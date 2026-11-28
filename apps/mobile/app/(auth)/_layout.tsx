import { Stack, usePathname } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { color } from '@haven/ui';
import { ShellHeader } from '../../components/ShellHeader.js';

/** Shared sign-in / onboarding shell (SDD §13.4 "Auth: Shared"). */
export default function AuthLayout() {
  const pathname = usePathname();
  // Sign-in is reached from the front page: Back returns there (DEC-032).
  const backTo = pathname === '/sign-in' ? '/' : null;
  return (
    <View style={styles.root}>
      <ShellHeader backTo={backTo} />
      <View style={styles.content}>
        <Stack screenOptions={{ headerShown: false }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { flex: 1 },
});
