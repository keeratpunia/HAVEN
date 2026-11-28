import { Platform } from 'react-native';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { ANDROID_CHANNELS } from '@haven/shared';
import * as api from '../services/api-client.js';
import type { PushPermission } from './push.js';

/**
 * Push on Android (SDD §9.7, §15.1): create the three channels, ask permission, get
 * the Expo push token and register it with `POST /me/push-tokens`. Taps are routed by
 * the payload's `screen` (see `notification-routing.ts`).
 */

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  for (const channel of ANDROID_CHANNELS) {
    await Notifications.setNotificationChannelAsync(channel.id, {
      name: channel.name,
      importance:
        channel.importance === 'high'
          ? Notifications.AndroidImportance.HIGH
          : Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
    });
  }
}

function toPermission(status: Notifications.PermissionStatus): PushPermission {
  if (status === Notifications.PermissionStatus.GRANTED) return 'granted';
  if (status === Notifications.PermissionStatus.DENIED) return 'denied';
  return 'undetermined';
}

export async function getPushPermission(): Promise<PushPermission> {
  if (!Device.isDevice) return 'unsupported';
  const { status } = await Notifications.getPermissionsAsync();
  return toPermission(status);
}

export async function registerForPush(): Promise<PushPermission> {
  if (!Device.isDevice) return 'unsupported';
  await ensureChannels();
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== Notifications.PermissionStatus.GRANTED) {
    ({ status } = await Notifications.requestPermissionsAsync());
  }
  if (status !== Notifications.PermissionStatus.GRANTED) return toPermission(status);

  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
    ?.eas?.projectId;
  const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  await api.registerPushToken(token.data, Platform.OS === 'ios' ? 'ios' : 'android');
  return 'granted';
}

export function subscribeToNotificationTaps(onTap: (data: unknown) => void): () => void {
  // A tap that launched the app from a killed state.
  void Notifications.getLastNotificationResponseAsync().then((response) => {
    if (response) onTap(response.notification.request.content.data);
  });
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    onTap(response.notification.request.content.data);
  });
  return () => sub.remove();
}
