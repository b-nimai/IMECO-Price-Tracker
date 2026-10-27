import { useMemo, useState } from 'react';

import { Sparkline, type SparkSeries } from '@/components/charts/Sparkline';
import { FilterBox, SchemaNote, Segmented, Where } from '@/components/listing';
import { ListingCell, ProductTrendModal } from '@/components/ProductTrendModal';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatPct, formatPrice } from '@/data/format';
import {
  CONFIGURED,
  fetchPriceDaily,
  fetchPriceStats,
  type PriceStatsRow,
} from '@/data/supabaseClient';
import { isMissingView, useRemote } from '@/hooks/useRemote';
import {
  MARKETPLACE_COLORS,
  MARKETPLACE_LABELS,
  MARKETPLACES,
  sheetOrder,
  type Marketplace,
  type Row,
} from '@/data/types';
import { byName, cn } from '@/lib/utils';

interface Priced {
  marketplace: Marketplace;
  value: number;
}

/**
 * How far apart a product's live prices are across marketplaces, from the SELLER's side.
 *
 * Neither end is "best": the high channel is where IMECO earns most per unit, the low one is
 * where the price is being pushed down — and where a shopper who compares will buy. The gap
 * between them is the reading worth acting on.
 */
function SpreadNow({ row }: { row: Row }) {
  const live: Priced[] = MARKETPLACES.flatMap((m) =>
    row.cells[m].status === 'ok' && row.cells[m].price != null
      ? [{ marketplace: m, value: row.cells[m].price as number }]
      : [],
  ).sort((a, b) => b.value - a.value);

  if (!live.length) return <span className="text-sm text-muted-foreground">Nowhere in stock</span>;
  if (live.length === 1) {
    return (
      <div className="flex flex-col gap-0.5 text-sm">
        <span className="text-muted-foreground">Only live on</span>
        <Where marketplace={live[0].marketplace} />
      </div>
    );
  }

  const high = live[0];
  const low = live[live.length - 1];
  const gap = (high.value - low.value) / low.value;
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={cn(
          'text-base font-semibold tabular-nums',
          gap >= 0.2 ? 'text-warn' : 'text-foreground',
        )}
        title={`${MARKETPLACE_LABELS[low.marketplace]} is ${formatPct(gap)} below ${MARKETPLACE_LABELS[high.marketplace]}`}
      >
        {gap < 0.005 ? 'Same price' : `${formatPct(gap)} gap`}
      </span>
      {gap >= 0.005 && (
        <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground tabular-nums">
          <span>high {formatPrice(high.value)}</span>
          <Where marketplace={high.marketplace} />
          <span>· low {formatPrice(low.value)}</span>
          <Where marketplace={low.marketplace} />
        </span>
      )}
    </div>
  );
}

/** Lowest and highest price ever recorded for a product, across every marketplace. */
function AllTime({
  row,
  stats,
}: {
  row: Row;
  stats: Map<string, PriceStatsRow> | null | undefined;
}) {
  const lows = MARKETPLACES.map((m) => stats?.get(`${row.sku}:${m}`)?.min_ever).filter(
    (v): v is number => v != null,
  );
  const highs = MARKETPLACES.map((m) => stats?.get(`${row.sku}:${m}`)?.max_ever).filter(
    (v): v is number => v != null,
  );
  if (!lows.length) return <span className="text-muted-foreground">—</span>;
  const lo = Math.min(...lows);
  const hi = Math.max(...highs);
  return (
    <span className="text-sm text-foreground tabular-nums">
      {lo === hi ? formatPrice(lo) : `${formatPrice(lo)} – ${formatPrice(hi)}`}
    </span>
  );
}

type TrendSort = 'sheet' | 'volatile' | 'drop';

const dayLabel = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });

