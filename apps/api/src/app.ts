import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Env } from './config.js';
import type { Database } from './db/index.js';
import { pingDb } from './db/index.js';
import { AppError, toErrorEnvelope } from './lib/errors.js';
import type { Logger } from './lib/logger.js';
import { generateRequestId } from './lib/request-id.js';

export interface BuildAppOptions {
  env: Env;
  logger: Logger;
  db: Kysely<Database>;
  /** Overridable for tests that want to assert /ready's degraded-DB path without a live Postgres. */
  checkDb?: (db: Kysely<Database>) => Promise<boolean>;
}

const BOOT_TIME = new Date();

/**
 * Builds (but does not start) the Fastify instance.
 *
 * Request pipeline order matches SDD §8.2: request ID → rate limit → auth → Zod
 * validation → handler → authorize() → service → repository → serializer → response.
 * Only the first two stages exist in this bootstrap milestone (auth, validation
 * schemas, and every handler beyond health/ready belong to later milestones).
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { env, logger, db } = options;
  const checkDb = options.checkDb ?? pingDb;

  const app = Fastify({
    // Cast: our pino instance (packages' own pino types) is runtime-compatible with
    // FastifyBaseLogger but TS sees a structural mismatch across the two packages'
    // separately-declared logger types (e.g. `msgPrefix`). Safe, well-known pattern.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    genReqId: () => generateRequestId(),
  });

  app.register(helmet, {
    contentSecurityPolicy: env.APP_ENV === 'production' ? undefined : false,
  });

  app.register(cors, {
    origin: env.CORS_ORIGINS,
    credentials: true,
  });

  app.register(cookie);

  app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
  });

  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof AppError) {
      request.log.warn({ err, code: err.code }, 'request failed with AppError');
      reply.status(err.httpStatus).send(toErrorEnvelope(err, request.id));
      return;
    }

    // Zod/Fastify schema validation errors surface here with a `validation` field.
    if ('validation' in err && err.validation) {
      const validationError = new AppError('VALIDATION_FAILED', 400, 'Request validation failed', {
        issues: err.validation,
      });
      reply.status(400).send(toErrorEnvelope(validationError, request.id));
      return;
    }

    request.log.error({ err }, 'unhandled error');
    const internal = new AppError('INTERNAL', 500, 'Something went wrong on our side.');
    reply.status(500).send(toErrorEnvelope(internal, request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    const notFound = new AppError('NOT_FOUND', 404, 'Resource not found.');
    reply.status(404).send(toErrorEnvelope(notFound, request.id));
  });

  // GET /health — no DB call, for the load balancer (SDD §12.10).
  app.get('/health', async () => ({
    ok: true,
    version: process.env.npm_package_version ?? '0.0.0',
  }));

  // GET /ready — 200 only if the DB answers `select 1` within 1s (SDD §12.10).
  // The "worker loop ran in the last 30s" half of this check is added once the notify
  // worker exists (M2/M3) — tracked, not forgotten; see docs/TRACEABILITY.md.
  app.get('/ready', async (_request, reply) => {
    const dbOk = await Promise.race([
      checkDb(db),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);

    if (!dbOk) {
      reply.status(503);
      return { ok: false, db: false, bootTime: BOOT_TIME.toISOString() };
    }

    return { ok: true, db: true, bootTime: BOOT_TIME.toISOString() };
  });

  return app;
}
