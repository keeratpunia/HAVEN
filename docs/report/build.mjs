#!/usr/bin/env node
/**
 * Regenerates the progress report with one command:
 *
 *   pnpm report                  diagrams + HAVEN-Progress-Report.docx/.pdf
 *   pnpm report -- --screenshots also re-captures the screenshots from a fresh `pnpm demo`
 *
 * Needs: Node + pnpm (repo setup), Python 3 with `pip install -r docs/report/requirements.txt`,
 * Microsoft Word on Windows (docx → pdf), and Playwright's Chromium for diagrams/screenshots.
 * Set PYTHON to choose the interpreter (default: python).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.PYTHON ?? 'python';

function step(label, cmd, args) {
  console.log(`\n== ${label}`);
  const r = spawnSync(cmd, args, {
    cwd: here,
    stdio: 'inherit',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (r.status !== 0) {
    console.error(`${label} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

if (process.argv.includes('--screenshots')) {
  step('screenshots', 'node', ['scripts/capture-screenshots.mjs']);
}
step('diagrams', 'node', ['scripts/render-diagrams.mjs']);
step('docx + pdf', python, ['scripts/build_report.py']);
