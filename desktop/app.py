"""The desktop GUI.

Tkinter, because it is in the standard library and PyInstaller bundles it without complaint —
this window has five widgets and does not justify a dependency.

Two responsibilities beyond showing progress:

  * First-run setup. Secrets are collected here and written to Windows Credential Manager, NOT
    embedded in the .exe. The Supabase service_role key can write to the database, so an .exe
    carrying it could be opened in a hex editor by anyone it is handed to.
  * Offering the Scheduled Task, which is what stops the board going stale at weekends.

    python -m desktop.app              # normal window
    python -m desktop.app --silent     # no window; used by the scheduled task
"""

from __future__ import annotations

import queue
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from . import catalogue, schedule
from .catalogue import load_products
from .config import load_settings, save_setting
from .fetch import Fetcher
from .models import MARKETPLACES, LocationCheck, Product, Status
from .run import all_stores_due, run_search, scrape, search_wanted, store_results

BG = "#111111"
FG = "#f1f5f9"
MUTED = "#a1a1aa"
ACCENT = "#22c55e"
WARN = "#f59e0b"
DANGER = "#f43f5e"

SETTING_LABELS = {
    "SUPABASE_URL": ("Supabase Project URL", "https://xxxxxxxx.supabase.co"),
    "SUPABASE_SERVICE_KEY": ("Supabase service_role key", "secret — never shared"),
}


