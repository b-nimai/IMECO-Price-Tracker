import { ArrowDown, ArrowUp, Star } from 'lucide-react';
import { useMemo, useState } from 'react';

import { BarList } from '@/components/charts/BarList';
import { FilterBox, SchemaNote, Where } from '@/components/listing';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatAmount } from '@/data/format';
import { CONFIGURED, fetchRatings, type RatingRow } from '@/data/supabaseClient';
import { MARKETPLACE_LABELS, sheetOrder, type Marketplace, type Row } from '@/data/types';
import { isMissingView, useRemote } from '@/hooks/useRemote';
import { byName, cn } from '@/lib/utils';

// Blinkit shows no ratings, so this tab has two columns, not three.
const RATED: Marketplace[] = ['amazon', 'flipkart'];

/** A drop this size or more is flagged: on a 5-point average over hundreds of ratings, 0.1 is
 *  a real shift, not rounding noise. */
const DROP_FLAG = 0.1;

type Sort = 'sheet' | 'lowest';

const dateLabel = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });

function RatingCell({ r }: { r: RatingRow | undefined }) {
  if (!r) return <span className="text-sm text-muted-foreground/50">No rating</span>;

  const change = r.rating_then != null ? Math.round((r.rating - r.rating_then) * 10) / 10 : 0;
  const added = r.count_then != null && r.rating_count != null ? r.rating_count - r.count_then : 0;

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 text-sm">
      <Star className="size-3.5 fill-amber-400 text-amber-400" aria-hidden />
      <span className="font-semibold text-foreground tabular-nums">{r.rating.toFixed(1)}</span>
      {r.rating_count != null && (
        <span className="text-xs text-muted-foreground tabular-nums">
          ({formatAmount(r.rating_count)}
          {added > 0 && `, +${formatAmount(added)} in 30d`})
        </span>
      )}
      {change <= -DROP_FLAG && (
        <span
          className="inline-flex items-center gap-0.5 text-xs font-medium text-warn"
          title={`Was ${r.rating_then?.toFixed(1)} on ${dateLabel.format(Date.parse(r.then_at!))}`}
        >
          <ArrowDown className="size-3" aria-hidden />
          {Math.abs(change).toFixed(1)} since {dateLabel.format(Date.parse(r.then_at!))}
        </span>
      )}
      {change >= DROP_FLAG && (
        <span className="inline-flex items-center gap-0.5 text-xs font-medium text-good">
          <ArrowUp className="size-3" aria-hidden />
          {change.toFixed(1)}
        </span>
      )}
    </span>
  );
}

/** Average of every listing's rating on one marketplace, plus how many ratings that covers. */
function Scorecard({ marketplace, rows }: { marketplace: Marketplace; rows: RatingRow[] }) {
  const mine = rows.filter((r) => r.marketplace === marketplace);
  const avg = mine.length ? mine.reduce((n, r) => n + r.rating, 0) / mine.length : null;
  const total = mine.reduce((n, r) => n + (r.rating_count ?? 0), 0);
  const low = mine.filter((r) => r.rating < 4).length;
  return (
    <div className="flex min-w-48 flex-1 flex-col gap-1 card-glass rounded-xl px-4 py-3">
      <span className="eyebrow">{MARKETPLACE_LABELS[marketplace]}</span>
      <span className="inline-flex items-center gap-2">
        <Star className="size-5 fill-amber-400 text-amber-400" aria-hidden />
        <span className="font-mono text-2xl font-bold text-foreground tabular-nums">
          {avg != null ? avg.toFixed(2) : '—'}
        </span>
      </span>
      <span className="text-xs text-muted-foreground">
        average over {mine.length} listings · {formatAmount(total)} ratings in all
        {low > 0 && ` · ${low} below 4★`}
      </span>
    </div>
  );
}

