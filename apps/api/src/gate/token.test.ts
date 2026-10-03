import { describe, expect, it } from 'vitest';
import { generateGateToken, STEP_MS, verifyGateToken, type GateTokenRow } from './token.js';
import { encryptAesGcm, randomSecret } from '../lib/crypto.js';

const DATA_ENCRYPTION_KEY = randomSecret(32);
const GATE_SECRET = randomSecret(32);
const GATE_CODE = 'GH8A01';
const NOW = new Date('2026-10-12T10:42:00.000Z');

function activeGateRow(overrides: Partial<GateTokenRow> = {}): GateTokenRow {
  return {
    id: 'gate-1',
    hostel_id: 'hostel-1',
    is_active: true,
    secret_enc: encryptAesGcm(GATE_SECRET, DATA_ENCRYPTION_KEY),
    secret_version: 1,
    prev_secret_enc: null,
    secret_rotated_at: null,
    ...overrides,
  };
}

function loaderReturning(row: GateTokenRow | null) {
  return async () => row;
}

describe('gate token (SDD §9.1)', () => {
  it('TC-TOK-01: a freshly generated token verifies at step s, s+1 and s+2', async () => {
    const gate = activeGateRow();
    const token = generateGateToken({ secret: GATE_SECRET, gateCode: GATE_CODE, now: NOW });

    for (const deltaSteps of [0, 1, 2]) {
      const checkAt = new Date(NOW.getTime() + deltaSteps * STEP_MS);
      const result = await verifyGateToken(
        token,
        DATA_ENCRYPTION_KEY,
        checkAt,
        loaderReturning(gate),
      );
      expect(result.gate.id).toBe('gate-1');
    }
  });

  it('TC-TOK-02: verified at s+3 is GATE_TOKEN_EXPIRED', async () => {
    const gate = activeGateRow();
    const token = generateGateToken({ secret: GATE_SECRET, gateCode: GATE_CODE, now: NOW });
    const checkAt = new Date(NOW.getTime() + 3 * STEP_MS);

    await expect(
      verifyGateToken(token, DATA_ENCRYPTION_KEY, checkAt, loaderReturning(gate)),
    ).rejects.toMatchObject({ code: 'GATE_TOKEN_EXPIRED', httpStatus: 410 });
  });

  it('TC-TOK-03: verified at s-1 (device clock ahead) is valid; s-2 is invalid', async () => {
    const gate = activeGateRow();
    const token = generateGateToken({ secret: GATE_SECRET, gateCode: GATE_CODE, now: NOW });

    const minusOne = new Date(NOW.getTime() - 1 * STEP_MS);
    await expect(
      verifyGateToken(token, DATA_ENCRYPTION_KEY, minusOne, loaderReturning(gate)),
    ).resolves.toMatchObject({ tokenAgeSteps: -1 });

    const minusTwo = new Date(NOW.getTime() - 2 * STEP_MS);
    await expect(
      verifyGateToken(token, DATA_ENCRYPTION_KEY, minusTwo, loaderReturning(gate)),
    ).rejects.toMatchObject({ code: 'GATE_TOKEN_EXPIRED' });
  });

  it('future token (far beyond one fast-clock step) is GATE_TOKEN_EXPIRED', async () => {
    const gate = activeGateRow();
    const future = new Date(NOW.getTime() + 10 * STEP_MS);
    const token = generateGateToken({ secret: GATE_SECRET, gateCode: GATE_CODE, now: future });

    await expect(
      verifyGateToken(token, DATA_ENCRYPTION_KEY, NOW, loaderReturning(gate)),
    ).rejects.toMatchObject({ code: 'GATE_TOKEN_EXPIRED' });
  });

  it('TC-TOK-04: one character of the MAC changed is GATE_TOKEN_INVALID', async () => {
    const gate = activeGateRow();
    const token = generateGateToken({ secret: GATE_SECRET, gateCode: GATE_CODE, now: NOW });
    const [code, step, mac] = token.split('.') as [string, string, string];
    const flippedChar = mac[0] === 'A' ? 'B' : 'A';
    const tampered = `${code}.${step}.${flippedChar}${mac.slice(1)}`;

    await expect(
      verifyGateToken(tampered, DATA_ENCRYPTION_KEY, NOW, loaderReturning(gate)),
    ).rejects.toMatchObject({ code: 'GATE_TOKEN_INVALID', httpStatus: 400 });
  });

  it('malformed token (fails the regex) is GATE_TOKEN_INVALID', async () => {
    await expect(
      verifyGateToken('not-a-real-token', DATA_ENCRYPTION_KEY, NOW, loaderReturning(null)),
    ).rejects.toMatchObject({ code: 'GATE_TOKEN_INVALID' });
  });

  it('unknown gate code is GATE_TOKEN_INVALID', async () => {
    const token = generateGateToken({ secret: GATE_SECRET, gateCode: GATE_CODE, now: NOW });
    await expect(
      verifyGateToken(token, DATA_ENCRYPTION_KEY, NOW, loaderReturning(null)),
    ).rejects.toMatchObject({ code: 'GATE_TOKEN_INVALID' });
  });

  it('inactive gate is GATE_TOKEN_INVALID', async () => {
    const gate = activeGateRow({ is_active: false });
    const token = generateGateToken({ secret: GATE_SECRET, gateCode: GATE_CODE, now: NOW });
    await expect(
      verifyGateToken(token, DATA_ENCRYPTION_KEY, NOW, loaderReturning(gate)),
    ).rejects.toMatchObject({ code: 'GATE_TOKEN_INVALID' });
  });

  it('wrong MAC — a token signed with a different secret entirely — is GATE_TOKEN_INVALID', async () => {
    const gate = activeGateRow();
    const wrongSecret = randomSecret(32);
    const token = generateGateToken({ secret: wrongSecret, gateCode: GATE_CODE, now: NOW });
    await expect(
      verifyGateToken(token, DATA_ENCRYPTION_KEY, NOW, loaderReturning(gate)),
    ).rejects.toMatchObject({ code: 'GATE_TOKEN_INVALID' });
  });

  it('TC-TOK-05: a token signed with the rotated-out previous secret is valid within 120s, invalid after', async () => {
    const oldSecret = GATE_SECRET;
    const newSecret = randomSecret(32);
    const rotatedAt = NOW;
    const gate = activeGateRow({
      secret_enc: encryptAesGcm(newSecret, DATA_ENCRYPTION_KEY),
      secret_version: 2,
      prev_secret_enc: encryptAesGcm(oldSecret, DATA_ENCRYPTION_KEY),
      secret_rotated_at: rotatedAt,
    });
    const withinGrace = new Date(rotatedAt.getTime() + 60_000);
    const tokenFromOldSecret = generateGateToken({
      secret: oldSecret,
      gateCode: GATE_CODE,
      now: withinGrace,
    });
    await expect(
      verifyGateToken(tokenFromOldSecret, DATA_ENCRYPTION_KEY, withinGrace, loaderReturning(gate)),
    ).resolves.toMatchObject({ gate: { id: 'gate-1' } });

    const afterGrace = new Date(rotatedAt.getTime() + 121_000);
    const tokenAtAfterGrace = generateGateToken({
      secret: oldSecret,
      gateCode: GATE_CODE,
      now: afterGrace,
    });
    await expect(
      verifyGateToken(tokenAtAfterGrace, DATA_ENCRYPTION_KEY, afterGrace, loaderReturning(gate)),
    ).rejects.toMatchObject({ code: 'GATE_TOKEN_INVALID' });
  });

  it('replay: the same (non-single-use) token verifies again at a later, still-fresh step', async () => {
    const gate = activeGateRow();
    const token = generateGateToken({ secret: GATE_SECRET, gateCode: GATE_CODE, now: NOW });
    const firstScan = await verifyGateToken(token, DATA_ENCRYPTION_KEY, NOW, loaderReturning(gate));
    const secondScan = await verifyGateToken(
      token,
      DATA_ENCRYPTION_KEY,
      new Date(NOW.getTime() + STEP_MS),
      loaderReturning(gate),
    );
    expect(firstScan.tokenStep).toBe(secondScan.tokenStep);
  });
});
