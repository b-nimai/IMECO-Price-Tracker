// The heatmap's colour scale. Pure, and kept out of the component so it can be pinned by tests
// rather than judged by eye on the wall.
//
// WHAT THE COLOUR MEANS: within one product row, where this marketplace's live selling price
// ranks against the others. Green is the highest price realised for that product, yellow the
// lowest, with the ramp between them for anything in the middle. We are the seller, so a higher
// realised price is the better outcome — this is not a shopper's "cheapest is best" board.
//
// Ranking is deliberately PER ROW, not across the grid. A ₹89 tissue box and a ₹450 wipes pack
// share no meaningful scale, so a global ramp would simply paint the cheap products yellow and
// the expensive ones green and say nothing about pricing. Rank also means the reading is
// unaffected by the size of the spread: three marketplaces within ₹4 of each other still get a
// clear best and worst, which is the comparison someone at the wall is actually making.
//
// The two non-price states are absolute, not ranked, because they are not prices:
//   out of stock -> red    (a listing that cannot be bought at any price)
//   no data      -> black  (not listed, blocked, or unreadable — we are not claiming anything)

/** Lowest live selling price in the row. */
export const LOW_PRICE = '#ffeb84';
/** Highest live selling price in the row. */
export const HIGH_PRICE = '#63be7b';
/** Out of stock. Absolute, never part of the ranking. */
export const OUT_OF_STOCK = '#f8696b';
/** No price to show at all. */
export const NO_DATA = '#000000';

/** Every filled cell is a light pastel, so ink is dark unconditionally. */
export const INK = '#0a0a0a';

/** Ink for the black no-data cells, which are the one exception to the rule above. */
export const NO_DATA_INK = '#6b6b6b';

/**
 * The comparable prices of one row, as the ascending list of DISTINCT values.
 *
 * Distinct is what makes ties tie: two marketplaces at ₹198 must land on the same colour, and
 * with duplicates left in they would rank one step apart and shade differently for no reason
 * anyone at the wall could explain.
 */
export function rowDomain(prices: (number | null | undefined)[]): number[] {
  const live = prices.filter((p): p is number => p != null && p > 0);
  return [...new Set(live)].sort((a, b) => a - b);
}

/**
 * Where a price sits on the ramp: 0 = lowest in its row (yellow), 1 = highest (green).
 *
 * A row with a SINGLE live listing scores 1 and is drawn green. It is the highest price that
 * product currently realises — the fact that it is also the lowest does not make it less true,
 * and leaving it grey was worse in practice: the eye reads an unshaded cell as a gap, so the
 * one channel still selling a product looked like the one channel that had failed.
 *
 * Returns `null` only when there is genuinely nothing to place: no price, or a price that is
 * not part of its own row's domain (an out-of-stock number, which is never ranked).
 */
export function position(price: number | null, domain: number[]): number | null {
  if (price == null || price <= 0 || domain.length === 0) return null;
  const rank = domain.indexOf(price);
  if (rank < 0) return null;
  if (domain.length === 1) return 1;
  return rank / (domain.length - 1);
}

/** 0 = yellow (lowest price in the row), 1 = green (highest). */
export function fill(t: number): string {
  const pct = (t < 0 ? 0 : t > 1 ? 1 : t) * 100;
  return `color-mix(in oklab, ${HIGH_PRICE} ${pct.toFixed(1)}%, ${LOW_PRICE})`;
}

/**
 * The discount annotation beside a price — the one number the old three-metric toggle is now
 * reduced to. `null` where there is no MRP to measure against, or where the "discount" would be
 * zero or negative, because "0% off" is noise on 32 rows.
 */
export function discountLabel(price: number | null, mrp: number | null | undefined): string | null {
  if (price == null || price <= 0 || mrp == null || mrp <= price) return null;
  return `${(((mrp - price) / mrp) * 100).toFixed(0)}% off`;
}

export const LEGEND =
  'colour ranks the live selling price within each row · green = highest realised · ' +
  'yellow = lowest · red = out of stock · black = no price';
