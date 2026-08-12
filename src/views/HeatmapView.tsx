import { useMemo } from 'react';

import { Heatmap } from '@/components/Heatmap';
import { Card, CardContent } from '@/components/ui/card';
import type { Row } from '@/data/types';

interface Props {
  rows: Row[];
  showUnlisted: boolean;
}

export function HeatmapView({ rows, showUnlisted }: Props) {
  const visible = useMemo(() => {
    // Most prices first, so the grid fills from the top and the gaps collect at the bottom.
    // `pricedCount` counts every cell that shows a number, which is what someone reading the
    // board actually sees; `liveCount` breaks the tie so an in-stock row outranks an equally
    // full one that cannot be bought.
    const sorted = [...rows].sort(
      (a, b) =>
        b.pricedCount - a.pricedCount ||
        b.liveCount - a.liveCount ||
        a.name.localeCompare(b.name),
    );
    return showUnlisted ? sorted : sorted.filter((r) => r.liveCount > 0);
  }, [rows, showUnlisted]);

  return (
    // `bg-transparent` defeats Card's own `bg-card`; `card-glass` then supplies an 85% fill so
    // the page's lattice reads faintly through the grid. The sticky Product and MRP cells stay
    // fully opaque — they have to hide rows sliding underneath them.
    //
    // `py-2` rather than `py-3`, and no legend strip underneath: at 21px type the grid needs
    // every pixel of card it can get, and the legend lives in the header instead. See
    // gridFit.ts MIN_PX for what that height is being spent on.
    <Card className="card-glass flex h-full min-h-0 flex-col bg-transparent py-2">
      <CardContent className="min-h-0 flex-1 overflow-hidden">
        <Heatmap rows={visible} />
      </CardContent>
    </Card>
  );
}
