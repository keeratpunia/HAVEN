import { useEffect, useRef, useState } from 'react';
import EventSource from 'react-native-sse';
import * as api from '../services/api-client.js';
import type { LiveEvent } from './live.js';

/**
 * SDD §9.9 on Android: `react-native-sse` (sends the Authorization header). Same
 * contract as the web hook: refetch on events, 15 s polling while disconnected,
 * reconnect with backoff.
 */
export { POLL_MS } from './live.js';
export type { LiveEvent } from './live.js';

export function useLiveUpdates(
  hostelId: string | null,
  onChange: (e: LiveEvent | null) => void,
): 'live' | 'polling' {
  const [status, setStatus] = useState<'live' | 'polling'>('polling');
  const cb = useRef(onChange);
  cb.current = onChange;
  const live = useRef(false);

  useEffect(() => {
    if (!hostelId) return;
    let closed = false;
    let attempt = 0;
    let es: EventSource<'visit' | 'gate' | 'ping'> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const poll = setInterval(() => {
      if (!live.current) cb.current(null);
    }, 15_000);

    const connect = () => {
      const token = api.getAccessToken();
      es = new EventSource<'visit' | 'gate' | 'ping'>(api.streamUrl(hostelId), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        pollingInterval: 0,
      });
      es.addEventListener('open', () => {
        attempt = 0;
        live.current = true;
        setStatus('live');
        cb.current(null);
      });
      for (const type of ['visit', 'gate'] as const) {
        es.addEventListener(type, (e) => {
          try {
            cb.current({
              type,
              ...(JSON.parse((e as { data?: string }).data ?? '{}') as { id: string }),
            });
          } catch {
            // ignore
          }
        });
      }
      es.addEventListener('error', () => {
        live.current = false;
        setStatus('polling');
        es?.close();
        if (closed) return;
        attempt += 1;
        void api.getMe().catch(() => undefined);
        retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5)));
      });
    };
    connect();
    return () => {
      closed = true;
      clearInterval(poll);
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [hostelId]);

  return status;
}
