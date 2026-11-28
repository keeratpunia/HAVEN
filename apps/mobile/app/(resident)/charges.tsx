import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { formatDateShort, type ChargeDTO } from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../services/api-client.js';
import { EmptyState } from '../../components/EmptyState.js';

/** R-14 Charges (SDD §13.4): "List with status chips and totals". Money is whole rupees (CLAUDE.md §2). */
const CHIP: Record<ChargeDTO['status'], { word: string; glyph: string; bg: string; fg: string }> = {
  pending: { word: 'Pending', glyph: '⏱', bg: '#FEF3C7', fg: color.warning },
  confirmed: { word: 'Due', glyph: '!', bg: '#FEF3C7', fg: color.warning },
  paid: { word: 'Paid', glyph: '✓', bg: '#DCFCE7', fg: color.success },
  waived: { word: 'Waived', glyph: '✕', bg: color.surface, fg: color.textMuted },
};

export default function Charges() {
  const [items, setItems] = useState<ChargeDTO[] | null>(null);
  const [error, setError] = useState(false);

  useFocusEffect(
    useCallback(() => {
      api
        .getCharges()
        .then((page) => {
          setItems(page.items);
          setError(false);
        })
        .catch(() => setError(true));
    }, []),
  );

  const owed = (items ?? [])
    .filter((c) => c.status === 'pending' || c.status === 'confirmed')
    .reduce((sum, c) => sum + c.amountInr, 0);
  const paid = (items ?? [])
    .filter((c) => c.status === 'paid')
    .reduce((sum, c) => sum + c.amountInr, 0);

  return (
    <View style={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        Charges
      </Text>
      {error ? <Text style={styles.error}>Couldn't load charges. Try again later.</Text> : null}
      {items === null ? (
        <ActivityIndicator accessibilityLabel="Loading charges" />
      ) : (
        <>
          <View style={styles.totals}>
            <Text style={styles.total}>To pay: ₹{owed}</Text>
            <Text style={styles.totalMuted}>Paid: ₹{paid}</Text>
          </View>
          <FlatList
            data={items}
            keyExtractor={(c) => c.id}
            contentContainerStyle={styles.list}
            ListEmptyComponent={<EmptyState message="No charges." />}
            renderItem={({ item }) => {
              const chip = CHIP[item.status];
              return (
                <View
                  style={styles.card}
                  accessibilityLabel={`${item.description} ₹${item.amountInr}, ${chip.word}`}
                >
                  <View style={styles.cardText}>
                    <Text style={styles.amount}>₹{item.amountInr}</Text>
                    <Text style={styles.sub}>
                      {item.description} · {formatDateShort(item.createdAt)}
                      {item.receiptNo ? ` · Receipt ${item.receiptNo}` : ''}
                    </Text>
                  </View>
                  <View style={[styles.chip, { backgroundColor: chip.bg }]}>
                    <Text style={[styles.chipText, { color: chip.fg }]}>
                      {chip.glyph} {chip.word}
                    </Text>
                  </View>
                </View>
              );
            }}
          />
        </>
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
  totals: { flexDirection: 'row', gap: space.md },
  total: {
    fontSize: typeTokens.size.body,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  totalMuted: { fontSize: typeTokens.size.body, color: color.textMuted },
  list: { gap: space.sm },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: shape.radius,
    backgroundColor: color.surface,
  },
  cardText: { flex: 1 },
  amount: {
    fontSize: typeTokens.size.body,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  sub: { fontSize: typeTokens.size.sm, color: color.textMuted },
  chip: { borderRadius: shape.chipRadius, paddingHorizontal: space.sm, paddingVertical: space.xxs },
  chipText: { fontSize: typeTokens.size.sm, fontWeight: typeTokens.weight.semibold },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
});
