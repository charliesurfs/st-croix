import { driveTime } from "./geo.js";

export const DAY_BUDGET = 540;
const DRIVE_BUFFER = 20;
const SLOT_TIMES = { morning: "09:00", afternoon: "13:00", evening: "18:00" };

const dwellOf = (a) => a.dwell_min || 75;
export const phaseOfDay = (sort) => (sort <= 2 ? "early" : sort <= 4 ? "mid" : "late");

const groupAvg = (a, ratings) => {
  const rs = ratings.filter((r) => r.activity_id === a.id);
  return rs.length ? rs.reduce((s, r) => s + r.want, 0) / rs.length : 0;
};
const mustCount = (a, mustDos) => mustDos.filter((x) => x.activity_id === a.id).length;
const mustWeight = (a, mustDos, members) =>
  mustDos.filter((x) => x.activity_id === a.id).reduce((s, x) => {
    const m = members.find((mm) => mm.id === x.member_id);
    return s + (m && m.role === "arbiter" ? 2 : 1);
  }, 0);

export const rankScore = (a, ratings, mustDos, members) =>
  groupAvg(a, ratings) + mustWeight(a, mustDos, members);

const slotForIndex = (idx, total) =>
  idx < Math.ceil(total / 3) ? "morning" : idx < Math.ceil((2 * total) / 3) ? "afternoon" : "evening";

const bySortThenTime = (a, b) =>
  (Number(a.sort) || 0) - (Number(b.sort) || 0) ||
  String(a.start_time || "99:99").localeCompare(String(b.start_time || "99:99")) ||
  String(a.id).localeCompare(String(b.id));

const driveBetween = (from, to) => {
  if (!from?.region || !to?.region) return 0;
  return driveTime(from.region, to.region);
};

function incrementalDrive(region, regions) {
  if (!region || regions.length === 0) return 0;
  let best = Infinity;
  for (const r of regions) best = Math.min(best, driveTime(region, r));
  return best === Infinity ? 30 : best;
}

