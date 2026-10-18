import { createElement, useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';

/**
 * Cloudflare Turnstile (SDD §16.1 T10: "CAPTCHA (Cloudflare Turnstile) after 3 requests
 * from one IP"). Shown only when the API answers an OTP request with
 * RATE_LIMITED / CAPTCHA_REQUIRED; the token goes back with the retried request. The
 * site key is public by design (§16.4 App). Web build; the native build lives in
 * TurnstileChallenge.native.tsx.
 */

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render(el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void }): string;
  remove(id: string): void;
}

function loadScript(): Promise<TurnstileApi> {
  const w = window as unknown as { turnstile?: TurnstileApi };
  if (w.turnstile) return Promise.resolve(w.turnstile);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () =>
      w.turnstile ? resolve(w.turnstile) : reject(new Error('turnstile')),
    );
    script.addEventListener('error', () => reject(new Error('turnstile')));
    if (!existing) {
      (script as HTMLScriptElement).src = SCRIPT_SRC;
      (script as HTMLScriptElement).async = true;
      document.head.appendChild(script);
    }
  });
}

export function TurnstileChallenge({
  message,
  onToken,
}: {
  /** The API's own message for the challenge. */
  message: string;
  onToken: (token: string) => void;
}) {
  const host = useRef<HTMLElement | null>(null);
  const siteKey = process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;

  useEffect(() => {
    if (!siteKey || !host.current) return;
    let widgetId: string | null = null;
    let api: TurnstileApi | null = null;
    let cancelled = false;
    loadScript()
      .then((t) => {
        if (cancelled || !host.current) return;
        api = t;
        widgetId = t.render(host.current, { sitekey: siteKey, callback: onToken });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (api && widgetId) api.remove(widgetId);
    };
    // onToken is stable for the life of one challenge.
  }, [siteKey]);

  return (
    <View style={styles.box} accessibilityRole="alert">
      <Text style={styles.text}>{message}</Text>
      {siteKey ? createElement('div', { ref: host }) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: space.sm },
  text: { fontSize: typeTokens.size.sm, color: color.text },
});
