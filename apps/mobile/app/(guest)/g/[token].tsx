import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { copyFor, fillCopy } from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../../api/client.js';
import { OfflineBanner } from '../../../components/Banner.js';
import { Button } from '../../../components/Button.js';
import { Countdown } from '../../../components/Countdown.js';
import { EmptyState } from '../../../components/EmptyState.js';
import { ErrorState } from '../../../components/ErrorState.js';
import { LiveCamera } from '../../../components/LiveCamera.js';
import { StatusChip } from '../../../components/StatusChip.js';
import { useAuth } from '../../../lib/auth-context.js';
import { useOnline } from '../../../lib/useOnline.js';
import { captureScanLocation } from '../../../lib/useScanLocation.js';
import { formatTimeIst } from '../../../lib/formatTime.js';

/**
 * G-06/G-07/G-08/G-09/G-10/G-11/G-12/G-13/G-14/G-15/G-18 (SDD §13.4), the one real
 * entry point for the gate flow (SDD §6: "Every gate interaction starts the same way:
 * the guest scans the gate QR"). Flow: create a scan session (with best-effort
 * location) -> resolve what the server says is possible (check in / check out /
 * request entry) -> live photo -> the matching `/scan-sessions/:id/*` call -> result.
 *
 * Replaces the guest-web milestone's direct `visits/[id]` check-in/out buttons — those
 * called temporary, non-SDD endpoints (see docs/DECISIONS.md DEC-010); every real
 * check-in/out/walk-in now starts here, from a scanned gate token, matching FR-21.
 */

const SEEN_LOCATION_EXPLAINER_KEY = 'haven.guest.seenLocationExplainer';
const MAX_LOCATION_ATTEMPTS = 3;

type Phase =
  | 'location_explainer'
  | 'locating'
  | 'location_problem'
  | 'resolving_actions'
  | 'find_host'
  | 'visit_type'
  | 'confirm_action'
  | 'photo'
  | 'submitting'
  | 'done'
  | 'waiting_for_host'
  | 'error';

function randomClientNonce(): string {
  const bytes = new Uint8Array(16);
  if (Platform.OS === 'web' && typeof crypto !== 'undefined') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** `scan_sessions.gps_failure` values (SDD §9.3) are lowercase/snake_case; the §13.6
 * copy table keys the geofence one as `OUT_OF_GEOFENCE` — everything else
 * (`low_accuracy`, `stale_fix`, `no_location`, `gate_not_configured`) matches as-is,
 * or falls through to `copyFor`'s own generic fallback. */
function copyKeyForGpsFailure(failure: string): string {
  return failure === 'outside_geofence' ? 'OUT_OF_GEOFENCE' : failure;
}

function hasSeenLocationExplainer(): boolean {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return true;
  try {
    return localStorage.getItem(SEEN_LOCATION_EXPLAINER_KEY) === '1';
  } catch {
    return true;
  }
}

function markSeenLocationExplainer(): void {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SEEN_LOCATION_EXPLAINER_KEY, '1');
  } catch {
    // ignore
  }
}

