import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

import { DeltaPill } from './DeltaPill';
import { Sparkline, type SparkSeries } from './Sparkline';
import { useCountUp } from './useCountUp';

interface Props {
  label: string;
  icon?: LucideIcon;
  value: number | null;
  format: (v: number) => string;
  /** Smaller text after the number, e.g. "/ 96". */
  suffix?: React.ReactNode;
  delta?: number | null;
  deltaFormat?: (abs: number) => string;
  deltaGood?: 'up' | 'down' | 'neutral';
  deltaLabel?: string;
  spark?: SparkSeries[];
  sparkSlots?: string[];
  sparkFormat?: (v: number) => string;
  footnote?: React.ReactNode;
  accent?: string;
  onClick?: () => void;
}

/** A headline number with its change and its recent shape. */
export function StatTile({
  label,
  icon: Icon,
  value,
  format,
  suffix,
  delta,
  deltaFormat,
  deltaGood,
  deltaLabel = 'vs yesterday',
  spark,
  sparkSlots,
  sparkFormat,
  footnote,
  accent = 'var(--primary)',
  onClick,
}: Props) {
  const shown = useCountUp(value);
  return (
    <div
      onClick={onClick}
      className={cn(
        'card-glass relative flex min-w-0 flex-col gap-2 overflow-hidden rounded-xl px-4 pt-3 pb-2 transition-colors',
        onClick && 'cursor-pointer hover:border-primary/50',
      )}
    >
      <span className="absolute inset-x-0 top-0 h-0.5" style={{ background: accent }} />
      <div className="flex items-center gap-2">
        {Icon && (
          <span
            className="flex size-6 items-center justify-center rounded-md"
            style={{ background: `color-mix(in srgb, ${accent} 16%, transparent)`, color: accent }}
          >
            <Icon className="size-3.5" aria-hidden />
          </span>
        )}
        <span className="eyebrow truncate">{label}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-2xl font-bold text-foreground tabular-nums">
          {shown == null ? '—' : format(shown)}
        </span>
        {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      </div>
      <div className="flex min-h-5 items-center gap-1.5 text-[11px] text-muted-foreground">
        {delta !== undefined && (
          <>
            <DeltaPill delta={delta} format={deltaFormat} good={deltaGood} />
            {delta != null && <span>{deltaLabel}</span>}
          </>
        )}
        {footnote && <span className="truncate">{footnote}</span>}
      </div>
      {spark && (
        <Sparkline series={spark} slots={sparkSlots} format={sparkFormat} height={30} area />
      )}
    </div>
  );
}
