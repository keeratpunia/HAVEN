import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { ZodTypeProvider } from '../lib/validation.js';
import type { Database } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import type { MediaStorage } from '../gate/media.js';
import type { MediaUrlSigner } from './signing.js';

/**
 * `GET /v1/media/:id?exp&sig` — serves one photo for a signed URL minted by
 * `MediaUrlSigner` (see that module for why the signature, not a bearer token, is the
 * credential). Every failure is the same 404 so a probe learns nothing about which
 * media ids exist.
 */

const Params = z.object({ id: z.string().uuid() });
const Query = z.object({ exp: z.coerce.number().int().positive(), sig: z.string().min(1) });

export async function registerMediaRoutes(
  app: FastifyInstance,
  opts: { db: Kysely<Database>; storage: MediaStorage; signer: MediaUrlSigner },
): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    '/media/:id',
    { schema: { params: Params, querystring: Query } },
    async (request, reply) => {
      const notFound = new AppError('NOT_FOUND', 404, 'Photo not found or link expired.');
      if (!opts.signer.verify(request.params.id, request.query.exp, request.query.sig))
        throw notFound;

      const media = await opts.db
        .selectFrom('haven.media')
        .select(['path', 'deleted_at'])
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!media || media.deleted_at) throw notFound;

      const bytes = await opts.storage.get(media.path);
      if (!bytes) throw notFound;

      reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'private, max-age=120')
        // The app runs on a different origin than the API; helmet's default
        // `same-origin` would stop <img> from loading these.
        .header('Cross-Origin-Resource-Policy', 'cross-origin')
        .send(bytes);
    },
  );
}
