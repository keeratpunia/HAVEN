import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { formatTime12h, type EmergencyRowDTO } from '@haven/shared';
import { color, space, type as typeTokens } from '@haven/ui';
import { adminCsv, staffApi } from '../../api/client.js';
import { useStaff } from '../../lib/staff-context.js';
import { useLiveUpdates } from '../../lib/live.js';
import { printPage, saveCsv, shareText } from '../../lib/download.js';
import { Button } from '../../components/Button.js';
import { ErrorText, StaffScreen } from '../../components/staff/StaffUi.js';

/**
 * W-03 Emergency roll call (FR-51): "Count + plain list sorted by room; large text —
 * Export / Share". Every load and export is an audited read (SDD §16.4).
 */
export default function Emergency() {
  const { hostel } = useStaff();
  const [items, setItems] = useState<EmergencyRowDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hostelId = hostel?.id ?? null;

  const load = useCallback(async () => {
    if (!hostelId) return;
    try {
      setItems((await staffApi.emergency(hostelId)).items);
      setError(null);
    } catch {
      setError("Couldn't load the roll call. Retrying.");
    }
  }, [hostelId]);
  useEffect(() => {
    void load();
  }, [load]);
  const live = useLiveUpdates(hostelId, () => void load());

  const asText = () =>
    [
      `${hostel?.code ?? ''} roll call — ${items?.length ?? 0} inside`,
      ...(items ?? []).map(
        (i) =>
          `Room ${i.room}: ${i.guestName} (host ${i.hostName}, ${i.zone}, since ${formatTime12h(i.since)})`,
      ),
    ].join('\n');

  return (
    <StaffScreen
      title="Emergency roll call"
      live={live}
      actions={
        <>
          <Button
            label="Export CSV"
            fullWidth={false}
            onPress={async () =>
              hostelId &&
              saveCsv('roll-call.csv', await adminCsv(hostelId, '/emergency?format=csv'))
            }
          />
          <Button
            label="Share"
            variant="secondary"
            fullWidth={false}
            onPress={() => void shareText('Roll call', asText())}
          />
          <Button label="Print" variant="secondary" fullWidth={false} onPress={printPage} />
        </>
      }
    >
      <ErrorText>{error}</ErrorText>
      {items === null ? (
        <ActivityIndicator accessibilityLabel="Loading" />
      ) : (
        <>
          <Text style={styles.count} accessibilityRole="header">
            {items.length} {items.length === 1 ? 'guest' : 'guests'} inside
          </Text>
          {items.map((i) => (
            <View
              key={i.visitId}
              style={styles.row}
              accessibilityLabel={`Room ${i.room}, ${i.guestName}, host ${i.hostName}`}
            >
              <Text style={styles.room}>{i.room}</Text>
              <View style={styles.text}>
                <Text style={styles.name}>{i.guestName}</Text>
                <Text style={styles.sub}>
                  Host {i.hostName} · {i.zone === 'visitors_room' ? "Visitors' Room" : i.zone} ·
                  since {formatTime12h(i.since)}
                </Text>
              </View>
            </View>
          ))}
        </>
      )}
    </StaffScreen>
  );
}

const styles = StyleSheet.create({
  count: {
    fontSize: typeTokens.size.xl,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  row: {
    flexDirection: 'row',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
  },
  room: {
    width: 72,
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
  },
  text: { flex: 1 },
  name: { fontSize: typeTokens.size.lg, color: color.text },
  sub: { fontSize: typeTokens.size.body, color: color.textMuted },
});
