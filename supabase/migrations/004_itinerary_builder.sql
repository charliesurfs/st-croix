-- Stage 2 (B4): manual placement / anchor lock.
-- A locked activity is pinned to its day+slot; "Build itinerary" never moves it.
alter table activities add column if not exists locked boolean not null default false;
