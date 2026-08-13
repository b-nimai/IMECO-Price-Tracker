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
    // THE SHEET'S OWN ORDER, top to bottom. The board and `Docs/pricing link.xlsx` are read
    // side by side, and a row has to be findable by looking where it sits in the workbook.
    //
    // This replaced a most-prices-first ranking. That filled the grid from the top and pushed
    // the gaps to the bottom, which looked tidier — but it meant every row moved whenever a
    // scrape lost or gained a price, so nothing was ever twice in the same place.
    //
    // A null position is a SKU the current sheet does not list (or a database still missing
    // the `position` column). Those have no place in the sheet's order, so they collect at the
    // bottom in name order.
    const sorted = [...rows].sort((a, b) => {
      if (a.position == null || b.position == null) {
        if (a.position != null) return -1;
        if (b.position != null) return 1;
        return a.name.localeCompare(b.name);
      }
      return a.position - b.position;
    });
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
