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

import random
import re
import threading
import time

import httpx

from .config import Settings
from .models import Status, Via

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
#:
#: This is now the ONLY thing standing between the app and a block, since there is no paid
#: fallback behind it. Shortening it to make runs finish faster is a false economy.
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
    """Owns the HTTP client and the per-host throttle.

    One instance per run. Use as a context manager so connections are closed.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._throttle = _HostThrottle()
        self._client = httpx.Client(headers=HEADERS, follow_redirects=True, timeout=TIMEOUT)

    def __enter__(self) -> "Fetcher":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def fetch_html(self, marketplace: str, url: str) -> FetchResult:
        """Get a listing's HTML.

        `marketplace` is unused now that there is one path for every host. It stays in the
        signature because it is the natural place for any future per-marketplace policy, and
        because every call site already passes it.
        """
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
                        # An outright refusal will not change on a retry.
                        return FetchResult(None, Via.DIRECT, Status.BLOCKED, last_note)
                else:
                    # 404 and friends are permanent and mean the listing is gone.
                    return FetchResult(
                        None, Via.DIRECT, Status.ERROR, f"HTTP {response.status_code}"
                    )

            if attempt < MAX_RETRIES:
                time.sleep(min(8.0, 1.5 * 2**attempt) + random.random())

        return FetchResult(None, Via.DIRECT, Status.BLOCKED, last_note)
