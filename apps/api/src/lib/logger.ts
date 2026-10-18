import pino from 'pino';
import type { Env } from '../config.js';

/**
 * Shared Pino logger. Redaction list is non-negotiable (CLAUDE.md §4, SDD §16.4):
 * never log authorization headers, cookies, phone numbers, OTP codes, tokens, secrets,
 * or photo paths. Extend this list in the same PR that adds a field matching one of
 * those categories — don't rely on remembering to do it later.
 */
/**
 * Deliberately wildcard-only (`*.field`), not bare top-level keys (`field`). Pino's
 * redactor replaces the *entire* matched value — a bare `'otp'` path would redact a
 * whole `{ otp: { code, expiresAt } }` object down to the literal string
 * `'[redacted]'` the moment anything is logged under a top-level key named `otp`,
 * destroying non-PII sibling fields (`expiresAt`) along with it, not just hiding the
 * PII.
 *
 * `code` is deliberately scoped to `req.body.code` only (the OTP-verify request body
 * field, SDD §9.5: `POST /v1/auth/otp/verify { phone, code, purpose }`), **not** a
 * blanket `'*.code'`. A generic wildcard also matches `AppError.code` (`'AUTH_REQUIRED'`,
 * `'FORBIDDEN'`, ...) wherever an error gets logged — found by manually booting the
 * server and reading its own error logs, where `err.code` came back as `[redacted]`.
 * That field is our own safe, non-PII enum; hiding it from every error log line
 * actively harms observability (SDD NFR-13) for no privacy benefit. `*.otp` already
 * covers the case where a whole OTP object (code + metadata) is logged under a named
 * wrapper key.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body.code',
  '*.phone',
  '*.invitedPhone',
  '*.otp',
  '*.idToken',
  '*.accessToken',
  '*.refreshToken',
  '*.token',
  '*.secret',
  '*.photoPath',
] as const;

/**
 * Request URLs carry credentials and personal data: invite tokens in the path
 * (`/v1/invites/<token>`), signed-URL signatures and phone or room searches in query
 * strings. The logged URL keeps the path only, with token segments masked
 * (SECURITY-AUDIT SA-08).
 */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const masked = path.replace(/\/invites\/[^/]+/g, '/invites/[redacted]');
  return q === -1 ? masked : `${masked}?[redacted]`;
}

interface LoggedRequest {
  method?: string;
  url?: string;
  hostname?: string;
  host?: string;
  ip?: string;
  socket?: { remoteAddress?: string; remotePort?: number };
}

/** Fastify's default request fields, with the URL redacted. */
export function serializeRequest(req: LoggedRequest) {
  return {
    method: req.method,
    url: redactUrl(req.url),
    host: req.host ?? req.hostname,
    remoteAddress: req.ip ?? req.socket?.remoteAddress,
  };
}

export function createLogger(
  env: Pick<Env, 'LOG_LEVEL' | 'APP_ENV'>,
  /** Test-only: capture output on a custom stream instead of stdout/pino-pretty. */
  destination?: NodeJS.WritableStream,
) {
  return pino(
    {
      level: env.LOG_LEVEL,
      redact: {
        paths: [...REDACT_PATHS],
        censor: '[redacted]',
      },
      serializers: { req: serializeRequest },
      transport:
        !destination && env.APP_ENV === 'local'
          ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
          : undefined,
    },
    destination,
  );
}

export type Logger = ReturnType<typeof createLogger>;
