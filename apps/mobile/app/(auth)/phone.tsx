import { useState } from 'react';
import { Redirect, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';
import * as api from '../../api/client.js';
import { Button } from '../../components/Button.js';
import { TurnstileChallenge } from '../../components/TurnstileChallenge.js';
import { Countdown } from '../../components/Countdown.js';
import { OtpInput } from '../../components/OtpInput.js';
import { PhoneInput } from '../../components/PhoneInput.js';
import { useAuth } from '../../lib/auth-context.js';
import { routeForUser } from '../../lib/resident-route.js';

/** R-02 Verify phone (SDD §13.4, F7 step 3): phone + OTP, purpose `phone_verify`. */
export default function VerifyPhone() {
  const router = useRouter();
  const { user, refresh } = useAuth();
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [resendAfterS, setResendAfterS] = useState(30);
  const [canResend, setCanResend] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The API's CAPTCHA prompt when it asks for one (SDD T10), else null. */
  const [captcha, setCaptcha] = useState<string | null>(null);

  if (!user) return <Redirect href="/sign-in" />;

  async function sendCode(captchaToken?: string) {
    setError(null);
    setCaptcha(null);
    setLoading(true);
    try {
      const res = await api.requestOtp(phone, 'phone_verify', captchaToken);
      setResendAfterS(res.resendAfterS);
      setCanResend(false);
      setStep('otp');
    } catch (err) {
      if (api.isCaptchaRequired(err)) {
        setCaptcha(err.message);
        return;
      }
      setError(err instanceof api.ApiError ? err.message : 'Could not send the code. Try again.');
    } finally {
      setLoading(false);
    }
  }

  async function verify() {
    setError(null);
    setLoading(true);
    try {
      await api.verifyResidentPhone(phone, code);
      await refresh();
      const me = await api.getMe();
      if (me.type === 'user') router.replace(routeForUser(me) as never);
    } catch (err) {
      if (err instanceof api.ApiError && err.code === 'OTP_LOCKED') {
        setError('Too many wrong tries. Request a new code and try again.');
        setStep('phone');
        setCode('');
      } else if (err instanceof api.ApiError && err.code === 'OTP_EXPIRED') {
        setError('This code expired. Request a new one.');
      } else {
        setError("That code wasn't right.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.step}>Step 1 of 2</Text>
      <Text style={styles.title} accessibilityRole="header">
        {step === 'phone' ? 'Verify your phone' : 'Enter the code'}
      </Text>
      {step === 'phone' ? (
        <>
          <PhoneInput value={phone} onChange={setPhone} hint="We'll text you a 6-digit code." />
          <Button
            label="Send code"
            onPress={() => void sendCode()}
            loading={loading}
            disabled={phone.length !== 10}
          />
        </>
      ) : (
        <>
          <Text style={styles.body}>We sent a 6-digit code to +91 {phone}</Text>
          <OtpInput value={code} onChange={setCode} />
          <Button label="Verify" onPress={verify} loading={loading} disabled={code.length !== 6} />
          {canResend ? (
            <Button
              label="Resend code"
              variant="ghost"
              onPress={() => void sendCode()}
              fullWidth={false}
            />
          ) : (
            <Countdown
              seconds={resendAfterS}
              onDone={() => setCanResend(true)}
              label={(s) => `Resend code in ${s}s`}
            />
          )}
        </>
      )}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      {captcha ? (
        <TurnstileChallenge message={captcha} onToken={(token) => void sendCode(token)} />
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
  step: { fontSize: typeTokens.size.sm, color: color.textMuted },
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
});
