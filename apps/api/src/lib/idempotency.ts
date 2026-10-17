import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { AppError } from './errors.js';

/**
 * SDD §9.12: "POSTs that change gate or visit state MUST carry Idempotency-Key: <uuid>
 * ... The API stores (key, principal, route) → (status, body) for 24 h in
 * idempotency_keys and replays the stored response on repeat." (24 h purge:
 * `haven.job_expire_sessions()`.)
 *
 * Only successful (2xx) outcomes are stored: a 4xx/5xx is either deterministic (the
 * repeat gets the same error anyway) or transient (the repeat should genuinely retry).
 * The key is scoped to the concrete path, so reusing a key on a different visit runs
 * that action rather than replaying the wrong visit's response.
 */

const KeySchema = z.string().uuid();

export interface IdempotentResult {
  status: number;
  body: unknown;
}

export async function runIdempotent(
  db: Kysely<Database>,
  request: FastifyRequest,
  reply: FastifyReply,
  handler: () => Promise<IdempotentResult>,
): Promise<void> {
  const header = request.headers['idempotency-key'];
  const parsed = KeySchema.safeParse(Array.isArray(header) ? header[0] : header);
  if (!parsed.success) {
    throw new AppError(
      'VALIDATION_FAILED',
      400,
      'An Idempotency-Key header (a UUID) is required.',
      {
        issues: [{ path: ['headers', 'idempotency-key'], message: 'Required UUID' }],
      },
    );
  }
  const principal = request.principal;
  const principalId =
    principal?.type === 'user'
      ? principal.userId
      : principal?.type === 'visitor'
        ? principal.visitorId
        : null;
  if (!principalId) throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');

  const route = `${request.method} ${request.url.split('?')[0]}`;
  const stored = await db
    .selectFrom('haven.idempotency_keys')
    .select(['status_code', 'response'])
    .where('key', '=', parsed.data)
    .where('principal_id', '=', principalId)
    .where('route', '=', route)
    .executeTakeFirst();
  if (stored) {
    reply.header('Idempotent-Replayed', 'true').status(stored.status_code).send(stored.response);
    return;
  }

  const result = await handler();
  if (result.status >= 200 && result.status < 300) {
    await db
      .insertInto('haven.idempotency_keys')
      .values({
        key: parsed.data,
        principal_id: principalId,
        route,
        status_code: result.status,
        response: JSON.stringify(result.body ?? null),
      })
      .onConflict((oc) => oc.columns(['key', 'principal_id', 'route']).doNothing())
      .execute();
  }
  reply.status(result.status).send(result.body);
}
