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

# The product's own rating sits in its `psi` tracking block, keyed by the FSN — the `pid` in the
# URL:  "psi":{"fsn":"KNRHKDXNWEFBN2GG", ..., "pr":{"individualRatingsCount":[...],
# "rating":4.6,"ratingsCount":416,"reviewsCount":189}
# Keying on the FSN is what keeps recommendation tiles out: a page carries a dozen other
# `"rating":` values. Checked against the page's own JSON-LD where it has one (4.5 / 2165, match).
_PID = re.compile(r"[?&]pid=([A-Z0-9]+)")
_PR = re.compile(r'"pr"\s*:\s*\{')
_STARS = re.compile(r'"rating"\s*:\s*([\d.]+)')
_COUNT = re.compile(r'"ratingsCount"\s*:\s*(\d+)')


def rating(html: str, url: str) -> tuple[float | None, int | None]:
    """(average stars, number of ratings) for this listing, or Nones when it has none yet."""
    pid = _PID.search(url)
    if not pid:
        return None, None
    at = html.find(f'"fsn":"{pid.group(1)}"')
    while at != -1:
        window = html[at : at + 900]
        pr = _PR.search(window)
        if pr:
            body = window[pr.end() :]
            stars = _STARS.search(body)
            count = _COUNT.search(body)
            value = float(stars.group(1)) if stars else None
            return (
                value if value is not None and 0 < value <= 5 else None,
                int(count.group(1)) if count else None,
            )
        at = html.find(f'"fsn":"{pid.group(1)}"', at + 1)
    return None, None


def _from_ppd(html: str) -> tuple[float | None, float | None]:
    m = _PPD.search(html)
    if not m:
        return None, None
    fields = {k: v for k, v in _FIELD.findall(m.group(1))}
    return to_price(fields.get("fsp")), to_price(fields.get("mrp"))


def parse(html: str, url: str) -> Cell:
    cell = _parse(html, url)
    cell.rating, cell.rating_count = rating(html, url)
    return cell


def _parse(html: str, url: str) -> Cell:
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
