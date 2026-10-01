import { Stack } from 'expo-router';

/**
 * Root layout — routing foundation only (SDD §13.3: route groups will later decide
 * which shell a signed-in principal sees — (auth)/(guest)/(resident)/(warden)/(office)
 * and gate/). None of those route groups exist yet; this is just proof that
 * expo-router boots and resolves a route tree.
 */
export default function RootLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
