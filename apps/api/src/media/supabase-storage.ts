import { assertMediaObject, type MediaObject, type MediaStorage } from '../gate/media.js';

/**
 * Supabase Storage behind the `MediaStorage` seam (SDD §9.10: three private buckets,
 * `visitor-photos` / `gate-photos` / `resident-docs`; "Signed URLs are created per API
 * response with a 120 s TTL").
 *
 * Talks to the Storage REST API with the service-role key, server side only (the key
 * never reaches a client, CLAUDE.md §4). The buckets are private: objects are read with
 * the key or through a signed URL, never a public path.
 *
 * Endpoints (Supabase Storage API):
 * - `POST   /storage/v1/object/{bucket}/{path}`               upload
 * - `GET    /storage/v1/object/authenticated/{bucket}/{path}` download (private)
 * - `DELETE /storage/v1/object/{bucket}` `{ prefixes: [path] }` delete
 * - `POST   /storage/v1/object/sign/{bucket}/{path}` `{ expiresIn }` signed URL
 */

const TIMEOUT_MS = 10_000;

export class SupabaseMediaStorage implements MediaStorage {
  private readonly base: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `${supabaseUrl.replace(/\/$/, '')}/storage/v1`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.serviceRoleKey}`,
      apikey: this.serviceRoleKey,
      ...extra,
    };
  }

  private objectPath(object: MediaObject): string {
    assertMediaObject(object);
    return `${object.bucket}/${object.path.split('/').map(encodeURIComponent).join('/')}`;
  }

  private call(path: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(`${this.base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async put(object: MediaObject, bytes: Buffer): Promise<void> {
    const res = await this.call(`/object/${this.objectPath(object)}`, {
      method: 'POST',
      // Paths are new UUIDs, so an upsert only matters for a retried upload.
      headers: this.headers({ 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }),
      body: new Uint8Array(bytes),
    });
    if (!res.ok) throw await storageError('upload', res);
  }

  async get(object: MediaObject): Promise<Buffer | null> {
    const res = await this.call(`/object/authenticated/${this.objectPath(object)}`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (await isNotFound(res)) return null;
    throw await storageError('download', res);
  }

  async delete(object: MediaObject): Promise<void> {
    assertMediaObject(object);
    const res = await this.call(`/object/${object.bucket}`, {
      method: 'DELETE',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: [object.path] }),
    });
    // Deleting an object that is already gone is not an error (MediaStorage contract).
    if (!res.ok && !(await isNotFound(res))) throw await storageError('delete', res);
  }

  /** A time-limited URL for one private object; null when it no longer exists. */
  async signedUrl(object: MediaObject, ttlSeconds: number): Promise<string | null> {
    const res = await this.call(`/object/sign/${this.objectPath(object)}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: ttlSeconds }),
    });
    if (!res.ok) {
      if (await isNotFound(res)) return null;
      throw await storageError('sign', res);
    }
    const body = (await res.json()) as { signedURL?: unknown };
    if (typeof body.signedURL !== 'string' || !body.signedURL.startsWith('/')) {
      throw new Error('media storage sign failed: unexpected response');
    }
    return `${this.base}${body.signedURL}`;
  }
}

/** Storage answers a missing object with 404, or (older versions) 400 + statusCode "404". */
async function isNotFound(res: Response): Promise<boolean> {
  if (res.status === 404) return true;
  if (res.status !== 400) return false;
  try {
    const body = (await res.clone().json()) as { statusCode?: unknown; error?: unknown };
    return String(body.statusCode) === '404' || body.error === 'not_found';
  } catch {
    return false;
  }
}

/** Status only: the response body may echo the path, which is not logged (§16.4). */
async function storageError(op: string, res: Response): Promise<Error> {
  await res.body?.cancel().catch(() => undefined);
  return new Error(`media storage ${op} failed: HTTP ${res.status}`);
}
