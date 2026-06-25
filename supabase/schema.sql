-- ============================================================
--  St. Croix Trip App — database schema
--  Run this once in your Supabase project: SQL Editor → paste → Run.
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- core ----------
create table if not exists trips (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  destination text,
  start_date date,
  end_date date,
  passphrase text,                         -- simple shared gate (v0.1)
  created_at timestamptz default now()
);

create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  name text not null,
  role text not null default 'member',     -- 'arbiter' (Dad) | 'member'
  color text default '#0E6E6E',
  must_do_limit int default 3,             -- NULL = unlimited (the arbiter)
  pin_hash text,
  claimed boolean not null default false,
  created_at timestamptz default now()
);

create table if not exists days (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  date date,
  label text,
  region text,
  sort int default 0
);

create table if not exists activities (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  day_id uuid references days(id) on delete set null,   -- NULL when unscheduled
  title text not null,
  region text,
  dwell_min int,
  start_time text,                          -- 'HH:MM'
  status text not null default 'scheduled', -- idea | proposed | scheduled | maybe_later | dropped
  done boolean default false,               -- checked off (separate from status)
  phase text,                               -- 'early' | 'mid' | 'late' | null
  locked boolean not null default false,    -- pinned to its day/slot by the builder UI
  notes text,
  sort int default 0,
  created_by uuid references members(id) on delete set null,
  created_at timestamptz default now()
);

