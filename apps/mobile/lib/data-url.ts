/**
 * Turns the live camera's `data:image/jpeg;base64,…` snapshot into a Blob for upload,
 * in memory. Fetching the data URL did the same, but the deployed web app's CSP
 * (`connect-src 'self'`, SDD §16.4) rightly blocks fetching `data:` URLs, so every photo
 * upload failed on the live site (phone test, 2026-11-28; DEC-032).
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  if (comma < 0 || !header.startsWith('data:') || !header.endsWith(';base64')) {
    throw new Error('Not a base64 data URL');
  }
  const mime = header.slice('data:'.length, -';base64'.length) || 'application/octet-stream';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
