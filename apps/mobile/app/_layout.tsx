import { Stack } from 'expo-router';
import { AuthProvider } from '../lib/auth-context.js';

/**
 * Root layout (SDD §13.3: route groups decide which shell a signed-in principal sees).
 * Only the `(guest)` shell is built in this milestone — see docs/TRACEABILITY.md.
 */
export default function RootLayout() {
  return (
    <AuthProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </AuthProvider>
  );
}
