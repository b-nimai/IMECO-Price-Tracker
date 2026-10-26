// Supabase fetch layer.
//
// Plain PostgREST over fetch rather than @supabase/supabase-js: the dashboard makes three GETs
// and needs none of the SDK's auth, realtime or storage surface, so pulling it in would be
// ~40 KB of bundle for a URL builder.
//
// The anon key here is compiled into a public bundle and that is fine BY DESIGN — the schema
// enables RLS with select-only policies, so this key cannot write. If that ever stops being
// true, this key stops being safe. See supabase/schema.sql.

import type { ProductRow, SnapshotRow } from './types';

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const CONFIGURED = Boolean(URL && KEY);

const LS_KEY = 'imeco:prices:v1';
/** Matches the poll in usePriceData — anything older is revalidated on boot. */
export const TTL_MS = 2 * 60 * 1000;

export interface CachedPayload {
  fetchedAt: number;
  products: ProductRow[];
  snapshots: SnapshotRow[];
  previous: SnapshotRow[];
}

async function get<T>(path: string, label: string): Promise<T> {
  if (!CONFIGURED) throw new Error('Supabase is not configured');
  const response = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY as string, Authorization: `Bearer ${KEY}` },
  });
  if (!response.ok) {
    throw new Error(`${label} ${response.status}: ${(await response.text()).slice(0, 160)}`);
  }
  return (await response.json()) as T;
}

/**
 * Fallback for when Supabase is not configured: a real scrape captured to a static file by
 * `python -m desktop.run --fixture public/demo-prices.json`.
 *
 * Deliberately the SAME row shapes the database returns, so the rendering path is not
 * special-cased for it — a bug that shows up in demo mode is a real bug. The dashboard labels
 * itself as demo data so this can never be mistaken for live pricing.
 */
export async function fetchDemo(): Promise<Omit<CachedPayload, 'fetchedAt'>> {
  const response = await fetch(`${import.meta.env.BASE_URL}demo-prices.json`);
  if (!response.ok) throw new Error(`demo data ${response.status}`);
  const data = (await response.json()) as { products: ProductRow[]; snapshots: SnapshotRow[] };
  return { products: data.products, snapshots: data.snapshots, previous: [] };
}

/**
 * The latest reading per SKU x marketplace, plus the run before it.
 *
 * The two runs are what power the change markers. The previous run is fetched by id rather
 * than by "second newest timestamp per cell", because cells within one run have slightly
 * different timestamps and a per-cell query would mix runs together.
 */
const PRODUCT_COLS = 'sku,name,mrp,starred,target_sp,urls';

/**
 * The catalogue, in the spreadsheet's own row order.
 *
 * `position`, then `brand` / `competitor_of`, were added to the schema after this dashboard
 * shipped, and PostgREST answers a request for a column that does not exist with a 400 rather
 * than by ignoring it. So a database that has not had the migrations in supabase/schema.sql
 * applied would show no prices at all — the fallbacks below are what stop a pending migration
 * from blanking the wall display. Each costs one extra request only while its column is missing.
 */
async function fetchProducts(): Promise<ProductRow[]> {
  const attempts = [
    `${PRODUCT_COLS},position,brand,competitor_of&order=position.asc.nullslast`,
    `${PRODUCT_COLS},position&order=position.asc.nullslast`,
    PRODUCT_COLS,
  ];
  for (const [i, cols] of attempts.entries()) {
    try {
      return await get<ProductRow[]>(`products?select=${cols}`, 'products');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const missing = /position|brand|competitor_of/.exec(message)?.[0];
      if (!missing || i === attempts.length - 1) throw err;
      console.warn(`[prices] products.${missing} missing — run supabase/schema.sql`);
    }
  }
  throw new Error('unreachable');
}

export async function fetchPrices(): Promise<Omit<CachedPayload, 'fetchedAt'>> {
  const [products, snapshots, runs] = await Promise.all([
    fetchProducts(),
    get<SnapshotRow[]>(
      'latest_prices?select=sku,marketplace,price,mrp,unit,status,via,note,checked_at',
      'latest_prices',
    ),
    // Only finished runs. An in-flight run is half-written, and reading it would show a
    // partially-scraped picture as though it were current.
    get<{ id: string }[]>(
      'runs?select=id&finished_at=not.is.null&order=finished_at.desc&limit=2',
      'runs',
    ),
  ]);

  let previous: SnapshotRow[] = [];
  if (runs.length > 1) {
    previous = await get<SnapshotRow[]>(
      `price_snapshots?select=sku,marketplace,price,mrp,unit,status,via,note,checked_at&run_id=eq.${runs[1].id}`,
      'previous run',
    );
  }

  return { products, snapshots, previous };
}

// ── history (Trends tab) ────────────────────────────────────────────────────────────────
// Fetched on demand when the tab is opened, never by the 2-minute poll: the wall display
// should not pay for a view nobody is looking at.

export interface HistoryRow {
  marketplace: string;
  price: number | null;
  status: string;
  checked_at: string;
}

/** PostgREST answers at most 1,000 rows per request; 90 days of one product is ~6.5k. */
const PAGE = 1000;

/** Every row of a query, a page at a time. `path` must carry a stable `order`. */
async function getAll<T>(path: string, label: string): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await get<T[]>(`${path}&limit=${PAGE}&offset=${offset}`, label);
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

