# St. Croix Trip App — Project Status & Handoff

_Last updated: 2026-06-24. Shared context for all team members (Dad/Dude, Claude in Cowork, Codex)._

## What this is
A shared, real-time trip planner for 4 people for **St. Croix, Aug 19–26 2026**.
**Stack:** React + Vite + installable PWA, **Supabase** (Postgres + realtime), weather via Open-Meteo (free, no key).
**Repo:** https://github.com/charliesurfs/st-croix  ·  branch `main`.

## The pivot we just made
The app used to open on a **pre-filled day-by-day itinerary**, which assumed the schedule was already decided. It isn't — the family uses the app to *do* the planning. We split it into two stages:

- **Stage 1 — Activities tab (default):** add everything, rate it, tag roughly when it fits. One flat list, no days yet.
- **Stage 2 — Itinerary tab:** turn the rated list into actual days. Also the live during-trip view.

## Decisions locked (don't relitigate without the group)
- **Dad is the final arbiter.**
- **Ratings are anonymous** — each card shows only *your* 1–5 and the *group average*. No per-person numbers, no separate "Dad's number."
- **Must-dos are anonymous** — shown as a count badge (★ N), never who flagged. Cap **3 per person, Dad unlimited** (enforced in UI + a DB trigger).
- **One scoring formula** for the "Most wanted" sort and the planner: `rank = group-avg rating + must-do weight`, where a regular must-do = ×1 and **Dad's must-do = ×2**.
- **Phase tags:** activities can be tagged early / mid / late. Days derive their phase by order (days 1–3 = early, 4–5 = mid, 6–8 = late).
- **Two add channels:** Wishlist (pre-trip ideas) and Suggest-now (in-the-moment, during the trip).

## Status

### Done & verified
- App installed and running locally (`npm install`, dev server at `http://localhost:5173`).
- `.env` wired to the Supabase project (publishable key; safe in the browser, RLS on).
- **Restructure sections 1–3 built** (per `COWORK_RESTRUCTURE.md`):
  1. Tabs renamed to **Activities** (Stage 1, default) and **Itinerary** (Stage 2 + live).
  2. **Activities** = flat candidate list with anonymous ratings + ★N must-do badge, inline early/mid/late chips, and **Most wanted / By when** sorts; Maybe-later at the bottom.
  3. **Itinerary** = day containers with a derived phase tag, null-safe labels, and the ✨ planner **reranked by rating + must-do (Dad ×2) + phase match** (no longer depends on region), with the day-load meter and one-tap draft.
- `npm run build` passes.
- Git repo committed on `main` and pushing to the GitHub repo (`.env` and `node_modules` excluded).

### Pending — by owner

**Dad / Dude (you):**
- **Run Part 1 in Supabase** (the reset SQL). It renames members to **Dad / Brandon / Andrew / Nina**, sets every activity back to an unscheduled candidate (`day_id=null, status='idea'`), and blanks the speculative day themes while keeping the real anchors (arrival, birthday 8/23, Frandelle 8/25, fly-out). **Until this runs, the Activities tab only shows a few unscheduled ideas** — everything else still sits on days.
- Finish the **git push** (auth from your machine), then **deploy to Vercel** (import the repo, set `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`).

**Codex (isolated, saves Claude credits):**
- **Section 4 — login/identity:** the 2×2 name grid + one-time PIN claim (`CODEX_login.md`). The login gate was intentionally **left untouched** in this restructure to avoid collisions.
- Events feed, energy pulse + anonymous eject, PWA icons.

**Claude / Cowork (context-heavy, later):**
- Anonymity/login wiring if not covered by Codex.
- **Stage 2 engine** (`STAGE2_AND_AUTH.md`): itinerary auto-build (B1) + manual move/lock (B4), then placement voting + reactive movement (B2/B3).
- Then & now (photos + map), auth hardening / tighter RLS.

## Build order (from STAGE2_AND_AUTH.md)
1. ✅ Stage-1 restructure (flat rated list, inline phase) — **done** (login still Codex's).
2. Light login + anonymity (one-time PIN claim, aggregate-only display).
3. Itinerary auto-build + manual move.
4. Placement voting + reactive movement.

## Heads-up for anyone working in Cowork
- The Cowork sandbox **truncated large file-tool writes** on this folder — large source files had to be written via the shell. If a file looks cut off, that's why; re-write via shell.
- **Git can't run inside the mounted folder** from the sandbox (filesystem permission limits) — the repo was initialized and pushed **from the local machine**.
- One feature per branch, merge before the next, so Cowork and Codex don't collide.
