// The Overview's arithmetic, kept out of the component so it can be tested.

import type {
  AvailabilityRow,
  PriceDailyRow,
  RatingRow,
  SearchDayRow,
  SearchResultRow,
} from './supabaseClient';
import { live, standing, type Group } from './competition';
import { MARKETPLACES, type Marketplace, type Row } from './types';

export interface DaySeries {
  days: string[];
  /** Share of stock readings that found IMECO's listings in stock, per day. */
  inStock: (number | null)[];
  /** IMECO listings with at least one in-stock reading that day. */
  liveListings: (number | null)[];
  /** Per marketplace: the day's average of (closing price ÷ that listing's median), × 100. */
  priceIndex: Record<Marketplace, (number | null)[]>;
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Day-by-day health of IMECO's own listings, from the `price_daily` view. */
export function daySeries(daily: PriceDailyRow[], ours: Set<string>): DaySeries {
  const rows = daily.filter((d) => ours.has(d.sku));
  const days = [...new Set(rows.map((d) => d.day))].sort();
  const at = new Map(days.map((d, i) => [d, i]));

  const readings = days.map(() => 0);
  const inStock = days.map(() => 0);
  const liveListings = days.map(() => 0);
  for (const d of rows) {
    const i = at.get(d.day)!;
    readings[i] += d.readings;
    inStock[i] += d.in_stock;
    if (d.in_stock > 0) liveListings[i] += 1;
  }

  // Each listing against its own normal price, so a ₹600 product and a ₹60 one weigh the same.
  const closes = new Map<string, number[]>();
  for (const d of rows) {
    if (d.close_price == null) continue;
    const key = `${d.sku}:${d.marketplace}`;
    closes.set(key, [...(closes.get(key) ?? []), d.close_price]);
  }
  const norm = new Map([...closes].map(([k, v]) => [k, median(v)]));
  const priceIndex = Object.fromEntries(
    MARKETPLACES.map((m) => {
      const sum = days.map(() => 0);
      const n = days.map(() => 0);
      for (const d of rows) {
        if (d.marketplace !== m || d.close_price == null) continue;
        const base = norm.get(`${d.sku}:${d.marketplace}`);
        if (!base) continue;
        const i = at.get(d.day)!;
        sum[i] += (d.close_price / base) * 100;
        n[i] += 1;
      }
      return [m, sum.map((s, i) => (n[i] ? s / n[i] : null))];
    }),
  ) as Record<Marketplace, (number | null)[]>;

  return {
    days,
    inStock: readings.map((r, i) => (r ? inStock[i] / r : null)),
    liveListings: liveListings.map((v, i) => (readings[i] ? v : null)),
    priceIndex,
  };
}

export interface Mover {
  row: Row;
  marketplace: Marketplace;
  from: number;
  to: number;
  /** Fractional change, e.g. -0.12. */
  change: number;
}

/** Live prices that changed since the previous run, biggest first. */
export function movers(rows: Row[], limit = 8): Mover[] {
  const out: Mover[] = [];
  for (const row of rows) {
    for (const m of MARKETPLACES) {
      const cell = row.cells[m];
      const now = live(cell);
      if (now == null || cell.previous == null || cell.previous === now) continue;
      out.push({
        row,
        marketplace: m,
        from: cell.previous,
        to: now,
        change: now / cell.previous - 1,
      });
    }
  }
  return out.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, limit);
}

export type AlertKind = 'out_of_stock' | 'below_target' | 'undercut' | 'rating_drop' | 'rank_lost';

export interface Alert {
  kind: AlertKind;
  sku: string | null;
  marketplace: Marketplace;
  text: string;
  /** Bigger first. */
  weight: number;
}

/** A target miss worth flagging: 5% or more under the sheet's intended SP. */
export const BELOW_TARGET = 0.05;
/** A rival this much cheaper is an undercut worth a line. */
export const UNDERCUT = 0.2;
const RATING_DROP = 0.1;
const NEW_OOS_HOURS = 26;

