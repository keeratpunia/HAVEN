import { StyleSheet, Text, View } from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';
import { Button } from './Button.js';

/** SDD §13.7: "Empty: illustration-free, one sentence + one action." */
export function EmptyState({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.container}>
      <Text style={styles.message}>{message}</Text>
      {actionLabel && onAction ? (
        <Button label={actionLabel} onPress={onAction} fullWidth={false} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl },
  message: { fontSize: typeTokens.size.body, color: color.textMuted, textAlign: 'center' },
});
