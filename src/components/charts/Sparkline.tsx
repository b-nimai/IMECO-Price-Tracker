import { useId, useState, type PointerEvent } from 'react';

import { cn } from '@/lib/utils';

export interface SparkSeries {
  /** One value per slot, oldest first; null is a gap. All series share the slots. */
  values: (number | null)[];
  color: string;
  label?: string;
}

interface Props {
  series: SparkSeries[];
  /** Label per slot for the hover readout, e.g. a date. */
  slots?: string[];
  format?: (v: number) => string;
  height?: number;
  /** A soft fill under a single series. */
  area?: boolean;
  className?: string;
}

/**
 * A small line chart with no axes: the shape of a number over time, for tiles, cards and rows.
 * Hovering shows the value at that slot. Width follows the container.
 */
export function Sparkline({ series, slots, format = String, height = 32, area, className }: Props) {
  const gid = useId();
  const [hover, setHover] = useState<number | null>(null);
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  if (n < 2 || !all.length) {
    return (
      <div className={cn('text-[10px] text-muted-foreground/60', className)}>No history yet</div>
    );
  }
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const W = 100;
  const pad = 3;
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (height - pad * 2);

  function path(values: (number | null)[]): string {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`;
      pen = true;
    });
    return d;
  }

  function onMove(e: PointerEvent<HTMLDivElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - box.left) / box.width) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  }

  const lastOf = (values: (number | null)[]) => {
    for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return i;
    return -1;
  };

  return (
    <div
      className={cn('relative w-full', className)}
      style={{ height }}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      <svg
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        className="size-full overflow-visible"
      >
        {area && series.length === 1 && (
          <>
            <defs>
              <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={series[0].color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={series[0].color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <path
              d={`${path(series[0].values)}L${x(lastOf(series[0].values))},${height}L${x(
                series[0].values.findIndex((v) => v != null),
              )},${height}Z`}
              fill={`url(#${gid})`}
            />
          </>
        )}
        {series.map((s, k) => (
          <path
            key={k}
            d={path(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {hover != null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={0}
            y2={height}
            stroke="var(--axis-ink)"
            strokeOpacity={0.4}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {/* End dots are HTML so they stay round however the SVG is stretched. */}
      {series.map((s, k) => {
        const i = hover ?? lastOf(s.values);
        const v = s.values[i];
        if (i < 0 || v == null) return null;
        return (
          <span
            key={k}
            className="pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
            style={{ left: `${x(i)}%`, top: y(v), background: s.color }}
          />
        );
      })}
      {hover != null && (
        <div
          className="pointer-events-none absolute bottom-full z-20 mb-1 -translate-x-1/2 rounded-md border border-border bg-popover px-2 py-1 text-[11px] whitespace-nowrap text-foreground shadow-lg"
          style={{ left: `${Math.min(85, Math.max(15, x(hover)))}%` }}
        >
          {slots?.[hover] && <div className="text-muted-foreground">{slots[hover]}</div>}
          {series.map((s, k) =>
            s.values[hover] != null ? (
              <div key={k} className="flex items-center gap-1.5 tabular-nums">
                <span className="size-1.5 rounded-full" style={{ background: s.color }} />
                {s.label && <span className="text-muted-foreground">{s.label}</span>}
                <span className="font-semibold">{format(s.values[hover] as number)}</span>
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
