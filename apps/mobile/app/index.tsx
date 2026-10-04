import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';
import { Button } from '../components/Button.js';

/**
 * App home. Most guests arrive via an invite link (`/i/[token]`) and never see this
 * screen; it exists for a returning guest who bookmarked the app directly.
 */
export default function Home() {
  const router = useRouter();
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
          onPress={() => router.push('/resident/login')}
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
