#!/usr/bin/env node
/* eslint-disable no-console -- CLI script */
/**
 * Sets the running demo's business clock (docs/DEMO.md step F):
 *
 *   pnpm demo:clock              show the demo time
 *   pnpm demo:clock 13:00        today 13:00 IST (present at any hour)
 *   pnpm demo:clock 20:05        just after the 20:00 entry cut-off
 *   pnpm demo:clock +11m         move forward 11 minutes
 *   pnpm demo:clock reset        back to the real time
 *
 * Talks only to the demo API on 127.0.0.1 (the route refuses anything but loopback).
 * The gate screen picks up the new time on its next heartbeat; reload it to be instant.
 */
import { DEMO_API_PORT } from './demo-constants.js';
import { formatIst } from './demo-time.js';

async function main() {
  const spec = process.argv.slice(2).filter((a) => a !== '--')[0];
  const url = `http://127.0.0.1:${DEMO_API_PORT}/__demo/clock`;
  let res: Response;
  try {
    res = spec
      ? await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ at: spec }),
        })
      : await fetch(url);
  } catch {
    console.error('The demo API is not running on :8080. Start it with `pnpm demo` first.');
    process.exit(1);
  }
  const body = (await res.json()) as { now?: string; offsetMinutes?: number; error?: string };
  if (!res.ok || !body.now) {
    console.error(body.error ?? `Demo API answered ${res.status}.`);
    process.exit(1);
  }
  const shifted = body.offsetMinutes
    ? ` (real time ${body.offsetMinutes > 0 ? '+' : ''}${body.offsetMinutes} min)`
    : ' (real time)';
  console.log(`Demo time is now ${formatIst(new Date(body.now))}${shifted}.`);
  if (spec)
    console.log('Reload the gate screen (or wait up to 60 s) so its QR follows the new time.');
}

void main();
