import { describe, expect, it } from 'vitest';

import { buildGroups } from './competition';
import { alerts, daySeries, movers, shareOfSearch } from './overview';
import type { PriceDailyRow, SearchResultRow } from './supabaseClient';
import type { Cell, Marketplace, Row } from './types';

function cell(m: Marketplace, price: number | null, extra: Partial<Cell> = {}): Cell {
  return {
    marketplace: m,
    status: price == null ? 'pending' : 'ok',
    price,
    mrp: null,
    unit: null,
    note: null,
    url: price == null ? null : 'https://x',
    targetSp: null,
    previous: null,
    ...extra,
  };
}

function row(
  sku: string,
  amazon: Partial<Cell> & { price: number | null },
  competitorOf: string | null = null,
): Row {
  return {
    sku,
    name: sku,
    brand: competitorOf ? 'Rival' : 'IMECO',
    competitorOf,
    starred: false,
    position: 0,
    mrp: null,
    cells: {
      amazon: cell('amazon', amazon.price, amazon),
      flipkart: cell('flipkart', null),
      blinkit: cell('blinkit', null),
    },
  } as unknown as Row;
}

function day(
  sku: string,
  d: string,
  close: number | null,
  inStock: number,
  readings = 2,
): PriceDailyRow {
  return {
    sku,
    marketplace: 'amazon',
    day: d,
    close_price: close,
    low_price: close,
    high_price: close,
    readings,
    in_stock: inStock,
  };
}

describe('daySeries', () => {
  it('indexes each listing against its own median and counts stock per day', () => {
    const s = daySeries(
      [
        day('A', '2026-10-01', 100, 2),
        day('A', '2026-10-02', 90, 1),
        day('A', '2026-10-03', 100, 0),
        day('X', '2026-10-01', 5, 2),
      ],
      new Set(['A']),
    );
    expect(s.days).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(s.priceIndex.amazon).toEqual([100, 90, 100]);
    expect(s.inStock).toEqual([1, 0.5, 0]);
    expect(s.liveListings).toEqual([1, 1, 0]);
  });
});

describe('movers', () => {
  it('lists live prices that changed, biggest change first', () => {
    const m = movers([
      row('A', { price: 90, previous: 100 }),
      row('B', { price: 50, previous: 100 }),
      row('C', { price: 10, previous: 10 }),
    ]);
    expect(m.map((x) => x.row.sku)).toEqual(['B', 'A']);
    expect(m[0].change).toBeCloseTo(-0.5);
  });
});

describe('alerts', () => {
  it('flags a price under target and a big undercut', () => {
    const rows = [row('A', { price: 90, targetSp: 100 })];
    const groups = buildGroups(rows, [row('R', { price: 60 }, 'A')]);
    const kinds = alerts({ rows, groups }).map((a) => a.kind);
    expect(kinds).toContain('below_target');
    expect(kinds).toContain('undercut');
  });

  it('flags a keyword that fell off page one', () => {
    const base = {
      keyword: 'k',
      marketplace: 'amazon',
      results: 40,
      best_rank: null,
      imeco_top10: 0,
      top10: 10,
      imeco_ads: 0,
    };
    const list = alerts({
      rows: [],
      groups: [],
      searchDays: [
        { ...base, day: '2026-10-26', best_organic_rank: 4 },
        { ...base, day: '2026-10-27', best_organic_rank: 15 },
      ],
    });
    expect(list.map((a) => a.kind)).toEqual(['rank_lost']);
  });
});

describe('shareOfSearch', () => {
  it('puts IMECO first, the biggest rivals next, and the rest in Other', () => {
    const r = (brand: string | null, position: number): SearchResultRow => ({
      keyword: 'k',
      marketplace: 'amazon',
      position,
      listing_id: String(position),
      title: null,
      brand,
      matched_sku: null,
      price: null,
      sponsored: false,
      checked_at: '',
    });
    const shares = shareOfSearch(
      [r('IMECO', 1), r('Beco', 2), r('Beco', 3), r('Ezee', 4), r(null, 5), r('Beco', 25)],
      'amazon',
      1,
    );
    expect(shares).toEqual([
      { brand: 'IMECO', slots: 1 },
      { brand: 'Beco', slots: 2 },
      { brand: 'Other', slots: 2 },
    ]);
  });
});
