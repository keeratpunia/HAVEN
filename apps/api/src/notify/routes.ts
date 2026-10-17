import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  defaultScreenForKind,
  NotificationsQuerySchema,
  PushTokenBodySchema,
  type NotificationDTO,
} from '@haven/shared';
import type { ZodTypeProvider } from '../lib/validation.js';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { withTx } from '../lib/tx.js';
import { decodeCursor, pageOf } from '../lib/paging.js';
import { requireAuth } from '../auth/authenticate.js';
import { authorize } from '../auth/policy.js';
import type { UserPrincipal } from '../auth/principal.js';

/** SDD §12.4 notification endpoints (all `User` callers). */

const NOTIFICATION_ID_PARAMS = z.object({ id: z.string().uuid() });

export interface NotificationRoutesOptions {
  db: Kysely<Database>;
  clock: Clock;
}

function requireUser(principal: unknown): UserPrincipal {
  const p = principal as UserPrincipal | null | undefined;
  if (!p || p.type !== 'user') {
    throw new AppError('AUTH_REQUIRED', 401, 'Sign in as a resident to use notifications.');
  }
  return p;
}

export async function registerNotificationRoutes(
  app: FastifyInstance,
  opts: NotificationRoutesOptions,
): Promise<void> {
  const { db, clock } = opts;
  const api = app.withTypeProvider<ZodTypeProvider>();

  // POST /v1/me/push-tokens — register this device's Expo token (SDD §12.4).
  api.post(
    '/me/push-tokens',
    { schema: { body: PushTokenBodySchema }, preHandler: requireAuth },
    async (request, reply) => {
      const principal = requireUser(request.principal);
      authorize(principal, 'push_tokens.register', {
        recipientType: 'user',
        recipientId: principal.userId,
      });
      const now = clock.now();
      await withTx(db, { principal, requestId: request.id }, async (trx) => {
        // A token belongs to one device; if that device signs in as someone else, the
        // token moves with it (unique on expo_token).
        await trx
          .insertInto('haven.push_tokens')
          .values({
            user_id: principal.userId,
            expo_token: request.body.expoToken,
            platform: request.body.platform,
            last_seen_at: now,
          })
          .onConflict((oc) =>
            oc.column('expo_token').doUpdateSet({
              user_id: principal.userId,
              platform: request.body.platform,
              last_seen_at: now,
              disabled_at: null,
            }),
          )
          .execute();
      });
      reply.status(204).send();
    },
  );

  // GET /v1/me/notifications — paged in-app notifications (SDD §12.4).
  api.get(
    '/me/notifications',
    { schema: { querystring: NotificationsQuerySchema }, preHandler: requireAuth },
    async (request, reply) => {
      const principal = requireUser(request.principal);
      authorize(principal, 'notifications.read', {
        recipientType: 'user',
        recipientId: principal.userId,
      });
      const offset = decodeCursor(request.query.cursor);
      const limit = request.query.limit;
      const rows = await db
        .selectFrom('haven.notifications')
        .select(['id', 'kind', 'title', 'body', 'visit_id', 'data', 'created_at', 'opened_at'])
        .where('recipient_type', '=', 'user')
        .where('recipient_id', '=', principal.userId)
        // SMS rows are a delivery channel for a push the list already shows.
        .where('channel', 'in', ['push', 'in_app'])
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .offset(offset)
        .limit(limit + 1)
        .execute();

      const page = pageOf(rows, offset, limit);
      const items: NotificationDTO[] = page.items.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        body: r.body,
        visitId: r.visit_id,
        screen:
          typeof r.data?.screen === 'string'
            ? r.data.screen
            : defaultScreenForKind(r.kind, r.visit_id),
        createdAt: r.created_at.toISOString(),
        openedAt: r.opened_at ? r.opened_at.toISOString() : null,
      }));
      reply.send({ items, nextCursor: page.nextCursor });
    },
  );

  // POST /v1/notifications/:id/opened — "cancels SMS fallback" (SDD §12.4, §9.7).
  api.post(
    '/notifications/:id/opened',
    { schema: { params: NOTIFICATION_ID_PARAMS }, preHandler: requireAuth },
    async (request, reply) => {
      const principal = requireUser(request.principal);
      const row = await db
        .selectFrom('haven.notifications')
        .select(['id', 'recipient_type', 'recipient_id'])
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      // Someone else's notification is "not visible to caller" (SDD §12.2 NOT_FOUND).
      if (!row || row.recipient_type !== 'user' || row.recipient_id !== principal.userId) {
        throw new AppError('NOT_FOUND', 404, 'Notification not found.');
      }
      authorize(principal, 'notifications.open', {
        recipientType: row.recipient_type,
        recipientId: row.recipient_id,
      });

      const now = clock.now();
      await withTx(db, { principal, requestId: request.id }, async (trx) => {
        await trx
          .updateTable('haven.notifications')
          .set({ opened_at: now.toISOString() })
          .where('id', '=', row.id)
          .where('opened_at', 'is', null)
          .execute();
        await trx
          .updateTable('haven.notifications')
          .set({ status: 'cancelled', last_error: 'push was opened' })
          .where('cancel_if_opened', '=', row.id)
          .where('status', '=', 'queued')
          .execute();
      });
      reply.status(204).send();
    },
  );
}
