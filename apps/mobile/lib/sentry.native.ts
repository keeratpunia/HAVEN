/**
 * Android build: Sentry for React Native needs its Expo config plugin and a native
 * build, which this environment can't produce or run (no Android SDK, DEC-012). Until
 * then this is a no-op; the web build (sentry.ts) reports. docs/SECURITY-AUDIT.md SA-13.
 */
export function initSentry(): void {}
