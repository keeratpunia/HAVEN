import type { Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import type { Logger } from '../lib/logger.js';
import type { MediaStorage } from '../gate/media.js';

/**
 * SDD §11.8: "job_retention() sets media.delete_after ...; the API worker deletes the
 * files from Storage and sets deleted_at". §16.5: gate photos after 180 days, a guest's
 * profile photo 365 days after their last visit. Deleting a file that's already gone is
 * not an error, so a run that stops halfway is simply finished by the next one.
 */
export async function purgeDueMedia(p: {
  db: Kysely<Database>;
  storage: MediaStorage;
  now: Date;
  logger?: Pick<Logger, 'info' | 'error'>;
  batchSize?: number;
}): Promise<number> {
  const due = await p.db
    .selectFrom('haven.media')
    .select(['id', 'path'])
    .where('deleted_at', 'is', null)
    .where('delete_after', 'is not', null)
    .where('delete_after', '<=', p.now)
    .orderBy('delete_after')
    .limit(p.batchSize ?? 500)
    .execute();

  let deleted = 0;
  for (const row of due) {
    try {
      await p.storage.delete(row.path);
      await p.db
        .updateTable('haven.media')
        .set({ deleted_at: p.now.toISOString() })
        .where('id', '=', row.id)
        .where('deleted_at', 'is', null)
        .execute();
      deleted += 1;
    } catch (err) {
      // Leave it for the next run; never log the path (CLAUDE.md §4 redaction).
      p.logger?.error({ err, mediaId: row.id }, 'media purge failed');
    }
  }
  if (deleted > 0) p.logger?.info({ deleted }, 'retention: photo files deleted');
  return deleted;
}
