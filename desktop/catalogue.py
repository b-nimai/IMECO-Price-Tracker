"""Reads `Docs/pricing link.xlsx` into normalised Products.

The workbook is hand-maintained, so this file is mostly about absorbing its inconsistencies
without letting any of them become a wrong number downstream. Every quirk handled here was
observed in the real file, not guessed at.

Run directly to inspect what was parsed:

    python -m desktop.catalogue
"""

from __future__ import annotations

import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

from openpyxl import load_workbook

from .models import Product

#: The workbook that ships with the app — the repo copy when running from source, and the one
#: baked into the bundle when frozen (`desktop_entry.py` repoints this).
WORKBOOK = Path(__file__).resolve().parent.parent / "Docs" / "pricing link.xlsx"

#: Where an operator-supplied workbook is kept once accepted.
#:
#: Deliberately OUTSIDE the app: a .exe is replaced wholesale on every rebuild, and a sheet
#: stored beside it would be destroyed by the next update. %LOCALAPPDATA% survives that, and
#: survives the exe being moved to another folder.
USER_WORKBOOK = (
    Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    / "IMECO Price Tracker"
    / "pricing link.xlsx"
)


def active_workbook() -> Path:
    """The workbook a run should read: the operator's if they have supplied one, else ours.

    This is the whole "update the spreadsheet" feature in one function. Nothing else needs to
    know which copy won — `load_products()` calls this, so a scheduled run picks up a sheet the
    operator swapped in an hour ago without the app being rebuilt or even restarted.
    """
    return USER_WORKBOOK if USER_WORKBOOK.exists() else WORKBOOK


def workbook_status() -> tuple[Path, bool, str]:
    """(path, is_operator_supplied, human date) — for the GUI's status line."""
    path = active_workbook()
    try:
        stamp = datetime.fromtimestamp(path.stat().st_mtime).strftime("%d %b %Y %H:%M")
    except OSError:
        stamp = "unknown date"
    return path, path == USER_WORKBOOK, stamp


def install_workbook(source: Path) -> list[Product]:
    """Validate `source`, then adopt it as the workbook every future run will read.

    PARSED BEFORE IT IS COPIED, and that ordering is the point. This app runs unattended once
    an hour; if a malformed sheet could be installed, the next 24 scrapes would fail silently
    while the operator believed they had just updated prices. A workbook that cannot be read,
    or that yields no products, is rejected and the previous one stays in force.
    """
    products = load_products(source)
    if not products:
        raise ValueError("that sheet parsed but contained no products — nothing was changed")

    USER_WORKBOOK.parent.mkdir(parents=True, exist_ok=True)
    # Copy to a temporary name and rename, so a failure part-way through cannot leave a
    # truncated workbook in place of the working one.
    staging = USER_WORKBOOK.with_suffix(".incoming")
    shutil.copyfile(source, staging)
    staging.replace(USER_WORKBOOK)
    return products


def revert_workbook() -> bool:
    """Drop the operator's copy and fall back to the one shipped with the app."""
    if not USER_WORKBOOK.exists():
        return False
    USER_WORKBOOK.unlink()
    return True


def summarise_catalogue(products: list[Product]) -> str:
    """A short "what this sheet contains" line, shown before a swap is committed."""
    counts: dict[str, int] = {}
    for p in products:
        for marketplace in p.urls:
            counts[marketplace] = counts.get(marketplace, 0) + 1
    per = ", ".join(f"{m} {n}" for m, n in sorted(counts.items(), key=lambda kv: -kv[1]))
    return f"{len(products)} products, {sum(len(p.urls) for p in products)} listings ({per})"

# Column A carries a U+2605 star on 24 of 32 rows. It has to come off before the SKU can be
# used as a database key, but it is kept as `Product.starred`.
STAR = "★"

# Header text -> (marketplace, kind). Matched case-insensitively on the stripped header, so
# adding "Blinkit SP" / "Blinkit Link" to the sheet is all that is needed to light Blinkit up.
HEADERS: dict[str, tuple[str, str]] = {
    "amazon sp": ("amazon", "sp"),
    "amazon link": ("amazon", "link"),
    "flipkart sp": ("flipkart", "sp"),
    "flipkart link": ("flipkart", "link"),
    "myntra sp": ("myntra", "sp"),
    "myntra link": ("myntra", "link"),
    "blinkit sp": ("blinkit", "sp"),
    "blinkit link": ("blinkit", "link"),
}


def parse_price(raw: object) -> float | None:
    """Cell -> number, or None for a genuinely absent value.

    None rather than 0.0 is deliberate and load-bearing: a blank price cell means "not listed
    here", which must stay distinguishable from a real price of zero all the way to the screen.
    """
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw) if raw == raw else None  # NaN check
    s = str(raw).strip()
    if not s or s.lower() in {"nan", "-", "na", "n/a"}:
        return None
    s = re.sub(r"[^\d.]", "", s.replace(",", ""))
    if not s or s == ".":
        return None
    try:
        return float(s)
    except ValueError:
        return None


