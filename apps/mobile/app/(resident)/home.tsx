import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatDateShort, toLocalDateString, type VisitDTO } from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../api/client.js';
import { Button } from '../../components/Button.js';
import { EmptyState } from '../../components/EmptyState.js';
import { VisitCard } from '../../components/VisitCard.js';
import { useAuth } from '../../lib/auth-context.js';
import { needsHost, screenForVisit } from '../../lib/visit-screen.js';

/**
 * R-05 Home (SDD §13.4): "Inside now (cards with photo, since, ends), pending requests
 * (top, amber), upcoming today, quick actions: Invite, Overnight, Guest without phone
 * — Invite guest". Hosts get push (SDD §9.9); the screen also refreshes every 10 s so
 * a walk-in shows up even where push isn't available (the web fallback).
 */
const REFRESH_MS = 10_000;

export default function Home() {
  const router = useRouter();
  const { user } = useAuth();
  const [inside, setInside] = useState<VisitDTO[] | null>(null);
  const [upcoming, setUpcoming] = useState<VisitDTO[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const [i, u] = await Promise.all([
        api.getHostedVisits({ bucket: 'inside', limit: 50 }),
        api.getHostedVisits({ bucket: 'upcoming', limit: 50 }),
      ]);
      setInside(i.items);
      setUpcoming(u.items);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useEffect(() => {
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const suspendedUntil =
    user?.resident?.status === 'suspended' ? user.resident.hostingSuspendedUntil : null;
  const today = toLocalDateString(new Date(), 'Asia/Kolkata');
  const pending = (upcoming ?? []).filter(needsHost);
  const todayUpcoming = (upcoming ?? []).filter(
    (v) => !needsHost(v) && toLocalDateString(new Date(v.windowStart), 'Asia/Kolkata') === today,
  );

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {user?.resident?.status === 'suspended' ? (
        <View style={styles.suspended} accessibilityRole="alert">
          <Text style={styles.suspendedTitle}>Guest privileges suspended</Text>
          {suspendedUntil ? (
            <Text style={styles.body}>Until {formatDateShort(suspendedUntil)}.</Text>
          ) : null}
        </View>
      ) : null}

      {error ? <Text style={styles.error}>Couldn't load your guests. We'll retry.</Text> : null}
      {inside === null || upcoming === null ? (
        <ActivityIndicator accessibilityLabel="Loading your guests" />
      ) : (
        <>
          {pending.length > 0 ? (
            <View style={styles.section}>
              <Text style={[styles.heading, styles.amber]}>⏱ Waiting for you</Text>
              {pending.map((v) => (
                <View key={v.id} style={styles.pendingCard}>
                  <VisitCard visit={v} onPress={() => router.push(screenForVisit(v) as never)} />
                </View>
              ))}
            </View>
          ) : null}

          <View style={styles.section}>
            <Text style={styles.heading}>Inside now</Text>
            {inside.length === 0 ? (
              <EmptyState message="No guests inside. Invite someone." />
            ) : (
              inside.map((v) => (
                <VisitCard
                  key={v.id}
                  visit={v}
                  onPress={() => router.push(screenForVisit(v) as never)}
                />
              ))
            )}
          </View>

          {todayUpcoming.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.heading}>Upcoming today</Text>
              {todayUpcoming.map((v) => (
                <VisitCard
                  key={v.id}
                  visit={v}
                  onPress={() => router.push(screenForVisit(v) as never)}
                />
              ))}
            </View>
          ) : null}
        </>
      )}

      <View style={styles.quick}>
        <Button
          label="Overnight"
          variant="secondary"
          fullWidth={false}
          onPress={() => router.push('/overnight')}
        />
        <Button
          label="Guest without phone"
          variant="secondary"
          fullWidth={false}
          onPress={() => router.push('/assist')}
        />
      </View>
      <Button
        label="Invite guest"
        onPress={() => router.push('/invite')}
        disabled={user?.resident?.status !== 'verified'}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.md, gap: space.md },
  section: { gap: space.sm },
  heading: {
    fontSize: typeTokens.size.md,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  amber: { color: color.warning },
  pendingCard: { borderWidth: 2, borderColor: color.warning, borderRadius: shape.radius },
  suspended: {
    backgroundColor: '#FEE2E2',
    padding: space.md,
    borderRadius: shape.radius,
    gap: space.xxs,
  },
  suspendedTitle: {
    fontSize: typeTokens.size.body,
    fontWeight: typeTokens.weight.semibold,
    color: color.danger,
  },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
  quick: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
});
