import { Star } from 'lucide-react';
import { useMemo, useState } from 'react';

import { FilterBox, Segmented, Where } from '@/components/listing';
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
import {
  buildGroups,
  live,
  ordinal,
  standing,
  type Group,
  type Standing,
} from '@/data/competition';
import { formatPct, formatPrice } from '@/data/format';
import { fetchRatings, type RatingRow } from '@/data/supabaseClient';
import {
  MARKETPLACE_LABELS,
  MARKETPLACES,
  type Cell,
  type Marketplace,
  type Row,
} from '@/data/types';
import { useRemote } from '@/hooks/useRemote';
import { byName, cn } from '@/lib/utils';

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
          className={cn('text-xs tabular-nums', diff < 0 ? 'text-warn' : 'text-muted-foreground')}
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

/** "₹20 · 10% cheaper" chip: amber when a rival undercuts IMECO, green when IMECO is cheapest. */
function GapChip({ s }: { s: Standing }) {
  if (s.gap == null || s.ours == null) return null;
  if (s.gap <= 0) {
    return (
      <span className="inline-flex w-fit items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-good">
        {s.gap === 0 ? 'Tied cheapest' : `IMECO cheapest by ${formatPrice(-s.gap)}`}
      </span>
    );
  }
  return (
    <span className="inline-flex w-fit items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-warn tabular-nums">
      Rival {formatPrice(s.gap)} cheaper · {formatPct(s.gap / s.ours)}
    </span>
  );
}

function Stars({ rating, who }: { rating: RatingRow | undefined; who?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
      {who && <span className="w-10">{who}</span>}
      {rating ? (
        <>
          <Star className="size-3 fill-amber-400 text-amber-400" aria-hidden />
          <span className="text-foreground">{rating.rating.toFixed(1)}</span>
          {rating.rating_count != null && `(${rating.rating_count.toLocaleString('en-IN')})`}
        </>
      ) : (
        <span className="text-muted-foreground/50">—</span>
      )}
    </span>
  );
}

function OursLabel({ cell }: { cell: Cell }) {
  const price = live(cell);
  if (price != null)
    return (
      <span className="text-base font-semibold text-foreground tabular-nums">
        {formatPrice(price)}
      </span>
    );
  return (
    <span className="text-sm text-muted-foreground">
      {!cell.url
        ? 'Not listed'
        : cell.status === 'out_of_stock'
          ? 'Out of stock'
          : cell.status === 'pending'
            ? 'No reading yet'
            : '—'}
    </span>
  );
}

/** The all-marketplace grid's cell: IMECO's price, the cheapest rival, and the gap between. */
function StandingCell({ group, m }: { group: Group; m: Marketplace }) {
  const s = standing(group, m);
  const cell = group.ours.cells[m];
  if (!cell.url && !s.best)
    return <span className="text-sm text-muted-foreground/50">Nobody listed</span>;
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex items-baseline gap-2">
        <OursLabel cell={cell} />
        {s.rank != null && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {ordinal(s.rank)} of {s.of}
          </span>
        )}
      </span>
      {s.best ? (
        <span className="truncate text-xs text-muted-foreground" title={s.best.row.name}>
          Cheapest rival: <span className="font-medium text-foreground">{s.best.row.brand}</span>{' '}
          <span className="tabular-nums">{formatPrice(s.best.price)}</span>
        </span>
      ) : (
        <span className="text-xs text-muted-foreground/60">No rival live here</span>
      )}
      <GapChip s={s} />
    </div>
  );
}

/** Across every product with a competitor on this marketplace: how often IMECO is cheapest. */
function Scorecard({
  marketplace,
  groups,
  active,
  onClick,
}: {
  marketplace: Marketplace;
  groups: Group[];
  active: boolean;
  onClick: () => void;
}) {
  let compared = 0;
  let cheapest = 0;
  let undercut = 0;
  for (const g of groups) {
    const s = standing(g, marketplace);
    if (s.gap == null) continue;
    compared += 1;
    if (s.gap <= 0) cheapest += 1;
    else undercut += 1;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex min-w-48 flex-1 flex-col gap-1 rounded-lg border bg-card/60 px-4 py-3 text-left transition-colors hover:bg-muted/40',
        active ? 'border-primary ring-1 ring-primary/40' : 'border-border',
      )}
    >
      <span className="eyebrow">
        <Where marketplace={marketplace} className="inline-flex items-center gap-1.5" />
      </span>
      <span className="font-mono text-3xl font-bold text-foreground tabular-nums">
        {compared ? `${cheapest} / ${compared}` : '—'}
      </span>
      <span className="text-xs text-muted-foreground">
        {compared ? (
          <>
            products where IMECO is the cheapest ({formatPct(cheapest / compared)})
            {undercut > 0 && <span className="text-warn"> · undercut on {undercut}</span>}
          </>
        ) : (
          'no product with both IMECO and a competitor live here'
        )}
      </span>
    </button>
  );
}

