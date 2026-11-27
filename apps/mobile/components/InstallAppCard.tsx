import { StyleSheet, Text, View } from 'react-native';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import { Button } from './Button.js';
import { promptInstall, useInstallOption } from '../lib/pwa.js';

/**
 * "Add HAVEN to your home screen" for residents, wardens and office staff on a phone
 * browser (DEC-026 Phase 1: no APK yet). Hidden once installed and in the Android app.
 * Android Chrome gets its install dialog; iPhone Safari has none, so it gets the steps.
 */
export function InstallAppCard() {
  const option = useInstallOption();
  if (option === 'installed') return null;
  return (
    <View style={styles.card} accessibilityRole="summary">
      <Text style={styles.title}>Add HAVEN to your home screen</Text>
      {option === 'prompt' ? (
        <>
          <Text style={styles.body}>It opens like an app, full screen, from its own icon.</Text>
          <Button label="Install HAVEN" onPress={() => void promptInstall()} />
        </>
      ) : option === 'ios-steps' ? (
        <Text style={styles.body}>
          In Safari, tap the Share button (the square with an arrow), then “Add to Home Screen”,
          then “Add”.
        </Text>
      ) : (
        <Text style={styles.body}>
          Open your browser’s menu (⋮) and choose “Add to Home screen” or “Install app”.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: space.xs,
    padding: space.md,
    borderRadius: shape.radius,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
  },
  title: {
    fontSize: typeTokens.size.body,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  body: { fontSize: typeTokens.size.sm, color: color.textMuted },
});
