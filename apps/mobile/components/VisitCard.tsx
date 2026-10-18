import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDateShort, formatTime12h, VISIT_TYPE_LABELS, type VisitDTO } from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import { StatusChip } from './StatusChip.js';

/**
 * SDD §13.5 `VisitCard`; §14 list layout: "cards with photo (40 px), two lines of
 * text, status chip on the right".
 */
export function VisitCard({ visit, onPress }: { visit: VisitDTO; onPress: () => void }) {
  const photo = visit.latestPhoto ?? visit.guest.profilePhoto;
  const when =
    visit.status === 'inside' && visit.firstEntryAt
      ? `Inside since ${formatTime12h(visit.firstEntryAt)} · ends ${formatTime12h(visit.windowEnd)}`
      : `${formatDateShort(visit.windowStart)} · ${formatTime12h(visit.windowStart)}–${formatTime12h(visit.windowEnd)}`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${visit.guest.name}, ${VISIT_TYPE_LABELS[visit.type]}, ${when}`}
      style={styles.card}
    >
      {photo ? (
        <Image
          source={{ uri: photo.url }}
          style={styles.photo}
          accessibilityLabel={`Photo of ${visit.guest.name}`}
        />
      ) : (
        <View style={[styles.photo, styles.placeholder]} accessibilityElementsHidden>
          <Text style={styles.initial}>{visit.guest.name.charAt(0).toUpperCase()}</Text>
        </View>
      )}
      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={1}>
          {visit.guest.name}
        </Text>
        <Text style={styles.sub} numberOfLines={2}>
          {VISIT_TYPE_LABELS[visit.type]} · {when}
        </Text>
      </View>
      <StatusChip status={visit.status} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.surface,
    borderRadius: shape.radius,
    padding: space.md,
    minHeight: 48,
  },
  photo: { width: 40, height: 40, borderRadius: 20 },
  placeholder: { backgroundColor: color.border, alignItems: 'center', justifyContent: 'center' },
  initial: { fontWeight: typeTokens.weight.semibold, color: color.textMuted },
  text: { flex: 1 },
  name: {
    fontSize: typeTokens.size.body,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  sub: { fontSize: typeTokens.size.sm, color: color.textMuted },
});
