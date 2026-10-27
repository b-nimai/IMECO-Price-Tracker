import { useState } from 'react';

/** Previous / next through the list a modal was opened from. */
export interface ModalNav {
  index: number;
  total: number;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  /** "product", "keyword" — for the button labels. */
  noun: string;
}

/** Build a ModalNav for `item` inside `list`. */
export function listNav<T>(
  list: T[],
  item: T | null,
  pick: (next: T) => void,
  noun: string,
): ModalNav | undefined {
  if (item == null) return undefined;
  const at = list.indexOf(item);
  return {
    index: at,
    total: list.length,
    onPrev: at > 0 ? () => pick(list[at - 1]) : null,
    onNext: at >= 0 && at < list.length - 1 ? () => pick(list[at + 1]) : null,
    noun,
  };
}

/**
 * The last non-null value. A modal keeps rendering its item while it slides out — without this
 * the panel would empty the instant the selection is cleared, and animate out blank.
 */
export function useSticky<T>(value: T | null): T | null {
  const [last, setLast] = useState(value);
  if (value != null && value !== last) setLast(value);
  return value ?? last;
}
