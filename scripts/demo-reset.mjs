#!/usr/bin/env node
/**
 * `pnpm demo:reset` — clears whatever a crashed or half-stopped demo left behind, so
 * the next `pnpm demo` starts clean:
 *   - stops processes LISTENING on the demo ports (API 8080, web 8081, proxy, demo
 *     Postgres 54625) and their child processes,
 *   - stops embedded Postgres processes whose data folder is this repo's
 *     .demo-pgdata, and cloudflared quick tunnels pointed at the proxy port,
 *   - deletes apps/api/.demo-pgdata and apps/api/.demo-media.
 * It never touches other programs: only those ports, and only Postgres/cloudflared
 * processes whose command line names this demo.
 *
 *   pnpm demo:reset          the demo only
 *   pnpm demo:reset --all    also the test and Playwright leftovers (ports 54621,
 *                            55439; apps/api/.e2e-pgdata, .e2e-media; the test DB folder)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadDemoConfig, ROOT } from './demo-config.mjs';

const all = process.argv.includes('--all');
const { proxyPort } = loadDemoConfig();
const ports = [8080, 8081, proxyPort, 54625, ...(all ? [54621, 55439] : [])];
const dirs = [
  path.join(ROOT, 'apps', 'api', '.demo-pgdata'),
  path.join(ROOT, 'apps', 'api', '.demo-media'),
  ...(all
    ? [
        path.join(ROOT, 'apps', 'api', '.e2e-pgdata'),
        path.join(ROOT, 'apps', 'api', '.e2e-media'),
        path.join(tmpdir(), 'haven-test-embedded-pg'),
      ]
    : []),
];
const isWin = process.platform === 'win32';

function sh(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    return err.stdout?.toString() ?? '';
  }
}

function listeningPids(port) {
  if (isWin) {
    const pids = new Set();
    for (const line of sh('netstat', ['-ano', '-p', 'TCP']).split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols[0] === 'TCP' && cols[3] === 'LISTENING' && cols[1]?.endsWith(`:${port}`)) {
        if (cols[4] && cols[4] !== '0') pids.add(cols[4]);
      }
    }
    return [...pids];
  }
  return sh('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
    .split(/\s+/)
    .filter(Boolean);
}

/** PIDs of postgres / cloudflared processes that belong to this demo (by command line). */
function demoProcessPids() {
  const markers = [
    '.demo-pgdata',
    `localhost:${proxyPort}`,
    ...(all ? ['.e2e-pgdata', 'haven-test-embedded-pg'] : []),
  ];
  if (isWin) {
    const ps = sh('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'postgres.exe\' OR Name=\'cloudflared.exe\'" | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
    ]);
    return ps
      .split(/\r?\n/)
      .map((l) => l.split('\t'))
      .filter(([pid, cmd]) => pid && cmd && markers.some((m) => cmd.includes(m)))
      .map(([pid]) => pid.trim());
  }
  return sh('ps', ['-eo', 'pid=,args='])
    .split('\n')
    .filter((l) => /postgres|cloudflared/.test(l) && markers.some((m) => l.includes(m)))
    .map((l) => l.trim().split(/\s+/)[0]);
}

function kill(pid) {
  if (isWin) spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' });
  else spawnSync('kill', ['-9', pid], { stdio: 'ignore' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Windows keeps a folder locked for a moment after its process dies (EBUSY/EPERM). */
async function removeDir(dir) {
  if (!existsSync(dir)) return 'absent';
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return 'deleted';
    } catch (err) {
      if (attempt === 10)
        return `still locked (${err.code}) — close any program using it and run this again`;
      await sleep(500 * attempt);
    }
  }
  return 'unknown';
}

let killed = 0;
for (const port of ports) {
  for (const pid of listeningPids(port)) {
    kill(pid);
    killed++;
    console.log(`stopped process ${pid} listening on :${port}`);
  }
}
for (const pid of demoProcessPids()) {
  kill(pid);
  killed++;
  console.log(`stopped leftover postgres/cloudflared process ${pid}`);
}
if (killed) await sleep(1_500);

for (const dir of dirs) {
  console.log(`${path.relative(ROOT, dir) || dir}: ${await removeDir(dir)}`);
}
const busy = ports.filter((p) => listeningPids(p).length > 0);
if (busy.length) {
  console.log(`\nStill in use: ${busy.map((p) => `:${p}`).join(', ')} — another program owns it.`);
  process.exitCode = 1;
} else {
  console.log('\nClean. Start again with: pnpm demo   (or pnpm demo:tunnel for phones)');
}
