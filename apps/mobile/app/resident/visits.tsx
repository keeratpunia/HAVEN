import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';
import * as api from '../../api/client.js';
import { EmptyState } from '../../components/EmptyState.js';
import { StatusChip } from '../../components/StatusChip.js';
import { formatDateIst, formatTimeIst } from '../../lib/formatTime.js';

/**
 * R-13 Guests (tab) — this demo slice shows a single chronological list rather than
 * the full SDD Upcoming/Inside/History segments (out of scope for the minimal slice,
 * see docs/TRACEABILITY.md); each card still carries the required status chip.
 */
export default function HostedVisits() {
  const [visits, setVisits] = useState<api.HostedVisitDto[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    api
      .getHostedVisits()
      .then(setVisits)
      .catch(() => setError(true));
  }, []);

  useEffect(load, [load]);
  useFocusEffect(load);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.body}>Couldn't load your visits. Try again later.</Text>
      </View>
    );
  }

  if (visits === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator accessibilityLabel="Loading your visits" />
      </View>
    );
  }

  if (visits.length === 0) {
    return (
      <View style={styles.container}>
        <EmptyState message="No guests invited yet. Invite someone." />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={visits}
      keyExtractor={(v) => v.id}
      renderItem={({ item }) => (
        <View style={styles.card}>
          <View style={styles.cardRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{item.guestName}</Text>
              <Text style={styles.cardSub}>
                {formatDateIst(item.windowStart)} · {formatTimeIst(item.windowStart)}
              </Text>
            </View>
            <StatusChip status={item.status} />
          </View>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: space.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.md },
  body: { fontSize: typeTokens.size.body, color: color.textMuted, textAlign: 'center' },
  card: {
    backgroundColor: color.surface,
    borderRadius: 12,
    padding: space.md,
    marginBottom: space.sm,
    minHeight: 48,
  },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  cardTitle: {
    fontSize: typeTokens.size.body,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  cardSub: { fontSize: typeTokens.size.sm, color: color.textMuted },
});
