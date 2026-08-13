// How wide the product-name column has to be: exactly the longest name in the catalogue, and
// not a pixel more. Pure, and kept out of the component so the clamping can be pinned by tests.
//
// This replaced a font multiple (34x). A multiple has to be set for the longest name anyone
// might ever add, so it is always too wide for the names actually on screen — it left ~100px of
// dead space beside every row while the price columns went short. Measuring the real strings
// spends the column on the names that exist.

/**
 * The name type's size relative to `--grid-font`, and its tracking in em.
 *
 * BOTH MUST MATCH `NAME_TEXT` in Heatmap.tsx. They are here because the measurement has to be
 * made in the same type the cell will render in — a width measured at the wrong size is worse
 * than no measurement, since it would confidently truncate.
 */
export const NAME_SCALE = 0.92;
export const NAME_TRACKING_EM = -0.01;
/** `font-semibold` on the name cell. */
export const NAME_WEIGHT = 600;

/** `TableCell`'s `p-2`, both sides. The text has to fit BETWEEN these. */
export const NAME_PAD_PX = 16;

/**
 * The floor. Below this the column stops being a product name and becomes an abbreviation, so a
 * catalogue of very short names still gets a column worth reading.
 */
export const MIN_NAME_PX = 120;

/**
 * The ceiling, as a share of the grid's width.
 *
 * The name column is spent out of the price columns, and the prices are the point of the board.
 * A pathological 200-character name must not squeeze them to nothing — past this the name
 * truncates (the cell keeps `truncate` + its tooltip) rather than eating the grid.
 */
export const MAX_NAME_SHARE = 0.45;

/**
 * Column width for a longest-name measurement of `longestTextPx`, inside a grid `containerPx`
 * wide. `containerPx` of 0 (not yet laid out) means the cap simply does not apply yet.
 */
export function nameColumnWidth(longestTextPx: number, containerPx: number): number {
  const wanted = Math.ceil(longestTextPx) + NAME_PAD_PX;
  const cap = containerPx > 0 ? containerPx * MAX_NAME_SHARE : Number.POSITIVE_INFINITY;
  // The floor wins over the cap: on a container too narrow for even MIN_NAME_PX, a column
  // sized to 45% of nothing is unreadable, and the grid scrolls horizontally anyway.
  return Math.round(Math.max(MIN_NAME_PX, Math.min(wanted, Math.max(MIN_NAME_PX, cap))));
}

/**
 * The width of the widest string in `names`, in the cell's own type.
 *
 * `measureText` is the browser's own text shaping, so this agrees with what will be painted —
 * which a character count multiplied by an average width does not, especially for a catalogue
 * where the widest name is not the longest one ("(27 x 30 cm)" vs "IMECO Natural Clean").
 *
 * Returns 0 when there is nothing to measure or no canvas (jsdom), which the caller reads as
 * "no measurement yet" and falls back to the floor.
 */
export function measureNames(names: string[], fontPx: number, fontFamily: string): number {
  if (!names.length) return 0;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;

  const size = fontPx * NAME_SCALE;
  ctx.font = `${NAME_WEIGHT} ${size}px ${fontFamily}`;

  // Chrome honours this and the measurement then includes the tracking exactly. Where it is
  // unsupported the property assignment is simply ignored, so the tracking is added by hand
  // below — it is negative, and un-subtracted it would over-measure by ~6px on a 60-character
  // name, which costs nothing but a few pixels of slack.
  const spaced = 'letterSpacing' in ctx;
  if (spaced) ctx.letterSpacing = `${NAME_TRACKING_EM}em`;

  let widest = 0;
  for (const name of names) {
    const width =
      ctx.measureText(name).width +
      (spaced ? 0 : NAME_TRACKING_EM * size * Math.max(0, name.length - 1));
    if (width > widest) widest = width;
  }
  return widest;
}
