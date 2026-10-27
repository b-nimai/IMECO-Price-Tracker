import { Trophy } from 'lucide-react';
import { useMemo, useState } from 'react';

import { DeltaPill } from '@/components/charts/DeltaPill';
import { Sparkline } from '@/components/charts/Sparkline';
import { StackedBar } from '@/components/charts/StackedBar';
import { FilterBox, Segmented, Where } from '@/components/listing';
import { ProductTrendModal } from '@/components/ProductTrendModal';
import { live } from '@/data/competition';
import { formatPct, formatPrice } from '@/data/format';
import { fetchPriceDaily, fetchPriceStats } from '@/data/supabaseClient';
import {
  MARKETPLACE_COLORS,
  MARKETPLACE_LABELS,
  MARKETPLACES,
  sheetOrder,
  type Cell,
  type Marketplace,
  type Row,
} from '@/data/types';
import { useRemote } from '@/hooks/useRemote';
import { byName, cn } from '@/lib/utils';

type Sort = 'sheet' | 'discount' | 'spread';

const dayLabel = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });

/** The cheapest marketplace a product is live on, if any. */
function cheapest(row: Row): Marketplace | null {
  let best: Marketplace | null = null;
  for (const m of MARKETPLACES) {
    const p = live(row.cells[m]);
    if (p != null && (best == null || p < live(row.cells[best])!)) best = m;
  }
  return best;
}

/** Discount off MRP, using the marketplace's own MRP where it reports one. */
function discount(cell: Cell, row: Row): number | null {
  const price = live(cell);
  const mrp = cell.mrp ?? row.mrp;
  return price != null && mrp ? 1 - price / mrp : null;
}

function spread(row: Row): number {
  const prices = MARKETPLACES.map((m) => live(row.cells[m])).filter((p): p is number => p != null);
  return prices.length > 1 ? Math.max(...prices) / Math.min(...prices) - 1 : -1;
}

/** Why a cell has no live price, in a word — and the hover text that explains it. */
function absence(cell: Cell, row: Row): { text: string; title: string; tone: string } {
  const head = `${row.name} on ${MARKETPLACE_LABELS[cell.marketplace]}`;
  switch (cell.status) {
    case 'not_listed':
      return {
        text: '—',
        title: `${head}: no link in the spreadsheet`,
        tone: 'text-muted-foreground/40',
      };
    case 'pending':
      return {
        text: 'Awaiting check',
        title: `${head}: the next run will price it`,
        tone: 'text-muted-foreground',
      };
    case 'blocked':
      return {
        text: 'Blocked',
        title: `${head}: could not be checked${cell.note ? ` — ${cell.note}` : ''}`,
        tone: 'text-muted-foreground',
      };
    case 'error':
      return {
        text: 'Error',
        title: `${head}: failed to read the price${cell.note ? ` — ${cell.note}` : ''}`,
        tone: 'text-bad',
      };
    default:
      return { text: 'Out of stock', title: `${head}: out of stock`, tone: 'text-bad' };
  }
}

