import { useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';
import * as api from '../../api/client.js';
import { Button } from '../../components/Button.js';
import { Countdown } from '../../components/Countdown.js';
import { OtpInput } from '../../components/OtpInput.js';
import { PhoneInput } from '../../components/PhoneInput.js';
import { useAuth } from '../../lib/auth-context.js';

/** G-02 Phone + G-03 OTP (SDD §13.4), combined into one route with two steps. */
export default function Login() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const router = useRouter();
  const { refresh } = useAuth();

  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [resendAfterS, setResendAfterS] = useState(30);
  const [canResend, setCanResend] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lockedOut, setLockedOut] = useState(false);

  async function sendCode() {
    setError(null);
    if (phone.length !== 10) {
      setError('Enter a 10-digit phone number.');
      return;
    }
    setLoading(true);
    try {
      const res = await api.requestOtp(phone, 'guest_login');
      setResendAfterS(res.resendAfterS);
      setCanResend(false);
      setStep('otp');
    } catch (err) {
      setError(err instanceof api.ApiError ? err.message : 'Could not send the code. Try again.');
    } finally {
      setLoading(false);
    }
  }

  async function verify() {
    setError(null);
    setLoading(true);
    try {
      const result = await api.verifyOtp(phone, code, 'guest_login');
      api.setAccessToken(result.accessToken);
      await refresh();

      if (token) {
        try {
          await api.claimInvite(token);
        } catch (claimErr) {
          // SDD F1 step 4: "If [the signed-in phone] differs from invited_phone, show
          // error." Other claim failures (already claimed, expired) aren't fatal to
          // sign-in itself — the guest still has an account; only the phone-mismatch
          // case blocks them here, matching INVITE_PHONE_MISMATCH's SDD §12.2 meaning.
          if (claimErr instanceof api.ApiError && claimErr.code === 'INVITE_PHONE_MISMATCH') {
            setLoading(false);
            setError(
              'This invite was sent to a different phone number. Ask your host to invite this number instead.',
            );
            return;
          }
        }
      }

      if (!result.principal.profileComplete) {
        router.replace({ pathname: '/profile', params: token ? { token } : {} });
      } else {
        router.replace('/visits');
      }
    } catch (err) {
      if (err instanceof api.ApiError && err.code === 'OTP_LOCKED') {
        setLockedOut(true);
      } else if (err instanceof api.ApiError) {
        setError(
          err.code === 'OTP_EXPIRED'
            ? 'This code expired. Request a new one.'
            : "That code wasn't right.",
        );
      } else {
        setError('Something went wrong. Try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  if (step === 'phone') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>What's your phone number?</Text>
        <PhoneInput value={phone} onChange={setPhone} hint="We'll text you a 6-digit code." />
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        <View style={styles.action}>
          <Button
            label="Send code"
            onPress={sendCode}
            loading={loading}
            disabled={phone.length !== 10}
          />
        </View>
      </View>
    );
  }

  if (lockedOut) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Too many wrong tries</Text>
        <Text style={styles.body}>Request a new code and try again.</Text>
        <View style={styles.action}>
          <Button
            label="Request a new code"
            onPress={() => {
              setLockedOut(false);
              setCode('');
              setStep('phone');
            }}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Enter the code</Text>
      <Text style={styles.body}>We sent a 6-digit code to +91 {phone}</Text>
      <OtpInput value={code} onChange={setCode} />
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <View style={styles.action}>
        <Button label="Verify" onPress={verify} loading={loading} disabled={code.length !== 6} />
      </View>
      {canResend ? (
        <Button label="Resend code" variant="ghost" onPress={sendCode} fullWidth={false} />
      ) : (
        <Countdown
          seconds={resendAfterS}
          onDone={() => setCanResend(true)}
          label={(s) => `Resend code in ${s}s`}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: space.md, gap: space.md },
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
  action: { marginTop: space.sm },
});
