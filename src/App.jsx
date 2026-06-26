import React, { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./supabaseClient.js";
import { getWeather, wcode } from "./weather.js";
import { buildItinerary, optimizeItinerary, rerollItinerary } from "./data/buildItinerary.js";

const REGION = {
  "Christiansted": "#0E6E6E", "West End": "#C98A1E", "Rainforest & North Shore": "#3F8E5B",
  "East End": "#2E7C9E", "Island-wide": "#94804E", "Travel": "#73817E"
};
const ac = (r) => REGION[r] || "#5E6D6A";
const ME_KEY = "stx_me";
const RLABELS = ["Don't want", "Eh", "Maybe", "Want to", "Really want"];
const PHASE = { early: "early trip", mid: "mid trip", late: "late trip" };
const DAY_BUDGET = 540; // ~9 hrs of daytime activity
const PIN_RE = /^\d{4,6}$/;
const ENERGY_LEVELS = [
  { value: 1, emoji: "😴", label: "Wiped" },
  { value: 2, emoji: "🙂", label: "Low" },
  { value: 3, emoji: "👌", label: "Steady" },
  { value: 4, emoji: "⚡", label: "Up for more" },
  { value: 5, emoji: "🔥", label: "High-energy" }
];
const fmtTime = (t) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const dow = (d) => d ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(d + "T12:00").getDay()] : "";
const todayStr = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
const dateKey = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const dwellOf = (a) => a.dwell_min || 75;
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
// Derived day phase from its order in the trip: 0-2 early, 3-4 mid, 5-7 late.
const dayPhase = (sort) => (sort <= 2 ? "early" : sort <= 4 ? "mid" : "late");
// One scoring weight, shared by the "Most wanted" sort and the Stage-2 planner.
const mustWeight = (a, mustDos, members) =>
  mustDos.filter((x) => x.activity_id === a.id).reduce((s, x) => {
    const m = members.find((mm) => mm.id === x.member_id);
    return s + (m && m.role === "arbiter" ? 2 : 1); // Dad's must-do counts double
  }, 0);
const groupAvg = (a, ratings) => {
  const rs = ratings.filter((r) => r.activity_id === a.id);
  return rs.length ? rs.reduce((s, r) => s + r.want, 0) / rs.length : null;
};
const hasClaimedPin = (m) => Boolean(m && m.claimed && m.pin_hash);
const needsClaimPin = (m) => Boolean(m && !hasClaimedPin(m));
const hashPin = async (pin) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
};

