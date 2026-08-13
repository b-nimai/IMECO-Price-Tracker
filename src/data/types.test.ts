import { describe, expect, it } from 'vitest';

import { buildPriceData, type ProductRow, type SnapshotRow } from './types';

function product(sku: string, position: number | null, urls: Record<string, string> = {}): ProductRow {
  return { sku, name: sku, mrp: 100, starred: false, position, target_sp: null, urls };
}

function snapshot(sku: string, marketplace: string, price: number | null): SnapshotRow {
  return {
    sku,
    marketplace,
    price,
    mrp: null,
    unit: null,
    status: price == null ? 'blocked' : 'ok',
    via: 'direct',
    note: null,
    checked_at: '2026-08-13T06:00:00Z',
  };
}

describe('buildPriceData', () => {
  it('drops products the current sheet no longer lists', () => {
    const data = buildPriceData(
      [product('KEPT', 0), product('WITHDRAWN', null)],
      [snapshot('KEPT', 'amazon', 200), snapshot('WITHDRAWN', 'amazon', 300)],
    );
    expect(data.rows.map((r) => r.sku)).toEqual(['KEPT']);
  });

  it('does not count a withdrawn product’s listings in the totals', () => {
    const data = buildPriceData(
      [product('KEPT', 0), product('WITHDRAWN', null)],
      [snapshot('KEPT', 'amazon', 200), snapshot('WITHDRAWN', 'amazon', 300)],
    );
    expect(data.totals.live).toBe(1);
  });

  it('keeps every product when none has a position, so a pre-migration database still renders', () => {
    const data = buildPriceData([product('A', null), product('B', null)], []);
    expect(data.rows.map((r) => r.sku)).toEqual(['A', 'B']);
  });

  it('marks a listing with a link but no snapshot as pending, not as unlinked', () => {
    const data = buildPriceData([product('NEW', 0, { amazon: 'https://amazon.in/dp/X' })], []);
    expect(data.rows[0].cells.amazon.status).toBe('pending');
    expect(data.rows[0].cells.flipkart.status).toBe('not_listed');
  });

  it('a snapshot always wins over the pending placeholder', () => {
    const data = buildPriceData(
      [product('NEW', 0, { amazon: 'https://amazon.in/dp/X' })],
      [snapshot('NEW', 'amazon', 250)],
    );
    expect(data.rows[0].cells.amazon.status).toBe('ok');
    expect(data.rows[0].cells.amazon.price).toBe(250);
  });
});
