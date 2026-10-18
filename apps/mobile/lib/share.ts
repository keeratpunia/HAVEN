import { Linking, Platform, Share } from 'react-native';

/**
 * R-07 Share invite (SDD §13.4): "Share button (WhatsApp first), Copy link". HAVEN
 * never sends the invite itself (§15.4) — the host's own share sheet does.
 */

export async function shareOnWhatsApp(message: string): Promise<void> {
  await Linking.openURL(`https://wa.me/?text=${encodeURIComponent(message)}`);
}

/** The OS share sheet; false when the platform has none (desktop browsers). */
export async function shareSheet(message: string): Promise<boolean> {
  if (Platform.OS === 'web') {
    const nav = navigator as Navigator & { share?: (data: { text: string }) => Promise<void> };
    if (!nav.share) return false;
    try {
      await nav.share({ text: message });
    } catch {
      // The user closed the sheet.
    }
    return true;
  }
  await Share.share({ message });
  return true;
}

export const canShareSheet =
  Platform.OS !== 'web' ||
  (typeof navigator !== 'undefined' &&
    typeof (navigator as { share?: unknown }).share === 'function');

export async function copyText(text: string): Promise<boolean> {
  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
