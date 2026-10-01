import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { createAuthenticateHook } from './auth/authenticate.js';
import { RevocationCache } from './auth/principal-loader.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerVisitPolicies } from './visits/policy.js';
import type { GoogleIdTokenVerifier } from './auth/google.js';
import { RealGoogleIdTokenVerifier } from './auth/google.js';
import type { Env } from './config.js';
import type { Database } from './db/index.js';
import { pingDb } from './db/index.js';
import { AppError, toErrorEnvelope } from './lib/errors.js';
import type { Clock } from './lib/clock.js';
import { SystemClock } from './lib/clock.js';
import type { Logger } from './lib/logger.js';
import { generateRequestId } from './lib/request-id.js';
import { configureZodValidation, extractZodValidationIssues } from './lib/validation.js';

export interface BuildAppOptions {
  env: Env;
  logger: Logger;
  db: Kysely<Database>;
  /** Overridable for tests that want to assert /ready's degraded-DB path without a live Postgres. */
  checkDb?: (db: Kysely<Database>) => Promise<boolean>;
  /**
   * Overridable for tests that need many requests in a tight window (SDD §12.11's
   * global default, "120 requests/min", is impractical to actually hit in a fast
   * test). Real callers never pass this — `server.ts` always uses the SDD default.
   */
  rateLimit?: { max: number; timeWindowMs: number };
  /** Overridable so tests can use a `FakeClock`; real callers never pass this. */
  clock?: Clock;
  /**
   * Overridable so tests can inject a `FakeGoogleIdTokenVerifier` instead of making a
   * real network call to Google with real client credentials (see `auth/google.ts`).
   * Real callers never pass this — it's built from `env.GOOGLE_CLIENT_IDS`.
   */
  googleVerifier?: GoogleIdTokenVerifier;
}

const BOOT_TIME = new Date();
const DEFAULT_RATE_LIMIT = { max: 120, timeWindowMs: 60_000 }; // SDD §12.11: "Default per IP 120 requests/min"

