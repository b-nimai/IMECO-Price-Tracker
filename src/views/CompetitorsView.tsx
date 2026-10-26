import { Star } from 'lucide-react';
import { useMemo, useState } from 'react';

import { FilterBox, Where } from '@/components/listing';
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
import { fetchRatings, type RatingRow } from '@/data/supabaseClient';
import {
  MARKETPLACE_LABELS,
  MARKETPLACES,
  sheetOrder,
  type Cell,
  type Marketplace,
  type Row,
} from '@/data/types';
import { useRemote } from '@/hooks/useRemote';
import { byName, cn } from '@/lib/utils';

/** A live price someone can buy at — the only kind worth comparing. */
function live(cell: Cell): number | null {
  return cell.status === 'ok' && cell.price != null ? cell.price : null;
}

/**
 * One product's price on one marketplace. For a competitor, also how it sits against IMECO's
 * own live price there — the reading this whole tab exists for.
 */
function PriceCell({
  cell,
  ours,
  rating,
}: {
  cell: Cell;
  ours: number | null;
  rating: RatingRow | undefined;
}) {
  if (!cell.url) return <span className="text-sm text-muted-foreground/50">Not listed</span>;
  const price = live(cell);
  const diff = price != null && ours != null ? price - ours : null;

  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={cn(
          'tabular-nums',
          price != null
            ? 'text-base font-semibold text-foreground'
            : 'text-sm text-muted-foreground',
        )}
      >
        {price != null
          ? formatPrice(price)
          : cell.status === 'out_of_stock'
            ? 'Out of stock'
            : cell.status === 'pending'
              ? 'No reading yet'
              : '—'}
      </span>
      {diff != null && diff !== 0 && (
        // From IMECO's side: a rival selling cheaper is the one to notice.
        <span
          className={cn(
            'text-xs tabular-nums',
            diff < 0 ? 'text-amber-400' : 'text-muted-foreground',
          )}
        >
          {formatPrice(Math.abs(diff))} {diff < 0 ? 'cheaper' : 'dearer'} than IMECO
        </span>
      )}
      {diff === 0 && <span className="text-xs text-muted-foreground">same as IMECO</span>}
      {rating && (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
          <Star className="size-3 fill-amber-400 text-amber-400" aria-hidden />
          {rating.rating.toFixed(1)}
          {rating.rating_count != null && ` · ${rating.rating_count.toLocaleString('en-IN')}`}
        </span>
      )}
    </div>
  );
}

/** Across every product with a competitor on this marketplace: how often IMECO is cheapest. */
function Scorecard({ marketplace, groups }: { marketplace: Marketplace; groups: Group[] }) {
  let compared = 0;
  let cheapest = 0;
  for (const { ours, rivals } of groups) {
    const mine = live(ours.cells[marketplace]);
    const theirs = rivals
      .map((r) => live(r.cells[marketplace]))
      .filter((p): p is number => p != null);
    if (mine == null || !theirs.length) continue;
    compared += 1;
    if (mine <= Math.min(...theirs)) cheapest += 1;
  }
  return (
    <div className="flex min-w-48 flex-1 flex-col gap-1 rounded-lg border border-border bg-card/60 px-4 py-3">
      <span className="eyebrow">{MARKETPLACE_LABELS[marketplace]}</span>
      <span className="font-mono text-3xl font-bold text-foreground tabular-nums">
        {compared ? `${cheapest} / ${compared}` : '—'}
      </span>
      <span className="text-xs text-muted-foreground">
        {compared
          ? `products where IMECO is the cheapest (${formatPct(cheapest / compared)})`
          : 'no product with both IMECO and a competitor live here'}
      </span>
    </div>
  );
}

interface Group {
  ours: Row;
  rivals: Row[];
}

