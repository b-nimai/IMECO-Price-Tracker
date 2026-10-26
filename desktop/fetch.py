"""Getting HTML, politely.

One tier: direct httpx from this machine. It works because a staff PC has a residential IP —
the same requests from a datacenter get blocked far more aggressively, which is the entire
reason this runs on a desktop rather than a cloud runner.

There used to be a second tier here: Bright Data's Web Unlocker, an optional paid escalation
for any fetch that came back refused. It has been REMOVED, not disabled. It never once fired —
all four marketplaces have always succeeded on the direct path — so it was a paid dependency,
a credit budget, a settings pair and ~80 lines of routing that existed purely to describe a
situation that has not happened.

If a marketplace does start refusing this IP, the honest failure is what happens now: those
cells report `blocked`, the dashboard leaves them unshaded, and someone decides what to do
about it. That is a better outcome than silently spending money to paper over it. Reintroducing
an unblocker later is a change to `_direct`'s failure branch and nothing else.
"""

from __future__ import annotations

import os
import random
import re
import threading
import time

import httpx

from .config import Settings
from .models import Status, Via
from .tls import SSL_CONTEXT

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)

HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-IN,en-US;q=0.9,en;q=0.8",
    # Brotli is deliberately excluded. Flipkart serves `br`, and httpx's decoder raises
    # "decoder process called with data when can_accept_more_data() is False" on their
    # response — the page is unreadable. gzip costs nothing and always works.
    "Accept-Encoding": "gzip, deflate",
    "sec-ch-ua": '"Chromium";v="141", "Not?A_Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    # Only correct for the FIRST request to a host — "none" means a navigation with no
    # referrer, i.e. a URL typed into the address bar. Every later request overrides it; see
    # `_navigation_headers`.
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
}

# ── Blinkit's delivery location ─────────────────────────────────────────────────────────
#
# Blinkit is HYPERLOCAL: both stock and price come from the dark store serving a delivery
# location, and with no location sent it answers as if nothing is deliverable.
#
# Measured across all 15 Blinkit listings, no-location vs Salt Lake Sector V:
#   * 11 of 15 gave a different answer.
#   * IMEBW72 read OutOfStock while the same page in Kolkata was in stock at ₹189.
#   * Two listings reported a WRONG PRICE — ₹449 for an item selling at ₹199, and ₹405 for one
#     at ₹189 — lifted from a recommendation tile because the product's own data was absent.
#     That fallback is gone (see adapters/blinkit.py); the location stops it arising at all.
#
# WHY THREE CITIES, TRIED IN ORDER: a dark store that has run out is not the same thing as a
# product IMECO no longer sells, but a single-city check cannot tell those apart — one empty
# Kolkata store paints the cell red. Asking Bengaluru and then Mumbai answers the question the
# board is really being asked: is this listing live and at what price. Kolkata is first because
# it is the home market, so its price wins whenever it has stock.
#
# The search STOPS at the first point with stock, so a listing that is in stock at the home
# store costs exactly one request. Only genuinely-unavailable listings pay for the whole walk,
# and `Cell.note` records which CITY answered so a price from Mumbai is never mistaken for a
# local one.
#
# WHY FOUR POINTS INSIDE KOLKATA, and not one: Blinkit answers per DARK STORE, not per city, and
# the stores do not carry the same catalogue. The single Kolkata point used until now (Salt Lake,
# 22.5726/88.4310) sat on one of the thinner ones, and the board carried its gaps as fact.
#
# Measured against every Blinkit listing that was not live from that point:
#   IMEGHFTB100-PP1   Salt Lake: no store carries it   Dum Dum: IN STOCK ₹99    Behala: ₹99
#   IMEFTCNP2_600     Salt Lake: out of stock          Dum Dum: IN STOCK ₹189   Behala: ₹189
#   IMEFTCNP600       Salt Lake: out of stock          Dum Dum: IN STOCK ₹189   Behala: ₹189
#   IMEBPB1           out of stock everywhere in Kolkata — a real absence, correctly reported
#
# Three of four "out of stock in Kolkata" cells were an artefact of WHERE we stood. Dum Dum
# leads because it recovered every one of them and is the operator's own location, so the board
# now agrees with what they see in their own browser.
#
# The city labels are deliberately all "Kolkata": which dark store answered is our business, not
# the board's, and `run.py` only annotates a price when the CITY differs from home.
BLINKIT_LOCATIONS: tuple[tuple[str, dict[str, str]], ...] = (
    # Home. Overridable by env for anyone running this from another neighbourhood.
    ("Kolkata", {"lat": os.environ.get("BLINKIT_LAT", "22.6420"),
                 "lon": os.environ.get("BLINKIT_LON", "88.4212")}),   # Dum Dum
    ("Kolkata", {"lat": "22.5250", "lon": "88.3650"}),                # Ballygunge
    ("Kolkata", {"lat": "22.4986", "lon": "88.3140"}),                # Behala
    ("Kolkata", {"lat": "22.5726", "lon": "88.4310"}),                # Salt Lake
    ("Bengaluru", {"lat": "12.9716", "lon": "77.5946"}),
    ("Mumbai", {"lat": "19.0760", "lon": "72.8777"}),
)

