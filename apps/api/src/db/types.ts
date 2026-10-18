import type { ColumnType, Generated } from 'kysely';

/**
 * Hand-written Kysely table types for the tables the authentication module queries,
 * transcribed directly from `supabase/migrations/20261001000001_init.sql` (the single
 * source of truth for column names/types/nullability).
 *
 * DEC-007 records why this is hand-written rather than `kysely-codegen`-generated: this
 * sandbox has no reliable Docker/Supabase-local connection to introspect (see
 * DEC-004/DEC-005 for the same constraint hit earlier), and `kysely-codegen` was always
 * deferred to "the milestone that first writes a typed query" — this one. Only the
 * tables this milestone's code actually queries are typed; a later milestone that
 * queries `visits`, `gate_events`, `notifications`, etc. in full should replace this
 * file wholesale with a `kysely-codegen` run against a real database, not keep hand-
 * extending it table by table.
 */

export type StaffRole = 'super_admin' | 'warden' | 'office';
export type ResidentStatus = 'pending' | 'verified' | 'rejected' | 'suspended' | 'left';
export type Gender = 'female' | 'male' | 'undisclosed';
export type OtpPurpose = 'guest_login' | 'phone_verify';
export type PrincipalType = 'user' | 'visitor';
export type VisitType = 'quick_drop' | 'day' | 'overnight_room' | 'guest_room';
export type VisitOrigin = 'invite' | 'walk_in' | 'host_assisted' | 'overnight_request';
export type Zone = 'gate' | 'visitors_room' | 'room' | 'guest_room';
export type ActorType = 'user' | 'visitor' | 'gate_device' | 'system';
export type VisitStatusDb =
  | 'pending_host'
  | 'pending_warden'
  | 'approved'
  | 'inside'
  | 'completed'
  | 'rejected'
  | 'expired'
  | 'cancelled';
export type GateEventKind = 'entry' | 'exit' | 'entry_denied';
export type GpsFailure =
  'outside_geofence' | 'low_accuracy' | 'stale_fix' | 'no_location' | 'gate_not_configured';
export type ConsumedAction = 'check_in' | 'check_out' | 'walk_in' | 'host_assisted';
export type MediaKind = 'visitor_profile' | 'gate_photo' | 'resident_id_card' | 'resident_selfie';
export type ApproverRole = 'host' | 'warden';
export type Decision = 'approved' | 'rejected';
export type ChargeKind = 'overnight_room' | 'guest_room' | 'fine';
export type ChargeStatus = 'pending' | 'confirmed' | 'paid' | 'waived';
export type NotifChannel = 'push' | 'sms' | 'in_app';
export type NotifStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';

interface HostelsTable {
  id: Generated<string>;
  code: string;
  name: string;
  gender_served: Gender;
  timezone: Generated<string>;
  created_at: Generated<Date>;
}

interface RoomsTable {
  id: Generated<string>;
  hostel_id: string;
  number: string;
  floor: number | null;
  created_at: Generated<Date>;
}

