import { useEffect, useState } from 'react';

/**
 * Installable web app helpers (DEC-026 Phase 1), web flavour. The native app has its
 * own icon and keyboard handling, so `pwa.native.ts` is a no-op.
 *
 * - The service worker (public/sw.js) only caches the app shell; it is registered in
 *   exported builds, never under `expo start`, so development and the e2e suite are
 *   unaffected.
 * - A focused input is scrolled into view once the on-screen keyboard has opened (iPhone
 *   Safari doesn't resize the page; Android Chrome does, see public/index.html).
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
let started = false;

export function startPwa(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    listeners.forEach((l) => l());
  });

  document.addEventListener('focusin', (e) => {
    const el = e.target as HTMLElement | null;
    if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    window.setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
  });
}

/** True when running as an installed app (home-screen icon), on Android or iPhone. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac with touch.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export type InstallOption = 'prompt' | 'ios-steps' | 'browser-menu' | 'installed';

/** How this browser can install HAVEN right now. */
export function useInstallOption(): InstallOption {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  if (isStandalone()) return 'installed';
  if (deferredPrompt) return 'prompt';
  if (isIos()) return 'ios-steps';
  return 'browser-menu';
}

/** Shows Chrome's own install dialog (only when `useInstallOption()` is 'prompt'). */
export async function promptInstall(): Promise<void> {
  const p = deferredPrompt;
  if (!p) return;
  await p.prompt();
  await p.userChoice.catch(() => undefined);
  deferredPrompt = null;
  listeners.forEach((l) => l());
}
