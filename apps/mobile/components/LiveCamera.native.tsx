import { useRef, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import { Button } from './Button.js';
import type { LiveCameraProps } from './LiveCamera.js';

/**
 * SDD §13.5 `LiveCamera`, native implementation (§9.4: "expo-camera CameraView with
 * facing="front"; takePictureAsync({ quality: 0.8 })"). Live camera only — there is
 * no gallery path anywhere (D4). The server resizes to 720 px and strips EXIF (§9.4),
 * so the client sends the capture as taken.
 */
export function LiveCamera({
  guideText,
  onCapture,
  onPermissionDenied,
  facing = 'user',
}: LiveCameraProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
  const [ready, setReady] = useState(false);
  const [captured, setCaptured] = useState<string | null>(null);

  if (!permission) return <View style={styles.frame} />;
  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.guide}>HAVEN needs the camera to take a live photo.</Text>
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

  async function takePhoto() {
    const photo = await cameraRef.current?.takePictureAsync({ quality: 0.8, base64: true });
    if (photo?.base64) setCaptured(`data:image/jpeg;base64,${photo.base64}`);
  }

  return (
    <View>
      <Text accessibilityLiveRegion="polite" style={styles.srOnly}>
        {ready && !captured ? 'Camera open' : ''}
      </Text>
      <View style={styles.frame}>
        {captured ? (
          <Image
            source={{ uri: captured }}
            style={styles.media}
            accessibilityLabel="Captured photo preview"
          />
        ) : (
          <CameraView
            ref={cameraRef}
            style={styles.media}
            facing={facing === 'user' ? 'front' : 'back'}
            onCameraReady={() => setReady(true)}
          />
        )}
      </View>
      {!captured ? <Text style={styles.guide}>{guideText}</Text> : null}
      <View style={styles.actions}>
        {captured ? (
          <>
            <Button
              label="Retake"
              variant="secondary"
              fullWidth={false}
              onPress={() => setCaptured(null)}
            />
            <Button label="Use photo" fullWidth={false} onPress={() => onCapture(captured)} />
          </>
        ) : (
          <Button label="Take photo" onPress={takePhoto} disabled={!ready} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    aspectRatio: 3 / 4,
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
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  srOnly: { position: 'absolute', width: 1, height: 1, overflow: 'hidden' },
});
