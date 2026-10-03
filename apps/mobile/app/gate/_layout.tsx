import { Stack } from 'expo-router';

/** Gate device shell: full screen, no chrome (SDD §13.4 "Gate device (web)"). */
export default function GateLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
