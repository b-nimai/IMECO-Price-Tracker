// The shapes the dashboard works in, and the transform from Supabase rows into them.

// Myntra was dropped — its prices are no longer wanted. Historical myntra snapshots are still in
// the database and are simply ignored here: `buildPriceData` skips any marketplace not in this
// tuple, so nothing has to be deleted for the column to disappear.
export const MARKETPLACES = ['amazon', 'flipkart', 'blinkit'] as const;
export type Marketplace = (typeof MARKETPLACES)[number];

export const MARKETPLACE_LABELS: Record<Marketplace, string> = {
  amazon: 'Amazon',
  flipkart: 'Flipkart',
  blinkit: 'Blinkit',
};

/**
 * Series colour per marketplace, for charts. Fixed to the marketplace, never to its rank, so a
 * channel keeps its colour when another drops out. These are the first three `--chart-*` slots
 * of the dark theme, validated as a set against the #111 card surface (colour-blind separation
 * and 3:1 contrast all pass).
 */
export const MARKETPLACE_COLORS: Record<Marketplace, string> = {
  amazon: 'var(--chart-1)',
  flipkart: 'var(--chart-2)',
  blinkit: 'var(--chart-3)',
};

/**
 * Why a cell does or does not carry a price. Mirrors desktop/models.py — the two must stay in
 * step, which is why the database also constrains this column.
 *
 * Only `ok` and `out_of_stock` can carry a number. Everything else renders as chrome, never as
 * a shaded cell: a blocked listing must never be mistakable for a cheap one.
 */
export type CellStatus =
  | 'ok'
  | 'not_listed'
  | 'out_of_stock'
  | 'blocked'
  | 'error'
  | /**
     * CLIENT-SIDE ONLY — never written to the database, and deliberately absent from
     * desktop/models.py and the schema's CHECK constraint.
     *
     * It means "this listing has a link but no reading yet", which became possible the moment
     * the desktop app started pushing a swapped catalogue to Supabase ahead of the scrape that
     * prices it. Those cells have a URL and no snapshot, and drawing them as `not_listed` told
     * the operator "No Link Available" about a link they had just supplied — reading as though
     * the upload had failed, minutes after it succeeded.
     */
    'pending';

export interface Cell {
  marketplace: Marketplace;
  status: CellStatus;
  price: number | null;
  /** As reported by this marketplace — Blinkit's differ from the sheet's. */
  mrp: number | null;
  unit: string | null;
  note: string | null;
  url: string | null;
  /** Intended SP from the spreadsheet. Absent where the sheet records no target price. */
  targetSp: number | null;
  /** Same cell on the previous run, for the change marker. Null on a first run. */
  previous: number | null;
}

export interface Row {
  sku: string;
  name: string;
  /** "IMECO" for our own products; the brand typed on the Competitors sheet otherwise. */
  brand: string;
  /** For a competitor, the IMECO SKU it is compared against. Null for IMECO's own rows. */
  competitorOf: string | null;
  starred: boolean;
  /**
   * The product's row order in the spreadsheet — what the grid sorts on.
   *
   * Null for a SKU the current sheet no longer lists (and for every row on a database that
   * predates the column). Those sort last; see sheetOrder.
   */
  position: number | null;
  /** The spreadsheet's MRP — what the pinned column shows. */
  mrp: number | null;
  cells: Record<Marketplace, Cell>;
  /** Cheapest live price across marketplaces, for the `cheapest` metric. */
  minPrice: number | null;
  /** In-stock listings on this row. Decides whether the row counts as listed at all. */
  liveCount: number;
  /**
   * How many cells actually show a number.
   *
   * Deliberately NOT `liveCount`: an out-of-stock cell still prints its price. This used to
   * drive the row sort, which is now the sheet's order (see sheetOrder) — it is kept because
   * it is the honest measure of how complete a row looks on screen, and nothing else counts it.
   */
  pricedCount: number;
}

