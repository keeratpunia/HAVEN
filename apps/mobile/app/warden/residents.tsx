import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, View } from 'react-native';
import { formatDateShort, type AdminResidentDTO } from '@haven/shared';
import * as api from '../../services/api-client.js';
import { staffApi } from '../../services/api-client.js';
import { useStaff } from '../../lib/staff-context.js';
import { Button } from '../../components/Button.js';
import { ConfirmSheet } from '../../components/ConfirmSheet.js';
import {
  Card,
  Chips,
  ErrorText,
  Field,
  Muted,
  StaffScreen,
  Strong,
  staffStyles,
} from '../../components/staff/StaffUi.js';

/**
 * W-08 Residents (SDD §13.4): "Search; status filters; resident detail with suspend /
 * mark left". Suspend cancels future visits (BR-10); mark left ends every session at
 * once and cancels future visits (FR-07, E-18).
 */
type Status = 'verified' | 'pending' | 'suspended' | 'rejected' | 'left';
type Sheet = { kind: 'suspend' | 'left'; resident: AdminResidentDTO };

export default function Residents() {
  const { hostel, can } = useStaff();
  const [status, setStatus] = useState<Status>('verified');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<AdminResidentDTO[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [until, setUntil] = useState('');
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const hostelId = hostel?.id ?? null;

  const load = useCallback(async () => {
    if (!hostelId) return;
    try {
      setItems((await staffApi.residents(hostelId, { status, q: q || undefined })).items);
    } catch {
      setMessage("Couldn't load residents.");
    }
  }, [hostelId, status, q]);
  useEffect(() => {
    void load();
    // search runs on demand
  }, [hostelId, status]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage(ok);
    } catch (err) {
      setMessage(err instanceof api.ApiError ? err.message : "Couldn't reach HAVEN.");
    } finally {
      setBusy(false);
      setSheet(null);
      await load();
    }
  }

  return (
    <StaffScreen title="Residents">
      <View style={staffStyles.row}>
        <Field label="Name, email or room" value={q} onChange={setQ} />
        <Button label="Search" fullWidth={false} onPress={() => void load()} />
      </View>
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
      <ErrorText>{message}</ErrorText>
      {items === null ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
      {items?.length === 0 ? <Muted>No residents.</Muted> : null}
      {items?.map((r) => (
        <Card
          key={r.userId}
          onPress={() => setOpen(open === r.userId ? null : r.userId)}
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
            </View>
          </View>
          {open === r.userId ? (
            <View>
              <Muted>
                {r.email} · {r.phone ?? 'no phone'}
              </Muted>
              {r.rejectionReason ? <Muted>Reason: {r.rejectionReason}</Muted> : null}
              <View style={staffStyles.row}>
                {r.status === 'verified' && can('warden', 'super_admin') ? (
                  <>
                    <Field
                      label="Suspend until (YYYY-MM-DD, empty = until lifted)"
                      value={until}
                      onChange={setUntil}
                    />
                    <Button
                      label="Suspend hosting"
                      variant="danger"
                      fullWidth={false}
                      onPress={() => setSheet({ kind: 'suspend', resident: r })}
                    />
                  </>
                ) : null}
                {r.status === 'suspended' && can('warden', 'super_admin') ? (
                  <Button
                    label="Lift suspension"
                    variant="secondary"
                    fullWidth={false}
                    loading={busy}
                    onPress={() =>
                      hostelId &&
                      act(
                        () => staffApi.unsuspendResident(hostelId, r.userId),
                        'Suspension lifted.',
                      )
                    }
                  />
                ) : null}
                {r.status !== 'left' && can('warden') ? (
                  <Button
                    label="Mark as left"
                    variant="danger"
                    fullWidth={false}
                    onPress={() => setSheet({ kind: 'left', resident: r })}
                  />
                ) : null}
              </View>
            </View>
          ) : null}
        </Card>
      ))}

      <ConfirmSheet
        visible={sheet?.kind === 'suspend'}
        title={`Suspend ${sheet?.resident.fullName}'s guest privileges?`}
        body="Their upcoming visits are cancelled and they're told."
        confirmLabel="Suspend hosting"
        reasonLabel="Reason (required)"
        reasonRequired
        loading={busy}
        onCancel={() => setSheet(null)}
        onConfirm={(reason) => {
          if (!sheet || !hostelId) return;
          const u = /^\d{4}-\d{2}-\d{2}$/.test(until)
            ? new Date(`${until}T23:59:00+05:30`).toISOString()
            : undefined;
          void act(
            () => staffApi.suspendResident(hostelId, sheet.resident.userId, reason, u),
            'Hosting suspended. Upcoming visits were cancelled.',
          );
        }}
      />
      <ConfirmSheet
        visible={sheet?.kind === 'left'}
        title={`Mark ${sheet?.resident.fullName} as left?`}
        body="They're signed out everywhere at once and their upcoming visits are cancelled."
        confirmLabel="Mark as left"
        loading={busy}
        onCancel={() => setSheet(null)}
        onConfirm={() =>
          sheet &&
          hostelId &&
          void act(
            () => staffApi.markLeft(hostelId, sheet.resident.userId),
            'Marked as left. All their sessions ended.',
          )
        }
      />
    </StaffScreen>
  );
}
