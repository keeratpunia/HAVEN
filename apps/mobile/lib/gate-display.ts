import { STEP_MS } from './gateToken.js';

/**
 * Pure pieces of the gate display (D-02, SDD §9.1/§9.2), kept out of the screen so they
 * can be unit-tested (FR-20, FR-30).
 */

/** FR-20: the QR encodes `https://<web>/g/<token>`. */
export function gateQrPayload(webBaseUrl: string, token: string): string {
  return `${webBaseUrl.replace(/\/+$/, '')}/g/${token}`;
}

/** How far into the current 10 s step the (server-corrected) clock is. */
export function msIntoStep(nowMs: number, offsetMs: number): number {
  return (((nowMs + offsetMs) % STEP_MS) + STEP_MS) % STEP_MS;
}

/** The countdown bar: 1 at the start of a step, 0 when the next token appears. */
export function countdownFraction(msInto: number): number {
  return Math.max(0, 1 - msInto / STEP_MS);
}

export const HEARTBEAT_INTERVAL_MS = 60_000;
export const HEARTBEAT_BACKOFF_MS = [5_000, 15_000, 60_000] as const;

/**
 * FR-30 / §9.2: heartbeat every 60 s; while failing, retry after 5 s, 15 s, then every
 * 60 s until the network is back. `failures` = consecutive failures so far (0 = ok).
 */
export function heartbeatDelayMs(failures: number): number {
  if (failures <= 0) return HEARTBEAT_INTERVAL_MS;
  return HEARTBEAT_BACKOFF_MS[Math.min(failures, HEARTBEAT_BACKOFF_MS.length) - 1] ?? 60_000;
}

interface WakeLockNavigator {
  wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
}

/**
 * FR-30: keep the screen awake. Requests a screen wake lock now and again whenever the
 * page becomes visible (browsers drop the lock when the tab is hidden). Returns a
 * cleanup that releases it. A browser without wake lock still shows the QR.
 */
export function keepScreenAwake(
  nav: WakeLockNavigator,
  doc: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>,
): () => void {
  let lock: { release: () => Promise<void> } | null = null;
  const request = async () => {
    try {
      if (nav.wakeLock) lock = await nav.wakeLock.request('screen');
    } catch {
      // Not available or refused: the page still works, it may just sleep.
    }
  };
  void request();
  const onVisible = () => {
    if (doc.visibilityState === 'visible') void request();
  };
  doc.addEventListener('visibilitychange', onVisible);
  return () => {
    doc.removeEventListener('visibilitychange', onVisible);
    void lock?.release();
  };
}
