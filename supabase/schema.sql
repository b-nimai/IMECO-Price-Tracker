-- IMECO Price Tracker — database schema.
--
-- Run once in the Supabase SQL Editor (Project -> SQL Editor -> New query -> Run).
-- Safe to re-run: every statement is idempotent.
--
-- SECURITY MODEL, in one line: the dashboard's anon key is compiled into a public JavaScript
-- bundle, so it MUST be incapable of writing. Everything below exists to guarantee that.
-- Writes happen only with the service_role key, which lives in the desktop app.

-- ── Tables ──────────────────────────────────────────────────────────────────────────────

-- The catalogue, mirrored from Docs/pricing link.xlsx on every run.
create table if not exists products (
  sku        text primary key,
  name       text not null,
  mrp        numeric,
  starred    boolean not null default false,   -- the U+2605 marker in the sheet's SKU column
  -- The product's row order in the workbook. The dashboard sorts on it, so the board reads in
  -- the same order as the sheet. NULL means "the current sheet does not list this SKU any
  -- more" — those rows are kept for their price history and sorted last.
  position   integer,
  target_sp  jsonb  not null default '{}'::jsonb,  -- {"amazon":299,"myntra":259}
  urls       jsonb  not null default '{}'::jsonb,  -- {"amazon":"https://...", ...}
  updated_at timestamptz not null default now()
);

-- MIGRATION for databases created before `position` existed. Harmless on a fresh one.
alter table products add column if not exists position integer;

-- MIGRATION: competitors, from the workbook's optional "Competitors" sheet. Their rows live in
-- this same table so the scraper, snapshots and every view treat them like any listing; these
-- two columns are what keep them OFF the wall display. `competitor_of` is the IMECO SKU a row
-- is compared against, NULL for IMECO's own products.
alter table products add column if not exists brand text not null default 'IMECO';
alter table products add column if not exists competitor_of text
  references products(sku) on delete set null;
create index if not exists products_competitor_of_idx on products (competitor_of);

-- One row per execution of the desktop app.
create table if not exists runs (
  id            uuid primary key default gen_random_uuid(),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  source        text not null default 'manual'
                  check (source in ('manual', 'scheduled')),
  ok_count      integer not null default 0,
  error_count   integer not null default 0,
  blocked_count integer not null default 0,
  credits_used  integer not null default 0     -- Bright Data requests spent this run
);

-- The measurements. Append-only: a price is a fact about a moment, never updated in place.
create table if not exists price_snapshots (
  id          bigserial primary key,
  run_id      uuid not null references runs(id) on delete cascade,
  sku         text not null references products(sku) on delete cascade,
  marketplace text not null
                check (marketplace in ('amazon','flipkart','myntra','blinkit')),

  -- NULL unless status is 'ok' or 'out_of_stock'. An OOS listing keeps its price because the
  -- number is still true — it is what the item costs when stock returns.
  price       numeric,
  -- As reported by THIS marketplace, which is not always products.mrp: Blinkit carries its own
  -- pack configurations and reports different MRPs (e.g. 249 where the sheet says 270).
  mrp         numeric,
  unit        text,          -- pack size, e.g. "6 x 100 pulls". Blinkit only.

  status      text not null
                check (status in ('ok','not_listed','out_of_stock','blocked','error')),
  via         text not null default 'direct'
                check (via in ('direct','brightdata','none')),
  note        text,          -- why, for any non-ok status. Shown in the dashboard tooltip.
  checked_at  timestamptz not null default now(),

  -- The invariant the entire status vocabulary rests on: 'ok' cannot exist without a number.
  -- Enforced here as well as in Python so no future writer can bypass it.
  constraint ok_requires_price check (status <> 'ok' or price is not null)
);

-- Serves the latest_prices view below: one index lookup per (sku, marketplace).
create index if not exists price_snapshots_latest_idx
  on price_snapshots (sku, marketplace, checked_at desc);

create index if not exists price_snapshots_run_idx on price_snapshots (run_id);

