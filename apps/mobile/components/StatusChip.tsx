import { StyleSheet, Text, View } from 'react-native';
import { color, shape, type as typeTokens } from '@haven/ui';

/**
 * SDD §13.1 principle 2: "Status is colour + icon + word, never colour alone: green
 * check 'Checked in', amber clock 'Waiting', red cross 'Not allowed'." Maps
 * `visits.status` to a token colour + icon glyph + word — never colour alone.
 */
const STATUS_MAP: Record<
  string,
  { word: string; glyph: string; tone: 'success' | 'warning' | 'danger' | 'muted' }
> = {
  pending_host: { word: 'Waiting', glyph: '⏱', tone: 'warning' },
  pending_warden: { word: 'Waiting for warden', glyph: '⏱', tone: 'warning' },
  approved: { word: 'Approved', glyph: '✓', tone: 'success' },
  inside: { word: 'Checked in', glyph: '✓', tone: 'success' },
  completed: { word: 'Completed', glyph: '✓', tone: 'muted' },
  rejected: { word: 'Not allowed', glyph: '✕', tone: 'danger' },
  expired: { word: 'Expired', glyph: '✕', tone: 'danger' },
  cancelled: { word: 'Cancelled', glyph: '✕', tone: 'muted' },
};

export function StatusChip({ status }: { status: string }) {
  const entry = STATUS_MAP[status] ?? { word: status, glyph: '', tone: 'muted' as const };
  return (
    <View
      style={[styles.chip, toneStyles[entry.tone]]}
      accessibilityRole="text"
      accessibilityLabel={entry.word}
    >
      <Text style={[styles.text, toneTextStyles[entry.tone]]}>
        {entry.glyph} {entry.word}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    borderRadius: shape.chipRadius,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  text: { fontSize: typeTokens.size.sm, fontWeight: typeTokens.weight.semibold },
});

const toneStyles = StyleSheet.create({
  success: { backgroundColor: '#DCFCE7' },
  warning: { backgroundColor: '#FEF3C7' },
  danger: { backgroundColor: '#FEE2E2' },
  muted: { backgroundColor: color.surface },
});
const toneTextStyles = StyleSheet.create({
  success: { color: color.success },
  warning: { color: color.warning },
  danger: { color: color.danger },
  muted: { color: color.textMuted },
});
