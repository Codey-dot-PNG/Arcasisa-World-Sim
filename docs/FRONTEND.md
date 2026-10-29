# Frontend (public/)

Vanilla JS, no framework, no build. `public/index.html` loads scripts in dependency order —
**keep this order** when adding a file:

```
core.js → pricepath.js → charts.js → map.js → mapedit.js → borders.js → views.js → sfx.js
→ entertainment.js → gm.js → gmbar.js → music.js → app.js
```

All styling in `public/css/style.css` (CSS custom properties; 1960s newspaper/dossier look).
Assets (flags, logos, building art, paper mastheads) under `public/assets/`.

## Module responsibilities

| File | Role |
|---|---|
| `core.js` | The `W` global (me, state, view, selection…), API client (`api()` fetch wrapper), realtime wiring (SSE or Supabase Realtime from `/api/config`), `el()` DOM builder, formatting helpers (`fmtMoney` etc.), explorer sidebar, wire ticker, modals/toasts |
| `app.js` | Boot, login screen, navigation (`App.go(view)`), `renderAll()` orchestration, scroll preservation across periodic re-renders |
| `views.js` | All player-facing views (map dossier panels, parliament, companies/exchange, economy, population, news, timeline) + the contextual inspector panel |
| `charts.js` | Zero-dep SVG charts: `Charts.chartLine(series, opts)`, `Charts.chartBars(rows, opts)` |
| `map.js` | `GameMap` — SVG world on the **3840×2160** master grid, pan/zoom, layers (political/data/ownership/military), all drawn from state (`settings.map`, provinces, cities, properties). Also owns the day/night cycle: a continuous solar model (`setDayNight`) writes `--dn-night/warm/lights` CSS vars that drive an in-svg night grade + screen-blended city-glow blobs (kept *under* buildings/labels so they stay readable) and the vehicles' headlight beams |
| `mapedit.js` | GM map editor for `settings.map` labels/roads/rails/lights (saves via `PATCH /api/gm/settings {map}`) and the host of the **Borders** mode |
| `borders.js` | GM border painter (`Borders`, map editor mode "Borders"): soft raster ownership fields per region, organic brush, marching-squares re-trace clipped to the pristine coastline, Territory panel (found province/country, give province to a country, annex a country), saves via `PUT /api/gm/territory` — see "Border painter" below |
| `war.js` | War layer (retained-mode situation map: front line + occupied ground in `#map-svg`; NATO-style units, orders, clash markers, objectives and strike FX in the `#war-overlay` svg), the map toolbar / situation HUD / unit card, and the War Room situation report; see docs/WAR.md "Client" |
| `war-map.js` | Folded into `War`: the war map sheet — km grid with sheet references (`gridRef`), printed frame/scale bar/compass rose/paper, the ruler and range-compass tools, unit trails and route length/ETA labels. Scale from `settings.map.kmPerPx`; see docs/WAR.md "The map sheet" |
| `war-air.js` | Folded into `War`: the air force client — airfields and squadrons on the map, the Air wing dock, the mission planner, air summaries for the HUD and War Room; see docs/WAR.md "The air force" |
| (map.js airfields) | Airfield properties (`MAP_AIRFIELD_KINDS` in core.js: airport, airbase, military_base) draw on every map layer at every zoom — a runway in the owner's colour, the name once zoomed in (`.map-airfields.named`), click opens the property dossier; hidden on the War layer, where the war overlay draws them |
| `gm.js` | GM Studio — seven desks (`GM.GROUPS`) with sub-pages: World (Settings & Time · Presentation · Archive & Rollback), Map & Territory (Territory · Provinces · Cities & Properties), Entities (one editor: Details · Money · Inventory · Ownership · Properties · Org chart · Trade), Economy & Trade (Levers & Tax · Money Supply · Items & Market · Trade Partners), Election, Rules & Events (Event Engine · Variables · Census Groups), Roles & Operators. Old single-tab ids still work via `GM.LEGACY_TABS` (`W.gmTab = 'trade'` → Economy › Trade Partners); `GM.go(desk, page)` navigates |
| `gmbar.js` | GM Command Bar (bottom toolbar): advance turns, quick actions. Touches only its own `#gm-bar` subtree |
| `entertainment.js` | Casino/lottery UI — animates toward server-decided outcomes only. Mirrors `ownership.controls` client-side (`ownership_controlsClient`) — keep in lockstep with server/ownership.js |
| `music.js` | Shared soundtrack via hidden YouTube IFrame player, driven by `settings.music` (GM changes propagate on sync) |
| `sfx.js` | Synthesised WebAudio effects; volume rides Music volume; localStorage toggle |
| `pricepath.js` | **Byte-identical copy of server/pricepath.js** — deterministic live price wiggle so clients render (never invent) the day-market ticker |

