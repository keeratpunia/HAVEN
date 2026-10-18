-- SDD §16.5 measures guest retention from `last_visit_at` ("365 days after last
-- visit"). It was only stamped at guest sign-in, so a returning guest whose session was
-- still valid could check in for a year without it moving, and be anonymised while
-- still visiting. Every entry at the gate now moves it, whichever path wrote the entry
-- (gate check-in, walk-in approval, host-assisted entry, host confirmation).

create function haven.touch_visitor_last_visit() returns trigger language plpgsql as $$
begin
  if new.kind = 'entry' then
    update haven.visitors vi
       set last_visit_at = greatest(coalesce(vi.last_visit_at, new.at), new.at)
      from haven.visits v
     where v.id = new.visit_id and vi.id = v.visitor_id;
  end if;
  return new;
end $$;

create trigger t_gate_events_last_visit after insert on haven.gate_events
  for each row execute function haven.touch_visitor_last_visit();
