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
 * `position` was added to the schema after this dashboard shipped, and PostgREST answers a
 * request for a column that does not exist with a 400 rather than by ignoring it. So a
 * database that has not had the migration in supabase/schema.sql applied would show no prices
 * at all — the retry below is what stops a pending migration from blanking the wall display.
 * It costs one extra request only while the column is missing.
 */
async function fetchProducts(): Promise<ProductRow[]> {
  try {
    return await get<ProductRow[]>(
      `products?select=${PRODUCT_COLS},position&order=position.asc.nullslast`,
      'products',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('position')) throw err;
    console.warn('[prices] products.position missing — run supabase/schema.sql to restore sheet order');
    return get<ProductRow[]>(`products?select=${PRODUCT_COLS}`, 'products');
  }
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