export default function App() {
  const [trip, setTrip] = useState(null);
  const [members, setMembers] = useState([]);
  const [days, setDays] = useState([]);
  const [acts, setActs] = useState([]);
  const [ratings, setRatings] = useState([]);
  const [mustDos, setMustDos] = useState([]);
  const [pulses, setPulses] = useState([]);
  const [meId, setMeId] = useState(() => localStorage.getItem(ME_KEY) || null);
  const [status, setStatus] = useState("loading");
  const [gate, setGate] = useState({ mode: "grid", memberId: null });
  const [weather, setWeather] = useState(null);
  const [view, setView] = useState("activities");   // 'activities' (Stage 1) | 'itinerary' (Stage 2 + live)
  const [activityView, setActivityView] = useState("rate"); // 'rate' | 'wanted' | 'when'
  const [sheet, setSheet] = useState(null);
  const [plannerDay, setPlannerDay] = useState(null);
  const [building, setBuilding] = useState(false);
  const [buildMsg, setBuildMsg] = useState(null);
  const [proposal, setProposal] = useState(null);
  const [shuffleBusy, setShuffleBusy] = useState("");
  const [applyingProposal, setApplyingProposal] = useState(false);
  const [myNote, setMyNote] = useState("");
  const [myNoteLoaded, setMyNoteLoaded] = useState(false);
  const [myNoteStatus, setMyNoteStatus] = useState("idle");
  const [aiPlanProposal, setAiPlanProposal] = useState(null);
  const [aiPlanBusy, setAiPlanBusy] = useState(false);
  const [applyingAiPlan, setApplyingAiPlan] = useState(false);
  const [aiPlanMsg, setAiPlanMsg] = useState("");
  const [aiPlanError, setAiPlanError] = useState("");
  const reloadTimer = useRef(null);
  const wantTimers = useRef({});
  const noteSaveTimer = useRef(null);
  const savedNoteRef = useRef("");
  const shuffleSeed = useRef(Math.floor(Date.now() % 1000000) || 1);
  const proposalRef = useRef(null);
  const [rateOrderIds, setRateOrderIds] = useState([]);

  const loadAll = useCallback(async () => {
    const { data: trips, error } = await supabase.from("trips").select("*").limit(1);
    if (error) { setStatus("error"); return; }
    const t = trips && trips[0];
    if (!t) { setStatus("error"); return; }
    const [m, d, a, r, md, p] = await Promise.all([
      supabase.from("members").select("*").eq("trip_id", t.id),
      supabase.from("days").select("*").eq("trip_id", t.id).order("sort"),
      supabase.from("activities").select("*").eq("trip_id", t.id).order("sort"),
      supabase.from("ratings").select("*"),
      supabase.from("must_dos").select("*"),
      supabase.from("pulses").select("*").eq("trip_id", t.id).order("created_at", { ascending: false })
    ]);
    const nextMembers = m.data || [];
    setTrip(t); setMembers(nextMembers); setDays(d.data || []);
    setActs(a.data || []); setRatings(r.data || []); setMustDos(md.data || []); setPulses(p.data || []);
    const storedId = localStorage.getItem(ME_KEY);
    const storedMember = nextMembers.find((x) => x.id === storedId) || null;
    if (storedMember) {
      setMeId(storedMember.id);
      if (needsClaimPin(storedMember)) {
        setGate({ mode: "claim", memberId: storedMember.id });
        setStatus("needsMe");
      } else {
        setGate({ mode: "grid", memberId: null });
        setStatus("ready");
      }
      return;
    }
    setMeId(null);
    setStatus("needsMe");
    setGate((prev) => {
      if (!prev.memberId) return { mode: "grid", memberId: null };
      const selected = nextMembers.find((x) => x.id === prev.memberId);
      if (!selected) return { mode: "grid", memberId: null };
      if (prev.mode === "claim") return needsClaimPin(selected) ? prev : { mode: "pin", memberId: selected.id };
      if (prev.mode === "pin") return needsClaimPin(selected) ? { mode: "claim", memberId: selected.id } : prev;
      return prev;
    });
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => {
    const reload = () => { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(loadAll, 600); };
    const ch = supabase.channel("trip")
      .on("postgres_changes", { event: "*", schema: "public", table: "activities" }, reload)
      .on("postgres_changes", { event: "*", schema: "public", table: "ratings" }, reload)
      .on("postgres_changes", { event: "*", schema: "public", table: "must_dos" }, reload)
      .on("postgres_changes", { event: "*", schema: "public", table: "days" }, reload)
      .on("postgres_changes", { event: "*", schema: "public", table: "members" }, reload)
      .on("postgres_changes", { event: "*", schema: "public", table: "pulses" }, reload)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [loadAll]);
  useEffect(() => { getWeather().then(setWeather).catch(() => setWeather("err")); }, []);
  useEffect(() => {
    clearTimeout(noteSaveTimer.current);
    savedNoteRef.current = "";
    setMyNote("");
    setMyNoteLoaded(false);
    setMyNoteStatus("idle");
    if (status !== "ready" || !meId || !trip?.id) return;
    let cancelled = false;
    const loadMyNote = async () => {
      // App-enforced privacy: only ever request the logged-in member's own note.
      const { data, error } = await supabase
        .from("member_notes")
        .select("note, updated_at")
        .eq("member_id", meId)
        .maybeSingle();
      if (cancelled) return;
      const nextNote = data?.note || "";
      savedNoteRef.current = nextNote;
      setMyNote(nextNote);
      setMyNoteLoaded(true);
      setMyNoteStatus(error ? "error" : "idle");
    };
    loadMyNote();
    return () => {
      cancelled = true;
      clearTimeout(noteSaveTimer.current);
    };
  }, [meId, status, trip?.id]);
  useEffect(() => {
    if (status !== "ready" || !meId || !trip?.id || !myNoteLoaded) return;
    if (myNote === savedNoteRef.current) return;
    clearTimeout(noteSaveTimer.current);
    noteSaveTimer.current = setTimeout(async () => {
      setMyNoteStatus("saving");
      const { error } = await supabase
        .from("member_notes")
        .upsert({
          member_id: meId,
          trip_id: trip.id,
          note: myNote,
          updated_at: new Date().toISOString()
        }, { onConflict: "member_id" });
      if (error) {
        setMyNoteStatus("error");
        return;
      }
      savedNoteRef.current = myNote;
      setMyNoteStatus("saved");
    }, 800);
    return () => { clearTimeout(noteSaveTimer.current); };
  }, [meId, myNote, myNoteLoaded, status, trip?.id]);
  useEffect(() => { proposalRef.current = proposal; }, [proposal]);
  useEffect(() => {
    if (!proposalRef.current) return;
    setProposal(null);
    setPlannerDay(null);
  }, [acts, days, ratings, mustDos]);
  useEffect(() => {
    const currentMe = members.find((x) => x.id === meId) || null;
    const currentDad = members.find((member) => member.role === "arbiter");
    const currentIsArbiter = currentMe && currentDad ? currentMe.id === currentDad.id : currentMe?.role === "arbiter";
    if (currentIsArbiter) return;
    setAiPlanProposal(null);
    setAiPlanMsg("");
    setAiPlanError("");
  }, [members, meId]);
  useEffect(() => {
    const unscheduledIds = acts.filter((activity) => !activity.day_id).map((activity) => activity.id);
    setRateOrderIds((prev) => {
      const activeIds = new Set(unscheduledIds);
      const kept = prev.filter((id) => activeIds.has(id));
      const seen = new Set(kept);
      const additions = unscheduledIds.filter((id) => !seen.has(id));
      if (kept.length === prev.length && additions.length === 0) return prev;
      return [...kept, ...additions];
    });
  }, [acts]);

  const me = members.find((x) => x.id === meId) || null;
  const enterAppAs = (id) => {
    localStorage.setItem(ME_KEY, id);
    setMeId(id);
    setGate({ mode: "grid", memberId: null });
    setStatus("ready");
  };
  const resetIdentity = () => {
    localStorage.removeItem(ME_KEY);
    setMeId(null);
    setGate({ mode: "grid", memberId: null });
    setStatus("needsMe");
  };
  const chooseMember = (member) => { setGate({ mode: hasClaimedPin(member) ? "pin" : "claim", memberId: member.id }); };
  const claimMember = async (member, pin) => {
    const pin_hash = await hashPin(pin);
    const { data, error } = await supabase
      .from("members")
      .update({ pin_hash, claimed: true })
      .eq("id", member.id)
      .eq("claimed", false)
      .select("*");
    if (error) throw error;
    const row = data && data[0];
    if (!row) {
      await loadAll();
      throw new Error("That name was just claimed on another device. Enter the PIN to continue.");
    }
    setMembers((prev) => prev.map((x) => (x.id === member.id ? { ...x, ...row } : x)));
    enterAppAs(member.id);
  };
  const verifyMemberPin = async (member, pin) => {
    const pin_hash = await hashPin(pin);
    if (pin_hash !== member.pin_hash) throw new Error("Wrong PIN.");
    enterAppAs(member.id);
  };

  // mutations
  const setWant = (a, val) => {
    setRatings((prev) => [...prev.filter((r) => !(r.activity_id === a.id && r.member_id === meId)), { activity_id: a.id, member_id: meId, want: val }]);
    clearTimeout(wantTimers.current[a.id]);
    wantTimers.current[a.id] = setTimeout(() => supabase.from("ratings").upsert({ activity_id: a.id, member_id: meId, want: val }, { onConflict: "activity_id,member_id" }), 300);
  };
  const toggleMust = async (a, mine) => {
    if (mine) await supabase.from("must_dos").delete().match({ activity_id: a.id, member_id: meId });
    else { const { error } = await supabase.from("must_dos").insert({ activity_id: a.id, member_id: meId }); if (error) { alert(`You've used all ${me.must_do_limit} must-dos. Free one up first.`); return; } }
    loadAll();
  };
  const toggleDone = async (a) => { await supabase.from("activities").update({ done: !a.done }).eq("id", a.id); loadAll(); };
  const toMaybe = async (a) => { await supabase.from("activities").update({ status: "maybe_later", day_id: null, done: false }).eq("id", a.id); loadAll(); };
  const schedule = async (a, dayId) => { if (!dayId) return; await supabase.from("activities").update({ status: "scheduled", day_id: dayId }).eq("id", a.id); loadAll(); };
  // Set early/mid/late inline on a card. Anyone can set/change it; null = untagged.
  const setPhase = async (a, phase) => {
    setActs((prev) => prev.map((x) => (x.id === a.id ? { ...x, phase } : x))); // optimistic
    await supabase.from("activities").update({ phase }).eq("id", a.id); loadAll();
  };
  const del = async (a) => { if (confirm(`Delete "${a.title}"?`)) { await supabase.from("activities").delete().eq("id", a.id); loadAll(); } };
  const rename = async (a) => { const v = prompt("Rename:", a.title); if (v && v.trim()) { await supabase.from("activities").update({ title: v.trim() }).eq("id", a.id); loadAll(); } };
  const addActivity = async ({ mode, title, phase, dayId }) => {
    const base = { trip_id: trip.id, title, phase: phase || null, sort: 999 };
    if (mode === "day") { const day = days.find((d) => d.id === dayId); Object.assign(base, { day_id: dayId, status: "scheduled", region: day && day.region }); }
    else if (mode === "suggest") Object.assign(base, { day_id: null, status: "proposed" });
    else Object.assign(base, { day_id: null, status: "idea" });
    await supabase.from("activities").insert(base); setSheet(null); loadAll();
  };
  const draftDay = async (day, list) => { for (const a of list) await supabase.from("activities").update({ status: "scheduled", day_id: day.id }).eq("id", a.id); loadAll(); };
  const submitPulse = async (energy) => {
    if (!trip) return;
    const { error } = await supabase.from("pulses").insert({ trip_id: trip.id, day: todayStr(), energy });
    if (error) throw error;
    loadAll();
  };
  const commitArrangement = async ({ assignments, didNotFit, message }) => {
    for (const assignment of assignments) {
      if (assignment.locked) continue;
      await supabase.from("activities").update({
        day_id: assignment.day_id,
        status: "scheduled",
        start_time: assignment.start_time,
        sort: assignment.sort
      }).eq("id", assignment.id);
    }
    for (const id of didNotFit) {
      await supabase.from("activities").update({
        status: "maybe_later",
        day_id: null,
        start_time: null
      }).eq("id", id);
    }
    setBuildMsg(message);
    await loadAll();
  };
  const runBuildItinerary = async () => {
    const overrideNote = !everyoneFinished && isArbiter
      ? `\n\nNote: ${waitingCount} of ${totalMembers} members haven't finished rating yet. Build anyway?`
      : "";
    if (!confirm(`Build the week from your rated activities?\n\nUnlocked items can move between days. Locked items stay where you pinned them.${overrideNote}`)) return;
    setBuilding(true);
    setBuildMsg(null);
    setProposal(null);
    try {
      const { assignments, didNotFit } = buildItinerary({ activities: acts, days, ratings, mustDos, members });
      const placed = assignments.filter((assignment) => !assignment.locked).length;
      await commitArrangement({
        assignments,
        didNotFit,
        message: `Built ${placed} ${placed === 1 ? "activity" : "activities"} into days. ${didNotFit.length} moved to Maybe later.`
      });
    } finally {
      setBuilding(false);
    }
  };
  const proposeArrangement = (mode) => {
    if (!canBuildItinerary || shuffleBusy || building || applyingProposal) return;
    setShuffleBusy(mode);
    setBuildMsg(null);
    setPlannerDay(null);
    try {
      const next = mode === "reroll"
        ? rerollItinerary({
            activities: acts,
            days,
            ratings,
            mustDos,
            members,
            seed: shuffleSeed.current++,
            avoidSignatures: proposal ? [proposal.signature] : []
          })
        : optimizeItinerary({ activities: acts, days });
      setProposal({
        ...next,
        mode
      });
    } finally {
      setShuffleBusy("");
    }
  };
  const dismissProposal = () => { setProposal(null); };
  const applyProposal = async () => {
    if (!proposal || !canBuildItinerary) return;
    if (!isArbiter) {
      alert("Only Dad can apply a proposed arrangement.");
      return;
    }
    setApplyingProposal(true);
    setBuildMsg(null);
    try {
      const moved = proposal.assignments.filter((assignment) => !assignment.locked).length;
      await commitArrangement({
        assignments: proposal.assignments,
        didNotFit: proposal.didNotFit,
        message: proposal.mode === "optimize"
          ? "Applied the optimized day order."
          : `Applied the re-roll proposal. ${moved} ${moved === 1 ? "activity" : "activities"} were placed into days and ${proposal.didNotFit.length} moved to Maybe later.`
      });
      setProposal(null);
    } finally {
      setApplyingProposal(false);
    }
  };
  const proposeAiPlan = async () => {
    if (!isArbiter || aiPlanBusy || applyingAiPlan) return;
    const dadNote = myNote.trim();
    if (!dadNote) {
      setAiPlanError("Write a few notes first, then ask for a proposed plan.");
      setAiPlanMsg("");
      return;
    }
    setAiPlanBusy(true);
    setAiPlanError("");
    setAiPlanMsg("");
    setAiPlanProposal(null);
    try {
      const response = await fetch("/api/propose-plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dadNote,
          days: days.map(({ date, label }) => ({ date, label })),
          activities: acts
            .filter((activity) => activity.status !== "dropped")
            .map((activity) => ({
              title: activity.title,
              region: activity.region,
              groupAvg: groupAvg(activity, ratings)
            }))
        })
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || !payload) throw new Error("proposal_failed");
      const nextProposal = {
        summary: typeof payload.summary === "string" ? payload.summary.trim() : "",
        spine: Array.isArray(payload.spine)
          ? payload.spine
              .filter((item) => item && typeof item.date === "string" && typeof item.theme === "string")
              .map((item) => ({
                date: item.date,
                theme: item.theme.trim(),
                rationale: typeof item.rationale === "string" ? item.rationale.trim() : ""
              }))
          : [],
        flags: Array.isArray(payload.flags)
          ? payload.flags
              .filter((item) => item && typeof item.activity === "string")
              .map((item) => ({
                activity: item.activity.trim(),
                groupAvg: typeof item.groupAvg === "number" ? item.groupAvg : null,
                note: typeof item.note === "string" ? item.note.trim() : ""
              }))
          : []
      };
      if (!nextProposal.summary || nextProposal.spine.length === 0) throw new Error("proposal_failed");
      setAiPlanProposal(nextProposal);
    } catch {
      setAiPlanProposal(null);
      setAiPlanError("The AI couldn't generate a plan right now, try again.");
    } finally {
      setAiPlanBusy(false);
    }
  };
  const dismissAiPlan = () => {
    setAiPlanProposal(null);
    setAiPlanError("");
  };
  const applyAiPlan = async () => {
    if (!isArbiter) return;
    if (!aiPlanProposal) return;
    setApplyingAiPlan(true);
    setAiPlanError("");
    setAiPlanMsg("");
    try {
      let updated = 0;
      for (const item of aiPlanProposal.spine) {
        const day = days.find((entry) => entry.date === item.date);
        if (!day) continue;
        const { error } = await supabase.from("days").update({ label: item.theme }).eq("id", day.id);
        if (error) throw error;
        updated += 1;
      }
      if (!updated) throw new Error("no_matching_days");
      setAiPlanProposal(null);
      await loadAll();
      setAiPlanMsg("Applied the proposed day themes.");
    } catch {
      setAiPlanError("Couldn't apply that plan right now.");
    } finally {
      setApplyingAiPlan(false);
    }
  };
  const moveToDay = async (a, dayId) => {
    if (!dayId || dayId === a.day_id) return;
    const target = acts.filter((x) => x.day_id === dayId && x.status === "scheduled");
    const maxSort = target.length ? Math.max(...target.map((x) => x.sort || 0)) : -1;
    await supabase.from("activities").update({
      day_id: dayId,
      status: "scheduled",
      sort: maxSort + 1,
      locked: true
    }).eq("id", a.id);
    loadAll();
  };
  const reorderInDay = async (a, dir) => {
    const list = acts
      .filter((x) => x.day_id === a.day_id && x.status === "scheduled")
      .sort((x, y) => (x.sort || 0) - (y.sort || 0));
    const i = list.findIndex((x) => x.id === a.id);
    const j = dir === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= list.length) return;
    const other = list[j];
    await supabase.from("activities").update({ sort: other.sort || 0, locked: true }).eq("id", a.id);
    await supabase.from("activities").update({ sort: a.sort || 0 }).eq("id", other.id);
    loadAll();
  };
  const toggleLock = async (a) => {
    await supabase.from("activities").update({ locked: !a.locked }).eq("id", a.id);
    loadAll();
  };

  if (status === "loading") return <div className="center">Loading the trip…</div>;
  if (status === "error") return <div className="center">Couldn't reach the trip. Check your Supabase URL/key in <code>.env</code> and that the schema + migration ran.</div>;
  if (status === "needsMe") return <IdentityGate members={members} gate={gate} onChooseMember={chooseMember} onClaimPin={claimMember} onEnterPin={verifyMemberPin} onBack={resetIdentity} />;
  if (!me) return <div className="center">Refreshing your trip seat...</div>;

  const myMustCount = mustDos.filter((x) => x.member_id === meId).length;
  const limit = me ? me.must_do_limit : null;
  const dad = members.find((m) => m.role === "arbiter");
  const isArbiter = me && dad ? me.id === dad.id : me?.role === "arbiter";
  const votableActs = acts.filter((a) => a.status === "idea");
  const votableCount = votableActs.length;
  const totalMembers = members.length;
  const votableIds = new Set(votableActs.map((a) => a.id));
  const ratedIdeaIdsByMember = ratings.reduce((map, rating) => {
    if (!votableIds.has(rating.activity_id)) return map;
    if (!map.has(rating.member_id)) map.set(rating.member_id, new Set());
    map.get(rating.member_id).add(rating.activity_id);
    return map;
  }, new Map());
  const unfinishedMembers = votableCount === 0
    ? []
    : members.filter((member) => (ratedIdeaIdsByMember.get(member.id)?.size || 0) < votableCount);
  const finishedCount = votableCount === 0 ? 0 : totalMembers - unfinishedMembers.length;
  const waitingCount = totalMembers - finishedCount;
  const everyoneFinished = votableCount > 0 && finishedCount === totalMembers;
  const canBuildItinerary = votableCount > 0 && (everyoneFinished || isArbiter);
  const buildGateStatus = votableCount === 0
    ? "No activities to build yet"
    : !everyoneFinished && !isArbiter
      ? `Waiting on ${waitingCount} of ${totalMembers} to finish rating: ${unfinishedMembers.map((member) => member.name).join(", ")}`
      : null;
  const cardProps = {
    me, members, ratings, mustDos, myMustCount, limit, days,
    on: {
      want: setWant,
      must: toggleMust,
      done: toggleDone,
      maybe: toMaybe,
      schedule,
      setPhase,
      del,
      rename,
      lock: toggleLock,
      moveDay: moveToDay,
      reorder: reorderInDay
    }
  };
  const sortDayItems = (items) => items.slice().sort((x, y) => (x.done - y.done) || String(x.start_time || "99").localeCompare(String(y.start_time || "99")) || ((x.sort || 0) - (y.sort || 0)));
  const showingProposal = Boolean(proposal);
  const proposalById = new Map((proposal?.assignments || []).map((assignment) => [assignment.id, assignment]));
  const dayItems = (dayId) => sortDayItems(acts.filter((a) => a.day_id === dayId && a.status === "scheduled"));
  const proposalDayItems = (dayId) => sortDayItems(
    acts
      .filter((a) => proposalById.get(a.id)?.day_id === dayId)
      .map((a) => ({ ...a, ...proposalById.get(a.id), status: "scheduled" }))
  );
  const proposalModeLabel = proposal?.mode === "optimize" ? "Optimized preview" : "Re-roll preview";
  const proposalSummary = proposal
    ? proposal.didNotFit.length
      ? `${proposal.didNotFit.length} ${proposal.didNotFit.length === 1 ? "activity would move" : "activities would move"} to Maybe later if Dad applies this.`
      : "Everything still fits into the week in this preview."
    : "";
  const noteStatusLabel = myNoteStatus === "saving"
    ? "Saving..."
    : myNoteStatus === "saved"
      ? "Saved"
      : myNoteStatus === "error"
        ? "Couldn't save right now."
        : "";
  const rankScore = (a) => (groupAvg(a, ratings) || 0) + mustWeight(a, mustDos, members);

  const tStr = todayStr();
  const todayIdx = days.findIndex((d) => d.date === tStr);
  const daysUntil = days[0] ? Math.ceil((new Date(days[0].date) - new Date(tStr)) / 86400000) : 0;

  // ---------- ACTIVITIES (Stage 1) - flat rated list ----------
  function renderActivities() {
    const phaseGroups = [["early", "Early trip"], ["mid", "Mid trip"], ["late", "Late trip"], [null, "Whenever"]];
    const unscheduled = acts.filter((activity) => !activity.day_id);
    const unscheduledById = new Map(unscheduled.map((activity) => [activity.id, activity]));
    const stableBase = rateOrderIds
      .map((id) => unscheduledById.get(id))
      .filter(Boolean);
    const seenIds = new Set(stableBase.map((activity) => activity.id));
    const stableActivities = [
      ...stableBase,
      ...unscheduled.filter((activity) => !seenIds.has(activity.id))
    ];
    const stableIndex = new Map(stableActivities.map((activity, index) => [activity.id, index]));
    const candidates = stableActivities.filter((activity) => activity.status === "idea" || activity.status === "proposed");
    const parked = stableActivities.filter((activity) => activity.status === "maybe_later");
    const phaseRank = (activity) => ({ early: 0, mid: 1, late: 2 }[activity.phase] ?? 3);
    const sortByRank = (left, right) =>
      (rankScore(right) - rankScore(left))
      || ((stableIndex.get(left.id) ?? 0) - (stableIndex.get(right.id) ?? 0));
    const sortByPhaseThenRank = (left, right) =>
      (phaseRank(left) - phaseRank(right))
      || sortByRank(left, right);
    const readOnly = activityView !== "rate";
    const renderCards = (items, options = {}) => items.map((activity) => (
      <ActivityCard
        key={activity.id}
        a={activity}
        context="flat"
        accent={ac(activity.region)}
        readOnly={options.readOnly ?? readOnly}
        allowMaybeAction={options.allowMaybeAction}
        allowScheduleAction={options.allowScheduleAction}
        {...cardProps}
      />
    ));

    let body;
    if (activityView === "rate") {
      body = renderCards(candidates);
    } else if (activityView === "wanted") {
      body = renderCards([...candidates].sort(sortByRank), { readOnly: true });
    } else {
      body = phaseGroups.map(([phase, label]) => {
        const items = candidates
          .filter((activity) => (activity.phase || null) === phase)
          .sort(sortByRank);
        if (!items.length) return null;
        return (
          <React.Fragment key={label}>
            <div className="section-label">{label}</div>
            {renderCards(items, { readOnly: true })}
          </React.Fragment>
        );
      });
    }

    const parkedItems = activityView === "rate"
      ? parked
      : activityView === "wanted"
        ? [...parked].sort(sortByRank)
        : [...parked].sort(sortByPhaseThenRank);
    const viewNote = activityView === "rate"
      ? "Rate view stays stable while you tap. Ratings, must-dos, and phase tags update the card but never reshuffle the list."
      : activityView === "wanted"
        ? "Read-only view - ranked by group interest plus must-do weight."
        : "Read-only view - grouped by early, mid, late, then untagged activities.";

    return (
      <main className="wrap">
        <div className="mebar">
          {members.map((m) => <span key={m.id} className="mchip"><span className="mswatch" style={{ background: m.color }} />{m.name}{m.role === "arbiter" ? " ⭐" : ""}</span>)}
          <span className="mecount">{limit == null ? "must-dos: unlimited" : <>must-dos: <b>{myMustCount}/{limit}</b></>}</span>
        </div>

        <p className="introline">Step 1 — add everything you'd want to do, rate it 1–5, and tag roughly when it fits. We'll build the daily schedule next.</p>
        <div className="sortrow">
          <button className={activityView === "rate" ? "on" : ""} onClick={() => setActivityView("rate")}>Rate</button>
          <button className={activityView === "wanted" ? "on" : ""} onClick={() => setActivityView("wanted")}>Most wanted</button>
          <button className={activityView === "when" ? "on" : ""} onClick={() => setActivityView("when")}>By when</button>
        </div>
        <div className="viewnote">{viewNote}</div>
        <PrivateNotesCard
          note={myNote}
          loaded={myNoteLoaded}
          statusLabel={noteStatusLabel}
          statusTone={myNoteStatus === "error" ? "error" : myNoteStatus === "saved" ? "saved" : ""}
          footer={isArbiter ? <>
            <div className="notesactions">
              <button
                className="notesactionbtn"
                onClick={proposeAiPlan}
                disabled={!myNoteLoaded || aiPlanBusy || applyingAiPlan}
              >
                {aiPlanBusy ? "Thinking..." : "Propose a plan from my notes"}
              </button>
            </div>
            {aiPlanMsg && <div className="notesnotice">{aiPlanMsg}</div>}
            {aiPlanError && <div className="notesnotice error">{aiPlanError}</div>}
          </> : null}
          onChange={(value) => {
            setMyNote(value);
            if (myNoteStatus !== "saving") setMyNoteStatus("typing");
          }}
        />
        {isArbiter && aiPlanProposal && <AiPlanPreview
          proposal={aiPlanProposal}
          busy={applyingAiPlan}
          onApply={applyAiPlan}
          onDismiss={dismissAiPlan}
        />}


        {candidates.length === 0 && parked.length === 0 && <div className="emptyhint">{activityView === "rate" ? "Nothing here yet. Tap + Add activity to start the list, then rate and tag without the cards jumping around." : "Nothing here yet. Switch to Rate to add activities, then come back here to browse the sorted views."}</div>}
        {body}

        {activityView === "rate" && <button className="addbtn" onClick={() => setSheet({ mode: "wishlist" })}>+ Add activity</button>}

        {parked.length > 0 && <>
          <div className="section-label">Maybe later · parked</div>
          {renderCards(parkedItems, {
            readOnly,
            allowMaybeAction: false,
            allowScheduleAction: false
          })}
        </>}
      </main>
    );
  }

  // ---------- ITINERARY (Stage 2 + live) - day-by-day builder ----------
  function renderItinerary() {
    const proposed = acts.filter((a) => a.status === "proposed" && !a.day_id);
    let preTrip = false, banner = "";
    if (todayIdx >= 0) banner = `Day ${todayIdx + 1} of the trip`;
    else if (daysUntil > 0) { preTrip = true; banner = `Trip starts in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`; }
    else banner = "Trip's a wrap";

    return (
      <main className="wrap">
        <WeatherStrip weather={weather} />
        {preTrip
          ? <p className="introline">Step 2 — once activities are rated, build each day here. Tap ✨ on a day to pull in the top-rated picks that fit.</p>
          : <div className="todaybanner mono">{banner}</div>}

        {todayIdx >= 0 && <EnergyPulseCard pulses={pulses} dayKey={tStr} onSubmit={submitPulse} />}
        <button className="suggestbtn" onClick={() => setSheet({ mode: "suggest" })}>＋ Suggest something now</button>
        <button className="buildbtn" onClick={runBuildItinerary} disabled={building || applyingProposal || !canBuildItinerary}>
          {building ? "Building..." : "Build itinerary from rated activities"}
        </button>
        <div className="shufflebar">
          <button className="shufflebtn" onClick={() => proposeArrangement("reroll")} disabled={!canBuildItinerary || building || applyingProposal || shuffleBusy === "optimize"}>
            {shuffleBusy === "reroll" ? "Re-rolling..." : "Re-roll"}
          </button>
          <button className="shufflebtn" onClick={() => proposeArrangement("optimize")} disabled={!canBuildItinerary || building || applyingProposal || shuffleBusy === "reroll"}>
            {shuffleBusy === "optimize" ? "Optimizing..." : "Optimize"}
          </button>
        </div>
        {buildGateStatus && <div className="buildnote">{buildGateStatus}</div>}
        <div className="buildnote">Unlocked activities can move when you rebuild. Lock pinned items first.</div>
        {proposal && <div className="proposalpanel">
          <div className="proposaleyebrow">Preview only</div>
          <div className="proposalhead">
            <div>
              <div className="proposaltitle">{proposalModeLabel}</div>
              <div className="proposaltext">{isArbiter ? "Review it here, then apply it if you want the live itinerary updated." : "Proposed - needs Dad to apply before the live itinerary changes."}</div>
            </div>
            <span className="proposalpill">{proposal.mode === "optimize" ? "same days, tighter order" : "fresh arrangement"}</span>
          </div>
          <div className="proposaltext">{proposalSummary}</div>
          <div className="proposalactions">
            {isArbiter && <button className="proposalapply" onClick={applyProposal} disabled={applyingProposal || !canBuildItinerary}>
              {applyingProposal ? "Applying..." : "Apply this arrangement"}
            </button>}
            <button className="proposaldismiss" onClick={dismissProposal} disabled={applyingProposal}>Dismiss</button>
          </div>
        </div>}
        {buildMsg && <div className="buildmsg">{buildMsg}</div>}

        {proposed.length > 0 && <>
          <div className="section-label coral">Suggested now · react and slot it in</div>
          {proposed.map((a) => <ActivityCard key={a.id} a={a} context="suggest" accent={REGION["Island-wide"]} {...cardProps} />)}
        </>}

        <div className="section-label">{showingProposal ? "Proposed week · preview only until Dad applies it" : "The week · tap ✨ to build a day from rated activities"}</div>
        {days.map((day) => {
          const items = showingProposal ? proposalDayItems(day.id) : dayItems(day.id); const A = ac(day.region); const open = plannerDay === day.id;
          const ph = dayPhase(day.sort);
          const isToday = day.date === tStr;
          const isTomorrow = todayIdx >= 0 && day.sort === days[todayIdx].sort + 1;
          return (
            <div className={"day" + (isToday ? " today" : "") + (showingProposal ? " proposalday" : "")} key={day.id}>
              <div className="dayhead">
                <span className="daynum" style={{ "--ac": A }}>{day.date.slice(8)}</span>
                <span>
                  <span className="daydow">{dow(day.date)}{isToday ? " · Today" : isTomorrow ? " · Tomorrow" : ""}</span>
                  <div className="daytheme">{day.label || cap(PHASE[ph])}</div>
                </span>
                <span className="dayphase">{cap(ph)}</span>
              </div>
              {items.map((a) => showingProposal
                ? <ProposalActivityCard key={a.id} a={a} accent={A} mustDos={mustDos} />
                : <ActivityCard key={a.id} a={a} context="day" accent={A} {...cardProps} />)}
              {items.length === 0 && <div className={"emptyhint" + (showingProposal ? " proposalempty" : "")} style={{ margin: "2px 0 6px" }}>
                {showingProposal ? "Nothing would land on this day in the preview." : "Empty — tap ✨ to pull in rated activities, or + Add."}
              </div>}
              {!showingProposal && <div className="dayactions">
                <button className="addbtn slim" onClick={() => setSheet({ mode: "day", dayId: day.id, dayLabel: `${dow(day.date)} ${day.date.slice(8)}` })}>+ Add</button>
                <button className={"planbtn" + (open ? " on" : "")} onClick={() => setPlannerDay(open ? null : day.id)}>✨ Suggest for this day</button>
              </div>}
              {!showingProposal && open && <PlannerPanel day={day} dPhase={ph} acts={acts} ratings={ratings} mustDos={mustDos} members={members} dad={dad} onSchedule={schedule} onDraft={draftDay} />}
            </div>
          );
        })}
      </main>
    );
  }

  return (
    <div>
      <header><div className="in">
        <div className="htop">
          <div><div className="eyebrow">U.S. Virgin Islands</div><h1 className="display">{trip.name}</h1><div className="dates mono">Aug 19–26, 2026</div></div>
          <div style={{ textAlign: "right", display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
            <span className="sync"><span className="d" /> live</span>
            <button className="mebtn" onClick={resetIdentity}>I'm {me.name} ▾</button>
          </div>
        </div>
      </div></header>

      {view === "itinerary" ? renderItinerary() : renderActivities()}

      <nav className="bottomnav">
        <button className={view === "activities" ? "on" : ""} onClick={() => setView("activities")}><span className="ni">📝</span>Activities</button>
        <button className={view === "itinerary" ? "on" : ""} onClick={() => setView("itinerary")}><span className="ni">🗓️</span>Itinerary</button>
      </nav>

      {sheet && <AddSheet sheet={sheet} onClose={() => setSheet(null)} onAdd={addActivity} />}
    </div>
  );
}

function IdentityGate({ members, gate, onChooseMember, onClaimPin, onEnterPin, onBack }) {
  const member = members.find((x) => x.id === gate.memberId) || null;
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPin("");
    setConfirmPin("");
    setError("");
    setBusy(false);
  }, [gate.mode, gate.memberId]);

  const changePin = (value, setter) => setter(value.replace(/\D/g, "").slice(0, 6));
  const submitClaim = async () => {
    if (!member) return;
    if (!PIN_RE.test(pin)) { setError("Use a 4-6 digit PIN."); return; }
    if (pin !== confirmPin) { setError("PINs don't match yet."); return; }
    setBusy(true);
    setError("");
    try { await onClaimPin(member, pin); }
    catch (err) { setError(err.message || "Couldn't save that PIN."); setBusy(false); }
  };
  const submitPin = async () => {
    if (!member) return;
    if (!PIN_RE.test(pin)) { setError("Enter your 4-6 digit PIN."); return; }
    setBusy(true);
    setError("");
    try { await onEnterPin(member, pin); }
    catch (err) { setError(err.message || "Wrong PIN."); setBusy(false); }
  };

  if ((gate.mode === "claim" || gate.mode === "pin") && member) {
    const claiming = gate.mode === "claim";
    // Forgotten PINs are reset manually for this trusted family app:
    // clear pin_hash and set claimed=false in the Supabase Table Editor.
    return (
      <div className="gate"><div className="gatecard">
        <div className="gatewho"><span className="mswatch" style={{ background: member.color }} />{member.name}{member.role === "arbiter" ? <span className="gaterolepill">final say</span> : null}</div>
        <h2 className="display">{claiming ? "Set a PIN" : "Enter PIN"}</h2>
        <p>{claiming ? "Claim your name once with a short PIN. After that, other devices need the PIN, but this phone remembers you." : "That name is already claimed. Enter the short PIN to use it on this device."}</p>
        <div className="gatefield">
          <label className="gatelabel" htmlFor="gate-pin">PIN</label>
          <input id="gate-pin" className="gateinput" type="password" inputMode="numeric" pattern="\d*" autoComplete={claiming ? "new-password" : "current-password"} maxLength={6} value={pin} onChange={(e) => changePin(e.target.value, setPin)} onKeyDown={(e) => { if (e.key === "Enter") claiming ? submitClaim() : submitPin(); }} />
        </div>
        {claiming && <div className="gatefield">
          <label className="gatelabel" htmlFor="gate-pin-confirm">Confirm PIN</label>
          <input id="gate-pin-confirm" className="gateinput" type="password" inputMode="numeric" pattern="\d*" autoComplete="new-password" maxLength={6} value={confirmPin} onChange={(e) => changePin(e.target.value, setConfirmPin)} onKeyDown={(e) => { if (e.key === "Enter") submitClaim(); }} />
        </div>}
        {error && <div className="gateerror">{error}</div>}
        <button className="gatecta" onClick={claiming ? submitClaim : submitPin} disabled={busy}>{busy ? (claiming ? "Saving..." : "Checking...") : (claiming ? "Claim this name" : "Log in")}</button>
        <button className="gateback" onClick={onBack} disabled={busy}>Back to names</button>
      </div></div>
    );
  }

  return (
    <div className="gate"><div className="gatecard">
      <h2 className="display">Who are you?</h2>
      <p>Claim your name once with a short PIN. After that, this phone remembers you and other devices need the PIN.</p>
      <div className="gategrid">
        {members.map((m) => <button key={m.id} className="gatebtn gatecell" onClick={() => onChooseMember(m)}>
          <span className="gatecelltop">
            <span className="mswatch" style={{ background: m.color }} />
            <span className="gatename">{m.name}</span>
            {m.claimed && <span className="gatelock" aria-hidden="true" title="Claimed" />}
          </span>
          <span className="gatesub">{m.role === "arbiter" ? "final say" : m.claimed ? "PIN on new devices" : "tap to claim"}</span>
        </button>)}
      </div>
    </div></div>
  );
}

