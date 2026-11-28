import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import type { AdminVisitDTO } from '@haven/shared';
import { staffApi } from '../../../services/api-client.js';
import { useStaff } from '../../../lib/staff-context.js';
import { useLiveUpdates } from '../../../lib/live.js';
import { Button } from '../../../components/Button.js';
import { AdminVisitCard } from '../../../components/staff/AdminVisitCard.js';
import { FilterSheet } from '../../../components/staff/FilterSheet.js';
import {
  Chips,
  ErrorText,
  Field,
  Muted,
  StaffScreen,
  staffStyles,
} from '../../../components/staff/StaffUi.js';

/** FR-57 visit search: guest name, guest phone, host name, room, code; status; dates. */
const STATUSES = [
  { value: '', label: 'Any status' },
  { value: 'inside', label: 'Inside' },
  { value: 'approved', label: 'Approved' },
  { value: 'pending_warden', label: 'Waiting for warden' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'expired', label: 'Expired' },
];

export default function SearchVisits() {
  const router = useRouter();
  const params = useLocalSearchParams<{ flag?: string; expectedToday?: string }>();
  const { hostel } = useStaff();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [items, setItems] = useState<AdminVisitDTO[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hostelId = hostel?.id ?? null;

  const query = useCallback(
    (c?: string | null) =>
      staffApi.visits(hostelId ?? '', {
        q: q || undefined,
        status: status || undefined,
        from: /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : undefined,
        to: /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : undefined,
        flag: params.flag,
        expectedToday: params.expectedToday === 'true',
        cursor: c,
      }),
    [hostelId, q, status, from, to, params.flag, params.expectedToday],
  );

  const load = useCallback(async () => {
    if (!hostelId) return;
    try {
      const page = await query();
      setItems(page.items);
      setCursor(page.nextCursor);
      setError(null);
    } catch {
      setError("Couldn't search. Try again.");
    }
  }, [hostelId, query]);
  useEffect(() => {
    void load();
    // Search runs on demand after the first load; filters from a tile apply immediately.
  }, [hostelId, status, params.flag, params.expectedToday]);
  const live = useLiveUpdates(hostelId, () => void load());

  const title =
    params.expectedToday === 'true'
      ? 'Expected today'
      : params.flag === 'disputed'
        ? 'Disputed visits'
        : 'Search visits';
  return (
    <StaffScreen title={title} live={live}>
      <FilterSheet
        inline={
          <View style={staffStyles.row}>
            <Field label="Guest, phone, host, room or code" value={q} onChange={setQ} />
          </View>
        }
        activeCount={[status, from, to].filter(Boolean).length}
        applyLabel="Search"
        onApply={() => void load()}
      >
        <View style={staffStyles.row}>
          <Field label="From (YYYY-MM-DD)" value={from} onChange={setFrom} />
          <Field label="To (YYYY-MM-DD)" value={to} onChange={setTo} />
        </View>
        <Chips label="Status" value={status} onChange={setStatus} options={STATUSES} />
      </FilterSheet>
      <ErrorText>{error}</ErrorText>
      {items === null ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
      {items?.length === 0 ? <Muted>No visits match.</Muted> : null}
      {items?.map((v) => (
        <AdminVisitCard
          key={v.id}
          visit={v}
          onPress={() => router.push(`/warden/visits/${v.id}`)}
        />
      ))}
      {cursor ? (
        <Button
          label="Load more"
          variant="secondary"
          onPress={async () => {
            const page = await query(cursor);
            setItems((prev) => [...(prev ?? []), ...page.items]);
            setCursor(page.nextCursor);
          }}
        />
      ) : null}
    </StaffScreen>
  );
}
