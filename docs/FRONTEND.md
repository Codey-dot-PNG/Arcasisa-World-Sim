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
2. Realtime `sync` (SSE event or Supabase broadcast) → refetch `/api/state` → `renderAll()`.
   The returned `v` (world version) lets the client skip no-op re-renders.
3. All mutations are POST/PATCH calls; the client never mutates `W.state` optimistically —
   it waits for the sync-triggered refetch.
4. `W.state` is already permission-filtered by the server. Absent fields (inventories,
   demographics, events…) mean "not cleared to see" — render defensively.

## Conventions

- DOM built with the `el('tag.class', attrs?, ...children)` helper; views rebuild their
  subtree from scratch on each render (scroll positions restored by app.js).
- No client-side secrets or authority: prices, casino outcomes, election results, and
  permission checks are all server-side. Client-side control checks exist only to show/hide
  UI affordances.
- Charts/styles read CSS custom properties so they follow the active theme.
