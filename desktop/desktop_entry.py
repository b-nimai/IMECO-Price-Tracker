"""PyInstaller entry point.

A frozen build has no package context, so `python -m desktop.app` is not available — this
script gives PyInstaller a plain module to start from and fixes up the paths a bundle needs.
"""

from __future__ import annotations

import sys
from pathlib import Path

# When frozen, resources live in the temporary extraction directory PyInstaller sets up.
# `catalogue.WORKBOOK` resolves relative to the source tree, which does not exist in a bundle,
# so it is repointed here before anything imports it.
if getattr(sys, "frozen", False):
    bundle = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    sys.path.insert(0, str(bundle))

    from desktop import catalogue, config

    catalogue.WORKBOOK = bundle / "Docs" / "pricing link.xlsx"
    # Secrets come from Credential Manager in a frozen build. Point the .env fallback beside
    # the .exe so an operator *can* drop one there if Credential Manager is unavailable.
    config.ENV_FILE = Path(sys.executable).parent / ".env"
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from desktop.app import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
