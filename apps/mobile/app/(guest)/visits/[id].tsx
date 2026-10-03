import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { copyFor } from '@haven/shared';
import { color, space, type as typeTokens } from '@haven/ui';
import * as api from '../../../api/client.js';
import { Banner, OfflineBanner } from '../../../components/Banner.js';
import { Button } from '../../../components/Button.js';
import { ErrorState } from '../../../components/ErrorState.js';
import { LiveCamera } from '../../../components/LiveCamera.js';
import { StatusChip } from '../../../components/StatusChip.js';
import { captureGeolocation } from '../../../lib/useGeolocation.js';
import { useOnline } from '../../../lib/useOnline.js';
import { formatDateIst, formatTimeIst } from '../../../lib/formatTime.js';

type GatePhase = 'explain_location' | 'locating' | 'photo' | 'submitting' | 'done';

/**
 * Combines G-06/07 (visit status), G-10 (location explainer), G-12 (camera), G-14/15/16
 * (check-in/out result), G-18 (zone notice) and G-13 (not-allowed) into one route keyed
 * by `visits.status` — SDD §13.4. The rotating-QR gate-scan session (G-11) is out of
 * scope for this milestone; entry/exit are driven directly from this screen instead
 * (see docs/DECISIONS.md).
 */
export default function VisitDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const online = useOnline();

  const [visit, setVisit] = useState<api.VisitDto | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [phase, setPhase] = useState<GatePhase>('explain_location');
  const [locationAttempts, setLocationAttempts] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const fixRef = useRef<{ lat: number; lng: number; accuracyM: number } | null>(null);
  const actionKindRef = useRef<'check-in' | 'check-out'>('check-in');

  const load = useCallback(() => {
    if (!id) return;
    api
      .getVisit(id)
      .then(setVisit)
      .catch(() => setLoadError(true));
  }, [id]);

  useEffect(load, [load]);

  async function startGateFlow(kind: 'check-in' | 'check-out') {
    actionKindRef.current = kind;
    setActionError(null);
    setPhase('locating');
    const result = await captureGeolocation();
    if (!result.ok) {
      setLocationAttempts((n) => n + 1);
      if (locationAttempts + 1 >= 3) {
        setActionError('location_failed_3x');
      } else {
        setActionError(result.reason);
      }
      setPhase('explain_location');
      return;
    }
    fixRef.current = result.fix;
    setPhase('photo');
  }

  async function onPhotoCaptured() {
    if (!id || !fixRef.current) return;
    setPhase('submitting');
    setActionError(null);
    try {
      const fn = actionKindRef.current === 'check-in' ? api.checkIn : api.checkOut;
      const updated = await fn(id, {
        lat: fixRef.current.lat,
        lng: fixRef.current.lng,
        accuracyM: fixRef.current.accuracyM,
      });
      setVisit(updated);
      setPhase('done');
    } catch (err) {
      setActionError(err instanceof api.ApiError ? err.code : 'INTERNAL_5XX_GATE');
      setPhase('explain_location');
    }
  }

  if (loadError) {
    return <ErrorState code="INTERNAL_5XX_GATE" onAction={load} />;
  }

  if (!visit) {
    return (
      <View style={styles.center}>
        <ActivityIndicator accessibilityLabel="Loading visit" />
      </View>
    );
  }

  if (
    actionError &&
    ['TOO_EARLY', 'WINDOW_ENDED', 'VISITOR_BANNED', 'HOST_NOT_VERIFIED', 'ALREADY_INSIDE'].includes(
      actionError,
    )
  ) {
    return <ErrorState code={actionError} onAction={() => setActionError(null)} />;
  }

  const canCheckIn = visit.status === 'approved' || visit.status === 'pre_invite_created';
  const canCheckOut = visit.status === 'inside';

  return (
    <View style={styles.container}>
      <OfflineBanner online={online} />

      <View style={styles.headerRow}>
        <Text style={styles.title}>{visit.hostFirstName ?? visit.hostelName}</Text>
        <StatusChip status={visit.status} />
      </View>
      <Text style={styles.sub}>
        {formatDateIst(visit.windowStart)} · {formatTimeIst(visit.windowStart)}–
        {formatTimeIst(visit.windowEnd)}
      </Text>

      {visit.status === 'inside' ? (
        <Banner
          tone="warning"
          text={`${copyFor('ZONE_NOTICE').title} — ${copyFor('ZONE_NOTICE').body}`}
        />
      ) : null}

      {phase === 'explain_location' && (canCheckIn || canCheckOut) ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>We need your location</Text>
          <Text style={styles.body}>
            This confirms you're at the gate. HAVEN only checks this at the moment of entry and
            exit.
          </Text>
          {actionError === 'location_failed_3x' ? (
            <Text style={styles.error} accessibilityRole="alert">
              We still can't find you. Ask office staff for help.
            </Text>
          ) : actionError === 'denied' ? (
            <Text style={styles.error} accessibilityRole="alert">
              Turn on location access for this site, then try again.
            </Text>
          ) : actionError === 'low_accuracy' ? (
            <Text style={styles.error} accessibilityRole="alert">
              {copyFor('low_accuracy').body}
            </Text>
          ) : actionError ? (
            <Text style={styles.error} accessibilityRole="alert">
              {copyFor(actionError).body}
            </Text>
          ) : null}
          <View style={styles.action}>
            <Button
              label={canCheckOut ? 'Check out' : 'Check in'}
              onPress={() => startGateFlow(canCheckOut ? 'check-out' : 'check-in')}
              disabled={actionError === 'location_failed_3x'}
            />
          </View>
        </View>
      ) : null}

      {phase === 'locating' ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel="Finding your location" />
          <Text style={styles.body}>Finding your location…</Text>
        </View>
      ) : null}

      {phase === 'photo' ? (
        <>
          <LiveCamera
            guideText="Look at the camera"
            onCapture={onPhotoCaptured}
            onPermissionDenied={() => setActionError('camera_denied')}
          />
          {actionError === 'camera_denied' ? (
            <Text style={styles.error} accessibilityRole="alert">
              Allow camera access in your browser's site settings, then reload this page.
            </Text>
          ) : null}
        </>
      ) : null}

      {phase === 'submitting' ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel="Submitting" />
        </View>
      ) : null}

      {phase === 'done' ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {actionKindRef.current === 'check-in'
              ? copyFor('CHECK_IN_SUCCESS').title
              : "You've checked out. Thanks!"}
          </Text>
        </View>
      ) : null}

      {!canCheckIn && !canCheckOut && phase === 'explain_location' ? (
        <View style={styles.card}>
          <Text style={styles.body}>Status: {visit.status}</Text>
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
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  sub: { fontSize: typeTokens.size.sm, color: color.textMuted },
  card: { backgroundColor: color.surface, borderRadius: 12, padding: space.md, gap: space.sm },
  cardTitle: {
    fontSize: typeTokens.size.body,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
  action: { marginTop: space.sm },
});