function EnergyPulseCard({ pulses, dayKey, onSubmit }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const todaysPulses = pulses.filter((pulse) => {
    const energy = Number(pulse.energy);
    if (!Number.isInteger(energy) || energy < 1 || energy > 5) return false;
    return (pulse.created_at && dateKey(pulse.created_at) === dayKey) || pulse.day === dayKey;
  });
  const counts = ENERGY_LEVELS.map((level) => todaysPulses.filter((pulse) => Number(pulse.energy) === level.value).length);
  const total = todaysPulses.length;
  const average = total ? todaysPulses.reduce((sum, pulse) => sum + Number(pulse.energy), 0) / total : null;

  const send = async (value) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await onSubmit(value);
      setNote("Added to today's anonymous pulse.");
    } catch (err) {
      setError(err.message || "Couldn't send your pulse right now.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pulsecard">
      <div className="pulsehead">
        <div>
          <div className="pulseeyebrow">Anonymous energy pulse</div>
          <div className="pulsetitle">How's everyone's energy?</div>
        </div>
        <div className="pulseavg">
          <span className="pulseavgnum">{average ? average.toFixed(1) : "—"}</span>
          <span className="pulseavgmax">/5</span>
        </div>
      </div>
      <div className="pulsesub">Group-only, today-only vibe check. {total ? `${total} check-in${total === 1 ? "" : "s"} so far.` : "No check-ins yet today."}</div>

      <div className="pulseactions">
        {ENERGY_LEVELS.map((level) => (
          <button key={level.value} className="pulsebtn" onClick={() => send(level.value)} disabled={busy} aria-label={`send energy ${level.value} of 5`}>
            <span className="pulseemoji" aria-hidden="true">{level.emoji}</span>
            <span className="pulsebtnlabel">{level.label}</span>
          </button>
        ))}
      </div>

      <div className="pulsedist">
        {ENERGY_LEVELS.map((level, i) => (
          <div className="pulserow" key={level.value}>
            <div className="pulselevel"><span aria-hidden="true">{level.emoji}</span>{level.label}</div>
            <div className="pulsebarwrap"><div className="pulsebar" style={{ width: `${total ? counts[i] / total * 100 : 0}%` }} /></div>
            <div className="pulsecnt mono">{counts[i]}</div>
          </div>
        ))}
      </div>

      {note && <div className="pulsenote">{note}</div>}
      {error && <div className="pulseerror">{error}</div>}
    </section>
  );
}

