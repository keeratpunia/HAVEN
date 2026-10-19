-- FR-27 / SDD F3 step 1: a guest who denies location permission goes straight to
-- "Ask host to confirm"; the denial is not one of the three GPS attempts (§9.3). A
-- session created with permission denied therefore starts at 0 attempts.
alter table haven.scan_sessions
  drop constraint scan_sessions_location_attempts_check;
alter table haven.scan_sessions
  add constraint scan_sessions_location_attempts_check check (location_attempts between 0 and 3);
