import { useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../api/client.js';
import { Button } from '../../components/Button.js';
import { PhoneInput } from '../../components/PhoneInput.js';

/**
 * R-06 Invite guest + R-07 Share invite (SDD §13.4, F1 step 1-2), combined into one
 * route with two steps, matching the guest login screen's pattern. Server-side
 * `evaluateCreate` is the only rule authority — this form does not duplicate rule
 * hints, it just surfaces whatever error the server returns.
 */
export default function Invite() {
  const [step, setStep] = useState<'form' | 'share'>('form');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [type, setType] = useState<'quick_drop' | 'day'>('day');
  const [date, setDate] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState('');
  const [copied, setCopied] = useState(false);

  const valid = name.trim().length > 0 && phone.length === 10 && date && start && end;

  async function createInvite() {
    setError(null);
    setLoading(true);
    try {
      const windowStart = new Date(`${date}T${start}:00+05:30`).toISOString();
      const windowEnd = new Date(`${date}T${end}:00+05:30`).toISOString();
      const result = await api.createInvite({
        guest: { name: name.trim(), phone: `+91${phone}` },
        type,
        windowStart,
        windowEnd,
      });
      setInviteUrl(result.inviteUrl);
      setStep('share');
    } catch (err) {
      setError(err instanceof api.ApiError ? err.message : 'Could not create the invite.');
    } finally {
      setLoading(false);
    }
  }

  async function copyLink() {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(inviteUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // ignore — the link is still shown for manual copy
      }
    }
  }

  if (step === 'share') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Share invite</Text>
        <Text style={styles.body}>
          Hi {name}, I've added you as my guest on {date}, {start}–{end}.{'\n'}
          Open this link to get set up, then scan the QR at the gate when you arrive:
        </Text>
        <View style={styles.linkBox}>
          <Text selectable style={styles.link}>
            {inviteUrl}
          </Text>
        </View>
        <View style={styles.action}>
          <Button label={copied ? 'Copied!' : 'Copy link'} onPress={copyLink} />
        </View>
        <Button
          label="Create another invite"
          variant="secondary"
          onPress={() => {
            setStep('form');
            setName('');
            setPhone('');
            setDate('');
            setStart('');
            setEnd('');
            setInviteUrl('');
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Invite guest</Text>
      <View>
        <Text style={styles.label} nativeID="name-label">
          Guest name
        </Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Guest's full name"
          placeholderTextColor={color.textMuted}
          style={styles.input}
          accessibilityLabel="Guest name"
          accessibilityLabelledBy="name-label"
        />
      </View>
      <PhoneInput value={phone} onChange={setPhone} />
      <View style={styles.typeRow}>
        {(['day', 'quick_drop'] as const).map((t) => (
          <Button
            key={t}
            label={t === 'day' ? 'Day visit' : 'Quick drop-off'}
            variant={type === t ? 'primary' : 'secondary'}
            fullWidth={false}
            onPress={() => setType(t)}
          />
        ))}
      </View>
      <View>
        <Text style={styles.label} nativeID="date-label">
          Date
        </Text>
        <TextInput
          value={date}
          onChangeText={setDate}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={color.textMuted}
          style={styles.input}
          accessibilityLabel="Date"
          accessibilityLabelledBy="date-label"
        />
      </View>
      <View style={styles.row}>
        <View style={styles.flex}>
          <Text style={styles.label} nativeID="start-label">
            Start time
          </Text>
          <TextInput
            value={start}
            onChangeText={setStart}
            placeholder="HH:MM"
            placeholderTextColor={color.textMuted}
            style={styles.input}
            accessibilityLabel="Start time"
            accessibilityLabelledBy="start-label"
          />
        </View>
        <View style={styles.flex}>
          <Text style={styles.label} nativeID="end-label">
            End time
          </Text>
          <TextInput
            value={end}
            onChangeText={setEnd}
            placeholder="HH:MM"
            placeholderTextColor={color.textMuted}
            style={styles.input}
            accessibilityLabel="End time"
            accessibilityLabelledBy="end-label"
          />
        </View>
      </View>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <View style={styles.action}>
        <Button label="Create invite" onPress={createInvite} loading={loading} disabled={!valid} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: space.md, gap: space.md, maxWidth: 480 },
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
  row: { flexDirection: 'row', gap: space.sm },
  flex: { flex: 1 },
  typeRow: { flexDirection: 'row', gap: space.sm },
  linkBox: {
    backgroundColor: color.surface,
    borderRadius: shape.radius,
    padding: space.sm,
  },
  link: { fontSize: typeTokens.size.sm, color: color.primary },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
  action: { marginTop: space.sm },
});
