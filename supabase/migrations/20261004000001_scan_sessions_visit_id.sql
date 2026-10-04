-- =============================================================================
-- Links a scan session to the visit it ultimately produced/served, so a later
-- action on that visit (specifically: a host approving a walk-in, SDD F2 step 9,
-- "server runs evaluateEntry using the scan session's GPS result ... so no second
-- scan") can recover the original GPS facts without a second geofence check.
-- Set by the gate module at the moment a session is consumed (check-in, check-out,
-- walk-in, host-assisted) — never at session creation, since the visit doesn't
-- necessarily exist yet at that point (walk-in creates one; check-in/out already
-- have one).
-- =============================================================================

alter table haven.scan_sessions
  add column visit_id uuid references haven.visits(id);

create index scan_sessions_visit_idx on haven.scan_sessions (visit_id) where visit_id is not null;