interface UsersTable {
  id: Generated<string>;
  google_sub: string;
  email: string;
  full_name: string;
  phone: string | null;
  phone_verified_at: ColumnType<Date | null, string | null | undefined, string | null>;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  last_login_at: ColumnType<Date | null, string | null | undefined, string | null>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

interface RoleAssignmentsTable {
  id: Generated<string>;
  user_id: string;
  hostel_id: string | null;
  role: StaffRole;
  granted_by: string | null;
  granted_at: Generated<Date>;
  revoked_at: ColumnType<Date | null, string | null | undefined, string | null>;
  revoked_by: string | null;
}

interface StaffInvitesTable {
  id: Generated<string>;
  hostel_id: string | null;
  role: StaffRole;
  email: string;
  token_hash: Buffer;
  invited_by: string | null;
  expires_at: ColumnType<Date, string, string>;
  accepted_by: string | null;
  accepted_at: ColumnType<Date | null, string | null | undefined, string | null>;
  revoked_at: ColumnType<Date | null, string | null | undefined, string | null>;
  created_at: Generated<Date>;
}

interface ResidentsTable {
  user_id: string;
  hostel_id: string;
  claimed_room: string;
  room_id: string | null;
  status: Generated<ResidentStatus>;
  id_card_media_id: string | null;
  selfie_media_id: string | null;
  submitted_at: ColumnType<Date | null, string | null | undefined, string | null>;
  decided_by: string | null;
  decided_at: ColumnType<Date | null, string | null | undefined, string | null>;
  rejection_reason: string | null;
  resubmissions: Generated<number>;
  hosting_suspended_until: ColumnType<Date | null, string | null | undefined, string | null>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

interface VisitorsTable {
  id: Generated<string>;
  phone: string | null;
  full_name: string;
  gender: Gender;
  is_adult_confirmed: Generated<boolean>;
  profile_media_id: string | null;
  consent_version: string | null;
  consent_at: ColumnType<Date | null, string | null | undefined, string | null>;
  created_by_host_id: string | null;
  last_visit_at: ColumnType<Date | null, string | null | undefined, string | null>;
  anonymised_at: ColumnType<Date | null, string | null | undefined, string | null>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

interface OtpChallengesTable {
  id: Generated<string>;
  phone: string;
  purpose: OtpPurpose;
  code_hash: Buffer;
  attempts: Generated<number>;
  expires_at: ColumnType<Date, string, string>;
  consumed_at: ColumnType<Date | null, string | null | undefined, string | null>;
  ip: string | null;
  created_at: Generated<Date>;
}

interface SessionsTable {
  id: Generated<string>;
  principal_type: PrincipalType;
  principal_id: string;
  refresh_hash: Buffer;
  previous_refresh_hash: Buffer | null;
  client: 'web' | 'native';
  user_agent: string | null;
  ip: string | null;
  created_at: Generated<Date>;
  last_used_at: Generated<Date>;
  expires_at: ColumnType<Date, string, string>;
  revoked_at: ColumnType<Date | null, string | null | undefined, string | null>;
  revoke_reason: string | null;
}

interface BansTable {
  id: Generated<string>;
  visitor_id: string;
  hostel_id: string | null;
  reason: string;
  starts_at: Generated<Date>;
  ends_at: ColumnType<Date | null, string | null | undefined, string | null>;
  created_by: string;
  created_at: Generated<Date>;
  lifted_at: ColumnType<Date | null, string | null | undefined, string | null>;
  lifted_by: string | null;
  lift_reason: string | null;
}

interface VisitsTable {
  id: Generated<string>;
  code: string;
  hostel_id: string;
  host_id: string;
  visitor_id: string | null;
  invited_name: string | null;
  invited_phone: string | null;
  invited_gender: Gender | null;
  type: VisitType;
  status: VisitStatusDb;
  origin: VisitOrigin;
  zone: Zone;
  window_start: ColumnType<Date, string, string>;
  window_end: ColumnType<Date, string, string>;
  nights: Generated<number>;
  invite_token_hash: Buffer | null;
  rules_version: number;
  location_unverified: Generated<boolean>;
  exit_location_unverified: Generated<boolean>;
  overstay_since: ColumnType<Date | null, string | null | undefined, string | null>;
  overstay_escalated_at: ColumnType<Date | null, string | null | undefined, string | null>;
  host_confirmed_at: ColumnType<Date | null, string | null | undefined, string | null>;
  host_disputed_at: ColumnType<Date | null, string | null | undefined, string | null>;
  dispute_resolved_at: ColumnType<Date | null, string | null | undefined, string | null>;
  dispute_resolved_by: string | null;
  first_entry_at: ColumnType<Date | null, string | null | undefined, string | null>;
  last_entry_at: ColumnType<Date | null, string | null | undefined, string | null>;
  last_exit_at: ColumnType<Date | null, string | null | undefined, string | null>;
  closed_at: ColumnType<Date | null, string | null | undefined, string | null>;
  close_reason: 'checked_out' | 'host_marked_left' | 'forced' | 'window_ended' | null;
  cancel_reason: string | null;
  created_by_type: ActorType;
  created_by_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

interface ApprovalsTable {
  id: Generated<string>;
  visit_id: string;
  approver_id: string;
  approver_role: ApproverRole;
  decision: Decision;
  reason: string | null;
  adjusted_window_end: ColumnType<Date | null, string | null | undefined, string | null>;
  decided_at: Generated<Date>;
}

interface GatesTable {
  id: Generated<string>;
  hostel_id: string;
  code: string;
  name: Generated<string>;
  lat: number | null;
  lng: number | null;
  radius_m: Generated<number>;
  max_accuracy_m: Generated<number>;
  secret_enc: Buffer;
  secret_version: Generated<number>;
  prev_secret_enc: Buffer | null;
  secret_rotated_at: ColumnType<Date | null, string | null | undefined, string | null>;
  location_set_by: string | null;
  location_set_at: ColumnType<Date | null, string | null | undefined, string | null>;
  is_active: Generated<boolean>;
}

interface GateDevicesTable {
  id: Generated<string>;
  gate_id: string;
  label: Generated<string>;
  token_hash: Buffer;
  paired_by: string;
  paired_at: Generated<Date>;
  last_seen_at: ColumnType<Date | null, string | null | undefined, string | null>;
  last_ip: string | null;
  user_agent: string | null;
  clock_offset_ms: number | null;
  offline_alerted_at: ColumnType<Date | null, string | null | undefined, string | null>;
  revoked_at: ColumnType<Date | null, string | null | undefined, string | null>;
  revoked_by: string | null;
}

interface GatePairingCodesTable {
  code_hash: Buffer;
  gate_id: string;
  created_by: string;
  expires_at: ColumnType<Date, string, string>;
  used_at: ColumnType<Date | null, string | null | undefined, string | null>;
  device_id: string | null;
}

interface ScanSessionsTable {
  id: Generated<string>;
  gate_id: string;
  client_nonce_hash: Buffer;
  token_step: string | number;
  token_age_steps: number;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  captured_at: ColumnType<Date | null, string | null | undefined, string | null>;
  distance_m: number | null;
  gps_ok: boolean;
  gps_failure: GpsFailure | null;
  location_attempts: Generated<number>;
  visitor_id: string | null;
  host_user_id: string | null;
  photo_media_id: string | null;
  ip: string | null;
  user_agent: string | null;
  consumed_at: ColumnType<Date | null, string | null | undefined, string | null>;
  consumed_action: ConsumedAction | null;
  visit_id: string | null;
  expires_at: ColumnType<Date, string, string>;
  created_at: Generated<Date>;
}

interface MediaTable {
  id: Generated<string>;
  kind: MediaKind;
  bucket: string;
  path: string;
  sha256: Buffer;
  bytes: number;
  owner_user_id: string | null;
  owner_visitor_id: string | null;
  delete_after: ColumnType<Date | null, string | null | undefined, string | null>;
  deleted_at: ColumnType<Date | null, string | null | undefined, string | null>;
  created_at: Generated<Date>;
}

interface GateEventsTable {
  id: Generated<string>;
  visit_id: string;
  hostel_id: string;
  gate_id: string;
  scan_session_id: string | null;
  kind: GateEventKind;
  actor_type: ActorType;
  actor_id: string | null;
  photo_media_id: string | null;
  location_verified: boolean;
  distance_m: number | null;
  accuracy_m: number | null;
  rule_codes: Generated<string[]>;
  at: Generated<Date>;
}

interface ChargesTable {
  id: Generated<string>;
  hostel_id: string;
  resident_id: string;
  visit_id: string | null;
  kind: ChargeKind;
  units: number | null;
  unit_price_inr: number | null;
  amount_inr: number;
  description: string;
  status: Generated<ChargeStatus>;
  created_by: string | null;
  created_at: Generated<Date>;
  confirmed_by: string | null;
  confirmed_at: ColumnType<Date | null, string | null | undefined, string | null>;
  paid_recorded_by: string | null;
  paid_at: ColumnType<Date | null, string | null | undefined, string | null>;
  receipt_no: string | null;
  waived_by: string | null;
  waived_at: ColumnType<Date | null, string | null | undefined, string | null>;
  waive_reason: string | null;
}

interface NotificationsTable {
  id: Generated<string>;
  hostel_id: string | null;
  recipient_type: 'user' | 'visitor' | 'phone';
  recipient_id: string | null;
  recipient_phone: string | null;
  kind: string;
  channel: NotifChannel;
  visit_id: string | null;
  title: string | null;
  body: string;
  data: Generated<Record<string, unknown>>;
  sms_template_id: string | null;
  status: Generated<NotifStatus>;
  attempts: Generated<number>;
  next_attempt_at: Generated<Date>;
  cancel_if_opened: string | null;
  dedupe_key: string | null;
  provider_ref: string | null;
  last_error: string | null;
  sent_at: ColumnType<Date | null, string | null | undefined, string | null>;
  opened_at: ColumnType<Date | null, string | null | undefined, string | null>;
  created_at: Generated<Date>;
}

interface PushTokensTable {
  id: Generated<string>;
  user_id: string;
  expo_token: string;
  platform: 'android' | 'ios' | 'web';
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  disabled_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

interface HostelRulesTable {
  id: Generated<string>;
  hostel_id: string;
  version: number;
  config: unknown;
  created_by: string | null;
  created_at: Generated<Date>;
}

interface AuditLogTable {
  id: Generated<number>;
  at: Generated<Date>;
  actor_type: ActorType;
  actor_id: string | null;
  hostel_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  request_id: string | null;
}

interface IdempotencyKeysTable {
  key: string;
  principal_id: string;
  route: string;
  status_code: number;
  response: unknown;
  created_at: Generated<Date>;
}

export interface Database {
  'haven.hostels': HostelsTable;
  'haven.rooms': RoomsTable;
  'haven.users': UsersTable;
  'haven.role_assignments': RoleAssignmentsTable;
  'haven.staff_invites': StaffInvitesTable;
  'haven.residents': ResidentsTable;
  'haven.visitors': VisitorsTable;
  'haven.bans': BansTable;
  'haven.otp_challenges': OtpChallengesTable;
  'haven.sessions': SessionsTable;
  'haven.visits': VisitsTable;
  'haven.approvals': ApprovalsTable;
  'haven.gates': GatesTable;
  'haven.gate_devices': GateDevicesTable;
  'haven.gate_pairing_codes': GatePairingCodesTable;
  'haven.scan_sessions': ScanSessionsTable;
  'haven.media': MediaTable;
  'haven.gate_events': GateEventsTable;
  'haven.charges': ChargesTable;
  'haven.notifications': NotificationsTable;
  'haven.push_tokens': PushTokensTable;
  'haven.idempotency_keys': IdempotencyKeysTable;
  'haven.audit_log': AuditLogTable;
  'haven.hostel_rules': HostelRulesTable;
}
