import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { createAuthenticateHook } from './auth/authenticate.js';
import { RevocationCache } from './auth/principal-loader.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerVisitPolicies } from './visits/policy.js';
import { registerVisitRoutes } from './visits/routes.js';
import { registerHostVisitRoutes } from './visits/host-routes.js';
import { registerGatePolicies } from './gate/policy.js';
import { registerGateRoutes } from './gate/routes.js';
import type { GoogleIdTokenVerifier } from './auth/google.js';
import { RealGoogleIdTokenVerifier } from './auth/google.js';
import type { Env } from './config.js';
import type { Database } from './db/index.js';
import { pingDb } from './db/index.js';
import { AppError, toErrorEnvelope } from './lib/errors.js';
import type { Clock } from './lib/clock.js';
import { SystemClock } from './lib/clock.js';
import type { Logger } from './lib/logger.js';
import { parseDataEncryptionKey } from './lib/crypto.js';
import { generateRequestId } from './lib/request-id.js';
import { configureZodValidation, extractZodValidationIssues } from './lib/validation.js';
import { LocalDiskMediaStorage, type MediaStorage } from './gate/media.js';
import { NotificationWorker } from './notify/worker.js';
import { registerNotificationPolicies } from './notify/policy.js';
import { registerNotificationRoutes } from './notify/routes.js';
import { registerAccountRoutes } from './account/routes.js';
import { createBotVerifier, type BotVerifier } from './auth/bot-check.js';
import { createErrorReporter, type ErrorReporter } from './lib/error-reporter.js';
import { authorizationContext } from './auth/policy.js';
import { MediaUrlSigner } from './media/signing.js';
import { RulesProvider } from './rules/provider.js';
import { registerAdminPolicies } from './admin/policy.js';
import { registerAdminVisitRoutes } from './admin/visit-routes.js';
import { registerAdminPeopleRoutes } from './admin/people-routes.js';
import { registerAdminConfigRoutes } from './admin/config-routes.js';
import { registerAdminChargesRoutes } from './admin/charges-routes.js';
import { StreamHub } from './stream/hub.js';
import { registerIdempotencyPolicies } from './lib/idempotency.js';
import { JobRunner } from './jobs/runner.js';
import { registerStreamRoutes } from './stream/routes.js';
import { registerMediaRoutes } from './media/routes.js';
import { registerResidentPolicies, registerResidentRoutes } from './residents/routes.js';
import {
  ConsoleSmsProvider,
  ExpoPushSender,
  type PushSender,
  type SmsProvider,
} from './notify/senders.js';

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
  rateLimit?: { max: number; timeWindowMs: number; otpVerifyMaxPer10Min?: number };
  /** SDD T10 OTP CAPTCHA; tests inject a fake. Default: Turnstile, or the local bypass. */
  botVerifier?: BotVerifier;
  /** SDD §8.4 Sentry; tests inject a fake. Default: Sentry if SENTRY_DSN is set, else a no-op. */
  errorReporter?: ErrorReporter;
  /** Overridable so tests can use a `FakeClock`; real callers never pass this. */
  clock?: Clock;
  /**
   * Overridable so tests can inject a `FakeGoogleIdTokenVerifier` instead of making a
   * real network call to Google with real client credentials (see `auth/google.ts`).
   * Real callers never pass this — it's built from `env.GOOGLE_CLIENT_IDS`.
   */
  googleVerifier?: GoogleIdTokenVerifier;
  /** Where gate/profile photos are written (SDD §9.10). Real callers use
   * `media/storage.ts`'s choice (Supabase outside local); tests inject a fake. */
  mediaStorage: MediaStorage;
  /** SSE ping interval override for tests (SDD §9.9 default: 25 s). */
  streamPingMs?: number;
  /** Delivery adapters for the notification worker; default to Expo push and console SMS. */
  pushSender?: PushSender;
  smsSender?: SmsProvider;
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

  // DEC-011: the dev-login bypass must never be reachable outside a real local dev
  // process. `DEV_LOGIN_ENABLED=true` alone is not enough — this refuses to boot
  // unless NODE_ENV is also explicitly 'development', so a staging/production deploy
  // that accidentally inherits the flag (a copied .env, a misconfigured pipeline)
  // fails loudly at startup instead of quietly exposing an auth bypass.
  // DEC-021 / FINAL-QA-REPORT D-03: local disk is ephemeral and per-instance on a host
  // like Render; photos outside local live in Supabase Storage.
  if (env.APP_ENV !== 'local' && options.mediaStorage instanceof LocalDiskMediaStorage) {
    throw new Error(
      'LocalDiskMediaStorage is for APP_ENV=local only. Refusing to start — configure ' +
        'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (SDD §9.10).',
    );
  }

  if (env.DEV_LOGIN_ENABLED && process.env.NODE_ENV !== 'development') {
    throw new Error(
      'DEV_LOGIN_ENABLED=true requires NODE_ENV=development. Refusing to start — ' +
        'this bypass must never run against staging or production.',
    );
  }

  const checkDb = options.checkDb ?? pingDb;
  const reporter = options.errorReporter ?? createErrorReporter(env);
  const rateLimitConfig: NonNullable<BuildAppOptions['rateLimit']> =
    options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const clock = options.clock ?? new SystemClock();
  const googleVerifier =
    options.googleVerifier ?? new RealGoogleIdTokenVerifier(env.GOOGLE_CLIENT_IDS);
  const revocationCache = new RevocationCache(db, clock);
  const dataEncryptionKey = parseDataEncryptionKey(env.DATA_ENCRYPTION_KEY);
  const mediaSigner = new MediaUrlSigner(env.JWT_SECRET, env.API_BASE_URL, clock);
  const rules = new RulesProvider(db);
  // SDD §9.9/§11.7: LISTEN needs a session connection; the transaction pooler would drop
  // it. The hub self-tests and refuses streams if notifications don't arrive (DEC-028).
  const hub = new StreamHub(env.DATABASE_DIRECT_URL, logger, env.DATABASE_CA_CERT);
  revocationCache.onForgetUser((userId) => hub.disconnectUser(userId));

  const app = Fastify({
    // Cast: our pino instance (packages' own pino types) is runtime-compatible with
    // FastifyBaseLogger but TS sees a structural mismatch across the two packages'
    // separately-declared logger types (e.g. `msgPrefix`). Safe, well-known pattern.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    genReqId: () => generateRequestId(),
    // SDD §16.4 Input: "max body 3 MB (uploads), 64 KB otherwise". Multipart uploads
    // stream through @fastify/multipart's own 3 MB file limit (SECURITY-AUDIT SA-09).
    bodyLimit: 64 * 1024,
    // Number of trusted proxy hops: behind N proxies the client IP is read N entries
    // back in X-Forwarded-For; 0 ignores the header entirely (SECURITY-AUDIT SA-10).
    // proxy-addr calls this per address, hop 0 being the TCP peer.
    trustProxy: (_address: string, hop: number) => hop < env.TRUST_PROXY_HOPS,
  });

  configureZodValidation(app);

  // Every /v1 handler must call authorize() (CLAUDE.md §3.10, SDD §3.4). Each request runs
  // in its own context; a successful /v1 response whose request never reached
  // authorize() is replaced with a 500 and reported, so a missing check fails closed
  // (SECURITY-AUDIT SA-15). Preflight OPTIONS are CORS's, not a handler's.
  app.addHook('onRequest', (_request, _reply, done) => {
    authorizationContext.run({ authorized: false }, done);
  });
  // SDD §9.13: clients judge "now" by the server's clock (they only pre-check rules;
  // the server decides). Every response says what time the server thinks it is. Set at
  // the start of the request: an extra async onSend hook made Fastify try to write the
  // headers twice ("Reply was already sent", logged on every request).
  app.addHook('onRequest', (_request, reply, done) => {
    reply.header('X-Server-Time', clock.now().toISOString());
    done();
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const ctx = authorizationContext.getStore();
    if (!ctx || ctx.authorized) return payload;
    if (
      request.method === 'OPTIONS' ||
      !request.url.startsWith('/v1/') ||
      reply.statusCode >= 400
    ) {
      return payload;
    }
    const route = `${request.method} ${request.routeOptions.url ?? request.url.split('?')[0]}`;
    request.log.error({ route }, 'handler finished without authorize()');
    reporter.captureException(new Error(`handler finished without authorize(): ${route}`), {
      requestId: request.id,
    });
    reply.code(500).header('content-type', 'application/json; charset=utf-8');
    return JSON.stringify(
      toErrorEnvelope(
        new AppError('INTERNAL', 500, 'Something went wrong on our side.'),
        request.id,
      ),
    );
  });

  // Open event streams would keep the HTTP server from closing; end them first.
  app.addHook('preClose', async () => hub.close());

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
    exposedHeaders: ['X-Server-Time'],
  });

  // --- Cookies (SDD §9.5: haven_rt refresh cookie — plugin only; the auth module sets/clears it) ---
  await app.register(cookie);

  // --- Multipart (SDD §9.4: gate/profile photo uploads are multipart form fields) ---
  await app.register(multipart, { limits: { fileSize: 3 * 1024 * 1024 } });

  // --- Rate limiting (SDD §12.11 default; per-route overrides via route `config.rateLimit`) ---
  await app.register(rateLimit, {
    global: true,
    max: rateLimitConfig.max,
    timeWindow: rateLimitConfig.timeWindowMs,
  });

  // --- Authentication (SDD §8.2 step 2 of the pipeline) ---
  app.addHook(
    'onRequest',
    createAuthenticateHook({ jwtSecretBase64: env.JWT_SECRET, revocationCache, db }),
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

    // Fastify's own body/content-type parsing errors (e.g. FST_ERR_CTP_EMPTY_JSON_BODY
    // — a client sending `Content-Type: application/json` with no body) are genuine
    // client-input problems, not server bugs — map them to VALIDATION_FAILED (400)
    // rather than falling through to the generic 500 below, which would misreport a
    // bad request as "something went wrong on our side."
    if (
      typeof err.code === 'string' &&
      err.code.startsWith('FST_ERR_CTP_') &&
      typeof err.statusCode === 'number'
    ) {
      const validationError = new AppError(
        'VALIDATION_FAILED',
        400,
        'Request body could not be read.',
      );
      reply.status(400).send(toErrorEnvelope(validationError, request.id));
      return;
    }

    // Multipart limits (SDD §9.4 "max 3 MB"): @fastify/multipart throws its own 413
    // error from file.toBuffer(). It's the client's photo, not our failure: §12.2's
    // PHOTO_INVALID (400), never a 500.
    if (err.code === 'FST_REQ_FILE_TOO_LARGE' || err.code === 'FST_FILES_LIMIT') {
      const tooLarge = new AppError('PHOTO_INVALID', 400, 'Photo is too large (max 3 MB).');
      reply.status(400).send(toErrorEnvelope(tooLarge, request.id));
      return;
    }
    if (
      typeof err.code === 'string' &&
      /^FST_(INVALID_MULTIPART|PARTS_LIMIT|FIELDS_LIMIT|PROTO_VIOLATION|NO_FORM_DATA)/.test(
        err.code,
      )
    ) {
      const invalid = new AppError('VALIDATION_FAILED', 400, 'Upload could not be read.');
      reply.status(400).send(toErrorEnvelope(invalid, request.id));
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
    reporter.captureException(err, { requestId: request.id });
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

  // Notification outbox worker (SDD §9.7) — only in the one instance with
  // WORKER_ENABLED=true.
  const pushSender = options.pushSender ?? new ExpoPushSender(env.EXPO_ACCESS_TOKEN);
  const worker = env.WORKER_ENABLED
    ? new NotificationWorker({
        db,
        clock,
        push: pushSender,
        sms: options.smsSender ?? new ConsoleSmsProvider(env.APP_ENV),
        logger,
        reporter,
      })
    : null;
  if (worker) {
    worker.start();
    app.addHook('onClose', async () => worker.stop());
    // SDD §9.8 jobs when pg_cron isn't installed (DEC-014), plus the API-side media
    // purge, push receipts and account deletion workers (DEC-015).
    const jobs = new JobRunner({
      db,
      clock,
      logger,
      push: pushSender,
      mediaStorage: options.mediaStorage,
      reporter,
    });
    app.addHook('onReady', async () => {
      await jobs.start();
    });
    app.addHook('onClose', async () => jobs.stop());
  }

  // GET /ready — 200 only if the DB answers `select 1` within 1s and, where this
  // instance runs the worker, the worker loop ran in the last 30s (SDD §12.10).
  app.get('/ready', async (_request, reply) => {
    const dbOk = await Promise.race([
      checkDb(db),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);

    if (!dbOk) {
      reply.status(503);
      return { ok: false, db: false, bootTime: BOOT_TIME.toISOString() };
    }

    if (worker) {
      const last = worker.lastTickAt;
      const workerOk = last !== null && clock.now().getTime() - last.getTime() <= 30_000;
      if (!workerOk) {
        reply.status(503);
        return { ok: false, db: true, worker: false, bootTime: BOOT_TIME.toISOString() };
      }
    }

    return { ok: true, db: true, bootTime: BOOT_TIME.toISOString() };
  });

  // API versioning boundary (SDD §12): every business route registers inside this
  // prefix. The auth module is the first real feature module; visits/gate/admin follow
  // in later milestones.
  registerVisitPolicies();
  registerGatePolicies();
  registerIdempotencyPolicies();
  registerNotificationPolicies();
  registerResidentPolicies();
  registerAdminPolicies();

  await app.register(
    async (v1) => {
      await registerAuthRoutes(v1, {
        env,
        db,
        clock,
        googleVerifier,
        mediaStorage: options.mediaStorage,
        botVerifier: options.botVerifier ?? createBotVerifier(env),
        otpVerifyMaxPer10Min: rateLimitConfig.otpVerifyMaxPer10Min ?? 10,
        mediaSigner,
      });
      await registerVisitRoutes(v1, { db, clock });
      await registerHostVisitRoutes(v1, {
        db,
        clock,
        signer: mediaSigner,
        webBaseUrl: env.WEB_BASE_URL,
        rules,
        appEnv: env.APP_ENV,
      });
      await registerMediaRoutes(v1, { db, storage: options.mediaStorage, signer: mediaSigner });
      await registerNotificationRoutes(v1, { db, clock });
      await registerAccountRoutes(v1, { db, clock, cache: revocationCache });
      await registerResidentRoutes(v1, { db, clock, mediaStorage: options.mediaStorage });
      await registerGateRoutes(v1, {
        db,
        clock,
        dataEncryptionKey,
        mediaStorage: options.mediaStorage,
        webBaseUrl: env.WEB_BASE_URL,
        rules,
        appEnv: env.APP_ENV,
      });
      // Warden and office (SDD §12.9, /v1/admin with X-Hostel-Id).
      await registerAdminVisitRoutes(v1, {
        db,
        clock,
        signer: mediaSigner,
        rules,
        webBaseUrl: env.WEB_BASE_URL,
      });
      await registerAdminPeopleRoutes(v1, {
        db,
        clock,
        signer: mediaSigner,
        storage: options.mediaStorage,
        cache: revocationCache,
      });
      await registerAdminConfigRoutes(v1, {
        db,
        clock,
        rules,
        dataEncryptionKey,
        webBaseUrl: env.WEB_BASE_URL,
        cache: revocationCache,
        appEnv: env.APP_ENV,
      });
      await registerAdminChargesRoutes(v1, { db, clock, signer: mediaSigner, rules });
      await registerStreamRoutes(v1, { hub, cache: revocationCache, pingMs: options.streamPingMs });
    },
    { prefix: '/v1' },
  );

  return app;
}
