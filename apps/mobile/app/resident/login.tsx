import { useState } from 'react';
import { useRouter } from 'expo-router';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../api/client.js';
import { Button } from '../../components/Button.js';
import { useAuth } from '../../lib/auth-context.js';

const DEV_LOGIN_ENABLED = process.env.EXPO_PUBLIC_DEV_LOGIN_ENABLED === 'true';

/**
 * Resident sign-in. No real Google OAuth credentials are configured for this demo
 * environment (no `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`), so the only path wired up is
 * the dev-only email bypass (docs/DECISIONS.md DEC-011) — gated here by a public env
 * flag that mirrors the API's own `DEV_LOGIN_ENABLED`. The API independently refuses
 * to even register `/auth/dev-login` unless `NODE_ENV=development`, so this screen
 * being visible is not itself a way around that: it just calls an endpoint that
 * either exists (dev) or returns 404 (anywhere else).
 */
export default function ResidentLogin() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setError(null);
    setLoading(true);
    try {
      const result = await api.devLogin(email.trim());
      api.setAccessToken(result.accessToken);
      await refresh();
      router.replace('/resident/visits');
    } catch (err) {
      setError(
        err instanceof api.ApiError
          ? err.message
          : 'Could not sign in. Check the email and try again.',
      );
    } finally {
      setLoading(false);
    }
  }

  if (!DEV_LOGIN_ENABLED) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Resident sign-in</Text>
        <Text style={styles.body}>
          Google sign-in isn't configured in this environment, and the dev sign-in bypass is
          disabled.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Resident sign-in</Text>
      <Text style={styles.body}>Development only — sign in with a seeded resident's email.</Text>
      <View>
        <Text style={styles.label} nativeID="email-label">
          Email
        </Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="resident1@example.test"
          placeholderTextColor={color.textMuted}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          style={styles.input}
          accessibilityLabel="Email"
          accessibilityLabelledBy="email-label"
        />
      </View>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <View style={styles.action}>
        <Button label="Sign in" onPress={signIn} loading={loading} disabled={!email.trim()} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: space.md, gap: space.md, maxWidth: 420 },
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
  label: { fontSize: typeTokens.size.sm, color: color.textMuted, marginBottom: space.xxs },
  input: {
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: shape.radius,
    paddingHorizontal: space.sm,
    minHeight: 48,
    fontSize: typeTokens.size.body,
    color: color.text,
  },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
  action: { marginTop: space.sm },
});
