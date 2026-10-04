import { useRouter, usePathname } from 'expo-router';
import { Stack } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';
import { useAuth } from '../../lib/auth-context.js';

const NAV_LINKS: {
  href: '/resident/invite' | '/resident/requests' | '/resident/visits';
  label: string;
}[] = [
  { href: '/resident/invite', label: 'Invite' },
  { href: '/resident/requests', label: 'Requests' },
  { href: '/resident/visits', label: 'Visits' },
];

/**
 * Resident shell: minimal demo slice (no tab bar from the full SDD §13.4 "Resident
 * (native)" shell — just enough navigation to reach the four screens this milestone
 * builds). Redirect-to-login and "only verified residents may host" are each enforced
 * by the screens themselves / by the API, not here.
 */
export default function ResidentLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, signOut } = useAuth();

  return (
    <View style={styles.root}>
      <View style={styles.header} accessibilityRole="header">
        <Pressable
          onPress={() => router.push('/resident/visits')}
          accessibilityRole="link"
          accessibilityLabel="HAVEN home"
        >
          <Text style={styles.logo}>HAVEN</Text>
        </Pressable>
        {user ? (
          <View style={styles.nav}>
            {NAV_LINKS.map((link) => (
              <Pressable
                key={link.href}
                onPress={() => router.push(link.href)}
                accessibilityRole="link"
                accessibilityLabel={link.label}
                style={styles.navItem}
              >
                <Text style={[styles.navText, pathname === link.href && styles.navTextActive]}>
                  {link.label}
                </Text>
              </Pressable>
            ))}
            <Pressable
              onPress={() => {
                signOut();
                router.replace('/resident/login');
              }}
              accessibilityRole="button"
              accessibilityLabel="Sign out"
              style={styles.navItem}
            >
              <Text style={styles.navText}>Sign out</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      <View style={styles.content}>
        <Stack screenOptions={{ headerShown: false }} />
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
  nav: { flexDirection: 'row', gap: space.sm },
  navItem: { minHeight: 48, justifyContent: 'center', paddingHorizontal: space.xs },
  navText: { fontSize: typeTokens.size.sm, color: color.textMuted },
  navTextActive: { color: color.primary, fontWeight: typeTokens.weight.semibold },
  content: { flex: 1 },
});
