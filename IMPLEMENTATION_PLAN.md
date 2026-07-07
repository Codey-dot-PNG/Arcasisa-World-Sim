# Arcasia World Sim — Implementation Plan

Audience: a junior developer. Work through the phases **in order** — later phases build on
helpers introduced in earlier ones. Do not rewrite systems that work; extend them.

---

## 0. Architecture primer (read before touching anything)

**Backend** (Node, no framework):
- [server.js](server.js) — static file server + API dispatch, long-lived mode.
- [server/api.js](server/api.js) — every API route in one `handle()` function. Auth via `arcsid`
  cookie, permissions via `u.role.perms`. `filterState(u)` builds the permission-filtered world
  each client sees. Generic GM CRUD lives at `/api/gm/coll/<collection>`.
- [server/sim.js](server/sim.js) — simulation engine: safe expression language (`evalExpr`),
  effects (`applyEffect`), turns (`advanceTurn`), elections, money (`txn`), news (`draftNews`).
  **It is deliberately world-agnostic** — no Arcasia names in it. Keep it that way: new world
  behaviour should be seeded events where possible, new generic effect types where not.
- [server/store.js](server/store.js) — the whole world is one JSON document (`store.get()`),
  persisted to file or Supabase. `store.save()`, `store.log()` (timeline), `store.recordTxn()`.
- [server/seed.js](server/seed.js) — the default 1962 world. All world data changes go here
  (plus a migration path for live worlds, see §11).

**Frontend** (vanilla JS, no build step, loaded from [public/index.html](public/index.html)):
- [public/js/core.js](public/js/core.js) — `el()` DOM helper, `W` global state, `S()` world
  accessor, API wrappers (`GET/POST/PATCH/DEL`), SSE/Supabase realtime, modal/toast, explorer.
- [public/js/map.js](public/js/map.js) — `GameMap`: SVG map, pan/zoom, layers, markers.
- [public/js/mapedit.js](public/js/mapedit.js) — `MapEdit`: GM editor for labels/roads/rails/properties.
- [public/js/views.js](public/js/views.js) — module pages + the **inspector** (right-hand panel).
- [public/js/gm.js](public/js/gm.js) — GM Studio (the spreadsheet-style backend editor).
- All writes re-fetch state (`scheduleRefresh()`), and every mutation broadcasts `sync`, so the
  UI is always render-from-state. Follow that pattern: **never mutate DOM state locally without
  a server write behind it** (except live drag previews, which PATCH on pointerup).

**Conventions**: match the 1962 dossier visual style (paper, mono kickers, `el()` builders).
No frameworks, no npm dependencies, no build step. New CSS goes in
[public/css/style.css](public/css/style.css) using the existing `--var` palette.

---

## Phase 1 — Map editor & UX fixes (brief §1)

### 1.1 Fix the stuck-pan bug (do this first, it's a real bug with a known cause)

In [map.js](public/js/map.js) `bindPanZoom()`, `pointerdown` sets `this.drag`, and the **svg's own
`pointerup` listener clears it**. But every child (province, city, marker, country) calls
`e.stopPropagation()` in its `pointerup` handler, so when you release on a clickable element the
svg listener never runs, `this.drag` is never cleared, and the next mouse move pans with no
button held.

Fix:
- Move the drag-ending logic to a `window`-level `pointerup` **capture** listener
  (`window.addEventListener('pointerup', fn, true)`) so no `stopPropagation` can bypass it.
- Also clear `this.drag` on `pointercancel` and when `e.buttons === 0` inside `pointermove`
  (belt and braces for the "mouse released outside the window" case).
