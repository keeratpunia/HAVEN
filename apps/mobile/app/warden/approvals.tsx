import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';
import {
  formatDateShort,
  formatMonth,
  VISIT_TYPE_LABELS,
  type AdminResidentDTO,
  type ApprovalDTO,
} from '@haven/shared';
import { color, shape, space } from '@haven/ui';
import * as api from '../../services/api-client.js';
import { staffApi } from '../../services/api-client.js';
import { useStaff } from '../../lib/staff-context.js';
import { useLiveUpdates } from '../../lib/live.js';
import { newActionKey } from '../../lib/action-key.js';
import { Button } from '../../components/Button.js';
import { ConfirmSheet } from '../../components/ConfirmSheet.js';
import { Card, Chips, Muted, StaffScreen, Strong } from '../../components/staff/StaffUi.js';
import { StatusText, useStatus } from '../../components/StatusText.js';

/**
 * W-04 Approvals (SDD §13.4): "Tabs: Overnight requests, Residents; each card has all
 * details and photos — Approve / Reject". F6 step 4 (host, guest, dates, quota, charge,
 * host's history) and F7 step 6 (name, Google email, phone, room, ID card photo,
 * selfie, other verified residents of that room).
 */
type Tab = 'overnight' | 'residents';

export default function Approvals() {
  const params = useLocalSearchParams<{ tab?: string }>();
  const router = useRouter();
  const { hostel, can } = useStaff();
  const canOvernight = can('warden');
  const [tab, setTab] = useState<Tab>(
    params.tab === 'residents' || !canOvernight ? 'residents' : 'overnight',
  );
  const [overnight, setOvernight] = useState<ApprovalDTO[] | null>(null);
  const [residents, setResidents] = useState<AdminResidentDTO[] | null>(null);
  const notice = useStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ kind: Tab; id: string; name: string } | null>(null);
  const hostelId = hostel?.id ?? null;

  const load = useCallback(async () => {
    if (!hostelId) return;
    try {
      if (canOvernight) setOvernight((await staffApi.approvals(hostelId)).items);
      setResidents((await staffApi.residents(hostelId, { status: 'pending' })).items);
    } catch {
      notice.fail("Couldn't load approvals. Retrying.");
    }
  }, [hostelId, canOvernight]);
  useEffect(() => {
    void load();
  }, [load]);
  const live = useLiveUpdates(hostelId, () => void load());

  async function act(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(id);
    notice.clear();
    try {
      await fn();
      notice.ok(ok);
    } catch (err) {
      notice.fail(
        err instanceof api.ApiError
          ? err.status === 409
            ? 'This was updated by someone else.'
            : err.message
          : "Couldn't reach HAVEN.",
      );
    } finally {
      setBusy(null);
      setRejecting(null);
      await load();
    }
  }

  return (
    <StaffScreen title="Approvals" live={live}>
      <Chips
        label="Approvals"
        value={tab}
        onChange={setTab}
        options={[
          ...(canOvernight
            ? [
                {
                  value: 'overnight' as Tab,
                  label: `Overnight requests${overnight ? ` (${overnight.length})` : ''}`,
                },
              ]
            : []),
          { value: 'residents', label: `Residents${residents ? ` (${residents.length})` : ''}` },
        ]}
      />
      <StatusText status={notice.message} />

      {tab === 'overnight' ? (
        overnight === null ? (
          <ActivityIndicator accessibilityLabel="Loading" />
        ) : overnight.length === 0 ? (
          <Muted>No requests waiting.</Muted>
        ) : (
          overnight.map((a) => (
            <Card key={a.visit.id}>
              <Strong>
                {a.visit.guest.name} · {VISIT_TYPE_LABELS[a.visit.type]}
              </Strong>
              <Muted>
                Host {a.visit.host.displayName}, room {a.visit.host.room} · guest{' '}
                {a.visit.guest.gender ?? '—'} · {a.visit.guestPhone ?? ''}
              </Muted>
              <Muted>
                {formatDateShort(`${a.arrivalDate}T12:00:00+05:30`)} →{' '}
                {formatDateShort(`${a.departureDate}T12:00:00+05:30`)} · {a.visit.nights} night(s) ·
                ₹{a.chargeInr}
              </Muted>
              {a.quota.map((q) => (
                <Muted key={q.month}>
                  {formatMonth(q.month)}: {q.used} of {q.limit} nights already used
                </Muted>
              ))}
              <Muted>
                Host history: {a.hostHistory.visits} visits, {a.hostHistory.overnightStays}{' '}
                overnight stays, {a.hostHistory.disputes} disputes
              </Muted>
              <View style={styles.pair}>
                <View style={styles.half}>
                  <Button
                    label="Reject"
                    variant="secondary"
                    accessibilityLabel={`Reject request for ${a.visit.guest.name}`}
                    onPress={() =>
                      setRejecting({ kind: 'overnight', id: a.visit.id, name: a.visit.guest.name })
                    }
                  />
                </View>
                <View style={styles.half}>
                  <Button
                    label="Approve"
                    accessibilityLabel={`Approve request for ${a.visit.guest.name}`}
                    loading={busy === a.visit.id}
                    onPress={() =>
                      act(
                        a.visit.id,
                        () => api.approveVisit(a.visit.id, newActionKey()),
                        `Approved ${a.visit.guest.name}'s stay. The charge is pending.`,
                      )
                    }
                  />
                </View>
              </View>
              <Button
                label="Open visit"
                variant="ghost"
                onPress={() => router.push(`/warden/visits/${a.visit.id}`)}
              />
            </Card>
          ))
        )
      ) : residents === null ? (
        <ActivityIndicator accessibilityLabel="Loading" />
      ) : residents.length === 0 ? (
        <Muted>No residents waiting.</Muted>
      ) : (
        residents.map((r) => (
          <Card key={r.userId}>
            <View style={styles.photos}>
              {r.idCardPhoto ? (
                <Image
                  source={{ uri: r.idCardPhoto.url }}
                  style={styles.card}
                  accessibilityLabel={`ID card of ${r.fullName}`}
                />
              ) : (
                <Muted>No ID card</Muted>
              )}
              {r.selfie ? (
                <Image
                  source={{ uri: r.selfie.url }}
                  style={styles.selfie}
                  accessibilityLabel={`Selfie of ${r.fullName}`}
                />
              ) : null}
            </View>
            <Strong>{r.fullName}</Strong>
            <Muted>
              Room {r.room} · {r.email} · {r.phone ?? 'no phone'}
            </Muted>
            <Muted>{r.submittedAt ? `Submitted ${formatDateShort(r.submittedAt)}` : ''}</Muted>
            <Muted>
              {r.roommates.length
                ? `Already verified in this room: ${r.roommates.map((m) => m.fullName).join(', ')}`
                : 'Nobody verified in this room yet.'}
            </Muted>
            <View style={styles.pair}>
              <View style={styles.half}>
                <Button
                  label="Reject"
                  variant="secondary"
                  accessibilityLabel={`Reject ${r.fullName}`}
                  onPress={() =>
                    setRejecting({ kind: 'residents', id: r.userId, name: r.fullName })
                  }
                />
              </View>
              <View style={styles.half}>
                <Button
                  label="Verify"
                  accessibilityLabel={`Verify ${r.fullName}`}
                  loading={busy === r.userId}
                  onPress={() =>
                    hostelId &&
                    act(
                      r.userId,
                      () => staffApi.verifyResident(hostelId, r.userId),
                      `${r.fullName} is verified. The ID card photo was deleted.`,
                    )
                  }
                />
              </View>
            </View>
          </Card>
        ))
      )}

      <ConfirmSheet
        visible={rejecting !== null}
        title={
          rejecting?.kind === 'residents'
            ? `Reject ${rejecting?.name}?`
            : `Decline ${rejecting?.name}'s stay?`
        }
        body={
          rejecting?.kind === 'residents'
            ? 'They see the reason and can resubmit once.'
            : 'The host is told the reason.'
        }
        confirmLabel={rejecting?.kind === 'residents' ? 'Reject resident' : 'Decline request'}
        reasonLabel="Reason (required)"
        reasonRequired
        loading={busy !== null}
        onCancel={() => setRejecting(null)}
        onConfirm={(reason) => {
          if (!rejecting || !hostelId) return;
          const r = rejecting;
          void act(
            r.id,
            () =>
              r.kind === 'residents'
                ? staffApi.rejectResident(hostelId, r.id, reason)
                : api.rejectVisit(r.id, newActionKey(), reason),
            r.kind === 'residents' ? `${r.name} was told why.` : 'Declined. The host was told why.',
          );
        }}
      />
    </StaffScreen>
  );
}

const styles = StyleSheet.create({
  pair: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  half: { flex: 1 },
  photos: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  card: { width: 220, height: 140, borderRadius: shape.radius, backgroundColor: color.border },
  selfie: { width: 140, height: 140, borderRadius: shape.radius, backgroundColor: color.border },
});
