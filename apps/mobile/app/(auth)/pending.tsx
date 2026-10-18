import { useState } from 'react';
import { Redirect, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { formatDateShort } from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import { Button } from '../../components/Button.js';
import { useAuth } from '../../lib/auth-context.js';
import { residentRoute } from '../../lib/resident-route.js';

/**
 * R-04 Pending verification (SDD §13.4): "Status card, submitted details, 'Usually
 * within a day' — Refresh". Also where a rejected resident sees the reason and, if
 * they have their one resubmission left (§3.2), goes back to R-03.
 */
export default function Pending() {
  const router = useRouter();
  const { user, refresh, signOut } = useAuth();
  const [loading, setLoading] = useState(false);

  if (!user) return <Redirect href="/sign-in" />;
  const resident = user.resident;
  const target = residentRoute(user);
  if (target !== '/pending') return <Redirect href={target as never} />;

  async function reload() {
    setLoading(true);
    await refresh();
    setLoading(false);
  }

  return (
    <View style={styles.container}>
      {resident?.status === 'rejected' ? (
        <View style={[styles.card, styles.rejected]} accessibilityRole="summary">
          <Text style={styles.title}>✕ Verification not approved</Text>
          {resident.rejectionReason ? (
            <Text style={styles.body}>{resident.rejectionReason}</Text>
          ) : null}
          {resident.canResubmit ? (
            <Button label="Fix and resubmit" onPress={() => router.push('/onboarding')} />
          ) : (
            <Text style={styles.body}>Please contact the warden's office.</Text>
          )}
        </View>
      ) : resident?.status === 'left' ? (
        <View style={styles.card}>
          <Text style={styles.title}>Your resident access has ended</Text>
          <Text style={styles.body}>Please contact the warden's office if this is a mistake.</Text>
        </View>
      ) : (
        <View style={styles.card} accessibilityRole="summary">
          <Text style={styles.title}>⏱ Waiting for the warden to verify you</Text>
          <Text style={styles.body}>Usually within a day.</Text>
        </View>
      )}

      {resident ? (
        <View style={styles.details}>
          <Text style={styles.label}>Submitted details</Text>
          <Text style={styles.body}>
            {resident.hostelName} · Room {resident.room}
          </Text>
          <Text style={styles.body}>Phone {user.phone ?? '—'}</Text>
          {resident.submittedAt ? (
            <Text style={styles.body}>Submitted {formatDateShort(resident.submittedAt)}</Text>
          ) : null}
        </View>
      ) : null}

      <Button label="Refresh" variant="secondary" onPress={reload} loading={loading} />
      <Button
        label="Sign out"
        variant="ghost"
        onPress={async () => {
          await signOut();
          router.replace('/sign-in');
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: space.md,
    gap: space.md,
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  card: {
    backgroundColor: '#FEF3C7',
    borderRadius: shape.radius,
    padding: space.md,
    gap: space.xs,
  },
  rejected: { backgroundColor: '#FEE2E2' },
  title: {
    fontSize: typeTokens.size.md,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
  label: {
    fontSize: typeTokens.size.sm,
    color: color.textMuted,
    fontWeight: typeTokens.weight.semibold,
  },
  details: { gap: space.xxs },
});
