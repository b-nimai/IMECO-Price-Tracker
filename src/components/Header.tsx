import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';

import { LiveClock } from '@/components/LiveClock';
import { LogoMark } from '@/components/LogoMark';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { formatAgo, freshness } from '@/data/format';
import type { PriceData } from '@/data/types';
import { cn } from '@/lib/utils';

interface Props {
  /** The only survivor of the KPI row — see `Coverage` below for why it is this one. */
  totals: PriceData['totals'] | null;
  showUnlisted: boolean;
  onShowUnlistedChange: (next: boolean) => void;
  unlistedCount: number;
  onRefresh: () => void;
  syncing: boolean;
  error: string | null;
  /** When the newest snapshot was TAKEN — not when the browser last fetched it. */
  checkedAt: number | null;
  /** The tab switcher. Lives in the header so the wall display's grid loses no height to it. */
  nav?: ReactNode;
}

/**
 * Live listings out of listings we hold a link for, plus how many are out of stock.
 *
 * This is what the four KPI tiles collapsed to. The other three were derived readings — off
 * target, cheapest channel, median — and the grid below now answers all of them directly, cell
 * by cell, which a single headline number never did. Coverage is different in kind: it is the
 * one fact the grid CANNOT show, because a listing that failed to respond looks much the same
 * as one that was never listed once you are standing back from the screen.
 */
function Coverage({ totals }: { totals: PriceData['totals'] }) {
  return (
    <div
      className="flex items-center gap-2.5 rounded-lg border border-border bg-card/60 px-3 py-1"
      title={`${totals.live} of ${totals.listed} tracked listings returned a live price`}
    >
      <span className="eyebrow leading-tight">
        Listings
        <br />
        Live
      </span>
      <span className="font-mono text-xl leading-none font-bold tabular-nums text-foreground">
        {totals.live} <span className="text-muted-foreground">/</span> {totals.listed}
      </span>
      {totals.outOfStock > 0 && (
        <span className="text-[11px] leading-tight text-muted-foreground">
          {totals.outOfStock}
          <br />
          out of stock
        </span>
      )}
    </div>
  );
}

export function Header({
  totals,
  showUnlisted,
  onShowUnlistedChange,
  unlistedCount,
  onRefresh,
  syncing,
  error,
  checkedAt,
  nav,
}: Props) {
  // Staleness is measured from when prices were SCRAPED, not from the browser's last poll.
  // Polling a two-day-old database every two minutes must never look fresh — and with a
  // desktop scraper, that is the failure mode this dashboard is most exposed to.
  const age = freshness(checkedAt);

  return (
    <header className="card-glass flex flex-none flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onRefresh}
          disabled={syncing}
          title="Refresh from the database"
          aria-label="Refresh prices from the database"
          // `border-0` matters: the base `*` rule gives every element a border, and those two
          // sub-pixel edges are enough to push the whole header taller.
          className="h-auto w-auto shrink-0 border-0 p-0"
        >
          <LogoMark syncing={syncing} />
        </Button>
        <div className="hidden h-7 w-px bg-border sm:block" />
        <div className="shrink-0">
          <h1 className="text-base font-black tracking-[0.08em] text-foreground uppercase sm:text-xl sm:tracking-[0.2em]">
            Price Tracker
          </h1>
          <div className="mt-1 flex items-center gap-2">
            <span className="pulse-dot" aria-hidden />
            <span className="text-[11px] font-bold tracking-widest text-primary uppercase">
              Live Marketplace Pricing
            </span>
          </div>
        </div>
      </div>

      {/* Title, tabs and status share one line when it is wide enough for all three (~1760px).
          Narrower, the TABS take the second row — not the status group, which would otherwise
          wrap on Prices alone (it has the extra unlisted switch) and make the header jump. */}
      {nav && (
        <div className="order-last max-w-full basis-full overflow-x-auto min-[1760px]:order-none min-[1760px]:basis-auto">
          {nav}
        </div>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-3">
        {totals && <Coverage totals={totals} />}

        {unlistedCount > 0 && (
          <label className="flex cursor-pointer items-center gap-2 text-[11px] tracking-wider whitespace-nowrap text-muted-foreground uppercase">
            <Switch checked={showUnlisted} onCheckedChange={onShowUnlistedChange} />
            Show {unlistedCount} unlisted
          </label>
        )}

        {error ? (
          <Badge variant="destructive" className="gap-1 text-[10px]">
            Cached — {error.slice(0, 48)}
          </Badge>
        ) : age !== 'fresh' && checkedAt ? (
          // Amber past 2h, red past 6h — i.e. one missed hourly run, then several. Deliberately
          // a Badge rather than the quiet grey sync line: a stale board that looks normal is
          // worse than no board, because the numbers are still perfectly readable and wrong.
          <Badge
            variant={age === 'very-stale' ? 'destructive' : 'secondary'}
            className={cn(
              'gap-1 text-[10px] whitespace-nowrap',
              age === 'stale' && 'bg-amber-500/15 text-amber-400',
            )}
            title="Prices refresh hourly from the desktop app — this is older than that"
          >
            Prices {formatAgo(checkedAt)} — run the desktop app
          </Badge>
        ) : (
          <span className="hidden items-center gap-1.5 text-[11px] tracking-widest text-muted-foreground uppercase md:flex">
            <RefreshCw className={syncing ? 'size-3 animate-spin' : 'size-3'} aria-hidden />
            {syncing ? 'Syncing' : checkedAt ? `Priced ${formatAgo(checkedAt)}` : '—'}
          </span>
        )}

        <LiveClock />
      </div>
    </header>
  );
}