class App:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.events: queue.Queue = queue.Queue()
        self.running = False

        root.title("IMECO Price Tracker")
        root.configure(bg=BG)
        root.geometry("560x420")
        root.resizable(False, False)

        tk.Label(
            root, text="IMECO PRICE TRACKER", bg=BG, fg=FG,
            font=("Segoe UI", 13, "bold"),
        ).pack(pady=(18, 2))
        self.subtitle = tk.Label(
            root, text="Ready", bg=BG, fg=MUTED, font=("Segoe UI", 9)
        )
        self.subtitle.pack(pady=(0, 14))

        # One progress row per marketplace.
        self.bars: dict[str, ttk.Progressbar] = {}
        self.labels: dict[str, tk.Label] = {}
        grid = tk.Frame(root, bg=BG)
        grid.pack(fill="x", padx=28)

        style = ttk.Style()
        style.theme_use("clam")
        style.configure(
            "IMECO.Horizontal.TProgressbar",
            troughcolor="#1a1a1a", background=ACCENT,
            bordercolor="#1a1a1a", lightcolor=ACCENT, darkcolor=ACCENT,
        )

        for row, marketplace in enumerate(MARKETPLACES):
            tk.Label(
                grid, text=marketplace.capitalize(), bg=BG, fg=FG,
                font=("Segoe UI", 9), width=10, anchor="w",
            ).grid(row=row, column=0, sticky="w", pady=4)
            bar = ttk.Progressbar(
                grid, length=300, mode="determinate",
                style="IMECO.Horizontal.TProgressbar",
            )
            bar.grid(row=row, column=1, padx=8)
            label = tk.Label(grid, text="-", bg=BG, fg=MUTED, font=("Consolas", 9), width=14, anchor="w")
            label.grid(row=row, column=2, sticky="w")
            self.bars[marketplace] = bar
            self.labels[marketplace] = label

        self.status = tk.Label(root, text="", bg=BG, fg=MUTED, font=("Consolas", 9))
        self.status.pack(pady=(16, 4))

        buttons = tk.Frame(root, bg=BG)
        buttons.pack(pady=8)
        self.run_button = tk.Button(
            buttons, text="Run now", command=self.start,
            bg=ACCENT, fg="#000000", font=("Segoe UI", 10, "bold"),
            relief="flat", padx=22, pady=6, cursor="hand2",
        )
        self.run_button.pack(side="left", padx=6)
        tk.Button(
            buttons, text="Spreadsheet", command=self.open_workbook_dialog,
            bg="#1a1a1a", fg=FG, font=("Segoe UI", 10),
            relief="flat", padx=18, pady=6, cursor="hand2",
        ).pack(side="left", padx=6)
        tk.Button(
            buttons, text="Settings", command=self.open_settings,
            bg="#1a1a1a", fg=FG, font=("Segoe UI", 10),
            relief="flat", padx=18, pady=6, cursor="hand2",
        ).pack(side="left", padx=6)

        self.refresh_status()
        self.root.after(100, self._drain)

        if load_settings().missing():
            self.root.after(400, self.open_settings)
        elif not schedule.is_registered():
            self.root.after(400, self.offer_schedule)
        elif schedule.is_stale():
            # A task exists but points at something else — typically the source checkout it was
            # first registered from, before this .exe existed. Left alone it keeps "working"
            # until that folder moves, then fails hourly and silently.
            self.root.after(400, self.offer_repoint)

    # ── status line ─────────────────────────────────────────────────────────────────────

    def refresh_status(self) -> None:
        settings = load_settings()
        bits: list[str] = []
        if missing := settings.missing():
            bits.append(f"missing: {', '.join(m.split('_')[0].lower() for m in missing)}")
        if schedule.is_registered():
            bits.append(f"auto-run {schedule.describe()}{' (other copy)' if schedule.is_stale() else ''}")

        # Running on the built-in sheet is a WARNING, not a neutral fact, and it used to read as
        # one — grey text saying "sheet: built-in" next to two other grey facts.
        #
        # What that hid, and it cost 13 SKUs a day of prices: the bundled sheet is frozen at
        # whenever the .exe was built. If the operator's sheet is ever removed — the "use the
        # built-in sheet" button unlinks it — every hourly run silently falls back to that
        # older, usually SMALLER catalogue. The products it no longer lists simply stop being
        # scraped, and because the dashboard reads the latest snapshot per SKU rather than the
        # latest run, their final prices stay on the wall looking current indefinitely.
        #
        # Nothing else notices: the runs all succeed, exit 0, and report no errors. So the one
        # place it can be caught is here, and it has to be loud enough to read as a problem.
        _, operator, stamp = catalogue.workbook_status()
        if operator:
            bits.append(f"sheet: yours ({stamp})")
            self.status.config(text="   ".join(bits), fg=MUTED)
            return

        bits.append(f"sheet: BUILT-IN, not yours ({stamp})")
        self.status.config(text="   ".join(bits), fg=WARN)

    # ── the run ─────────────────────────────────────────────────────────────────────────

    def start(self) -> None:
        if self.running:
            return
        settings = load_settings()
        if not settings.can_store:
            messagebox.showwarning(
                "Not configured",
                "Supabase is not set up yet, so results cannot be saved.\n\n"
                "Open Settings and add the project URL and service_role key.",
            )
            return

        self.running = True
        self.run_button.config(state="disabled", text="Running...")
        self.subtitle.config(text="Fetching prices...", fg=MUTED)
        for marketplace in MARKETPLACES:
            self.bars[marketplace]["value"] = 0
            self.labels[marketplace].config(text="-", fg=MUTED)

        threading.Thread(target=self._work, args=("manual",), daemon=True).start()

    def _work(self, source: str) -> None:
        try:
            settings = load_settings()
            products = load_products()

            def progress(marketplace: str, done: int, total: int) -> None:
                self.events.put(("progress", marketplace, done, total))

            # The scheduled task runs the exe with --silent, which goes through run.main; this
            # is the button. Both follow the same every-few-hours dark-store cadence.
            checks: list[LocationCheck] | None = [] if all_stores_due() else None

            with Fetcher(settings) as fetcher:
                results = scrape(products, fetcher, progress, checks)
                # The daily keyword search, if today's has not happened yet. No progress bar of
                # its own: it is ~1-2 minutes after the prices, and failures only skip keywords.
                searches = run_search(products, fetcher)[0] if search_wanted(settings) else None

            store_results(settings, products, results, checks, source, searches)

            ok = sum(c.status is Status.OK for _, c in results)
            self.events.put(("done", ok, len(results)))
        except Exception as exc:  # surfaced in the window rather than a silent death
            self.events.put(("error", f"{type(exc).__name__}: {exc}"))

    # ── the catalogue ───────────────────────────────────────────────────────────────────

    def push_catalogue(self, products: list[Product] | None = None) -> None:
        """Mirror the sheet now in force into Supabase, without waiting for a scrape.

        Called whenever the WORKBOOK changes, not whenever prices do. `store.sync_products`
        also runs inside every scrape, so this is not what keeps the catalogue correct — it is
        what keeps it correct SOONER. Product names, the row order and which SKUs exist at all
        come from this table, so without this the wall display keeps showing the previous
        sheet's names and order for up to an hour after the operator swapped it, and every one
        of those minutes looks like the upload silently failed.

        Threaded and silent about being unconfigured: this is a side effect of a button press
        about a spreadsheet, and it must never block the window or turn into a dialog the
        operator has to dismiss before they can get on.
        """
        settings = load_settings()
        if not settings.can_store:
            return

        def work() -> None:
            try:
                items = load_products() if products is None else products
                from .store import Store

                with Store(settings) as store:
                    store.sync_products(items)
                self.events.put(("catalogue", f"Dashboard updated — {len(items)} products", True))
            except Exception as exc:
                # The sheet itself IS installed at this point, and the next run will sync it.
                # So this is a delay, not a failure, and it says so.
                self.events.put(
                    (
                        "catalogue",
                        f"Sheet saved. Dashboard updates on the next run ({type(exc).__name__})",
                        False,
                    )
                )

        threading.Thread(target=work, daemon=True).start()

    def _drain(self) -> None:
        """Pump worker events onto the Tk thread. Tk is not thread-safe, so every widget
        update has to funnel through here."""
        try:
            while True:
                event = self.events.get_nowait()
                if event[0] == "progress":
                    _, marketplace, done, total = event
                    bar = self.bars[marketplace]
                    bar["maximum"] = max(total, 1)
                    bar["value"] = done
                    self.labels[marketplace].config(text=f"{done}/{total}", fg=FG)
                elif event[0] == "done":
                    _, ok, total = event
                    self.subtitle.config(
                        text=f"Done — {ok} live prices saved", fg=ACCENT
                    )
                    self._finish()
                elif event[0] == "error":
                    self.subtitle.config(text=event[1][:70], fg=DANGER)
                    self._finish()
                elif event[0] == "catalogue":
                    # A run's own progress outranks this — the catalogue push is a background
                    # courtesy, and it must not overwrite the line someone is watching.
                    if not self.running:
                        self.subtitle.config(text=event[1][:70], fg=ACCENT if event[2] else WARN)
        except queue.Empty:
            pass
        self.root.after(120, self._drain)

    def _finish(self) -> None:
        self.running = False
        self.run_button.config(state="normal", text="Run now")
        self.refresh_status()

    # ── settings ────────────────────────────────────────────────────────────────────────

    def open_settings(self) -> None:
        window = tk.Toplevel(self.root)
        window.title("Settings")
        window.configure(bg=BG)
        window.geometry("560x330")
        window.transient(self.root)
        window.grab_set()

        tk.Label(
            window,
            text="Stored in Windows Credential Manager, not in the app file.",
            bg=BG, fg=MUTED, font=("Segoe UI", 8), wraplength=500,
        ).pack(pady=(14, 10))

        settings = load_settings()
        current = {
            "SUPABASE_URL": settings.supabase_url,
            "SUPABASE_SERVICE_KEY": settings.supabase_service_key,
        }
        entries: dict[str, tk.Entry] = {}

        for name, (label, hint) in SETTING_LABELS.items():
            frame = tk.Frame(window, bg=BG)
            frame.pack(fill="x", padx=24, pady=3)
            tk.Label(
                frame, text=label, bg=BG, fg=FG, font=("Segoe UI", 9),
                width=26, anchor="w",
            ).pack(side="left")
            entry = tk.Entry(
                frame, bg="#1a1a1a", fg=FG, insertbackground=FG,
                relief="flat", font=("Consolas", 9), width=32,
                show="*" if "KEY" in name else "",
            )
            entry.insert(0, current[name])
            entry.pack(side="left", ipady=4)
            entries[name] = entry
            tk.Label(frame, text=hint, bg=BG, fg="#555", font=("Segoe UI", 7)).pack(side="left", padx=6)

        def save() -> None:
            failed = [
                name
                for name, entry in entries.items()
                if entry.get().strip() and not save_setting(name, entry.get().strip())
            ]
            if failed:
                messagebox.showerror(
                    "Could not save",
                    "Windows Credential Manager is unavailable.\n"
                    "Values can be put in the .env file instead.",
                    parent=window,
                )
                return
            window.destroy()
            self.refresh_status()
            if not schedule.is_registered():
                self.offer_schedule()

        tk.Button(
            window, text="Save", command=save, bg=ACCENT, fg="#000000",
            font=("Segoe UI", 10, "bold"), relief="flat", padx=24, pady=6, cursor="hand2",
        ).pack(pady=14)

    # ── the spreadsheet ─────────────────────────────────────────────────────────────────

    def open_workbook_dialog(self) -> None:
        """Let the operator swap in a new pricing sheet — or carry on with the current one.

        Doing nothing is a first-class outcome here, which is why this is a dialog rather than
        a bare file picker: the common case is that the sheet has NOT changed and the operator
        just wants to see which one is in force. Nothing is touched unless they choose a file
        and that file parses.
        """
        path, operator, stamp = catalogue.workbook_status()
        try:
            summary = catalogue.summarise_catalogue(load_products())
        except Exception as exc:
            summary = f"could not be read — {type(exc).__name__}: {exc}"

        window = tk.Toplevel(self.root)
        window.title("Pricing spreadsheet")
        window.configure(bg=BG)
        window.geometry("560x300")
        window.resizable(False, False)
        window.transient(self.root)
        window.grab_set()

        tk.Label(
            window, text="PRICING SPREADSHEET", bg=BG, fg=FG, font=("Segoe UI", 11, "bold")
        ).pack(pady=(18, 10))

        body = tk.Frame(window, bg=BG)
        body.pack(fill="x", padx=24)
        tk.Label(
            body,
            text=f"In use:  {'your uploaded sheet' if operator else 'the sheet built into this app'}",
            bg=BG, fg=FG, font=("Segoe UI", 9), anchor="w",
        ).pack(fill="x")
        tk.Label(
            body, text=stamp, bg=BG, fg=MUTED, font=("Consolas", 9), anchor="w"
        ).pack(fill="x", pady=(2, 0))
        tk.Label(
            body, text=summary, bg=BG, fg=MUTED, font=("Consolas", 9),
            anchor="w", wraplength=500, justify="left",
        ).pack(fill="x", pady=(2, 0))
        tk.Label(
            body, text=str(path), bg=BG, fg=MUTED, font=("Consolas", 8),
            anchor="w", wraplength=500, justify="left",
        ).pack(fill="x", pady=(8, 0))

        tk.Label(
            window,
            text="Prices and links come from this sheet on every run, including the automatic\n"
                 "hourly ones. Leave it alone and nothing changes.",
            bg=BG, fg=MUTED, font=("Segoe UI", 8), justify="left",
        ).pack(pady=(12, 0), padx=24, anchor="w")

        row = tk.Frame(window, bg=BG)
        row.pack(pady=16)

        def choose() -> None:
            selected = filedialog.askopenfilename(
                parent=window,
                title="Choose the new pricing spreadsheet",
                filetypes=[("Excel workbook", "*.xlsx *.xlsm"), ("All files", "*.*")],
            )
            if not selected:
                return  # cancelled — the current sheet stays in force
            try:
                # Parses before it copies. A sheet that cannot be read must never become the
                # one 24 unattended runs a day depend on.
                products = catalogue.install_workbook(Path(selected))
            except Exception as exc:
                messagebox.showerror(
                    "That sheet was not accepted",
                    f"{type(exc).__name__}: {exc}\n\n"
                    "The previous spreadsheet is still in use — nothing was changed.",
                    parent=window,
                )
                return
            # Names, row order and which SKUs exist go to the dashboard straight away; the
            # PRICES still need a scrape, which is the distinction the message draws.
            self.push_catalogue(products)
            messagebox.showinfo(
                "Spreadsheet updated",
                f"{catalogue.summarise_catalogue(products)}\n\n"
                "The dashboard's product list and order update now. Prices follow on the next "
                "run — manual or automatic.",
                parent=window,
            )
            window.destroy()
            self.refresh_status()

        def revert() -> None:
            if not messagebox.askyesno(
                "Use the built-in sheet?",
                "Discard the spreadsheet you uploaded and go back to the one that shipped "
                "with this app?",
                parent=window,
            ):
                return
            catalogue.revert_workbook()
            # The built-in sheet is usually SMALLER, so this path removes products as well as
            # renaming them. Pushing it immediately is what makes the board agree with the
            # sheet that is actually in force from this moment on.
            self.push_catalogue()
            window.destroy()
            self.refresh_status()

        tk.Button(
            row, text="Update spreadsheet...", command=choose, bg=ACCENT, fg="#000000",
            font=("Segoe UI", 10, "bold"), relief="flat", padx=18, pady=6, cursor="hand2",
        ).pack(side="left", padx=6)
        if operator:
            tk.Button(
                row, text="Use built-in", command=revert, bg="#1a1a1a", fg=FG,
                font=("Segoe UI", 10), relief="flat", padx=14, pady=6, cursor="hand2",
            ).pack(side="left", padx=6)
        tk.Button(
            row, text="Keep current", command=window.destroy, bg="#1a1a1a", fg=FG,
            font=("Segoe UI", 10), relief="flat", padx=14, pady=6, cursor="hand2",
        ).pack(side="left", padx=6)

    # ── scheduling ──────────────────────────────────────────────────────────────────────

    def offer_repoint(self) -> None:
        if messagebox.askyesno(
            "Update the automatic run?",
            "The hourly task is set up to run a different copy of this app:\n\n"
            f"{schedule.registered_command()}\n\n"
            "Point it at this one instead? Recommended — otherwise the automatic updates stop "
            "working if that copy is moved or deleted.",
        ):
            ok, message = schedule.register()
            messagebox.showinfo("Automatic updates" if ok else "Could not schedule", message)
            self.refresh_status()

    def offer_schedule(self) -> None:
        if messagebox.askyesno(
            "Automatic updates",
            f"Run automatically {schedule.describe()} whenever this PC is on?\n\n"
            "Without this, the dashboard only updates when someone opens this app — so it "
            "goes stale over weekends.\n\nA run takes about four minutes and stays in the "
            "background.\n\nYou can still use Run now at any time.",
        ):
            ok, message = schedule.register()
            messagebox.showinfo("Automatic updates" if ok else "Could not schedule", message)
            self.refresh_status()


def _silent() -> int:
    """Headless path for the scheduled task — no window, exit code reports success."""
    from .run import main

    return main(["--source", "scheduled"])


def main() -> int:
    if "--silent" in sys.argv:
        return _silent()
    root = tk.Tk()
    App(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