/** Everything that needs a look, from the data the dashboard already has. */
export function alerts(input: {
  rows: Row[];
  groups: Group[];
  availability?: AvailabilityRow[] | null;
  ratings?: RatingRow[] | null;
  searchDays?: SearchDayRow[] | null;
  now?: number;
}): Alert[] {
  const now = input.now ?? Date.now();
  const names = new Map(input.rows.map((r) => [r.sku, r.name]));
  const out: Alert[] = [];

  for (const a of input.availability ?? []) {
    if (a.status_now !== 'out_of_stock' || !names.has(a.sku)) continue;
    const hours = (now - Date.parse(a.status_since)) / 3_600_000;
    if (hours > NEW_OOS_HOURS) continue;
    out.push({
      kind: 'out_of_stock',
      sku: a.sku,
      marketplace: a.marketplace as Marketplace,
      text: `${names.get(a.sku)} went out of stock`,
      weight: 3,
    });
  }

  for (const row of input.rows) {
    for (const m of MARKETPLACES) {
      const cell = row.cells[m];
      const price = live(cell);
      if (price == null || !cell.targetSp) continue;
      const under = 1 - price / cell.targetSp;
      if (under >= BELOW_TARGET) {
        out.push({
          kind: 'below_target',
          sku: row.sku,
          marketplace: m,
          text: `${row.name} is ${Math.round(under * 100)}% under target`,
          weight: 2 + under,
        });
      }
    }
  }

  for (const g of input.groups) {
    for (const m of MARKETPLACES) {
      const s = standing(g, m);
      if (s.gap == null || s.ours == null || !s.best || s.gap / s.ours < UNDERCUT) continue;
      out.push({
        kind: 'undercut',
        sku: g.ours.sku,
        marketplace: m,
        text: `${s.best.row.brand} is ${Math.round((s.gap / s.ours) * 100)}% cheaper than ${g.ours.name}`,
        weight: 1 + s.gap / s.ours,
      });
    }
  }

  for (const r of input.ratings ?? []) {
    if (r.rating_then == null || !names.has(r.sku)) continue;
    const drop = r.rating_then - r.rating;
    if (drop < RATING_DROP - 1e-9) continue;
    out.push({
      kind: 'rating_drop',
      sku: r.sku,
      marketplace: r.marketplace as Marketplace,
      text: `${names.get(r.sku)} rating fell ${r.rating_then.toFixed(1)} → ${r.rating.toFixed(1)}`,
      weight: 2 + drop,
    });
  }

  // A keyword where IMECO was on page one the search before, and is not any more.
  const byKey = new Map<string, SearchDayRow[]>();
  for (const d of input.searchDays ?? []) {
    const key = `${d.keyword}:${d.marketplace}`;
    byKey.set(key, [...(byKey.get(key) ?? []), d]);
  }
  for (const list of byKey.values()) {
    const [today, before] = [...list].sort((a, b) => b.day.localeCompare(a.day));
    if (!today || !before) continue;
    const rank = (d: SearchDayRow) => d.best_organic_rank ?? d.best_rank;
    const was = rank(before);
    const is = rank(today);
    if (was != null && was <= 10 && (is == null || is > 10)) {
      out.push({
        kind: 'rank_lost',
        sku: null,
        marketplace: today.marketplace as Marketplace,
        text: `Dropped off page one for “${today.keyword}” (was #${was})`,
        weight: 1.5,
      });
    }
  }

  return out.sort((a, b) => b.weight - a.weight);
}

export interface BrandShare {
  brand: string;
  slots: number;
}

/** Who holds the top 20 slots across every keyword, per marketplace. IMECO first, then the
 *  `top` biggest rivals, then everyone else as "Other". */
export function shareOfSearch(
  results: SearchResultRow[],
  marketplace: Marketplace,
  top = 3,
): BrandShare[] {
  const counts = new Map<string, number>();
  for (const r of results) {
    if (r.marketplace !== marketplace || r.position > 20) continue;
    const brand = r.brand ?? 'Other';
    counts.set(brand, (counts.get(brand) ?? 0) + 1);
  }
  const imeco = counts.get('IMECO') ?? 0;
  counts.delete('IMECO');
  const unknown = counts.get('Other') ?? 0;
  counts.delete('Other');
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const named = ranked.slice(0, top).map(([brand, slots]) => ({ brand, slots }));
  const rest = ranked.slice(top).reduce((n, [, v]) => n + v, 0) + unknown;
  return [{ brand: 'IMECO', slots: imeco }, ...named, { brand: 'Other', slots: rest }];
}
