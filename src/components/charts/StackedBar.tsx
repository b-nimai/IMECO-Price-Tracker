import { cn } from '@/lib/utils';

export interface Segment {
  label: string;
  value: number;
  color: string;
}

interface Props {
  segments: Segment[];
  /** Show "label n" under the bar. */
  legend?: boolean;
  height?: number;
  className?: string;
  onClick?: () => void;
}

/** Parts of a whole on one bar, with a 2px gap between parts and a hover readout per part. */
export function StackedBar({ segments, legend = true, height = 12, className, onClick }: Props) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  return (
    <div
      className={cn('flex flex-col gap-1.5', onClick && 'cursor-pointer', className)}
      onClick={onClick}
    >
      <div
        className="flex w-full gap-[2px] overflow-hidden rounded-full bg-muted"
        style={{ height }}
      >
        {total > 0 &&
          segments
            .filter((s) => s.value > 0)
            .map((s) => (
              <div
                key={s.label}
                className="h-full transition-[flex-grow] duration-700 ease-out first:rounded-l-full last:rounded-r-full hover:opacity-80"
                style={{ flexGrow: s.value, flexBasis: 0, background: s.color }}
                title={`${s.label}: ${s.value} (${Math.round((s.value / total) * 100)}%)`}
              />
            ))}
      </div>
      {legend && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          {segments.map((s) => (
            <span key={s.label} className="inline-flex items-center gap-1">
              <span className="size-2 rounded-[2px]" style={{ background: s.color }} />
              {s.label}
              <span className="font-semibold text-foreground tabular-nums">{s.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
