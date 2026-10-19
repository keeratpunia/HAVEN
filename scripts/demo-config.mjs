/**
 * The one file a presenter edits: demo.config.json at the repo root (created from
 * demo.config.example.json on first run, and never committed — it holds the room's
 * real coordinates). Environment variables still win, for one-off overrides:
 * DEMO_GATE_LAT, DEMO_GATE_LNG, DEMO_GATE_RADIUS_M, PROXY_PORT.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG = path.join(ROOT, 'demo.config.json');
const EXAMPLE = path.join(ROOT, 'demo.config.example.json');

function num(value, name, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`demo.config.json: ${name} must be a number between ${min} and ${max}.`);
  }
  return n;
}

export function loadDemoConfig() {
  if (!existsSync(CONFIG)) {
    copyFileSync(EXAMPLE, CONFIG);
    console.log(
      'Created demo.config.json from demo.config.example.json — edit it to set the gate location.\n',
    );
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(CONFIG, 'utf-8'));
  } catch (err) {
    throw new Error(`demo.config.json is not valid JSON: ${err.message}`);
  }
  const gate = raw.gate ?? {};
  return {
    gateLat: num(process.env.DEMO_GATE_LAT ?? gate.lat, 'gate.lat', -90, 90),
    gateLng: num(process.env.DEMO_GATE_LNG ?? gate.lng, 'gate.lng', -180, 180),
    gateRadiusM: num(
      process.env.DEMO_GATE_RADIUS_M ?? gate.radiusM ?? 150,
      'gate.radiusM',
      10,
      300,
    ),
    proxyPort: num(process.env.PROXY_PORT ?? raw.proxyPort ?? 9000, 'proxyPort', 1024, 65535),
  };
}
