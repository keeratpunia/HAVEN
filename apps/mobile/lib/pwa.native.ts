/** Android app: installed from the APK, so there is nothing to install or register. */
export function startPwa(): void {}

export function isStandalone(): boolean {
  return true;
}

export function isIos(): boolean {
  return false;
}

export type InstallOption = 'prompt' | 'ios-steps' | 'browser-menu' | 'installed';

export function useInstallOption(): InstallOption {
  return 'installed';
}

export async function promptInstall(): Promise<void> {}
