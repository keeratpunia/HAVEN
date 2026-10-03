import { useState } from 'react';
import { useRouter } from 'expo-router';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import * as api from '../../api/client.js';
import { Button } from '../../components/Button.js';
import { writeGateStorage } from '../../lib/gateStorage.js';

/** D-01 Pair (SDD §13.4/F8 step 2): 8-character pairing code, entered on the device. */
export default function GatePair() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pair() {
    setError(null);
    setLoading(true);
    try {
      const result = await api.pairGateDevice(code.trim().toUpperCase());
      writeGateStorage({
        deviceToken: result.deviceToken,
        secret: result.secret,
        secretVersion: result.secretVersion,
        code: result.gate.code,
        offsetMs: Date.now() - new Date(result.serverTime).getTime(),
        hostelName: result.hostelName,
        gateName: result.gate.name,
      });
      router.replace('/gate');
    } catch {
      setError('That code is invalid or expired. Ask the warden for a new one.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>HAVEN gate</Text>
      <Text style={styles.body}>Ask the warden for a code</Text>
      <TextInput
        value={code}
        onChangeText={(text) => setCode(text.replace(/[^A-Za-z0-9]/g, '').slice(0, 8))}
        placeholder="e.g. 7K3Q9A2M"
        placeholderTextColor={color.textMuted}
        autoCapitalize="characters"
        style={styles.input}
        accessibilityLabel="Pairing code"
      />
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <View style={styles.action}>
        <Button label="Pair" onPress={pair} loading={loading} disabled={code.length !== 8} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.bg,
    padding: space.lg,
    gap: space.md,
  },
  title: {
    fontSize: typeTokens.size.xl,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
  input: {
    width: 260,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: shape.radius,
    paddingHorizontal: space.sm,
    minHeight: 52,
    fontSize: typeTokens.size.lg,
    letterSpacing: 2,
    textAlign: 'center',
    color: color.text,
  },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
  action: { width: 260, marginTop: space.sm },
});
