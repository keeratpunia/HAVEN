import { Redirect } from 'expo-router';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';
import { ProfileEditor } from '../../components/ProfileEditor.js';
import { useAuth } from '../../lib/auth-context.js';

/** FR-08: the guest's own profile — see and edit their name, retake their photo. */
export default function MyProfile() {
  const { visitor, loading, refresh } = useAuth();
  if (!loading && !visitor) return <Redirect href="/login" />;
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        My profile
      </Text>
      <ProfileEditor kind="guest" onSaved={() => void refresh()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: space.md,
    gap: space.md,
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
});
