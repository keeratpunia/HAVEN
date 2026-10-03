import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

/** SDD §13.7: "Offline: top banner 'You're offline. We'll retry.'" */
export function useOnline(): boolean {
  const [online, setOnline] = useState(
    Platform.OS !== 'web' || typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
