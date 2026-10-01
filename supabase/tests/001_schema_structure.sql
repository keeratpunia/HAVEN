-- Structural tests for the HAVEN schema foundation (SDD §11).
-- Run via `supabase test db` (pgTAP). See docs/DEVELOPMENT.md §5.1.
begin;
select plan(14);

select has_schema('haven', 'haven schema exists');

-- Core tables exist (SDD §10.1 / §11.2-11.5)
select has_table('haven', 'hostels', 'hostels table exists');
select has_table('haven', 'users', 'users table exists');
select has_table('haven', 'residents', 'residents table exists');
select has_table('haven', 'visitors', 'visitors table exists');
select has_table('haven', 'visits', 'visits table exists');
select has_table('haven', 'gate_events', 'gate_events table exists');
select has_table('haven', 'gates', 'gates table exists');
select has_table('haven', 'audit_log', 'audit_log table exists');
select has_table('haven', 'notifications', 'notifications table exists');
select has_table('haven', 'charges', 'charges table exists');

-- visit_status enum has exactly the 8 values from SDD §7
select is(
  (select array_agg(e.enumlabel order by e.enumsortorder)
     from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'visit_status' and t.typnamespace = 'haven'::regnamespace),
  array['pending_host','pending_warden','approved','inside','completed','rejected','expired','cancelled'],
  'visit_status has exactly the 8 SDD §7 states, in order'
);

-- Money is integer rupees, never numeric/float (CLAUDE.md §2)
select col_type_is('haven', 'charges', 'amount_inr', 'integer', 'charges.amount_inr is integer (no paise, no floats)');

-- Timestamps are timestamptz (UTC storage), never naive timestamp (SDD §0 conventions)
select col_type_is('haven', 'visits', 'window_start', 'timestamp with time zone', 'visits.window_start is timestamptz (UTC storage)');
select col_type_is('haven', 'visits', 'window_end', 'timestamp with time zone', 'visits.window_end is timestamptz (UTC storage)');

select * from finish();
rollback;
