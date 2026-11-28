import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { copyFor } from '@haven/shared';
import { color, space, type as typeTokens } from '@haven/ui';
import * as api from '../../../services/api-client.js';
import { OfflineBanner } from '../../../components/Banner.js';
import { ErrorState } from '../../../components/ErrorState.js';
import { StatusChip } from '../../../components/StatusChip.js';
import { useOnline } from '../../../lib/useOnline.js';
import { formatDateIst, formatTimeIst } from '../../../lib/formatTime.js';

/**
 * G-06/G-07/G-12/G-14/G-17/G-18 (visit status, SDD §13.4) — read-only. Check-in and
 * check-out only happen by scanning the gate's QR (`/g/[token]`, SDD FR-21: "Scanning
 * the QR... validates token + GPS before showing anything else"); this screen used to
 * offer its own direct Check in/Check out buttons against a temporary, non-SDD
 * endpoint — see docs/DECISIONS.md DEC-010 for why that was removed.
 */
export default function VisitDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const online = useOnline();

  const [visit, setVisit] = useState<api.VisitDto | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    api
      .getVisit(id)
      .then(setVisit)
      .catch(() => setLoadError(true));
  }, [id]);

  useEffect(load, [load]);

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

  const canCheckIn = visit.status === 'approved';
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
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{copyFor('ZONE_NOTICE').title}</Text>
          <Text style={styles.body}>{copyFor('ZONE_NOTICE').body}</Text>
        </View>
      ) : null}

      {canCheckIn || canCheckOut ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {canCheckOut ? 'Ready to check out?' : 'Ready to check in?'}
          </Text>
          <Text style={styles.body}>
            Scan the QR on the screen at the hostel gate with your phone camera.
          </Text>
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
});
