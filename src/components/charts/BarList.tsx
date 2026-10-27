import { cn } from '@/lib/utils';

export interface BarItem {
  key: string;
  label: React.ReactNode;
  /** Bar length, relative to the largest in the list. */
  value: number;
  /** What to print on the right; defaults to the value. */
  display?: React.ReactNode;
  color?: string;
  onClick?: () => void;
}

/** A ranked list where each row's bar sits behind its label — leaderboards and top movers. */
export function BarList({ items, className }: { items: BarItem[]; className?: string }) {
  const max = Math.max(1e-9, ...items.map((i) => Math.abs(i.value)));
  return (
    <ul className={cn('flex flex-col gap-1', className)}>
      {items.map((i) => (
        <li key={i.key}>
          <button
            type="button"
            onClick={i.onClick}
            disabled={!i.onClick}
            className="group relative flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1 text-left text-xs enabled:hover:bg-muted/60"
          >
            <span
              className="absolute inset-y-0 left-0 rounded-md opacity-20 transition-[width] duration-700 ease-out"
              style={{
                width: `${(Math.abs(i.value) / max) * 100}%`,
                background: i.color ?? 'var(--primary)',
              }}
            />
            <span className="relative min-w-0 flex-1 truncate text-foreground">{i.label}</span>
            <span className="relative shrink-0 font-semibold text-foreground tabular-nums">
              {i.display ?? i.value}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
