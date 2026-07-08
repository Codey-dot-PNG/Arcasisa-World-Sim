-- ═══════════════════════════════════════════════════════════════════
-- ARCASIA SIMULATION ENGINE — Supabase setup
-- Paste this whole file into your Supabase project's SQL Editor and Run.
-- Safe to re-run; it only creates what is missing.
-- ═══════════════════════════════════════════════════════════════════

-- The world: one JSONB document. `version` changes on every write so the
-- serverless functions know when their warm cache is stale.
create table if not exists world (
  id      int primary key,
  version bigint not null,
  doc     jsonb  not null
);

-- Append-only audit log (The Record / wire ticker).
create table if not exists timeline (
  id       text primary key,
  ts       bigint not null,
  turn     int,
  sim_date text,
  type     text,
  title    text,
  detail   text,
  actor    text,
  refs     jsonb default '[]'::jsonb
);
create index if not exists timeline_ts_idx on timeline (ts desc);

-- Append-only bank ledger.
create table if not exists transactions (
  id        text primary key,
  ts        bigint not null,
  turn      int,
  sim_date  text,
  from_acct text,
  to_acct   text,
  amount    double precision,
  memo      text,
  actor     text,
  kind      text
);
create index if not exists transactions_ts_idx on transactions (ts desc);

-- Rollback snapshots (one per turn-advance).
create table if not exists snapshots (
  turn int primary key,
  ts   bigint not null,
  doc  jsonb not null
);

-- Lock everything down: row level security ON with no policies means the
-- public anon key can read and write NOTHING. The engine talks to these
-- tables exclusively with the service_role key, which bypasses RLS.
alter table world        enable row level security;
alter table timeline     enable row level security;
alter table transactions enable row level security;
alter table snapshots    enable row level security;

-- Housekeeping called by the engine after turn advances: keeps the logs and
-- snapshot archive bounded so the free tier never fills up.
create or replace function prune_arcasia() returns void
language sql security definer as $$
  delete from timeline
   where ts < coalesce((select ts from timeline order by ts desc offset 8000 limit 1), 0);
  delete from transactions
   where ts < coalesce((select ts from transactions order by ts desc offset 12000 limit 1), 0);
  -- prune by write time, not turn number: after a rollback the freshest
  -- snapshots can carry lower turn numbers than stale ones
  delete from snapshots
   where ts < coalesce((select ts from snapshots order by ts desc offset 20 limit 1), 0);
$$;

-- Realtime change signal: a tiny version row clients subscribe to via
-- postgres_changes. Contains no world data, so anon read access is harmless.
create table if not exists world_version (
  id         int primary key,
  version    bigint not null,
  updated_at timestamptz not null default now()
);
alter table world_version enable row level security;
drop policy if exists world_version_read on world_version;
create policy world_version_read on world_version for select to anon, authenticated using (true);
-- add to the realtime publication (ignore if already added)
do $$ begin
  alter publication supabase_realtime add table world_version;
exception when duplicate_object then null; end $$;
