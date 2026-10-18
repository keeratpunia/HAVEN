import * as Sentry from '@sentry/browser';
import { scrubSentryEvent } from '@haven/shared';

/**
 * Error reporting for the web app (SDD §8.4, §20.3 EXPO_PUBLIC_SENTRY_DSN). With no DSN
 * it does nothing. Only uncaught errors and unhandled rejections are sent, with no user,
 * no breadcrumbs (they hold URLs, clicks and console text) and every string scrubbed
 * with the §16.4 redaction list. The Android build is sentry.native.ts.
 */
let started = false;

export function initSentry(): void {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (started || !dsn) return;
  started = true;
  Sentry.init({
    dsn,
    environment: process.env.EXPO_PUBLIC_APP_ENV ?? 'local',
    defaultIntegrations: false,
    integrations: [Sentry.globalHandlersIntegration()],
    tracesSampleRate: 0,
    beforeSend: (event) =>
      scrubSentryEvent(event as unknown as Record<string, unknown>) as unknown as typeof event,
    beforeBreadcrumb: () => null,
  });
}
