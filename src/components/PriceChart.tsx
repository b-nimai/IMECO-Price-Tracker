import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';

import { formatAmount, formatPrice } from '@/data/format';
import { MARKETPLACE_COLORS, MARKETPLACE_LABELS, type Marketplace } from '@/data/types';

// Hand-rolled SVG rather than a charting library, for the same reason supabaseClient.ts is plain
// fetch: one chart does not justify ~100 KB of bundle.

export interface SeriesPoint {
  t: number;
  price: number | null;
  status: string;
}

export interface Series {
  marketplace: Marketplace;
  /** Oldest first. */
  points: SeriesPoint[];
  target: number | null;
}

interface Props {
  series: Series[];
  from: number;
  to: number;
}

const PLOT_H = 260;
const RIBBON_H = 10;
const RIBBON_GAP = 5;
// Left margin fits both the ₹ axis labels and the marketplace names on the stock strips.
const M = { top: 12, right: 16, bottom: 26, left: 64 };

/** A reading the chart can draw as a price. Same rule as the heatmap's. */
function priced(p: SeriesPoint): boolean {
  return p.price != null && (p.status === 'ok' || p.status === 'out_of_stock');
}

/** 1, 2 or 5 × 10^k ticks — about four of them across the domain. */
function niceTicks(lo: number, hi: number): number[] {
  const raw = (hi - lo) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  return ticks;
}

