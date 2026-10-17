import { sql, type Kysely } from 'kysely';
import { channelForKind, defaultScreenForKind, type PushData } from '@haven/shared';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import type { PushSender, SmsSender } from './senders.js';

/**
 * Notification outbox worker (SDD §9.7). Every `intervalMs` (2 s) it claims up to 50
 * due rows with the SDD's exact `FOR UPDATE SKIP LOCKED` query, so a second replica
 * can never double-send, then for each row:
 *   1. cancels it if its `cancel_if_opened` push was opened (SMS fallback no longer needed);
 *   2. cancels it if it's stale for its kind (e.g. a walk-in SMS once the visit is no
 *      longer `pending_host`);
 *   3. delivers: push via Expo to every active token, SMS via the provider, in-app
 *      needs no delivery;
 *   4. on failure, retries at 10 s, 30 s, 2 min, 10 min, then `failed`.
 * "Push to a user with no active push token → the worker creates the SMS fallback
 * immediately for kinds that have one; otherwise in-app only" (§15.5).
 */

const RETRY_DELAYS_MS = [10_000, 30_000, 120_000, 600_000];
const BATCH_SIZE = 50;

interface ClaimedRow {
  id: string;
  hostel_id: string | null;
  recipient_type: 'user' | 'visitor' | 'phone';
  recipient_id: string | null;
  recipient_phone: string | null;
  kind: string;
  channel: 'push' | 'sms' | 'in_app';
  visit_id: string | null;
  title: string | null;
  body: string;
  data: Record<string, unknown> | null;
  sms_template_id: string | null;
  attempts: number;
  cancel_if_opened: string | null;
}

export interface NotificationWorkerDeps {
  db: Kysely<Database>;
  clock: Clock;
  push: PushSender;
  sms: SmsSender;
  logger?: Pick<Logger, 'warn' | 'error'>;
}

