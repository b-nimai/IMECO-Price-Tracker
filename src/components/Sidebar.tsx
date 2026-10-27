import {
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';

import { LiveClock } from '@/components/LiveClock';
import { LogoMark } from '@/components/LogoMark';
import { Dialog, DialogBody, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { formatAgo, freshness } from '@/data/format';
import type { Theme } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';

export interface NavItem<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
  /** A small count beside the label, e.g. listings out of stock. Hidden when absent or 0. */
  badge?: number;
  /** Amber rather than neutral: a count that is a problem to look at. */
  alert?: boolean;
}

interface Props<T extends string> {
  items: NavItem<T>[];
  current: T;
  onSelect: (id: T) => void;
  collapsed: boolean;
  onCollapsedChange: (next: boolean) => void;
  theme: Theme;
  onThemeToggle: () => void;
  checkedAt: number | null;
  syncing: boolean;
  error: string | null;
  onRefresh: () => void;
}

function Badge({ n, alert }: { n?: number; alert?: boolean }) {
  if (!n) return null;
  return (
    <span
      className={cn(
        'ml-auto rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums',
        alert ? 'bg-amber-500/15 text-warn' : 'bg-muted text-muted-foreground',
      )}
    >
      {n}
    </span>
  );
}

function NavList<T extends string>({
  items,
  current,
  onSelect,
  collapsed,
}: Pick<Props<T>, 'items' | 'current' | 'onSelect' | 'collapsed'>) {
  return (
    <nav className="flex flex-col gap-0.5" aria-label="Pages">
      {items.map(({ id, label, icon: Icon, badge, alert }) => {
        const active = id === current;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            aria-current={active ? 'page' : undefined}
            title={collapsed ? label : undefined}
            className={cn(
              'group relative flex h-9 items-center gap-3 rounded-lg px-2.5 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
              active
                ? 'bg-primary/12 font-semibold text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              collapsed && 'justify-center px-0',
            )}
          >
            {active && (
              <span className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full bg-primary" />
            )}
            <Icon className={cn('size-4 shrink-0', active && 'text-primary')} aria-hidden />
            {!collapsed && <span className="truncate">{label}</span>}
            {!collapsed && <Badge n={badge} alert={alert} />}
            {collapsed && badge ? (
              <span
                className={cn(
                  'absolute top-1 right-1.5 size-1.5 rounded-full',
                  alert ? 'bg-amber-400' : 'bg-muted-foreground/60',
                )}
              />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

/** How fresh the prices are, from when they were SCRAPED — a stale board must never look live. */
function Freshness({
  checkedAt,
  syncing,
  error,
  compact,
}: {
  checkedAt: number | null;
  syncing: boolean;
  error: string | null;
  compact: boolean;
}) {
  const age = freshness(checkedAt);
  const tone = error || age === 'very-stale' ? 'bg-bad' : age === 'stale' ? 'bg-warn' : 'bg-good';
  const text = error
    ? 'Offline — cached'
    : syncing
      ? 'Syncing…'
      : checkedAt
        ? `Priced ${formatAgo(checkedAt)}${age === 'fresh' ? '' : ' — run app'}`
        : 'No prices yet';
  return (
    <span
      className={cn(
        'flex items-center gap-2 text-xs',
        age === 'fresh' && !error ? 'text-muted-foreground' : 'text-warn',
      )}
      title={error ?? 'Prices refresh hourly from the desktop app'}
    >
      <span className={cn('size-2 shrink-0 rounded-full', tone, age === 'fresh' && 'pulse-dot')} />
      {!compact && <span className="truncate">{text}</span>}
    </span>
  );
}

function IconButton({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/**
 * The left rail: brand, pages, and the live status at the foot. Collapses to icons to give the
 * charts more width; below `md` it becomes a top bar whose menu opens the same list.
 */
export function Sidebar<T extends string>(props: Props<T>) {
  const { collapsed, onCollapsedChange, theme, onThemeToggle, syncing, onRefresh } = props;
  const [drawer, setDrawer] = useState(false);

  const tools = (compact: boolean) => (
    <div className={cn('flex items-center gap-1', compact && 'flex-col')}>
      <IconButton label="Refresh from the database" onClick={onRefresh} disabled={syncing}>
        <RefreshCw className={cn('size-4', syncing && 'animate-spin')} />
      </IconButton>
      <IconButton label={theme === 'dark' ? 'Light theme' : 'Dark theme'} onClick={onThemeToggle}>
        {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </IconButton>
    </div>
  );

  return (
    <>
      {/* Phone / narrow tablet: a top bar, the list in a drawer. */}
      <div className="sticky top-0 z-40 flex items-center gap-3 border-b border-border bg-sidebar px-3 py-2 md:hidden">
        <IconButton label="Open menu" onClick={() => setDrawer(true)}>
          <Menu className="size-5" />
        </IconButton>
        <span className="rounded-md bg-black px-1">
          <LogoMark syncing={syncing} />
        </span>
        <span className="ml-auto">
          <Freshness {...props} compact={false} />
        </span>
      </div>
      <Dialog open={drawer} onOpenChange={setDrawer}>
        <DialogContent side="left" className="max-w-72">
          <DialogTitle className="px-4 pt-4 text-sm tracking-widest text-muted-foreground uppercase">
            Price Tracker
          </DialogTitle>
          <DialogBody className="flex flex-col gap-4">
            <NavList
              {...props}
              collapsed={false}
              onSelect={(id) => {
                props.onSelect(id);
                setDrawer(false);
              }}
            />
            {tools(false)}
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* Laptop and up: the rail. */}
      <aside
        className={cn(
          'sticky top-0 hidden h-svh flex-none flex-col gap-4 border-r border-border bg-sidebar py-3 transition-[width] duration-200 md:flex',
          collapsed ? 'w-16 px-2' : 'w-60 px-3',
        )}
      >
        {/* The logo video is white on black and blends with `screen`, so it always sits on its
            own black tile — that keeps it legible on the light theme too. */}
        {collapsed ? (
          <button
            type="button"
            onClick={onRefresh}
            title="Refresh"
            className="mx-auto flex size-10 items-center justify-center rounded-lg bg-black text-lg font-black text-white"
          >
            i
          </button>
        ) : (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={onRefresh}
              title="Refresh from the database"
              className="w-fit rounded-lg bg-black px-1.5"
            >
              <LogoMark syncing={syncing} />
            </button>
            <div className="flex items-center gap-2 px-1">
              <span className="text-xs font-black tracking-[0.2em] text-foreground uppercase">
                Price Tracker
              </span>
            </div>
          </div>
        )}

        <NavList {...props} />

        <div className="mt-auto flex flex-col gap-3 border-t border-border pt-3">
          {!collapsed && (
            <div className="flex flex-col gap-1.5 px-1">
              <LiveClock />
              <Freshness {...props} compact={false} />
            </div>
          )}
          {collapsed && (
            <div className="flex justify-center">
              <Freshness {...props} compact />
            </div>
          )}
          <div
            className={cn('flex items-center', collapsed ? 'flex-col gap-1' : 'justify-between')}
          >
            {tools(collapsed)}
            <IconButton
              label={collapsed ? 'Expand menu' : 'Collapse menu'}
              onClick={() => onCollapsedChange(!collapsed)}
            >
              {collapsed ? (
                <PanelLeftOpen className="size-4" />
              ) : (
                <PanelLeftClose className="size-4" />
              )}
            </IconButton>
          </div>
        </div>
      </aside>
    </>
  );
}
