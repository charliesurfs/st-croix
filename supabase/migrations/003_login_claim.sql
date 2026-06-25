-- 003_login_claim.sql - lightweight member PIN claims.
-- Supabase: SQL Editor -> New query -> paste -> Run.

alter table members add column if not exists pin_hash text;
alter table members add column if not exists claimed boolean not null default false;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'members'
  ) then
    alter publication supabase_realtime add table members;
  end if;
end $$;
