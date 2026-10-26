import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Case-insensitive name filter, for the filter box on the per-product tables. */
export function byName<T extends { name: string }>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  return q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows
}
