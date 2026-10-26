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
from dataclasses import dataclass
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
    """(path, is_operator_supplied, human date) — for the GUI's status line.

    A date is reported only for an OPERATOR-SUPPLIED sheet, because only that one has a
    meaningful date. PyInstaller extracts the bundled workbook into a fresh temporary
    directory on every launch, so its mtime is the moment the app was opened — the built-in
    sheet was displaying "07 Aug 2026 19:46" when 19:46 was simply when someone double-clicked
    the .exe. A timestamp that changes every launch is worse than none: it reads as "this sheet
    is up to date" no matter how old the bundled data actually is.
    """
    path = active_workbook()
    if path != USER_WORKBOOK:
        return path, False, "shipped with this app"
    try:
        stamp = "uploaded " + datetime.fromtimestamp(path.stat().st_mtime).strftime("%d %b %Y %H:%M")
    except OSError:
        stamp = "uploaded, date unknown"
    return path, True, stamp


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
    own = sum(p.competitor_of is None for p in products)
    rivals = len(products) - own
    who = f"{own} products" + (f" + {rivals} competitor{'s' * (rivals != 1)}" if rivals else "")
    return f"{who}, {sum(len(p.urls) for p in products)} listings ({per})"

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
    # The sheet still has "Myntra SP" / "Myntra Link" columns. They are deliberately NOT mapped:
    # Myntra was dropped, and an unmapped header is simply ignored, so the links never reach
    # `Product.urls` and never get counted as listings to fetch.
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

    ONE SHEET, ONE ROW PER PRODUCT — the sheet the operator already keeps, with optional columns
    added on the right for that product's search keywords and its competitors' links:

        SKU | Product Name | MRP | ... Links ... | Keywords |
            Competitor 1 Brand | Competitor 1 Name | Competitor 1 Amazon Link | ... Flipkart ... |
            ... Blinkit ... | Competitor 2 Brand | ...

    As many numbered competitors as there are column groups. Every one of these columns is
    optional, so a sheet without them reads exactly as it always has, and a competitor whose
    links are still blank is simply not tracked yet. (Competitor rows with a "Competitor Of"
    column, on this sheet or a separate "Competitors" sheet, are still accepted too.)
    """
    path = path or active_workbook()
    if not path.exists():
        raise FileNotFoundError(f"catalogue workbook not found: {path}")

    # Not read_only: that mode drops hyperlinks, and a link cell may show "Amazon" or "Link"
    # with the URL only behind it. The sheet is small, so the full load costs nothing.
    book = load_workbook(path, data_only=True)
    own, rivals = _read_sheet(book.worksheets[0], path, main=True)
    extra = next((ws for ws in book.worksheets if ws.title.strip().lower() == COMPETITOR_SHEET), None)
    if extra is not None and extra is not book.worksheets[0]:
        rivals += _read_sheet(extra, path, main=False)[1]

    products = own + _resolve_competitors(rivals, own, path)
    _reject_duplicates(products, path)
    return products


def _header(rows, path: Path, sheet: str) -> tuple[dict[str, int], dict[int, tuple[str, str]]]:
    """(fixed column -> index, index -> (marketplace, kind)) from a sheet's first row.

    Driven by header text rather than position so inserting a column does not silently shift
    every price.
    """
    try:
        header = next(rows)
    except StopIteration as exc:
        raise ValueError(f"{path.name}: the {sheet} sheet is empty") from exc

    fixed: dict[str, int] = {}
    cols: dict[int, tuple[str, str]] = {}
    for i, cell in enumerate(header):
        key = str(cell or "").strip().lower()
        if key in HEADERS:
            cols[i] = HEADERS[key]
        elif key:
            fixed.setdefault(key, i)
    return fixed, cols


def _read_listings(product: Product, row: tuple, cols: dict[int, tuple[str, str]]) -> None:
    """Fill a product's links and target prices from its row."""
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


def _value(cell) -> object:
    """A cell's value — or, for a hyperlink whose shown text is not a URL ("Amazon", "Link",
    a product name), the address behind it. A pasted URL that Excel turned into a link reads the
    same either way."""
    value = cell.value
    link = getattr(cell, "hyperlink", None)
    target = getattr(link, "target", None) if link else None
    if target and str(target).lower().startswith("http") and not str(value or "").lower().startswith("http"):
        return target
    return value


def _cell(row: tuple, index: int | None) -> object:
    return row[index] if index is not None and index < len(row) else None


_KEYWORD_SPLIT = re.compile(r"[,;|\n]+")


