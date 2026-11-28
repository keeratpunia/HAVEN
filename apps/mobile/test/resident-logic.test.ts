import type { MeUserDTO, VisitDTO } from '@haven/shared';
import { handleNotificationTap } from '../lib/notification-routing';
import { availableShells, routeForUser } from '../lib/resident-route';
import { needsHost, screenForVisit } from '../lib/visit-screen';
import { newActionKey } from '../lib/action-key';

const VISIT = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

describe('notification tap routing (SDD §13.7)', () => {
  it('opens the payload screen and marks the notification opened', async () => {
    const navigate = jest.fn();
    const markOpened = jest.fn().mockResolvedValue(undefined);
    const path = await handleNotificationTap(
      { kind: 'N-WALKIN', notificationId: 'n1', visitId: VISIT, screen: `/walk-in/${VISIT}` },
      { navigate, markOpened },
    );
    expect(path).toBe(`/walk-in/${VISIT}`);
    expect(navigate).toHaveBeenCalledWith(`/walk-in/${VISIT}`);
    expect(markOpened).toHaveBeenCalledWith('n1');
  });

  it('routes an arrival to R-09', async () => {
    const navigate = jest.fn();
    await handleNotificationTap(
      { kind: 'N-ARRIVED', notificationId: 'n2', visitId: VISIT, screen: `/arrival/${VISIT}` },
      { navigate, markOpened: jest.fn().mockResolvedValue(undefined) },
    );
    expect(navigate).toHaveBeenCalledWith(`/arrival/${VISIT}`);
  });

  it('never navigates to an unknown or hostile screen', async () => {
    const navigate = jest.fn();
    const markOpened = jest.fn().mockResolvedValue(undefined);
    await handleNotificationTap(
      { kind: 'N-WALKIN', notificationId: 'n3', screen: 'https://evil.example/login' },
      { navigate, markOpened },
    );
    expect(navigate).toHaveBeenCalledWith('/home');
    await handleNotificationTap({ nonsense: true }, { navigate, markOpened });
    expect(navigate).toHaveBeenLastCalledWith('/home');
  });

  it('still navigates when marking opened fails (offline)', async () => {
    const navigate = jest.fn();
    await handleNotificationTap(
      { kind: 'N-LEFT', notificationId: 'n4', visitId: VISIT, screen: `/visit/${VISIT}` },
      { navigate, markOpened: jest.fn().mockRejectedValue(new Error('offline')) },
    );
    expect(navigate).toHaveBeenCalledWith(`/visit/${VISIT}`);
  });
});

function me(
  overrides: Partial<MeUserDTO> = {},
  resident: Partial<NonNullable<MeUserDTO['resident']>> | null = {},
): MeUserDTO {
  return {
    type: 'user',
    id: 'u1',
    fullName: 'Priya Sharma',
    email: 'p@x.test',
    phone: '+919999900001',
    phoneVerified: true,
    roles: [],
    residentStatus: resident ? (resident.status ?? 'verified') : null,
    resident: resident
      ? {
          hostelId: 'h',
          hostelName: 'Florence Nightingale',
          room: '214',
          status: 'verified',
          submittedAt: '2026-10-01T00:00:00.000Z',
          hasIdCard: true,
          hasSelfie: true,
          rejectionReason: null,
          canResubmit: false,
          hostingSuspendedUntil: null,
          ...resident,
        }
      : null,
    ...overrides,
  };
}

describe('routing by principal (SDD §13.3, F7)', () => {
  it('follows R-02 → R-03 → R-04 → home', () => {
    expect(routeForUser(me({ phoneVerified: false }, null))).toBe('/phone');
    expect(routeForUser(me({}, null))).toBe('/onboarding');
    expect(routeForUser(me({}, { status: 'pending', submittedAt: null }))).toBe('/onboarding');
    expect(routeForUser(me({}, { status: 'pending' }))).toBe('/pending');
    expect(routeForUser(me({}, { status: 'rejected', canResubmit: true }))).toBe('/pending');
    expect(routeForUser(me({}, { status: 'verified' }))).toBe('/home');
    expect(routeForUser(me({}, { status: 'suspended' }))).toBe('/home');
    expect(routeForUser(me({}, { status: 'left' }))).toBe('/pending');
  });
});

describe('which screen a visit card opens', () => {
  const base = {
    id: VISIT,
    allowedActions: [] as VisitDTO['allowedActions'],
    awaitingHostConfirmation: false,
  };
  it('pending walk-in → R-08, arrival to confirm (F3) → R-09, else R-10', () => {
    expect(screenForVisit({ ...base, status: 'pending_host' })).toBe(`/walk-in/${VISIT}`);
    expect(screenForVisit({ ...base, status: 'approved', awaitingHostConfirmation: true })).toBe(
      `/arrival/${VISIT}`,
    );
    // DEC-033: a guest who is already inside has nothing to confirm or report.
    expect(screenForVisit({ ...base, status: 'inside', allowedActions: ['mark_left'] })).toBe(
      `/visit/${VISIT}`,
    );
    expect(needsHost({ status: 'pending_host', awaitingHostConfirmation: false })).toBe(true);
    expect(needsHost({ status: 'approved', awaitingHostConfirmation: false })).toBe(false);
  });
});

describe('Idempotency-Key generation (SDD §9.12)', () => {
  it('produces distinct v4 UUIDs', () => {
    const a = newActionKey();
    const b = newActionKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe('staff routing and the role switcher (SDD §13.3)', () => {
  it('sends wardens and super admins to the warden shell, office to O-01', () => {
    expect(
      routeForUser(me({ roles: [{ h: 'h1', r: 'warden' }], phoneVerified: false }, null)),
    ).toBe('/warden');
    expect(routeForUser(me({ roles: [{ h: '*', r: 'super_admin' }] }, null))).toBe('/warden');
    expect(routeForUser(me({ roles: [{ h: 'h1', r: 'office' }] }, null))).toBe('/office/charges');
  });

  it('offers every shell a multi-role user can open', () => {
    const both = me({ roles: [{ h: 'h1', r: 'office' }] }, { status: 'verified' });
    expect(availableShells(both).map((s) => s.label)).toEqual(['Office', 'Resident']);
    expect(availableShells(me({}, { status: 'verified' })).map((s) => s.label)).toEqual([
      'Resident',
    ]);
  });
});
