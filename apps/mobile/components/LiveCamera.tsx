import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { color, shape, space, type as typeTokens } from '@haven/ui';
import { Button } from './Button.js';

/**
 * SDD §13.5 `LiveCamera` ("web and native implementations behind one interface; no
 * gallery"). This is the web implementation — `navigator.mediaDevices.getUserMedia`,
 * never a file input (SDD §9.4/D4, §13.4 G-05/G-10: "No gallery"). The native
 * (`expo-camera`) implementation is `LiveCamera.native.tsx`.
 *
 * Announces "Camera open" for screen readers on mount (SDD §13.7).
 */
const SHUTTER_DELAY_MS = 1_000;
const CAPTURE_SIZE = 720;

export type LiveCameraState = 'idle' | 'opening' | 'open' | 'denied' | 'captured';

export interface LiveCameraProps {
  guideText: string;
  onCapture: (dataUrl: string) => void;
  onPermissionDenied: () => void;
  /** `environment` (rear) for the hostel ID card photo (R-03); `user` for selfies. */
  facing?: 'user' | 'environment';
}

export function LiveCamera({
  guideText,
  onCapture,
  onPermissionDenied,
  facing = 'user',
}: LiveCameraProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<LiveCameraState>('idle');
  const [capturedUrl, setCapturedUrl] = useState<string | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // SDD §9.4: "shutter enabled only after the stream has produced frames for 1 s" — so
  // a quick tap can never capture a blank frame.
  const attach = useCallback((stream: MediaStream) => {
    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    const onPlaying = () => {
      video.removeEventListener('playing', onPlaying);
      setTimeout(() => {
        if (streamRef.current === stream) setState('open');
      }, SHUTTER_DELAY_MS);
    };
    video.addEventListener('playing', onPlaying);
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let cancelled = false;
    setState('opening');
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: facing }, audio: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        attach(stream);
      })
      .catch(() => {
        if (!cancelled) {
          setState('denied');
          onPermissionDenied();
        }
      });
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  function takePhoto() {
    const video = videoRef.current;
    if (!video || Platform.OS !== 'web') return;
    // SDD §9.4: "Capture a centred square to a 720×720 canvas; canvas.toBlob(cb,
    // 'image/jpeg', 0.8)".
    const side = Math.min(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = CAPTURE_SIZE;
    canvas.height = CAPTURE_SIZE;
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(
      video,
      (video.videoWidth - side) / 2,
      (video.videoHeight - side) / 2,
      side,
      side,
      0,
      0,
      CAPTURE_SIZE,
      CAPTURE_SIZE,
    );
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    setCapturedUrl(dataUrl);
    setState('captured');
    stop();
  }

  function retake() {
    setCapturedUrl(null);
    setState('opening');
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: facing }, audio: false })
      .then((stream) => attach(stream))
      .catch(() => {
        setState('denied');
        onPermissionDenied();
      });
  }

  if (Platform.OS !== 'web') {
    return (
      <View style={styles.frame}>
        <Text style={styles.guide}>
          Camera capture is only available on the web app in this milestone.
        </Text>
      </View>
    );
  }

  return (
    <View>
      <Text accessibilityLiveRegion="polite" style={styles.srOnly}>
        {state === 'open' ? 'Camera open' : ''}
      </Text>
      <View style={styles.frame}>
        {state === 'captured' && capturedUrl ? (
          createElement('img', {
            src: capturedUrl,
            style: styles.media,
            alt: 'Captured photo preview',
          })
        ) : (
          <>
            {createElement('video', {
              ref: videoRef,
              autoPlay: true,
              playsInline: true,
              muted: true,
              style: styles.media,
            })}
            {facing === 'user' ? (
              <View
                style={styles.ovalGuide}
                accessibilityElementsHidden
                importantForAccessibility="no"
              />
            ) : null}
          </>
        )}
      </View>
      {state !== 'captured' && <Text style={styles.guide}>{guideText}</Text>}
      <View style={styles.actions}>
        {state === 'captured' ? (
          <>
            <Button label="Retake" variant="secondary" onPress={retake} fullWidth={false} />
            <Button
              label="Use photo"
              fullWidth={false}
              onPress={() => {
                if (capturedUrl) onCapture(capturedUrl);
              }}
            />
          </>
        ) : (
          <Button
            label="Take photo"
            onPress={takePhoto}
            disabled={state !== 'open'}
            loading={state === 'opening'}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    maxWidth: 400,
    maxHeight: 320,
    aspectRatio: 3 / 4,
    alignSelf: 'center',
    borderRadius: shape.radius,
    backgroundColor: '#000',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  media: { width: '100%', height: '100%', objectFit: 'cover' },
  ovalGuide: {
    position: 'absolute',
    width: '60%',
    height: '75%',
    borderRadius: 999,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.8)',
  },
  guide: {
    fontSize: typeTokens.size.sm,
    color: color.textMuted,
    textAlign: 'center',
    marginTop: space.xs,
  },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  srOnly: { position: 'absolute', width: 1, height: 1, overflow: 'hidden' },
});
