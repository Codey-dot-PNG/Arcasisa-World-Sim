# War (server/war-engine.js, server/war.js, server/war-scenarios.js, public/js/war-engine.js, public/js/war.js)

A realtime, wall-clock-ticking battlefield RTS layered on top of the turn-based
simulation. It does **not** touch the economy or politics yet — only the
timeline log and auto-published news on milestones. It is meant to be wired
into other systems (occupation effects, refugee flows, war economy) later.

**Module split (Phase 18):**

- `server/war-engine.js` — the deterministic, dependency-free SIMULATION
  (movement, combat, territory, objectives, AI, transport-graph pathing,
  embedded point-in-polygon geometry). Shared **byte-for-byte** with
  `public/js/war-engine.js` (the browser copy — edit both together, same rule
  as pricepath.js). All tick-time randomness comes from a mulberry32 PRNG
  seeded per tick from `(war.seed ^ war.tick)` — never `Math.random()` — so
  server and client compute identical ticks from identical state. Timeline
  logs and news milestones are `ctx` hooks: the server passes real
  `store.log`/`sim.draftNews`; a predicting client passes nothing (no-ops).
- `server/war.js` — the server-only AUTHORITY layer: scenario spawning
  (startWar mints `war.seed` once), endWar, bombs (mutate properties/roads/
  deeds beyond `db.war`), the command shim, and `warTick`/`maybeWarTick`
  bound to the server ctx.
- `public/js/war.js` — input, rendering, **client-side prediction** (see
  "Client-side prediction" below).

## State — `db.war`

Absent/`null` means no war is running. Shape:

```js
war: {
  active: true, paused: false, speed: 1,     // speed ∈ {1,2,4,8}
  tickMs: 2000, _lastTick: <epoch ms>,       // wall-clock gate (see maybeWarTick)
  tick: 0, startedAt: <iso>,
  seed: <uint32>,                            // minted once at startWar; per-tick PRNG = mulberry32(seed ^ tick) — the client-prediction determinism anchor
  scenarioId, name, attackerId, defenderId,  // entity ids — attacker is a 'foreign' entity
  grid: {
    cell: 48, cols, rows,                    // 48px cells over the 3840×2160 master grid
    provinceLandCells: { provId: count },    // total LAND cells per province (computed once at startWar)
    provinceCells: { provId: [[cx,cy], …] }, // that province's land-cell indices (patrol/sweep waypoints)
    totalLandCells
  },
  cells: { "cx,cy": { o:'att', p:1, pid: provId } }, // SPARSE — only attacker-held/contested cells; absent key = defender-held (if it's land at all)
  units: [ { id, side:'att'|'def', name, kind, pos:[x,y], dest:[x,y]|null,
             strength, maxStrength, org, speed, atk, state, objectiveId, garrison? } ],
  objectives: [ { id, kind, ref, pos:[x,y], priority, status, holdTicks } ],
  ai: { phase, lastPlanTick, notes:[{t,text}], attackerStartStrength, consolidateFrac, collapseFrac }, // GM-only — stripped by filterState
  events: [ { t, kind:'battle'|'capture'|'landing'|'milestone', pos, text } ], // cap 60, for client animation
  stats: { attLosses, defLosses, provinceControl: { provId: 0..100 }, citiesHeld: [cityIds] },
  bombs: { att: { cooldownUntil: <epoch ms> }, def: { cooldownUntil: <epoch ms> } }, // {att,def} shape kept for compatibility, but only `def` is ever used — bombs are DEFENDER-ONLY
  craters: [ { pos:[x,y], t: <epoch ms>, side } ],  // cap 40, client scorch marks
  mods: { dmg: 1, bombDmg: 1, hp: 1 },       // GM global tuning multipliers — additive/absent-safe, see "GM global tuning" below
  result: null | { winner:'att'|'def'|null, endedAt, reason }
}
```

Unit fields gained by the interactive layer (Phase 16): `dead`/`deadAt` (a
corpse — see below), `orderedBy:'player'`/`playerHoldUntil` (a direct player
move order and, for attacker units only, how long `runAI` must leave it
alone). Phase 17 adds `path` (array of `[x,y]` transport-graph waypoints) +
`pathIdx`, set alongside `dest` whenever routing via roads/rails beats the
straight line — see "Transport-graph pathing" below. Phase 19 adds
`manualPath` (true when `path`/`dest` were set by a player-drawn freehand
line rather than the transport graph — see "Manual paths" below) and the
top-level `mods` field above.

Unit `kind` is free-form scenario data (`marine`, `infantry`, `armored`,
`reserve` for the attacker; every defender is spawned as `garrison`). Unit
`state` is one of `embarked` (attacker only, still at sea), `moving`,
`fighting`, `holding`, `routed`.

