import { describe, expect, it } from 'vitest';

import { formatAgo, formatAmount, formatPrice, freshness } from './format';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

describe('formatPrice', () => {
  it('uses Indian digit grouping, not thousands-of-three', () => {
    // 1,29,999 rather than 129,999. These are .in storefronts and the numbers are read beside
    // the marketplaces' own, so the grouping has to match theirs.
    expect(formatPrice(129999)).toBe('₹1,29,999');
    expect(formatPrice(1299)).toBe('₹1,299');
  });

  it('rounds rather than showing paise', () => {
    expect(formatPrice(198.6)).toBe('₹199');
    expect(formatPrice(198.4)).toBe('₹198');
  });
});

describe('formatAmount', () => {
  it('is the same number without the symbol', () => {
    // The MRP column drops the ₹ because it would otherwise repeat on all 32 rows.
    expect(formatAmount(499)).toBe('499');
    expect(formatAmount(129999)).toBe('1,29,999');
  });
});

describe('formatAgo', () => {
  it('reads as words under a minute', () => {
    expect(formatAgo(NOW - 30_000, NOW)).toBe('just now');
  });

  it('steps up through minutes, hours and days', () => {
    expect(formatAgo(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(formatAgo(NOW - 3 * HOUR, NOW)).toBe('3h ago');
    expect(formatAgo(NOW - 50 * HOUR, NOW)).toBe('2d ago');
  });

  it('never reports a negative age when the clocks disagree', () => {
    // The scrape timestamp comes from the database, the "now" from the browser. A PC a few
    // seconds fast would otherwise render "-1m ago" on the wall.
    expect(formatAgo(NOW + 60_000, NOW)).toBe('just now');
  });
});

describe('freshness', () => {
  // The scrape runs hourly, so one missed run is amber and several are red.
  it('is fresh within the hourly cadence, with an hour of slack', () => {
    expect(freshness(NOW - 30 * 60_000, NOW)).toBe('fresh');
    expect(freshness(NOW - 1.9 * HOUR, NOW)).toBe('fresh');
  });

  it('turns stale at 2h and very-stale at 6h', () => {
    expect(freshness(NOW - 2 * HOUR, NOW)).toBe('stale');
    expect(freshness(NOW - 5 * HOUR, NOW)).toBe('stale');
    expect(freshness(NOW - 6 * HOUR, NOW)).toBe('very-stale');
  });

  it('treats "never checked" as the worst case, not the best', () => {
    // A null timestamp means no run has ever been recorded. Defaulting that to 'fresh' would
    // paint an empty board as a healthy one.
    expect(freshness(null, NOW)).toBe('very-stale');
  });
});
