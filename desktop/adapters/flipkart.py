"""Flipkart.

Price lives in the `ppd` node of the embedded state:

    "ppd":{"fsp":336,"finalPrice":382,"mrp":499,"nepPrice":236,"specialPrice":true}

`fsp` ("Flipkart selling price") is the number shown to the customer — confirmed by it also
appearing under the `price`, `primaryProductPrice` and `text` keys, `text` being the rendered
string. `finalPrice` appears exactly once and is NOT what the page displays; using it would
have reported 382 against an actual 336.

Two traps this adapter exists to avoid:

  1. Regex on `₹` is unusable. A probe of this exact page pulled 154, 310, 174 and 77 — all
     from recommendation tiles, none the product's own price.
  2. `finalPrice` reads like the right field and is not.
"""

from __future__ import annotations

import re

from ..models import Cell, Status
from ._util import find_json_objects, to_price

# The `ppd` block, matched directly. Cheaper than a full brace-scan of a 1.4 MB page, and this
# shape has been stable; `find_json_objects` is the fallback when it is not.
_PPD = re.compile(r'"ppd"\s*:\s*\{([^{}]*)\}')
_FIELD = re.compile(r'"(\w+)"\s*:\s*(-?[\d.]+)')

# `>Notify Me<` is the rendered button Flipkart now shows in place of "Buy Now" on a listing it
# cannot sell — with the ppd node zeroed out ("fsp":0,"mrp":0) and none of the older phrases on
# the page. Without it, 11 out-of-stock SKUs were reported as `error`. The button also appears on
# some in-stock pages (a price alert), which is harmless: this is only consulted once no price
# was found.
_UNAVAILABLE = re.compile(
    r"(?:Currently Out of Stock|Sold Out|This item is unavailable|>Notify Me<)", re.I
)


def _from_ppd(html: str) -> tuple[float | None, float | None]:
    m = _PPD.search(html)
    if not m:
        return None, None
    fields = {k: v for k, v in _FIELD.findall(m.group(1))}
    return to_price(fields.get("fsp")), to_price(fields.get("mrp"))


def parse(html: str, url: str) -> Cell:
    price, mrp = _from_ppd(html)

    if price is None:
        # Fallback: any embedded object carrying an `fsp`. Deliberately still keyed on `fsp`
        # rather than widening to `finalPrice` — a wrong price is worse than no price.
        for blob in find_json_objects(html, "fsp"):
            candidate = to_price(blob.get("fsp"))
            if candidate:
                price = candidate
                mrp = mrp or to_price(blob.get("mrp"))
                break

    if price is None:
        if _UNAVAILABLE.search(html):
            return Cell(
                marketplace="flipkart",
                status=Status.OUT_OF_STOCK,
                mrp=mrp,
                url=url,
                note="out of stock on Flipkart",
            )
        return Cell(
            marketplace="flipkart",
            status=Status.ERROR,
            url=url,
            note="no fsp in ppd node",
        )

    return Cell(marketplace="flipkart", status=Status.OK, price=price, mrp=mrp, url=url)
