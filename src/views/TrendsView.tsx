import { ArrowDown, ArrowUp, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';

import { FilterBox, SchemaNote, Where } from '@/components/listing';
import { PriceChart, type Series } from '@/components/PriceChart';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Modal } from '@/components/Modal';
import { listNav, useSticky } from '@/hooks/useModal';
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
  fetchHistory,
  fetchPriceStats,
  type PriceStatsRow,
} from '@/data/supabaseClient';
import { isMissingView, useRemote } from '@/hooks/useRemote';
import {
  MARKETPLACE_COLORS,
  MARKETPLACE_LABELS,
  MARKETPLACES,
  sheetOrder,
  type Cell,
  type Marketplace,
  type Row,
} from '@/data/types';
import { byName, cn } from '@/lib/utils';

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];
const DAY = 86_400_000;

/**
 * Where the live price sits against the sheet's intended SP.
 *
 * Below target is the reading worth flagging: someone is selling under the price IMECO set,
 * whether that is a marketplace discount or a third-party seller undercutting.
 */
function VsTarget({ cell }: { cell: Cell }) {
  if (cell.status !== 'ok' || cell.price == null || !cell.targetSp) {
    return <span className="text-muted-foreground">—</span>;
  }
  const diff = (cell.price - cell.targetSp) / cell.targetSp;
  if (Math.abs(diff) < 0.005) return <span className="text-muted-foreground">on target</span>;
  const pct = `${diff > 0 ? '+' : '−'}${Math.abs(diff * 100).toFixed(0)}%`;
  return diff < 0 ? (
    <span className="inline-flex items-center gap-1 text-warn" title="Selling below target SP">
      <TriangleAlert className="size-3" aria-hidden />
      {pct} below
    </span>
  ) : (
    <span className="text-muted-foreground">{pct} above</span>
  );
}

/**
 * One marketplace's cell in the listing table: today's price big, its 30-day story small.
 *
 * Same shape as the board on the Prices tab — a product row with a column per marketplace —
 * so nobody has to learn a second layout to read this one.
 */
function ListingCell({
  cell,
  stats,
  showTarget,
}: {
  cell: Cell;
  stats: PriceStatsRow | undefined;
  showTarget: boolean;
}) {
  if (!cell.url) return <span className="text-muted-foreground/50">Not listed</span>;

  const live = cell.status === 'ok' && cell.price != null;
  // Only meaningful when the range is a range: a price that never moved is at its low AND high.
  const moved = stats?.min_30d != null && stats.max_30d != null && stats.min_30d < stats.max_30d;
  const atLow = live && moved && cell.price === stats!.min_30d;
  const atHigh = live && moved && cell.price === stats!.max_30d;

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            'text-base font-semibold tabular-nums',
            live ? 'text-foreground' : 'text-sm font-normal text-muted-foreground',
          )}
        >
          {live
            ? formatPrice(cell.price as number)
            : cell.status === 'out_of_stock'
              ? 'Out of stock'
              : cell.status === 'pending'
                ? 'No reading yet'
                : '—'}
        </span>
        {atLow && (
          <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-good">
            <ArrowDown className="size-3" aria-hidden />
            30d low
          </span>
        )}
        {atHigh && (
          <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground">
            <ArrowUp className="size-3" aria-hidden />
            30d high
          </span>
        )}
      </div>
      {stats && (stats.min_30d != null || stats.changes_30d > 0) && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {stats.min_30d != null &&
            (moved
              ? `${formatPrice(stats.min_30d)} – ${formatPrice(stats.max_30d as number)}`
              : `steady at ${formatPrice(stats.min_30d)}`)}
          {stats.min_30d != null && stats.changes_30d > 0 && ' · '}
          {stats.changes_30d > 0 &&
            `${stats.changes_30d} change${stats.changes_30d === 1 ? '' : 's'}`}
        </span>
      )}
      {showTarget && cell.targetSp != null && (
        <span className="text-xs text-muted-foreground tabular-nums">
          target {formatPrice(cell.targetSp)} <VsTarget cell={cell} />
        </span>
      )}
    </div>
  );
}

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

export default function TrendsView({ rows }: { rows: Row[] }) {
  const ordered = useMemo(() => sheetOrder(rows), [rows]);
  const [sku, setSku] = useState<string | null>(null);
  // 30 days by default: a week is usually too short for a price to move, and a chart of flat
  // lines reads as broken rather than as "nothing happened".
  const [days, setDays] = useState<Range>(30);
  const [filter, setFilter] = useState('');

  // The product whose chart is open in the modal, if any.
  const selected = ordered.find((r) => r.sku === sku) ?? null;
  // What the sheet shows — the last selection, kept while it slides out after a close.
  const shown = useSticky(selected);

  // The sheet's SP columns are optional; with none filled in, target lines are noise.
  const hasTargets = ordered.some((r) => MARKETPLACES.some((m) => r.cells[m].targetSp));

  const history = useRemote(fetchHistory, shown?.sku ?? null, days);
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

  const chart = useMemo(() => {
    if (!shown || !history?.data) return null;
    const series: Series[] = MARKETPLACES.filter((m) => shown.cells[m].url).map((m) => ({
      marketplace: m,
      target: shown.cells[m].targetSp,
      points: history
        .data!.filter((h) => h.marketplace === m)
        .map((h) => ({ t: Date.parse(h.checked_at), price: h.price, status: h.status })),
    }));
    return { series, from: history.at - days * DAY, to: history.at };
  }, [shown, history, days]);

  const visible = useMemo(() => byName(ordered, filter), [ordered, filter]);

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
              Click a product to open its price chart.
            </p>
            {stats?.error &&
              (isMissingView(stats.error) ? (
                <SchemaNote view="price_stats" />
              ) : (
                <p className="mt-1 text-xs text-destructive">{stats.error.slice(0, 120)}</p>
              ))}
          </div>
          <FilterBox value={filter} onChange={setFilter} />
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>
      <Modal
        open={selected != null}
        onClose={() => setSku(null)}
        width="xl"
        title={shown?.name}
        description={shown && `${shown.sku} · price on each marketplace over the last ${days} days`}
        actions={
          <div className="flex gap-1" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <Button
                key={r}
                size="sm"
                variant={r === days ? 'secondary' : 'ghost'}
                aria-pressed={r === days}
                onClick={() => setDays(r)}
              >
                {r} days
              </Button>
            ))}
          </div>
        }
        nav={listNav(visible, selected, (r) => setSku(r.sku), 'product')}
      >
        {shown && (
          <div className="flex flex-col gap-4">
            <div className="grid gap-2 sm:grid-cols-3">
              {MARKETPLACES.map((m) => (
                <div
                  key={m}
                  className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2.5"
                >
                  <Where
                    marketplace={m}
                    className="inline-flex items-center gap-1.5 text-sm font-medium"
                  />
                  <ListingCell
                    cell={shown.cells[m]}
                    stats={stats?.data?.get(`${shown.sku}:${m}`)}
                    showTarget={hasTargets}
                  />
                </div>
              ))}
            </div>
            {history?.error ? (
              <p className="py-16 text-center text-sm text-destructive">
                Could not load history — {history.error.slice(0, 120)}
              </p>
            ) : !chart ? (
              <div className="h-[360px] animate-pulse rounded-md bg-muted/30" />
            ) : (
              <PriceChart series={chart.series} from={chart.from} to={chart.to} />
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
