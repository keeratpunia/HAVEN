import { StyleSheet, Text, TextInput, View } from 'react-native';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import { IS_TEST_VERSION } from '../lib/app-env.js';

/** SDD G-02: "Phone field with +91 prefix." */
export function PhoneInput({
  value,
  onChange,
  hint,
}: {
  value: string;
  onChange: (digits: string) => void;
  hint?: string;
}) {
  return (
    <View>
      <Text style={styles.label} nativeID="phone-label">
        Phone number
      </Text>
      <View style={styles.row}>
        <Text style={styles.prefix}>+91</Text>
        <TextInput
          value={value}
          onChangeText={(text) => onChange(text.replace(/[^0-9]/g, '').slice(0, 10))}
          keyboardType="number-pad"
          inputMode="numeric"
          autoComplete="tel-national"
          maxLength={10}
          placeholder="98765 43210"
          placeholderTextColor={color.textMuted}
          style={styles.input}
          accessibilityLabel="Phone number"
          accessibilityLabelledBy="phone-label"
        />
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {IS_TEST_VERSION ? (
        // DEC-028: the test version takes only the SDD §9.5 test numbers.
        <Text style={styles.hint}>
          Test version: use a test number, 99999 00001 to 99999 00009. The code is 123456.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: typeTokens.size.sm, color: color.textMuted, marginBottom: space.xxs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: shape.radius,
    paddingHorizontal: space.sm,
    minHeight: 48,
  },
  prefix: { fontSize: typeTokens.size.body, color: color.text, marginRight: space.xs },
  input: { flex: 1, fontSize: typeTokens.size.body, color: color.text, minHeight: 48 },
  hint: { fontSize: typeTokens.size.sm, color: color.textMuted, marginTop: space.xxs },
});
