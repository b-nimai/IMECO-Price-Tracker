import { type CSSProperties } from 'react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatAmount, formatPrice } from '@/data/format';
import { MARKETPLACES, MARKETPLACE_LABELS, type Cell, type Row } from '@/data/types';
import { useGridFit } from '@/hooks/useGridFit';
import { useNameWidth } from '@/hooks/useNameWidth';
import { cn } from '@/lib/utils';

/**
 * Every cell is the same black plate with white type — no heatmap, no status colour.
 *
 * The grid used to rank each row's prices on a yellow-to-green ramp and paint out-of-stock red.
 * That was removed on request: this board is read as a price table, and the colour was carrying
 * a second, competing argument across it.
 *
 * The hairline is what replaces it. With every cell the same colour there is nothing to
 * separate one from the next, so the 1px inset border is the only thing keeping this legible as
 * a grid rather than a wall of numbers.
 */
const PLATE: CSSProperties = {
  backgroundColor: '#000000',
  color: '#ffffff',
  boxShadow: 'inset 0 0 0 1px var(--border)',
};

/**
 * The two pinned columns are sized from `--name-w` / `--mrp-w`, both computed below. Each is a
 * `min()` of a type multiple AND a share of the viewport, and the second half is what stops the
 * grid breaking: the type size is measured from the grid's HEIGHT while a column is spent out
 * of its WIDTH, and on a tall-narrow screen a pure type multiple eats the whole viewport.
 *
 * Below `lg` both collapse to fixed widths — on a phone a proportional name column would leave
 * no room at all for the data, so names fall back to `truncate` + tooltip.
 *
 * MRP is a type multiple, 5.4x — it holds "₹597" and never anything longer, so its width is a
 * property of the type rather than of the data. It was 6x; the trim goes to the names.
 *
 * The NAME column is not a multiple at all. It is measured from the longest name actually on
 * the board (`useNameWidth`) and set to exactly that, because any fixed multiple is wrong in
 * one of two directions: 25x cut "Good Habbit 100 Pulls Facial Tissue Box Assorted - Pack of 2"
 * off mid-word, and 34x fit it with ~100px of dead space left over beside every shorter row.
 * Both are paid for out of the price columns, which under `table-fixed` split whatever is left.
 */
const NAME_W =
  'w-[12rem] min-w-[12rem] max-w-[12rem] lg:w-[var(--name-w)] lg:min-w-[var(--name-w)] lg:max-w-[var(--name-w)]';
const MRP_W = 'w-[5rem] min-w-[5rem] lg:w-[var(--mrp-w)] lg:min-w-[var(--mrp-w)]';
/** Sticky offset for MRP = the name column plus one border-spacing step. */
const MRP_LEFT = 'left-[12.25rem] lg:left-[calc(var(--name-w)+2px)]';

/**
 * Every type size is a multiple of `--grid-font`, the px value `useGridFit` measures for the
 * box the card was given. The explicit `leading` is load-bearing, not tidiness: `Table` carries
 * `text-sm`, whose 20px line-height would otherwise pin every line box regardless of font size,
 * so rows would not shrink with the type and the fit would be computed against a height the
 * grid does not occupy. gridFit.ts hardcodes this 1.15 — change both together.
 *
 * The ratios are the dispatch dashboard's: 1x cells, 0.9x heads, 1.1x the summary row, 2x for
 * the header height. SUB_TEXT is the one addition — it labels the non-price states ("out of
 * stock", "blocked"), which that board has no equivalent of.
 *
 * SUMMARY_TEXT is the summary figures now sharing the single header row with the column
 * labels — 1.1x, inside a 2x band. gridFit.ts assumes that fits; see HEAD_LINE there.
 */