function ProposalActivityCard({ a, accent, mustDos }) {
  const mustCount = mustDos.filter((x) => x.activity_id === a.id).length;

  return (
    <div className={"act proposalact" + (a.done ? " done" : "")} style={{ "--ac": accent }}>
      <div className="acttop">
        <div className="acttitle">
          <div className="aname">{a.start_time && <span className="atime">{fmtTime(a.start_time)}</span>}{a.title}</div>
          {a.notes && <div className="anote">{a.notes}</div>}
          {(a.phase || mustCount > 0 || a.locked) && <div className="flags">
            {a.phase && <span className="phasechip">{PHASE[a.phase] || a.phase}</span>}
            {a.locked && <span className="lockchip">locked</span>}
            {mustCount > 0 && <span className="mustbadge">★ {mustCount}</span>}
          </div>}
        </div>
        <span className="proposaltag">preview</span>
      </div>
    </div>
  );
}

function PrivateNotesCard({ note, loaded, statusLabel, statusTone, onChange, footer }) {
  return (
    <section className="notescard">
      <div className="noteshead">
        <div>
          <h2 className="display notestitle">My private notes</h2>
          <p className="noteshelper">Only you see this. Dump your ideas, must-dos, and what you're hoping for on the trip.</p>
        </div>
        {statusLabel && <span className={"notestatus" + (statusTone ? ` ${statusTone}` : "")}>{statusLabel}</span>}
      </div>
      <textarea
        className="notesbox"
        value={note}
        disabled={!loaded}
        placeholder={loaded ? "Beach day thoughts, food priorities, backup plans, birthday ideas..." : "Loading your note..."}
        onChange={(e) => onChange(e.target.value)}
      />
      {footer && <div className="notesfooter">{footer}</div>}
    </section>
  );
}

