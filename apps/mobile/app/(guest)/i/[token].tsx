import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { color, space, type as typeTokens } from '@haven/ui';
import * as api from '../../../api/client.js';
import { Button } from '../../../components/Button.js';
import { formatDateIst, formatTimeIst } from '../../../lib/formatTime.js';

/**
 * G-01 Invite landing (SDD §13.4): "Priya S. invited you to GH-8", date, time
 * window, type. Primary action: Continue. Notes: Expired/claimed invite -> explanation.
 */
export default function InviteLanding() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error' } | { status: 'ready'; invite: api.InviteLanding }
  >({ status: 'loading' });

  useEffect(() => {
    if (!token) return;
    api
      .getInvite(token)
      .then((invite) => setState({ status: 'ready', invite }))
      .catch(() => setState({ status: 'error' }));
  }, [token]);

  if (state.status === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator accessibilityLabel="Loading invite" />
      </View>
    );
  }

  if (state.status === 'error') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>This invite link isn't valid</Text>
        <Text style={styles.body}>
          It may have expired, or the link was typed incorrectly. Ask your host to send a new one.
        </Text>
      </View>
    );
  }

  const { invite } = state;

  if (invite.claimed) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>This invite has already been used</Text>
        <Text style={styles.body}>
          Ask {invite.hostFirstName} to send you a new invite if you need one.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        {invite.hostFirstName} invited you to {invite.hostelName}
      </Text>
      <View style={styles.card}>
        <Text style={styles.cardLine}>
          {formatDateIst(invite.windowStart)} · {formatTimeIst(invite.windowStart)} –{' '}
          {formatTimeIst(invite.windowEnd)}
        </Text>
        <Text style={styles.cardLine}>{invite.type === 'day' ? 'Day visit' : invite.type}</Text>
        {invite.invitedPhoneMasked ? (
          <Text style={styles.cardLine}>For {invite.invitedPhoneMasked}</Text>
        ) : null}
      </View>
      <View style={styles.action}>
        <Button
          label="Continue"
          onPress={() => router.push({ pathname: '/login', params: { token } })}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  container: { flex: 1, padding: space.md, gap: space.md },
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
  card: { backgroundColor: color.surface, borderRadius: 12, padding: space.md, gap: space.xxs },
  cardLine: { fontSize: typeTokens.size.body, color: color.text },
  action: { marginTop: 'auto' },
});
