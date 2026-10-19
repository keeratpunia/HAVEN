import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  CreateVisitBodySchema,
  inviteShareText,
  localDateTimeToUtc,
  toLocalDateString,
  type VisitPreview,
} from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../api/client.js';
import { Button } from '../../components/Button.js';
import { DateTimeField } from '../../components/DateTimeField.js';
import { PhoneInput } from '../../components/PhoneInput.js';
import { Segments } from '../../components/Segments.js';
import { SharePanel } from '../../components/SharePanel.js';
import { useAuth } from '../../lib/auth-context.js';
import { dayVisitHints, localInviteCheck, ruleMessage, RULES } from '../../lib/rule-hints.js';
import { serverNow } from '../../lib/server-time.js';

/**
 * R-06 Invite guest + R-07 Share invite (SDD §13.4, F1 steps 1-2, FR-10/FR-11).
 * Validation: the shared Zod schema, then the shared rules engine for instant hints,
 * then the server's `POST /visits/preview` — the only authority. The primary button
 * stays disabled until all three agree (§14 forms).
 *
 * Quick drop-off is "fixed 15 min" (§4.1), so it has no end time field. The SDD's
 * contact picker isn't built — the phone is typed (docs/TRACEABILITY.md, FR-10).
 */
const TZ = RULES.timezone;

export default function Invite() {
  const { user } = useAuth();
  const now = serverNow();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [type, setType] = useState<'day' | 'quick_drop'>('day');
  const [date, setDate] = useState(toLocalDateString(now, TZ));
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [preview, setPreview] = useState<VisitPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    inviteUrl: string;
    windowStart: string;
    windowEnd: string;
  } | null>(null);

  const slot = useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start)) return null;
    const ws = localDateTimeToUtc(date, start, TZ);
    if (type === 'quick_drop') {
      return { start: ws, end: new Date(ws.getTime() + RULES.quick_drop_minutes * 60_000) };
    }
    if (!/^\d{2}:\d{2}$/.test(end)) return null;
    return { start: ws, end: localDateTimeToUtc(date, end, TZ) };
  }, [date, start, end, type]);

  const body = slot
    ? {
        kind: 'invite' as const,
        guest: { name: name.trim(), phone: `+91${phone}` },
        type,
        windowStart: slot.start.toISOString(),
        windowEnd: slot.end.toISOString(),
      }
    : null;
  const parsed = body ? CreateVisitBodySchema.safeParse(body) : null;
  const localCode = slot
    ? localInviteCheck({ type, windowStart: slot.start, windowEnd: slot.end, now })
    : null;

  // Server preview (authoritative) once the form is locally valid, debounced.
  const previewKey = parsed?.success && !localCode ? JSON.stringify(body) : null;
  useEffect(() => {
    setPreview(null);
    if (!previewKey) return;
    const timer = setTimeout(() => {
      api
        .previewVisit(JSON.parse(previewKey))
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 400);
    return () => clearTimeout(timer);
  }, [previewKey]);

  const serverCode = preview?.decision === 'deny' ? preview.codes[0] : null;
  const ruleProblem = localCode ?? serverCode ?? null;
  const ready = Boolean(parsed?.success && !localCode && preview && preview.decision !== 'deny');

  async function createInvite() {
    if (!parsed?.success) return;
    setError(null);
    setLoading(true);
    try {
      const res = await api.createVisit(parsed.data);
      if (res.inviteUrl) {
        setCreated({
          inviteUrl: res.inviteUrl,
          windowStart: res.visit.windowStart,
          windowEnd: res.visit.windowEnd,
        });
      }
    } catch (err) {
      setError(
        err instanceof api.ApiError
          ? err.status === 422
            ? ruleMessage(err.code)
            : err.message
          : 'Could not create the invite. Try again.',
      );
    } finally {
      setLoading(false);
    }
  }

  if (created) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} accessibilityRole="header">
          Share invite
        </Text>
        <SharePanel
          inviteUrl={created.inviteUrl}
          message={inviteShareText({
            guestName: name.trim(),
            hostelName: user?.resident?.hostelName ?? 'the hostel',
            windowStart: created.windowStart,
            windowEnd: created.windowEnd,
            inviteUrl: created.inviteUrl,
          })}
        />
        <Button
          label="Invite someone else"
          variant="ghost"
          onPress={() => {
            setCreated(null);
            setName('');
            setPhone('');
          }}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        Invite guest
      </Text>
      <View>
        <Text style={styles.label} nativeID="guest-name-label">
          Guest name
        </Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Full name"
          placeholderTextColor={color.textMuted}
          style={styles.input}
          accessibilityLabel="Guest name"
          accessibilityLabelledBy="guest-name-label"
          maxLength={80}
        />
      </View>
      <PhoneInput value={phone} onChange={setPhone} hint="Your guest signs in with this number." />
      <Segments
        options={[
          { value: 'day', label: 'Day visit' },
          { value: 'quick_drop', label: 'Quick drop-off' },
        ]}
        value={type}
        onChange={setType}
      />
      <DateTimeField
        kind="date"
        label="Date"
        value={date}
        onChange={setDate}
        min={toLocalDateString(now, TZ)}
      />
      <View style={styles.row}>
        <DateTimeField kind="time" label="Start" value={start} onChange={setStart} />
        {type === 'day' ? (
          <DateTimeField kind="time" label="End" value={end} onChange={setEnd} />
        ) : null}
      </View>
      <View style={styles.hints}>
        {type === 'quick_drop' ? (
          <Text style={styles.hint}>Quick drop-off lasts {RULES.quick_drop_minutes} minutes.</Text>
        ) : null}
        {dayVisitHints().map((h) => (
          <Text key={h} style={styles.hint}>
            {h}
          </Text>
        ))}
      </View>
      {ruleProblem ? (
        <Text style={styles.error} accessibilityRole="alert">
          {ruleMessage(ruleProblem)}
        </Text>
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <Button label="Create invite" onPress={createInvite} loading={loading} disabled={!ready} />
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
  row: { flexDirection: 'row', gap: space.sm },
  hints: { gap: space.xxs },
  hint: { fontSize: typeTokens.size.sm, color: color.textMuted },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
});
