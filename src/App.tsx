import { Boxes, ChartLine, IndianRupee, Search, Star, Swords } from 'lucide-react';
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';

import { Sidebar, type NavItem } from '@/components/Sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { usePriceData } from '@/hooks/usePriceData';
import { useHashTab } from '@/hooks/useHashTab';
import { useTheme } from '@/hooks/useTheme';
import { HeatmapView } from '@/views/HeatmapView';

// Every page but the board is code-split, so the first paint downloads only what it shows.
const TrendsView = lazy(() => import('@/views/TrendsView'));
const AvailabilityView = lazy(() => import('@/views/AvailabilityView'));
const ReviewsView = lazy(() => import('@/views/ReviewsView'));
const CompetitorsView = lazy(() => import('@/views/CompetitorsView'));
const SearchView = lazy(() => import('@/views/SearchView'));

const TABS = ['prices', 'trends', 'availability', 'reviews', 'competitors', 'search'] as const;
type Tab = (typeof TABS)[number];

const PAGES: Record<Tab, { label: string; icon: NavItem<Tab>['icon']; subtitle: string }> = {
  prices: {
    label: 'Prices',
    icon: IndianRupee,
    subtitle: 'Live price of every product on every marketplace',
  },
  trends: {
    label: 'Trends',
    icon: ChartLine,
    subtitle: 'How prices have moved — click a product for its chart',
  },
  availability: {
    label: 'Stock',
    icon: Boxes,
    subtitle: 'In-stock share by marketplace and Blinkit dark store',
  },
  reviews: { label: 'Reviews', icon: Star, subtitle: 'Star ratings and how they are changing' },
  competitors: {
    label: 'Competitors',
    icon: Swords,
    subtitle: 'IMECO against its rivals, product by product',
  },
  search: {
    label: 'Search',
    icon: Search,
    subtitle: 'Where IMECO ranks when shoppers search — once a day',
  },
};

const COLLAPSE_KEY = 'imeco-sidebar-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Shown whenever the dashboard is rendering the captured scrape instead of the database.
 *
 * Deliberately loud and permanent. Demo prices are real numbers from a real run, which makes
 * them *more* dangerous to mistake for live ones, not less — someone could reprice against a
 * frozen snapshot without ever noticing.
 */
function DemoBanner() {
  return (
    <div className="flex-none rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-[11px] tracking-widest text-warn uppercase">
      Demo data — not live. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to connect the
      database.
    </div>
  );
}

/** Page title row: name and one line of context on the left, the page's own controls right. */
function PageHeader({ tab, actions }: { tab: Tab; actions?: ReactNode }) {
  const page = PAGES[tab];
  return (
    <div className="flex flex-none flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{page.label}</h1>
        <p className="text-xs text-muted-foreground">{page.subtitle}</p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </div>
  );
}

export function App() {
  const { data, syncing, error, demo, refresh } = usePriceData();
  const [showUnlisted, setShowUnlisted] = useState(true);
  const [tab, setTab] = useHashTab(TABS, 'prices');
  const [theme, toggleTheme] = useTheme();
  const [collapsed, setCollapsed] = useState(readCollapsed);

  function collapse(next: boolean) {
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    } catch {
      /* remembered for this visit only */
    }
  }

  const unlistedCount = useMemo(
    () => (data ? data.rows.filter((r) => r.liveCount === 0).length : 0),
    [data],
  );

  const items: NavItem<Tab>[] = TABS.map((t) => ({
    id: t,
    label: PAGES[t].label,
    icon: PAGES[t].icon,
    badge:
      t === 'prices'
        ? data?.totals.live
        : t === 'availability'
          ? data?.totals.outOfStock
          : undefined,
    alert: t === 'availability',
  }));

  const pricesActions = data && (
    <>
      <span
        className="rounded-lg border border-border bg-card px-3 py-1 text-xs text-muted-foreground"
        title={`${data.totals.live} of ${data.totals.listed} tracked listings returned a live price`}
      >
        <span className="font-mono text-sm font-bold text-foreground tabular-nums">
          {data.totals.live}/{data.totals.listed}
        </span>{' '}
        listings live
        {data.totals.outOfStock > 0 && ` · ${data.totals.outOfStock} out of stock`}
      </span>
      {unlistedCount > 0 && (
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={showUnlisted} onCheckedChange={setShowUnlisted} />
          Show {unlistedCount} unlisted
        </label>
      )}
    </>
  );

  return (
    <div className="flex h-svh flex-col bg-background md:flex-row">
      <Sidebar
        items={items}
        current={tab}
        onSelect={setTab}
        collapsed={collapsed}
        onCollapsedChange={collapse}
        theme={theme}
        onThemeToggle={toggleTheme}
        checkedAt={data?.checkedAt ?? null}
        syncing={syncing}
        error={error}
        onRefresh={refresh}
      />

      <div className="bg-grid flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3 md:p-4">
        <PageHeader tab={tab} actions={tab === 'prices' ? pricesActions : undefined} />

        {demo && <DemoBanner />}

        {!data ? (
          <Skeleton className="min-h-96 flex-1 rounded-xl" />
        ) : tab === 'prices' ? (
          <main className="animate-fade-in-up min-h-[32rem] flex-1">
            <HeatmapView rows={data.rows} showUnlisted={showUnlisted} />
          </main>
        ) : (
          <main key={tab} className="animate-fade-in-up min-w-0">
            <Suspense fallback={<Skeleton className="h-96 rounded-xl" />}>
              {tab === 'trends' && <TrendsView rows={data.rows} />}
              {tab === 'availability' && <AvailabilityView rows={data.rows} />}
              {tab === 'reviews' && <ReviewsView rows={data.rows} />}
              {tab === 'competitors' && (
                <CompetitorsView rows={data.rows} competitors={data.competitors} />
              )}
              {tab === 'search' && <SearchView />}
            </Suspense>
          </main>
        )}
      </div>
    </div>
  );
}

export default App;