- Keep the deferred pointer-capture logic (the comment at map.js:69 explains why; don't undo it).
- While here, replace `dragMoved()` / `lastDragMoved` document-listener hack with a simple flag
  set by the same window-level handlers.

Acceptance: click a province → inspector opens, no panning afterwards. Drag from on top of a
province → map pans, no selection on release. Release outside the window → no stuck pan.

### 1.2 Fix road / railway editing

Symptoms to verify and fix in [mapedit.js](public/js/mapedit.js) + map.js:
- Clicking a line to select it goes through an `edit-hit` polyline whose `pointerup` also has the
  stuck-drag interaction above — retest after 1.1; the selection likely starts working.
- Vertex handles (`edit-handle`), midpoints (`edit-mid`) are counter-scaled by
  `updateMarkerScale()`; confirm they get their initial transform on render (call
  `updateMarkerScale()` at the end of `renderOverlay`, not only via `applyTransform`).
- Vertex drag listeners are attached to the **handle** node but `GameMap.render()` may replace
  the node mid-drag if a sync arrives; use `setPointerCapture` (already there) and additionally
  suppress `render()` during an active vertex drag (add a `MapEdit.dragging` flag checked at the
  top of `GameMap.render()`; queue a render for pointerup).
- Add visible node rendering when a road/rail is merely hovered in edit mode (CSS `.edit-hit:hover`).

### 1.3 Property placement/editing directly on the map (mostly exists — finish it)

`MapEdit` mode `properties` already places and drags markers. Improve:
- `createProperty()` currently dumps the GM into GM Studio. Instead open the **inline editor**
  from Phase 2 (inspector in edit mode) so the GM never leaves the map.
- `nearestProvinceId()` guesses by nearest city. Better: do point-in-polygon against province
  `path`/`shape` server-side. Add a helper in [server/map-geometry.js](server/map-geometry.js)
  and set `provinceId` on the server in the `properties` POST/PATCH when `pos` changes and the
  client sent no explicit override.

### 1.4 New "Event Marker" map object

- New collection `db.markers`: `{ id, pos:[x,y], icon, title, description, createdTurn }`.
  - Server: add `markers: 'mark'` to `COLLS` in api.js, add `markers` to `filterState` (visible
    to everyone), seed `markers: []`, and add a store migration default (`db.markers ||= []`).
- Map: render in `GameMap.render()` as a counter-scaled group (icon + title on hover), click →
  inspector `inspMarker` (title, description, GM edit/delete buttons).
- MapEdit: add a `markers` mode (`+ Marker` places one, drag moves, click edits) — copy the
  `properties` mode pattern.
- `icon` is a reference into the SVG icon library (1.5) or an emoji/text fallback.

### 1.5 Assignable SVG map icons

- Create `public/assets/icons/` and add ~12 small monochrome SVGs (airport, factory, port,
  military base, mine, farm, bank, government, university, rail-station, radio-mast, star).
  Source from a public-domain set (e.g. game-icons.net CC0 exports); keep each under 2 KB,
  single `path`, `fill="currentColor"` so CSS colours them.
- Server: serve statically (already works — anything in `public/` is served).
- Data: properties and markers get an optional `icon` field (filename without extension).
  In `GameMap.render()`, when `pr.icon` is set render `<image href="/assets/icons/x.svg">`
  (or inline `<use>` from a symbol sheet) instead of the letter glyph.
- GM UI: in the property inline editor and GM Studio property form, an icon picker grid
  (thumbnails from a hardcoded manifest array in core.js — keep it simple, no directory listing).

### 1.6 Isometric building models for properties

Match the reference image (white extruded blocks, grey roofs, slight 3/4 view — see
`Newspaper examples/` sibling reference screenshot in the brief).
- Pure SVG, no assets: write a helper `isoBuilding(kind, color)` in map.js that returns a small
  `<g>` composed of 2–4 parallelogram/box faces (top face light, front face mid, side face dark —
  three `polygon`s per box). Define per-kind silhouettes: factory = long low block + chimney,
  office = tall block, port = crane arm, military = flat wide block, house = small box + roof, etc.
- Render these instead of the square `prop-marker` when zoomed in (`showProps` branch of
  `updateMarkerScale`), keeping the existing counter-scaling and selection ring. Keep the flat
  square at far zoom.
- Owner colour tints the roof face only; walls stay paper-white like the reference.

---

## Phase 2 — Inline editing from the inspector (brief §2) ⭐ foundation

This is the single highest-leverage feature; later phases reuse it.

### 2.1 Edit-mode inspector

In [views.js](public/js/views.js):
- Add a pencil button in the inspector header, visible when `isGM()` (later: entity owners for
  their own entities). Toggles `W.inspEdit = true` and re-renders the inspector.
- In edit mode each `kv()` row becomes an input bound to a draft (reuse the `GM.getDraft` /
  `GM.text/num/sel/area/color` form helpers — move them from gm.js into a shared `Forms` object
  in core.js so both GM Studio and the inspector use them).
- Per-kind editable fields:
  - **province**: name, color, description, vars, demographics (small grid), label pos/size/rot.
  - **city**: name, province, size, capital, description, position (⌖ re-place on map).
  - **property**: name, owner, type/kind, icon, value, income, expenses, employees, description,
    inventory, position.
  - **entity**: name, color, logo, description + type-specific fields (industry/owner/CEO/shares;
    party leader/ideology/inGovernment; person title; foreign stance) — mirror the GM Studio
    registry form.
  - **item**: name, category, marketValue, tradable, description.
- Save button PATCHes the existing `/api/gm/coll/...` endpoints — **no new backend needed** for
  the GM case. Cancel discards the draft.
- Keep "Open in GM Studio" for bulk/rare fields; GM Studio itself stays as-is (bulk editor).

### 2.2 Owner-level editing (non-GM)

Allow a non-GM user to edit *descriptive* fields of entities they own/control:
- Server: new endpoint `PATCH /api/entity/:id` allowing only a whitelist
  (`description, color, logo`) when `controls(u.user.entityId, id)` (helper from Phase 4.1).
- Inspector shows the pencil for those entities with the reduced field set.

Acceptance: GM clicks a country/province/company on the map, edits name + a stat in the sidebar,
saves, sees it update everywhere without opening GM Studio.

---

## Phase 3 — GM console redesign (brief §3)

Keep GM Studio tabs for deep editing; add a **GM Command Bar** for day-to-day actions.

### 3.1 GM overlay ("Command Bar")

- A slim, always-available GM toolbar (bottom of screen when `isGM()`, any view) with:
  - **Turn controls**: advance 1/7/30 (moves out of GM Studio → world tab keeps them too).
  - **Find**: a fuzzy search box over users + entities; picking a user jumps to their persona
    entity on the map / opens their dossier (add `user` search: match username/displayName, then
    `select('entity', user.entityId)`).
  - **Quick actions** menu: Trigger Event (list of `manual` events → `/api/gm/run-event`),
    Mint/Transfer, Assign Ownership, Announcement (Phase 10), Call Election.
- Implementation: new file `public/js/gmbar.js`, rendered from `App.renderAll()`.

### 3.2 Assign-ownership dialog

One modal, reachable from the command bar and from any entity/property inspector:
- Pick target (company/org/party/property), pick new owner entity, optional CEO/leader change.
- Uses existing `PATCH /api/gm/coll/entities/:id` / `properties/:id`. Log via existing gm log.

### 3.3 Influence dialog

Modal wrapping the existing `adjust_demo` / `adjust_var` / `adjust_support` effects with a
friendly form (province, group, metric, +/- slider) that POSTs to a new endpoint
`POST /api/gm/effect` `{ effect }` → validates `fx.type` is in a safe list → `sim.applyEffect`.
This gives the GM one-off nudges without creating an event.

### 3.4 Manual election results

- Server: `POST /api/gm/election` accepts optional body
  `{ manual: { rows: [{ partyId, votes, seats }], turnout } }`.
  In `sim.runElection`, if `manual` is provided, skip `computePolling`, use given rows (validate
  seats sum ≤ parliamentSeats), still write the election record, update `mpCount`, news, log.
- UI: "Call Election" modal gains two tabs: *Simulate* (current behaviour) and *Manual entry*
  (a table pre-filled with current polling as a starting point).

Acceptance: GM can find a player, hand a company to them, bump a province's happiness, and run a
manually-specified election — all without opening GM Studio.

---

## Phase 4 — Economy (brief §4)

### 4.1 Ownership-chain helper (server) ⭐ used by 4.2, 6, and permissions

In sim.js (or a new `server/ownership.js`):
```
controls(rootEntityId, targetEntityId) -> bool
controlledSet(rootEntityId) -> Set<entityId>
```
Walk: `entity.ownerId`, `entity.ceoId` (CEO controls company), party `leaderId`, majority
shareholding (>50% of `sharesOutstanding`), and property `ownerId` chains. Cap depth (e.g. 6) and
guard against cycles. Example that must pass: President (person) → Government of Arcasia
(`ent_gov`) → Bank of Arcasia is NOT owned by gov in seed — add `ownerId: 'ent_gov'` to
`ent_bank` in seed.js so the chain works.

Apply it:
- `/api/transfer`: allow when `from.ownerId` is in `controlledSet(me)` (not only `=== me`).
- `filterState`: when `perms.accounts === 'own'`, visible accounts = accounts whose owner is in
  `controlledSet(me)`. Same for inventories. This automatically gives owners the "move money in
  and out of owned entities" ability and the President the Bank-of-Arcasia visibility example.

### 4.2 Wire-transfer UI overhaul

Rewrite `Views.transferModal` ([views.js:285](public/js/views.js)):
- **From**: searchable list of controlled accounts (text input filters; show balance).
- **To**: one search box over entities *and* accounts (type-ahead list, arrow keys optional);
  citizens still target entities (server already auto-creates `primaryAccount`).
- Recent recipients (derive from last 20 visible transactions) as one-click chips.
- Keep the endpoint as-is; it already covers everything.

### 4.3 Trade offers (request/offer, not just instant give)

Current `/api/trade` is an instant one-way gift. Add negotiated trades:
- New collection `db.trades`:
  `{ id, fromEntityId, toEntityId, give:[{itemId,qty}], get:[{itemId,qty}], money:{give:0,get:0},
     memo, status:'open'|'accepted'|'declined'|'cancelled', ts, turn }`.
- Endpoints: `POST /api/trades` (create, escrow nothing — validate at accept time),
  `POST /api/trades/:id/accept|decline|cancel`. On accept: verify both inventories/balances,
  swap items via the existing inventory code path, move money via `sim.txn`, log both entities.
- `filterState`: a user sees trades where either side is in their `controlledSet` (GM sees all).
- UI: "Trade" tab inside the Economy view + a badge in the top bar when you have open incoming
  offers. Offer composer: your inventory table (pick give), their visible info (request get).
  Viewing inventories: inspector already shows them subject to perms — good enough.
- Keep the old instant-gift path as "Send items" (it already exists).

### 4.4 Simplified stock market

Reuse what exists — companies already have `sharesOutstanding`, `shareholders`, and
`item_share_*` inventory items. **Keep both representations**, but make the shareholder register
(`entity.shareholders`) the canonical ownership record. Share certificate items remain in player
inventories so they can be traded like any other item. Ensure both stay synchronised at all times.
Migrate existing data so any shareholder also receives matching share certificate items (e.g. Toma
Rill's 500 AMCO shares appear in both the shareholder register and as a 500-share certificate in
their inventory).

- Company fields: add `publicFloat` (0–100, % of shares tradable), `sharePrice` (number),
  `trust` (0–100, citizen trust — also used by Phase 9).
- Market maker (no order book): players buy from / sell into the float at `sharePrice`.
  - `POST /api/market/buy` `{companyId, shares}`: cost = shares × price; must not push public
    holdings above `publicFloat`% of `sharesOutstanding`; money goes to the company account.
    Buying automatically creates or updates the player's share certificate item and shareholder
    register entry.
  - `POST /api/market/sell`: inverse; company account pays out (reject if the company can't pay).
    Selling removes shares from both the shareholder register and the player's certificate item.
  - `POST /api/market/transfer` `{companyId, toEntityId, shares}`: private transfer between
    shareholders. This should behave like any normal inventory item transfer—the share certificate
    moves to the recipient, and the shareholder register updates automatically.
  - Company issue: `POST /api/market/issue` `{companyId, newShares, floatPct}` — only the
    company's controller; dilutes the register, updates available public float, creates any
    necessary company-held certificates, and logs the event.
- Pricing event (seeded, weekly, replaces `ev_market`): new generic effect type
  `reprice_shares` in `sim.js`:
  `price *= 1 + a·(profit/valuation) + b·(gdpGrowth) + c·((trust-50)/100) + rand(-e, e)`
  with coefficients defined in the effect data (not hardcoded). Record every price update into
  historical price data (Phase 7).
- GM lever: GM can PATCH `sharePrice` and `trust` directly from the inline editor, and events can
  use a new `set_share_price` effect.
- UI: add an **Exchange** tab in the Economy view showing listed companies, current price,
  day/week change, public float, player's holdings, Buy/Sell buttons, and a sparkline using the
  recorded price history (Phase 7 helper).

Acceptance: a citizen buys 100 LEIKA shares, receives a share certificate item, and sees the
shareholder register update. They can later either sell the shares back to the exchange or trade
the certificate to another player through the normal inventory/trade system, with the register
automatically synchronising ownership. The GM triggers a market crash event, share prices update,
and the President transfers money from the Treasury to the Bank of Arcasia.

---

## Phase 5 — Newspapers (brief §5, §12)

Exactly **four** papers, from the reference images in `Newspaper examples/`:

| id | Name | Masthead style | Owner note | Auto-prints |
|---|---|---|---|---|
| `paper_today` | Arcasia Today | black block caps, double rules | state (ARC) | political: elections, parliament, government events |
| `paper_herald` | The National Herald | red caps + yellow frame | NFP-funded | instability: unrest, crime spikes, military/foreign incidents |
| `paper_economists` | Economists | red serif on blue swoosh | Satrom group | money: GDP reports, large transfers, market sessions |
| `paper_radical` | Radical | navy slab serif | independent | **nothing** — player-written only |

- Settings: `settings.newspapers = [{id, name, tagline, city, style}]` (fixed list, seeded; GM can
  rename but the UI offers no "add paper").
- News articles get `paperId` (migration: existing articles → `paper_today`; the seed's
  "Arcasian Herald" masthead in `viewNews` is replaced by the four-paper UI).
- Users/entities: role `journalist` and MPs get `user.newspaperId` (GM sets it in the operator
  editor and inline). Publishing (`POST /api/news`) requires `manageNews` **and** the article's
  `paperId === user.newspaperId` (GM bypasses).
- Routing auto-drafts: `sim.draftNews(headline, body, category, publish, author, paperId?)` —
  callers pass a category; add a small category→paper map in settings
  (`Politics→today, Regional/unrest→herald, Economy/Business→economists`). Auto articles are
  **drafts** by default (player editors publish), except the wire-service statistical bulletins
  which stay auto-published — matches "mostly player controlled, only autoprint updates".
- UI (`viewNews`): paper switcher rendered as four masthead cards styled per reference image
  (CSS only — block caps for Today, red/yellow Herald, blue swoosh Economists, navy slab
  Radical; the ownership footnote line under each masthead as in the images). Article list
  filters by `paperId`. Journalists see the editor only for their own paper.

---

## Phase 6 — Timeline & wire-log visibility (brief §6)

- `filterState` timeline: if `!perms.gm`, filter `db.timeline` to entries whose `refs` intersect
  `controlledSet(me)` ∪ {my entityId}, plus types `news`, `time`, `election`, `system` (public
  record). Keep the cap at 400 after filtering.
- Transactions: already filtered by visible accounts — after 4.1 this automatically becomes
  "ownership chain" visibility. Remove `accounts:'all'` from the president/minister roles in the
  seed (they now see their chain instead) — GM keeps `all`.
- UI: Timeline page shows a notice "You see the public record and files concerning your own
  holdings" for non-GM.

---

## Phase 7 — Statistics & graphs (brief §7)

### 7.1 History recording (prerequisite — there is no time-series data today)

- New collection `db.history`, appended once per turn at the end of `advanceTurn`:
  `{ turn, date, gdp, population, avgHappiness, avgApproval, moneySupply, treasury,
     provinces: {id:{gdp,happiness,approval,employment}}, polling: {partyId:pct (weekly only)},
     shares: {companyId:price} }`
  Cap at ~1000 entries. Include in `filterState` only when `perms.statistics`.
- Polling snapshot: run `computePolling(false)` weekly (guard by `weekIndex` change) — it's O(provinces×groups×parties), fine.

### 7.2 Chart helper (no dependencies)

- `chartLine(series, opts)` and `chartBars(rows, opts)` in a new `public/js/charts.js`: return an
  SVG node in the house style (thin ink lines, paper background, mono axis labels). ~120 lines.

### 7.3 Place charts

- Economy view: GDP line, money supply line, share-price sparklines per listed company.
- Population view: happiness/approval lines per selected province.
- Parliament view: polling-over-time line per party; election results bar chart.
- Entity inspector (company): valuation/price sparkline.
- GM command bar: mini national dashboard (GDP, approval, treasury deltas).

---

## Phase 8 — Events & variables usability (brief §8)

Keep `evalExpr` and the effect schema unchanged (worlds already contain them). Improve authoring:

- **Sentence-style effect builder**: re-skin `GM.effectParams` so each effect reads as a sentence
  ("Adjust [gdp ▾] in [all provinces ▾] by [ expression ]"). Mostly re-layout, low risk.
- **Expression helper popover** on every expression input:
  - chips for available `$vars` in the current scope (from `S().variables`),
  - chips for functions (`rand`, `clamp`, `prov(...)` …) inserting templates at the caret,
  - live evaluation (debounced `POST /api/gm/test-expr`) showing `= value` or the error inline.
    Extend `test-expr` to accept a `scope`/`targetId` so province/entity expressions evaluate
    against a real context, not just globals.
- **Condition builder**: same treatment; render as "when [expr] [≥] [expr]".
- **Simulate button** per event: `POST /api/gm/run-event { id, dryRun: true }` — add a dry-run
  path that deep-clones the db (`JSON.parse(JSON.stringify)`), applies effects on the clone, and
  returns a diff summary (vars changed, money moved) without saving.
- Variables tab: show where each variable is used (scan event effect strings for `$key`) before
  allowing rename/delete.

---

## Phase 9 — Simulation interactions (brief §9)

Implement as **seeded events + 2 new generic effect types**, keeping sim.js world-agnostic.

New effect types in `applyEffect`:
1. `recompute_employment` — per province: labour demand = Σ `employees` of properties in the
   province; labour force ≈ working-age share (~60%) of population; set
   `p.vars.employment = clamp(100 · demand·k / force, 40, 98)` with `k` a calibration factor in
   the effect. Also nudge each demographic group's `employment` toward the provincial value.
2. `adjust_trust` — move company `trust` toward a target expression (used with happiness/news).

Replace/extend the seeded drift events (`ev_econ_drift`, `ev_confidence`, `ev_polling`) with a
causal chain, each a small documented event the GM can inspect and tune:
- **Jobs → employment**: `recompute_employment` every turn.
- **Employment → happiness**: happiness drifts toward `35 + employment·0.35 + income effect`
  (per group, using `$p_employment`) — realistic anchor: unemployment is the strongest
  happiness depressor, so weight it ~2× approval.
- **Economy → opinion**: `governmentSupport` drifts with `economicConfidence` and GDP growth
  (store last-month GDP in a global var to compute growth).
- **Trust → companies**: company `trust` drifts toward avg provincial happiness where it has
  properties; `trust` feeds share price (Phase 4.4) and a small revenue multiplier in the
  corporate-earnings event.
- **Demographics → elections**: already implemented in `scoreParty` — leave it, but document it
  in the event tab so the GM knows the lever order.

Calibration: pick coefficients so a ±10 pt employment shock moves happiness ~±3 pts/month and
approval ~±2 pts/month (slow, GM-observable). Put all coefficients in the event expressions, not
in code.

---

## Phase 10 — Audio & Presentation (brief §10)

- **Music**: Store music as URLs instead of local files.
  `settings.music = { enabled, shuffle, volume, library:[{id,title,url}], playlists:[{id,name,tracks:[trackId]}], activePlaylist, forcedTrack }`.

  Create a small client-side `Music` module (`public/js/music.js`) using a single `<audio>` element with autoplay-after-first-interaction (browser policy compliant), shuffle queue support, and a compact player widget in the top bar.

  The music system should distinguish between a global **Music Library** and **Playlists**.

  - The **Music Library** contains every available track in the simulator.
  - Playlists simply reference tracks from the library.
  - The GM should be able to add, edit and remove tracks from the library by supplying a **Title** and **Audio URL**, making it easy to expand the simulator's soundtrack over time without modifying project files.
  - The GM should also be able to create, rename and edit playlists by selecting tracks from the Music Library rather than repeatedly entering URLs.

- **Playback**

  When music settings are updated via sync broadcast, all connected clients should react immediately.

  - Changing the active playlist updates everyone's playback.
  - Setting `forcedTrack` immediately switches every client to that specific track, overriding normal playlist playback.
  - Clearing `forcedTrack` resumes the active playlist (continuing or reshuffling as appropriate).
  - Tracks marked as forced should never appear during normal shuffle playback.
  - Playlist playback should only select tracks designated as "normal" unless the GM explicitly forces a track.

- **GM Presentation Controls**

  Add a **Presentation** tab to GM Studio containing:

  - Music Library management
  - Playlist management
  - Active playlist selector
  - Force Track selector
  - Volume controls
  - Shuffle toggle
  - Enable/disable music

  The interface should make adding future music as simple as pasting a new URL and title into the library.

- **Default Content**

  Seed the Music Library with the tracks from the following playlist as the default soundtrack:

  https://www.youtube.com/watch?v=vZDT1vaCUqE

  Where possible, preserve the playlist ordering when importing the default library, while still allowing shuffle playback.

---

## Phase 11 — World data updates (brief §11, §12)

All in [seed.js](server/seed.js), **plus** a one-time migration function (`migrate(db)` in
store.js, run on load, bumping `db.schema` → 2) so live worlds update without a reset:

1. **Remove Kordistan** (the *foreign power* `for_kordistan` — the domestic Kordi province
   stays): delete the entity from seed; delete `public/assets/flags/kordistan.png`; check
   [server/mapdata.js](server/mapdata.js) for a Kordistan country shape/label and remove it.
   Migration: drop the entity, its accounts, any map country/label with that entityId/name.
2. **Currency → Arcasian Koren (ARK)**: `settings.currency = 'K'` (or keep `₳` if the GM
   prefers a symbol — decision: use `ARK` in names, symbol `K`), `currencyName = 'Arcasian
   Koren'`. UI already reads `CUR()` everywhere — grep for hardcoded `₳` in seed
   descriptions/news and update. Update GDP label `GDP (₳M)` → `GDP (ARK M)`.
3. **Arcasia profile**: add `settings.country = { leader: null, government: 'Semi-Presidential
   Republic (no Prime Minister)', economy: 'Mixed State Capitalism & Planned Economy',
   gdpRank: '20th / 103', urbanisation: 60, lifeExpectancy: 55, schooling: 4, hdi: 0.534,
   populationGrowth: 'high' }`. Show it in a new "Country" section at the top of the Population
   view and in the Government entity dossier. Remove President Valen as leader (`per_valen`
   keeps existing but title → 'Former President'? — per brief, Leader: None: clear the
   `president` user's linked persona title and any "President since 1958" copy).
4. **Rescale numbers**: total population 39,000,000 (current 14.0M → scale every province's
   demographics ×2.79 and re-derive `vars.population`); GDP 13,000 (ARK M) total (current
   4,840 → scale province `gdp` ×2.686). Keep relative proportions. Update seed news/description
   copy that mentions old figures.
5. **Valksland flag**: copy `Valksland.png` → `public/assets/flags/valksland.png` and set
   `logo` on `for_valksland`.
6. **Newspapers seed**: the four papers from Phase 5, `per_halden` affiliated to `paper_today`.

---

## Phase 12 — Verification pass

- Manual test script (run with two browsers, GM + citizen):
  1. Map: click/drag/zoom on every object type; draw + edit + delete a road and a rail; place a
     property and an event marker; assign icons.
  2. Inline edit a province, company, property; verify a citizen sees changes live.
  3. GM bar: find player, assign company, influence happiness, trigger event, manual election.
  4. Economy: chain transfer (President → Treasury → Bank), trade offer accept/decline, share
     buy/sell/issue, verify all appear in transactions/timeline with correct visibility.
  5. Papers: journalist can publish only to own paper; auto-drafts land in the right paper.
  6. Advance 40 turns; charts populate; simulation chain moves plausibly; no console errors.
- Check both storage modes: file mode locally and (if configured) Supabase mode — every new
  collection must be included in the store save path and in `filterState`.

---

## Suggested order & sizing

| Phase | Size | Depends on |
|---|---|---|
| 1 Map fixes | M | — |
| 2 Inline editing | M | — |
| 4.1 Ownership helper | S | — |
| 3 GM console | M | 2 |
| 4 Economy | L | 4.1, 2 |
| 5 Newspapers | M | — |
| 6 Visibility | S | 4.1 |
| 7 Statistics | M | — (7.1 early helps 4.4) |
| 8 Events UX | M | — |
| 9 Simulation | M | 4.4 (trust), 7.1 |
| 10 Audio/presentation | S–M | — |
| 11 World data | S | 5 (paper seeds) |

Every phase must leave the app shippable: no half-wired collections (server + filterState + UI
+ seed + migration together in one change).
