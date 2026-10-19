#!/usr/bin/env node
/**
 * `pnpm demo` — starts the local demo database, API and web app together for a live
 * presentation (docs/DEMO.md). `pnpm demo:tunnel` runs this behind one cloudflared quick
 * tunnel for phones. Plain Node, no build step.
 *
 * Safety: everything points at the embedded, localhost-only database that
 * apps/api/scripts/demo-db.ts starts, so this can't touch staging or production —
 * reinforced by refusing to run if APP_ENV/NODE_ENV look like a real deployment.
 */
import { spawn } from 'node:child_process';
import { loadDemoConfig, ROOT } from './demo-config.mjs';

for (const varName of ['APP_ENV', 'NODE_ENV']) {
  const value = process.env[varName];
  if (value && value !== 'local' && value !== 'development' && value !== 'test') {
    console.error(
      `Refusing to run the demo: ${varName}=${value} looks like a real deployment. ` +
        'The demo seed and dev sign-in must never run against staging or production.',
    );
    process.exit(1);
  }
}

let config;
try {
  config = loadDemoConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const webBaseUrl = process.env.WEB_BASE_URL ?? 'http://localhost:8081';
const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:8080';

// One tunnel, one origin (docs/DEMO.md "Phones"): two tunnel hostnames would be two
// sites, and the SameSite=Lax refresh cookie would never reach the API. When the web
// and API URLs are the same non-localhost origin, scripts/demo-proxy.mjs serves both on
// one port (/v1 → API :8080, everything else → web :8081) and the tunnel points there.
const usingSharedTunnelOrigin = webBaseUrl === apiBaseUrl && !webBaseUrl.includes('localhost');

/** Prefixes every line with `[name]` (one `data` event can hold several lines). */
function prefixedWrite(stream, name, buf) {
  const lines = buf.toString().split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) stream.write(`[${name}] ${line}\n`);
}

const children = [];
/**
 * `command` is one string: on Windows `pnpm` is `pnpm.cmd`, which Node can only start
 * through a shell, and passing an args array with `shell: true` is deprecated (DEP0190).
 * No path is ever part of the command, so a repo folder with spaces is fine (`cwd`).
 */
function run(name, command, env = {}) {
  const child = spawn(command, {
    cwd: ROOT,
    stdio: 'pipe',
    shell: true,
    env: { ...process.env, ...env },
  });
  children.push(child);
  child.stdout.on('data', (buf) => prefixedWrite(process.stdout, name, buf));
  child.stderr.on('data', (buf) => prefixedWrite(process.stderr, name, buf));
  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0 && code !== null) {
      console.error(
        `\n[${name}] stopped (exit ${code}). See the lines above; "pnpm demo:reset" clears leftovers.`,
      );
      shutdown(1);
    }
  });
  return child;
}

/** Resolves with the matching line once `pattern` appears in the child's output. */
function waitFor(child, pattern) {
  return new Promise((resolve) => {
    const onData = (buf) => {
      const m = pattern.exec(buf.toString());
      if (m) {
        child.stdout.off('data', onData);
        resolve(m);
      }
    };
    child.stdout.on('data', onData);
  });
}

