import { Image, StyleSheet, Text, View } from 'react-native';
import { space } from '@haven/ui';
import {
  formatTime12h,
  formatDateShort,
  VISIT_TYPE_LABELS,
  type AdminVisitDTO,
} from '@haven/shared';
import { StatusChip } from '../StatusChip.js';
import { Card, Muted, staffStyles } from './StaffUi.js';

/**
 * List row for W-02 / visit search: photo (40 px), two lines, status chip (§14). The chip
 * sits beside the name and wraps under it on a narrow phone, so the name and details
 * always get the card's full width (DEC-026 mobile-first pass).
 */
export function AdminVisitCard({ visit, onPress }: { visit: AdminVisitDTO; onPress: () => void }) {
  const photo = visit.latestPhoto ?? visit.guest.profilePhoto;
  const flags = [
    visit.flags.overstay ? '⏱ Overstay' : null,
    visit.flags.disputed ? '✕ Disputed' : null,
    visit.flags.locationUnverified ? '⚠ Location not verified' : null,
  ].filter(Boolean);
  const since =
    visit.status === 'inside' && visit.firstEntryAt
      ? `since ${formatTime12h(visit.firstEntryAt)}`
      : `${formatDateShort(visit.windowStart)} ${formatTime12h(visit.windowStart)}`;
  return (
    <Card
      onPress={onPress}
      label={`${visit.guest.name}, guest of ${visit.host.displayName}, room ${visit.host.room}, ${visit.status}`}
    >
      <View style={staffStyles.row}>
        {photo ? (
          <Image
            source={{ uri: photo.url }}
            style={staffStyles.photo}
            accessibilityLabel={`Photo of ${visit.guest.name}`}
          />
        ) : (
          <View style={staffStyles.photo} />
        )}
        <View style={[staffStyles.grow, styles.text]}>
          <View style={styles.nameRow}>
            <Text style={[staffStyles.big, styles.name]}>{visit.guest.name}</Text>
            <StatusChip status={visit.status} />
          </View>
          <Muted>
            {visit.host.displayName} · room {visit.host.room} · {VISIT_TYPE_LABELS[visit.type]} ·{' '}
            {visit.zone === 'visitors_room' ? "Visitors' Room" : visit.zone} · {since}
          </Muted>
          {flags.length ? <Muted>{flags.join('  ')}</Muted> : null}
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  text: { minWidth: 0, gap: space.xxs },
  nameRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space.xs,
    rowGap: space.xxs,
  },
  name: { flexShrink: 1 },
});
