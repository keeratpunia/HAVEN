import { Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { AuthProvider } from '../lib/auth-context.js';
import { initSentry } from '../lib/sentry.js';
import { startPwa } from '../lib/pwa.js';

// No-op unless EXPO_PUBLIC_SENTRY_DSN is set (SDD §8.4).
initSentry();
// Web only: service worker (exported builds), install prompt, keyboard (DEC-026).
startPwa();

/**
 * Root layout (SDD §13.3: route groups decide which shell a signed-in principal sees).
 * Only the `(guest)` shell is built in this milestone — see docs/TRACEABILITY.md.
 */
export default function RootLayout() {
  return (
    <AuthProvider>
      <View style={styles.root}>
        <Stack screenOptions={{ headerShown: false }} />
      </View>
    </AuthProvider>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
