import * as Sentry from '@sentry/node';
import { scrubSentryEvent } from '@haven/shared';
import type { Env } from '../config.js';

/**
 * Error reporting (SDD §8.4 "pino + Sentry", NFR-13 "errors reach Sentry within 1 min",
 * §9.7 failed notifications "logged to Sentry"). With no SENTRY_DSN it does nothing.
 * Nothing personal leaves: no user, IP, headers, cookies, bodies or query strings, and
 * every string is scrubbed with the §16.4 redaction list (`scrubSentryEvent`).
 */
export interface ErrorReporter {
  captureException(
    err: unknown,
    context?: { requestId?: string; tags?: Record<string, string> },
  ): void;
}

export const NOOP_REPORTER: ErrorReporter = { captureException: () => undefined };

export function createErrorReporter(env: Pick<Env, 'SENTRY_DSN' | 'APP_ENV'>): ErrorReporter {
  if (!env.SENTRY_DSN) return NOOP_REPORTER;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.APP_ENV,
    // No default integrations: nothing collects request data, IPs or users on its own.
    // Errors only: no performance traces (they carry URLs and timings per user).
    tracesSampleRate: 0,
    defaultIntegrations: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
    ],
    beforeSend: (event) =>
      scrubSentryEvent(event as unknown as Record<string, unknown>) as unknown as typeof event,
    beforeBreadcrumb: () => null,
  });
  return {
    captureException(err, context) {
      Sentry.withScope((scope) => {
        if (context?.requestId) scope.setTag('request_id', context.requestId);
        for (const [k, v] of Object.entries(context?.tags ?? {})) scope.setTag(k, v);
        Sentry.captureException(err);
      });
    },
  };
}
