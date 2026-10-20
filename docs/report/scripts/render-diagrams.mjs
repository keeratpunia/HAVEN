#!/usr/bin/env node
/**
 * Renders every docs/report/diagrams/*.mmd (Mermaid) and *.dot (Graphviz) to a
 * high-resolution PNG beside it — Mermaid inside Playwright's Chromium, Graphviz via its
 * WASM build; both pinned in package.json, no global tools.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'diagrams');
const require = createRequire(import.meta.url);
const mermaidJs = readFileSync(require.resolve('mermaid/dist/mermaid.min.js'), 'utf-8');

const only = process.argv.slice(2);
const all = readdirSync(dir).filter((f) => only.length === 0 || only.some((o) => f.startsWith(o)));
const dotFiles = all.filter((f) => f.endsWith('.dot'));
const files = all
  .filter((f) => f.endsWith('.mmd'))
  .filter((f) => only.length === 0 || only.some((o) => f.startsWith(o)));

const viz = await (await import('@viz-js/viz')).instance();
const browser = await chromium.launch();
const page = await browser.newPage({
  deviceScaleFactor: 3,
  viewport: { width: 1400, height: 1000 },
});
await page.setContent(
  '<!doctype html><html><body style="margin:0;background:#fff"><div id="out"></div></body></html>',
);
await page.addScriptTag({ content: mermaidJs });
await page.evaluate(() => {
  // eslint-disable-next-line no-undef
  mermaid.initialize({
    startOnLoad: false,
    theme: 'neutral',
    fontFamily: '"Times New Roman", Times, serif',
    themeVariables: { fontSize: '16px', fontFamily: '"Times New Roman", Times, serif' },
    flowchart: {
      htmlLabels: true,
      curve: 'basis',
      padding: 8,
      nodeSpacing: 28,
      rankSpacing: 30,
      useMaxWidth: false,
    },
    sequence: {
      useMaxWidth: false,
      wrap: false,
      width: 120,
      actorMargin: 20,
      messageMargin: 28,
      boxMargin: 6,
      messageFontSize: 21,
      noteFontSize: 20,
      actorFontSize: 21,
      messageFontFamily: '"Times New Roman", Times, serif',
      noteFontFamily: '"Times New Roman", Times, serif',
      actorFontFamily: '"Times New Roman", Times, serif',
    },
    er: { useMaxWidth: false },
    state: { useMaxWidth: false },
  });
});

for (const file of files) {
  const source = readFileSync(path.join(dir, file), 'utf-8');
  const ok = await page.evaluate(async (src) => {
    try {
      // eslint-disable-next-line no-undef
      const { svg } = await mermaid.render('d' + Math.random().toString(36).slice(2), src);
      const out = document.getElementById('out');
      out.innerHTML = svg;
      const el = out.querySelector('svg');
      el.style.maxWidth = 'none';
      el.style.background = '#fff';
      return true;
    } catch (err) {
      return String(err?.message ?? err);
    }
  }, source);
  if (ok !== true) {
    console.error(`${file}: ${ok}`);
    process.exitCode = 1;
    continue;
  }
  const png = path.join(dir, file.replace(/\.mmd$/, '.png'));
  await page.locator('#out svg').screenshot({ path: png, omitBackground: false });
  console.log(`rendered ${path.basename(png)}`);
}
// Graphviz sources (.dot): laid out by Graphviz (WASM build) to SVG, rasterised by Chromium.
for (const file of dotFiles) {
  const svg = viz.renderString(readFileSync(path.join(dir, file), 'utf-8'), { format: 'svg' });
  await page.evaluate((s) => {
    const out = document.getElementById('out');
    out.innerHTML = s;
    const el = out.querySelector('svg');
    el.style.background = '#fff';
  }, svg);
  const png = path.join(dir, file.replace(/\.dot$/, '.png'));
  await page.locator('#out svg').screenshot({ path: png, omitBackground: false });
  console.log(`rendered ${path.basename(png)}`);
}
await browser.close();
