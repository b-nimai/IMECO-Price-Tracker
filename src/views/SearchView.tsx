import { ArrowDown, ArrowUp } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Ring } from '@/components/charts/Ring';
import { StackedBar } from '@/components/charts/StackedBar';
import { FilterBox, Segmented, SchemaNote, Where } from '@/components/listing';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Modal } from '@/components/Modal';
import { listNav, useSticky } from '@/hooks/useModal';
import { formatPrice } from '@/data/format';
import {
  CONFIGURED,
  fetchSearchDays,
  fetchSearchLatest,
  type SearchDayRow,
  type SearchResultRow,
} from '@/data/supabaseClient';
import { shareOfSearch } from '@/data/overview';
import { MARKETPLACE_COLORS, MARKETPLACES, type Marketplace } from '@/data/types';
import { isMissingView, useRemote } from '@/hooks/useRemote';
import { cn } from '@/lib/utils';

/** How many days of daily ranks to load — enough for "since yesterday" and a week's view. */
const DAYS = 14;
/** How deep the detail lists go. Page one on a phone is about this many. */
const DETAIL_DEPTH = 20;

const dateLabel = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });

/** The rank to judge by: organic when IMECO has one, else its best ad slot. */
function rankOf(d: SearchDayRow | undefined): { rank: number; ad: boolean } | null {
  if (!d) return null;
  if (d.best_organic_rank != null) return { rank: d.best_organic_rank, ad: false };
  if (d.best_rank != null) return { rank: d.best_rank, ad: true };
  return null;
}

