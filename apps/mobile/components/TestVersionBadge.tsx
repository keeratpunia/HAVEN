import { StyleSheet, Text, View } from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';
import { IS_TEST_VERSION } from '../lib/app-env.js';

/**
 * "TEST VERSION · dummy data" on every screen of the Phase 1 test version (DEC-028). A
 * thin strip above everything else, so it never covers content and stays well away
 * from the gate QR in the middle of the gate screen.
 */
export function TestVersionBadge() {
  if (!IS_TEST_VERSION) return null;
  return (
    <View style={styles.strip} accessibilityRole="text">
      <Text style={styles.text}>TEST VERSION · dummy data</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    backgroundColor: color.warning,
    paddingVertical: space.xxs,
    alignItems: 'center',
  },
  text: {
    color: color.onPrimary,
    fontSize: typeTokens.size.xs,
    fontWeight: typeTokens.weight.semibold,
    letterSpacing: 0.5,
  },
});
