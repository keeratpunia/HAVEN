import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import { Button } from './Button.js';

/**
 * SDD §13.5 `ConfirmSheet` — "bottom sheet for destructive actions with reason field".
 */
export function ConfirmSheet({
  visible,
  title,
  body,
  confirmLabel,
  reasonLabel,
  reasonRequired = false,
  onConfirm,
  onCancel,
  loading,
}: {
  visible: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  reasonLabel?: string;
  reasonRequired?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  loading?: boolean;
}) {
  const [reason, setReason] = useState('');
  // Each opening starts empty, so a reason typed for one action never carries over.
  useEffect(() => {
    if (visible) setReason('');
  }, [visible]);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel} accessibilityLabel="Close" />
      <View style={styles.sheet} accessibilityViewIsModal>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        {body ? <Text style={styles.body}>{body}</Text> : null}
        {reasonLabel ? (
          <View>
            <Text style={styles.label} nativeID="reason-label">
              {reasonLabel}
            </Text>
            <TextInput
              value={reason}
              onChangeText={setReason}
              style={styles.input}
              accessibilityLabelledBy="reason-label"
              accessibilityLabel={reasonLabel}
              maxLength={300}
              multiline
            />
          </View>
        ) : null}
        <View style={styles.actions}>
          <Button label="Back" variant="secondary" fullWidth={false} onPress={onCancel} />
          <Button
            label={confirmLabel}
            variant="danger"
            fullWidth={false}
            loading={loading}
            disabled={reasonRequired && !reason.trim()}
            onPress={() => onConfirm(reason.trim())}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.4)' },
  sheet: {
    backgroundColor: color.bg,
    borderTopLeftRadius: shape.radius,
    borderTopRightRadius: shape.radius,
    padding: space.md,
    gap: space.sm,
  },
  title: {
    fontSize: typeTokens.size.md,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  body: { fontSize: typeTokens.size.body, color: color.textMuted },
  label: { fontSize: typeTokens.size.sm, color: color.textMuted, marginBottom: space.xxs },
  input: {
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: shape.radius,
    padding: space.sm,
    minHeight: 72,
    fontSize: typeTokens.size.body,
    color: color.text,
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
});
