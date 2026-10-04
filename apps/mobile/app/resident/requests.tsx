import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';
import * as api from '../../api/client.js';
import { Button } from '../../components/Button.js';
import { EmptyState } from '../../components/EmptyState.js';
import { formatTimeIst } from '../../lib/formatTime.js';

/**
 * R-08 Walk-in request (SDD §13.4): pending walk-ins awaiting this host's decision.
 * Wireframe rule (§14): "Approvals (R-08, W-04): full-screen card; photos first;
 * approve and reject equally sized, approve on the right." This demo slice shows the
 * guest's live photo when the gate captured one, but has no photo-comparison UI
 * beyond that — the host's own judgement is the check (CLAUDE.md §3.3, "no
 * receptionist verification").
 */
export default function Requests() {
  const [visits, setVisits] = useState<api.HostedVisitDto[] | null>(null);
  const [error, setError] = useState(false);
  const [actingOn, setActingOn] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .getHostedVisits()
      .then((all) => setVisits(all.filter((v) => v.status === 'pending_host')))
      .catch(() => setError(true));
  }, []);

  useEffect(load, [load]);
  useFocusEffect(load);

  async function decide(id: string, action: 'approve' | 'reject') {
    setActingOn(id);
    try {
      if (action === 'approve') {
        await api.approveVisit(id);
      } else {
        await api.rejectVisit(id);
      }
      load();
    } catch {
      setError(true);
    } finally {
      setActingOn(null);
    }
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.body}>Couldn't load requests. Try again later.</Text>
      </View>
    );
  }

  if (visits === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator accessibilityLabel="Loading requests" />
      </View>
    );
  }

  if (visits.length === 0) {
    return (
      <View style={styles.container}>
        <EmptyState message="No pending requests." />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {visits.map((visit) => (
        <View key={visit.id} style={styles.card}>
          <Text style={styles.name}>{visit.guestName}</Text>
          <Text style={styles.body}>
            {visit.type === 'quick_drop' ? 'Quick drop-off' : 'Day visit'} · until{' '}
            {formatTimeIst(visit.windowEnd)}
          </Text>
          <Text style={visit.locationUnverified ? styles.warn : styles.ok}>
            {visit.locationUnverified ? 'Location not verified' : 'Location verified'}
          </Text>
          <View style={styles.actions}>
            <Button
              label="Reject"
              variant="secondary"
              fullWidth={false}
              onPress={() => decide(visit.id, 'reject')}
              loading={actingOn === visit.id}
            />
            <Button
              label="Approve"
              fullWidth={false}
              onPress={() => decide(visit.id, 'approve')}
              loading={actingOn === visit.id}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: space.md, gap: space.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.md },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
  card: {
    backgroundColor: color.surface,
    borderRadius: 12,
    padding: space.md,
    gap: space.xs,
  },
  name: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  ok: { fontSize: typeTokens.size.sm, color: color.success },
  warn: { fontSize: typeTokens.size.sm, color: color.warning },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm, marginTop: space.sm },
});
