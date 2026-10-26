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


# Myntra was dropped — its prices are no longer wanted, so it is not scraped. The database
# CHECK constraint still ALLOWS 'myntra' so historical snapshots stay valid; nothing writes it.
# Mirrors src/data/types.ts — the two must stay in step.
MARKETPLACES = ("amazon", "flipkart", "blinkit")


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
    rating: float | None = None
    """Average star rating, 0-5, as THIS listing shows it. Amazon and Flipkart only."""
    rating_count: int | None = None
    """How many ratings that average is over. None when the page did not say."""

    def __post_init__(self) -> None:
        # The invariant that makes the whole status vocabulary trustworthy. If this ever fires,
        # an adapter has reported success without actually finding a number.
        if self.status is Status.OK and self.price is None:
            raise ValueError(f"{self.marketplace}: status=ok requires a price")


@dataclass
class LocationCheck:
    """One Blinkit listing as ONE dark store answers it.

    The board's cell keeps asking "is this live anywhere, and at what price" (see
    `run._fetch_blinkit`). These rows answer the question the board cannot: WHERE it is live.
    Written to `availability_checks`, never to `price_snapshots`.
    """

    sku: str
    city: str
    area: str
    lat: float
    lon: float
    cell: Cell


@dataclass
class Product:
    """A row of the spreadsheet, normalised."""

    sku: str
    name: str
    mrp: float | None
    starred: bool
    """The U+2605 prefix on 24 of the 32 SKUs in column A. Preserved as data rather than
    discarded, since it appears to mark best-sellers."""
    position: int = 0
    """This product's row order in the spreadsheet, counting only parsed rows.

    The dashboard sorts on it, so the board reads top-to-bottom in the same order as the sheet
    the operator maintains. That is the whole reason it is carried: without it the grid imposed
    its own ordering and no row could be found by looking where it sits in the workbook."""
    urls: dict[str, str] = field(default_factory=dict)
    target_sp: dict[str, float] = field(default_factory=dict)
    """Intended selling price per marketplace, from the sheet. The `drift` colour metric is
    measured against this, so a marketplace missing here simply cannot be drift-shaded."""
    brand: str = "IMECO"
    """Whose product this is. Everything on the IMECO sheet is IMECO's; rows from the
    "Competitors" sheet carry the brand typed there."""
    competitor_of: str | None = None
    """For a competitor: the IMECO SKU it is compared against. None for IMECO's own products —
    which is how the dashboard keeps competitors off the wall display."""
    keywords: list[str] = field(default_factory=list)
    """Search keywords typed in this product's "Keywords" cell, for the daily search."""

    def url_for(self, marketplace: str) -> str | None:
        return self.urls.get(marketplace)
