"""Orchestrates a full scrape.

    python -m desktop.run                 # scrape and store
    python -m desktop.run --dry-run       # scrape, print, store nothing
    python -m desktop.run --source scheduled
    python -m desktop.run --all-stores    # also check every Blinkit dark store, whatever the hour
    python -m desktop.run --search        # also run the daily keyword search now

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

import httpx

from .adapters import PARSERS
from .catalogue import load_products
from .config import Settings, load_settings
from .fetch import BLINKIT_LOCATIONS, Fetcher
from .models import MARKETPLACES, Cell, LocationCheck, Product, Status, Via
from .search import SearchResult, load_keywords, search, search_due

ProgressFn = Callable[[str, int, int], None]
"""(marketplace, done, total) — called after each listing so the GUI can draw a bar."""

#: Every this many hours, a run asks EVERY Blinkit dark store about every listing instead of
#: stopping at the first with stock. That full walk is ~6x the Blinkit requests (~11 minutes
#: behind the throttle for 17 listings), which is fine a few times a day and wasteful hourly —
#: which store has stock does not change minute to minute.
ALL_STORES_EVERY_HOURS = 3


def all_stores_due(now: datetime | None = None) -> bool:
    """Whether this run should do the full dark-store walk. On the hour 0, 3, 6, ... 21 —
    clock-based rather than "since the last walk" so it needs no state, and an hourly schedule
    over a working day hits 9, 12, 15 and 18."""
    now = now or datetime.now()
    return now.hour % ALL_STORES_EVERY_HOURS == 0


def _fetch_one(
    marketplace: str, url: str, fetcher: Fetcher, context: dict[str, str] | None = None
) -> Cell:
    """One request, parsed into a Cell. Never raises."""
    result = fetcher.fetch_html(marketplace, url, context)

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
        return cell

    return Cell(
        marketplace=marketplace,
        status=result.status or Status.ERROR,
        url=url,
        via=result.via,
        note=result.note,
    )


def _fetch_blinkit(
    url: str,
    fetcher: Fetcher,
    sku: str = "",
    checks: list[LocationCheck] | None = None,
) -> Cell:
    """Ask Blinkit for one listing, trying each location until one has it in stock.

    Blinkit answers per DARK STORE, so "out of stock" from a single point means only that ONE
    store is empty — which is not the question the board is asking. Walking four Kolkata
    neighbourhoods and then Bengaluru and Mumbai answers it properly: is this listing live
    anywhere, and at what price. The Kolkata points matter as much as the other cities do; see
    BLINKIT_LOCATIONS for the measurements that put them there.

    Stops at the first location with stock, so anything the home store carries costs exactly one
    request. Only genuinely unavailable listings pay for the full walk. If none has stock, the
    FIRST location's answer is kept — the home store is the honest thing to report as
    unavailable, and it carries the real price the item returns at.

    With `checks`, it does NOT stop: every location is asked and each answer is appended there,
    for the Availability tab. The cell returned is chosen exactly as above, so the board reads
    the same whichever way the walk was done.
    """
    first: Cell | None = None
    found: Cell | None = None
    home = BLINKIT_LOCATIONS[0].city

    for location in BLINKIT_LOCATIONS:
        cell = _fetch_one("blinkit", url, fetcher, location.context)
        if checks is not None:
            checks.append(
                LocationCheck(
                    sku=sku,
                    city=location.city,
                    area=location.area,
                    lat=float(location.context["lat"]),
                    lon=float(location.context["lon"]),
                    # A copy: the board's cell gets a note added below, which is about the
                    # board's choice and does not belong on this store's own reading.
                    cell=Cell(**vars(cell)),
                )
            )
        if first is None:
            first = cell
        if found is None and cell.status is Status.OK:
            # Say where it came from whenever that is not the home market, so a Bengaluru price
            # on the wall is never read as one a Kolkata customer can pay.
            if location.city != home:
                cell.note = f"in stock in {location.city}; not in {home}"
            found = cell
            if checks is None:
                return cell

    if found is not None:
        return found

    assert first is not None  # BLINKIT_LOCATIONS is never empty
    # Only if the adapter had nothing more specific to say. "no store is carrying it" is a
    # better answer than "out of stock in three cities" and must not be overwritten by it.
    if first.status is Status.OUT_OF_STOCK and not first.note:
        # Deduplicated, order preserved: several of these points are different dark stores in
        # the SAME city, and "out of stock in Kolkata, Kolkata, Kolkata, Kolkata, Bengaluru,
        # Mumbai" reads as a bug in the app rather than a fact about the product.
        cities = list(dict.fromkeys(loc.city for loc in BLINKIT_LOCATIONS))
        first.note = "out of stock in " + ", ".join(cities)
    return first


def _scrape_marketplace(
    marketplace: str,
    products: list[Product],
    fetcher: Fetcher,
    on_progress: ProgressFn | None,
    checks: list[LocationCheck] | None = None,
) -> list[tuple[str, Cell]]:
    listed = [p for p in products if p.url_for(marketplace)]
    total = len(listed)
    out: list[tuple[str, Cell]] = []

    for i, product in enumerate(listed, start=1):
        url = product.url_for(marketplace) or ""
        if marketplace == "blinkit":
            cell = _fetch_blinkit(url, fetcher, product.sku, checks)
        else:
            cell = _fetch_one(marketplace, url, fetcher)

        out.append((product.sku, cell))
        if on_progress:
            on_progress(marketplace, i, total)

    return out


def scrape(
    products: list[Product],
    fetcher: Fetcher,
    on_progress: ProgressFn | None = None,
    checks: list[LocationCheck] | None = None,
) -> list[tuple[str, Cell]]:
    """Fetch every listed product on every marketplace.

    Pass a `checks` list to also ask every Blinkit dark store (see `_fetch_blinkit`); it is
    filled in place.
    """
    results: list[tuple[str, Cell]] = []

    # One worker per marketplace. Any more would not help — the throttle serialises each host
    # anyway — and any fewer would leave hosts idle.
    with ThreadPoolExecutor(max_workers=len(MARKETPLACES)) as pool:
        futures = [
            pool.submit(_scrape_marketplace, m, products, fetcher, on_progress, checks)
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
                # Carried so demo mode renders in the sheet's order too. The dashboard sorts on
                # it and hides products without one, so a fixture missing this key would render
                # alphabetically — a different board from the one it is supposed to stand in for.
                "position": p.position,
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
                "rating": cell.rating,
                "rating_count": cell.rating_count,
                "checked_at": checked_at,
            }
            for sku, cell in results
        ],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=1), encoding="utf-8")


def store_results(
    settings: Settings,
    products: list[Product],
    results: list[tuple[str, Cell]],
    checks: list[LocationCheck] | None,
    source: str,
    searches: list[SearchResult] | None = None,
) -> tuple[str, int, str | None]:
    """Write one finished scrape. Shared by the console and the GUI so the two cannot drift.

    Returns (run_id, snapshots written, warning). The dark-store and search rows are written
    BEFORE the run is closed, so the dashboard never sees a finished run without them — but a
    failure to write them is only a warning: they are their tabs' extra detail, and must never
    cost the board its prices.
    """
    from .store import Store

    warnings: list[str] = []
    with Store(settings) as store:
        stored = store.sync_products(products)
        if len(stored) < len(products):
            warnings.append("competitors not stored — run supabase/schema.sql to add them")
            results = [(sku, cell) for sku, cell in results if sku in stored]
            checks = [c for c in checks or [] if c.sku in stored]
        run_id = store.start_run(source)
        written = store.save_snapshots(run_id, results)
        if checks:
            try:
                store.save_availability(run_id, checks)
            except RuntimeError as exc:
                warnings.append(f"dark-store checks not stored — run supabase/schema.sql? ({exc})")
        if searches:
            try:
                store.save_search(run_id, searches, stored)
            except RuntimeError as exc:
                warnings.append(f"search ranks not stored — run supabase/schema.sql? ({exc})")
        store.finish_run(run_id, [c for _, c in results])
    return run_id, written, "; ".join(warnings) or None


def search_wanted(settings: Settings, force: bool = False) -> bool:
    """Whether this run should also do the daily keyword search (see desktop/search.py).

    Asks the database when the last one was, so it happens once a day whenever the PC is on
    after 9 — never on a dry run unless forced, and never against a database that has no
    `search_results` table yet (that would spend ~60 requests to store nothing).
    """
    if force:
        return True
    if not settings.can_store:
        return False
    from .store import Store

    try:
        with Store(settings) as store:
            return search_due(store.last_search_at())
    except (RuntimeError, httpx.HTTPError):
        return False


def run_search(products: list[Product], fetcher: Fetcher) -> tuple[list[SearchResult], list[str]]:
    """The daily keyword search, with the workbook's keywords (or the defaults)."""
    try:
        keywords = load_keywords()
    except ValueError as exc:
        return [], [str(exc)]
    return search(keywords, fetcher, products)


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
    parser.add_argument(
        "--all-stores",
        action="store_true",
        help=f"ask every Blinkit dark store this run (otherwise every {ALL_STORES_EVERY_HOURS}h)",
    )
    parser.add_argument(
        "--search",
        action="store_true",
        help="run the keyword search this run (otherwise once a day, first run after 9)",
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
    started = time.monotonic()

    print(f"{len(products)} products, {sum(len(p.urls) for p in products)} listings")
    if not settings.can_store and not args.dry_run:
        print("  ! Supabase not configured — running dry")
        args.dry_run = True
    print()

    checks: list[LocationCheck] | None = [] if args.all_stores or all_stores_due() else None
    if checks is not None:
        print(f"checking all {len(BLINKIT_LOCATIONS)} Blinkit dark stores this run")

    do_search = search_wanted(settings, args.search) and not (args.dry_run and not args.search)
    searches: list[SearchResult] | None = None

    with Fetcher(settings) as fetcher:
        results = scrape(products, fetcher, checks=checks)
        if do_search:
            print("running the daily keyword search")
            searches, problems = run_search(products, fetcher)
            for problem in problems:
                print(f"  ! search: {problem}")

    elapsed = time.monotonic() - started
    for marketplace in MARKETPLACES:
        counts = summarise(results).get(marketplace, {})
        detail = "  ".join(f"{k}={v}" for k, v in sorted(counts.items()))
        print(f"  {marketplace:<9} {detail}")
    print(f"\n{elapsed / 60:.1f} min")

    if args.fixture:
        write_fixture(Path(args.fixture), products, results)
        print(f"\nfixture written to {args.fixture}")

    if args.dry_run:
        print("dry run — nothing written to Supabase")
        return 0

    if searches is not None:
        ours = sum(r.brand == "IMECO" for r in searches)
        print(f"search: {len(searches)} results, {ours} of them IMECO's")

    run_id, written, warning = store_results(
        settings, products, results, checks, args.source, searches
    )
    print(f"\nstored {written} snapshots (run {run_id})")
    if checks and not warning:
        print(f"stored {len(checks)} dark-store checks")
    if searches and not warning:
        print(f"stored {len(searches)} search results")
    if warning:
        print(f"  ! {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
