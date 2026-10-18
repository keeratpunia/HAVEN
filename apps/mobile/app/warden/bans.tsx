import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { formatDateShort, type AdminVisitDTO, type BanDTO } from '@haven/shared';
import * as api from '../../api/client.js';
import { staffApi } from '../../api/client.js';
import { useStaff } from '../../lib/staff-context.js';
import { Button } from '../../components/Button.js';
import { ConfirmSheet } from '../../components/ConfirmSheet.js';
import {
  Card,
  ErrorText,
  Field,
  Muted,
  StaffScreen,
  Strong,
  staffStyles,
} from '../../components/staff/StaffUi.js';

/**
 * W-07 Bans (FR-54): "Active bans list; add ban from visit or guest search — Add ban".
 * Adding opens a guest search (by name, phone or visit code); the ban itself is placed
 * from that guest's visit (W-05), where the warden has the photos in front of them.
 */
export default function Bans() {
  const router = useRouter();
  const { hostel } = useStaff();
  const [items, setItems] = useState<BanDTO[] | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<AdminVisitDTO[] | null>(null);
  const [lifting, setLifting] = useState<BanDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const hostelId = hostel?.id ?? null;

  const load = useCallback(async () => {
    if (!hostelId) return;
    setItems((await staffApi.bans(hostelId)).items);
  }, [hostelId]);
  useEffect(() => {
    void load().catch(() => setMessage("Couldn't load bans."));
  }, [load]);

  return (
    <StaffScreen title="Bans">
      <Card>
        <Strong>Add ban</Strong>
        <View style={staffStyles.row}>
          <Field label="Find the guest: name, phone or visit code" value={q} onChange={setQ} />
          <Button
            label="Find guest"
            fullWidth={false}
            disabled={q.trim().length < 2}
            onPress={async () =>
              hostelId &&
              setFound((await staffApi.visits(hostelId, { q })).items.filter((v) => v.guest.id))
            }
          />
        </View>
        {found?.length === 0 ? <Muted>No guest found.</Muted> : null}
        {found?.map((v) => (
          <Button
            key={v.id}
            variant="secondary"
            label={`${v.guest.name} · ${v.code} · ${formatDateShort(v.windowStart)}`}
            onPress={() => router.push(`/warden/visits/${v.id}`)}
          />
        ))}
      </Card>
      <ErrorText>{message}</ErrorText>
      {items === null ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
      {items?.length === 0 ? <Muted>No active bans.</Muted> : null}
      {items?.map((b) => (
        <Card key={b.id}>
          <Strong>{b.guestName}</Strong>
          <Muted>
            {b.allHostels ? 'All hostels' : 'This hostel'} · since {formatDateShort(b.startsAt)} ·{' '}
            {b.endsAt ? `until ${formatDateShort(b.endsAt)}` : 'permanent'}
          </Muted>
          <Muted>{b.reason}</Muted>
          <Button
            label="Lift ban"
            variant="secondary"
            fullWidth={false}
            accessibilityLabel={`Lift ban on ${b.guestName}`}
            onPress={() => setLifting(b)}
          />
        </Card>
      ))}
      <ConfirmSheet
        visible={lifting !== null}
        title={`Lift the ban on ${lifting?.guestName}?`}
        confirmLabel="Lift ban"
        reasonLabel="Reason (required)"
        reasonRequired
        loading={busy}
        onCancel={() => setLifting(null)}
        onConfirm={async (reason) => {
          if (!lifting || !hostelId) return;
          setBusy(true);
          try {
            await staffApi.liftBan(hostelId, lifting.id, reason);
            setMessage('Ban lifted.');
          } catch (err) {
            setMessage(err instanceof api.ApiError ? err.message : "Couldn't lift the ban.");
          } finally {
            setBusy(false);
            setLifting(null);
            await load();
          }
        }}
      />
    </StaffScreen>
  );
}
