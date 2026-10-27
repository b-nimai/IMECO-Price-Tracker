"""Orchestrates a full scrape.

    python -m desktop.run                 # scrape and store
    python -m desktop.run --dry-run       # scrape, print, store nothing
    python -m desktop.run --source scheduled
    python -m desktop.run --full          # every competitor and every Blinkit store this run
    python -m desktop.run --search        # search every keyword now

Each run prices every IMECO listing; competitors, the dark-store walk and the keyword search
are spread over runs (see ROTATION and KEYWORDS_PER_RUN).

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
from contextlib import ExitStack
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import httpx

from .adapters import PARSERS
from .catalogue import USER_WORKBOOK, load_products
from .config import Settings, load_settings
from .fetch import BLINKIT_LOCATIONS, Fetcher
from .models import MARKETPLACES, Cell, LocationCheck, Product, Status, Via
from .search import (
    DEFAULT_KEYWORDS,
    SEARCH_FROM_HOUR,
    SearchResult,
    load_keywords,
    search,
)

ProgressFn = Callable[[str, int, int], None]
"""(marketplace, done, total) — called after each listing so the GUI can draw a bar."""

#: What a run fetches, by how fresh it needs to be. IMECO's own listings — prices, stock and
#: the ratings read off the same pages — are the dashboard's core and are fetched EVERY run.
#: Competitor prices and the Blinkit every-store walk move slowly, so each run takes only one
#: of ROTATION slices of them: every competitor and every store is still read every ROTATION
#: hours, and an hourly run stays ~8-12 minutes instead of 14-26 with everything at once.
ROTATION = 3

#: The daily keyword search is spread over the morning the same way: at most this many keywords
#: a run, from SEARCH_FROM_HOUR, until every keyword has been searched today.
KEYWORDS_PER_RUN = 25


def rotation_slot(now: datetime | None = None) -> int:
    """Which slice this run takes: the hour of the day, round-robin."""
    return (now or datetime.now()).hour % ROTATION


def _in_slot(items: list[Product], slot: int) -> set[str]:
    """Deal `items` round-robin into ROTATION equal slices (in SKU order, so a product keeps
    its slice from run to run) and return the SKUs in `slot`."""
    ordered = sorted(p.sku for p in items)
    return {sku for i, sku in enumerate(ordered) if i % ROTATION == slot}


def plan_run(
    products: list[Product], now: datetime | None = None, full: bool = False
) -> tuple[list[Product], set[str]]:
    """(the products to price this run, the IMECO SKUs to ask every Blinkit store about).

    Every IMECO product, plus this hour's third of the competitors; with `full`, everything.
    """
    slot = rotation_slot(now)
    rivals = [p for p in products if p.competitor_of]
    own_blinkit = [p for p in products if not p.competitor_of and p.url_for("blinkit")]
    rival_due = {p.sku for p in rivals} if full else _in_slot(rivals, slot)
    walk = {p.sku for p in own_blinkit} if full else _in_slot(own_blinkit, slot)
    due = [p for p in products if not p.competitor_of or p.sku in rival_due]
    return due, walk


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
    walk: set[str] | None = None,
    walk_only: list[Product] = (),  # type: ignore[assignment]
) -> list[tuple[str, Cell]]:
    listed = [p for p in products if p.url_for(marketplace)]
    if marketplace == "blinkit":
        listed += [p for p in walk_only if p.url_for("blinkit")]
    total = len(listed)
    out: list[tuple[str, Cell]] = []

    for i, product in enumerate(listed, start=1):
        url = product.url_for(marketplace) or ""
        if marketplace == "blinkit":
            # Only IMECO's own listings get the every-store walk (with a few competitors per
            # product it would be ~500 requests), and only those in this run's `walk` slice.
            due = not product.competitor_of and (walk is None or product.sku in walk)
            own = checks if due else None
            cell = _fetch_blinkit(url, fetcher, product.sku, own)
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
    walk: set[str] | None = None,
    walk_only: list[Product] = (),  # type: ignore[assignment]
) -> list[tuple[str, Cell]]:
    """Fetch every listed product on every marketplace.

    `walk_only` products are asked of every Blinkit store for `checks` and nothing else; their
    cells are left out of the result (the run has already priced them).

    Pass a `checks` list to also ask every Blinkit dark store (see `_fetch_blinkit`) about the
    IMECO SKUs in `walk` (all of them when `walk` is None); it is filled in place.
    """
    results: list[tuple[str, Cell]] = []

    # One worker per marketplace. Any more would not help — the throttle serialises each host
    # anyway — and any fewer would leave hosts idle.
    with ThreadPoolExecutor(max_workers=len(MARKETPLACES)) as pool:
        futures = [
            pool.submit(
                _scrape_marketplace, m, products, fetcher, on_progress, checks, walk, walk_only
            )
            for m in MARKETPLACES
        ]
        skip = {p.sku for p in walk_only}
        for future in futures:
            results.extend((sku, cell) for sku, cell in future.result() if sku not in skip)

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


PhaseFn = Callable[[str, bool], None]
"""(what the run is doing now, whether the progress bars start over for it)."""


@dataclass
class RunReport:
    results: list[tuple[str, Cell]] = field(default_factory=list)
    checks: list[LocationCheck] = field(default_factory=list)
    searches: list[SearchResult] | None = None
    #: Keyword-search problems, also written to SEARCH_LOG.
    problems: list[str] = field(default_factory=list)
    #: Parts that could not be stored (a missing table) — the prices still were.
    warnings: list[str] = field(default_factory=list)
    run_id: str | None = None
    stored: int = 0


def execute_run(
    settings: Settings,
    products: list[Product],
    *,
    source: str = "manual",
    full: bool = False,
    force_search: bool = False,
    dry_run: bool = False,
    on_progress: ProgressFn | None = None,
    on_phase: PhaseFn | None = None,
    on_saved: Callable[[int, int], None] | None = None,
) -> RunReport:
    """One run, most important first, each stage SAVED as soon as it is fetched:

    1. every IMECO listing — prices, stock and ratings — so the dashboard updates within
       minutes;
    2. this hour's third of the competitors, and of the Blinkit every-store walk;
    3. the keywords still due today.

    The run row is opened before stage 1 and closed after stage 3; the dashboard reads the
    newest snapshot per listing, so each stage shows up the moment it is written. A stage that
    cannot be stored (a table the database does not have yet) is a warning, never a lost run.
    Shared by the window and the scheduled task, so the two cannot drift.
    """
    from .store import Store

    phase = on_phase or (lambda text, reset: None)
    report = RunReport()
    due, walk = plan_run(products, full=full)
    own = [p for p in due if not p.competitor_of]
    rivals = [p for p in due if p.competitor_of]
    walk_only = [p for p in own if p.sku in walk]
    keywords: list[tuple[str, tuple[str, ...]]] = []
    if not dry_run or force_search:
        keywords, report.problems = keywords_due(settings, products, force_search)
    stages = 1 + bool(rivals or walk_only) + bool(keywords)
    saved = 0

    def stage_saved() -> None:
        nonlocal saved
        saved += 1
        if on_saved:
            on_saved(saved, stages)

    with ExitStack() as stack:
        fetcher = stack.enter_context(Fetcher(settings))
        store = None if dry_run else stack.enter_context(Store(settings))
        stored: set[str] = set()
        if store:
            stored = store.sync_products(products)
            if len(stored) < len(products):
                report.warnings.append("competitors not stored — run supabase/schema.sql")
            report.run_id = store.start_run(source)

        def save(results: list[tuple[str, Cell]]) -> None:
            if store and report.run_id:
                keep = [(sku, cell) for sku, cell in results if sku in stored]
                report.stored += store.save_snapshots(report.run_id, keep)

        phase(f"IMECO prices and stock ({len(own)} products)", True)
        first = scrape(own, fetcher, on_progress)
        report.results += first
        phase("Saving IMECO prices", False)
        save(first)
        stage_saved()

        if rivals or walk_only:
            phase(f"{len(rivals)} competitors and {len(walk_only)} dark-store checks", True)
            second = scrape(
                rivals, fetcher, on_progress, report.checks, {p.sku for p in walk_only}, walk_only
            )
            report.results += second
            phase("Saving competitors", False)
            save(second)
            checks = [c for c in report.checks if c.sku in stored]
            if store and report.run_id and checks:
                try:
                    store.save_availability(report.run_id, checks)
                except RuntimeError as exc:
                    report.warnings.append(f"dark-store checks not stored ({exc})")
            stage_saved()

        if keywords:
            phase(f"Searching {len(keywords)} keywords", True)
            report.searches, issues = run_search(keywords, products, fetcher, on_progress)
            report.problems += issues
            write_search_log(report.searches, report.problems)
            phase("Saving search ranks", False)
            if store and report.run_id:
                try:
                    store.save_search(report.run_id, report.searches, stored)
                except RuntimeError as exc:
                    report.warnings.append(f"search ranks not stored ({exc})")
            stage_saved()

        if store and report.run_id:
            store.finish_run(report.run_id, [c for _, c in report.results])
    return report


def keywords_due(
    settings: Settings, products: list[Product], force: bool = False
) -> tuple[list[tuple[str, tuple[str, ...]]], list[str]]:
    """(keywords to search this run, with the marketplaces still missing for each; problems).

    From SEARCH_FROM_HOUR, each run searches up to KEYWORDS_PER_RUN keywords that have not
    been searched today — so the daily search is spread over the first few morning runs, and a
    PC that was off at 9 simply catches up later. Asks the database what today already has;
    if it cannot, it searches nothing (never the whole list behind every price run).
    `force` searches every keyword.
    """
    problems: list[str] = []
    try:
        keywords = load_keywords(products=products)
    except Exception as exc:
        problems.append(f"{exc} — searched the default keywords instead")
        keywords = [(k, MARKETPLACES) for k in DEFAULT_KEYWORDS]
    if force:
        return keywords, problems
    if datetime.now().hour < SEARCH_FROM_HOUR or not settings.can_store:
        return [], problems
    from .store import Store

    try:
        with Store(settings) as store:
            done = store.searched_today()
    except (RuntimeError, httpx.HTTPError):
        return [], problems
    due: list[tuple[str, tuple[str, ...]]] = []
    for keyword, where in keywords:
        missing = tuple(m for m in where if (keyword, m) not in done)
        if missing:
            due.append((keyword, missing))
        if len(due) >= KEYWORDS_PER_RUN:
            break
    return due, problems


#: Where the last keyword search's problems are written, beside the uploaded sheet. The
#: button and the scheduled task both run windowless, so without this a marketplace whose
#: every search failed leaves no trace of why.
SEARCH_LOG = USER_WORKBOOK.parent / "last-search.txt"


def write_search_log(results: list[SearchResult], problems: list[str]) -> Path | None:
    """Per-marketplace result counts and every problem, overwriting the previous search's."""
    lines = [f"Keyword search at {datetime.now():%d %b %Y %H:%M}"]
    for marketplace in MARKETPLACES:
        found = sum(r.marketplace == marketplace for r in results)
        lines.append(f"  {marketplace:<9} {found} results")
    lines += ["", f"{len(problems)} problems:" if problems else "No problems."]
    lines += [f"  {p}" for p in problems]
    try:
        SEARCH_LOG.parent.mkdir(parents=True, exist_ok=True)
        SEARCH_LOG.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        return None  # a log that cannot be written must not cost the run
    return SEARCH_LOG


