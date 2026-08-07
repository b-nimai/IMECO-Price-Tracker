"""Getting HTML, politely, and unblocking it only if we ever have to.

  1. Direct httpx from this machine. Free, and the path every marketplace actually uses. It
     works because a staff PC has a residential IP — the same requests from a datacenter get
     blocked far more aggressively, which is the entire reason this runs on a desktop.
  2. Bright Data Web Unlocker — an OPTIONAL fallback that fires only when a direct fetch is
     refused. Dormant by default: with no key configured it simply reports `blocked`, and all
     four marketplaces currently succeed on tier 1, so it never runs.

Tier 2 is kept as insurance rather than a dependency. If Amazon or Flipkart start refusing
this IP, adding a key is the whole fix — but nothing needs it today.

Adapters never call this with a preference; `fetch_html` owns the routing so the policy lives
in exactly one place.
"""

from __future__ import annotations

import random
import re
import threading
import time

import httpx

from .budget import Budget
from .config import Settings
from .models import Status, Via

BRIGHTDATA_ENDPOINT = "https://api.brightdata.com/request"

#: Marketplaces to send straight to tier 2 without attempting a direct fetch.
#:
#: Empty, and that is the current correct state — all four marketplaces work directly. This
#: existed for Meesho, which was dropped: it is hard-blocked by Akamai (confirmed against
#: httpx, headless Chromium, headed Chromium, real Chrome with a persistent profile, mobile
#: user-agents and every api.* subdomain) and was not worth a paid unblocker for 19% of
#: listings that had no intended price to check against anyway.
ALWAYS_UNLOCK: set[str] = set()

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
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
}

#: Politeness window between two requests to the SAME host, seconds. Different hosts run in
#: parallel, so this does not multiply out across marketplaces.
THROTTLE = (4.0, 9.0)

MAX_RETRIES = 3
TIMEOUT = 45.0

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
    """Owns the HTTP clients, the throttle and the Bright Data key pool.

    One instance per run. Use as a context manager so connections are closed.
    """

    def __init__(self, settings: Settings, budget: Budget) -> None:
        self.settings = settings
        self.budget = budget
        self._throttle = _HostThrottle()
        self._client = httpx.Client(
            headers=HEADERS, follow_redirects=True, timeout=TIMEOUT
        )
        self._unlocker = httpx.Client(timeout=TIMEOUT + 60)
        # Index into the key pool. Advances only on quota exhaustion, so a single-key setup
        # (the expected case) never touches this.
        self._key_index = 0
        self.credits_used = 0

    def __enter__(self) -> "Fetcher":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()
        self._unlocker.close()

    # ── tier 1 ──────────────────────────────────────────────────────────────────────────

    def _direct(self, url: str) -> FetchResult:
        host = httpx.URL(url).host or url
        last_note = "no response"

        for attempt in range(MAX_RETRIES + 1):
            self._throttle.wait(host)
            try:
                response = self._client.get(url)
            except httpx.HTTPError as exc:
                last_note = f"{type(exc).__name__}: {exc}"
            else:
                text = response.text
                if response.status_code == 200:
                    if _BLOCK_MARKERS.search(text[:6000]):
                        return FetchResult(None, Via.DIRECT, Status.BLOCKED, "anti-bot page")
                    return FetchResult(text, Via.DIRECT)
                if response.status_code in (403, 429) or response.status_code >= 500:
                    last_note = f"HTTP {response.status_code}"
                    if response.status_code == 403:
                        # Not worth retrying an outright refusal — escalate instead.
                        return FetchResult(None, Via.DIRECT, Status.BLOCKED, last_note)
                else:
                    # 404 and friends are permanent and mean the listing is gone.
                    return FetchResult(
                        None, Via.DIRECT, Status.ERROR, f"HTTP {response.status_code}"
                    )

            if attempt < MAX_RETRIES:
                time.sleep(min(8.0, 1.5 * 2**attempt) + random.random())

        return FetchResult(None, Via.DIRECT, Status.BLOCKED, last_note)

    # ── tier 2 ──────────────────────────────────────────────────────────────────────────

    def _unlock(self, url: str) -> FetchResult:
        if not self.settings.can_unlock:
            return FetchResult(
                None, Via.NONE, Status.BLOCKED, "Bright Data not configured (missing zone)"
            )
        if not self.budget.allow():
            return FetchResult(
                None,
                Via.NONE,
                Status.BLOCKED,
                f"monthly credit ceiling reached ({self.budget.used}/{self.budget.ceiling})",
            )

        keys = self.settings.brightdata_keys
        payload = {
            "zone": self.settings.brightdata_zone,
            "url": url,
            "format": "raw",
            # These are .in storefronts; price and availability are geo-dependent, so the exit
            # node has to be Indian or the numbers are quietly wrong.
            "country": "in",
        }

        last_note = "no response"
        for _ in range(len(keys)):
            key = keys[self._key_index % len(keys)]
            try:
                response = self._unlocker.post(
                    BRIGHTDATA_ENDPOINT,
                    json=payload,
                    headers={
                        "Authorization": f"Bearer {key}",
                        "Content-Type": "application/json",
                    },
                )
            except httpx.HTTPError as exc:
                last_note = f"{type(exc).__name__}: {exc}"
                break

            if response.status_code == 200:
                self.credits_used += 1
                self.budget.spend()
                return FetchResult(response.text, Via.BRIGHTDATA)

            if response.status_code in (402, 429):
                # Quota exhausted on this key — try the next one in the pool.
                last_note = f"Bright Data HTTP {response.status_code} (quota)"
                self._key_index += 1
                continue

            last_note = f"Bright Data HTTP {response.status_code}: {response.text[:180]}"
            break

        return FetchResult(None, Via.BRIGHTDATA, Status.BLOCKED, last_note)

    # ── routing ─────────────────────────────────────────────────────────────────────────

    def fetch_html(self, marketplace: str, url: str) -> FetchResult:
        """Get a listing's HTML, escalating to Bright Data only where it is needed."""
        if marketplace in ALWAYS_UNLOCK:
            return self._unlock(url)

        result = self._direct(url)
        if result.ok or result.status is Status.ERROR:
            # ERROR means a definite 404-class answer; unlocking would not change it.
            return result

        # Blocked directly — worth one credit to find out if it is just our IP.
        escalated = self._unlock(url)
        if escalated.ok:
            return escalated
        # Report the cheaper failure's reason; the escalation note is usually less specific.
        return FetchResult(None, escalated.via, Status.BLOCKED, result.note or escalated.note)