export interface PriceData {
  /** IMECO's own products — everything the board, its counts and the other tabs list. */
  rows: Row[];
  /** Products from the workbook's Competitors sheet. Only the Competitors tab shows these. */
  competitors: Row[];
  /** When the newest snapshot was taken, not when we fetched it. */
  checkedAt: number | null;
  lastRunSource: 'manual' | 'scheduled' | null;
  totals: {
    live: number;
    listed: number;
    errored: number;
    blocked: number;
    outOfStock: number;
  };
}

// ── raw Supabase shapes ──────────────────────────────────────────────────────────────────

export interface ProductRow {
  sku: string;
  name: string;
  mrp: number | null;
  starred: boolean;
  /** Absent on a database that has not had the `position` migration applied. */
  position?: number | null;
  target_sp: Record<string, number> | null;
  urls: Record<string, string> | null;
  /** Absent on a database without the competitor migration — every row is then IMECO's. */
  brand?: string | null;
  competitor_of?: string | null;
}

/**
 * A competitor row. `competitor_of` is the defining column; the brand check is the backstop
 * for a competitor whose IMECO product was deleted (the foreign key nulls `competitor_of`), so
 * it still cannot reach the wall as one of ours.
 */
export function isCompetitor(p: ProductRow): boolean {
  return p.competitor_of != null || (p.brand != null && p.brand !== 'IMECO');
}

export interface SnapshotRow {
  sku: string;
  marketplace: string;
  price: number | null;
  mrp: number | null;
  unit: string | null;
  status: string;
  via: string;
  note: string | null;
  checked_at: string;
}

/**
 * The cell before any snapshot is laid over it.
 *
 * The URL decides which absence this is: no link in the sheet is `not_listed` and always will
 * be, whereas a link with no reading yet is `pending` and will have a price after the next run.
 */
function emptyCell(marketplace: Marketplace, targetSp: number | null, url: string | null): Cell {
  return {
    marketplace,
    status: url ? 'pending' : 'not_listed',
    price: null,
    mrp: null,
    unit: null,
    note: null,
    url,
    targetSp,
    previous: null,
  };
}

/**
 * The products the CURRENT spreadsheet lists — everything the board should be counting.
 *
 * A withdrawn SKU is never deleted from the database: its price history is still worth having,
 * and deleting the product row would cascade that history away. Instead the desktop app nulls
 * its `position` on every sync, and it is dropped here.
 *
 * Without this, a sheet that loses a product keeps showing it on the wall FOREVER, holding its
 * last-known price — the dashboard reads the latest snapshot per SKU, not the latest run, so a
 * SKU that stopped being scraped simply freezes rather than disappearing. It was also still
 * counted, which is why the header read 45 products against a 42-row sheet.
 *
 * The `some` guard is what keeps a database that has not had the `position` migration applied
 * (every position null) from rendering an empty board. Losing the row order there is acceptable;
 * losing every row is not.
 */
function catalogued(products: ProductRow[]): ProductRow[] {
  const positioned = products.filter((p) => p.position != null);
  return positioned.length ? positioned : products;
}

/**
 * THE SHEET'S OWN ORDER, top to bottom. The board and `Docs/pricing link.xlsx` are read side by
 * side, and a row has to be findable by looking where it sits in the workbook.
 *
 * This replaced a most-prices-first ranking. That filled the grid from the top and pushed the
 * gaps to the bottom, which looked tidier — but it meant every row moved whenever a scrape lost
 * or gained a price, so nothing was ever twice in the same place.
 *
 * A null position is a SKU the current sheet does not list (or a database still missing the
 * `position` column). Those have no place in the sheet's order, so they collect at the bottom
 * in name order.
 */
export function sheetOrder(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    if (a.position == null || b.position == null) {
      if (a.position != null) return -1;
      if (b.position != null) return 1;
      return a.name.localeCompare(b.name);
    }
    return a.position - b.position;
  });
}

