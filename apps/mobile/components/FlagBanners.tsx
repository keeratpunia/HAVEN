import { StyleSheet, Text, View } from 'react-native';
import type { VisitDTO } from '@haven/shared';
import { color, shape, space, type as typeTokens } from '@haven/ui';

/**
 * Visit flags as banners (SDD §14 detail layout: "then flags as banners"). Colour +
 * icon + word, never colour alone (§13.1 principle 2).
 */
export function FlagBanners({ visit }: { visit: VisitDTO }) {
  const banners: { key: string; glyph: string; text: string; tone: 'warning' | 'danger' }[] = [];
  if (visit.flags.disputed)
    banners.push({
      key: 'd',
      glyph: '✕',
      text: 'You reported this guest as not yours.',
      tone: 'danger',
    });
  if (visit.flags.overstay)
    banners.push({
      key: 'o',
      glyph: '⏱',
      text: 'Your guest is past their end time.',
      tone: 'warning',
    });
  if (visit.flags.locationUnverified)
    banners.push({
      key: 'l',
      glyph: '⚠',
      text: 'Location not verified at entry.',
      tone: 'warning',
    });
  if (visit.flags.exitLocationUnverified)
    banners.push({ key: 'e', glyph: '⚠', text: 'Location not verified at exit.', tone: 'warning' });
  if (banners.length === 0) return null;
  return (
    <View style={styles.list}>
      {banners.map((b) => (
        <View
          key={b.key}
          style={[styles.banner, b.tone === 'danger' ? styles.danger : styles.warning]}
          accessibilityRole="alert"
        >
          <Text style={[styles.text, b.tone === 'danger' ? styles.dangerText : styles.warningText]}>
            {b.glyph} {b.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.xs },
  banner: { borderRadius: shape.radius, padding: space.sm },
  warning: { backgroundColor: '#FEF3C7' },
  danger: { backgroundColor: '#FEE2E2' },
  text: { fontSize: typeTokens.size.sm, fontWeight: typeTokens.weight.semibold },
  warningText: { color: color.warning },
  dangerText: { color: color.danger },
});
