/**
 * Which deployment this build talks to (SDD §20.3 `EXPO_PUBLIC_APP_ENV`). Public by
 * design; the API enforces everything it implies.
 *
 * `staging` is the Phase 1 test version (DEC-026, DEC-028): dummy data, test phone
 * numbers only, a "TEST VERSION" badge on every screen, and sign-in by test number for
 * residents and staff.
 */
export const APP_ENV = (process.env.EXPO_PUBLIC_APP_ENV ?? 'local') as
  'local' | 'staging' | 'production';

export const IS_TEST_VERSION = APP_ENV === 'staging';
