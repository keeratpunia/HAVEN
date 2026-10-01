import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

/**
 * Placeholder boot screen — NOT a product screen. Proves the Expo Router entry point,
 * the monorepo's @haven/shared and @haven/ui workspace packages, and Metro bundling
 * all work end to end. The actual route groups and screens ((auth), (guest),
 * (resident), (warden), (office), gate/ — SDD §13.3/§13.4) are built starting in M1/M2.
 */
export default function BootPlaceholder() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>HAVEN</Text>
      <Text style={styles.subtitle}>Bootstrap foundation — no product screens yet.</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    gap: 8,
  },
  title: {
    fontSize: 32,
    fontWeight: '600',
    color: '#0F172A',
  },
  subtitle: {
    fontSize: 14,
    color: '#475569',
  },
});
