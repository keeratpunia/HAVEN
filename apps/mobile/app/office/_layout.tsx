import { Redirect, Stack, useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';
import { useAuth } from '../../lib/auth-context.js';
import { StaffProvider } from '../../lib/staff-context.js';
import { availableShells, routeForUser } from '../../lib/resident-route.js';
import { HostelPicker } from '../../components/staff/StaffUi.js';
import { ShellHeader } from '../../components/ShellHeader.js';

/** Office shell (SDD §13.3): "Single screen with filters" — O-01 Charges. */
export default function OfficeLayout() {
  const router = useRouter();
  const { user, loading, signOut } = useAuth();
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator accessibilityLabel="Loading" />
      </View>
    );
  }
  if (!user) return <Redirect href="/sign-in" />;
  if (!user.roles.some((r) => r.r === 'office'))
    return <Redirect href={routeForUser(user) as never} />;
  const others = availableShells(user).filter((s) => s.label !== 'Office');
  return (
    <StaffProvider me={user}>
      <View style={styles.root}>
        <ShellHeader
          role="Office"
          right={
            <>
              <HostelPicker />
              <View style={styles.links}>
                {others.map((s) => (
                  <Pressable
                    key={s.path}
                    onPress={() => router.replace(s.path as never)}
                    accessibilityRole="button"
                    style={styles.link}
                  >
                    <Text style={styles.linkText}>{`Switch to ${s.label}`}</Text>
                  </Pressable>
                ))}
                <Pressable
                  onPress={async () => {
                    await signOut();
                    router.replace('/sign-in');
                  }}
                  accessibilityRole="button"
                  style={styles.link}
                >
                  <Text style={styles.linkText}>Sign out</Text>
                </Pressable>
              </View>
            </>
          }
        />
        <View style={styles.content}>
          <Stack screenOptions={{ headerShown: false }} />
        </View>
      </View>
    </StaffProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  links: { flexDirection: 'row', gap: space.sm },
  link: { minHeight: 48, justifyContent: 'center' },
  linkText: {
    color: color.primary,
    fontSize: typeTokens.size.sm,
    fontWeight: typeTokens.weight.semibold,
  },
  content: { flex: 1 },
});
