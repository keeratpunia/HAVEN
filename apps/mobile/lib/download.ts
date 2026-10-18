import { Platform, Share } from 'react-native';

/**
 * Saves a CSV the API produced (W-03 export, W-12 export). Web: a download link;
 * Android: the share sheet with the CSV text (no file-system module in this app).
 */
export async function saveCsv(filename: string, csv: string): Promise<void> {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  await Share.share({ title: filename, message: csv });
}

/** Share plain text (W-03 "Share"). */
export async function shareText(title: string, text: string): Promise<void> {
  if (Platform.OS === 'web') {
    const nav = globalThis.navigator as Navigator & {
      share?: (d: { title: string; text: string }) => Promise<void>;
    };
    if (nav?.share) {
      await nav.share({ title, text }).catch(() => undefined);
      return;
    }
    await nav?.clipboard?.writeText(text).catch(() => undefined);
    return;
  }
  await Share.share({ title, message: text });
}

export function printPage(): void {
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.print();
}
