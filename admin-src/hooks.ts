// Data-fetching hook that maps ApiError → auth/forbidden/error UI states.
import { useState, useEffect, useCallback } from 'preact/hooks';
import { ApiError } from './api';

export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  forbidden: boolean;
  unauthorized: boolean;
  reload: () => void;
}

export function useResource<T>(loader: () => Promise<T>, deps: any[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setForbidden(false);
    setUnauthorized(false);
    loader()
      .then((d) => { if (alive) setData(d); })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) setUnauthorized(true);
        else if (e instanceof ApiError && e.status === 403) setForbidden(true);
        else setError(e?.message || 'Error');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [...deps, tick]);

  return { data, loading, error, forbidden, unauthorized, reload };
}
