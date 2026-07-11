'use strict';
// Realtime battlefield RTS. Generic engine — no Arcasia/Valksland names here
// (world specifics live in server/war-scenarios.js), same split as sim.js vs
// seed.js. State lives entirely at `db.war` (absent/null = no war running),
// so this module holds no module-level mutable state and works serverless —
// see maybeWarTick(), which is the wall-clock-gated heartbeat ridden by
// GET /api/state exactly like market.maybeDayTick.
//
// ---------------------------------------------------------------------------
// STATE SHAPE (db.war) — see docs/WAR.md for the full write-up.
//   active, paused, speed (1/2/4/8), tickMs, _lastTick, tick, startedAt
//   scenarioId, name, attackerId, defenderId
//   grid: { cell, cols, rows, provinceLandCells: {provId:count}, totalLandCells }
//   cells: { "cx,cy": { o:'att', p:1, pid: provId } }  — SPARSE; absent = defender-held
//   units: [{ id, side, name, kind, pos:[x,y], dest:[x,y]|null, strength,
//             maxStrength, org, speed, atk, state, objectiveId, garrison?,
//             dead?, deadAt?, orderedBy?:'player', playerHoldUntil?,
//             path?:[[x,y],…], pathIdx? }]  — path/pathIdx are set whenever
//             dest is (see setDest()); network-node waypoints for the
//             transport-graph route, followed at ROAD_SPEED_MULT until the
//             last one, then a normal-speed leg to dest.
//   objectives: [{ id, kind, ref, pos:[x,y], priority, status, holdTicks }]
//   ai: { phase, lastPlanTick, notes:[…] }   — GM-only (stripped in filterState)
//   events: [{ t, kind, pos, text }]         — capped 60, for client animation
//   stats: { attLosses, defLosses, provinceControl:{provId:0..100}, citiesHeld:[] }
//   bombs: { att:{cooldownUntil}, def:{cooldownUntil} }
//   craters: [{ pos:[x,y], t: epochMs, side }]  — capped 40, for client scorch marks
//   result: null | { winner:'att'|'def', endedAt, reason }
//
// Unit `dead` units are KEPT in war.units as corpses (never spliced) so the
// front line's history is visible; they are excluded from everything via the
// isLive() helper. `orderedBy`/`playerHoldUntil` mark a unit that took a
// direct player order (only meaningful for attacker units, whose default
// controller is the AI) — see commandUnits() and runAI()'s player-hold guard.
// ---------------------------------------------------------------------------
const store = require('./store');
const sim = require('./sim');
const geometry = require('./geometry');

// ---------- tunables (generic — scenario data only supplies strengths/roster) ----------
const CELL = 48;
const CONTROL_RADIUS_CELLS = 1.5;     // a unit projects control this many cells out
const COMBAT_RANGE = 40;              // px — opposing units this close fight (symbols are 40 world units wide — combat on box-touch)
const CAPTURE_RANGE = 60;             // px — how close to a city counts as "holding" it
const CAPTURE_HOLD_TICKS = 3;         // consecutive uncontested ticks to flip a city
const AI_INTERVAL = 10;               // ticks between grand-strategy replans
const K_COMBAT = 0.0035;              // per-tick strength loss ~ k × enemy strength (÷10 vs the old value — strengths are now ×10, so this is what actually stretches time-to-kill ~10×; leaving k unchanged would have left relative attrition identical)
const ORG_DRAIN = 3.5;                // per-tick org loss while fighting
const ORG_REGEN = 0.6;                // per-tick org recovery while not fighting
const ROUT_ORG = 25;                  // org threshold that triggers a rout
const RALLY_ORG = 45;                 // org a routed unit needs to rejoin the line
const ROAD_SPEED_MULT = 5;            // speed multiplier while following the road/rail transport graph
const ROAD_JUNCTION_RANGE = 50;       // px — nodes from different polylines within this range are linked (roads/rails meeting at a junction)
const CITY_CONTROL_PCT = 65;          // province-control % that satisfies control_province
const MAX_TICKS_PER_CALL = 20;        // catch-up cap, same spirit as autoTick's 30
// ---- interactive War layer tunables (Phase 16 — player-commanded defenders,
// mobile garrisons, collision/firefights, corpses, bombs) ----
const UNIT_RADIUS = 26;               // px — a unit's collider radius
const COLLIDE_ENEMY = 40;             // px — a unit will not advance within this of a live enemy; it stops and fights instead (matches the 40-unit-wide symbol/COMBAT_RANGE)
const FRIENDLY_SEP = 30;              // px — soft separation distance between live friendlies
const DEF_MOVE_SPEED = 3.2;           // px/tick granted to a garrison the first time the player orders it to move
const BOMB_RADIUS = 95;               // px — blast radius
const BOMB_UNIT_DMG = 90;             // max strength damage to a unit at the blast centre (falls off to 0 at BOMB_RADIUS)
const BOMB_COOLDOWN_MS = 12000;       // per-side cooldown between bomb drops
const PLAYER_HOLD_TICKS = 12;         // ticks a GM-ordered ATTACKER unit is exempt from AI reassignment
const CORPSE_MAX_AGE_TICKS = 400;     // corpses older than this are pruned to bound war.units growth

function isLive(u) { return !!u && u.strength > 0 && !u.dead; }

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function rand(a, b) { return a + Math.random() * (b - a); }

// ---------- news / logging (mirrors sim.js effect type 'news') ----------
function newsMilestone(headline, body) {
  sim.draftNews(headline, body, 'Foreign', true, 'Wire Service');
}