/** One product as a small chart card: its live prices on top, its 30 days underneath. */
function TrendCard({
  row,
  series,
  slots,
  changes,
  loading,
  onOpen,
}: {
  row: Row;
  series: SparkSeries[];
  slots: string[];
  changes: number;
  loading: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-card/60 p-3 text-left transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-2 text-sm font-medium text-foreground">{row.name}</span>
        {changes > 0 && (
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground tabular-nums">
            {changes} change{changes === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
        {MARKETPLACES.filter((m) => row.cells[m].url).map((m) => {
          const c = row.cells[m];
          const price = c.status === 'ok' ? c.price : null;
          return (
            <span key={m} className="inline-flex items-center gap-1">
              <span
                className="size-1.5 rounded-full"
                style={{ background: MARKETPLACE_COLORS[m] }}
              />
              <span
                className={cn(
                  'tabular-nums',
                  price != null ? 'font-semibold text-foreground' : 'text-muted-foreground',
                )}
              >
                {price != null ? formatPrice(price) : c.status === 'out_of_stock' ? 'OOS' : '—'}
              </span>
            </span>
          );
        })}
      </div>
      {series.length ? (
        <Sparkline series={series} slots={slots} format={formatPrice} height={56} />
      ) : loading ? (
        <div className="h-14 animate-pulse rounded-md bg-muted/40" />
      ) : (
        <div className="flex h-14 items-center justify-center text-[11px] text-muted-foreground/60">
          No history yet
        </div>
      )}
    </button>
  );
}

export default function TrendsView({ rows }: { rows: Row[] }) {
  const ordered = useMemo(() => sheetOrder(rows), [rows]);
  const [sku, setSku] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<'cards' | 'table'>('cards');
  const [sort, setSort] = useState<TrendSort>('sheet');
  const daily = useRemote(fetchPriceDaily, 30);

  // The product whose chart is open in the modal, if any.
  const selected = ordered.find((r) => r.sku === sku) ?? null;

  // The sheet's SP columns are optional; with none filled in, target lines are noise.
  const hasTargets = ordered.some((r) => MARKETPLACES.some((m) => r.cells[m].targetSp));

  const statsRemote = useRemote(fetchPriceStats);
  const stats = useMemo(
    () =>
      statsRemote && {
        error: statsRemote.error,
        data:
          statsRemote.data &&
          new Map(statsRemote.data.map((r) => [`${r.sku}:${r.marketplace}`, r])),
      },
    [statsRemote],
  );

  // Per listing, its daily closes over 30 days — the cards' charts and the sort keys.
  const history = useMemo(() => {
    const days = [...new Set((daily?.data ?? []).map((d) => d.day))].sort();
    const at = new Map(days.map((d, i) => [d, i]));
    const series = new Map<string, (number | null)[]>();
    for (const d of daily?.data ?? []) {
      const key = `${d.sku}:${d.marketplace}`;
      if (!series.has(key))
        series.set(
          key,
          days.map(() => null),
        );
      series.get(key)![at.get(d.day)!] = d.close_price;
    }
    return { days: days.map((d) => dayLabel.format(Date.parse(d))), series };
  }, [daily]);

  const visible = useMemo(() => {
    const list = byName(ordered, filter);
    if (sort === 'sheet') return list;
    const changes = (r: Row) =>
      MARKETPLACES.reduce((n, m) => n + (stats?.data?.get(`${r.sku}:${m}`)?.changes_30d ?? 0), 0);
    // The biggest fall from a listing's first close in the window to its latest.
    const drop = (r: Row) =>
      Math.min(
        0,
        ...MARKETPLACES.map((m) => {
          const v = (history.series.get(`${r.sku}:${m}`) ?? []).filter(
            (x): x is number => x != null,
          );
          return v.length > 1 ? v[v.length - 1] / v[0] - 1 : 0;
        }),
      );
    return [...list].sort((a, b) =>
      sort === 'volatile' ? changes(b) - changes(a) : drop(a) - drop(b),
    );
  }, [ordered, filter, sort, stats, history]);

  if (!CONFIGURED) {
    return (
      <Card className="card-glass">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Trends read the price history in the live database, and this dashboard is running on demo
          data.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Card className="card-glass min-w-0">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-sm tracking-widest text-muted-foreground uppercase">
              All products · last 30 days
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Every product’s last 30 days on each marketplace — click one for the full chart.
            </p>
            {stats?.error &&
              (isMissingView(stats.error) ? (
                <SchemaNote view="price_stats" />
              ) : (
                <p className="mt-1 text-xs text-destructive">{stats.error.slice(0, 120)}</p>
              ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              label="Sort"
              value={sort}
              onChange={setSort}
              options={[
                ['sheet', 'Sheet order'],
                ['volatile', 'Most changes'],
                ['drop', 'Biggest drop'],
              ]}
            />
            <Segmented
              label="View"
              value={view}
              onChange={setView}
              options={[
                ['cards', 'Cards'],
                ['table', 'Table'],
              ]}
            />
            <FilterBox value={filter} onChange={setFilter} />
          </div>
        </CardHeader>
        <CardContent>
          {view === 'cards' ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {visible.map((row) => (
                <TrendCard
                  key={row.sku}
                  row={row}
                  series={MARKETPLACES.map((m) => ({
                    values: history.series.get(`${row.sku}:${m}`) ?? [],
                    color: MARKETPLACE_COLORS[m],
                    label: MARKETPLACE_LABELS[m],
                  })).filter((x) => x.values.some((v) => v != null))}
                  slots={history.days}
                  changes={MARKETPLACES.reduce(
                    (n, m) => n + (stats?.data?.get(`${row.sku}:${m}`)?.changes_30d ?? 0),
                    0,
                  )}
                  loading={!daily}
                  onOpen={() => setSku(row.sku)}
                />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[30%]">Product</TableHead>
                  {MARKETPLACES.map((m) => (
                    <TableHead key={m}>
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="inline-block size-2 rounded-full"
                          style={{ background: MARKETPLACE_COLORS[m] }}
                          aria-hidden
                        />
                        {MARKETPLACE_LABELS[m]}
                      </span>
                    </TableHead>
                  ))}
                  <TableHead title="Gap between the highest and lowest live price across marketplaces">
                    Spread now
                  </TableHead>
                  <TableHead title="Lowest to highest price ever recorded, any marketplace">
                    All-time range
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((row) => {
                  const isSelected = row.sku === selected?.sku;
                  return (
                    <TableRow
                      key={row.sku}
                      className={cn(
                        'cursor-pointer align-top',
                        isSelected && 'bg-muted/50 hover:bg-muted/50',
                      )}
                      onClick={() => setSku(row.sku)}
                      aria-selected={isSelected}
                    >
                      <TableCell className="py-3 whitespace-normal">
                        <span
                          className={cn(
                            'font-medium text-foreground',
                            isSelected && 'border-l-2 border-primary pl-2',
                          )}
                        >
                          {row.name}
                        </span>
                      </TableCell>
                      {MARKETPLACES.map((m) => (
                        <TableCell key={m} className="py-3">
                          <ListingCell
                            cell={row.cells[m]}
                            stats={stats?.data?.get(`${row.sku}:${m}`)}
                            showTarget={hasTargets}
                          />
                        </TableCell>
                      ))}
                      <TableCell className="py-3">
                        <SpreadNow row={row} />
                      </TableCell>
                      <TableCell className="py-3">
                        <AllTime row={row} stats={stats?.data} />
                      </TableCell>
                    </TableRow>
                  );
                })}
                {visible.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={MARKETPLACES.length + 3}
                      className="py-8 text-center text-muted-foreground"
                    >
                      No product matches "{filter}".
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <ProductTrendModal
        product={selected}
        list={visible}
        onPick={setSku}
        stats={stats?.data ?? null}
        showTarget={hasTargets}
      />
    </div>
  );
}
