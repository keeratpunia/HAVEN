import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { ActivityIndicator, Image, View } from 'react-native';
import { formatDateShort, type AdminResidentDTO, type ResidentSort } from '@haven/shared';
import { staffApi } from '../../../services/api-client.js';
import { useStaff } from '../../../lib/staff-context.js';
import { Button } from '../../../components/Button.js';
import { FilterSheet } from '../../../components/staff/FilterSheet.js';
import {
  Card,
  Chips,
  ErrorText,
  Field,
  Muted,
  StaffScreen,
  Strong,
  staffStyles,
} from '../../../components/staff/StaffUi.js';

/**
 * W-08 Residents (SDD §13.4): "Search; status filters; resident detail with suspend /
 * mark left". Tapping a resident opens the detail (`[id].tsx`), which now also shows them
 * as a host; the list can be sorted by how many guests came in (DEC-031).
 */
type Status = 'verified' | 'pending' | 'suspended' | 'rejected' | 'left';

const SORTS: { value: ResidentSort; label: string }[] = [
  { value: 'oldest', label: 'Joined first' },
  { value: 'most_guests', label: 'Most guests' },
  { value: 'latest_guest', label: 'Latest guest' },
  { value: 'name', label: 'Name' },
  { value: 'room', label: 'Room' },
];

export default function Residents() {
  const router = useRouter();
  const { hostel } = useStaff();
  const [status, setStatus] = useState<Status>('verified');
  const [sort, setSort] = useState<ResidentSort>('oldest');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<AdminResidentDTO[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const hostelId = hostel?.id ?? null;

  const load = useCallback(async () => {
    if (!hostelId) return;
    try {
      const page = await staffApi.residents(hostelId, { status, sort, q: q || undefined });
      setItems(page.items);
      setCursor(page.nextCursor);
      setMessage(null);
    } catch {
      setMessage("Couldn't load residents.");
    }
  }, [hostelId, status, sort, q]);
  useEffect(() => {
    void load();
    // the text search runs on demand; status and sort apply at once
  }, [hostelId, status, sort]);

  return (
    <StaffScreen title="Residents">
      <FilterSheet
        inline={
          <View style={staffStyles.row}>
            <Field label="Name, email or room" value={q} onChange={setQ} />
          </View>
        }
        activeCount={(status !== 'verified' ? 1 : 0) + (sort !== 'oldest' ? 1 : 0)}
        applyLabel="Search"
        onApply={() => void load()}
      >
        <Chips
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'verified', label: 'Verified' },
            { value: 'pending', label: 'Waiting' },
            { value: 'suspended', label: 'Suspended' },
            { value: 'rejected', label: 'Rejected' },
            { value: 'left', label: 'Left' },
          ]}
        />
        <Muted>Sort by</Muted>
        <Chips label="Sort by" value={sort} onChange={setSort} options={SORTS} />
      </FilterSheet>
      <ErrorText>{message}</ErrorText>
      {items === null ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
      {items?.length === 0 ? <Muted>No residents.</Muted> : null}
      {items?.map((r) => (
        <Card
          key={r.userId}
          onPress={() => router.push(`/warden/residents/${r.userId}` as never)}
          label={`${r.fullName}, room ${r.room}, ${r.status}`}
        >
          <View style={staffStyles.row}>
            {r.selfie ? (
              <Image
                source={{ uri: r.selfie.url }}
                style={staffStyles.photo}
                accessibilityLabel={`Selfie of ${r.fullName}`}
              />
            ) : (
              <View style={staffStyles.photo} />
            )}
            <View style={staffStyles.grow}>
              <Strong>{r.fullName}</Strong>
              <Muted>
                Room {r.room} · {r.status}
                {r.hostingSuspendedUntil
                  ? ` until ${formatDateShort(r.hostingSuspendedUntil)}`
                  : ''}
              </Muted>
              <Muted>{guestLine(r)}</Muted>
            </View>
          </View>
        </Card>
      ))}
      {cursor && hostelId ? (
        <Button
          label="Load more"
          variant="secondary"
          onPress={async () => {
            const page = await staffApi.residents(hostelId, {
              status,
              sort,
              q: q || undefined,
              cursor,
            });
            setItems((prev) => [...(prev ?? []), ...page.items]);
            setCursor(page.nextCursor);
          }}
        />
      ) : null}
    </StaffScreen>
  );
}

function guestLine(r: AdminResidentDTO): string {
  const s = r.hostStats;
  if (s.visits === 0) return 'No guests yet';
  const came = `${s.guestsIn} guest${s.guestsIn === 1 ? '' : 's'} came in`;
  const latest = s.lastGuestAt ? ` · latest ${formatDateShort(s.lastGuestAt)}` : '';
  const disputes = s.disputes > 0 ? ` · ${s.disputes} "not my guest"` : '';
  return `${came}${latest}${disputes}`;
}
