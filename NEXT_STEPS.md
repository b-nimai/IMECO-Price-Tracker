# Next steps

Status as of **7 Aug 2026**. Scraper, database, desktop app and dashboard are all live and
verified end to end. **The one thing standing between this and being useful to anyone but the
machine it runs on is deployment — the dashboard has never left localhost.**

Tick items off as you go. Setup detail lives in [README.md](README.md#setup) — this file is the
running checklist.

**Progress: 11 / 15**

---

## Where things stand

| Piece | State |
|---|---|
| Catalogue parser | ✅ 32 products, 104 listings |
| Amazon / Flipkart / Myntra / Blinkit adapters | ✅ verified live, **0 parse errors** |
| Supabase schema + store layer | ✅ **live** — 128 snapshots stored, RLS verified |
| Desktop GUI + scheduler | ✅ hourly task proven, `source='scheduled'` in the database |
| `.exe` build | ✅ **15.9 MB, runs a full scrape headlessly** |
| Dashboard | ✅ single per-row price ranking, responsive, 17/17 tests, build clean |
| Deployment | ⚠️ **not done — the dashboard still only runs locally** |
| Dashboard reading live data | ✅ verified end to end |
| **Meesho** | ❌ **dropped** — see below |

Latest full run, from the packaged `.exe`: **104 listings, zero parse errors, 3.3 min.**

```
amazon    ok=29  out_of_stock=3
flipkart  ok=30  not_listed=2
myntra    ok=23  out_of_stock=4  not_listed=5
blinkit   ok=6   out_of_stock=9  not_listed=17
```

### Meesho — closed

Removed from the codebase. Akamai refused every method tested: plain HTTP, headless Chromium,
headed Chromium, real Chrome with a persistent profile, mobile user-agents, and every
`api.*.meesho.com` subdomain. `Accumulate_Price_Maker` and `PriceChecker` both hit the same wall
independently — PriceChecker's README says so outright.

Bright Data would have solved it but needs a card, and Meesho had no `Meesho SP` column to check
drift against anyway. **No Bright Data account is needed.** If Meesho ever matters, the free
route is a supplier-panel export joined on SKU, not scraping.

---

## Phase 1 — Blocking on you  `0 / 4`

### 1. Supabase project  → unblocks storage, history and the live dashboard

- [x] **1.1** supabase.com → **New project**, free tier, region **Mumbai** or **Singapore**
- [x] **1.2** **Project Settings → API** → copy four values into `.env`:
      ```
      SUPABASE_URL="https://xxxx.supabase.co"
      SUPABASE_SERVICE_KEY="<service_role secret key>"     # desktop app only
      VITE_SUPABASE_URL="https://xxxx.supabase.co"         # same URL
      VITE_SUPABASE_ANON_KEY="<anon public key>"           # dashboard
      ```
      ⚠️ The **service_role** key bypasses row-level security. It must never go in a `VITE_`
      variable — those are compiled into the public browser bundle.
- [x] **1.3** **SQL Editor** → paste and run [`supabase/schema.sql`](supabase/schema.sql)

### 2. Blinkit columns  → unblocks Blinkit (currently a dark column)

- [x] **2.1** Add **`Blinkit SP`** and **`Blinkit Link`** columns to `Docs/pricing link.xlsx`,
      and paste the `https://blinkit.com/prn/.../prid/NNNNNN` URL for each SKU Blinkit carries.
      Leave blank where it doesn't.

Blinkit's search page is client-rendered, so these cannot be discovered automatically — I
checked. Both links you already gave parse correctly:

| Link | price | MRP | stock |
|---|---|---|---|
| `/prid/691909` | ₹189 | 270 | out of stock |
| `/prid/695492` | ₹89 | 249 | in stock |

Worth knowing: Blinkit reports its **own** MRPs, which differ from the sheet (249 vs 270 on one
listing). It carries different pack configurations. The pinned MRP column keeps the sheet's
value; discount maths uses each marketplace's own.

---

## Phase 2 — Then me  `0 / 6`

- [x] **3** Verify **Supabase** — ✅ 128 snapshots stored, run closed with ok=89 error=0 blocked=0
- [x] **4** Verify **RLS** — ✅ publishable key reads (200), `INSERT` rejected (401), no row landed.
      Confirms the new `sb_publishable_` format maps to the `anon` role, so the key is safe to
      ship in the browser bundle.
- [x] **5** Verify **Blinkit** across all its links — ✅ 15 links, 6 ok / 9 out of stock, 0 errors.
      Also fixed the adapter: it was reading the first priced `product_id` blob on the page,
      which is now a recommendation tile, so it could report a neighbouring product's price.
      It matches on the prid from the URL instead.
- [x] **6a** Build the **`.exe`** — ✅ 15.9 MB, full 104-listing scrape written to Supabase, clean exit
- [ ] **6b** Test the **first-run prompt and Credential Manager storage** on the exe. Not yet done:
      the build was tested with a `.env` beside the exe, which is the fallback path, not the one
      a staff PC will use.
- [x] **7** Register and fire the **Scheduled Task** — ✅ `Last Result: 0`, `source='scheduled'`
      runs in the database. Took two silent-failure fixes; see "Known unverified" below.
- [x] **8a** Dashboard verified reading live Supabase data locally (demo banner gone, 84/89 live)
- [ ] **8b** **Deploy** to Vercel; confirm it picks up a desktop run within one 2-minute poll

---

## Phase 3 — Sign-off  `0 / 4`

- [~] **9** All 32 rows readable with no scrolling — **deliberately traded away.** Matching
      marketplace-dispatch-dashboard's 21px type was chosen instead, which leaves ~6 products
      below the fold on a 1080 window. On a 4K panel reporting 3840x2160 the fit lands near
      39px and all 32 fit. One line reverses it: `MIN_PX` in `src/lib/gridFit.ts`.
- [ ] **10** A staff member runs the `.exe` unaided and prices reach the dashboard
- [ ] **11** Scheduled Task fires unattended overnight and the board is fresh next morning
- [ ] **12** Leave it a week, then review the price history and confirm the cadence is right

---

## Known unverified

Being explicit about what has *not* been proven, rather than implying it has:

- ~~**The `.exe` has never been built.**~~ Built and proven end-to-end: **15.9 MB**, runs a full
  104-listing scrape headlessly and writes it to Supabase (ok=104, err=0, blk=0), then exits.
  `keyring` bundled without a snag.

  The first build came out at **223.5 MB** because PyInstaller was run from the conda base
  environment and swept in numpy, matplotlib, PyQt6, IPython, zmq, lxml and the MKL stack —
  none of which anything here imports. `build.ps1` now builds inside a throwaway `.buildenv`
  venv holding only `requirements.txt`, which is also what makes the build reproducible rather
  than dependent on whatever the builder happens to have installed.

  `build.ps1` also runs at `$ErrorActionPreference = "Continue"` on purpose: under Windows
  PowerShell 5.1 anything a native .exe writes to stderr is re-raised as a NativeCommandError,
  and one harmless PyInstaller WARNING was aborting an otherwise successful build.
- ~~**The Scheduled Task has never been registered.**~~ Registered on the staff PC as one hourly
  repeating task and proven end-to-end: `Last Result: 0`, two `source='scheduled'` runs in the
  database, ok=104 err=0 blk=0. It points at the source checkout, so re-run the packaged `.exe`
  once it exists and let it re-register against the exe instead.

  Getting there took two real bug fixes, both of which failed SILENTLY — the task reported
  `Last Result: 1` and nothing else complained:
  1. `schedule._executable()` tried to set a working directory by closing the `/TR` quote early
     and appending `" /D "<root>`. `/D` is not schtasks' working-directory switch, so python
     launched from `C:\Windows\System32` and `-m desktop.run` raised ModuleNotFoundError. Now
     it runs `desktop_entry.py` by absolute path, which needs no working directory at all.
  2. Running it under `pythonw.exe` (no console, so no window flashes hourly) meant
     `sys.stdout` was None, and `run.main()`'s unguarded `sys.stdout.reconfigure()` raised
     before a single listing was fetched. Guarded in `run.py`, `catalogue.py` and `probe.py`.
- ~~**Blinkit has been verified on two listings, not a full column.**~~ All 15 Blinkit links now
  parse (6 ok, 9 out-of-stock). Myntra's 27 links likewise, added to the workbook 2026-08-07.
  A full run is 104 listings in 3.4 min with zero blocked.

---

## Decisions worth revisiting later

- **Cadence.** Now a single Scheduled Task repeating hourly (was 09:00 / 14:00 / 18:00). Amazon
  moved a price between two scrapes on the same day (299 → 301), so intraday movement is real
  and hourly captures it. 30 minutes is the floor in `schedule.py`; going there is only worth it
  if `blocked_count` stays at zero for a week first.
- **Drift and Cheapest were removed**, along with the KPI tiles, on request — the board is now
  one view: price rank within each product row. `target_sp` is still parsed from the sheet and
  still stored per cell, so a drift reading can come back without a scrape or a schema change.
- **Price history.** `price_snapshots` is append-only, so trend charts and "cheapest ever" are
  available later with no schema change. Not built — say the word.
- **Bright Data is dormant, not removed.** `fetch.py` keeps an escalation path that fires only
  if a direct fetch is refused; with no key configured it never runs. Left in as insurance if a
  marketplace starts blocking this IP — deleting it would mean rebuilding it under pressure.
