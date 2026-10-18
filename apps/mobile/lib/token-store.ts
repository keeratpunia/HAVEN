/**
 * Refresh-token storage, web flavour (SDD §9.5): on the web the refresh token is the
 * httpOnly `haven_rt` cookie the browser manages, so there is nothing for JS to keep.
 * The native flavour (`token-store.native.ts`) uses expo-secure-store.
 */
export const usesBodyRefreshToken = false;

export async function readRefreshToken(): Promise<string | null> {
  return null;
}

export async function writeRefreshToken(_token: string | null): Promise<void> {
  // The browser holds it as an httpOnly cookie.
}
