"""Meesho prices, read from the Google Sheet the Meesho team keeps — never scraped.

    python -m desktop.meesho        # read the sheet, print what matches, store nothing

Meesho refuses automated requests (see README), so its prices come from Meesho's own
"Price Recommendations" export instead. Whoever handles Meesho pastes that export, unchanged,
into the "Meesho Product Sheet" Google Sheet, shared as "anyone with the link can view".

Each run reads that sheet and keeps only the products on OUR sheet: a row's STYLE ID is the
same code as our SKU. The prices move when the Meesho team pastes a new export — a few times a
week, not every hour — so a reading is saved ONLY when it differs from the last one stored.
The dashboard carries the last saved price forward until the next change.
"""

from __future__ import annotations

import io
import os
import re
from dataclasses import dataclass

import httpx

from .models import Cell, Product, Status, Via
from .tls import SSL_CONTEXT

MARKETPLACE = "meesho"

#: The "Meesho Product Sheet". Overridable for a test copy without rebuilding the .exe.
SHEET_ID = os.environ.get("MEESHO_SHEET_ID", "11WhxmP81D42QTmEZ2_NH1C5OgcSCAwsQWNCRIoKUJvg")

#: Downloaded as a whole workbook rather than one tab as CSV: a CSV export is addressed by the
#: tab's numeric id, which changes whenever someone deletes the tab and pastes a fresh one in.
#: The workbook is found by tab NAME, and failing that by its headers.
EXPORT_URL = "https://docs.google.com/spreadsheets/d/{id}/export?format=xlsx"
TAB_NAME = "price recommendations"

#: Header text, after collapsing whitespace and upper-casing. Columns are found by these, never
#: by position, so a column Meesho adds or moves does not shift the prices.
STYLE_ID = "STYLE ID"
PRICE = "MEESHO PRICE"
RETURNS_PRICE = "WRONG/DEFECTIVE RETURNS PRICE"
SUGGESTED = "COMPETITIVE MEESHO PRICE"
STOCK = "CURRENT STOCK"
PRODUCT_ID = "PRODUCT_ID"

#: Meesho's product links end in the product id written in base 36 — c4ym2e is 733927478.
PRODUCT_URL = "https://www.meesho.com/s/p/{code}"

NOT_IN_SHEET = "Not in the Meesho sheet"


@dataclass(frozen=True)
class Listing:
    style_id: str
    price: float
    returns_price: float | None
    suggested: float | None
    stock: int | None
    product_id: int | None = None

    @property
    def url(self) -> str | None:
        if not self.product_id or self.product_id <= 0:
            return None
        n, code = self.product_id, ""
        while n:
            n, r = divmod(n, 36)
            code = "0123456789abcdefghijklmnopqrstuvwxyz"[r] + code
        return PRODUCT_URL.format(code=code)


def _key(raw: object) -> str:
    return str(raw or "").strip().upper()


def _header(raw: object) -> str:
    return re.sub(r"\s+", " ", str(raw or "")).strip().upper()


def _number(raw: object) -> float | None:
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    text = str(raw).replace(",", "").replace("₹", "").strip()
    try:
        return float(text)
    except ValueError:
        return None


def parse_rows(rows: list[tuple]) -> dict[str, Listing]:
    """The export's rows -> listings by upper-cased STYLE ID.

    Raises ValueError when no header row is found: an emptied or half-pasted sheet must stop the
    Meesho step, not read as "every product left Meesho".
    """
    for at, row in enumerate(rows[:20]):
        names = [_header(c) for c in row]
        if STYLE_ID in names and PRICE in names:
            cols = {name: i for i, name in reversed(list(enumerate(names))) if name}
            break
    else:
        raise ValueError(f'no "{STYLE_ID}" / "{PRICE}" header row in the Meesho sheet')

    def get(row: tuple, name: str) -> object:
        i = cols.get(name)
        return row[i] if i is not None and i < len(row) else None

    listings: dict[str, Listing] = {}
    for row in rows[at + 1 :]:
        style = _key(get(row, STYLE_ID))
        price = _number(get(row, PRICE))
        if not style or price is None or price <= 0:
            continue  # the description row under the headers, blanks, or a broken row
        stock = _number(get(row, STOCK))
        product_id = _number(get(row, PRODUCT_ID))
        listings[style] = Listing(
            style_id=style,
            price=price,
            returns_price=_number(get(row, RETURNS_PRICE)),
            suggested=_number(get(row, SUGGESTED)),
            stock=int(stock) if stock is not None else None,
            product_id=int(product_id) if product_id is not None else None,
        )
    return listings


def read_workbook(data: bytes) -> dict[str, Listing]:
    from openpyxl import load_workbook

    book = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        sheets = sorted(book.worksheets, key=lambda ws: TAB_NAME not in ws.title.strip().lower())
        last: ValueError | None = None
        for ws in sheets:
            try:
                return parse_rows(list(ws.iter_rows(max_row=2000, values_only=True)))
            except ValueError as exc:
                last = exc
        raise last or ValueError("the Meesho sheet has no tabs")
    finally:
        book.close()