const DAY = 86_400_000;
const dayLabel = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });
const hourLabel = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric' });
const stampLabel = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/** Index of the last point at or before `t`, or -1. Points are sorted by time. */
function lastAtOrBefore(points: SeriesPoint[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * One marketplace's period in plain words, e.g. "₹165 → ₹172 · 1 change · out of stock since
 * 26 Oct, 2 pm". The chart shows the shape; this says what happened, so nobody has to decode
 * lines to learn that nothing moved.
 */
function describe(points: SeriesPoint[]): string {
  const withPrice = points.filter(priced);
  const parts: string[] = [];

  if (withPrice.length) {
    let changes = 0;
    for (let i = 1; i < withPrice.length; i++) {
      if (withPrice[i].price !== withPrice[i - 1].price) changes += 1;
    }
    const first = withPrice[0].price as number;
    const last = withPrice[withPrice.length - 1].price as number;
    if (changes === 0) {
      parts.push(`steady at ${formatPrice(last)}`);
    } else {
      const times = `${changes} change${changes === 1 ? '' : 's'}`;
      // "₹172 → ₹172" reads as a mistake; say the price came back instead.
      parts.push(
        first === last
          ? `back at ${formatPrice(last)} after ${times}`
          : `${formatPrice(first)} → ${formatPrice(last)} · ${times}`,
      );
      const prices = withPrice.map((p) => p.price as number);
      const lo = Math.min(...prices);
      const hi = Math.max(...prices);
      if (lo < Math.min(first, last) || hi > Math.max(first, last)) {
        parts.push(`range ${formatPrice(lo)}–${formatPrice(hi)}`);
      }
    }
  } else if (points.length) {
    parts.push('no price recorded');
  }

  // How long the CURRENT state has lasted, when it is not "selling".
  const now = points[points.length - 1];
  if (now && now.status !== 'ok') {
    let i = points.length - 1;
    while (i > 0 && points[i - 1].status === now.status) i -= 1;
    const what = now.status === 'out_of_stock' ? 'out of stock' : now.status.replace('_', ' ');
    parts.push(i > 0 ? `${what} since ${stampLabel.format(points[i].t)}` : `${what} all period`);
  }
  return parts.join(' · ');
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measured once up front as well: the observer's first callback is not guaranteed before
    // the first paint, and a zero width renders nothing at all.
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function PriceChart({ series, from, to }: Props) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hoverT, setHoverT] = useState<number | null>(null);

  const ribbonsH = series.length * (RIBBON_H + RIBBON_GAP);
  const height = M.top + PLOT_H + 12 + ribbonsH + M.bottom;
  const plotW = Math.max(0, width - M.left - M.right);

  const geometry = useMemo(() => {
    // Start the axis at the first reading, not at the start of the range: when the scraper was
    // off for days, a fixed 7-day axis spent most of its width on nothing. What was skipped is
    // said in words under the chart instead.
    const first = Math.min(...series.map((s) => s.points[0]?.t ?? Infinity));
    const start = Number.isFinite(first) && first > from ? first : from;
    const values = series.flatMap((s) => [
      ...s.points.filter(priced).map((p) => p.price as number),
      ...(s.target != null ? [s.target] : []),
    ]);
    if (!values.length) return null;

    let lo = Math.min(...values);
    let hi = Math.max(...values);
    const pad = Math.max((hi - lo) * 0.08, hi * 0.03, 1);
    lo -= pad;
    hi += pad;

    const x = (t: number) => M.left + ((t - start) / (to - start)) * plotW;
    const y = (v: number) => M.top + PLOT_H - ((v - lo) / (hi - lo)) * PLOT_H;

    const paths = series.map((s) => {
      // Step-after: a price holds until the next reading changes it, which is what a listing
      // actually does. A straight diagonal would invent prices nobody was ever offered.
      let solid = '';
      let dashed = '';
      for (let i = 1; i < s.points.length; i++) {
        const a = s.points[i - 1];
        const b = s.points[i];
        if (!priced(a) || !priced(b)) continue; // a failed or missing reading is a gap, not a line
        const seg = `M${x(a.t)},${y(a.price as number)}H${x(b.t)}V${y(b.price as number)}`;
        if (a.status === 'out_of_stock' || b.status === 'out_of_stock') dashed += seg;
        else solid += seg;
      }
      const last = [...s.points].reverse().find(priced) ?? null;
      return { marketplace: s.marketplace, solid, dashed, last };
    });

    const span = to - start;
    const HOUR = 3_600_000;
    const every =
      span <= 2 * DAY ? 6 * HOUR : span <= 8 * DAY ? DAY : span <= 31 * DAY ? 5 * DAY : 15 * DAY;
    const xTicks: number[] = [];
    const midnight = new Date(start);
    midnight.setHours(0, 0, 0, 0);
    for (let t = midnight.getTime(); t < to; t += every) if (t > start) xTicks.push(t);
    const tickLabel = every < DAY ? hourLabel : dayLabel;

    // Price at the end of each line, so the latest number sits on the line itself. Placed top
    // to bottom and skipped where it would collide with the label above it.
    const endLabels: { marketplace: Marketplace; x: number; y: number; text: string }[] = [];
    for (const p of [...paths]
      .filter((p) => p.last)
      .sort((a, b) => y(a.last!.price as number) - y(b.last!.price as number))) {
      const ly = y(p.last!.price as number) - 8;
      if (endLabels.some((l) => Math.abs(l.y - ly) < 14)) continue;
      endLabels.push({
        marketplace: p.marketplace,
        x: x(p.last!.t),
        y: ly,
        text: formatPrice(p.last!.price as number),
      });
    }
    const anyDashed = paths.some((p) => p.dashed);

    return { x, y, paths, yTicks: niceTicks(lo, hi), xTicks, tickLabel, start, endLabels, anyDashed };
  }, [series, from, to, plotW]);

  function onMove(e: PointerEvent<SVGRectElement>) {
    if (!geometry) return;
    const box = e.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    setHoverT(geometry.start + fraction * (to - geometry.start));
  }

  const hover =
    hoverT != null && geometry
      ? series.map((s) => {
          const i = lastAtOrBefore(s.points, hoverT);
          return { marketplace: s.marketplace, point: i >= 0 ? s.points[i] : null };
        })
      : null;

  const ribbonTop = M.top + PLOT_H + 12;

  return (
    <div className="flex flex-col gap-2">
      {/* Legend and summary in one: who each line is, and what it did in this period in
          words. Identity never rests on line colour alone. */}
      <ul className="flex flex-col gap-1 text-sm">
        {series.map((s) => (
          <li key={s.marketplace} className="flex flex-wrap items-center gap-x-2">
            <span
              className="inline-block h-[3px] w-5 rounded-full"
              style={{ background: MARKETPLACE_COLORS[s.marketplace] }}
              aria-hidden
            />
            <span className="w-16 font-medium text-foreground">
              {MARKETPLACE_LABELS[s.marketplace]}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {describe(s.points)}
              {s.target != null && ` · target ${formatPrice(s.target)}`}
            </span>
          </li>
        ))}
      </ul>

      <div ref={wrapRef} className="relative w-full">
        {width > 0 && !geometry && (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No prices recorded in this period.
          </p>
        )}

        {width > 0 && geometry && (
          <svg width={width} height={height} role="img" aria-label="Price history by marketplace">
            {geometry.yTicks.map((v) => (
              <g key={v}>
                <line
                  x1={M.left}
                  x2={width - M.right}
                  y1={geometry.y(v)}
                  y2={geometry.y(v)}
                  className="stroke-border"
                  strokeWidth={1}
                />
                <text
                  x={M.left - 8}
                  y={geometry.y(v)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-muted-foreground text-xs tabular-nums"
                >
                  ₹{formatAmount(v)}
                </text>
              </g>
            ))}

            {geometry.xTicks.map((t) => (
              <text
                key={t}
                x={geometry.x(t)}
                y={height - 6}
                textAnchor="middle"
                className="fill-muted-foreground text-xs"
              >
                {geometry.tickLabel.format(t)}
              </text>
            ))}

            {series.map(
              (s) =>
                s.target != null && (
                  <line
                    key={`target-${s.marketplace}`}
                    x1={M.left}
                    x2={width - M.right}
                    y1={geometry.y(s.target)}
                    y2={geometry.y(s.target)}
                    stroke={MARKETPLACE_COLORS[s.marketplace]}
                    strokeOpacity={0.45}
                    strokeWidth={1}
                    strokeDasharray="2 4"
                  />
                ),
            )}

            {geometry.paths.map((p) => (
              <g key={p.marketplace} stroke={MARKETPLACE_COLORS[p.marketplace]} fill="none">
                <path d={p.solid} strokeWidth={2} strokeLinejoin="round" />
                <path d={p.dashed} strokeWidth={2} strokeDasharray="4 4" />
                {p.last && (
                  <circle
                    cx={geometry.x(p.last.t)}
                    cy={geometry.y(p.last.price as number)}
                    r={4}
                    fill={MARKETPLACE_COLORS[p.marketplace]}
                    className="stroke-card"
                    strokeWidth={2}
                  />
                )}
              </g>
            ))}

            {geometry.endLabels.map((l) => (
              <text
                key={`end-${l.marketplace}`}
                x={l.x}
                y={l.y}
                textAnchor="end"
                className="fill-foreground text-xs font-medium tabular-nums"
              >
                {l.text}
              </text>
            ))}

            {/* Availability ribbons: one strip per marketplace under the plot. */}
            {series.map((s, row) => {
              const top = ribbonTop + row * (RIBBON_H + RIBBON_GAP);
              return (
                <g key={`ribbon-${s.marketplace}`}>
                  <text
                    x={M.left - 8}
                    y={top + RIBBON_H / 2}
                    dy="0.32em"
                    textAnchor="end"
                    className="fill-muted-foreground text-[11px]"
                  >
                    {MARKETPLACE_LABELS[s.marketplace]}
                  </text>
                  {s.points.map((p, i) => {
                    if (p.status !== 'ok' && p.status !== 'out_of_stock') return null;
                    const next = s.points[i + 1]?.t ?? Math.min(p.t + 3_600_000, to);
                    const x1 = geometry.x(p.t);
                    const x2 = geometry.x(next);
                    return (
                      <rect
                        key={p.t}
                        x={x1}
                        y={top}
                        width={Math.max(1, x2 - x1)}
                        height={RIBBON_H}
                        className={
                          p.status === 'ok' ? 'fill-foreground/25' : 'fill-destructive'
                        }
                      />
                    );
                  })}
                </g>
              );
            })}

            {hoverT != null && (
              <line
                x1={geometry.x(hoverT)}
                x2={geometry.x(hoverT)}
                y1={M.top}
                y2={ribbonTop + ribbonsH}
                className="stroke-muted-foreground"
                strokeWidth={1}
              />
            )}

            <rect
              x={M.left}
              y={0}
              width={plotW}
              height={height}
              fill="transparent"
              onPointerMove={onMove}
              onPointerLeave={() => setHoverT(null)}
            />
          </svg>
        )}

        {hover && geometry && hoverT != null && (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-40 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg"
            style={
              geometry.x(hoverT) > width / 2
                ? { right: width - geometry.x(hoverT) + 12 }
                : { left: geometry.x(hoverT) + 12 }
            }
          >
            <div className="mb-1 text-muted-foreground">{stampLabel.format(hoverT)}</div>
            {hover.map(({ marketplace, point }) => (
              <div key={marketplace} className="flex items-center justify-between gap-4">
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{ background: MARKETPLACE_COLORS[marketplace] }}
                    aria-hidden
                  />
                  {MARKETPLACE_LABELS[marketplace]}
                </span>
                <span className="text-foreground tabular-nums">
                  {!point
                    ? '—'
                    : priced(point)
                      ? `${formatPrice(point.price as number)}${point.status === 'out_of_stock' ? ' (OOS)' : ''}`
                      : point.status === 'out_of_stock'
                        ? 'Out of stock'
                        : point.status.replace('_', ' ')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-16 text-xs text-muted-foreground">
        <span>Bars under the chart show stock:</span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-foreground/25" aria-hidden /> in stock
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-destructive" aria-hidden /> out of stock
        </span>
        <span>gap = no reading</span>
        {geometry?.anyDashed && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 border-t-2 border-dashed border-muted-foreground" aria-hidden />
            dashed line = price while out of stock
          </span>
        )}
        {geometry && geometry.start > from && (
          <span>· no readings before {stampLabel.format(geometry.start)}</span>
        )}
      </div>
    </div>
  );
}
