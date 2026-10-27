import { Check, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Ring } from '@/components/charts/Ring';
import { StackedBar } from '@/components/charts/StackedBar';
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
import { formatPct, formatPrice } from '@/data/format';
import {
  CONFIGURED,
  fetchAvailability,
  fetchBlinkitStores,
  type AvailabilityRow,
  type StoreRow,
} from '@/data/supabaseClient';
import {
  MARKETPLACE_COLORS,
  MARKETPLACES,
  sheetOrder,
  type Marketplace,
  type Row,
} from '@/data/types';
import { isMissingView, useRemote } from '@/hooks/useRemote';
import { byName, cn } from '@/lib/utils';

// The dark stores in the order desktop/fetch.py walks them: home first, then the rest of
// Kolkata, then the other cities. Any area the database has that is not listed here is
// appended after, so a store added to the scraper shows up without a dashboard change.
const STORE_ORDER = ['Dum Dum', 'Ballygunge', 'Behala', 'Salt Lake', 'Bengaluru', 'Mumbai'];

const since = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
});

type Sort = 'sheet' | 'longest-out';

function InStock({ ok }: { ok: boolean }) {
  // Status, so it carries an icon and a word as well as its colour.
  return ok ? (
    <span className="inline-flex items-center gap-1 font-medium text-good">
      <Check className="size-4" aria-hidden />
      In stock
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 font-medium text-bad">
      <X className="size-4" aria-hidden />
      Out of stock
    </span>
  );
}

function AvailabilityCell({ row, stats }: { row: Row; stats: AvailabilityRow | undefined }) {
  if (!stats) return <span className="text-muted-foreground/50">—</span>;
  const share = stats.checks_7d ? stats.in_stock_7d / stats.checks_7d : null;
  return (
    <div className="flex flex-col gap-0.5" title={row.name}>
      <InStock ok={stats.status_now === 'ok'} />
      <span className="text-xs text-muted-foreground">
        {stats.unchanged_30d
          ? 'all of the last 30 days'
          : `since ${since.format(Date.parse(stats.status_since))}`}
      </span>
      {share != null && (
        <span className="text-xs text-muted-foreground tabular-nums">
          in stock {formatPct(share)} of last 7 days
        </span>
      )}
    </div>
  );
}

/** In stock share across every listing on one marketplace, last 7 days. */
function Scorecard({ marketplace, rows }: { marketplace: Marketplace; rows: AvailabilityRow[] }) {
  const checks = rows.reduce((n, r) => n + r.checks_7d, 0);
  const inStock = rows.reduce((n, r) => n + r.in_stock_7d, 0);
  const now = rows.filter((r) => r.status_now === 'ok').length;
  const out = rows.length - now;
  return (
    <div className="card-glass flex min-w-0 flex-col gap-3 rounded-xl px-4 py-3">
      <div className="flex items-center gap-3">
        <Ring
          value={checks ? inStock / checks : null}
          color={MARKETPLACE_COLORS[marketplace]}
          size={60}
        />
        <div className="flex min-w-0 flex-col">
          <Where
            marketplace={marketplace}
            className="inline-flex items-center gap-1.5 text-sm font-semibold"
          />
          <span className="text-xs text-muted-foreground">of checks in stock, last 7 days</span>
        </div>
      </div>
      <StackedBar
        height={8}
        segments={[
          { label: 'In stock now', value: now, color: MARKETPLACE_COLORS[marketplace] },
          { label: 'Out of stock', value: out, color: 'var(--bad)' },
        ]}
      />
    </div>
  );
}

