import { lazy, Suspense, useMemo, useState } from 'react';

import { Header } from '@/components/Header';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePriceData } from '@/hooks/usePriceData';
import { useHashTab } from '@/hooks/useHashTab';
import { useKioskMode } from '@/hooks/useKioskMode';
import { HeatmapView } from '@/views/HeatmapView';

// Everything but the board is code-split: the wall display only ever shows Prices, and should
// not download views it never opens.
const TrendsView = lazy(() => import('@/views/TrendsView'));
const AvailabilityView = lazy(() => import('@/views/AvailabilityView'));
const ReviewsView = lazy(() => import('@/views/ReviewsView'));
const CompetitorsView = lazy(() => import('@/views/CompetitorsView'));

const TABS = ['prices', 'trends', 'availability', 'reviews', 'competitors'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  prices: 'Prices',
  trends: 'Trends',
  availability: 'Availability',
  reviews: 'Reviews',
  competitors: 'Competitors',
};

/**
 * Shown whenever the dashboard is rendering the captured scrape instead of the database.
 *
 * Deliberately loud and permanent. Demo prices are real numbers from a real run, which makes
 * them *more* dangerous to mistake for live ones, not less — someone could reprice against a
 * frozen snapshot without ever noticing.
 */
function DemoBanner() {
  return (
    <div className="flex-none rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-[11px] tracking-widest text-amber-400 uppercase">
      Demo data — not live. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to connect the
      database.
    </div>
  );
}

export function App() {
  const { data, syncing, error, demo, refresh } = usePriceData();
  // Default ON: this is a wall display and nobody is standing at it to flip a switch. A product
  // selling nowhere is itself the signal. The toggle exists to NARROW the grid, not widen it.
  const [showUnlisted, setShowUnlisted] = useState(true);
  const [tab, setTab] = useHashTab(TABS, 'prices');

  useKioskMode();

  const unlistedCount = useMemo(
    () => (data ? data.rows.filter((r) => r.liveCount === 0).length : 0),
    [data],
  );

  const nav = (
    <Tabs value={tab} onValueChange={(next) => setTab(next as Tab)}>
      <TabsList>
        {TABS.map((t) => (
          <TabsTrigger key={t} value={t} className="px-3 text-xs tracking-widest uppercase">
            {TAB_LABELS[t]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );

  return (
    <div className="bg-grid flex min-h-svh flex-col gap-2 overflow-y-auto bg-background p-2 lg:h-svh lg:overflow-hidden">
      <Header
        totals={data?.totals ?? null}
        showUnlisted={showUnlisted}
        onShowUnlistedChange={setShowUnlisted}
        // The switch only narrows the board, so it has nothing to do on other tabs.
        unlistedCount={tab === 'prices' ? unlistedCount : 0}
        onRefresh={refresh}
        syncing={syncing}
        error={error}
        checkedAt={data?.checkedAt ?? null}
        nav={nav}
      />

      {demo && <DemoBanner />}

      {/* The grid is the whole page now that the KPI tiles are gone, so the skeleton is one
          block rather than four tiles plus a block — it has to occupy what it is standing in
          for, or the first paint jumps. */}
      {!data ? (
        <Skeleton className="min-h-0 flex-1 rounded-xl" />
      ) : tab === 'prices' ? (
        <main className="animate-fade-in-up min-h-0 flex-1">
          <HeatmapView rows={data.rows} showUnlisted={showUnlisted} />
        </main>
      ) : (
        <main className="animate-fade-in-up min-h-0 min-w-0 flex-1 lg:overflow-y-auto">
          <Suspense fallback={<Skeleton className="h-96 rounded-xl" />}>
            {tab === 'trends' && <TrendsView rows={data.rows} />}
            {tab === 'availability' && <AvailabilityView rows={data.rows} />}
            {tab === 'reviews' && <ReviewsView rows={data.rows} />}
            {tab === 'competitors' && (
              <CompetitorsView rows={data.rows} competitors={data.competitors} />
            )}
          </Suspense>
        </main>
      )}
    </div>
  );
}

export default App;
