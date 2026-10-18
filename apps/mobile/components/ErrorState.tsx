import { StyleSheet, Text, View } from 'react-native';
import { copyFor, fillCopy } from '@haven/shared';
import { color, space, type as typeTokens } from '@haven/ui';
import { Button } from './Button.js';

/**
 * SDD G-13 "Not allowed": red cross, reason in plain words, what to do. §13.1
 * principle 5: "Never a dead end. Every error screen has a next step." Looks up copy
 * by error/rule code from the SDD §13.6 table (`@haven/shared`'s `copyFor`) — never a
 * hand-written string here.
 */
export function ErrorState({
  code,
  values,
  actionLabel = 'Back to start',
  onAction,
  tone = 'error',
}: {
  code: string;
  values?: Record<string, string>;
  actionLabel?: string;
  onAction: () => void;
  /** `info` for a next-step screen that isn't a refusal (no red cross). */
  tone?: 'error' | 'info';
}) {
  const entry = fillCopy(copyFor(code), values ?? {});
  return (
    <View style={styles.container} accessibilityRole="alert">
      {tone === 'error' ? (
        <Text style={styles.glyph} accessibilityLabel="Not allowed">
          ✕
        </Text>
      ) : (
        <Text style={[styles.glyph, styles.infoGlyph]} accessibilityElementsHidden>
          ✓
        </Text>
      )}
      <Text style={styles.title}>{entry.title}</Text>
      <Text style={styles.body}>{entry.body}</Text>
      <View style={styles.action}>
        <Button label={actionLabel} onPress={onAction} variant="secondary" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xl,
    paddingHorizontal: space.md,
  },
  glyph: { fontSize: 48, color: color.danger },
  infoGlyph: { color: color.success },
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
    textAlign: 'center',
  },
  body: { fontSize: typeTokens.size.body, color: color.textMuted, textAlign: 'center' },
  action: { marginTop: space.md, width: '100%' },
});
