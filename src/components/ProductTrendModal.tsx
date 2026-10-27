import { ArrowDown, ArrowUp, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Where } from '@/components/listing';
import { Modal } from '@/components/Modal';
import { PriceChart, type Series } from '@/components/PriceChart';
import { Button } from '@/components/ui/button';
import { formatPrice } from '@/data/format';
import { fetchHistory, type PriceStatsRow } from '@/data/supabaseClient';
import { MARKETPLACES, type Cell, type Row } from '@/data/types';
import { listNav, useSticky } from '@/hooks/useModal';
import { useRemote } from '@/hooks/useRemote';
import { cn } from '@/lib/utils';

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
export function ListingCell({
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

/**
 * One product's price history: today's reading per marketplace on top, the full chart below.
 * Shared by the Trends page and the Overview, so a product clicked anywhere opens the same view.
 */
export function ProductTrendModal({
  product,
  list,
  onPick,
  stats,
  showTarget,
}: {
  product: Row | null;
  /** The list it was opened from, for the ‹ › arrows. */
  list: Row[];
  onPick: (sku: string | null) => void;
  stats: Map<string, PriceStatsRow> | null;
  showTarget: boolean;
}) {
  // 30 days by default: a week is usually too short for a price to move, and a chart of flat
  // lines reads as broken rather than as "nothing happened".
  const [days, setDays] = useState<Range>(30);
  // The last selection, kept while the sheet slides out after a close.
  const shown = useSticky(product);
  const history = useRemote(fetchHistory, shown?.sku ?? null, days);

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

  return (
    <Modal
      open={product != null}
      onClose={() => onPick(null)}
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
      nav={listNav(list, product, (r) => onPick(r.sku), 'product')}
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
                  stats={stats?.get(`${shown.sku}:${m}`)}
                  showTarget={showTarget}
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
  );
}
