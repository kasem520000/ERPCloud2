'use client';

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from './api';

export type QueryState<T> = {
  status: 'loading' | 'success' | 'error' | 'forbidden';
  data?: T;
  error?: string;
  reload: () => void;
};

/** Minimal data hook — no cache, explicit states, forbidden separated from error. */
export function useQuery<T>(loader: () => Promise<T>, deps: unknown[] = []): QueryState<T> {
  const [state, setState] = useState<{ status: QueryState<T>['status']; data?: T; error?: string }>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);

  // The loader identity changes on every render by design; the caller controls
  // re-running through `deps`.
  const run = useCallback(loader, deps);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    run()
      .then((data) => {
        if (!cancelled) setState({ status: 'success', data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.isForbidden) {
          setState({ status: 'forbidden', error: error.message });
          return;
        }
        setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [run, nonce]);

  return { ...state, reload: () => setNonce((value) => value + 1) };
}