function RankCell({
  today,
  before,
}: {
  today: SearchDayRow | undefined;
  before: SearchDayRow | undefined;
}) {
  if (!today) return <span className="text-sm text-muted-foreground/50">Not searched</span>;
  const now = rankOf(today);
  const then = rankOf(before);
  // A smaller number is a better rank, so "up" is then - now.
  const moved = now && then && !now.ad && !then.ad ? then.rank - now.rank : 0;

  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 text-sm">
      {now ? (
        <span
          className={cn(
            'font-semibold tabular-nums',
            now.rank <= 10 ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          #{now.rank}
          {now.ad && <span className="ml-1 text-xs font-normal">(ad only)</span>}
        </span>
      ) : (
        <span className="text-muted-foreground">Not in top {today.results}</span>
      )}
      {moved > 0 && (
        <span className="inline-flex items-center text-xs font-medium text-good">
          <ArrowUp className="size-3" aria-hidden />
          {moved}
        </span>
      )}
      {moved < 0 && (
        <span className="inline-flex items-center text-xs font-medium text-warn">
          <ArrowDown className="size-3" aria-hidden />
          {-moved}
        </span>
      )}
      <span className="text-xs text-muted-foreground tabular-nums">
        {today.imeco_top10}/{Math.min(10, today.top10)} in top 10
        {today.imeco_ads > 0 && ` · ${today.imeco_ads} ad${today.imeco_ads === 1 ? '' : 's'}`}
      </span>
    </span>
  );
}

/** A rank's colour band: the darker the green, the nearer the top. */
function band(rank: number | null): { bg: string; fg: string } {
  if (rank == null) return { bg: 'transparent', fg: 'text-muted-foreground/60' };
  if (rank <= 3)
    return { bg: 'color-mix(in srgb, var(--primary) 55%, transparent)', fg: 'text-foreground' };
  if (rank <= 10)
    return { bg: 'color-mix(in srgb, var(--primary) 28%, transparent)', fg: 'text-foreground' };
  if (rank <= 20)
    return { bg: 'color-mix(in srgb, var(--warn) 22%, transparent)', fg: 'text-foreground' };
  return { bg: 'var(--muted)', fg: 'text-muted-foreground' };
}

const BANDS: [string, number | null][] = [
  ['Top 3', 1],
  ['4–10', 5],
  ['11–20', 15],
  ['Lower', 30],
  ['Not found', null],
];

/** One keyword on one marketplace as a coloured tile: rank, movement, and IMECO's ads. */
function HeatCell({
  today,
  before,
}: {
  today: SearchDayRow | undefined;
  before: SearchDayRow | undefined;
}) {
  if (!today) {
    return (
      <div className="flex h-9 items-center justify-center rounded-md border border-dashed border-border text-[10px] text-muted-foreground/50">
        not searched
      </div>
    );
  }
  const now = rankOf(today);
  const then = rankOf(before);
  const moved = now && then && !now.ad && !then.ad ? then.rank - now.rank : 0;
  const tone = band(now?.rank ?? null);
  return (
    <div
      className={cn(
        'flex h-9 items-center justify-between gap-1 rounded-md px-2 text-xs tabular-nums',
        tone.fg,
        !now && 'border border-dashed border-border',
      )}
      style={{ background: tone.bg }}
      title={
        now
          ? `#${now.rank}${now.ad ? ' (ad)' : ''} · ${today.imeco_top10} IMECO in top 10${
              today.imeco_ads ? ` · ${today.imeco_ads} ads` : ''
            }`
          : `Not in the top ${today.results}`
      }
    >
      <span className="font-semibold">
        {now ? `#${now.rank}` : '—'}
        {now?.ad && <span className="ml-0.5 text-[9px] font-normal opacity-80">ad</span>}
      </span>
      <span className="flex items-center gap-1">
        {moved > 0 && (
          <span className="inline-flex items-center text-[10px] font-semibold text-good">
            <ArrowUp className="size-3" aria-hidden />
            {moved}
          </span>
        )}
        {moved < 0 && (
          <span className="inline-flex items-center text-[10px] font-semibold text-bad">
            <ArrowDown className="size-3" aria-hidden />
            {-moved}
          </span>
        )}
        {today.imeco_ads > 0 && (
          <span className="rounded bg-amber-500/20 px-1 text-[9px] font-semibold text-warn">
            {today.imeco_ads} AD
          </span>
        )}
      </span>
    </div>
  );
}

/** Per marketplace: how many keywords IMECO is on page one for, and who owns the top 20. */
function MarketCard({
  marketplace,
  latest,
  results,
}: {
  marketplace: Marketplace;
  latest: Map<string, SearchDayRow>;
  results: SearchResultRow[];
}) {
  const mine = [...latest.values()].filter((d) => d.marketplace === marketplace);
  const pageOne = mine.filter((d) => (rankOf(d)?.rank ?? Infinity) <= 10).length;
  const advertised = mine.filter((d) => d.imeco_ads > 0).length;
  const shares = shareOfSearch(results, marketplace);
  return (
    <div className="card-glass flex min-w-0 flex-1 flex-col gap-3 rounded-xl px-4 py-3">
      <div className="flex items-center gap-3">
        <Ring
          value={mine.length ? pageOne / mine.length : null}
          color={MARKETPLACE_COLORS[marketplace]}
          size={56}
        />
        <div className="flex min-w-0 flex-col">
          <Where
            marketplace={marketplace}
            className="inline-flex items-center gap-1.5 text-sm font-semibold"
          />
          <span className="text-xs text-muted-foreground">
            top 10 on <span className="font-semibold text-foreground">{pageOne}</span> of{' '}
            {mine.length} keywords
            {advertised > 0 && ` · ads on ${advertised}`}
          </span>
        </div>
      </div>
      {shares.some((x) => x.slots) && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">
            Share of the top 20, all keywords
          </span>
          <StackedBar
            height={10}
            segments={shares.map((x, i) => ({
              label: x.brand,
              value: x.slots,
              color:
                x.brand === 'IMECO'
                  ? 'var(--primary)'
                  : x.brand === 'Other'
                    ? 'color-mix(in srgb, var(--muted-foreground) 35%, transparent)'
                    : ['var(--chart-4)', 'var(--chart-5)', 'var(--chart-1)'][i - 1],
            }))}
          />
        </div>
      )}
    </div>
  );
}