_MARKETPLACE_HEADERS: dict[str, dict[str, str]] = {
    "blinkit": BLINKIT_LOCATIONS[0][1],
}

#: Politeness window between two requests to the SAME host, seconds. Different hosts run in
#: parallel, so this does not multiply out across marketplaces.
#:
#: This is now the ONLY thing standing between the app and a block, since there is no paid
#: fallback behind it. Shortening it to make runs finish faster is a false economy.
THROTTLE = (4.0, 9.0)

MAX_RETRIES = 3
TIMEOUT = 45.0

#: How long to wait after an anti-bot page, seconds. Deliberately much longer than the ordinary
#: retry backoff: the CAPTCHA is not an error, it is Amazon asking us to slow down, and the one
#: thing that reliably clears it is time. Measured on this machine, a listing that answered with
#: the robot check returned a full 2.1 MB product page on the next attempt.
BLOCK_BACKOFF = (15.0, 30.0)

#: How many of those long waits one listing may buy. Just one, on purpose. A sporadic CAPTCHA
#: clears on the very next attempt; a marketplace that has genuinely decided to refuse this IP
#: will refuse all 42 listings, and three long waits each would turn a 10-minute run into an
#: hour of sleeping to reach the same `blocked` cells. One retry catches the common case and
#: keeps the honest failure fast.
BLOCK_RETRIES = 1

# ── Looking like a navigation, not a script ─────────────────────────────────────────────
#
# Two things were wrong with how these requests presented themselves. Measured against
# Amazon, same machine, same throttle, one product URL, interleaved arms so time of day
# cannot explain the gap:
#
#   sec-fetch-site: none on EVERY request     5 of 14 answered with the robot check
#   none first, then same-origin + Referer    1 of 14
#
# Nobody navigates to forty product pages in a row by typing each URL into the address bar.
# After the first page of a session a browser sends `sec-fetch-site: same-origin` and a
# `Referer`, because you got there by clicking. So does this now.
#
# COOKIES ARE ALREADY HANDLED — httpx.Client persists them across requests by itself, and
# that is load-bearing, not incidental: Amazon's Akamai cookies (`ak_bmsc`, `bm_sv`) are set
# by the robot-check page itself, and carrying them is what gets the next request through.
# Clearing the jar per request was measured at 5 of 6 blocked. Do not "fix" it by clearing.

#: Signals that a 200 is really a defence page rather than a product. Checked before parsing,
#: so "blocked" never gets misfiled as "the parser broke".
_BLOCK_MARKERS = re.compile(
    r"(?:Enter the characters you see below|api-services-support@amazon\.com"
    r"|Access Denied|Request unsuccessful|captcha-delivery|/errors/500\.html"
    r"|Robot Check|unusual traffic from your computer)",
    re.I,
)


class FetchResult:
    __slots__ = ("html", "via", "status", "note")

    def __init__(
        self,
        html: str | None,
        via: Via,
        status: Status | None = None,
        note: str | None = None,
    ) -> None:
        self.html = html
        self.via = via
        #: Set only on failure. None means "HTML retrieved, go parse it".
        self.status = status
        self.note = note

    @property
    def ok(self) -> bool:
        return self.html is not None and self.status is None