// ---------- grid / province geometry ----------
function buildGrid(db) {
  const cols = Math.ceil(3840 / CELL), rows = Math.ceil(2160 / CELL);
  const provinceLandCells = {};
  const provinceCells = {}; // provId -> [[cx,cy], …] — used to pick patrol/sweep waypoints once a control_province objective has no city left to march on
  let totalLandCells = 0;
  for (let cx = 0; cx < cols; cx++) {
    for (let cy = 0; cy < rows; cy++) {
      const centerX = (cx + 0.5) * CELL, centerY = (cy + 0.5) * CELL;
      const pid = geometry.provinceAt(db.provinces, [centerX, centerY]);
      if (!pid) continue;
      provinceLandCells[pid] = (provinceLandCells[pid] || 0) + 1;
      (provinceCells[pid] = provinceCells[pid] || []).push([cx, cy]);
      totalLandCells++;
    }
  }
  return { cell: CELL, cols, rows, provinceLandCells, provinceCells, totalLandCells };
}
// A land-cell centre inside a province — used to send committed units
// sweeping across a control_province objective once every city on the way
// has already fallen (there is otherwise nothing left to "march toward").
// Biased toward STILL-UNCAPTURED cells: a handful of random draws, keeping
// the first one not already marked 'att' in war.cells. Pure uniform random
// sampling stalls out (coupon-collector effect — once most of a province is
// captured, most random draws just re-land on ground already held), so this
// is what actually lets a control_province objective finish instead of
// crawling to a halt in the high 50s/60s percent.
function randomProvincePoint(war, provId) {
  const cells = (war.grid.provinceCells || {})[provId];
  if (!cells || !cells.length) return null;
  const cs = war.grid.cell;
  let pick = cells[Math.floor(Math.random() * cells.length)];
  for (let tries = 0; tries < 12; tries++) {
    const cand = cells[Math.floor(Math.random() * cells.length)];
    const key = cellKey(cand[0], cand[1]);
    const held = war.cells[key];
    if (!held || held.o !== 'att') { pick = cand; break; }
  }
  return [(pick[0] + 0.5) * cs, (pick[1] + 0.5) * cs];
}

function cellKey(cx, cy) { return cx + ',' + cy; }

// ---------- transport graph (roads + rails) — route-following movement ----------
// This is a PURE DERIVED CACHE built from db.settings.map.{roads,rails}: it
// holds no gameplay-authoritative state of its own (everything a client can
// observe still lives on db.war/db.settings), so it is safe under serverless
// cold starts — a fresh worker just rebuilds it on first use, same as any
// other in-process memoisation. It's keyed by a cheap content fingerprint
// (polyline count + point count + a coordinate checksum) so a bomb cutting a
// road (server/war.js's dropBomb, step 4) invalidates it the next time a path
// is computed, without needing an explicit "dirty" flag.
let _graphCache = { fingerprint: null, graph: null };

function transportFingerprint(db) {
  const map = (db.settings || {}).map || {};
  const lines = [].concat(map.roads || [], map.rails || []);
  let points = 0, coordSum = 0;
  for (const r of lines) {
    const pts = r.pts || [];
    points += pts.length;
    for (const p of pts) coordSum += p[0] + p[1];
  }
  return lines.length + ':' + points + ':' + Math.round(coordSum);
}

// nodes = every polyline point (roads + rails); edges connect consecutive
// points of the same polyline (weight = segment length / ROAD_SPEED_MULT —
// travelling the network is ROAD_SPEED_MULT times faster than the same
// distance off-network) plus edges between any two nodes from DIFFERENT
// polylines within ROAD_JUNCTION_RANGE px, so roads/rails that meet at a
// junction (per mapdata) are actually walkable across each other.
function buildTransportGraph(db) {
  const map = (db.settings || {}).map || {};
  const lines = [].concat(map.roads || [], map.rails || []);
  const nodes = [];
  const adj = [];
  function addNode(pt) { nodes.push([pt[0], pt[1]]); adj.push([]); return nodes.length - 1; }
  function addEdge(i, j, w) { adj[i].push([j, w]); adj[j].push([i, w]); }

  for (const r of lines) {
    const pts = r.pts || [];
    if (pts.length < 2) continue;
    let prevIdx = null;
    for (const p of pts) {
      const idx = addNode(p);
      if (prevIdx !== null) addEdge(prevIdx, idx, dist(nodes[prevIdx], nodes[idx]) / ROAD_SPEED_MULT);
      prevIdx = idx;
    }
  }
  // Junction links — O(n^2) over the whole node set, but the network is only
  // a few hundred nodes for the seed map, so this is cheap.
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = dist(nodes[i], nodes[j]);
      if (d > 0 && d <= ROAD_JUNCTION_RANGE) addEdge(i, j, d / ROAD_SPEED_MULT);
    }
  }
  return { nodes, adj };
}

function getTransportGraph(db) {
  const fp = transportFingerprint(db);
  if (_graphCache.fingerprint !== fp) _graphCache = { fingerprint: fp, graph: buildTransportGraph(db) };
  return _graphCache.graph;
}

function nearestNode(graph, pos) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < graph.nodes.length; i++) {
    const d = dist(graph.nodes[i], pos);
    if (d < bd) { bd = d; best = i; }
  }
  return { idx: best, dist: bd };
}