/** One marketplace's results page for a keyword, top DETAIL_DEPTH, with whose each one is. */
function ResultsList({ rows }: { rows: SearchResultRow[] }) {
  const top = rows.slice(0, DETAIL_DEPTH);
  const brands = new Map<string, number>();
  for (const r of top) brands.set(r.brand ?? 'other', (brands.get(r.brand ?? 'other') ?? 0) + 1);
  const named = [...brands.entries()]
    .filter(([b]) => b !== 'other')
    .sort((a, b) => b[1] - a[1] || (a[0] === 'IMECO' ? -1 : 1));

  if (!top.length) return <p className="text-sm text-muted-foreground">Not searched here.</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Top {top.length}: {named.map(([b, n]) => `${b} ${n}`).join(' · ') || 'no brand we track'}
        {brands.get('other') ? ` · other ${brands.get('other')}` : ''}
      </p>
      <ol className="flex flex-col">
        {top.map((r) => (
          <li
            key={`${r.position}:${r.listing_id}`}
            className={cn(
              'flex items-baseline gap-2 border-b border-border/50 py-1.5 text-xs',
              r.brand === 'IMECO' && 'bg-primary/10',
            )}
          >
            <span className="w-7 shrink-0 text-right text-muted-foreground tabular-nums">
              {r.position}
            </span>
            {/* A fixed slot whether or not there is a badge, so titles line up down the list. */}
            <span className="w-7 shrink-0">
              {r.sponsored && (
                <Badge variant="outline" className="h-4 px-1 text-[9px] text-warn">
                  AD
                </Badge>
              )}
            </span>
            <span
              className={cn(
                'w-24 shrink-0 truncate font-medium',
                r.brand === 'IMECO'
                  ? 'text-primary'
                  : r.brand
                    ? 'text-foreground'
                    : 'text-muted-foreground',
              )}
              title={r.brand ?? 'brand not identified'}
            >
              {r.brand ?? '—'}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={r.title ?? ''}>
              {r.title}
            </span>
            <span className="shrink-0 text-foreground tabular-nums">
              {r.price != null ? formatPrice(r.price) : ''}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * One keyword's first page on every marketplace, side by side. A modal rather than a panel
 * under the table, so it opens where you are; the arrows (or ← →) step through the keywords
 * in the table's current order without closing it.
 */
function ResultsDialog({
  keyword,
  keywords,
  detail,
  today,
  before,
  lastDay,
  onPick,
}: {
  keyword: string | null;
  keywords: string[];
  detail: Map<Marketplace, SearchResultRow[]>;
  today: Map<string, SearchDayRow>;
  before: Map<string, SearchDayRow>;
  lastDay: string;
  onPick: (k: string | null) => void;
}) {
  const shown = useSticky(keyword);
  return (
    <Modal
      open={keyword != null}
      onClose={() => onPick(null)}
      width="xl"
      flush
      title={`“${shown ?? ''}”`}
      description={`First page of results, searched ${
        lastDay ? dateLabel.format(Date.parse(lastDay)) : '—'
      } · IMECO rows highlighted`}
      nav={listNav(keywords, keyword, onPick, 'keyword')}
    >
      <div className="grid h-full gap-px bg-border lg:grid-cols-3">
        {MARKETPLACES.map((m) => (
          <section key={m} className="flex min-h-0 min-w-0 flex-col bg-background">
            <div className="flex flex-none items-start justify-between gap-2 border-b border-border px-4 py-3">
              <Where
                marketplace={m}
                className="inline-flex items-center gap-1.5 text-sm font-medium"
              />
              {shown && (
                <RankCell today={today.get(`${shown}:${m}`)} before={before.get(`${shown}:${m}`)} />
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <ResultsList rows={detail.get(m) ?? []} />
            </div>
          </section>
        ))}
      </div>
    </Modal>
  );
}

function EmptyState({ missing }: { missing: boolean }) {
  return (
    <Card className="card-glass">
      <CardContent className="mx-auto flex max-w-2xl flex-col gap-3 py-8 text-sm text-muted-foreground">
        <p className="text-base font-medium text-foreground">No keyword searches yet</p>
        {missing && <SchemaNote view="search_rank_daily" />}
        <p>
          Once a day, on the first run after 9 o’clock, the desktop app searches Amazon, Flipkart
          and Blinkit for each keyword and records the first page of results — who ranks where, and
          who is paying for the top slots.
        </p>
        <p>
          It starts with 19 keywords for IMECO’s product types (“kitchen tissue roll”, “garbage
          bags”, “bamboo toothbrush”…). To choose your own, add a{' '}
          <strong className="text-foreground">Keywords</strong> column to the product sheet and type
          each product’s search words in its cell, separated by commas — once any are filled in,
          those are searched instead of the defaults.
        </p>
      </CardContent>
    </Card>
  );
}

export default function SearchView() {
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [sort, setSort] = useState<'az' | 'best' | 'worst'>('az');
  const days = useRemote(fetchSearchDays, DAYS);
  const latest = useRemote(fetchSearchLatest);

  // Per keyword x marketplace: the newest day, and the day before it.
  const { today, before, keywords, lastDay } = useMemo(() => {
    const today = new Map<string, SearchDayRow>();
    const before = new Map<string, SearchDayRow>();
    for (const d of days?.data ?? []) {
      const key = `${d.keyword}:${d.marketplace}`;
      const current = today.get(key);
      if (!current || d.day > current.day) {
        if (current) before.set(key, current);
        today.set(key, d);
      } else if (!before.has(key) || d.day > before.get(key)!.day) {
        before.set(key, d);
      }
    }
    const keywords = [...new Set([...today.values()].map((d) => d.keyword))].sort();
    const lastDay = [...today.values()].reduce((m, d) => (d.day > m ? d.day : m), '');
    return { today, before, keywords, lastDay };
  }, [days]);

  // The keyword whose results page is open in the modal, if any.
  const selected = picked && keywords.includes(picked) ? picked : null;
  const showing = useSticky(selected);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? keywords.filter((k) => k.toLowerCase().includes(q)) : keywords;
  }, [keywords, filter]);

  // Best rank across the marketplaces; a keyword IMECO is not on anywhere sorts as 999.
  const sorted = useMemo(() => {
    if (sort === 'az') return visible;
    const best = (k: string) =>
      Math.min(999, ...MARKETPLACES.map((m) => rankOf(today.get(`${k}:${m}`))?.rank ?? 999));
    return [...visible].sort((a, b) => (sort === 'best' ? 1 : -1) * (best(a) - best(b)));
  }, [visible, sort, today]);

  const detail = useMemo(() => {
    const out = new Map<Marketplace, SearchResultRow[]>();
    for (const r of latest?.data ?? []) {
      if (r.keyword !== showing) continue;
      const m = r.marketplace as Marketplace;
      out.set(m, [...(out.get(m) ?? []), r]);
    }
    return out;
  }, [latest, showing]);

  if (!CONFIGURED) {
    return (
      <Card className="card-glass">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Search ranks are read from the live database, and this dashboard is running on demo data.
        </CardContent>
      </Card>
    );
  }
  if (days && !keywords.length) return <EmptyState missing={isMissingView(days.error)} />;
  if (!days) return <div className="h-96 animate-pulse rounded-xl bg-muted/30" />;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-3">
        {MARKETPLACES.map((m) => (
          <MarketCard key={m} marketplace={m} latest={today} results={latest?.data ?? []} />
        ))}
      </div>

      <section className="card-glass min-w-0 rounded-xl">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              IMECO’s best position per keyword, searched{' '}
              {lastDay ? dateLabel.format(Date.parse(lastDay)) : '—'} · arrows vs the search before
              · click a keyword for its full results
            </span>
            <span className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              {BANDS.map(([label, rank]) => (
                <span key={label} className="inline-flex items-center gap-1">
                  <span
                    className={cn(
                      'size-3 rounded-sm',
                      rank == null && 'border border-dashed border-border',
                    )}
                    style={{ background: band(rank).bg }}
                  />
                  {label}
                </span>
              ))}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              label="Sort"
              value={sort}
              onChange={setSort}
              options={[
                ['az', 'A–Z'],
                ['best', 'Best rank'],
                ['worst', 'Needs work'],
              ]}
            />
            <FilterBox value={filter} onChange={setFilter} placeholder="Filter keywords" />
          </div>
        </header>
        <div className="px-4 py-3">
          {/* Two columns on a wide screen, each read top to bottom. */}
          <div className="grid gap-x-6 pb-1.5 xl:grid-cols-2">
            {[0, 1].map((col) => (
              <div
                key={col}
                className={cn(
                  'grid grid-cols-[minmax(8rem,1.4fr)_repeat(3,minmax(0,1fr))] items-center gap-1.5 text-[11px] text-muted-foreground',
                  col === 1 && 'hidden xl:grid',
                )}
              >
                <span className="pl-1">Keyword</span>
                {MARKETPLACES.map((m) => (
                  <Where
                    key={m}
                    marketplace={m}
                    className="inline-flex items-center gap-1 text-[11px]"
                  />
                ))}
              </div>
            ))}
          </div>
          <div className="gap-x-6 xl:columns-2">
            {sorted.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setPicked(k)}
                className={cn(
                  'mb-1 grid w-full break-inside-avoid grid-cols-[minmax(8rem,1.4fr)_repeat(3,minmax(0,1fr))] items-center gap-1.5 rounded-lg py-0.5 text-left transition-colors hover:bg-muted/40',
                  k === selected && 'bg-muted/50',
                )}
              >
                <span className="truncate pl-1 text-sm font-medium text-foreground" title={k}>
                  {k}
                </span>
                {MARKETPLACES.map((m) => (
                  <HeatCell
                    key={m}
                    today={today.get(`${k}:${m}`)}
                    before={before.get(`${k}:${m}`)}
                  />
                ))}
              </button>
            ))}
          </div>
          {!sorted.length && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No keyword matches “{filter}”.
            </p>
          )}
        </div>
      </section>

      <ResultsDialog
        keyword={selected}
        keywords={sorted}
        detail={detail}
        today={today}
        before={before}
        lastDay={lastDay}
        onPick={setPicked}
      />
    </div>
  );
}
