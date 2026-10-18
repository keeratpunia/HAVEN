import pg from 'pg';
import type { Logger } from '../lib/logger.js';

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

  constructor(
    private readonly connectionString: string,
    private readonly logger?: Pick<Logger, 'warn' | 'error'>,
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
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new pg.Client({ connectionString: this.connectionString });
        client.on('notification', (msg) => {
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
