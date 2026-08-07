"""Writing results to Supabase, over PostgREST.

Uses plain HTTP rather than the supabase-py SDK: the calls needed here are three POSTs and a
PATCH, and PyInstaller has a much easier time with httpx than with the SDK's dependency tree.

Ordering is deliberate — the `runs` row is opened first and closed last, so a crashed run
leaves `finished_at IS NULL`. The dashboard ignores unfinished runs, which is what stops a
half-written scrape from being read as the current picture.
"""

from __future__ import annotations

from typing import Any

import httpx

from .config import Settings
from .models import Cell, Product, Status

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

    def sync_products(self, products: list[Product]) -> None:
        """Mirror the spreadsheet into `products`. Upsert, so re-running is harmless."""
        rows = [
            {
                "sku": p.sku,
                "name": p.name,
                "mrp": p.mrp,
                "starred": p.starred,
                "target_sp": p.target_sp,
                "urls": p.urls,
                "updated_at": "now()",
            }
            for p in products
        ]
        for i in range(0, len(rows), CHUNK):
            self._post("products", rows[i : i + CHUNK], upsert=True)

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
        observes a partially-populated run."""
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
            }
            for sku, cell in results
        ]
        written = 0
        for i in range(0, len(rows), CHUNK):
            self._post("price_snapshots", rows[i : i + CHUNK])
            written += len(rows[i : i + CHUNK])
        return written
