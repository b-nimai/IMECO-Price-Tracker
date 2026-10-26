# Plan — 42signals-style features for the IMECO Price Tracker

Research done **26 Oct 2026**. Tick items off as they land. [NEXT_STEPS.md](NEXT_STEPS.md) is the
original build checklist; this file tracks everything added on top of it.

**Status key**

| Mark | Meaning |
|---|---|
| ✅ | **Done** — live on https://imeco-price-tracker.vercel.app/ (or in the shipped `.exe`) |
| 🟡 | **Working** — built and tested locally, not yet deployed / committed |
| ⬜ | **To do** |
| ⏸ | **Skipped for now** — not needed yet; can be picked up later |
| ❌ | Dropped, with the reason |

**Progress: 2 done · 3 working · 2 to do · 1 skipped** (by phase)

---

## Why

[42signals](https://www.42signals.com) is a paid "digital shelf analytics" SaaS for Indian
e-commerce and quick commerce. What it sells, and what we already have:

| 42signals module | What it does | Us today |
|---|---|---|
| Price monitoring / MAP & sellers | Per-SKU prices across marketplaces and sellers, breach alerts, screenshot evidence | ✅ Hourly prices for Amazon, Flipkart, Blinkit |
| Price alerts / guardrails | Telegram, WhatsApp, email alerts on thresholds | ⏸ Phase 2 — skipped for now |
| Product availability | In-stock by pincode / dark store, stockout patterns, OOS alerts | Partly — Blinkit checked at 6 dark stores, only "anywhere in stock?" kept |
| Share of search | Daily keyword rank, organic vs sponsored, brand share of top results | ⬜ Phase 6 |
| Competitor analysis | Competitor SKUs beside yours, price benchmarking | ⬜ Phase 5 |
| Voice of customer | Ratings, reviews, sentiment, themes | ⬜ Phase 4 |
| Data delivery | Freshness indicators, source URLs, API / S3 | Freshness ✅, export ⬜ Phase 7 |

All four feature areas plus competitor tracking were chosen.

**Ground rules** that carry through every phase:

- The repo is **public**. New secrets (Telegram token, etc.) go through repo secrets and the
  encrypted `.exe` build only — never committed, never in a `VITE_` variable.
- The dashboard's anon key stays **read-only**: every new table/view gets RLS with SELECT-only
  policies, same pattern as `supabase/schema.sql`.
- An hourly run must stay well under an hour (today ~3.3 min for 104 listings).
- The wall display (Prices tab) must look and behave exactly as before.
- Commits carry **no co-author line**.

**Order:** 0 → 1 → ~~2~~ → 3 → 4 → 5 → 6 → 7. Phase 2 skipped for now; 3 and 4 moved ahead of 5 because
they need nothing from you. Phases 0–1 are dashboard-only (Vercel
deploy). Phases 2–6 change the desktop app and need `./desktop/build-remote.sh` after.

---

## Phase 0 — Navigation shell  ✅ Done

Dashboard only · no `.exe` rebuild

- [x] Tab bar in the header (`src/App.tsx`, `src/components/Header.tsx`) — Prices | Trends
- [x] Selected tab kept in the URL hash, e.g. `/#trends` (`src/hooks/useHashTab.ts`)
- [x] Non-Prices views code-split, so the wall display downloads nothing extra
- [x] Wall display unchanged — still opens on Prices
- [x] Commit + push → Vercel deploy (`17c8a81`, 26 Oct)
- Note: tabs for Availability / Search / Reviews / Competitors are added when their phase
  ships, rather than as empty placeholders now.

## Phase 1 — Price history & trends  ✅ Done

Dashboard + one SQL view · no `.exe` rebuild

- [x] `price_stats` view in `supabase/schema.sql` — lows, highs, 30-day change count per listing
- [x] View **run in Supabase** (26 Oct) — 132 listings readable with the anon key, writes refused
- [x] `fetchHistory` / `fetchPriceStats` in `src/data/supabaseClient.ts`
- [x] Price chart per product, 7 / 30 / 90 days, one line per marketplace, OOS dashed,
      stock strips underneath, hover tooltip (`src/components/PriceChart.tsx`)
- [x] "All products" table — one row per product, a column per marketplace like the Prices
      board: price now, 30-day range, change count, "30d low / high" tags,
      spread now (high vs low channel, gap %) and all-time range; filter box; click a row to
      chart it (`src/views/TrendsView.tsx`)
- [x] Readability pass (26 Oct) — chart starts at the first reading instead of an empty week,
      larger text, labelled stock strips, legend says "out of stock now"; checked at desktop and
      phone widths
- [x] Target / vs-target columns — shown automatically once the sheet has SP values
- [x] Typecheck, lint, 20/20 tests, production build, visual check in a browser
- [x] Commit + push → Vercel deploy, confirmed live (`17c8a81`, 26 Oct)
- [ ] Fill in the SP (target price) columns in the sheet so "vs target" lights up *(you)*

## Phase 2 — Alerts  ⏸ Skipped for now

> Not needed right now (decided 26 Oct 2026). Nothing below is built. The dashboard's "Spread
> now" amber gap and the out-of-stock labels cover the same ground for anyone looking at it.
> Pick this up if someone needs to be told without opening the dashboard.

Desktop app · needs `.exe` rebuild

- [ ] Create a Telegram bot with @BotFather; get bot token + chat id *(you)*
- [ ] `desktop/alerts.py` — after each run, compare with the previous run:
  - [ ] Price fell below target SP by more than X %
  - [ ] Price moved more than Y % since the last run
  - [ ] Went out of stock / came back in stock
  - [ ] Competitor undercuts IMECO *(after Phase 5)*
  - [ ] IMECO dropped out of top N for a keyword *(after Phase 6)*
- [ ] `alert_events` table — don't repeat an alert while the condition persists; send "cleared"
- [ ] Thresholds: defaults in code first, later an `alert_rules` table or sheet tab
- [ ] Secrets `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` through `.env` → `build-remote.sh --setup`
      → workflow → `build.ps1` bake → `config.py`
- [ ] Alerts feed on the dashboard (last 50)
- [ ] Rebuild `.exe`, force a test alert, confirm it arrives once and not again

## Phase 3 — Availability analytics  🟡 Working

Desktop app + dashboard · needs `.exe` rebuild

- [x] Every Blinkit dark store's answer recorded in a new `availability_checks` table — the
      board's cell and `price_snapshots` unchanged (`desktop/run.py` `_fetch_blinkit`)
- [x] Full walk every 3 h (on the hour 0, 3, 6 … 21; `--all-stores` forces it), the quick
      "stop at the first store with stock" walk otherwise — ~11 extra minutes on those runs
- [x] Each store named by area — Dum Dum, Ballygunge, Behala, Salt Lake, Bengaluru, Mumbai
      (`desktop/fetch.py` `BLINKIT_LOCATIONS`)
- [x] Tested live on 2 listings: one in stock everywhere except Mumbai, one out everywhere
- [x] `availability_stats` view — in-stock % (7d / 30d), current state and since when, from the
      hourly readings already stored, so Amazon / Flipkart / Blinkit fill in straight away
- [x] `blinkit_store_stats` view — each store's latest answer and 7-day in-stock %
- [x] Schema tested on a local PostgreSQL: applies on top of the live schema, re-runnable,
      anon can read and cannot write
- [x] **Availability** tab — in-stock % per marketplace, per-product stock with "since",
      "longest out of stock" sort, Blinkit product × dark-store grid
- [ ] Run the updated `supabase/schema.sql` in Supabase *(you)*
- [ ] Commit + push, rebuild `.exe` (`./desktop/build-remote.sh`), install it on the PC
- [ ] Confirm the first full walk lands (next run at 9 / 12 / 3 / 6 o'clock)
- [ ] *Later:* optional "Locations" sheet tab to add cities (Delhi, Hyderabad, …)
- ❌ Lost-revenue estimate — needs sales data we don't have

## Phase 4 — Ratings & reviews  🟡 Working

Desktop app + dashboard · needs `.exe` rebuild

- [x] Amazon reads the product's own rating widget (`acrPopover`), not the recommendation tiles
- [x] Flipkart reads the rating keyed by the product id in the URL — matches the page's own
      structured data where it has one (4.5 / 2,165)
- [x] Tested on 8 live pages, in stock and out of stock: all correct
- [x] `rating`, `rating_count` on `price_snapshots`; `models.py` / `store.py` updated — a database
      without the columns still gets its prices (ratings dropped, run not failed)
- [x] `rating_trend` view — latest rating vs. 30 days ago, ratings added
- [x] **Reviews** tab — average rating per marketplace, per-product ★ and count, "▼0.1 since …"
      flag for drops, "lowest rated first" sort
- [ ] Run the updated `supabase/schema.sql` *(you — same step as Phase 3)*
- [ ] Commit + push, rebuild `.exe`, confirm ratings appear after the first run
- [ ] *Optional later:* review text → sentiment + themes via Claude API (needs an API key;
      Amazon's full review pages need login, so check feasibility first)

## Phase 5 — Competitor SKUs  🟡 Working

Desktop app + sheet + dashboard · needs `.exe` rebuild

- [x] Optional **"Competitors"** sheet in the workbook — Competitor Of (IMECO SKU), Brand,
      Product Name, MRP, Amazon / Flipkart / Blinkit Link. No SKU to invent: the key is made
      from the first link (`C:amazon:B0XXXXXXXX`)
- [x] `desktop/catalogue.py` reads it; refuses the sheet, naming the row, for an unknown IMECO
      SKU, a row with no link, or the same link twice. IMECO's own catalogue parses
      byte-for-byte as before (checked against the old parser on both workbooks)
- [x] Competitors scraped exactly like IMECO listings — price, stock, ratings, dark stores
- [x] `products.brand` (default `IMECO`) and `products.competitor_of` columns; an un-migrated
      database still gets IMECO's prices and simply skips the competitors (tested)
- [x] Prices board, its counts and the other tabs stay IMECO-only (tested; 22/22 tests)
- [x] **Competitors** tab — each IMECO product with its rivals under it, per marketplace:
      price, "₹50 cheaper than IMECO" in amber, rating; "IMECO cheapest on X of Y" per
      marketplace; empty state explains the sheet format
- [x] Sample "Competitors" sheet in `Docs/pricing link.example.xlsx`
- [ ] Add the **Competitors** sheet to your workbook with real competitor links, then upload it
      in the desktop app *(you)*
- [ ] Run the updated `supabase/schema.sql` *(you — one run covers Phases 3, 4 and 5)*
- [ ] Push, rebuild `.exe`, confirm competitors appear after the first run
- ❌ Price per unit — the sheet carries no pack size to divide by; revisit if a "Pack Size"
      column is added

## Phase 6 — Share of search / keyword rank  ⬜ To do

Desktop app + sheet · needs `.exe` rebuild

- [ ] **"Keywords"** sheet tab — keyword + marketplaces *(you: list keywords)*
- [ ] Search-page adapters: Amazon `s?k=`, Flipkart `search?q=`
- [ ] Blinkit search — investigate its JSON endpoint first; ship only if plain HTTP works
- [ ] Match results to IMECO / competitors by ASIN / Flipkart pid, then brand text
- [ ] `search_results` table; runs **daily** (first run after 09:00)
- [ ] `share_of_search_daily` view — brand share of top 10 / 20, organic vs sponsored, best rank
- [ ] **Search** tab — share over time, keyword × marketplace rank table, competitors
      sponsoring our keywords

## Phase 7 — Later / optional  ⬜ To do

- [ ] CSV export on each tab
- [ ] Screenshot / HTML evidence for alerts in Supabase Storage
- [ ] Amazon multi-seller & Buy Box tracking (offer pages are often blocked — check first)
- [ ] More channels: Zepto, Instamart (location handling like Blinkit), Myntra back on

---

## Cross-cutting

- [ ] **Database size.** ~2.5k price rows/day now, ~6k with competitors + availability →
      roughly 400 MB/year against the Supabase free tier's 500 MB. Add a rollup: keep raw rows
      90 days, keep daily summaries forever.
- [ ] Keep `src/data/types.ts` and `desktop/models.py` in step; DB CHECK constraints stay the
      source of truth.

## How each phase is checked

- **Dashboard:** `npm test`, `npm run build`, look at the tab against live data, then confirm
  the Vercel deploy and the live page.
- **SQL:** run in the Supabase SQL editor; confirm the anon key can read the new view/table and
  cannot write to it.
- **Desktop:** parser tests on saved pages; one full run from source with run time noted;
  rebuild with `./desktop/build-remote.sh` and confirm the log shows each secret being baked.

## Log

| Date | What |
|---|---|
| 26 Oct 2026 | 42signals researched, plan agreed. Phases 0–1 built and tested locally. `price_stats` view run in Supabase. |
| 26 Oct 2026 | Trends tab redesigned for readability: one row per product instead of one per listing. |
| 26 Oct 2026 | Seller view: "Best now" (lowest = buyer's view) replaced by **Spread now** — high vs low channel and the gap %, amber at 20 %+; "Lowest ever" became an all-time range. Chart gets a plain-words summary per marketplace, price labels on the lines, and opens on 30 days. |
| 26 Oct 2026 | Phases 0–1 shipped — `17c8a81`, live on Vercel. |
| 26 Oct 2026 | Phase 2 (alerts) skipped for now — not needed yet. |
| 26 Oct 2026 | Phases 3–4 built and tested: dark-store walk, ratings, Availability + Reviews tabs. Waiting on schema run + `.exe` rebuild. Committed locally (`34af673`), not pushed. |
| 26 Oct 2026 | Phase 5 built and tested: Competitors sheet, competitor scraping, Competitors tab. Waiting on your competitor links, schema run + `.exe` rebuild. |
