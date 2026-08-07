# IMECO Price Tracker

Live selling prices for ~32 IMECO SKUs across **Amazon.in, Flipkart, Myntra and Blinkit**,
rendered as a SKU x marketplace heatmap.

Two halves:

- **`desktop/`** — a Python app (packaged to a double-clickable `.exe`) that scrapes prices and
  writes them to Supabase. Runs on a staff PC.
- **`src/`** — a static React dashboard that reads Supabase directly in the browser. Deploys to
  Vercel or Netlify.

```
   Staff PC (residential IP)              Supabase (Postgres)          Vercel / Netlify
  ┌──────────────────────────┐          ┌────────────────────┐       ┌────────────────┐
  │ IMECO Price Tracker.exe  │          │ products           │       │  React SPA     │
  │  ├ Amazon   direct HTTP  │──service─▶│ runs               │◀─anon─│  heatmap       │
  │  ├ Flipkart direct HTTP  │   key    │ price_snapshots    │  key  │  (static)      │
  │  ├ Myntra   direct HTTP  │  INSERT  │ latest_prices view │ SELECT└────────────────┘
  │  └ Blinkit  direct HTTP  │          └────────────────────┘
  └──────────────────────────┘
```

The dashboard polls every 2 minutes, so a scrape appears on screen without any redeploy.

## Why the scraper runs on a desktop

Requests originate from a **residential IP**, which is why all four marketplaces work with a
plain HTTP client. The same requests from a cloud runner (Vercel, GitHub Actions) come
from datacenter ranges that Amazon and Flipkart block far more aggressively.

**The tradeoff:** prices are only as fresh as the last run. The app offers to register a Windows
Scheduled Task that repeats **every hour** so it runs unattended whenever the PC is on, and the
dashboard turns amber past 2h and red past 6h rather than showing stale numbers quietly.

Hourly is a deliberate floor, not a limit of the tooling. A run touches ~77 listings and takes
about four minutes, because requests to any one host are serialised behind a 4-9s throttle —
that throttle is what keeps a residential IP looking like a person rather than a scraper.
Hourly puts ~770 requests/day on Amazon, the largest column, which has never tripped a defence
page. `desktop/schedule.py` accepts a shorter interval down to 30 minutes; below that the runs
overlap their own throttle windows. If you do shorten it, watch `blocked_count` on the `runs`
table for a day — a blocked scrape is worse than an hour-old price, because it takes the number
off the wall entirely.

---

## Setup

### 1. The pricing spreadsheet

**The real sheet is not in this repository.** This repo is public and `Docs/pricing link.xlsx`
holds IMECO's MRPs, intended selling prices and listing URLs, so it is gitignored. What IS
committed is [`Docs/pricing link.example.xlsx`](Docs/pricing%20link.example.xlsx), which has the
exact columns and two dummy rows — enough to build and run. Supply the real one either by
dropping it in as `Docs/pricing link.xlsx` before building, or through the desktop app's
**Spreadsheet** button afterwards.

`Docs/pricing link.xlsx` drives everything: which SKUs exist, their names, their MRPs and the
listing URL per marketplace. Columns are matched by HEADER TEXT, not position, so adding or
reordering columns is safe. Recognised headers:

```
SKU | Product Name | MRP | <Marketplace> SP | <Marketplace> Link
```

for `Amazon`, `Flipkart`, `Myntra` and `Blinkit`. Anything else — `Meesho Link`, for instance —
is ignored. A missing `<Marketplace> Link` means that cell renders as "not listed" rather than
as a failure.

