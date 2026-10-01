import { z } from 'zod';

/**
 * Environment validation, fails fast on boot (SDD §20.3, CLAUDE.md §4/§6).
 *
 * Scope grows one milestone at a time: a var is added here only when the API
 * *server process itself* (`server.ts`/`app.ts`) genuinely needs it — not
 * speculatively, and not just because some other script in the repo uses it.
 * `JWT_SECRET` was added in the API-foundation milestone because the authentication
 * hook (`apps/api/src/auth/jwt.ts`) now actually verifies tokens with it. Still not
 * validated here: OTP_PEPPER, DATA_ENCRYPTION_KEY, GOOGLE_CLIENT_IDS, SMS_PROVIDER,
 * EXPO_ACCESS_TOKEN, TURNSTILE_SECRET, SENTRY_DSN, WORKER_ENABLED — those wait for the
 * auth-flow/gate/notify milestones that actually make the *server* use them (OTP
 * request/verify and Google sign-in aren't implemented yet — only JWT
 * verification/issuance, which every later auth method shares, is).
 *
 * `DATA_ENCRYPTION_KEY` and `SEED_SUPER_ADMIN_EMAIL`/`SEED_WARDEN_EMAIL` are
 * deliberately NOT here even though `apps/api/scripts/seed.ts` needs them now — the
 * seed script is a separate process from the server and validates its own env
 * independently (see `scripts/seed.ts`), so running the API does not require seed-only
 * configuration, and running the seed script does not require JWT_SECRET etc. Do not
 * merge the two schemas "for consistency" — they gate different processes.
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