Cell keys are **grid indices**, not pixel coordinates (`cx = floor(x/48)`).
The `pid` on a captured cell is cached at capture time purely as a
performance shortcut for `recomputeProvinceControl` — recomputing province
membership by point-in-polygon for every captured cell every tick would
otherwise cost a geometry lookup per cell per tick.

## The tick pipeline — `warTick(db)`

One tick does, in order:

1. **AI grand strategy**, every `AI_INTERVAL` (10) ticks — see below.
2. **Movement** (`stepMovement`) — embarked units sail toward the scenario's
   `landing` objective; land units advance toward `dest`, following their
   transport-graph `path` at `speed × ROAD_SPEED_MULT` (5×) while between
   network waypoints, or in a straight line at base `speed` px/tick when no
   route beat the direct line (see "Transport-graph pathing" below); routed
   units retreat from the nearest live enemy and regenerate organisation.
3. **Combat** (`stepCombat`) — opposing units within `COMBAT_RANGE` (40px —
   exactly the 40-world-unit symbol width, so units fight when their symbols
   touch) fight every tick: Lanchester-ish loss = `K_COMBAT × enemyStrength ×
   (0.7 + 0.6×rand()) × atk`. Garrisons (defenders sitting on a city/military
   property) get a 1.35× defend bonus and drain organisation more slowly. Org
   drops below 25 → rout; strength ≤ 0 → destroyed (killUnit, with a `battle`
   event).
4. **Territory fracture** (`stepTerritory`) — every non-embarked, living unit
   projects control ~1.5 cells out; attacker cells whose CENTRE falls inside
   a province polygon (`geometry.provinceAt`) are marked captured, defender
   units in range recapture (delete the cell). Sea cells are never
   capturable (no province contains them).
5. **`recomputeProvinceControl`** — captured-cell count ÷ that province's
   total land-cell count, per province, from the sparse `cells` map (cheap:
   proportional to cells actually captured, not the whole grid).
