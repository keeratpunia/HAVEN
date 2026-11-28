import { useCallback, useEffect, useState } from 'react';
import type { VisitDetailDTO } from '@haven/shared';
import * as api from '../services/api-client.js';

/**
 * Loads one of the host's visits for R-08/R-09/R-10, and runs host actions with the
 * SDD §17.2 error rules: a 409 refetches and shows "This was updated by someone
 * else."; a 422 shows the rule's message; anything else shows the server message.
 */
export function useHostedVisit(id: string | undefined) {
  const [visit, setVisit] = useState<VisitDetailDTO | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!id) return;
    try {
      setVisit(await api.getHostedVisit(id));
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 404) setNotFound(true);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Opening the related screen counts as opening its notifications (SDD §9.7) — this
  // is what cancels the SMS fallback when the host came here from Home, not the push.
  useEffect(() => {
    if (!id) return;
    void api
      .getNotifications()
      .then((page) =>
        Promise.all(
          page.items
            .filter((n) => n.visitId === id && !n.openedAt)
            .map((n) => api.markNotificationOpened(n.id).catch(() => undefined)),
        ),
      )
      .catch(() => undefined);
  }, [id]);

  const run = useCallback(
    async (
      action: () => Promise<unknown>,
      ruleMessage: (code: string) => string,
    ): Promise<boolean> => {
      setBusy(true);
      setMessage(null);
      try {
        await action();
        await reload();
        return true;
      } catch (err) {
        if (err instanceof api.ApiError && err.status === 409) {
          setMessage('This was updated by someone else.');
          await reload();
        } else if (err instanceof api.ApiError && err.status === 410) {
          setMessage(err.message);
          await reload();
        } else if (err instanceof api.ApiError && err.status === 422) {
          setMessage(ruleMessage(err.code));
        } else if (err instanceof api.ApiError) {
          setMessage(err.message);
        } else {
          setMessage("Couldn't reach HAVEN. Check your connection and try again.");
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  return { visit, notFound, message, busy, reload, run };
}