export class NotificationWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** When the loop last completed a tick — `/ready` requires this within 30 s (SDD §12.10). */
  lastTickAt: Date | null = null;

  constructor(private readonly deps: NotificationWorkerDeps) {}

  start(intervalMs = 2_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.tick()
        .catch((err: unknown) =>
          this.deps.logger?.error({ err }, 'notification worker tick failed'),
        )
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Processes one batch. Returns how many rows were claimed. */
  async tick(): Promise<number> {
    const now = this.deps.clock.now();
    const result = await sql<ClaimedRow>`
      update haven.notifications set status = 'sending', attempts = attempts + 1
       where id in (
         select id from haven.notifications
          where status = 'queued' and next_attempt_at <= ${now}
          order by created_at limit ${BATCH_SIZE}
          for update skip locked)
      returning id, hostel_id, recipient_type, recipient_id, recipient_phone, kind, channel,
                visit_id, title, body, data, sms_template_id, attempts, cancel_if_opened`.execute(
      this.deps.db,
    );

    for (const row of result.rows) {
      try {
        await this.process(row, now);
      } catch (err) {
        await this.scheduleRetry(row, now, err instanceof Error ? err.message : String(err));
      }
    }
    this.lastTickAt = this.deps.clock.now();
    return result.rows.length;
  }

  private async process(row: ClaimedRow, now: Date): Promise<void> {
    if (row.cancel_if_opened && (await this.wasOpened(row.cancel_if_opened))) {
      return this.finish(row.id, 'cancelled', 'push was opened');
    }
    const staleReason = await this.staleReason(row);
    if (staleReason) return this.finish(row.id, 'cancelled', staleReason);

    if (row.channel === 'in_app') return this.finish(row.id, 'sent', null, now);
    if (row.channel === 'sms') return this.deliverSms(row, now);
    return this.deliverPush(row, now);
  }

  private async deliverPush(row: ClaimedRow, now: Date): Promise<void> {
    if (row.recipient_type !== 'user' || !row.recipient_id) {
      // Guests have no push (SDD §9.9); anything addressed to them is in-app only.
      return this.finish(row.id, 'sent', null, now);
    }
    const tokens = await this.deps.db
      .selectFrom('haven.push_tokens')
      .select(['id', 'expo_token'])
      .where('user_id', '=', row.recipient_id)
      .where('disabled_at', 'is', null)
      .execute();

    if (tokens.length === 0) {
      await this.releaseSmsFallback(row.id, now);
      return this.finish(row.id, 'cancelled', 'no active push token; in-app only');
    }

    const data: PushData = {
      kind: row.kind,
      notificationId: row.id,
      ...(row.visit_id ? { visitId: row.visit_id } : {}),
      screen:
        typeof row.data?.screen === 'string'
          ? row.data.screen
          : defaultScreenForKind(row.kind, row.visit_id),
    };
    const channelId = channelForKind(row.kind);
    const tickets = await this.deps.push.send(
      tokens.map((t) => ({
        to: t.expo_token,
        title: row.title,
        body: row.body,
        data: { ...data },
        channelId,
        priority: channelId === 'updates' ? 'default' : 'high',
      })),
    );

    const deadTokenIds = tokens
      .filter((_, i) => {
        const ticket = tickets[i];
        return ticket?.status === 'error' && ticket.deviceNotRegistered;
      })
      .map((t) => t.id);
    if (deadTokenIds.length > 0) {
      await this.deps.db
        .updateTable('haven.push_tokens')
        .set({ disabled_at: now })
        .where('id', 'in', deadTokenIds)
        .execute();
    }

    const okIds = tickets.flatMap((t) => (t?.status === 'ok' ? [t.id] : []));
    if (okIds.length > 0) {
      await this.finish(row.id, 'sent', null, now, okIds.join(','));
      return;
    }
    if (deadTokenIds.length === tokens.length) {
      await this.releaseSmsFallback(row.id, now);
      return this.finish(row.id, 'cancelled', 'all push tokens unregistered; in-app only');
    }
    const firstError = tickets.find((t) => t?.status === 'error');
    throw new Error(firstError?.status === 'error' ? firstError.message : 'push send failed');
  }

  private async deliverSms(row: ClaimedRow, now: Date): Promise<void> {
    const phone = await this.phoneFor(row);
    if (!phone) return this.finish(row.id, 'failed', 'recipient has no phone number');
    const { ref } = await this.deps.sms.send(phone, row.sms_template_id ?? 'UNKNOWN', row.body);
    await this.finish(row.id, 'sent', null, now, ref);
  }

  private async phoneFor(row: ClaimedRow): Promise<string | null> {
    if (row.recipient_type === 'phone') return row.recipient_phone;
    if (!row.recipient_id) return null;
    if (row.recipient_type === 'user') {
      const user = await this.deps.db
        .selectFrom('haven.users')
        .select('phone')
        .where('id', '=', row.recipient_id)
        .executeTakeFirst();
      return user?.phone ?? null;
    }
    const visitor = await this.deps.db
      .selectFrom('haven.visitors')
      .select('phone')
      .where('id', '=', row.recipient_id)
      .executeTakeFirst();
    return visitor?.phone ?? null;
  }

  private async wasOpened(notificationId: string): Promise<boolean> {
    const row = await this.deps.db
      .selectFrom('haven.notifications')
      .select('opened_at')
      .where('id', '=', notificationId)
      .executeTakeFirst();
    return Boolean(row?.opened_at);
  }

  /**
   * Kind-specific staleness (SDD §9.7: "e.g. a walk-in SMS is cancelled if the visit is
   * no longer pending_host"). A request-for-action notification whose action can no
   * longer be taken would only mislead the host.
   */
  private async staleReason(row: ClaimedRow): Promise<string | null> {
    if (!row.visit_id) return null;
    if (row.kind !== 'N-WALKIN' && row.kind !== 'N-CONFIRM-LOCATION') return null;
    const visit = await this.deps.db
      .selectFrom('haven.visits')
      .select(['status', 'host_confirmed_at'])
      .where('id', '=', row.visit_id)
      .executeTakeFirst();
    if (!visit) return 'visit not found';
    if (row.kind === 'N-WALKIN' && visit.status !== 'pending_host') {
      return `visit is ${visit.status}, no longer pending_host`;
    }
    if (row.kind === 'N-CONFIRM-LOCATION') {
      if (visit.host_confirmed_at) return 'host already confirmed';
      if (visit.status !== 'pending_host' && visit.status !== 'approved') {
        return `visit is ${visit.status}`;
      }
    }
    return null;
  }

  /** Pulls a push row's linked SMS fallback forward to "now". */
  private async releaseSmsFallback(pushId: string, now: Date): Promise<void> {
    await this.deps.db
      .updateTable('haven.notifications')
      .set({ next_attempt_at: now })
      .where('cancel_if_opened', '=', pushId)
      .where('status', '=', 'queued')
      .execute();
  }

  private async finish(
    id: string,
    status: 'sent' | 'cancelled' | 'failed',
    lastError: string | null,
    sentAt?: Date,
    providerRef?: string,
  ): Promise<void> {
    await this.deps.db
      .updateTable('haven.notifications')
      .set({
        status,
        last_error: lastError,
        ...(sentAt ? { sent_at: sentAt.toISOString() } : {}),
        ...(providerRef ? { provider_ref: providerRef } : {}),
      })
      .where('id', '=', id)
      .execute();
  }

  private async scheduleRetry(row: ClaimedRow, now: Date, error: string): Promise<void> {
    const delay = RETRY_DELAYS_MS[row.attempts - 1];
    if (delay === undefined) {
      this.deps.logger?.error(
        { notificationId: row.id, kind: row.kind, error },
        'notification failed',
      );
      await this.finish(row.id, 'failed', error);
      return;
    }
    this.deps.logger?.warn({ notificationId: row.id, kind: row.kind, error }, 'notification retry');
    await this.deps.db
      .updateTable('haven.notifications')
      .set({
        status: 'queued',
        last_error: error,
        next_attempt_at: new Date(now.getTime() + delay),
      })
      .where('id', '=', row.id)
      .execute();
  }
}