6. **Objectives/milestones** (`stepObjectives`) — a `seize_city`/
   `seize_capital` objective completes once an attacker unit has held within
   60px of the city for `CAPTURE_HOLD_TICKS` (3) consecutive ticks with no
   defender unit in range; a `control_province` objective completes once its
   privince crosses `CITY_CONTROL_PCT` (65%). Each completion logs a
   `store.log('event', …)` entry and publishes a news article via
   `sim.draftNews` (the same mechanism `sim.js`'s `news` effect uses).
7. **`checkVictory`** — all objectives done → attacker wins, war ends.
   (Defender victory is decided inside the AI step below, since it hinges on
   the attacker's total strength, not an objective.)

## Transport-graph pathing — roads AND rails, 5× on-network speed

Phase 17 replaced the old proximity road bonus (1.5× within 60px of a road)
with real route-following over a graph built from `settings.map.roads` **plus**
`settings.map.rails`:

- **Graph**: nodes = every polyline point; edges join consecutive points of a
  polyline with weight `distance / ROAD_SPEED_MULT` (5 — on-network travel is
  5× faster), plus junction edges between any two nodes of *different*
  polylines within `ROAD_JUNCTION_RANGE` (50px), so lines that meet at a city
  junction are walkable across each other.
- **Cache**: the built graph lives in a module-level variable keyed by a cheap
  content fingerprint (`polylineCount:pointCount:roundedCoordSum`). This is a
  *pure derived cache* — no gameplay state of its own — so it's serverless-safe
  (a cold start simply rebuilds it) and needs no dirty flag: a bomb cutting a
  road changes the fingerprint, invalidating it on the next path computation.
- **`computePath(db, from, to, baseSpeed)`**: nearest node to `from` (entry)
  and `to` (exit), Dijkstra between them (simple O(V²) array scan — the seed
  network is a few hundred nodes), total route time = off-network entry leg +
  on-network time + exit leg vs. the direct straight-line time; the route is
  used only when it wins, otherwise `null` (straight line, exactly the old
  behaviour).
- **`setDest()`** is the single choke point that assigns `dest` and computes
  `path`/`pathIdx`; every dest writer (player `commandUnits`, `runAI` target
  and sweep assignment, the embarked→landing handoff) goes through it, and
  `clearDest()` wipes all three together. `stepMovement` runs waypoint legs at
  `baseSpeed × ROAD_SPEED_MULT` (advancing `pathIdx` within 12px of each
  waypoint) and the entry/exit legs at base speed; the blocked-by-enemy
  collision check still applies while on a path.
- **Accepted rough edge**: the path is computed once, at order time — a road
  destroyed mid-traversal does not reroute a unit already following its
  waypoints; it finishes the remembered path at on-network speed.

### Manual paths (Phase 19)

A player can draw a freehand path instead of issuing a plain move order — see
"Right-drag" in the Input gestures table below. `applyOrders` accepts an order
shaped `{ unitId, path:[[x,y],…] }` (instead of `{ unitId, dest }`); the
engine's `setManualPath(db, u, waypoints)` clamps each point in-bounds (cap
`MAX_MANUAL_PATH_POINTS` = 200), then sets `unit.path` to the drawn waypoints,
`unit.pathIdx = 0`, `unit.dest` to the path's last point, and
`unit.manualPath = true`. In `stepMovement`/`stepAlongPath`, a `manualPath`
unit follows its waypoints at **base speed only** — it deliberately does NOT
get the `ROAD_SPEED_MULT` (5×) bonus, even if the drawn line happens to run
along a road, because the player chose to hand-route it rather than let the
transport graph route it. `setDest()` (any later plain-move order, including
the AI reassigning an attacker unit) clears `manualPath` back to `false` and
restores normal road/rail routing; `clearDest()` clears it too.

## World border clamp

Every position write in the engine — normal straight-line advance, transport-
graph/manual-path following, routed retreat, and the friendly-separation
nudge — is clamped to `[WORLD_BORDER_INSET, W - WORLD_BORDER_INSET]` on each
axis (`WORLD_BORDER_INSET` = 8px), where `W`/`H` are **derived** from
`war.grid.cols/rows × war.grid.cell` rather than hardcoded 3840×2160 (see
`worldBounds`/`clampToWorld` in war-engine.js). `setDest`/`setManualPath` also
clamp the `dest`/waypoints they assign, so neither a player order nor an
AI-assigned objective can send a unit off the map — the engine is the single
choke point for this, covering both authoritative ticks and predicted-client
ticks from optimistic orders.

## Combat tuning — collision-only fights, 10× HP (Phase 17)

`COMBAT_RANGE` and `COLLIDE_ENEMY` are both 40px — the unit symbol's own
world width, so combat starts when symbols visually touch, never at standoff
range (`CAPTURE_RANGE` stays 60). All scenario strengths were multiplied ×10
(`UNIT_DEFAULTS`, `citySizeStrength` {1:1300, 2:2200, 3:3800},
`militaryPropertyStrength` 2600) **and** `K_COMBAT` divided by 10 (0.035 →
0.0035): damage is `k × enemyStrength`, so ×10 strengths alone would leave
relative attrition identical — the k reduction is what actually stretches
time-to-kill ~10×. `BOMB_UNIT_DMG` stays 90, so a bomb now wounds units
rather than annihilating them (intended). Org/rout thresholds are unchanged —
fights resolve by routing more often than annihilation. These numbers apply
to **new** wars only: an in-progress war keeps the strengths it started with
(no migration of a live `war.units` array).

## GM global tuning (Phase 19) — `war.mods`

Three GM-adjustable multipliers, additive/absent-safe (`war.mods` may be
missing entirely on a legacy war doc — every read is defensive, e.g.
`(war.mods && war.mods.dmg) || 1`):

- **`dmg`** — multiplies both `dmgToDef`/`dmgToAtt` in `stepCombat` (the
  engine, so client prediction picks it up too).
- **`bombDmg`** — multiplies `BOMB_UNIT_DMG` falloff damage in `dropBomb`
  (server/war.js only — bombs are a server-only authority-layer mutation, not
  part of the shared engine tick).
- **`hp`** — does NOT get read per-tick; changing it immediately rescales
  every LIVE unit's `strength`/`maxStrength` by the ratio `newHp / oldHp`
  (proportional, so a unit at 40% HP stays at 40% HP after the rescale). This
  happens once, in `server/war.js`'s `setWarTuning`, at the moment the GM
  changes the slider — not in the engine, since it's a one-shot mutation of
  existing units rather than a per-tick read. Newly spawned units aren't
  affected retroactively by an `hp` set before their scenario starts (each
  new war resets `mods` to `{dmg:1, bombDmg:1, hp:1}`).

`POST /api/gm/war/tuning { dmg?, bombDmg?, hp? }` (GM-only) validates each
provided key as a finite number, clamps it to `[0.1, 10]`, and calls
`setWarTuning` (mutate → `store.log` → `store.save` → `broadcast('sync')`).
The War Room panel's GM section (`public/js/war.js`'s `renderTuning`) exposes
three sliders (range 0.1–5, step 0.1, live `×` readout) that POST on a ~300ms
debounce so dragging doesn't spam the route.

## AI grand strategy — attacker only

