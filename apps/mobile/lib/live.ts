import { useEffect, useRef, useState } from 'react';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import * as api from '../services/api-client.js';

/**
 * SDD §9.9 client side (web): `@microsoft/fetch-event-source`, so the Authorization
 * header can be sent. On each `visit` or `gate` event the screen refetches. If the
 * stream drops it reconnects with backoff (1 s, 2 s, 4 s … 30 s) and meanwhile polls
 * every 15 s. The native flavour is `live.native.ts`.
 */

export type LiveEvent = { type: 'visit' | 'gate'; id: string; s?: string; online?: boolean };
export const POLL_MS = 15_000;

class Fatal extends Error {}

export function useLiveUpdates(
  hostelId: string | null,
  onChange: (e: LiveEvent | null) => void,
): 'live' | 'polling' {
  const [status, setStatus] = useState<'live' | 'polling'>('polling');
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    if (!hostelId) return;
    const ctrl = new AbortController();
    let attempt = 0;
    let poll: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      setStatus('polling');
      if (!poll) poll = setInterval(() => cb.current(null), POLL_MS);
    };
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };
    startPolling();

    void fetchEventSource(api.streamUrl(hostelId), {
      signal: ctrl.signal,
      openWhenHidden: true,
      fetch: async (input, init) => {
        // Fresh access token on every (re)connect.
        const token = api.getAccessToken();
        return fetch(input, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string>),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
      },
      onopen: async (res) => {
        if (res.ok) {
          attempt = 0;
          stopPolling();
          setStatus('live');
          cb.current(null); // catch up on anything missed while disconnected
          return;
        }
        if (res.status === 401) {
          await api.getMe().catch(() => undefined); // triggers the refresh flow
          throw new Error('retry');
        }
        throw new Fatal(String(res.status)); // 403: no access — stay on polling
      },
      onmessage: (msg) => {
        if (msg.event !== 'visit' && msg.event !== 'gate') return;
        try {
          const data = JSON.parse(msg.data) as { id: string; s?: string; online?: boolean };
          cb.current({ type: msg.event, ...data });
        } catch {
          // ignore malformed events
        }
      },
      onclose: () => {
        throw new Error('closed'); // server ended the stream: reconnect
      },
      onerror: (err) => {
        startPolling();
        if (err instanceof Fatal) throw err;
        attempt += 1;
        return Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
      },
    }).catch(() => startPolling());

    return () => {
      ctrl.abort();
      stopPolling();
    };
  }, [hostelId]);

  return status;
}
