import { Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';

/** Shared sign-in / onboarding shell (SDD §13.4 "Auth: Shared"). */
export default function AuthLayout() {
  return (
    <View style={styles.root}>
      <View style={styles.header} accessibilityRole="header">
        <Text style={styles.logo}>HAVEN</Text>
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
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
  },
  logo: {
    fontSize: typeTokens.size.md,
    fontWeight: typeTokens.weight.semibold,
    color: color.primary,
  },
  content: { flex: 1 },
});
