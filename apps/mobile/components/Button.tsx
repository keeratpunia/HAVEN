import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { color, primaryButtonHeight, shape, touchTarget, type as typeTokens } from '@haven/ui';

/**
 * SDD §13.1 principle 1: "One primary action per screen. It's the big button at the
 * bottom, in thumb reach." §13.2: "Primary buttons full width, 52 high." Touch targets
 * >= 48x48dp for every variant, including secondary/ghost.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  accessibilityHint?: string;
  /** Overrides the accessible name when the visible label repeats across a list (e.g.
   * "Approve" on every card) and a screen reader needs to disambiguate which row. */
  accessibilityLabel?: string;
  fullWidth?: boolean;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  accessibilityHint,
  accessibilityLabel,
  fullWidth = true,
}: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={isDisabled ? undefined : onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      style={({ pressed }) => [
        styles.base,
        variantStyles[variant],
        fullWidth && styles.fullWidth,
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'ghost' ? color.primary : color.onPrimary} />
      ) : (
        <Text style={[styles.label, textStyles[variant]]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: primaryButtonHeight,
    minWidth: touchTarget,
    borderRadius: shape.radius,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  fullWidth: { width: '100%' },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
  label: { fontSize: typeTokens.size.body, fontWeight: typeTokens.weight.semibold },
});

const variantStyles = StyleSheet.create({
  primary: { backgroundColor: color.primary },
  secondary: { backgroundColor: color.surface, borderWidth: 1, borderColor: color.border },
  danger: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: color.danger },
  ghost: { backgroundColor: 'transparent' },
});

const textStyles = StyleSheet.create({
  primary: { color: color.onPrimary },
  secondary: { color: color.text },
  danger: { color: color.danger },
  ghost: { color: color.primary },
});