-- MIGRATION: star ratings, read from the product pages already fetched (Amazon, Flipkart).
-- Nullable — Blinkit shows none, a new listing has none yet, and every row written before
-- these existed has none.
alter table price_snapshots add column if not exists rating numeric
  check (rating is null or (rating > 0 and rating <= 5));
alter table price_snapshots add column if not exists rating_count integer
  check (rating_count is null or rating_count >= 0);

-- Every Blinkit dark store's answer for every listing, from the full walk the desktop app does
-- every few hours (run.ALL_STORES_EVERY_HOURS). The board's cell answers "is it live anywhere";
-- these rows answer WHERE. Kept apart from price_snapshots so latest_prices, and with it the
-- wall display, is untouched by them.
create table if not exists availability_checks (
  id          bigserial primary key,
  run_id      uuid not null references runs(id) on delete cascade,
  sku         text not null references products(sku) on delete cascade,
  marketplace text not null default 'blinkit' check (marketplace in ('blinkit')),
  city        text not null,
  area        text not null,           -- the dark store's neighbourhood, e.g. "Dum Dum"
  lat         numeric not null,
  lon         numeric not null,
  status      text not null
                check (status in ('ok','not_listed','out_of_stock','blocked','error')),
  price       numeric,
  note        text,
  checked_at  timestamptz not null default now(),
  constraint ok_requires_price check (status <> 'ok' or price is not null)
);

create index if not exists availability_checks_latest_idx
  on availability_checks (sku, area, checked_at desc);
create index if not exists availability_checks_run_idx on availability_checks (run_id);

-- The daily keyword search (desktop/search.py): every result on the first page, in the order
-- the marketplace showed it, ads included — ours, competitors' and everyone else's.
create table if not exists search_results (
  id          bigserial primary key,
  run_id      uuid not null references runs(id) on delete cascade,
  keyword     text not null,
  marketplace text not null check (marketplace in ('amazon','flipkart','blinkit')),
  position    integer not null check (position > 0),
  listing_id  text not null,           -- ASIN / Flipkart pid / Blinkit prid
  title       text,
  brand       text,                    -- 'IMECO' for ours; NULL when it could not be told
  matched_sku text references products(sku) on delete set null,  -- when it IS a sheet product
  price       numeric,
  sponsored   boolean not null default false,
  checked_at  timestamptz not null default now()
);

create index if not exists search_results_keyword_idx
  on search_results (keyword, marketplace, checked_at desc);
create index if not exists search_results_run_idx on search_results (run_id);

-- ── What the dashboard reads ────────────────────────────────────────────────────────────

-- One row per SKU x marketplace, most recent first. The SPA fetches this rather than the raw
-- table so it never downloads history it does not display.
--
-- security_invoker is important: without it the view would run as its owner and silently
-- bypass the RLS policies below, which is the classic way a "read-only" anon key stops being
-- read-only.
create or replace view latest_prices
  with (security_invoker = on) as
  select distinct on (sku, marketplace) *
  from price_snapshots
  order by sku, marketplace, checked_at desc;

-- One row per SKU x marketplace summarising its price history, for the dashboard's Trends tab.
-- Aggregated here because the browser cannot afford the raw rows: 30 days is ~75k snapshots,
-- and PostgREST caps a response at 1,000.
--
-- Lows and highs count only `ok` readings, a price someone could actually pay. Changes count
-- `out_of_stock` readings too, because an OOS listing still carries its true price (see
-- price_snapshots.price above).
create or replace view price_stats
  with (security_invoker = on) as
  with priced as (
    select sku, marketplace, price, status, checked_at,
           lag(price) over (partition by sku, marketplace order by checked_at) as prev_price
    from price_snapshots
    where status in ('ok', 'out_of_stock') and price is not null
  )
  select sku, marketplace,
         min(price) filter (where status = 'ok')                                         as min_ever,
         max(price) filter (where status = 'ok')                                         as max_ever,
         min(price) filter (where status = 'ok' and checked_at >= now() - interval '30 days') as min_30d,
         max(price) filter (where status = 'ok' and checked_at >= now() - interval '30 days') as max_30d,
         count(*)   filter (where checked_at >= now() - interval '30 days'
                              and prev_price is not null and prev_price <> price)         as changes_30d,
         min(checked_at)                                                                  as first_seen
  from priced
  group by sku, marketplace;

