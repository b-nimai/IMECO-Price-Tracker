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

-- ── Row Level Security ──────────────────────────────────────────────────────────────────
-- With RLS enabled and only SELECT policies defined, anon can read and nothing else.
-- service_role bypasses RLS entirely, which is how the desktop app writes.

alter table products        enable row level security;
alter table runs            enable row level security;
alter table price_snapshots enable row level security;

drop policy if exists "public read products"  on products;
drop policy if exists "public read runs"      on runs;
drop policy if exists "public read snapshots" on price_snapshots;

create policy "public read products"  on products        for select to anon, authenticated using (true);
create policy "public read runs"      on runs            for select to anon, authenticated using (true);
create policy "public read snapshots" on price_snapshots for select to anon, authenticated using (true);

grant select on products, runs, price_snapshots, latest_prices to anon, authenticated;

-- ── Verification ────────────────────────────────────────────────────────────────────────
-- Confirms no INSERT/UPDATE/DELETE policy was created by accident. Expect zero rows.
--
--   select tablename, policyname, cmd from pg_policies
--   where schemaname = 'public' and cmd <> 'SELECT';
