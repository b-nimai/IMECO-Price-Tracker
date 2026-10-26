import { useEffect, useState } from 'react';

import { CONFIGURED } from '@/data/supabaseClient';

/** One async result, tagged with what it was fetched for so a stale answer is never shown. */
export interface Remote<T> {
  key: string;
  /** When the answer arrived — a render-safe "now" for anything measured against it. */
  at: number;
  data: T | null;
  error: string | null;
}

/**
 * Call `load(...args)` once per distinct `args`, for the tabs that read on demand rather than
 * on the 2-minute poll. Null until the first answer for these args; skipped entirely (stays
 * null) when Supabase is not configured or any arg is null.
 *
 * `load` must be a stable, module-level function — the fetchers in supabaseClient are.
 */
export function useRemote<A extends unknown[], T>(
  load: (...args: A) => Promise<T>,
  ...args: { [K in keyof A]: A[K] | null }
): Remote<T> | null {
  const key = JSON.stringify(args);
  const [state, setState] = useState<Remote<T> | null>(null);

  useEffect(() => {
    const parsed = JSON.parse(key) as A;
    if (!CONFIGURED || parsed.some((a) => a === null)) return;
    let live = true;
    load(...parsed).then(
      (data) => live && setState({ key, at: Date.now(), data, error: null }),
      (err) =>
        live &&
        setState({
          key,
          at: Date.now(),
          data: null,
          error: err instanceof Error ? err.message : String(err),
        }),
    );
    return () => {
      live = false;
    };
  }, [load, key]);

  return state?.key === key ? state : null;
}

/**
 * A view in supabase/schema.sql that the database does not have yet. PostgREST answers those
 * with a 404, which deserves "run the schema" rather than a raw error.
 */
export function isMissingView(error: string | null | undefined): boolean {
  return !!error && /\b404\b|PGRST205|does not exist/.test(error);
}