export default function GateScan() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const online = useOnline();
  const { visitor, loading: authLoading } = useAuth();

  const [phase, setPhase] = useState<Phase>(
    hasSeenLocationExplainer() ? 'locating' : 'location_explainer',
  );
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [locationAttempts, setLocationAttempts] = useState(0);
  const [session, setSession] = useState<api.ScanSessionResult | null>(null);
  const [scanActions, setScanActions] = useState<api.ScanSessionActions | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [hostFirstName, setHostFirstName] = useState<string>('your host');
  const [visitType, setVisitType] = useState<'quick_drop' | 'day'>('day');
  const [room, setRoom] = useState('');
  const [residents, setResidents] = useState<{ userId: string; fullName: string }[] | null>(null);
  const [hostelId, setHostelId] = useState<string | null>(null);
  const [resultKind, setResultKind] = useState<'check_in' | 'check_out' | 'walk_in'>('check_in');
  const [resultStatus, setResultStatus] = useState<string | null>(null);
  const [walkInVisitId, setWalkInVisitId] = useState<string | null>(null);
  const [walkInStatus, setWalkInStatus] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const clientNonceRef = useRef<string>(randomClientNonce());

  const runCreateSession = useCallback(async () => {
    setPhase('locating');
    setErrorCode(null);
    const { location, locationError } = await captureScanLocation();
    try {
      const result = await api.createScanSession({
        token,
        clientNonce: clientNonceRef.current,
        location,
      });
      setSession(result);
      if (result.gpsOk) {
        setPhase('resolving_actions');
      } else {
        setLocationAttempts(1);
        setErrorCode(result.gpsFailure ?? locationError ?? 'no_location');
        setPhase('location_problem');
      }
    } catch (err) {
      setErrorCode(err instanceof api.ApiError ? err.code : 'INTERNAL_5XX_GATE');
      setPhase('error');
    }
  }, [token]);

  useEffect(() => {
    if (phase === 'locating' && !session) {
      void runCreateSession();
    }
  }, [phase, session, runCreateSession]);

  async function retryLocation() {
    if (!session) return;
    setPhase('locating');
    const { location, locationError } = await captureScanLocation();
    try {
      const result = await api.retryScanSessionLocation(session.scanSessionId, location);
      setSession(result);
      if (result.gpsOk) {
        setPhase('resolving_actions');
      } else {
        const nextAttempt = locationAttempts + 1;
        setLocationAttempts(nextAttempt);
        setErrorCode(result.gpsFailure ?? locationError ?? 'no_location');
        setPhase('location_problem');
      }
    } catch (err) {
      if (err instanceof api.ApiError && err.code === 'LOCATION_RETRY_LIMIT') {
        setLocationAttempts(MAX_LOCATION_ATTEMPTS);
        setPhase('location_problem');
      } else {
        setErrorCode(err instanceof api.ApiError ? err.code : 'INTERNAL_5XX_GATE');
        setPhase('error');
      }
    }
  }

  // FR-27: after 3 GPS failures (or permission denial), proceed anyway — the session
  // already exists with gpsOk: false; check-in/walk-in still work, landing on
  // `awaiting_host_confirmation` instead of an immediate `inside` (SDD F3).
  function askHostToConfirm() {
    setPhase('resolving_actions');
  }

  useEffect(() => {
    if (phase !== 'resolving_actions' || !session) return;
    if (authLoading) return;
    if (!visitor) {
      router.replace({ pathname: '/login', params: { returnTo: `/g/${token}` } });
      return;
    }
    api
      .getScanSession(session.scanSessionId, clientNonceRef.current)
      .then((actions) => {
        setScanActions(actions);
        const primary = actions.actions[0];
        if (primary === 'check_in' || primary === 'check_out') {
          setResultKind(primary);
          setPhase('confirm_action');
        } else {
          setPhase('find_host');
        }
      })
      .catch((err: unknown) => {
        setErrorCode(err instanceof api.ApiError ? err.code : 'INTERNAL_5XX_GATE');
        setPhase('error');
      });
  }, [phase, session, authLoading, visitor, router, token]);

  useEffect(() => {
    if (phase === 'find_host' && !hostelId) {
      api
        .getHostels()
        .then((hostels) => setHostelId(hostels[0]?.id ?? null))
        .catch(() => undefined);
    }
  }, [phase, hostelId]);

  async function searchHostRoom() {
    if (!hostelId || !room.trim()) return;
    const found = await api.searchRooms(hostelId, room.trim());
    setResidents(found);
  }

  async function onPhotoCaptured(dataUrl: string) {
    if (!session) return;
    setPhase('submitting');
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const { photoId } = await api.uploadScanSessionPhoto(
        session.scanSessionId,
        clientNonceRef.current,
        blob,
      );

      if (resultKind === 'check_in') {
        const visitId = scanActions?.visits[0]?.id;
        if (!visitId) throw new api.ApiError('NOT_FOUND', 404, 'Visit not found.');
        const res = await api.scanSessionCheckIn(session.scanSessionId, clientNonceRef.current, {
          visitId,
          photoId,
        });
        setResultStatus(res.result);
        setPhase('done');
      } else if (resultKind === 'check_out') {
        const visitId = scanActions?.visits[0]?.id;
        if (!visitId) throw new api.ApiError('NOT_FOUND', 404, 'Visit not found.');
        await api.scanSessionCheckOut(session.scanSessionId, clientNonceRef.current, {
          visitId,
          photoId,
        });
        setPhase('done');
      } else {
        if (!hostId) throw new api.ApiError('VALIDATION_FAILED', 400, 'Pick a host first.');
        const { visit } = await api.scanSessionWalkIn(
          session.scanSessionId,
          clientNonceRef.current,
          {
            hostId,
            type: visitType,
            durationMinutes: visitType === 'quick_drop' ? 15 : 120,
            photoId,
          },
        );
        setWalkInVisitId(visit.id);
        setPhase('waiting_for_host');
      }
    } catch (err) {
      setErrorCode(err instanceof api.ApiError ? err.code : 'INTERNAL_5XX_GATE');
      setPhase('error');
    }
  }

  // FR-26: poll every 3 seconds while waiting for the host's decision, so the screen
  // turns green on its own without a reload.
  useEffect(() => {
    if (phase !== 'waiting_for_host' || !walkInVisitId) return;
    let cancelled = false;
    const interval = setInterval(() => {
      api
        .getVisit(walkInVisitId)
        .then((visit) => {
          if (cancelled) return;
          if (visit.status !== 'pending_host') {
            setWalkInStatus(visit.status);
          }
        })
        .catch(() => undefined);
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [phase, walkInVisitId]);

  async function cancelWalkIn() {
    if (!walkInVisitId) return;
    setCancelling(true);
    try {
      await api.cancelMyVisit(walkInVisitId);
      setWalkInStatus('cancelled');
    } catch (err) {
      setErrorCode(err instanceof api.ApiError ? err.code : 'INTERNAL_5XX_GATE');
      setPhase('error');
    } finally {
      setCancelling(false);
    }
  }

  if (phase === 'error' && errorCode) {
    return <ErrorState code={errorCode} onAction={() => router.replace('/visits')} />;
  }

  return (
    <View style={styles.container}>
      <OfflineBanner online={online} />

      {phase === 'location_explainer' ? (
        <View style={styles.card}>
          <Text style={styles.title}>We need your location</Text>
          <Text style={styles.body}>
            This only happens at the gate, to confirm you're here. We never track you otherwise.
          </Text>
          <View style={styles.action}>
            <Button
              label="Allow location"
              onPress={() => {
                markSeenLocationExplainer();
                setPhase('locating');
              }}
            />
          </View>
        </View>
      ) : null}

      {phase === 'locating' ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel="Checking you're at the gate" />
          <Text style={styles.body}>Checking you're at the gate…</Text>
        </View>
      ) : null}

      {phase === 'location_problem' ? (
        <View style={styles.card}>
          <Text style={styles.title}>
            {copyFor(copyKeyForGpsFailure(errorCode ?? 'low_accuracy')).title}
          </Text>
          <Text style={styles.body}>
            {copyFor(copyKeyForGpsFailure(errorCode ?? 'low_accuracy')).body}
          </Text>
          <Text style={styles.hint}>
            Attempt {locationAttempts} of {MAX_LOCATION_ATTEMPTS}
          </Text>
          <View style={styles.action}>
            {locationAttempts >= MAX_LOCATION_ATTEMPTS ? (
              <Button label="Ask host to confirm" onPress={askHostToConfirm} />
            ) : (
              <Button label="Try again" onPress={retryLocation} />
            )}
          </View>
        </View>
      ) : null}

      {phase === 'resolving_actions' ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel="Loading" />
        </View>
      ) : null}

      {phase === 'confirm_action' ? (
        <View style={styles.card}>
          <Text style={styles.title}>{resultKind === 'check_in' ? 'Check in' : 'Check out'}</Text>
          {scanActions?.visits[0] ? (
            <Text style={styles.body}>
              Visiting {scanActions.visits[0].hostFirstName ?? scanActions.visits[0].hostelName}{' '}
              until {formatTimeIst(scanActions.visits[0].windowEnd)}
            </Text>
          ) : null}
          <View style={styles.action}>
            <Button
              label={resultKind === 'check_in' ? 'Check in' : 'Check out'}
              onPress={() => setPhase('photo')}
            />
          </View>
        </View>
      ) : null}

      {phase === 'find_host' ? (
        <View style={styles.card}>
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
              onPress={searchHostRoom}
              fullWidth={false}
              disabled={!room.trim()}
            />
          </View>
          {residents !== null &&
            (residents.length === 0 ? (
              <EmptyState message={`No registered resident in room ${room}.`} />
            ) : (
              <View style={styles.list}>
                {residents.map((r) => (
                  <Pressable
                    key={r.userId}
                    onPress={() => {
                      setHostId(r.userId);
                      setHostFirstName(r.fullName.split(' ')[0] ?? 'your host');
                      setResultKind('walk_in');
                      setPhase('visit_type');
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
        </View>
      ) : null}

      {phase === 'visit_type' ? (
        <View style={styles.card}>
          <Text style={styles.title}>Visit type</Text>
          <View style={styles.typeRow}>
            {(['quick_drop', 'day'] as const).map((t) => (
              <Pressable
                key={t}
                onPress={() => setVisitType(t)}
                accessibilityRole="radio"
                accessibilityState={{ checked: visitType === t }}
                accessibilityLabel={t === 'quick_drop' ? 'Quick drop-off' : 'Day visit'}
                style={[styles.typeOption, visitType === t && styles.typeOptionSelected]}
              >
                <Text style={[styles.body, visitType === t && styles.typeTextSelected]}>
                  {t === 'quick_drop' ? 'Quick drop-off' : 'Day visit'}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.action}>
            <Button label="Continue" onPress={() => setPhase('photo')} />
          </View>
        </View>
      ) : null}

      {phase === 'photo' ? (
        <LiveCamera
          guideText="Take a photo so your host knows it's you"
          onCapture={onPhotoCaptured}
          onPermissionDenied={() => {
            setErrorCode('camera_denied');
            setPhase('error');
          }}
        />
      ) : null}

      {phase === 'submitting' ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel="Submitting" />
        </View>
      ) : null}

      {phase === 'waiting_for_host' ? (
        <View style={styles.card}>
          {walkInStatus === 'inside' ? (
            <>
              <Text style={styles.title}>{copyFor('CHECK_IN_SUCCESS').title}</Text>
              <StatusChip status="inside" />
              <View style={styles.action}>
                <Button label="Done" onPress={() => router.replace('/visits')} />
              </View>
            </>
          ) : walkInStatus === 'rejected' ? (
            <>
              <Text style={styles.title}>
                {fillCopy(copyFor('WALK_IN_REJECTED'), { hostFirstName }).title}
              </Text>
              <Text style={styles.body}>{copyFor('WALK_IN_REJECTED').body}</Text>
              <View style={styles.action}>
                <Button label="Go to My visits" onPress={() => router.replace('/visits')} />
              </View>
            </>
          ) : walkInStatus === 'cancelled' ? (
            <>
              <Text style={styles.title}>Request cancelled</Text>
              <View style={styles.action}>
                <Button label="Go to My visits" onPress={() => router.replace('/visits')} />
              </View>
            </>
          ) : (
            <>
              <Text style={styles.title}>Waiting for host</Text>
              <Text style={styles.body}>We've notified your host.</Text>
              <Countdown seconds={600} label={(s) => `Expires in ${Math.ceil(s / 60)} min`} />
              <View style={styles.action}>
                <Button
                  label="Cancel request"
                  variant="secondary"
                  onPress={cancelWalkIn}
                  loading={cancelling}
                />
              </View>
            </>
          )}
        </View>
      ) : null}

      {phase === 'done' ? (
        <View style={styles.card}>
          {resultKind === 'check_out' ? (
            <Text style={styles.title}>You've checked out. Thanks!</Text>
          ) : resultStatus === 'awaiting_host_confirmation' ? (
            <>
              <Text style={styles.title}>
                {
                  fillCopy(copyFor('HOST_CONFIRM_PATH'), {
                    hostFirstName: scanActions?.visits[0]?.hostFirstName ?? 'your host',
                    subject: "you're",
                  }).title
                }
              </Text>
              <Text style={styles.body}>{copyFor('HOST_CONFIRM_PATH').body}</Text>
            </>
          ) : (
            <>
              <Text style={styles.title}>{copyFor('CHECK_IN_SUCCESS').title}</Text>
              <StatusChip status="inside" />
            </>
          )}
          <View style={styles.action}>
            <Button label="Done" onPress={() => router.replace('/visits')} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: space.md, gap: space.md },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    padding: space.md,
  },
  card: {
    backgroundColor: color.surface,
    borderRadius: shape.radius,
    padding: space.md,
    gap: space.sm,
  },
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
  hint: { fontSize: typeTokens.size.sm, color: color.textMuted },
  label: { fontSize: typeTokens.size.sm, color: color.textMuted },
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
  typeRow: { flexDirection: 'row', gap: space.xs },
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
  action: { marginTop: space.sm },
});