function AiPlanPreview({ proposal, busy, onApply, onDismiss }) {
  return (
    <section className="proposalpanel">
      <div className="proposaleyebrow">Preview only</div>
      <div className="proposalhead">
        <div>
          <div className="proposaltitle">AI plan proposal</div>
          <div className="proposaltext">Review the day themes here first. Applying this only updates the day labels, not the schedule itself.</div>
        </div>
        <span className="proposalpill">Dad's note to themes</span>
      </div>
      <div className="proposaltext">{proposal.summary}</div>

      <div className="aiplansection">Heads-ups</div>
      {proposal.flags.length > 0
        ? <div className="aiplanstack">
            {proposal.flags.map((flag, index) => (
              <div className="aiplanflag" key={`${flag.activity}-${index}`}>
                <div className="aiplanflaghead">
                  <strong>{flag.activity}</strong>
                  {typeof flag.groupAvg === "number" && <span className="proposalpill">group avg {flag.groupAvg.toFixed(1)}</span>}
                </div>
                {flag.note && <div className="proposaltext">{flag.note}</div>}
              </div>
            ))}
          </div>
        : <div className="aiplanempty">No low-interest tension flags jumped out in this pass.</div>}

      <div className="aiplansection">Proposed trip spine</div>
      <div className="aiplanstack">
        {proposal.spine.map((item, index) => (
          <div className="aiplanitem" key={`${item.date}-${index}`}>
            <div className="aiplanitemhead">
              <span className="mono">{dow(item.date)} {item.date}</span>
              <strong>{item.theme}</strong>
            </div>
            {item.rationale && <div className="proposaltext">{item.rationale}</div>}
          </div>
        ))}
      </div>

      <div className="proposalactions">
        <button className="proposalapply" onClick={onApply} disabled={busy}>
          {busy ? "Applying..." : "Apply this plan"}
        </button>
        <button className="proposaldismiss" onClick={onDismiss} disabled={busy}>Dismiss</button>
      </div>
    </section>
  );
}

