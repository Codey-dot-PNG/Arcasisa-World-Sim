# HTTP API (server/api.js)

All routes live in one handler, `api.handle()`. JSON in/out. Errors: `{error}` with 400
(`bad`), 401, 403 (`deny`), 404, 500. Auth via `arcsid` HttpOnly cookie → `db.sessions`.
After any mutation the pattern is `store.save(); broadcast('sync');` — clients refetch state.

## Auth & session

| Route | Notes |
|---|---|
| `GET /api/config` | public; storage mode, Supabase keys for realtime, ephemeral-host warning |
| `POST /api/auth/login` | `{username, password}` → sets cookie, returns `{user}` |
| `POST /api/auth/logout` | |
| `POST /api/auth/register` | if `settings.registration.open`; creates person entity + account + stipend |
| `GET /api/me` · `PATCH /api/me/password` | |
| `GET /api/state` | `{user, state: filterState(u), v}`. Also rides `market.maybeDayTick` (serverless day market) |
| `GET /api/stream` | SSE (file mode only; cloud uses Supabase Realtime) |
| `GET /api/polling` | public party-support percentages, national + per province |
| `GET\|POST /api/cron` | advance overdue auto-turns; auth: `CRON_SECRET` bearer/`?key=` or GM session |

## Player actions

| Route | Notes |
|---|---|
| `POST /api/transfer` | money between accounts; must control source (ownership chain); GM may overdraw |
| `POST /api/trade` | instant item transfer between entities. Cert/deed items route through `market.transfer`/`deeds.transfer` |
| `POST /api/property/items` | deposit/withdraw goods between a property site and its owner (`direction: 'withdraw'`) |
| `POST /api/trades` | create negotiated offer `{fromEntityId, toEntityId, give[], get[], money{give,get}, memo}`; no escrow |
| `POST /api/trades/:id/(accept\|decline\|cancel)` | accept validates everything first, then moves items/money; single-company cert-vs-cash trades re-mark the day quote |
| `PATCH /api/entity/:id` | owner-editable descriptive fields only (description, color, logo) |
| `PATCH /api/company/:id/controls` | CEO/owner: `keepPct, govMix, govPriceMult, wage, govMixByItem` |
| `PATCH /api/trade/controls` | President (controls `ent_gov`) or GM: `govBuy`, `exports`, `imports` |

## Market (Phase 4.4 / Workstream A)

`POST /api/market/buy | sell | transfer | issue (bonus mint) | offer (capital raise) |
buyback`. Buy/sell execute at the live day price against the National Bank. Issue/offer/
buyback require control of the company.

## Casino (Phase 12) — outcomes decided server-side

`POST /api/casino/roulette` (`{venueId, bets}`), `/api/casino/blackjack`
(`{venueId, action: deal|hit|stand|double, bet}` — hands in `db.casinoHands`, never sent to
clients), `/api/casino/lottery` (`{venueId, numbers}`). `PATCH /api/casino/venue/:id` —
venue owner's controller or GM tunes odds/limits; GM-only: enable, rename, re-own.

## Newsroom (Phase 5)

`POST /api/news` (needs `manageNews`; non-GM journalists may only file to their own
`user.newspaperId`), `PATCH|DELETE /api/news/:id` (same paper restriction).

## GM (`/api/gm/*`, requires `perms.gm`)

| Route | Notes |
|---|---|
| `POST advance` | `{steps}` → `sim.advanceTurn` |
| `POST run-event` | `{id, dryRun?}` — dryRun deep-snapshots db, runs, diffs, restores (cloud caveat: pending log rows still flush) |
| `POST election` | optional `{manual: {rows, turnout}}` |
| `POST effect` | one-off safe effects: `adjust_demo, adjust_var, adjust_support` |
| `POST test-expr` | evaluate an expression against global/province/entity scope |
| `POST mint` | `{accountId, amount}` — positive deposits, negative withdraws |
| `POST give-item` | move any item between entities (certs/deeds routed properly) |
| `POST set-holding` | assign shares; `fromEntityId`/`toEntityId` may be `'float'` |
| `GET snapshots` · `POST rollback` `{turn}` | |
| `GET export` · `POST import` | full world JSON archive |
| `POST reset` | reseed |
| `PATCH settings` | worldName, currency, time (+auto), registration, taxation, newspapers routing, entertainment, music, map, trade (govBuyPrices/partners), economy |
| `POST users` · `PATCH\|DELETE users/:id` | user CRUD; calls `sim.syncPresidency` |
| `POST\|PATCH\|DELETE coll/:coll(/:id)` | generic CRUD for `entities, provinces, cities, properties, items, events, variables, roles, accounts, markers` — with cascade deletes, geometry-based province placement, deed/cert/texture sync hooks |

## Permission filtering — `filterState(u)`

The single place the world is narrowed per operator. Key rules:
- **Ownership chain** (`ownership.controlledSet`): own entity + everything reached via
  `ownerId`, `ceoId`, party `leaderId`, government `executives`, or >50 % shareholding
  (depth ≤ 6, cycle-safe). `'own'`-scoped accounts/inventories follow this chain.
- Accounts/transactions: `perms.accounts` all/own; txns filtered to visible accounts (last 400).
- Inventories stripped unless `perms.inventories` allows; company `vars/shareholders` stripped
  without `companyFinancials` (unless it's your company).
- Provinces: without `statistics`, only `vars.population`, no demographics.
- Properties: `type === 'military'` requires the `military` map layer.
- News: non-`manageNews` sees published only.
- Timeline: GM sees all; players see only economy/ownership/market/inventory entries whose
  `refs` touch their chain.
- Trades: parties + GM.
- `events`, full `roles`, `users` are GM-only. `history` without `statistics` is
  share-prices-only. `globalVars` without `statistics` → population + econConfidence only.

**When adding state, decide its visibility here** — never rely on the client to hide data.
