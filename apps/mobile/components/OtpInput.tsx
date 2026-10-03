import { useRef } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { color, shape, space, type as typeTokens } from '@haven/ui';

/** SDD G-03: "6 boxes, auto-advance, Android SMS autofill (autocomplete='one-time-code')." */
export function OtpInput({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const refs = useRef<(TextInput | null)[]>([]);
  const digits = value.padEnd(6, ' ').split('').slice(0, 6);

  function setDigit(index: number, char: string) {
    const clean = char.replace(/[^0-9]/g, '');
    const next = digits.slice();
    if (clean.length > 1) {
      // Pasted/autofilled the whole code into one box.
      const pasted = clean.slice(0, 6).split('');
      onChange(pasted.join('').padEnd(6, ' ').trimEnd());
      refs.current[Math.min(pasted.length, 5)]?.focus();
      return;
    }
    next[index] = clean;
    onChange(next.join('').trimEnd());
    if (clean && index < 5) refs.current[index + 1]?.focus();
  }

  return (
    <View style={styles.row} accessibilityRole="none" accessibilityLabel="6-digit code">
      {digits.map((d, i) => (
        <TextInput
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d.trim()}
          onChangeText={(text) => setDigit(i, text)}
          keyboardType="number-pad"
          inputMode="numeric"
          maxLength={6}
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          style={styles.box}
          accessibilityLabel={`Digit ${i + 1} of 6`}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.xs, justifyContent: 'center' },
  box: {
    width: 44,
    height: 52,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: shape.radius,
    textAlign: 'center',
    fontSize: typeTokens.size.lg,
    color: color.text,
  },
});
