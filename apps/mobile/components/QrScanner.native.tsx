import { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import { Button } from './Button.js';
import type { QrScannerProps } from './QrScanner.js';

/** SDD §13.5 `QrScanner`, native (`expo-camera` barcode scanning). */
export function QrScanner({ onScan, onPermissionDenied }: QrScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const doneRef = useRef(false);

  if (!permission) return <View style={styles.frame} />;
  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.guide}>HAVEN needs the camera to scan the gate QR.</Text>
        <Button
          label="Allow camera"
          onPress={async () => {
            const result = await requestPermission();
            if (!result.granted) onPermissionDenied();
          }}
        />
      </View>
    );
  }

  return (
    <View>
      <View style={styles.frame}>
        <CameraView
          style={styles.media}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (doneRef.current) return;
            doneRef.current = true;
            onScan(data);
          }}
        />
      </View>
      <Text style={styles.guide}>Point the camera at the QR on the gate screen.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: shape.radius,
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  media: { flex: 1 },
  center: { gap: space.sm, padding: space.md },
  guide: {
    fontSize: typeTokens.size.sm,
    color: color.textMuted,
    textAlign: 'center',
    marginTop: space.xs,
  },
});
