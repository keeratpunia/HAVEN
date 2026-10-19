/**
 * Folder cleanup that survives Windows. A Postgres process (or antivirus, or Explorer)
 * can keep a folder locked for a moment after it exits, so deleting it throws EBUSY or
 * EPERM. Every embedded-Postgres script here deletes its data folder through these
 * helpers: retried, and never fatal on the way out.
 */
import { existsSync, rmSync } from 'node:fs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deletes `dir` with retries. Returns false (after a warning) if it stays locked. */
export async function removeDirSafely(dir: string, attempts = 8): Promise<boolean> {
  for (let i = 1; i <= attempts; i++) {
    if (!existsSync(dir)) return true;
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (i === attempts) {
        console.warn(
          `Could not delete ${dir} (${(err as NodeJS.ErrnoException).code}); it is left behind. ` +
            '`pnpm demo:reset --all` clears it once nothing is using it.',
        );
        return false;
      }
      await sleep(250 * i);
    }
  }
  return false;
}

/**
 * Before starting embedded Postgres: a run that was killed (closed window, taskkill)
 * never deleted its data folder, and initdb refuses a folder that "exists but is not
 * empty". This folder only ever holds the throwaway database, so it is safe to clear.
 */
export async function clearStaleDataDir(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  console.warn(`Removing the database folder a previous run left behind: ${dir}`);
  if (!(await removeDirSafely(dir))) {
    throw new Error(
      `${dir} is still in use — a previous run may still be running. ` +
        'Run `pnpm demo:reset --all` and try again.',
    );
  }
}

/** `pg.stop()` deletes a non-persistent data folder itself and can hit EBUSY doing so. */
export async function stopPostgresSafely(
  pg: { stop: () => Promise<void> },
  dir: string,
): Promise<void> {
  try {
    await pg.stop();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw err;
  }
  await removeDirSafely(dir);
}
