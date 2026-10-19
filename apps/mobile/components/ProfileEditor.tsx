import { useCallback, useEffect, useState } from 'react';
import { Image, StyleSheet, Text, TextInput, View } from 'react-native';
import { copyFor } from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../api/client.js';
import { Button } from './Button.js';
import { LiveCamera } from './LiveCamera.js';

/**
 * FR-08: "Guests and residents can view and edit their name and retake their profile
 * photo (re-verification not required for guests; resident photo changes are
 * logged)." The photo comes from a fresh GET /me each time (signed URLs last 120 s and
 * must not be kept, §9.10); retakes use the live camera only (§9.4, no gallery).
 */
export function ProfileEditor(props: { kind: 'guest' | 'resident'; onSaved?: () => void }) {
  const [name, setName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [retaking, setRetaking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const me = (await api.getMe()) as { fullName: string; profilePhoto?: { url: string } | null };
    setName(me.fullName);
    setSavedName(me.fullName);
    setPhotoUrl(me.profilePhoto?.url ?? null);
  }, []);

  useEffect(() => {
    void load().catch(() => setError('Could not load your profile.'));
  }, [load]);

  async function saveName() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.patchMe({ fullName: name.trim() });
      await load();
      setMessage('Name saved.');
      props.onSaved?.();
    } catch (err) {
      setError(err instanceof api.ApiError ? err.message : 'Could not save your name.');
    } finally {
      setBusy(false);
    }
  }

  async function savePhoto(dataUrl: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const blob = await (await fetch(dataUrl)).blob();
      if (props.kind === 'guest') await api.uploadProfilePhoto(blob);
      else await api.uploadResidentDocument('selfie', blob);
      setRetaking(false);
      await load();
      setMessage('Photo updated.');
      props.onSaved?.();
    } catch (err) {
      setError(copyFor(err instanceof api.ApiError ? err.code : 'PHOTO_INVALID').title);
    } finally {
      setBusy(false);
    }
  }

  const trimmed = name.trim();
  return (
    <View style={styles.card}>
      {retaking ? (
        <>
          <LiveCamera
            guideText="Good light, no sunglasses."
            onCapture={(dataUrl) => void savePhoto(dataUrl)}
            onPermissionDenied={() =>
              setError("Camera is blocked. Allow camera access in your browser's site settings.")
            }
          />
          <Button label="Cancel" variant="ghost" onPress={() => setRetaking(false)} />
        </>
      ) : (
        <>
          {photoUrl ? (
            <Image
              source={{ uri: photoUrl }}
              style={styles.photo}
              accessibilityLabel="Your profile photo"
            />
          ) : (
            <View style={[styles.photo, styles.noPhoto]}>
              <Text style={styles.hint}>No photo yet</Text>
            </View>
          )}
          <Button
            label="Retake photo"
            variant="secondary"
            onPress={() => setRetaking(true)}
            disabled={busy}
          />
        </>
      )}
      <Text style={styles.label}>Full name</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        style={styles.input}
        accessibilityLabel="Full name"
        autoComplete="name"
      />
      <Button
        label="Save name"
        onPress={() => void saveName()}
        disabled={busy || trimmed.length < 2 || trimmed === savedName}
      />
      {props.kind === 'resident' ? (
        <Text style={styles.hint}>
          A new photo is recorded in the hostel's log. The warden doesn't need to verify you again.
        </Text>
      ) : null}
      {message ? (
        <Text style={styles.message} accessibilityRole="alert">
          {message}
        </Text>
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
  card: {
    backgroundColor: color.surface,
    borderRadius: shape.radius,
    padding: space.md,
    gap: space.sm,
  },
  photo: { width: 120, height: 120, borderRadius: 60, alignSelf: 'center' },
  noPhoto: { alignItems: 'center', justifyContent: 'center', backgroundColor: color.bg },
  label: { fontSize: typeTokens.size.sm, color: color.textMuted },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: shape.radius,
    paddingHorizontal: space.sm,
    fontSize: typeTokens.size.body,
    color: color.text,
  },
  hint: { fontSize: typeTokens.size.sm, color: color.textMuted },
  message: { fontSize: typeTokens.size.sm, color: color.text },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
});