function PlannerPanel({ day, dPhase, acts, ratings, mustDos, members, dad, onSchedule, onDraft }) {
  const scheduled = acts.filter((a) => a.day_id === day.id && a.status === "scheduled");
  const load = scheduled.reduce((s, a) => s + dwellOf(a), 0) + Math.max(0, scheduled.length - 1) * 20;
  const pct = Math.min(100, Math.round(load / DAY_BUDGET * 100));
  // Nice-to-have: once a day has items, lean suggestions toward its dominant region.
  const regionCounts = {};
  scheduled.forEach((a) => { if (a.region) regionCounts[a.region] = (regionCounts[a.region] || 0) + 1; });
  const domRegion = Object.keys(regionCounts).sort((x, y) => regionCounts[y] - regionCounts[x])[0] || null;

  const pool = acts.filter((a) => !a.day_id && (a.status === "idea" || a.status === "maybe_later" || a.status === "proposed"));
  const score = (a) => {
    const avg = groupAvg(a, ratings) || 0;
    const must = mustWeight(a, mustDos, members);
    let fit = 0;
    if (a.phase) fit += a.phase === dPhase ? 1.5 : -0.75; // phase match boost / mismatch penalty; untagged neutral
    if (domRegion && a.region) fit += a.region === domRegion ? 0.5 : 0; // light region clustering
    return { s: avg + must + fit, avg, phaseMatch: a.phase === dPhase, count: mustDos.filter((x) => x.activity_id === a.id).length };
  };
  const ranked = pool.map((a) => ({ a, ...score(a) })).sort((x, y) => y.s - x.s).slice(0, 6);
  // Draft: top picks that respect the day's phase window and fit the time budget.
  let acc = load; const fill = [];
  for (const r of ranked) {
    const a = r.a;
    if (a.phase && a.phase !== dPhase) continue; // don't auto-draft into the wrong phase
    if (acc + dwellOf(a) <= DAY_BUDGET * 0.92) { fill.push(a); acc += dwellOf(a) + 20; }
  }

  return (
    <div className="planner">
      <div className="loadrow">
        <span className="loadlbl">Day load (rough)</span>
        <span className="loadwrap"><span className={"loadbar" + (load > DAY_BUDGET ? " over" : "")} style={{ width: pct + "%" }} /></span>
        <span className="loadnum mono">{Math.round(load / 60 * 10) / 10}h{load > DAY_BUDGET ? " · full" : ""}</span>
      </div>
      {ranked.length === 0 && <div className="emptyhint" style={{ margin: "8px 0 0" }}>No rated activities to pull from yet — add ideas and rate them over in Activities, then draft here.</div>}
      {ranked.map(({ a, avg, phaseMatch, count }) => (
        <div className="cand" key={a.id}>
          <div className="candmain">
            <div className="candname">{a.title}</div>
            <div className="candmeta">
              <span className="phasechip">{a.phase ? PHASE[a.phase] : "anytime"}{phaseMatch ? " · fits" : ""}</span>
              <span className="mono"> · {dwellOf(a)}m · want {avg ? avg.toFixed(1) : "—"}</span>
              {count > 0 && <span className="mustbadge"> ★ {count}</span>}
            </div>
          </div>
          <button className="candadd" onClick={() => onSchedule(a, day.id)}>+ Add</button>
        </div>
      ))}
      {fill.length > 0 && <button className="draftbtn" onClick={() => onDraft(day, fill)}>✨ Draft this day — add the top {fill.length} that fit</button>}
    </div>
  );
}

