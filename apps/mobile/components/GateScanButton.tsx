import { useState } from 'react';
import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { copyFor, gateTokenFromQr } from '@haven/shared';
import { color, space, type as typeTokens } from '@haven/ui';
import { Button } from './Button.js';
import { QrScanner } from './QrScanner.js';

/**
 * FR-22: "The guest app also offers an in-app scanner on its home screen." Reads the
 * gate QR with the live camera (`QrScanner`, @zxing/browser on the web) and opens the
 * same gate flow as the phone's own camera would (`/g/<token>`). Only a gate token is
 * accepted; the scanned URL itself is never opened.
 */
export function GateScanButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!open) {
    return (
      <View style={styles.box}>
        <Button
          label="Scan the gate QR"
          onPress={() => {
            setProblem(null);
            setOpen(true);
          }}
        />
        {problem ? (
          <Text style={styles.problem} accessibilityRole="alert">
            {problem}
          </Text>
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.box}>
      <QrScanner
        onScan={(text) => {
          const token = gateTokenFromQr(text);
          setOpen(false);
          if (token) router.push(`/g/${token}`);
          else setProblem(copyFor('GATE_TOKEN_INVALID').body);
        }}
        onPermissionDenied={() => {
          setOpen(false);
          setProblem("Camera is blocked. Allow camera access in your browser's site settings.");
        }}
      />
      <Button label="Cancel" variant="ghost" onPress={() => setOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: space.xs, marginBottom: space.md },
  problem: { fontSize: typeTokens.size.sm, color: color.danger },
});
