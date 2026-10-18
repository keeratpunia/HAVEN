-- docs/DECISIONS.md DEC-016 item 4: job_retention also nulls the recipient phone of SMS
-- rows past the §16.5 notifications period (90 days), once they can no longer be sent
-- (constraint relaxed in 20261020000001). Otherwise identical to 20261019000007.

-- §16.5 rows owned by the database. The API worker deletes the photo files whose
-- delete_after has passed and sets deleted_at (§11.8). Security definer: the audit-log
-- purge needs DELETE on audit_log, which haven_api never has.
create or replace function haven.job_retention(p_now timestamptz default now()) returns void
language plpgsql security definer set search_path = haven, pg_temp as $$
declare
  n_gate int; n_profile int; n_guests int; n_visits int; n_audit int; n_notifs int;
begin
  perform set_config('haven.actor_type', 'system', true);

  -- Gate photos: delete_after = created_at + 180 days.
  update haven.media
     set delete_after = created_at + interval '180 days'
   where kind = 'gate_photo' and delete_after is null and deleted_at is null;
  get diagnostics n_gate = row_count;

  -- Guest profile photo: 365 days after last_visit_at — moved forward whenever the guest
  -- visits again. A guest who never visited counts from when the row was created.
  update haven.media m
     set delete_after = coalesce(v.last_visit_at, v.created_at) + interval '365 days'
    from haven.visitors v
   where m.owner_visitor_id = v.id and m.kind = 'visitor_profile' and m.deleted_at is null
     and m.delete_after is distinct from coalesce(v.last_visit_at, v.created_at) + interval '365 days';
  get diagnostics n_profile = row_count;

  -- Guest identity: 365 days after last visit with no future visits.
  update haven.visitors v
     set full_name = 'Former guest', phone = null, anonymised_at = p_now
   where v.anonymised_at is null
     and coalesce(v.last_visit_at, v.created_at) <= p_now - interval '365 days'
     and not exists (
       select 1 from haven.visits x
        where x.visitor_id = v.id
          and (x.window_end > p_now or x.status in ('inside','pending_host','pending_warden','approved')));
  get diagnostics n_guests = row_count;

  -- Visit rows: kept 2 years, then invited_name and invited_phone nulled.
  update haven.visits
     set invited_name = null, invited_phone = null
   where created_at <= p_now - interval '2 years'
     and (invited_name is not null or invited_phone is not null);
  get diagnostics n_visits = row_count;

  -- Audit log: kept 2 years (see 20261019000003).
  perform set_config('haven.retention_cutoff', (p_now - interval '2 years')::text, true);
  delete from haven.audit_log where at <= p_now - interval '2 years';
  get diagnostics n_audit = row_count;
  perform set_config('haven.retention_cutoff', '', true);

  -- Notifications: bodies nulled after 90 days (title and data too: data can hold SMS
  -- variables such as a guest's name), and a finished SMS row's recipient phone too
  -- (docs/DECISIONS.md DEC-016).
  update haven.notifications
     set body = '', title = null, data = '{}'::jsonb,
         recipient_phone = case when status in ('sent', 'failed', 'cancelled') then null else recipient_phone end
   where created_at <= p_now - interval '90 days'
     and (body <> '' or title is not null or data <> '{}'::jsonb
          or (recipient_phone is not null and status in ('sent', 'failed', 'cancelled')));
  get diagnostics n_notifs = row_count;

  -- FR-74: the job's own action, as counts only (no PII).
  insert into haven.audit_log (actor_type, action, entity, after)
  values ('system', 'job.retention', 'retention', jsonb_build_object(
    'at', p_now, 'gatePhotosScheduled', n_gate, 'profilePhotosScheduled', n_profile,
    'guestsAnonymised', n_guests, 'visitsCleared', n_visits, 'auditRowsPurged', n_audit,
    'notificationsCleared', n_notifs));
end $$;