## Phase 36 UX notes

- **Tab overflow** (`App.fitTabs`): when the top bar can't fit every tab beside the
  clock/music/user cluster, `#topbar.tabs-row` drops the tabs to their own full-width row;
  if even that overflows, the rightmost tabs fold into a "More ▾" menu (`#tab-menu`,
  body-level so the strip's overflow doesn't clip it). The active tab always stays visible.
  Re-fitted on every render and on resize.
- **War Room** (`war.js`): `War.access(doc)` returns the caller's full `cmdAccess`;
  `War.authorityText(doc)` is the one-line "Your authority …" shown under each conflict and
  as the observer's toolbar hint. A protest gets its own report (`renderProtestReport`):
  the escalation grid with only the levers the caller holds (`_protestLevers` — `attLead` /
  `force`, plus Call off / Concede), the streets, Public Opinion (`renderProtestOpinion`) and
  strikes; player petitions (`renderProtestApplications`), the GM petition queue
  (`renderApplicationQueue`) and Protest Rules (`renderProtestRules`). City pickers are
  tappable chips (`_cityChips`). See docs/WAR.md "Protests → Client".
- **Delegation** (`core.js`): `grantCoversClient(entityId, scope)`, `actsForSetClient(scope)`
  (chain + grant entities) and `canSpendFromClient(account)` mirror `ownership.canAct` over
  `S().myGrants`; the transfer/trade/contract pickers, inventory, trade view and the company/
  property desks use them, and delegated accounts are labelled "(delegated)" and kept out of
  "Your Money".
- **The Office** (`office.js`, tab after Parliament): a per-operator desk of widgets
  (`Office.TYPES` — accounts, portfolio, market watch, stock room, headlines, trade inbox,
  polling, chamber, food distribution, situation room, notepad, desk clock, province watch,
  pinned file, ledger, holdings desk). **Free-placement canvas**: windows are absolutely
  positioned (`Office.arrange` → `Office.solve`) at `x` (column) / `y` (px). On the 4-column
  desk placement is free — a window stays where it is dropped, empty space included, and
  overlaps are resolved by pushing the lower window down; windows without a spot (new ones)
  take the first gap. Tablet (2 cols) and phone (1 col) can't honour desk coordinates, so
  they keep the desk's reading order and pack upward (no window above the one before it);
  a drag there only reorders, and `Office.commit` hands the desk's existing slots out in the
  new order. Heights are measured content, and a `ResizeObserver` re-arranges when a widget
  grows or the canvas width changes. Drag from the whole title bar (pointer events, 5px
  threshold): the window follows the pointer, a dashed `.ow-placeholder` marks the snapped
  spot (column + 10px), neighbours glide via CSS transitions on left/top (enabled by
  `.office-grid.ready` after the first paint); heights are cached at drag start. The ◢
  corner grip (`resizeStart`) snaps width to columns live and sets a free height (80–1100px,
  numeric `w.h`; legacy `s|m|l` still render), pushing neighbours live; double-click resets.
  ⚙ settings, ◐ style (`ledger|card|dark|telegram|accent`). The **Ledger** widget merges
  money (signed txns) with the Record (entries you acted on or that touch your chain;
  All/Money/Record/By me). The **Holdings Desk** (`Office.holdings()`) lists companies
  (`Views.opsCompanies`), properties (`opsProperties`), groups (party/org/government you
  control or lead) and share positions, with the existing modals as actions
  (`tradeOfferComposer(prefFrom)`, `tradeModal(item, to, prefFrom)` — deeds sell from the
  owning entity — `transferModal`, market buy/sell/offer, ops desks). Layout is kept in
  `Office._local` and
  saved debounced to `PUT /api/me/office`; `Views.render` skips rebuilding the Office while a
  drag or a focused widget input is live (`Office.busy`). Widgets only render filtered state
  and call existing routes — they add no authority.
