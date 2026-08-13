import { useLayoutEffect, useState, type RefObject } from 'react';

import { MIN_NAME_PX, measureNames, nameColumnWidth } from '@/lib/nameWidth';

/**
 * The px width the name column needs for the longest name currently on the board.
 *
 * `container` is the grid element — it supplies both the width the cap is taken from and the
 * font family the measurement is made in. Reading the family off the DOM rather than naming it
 * here is deliberate: the cell inherits it, so a theme change moves both together and the
 * measurement cannot drift out of step with what is painted.
 *
 * `useLayoutEffect` for the same reason as `useGridFit`: the column must be sized before paint,
 * or the wall display shows one frame of truncated names.
 */
export function useNameWidth(
  container: RefObject<HTMLElement | null>,
  names: string[],
  fontPx: number,
): number {
  const [width, setWidth] = useState(MIN_NAME_PX);

  // Serialised so the effect re-runs when the CATALOGUE changes rather than on every render:
  // `rows.map(r => r.name)` is a fresh array on every poll even when nothing in it has
  // changed, and a raw array dependency would re-measure on each one.
  const key = JSON.stringify(names);

  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;

    const measure = () => {
      const family = getComputedStyle(el).fontFamily;
      const text = measureNames(JSON.parse(key) as string[], fontPx, family);
      setWidth(nameColumnWidth(text, el.clientWidth));
    };
    measure();

    // Webfonts land after first paint and are wider or narrower than the fallback that was
    // measured, so a name that fit can stop fitting. One re-measure when they are ready fixes
    // it. Optional-chained — jsdom has no `document.fonts`.
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) measure();
    });

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        cancelled = true;
      };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [container, key, fontPx]);

  return width;
}
