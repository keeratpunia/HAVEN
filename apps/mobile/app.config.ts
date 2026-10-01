import type { ExpoConfig } from 'expo/config';

/**
 * Expo app config (SDD §20.1 names this file `app.config.ts`, not static `app.json`,
 * so env-driven values like EXPO_PUBLIC_* can be read at config time later). Bootstrap
 * milestone: identity/branding placeholders only — no product configuration
 * (deep-link schemes for invite/gate URLs, push credentials, etc. land with the
 * features that need them).
 */
const config: ExpoConfig = {
  name: 'HAVEN',
  slug: 'haven',
  version: '0.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  scheme: 'haven',
  plugins: ['expo-router'],
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
