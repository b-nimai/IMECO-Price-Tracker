"""Blinkit.

The best of the five, and the only one not parsing markup. Blinkit publishes a
`schema.org/Product` JSON-LD block, so extraction hits a documented standard rather than CSS
classes — this adapter should survive redesigns the others will not.

It is also the only marketplace reporting real stock status, which is what lets OUT_OF_STOCK
be actual data instead of a guess.

Verified live:
    /prid/691909  ->  price 189, mrp 270, OutOfStock (inventory 0)
    /prid/695492  ->  price  89, mrp 249, InStock    (inventory 1)

Prices were identical from Delhi and Bangalore coordinates, so despite Blinkit being a
hyperlocal service, no per-city fan-out is needed.
"""

from __future__ import annotations

import re

from ..models import Cell, Status
from ._util import find_json_objects, json_ld_products, to_price

_PRID = re.compile(r"/prid/(\d+)")


def _state_blob(html: str, url: str) -> dict | None:
    """The page's OWN product state, or None. Never a neighbouring product's.

    Blinkit embeds a priced `product_id` object for every card on the page, including the
    "you might also like" rail — and the rail's objects come first in the markup. So the only
    safe way to identify this product's data is the prid from the URL.

    THERE IS DELIBERATELY NO FALLBACK. An earlier version returned the first priced block when
    no id matched, and it published two wrong prices: ₹449 for an item selling at ₹199, and
    ₹405 for one at ₹189, both lifted from a recommendation tile for a different pack. Those
    numbers were indistinguishable from correct ones on the wall.

    When this returns None the caller still has the page's own JSON-LD, which is genuinely
    scoped to this product — so the outcome is a price with less detail, or an honest `error`,
    never a confident wrong number.
    """
    m = _PRID.search(url)
    if not m:
        return None
    for blob in find_json_objects(html, "product_id"):
        if str(blob.get("product_id")) == m.group(1) and to_price(blob.get("price")):
            return blob
    return None


def parse(html: str, url: str) -> Cell:
    price = mrp = None
    unit = None
    in_stock: bool | None = None

    # Preferred path: the published standard.
    for product in json_ld_products(html):
        offers = product.get("offers")
        if isinstance(offers, list):
            offers = offers[0] if offers else None
        if not isinstance(offers, dict):
            continue
        price = to_price(offers.get("price"))
        availability = str(offers.get("availability", ""))
        if availability:
            in_stock = "outofstock" not in availability.lower().replace("/", "")
        if price:
            break

    # Blinkit's internal state carries mrp, inventory and pack size, which JSON-LD does not.
    blob = _state_blob(html, url)
    if blob is not None:
        mrp = to_price(blob.get("mrp"))
        unit = str(blob.get("unit") or "").strip() or None
        if price is None:
            price = to_price(blob.get("price"))
        if in_stock is None:
            if "inventory" in blob:
                try:
                    in_stock = int(blob["inventory"]) > 0
                except (TypeError, ValueError):
                    pass
            elif blob.get("state"):
                in_stock = str(blob["state"]).lower() == "available"

    if price is None:
        # Blinkit publishes the product page for a SKU no dark store currently carries: the
        # JSON-LD is well-formed, says OutOfStock, and quotes `price: 0` — its way of saying
        # "there is no offer here". `to_price` rejects the 0 (a zero price is never real), so
        # nothing is left to report.
        #
        # That is OUT OF STOCK, not an error. `error` means the page defeated the parser and
        # somebody should look at the adapter; this page was read perfectly and simply says the
        # item cannot be bought. Filing it as `error` sent people hunting a bug that was not
        # there, and buried the one signal that would matter if the markup really did change.
        if in_stock is False:
            return Cell(
                marketplace="blinkit",
                status=Status.OUT_OF_STOCK,
                url=url,
                note="listed on Blinkit, but no store is carrying it",
            )
        return Cell(
            marketplace="blinkit",
            status=Status.ERROR,
            url=url,
            note="no price in JSON-LD or product state",
        )

    # An out-of-stock listing keeps its price. The number is still true — it is what the item
    # costs when it comes back — and blanking it would lose real information. The status is
    # what tells the dashboard to render it differently.
    return Cell(
        marketplace="blinkit",
        status=Status.OK if in_stock is not False else Status.OUT_OF_STOCK,
        price=price,
        mrp=mrp,
        unit=unit,
        url=url,
        note=None if in_stock is not False else "out of stock on Blinkit",
    )
