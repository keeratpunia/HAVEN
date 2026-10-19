#!/usr/bin/env node
/**
 * `pnpm demo:reset` — clears whatever a crashed or half-stopped demo left behind, so
 * the next `pnpm demo` starts clean:
 *   - stops processes LISTENING on the demo ports (API 8080, web 8081, proxy, demo
 *     Postgres 54625) and their child processes,
 *   - stops embedded Postgres processes started from this repo's node_modules, and
 *     cloudflared quick tunnels pointed at the proxy port,
 *   - deletes apps/api/.demo-pgdata and apps/api/.demo-media.
 * It never touches other programs: only those ports, their children, and Postgres /
 * cloudflared processes that belong to this checkout.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    // -p TCP lists IPv4 sockets only; Postgres listens on IPv6 too.
    for (const proto of ['TCP', 'TCPv6']) {
      for (const line of sh('netstat', ['-ano', '-p', proto]).split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols[0] === 'TCP' && cols[3] === 'LISTENING' && cols[1]?.endsWith(`:${port}`)) {
          if (cols[4] && cols[4] !== '0') pids.add(cols[4]);
        }
      }
    }
    return [...pids];
  }
  return sh('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
    .split(/\s+/)
    .filter(Boolean);
}

/** Every process as { pid, ppid, cmd }. */
function processes() {
  if (isWin) {
    const ps = sh('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name) $($_.CommandLine)" }',
    ]);
    return ps
      .split(/\r?\n/)
      .map((line) => line.split('\t'))
      .filter(([pid, , cmd]) => pid && cmd)
      .map(([pid, ppid, cmd]) => ({ pid: pid.trim(), ppid: (ppid ?? '').trim(), cmd }));
  }
  return sh('ps', ['-eo', 'pid=,ppid=,args='])
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 3)
    .map(([pid, ppid, ...rest]) => ({ pid, ppid, cmd: rest.join(' ') }));
}

const norm = (s) => s.replace(/\\/g, '/').toLowerCase();
const ourModules = norm(path.join(ROOT, 'node_modules'));
const testDbMarker = /e2e-pgdata|haven-test-embedded-pg/i;

/**
 * Leftovers that belong to this demo:
 * - postgres started from THIS checkout's node_modules (the embedded Postgres). Its
 *   worker processes ("--forkchild=...") don't name the data folder, and on Windows
 *   they keep the listening port after their parent is killed;
 * - cloudflared quick tunnels pointed at the proxy port;
 * - children of a process that was listening on a demo port.
 */
function leftoverPids(listeners) {
  return processes()
    .filter(({ ppid, cmd }) => {
      const isOurPostgres = /postgres/i.test(cmd) && norm(cmd).includes(ourModules);
      if (isOurPostgres && (all || !testDbMarker.test(cmd))) return true;
      if (/cloudflared/i.test(cmd) && cmd.includes(`localhost:${proxyPort}`)) return true;
      return listeners.has(ppid);
    })
    .map(({ pid }) => pid)
    .filter((pid) => pid !== String(process.pid) && !listeners.has(pid));
}

function kill(pid) {
  if (isWin) spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' });
  else spawnSync('kill', ['-9', pid], { stdio: 'ignore' });
}

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

// Up to three rounds: Windows can take a moment to release a port after a kill.
for (let round = 1; round <= 3; round++) {
  const listeners = new Set();
  for (const port of ports) {
    for (const pid of listeningPids(port)) {
      listeners.add(pid);
      kill(pid);
      console.log(`stopped process ${pid} listening on :${port}`);
    }
  }
  const leftovers = leftoverPids(listeners);
  for (const pid of leftovers) {
    kill(pid);
    console.log(`stopped leftover demo process ${pid}`);
  }
  if (listeners.size === 0 && leftovers.length === 0) break;
  await sleep(1_500 * round);
}

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