// Simple array-scan Dijkstra — fine for a few hundred nodes (no heap needed).
function dijkstra(graph, startIdx) {
  const n = graph.nodes.length;
  const distArr = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  const visited = new Array(n).fill(false);
  distArr[startIdx] = 0;
  for (let iter = 0; iter < n; iter++) {
    let u = -1, ud = Infinity;
    for (let i = 0; i < n; i++) if (!visited[i] && distArr[i] < ud) { ud = distArr[i]; u = i; }
    if (u === -1) break;
    visited[u] = true;
    for (const edge of graph.adj[u]) {
      const v = edge[0], w = edge[1];
      if (distArr[u] + w < distArr[v]) { distArr[v] = distArr[u] + w; prev[v] = u; }
    }
  }
  return { dist: distArr, prev };
}

// Returns an array of [x,y] waypoints (network nodes only, entry → exit) if
// routing beats a straight line; otherwise null (caller falls back to the
// direct line, exactly as before this feature existed). baseSpeed cancels
// out of the route-vs-direct comparison (both sides divide by it), but is
// threaded through for clarity/parity with how the caller actually moves.
// Known rough edge: this is computed once, at order time — a road destroyed
// mid-traversal (a bomb cutting it) does not reroute a unit already
// following its waypoints; it just finishes the (now-fictional) path at
// on-network speed. See docs/WAR.md.
function computePath(db, from, to, baseSpeed) {
  const graph = getTransportGraph(db);
  if (!graph || graph.nodes.length < 2) return null;
  const entry = nearestNode(graph, from);
  const exit = nearestNode(graph, to);
  if (entry.idx < 0 || exit.idx < 0 || entry.idx === exit.idx) return null;
  const { dist: distArr, prev } = dijkstra(graph, entry.idx);
  const graphDist = distArr[exit.idx];
  if (!Number.isFinite(graphDist)) return null;
  const routeDist = entry.dist + graphDist + exit.dist;
  const directDist = dist(from, to);
  if (routeDist >= directDist) return null;
  const path = [];
  let cur = exit.idx;
  while (cur !== -1) {
    path.unshift(graph.nodes[cur].slice());
    if (cur === entry.idx) break;
    cur = prev[cur];
  }
  return path;
}

// Assign a dest + (re)compute its route in one place, so every call site
// (player orders, AI target/sweep assignment, embarked-landing handoff) gets
// consistent path/pathIdx bookkeeping.
function setDest(db, u, dest, baseSpeed) {
  u.dest = dest;
  const path = computePath(db, u.pos, dest, baseSpeed || u.speed || 1);
  if (path && path.length) { u.path = path; u.pathIdx = 0; }
  else { u.path = null; u.pathIdx = 0; }
}
function clearDest(u) {
  u.dest = null; u.path = null; u.pathIdx = 0;
}
// Advances a unit toward its dest, following u.path if present: the leg onto
// the network (path[0]) and the leg off it (after the last waypoint) run at
// baseSpeed; legs BETWEEN network nodes run at baseSpeed × ROAD_SPEED_MULT.
function stepAlongPath(u, baseSpeed) {
  const path = u.path;
  if (path && path.length) {
    const idx = u.pathIdx || 0;
    if (idx < path.length) {
      const wp = path[idx];
      const spd = idx === 0 ? baseSpeed : baseSpeed * ROAD_SPEED_MULT;
      advanceToward(u, wp, spd);
      if (dist(u.pos, wp) < 12) u.pathIdx = idx + 1;
      return;
    }
  }
  advanceToward(u, u.dest, baseSpeed);
}

// ---------- objective resolution ----------
function resolveObjectivePos(db, obj) {
  if (obj.kind === 'control_province') {
    const p = db.provinces.find(x => x.id === obj.ref);
    return p ? (p.labelPos || [0, 0]) : [0, 0];
  }
  if (obj.kind === 'seize_capital' && !obj.ref) {
    const cap = db.cities.find(c => c.isCapital);
    return cap ? cap.pos : [0, 0];
  }
  const city = db.cities.find(c => c.id === obj.ref);
  return city ? city.pos : [0, 0];
}
function resolveObjectiveRef(db, obj) {
  if (obj.kind === 'seize_capital' && !obj.ref) {
    const cap = db.cities.find(c => c.isCapital);
    return cap ? cap.id : null;
  }
  return obj.ref;
}

