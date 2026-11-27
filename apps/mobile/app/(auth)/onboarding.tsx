import { CONSENT_VERSION, copyFor } from '@haven/shared';
import { useEffect, useState } from 'react';
import { Link, Redirect, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { RoomNumberSchema } from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../api/client.js';
import { Button } from '../../components/Button.js';
import { ErrorState } from '../../components/ErrorState.js';
import { LiveCamera } from '../../components/LiveCamera.js';
import { useAuth } from '../../lib/auth-context.js';

/**
 * R-03 Onboarding (SDD §13.4, F7 step 4): "Hostel (GH-8 preselected), room number,
 * ID card photo (live), selfie (live), consent — Submit for verification". Live
 * camera only, no gallery (D4). Each photo uploads as soon as it's taken; the
 * server re-checks that everything is present on submit.
 */

type Step = 'details' | 'id_card' | 'selfie' | 'submit';

export default function Onboarding() {
  const router = useRouter();
  const { user, refresh } = useAuth();
  const [step, setStep] = useState<Step>('details');
  const [hostels, setHostels] = useState<{ id: string; code: string; name: string }[] | null>(null);
  const [hostelId, setHostelId] = useState<string | null>(null);
  const [room, setRoom] = useState(user?.resident?.room ?? '');
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraBlocked, setCameraBlocked] = useState(false);

  useEffect(() => {
    api
      .getHostels()
      .then((list) => {
        setHostels(list);
        const preselect =
          list.find((h) => h.id === user?.resident?.hostelId) ??
          list.find((h) => h.code === 'GH-8') ??
          list[0];
        setHostelId(preselect?.id ?? null);
      })
      .catch(() => setError('Could not load hostels. Check your connection and try again.'));
  }, [user?.resident?.hostelId]);

  if (!user) return <Redirect href="/sign-in" />;
  if (cameraBlocked) {
    return (
      <ErrorState
        code="camera_denied"
        actionLabel="Try again"
        onAction={() => setCameraBlocked(false)}
      />
    );
  }

  const roomCheck = RoomNumberSchema.safeParse(room);

  async function saveDetails() {
    if (!hostelId || !roomCheck.success) return;
    setError(null);
    setLoading(true);
    try {
      await api.saveResidentDraft({ hostelId, room: roomCheck.data });
      setStep('id_card');
    } catch (err) {
      setError(err instanceof api.ApiError ? err.message : 'Could not save. Try again.');
    } finally {
      setLoading(false);
    }
  }

  async function upload(kind: 'id_card' | 'selfie', dataUrl: string) {
    setError(null);
    setLoading(true);
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await api.uploadResidentDocument(kind, blob);
      setStep(kind === 'id_card' ? 'selfie' : 'submit');
    } catch (err) {
      setError(
        err instanceof api.ApiError ? err.message : 'Could not upload the photo. Try again.',
      );
    } finally {
      setLoading(false);
    }
  }

  async function submit() {
    setError(null);
    setLoading(true);
    try {
      await api.submitResident(CONSENT_VERSION);
      await refresh();
      router.replace('/pending');
    } catch (err) {
      setError(err instanceof api.ApiError ? err.message : 'Could not submit. Try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.step}>Step 2 of 2 · {STEP_LABELS[step]}</Text>

      {step === 'details' ? (
        <>
          <Text style={styles.title} accessibilityRole="header">
            Where do you live?
          </Text>
          <Text style={styles.label}>Hostel</Text>
          <View style={styles.choices} accessibilityRole="radiogroup">
            {(hostels ?? []).map((h) => (
              <Pressable
                key={h.id}
                onPress={() => setHostelId(h.id)}
                accessibilityRole="radio"
                accessibilityState={{ checked: hostelId === h.id }}
                aria-checked={hostelId === h.id}
                accessibilityLabel={`${h.code} ${h.name}`}
                style={[styles.choice, hostelId === h.id && styles.choiceSelected]}
              >
                <Text style={[styles.choiceText, hostelId === h.id && styles.choiceTextSelected]}>
                  {h.code} · {h.name}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.label} nativeID="room-label">
            Room number
          </Text>
          <TextInput
            value={room}
            onChangeText={setRoom}
            placeholder="e.g. 214"
            placeholderTextColor={color.textMuted}
            autoCapitalize="characters"
            style={styles.input}
            accessibilityLabel="Room number"
            accessibilityLabelledBy="room-label"
          />
          {room.length > 0 && !roomCheck.success ? (
            <Text style={styles.error}>{roomCheck.error.issues[0]?.message}</Text>
          ) : null}
          <Button
            label="Continue"
            onPress={saveDetails}
            loading={loading}
            disabled={!hostelId || !roomCheck.success}
          />
        </>
      ) : null}

      {step === 'id_card' ? (
        <>
          <Text style={styles.title} accessibilityRole="header">
            Photo of your hostel ID card
          </Text>
          <LiveCamera
            facing="environment"
            guideText="Fit the whole card in the frame, in good light."
            onCapture={(url) => void upload('id_card', url)}
            onPermissionDenied={() => setCameraBlocked(true)}
          />
        </>
      ) : null}

      {step === 'selfie' ? (
        <>
          <Text style={styles.title} accessibilityRole="header">
            Take a selfie
          </Text>
          <LiveCamera
            guideText="Good light, no sunglasses."
            onCapture={(url) => void upload('selfie', url)}
            onPermissionDenied={() => setCameraBlocked(true)}
          />
        </>
      ) : null}

      {step === 'submit' ? (
        <>
          <Text style={styles.title} accessibilityRole="header">
            Submit for verification
          </Text>
          <Pressable
            onPress={() => setConsent(!consent)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: consent }}
            aria-checked={consent}
            accessibilityLabel="I agree to share these details with the warden"
            style={styles.consent}
          >
            <View style={[styles.box, consent && styles.boxChecked]}>
              {consent ? <Text style={styles.tick}>✓</Text> : null}
            </View>
            <Text style={styles.body}>
              I agree to share my name, phone, room, ID card photo and selfie with the warden so
              they can verify me. The ID card photo is deleted once the warden decides.
            </Text>
          </Pressable>
          <Link href="/privacy" style={styles.link}>
            {copyFor('PRIVACY_CONSENT_LABEL').body}
          </Link>
          <Button
            label="Submit for verification"
            onPress={submit}
            loading={loading}
            disabled={!consent}
          />
        </>
      ) : null}

      {loading && step !== 'details' && step !== 'submit' ? (
        <Text style={styles.body}>Uploading…</Text>
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const STEP_LABELS: Record<Step, string> = {
  details: 'Your room',
  id_card: 'ID card',
  selfie: 'Selfie',
  submit: 'Submit',
};

const styles = StyleSheet.create({
  container: {
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
  body: { flex: 1, fontSize: typeTokens.size.body, color: color.textMuted },
  label: { fontSize: typeTokens.size.sm, color: color.textMuted },
  choices: { gap: space.xs },
  choice: {
    minHeight: 48,
    justifyContent: 'center',
    padding: space.sm,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: shape.radius,
  },
  choiceSelected: { borderColor: color.primary, backgroundColor: color.primary },
  choiceText: { fontSize: typeTokens.size.body, color: color.text },
  choiceTextSelected: { color: color.onPrimary, fontWeight: typeTokens.weight.semibold },
  input: {
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: shape.radius,
    paddingHorizontal: space.sm,
    minHeight: 48,
    fontSize: typeTokens.size.body,
    color: color.text,
  },
  // Padded to a 48 px tap target (SDD §13.2); the phone audit measured 19 px.
  link: {
    fontSize: typeTokens.size.sm,
    color: color.primary,
    textDecorationLine: 'underline',
    paddingVertical: space.sm,
    minHeight: 48,
    alignSelf: 'flex-start',
  },
  consent: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start', minHeight: 48 },
  box: {
    width: 24,
    height: 24,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxChecked: { backgroundColor: color.primary, borderColor: color.primary },
  tick: { color: color.onPrimary, fontWeight: typeTokens.weight.semibold },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
});
