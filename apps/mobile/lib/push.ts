/**
 * Push, web flavour. HAVEN's push is Expo push to the Android app (SDD D6: "Reliable
 * push notifications are critical"); Expo push tokens don't exist in a browser, so on
 * the web fallback the resident gets the same notifications in-app (GET
 * /me/notifications, polled by the shell) and by SMS fallback (SDD §15.5: "Push to a
 * user with no active push token → ... SMS fallback immediately ... otherwise in-app
 * only"). The native flavour is `push.native.ts`.
 */

export type PushPermission = 'granted' | 'denied' | 'undetermined' | 'unsupported';

export async function registerForPush(): Promise<PushPermission> {
  return 'unsupported';
}

export async function getPushPermission(): Promise<PushPermission> {
  return 'unsupported';
}

/** Calls `onTap` with the tapped notification's data payload. */
export function subscribeToNotificationTaps(_onTap: (data: unknown) => void): () => void {
  return () => undefined;
}
