import { describe, expect, it } from 'vitest';
import { chromeIntentUrl, detectInAppBrowser } from './in-app-browser.js';

/** E-03: WhatsApp / Instagram / Facebook in-app browsers are detected by user agent. */

const UA = {
  instagramAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A.240205.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.105 Mobile Safari/537.36 Instagram 321.0.0.39.106 Android (34/14; 420dpi; 1080x2400; Google/google; Pixel 7; panther; panther; en_IN; 573418395)',
  instagramIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 321.0.2.21.107 (iPhone14,5; iOS 17_4; en_IN; en-IN; scale=3.00; 1170x2532; 574000000)',
  facebookAndroid:
    'Mozilla/5.0 (Linux; Android 13; SM-A536E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/121.0.6167.178 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.42.109;]',
  facebookIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0.38.108;FBBV/567890123;FBDV/iPhone13,2;FBMD/iPhone;FBSN/iOS;FBSV/16.6;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]',
  whatsappAndroid:
    'Mozilla/5.0 (Linux; Android 12; Redmi Note 11; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 WhatsApp/2.24.4.76',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  safariIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  samsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36',
};

describe('detectInAppBrowser (E-03)', () => {
  it('recognises Instagram, Facebook and WhatsApp on Android and iOS', () => {
    expect(detectInAppBrowser(UA.instagramAndroid)).toEqual({ app: 'instagram', os: 'android' });
    expect(detectInAppBrowser(UA.instagramIos)).toEqual({ app: 'instagram', os: 'ios' });
    expect(detectInAppBrowser(UA.facebookAndroid)).toEqual({ app: 'facebook', os: 'android' });
    expect(detectInAppBrowser(UA.facebookIos)).toEqual({ app: 'facebook', os: 'ios' });
    expect(detectInAppBrowser(UA.whatsappAndroid)).toEqual({ app: 'whatsapp', os: 'android' });
  });

  it('leaves normal browsers alone', () => {
    expect(detectInAppBrowser(UA.chromeAndroid)).toBeNull();
    expect(detectInAppBrowser(UA.safariIos)).toBeNull();
    expect(detectInAppBrowser(UA.samsung)).toBeNull();
    expect(detectInAppBrowser('')).toBeNull();
    expect(detectInAppBrowser(undefined)).toBeNull();
  });
});

describe('chromeIntentUrl (E-03 "Android intent URL")', () => {
  it('opens the same page in Chrome, falling back to the page itself', () => {
    const href = 'https://app.haven.example/g/GH8A01.177958201.7K3Q9A2M4XBN6PDR?resumed=1';
    expect(chromeIntentUrl(href)).toBe(
      'intent://app.haven.example/g/GH8A01.177958201.7K3Q9A2M4XBN6PDR?resumed=1' +
        '#Intent;scheme=https;package=com.android.chrome;' +
        `S.browser_fallback_url=${encodeURIComponent(href)};end`,
    );
  });

  it('refuses anything but http(s)', () => {
    expect(() => chromeIntentUrl('javascript:alert(1)')).toThrow();
  });
});
