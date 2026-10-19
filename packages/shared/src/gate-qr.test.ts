import { describe, expect, it } from 'vitest';
import { gateTokenFromQr } from './gate-qr.js';

const TOKEN = 'GH8A01.177958201.7K3Q9A2M4XBN6PDR';

describe('gateTokenFromQr (FR-22)', () => {
  it('reads the token from the gate QR URL', () => {
    expect(gateTokenFromQr(`https://app.haven.example/g/${TOKEN}`)).toBe(TOKEN);
    expect(gateTokenFromQr(`http://localhost:8081/g/${TOKEN}?x=1`)).toBe(TOKEN);
    expect(gateTokenFromQr(`  ${TOKEN}  `)).toBe(TOKEN);
  });

  it('ignores anything that is not a gate token', () => {
    expect(gateTokenFromQr('https://example.com/login')).toBeNull();
    expect(gateTokenFromQr('https://evil.example/g/not-a-token')).toBeNull();
    expect(gateTokenFromQr(`https://app.haven.example/g/${TOKEN}/extra`)).toBeNull();
    expect(gateTokenFromQr('WIFI:S:hostel;T:WPA;P:secret;;')).toBeNull();
    expect(gateTokenFromQr('')).toBeNull();
  });
});
