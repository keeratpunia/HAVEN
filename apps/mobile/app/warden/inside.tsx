import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator } from 'react-native';
import type { AdminVisitDTO } from '@haven/shared';
import { staffApi } from '../../api/client.js';
import { useStaff } from '../../lib/staff-context.js';
import { useLiveUpdates } from '../../lib/live.js';
import { Button } from '../../components/Button.js';
import { AdminVisitCard } from '../../components/staff/AdminVisitCard.js';
import { Chips, ErrorText, Muted, StaffScreen } from '../../components/staff/StaffUi.js';

/** W-02 Inside now: photo, guest, host + room, zone, since, flags; filter chips. */
type Filter = 'all' | 'overstay' | 'disputed' | 'location_unverified';

export default function Inside() {
  const router = useRouter();
  const params = useLocalSearchParams<{ flag?: string }>();
  const { hostel, can } = useStaff();
  const [filter, setFilter] = useState<Filter>((params.flag as Filter) ?? 'all');
  const [items, setItems] = useState<AdminVisitDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hostelId = hostel?.id ?? null;

  const load = useCallback(async () => {
    if (!hostelId) return;
    try {
      const page = await staffApi.visits(hostelId, {
        status: 'inside',
        flag: filter === 'all' ? undefined : filter,
      });
      setItems(page.items);
      setError(null);
    } catch {
      setError("Couldn't load. Retrying.");
    }
  }, [hostelId, filter]);
  useEffect(() => {
    void load();
  }, [load]);
  const live = useLiveUpdates(hostelId, () => void load());

  return (
    <StaffScreen
      title={`Inside now${items ? ` (${items.length})` : ''}`}
      live={live}
      actions={
        can('warden') ? (
          <Button
            label="Emergency roll call"
            variant="secondary"
            fullWidth={false}
            onPress={() => router.push('/warden/emergency')}
          />
        ) : null
      }
    >
      <Chips
        label="Filter"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'overstay', label: 'Overstaying' },
          { value: 'disputed', label: 'Disputed' },
          { value: 'location_unverified', label: 'Location not verified' },
        ]}
      />
      <ErrorText>{error}</ErrorText>
      {items === null ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
      {items?.length === 0 ? <Muted>No guests inside.</Muted> : null}
      {items?.map((v) => (
        <AdminVisitCard
          key={v.id}
          visit={v}
          onPress={() => router.push(`/warden/visits/${v.id}`)}
        />
      ))}
    </StaffScreen>
  );
}
