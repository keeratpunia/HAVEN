import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PhotoDTO } from '@haven/shared';
import type { Clock } from '../lib/clock.js';

/**
 * Signed photo URLs (SDD §9.10: "Signed URLs are created per API response with a
 * 120 s TTL. Clients must not persist them"; §12.1: "Photos: returned as
 * { url, expiresAt } signed URLs (120 s), never as paths").
 *
 * This is the local-disk stand-in for Supabase Storage's `createSignedUrl` (the same
 * `MediaStorage` seam DEC-004/`gate/media.ts` describe): the URL itself is the
 * credential — an HMAC over (mediaId, expiry) with a key derived from JWT_SECRET — so
 * an `<img>` tag can load it without an Authorization header, and it stops working
 * after 120 s.
 */

export const SIGNED_URL_TTL_SECONDS = 120;

export class MediaUrlSigner {
  private readonly key: Buffer;

  constructor(
    jwtSecretBase64: string,
    private readonly apiBaseUrl: string,
    private readonly clock: Clock,
  ) {
    this.key = createHmac('sha256', Buffer.from(jwtSecretBase64, 'base64'))
      .update('haven-media-url-v1')
      .digest();
  }

  private signature(mediaId: string, exp: number): string {
    return createHmac('sha256', this.key).update(`${mediaId}.${exp}`).digest('base64url');
  }

  sign(mediaId: string): PhotoDTO {
    const exp = Math.floor(this.clock.now().getTime() / 1000) + SIGNED_URL_TTL_SECONDS;
    const base = this.apiBaseUrl.replace(/\/$/, '');
    return {
      url: `${base}/v1/media/${mediaId}?exp=${exp}&sig=${this.signature(mediaId, exp)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  signOrNull(mediaId: string | null | undefined): PhotoDTO | null {
    return mediaId ? this.sign(mediaId) : null;
  }

  verify(mediaId: string, exp: number, sig: string): boolean {
    if (exp * 1000 < this.clock.now().getTime()) return false;
    const expected = Buffer.from(this.signature(mediaId, exp));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}
