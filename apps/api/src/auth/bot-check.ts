import type { Env } from '../config.js';

/**
 * Bot protection for OTP requests (SDD §16.1 T10: "CAPTCHA (Cloudflare Turnstile)
 * after 3 requests from one IP"; §20.3 TURNSTILE_SECRET). The OTP service asks for a
 * passed challenge once an IP has made 3 requests in the per-IP window.
 */
export interface BotVerifier {
  /** True only for a token Cloudflare confirms. A missing token is never valid. */
  verify(token: string | undefined, ip: string | null): Promise<boolean>;
}

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export class TurnstileVerifier implements BotVerifier {
  constructor(
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async verify(token: string | undefined, ip: string | null): Promise<boolean> {
    if (!token) return false;
    const body = new URLSearchParams({ secret: this.secret, response: token });
    if (ip) body.set('remoteip', ip);
    try {
      const res = await this.fetchImpl(SITEVERIFY_URL, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { success?: unknown };
      return json.success === true;
    } catch {
      return false; // fail closed: an unreachable verifier never waves a request through
    }
  }
}

/** Local development only: there is no Turnstile site key on localhost. */
export class DevBypassBotVerifier implements BotVerifier {
  async verify(): Promise<boolean> {
    return true;
  }
}

/**
 * Turnstile whenever a secret is configured. Without one the bypass is allowed only in
 * APP_ENV=local; staging and production refuse to boot (fail closed).
 */
export function createBotVerifier(env: Pick<Env, 'APP_ENV' | 'TURNSTILE_SECRET'>): BotVerifier {
  if (env.TURNSTILE_SECRET) return new TurnstileVerifier(env.TURNSTILE_SECRET);
  if (env.APP_ENV === 'local') return new DevBypassBotVerifier();
  throw new Error(
    `TURNSTILE_SECRET is required when APP_ENV=${env.APP_ENV} (SDD T10: CAPTCHA on OTP requests).`,
  );
}
