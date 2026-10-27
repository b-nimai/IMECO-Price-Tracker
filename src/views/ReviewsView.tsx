import { ArrowDown, ArrowUp, Star } from 'lucide-react';
import { useMemo, useState } from 'react';

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
import { byName } from '@/lib/utils';

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
          className="inline-flex items-center gap-0.5 text-xs font-medium text-amber-400"
          title={`Was ${r.rating_then?.toFixed(1)} on ${dateLabel.format(Date.parse(r.then_at!))}`}
        >
          <ArrowDown className="size-3" aria-hidden />
          {Math.abs(change).toFixed(1)} since {dateLabel.format(Date.parse(r.then_at!))}
        </span>
      )}
      {change >= DROP_FLAG && (
        <span className="inline-flex items-center gap-0.5 text-xs font-medium text-emerald-400">
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
    <div className="flex min-w-48 flex-1 flex-col gap-1 rounded-lg border border-border bg-card/60 px-4 py-2">
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

export default function ReviewsView({ rows }: { rows: Row[] }) {
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
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {RATED.map((m) => (
          <Scorecard key={m} marketplace={m} rows={ratings?.data ?? []} />
        ))}
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