**Updating it does not need a rebuild.** The `.exe` ships with a copy of the sheet so a fresh
install works immediately, but the **Spreadsheet** button lets an operator upload a newer one.
The uploaded copy is stored in `%LOCALAPPDATA%\IMECO Price Tracker\` — outside the app, so
replacing the `.exe` cannot destroy it — and takes precedence from the next run onward,
including the unattended hourly ones. Nothing changes until a file is actually chosen, and a
sheet that will not parse is rejected with the previous one left in force. "Use built-in"
reverts.

### 2. Supabase

1. supabase.com → **New project** (free tier). Region **Mumbai** or **Singapore**.
2. Save the database password somewhere safe.
3. **Project Settings → API** — copy three values:

   | Value | Goes to | Notes |
   |---|---|---|
   | Project URL | both | `https://xxxx.supabase.co` |
   | `anon` `public` key | dashboard | Safe to publish *because* RLS limits it to SELECT |
   | `service_role` `secret` key | desktop app only | Bypasses RLS. Never commit; never put in the dashboard |

4. **SQL Editor** → paste and run [`supabase/schema.sql`](supabase/schema.sql). Safe to re-run.

Then verify the anon key really is read-only — this is a security check, not a formality:

```sql
select tablename, policyname, cmd from pg_policies
where schemaname = 'public' and cmd <> 'SELECT';   -- must return zero rows
```

### 3. Dashboard config

```bash
cp .env.example .env       # then fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install
npm run dev                # http://localhost:5173
```

Without those two variables the dashboard renders `public/demo-prices.json` — a real captured
scrape — behind a permanent "DEMO DATA — NOT LIVE" banner, so it is demonstrable before the
database exists.

### 4. Deploy

Push to GitHub, import the repo in Vercel (Vite is autodetected), add `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` as environment variables, deploy.

### 5. Build and hand over the desktop app

```powershell
cd desktop
./build.ps1               # -> desktop/dist/IMECO Price Tracker.exe  (~35 MB)
```

First launch prompts for the Supabase URL and service_role key and stores them in **Windows
Credential Manager** —
they are *not* baked into the `.exe`, so the same file can be copied to another staff PC safely.
It then offers to register the Scheduled Task.

---

## Running from source

```bash
python -m desktop.catalogue                    # inspect what the spreadsheet parsed to
python -m desktop.probe                        # fetch + parse the known-good fixtures
python -m desktop.probe amazon <url>           # one listing
python -m desktop.run --dry-run                # full scrape, print, write nothing
python -m desktop.run                          # full scrape -> Supabase
python -m desktop.run --fixture public/demo-prices.json   # refresh the demo data
```

A full run takes **~3.5 minutes** for ~89 listings (more once Blinkit links are added).

## How the marketplaces are read

| Marketplace | Route | Source of truth | Notes |
|---|---|---|---|
| Amazon | direct | `a-price-whole`, `displayPrice` | MRP from `apex-basisprice-value` |
| Flipkart | direct | `ppd.fsp` in the embedded state | |
| Myntra | direct | `"price":{"mrp":N,"discounted":M}` | |
| Blinkit | direct | `schema.org/Product` JSON-LD | Also reports real stock status |

**Meesho is not supported.** Its pages are behind an Akamai anti-bot wall that refused every
method tested: plain HTTP, headless Chromium, headed Chromium, real Chrome with a persistent
profile, mobile user-agents, and every `api.*.meesho.com` subdomain. Two earlier in-house
projects (`Accumulate_Price_Maker`, `PriceChecker`) reached the same conclusion independently.
It would need a paid unblocker, and the spreadsheet has no `Meesho SP` column to check drift
against anyway. If it ever matters, the supplier panel export is the free route.

### Traps that are deliberately guarded against

These are all real failures found while building, and each is guarded in code:

- **Flipkart brotli.** Flipkart serves `br`, which crashes httpx's decoder. `fetch.py` sends
  `Accept-Encoding: gzip, deflate` on purpose — do not "fix" it by adding `br`.
- **Flipkart `finalPrice` is not the price.** On a page whose real price is 336, `finalPrice` is
  382. The displayed number is `fsp`. Regex on `₹` is worse still — it returns recommendation
  tile prices (154, 310, 174, 77).
