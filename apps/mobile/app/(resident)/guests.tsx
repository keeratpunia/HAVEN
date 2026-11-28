import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import type { HostedVisitBucket, VisitDTO } from '@haven/shared';
import { color, space, type as typeTokens } from '@haven/ui';
import * as api from '../../services/api-client.js';
import { EmptyState } from '../../components/EmptyState.js';
import { Segments } from '../../components/Segments.js';
import { VisitCard } from '../../components/VisitCard.js';
import { screenForVisit } from '../../lib/visit-screen.js';

/** R-13 Guests (SDD §13.4): "Segments: Upcoming, Inside, History"; infinite scroll (§14). */
const SEGMENTS: { value: HostedVisitBucket; label: string }[] = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'inside', label: 'Inside' },
  { value: 'history', label: 'History' },
];
const EMPTY: Record<HostedVisitBucket, string> = {
  upcoming: 'No upcoming guests. Invite someone.',
  inside: 'No guests inside. Invite someone.',
  history: 'No past visits yet.',
};

export default function Guests() {
  const router = useRouter();
  const [bucket, setBucket] = useState<HostedVisitBucket>('upcoming');
  const [items, setItems] = useState<VisitDTO[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async (b: HostedVisitBucket) => {
    setItems(null);
    try {
      const page = await api.getHostedVisits({ bucket: b });
      setItems(page.items);
      setCursor(page.nextCursor);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load(bucket);
    }, [bucket, load]),
  );

  async function more() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.getHostedVisits({ bucket, cursor });
      setItems((prev) => [...(prev ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        Guests
      </Text>
      <Segments options={SEGMENTS} value={bucket} onChange={setBucket} />
      {error ? (
        <Text style={styles.error}>Couldn't load visits. Pull down or try again.</Text>
      ) : null}
      {items === null ? (
        <ActivityIndicator accessibilityLabel="Loading visits" />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(v) => v.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<EmptyState message={EMPTY[bucket]} />}
          onEndReached={() => void more()}
          onEndReachedThreshold={0.5}
          renderItem={({ item }) => (
            <VisitCard visit={item} onPress={() => router.push(screenForVisit(item) as never)} />
          )}
          ListFooterComponent={
            loadingMore ? <ActivityIndicator accessibilityLabel="Loading more" /> : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: space.md, gap: space.sm },
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  list: { gap: space.sm, paddingBottom: space.lg },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
});
