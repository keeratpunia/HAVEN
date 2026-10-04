#!/usr/bin/env node
/**
 * `pnpm demo` — starts the local demo DB, API and web app together for a live
 * presentation (see docs/DEMO.md for the full script). Plain Node, no build step: this
 * only ever points at the embedded, localhost-only database `apps/api/scripts/demo-db.ts`
 * starts, so there is no way for it to touch staging or production — reinforced here
 * with an explicit refusal if `APP_ENV`/`NODE_ENV` look like a real deployment.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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

const webBaseUrl = process.env.WEB_BASE_URL ?? 'http://localhost:8081';
const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:8080';

/** Prefixes every line of a chunk with `[name]` — a single `data` event can contain
 * several newline-separated lines, and prefixing only the chunk's start left later
 * lines unprefixed in the combined output. */
function prefixedWrite(stream, name, buf) {
  const text = buf.toString();
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) stream.write(`[${name}] ${line}\n`);
}

const children = [];
function run(name, command, args, opts = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: 'pipe',
    shell: process.platform === 'win32',
    env: { ...process.env, ...opts.env },
  });
  children.push(child);
  child.stdout.on('data', (buf) => prefixedWrite(process.stdout, name, buf));
  child.stderr.on('data', (buf) => prefixedWrite(process.stderr, name, buf));
  return child;
}

/** Resolves once `pattern` appears in the child's stdout, so the next process only
 * starts once the previous one is genuinely ready (not just "spawned"). */
function waitFor(child, pattern) {
  return new Promise((resolve) => {
    const onData = (buf) => {
      if (pattern.test(buf.toString())) {
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
  });
}

/** `spawn(..., { shell: true })` on Windows wraps each child in an extra cmd.exe
 * layer — `child.kill()` only kills that wrapper, leaving the actual tsx/expo
 * process (and the embedded Postgres under it) running and still holding its port.
 * `taskkill /T` kills the whole process tree instead; on POSIX, `child.kill()` is
 * already enough since there's no such wrapper. */
function killTree(child) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill();
  }
}

function shutdown() {
  for (const child of children) killTree(child);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
  console.log('Starting HAVEN demo stack (real clock, embedded local database)...\n');

  const db = run('db', 'pnpm', ['--filter', '@haven/api', 'run', 'demo:db']);
  await waitFor(db, /Demo database ready\./);

  const server = run('api', 'pnpm', ['--filter', '@haven/api', 'run', 'demo:server'], {
    env: { WEB_BASE_URL: webBaseUrl, API_BASE_URL: apiBaseUrl },
  });
  await waitFor(server, /listening on/);

  run('web', 'pnpm', ['--filter', '@haven/mobile', 'run', 'web'], {
    env: { EXPO_PUBLIC_API_URL: apiBaseUrl, EXPO_PUBLIC_WEB_URL: webBaseUrl },
  });

  setTimeout(() => {
    console.log('\n' + '='.repeat(72));
    console.log('HAVEN demo is up.');
    console.log(`  Web:  ${webBaseUrl}`);
    console.log(`  API:  ${apiBaseUrl}`);
    console.log(
      '  Resident dev sign-in: priya@haven.demo, fatima@haven.demo (any password-free email)',
    );
    console.log(
      '  Guest OTP: read "[otp:dev] ... purpose-code=" above, or use +91 9999900001/02 with code 123456',
    );
    console.log('  Gate pairing code: printed above by [db] — regenerate anytime with:');
    console.log('    pnpm --filter @haven/api run demo:pair-code');
    console.log(
      '  See docs/DEMO.md for the full script, tunnel setup, and failure-case walkthroughs.',
    );
    console.log('='.repeat(72) + '\n');
  }, 3000);
}

void main();
