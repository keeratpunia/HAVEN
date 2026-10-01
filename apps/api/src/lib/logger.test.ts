import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

/** Captures every line a pino logger writes, so tests can inspect the raw JSON output. */
function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({ LOG_LEVEL: 'info', APP_ENV: 'production' }, stream);
  return { logger, lines };
}

describe('PII log redaction (CLAUDE.md §4, SDD §16.4)', () => {
  it('redacts a nested phone field', () => {
    const { logger, lines } = captureLogger();
    logger.info({ visitor: { phone: '+919876543210', name: 'Priya' } }, 'check-in');
    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry.visitor.phone).toBe('[redacted]');
    expect(entry.visitor.name).toBe('Priya'); // only PII fields are redacted, not the whole object
  });

  it('redacts the OTP verify request body field (SDD §9.5 POST /v1/auth/otp/verify)', () => {
    const { logger, lines } = captureLogger();
    logger.info({ req: { body: { phone: '+919876543210', code: '123456' } } }, 'otp verify');
    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry.req.body.code).toBe('[redacted]');
  });

  it('redacts a whole OTP object logged under a named wrapper key', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      { auth: { otp: { code: '123456', expiresAt: '2026-10-01T00:00:00Z' } } },
      'otp issued',
    );
    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry.auth.otp).toBe('[redacted]');
  });

  it('does NOT redact AppError.code (e.g. "AUTH_REQUIRED") — that is our own safe error enum, not PII', () => {
    // Regression test: a blanket '*.code' wildcard previously matched err.code too,
    // hiding every error's code from the logs — found by manually booting the server
    // and reading its own error-handler log line.
    const { logger, lines } = captureLogger();
    logger.warn(
      { err: { code: 'AUTH_REQUIRED', httpStatus: 401 } },
      'request failed with AppError',
    );
    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry.err.code).toBe('AUTH_REQUIRED');
  });

  it('redacts the Authorization header', () => {
    const { logger, lines } = captureLogger();
    logger.info({ req: { headers: { authorization: 'Bearer eyJhbGciOi...' } } }, 'request');
    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry.req.headers.authorization).toBe('[redacted]');
  });

  it('redacts the Cookie header', () => {
    const { logger, lines } = captureLogger();
    logger.info({ req: { headers: { cookie: 'haven_rt=supersecret' } } }, 'request');
    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry.req.headers.cookie).toBe('[redacted]');
  });

  it('redacts tokens and secrets', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        session: { refreshToken: 'rt_abc', accessToken: 'at_abc' },
        gate: { secret: 'gate-secret' },
      },
      'session issued',
    );
    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry.session.refreshToken).toBe('[redacted]');
    expect(entry.session.accessToken).toBe('[redacted]');
    expect(entry.gate.secret).toBe('[redacted]');
  });

  it('redacts a photo path', () => {
    const { logger, lines } = captureLogger();
    logger.info({ media: { photoPath: 'gate-photos/2026/10/abc.jpg' } }, 'photo stored');
    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry.media.photoPath).toBe('[redacted]');
  });

  it('does not redact unrelated fields', () => {
    const { logger, lines } = captureLogger();
    logger.info({ visit: { status: 'inside', hostelId: 'h1' } }, 'visit updated');
    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry.visit.status).toBe('inside');
    expect(entry.visit.hostelId).toBe('h1');
  });
});
