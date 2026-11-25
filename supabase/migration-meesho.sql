-- MIGRATION: Meesho prices, read from the "Meesho Product Sheet" Google Sheet by
-- desktop/meesho.py — never scraped. Saved only when a price or stock state changes, so these
-- rows are sparse by design; the dashboard carries each one forward until the next change.
-- Safe to run more than once. Also part of schema.sql.
-- Drops the old marketplace / via checks whatever they were named, then adds the wider ones.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'price_snapshots'::regclass and contype = 'c'
      and (pg_get_constraintdef(oid) ~ '\mmarketplace\M' or pg_get_constraintdef(oid) ~ '\mvia\M')
  loop
    execute format('alter table price_snapshots drop constraint %I', c.conname);
  end loop;
end $$;
alter table price_snapshots add constraint price_snapshots_marketplace_check
  check (marketplace in ('amazon','flipkart','myntra','blinkit','meesho'));
alter table price_snapshots add constraint price_snapshots_via_check
  check (via in ('direct','brightdata','none','sheet'));
