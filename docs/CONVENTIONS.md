# Conventions, Invariants & Gotchas

Read this before writing code. Most of these were learned the hard way — several comments in
the codebase document past regressions.

## Code style

- Plain CommonJS (`require`/`module.exports`), `'use strict'` at the top of every file.
- Zero dependencies, server and client. No npm installs, no build tools, no TypeScript.
- Comments are prose explaining *why*, often referencing the phase/workstream that introduced
  the feature ("Phase 13 — …", "Workstream A5 — …"). Match that style; keep the phase
  breadcrumbs when touching related code.
- Ids via `store.uid(prefix)`. Money rounded to 2dp; vars to 4dp (`applyOp`). Percent-like
  metrics clamped 0–100.

## The mutation contract (server)

Every state change follows:
```js
// 1. validate (return bad()/deny() early)   2. mutate db in place
store.log(type, title, detail, actor, refs); // audit — refs + actor drive player timeline visibility
store.save();                                 // debounced file write / cloud dirty flag
broadcast('sync');                            // ping OTHER clients to refetch
```
- Log every player-visible action, with the operator's `displayName` as `actor` (that is how
  their own Record/Office Ledger finds it) and the affected entity ids in `refs`. Edits should
  say WHAT changed: `describeChanges(obj, patch, secretKeys)` in api.js builds the
  "field: old → new" detail (GM collection/settings/user edits use it). War unit move orders
  are the deliberate exception (too frequent; the war's own milestones are logged).
- `broadcast('sync')` is for changes other players must see promptly. High-frequency churn
  whose consumers already pull it (war ticks/orders → the ~1s war heartbeat) saves WITHOUT
  broadcasting — a ping per tick/order forces every client into a full refetch and lags the
  whole app (docs/SYNC-ARCHITECTURE.md, invariant 9).
- The mutating client itself doesn't need the broadcast: `json()` auto-attaches a `sync`
  payload (fresh filtered world + polling) to successful mutating responses, and core.js
  applies it in the same round-trip (response-sync — docs/SYNC-ARCHITECTURE.md). This is
  free for new routes; don't hand-roll post-write refetches client-side.
- Money moves **only** through `sim.txn()` (logged, news on big transfers) or `ledgerTxn()`
  (per-turn economy — records the transaction but skips the per-call timeline entry; emit one
  summary log per turn instead). Never touch `account.balance` directly.
- `txn(null, acct, …)` mints at the world edge; `txn(acct, null, …)` burns. Engine events may
  overdraw (the world must never jam); player routes must check balances first.
- Timeline types in use: `economy, ownership, market, inventory, news, politics, election,
  simulation, system, gm, event, time, error`. Players only ever see
  economy/ownership/market/inventory entries referencing their own chain.

## Canonical record + mirror (do NOT bypass the choke points)

| Canonical | Mirror | Choke point |
|---|---|---|
| `company.shareholders` | share-certificate item in holders' inventories | `market.setHolding` / `syncAllCertificates` |
| `property.ownerId` | deed item (qty 1) in owner's inventory | `deeds.transfer` / `syncAllDeeds` |
| users with `president` role | `ent_gov.ceoId` + `executives` (+ titles) | `sim.syncPresidency` |
| property `kind` | `texture` art file | `buildings.assignTexture` / `syncAllTextures` |

Item-move code must special-case `item.meta.companyId` / `item.meta.propertyId` and route
through market/deeds (see the `moveItem` helper in trade-accept, `/api/trade`, and
`/api/gm/give-item` for the pattern).

## migrate() rules (server/store.js)

- Runs on EVERY load — file boot, every cloud `begin()` reload, fresh seeds, imports,
  rollbacks. Must be idempotent and additive; return `changed` accurately.
- One-shot transformations gate on `world.schema` (bump it) or a `world._flag`. Additive
  defaults use the `need(key, default)` / `=== undefined` style.
- Never clobber GM-tuned values — guard on "still carries the old default" before rewriting
  (see the currency, music, and ev_market blocks for the pattern).

## Serverless correctness

- No new module-level `setInterval`s that gameplay depends on — `server.js` timers only run
  locally. Time-based behaviour must also work per-request (pattern: `maybeDayTick`'s
  wall-clock gate stored on the db doc, e.g. `db._lastDayTick`).
- Cloud mode reloads the world per request when the version changed; module-level caches
  outside the db doc will silently desync. Keep transient engine state ON the world doc.
- Handlers must not write to the response before mutations are final — the serverless entry
  buffers responses and retries the whole request on CAS conflict.
- Known accepted wart: GM dry-run (`run-event` with `dryRun`) restores the db but pending
  timeline/txn buffer rows still flush in cloud mode (phantom log entries).

## Permission model

- Role perms split into **clearance** (what a role may SEE: pages, statistics, map layers,
  "government information") and **abilities** (what it may DO — `perms.abilities`, catalogue
  `ABILITIES` in api.js, mirrored by `ROLE_ABILITIES` in gm.js). Never gate an action on a
  clearance flag: until Phase 36 the government/military-layer flags let every MP and judge
  command the police and bomb a peaceful protest.
- Authorisation = role perms + the **ownership chain** (`ownership.controls`), never entity
  identity alone. Delegated actions go through `ownership.canAct(db, me, entity, scope)`
  (chain first, then roster grants) — use it, not `controls`, on any route a grant scope covers. A CEO controls their company's subsidiaries, properties, accounts; the
  President controls the government chain (which does NOT reach privately-owned companies —
  see the Satrom-casino regression note in api.js around line 353).
- New state exposed to clients must be classified in `api.filterState` — public, statistics-
  gated, chain-scoped, or GM-only. The client is untrusted.
- Casino/blackjack state (`db.casinoHands`) is intentionally never shipped.

## Two-price market invariants

- `sharePrice` (turn/fundamental) and `dayPrice` (speculative) are distinct; don't conflate.
  Certificate `item.marketValue` tracks the DAY price.
- After any direct `dayPrice` write: `nudgeConfidence` → `dayReanchor(co)` → sync the cert
  item's `marketValue` (see `applyDayImpact` / `remarkFromTrade`).
- `server/pricepath.js` ≡ `public/js/pricepath.js` — change both or neither.
- The National Bank (`ent_bank`) is counterparty to ALL share cash flows; its reserve going
  negative is a designed failure state (bank crisis), not a bug to "fix" with clamps.

## Map

- All coordinates are on the **3840×2160** master grid. `server/map-geometry.js` is
  auto-generated by `tools/build-mapdata.js` from the master SVG — regenerate, don't edit.
- Placing/moving properties/markers derives `provinceId` by point-in-polygon
  (`geometry.provinceAt`), falling back to nearest city.
- `mapdata.applyMap(db)` self-heals worlds/imports/rollbacks that predate the SVG map —
  call it after swapping the db object wholesale.
- **Map paint budget.** Anything that changes inside `#map-svg` every frame (a JS transform
  tween, an infinite CSS animation — even an opacity pulse on a group) makes the browser
  repaint the whole map, provinces, patterns and clip paths included; on a phone that was
  the difference between ~17fps and 60fps. So: no infinite CSS animations inside the map
  svg (the night glow's old ambient "breath" was removed for this); per-frame movers
  belong in the transparent overlay svg
  (`GameMap.overSvg/overWorld`, same viewBox + pan/zoom transform — the war's units,
  arrows and strike FX live there); rAF loops write attributes only when a value changed.
  Things that must live in the map svg but change often (the war's occupied ground) are
  rate-limited (`WAR_GROUND_MIN_MS`), not rebuilt on every tick.
  Also inside `#map-svg`: **no `mix-blend-mode` and no `filter`** on anything big or
  numerous — a blend/filter group is re-rendered offscreen on every pan frame (the night
  grade used to multiply and the glows screen: night panning ran at half the day rate;
  they are plain alpha now). By day the whole night layer is `display:none` (`data-dn`
  on `#map-wrap`), not merely transparent. **No wide strokes over long paths** either:
  the atlas coast first stacked 20–70px strokes along every shore and halved the frame
  rate; its water-lines are now offset contours computed once (`_coastRings`) and drawn
  as hairlines. Pan/zoom input only updates `GameMap.view` and asks for one transform
  write per frame (`scheduleTransform`); counter-scaled markers are only walked when the
  zoom changed. Static decoration that doesn't need to move with the map (paper grain,
  neatline, compass, scale bar, locator) is composited HTML over the map, never svg.
  Images that should change with the light are pre-baked once per texture on a canvas
  (shadow silhouettes, lit-window night art — `map-style.js`) and moved/faded by CSS
  variables, never filtered per element. The same goes for organic effects: smoke, flame
  and fireballs are canvas-baked sprites (`map-fx.js _fxBake`) that only move, scale and
  fade — not SVG primitives (they read as geometry) and not per-element filters.

## Data & environment

- `data/world.json` is live state — don't hand-edit while a server is running (the debounced
  save will clobber it). `data/baseline-world.json` is the fresh-seed source; `arcasia-world
  (2).json` in the root is a stray export, not used by code.
- Snapshots: `data/snapshots/turn-XXXXX.json`, 60 kept, pruned by mtime.
- Dev machine is Windows; paths in code must stay `path.join`-based.
- Caps to respect when appending: timeline 8000, transactions 12000, news 400, history 1000,
  elections 60, dayHistory 120, trade.history 180.

## Testing / verification

There is no test suite. Verify changes by running `node server.js` and exercising the flow in
the browser (seed logins, passphrase `arcasia`), or via curl against the API. For cloud-sync
work use `node tools/diagnose-sync.js <url>`. Advance turns as `gm` (GM bar or
`POST /api/gm/advance`) to exercise the economy; `POST /api/gm/run-event` with `dryRun: true`
diffs an event safely.
