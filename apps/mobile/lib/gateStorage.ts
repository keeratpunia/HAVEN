import { Platform } from 'react-native';

/** The gate display page's localStorage keys (SDD §9.2), namespaced exactly as specified. */
export interface GateStorageState {
  deviceToken: string;
  secret: string; // base64
  secretVersion: number;
  code: string;
  offsetMs: number;
  hostelName: string;
  gateName: string;
}

const KEYS = {
  deviceToken: 'haven.gate.deviceToken',
  secret: 'haven.gate.secret',
  secretVersion: 'haven.gate.secretVersion',
  code: 'haven.gate.code',
  offsetMs: 'haven.gate.offsetMs',
  hostelName: 'haven.gate.hostelName',
  gateName: 'haven.gate.gateName',
} as const;

function storageAvailable(): boolean {
  return Platform.OS === 'web' && typeof localStorage !== 'undefined';
}

export function readGateStorage(): GateStorageState | null {
  if (!storageAvailable()) return null;
  try {
    const deviceToken = localStorage.getItem(KEYS.deviceToken);
    const secret = localStorage.getItem(KEYS.secret);
    const code = localStorage.getItem(KEYS.code);
    if (!deviceToken || !secret || !code) return null;
    return {
      deviceToken,
      secret,
      secretVersion: Number(localStorage.getItem(KEYS.secretVersion) ?? '1'),
      code,
      offsetMs: Number(localStorage.getItem(KEYS.offsetMs) ?? '0'),
      hostelName: localStorage.getItem(KEYS.hostelName) ?? '',
      gateName: localStorage.getItem(KEYS.gateName) ?? '',
    };
  } catch {
    return null;
  }
}

export function writeGateStorage(state: GateStorageState): void {
  if (!storageAvailable()) return;
  try {
    localStorage.setItem(KEYS.deviceToken, state.deviceToken);
    localStorage.setItem(KEYS.secret, state.secret);
    localStorage.setItem(KEYS.secretVersion, String(state.secretVersion));
    localStorage.setItem(KEYS.code, state.code);
    localStorage.setItem(KEYS.offsetMs, String(state.offsetMs));
    localStorage.setItem(KEYS.hostelName, state.hostelName);
    localStorage.setItem(KEYS.gateName, state.gateName);
  } catch {
    // ignore — a gate device with storage disabled just re-pairs every reload
  }
}

export function updateGateOffsetAndSecret(offsetMs: number, secret?: string): void {
  if (!storageAvailable()) return;
  try {
    localStorage.setItem(KEYS.offsetMs, String(offsetMs));
    if (secret) localStorage.setItem(KEYS.secret, secret);
  } catch {
    // ignore
  }
}

/** SDD F8 step 5 / §9.2: a revoked device clears storage and shows D-03. */
export function clearGateStorage(): void {
  if (!storageAvailable()) return;
  try {
    Object.values(KEYS).forEach((key) => localStorage.removeItem(key));
  } catch {
    // ignore
  }
}
