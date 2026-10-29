# Frontend (public/)

Vanilla JS, no framework, no build. `public/index.html` loads scripts in dependency order —
**keep this order** when adding a file:

```
core.js → pricepath.js → charts.js → map.js → mapedit.js → views.js → sfx.js
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
| `mapedit.js` | GM map editor for `settings.map` labels/roads/rails/lights (saves via `PATCH /api/gm/settings {map}`) |
| `war.js` | War Room — territory-fracture map overlay + unit markers (drawn into `GameMap` via a hook) and the War Room panel (status/objectives/casualties/controls); see docs/WAR.md |
| `gm.js` | GM Studio — visual CRUD editors for every collection, Event Engine, templates |
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
  as the observer's toolbar hint. Protest controls render per lever (`attLead` / `force` /
  `concede`), plus Public Opinion (`renderProtestOpinion`), player petitions
  (`renderProtestApplications`), the GM petition queue (`renderApplicationQueue`) and Protest
  Rules (`renderProtestRules`).
- **Delegation** (`core.js`): `grantCoversClient(entityId, scope)`, `actsForSetClient(scope)`
  (chain + grant entities) and `canSpendFromClient(account)` mirror `ownership.canAct` over
  `S().myGrants`; the transfer/trade/contract pickers, inventory, trade view and the company/
  property desks use them, and delegated accounts are labelled "(delegated)" and kept out of
  "Your Money".
- **The Office** (`office.js`, tab after Parliament): a per-operator desk of widgets
  (`Office.TYPES` — accounts, portfolio, market watch, stock room, headlines, trade inbox,
  polling, chamber, food distribution, situation room, notepad, desk clock, province watch,
  pinned file, ledger). Pointer-event drag (mouse and touch) reorders cards by rectangle
  hit-testing; ⚙ settings (title, style, widget options), ◐ cycles window style
  (`ledger|card|dark|telegram|accent`), ⇔/↕ size. Layout is kept in `Office._local` and
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
