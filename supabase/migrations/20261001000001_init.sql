-- HAVEN database foundation.
-- Authoritative schema per SDD §11 ("Database schema"). Everything lives in schema
-- `haven`, which must never be added to Supabase's "Exposed schemas" setting (SDD
-- §11.7) — the only way in is the API, connecting as the `haven_api` role.
--
-- This migration is transcribed from the SDD as closely as SQL syntax allows. Where a
-- choice was genuinely open (e.g. exact seed-invite expiry), see docs/DECISIONS.md.

-- =============================================================================
-- 11.1 Extensions, schema and enums
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

-- pg_cron ships with Supabase's Postgres image (local CLI and cloud) but is not part
-- of vanilla community Postgres, so `create extension pg_cron` errors outright (not a
-- no-op) on a plain Postgres server. Guarded so this same migration file is valid
-- against both: on Supabase, pg_cron installs and the job schedules below register
-- normally; on a plain Postgres instance (used in this environment to validate the
-- schema when Docker/Supabase CLI was unavailable — see docs/DECISIONS.md), the
-- extension and the cron.schedule() calls are skipped with a notice, and the job
-- functions themselves (haven.job_*) are still created and callable directly.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  else
    raise notice 'pg_cron is not available on this Postgres server — skipping. Expected on Supabase; the haven.job_* functions are still created below and can be invoked directly or scheduled once pg_cron is present.';
  end if;
end $$;

create schema if not exists haven;

create type haven.gender          as enum ('female','male','undisclosed');
create type haven.staff_role      as enum ('super_admin','warden','office');
create type haven.resident_status as enum ('pending','verified','rejected','suspended','left');
create type haven.visit_type      as enum ('quick_drop','day','overnight_room','guest_room');
create type haven.visit_status    as enum ('pending_host','pending_warden','approved','inside',
                                            'completed','rejected','expired','cancelled');
create type haven.visit_origin    as enum ('invite','walk_in','host_assisted','overnight_request');
create type haven.zone            as enum ('gate','visitors_room','room','guest_room');
create type haven.gate_event_kind as enum ('entry','exit','entry_denied');
create type haven.actor_type      as enum ('user','visitor','gate_device','system');
create type haven.approver_role   as enum ('host','warden');
create type haven.decision        as enum ('approved','rejected');
create type haven.charge_kind     as enum ('overnight_room','guest_room','fine');
create type haven.charge_status   as enum ('pending','confirmed','paid','waived');
create type haven.media_kind      as enum ('visitor_profile','gate_photo','resident_id_card','resident_selfie');
create type haven.notif_channel   as enum ('push','sms','in_app');
create type haven.notif_status    as enum ('queued','sending','sent','failed','cancelled');
create type haven.otp_purpose     as enum ('guest_login','phone_verify');
create type haven.principal_type  as enum ('user','visitor');

-- =============================================================================
-- 11.2 Identity and hostel tables
-- =============================================================================

create table haven.hostels (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique check (code ~ '^[A-Z0-9-]{2,12}$'),
  name          text not null,
  gender_served haven.gender not null check (gender_served <> 'undisclosed'),
  timezone      text not null default 'Asia/Kolkata',
  created_at    timestamptz not null default now()
);