// ---------- start / end ----------
function startWar(db, scenario) {
  if (!scenario) throw new Error('Unknown scenario');
  if (db.war && db.war.active) throw new Error('A war is already active');
  const attacker = db.entities.find(e => e.id === scenario.attackerId);
  const defender = db.entities.find(e => e.id === scenario.defenderId);
  if (!attacker) throw new Error('Unknown attacker entity: ' + scenario.attackerId);
  if (!defender) throw new Error('Unknown defender entity: ' + scenario.defenderId);

  const grid = buildGrid(db);

  const objectives = scenario.objectives.map(o => ({
    id: store.uid('warobj'),
    kind: o.kind,
    ref: resolveObjectiveRef(db, o),
    pos: resolveObjectivePos(db, o),
    priority: o.priority,
    status: 'pending',
    holdTicks: 0
  }));

  const unitDefaults = (require('./war-scenarios').UNIT_DEFAULTS) || {};
  const stage = scenario.staging;
  const units = scenario.units.map(u => {
    const def = unitDefaults[u.kind] || { strength: 2000, speed: 4, atk: 1 }; // ×10 fallback, consistent with the scenario-data tuning (see war-scenarios.js)
    const strength = u.strength || def.strength;
    return {
      id: store.uid('warunit'),
      side: 'att',
      name: u.name,
      kind: u.kind,
      pos: [rand(stage.x0, stage.x1), rand(stage.y0, stage.y1)],
      dest: null,
      strength, maxStrength: strength,
      org: 100,
      speed: u.speed || def.speed,
      atk: u.atk || def.atk || 1,
      state: 'embarked',
      objectiveId: null
    };
  });

  // Defender garrisons: one per city (by size) and one per military property —
  // fully generic, no ids named here (scenario.defense only supplies numbers).
  const def = scenario.defense || {};
  const sizeStrength = def.citySizeStrength || { 1: 1300, 2: 2200, 3: 3800 }; // ×10 fallback, consistent with the scenario-data tuning
  for (const c of db.cities) {
    if (!c.pos) continue;
    const strength = sizeStrength[c.size] || sizeStrength[1] || 1300;
    units.push({
      id: store.uid('warunit'), side: 'def', name: c.name + ' Garrison', kind: 'garrison',
      pos: [c.pos[0], c.pos[1]], dest: null, strength, maxStrength: strength, org: 100,
      speed: 0, atk: 1, state: 'holding', objectiveId: null, garrison: true
    });
  }
  for (const p of db.properties) {
    if (p.type !== 'military' || !p.pos) continue;
    const strength = def.militaryPropertyStrength || 2600;
    units.push({
      id: store.uid('warunit'), side: 'def', name: p.name + ' Garrison', kind: 'garrison',
      pos: [p.pos[0], p.pos[1]], dest: null, strength, maxStrength: strength, org: 100,
      speed: 0, atk: 1, state: 'holding', objectiveId: null, garrison: true
    });
  }

  const attackerTotal = units.filter(u => u.side === 'att').reduce((s, u) => s + u.strength, 0);

  db.war = {
    active: true, paused: false, speed: 1,
    tickMs: 2000, _lastTick: Date.now(),
    tick: 0, startedAt: new Date().toISOString(),
    scenarioId: scenario.id, name: scenario.name, attackerId: attacker.id, defenderId: defender.id,
    grid, cells: {}, units, objectives,
    ai: { phase: 'landing', lastPlanTick: 0, notes: [], attackerStartStrength: attackerTotal,
      consolidateFrac: (scenario.tuning || {}).consolidateFrac || 0.35,
      collapseFrac: (scenario.tuning || {}).collapseFrac || 0.12 },
    events: [],
    stats: { attLosses: 0, defLosses: 0, provinceControl: {}, citiesHeld: [] },
    bombs: { att: { cooldownUntil: 0 }, def: { cooldownUntil: 0 } },
    craters: [],
    result: null
  };
  pushEvent(db.war, 'landing', units[0].pos, `${attacker.name} war fleet sighted in the Strait — invasion begins.`);
  store.log('event', `${attacker.name} launches an invasion`, scenario.name, 'WAR ENGINE', [attacker.id, defender.id]);
  newsMilestone(`WAR: ${attacker.name} FORCES SIGHTED OFF THE COAST`,
    `Naval assets belonging to ${attacker.name} have been sighted massing in the Strait of Valgos. The government has not yet issued a statement.`);
  return db.war;
}

function endWar(db, actor, reason) {
  const war = db.war;
  if (!war) return null;
  war.active = false;
  if (!war.result) war.result = { winner: null, endedAt: new Date().toISOString(), reason: reason || 'Ended by the Gamemaster' };
  store.log('event', 'War ended', reason || 'By order of the Gamemaster', actor || 'WAR ENGINE', []);
  return war;
}

function pushEvent(war, kind, pos, text) {
  war.events.push({ t: Date.now(), kind, pos, text });
  if (war.events.length > 60) war.events.splice(0, war.events.length - 60);
}

