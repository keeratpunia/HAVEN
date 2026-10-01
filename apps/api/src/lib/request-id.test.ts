import { describe, expect, it } from 'vitest';
import { generateRequestId } from './request-id.js';

describe('generateRequestId', () => {
  it('matches the SDD §9.11 format: req_ + 12 lowercase-alphanumeric chars', () => {
    const id = generateRequestId();
    expect(id).toMatch(/^req_[a-z0-9]{12}$/);
  });

  it('is not trivially predictable across calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateRequestId()));
    expect(ids.size).toBe(50);
  });
});
