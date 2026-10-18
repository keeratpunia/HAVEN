import { useCallback, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';
import * as api from '../../../api/client.js';
import {
  GoogleSignInButton,
  googleSignInAvailable,
} from '../../../components/GoogleSignInButton.js';
import { useAuth } from '../../../lib/auth-context.js';
import { routeForUser } from '../../../lib/resident-route.js';

/**
 * Staff invite link (F11 step 3): "Invitee opens the link, signs in with Google using
 * that email; the role is granted. Any other email gets INVITE_EMAIL_MISMATCH."
 */
export default function StaffInvite() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const { refresh } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const onGoogle = useCallback(
    async (idToken: string) => {
      setError(null);
      try {
        await api.acceptSession(await api.googleSignIn(idToken, token));
        await refresh();
        const me = await api.getMe();
        if (me.type === 'user') router.replace(routeForUser(me) as never);
      } catch (err) {
        if (err instanceof api.ApiError && err.code === 'INVITE_EMAIL_MISMATCH') {
          setError(
            'This invite was sent to a different email address. Sign in with the Google account it was sent to.',
          );
        } else if (err instanceof api.ApiError && err.code === 'INVITE_EXPIRED') {
          setError('This invite has expired or was already used. Ask for a new one.');
        } else {
          setError(err instanceof api.ApiError ? err.message : 'Could not sign in. Try again.');
        }
      }
    },
    [token, refresh, router],
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        You're invited to HAVEN staff
      </Text>
      <Text style={styles.body}>
        Sign in with the Google account this invite was sent to. The link works for 48 hours.
      </Text>
      <GoogleSignInButton onIdToken={onGoogle} />
      {!googleSignInAvailable ? (
        <Text style={styles.body}>Google sign-in isn't set up in this build.</Text>
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: space.md,
    gap: space.md,
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
});
