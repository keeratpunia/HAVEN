import { describe, expect, it } from 'vitest';
import {
  channelForKind,
  defaultScreenForKind,
  isPushData,
  RESIDENT_SCREENS,
  safeScreen,
} from './notifications.js';

const VISIT = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

describe('notification tap routing (SDD §13.7)', () => {
  it('routes N-WALKIN to R-08 and N-ARRIVED to R-09 for that visit', () => {
    expect(defaultScreenForKind('N-WALKIN', VISIT)).toBe(`/walk-in/${VISIT}`);
    expect(defaultScreenForKind('N-ARRIVED', VISIT)).toBe(`/arrival/${VISIT}`);
  });

  it('routes the host update kinds to R-10, charges to R-14, decisions to home', () => {
    for (const kind of ['N-LEFT', 'N-OVERSTAY-HOST', 'N-WALKIN-EXPIRED', 'N-OVERNIGHT-DECIDED']) {
      expect(defaultScreenForKind(kind, VISIT)).toBe(RESIDENT_SCREENS.visit(VISIT));
    }
    expect(defaultScreenForKind('N-CHARGE', null)).toBe('/charges');
    expect(defaultScreenForKind('N-RES-DECIDED', null)).toBe('/home');
  });

  it('routes disputes to the warden visit screen (W-05)', () => {
    expect(defaultScreenForKind('N-DISPUTE', VISIT)).toBe(`/warden/visits/${VISIT}`);
  });

  it('puts each kind on its SDD §15.1 Android channel', () => {
    expect(channelForKind('N-WALKIN')).toBe('approvals');
    expect(channelForKind('N-CONFIRM-LOCATION')).toBe('approvals');
    expect(channelForKind('N-DISPUTE')).toBe('alerts');
    expect(channelForKind('N-OVERSTAY-HOST')).toBe('alerts');
    expect(channelForKind('N-ARRIVED')).toBe('updates');
    expect(channelForKind('N-LEFT')).toBe('updates');
  });

  it('only lets known routes through safeScreen', () => {
    expect(safeScreen(`/walk-in/${VISIT}`)).toBe(`/walk-in/${VISIT}`);
    expect(safeScreen('/charges')).toBe('/charges');
    expect(safeScreen('https://evil.example/phish')).toBe('/home');
    expect(safeScreen('/walk-in/not-a-uuid')).toBe('/home');
    expect(safeScreen('/visit/../../admin')).toBe('/home');
    expect(safeScreen(undefined)).toBe('/home');
  });

  it('validates the §15.1 payload shape', () => {
    expect(
      isPushData({ kind: 'N-WALKIN', notificationId: 'n1', visitId: VISIT, screen: '/home' }),
    ).toBe(true);
    expect(isPushData({ kind: 'N-WALKIN', screen: '/home' })).toBe(false);
    expect(isPushData(null)).toBe(false);
  });
});
