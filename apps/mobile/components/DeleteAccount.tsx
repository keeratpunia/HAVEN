import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { copyFor, fillCopy, type CopyEntry, type DeletionWaitingFor } from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../api/client.js';
import { Button } from './Button.js';
import { ConfirmSheet } from './ConfirmSheet.js';

/**
 * "Delete my account" (FR-09, SDD §16.6) for R-15 and the G-17 menu. The request signs
 * the person out everywhere; the screen then says whether deletion waits for a visit
 * (§16.6 step 2, "shown to the user") and lets them leave. A resident with unpaid
 * charges is told so and stays signed in (step 4).
 */
export function DeleteAccount({
  kind,
  onSignedOut,
}: {
  kind: 'guest' | 'resident';
  /** Clears the local session and leaves the signed-in screens. */
  onSignedOut: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CopyEntry | null>(null);
  const [problem, setProblem] = useState<CopyEntry | null>(null);
  const confirm = copyFor(
    kind === 'guest' ? 'ACCOUNT_DELETE_CONFIRM_GUEST' : 'ACCOUNT_DELETE_CONFIRM_RESIDENT',
  );

  async function submit(reason: string) {
    setBusy(true);
    setProblem(null);
    try {
      const res = await api.requestAccountDeletion(reason || undefined);
      setResult(copyFor(resultKey(res.waitingFor)));
    } catch (err) {
      const details =
        err instanceof api.ApiError
          ? (err.details as { reason?: string; unpaidInr?: number } | undefined)
          : undefined;
      setProblem(
        details?.reason === 'UNPAID_CHARGES'
          ? fillCopy(copyFor('ACCOUNT_DELETION_UNPAID'), {
              amount: String(details.unpaidInr ?? ''),
            })
          : copyFor('UNKNOWN'),
      );
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (result) {
    return (
      <View style={styles.card} accessibilityRole="alert">
        <Text style={styles.title}>{result.title}</Text>
        <Text style={styles.body}>{result.body}</Text>
        <Button label="OK" onPress={() => void onSignedOut()} />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {problem ? (
        <View style={styles.card} accessibilityRole="alert">
          <Text style={styles.title}>{problem.title}</Text>
          <Text style={styles.body}>{problem.body}</Text>
        </View>
      ) : null}
      <Button label="Delete my account" variant="danger" onPress={() => setConfirming(true)} />
      <ConfirmSheet
        visible={confirming}
        title={confirm.title}
        body={confirm.body}
        reasonLabel="Reason (optional)"
        confirmLabel="Delete my account"
        loading={busy}
        onConfirm={(reason) => void submit(reason)}
        onCancel={() => setConfirming(false)}
      />
    </View>
  );
}

function resultKey(waitingFor: DeletionWaitingFor | null): string {
  if (waitingFor === 'inside') return 'ACCOUNT_DELETION_WAITS_INSIDE';
  if (waitingFor === 'upcoming_visit') return 'ACCOUNT_DELETION_WAITS_UPCOMING';
  return 'ACCOUNT_DELETION_REQUESTED';
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  card: {
    backgroundColor: color.surface,
    borderRadius: shape.radius,
    padding: space.md,
    gap: space.sm,
  },
  title: {
    fontSize: typeTokens.size.md,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  body: { fontSize: typeTokens.size.body, color: color.text },
});