Defenders never move: every defender unit is a static garrison spawned at a
city or a `type:'military'` property, generic to any scenario (see below).
Only the attacker plans.

Every `AI_INTERVAL` ticks, `runAI`:

- Computes attacker total strength. Below `collapseFrac` × starting strength
  → the invasion is declared destroyed, the defender wins, the war ends.
- Below `consolidateFrac` × starting strength → phase `consolidate`: every
  committed unit's `dest` is cleared and it holds its ground. No further
  pushes are ordered until (if ever) that changes.
- Otherwise phase is `landing` while the scenario's `landing` objective is
  still pending, else `breakout` (working through the objective list) or
  `exploit` once every objective is done.
- Picks the highest-priority (lowest `priority` number) incomplete objective
  that isn't `control_province` (`primaryObjective`) and assigns it as
  `dest`/`objectiveId` to every committed unit — except every 4th committed
  unit, which is held back to garrison the most recently captured city
  instead (so captured ground doesn't immediately fall back into fog).
- Once every `landing`/`seize_*` objective is done but a `control_province`
  objective is still short of its threshold, there is nothing left to march
  toward — units instead sweep to **random land cells inside that province**
  (`randomProvincePoint`, drawn from `grid.provinceCells`), reassigned
  immediately on arrival (in `stepMovement`, not gated on the next AI cycle)
  so the captured footprint keeps growing between AI replans instead of
  units idling on objectives they've already taken.
- Every decision writes a one-line reasoning string into `ai.notes` (capped
  20) — this is the GM's window into what the AI is "thinking"; it is
  stripped from the client payload for non-GM operators (see Fog of war).

## Scenario format — `server/war-scenarios.js`

Pure data, no engine logic (mirrors the `seed.js`/`sim.js` split). Exports
`{ scenarios: { <id>: scenario }, UNIT_DEFAULTS }`.

```js
scenario = {
  id, name, attackerId, defenderId,        // entity ids — attackerId must resolve to a 'foreign' entity
  staging: { x0, y0, x1, y1 },              // sea box; attacker units spawn 'embarked' at random points inside it
  objectives: [ { kind, ref?, priority } ], // ref is a city/province id. 'seize_capital' may omit ref —
                                            // war.js resolves whichever city has isCapital:true, so the
                                            // scenario never has to name the capital twice.
  units: [ { name, kind } ],                // kind indexes UNIT_DEFAULTS for strength/speed/atk unless overridden per-unit
  defense: { citySizeStrength: {1,2,3}, militaryPropertyStrength }, // war.js spawns one garrison per city (by size)
                                            // and one per type:'military' property — no ids named here
  tuning: { consolidateFrac, collapseFrac } // fractions of the attacker's OWN starting strength
}
```

**Why `city_lachevan` only gets one objective, not two:** in the seed world
`city_lachevan` IS the capital (`isCapital: true`). The brief for this
scenario listed it as both an intermediate `seize_city` stop and (separately)
"seize the capital, found via `isCapital`" — since those name the same city,
`valksland_invasion`'s objective list has a single `seize_capital` entry
(engine-resolved) instead of a redundant duplicate `seize_city` for the same
place. `city_razno` and `city_valgos` remain ordinary `seize_city` stops.

The shipped scenario (`valksland_invasion`): Valksland (`for_valksland`)
stages a dozen units in the Strait of Valgos (east of every Arcasian
province, west of the Valksland landmass), lands near Cape Valgos
(`city_valgos`), then in priority order: take Cape Valgos → take the capital
→ take Razno (`city_razno`) → hold 65% of Lachevan province. Balanced (by
playtesting at 8× speed) to reach the capital in single-digit minutes of
real 1× time and finish the whole campaign in roughly 15–30 minutes.

## Interactive War layer (Phase 16)

A dedicated map layer (`⚔ War`, public — appears for any operator once
`db.war` exists) lets a player command troops in realtime instead of only
watching the AI-vs-garrison front. **Authority is server-authoritative**: the
client only sends orders; `server/war.js` validates and applies them.

- **Who commands what**: the GM may command either side via a `side` param
  (default `'def'`); every other operator is forced onto `'def'` regardless
  of what the client sends (`server/api.js`'s two war routes compute
  `side = u.role.perms.gm && b.side === 'att' ? 'att' : 'def'`). The attacker
  AI (`runAI`) keeps driving the invasion — a GM commanding `'att'` directly
  only pins the units it explicitly orders (see player-hold below); it
  doesn't disable the AI.
- **Input gestures** (Phase 19 redesign — right-drag used to be the formation
  gesture; it now draws a freehand custom path instead, and formation moved
  to its ctrl-left-drag alias, which already existed. The base map's plain
  left-drag pan is never consumed, and a click on empty ground deselects;
  map.js delegates pointerdown/move/up to `War.onMapPointerDown/Move/Up`
  while `W.layer === 'war'`, and suppresses the browser context menu on the
  map svg for that layer only):

  | Gesture | Action |
  |---|---|
  | Right-click | Move order for the current selection (single unit goes to the point; multiple spread in a small ring) |
  | Right-drag | **Custom path** — draws a freehand polyline for the current selection to follow at base speed, ignoring road/rail routing (see "Manual paths") |
  | Ctrl+left-drag | Formation — distributes the selection along the drawn line, nearest-in-order (the gesture right-drag used to trigger) |
  | Left-click on an own live soldier | Select it (replaces the selection) — per-marker listeners, enemy/dead units aren't clickable |
  | Shift+left-click on a soldier | Add/toggle it in the selection |
  | Shift+left-drag on ground | Box-select all live units of the commandable side inside the marquee |
  | Plain left-click on ground | Deselect (the dossier handlers stand down on the war layer, so the click reaches the svg-level handler) |
  | Plain left-drag | Pan — exactly the base map, War never consumes it |
  | Esc | Clear selection + disarm the bomb (window-level, bound once) |
  | Bomb armed + left-click | Drops the bomb at the click point (defender only — see below), then disarms |

  A right-button drag under ~12 world px is still treated as a plain click
  (move order); at or above that it samples pointer positions into a
  polyline (points kept ≥25px apart) with a live dashed preview, and on
  release with ≥2 points issues a path order for every selected unit.
- **Command routes**:
  - `POST /api/war/command { side?, orders:[{unitId,dest:[x,y]}]|[{unitId,path:[[x,y],…]}] }`
    — any logged-in operator; validates `orders` (array, cap 64; each `dest`
    a finite `[x,y]` inside the 3840×2160 grid, or each `path` an array of
    2-200 such points), then `war.commandUnits` → `engine.applyOrders`. An
    order carries either `dest` (plain move, road/rail routing applies) or
    `path` (freehand — see "Manual paths"), never both meaningfully (`path`
    wins if present).
  - `POST /api/war/bomb { side?, pos:[x,y] }` — same auth/side rule;
    `war.dropBomb`; returns the new cooldown timestamp.
  Both are outside the `/api/gm/...` block — deliberately player-accessible,
  unlike every other war route.

### Mobile defenders & collision

Garrisons are still static by default (spawn `speed: 0`), but the first time
a player orders one to move, `commandUnits` grants it `DEF_MOVE_SPEED`
(3.2 px/tick) and it marches like any other unit. The garrison's 1.35× defend
bonus (`stepCombat`) now only applies while it's stationary (`garrison &&
!dest`) — a garrison that leaves its position fights as a regular unit.

Units never pass through a live enemy: before advancing toward its `dest`,
`stepMovement` checks the nearest live enemy and refuses to close within
`COLLIDE_ENEMY` (46px) of it — the unit stops and its state becomes
`'fighting'` instead, letting `stepCombat` grind the engagement out until one
side routs (the existing rout/retreat logic is exactly how a unit "steps out
of the way"). A light `FRIENDLY_SEP` (30px) separation nudges overlapping
same-side units apart each tick so live stacks don't visually merge (garrisons
that are holding are exempt, so dug-in stacks stay put).

### Corpses

A unit that hits `strength <= 0` is no longer spliced out of `war.units` —
`killUnit` marks it `dead: true, deadAt: <tick>, state: 'dead', dest: null`
and it stays in the array. The `isLive(u)` helper (`strength > 0 && !u.dead`)
gates every place a unit must be alive: movement, combat targeting,
collision, territory projection, objective checks, AI strength sums. Corpses
render at reduced opacity with no HP bar and aren't selectable. They're kept
for the rest of the war (the roster is small, ~24 units) but pruned once
older than `CORPSE_MAX_AGE_TICKS` (400) so a very long war doesn't grow
`war.units` unbounded.

### Bombs — defender-only

Only the defence has an air arm: `dropBomb` rejects any `side !== 'def'`
outright, and `/api/war/bomb` forces `side = 'def'` for everyone including
the GM (the GM `att` branch exists only on `/api/war/command`). The client
mirrors this — the Bomb button is disabled with a "The invader has no air
arm." hint while the GM is commanding the attacker. `war.bombs` keeps its
`{att,def}` shape for compatibility with existing war docs, but only `def`
is ever used now.

`dropBomb(db, side, pos, actor)` — validated (side is 'def', war active, not
paused, the defender's cooldown expired) then, on success:
1. Sets a `BOMB_COOLDOWN_MS` (12s) cooldown for that side.
2. Damages every live unit (both sides) within `BOMB_RADIUS` (95px) by up to
   `BOMB_UNIT_DMG` (90), falling off linearly to 0 at the radius edge; a unit
   that drops to 0 becomes a corpse via the same `killUnit` path as combat.
3. Destroys every property within the blast radius (removed from
   `db.properties`), then calls `deeds.syncAllDeeds(db)` **once** after the
   loop — properties are never hand-deleted from the deed register; this is
   the sanctioned choke point that retires the orphaned deed items and
   inventory rows in one idempotent pass.
4. Cuts roads: any `settings.map.roads` polyline with a point inside the
   blast has those points stripped; if that splits the line into two or more
   surviving runs of ≥2 points, each run becomes its own new road object
   (`{ id: store.uid('road'), pts: run }`) — this changes the transport
   graph's content fingerprint, so the cached routing graph rebuilds on the
   next path computation and the cut immediately costs mobility for NEW
   orders (units already mid-route keep their old waypoints — see the
   pathing section's rough edge).
5. Records a crater (`war.craters`, capped at 40) and a `'battle'` war event
   so the client flashes it.

## Client-side prediction (Phase 18) — why the war feels realtime now

The pre-Phase-18 war was poll-bound: ticks only ran when something hit the
server's wall-clock gate, and clients only saw movement after a full
`/api/state` refetch. Worse, on serverless the tick loop is **not
self-sustaining** — a tick's own broadcast triggers refetches that land well
inside the next 2s tick window (so they don't tick), and then nothing polls
until the 20s fallback: idle wars advanced in 20-second catch-up bursts.

Three mechanisms fix it, all in `public/js/war.js` + the shared engine:

1. **Predicted war** — the client keeps a deep copy of the last authoritative
   `db.war` and ticks it locally with the SAME engine on the same wall-clock
   gate (`WarEngine.maybeWarTick`, 250ms driver interval, paused while
   `document.hidden`, bounded to ≤10 ticks ahead of the last authoritative
   tick). The map renders the predicted doc, so units keep moving/fighting
   at full cadence between server snapshots. Every new authoritative war
   object (full refetch or heartbeat) **rebases** the prediction with
   ROLLBACK RECONCILIATION: a snapshot is usually *behind* the local sim
   (network latency + the server only ticking when polled), so adopting it
   raw would teleport units backward every sync — instead the snapshot is
   fast-forwarded deterministically (≤12 ticks) to the tick the player is
   already watching, folding in whatever the server knew (other players'
   orders, bombs, AI replans) with a visually seamless swap. The local tick
   PHASE (`_lastTick`) is carried across rebases (clamped if ≥2 intervals
   stale) — resetting it per snapshot would starve prediction whenever
   snapshots arrive faster than the tick interval, which is exactly what
   happens at 4×/8×. A stale snapshot of the same war (`tick <` the rebase
   base tick) is ignored. Non-GM clients have `war.ai` stripped, so the
   engine simply skips AI replans in their prediction (units keep marching
   on existing dests; the next snapshot carries any replan).
2. **Optimistic orders** — `_issueMove`/`_issueFormation` apply orders to the
   predicted war immediately via `WarEngine.applyOrders` (the same pure
   function the server route uses), before the POST round-trips. An outbox
   (5s expiry) re-applies them across rebases until a server snapshot
   reflects the dest, so an in-flight order's arrow never flickers away.
3. **War heartbeat** — while a war is active and the tab is visible (map
   layer OR War Room panel), the client polls `GET /api/war/state` once per
   tick interval (min 1s). The route runs `maybeWarTick` (driving the
   authoritative simulation at cadence — this is what makes the serverless
   tick loop self-sustaining) and returns just `{war, v}` (ai stripped for
   non-GM), which the client version-guards (`v` monotonic, same rule as
   core.js) and rebases onto.

Two rendering rules keep it smooth (both born from live-server testing):

- **War-layer-only redraws** — predicted ticks and heartbeat rebases rebuild
  only the `war-layer` SVG group (`War.refreshLayer`), never the whole map;
  a full `GameMap.render()` per tick was most of the perceived lag. Marker
  interpolation is LINEAR with the leg duration equal to the tick interval,
  and a mid-leg redraw whose target is unchanged KEEPS the in-flight leg
  (recreating it restarted the motion clock — crawl-and-freeze stutter).
  The rAF loop also drags each move arrow's tail along with its tweened
  marker, so arrows track movement continuously instead of per render.
- **Milestone-only broadcasts** — war ticks `store.save()` (commit bumps
  `v`, which heartbeat pollers read) but only `broadcast('sync')` when the
  milestone fingerprint changes (war ended / objective done / city fell —
  `war.maybeWarTickSignal` in server/war.js, used by both api.js call sites
  and server.js's local interval). Per-tick broadcasts forced EVERY client
  into a full `/api/state` refetch + whole-app re-render at up to 1Hz
  during a war — that global thrash, not the war itself, made the app lag.

Determinism contract: `war.seed` is minted once at startWar (migrate defaults
legacy wars to seed 1, matching the engine's `(seed>>>0)||1` fallback);
combat rolls and sweep waypoints draw from the per-tick PRNG in state-defined
order. Prediction still diverges when it can't know something (another
player's orders, a bomb, an AI replan on non-GM clients) — that's fine; the
next rebase discards the error, and the marker tween (whose duration now
matches the tick interval instead of a fixed 900ms, so motion is continuous
rather than stop-start) absorbs the correction visually.

This snapshot → local deterministic simulation → optimistic writes →
rebase-on-authority pattern is deliberately generic: it's the template for
making other poll-bound systems (Day Market already does a read-only version
via pricepath; turn previews could too) feel realtime without touching the
CAS commit model.

## API — `server/api.js`

- `POST /api/gm/war/start { scenario }` — GM-only; 409 if a war is already
  active; 400 for an unknown scenario id or a scenario referencing missing
  entities.
- `POST /api/gm/war/control { paused?, speed? }` — GM-only; `speed` must be
  one of 1/2/4/8.
- `POST /api/gm/war/end` — GM-only abort. `endWar` sets `active:false` and
  (if the war hadn't already produced a result) a `result` with
  `winner: null` — **the war document is kept, not deleted**, so the GM (and
  players) can review the final front line and casualty count. A GM must
  start a new scenario to run another war; there's no separate "clear" route
  — the next `war/start` fails with 409 while one is still `active`, and
  since `startWar` overwrites `db.war` wholesale, starting a new scenario
  after a `result` has been set naturally replaces the old record.
- `POST /api/gm/war/tuning { dmg?, bombDmg?, hp? }` — GM-only; each provided
  key must be a finite number, clamped to `[0.1, 10]`; calls
  `war.setWarTuning` — see "GM global tuning" above for what each multiplier
  does and why `hp` rescales live units immediately while `dmg`/`bombDmg`
  just get read fresh next fight/bomb.
- `POST /api/war/command { side?, orders:[{unitId,dest}]|[{unitId,path}] }`
  and `POST /api/war/bomb { side?, pos:[x,y] }` — **player-accessible** (any
  logged-in operator, not GM-gated); see "Interactive War layer" above for
  the authority model and validation, and "Manual paths" for the `path` order
  shape.
- `GET /api/war/state` — **player-accessible** lightweight heartbeat (Phase
  18): runs `maybeWarTick` (save + broadcast on a real tick) and returns
  `{war, v}` only, with `war.ai` stripped for non-GM exactly like
  filterState. Clients watching an active war poll it at ~tick cadence; see
  "Client-side prediction" above.
- Heartbeat: `GET /api/state` also calls `war.maybeWarTick(db)` right after
  the existing `market.maybeDayTick(db)` call, saving + broadcasting on a
  real tick — identical wall-clock-gate pattern, so any traffic at all
  drives the war even if no one is running the dedicated heartbeat.
- `api.filterState`: `db.war` ships to every logged-in operator (so all
  players can watch the front), but `war.ai` (phase, notes, thresholds) is
  deleted for non-GM roles — the AI's planning is intentionally invisible to
  players, only its visible consequences (units, territory, objectives,
  events) are public. This means the War Room panel's phase readout is also
  GM-only in practice, since it lives inside `ai`; players still see
  objectives, casualties, province control and the event feed.

## Local realtime — `server.js`

A ~1s `.unref()`ed interval calls `war.maybeWarTick` (same pattern as the
existing 5s Day-Market interval) and saves + broadcasts on a real tick. This
is local-mode convenience only — on Vercel there is no timer at all;
`GET /api/state` rides the same gate, exactly like the Day Market.

## Migration

`store.migrate()` adds a narrow, idempotent guard: a `db.war` missing a
numeric `tick` (a legacy/malformed doc) is deleted rather than left to crash
the tick loop. No schema bump — `db.war` is additive/absent-by-default, and
`'war'` was added to every role's `pages` list the same way `'entertainment'`
was previously (see the `STD_PAGES` loop in `migrate()`). Phase 16 added two
more additive guards next to it: a `db.war` missing `bombs` or `craters`
(started before this change) gets them defaulted in place. Phase 18 adds one
more: a `db.war` missing a numeric `seed` gets `seed: 1` — the same value the
engine falls back to (`(seed>>>0)||1`), so server and predicting clients
agree even on a pre-engine war.

## Client — `public/js/war.js`

Loaded after `map.js`/`mapedit.js`, before `views.js`.

- **Map layer**: `GameMap.render()` calls `War.renderMapLayer(this, mk, NS)`
  after the event-marker layer. It draws, per render:
  - **Territory fracture** — captured cells grouped by province, each drawn
    as a union of 48px cell rects filled with a hatched `<pattern>`
    (`#war-hatch`) and clipped to that province's real SVG shape
    (`<clipPath>`), so captured ground reads as chunks bitten out of the
    real province outline rather than a floating grid.
  - **Unit markers** — small NATO-style rectangles, tinted red (attacker) or
    navy (defender), with a kind glyph, a strength pip bar, and a pulsing
    ring on `fighting` units. **Two scale modes** (Phase 17): above
    `WAR_FIXED_MODE_K` (3) map zoom, markers render at a constant WORLD
    scale — a fixed 40×28 world-unit symbol that grows on screen as you zoom,
    exactly matching the server's 40px collision/combat range (the hitbox IS
    the symbol, since the marker group itself is the click target). Below the
    threshold they counter-scale to a constant SCREEN size so units stay
    readable over the whole island; `scale = max(1, 3/k)` is continuous at
    the boundary, so there's no pop mid-zoom. The rAF loop recomputes it
    every frame.
  - **Movement arrows** — for every commandable-side live unit with a `dest`,
    a dashed polyline from the (tweened) marker along its remaining `path`
    waypoints (straight to `dest` when there's no route), ending in an SVG
    `<marker>` arrowhead. Selected units get the bright amber
    `.war-move-arrow-sel`, other own units the fainter `.war-move-arrow`.
    Enemy movement arrows are deliberately NOT drawn — fog of war on intent.
  - **Battle flashes** — a fading ring at each recent `war.events` position.
  - **Craters** — dark scorch circles at each `war.craters` entry, drawn under
    the territory/unit layers.
  - **War toolbar** — a small floating control surface, present only while
    `W.layer === 'war'`: the gesture hint line, an arm/cooldown Bomb button,
    Clear selection, and (GM-only) a Defender/Attacker command-side toggle.
  - Positions are **tweened client-side**: a module-level `_anim` registry
    (keyed by unit id, not DOM node) remembers each unit's last interpolated
    position across renders, so even though `GameMap.render()` tears down
    and rebuilds the whole SVG on every sync, a unit's marker keeps easing
    from where it visually was toward the new server position (~900ms ease)
    instead of snapping. A single shared `requestAnimationFrame` loop
    (`ensureLoop`) drives both this tween and the battle-flash fade, and
    also applies the current map zoom as a counter-scale so markers stay a
    constant screen size.
- **War Room panel** (`War.renderPanel`, wired into `Views.render` for
  `W.view === 'war'`, tab added to `App.PAGES`): status line, casualty/city
  counters, objective table, per-province control bars (`Views.barRow`), and
  a recent-events feed. GM-only: pause/resume, speed 1×/2×/4×/8×, End War,
  and the scenario picker (currently just `valksland_invasion`) shown when no
  war is running or the last one has concluded.

## Known rough edges

- The AI's "garrison every 4th committed unit on the last city taken" rule
  is a flat heuristic, not a real threat assessment — it can leave a
  just-captured city under-defended if the defender still has a nearby
  garrison it hasn't yet engaged.
- `control_province`'s random-sweep fallback has no notion of "already dense
  in this area" — units can (rarely) repeatedly sample nearby cells instead
  of spreading out, slowing the last few percent of a control objective.
- Transport-graph routes are computed at order time and never re-planned: a
  road destroyed mid-traversal doesn't reroute a unit already following its
  waypoints (it finishes the remembered path at on-network speed), and a
  straight-line fallback can still path into water at a re-entrant coastline
  if a scenario ever places waypoints badly.
- Defenders are purely static garrisons unless a player moves them; there's
  still no defender-side AI (no counter-attacks, no falling back to
  consolidate a line) — a defender left alone by every player behaves exactly
  as before.
- The formation gesture assigns slots along a straight line only — no
  wedge/column presets, and a very uneven selection (wildly different
  positions) can produce awkward nearest-in-order pairings.
- Bomb blast radius and combat range are both simple circle checks, matching
  the rest of the engine's coarse-by-design approach (see
  docs/CONVENTIONS.md) — no line-of-sight, no terrain occlusion.
- Corpses are pruned by age (`CORPSE_MAX_AGE_TICKS`), not by count; an
  unusually long, static war could still accumulate a few hundred stale
  corpse entries before the age cutoff catches up.
