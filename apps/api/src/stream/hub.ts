import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Logger } from '../lib/logger.js';
import { pgConnectionOptions } from '../db/ssl.js';

/** How long the hub waits for its own test notification after LISTEN (DEC-028). */
export const SELF_TEST_TIMEOUT_MS = 5_000;
/** After a failed self-test, streams are refused (clients poll) for this long. */
export const SELF_TEST_RETRY_MS = 5 * 60_000;

/**
 * Thrown by `subscribe` when LISTEN can't be trusted on this connection: the stream
 * route answers 503 and the client keeps polling every 15 s (§9.9) instead of showing
 * "Live" with nothing arriving.
 */
export class StreamUnavailableError extends Error {}

/**
 * SSE fan-out (SDD §9.9): "API holds one dedicated pg connection with LISTEN
 * haven_events and fans out to subscribers in memory, filtered by hostel and role."
 *
 * The connection is opened when the first subscriber arrives and closed with the app,
 * so test apps and replicas without staff traffic don't hold one. Each subscriber
 * decides what it may receive (`accepts`); the hub never sends an event for another
 * hostel to anyone.
 */

export interface HubEvent {
  t: 'visit' | 'gate';
  h: string;
  id: string;
  s?: string;
  online?: boolean;
}

export interface Subscriber {
  hostelId: string;
  userId: string;
  accepts: (event: HubEvent) => boolean;
  send: (event: HubEvent) => void;
  close: () => void;
}

export class StreamHub {
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private readonly subscribers = new Set<Subscriber>();
  private closed = false;
  private unavailableUntil = 0;

  constructor(
    private readonly connectionString: string,
    private readonly logger?: Pick<Logger, 'warn' | 'error'>,
    /** PEM override for the database CA (`DATABASE_CA_CERT`, `db/ssl.ts`). */
    private readonly caCert?: string,
    /** Tests only: how the self-test notification is sent, and how long to wait. */
    private readonly selfTest: {
      timeoutMs?: number;
      send?: (client: pg.Client, token: string) => Promise<unknown>;
    } = {},
  ) {}

  async subscribe(sub: Subscriber): Promise<() => void> {
    await this.ensureListening();
    this.subscribers.add(sub);
    return () => {
      this.subscribers.delete(sub);
    };
  }

  /** FR-07: a user whose sessions were just ended loses their streams too. */
  disconnectUser(userId: string): void {
    for (const sub of [...this.subscribers]) {
      if (sub.userId === userId) {
        this.subscribers.delete(sub);
        sub.close();
      }
    }
  }

  get size(): number {
    return this.subscribers.size;
  }

  /** Delivers one parsed event to every matching subscriber (exported for tests). */
  dispatch(event: HubEvent): void {
    for (const sub of this.subscribers) {
      if (sub.hostelId !== event.h) continue;
      if (!sub.accepts(event)) continue;
      try {
        sub.send(event);
      } catch (err) {
        this.logger?.warn({ err }, 'stream send failed');
      }
    }
  }

  private async ensureListening(): Promise<void> {
    if (this.client || this.closed) return;
    if (Date.now() < this.unavailableUntil) {
      throw new StreamUnavailableError('live updates are unavailable on this connection');
    }
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new pg.Client(pgConnectionOptions(this.connectionString, this.caCert));
        let pendingTest: { token: string; done: () => void } | null = null;
        client.on('notification', (msg) => {
          if (msg.channel === 'haven_selftest') {
            if (pendingTest && msg.payload === pendingTest.token) pendingTest.done();
            return;
          }
          if (msg.channel !== 'haven_events' || !msg.payload) return;
          try {
            const raw = JSON.parse(msg.payload) as Record<string, unknown>;
            if (
              (raw.t === 'visit' || raw.t === 'gate') &&
              typeof raw.h === 'string' &&
              typeof raw.id === 'string'
            ) {
              this.dispatch({
                t: raw.t,
                h: raw.h,
                id: raw.id,
                s: typeof raw.s === 'string' ? raw.s : undefined,
                online: typeof raw.online === 'boolean' ? raw.online : undefined,
              });
            }
          } catch (err) {
            this.logger?.warn({ err }, 'bad haven_events payload');
          }
        });
        client.on('error', (err) => {
          // Drop the connection; the next subscriber reconnects. Clients fall back to
          // 15 s polling while their stream is down (§9.9).
          this.logger?.error({ err }, 'stream LISTEN connection lost');
          this.client = null;
          for (const sub of [...this.subscribers]) sub.close();
          this.subscribers.clear();
        });
        await client.connect();
        // Self-test (DEC-028): a session notifies itself and must hear it back. Through a
        // proxy that doesn't pass asynchronous notifications on (a transaction pooler, or
        // a session pooler that turns out not to), LISTEN "works" but nothing ever
        // arrives; then streams are refused and clients poll instead.
        const token = randomUUID();
        const heard = new Promise<boolean>((resolve) => {
          const timer = setTimeout(
            () => resolve(false),
            this.selfTest.timeoutMs ?? SELF_TEST_TIMEOUT_MS,
          );
          pendingTest = {
            token,
            done: () => {
              clearTimeout(timer);
              resolve(true);
            },
          };
        });
        await client.query('LISTEN haven_selftest');
        await (this.selfTest.send
          ? this.selfTest.send(client, token)
          : client.query('select pg_notify($1, $2)', ['haven_selftest', token]));
        if (!(await heard)) {
          this.unavailableUntil = Date.now() + SELF_TEST_RETRY_MS;
          this.logger?.error(
            {},
            'stream self-test failed: LISTEN/NOTIFY does not reach this connection; clients will poll',
          );
          await client.end().catch(() => undefined);
          throw new StreamUnavailableError('live updates are unavailable on this connection');
        }
        await client.query('UNLISTEN haven_selftest');
        pendingTest = null;
        await client.query('LISTEN haven_events');
        this.client = client;
      })().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const sub of [...this.subscribers]) sub.close();
    this.subscribers.clear();
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => undefined);
  }
}
