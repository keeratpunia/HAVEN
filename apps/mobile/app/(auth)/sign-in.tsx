import { useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../services/api-client.js';
import { Button } from '../../components/Button.js';
import { GoogleSignInButton, googleSignInAvailable } from '../../components/GoogleSignInButton.js';
import { useAuth } from '../../lib/auth-context.js';
import { routeForUser } from '../../lib/resident-route.js';
import { IS_TEST_VERSION } from '../../lib/app-env.js';
import { PhoneInput } from '../../components/PhoneInput.js';
import { OtpInput } from '../../components/OtpInput.js';

const DEV_LOGIN_ENABLED = process.env.EXPO_PUBLIC_DEV_LOGIN_ENABLED === 'true';

/**
 * R-01 Sign in (SDD §13.4): "HAVEN intro, one line per role — Continue with Google".
 * When no Google client id is configured, the dev-only email sign-in (docs/DECISIONS.md
 * DEC-011) stands in; the API itself only registers that route under
 * NODE_ENV=development.
 */
export default function SignIn() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = useCallback(async () => {
    await refresh();
    const me = await api.getMe();
    if (me.type !== 'user') return;
    router.replace(routeForUser(me) as never);
  }, [refresh, router]);

  const onGoogle = useCallback(
    async (idToken: string) => {
      setError(null);
      setLoading(true);
      try {
        await api.acceptSession(await api.googleSignIn(idToken));
        await finish();
      } catch (err) {
        setError(err instanceof api.ApiError ? err.message : 'Could not sign in. Try again.');
      } finally {
        setLoading(false);
      }
    },
    [finish],
  );

  // Phase 1 test version (DEC-028, DEC-032): no Google sign-in. Residents and staff sign
  // in with their phone and a code, like the pilot's own phone step; the API accepts only
  // the test numbers and refuses all of this outside the test version.
  async function testNumberSignIn() {
    setError(null);
    setLoading(true);
    try {
      await api.acceptSession(await api.testSignIn(`+91${phone}`, code.trim()));
      await finish();
    } catch (err) {
      if (err instanceof api.ApiError && err.code === 'TEST_PHONES_ONLY') {
        setStep('phone');
        setCode('');
      }
      setError(err instanceof api.ApiError ? err.message : 'Could not sign in. Try again.');
    } finally {
      setLoading(false);
    }
  }

  async function devSignIn() {
    setError(null);
    setLoading(true);
    try {
      await api.acceptSession(await api.devLogin(email.trim()));
      await finish();
    } catch (err) {
      setError(err instanceof api.ApiError ? err.message : 'Could not sign in. Try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        Sign in to HAVEN
      </Text>
      <View style={styles.roles}>
        <Text style={styles.body}>Residents: invite guests and approve visitors at the gate.</Text>
        <Text style={styles.body}>
          Warden and office: manage the hostel, approvals and charges.
        </Text>
      </View>

      {IS_TEST_VERSION && step === 'phone' ? (
        <View style={styles.phone}>
          <PhoneInput value={phone} onChange={setPhone} />
          <Button
            label="Send code"
            onPress={() => {
              setError(null);
              setCode('');
              setStep('code');
            }}
            disabled={phone.length !== 10}
          />
        </View>
      ) : null}
      {IS_TEST_VERSION && step === 'code' ? (
        <View style={styles.phone}>
          <Text style={styles.body}>Enter the 6-digit code sent to +91 {phone}</Text>
          <OtpInput value={code} onChange={setCode} />
          <Button
            label="Verify"
            onPress={testNumberSignIn}
            loading={loading}
            disabled={code.trim().length !== 6}
          />
          <Button
            label="Change number"
            variant="ghost"
            fullWidth={false}
            onPress={() => {
              setError(null);
              setStep('phone');
            }}
          />
        </View>
      ) : null}

      <GoogleSignInButton onIdToken={onGoogle} />
      {!googleSignInAvailable && !DEV_LOGIN_ENABLED && !IS_TEST_VERSION ? (
        <Text style={styles.body}>Google sign-in isn't set up in this build.</Text>
      ) : null}

      {DEV_LOGIN_ENABLED ? (
        <View style={styles.dev}>
          <Text style={styles.devTitle}>Development sign-in</Text>
          <Text style={styles.hint}>
            Not available in production. Use a seeded account's email.
          </Text>
          <Text style={styles.label} nativeID="email-label">
            Email
          </Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="priya@haven.demo"
            placeholderTextColor={color.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            style={styles.input}
            accessibilityLabel="Email"
            accessibilityLabelledBy="email-label"
          />
          <Button label="Sign in" onPress={devSignIn} loading={loading} disabled={!email.trim()} />
        </View>
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
  roles: { gap: space.xxs },
  phone: { gap: space.md },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
  dev: {
    gap: space.xs,
    padding: space.md,
    borderRadius: shape.radius,
    backgroundColor: color.surface,
  },
  devTitle: {
    fontSize: typeTokens.size.body,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  hint: { fontSize: typeTokens.size.sm, color: color.textMuted },
  label: { fontSize: typeTokens.size.sm, color: color.textMuted },
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
});