def split_keywords(raw: object) -> list[str]:
    """A Keywords cell -> its keywords. Commas, semicolons, "|" or new lines all separate."""
    return [" ".join(k.split()) for k in _KEYWORD_SPLIT.split(str(raw or "")) if k.strip()]


@dataclass
class _Rival:
    """A competitor row, held until every IMECO SKU is known so "Competitor Of" can be checked."""

    product: Product
    explicit_sku: str
    where: str  # "row 7" / "Competitors row 3", for the error message


def _read_sheet(ws, path: Path, main: bool) -> tuple[list[Product], list[_Rival]]:
    """(IMECO products, competitor rows) from one sheet.

    `main` is the workbook's first sheet, which must have SKU and Product Name. The optional
    "Competitors" sheet needs only "Competitor Of" — and may be empty, or header-only, while it
    is being filled in.
    """
    label = "first" if main else "Competitors"
    rows = (tuple(_value(c) for c in r) for r in ws.iter_rows())
    first = next(rows, None)
    if first is None or not any(str(c or "").strip() for c in first):
        if main:
            raise ValueError(f"{path.name} is empty")
        return [], []  # an empty placeholder sheet
    fixed, cols = _header(iter([first]), path, label)

    sku_col, name_col, mrp_col = fixed.get("sku"), fixed.get("product name"), fixed.get("mrp")
    of_col, brand_col = fixed.get("competitor of"), fixed.get("brand")
    kw_col = fixed.get("keywords", fixed.get("keyword"))
    slots = _competitor_columns(fixed, cols)
    if main and (sku_col is None or name_col is None):
        raise ValueError(f"{path.name}: missing required 'SKU' / 'Product Name' headers")
    if not main and of_col is None:
        raise ValueError(f"{path.name}: the Competitors sheet needs a 'Competitor Of' column")

    own: list[Product] = []
    rivals: list[_Rival] = []
    for n, row in enumerate(rows, start=2):  # Excel row number, header being row 1
        raw_sku = str(_cell(row, sku_col) or "")
        sku = raw_sku.replace(STAR, "").strip()
        of = str(_cell(row, of_col) or "").replace(STAR, "").strip()
        name = str(_cell(row, name_col) or "").strip()
        mrp = parse_price(_cell(row, mrp_col))

        if of:
            rival = Product(
                sku="",
                name=name,
                mrp=mrp,
                starred=False,
                position=0,  # set in _resolve_competitors, after every IMECO product
                brand=str(_cell(row, brand_col) or "").strip() or "Unknown brand",
                competitor_of=of,
            )
            _read_listings(rival, row, cols)
            where = f"row {n}" if main else f"Competitors row {n}"
            rivals.append(_Rival(rival, sku, where))
            continue
        if not main or not sku:
            continue  # blank spacer row

        product = Product(
            sku=sku,
            name=name,
            mrp=mrp,
            starred=STAR in raw_sku,
            # Position among PARSED rows, not among worksheet rows: blank spacers and competitor
            # rows are skipped, and a gap in the numbering would otherwise appear wherever the
            # sheet has one. The dashboard only ever sorts on this, so density is what matters,
            # not matching a row number in Excel.
            position=len(own),
            keywords=split_keywords(_cell(row, kw_col)),
        )
        _read_listings(product, row, cols)
        own.append(product)
        for slot, fields in sorted(slots.items()):
            rival = _rival_from_columns(row, fields, sku)
            if rival is not None:
                rivals.append(_Rival(rival, "", f"row {n}, competitor {slot}"))
    return own, rivals


# "Competitor 2 Amazon Link", "competitor 2 brand", "Competitor2 Flipkart Link", ...
_COMPETITOR_COLUMN = re.compile(
    r"^competitor\s*(\d+)\s*(brand|name|product name|amazon link|flipkart link|blinkit link)$"
)


def _competitor_columns(
    fixed: dict[str, int], cols: dict[int, tuple[str, str]]
) -> dict[int, dict[str, int]]:
    """{competitor number: {field: column index}} from the header's "Competitor N ..." columns."""
    slots: dict[int, dict[str, int]] = {}
    for key, index in fixed.items():
        m = _COMPETITOR_COLUMN.match(key)
        if m:
            field_name = "name" if m.group(2) == "product name" else m.group(2)
            slots.setdefault(int(m.group(1)), {})[field_name] = index
    return slots


