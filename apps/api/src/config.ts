import { z } from 'zod';

/**
 * Environment validation, fails fast on boot (SDD §20.3, CLAUDE.md §4/§6).
 *
 * Scope grows one milestone at a time: a var is added here only when the API
 * *server process itself* (`server.ts`/`app.ts`) genuinely needs it — not
 * speculatively, and not just because some other script in the repo uses it.
 * `JWT_SECRET` was added in the API-foundation milestone because the authentication
 * hook (`apps/api/src/auth/jwt.ts`) now actually verifies tokens with it. `OTP_PEPPER`,
 * `GOOGLE_CLIENT_IDS`, and `SMS_PROVIDER` were added in the authentication milestone
 * because the OTP and Google sign-in handlers now use them. `WORKER_ENABLED` and
 * `EXPO_ACCESS_TOKEN` were added in the resident-app milestone, when the notification
 * worker started delivering push. Still not validated here: TURNSTILE_SECRET,
 * SENTRY_DSN — they wait for the milestones that make the *server* use them.
 *
 * `SEED_SUPER_ADMIN_EMAIL`/`SEED_WARDEN_EMAIL` are deliberately NOT here even though
 * `apps/api/scripts/seed.ts` needs them now — the seed script is a separate process
 * from the server and validates its own env independently (see `scripts/seed.ts`), so
 * running the API does not require seed-only configuration, and running the seed
 * script does not require JWT_SECRET etc. Do not merge the two schemas "for
 * consistency" — they gate different processes.
 *
 * `DATA_ENCRYPTION_KEY` was added in the gate milestone — the server now genuinely
 * encrypts/decrypts gate secrets with it (`gate/secret.ts`).
 */
const EnvSchema = z.object({
  APP_ENV: z.enum(['local', 'staging', 'production']).default('local'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Pooler connection (port 6543) — used for normal queries (SDD §11.7).
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Direct connection (port 5432) — reserved for the future LISTEN/SSE connection
  // (SDD §9.9); not used by anything yet, but validated now so it's configured
  // correctly from day one rather than discovered missing in M3.
  DATABASE_DIRECT_URL: z.string().min(1, 'DATABASE_DIRECT_URL is required'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  API_BASE_URL: z.string().url().default('http://localhost:8080'),
  WEB_BASE_URL: z.string().url().default('http://localhost:8081'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:8081')
    .transform((value) => value.split(',').map((origin) => origin.trim())),
  COOKIE_DOMAIN: z.string().default('localhost'),

  // HS256 access/refresh JWT signing key (SDD §9.5). 32+ random bytes, base64 — same
  // format convention as DATA_ENCRYPTION_KEY, validated the same way.
  JWT_SECRET: z
    .string()
    .min(1, 'JWT_SECRET is required')
    .refine((value) => Buffer.from(value, 'base64').length >= 32, {
      message: 'JWT_SECRET must decode to at least 32 bytes (base64)',
    }),

  // HMAC pepper for OTP code hashing (SDD §9.5: `HMAC_SHA256(OTP_PEPPER, phone + '|' +
  // code)`). Added this milestone — the OTP request/verify handlers now use it.
  OTP_PEPPER: z
    .string()
    .min(1, 'OTP_PEPPER is required')
    .refine((value) => Buffer.from(value, 'base64').length >= 32, {
      message: 'OTP_PEPPER must decode to at least 32 bytes (base64)',
    }),

  // Allowed Google OAuth client IDs (web + Android), comma list — the `aud` the
  // verified Google ID token must match (SDD §9.5).
  GOOGLE_CLIENT_IDS: z
    .string()
    .min(1, 'GOOGLE_CLIENT_IDS is required')
    .transform((value) => value.split(',').map((id) => id.trim())),

  // `console` prints OTP codes to stdout for local/dev convenience (SDD §9.5); `msg91`
  // sends real SMS. Never `msg91` without real credentials, never `console` in
  // production (enforced in otp-service.ts, not just by this enum).
  SMS_PROVIDER: z.enum(['console', 'msg91']).default('console'),

  // AES-256-GCM key for gate secrets (SDD §9.1, CLAUDE.md §4). Base64, must decode to
  // exactly 32 bytes (`parseDataEncryptionKey` in `lib/crypto.ts` enforces the exact
  // length; this just fails boot fast if it's obviously the wrong shape).
  DATA_ENCRYPTION_KEY: z
    .string()
    .min(1, 'DATA_ENCRYPTION_KEY is required')
    .refine((value) => Buffer.from(value, 'base64').length === 32, {
      message: 'DATA_ENCRYPTION_KEY must decode to exactly 32 bytes (base64)',
    }),

  // Local-disk substitute for Supabase Storage (gate/media.ts's `LocalDiskMediaStorage`
  // — see that module's comment: this environment has no reliable Supabase/Docker
  // storage connection, same constraint as DEC-004's embedded-postgres substitute).
  MEDIA_STORAGE_DIR: z.string().default('.media-storage'),

  // Dev-only resident/staff sign-in bypass (demo milestone, docs/DECISIONS.md DEC-011):
  // issues real tokens for an existing `users` row by email, no Google ID token
  // required. Registered as a route only when true. `buildApp` additionally refuses
  // to boot with this on unless `process.env.NODE_ENV === 'development'` — a second,
  // independent gate (this flag alone is not enough to turn the bypass on) so it can
  // never be left on by accident in a staging/production deploy.
  // `z.coerce.boolean()` would treat the *string* "false" as truthy (any non-empty
  // string coerces to `true` in JS) — exactly the footgun this flag cannot afford.
  DEV_LOGIN_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  // Notification outbox worker (SDD §9.7): "in the API process when
  // WORKER_ENABLED=true" — exactly one running instance must have it on. Defaults off
  // so a test or a second replica never starts a competing loop by accident.
  WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // Expo push access token (SDD §20.3). Optional: Expo accepts unauthenticated sends
  // unless the project enables "enhanced security for push".
  EXPO_ACCESS_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cachedEnv: Env | undefined;

/** Parses and validates process.env once per process. Throws (stops boot) on failure. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cachedEnv) return cachedEnv;
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cachedEnv = result.data;
  return cachedEnv;
}

/** Test-only: clears the cache so a test can reload with different env values. */
export function __resetEnvCacheForTests(): void {
  cachedEnv = undefined;
}
