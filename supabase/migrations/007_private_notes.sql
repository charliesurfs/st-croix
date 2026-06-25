create table if not exists member_notes (
  member_id uuid primary key references members(id) on delete cascade,
  trip_id uuid references trips(id),
  note text not null default '',
  updated_at timestamptz not null default now()
);

alter table member_notes enable row level security;

drop policy if exists "anon all" on member_notes;
create policy "anon all" on member_notes
  for all
  to anon
  using (true)
  with check (true);
