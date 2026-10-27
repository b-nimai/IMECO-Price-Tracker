import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ModalNav } from '@/hooks/useModal';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  nav?: ModalNav;
  /** Extra controls in the header, left of the arrows (e.g. a time range). */
  actions?: ReactNode;
  /** Sheet width; the sheet is full-width below it. */
  width?: 'md' | 'lg' | 'xl';
  /** Drop the body's padding — for content that draws its own edges. */
  flush?: boolean;
  children: ReactNode;
}

const WIDTH = { md: 'sm:max-w-2xl', lg: 'sm:max-w-5xl', xl: 'sm:max-w-7xl' };

/**
 * The one detail view every page uses: a sheet that slides in from the right over the page,
 * and slides back out on close (Esc, the ×, or a click outside). With `nav`, the arrows — or
 * ← → on the keyboard — step through the list without closing it.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  nav,
  actions,
  width = 'lg',
  flush,
  children,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className={WIDTH[width]}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') nav?.onPrev?.();
          if (e.key === 'ArrowRight') nav?.onNext?.();
        }}
      >
        <DialogHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <DialogTitle className="text-lg">{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {actions}
            {nav && nav.index >= 0 && (
              <div className="flex items-center gap-1">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={!nav.onPrev}
                  onClick={() => nav.onPrev?.()}
                  aria-label={`Previous ${nav.noun}`}
                >
                  <ChevronLeft />
                </Button>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {nav.index + 1} / {nav.total}
                </span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={!nav.onNext}
                  onClick={() => nav.onNext?.()}
                  aria-label={`Next ${nav.noun}`}
                >
                  <ChevronRight />
                </Button>
              </div>
            )}
          </div>
        </DialogHeader>
        <DialogBody className={cn(flush && 'p-0')}>{children}</DialogBody>
      </DialogContent>
    </Dialog>
  );
}
