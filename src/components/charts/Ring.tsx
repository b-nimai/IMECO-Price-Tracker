import { cn } from '@/lib/utils';

interface Props {
  /** 0–1. */
  value: number | null;
  color?: string;
  size?: number;
  /** Big text in the middle; defaults to the percentage. */
  center?: string;
  label?: React.ReactNode;
  sublabel?: React.ReactNode;
  className?: string;
}

/** One share as a ring with its number in the middle — in stock, cheapest, top 10. */
export function Ring({
  value,
  color = 'var(--primary)',
  size = 72,
  center,
  label,
  sublabel,
  className,
}: Props) {
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = value == null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <svg width={size} height={size} className="shrink-0 -rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * v} ${c}`}
          className="transition-[stroke-dasharray] duration-700 ease-out"
        />
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          className="rotate-90 fill-foreground font-mono text-sm font-bold"
          style={{ transformOrigin: 'center' }}
        >
          {center ?? (value == null ? '—' : `${Math.round(v * 100)}%`)}
        </text>
      </svg>
      {(label || sublabel) && (
        <div className="flex min-w-0 flex-col gap-0.5">
          {label && <span className="text-sm font-medium text-foreground">{label}</span>}
          {sublabel && <span className="text-xs text-muted-foreground">{sublabel}</span>}
        </div>
      )}
    </div>
  );
}