/**
 * Join products to their latest snapshots.
 *
 * `previousBySku` is an optional second pass over the run before last; without it the change
 * markers simply do not render, which is the correct behaviour on a first run rather than
 * something to fake.
 */
export function buildPriceData(
  products: ProductRow[],
  snapshots: SnapshotRow[],
  previous: SnapshotRow[] = [],
): PriceData {
  const previousIndex = new Map<string, number>();
  for (const s of previous) {
    if (s.price != null) previousIndex.set(`${s.sku}:${s.marketplace}`, s.price);
  }

  const byProduct = new Map<string, SnapshotRow[]>();
  for (const s of snapshots) {
    const list = byProduct.get(s.sku);
    if (list) list.push(s);
    else byProduct.set(s.sku, [s]);
  }

  let checkedAt: number | null = null;
  const totals = { live: 0, listed: 0, errored: 0, blocked: 0, outOfStock: 0 };

  const all: Row[] = catalogued(products).map((product) => {
    // Competitors are joined to their snapshots like any product, but they are not ours: they
    // stay out of the header's counts and the board's freshness, which describe IMECO.
    const rival = isCompetitor(product);
    const targetSp = product.target_sp ?? {};
    const urls = product.urls ?? {};

    const cells = Object.fromEntries(
      MARKETPLACES.map((m) => [m, emptyCell(m, targetSp[m] ?? null, urls[m] ?? null)]),
    ) as Record<Marketplace, Cell>;

    for (const snapshot of byProduct.get(product.sku) ?? []) {
      const marketplace = snapshot.marketplace as Marketplace;
      if (!MARKETPLACES.includes(marketplace)) continue;

      const timestamp = Date.parse(snapshot.checked_at);
      if (!rival && !Number.isNaN(timestamp) && (checkedAt === null || timestamp > checkedAt)) {
        checkedAt = timestamp;
      }

      cells[marketplace] = {
        marketplace,
        status: snapshot.status as CellStatus,
        price: snapshot.price,
        mrp: snapshot.mrp,
        unit: snapshot.unit,
        note: snapshot.note,
        url: urls[marketplace] ?? null,
        targetSp: targetSp[marketplace] ?? null,
        previous: previousIndex.get(`${product.sku}:${marketplace}`) ?? null,
      };

      if (rival) continue;
      if (snapshot.status !== 'not_listed') totals.listed += 1;
      if (snapshot.status === 'ok') totals.live += 1;
      if (snapshot.status === 'error') totals.errored += 1;
      if (snapshot.status === 'blocked') totals.blocked += 1;
      if (snapshot.status === 'out_of_stock') totals.outOfStock += 1;
    }

    // Only in-stock listings count toward "cheapest". An out-of-stock price cannot be bought,
    // so letting it win would point a buyer at a channel that has nothing to sell.
    const buyable = MARKETPLACES.map((m) => cells[m]).filter(
      (c) => c.status === 'ok' && c.price != null,
    );
    const minPrice = buyable.length ? Math.min(...buyable.map((c) => c.price as number)) : null;

    // Everything the grid draws as a number, in stock or not — see `Row.pricedCount`.
    const priced = MARKETPLACES.filter(
      (m) =>
        cells[m].price != null &&
        (cells[m].status === 'ok' || cells[m].status === 'out_of_stock'),
    ).length;

    return {
      sku: product.sku,
      name: product.name,
      brand: rival ? (product.brand ?? 'Unknown brand') : 'IMECO',
      competitorOf: rival ? (product.competitor_of ?? null) : null,
      starred: product.starred,
      position: product.position ?? null,
      mrp: product.mrp,
      cells,
      minPrice,
      liveCount: buyable.length,
      pricedCount: priced,
    };
  });

  return {
    rows: all.filter((r) => r.brand === 'IMECO' && r.competitorOf === null),
    competitors: all.filter((r) => r.brand !== 'IMECO' || r.competitorOf !== null),
    checkedAt,
    lastRunSource: null,
    totals,
  };
}
