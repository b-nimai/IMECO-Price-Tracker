import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CONFIGURED,
  clearCache,
  fetchDemo,
  fetchPrices,
  isStale,
  readCache,
  writeCache,
} from '@/data/supabaseClient';
import { buildPriceData, type PriceData } from '@/data/types';

// Poll often. The file is small and served from a CDN edge, and the point of polling this
// briskly is that a desktop run appears on the wall display within a couple of minutes rather
// than whenever someone next reloads.
const REFRESH_MS = 2 * 60 * 1000;
const MAX_FAILURES = 30; // ~1h of consecutive failures → reload the page

export interface UsePriceData {
  data: PriceData | null;
  fetchedAt: number | null;
  syncing: boolean;
  error: string | null;
  configured: boolean;
  /** True when rendering the bundled demo scrape rather than live database rows. */
  demo: boolean;
  refresh: () => void;
}

/** Hydrate from localStorage synchronously so a reload paints instantly and costs 0 requests. */
function hydrate(): { data: PriceData; fetchedAt: number } | null {
  const cached = readCache();
  if (!cached) return null;
  try {
    return {
      data: buildPriceData(cached.products, cached.snapshots, cached.previous),
      fetchedAt: cached.fetchedAt,
    };
  } catch {
    return null; // shape changed since it was written — refetch
  }
}

export function usePriceData(): UsePriceData {
  // Lazy state initialiser rather than a ref: this runs exactly once and its value IS read
  // during render, which is precisely what refs must not be used for.
  const [initial] = useState(hydrate);

  const [data, setData] = useState<PriceData | null>(initial?.data ?? null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(initial?.fetchedAt ?? null);
  const [syncing, setSyncing] = useState(!initial);
  const [error, setError] = useState<string | null>(null);

  const failures = useRef(0);
  const lastGood = useRef<PriceData | null>(initial?.data ?? null);

  const load = useCallback(async () => {
    setSyncing(true);
    try {
      // Without a database, fall back to the captured scrape so the dashboard is still
      // demonstrable. Same shapes, same rendering path — only the source differs.
      const payload = CONFIGURED ? await fetchPrices() : await fetchDemo();
      const parsed = buildPriceData(payload.products, payload.snapshots, payload.previous);
      const cached = writeCache(payload);

      lastGood.current = parsed;
      setData(parsed);
      setFetchedAt(cached.fetchedAt);
      setError(null);
      failures.current = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[prices]', message);
      setError(message);
      failures.current += 1;
      if (failures.current >= MAX_FAILURES) window.location.reload();
      // Keep the last known good picture on screen rather than blanking the wall display.
      if (lastGood.current) setData(lastGood.current);
    } finally {
      setSyncing(false);
    }
  }, []);

  const refresh = useCallback(() => {
    clearCache();
    void load();
  }, [load]);

  useEffect(() => {
    const interval = setInterval(() => void load(), REFRESH_MS);

    // A fresh cache hit skips the boot fetch entirely — that's the zero-request reload.
    if (initial && !isStale(initial.fetchedAt)) return () => clearInterval(interval);

    // Deferred a tick so the cached (or skeleton) paint lands before revalidation starts,
    // rather than the fetch's setState cascading onto the mount render.
    const boot = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(boot);
      clearInterval(interval);
    };
  }, [load, initial]);

  return { data, fetchedAt, syncing, error, configured: CONFIGURED, demo: !CONFIGURED, refresh };
}
