import { z } from 'zod';

/**
 * Environment validation, fails fast on boot (SDD §20.3, CLAUDE.md §4/§6).
 *
 * Bootstrap-milestone scope only: this validates the variables the infrastructure
 * built so far actually needs (server, DB connection, CORS). It deliberately does NOT
 * yet validate the auth/crypto/provider variables listed in SDD §20.3
 * (JWT_SECRET, OTP_PEPPER, DATA_ENCRYPTION_KEY, GOOGLE_CLIENT_IDS, SMS_PROVIDER,
 * EXPO_ACCESS_TOKEN, TURNSTILE_SECRET, SENTRY_DSN, WORKER_ENABLED, SEED_*, etc.) —
 * those are added to this schema in the milestone that first uses them (M1 for auth
 * vars, M2 for gate/media vars, M3 for notify vars), per docs/IMPLEMENTATION-PLAN.md.
 * Do not widen this schema to "validate everything now" — an unused required var with
 * no real value to validate against just makes local setup harder for no safety gain
 * yet. Do not silently start the server if a var that IS listed below is missing.
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
