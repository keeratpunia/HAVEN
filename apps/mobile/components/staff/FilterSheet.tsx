import { useState, type ReactNode } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import { Button } from '../Button.js';

/** Below this width the filters move into a bottom sheet (DEC-026 mobile-first pass). */
export const FILTER_SHEET_BELOW = 600;

/**
 * Search filters for the warden's list screens. On a laptop they sit above the list as
 * before; on a phone only `inline` (the main search box) stays on screen, and the rest
 * open in a bottom sheet from a "Filters" button, so the results are visible straight
 * away instead of below a screenful of fields.
 */
export function FilterSheet({
  inline,
  children,
  activeCount,
  applyLabel,
  onApply,
}: {
  /** Always on screen (e.g. the free-text search). */
  inline?: ReactNode;
  /** The filters that move into the sheet on a phone. */
  children: ReactNode;
  activeCount: number;
  applyLabel: string;
  onApply: () => void;
}) {
  const { width } = useWindowDimensions();
  const [open, setOpen] = useState(false);

  if (width >= FILTER_SHEET_BELOW) {
    return (
      <>
        {inline}
        {children}
        <Button label={applyLabel} fullWidth={false} onPress={onApply} />
      </>
    );
  }

  const filtersLabel = activeCount > 0 ? `Filters (${activeCount})` : 'Filters';
  return (
    <>
      {inline}
      <View style={styles.row}>
        <View style={styles.half}>
          <Button
            label={filtersLabel}
            variant="secondary"
            onPress={() => setOpen(true)}
            accessibilityLabel={`${filtersLabel}, opens the filter options`}
          />
        </View>
        <View style={styles.half}>
          <Button label={applyLabel} onPress={onApply} />
        </View>
      </View>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={styles.backdrop}
          onPress={() => setOpen(false)}
          accessibilityLabel="Close filters"
        />
        <View style={styles.sheet} accessibilityViewIsModal>
          <Text style={styles.title} accessibilityRole="header">
            Filters
          </Text>
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          <View style={styles.row}>
            <View style={styles.half}>
              <Button label="Close" variant="secondary" onPress={() => setOpen(false)} />
            </View>
            <View style={styles.half}>
              <Button
                label="Show results"
                onPress={() => {
                  setOpen(false);
                  onApply();
                }}
              />
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm },
  half: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.4)' },
  sheet: {
    backgroundColor: color.bg,
    borderTopLeftRadius: shape.radius,
    borderTopRightRadius: shape.radius,
    padding: space.md,
    // Clears the iPhone home indicator in an installed web app.
    paddingBottom: space.lg,
    gap: space.md,
    maxHeight: '85%',
  },
  title: {
    fontSize: typeTokens.size.md,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  body: { gap: space.md },
});
