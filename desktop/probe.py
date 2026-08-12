"""Fetch and parse one listing, or the known-good set. A quick way to tell whether a site
changed its markup without running the whole catalogue.

    python -m desktop.probe                      # the verified fixtures below
    python -m desktop.probe amazon <url>         # one listing
"""

from __future__ import annotations

import sys

from .adapters import PARSERS
from .config import load_settings
from .fetch import Fetcher

#: Listings whose live values were confirmed by hand during planning. If one of these stops
#: matching, the adapter is broken — not the listing.
FIXTURES: list[tuple[str, str, str]] = [
    ("amazon", "https://www.amazon.in/dp/B0GLNWPCPT", "expect 299"),
    ("flipkart", "https://www.flipkart.com/product/p/itme?pid=KNRHKDXNWEFBN2GG", "expect fsp 336, mrp 499"),
    ("blinkit", "https://blinkit.com/prn/-/prid/695492", "expect 89, mrp 249, in stock"),
    ("blinkit", "https://blinkit.com/prn/-/prid/691909", "expect 189, mrp 270, OUT OF STOCK"),
]


def run(targets: list[tuple[str, str, str]]) -> int:
    settings = load_settings()
    failures = 0

    with Fetcher(settings) as fetcher:
        for marketplace, url, expectation in targets:
            result = fetcher.fetch_html(marketplace, url)
            if not result.ok:
                print(f"  {marketplace:<9} {result.status.value.upper():<13} {result.note}")
                print(f"            {expectation}")
                failures += 1
                continue

            cell = PARSERS[marketplace](result.html, url)
            money = f"{cell.price:g}" if cell.price is not None else "-"
            mrp = f"{cell.mrp:g}" if cell.mrp is not None else "-"
            flag = "  <-- CHECK" if cell.status.value == "error" else ""
            print(
                f"  {marketplace:<9} {cell.status.value:<13} price={money:<7} mrp={mrp:<7}"
                f" via={result.via.value:<11} {expectation}{flag}"
            )
            if cell.unit:
                print(f"            unit: {cell.unit}")
            if cell.note:
                print(f"            note: {cell.note}")
            if cell.status.value == "error":
                failures += 1

    return 1 if failures else 0


def _main() -> int:
    if sys.stdout is not None:  # None under pythonw.exe — see run.main()
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = sys.argv[1:]
    if len(args) == 2:
        marketplace, url = args
        if marketplace not in PARSERS:
            print(f"unknown marketplace: {marketplace}. one of {sorted(PARSERS)}")
            return 2
        return run([(marketplace, url, "")])
    return run(FIXTURES)


if __name__ == "__main__":
    raise SystemExit(_main())