// ---------- AI grand strategy (attacker only — defenders are static garrisons) ----------
function primaryObjective(war) {
  const pending = war.objectives.filter(o => o.status !== 'done' && o.kind !== 'control_province');
  pending.sort((a, b) => a.priority - b.priority);
  return pending[0] || null;
}
function note(war, text) {
  war.ai.notes.push({ t: war.tick, text });
  if (war.ai.notes.length > 20) war.ai.notes.shift();
}
function runAI(db, war) {
  const attTotal = war.units.filter(u => u.side === 'att' && isLive(u)).reduce((s, u) => s + u.strength, 0);
  const collapseAt = war.ai.attackerStartStrength * war.ai.collapseFrac;
  const consolidateAt = war.ai.attackerStartStrength * war.ai.consolidateFrac;

  if (attTotal <= collapseAt) {
    if (war.active) {
      war.active = false;
      war.result = { winner: 'def', endedAt: new Date().toISOString(), reason: 'Invasion force destroyed' };
      note(war, `Attacking force collapsed (${Math.round(attTotal)} strength remaining) — the defence holds.`);
      store.log('event', 'The invasion has been repelled', war.name, 'WAR ENGINE', [war.attackerId, war.defenderId]);
      newsMilestone('THE INVASION IS REPELLED', 'The invading expeditionary force has been shattered. What remains is falling back to the coast.');
    }
    return;
  }

  const landingObj = war.objectives.find(o => o.kind === 'landing');
  const wasPhase = war.ai.phase;
  if (attTotal <= consolidateAt) war.ai.phase = 'consolidate';
  else if (landingObj && landingObj.status !== 'done') war.ai.phase = 'landing';
  else war.ai.phase = war.ai.phase === 'consolidate' ? 'consolidate' : (war.objectives.every(o => o.status === 'done') ? 'exploit' : 'breakout');
  if (war.ai.phase !== wasPhase) note(war, `Phase change: ${wasPhase} → ${war.ai.phase}`);

  const target = primaryObjective(war);
  if (war.ai.phase === 'consolidate') {
    for (const u of war.units) {
      if (u.side !== 'att' || !isLive(u) || u.state === 'embarked') continue;
      if (u.orderedBy === 'player' && (u.playerHoldUntil || 0) > war.tick) continue;
      clearDest(u);
      if (u.state !== 'routed') u.state = 'holding';
    }
    note(war, 'Digging in on captured ground — no further advances ordered.');
    return;
  }

  // Once every city/landing objective is done but a control_province
  // objective is still short of its threshold, there is nothing left to
  // "march toward" — fall back to sweeping committed units across random
  // land cells inside that province so they keep expanding the captured
  // footprint instead of standing idle on the cities they already took.
  const sweepObj = !target ? war.objectives.find(o => o.status !== 'done' && o.kind === 'control_province') : null;

  let assigned = 0, garrisoned = 0;
  for (let i = 0; i < war.units.length; i++) {
    const u = war.units[i];
    if (u.side !== 'att' || !isLive(u) || u.state === 'routed') continue;
    if (u.orderedBy === 'player' && (u.playerHoldUntil || 0) > war.tick) continue; // GM ordered this unit directly — leave it alone until the hold expires
    if (u.state === 'embarked') { u.objectiveId = landingObj ? landingObj.id : null; continue; }
    // hold every 4th committed unit back on the last city taken, as a garrison
    const lastHeld = war.stats.citiesHeld.length ? war.stats.citiesHeld[war.stats.citiesHeld.length - 1] : null;
    if (lastHeld && i % 4 === 3) {
      const city = db.cities.find(c => c.id === lastHeld);
      if (city) { clearDest(u); u.state = 'holding'; u.objectiveId = null; garrisoned++; continue; }
    }
    if (target) { setDest(db, u, target.pos.slice(), u.speed); u.objectiveId = target.id; assigned++; }
    else if (sweepObj) {
      setDest(db, u, randomProvincePoint(war, sweepObj.ref) || sweepObj.pos.slice(), u.speed);
      u.objectiveId = sweepObj.id; assigned++;
    }
  }
  if (target) note(war, `Committing ${assigned} unit(s) toward ${target.kind} (priority ${target.priority}); ${garrisoned} holding captured ground.`);
  else if (sweepObj) note(war, `Sweeping ${assigned} unit(s) through ${sweepObj.kind} (priority ${sweepObj.priority}) to raise territorial control.`);
  else note(war, 'All objectives complete — mopping up.');
}

// ---------- movement ----------
// nearest LIVE enemy to a unit (used both for collision and elsewhere).
function nearestLiveEnemy(war, u) {
  let nearest = null, nd = Infinity;
  for (const e of war.units) {
    if (e.side === u.side || !isLive(e)) continue;
    const d = dist(u.pos, e.pos);
    if (d < nd) { nd = d; nearest = e; }
  }
  return { unit: nearest, dist: nd };
}
function stepMovement(db, war) {
  for (const u of war.units) {
    if (!isLive(u)) continue;
    if (u.side === 'def') {
      // Mobile defenders: a garrison only moves once the player has given it
      // a dest (commandUnits grants it DEF_MOVE_SPEED). No dest = stays put
      // (the classic static garrison, unchanged for scenarios with no player
      // input at all).
      if (!u.dest) continue;
      // Collision: a live unit never advances into COLLIDE_ENEMY of a live
      // enemy — it stops and fights instead (stepCombat handles damage).
      const near = nearestLiveEnemy(war, u);
      if (near.unit && near.dist <= COLLIDE_ENEMY) { u.state = 'fighting'; continue; }
      const spd = u.speed || DEF_MOVE_SPEED;
      stepAlongPath(u, spd);
      u.state = 'moving';
      if (dist(u.pos, u.dest) < 12) { clearDest(u); u.orderedBy = null; u.state = 'holding'; }
      continue;
    }
    if (u.state === 'embarked') {
      const landingObj = war.objectives.find(o => o.kind === 'landing');
      if (!u.dest && landingObj) setDest(db, u, landingObj.pos.slice(), u.speed);
      if (u.dest) {
        stepAlongPath(u, u.speed);
        if (dist(u.pos, u.dest) < 40) {
          u.state = 'moving';
          if (landingObj && landingObj.status === 'pending') {
            landingObj.status = 'done';
            pushEvent(war, 'landing', u.pos.slice(), `${u.name} storms ashore.`);
            store.log('event', 'Landing achieved', `${u.name} has established a beachhead.`, 'WAR ENGINE', [war.attackerId]);
            newsMilestone('INVASION FORCES LAND', `${u.name} has come ashore under fire. The beachhead is holding for now.`);
          }
          const next = primaryObjective(war);
          if (next) setDest(db, u, next.pos.slice(), u.speed); else clearDest(u);
          u.objectiveId = next ? next.id : null;
        }
      }
      continue;
    }
    if (u.state === 'routed') {
      // fall back away from the nearest live enemy, recovering org
      const enemies = war.units.filter(e => e.side !== u.side && isLive(e));
      let away = u.pos;
      if (enemies.length) {
        let nearest = enemies[0], nd = dist(u.pos, nearest.pos);
        for (const e of enemies) { const d = dist(u.pos, e.pos); if (d < nd) { nd = d; nearest = e; } }
        const dx = u.pos[0] - nearest.pos[0], dy = u.pos[1] - nearest.pos[1];
        const m = Math.hypot(dx, dy) || 1;
        away = [u.pos[0] + dx / m * 100, u.pos[1] + dy / m * 100];
      }
      advanceToward(u, away, u.speed * 0.8);
      u.org = clamp(u.org + ORG_REGEN * 1.5, 0, 100);
      if (u.org >= RALLY_ORG) { u.state = 'holding'; note(war, `${u.name} rallies (org ${Math.round(u.org)}).`); }
      continue;
    }
    if (u.dest) {
      // Collision: a live unit never advances into COLLIDE_ENEMY of a live
      // enemy — it stops and fights instead (stepCombat handles damage).
      const near = nearestLiveEnemy(war, u);
      if (near.unit && near.dist <= COLLIDE_ENEMY) { u.state = 'fighting'; continue; }
      stepAlongPath(u, u.speed);
      // A player-ordered attacker unit that reaches its dest reverts to
      // normal AI-eligible behaviour on the next replan.
      if (u.orderedBy === 'player' && dist(u.pos, u.dest) < 12) { u.orderedBy = null; clearDest(u); u.state = 'holding'; continue; }
      // Reached a sweep waypoint (control_province patrol) with the objective
      // still short of its threshold — pick a fresh waypoint immediately
      // rather than idling until the next AI replan (up to AI_INTERVAL ticks).
      if (dist(u.pos, u.dest) < 20 && u.objectiveId) {
        const obj = war.objectives.find(o => o.id === u.objectiveId);
        if (obj && obj.kind === 'control_province' && obj.status !== 'done') {
          setDest(db, u, randomProvincePoint(war, obj.ref) || obj.pos.slice(), u.speed);
        }
      }
    }
  }
  // Friendly separation — cheap O(n^2) over a small roster (~24 units).
  // Garrisons that are holding (not moving) stay put so dug-in stacks don't jitter.
  const live = war.units.filter(isLive);
  for (let i = 0; i < live.length; i++) {
    const a = live[i];
    if (a.garrison && !a.dest) continue;
    for (let j = i + 1; j < live.length; j++) {
      const b = live[j];
      if (a.side !== b.side) continue;
      if (b.garrison && !b.dest) continue;
      const dx = b.pos[0] - a.pos[0], dy = b.pos[1] - a.pos[1];
      const d = Math.hypot(dx, dy);
      if (d > 0 && d < FRIENDLY_SEP) {
        const push = (FRIENDLY_SEP - d) / 2;
        const nx = dx / d, ny = dy / d;
        a.pos = [a.pos[0] - nx * push * 0.5, a.pos[1] - ny * push * 0.5];
        b.pos = [b.pos[0] + nx * push * 0.5, b.pos[1] + ny * push * 0.5];
      }
    }
  }
}
function advanceToward(u, dest, speed) {
  const dx = dest[0] - u.pos[0], dy = dest[1] - u.pos[1];
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return;
  const step = Math.min(speed, d);
  u.pos = [u.pos[0] + dx / d * step, u.pos[1] + dy / d * step];
}