function ActivityCard({ a, context, accent, me, members, ratings, mustDos, myMustCount, limit, days, on, readOnly = false, allowMaybeAction = true, allowScheduleAction = true }) {
  const myR = ratings.find((r) => r.activity_id === a.id && r.member_id === me.id);
  const myWant = myR ? myR.want : 0;
  const all = ratings.filter((r) => r.activity_id === a.id);
  const avg = all.length ? all.reduce((s, r) => s + r.want, 0) / all.length : null;
  const mustCount = mustDos.filter((x) => x.activity_id === a.id).length;          // anonymous count only
  const mine = mustDos.some((x) => x.activity_id === a.id && x.member_id === me.id); // my own flag (allowed)
  const atCap = limit != null && myMustCount >= limit && !mine;
  const showPhaseEditor = !readOnly && context !== "day";
  const showRate = context !== "maybe";
  const showMust = !readOnly && context !== "maybe";
  const showSchedule = !readOnly && allowScheduleAction && context !== "day";
  const showMaybe = !readOnly && allowMaybeAction && context !== "maybe";
  const showDelete = !readOnly;

  return (
    <div className={"act" + (a.done ? " done" : "") + (readOnly ? " readonly" : "")} style={{ "--ac": accent }}>
      <div className="acttop">
        {context === "day" && <button className={"donebox" + (a.done ? " on" : "")} onClick={() => on.done(a)} aria-label="mark done">{a.done ? "✓" : ""}</button>}
        <div className="acttitle">
          <div className="aname">{a.start_time && <span className="atime">{fmtTime(a.start_time)}</span>}{a.title}</div>
          {a.notes && <div className="anote">{a.notes}</div>}
          {((!showPhaseEditor && a.phase) || mustCount > 0 || (context === "day" && a.locked)) && <div className="flags">
            {!showPhaseEditor && a.phase && <span className="phasechip">{PHASE[a.phase] || a.phase}</span>}
            {context === "day" && a.locked && <span className="lockchip">locked</span>}
            {mustCount > 0 && <span className="mustbadge">★ {mustCount}</span>}
          </div>}
        </div>
        <button className="amenu" onClick={() => on.rename(a)} title="Rename">⋯</button>
      </div>

      {showPhaseEditor && <div className="phaseedit">
        <span className="phaselbl2">when</span>
        {[["early", "Early"], ["mid", "Mid"], ["late", "Late"]].map(([v, l]) =>
          <button key={v} className={"pchip" + (a.phase === v ? " on" : "")} onClick={() => on.setPhase(a, v)}>{l}</button>)}
        {a.phase && <button className="pchip clear" onClick={() => on.setPhase(a, null)}>clear</button>}
      </div>}

      {showRate && <div className="rateblock">
        <div className="raterow">
          <span className="ratemini">you</span>
          <div className="dots">{[1, 2, 3, 4, 5].map((n) => <button key={n} className={"rdot" + (myWant === n ? " on" : "")} onClick={() => on.want(a, n)} aria-label={`rate ${n} of 5`}>{n}</button>)}</div>
          <span className={"ratesel" + (readOnly ? " readonly" : "")}>{myWant ? RLABELS[myWant - 1] : readOnly ? "Not rated yet" : "rate it"}</span>
        </div>
        <div className="grouprow">
          <span className="ratemini">group</span>
          <span className="avgwrap"><span className="avgbar" style={{ width: (avg ? avg / 5 * 100 : 0) + "%" }} /></span>
          <span className="avgnum mono">{avg ? avg.toFixed(1) : "—"}</span>
        </div>
      </div>}

      {context === "day" && <div className="dayctl">
        <button className={"lockbtn" + (a.locked ? " on" : "")} onClick={() => on.lock(a)} title={a.locked ? "Locked - a rebuild will not move it" : "Lock to this day and slot"}>
          {a.locked ? "Locked" : "Lock"}
        </button>
        <button className="reordbtn" onClick={() => on.reorder(a, "up")} aria-label="move earlier">Up</button>
        <button className="reordbtn" onClick={() => on.reorder(a, "down")} aria-label="move later">Down</button>
        <select className="schedsel" value="" onChange={(e) => on.moveDay(a, e.target.value)}>
          <option value="" disabled>Move to...</option>
          {days.map((d) => <option key={d.id} value={d.id}>{dow(d.date)} {d.date.slice(8)}{d.label ? ` â€” ${d.label.slice(0, 18)}` : ""}</option>)}
        </select>
      </div>}

      {(showMust || showSchedule || showMaybe || showDelete) && <div className="actbtns">
        {showMust && <button className={"abtn" + (mine ? " on" : "")} disabled={atCap} onClick={() => on.must(a, mine)} title={atCap ? `All ${limit} must-dos used` : ""}>{mine ? "★ Must-do (mine)" : atCap ? "★ limit reached" : "☆ Must-do"}</button>}
        {showSchedule && <select className="schedsel" value="" onChange={(e) => on.schedule(a, e.target.value)}><option value="" disabled>＋ Into a day…</option>{days.map((d) => <option key={d.id} value={d.id}>{dow(d.date)} {d.date.slice(8)}{d.label ? ` — ${d.label.slice(0, 22)}` : ""}</option>)}</select>}
        {showMaybe && <button className="abtn" onClick={() => on.maybe(a)}>→ Maybe later</button>}
        {showDelete && <button className="abtn danger" onClick={() => on.del(a)}>Delete</button>}
      </div>}
    </div>
  );
}

