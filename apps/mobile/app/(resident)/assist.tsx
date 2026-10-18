import { useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  copyFor,
  formatDuration,
  localDateTimeToUtc,
  toLocalDateString,
  type VisitDTO,
} from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../api/client.js';
import { Button } from '../../components/Button.js';
import { LiveCamera } from '../../components/LiveCamera.js';
import { PhoneInput } from '../../components/PhoneInput.js';
import { QrScanner } from '../../components/QrScanner.js';
import { Segments } from '../../components/Segments.js';
import { StatusChip } from '../../components/StatusChip.js';
import { VisitCard } from '../../components/VisitCard.js';
import { newActionKey } from '../../lib/action-key.js';
import { successHaptic } from '../../lib/haptics.js';
import { ruleMessage, RULES } from '../../lib/rule-hints.js';
import { captureScanLocation } from '../../lib/useScanLocation.js';

/**
 * R-12 Guest without phone (SDD §13.4, F4, FR-28): "Scan gate QR (camera) → guest
 * name, gender, phone (optional), type, duration → photo — Check in guest". Check-out
 * is the same scan, then picking the visit (F4 step 5). Mock-location detection on
 * Android refuses before calling the API (F4 step 2).
 */
type Mode = 'in' | 'out';
type Phase =
  | 'choose'
  | 'scan'
  | 'locating'
  | 'location'
  | 'form'
  | 'photo'
  | 'pick'
  | 'busy'
  | 'done'
  | 'error';
const MAX_ATTEMPTS = 3;

