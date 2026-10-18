import { createElement, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';

/**
 * "Continue with Google" (SDD R-01, D8). Web uses Google Identity Services; the ID
 * token goes to `POST /auth/google`, which verifies it server-side (SDD §9.5). The
 * client id is public by design (CLAUDE.md §4). Renders nothing useful when no client
 * id is configured — the caller then offers the DEC-011 dev sign-in instead.
 *
 * Android uses `@react-native-google-signin/google-signin` per SDD §8.4; that native
 * module needs a development build with the Android OAuth client configured, which is
 * not available in this environment (docs/DECISIONS.md DEC-012).
 */

const WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';

interface GoogleIdApi {
  accounts: {
    id: {
      initialize(options: {
        client_id: string;
        callback: (r: { credential: string }) => void;
      }): void;
      renderButton(el: HTMLElement, options: Record<string, unknown>): void;
    };
  };
}

export const googleSignInAvailable = Platform.OS === 'web' && WEB_CLIENT_ID.length > 0;

export function GoogleSignInButton({ onIdToken }: { onIdToken: (idToken: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!googleSignInAvailable) return;
    const render = () => {
      const google = (window as unknown as { google?: GoogleIdApi }).google;
      if (!google || !ref.current) return;
      google.accounts.id.initialize({
        client_id: WEB_CLIENT_ID,
        callback: (response) => onIdToken(response.credential),
      });
      google.accounts.id.renderButton(ref.current, {
        theme: 'outline',
        size: 'large',
        text: 'continue_with',
        width: 280,
      });
    };
    const existing = document.getElementById('google-gsi');
    if (existing) {
      render();
      return;
    }
    const script = document.createElement('script');
    script.id = 'google-gsi';
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = render;
    script.onerror = () => setFailed(true);
    document.head.appendChild(script);
  }, [onIdToken]);

  if (!googleSignInAvailable) return null;
  return (
    <View style={styles.wrap}>
      {createElement('div', { ref })}
      {failed ? (
        <Text style={styles.error}>Couldn't load Google sign-in. Check your connection.</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: space.xs },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
});