// ---------- combat ----------
// Mark a unit dead WITHOUT splicing it out of war.units — it stays as a
// corpse for the rest of the war (see the STATE SHAPE note above). Roster is
// small (~24 units) so no cap is needed; pruneCorpses() below bounds growth
// over very long wars by age instead.
function killUnit(war, u) {
  u.strength = 0;
  u.dead = true;
  u.deadAt = war.tick;
  u.state = 'dead';
  u.dest = null;
  pushEvent(war, 'battle', u.pos.slice(), `${u.name} destroyed.`);
}
function pruneCorpses(war) {
  war.units = war.units.filter(u => !u.dead || (war.tick - (u.deadAt || 0)) < CORPSE_MAX_AGE_TICKS);
}
function stepCombat(db, war) {
  const atts = war.units.filter(u => u.side === 'att' && isLive(u) && u.state !== 'embarked');
  const defs = war.units.filter(u => u.side === 'def' && isLive(u));
  let anyFight = false;
  for (const a of atts) {
    let nearest = null, nd = Infinity;
    for (const d of defs) { const dd = dist(a.pos, d.pos); if (dd < nd) { nd = dd; nearest = d; } }
    if (!nearest || nd > COMBAT_RANGE) { if (a.state !== 'routed') a.state = a.dest ? 'moving' : 'holding'; continue; }
    const d = nearest;
    anyFight = true;
    a.state = 'fighting'; if (d.state !== 'routed') d.state = 'fighting';
    const defStationary = d.garrison && !d.dest; // the dug-in bonus only applies while the defender is holding its ground — a garrison that marches out loses it
    const defBonus = defStationary ? 1.35 : 1;
    const dmgToDef = K_COMBAT * a.strength * (0.7 + 0.6 * Math.random()) * (a.atk || 1);
    const dmgToAtt = K_COMBAT * d.strength * (0.7 + 0.6 * Math.random()) * defBonus;
    d.strength = Math.max(0, round1(d.strength - dmgToDef));
    a.strength = Math.max(0, round1(a.strength - dmgToAtt));
    war.stats.defLosses += dmgToDef; war.stats.attLosses += dmgToAtt;
    a.org = clamp(a.org - ORG_DRAIN, 0, 100);
    d.org = clamp(d.org - ORG_DRAIN * 0.7, 0, 100); // dug-in defenders lose organisation more slowly
    if (a.org < ROUT_ORG && a.state !== 'routed') { a.state = 'routed'; pushEvent(war, 'battle', a.pos.slice(), `${a.name} breaks and routs.`); }
    if (d.org < ROUT_ORG && !d.garrison && d.state !== 'routed') { d.state = 'routed'; pushEvent(war, 'battle', d.pos.slice(), `${d.name} breaks and routs.`); }
    if (a.strength <= 0) killUnit(war, a);
    if (d.strength <= 0) killUnit(war, d);
  }
  pruneCorpses(war);
  if (!anyFight) {
    for (const u of war.units) if (isLive(u) && u.state !== 'routed' && u.side === 'att') u.org = clamp(u.org + ORG_REGEN, 0, 100);
  }
}
function round1(n) { return Math.round(n * 10) / 10; }

