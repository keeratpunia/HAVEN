import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  CreateVisitBodySchema,
  formatMonth,
  plusDays,
  toLocalDateString,
  type VisitPreview,
} from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../api/client.js';
import { Button } from '../../components/Button.js';
import { DateTimeField } from '../../components/DateTimeField.js';
import { PhoneInput } from '../../components/PhoneInput.js';
import { Segments } from '../../components/Segments.js';
import { overnightHints, ruleMessage, RULES } from '../../lib/rule-hints.js';
import { serverNow } from '../../lib/server-time.js';

/**
 * R-11 Overnight request (SDD §13.4, F6, FR-14): "Guest details, type, dates; nights,
 * charge, quota bar for affected months — Send to warden". F6 step 2: the app calls
 * `POST /visits/preview` and shows nights, charge, quota used/remaining — the numbers
 * are the server's, not computed here.
 */
type Gender = 'female' | 'male' | 'undisclosed';

export default function Overnight() {
  const router = useRouter();
  const today = toLocalDateString(serverNow(), RULES.timezone);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState<Gender | null>(null);
  const [type, setType] = useState<'overnight_room' | 'guest_room'>('overnight_room');
  const [arrival, setArrival] = useState(today);
  const [departure, setDeparture] = useState(plusDays(today, 1));
  const [preview, setPreview] = useState<VisitPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const body = gender
    ? {
        kind: 'overnight' as const,
        guest: { name: name.trim(), phone: `+91${phone}`, gender },
        type,
        arrivalDate: arrival,
        departureDate: departure,
      }
    : null;
  const parsed = body ? CreateVisitBodySchema.safeParse(body) : null;
  const datesOk = departure > arrival;
  const key = parsed?.success && datesOk ? JSON.stringify(body) : null;

  useEffect(() => {
    setPreview(null);
    if (!key) return;
    const timer = setTimeout(() => {
      api
        .previewVisit(JSON.parse(key))
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 400);
    return () => clearTimeout(timer);
  }, [key]);

  async function send() {
    if (!parsed?.success) return;
    setError(null);
    setLoading(true);
    try {
      const res = await api.createVisit(parsed.data);
      setSent(res.visit.id);
    } catch (err) {
      setError(
        err instanceof api.ApiError
          ? err.status === 422
            ? ruleMessage(err.code)
            : err.message
          : 'Could not send. Try again.',
      );
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <View style={styles.container}>
        <Text style={styles.title} accessibilityRole="header">
          Sent to the warden
        </Text>
        <Text style={styles.body}>
          You'll get a notification when they decide. Once approved, share the invite from the
          visit.
        </Text>
        <Button label="Open the request" onPress={() => router.replace(`/visit/${sent}`)} />
      </View>
    );
  }

  const deny = preview?.decision === 'deny' ? preview.codes[0] : null;
  const limit = RULES.overnight_room.max_nights_per_month;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        Overnight request
      </Text>
      <View>
        <Text style={styles.label} nativeID="o-name-label">
          Guest name
        </Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Full name"
          placeholderTextColor={color.textMuted}
          style={styles.input}
          accessibilityLabel="Guest name"
          accessibilityLabelledBy="o-name-label"
          maxLength={80}
        />
      </View>
      <PhoneInput value={phone} onChange={setPhone} />
      <Text style={styles.label}>Guest's gender</Text>
      <Segments
        options={[
          { value: 'female', label: 'Female' },
          { value: 'male', label: 'Male' },
          { value: 'undisclosed', label: 'Prefer not to say' },
        ]}
        value={gender ?? ('' as Gender)}
        onChange={setGender}
      />
      <Text style={styles.label}>Where</Text>
      <Segments
        options={[
          { value: 'overnight_room', label: 'Overnight in my room' },
          { value: 'guest_room', label: 'Hostel guest room' },
        ]}
        value={type}
        onChange={setType}
      />
      <View style={styles.row}>
        <DateTimeField
          kind="date"
          label="Arrival"
          value={arrival}
          onChange={setArrival}
          min={today}
        />
        <DateTimeField
          kind="date"
          label="Departure"
          value={departure}
          onChange={setDeparture}
          min={arrival}
        />
      </View>
      {!datesOk ? <Text style={styles.error}>Departure must be after arrival.</Text> : null}
      <View style={styles.hints}>
        {overnightHints().map((h) => (
          <Text key={h} style={styles.hint}>
            {h}
          </Text>
        ))}
      </View>

      {preview && preview.decision !== 'deny' ? (
        <View style={styles.card} accessibilityLabel="Request summary">
          <Text style={styles.summary}>
            {preview.nights} night{preview.nights === 1 ? '' : 's'} · ₹{preview.chargeInr}
          </Text>
          {preview.quota.map((q) => (
            <View key={q.month} style={styles.quota}>
              <Text style={styles.hint}>
                {formatMonth(q.month)}: {q.after} of {limit} nights after this
              </Text>
              <View style={styles.bar} accessibilityLabel={`${q.after} of ${limit} nights used`}>
                <View
                  style={[styles.barFill, { width: `${Math.min(100, (q.after / limit) * 100)}%` }]}
                />
              </View>
            </View>
          ))}
        </View>
      ) : null}
      {deny ? (
        <Text style={styles.error} accessibilityRole="alert">
          {ruleMessage(deny)}
        </Text>
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <Button
        label="Send to warden"
        onPress={send}
        loading={loading}
        disabled={!preview || preview.decision === 'deny'}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: space.md,
    gap: space.md,
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
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
  row: { flexDirection: 'row', gap: space.sm },
  hints: { gap: space.xxs },
  hint: { fontSize: typeTokens.size.sm, color: color.textMuted },
  card: {
    backgroundColor: color.surface,
    borderRadius: shape.radius,
    padding: space.md,
    gap: space.sm,
  },
  summary: {
    fontSize: typeTokens.size.md,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  quota: { gap: space.xxs },
  bar: { height: 8, borderRadius: 999, backgroundColor: color.border, overflow: 'hidden' },
  barFill: { height: 8, backgroundColor: color.primary },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
});
