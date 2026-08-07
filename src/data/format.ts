// Number and time formatting. ONE copy — mission-control has this duplicated across two files
// and they have already drifted apart.

const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** 1299 → "₹1,299" (Indian grouping, matching the marketplaces' own locale). */
export function formatPrice(n: number): string {
  return `₹${INR.format(Math.round(n))}`;
}

/** Bare number, no symbol — for the MRP column, where the ₹ would be repeated 32 times. */
export function formatAmount(n: number): string {
  return INR.format(Math.round(n));
}

export function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

/** Relative freshness for the header: "synced 4m ago". */
export function formatAgo(ts: number, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * How alarmed to be about the age of the data.
 *
 * This exists because prices are only as fresh as the last time someone ran the desktop app.
 * A silently stale board is the main failure mode of that design, so staleness is surfaced
 * rather than left for someone to work out from a timestamp.
 *
 * The scrape is scheduled hourly, so 2h means a run was missed rather than merely late — one
 * hour of slack absorbs a long run or a PC that woke up late without crying wolf. 6h means the
 * machine has been off, or something is failing every time.
 */
export type Freshness = 'fresh' | 'stale' | 'very-stale';

export function freshness(ts: number | null, now = Date.now()): Freshness {
  if (ts === null) return 'very-stale';
  const hours = (now - ts) / 3_600_000;
  if (hours >= 6) return 'very-stale';
  if (hours >= 2) return 'stale';
  return 'fresh';
}
