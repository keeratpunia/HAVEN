import { StyleSheet, Text, View } from 'react-native';
import { color, shape, space, type as typeTokens } from '@haven/ui';

/** SDD §13.5 `Banner` (offline, location unverified) + §13.7: "Offline: top banner 'You're offline. We'll retry.'" */
export function Banner({ text, tone = 'warning' }: { text: string; tone?: 'warning' | 'danger' }) {
  return (
    <View
      style={[styles.banner, tone === 'danger' ? styles.danger : styles.warning]}
      accessibilityRole="alert"
    >
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

export function OfflineBanner({ online }: { online: boolean }) {
  if (online) return null;
  return <Banner text="You're offline. We'll retry." tone="warning" />;
}

const styles = StyleSheet.create({
  banner: {
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
    borderRadius: shape.radius,
    marginBottom: space.sm,
  },
  warning: { backgroundColor: '#FEF3C7' },
  danger: { backgroundColor: '#FEE2E2' },
  text: { fontSize: typeTokens.size.sm, color: color.text, fontWeight: typeTokens.weight.semibold },
});