function tokenFrom(scanned: string): string | null {
  const match = /\/g\/([^/?#\s]+)/.exec(scanned);
  return match?.[1] ?? null;
}

function newNonce(): string {
  return newActionKey().replace(/-/g, '');
}

export default function Assist() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('in');
  const [phase, setPhase] = useState<Phase>('choose');
  const [problem, setProblem] = useState<{ title: string; body: string } | null>(null);
  const [session, setSession] = useState<{ id: string; nonce: string; gpsOk: boolean } | null>(
    null,
  );
  const [attempts, setAttempts] = useState(0);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState<'female' | 'male' | 'undisclosed' | null>(null);
  const [type, setType] = useState<'day' | 'quick_drop'>('day');
  const [duration, setDuration] = useState(60);
  const [inside, setInside] = useState<VisitDTO[] | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const actionKey = useRef<string | null>(null);

  function fail(code: string, fallback?: { title: string; body: string }) {
    setProblem(fallback ?? copyFor(code));
    setPhase('error');
  }

  async function onScanned(text: string) {
    const token = tokenFrom(text);
    if (!token) return fail('GATE_TOKEN_INVALID');
    setPhase('locating');
    const nonce = newNonce();
    const { location, locationError } = await captureScanLocation();
    if (locationError === 'mocked') {
      return fail('MOCK_LOCATION', {
        title: 'Turn off fake location apps',
        body: 'Fake location apps must be turned off.',
      });
    }
    try {
      const res = await api.createScanSession({ token, clientNonce: nonce, location });
      setSession({ id: res.scanSessionId, nonce, gpsOk: res.gpsOk });
      setAttempts(1);
      if (!res.gpsOk) {
        setProblem(
          copyFor(res.gpsFailure === 'outside_geofence' ? 'OUT_OF_GEOFENCE' : 'low_accuracy'),
        );
        setPhase('location');
      } else {
        await next();
      }
    } catch (err) {
      fail(err instanceof api.ApiError ? err.code : 'INTERNAL_5XX_GATE');
    }
  }

  async function retryLocation() {
    if (!session) return;
    setPhase('locating');
    const { location, locationError } = await captureScanLocation();
    if (locationError === 'mocked') {
      return fail('MOCK_LOCATION', {
        title: 'Turn off fake location apps',
        body: 'Fake location apps must be turned off.',
      });
    }
    try {
      const res = await api.retryScanSessionLocation(session.id, session.nonce, location);
      setAttempts((a) => a + 1);
      setSession({ ...session, gpsOk: res.gpsOk });
      if (res.gpsOk) await next();
      else setPhase('location');
    } catch (err) {
      if (err instanceof api.ApiError && err.code === 'LOCATION_RETRY_LIMIT') {
        setAttempts(MAX_ATTEMPTS);
        setPhase('location');
      } else fail(err instanceof api.ApiError ? err.code : 'INTERNAL_5XX_GATE');
    }
  }

  async function next() {
    if (mode === 'in') {
      setPhase('form');
      return;
    }
    setPhase('busy');
    const page = await api.getHostedVisits({ bucket: 'inside', limit: 50 });
    setInside(page.items);
    setPhase('pick');
  }

  async function checkIn(dataUrl: string) {
    if (!session || !gender) return;
    setPhase('busy');
    actionKey.current = actionKey.current ?? newActionKey();
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const { photoId } = await api.uploadScanSessionPhoto(session.id, session.nonce, blob);
      await api.hostAssistedEntry(session.id, session.nonce, actionKey.current, {
        guest: { name: name.trim(), gender, phone: phone ? `+91${phone}` : null },
        type,
        durationMinutes: type === 'quick_drop' ? RULES.quick_drop_minutes : duration,
        photoId,
      });
      successHaptic();
      setResult(`${name.trim()} is checked in.`);
      setPhase('done');
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 422) fail(err.code, rule(err.code));
      else fail(err instanceof api.ApiError ? err.code : 'INTERNAL_5XX_GATE');
    }
  }

  async function checkOut(visit: VisitDTO) {
    if (!session) return;
    setPhase('busy');
    actionKey.current = actionKey.current ?? newActionKey();
    try {
      await api.hostAssistedExit(session.id, session.nonce, actionKey.current, visit.id);
      setResult(`${visit.guest.name} is checked out.`);
      setPhase('done');
    } catch (err) {
      fail(err instanceof api.ApiError ? err.code : 'INTERNAL_5XX_GATE');
    }
  }

  // G-09's duration chips, capped at the day-visit latest end (SDD F2 step 4).
  const today = toLocalDateString(new Date(), RULES.timezone);
  const untilEight = Math.floor(
    (localDateTimeToUtc(today, RULES.last_entry_day, RULES.timezone).getTime() - Date.now()) /
      60_000,
  );
  const durations = [30, 60, 120, 180].filter((m) => m > 0);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        {mode === 'in' ? 'Check in a guest without a phone' : 'Check out a guest'}
      </Text>

      {phase === 'choose' ? (
        <>
          <Text style={styles.body}>
            Go to the gate first. You'll scan the QR on the gate screen.
          </Text>
          <Button
            label="Check in a guest"
            onPress={() => {
              setMode('in');
              setPhase('scan');
            }}
          />
          <Button
            label="Check out a guest"
            variant="secondary"
            onPress={() => {
              setMode('out');
              setPhase('scan');
            }}
          />
        </>
      ) : null}

      {phase === 'scan' ? (
        <QrScanner
          onScan={(t) => void onScanned(t)}
          onPermissionDenied={() => fail('camera_denied')}
        />
      ) : null}

      {phase === 'locating' || phase === 'busy' ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel="Working" />
          <Text style={styles.body}>
            {phase === 'locating' ? "Checking you're at the gate…" : 'One moment…'}
          </Text>
        </View>
      ) : null}

      {phase === 'location' && problem ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{problem.title}</Text>
          <Text style={styles.body}>{problem.body}</Text>
          <Text style={styles.hint}>
            Attempt {attempts} of {MAX_ATTEMPTS}
          </Text>
          {attempts < MAX_ATTEMPTS ? (
            <Button label="Try again" onPress={retryLocation} />
          ) : (
            <Button
              label="Continue without location"
              variant="secondary"
              onPress={() => void next()}
            />
          )}
        </View>
      ) : null}

      {phase === 'form' ? (
        <>
          <View>
            <Text style={styles.label} nativeID="a-name-label">
              Guest name
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              style={styles.input}
              placeholder="Full name"
              placeholderTextColor={color.textMuted}
              accessibilityLabel="Guest name"
              accessibilityLabelledBy="a-name-label"
              maxLength={80}
            />
          </View>
          <Text style={styles.label}>Gender</Text>
          <Segments
            options={[
              { value: 'female', label: 'Female' },
              { value: 'male', label: 'Male' },
              { value: 'undisclosed', label: 'Prefer not to say' },
            ]}
            value={gender ?? ('' as 'female')}
            onChange={setGender}
          />
          <PhoneInput value={phone} onChange={setPhone} hint="Optional." />
          <Segments
            options={[
              { value: 'day', label: 'Day visit' },
              { value: 'quick_drop', label: 'Quick drop-off' },
            ]}
            value={type}
            onChange={setType}
          />
          {type === 'day' ? (
            <Segments
              options={[
                ...durations.map((m) => ({ value: String(m), label: formatDuration(m) })),
                ...(untilEight > 0 ? [{ value: String(untilEight), label: 'Until 8 pm' }] : []),
              ]}
              value={String(duration)}
              onChange={(v) => setDuration(Number(v))}
            />
          ) : null}
          <Button
            label="Continue"
            onPress={() => setPhase('photo')}
            disabled={
              name.trim().length < 2 || !gender || (phone.length > 0 && phone.length !== 10)
            }
          />
        </>
      ) : null}

      {phase === 'photo' ? (
        <LiveCamera
          facing="environment"
          guideText="Take a photo of your guest."
          onCapture={(url) => void checkIn(url)}
          onPermissionDenied={() => fail('camera_denied')}
        />
      ) : null}

      {phase === 'pick' ? (
        <View style={styles.list}>
          {(inside ?? []).length === 0 ? (
            <Text style={styles.body}>None of your guests are inside.</Text>
          ) : null}
          {(inside ?? []).map((v) => (
            <VisitCard key={v.id} visit={v} onPress={() => void checkOut(v)} />
          ))}
        </View>
      ) : null}

      {phase === 'done' && result ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{result}</Text>
          <StatusChip status={mode === 'in' ? 'inside' : 'completed'} />
          <Button label="Done" onPress={() => router.replace('/home')} />
        </View>
      ) : null}

      {phase === 'error' && problem ? (
        <View style={styles.card} accessibilityRole="alert">
          <Text style={styles.cardTitle}>✕ {problem.title}</Text>
          <Text style={styles.body}>{problem.body}</Text>
          <Button
            label="Scan again"
            onPress={() => {
              setProblem(null);
              setSession(null);
              actionKey.current = null;
              setPhase('scan');
            }}
          />
        </View>
      ) : null}
    </ScrollView>
  );
}

function rule(code: string): { title: string; body: string } {
  const copy = copyFor(code);
  return copy.title === 'Something went wrong'
    ? { title: 'Not allowed', body: ruleMessage(code) }
    : copy;
}

const styles = StyleSheet.create({
  container: {
    padding: space.md,
    gap: space.md,
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  center: { alignItems: 'center', gap: space.sm, padding: space.md },
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
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
  card: {
    backgroundColor: color.surface,
    borderRadius: shape.radius,
    padding: space.md,
    gap: space.sm,
  },
  cardTitle: {
    fontSize: typeTokens.size.md,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  list: { gap: space.sm },
});
