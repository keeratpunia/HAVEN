import type { ExpoConfig } from 'expo/config';

/**
 * Expo app config (SDD §20.1 names this file `app.config.ts`, not static `app.json`,
 * so env-driven values like EXPO_PUBLIC_* can be read at config time). The resident
 * app milestone added the native modules' config plugins (push, camera, location,
 * secure storage).
 */
const config: ExpoConfig = {
  name: 'HAVEN',
  slug: 'haven',
  version: '0.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  scheme: 'haven',
  plugins: [
    'expo-router',
    'expo-secure-store',
    // SDD §15.1: push for the resident app; channels are created at runtime.
    ['expo-notifications', { color: '#0F766E' }],
    [
      'expo-camera',
      {
        cameraPermission:
          'HAVEN uses the camera to scan the gate QR and take live photos at the gate.',
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'HAVEN checks your location only at the hostel gate, never otherwise.',
      },
    ],
  ],
  extra: {
    // EAS project id, needed by expo-notifications' getExpoPushTokenAsync on device.
    eas: { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID },
  },
  ios: {
    supportsTablet: true,
  },
  android: {
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
  },
  web: {
    favicon: './assets/favicon.png',
    bundler: 'metro',
  },
};

export default config;
