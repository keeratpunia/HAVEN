-- Database-level guarantees the SDD requires explicitly (not application checks):
--   - append-only tables (gate_events, audit_log, approvals, hostel_rules)
--   - BR-15: one `inside` visit per visitor, anywhere, enforced by a partial unique index
--   - charges status/receipt/waive-reason consistency
-- See docs/DEVELOPMENT.md §5.1, CLAUDE.md §3.11.
begin;
select plan(9);

-- Fixtures: one hostel, one gate, one rules version, one host, one visitor.
insert into haven.hostels (id, code, name, gender_served) values
  ('00000000-0000-0000-0000-000000000001', 'TST', 'Test Hostel', 'female');

insert into haven.hostel_rules (id, hostel_id, version, config) values
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 1, '{}'::jsonb);

insert into haven.gates (id, hostel_id, code, secret_enc) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'TST001', '\x00');

insert into haven.users (id, google_sub, email, full_name) values
  ('00000000-0000-0000-0000-000000000004', 'sub-1', 'host1@test.local', 'Test Host');
insert into haven.rooms (id, hostel_id, number) values
  ('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000001', '101');
insert into haven.residents (user_id, hostel_id, claimed_room, room_id, status) values
  ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', '101',
   '00000000-0000-0000-0000-00000000000d', 'verified');

insert into haven.visitors (id, phone, full_name, gender) values
  ('00000000-0000-0000-0000-000000000005', '+919999900001', 'Test Guest', 'female');

-- ---- Append-only enforcement ----
insert into haven.visits (id, code, hostel_id, host_id, visitor_id, type, status, origin, zone,
                          window_start, window_end, rules_version, created_by_type)
values ('00000000-0000-0000-0000-000000000006', 'V000001', '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000005',
        'day', 'approved', 'invite', 'room', now(), now() + interval '1 hour', 1, 'user');

insert into haven.gate_events (id, visit_id, hostel_id, gate_id, kind, actor_type, location_verified)
values ('00000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000006',
        '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003',
        'entry', 'visitor', true);

select throws_ok(
  $$ update haven.gate_events set kind = 'exit' where id = '00000000-0000-0000-0000-000000000008' $$,
  '42501',
  'gate_events is append-only',
  'UPDATE on gate_events is rejected (append-only guarantee)'
);
select throws_ok(
  $$ delete from haven.gate_events where id = '00000000-0000-0000-0000-000000000008' $$,
  '42501',
  'gate_events is append-only',
  'DELETE on gate_events is rejected (append-only guarantee)'
);

insert into haven.approvals (id, visit_id, approver_id, approver_role, decision)
values ('00000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000006',
        '00000000-0000-0000-0000-000000000004', 'host', 'approved');
select throws_ok(
  $$ update haven.approvals set decision = 'rejected' where id = '00000000-0000-0000-0000-000000000009' $$,
  '42501',
  'approvals is append-only',
  'UPDATE on approvals is rejected (append-only guarantee)'
);

select throws_ok(
  $$ update haven.hostel_rules set version = 2 where id = '00000000-0000-0000-0000-000000000002' $$,
  '42501',
  'hostel_rules is append-only',
  'UPDATE on hostel_rules is rejected (append-only guarantee)'
);

-- audit_log is append-only too; at least one row should already exist from the inserts above
select throws_ok(
  $$ delete from haven.audit_log $$,
  '42501',
  'audit_log is append-only',
  'DELETE on audit_log is rejected (append-only guarantee)'
);

-- ---- BR-15: one `inside` visit per visitor, anywhere ----
update haven.visits set status = 'inside' where id = '00000000-0000-0000-0000-000000000006';

insert into haven.visits (id, code, hostel_id, host_id, visitor_id, type, status, origin, zone,
                          window_start, window_end, rules_version, created_by_type)
values ('00000000-0000-0000-0000-000000000007', 'V000002', '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000005',
        'day', 'approved', 'invite', 'room', now(), now() + interval '2 hour', 1, 'user');

select throws_ok(
  $$ update haven.visits set status = 'inside' where id = '00000000-0000-0000-0000-000000000007' $$,
  '23505',
  null,
  'BR-15: a second `inside` visit for the same visitor violates the partial unique index'
);

-- ---- Charges: paid requires receipt_no; waived requires waive_reason ----
insert into haven.charges (id, hostel_id, resident_id, kind, amount_inr, description, status)
values ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000004', 'fine', 400, 'test fine', 'pending');

select throws_ok(
  $$ update haven.charges set status = 'paid' where id = '00000000-0000-0000-0000-00000000000a' $$,
  '23514',
  null,
  'charges: cannot mark paid without a receipt_no (check constraint)'
);
select lives_ok(
  $$ update haven.charges set status = 'paid', receipt_no = 'RCPT-1' where id = '00000000-0000-0000-0000-00000000000a' $$,
  'charges: marking paid with a receipt_no succeeds'
);

select * from finish();
rollback;