// ---------- territory fracture ----------
function stepTerritory(db, war) {
  const cs = war.grid.cell;
  for (const u of war.units) {
    if (!isLive(u) || u.state === 'embarked') continue;
    const cx0 = Math.floor(u.pos[0] / cs), cy0 = Math.floor(u.pos[1] / cs);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const cx = cx0 + dx, cy = cy0 + dy;
        if (cx < 0 || cy < 0 || cx >= war.grid.cols || cy >= war.grid.rows) continue;
        const centerX = (cx + 0.5) * cs, centerY = (cy + 0.5) * cs;
        if (Math.hypot(centerX - u.pos[0], centerY - u.pos[1]) / cs > CONTROL_RADIUS_CELLS) continue;
        const key = cellKey(cx, cy);
        if (u.side === 'def') { if (war.cells[key]) delete war.cells[key]; continue; }
        const existing = war.cells[key];
        if (existing && existing.o === 'att') continue;
        const pid = geometry.provinceAt(db.provinces, [centerX, centerY]);
        if (!pid) continue; // sea / no province — not capturable
        war.cells[key] = { o: 'att', p: 1, pid };
      }
    }
  }
}

// ---------- objectives / milestones ----------
function stepObjectives(db, war) {
  for (const o of war.objectives) {
    if (o.status === 'done' || o.kind === 'landing') continue;
    if (o.kind === 'control_province') {
      const total = war.grid.provinceLandCells[o.ref] || 0;
      const pct = total ? Math.round((war.stats.provinceControl[o.ref] || 0)) : 0;
      if (pct >= CITY_CONTROL_PCT) {
        o.status = 'done';
        const prov = db.provinces.find(p => p.id === o.ref);
        pushEvent(war, 'capture', o.pos, `${prov ? prov.name : o.ref} province secured.`);
        store.log('event', `${prov ? prov.name : o.ref} secured`, 'Province control objective complete.', 'WAR ENGINE', [war.attackerId]);
      }
      continue;
    }
    // seize_city / seize_capital: uncontested attacker presence for N ticks
    const cityId = o.ref;
    const city = db.cities.find(c => c.id === cityId);
    if (!city) continue;
    const attNear = war.units.some(u => u.side === 'att' && isLive(u) && u.state !== 'embarked' && dist(u.pos, o.pos) <= CAPTURE_RANGE);
    const defNear = war.units.some(u => u.side === 'def' && isLive(u) && dist(u.pos, o.pos) <= CAPTURE_RANGE);
    if (attNear && !defNear) {
      o.holdTicks = (o.holdTicks || 0) + 1;
      if (o.status === 'pending') o.status = 'active';
      if (o.holdTicks >= CAPTURE_HOLD_TICKS) {
        o.status = 'done';
        war.stats.citiesHeld.push(city.id);
        const label = o.kind === 'seize_capital' ? 'THE CAPITAL FALLS' : `${city.name.toUpperCase()} FALLS`;
        pushEvent(war, 'capture', o.pos, `${city.name} has fallen.`);
        store.log('event', `${city.name} captured`, o.kind === 'seize_capital' ? 'The capital has fallen.' : 'City objective complete.', 'WAR ENGINE', [war.attackerId, war.defenderId]);
        newsMilestone(label, o.kind === 'seize_capital'
          ? `${city.name} has fallen to the invading force. The government's whereabouts are unconfirmed.`
          : `${city.name} has fallen after a sustained assault. Refugees are reported streaming inland.`);
      }
    } else {
      o.holdTicks = 0;
    }
  }
}

function recomputeProvinceControl(war) {
  const counts = {};
  for (const key in war.cells) {
    const c = war.cells[key];
    if (c.o !== 'att' || !c.pid) continue;
    counts[c.pid] = (counts[c.pid] || 0) + 1;
  }
  const out = {};
  for (const pid in war.grid.provinceLandCells) {
    const total = war.grid.provinceLandCells[pid] || 0;
    out[pid] = total ? Math.round((counts[pid] || 0) / total * 100) : 0;
  }
  war.stats.provinceControl = out;
}

function checkVictory(db, war) {
  if (!war.active) return;
  const allDone = war.objectives.every(o => o.status === 'done');
  if (allDone) {
    war.active = false;
    war.result = { winner: 'att', endedAt: new Date().toISOString(), reason: 'All objectives secured' };
    store.log('event', 'The invasion succeeds', war.name, 'WAR ENGINE', [war.attackerId, war.defenderId]);
    newsMilestone('THE REPUBLIC FALLS', 'All strategic objectives have been secured by the invading force. The government has fallen.');
  }
}

// ---------- player command entry points ----------
// A player order sets dest (+ orderedBy/playerHoldUntil for attacker units —
// meaningless for defenders, which have no AI to hold off, but harmless to
// set uniformly). Defenders additionally get DEF_MOVE_SPEED the first time
// they're ordered to move (spawn speed stays 0 otherwise, preserving the
// classic static-garrison behaviour for scenarios/tests that never call this).
function commandUnits(db, side, orders, actor) {
  const war = db.war;
  if (!war || !Array.isArray(orders)) return;
  for (const o of orders) {
    if (!o || !o.unitId || !Array.isArray(o.dest) || o.dest.length !== 2) continue;
    const u = war.units.find(x => x.id === o.unitId && x.side === side);
    if (!u || !isLive(u)) continue; // unknown/dead/wrong-side — ignore silently
    if (u.side === 'def' && !u.speed) u.speed = DEF_MOVE_SPEED;
    setDest(db, u, [Number(o.dest[0]), Number(o.dest[1])], u.speed);
    u.orderedBy = 'player';
    u.playerHoldUntil = war.tick + PLAYER_HOLD_TICKS;
  }
}

