import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { copyFor } from '@haven/shared';
import { color, space, type as typeTokens } from '@haven/ui';

/**
 * The full privacy notice (SDD §16.3: "Full text at /privacy"). Public — it is read
 * before anyone signs in or consents. Text lives in copy/en.ts (PRIVACY_*); the version
 * a person agrees to is CONSENT_VERSION.
 */
const SECTIONS = [
  'PRIVACY_PURPOSE',
  'PRIVACY_DATA',
  'PRIVACY_WHO',
  'PRIVACY_RETENTION',
  'PRIVACY_DELETE',
  'PRIVACY_CONTACT',
] as const;

export default function Privacy() {
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        Privacy notice
      </Text>
      <Text style={styles.body}>{copyFor('PRIVACY_SUMMARY').body}</Text>
      {SECTIONS.map((key) => (
        <View key={key} style={styles.section}>
          <Text style={styles.heading} accessibilityRole="header">
            {copyFor(key).title}
          </Text>
          <Text style={styles.body}>{copyFor(key).body}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: space.md,
    gap: space.md,
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  heading: {
    fontSize: typeTokens.size.md,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  section: { gap: space.xxs },
  body: { fontSize: typeTokens.size.body, color: color.text },
});
