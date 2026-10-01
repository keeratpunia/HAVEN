import { describe, expect, it } from 'vitest';
import { AppError } from '../lib/errors.js';
import {
  assertTransition,
  findTransition,
  isReachable,
  VISIT_STATUSES,
  VISIT_TRANSITIONS,
  type VisitStatus,
  type VisitTrigger,
} from './stateMachine.js';

const ALL_TRIGGERS: VisitTrigger[] = [
  'pre_invite_created',
  'walk_in_requested',
  'overnight_requested',
  'host_assisted_entry',
  'host_approves_walk_in',
  'host_rejects_walk_in',
  'walk_in_timeout',
  'guest_cancels_walk_in',
  'warden_approves_overnight',
  'warden_rejects_overnight',
  'host_cancels_overnight_request',
  'check_in',
  'cancel_approved',
  'window_expired_no_entry',
  'window_ended_after_entry',
  'check_out_step_out',
  'check_out_final',
  'host_marks_guest_left',
  'warden_forces_checkout',
];

describe('VISIT_TRANSITIONS (SDD §7.1 — the literal table)', () => {
  it('has exactly 19 rows: 4 creation rows + 15 update rows', () => {
    expect(VISIT_TRANSITIONS).toHaveLength(19);
    expect(VISIT_TRANSITIONS.filter((t) => t.from === 'new')).toHaveLength(4);
    expect(VISIT_TRANSITIONS.filter((t) => t.from !== 'new')).toHaveLength(15);
  });

  it('every trigger in the table is unique (one row per trigger name)', () => {
    const triggers = VISIT_TRANSITIONS.map((t) => t.trigger);
    expect(new Set(triggers).size).toBe(triggers.length);
  });

  it('every one of the 8 visit_status values appears as a `to`', () => {
    const toStatuses = new Set(VISIT_TRANSITIONS.map((t) => t.to));
    for (const status of VISIT_STATUSES) {
      expect(toStatuses.has(status)).toBe(true);
    }
  });

  it('VISIT_STATUSES has exactly the 8 SDD §7 values, no invented states', () => {
    expect(VISIT_STATUSES).toEqual([
      'pending_host',
      'pending_warden',
      'approved',
      'inside',
      'completed',
      'rejected',
      'expired',
      'cancelled',
    ]);
  });

  // The SDD's own worked table, transcribed row for row — if any row here doesn't
  // match VISIT_TRANSITIONS, the implementation has drifted from §7.1.
  it.each([
    ['new', 'approved', 'pre_invite_created'],
    ['new', 'pending_host', 'walk_in_requested'],
    ['new', 'pending_warden', 'overnight_requested'],
    ['new', 'inside', 'host_assisted_entry'],
    ['pending_host', 'inside', 'host_approves_walk_in'],
    ['pending_host', 'rejected', 'host_rejects_walk_in'],
    ['pending_host', 'expired', 'walk_in_timeout'],
    ['pending_host', 'cancelled', 'guest_cancels_walk_in'],
    ['pending_warden', 'approved', 'warden_approves_overnight'],
    ['pending_warden', 'rejected', 'warden_rejects_overnight'],
    ['pending_warden', 'cancelled', 'host_cancels_overnight_request'],
    ['approved', 'inside', 'check_in'],
    ['approved', 'cancelled', 'cancel_approved'],
    ['approved', 'expired', 'window_expired_no_entry'],
    ['approved', 'completed', 'window_ended_after_entry'],
    ['inside', 'approved', 'check_out_step_out'],
    ['inside', 'completed', 'check_out_final'],
    ['inside', 'completed', 'host_marks_guest_left'],
    ['inside', 'completed', 'warden_forces_checkout'],
  ] as const)('%s --(%s)--> %s is a listed transition', (from, to, trigger) => {
    expect(findTransition(from, trigger)).toEqual({ from, to, trigger });
  });
});

describe('assertTransition — exhaustive matrix over every (from, trigger) pair', () => {
  const froms: (VisitStatus | 'new')[] = ['new', ...VISIT_STATUSES];

  for (const from of froms) {
    for (const trigger of ALL_TRIGGERS) {
      const listed = VISIT_TRANSITIONS.find((t) => t.from === from && t.trigger === trigger);
      const label = `${from} --(${trigger})-->`;

      if (listed) {
        it(`${label} ${listed.to} succeeds (listed in SDD §7.1)`, () => {
          expect(assertTransition(from, trigger)).toEqual(listed);
        });
      } else {
        it(`${label} ??? throws INVALID_TRANSITION 409 (not listed in SDD §7.1)`, () => {
          try {
            assertTransition(from, trigger);
            expect.fail(`expected assertTransition(${from}, ${trigger}) to throw`);
          } catch (err) {
            expect(err).toBeInstanceOf(AppError);
            expect((err as AppError).code).toBe('INVALID_TRANSITION');
            expect((err as AppError).httpStatus).toBe(409);
          }
        });
      }
    }
  }
});

describe('isReachable — every (from, to) pair not in the table is unreachable', () => {
  const froms: (VisitStatus | 'new')[] = ['new', ...VISIT_STATUSES];

  for (const from of froms) {
    for (const to of VISIT_STATUSES) {
      const expected = VISIT_TRANSITIONS.some((t) => t.from === from && t.to === to);
      it(`isReachable(${from}, ${to}) === ${expected}`, () => {
        expect(isReachable(from, to)).toBe(expected);
      });
    }
  }
});

describe('terminal states have no outgoing transitions (SDD §7: closed_at set, visit never mutates again)', () => {
  it.each(['completed', 'rejected', 'expired', 'cancelled'] as const)(
    '%s has zero rows as a `from` in VISIT_TRANSITIONS',
    (terminal) => {
      expect(VISIT_TRANSITIONS.filter((t) => t.from === terminal)).toHaveLength(0);
    },
  );
});
