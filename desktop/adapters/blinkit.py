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
    """The page's OWN product state, not a recommendation tile's.

    Blinkit embeds a priced `product_id` object for every card on the page, including the
    "you might also like" rail — and the rail's objects come first in the markup. Matching on
    the prid from the URL is what stops a neighbouring product's price being read as this
    one's. Only if no blob carries the right id do we fall back to the first priced one.
    """
    blobs = [b for b in find_json_objects(html, "product_id") if to_price(b.get("price"))]
    if not blobs:
        return None

    m = _PRID.search(url)
    if m:
        for blob in blobs:
            if str(blob.get("product_id")) == m.group(1):
                return blob
    return blobs[0]


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
