import { describe, expect, it, vi } from 'vitest';
import type { Kysely, Transaction } from 'kysely';
import { actorIdFor, actorTypeFor, withTx } from './tx.js';
import type { Database } from '../db/index.js';
import type { DevicePrincipal, UserPrincipal, VisitorPrincipal } from '../auth/principal.js';

const USER: UserPrincipal = { type: 'user', userId: 'u1', sessionId: 's1', roles: [] };
const VISITOR: VisitorPrincipal = { type: 'visitor', visitorId: 'v1', sessionId: 's2' };
const DEVICE: DevicePrincipal = { type: 'device', gateId: 'g1', deviceId: 'd1' };

describe('actorTypeFor', () => {
  it('maps each principal type, and null to system', () => {
    expect(actorTypeFor(null)).toBe('system');
    expect(actorTypeFor(USER)).toBe('user');
    expect(actorTypeFor(VISITOR)).toBe('visitor');
    expect(actorTypeFor(DEVICE)).toBe('gate_device');
  });
});

describe('actorIdFor', () => {
  it('extracts the right id field per principal type, and null for no principal', () => {
    expect(actorIdFor(null)).toBeNull();
    expect(actorIdFor(USER)).toBe('u1');
    expect(actorIdFor(VISITOR)).toBe('v1');
    expect(actorIdFor(DEVICE)).toBe('d1');
  });
});

/** Minimal fake satisfying only what `withTx` itself calls — not a real Kysely instance. */
function fakeDb(trx: unknown) {
  return {
    transaction: () => ({
      execute: async <T>(cb: (t: Transaction<Database>) => Promise<T>) =>
        cb(trx as Transaction<Database>),
    }),
  } as unknown as Kysely<Database>;
}

describe('withTx', () => {
  it('sets the actor context before running the callback, and returns its result', async () => {
    const calls: string[] = [];
    const setActorContext = vi.fn(async () => {
      calls.push('setActorContext');
    });
    const trx = {} as Transaction<Database>;
    const db = fakeDb(trx);

    const result = await withTx(
      db,
      { principal: USER, requestId: 'req_abc' },
      async (t) => {
        calls.push('fn');
        expect(t).toBe(trx);
        return 'ok';
      },
      setActorContext,
    );

    expect(result).toBe('ok');
    expect(calls).toEqual(['setActorContext', 'fn']);
    expect(setActorContext).toHaveBeenCalledWith(trx, { principal: USER, requestId: 'req_abc' });
  });

  it('propagates an error thrown by the callback', async () => {
    const db = fakeDb({});
    await expect(
      withTx(
        db,
        { principal: null, requestId: 'req_x' },
        async () => {
          throw new Error('boom');
        },
        async () => {},
      ),
    ).rejects.toThrow('boom');
  });

  it('propagates an error thrown while setting the actor context, without running fn', async () => {
    const db = fakeDb({});
    const fn = vi.fn();
    await expect(
      withTx(db, { principal: null, requestId: 'req_x' }, fn, async () => {
        throw new Error('set_config failed');
      }),
    ).rejects.toThrow('set_config failed');
    expect(fn).not.toHaveBeenCalled();
  });
});