- **Ledger views (compact UI pass)**: the Exchange is a quote board (`viewExchange` — one
  row per company with a static `Views.miniSpark` trend; clicking a row sets `W.exchOpen`
  and opens a drawer with the two live charts, the ×100 lane and the controller's capital
  tools). Parliament is one party ledger (seats, polling, last vote) with the election record
  folded. Reference tables (all accounts, market values — deeds/certificates hidden unless
  asked — inventory holders, ended conflicts, GM war tools, the petition form) use
  `Views.ledgerFold(key, label, build, defaultOpen)`: a `<details>` whose body is built only
  when open and whose state persists in `W[key]` across re-renders. Columns marked `.col-opt`
  drop on phones. Players without statistics clearance get a public census table on the
  Population tab.
- **Phones**: one-line control cluster (theme swatches fold behind `#theme-btn`, world
  clock hidden), page sub-tab rows (`.doc-inner > .chip-row`) scroll as one line, stat strips
  become a 3-up grid, and the map key starts folded (`W.legendHidden`). The explorer folds
  sections longer than `EXP_FOLD_OVER` (12) unless searching. The GM's top-bar Advance button
  is hidden — the GM command bar carries Advance.
- **Roles editor** (`gm.js tabRoles`): "Abilities — conflict command" checkboxes
  (`ROLE_ABILITIES`, keys mirror api.js `ABILITIES`).

## Data flow

1. Boot: `GET /api/config` → storage/realtime mode → `GET /api/state` → `W.state`.
2. Realtime `sync` (SSE event or Supabase broadcast) → refetch `/api/state?ifv=<lastV>` →
   `renderAll()`. When the version still matches, the server answers a tiny
   `{v, unchanged, user}` envelope; `polling` rides the full response (no separate fetch).
3. Mutations are POST/PATCH calls. Successful responses carry a `sync` payload (the fresh
   filtered world) which `applySync()` applies immediately — one round-trip, no refetch.
   Hot actions (wire transfer, market buy/sell, goods trade) additionally pass
   `opts.optimistic` to `POST()`: a guess painted into `W.state` at click time via the
   `Optimistic` outbox (the war-order pattern generalised), always replaced by server
   truth when the response lands. `/api/war/*` orders skip all of this — war prediction +
   the ~1s heartbeat own that path (docs/WAR.md).
4. `W.state` is already permission-filtered by the server. Absent fields (inventories,
   demographics, events…) mean "not cleared to see" — render defensively.
5. `renderAll()` skips the full-SVG map rebuild when a content fingerprint over the map's
   actual inputs (provinces/cities/properties/markers/`settings.map`/entity colours/layer)
   is unchanged (`mapFingerprint` in app.js) — most syncs don't touch the map. Direct
   `GameMap.render()` calls (map editor, layer buttons) always render.

## Conventions

- DOM built with the `el('tag.class', attrs?, ...children)` helper; views rebuild their
  subtree from scratch on each render (scroll positions restored by app.js).
- All `<script>` tags in index.html carry `defer` — they still execute in the dependency
  order above, but download in parallel without blocking first paint.
- Mobile: below 900px the explorer floats over the view (below 1180px the inspector does);
  `App.bindDrawers()` adds a scrim (`#drawer-scrim`) that closes them on outside tap.
  Touch-target sizing lives in the `(pointer:coarse)` block of style.css; phones also get
  `100dvh` shell height, safe-area padding and horizontally scrollable wide tables.
- No client-side secrets or authority: prices, casino outcomes, election results, and
  permission checks are all server-side. Client-side control checks exist only to show/hide
  UI affordances.
- Charts/styles read CSS custom properties so they follow the active theme.

## Live elections (Phase 33) — the Elections desk

While `state.election` exists (the server ships it to every operator, redacted for
non-GMs via `election.forPlayers` — never render `targets`/`deviationPct`/`supportToVotes`,
GM-only), the **Parliament tab relabels to "Elections"** (`renderTabs` in app.js) and
`views.js` dispatches to the Elections desk instead of the Parliament view:

