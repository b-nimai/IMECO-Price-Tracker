"""Windows Scheduled Task registration.

The dashboard is only as fresh as the last run, so relying purely on someone remembering to
open the app means the board goes stale over a weekend. This registers the same executable to
run itself on a repeating interval whenever the PC is on — manual "Run now" still works and is
unaffected.

Uses `schtasks` rather than the `pywin32` COM API: no extra dependency, and it is far easier to
inspect or remove by hand if something goes wrong (`schtasks /Query /TN "IMECO Price Tracker"`).

WHY HOURLY, AND WHY NOT FASTER
------------------------------
One repeating task replaced the old three-a-day fixed times (09:00 / 14:00 / 18:00). A run
touches ~77 listings and finishes in roughly four minutes, so an hourly cadence leaves the
machine idle ~93% of the time and the board is never more than an hour behind.

MIN_INTERVAL_MINUTES is 30, and that floor is about the marketplaces rather than this PC.
Requests to one host are serialised behind a 4-9s throttle (`fetch.py`), so Amazon — the
largest and least forgiving column, 32 listings — already sees a request every few seconds for
~3.5 minutes per run. Hourly puts that at ~770 Amazon requests/day from one residential IP,
which is quiet enough to have never tripped a defence page. Halving the interval doubles that;
below 30 minutes the runs start overlapping their own throttle windows and the request pattern
stops looking like a person. If a shorter interval is ever wanted, watch `blocked_count` on the
`runs` table for a run or two before leaving it there — a blocked scrape is worse than an
hour-old price, because it removes the number from the wall entirely.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

TASK_NAME = "IMECO Price Tracker"

#: How often the scrape repeats, in minutes. 60 is the intended cadence.
DEFAULT_INTERVAL_MINUTES = 60

#: Below this, request rates stop being polite — see the module docstring.
MIN_INTERVAL_MINUTES = 30

#: The three fixed daily times this module used to register. Kept only so `unregister()` can
#: clean them off machines that were set up before the switch to a repeating task.
_LEGACY_TIMES = ("09:00", "14:00", "18:00")


def _executable() -> tuple[str, str]:
    """(program, arguments) for however this app is currently running.

    Frozen by PyInstaller it is the .exe directly; from source it is the interpreter plus
    `desktop_entry.py`, so a developer can register a task without building first.

    THE BUG THIS REPLACED, because it failed silently and cost a day of empty scrapes: the
    source branch used to run `-m desktop.run` and try to set a working directory by closing
    the /TR quote early and appending `" /D "<root>`. `/D` is not schtasks' working-directory
    switch — for a DAILY/WEEKLY schedule it means "days" — so it was swallowed into the command
    string, `Start In` stayed empty, Task Scheduler launched python from C:\\Windows\\System32,
    and `-m desktop.run` died with ModuleNotFoundError. The task showed `Last Result: 1` and
    nothing else complained.

    The fix is to need no working directory at all. Python sets `sys.path[0]` to the directory
    of the script it is given, and `desktop_entry.py` puts the project root on the path from
    there — so an absolute path to it resolves the package from anywhere.

    pythonw.exe rather than python.exe: an unattended hourly task must not flash a console
    window over whatever is on screen. It falls back to python.exe if pythonw is missing.
    """
    if getattr(sys, "frozen", False):
        return sys.executable, "--silent --source scheduled"

    interpreter = Path(sys.executable)
    windowless = interpreter.with_name("pythonw.exe")
    if windowless.exists():
        interpreter = windowless

    entry = Path(__file__).resolve().parent / "desktop_entry.py"
    return str(interpreter), f'"{entry}" --silent --source scheduled'


def _run(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )


def describe(minutes: int = DEFAULT_INTERVAL_MINUTES) -> str:
    """How the cadence reads in a dialog: "every hour", "every 30 minutes"."""
    if minutes == 60:
        return "every hour"
    if minutes % 60 == 0:
        return f"every {minutes // 60} hours"
    return f"every {minutes} minutes"


def is_registered() -> bool:
    return _run(["schtasks", "/Query", "/TN", TASK_NAME]).returncode == 0


def register(minutes: int = DEFAULT_INTERVAL_MINUTES) -> tuple[bool, str]:
    """Create the repeating task. Returns (ok, message)."""
    if minutes < MIN_INTERVAL_MINUTES:
        return False, (
            f"{minutes} minutes is below the {MIN_INTERVAL_MINUTES}-minute floor — "
            "the marketplaces would start refusing this IP."
        )

    program, arguments = _executable()
    unregister()  # replace rather than accumulate duplicates, and clear the legacy tasks

    # HOURLY repeats indefinitely; MINUTE is used only for sub-hourly intervals, where it also
    # needs an explicit duration or it stops after a day.
    if minutes % 60 == 0:
        cadence = ["/SC", "HOURLY", "/MO", str(minutes // 60)]
    else:
        cadence = ["/SC", "MINUTE", "/MO", str(minutes), "/DU", "9999:59"]

    result = _run(
        [
            "schtasks", "/Create",
            "/TN", TASK_NAME,
            "/TR", f'"{program}" {arguments}',
            *cadence,
            "/F",
        ]
    )
    if result.returncode != 0:
        return False, (result.stderr or result.stdout).strip()[:200]
    return True, f"Scheduled to run {describe(minutes)}."


def unregister() -> None:
    """Remove every task this module has ever created. Silent if none exist."""
    names = [TASK_NAME] + [f"{TASK_NAME} {t.replace(':', '')}" for t in _LEGACY_TIMES]
    for name in names:
        _run(["schtasks", "/Delete", "/TN", name, "/F"])


def any_registered() -> bool:
    """True if the current task OR a leftover legacy one is present."""
    if is_registered():
        return True
    return any(
        _run(["schtasks", "/Query", "/TN", f"{TASK_NAME} {t.replace(':', '')}"]).returncode == 0
        for t in _LEGACY_TIMES
    )
