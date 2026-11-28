import { useCallback, useEffect, useState } from 'react';
import { Redirect, useRouter } from 'expo-router';
import { ActivityIndicator, Text, View } from 'react-native';
import { formatDateTime, formatTime12h, type DashboardDTO } from '@haven/shared';
import { staffApi } from '../../services/api-client.js';
import { useStaff } from '../../lib/staff-context.js';
import { useLiveUpdates } from '../../lib/live.js';
import {
  Card,
  ErrorText,
  Muted,
  RedBanner,
  StaffScreen,
  Strong,
  Tile,
  staffStyles,
} from '../../components/staff/StaffUi.js';

/** W-01 Dashboard (FR-50): tiles open filtered lists; gate status; latest 10 events. */
const KIND: Record<string, string> = {
  entry: '✓ Checked in',
  exit: '↩ Checked out',
  entry_denied: '✕ Entry refused',
};

export default function Dashboard() {
  const router = useRouter();
  const { hostel, can } = useStaff();
  const [data, setData] = useState<DashboardDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hostelId = hostel?.id ?? null;

  const load = useCallback(async () => {
    if (!hostelId) return;
    try {
      setData(await staffApi.dashboard(hostelId));
      setError(null);
    } catch {
      setError("Couldn't load the dashboard. Retrying.");
    }
  }, [hostelId]);

  useEffect(() => {
    void load();
  }, [load]);
  const live = useLiveUpdates(hostelId, () => void load());

  if (hostel && !can('warden')) return <Redirect href="/warden/residents" />;
  if (!data) {
    return (
      <StaffScreen title="Dashboard" live={live}>
        <ErrorText>{error}</ErrorText>
        <ActivityIndicator accessibilityLabel="Loading dashboard" />
      </StaffScreen>
    );
  }
  const c = data.counts;
  const unconfigured = data.gates.filter((g) => !g.configured);

  return (
    <StaffScreen title="Dashboard" live={live}>
      {unconfigured.length > 0 ? (
        <RedBanner>
          Set the gate location — {unconfigured.map((g) => g.name).join(', ')} can't check anyone in
          yet.
        </RedBanner>
      ) : null}
      <ErrorText>{error}</ErrorText>
      <View style={[staffStyles.row]}>
        <Tile label="Inside now" value={c.inside} onPress={() => router.push('/warden/inside')} />
        <Tile
          label="Expected today"
          value={c.expectedToday}
          onPress={() => router.push('/warden/visits?expectedToday=true')}
        />
        <Tile
          label="Overstaying"
          value={c.overstaying}
          tone={c.overstaying ? 'warning' : undefined}
          onPress={() => router.push('/warden/inside?flag=overstay')}
        />
        <Tile
          label="Pending approvals"
          value={c.pendingApprovals}
          tone={c.pendingApprovals ? 'warning' : undefined}
          onPress={() => router.push('/warden/approvals')}
        />
        <Tile
          label="Pending residents"
          value={c.pendingResidents}
          tone={c.pendingResidents ? 'warning' : undefined}
          onPress={() => router.push('/warden/approvals?tab=residents')}
        />
      </View>

      <Strong>Gates</Strong>
      {data.gates.map((g) => (
        <Card
          key={g.id}
          onPress={() => router.push('/warden/gates')}
          label={`${g.name}, ${g.online ? 'online' : 'offline'}`}
        >
          <Text style={staffStyles.big}>
            {g.online ? '● ' : '○ '}
            {g.name} — {g.online ? 'Online' : 'Offline'}
          </Text>
          <Muted>
            {g.lastSeenAt
              ? `Last seen ${formatDateTime(g.lastSeenAt)}`
              : 'No gate screen paired yet.'}
          </Muted>
        </Card>
      ))}

      <Strong>Latest events</Strong>
      {data.latestEvents.length === 0 ? <Muted>No gate activity yet.</Muted> : null}
      {data.latestEvents.map((e) => (
        <Card
          key={`${e.visitId}-${e.at}-${e.kind}`}
          onPress={() => router.push(`/warden/visits/${e.visitId}`)}
          label={`${KIND[e.kind]} ${e.guestName} at ${formatTime12h(e.at)}`}
        >
          <Text style={staffStyles.big}>
            {KIND[e.kind] ?? e.kind} · {e.guestName}
          </Text>
          <Muted>
            {formatTime12h(e.at)} · {e.visitCode}
            {e.locationVerified ? '' : ' · ⚠ location not verified'}
          </Muted>
        </Card>
      ))}
    </StaffScreen>
  );
}