-- ---------- the two signals ----------
-- soft preference slider (0..100), one row per member per activity
create table if not exists ratings (
  activity_id uuid not null references activities(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  want int not null default 3,             -- 1..5  (1 don't want → 5 really want)
  primary key (activity_id, member_id)
);

-- hard "must-do for me" flag. Capped per member (NULL limit = unlimited).
create table if not exists must_dos (
  activity_id uuid not null references activities(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (activity_id, member_id)
);

-- enforce the cap in the database too (belt and suspenders alongside the UI)
create or replace function enforce_must_do_cap() returns trigger as $$
declare lim int; cnt int;
begin
  select must_do_limit into lim from members where id = NEW.member_id;
  if lim is not null then
    select count(*) into cnt from must_dos where member_id = NEW.member_id;
    if cnt >= lim then
      raise exception 'must-do limit (%) reached', lim;
    end if;
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists trg_must_do_cap on must_dos;
create trigger trg_must_do_cap before insert on must_dos
  for each row execute function enforce_must_do_cap();

-- ---------- events feed (VA / Google-Sheet sourced) ----------
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  date date,
  start_time text,
  title text not null,
  category text,
  venue text,
  area text,
  cost text,
  link text,
  source text,
  checked_on date
);

-- ---------- then & now ----------
create table if not exists pins (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  name text not null,
  lat double precision,
  lng double precision,
  note text,
  created_by uuid references members(id) on delete set null
);
create table if not exists pin_photos (
  id uuid primary key default gen_random_uuid(),
  pin_id uuid not null references pins(id) on delete cascade,
  url text not null,            -- Supabase Storage public URL
  caption text,
  taken_year int
);

-- ---------- anonymous energy pulse ----------
create table if not exists pulses (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  day date default current_date,
  energy int,                   -- 0 rest .. 3 energized  (no member_id = anonymous)
  created_at timestamptz default now()
);

-- ---------- realtime (run once) ----------
alter publication supabase_realtime add table activities;
alter publication supabase_realtime add table members;
alter publication supabase_realtime add table ratings;
alter publication supabase_realtime add table must_dos;
alter publication supabase_realtime add table days;
alter publication supabase_realtime add table events;
alter publication supabase_realtime add table pulses;

-- ---------- row level security ----------
-- v0.1 is family-scale and gated by the app's trip passphrase, not per-user auth.
-- These policies give the anon key full CRUD on the app tables. Before any wider
-- use, add Supabase Auth (magic links) and scope these by membership — see README.
do $$
declare t text;
begin
  foreach t in array array['trips','members','days','activities','ratings','must_dos','events','pins','pin_photos','pulses']
  loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists "anon all" on %I;', t);
    execute format('create policy "anon all" on %I for all to anon using (true) with check (true);', t);
  end loop;
end $$;

-- ============================================================
--  SEED — the St. Croix trip (Aug 19–26, 2026)
-- ============================================================
do $$
declare
  v uuid; d0 uuid; d1 uuid; d2 uuid; d3 uuid; d4 uuid; d5 uuid; d6 uuid; d7 uuid;
begin
  insert into trips(name,destination,start_date,end_date,passphrase)
    values ('St. Croix','St. Croix, USVI','2026-08-19','2026-08-26','buckisland')
    returning id into v;

  insert into members(trip_id,name,role,color,must_do_limit) values
    (v,'Dad','arbiter','#C98A1E',null),
    (v,'You','member','#0E6E6E',3),
    (v,'Brother','member','#2E7C9E',3),
    (v,'Nina','member','#E2614A',3);

  insert into days(trip_id,date,label,region,sort) values (v,'2026-08-19','Touch down & settle in','Christiansted',0) returning id into d0;
  insert into days(trip_id,date,label,region,sort) values (v,'2026-08-20','Christiansted & Dad''s haunts','Christiansted',1) returning id into d1;
  insert into days(trip_id,date,label,region,sort) values (v,'2026-08-21','Rum, sugar & Frederiksted','West End',2) returning id into d2;
  insert into days(trip_id,date,label,region,sort) values (v,'2026-08-22','Rainforest, Salt River & the Wall','Rainforest & North Shore',3) returning id into d3;
  insert into days(trip_id,date,label,region,sort) values (v,'2026-08-23','Buck Island — birthday, all of us','East End',4) returning id into d4;
  insert into days(trip_id,date,label,region,sort) values (v,'2026-08-24','Split morning, East End together','East End',5) returning id into d5;
  insert into days(trip_id,date,label,region,sort) values (v,'2026-08-25','Tour with Frandelle','Island-wide',6) returning id into d6;
  insert into days(trip_id,date,label,region,sort) values (v,'2026-08-26','Last morning & fly out','Travel',7) returning id into d7;

  insert into activities(trip_id,day_id,title,region,dwell_min,start_time,status,notes,sort) values
    (v,d0,'Land at STX, pick up rental car','Christiansted',null,null,'scheduled','Drive on the LEFT.',0),
    (v,d0,'First dinner in Christiansted','Christiansted',90,'19:00','scheduled',null,1),
    (v,d0,'Sunset on the Boardwalk','Christiansted',45,null,'scheduled',null,2),

    (v,d1,'Historic Christiansted walk','Christiansted',120,'09:30','scheduled','Fort, wharf, Government House.',0),
    (v,d1,'Dad''s roots loop','Christiansted',90,null,'scheduled','Strand St, North St, St. John''s, St. Dunstan''s.',1),
    (v,d1,'Sonya''s for the hook bracelet','Christiansted',30,null,'scheduled',null,2),
    (v,d1,'Pueblo grocery run','Christiansted',45,null,'scheduled','Rice, beans, flour, condensed milk.',3),
    (v,d1,'Armstrong''s ice cream','Christiansted',20,null,'scheduled',null,4),

    (v,d2,'Cruzan Rum Distillery tour','West End',90,'10:30','scheduled',null,0),
    (v,d2,'Estate Whim Museum','West End',60,null,'scheduled',null,1),
    (v,d2,'St. George Village Botanical Garden','West End',75,null,'scheduled',null,2),
    (v,d2,'Frederiksted — fort, pier, lunch','West End',90,'13:00','scheduled',null,3),

    (v,d3,'Scenic & Mahogany Rd rainforest drive','Rainforest & North Shore',60,'09:30','scheduled',null,0),
    (v,d3,'The Domino Club (the pigs)','Rainforest & North Shore',30,null,'scheduled',null,1),
    (v,d3,'Salt River — kayak or SUP','Rainforest & North Shore',90,null,'scheduled',null,2),
    (v,d3,'Cane Bay — beach-bar lunch','Rainforest & North Shore',90,'12:30','scheduled',null,3),
    (v,d3,'Scuba the Cane Bay Wall','Rainforest & North Shore',120,null,'scheduled','Nina''s dive day.',4),

    (v,d4,'Buck Island — full day from Christiansted','East End',420,'08:30','scheduled','BOOK AHEAD. Sat is the weather backup.',0),
    (v,d4,'Birthday dinner','East End',90,'19:00','scheduled',null,1),
    (v,d4,'Cake + Armstrong''s','Christiansted',20,null,'scheduled',null,2),

    (v,d5,'Golf — Carambola or the Buccaneer','East End',270,'08:00','scheduled','You, Dad, Brother.',0),
    (v,d5,'Scuba or relaxed morning','Rainforest & North Shore',120,null,'scheduled','Nina.',1),
    (v,d5,'East End — Point Udall, Isaac''s Bay, Cramer Park','East End',150,'13:30','scheduled',null,2),
    (v,d5,'Carina Bay Casino (optional)','East End',120,'20:00','scheduled','21+',3),

    (v,d6,'Heritage tour with Frandelle','West End',120,'10:00','scheduled','Locked anchor — has a Plan B if it falls through.',0),
    (v,d6,'Final dinner; start packing','Christiansted',90,'19:00','scheduled',null,1),

    (v,d7,'Return rental, fly out of STX','Travel',null,null,'scheduled','Right-side window for Sandy Point.',0);

  -- maybe-later / ideas bucket (unscheduled)
  insert into activities(trip_id,day_id,title,region,dwell_min,status,sort) values
    (v,null,'Captain Morgan distillery','West End',60,'idea',0),
    (v,null,'CHANT heritage walk, Frederiksted','West End',90,'idea',1),
    (v,null,'Horseback — Paul & Jill''s Stables','West End',120,'idea',2),
    (v,null,'Carambola zipline','Rainforest & North Shore',90,'idea',3),
    (v,null,'Bioluminescent night kayak — Salt River','Rainforest & North Shore',120,'idea',4),
    (v,null,'Hotel on the Cay afternoon','Christiansted',150,'idea',5),
    (v,null,'Deep-sea fishing charter','Island-wide',300,'idea',6),
    (v,null,'Annaly Bay tide pools hike','Rainforest & North Shore',120,'idea',7),
    (v,null,'Seaplane day to St. Thomas','Island-wide',480,'idea',8);
end $$;
