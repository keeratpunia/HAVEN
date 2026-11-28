import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import {
  formatDateShort,
  formatDateTime,
  formatTime12h,
  VISIT_TYPE_LABELS,
  type AdminVisitDetailDTO,
  type VisitEventDTO,
} from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../../services/api-client.js';
import { staffApi } from '../../../services/api-client.js';
import { useStaff } from '../../../lib/staff-context.js';
import { useLiveUpdates } from '../../../lib/live.js';
import { useActionKeys } from '../../../lib/action-key.js';
import { Button } from '../../../components/Button.js';
import { ConfirmSheet } from '../../../components/ConfirmSheet.js';
import { PhotoCompare } from '../../../components/PhotoCompare.js';
import { StatusChip } from '../../../components/StatusChip.js';
import {
  Card,
  Chips,
  ErrorText,
  Field,
  Muted,
  RedBanner,
  StaffScreen,
  Strong,
} from '../../../components/staff/StaffUi.js';

/**
 * W-05 Visit detail (FR-52): "Everything in VisitDTO + timeline with photos and GPS
 * distance — Force check-out, Ban guest, Resolve dispute". §14: header card, flags as
 * banners, timeline (newest at bottom), actions at the bottom. Buttons only for the
 * server's `allowedActions`. Opening this screen is an audited read.
 */
const EVENT: Record<VisitEventDTO['kind'], string> = {
  created: 'Created',
  approved: 'Approved',
  rejected: 'Declined',
  entry: 'Checked in',
  exit: 'Checked out',
  entry_denied: 'Entry refused',
  host_confirmed: 'Host confirmed the guest',
  disputed: 'Host reported "Not my guest"',
  dispute_resolved: 'Dispute resolved',
  overstay: 'Overstay flagged',
  closed: 'Closed',
};

