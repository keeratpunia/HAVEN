import { StyleSheet, Text } from 'react-native';
import { color, type as typeTokens } from '@haven/ui';

/**
 * Native build: the Turnstile widget is web-only, so the Android app shows the API's
 * message and the person tries again later (the per-IP window resets within the hour).
 * Guests use the web app; residents verify their phone once (docs/SECURITY-AUDIT.md SA-07).
 */
export function TurnstileChallenge({
  message,
}: {
  message: string;
  onToken: (token: string) => void;
}) {
  return (
    <Text style={styles.text} accessibilityRole="alert">
      {message}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: { fontSize: typeTokens.size.sm, color: color.danger },
});