const CELL_TEXT = 'text-[length:var(--grid-font)] leading-[1.15]';
const SUB_TEXT = 'text-[length:calc(var(--grid-font)*0.62)] leading-[1.1]';
/**
 * MRP is set slightly LARGER than the prices it anchors — see the column's note below.
 *
 * The paired `leading` is not cosmetic. `leading-[1.15]` on the cell is a UNITLESS multiplier,
 * so a child at 1.05x font size would resolve its own line box to 1.15 x 1.05 and make every
 * row ~5% taller than gridFit.ts solved for — enough to push the last product off a 1080
 * screen. 1.05 x 1.1 lands back on 1.155, so the row band is unchanged.
 */
const MRP_TEXT = 'text-[length:calc(var(--grid-font)*1.05)] leading-[1.1]';
/**
 * The product name, set a touch smaller than the prices so the longest names fit their column
 * whole rather than truncating.
 *
 * 0.92 x 1.25 = 1.15, which is CELL_TEXT's line box exactly — so this buys the extra characters
 * without changing the row height gridFit.ts solved for. Change the two together or the fit
 * silently drifts.
 */
const NAME_TEXT = 'text-[length:calc(var(--grid-font)*0.92)] leading-[1.25] tracking-[-0.01em]';
const HEAD_TEXT = 'text-[length:calc(var(--grid-font)*0.9)]';
const SUMMARY_TEXT = 'text-[length:calc(var(--grid-font)*1.1)] leading-[1.15]';
const HEAD_H = 'h-[calc(var(--grid-font)*2)]';

interface Props {
  rows: Row[];
}

/**
 * How a cell is drawn.
 *
 * With colour gone, the distinctions all live in the TEXT, and they still matter: a price you
 * can buy, a price you cannot, a listing we hold no link for, and a page we could not read are
 * four different things. `sub` carries the ones a number cannot say on its own.
 */
function cellChrome(cell: Cell) {
  const base = { style: PLATE, className: '', sub: null as string | null };

  switch (cell.status) {
    case 'not_listed':
      // Spelled out rather than left as a dot. "No link available" is a job for whoever
      // maintains the spreadsheet, and a bare dot never once read as one. It sits in the SUB
      // slot so it stays subordinate to the prices around it — a note, not a value.
      return { ...base, className: 'text-muted-foreground', text: '', sub: 'No Link Available' };

    case 'pending':
      // A product added to the sheet minutes ago, whose first scrape has not run yet. Says so,
      // rather than borrowing "No Link Available" (there IS a link) or the em dash this board
      // uses for a listing that has no price.
      return { ...base, className: 'text-muted-foreground', text: '', sub: 'Awaiting first check' };

    case 'blocked':
      // Hatched, so "we could not look" stays distinguishable from "there is nothing here to
      // look at". Both are absences; only one is a problem.
      return {
        ...base,
        style: {
          ...PLATE,
          backgroundImage:
            'repeating-linear-gradient(45deg, transparent, transparent 3px, var(--border) 3px, var(--border) 4px)',
        } as CSSProperties,
        className: 'text-muted-foreground',
        text: '—',
        sub: 'blocked',
      };

    case 'error':
      return { ...base, className: 'text-muted-foreground', text: '!', sub: 'error' };

    case 'out_of_stock':
      // Drawn exactly like a live price, by request. The price is still true — it is what the
      // item costs when stock returns — and the grid is now read as a price table rather than
      // an availability board. Where there is no price at all (an Amazon listing with no
      // buybox, a Flipkart "Notify Me" page) it says so in the SUB slot, like "No Link
      // Available", rather than an em dash that read as missing data.
      return cell.price != null
        ? { ...base, text: formatPrice(cell.price) }
        : { ...base, className: 'text-muted-foreground', text: '', sub: 'Out of Stock' };

    default:
      return cell.price != null
        ? { ...base, text: formatPrice(cell.price) }
        : { ...base, className: 'text-muted-foreground', text: '·' };
  }
}