// Falloff 1 at blast centre → 0 at BOMB_RADIUS.
function bombFalloff(d) { return clamp(1 - d / BOMB_RADIUS, 0, 1); }

function dropBomb(db, side, pos, actor) {
  // Bombs are DEFENDER-ONLY — the attacker AI never bombs, and even a GM
  // commanding the attacker side directly has no air arm to call in. This is
  // enforced here, not just hidden client-side, since the client is untrusted.
  if (side !== 'def') return { ok: false, error: 'Only the defence has an air arm in this scenario.' };
  const war = db.war;
  if (!war || !war.active || war.paused) return { ok: false, error: 'No war is active.' };
  war.bombs = war.bombs || { att: { cooldownUntil: 0 }, def: { cooldownUntil: 0 } };
  const bomb = war.bombs[side] = war.bombs[side] || { cooldownUntil: 0 };
  const now = Date.now();
  if (now < bomb.cooldownUntil) return { ok: false, error: 'Bomb is on cooldown.' };
  if (!Array.isArray(pos) || pos.length !== 2) return { ok: false, error: 'Invalid target position.' };
  bomb.cooldownUntil = now + BOMB_COOLDOWN_MS;

  // 1. Damage units of both sides within the blast.
  for (const u of war.units) {
    if (!isLive(u)) continue;
    const d = dist(u.pos, pos);
    if (d > BOMB_RADIUS) continue;
    const dmg = BOMB_UNIT_DMG * bombFalloff(d);
    u.strength = Math.max(0, round1(u.strength - dmg));
    if (u.side === 'att') war.stats.attLosses += dmg; else war.stats.defLosses += dmg;
    if (u.strength <= 0) killUnit(war, u);
  }
  pruneCorpses(war);

  // 2. Destroy properties within the blast; sync the deed mirror ONCE after.
  const destroyed = [];
  db.properties = (db.properties || []).filter(p => {
    if (!p.pos || dist(p.pos, pos) > BOMB_RADIUS) return true;
    destroyed.push(p);
    return false;
  });
  if (destroyed.length) {
    require('./deeds').syncAllDeeds(db);
    for (const p of destroyed) {
      store.log('event', `${p.name} destroyed`, 'Levelled by aerial bombardment', actor || 'WAR ENGINE', []);
    }
  }

  // 3. Cut roads: strip points within the blast, split surviving runs.
  const roads = ((db.settings || {}).map || {}).roads || [];
  const nextRoads = [];
  let roadsCut = 0;
  for (const r of roads) {
    const pts = r.pts || [];
    const inBlast = pts.some(p => dist(p, pos) <= BOMB_RADIUS);
    if (!inBlast) { nextRoads.push(r); continue; }
    roadsCut++;
    let run = [];
    const runs = [];
    for (const p of pts) {
      if (dist(p, pos) <= BOMB_RADIUS) { if (run.length) runs.push(run); run = []; }
      else run.push(p);
    }
    if (run.length) runs.push(run);
    for (const run2 of runs) if (run2.length >= 2) nextRoads.push({ id: store.uid('road'), pts: run2 });
  }
  if (roadsCut) {
    db.settings = db.settings || {}; db.settings.map = db.settings.map || {};
    db.settings.map.roads = nextRoads;
  }

  // 4. Crater.
  war.craters = war.craters || [];
  war.craters.push({ pos: pos.slice(), t: now, side });
  if (war.craters.length > 40) war.craters.shift();

  // 5. Battle event.
  pushEvent(war, 'battle', pos.slice(), `Bombing run — ${destroyed.length} structure${destroyed.length === 1 ? '' : 's'} levelled.`);

  return { ok: true };
}

// ---------- one tick ----------
function warTick(db) {
  const war = db.war;
  if (!war || !war.active || war.paused) return false;
  war.tick++;
  if (war.tick - (war.ai.lastPlanTick || 0) >= AI_INTERVAL) {
    runAI(db, war);
    war.ai.lastPlanTick = war.tick;
    if (!war.active) return true; // AI declared a collapse-defeat this tick
  }
  stepMovement(db, war);
  stepCombat(db, war);
  stepTerritory(db, war);
  recomputeProvinceControl(war);
  stepObjectives(db, war);
  checkVictory(db, war);
  return true;
}

// ---------- serverless heartbeat ----------
function maybeWarTick(db) {
  const war = db.war;
  if (!war || !war.active || war.paused) return false;
  const now = Date.now();
  const interval = Math.max(200, war.tickMs / (war.speed || 1));
  const last = war._lastTick || 0;
  const elapsed = now - last;
  if (elapsed < interval) return false;
  const steps = Math.min(MAX_TICKS_PER_CALL, Math.max(1, Math.floor(elapsed / interval)));
  let any = false;
  for (let i = 0; i < steps; i++) {
    if (!warTick(db)) break;
    any = true;
  }
  war._lastTick = now;
  return any;
}

module.exports = { startWar, endWar, warTick, maybeWarTick, buildGrid, dropBomb, commandUnits, isLive };
