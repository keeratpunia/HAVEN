import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import type { MediaKind } from '../db/types.js';
import { AppError } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';
import type { Clock } from '../lib/clock.js';

/**
 * Photo upload pipeline (SDD §9.4): "Server: max 3 MB; check JPEG/PNG magic bytes;
 * sharp -> rotate by EXIF, resize to max 720px, re-encode JPEG q80, strip all
 * metadata; compute SHA-256; reject PHOTO_REUSED if the same hash exists for this
 * visitor; store; insert media row; return { photoId }."
 *
 * Storage: `MediaStorage` is the seam. Outside local it is `SupabaseMediaStorage`
 * (`media/supabase-storage.ts`, private buckets per SDD §9.10); `LocalDiskMediaStorage`
 * is the local-only stand-in, same bucket/path layout. `media/storage.ts` chooses and
 * refuses local disk outside APP_ENV=local (DEC-021).
 */

export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const MAX_DIMENSION = 720;
const JPEG_QUALITY = 80;
/**
 * Decoding limit: a 3 MB PNG can declare an enormous canvas and exhaust memory when
 * decoded. 40 megapixels is above any phone camera's live frame; the client sends 720 px.
 */
export const MAX_INPUT_PIXELS = 40_000_000;

/** The three private buckets of SDD §9.10. */
export const MEDIA_BUCKETS = ['visitor-photos', 'gate-photos', 'resident-docs'] as const;
export type MediaBucket = (typeof MEDIA_BUCKETS)[number];

/** One stored object, addressed exactly like Supabase Storage: bucket + path in it. */
export interface MediaObject {
  bucket: MediaBucket;
  path: string;
}

export interface MediaStorage {
  put(object: MediaObject, bytes: Buffer): Promise<void>;
  /** Null when the object doesn't exist (deleted by retention, or never stored). */
  get(object: MediaObject): Promise<Buffer | null>;
  /** Removes the object; deleting one that's already gone is not an error. */
  delete(object: MediaObject): Promise<void>;
  /**
   * A URL that reads the object directly for `ttlSeconds` (Supabase's signed URL, SDD
   * §9.10), or null when it no longer exists. Stores without one (local disk, tests)
   * have their bytes served by `GET /v1/media/:id` itself.
   */
  signedUrl?(object: MediaObject, ttlSeconds: number): Promise<string | null>;
}

// Paths are built from UUIDs (§9.10), so only these characters ever appear.
const SAFE_PATH = /^[A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)*\.jpg$/;

/** Rejects anything that isn't a §9.10 bucket and a plain path inside it. */
export function assertMediaObject(object: MediaObject): void {
  if (
    !(MEDIA_BUCKETS as readonly string[]).includes(object.bucket) ||
    !SAFE_PATH.test(object.path)
  ) {
    throw new Error('invalid media object');
  }
}

/** Local stand-in for Supabase Storage: `<root>/<bucket>/<path>`, never outside root. */
export class LocalDiskMediaStorage implements MediaStorage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  private fullPath(object: MediaObject): string {
    assertMediaObject(object);
    const full = resolve(this.root, object.bucket, object.path);
    if (!full.startsWith(this.root + sep)) throw new Error('invalid media object');
    return full;
  }

  async put(object: MediaObject, bytes: Buffer): Promise<void> {
    const fullPath = this.fullPath(object);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, bytes);
  }

  async get(object: MediaObject): Promise<Buffer | null> {
    try {
      return await readFile(this.fullPath(object));
    } catch {
      return null;
    }
  }

  async delete(object: MediaObject): Promise<void> {
    await rm(this.fullPath(object), { force: true });
  }
}

function hasJpegOrPngMagicBytes(buf: Buffer): boolean {
  const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng =
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a;
  return isJpeg || isPng;
}

export interface GatePhotoPathParams {
  hostelId: string;
  mediaId: string;
  now: Date;
}