export default function WardenVisit() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { hostel } = useStaff();
  const { keyFor, done } = useActionKeys();
  const [visit, setVisit] = useState<AdminVisitDetailDTO | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<'force' | 'resolve' | 'reject' | null>(null);
  const [banOpen, setBanOpen] = useState(false);
  const [banReason, setBanReason] = useState('');
  const [banScope, setBanScope] = useState<'hostel' | 'all'>('hostel');
  const [banUntil, setBanUntil] = useState('');
  const hostelId = hostel?.id ?? null;

  const load = useCallback(async () => {
    if (!hostelId || !id) return;
    try {
      setVisit(await staffApi.visit(hostelId, id));
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 404) setNotFound(true);
    }
  }, [hostelId, id]);
  useEffect(() => {
    void load();
  }, [load]);
  const live = useLiveUpdates(hostelId, (e) => {
    if (!e || e.id === id) void load();
  });

  async function act(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      after?.();
      await load();
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 409) {
        setMessage('This was updated by someone else.');
        await load();
      } else
        setMessage(err instanceof api.ApiError ? err.message : "Couldn't reach HAVEN. Try again.");
    } finally {
      setBusy(false);
      setSheet(null);
    }
  }

  if (notFound)
    return <StaffScreen title="Visit">{<Muted>This visit isn't available.</Muted>}</StaffScreen>;
  if (!visit || !hostelId) {
    return (
      <StaffScreen title="Visit">
        <ActivityIndicator accessibilityLabel="Loading visit" />
      </StaffScreen>
    );
  }
  const can = (a: string) => visit.allowedActions.includes(a as never);
  const visitId = visit.id;

  return (
    <StaffScreen title={`Visit ${visit.code}`} live={live}>
      <Card>
        <View style={styles.header}>
          <View style={styles.grow}>
            <Text style={styles.name}>{visit.guest.name}</Text>
            <Muted>
              {visit.guest.gender ? `${visit.guest.gender} · ` : ''}
              {visit.guestPhone ?? 'No phone'}
            </Muted>
            <Muted>
              Host {visit.host.displayName} · room {visit.host.room}
            </Muted>
            <Muted>
              {VISIT_TYPE_LABELS[visit.type]} ·{' '}
              {visit.zone === 'visitors_room' ? "Visitors' Room only" : visit.zone} ·{' '}
              {formatDateShort(visit.windowStart)} {formatTime12h(visit.windowStart)}–
              {formatTime12h(visit.windowEnd)}
            </Muted>
            {visit.charge ? (
              <Muted>
                Charge ₹{visit.charge.amountInr} · {visit.charge.status}
              </Muted>
            ) : null}
            {visit.closeReason ? <Muted>Closed: {visit.closeReason}</Muted> : null}
          </View>
          <StatusChip status={visit.status} />
        </View>
      </Card>

      {visit.flags.disputed ? <RedBanner>✕ Host says this is not their guest.</RedBanner> : null}
      {visit.flags.overstay ? <Banner tone="warning">⏱ Past the end time.</Banner> : null}
      {visit.flags.locationUnverified ? (
        <Banner tone="warning">⚠ Entered without a verified location (host confirmed).</Banner>
      ) : null}
      {visit.flags.exitLocationUnverified ? (
        <Banner tone="warning">⚠ Left without a verified location.</Banner>
      ) : null}

      <PhotoCompare
        live={visit.latestPhoto}
        profile={visit.guest.profilePhoto}
        guestName={visit.guest.name}
      />

      <Strong>Timeline</Strong>
      {visit.events.map((e, i) => (
        <View key={`${e.kind}-${i}`} style={styles.event}>
          <Text style={styles.time}>{formatDateTime(e.at)}</Text>
          <View style={styles.grow}>
            <Text style={styles.eventText}>
              {EVENT[e.kind]}
              {e.kind === 'entry' || e.kind === 'exit'
                ? `${e.locationVerified ? ' · location verified' : ' · location not verified'}${e.distanceM != null ? ` · ${Math.round(e.distanceM)} m from the gate` : ''}`
                : ''}
              {e.reason ? ` · ${e.reason}` : ''}
            </Text>
            {e.photo ? (
              <Image
                source={{ uri: e.photo.url }}
                style={styles.photo}
                accessibilityLabel={`Gate photo: ${EVENT[e.kind]}`}
              />
            ) : null}
          </View>
        </View>
      ))}

      <Strong>Notifications</Strong>
      {visit.notifications.length === 0 ? <Muted>None.</Muted> : null}
      {visit.notifications.map((n, i) => (
        <Muted key={`${n.kind}-${i}`}>
          {formatDateTime(n.createdAt)} · {n.kind} · {n.channel} to {n.recipientType} · {n.status}
          {n.openedAt ? ' · opened' : ''}
        </Muted>
      ))}

      <ErrorText>{message}</ErrorText>
      <View style={styles.actions}>
        {can('approve') ? (
          <Button
            label="Approve"
            fullWidth={false}
            loading={busy}
            onPress={() =>
              act(
                () => api.approveVisit(visitId, keyFor('approve')),
                () => done('approve'),
              )
            }
          />
        ) : null}
        {can('reject') ? (
          <Button
            label="Reject"
            variant="secondary"
            fullWidth={false}
            onPress={() => setSheet('reject')}
          />
        ) : null}
        {can('force_checkout') ? (
          <Button
            label="Force check-out"
            variant="danger"
            fullWidth={false}
            onPress={() => setSheet('force')}
          />
        ) : null}
        {can('resolve_dispute') ? (
          <Button
            label="Resolve dispute"
            variant="secondary"
            fullWidth={false}
            onPress={() => setSheet('resolve')}
          />
        ) : null}
        {can('ban') ? (
          <Button
            label="Ban guest"
            variant="danger"
            fullWidth={false}
            onPress={() => setBanOpen((o) => !o)}
          />
        ) : null}
      </View>

      {banOpen && visit.guest.id ? (
        <Card>
          <Strong>Ban {visit.guest.name}</Strong>
          <Field label="Reason" value={banReason} onChange={setBanReason} />
          <Chips
            label="Where"
            value={banScope}
            onChange={setBanScope}
            options={[
              { value: 'hostel', label: `This hostel (${hostel?.code ?? ''})` },
              { value: 'all', label: 'All hostels' },
            ]}
          />
          <Field
            label="Until (YYYY-MM-DD, empty = permanent)"
            value={banUntil}
            onChange={setBanUntil}
          />
          <Button
            label="Confirm ban"
            variant="danger"
            disabled={
              !banReason.trim() || (banUntil !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(banUntil))
            }
            loading={busy}
            onPress={() =>
              act(
                () =>
                  staffApi.ban(hostelId, {
                    visitorId: visit.guest.id as string,
                    allHostels: banScope === 'all',
                    reason: banReason.trim(),
                    ...(banUntil
                      ? { endsAt: new Date(`${banUntil}T00:00:00+05:30`).toISOString() }
                      : {}),
                  }),
                () => {
                  setBanOpen(false);
                  setMessage('Guest banned.');
                },
              )
            }
          />
        </Card>
      ) : null}

      <Button label="Back" variant="ghost" onPress={() => router.back()} />

      <ConfirmSheet
        visible={sheet === 'force'}
        title={`Force check-out ${visit.guest.name}?`}
        body="The visit closes now as a forced exit."
        confirmLabel="Force check-out"
        reasonLabel="Reason (required)"
        reasonRequired
        loading={busy}
        onCancel={() => setSheet(null)}
        onConfirm={(reason) =>
          act(
            () => staffApi.forceCheckout(hostelId, visitId, keyFor('force'), reason),
            () => done('force'),
          )
        }
      />
      <ConfirmSheet
        visible={sheet === 'resolve'}
        title="Mark this dispute resolved?"
        body="For example after talking to the host."
        confirmLabel="Resolve dispute"
        reasonLabel="Note (optional)"
        loading={busy}
        onCancel={() => setSheet(null)}
        onConfirm={(note) =>
          act(() => staffApi.resolveDispute(hostelId, visitId, note || undefined))
        }
      />
      <ConfirmSheet
        visible={sheet === 'reject'}
        title="Decline this request?"
        body="The host is told the reason."
        confirmLabel="Decline request"
        reasonLabel="Reason (required)"
        reasonRequired
        loading={busy}
        onCancel={() => setSheet(null)}
        onConfirm={(reason) =>
          act(
            () => api.rejectVisit(visitId, keyFor('reject'), reason),
            () => done('reject'),
          )
        }
      />
    </StaffScreen>
  );
}

function Banner({ tone, children }: { tone: 'warning'; children: string }) {
  return (
    <View style={[styles.banner, tone === 'warning' && styles.warn]} accessibilityRole="alert">
      <Text style={styles.bannerText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  grow: { flex: 1, gap: space.xxs },
  name: { fontSize: typeTokens.size.md, fontWeight: typeTokens.weight.semibold, color: color.text },
  event: { flexDirection: 'row', gap: space.sm },
  time: { width: 120, fontSize: typeTokens.size.sm, color: color.textMuted },
  eventText: { fontSize: typeTokens.size.sm, color: color.text },
  photo: { width: 96, height: 96, borderRadius: shape.radius, marginTop: space.xxs },
  actions: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  banner: { borderRadius: shape.radius, padding: space.sm },
  warn: { backgroundColor: '#FEF3C7' },
  bannerText: { color: color.warning, fontWeight: typeTokens.weight.semibold },
});
