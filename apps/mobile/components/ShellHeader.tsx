import type { ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, space, touchTarget, type as typeTokens } from '@haven/ui';

/**
 * The one header every shell uses (DEC-032): "HAVEN · <role>", an optional Back, and the
 * shell's own controls on the right. Back goes to the previous screen when there is one
 * in this tab's history, otherwise to `backTo`. An installed web app has no browser Back
 * button, so screens below a shell's main pages need their own.
 */
export function ShellHeader({
  role,
  backTo,
  right,
}: {
  /** "Guest", "Resident", "Warden", "Admin", "Office"; omitted on sign-in screens. */
  role?: string;
  /** Show Back, falling back to this path when there's no history (e.g. a shared link). */
  backTo?: string | null;
  right?: ReactNode;
}) {
  const router = useRouter();
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else if (backTo) router.replace(backTo as never);
  };
  return (
    <View style={styles.header} accessibilityRole="header">
      <View style={styles.left}>
        {backTo ? (
          <Pressable
            onPress={goBack}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={styles.back}
          >
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
        ) : null}
        <Text style={styles.logo} numberOfLines={1}>
          {role ? `HAVEN · ${role}` : 'HAVEN'}
        </Text>
      </View>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    minHeight: 56,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
    backgroundColor: color.bg,
  },
  left: { flexDirection: 'row', alignItems: 'center', gap: space.xs, flexShrink: 1 },
  back: {
    minHeight: touchTarget,
    minWidth: touchTarget,
    justifyContent: 'center',
    paddingRight: space.xs,
  },
  backText: {
    fontSize: typeTokens.size.body,
    color: color.primary,
    fontWeight: typeTokens.weight.semibold,
  },
  logo: {
    fontSize: typeTokens.size.md,
    fontWeight: typeTokens.weight.semibold,
    color: color.primary,
    flexShrink: 1,
  },
  right: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
});
