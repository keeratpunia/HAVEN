import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';
import { formatDateShort, type AdminResidentDTO, type AdminVisitDTO } from '@haven/shared';
import { color, space } from '@haven/ui';
import * as api from '../../../services/api-client.js';
import { staffApi } from '../../../services/api-client.js';
import { useStaff } from '../../../lib/staff-context.js';
import { Button } from '../../../components/Button.js';
import { ConfirmSheet } from '../../../components/ConfirmSheet.js';
import { AdminVisitCard } from '../../../components/staff/AdminVisitCard.js';
import {
  Card,
  Muted,
  StaffScreen,
  Strong,
  Tile,
  staffStyles,
} from '../../../components/staff/StaffUi.js';
import { DateTimeField } from '../../../components/DateTimeField.js';
import { StatusText, useStatus } from '../../../components/StatusText.js';

/**
 * W-08 resident detail (SDD §13.4: "resident detail with suspend / mark left"), with the
 * resident as a host (DEC-031): how many guests came in, how many different people,
 * overnight stays, "Not my guest" reports, the latest guest, and every visit they hosted,
 * newest first. Each visit opens W-05. Suspend cancels future visits (BR-10); mark left
 * ends every session at once and cancels future visits (FR-07, E-18).
 */
type Sheet = 'suspend' | 'left' | null;

export default function ResidentDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { hostel, can } = useStaff();
  const hostelId = hostel?.id ?? null;
  const [resident, setResident] = useState<AdminResidentDTO | null>(null);
  const [visits, setVisits] = useState<AdminVisitDTO[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [until, setUntil] = useState('');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [busy, setBusy] = useState(false);
  const notice = useStatus();

  const load = useCallback(async () => {
    if (!hostelId || !id) return;
    try {
      setResident(await staffApi.resident(hostelId, id));
      const page = await staffApi.visits(hostelId, { hostId: id });
      setVisits(page.items);
      setCursor(page.nextCursor);
    } catch (err) {
      notice.fail(err instanceof api.ApiError ? err.message : "Couldn't load this resident.");
    }
  }, [hostelId, id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    notice.clear();
    try {
      await fn();
      notice.ok(ok);
    } catch (err) {
      notice.fail(err instanceof api.ApiError ? err.message : "Couldn't reach HAVEN.");
    } finally {
      setBusy(false);
      setSheet(null);
      await load();
    }
  }

  if (!resident) {
    return (
      <StaffScreen title="Resident">
        <StatusText status={notice.message} />
        {notice.message ? null : <ActivityIndicator accessibilityLabel="Loading" />}
      </StaffScreen>
    );
  }

  const s = resident.hostStats;
  return (
    <StaffScreen title={resident.fullName}>
      <Card>
        <View style={staffStyles.row}>
          {resident.selfie ? (
            <Image
              source={{ uri: resident.selfie.url }}
              style={styles.selfie}
              accessibilityLabel={`Selfie of ${resident.fullName}`}
            />
          ) : (
            <View style={styles.selfie} />
          )}
          <View style={[staffStyles.grow, styles.text]}>
            <Strong>Room {resident.room}</Strong>
            <Muted>
              {resident.status}
              {resident.hostingSuspendedUntil
                ? ` until ${formatDateShort(resident.hostingSuspendedUntil)}`
                : ''}
            </Muted>
            <Muted>{resident.email}</Muted>
            <Muted>{resident.phone ?? 'no phone'}</Muted>
          </View>
        </View>
        {resident.rejectionReason ? <Muted>Reason: {resident.rejectionReason}</Muted> : null}
      </Card>

      <Strong>As a host</Strong>
      <View style={styles.tiles}>
        <Tile label="Guests came in" value={s.guestsIn} />
        <Tile label="Different guests" value={s.distinctGuests} />
        <Tile label="Visits hosted" value={s.visits} />
        <Tile label="Overnight stays" value={s.overnightStays} />
        <Tile label="Latest guest" value={s.lastGuestAt ? formatDateShort(s.lastGuestAt) : '—'} />
      </View>

      <StatusText status={notice.message} />
      {resident.status === 'verified' && can('warden', 'super_admin') ? (
        <View style={staffStyles.row}>
          <DateTimeField
            kind="date"
            label="Suspend until (optional)"
            value={until}
            onChange={setUntil}
          />
          <Button
            label="Suspend hosting"
            variant="danger"
            fullWidth={false}
            onPress={() => setSheet('suspend')}
          />
        </View>
      ) : null}
      {resident.status === 'suspended' && can('warden', 'super_admin') ? (
        <Button
          label="Lift suspension"
          variant="secondary"
          loading={busy}
          onPress={() =>
            hostelId &&
            act(() => staffApi.unsuspendResident(hostelId, resident.userId), 'Suspension lifted.')
          }
        />
      ) : null}
      {resident.status !== 'left' && can('warden') ? (
        <Button label="Mark as left" variant="danger" onPress={() => setSheet('left')} />
      ) : null}

      <Strong>Their guests</Strong>
      {visits === null ? <ActivityIndicator accessibilityLabel="Loading visits" /> : null}
      {visits?.length === 0 ? <Muted>No visits yet.</Muted> : null}
      {visits?.map((v) => (
        <AdminVisitCard
          key={v.id}
          visit={v}
          onPress={() => router.push(`/warden/visits/${v.id}`)}
        />
      ))}
      {cursor && hostelId ? (
        <Button
          label="Load more"
          variant="secondary"
          onPress={async () => {
            const page = await staffApi.visits(hostelId, { hostId: resident.userId, cursor });
            setVisits((prev) => [...(prev ?? []), ...page.items]);
            setCursor(page.nextCursor);
          }}
        />
      ) : null}

      <ConfirmSheet
        visible={sheet === 'suspend'}
        title={`Suspend ${resident.fullName}'s guest privileges?`}
        body="Their upcoming visits are cancelled and they're told."
        confirmLabel="Suspend hosting"
        reasonLabel="Reason (required)"
        reasonRequired
        loading={busy}
        onCancel={() => setSheet(null)}
        onConfirm={(reason) => {
          if (!hostelId) return;
          const u = /^\d{4}-\d{2}-\d{2}$/.test(until)
            ? new Date(`${until}T23:59:00+05:30`).toISOString()
            : undefined;
          void act(
            () => staffApi.suspendResident(hostelId, resident.userId, reason, u),
            'Hosting suspended. Upcoming visits were cancelled.',
          );
        }}
      />
      <ConfirmSheet
        visible={sheet === 'left'}
        title={`Mark ${resident.fullName} as left?`}
        body="They're signed out everywhere at once and their upcoming visits are cancelled."
        confirmLabel="Mark as left"
        loading={busy}
        onCancel={() => setSheet(null)}
        onConfirm={() =>
          hostelId &&
          void act(
            () => staffApi.markLeft(hostelId, resident.userId),
            'Marked as left. All their sessions ended.',
          )
        }
      />
    </StaffScreen>
  );
}

const styles = StyleSheet.create({
  selfie: { width: 72, height: 72, borderRadius: 36, backgroundColor: color.border },
  text: { minWidth: 0, gap: space.xxs },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
