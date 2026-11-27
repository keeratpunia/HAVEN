import { useState } from 'react';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { CONSENT_VERSION, copyFor } from '@haven/shared';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../api/client.js';
import { Button } from '../../components/Button.js';
import { LiveCamera } from '../../components/LiveCamera.js';
import { useAuth } from '../../lib/auth-context.js';

type Gender = 'female' | 'male' | 'undisclosed';

/**
 * G-04 "About you" (name, gender, 18+ checkbox, privacy notice) + G-05 "Profile photo"
 * (live camera, no gallery) — SDD §13.4.
 */
export default function Profile() {
  const { token, returnTo } = useLocalSearchParams<{ token?: string; returnTo?: string }>();
  const router = useRouter();
  const { refresh } = useAuth();

  const [step, setStep] = useState<'about' | 'photo'>('about');
  const [fullName, setFullName] = useState('');
  const [gender, setGender] = useState<Gender | null>(null);
  const [isAdult, setIsAdult] = useState<boolean | null>(null);
  // §16.3 "explicit checkbox, not pre-ticked".
  const [consented, setConsented] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photoKey, setPhotoKey] = useState(0);

  async function continueFromAbout() {
    if (!fullName.trim() || fullName.trim().length < 2 || !gender || isAdult === null) return;
    if (!isAdult || !consented) return; // Continue stays disabled below
    setSaving(true);
    setError(null);
    try {
      await api.patchMe({ fullName: fullName.trim(), gender });
      // SDD §12.4 POST /me/consent records the notice version and 18+ (§16.3).
      await api.postConsent(CONSENT_VERSION);
      setStep('photo');
    } catch {
      setError('Could not save your details. Try again.');
    } finally {
      setSaving(false);
    }
  }

  async function finishWithPhoto(dataUrl: string) {
    setError(null);
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await api.uploadProfilePhoto(blob);
    } catch (err) {
      // The profile photo is part of a complete profile (FR-02): without it the API
      // refuses check-in and walk-ins (PROFILE_INCOMPLETE). Say why and let them retake.
      setError(copyFor(err instanceof api.ApiError ? err.code : 'PHOTO_INVALID').title);
      setPhotoKey((k) => k + 1);
      return;
    }
    await refresh();
    if (token) {
      // F1 step 5: with the profile finished the invite becomes this guest's.
      try {
        await api.claimInvite(token);
      } catch {
        // Already claimed by this guest, or expired: My visits shows where things stand.
      }
    }
    if (returnTo) {
      router.replace(returnTo);
    } else if (token) {
      router.replace({ pathname: '/visits', params: { justClaimed: token } });
    } else {
      router.replace('/visits');
    }
  }

  if (step === 'photo') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Take your profile photo</Text>
        <LiveCamera
          key={photoKey}
          guideText="Good light, no sunglasses."
          onCapture={(dataUrl) => void finishWithPhoto(dataUrl)}
          onPermissionDenied={() => setError('camera_denied')}
        />
        {error && error !== 'camera_denied' ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        {error === 'camera_denied' ? (
          <View style={styles.deniedBox}>
            <Text style={styles.title}>Camera is blocked</Text>
            <Text style={styles.body}>
              Allow camera access in your browser's site settings, then reload this page.
            </Text>
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>About you</Text>

      <View>
        <Text style={styles.label} nativeID="fullname-label">
          Full name
        </Text>
        <TextInput
          value={fullName}
          onChangeText={setFullName}
          placeholder="Your full name"
          placeholderTextColor={color.textMuted}
          style={styles.input}
          accessibilityLabel="Full name"
          accessibilityLabelledBy="fullname-label"
        />
      </View>

      <View>
        <Text style={styles.label}>Gender</Text>
        <View style={styles.genderRow}>
          {(['female', 'male', 'undisclosed'] as const).map((g) => (
            <Pressable
              key={g}
              onPress={() => setGender(g)}
              accessibilityRole="radio"
              accessibilityState={{ checked: gender === g }}
              accessibilityLabel={
                g === 'undisclosed' ? 'Prefer not to say' : g === 'female' ? 'Female' : 'Male'
              }
              style={[styles.genderOption, gender === g && styles.genderOptionSelected]}
            >
              <Text style={[styles.genderText, gender === g && styles.genderTextSelected]}>
                {g === 'undisclosed' ? 'Prefer not to say' : g === 'female' ? 'Female' : 'Male'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Pressable
        onPress={() => setIsAdult((v) => (v === true ? false : true))}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: isAdult === true }}
        accessibilityLabel="I am 18 years or older"
        style={styles.checkboxRow}
      >
        <View style={[styles.checkbox, isAdult && styles.checkboxChecked]}>
          {isAdult ? <Text style={styles.checkmark}>✓</Text> : null}
        </View>
        <Text style={styles.body}>I am 18 years or older</Text>
      </Pressable>
      {isAdult === false ? (
        <Text style={styles.error} accessibilityRole="alert">
          Ask your host to check you in.
        </Text>
      ) : null}

      <View style={styles.notice}>
        <Text style={styles.label}>{copyFor('PRIVACY_SUMMARY').title}</Text>
        <Text style={styles.privacy}>{copyFor('PRIVACY_SUMMARY').body}</Text>
        <Link href="/privacy" style={styles.link}>
          {copyFor('PRIVACY_CONSENT_LABEL').body}
        </Link>
      </View>
      <Pressable
        onPress={() => setConsented((v) => !v)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: consented }}
        aria-checked={consented}
        accessibilityLabel={copyFor('PRIVACY_CONSENT_LABEL').title}
        style={styles.checkboxRow}
      >
        <View style={[styles.checkbox, consented && styles.checkboxChecked]}>
          {consented ? <Text style={styles.checkmark}>✓</Text> : null}
        </View>
        <Text style={styles.body}>{copyFor('PRIVACY_CONSENT_LABEL').title}</Text>
      </Pressable>

      {error && error !== 'camera_denied' ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      <View style={styles.action}>
        <Button
          label="Continue"
          onPress={continueFromAbout}
          loading={saving}
          disabled={
            !fullName.trim() || fullName.trim().length < 2 || !gender || !isAdult || !consented
          }
        />
      </View>
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
  genderRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  genderOption: {
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: shape.chipRadius,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    minHeight: 48,
    justifyContent: 'center',
  },
  genderOptionSelected: { backgroundColor: color.primary, borderColor: color.primary },
  genderText: { fontSize: typeTokens.size.body, color: color.text },
  genderTextSelected: { color: color.onPrimary },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: 48 },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: color.primary, borderColor: color.primary },
  checkmark: { color: color.onPrimary, fontSize: typeTokens.size.sm },
  privacy: { fontSize: typeTokens.size.sm, color: color.textMuted },
  notice: { gap: space.xxs },
  // Padded to a 48 px tap target (SDD §13.2); the phone audit measured 19 px.
  link: {
    fontSize: typeTokens.size.sm,
    color: color.primary,
    textDecorationLine: 'underline',
    paddingVertical: space.sm,
    minHeight: 48,
    alignSelf: 'flex-start',
  },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
  action: { marginTop: space.sm },
  deniedBox: { gap: space.xs, marginTop: space.md },
});
