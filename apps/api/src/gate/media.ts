import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
 * Storage: this environment has no reliable Supabase/Docker storage connection
 * (DEC-004's same constraint). `MediaStorage` is the seam a real Supabase Storage
 * client plugs into later; `LocalDiskMediaStorage` is a disclosed local-disk
 * substitute used for dev/test, writing under the same bucket/path layout SDD §9.11
 * specifies so swapping the implementation later needs no path changes.
 */

export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const MAX_DIMENSION = 720;
const JPEG_QUALITY = 80;

export interface MediaStorage {
  put(path: string, bytes: Buffer): Promise<void>;
  /** Null when the object doesn't exist (deleted by retention, or never stored). */
  get(path: string): Promise<Buffer | null>;
  /** Removes the object; deleting one that's already gone is not an error. */
  delete(path: string): Promise<void>;
}

export class LocalDiskMediaStorage implements MediaStorage {
  constructor(private readonly rootDir: string) {}

  async put(path: string, bytes: Buffer): Promise<void> {
    const fullPath = join(this.rootDir, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, bytes);
  }

  async get(path: string): Promise<Buffer | null> {
    try {
      return await readFile(join(this.rootDir, path));
    } catch {
      return null;
    }
  }

  async delete(path: string): Promise<void> {
    await rm(join(this.rootDir, path), { force: true });
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
    return await sharp(raw)
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
  bucket: string;
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
    .executeTakeFirstOrThrow();

  await params.storage.put(path, processed);

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
    .select(['path', 'deleted_at'])
    .where('id', '=', params.mediaId)
    .executeTakeFirst();
  if (!row || row.deleted_at) return;
  await params.storage.delete(row.path);
  await params.db
    .updateTable('haven.media')
    .set({ deleted_at: params.clock.now().toISOString() })
    .where('id', '=', params.mediaId)
    .execute();
}
