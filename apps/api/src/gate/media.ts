import { mkdir, writeFile } from 'node:fs/promises';
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
}

export class LocalDiskMediaStorage implements MediaStorage {
  constructor(private readonly rootDir: string) {}

  async put(path: string, bytes: Buffer): Promise<void> {
    const fullPath = join(this.rootDir, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, bytes);
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
  const { db, storage, clock, raw } = params;

  if (raw.length === 0) {
    throw new AppError('PHOTO_REQUIRED', 400, 'A photo is required.');
  }
  if (raw.length > MAX_PHOTO_BYTES) {
    throw new AppError('PHOTO_INVALID', 400, 'Photo is too large (max 3 MB).');
  }
  if (!hasJpegOrPngMagicBytes(raw)) {
    throw new AppError('PHOTO_INVALID', 400, 'Photo must be a JPEG or PNG image.');
  }

  let processed: Buffer;
  try {
    processed = await sharp(raw)
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

  const hash = sha256(processed);

  if (params.ownerVisitorId) {
    const existing = await db
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

  const now = clock.now();
  const mediaId = randomUUID();
  const path = gatePhotoPath({ hostelId: params.hostelId, mediaId, now });

  const inserted = await db
    .insertInto('haven.media')
    .values({
      id: mediaId,
      kind: 'gate_photo' satisfies MediaKind,
      bucket: 'gate-photos',
      path,
      sha256: hash,
      bytes: processed.length,
      owner_user_id: params.ownerUserId ?? null,
      owner_visitor_id: params.ownerVisitorId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await storage.put(path, processed);

  return { photoId: inserted.id };
}
