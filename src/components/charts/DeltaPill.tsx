import { ArrowDown, ArrowUp, Minus } from 'lucide-react';

import { cn } from '@/lib/utils';

interface Props {
  delta: number | null;
  format?: (abs: number) => string;
  /** Which direction is good news. Prices: 'neutral' — a drop is neither win nor loss. */
  good?: 'up' | 'down' | 'neutral';
  className?: string;
}

/** ▲/▼ with the size of a change. The arrow and sign carry the meaning; colour only adds to it. */
export function DeltaPill({ delta, format = (v) => String(v), good = 'up', className }: Props) {
  if (delta == null) return null;
  const flat = Math.abs(delta) < 1e-9;
  const up = delta > 0;
  const tone = flat || good === 'neutral' ? 'neutral' : up === (good === 'up') ? 'good' : 'bad';
  const Icon = flat ? Minus : up ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums',
        tone === 'good' && 'bg-emerald-500/15 text-good',
        tone === 'bad' && 'bg-rose-500/15 text-bad',
        tone === 'neutral' && 'bg-muted text-muted-foreground',
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {flat ? 'no change' : format(Math.abs(delta))}
    </span>
  );
}
