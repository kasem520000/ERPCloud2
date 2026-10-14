'use client';

import { useCallback, useEffect, useState } from 'react';

export type AsyncState<T> = { status: 'loading' | 'ready' | 'error'; data?: T; error: string; reload: () => void };

/** Minimal data hook: one request, an Arabic error string, and a manual reload. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; data?: T; error: string }>({ status: 'loading', error: '' });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let live = true;
    setState({ status: 'loading', error: '' });
    load()
      .then((data) => live && setState({ status: 'ready', data, error: '' }))
      .catch((error: Error) => live && setState({ status: 'error', error: error.message || 'تعذّر تحميل البيانات' }));
    return () => {
      live = false;
    };
  }, [...deps, nonce]);

  return { ...state, reload };
}
