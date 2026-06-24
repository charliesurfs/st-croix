# St. Croix Trip App

A shared, real-time trip planner for four people — built so it's genuinely usable **before and during** the trip, with **Dad as final arbiter**, a **must-do system** (3 per person, unlimited for Dad), a **maybe-later bucket**, and **live weather**. The bigger pieces we designed (day-planner, reshuffle, events feed, then & now) are built into the database and scoped in the roadmap below.

**Stack:** React + Vite, Supabase (Postgres + realtime), installable PWA. Weather is Open-Meteo (free, no key). Free to host.

---

## What works in this v0.1

- **One shared plan, live.** Everyone sees the same itinerary; edits sync across phones in real time.
- **No accounts to start.** You pick your name on first open (stored on your device). Adds are **anonymous**. Real logins are a roadmap item.
- **Two add channels** through a clean add sheet (no browser prompts):
  - **Wishlist** — researched, pre-trip ideas. Land here, get rated, get planned.
  - **Suggest something now** — a loud, structured channel for in-the-moment ideas so they don't get lost in the group chat. They show under "Suggested now," the crew reacts, and they slot into a day.
- **1–5 rating** ("don't want → really want") with the group average shown, and **Dad's number shown explicitly** so it's never buried.
- **Must-do flag** with the cap: members get **3**, **Dad unlimited** — enforced in the UI *and* by a database trigger.
- **Check off** completed activities (separate from status, so they stay on their day), or send anything to the **Maybe-later** bucket and reschedule it.
- Optional **early / mid / late** phase tag on the few activities where timing matters.
- **Live weather** strip for St. Croix (current week; trip-date forecasts populate ~2 weeks out).
- **Two environments** via a bottom tab bar: **Plan** (the full week + wishlist, mostly pre-trip) and **Today** (the live day plus a peek at tomorrow, the suggest-now channel, and weather).
- **Day-planner.** In Plan, each day has a ✨ **Suggest for this day** that ranks unscheduled wishlist items by group rating + must-do weight (Dad heaviest) + region fit, shows a rough **day-load meter** (dwell + travel), and lets you one-tap add or **Draft this day** to auto-fill the top region-matching picks.

---

## Setup (~15 min)

**1. Create a Supabase project** — [supabase.com](https://supabase.com), free tier. (You'll make this account yourself.)

**2. Run the schema.** In your project: **SQL Editor → New query →** paste all of `supabase/schema.sql` → **Run.** That creates the tables, the realtime publication, the v0.1 security policies, and seeds the St. Croix trip. (Already ran the old schema? Run `supabase/migrations/002_loop.sql` instead — it adds the new columns without touching your data.)

**3. Grab your keys.** **Project Settings → API** → copy the **Project URL** and the **anon public** key.

**4. Configure the app.**
```bash
cp .env.example .env
# paste your URL + anon key into .env
```

**5. Run it.**
```bash
npm install
npm run dev
```
Open the local URL, pick your name, and you'll see the seeded plan. Open it in a second browser, pick a different name, and watch edits sync.

**6. Deploy + install on phones.** Push to GitHub, import the repo into **Vercel** (or Netlify/Cloudflare Pages), and set the same two env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). Open the deployed URL on each phone → **Share → Add to Home Screen.** It installs and launches like a native app.

> **Troubleshooting:** If changes don't appear live, check **Database → Replication** and confirm the tables are in the `supabase_realtime` publication (the schema adds them; this only matters if a step errored). If the app says it can't reach the trip, re-check `.env` and that the schema ran without errors.

---

## Data model (so the next features are easy to build)

- **trips** → the trip + a simple `passphrase` (for later gating).
- **members** → `role` (`arbiter` | `member`) and `must_do_limit` (`NULL` = unlimited). Dad is the arbiter.
- **days** → the eight days, ordered.
- **activities** → `status` is the key field: `scheduled` (lives in a `day_id`), `maybe_later`, `idea`, or `dropped`. Carries `region`, `dwell_min`, `start_time`.
- **ratings** → the want slider, one row per member per activity.
- **must_dos** → the hard flag, capped per member by the `enforce_must_do_cap()` trigger.
- **events** → the VA / Google-Sheet events feed.
- **pins** + **pin_photos** → then & now (photos live in Supabase Storage).
- **pulses** → the anonymous energy check (no `member_id`).

`src/data/geo.js` already holds rough **drive times** between island areas and default **dwell times** — the inputs the day-planner and reshuffle need.

---

## Roadmap

**Phase 2 — the decision tools**
- ~~**Day-planner suggestions.**~~ ✅ Built — per-day ranked suggestions from `ratings` + `activities` using `geo.js` drive times and dwell, with a day-load meter and one-tap draft.
- **Reshuffle + private consent.** When the day runs behind, protect must-dos (Dad first), drop unflagged items, and ask the affected person privately to keep / move / let go — moving items to `maybe_later`. (Prototyped.)
- **Energy pulse + anonymous eject.** Write to `pulses`; show aggregate mood; suggest a chill swap when low.

**Phase 3 — content + memory**
- **Events feed.** Point a Google Sheet at the columns in the Fiverr brief; sync rows into `events` (a small scheduled function) or read the published CSV directly. Show a "What's on" feed by day/area with one-tap add.
- **Then & now.** Supabase Storage for Dad's photos, a map (MapLibre/Leaflet) for `pins`, a before/after slider, and a geofenced "THEN pictures available" alert off device GPS. (Alert + slider prototyped.)

**Phase 4 — hardening**
- Supabase **Auth** (magic links) and tighter RLS scoped by membership (replacing the open v0.1 policies).
- PNG/maskable icons for a crisper iOS install, and offline-cache tuning for out on the water.

---

## Note on v0.1 security
The current row-level-security policies let the anon key read/write the app tables — fine for a private family deployment whose URL you don't share publicly, **not** fine for anything wider. Phase 4 adds real auth before that matters.
