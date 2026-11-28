/**
 * W-11 in plain words (DEC-032). The audit log stores machine names: the database trigger
 * writes "<table>.<insert|update|delete>" (SDD §11.6) and the API writes "admin.…" and
 * "read.…" actions. The warden reads sentences.
 */

const ACTIONS: Record<string, string> = {
  'read.visit': 'Viewed a visit with photos',
  'read.emergency': 'Opened the emergency roll call',
  'read.export': 'Exported visits (CSV)',
  'read.resident_documents': "Viewed residents' photos",
  'admin.residents.verify': 'Verified a resident',
  'admin.residents.reject': 'Rejected a resident',
  'admin.residents.suspend': "Suspended a resident's guest privileges",
  'admin.residents.unsuspend': 'Lifted a suspension',
  'admin.residents.mark_left': 'Marked a resident as left',
  'admin.media.delete_id_card': 'Deleted an ID card photo after the decision',
  'admin.visits.force_checkout': 'Checked a guest out',
  'admin.visits.resolve_dispute': 'Resolved a "Not my guest" report',
  'admin.bans.create': 'Banned a guest',
  'admin.bans.lift': 'Lifted a ban',
  'admin.rules.publish': 'Published new rules',
  'admin.gates.set_location': 'Set the gate location',
  'admin.gates.set_test_location': 'Moved the gate to their position',
  'admin.gates.create_pairing_code': 'Made a gate pairing code',
  'admin.gates.revoke_device': 'Removed a gate screen',
  'admin.staff.invite_office': 'Invited office staff',
  'admin.staff.invite_warden': 'Invited a warden',
  'admin.staff.deactivate': 'Deactivated a staff member',
  'admin.hostels.create': 'Created a hostel',
  'admin.charges.confirm': 'Confirmed a charge',
  'admin.charges.mark_paid': 'Marked a charge paid',
  'admin.charges.waive': 'Waived a charge',
  'admin.charges.create_fine': 'Added a fine',
};

const THING: Record<string, string> = {
  visits: 'Visit',
  residents: 'Resident',
  charges: 'Charge',
  bans: 'Ban',
  gates: 'Gate',
  gate_devices: 'Gate screen',
  staff_invites: 'Staff invite',
  role_assignments: 'Staff role',
  users: 'Account',
  hostel_rules: 'Rules',
  media: 'Photo',
};

const CHANGE: Record<string, string> = {
  insert: 'created',
  update: 'changed',
  delete: 'removed',
};

export function describeAuditAction(action: string, entity: string): string {
  const known = ACTIONS[action];
  if (known) return known;
  const [table, op] = action.split('.');
  if (table && op && CHANGE[op])
    return `${THING[table] ?? THING[entity] ?? 'Record'} ${CHANGE[op]}`;
  return action.replace(/^(admin|read)\./, '').replace(/[._]/g, ' ');
}

/** W-11 filter chips: entity names as the API takes them (comma = several). */
export const AUDIT_ENTITIES: { value: string; label: string }[] = [
  { value: '', label: 'Everything' },
  { value: 'visits', label: 'Visits' },
  { value: 'residents', label: 'Residents' },
  { value: 'charges', label: 'Charges' },
  { value: 'bans', label: 'Bans' },
  { value: 'gates,gate_devices', label: 'Gates' },
  { value: 'hostel_rules', label: 'Rules' },
  { value: 'staff_invites,role_assignments,users', label: 'Staff' },
];