/** Average of a product's ratings across Amazon and Flipkart, weighted by how many ratings each has. */
function avgRating(
  sku: string,
  byKey: Map<string, RatingRow>,
): { rating: number; count: number } | null {
  let sum = 0;
  let weight = 0;
  let count = 0;
  for (const m of RATED) {
    const r = byKey.get(`${sku}:${m}`);
    if (!r) continue;
    const w = Math.max(1, r.rating_count ?? 1);
    sum += r.rating * w;
    weight += w;
    count += r.rating_count ?? 0;
  }
  return weight ? { rating: sum / weight, count } : null;
}

const LO = 3.5;
const HI = 5;
const at = (v: number) => `${((Math.min(HI, Math.max(LO, v)) - LO) / (HI - LO)) * 100}%`;

/** Each IMECO product's rating against its best-rated rival, on one 3.5–5★ scale. */
function RatingDuel({
  rows,
  competitors,
  byKey,
}: {
  rows: Row[];
  competitors: Row[];
  byKey: Map<string, RatingRow>;
}) {
  const lines = rows
    .map((row) => {
      const ours = avgRating(row.sku, byKey);
      const rivals = competitors
        .filter((c) => c.competitorOf === row.sku)
        .map((c) => ({ c, r: avgRating(c.sku, byKey) }))
        .filter((x): x is { c: Row; r: { rating: number; count: number } } => x.r != null)
        .sort((a, b) => b.r.rating - a.r.rating);
      return { row, ours, best: rivals[0] ?? null };
    })
    .filter((l) => l.ours && l.best)
    .sort((a, b) => a.ours!.rating - a.best!.r.rating - (b.ours!.rating - b.best!.r.rating));
  if (!lines.length) return null;
  const ahead = lines.filter((l) => l.ours!.rating >= l.best!.r.rating).length;
  return (
    <section className="card-glass flex min-w-0 flex-col gap-3 rounded-xl p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <span className="eyebrow">IMECO vs best-rated rival</span>
        <span className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="size-2.5 rounded-full bg-primary" /> IMECO
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-2.5 rounded-full border-2 border-warn" /> best rival
          </span>
          <span>
            IMECO rated higher on <span className="font-semibold text-foreground">{ahead}</span> of{' '}
            {lines.length}
          </span>
        </span>
      </header>
      <div className="flex flex-col gap-1">
        <div className="ml-[40%] flex justify-between text-[10px] text-muted-foreground">
          {[3.5, 4, 4.5, 5].map((v) => (
            <span key={v}>{v.toFixed(1)}★</span>
          ))}
        </div>
        {lines.map(({ row, ours, best }) => {
          const behind = ours!.rating < best!.r.rating;
          const [lo, hi] = [ours!.rating, best!.r.rating].sort((a, b) => a - b);
          return (
            <div key={row.sku} className="grid grid-cols-[40%_1fr] items-center gap-2 text-xs">
              <span className="truncate text-foreground" title={row.name}>
                {row.name}
              </span>
              <div
                className="relative h-5"
                title={`IMECO ${ours!.rating.toFixed(2)}★ · ${best!.c.brand} ${best!.r.rating.toFixed(2)}★`}
              >
                <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
                <span
                  className={cn(
                    'absolute top-1/2 h-1 -translate-y-1/2 rounded-full',
                    behind ? 'bg-warn/40' : 'bg-primary/30',
                  )}
                  style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }}
                />
                <span
                  className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-warn bg-card"
                  style={{ left: at(best!.r.rating) }}
                />
                <span
                  className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-card"
                  style={{ left: at(ours!.rating) }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Where the new ratings came from in the last 30 days. */
function Gained({ rows, byKey }: { rows: Row[]; byKey: Map<string, RatingRow> }) {
  const items = rows
    .map((row) => ({
      row,
      n: RATED.reduce((n, m) => {
        const r = byKey.get(`${row.sku}:${m}`);
        return (
          n +
          (r?.rating_count != null && r.count_then != null
            ? Math.max(0, r.rating_count - r.count_then)
            : 0)
        );
      }, 0),
    }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);
  return (
    <section className="card-glass flex min-w-0 flex-col gap-3 rounded-xl p-4">
      <span className="eyebrow">Most new ratings · 30 days</span>
      {items.length ? (
        <BarList
          items={items.map(({ row, n }) => ({
            key: row.sku,
            label: <span title={row.name}>{row.name}</span>,
            value: n,
            display: `+${formatAmount(n)}`,
            color: '#f59e0b',
          }))}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          No new ratings yet — this fills in as the 30-day history builds.
        </p>
      )}
    </section>
  );
}

export default function ReviewsView({ rows, competitors }: { rows: Row[]; competitors: Row[] }) {
  const ordered = useMemo(() => sheetOrder(rows), [rows]);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort>('sheet');
  const ratings = useRemote(fetchRatings);

  const byKey = useMemo(
    () => new Map((ratings?.data ?? []).map((r) => [`${r.sku}:${r.marketplace}`, r])),
    [ratings],
  );

  const visible = useMemo(() => {
    const listed = byName(
      ordered.filter((r) => RATED.some((m) => r.cells[m].url)),
      filter,
    );
    if (sort === 'sheet') return listed;
    const worst = (row: Row) =>
      Math.min(...RATED.map((m) => byKey.get(`${row.sku}:${m}`)?.rating ?? Infinity));
    return [...listed].sort((a, b) => {
      const x = worst(a);
      const y = worst(b);
      return x === y ? 0 : x < y ? -1 : 1;
    });
  }, [ordered, filter, sort, byKey]);

  if (!CONFIGURED) {
    return (
      <Card className="card-glass">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Reviews read the ratings in the live database, and this dashboard is running on demo data.
        </CardContent>
      </Card>
    );
  }

  const empty = ratings?.data && ratings.data.length === 0;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-2">
        {RATED.map((m) => (
          <Scorecard key={m} marketplace={m} rows={ratings?.data ?? []} />
        ))}
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <RatingDuel rows={ordered} competitors={competitors} byKey={byKey} />
        </div>
        <Gained rows={ordered} byKey={byKey} />
      </div>

      <Card className="card-glass min-w-0">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-sm tracking-widest text-muted-foreground uppercase">
              Ratings by product
            </CardTitle>
            {ratings?.error &&
              (isMissingView(ratings.error) ? (
                <SchemaNote view="rating_trend" />
              ) : (
                <p className="mt-1 text-xs text-destructive">{ratings.error.slice(0, 120)}</p>
              ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1" role="group" aria-label="Sort">
              <Button
                size="sm"
                variant={sort === 'sheet' ? 'secondary' : 'ghost'}
                aria-pressed={sort === 'sheet'}
                onClick={() => setSort('sheet')}
              >
                Sheet order
              </Button>
              <Button
                size="sm"
                variant={sort === 'lowest' ? 'secondary' : 'ghost'}
                aria-pressed={sort === 'lowest'}
                onClick={() => setSort('lowest')}
              >
                Lowest rated first
              </Button>
            </div>
            <FilterBox value={filter} onChange={setFilter} />
          </div>
        </CardHeader>
        <CardContent>
          {empty ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No ratings recorded yet. The updated desktop app reads them from the Amazon and
              Flipkart pages it already visits, so they appear after its first run.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40%]">Product</TableHead>
                  {RATED.map((m) => (
                    <TableHead key={m}>
                      <Where marketplace={m} className="inline-flex items-center gap-1.5" />
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((row) => (
                  <TableRow key={row.sku}>
                    <TableCell className="py-1.5 text-sm font-medium whitespace-normal text-foreground">
                      {row.name}
                    </TableCell>
                    {RATED.map((m) => (
                      <TableCell key={m} className="py-1.5">
                        {row.cells[m].url ? (
                          <RatingCell r={byKey.get(`${row.sku}:${m}`)} />
                        ) : (
                          <span className="text-sm text-muted-foreground/50">Not listed</span>
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
