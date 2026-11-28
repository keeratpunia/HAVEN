import { useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  formatDateShort,
  formatDateTime,
  formatHhMm,
  formatTime12h,
  inviteShareText,
  localDateTimeToUtc,
  overnightInviteShareText,
  toLocalDateString,
  VISIT_TYPE_LABELS,
  type VisitAction,
  type VisitEventDTO,
} from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../../services/api-client.js';
import { Button } from '../../../components/Button.js';
import { ConfirmSheet } from '../../../components/ConfirmSheet.js';
import { DateTimeField } from '../../../components/DateTimeField.js';
import { EmptyState } from '../../../components/EmptyState.js';
import { FlagBanners } from '../../../components/FlagBanners.js';
import { SharePanel } from '../../../components/SharePanel.js';
import { StatusChip } from '../../../components/StatusChip.js';
import { useActionKeys } from '../../../lib/action-key.js';
import { useAuth } from '../../../lib/auth-context.js';
import { ruleMessage, RULES } from '../../../lib/rule-hints.js';
import { useHostedVisit } from '../../../lib/useHostedVisit.js';

/**
 * R-10 Visit detail (SDD §13.4): "Timeline, photos, flags — Context actions (Cancel,
 * Edit, My guest has left)". §14 layout: header card, flags as banners, timeline
 * (newest at bottom), actions in a bottom bar. Buttons come only from the API's
 * `allowedActions` (§12.3).
 */
const EVENT_TEXT: Record<VisitEventDTO['kind'], string> = {
  created: 'Created',
  approved: 'Approved',
  rejected: 'Declined',
  entry: 'Checked in',
  exit: 'Checked out',
  entry_denied: 'Entry refused',
  host_confirmed: 'You confirmed your guest',
  disputed: 'You reported this guest',
  dispute_resolved: 'Report resolved by the warden',
  overstay: 'Past the end time',
  closed: 'Closed',
};

