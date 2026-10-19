import type { Env } from '../config.js';
import { LocalDiskMediaStorage, type MediaStorage } from '../gate/media.js';
import { SupabaseMediaStorage } from './supabase-storage.js';

/**
 * Picks the photo store (SDD §9.10, DEC-021): Supabase Storage's private buckets
 * everywhere except APP_ENV=local, where a local folder stands in. Local disk is never
 * used elsewhere: on Render it is wiped on every deploy and not shared between
 * instances (FINAL-QA-REPORT D-03).
 */
export function createMediaStorage(
  env: Pick<Env, 'APP_ENV' | 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY' | 'MEDIA_STORAGE_DIR'>,
  fetchImpl: typeof fetch = fetch,
): MediaStorage {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return new SupabaseMediaStorage(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl);
  }
  if (env.APP_ENV !== 'local') {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required outside local (SDD §9.10). ' +
        'Refusing to store photos on local disk.',
    );
  }
  return new LocalDiskMediaStorage(env.MEDIA_STORAGE_DIR);
}
