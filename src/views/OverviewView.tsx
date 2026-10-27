import {
  AlertTriangle,
  ArrowDownRight,
  BadgeIndianRupee,
  Boxes,
  PackageX,
  Search,
  Star,
  Swords,
  TrendingDown,
  Trophy,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { BarList } from '@/components/charts/BarList';
import { Ring } from '@/components/charts/Ring';
import { Sparkline } from '@/components/charts/Sparkline';
import { StackedBar } from '@/components/charts/StackedBar';
import { StatTile } from '@/components/charts/StatTile';
import { SchemaNote, Where } from '@/components/listing';
import { ProductTrendModal } from '@/components/ProductTrendModal';
import { buildGroups, winLoss } from '@/data/competition';
import { formatPct, formatPrice } from '@/data/format';
import {
  alerts,
  dailyMovers,
  daySeries,
  movers,
  shareOfSearch,
  type AlertKind,
} from '@/data/overview';
import {
  fetchAvailability,
  fetchBlinkitStores,
  fetchPriceDaily,
  fetchPriceStats,
  fetchRatings,
  fetchSearchDays,
  fetchSearchLatest,
} from '@/data/supabaseClient';
import {
  MARKETPLACE_COLORS,
  MARKETPLACE_LABELS,
  MARKETPLACES,
  sheetOrder,
  type Marketplace,
  type Row,
} from '@/data/types';
import { isMissingView, useRemote } from '@/hooks/useRemote';
import { cn } from '@/lib/utils';

export type OverviewLink =
  'prices' | 'trends' | 'availability' | 'reviews' | 'competitors' | 'search';

const dayLabel = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });
const fmtDay = (d: string) => dayLabel.format(Date.parse(d));

/** Rivals' slices of the share-of-search bar, after IMECO's green. */
const BRAND_COLORS = ['var(--chart-4)', 'var(--chart-5)', 'var(--chart-1)'];

function Panel({
  title,
  icon: Icon,
  action,
  children,
  className,
}: {
  title: string;
  icon: typeof Star;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('card-glass flex min-w-0 flex-col gap-3 rounded-xl p-4', className)}>
      <header className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="eyebrow">{title}</h2>
        {action && <div className="ml-auto">{action}</div>}
      </header>
      {children}
    </section>
  );
}

function LinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children} →
    </button>
  );
}

const ALERT_STYLE: Record<AlertKind, { icon: typeof Star; tone: string; link: OverviewLink }> = {
  out_of_stock: { icon: PackageX, tone: 'text-bad bg-rose-500/12', link: 'availability' },
  below_target: { icon: TrendingDown, tone: 'text-warn bg-amber-500/12', link: 'trends' },
  undercut: { icon: Swords, tone: 'text-warn bg-amber-500/12', link: 'competitors' },
  rating_drop: { icon: Star, tone: 'text-warn bg-amber-500/12', link: 'reviews' },
  rank_lost: { icon: Search, tone: 'text-muted-foreground bg-muted', link: 'search' },
};

