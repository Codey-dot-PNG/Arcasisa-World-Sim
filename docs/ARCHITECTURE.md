# Architecture

## Big picture

One codebase, two deployment shapes, **identical handler code**:

| | Local / self-hosted | Vercel + Supabase |
|---|---|---|
| Entry | `server.js` (long-lived `http` server) | `api/index.js` (serverless function per request) |
| Storage | `data/world.json` (atomic file writes) | Postgres JSONB row (`world` table, id=1) via PostgREST |
| Realtime | Server-Sent Events (`/api/stream`) | Supabase Realtime broadcast (`world_version` table + channel ping) |
| Turn timer | `setInterval` in the process | `/api/cron` endpoint (Vercel Cron or any pinger) + `autoTick()` |
| Day-market ticker | 5s `setInterval` in `server.js` | gated tick ridden by `GET /api/state` (`market.maybeDayTick`) |

Mode is decided once in `server/store.js`: `MODE = 'supabase'` iff `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` env vars are set, else `'file'`. Handlers never branch on it —
persistence differences are contained in `store.js`.

## Request flow

```
HTTP request
  └─ /api/*  → (cloud mode: store.begin() — load world or reuse warm cache)
             → api.handle(req, res, pathname, method)   [server/api.js]
                 · getUser() from arcsid cookie → { user, role }
                 · route match → validate → mutate db → store.log → store.save → broadcast('sync')
             → (cloud mode: store.commit() — CAS write + flush log rows + realtime ping)
  └─ else    → static file from public/ (SPA fallback to index.html for extension-less paths)
```

In cloud mode (`api/index.js`) the response is **buffered** so nothing reaches the client until
`commit()` lands; on a CAS version conflict (`WORLD_CONFLICT`) the whole attempt re-runs against
fresh state (body was read once up front; `store.invalidate()` drops the poisoned cache).

## The store (server/store.js)

- The whole world is **one JSON document** (`db`), mutated synchronously in memory by all
  handlers. Persistence happens at the edges.
- **File mode:** `save()` marks dirty and debounces a 400ms atomic write (tmp + rename);
  `saveNow()` is synchronous (used on shutdown/SIGINT and a 60s safety interval). `fileRev`
  bumps on every save so `getVersion()` is meaningful in both modes.
- **Cloud mode:** `begin()` per request loads the doc if the stored `version` changed
  (otherwise reuses the warm module-level cache); `commit()` does a compare-and-swap
  (`version=eq.N`) update, inserts pending timeline/transaction rows, upserts one snapshot at
  most, upserts `world_version`, and broadcasts `sync`. The doc stored in Postgres **excludes**
  `timeline`/`transactions` (append-only tables of their own; last 400 loaded per request).
- **Snapshots:** one before every turn (`sim.advanceTurn` calls `store.snapshot()`), 60 kept,
  pruned by write-time. GM can roll back (`/api/gm/rollback`) — rollback preserves live
  `users`/`sessions`/`roles` so nobody is locked out.
- **`migrate(world)`:** brings any loaded/imported/rolled-back world up to the current schema.
  Runs on every load in file mode and on every `begin()` reload in cloud mode, and on fresh
  seeds too — so ALL structural upgrades live only here. Must stay idempotent. One-shot fixes
  are gated on `world.schema` (currently 4) or boolean flags like `world._loreFixes1`.
- **Audit:** `store.log(type, title, detail, actor, refs)` → `db.timeline` (cap 8000);
  `store.recordTxn(t)` → `db.transactions` (cap 12000). Both mirrored to Supabase tables in
  cloud mode. `refs` (entity ids) drive per-player timeline visibility.

## Boot sequence (local)

`server.js`: `store.load(seed, --reseed?)` → `mapdata.applyMap()` self-heal (worlds predating
the SVG map) → `sim.setLongLived(true)` → `sim.init(api.broadcast)` → `sim.updateDerived()` →
`sim.scheduleAuto()` (auto-advance timer if `settings.time.auto.enabled`) → listen. Plus the
60s save flush and the 5s day-market tick, both `.unref()`ed.

## Realtime

`api.broadcast(type, data)` writes SSE frames to connected `/api/stream` clients (file mode)
and flags `store.requestBroadcast()` so cloud commits ping Supabase Realtime. Clients react to
`sync` by refetching `GET /api/state` (which returns a permission-filtered world + version `v`,
letting clients skip no-op re-renders). See docs/SYNC-ARCHITECTURE.md for the cloud sync deep
dive and `tools/diagnose-sync.js` for verification.

## Seeding

`seed.js` exports `seed: seedWorld` — which loads `data/baseline-world.json` if present
(the calibrated 1960-baseline world) and falls back to the coded `seed()` otherwise. Everything
seeded is plain data; the GM can edit all of it in the UI.

## Deployment notes

- `vercel.json` rewrites `/api/:path*` → `/api/index` and schedules `/api/cron` daily.
- `supabase-setup.sql` creates tables/RLS/publication — must be re-run in the Supabase SQL
  editor whenever it changes.
- File mode on an ephemeral host (Vercel/Render/Railway detected via env) prints a loud
  data-loss warning and `/api/config` tells the client to show one too.
- `DATA_DIR` env relocates the world file (e.g. onto a mounted volume).
