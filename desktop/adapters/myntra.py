"""Myntra.

Price comes from the `window.__myx` state embedded in the product page:

    "price":{"mrp":499,"discounted":262}

Note the API route is NOT usable — `myntra.com/gateway/v2/product/{styleId}` returns 401
without a session, so the HTML page is the only way in.

Verified live: style 40002424 -> discounted 262, mrp 499. The sheet records an intended SP of
259, so this listing has genuinely drifted +1.2%. It was the first drift this project found.
"""

from __future__ import annotations

import re

from ..models import Cell, Status
from ._util import to_price

# The canonical node. Both keys in one object, so no risk of pairing an mrp with the wrong price.
_PRICE_NODE = re.compile(r'"price"\s*:\s*\{\s*"mrp"\s*:\s*([\d.]+)\s*,\s*"discounted"\s*:\s*([\d.]+)')
# Fallback: the seller block carries the same figure under a different name.
_SELLER_PRICE = re.compile(r'"discountedPrice"\s*:\s*([\d.]+)')
_MRP_ONLY = re.compile(r'"mrp"\s*:\s*([\d.]+)')

# Every size row is `"available":true|false`. All-false means nothing is buyable.
_AVAILABLE = re.compile(r'"available"\s*:\s*(true|false)')


def parse(html: str, url: str) -> Cell:
    price = mrp = None

    m = _PRICE_NODE.search(html)
    if m:
        mrp = to_price(m.group(1))
        price = to_price(m.group(2))
    else:
        m = _SELLER_PRICE.search(html)
        if m:
            price = to_price(m.group(1))
        m = _MRP_ONLY.search(html)
        if m:
            mrp = to_price(m.group(1))

    if price is None:
        return Cell(
            marketplace="myntra",
            status=Status.ERROR,
            mrp=mrp,
            url=url,
            note="no price node in __myx state",
        )

    # Only treat as OOS when sizes were actually found and every one is unavailable — absence
    # of the field must not be read as absence of stock.
    flags = _AVAILABLE.findall(html)
    sold_out = bool(flags) and all(f == "false" for f in flags)

    return Cell(
        marketplace="myntra",
        status=Status.OUT_OF_STOCK if sold_out else Status.OK,
        price=price,
        mrp=mrp,
        url=url,
        note="out of stock on Myntra" if sold_out else None,
    )
