import { describe, expect, it } from 'vitest';
import { GH8_RULES_CONFIG_V1 } from './config.js';
import { evaluateExit } from './evaluate-exit.js';
import type { ExitContext } from './types.js';

const cfg = GH8_RULES_CONFIG_V1;

function baseExitContext(overrides: Partial<ExitContext> = {}): ExitContext {
  return {
    now: new Date('2026-10-12T20:00:00+05:30'),
    windowEnd: new Date('2026-10-12T21:00:00+05:30'),
    gpsOk: true,
    ...overrides,
  };
}

describe('evaluateExit — TC-RULE-16: exit after window + grace → allow with LATE_EXIT flag', () => {
  it('matches the worked case exactly', () => {
    const result = evaluateExit(
      baseExitContext({
        now: new Date('2026-10-12T21:16:00+05:30'), // window_end (21:00) + grace (15 min) + 1 min
        windowEnd: new Date('2026-10-12T21:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'allow_flagged', codes: ['LATE_EXIT'] });
  });
});

describe('evaluateExit — BR-17: never denies, regardless of how bad the inputs are', () => {
  it('still allows with every possible flag active at once', () => {
    const result = evaluateExit(
      baseExitContext({
        now: new Date('2026-10-13T10:00:00+05:30'), // wildly late
        windowEnd: new Date('2026-10-12T21:00:00+05:30'),
        gpsOk: false,
      }),
      cfg,
    );
    expect(result.decision).toBe('allow_flagged');
    expect(result.decision).not.toBe('deny');
  });
});

describe('evaluateExit — LATE_EXIT exact grace-period boundary (BR-13: window_end + 15 min)', () => {
  it('one second before the grace period ends: on time, no flag', () => {
    const result = evaluateExit(
      baseExitContext({
        now: new Date('2026-10-12T21:14:59+05:30'),
        windowEnd: new Date('2026-10-12T21:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'allow', codes: [] });
  });

  it('exactly at the grace-period boundary (window_end + 15 min): flagged', () => {
    const result = evaluateExit(
      baseExitContext({
        now: new Date('2026-10-12T21:15:00+05:30'),
        windowEnd: new Date('2026-10-12T21:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'allow_flagged', codes: ['LATE_EXIT'] });
  });

  it('exiting exactly at window_end (no lateness at all) is not flagged', () => {
    const result = evaluateExit(
      baseExitContext({
        now: new Date('2026-10-12T21:00:00+05:30'),
        windowEnd: new Date('2026-10-12T21:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'allow', codes: [] });
  });

  it('exiting before window_end entirely is not flagged', () => {
    const result = evaluateExit(
      baseExitContext({
        now: new Date('2026-10-12T18:00:00+05:30'),
        windowEnd: new Date('2026-10-12T21:00:00+05:30'),
      }),
      cfg,
    );
    expect(result).toEqual({ decision: 'allow', codes: [] });
  });
});

describe('evaluateExit — LOCATION_UNVERIFIED flag (BR-17)', () => {
  it('flags when GPS failed on exit, but still allows the checkout', () => {
    const result = evaluateExit(baseExitContext({ gpsOk: false }), cfg);
    expect(result).toEqual({ decision: 'allow_flagged', codes: ['LOCATION_UNVERIFIED'] });
  });

  it('does not flag when GPS succeeded', () => {
    const result = evaluateExit(baseExitContext({ gpsOk: true }), cfg);
    expect(result.codes).not.toContain('LOCATION_UNVERIFIED');
  });

  it('accumulates both LOCATION_UNVERIFIED and LATE_EXIT together', () => {
    const result = evaluateExit(
      baseExitContext({
        now: new Date('2026-10-12T21:20:00+05:30'),
        windowEnd: new Date('2026-10-12T21:00:00+05:30'),
        gpsOk: false,
      }),
      cfg,
    );
    expect(result.decision).toBe('allow_flagged');
    expect(result.codes).toEqual(['LOCATION_UNVERIFIED', 'LATE_EXIT']);
  });
});
