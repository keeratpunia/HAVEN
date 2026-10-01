import { describe, expect, it } from 'vitest';
import { FakeClock, SystemClock } from './clock.js';

describe('Clock', () => {
  it('SystemClock returns the current time', () => {
    const before = Date.now();
    const clock = new SystemClock();
    const now = clock.now().getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('FakeClock is deterministic and advances on demand', () => {
    const start = new Date('2026-10-01T10:00:00.000Z');
    const clock = new FakeClock(start);
    expect(clock.now().toISOString()).toBe('2026-10-01T10:00:00.000Z');

    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe('2026-10-01T10:01:00.000Z');

    clock.set(new Date('2026-12-25T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-12-25T00:00:00.000Z');
  });
});
