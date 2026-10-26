import { useCallback, useEffect, useState } from 'react';

/**
 * The selected tab, mirrored in `location.hash` so a tab can be linked to and survives a
 * reload. A missing or unknown hash means `fallback` — which is what the wall display, opened
 * at the bare URL, always gets.
 */
export function useHashTab<T extends string>(
  tabs: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const read = useCallback((): T => {
    const hash = window.location.hash.slice(1) as T;
    return tabs.includes(hash) ? hash : fallback;
  }, [tabs, fallback]);

  const [tab, setTab] = useState<T>(read);

  useEffect(() => {
    const onChange = () => setTab(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, [read]);

  const select = useCallback(
    (next: T) => {
      // replaceState rather than assigning location.hash: switching tabs should not pile up
      // history entries, and assigning the hash would also jump-scroll to a matching id.
      const url =
        next === fallback ? window.location.pathname + window.location.search : `#${next}`;
      window.history.replaceState(null, '', url);
      setTab(next);
    },
    [fallback],
  );

  return [tab, select];
}
