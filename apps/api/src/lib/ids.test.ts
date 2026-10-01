import { describe, expect, it } from 'vitest';
import {
  formatPairingCodeForDisplay,
  generateGateCode,
  generatePairingCode,
  generateVisitCode,
} from './ids.js';

describe('generateVisitCode', () => {
  it('matches the SDD §11.4 check constraint pattern', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateVisitCode()).toMatch(/^V[0-9A-HJKMNP-TV-Z]{6}$/);
    }
  });
});

describe('generatePairingCode', () => {
  it('is 8 Crockford base32 characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePairingCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    }
  });
});

describe('formatPairingCodeForDisplay', () => {
  it('formats as XXXX-XXXX', () => {
    expect(formatPairingCodeForDisplay('7K3Q9A2M')).toBe('7K3Q-9A2M');
  });

  it('rejects the wrong length', () => {
    expect(() => formatPairingCodeForDisplay('ABC')).toThrow(/8 characters/);
  });
});

describe('generateGateCode', () => {
  it('matches the SDD §11.3 check constraint pattern', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateGateCode()).toMatch(/^[A-Z0-9]{6}$/);
    }
  });
});