- **Amazon per-unit price.** A loose `a-text-price` match picks up `apex-priceperunit-value`
  (e.g. ₹50.17 per 100 pulls) instead of the ₹499 list price. The MRP regex is pinned to
  `apex-basisprice-value`, and any MRP below the selling price is discarded.
- **Myntra's API 401s.** `myntra.com/gateway/v2/product/{id}` needs a session; the HTML page is
  the only way in.
- **Blinkit MRPs differ from the sheet.** Blinkit carries its own pack configurations (one
  listing reports MRP 249 where the sheet says 270). The pinned MRP column shows the sheet's
  value; discount maths uses each marketplace's own reported MRP.

### Status vocabulary — the rule everything rests on

**Absent must never be renderable as a value.** A blocked listing must not be mistakable for a
cheap one, and a delisted SKU must not be mistakable for a zero.

| Status | Meaning | Rendered as |
|---|---|---|
| `ok` | live price read | shaded cell |
| `not_listed` | no link in the spreadsheet | `·` hairline |
| `out_of_stock` | listing exists, cannot be bought | dimmed, struck through, keeps its price |
| `blocked` | anti-bot won, or credit budget exhausted | hatched, links to the listing |
| `error` | fetched but unparseable | red hairline `!` |

Only `ok` cells are ever shaded. This is also what makes a site redesign show up as a wall of
`error` rather than as stale numbers presented as live ones — enforced in Python
(`models.Cell.__post_init__`) *and* as a database `CHECK` constraint.

## The colour rule

One rule, no toggle. Within a single product row, the colour ranks that marketplace's live
selling price against the others:

| Colour | Meaning |
|---|---|
| **Green** | the highest price this product currently realises |
| **Green → yellow** | in between, one even step per distinct price in the row |
| **Yellow** | the lowest price this product realises |
| **Red** | out of stock — the price is kept, but it cannot be bought |
| **Black** | no price at all: not listed, blocked, or unreadable |

We are the seller, so the highest realised price is the good end of the ramp. This is not a
shopper's "cheapest wins" board — the `% off MRP` beside each price runs the other way, and
that is intentional: the colour says where the money is best, the annotation says how deep the
listing is discounted.

Ranking is **per row**, not across the grid. A ₹89 tissue box and a ₹450 wipes pack share no
meaningful scale, so a grid-wide ramp would just paint cheap products yellow and expensive ones
green while saying nothing about pricing. Rank also makes the reading independent of spread:
three marketplaces within ₹4 of each other still get a clear best and worst.

Out of stock sits outside the ranking on purpose: it is not a price anyone can pay today, so
letting it compete for "highest realised" would rank a sale that is not happening.

A row with only ONE live listing shades that price **green**. It is the highest price the
product realises, and the fact that it is also the lowest does not make that less true — an
unshaded cell beside black neighbours read as a gap, so the one channel still selling a product
looked like the one channel that had failed.

## Tests

```bash
npm test                  # colour scale, 17 tests
npm run typecheck
npm run build
```

## Things that will bite you

- **The parsers are the fragile part, not the fetching.** These are undocumented HTML shapes and
  none of the five sites offers a public price API. When a site redesigns, its column fills with
  `error`. Run `python -m desktop.probe` — it checks every adapter against listings whose live
  values were confirmed by hand, so a failure there means the adapter broke, not the listing.
- **Bright Data is optional and currently unused.** `fetch.py` keeps an escalation path that
  fires only if a direct fetch is refused; with no key configured it stays dormant. It is
  insurance in case a marketplace starts blocking this IP, not a dependency.
- **The board goes stale if nobody runs the app.** That is what the amber/red staleness badge
  and the Scheduled Task are for. Do not remove either.
- **`.env` is gitignored and holds a live key.** Check before committing.
- **The `service_role` key can write to the database.** It lives in Credential Manager, but
  anyone with admin on that PC can extract it. Fine for internal use; if the `.exe` ever leaves
  the company, replace the direct insert with a Supabase Edge Function behind a rotatable secret.
