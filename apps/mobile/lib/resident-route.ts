import type { MeUserDTO } from '@haven/shared';

/**
 * SDD §13.3: "After sign-in the root layout routes by principal: ... user with warden
 * role → (warden); office → (office); resident → (resident) (or onboarding if not
 * submitted, or R-04 if pending). A user with several roles gets a role switcher in
 * Profile."
 */
export function routeForUser(me: MeUserDTO): string {
  const roles = new Set(me.roles.map((r) => r.r));
  if (roles.has('warden') || roles.has('super_admin')) return '/warden';
  if (roles.has('office')) return '/office/charges';
  return residentRoute(me);
}

/** The resident side only (R-02 → R-03 → R-04 → home), following F7's order. */
export function residentRoute(me: MeUserDTO): string {
  const resident = me.resident;
  if (!me.phoneVerified) return '/phone';
  if (!resident) return '/onboarding';
  if (resident.status === 'pending' && !resident.submittedAt) return '/onboarding';
  if (resident.status === 'verified' || resident.status === 'suspended') return '/home';
  // pending (submitted), rejected (with or without a resubmission left), left.
  return '/pending';
}

/** Shells this user can switch between (Profile / More role switcher). */
export function availableShells(me: MeUserDTO): { path: string; label: string }[] {
  const roles = new Set(me.roles.map((r) => r.r));
  const shells: { path: string; label: string }[] = [];
  if (roles.has('warden') || roles.has('super_admin'))
    shells.push({ path: '/warden', label: 'Warden' });
  if (roles.has('office')) shells.push({ path: '/office/charges', label: 'Office' });
  if (me.resident) shells.push({ path: residentRoute(me), label: 'Resident' });
  return shells;
}
