import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { color, type as typeTokens } from '@haven/ui';

/**
 * The one line under a form or list that says what just happened (DEC-032): green when
 * it worked ("Marked paid."), red when it didn't. Before, every message used the error
 * style, so a success read like a failure (phone test, 2026-11-28).
 */
export type Status = { text: string; ok: boolean } | null;

export function useStatus() {
  const [message, setStatus] = useState<Status>(null);
  const ok = useCallback((text: string) => setStatus({ text, ok: true }), []);
  const fail = useCallback((text: string) => setStatus({ text, ok: false }), []);
  const clear = useCallback(() => setStatus(null), []);
  return useMemo(() => ({ message, ok, fail, clear }), [message, ok, fail, clear]);
}

export function StatusText({ status }: { status: Status }) {
  if (!status) return null;
  return (
    <Text
      style={[styles.text, status.ok ? styles.ok : styles.fail]}
      accessibilityRole={status.ok ? 'text' : 'alert'}
      accessibilityLiveRegion="polite"
    >
      {status.text}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: { fontSize: typeTokens.size.sm, fontWeight: typeTokens.weight.semibold },
  ok: { color: color.success },
  fail: { color: color.danger },
});
