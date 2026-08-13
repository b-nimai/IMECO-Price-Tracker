import { describe, expect, it } from 'vitest';

import { MAX_NAME_SHARE, MIN_NAME_PX, NAME_PAD_PX, nameColumnWidth } from './nameWidth';

describe('nameColumnWidth', () => {
  it('is the measured text plus the cell padding', () => {
    expect(nameColumnWidth(600, 1920)).toBe(600 + NAME_PAD_PX);
  });

  it('never drops below the floor, however short the names', () => {
    expect(nameColumnWidth(10, 1920)).toBe(MIN_NAME_PX);
  });

  it('caps a pathologically long name so the price columns survive', () => {
    expect(nameColumnWidth(4000, 1920)).toBe(1920 * MAX_NAME_SHARE);
  });

  it('keeps the floor when the cap would fall below it', () => {
    // A container narrower than ~267px: 45% of it is unreadable, and the grid scrolls anyway.
    expect(nameColumnWidth(4000, 200)).toBe(MIN_NAME_PX);
  });

  it('applies no cap before the container has been laid out', () => {
    expect(nameColumnWidth(4000, 0)).toBe(4000 + NAME_PAD_PX);
  });

  it('rounds to whole pixels', () => {
    expect(Number.isInteger(nameColumnWidth(600.4, 1920))).toBe(true);
  });
});
