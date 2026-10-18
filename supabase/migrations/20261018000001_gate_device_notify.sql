-- SDD §9.9: "Same [pg_notify('haven_events', ...)] for gate_devices heartbeat state
-- changes." The visits trigger already exists (init migration). This adds the gate half,
-- firing only when a device's state changes — not on every 60 s heartbeat:
--   * it comes online: first heartbeat, or a heartbeat after more than 5 minutes silent;
--   * it goes offline: job_gate_offline() stamps offline_alerted_at;
--   * it is paired (insert) or revoked.
-- Payload: {t:'gate', h:<hostel id>, id:<gate id>, online:<bool>}.

create or replace function haven.notify_gate_device() returns trigger language plpgsql as $$
declare
  h uuid;
  came_online boolean;
  went_offline boolean;
  revoked boolean;
begin
  select hostel_id into h from haven.gates where id = new.gate_id;
  if tg_op = 'INSERT' then
    -- Pairing stamps last_seen_at, so a newly paired device is online.
    perform pg_notify('haven_events', json_build_object(
      't','gate','h',h,'id',new.gate_id,'online',new.last_seen_at is not null)::text);
    return new;
  end if;
  came_online := new.last_seen_at is not null and (
    old.last_seen_at is null or new.last_seen_at - old.last_seen_at > interval '5 minutes'
    or (old.offline_alerted_at is not null and old.offline_alerted_at >= old.last_seen_at));
  went_offline := new.offline_alerted_at is distinct from old.offline_alerted_at
                  and new.offline_alerted_at is not null;
  revoked := new.revoked_at is not null and old.revoked_at is null;
  if came_online or went_offline or revoked then
    perform pg_notify('haven_events', json_build_object(
      't','gate','h',h,'id',new.gate_id,
      'online', came_online and not revoked and not went_offline)::text);
  end if;
  return new;
end $$;

create trigger t_gate_devices_notify after insert or update on haven.gate_devices
  for each row execute function haven.notify_gate_device();