/** Every reading of one product over the last `days`, oldest first. */
export async function fetchHistory(sku: string, days: number): Promise<HistoryRow[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return getAll<HistoryRow>(
    `price_snapshots?select=marketplace,price,status,checked_at` +
      `&sku=eq.${encodeURIComponent(sku)}&checked_at=gte.${encodeURIComponent(since)}` +
      `&order=checked_at.asc,id.asc`,
    'history',
  );
}

export interface PriceStatsRow {
  sku: string;
  marketplace: string;
  min_ever: number | null;
  max_ever: number | null;
  min_30d: number | null;
  max_30d: number | null;
  changes_30d: number;
  first_seen: string;
}

/** Lows, highs and change counts per listing — the `price_stats` view in supabase/schema.sql. */
export async function fetchPriceStats(): Promise<PriceStatsRow[]> {
  return get<PriceStatsRow[]>(
    'price_stats?select=sku,marketplace,min_ever,max_ever,min_30d,max_30d,changes_30d,first_seen',
    'price_stats',
  );
}

// ── availability & ratings (their tabs) ─────────────────────────────────────────────────
// Views in supabase/schema.sql, each one row per listing. Same on-demand rule as history.

export interface AvailabilityRow {
  sku: string;
  marketplace: string;
  status_now: 'ok' | 'out_of_stock';
  checks_7d: number;
  in_stock_7d: number;
  checks_30d: number;
  in_stock_30d: number;
  /** First reading of the current state inside the last 30 days. */
  status_since: string;
  /** No change at all in 30 days — `status_since` is then just where the window starts. */
  unchanged_30d: boolean;
}

export async function fetchAvailability(): Promise<AvailabilityRow[]> {
  return get<AvailabilityRow[]>(
    'availability_stats?select=sku,marketplace,status_now,checks_7d,in_stock_7d,checks_30d,in_stock_30d,status_since,unchanged_30d',
    'availability_stats',
  );
}

export interface StoreRow {
  sku: string;
  area: string;
  city: string;
  status_now: string;
  price_now: number | null;
  checked_at: string;
  checks_7d: number;
  in_stock_7d: number;
}

/** Each Blinkit dark store's latest answer per listing — the `blinkit_store_stats` view. */
export async function fetchBlinkitStores(): Promise<StoreRow[]> {
  return get<StoreRow[]>(
    'blinkit_store_stats?select=sku,area,city,status_now,price_now,checked_at,checks_7d,in_stock_7d',
    'blinkit_store_stats',
  );
}

export interface RatingRow {
  sku: string;
  marketplace: string;
  rating: number;
  rating_count: number | null;
  checked_at: string;
  /** Earliest rating inside the last 30 days, for the change. */
  rating_then: number | null;
  count_then: number | null;
  then_at: string | null;
}

export async function fetchRatings(): Promise<RatingRow[]> {
  return get<RatingRow[]>(
    'rating_trend?select=sku,marketplace,rating,rating_count,checked_at,rating_then,count_then,then_at',
    'rating_trend',
  );
}

// ── search ranks (Search tab) ───────────────────────────────────────────────────────────

export interface SearchDayRow {
  keyword: string;
  marketplace: string;
  /** YYYY-MM-DD, India time. */
  day: string;
  results: number;
  /** IMECO's best position, ads included. Null when IMECO is not on the page at all. */
  best_rank: number | null;
  best_organic_rank: number | null;
  imeco_top10: number;
  top10: number;
  imeco_ads: number;
}

/** IMECO's daily rank per keyword x marketplace — the `search_rank_daily` view. */
export async function fetchSearchDays(days: number): Promise<SearchDayRow[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return getAll<SearchDayRow>(
    'search_rank_daily?select=keyword,marketplace,day,results,best_rank,best_organic_rank,imeco_top10,top10,imeco_ads' +
      `&day=gte.${since}&order=keyword.asc,marketplace.asc,day.asc`,
    'search_rank_daily',
  );
}

export interface SearchResultRow {
  keyword: string;
  marketplace: string;
  position: number;
  listing_id: string;
  title: string | null;
  brand: string | null;
  matched_sku: string | null;
  price: number | null;
  sponsored: boolean;
  checked_at: string;
}

/** The newest results page per keyword x marketplace — the `search_latest` view. */
export async function fetchSearchLatest(): Promise<SearchResultRow[]> {
  return getAll<SearchResultRow>(
    'search_latest?select=keyword,marketplace,position,listing_id,title,brand,matched_sku,price,sponsored,checked_at' +
      '&order=keyword.asc,marketplace.asc,position.asc',
    'search_latest',
  );
}

// ── localStorage ────────────────────────────────────────────────────────────────────────
// A reload inside the TTL paints from disk with zero network. The scrape lands once an hour,
// so a two-minute cache costs nothing in freshness.

export function readCache(): CachedPayload | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPayload;
    if (!Array.isArray(parsed?.products) || typeof parsed.fetchedAt !== 'number') return null;
    return parsed;
  } catch {
    return null; // corrupt or quota-blocked storage is not an error worth surfacing
  }
}

export function writeCache(payload: Omit<CachedPayload, 'fetchedAt'>): CachedPayload {
  const full: CachedPayload = { fetchedAt: Date.now(), ...payload };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(full));
  } catch {
    // Over quota — the render already has the data in memory.
  }
  return full;
}

export function clearCache(): void {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

export function isStale(fetchedAt: number): boolean {
  return Date.now() - fetchedAt >= TTL_MS;
}
