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
  status: string;
  origin: VisitOrigin;
  zone: Zone;
  window_start: ColumnType<Date, string, string>;
  window_end: ColumnType<Date, string, string>;
  nights: Generated<number>;
  invite_token_hash: Buffer | null;
  rules_version: number;
  created_by_type: ActorType;
  created_by_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface Database {
  'haven.hostels': HostelsTable;
  'haven.rooms': RoomsTable;
  'haven.users': UsersTable;
  'haven.role_assignments': RoleAssignmentsTable;
  'haven.staff_invites': StaffInvitesTable;
  'haven.residents': ResidentsTable;
  'haven.visitors': VisitorsTable;
  'haven.otp_challenges': OtpChallengesTable;
  'haven.sessions': SessionsTable;
  'haven.visits': VisitsTable;
}