/** With `shell: true` the child is a cmd.exe wrapper on Windows: kill the whole tree. */
function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill();
  }
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child);
  setTimeout(() => process.exit(code), 1500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** Waits for the Expo web server, then requests the app bundle once so the first phone
 * doesn't wait a minute or more for Metro to build it. */
async function warmWebBundle() {
  const deadline = Date.now() + 10 * 60_000;
  let html = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:8081/', { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        html = await res.text();
        break;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  const src = /src="([^"]*bundle[^"]*)"/.exec(html)?.[1]?.replace(/&amp;/g, '&');
  if (!src) return false;
  console.log('\nBuilding the web app bundle (first time can take a few minutes)...');
  try {
    const res = await fetch(new URL(src, 'http://127.0.0.1:8081/'), {
      signal: AbortSignal.timeout(10 * 60_000),
    });
    await res.arrayBuffer();
    return res.ok;
  } catch {
    return false;
  }
}

function banner(pairing) {
  const line = '='.repeat(76);
  const out = [
    '',
    line,
    'HAVEN demo is up.',
    `  Open on the laptop and phones:  ${webBaseUrl}`,
    usingSharedTunnelOrigin
      ? `  (tunnel → local proxy :${config.proxyPort} → API :8080 + web :8081)`
      : `  API:  ${apiBaseUrl}`,
    '',
    `  Gate screen:  ${webBaseUrl}/gate   pairing code ${pairing ?? '(see [db] above)'}  (valid 10 min)`,
    '                new code any time:  pnpm demo:pair-code',
    `  Gate location: ${config.gateLat}, ${config.gateLng} (radius ${config.gateRadiusM} m) — edit demo.config.json`,
    '',
    '  Sign in at /sign-in with the email only (dev sign-in, no password):',
    '    Residents:   priya@haven.demo (room 101), fatima@haven.demo (room 102)',
    '    Warden:      warden@haven.demo',
    '    Office:      office@haven.demo',
    '    Super admin: admin@haven.demo',
    '',
    '  Guests: phone 99999 00001 or 99999 00002 (also 03–09), OTP code 123456',
    '',
    '  Demo clock:   pnpm demo:clock 13:00 | 20:05 | +11m | reset',
    '  Jobs:         pnpm demo:job list | overstay <VISIT> | escalate <VISIT>',
    '  Stop: Ctrl+C.  Leftovers / start clean: pnpm demo:reset.   Script: docs/DEMO.md',
    line,
    '',
  ];
  console.log(out.join('\n'));
}

async function main() {
  console.log('Starting HAVEN demo stack (embedded local database, dev sign-in)...\n');

  const db = run('db', 'pnpm --filter @haven/api run demo:db', {
    DEMO_GATE_LAT: String(config.gateLat),
    DEMO_GATE_LNG: String(config.gateLng),
    DEMO_GATE_RADIUS_M: String(config.gateRadiusM),
  });
  const pairingLine = waitFor(db, /Gate pairing code: ([0-9A-Z]{4}-[0-9A-Z]{4})/);
  await waitFor(db, /Demo database ready\./);
  const pairing = (
    await Promise.race([pairingLine, new Promise((r) => setTimeout(r, 2_000))])
  )?.[1];

  const server = run('api', 'pnpm --filter @haven/api run demo:server', {
    WEB_BASE_URL: webBaseUrl,
    API_BASE_URL: apiBaseUrl,
    CORS_ORIGINS:
      process.env.CORS_ORIGINS ??
      `${webBaseUrl},http://localhost:8081,http://localhost:${config.proxyPort}`,
    TRUST_PROXY_HOPS: usingSharedTunnelOrigin ? '1' : '0',
  });
  await waitFor(server, /listening on/);

  run('web', 'pnpm --filter @haven/mobile run web', {
    EXPO_PUBLIC_API_URL: apiBaseUrl,
    EXPO_PUBLIC_WEB_URL: webBaseUrl,
    // The resident/staff sign-in screen only shows the dev sign-in form with this on
    // (no real Google OAuth in the demo; demo-server.ts enables the API side).
    EXPO_PUBLIC_DEV_LOGIN_ENABLED: 'true',
    // Non-interactive: no "press a key" prompts, no browser auto-open.
    CI: '1',
  });

  if (usingSharedTunnelOrigin) {
    run('proxy', 'node scripts/demo-proxy.mjs', { PROXY_PORT: String(config.proxyPort) });
  }

  const warmed = await warmWebBundle();
  if (!warmed)
    console.log('\n(The web bundle did not pre-build; the first page load will be slow.)');
  banner(pairing);
}

void main();