create table haven.users (                       -- anyone signing in with Google
  id                uuid primary key default gen_random_uuid(),
  google_sub        text not null unique,
  email             citext not null unique,
  full_name         text not null check (char_length(full_name) between 2 and 80),
  phone             text unique check (phone ~ '^\+91[6-9][0-9]{9}$'),
  phone_verified_at timestamptz,
  is_active         boolean not null default true,
  last_login_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table haven.role_assignments (            -- staff roles only; residents use haven.residents
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references haven.users(id),
  hostel_id   uuid references haven.hostels(id),
  role        haven.staff_role not null,
  granted_by  uuid references haven.users(id),
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  revoked_by  uuid references haven.users(id),
  check ((role = 'super_admin') = (hostel_id is null))
);
create unique index role_assignments_active_uq on haven.role_assignments
  (user_id, coalesce(hostel_id, '00000000-0000-0000-0000-000000000000'), role)
  where revoked_at is null;

create table haven.staff_invites (
  id          uuid primary key default gen_random_uuid(),
  hostel_id   uuid references haven.hostels(id),
  role        haven.staff_role not null,
  email       citext not null,
  token_hash  bytea not null unique,
  invited_by  uuid references haven.users(id),     -- null for seed-created invites
  expires_at  timestamptz not null,
  accepted_by uuid references haven.users(id),
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

create table haven.rooms (
  id         uuid primary key default gen_random_uuid(),
  hostel_id  uuid not null references haven.hostels(id),
  number     text not null check (number ~ '^[A-Z0-9-]{1,8}$'),
  floor      smallint,
  created_at timestamptz not null default now(),
  unique (hostel_id, number)
);

create table haven.media (
  id               uuid primary key default gen_random_uuid(),
  kind             haven.media_kind not null,
  bucket           text not null,
  path             text not null unique,
  sha256           bytea not null,
  bytes            integer not null check (bytes > 0),
  owner_user_id    uuid references haven.users(id),
  owner_visitor_id uuid,                                  -- FK added below (haven.visitors doesn't exist yet)
  delete_after     timestamptz,
  deleted_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index media_sha_visitor_idx on haven.media (owner_visitor_id, sha256);
create index media_delete_due_idx on haven.media (delete_after) where deleted_at is null;

create table haven.residents (
  user_id                 uuid primary key references haven.users(id),
  hostel_id               uuid not null references haven.hostels(id),
  claimed_room            text not null check (claimed_room ~ '^[A-Z0-9-]{1,8}$'),
  room_id                 uuid references haven.rooms(id),      -- set when verified
  status                  haven.resident_status not null default 'pending',
  id_card_media_id        uuid references haven.media(id),
  selfie_media_id         uuid references haven.media(id),
  submitted_at            timestamptz,
  decided_by              uuid references haven.users(id),
  decided_at              timestamptz,
  rejection_reason        text,
  resubmissions           smallint not null default 0 check (resubmissions <= 1),
  hosting_suspended_until timestamptz,          -- null with status 'suspended' = until lifted
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  check (status <> 'verified' or room_id is not null)
);
create index residents_hostel_status_idx on haven.residents (hostel_id, status);
create index residents_room_idx on haven.residents (room_id) where status = 'verified';

create table haven.visitors (
  id                 uuid primary key default gen_random_uuid(),
  phone              text unique check (phone ~ '^\+91[6-9][0-9]{9}$'),
  full_name          text not null check (char_length(full_name) between 2 and 80),
  gender             haven.gender not null,
  is_adult_confirmed boolean not null default false,
  profile_media_id   uuid references haven.media(id),
  consent_version    text,
  consent_at         timestamptz,
  created_by_host_id uuid references haven.users(id),   -- set for host-assisted, phone-less guests
  last_visit_at      timestamptz,
  anonymised_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (phone is not null or created_by_host_id is not null)
);
alter table haven.media add constraint media_owner_visitor_fk
  foreign key (owner_visitor_id) references haven.visitors(id);

create table haven.bans (                        -- guest bans; host suspensions live on residents
  id          uuid primary key default gen_random_uuid(),
  visitor_id  uuid not null references haven.visitors(id),
  hostel_id   uuid references haven.hostels(id),           -- null = all hostels
  reason      text not null,
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz,                                 -- null = permanent
  created_by  uuid not null references haven.users(id),
  created_at  timestamptz not null default now(),
  lifted_at   timestamptz,
  lifted_by   uuid references haven.users(id),
  lift_reason text,
  check (ends_at is null or ends_at > starts_at)
);
create index bans_visitor_active_idx on haven.bans (visitor_id) where lifted_at is null;

-- =============================================================================
-- 11.3 Rules and gate tables
-- =============================================================================

create table haven.hostel_rules (                -- insert-only, versioned
  id         uuid primary key default gen_random_uuid(),
  hostel_id  uuid not null references haven.hostels(id),
  version    integer not null check (version > 0),
  config     jsonb not null,
  created_by uuid references haven.users(id),
  created_at timestamptz not null default now(),
  unique (hostel_id, version)
);

create table haven.gates (
  id                uuid primary key default gen_random_uuid(),
  hostel_id         uuid not null references haven.hostels(id),
  code              text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  name              text not null default 'Main gate',
  lat               double precision check (lat between -90 and 90),
  lng               double precision check (lng between -180 and 180),
  radius_m          integer not null default 50 check (radius_m between 10 and 300),
  max_accuracy_m    integer not null default 75 check (max_accuracy_m between 10 and 200),
  secret_enc        bytea not null,               -- AES-256-GCM (iv || tag || ciphertext)
  secret_version    integer not null default 1,
  prev_secret_enc   bytea,
  secret_rotated_at timestamptz,
  location_set_by   uuid references haven.users(id),
  location_set_at   timestamptz,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now()
);

create table haven.gate_devices (
  id                 uuid primary key default gen_random_uuid(),
  gate_id            uuid not null references haven.gates(id),
  label              text not null default 'Gate phone',
  token_hash         bytea not null unique,
  paired_by          uuid not null references haven.users(id),
  paired_at          timestamptz not null default now(),
  last_seen_at       timestamptz,
  last_ip            inet,
  user_agent         text,
  clock_offset_ms    integer,
  offline_alerted_at timestamptz,
  revoked_at         timestamptz,
  revoked_by         uuid references haven.users(id)
);

create table haven.gate_pairing_codes (
  code_hash  bytea primary key,
  gate_id    uuid not null references haven.gates(id),
  created_by uuid not null references haven.users(id),
  expires_at timestamptz not null,
  used_at    timestamptz,
  device_id  uuid references haven.gate_devices(id)
);

-- =============================================================================
-- 11.4 Visit tables
-- =============================================================================

create table haven.visits (
  id                       uuid primary key default gen_random_uuid(),
  code                     text not null unique check (code ~ '^V[0-9A-HJKMNP-TV-Z]{6}$'),
  hostel_id                uuid not null references haven.hostels(id),
  host_id                  uuid not null references haven.residents(user_id),
  visitor_id               uuid references haven.visitors(id),
  invited_name             text,
  invited_phone            text check (invited_phone ~ '^\+91[6-9][0-9]{9}$'),
  invited_gender           haven.gender,
  type                     haven.visit_type not null,
  status                   haven.visit_status not null,
  origin                   haven.visit_origin not null,
  zone                     haven.zone not null,
  window_start             timestamptz not null,
  window_end               timestamptz not null,
  nights                   smallint not null default 0 check (nights >= 0),
  invite_token_hash        bytea unique,
  rules_version            integer not null,
  location_unverified      boolean not null default false,
  exit_location_unverified boolean not null default false,
  overstay_since           timestamptz,
  overstay_escalated_at    timestamptz,
  host_confirmed_at        timestamptz,
  host_disputed_at         timestamptz,
  dispute_resolved_at      timestamptz,
  dispute_resolved_by      uuid references haven.users(id),
  first_entry_at           timestamptz,
  last_entry_at            timestamptz,
  last_exit_at             timestamptz,
  closed_at                timestamptz,
  close_reason             text check (close_reason in
                             ('checked_out','host_marked_left','forced','window_ended')),
  cancel_reason            text,
  created_by_type          haven.actor_type not null,
  created_by_id            uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check (window_end > window_start),
  check (visitor_id is not null or (invited_phone is not null and invited_name is not null)),
  check (type in ('overnight_room','guest_room') or nights = 0)
);
-- BR-15: a guest can be inside only one visit at a time, anywhere — enforced as a
-- database guarantee (partial unique index), not an application-level check, because
-- the SDD explicitly requires this invariant to hold under concurrent writes (§7.3).
create unique index visits_one_inside_per_visitor on haven.visits (visitor_id) where status = 'inside';
create index visits_hostel_status_idx   on haven.visits (hostel_id, status);
create index visits_host_idx            on haven.visits (host_id, window_start desc);
create index visits_visitor_idx         on haven.visits (visitor_id, window_start desc);
create index visits_active_end_idx      on haven.visits (window_end) where status in ('approved','inside');
create index visits_unclaimed_phone_idx on haven.visits (invited_phone) where visitor_id is null;

create table haven.approvals (                   -- insert-only
  id                  uuid primary key default gen_random_uuid(),
  visit_id            uuid not null references haven.visits(id),
  approver_id         uuid not null references haven.users(id),
  approver_role       haven.approver_role not null,
  decision            haven.decision not null,
  reason              text,
  adjusted_window_end timestamptz,
  decided_at          timestamptz not null default now(),
  unique (visit_id, approver_role)
);

create table haven.scan_sessions (               -- short-lived; purged hourly
  id                uuid primary key default gen_random_uuid(),
  gate_id           uuid not null references haven.gates(id),
  client_nonce_hash bytea not null,
  token_step        bigint not null,
  token_age_steps   smallint not null,
  lat               double precision,
  lng               double precision,
  accuracy_m        real,
  captured_at       timestamptz,
  distance_m        real,
  gps_ok            boolean not null,
  gps_failure       text check (gps_failure in
                      ('outside_geofence','low_accuracy','stale_fix','no_location','gate_not_configured')),
  location_attempts smallint not null default 1 check (location_attempts between 1 and 3),
  visitor_id        uuid references haven.visitors(id),
  host_user_id      uuid references haven.users(id),
  photo_media_id    uuid references haven.media(id),
  ip                inet,
  user_agent        text,
  consumed_at       timestamptz,
  consumed_action   text check (consumed_action in ('check_in','check_out','walk_in','host_assisted')),
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now()
);
create index scan_sessions_expires_idx on haven.scan_sessions (expires_at);

create table haven.gate_events (                 -- append-only; copies GPS facts so sessions can be purged
  id                uuid primary key default gen_random_uuid(),
  visit_id          uuid not null references haven.visits(id),
  hostel_id         uuid not null references haven.hostels(id),
  gate_id           uuid not null references haven.gates(id),
  scan_session_id   uuid,                         -- no FK on purpose (scan_sessions is purged hourly)
  kind              haven.gate_event_kind not null,
  actor_type        haven.actor_type not null,
  actor_id          uuid,
  photo_media_id    uuid references haven.media(id),
  location_verified boolean not null,
  distance_m        real,
  accuracy_m        real,
  rule_codes        text[] not null default '{}',
  at                timestamptz not null default now()
);
create index gate_events_visit_idx  on haven.gate_events (visit_id, at);
create index gate_events_hostel_idx on haven.gate_events (hostel_id, at desc);

create table haven.charges (
  id               uuid primary key default gen_random_uuid(),
  hostel_id        uuid not null references haven.hostels(id),
  resident_id      uuid not null references haven.residents(user_id),
  visit_id         uuid references haven.visits(id),
  kind             haven.charge_kind not null,
  units            smallint check (units > 0),
  unit_price_inr   integer check (unit_price_inr >= 0),
  amount_inr       integer not null check (amount_inr >= 0),
  description      text not null,
  status           haven.charge_status not null default 'pending',
  created_by       uuid references haven.users(id),
  created_at       timestamptz not null default now(),
  confirmed_by     uuid references haven.users(id),
  confirmed_at     timestamptz,
  paid_recorded_by uuid references haven.users(id),
  paid_at          timestamptz,
  receipt_no       text,
  waived_by        uuid references haven.users(id),
  waived_at        timestamptz,
  waive_reason     text,
  check (status <> 'paid'   or receipt_no   is not null),
  check (status <> 'waived' or waive_reason is not null)
);
create unique index charges_visit_kind_uq on haven.charges (visit_id, kind) where visit_id is not null;
create index charges_hostel_status_idx on haven.charges (hostel_id, status, created_at desc);

-- =============================================================================
-- 11.5 Messaging, auth bookkeeping and audit
-- =============================================================================

create table haven.notifications (               -- outbox
  id               uuid primary key default gen_random_uuid(),
  hostel_id        uuid references haven.hostels(id),
  recipient_type   text not null check (recipient_type in ('user','visitor','phone')),
  recipient_id     uuid,
  recipient_phone  text,
  kind             text not null,                -- e.g. 'N-WALKIN' (SDD §15)
  channel          haven.notif_channel not null,
  visit_id         uuid references haven.visits(id),
  title            text,
  body             text not null,
  data             jsonb not null default '{}',
  sms_template_id  text,
  status           haven.notif_status not null default 'queued',
  attempts         smallint not null default 0,
  next_attempt_at  timestamptz not null default now(),
  cancel_if_opened uuid references haven.notifications(id),
  dedupe_key       text unique,
  provider_ref     text,
  last_error       text,
  sent_at          timestamptz,
  opened_at        timestamptz,
  created_at       timestamptz not null default now(),
  check (recipient_type <> 'phone' or recipient_phone is not null)
);
create index notifications_queue_idx on haven.notifications (next_attempt_at) where status = 'queued';
create index notifications_recipient_idx on haven.notifications (recipient_type, recipient_id, created_at desc);

create table haven.push_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references haven.users(id),
  expo_token   text not null unique,
  platform     text not null check (platform in ('android','ios','web')),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  disabled_at  timestamptz
);

create table haven.otp_challenges (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null,
  purpose     haven.otp_purpose not null,
  code_hash   bytea not null,
  attempts    smallint not null default 0 check (attempts <= 5),
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  ip          inet,
  created_at  timestamptz not null default now()
);
create index otp_phone_idx on haven.otp_challenges (phone, created_at desc);

create table haven.sessions (
  id                    uuid primary key default gen_random_uuid(),
  principal_type        haven.principal_type not null,
  principal_id          uuid not null,
  refresh_hash          bytea not null unique,
  previous_refresh_hash bytea,
  client                text not null check (client in ('web','native')),
  user_agent            text,
  ip                    inet,
  created_at            timestamptz not null default now(),
  last_used_at          timestamptz not null default now(),
  expires_at            timestamptz not null,
  revoked_at            timestamptz,
  revoke_reason         text
);
create index sessions_principal_idx on haven.sessions (principal_type, principal_id) where revoked_at is null;

create table haven.idempotency_keys (
  key          uuid not null,
  principal_id uuid not null,
  route        text not null,
  status_code  smallint not null,
  response     jsonb not null,
  created_at   timestamptz not null default now(),
  primary key (key, principal_id, route)
);

create table haven.audit_log (                   -- append-only; never contains raw PII (see trigger)
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor_type haven.actor_type not null,
  actor_id   uuid,
  hostel_id  uuid,
  action     text not null,                      -- e.g. 'visits.update'
  entity     text not null,
  entity_id  uuid,
  before     jsonb,
  after      jsonb,
  ip         inet,
  request_id text
);
create index audit_hostel_at_idx on haven.audit_log (hostel_id, at desc);
create index audit_entity_idx    on haven.audit_log (entity, entity_id, at);

-- =============================================================================
-- 11.6 Triggers
--
-- The API sets transaction-local settings at the start of every write transaction:
--   select set_config('haven.actor_type', $1, true),
--          set_config('haven.actor_id', $2, true),
--          set_config('haven.request_id', $3, true);
-- Jobs set actor_type = 'system'. Gate heartbeats also set haven.skip_audit = '1' so
-- the audit log isn't flooded.
-- =============================================================================

-- updated_at
create function haven.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger t_users_touch     before update on haven.users     for each row execute function haven.touch_updated_at();
create trigger t_residents_touch before update on haven.residents for each row execute function haven.touch_updated_at();
create trigger t_visitors_touch  before update on haven.visitors  for each row execute function haven.touch_updated_at();
create trigger t_visits_touch    before update on haven.visits    for each row execute function haven.touch_updated_at();

-- append-only tables — a database-level guarantee the SDD requires explicitly (§10.2:
-- "gate_events and audit_log hold what happened and are never updated or deleted";
-- §11.2 modelling decision: approvals and hostel_rules are insert-only).
create function haven.forbid_mutation() returns trigger language plpgsql as $$
begin raise exception '% is append-only', tg_table_name using errcode = '42501'; end $$;

create trigger t_gate_events_ro before update or delete on haven.gate_events  for each row execute function haven.forbid_mutation();
create trigger t_audit_ro       before update or delete on haven.audit_log    for each row execute function haven.forbid_mutation();
create trigger t_approvals_ro   before update or delete on haven.approvals    for each row execute function haven.forbid_mutation();
create trigger t_rules_ro       before update or delete on haven.hostel_rules for each row execute function haven.forbid_mutation();

-- audit: PII and secret columns are stripped before logging (SDD §16.4 "Audit of
-- reads" is a separate, API-level control for read actions — see CLAUDE.md §4. This
-- trigger covers the *write* half: every insert/update on the tables below gets an
-- audit_log row with PII columns removed, automatically, so no handler can forget it.)
create function haven.audit_row() returns trigger language plpgsql as $$
declare
  pii text[] := array['phone','invited_phone','invited_name','full_name','email','secret_enc',
                       'prev_secret_enc','token_hash','invite_token_hash','code_hash','refresh_hash',
                       'lat','lng'];
  b jsonb; a jsonb;
begin
  if current_setting('haven.skip_audit', true) = '1' then return coalesce(new, old); end if;
  if tg_op <> 'INSERT' then b := to_jsonb(old) - pii; end if;
  if tg_op <> 'DELETE' then a := to_jsonb(new) - pii; end if;
  insert into haven.audit_log (actor_type, actor_id, hostel_id, action, entity, entity_id, before, after, request_id)
  values (
    coalesce(nullif(current_setting('haven.actor_type', true), ''), 'system')::haven.actor_type,
    nullif(current_setting('haven.actor_id', true), '')::uuid,
    coalesce(a ->> 'hostel_id', b ->> 'hostel_id')::uuid,
    tg_table_name || '.' || lower(tg_op),
    tg_table_name,
    coalesce(a ->> 'id', b ->> 'id', a ->> 'user_id', b ->> 'user_id')::uuid,
    b, a,
    nullif(current_setting('haven.request_id', true), ''));
  return coalesce(new, old);
end $$;

create trigger t_audit_visits    after insert or update on haven.visits          for each row execute function haven.audit_row();
create trigger t_audit_residents after insert or update on haven.residents       for each row execute function haven.audit_row();
create trigger t_audit_roles     after insert or update on haven.role_assignments for each row execute function haven.audit_row();
create trigger t_audit_bans      after insert or update on haven.bans            for each row execute function haven.audit_row();
create trigger t_audit_charges   after insert or update on haven.charges         for each row execute function haven.audit_row();
create trigger t_audit_gates     after insert or update on haven.gates           for each row execute function haven.audit_row();
create trigger t_audit_devices   after insert or update on haven.gate_devices    for each row execute function haven.audit_row();
create trigger t_audit_rules     after insert           on haven.hostel_rules    for each row execute function haven.audit_row();
create trigger t_audit_invites   after insert or update on haven.staff_invites   for each row execute function haven.audit_row();

-- live events for SSE
create function haven.notify_visit() returns trigger language plpgsql as $$
begin
  perform pg_notify('haven_events', json_build_object(
    't','visit','h',new.hostel_id,'id',new.id,'s',new.status,
    'o', new.overstay_since is not null, 'd', new.host_disputed_at is not null)::text);
  return new;
end $$;
create trigger t_visits_notify after insert or update on haven.visits
  for each row execute function haven.notify_visit();

-- =============================================================================
-- 11.7 Database role and row-level security
-- =============================================================================

-- SDD §11.7 specifies `create role haven_api login password :'api_password' noinherit;`
-- — the `:'api_password'` form is psql client-side variable interpolation (`psql -v
-- api_password=...`), which only works when this file is run through the `psql`
-- binary with that variable set. Supabase CLI's migration runner (and any other plain
-- SQL executor) does not provide psql variables, so that syntax is a hard syntax error
-- outside of psql. It is replaced here with a literal, clearly-local-only password —
-- documented in docs/DECISIONS.md — that MUST be rotated with
-- `ALTER ROLE haven_api WITH PASSWORD '<secret-from-the-secrets-manager>'` immediately
-- after this migration first runs against staging or production, per the SDD comment
-- "password from the secrets manager".
--
-- Also guarded with IF NOT EXISTS: Postgres roles are cluster-level, not
-- database-level, so `supabase db reset` (which drops and recreates the *database*
-- but not the cluster's roles) would make a second, unguarded `create role` fail with
-- "role already exists" on the second and every subsequent reset.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'haven_api') then
    create role haven_api login password 'haven_api_local_dev_only' noinherit;
  else
    alter role haven_api with login noinherit;
  end if;
end $$;

grant usage on schema haven to haven_api;
grant select, insert, update on all tables in schema haven to haven_api;
grant delete on haven.scan_sessions, haven.otp_challenges, haven.idempotency_keys,
                haven.push_tokens, haven.gate_pairing_codes to haven_api;
revoke update on haven.gate_events, haven.audit_log, haven.approvals, haven.hostel_rules from haven_api;
grant usage on all sequences in schema haven to haven_api;

-- RLS on every table: Supabase's anon/authenticated roles get nothing; haven_api gets everything
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'haven' loop
    execute format('alter table haven.%I enable row level security', t);
    execute format('create policy api_all on haven.%I to haven_api using (true) with check (true)', t);
  end loop;
end $$;

-- The API connects as haven_api through Supabase's connection pooler (transaction
-- mode, port 6543); the SSE LISTEN connection uses the direct connection (port 5432),
-- because LISTEN does not work through a transaction pooler. Migrations and jobs run
-- as postgres. The haven schema MUST NOT be added to Supabase's "Exposed schemas"
-- setting (enforced operationally, not in SQL).

-- =============================================================================
-- 11.8 Jobs
--
-- All jobs are idempotent SQL functions, so a double run is harmless. Times are UTC
-- in cron. Each sets the actor to 'system', updates with a status guard, and inserts
-- outbox rows with a dedupe_key, `on conflict do nothing`.
-- =============================================================================

create function haven.rules_for(p_hostel uuid) returns jsonb language sql stable as $$
  select config from haven.hostel_rules where hostel_id = p_hostel order by version desc limit 1
$$;

create function haven.job_expire_walkins() returns void language plpgsql as $$
begin
  perform set_config('haven.actor_type', 'system', true);
  with expired as (
    update haven.visits v
       set status = 'expired', closed_at = now(), cancel_reason = 'host_no_response'
     where v.status = 'pending_host'
       and v.created_at < now() - make_interval(mins => (haven.rules_for(v.hostel_id) ->> 'walk_in_timeout_minutes')::int)
    returning v.id, v.hostel_id, v.host_id)
  insert into haven.notifications (hostel_id, recipient_type, recipient_id, kind, channel,
                                   visit_id, title, body, dedupe_key)
  select hostel_id, 'user', host_id, 'N-WALKIN-EXPIRED', 'push', id,
         'Guest request expired', 'A guest''s request at the gate expired because it wasn''t answered.',
         'walkin-expired:' || id
    from expired
  on conflict (dedupe_key) do nothing;
end $$;

create function haven.job_expire_approved() returns void language plpgsql as $$
begin
  perform set_config('haven.actor_type', 'system', true);
  update haven.visits v
     set status = 'expired', closed_at = now(), cancel_reason = 'window_ended'
   where v.status = 'approved' and v.window_end < now() and v.first_entry_at is null;

  update haven.visits v
     set status = 'completed', closed_at = now(), close_reason = 'window_ended'
   where v.status = 'approved' and v.window_end < now() and v.first_entry_at is not null;

  -- "waive any pending charge" (SDD §11.8) applies to visits that expired (never entered).
  update haven.charges c
     set status = 'waived', waived_at = now(), waive_reason = 'visit expired unentered'
    from haven.visits v
   where c.visit_id = v.id and v.status = 'expired' and v.closed_at >= now() - interval '5 minutes'
     and c.status = 'pending';
end $$;

create function haven.job_flag_overstays() returns void language plpgsql as $$
begin
  perform set_config('haven.actor_type', 'system', true);
  with flagged as (
    update haven.visits v set overstay_since = now()
     where v.status = 'inside' and v.overstay_since is null
       and now() > v.window_end + make_interval(mins => (haven.rules_for(v.hostel_id) ->> 'overstay_grace_minutes')::int)
    returning v.*)
  insert into haven.notifications (hostel_id, recipient_type, recipient_id, recipient_phone, kind,
                                   channel, visit_id, title, body, sms_template_id, dedupe_key)
  select f.hostel_id, 'user', f.host_id, null, 'N-OVERSTAY-HOST', 'push', f.id,
         'Your guest is still inside',
         'Their visit ended at ' || to_char(f.window_end at time zone 'Asia/Kolkata', 'HH12:MI am')
           || '. Ask them to check out at the gate.',
         null, 'overstay-host:' || f.id
    from flagged f
  union all
  select f.hostel_id, 'phone', null, vi.phone, 'N-OVERSTAY-GUEST', 'sms', f.id,
         null, 'Your HAVEN visit has ended. Please check out at the gate.', 'HAVEN_OVERSTAY',
         'overstay-guest:' || f.id
    from flagged f join haven.visitors vi on vi.id = f.visitor_id
   where vi.phone is not null
  on conflict (dedupe_key) do nothing;

  with esc as (
    update haven.visits v set overstay_escalated_at = now()
     where v.status = 'inside' and v.overstay_since < now() - interval '30 minutes'
       and v.overstay_escalated_at is null
    returning v.*)
  insert into haven.notifications (hostel_id, recipient_type, recipient_id, kind, channel,
                                   visit_id, title, body, dedupe_key)
  select e.hostel_id, 'user', ra.user_id, 'N-OVERSTAY-WARDEN', 'push', e.id,
         'Guest overstaying', 'Visit ' || e.code || ' is 30+ minutes past its end time.',
         'overstay-warden:' || e.id || ':' || ra.user_id
    from esc e
    join haven.role_assignments ra
      on ra.hostel_id = e.hostel_id and ra.role = 'warden' and ra.revoked_at is null
  on conflict (dedupe_key) do nothing;
end $$;

create function haven.job_night_sweep() returns void language plpgsql as $$
declare
  h record;
  inside_count int;
begin
  perform set_config('haven.actor_type', 'system', true);
  for h in select id from haven.hostels loop
    select count(*) into inside_count
      from haven.visits v
     where v.hostel_id = h.id and v.status = 'inside' and v.type in ('day','quick_drop');

    if inside_count = 0 then
      insert into haven.notifications (hostel_id, recipient_type, recipient_id, kind, channel,
                                       title, body, dedupe_key)
      select h.id, 'user', ra.user_id, 'N-NIGHT-SWEEP', 'in_app',
             'No day guests inside at 10 pm', 'No day guests inside at 10 pm',
             'night-sweep:' || h.id || ':' || (now() at time zone 'Asia/Kolkata')::date || ':' || ra.user_id
        from haven.role_assignments ra
       where ra.hostel_id = h.id and ra.role = 'warden' and ra.revoked_at is null
      on conflict (dedupe_key) do nothing;
    else
      insert into haven.notifications (hostel_id, recipient_type, recipient_id, kind, channel,
                                       title, body, data, dedupe_key)
      select h.id, 'user', ra.user_id, 'N-NIGHT-SWEEP', 'push',
             inside_count || ' day guests still inside',
             'Tap to see who and whose guests they are.',
             jsonb_build_object('visitIds', (
               select jsonb_agg(v.id) from haven.visits v
                where v.hostel_id = h.id and v.status = 'inside' and v.type in ('day','quick_drop')
             )),
             'night-sweep:' || h.id || ':' || (now() at time zone 'Asia/Kolkata')::date || ':' || ra.user_id
        from haven.role_assignments ra
       where ra.hostel_id = h.id and ra.role = 'warden' and ra.revoked_at is null
      on conflict (dedupe_key) do nothing;

      insert into haven.notifications (hostel_id, recipient_type, recipient_id, kind, channel,
                                       visit_id, title, body, dedupe_key)
      select h.id, 'user', v.host_id, 'N-NIGHT-SWEEP-HOST', 'push', v.id,
             'Your guest is still inside after 10 pm',
             'Day guests must leave. The warden has been informed.',
             'night-sweep-host:' || v.id || ':' || (now() at time zone 'Asia/Kolkata')::date
        from haven.visits v
       where v.hostel_id = h.id and v.status = 'inside' and v.type in ('day','quick_drop')
      on conflict (dedupe_key) do nothing;
    end if;
  end loop;
end $$;

create function haven.job_gate_offline() returns void language plpgsql as $$
begin
  perform set_config('haven.actor_type', 'system', true);
  with offline as (
    update haven.gate_devices d
       set offline_alerted_at = now()
     where d.revoked_at is null
       and d.last_seen_at < now() - interval '5 minutes'
       and (d.offline_alerted_at is null or d.offline_alerted_at < d.last_seen_at)
    returning d.id, d.gate_id, d.label, d.last_seen_at)
  insert into haven.notifications (hostel_id, recipient_type, recipient_id, kind, channel,
                                   title, body, dedupe_key)
  select g.hostel_id, 'user', ra.user_id, 'N-GATE-OFFLINE', 'push',
         'Gate screen offline',
         g.name || ' hasn''t checked in since ' || to_char(o.last_seen_at at time zone 'Asia/Kolkata', 'HH12:MI am') || '.',
         'gate-offline:' || o.id || ':' || o.last_seen_at
    from offline o
    join haven.gates g on g.id = o.gate_id
    join haven.role_assignments ra on ra.hostel_id = g.hostel_id and ra.role = 'warden' and ra.revoked_at is null
  on conflict (dedupe_key) do nothing;
end $$;

-- job_retention(): sets media.delete_after and anonymises rows per SDD §16.5. The API
-- worker (not this job) deletes the actual files from Storage and sets deleted_at —
-- this job only marks what's due and anonymises what the database itself owns.
create function haven.job_retention() returns void language plpgsql as $$
begin
  perform set_config('haven.actor_type', 'system', true);

  -- Gate photos: delete_after = created_at + 180 days (SDD §16.5). Set once, not
  -- re-stamped on every job run.
  update haven.media
     set delete_after = created_at + interval '180 days'
   where kind = 'gate_photo' and delete_after is null and deleted_at is null;

  -- Guest profile photo: deleted 365 days after last_visit_at.
  update haven.media m
     set delete_after = v.last_visit_at + interval '365 days'
    from haven.visitors v
   where m.owner_visitor_id = v.id and m.kind = 'visitor_profile'
     and v.last_visit_at is not null and m.delete_after is null and m.deleted_at is null;

  -- Guest identity: 365 days after last visit with no future visits — anonymise.
  update haven.visitors v
     set full_name = 'Former guest', phone = null, anonymised_at = now()
   where v.anonymised_at is null
     and v.last_visit_at is not null
     and v.last_visit_at < now() - interval '365 days'
     and not exists (
       select 1 from haven.visits x
        where x.visitor_id = v.id and x.window_end > now()
     );

  -- Visit rows: kept 2 years, then invited_name/invited_phone nulled.
  update haven.visits
     set invited_name = null, invited_phone = null
   where created_at < now() - interval '2 years'
     and (invited_name is not null or invited_phone is not null);

  -- Notifications: bodies nulled after 90 days.
  update haven.notifications
     set body = '', title = null
   where created_at < now() - interval '90 days' and body <> '';
end $$;

-- job_expire_sessions(): deletes scan_sessions past expires_at + 1 day, otp_challenges
-- older than 1 day, idempotency_keys older than 24h, used or expired gate_pairing_codes.
create function haven.job_expire_sessions() returns void language plpgsql as $$
begin
  perform set_config('haven.actor_type', 'system', true);
  delete from haven.scan_sessions where expires_at < now() - interval '1 day';
  delete from haven.otp_challenges where created_at < now() - interval '1 day';
  delete from haven.idempotency_keys where created_at < now() - interval '24 hours';
  delete from haven.gate_pairing_codes where used_at is not null or expires_at < now();
end $$;

-- Same guard as the extension above: only register the cron schedule when pg_cron is
-- actually installed. The functions exist either way.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('haven-expire-walkins',  '* * * * *',   $cron$select haven.job_expire_walkins()$cron$);
    perform cron.schedule('haven-expire-approved', '*/5 * * * *', $cron$select haven.job_expire_approved()$cron$);
    perform cron.schedule('haven-overstays',       '*/5 * * * *', $cron$select haven.job_flag_overstays()$cron$);
    perform cron.schedule('haven-night-sweep',     '30 16 * * *', $cron$select haven.job_night_sweep()$cron$);
    perform cron.schedule('haven-gate-offline',    '*/5 * * * *', $cron$select haven.job_gate_offline()$cron$);
    perform cron.schedule('haven-retention',       '30 21 * * *', $cron$select haven.job_retention()$cron$);
    perform cron.schedule('haven-purge-ephemeral', '0 * * * *',   $cron$select haven.job_expire_sessions()$cron$);
  else
    raise notice 'pg_cron not installed — job schedules were not registered. Run the cron.schedule() calls above manually once pg_cron is available (e.g. after supabase start).';
  end if;
end $$;