export default function OverviewView({
  rows,
  competitors,
  totals,
  onNavigate,
}: {
  rows: Row[];
  competitors: Row[];
  totals: { live: number; listed: number; outOfStock: number };
  onNavigate: (to: OverviewLink) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const daily = useRemote(fetchPriceDaily, 30);
  const statsRemote = useRemote(fetchPriceStats);
  const availability = useRemote(fetchAvailability);
  const stores = useRemote(fetchBlinkitStores);
  const ratings = useRemote(fetchRatings);
  const searchDays = useRemote(fetchSearchDays, 14);
  const searchLatest = useRemote(fetchSearchLatest);

  const ordered = useMemo(() => sheetOrder(rows), [rows]);
  const ours = useMemo(() => new Set(rows.map((r) => r.sku)), [rows]);
  const groups = useMemo(() => buildGroups(rows, competitors), [rows, competitors]);
  const series = useMemo(() => daily?.data && daySeries(daily.data, ours), [daily, ours]);
  const stats = useMemo(
    () => new Map((statsRemote?.data ?? []).map((r) => [`${r.sku}:${r.marketplace}`, r])),
    [statsRemote],
  );
  // Since yesterday when there is daily history; since the previous run otherwise.
  const moved = useMemo(
    () => (daily?.data?.length ? dailyMovers(daily.data, rows) : movers(rows)),
    [daily, rows],
  );
  const flagged = useMemo(
    () =>
      alerts({
        rows,
        groups,
        availability: availability?.data,
        ratings: ratings?.data,
        searchDays: searchDays?.data,
      }),
    [rows, groups, availability, ratings, searchDays],
  );

  // ── headline numbers ──
  const last = <T,>(v: (T | null)[] | undefined) => {
    if (!v) return null;
    for (let i = v.length - 1; i >= 0; i--) if (v[i] != null) return v[i];
    return null;
  };
  const prev = <T,>(v: (T | null)[] | undefined) => {
    if (!v) return null;
    let seen = false;
    for (let i = v.length - 1; i >= 0; i--) {
      if (v[i] == null) continue;
      if (seen) return v[i];
      seen = true;
    }
    return null;
  };
  const delta = (v: (number | null)[] | undefined) => {
    const a = last(v);
    const b = prev(v);
    return a != null && b != null ? a - b : null;
  };

  const wl = winLoss(groups);
  const compared = wl.cheapest + wl.tied + wl.undercut;

  const ownRatings = (ratings?.data ?? []).filter((r) => ours.has(r.sku));
  const avgRating = ownRatings.length
    ? ownRatings.reduce((n, r) => n + r.rating, 0) / ownRatings.length
    : null;
  const ratingThen = ownRatings.filter((r) => r.rating_then != null);
  const ratingDelta = ratingThen.length
    ? ratingThen.reduce((n, r) => n + (r.rating - r.rating_then!), 0) / ratingThen.length
    : null;

  // Keywords with IMECO on page one, per search day.
  const topTen = useMemo(() => {
    const byDay = new Map<string, Set<string>>();
    const all = new Map<string, Set<string>>();
    for (const d of searchDays?.data ?? []) {
      all.set(d.day, (all.get(d.day) ?? new Set()).add(d.keyword));
      const rank = d.best_organic_rank ?? d.best_rank;
      if (rank != null && rank <= 10)
        byDay.set(d.day, (byDay.get(d.day) ?? new Set()).add(d.keyword));
    }
    const days = [...all.keys()].sort();
    return {
      days,
      values: days.map((d) => byDay.get(d)?.size ?? 0),
      of: days.length ? all.get(days[days.length - 1])!.size : 0,
    };
  }, [searchDays]);

  const belowTarget = rows.reduce(
    (n, r) =>
      n +
      MARKETPLACES.filter((m) => {
        const c = r.cells[m];
        return c.status === 'ok' && c.price != null && c.targetSp && c.price < c.targetSp * 0.95;
      }).length,
    0,
  );

  const cities = useMemo(() => {
    const by = new Map<string, { checks: number; ok: number }>();
    for (const s of stores?.data ?? []) {
      if (!ours.has(s.sku)) continue;
      const c = by.get(s.city) ?? { checks: 0, ok: 0 };
      c.checks += s.checks_7d;
      c.ok += s.in_stock_7d;
      by.set(s.city, c);
    }
    return [...by.entries()]
      .filter(([, c]) => c.checks)
      .map(([city, c]) => ({ city, share: c.ok / c.checks }))
      .sort((a, b) => b.share - a.share);
  }, [stores, ours]);

  const missingDaily = daily?.error && isMissingView(daily.error);
  const spark = (values: (number | null)[] | undefined, color = 'var(--primary)') =>
    values && values.length > 1 ? [{ values, color }] : undefined;
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {missingDaily && (
        <div className="card-glass rounded-xl px-4 py-2">
          <SchemaNote view="price_daily" />
        </div>
      )}

      {/* ── KPI strip ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        <StatTile
          label="Listings live"
          icon={BadgeIndianRupee}
          value={totals.live}
          format={(v) => String(Math.round(v))}
          suffix={`/ ${totals.listed}`}
          delta={delta(series?.liveListings)}
          deltaFormat={(v) => String(Math.round(v))}
          footnote={series ? undefined : `${totals.outOfStock} out of stock`}
          spark={spark(series?.liveListings)}
          sparkSlots={series?.days.map(fmtDay)}
          sparkFormat={(v) => `${v} live`}
          onClick={() => onNavigate('prices')}
        />
        <StatTile
          label="In stock"
          icon={Boxes}
          accent="var(--chart-3)"
          value={last(series?.inStock) ?? (totals.listed ? totals.live / totals.listed : null)}
          format={pct}
          delta={delta(series?.inStock)}
          deltaFormat={(v) => `${(v * 100).toFixed(1)} pts`}
          spark={spark(series?.inStock, 'var(--chart-3)')}
          sparkSlots={series?.days.map(fmtDay)}
          sparkFormat={pct}
          onClick={() => onNavigate('availability')}
        />
        <StatTile
          label="Price wins"
          icon={Trophy}
          accent="var(--chart-4)"
          value={compared ? wl.cheapest / compared : null}
          format={pct}
          footnote={
            compared
              ? `${wl.cheapest} of ${compared} · undercut on ${wl.undercut}`
              : 'no rivals yet'
          }
          onClick={() => onNavigate('competitors')}
        />
        <StatTile
          label="Under target SP"
          icon={ArrowDownRight}
          accent="var(--warn)"
          value={belowTarget}
          format={(v) => String(Math.round(v))}
          footnote="listings 5%+ below the sheet’s price"
          onClick={() => onNavigate('trends')}
        />
        <StatTile
          label="Avg rating"
          icon={Star}
          accent="#f59e0b"
          value={avgRating}
          format={(v) => `${v.toFixed(2)}★`}
          delta={ratingDelta}
          deltaFormat={(v) => v.toFixed(2)}
          deltaLabel="in 30 days"
          footnote={ratingDelta == null ? `${ownRatings.length} listings` : undefined}
          onClick={() => onNavigate('reviews')}
        />
        <StatTile
          label="Top-10 keywords"
          icon={Search}
          accent="var(--chart-1)"
          value={topTen.values.length ? topTen.values[topTen.values.length - 1] : null}
          format={(v) => String(Math.round(v))}
          suffix={topTen.of ? `/ ${topTen.of}` : undefined}
          delta={delta(topTen.values)}
          deltaFormat={(v) => String(Math.round(v))}
          deltaLabel="vs last search"
          spark={spark(topTen.values, 'var(--chart-1)')}
          sparkSlots={topTen.days.map(fmtDay)}
          sparkFormat={(v) => `${v} keywords`}
          onClick={() => onNavigate('search')}
        />
      </div>

      {/* ── middle row: price index + attention ── */}
      <div className="grid gap-3 xl:grid-cols-5">
        <Panel
          title="Price index · 30 days"
          icon={TrendingDown}
          className="xl:col-span-3"
          action={<LinkButton onClick={() => onNavigate('trends')}>Trends</LinkButton>}
        >
          <p className="-mt-1 text-xs text-muted-foreground">
            Each listing’s daily price against its own 30-day median (100 = normal), averaged per
            marketplace. Below 100 means prices are running cheaper than usual.
          </p>
          {series && series.days.length > 1 ? (
            <>
              <Sparkline
                height={170}
                series={MARKETPLACES.map((m) => ({
                  values: series.priceIndex[m],
                  color: MARKETPLACE_COLORS[m],
                  label: MARKETPLACE_LABELS[m],
                }))}
                slots={series.days.map(fmtDay)}
                format={(v) => v.toFixed(1)}
              />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                {MARKETPLACES.map((m) => {
                  const v = last(series.priceIndex[m]);
                  return (
                    <span key={m} className="inline-flex items-center gap-1.5">
                      <Where marketplace={m} />
                      <span className="font-semibold text-foreground tabular-nums">
                        {v != null ? v.toFixed(1) : '—'}
                      </span>
                    </span>
                  );
                })}
                <span className="ml-auto text-muted-foreground">
                  {fmtDay(series.days[0])} – {fmtDay(series.days[series.days.length - 1])}
                </span>
              </div>
            </>
          ) : (
            <div className="flex h-[170px] items-center justify-center rounded-lg bg-muted/30 text-xs text-muted-foreground">
              {missingDaily
                ? 'Needs the price_daily view'
                : daily
                  ? 'Not enough history yet'
                  : 'Loading…'}
            </div>
          )}
        </Panel>

        <Panel
          title={`Needs attention · ${flagged.length}`}
          icon={AlertTriangle}
          className="xl:col-span-2"
        >
          {flagged.length ? (
            <ul className="-mx-1 flex max-h-[15.5rem] flex-col gap-1 overflow-y-auto pr-1">
              {flagged.slice(0, 30).map((a, i) => {
                const style = ALERT_STYLE[a.kind];
                const Icon = style.icon;
                return (
                  <li key={i}>
                    <button
                      type="button"
                      // A price miss opens that product's chart; the rest go to their page.
                      onClick={() =>
                        a.kind === 'below_target' && a.sku
                          ? setPicked(a.sku)
                          : onNavigate(style.link)
                      }
                      className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left text-xs transition-colors hover:bg-muted/60"
                    >
                      <span
                        className={cn(
                          'flex size-6 shrink-0 items-center justify-center rounded-md',
                          style.tone,
                        )}
                      >
                        <Icon className="size-3.5" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-foreground" title={a.text}>
                        {a.text}
                      </span>
                      <Where
                        marketplace={a.marketplace}
                        className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing needs attention right now. 🎉
            </p>
          )}
        </Panel>
      </div>

      {/* ── bottom row: movers, win/lose, stock, search ── */}
      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
        <Panel title="Price moves since yesterday" icon={TrendingDown}>
          {moved.length ? (
            <BarList
              items={moved.map((mv) => ({
                key: `${mv.row.sku}:${mv.marketplace}`,
                label: (
                  <span className="flex items-center gap-1.5">
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ background: MARKETPLACE_COLORS[mv.marketplace] }}
                    />
                    <span className="truncate" title={mv.row.name}>
                      {mv.row.name}
                    </span>
                  </span>
                ),
                value: mv.change,
                color: mv.change < 0 ? 'var(--good)' : 'var(--warn)',
                display: (
                  <span className={mv.change < 0 ? 'text-good' : 'text-warn'}>
                    {mv.change < 0 ? '▼' : '▲'} {formatPct(Math.abs(mv.change))}{' '}
                    <span className="font-normal text-muted-foreground">{formatPrice(mv.to)}</span>
                  </span>
                ),
                onClick: () => setPicked(mv.row.sku),
              }))}
            />
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No price changed since yesterday.
            </p>
          )}
        </Panel>

        <Panel
          title="Who is cheapest"
          icon={Swords}
          action={<LinkButton onClick={() => onNavigate('competitors')}>Competitors</LinkButton>}
        >
          <div className="flex flex-col gap-4">
            {MARKETPLACES.map((m) => {
              const w = winLoss(groups, [m]);
              const n = w.cheapest + w.tied + w.undercut;
              return (
                <div key={m} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between text-xs">
                    <Where marketplace={m} />
                    <span className="text-muted-foreground tabular-nums">
                      {n ? `IMECO cheapest on ${pct(w.cheapest / n)}` : 'no comparisons'}
                    </span>
                  </div>
                  <StackedBar
                    onClick={() => onNavigate('competitors')}
                    segments={[
                      { label: 'IMECO cheapest', value: w.cheapest, color: 'var(--good)' },
                      { label: 'Tied', value: w.tied, color: 'var(--muted-foreground)' },
                      { label: 'Rival cheaper', value: w.undercut, color: 'var(--warn)' },
                    ]}
                  />
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel
          title="Stock health"
          icon={Boxes}
          action={<LinkButton onClick={() => onNavigate('availability')}>Stock</LinkButton>}
        >
          <div className="grid grid-cols-3 gap-2">
            {MARKETPLACES.map((m) => {
              const listed = rows.filter((r) => r.cells[m].url);
              const ok = listed.filter((r) => r.cells[m].status === 'ok').length;
              return (
                <div key={m} className="flex flex-col items-center gap-1">
                  <Ring
                    value={listed.length ? ok / listed.length : null}
                    color={MARKETPLACE_COLORS[m]}
                    size={64}
                  />
                  <span className="text-[11px] text-muted-foreground">{MARKETPLACE_LABELS[m]}</span>
                  <span className="text-[10px] text-muted-foreground/70 tabular-nums">
                    {ok}/{listed.length}
                  </span>
                </div>
              );
            })}
          </div>
          {cities.length > 0 && (
            <div className="flex flex-col gap-1 border-t border-border pt-2">
              <span className="text-[11px] text-muted-foreground">Blinkit by city · 7 days</span>
              <BarList
                items={cities.map((c) => ({
                  key: c.city,
                  label: c.city,
                  value: c.share,
                  display: pct(c.share),
                  color: MARKETPLACE_COLORS.blinkit,
                }))}
              />
            </div>
          )}
        </Panel>

        <Panel
          title="Share of search"
          icon={Search}
          action={<LinkButton onClick={() => onNavigate('search')}>Search</LinkButton>}
        >
          {searchLatest?.data?.length ? (
            <div className="flex flex-col gap-4">
              {MARKETPLACES.map((m: Marketplace) => {
                const shares = shareOfSearch(searchLatest.data!, m);
                const total = shares.reduce((n, s) => n + s.slots, 0);
                if (!total) return null;
                return (
                  <div key={m} className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between text-xs">
                      <Where marketplace={m} />
                      <span className="text-muted-foreground tabular-nums">
                        IMECO {pct(shares[0].slots / total)}
                      </span>
                    </div>
                    <StackedBar
                      onClick={() => onNavigate('search')}
                      segments={shares.map((s, i) => ({
                        label: s.brand,
                        value: s.slots,
                        color:
                          s.brand === 'IMECO'
                            ? 'var(--primary)'
                            : s.brand === 'Other'
                              ? 'color-mix(in srgb, var(--muted-foreground) 35%, transparent)'
                              : BRAND_COLORS[i - 1],
                      }))}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">No searches yet.</p>
          )}
        </Panel>
      </div>

      <ProductTrendModal
        product={ordered.find((r) => r.sku === picked) ?? null}
        list={ordered}
        onPick={setPicked}
        stats={stats}
        showTarget={ordered.some((r) => MARKETPLACES.some((m) => r.cells[m].targetSp))}
      />
    </div>
  );
}
