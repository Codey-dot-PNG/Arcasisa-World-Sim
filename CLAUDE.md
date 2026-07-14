# The Arcasia Simulation Engine — Agent Guide

Persistent, browser-based multiplayer geopolitical simulation. The engine is a **generic,
data-driven world simulator**; the Republic of Arcasia (1962) is just the seed data. Players
role-play on Discord; this app is the source of truth for money, ownership, politics and news.

## Run it

```
node server.js            # http://localhost:4820  (PORT env overrides)
node server.js --reseed   # wipe the world back to the 1962 seed
```

Node 18+, **zero npm dependencies, no build step** (both are deliberate — never add a package
or a bundler). Seed logins: `gm`, `president`, `journalist`, `executive`, `citizen` (and more,
see [docs/WORLD-DATA.md](docs/WORLD-DATA.md)) — passphrase `arcasia` for all.
`.claude/launch.json` has an `arcasia` config for the preview tools.

## Documentation map — read what the task needs, not everything

| File | Read when working on… |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | anything — module layout, request flow, file vs Supabase storage, deployment |
| [docs/WORLD-DATA.md](docs/WORLD-DATA.md) | the world document: collections, schemas, id conventions, migrations, seed |
| [docs/SIMULATION.md](docs/SIMULATION.md) | turns, events/effects/expressions, economy, foreign trade, stock market, elections |
| [docs/WAR.md](docs/WAR.md) | the realtime battlefield RTS: war state, tick pipeline, AI grand strategy, scenario format |
| [docs/API.md](docs/API.md) | HTTP endpoints, auth, roles/permissions, the ownership-control chain |
| [docs/FRONTEND.md](docs/FRONTEND.md) | the client: vanilla-JS modules, rendering, map, GM Studio, realtime sync |
| [docs/CONVENTIONS.md](docs/CONVENTIONS.md) | before writing ANY code — patterns, invariants, known gotchas |
| [docs/SYNC-ARCHITECTURE.md](docs/SYNC-ARCHITECTURE.md) | (pre-existing) deep dive on cloud persistence/realtime debugging |
| [DEPLOY.md](DEPLOY.md) | Vercel + Supabase hosting setup |

## Hard rules (violating these breaks the game)

1. **Zero dependencies.** Server is plain Node stdlib; client is hand-written vanilla JS/CSS
   loaded via `<script>` tags in `public/index.html`.
2. **Every mutation follows the pattern:** mutate the in-memory db → `store.log(...)` (audit
   timeline) → `store.save()` → `api.broadcast('sync')`. Money moves ONLY through `sim.txn()`
   (or `ledgerTxn` inside the per-turn economy). See docs/CONVENTIONS.md.
3. **Everything must work serverless.** Code also runs on Vercel where there is no long-lived
   process: no reliance on module-level timers or in-memory state across requests. Wall-clock
   work rides requests through gated ticks (see `market.maybeDayTick`).
4. **`store.migrate()` is the only place for schema upgrades.** It must stay idempotent and
   additive — it runs on *every* load (every request, in cloud mode). Gate one-shot changes on
   `world.schema` (currently 4) or a `world._flag`.
5. **Canonical record + mirror:** shareholder register ↔ share-certificate items
   (`market.setHolding`), `property.ownerId` ↔ deed items (`deeds.transfer`), presidency ↔
   `ent_gov.ceoId/executives` (`sim.syncPresidency`). Always go through the choke point; never
   update one side alone.
6. **`server/pricepath.js` and `public/js/pricepath.js` must stay byte-identical** — server and
   clients deterministically compute the same live price wiggle.
7. **The engine stays generic.** No Arcasia-specific names/rules in engine code (`sim.js`
   effects, market, elections). World specifics belong in seed/migration data. (Existing
   well-known ids like `ent_gov`, `ent_bank`, `acct_treasury` are the sanctioned exceptions.)
8. **The server is authoritative.** Clients only render/animate what the API returns (casino
   outcomes, prices, elections). Permission filtering happens server-side in
   `api.filterState` — never ship hidden data and hide it in the UI.

## Quick module index

```
server.js              HTTP server, static files, long-lived timers (local mode only)
api/index.js           Vercel serverless entry (same handler, per-request begin/commit + CAS retry)
server/store.js        persistence (file | supabase), migrate(), snapshots, audit log
server/seed.js         the 1962 world as pure data (fresh seed = data/baseline-world.json if present)
server/sim.js          expression lang, event engine, turn loop, economy, elections, presidency
server/api.js          auth, permission filtering (filterState), all REST routes, SSE hub
server/market.js       stock market: turn price + day market, National Bank counterparty
server/ownership.js    "who controls whom" chain (owner/CEO/leader/majority shares)
server/deeds.js        property deeds as tradeable items (mirror of property.ownerId)
server/casino.js       roulette/blackjack/lottery — outcomes decided server-side
server/war.js          realtime battlefield RTS engine (generic — see docs/WAR.md)
server/war-ai.js       commander-hierarchy AI (national commands/corps/defender doctrine) — byte-identical to public/js/war-ai.js
server/war-scenarios.js scenario data (attacker/defender, objectives, roster) — no engine logic
server/buildings.js    map building texture assignment per property kind
server/geometry.js     point-in-polygon province lookup for map placement
server/mapdata.js      map document (labels/roads/rails/countries); applyMap() self-heal
server/map-geometry.js AUTO-GENERATED from the master SVG — do not edit (tools/build-mapdata.js)
server/supabase.js     minimal PostgREST/Realtime client (plain fetch)
public/js/*            client modules — see docs/FRONTEND.md
tools/                 build-mapdata.js, diagnose-sync.js, migrate-world.js
data/                  world.json (live state — do not hand-edit while running), snapshots/
```

Currency: **Arcasian Koren**, symbol `₳`, code ARK (`settings.currency` / `currencyName`).
