import type { MeUserDTO } from '@haven/shared';

/**
 * SDD §13.3: "resident → (resident) (or onboarding if not submitted, or R-04 if
 * pending)", following F7's order: R-02 verify phone → R-03 onboarding → R-04 waiting.
 */
export function routeForUser(me: MeUserDTO): string {
  const resident = me.resident;
  if (!me.phoneVerified) return '/phone';
  if (!resident) return '/onboarding';
  if (resident.status === 'pending' && !resident.submittedAt) return '/onboarding';
  if (resident.status === 'verified' || resident.status === 'suspended') return '/home';
  // pending (submitted), rejected (with or without a resubmission left), left.
  return '/pending';
}
