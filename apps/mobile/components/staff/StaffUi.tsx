import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { color, shape, space, touchTarget, type as typeTokens } from '@haven/ui';
import { useStaff } from '../../lib/staff-context.js';

/**
 * Building blocks for the warden and office screens (SDD §13.4 W-01..W-12, O-01; §14
 * "the warden's screens optimise for scanning lists quickly"). Tokens only (§13.2).
 */

export function StaffScreen({
  title,
  live,
  actions,
  children,
  scroll = true,
}: {
  title: string;
  live?: 'live' | 'polling';
  actions?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
}) {
  const body = (
    <View style={styles.inner}>
      <View style={styles.titleRow}>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        {live ? <LiveBadge status={live} /> : null}
      </View>
      {actions ? <View style={styles.actions}>{actions}</View> : null}
      {children}
    </View>
  );
  return scroll ? (
    <ScrollView contentContainerStyle={styles.scroll}>{body}</ScrollView>
  ) : (
    <View style={styles.scroll}>{body}</View>
  );
}

function LiveBadge({ status }: { status: 'live' | 'polling' }) {
  return (
    <Text
      style={[styles.badge, status === 'live' ? styles.badgeLive : styles.badgePoll]}
      accessibilityLabel={status === 'live' ? 'Live updates on' : 'Updating every 15 seconds'}
    >
      {status === 'live' ? '● Live' : '◌ Updating every 15 s'}
    </Text>
  );
}

export function HostelPicker() {
  const { hostels, hostel, choose } = useStaff();
  if (!hostels || hostels.length < 2)
    return hostel ? (
      <Text style={styles.hostelName}>
        {hostel.code} · {hostel.name}
      </Text>
    ) : null;
  return (
    <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="Hostel">
      {hostels.map((h) => (
        <Pressable
          key={h.id}
          onPress={() => choose(h.id)}
          accessibilityRole="radio"
          accessibilityState={{ checked: h.id === hostel?.id }}
          aria-checked={h.id === hostel?.id}
          style={[styles.chip, h.id === hostel?.id && styles.chipOn]}
        >
          <Text style={[styles.chipText, h.id === hostel?.id && styles.chipTextOn]}>{h.code}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Tile({
  label,
  value,
  tone,
  onPress,
}: {
  label: string;
  value: number | string;
  tone?: 'warning' | 'danger';
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      style={[
        styles.tile,
        tone === 'warning' && styles.tileWarn,
        tone === 'danger' && styles.tileDanger,
      ]}
    >
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </Pressable>
  );
}

export function Card({
  children,
  onPress,
  label,
}: {
  children: ReactNode;
  onPress?: () => void;
  label?: string;
}) {
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={styles.card}
      >
        {children}
      </Pressable>
    );
  }
  return <View style={styles.card}>{children}</View>;
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  keyboardType,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'email-address';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={color.textMuted}
        keyboardType={keyboardType}
        autoCapitalize="none"
        style={styles.input}
        accessibilityLabel={label}
      />
    </View>
  );
}

export function Chips<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <View style={styles.chips} accessibilityRole="tablist" accessibilityLabel={label}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          onPress={() => onChange(o.value)}
          accessibilityRole="tab"
          accessibilityState={{ selected: o.value === value }}
          aria-selected={o.value === value}
          accessibilityLabel={o.label}
          style={[styles.chip, o.value === value && styles.chipOn]}
        >
          <Text style={[styles.chipText, o.value === value && styles.chipTextOn]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={styles.muted}>{children}</Text>;
}

export function Strong({ children }: { children: ReactNode }) {
  return <Text style={styles.strong}>{children}</Text>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? (
    <Text style={styles.error} accessibilityRole="alert">
      {children}
    </Text>
  ) : null;
}

export function RedBanner({ children }: { children: ReactNode }) {
  return (
    <View style={styles.redBanner} accessibilityRole="alert">
      <Text style={styles.redBannerText}>{children}</Text>
    </View>
  );
}

export const staffStyles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' },
  grow: { flex: 1 },
  photo: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.border },
  big: { fontSize: typeTokens.size.md, color: color.text, fontWeight: typeTokens.weight.semibold },
});

const styles = StyleSheet.create({
  scroll: { padding: space.md, flexGrow: 1 },
  inner: { gap: space.md, width: '100%', maxWidth: 1100, alignSelf: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
    flexShrink: 1,
  },
  actions: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  badge: {
    fontSize: typeTokens.size.xs,
    paddingHorizontal: space.xs,
    paddingVertical: space.xxs,
    borderRadius: shape.chipRadius,
  },
  badgeLive: { color: color.success, backgroundColor: '#DCFCE7' },
  badgePoll: { color: color.warning, backgroundColor: '#FEF3C7' },
  hostelName: { fontSize: typeTokens.size.sm, color: color.textMuted },
  chips: { flexDirection: 'row', gap: space.xs, flexWrap: 'wrap' },
  chip: {
    // SDD §13.2: touch targets >= 48 px (the phone audit found 40).
    minHeight: touchTarget,
    minWidth: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    borderRadius: shape.chipRadius,
    borderWidth: 1,
    borderColor: color.border,
  },
  chipOn: { backgroundColor: color.primary, borderColor: color.primary },
  chipText: { fontSize: typeTokens.size.sm, color: color.text },
  chipTextOn: { color: color.onPrimary, fontWeight: typeTokens.weight.semibold },
  tile: {
    flexGrow: 1,
    flexBasis: 150,
    minHeight: 88,
    padding: space.md,
    borderRadius: shape.radius,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    gap: space.xxs,
  },
  tileWarn: { borderColor: color.warning, backgroundColor: '#FFFBEB' },
  tileDanger: { borderColor: color.danger, backgroundColor: '#FEF2F2' },
  tileValue: {
    fontSize: typeTokens.size.xl,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  tileLabel: { fontSize: typeTokens.size.sm, color: color.textMuted },
  card: {
    backgroundColor: color.surface,
    borderRadius: shape.radius,
    padding: space.md,
    gap: space.xs,
    borderWidth: 1,
    borderColor: color.border,
  },
  field: { gap: space.xxs, flexGrow: 1, flexBasis: 200 },
  label: { fontSize: typeTokens.size.sm, color: color.textMuted },
  input: {
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: shape.radius,
    paddingHorizontal: space.sm,
    minHeight: 48,
    fontSize: typeTokens.size.body,
    color: color.text,
    backgroundColor: color.bg,
  },
  muted: { fontSize: typeTokens.size.sm, color: color.textMuted },
  strong: {
    fontSize: typeTokens.size.body,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  error: { fontSize: typeTokens.size.sm, color: color.danger },
  redBanner: { backgroundColor: '#FEE2E2', borderRadius: shape.radius, padding: space.md },
  redBannerText: {
    color: color.danger,
    fontWeight: typeTokens.weight.semibold,
    fontSize: typeTokens.size.body,
  },
});
