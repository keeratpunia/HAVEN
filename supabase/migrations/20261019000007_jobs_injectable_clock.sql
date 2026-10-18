-- SDD §9.8 / §11.8 jobs, revised in one place (docs/DECISIONS.md DEC-015):
--
-- * Every job takes `p_now timestamptz default now()`. pg_cron still calls them with no
--   argument (the database clock), and the in-process JobRunner passes its injected
--   Clock, so time boundaries can be tested exactly (§9.13: the server clock decides).
--   The old zero-argument versions are dropped first so the call stays unambiguous.
-- * Boundaries are inclusive where the SDD names the moment: a walk-in expires at
--   exactly walk_in_timeout_minutes (BR-12), an approved visit at window_end (FR-71),
--   an overstay starts at window_end + overstay_grace_minutes (BR-13) and escalates to
--   wardens at exactly 30 minutes (FR-72).
-- * N-OVERSTAY-GUEST sends the registered DLT text (§15.3 HAVEN_OVERSTAY): an SMS that
--   doesn't match its template is rejected by the operator.
-- * SMS rows carry their DLT variables in data.smsVars, for SmsProvider.send(to,
--   templateId, vars) (§9.7).
-- * N-NIGHT-SWEEP opens W-02 filtered to the guests (§11.8 "the app opens W-02 filtered
--   to them"), N-GATE-OFFLINE opens W-09, and times read "4:42 pm" (§13.1).
-- * job_expire_approved waives exactly the charges of the visits it expired.
-- * job_retention implements every §16.5 row it owns, refreshes a guest's profile-photo
--   date when they visit again, purges audit rows older than 2 years, clears
--   notification data with the body, and records what it did in audit_log.

drop function haven.job_expire_walkins();
drop function haven.job_expire_approved();
drop function haven.job_flag_overstays();
drop function haven.job_night_sweep();
drop function haven.job_gate_offline();
drop function haven.job_retention();
drop function haven.job_expire_sessions();

create function haven.job_expire_walkins(p_now timestamptz default now()) returns void
language plpgsql as $$
begin
  perform set_config('haven.actor_type', 'system', true);
  with expired as (
    update haven.visits v
       set status = 'expired', closed_at = p_now, cancel_reason = 'host_no_response'
     where v.status = 'pending_host'
       and v.created_at <= p_now - make_interval(mins => (haven.rules_for(v.hostel_id) ->> 'walk_in_timeout_minutes')::int)
    returning v.id, v.hostel_id, v.host_id, v.visitor_id, v.invited_name)
  -- N-WALKIN-EXPIRED: "Guest request expired / {guestName}'s request at the gate wasn't answered."
  insert into haven.notifications (hostel_id, recipient_type, recipient_id, kind, channel,
                                   visit_id, title, body, data, dedupe_key, next_attempt_at)
  select e.hostel_id, 'user', e.host_id, 'N-WALKIN-EXPIRED', 'push', e.id,
         'Guest request expired',
         coalesce(vi.full_name, e.invited_name, 'Your guest') || '''s request at the gate wasn''t answered.',
         jsonb_build_object('screen', '/visit/' || e.id),
         'walkin-expired:' || e.id, p_now
    from expired e
    left join haven.visitors vi on vi.id = e.visitor_id
  on conflict (dedupe_key) do nothing;
end $$;

create function haven.job_expire_approved(p_now timestamptz default now()) returns void
language plpgsql as $$
begin
  perform set_config('haven.actor_type', 'system', true);
  with expired as (
    update haven.visits v
       set status = 'expired', closed_at = p_now, cancel_reason = 'window_ended'
     where v.status = 'approved' and v.window_end <= p_now and v.first_entry_at is null
    returning v.id)
  -- "waive any pending charge" (§11.8) — only for the visits this run expired.
  update haven.charges c
     set status = 'waived', waived_at = p_now, waive_reason = 'visit expired unentered'
    from expired e
   where c.visit_id = e.id and c.status = 'pending';

  update haven.visits v
     set status = 'completed', closed_at = p_now, close_reason = 'window_ended'
   where v.status = 'approved' and v.window_end <= p_now and v.first_entry_at is not null;
end $$;

create function haven.job_flag_overstays(p_now timestamptz default now()) returns void
language plpgsql as $$
begin
  perform set_config('haven.actor_type', 'system', true);
  with flagged as (
    update haven.visits v set overstay_since = p_now
     where v.status = 'inside' and v.overstay_since is null
       and p_now >= v.window_end + make_interval(mins => (haven.rules_for(v.hostel_id) ->> 'overstay_grace_minutes')::int)
    returning v.*),
  ended as (
    select f.*, lower(to_char(f.window_end at time zone coalesce(haven.rules_for(f.hostel_id) ->> 'timezone', 'Asia/Kolkata'),
                               'FMHH12:MI am')) as end_time
      from flagged f)
  -- N-OVERSTAY-HOST: "Your guest is still inside / Their visit ended at {endTime}. Ask them to check out at the gate."
  insert into haven.notifications (hostel_id, recipient_type, recipient_id, recipient_phone, kind,
                                   channel, visit_id, title, body, sms_template_id, data, dedupe_key,
                                   next_attempt_at)
  select e.hostel_id, 'user', e.host_id, null, 'N-OVERSTAY-HOST', 'push'::haven.notif_channel, e.id,
         'Your guest is still inside',
         'Their visit ended at ' || e.end_time || '. Ask them to check out at the gate.',
         null, jsonb_build_object('screen', '/visit/' || e.id), 'overstay-host:' || e.id, p_now
    from ended e
  union all
  -- N-OVERSTAY-GUEST, SMS HAVEN_OVERSTAY (§15.3): "Your HAVEN visit ended at {#var#}. Please check out at the gate now."
  select e.hostel_id, 'phone', null, vi.phone, 'N-OVERSTAY-GUEST', 'sms'::haven.notif_channel, e.id,
         null,
         'Your HAVEN visit ended at ' || e.end_time || '. Please check out at the gate now.',
         'HAVEN_OVERSTAY', jsonb_build_object('smsVars', jsonb_build_array(e.end_time)),
         'overstay-guest:' || e.id, p_now
    from ended e
    join haven.visitors vi on vi.id = e.visitor_id
   where vi.phone is not null
  on conflict (dedupe_key) do nothing;

  with esc as (
    update haven.visits v set overstay_escalated_at = p_now
     where v.status = 'inside' and v.overstay_since <= p_now - interval '30 minutes'
       and v.overstay_escalated_at is null
    returning v.*)
  -- N-OVERSTAY-WARDEN: "Guest overstaying / {guestName} (host {hostName}, room {room}) is 30+ min past their end time."
  insert into haven.notifications (hostel_id, recipient_type, recipient_id, kind, channel,
                                   visit_id, title, body, data, dedupe_key, next_attempt_at)
  select e.hostel_id, 'user', ra.user_id, 'N-OVERSTAY-WARDEN', 'push', e.id,
         'Guest overstaying',
         coalesce(vi.full_name, e.invited_name, 'A guest') || ' (host ' || u.full_name || ', room '
           || coalesce(r.number, res.claimed_room) || ') is 30+ min past their end time.',
         jsonb_build_object('screen', '/warden/visits/' || e.id),
         'overstay-warden:' || e.id || ':' || ra.user_id, p_now
    from esc e
    join haven.role_assignments ra
      on ra.hostel_id = e.hostel_id and ra.role = 'warden' and ra.revoked_at is null
    join haven.users u on u.id = e.host_id
    join haven.residents res on res.user_id = e.host_id
    left join haven.rooms r on r.id = res.room_id
    left join haven.visitors vi on vi.id = e.visitor_id
  on conflict (dedupe_key) do nothing;
end $$;

-- §11.8: per hostel, one notification to each warden (push listing the day/quick
-- guests still inside, or in-app "No day guests inside at 10 pm") and one push to each
-- affected host. Dedupe per hostel, recipient and the hostel's local date.
create function haven.job_night_sweep(p_now timestamptz default now()) returns void
language plpgsql as $$
declare
  h record;
  local_date date;
  ids uuid[];
begin
  perform set_config('haven.actor_type', 'system', true);
  for h in select id from haven.hostels loop
    local_date := (p_now at time zone coalesce(haven.rules_for(h.id) ->> 'timezone', 'Asia/Kolkata'))::date;
    select coalesce(array_agg(v.id order by v.id), '{}') into ids
      from haven.visits v
     where v.hostel_id = h.id and v.status = 'inside' and v.type in ('day','quick_drop');

    if cardinality(ids) = 0 then
      insert into haven.notifications (hostel_id, recipient_type, recipient_id, kind, channel,
                                       title, body, data, dedupe_key, next_attempt_at)
      select h.id, 'user', ra.user_id, 'N-NIGHT-SWEEP', 'in_app',
             'No day guests inside at 10 pm', 'No day guests inside at 10 pm',
             jsonb_build_object('screen', '/warden/inside'),
             'night-sweep:' || h.id || ':' || local_date || ':' || ra.user_id, p_now
        from haven.role_assignments ra
       where ra.hostel_id = h.id and ra.role = 'warden' and ra.revoked_at is null
      on conflict (dedupe_key) do nothing;
    else
      -- N-NIGHT-SWEEP: "{n} day guests still inside / Tap to see who and whose guests they are."
      insert into haven.notifications (hostel_id, recipient_type, recipient_id, kind, channel,
                                       title, body, data, dedupe_key, next_attempt_at)
      select h.id, 'user', ra.user_id, 'N-NIGHT-SWEEP', 'push',
             cardinality(ids) || ' day guests still inside',
             'Tap to see who and whose guests they are.',
             jsonb_build_object('visitIds', to_jsonb(ids),
                                'screen', '/warden/inside?ids=' || array_to_string(ids, ',')),
             'night-sweep:' || h.id || ':' || local_date || ':' || ra.user_id, p_now
        from haven.role_assignments ra
       where ra.hostel_id = h.id and ra.role = 'warden' and ra.revoked_at is null
      on conflict (dedupe_key) do nothing;

      -- N-NIGHT-SWEEP-HOST: "Your guest is still inside after 10 pm / Day guests must leave. The warden has been informed."
      insert into haven.notifications (hostel_id, recipient_type, recipient_id, kind, channel,
                                       visit_id, title, body, data, dedupe_key, next_attempt_at)
      select h.id, 'user', v.host_id, 'N-NIGHT-SWEEP-HOST', 'push', v.id,
             'Your guest is still inside after 10 pm',
             'Day guests must leave. The warden has been informed.',
             jsonb_build_object('screen', '/visit/' || v.id),
             'night-sweep-host:' || v.id || ':' || local_date, p_now
        from haven.visits v
       where v.id = any(ids)
      on conflict (dedupe_key) do nothing;
    end if;
  end loop;
end $$;

-- §11.8: "active, unrevoked devices with last_seen_at < now() - 5 min and
-- offline_alerted_at is null or offline_alerted_at < last_seen_at → notify wardens, set
-- offline_alerted_at" — once per outage (§15.5).
create function haven.job_gate_offline(p_now timestamptz default now()) returns void
language plpgsql as $$
begin
  perform set_config('haven.actor_type', 'system', true);
  with offline as (
    update haven.gate_devices d
       set offline_alerted_at = p_now
     where d.revoked_at is null
       and d.last_seen_at < p_now - interval '5 minutes'
       and (d.offline_alerted_at is null or d.offline_alerted_at < d.last_seen_at)
    returning d.id, d.gate_id, d.last_seen_at)
  -- N-GATE-OFFLINE: "Gate screen offline / {gateName} hasn't checked in since {time}. Guests can't scan in."
  insert into haven.notifications (hostel_id, recipient_type, recipient_id, kind, channel,
                                   title, body, data, dedupe_key, next_attempt_at)
  select g.hostel_id, 'user', ra.user_id, 'N-GATE-OFFLINE', 'push',
         'Gate screen offline',
         g.name || ' hasn''t checked in since '
           || lower(to_char(o.last_seen_at at time zone coalesce(haven.rules_for(g.hostel_id) ->> 'timezone', 'Asia/Kolkata'),
                            'FMHH12:MI am'))
           || '. Guests can''t scan in.',
         jsonb_build_object('screen', '/warden/gates'),
         'gate-offline:' || o.id || ':' || o.last_seen_at || ':' || ra.user_id, p_now
    from offline o
    join haven.gates g on g.id = o.gate_id
    join haven.role_assignments ra on ra.hostel_id = g.hostel_id and ra.role = 'warden' and ra.revoked_at is null
  on conflict (dedupe_key) do nothing;
end $$;

-- §16.5 rows owned by the database. The API worker deletes the photo files whose
-- delete_after has passed and sets deleted_at (§11.8). Security definer: the audit-log
-- purge needs DELETE on audit_log, which haven_api never has.
create function haven.job_retention(p_now timestamptz default now()) returns void
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
  -- variables such as a guest's name).
  update haven.notifications
     set body = '', title = null, data = '{}'::jsonb
   where created_at <= p_now - interval '90 days'
     and (body <> '' or title is not null or data <> '{}'::jsonb);
  get diagnostics n_notifs = row_count;

  -- FR-74: the job's own action, as counts only (no PII).
  insert into haven.audit_log (actor_type, action, entity, after)
  values ('system', 'job.retention', 'retention', jsonb_build_object(
    'at', p_now, 'gatePhotosScheduled', n_gate, 'profilePhotosScheduled', n_profile,
    'guestsAnonymised', n_guests, 'visitsCleared', n_visits, 'auditRowsPurged', n_audit,
    'notificationsCleared', n_notifs));
end $$;

-- §11.8: "deletes scan_sessions past expires_at + 1 day, otp_challenges older than 1
-- day, idempotency_keys older than 24 h, used or expired gate_pairing_codes".
create function haven.job_expire_sessions(p_now timestamptz default now()) returns void
language plpgsql as $$
begin
  perform set_config('haven.actor_type', 'system', true);
  delete from haven.scan_sessions where expires_at <= p_now - interval '1 day';
  delete from haven.otp_challenges where created_at <= p_now - interval '1 day';
  delete from haven.idempotency_keys where created_at <= p_now - interval '24 hours';
  delete from haven.gate_pairing_codes where used_at is not null or expires_at <= p_now;
end $$;

grant execute on function haven.job_expire_walkins(timestamptz), haven.job_expire_approved(timestamptz),
  haven.job_flag_overstays(timestamptz), haven.job_night_sweep(timestamptz),
  haven.job_gate_offline(timestamptz), haven.job_retention(timestamptz),
  haven.job_expire_sessions(timestamptz) to haven_api;
