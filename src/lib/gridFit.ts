// How big the heatmap's type can be. Pure, and kept out of the component so it can be
// pinned by tests rather than judged by eye on the wall.
//
// The grid is read from across a room, so bigger is always better — but the page is a fixed
// one-screen shell (`lg:h-svh lg:overflow-hidden`) and nobody is standing at the TV to scroll
// a row into view. So the size is not a constant: it is the largest that still fits every row
// on screen, capped so it never gets comic on a short list.

/**
 * The floor, and it is deliberately high: nothing smaller is readable from across a room,
 * which is the only thing this screen is for. So the grid stops shrinking here and scrolls
 * instead.
 *
 * It is set EQUAL to MAX_PX on purpose, which makes the type a constant 21px on a 1080 screen
 * rather than a fitted value. That is a deliberate override of this file's original goal.
 *
 * The reason is that the two boards hang on the same wall and have to read as one system, and
 * marketplace-dispatch-dashboard renders at 21px (measured live: 23 rows in an 892px grid).
 * This catalogue is 32 rows in a 968px grid, and the fit solved to 16px — visibly smaller type
 * beside an identical-looking board, which read as a different, lesser screen.
 *
 * WHAT IT COSTS, measured rather than estimated: 32 rows at 21px make a 1,185px table in a
 * 968px grid, so the last SEVEN products sit below the fold and the grid scrolls. Matching the
 * sibling board was chosen over showing every row unattended. Lower this back to 16 to reverse
 * that trade — it is the only line that has to change.
 *
 * Note this is a 1080-window problem specifically. On a 4K panel reporting its full 3840x2160
 * the cap scales with the box (see CAP_DIVISOR), the fit lands near 39px, and all 32 rows fit
 * with room to spare — so the wall display itself is not where this bites.
 */
export const MIN_PX = 21;

/**
 * The cap on a 1080 screen — ~1.75x the 12px this grid used to be, and about where the
 * height budget runs out anyway: 23 rows in a ~890px card top out near 21px.
 */
export const MAX_PX = 21;

/**
 * ...but the cap cannot be a constant, because a CSS pixel is not a fixed angular size.
 *
 * A 4K TV whose browser reports the full 3840x2160 gives every element half the physical
 * size it has on a 1080 screen, so a flat 21px cap renders HALF AS BIG across the room —
 * which is the whole thing this grid exists to avoid. Scaling the cap with the height of the
 * box keeps the type the same fraction of the screen at any resolution. (A 4K panel whose
 * browser reports 1920x1080 at DPR 2 is already correct and lands on MAX_PX, unchanged.)
 *
 * 42 is chosen so a 1080 screen's ~890px grid comes out at MAX_PX exactly — the divisor is
 * calibrated to the size that was signed off, not picked for roundness.
 */
const CAP_DIVISOR = 42;
/** Past this the grid stops being a table and starts being a poster. */
const CAP_LIMIT = 56;

/** The cap for a box this tall: MAX_PX on a 1080 screen, proportionally more on a 4K one. */
export function maxFontSize(availablePx: number): number {
  return Math.min(CAP_LIMIT, Math.max(MAX_PX, Math.round(availablePx / CAP_DIVISOR)));
}

// A row's height is NOT a plain multiple of the font size: the line box scales with the type
// but the padding does not. So each row costs `line * fontPx + padPx`, and the fit is solved
// for `fontPx` across the whole grid.
//
// THESE MUST TRACK Heatmap.tsx. The `line` figures are the `leading-*` on the cells (which
// has to be set explicitly — the table's own `text-sm` otherwise pins every line box at 20px
// no matter what size the text is, which is exactly the bug that made the first version of
// this size the grid to a height it did not really occupy). The `pad` figures are the `py-*`
// plus anything else drawn into the row band.

/** `border-spacing-0.5` — 2px of gutter under every row, header rows included. */
const GAP_PX = 2;
/** `leading-[1.15]` on the data cells. */
const LINE = 1.15;

/**
 * Data cells render their annotation INLINE with the price ("₹301 +8.7%"), not on a second
 * line, so a row still costs one line box.
 *
 * That is a deliberate constraint rather than a style choice. A stacked annotation makes each
 * row ~60% taller, and 32 products then need ~1,250px of grid — more than a 1080 wall display
 * has after the header. The grid would floor at MIN_PX and scroll, which on an
 * unattended screen means the bottom third of the catalogue is simply never seen. The data
 * columns are ~250px at 1920, which fits price and annotation on one line comfortably.
 *
 * If a stacked layout is ever reintroduced, add `+ 0.62 * 1.1` to ROW_LINE.
 */

/**
 * The single header row: `h-[calc(var(--grid-font)*2)]`, so pure font, plus the 2px underline
 * beneath it.
 *
 * It was two rows — column labels, then per-marketplace totals — until they were merged. The
 * merged row carries 1.1x type inside a 2x band, which fits comfortably; if that type ever
 * grows past 1.7x the band has to grow with it or the summary will clip.
 */
const HEAD_LINE = 2.0;
const HEAD_PAD = 2 + GAP_PX;

/** A product row: `py-1`. */
const ROW_LINE = LINE;
const ROW_PAD = 8 + GAP_PX;

/**
 * The largest font size at which `rowCount` products, plus the header row, still fit in
 * `availablePx`.
 *
 * Clamped at both ends: `maxFontSize` for this box when there is room to spare, `MIN_PX` when
 * there is not — hitting the floor means the grid scrolls, which is the lesser evil against
 * type nobody can read at any distance.
 */
export function fitFontSize(availablePx: number, rowCount: number): number {
  const rows = Math.max(0, rowCount);
  const fixed = HEAD_PAD + ROW_PAD * rows;
  const perPx = HEAD_LINE + ROW_LINE * rows;
  const room = availablePx - fixed;
  if (!(room > 0)) return MIN_PX;
  return Math.min(maxFontSize(availablePx), Math.max(MIN_PX, Math.floor(room / perPx)));
}
