import { createElement, useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import QRCode from 'qrcode';
import { color, space, type as typeTokens } from '@haven/ui';
import * as api from '../../services/api-client.js';
import {
  clearGateStorage,
  readGateStorage,
  updateGateOffsetAndSecret,
  type GateStorageState,
} from '../../lib/gateStorage.js';
import { currentStep, decodeBase64Secret, generateGateToken } from '../../lib/gateToken.js';
import {
  countdownFraction,
  gateQrPayload,
  heartbeatDelayMs,
  keepScreenAwake,
  msIntoStep,
} from '../../lib/gate-display.js';

const QR_RENDER_INTERVAL_MS = 250;

const WEB_BASE_URL =
  (typeof window !== 'undefined' && window.location?.origin) || 'http://localhost:8081';

/**
 * D-02 QR display (SDD §9.2): draws a new QR every time the 10s step changes, a
 * countdown bar, hostel/gate name, and a fixed instruction. Works offline (the token
 * is generated locally) with a small grey "Offline" badge; heartbeats every 60s with
 * backoff; never shows any personal data, ever.
 */
export default function GateDisplay() {
  const router = useRouter();
  const [state, setState] = useState<GateStorageState | null>(null);
  const [, setStep] = useState<bigint | null>(null);
  const [msIntoStepState, setMsIntoStep] = useState(0);
  const [online, setOnline] = useState(true);
  const [revoked, setRevoked] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const heartbeatFailuresRef = useRef(0);

  useEffect(() => {
    const stored = readGateStorage();
    if (!stored) {
      router.replace('/gate/pair');
      return;
    }
    setState(stored);
  }, [router]);

  // Render loop: every 250ms, recompute the step; redraw the QR only when it changes.
  useEffect(() => {
    if (!state) return;
    const secretBytes = decodeBase64Secret(state.secret);
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      const nowStep = currentStep(state.offsetMs);
      const elapsed = msIntoStep(Date.now(), state.offsetMs);
      setMsIntoStep(elapsed);
      setStep((prev) => {
        if (prev === nowStep) return prev;
        void drawToken(nowStep);
        return nowStep;
      });
    };

    const drawToken = async (forStep: bigint) => {
      const token = await generateGateToken({
        secret: secretBytes,
        gateCode: state.code,
        step: forStep,
      });
      const qrPayload = gateQrPayload(WEB_BASE_URL, token);
      if (canvasRef.current) {
        await QRCode.toCanvas(canvasRef.current, qrPayload, {
          errorCorrectionLevel: 'M',
          margin: 4,
          width: Math.min(window.innerWidth * 0.8, window.innerHeight * 0.6),
          color: { dark: '#000000', light: '#FFFFFF' },
        });
      }
    };

    void tick();
    const interval = setInterval(tick, QR_RENDER_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [state]);

  // Wake lock: on load and whenever the tab becomes visible again (SDD §9.2).
  useEffect(() => {
    return keepScreenAwake(navigator as Parameters<typeof keepScreenAwake>[0], document);
  }, []);

  // Heartbeat every 60s, with backoff (5s/15s/60s) while failing (SDD §9.2).
  useEffect(() => {
    if (!state) return;
    const deviceToken = state.deviceToken;
    let timeoutId: ReturnType<typeof setTimeout>;
    let cancelled = false;

    async function beat() {
      try {
        const result = await api.gateDeviceHeartbeat(deviceToken, new Date().toISOString());
        if (cancelled) return;
        if (result.revoked) {
          clearGateStorage();
          setRevoked(true);
          return;
        }
        heartbeatFailuresRef.current = 0;
        setOnline(true);
        const serverTime = new Date(result.serverTime).getTime();
        const offsetMs = serverTime - Date.now();
        updateGateOffsetAndSecret(offsetMs, result.secret);
        setState((prev) =>
          prev ? { ...prev, offsetMs, secretVersion: result.secretVersion } : prev,
        );
        schedule(heartbeatDelayMs(0));
      } catch {
        if (cancelled) return;
        setOnline(false);
        heartbeatFailuresRef.current += 1;
        schedule(heartbeatDelayMs(heartbeatFailuresRef.current));
      }
    }

    function schedule(delay: number) {
      if (cancelled) return;
      timeoutId = setTimeout(() => void beat(), delay);
    }

    void beat();
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [state?.deviceToken]);

  function enterFullscreen() {
    document.documentElement.requestFullscreen?.().then(() => setFullscreen(true));
  }

  if (revoked) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>This device was removed by the warden</Text>
        <Pressable
          onPress={() => router.replace('/gate/pair')}
          accessibilityRole="button"
          accessibilityLabel="Pair again"
          style={styles.pairAgainButton}
        >
          <Text style={styles.pairAgainText}>Pair again</Text>
        </Pressable>
      </View>
    );
  }

  if (!state) {
    return <View style={styles.container} />;
  }

  const countdown = countdownFraction(msIntoStepState);

  return (
    <Pressable style={styles.container} onPress={enterFullscreen} accessibilityRole="none">
      <Text style={styles.hostelName}>{state.hostelName}</Text>
      <Text style={styles.gateName}>{state.gateName}</Text>

      <View style={styles.qrWrap}>{createElement('canvas', { ref: canvasRef })}</View>

      <View style={styles.countdownTrack}>
        <View style={[styles.countdownFill, { width: `${countdown * 100}%` }]} />
      </View>

      <Text style={styles.instruction}>Guests: scan with your phone camera to enter or leave</Text>

      {!online ? (
        <View style={styles.offlineBadge}>
          <Text style={styles.offlineText}>Offline</Text>
        </View>
      ) : null}

      {!fullscreen ? <Text style={styles.fullscreenHint}>Tap for full screen</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Gate display always uses light theme, regardless of device setting (SDD §13.2).
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    gap: space.md,
    padding: space.lg,
  },
  hostelName: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: '#0F172A',
  },
  gateName: { fontSize: typeTokens.size.body, color: '#475569' },
  qrWrap: { alignItems: 'center', justifyContent: 'center' },
  countdownTrack: {
    width: 240,
    height: 8,
    borderRadius: 999,
    backgroundColor: '#E2E8F0',
    overflow: 'hidden',
  },
  countdownFill: { height: '100%', backgroundColor: color.primary },
  instruction: { fontSize: typeTokens.size.body, color: '#0F172A', textAlign: 'center' },
  offlineBadge: {
    position: 'absolute',
    top: space.md,
    right: space.md,
    backgroundColor: '#E2E8F0',
    borderRadius: 999,
    paddingHorizontal: space.sm,
    paddingVertical: space.xxs,
  },
  offlineText: { fontSize: typeTokens.size.xs, color: '#475569' },
  fullscreenHint: { fontSize: typeTokens.size.sm, color: '#94A3B8' },
  title: {
    fontSize: typeTokens.size.lg,
    fontWeight: typeTokens.weight.semibold,
    color: color.text,
    textAlign: 'center',
  },
  pairAgainButton: {
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: space.md,
    backgroundColor: color.primary,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pairAgainText: {
    color: color.onPrimary,
    fontSize: typeTokens.size.body,
    fontWeight: typeTokens.weight.semibold,
  },
});