def _rival_from_columns(row: tuple, fields: dict[str, int], of: str) -> Product | None:
    """One competitor from one product row's "Competitor N" columns, or None while its links
    are still blank."""
    rival = Product(
        sku="",
        name=str(_cell(row, fields.get("name")) or "").strip(),
        mrp=None,
        starred=False,
        position=0,
        brand=str(_cell(row, fields.get("brand")) or "").strip() or "Unknown brand",
        competitor_of=of,
    )
    for marketplace in ("amazon", "flipkart", "blinkit"):
        raw = _cell(row, fields.get(f"{marketplace} link"))
        url = canonical_url(marketplace, str(raw)) if raw else None
        if url:
            rival.urls[marketplace] = url
    return rival if rival.urls else None


# ── Competitors ─────────────────────────────────────────────────────────────────────────
# Entered as numbered column groups on each IMECO product's own row (see `load_products`):
#
#   Competitor 1 Brand | Competitor 1 Name | Competitor 1 Amazon Link | Competitor 1 Flipkart
#   Link | Competitor 1 Blinkit Link | Competitor 2 Brand | ...
#
# There is deliberately no SKU to fill in: a competitor's key is made from the IMECO SKU and its
# first link (`C:IMEBKT360:amazon:B0XXXXXXXX`), which is unique and stays the same however the
# sheet is edited. The older row form — a row with "Competitor Of" set to the IMECO SKU, on this
# sheet or on a separate "Competitors" sheet — is read by the same rules.
COMPETITOR_SHEET = "competitors"
LISTING_ID = {
    "amazon": re.compile(r"/dp/([A-Z0-9]{10})"),
    "flipkart": re.compile(r"[?&]pid=([A-Z0-9]+)"),
    "blinkit": re.compile(r"/prid/(\d+)"),
}


def _competitor_key(product: Product) -> str | None:
    """`C:<IMECO SKU>:<marketplace>:<listing id>`. The IMECO SKU is part of it so the same rival
    listing can be compared against more than one of our products."""
    for marketplace in ("amazon", "flipkart", "blinkit"):
        url = product.urls.get(marketplace)
        m = url and LISTING_ID[marketplace].search(url)
        if m:
            return f"C:{product.competitor_of}:{marketplace}:{m.group(1)}"
    return None


def _resolve_competitors(rivals: list[_Rival], own: list[Product], path: Path) -> list[Product]:
    """Key and check the competitor rows.

    Built to be filled in GRADUALLY: a row whose links have not been found yet is skipped until
    one is added. Only a genuine mistake is refused, by row: a "Competitor Of" that is not an
    IMECO SKU (a typo would otherwise compare a rival against nothing). Same reasoning as
    `_reject_duplicates`: tell the operator now, while they are looking at the file, not an
    hour later in a scheduled run.
    """
    known = {p.sku for p in own}
    out: list[Product] = []
    for r in rivals:
        product = r.product
        if product.competitor_of not in known:
            raise ValueError(
                f"{path.name}: {r.where} says 'Competitor Of' {product.competitor_of!r}, which "
                "is not an IMECO SKU in this sheet. Use the SKU exactly as it is written there."
            )
        key = r.explicit_sku or _competitor_key(product)
        if not key:
            continue  # no link found for it yet — nothing to fetch until one is added
        if any(p.sku == key for p in out):
            continue  # the same rival entered twice for the same product: track it once
        product.sku = key
        # After every IMECO product, so a competitor can never sit among them in sheet order.
        product.position = len(own) + len(out)
        if not product.name:
            product.name = product.brand
        out.append(product)
    return out


def _reject_duplicates(products: list[Product], path: Path) -> None:
    """A SKU may appear once. Refuse the sheet, by name, if one appears twice.

    The SKU is the database's primary key, so a repeat makes the catalogue upsert fail with
    `ON CONFLICT DO UPDATE command cannot affect row a second time` — a message that says
    nothing to the person who typed the duplicate, arriving an hour later inside a scheduled
    run that then stores nothing at all.

    Raised from the parser so `install_workbook` catches it BEFORE the sheet is adopted: the
    operator is told which SKU to fix while they are still looking at the file picker, and the
    previous workbook stays in force meanwhile.
    """
    seen: set[str] = set()
    repeated: list[str] = []
    for product in products:
        if product.sku in seen and product.sku not in repeated:
            repeated.append(product.sku)
        seen.add(product.sku)

    if repeated:
        listed = ", ".join(repeated)
        if all(s.startswith("C:") for s in repeated):
            # Competitor keys are made from the link, so a repeat means the same listing twice.
            raise ValueError(
                f"{path.name}: the Competitors sheet lists the same product link twice ({listed}). "
                "Keep one row per competitor product and try again."
            )
        raise ValueError(
            f"{path.name}: the same SKU appears on more than one row ({listed}). "
            "Every product needs its own SKU — merge or rename those rows and try again."
        )


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
    print(f"competitors: {sum(p.competitor_of is not None for p in products)}")
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
