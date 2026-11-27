#!/usr/bin/env node
/**
 * Draws HAVEN's web-app icons from the design tokens (packages/ui/src/tokens.ts:
 * primary #0F766E on white): a plain house outline, no fonts and no third-party art.
 * Writes apps/mobile/public/icons/* and apps/mobile/assets/favicon.png. Run it again
 * only if the design changes; the PNGs are committed.
 *
 *   node scripts/make-pwa-icons.mjs
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ROOT } from './demo-config.mjs';

// sharp is the API's dependency (SDD §8.4, photo processing); borrow it from there.
const require = createRequire(path.join(ROOT, 'apps', 'api', 'package.json'));
const sharp = require('sharp');

const PRIMARY = '#0F766E';
const ON_PRIMARY = '#FFFFFF';

/**
 * `glyph` is the share of the square the house takes: 0.62 for normal icons, 0.5 for
 * maskable ones (the platform may crop to a circle, so it stays inside the safe zone).
 */
function svg(size, { glyph, rounded }) {
  const g = size * glyph;
  const x = (size - g) / 2;
  const y = (size - g) / 2;
  const stroke = Math.max(2, Math.round(size * 0.055));
  const roofTop = y + g * 0.05;
  const eave = y + g * 0.45;
  const base = y + g * 0.95;
  const left = x + g * 0.16;
  const right = x + g * 0.84;
  const doorW = g * 0.2;
  const doorL = size / 2 - doorW / 2;
  const doorTop = y + g * 0.62;
  const radius = rounded ? size * 0.2 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${PRIMARY}"/>
  <path d="M ${x} ${eave + g * 0.04} L ${size / 2} ${roofTop} L ${x + g} ${eave + g * 0.04}"
        fill="none" stroke="${ON_PRIMARY}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M ${left} ${eave} L ${left} ${base} L ${right} ${base} L ${right} ${eave}"
        fill="none" stroke="${ON_PRIMARY}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="${doorL}" y="${doorTop}" width="${doorW}" height="${base - doorTop}" rx="${doorW * 0.15}" fill="${ON_PRIMARY}"/>
</svg>`;
}

async function write(file, size, opts) {
  mkdirSync(path.dirname(file), { recursive: true });
  await sharp(Buffer.from(svg(size, opts)))
    .png()
    .toFile(file);
  console.log(`wrote ${path.relative(ROOT, file)}`);
}

const icons = path.join(ROOT, 'apps', 'mobile', 'public', 'icons');
await write(path.join(icons, 'icon-192.png'), 192, { glyph: 0.62, rounded: true });
await write(path.join(icons, 'icon-512.png'), 512, { glyph: 0.62, rounded: true });
await write(path.join(icons, 'maskable-512.png'), 512, { glyph: 0.5, rounded: false });
// iOS rounds the corners itself and ignores transparency, so a full square.
await write(path.join(icons, 'apple-touch-icon.png'), 180, { glyph: 0.6, rounded: false });
await write(path.join(ROOT, 'apps', 'mobile', 'assets', 'favicon.png'), 48, {
  glyph: 0.7,
  rounded: true,
});
