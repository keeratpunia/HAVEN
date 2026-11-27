import { afterEach, describe, expect, it } from 'vitest';
import { StreamHub, StreamUnavailableError, type Subscriber } from '../src/stream/hub.js';
import { TEST_DATABASE_URL } from './pg-test-constants.js';

/**
 * DEC-028: before trusting LISTEN, the hub notifies itself and must hear it back. A
 * connection that swallows notifications (a transaction pooler, or a session pooler
 * that turns out not to forward them) would otherwise show "Live" with nothing ever
 * arriving; instead streams are refused and clients keep polling (§9.9).
 */

const sub = (): Subscriber => ({
  hostelId: '00000000-0000-0000-0000-000000000001',
  userId: '00000000-0000-0000-0000-000000000002',
  accepts: () => true,
  send: () => undefined,
  close: () => undefined,
});

let hubs: StreamHub[] = [];
afterEach(async () => {
  await Promise.all(hubs.map((h) => h.close()));
  hubs = [];
});

describe('stream hub LISTEN self-test', () => {
  it('passes on a real Postgres session and accepts subscribers', async () => {
    const hub = new StreamHub(TEST_DATABASE_URL);
    hubs.push(hub);
    const unsubscribe = await hub.subscribe(sub());
    expect(hub.size).toBe(1);
    unsubscribe();
  });

  it('refuses streams when its own notification never arrives, and keeps refusing', async () => {
    const hub = new StreamHub(TEST_DATABASE_URL, undefined, undefined, {
      timeoutMs: 200,
      // Stands in for a proxy that drops notifications: nothing is ever sent.
      send: async () => undefined,
    });
    hubs.push(hub);
    await expect(hub.subscribe(sub())).rejects.toBeInstanceOf(StreamUnavailableError);
    // Within the retry window it doesn't even reconnect.
    await expect(hub.subscribe(sub())).rejects.toBeInstanceOf(StreamUnavailableError);
    expect(hub.size).toBe(0);
  });
});
