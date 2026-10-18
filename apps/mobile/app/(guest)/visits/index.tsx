import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';
import * as api from '../../../api/client.js';
import { EmptyState } from '../../../components/EmptyState.js';
import { StatusChip } from '../../../components/StatusChip.js';
import { formatDateIst, formatTimeIst } from '../../../lib/formatTime.js';
import { DeleteAccount } from '../../../components/DeleteAccount.js';
import { useAuth } from '../../../lib/auth-context.js';

/**
 * G-17 "My visits": Today, upcoming, history cards with status chips (SDD §13.4). Its
 * menu holds "Delete my account" (§16.6, FR-09) below the list.
 */
export default function MyVisits() {
  const router = useRouter();
  const { signOut } = useAuth();
  const menu = (
    <View style={styles.menu}>
      <DeleteAccount
        kind="guest"
        onSignedOut={async () => {
          await signOut();
          router.replace('/');
        }}
      />
    </View>
  );
  const [visits, setVisits] = useState<api.VisitDto[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    api
      .getMyVisits()
      .then(setVisits)
      .catch(() => setError(true));
  }, []);

  useEffect(load, [load]);
  useFocusEffect(load);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.body}>
          Couldn't load your visits. Pull to refresh or try again later.
        </Text>
        {menu}
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
        <EmptyState message="No visits yet. Open an invite link from your host to get started." />
        {menu}
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={visits}
      keyExtractor={(v) => v.id}
      ListFooterComponent={menu}
      renderItem={({ item }) => (
        <Pressable
          onPress={() => router.push(`/visits/${item.id}`)}
          accessibilityRole="link"
          accessibilityLabel={`Visit to ${item.hostFirstName ?? 'host'}, ${item.status}`}
          style={styles.card}
        >
          <View style={styles.cardRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{item.hostFirstName ?? item.hostelName}</Text>
              <Text style={styles.cardSub}>
                {formatDateIst(item.windowStart)} · {formatTimeIst(item.windowStart)}
              </Text>
            </View>
            <StatusChip status={item.status} />
          </View>
        </Pressable>
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
  menu: { marginTop: space.lg, width: '100%' },
});
