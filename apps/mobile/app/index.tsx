import { Redirect, useRouter } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';
import { Button } from '../components/Button.js';
import { useAuth } from '../lib/auth-context.js';
import { routeForUser } from '../lib/resident-route.js';

/**
 * App home. SDD §13.3: "After sign-in the root layout routes by principal: visitor →
 * (guest); ... resident → (resident) (or onboarding if not submitted, or R-04 if
 * pending)." Signed-out people choose guest (phone OTP) or resident (Google) sign-in.
 */
export default function Home() {
  const router = useRouter();
  const { visitor, user, loading } = useAuth();

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator accessibilityLabel="Loading" />
      </View>
    );
  }
  if (user) return <Redirect href={routeForUser(user) as never} />;
  if (visitor) return <Redirect href="/visits" />;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>HAVEN</Text>
      <Text style={styles.subtitle}>Hostel guest check-in</Text>
      <View style={styles.action}>
        <Button label="Sign in" onPress={() => router.push('/login')} />
      </View>
      <View style={styles.action}>
        <Button
          label="Resident sign-in"
          variant="secondary"
          onPress={() => router.push('/sign-in')}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.bg,
    gap: space.sm,
  },
  title: {
    fontSize: typeTokens.size.xl,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  subtitle: { fontSize: typeTokens.size.body, color: color.textMuted },
  action: { marginTop: space.lg, width: 240 },
});