/** `gate-photos/{hostelId}/{yyyy}/{mm}/{mediaId}.jpg` (SDD §9.11). */
export function gatePhotoPath(params: GatePhotoPathParams): string {
  const yyyy = params.now.getUTCFullYear().toString();
  const mm = (params.now.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${params.hostelId}/${yyyy}/${mm}/${params.mediaId}.jpg`;
}

/** `visitor-photos/{visitorId}/{mediaId}.jpg` (SDD §9.11). */
export function visitorProfilePhotoPath(params: { visitorId: string; mediaId: string }): string {
  return `${params.visitorId}/${params.mediaId}.jpg`;
}

/** Shared magic-byte/size/EXIF-strip/resize/re-encode steps (SDD §9.4), independent of
 * which bucket/kind the caller eventually stores the result under. */
async function processPhotoBytes(raw: Buffer): Promise<Buffer> {
  if (raw.length === 0) {
    throw new AppError('PHOTO_REQUIRED', 400, 'A photo is required.');
  }
  if (raw.length > MAX_PHOTO_BYTES) {
    throw new AppError('PHOTO_INVALID', 400, 'Photo is too large (max 3 MB).');
  }
  if (!hasJpegOrPngMagicBytes(raw)) {
    throw new AppError('PHOTO_INVALID', 400, 'Photo must be a JPEG or PNG image.');
  }

  try {
    return await sharp(raw, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate() // auto-orient from EXIF, then strip all metadata (no .withMetadata() call)
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
  } catch {
    throw new AppError('PHOTO_INVALID', 400, 'Photo could not be read.');
  }
}

export interface StorePhotoParams {
  db: Kysely<Database>;
  storage: MediaStorage;
  clock: Clock;
  raw: Buffer;
  kind: MediaKind;
  bucket: MediaBucket;
  path: (mediaId: string, now: Date) => string;
  ownerVisitorId?: string | null;
  ownerUserId?: string | null;
}

/** Generic photo-upload pipeline: process, dedupe-check (per visitor), store, insert `media` row. */
async function storePhoto(params: StorePhotoParams): Promise<{ photoId: string }> {
  const processed = await processPhotoBytes(params.raw);
  const hash = sha256(processed);

  if (params.ownerVisitorId) {
    const existing = await params.db
      .selectFrom('haven.media')
      .select('id')
      .where('owner_visitor_id', '=', params.ownerVisitorId)
      .where('sha256', '=', hash)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (existing) {
      throw new AppError('PHOTO_REUSED', 400, "This looks like a photo you've already used.");
    }
  }

  const now = params.clock.now();
  const mediaId = randomUUID();
  const path = params.path(mediaId, now);

  // The unique index (migration 20261021000001) settles the race the check above can't:
  // two parallel uploads of the same photo (SECURITY-AUDIT SA-17).
  const inserted = await params.db
    .insertInto('haven.media')
    .values({
      id: mediaId,
      kind: params.kind,
      bucket: params.bucket,
      path,
      sha256: hash,
      bytes: processed.length,
      owner_user_id: params.ownerUserId ?? null,
      owner_visitor_id: params.ownerVisitorId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
    .catch((err: unknown) => {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError('PHOTO_REUSED', 400, "This looks like a photo you've already used.");
      }
      throw err;
    });

  await params.storage.put({ bucket: params.bucket, path }, processed);

  return { photoId: inserted.id };
}

export interface StoreGatePhotoParams {
  db: Kysely<Database>;
  storage: MediaStorage;
  clock: Clock;
  raw: Buffer;
  hostelId: string;
  ownerVisitorId?: string | null;
  ownerUserId?: string | null;
}

/** Processes and stores one gate photo upload; returns the new `media.id`. */
export async function storeGatePhoto(params: StoreGatePhotoParams): Promise<{ photoId: string }> {
  return storePhoto({
    db: params.db,
    storage: params.storage,
    clock: params.clock,
    raw: params.raw,
    kind: 'gate_photo',
    bucket: 'gate-photos',
    path: (mediaId, now) => gatePhotoPath({ hostelId: params.hostelId, mediaId, now }),
    ownerVisitorId: params.ownerVisitorId,
    ownerUserId: params.ownerUserId,
  });
}

export interface StoreVisitorProfilePhotoParams {
  db: Kysely<Database>;
  storage: MediaStorage;
  clock: Clock;
  raw: Buffer;
  visitorId: string;
}

/** `resident-docs/{userId}/{mediaId}.jpg` (SDD §9.11) — ID card photo and resident selfie. */
export async function storeResidentDocument(params: {
  db: Kysely<Database>;
  storage: MediaStorage;
  clock: Clock;
  raw: Buffer;
  userId: string;
  kind: 'resident_id_card' | 'resident_selfie';
}): Promise<{ photoId: string }> {
  return storePhoto({
    db: params.db,
    storage: params.storage,
    clock: params.clock,
    raw: params.raw,
    kind: params.kind,
    bucket: 'resident-docs',
    path: (mediaId) => `${params.userId}/${mediaId}.jpg`,
    ownerUserId: params.userId,
  });
}

/** `POST /v1/me/profile-photo` (SDD §9.4). */
export async function storeVisitorProfilePhoto(
  params: StoreVisitorProfilePhotoParams,
): Promise<{ photoId: string }> {
  const result = await storePhoto({
    db: params.db,
    storage: params.storage,
    clock: params.clock,
    raw: params.raw,
    kind: 'visitor_profile',
    bucket: 'visitor-photos',
    path: (mediaId) => visitorProfilePhotoPath({ visitorId: params.visitorId, mediaId }),
    ownerVisitorId: params.visitorId,
  });
  await params.db
    .updateTable('haven.visitors')
    .set({ profile_media_id: result.photoId })
    .where('id', '=', params.visitorId)
    .execute();
  return result;
}

/**
 * Deletes a stored photo now and marks its media row deleted (SDD §16.5: "Resident ID
 * card: deleted at verification decision (synchronously, not by job)").
 */
export async function deleteMedia(params: {
  db: Kysely<Database>;
  storage: MediaStorage;
  clock: Clock;
  mediaId: string;
}): Promise<void> {
  const row = await params.db
    .selectFrom('haven.media')
    .select(['bucket', 'path', 'deleted_at'])
    .where('id', '=', params.mediaId)
    .executeTakeFirst();
  if (!row || row.deleted_at) return;
  await params.storage.delete({ bucket: row.bucket as MediaBucket, path: row.path });
  await params.db
    .updateTable('haven.media')
    .set({ deleted_at: params.clock.now().toISOString() })
    .where('id', '=', params.mediaId)
    .execute();
}
