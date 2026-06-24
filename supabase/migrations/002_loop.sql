-- 002_loop.sql — core-loop additions. Safe to run on your existing database.
-- Supabase: SQL Editor → New query → paste → Run.

alter table activities add column if not exists done  boolean default false;
alter table activities add column if not exists phase text;   -- 'early' | 'mid' | 'late' | null

-- Notes:
--  • status now also uses 'proposed' for during-trip suggestions
--    (lifecycle: idea | proposed | scheduled | maybe_later | dropped).
--  • 'done' above is a boolean, separate from status, so a scheduled activity
--    can be checked off without leaving its day.
--  • ratings are now a 1–5 scale. Any existing rating rows are untouched; the app
--    writes 1..5 from here on.
