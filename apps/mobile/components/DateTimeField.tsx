import { createElement } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { color, shape, space, type as typeTokens } from '@haven/ui';

/**
 * A labelled date ("YYYY-MM-DD") or time ("HH:MM") field (SDD §14 forms: "labels above
 * fields ... rule hints under time fields"). On the web this is the browser's own
 * accessible date/time picker; on Android a plain text field in the same format.
 */
export function DateTimeField({
  kind,
  label,
  value,
  onChange,
  hint,
  min,
}: {
  kind: 'date' | 'time';
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  min?: string;
}) {
  const id = `${kind}-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <View style={styles.wrap}>
      <Text style={styles.label} nativeID={`${id}-label`}>
        {label}
      </Text>
      {Platform.OS === 'web' ? (
        createElement('input', {
          type: kind,
          value,
          min,
          'aria-label': label,
          onChange: (e: { target: { value: string } }) => onChange(e.target.value),
          style: webInputStyle,
        })
      ) : (
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={kind === 'date' ? 'YYYY-MM-DD' : 'HH:MM'}
          placeholderTextColor={color.textMuted}
          style={styles.input}
          accessibilityLabel={label}
          accessibilityLabelledBy={`${id}-label`}
        />
      )}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

const webInputStyle = {
  minHeight: 48,
  border: `1px solid ${color.border}`,
  borderRadius: shape.radius,
  padding: `0 ${space.sm}px`,
  fontSize: typeTokens.size.body,
  color: color.text,
  fontFamily: 'inherit',
  background: color.bg,
};

const styles = StyleSheet.create({
  wrap: { flex: 1, gap: space.xxs },
  label: { fontSize: typeTokens.size.sm, color: color.textMuted },
  input: {
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: shape.radius,
    paddingHorizontal: space.sm,
    minHeight: 48,
    fontSize: typeTokens.size.body,
    color: color.text,
  },
  hint: { fontSize: typeTokens.size.sm, color: color.textMuted },
});
