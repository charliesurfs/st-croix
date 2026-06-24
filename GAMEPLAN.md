# St. Croix Trip App — Gameplan & Handoff

*Drop this file (with the project) into Claude Cowork tomorrow — it's the context any agent needs.*

## The app, in a paragraph
A real-time shared trip planner for 4 people (St. Croix, Aug 19–26, 2026). **Stack:** React + Vite + PWA on **Supabase** (Postgres + realtime); weather via **Open-Meteo** (free, no key). Decisions already made: **Dad is final arbiter**; **1–5 "want" ratings** with Dad's number shown explicitly; **must-do flags capped at 3/person** (Dad unlimited, enforced by a DB trigger); a **maybe-later bucket**; **two add channels** (Wishlist pre-trip, Suggest-now during trip); a **Plan/Today split**; and a **per-day planner** that drafts days from the rated wishlist using region clustering + dwell + drive times. The core loop, Plan/Today, and the planner are **built**. See `README.md` for the full feature list + roadmap.

---

## Who does what

| Task | Owner |
|---|---|
| Make Supabase project, run the schema, copy keys | **You** (only you can — your account) |
| Install + run the app, fix build errors, test it | **Claude in Cowork** |
| Deploy to Vercel so the phones can use it | **You + Claude** (you connect accounts; Claude preps the repo/config) |
| Build: events feed, energy pulse, app icons | **Codex** (self-contained — saves your Claude credits) |
| Build: reshuffle + private consent, then & now, auth | **Claude in Cowork** (needs the design context) |
| Write the Codex task briefs | **Claude, here in chat** (cheapest place to do it) |

---

## Tomorrow — do these in order

### Step 1 — You: stand up the database (~15 min)
1. Go to **supabase.com** and sign in (free).
2. **New project** → name it `stx-trip`, set a database password (save it somewhere), pick the nearest region → **Create**. Wait ~2 min for it to spin up.
3. Left menu → **SQL Editor** → **New query**.
4. Open `supabase/schema.sql`, **copy all of it**, paste into the box, click **Run**. You should see "Success." (This builds every table *and* loads your St. Croix plan.)
5. Left menu → **Project Settings** (gear icon) → **API**. Copy two things: the **Project URL** and the **anon `public`** key.
   - ⚠️ Use the **anon public** key only. Never put the `service_role` secret key in the app — it has full access.

### Step 2 — Cowork: get it running
1. Download the whole project folder onto your laptop.
2. Open **Claude Cowork**, point it at the folder, and paste this:
   > *"This is a React + Vite + Supabase app — read GAMEPLAN.md and README.md for context. Create a `.env` from `.env.example` with these values: `VITE_SUPABASE_URL=<your url>` and `VITE_SUPABASE_ANON_KEY=<your anon key>`. Then run `npm install`, start the dev server, and fix anything that breaks until it loads. Then tell me how to test it."*
3. Open the local URL it gives you, pick your name — you should see the seeded plan. Quick test: rate something, flag a must-do, check one off, and hit ✨ Draft this day on a day.

### Step 3 — (Once it works) Deploy for the family
1. Have Cowork init a git repo and push to a new GitHub repo (or do it yourself).
2. **vercel.com** → sign in with GitHub → **Add New Project** → import the repo.
3. In Vercel → Settings → **Environment Variables**, add the same two (URL + anon key).
4. **Deploy** → open the URL on each phone → **Share → Add to Home Screen**. It installs like an app.

---

## After it's live — build backlog
**Rule: one feature per git branch, merge before starting the next** — so Cowork and Codex never step on each other.

- **Codex (isolated, saves credits):**
  - **Events feed** — reads a Google Sheet (the Fiverr columns) into the `events` table; shows a "What's on" list by day/area with one-tap add.
  - **Energy pulse + anonymous eject** — writes to `pulses`; shows aggregate mood; suggests a chill swap when low.
  - **PWA icons** — proper PNG/maskable icons for a crisp home-screen install.
- **Claude / Cowork (context-heavy):**
  - **Reshuffle + private consent** — the "running behind → protect must-dos → ask the owner privately to keep/move/let-go" flow (moves items to `maybe_later`).
  - **Then & now** — Supabase Storage for Dad's photos, a map for pins, a before/after slider, geofenced "THEN pictures available" alert.
  - **Auth hardening** — Supabase magic links + tighter row-level security (replacing the open v0.1 policies).

---

## Credit notes
- **Codex is a different provider**, so moving the isolated features there spares your Claude usage for work.
- Have Claude write the **Codex briefs in this chat** (cheap text) — not inside Cowork.
- **Cowork still uses your Claude usage**, but it executes directly (no copy-paste round-trips), so it's the efficient place for the hands-on building and debugging.
