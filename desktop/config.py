"""Where secrets come from.

Two sources, in priority order:

  1. Windows Credential Manager (via `keyring`) — what the packaged .exe uses.
  2. A `.env` file — development convenience when running from source.

The ordering matters. The Supabase service_role key can write to the database, so it must not
be compiled into a distributed .exe where anyone could pull it out with a hex editor. Credential
Manager keeps it per-machine and per-user instead.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

SERVICE = "IMECO Price Tracker"
"""Credential Manager service name — how the stored secrets are grouped."""

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"

_FIELDS = (
    "BRIGHTDATA_API_KEYS",
    "BRIGHTDATA_ZONE",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_KEY",
)


def _load_env_file() -> dict[str, str]:
    """Minimal .env reader. Avoids a python-dotenv dependency for ~15 lines of parsing."""
    values: dict[str, str] = {}
    if not ENV_FILE.exists():
        return values
    for line in ENV_FILE.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, raw = line.partition("=")
        values[key.strip()] = raw.strip().strip('"').strip("'")
    return values


def _from_keyring(name: str) -> str | None:
    try:
        import keyring

        return keyring.get_password(SERVICE, name)
    except Exception:
        # keyring missing, or no Windows credential backend available. Not an error — the
        # .env fallback covers development, and first-run setup will prompt.
        return None


@dataclass
class Settings:
    brightdata_keys: list[str]
    brightdata_zone: str
    supabase_url: str
    supabase_service_key: str

    @property
    def can_unlock(self) -> bool:
        """Whether the optional Bright Data fallback is available.

        Expected to be False. All four marketplaces fetch directly; this only matters if one
        of them starts refusing this IP."""
        return bool(self.brightdata_keys and self.brightdata_zone)

    @property
    def can_store(self) -> bool:
        return bool(self.supabase_url and self.supabase_service_key)

    def missing(self) -> list[str]:
        """Which REQUIRED settings still need a value — drives the first-run setup prompt.

        Bright Data is deliberately not listed: it is an optional fallback, and prompting for
        it would imply the app cannot run without it."""
        out = []
        if not self.supabase_url:
            out.append("SUPABASE_URL")
        if not self.supabase_service_key:
            out.append("SUPABASE_SERVICE_KEY")
        return out


def load_settings() -> Settings:
    env = _load_env_file()

    def get(name: str) -> str:
        # Credential Manager wins; a real env var beats the .env file, for CI and one-offs.
        return (_from_keyring(name) or os.environ.get(name) or env.get(name) or "").strip()

    raw_keys = get("BRIGHTDATA_API_KEYS")
    return Settings(
        brightdata_keys=[k.strip() for k in raw_keys.split(",") if k.strip()],
        brightdata_zone=get("BRIGHTDATA_ZONE"),
        supabase_url=get("SUPABASE_URL").rstrip("/"),
        supabase_service_key=get("SUPABASE_SERVICE_KEY"),
    )


def save_setting(name: str, value: str) -> bool:
    """Persist one secret to Credential Manager. False if no backend is available."""
    if name not in _FIELDS:
        raise ValueError(f"unknown setting: {name}")
    try:
        import keyring

        keyring.set_password(SERVICE, name, value)
        return True
    except Exception:
        return False
