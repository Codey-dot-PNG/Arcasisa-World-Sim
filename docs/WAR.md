# War (server/war-engine.js, server/war.js, server/war-scenarios.js, public/js/war-engine.js, public/js/war.js)

A realtime, wall-clock-ticking battlefield RTS layered on top of the turn-based
simulation. Since Phase 22 the war **does** touch the world: ground combat and
air raids kill civilians (province populations + demographics shrink),
occupation sends refugee waves to interior provinces, and treaties (Phase 24)
redraw the map itself. Equipment (Phase 23) ties armies to the item economy:
gun and fuel stocks scale damage/armour/morale/speed per side.

**Phase 22–25 additions at a glance** (details live in the matching code
comments; state fields are all additive/absent-safe):

- **Total war** — completing the scenario objectives no longer ends the war;
  it sets `war.totalWar` (milestone broadcast + news) and the AI enters a
  'total' phase: hunt every remaining defender (chase orders), then sweep the
  least-controlled province. The war ends only on a complete win: attacker
  holds ≥ TOTAL_VICTORY_PCT (97%) of EVERY province with no defender alive,
  or the invasion force is annihilated outright / collapses (the existing
  collapse rule remains the other defender win).
- **Defender invasion & closed borders** — `buildGrid` also rasterises every
  map nation (`grid.countryCells/countryLandCells`); `refreshWarZones`
  derives `grid.enemyCells` (attacker-side homelands — defender units CAPTURE
  these as `{o:'def', c: countryId}` cells, drawn in the defence's blue) and
  `grid.neutralCells` (non-belligerent soil — NO unit may enter: `advanceToward`
  refuses the step and wall-follows ±45°/±90°/±135° around the border,
  deterministically). `war.stats.enemyControl` tracks % of each enemy
  homeland occupied; zones re-derive when the belligerent set changes
  (`war._zonesKey`, reset by joinWar). Entities link to a map country by
  `e.countryId` or normalised name match (`countryIdForEntity`).
- **Occupation devastation** (authority-only — `server/war.js
  applyDevastation`, called after every real tick; a predicting client never
  runs it): fighting units kill `settings.war.civPerFightTick` (default 6,
  scaled by strength) civilians per tick in their province; an airstrike
  kills `civPerStrike` (500 × bombDmg). Occupation crossing each
  `refugeeStages` threshold (25/50/75/95%) moves `refugeeFrac` (5%) of the
  province's people inward to the 3 least-occupied provinces, demographics
  pro-rata, with news. `war.stats.civilianDeaths/refugees` accumulate.
- **Equipment quality (Phase 23, per-unit since Phase 26)** — items carrying
  `meta.weapon` (`{kind:'smallarms', dmg, hp, morale}` or `{kind:'fuel',
  speed}`) arm the war. Every unit holds its OWN inventory (`u.inv`, the
  entity-inventory row shape) and its combat multipliers `u.kit =
  {dmg,hp,morale,speed}` are folded from THAT before every authoritative
  tick (server/war.js resupplyUnits: the unit's soldiers armed
  best-gun-first from its own packs, each armed man contributing 1× + his
  weapon's stats and each UNARMED man only `settings.war.unarmedDmg/
  unarmedHp/unarmedMorale` — defaults 0.25/0.5/0.3, so a gunless division
  fights with fists: quarter damage, double damage taken, breaks 3× faster;
  speed from the best fuel grade carried × tank fullness, full tank =
  strength × `settings.war.fuelPerStrength`). Resupply is the drain on the item
  economy: a unit inside its supply corridor tops up to one gun per soldier
  and refills its tank OUT OF its own nation's stockpile — the entity
  inventory of `u.nationId` (fallback: the side's principal belligerent;
  Republic units also eat military-property depots). Casualties destroy
  their guns, movement burns fuel (`settings.war.fuelBurnFrac` of a tank per
  call), so national arsenals deplete tick by tick and an arms factory (see
  `prop_arc_arms`, ARC's rifle line) is war infrastructure. The shared
  engine only CONSUMES the stored multipliers (`unitMul` in stepCombat's
  damage/armour/morale drain and advanceToward's step; falls back to the
  side-wide `war.equip`, now the strength-weighted mean kit kept for the War
  Room readout), so client prediction replays identically. Weapon items are
  seeded once by store.migrate (`world._weaponsSeeded`; `world._arcArms`
  renames the Republic rifle to the ARC M38 Bolt Action and builds the
  factory); the GM mints more from the item template "Weapon — small arms"
  and edits stats in the Metadata JSON.
- **Homeland musters** — joinWar contingents from nations with a map homeland
  mobilise FROM that homeland (nearest home cell to where they're needed),
  as mobile infantry on either side (a def ally marches on the capital);
  off-map nations keep the old near-the-front spawn.
- **Peace treaties (Phase 24, GM-only)** — `POST /api/gm/war/treaty` with any
  of: `reparations {fromEntityId, toEntityId, amount}` (sim.txn between
  primary accounts), `cede {provinceId, toEntityId}` (the province's shape
  becomes a new country entry in the recipient's colours; its cities and
  properties leave the Republic's books — deeds re-synced), `annex
  {countryId}` (the nation's polygon becomes a NEW province with generated
  demographics scaled to `settings.war.annexPopulation`, a namesake city at
  the polygon centroid, and the country entry removed — map render,
  geometry.provinceAt, elections and future war grids all pick it up because
  they read `province.shape`). Signing during an active war ends it first.
  GM UI: the "Peace Treaty" desk in the War Room panel.
- **Relations shocks (Phase 25)** — startWar hits the attacker −40; joinWar
  +25 (defence) / −30 (invader) via `sim.shiftRelations` — see
  docs/SIMULATION.md "Foreign relations".

**Phase 27 war-overhaul additions at a glance** (each has a full section
below; state fields remain additive/absent-safe):

- **Naval kinds** — two new unit kinds, `boat` and `warship` (`NAVAL_KINDS`):
  water-only movers (they wall-follow around land the way every unit already
  wall-follows around neutral borders). Warships never fight in the 40px
  collision pass at all — they fire in a separate RANGED pass at
  `WARSHIP_RANGE` (180px) with a `WARSHIP_TRANSPORT_BONUS` (3×) against
  transports and boats. See "Naval kinds — boats & warships".
- **Transport state** — a LAND unit whose position ends up over open sea
  becomes `state: 'transport'` (rendered as a little transport ship): it
  cannot deal damage but can still be hit, and resumes its previous state on
  landfall. Backed by a new merged `grid.landCells` land/sea lookup. See
  "Transport state".
- **Arsenal deployment at war start** — `startWar` walks the defender's own
  inventory for `meta.weapon.kind: 'tank'/'warship'` items: every 25 tanks of
  a model become one armoured unit at the capital, every warship item becomes
  one warship unit at the nearest port. See "Tank & warship arsenal
  deployment".
- **Population-scaled garrisons** — the defender roster is no longer a flat
  one-garrison-per-site rule; the garrison COUNT scales with national
  population (`POP_PER_GARRISON`), distributed across the same city/military-
  property sites by weight. See "Population-scaled garrisons".
- **Dynamic attacker staging** — the staging box is computed fresh from
  current map data (homeland bearing for naval attackers, nearest own soil
  for land ones; `scenario.bearingHint` covers off-map powers), falling back
  to the static `scenario.staging`. See "Dynamic attacker staging".
- **Neutral-territory hardening** — orders and transport-graph routes are
  kept off closed-border soil BEFORE movement starts (`nearestNonNeutralPoint`
  dest/waypoint clamping, blocked Dijkstra nodes), not just refused mid-step.
  See "Neutral-territory hardening".
- **Occupation transfers property** — a property sitting on attacker-held
  ground changes owner via the deed choke point (`applyOccupationTransfers`,
  authority-only), reverts if recaptured, and stays with the occupier after
  the war ends. See "Occupation property transfers".
- **Alliance auto-join** — nations allied with a belligerent
  (`entity.meta.military.allies`, seeded by store.migrate) auto-join at
  `startWar` through the existing joinWar pathway; `scenario.allies: false`
  opts out, `scenario.coAttackers` force-joins. See "Alliance-aware wars".
- The wider Phase 27 economy half — foreign per-turn military production,
  property-tied company profits, war→market/happiness effects, the tank and
  warship items themselves — lives in docs/SIMULATION.md and
  docs/WORLD-DATA.md.

**Module split (Phase 18):**

- `server/war-engine.js` — the deterministic, dependency-free SIMULATION
  (movement, combat, territory, objectives, AI, transport-graph pathing,
  airstrike blast resolution, embedded point-in-polygon geometry). Shared
  **byte-for-byte** with `public/js/war-engine.js` (the browser copy — edit
  both together, same rule as pricepath.js). All tick-time randomness comes
  from a mulberry32 PRNG seeded per tick from `(war.seed ^ war.tick)` — never
  `Math.random()` — so server and client compute identical ticks from
  identical state. Timeline logs, news milestones and an airstrike's
  authority-only ground effects are all `ctx` hooks: the server passes real
  `store.log`/`sim.draftNews`/`onAirstrike`; a predicting client passes
  nothing (no-ops).
- `server/war.js` — the server-only AUTHORITY layer: scenario spawning
  (startWar mints `war.seed` once), endWar, dropBomb (ORDERS an airstrike —
  the blast itself is engine-side, see "Airstrikes" below), the ground
  effects an impact triggers (mutate properties/roads/deeds beyond `db.war`,
  via `ctx.onAirstrike`), the command shim, and `warTick`/`maybeWarTick`
  bound to the server ctx.
- `public/js/war.js` — input, rendering, **client-side prediction** (see
  "Client-side prediction" below), plus the airstrike's purely-cosmetic
  plane and fireball/shockwave/debris impact FX (see "Client — plane,
  fireball, shockwave" below).

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
    totalLandCells,
    landCells: { "cx,cy": true }             // Phase 27 — merged land lookup (province + foreign-homeland
                                             // cells); absent key = sea. Built by buildGrid; ensureWarGrid
                                             // backfills it onto an in-progress pre-Phase-27 war. Powers
                                             // isWaterAt (transport state, naval land-refusal).
  },
  cells: { "cx,cy": { o:'att', p:1, pid: provId } }, // SPARSE — only attacker-held/contested cells; absent key = defender-held (if it's land at all)
  units: [ { id, side:'att'|'def', name, kind, pos:[x,y], dest:[x,y]|null,
             strength, maxStrength, org, speed, atk, state, objectiveId, garrison? } ],
  objectives: [ { id, kind, ref, pos:[x,y], priority, status, holdTicks } ],
  ai: { phase, lastPlanTick, notes:[{t,text}], attackerStartStrength, consolidateFrac, collapseFrac }, // GM-only — stripped by filterState
  events: [ { t, kind:'battle'|'capture'|'landing'|'milestone', pos, text } ], // cap 60, for client animation
  stats: { attLosses, defLosses, provinceControl: { provId: 0..100 }, citiesHeld: [cityIds] },
  bombs: { att: { cooldownUntil: <epoch ms> }, def: { cooldownUntil: <epoch ms> } }, // {att,def} shape kept for compatibility, but only `def` is ever used — bombs are DEFENDER-ONLY
  airstrikes: [ { id, side, pos:[x,y], from:[x,y], orderedTick, strikeTick,
                  orderedAt: <epoch ms>, done, groundApplied } ], // additive/absent-safe — see "Airstrikes" below
  supplyAnchor: [x,y],                       // attacker supply source, minted once at startWar (landing objective pos, or the
                                             // staging centre for land:true) — additive/absent-safe, see "Supply corridors" below
  craters: [ { pos:[x,y], t: <epoch ms>, side } ],  // cap 40, client scorch marks
  mods: { dmg: 1, bombDmg: 1, hp: 1 },       // GM global tuning multipliers — additive/absent-safe, see "GM global tuning" below
  allies: { att: [entityId, …], def: [entityId, …] }, // foreign entities that joined via joinWar — additive/absent-safe, see "Foreign intervention" below
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
top-level `mods` field above. Phase 20 adds `attackId` (the enemy unit id a
unit is chasing under an explicit attack order — see "Explicit attack orders"
below) and `supplied` (recomputed every tick by `stepSupply`; `false` means
the unit is cut off from its side's supply corridor — see "Supply corridors &
resupply" below; absent on pre-Phase-20 docs, which every reader treats as
supplied). Phase 27 adds `_preTransportState` (the state a land unit was in
before drifting over water — see "Transport state" below).

Unit `kind` is free-form scenario data (`marine`, `infantry`, `armored`,
`reserve` for the attacker; defenders spawn as `garrison`, plus `armored`/
`warship` units deployed from the national arsenal — see "Tank & warship
arsenal deployment" below). Phase 27 adds the naval-only kinds `boat` and
`warship` (see "Naval kinds" below). Unit `state` is one of `embarked`
(attacker only, still at sea), `moving`, `fighting`, `holding`, `routed`,
plus `transport` (Phase 27 — a land unit currently over water).

A unit gets `spawned: true` when it was created outside `startWar`'s scenario
roster — GM `spawnUnits` or `joinWar` reinforcements (see "GM unit spawner"
and "Foreign intervention" below) — purely for provenance; the engine treats
it identically to any scenario unit. A `joinWar` unit additionally carries
`nationId` (the joining entity's id, for the client's ally tint/tooltip) and
is named `"<Nation> Expeditionary <roman numeral>"`.

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
   Naval kinds refuse land steps (see "Naval kinds" below).
3. **Transport-state transitions** (`stepTransportState`, Phase 27) — land
   units over water flip to `state:'transport'`, and back on landfall — see
   "Transport state" below.
4. **Combat** (`stepCombat`) — opposing units within `COMBAT_RANGE` (40px —
   exactly the 40-world-unit symbol width, so units fight when their symbols
   touch) fight every tick: Lanchester-ish loss = `K_COMBAT × enemyStrength ×
   (0.7 + 0.6×rand()) × atk`. Garrisons (defenders sitting on a city/military
   property) get a 1.35× defend bonus and drain organisation more slowly. Org
   drops below 25 → rout; strength ≤ 0 → destroyed (killUnit, with a `battle`
   event). Warships are excluded from this pass entirely; it ends with the
   warship ranged pass (`stepWarshipFire` — see "Naval kinds" below).
   Transport-state units and beached boats can be hit here but deal no
   damage (`canFight`).
5. **Airstrikes** (`stepAirstrikes`) — any `war.airstrikes` entry with
   `!done && war.tick >= strikeTick` detonates: every live unit within
   `BOMB_RADIUS` takes falloff damage (same shape as the old instant bomb),
   a crater and a `battle` event are pushed, and the strike is flipped
   `done: true` — see "Airstrikes" below for the full order→impact design.
   Processed in array order for determinism; resolved strikes older than
   `AIRSTRIKE_PRUNE_TICKS` (30) are dropped from the array afterward.
6. **Territory fracture** (`stepTerritory`) — every non-embarked, living unit
   projects control ~1.5 cells out; attacker cells whose CENTRE falls inside
   a province polygon (`geometry.provinceAt`) are marked captured, defender
   units in range recapture (delete the cell). Sea cells are never
   capturable (no province contains them).
7. **`recomputeProvinceControl`** — captured-cell count ÷ that province's
   total land-cell count, per province, from the sparse `cells` map (cheap:
   proportional to cells actually captured, not the whole grid).
8. **Supply** (`stepSupply`) — flood-fills each side's supply corridor and
   stamps `u.supplied` on every live unit; supplied units out of combat heal
   `SUPPLY_HEAL_FRAC` (0.4%) of `maxStrength` per tick — see "Supply
   corridors & resupply" below.
9. **Objectives/milestones** (`stepObjectives`) — a `seize_city`/
   `seize_capital` objective completes once an attacker unit has held within
   60px of the city for `CAPTURE_HOLD_TICKS` (3) consecutive ticks with no
   defender unit in range; a `control_province` objective completes once its
   privince crosses `CITY_CONTROL_PCT` (65%). Each completion logs a
   `store.log('event', …)` entry and publishes a news article via
   `sim.draftNews` (the same mechanism `sim.js`'s `news` effect uses).
10. **`checkVictory`** — all objectives done → attacker wins, war ends.
    (Defender victory is decided inside the AI step below, since it hinges on
    the attacker's total strength, not an objective.)

After each REAL (authoritative) tick, `server/war.js`'s `warTick`/
`maybeWarTick` also run the authority-only layer: `resupplyUnits`,
`applyDevastation`, and (Phase 27) `applyOccupationTransfers` — see
"Occupation property transfers" below.

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
  (a cold start simply rebuilds it) and needs no dirty flag: an airstrike
  cutting a road changes the fingerprint, invalidating it on the next path
  computation.
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
time-to-kill ~10×. `BOMB_UNIT_DMG` stays 90, so an airstrike now wounds units
rather than annihilating them (intended). Org/rout thresholds are unchanged —
fights resolve by routing more often than annihilation. These numbers apply
to **new** wars only: an in-progress war keeps the strengths it started with
(no migration of a live `war.units` array).

### Morale collapse — garrisons rout too (Phase 20)

`org` is the morale stat (0–100; the client renders it as a bar above HP).
Field units still rout below `ROUT_ORG` (25). Garrisons used to be exempt
entirely (dug in = infinitely stubborn); now a garrison routs once its
morale FULLY collapses — `GARRISON_ROUT_ORG` (5) — so it holds far past a
field unit's breaking point but is not unbreakable. Routed DEFENDERS also
now retreat, recover org and rally exactly like routed attackers always
have (mirrored branch at the top of `stepMovement`'s defender arm; a speed-0
garrison scatters at `DEF_MOVE_SPEED × 0.8`): without it, a morale-broken
garrison would stand frozen in the line, still soaking and dealing damage,
and never regain organisation (the attacker-only org regen in `stepCombat`
never covered defenders).

## Explicit attack orders — chase a unit, not a point (Phase 20)

The third order shape accepted by `applyOrders` (and `POST /api/war/command`):
`{ unitId, attackId: <enemy unit id> }`. Precedence when several are present:
`path > attackId > dest` (in practice an order carries exactly one).

- **Validation** (engine-side, the route only pre-filters
  `typeof attackId === 'string'`): the target must exist, be `isLive`, and
  sit on the OPPOSITE side; an invalid target drops the order silently, the
  same as every other malformed-order case.
- On accept: `clearDest(u)`, `u.attackId = target.id`, state `'moving'`
  (unless routed), plus the usual `orderedBy:'player'`/`playerHoldUntil`
  bookkeeping (a defender with no speed gets `DEF_MOVE_SPEED`, same as a
  move order).
- **`stepChase`** runs in `stepMovement` before normal dest handling for
  both sides: target gone/dead → `attackId` cleared, unit holds; any live
  enemy within `COLLIDE_ENEMY` → `'fighting'` (the SAME collision rule as
  normal movement, so a chase can't walk through a different enemy standing
  in the way); otherwise advance straight toward the target's CURRENT
  position at base speed. Routed units ignore their attack order until they
  rally (the order survives on the unit).
- **Accepted rough edge:** the chase is a straight line — no per-tick
  Dijkstra re-plan toward a moving target (a full path recompute per chasing
  unit per tick would swamp the tick budget; same spirit as the
  computed-once transport routes above).
- `setDest`/`setManualPath`/`clearDest` all clear `attackId` — any plain
  move or drawn path cancels the chase, including the AI reassigning an
  attacker unit once its player-hold expires.
- **Client**: right-clicking an ENEMY soldier with a selection issues attack
  orders for the whole selection (`_hitEnemyAt` hit-tests at the marker's
  fixed-world radius, so "did I click the soldier" agrees with what's drawn).
  Chasing units draw a red dashed arrow to their target; the target gets a
  pulsing red ring. Applied optimistically ONCE, deliberately NOT via the
  order outbox: the outbox's "confirmed?" check compares `o.dest`, but a
  chase has no stable point to compare — worst case is one tick of visual
  lag, not a stuck order.

## Supply corridors & resupply (Phase 20)

Units connected to their side's supply source through friendly territory
slowly heal; cut-off units don't (no extra damage — being unable to heal is
the punishment). All engine-side (`stepSupply`), so client prediction tracks
it tick-for-tick.

- **Attacker corridor**: `war.supplyAnchor` is minted once at `startWar` —
  the landing objective's pos for a naval scenario, the staging-box centre
  for a `land: true` one. Each tick, the anchor's own cell plus att-held
  cells within 2 cells (Chebyshev) of it seed an 8-neighbour BFS over
  attacker-held ground; an attacker unit is in supply iff its cell (or any
  8-neighbour — see below) is in the reached set. "Attacker-held" for supply
  (Phase 26 fix) means captured cells in `war.cells` PLUS the attacker's own
  homeland (`grid.enemyCells`) where the defence hasn't captured — a
  land-border invasion anchors in the homeland, which the old
  war.cells-only predicate could never seed or traverse, so the whole force
  read permanently CUT OFF. Captured ground that got pinched off from the
  corridor by a defender recapture is out of supply even though it's still
  att-held.
- **Defender corridor**: defender-controlled land = every land cell (from
  `grid.provinceCells`) NOT currently att-held, PLUS enemy-homeland cells
  the defence has captured (`{o:'def'}` — an invading defender column stays
  supplied through the ground it took); BFS from the capital's cell
  (fallback: first city; no cities at all → all defenders supplied). A
  defender inside the attacker's zone or in a cut-off pocket is unsupplied.
- **Neighbour tolerance**: a unit counts as supplied when its own cell OR
  any 8-neighbour is in the reached set — a unit at the coastline can stand
  on a cell whose CENTRE falls in the sea (in neither side's cell set at
  all); without the tolerance a garrison in a harbour city could read
  permanently cut off.
- **Healing**: a supplied, live, non-embarked unit not currently `fighting`
  heals `SUPPLY_HEAL_FRAC` (0.004) × `maxStrength` per tick, capped at
  `maxStrength`. Embarked units always read supplied (the fleet feeds them).
- **Determinism**: fixed neighbour-offset order, array-based queue, seeds
  built by iterating `war.cells` (insertion-ordered, part of state — the
  same guarantee `stepTerritory` already leans on).
- **Legacy docs**: no `supplyAnchor` and no landing objective → every
  attacker unit reads supplied (the corridor can't be anchored); `supplied`
  is additive — no migration needed.
- **Client**: cut-off units get a dashed amber outline, a "⚠" corner glyph,
  a "CUT OFF" line in the tooltip and the unit info card.

## Naval kinds — boats & warships (Phase 27)

Two new unit kinds, gathered in the engine's `NAVAL_KINDS` set:

- **`boat`** (UNIT_DEFAULTS: strength 900, speed 6.5, atk 0.8) — light, fast,
  fights in the normal 40px collision pass, but ONLY while afloat: a beached
  boat cannot deal damage (`canFight`), though it can still be hit.
- **`warship`** (UNIT_DEFAULTS: strength 3600, speed 5.0, atk 1.6) — never
  appears in the collision pass at all (both `stepCombat` rosters filter
  `kind !== 'warship'`). It fights exclusively via **`stepWarshipFire`**, a
  separate ranged pass run at the end of `stepCombat`: each live,
  non-embarked warship engages the nearest live enemy (naval OR land, either
  side) within `WARSHIP_RANGE` (180px — far beyond the 40px collision range),
  dealing the usual Lanchester-ish damage one-directionally (the target
  doesn't automatically shoot back here; it gets its own turn in this same
  pass or the collision pass if it qualifies). Against a `'transport'`-state
  unit or a `boat` the damage is multiplied by `WARSHIP_TRANSPORT_BONUS` (3×)
  — warships hunt transports. Targets drain org at half the normal combat
  rate (garrisons rout at `GARRISON_ROUT_ORG` as usual); a beached boat not
  in transport state isn't a valid naval target. UNIT_DEFAULTS are every
  warship squadron's BASE stats; the hulls the squadron carries as kit
  multiply them (see "Tank & warship arsenal deployment" below). Land units
  never chase a warship — the AI's total-war hunt skips warship targets for
  land kinds and `stepChase` drops any land-on-warship attack order (a
  transport swimming into WARSHIP_RANGE fire is suicide).

**Movement**: naval kinds route and step over WATER ONLY, against the EXACT
drawn borders (fine naval grid), on four layers:

- **Fine coastline grid** — `ensureNavalGrid(db)` rasterises a 24px grid
  straight from the authoritative border polygons (every province shape +
  every country shape — the same borders the map renders); a fine cell is
  water only if its centre and four inset corners all fall outside every
  land polygon (conservative). Module-cached by a shape fingerprint; a pure
  function of the world's polygons, so server and predicting client derive
  the identical grid independently (nothing extra is synced). Rebuilt/
  reused every `warTick`, every naval order, and at `startWar`.
  `navalWaterAt` is the fidelity-aware water test (fine grid when built,
  coarse `war.grid` as legacy fallback) the layers below share.
- **Water routing** — `setDest` for a naval kind clamps the dest to water
  (`nearestWaterPoint`, fine-grid-aware) and computes `navalPath`: A* over
  the fine grid's water cells (binary heap ordered by (f, cell index), fixed
  neighbour order, no diagonal squeeze past a land corner — deterministic,
  so a predicting client replays the identical route), then greedy
  line-of-sight string-pulling sampled every 6px at the same fidelity.
  Returns null when the trip stays in one cell or no water route exists —
  those fall back to the straight-line move below. Water paths never get the
  transport graph's 5× on-network bonus (`stepAlongPath` special-cases naval
  kinds to base speed).
- **Step refusal** — `advanceToward` refuses any step onto land at
  `navalWaterAt` fidelity and wall-follows ±45°/±90°/±135° around the
  coastline, the pattern already used for neutral borders.
- **Shove refusal** — the friendly-separation nudge never pushes an afloat
  naval unit onto land (`navalWaterAt` again; this shove is how ships used
  to get beached, after which the un-beach exception let them drive
  cross-country).
- **Un-beaching** — a naval unit that is somehow ALREADY beached (GM land
  spawn, legacy doc) steers for the NEAREST water cell instead of its ordered
  dest until it's afloat again.

`grid.landCells` (the merged land/sea mask buildGrid computes: every land
cell, Republic province or foreign homeland, in one flat set) is built with
coastal sub-sampling — four quarter-points per cell, not just the centre —
so land strips narrower than a 48px cell no longer read as phantom water
corridors (province/country CONTROL cells stay centre-based; occupation math
is unchanged). A legacy `war.grid` without `landCells` reads as "no
restriction" (permissive, same spirit as `neutralAt`); `ensureWarGrid`
backfills `landCells` onto an in-progress war.

**Client**: glyphs ⛵ (boat) and 🚢 (warship); both kinds are in the GM
spawner's kind list. A warship in `fighting` state draws a thin fading
tracer line (`.war-warship-fire`) to its target — cosmetic only, the client
re-runs the same nearest-in-range search purely for the line's endpoint.

## Transport state (Phase 27)

A LAND unit (any non-naval kind) whose position drifts over open sea — a
route that crosses a strait, a unit pushed off a captured beach — becomes
`state: 'transport'` until it's back over land (`stepTransportState`, run
between movement and combat; embarked/dead/routed units are skipped). While
in transport state the unit **cannot initiate combat or deal damage**
(`canFight` zeroes its dealt-damage term in `stepCombat`) but can still be
damaged — notably by a warship's 3× ranged bonus. Its pre-transition state
is stashed on `u._preTransportState` and restored on landfall, so it resumes
exactly what it was doing rather than snapping to a fixed state. The client
renders a transport-state unit with a ⛴ glyph (regardless of kind) and a
lighter dashed-outline box (`.war-state-transport`), and its state is never
stomped to `'fighting'` while under fire, so it keeps reading as a vessel.

## Tank & warship arsenal deployment (Phase 27)

At `startWar`, after `db.war` exists, `deployArsenalUnits` walks BOTH
belligerents' own inventories (conventionally `ent_gov` for the defender —
the same arsenals resupply already draws guns and fuel from) for items
carrying `meta.weapon.kind: 'tank'` or `'warship'` and turns them into fresh
units:

- **Tanks** — `ceil(totalTanks / tankCapacity)` `kind:'armored'` defender
  units (capped at 50% of the defender's other formations), spawned
  scattered near the capital. The tanks themselves STAY in the national
  stockpile: `resupplyUnits` loads each armoured unit best-tank-first as its
  kit, so its combat stats come from the models it actually carries.
- **Warships** — hulls form SQUADRONS by the same rule as tanks:
  `ceil(totalHulls / shipCapacity)` (`settings.war.shipCapacity`, default
  25) `kind:'warship'` units per fleet — 25 dreadnoughts = 1 squadron, 26 =
  2, 51 = 3. Hulls stay in the stockpile and load as the squadron's kit
  (best-hull-first, `shipQuality = dmg+hp+range`), so an under-filled
  squadron fights far below par and combat power scales with the hulls it
  carries. Base stats are `UNIT_DEFAULTS.warship`. The DEFENDER's fleet
  spawns afloat at the harbour water nearest its principal port; the
  ATTACKER's fleet spawns with the invasion force — around the staging box
  for a sea assault, or in the harbour water nearest the staging ground for
  a land start.

Entirely defensive: a world where the tank/warship items haven't been seeded
yet deploys nothing extra — the garrisons below still stand. The items
themselves (three tank models, three warship classes) are seeded by
store.migrate — see docs/WORLD-DATA.md "Items".

## Population-scaled garrisons (Phase 27)

The defender roster is built by `buildGarrisonUnits` instead of the old flat
one-garrison-per-city/military-property rule. Same SITE set (one weighted
site per city, weight = city size; one per `type:'military'` property,
weight 2) and the same per-unit strengths (`citySizeStrength` /
`militaryPropertyStrength`, unchanged) — only the COUNT now scales with
national population: `target = round(totalPopulation / POP_PER_GARRISON)`,
clamped between the site count (a defenceless world would be game-breaking)
and 8× the site count (a wildly inflated population doesn't spawn thousands
of units). `POP_PER_GARRISON` (3,255,000) is calibrated so the 1962 baseline
seed (39,060,001 people, 12 sites) reproduces exactly the old 12-garrison
roster. Garrisons are distributed across sites by largest-remainder
(`distributeByWeight` — deterministic, sums exactly to the target), so a
busier city gets extra garrisons of the SAME strength (named "`<site>
Garrison II/III…`"), never stronger ones.

## Dynamic attacker staging (Phase 27)

`startWar` computes a fresh staging box from CURRENT map data
(`computeDynamicStaging`) — so ceded provinces, annexations and map edits
are picked up automatically — and only falls back to the scenario's static
`staging` box when the dynamic walk can't resolve. Two shapes:

- **Land scenario** (`scenario.land: true`) — the box (130px half-size)
  centres on the attacker's own homeland cell nearest the campaign's first
  objective (from `grid.countryCells`), so troops muster just inside their
  own border pointed the right way.
- **Naval scenario** — the bearing from the defender's landmass centroid
  (`defenderLandCentroid`, from `grid.provinceCells`) toward the attacker's
  homeland centroid (`countryCentroid` of its country polygon's largest
  subpath) is walked outward one grid cell at a time (`walkToOpenSea`) until
  it hits open sea — not land, and not a third nation's closed-border soil
  (`neutralCellsExcept`; computed directly since `war.allies` doesn't exist
  yet at startWar). The box (100px half-size) centres there. An OFF-MAP
  power with no homeland polygon (e.g. Qinal) can't yield a bearing — the
  scenario supplies **`scenario.bearingHint`** (`'east'|'west'|'north'|
  'south'`) as the generic escape hatch, and the walk proceeds from the
  defender's centroid along that compass side (`qinal_invasion` uses
  `'east'`, the Antacean ocean side).

The walk returning null (runs off the map, never clears land/neutral ground)
falls back to `scenario.staging` — the static boxes are now last-resort
data, not the primary mechanism.

## Neutral-territory hardening (Phase 27)

`advanceToward`'s wall-follow (Phase 22) only stops a unit already mid-step
into neutral soil; Phase 27 stops orders and routes from ever AIMING there:

- **`nearestNonNeutralPoint(war, pos)`** — the nearest non-neutral cell
  centre to `pos`, found by a deterministic ring search (radius ascending to
  60 cells; fixed dx-outer/dy-inner order so server and predicting client
  substitute the exact same point). A non-neutral `pos` returns unchanged; a
  legacy war doc with no grid/neutralCells is permissive, same as
  `neutralAt`. `setDest` clamps every dest through it, and `setManualPath`
  clamps every hand-drawn waypoint (the only gate a freehand path passes,
  since it never consults the transport graph).
- **Blocked graph nodes** — `dijkstra` takes an optional `blocked(idx)`
  predicate; `computePath` builds it per call from the war's `neutralCells`
  (`neutralNodeTest` — kept out of the cached graph because the belligerent
  set, and therefore neutralCells, can change mid-war), so road/rail routes
  never relax into a node on closed-border soil. A route whose entry or
  exit node sits ON neutral soil returns null outright — the unit falls back
  to the direct-line move and the wall-follow handles the border itself.
- **Friendly separation** — the per-tick separation nudge no longer shoves a
  friendly unit onto neutral ground (the candidate position is checked, with
  the usual "already standing in neutral soil, let it move" exception).

## Occupation property transfers (Phase 27)

AUTHORITY-ONLY, like `applyDevastation` — property ownership lives outside
`db.war`, so a predicting client never runs it. `applyOccupationTransfers`
(server/war.js) runs after every real tick, throttled to every
`OCCUPATION_CHECK_TICKS` (5) ticks since it walks every property:

- A property whose grid cell is attacker-held (`war.cells[key].o === 'att'`)
  and not already attacker-owned is transferred to the attacker through the
  deed choke point (`deeds.transfer` — the same single path every other
  ownership change uses, so the deed item mirror stays consistent). The
  original owner is stashed first in `prop.vars._preWarOwnerId` (only if not
  already stashed, so a mid-war chain of recaptures remembers the TRUE
  pre-war owner). A failed transfer (unowned/malformed deed) keeps the stash
  for a retry on a later sweep.
- A stashed property whose cell is no longer attacker-held (recaptured) is
  restored to the pre-war owner and the stash cleared.
- **Post-war**: `endWar` deletes every `_preWarOwnerId` stash WITHOUT
  touching `ownerId` — whatever the occupier holds at the ceasefire stays
  theirs permanently (a future war re-stashes fresh owners instead of
  reaching back through this one). This is the mechanism that makes "a
  company stripped of its factories by war" real — the economy side
  (zero-property overhead bleed) is documented in docs/SIMULATION.md.

Each sweep that changed anything logs one timeline entry ("Occupation
changes property ownership — N seized, M restored").

## Alliance-aware wars — auto-join (Phase 27)

Foreign powers carry an authored military profile at
`entity.meta.military = { navy, army, size, focus, alliance, allies,
importsFrom }` (seeded by store.migrate — see docs/WORLD-DATA.md). At
`startWar`, after arsenal deployment, `autoJoinAllies` walks every OTHER
`type:'foreign'` entity:

- **Allied with the attacker** (either side's `meta.military.allies` lists
  the other — `alliedWith` reads both directions so a hand-edited one-sided
  array still works) → joins the `att` side. Allied with the defender →
  `def`. An entity qualifying for both (contradictory data) joins the
  attacker — the invasion is the thing that just happened.
- **Contingent size** from the profile (`allyContingentSize`): base by
  `size` (tiny 1 … big 4) plus an `army` bonus (weak 0, medium +1, strong
  +2), clamped to joinWar's own min/max. `army: 'none'` (e.g. Iceland)
  contributes ZERO units — joinWar is skipped and a flavour milestone is
  pushed instead ("allied but has no forces to commit"). A joining entity
  with no profile at all falls back to `JOIN_DEFAULT_COUNT`.
- The join itself reuses the existing `joinWar` pathway wholesale — homeland
  muster, `war.allies` bookkeeping, "`<NATION> ENTERS THE WAR`" news — so an
  auto-join reads exactly like a manually-triggered intervention.
- **Scenario overrides**: `scenario.allies: false` disables auto-join
  entirely (default on); `scenario.coAttackers: [entityId, …]` force-joins
  specific entities on the attacker's side regardless of their profile
  (hand-authored joint invasions).

The client's War Room header lists allied belligerents per side ("Also
attacking: … · Also defending: …") whether they auto-joined or intervened
mid-war — both land in `war.allies` the same way.

## GM global tuning (Phase 19) — `war.mods`

Three GM-adjustable multipliers, additive/absent-safe (`war.mods` may be
missing entirely on a legacy war doc — every read is defensive, e.g.
`(war.mods && war.mods.dmg) || 1`):

- **`dmg`** — multiplies both `dmgToDef`/`dmgToAtt` in `stepCombat` (the
  engine, so client prediction picks it up too).
- **`bombDmg`** — multiplies `BOMB_UNIT_DMG` falloff damage in the engine's
  `stepAirstrikes` (moved there from `dropBomb` with the two-phase airstrike
  rework — see "Airstrikes" below — so client prediction picks it up too,
  same as `dmg` above).
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

## GM unit spawner

The GM can deploy fresh units mid-war for either side, with adjustable stats
— `server/war.js`'s `spawnUnits(db, { side, pos, kind, name, count, strength,
atk, speed }, actor)`:

- Validates the war is active, `side` is `att`/`def`, `pos` is finite and
  inside the war's grid (`engine.worldBounds`).
- `count` clamps 1–12; `strength` 50–20000; `atk` 0.2–10; `speed` 0–12 — any
  stat the GM leaves unset falls back to `UNIT_DEFAULTS[kind]` (kind defaults
  to `infantry` if unset/unknown, same fallback `war-scenarios.js` uses
  everywhere else).
- Spawns `count` units scattered in a small ring (`SPAWN_SCATTER_R` = 50px)
  around `pos`, state `'holding'` (idle until ordered — an attacker spawn
  gets swept into the next AI replan as a "committed" unit exactly like a
  land-invasion spawn does; see "Land invasions" above).
- Respects `war.mods.hp`: spawned `strength`/`maxStrength` are the requested
  value × the CURRENT hp multiplier, so a spawn on a GM-buffed war stays
  consistent with the rest of the roster.
- Marks every spawned unit `spawned: true`; a `kind: 'garrison'` defender
  spawn also gets `garrison: true` so it picks up the static-defence combat
  bonus like any other garrison. Pushes a `'milestone'` war event and a
  `store.log('gm', …)` entry (no news wire — this is a GM tool, not an
  in-fiction event).

**UI** (`public/js/war.js`'s `renderSpawner`, War Room GM section): side
toggle, kind select (`infantry`/`armored`/`marine`/`garrison`), and
count/HP/damage/speed sliders (`Forms.sliderNum`) bound to
`War._spawnDraft`. "Arm placement" sets `War._spawnArmed = true`; the next
war-layer left-click calls `_doSpawn(pos)` (POSTs `/api/gm/war/spawn`) and
disarms — mirrors the airstrike-arming flow exactly (`onMapPointerDown`
checks `_spawnArmed` the same way it checks `_bombArmed`, before the click
can hit a unit marker underneath it), including an Esc handler and a floating
war-toolbar chip (`🪖 Spawn armed (Att/Def) — click target`) so the armed
state is visible while looking at the map, not just the panel it was armed
from.

## Foreign intervention

A GM can bring an existing `type:'foreign'` entity into an ongoing war on
either side — `server/war.js`'s `joinWar(db, { entityId, side, count? },
actor)`. Since Phase 27 the same pathway is also driven automatically at
`startWar` by alliance auto-join (see "Alliance-aware wars" above):

- Validates the war is active, `side` is `att`/`def`, `entityId` resolves to
  a `foreign` entity that isn't already the attacker/defender or a prior
  `war.allies[att|def]` entry.
- Spawns a contingent (`count` clamped 1–10, default 4) of `infantry`-stat
  units (garrison-kind and immobile for the defence) at a sensible entry
  point: for `att`, near any existing live attacker unit (the closest thing
  to "the original staging area" once `startWar`'s staging box itself isn't
  kept on the war doc); for `def`, near the capital (or any city if none is
  marked capital). Units are named `"<Nation> Expeditionary <roman
  numeral>"` and carry `nationId` (the joining entity's id) for flavour —
  the client tints their marker outline gold (`.war-unit-ally`) and appends
  `"· <Nation> contingent"` to the unit tooltip.
- Records the join in `war.allies = { att: [entityId, …], def: [entityId,
  …] }` (additive, defaults to `{att:[], def:[]}` at `startWar`), pushes a
  `'milestone'` war event, `store.log`s a timeline entry, and publishes a
  news article via `sim.draftNews` ("`<NATION> ENTERS THE WAR`" / "*has
  entered the conflict on the side of \<attacker/defender name\>*") — the
  same mechanism war milestones already use.

**UI** (`public/js/war.js`'s `renderIntervention`, War Room GM section): a
nation select (every `foreign` entity not already the attacker, defender, or
a listed ally — hidden entirely once none remain), a side toggle, and a Join
button that POSTs `/api/gm/war/join`.

## AI grand strategy — attacker only

Defenders have no AI: garrisons spawn static at cities and `type:'military'`
properties (population-scaled since Phase 27 — see above), and the arsenal's
armoured/warship units spawn `'holding'` — none of them move until a player
orders them. Only the attacker plans.

Every `AI_INTERVAL` ticks, `runAI`:

- Computes attacker total strength. Below `collapseFrac` × starting strength
  → the invasion is REPELLED: the war does NOT end — it turns `totalWar`
  (one-shot) and the remnants fight to the last. The defender's win now
  comes from checkVictory's annihilation path (no live attacker units).
- `totalWar` set (by the repel above, all objectives done, or an objective
  becoming unreachable) → phase `total`, outranking everything else — a
  total-phase force never consolidates, it hunts. Land units only hunt LAND
  targets (never enemy warships — see stepChase's matching refusal); if only
  enemy hulls remain afloat, the ground forces sweep territory instead.
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
  land: true,                              // OPTIONAL — see "Land invasions" below; omit/false for the default naval-embark flow
  staging: { x0, y0, x1, y1 },              // FALLBACK sea box (or, when land:true, a land box in the attacker's
                                            // own territory) — since Phase 27 the primary staging box is computed
                                            // dynamically from map data (see "Dynamic attacker staging" above);
                                            // this static box is only used when that walk fails
  bearingHint: 'east',                      // OPTIONAL (Phase 27) — compass side ('east'|'west'|'north'|'south')
                                            // for an OFF-MAP attacker with no homeland polygon to derive a
                                            // staging bearing from (see qinal_invasion)
  allies: false,                            // OPTIONAL (Phase 27) — opt this scenario out of alliance auto-join
  coAttackers: [entityId, …],               // OPTIONAL (Phase 27) — force-join these entities on the attacker's side
  objectives: [ { kind, ref?, priority } ], // ref is a city/province id. 'seize_capital' may omit ref —
                                            // war.js resolves whichever city has isCapital:true, so the
                                            // scenario never has to name the capital twice. A land:true
                                            // scenario simply omits any 'landing' objective (see below).
  units: [ { name, kind } ],                // kind indexes UNIT_DEFAULTS for strength/speed/atk unless overridden per-unit
  defense: { citySizeStrength: {1,2,3}, militaryPropertyStrength }, // per-garrison strengths; the garrison COUNT
                                            // is population-scaled since Phase 27 (see "Population-scaled
                                            // garrisons" above) — still no ids named here
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

Six more scenarios ship alongside it:

- **`delcasia_invasion`** ("The Kordi Incursion") — Del' Casia (`for_delcasia`,
  the southern land-border neighbour) crosses the frontier south of Kordi
  province: `land: true`, staged in Del' Casia's own territory just past the
  road_fork_delcasia/road_delcasia_interior border crossing
  (`server/mapdata.js`), objectives take Surat (`city_surat`) then hold 65%
  of Kordi province. A smaller, land-only campaign — 7 units, no sea transit.
- **`qinal_invasion`** ("The Kradon Landings") — the People's Republic of
  Qinal (`for_qinal`, a distant hostile power with no shared border) runs the
  standard embarked/landing flow like Valksland and drives inland through
  Grazi province (`city_kradon` → `city_kradesh` → control `prov_grazi`)
  instead of toward the capital. Qinal has no map homeland polygon, so it's
  the scenario that carries `bearingHint: 'east'` (see "Dynamic attacker
  staging" above); its old static staging box in the strait north of Port
  Kradon is now the last-resort fallback.
- **`madrosia_invasion`** ("The Mezdov Landings") — Madrosia
  (`for_madrosia`) lands a 12-unit amphibious force on Mezdov province's
  western seaboard (staging box verified open sea against the
  map-geometry polygons): land at `city_mezdov` → seize it → control
  `prov_mezdov`.
- **`solme_invasion`** ("The Solme Border Raid") — Solme (`for_solme`, the
  south-western land neighbour), `land: true`, a fast 5-unit raid across the
  Kordi frontier: seize `city_surat` → control `prov_kordi`. Tighter tuning
  (`consolidateFrac` 0.30 / `collapseFrac` 0.10) so it folds quickly once
  its momentum breaks.
- **`mazon_invasion`** ("The Port Kradon Offensive") — Mazon (`for_mazon`,
  the island state off the north-west) stages in the open water west of
  Port Kradon and works through Grazi: land at `city_kradon` → seize it →
  seize `city_kradesh` → control `prov_grazi`.
- **`aldonesia_invasion`** ("The Aldonesian Offensive") — Aldonesia
  (`for_aldonesia`) is an ARCHIPELAGO with no land border, so despite being
  a neighbour this is a NAVAL scenario (a `land: true` version would march
  units across the Strait of Casa): stage in verified open sea south-west
  of Mezdov, land at `city_mezdov` (the coastline reaches within ~100px of
  the city), seize it, then drive east to `city_surat` and control
  `prov_kordi`.

### Land invasions (`scenario.land: true`)

A land scenario spawns its attacker units already on solid ground instead of
`embarked` at sea: `startWar` sets their initial `state` to `'moving'`
instead of `'embarked'`, and the scenario's `objectives` list simply contains
no `kind: 'landing'` entry (there is nothing to resolve — `startWar` only
ever creates the objectives a scenario lists). No engine change was needed
for this: `runAI`'s `landingObj` lookup already tolerates "no landing
objective in this war" (`war.objectives.find(...)` returning `undefined`
just skips the `landing` AI phase and goes straight to `breakout`), and
`stepMovement`'s embarked-only branch only ever runs for units whose `state`
literally is `'embarked'` — a `'moving'` unit with no `dest` yet simply waits
(harmlessly) for the next `AI_INTERVAL` replan to assign one, exactly like a
unit that just finished landing. The only server/war.js change is the spawn
state itself, plus a land-flavoured start-of-war narration (log/news text
reads "forces cross the border" instead of "war fleet sighted offshore").

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
  | Right-click on an enemy soldier | **Attack order** — every selected unit chases that unit (`{unitId, attackId}` — see "Explicit attack orders" above); hit-tested at the marker's fixed-world radius before falling back to a plain move |
  | Right-drag | **Custom path** — draws a freehand polyline for the current selection to follow at base speed, ignoring road/rail routing (see "Manual paths") |
  | Ctrl+left-drag | Formation — distributes the selection along the drawn line, nearest-in-order (the gesture right-drag used to trigger) |
  | Left-click on an own live soldier | Select it (replaces the selection) — per-marker listeners; dead units aren't clickable |
  | Left-click on an ENEMY live soldier | Inspect it — opens the unit info card (`War._inspect`; no effect on the command selection). Crosshair cursor while a friendly selection exists doubles as the attack affordance |
  | Shift+left-click on a soldier | Add/toggle it in the selection |
  | Shift+left-drag on ground | Box-select all live units of the commandable side inside the marquee |
  | Plain left-click on ground | Deselect (the dossier handlers stand down on the war layer, so the click reaches the svg-level handler) |
  | Plain left-drag | Pan — exactly the base map, War never consumes it |
  | Esc | Clear selection + disarm the airstrike (window-level, bound once) |
  | Airstrike armed + left-click | Orders an airstrike on the click point (defender only — see below), then disarms |

  A right-button drag under ~12 world px is still treated as a plain click
  (move order); at or above that it samples pointer positions into a
  polyline (points kept ≥25px apart) with a live dashed preview, and on
  release with ≥2 points issues a path order for every selected unit.
- **Command routes**:
  - `POST /api/war/command { side?, orders:[{unitId,dest:[x,y]}]|[{unitId,path:[[x,y],…]}]|[{unitId,attackId}] }`
    — any logged-in operator; validates `orders` (array, cap 64; each `dest`
    a finite `[x,y]` inside the 3840×2160 grid, each `path` an array of
    2-200 such points, or each `attackId` a string — the engine re-validates
    the target itself), then `war.commandUnits` → `engine.applyOrders`. An
    order carries `dest` (plain move, road/rail routing applies), `path`
    (freehand — see "Manual paths"), or `attackId` (chase — see "Explicit
    attack orders"); precedence `path > attackId > dest` if several are
    present.
  - `POST /api/war/bomb { side?, pos:[x,y] }` — same auth/side rule;
    `war.dropBomb`; ORDERS an airstrike (see "Airstrikes" below) and returns
    `{ ok, cooldownUntil, strike }` — `strike` is the created
    `war.airstrikes` entry, used by the client for optimistic prediction.
  Both routes `store.save()` WITHOUT `broadcast('sync')` (Phase 21): an
  order/strike only touches `db.war`, which every watcher pulls through the
  ~1s heartbeat — a per-order broadcast forced every client (war-watching or
  not) into a full /api/state refetch, the same global thrash per-tick
  broadcasts caused. The client's generic `api()` wrapper likewise skips its
  post-write refetch for `/api/war/*` paths.
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

### Airstrikes — defender-only, cinematic two-phase bombing

Only the defence has an air arm: `dropBomb` rejects any `side !== 'def'`
outright, and `/api/war/bomb` forces `side = 'def'` for everyone including
the GM (the GM `att` branch exists only on `/api/war/command`). The client
mirrors this — the airstrike button is disabled with a "The invader has no
air arm." hint while the GM is commanding the attacker. `war.bombs` keeps its
`{att,def}` shape for compatibility with existing war docs, but only `def`
is ever used now.

What used to be an instant blast is now an **order → flight → impact**
sequence split across the engine/authority boundary the same way everything
else in this file is:

- **`dropBomb(db, side, pos, actor)`** (`server/war.js`, unchanged route/name)
  — validated exactly as before (side is 'def', war active, not paused, the
  defender's cooldown expired), but instead of applying the blast it just
  ENQUEUES a strike onto `war.airstrikes`:
  `{ id, side, pos:[x,y], from:[x,y], orderedTick: war.tick,
  strikeTick: war.tick + AIRSTRIKE_FLIGHT_TICKS, orderedAt: <epoch ms>,
  done: false, groundApplied: false }`. `AIRSTRIKE_FLIGHT_TICKS` is 4 — at
  the default 2000ms `tickMs` that's an ~8s flight at 1× speed, inside the
  ~6–10s cinematic window. `from` is the launch point: the seed's
  `kind:'airport'` property (`prop_airport`, "Lachevan International
  Airport") at its CURRENT position, falling back to the capital city, then
  to a fixed map-edge point — the airport can itself be bombed to rubble
  mid-war, so the fallback chain is a real case, not defensive padding.
  The `BOMB_COOLDOWN_MS` (12s) cooldown still starts at ORDER time, same as
  before — a player can't spam strikes just because the last one hasn't
  landed. Returns `{ ok: true, strike }`; `POST /api/war/bomb` includes
  `strike` in its response so the client can predict it immediately (see
  "Client-side prediction" below).
- **`stepAirstrikes`** (`server/war-engine.js`, shared byte-for-byte with the
  browser copy) — part of the tick pipeline (see above): once
  `war.tick >= strike.strikeTick`, applies the DETERMINISTIC blast (moved
  here from the old `dropBomb` so a predicting client resolves it on the
  same tick as the server): every live unit within `BOMB_RADIUS` (95px, now
  an engine constant) takes falloff damage up to `BOMB_UNIT_DMG` (90) ×
  `war.mods.bombDmg`, a corpse is made via the usual `killUnit` path, a
  crater is pushed to `war.craters`, a `'battle'` war event fires, and
  `strike.done = true`. Strikes are processed in array order (determinism);
  resolved strikes older than `AIRSTRIKE_PRUNE_TICKS` (30) are dropped
  afterward so the array doesn't grow across a long war.
- **`ctx.onAirstrike(war, strike)`** — the moment a strike flips
  `done: true`, the engine calls this hook for everything it must NOT do
  itself (a predicting client must never mutate `db.properties` or
  `settings.map.roads`): destroying properties in the blast radius (then
  `deeds.syncAllDeeds(db)` **once**, the same choke point the old instant
  bomb used), cutting roads (identical split-the-polyline logic as before),
  and the audit-log entries for both. `server/war.js`'s
  `applyAirstrikeGroundEffects(db, war, strike)` implements it, bound into
  the server's `ctxFor(db)` (closing over `db` per tick call — the only
  hook that needs it; `log`/`news` don't). It's idempotent via
  `strike.groundApplied` even though the engine only ever calls it once per
  strike. A predicting client's ctx simply omits `onAirstrike` and the
  engine's `normCtx` defaults it to a no-op — exactly the log/news pattern.

`war.airstrikes` is additive/absent-safe: the engine treats a missing array
as `[]`, no migration was needed.

### Client — plane, fireball, shockwave (all cosmetic)

Everything from here down is client-only dressing in `public/js/war.js`
around the moment `stepAirstrikes` has already decided — none of it feeds
back into gameplay, so it's safe to render slightly differently on different
clients:

- **Plane** — a small swept-wing SVG silhouette (`.war-plane`, tinted
  defender navy), one per in-flight `war.airstrikes` entry. Its position is
  a pure function of `(strike, "now")`, not a snapshot-to-snapshot tween: a
  three-leg flight (climb-out from `from` to a turn-in point
  `AIRSTRIKE_FAR_OFFSET` px away from the target, an attack run from there
  through `pos` timed to arrive exactly at `strikeTick`, then egress back
  toward `from` fading over `AIRSTRIKE_EGRESS_TICKS`) computed from the
  predicted war's `tick`/`_lastTick`/`tickMs`/`speed` every rAF frame
  (`War._planeState`). Because it's derived fresh each frame instead of
  tweened between renders, it survives the war-layer's every-render DOM
  rebuild for free.
- **Impact FX** — triggered exactly once per strike, the first render where
  `strike.done` reads true (`War._checkAirstrikeLandings`, keyed by strike
  id so it's idempotent across rebases). Modelled frame-by-frame on
  neal.fun's Asteroid Launcher impact (from a 24fps reference capture) —
  soft light only, no debris lines, no turbulence displacement
  (`renderExplosions`/`_updateExplosion`, `EXPLOSION_LIFE_MS` 2900ms, all
  at the impact point):
  1. a huge soft warm-white **bloom** (pure radial-gradient falloff, no
     hard edges) washing over ~3× `BOMB_RADIUS` within ~450ms, holding to
     ~650ms, bled away by ~1600ms — plus a flattened horizontal **lens
     streak** (an ellipse reusing the same gradient in objectBoundingBox
     units) for the anamorphic-flare look;
  2. a bright **core ball** swelling to ~0.55× `BOMB_RADIUS` by 250ms and
     then shrinking steadily into a small warm **ember** that lingers at
     ground zero until the very end;
  3. a **soap-bubble shockwave** detaching at ~480ms and expanding slowly
     (ease-out) to ~2.6× `BOMB_RADIUS` by ~2750ms — a wide
     `feGaussianBlur`-softened band plus a thinner bright rim, never a
     crisp stroke.
  Nodes are recreated each render (the whole war layer is torn down every
  render, same as the hatch pattern), with timing carried across rebuilds
  via `_strikeImpactAt` and per-frame animation driven by the shared rAF
  loop keyed off `Date.now()` (matching `_strikeImpactAt`'s epoch — NOT the
  rAF `performance.now()` timestamp, a different clock entirely).
  **Replay guard:** the `_strikeImpactAt` stamp is kept until the strike
  leaves `war.airstrikes` entirely (the engine prunes it
  `AIRSTRIKE_PRUNE_TICKS` after impact) — deleting it when the FX ends (the
  original code) let `_checkAirstrikeLandings` re-stamp the still-`done`
  strike on the next render, replaying the explosion every
  `EXPLOSION_LIFE_MS` until the prune caught up.
- **UI language** — the toolbar button reads "✈ Call Airstrike"; armed:
  "Airstrike armed — click the target"; while a strike is inbound, a
  separate countdown chip reads "✈ Strike inbound — Ts"; cooldown reads "Air
  wing rearming — Ts"; the attacker-side disabled state reads "✈ No air arm"
  with the same "The invader has no air arm." hint as before. Esc still
  disarms.
- **Prediction** — `War._dropBomb` inserts the strike the POST response
  returns straight into the predicted war (same optimistic-order pattern as
  `_issueMove`), so the plane and countdown start before the next heartbeat;
  the engine's `stepAirstrikes` then predicts the blast locally at
  `strikeTick` exactly like the server, and the next rebase reconciles
  anything a predicting client couldn't know (another player's strike, an
  AI replan).

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
   base tick) is ignored. Non-GM clients receive a REDACTED `war.ai`
   (numeric plan state with `notes: []` — see api.js `warForPlayers`), so
   their prediction replays the attacker's replans deterministically too;
   only the reasoning notes stay GM-only. (Before Phase 27 `ai` was stripped
   wholesale and player predictions kept units marching on stale dests —
   on slow serverless heartbeats every AI turn surfaced as a rubberband.)
2. **Optimistic orders** — `_issueMove`/`_issueFormation`/`_issuePath` apply
   orders to the predicted war immediately via `WarEngine.applyOrders` (the
   same pure function the server route uses), before the POST round-trips.
   An outbox (5s expiry) re-applies them across rebases until a server
   snapshot reflects the dest, so an in-flight order's arrow never flickers
   away — `path` orders are re-applied exactly like `dest` orders (the
   outbox entry's "confirmed?" anchor is always the order's final point:
   `path`'s last waypoint for a manual path, `dest` for a plain move).
   `War._clamp` delegates to `WarEngine.clampToWorld` (rather than a
   hand-rolled `[0,3840]x[0,2160]` bound) so an order issued near the map
   edge clamps to the SAME point client- and server-side — otherwise the
   outbox's 2px "did the server pick this up yet?" check could never read
   as confirmed near the border and would keep re-applying until its 5s
   expiry (harmless, since both sides converged on the same final position
   either way, but wasteful and could show a flickering arrow).
3. **War heartbeat** — while a war is active and the tab is visible (map
   layer OR War Room panel), the client polls `GET /api/war/state` once per
   tick interval (min 1s). The route runs `maybeWarTick` (driving the
   authoritative simulation at cadence — this is what makes the serverless
   tick loop self-sustaining) and returns just `{war, v}` (ai stripped for
   non-GM), which the client version-guards (`v` monotonic, same rule as
   core.js) and rebases onto.

**Airstrike outbox** — `_dropBomb` splices the strike `POST /api/war/bomb`
returns straight into the predicted war (see "Prediction" under Airstrikes
above), but `dropBomb` saves server-side SYNCHRONOUSLY before that response
returns, and the client ALSO polls `GET /api/war/state` on its own ~1-tick
timer independently of any order it just sent. A heartbeat request already
in flight the instant a bomb order lands can resolve with a snapshot from
just BEFORE the strike existed; adopting that snapshot naively would drop
the just-ordered strike (no plane, no countdown) for a whole heartbeat
interval, until the next poll picked it back up. `War._rebase` guards
against this with a small strike outbox (`_pred.strikeOutbox`, 8s expiry,
mirroring the order outbox): any outbox strike the incoming snapshot doesn't
know about yet (by id) is re-spliced into the rebased war BEFORE the
rollback-reconciliation fast-forward runs below, so a snapshot that needs
catching up ticks the strike through `stepAirstrikes` exactly like the
server would — it can even resolve it locally, same as the server, if the
catch-up crosses `strikeTick`. `tools/war-divergence-check.js` scripts this
exact race (a snapshot captured one tick before the order, delivered one
tick after) and reports the gap in ticks with the fix on/off.

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
making other poll-bound systems feel realtime without touching the CAS
commit model. The Day Market applies the READ-ONLY half of it (no orders to
predict, since money never gets predicted client-side — see
docs/SIMULATION.md's "Day Market client prediction"). Phase 21 generalised
the WRITE half game-wide: mutation responses carry the freshly-committed
filtered world (response-sync) and hot actions paint optimistic guesses via
core.js's `Optimistic` outbox — see docs/SYNC-ARCHITECTURE.md.

**Testing determinism/prediction** — `tools/war-divergence-check.js` (plain
`node`, no running server) ticks `server/war-engine.js` as an authoritative
"server" and a ported copy of `public/js/war.js`'s rebase/outbox logic as a
"client", replaying a scripted order/airstrike sequence including the raced
snapshot described above, and prints max position/strength divergence plus
whether an in-flight airstrike ever visibly disappears from the predicted
war. Useful as a regression check whenever `_rebase`, `_optimistic`,
`_dropBomb`, or the engine's tick pipeline changes shape.

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
- `GET /api/gm/war/scenarios` — GM-only; returns
  `{ scenarios: [{id, name, attackerId, defenderId, attackerName, defenderName}, …] }`
  for every entry in `server/war-scenarios.js`, so the War Room's Start form
  doesn't hardcode the scenario list — see "GM Studio" client note below.
- `POST /api/gm/war/spawn { side, pos:[x,y], kind?, name?, count?, strength?, atk?, speed? }`
  — GM-only; calls `war.spawnUnits` (see "GM unit spawner" below). `side`
  must be `att`/`def`, `pos` finite inside the grid, `count` clamped 1–12,
  `strength` 50–20000, `atk` 0.2–10, `speed` 0–12; any omitted stat falls
  back to `UNIT_DEFAULTS[kind]` (default kind `infantry`).
- `POST /api/gm/war/join { entityId, side, count? }` — GM-only; calls
  `war.joinWar` (see "Foreign intervention" below). `entityId` must resolve
  to a `type:'foreign'` entity that isn't already the attacker/defender or a
  prior `war.allies` entry; `count` clamps 1–10 (default 4).
- `POST /api/war/command { side?, orders:[{unitId,dest}]|[{unitId,path}] }`
  and `POST /api/war/bomb { side?, pos:[x,y] }` — **player-accessible** (any
  logged-in operator, not GM-gated); see "Interactive War layer" above for
  the authority model and validation, and "Manual paths" for the `path` order
  shape.
- `GET /api/war/state` — **player-accessible** lightweight heartbeat (Phase
  18): runs `maybeWarTick` (save + broadcast on a real tick) and returns
  `{war, v}` only, with `war.ai` redacted for non-GM exactly like
  filterState (numeric plan state ships, `notes` emptied — see
  `warForPlayers`). Clients watching an active war poll it at ~tick cadence;
  see "Client-side prediction" above.
- Heartbeat: `GET /api/state` also calls `war.maybeWarTick(db)` right after
  the existing `market.maybeDayTick(db)` call, saving + broadcasting on a
  real tick — identical wall-clock-gate pattern, so any traffic at all
  drives the war even if no one is running the dedicated heartbeat.
- `api.filterState`: `db.war` ships to every logged-in operator (so all
  players can watch the front). Since Phase 27 non-GM roles receive a
  REDACTED `war.ai` — the numeric plan state (phase, lastPlanTick,
  thresholds) with `notes: []` — because the client's predicted engine
  needs it to replay `runAI` deterministically between snapshots (see
  `warForPlayers` in api.js). The AI's REASONING (`ai.notes`) remains
  GM-only intel; players still see objectives, casualties, province control
  and the event feed.

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
  - **Airstrike planes and impact FX** — see "Client — plane, fireball,
    shockwave" above: a cosmetic plane sprite per in-flight strike, plus a
    one-shot fireball/shockwave/debris explosion the instant a strike lands.
  - **Attack arrows & target rings** — a red dashed line from every live
    unit with an `attackId` to its target, plus a pulsing red ring on the
    target (drawn for both sides — an ongoing attack is visible through
    combat itself, unlike plain movement intent).
  - **Morale bars** — a 3px steel-blue bar above each HP bar showing `org`
    (0–100); turns red below the rout threshold (25) and pulses while the
    unit is routed.
  - **Damage feedback** — `renderUnits` tracks each unit's strength between
    passes (`_lastStrength`); a drop stamps `_hitAt` and the marker plays a
    ~450ms jitter + red flash. The effect lives on an INNER `<g
    class="war-unit-inner">` wrapping the box+glyph, because the outer
    group's transform is rewritten every rAF frame by the tween loop — CSS
    animating the outer transform would fight it. Fighting units also blink
    small muzzle-flash ticks.
  - **Unit info card** — `#war-unit-card`, top-right of the map, shown while
    exactly one own unit is selected or an enemy unit is inspected
    (`War._inspect`): name, kind, side (+ ally contingent), HP and morale
    with mini bars, state, speed/atk, garrison tag and supply status.
    Re-rendered with the toolbar's 1s timer, reading the unit fresh from the
    predicted war so a unit that dies degrades to a "destroyed" note.
  - **War toolbar** — a small floating control surface, present only while
    `W.layer === 'war'`: the gesture hint line, an arm/cooldown "✈ Call
    Airstrike" button (plus a "✈ Strike inbound — Ts" countdown chip while
    one is in flight), Clear selection, and (GM-only) a Defender/Attacker
    command-side toggle. Offset above the GM command bar's footprint when
    it's visible (`body:has(.gm-bar:not(.hidden)) .war-toolbar`, mirroring
    the same `:has()` pattern `#toast-root` already used for the same bar)
    so the toolbar and the bar's Quick Actions dropdown never overlap.
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
  global tuning sliders, the unit spawner and foreign-intervention controls
  (see "GM unit spawner" and "Foreign intervention" above), and the scenario
  picker shown when no war is running or the last one has concluded — the
  picker's option list is fetched from `GET /api/gm/war/scenarios`
  (`War._ensureScenarioList`, cached after the first fetch) rather than
  hardcoded, so a new `server/war-scenarios.js` entry appears automatically;
  a small hardcoded fallback (`WAR_SCENARIOS_FALLBACK`) covers the one render
  before the fetch resolves.

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
- Airstrike blast radius and combat range are both simple circle checks,
  matching the rest of the engine's coarse-by-design approach (see
  docs/CONVENTIONS.md) — no line-of-sight, no terrain occlusion.
- Corpses are pruned by age (`CORPSE_MAX_AGE_TICKS`), not by count; an
  unusually long, static war could still accumulate a few hundred stale
  corpse entries before the age cutoff catches up.
- A transport-graph route computed before an airstrike cuts the road it runs
  on isn't re-planned (same rough edge as any other mid-traversal road cut,
  see above) — a unit already following the old path finishes it at
  on-network speed regardless of when the cut landed.