def run_search(
    keywords: list[tuple[str, tuple[str, ...]]],
    products: list[Product],
    fetcher: Fetcher,
    on_progress: ProgressFn | None = None,
) -> tuple[list[SearchResult], list[str]]:
    """Search `keywords` (from `keywords_due`) on their marketplaces."""
    return search(keywords, fetcher, products, on_progress)


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
        "--full",
        action="store_true",
        help=f"price every competitor and ask every Blinkit store this run "
        f"(otherwise one of {ROTATION} slices a run)",
    )
    parser.add_argument(
        "--search",
        action="store_true",
        help=f"search every keyword this run (otherwise up to {KEYWORDS_PER_RUN} a run from "
        f"{SEARCH_FROM_HOUR}:00 until all are done today)",
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

    report = execute_run(
        settings,
        products,
        source=args.source,
        full=args.full,
        force_search=args.search,
        dry_run=args.dry_run,
        on_phase=lambda text, _reset: print(f"[{time.monotonic() - started:5.0f}s] {text}"),
    )
    results, searches = report.results, report.searches
    for problem in report.problems:
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

    if searches is not None:
        ours = sum(r.brand == "IMECO" for r in searches)
        print(f"search: {len(searches)} results, {ours} of them IMECO's")

    if args.dry_run:
        print("dry run — nothing written to Supabase")
        return 0

    print(
        f"\nstored {report.stored} snapshots, {len(report.checks)} dark-store checks "
        f"(run {report.run_id})"
    )
    for warning in report.warnings:
        print(f"  ! {warning}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
