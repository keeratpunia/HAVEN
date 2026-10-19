-- SDD §11.7: haven_api must be able to select/insert/update everything, delete only
-- the explicitly-ephemeral tables, and must NOT be able to update append-only tables
-- even directly (defence in depth alongside the triggers in 002). RLS must be enabled
-- on every table in the schema so Supabase's anon/authenticated roles get nothing.
begin;
select plan(7);

select ok(
  (select rolcanlogin from pg_roles where rolname = 'haven_api'),
  'haven_api can log in'
);
select ok(
  (select not rolinherit from pg_roles where rolname = 'haven_api'),
  'haven_api is NOINHERIT (does not implicitly gain other roles'' privileges)'
);

select ok(
  has_table_privilege('haven_api', 'haven.visits', 'SELECT'),
  'haven_api can SELECT on haven.visits'
);
select ok(
  has_table_privilege('haven_api', 'haven.visits', 'INSERT'),
  'haven_api can INSERT on haven.visits'
);
select ok(
  not has_table_privilege('haven_api', 'haven.gate_events', 'UPDATE'),
  'haven_api cannot UPDATE haven.gate_events even directly (not just via trigger)'
);
select ok(
  has_table_privilege('haven_api', 'haven.scan_sessions', 'DELETE'),
  'haven_api can DELETE on the explicitly-ephemeral haven.scan_sessions'
);

select is(
  (select count(*)::integer from pg_tables where schemaname = 'haven' and rowsecurity = false),
  0,
  'every table in schema haven has row-level security enabled'
);

select * from finish();
rollback;
