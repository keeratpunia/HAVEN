import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import QRCode from 'qrcode';
import { formatDateTime, type GateDTO } from '@haven/shared';
import { color, space, type as typeTokens } from '@haven/ui';
import * as api from '../../services/api-client.js';
import { staffApi } from '../../services/api-client.js';
import { useStaff } from '../../lib/staff-context.js';
import { useLiveUpdates } from '../../lib/live.js';
import { captureScanLocation } from '../../lib/useScanLocation.js';
import { Button } from '../../components/Button.js';
import { ConfirmSheet } from '../../components/ConfirmSheet.js';
import { averageGateFixes } from '../../lib/gate-location.js';
import { IS_TEST_VERSION } from '../../lib/app-env.js';
import {
  Card,
  ErrorText,
  Field,
  Muted,
  RedBanner,
  StaffScreen,
  Strong,
  staffStyles,
} from '../../components/staff/StaffUi.js';

/**
 * W-09 Gates (FR-56, FR-29, F8, E-14): "Gate card: location map, radius, devices
 * (online/offline, last seen) — Add device, Set location".
 */
const WEB_URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'http://localhost:8081';
const FIXES = 5;
const FIX_GAP_MS = 2000;

interface Capture {
  lat: number;
  lng: number;
  used: number;
  accuracy: number;
}

