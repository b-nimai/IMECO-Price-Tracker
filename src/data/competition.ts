// IMECO against its rivals: the arithmetic shared by the Competitors page and the Overview.

import { MARKETPLACES, sheetOrder, type Cell, type Marketplace, type Row } from './types';

export interface Group {
  ours: Row;
  rivals: Row[];
}

/** Where IMECO stands against its rivals on one marketplace, for one product. */
export interface Standing {
  /** IMECO's live price here, if any. */
  ours: number | null;
  /** The cheapest rival live here, if any. */
  best: { row: Row; price: number } | null;
  /** IMECO's place among the live prices (1 = cheapest), when IMECO and a rival are both live. */
  rank: number | null;
  /** How many live prices that rank is out of, IMECO included. */
  of: number;
  /** Rupees IMECO is dearer than the cheapest rival; negative when IMECO is cheaper. */
  gap: number | null;
}

/** A live price someone can buy at — the only kind worth comparing. */
export function live(cell: Cell): number | null {
  return cell.status === 'ok' && cell.price != null ? cell.price : null;
}

/** Each IMECO product that has competitors, with them, both in sheet order. */
export function buildGroups(rows: Row[], competitors: Row[]): Group[] {
  const bySku = new Map<string, Row[]>();
  for (const c of competitors) {
    if (!c.competitorOf) continue;
    bySku.set(c.competitorOf, [...(bySku.get(c.competitorOf) ?? []), c]);
  }
  return sheetOrder(rows)
    .filter((r) => bySku.has(r.sku))
    .map((r) => ({ ours: r, rivals: sheetOrder(bySku.get(r.sku)!) }));
}

export function standing({ ours, rivals }: Group, m: Marketplace): Standing {
  const mine = live(ours.cells[m]);
  let best: Standing['best'] = null;
  const theirs: number[] = [];
  for (const row of rivals) {
    const price = live(row.cells[m]);
    if (price == null) continue;
    theirs.push(price);
    if (!best || price < best.price) best = { row, price };
  }
  if (mine == null || !best) return { ours: mine, best, rank: null, of: theirs.length, gap: null };
  return {
    ours: mine,
    best,
    rank: 1 + theirs.filter((p) => p < mine).length,
    of: theirs.length + 1,
    gap: mine - best.price,
  };
}

export interface WinLoss {
  /** IMECO strictly cheapest. */
  cheapest: number;
  tied: number;
  /** A rival is cheaper. */
  undercut: number;
}

/** Across every product compared on one marketplace (or all of them): who is cheapest. */
export function winLoss(groups: Group[], markets: readonly Marketplace[] = MARKETPLACES): WinLoss {
  const out: WinLoss = { cheapest: 0, tied: 0, undercut: 0 };
  for (const g of groups) {
    for (const m of markets) {
      const s = standing(g, m);
      if (s.gap == null) continue;
      if (s.gap < 0) out.cheapest += 1;
      else if (s.gap === 0) out.tied += 1;
      else out.undercut += 1;
    }
  }
  return out;
}

const ORDINAL = new Intl.PluralRules('en-IN', { type: 'ordinal' });
const SUFFIX: Record<string, string> = { one: 'st', two: 'nd', few: 'rd', other: 'th' };
export function ordinal(n: number): string {
  return `${n}${SUFFIX[ORDINAL.select(n)]}`;
}
