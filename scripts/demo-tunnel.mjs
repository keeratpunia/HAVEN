#!/usr/bin/env node
/**
 * `pnpm demo:tunnel` — the phone demo in one command:
 *   1. starts a cloudflared quick tunnel to the local proxy port (demo.config.json),
 *   2. reads the https://….trycloudflare.com URL it prints,
 *   3. starts `pnpm demo` with WEB_BASE_URL = API_BASE_URL = CORS_ORIGINS = that URL,
 *      so the proxy serves the web app and the API under one origin.
 * Ctrl+C stops both. Needs cloudflared (winget install --id Cloudflare.cloudflared).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadDemoConfig, ROOT } from './demo-config.mjs';

const config = loadDemoConfig();

function findCloudflared() {
  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], {
    encoding: 'utf-8',
  });
  if (onPath.status === 0) return onPath.stdout.split(/\r?\n/)[0].trim();
  // winget puts it here but a terminal opened before the install hasn't got the new PATH.
  for (const dir of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
    if (!dir) continue;
    const exe = path.join(dir, 'cloudflared', 'cloudflared.exe');
    if (existsSync(exe)) return exe;
  }
  return null;
}

const cloudflared = findCloudflared();
if (!cloudflared) {
  console.error(
    'cloudflared is not installed. In PowerShell run:\n' +
      '  winget install --id Cloudflare.cloudflared\n' +
      'then open a new terminal and run pnpm demo:tunnel again.\n' +
      'No phone handy? `pnpm demo` runs everything on this laptop (docs/SETUP.md, laptop-only).',
  );
  process.exit(1);
}

let demo = null;
let stopping = false;
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill();
  }
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  killTree(demo);
  killTree(tunnel);
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

console.log(`Starting a cloudflared quick tunnel to http://localhost:${config.proxyPort} ...`);
const tunnel = spawn(
  cloudflared,
  ['tunnel', '--no-autoupdate', '--url', `http://localhost:${config.proxyPort}`],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
);
tunnel.on('exit', (code) => {
  if (!stopping) {
    console.error(`\ncloudflared stopped (exit ${code}). The phones can no longer reach the demo.`);
    stop(1);
  }
});

const url = await new Promise((resolve) => {
  let log = '';
  const timer = setTimeout(() => {
    console.error(
      'No tunnel URL after 60 s. cloudflared said:\n' +
        log.slice(-2_000) +
        '\nCheck the internet connection (and that the network allows outbound QUIC/HTTPS), then retry.',
    );
    stop(1);
  }, 60_000);
  const onData = (buf) => {
    log += buf.toString();
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log);
    if (m) {
      clearTimeout(timer);
      resolve(m[0]);
    }
  };
  tunnel.stdout.on('data', onData);
  tunnel.stderr.on('data', onData);
});
console.log(`Tunnel: ${url}\n`);

demo = spawn('node scripts/demo.mjs', {
  cwd: ROOT,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, WEB_BASE_URL: url, API_BASE_URL: url },
});
demo.on('exit', (code) => stop(code ?? 0));
