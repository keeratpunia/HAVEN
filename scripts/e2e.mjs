#!/usr/bin/env node
/**
 * `pnpm e2e [playwright args]` — the Playwright suite (SDD §19.1) exactly as CI runs it,
 * on Windows, macOS or Linux: a fresh embedded-Postgres E2E database, the E2E API
 * (frozen clock) on :8080, the Expo web app on :8081, then the whole suite.
 * Stop `pnpm demo` first: they share ports 8080/8081.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './demo-config.mjs';

const LOGS = process.env.E2E_LOG_DIR ?? path.join(ROOT, 'apps', 'mobile', 'e2e-logs');
mkdirSync(LOGS, { recursive: true });

const children = [];
function background(name, command, cwd, env = {}) {
  const log = openSync(path.join(LOGS, `${name}.log`), 'w');
  const child = spawn(command, {
    cwd,
    shell: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, ...env },
  });
  children.push(child);
  return child;
}
function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill();
    }
  }
}
process.on('SIGINT', () => {
  stopAll();
  process.exit(130);
});

async function waitFor(what, seconds, check) {
  for (let i = 0; i < seconds; i++) {
    try {
      if (await check()) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Timed out waiting for ${what} — see ${LOGS}`);
}
const httpOk = (url) => fetch(url, { signal: AbortSignal.timeout(5_000) }).then((r) => r.ok);

async function main() {
  const api = path.join(ROOT, 'apps', 'api');
  const mobile = path.join(ROOT, 'apps', 'mobile');

  console.log('Starting the E2E database...');
  background('e2e-db', 'pnpm e2e:db', api);
  const { readFileSync } = await import('node:fs');
  await waitFor('the E2E database', 180, async () =>
    readFileSync(path.join(LOGS, 'e2e-db.log'), 'utf-8').includes('E2E database ready'),
  );

  console.log('Starting the E2E API...');
  background('e2e-server', 'pnpm e2e:server', api);
  await waitFor('the E2E API', 120, () => httpOk('http://127.0.0.1:8080/health'));

  console.log('Starting the web app (the first bundle can take a few minutes)...');
  background('e2e-web', 'npx expo start --web --port 8081', mobile, {
    EXPO_PUBLIC_API_URL: 'http://localhost:8080',
    EXPO_PUBLIC_WEB_URL: 'http://localhost:8081',
    EXPO_PUBLIC_DEV_LOGIN_ENABLED: 'true',
    CI: '1',
  });
  await waitFor('the web app', 300, () => httpOk('http://127.0.0.1:8081/'));
  const html = await (await fetch('http://127.0.0.1:8081/home')).text();
  const src = /src="([^"]*bundle[^"]*)"/.exec(html)?.[1]?.replace(/&amp;/g, '&');
  if (src) {
    await fetch(new URL(src, 'http://127.0.0.1:8081/'), { signal: AbortSignal.timeout(600_000) })
      .then((r) => r.arrayBuffer())
      .catch(() => undefined);
  }

  console.log('Running Playwright...\n');
  const args = [
    'playwright',
    'test',
    '--config=e2e/playwright.config.ts',
    '--workers=1',
    ...process.argv.slice(2),
  ];
  const result = spawnSync(`npx ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`, {
    cwd: mobile,
    shell: true,
    stdio: 'inherit',
  });
  stopAll();
  process.exit(result.status ?? 1);
}

main().catch((err) => {
  console.error(err.message);
  stopAll();
  process.exit(1);
});
