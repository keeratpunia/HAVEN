import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  formatDuration,
  formatHhMm,
  formatTime12h,
  localDateTimeToUtc,
  toLocalDateString,
  VISIT_TYPE_LABELS,
} from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../../services/api-client.js';
import { Button } from '../../../components/Button.js';
import { ConfirmSheet } from '../../../components/ConfirmSheet.js';
import { DateTimeField } from '../../../components/DateTimeField.js';
import { EmptyState } from '../../../components/EmptyState.js';
import { PhotoCompare } from '../../../components/PhotoCompare.js';
import { StatusChip } from '../../../components/StatusChip.js';
import { useActionKeys } from '../../../lib/action-key.js';
import { successHaptic } from '../../../lib/haptics.js';
import { ruleMessage, RULES } from '../../../lib/rule-hints.js';
import { useHostedVisit } from '../../../lib/useHostedVisit.js';

/**
 * R-08 Walk-in request (SDD §13.4): "Full-screen: live photo large, profile photo
 * small, name, gender, type, duration (editable end time), 'Location verified' or
 * amber 'Location not verified' — Approve / Reject". §14: "approve and reject equally
 * sized, approve on the right". FR-40.
 */
const GENDER: Record<string, string> = {
  female: 'Female',
  male: 'Male',
  undisclosed: 'Prefer not to say',
};

export default function WalkInRequest() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { visit, notFound, message, busy, run } = useHostedVisit(id);
  const { keyFor, done } = useActionKeys();
  const [endTime, setEndTime] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [decided, setDecided] = useState<'approved' | 'rejected' | null>(null);

  useEffect(() => {
    if (visit && !endTime) setEndTime(formatHhMm(visit.windowEnd));
  }, [visit, endTime]);

  if (notFound)
    return (
      <EmptyState
        message="This request isn't available."
        actionLabel="Back to Home"
        onAction={() => router.replace('/home')}
      />
    );
  if (!visit) {
    return (
      <View style={styles.center}>
        <ActivityIndicator accessibilityLabel="Loading request" />
      </View>
    );
  }

  const day = toLocalDateString(new Date(visit.windowStart), RULES.timezone);
  const adjustedEnd = /^\d{2}:\d{2}$/.test(endTime)
    ? localDateTimeToUtc(day, endTime, RULES.timezone)
    : null;
  const endChanged = adjustedEnd !== null && adjustedEnd.toISOString() !== visit.windowEnd;
  const durationMin =
    (new Date(visit.windowEnd).getTime() - new Date(visit.windowStart).getTime()) / 60_000;

  const visitId = visit.id;
  const newEnd = endChanged && adjustedEnd ? adjustedEnd.toISOString() : undefined;

  async function approve() {
    const ok = await run(() => api.approveVisit(visitId, keyFor('approve'), newEnd), ruleMessage);
    if (ok) {
      done('approve');
      successHaptic();
      setDecided('approved');
    }
  }

  async function reject(reason: string) {
    const ok = await run(
      () => api.rejectVisit(visitId, keyFor('reject'), reason || undefined),
      ruleMessage,
    );
    setRejecting(false);
    if (ok) {
      done('reject');
      setDecided('rejected');
    }
  }

  const waiting = visit.allowedActions.includes('approve');

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        {waiting
          ? 'Guest at the gate'
          : decided === 'approved'
            ? 'Approved — your guest is checked in'
            : 'Walk-in request'}
      </Text>
      <PhotoCompare
        live={visit.latestPhoto}
        profile={visit.guest.profilePhoto}
        guestName={visit.guest.name}
      />
      <View style={styles.card}>
        <Text style={styles.name}>{visit.guest.name}</Text>
        <Text style={styles.body}>
          {visit.guest.gender ? `${GENDER[visit.guest.gender]} · ` : ''}
          {VISIT_TYPE_LABELS[visit.type]} · {formatDuration(durationMin)} · until{' '}
          {formatTime12h(visit.windowEnd)}
        </Text>
        {visit.flags.locationUnverified ? (
          <Text style={styles.warn} accessibilityRole="alert">
            ⚠ Location not verified. Only confirm if you know your guest is at the gate.
          </Text>
        ) : (
          <Text style={styles.ok}>✓ Location verified</Text>
        )}
        {!waiting ? <StatusChip status={visit.status} /> : null}
      </View>

      {waiting && visit.type === 'day' ? (
        <DateTimeField
          kind="time"
          label="Leaves by"
          value={endTime}
          onChange={setEndTime}
          hint={`Day visits end by ${formatTime12h(localDateTimeToUtc(day, RULES.day_visit_latest_end, RULES.timezone))}.`}
        />
      ) : null}

      {message ? (
        <Text style={styles.error} accessibilityRole="alert">
          {message}
        </Text>
      ) : null}

      {waiting ? (
        <View style={styles.actions}>
          <View style={styles.half}>
            <Button
              label="Reject"
              variant="secondary"
              onPress={() => setRejecting(true)}
              disabled={busy}
            />
          </View>
          <View style={styles.half}>
            <Button label="Approve" onPress={approve} loading={busy} />
          </View>
        </View>
      ) : (
        <Button label="Back to Home" variant="secondary" onPress={() => router.replace('/home')} />
      )}

      <ConfirmSheet
        visible={rejecting}
        title={`Reject ${visit.guest.name}'s request?`}
        body="They'll be told you couldn't approve the visit."
        confirmLabel="Reject request"
        reasonLabel="Reason (optional)"
        loading={busy}
        onCancel={() => setRejecting(false)}
        onConfirm={(reason) => void reject(reason)}
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
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  card: {
    backgroundColor: color.surface,
    borderRadius: shape.radius,
    padding: space.md,
    gap: space.xs,
  },
  name: { fontSize: typeTokens.size.md, fontWeight: typeTokens.weight.semibold, color: color.text },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
  ok: {
    fontSize: typeTokens.size.sm,
    color: color.success,
    fontWeight: typeTokens.weight.semibold,
  },
  warn: {
    fontSize: typeTokens.size.sm,
    color: color.warning,
    fontWeight: typeTokens.weight.semibold,
  },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
  actions: { flexDirection: 'row', gap: space.sm },
  half: { flex: 1 },
});
