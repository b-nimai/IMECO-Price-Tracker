import { describe, expect, it } from 'vitest';

import { HIGH_PRICE, LOW_PRICE, discountLabel, fill, position, rowDomain } from './priceScale';

describe('rowDomain', () => {
  it('sorts ascending and drops absent prices', () => {
    expect(rowDomain([199, null, 89, undefined, 149])).toEqual([89, 149, 199]);
  });

  it('collapses duplicates so ties shade identically', () => {
    // Real row: Amazon and Myntra both at 198. Two cells at the same price must be the same
    // colour — with duplicates left in they would rank a step apart for no visible reason.
    expect(rowDomain([198, 174, 198])).toEqual([174, 198]);
  });

  it('rejects non-positive prices rather than ranking them', () => {
    expect(rowDomain([0, -5, 120])).toEqual([120]);
  });
});

describe('position', () => {
  const domain = rowDomain([159, 249, 237, 199]); // [159, 199, 237, 249]

  it('puts the highest selling price at the green end', () => {
    expect(position(249, domain)).toBe(1);
  });

  it('puts the lowest at the yellow end', () => {
    expect(position(159, domain)).toBe(0);
  });

  it('spaces the middle evenly by rank, not by value', () => {
    // 199 and 237 are 38 apart while 159 and 199 are 40 apart, but rank is what is drawn:
    // four distinct prices become four even steps.
    expect(position(199, domain)).toBeCloseTo(1 / 3, 6);
    expect(position(237, domain)).toBeCloseTo(2 / 3, 6);
  });

  it('gives tied prices the same position', () => {
    const tied = rowDomain([198, 174, 198]);
    expect(position(198, tied)).toBe(position(198, tied));
    expect(position(198, tied)).toBe(1);
    expect(position(174, tied)).toBe(0);
  });
});

// The load-bearing guarantee: absent must never be renderable as a value, and a lone value must
// never be renderable as a comparison.
describe('a lone live listing is the row\'s highest price, so it shades green', () => {
  it('scores 1 rather than null', () => {
    // The one channel still selling a product must not look like the one channel that failed,
    // which is exactly how an unshaded cell reads next to its black neighbours.
    expect(position(299, rowDomain([299]))).toBe(1);
    expect(position(163, rowDomain([163, null, null, null]))).toBe(1);
  });
});

describe('position returns null rather than a colour when there is nothing to rank', () => {
  it('when the row has no live listing at all', () => {
    expect(position(299, [])).toBeNull();
  });

  it('when there is no price', () => {
    expect(position(null, [89, 199])).toBeNull();
  });

  it('when the price is non-positive', () => {
    expect(position(0, [89, 199])).toBeNull();
    expect(position(-5, [89, 199])).toBeNull();
  });

  it('when the price is not in its own row — an out-of-stock cell, which is never ranked', () => {
    expect(position(449, [89, 199])).toBeNull();
  });
});

describe('fill', () => {
  it('anchors on the ramp endpoints', () => {
    expect(fill(0)).toContain(LOW_PRICE);
    expect(fill(1)).toContain(HIGH_PRICE);
    expect(fill(1)).toContain('100.0%');
  });

  it('is a continuous mix between them', () => {
    expect(fill(0.5)).toContain('50.0%');
    expect(fill(1 / 3)).toContain('33.3%');
  });

  it('clamps rather than emitting an out-of-range mix', () => {
    expect(fill(-1)).toContain('0.0%');
    expect(fill(2)).toContain('100.0%');
  });
});

describe('discountLabel', () => {
  it('reports the discount off MRP', () => {
    // B0GLNWPCPT: live 301 against MRP 499.
    expect(discountLabel(301, 499)).toBe('40% off');
    expect(discountLabel(89, 249)).toBe('64% off');
  });

  it('says nothing when there is no discount to report', () => {
    expect(discountLabel(500, 500)).toBeNull();
    expect(discountLabel(520, 500)).toBeNull();
    expect(discountLabel(299, null)).toBeNull();
    expect(discountLabel(null, 499)).toBeNull();
  });
});
