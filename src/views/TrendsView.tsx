import { useMemo, useState } from 'react';

import { FilterBox, SchemaNote, Where } from '@/components/listing';
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
import { CONFIGURED, fetchPriceStats, type PriceStatsRow } from '@/data/supabaseClient';
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

export default function TrendsView({ rows }: { rows: Row[] }) {
  const ordered = useMemo(() => sheetOrder(rows), [rows]);
  const [sku, setSku] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

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
