-- Found by running supabase/tests (pgTAP) for the first time (FINAL-QA-REPORT item 10):
-- haven.forbid_mutation() read `old.at` in the same IF as the table-name check, and
-- PL/pgSQL resolves the record field for every table the trigger is on. approvals and
-- hostel_rules have no `at` column, so an UPDATE/DELETE there failed with 42703
-- ("record old has no field at") instead of the append-only 42501. Still blocked, but
-- with the wrong error. Only audit_log's row is read now.
create or replace function haven.forbid_mutation() returns trigger language plpgsql as $$
declare
  cutoff timestamptz := nullif(current_setting('haven.retention_cutoff', true), '')::timestamptz;
begin
  if tg_op = 'DELETE' and tg_table_name = 'audit_log' and cutoff is not null then
    if old.at <= cutoff then
      return old;
    end if;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;
