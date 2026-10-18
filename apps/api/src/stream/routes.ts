import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from '../lib/validation.js';
import { AppError } from '../lib/errors.js';
import { authorize } from '../auth/policy.js';
import { hasHostelRole } from '../auth/principal.js';
import type { RevocationCache } from '../auth/principal-loader.js';
import type { HubEvent, StreamHub } from './hub.js';

/**
 * `GET /v1/stream?hostelId=` (SDD §9.9, §12.9: warden, office) — `text/event-stream`
 * with events `visit`, `gate` and `ping` every 25 s. Clients invalidate and refetch.
 *
 * Filtering (DEC-014): a warden gets visit and gate events for their hostel. Office
 * staff may see visits only through charges (SDD §3.3), so they get the connection and
 * pings but no visit or gate events. Every ping re-checks the session and the role, so
 * a revoked session or role ends the stream within 25 s, and at once when it is ended
 * through the API (FR-07).
 */

const Query = z.object({ hostelId: z.string().uuid() });
export const PING_MS = 25_000;

export async function registerStreamRoutes(
  app: FastifyInstance,
  opts: { hub: StreamHub; cache: RevocationCache | null; pingMs?: number },
): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get('/stream', { schema: { querystring: Query } }, async (request, reply) => {
    const principal = request.principal;
    if (!principal) throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
    const hostelId = request.query.hostelId;
    authorize(principal, 'stream.subscribe', { hostelId });
    if (principal.type !== 'user')
      throw new AppError('FORBIDDEN', 403, "You don't have permission to do that.");
    const isWarden = hasHostelRole(principal, hostelId, ['warden']);

    // Subscribe before answering, so no event between "connected" and LISTEN is lost.
    let ended = false;
    let timer: NodeJS.Timeout | null = null;
    const raw = reply.raw;
    const write = (event: string, data: unknown) => {
      if (!ended) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const end = () => {
      if (ended) return;
      ended = true;
      if (timer) clearInterval(timer);
      unsubscribe();
      raw.end();
    };
    const unsubscribe = await opts.hub.subscribe({
      hostelId,
      userId: principal.userId,
      accepts: () => isWarden,
      send: (e: HubEvent) =>
        e.t === 'visit'
          ? write('visit', { id: e.id, s: e.s })
          : write('gate', { id: e.id, online: e.online }),
      close: () => end(),
    });

    reply.hijack();
    raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    write('ping', { at: new Date().toISOString() });

    timer = setInterval(() => {
      void (async () => {
        if (opts.cache) {
          const { isValid, roles } = await opts.cache.check(principal.sessionId, principal.userId);
          const stillAllowed =
            isValid && hasHostelRole({ ...principal, roles }, hostelId, ['warden', 'office']);
          if (!stillAllowed) return end();
        }
        write('ping', { at: new Date().toISOString() });
      })().catch(() => end());
    }, opts.pingMs ?? PING_MS);

    request.raw.on('close', end);
  });
}
