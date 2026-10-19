/**
 * E-03: "Guest opens link inside WhatsApp, Instagram or Facebook's in-app browser —
 * Detect via user agent; show 'Open in Chrome' (Android intent URL) or 'Open in Safari'
 * instructions, because in-app browsers often block camera and location."
 *
 * Pure functions (no `navigator`), so the app passes the user agent and the tests pass
 * plain strings.
 */

export type InAppBrowserApp = 'whatsapp' | 'instagram' | 'facebook';

export interface InAppBrowser {
  app: InAppBrowserApp;
  os: 'android' | 'ios' | 'other';
}

const APPS: readonly [InAppBrowserApp, RegExp][] = [
  // Instagram before Facebook: Instagram's UA can also carry FB tokens.
  ['instagram', /\bInstagram\b/i],
  ['facebook', /\bFBAN\/|\bFBAV\/|\bFB_IAB\/|\bFBIOS\b|\[FB/i],
  ['whatsapp', /\bWhatsApp\b/i],
];

/** The in-app browser `userAgent` belongs to, or null for a normal browser. */
export function detectInAppBrowser(userAgent: string | null | undefined): InAppBrowser | null {
  if (!userAgent) return null;
  const match = APPS.find(([, re]) => re.test(userAgent));
  if (!match) return null;
  const os = /Android/i.test(userAgent)
    ? 'android'
    : /iPhone|iPad|iPod/i.test(userAgent)
      ? 'ios'
      : 'other';
  return { app: match[0], os };
}

/**
 * Android intent URL that opens `href` in Chrome (E-03 "Android intent URL"), with the
 * page itself as the fallback if Chrome isn't installed. Only http(s) URLs.
 */
export function chromeIntentUrl(href: string): string {
  const url = new URL(href);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('chromeIntentUrl: only http(s) URLs');
  }
  const scheme = url.protocol.slice(0, -1);
  const rest = `${url.host}${url.pathname}${url.search}${url.hash}`;
  return (
    `intent://${rest}#Intent;scheme=${scheme};package=com.android.chrome;` +
    `S.browser_fallback_url=${encodeURIComponent(href)};end`
  );
}
