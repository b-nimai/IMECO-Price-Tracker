"""Where secrets come from.

Sources, in priority order:

  1. Windows Credential Manager (via `keyring`) — set by the app's first-run prompt.
  2. A real environment variable — for CI and one-offs.
  3. A `.env` file — development convenience when running from source.
  4. Secrets baked in at build time — the last-resort fallback, so a freshly copied .exe
     starts working without a setup prompt.

The ordering matters. The Supabase service_role key can write to the database, so a baked-in
copy is recoverable from the .exe by anyone holding the file: treat any build made with baked
secrets as internal-only, and rotate the key in Supabase if such a build ever leaves IMECO.
Credential Manager remains the preferred source and always wins over the baked value.
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


def _from_baked(name: str) -> str | None:
    """Secrets written into the bundle by build.ps1, if that build had any.

    `desktop/_baked.py` is generated immediately before PyInstaller runs and deleted
    immediately after, so it exists on disk for the length of a build and never at rest. In a
    source checkout this import simply fails and the function returns None.
    """
    try:
        from . import _baked  # type: ignore[attr-defined]

        return getattr(_baked, name, None)
    except Exception:
        return None


@dataclass
class Settings:
    supabase_url: str
    supabase_service_key: str

    @property
    def can_store(self) -> bool:
        return bool(self.supabase_url and self.supabase_service_key)

    def missing(self) -> list[str]:
        """Which settings still need a value — drives the first-run setup prompt."""
        out = []
        if not self.supabase_url:
            out.append("SUPABASE_URL")
        if not self.supabase_service_key:
            out.append("SUPABASE_SERVICE_KEY")
        return out


def load_settings() -> Settings:
    env = _load_env_file()

    def get(name: str) -> str:
        # Credential Manager wins; a real env var beats the .env file, for CI and one-offs;
        # a baked-in build secret is the floor, so a copied .exe runs without being set up.
        return (
            _from_keyring(name)
            or os.environ.get(name)
            or env.get(name)
            or _from_baked(name)
            or ""
        ).strip()

    return Settings(
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
