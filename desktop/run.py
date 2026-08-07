"""Orchestrates a full scrape.

    python -m desktop.run                 # scrape and store
    python -m desktop.run --dry-run       # scrape, print, store nothing
    python -m desktop.run --source scheduled

Hosts run in parallel; listings within a host run sequentially behind the throttle in
`fetch.py`. That shape is the point — it keeps per-host request rates polite while still
finishing all ~110 listings in a few minutes rather than a quarter of an hour.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from .adapters import PARSERS
from .budget import Budget
from .catalogue import load_products
from .config import load_settings
from .fetch import Fetcher
from .models import MARKETPLACES, Cell, Product, Status, Via

ProgressFn = Callable[[str, int, int], None]
"""(marketplace, done, total) — called after each listing so the GUI can draw a bar."""


def _scrape_marketplace(
    marketplace: str,
    products: list[Product],
    fetcher: Fetcher,
    on_progress: ProgressFn | None,
) -> list[tuple[str, Cell]]:
    listed = [p for p in products if p.url_for(marketplace)]
    total = len(listed)
    out: list[tuple[str, Cell]] = []

    for i, product in enumerate(listed, start=1):
        url = product.url_for(marketplace) or ""
        result = fetcher.fetch_html(marketplace, url)

        if result.ok and result.html is not None:
            try:
                cell = PARSERS[marketplace](result.html, url)
            except Exception as exc:
                # An adapter must never take the run down. A page it cannot read is a signal
                # worth seeing, not a crash.
                cell = Cell(
                    marketplace=marketplace,
                    status=Status.ERROR,
                    url=url,
                    note=f"parser raised {type(exc).__name__}: {exc}",
                )
            cell.via = result.via
        else:
            cell = Cell(
                marketplace=marketplace,
                status=result.status or Status.ERROR,
                url=url,
                via=result.via,
                note=result.note,
            )

        out.append((product.sku, cell))
        if on_progress:
            on_progress(marketplace, i, total)

    return out


def scrape(
    products: list[Product],
    fetcher: Fetcher,
    on_progress: ProgressFn | None = None,
) -> list[tuple[str, Cell]]:
    """Fetch every listed product on every marketplace."""
    results: list[tuple[str, Cell]] = []

    # One worker per marketplace. Any more would not help — the throttle serialises each host
    # anyway — and any fewer would leave hosts idle.
    with ThreadPoolExecutor(max_workers=len(MARKETPLACES)) as pool:
        futures = [
            pool.submit(_scrape_marketplace, m, products, fetcher, on_progress)
            for m in MARKETPLACES
        ]
        for future in futures:
            results.extend(future.result())

    # Products with no URL on a marketplace were never fetched, but the dashboard still needs
    # a cell for them — otherwise "we never looked" is indistinguishable from "the fetch
    # failed", which is exactly the confusion the status vocabulary exists to prevent.
    for product in products:
        for marketplace in MARKETPLACES:
            if not product.url_for(marketplace):
                results.append(
                    (
                        product.sku,
                        Cell(
                            marketplace=marketplace,
                            status=Status.NOT_LISTED,
                            via=Via.NONE,
                            note="no link in the spreadsheet",
                        ),
                    )
                )

    return results


def summarise(results: list[tuple[str, Cell]]) -> dict[str, dict[str, int]]:
    """Per-marketplace status counts, for the console and the GUI."""
    table: dict[str, dict[str, int]] = {}
    for _, cell in results:
        row = table.setdefault(cell.marketplace, {})
        row[cell.status.value] = row.get(cell.status.value, 0) + 1
    return table


def write_fixture(path: Path, products: list[Product], results: list[tuple[str, Cell]]) -> None:
    """Dump a run in the same shape the dashboard reads from Supabase.

    This is what lets the dashboard be developed, demoed and screenshotted without a database
    behind it — the rows are byte-identical in structure to `products` + `latest_prices`, so
    nothing about the rendering path is faked or special-cased.
    """
    checked_at = datetime.now(timezone.utc).isoformat()
    payload = {
        "generatedAt": checked_at,
        "products": [
            {
                "sku": p.sku,
                "name": p.name,
                "mrp": p.mrp,
                "starred": p.starred,
                "target_sp": p.target_sp,
                "urls": p.urls,
            }
            for p in products
        ],
        "snapshots": [
            {
                "sku": sku,
                "marketplace": cell.marketplace,
                "price": cell.price,
                "mrp": cell.mrp,
                "unit": cell.unit,
                "status": cell.status.value,
                "via": cell.via.value,
                "note": cell.note,
                "checked_at": checked_at,
            }
            for sku, cell in results
        ],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=1), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="desktop.run", description="Scrape marketplace prices")
    parser.add_argument("--dry-run", action="store_true", help="do not write to Supabase")
    parser.add_argument("--source", default="manual", choices=("manual", "scheduled"))
    parser.add_argument(
        "--fixture",
        metavar="PATH",
        help="also write the results as a demo JSON file the dashboard can render "
        "without a database (used for public/demo-prices.json)",
    )
    args = parser.parse_args(argv)

    # Guarded because the scheduled task runs this under pythonw.exe, which has NO stdout —
    # `sys.stdout` is None there, and calling .reconfigure() on it raised AttributeError before
    # a single listing was fetched. The task recorded `Last Result: 1` and nothing else said a
    # word, so the hourly refresh looked registered and did nothing. print() itself is safe:
    # CPython silently discards output when sys.stdout is None.
    if sys.stdout is not None:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    settings = load_settings()
    products = load_products()
    budget = Budget()
    started = time.monotonic()

    print(f"{len(products)} products, {sum(len(p.urls) for p in products)} listings")
    if not settings.can_store and not args.dry_run:
        print("  ! Supabase not configured — running dry")
        args.dry_run = True
    print()

    with Fetcher(settings, budget) as fetcher:
        results = scrape(products, fetcher)
        credits = fetcher.credits_used
    budget.save()

    elapsed = time.monotonic() - started
    for marketplace in MARKETPLACES:
        counts = summarise(results).get(marketplace, {})
        detail = "  ".join(f"{k}={v}" for k, v in sorted(counts.items()))
        print(f"  {marketplace:<9} {detail}")
    print(f"\n{elapsed / 60:.1f} min   credits {credits}   monthly {budget.used}/{budget.ceiling}")

    if args.fixture:
        write_fixture(Path(args.fixture), products, results)
        print(f"\nfixture written to {args.fixture}")

    if args.dry_run:
        print("dry run — nothing written to Supabase")
        return 0

    from .store import Store

    with Store(settings) as store:
        store.sync_products(products)
        run_id = store.start_run(args.source)
        written = store.save_snapshots(run_id, results)
        store.finish_run(run_id, [c for _, c in results], credits)
    print(f"\nstored {written} snapshots (run {run_id})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