-- One row per listing per day (India time) for the last 90 days: the day's closing live price,
-- its low and high, and how many readings found it in stock. The Overview's sparklines and the
-- Trends cards read this rather than ~2.5k raw snapshots a day.
create or replace view price_daily
  with (security_invoker = on) as
  select sku, marketplace,
         (checked_at at time zone 'Asia/Kolkata')::date                             as day,
         (array_agg(price order by checked_at desc)
            filter (where status = 'ok' and price is not null))[1]                  as close_price,
         min(price) filter (where status = 'ok')                                     as low_price,
         max(price) filter (where status = 'ok')                                     as high_price,
         count(*)   filter (where status in ('ok', 'out_of_stock'))                  as readings,
         count(*)   filter (where status = 'ok')                                     as in_stock
  from price_snapshots
  where checked_at >= now() - interval '90 days'
  group by sku, marketplace, day;

-- In-stock share per listing over the last 7 and 30 days, from the hourly readings, plus how
-- long the CURRENT state has lasted. Only `ok` and `out_of_stock` readings count: a blocked or
-- failed fetch says nothing about stock, and counting it either way would make a bad scrape
-- night look like a stockout.
create or replace view availability_stats
  with (security_invoker = on) as
  with readings as (
    select sku, marketplace, status, checked_at
    from price_snapshots
    where status in ('ok', 'out_of_stock') and checked_at >= now() - interval '30 days'
  ),
  latest as (
    select distinct on (sku, marketplace) sku, marketplace, status
    from readings
    order by sku, marketplace, checked_at desc
  ),
  -- The newest reading in the OTHER state: the current state began just after it.
  flipped as (
    select r.sku, r.marketplace, max(r.checked_at) as last_other
    from readings r
    join latest l on l.sku = r.sku and l.marketplace = r.marketplace
    where r.status <> l.status
    group by r.sku, r.marketplace
  )
  select l.sku, l.marketplace,
         l.status                                                                  as status_now,
         count(*) filter (where r.checked_at >= now() - interval '7 days')         as checks_7d,
         count(*) filter (where r.checked_at >= now() - interval '7 days'
                            and r.status = 'ok')                                    as in_stock_7d,
         count(*)                                                                   as checks_30d,
         count(*) filter (where r.status = 'ok')                                    as in_stock_30d,
         min(r.checked_at) filter (where f.last_other is null
                                      or r.checked_at > f.last_other)               as status_since,
         f.last_other is null                                                       as unchanged_30d
  from latest l
  join readings r on r.sku = l.sku and r.marketplace = l.marketplace
  left join flipped f on f.sku = l.sku and f.marketplace = l.marketplace
  group by l.sku, l.marketplace, l.status, f.last_other;

-- Each Blinkit dark store's latest answer per listing, and its in-stock share over 7 days.
create or replace view blinkit_store_stats
  with (security_invoker = on) as
  select sku, area, city,
         (array_agg(status order by checked_at desc))[1]          as status_now,
         (array_agg(price  order by checked_at desc))[1]          as price_now,
         max(checked_at)                                          as checked_at,
         count(*) filter (where status in ('ok', 'out_of_stock')) as checks_7d,
         count(*) filter (where status = 'ok')                    as in_stock_7d
  from availability_checks
  where checked_at >= now() - interval '7 days'
  group by sku, area, city;

