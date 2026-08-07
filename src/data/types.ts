// The shapes the dashboard works in, and the transform from Supabase rows into them.

export const MARKETPLACES = ['amazon', 'flipkart', 'myntra', 'blinkit'] as const;
export type Marketplace = (typeof MARKETPLACES)[number];

export const MARKETPLACE_LABELS: Record<Marketplace, string> = {
  amazon: 'Amazon',
  flipkart: 'Flipkart',
  myntra: 'Myntra',
  blinkit: 'Blinkit',
};

/**
 * Why a cell does or does not carry a price. Mirrors desktop/models.py — the two must stay in
 * step, which is why the database also constrains this column.
 *
 * Only `ok` and `out_of_stock` can carry a number. Everything else renders as chrome, never as
 * a shaded cell: a blocked listing must never be mistakable for a cheap one.
 */
export type CellStatus = 'ok' | 'not_listed' | 'out_of_stock' | 'blocked' | 'error';

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
  starred: boolean;
  /** The spreadsheet's MRP — what the pinned column shows. */
  mrp: number | null;
  cells: Record<Marketplace, Cell>;
  /** Cheapest live price across marketplaces, for the `cheapest` metric. */
  minPrice: number | null;
  /** Live listings on this row — drives the default sort. */
  liveCount: number;
}

export interface PriceData {
  rows: Row[];
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
  target_sp: Record<string, number> | null;
  urls: Record<string, string> | null;
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

function emptyCell(marketplace: Marketplace, targetSp: number | null, url: string | null): Cell {
  return {
    marketplace,
    status: 'not_listed',
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

  const rows: Row[] = products.map((product) => {
    const targetSp = product.target_sp ?? {};
    const urls = product.urls ?? {};

    const cells = Object.fromEntries(
      MARKETPLACES.map((m) => [m, emptyCell(m, targetSp[m] ?? null, urls[m] ?? null)]),
    ) as Record<Marketplace, Cell>;

    for (const snapshot of byProduct.get(product.sku) ?? []) {
      const marketplace = snapshot.marketplace as Marketplace;
      if (!MARKETPLACES.includes(marketplace)) continue;

      const timestamp = Date.parse(snapshot.checked_at);
      if (!Number.isNaN(timestamp) && (checkedAt === null || timestamp > checkedAt)) {
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

    return {
      sku: product.sku,
      name: product.name,
      starred: product.starred,
      mrp: product.mrp,
      cells,
      minPrice,
      liveCount: buyable.length,
    };
  });

  return { rows, checkedAt, lastRunSource: null, totals };
}
