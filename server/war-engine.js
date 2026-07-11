'use strict';
// Deterministic war simulation engine — the PURE tick pipeline shared by the
// server (authority) and the browser (client-side prediction). Same pattern
// as pricepath.js: this file MUST stay behaviourally identical to
// public/js/war-engine.js (browser copy) — edit both together.
//
// Determinism contract: given the same db.war document (including war.seed
// and war.tick) and the same provinces/cities/settings.map, warTick()
// produces the same next state on the server and on every client. All
// tick-time randomness flows through a mulberry32 PRNG seeded from
// (war.seed ^ war.tick) — never Math.random(). This is what lets the client
// run the same simulation locally between authoritative snapshots (smooth,
// instant-feeling combat) and simply rebase onto each server state when it
// arrives, with only tiny corrections.
//
// Side effects (timeline log entries, news milestones) are NOT part of the
// simulation: they arrive through the `ctx` hooks. The server passes real
// store.log/sim.draftNews; a predicting client passes nothing and gets
// no-ops, so predicted milestones never double-publish. Everything that
// needs server-only modules (store.uid, deeds, scenario spawning, bombs)
// stays in server/war.js — this module has ZERO requires.
//
// Airstrikes (cinematic two-phase bombing) split the same way: server/war.js's
// dropBomb only ENQUEUES a strike onto war.airstrikes (additive, absent-safe
// — a missing array reads as []); the DETERMINISTIC blast (unit damage,
// crater, event) applies here in stepAirstrikes, at war.tick >=
// strike.strikeTick, so a predicting client detonates it at the same tick as
// the server. The server-only ground effects — destroying properties, cutting
// roads, the audit log — are NOT part of the simulation (a predicting client
// must never mutate db.properties/settings.map.roads) and instead ride the
// `ctx.onAirstrike(war, strike)` hook, exactly like log/news: the server
// binds a real handler, a predicting client's ctx omits it and gets a no-op.
//
// Cosmetic exception to determinism: event timestamps (events[].t) and
// result.endedAt use wall-clock time — they are display-only and never feed
// back into the simulation.
(function (global) {

  // ---------- tunables (identical to the pre-split server/war.js values) ----------
  const CELL = 48;
  const CONTROL_RADIUS_CELLS = 1.5;   // a unit projects control this many cells out
  const COMBAT_RANGE = 40;            // px — opposing units this close fight (symbol width — combat on box-touch)
  const CAPTURE_RANGE = 60;           // px — how close to a city counts as "holding" it
  const CAPTURE_HOLD_TICKS = 3;       // consecutive uncontested ticks to flip a city
  const AI_INTERVAL = 10;             // ticks between grand-strategy replans
  const K_COMBAT = 0.0035;            // per-tick strength loss ~ k × enemy strength
  const ORG_DRAIN = 3.5;              // per-tick org loss while fighting
  const ORG_REGEN = 0.6;              // per-tick org recovery while not fighting
  const ROUT_ORG = 25;                // org threshold that triggers a rout
  const RALLY_ORG = 45;               // org a routed unit needs to rejoin the line
  const ROAD_SPEED_MULT = 5;          // speed multiplier while following the road/rail transport graph
  const ROAD_JUNCTION_RANGE = 50;     // px — nodes from different polylines within this range are linked
  const CITY_CONTROL_PCT = 65;        // province-control % that satisfies control_province
  const MAX_TICKS_PER_CALL = 20;      // catch-up cap, same spirit as autoTick's 30
  const UNIT_RADIUS = 26;             // px — a unit's collider radius
  const COLLIDE_ENEMY = 40;           // px — a unit will not advance within this of a live enemy
  const FRIENDLY_SEP = 30;            // px — soft separation distance between live friendlies
  const DEF_MOVE_SPEED = 3.2;         // px/tick granted to a garrison the first time it's ordered to move
  const PLAYER_HOLD_TICKS = 12;       // ticks a GM-ordered ATTACKER unit is exempt from AI reassignment
  const CORPSE_MAX_AGE_TICKS = 400;   // corpses older than this are pruned
  const WORLD_BORDER_INSET = 8;       // px — units/dests never sit closer than this to the map edge
  const MAX_MANUAL_PATH_POINTS = 200; // cap on a player-drawn freehand path (also enforced by the API)
  const BOMB_RADIUS = 95;             // px — airstrike blast radius (also read by the client for shockwave FX sizing)
  const BOMB_UNIT_DMG = 90;           // max strength damage at the blast centre (falls off to 0 at BOMB_RADIUS)
  const AIRSTRIKE_PRUNE_TICKS = 30;   // a done strike is dropped from war.airstrikes this many ticks after impact

  function isLive(u) { return !!u && u.strength > 0 && !u.dead; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function round1(n) { return Math.round(n * 10) / 10; }

  // ---------- world border clamp ----------
  // The master grid is 3840×2160, but W/H are DERIVED from war.grid (cols/rows
  // × cell) rather than hardcoded, so a war built on a differently-sized grid
  // (or a legacy doc) still clamps correctly. A small inset keeps unit symbols
  // fully on-screen instead of allowing their center to sit exactly on row 0.
  function worldBounds(war) {
    const g = (war && war.grid) || {};
    const cell = g.cell || CELL;
    const cols = g.cols || Math.ceil(3840 / cell);
    const rows = g.rows || Math.ceil(2160 / cell);
    return [cols * cell, rows * cell];
  }
  function clampToWorld(war, pos) {
    const [W, H] = worldBounds(war);
    return [clamp(pos[0], WORLD_BORDER_INSET, W - WORLD_BORDER_INSET), clamp(pos[1], WORLD_BORDER_INSET, H - WORLD_BORDER_INSET)];
  }

  // ---------- seeded PRNG ----------
  // mulberry32 — tiny, fast, good enough for combat rolls. A fresh stream is
  // derived per tick from (war.seed ^ war.tick), so server and client draw
  // identical numbers as long as they consume them in the same order (they
  // do: iteration order over war.units is part of the state).
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function tickRng(war) {
    const seed = ((war.seed >>> 0) || 1) ^ Math.imul(war.tick, 2654435761);
    return mulberry32(seed >>> 0);
  }

  // ---------- geometry (embedded copy of server/geometry.js's algorithms) ----------
  // Self-contained so the browser copy needs no separate geometry module.
  // Parses M/m L/l H/h V/v Z/z plus curve commands consumed by chord — see
  // server/geometry.js for the full commentary.
  function parseShape(d) {
    const subpaths = [];
    const cmdRe = /([MmLlHhVvCcSsQqTtZz])([^MmLlHhVvCcSsQqTtZz]*)/g;
    let cur = null, x = 0, y = 0, startX = 0, startY = 0, m;
    while ((m = cmdRe.exec(String(d || '')))) {
      const cmd = m[1];
      const nums = (m[2].match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);
      let i = 0;
      switch (cmd) {
        case 'M':
          x = nums[i++]; y = nums[i++];
          cur = [[x, y]]; subpaths.push(cur);
          startX = x; startY = y;
          while (i < nums.length - 1) { x = nums[i++]; y = nums[i++]; cur.push([x, y]); }
          break;
        case 'm':
          x += nums[i++]; y += nums[i++];
          cur = [[x, y]]; subpaths.push(cur);
          startX = x; startY = y;
          while (i < nums.length - 1) { x += nums[i++]; y += nums[i++]; cur.push([x, y]); }
          break;
        case 'L':
          if (!cur) { cur = [[x, y]]; subpaths.push(cur); }
          while (i < nums.length - 1) { x = nums[i++]; y = nums[i++]; cur.push([x, y]); }
          break;
        case 'l':
          if (!cur) { cur = [[x, y]]; subpaths.push(cur); }
          while (i < nums.length - 1) { x += nums[i++]; y += nums[i++]; cur.push([x, y]); }
          break;
        case 'H':
          if (!cur) { cur = [[x, y]]; subpaths.push(cur); }
          while (i < nums.length) { x = nums[i++]; cur.push([x, y]); }
          break;
        case 'h':
          if (!cur) { cur = [[x, y]]; subpaths.push(cur); }
          while (i < nums.length) { x += nums[i++]; cur.push([x, y]); }
          break;
        case 'V':
          if (!cur) { cur = [[x, y]]; subpaths.push(cur); }
          while (i < nums.length) { y = nums[i++]; cur.push([x, y]); }
          break;
        case 'v':
          if (!cur) { cur = [[x, y]]; subpaths.push(cur); }
          while (i < nums.length) { y += nums[i++]; cur.push([x, y]); }
          break;
        case 'C': case 'S': case 'Q': case 'T': {
          if (!cur) { cur = [[x, y]]; subpaths.push(cur); }
          const pairs = cmd === 'C' ? 3 : cmd === 'T' ? 1 : 2;
          while (i + pairs * 2 <= nums.length) { i += (pairs - 1) * 2; x = nums[i++]; y = nums[i++]; cur.push([x, y]); }
          break;
        }
        case 'c': case 's': case 'q': case 't': {
          if (!cur) { cur = [[x, y]]; subpaths.push(cur); }
          const pairs = cmd === 'c' ? 3 : cmd === 't' ? 1 : 2;
          while (i + pairs * 2 <= nums.length) { i += (pairs - 1) * 2; x += nums[i++]; y += nums[i++]; cur.push([x, y]); }
          break;
        }
        case 'Z': case 'z':
          x = startX; y = startY;
          break;
      }
    }
    return subpaths;
  }
  function polygonOf(prov) {
    if (Array.isArray(prov.path) && prov.path.length > 2) return prov.path;
    if (typeof prov.shape === 'string') return parseShape(prov.shape);
    return null;
  }
  function rayCross(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }
  function pointInPolygon(pt, poly) {
    if (!pt || !poly || !poly.length) return false;
    const x = pt[0], y = pt[1];
    const isCompound = Array.isArray(poly[0][0]);
    const subpaths = isCompound ? poly : [poly];
    let inside = false;
    for (const sp of subpaths) {
      if (!sp || sp.length < 3) continue;
      if (rayCross(x, y, sp)) inside = !inside;
    }
    return inside;
  }
  // Parsed-polygon cache keyed by province object — provinceAt runs per
  // projected cell per tick, and re-parsing SVG shape strings every call
  // would dominate the tick. The entry revalidates against the shape/path
  // references it was built from, so an in-place edit to a province outline
  // (GM map editor on a warm server instance) invalidates naturally; replaced
  // state objects (fresh client snapshots, reloaded server docs) simply miss.
  const _polyCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function cachedPolygonOf(prov) {
    if (!_polyCache) return polygonOf(prov);
    const hit = _polyCache.get(prov);
    if (hit && hit.shape === prov.shape && hit.path === prov.path) return hit.poly;
    const poly = polygonOf(prov);
    _polyCache.set(prov, { shape: prov.shape, path: prov.path, poly });
    return poly;
  }
  function provinceAt(provinces, pt) {
    if (!pt || !Array.isArray(provinces)) return null;
    for (const p of provinces) {
      const poly = cachedPolygonOf(p);
      if (poly && poly.length && pointInPolygon(pt, poly)) return p.id;
    }
    return null;
  }

  // ---------- grid ----------
  function cellKey(cx, cy) { return cx + ',' + cy; }
  function buildGrid(db) {
    const cols = Math.ceil(3840 / CELL), rows = Math.ceil(2160 / CELL);
    const provinceLandCells = {};
    const provinceCells = {};
    let totalLandCells = 0;
    for (let cx = 0; cx < cols; cx++) {
      for (let cy = 0; cy < rows; cy++) {
        const centerX = (cx + 0.5) * CELL, centerY = (cy + 0.5) * CELL;
        const pid = provinceAt(db.provinces, [centerX, centerY]);
        if (!pid) continue;
        provinceLandCells[pid] = (provinceLandCells[pid] || 0) + 1;
        (provinceCells[pid] = provinceCells[pid] || []).push([cx, cy]);
        totalLandCells++;
      }
    }
    return { cell: CELL, cols, rows, provinceLandCells, provinceCells, totalLandCells };
  }
  // A land-cell centre inside a province, biased toward STILL-UNCAPTURED
  // cells (a handful of seeded draws) — see the pre-split commentary in
  // docs/WAR.md. All draws come from the tick's rng for determinism.
  function randomProvincePoint(war, provId, rng) {
    const cells = (war.grid.provinceCells || {})[provId];
    if (!cells || !cells.length) return null;
    const cs = war.grid.cell;
    let pick = cells[Math.floor(rng() * cells.length)];
    for (let tries = 0; tries < 12; tries++) {
      const cand = cells[Math.floor(rng() * cells.length)];
      const key = cellKey(cand[0], cand[1]);
      const held = war.cells[key];
      if (!held || held.o !== 'att') { pick = cand; break; }
    }
    return [(pick[0] + 0.5) * cs, (pick[1] + 0.5) * cs];
  }

  // ---------- transport graph (roads + rails) ----------
  // Pure derived cache (see docs/WAR.md) — safe on serverless cold starts AND
  // in the browser; keyed by a content fingerprint of the road/rail data.
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
  function setDest(db, u, dest, baseSpeed) {
    const war = db.war;
    u.dest = clampToWorld(war, dest);
    u.manualPath = false; // a normal order always restores road/rail routing over any earlier freehand path
    const path = computePath(db, u.pos, u.dest, baseSpeed || u.speed || 1);
    if (path && path.length) { u.path = path; u.pathIdx = 0; }
    else { u.path = null; u.pathIdx = 0; }
  }
  // Player-drawn freehand path (right-drag — see docs/WAR.md "Manual paths").
  // Unlike setDest, this never consults the transport graph: manualPath units
  // ignore road/rail speed entirely and just walk the drawn polyline at base
  // speed (stepAlongPath below checks the flag).
  function setManualPath(db, u, waypoints) {
    const war = db.war;
    const pts = (waypoints || []).slice(0, MAX_MANUAL_PATH_POINTS)
      .map(p => clampToWorld(war, [Number(p[0]), Number(p[1])]))
      .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (pts.length < 1) return;
    u.path = pts;
    u.pathIdx = 0;
    u.dest = pts[pts.length - 1];
    u.manualPath = true;
  }
  function clearDest(u) {
    u.dest = null; u.path = null; u.pathIdx = 0; u.manualPath = false;
  }
  function stepAlongPath(war, u, baseSpeed) {
    const path = u.path;
    if (path && path.length) {
      const idx = u.pathIdx || 0;
      if (idx < path.length) {
        const wp = path[idx];
        // Manual (freehand) paths ignore the road-speed bonus entirely — the
        // player drew this line deliberately and expects the unit to just
        // walk it, not silently divert onto the transport graph's speed rule.
        const spd = u.manualPath ? baseSpeed : (idx === 0 ? baseSpeed : baseSpeed * ROAD_SPEED_MULT);
        advanceToward(war, u, wp, spd);
        if (dist(u.pos, wp) < 12) u.pathIdx = idx + 1;
        return;
      }
    }
    advanceToward(war, u, u.dest, baseSpeed);
  }
  function advanceToward(war, u, dest, speed) {
    const dx = dest[0] - u.pos[0], dy = dest[1] - u.pos[1];
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return;
    const step = Math.min(speed, d);
    u.pos = clampToWorld(war, [u.pos[0] + dx / d * step, u.pos[1] + dy / d * step]);
  }

  // ---------- events / notes ----------
  function pushEvent(war, kind, pos, text) {
    war.events.push({ t: Date.now(), kind, pos, text });
    if (war.events.length > 60) war.events.splice(0, war.events.length - 60);
  }
  function note(war, text) {
    if (!war.ai) return; // non-GM predicted state has ai stripped — notes are GM-only intel anyway
    war.ai.notes.push({ t: war.tick, text });
    if (war.ai.notes.length > 20) war.ai.notes.shift();
  }

  // ---------- AI grand strategy (attacker only) ----------
  function primaryObjective(war) {
    const pending = war.objectives.filter(o => o.status !== 'done' && o.kind !== 'control_province');
    pending.sort((a, b) => a.priority - b.priority);
    return pending[0] || null;
  }
  function runAI(db, war, ctx, rng) {
    const attTotal = war.units.filter(u => u.side === 'att' && isLive(u)).reduce((s, u) => s + u.strength, 0);
    const collapseAt = war.ai.attackerStartStrength * war.ai.collapseFrac;
    const consolidateAt = war.ai.attackerStartStrength * war.ai.consolidateFrac;

    if (attTotal <= collapseAt) {
      if (war.active) {
        war.active = false;
        war.result = { winner: 'def', endedAt: new Date().toISOString(), reason: 'Invasion force destroyed' };
        note(war, `Attacking force collapsed (${Math.round(attTotal)} strength remaining) — the defence holds.`);
        ctx.log('event', 'The invasion has been repelled', war.name, 'WAR ENGINE', [war.attackerId, war.defenderId]);
        ctx.news('THE INVASION IS REPELLED', 'The invading expeditionary force has been shattered. What remains is falling back to the coast.');
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

    const sweepObj = !target ? war.objectives.find(o => o.status !== 'done' && o.kind === 'control_province') : null;

    let assigned = 0, garrisoned = 0;
    for (let i = 0; i < war.units.length; i++) {
      const u = war.units[i];
      if (u.side !== 'att' || !isLive(u) || u.state === 'routed') continue;
      if (u.orderedBy === 'player' && (u.playerHoldUntil || 0) > war.tick) continue;
      if (u.state === 'embarked') { u.objectiveId = landingObj ? landingObj.id : null; continue; }
      const lastHeld = war.stats.citiesHeld.length ? war.stats.citiesHeld[war.stats.citiesHeld.length - 1] : null;
      if (lastHeld && i % 4 === 3) {
        const city = db.cities.find(c => c.id === lastHeld);
        if (city) { clearDest(u); u.state = 'holding'; u.objectiveId = null; garrisoned++; continue; }
      }
      if (target) { setDest(db, u, target.pos.slice(), u.speed); u.objectiveId = target.id; assigned++; }
      else if (sweepObj) {
        setDest(db, u, randomProvincePoint(war, sweepObj.ref, rng) || sweepObj.pos.slice(), u.speed);
        u.objectiveId = sweepObj.id; assigned++;
      }
    }
    if (target) note(war, `Committing ${assigned} unit(s) toward ${target.kind} (priority ${target.priority}); ${garrisoned} holding captured ground.`);
    else if (sweepObj) note(war, `Sweeping ${assigned} unit(s) through ${sweepObj.kind} (priority ${sweepObj.priority}) to raise territorial control.`);
    else note(war, 'All objectives complete — mopping up.');
  }

  // ---------- movement ----------
  function nearestLiveEnemy(war, u) {
    let nearest = null, nd = Infinity;
    for (const e of war.units) {
      if (e.side === u.side || !isLive(e)) continue;
      const d = dist(u.pos, e.pos);
      if (d < nd) { nd = d; nearest = e; }
    }
    return { unit: nearest, dist: nd };
  }
  function stepMovement(db, war, ctx, rng) {
    for (const u of war.units) {
      if (!isLive(u)) continue;
      if (u.side === 'def') {
        if (!u.dest) continue;
        const near = nearestLiveEnemy(war, u);
        if (near.unit && near.dist <= COLLIDE_ENEMY) { u.state = 'fighting'; continue; }
        const spd = u.speed || DEF_MOVE_SPEED;
        stepAlongPath(war, u, spd);
        u.state = 'moving';
        if (dist(u.pos, u.dest) < 12) { clearDest(u); u.orderedBy = null; u.state = 'holding'; }
        continue;
      }
      if (u.state === 'embarked') {
        const landingObj = war.objectives.find(o => o.kind === 'landing');
        if (!u.dest && landingObj) setDest(db, u, landingObj.pos.slice(), u.speed);
        if (u.dest) {
          stepAlongPath(war, u, u.speed);
          if (dist(u.pos, u.dest) < 40) {
            u.state = 'moving';
            if (landingObj && landingObj.status === 'pending') {
              landingObj.status = 'done';
              pushEvent(war, 'landing', u.pos.slice(), `${u.name} storms ashore.`);
              ctx.log('event', 'Landing achieved', `${u.name} has established a beachhead.`, 'WAR ENGINE', [war.attackerId]);
              ctx.news('INVASION FORCES LAND', `${u.name} has come ashore under fire. The beachhead is holding for now.`);
            }
            const next = primaryObjective(war);
            if (next) setDest(db, u, next.pos.slice(), u.speed); else clearDest(u);
            u.objectiveId = next ? next.id : null;
          }
        }
        continue;
      }
      if (u.state === 'routed') {
        const enemies = war.units.filter(e => e.side !== u.side && isLive(e));
        let away = u.pos;
        if (enemies.length) {
          let nearest = enemies[0], nd = dist(u.pos, nearest.pos);
          for (const e of enemies) { const d = dist(u.pos, e.pos); if (d < nd) { nd = d; nearest = e; } }
          const dx = u.pos[0] - nearest.pos[0], dy = u.pos[1] - nearest.pos[1];
          const m = Math.hypot(dx, dy) || 1;
          away = [u.pos[0] + dx / m * 100, u.pos[1] + dy / m * 100];
        }
        advanceToward(war, u, away, u.speed * 0.8);
        u.org = clamp(u.org + ORG_REGEN * 1.5, 0, 100);
        if (u.org >= RALLY_ORG) { u.state = 'holding'; note(war, `${u.name} rallies (org ${Math.round(u.org)}).`); }
        continue;
      }
      if (u.dest) {
        const near = nearestLiveEnemy(war, u);
        if (near.unit && near.dist <= COLLIDE_ENEMY) { u.state = 'fighting'; continue; }
        stepAlongPath(war, u, u.speed);
        if (u.orderedBy === 'player' && dist(u.pos, u.dest) < 12) { u.orderedBy = null; clearDest(u); u.state = 'holding'; continue; }
        if (dist(u.pos, u.dest) < 20 && u.objectiveId) {
          const obj = war.objectives.find(o => o.id === u.objectiveId);
          if (obj && obj.kind === 'control_province' && obj.status !== 'done') {
            setDest(db, u, randomProvincePoint(war, obj.ref, rng) || obj.pos.slice(), u.speed);
          }
        }
      }
    }
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
          a.pos = clampToWorld(war, [a.pos[0] - nx * push * 0.5, a.pos[1] - ny * push * 0.5]);
          b.pos = clampToWorld(war, [b.pos[0] + nx * push * 0.5, b.pos[1] + ny * push * 0.5]);
        }
      }
    }
  }

  // ---------- combat ----------
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
  function stepCombat(db, war, ctx, rng) {
    const atts = war.units.filter(u => u.side === 'att' && isLive(u) && u.state !== 'embarked');
    const defs = war.units.filter(u => u.side === 'def' && isLive(u));
    // GM global tuning (Feature 3) — read defensively so a war doc without
    // `mods` (every war predating this change) falls back to 1× exactly.
    const dmgMod = (war.mods && war.mods.dmg) || 1;
    let anyFight = false;
    for (const a of atts) {
      let nearest = null, nd = Infinity;
      for (const d of defs) { const dd = dist(a.pos, d.pos); if (dd < nd) { nd = dd; nearest = d; } }
      if (!nearest || nd > COMBAT_RANGE) { if (a.state !== 'routed') a.state = a.dest ? 'moving' : 'holding'; continue; }
      const d = nearest;
      anyFight = true;
      a.state = 'fighting'; if (d.state !== 'routed') d.state = 'fighting';
      const defStationary = d.garrison && !d.dest;
      const defBonus = defStationary ? 1.35 : 1;
      const dmgToDef = K_COMBAT * a.strength * (0.7 + 0.6 * rng()) * (a.atk || 1) * dmgMod;
      const dmgToAtt = K_COMBAT * d.strength * (0.7 + 0.6 * rng()) * defBonus * dmgMod;
      d.strength = Math.max(0, round1(d.strength - dmgToDef));
      a.strength = Math.max(0, round1(a.strength - dmgToAtt));
      war.stats.defLosses += dmgToDef; war.stats.attLosses += dmgToAtt;
      a.org = clamp(a.org - ORG_DRAIN, 0, 100);
      d.org = clamp(d.org - ORG_DRAIN * 0.7, 0, 100);
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

  // ---------- airstrikes (cinematic two-phase bombing) ----------
  // Falloff 1 at blast centre → 0 at BOMB_RADIUS, same shape as the old
  // instant-bomb falloff (formerly server/war.js's bombFalloff).
  function airstrikeFalloff(d) { return clamp(1 - d / BOMB_RADIUS, 0, 1); }
  // war.airstrikes: { id, side, pos:[x,y], from:[x,y], orderedTick, strikeTick,
  // orderedAt, done, groundApplied } — enqueued by server/war.js's dropBomb
  // (the order/scheduling is server-only), detonated HERE once
  // war.tick >= strikeTick so the predicted client sees the same explosion at
  // the same tick as the server. Processing is in array order (deterministic).
  function stepAirstrikes(db, war, ctx) {
    if (!Array.isArray(war.airstrikes) || !war.airstrikes.length) return;
    const bombDmgMod = (war.mods && war.mods.bombDmg) || 1;
    for (const strike of war.airstrikes) {
      if (strike.done || war.tick < strike.strikeTick) continue;
      for (const u of war.units) {
        if (!isLive(u)) continue;
        const d = dist(u.pos, strike.pos);
        if (d > BOMB_RADIUS) continue;
        const dmg = BOMB_UNIT_DMG * airstrikeFalloff(d) * bombDmgMod;
        u.strength = Math.max(0, round1(u.strength - dmg));
        if (u.side === 'att') war.stats.attLosses += dmg; else war.stats.defLosses += dmg;
        if (u.strength <= 0) killUnit(war, u);
      }
      pruneCorpses(war);
      war.craters = war.craters || [];
      war.craters.push({ pos: strike.pos.slice(), t: Date.now(), side: strike.side });
      if (war.craters.length > 40) war.craters.shift();
      pushEvent(war, 'battle', strike.pos.slice(), 'Airstrike impact — the blast wave rips through the area.');
      strike.done = true;
      // Server-only: destroy properties/cut roads/audit log. No-op (and thus
      // safely skipped) on a predicting client, which must never touch
      // db.properties or settings.map.roads outside the authoritative tick.
      ctx.onAirstrike(war, strike);
    }
    // Prune old resolved strikes so the array doesn't grow across a long war —
    // the client keeps its plane/FX animation going for a few seconds past
    // impact (see public/js/war.js), well inside this window.
    war.airstrikes = war.airstrikes.filter(s => !s.done || (war.tick - s.strikeTick) < AIRSTRIKE_PRUNE_TICKS);
  }

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
          const pid = provinceAt(db.provinces, [centerX, centerY]);
          if (!pid) continue;
          war.cells[key] = { o: 'att', p: 1, pid };
        }
      }
    }
  }

  // ---------- objectives / milestones ----------
  function stepObjectives(db, war, ctx) {
    for (const o of war.objectives) {
      if (o.status === 'done' || o.kind === 'landing') continue;
      if (o.kind === 'control_province') {
        const total = war.grid.provinceLandCells[o.ref] || 0;
        const pct = total ? Math.round((war.stats.provinceControl[o.ref] || 0)) : 0;
        if (pct >= CITY_CONTROL_PCT) {
          o.status = 'done';
          const prov = db.provinces.find(p => p.id === o.ref);
          pushEvent(war, 'capture', o.pos, `${prov ? prov.name : o.ref} province secured.`);
          ctx.log('event', `${prov ? prov.name : o.ref} secured`, 'Province control objective complete.', 'WAR ENGINE', [war.attackerId]);
        }
        continue;
      }
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
          ctx.log('event', `${city.name} captured`, o.kind === 'seize_capital' ? 'The capital has fallen.' : 'City objective complete.', 'WAR ENGINE', [war.attackerId, war.defenderId]);
          ctx.news(label, o.kind === 'seize_capital'
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

  function checkVictory(db, war, ctx) {
    if (!war.active) return;
    const allDone = war.objectives.every(o => o.status === 'done');
    if (allDone) {
      war.active = false;
      war.result = { winner: 'att', endedAt: new Date().toISOString(), reason: 'All objectives secured' };
      ctx.log('event', 'The invasion succeeds', war.name, 'WAR ENGINE', [war.attackerId, war.defenderId]);
      ctx.news('THE REPUBLIC FALLS', 'All strategic objectives have been secured by the invading force. The government has fallen.');
    }
  }

  // ---------- player orders (pure — shared by the server route and optimistic client apply) ----------
  // An order carries EITHER `dest` (plain move — road/rail routing applies)
  // OR `path` (a player-drawn freehand polyline, ≥2 points — see setManualPath
  // and docs/WAR.md "Manual paths"). `path` wins if both are present.
  function applyOrders(db, side, orders) {
    const war = db.war;
    if (!war || !Array.isArray(orders)) return;
    for (const o of orders) {
      if (!o || !o.unitId) continue;
      const hasPath = Array.isArray(o.path) && o.path.length >= 2 &&
        o.path.every(p => Array.isArray(p) && p.length === 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])));
      const hasDest = Array.isArray(o.dest) && o.dest.length === 2 && Number.isFinite(Number(o.dest[0])) && Number.isFinite(Number(o.dest[1]));
      if (!hasPath && !hasDest) continue;
      const u = war.units.find(x => x.id === o.unitId && x.side === side);
      if (!u || !isLive(u)) continue;
      if (u.side === 'def' && !u.speed) u.speed = DEF_MOVE_SPEED;
      if (hasPath) setManualPath(db, u, o.path);
      else setDest(db, u, [Number(o.dest[0]), Number(o.dest[1])], u.speed);
      u.orderedBy = 'player';
      u.playerHoldUntil = war.tick + PLAYER_HOLD_TICKS;
    }
  }

  // ---------- one tick ----------
  const NOOP = function () { };
  function normCtx(ctx) {
    ctx = ctx || {};
    return { log: ctx.log || NOOP, news: ctx.news || NOOP, onAirstrike: ctx.onAirstrike || NOOP };
  }
  function warTick(db, ctx) {
    const war = db.war;
    if (!war || !war.active || war.paused) return false;
    ctx = normCtx(ctx);
    war.tick++;
    const rng = tickRng(war);
    // AI runs only when war.ai is present: always on the server; on a
    // predicting client only for the GM (filterState strips ai for players).
    // A player client simply keeps units marching on their existing dests
    // between snapshots — the next authoritative state carries any replan.
    if (war.ai && war.tick - (war.ai.lastPlanTick || 0) >= AI_INTERVAL) {
      runAI(db, war, ctx, rng);
      war.ai.lastPlanTick = war.tick;
      if (!war.active) return true; // AI declared a collapse-defeat this tick
    }
    stepMovement(db, war, ctx, rng);
    stepCombat(db, war, ctx, rng);
    stepAirstrikes(db, war, ctx);
    stepTerritory(db, war);
    recomputeProvinceControl(war);
    stepObjectives(db, war, ctx);
    checkVictory(db, war, ctx);
    return true;
  }

  // ---------- wall-clock gate (shared by the server heartbeat and client prediction) ----------
  function maybeWarTick(db, ctx) {
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
      if (!warTick(db, ctx)) break;
      any = true;
    }
    war._lastTick = now;
    return any;
  }

  const api = {
    // constants other modules need
    CELL, COMBAT_RANGE, CAPTURE_RANGE, DEF_MOVE_SPEED, PLAYER_HOLD_TICKS,
    ROAD_SPEED_MULT, MAX_TICKS_PER_CALL, MAX_MANUAL_PATH_POINTS, WORLD_BORDER_INSET,
    BOMB_RADIUS, BOMB_UNIT_DMG, AIRSTRIKE_PRUNE_TICKS,
    // helpers
    isLive, dist, clamp, round1, mulberry32, tickRng,
    // geometry
    parseShape, polygonOf, pointInPolygon, provinceAt,
    // grid / pathing / world bounds
    buildGrid, cellKey, randomProvincePoint, worldBounds, clampToWorld,
    transportFingerprint, getTransportGraph, computePath, setDest, setManualPath, clearDest,
    // sim
    pushEvent, killUnit, pruneCorpses, applyOrders, warTick, maybeWarTick
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.WarEngine = api;
})(typeof self !== 'undefined' ? self : this);
