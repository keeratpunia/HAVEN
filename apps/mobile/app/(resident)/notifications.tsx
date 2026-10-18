import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDateTime, type NotificationDTO } from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../api/client.js';
import { EmptyState } from '../../components/EmptyState.js';
import { handleNotificationTap } from '../../lib/notification-routing.js';

/**
 * In-app notifications (`GET /me/notifications`, SDD §12.4). Tapping one behaves
 * exactly like tapping the push (SDD §13.7): open its screen, mark it opened.
 */
export default function Notifications() {
  const router = useRouter();
  const [items, setItems] = useState<NotificationDTO[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      api
        .getNotifications()
        .then((page) => {
          setItems(page.items);
          setCursor(page.nextCursor);
        })
        .catch(() => setItems([]));
    }, []),
  );

  async function more() {
    if (!cursor) return;
    const page = await api.getNotifications(cursor);
    setItems((prev) => [...(prev ?? []), ...page.items]);
    setCursor(page.nextCursor);
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        Notifications
      </Text>
      {items === null ? (
        <ActivityIndicator accessibilityLabel="Loading notifications" />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(n) => n.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<EmptyState message="Nothing yet." />}
          onEndReached={() => void more()}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.openedAt ? '' : 'Unread. '}${item.title ?? ''} ${item.body}`}
              style={[styles.card, !item.openedAt && styles.unread]}
              onPress={() =>
                void handleNotificationTap(
                  {
                    kind: item.kind,
                    notificationId: item.id,
                    ...(item.visitId ? { visitId: item.visitId } : {}),
                    screen: item.screen,
                  },
                  {
                    navigate: (path) => router.push(path as never),
                    markOpened: (id) => api.markNotificationOpened(id),
                  },
                )
              }
            >
              {item.title ? <Text style={styles.cardTitle}>{item.title}</Text> : null}
              <Text style={styles.body}>{item.body}</Text>
              <Text style={styles.time}>{formatDateTime(item.createdAt)}</Text>
            </Pressable>
          )}
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
  list: { gap: space.sm },
  card: {
    padding: space.md,
    borderRadius: shape.radius,
    backgroundColor: color.surface,
    gap: space.xxs,
  },
  unread: { borderLeftWidth: 4, borderLeftColor: color.primary },
  cardTitle: {
    fontSize: typeTokens.size.body,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  body: { fontSize: typeTokens.size.sm, color: color.text },
  time: { fontSize: typeTokens.size.xs, color: color.textMuted },
});
