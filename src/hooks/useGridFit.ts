import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { MAX_PX, fitFontSize } from '@/lib/gridFit';

/**
 * Sizes the heatmap's type to the box it has been given.
 *
 * The grid card is whatever height is left over after the header and the KPI tiles, so the
 * font size cannot be a constant — it has to come off a measurement. Returns the ref to put
 * on the scroll container and the size in px to publish as a CSS variable.
 *
 * `useLayoutEffect`, not `useEffect`: the first measurement has to land before paint, or the
 * wall display flashes a screen of MAX_PX type and then snaps down.
 */
export function useGridFit(rowCount: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [fontPx, setFontPx] = useState(MAX_PX);

  // The observer fires on the container's own resize; the row count changes independently of
  // it (a month tab with fewer SKUs), so measuring is its own callback that both paths call.
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setFontPx(fitFontSize(el.clientHeight, rowCount));
  }, [rowCount]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    // Guarded because jsdom has no ResizeObserver — the size then simply stays at whatever
    // the one-shot measurement above produced.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  return [ref, fontPx] as const;
}
