import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatTime12h, VISIT_TYPE_LABELS } from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../../services/api-client.js';
import { Button } from '../../../components/Button.js';
import { EmptyState } from '../../../components/EmptyState.js';
import { FlagBanners } from '../../../components/FlagBanners.js';
import { LivePhoto, PhotoCompare } from '../../../components/PhotoCompare.js';
import { StatusChip } from '../../../components/StatusChip.js';
import { useActionKeys } from '../../../lib/action-key.js';
import { successHaptic } from '../../../lib/haptics.js';
import { ruleMessage } from '../../../lib/rule-hints.js';
import { useHostedVisit } from '../../../lib/useHostedVisit.js';

/**
 * R-09 Guest arrived (SDD §13.4), opened from N-ARRIVED. DEC-033: for an invited or
 * overnight guest it is a notice only — the gate photo and the time, no "Yes, that's my
 * guest" / "Not my guest" (those belong to walk-ins, whom the host approves before entry).
 *
 * Also the F3 confirmation: a guest whose location couldn't be checked is waiting at
 * the gate, and only the host's Confirm lets them in (§13.6 "Host-confirm path").
 */
export default function Arrival() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { visit, notFound, message, busy, run } = useHostedVisit(id);
  const { keyFor, done } = useActionKeys();

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
  const waiting = visit.awaitingHostConfirmation;

  async function confirm() {
    const ok = await run(() => api.confirmArrival(visitId, keyFor('confirm')), ruleMessage);
    if (ok) {
      done('confirm');
      successHaptic();
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        {waiting ? 'Confirm your guest is at the gate' : `${visit.guest.name} has arrived`}
      </Text>
      {waiting ? (
        <PhotoCompare
          live={visit.latestPhoto}
          profile={visit.guest.profilePhoto}
          guestName={visit.guest.name}
        />
      ) : (
        <LivePhoto photo={visit.latestPhoto} guestName={visit.guest.name} />
      )}
      <FlagBanners visit={visit} />
      <View style={styles.card}>
        <Text style={styles.name}>{visit.guest.name}</Text>
        <Text style={styles.body}>
          {VISIT_TYPE_LABELS[visit.type]} · until {formatTime12h(visit.windowEnd)}
        </Text>
        {waiting ? (
          <Text style={styles.warn} accessibilityRole="alert">
            ⚠ {visit.guest.name}'s location couldn't be checked. Only confirm if you know they're
            there.
          </Text>
        ) : visit.firstEntryAt ? (
          <Text style={styles.body}>Checked in at {formatTime12h(visit.firstEntryAt)}</Text>
        ) : null}
        <StatusChip status={visit.status} />
      </View>

      {message ? (
        <Text style={styles.error} accessibilityRole="alert">
          {message}
        </Text>
      ) : null}

      {canConfirm ? (
        <Button label="Confirm" onPress={confirm} loading={busy} />
      ) : (
        <Button
          label="Open visit"
          variant="secondary"
          onPress={() => router.replace(`/visit/${visitId}`)}
        />
      )}
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
  warn: {
    fontSize: typeTokens.size.sm,
    color: color.warning,
    fontWeight: typeTokens.weight.semibold,
  },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
});
