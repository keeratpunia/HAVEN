-- SDD §11.6: the audit_row() trigger must strip PII/secret columns before writing to
-- audit_log, so the audit log never contains raw PII by construction (SDD §16.4 —
-- distinct from, and in addition to, the API-level "audit of reads" control in
-- CLAUDE.md §4, which this migration cannot enforce since reads don't hit a trigger).
--
-- Exercised against haven.gates, not haven.users: SDD §11.6 does not attach an audit
-- trigger to haven.users (only to visits, residents, role_assignments, bans, charges,
-- gates, gate_devices, hostel_rules, staff_invites) — gates has both an audit trigger
-- and a strip-listed PII column (lat/lng), so it proves the stripping behaviour on a
-- table the SDD actually audits.
begin;
select plan(5);

insert into haven.hostels (id, code, name, gender_served) values
  ('00000000-0000-0000-0000-00000000000c', 'TS2', 'Test Hostel 2', 'female');

insert into haven.gates (id, hostel_id, code, secret_enc) values
  ('00000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-00000000000c', 'TS2001', '\x00');

update haven.gates set lat = 12.9716, lng = 77.5946
 where id = '00000000-0000-0000-0000-00000000000e';

select ok(
  (select count(*) = 1 from haven.audit_log
    where entity = 'gates' and entity_id = '00000000-0000-0000-0000-00000000000e' and action = 'gates.update'),
  'updating a gate''s location writes exactly one audit_log row'
);
select ok(
  (select (after ->> 'lat') is null from haven.audit_log
    where entity = 'gates' and entity_id = '00000000-0000-0000-0000-00000000000e' and action = 'gates.update'),
  'audit_log.after does not contain the raw lat'
);
select ok(
  (select (after ->> 'lng') is null from haven.audit_log
    where entity = 'gates' and entity_id = '00000000-0000-0000-0000-00000000000e' and action = 'gates.update'),
  'audit_log.after does not contain the raw lng'
);
select ok(
  (select (after ->> 'id') = '00000000-0000-0000-0000-00000000000e' from haven.audit_log
    where entity = 'gates' and entity_id = '00000000-0000-0000-0000-00000000000e' and action = 'gates.update'),
  'audit_log.after keeps non-PII fields (id) so the row is still traceable'
);
select ok(
  (select (after ->> 'radius_m')::int = 50 from haven.audit_log
    where entity = 'gates' and entity_id = '00000000-0000-0000-0000-00000000000e' and action = 'gates.update'),
  'audit_log.after keeps non-PII fields (radius_m) — stripping is column-specific, not whole-row'
);

select * from finish();
rollback;