function EmptyState() {
  // As the product sheet itself looks: the same row, with the competitor's columns to the right.
  const headers = [
    'SKU',
    'Product Name',
    '…',
    'Competitor 1 Brand',
    'Competitor 1 Name',
    'Competitor 1 Amazon Link',
    'Competitor 1 Flipkart Link',
    'Competitor 1 Blinkit Link',
    'Competitor 2 Brand',
    '…',
  ];
  const row = [
    'IMEBKT360',
    'Kitchen Tissues Roll',
    '…',
    'Origami',
    'Origami Kitchen Towel',
    'https://www.amazon.in/dp/…',
    '',
    'https://blinkit.com/prn/…',
    'Premier',
    '…',
  ];
  return (
    <Card className="card-glass">
      <CardContent className="mx-auto flex max-w-3xl flex-col gap-3 py-8 text-sm text-muted-foreground">
        <p className="text-base font-medium text-foreground">No competitors added yet</p>
        <p>
          Competitors go on each product’s own row in the product sheet — in the{' '}
          <strong className="text-foreground">Competitor 1</strong>,{' '}
          <strong className="text-foreground">Competitor 2</strong>,{' '}
          <strong className="text-foreground">Competitor 3</strong> columns on the right:
        </p>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-foreground">
              <tr>
                {headers.map((h, i) => (
                  <th key={i} className="px-2 py-1.5 text-left font-medium whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {row.map((v, i) => (
                  <td key={i} className="px-2 py-1.5 whitespace-nowrap">
                    {v}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Any one link is enough; a competitor whose links are still blank is simply not tracked
          yet. Then upload the workbook in the desktop app — competitors are priced on the next run,
          alongside IMECO’s own products.
        </p>
      </CardContent>
    </Card>
  );
}

export default function CompetitorsView({
  rows,
  competitors,
}: {
  rows: Row[];
  competitors: Row[];
}) {
  const [filter, setFilter] = useState('');
  const ratings = useRemote(fetchRatings);
  const rated = useMemo(
    () => new Map((ratings?.data ?? []).map((r) => [`${r.sku}:${r.marketplace}`, r])),
    [ratings],
  );

  const groups: Group[] = useMemo(() => {
    const bySku = new Map<string, Row[]>();
    for (const c of competitors) {
      if (!c.competitorOf) continue;
      bySku.set(c.competitorOf, [...(bySku.get(c.competitorOf) ?? []), c]);
    }
    return sheetOrder(rows)
      .filter((r) => bySku.has(r.sku))
      .map((r) => ({ ours: r, rivals: sheetOrder(bySku.get(r.sku)!) }));
  }, [rows, competitors]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        byName([g.ours], q).length ||
        g.rivals.some((r) => `${r.brand} ${r.name}`.toLowerCase().includes(q)),
    );
  }, [groups, filter]);

  if (!groups.length) return <EmptyState />;

  const without = rows.length - groups.length;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {MARKETPLACES.map((m) => (
          <Scorecard key={m} marketplace={m} groups={groups} />
        ))}
      </div>

      <Card className="card-glass min-w-0">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-sm tracking-widest text-muted-foreground uppercase">
              IMECO vs competitors
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {groups.length} products compared against {competitors.length} competitor listings
              {without > 0 && ` · ${without} IMECO products have no competitors on the sheet yet`}
            </p>
          </div>
          <FilterBox value={filter} onChange={setFilter} />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[34%]">Product</TableHead>
                {MARKETPLACES.map((m) => (
                  <TableHead key={m}>
                    <Where marketplace={m} className="inline-flex items-center gap-1.5" />
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map(({ ours, rivals }) =>
                [ours, ...rivals].map((row, i) => (
                  <TableRow
                    key={row.sku}
                    className={cn(
                      'align-top',
                      i === 0 && 'border-t-2 border-t-border bg-muted/30 hover:bg-muted/30',
                    )}
                  >
                    <TableCell className={cn('py-3 whitespace-normal', i > 0 && 'pl-6')}>
                      <div className="flex flex-col gap-0.5">
                        <span
                          className={cn(
                            'text-xs font-bold tracking-widest uppercase',
                            i === 0 ? 'text-primary' : 'text-muted-foreground',
                          )}
                        >
                          {row.brand}
                        </span>
                        <span
                          className={cn(
                            i === 0 ? 'font-semibold' : 'font-normal',
                            'text-foreground',
                          )}
                        >
                          {row.name}
                        </span>
                      </div>
                    </TableCell>
                    {MARKETPLACES.map((m) => (
                      <TableCell key={m} className="py-3">
                        <PriceCell
                          cell={row.cells[m]}
                          ours={i === 0 ? null : live(ours.cells[m])}
                          rating={rated.get(`${row.sku}:${m}`)}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                )),
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
