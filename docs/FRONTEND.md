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
| `map.js` | `GameMap` — SVG world on the **3840×2160** master grid, pan/zoom, layers (political/data/ownership/military), all drawn from state (`settings.map`, provinces, cities, properties) |
| `mapedit.js` | GM map editor for `settings.map` labels/roads/rails (saves via `PATCH /api/gm/settings {map}`) |
| `war.js` | War Room — territory-fracture map overlay + unit markers (drawn into `GameMap` via a hook) and the War Room panel (status/objectives/casualties/controls); see docs/WAR.md |
| `gm.js` | GM Studio — visual CRUD editors for every collection, Event Engine, templates |
| `gmbar.js` | GM Command Bar (bottom toolbar): advance turns, quick actions. Touches only its own `#gm-bar` subtree |
| `entertainment.js` | Casino/lottery UI — animates toward server-decided outcomes only. Mirrors `ownership.controls` client-side (`ownership_controlsClient`) — keep in lockstep with server/ownership.js |
| `music.js` | Shared soundtrack via hidden YouTube IFrame player, driven by `settings.music` (GM changes propagate on sync) |
| `sfx.js` | Synthesised WebAudio effects; volume rides Music volume; localStorage toggle |
| `pricepath.js` | **Byte-identical copy of server/pricepath.js** — deterministic live price wiggle so clients render (never invent) the day-market ticker |

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