export default function VisitDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { visit, notFound, message, busy, run } = useHostedVisit(id);
  const { keyFor, done } = useActionKeys();
  const [sheet, setSheet] = useState<'cancel' | 'left' | null>(null);
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  if (notFound)
    return (
      <EmptyState
        message="This visit isn't available."
        actionLabel="Back to Guests"
        onAction={() => router.replace('/guests')}
      />
    );
  if (!visit) {
    return (
      <View style={styles.center}>
        <ActivityIndicator accessibilityLabel="Loading visit" />
      </View>
    );
  }
  const visitId = visit.id;
  const actions = visit.allowedActions;
  const can = (a: VisitAction) => actions.includes(a);
  const day = toLocalDateString(new Date(visit.windowStart), RULES.timezone);

  async function saveWindow() {
    const ok = await run(
      () =>
        api.editVisitWindow(visitId, {
          windowStart: localDateTimeToUtc(day, start, RULES.timezone).toISOString(),
          windowEnd: localDateTimeToUtc(day, end, RULES.timezone).toISOString(),
        }),
      ruleMessage,
    );
    if (ok) setEditing(false);
  }

  async function share() {
    await run(async () => setInviteUrl((await api.newInviteLink(visitId)).inviteUrl), ruleMessage);
  }

  const shareMessage = inviteUrl
    ? (visit.type === 'overnight_room' || visit.type === 'guest_room'
        ? overnightInviteShareText
        : inviteShareText)({
        guestName: visit.guest.name,
        hostelName: user?.resident?.hostelName ?? visit.hostel.name,
        windowStart: visit.windowStart,
        windowEnd: visit.windowEnd,
        inviteUrl,
      })
    : null;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.card}>
        <Text style={styles.name} accessibilityRole="header">
          {visit.guest.name}
        </Text>
        <Text style={styles.body}>
          {VISIT_TYPE_LABELS[visit.type]} · {formatDateShort(visit.windowStart)},{' '}
          {formatTime12h(visit.windowStart)}–
          {visit.nights > 0 ? `${formatDateShort(visit.windowEnd)}, ` : ''}
          {formatTime12h(visit.windowEnd)}
        </Text>
        {visit.guest.phoneMasked ? (
          <Text style={styles.body}>{visit.guest.phoneMasked}</Text>
        ) : null}
        {visit.zone === 'visitors_room' ? (
          <Text style={styles.zone}>Visitors' Room only</Text>
        ) : null}
        <StatusChip status={visit.status} />
        {visit.charge ? (
          <Text style={styles.body}>
            Charge ₹{visit.charge.amountInr} · {visit.charge.status}
          </Text>
        ) : null}
      </View>

      <FlagBanners visit={visit} />

      {visit.awaitingHostConfirmation || can('approve') ? (
        <Button
          label={can('approve') ? 'Review request' : 'Confirm your guest'}
          onPress={() =>
            router.push((can('approve') ? `/walk-in/${visitId}` : `/arrival/${visitId}`) as never)
          }
        />
      ) : null}

      <View style={styles.timeline} accessibilityLabel="Timeline">
        {visit.events.map((e, i) => (
          <View key={`${e.kind}-${i}`} style={styles.event}>
            <Text style={styles.eventTime}>{formatDateTime(e.at)}</Text>
            <View style={styles.eventBody}>
              <Text style={styles.eventText}>
                {EVENT_TEXT[e.kind]}
                {e.kind === 'entry' || e.kind === 'exit'
                  ? e.locationVerified
                    ? ' · location verified'
                    : ' · location not verified'
                  : ''}
                {e.reason ? ` · ${e.reason}` : ''}
              </Text>
              {e.photo ? (
                <Image
                  source={{ uri: e.photo.url }}
                  style={styles.eventPhoto}
                  accessibilityLabel={`Photo at ${EVENT_TEXT[e.kind]}`}
                />
              ) : null}
            </View>
          </View>
        ))}
      </View>

      {editing ? (
        <View style={styles.card}>
          <View style={styles.row}>
            <DateTimeField kind="time" label="Start" value={start} onChange={setStart} />
            <DateTimeField kind="time" label="End" value={end} onChange={setEnd} />
          </View>
          <View style={styles.row}>
            <View style={styles.half}>
              <Button label="Back" variant="secondary" onPress={() => setEditing(false)} />
            </View>
            <View style={styles.half}>
              <Button label="Save" onPress={saveWindow} loading={busy} />
            </View>
          </View>
        </View>
      ) : null}

      {shareMessage && inviteUrl ? (
        <SharePanel message={shareMessage} inviteUrl={inviteUrl} />
      ) : null}

      {message ? (
        <Text style={styles.error} accessibilityRole="alert">
          {message}
        </Text>
      ) : null}

      <View style={styles.actions}>
        {can('share_invite') && !inviteUrl ? (
          <Button label="Share invite" onPress={share} loading={busy} />
        ) : null}
        {can('edit') && !editing ? (
          <Button
            label="Edit time"
            variant="secondary"
            onPress={() => {
              setStart(formatHhMm(visit.windowStart));
              setEnd(formatHhMm(visit.windowEnd));
              setEditing(true);
            }}
          />
        ) : null}
        {can('mark_left') ? (
          <Button label="My guest has left" variant="secondary" onPress={() => setSheet('left')} />
        ) : null}
        {can('cancel') ? (
          <Button label="Cancel visit" variant="danger" onPress={() => setSheet('cancel')} />
        ) : null}
      </View>

      <ConfirmSheet
        visible={sheet === 'cancel'}
        title="Cancel this visit?"
        body="Your guest's invite stops working."
        confirmLabel="Cancel visit"
        reasonLabel="Reason (optional)"
        loading={busy}
        onCancel={() => setSheet(null)}
        onConfirm={async (reason) => {
          await run(() => api.cancelHostedVisit(visitId, reason || undefined), ruleMessage);
          setSheet(null);
        }}
      />
      <ConfirmSheet
        visible={sheet === 'left'}
        title="Mark your guest as left?"
        body="Use this if they forgot to check out at the gate. The warden can see you did this."
        confirmLabel="My guest has left"
        loading={busy}
        onCancel={() => setSheet(null)}
        onConfirm={async () => {
          const ok = await run(() => api.markGuestLeft(visitId, keyFor('left')), ruleMessage);
          if (ok) done('left');
          setSheet(null);
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: space.md,
    gap: space.md,
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    backgroundColor: color.surface,
    borderRadius: shape.radius,
    padding: space.md,
    gap: space.xs,
  },
  name: { fontSize: typeTokens.size.md, fontWeight: typeTokens.weight.semibold, color: color.text },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
  zone: {
    fontSize: typeTokens.size.body,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  timeline: { gap: space.sm },
  event: { flexDirection: 'row', gap: space.sm },
  eventTime: { width: 110, fontSize: typeTokens.size.sm, color: color.textMuted },
  eventBody: { flex: 1, gap: space.xxs },
  eventText: { fontSize: typeTokens.size.sm, color: color.text },
  eventPhoto: { width: 72, height: 72, borderRadius: shape.radius },
  row: { flexDirection: 'row', gap: space.sm },
  half: { flex: 1 },
  actions: { gap: space.sm },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
});
