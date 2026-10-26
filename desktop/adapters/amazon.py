"""Amazon.in.

Verified live: /dp/B0GLNWPCPT -> 301, mrp 499.

THE CENTRAL PROBLEM ON AMAZON: a product page carries dozens of prices — the buybox, every
variant in the size selector, "Frequently bought together", sponsored tiles, "Customers also
viewed". Only one of them belongs to this ASIN.

An earlier version of this adapter took the first `a-price-whole` on the page. On an AVAILABLE
listing that is harmless, because the buybox price is repeated and appears first. On an
UNAVAILABLE listing there is no buybox price at all, so the first match was a recommendation
tile — B0F79X7RFN reported 369, which was some other product entirely, filed under an IMECO SKU.

The tell is unmistakable once you look:

    B0GLNWPCPT (available)   a-price-whole -> 301, 301, 301, 301   <- one price, repeated
    B0F79X7RFN (no buybox)   a-price-whole -> 369, 170, 139, 179   <- four different products

So this adapter now establishes whether a buybox EXISTS before trusting any number, and reads
the price only from buybox-scoped markup.
"""

from __future__ import annotations

import re

from ..models import Cell, Status
from ._util import to_price

# ── Is there a buybox at all? ───────────────────────────────────────────────────────────
# These two only appear when this ASIN is actually purchasable. Without them, every price on
# the page belongs to something else and none may be reported.
_ADD_TO_CART = re.compile(r'id="(?:add-to-cart-button|buy-now-button)"')
_DISPLAY = re.compile(r'"displayPrice"\s*:\s*"₹\s*([\d,.]+)"')

# ── The buybox price ────────────────────────────────────────────────────────────────────
# `apex_desktop` / `corePrice*` are the containers Amazon renders the buybox price into.
# Scoping to them is what keeps recommendation tiles out.
_CORE_BLOCK = re.compile(
    r'id="(?:apex_desktop|corePrice_feature_div|corePriceDisplay_desktop_feature_div)"'
    r'(.{0,6000}?)(?:id="(?:HLCXComparisonWidget|similarities_feature_div|sims-fbt)"|$)',
    re.S,
)
_PRICE_IN_BLOCK = re.compile(r'class="a-price-whole">\s*([\d,]+)')

# ── MRP ─────────────────────────────────────────────────────────────────────────────────
# Pinned to `apex-basisprice-value`. A looser `a-text-price` match is WRONG: the same page
# carries `apex-priceperunit-value`, which on B0GLNWPCPT is ₹50.17 (the per-100-pulls unit
# rate). That regex reported an MRP of 50.17 against a real 499 — a ~500% discount.
_MRP_MARKUP = re.compile(
    r'apex-basisprice-value[^>]*>\s*<span[^>]*class="a-offscreen">\s*₹\s*([\d,.]+)', re.I
)
_MRP_JSON = re.compile(
    r'"(?:basisPrice|strikePrice|listPrice)"[^{]{0,40}\{[^{}]{0,200}?"amount"\s*:\s*([\d.]+)',
    re.I,
)

# Scoped to the availability slot, NOT the whole page. "Currently unavailable" appears 3 times
# even on a perfectly in-stock listing, because it describes other variants in the selector.
_AVAILABILITY_BLOCK = re.compile(
    r'id="availability".{0,600}?(?:</div>|$)', re.S
)
_UNAVAILABLE_TEXT = re.compile(
    r"(?:Currently unavailable|We don't know when or if this item|not available)", re.I
)

# ── Rating ──────────────────────────────────────────────────────────────────────────────
# `acrPopover` / `acrCustomerReviewText` are the rating widget under the product title — this
# ASIN's own. NOT `a-icon-alt` "4.2 out of 5 stars": that text is on every recommendation tile
# too (a page carries ten or more of them, with different values).
_RATING = re.compile(r'id="acrPopover"[^>]*?title="([\d.]+) out of 5 stars"')
_RATING_COUNT = re.compile(r'id="acrCustomerReviewText"[^>]*?aria-label="([\d,]+) [A-Za-z ]*"')


def rating(html: str) -> tuple[float | None, int | None]:
    """(average stars, number of ratings) for this listing, or Nones when it has none yet."""
    stars = None
    m = _RATING.search(html)
    if m:
        value = float(m.group(1))
        stars = value if 0 < value <= 5 else None
    count = None
    m = _RATING_COUNT.search(html)
    if m:
        count = int(m.group(1).replace(",", ""))
    return stars, count


def _buybox_price(html: str) -> float | None:
    """The price for THIS ASIN, or None if the page is not offering one."""
    # `displayPrice` is the buybox's own JSON field and is absent when there is no offer,
    # which makes it both the most precise source and a reliable availability signal.
    m = _DISPLAY.search(html)
    if m:
        price = to_price(m.group(1))
        if price:
            return price

    # Fallback: `a-price-whole`, but only inside the core price container.
    block = _CORE_BLOCK.search(html)
    if block:
        hits = [to_price(h) for h in _PRICE_IN_BLOCK.findall(block.group(1))]
        hits = [h for h in hits if h]
        if hits:
            # Within the buybox the same figure repeats (whole/fraction, screen-reader copy).
            # Taking the most common guards against a stray neighbouring node.
            return max(set(hits), key=hits.count)
    return None


def _is_unavailable(html: str) -> bool:
    block = _AVAILABILITY_BLOCK.search(html)
    if block and _UNAVAILABLE_TEXT.search(block.group(0)):
        return True
    # No buy button anywhere means nothing on this page is purchasable.
    return not _ADD_TO_CART.search(html)


def parse(html: str, url: str) -> Cell:
    cell = _parse(html, url)
    cell.rating, cell.rating_count = rating(html)
    return cell


def _parse(html: str, url: str) -> Cell:
    price = _buybox_price(html)

    mrp = None
    for pattern in (_MRP_MARKUP, _MRP_JSON):
        m = pattern.search(html)
        if m:
            mrp = to_price(m.group(1))
            if mrp:
                break

    # An MRP below the selling price is never real — it means the wrong node was matched.
    if mrp is not None and price is not None and mrp < price:
        mrp = None

    if price is None:
        if _is_unavailable(html):
            # No price is reported, deliberately. The listing is not selling at any price, and
            # inventing one from elsewhere on the page is exactly the bug this adapter exists
            # to prevent.
            return Cell(
                marketplace="amazon",
                status=Status.OUT_OF_STOCK,
                mrp=mrp,
                url=url,
                note="no buybox — currently unavailable on Amazon",
            )
        return Cell(
            marketplace="amazon",
            status=Status.ERROR,
            url=url,
            note="buybox present but no price found — check the selectors",
        )

    # A buybox price on a page with no buy button is contradictory; trust the availability
    # signal and keep the price for reference rather than calling it live.
    if _is_unavailable(html):
        return Cell(
            marketplace="amazon",
            status=Status.OUT_OF_STOCK,
            price=price,
            mrp=mrp,
            url=url,
            note="listed but not currently purchasable",
        )

    return Cell(marketplace="amazon", status=Status.OK, price=price, mrp=mrp, url=url)