-- Latest rating per listing, against the earliest one inside the last 30 days, so the Reviews
-- tab can say "4.3, down from 4.4" and "+12 ratings".
create or replace view rating_trend
  with (security_invoker = on) as
  with rated as (
    select sku, marketplace, rating, rating_count, checked_at
    from price_snapshots
    where rating is not null
  ),
  latest as (
    select distinct on (sku, marketplace) *
    from rated
    order by sku, marketplace, checked_at desc
  )
  select l.sku, l.marketplace, l.rating, l.rating_count, l.checked_at,
         f.rating as rating_then, f.rating_count as count_then, f.checked_at as then_at
  from latest l
  left join lateral (
    select r.rating, r.rating_count, r.checked_at
    from rated r
    where r.sku = l.sku and r.marketplace = l.marketplace
      and r.checked_at >= now() - interval '30 days'
    order by r.checked_at asc
    limit 1
  ) f on true;

-- Every result of the newest search per keyword x marketplace — the Search tab's detail list.
create or replace view search_latest
  with (security_invoker = on) as
  with newest as (
    select distinct on (keyword, marketplace) keyword, marketplace, run_id
    from search_results
    order by keyword, marketplace, checked_at desc
  )
  select s.keyword, s.marketplace, s.position, s.listing_id, s.title, s.brand, s.matched_sku,
         s.price, s.sponsored, s.checked_at
  from search_results s
  join newest n on n.keyword = s.keyword and n.marketplace = s.marketplace and n.run_id = s.run_id;

-- One row per keyword x marketplace x day (India time), from that day's newest search: IMECO's
-- best rank (any, and organic only), how much of the top 10 is ours, and how many of our
-- results were ads. A manual re-run the same day replaces, never doubles, the day's figures.
create or replace view search_rank_daily
  with (security_invoker = on) as
  with day_runs as (
    select distinct on (keyword, marketplace, (checked_at at time zone 'Asia/Kolkata')::date)
           keyword, marketplace, (checked_at at time zone 'Asia/Kolkata')::date as day, run_id
    from search_results
    order by keyword, marketplace, (checked_at at time zone 'Asia/Kolkata')::date, checked_at desc
  )
  select d.keyword, d.marketplace, d.day,
         count(*)                                                                 as results,
         min(s.position) filter (where s.brand = 'IMECO')                         as best_rank,
         min(s.position) filter (where s.brand = 'IMECO' and not s.sponsored)     as best_organic_rank,
         count(*) filter (where s.brand = 'IMECO' and s.position <= 10)           as imeco_top10,
         count(*) filter (where s.position <= 10)                                 as top10,
         count(*) filter (where s.brand = 'IMECO' and s.sponsored)                as imeco_ads
  from day_runs d
  join search_results s
    on s.keyword = d.keyword and s.marketplace = d.marketplace and s.run_id = d.run_id
  group by d.keyword, d.marketplace, d.day;

-- ── Row Level Security ──────────────────────────────────────────────────────────────────
-- With RLS enabled and only SELECT policies defined, anon can read and nothing else.
-- service_role bypasses RLS entirely, which is how the desktop app writes.

alter table products        enable row level security;
alter table runs            enable row level security;
alter table price_snapshots enable row level security;
alter table availability_checks enable row level security;
alter table search_results      enable row level security;

drop policy if exists "public read products"  on products;
drop policy if exists "public read runs"      on runs;
drop policy if exists "public read snapshots" on price_snapshots;
drop policy if exists "public read availability" on availability_checks;
drop policy if exists "public read search" on search_results;

create policy "public read products"  on products        for select to anon, authenticated using (true);
create policy "public read runs"      on runs            for select to anon, authenticated using (true);
create policy "public read snapshots" on price_snapshots for select to anon, authenticated using (true);
create policy "public read availability" on availability_checks for select to anon, authenticated using (true);
create policy "public read search" on search_results for select to anon, authenticated using (true);

grant select on products, runs, price_snapshots, latest_prices, price_stats, price_daily,
                availability_checks, availability_stats, blinkit_store_stats, rating_trend,
                search_results, search_latest, search_rank_daily
  to anon, authenticated;

-- ── Verification ────────────────────────────────────────────────────────────────────────
-- Confirms no INSERT/UPDATE/DELETE policy was created by accident. Expect zero rows.
--
--   select tablename, policyname, cmd from pg_policies
--   where schemaname = 'public' and cmd <> 'SELECT';