export default function Gates() {
  const { hostel, can } = useStaff();
  // DEC-028: the test version lets the admin move the gate to wherever the demo is.
  const canMoveForTest = IS_TEST_VERSION && can('super_admin');
  const [moving, setMoving] = useState<string | null>(null);
  const [gates, setGates] = useState<GateDTO[] | null>(null);
  const [pairing, setPairing] = useState<{
    gateId: string;
    code: string;
    expiresAt: string;
    qr: string | null;
  } | null>(null);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [capture, setCapture] = useState<(Capture & { gateId: string }) | null>(null);
  const [radius, setRadius] = useState('50');
  const [revoking, setRevoking] = useState<{ id: string; label: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const hostelId = hostel?.id ?? null;

  const load = useCallback(async () => {
    if (!hostelId) return;
    setGates((await staffApi.gates(hostelId)).items);
  }, [hostelId]);
  useEffect(() => {
    void load().catch(() => setMessage("Couldn't load gates."));
  }, [load]);
  const live = useLiveUpdates(hostelId, (e) => {
    if (!e || e.type === 'gate') void load();
  });

  async function addDevice(gateId: string) {
    if (!hostelId) return;
    try {
      const res = await staffApi.pairingCode(hostelId, gateId);
      const qr = await QRCode.toDataURL(
        `${WEB_URL.replace(/\/$/, '')}/gate/pair?code=${encodeURIComponent(res.code)}`,
        { margin: 1, width: 220 },
      ).catch(() => null);
      setPairing({ gateId, code: res.code, expiresAt: res.expiresAt, qr });
    } catch (err) {
      setMessage(err instanceof api.ApiError ? err.message : "Couldn't create a pairing code.");
    }
  }

  // F8 step 4: "takes 5 GPS fixes 2 s apart, discards any with accuracy > 30 m, averages the rest".
  async function captureLocation(gateId: string) {
    setCapturing(gateId);
    setMessage(null);
    const fixes: { lat: number; lng: number; accuracy: number }[] = [];
    for (let i = 0; i < FIXES; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, FIX_GAP_MS));
      const { location, locationError } = await captureScanLocation();
      if (locationError === 'mocked') {
        setCapturing(null);
        setMessage('Turn off fake location apps.');
        return;
      }
      if (location) fixes.push(location);
    }
    setCapturing(null);
    const avg = averageGateFixes(fixes);
    if (!avg) {
      setMessage('No accurate reading. Stand in the open at the gate and try again.');
      return;
    }
    setCapture({ gateId, ...avg });
  }

  async function moveGateHere(gateId: string) {
    if (!hostelId) return;
    setMoving(gateId);
    setMessage(null);
    try {
      const { location, locationError } = await captureScanLocation();
      if (locationError === 'mocked') {
        setMessage('Turn off fake location apps.');
        return;
      }
      if (!location) {
        setMessage("Couldn't get your location. Allow location for this site and try again.");
        return;
      }
      await staffApi.setGateTestLocation(hostelId, gateId, {
        lat: location.lat,
        lng: location.lng,
        accuracyM: location.accuracy,
      });
      setMessage(`Gate moved to your position (about ±${Math.round(location.accuracy)} m).`);
      await load();
    } catch (err) {
      setMessage(err instanceof api.ApiError ? err.message : "Couldn't move the gate.");
    } finally {
      setMoving(null);
    }
  }

  const radiusOk = /^\d+$/.test(radius) && Number(radius) >= 10 && Number(radius) <= 300;

  return (
    <StaffScreen title="Gates" live={live}>
      <ErrorText>{message}</ErrorText>
      {gates === null ? <ActivityIndicator accessibilityLabel="Loading gates" /> : null}
      {gates?.map((g) => (
        <Card key={g.id}>
          <Strong>
            {g.name} ({g.code})
          </Strong>
          {g.configured ? (
            <Muted>
              Location {g.lat?.toFixed(5)}, {g.lng?.toFixed(5)} · radius {g.radiusM} m · set{' '}
              {g.locationSetAt ? formatDateTime(g.locationSetAt) : ''}
            </Muted>
          ) : (
            <RedBanner>Set the gate location — nobody can check in until you do.</RedBanner>
          )}
          <Strong>Gate screens</Strong>
          {g.devices.length === 0 ? <Muted>None paired.</Muted> : null}
          {g.devices.map((d) => (
            <View key={d.id} style={staffStyles.row}>
              <Text style={[styles.status, d.online ? styles.online : styles.offline]}>
                {d.online ? '● Online' : '○ Offline'}
              </Text>
              <View style={staffStyles.grow}>
                <Text>{d.label}</Text>
                <Muted>
                  {d.lastSeenAt ? `Last seen ${formatDateTime(d.lastSeenAt)}` : 'Never seen'}
                </Muted>
              </View>
              <Button
                label="Remove"
                variant="danger"
                fullWidth={false}
                accessibilityLabel={`Remove ${d.label}`}
                onPress={() => setRevoking({ id: d.id, label: d.label })}
              />
            </View>
          ))}
          <View style={staffStyles.row}>
            <Button label="Add device" fullWidth={false} onPress={() => void addDevice(g.id)} />
            <Button
              label={capturing === g.id ? 'Capturing…' : 'Set location'}
              variant="secondary"
              fullWidth={false}
              loading={capturing === g.id}
              onPress={() => void captureLocation(g.id)}
            />
          </View>

          {canMoveForTest ? (
            <Button
              label="Set gate location to my current position"
              variant="secondary"
              loading={moving === g.id}
              accessibilityLabel="Test version: set gate location to my current position"
              onPress={() => void moveGateHere(g.id)}
            />
          ) : null}

          {pairing?.gateId === g.id ? (
            <View style={styles.pairing} accessibilityLabel={`Pairing code ${pairing.code}`}>
              <Text style={styles.code}>{pairing.code}</Text>
              <Muted>
                On the gate phone open {WEB_URL}/gate and enter this code. It expires{' '}
                {formatDateTime(pairing.expiresAt)}.
              </Muted>
              {pairing.qr ? (
                <Image
                  source={{ uri: pairing.qr }}
                  style={styles.qr}
                  accessibilityLabel="QR of the pairing link"
                />
              ) : null}
            </View>
          ) : null}

          {capture?.gateId === g.id ? (
            <View style={styles.pairing}>
              <Strong>
                {capture.lat.toFixed(6)}, {capture.lng.toFixed(6)}
              </Strong>
              <Muted>
                Average of {capture.used} reading(s), about ±{Math.round(capture.accuracy)} m.
              </Muted>
              <Field
                label="Radius in metres (10–300)"
                value={radius}
                onChange={setRadius}
                keyboardType="numeric"
              />
              <Button
                label="Confirm location"
                disabled={!radiusOk}
                onPress={async () => {
                  if (!hostelId) return;
                  try {
                    await staffApi.setGateLocation(hostelId, g.id, {
                      lat: capture.lat,
                      lng: capture.lng,
                      radiusM: Number(radius),
                      maxAccuracyM: g.maxAccuracyM,
                    });
                    setCapture(null);
                    setMessage('Gate location saved.');
                    await load();
                  } catch (err) {
                    setMessage(err instanceof api.ApiError ? err.message : "Couldn't save.");
                  }
                }}
              />
            </View>
          ) : null}
        </Card>
      ))}
      <ConfirmSheet
        visible={revoking !== null}
        title={`Remove ${revoking?.label}?`}
        body="Its link stops working and the gate code changes for every other screen."
        confirmLabel="Remove device"
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking || !hostelId) return;
          await staffApi
            .revokeDevice(hostelId, revoking.id)
            .catch(() => setMessage("Couldn't remove it."));
          setRevoking(null);
          await load();
        }}
      />
    </StaffScreen>
  );
}

const styles = StyleSheet.create({
  status: { width: 90, fontSize: typeTokens.size.sm, fontWeight: typeTokens.weight.semibold },
  online: { color: color.success },
  offline: { color: color.danger },
  pairing: { gap: space.xs, paddingTop: space.sm, alignItems: 'flex-start' },
  code: {
    fontSize: typeTokens.size.xl,
    fontWeight: typeTokens.weight.semibold,
    letterSpacing: 4,
    color: color.text,
  },
  qr: { width: 220, height: 220 },
});
