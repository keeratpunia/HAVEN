import { CONSENT_VERSION } from '@haven/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { ResidentDocumentKindSchema, ResidentMeBodySchema } from '@haven/shared';
import type { ZodTypeProvider } from '../lib/validation.js';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { requireAuth } from '../auth/authenticate.js';
import type { Principal, UserPrincipal } from '../auth/principal.js';
import { definePolicy } from '../auth/policy.js';
import { storeResidentDocument, type MediaStorage } from '../gate/media.js';
import {
  assertEditableDraft,
  attachResidentDocument,
  submitForVerification,
  upsertResidentDraft,
} from './service.js';

/** SDD §12.5 resident onboarding endpoints (F7, R-02..R-04). */

const SubmitBody = z
  .object({ consentVersion: z.literal(CONSENT_VERSION), consent: z.literal(true) })
  .strict();

let policiesRegistered = false;
export function registerResidentPolicies(): void {
  if (policiesRegistered) return;
  policiesRegistered = true;
  // Residents only ever edit their own onboarding record.
  definePolicy<{ userId: string }>(
    'residents.update_self',
    (p: Principal | null, r) => p?.type === 'user' && p.userId === r.userId,
  );
}
export function __resetResidentPoliciesForTests(): void {
  policiesRegistered = false;
}

function requireUser(principal: Principal | null | undefined): UserPrincipal {
  if (!principal || principal.type !== 'user') {
    throw new AppError('AUTH_REQUIRED', 401, 'Sign in with Google first.');
  }
  return principal;
}

export async function registerResidentRoutes(
  app: FastifyInstance,
  opts: { db: Kysely<Database>; clock: Clock; mediaStorage: MediaStorage },
): Promise<void> {
  const { db, clock } = opts;
  const api = app.withTypeProvider<ZodTypeProvider>();

  // POST /v1/residents/me { hostelId, room } → resident (status pending).
  api.post(
    '/residents/me',
    { schema: { body: ResidentMeBodySchema }, preHandler: requireAuth },
    async (request, reply) => {
      const principal = requireUser(request.principal);
      await upsertResidentDraft(
        { db },
        {
          principal,
          requestId: request.id,
          hostelId: request.body.hostelId,
          room: request.body.room,
        },
      );
      reply.status(201).send({ ok: true });
    },
  );

  // POST /v1/residents/me/documents — multipart `photo`, field `kind` (SDD §9.4).
  api.post('/residents/me/documents', { preHandler: requireAuth }, async (request, reply) => {
    const principal = requireUser(request.principal);
    await assertEditableDraft(db, principal.userId);
    const file = await request.file();
    if (!file) throw new AppError('PHOTO_REQUIRED', 400, 'A photo is required.');
    const kindField = file.fields.kind;
    const rawKind =
      kindField && !Array.isArray(kindField) && 'value' in kindField ? kindField.value : undefined;
    const kind = ResidentDocumentKindSchema.safeParse(rawKind);
    if (!kind.success) {
      throw new AppError('VALIDATION_FAILED', 400, 'Field "kind" must be id_card or selfie.', {
        issues: [{ path: ['kind'], message: 'Expected id_card or selfie' }],
      });
    }
    const raw = await file.toBuffer();
    const { photoId } = await storeResidentDocument({
      db,
      storage: opts.mediaStorage,
      clock,
      raw,
      userId: principal.userId,
      kind: kind.data === 'id_card' ? 'resident_id_card' : 'resident_selfie',
    });
    await attachResidentDocument(
      { db },
      { principal, requestId: request.id, kind: kind.data, photoId },
    );
    reply.send({ photoId });
  });

  // POST /v1/residents/me/submit — needs phone verified + both documents (SDD §12.5).
  // R-03 "consent": the checkbox's agreement and the notice version (SDD §16.3).
  api.post(
    '/residents/me/submit',
    { schema: { body: SubmitBody }, preHandler: requireAuth },
    async (request, reply) => {
      const principal = requireUser(request.principal);
      await submitForVerification(
        { db, clock },
        { principal, requestId: request.id, consentVersion: request.body.consentVersion },
      );
      reply.status(204).send();
    },
  );
}