function tooltip(cell: Cell, row: Row): string {
  const label = MARKETPLACE_LABELS[cell.marketplace];
  const head = `${row.name} → ${label}`;
  switch (cell.status) {
    case 'not_listed':
      return `${head}: not listed — no link in the spreadsheet`;
    case 'pending':
      return `${head}: in the spreadsheet, not yet checked — the next run will price it`;
    case 'blocked':
      return `${head}: could not be checked${cell.note ? ` — ${cell.note}` : ''}`;
    case 'error':
      return `${head}: failed to read the price${cell.note ? ` — ${cell.note}` : ''}. The listing page has probably changed.`;
    default: {
      const parts = [`${head}: ${cell.price != null ? formatPrice(cell.price) : 'no price'} live`];
      const mrp = cell.mrp ?? row.mrp;
      if (mrp != null) parts.push(`MRP ${formatPrice(mrp)}`);
      if (cell.status === 'out_of_stock') parts.push('OUT OF STOCK');
      // The note is where a Blinkit price from another city announces itself.
      if (cell.note) parts.push(cell.note);
      if (cell.unit) parts.push(cell.unit);
      return parts.join(' · ');
    }
  }
}

export function Heatmap({ rows }: Props) {
  // The type is sized to the box, not fixed: with every product on screen and nobody at the TV
  // to scroll, the grid has to be as large as it can be while still fitting.
  const [fitRef, fontPx] = useGridFit(rows.length);
  // ...and the name column to the longest name in it, so the column is exactly as wide as it
  // has to be and every pixel it does not need goes to the prices.
  const nameW = useNameWidth(
    fitRef,
    rows.map((r) => r.name),
    fontPx,
  );

  return (
    // The height has to land on the table's own container — that div carries `overflow-x-auto`,
    // making it the scrollport, and sticky rows/columns only stick inside a bounded scrollport.
    <div
      ref={fitRef}
      className="h-full min-h-0 [&>[data-slot=table-container]]:h-full"
      style={
        {
          '--grid-font': `${fontPx}px`,
          '--name-w': `${nameW}px`,
          '--mrp-w': `min(${fontPx * 5.4}px, 6vw)`,
        } as CSSProperties
      }
    >
      {/* `table-fixed` is what makes every marketplace column the SAME width. Under auto layout
          they size to their header text, so FLIPKART came out wider than MYNTRA and the cells
          stopped being comparable at a glance.

          `min-w` is what makes this usable on a phone: under `table-fixed` + `w-full` the data
          columns divide whatever is left after the pinned ones, which on a narrow screen is
          nothing — they collapsed to zero and the grid showed only product names. A floor makes
          the container scroll horizontally instead, with Product and MRP pinned. */}
      <Table className="h-full table-fixed border-separate border-spacing-0.5 min-w-[47rem]">
        {/* ONE header row carrying both the column name and that column's summary.

            They were two rows — labels, then per-marketplace totals welded underneath by a
            sticky offset. Merging them puts each number beside the thing it counts, and buys
            back a full product row of height, which at 21px type the grid badly needs.

            The underline is load-bearing: without it this row reads as just another product
            and the summary looks missing. */}
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead
              className={cn(
                'eyebrow sticky top-0 left-0 z-30 border-b-2 border-primary/40 bg-card text-left text-foreground',
                HEAD_TEXT,
                HEAD_H,
                NAME_W,
              )}
            >
              All products
            </TableHead>
            {/* Brighter than the other heads on purpose — MRP is the number every price in the
                row is read against, and as muted grey it disappeared into the name column. */}
            <TableHead
              className={cn(
                'sticky top-0 z-30 border-b-2 border-primary/40 bg-card text-right',
                HEAD_H,
                MRP_LEFT,
                MRP_W,
              )}
              title={`${rows.length} products`}
            >
              <span className="flex items-baseline justify-end gap-1.5">
                <span className={cn('eyebrow', HEAD_TEXT)}>MRP</span>
                <span
                  className={cn(
                    'font-mono font-bold tabular-nums text-foreground',
                    SUMMARY_TEXT,
                  )}
                >
                  {rows.length}
                </span>
              </span>
            </TableHead>
            {MARKETPLACES.map((m) => {
              const live = rows.filter((r) => r.cells[m].status === 'ok').length;
              return (
                <TableHead
                  key={m}
                  className={cn(
                    'sticky top-0 z-20 border-b-2 border-primary/40 bg-card text-center whitespace-nowrap',
                    HEAD_H,
                  )}
                  title={`${MARKETPLACE_LABELS[m]}: ${live} live listings`}
                >
                  <span className="flex items-baseline justify-center gap-2">
                    <span className={cn('eyebrow', HEAD_TEXT)}>{MARKETPLACE_LABELS[m]}</span>
                    <span
                      className={cn(
                        'font-mono font-bold tabular-nums',
                        SUMMARY_TEXT,
                        live > 0 ? 'text-foreground' : 'text-muted-foreground/60',
                      )}
                    >
                      {live > 0 ? `${live} live` : '·'}
                    </span>
                  </span>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>

        <TableBody>
          {rows.map((row) => {
            return (
              <TableRow key={row.sku} className="hover:bg-transparent">
                <TableCell
                  className={cn(
                    'sticky left-0 z-10 truncate bg-card py-1 font-semibold text-foreground',
                    NAME_TEXT,
                    NAME_W,
                  )}
                  title={`${row.name} · ${row.sku}`}
                >
                  {/* `row.starred` is still parsed, stored and carried through to here — it is
                      just no longer drawn. 27 of 32 rows carried the star, so as a marker it
                      distinguished almost nothing while costing every name two characters of a
                      column that truncates. */}
                  {row.name}
                </TableCell>

                {/* MRP carries its own tinted plate and full-strength bold type. Every colour in
                    the row is a discount off THIS number, so it cannot be the quietest thing on
                    the line — as muted grey it read as a row label rather than a price. */}
                <TableCell
                  className={cn(
                    'sticky z-10 bg-card py-1 text-right font-mono font-bold tabular-nums text-foreground',
                    CELL_TEXT,
                    MRP_LEFT,
                    MRP_W,
                  )}
                  title={row.mrp != null ? `MRP ${formatPrice(row.mrp)}` : 'no MRP recorded'}
                >
                  {row.mrp != null ? (
                    <span
                      className={cn(
                        'rounded-[3px] bg-foreground/15 px-1.5 py-0.5 ring-1 ring-foreground/20',
                        MRP_TEXT,
                      )}
                    >
                      <span className={cn('mr-0.5 font-normal text-muted-foreground', SUB_TEXT)}>
                        ₹
                      </span>
                      {formatAmount(row.mrp)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/60">·</span>
                  )}
                </TableCell>

                {MARKETPLACES.map((m) => {
                  const cell = row.cells[m];
                  const chrome = cellChrome(cell);
                  // Annotation sits INLINE with the price, not stacked. See gridFit.ts — a second
                  // line per row costs ~8 products off the bottom of a 1080 screen.
                  //
                  // The ▲/▼ against the previous run used to sit here too. `cell.previous` is
                  // still fetched and carried, so restoring the marker is a local change.
                  const body = (
                    <>
                      {chrome.text}
                      {chrome.sub && (
                        <span className={cn('ml-1 font-normal opacity-70', SUB_TEXT)}>
                          {chrome.sub}
                        </span>
                      )}
                    </>
                  );
                  return (
                    <TableCell
                      key={m}
                      className={cn(
                        'rounded-[3px] px-2 py-1 text-center font-mono font-bold tabular-nums transition-colors',
                        CELL_TEXT,
                        chrome.className,
                      )}
                      style={chrome.style}
                      title={tooltip(cell, row)}
                    >
                      {/* A blocked cell keeps its link so someone can check it by hand — that is
                          the whole reason the URL is carried through to the browser. */}
                      {cell.status === 'blocked' && cell.url ? (
                        <a href={cell.url} target="_blank" rel="noreferrer" className="hover:underline">
                          {body}
                        </a>
                      ) : (
                        body
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