def fetch_listings(sheet_id: str = SHEET_ID) -> dict[str, Listing]:
    response = httpx.get(
        EXPORT_URL.format(id=sheet_id), follow_redirects=True, timeout=60.0, verify=SSL_CONTEXT
    )
    if response.status_code != 200 or not response.content.startswith(b"PK"):
        # A sheet that is not link-shared answers with Google's sign-in page, not an error.
        raise RuntimeError(
            f"could not download the Meesho sheet [{response.status_code}] — "
            'is it shared as "anyone with the link can view"?'
        )
    return read_workbook(response.content)


def _product_id(url: str | None) -> int | None:
    """The Meesho product id in a listing link — ".../p/c4ym2e" is 733927478."""
    m = re.search(r"/p/([0-9a-z]+)(?:[/?#]|$)", url or "", re.IGNORECASE)
    try:
        return int(m.group(1).lower(), 36) if m else None
    except ValueError:
        return None


def listing_for(product: Product, listings: dict[str, Listing]) -> Listing | None:
    """This product's row on the Meesho sheet: by SKU = STYLE ID, or else through the "Meesho
    Link" on our sheet, for a product Meesho knows by another code (IMECTCP2 is DMWC4KKP)."""
    if product.competitor_of:
        return None
    listing = listings.get(_key(product.sku))
    if listing is None and (pid := _product_id(product.url_for(MARKETPLACE))):
        listing = next((x for x in listings.values() if x.product_id == pid), None)
    return listing


def urls_for(products: list[Product], listings: dict[str, Listing]) -> dict[str, dict[str, str]]:
    """{sku: {"meesho": link}} for products on the Meesho sheet, merged into `products.urls`
    when the catalogue is synced. A link typed in our sheet's "Meesho Link" column wins over
    this one (see Store.sync_products), so this only fills the products that have none."""
    out: dict[str, dict[str, str]] = {}
    for product in products:
        listing = listing_for(product, listings)
        if listing and listing.url:
            out[product.sku] = {MARKETPLACE: listing.url}
    return out


def links_or_none(products: list[Product]) -> dict[str, dict[str, str]] | None:
    """urls_for, straight from the sheet — or None when it cannot be read right now."""
    try:
        return urls_for(products, fetch_listings())
    except Exception:  # noqa: BLE001 — the links come back on the next run
        return None


def cells_for(
    products: list[Product], listings: dict[str, Listing], previously_listed: set[str]
) -> list[tuple[str, Cell]]:
    """A Meesho cell for every one of OUR products the sheet lists.

    Competitors are skipped: the export covers IMECO's own Meesho catalogue only. A product the
    sheet does not list gets a `not_listed` cell when it was on Meesho last time (so the
    dashboard stops showing a price the sheet no longer gives) or when our sheet has a Meesho
    link for it (so its cell says why there is no price instead of "awaiting check" forever).
    `changed` then saves that once, not every run.
    """
    cells: list[tuple[str, Cell]] = []
    for product in products:
        if product.competitor_of:
            continue
        listing = listing_for(product, listings)
        if listing is None:
            if product.sku in previously_listed or product.url_for(MARKETPLACE):
                cells.append(
                    (product.sku, Cell(MARKETPLACE, Status.NOT_LISTED, via=Via.SHEET, note=NOT_IN_SHEET))
                )
            continue
        in_stock = listing.stock is None or listing.stock > 0
        note = None
        if listing.suggested is not None and listing.suggested != listing.price:
            note = f"Meesho suggests ₹{listing.suggested:g}"
        cells.append(
            (
                product.sku,
                Cell(
                    MARKETPLACE,
                    Status.OK if in_stock else Status.OUT_OF_STOCK,
                    price=listing.price,
                    via=Via.SHEET,
                    note=note,
                ),
            )
        )
    return cells


def changed(
    cells: list[tuple[str, Cell]], latest: dict[str, tuple[float | None, str]]
) -> list[tuple[str, Cell]]:
    """Only the cells whose price or status differs from the newest stored one.

    The suggested-price note is deliberately not compared: Meesho recalculates it daily, and
    saving a row for every suggestion would bring back the hourly rows this exists to avoid.
    """
    out = []
    for sku, cell in cells:
        before = latest.get(sku)
        if before is None or before[1] != cell.status.value or before[0] != cell.price:
            out.append((sku, cell))
    return out


def _main() -> int:
    from .catalogue import load_products

    products = load_products()
    listings = fetch_listings()
    cells = cells_for(products, listings, set())
    own = [p for p in products if not p.competitor_of]
    priced = [(s, c) for s, c in cells if c.price is not None]
    print(f"{len(listings)} Meesho listings, {len(priced)} of our {len(own)} products matched\n")
    for sku, cell in priced:
        url = next(p for p in products if p.sku == sku).url_for(MARKETPLACE) or ""
        print(f"  {sku:<22} {cell.status.value:<13} ₹{cell.price:<5g} {url}  {cell.note or ''}")
    missing = [p.sku for p in own if listing_for(p, listings) is None]
    print(f"\nnot on the Meesho sheet ({len(missing)}): {', '.join(missing)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
