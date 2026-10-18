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
type Filter = 'all' | 'sweep' | 'overstay' | 'disputed' | 'location_unverified';

export default function Inside() {
  const router = useRouter();
  // `ids` comes from the 10 pm night-sweep push (SDD §11.8: "the app opens W-02
  // filtered to them").
  const params = useLocalSearchParams<{ flag?: string; ids?: string }>();
  const sweepIds = params.ids ? new Set(params.ids.split(',')) : null;
  const { hostel, can } = useStaff();
  const [filter, setFilter] = useState<Filter>(
    sweepIds ? 'sweep' : ((params.flag as Filter | undefined) ?? 'all'),
  );
  const [items, setItems] = useState<AdminVisitDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hostelId = hostel?.id ?? null;

  const load = useCallback(async () => {
    if (!hostelId) return;
    try {
      const page = await staffApi.visits(hostelId, {
        status: 'inside',
        flag: filter === 'all' || filter === 'sweep' ? undefined : filter,
      });
      setItems(
        filter === 'sweep' && sweepIds ? page.items.filter((v) => sweepIds.has(v.id)) : page.items,
      );
      setError(null);
    } catch {
      setError("Couldn't load. Retrying.");
    }
    // sweepIds comes from the URL and only changes with it.
  }, [hostelId, filter, params.ids]);
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
          ...(sweepIds ? [{ value: 'sweep' as const, label: 'Night sweep' }] : []),
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
