/**
 * The demo's clock: real time plus an offset the presenter can set (`pnpm demo:clock`),
 * so the live demo works at any hour and can show the 20:00 / 22:00 rules on cue
 * (docs/DEMO.md step F). Demo-only — the real API always uses `SystemClock`.
 *
 * Only business time moves: access/refresh tokens are signed and checked on real time
 * (`auth/jwt.ts`), exactly as with the frozen E2E clock, so sessions keep working.
 */
import { formatDateTime, localDateTimeToUtc, toLocalDateString } from '@haven/shared';
import type { Clock } from '../src/lib/clock.js';
import { DEMO_API_PORT } from './demo-constants.js';

export class OffsetClock implements Clock {
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  /** Jump so that "now" reads `at`; time keeps running from there. */
  setNow(at: Date): void {
    this.offsetMs = at.getTime() - Date.now();
  }

  reset(): void {
    this.offsetMs = 0;
  }

  get offset(): number {
    return this.offsetMs;
  }
}

const TZ = 'Asia/Kolkata';

/**
 * "19:58" → today at 19:58 IST; "+15m" / "-2h" → shift from the current demo time;
 * an ISO timestamp → that instant. Returns null for "reset".
 */
export function parseDemoTime(spec: string, current: Date): Date | null {
  const s = spec.trim();
  if (s === 'reset' || s === 'real') return null;
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hhmm) {
    const hh = hhmm[1]?.padStart(2, '0') ?? '00';
    return localDateTimeToUtc(toLocalDateString(current, TZ), `${hh}:${hhmm[2] ?? '00'}`, TZ);
  }
  const rel = /^([+-])(\d+)([mh])$/.exec(s);
  if (rel) {
    const ms = Number(rel[2]) * (rel[3] === 'h' ? 3_600_000 : 60_000);
    return new Date(current.getTime() + (rel[1] === '-' ? -ms : ms));
  }
  const iso = new Date(s);
  if (!Number.isNaN(iso.getTime())) return iso;
  throw new Error(
    `Can't read "${spec}". Use HH:MM (IST, today), +15m, -2h, an ISO time, or reset.`,
  );
}

export function formatIst(d: Date): string {
  return `${formatDateTime(d, TZ)} IST`;
}

/** The running demo API's current business time (falls back to real time if it's down). */
export async function demoNow(): Promise<{ now: Date; running: boolean }> {
  try {
    const res = await fetch(`http://127.0.0.1:${DEMO_API_PORT}/__demo/clock`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { now: string };
    return { now: new Date(body.now), running: true };
  } catch {
    return { now: new Date(), running: false };
  }
}
