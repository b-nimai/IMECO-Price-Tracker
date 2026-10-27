import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';

import { FilterBox, SchemaNote, Where } from '@/components/listing';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatPrice } from '@/data/format';
import {
  CONFIGURED,
  fetchSearchDays,
  fetchSearchLatest,
  type SearchDayRow,
  type SearchResultRow,
} from '@/data/supabaseClient';
import { MARKETPLACES, type Marketplace } from '@/data/types';
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
    <div className="flex flex-col gap-0.5">
      <span className="inline-flex items-baseline gap-2">
        {now ? (
          <span
            className={cn(
              'text-base font-semibold tabular-nums',
              now.rank <= 10 ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            #{now.rank}
            {now.ad && <span className="ml-1 text-xs font-normal">(ad only)</span>}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">Not in top {today.results}</span>
        )}
        {moved > 0 && (
          <span className="inline-flex items-center text-xs font-medium text-emerald-400">
            <ArrowUp className="size-3" aria-hidden />
            {moved}
          </span>
        )}
        {moved < 0 && (
          <span className="inline-flex items-center text-xs font-medium text-amber-400">
            <ArrowDown className="size-3" aria-hidden />
            {-moved}
          </span>
        )}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {today.imeco_top10} of top {Math.min(10, today.top10)}
        {today.imeco_ads > 0 && ` · ${today.imeco_ads} ad${today.imeco_ads === 1 ? '' : 's'}`}
      </span>
    </div>
  );
}

function Scorecard({
  marketplace,
  latest,
}: {
  marketplace: Marketplace;
  latest: Map<string, SearchDayRow>;
}) {
  const mine = [...latest.values()].filter((d) => d.marketplace === marketplace);
  const pageOne = mine.filter((d) => (rankOf(d)?.rank ?? Infinity) <= 10).length;
  const advertised = mine.filter((d) => d.imeco_ads > 0).length;
  return (
    <div className="flex min-w-48 flex-1 flex-col gap-1 rounded-lg border border-border bg-card/60 px-4 py-3">
      <span className="eyebrow">
        <Where marketplace={marketplace} className="inline-flex items-center gap-1.5" />
      </span>
      <span className="font-mono text-3xl font-bold text-foreground tabular-nums">
        {mine.length ? `${pageOne} / ${mine.length}` : '—'}
      </span>
      <span className="text-xs text-muted-foreground">
        keywords where IMECO is in the top 10
        {advertised > 0 && ` · advertising on ${advertised}`}
      </span>
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
                <Badge variant="outline" className="h-4 px-1 text-[9px] text-amber-400">
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
  const at = keyword ? keywords.indexOf(keyword) : -1;
  const prev = at > 0 ? keywords[at - 1] : null;
  const next = at >= 0 && at < keywords.length - 1 ? keywords[at + 1] : null;

  return (
    <Dialog open={keyword != null} onOpenChange={(open) => !open && onPick(null)}>
      <DialogContent
        className="h-[min(56rem,calc(100dvh-2rem))] max-w-7xl"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' && prev) onPick(prev);
          if (e.key === 'ArrowRight' && next) onPick(next);
        }}
      >
        <DialogHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <DialogTitle className="text-lg">“{keyword}”</DialogTitle>
            <DialogDescription>
              First page of results, searched{' '}
              {lastDay ? dateLabel.format(Date.parse(lastDay)) : '—'} · IMECO rows highlighted
            </DialogDescription>
          </div>
          {at >= 0 && (
            <div className="flex items-center gap-1">
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={!prev}
                onClick={() => prev && onPick(prev)}
                aria-label="Previous keyword"
              >
                <ChevronLeft />
              </Button>
              <span className="text-xs text-muted-foreground tabular-nums">
                {at + 1} / {keywords.length}
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={!next}
                onClick={() => next && onPick(next)}
                aria-label="Next keyword"
              >
                <ChevronRight />
              </Button>
            </div>
          )}
        </DialogHeader>
        <DialogBody className="p-0">
          <div className="grid h-full gap-px bg-border lg:grid-cols-3">
            {MARKETPLACES.map((m) => (
              <section key={m} className="flex min-h-0 min-w-0 flex-col bg-background">
                <div className="flex flex-none items-start justify-between gap-2 border-b border-border px-4 py-3">
                  <Where
                    marketplace={m}
                    className="inline-flex items-center gap-1.5 text-sm font-medium"
                  />
                  {keyword && (
                    <RankCell
                      today={today.get(`${keyword}:${m}`)}
                      before={before.get(`${keyword}:${m}`)}
                    />
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                  <ResultsList rows={detail.get(m) ?? []} />
                </div>
              </section>
            ))}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
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

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? keywords.filter((k) => k.toLowerCase().includes(q)) : keywords;
  }, [keywords, filter]);

  const detail = useMemo(() => {
    const out = new Map<Marketplace, SearchResultRow[]>();
    for (const r of latest?.data ?? []) {
      if (r.keyword !== selected) continue;
      const m = r.marketplace as Marketplace;
      out.set(m, [...(out.get(m) ?? []), r]);
    }
    return out;
  }, [latest, selected]);

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
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {MARKETPLACES.map((m) => (
          <Scorecard key={m} marketplace={m} latest={today} />
        ))}
      </div>

      <Card className="card-glass min-w-0">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-sm tracking-widest text-muted-foreground uppercase">
              IMECO’s rank by keyword
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Best organic position (an ad slot only when there is no organic one), searched{' '}
              {lastDay ? dateLabel.format(Date.parse(lastDay)) : '—'}; arrows compare with the
              search before. Click a keyword to open its whole results page.
            </p>
          </div>
          <FilterBox value={filter} onChange={setFilter} placeholder="Filter keywords" />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[28%]">Keyword</TableHead>
                {MARKETPLACES.map((m) => (
                  <TableHead key={m}>
                    <Where marketplace={m} className="inline-flex items-center gap-1.5" />
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((k) => (
                <TableRow
                  key={k}
                  className={cn(
                    'cursor-pointer align-top',
                    k === selected && 'bg-muted/50 hover:bg-muted/50',
                  )}
                  onClick={() => setPicked(k)}
                  aria-selected={k === selected}
                >
                  <TableCell className="py-3 font-medium text-foreground">
                    <span className={cn(k === selected && 'border-l-2 border-primary pl-2')}>
                      {k}
                    </span>
                  </TableCell>
                  {MARKETPLACES.map((m) => (
                    <TableCell key={m} className="py-3">
                      <RankCell today={today.get(`${k}:${m}`)} before={before.get(`${k}:${m}`)} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ResultsDialog
        keyword={selected}
        keywords={visible}
        detail={detail}
        today={today}
        before={before}
        lastDay={lastDay}
        onPick={setPicked}
      />
    </div>
  );
}
