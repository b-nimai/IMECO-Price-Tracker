"""Shared types.

The status vocabulary is the load-bearing idea in this codebase, so it lives here rather than
being spelled as bare strings at each call site.

The rule it enforces: ABSENT MUST NEVER BE RENDERABLE AS A VALUE. A blocked cell must not be
mistakable for a cheap price, and a delisted SKU must not be mistakable for a zero. Every other
design decision downstream — the None-not-0 discipline in the parser, the unshaded cells in the
heatmap — is this rule showing up again.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Status(str, Enum):
    """Why a cell does or does not have a price."""

    OK = "ok"
    """A live price was read. The only status that guarantees `price is not None`."""

    NOT_LISTED = "not_listed"
    """No URL in the spreadsheet — we never looked, because there is nothing to look at."""

    OUT_OF_STOCK = "out_of_stock"
    """Listing exists but cannot be bought. `price` may still be set: an OOS listing's price is
    real information (it is what the price WILL be), so we keep it rather than blanking it."""

    BLOCKED = "blocked"
    """Anti-bot defence won. We do not know the price, and there is no fallback to try."""

    ERROR = "error"
    """Fetched but could not parse, or the request failed. Almost always means the site changed
    its markup — which is exactly why this is distinct from BLOCKED."""


class Via(str, Enum):
    """How the HTML was obtained. Not shown on the dashboard.

    Only two values now that the paid unblocker is gone. The database still ALLOWS
    'brightdata' in its CHECK constraint so historical rows stay valid — nothing writes it."""

    DIRECT = "direct"
    NONE = "none"
    """No request was made at all — the SKU has no link for this marketplace."""


MARKETPLACES = ("amazon", "flipkart", "myntra", "blinkit")


@dataclass
class Cell:
    """One product on one marketplace, at one moment."""

    marketplace: str
    status: Status
    price: float | None = None
    mrp: float | None = None
    """As reported by THIS marketplace. Blinkit's MRPs differ from the spreadsheet's, because it
    carries its own pack configurations — so this is not redundant with `Product.mrp`."""
    unit: str | None = None
    """Pack configuration, e.g. "6 x 100 pulls". Only Blinkit reports one."""
    url: str | None = None
    via: Via = Via.NONE
    note: str | None = None
    """Human-readable detail for a non-OK status. Surfaced in the dashboard tooltip."""

    def __post_init__(self) -> None:
        # The invariant that makes the whole status vocabulary trustworthy. If this ever fires,
        # an adapter has reported success without actually finding a number.
        if self.status is Status.OK and self.price is None:
            raise ValueError(f"{self.marketplace}: status=ok requires a price")


@dataclass
class Product:
    """A row of the spreadsheet, normalised."""

    sku: str
    name: str
    mrp: float | None
    starred: bool
    """The U+2605 prefix on 24 of the 32 SKUs in column A. Preserved as data rather than
    discarded, since it appears to mark best-sellers."""
    urls: dict[str, str] = field(default_factory=dict)
    target_sp: dict[str, float] = field(default_factory=dict)
    """Intended selling price per marketplace, from the sheet. The `drift` colour metric is
    measured against this, so a marketplace missing here simply cannot be drift-shaded."""

    def url_for(self, marketplace: str) -> str | None:
        return self.urls.get(marketplace)
