import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../api/client.js';
import { Button } from '../../components/Button.js';
import { EmptyState } from '../../components/EmptyState.js';

type Step = 'room' | 'type';

/**
 * G-08 "Find your host" + G-09 "Visit type" (SDD §13.4), combined into one route.
 * Submitting lands the visit in `pending_host`; approval requires the resident app
 * (out of scope for guest web — see docs/DECISIONS.md), so this flow ends at the
 * "waiting" status shown by `visits/[id]`, not full completion.
 */
export default function WalkIn() {
  const router = useRouter();
  const [hostelId, setHostelId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('room');
  const [room, setRoom] = useState('');
  const [searching, setSearching] = useState(false);
  const [residents, setResidents] = useState<{ userId: string; fullName: string }[] | null>(null);
  const [selectedHost, setSelectedHost] = useState<{ userId: string; fullName: string } | null>(
    null,
  );
  const [type, setType] = useState<'quick_drop' | 'day'>('day');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getHostels()
      .then((hostels) => setHostelId(hostels[0]?.id ?? null))
      .catch(() => setError('Could not load hostels.'));
  }, []);

  async function search() {
    if (!hostelId || !room.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const found = await api.searchRooms(hostelId, room.trim());
      setResidents(found);
    } catch {
      setError('Could not search right now.');
    } finally {
      setSearching(false);
    }
  }

  async function submit() {
    if (!selectedHost) return;
    setSubmitting(true);
    setError(null);
    try {
      const durationMinutes = type === 'quick_drop' ? 15 : 120;
      const visit = await api.createWalkIn({
        hostUserId: selectedHost.userId,
        type,
        guestGender: null,
        durationMinutes,
      });
      router.replace(`/visits/${visit.id}`);
    } catch (err) {
      setError(err instanceof api.ApiError ? err.message : 'Could not send your request.');
    } finally {
      setSubmitting(false);
    }
  }

  if (step === 'room') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Find your host</Text>
        <Text style={styles.label}>Room number</Text>
        <View style={styles.row}>
          <TextInput
            value={room}
            onChangeText={setRoom}
            placeholder="e.g. 214"
            placeholderTextColor={color.textMuted}
            style={styles.input}
            accessibilityLabel="Room number"
          />
          <Button
            label="Search"
            onPress={search}
            loading={searching}
            fullWidth={false}
            disabled={!room.trim()}
          />
        </View>

        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}

        {residents !== null &&
          (residents.length === 0 ? (
            <EmptyState message={`No registered resident in room ${room}.`} />
          ) : (
            <View style={styles.list}>
              {residents.map((r) => (
                <Pressable
                  key={r.userId}
                  onPress={() => {
                    setSelectedHost(r);
                    setStep('type');
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Select ${r.fullName}`}
                  style={styles.residentRow}
                >
                  <Text style={styles.body}>{r.fullName}</Text>
                </Pressable>
              ))}
            </View>
          ))}

        {searching ? <ActivityIndicator accessibilityLabel="Searching" /> : null}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Visit type</Text>
      <View style={styles.genderRow}>
        {(['quick_drop', 'day'] as const).map((t) => (
          <Pressable
            key={t}
            onPress={() => setType(t)}
            accessibilityRole="radio"
            accessibilityState={{ checked: type === t }}
            accessibilityLabel={t === 'quick_drop' ? 'Quick drop-off' : 'Day visit'}
            style={[styles.typeOption, type === t && styles.typeOptionSelected]}
          >
            <Text style={[styles.body, type === t && styles.typeTextSelected]}>
              {t === 'quick_drop' ? 'Quick drop-off' : 'Day visit'}
            </Text>
          </Pressable>
        ))}
      </View>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <View style={styles.action}>
        <Button label="Continue" onPress={submit} loading={submitting} />
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
  label: { fontSize: typeTokens.size.sm, color: color.textMuted },
  body: { fontSize: typeTokens.size.body, color: color.text },
  row: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: shape.radius,
    paddingHorizontal: space.sm,
    minHeight: 48,
    fontSize: typeTokens.size.body,
    color: color.text,
  },
  list: { gap: space.xs },
  residentRow: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: shape.radius,
  },
  genderRow: { flexDirection: 'row', gap: space.xs },
  typeOption: {
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: shape.chipRadius,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    minHeight: 48,
    justifyContent: 'center',
  },
  typeOptionSelected: { backgroundColor: color.primary, borderColor: color.primary },
  typeTextSelected: { color: color.onPrimary },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
  action: { marginTop: space.sm },
});
