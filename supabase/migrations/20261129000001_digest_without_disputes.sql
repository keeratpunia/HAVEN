-- DEC-033: hosts no longer report an invited or overnight guest as "Not my guest" after
-- entry (walk-ins are approved by the host before entry instead), so the FR-60 daily
-- digest drops its "{disputes} disputed" count. Everything else is unchanged from
-- 20261020000002_daily_digest.sql; the schedule stays as it is.

create or replace function haven.job_daily_digest(p_now timestamptz default now()) returns void
language plpgsql as $$
declare
  h record;
  tz text;
  d date;
  day_start timestamptz;
  day_end timestamptz;
  n_visits int; n_overstayed int; n_unverified int; n_forced int;
begin
  perform set_config('haven.actor_type', 'system', true);
  for h in select id, code from haven.hostels loop
    tz := coalesce(haven.rules_for(h.id) ->> 'timezone', 'Asia/Kolkata');
    d := (p_now at time zone tz)::date - 1;
    day_start := d::timestamp at time zone tz;
    day_end := (d + 1)::timestamp at time zone tz;

    select count(*) into n_visits from haven.visits
     where hostel_id = h.id and first_entry_at >= day_start and first_entry_at < day_end;
    select count(*) into n_overstayed from haven.visits
     where hostel_id = h.id and overstay_since >= day_start and overstay_since < day_end;
    select count(*) into n_unverified from haven.gate_events
     where hostel_id = h.id and kind = 'entry' and not location_verified
       and at >= day_start and at < day_end;
    select count(*) into n_forced from haven.visits
     where hostel_id = h.id and close_reason = 'forced' and closed_at >= day_start and closed_at < day_end;

    -- N-DIGEST: "Yesterday at {hostelCode} / {visits} visits · {overstays} overstayed ·
    -- {unverified} location not verified · {forced} forced check-outs."
    insert into haven.notifications (hostel_id, recipient_type, recipient_id, kind, channel,
                                     title, body, data, dedupe_key, next_attempt_at)
    select h.id, 'user', ra.user_id, 'N-DIGEST', 'push',
           'Yesterday at ' || h.code,
           n_visits || ' visits · ' || n_overstayed || ' overstayed · '
             || n_unverified || ' location not verified · ' || n_forced || ' forced check-outs.',
           jsonb_build_object('screen', '/warden/reports?from=' || d || '&to=' || d),
           'digest:' || h.id || ':' || d || ':' || ra.user_id, p_now
      from haven.role_assignments ra
     where ra.hostel_id = h.id and ra.role = 'warden' and ra.revoked_at is null
    on conflict (dedupe_key) do nothing;
  end loop;
end $$;
