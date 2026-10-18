-- FR-60 "Daily 08:00 digest to warden: yesterday's visits, disputes, overstays,
-- location-unverified entries, forced exits". SDD §15.2 had no kind or text for it; the
-- team approved N-DIGEST and its text as an addition to the catalogue
-- (docs/DECISIONS.md DEC-016). "Yesterday" is the hostel's local calendar day:
--   visits        visits whose first entry was yesterday
--   disputed      visits the host disputed yesterday
--   overstayed    visits flagged as overstaying yesterday
--   unverified    entries at the gate yesterday with location not verified
--   forced        visits force-checked-out yesterday
-- One push per warden per day (dedupe key), tap opens W-12 for that date.

create function haven.job_daily_digest(p_now timestamptz default now()) returns void
language plpgsql as $$
declare
  h record;
  tz text;
  d date;
  day_start timestamptz;
  day_end timestamptz;
  n_visits int; n_disputed int; n_overstayed int; n_unverified int; n_forced int;
begin
  perform set_config('haven.actor_type', 'system', true);
  for h in select id, code from haven.hostels loop
    tz := coalesce(haven.rules_for(h.id) ->> 'timezone', 'Asia/Kolkata');
    d := (p_now at time zone tz)::date - 1;
    day_start := d::timestamp at time zone tz;
    day_end := (d + 1)::timestamp at time zone tz;

    select count(*) into n_visits from haven.visits
     where hostel_id = h.id and first_entry_at >= day_start and first_entry_at < day_end;
    select count(*) into n_disputed from haven.visits
     where hostel_id = h.id and host_disputed_at >= day_start and host_disputed_at < day_end;
    select count(*) into n_overstayed from haven.visits
     where hostel_id = h.id and overstay_since >= day_start and overstay_since < day_end;
    select count(*) into n_unverified from haven.gate_events
     where hostel_id = h.id and kind = 'entry' and not location_verified
       and at >= day_start and at < day_end;
    select count(*) into n_forced from haven.visits
     where hostel_id = h.id and close_reason = 'forced' and closed_at >= day_start and closed_at < day_end;

    -- N-DIGEST: "Yesterday at {hostelCode} / {visits} visits · {disputes} disputed ·
    -- {overstays} overstayed · {unverified} location not verified · {forced} forced check-outs."
    insert into haven.notifications (hostel_id, recipient_type, recipient_id, kind, channel,
                                     title, body, data, dedupe_key, next_attempt_at)
    select h.id, 'user', ra.user_id, 'N-DIGEST', 'push',
           'Yesterday at ' || h.code,
           n_visits || ' visits · ' || n_disputed || ' disputed · ' || n_overstayed || ' overstayed · '
             || n_unverified || ' location not verified · ' || n_forced || ' forced check-outs.',
           jsonb_build_object('screen', '/warden/reports?from=' || d || '&to=' || d),
           'digest:' || h.id || ':' || d || ':' || ra.user_id, p_now
      from haven.role_assignments ra
     where ra.hostel_id = h.id and ra.role = 'warden' and ra.revoked_at is null
    on conflict (dedupe_key) do nothing;
  end loop;
end $$;

grant execute on function haven.job_daily_digest(timestamptz) to haven_api;

-- 08:00 IST = 02:30 UTC. Same guard as the init migration's schedules.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('haven-daily-digest', '30 2 * * *', $cron$select haven.job_daily_digest()$cron$);
  end if;
end $$;
