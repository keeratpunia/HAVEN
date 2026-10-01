-- Storage buckets (SDD §9.10). Three private buckets, signed URLs only (120s TTL,
-- issued per API response — not configured here, that's application code). Supabase
-- provisions its own `storage` schema with a `storage.buckets` table; vanilla Postgres
-- (used in this environment to validate migrations when Docker/Supabase CLI was
-- unavailable — see docs/DECISIONS.md) does not have it, so this is guarded the same
-- way as the pg_cron extension in the init migration.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public)
    values
      ('visitor-photos', 'visitor-photos', false),
      ('gate-photos', 'gate-photos', false),
      ('resident-docs', 'resident-docs', false)
    on conflict (id) do nothing;
  else
    raise notice 'storage.buckets not present on this Postgres server — skipping bucket creation. Expected on Supabase.';
  end if;
end $$;
