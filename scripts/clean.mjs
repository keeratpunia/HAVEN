#!/usr/bin/env node
/**
 * Cross-platform `rm -rf` for the package `clean` scripts (Windows `cmd` has no `rm`).
 * Usage: node <path>/scripts/clean.mjs dist .turbo …   (paths relative to the cwd)
 */
import { rmSync } from 'node:fs';
import path from 'node:path';

for (const target of process.argv.slice(2)) {
  const full = path.resolve(process.cwd(), target);
  try {
    rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch (err) {
    console.warn(
      `clean: could not remove ${target} (${err.code}); close programs using it and retry.`,
    );
  }
}
