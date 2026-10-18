/**
 * Scrubbing for anything sent to an error tracker (SDD §16.4 Logs: redact
 * authorization, cookie, phone, code, idToken, token, secret and photo paths; phones
 * masked only). Shared by the API and the app so both send Sentry the same nothing.
 */

/** Keys whose values are dropped wherever they appear (case-insensitive substring). */
export const SCRUB_KEY_PARTS = [
  'authorization',
  'cookie',
  'phone',
  'idtoken',
  'token',
  'secret',
  'password',
  'captcha',
  'email',
  'photopath',
] as const;
/** Keys dropped only on an exact (case-insensitive) match: too short to match inside others. */
export const SCRUB_KEYS_EXACT = ['code', 'otp', 'sig', 'q', 'number'] as const;

// Error codes such as AUTH_REQUIRED are our own safe enum; a key named exactly "code"
// whose value looks like one is kept so errors stay diagnosable.
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,40}$/;

const PATTERNS: [RegExp, string][] = [
  [/(?<!\d)(?:\+?91[\s-]?)?([6-9]\d{4})(\d{5})(?!\d)/g, '+91•••••$2'], // Indian mobiles → last 5
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]'], // JWTs
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/([?&](?:sig|exp|token|code|q|number)=)[^&\s]*/gi, '$1[redacted]'], // query credentials / PII
  [/\/invites\/[^/\s?]+/g, '/invites/[redacted]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
];

export function scrubText(text: string): string {
  return PATTERNS.reduce((out, [re, rep]) => out.replace(re, rep), text);
}

function isScrubKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    SCRUB_KEY_PARTS.some((s) => k.includes(s)) ||
    (SCRUB_KEYS_EXACT as readonly string[]).includes(k)
  );
}

/** Deep copy with sensitive keys removed and every string scrubbed. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[truncated]';
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'code' && typeof v === 'string' && SAFE_CODE.test(v)) out[k] = v;
      else if (isScrubKey(k)) out[k] = '[redacted]';
      else out[k] = scrubValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Sentry `beforeSend`: no user, no request headers, cookies, bodies or query strings,
 * no breadcrumbs with request data, and every remaining string scrubbed.
 */
export function scrubSentryEvent<T extends Record<string, unknown>>(event: T): T {
  const e: Record<string, unknown> = { ...event };
  delete e.user;
  delete e.server_name;
  const req = e.request as Record<string, unknown> | undefined;
  if (req) {
    e.request = {
      method: req.method,
      url: typeof req.url === 'string' ? scrubText(req.url.split('?')[0] ?? '') : undefined,
    };
  }
  if (Array.isArray(e.breadcrumbs)) {
    e.breadcrumbs = (e.breadcrumbs as Record<string, unknown>[]).map((b) => ({
      ...b,
      data: undefined,
      message: typeof b.message === 'string' ? scrubText(b.message) : b.message,
    }));
  }
  return scrubValue(e) as T;
}
