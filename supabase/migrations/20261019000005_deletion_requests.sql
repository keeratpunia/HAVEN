-- SDD §16.6 / FR-09: "API records a deletion request". The SDD names the endpoint
-- (POST /me/deletion-request, §12.4) but no table; this is the record the worker
-- completes "within 7 days" (docs/DECISIONS.md DEC-015). One open request per person.

create table haven.deletion_requests (
  id             uuid primary key default gen_random_uuid(),
  principal_type haven.principal_type not null,
  principal_id   uuid not null,
  reason         text check (char_length(reason) <= 500),
  status         text not null default 'pending' check (status in ('pending','completed')),
  -- Why the worker hasn't finished yet: 'inside', 'upcoming_visit' or 'unpaid_charges'.
  waiting_for    text check (waiting_for in ('inside','upcoming_visit','unpaid_charges')),
  requested_at   timestamptz not null default now(),
  checked_at     timestamptz,
  completed_at   timestamptz
);
create unique index deletion_requests_open_uq on haven.deletion_requests (principal_type, principal_id)
  where status = 'pending';

grant select, insert, update on haven.deletion_requests to haven_api;
alter table haven.deletion_requests enable row level security;
create policy api_all on haven.deletion_requests to haven_api using (true) with check (true);
