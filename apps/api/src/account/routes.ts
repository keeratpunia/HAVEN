import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { DeletionRequestBodySchema, type DeletionRequestDTO } from '@haven/shared';
import type { ZodTypeProvider } from '../lib/validation.js';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { withTx } from '../lib/tx.js';
import { AppError } from '../lib/errors.js';
import { REFRESH_COOKIE_NAME } from '../lib/cookies.js';
import { requireAuth } from '../auth/authenticate.js';
import { authorize } from '../auth/policy.js';
import type { RevocationCache } from '../auth/principal-loader.js';
import { blockersFor, recordDeletionRequest, signOutEverywhere, type Subject } from './deletion.js';

/**
 * `POST /v1/me/deletion-request` (SDD §12.4, §16.6, FR-09). Caller: any signed-in guest
 * or resident. Staff are refused: their access ends through deactivation (FR-07), not
 * self-deletion (docs/DECISIONS.md DEC-015).
 */
export async function registerAccountRoutes(
  app: FastifyInstance,
  opts: { db: Kysely<Database>; clock: Clock; cache: RevocationCache },
): Promise<void> {
  const { db, clock, cache } = opts;
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.post(
    '/me/deletion-request',
    { schema: { body: DeletionRequestBodySchema }, preHandler: requireAuth },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal || principal.type === 'device') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
      }
      const subject: Subject =
        principal.type === 'user'
          ? { type: 'user', id: principal.userId }
          : { type: 'visitor', id: principal.visitorId };
      authorize(principal, 'me.delete', {
        ownerType: subject.type,
        ownerId: subject.id,
        hasStaffRole: principal.type === 'user' && principal.roles.length > 0,
      });

      const now = clock.now();
      const result = await withTx(db, { principal, requestId: request.id }, async (trx) => {
        const blockers = await blockersFor(trx, subject, now);
        // §16.6 step 4: "Residents with unpaid charges can't delete until the office
        // clears them" — nothing is recorded and they stay signed in.
        if (blockers.unpaidInr > 0) {
          throw new AppError('CONFLICT', 409, 'Clear your unpaid charges before deleting.', {
            reason: 'UNPAID_CHARGES',
            unpaidInr: blockers.unpaidInr,
          });
        }
        await recordDeletionRequest(trx, subject, {
          reason: request.body.reason ?? null,
          now,
          waitingFor: blockers.waitingFor,
        });
        const sessionIds = await signOutEverywhere(trx, subject, now, 'account deletion requested');
        return { blockers, sessionIds };
      });

      // §16.6 step 1: "signs the user out everywhere" — effective on the next request.
      if (subject.type === 'user') cache.forgetUser(subject.id);
      cache.forgetSessions(result.sessionIds);

      const body: DeletionRequestDTO = {
        status: 'pending',
        waitingFor: result.blockers.waitingFor,
        waitUntil: result.blockers.waitUntil?.toISOString() ?? null,
      };
      reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/v1/auth' }).status(202).send(body);
    },
  );
}
