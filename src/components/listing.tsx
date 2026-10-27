// Small pieces shared by the per-product tables on the Trends, Availability and Reviews tabs,
// so the three read as one dashboard rather than three.

import { Search } from 'lucide-react';

import { MARKETPLACE_COLORS, MARKETPLACE_LABELS, type Marketplace } from '@/data/types';

/** Marketplace name with its series dot — the same colour it has in every chart. */
export function Where({
  marketplace,
  className,
}: {
  marketplace: Marketplace;
  className?: string;
}) {
  return (
    <span className={className ?? 'inline-flex items-center gap-1 text-xs text-muted-foreground'}>
      <span
        className="inline-block size-2 shrink-0 rounded-full"
        style={{ background: MARKETPLACE_COLORS[marketplace] }}
        aria-hidden
      />
      {MARKETPLACE_LABELS[marketplace]}
    </span>
  );
}

export function FilterBox({
  value,
  onChange,
  placeholder = 'Filter products',
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5">
      <Search className="size-4 text-muted-foreground" aria-hidden />
      <span className="sr-only">{placeholder}</span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground sm:w-56"
      />
    </label>
  );
}

/** For when a tab's view is not in the database yet. */
export function SchemaNote({ view }: { view: string }) {
  return (
    <p className="mt-1 text-xs text-warn">
      This needs the <code>{view}</code> view — run <code>supabase/schema.sql</code> in the Supabase
      SQL editor.
    </p>
  );
}
