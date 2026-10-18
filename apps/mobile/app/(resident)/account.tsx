import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import { Button } from '../../components/Button.js';
import { useAuth } from '../../lib/auth-context.js';
import { getPushPermission, registerForPush, type PushPermission } from '../../lib/push.js';

/**
 * R-15 Profile (SDD §13.4): "Name, room, phone, notifications on/off check, sign out,
 * delete account". Account deletion (FR-09, priority S) has no API yet, so there is no
 * button for it here rather than one that does nothing (docs/TRACEABILITY.md).
 */
const PUSH_TEXT: Record<PushPermission, string> = {
  granted: '✓ Notifications are on.',
  denied: '✕ Notifications are off. Turn them on in Android Settings → Apps → HAVEN.',
  undetermined: '⏱ Notifications aren’t set up yet.',
  unsupported:
    'Push notifications come through the HAVEN Android app. Here, new requests appear under Notifications and on Home.',
};

export default function Account() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [push, setPush] = useState<PushPermission | null>(null);

  useEffect(() => {
    void getPushPermission().then(setPush);
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        Profile
      </Text>
      <View style={styles.card}>
        <Row label="Name" value={user?.fullName ?? '—'} />
        <Row
          label="Room"
          value={user?.resident ? `${user.resident.room} · ${user.resident.hostelName}` : '—'}
        />
        <Row label="Phone" value={user?.phone ?? '—'} />
        <Row label="Email" value={user?.email ?? '—'} />
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>Notifications</Text>
        <Text style={styles.body}>{push ? PUSH_TEXT[push] : 'Checking…'}</Text>
        {push === 'undetermined' ? (
          <Button
            label="Turn on notifications"
            variant="secondary"
            onPress={async () => setPush(await registerForPush())}
          />
        ) : null}
      </View>
      <Button
        label="Sign out"
        variant="secondary"
        onPress={async () => {
          await signOut();
          router.replace('/sign-in');
        }}
      />
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: space.md, gap: space.md },
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  card: {
    backgroundColor: color.surface,
    borderRadius: shape.radius,
    padding: space.md,
    gap: space.sm,
  },
  row: { gap: space.xxs },
  label: { fontSize: typeTokens.size.sm, color: color.textMuted },
  value: { fontSize: typeTokens.size.body, color: color.text },
  body: { fontSize: typeTokens.size.body, color: color.text },
});