function AddSheet({ sheet, onClose, onAdd }) {
  const [title, setTitle] = useState(""); const [phase, setPhase] = useState(null);
  const TITLES = { wishlist: "Add an activity", suggest: "Suggest something now", day: `Add to ${sheet.dayLabel || "this day"}` };
  const SUBS = { wishlist: "Add something you'd want to do — everyone rates it 1–5 and tags when it fits, then it gets built into a day.", suggest: "A clear channel for in-the-moment ideas, so they don't get lost in the group chat. The crew reacts and it slots into a day.", day: "Adds straight onto this day." };
  const submit = () => { if (title.trim()) onAdd({ mode: sheet.mode, title: title.trim(), phase, dayId: sheet.dayId }); };
  return (
    <div className="sheetbg" onClick={onClose}><div className="sheet" onClick={(e) => e.stopPropagation()}>
      <div className="sheethead"><h3 className="display">{TITLES[sheet.mode]}</h3><button className="sheetx" onClick={onClose}>✕</button></div>
      <p className="sheetsub">{SUBS[sheet.mode]}</p>
      <input className="sheetinput" autoFocus value={title} placeholder="What do you want to do?" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
      <div className="phaserow"><span className="phaselbl">when (optional)</span>{[["early", "Early"], ["mid", "Mid"], ["late", "Late"], [null, "Any"]].map(([v, l]) => <button key={l} className={"phasebtn" + (phase === v ? " on" : "")} onClick={() => setPhase(v)}>{l}</button>)}</div>
      <button className="sheetsubmit" disabled={!title.trim()} onClick={submit}>{sheet.mode === "suggest" ? "Send to the crew" : sheet.mode === "wishlist" ? "Add activity" : "Add"}</button>
    </div></div>
  );
}

function WeatherStrip({ weather }) {
  if (!weather) return <div className="wnote">Loading weather…</div>;
  if (weather === "err") return <div className="wnote">Live weather unavailable right now — it drives the daily plan during the trip.</div>;
  const d = weather.daily; if (!d || !d.time) return null;
  return (<>
    <div className="wstrip">{d.time.map((date, i) => { const w = wcode(d.weather_code[i]); const pr = d.precipitation_probability_max[i]; return (
      <div className={"wday" + (pr >= 50 ? " rain" : "")} key={date}><div className="dw">{dow(date)}</div><div className="ic">{w.i}</div><div className="tp">{Math.round(d.temperature_2m_max[i])}°</div>{pr >= 30 && <div className="pr">{pr}%</div>}</div>); })}</div>
    <div className="wnote">Live now for St. Croix. Trip-date forecasts fill in ~2 weeks out — then rainy days flag a swap.</div>
  </>);
}
