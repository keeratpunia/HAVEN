import { Image, Text, View } from 'react-native';
import {
  formatTime12h,
  formatDateShort,
  VISIT_TYPE_LABELS,
  type AdminVisitDTO,
} from '@haven/shared';
import { StatusChip } from '../StatusChip.js';
import { Card, Muted, staffStyles } from './StaffUi.js';

/** List row for W-02 / visit search: photo (40 px), two lines, status chip on the right (§14). */
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
        <View style={staffStyles.grow}>
          <Text style={staffStyles.big}>{visit.guest.name}</Text>
          <Muted>
            {visit.host.displayName} · room {visit.host.room} · {VISIT_TYPE_LABELS[visit.type]} ·{' '}
            {visit.zone === 'visitors_room' ? "Visitors' Room" : visit.zone} · {since}
          </Muted>
          {flags.length ? <Muted>{flags.join('  ')}</Muted> : null}
        </View>
        <StatusChip status={visit.status} />
      </View>
    </Card>
  );
}
