import { definePolicy } from '../auth/policy.js';
import { hasHostelRole, isSuperAdmin } from '../auth/principal.js';
import type { Principal } from '../auth/principal.js';

/**
 * `authorize()` rules for /v1/admin and /v1/stream (SDD §3.4), transcribed from the
 * SDD §3.3 permission matrix. Each capability lists exactly the roles the matrix gives
 * it; where the matrix and §12.9's "Role" column differ, the narrower one wins
 * (docs/DECISIONS.md DEC-014). The resource is always the hostel named by
 * `X-Hostel-Id` — every handler also checks the record it touches belongs to that hostel.
 */
export interface HostelResource {
  hostelId: string;
}

type Role = 'warden' | 'office' | 'super_admin';

function roles(...allowed: Role[]) {
  return (p: Principal | null, r: HostelResource) => hasHostelRole(p, r.hostelId, allowed);
}

/** Every capability in /v1/admin, with the §3.3 row it implements. */
export const ADMIN_POLICIES: Record<string, (p: Principal | null, r: HostelResource) => boolean> = {
  // "See visits": warden Hostel, super admin All (office: charges only).
  'admin.visits.read': roles('warden', 'super_admin'),
  // Dashboard / inside now / roll call / approvals queue / reports — §12.9 Role: Warden.
  'admin.dashboard.read': roles('warden'),
  'admin.emergency.read': roles('warden'),
  'admin.approvals.read': roles('warden'),
  'admin.reports.read': roles('warden'),
  // "Force check-out a guest": warden Hostel. Resolve dispute (F9): warden.
  'admin.visits.force_checkout': roles('warden'),
  'admin.visits.resolve_dispute': roles('warden'),
  // "Verify residents": warden Hostel, super admin All.
  'admin.residents.read': roles('warden', 'super_admin'),
  'admin.residents.verify': roles('warden', 'super_admin'),
  // "Ban guests / suspend hosts": warden Hostel, super admin All.
  'admin.residents.suspend': roles('warden', 'super_admin'),
  'admin.bans.read': roles('warden', 'super_admin'),
  'admin.bans.write': roles('warden', 'super_admin'),
  // FR-07: "Warden can ... mark a resident as left" (no matrix row; warden only).
  'admin.residents.mark_left': roles('warden'),
  // "Edit rules": warden Hostel, super admin All.
  'admin.rules.read': roles('warden', 'super_admin'),
  'admin.rules.write': roles('warden', 'super_admin'),
  // "Pair / revoke gate devices; set gate location": warden Hostel, super admin All.
  'admin.gates.read': roles('warden', 'super_admin'),
  'admin.gates.write': roles('warden', 'super_admin'),
  // DEC-028, staging only: set the gate to the admin's current position (demo anywhere).
  'admin.gates.test_location': (p) => isSuperAdmin(p),
  // "Invite office staff": warden Hostel. FR-07 deactivate: warden (office staff, DEC-014).
  'admin.staff.read': roles('warden'),
  'admin.staff.invite_office': roles('warden'),
  'admin.staff.deactivate': roles('warden'),
  // "Invite wardens; create hostels": super admin only.
  'admin.staff.invite_warden': (p) => isSuperAdmin(p),
  'admin.hostels.create': (p) => isSuperAdmin(p),
  // Charges: office "Hostel (charges view only)" + "(confirm, mark paid)"; warden all
  // actions; "Create manual fine": warden. Super admin: "--".
  'admin.charges.read': roles('warden', 'office'),
  'admin.charges.confirm': roles('warden', 'office'),
  'admin.charges.mark_paid': roles('warden', 'office'),
  'admin.charges.waive': roles('warden'),
  'admin.charges.create_fine': roles('warden'),
  // "View audit log": warden Hostel, super admin All.
  'admin.audit.read': roles('warden', 'super_admin'),
  // SSE (§9.9, §12.9): warden and office.
  'stream.subscribe': roles('warden', 'office'),
};

let registered = false;

export function registerAdminPolicies(): void {
  if (registered) return;
  registered = true;
  for (const [action, rule] of Object.entries(ADMIN_POLICIES)) {
    definePolicy<HostelResource>(action, rule);
  }
}

export function __resetAdminPoliciesForTests(): void {
  registered = false;
}
