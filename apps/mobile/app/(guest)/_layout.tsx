import { useState } from 'react';
import { usePathname, useRouter } from 'expo-router';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { detectInAppBrowser } from '@haven/shared';
import { InAppBrowserNotice } from '../../components/InAppBrowserNotice.js';
import { Stack } from 'expo-router';
import { color, type as typeTokens } from '@haven/ui';
import { useAuth } from '../../lib/auth-context.js';
import { ShellHeader } from '../../components/ShellHeader.js';

/** Where Back goes when there's no history (DEC-032). Entry screens (/g, /i) have none. */
function guestBackTo(pathname: string): string | null {
  if (pathname === '/login') return '/';
  if (pathname === '/my-profile' || /^\/visits\/[^/]+$/.test(pathname)) return '/visits';
  return null;
}

/** SDD §13.4: "Guest (web): No tab bar; header with HAVEN logo and 'My visits'." */
export default function GuestLayout() {
  const router = useRouter();
  const { visitor } = useAuth();
  const pathname = usePathname();
  // E-03: guest links are mostly opened from WhatsApp; its in-app browser (and
  // Instagram's, Facebook's) often blocks camera and location.
  const [inAppBrowser, setInAppBrowser] = useState(() =>
    Platform.OS === 'web' && typeof navigator !== 'undefined'
      ? detectInAppBrowser(navigator.userAgent)
      : null,
  );

  return (
    <View style={styles.root}>
      <ShellHeader
        role="Guest"
        backTo={guestBackTo(pathname)}
        right={
          visitor && pathname !== '/visits' ? (
            <Pressable
              onPress={() => router.navigate('/visits')}
              accessibilityRole="link"
              accessibilityLabel="My visits"
              style={styles.myVisits}
            >
              <Text style={styles.myVisitsText}>My visits</Text>
            </Pressable>
          ) : null
        }
      />
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
  myVisits: { minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center' },
  myVisitsText: {
    fontSize: typeTokens.size.sm,
    color: color.primary,
    fontWeight: typeTokens.weight.semibold,
  },
  content: { flex: 1 },
});
