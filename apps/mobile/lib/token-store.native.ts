import * as SecureStore from 'expo-secure-store';

/**
 * Refresh-token storage on Android (SDD §9.5: "Native: expo-secure-store"). Native
 * clients send `X-Client: native` and receive the refresh token in the response body
 * instead of a cookie.
 */
export const usesBodyRefreshToken = true;

const KEY = 'haven.refreshToken';

export async function readRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY);
}

export async function writeRefreshToken(token: string | null): Promise<void> {
  if (token) await SecureStore.setItemAsync(KEY, token);
  else await SecureStore.deleteItemAsync(KEY);
}
