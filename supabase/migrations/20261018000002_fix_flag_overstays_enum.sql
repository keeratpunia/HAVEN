-- Fix: job_flag_overstays() never ran. Its host-push and guest-SMS rows are combined
-- with UNION ALL, which types the bare 'push'/'sms' literals as text, and Postgres
-- refuses text for the haven.notif_channel column ("column channel is of type
-- haven.notif_channel but expression is of type text"). Found when the in-process job
-- runner (docs/DECISIONS.md DEC-014) first executed it. Same function, with explicit
-- enum casts; behaviour and text unchanged.

create or replace function haven.job_flag_overstays() returns void language plpgsql as $$
begin
  perform set_config('haven.actor_type', 'system', true);
  with flagged as (
    update haven.visits v set overstay_since = now()
     where v.status = 'inside' and v.overstay_since is null
       and now() > v.window_end + make_interval(mins => (haven.rules_for(v.hostel_id) ->> 'overstay_grace_minutes')::int)
    returning v.*)
  -- N-OVERSTAY-HOST: "Your guest is still inside / Their visit ended at {endTime}. Ask them to check out at the gate."
  insert into haven.notifications (hostel_id, recipient_type, recipient_id, recipient_phone, kind,
                                   channel, visit_id, title, body, sms_template_id, dedupe_key)
  select f.hostel_id, 'user', f.host_id, null, 'N-OVERSTAY-HOST', 'push'::haven.notif_channel, f.id,
         'Your guest is still inside',
         'Their visit ended at ' || lower(to_char(f.window_end at time zone 'Asia/Kolkata', 'FMHH12:MI am'))
           || '. Ask them to check out at the gate.',
         null, 'overstay-host:' || f.id
    from flagged f
  union all
  -- N-OVERSTAY-GUEST (SMS, HAVEN_OVERSTAY): "Your HAVEN visit to {hostelCode} ended at {endTime}. Please check out at the gate now."
  select f.hostel_id, 'phone', null, vi.phone, 'N-OVERSTAY-GUEST', 'sms'::haven.notif_channel, f.id,
         null,
         'Your HAVEN visit to ' || h.code || ' ended at '
           || lower(to_char(f.window_end at time zone 'Asia/Kolkata', 'FMHH12:MI am'))
           || '. Please check out at the gate now.',
         'HAVEN_OVERSTAY',
         'overstay-guest:' || f.id
    from flagged f
    join haven.visitors vi on vi.id = f.visitor_id
    join haven.hostels h on h.id = f.hostel_id
   where vi.phone is not null
  on conflict (dedupe_key) do nothing;

  with esc as (
    update haven.visits v set overstay_escalated_at = now()
     where v.status = 'inside' and v.overstay_since < now() - interval '30 minutes'
       and v.overstay_escalated_at is null
    returning v.*)
  -- N-OVERSTAY-WARDEN: "Guest overstaying / {guestName} (host {hostName}, room {room}) is 30+ min past their end time."
  insert into haven.notifications (hostel_id, recipient_type, recipient_id, kind, channel,
                                   visit_id, title, body, dedupe_key)
  select e.hostel_id, 'user', ra.user_id, 'N-OVERSTAY-WARDEN', 'push', e.id,
         'Guest overstaying',
         coalesce(vi.full_name, e.invited_name, 'A guest') || ' (host ' || u.full_name || ', room '
           || coalesce(r.number, res.claimed_room) || ') is 30+ min past their end time.',
         'overstay-warden:' || e.id || ':' || ra.user_id
    from esc e
    join haven.role_assignments ra
      on ra.hostel_id = e.hostel_id and ra.role = 'warden' and ra.revoked_at is null
    join haven.users u on u.id = e.host_id
    join haven.residents res on res.user_id = e.host_id
    left join haven.rooms r on r.id = res.room_id
    left join haven.visitors vi on vi.id = e.visitor_id
  on conflict (dedupe_key) do nothing;
end $$;