# ── URL canonicalisation ────────────────────────────────────────────────────────────────
# Each marketplace gets reduced to its stable identifier and rebuilt. This strips tracking
# junk (one Amazon row is a 900-char search URL) and guarantees a consistent shape to fetch.

_CANONICALISERS: dict[str, tuple[re.Pattern[str], str]] = {
    # ASIN. Handles both /dp/B0XXXXXXXX and the /IMECO-Baby-Wipes/dp/B0XXXXXXXX/ref=... form.
    "amazon": (re.compile(r"/dp/([A-Z0-9]{10})"), "https://www.amazon.in/dp/{}"),
    # Myntra style id — the numeric path segment; the sheet has no slug.
    "myntra": (re.compile(r"myntra\.com/(?:.*/)?(\d{5,})"), "https://www.myntra.com/{}"),
    # Blinkit product id.
    "blinkit": (re.compile(r"/prid/(\d+)"), "https://blinkit.com/prn/-/prid/{}"),
}


def canonical_url(marketplace: str, raw: str) -> str | None:
    """Reduce a sheet URL to a canonical, fetchable form. None if it is unusable."""
    url = raw.strip()
    if not url.lower().startswith(("http://", "https://")):
        return None

    if marketplace in _CANONICALISERS:
        pattern, template = _CANONICALISERS[marketplace]
        m = pattern.search(url)
        return template.format(m.group(1)) if m else url

    if marketplace == "flipkart":
        # The real identifier is the pid. All but one row uses the placeholder
        # `/product/p/itme?pid=` slug, which Flipkart resolves fine, so normalise onto it.
        m = re.search(r"[?&]pid=([A-Z0-9]+)", url)
        return f"https://www.flipkart.com/product/p/itme?pid={m.group(1)}" if m else url

    return url


def load_products(path: Path | None = None) -> list[Product]:
    """Parse the workbook. Raises if the file or its header row is missing.

    Defaults to `active_workbook()`, NOT to the shipped copy — so an operator-supplied sheet is
    what every run reads, without a single call site having to know that.
    """
    path = path or active_workbook()
    if not path.exists():
        raise FileNotFoundError(f"catalogue workbook not found: {path}")

    ws = load_workbook(path, data_only=True, read_only=True).worksheets[0]
    rows = ws.iter_rows(values_only=True)

    try:
        header = next(rows)
    except StopIteration as exc:
        raise ValueError(f"{path.name} is empty") from exc

    # Map column index -> (marketplace, kind), plus the three fixed columns. Driven by header
    # text rather than position so inserting a column does not silently shift every price.
    cols: dict[int, tuple[str, str]] = {}
    sku_col = name_col = mrp_col = None
    for i, cell in enumerate(header):
        key = str(cell or "").strip().lower()
        if key == "sku":
            sku_col = i
        elif key == "product name":
            name_col = i
        elif key == "mrp":
            mrp_col = i
        elif key in HEADERS:
            cols[i] = HEADERS[key]

    if sku_col is None or name_col is None:
        raise ValueError(f"{path.name}: missing required 'SKU' / 'Product Name' headers")

    products: list[Product] = []
    for row in rows:
        raw_sku = str(row[sku_col] or "").replace(STAR, "").strip()
        if not raw_sku:
            continue  # blank spacer row

        product = Product(
            sku=raw_sku,
            name=str(row[name_col] or "").strip(),
            mrp=parse_price(row[mrp_col]) if mrp_col is not None else None,
            starred=STAR in str(row[sku_col] or ""),
        )

        for i, (marketplace, kind) in cols.items():
            if i >= len(row):
                continue
            value = row[i]
            if value is None:
                continue
            if kind == "sp":
                price = parse_price(value)
                if price is not None:
                    product.target_sp[marketplace] = price
            else:
                url = canonical_url(marketplace, str(value))
                if url:
                    product.urls[marketplace] = url

        products.append(product)

    return products


def _main() -> int:
    """Inspect the parsed catalogue — the check described in the plan's Verification step 1."""
    if sys.stdout is not None:  # None under pythonw.exe — see run.main()
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    products = load_products()

    print(f"{len(products)} products from {WORKBOOK.name}\n")
    counts: dict[str, int] = {}
    for p in products:
        for marketplace in p.urls:
            counts[marketplace] = counts.get(marketplace, 0) + 1

    print("links per marketplace:")
    for marketplace, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {marketplace:<9} {n}")
    print(f"\nstarred: {sum(p.starred for p in products)}")
    print(f"total listings to fetch: {sum(len(p.urls) for p in products)}\n")

    for p in products[:3]:
        print(f"  {p.sku}  mrp={p.mrp}  starred={p.starred}")
        print(f"    {p.name[:70]}")
        for marketplace, url in p.urls.items():
            sp = p.target_sp.get(marketplace)
            print(f"      {marketplace:<9} sp={sp!s:<7} {url[:78]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
