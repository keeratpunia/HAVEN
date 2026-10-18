import { sql, type Kysely } from 'kysely';
import { channelForKind, defaultScreenForKind, type PushData } from '@haven/shared';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import type { PushSender, SmsProvider } from './senders.js';
import { isDltTemplateId, renderDlt } from './dlt.js';
import { personalDataIn } from './sending-rules.js';
import type { ErrorReporter } from '../lib/error-reporter.js';

/**
 * Notification outbox worker (SDD §9.7). Every `intervalMs` (2 s) it claims up to 50
 * due rows with the SDD's `FOR UPDATE SKIP LOCKED` query, so concurrent workers never
 * claim the same row, then for each row:
 *   1. cancels it if its `cancel_if_opened` push was opened (SMS fallback no longer needed);
 *   2. cancels it if it's stale for its kind (e.g. a walk-in SMS once the visit is no
 *      longer `pending_host`);
 *   3. refuses it if the text breaks §15.5 (a phone number or photo in a push/SMS);
 *   4. delivers: push via Expo to every active token, SMS as its DLT template and
 *      variables (§15.3), in-app needs no delivery;
 *   5. on failure, retries at 10 s, 30 s, 2 min, 10 min, then `failed`.
 * "Push to a user with no active push token → the worker creates the SMS fallback
 * immediately for kinds that have one; otherwise in-app only" (§15.5).
 *
 * Claiming also stamps `next_attempt_at` with the claim time. A row still `sending`
 * `LEASE_MS` later belongs to a worker that died mid-send; the next tick puts it back in
 * the queue (counting as an attempt). Every write after the claim is conditional on the
 * row still being this claim's (`status = 'sending'` with the same attempt number), so a
 * row processed twice is delivered and finished at most once per claim
 * (docs/DECISIONS.md DEC-015).
 */

export const RETRY_DELAYS_MS = [10_000, 30_000, 120_000, 600_000];
export const LEASE_MS = 5 * 60_000;
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
  sms: SmsProvider;
  logger?: Pick<Logger, 'warn' | 'error'>;
  /** §9.7 "then failed (and logged to Sentry)". */
  reporter?: ErrorReporter;
}

