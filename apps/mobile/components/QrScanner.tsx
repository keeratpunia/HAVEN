import { createElement, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { color, shape, space, type as typeTokens } from '@haven/ui';

/**
 * SDD §13.5 `QrScanner`, web implementation (`@zxing/browser`); the native one is
 * `QrScanner.native.tsx` (expo-camera). Used by R-12 to read the gate QR. Calls
 * `onScan` once with the decoded text.
 */
export interface QrScannerProps {
  onScan: (text: string) => void;
  onPermissionDenied: () => void;
}

export function QrScanner({ onScan, onPermissionDenied }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<'opening' | 'scanning' | 'denied'>('opening');
  const doneRef = useRef(false);

  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const { BrowserQRCodeReader } = await import('@zxing/browser');
      if (cancelled || !videoRef.current) return;
      const reader = new BrowserQRCodeReader();
      try {
        // The first frame can decode before decodeFromConstraints resolves (a sharp QR
        // in good light), so the callback must not touch `controls` directly: it stops
        // the camera through `stop`, or right after the promise resolves.
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: 'environment' }, audio: false },
          videoRef.current,
          (result) => {
            if (result && !doneRef.current) {
              doneRef.current = true;
              stop?.();
              onScan(result.getText());
            }
          },
        );
        stop = () => controls.stop();
        if (cancelled || doneRef.current) controls.stop();
        else setState('scanning');
      } catch {
        if (!cancelled) {
          setState('denied');
          onPermissionDenied();
        }
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  return (
    <View>
      <Text accessibilityLiveRegion="polite" style={styles.srOnly}>
        {state === 'scanning' ? 'Camera open' : ''}
      </Text>
      <View style={styles.frame}>
        {createElement('video', {
          ref: videoRef,
          autoPlay: true,
          playsInline: true,
          muted: true,
          style: { width: '100%', height: '100%', objectFit: 'cover' },
        })}
      </View>
      <Text style={styles.guide}>Point the camera at the QR on the gate screen.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    maxWidth: 400,
    aspectRatio: 1,
    alignSelf: 'center',
    borderRadius: shape.radius,
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  guide: {
    fontSize: typeTokens.size.sm,
    color: color.textMuted,
    textAlign: 'center',
    marginTop: space.xs,
  },
  srOnly: { position: 'absolute', width: 1, height: 1, overflow: 'hidden' },
});
