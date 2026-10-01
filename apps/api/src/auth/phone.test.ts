import { describe, expect, it } from 'vitest';
import { normalizePhone } from './phone.js';
import { AppError } from '../lib/errors.js';

describe('normalizePhone (SDD §9.5 / CLAUDE.md §2)', () => {
  it('accepts a bare 10-digit number starting 6-9', () => {
    expect(normalizePhone('9876543210')).toBe('+919876543210');
  });

  it('accepts an already-E.164 number unchanged', () => {
    expect(normalizePhone('+919876543210')).toBe('+919876543210');
  });

  it('accepts a 91-prefixed number without +', () => {
    expect(normalizePhone('919876543210')).toBe('+919876543210');
  });

  it('accepts a leading-0 trunk-prefixed number', () => {
    expect(normalizePhone('09876543210')).toBe('+919876543210');
  });

  it('strips spaces and hyphens', () => {
    expect(normalizePhone('98765 43210')).toBe('+919876543210');
    expect(normalizePhone('98765-43210')).toBe('+919876543210');
  });

  it('rejects a number starting 0-5 (not a valid Indian mobile prefix)', () => {
    expect(() => normalizePhone('5876543210')).toThrow(AppError);
  });

  it('rejects a too-short number', () => {
    expect(() => normalizePhone('98765')).toThrow(AppError);
  });

  it('rejects a non-Indian number', () => {
    expect(() => normalizePhone('+14155552671')).toThrow(AppError);
  });

  it('throws VALIDATION_FAILED with 400', () => {
    try {
      normalizePhone('abc');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('VALIDATION_FAILED');
      expect((err as AppError).httpStatus).toBe(400);
    }
  });
});