/**
 * Every rival of one IMECO product, every marketplace: the full comparison behind a row of
 * the overview. The arrows (or ← →) step through the products in the table's current order.
 */
function GroupDialog({
  group,
  groups,
  rated,
  onPick,
}: {
  group: Group | null;
  groups: Group[];
  rated: Map<string, RatingRow>;
  onPick: (sku: string | null) => void;
}) {
  const shown = useSticky(group);
  return (
    <Modal
      open={group != null}
      onClose={() => onPick(null)}
      width="xl"
      title={shown?.ours.name}
      description={
        shown &&
        `${shown.ours.sku} · against ${shown.rivals.length} competitor${
          shown.rivals.length === 1 ? '' : 's'
        } · differences are from IMECO’s price on the same marketplace`
      }
      nav={listNav(groups, group, (g) => onPick(g.ours.sku), 'product')}
    >
      {shown && (
        <>
          <div className="mb-4 grid gap-2 sm:grid-cols-3">
            {MARKETPLACES.map((m) => {
              const s = standing(shown, m);
              return (
                <div
                  key={m}
                  className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2.5"
                >
                  <Where
                    marketplace={m}
                    className="inline-flex items-center gap-1.5 text-sm font-medium"
                  />
                  <span className="text-xs text-muted-foreground">
                    {s.rank != null
                      ? `IMECO is ${ordinal(s.rank)} cheapest of ${s.of}`
                      : s.ours == null
                        ? 'IMECO not live here'
                        : 'No rival live here'}
                  </span>
                  <GapChip s={s} />
                </div>
              );
            })}
          </div>
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
              {[shown.ours, ...shown.rivals].map((row, i) => (
                <TableRow
                  key={row.sku}
                  className={cn('align-top', i === 0 && 'bg-primary/10 hover:bg-primary/10')}
                >
                  <TableCell className="py-3 whitespace-normal">
                    <div className="flex flex-col gap-0.5">
                      <span
                        className={cn(
                          'text-xs font-bold tracking-widest uppercase',
                          i === 0 ? 'text-primary' : 'text-muted-foreground',
                        )}
                      >
                        {row.brand}
                      </span>
                      <span className={cn(i === 0 && 'font-semibold', 'text-foreground')}>
                        {row.name}
                      </span>
                    </div>
                  </TableCell>
                  {MARKETPLACES.map((m) => (
                    <TableCell key={m} className="py-3">
                      <PriceCell
                        cell={row.cells[m]}
                        ours={i === 0 ? null : live(shown.ours.cells[m])}
                        rating={rated.get(`${row.sku}:${m}`)}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </Modal>
  );
}

type Show = 'all' | 'undercut' | 'cheapest';
type Sort = 'sheet' | 'gap';

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
  const [where, setWhere] = useState<Marketplace | 'all'>('all');
  const [show, setShow] = useState<Show>('all');
  const [sort, setSort] = useState<Sort>('sheet');
  const [picked, setPicked] = useState<string | null>(null);
  const ratings = useRemote(fetchRatings);
  const rated = useMemo(
    () => new Map((ratings?.data ?? []).map((r) => [`${r.sku}:${r.marketplace}`, r])),
    [ratings],
  );

  const groups: Group[] = useMemo(() => buildGroups(rows, competitors), [rows, competitors]);

  const shown: Marketplace[] = where === 'all' ? [...MARKETPLACES] : [where];

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const markets: readonly Marketplace[] = where === 'all' ? MARKETPLACES : [where];
    // The worst gap on the marketplaces in view, as a share of IMECO's price.
    const worst = (g: Group) =>
      Math.max(
        -Infinity,
        ...markets.map((m) => {
          const s = standing(g, m);
          return s.gap != null && s.ours ? s.gap / s.ours : -Infinity;
        }),
      );
    let out = groups.filter(
      (g) =>
        !q ||
        g.ours.sku.toLowerCase().includes(q) ||
        byName([g.ours], q).length ||
        g.rivals.some((r) => `${r.brand} ${r.name}`.toLowerCase().includes(q)),
    );
    if (show === 'undercut') out = out.filter((g) => worst(g) > 0);
    if (show === 'cheapest') out = out.filter((g) => worst(g) <= 0 && worst(g) !== -Infinity);
    if (sort === 'gap') out = [...out].sort((a, b) => worst(b) - worst(a));
    return out;
  }, [groups, filter, where, show, sort]);

  if (!groups.length) return <EmptyState />;

  const without = rows.length - groups.length;
  const open = visible.find((g) => g.ours.sku === picked) ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {MARKETPLACES.map((m) => (
          <Scorecard
            key={m}
            marketplace={m}
            groups={groups}
            active={where === m}
            onClick={() => setWhere(where === m ? 'all' : m)}
          />
        ))}
      </div>

      <Card className="card-glass min-w-0">
        <CardHeader className="flex flex-col gap-3">
          <div className="flex w-full flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-sm tracking-widest text-muted-foreground uppercase">
                IMECO vs competitors
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                {groups.length} products against {competitors.length} competitor listings
                {without > 0 && ` · ${without} IMECO products have no competitors on the sheet yet`}
                {' · '}click a product for every rival side by side
              </p>
            </div>
            <FilterBox
              value={filter}
              onChange={setFilter}
              placeholder="Filter products or brands"
            />
          </div>
          <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2">
            <Segmented
              label="Marketplace"
              value={where}
              onChange={setWhere}
              options={[
                ['all', 'All marketplaces'],
                ...MARKETPLACES.map((m): [Marketplace, string] => [m, MARKETPLACE_LABELS[m]]),
              ]}
            />
            <span className="hidden h-5 w-px bg-border sm:block" aria-hidden />
            <Segmented
              label="Show"
              value={show}
              onChange={setShow}
              options={[
                ['all', 'All products'],
                ['undercut', 'A rival is cheaper'],
                ['cheapest', 'IMECO is cheapest'],
              ]}
            />
            <span className="hidden h-5 w-px bg-border sm:block" aria-hidden />
            <Segmented
              label="Sort"
              value={sort}
              onChange={setSort}
              options={[
                ['sheet', 'Sheet order'],
                ['gap', 'Biggest undercut first'],
              ]}
            />
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[26%]">Product</TableHead>
                {where === 'all' ? (
                  shown.map((m) => (
                    <TableHead key={m}>
                      <Where marketplace={m} className="inline-flex items-center gap-1.5" />
                    </TableHead>
                  ))
                ) : (
                  <>
                    <TableHead>IMECO</TableHead>
                    <TableHead>Cheapest rival</TableHead>
                    <TableHead>Gap</TableHead>
                    <TableHead>IMECO rank</TableHead>
                    <TableHead>Rating</TableHead>
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((g) => {
                const s = where === 'all' ? null : standing(g, where);
                return (
                  <TableRow
                    key={g.ours.sku}
                    className="cursor-pointer align-top"
                    onClick={() => setPicked(g.ours.sku)}
                  >
                    <TableCell className="py-3 whitespace-normal">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium text-foreground">{g.ours.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {g.ours.sku} · {g.rivals.length} rival{g.rivals.length === 1 ? '' : 's'}
                        </span>
                      </div>
                    </TableCell>
                    {where === 'all' ? (
                      shown.map((m) => (
                        <TableCell key={m} className="max-w-0 py-3">
                          <StandingCell group={g} m={m} />
                        </TableCell>
                      ))
                    ) : (
                      <>
                        <TableCell className="py-3">
                          <OursLabel cell={g.ours.cells[where]} />
                        </TableCell>
                        <TableCell className="py-3 whitespace-normal">
                          {s?.best ? (
                            <div className="flex flex-col gap-0.5">
                              <span className="text-base font-semibold text-foreground tabular-nums">
                                {formatPrice(s.best.price)}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                <span className="font-medium text-foreground">
                                  {s.best.row.brand}
                                </span>{' '}
                                {s.best.row.name}
                              </span>
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground/60">
                              No rival live here
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="py-3">
                          {s && s.gap != null ? (
                            <GapChip s={s} />
                          ) : (
                            <span className="text-sm text-muted-foreground/50">—</span>
                          )}
                        </TableCell>
                        <TableCell className="py-3 tabular-nums">
                          {s?.rank != null ? (
                            <span className="text-foreground">
                              {ordinal(s.rank)}{' '}
                              <span className="text-xs text-muted-foreground">of {s.of}</span>
                            </span>
                          ) : (
                            <span className="text-sm text-muted-foreground/50">—</span>
                          )}
                        </TableCell>
                        <TableCell className="py-3">
                          <div className="flex flex-col gap-1">
                            <Stars who="IMECO" rating={rated.get(`${g.ours.sku}:${where}`)} />
                            <Stars
                              who="Rival"
                              rating={s?.best ? rated.get(`${s.best.row.sku}:${where}`) : undefined}
                            />
                          </div>
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                );
              })}
              {!visible.length && (
                <TableRow>
                  <TableCell
                    colSpan={where === 'all' ? 4 : 6}
                    className="py-8 text-center text-sm text-muted-foreground"
                  >
                    No product matches these filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <GroupDialog group={open} groups={visible} rated={rated} onPick={setPicked} />
    </div>
  );
}
