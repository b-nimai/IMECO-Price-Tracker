# Plan — 42signals-style features for the IMECO Price Tracker

Research done **26 Oct 2026**. Tick items off as they land. [NEXT_STEPS.md](NEXT_STEPS.md) is the
original build checklist; this file tracks everything added on top of it.

**Status key**

| Mark | Meaning |
|---|---|
| ✅ | **Done** — live on https://imeco-price-tracker.vercel.app/ (or in the shipped `.exe`) |
| 🟡 | **Working** — built and tested locally, not yet deployed / committed |
| ⬜ | **To do** |
| ❌ | Dropped, with the reason |

**Progress: 0 done · 2 working · 7 to do** (by phase)

---

## Why

[42signals](https://www.42signals.com) is a paid "digital shelf analytics" SaaS for Indian
e-commerce and quick commerce. What it sells, and what we already have:

| 42signals module | What it does | Us today |
|---|---|---|
| Price monitoring / MAP & sellers | Per-SKU prices across marketplaces and sellers, breach alerts, screenshot evidence | ✅ Hourly prices for Amazon, Flipkart, Blinkit |
| Price alerts / guardrails | Telegram, WhatsApp, email alerts on thresholds | ⬜ Phase 2 |
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

**Recommended order:** 0 → 1 → 2 → 5 → 3 → 4 → 6 → 7. Phases 0–1 are dashboard-only (Vercel
deploy). Phases 2–6 change the desktop app and need `./desktop/build-remote.sh` after.

---

## Phase 0 — Navigation shell  🟡 Working

Dashboard only · no `.exe` rebuild

- [x] Tab bar in the header (`src/App.tsx`, `src/components/Header.tsx`) — Prices | Trends
- [x] Selected tab kept in the URL hash, e.g. `/#trends` (`src/hooks/useHashTab.ts`)
- [x] Non-Prices views code-split, so the wall display downloads nothing extra
- [x] Wall display unchanged — still opens on Prices
- [ ] Commit + push → Vercel deploy
- Note: tabs for Availability / Search / Reviews / Competitors are added when their phase
  ships, rather than as empty placeholders now.

## Phase 1 — Price history & trends  🟡 Working

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
- [ ] Commit + push → Vercel deploy, confirm live
- [ ] Fill in the SP (target price) columns in the sheet so "vs target" lights up *(you)*

## Phase 2 — Alerts  ⬜ To do

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

## Phase 3 — Availability analytics  ⬜ To do

Desktop app · needs `.exe` rebuild

- [ ] Record **every** Blinkit location's answer (today `_fetch_blinkit` stops at the first in
      stock) into a new `availability_checks` table — `price_snapshots` stays as is
- [ ] Full location walk on a slower cadence (e.g. every 3 h) to keep runs short
- [ ] Optional "Locations" sheet tab (pincode / lat / lon) — add Delhi, Hyderabad, …
- [ ] `availability_daily` view — in-stock %, longest OOS streak, current OOS duration
- [ ] **Availability** tab — in-stock % per marketplace (7d / 30d), SKU × location grid,
      "out of stock longest" ranking, stockout timeline
- ❌ Lost-revenue estimate — needs sales data we don't have

## Phase 4 — Ratings & reviews  ⬜ To do

Desktop app · needs `.exe` rebuild

- [ ] Amazon + Flipkart adapters also extract `rating` and `review_count` from the pages
      already fetched (Blinkit has no reviews)
- [ ] `rating`, `review_count` columns on `price_snapshots`; mirror in `models.py` / `types.ts`
- [ ] Parser tests against saved pages
- [ ] **Reviews** tab — rating and count per listing, 30-day trend, "rating dropped" flag
- [ ] Rating-drop alert *(wires into Phase 2)*
- [ ] *Optional later:* review snippets → sentiment + themes via Claude API (Haiku), stored in a
      `reviews` table. Needs an Anthropic API key; Amazon's full review pages need login, so
      check feasibility first.

## Phase 5 — Competitor SKUs  ⬜ To do

Desktop app + sheet · needs `.exe` rebuild

- [ ] Add a **"Competitors"** tab to `Docs/pricing link.xlsx` — Competitor of (IMECO SKU),
      Brand, Name, Amazon Link, Flipkart Link, Blinkit Link *(you: fill in links)*
- [ ] `desktop/catalogue.py` reads the tab; synthetic SKU like `C:<brand>:<slug>`
- [ ] `products.brand` (default `IMECO`) and `products.competitor_of` columns
- [ ] Prices tab filters to IMECO only — wall display unchanged
- [ ] **Competitors** tab — IMECO vs competitors per marketplace: price, per-unit price,
      rating, stock, "undercut by", 30-day price gap

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