/** A failure retrying can't fix: finish as `failed` now. */
class PermanentFailure extends Error {}

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
    await this.requeueAbandoned(now);
    const result = await sql<ClaimedRow>`
      update haven.notifications
         set status = 'sending', attempts = attempts + 1, next_attempt_at = ${now}
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
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof PermanentFailure) {
          this.deps.logger?.error(
            { notificationId: row.id, kind: row.kind, error: message },
            'notification failed',
          );
          this.reportFailure(row, message);
          await this.finish(row, 'failed', message);
        } else {
          await this.scheduleRetry(row, now, message);
        }
      }
    }
    this.lastTickAt = this.deps.clock.now();
    return result.rows.length;
  }

  /** Rows a dead worker left in `sending` go back in the queue after the lease. */
  private async requeueAbandoned(now: Date): Promise<void> {
    await this.deps.db
      .updateTable('haven.notifications')
      .set({ status: 'queued', last_error: 'worker lease expired', next_attempt_at: now })
      .where('status', '=', 'sending')
      .where('next_attempt_at', '<=', new Date(now.getTime() - LEASE_MS))
      .execute();
  }

  private async process(row: ClaimedRow, now: Date): Promise<void> {
    if (!(await this.stillClaimed(row))) return;
    if (row.cancel_if_opened && (await this.wasOpened(row.cancel_if_opened))) {
      return this.finish(row, 'cancelled', 'push was opened');
    }
    const staleReason = await this.staleReason(row);
    if (staleReason) return this.finish(row, 'cancelled', staleReason);

    if (row.channel === 'in_app') return this.finish(row, 'sent', null, now);

    const blocked = personalDataIn(row.title) ?? personalDataIn(row.body);
    if (blocked) throw new PermanentFailure(`blocked by §15.5: ${blocked}`);

    if (row.channel === 'sms') return this.deliverSms(row, now);
    return this.deliverPush(row, now);
  }

  private async deliverPush(row: ClaimedRow, now: Date): Promise<void> {
    if (row.recipient_type !== 'user' || !row.recipient_id) {
      // Guests have no push (SDD §9.9); anything addressed to them is in-app only.
      return this.finish(row, 'sent', null, now);
    }
    const tokens = await this.deps.db
      .selectFrom('haven.push_tokens')
      .select(['id', 'expo_token'])
      .where('user_id', '=', row.recipient_id)
      .where('disabled_at', 'is', null)
      .execute();

    if (tokens.length === 0) {
      await this.releaseSmsFallback(row.id, now);
      return this.finish(row, 'cancelled', 'no active push token; in-app only');
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
      // "DeviceNotRegistered disables that push_tokens row" (§9.7).
      await this.deps.db
        .updateTable('haven.push_tokens')
        .set({ disabled_at: now })
        .where('id', 'in', deadTokenIds)
        .execute();
    }

    // "<ticket id>:<push_tokens id>" pairs, so the receipts job can disable the right token.
    const okRefs = tokens.flatMap((t, i) => {
      const ticket = tickets[i];
      return ticket?.status === 'ok' ? [`${ticket.id}:${t.id}`] : [];
    });
    if (okRefs.length > 0) {
      await this.finish(row, 'sent', null, now, okRefs.join(','));
      return;
    }
    if (deadTokenIds.length === tokens.length) {
      await this.releaseSmsFallback(row.id, now);
      return this.finish(row, 'cancelled', 'all push tokens unregistered; in-app only');
    }
    const firstError = tickets.find((t) => t?.status === 'error');
    throw new Error(firstError?.status === 'error' ? firstError.message : 'push send failed');
  }

  private async deliverSms(row: ClaimedRow, now: Date): Promise<void> {
    const templateId = row.sms_template_id ?? '';
    if (!isDltTemplateId(templateId)) {
      throw new PermanentFailure(`${templateId || 'no template'} is not a §15.3 DLT template`);
    }
    const rawVars = row.data?.smsVars;
    const vars =
      Array.isArray(rawVars) && rawVars.every((v) => typeof v === 'string') ? rawVars : null;
    if (!vars) throw new PermanentFailure('SMS row has no DLT variables');
    // The operator rejects text that differs from the registered template, so the text
    // we recorded must be exactly the template with these variables.
    if (renderDlt(templateId, vars) !== row.body) {
      throw new PermanentFailure(`SMS text does not match ${templateId}`);
    }
    const phone = await this.phoneFor(row);
    if (!phone) throw new PermanentFailure('recipient has no phone number');
    const { ref } = await this.deps.sms.send(phone, templateId, vars);
    await this.finish(row, 'sent', null, now, ref);
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

  private async stillClaimed(row: ClaimedRow): Promise<boolean> {
    const current = await this.deps.db
      .selectFrom('haven.notifications')
      .select(['status', 'attempts'])
      .where('id', '=', row.id)
      .executeTakeFirst();
    return current?.status === 'sending' && current.attempts === row.attempts;
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

  /** Only finishes the row if it is still this claim's — see the class comment. */
  private async finish(
    row: ClaimedRow,
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
      .where('id', '=', row.id)
      .where('status', '=', 'sending')
      .where('attempts', '=', row.attempts)
      .execute();
  }

  /** The error text never includes the body or recipient — only kind, channel and why. */
  private reportFailure(row: ClaimedRow, error: string): void {
    this.deps.reporter?.captureException(new Error(`notification failed: ${error}`), {
      tags: { kind: row.kind, channel: row.channel, notification_id: row.id },
    });
  }

  private async scheduleRetry(row: ClaimedRow, now: Date, error: string): Promise<void> {
    const delay = RETRY_DELAYS_MS[row.attempts - 1];
    if (delay === undefined) {
      // "then failed (and logged to Sentry)" (§9.7).
      this.deps.logger?.error(
        { notificationId: row.id, kind: row.kind, error },
        'notification failed',
      );
      this.reportFailure(row, error);
      await this.finish(row, 'failed', error);
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
      .where('status', '=', 'sending')
      .where('attempts', '=', row.attempts)
      .execute();
  }
}
