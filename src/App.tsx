import { useMemo, useState } from 'react';

import { Header } from '@/components/Header';
import { Skeleton } from '@/components/ui/skeleton';
import { usePriceData } from '@/hooks/usePriceData';
import { useKioskMode } from '@/hooks/useKioskMode';
import { HeatmapView } from '@/views/HeatmapView';

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

  useKioskMode();

  const unlistedCount = useMemo(
    () => (data ? data.rows.filter((r) => r.liveCount === 0).length : 0),
    [data],
  );

  return (
    <div className="bg-grid flex min-h-svh flex-col gap-2 overflow-y-auto bg-background p-2 lg:h-svh lg:overflow-hidden">
      <Header
        totals={data?.totals ?? null}
        showUnlisted={showUnlisted}
        onShowUnlistedChange={setShowUnlisted}
        unlistedCount={unlistedCount}
        onRefresh={refresh}
        syncing={syncing}
        error={error}
        checkedAt={data?.checkedAt ?? null}
      />

      {demo && <DemoBanner />}

      {/* The grid is the whole page now that the KPI tiles are gone, so the skeleton is one
          block rather than four tiles plus a block — it has to occupy what it is standing in
          for, or the first paint jumps. */}
      {!data ? (
        <Skeleton className="min-h-0 flex-1 rounded-xl" />
      ) : (
        <main className="animate-fade-in-up min-h-0 flex-1">
          <HeatmapView rows={data.rows} showUnlisted={showUnlisted} />
        </main>
      )}
    </div>
  );
}

export default App;