/**
 * Builds (but does not start) the Fastify instance.
 *
 * Request pipeline, matching SDD §8.2 exactly: request ID → rate limit → auth
 * (verify JWT, load principal) → Zod validation → handler → authorize() → service →
 * repository → serializer → response.
 *   - Request ID: `genReqId` below (SDD §9.11 format), present before any hook runs.
 *   - Rate limit: the global `@fastify/rate-limit` `onRequest` hook, registered first.
 *   - Auth: `authenticate` (`src/auth/authenticate.ts`), an `onRequest` hook
 *     registered second — Fastify runs `onRequest` hooks in registration order, so it
 *     always sees a post-rate-limit request, and always runs before Fastify's own
 *     validation stage (which is a later lifecycle phase, not a hook this file
 *     orders).
 *   - Validation: Zod, wired via `configureZodValidation` — individual routes supply
 *     their own `schema.body`/`schema.querystring`/`schema.params`; none exist yet.
 *   - `authorize()`, service, repository, serializer: per-handler concerns
 *     (`src/auth/policy.ts`, `src/lib/serializer.ts`) — no feature module exists yet
 *     to call them from a real route.
 *
 * All business routes register under the `/v1` prefix (SDD §12: "REST over HTTPS at
 * https://api.<domain>/v1"); `/health` and `/ready` deliberately stay unprefixed
 * (SDD §12.10 lists them separately from the versioned API).
 *
 * **Why this function is `async` and every `register()` call below is `await`ed:**
 * Fastify normally lets you call `app.register(plugin)` without awaiting it and still
 * rely on avvio's internal boot ordering before `.ready()`/`.listen()`. In practice,
 * with `@fastify/rate-limit` specifically, routes declared synchronously right after
 * an un-awaited `app.register(rateLimit, ...)` can end up attached before the plugin's
 * global `onRequest` hook is actually wired — the server still boots and responds
 * normally, but the rate limiter silently never triggers, for every request, with no
 * error anywhere. This was caught by this milestone's own rate-limit test, confirmed
 * by bisection (awaiting the registration alone fixes it), and is exactly the kind of
 * silent security-control failure that must not ship — so every plugin here is
 * awaited before any route is declared, not just rate-limit, since the same class of
 * bug could in principle hit helmet/cors/cookie too.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { env, logger, db } = options;
  const checkDb = options.checkDb ?? pingDb;
  const rateLimitConfig = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const clock = options.clock ?? new SystemClock();
  const googleVerifier =
    options.googleVerifier ?? new RealGoogleIdTokenVerifier(env.GOOGLE_CLIENT_IDS);
  const revocationCache = new RevocationCache(db, clock);

  const app = Fastify({
    // Cast: our pino instance (packages' own pino types) is runtime-compatible with
    // FastifyBaseLogger but TS sees a structural mismatch across the two packages'
    // separately-declared logger types (e.g. `msgPrefix`). Safe, well-known pattern.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    genReqId: () => generateRequestId(),
  });

  configureZodValidation(app);

  // --- Security headers (SDD §16.4) ---
  await app.register(helmet, {
    // This is a JSON API, not an HTML-serving app — `default-src 'none'` is
    // appropriate regardless of environment (there is no inline-script dev friction
    // to relax, unlike a web app). frame-ancestors 'none' and the HSTS max-age match
    // the SDD's literal values; X-Content-Type-Options is one of helmet's defaults.
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true },
  });

  // --- CORS (SDD §16.4: "Allow only https://app.<domain> (and localhost in dev); credentials true") ---
  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    credentials: true,
  });

  // --- Cookies (SDD §9.5: haven_rt refresh cookie — plugin only; the auth module sets/clears it) ---
  await app.register(cookie);

  // --- Rate limiting (SDD §12.11 default; per-route overrides via route `config.rateLimit`) ---
  await app.register(rateLimit, {
    global: true,
    max: rateLimitConfig.max,
    timeWindow: rateLimitConfig.timeWindowMs,
  });

  // --- Authentication (SDD §8.2 step 2 of the pipeline) ---
  app.addHook(
    'onRequest',
    createAuthenticateHook({ jwtSecretBase64: env.JWT_SECRET, revocationCache }),
  );

  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof AppError) {
      request.log.warn({ err, code: err.code }, 'request failed with AppError');
      reply.status(err.httpStatus).send(toErrorEnvelope(err, request.id));
      return;
    }

    const zodIssues = extractZodValidationIssues(err);
    if (zodIssues) {
      const validationError = new AppError('VALIDATION_FAILED', 400, 'Request validation failed', {
        issues: zodIssues,
      });
      reply.status(400).send(toErrorEnvelope(validationError, request.id));
      return;
    }

    // AJV/Fastify-native schema validation errors (not expected once every route uses
    // Zod, but kept as a safety net rather than falling through to a bare 500).
    if ('validation' in err && err.validation) {
      const validationError = new AppError('VALIDATION_FAILED', 400, 'Request validation failed', {
        issues: err.validation,
      });
      reply.status(400).send(toErrorEnvelope(validationError, request.id));
      return;
    }

    if (err.statusCode === 429) {
      // @fastify/rate-limit throws its own error shape; map it to SDD §12.2's
      // RATE_LIMITED envelope instead of leaking the plugin's own message/format.
      // Retry-After is set by the plugin itself via `reply.header`, before this
      // handler runs — this rewrites the body only, not the headers.
      const rateLimited = new AppError('RATE_LIMITED', 429, 'Too many requests. Please slow down.');
      reply.status(429).send(toErrorEnvelope(rateLimited, request.id));
      return;
    }

    // No stack traces in any response, ever (CLAUDE.md §4, SDD §16.4 "Output: ...
    // no stack traces in responses") — including in non-production environments
    // reachable over a network. The full error still goes to the log.
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

  // API versioning boundary (SDD §12): every business route registers inside this
  // prefix. The auth module is the first real feature module; visits/gate/admin follow
  // in later milestones.
  // The visits module has no HTTP routes yet (service + repository only, see
  // docs/TRACEABILITY.md) — its authorize() policies still register at boot so the
  // mechanism is ready the moment a route calls it, same as every other module.
  registerVisitPolicies();

  await app.register(
    async (v1) => {
      await registerAuthRoutes(v1, { env, db, clock, googleVerifier });
    },
    { prefix: '/v1' },
  );

  return app;
}
