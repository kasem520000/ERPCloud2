'use client';

import { useCallback, useEffect, useState } from 'react';

import { REP_QUEUE_EVENT } from '../lib/offline/rep-db';

/**
 * M5 — the read hook for the offline stores: reads on mount, re-reads whenever the
 * queue changes (a new op was enqueued) or the caller bumps `reloadKey` (e.g. after a
 * sync cycle). Reading is safe offline — that is the point.
 */
export function useOfflineRead<T>(reader: () => Promise<T>, reloadKey: unknown = 0): {
  data: T | undefined;
  loading: boolean;
  error: string | undefined;
  reload: () => void;
} {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    reader()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(undefined);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // The reader is expected to be a stable module-level function (listCustomers etc.).
  }, [tick, reloadKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => reload();
    window.addEventListener(REP_QUEUE_EVENT, handler);
    return () => window.removeEventListener(REP_QUEUE_EVENT, handler);
  }, [reload]);

  return { data, loading, error, reload };
}