function StoreGrid({ products, stores }: { products: Row[]; stores: StoreRow[] }) {
  const areas = useMemo(() => {
    const seen = [...new Set(stores.map((s) => s.area))];
    return [
      ...STORE_ORDER.filter((a) => seen.includes(a)),
      ...seen.filter((a) => !STORE_ORDER.includes(a)),
    ];
  }, [stores]);
  const cityOf = useMemo(() => new Map(stores.map((s) => [s.area, s.city])), [stores]);
  const byKey = useMemo(() => new Map(stores.map((s) => [`${s.sku}:${s.area}`, s])), [stores]);
  const lastWalk = stores.reduce((t, s) => Math.max(t, Date.parse(s.checked_at)), 0);

  return (
    <>
      <p className="mb-3 text-xs text-muted-foreground">
        Blinkit stock is per dark store, so the same product can be in stock in one neighbourhood
        and not the next. The desktop app asks every store every 3 hours; last asked{' '}
        {since.format(lastWalk)}.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[30%]">Product</TableHead>
            {areas.map((a) => (
              <TableHead key={a} className="text-center">
                <div className="leading-tight">
                  {a}
                  {cityOf.get(a) !== a && (
                    <div className="text-[10px] font-normal text-muted-foreground">
                      {cityOf.get(a)}
                    </div>
                  )}
                </div>
              </TableHead>
            ))}
            <TableHead className="text-right">Stores with stock</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {products.map((row) => {
            const cells = areas.map((a) => byKey.get(`${row.sku}:${a}`));
            const answered = cells.filter(
              (c) => c && (c.status_now === 'ok' || c.status_now === 'out_of_stock'),
            );
            const live = cells.filter((c) => c?.status_now === 'ok').length;
            return (
              <TableRow key={row.sku}>
                <TableCell className="py-2.5 font-medium whitespace-normal text-foreground">
                  {row.name}
                </TableCell>
                {cells.map((c, i) => (
                  <TableCell key={areas[i]} className="py-2.5 text-center">
                    {!c || (c.status_now !== 'ok' && c.status_now !== 'out_of_stock') ? (
                      <span className="text-muted-foreground/50" title="No answer from this store">
                        —
                      </span>
                    ) : c.status_now === 'ok' ? (
                      <span
                        className="inline-flex items-center gap-1 text-good tabular-nums"
                        title={`In stock in ${areas[i]}`}
                      >
                        <Check className="size-4" aria-label="In stock" />
                        {c.price_now != null && formatPrice(c.price_now)}
                      </span>
                    ) : (
                      <X
                        className="mx-auto size-4 text-bad"
                        aria-label={`Out of stock in ${areas[i]}`}
                      />
                    )}
                  </TableCell>
                ))}
                <TableCell
                  className={cn(
                    'py-2.5 text-right tabular-nums',
                    answered.length && live === 0 ? 'text-bad' : 'text-foreground',
                  )}
                >
                  {answered.length ? `${live} of ${answered.length}` : '—'}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}

export default function AvailabilityView({ rows }: { rows: Row[] }) {
  const ordered = useMemo(() => sheetOrder(rows), [rows]);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort>('sheet');

  const availability = useRemote(fetchAvailability);
  const stores = useRemote(fetchBlinkitStores);

  const stats = useMemo(
    () => new Map((availability?.data ?? []).map((r) => [`${r.sku}:${r.marketplace}`, r])),
    [availability],
  );

  const visible = useMemo(() => {
    const filtered = byName(ordered, filter);
    if (sort === 'sheet') return filtered;
    // Longest-running stockout first: the oldest `status_since` among a product's OOS listings.
    const outSince = (row: Row) =>
      Math.min(
        ...MARKETPLACES.map((m) => stats.get(`${row.sku}:${m}`))
          .filter((s) => s?.status_now === 'out_of_stock')
          .map((s) => Date.parse(s!.status_since)),
      );
    // Compared rather than subtracted: products with nothing out of stock are all Infinity, and
    // Infinity - Infinity is NaN, which leaves sort order undefined.
    return [...filtered].sort((a, b) => {
      const x = outSince(a);
      const y = outSince(b);
      return x === y ? 0 : x < y ? -1 : 1;
    });
  }, [ordered, filter, sort, stats]);

  const blinkitProducts = useMemo(
    () =>
      byName(
        ordered.filter((r) => r.cells.blinkit.url),
        filter,
      ),
    [ordered, filter],
  );

  if (!CONFIGURED) {
    return (
      <Card className="card-glass">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Availability reads the stock history in the live database, and this dashboard is running
          on demo data.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-3">
        {MARKETPLACES.map((m) => (
          <Scorecard
            key={m}
            marketplace={m}
            rows={(availability?.data ?? []).filter((r) => r.marketplace === m)}
          />
        ))}
      </div>

      <Card className="card-glass min-w-0">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-sm tracking-widest text-muted-foreground uppercase">
              Stock by product
            </CardTitle>
            {availability?.error &&
              (isMissingView(availability.error) ? (
                <SchemaNote view="availability_stats" />
              ) : (
                <p className="mt-1 text-xs text-destructive">{availability.error.slice(0, 120)}</p>
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
                variant={sort === 'longest-out' ? 'secondary' : 'ghost'}
                aria-pressed={sort === 'longest-out'}
                onClick={() => setSort('longest-out')}
              >
                Longest out of stock
              </Button>
            </div>
            <FilterBox value={filter} onChange={setFilter} />
          </div>
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
              {visible.map((row) => (
                <TableRow key={row.sku} className="align-top">
                  <TableCell className="py-3 font-medium whitespace-normal text-foreground">
                    {row.name}
                  </TableCell>
                  {MARKETPLACES.map((m) => (
                    <TableCell key={m} className="py-3">
                      {row.cells[m].url ? (
                        <AvailabilityCell row={row} stats={stats.get(`${row.sku}:${m}`)} />
                      ) : (
                        <span className="text-muted-foreground/50">Not listed</span>
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="card-glass min-w-0">
        <CardHeader>
          <CardTitle className="text-sm tracking-widest text-muted-foreground uppercase">
            Blinkit · by dark store
          </CardTitle>
          {stores?.error && isMissingView(stores.error) && (
            <SchemaNote view="blinkit_store_stats" />
          )}
        </CardHeader>
        <CardContent>
          {stores?.data?.length ? (
            <StoreGrid products={blinkitProducts} stores={stores.data} />
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {stores?.data
                ? 'No dark-store checks yet. The updated desktop app asks every Blinkit store every 3 hours (at 9, 12, 3 and 6 o’clock), and they will appear here after its first one.'
                : stores?.error
                  ? '—'
                  : 'Loading…'}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
