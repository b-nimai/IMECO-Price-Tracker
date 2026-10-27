import { useEffect, useRef, useState } from 'react';

const reduced = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Animate a number from its previous value to `target` — the "tick up" on a KPI tile. */
export function useCountUp(target: number | null, ms = 700): number | null {
  const animate = target != null && !reduced();
  const [shown, setShown] = useState(target ?? 0);
  const from = useRef(0);

  useEffect(() => {
    if (!animate || target == null) return;
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      setShown(origin + (target - origin) * (1 - (1 - t) ** 3));
      if (t < 1) frame = requestAnimationFrame(step);
      else from.current = target;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [animate, target, ms]);

  return animate ? shown : target;
}