- **Campaign season** (`election.phase === 'campaign'`): `viewElection` renders the
  polling snapshot (gated to `perms().statistics || isGM()`), a "Campaign Desk" section
  per party — run buttons for the public campaign catalogue
  (`state.settings.election.campaigns`), disabled unless the party treasury
  (`state.accounts` owner = party) and inventory cover the cost (helpers
  `campaignCostAffordable` / `campaignCostText`), controlled parties only
  (`ownership_controlsClient` or GM) — plus the public election log and a GM strip
  (Open the Polls, Election Commission → GM Studio, Call Off).
- **The count** (`phase === 'voting'`): `electionCountView` — a hero (current leader,
  votes, % counted, margin), a per-batch progress bar (`step / durationTurns`), the
  national table (votes, share, and "polls said" from `pollingAtCall`), a live share
  chart from `election.steps` (`Charts.chartLine`, `yFormat: v => fmtCompact(v)`), a
  by-province table from `election.counted`, the "campaigning into the count" desk, and
  the GM strip (Count One Batch Now, watch the count, Call Off).

### GM Studio → Election tab (gm.js `tabElection`)

- Status: phase, called date, polls-lead at call, counted totals; buttons to open the
  polls / count a batch now / watch the count / call off; or **Call Election** (live)
  when none is running. The legacy **Instant Election…** (gmbar.js) is refused while a
  live election is underway.
- Tuning (`getDraft('election-tune', …)`): `durationTurns`, `deviationPct`,
  `supportToVotes` sliders → `PATCH /api/gm/settings {election}`.
- Vote corrections (during the count): `_elAdj` draft — party, province (or "all"),
  votes → `POST /api/gm/election/adjust`. The GM-only **OFFICIAL TOTALS (UNREVEALED)**
  table reads `election.targets` directly.
- Campaign catalogue: `_elCamps` deep clone with add/remove/OR-alternative rows →
  `PATCH /api/gm/settings {election: {campaigns}}`.
- Party treasuries: balance + stock per party; a Fund input (default ₳10,000) →
  `POST /api/gm/mint` against the party's treasury account.

## Border painter (borders.js)

- **Model.** Every region — a Republic province (`p:<id>`) or a foreign country (`c:<id>`) —
  is rasterised on a 4-unit grid (960×540) with canvas anti-aliasing into a `Uint16` ownership
  field (coverage, so the 50% line *is* the drawn border). The pristine land outline
  (`GET /api/gm/map/land` → `settings.map.land`, frozen server-side on the first save) is
  rasterised the same way.
- **Brush.** A stamp raises the target region's share of the land under it by
  `a = strength · (1 − d²/r²)² · organic-noise` and scales every other region's share by
  `(1 − a)` (so shares still sum to one); open sea is skipped. The 50% line is therefore
  *pushed*, not painted. A two-octave seeded value noise (`Borders.noise`) varies how fast each
  patch gives way — that is what makes pushed borders wander. Panel sliders: Brush (radius),
  Push (strength), Organic (noise share). Space / ✋ Pan pans, `[ ]` resize, Ctrl+Z undo
  (12 snapshots of the touched fields).
- **Trace.** Touched regions only: marching squares over `min(region, land)` at 0.5 →
  stitched loops → closed Douglas-Peucker (0.6 units) → `M…l…z` path; specks < 30 units²
  dropped; the largest loop's centroid becomes the label spot of a newly founded region.
  Untouched regions keep their exact original paths. While unsaved, traces live in
  `Borders.overrides`, which `GameMap.render` consults (`shapeOf`), and
  `GameMap.regionNodes[key]` lets the painter update paths in place mid-stroke
  (`MapEdit.dragging` holds sync re-renders off during a stroke).
- **Operations** (Territory panel): *give to…* (province → country: fields merge, province
  dissolved on save), *annex* (country → new province via `POST /api/gm/territory/province`,
  country dissolved on save), *+ Province* / *+ Country* (founded immediately with no land,
  then painted). Discard drops regions founded this session that never got land.
- **Save** → `PUT /api/gm/territory { regions:[{kind,id,shape,labelPos?}], remove:[{kind,id}] }`.
  Every consumer of `shape` (map, war engine grid, `geometry.provinceAt`) needs no change.

