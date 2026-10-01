import pino from 'pino';
import type { Env } from '../config.js';

/**
 * Shared Pino logger. Redaction list is non-negotiable (CLAUDE.md §4, SDD §16.4):
 * never log authorization headers, cookies, phone numbers, OTP codes, tokens, secrets,
 * or photo paths. Extend this list in the same PR that adds a field matching one of
 * those categories — don't rely on remembering to do it later.
 */
export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'APP_ENV'>) {
  return pino({
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.phone',
        '*.invitedPhone',
        '*.code',
        '*.otp',
        '*.idToken',
        '*.accessToken',
        '*.refreshToken',
        '*.token',
        '*.secret',
        '*.photoPath',
      ],
      censor: '[redacted]',
    },
    transport:
      env.APP_ENV === 'local'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
        : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
