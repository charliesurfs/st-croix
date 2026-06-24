// Stage 2 — transparent itinerary auto-builder (B1).
// Pure functions: no React, no Supabase. Given the rated candidates, the 8 days,
// ratings/must-dos/members and the drive matrix, it returns where each activity
// should go. The UI applies the result and the user corrects it with manual
// moves + locks (B4) and (later) voting. It is a heuristic, not an optimizer.
import { driveTime } from "./geo.js";

export const DAY_BUDGET = 540;   // ~9h of activity per day (matches the day-load meter)
const DRIVE_BUFFER = 20;         // minutes of slack between stops
const SLOT_TIMES = { morning: "09:00", afternoon: "13:00", evening: "18:00" };

const dwellOf = (a) => a.dwell_min || 75;
// Derived day phase by order: days 1-3 (sort 0-2) early, 4-5 mid, 6-8 late.
export const phaseOfDay = (sort) => (sort <= 2 ? "early" : sort <= 4 ? "mid" : "late");

const groupAvg = (a, ratings) => {
  const rs = ratings.filter((r) => r.activity_id === a.id);
  return rs.length ? rs.reduce((s, r) => s + r.want, 0) / rs.length : 0;
};
const mustCount = (a, mustDos) => mustDos.filter((x) => x.activity_id === a.id).length;
const mustWeight = (a, mustDos, members) =>
  mustDos.filter((x) => x.activity_id === a.id).reduce((s, x) => {
    const m = members.find((mm) => mm.id === x.member_id);
    return s + (m && m.role === "arbiter" ? 2 : 1); // Dad's must-do counts double
  }, 0);
// rank_score = group-avg rating + must-do weight (regular x1, Dad x2)
export const rankScore = (a, ratings, mustDos, members) =>
  groupAvg(a, ratings) + mustWeight(a, mustDos, members);

// Cheapest drive from `region` to any region already on a day (0 if day empty/unknown).
function incrementalDrive(region, regions) {
  if (!region || regions.length === 0) return 0;
  let best = Infinity;
  for (const r of regions) best = Math.min(best, driveTime(region, r));
  return best === Infinity ? 30 : best;
}

// Greedy nearest-neighbour ordering by region to cut backtracking within a day.
function orderByDrive(items) {
  if (items.length <= 2) return items.slice();
  const remaining = items.slice();
  const ordered = [remaining.shift()];
  while (remaining.length) {
    const last = ordered[ordered.length - 1];
    let bi = 0, bd = Infinity;
    remaining.forEach((it, idx) => {
      const d = driveTime(last.region, it.region);
      if (d < bd) { bd = d; bi = idx; }
    });
    ordered.push(remaining.splice(bi, 1)[0]);
  }
  return ordered;
}

export function buildItinerary({ activities, days, ratings, mustDos, members }) {
  const sortedDays = [...days].sort((a, b) => a.sort - b.sort);

  // Each day starts pre-loaded with its LOCKED items (manual placements + anchors).
  const state = sortedDays.map((d) => {
    const pinned = activities.filter((a) => a.locked && a.day_id === d.id);
    const load = pinned.reduce((s, a) => s + dwellOf(a), 0) + Math.max(0, pinned.length - 1) * DRIVE_BUFFER;
    return { day: d, phase: phaseOfDay(d.sort), load, regions: pinned.map((a) => a.region).filter(Boolean), placed: pinned.slice() };
  });

  // Pool = everything NOT locked. Must-dos selected first, then by rank_score.
  const pool = activities.filter((a) => !a.locked && a.status !== "dropped");
  const ranked = pool
    .map((a) => ({ a, score: rankScore(a, ratings, mustDos, members), must: mustCount(a, mustDos) > 0 }))
    .sort((x, y) => (Number(y.must) - Number(x.must)) || (y.score - x.score));

  const didNotFit = [];
  for (const { a, must } of ranked) {
    const dwell = dwellOf(a);
    const fits = (s) => s.load + incrementalDrive(a.region, s.regions) + dwell <= DAY_BUDGET;
    // Prefer days whose phase matches; untagged activities can go anywhere.
    const phaseOk = state.filter((s) => !a.phase || s.phase === a.phase);
    let candidates = (phaseOk.length ? phaseOk : state).filter(fits);
    // Must-dos must land somewhere: relax the phase window if needed.
    if (candidates.length === 0 && must) candidates = state.filter(fits);
    if (candidates.length === 0) { didNotFit.push(a.id); continue; }
    // Cluster by region (least added driving); tie-break toward the emptier day.
    candidates.sort((s1, s2) => {
      const d1 = incrementalDrive(a.region, s1.regions), d2 = incrementalDrive(a.region, s2.regions);
      return d1 !== d2 ? d1 - d2 : s1.load - s2.load;
    });
    const chosen = candidates[0];
    chosen.load += incrementalDrive(a.region, chosen.regions) + dwell;
    if (a.region) chosen.regions.push(a.region);
    chosen.placed.push(a);
  }

  // Order each day + assign rough morning/afternoon/evening slots.
  const assignments = [];
  for (const s of state) {
    const ordered = orderByDrive(s.placed);
    const n = ordered.length;
    ordered.forEach((a, i) => {
      const slot = i < Math.ceil(n / 3) ? "morning" : i < Math.ceil((2 * n) / 3) ? "afternoon" : "evening";
      assignments.push({
        id: a.id,
        day_id: s.day.id,
        sort: i,
        // Keep a locked item's pinned time; otherwise a rough slot time.
        start_time: (a.locked && a.start_time) ? a.start_time : SLOT_TIMES[slot],
        slot,
        locked: !!a.locked
      });
    });
  }
  return { assignments, didNotFit };
}
