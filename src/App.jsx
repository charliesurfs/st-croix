import React, { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./supabaseClient.js";
import { getWeather, wcode } from "./weather.js";
import { driveTime } from "./data/geo.js";
import { buildItinerary } from "./data/buildItinerary.js";

const REGION = {
  "Christiansted": "#0E6E6E", "West End": "#C98A1E", "Rainforest & North Shore": "#3F8E5B",
  "East End": "#2E7C9E", "Island-wide": "#94804E", "Travel": "#73817E"
};
const ac = (r) => REGION[r] || "#5E6D6A";
const ME_KEY = "stx_me";
const RLABELS = ["Don't want", "Eh", "Maybe", "Want to", "Really want"];
const PHASE = { early: "early trip", mid: "mid trip", late: "late trip" };
const DAY_BUDGET = 540; // ~9 hrs of daytime activity
const fmtTime = (t) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const dow = (d) => d ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(d + "T12:00").getDay()] : "";
const todayStr = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
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

export default function App() {
  const [trip, setTrip] = useState(null);
  const [members, setMembers] = useState([]);
  const [days, setDays] = useState([]);
  const [acts, setActs] = useState([]);
  const [ratings, setRatings] = useState([]);
  const [mustDos, setMustDos] = useState([]);
  const [meId, setMeId] = useState(() => localStorage.getItem(ME_KEY) || null);
  const [status, setStatus] = useState("loading");
  const [weather, setWeather] = useState(null);
  const [view, setView] = useState("activities");   // 'activities' (Stage 1) | 'itinerary' (Stage 2 + live)
  const [sortMode, setSortMode] = useState("wanted"); // 'wanted' | 'when'
  const [sheet, setSheet] = useState(null);
  const [plannerDay, setPlannerDay] = useState(null);
  const [building, setBuilding] = useState(false);
  const [buildMsg, setBuildMsg] = useState(null);
  const reloadTimer = useRef(null);
  const wantTimers = useRef({});

  const loadAll = useCallback(async () => {
    const { data: trips, error } = await supabase.from("trips").select("*").limit(1);
    if (error) { setStatus("error"); return; }
    const t = trips && trips[0];
    if (!t) { setStatus("error"); return; }
    const [m, d, a, r, md] = await Promise.all([
      supabase.from("members").select("*").eq("trip_id", t.id),
      supabase.from("days").select("*").eq("trip_id", t.id).order("sort"),
      supabase.from("activities").select("*").eq("trip_id", t.id).order("sort"),
      supabase.from("ratings").select("*"),
      supabase.from("must_dos").select("*")
    ]);
    setTrip(t); setMembers(m.data || []); setDays(d.data || []);
    setActs(a.data || []); setRatings(r.data || []); setMustDos(md.data || []);
    setStatus((m.data || []).some((x) => x.id === localStorage.getItem(ME_KEY)) ? "ready" : "needsMe");
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => {
    const reload = () => { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(loadAll, 600); };
    const ch = supabase.channel("trip")
      .on("postgres_changes", { event: "*", schema: "public", table: "activities" }, reload)
      .on("postgres_changes", { event: "*", schema: "public", table: "ratings" }, reload)
      .on("postgres_changes", { event: "*", schema: "public", table: "must_dos" }, reload)
      .on("postgres_changes", { event: "*", schema: "public", table: "days" }, reload)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [loadAll]);
  useEffect(() => { getWeather().then(setWeather).catch(() => setWeather("err")); }, []);

  const me = members.find((x) => x.id === meId) || null;
  const pickMe = (id) => { localStorage.setItem(ME_KEY, id); setMeId(id); setStatus("ready"); };

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

  // ---- Stage 2: auto-build (B1) + manual move / lock (B4) ----
  const runBuildItinerary = async () => {
    if (!confirm("Auto-build the week from the rated activities?\n\nThis re-arranges all UNLOCKED items into days. Locked items (your manual placements + anchors) stay put. Times are rough morning/afternoon/evening suggestions — pin real bookings by locking them.")) return;
    setBuilding(true); setBuildMsg(null);
    const { assignments, didNotFit } = buildItinerary({ activities: acts, days, ratings, mustDos, members });
    for (const as of assignments) {
      if (as.locked) continue; // never touch locked items
      await supabase.from("activities").update({ day_id: as.day_id, status: "scheduled", start_time: as.start_time, sort: as.sort }).eq("id", as.id);
    }
    for (const id of didNotFit) {
      await supabase.from("activities").update({ status: "maybe_later", day_id: null, start_time: null }).eq("id", id);
    }
    const placed = assignments.filter((a) => !a.locked).length;
    setBuilding(false);
    setBuildMsg(`Built ${placed} ${placed === 1 ? "activity" : "activities"} into days. ${didNotFit.length} didn't fit — find them under “Maybe later” in Activities. Times are rough; lock anything with a real booking.`);
    loadAll();
  };
  // Manual move to another day -> pins (locks) the item so a rebuild won't move it.
  const moveToDay = async (a, dayId) => {
    if (!dayId || dayId === a.day_id) return;
    const target = acts.filter((x) => x.day_id === dayId && x.status === "scheduled");
    const maxSort = target.length ? Math.max(...target.map((x) => x.sort || 0)) : -1;
    await supabase.from("activities").update({ day_id: dayId, status: "scheduled", sort: maxSort + 1, locked: true }).eq("id", a.id);
    loadAll();
  };
  // Reorder within a day (swap sort with neighbour) -> pins the moved item.
  const reorderInDay = async (a, dir) => {
    const list = acts.filter((x) => x.day_id === a.day_id && x.status === "scheduled").sort((x, y) => (x.sort || 0) - (y.sort || 0));
    const i = list.findIndex((x) => x.id === a.id);
    const j = dir === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= list.length) return;
    const b = list[j];
    await supabase.from("activities").update({ sort: b.sort || 0, locked: true }).eq("id", a.id);
    await supabase.from("activities").update({ sort: a.sort || 0 }).eq("id", b.id);
    loadAll();
  };
  const toggleLock = async (a) => { await supabase.from("activities").update({ locked: !a.locked }).eq("id", a.id); loadAll(); };

  if (status === "loading") return <div className="center">Loading the trip…</div>;
  if (status === "error") return <div className="center">Couldn't reach the trip. Check your Supabase URL/key in <code>.env</code> and that the schema + migration ran.</div>;
  if (status === "needsMe") return (
    <div className="gate"><div className="gatecard">
      <h2 className="display">Who are you?</h2>
      <p>Pick yourself so your ratings and must-dos are tagged to you. Adds stay anonymous.</p>
      {members.map((m) => <button key={m.id} className="gatebtn" onClick={() => pickMe(m.id)}><span className="mswatch" style={{ background: m.color }} />{m.name}{m.role === "arbiter" ? " · final say" : ""}</button>)}
    </div></div>
  );

  const myMustCount = mustDos.filter((x) => x.member_id === meId).length;
  const limit = me ? me.must_do_limit : null;
  const dad = members.find((m) => m.role === "arbiter");
  const cardProps = { me, members, ratings, mustDos, myMustCount, limit, days, on: { want: setWant, must: toggleMust, done: toggleDone, maybe: toMaybe, schedule, setPhase, del, rename, lock: toggleLock, moveDay: moveToDay, reorder: reorderInDay } };
  const dayItems = (dayId) => acts.filter((a) => a.day_id === dayId && a.status === "scheduled").sort((x, y) => (x.done - y.done) || ((x.start_time || "99") < (y.start_time || "99") ? -1 : x.sort - y.sort));
  const rankScore = (a) => (groupAvg(a, ratings) || 0) + mustWeight(a, mustDos, members);

  const tStr = todayStr();
  const todayIdx = days.findIndex((d) => d.date === tStr);
  const daysUntil = days[0] ? Math.ceil((new Date(days[0].date) - new Date(tStr)) / 86400000) : 0;

  // ---------- ACTIVITIES (Stage 1) - flat rated list ----------
  function renderActivities() {
    const candidates = acts.filter((a) => !a.day_id && (a.status === "idea" || a.status === "proposed"));
    const maybe = acts.filter((a) => !a.day_id && a.status === "maybe_later");

    let body;
    if (sortMode === "wanted") {
      const sorted = [...candidates].sort((x, y) => rankScore(y) - rankScore(x));
      body = sorted.map((a) => <ActivityCard key={a.id} a={a} context="flat" accent={ac(a.region)} {...cardProps} />);
    } else {
      const groups = [["early", "Early trip"], ["mid", "Mid trip"], ["late", "Late trip"], [null, "Whenever"]];
      body = groups.map(([ph, label]) => {
        const items = candidates.filter((a) => (a.phase || null) === ph).sort((x, y) => rankScore(y) - rankScore(x));
        if (!items.length) return null;
        return (
          <React.Fragment key={label}>
            <div className="section-label">{label}</div>
            {items.map((a) => <ActivityCard key={a.id} a={a} context="flat" accent={ac(a.region)} {...cardProps} />)}
          </React.Fragment>
        );
      });
    }

    return (
      <main className="wrap">
        <div className="mebar">
          {members.map((m) => <span key={m.id} className="mchip"><span className="mswatch" style={{ background: m.color }} />{m.name}{m.role === "arbiter" ? " ⭐" : ""}</span>)}
          <span className="mecount">{limit == null ? "must-dos: unlimited" : <>must-dos: <b>{myMustCount}/{limit}</b></>}</span>
        </div>

        <p className="introline">Step 1 — add everything you'd want to do, rate it 1–5, and tag roughly when it fits. We'll build the daily schedule next.</p>

        <div className="sortrow">
          <button className={sortMode === "wanted" ? "on" : ""} onClick={() => setSortMode("wanted")}>Most wanted</button>
          <button className={sortMode === "when" ? "on" : ""} onClick={() => setSortMode("when")}>By when</button>
        </div>

        {candidates.length === 0 && <div className="emptyhint">Nothing here yet. Tap “+ Add activity” to start the list — everyone rates it, then you build the days over in Itinerary.</div>}
        {body}

        <button className="addbtn" onClick={() => setSheet({ mode: "wishlist" })}>+ Add activity</button>

        {maybe.length > 0 && <>
          <div className="section-label">Maybe later · parked / didn't fit</div>
          {maybe.map((a) => <ActivityCard key={a.id} a={a} context="maybe" accent={ac(a.region)} {...cardProps} />)}
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
          ? <p className="introline">Step 2 — build the week from your rated activities, then drag, lock, and adjust. Tap ✨ on a single day for hand-picked suggestions instead.</p>
          : <div className="todaybanner mono">{banner}</div>}

        <button className="buildbtn" onClick={runBuildItinerary} disabled={building}>{building ? "Building…" : "✨ Build itinerary from rated activities"}</button>
        <div className="buildnote">Auto-arranges unlocked activities across the 8 days by rating, must-dos, phase, and driving. 🔒 Lock anything with a real booking so a rebuild leaves it alone.</div>
        {buildMsg && <div className="buildmsg">{buildMsg}</div>}

        <button className="suggestbtn" onClick={() => setSheet({ mode: "suggest" })}>＋ Suggest something now</button>
        {proposed.length > 0 && <>
          <div className="section-label coral">Suggested now · react and slot it in</div>
          {proposed.map((a) => <ActivityCard key={a.id} a={a} context="suggest" accent={REGION["Island-wide"]} {...cardProps} />)}
        </>}

        <div className="section-label">The week · ✨ build all, or suggest per day</div>
        {days.map((day) => {
          const items = dayItems(day.id); const A = ac(day.region); const open = plannerDay === day.id;
          const ph = dayPhase(day.sort);
          const isToday = day.date === tStr;
          const isTomorrow = todayIdx >= 0 && day.sort === days[todayIdx].sort + 1;
          return (
            <div className={"day" + (isToday ? " today" : "")} key={day.id}>
              <div className="dayhead">
                <span className="daynum" style={{ "--ac": A }}>{day.date.slice(8)}</span>
                <span>
                  <span className="daydow">{dow(day.date)}{isToday ? " · Today" : isTomorrow ? " · Tomorrow" : ""}</span>
                  <div className="daytheme">{day.label || cap(PHASE[ph])}</div>
                </span>
                <span className="dayphase">{cap(ph)}</span>
              </div>
              {items.map((a) => <ActivityCard key={a.id} a={a} context="day" accent={A} {...cardProps} />)}
              {items.length === 0 && <div className="emptyhint" style={{ margin: "2px 0 6px" }}>Empty — ✨ Build itinerary, tap Suggest below, or + Add.</div>}
              <div className="dayactions">
                <button className="addbtn slim" onClick={() => setSheet({ mode: "day", dayId: day.id, dayLabel: `${dow(day.date)} ${day.date.slice(8)}` })}>+ Add</button>
                <button className={"planbtn" + (open ? " on" : "")} onClick={() => setPlannerDay(open ? null : day.id)}>✨ Suggest for this day</button>
              </div>
              {open && <PlannerPanel day={day} dPhase={ph} acts={acts} ratings={ratings} mustDos={mustDos} members={members} dad={dad} onSchedule={schedule} onDraft={draftDay} />}
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
            <button className="mebtn" onClick={() => { localStorage.removeItem(ME_KEY); setMeId(null); setStatus("needsMe"); }}>I'm {me.name} ▾</button>
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

function ActivityCard({ a, context, accent, me, members, ratings, mustDos, myMustCount, limit, days, on }) {
  const myR = ratings.find((r) => r.activity_id === a.id && r.member_id === me.id);
  const myWant = myR ? myR.want : 0;
  const all = ratings.filter((r) => r.activity_id === a.id);
  const avg = all.length ? all.reduce((s, r) => s + r.want, 0) / all.length : null;
  const mustCount = mustDos.filter((x) => x.activity_id === a.id).length;          // anonymous count only
  const mine = mustDos.some((x) => x.activity_id === a.id && x.member_id === me.id); // my own flag (allowed)
  const atCap = limit != null && myMustCount >= limit && !mine;
  const editPhase = context !== "day";
  const showRate = context !== "maybe", showMust = context !== "maybe", showSchedule = context !== "day", showMaybe = context !== "maybe";

  return (
    <div className={"act" + (a.done ? " done" : "")} style={{ "--ac": accent }}>
      <div className="acttop">
        {context === "day" && <button className={"donebox" + (a.done ? " on" : "")} onClick={() => on.done(a)} aria-label="mark done">{a.done ? "✓" : ""}</button>}
        <div className="acttitle">
          <div className="aname">{a.start_time && <span className="atime">{fmtTime(a.start_time)}</span>}{a.title}</div>
          {a.notes && <div className="anote">{a.notes}</div>}
          {((!editPhase && a.phase) || mustCount > 0 || (context === "day" && a.locked)) && <div className="flags">
            {!editPhase && a.phase && <span className="phasechip">{PHASE[a.phase] || a.phase}</span>}
            {context === "day" && a.locked && <span className="lockchip">🔒 locked</span>}
            {mustCount > 0 && <span className="mustbadge">★ {mustCount}</span>}
          </div>}
        </div>
        <button className="amenu" onClick={() => on.rename(a)} title="Rename">⋯</button>
      </div>

      {editPhase && <div className="phaseedit">
        <span className="phaselbl2">when</span>
        {[["early", "Early"], ["mid", "Mid"], ["late", "Late"]].map(([v, l]) =>
          <button key={v} className={"pchip" + (a.phase === v ? " on" : "")} onClick={() => on.setPhase(a, v)}>{l}</button>)}
        {a.phase && <button className="pchip clear" onClick={() => on.setPhase(a, null)}>clear</button>}
      </div>}

      {showRate && <div className="rateblock">
        <div className="raterow">
          <span className="ratemini">you</span>
          <div className="dots">{[1, 2, 3, 4, 5].map((n) => <button key={n} className={"rdot" + (myWant === n ? " on" : "")} onClick={() => on.want(a, n)} aria-label={`rate ${n} of 5`}>{n}</button>)}</div>
          <span className="ratesel">{myWant ? RLABELS[myWant - 1] : "rate it"}</span>
        </div>
        <div className="grouprow">
          <span className="ratemini">group</span>
          <span className="avgwrap"><span className="avgbar" style={{ width: (avg ? avg / 5 * 100 : 0) + "%" }} /></span>
          <span className="avgnum mono">{avg ? avg.toFixed(1) : "—"}</span>
        </div>
      </div>}

      {context === "day" && <div className="dayctl">
        <button className={"lockbtn" + (a.locked ? " on" : "")} onClick={() => on.lock(a)} title={a.locked ? "Locked — a rebuild won't move it" : "Lock to this day/slot"}>{a.locked ? "🔒 Locked" : "🔓 Lock"}</button>
        <button className="reordbtn" onClick={() => on.reorder(a, "up")} aria-label="move earlier">↑</button>
        <button className="reordbtn" onClick={() => on.reorder(a, "down")} aria-label="move later">↓</button>
        <select className="schedsel" value="" onChange={(e) => on.moveDay(a, e.target.value)}><option value="" disabled>Move to…</option>{days.map((d) => <option key={d.id} value={d.id}>{dow(d.date)} {d.date.slice(8)}{d.label ? ` — ${d.label.slice(0, 18)}` : ""}</option>)}</select>
      </div>}

      <div className="actbtns">
        {showMust && <button className={"abtn" + (mine ? " on" : "")} disabled={atCap} onClick={() => on.must(a, mine)} title={atCap ? `All ${limit} must-dos used` : ""}>{mine ? "★ Must-do (mine)" : atCap ? "★ limit reached" : "☆ Must-do"}</button>}
        {showSchedule && <select className="schedsel" value="" onChange={(e) => on.schedule(a, e.target.value)}><option value="" disabled>＋ Into a day…</option>{days.map((d) => <option key={d.id} value={d.id}>{dow(d.date)} {d.date.slice(8)}{d.label ? ` — ${d.label.slice(0, 22)}` : ""}</option>)}</select>}
        {showMaybe && <button className="abtn" onClick={() => on.maybe(a)}>→ Maybe later</button>}
        <button className="abtn danger" onClick={() => on.del(a)}>Delete</button>
      </div>
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
