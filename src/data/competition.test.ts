import { describe, expect, it } from 'vitest';

import { buildGroups, ordinal, standing, winLoss } from './competition';
import type { Cell, Marketplace, Row } from './types';

function cell(marketplace: Marketplace, price: number | null, status = 'ok'): Cell {
  return {
    marketplace,
    status: status as Cell['status'],
    price,
    mrp: null,
    unit: null,
    note: null,
    url: price == null && status === 'ok' ? null : 'https://x',
    targetSp: null,
    previous: null,
  };
}

function row(sku: string, amazon: number | null, competitorOf: string | null = null): Row {
  return {
    sku,
    name: sku,
    brand: competitorOf ? 'Rival' : 'IMECO',
    competitorOf,
    starred: false,
    position: 0,
    mrp: null,
    cells: {
      amazon: cell('amazon', amazon),
      flipkart: cell('flipkart', null),
      blinkit: cell('blinkit', null),
    },
    minPrice: amazon,
    liveCount: amazon == null ? 0 : 1,
    shownCount: amazon == null ? 0 : 1,
  } as unknown as Row;
}

describe('standing', () => {
  it('ranks IMECO among the live prices and measures the gap to the cheapest rival', () => {
    const [g] = buildGroups([row('A', 150)], [row('R1', 120, 'A'), row('R2', 200, 'A')]);
    const s = standing(g, 'amazon');
    expect(s.rank).toBe(2);
    expect(s.of).toBe(3);
    expect(s.gap).toBe(30);
    expect(s.best?.row.sku).toBe('R1');
  });

  it('has no rank when IMECO is not live', () => {
    const [g] = buildGroups([row('A', null)], [row('R1', 120, 'A')]);
    expect(standing(g, 'amazon').rank).toBeNull();
  });
});

describe('winLoss', () => {
  it('counts cheapest, tied and undercut products', () => {
    const groups = buildGroups(
      [row('A', 100), row('B', 100), row('C', 100)],
      [row('RA', 120, 'A'), row('RB', 100, 'B'), row('RC', 90, 'C')],
    );
    expect(winLoss(groups)).toEqual({ cheapest: 1, tied: 1, undercut: 1 });
  });
});

it('ordinal', () => {
  expect([1, 2, 3, 4, 11, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '22nd']);
});
