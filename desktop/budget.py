"""Bright Data credit guard.

Bright Data is an OPTIONAL fallback that nothing currently uses — all four marketplaces fetch
directly, so expected spend is zero. This module exists for the case where that stops being
true.

If a marketplace starts refusing this IP and every fetch escalates, ~77 listings x 24 runs/day
is ~55,000 requests/month against a 5,000 free tier — the hourly cadence would burn the whole
free allowance inside three days and then start billing. Past the ceiling, unlocking is refused
and the affected cells report `blocked`. A visibly degraded dashboard is a much better failure
than a surprise invoice, and this guard matters considerably more at hourly than it did at
three runs a day.

Usage is counted locally rather than queried from Bright Data, because there is no cheap API
for remaining balance and an extra call per run to find out would itself cost.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

STATE_DIR = Path(__file__).resolve().parent / ".state"
STATE_FILE = STATE_DIR / "budget.json"

FREE_TIER = 5_000
#: 90% of free. The headroom absorbs the gap between our count and Bright Data's, which can
#: drift if a request is billed that we did not record as successful.
DEFAULT_CEILING = 4_500


class Budget:
    """Tracks credits spent this calendar month, persisted across runs."""

    def __init__(self, ceiling: int = DEFAULT_CEILING, path: Path | None = None) -> None:
        self.ceiling = ceiling
        self._path = path or STATE_FILE
        self._period, self.used = self._load()

    # Bright Data's free credits renew on the 1st, so the local counter resets on the same
    # boundary. Any other period would drift out of step with the thing being budgeted.
    @staticmethod
    def _current_period() -> str:
        return date.today().strftime("%Y-%m")

    def _load(self) -> tuple[str, int]:
        period = self._current_period()
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return period, 0
        if data.get("period") != period:
            return period, 0  # new month, fresh allowance
        return period, int(data.get("used", 0))

    def save(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            # Write-then-rename: a crash mid-write must not leave a corrupt counter that
            # reads as zero and hands out another 4,500 credits.
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(
                json.dumps({"period": self._period, "used": self.used}, indent=2),
                encoding="utf-8",
            )
            tmp.replace(self._path)
        except OSError:
            pass  # a lost counter is not worth failing a run over

    def allow(self) -> bool:
        return self.used < self.ceiling

    def spend(self, n: int = 1) -> None:
        self.used += n

    @property
    def remaining(self) -> int:
        return max(0, self.ceiling - self.used)