function createRng(seed = 1) {
  let t = (seed >>> 0) || 1;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, rng) {
  const next = items.slice();
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function buildDayState(days, activities) {
  return [...days]
    .sort((a, b) => a.sort - b.sort)
    .map((day) => {
      const pinned = activities
        .filter((a) => a.locked && a.day_id === day.id && a.status === "scheduled")
        .sort(bySortThenTime);
      const load = pinned.reduce((sum, a) => sum + dwellOf(a), 0) + Math.max(0, pinned.length - 1) * DRIVE_BUFFER;
      return {
        day,
        phase: phaseOfDay(day.sort),
        load,
        regions: pinned.map((a) => a.region).filter(Boolean),
        placed: pinned.slice()
      };
    });
}

function rankPool(pool, ratings, mustDos, members, rng = null) {
  const ranked = pool
    .map((a) => ({ a, score: rankScore(a, ratings, mustDos, members), must: mustCount(a, mustDos) > 0 }))
    .sort((x, y) => (Number(y.must) - Number(x.must)) || (y.score - x.score) || String(x.a.id).localeCompare(String(y.a.id)));

  if (!rng) return ranked;

  const remixed = [];
  for (let i = 0; i < ranked.length;) {
    const base = ranked[i];
    let j = i + 1;
    while (
      j < ranked.length &&
      ranked[j].must === base.must &&
      Math.abs(ranked[j].score - base.score) <= 0.75
    ) {
      j += 1;
    }
    remixed.push(...shuffle(ranked.slice(i, j), rng));
    i = j;
  }
  return remixed;
}

function chooseCandidate(candidates, activity, rng = null) {
  const ranked = candidates
    .map((state) => ({
      state,
      drive: incrementalDrive(activity.region, state.regions),
      load: state.load,
      sort: state.day.sort
    }))
    .sort((a, b) => a.drive - b.drive || a.load - b.load || a.sort - b.sort);

  if (!rng) return ranked[0].state;

  const best = ranked[0];
  const near = ranked
    .filter((entry) => entry.drive <= best.drive + 20 && entry.load <= best.load + 90)
    .slice(0, 3);
  return near[Math.floor(rng() * near.length)].state;
}

function lockedEntries(items) {
  const used = new Set();
  return items
    .filter((a) => a.locked)
    .sort(bySortThenTime)
    .map((item, idx) => {
      let sort = Number.isFinite(Number(item.sort)) ? Number(item.sort) : idx;
      sort = Math.max(0, sort);
      while (used.has(sort)) sort += 1;
      used.add(sort);
      return [sort, item];
    });
}

function freeSorts(locked, needed) {
  const occupied = new Set(locked.map(([sort]) => sort));
  const open = [];
  for (let sort = 0; open.length < needed; sort += 1) {
    if (!occupied.has(sort)) open.push(sort);
  }
  return open;
}

function chooseUnlockedForSlot(remaining, placed, locked, sort, rng = null) {
  let bestScore = Infinity;
  let bestIndexes = [];
  const prev = [...placed, ...locked]
    .filter(([entrySort]) => entrySort < sort)
    .sort((a, b) => a[0] - b[0]);
  const prevItem = prev.length ? prev[prev.length - 1][1] : null;
  const nextLocked = locked
    .filter(([entrySort]) => entrySort > sort)
    .sort((a, b) => a[0] - b[0])[0]?.[1] || null;

  remaining.forEach((item, idx) => {
    const score = driveBetween(prevItem, item) + (nextLocked ? driveBetween(item, nextLocked) * 0.65 : 0);
    if (score < bestScore) {
      bestScore = score;
      bestIndexes = [idx];
    } else if (score === bestScore) {
      bestIndexes.push(idx);
    }
  });

  const chosenIndex = rng && bestIndexes.length > 1
    ? bestIndexes[Math.floor(rng() * bestIndexes.length)]
    : bestIndexes[0];
  return remaining.splice(chosenIndex, 1)[0];
}

function buildAssignmentsForDay(day, items, rng = null) {
  const locked = lockedEntries(items);
  const unlocked = items.filter((a) => !a.locked);
  const openSorts = freeSorts(locked, unlocked.length);
  const placed = [];
  const remaining = unlocked.slice();

  for (const sort of openSorts) {
    const item = chooseUnlockedForSlot(remaining, placed, locked, sort, rng);
    placed.push([sort, item]);
  }

  const ordered = [...locked, ...placed].sort((a, b) => a[0] - b[0]);
  const total = ordered.length;

  return ordered.map(([sort, item], idx) => {
    const slot = slotForIndex(idx, total);
    return {
      id: item.id,
      day_id: day.id,
      sort,
      start_time: item.locked ? (item.start_time || null) : SLOT_TIMES[slot],
      slot,
      locked: !!item.locked
    };
  });
}

function planBuild({ activities, days, ratings, mustDos, members, rng = null }) {
  const state = buildDayState(days, activities);
  const pool = activities.filter((a) => !a.locked && a.status !== "dropped");
  const ranked = rankPool(pool, ratings, mustDos, members, rng);
  const didNotFit = [];

  for (const { a, must } of ranked) {
    const dwell = dwellOf(a);
    const fits = (s) => s.load + incrementalDrive(a.region, s.regions) + dwell <= DAY_BUDGET;
    const phaseMatches = state.filter((s) => !a.phase || s.phase === a.phase);
    let candidates = (phaseMatches.length ? phaseMatches : state).filter(fits);
    if (candidates.length === 0 && must) candidates = state.filter(fits);
    if (candidates.length === 0) {
      didNotFit.push(a.id);
      continue;
    }

    const chosen = chooseCandidate(candidates, a, rng);
    chosen.load += incrementalDrive(a.region, chosen.regions) + dwell;
    if (a.region) chosen.regions.push(a.region);
    chosen.placed.push(a);
  }

  const assignments = state.flatMap((entry) => buildAssignmentsForDay(entry.day, entry.placed, rng));
  return {
    assignments,
    didNotFit,
    signature: arrangementSignature({ activities, assignments, didNotFit })
  };
}

function nudgePlan(plan, activities) {
  const grouped = new Map();
  for (const assignment of plan.assignments) {
    if (assignment.locked) continue;
    if (!grouped.has(assignment.day_id)) grouped.set(assignment.day_id, []);
    grouped.get(assignment.day_id).push(assignment);
  }

  for (const list of grouped.values()) {
    if (list.length < 2) continue;
    const ordered = list.slice().sort((a, b) => a.sort - b.sort);
    const first = ordered[0];
    const second = ordered[1];
    const assignments = plan.assignments.map((assignment) => {
      if (assignment.id === first.id) return { ...assignment, sort: second.sort, start_time: second.start_time };
      if (assignment.id === second.id) return { ...assignment, sort: first.sort, start_time: first.start_time };
      return assignment;
    });
    return {
      ...plan,
      assignments,
      signature: arrangementSignature({ activities, assignments, didNotFit: plan.didNotFit })
    };
  }

  return null;
}

export function arrangementSignature({ activities, assignments = [], didNotFit = [] }) {
  const byId = new Map(assignments.map((assignment) => [assignment.id, assignment]));
  const parked = new Set(didNotFit);

  return activities
    .filter((activity) => activity.status !== "dropped")
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((activity) => {
      const next = byId.get(activity.id);
      if (next) return `${activity.id}:${next.day_id || "none"}:${next.sort ?? ""}:${next.start_time || ""}:scheduled`;
      if (parked.has(activity.id)) return `${activity.id}:none:::maybe_later`;
      return `${activity.id}:${activity.day_id || "none"}:${activity.sort ?? ""}:${activity.start_time || ""}:${activity.status || ""}`;
    })
    .join("|");
}

export function buildItinerary(params) {
  return planBuild(params);
}

export function rerollItinerary({ seed = 1, avoidSignatures = [], ...params }) {
  const avoid = new Set([arrangementSignature({ activities: params.activities }), ...avoidSignatures].filter(Boolean));
  let fallback = null;

  for (let attempt = 0; attempt < 18; attempt += 1) {
    const rng = createRng(seed + attempt * 101);
    const candidate = planBuild({ ...params, rng });
    fallback = candidate;
    if (!avoid.has(candidate.signature)) return candidate;
  }

  const nudged = fallback ? nudgePlan(fallback, params.activities) : null;
  if (nudged && !avoid.has(nudged.signature)) return nudged;
  return fallback || planBuild({ ...params, rng: createRng(seed) });
}

export function optimizeItinerary({ activities, days }) {
  const assignments = [...days]
    .sort((a, b) => a.sort - b.sort)
    .flatMap((day) => {
      const scheduled = activities
        .filter((activity) => activity.day_id === day.id && activity.status === "scheduled")
        .sort(bySortThenTime);
      return buildAssignmentsForDay(day, scheduled, null);
    });

  return {
    assignments,
    didNotFit: [],
    signature: arrangementSignature({ activities, assignments, didNotFit: [] })
  };
}