class _HostThrottle:
    """Enforces a minimum gap between requests to one host, across threads."""

    def __init__(self) -> None:
        self._last: dict[str, float] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def _lock_for(self, host: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(host, threading.Lock())

    def wait(self, host: str) -> None:
        with self._lock_for(host):
            gap = random.uniform(*THROTTLE)
            elapsed = time.monotonic() - self._last.get(host, 0.0)
            if elapsed < gap:
                time.sleep(gap - elapsed)
            self._last[host] = time.monotonic()


class Fetcher:
    """Owns the HTTP client and the per-host throttle.

    One instance per run. Use as a context manager so connections are closed.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._throttle = _HostThrottle()
        #: Hosts this run has already requested something from. Guards the first-request-only
        #: `sec-fetch-site: none`; the lock is because marketplaces run on separate threads.
        self._seen_hosts: set[str] = set()
        self._seen_guard = threading.Lock()
        # The client keeps one cookie jar for the whole run on purpose — see the note above
        # `_navigation_headers`.
        self._client = httpx.Client(
            headers=HEADERS, follow_redirects=True, timeout=TIMEOUT, verify=SSL_CONTEXT
        )

    def __enter__(self) -> "Fetcher":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def _navigation_headers(self, url: str, host: str) -> dict[str, str]:
        """Make request N of a session look like a click, not a fresh address-bar entry.

        The first request to a host keeps the class-level `sec-fetch-site: none`. Every one
        after it claims the site's own home page as its referrer, which is what a browser
        sends once you are actually browsing.
        """
        with self._seen_guard:
            first = host not in self._seen_hosts
            self._seen_hosts.add(host)
        if first:
            return {}
        parsed = httpx.URL(url)
        return {
            "sec-fetch-site": "same-origin",
            "Referer": f"{parsed.scheme}://{host}/",
        }

    def fetch_html(
        self, marketplace: str, url: str, context: dict[str, str] | None = None
    ) -> FetchResult:
        """Get a listing's HTML.

        `context` overrides the marketplace's default extra headers — used to ask Blinkit the
        same page from a different delivery location.
        """
        extra = context if context is not None else _MARKETPLACE_HEADERS.get(marketplace)
        host = httpx.URL(url).host or url
        last_note = "no response"

        # Set when the last failure was an anti-bot page rather than a transport error, so the
        # next sleep can be the long one.
        soft_blocked = False
        block_attempts = 0

        for attempt in range(MAX_RETRIES + 1):
            self._throttle.wait(host)
            soft_blocked = False
            # `extra` carries Blinkit's delivery location; the navigation headers are layered
            # on top and never collide with it.
            headers = {**(extra or {}), **self._navigation_headers(url, host)}
            try:
                response = self._client.get(url, headers=headers)
            except httpx.HTTPError as exc:
                last_note = f"{type(exc).__name__}: {exc}"
            else:
                text = response.text
                if response.status_code == 200:
                    if _BLOCK_MARKERS.search(text[:6000]):
                        # Not terminal. Amazon serves this sporadically — often on the first
                        # request of a run, on a cold connection — and the same URL answers
                        # normally moments later. Returning BLOCKED here on the first sighting
                        # is what put a striped cell on listings that were perfectly fetchable;
                        # so wait it out and ask again.
                        last_note = "anti-bot page"
                        soft_blocked = True
                    else:
                        return FetchResult(text, Via.DIRECT)
                elif response.status_code in (403, 429) or response.status_code >= 500:
                    last_note = f"HTTP {response.status_code}"
                    # 403 and 429 are the same request being refused, just louder — give them
                    # the long wait too rather than hammering through the short backoff.
                    soft_blocked = response.status_code in (403, 429)
                else:
                    # 404 and friends are permanent and mean the listing is gone.
                    return FetchResult(
                        None, Via.DIRECT, Status.ERROR, f"HTTP {response.status_code}"
                    )

            if soft_blocked:
                if block_attempts >= BLOCK_RETRIES:
                    break
                block_attempts += 1
                time.sleep(random.uniform(*BLOCK_BACKOFF))
            elif attempt < MAX_RETRIES:
                time.sleep(min(8.0, 1.5 * 2**attempt) + random.random())

        return FetchResult(None, Via.DIRECT, Status.BLOCKED, last_note)
