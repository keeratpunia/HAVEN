import { afterEach, describe, expect, it } from 'vitest';
import { __resetPolicyRegistryForTests, authorize, definePolicy } from './policy.js';
import type { UserPrincipal } from './principal.js';

afterEach(() => {
  __resetPolicyRegistryForTests();
});

const WARDEN: UserPrincipal = {
  type: 'user',
  userId: 'u1',
  sessionId: 's1',
  roles: [{ h: 'hostel-1', r: 'warden' }],
};

describe('authorize()', () => {
  it('denies an action with no registered policy (fail closed, not fail open)', () => {
    expect(() => authorize(WARDEN, 'some.unregistered.action', {})).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', httpStatus: 403 }),
    );
  });

  it('allows when the registered rule returns true', () => {
    definePolicy<{ hostelId: string }>(
      'example.view',
      (principal, resource) =>
        principal?.type === 'user' && principal.roles.some((r) => r.h === resource.hostelId),
    );
    expect(() => authorize(WARDEN, 'example.view', { hostelId: 'hostel-1' })).not.toThrow();
  });

  it('denies when the registered rule returns false', () => {
    definePolicy<{ hostelId: string }>(
      'example.view',
      (principal, resource) =>
        principal?.type === 'user' && principal.roles.some((r) => r.h === resource.hostelId),
    );
    expect(() => authorize(WARDEN, 'example.view', { hostelId: 'some-other-hostel' })).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('denies a null principal for a rule that requires one', () => {
    definePolicy<Record<string, never>>(
      'example.requires-principal',
      (principal) => principal !== null,
    );
    expect(() => authorize(null, 'example.requires-principal', {})).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('allows a rule that is intentionally public (principal may be null)', () => {
    definePolicy<Record<string, never>>('example.public', () => true);
    expect(() => authorize(null, 'example.public', {})).not.toThrow();
  });

  it('fails closed if the rule itself throws, rather than letting the exception bypass the check', () => {
    definePolicy<Record<string, never>>('example.buggy', () => {
      throw new Error('bug in this policy rule');
    });
    expect(() => authorize(WARDEN, 'example.buggy', {})).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('refuses to register the same action twice', () => {
    definePolicy('example.dup', () => true);
    expect(() => definePolicy('example.dup', () => true)).toThrow(/already registered/);
  });
});
