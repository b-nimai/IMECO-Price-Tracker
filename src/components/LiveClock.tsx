import { useEffect, useState } from 'react';

const TIME = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const DATE = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

export function LiveClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-baseline gap-2 leading-none whitespace-nowrap">
      <span className="font-mono text-lg font-semibold tabular-nums text-foreground">
        {TIME.format(now)}
      </span>
      <span className="text-[10px] tracking-widest text-muted-foreground uppercase">
        {DATE.format(now)}
      </span>
    </div>
  );
}
