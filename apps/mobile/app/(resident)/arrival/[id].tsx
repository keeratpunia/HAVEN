import { useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatTime12h, VISIT_TYPE_LABELS } from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../../services/api-client.js';
import { Button } from '../../../components/Button.js';
import { ConfirmSheet } from '../../../components/ConfirmSheet.js';
import { EmptyState } from '../../../components/EmptyState.js';
import { FlagBanners } from '../../../components/FlagBanners.js';
import { PhotoCompare } from '../../../components/PhotoCompare.js';
import { StatusChip } from '../../../components/StatusChip.js';
import { useActionKeys } from '../../../lib/action-key.js';
import { successHaptic, warningHaptic } from '../../../lib/haptics.js';
import { ruleMessage, RULES } from '../../../lib/rule-hints.js';
import { useHostedVisit } from '../../../lib/useHostedVisit.js';

/**
 * R-09 Guest arrived (SDD §13.4): "Live photo vs profile photo side by side, time —
 * Yes, that's my guest / Not my guest" (FR-42, available for 30 min; FR-43 dispute).
 * §14: "the dispute button is visually distinct (red outline) but not the default."
 *
 * Also the F3 confirmation: a guest whose location couldn't be checked is waiting at
 * the gate, and only the host's Confirm lets them in (§13.6 "Host-confirm path").
 */
export default function Arrival() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { visit, notFound, message, busy, run } = useHostedVisit(id);
  const { keyFor, done } = useActionKeys();
  const [disputing, setDisputing] = useState(false);

  if (notFound)
    return (
      <EmptyState
        message="This visit isn't available."
        actionLabel="Back to Home"
        onAction={() => router.replace('/home')}
      />
    );
  if (!visit) {
    return (
      <View style={styles.center}>
        <ActivityIndicator accessibilityLabel="Loading arrival" />
      </View>
    );
  }
  const visitId = visit.id;
  const canConfirm = visit.allowedActions.includes('confirm_arrival');
  const canDispute = visit.allowedActions.includes('dispute');

  async function confirm() {
    const ok = await run(() => api.confirmArrival(visitId, keyFor('confirm')), ruleMessage);
    if (ok) {
      done('confirm');
      successHaptic();
    }
  }

  async function dispute(note: string) {
    const ok = await run(
      () => api.disputeArrival(visitId, keyFor('dispute'), note || undefined),
      ruleMessage,
    );
    setDisputing(false);
    if (ok) {
      done('dispute');
      warningHaptic();
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        {visit.awaitingHostConfirmation
          ? 'Confirm your guest is at the gate'
          : visit.flags.disputed
            ? 'You reported this guest'
            : `${visit.guest.name} has arrived`}
      </Text>
      <PhotoCompare
        live={visit.latestPhoto}
        profile={visit.guest.profilePhoto}
        guestName={visit.guest.name}
      />
      <FlagBanners visit={visit} />
      <View style={styles.card}>
        <Text style={styles.name}>{visit.guest.name}</Text>
        <Text style={styles.body}>
          {VISIT_TYPE_LABELS[visit.type]} · until {formatTime12h(visit.windowEnd)}
        </Text>
        {visit.awaitingHostConfirmation ? (
          <Text style={styles.warn} accessibilityRole="alert">
            ⚠ {visit.guest.name}'s location couldn't be checked. Only confirm if you know they're
            there.
          </Text>
        ) : visit.firstEntryAt ? (
          <Text style={styles.body}>Checked in at {formatTime12h(visit.firstEntryAt)}</Text>
        ) : null}
        <StatusChip status={visit.status} />
        {visit.hostConfirmedAt && !visit.awaitingHostConfirmation ? (
          <Text style={styles.ok}>✓ You confirmed this guest.</Text>
        ) : null}
        {canDispute ? (
          <Text style={styles.hint}>
            You can report a guest you don't know for {RULES.dispute_window_minutes} minutes after
            they arrive.
          </Text>
        ) : null}
      </View>

      {message ? (
        <Text style={styles.error} accessibilityRole="alert">
          {message}
        </Text>
      ) : null}

      {canConfirm ? (
        <Button
          label={visit.awaitingHostConfirmation ? 'Confirm' : "Yes, that's my guest"}
          onPress={confirm}
          loading={busy}
        />
      ) : null}
      {canDispute ? (
        <Button
          label="Not my guest"
          variant="danger"
          onPress={() => setDisputing(true)}
          disabled={busy}
        />
      ) : null}
      {!canConfirm && !canDispute ? (
        <Button
          label="Open visit"
          variant="secondary"
          onPress={() => router.replace(`/visit/${visitId}`)}
        />
      ) : null}

      <ConfirmSheet
        visible={disputing}
        title={`Report ${visit.guest.name} as not your guest?`}
        body="The warden is told straight away. Your guest stays checked in until the warden acts."
        confirmLabel="Report guest"
        reasonLabel="Anything the warden should know (optional)"
        loading={busy}
        onCancel={() => setDisputing(false)}
        onConfirm={(note) => void dispute(note)}
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
  hint: { fontSize: typeTokens.size.sm, color: color.textMuted },
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
});