function PriceCell({
  cell,
  row,
  best,
  yesterday,
}: {
  cell: Cell;
  row: Row;
  best: boolean;
  yesterday: number | undefined;
}) {
  const price = live(cell);
  if (price == null) {
    const a = absence(cell, row);
    const oosPrice = cell.status === 'out_of_stock' && cell.price != null;
    const body = (
      <span className={cn('flex flex-col gap-0.5', a.tone)}>
        {oosPrice && (
          <span className="text-sm text-muted-foreground line-through tabular-nums">
            {formatPrice(cell.price!)}
          </span>
        )}
        <span className="text-xs">{a.text}</span>
      </span>
    );
    return (
      <div title={a.title}>
        {cell.status === 'blocked' && cell.url ? (
          <a
            href={cell.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="hover:underline"
          >
            {body}
          </a>
        ) : (
          body
        )}
      </div>
    );
  }
  const off = discount(cell, row);
  const change = yesterday != null && yesterday !== price ? price / yesterday - 1 : null;
  return (
    <div
      className={cn(
        '-mx-2 flex flex-col gap-0.5 rounded-lg px-2 py-1',
        best && 'bg-emerald-500/10 ring-1 ring-emerald-500/40',
      )}
      title={[cell.note, cell.unit].filter(Boolean).join(' · ') || undefined}
    >
      <span className="flex items-center gap-1.5">
        <span className="text-base font-semibold text-foreground tabular-nums">
          {formatPrice(price)}
        </span>
        {best && <Trophy className="size-3 text-good" aria-label="Cheapest" />}
        {change != null && <DeltaPill delta={change} format={(v) => formatPct(v)} good="neutral" />}
      </span>
      {off != null && off > 0.005 && (
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {formatPct(off)} off MRP
        </span>
      )}
    </div>
  );
}

/** One marketplace at a glance: live / out of stock / not listed, average discount, wins. */
function MarketCard({ m, rows }: { m: Marketplace; rows: Row[] }) {
  const listed = rows.filter((r) => r.cells[m].url);
  const ok = listed.filter((r) => r.cells[m].status === 'ok');
  const oos = listed.filter((r) => r.cells[m].status === 'out_of_stock').length;
  const other = listed.length - ok.length - oos;
  const offs = ok.map((r) => discount(r.cells[m], r)).filter((v): v is number => v != null);
  const avgOff = offs.length ? offs.reduce((a, b) => a + b, 0) / offs.length : null;
  const wins = rows.filter((r) => cheapest(r) === m).length;
  return (
    <div className="card-glass flex min-w-0 flex-1 flex-col gap-2 rounded-xl px-4 py-3">
      <div className="flex items-center justify-between">
        <Where marketplace={m} className="inline-flex items-center gap-1.5 text-sm font-semibold" />
        <span className="text-xs text-muted-foreground">
          <span className="font-mono text-lg font-bold text-foreground tabular-nums">
            {ok.length}
          </span>{' '}
          / {listed.length} live
        </span>
      </div>
      <StackedBar
        height={8}
        legend={false}
        segments={[
          { label: 'Live', value: ok.length, color: MARKETPLACE_COLORS[m] },
          { label: 'Out of stock', value: oos, color: 'var(--bad)' },
          { label: 'Other', value: other, color: 'var(--muted-foreground)' },
        ]}
      />
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
        <span>
          <span className="font-semibold text-foreground">{oos}</span> out of stock
        </span>
        {avgOff != null && (
          <span>
            avg <span className="font-semibold text-foreground">{formatPct(avgOff)}</span> off MRP
          </span>
        )}
        <span>
          cheapest on <span className="font-semibold text-good">{wins}</span>
        </span>
      </div>
    </div>
  );
}

export default function PricesView({ rows, showUnlisted }: { rows: Row[]; showUnlisted: boolean }) {
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort>('sheet');
  const [picked, setPicked] = useState<string | null>(null);
  const daily = useRemote(fetchPriceDaily, 30);
  const statsRemote = useRemote(fetchPriceStats);
  const stats = useMemo(
    () => new Map((statsRemote?.data ?? []).map((r) => [`${r.sku}:${r.marketplace}`, r])),
    [statsRemote],
  );

  // Per listing: its daily closes (for the row's mini chart) and yesterday's close.
  const history = useMemo(() => {
    const days = [...new Set((daily?.data ?? []).map((d) => d.day))].sort();
    const at = new Map(days.map((d, i) => [d, i]));
    const series = new Map<string, (number | null)[]>();
    const yesterday = new Map<string, number>();
    const today = days[days.length - 1];
    for (const d of daily?.data ?? []) {
      const key = `${d.sku}:${d.marketplace}`;
      if (!series.has(key))
        series.set(
          key,
          days.map(() => null),
        );
      series.get(key)![at.get(d.day)!] = d.close_price;
      if (d.day !== today && d.close_price != null) yesterday.set(key, d.close_price);
    }
    return { days: days.map((d) => dayLabel.format(Date.parse(d))), series, yesterday };
  }, [daily]);

  const visible = useMemo(() => {
    let out = sheetOrder(rows);
    if (!showUnlisted) out = out.filter((r) => r.liveCount > 0);
    out = byName(out, filter);
    if (sort === 'discount') {
      const best = (r: Row) =>
        Math.max(-1, ...MARKETPLACES.map((m) => discount(r.cells[m], r) ?? -1));
      out = [...out].sort((a, b) => best(b) - best(a));
    }
    if (sort === 'spread') out = [...out].sort((a, b) => spread(b) - spread(a));
    return out;
  }, [rows, showUnlisted, filter, sort]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-3">
        {MARKETPLACES.map((m) => (
          <MarketCard key={m} m={m} rows={rows} />
        ))}
      </div>

      <section className="card-glass min-w-0 rounded-xl">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <Segmented
            label="Sort"
            value={sort}
            onChange={setSort}
            options={[
              ['sheet', 'Sheet order'],
              ['discount', 'Biggest discount'],
              ['spread', 'Biggest price gap'],
            ]}
          />
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-1 text-[11px] text-muted-foreground lg:inline-flex">
              <Trophy className="size-3 text-good" aria-hidden /> cheapest marketplace
            </span>
            <FilterBox value={filter} onChange={setFilter} />
          </div>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[60rem] table-fixed text-sm">
            <thead className="sticky top-0 z-10 bg-card text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="w-[28%] px-4 py-2 text-left font-medium">Product</th>
                <th className="w-[20%] px-4 py-2 text-left font-medium">30 days</th>
                <th className="w-[7%] px-2 py-2 text-right font-medium">MRP</th>
                {MARKETPLACES.map((m) => (
                  <th key={m} className="px-4 py-2 text-left font-medium">
                    <Where marketplace={m} className="inline-flex items-center gap-1.5" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const best = cheapest(row);
                const spark = MARKETPLACES.map((m) => ({
                  values: history.series.get(`${row.sku}:${m}`) ?? [],
                  color: MARKETPLACE_COLORS[m],
                  label: MARKETPLACE_LABELS[m],
                })).filter((s) => s.values.some((v) => v != null));
                return (
                  <tr
                    key={row.sku}
                    onClick={() => setPicked(row.sku)}
                    className="cursor-pointer border-b border-border/60 align-middle transition-colors last:border-0 hover:bg-muted/40"
                  >
                    <td className="px-4 py-2">
                      <div className="flex min-w-0 flex-col">
                        <span className="font-medium text-foreground">{row.name}</span>
                        <span className="text-[11px] text-muted-foreground">{row.sku}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      {spark.length ? (
                        <Sparkline
                          series={spark}
                          slots={history.days}
                          format={formatPrice}
                          height={34}
                        />
                      ) : daily ? (
                        <span className="text-[10px] text-muted-foreground/50">no history</span>
                      ) : (
                        <span className="block h-5 w-full animate-pulse rounded bg-muted/50" />
                      )}
                    </td>
                    <td className="px-2 py-2 text-right text-muted-foreground tabular-nums">
                      {row.mrp != null ? formatPrice(row.mrp) : '—'}
                    </td>
                    {MARKETPLACES.map((m) => (
                      <td key={m} className="px-4 py-2">
                        <PriceCell
                          cell={row.cells[m]}
                          row={row}
                          best={best === m}
                          yesterday={history.yesterday.get(`${row.sku}:${m}`)}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
              {!visible.length && (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-muted-foreground">
                    No product matches “{filter}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <ProductTrendModal
        product={visible.find((r) => r.sku === picked) ?? null}
        list={visible}
        onPick={setPicked}
        stats={stats}
        showTarget={rows.some((r) => MARKETPLACES.some((m) => r.cells[m].targetSp))}
      />
    </div>
  );
}
