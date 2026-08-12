"""Per-marketplace price parsers.

Every adapter is `parse(html, url) -> Cell` and does nothing else. It never fetches, so the
same parser serves both a direct response and an unblocked one — how the HTML arrived is
`fetch.py`'s concern.

Adapters must never raise. A page they cannot read is `Status.ERROR` with a note, because
that is a signal worth seeing on the dashboard: it almost always means the site redesigned and
the selector needs updating.
"""

from __future__ import annotations

from collections.abc import Callable

from ..models import Cell
from . import amazon, blinkit, flipkart

# No myntra entry: the marketplace was dropped. `myntra.py` is kept on disk, unimported, so
# putting the column back is a two-line change rather than a rewrite of the parser.
PARSERS: dict[str, Callable[[str, str], Cell]] = {
    "amazon": amazon.parse,
    "flipkart": flipkart.parse,
    "blinkit": blinkit.parse,
}

__all__ = ["PARSERS", "amazon", "blinkit", "flipkart"]
