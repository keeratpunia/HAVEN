-- SDD §16.5 "Audit log: kept 2 years". The table is append-only (§10.2), enforced by
-- haven.forbid_mutation(), which also blocked the retention purge. Deleting is now
-- allowed in exactly one case: the retention job sets `haven.retention_cutoff` for its
-- own transaction, and only audit rows at or before that cutoff (which the job computes
-- as two years before its clock) may go. Updates stay forbidden everywhere, and
-- `haven_api` still has no DELETE grant on audit_log, so the API can't use this.

create or replace function haven.forbid_mutation() returns trigger language plpgsql as $$
declare
  cutoff timestamptz := nullif(current_setting('haven.retention_cutoff', true), '')::timestamptz;
begin
  if tg_op = 'DELETE' and tg_table_name = 'audit_log' and cutoff is not null and old.at <= cutoff then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;
