import { createHmac, webcrypto } from 'node:crypto';
import {
  countdownFraction,
  gateQrPayload,
  HEARTBEAT_INTERVAL_MS,
  heartbeatDelayMs,
  keepScreenAwake,
  msIntoStep,
} from '../lib/gate-display';
import { averageGateFixes } from '../lib/gate-location';
import { currentStep, generateGateToken, STEP_MS } from '../lib/gateToken';

/** FR-20, FR-30, FR-56 at unit level (FINAL-QA-REPORT item 13). */

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

const TOKEN = /^[A-Z0-9]{6}\.\d{1,12}\.[0-9A-HJKMNP-TV-Z]{16}$/;

describe('FR-20: the gate QR', () => {
  it('encodes https://<web>/g/<token>', () => {
    expect(gateQrPayload('https://app.haven.example/', 'GH8A01.1.ABC')).toBe(
      'https://app.haven.example/g/GH8A01.1.ABC',
    );
  });

  it('generates the §9.1 token locally (works offline), the same MAC as the server, new every 10 s', async () => {
    const secret = new Uint8Array(32).fill(3);
    const step = 177958201n;
    const token = await generateGateToken({ secret, gateCode: 'GH8A01', step });
    expect(token).toMatch(TOKEN);
    // Server algorithm (apps/api/src/gate/token.ts): HMAC-SHA256("HVG1|code|step"), first
    // 10 bytes, Crockford base32.
    const mac = createHmac('sha256', Buffer.from(secret))
      .update(`HVG1|GH8A01|${step}`)
      .digest()
      .subarray(0, 10);
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let bits = 0;
    let value = 0;
    let b32 = '';
    for (const byte of mac) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        b32 += alphabet[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    expect(token).toBe(`GH8A01.${step}.${b32}`);
    const next = await generateGateToken({ secret, gateCode: 'GH8A01', step: step + 1n });
    expect(next).not.toBe(token);
    expect(STEP_MS).toBe(10_000);
  });

  it('follows the server clock offset and shows a countdown to the next code', () => {
    const now = 1_000_000_003_000; // 3 s into a step
    expect(msIntoStep(now, 0)).toBe(3_000);
    expect(msIntoStep(now, 8_000)).toBe(1_000); // server 8 s ahead: next step already
    expect(msIntoStep(now, -4_000)).toBe(9_000);
    expect(countdownFraction(0)).toBe(1);
    expect(countdownFraction(7_500)).toBeCloseTo(0.25);
    expect(countdownFraction(10_000)).toBe(0);
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    expect(currentStep(8_000)).toBe(BigInt(Math.floor((now + 8_000) / 10_000)));
    spy.mockRestore();
  });
});

describe('FR-30: the gate keeps going', () => {
  it('heartbeats every 60 s and backs off 5 s, 15 s, then 60 s while the network is down', () => {
    expect(heartbeatDelayMs(0)).toBe(HEARTBEAT_INTERVAL_MS);
    expect([1, 2, 3, 4, 10].map(heartbeatDelayMs)).toEqual([5_000, 15_000, 60_000, 60_000, 60_000]);
  });

  it('keeps the screen awake and re-takes the lock when the tab is visible again', async () => {
    const release = jest.fn().mockResolvedValue(undefined);
    const request = jest.fn().mockResolvedValue({ release });
    const listeners: Record<string, () => void> = {};
    const doc = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (t: string, fn: () => void) => {
        listeners[t] = fn;
      },
      removeEventListener: jest.fn(),
    };
    const stop = keepScreenAwake({ wakeLock: { request } }, doc as never);
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith('screen');
    listeners.visibilitychange?.();
    expect(request).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    stop();
    expect(doc.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(release).toHaveBeenCalled();
  });

  it('still works where wake lock is missing or refused', () => {
    const doc = {
      visibilityState: 'visible',
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
    expect(() => keepScreenAwake({}, doc as never)()).not.toThrow();
    const refused = { wakeLock: { request: jest.fn().mockRejectedValue(new Error('denied')) } };
    expect(() => keepScreenAwake(refused, doc as never)()).not.toThrow();
  });
});

describe('FR-56: gate location from 5 fixes', () => {
  it('drops fixes worse than 30 m and averages the rest', () => {
    const avg = averageGateFixes([
      { lat: 12.0, lng: 77.0, accuracy: 10 },
      { lat: 12.2, lng: 77.2, accuracy: 20 },
      { lat: 50.0, lng: 10.0, accuracy: 120 }, // discarded
      { lat: 12.1, lng: 77.1, accuracy: 30 }, // exactly 30 m is kept
      { lat: 13.0, lng: 78.0, accuracy: 31 }, // discarded
    ]);
    expect(avg?.used).toBe(3);
    expect(avg?.lat).toBeCloseTo(12.1, 10);
    expect(avg?.lng).toBeCloseTo(77.1, 10);
    expect(avg?.accuracy).toBeCloseTo(20, 10);
  });

  it('has nothing to save when every fix is too inaccurate', () => {
    expect(averageGateFixes([{ lat: 1, lng: 1, accuracy: 80 }])).toBeNull();
    expect(averageGateFixes([])).toBeNull();
  });
});
