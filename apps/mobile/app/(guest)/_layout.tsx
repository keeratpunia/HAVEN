import { useState } from 'react';
import { useRouter } from 'expo-router';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { detectInAppBrowser } from '@haven/shared';
import { InAppBrowserNotice } from '../../components/InAppBrowserNotice.js';
import { Stack } from 'expo-router';
import { color, space, type as typeTokens } from '@haven/ui';
import { useAuth } from '../../lib/auth-context.js';

/** SDD §13.4: "Guest (web): No tab bar; header with HAVEN logo and 'My visits'." */
export default function GuestLayout() {
  const router = useRouter();
  const { visitor } = useAuth();
  // E-03: guest links are mostly opened from WhatsApp; its in-app browser (and
  // Instagram's, Facebook's) often blocks camera and location.
  const [inAppBrowser, setInAppBrowser] = useState(() =>
    Platform.OS === 'web' && typeof navigator !== 'undefined'
      ? detectInAppBrowser(navigator.userAgent)
      : null,
  );

  return (
    <View style={styles.root}>
      <View style={styles.header} accessibilityRole="header">
        <Pressable
          onPress={() => router.push('/')}
          accessibilityRole="link"
          accessibilityLabel="HAVEN home"
          style={styles.home}
        >
          <Text style={styles.logo}>HAVEN</Text>
        </Pressable>
        {visitor ? (
          <Pressable
            onPress={() => router.push('/visits')}
            accessibilityRole="link"
            accessibilityLabel="My visits"
            style={styles.myVisits}
          >
            <Text style={styles.myVisitsText}>My visits</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.content}>
        {inAppBrowser ? (
          <InAppBrowserNotice
            browser={inAppBrowser}
            href={typeof window !== 'undefined' ? window.location.href : ''}
            onContinue={() => setInAppBrowser(null)}
          />
        ) : (
          <Stack screenOptions={{ headerShown: false }} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
    minHeight: 48,
  },
  logo: {
    fontSize: typeTokens.size.md,
    fontWeight: typeTokens.weight.semibold,
    color: color.primary,
  },
  home: { minHeight: 48, minWidth: 48, justifyContent: 'center' },
  myVisits: { minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center' },
  myVisitsText: {
    fontSize: typeTokens.size.sm,
    color: color.primary,
    fontWeight: typeTokens.weight.semibold,
  },
  content: { flex: 1 },
});
