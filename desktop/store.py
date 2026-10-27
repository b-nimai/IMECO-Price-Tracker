"""Writing results to Supabase, over PostgREST.

Uses plain HTTP rather than the supabase-py SDK: the calls needed here are three POSTs and a
PATCH, and PyInstaller has a much easier time with httpx than with the SDK's dependency tree.

Ordering is deliberate — the `runs` row is opened first and closed last, so a crashed run
leaves `finished_at IS NULL`. The dashboard ignores unfinished runs, which is what stops a
half-written scrape from being read as the current picture.
"""

from __future__ import annotations

from collections.abc import Callable

from datetime import datetime
from typing import Any

import httpx

from .config import Settings
from .models import Cell, LocationCheck, Product, Status
from .search import SearchResult
from .tls import SSL_CONTEXT

TIMEOUT = 60.0
#: PostgREST rejects very large payloads; 110 rows fits comfortably in one request but the
#: catalogue upsert is chunked anyway so this does not become a limit later.
CHUNK = 250


class Store:
    def __init__(self, settings: Settings) -> None:
        if not settings.can_store:
            raise RuntimeError("Supabase is not configured (need URL + service_role key)")
        self._base = f"{settings.supabase_url}/rest/v1"
        self._client = httpx.Client(
            timeout=TIMEOUT,
            verify=SSL_CONTEXT,
            headers={
                "apikey": settings.supabase_service_key,
                "Authorization": f"Bearer {settings.supabase_service_key}",
                "Content-Type": "application/json",
            },
        )

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc: object) -> None:
        self._client.close()

    def close(self) -> None:
        self._client.close()

    def _post(self, table: str, rows: list[dict[str, Any]], *, upsert: bool = False) -> Any:
        prefer = "return=representation"
        if upsert:
            prefer = f"resolution=merge-duplicates,{prefer}"
        response = self._client.post(
            f"{self._base}/{table}", json=rows, headers={"Prefer": prefer}
        )
        if response.status_code >= 400:
            raise RuntimeError(f"{table} write failed [{response.status_code}]: {response.text[:300]}")
        return response.json()

    # ── catalogue ───────────────────────────────────────────────────────────────────────

    def sync_products(self, products: list[Product]) -> set[str]:
        """Mirror the spreadsheet into `products`. Upsert, so re-running is harmless.

        `position` carries the sheet's row order through to the dashboard, which sorts on it;
        `brand` / `competitor_of` mark the rows from the Competitors sheet. All three were added
        after this app shipped, so a database that has not had the migration in
        supabase/schema.sql applied is still written to — without the ordering, and WITHOUT the
        competitors at all: a competitor written to a table that cannot say it is one would land
        on the wall display as an IMECO product. An un-migrated database should lose features,
        not the scrape, and never gain a wrong row.

        Returns the SKUs actually stored, so the caller writes snapshots only for those — a
        snapshot for a product that is not in the table would fail the whole run on its
        foreign key.
        """
        rows = [
            {
                "sku": p.sku,
                "name": p.name,
                "mrp": p.mrp,
                "starred": p.starred,
                "position": p.position,
                "target_sp": p.target_sp,
                "urls": p.urls,
                "brand": p.brand,
                "competitor_of": p.competitor_of,
                "updated_at": "now()",
            }
            for p in products
        ]

        degraded = False
        for _ in range(3):  # at most: drop competitors, then drop position
            try:
                for i in range(0, len(rows), CHUNK):
                    self._post("products", rows[i : i + CHUNK], upsert=True)
                break
            except RuntimeError as exc:
                message = str(exc)
                if ("brand" in message or "competitor_of" in message) and "brand" in rows[0]:
                    rows = [
                        {k: v for k, v in r.items() if k not in ("brand", "competitor_of")}
                        for r in rows
                        if r["competitor_of"] is None
                    ]
                elif "position" in message and "position" in rows[0]:
                    for row in rows:
                        row.pop("position")
                    degraded = True
                else:
                    raise
        else:
            raise RuntimeError("products write failed after dropping unmigrated columns")

        stored = {r["sku"] for r in rows}
        if not degraded:
            self._demote_missing(sorted(stored))
        return stored

    def _demote_missing(self, skus: list[str]) -> None:
        """Null the position of every product the sheet no longer lists.

        Nothing is deleted — the snapshots of a withdrawn SKU are still history worth keeping,
        and a delete would cascade them away. But a stale row must not keep a position it no
        longer earns, or it would sit in the middle of the sheet's order forever. The dashboard
        sorts nulls last, so these collect at the bottom of the board.
        """
        if not skus:
            return
        in_list = ",".join(f'"{s}"' for s in skus)
        response = self._client.patch(
            f"{self._base}/products",
            params={"sku": f"not.in.({in_list})", "position": "not.is.null"},
            json={"position": None},
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"products reorder failed [{response.status_code}]: {response.text[:300]}"
            )

    # ── runs ────────────────────────────────────────────────────────────────────────────

    def start_run(self, source: str = "manual") -> str:
        rows = self._post("runs", [{"source": source}])
        return rows[0]["id"]

    def finish_run(self, run_id: str, cells: list[Cell]) -> None:
        counts = {
            "ok_count": sum(c.status in (Status.OK, Status.OUT_OF_STOCK) for c in cells),
            "error_count": sum(c.status is Status.ERROR for c in cells),
            "blocked_count": sum(c.status is Status.BLOCKED for c in cells),
            "finished_at": "now()",
        }
        response = self._client.patch(
            f"{self._base}/runs", params={"id": f"eq.{run_id}"}, json=counts
        )
        if response.status_code >= 400:
            raise RuntimeError(f"run close failed [{response.status_code}]: {response.text[:300]}")

    # ── snapshots ───────────────────────────────────────────────────────────────────────

    def save_snapshots(self, run_id: str, results: list[tuple[str, Cell]]) -> int:
        """`results` is (sku, cell) pairs. Written in one request so the dashboard never
        observes a partially-populated run.

        `rating` / `rating_count` were added to the schema after this app shipped. A database
        that has not had that migration applied is still written to, without them — the same
        deliberate degradation as `position` in `sync_products`: a pending migration must cost
        the ratings, never the prices.
        """
        rows = [
            {
                "run_id": run_id,
                "sku": sku,
                "marketplace": cell.marketplace,
                "price": cell.price,
                "mrp": cell.mrp,
                "unit": cell.unit,
                "status": cell.status.value,
                "via": cell.via.value,
                "note": cell.note,
                "rating": cell.rating,
                "rating_count": cell.rating_count,
            }
            for sku, cell in results
        ]
        written = 0
        for i in range(0, len(rows), CHUNK):
            chunk = rows[i : i + CHUNK]
            try:
                self._post("price_snapshots", chunk)
            except RuntimeError as exc:
                if "rating" not in str(exc):
                    raise
                for row in rows:
                    row.pop("rating", None)
                    row.pop("rating_count", None)
                self._post("price_snapshots", chunk)
            written += len(chunk)
        return written

    def save_availability(self, run_id: str, checks: list[LocationCheck]) -> int:
        """Every Blinkit dark store's answer for every listing — the Availability tab's data.

        Raises RuntimeError if the `availability_checks` table does not exist yet; the caller
        treats that as a warning, not a failed run.
        """
        rows = [
            {
                "run_id": run_id,
                "sku": c.sku,
                "marketplace": c.cell.marketplace,
                "city": c.city,
                "area": c.area,
                "lat": c.lat,
                "lon": c.lon,
                "status": c.cell.status.value,
                "price": c.cell.price,
                "note": c.cell.note,
            }
            for c in checks
        ]
        for i in range(0, len(rows), CHUNK):
            self._post("availability_checks", rows[i : i + CHUNK])
        return len(rows)

    # ── search ranks ────────────────────────────────────────────────────────────────────

    def last_search_at(self) -> datetime | None:
        """When the daily keyword search last ran, or None if never. Raises RuntimeError if the
        `search_results` table does not exist yet."""
        response = self._client.get(
            f"{self._base}/search_results",
            params={"select": "checked_at", "order": "checked_at.desc", "limit": "1"},
        )
        if response.status_code >= 400:
            raise RuntimeError(f"search_results read failed [{response.status_code}]")
        rows = response.json()
        return datetime.fromisoformat(rows[0]["checked_at"]) if rows else None

    def save_search(
        self,
        run_id: str,
        results: list[SearchResult],
        stored: set[str],
        on_chunk: Callable[[], None] | None = None,
    ) -> int:
        """One row per search result. `stored` is the SKUs actually in `products`: a match to
        anything else (a competitor an un-migrated database refused) is dropped rather than
        failing the whole write on its foreign key."""
        rows = [
            {
                "run_id": run_id,
                "keyword": r.keyword,
                "marketplace": r.marketplace,
                "position": r.position,
                "listing_id": r.listing_id,
                "title": r.title[:300],
                "brand": r.brand,
                "matched_sku": r.matched_sku if r.matched_sku in stored else None,
                "price": r.price,
                "sponsored": r.sponsored,
            }
            for r in results
        ]
        for i in range(0, len(rows), CHUNK):
            self._post("search_results", rows[i : i + CHUNK])
            if on_chunk:
                on_chunk()
        return len(rows)
