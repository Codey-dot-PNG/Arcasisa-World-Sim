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
  const TOTAL_VICTORY_PCT = 97;       // per-province control % the attacker needs in EVERY province for total conquest (Phase 22)
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
  const SUPPLY_HEAL_FRAC = 0.004;     // fraction of maxStrength healed per tick for a unit reached by its side's supply flood-fill
  const GARRISON_ROUT_ORG = 5;        // org threshold below which even a dug-in GARRISON routs (non-garrison defenders/attackers still use ROUT_ORG)

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
  // Same point-in-polygon lookup over settings.map.countries — foreign
  // nations' home soil (Phase 22: total war). Reuses cachedPolygonOf since
  // country entries carry the same `shape` SVG-path field provinces do.
  function countryAt(countries, pt) {
    if (!pt || !Array.isArray(countries)) return null;
    for (const c of countries) {
      const poly = cachedPolygonOf(c);
      if (poly && poly.length && pointInPolygon(pt, poly)) return c.id;
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
    const provinceKeys = new Set();
    for (let cx = 0; cx < cols; cx++) {
      for (let cy = 0; cy < rows; cy++) {
        const centerX = (cx + 0.5) * CELL, centerY = (cy + 0.5) * CELL;
        const pid = provinceAt(db.provinces, [centerX, centerY]);
        if (!pid) continue;
        provinceLandCells[pid] = (provinceLandCells[pid] || 0) + 1;
        (provinceCells[pid] = provinceCells[pid] || []).push([cx, cy]);
        provinceKeys.add(cellKey(cx, cy));
        totalLandCells++;
      }
    }
    // Foreign-nation homelands (Phase 22: total war) — the same cell
    // rasterisation over settings.map.countries, so defenders can capture
    // attacker home soil and movement can refuse closed neutral borders.
    // Province membership wins any polygon overlap (the Republic's own land
    // is never someone's homeland).
    const countries = ((db.settings || {}).map || {}).countries || [];
    const countryLandCells = {};
    const countryCells = {};
    if (countries.length) {
      for (let cx = 0; cx < cols; cx++) {
        for (let cy = 0; cy < rows; cy++) {
          if (provinceKeys.has(cellKey(cx, cy))) continue;
          const cid = countryAt(countries, [(cx + 0.5) * CELL, (cy + 0.5) * CELL]);
          if (!cid) continue;
          countryLandCells[cid] = (countryLandCells[cid] || 0) + 1;
          (countryCells[cid] = countryCells[cid] || []).push([cx, cy]);
        }
      }
    }
    return { cell: CELL, cols, rows, provinceLandCells, provinceCells, totalLandCells, countryLandCells, countryCells };
  }

  // ---------- war zones: whose soil is whose (Phase 22: total war) ----------
  // Derived, cheap, and re-derived deterministically on BOTH sides whenever
  // the belligerent set changes (joinWar): grid.enemyCells maps a cell key to
  // the ATT-side homeland country that owns it (defender units may capture
  // these), grid.neutralCells to a non-belligerent country (no unit may enter
  // — borders are closed). Entities link to a map country by explicit
  // e.countryId when set, else by normalised name match.
  function countryIdForEntity(db, entityId) {
    const e = (db.entities || []).find(x => x.id === entityId);
    if (!e) return null;
    if (e.countryId) return e.countryId;
    const countries = ((db.settings || {}).map || {}).countries || [];
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const hit = countries.find(c => norm(c.name) === norm(e.name) || norm(c.id) === norm(e.name));
    return hit ? hit.id : null;
  }
  function belligerentKey(db, war) {
    const attIds = [war.attackerId].concat((war.allies && war.allies.att) || []);
    const defIds = ((war.allies && war.allies.def) || []).slice();
    const attC = attIds.map(id => countryIdForEntity(db, id)).filter(Boolean).sort();
    const defC = defIds.map(id => countryIdForEntity(db, id)).filter(Boolean).sort();
    return attC.join('+') + '|' + defC.join('+');
  }
  function refreshWarZones(db, war) {
    const grid = war.grid;
    if (!grid || !grid.countryCells) return;
    const key = belligerentKey(db, war);
    if (war._zonesKey === key && grid.neutralCells && grid.enemyCells) return;
    war._zonesKey = key;
    const parts = key.split('|');
    const attSet = new Set(parts[0] ? parts[0].split('+') : []);
    const defSet = new Set(parts[1] ? parts[1].split('+') : []);
    grid.neutralCells = {};
    grid.enemyCells = {};
    for (const cid in grid.countryCells) {
      const enemy = attSet.has(cid);
      const friendly = enemy || defSet.has(cid); // a def-ally homeland is open ground, just not capturable
      for (const cell of grid.countryCells[cid]) {
        const k = cellKey(cell[0], cell[1]);
        if (enemy) grid.enemyCells[k] = cid;
        else if (!friendly) grid.neutralCells[k] = cid;
      }
    }
  }
  // The neutral country a position is standing in, or null. Sea (no polygon)
  // is always open water.
  function neutralAt(war, pos) {
    const g = war.grid;
    if (!g || !g.neutralCells) return null;
    return g.neutralCells[cellKey(Math.floor(pos[0] / g.cell), Math.floor(pos[1] / g.cell))] || null;
  }

  // ---------- equipment quality (Phase 23: weapons & fuel) ----------
  // server/war.js computes war.equip = { att: {dmg,hp,morale,speed}, def: … }
  // from each side's gun/fuel stocks before every authoritative tick; the
  // engine only CONSUMES the stored multipliers. A predicting client (which
  // cannot see inventories — filterState strips them) replays combat
  // identically from the multipliers carried in war state.
  function equipMul(war, side, stat) {
    const e = war.equip && war.equip[side];
    const v = e && Number(e[stat]);
    return (Number.isFinite(v) && v > 0) ? v : 1;
  }
  // Per-unit kit (Phase 26): every unit carries its OWN inventory (u.inv —
  // guns and fuel rows), and the authority folds THAT into u.kit before each
  // real tick (server/war.js resupplyUnits). A unit fights with what's in its
  // packs, not with the national average: a fresh column with rifles for
  // every soldier outfights a cut-off pocket that ran dry ticks ago. The
  // engine only consumes the stored multipliers, so a predicting client
  // (which cannot see stockpiles) replays combat identically from the kit
  // carried in war state. Units predating kits (legacy doc) fall back to the
  // side-wide war.equip multiplier, then 1×.
  function unitMul(war, u, stat) {
    const k = u && u.kit;
    const v = k && Number(k[stat]);
    if (Number.isFinite(v) && v > 0) return v;
    return equipMul(war, u ? u.side : 'att', stat);
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
    u.attackId = null; // a plain move order cancels any in-progress chase (Feature: explicit attack orders)
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
    u.attackId = null; // a hand-drawn path also cancels any in-progress chase
  }
  function clearDest(u) {
    u.dest = null; u.path = null; u.pathIdx = 0; u.manualPath = false; u.attackId = null;
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
    // Fuel carried by THIS unit scales its mobility (Phase 26) — one choke
    // point covers every movement mode: paths, straight lines, chases,
    // retreats, sailing.
    const step = Math.min(speed * unitMul(war, u, 'speed'), d);
    let next = clampToWorld(war, [u.pos[0] + dx / d * step, u.pos[1] + dy / d * step]);
    // Closed neutral borders (Phase 22): a step that would land on a
    // non-belligerent nation's soil is refused. Greedy wall-follow instead:
    // try ±45°/±90°/±135° in a FIXED order (determinism — client prediction
    // replays this) and take the first open step; fully boxed in → hold this
    // tick. A unit somehow ALREADY inside neutral ground (legacy doc, GM
    // spawn) is allowed to move freely so it can walk out rather than freeze.
    if (neutralAt(war, next) && !neutralAt(war, u.pos)) {
      const base = Math.atan2(dy, dx);
      let moved = false;
      for (const dAng of [Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI * 0.75, -Math.PI * 0.75]) {
        const cand = clampToWorld(war, [u.pos[0] + Math.cos(base + dAng) * step, u.pos[1] + Math.sin(base + dAng) * step]);
        if (!neutralAt(war, cand)) { next = cand; moved = true; break; }
      }
      if (!moved) return;
    }
    u.pos = next;
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
    else if (war.totalWar) war.ai.phase = 'total';
    else war.ai.phase = war.ai.phase === 'consolidate' ? 'consolidate' : (war.objectives.every(o => o.status === 'done') ? 'exploit' : 'breakout');
    if (war.ai.phase !== wasPhase) note(war, `Phase change: ${wasPhase} → ${war.ai.phase}`);

    // Total war (Phase 22): objectives are history — hunt down every
    // remaining defender, then sweep whatever ground is still uncontrolled.
    // Chase orders reuse stepChase; the sweep reuses randomProvincePoint on
    // the LEAST-controlled province, so the drive converges on 100%.
    if (war.ai.phase === 'total') {
      const defsLive = war.units.filter(x => x.side === 'def' && isLive(x));
      let sweepPid = null;
      if (!defsLive.length) {
        const ctl = war.stats.provinceControl || {};
        let low = 101;
        for (const pid in war.grid.provinceLandCells) {
          const c = ctl[pid] || 0;
          if (c < TOTAL_VICTORY_PCT && c < low) { low = c; sweepPid = pid; }
        }
      }
      let hunting = 0, sweeping = 0;
      for (const u of war.units) {
        if (u.side !== 'att' || !isLive(u) || u.state === 'routed' || u.state === 'embarked') continue;
        if (u.orderedBy === 'player' && (u.playerHoldUntil || 0) > war.tick) continue;
        if (defsLive.length) {
          let nearest = defsLive[0], nd = dist(u.pos, nearest.pos);
          for (const d of defsLive) { const dd = dist(u.pos, d.pos); if (dd < nd) { nd = dd; nearest = d; } }
          clearDest(u);
          u.attackId = nearest.id;
          u.objectiveId = null;
          if (u.state !== 'fighting') u.state = 'moving';
          hunting++;
        } else if (sweepPid) {
          u.attackId = null;
          setDest(db, u, randomProvincePoint(war, sweepPid, rng) || u.pos.slice(), u.speed);
          sweeping++;
        }
      }
      if (defsLive.length) note(war, `Total war: ${hunting} unit(s) hunting the ${defsLive.length} defending formation(s) still in the field.`);
      else if (sweepPid) note(war, `Total war: ${sweeping} unit(s) sweeping the last uncontrolled ground.`);
      return;
    }

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
  // ---------- explicit attack (chase) orders ----------
  // Straight-line chase toward a specific enemy unit rather than a fixed
  // point. No per-tick Dijkstra re-plan toward the target's CURRENT position
  // — that would mean a full path recompute every tick for every chasing
  // unit, far more expensive than the transport graph's "compute once at
  // order time" cost; an accepted rough edge, same spirit as the road-cut
  // note above stepAlongPath. Called from stepMovement BEFORE the normal
  // dest-handling for both the attacker and defender branches, but only
  // reached for units that are live and past the embarked/routed `continue`s
  // in each branch, so a chasing unit that dies, embarks, or routs falls out
  // of this automatically. Returns true when the chase drove this unit's
  // movement for the tick (caller should skip normal dest handling); false
  // when there was no attackId, or the target is gone (in which case the
  // unit is dropped back to 'holding' and normal dest handling — which will
  // find no dest either — takes over).
  function stepChase(war, u) {
    if (!u.attackId) return false;
    if (u.state === 'routed') return false; // a broken unit ignores its attack order until it rallies (the order survives on the unit)
    const target = war.units.find(x => x.id === u.attackId);
    if (!target || !isLive(target)) { u.attackId = null; u.state = 'holding'; return false; }
    // Same collision rule as normal dest movement: ANY live enemy inside
    // COLLIDE_ENEMY stops the advance and starts the fight — otherwise a
    // chase could walk straight through a different enemy standing between
    // the unit and its ordered target.
    const near = nearestLiveEnemy(war, u);
    if (near.unit && near.dist <= COLLIDE_ENEMY) { u.state = 'fighting'; return true; }
    if (dist(u.pos, target.pos) <= COLLIDE_ENEMY) { u.state = 'fighting'; }
    else { advanceToward(war, u, target.pos, u.speed || DEF_MOVE_SPEED); u.state = 'moving'; }
    return true;
  }
  function stepMovement(db, war, ctx, rng) {
    for (const u of war.units) {
      if (!isLive(u)) continue;
      if (u.side === 'def') {
        // Routed defenders retreat, recover and rally exactly like routed
        // attackers do below — without this, a morale-broken garrison (now
        // possible via GARRISON_ROUT_ORG) would stand frozen in the line,
        // still soaking and dealing damage, and never regain organisation
        // (the attacker-side org regen in stepCombat doesn't cover it).
        if (u.state === 'routed') {
          const near = nearestLiveEnemy(war, u);
          if (near.unit) {
            const dx = u.pos[0] - near.unit.pos[0], dy = u.pos[1] - near.unit.pos[1];
            const m = Math.hypot(dx, dy) || 1;
            // Garrisons spawn speed 0 — a broken one still scatters at the
            // ordered-defender pace rather than standing in the fire.
            advanceToward(war, u, [u.pos[0] + dx / m * 100, u.pos[1] + dy / m * 100], (u.speed || DEF_MOVE_SPEED) * 0.8);
          }
          u.org = clamp(u.org + ORG_REGEN * 1.5, 0, 100);
          if (u.org >= RALLY_ORG) { u.state = 'holding'; note(war, `${u.name} rallies (org ${Math.round(u.org)}).`); }
          continue;
        }
        if (stepChase(war, u)) continue;
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
      if (stepChase(war, u)) continue;
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
    const engagedDefs = new Set(); // defenders an attacker actually fought this tick — the rest stand down below
    for (const a of atts) {
      let nearest = null, nd = Infinity;
      for (const d of defs) { const dd = dist(a.pos, d.pos); if (dd < nd) { nd = dd; nearest = d; } }
      if (!nearest || nd > COMBAT_RANGE) { if (a.state !== 'routed') a.state = a.dest ? 'moving' : 'holding'; continue; }
      const d = nearest;
      anyFight = true;
      a.state = 'fighting'; if (d.state !== 'routed') d.state = 'fighting';
      const defStationary = d.garrison && !d.dest;
      const defBonus = defStationary ? 1.35 : 1;
      // Equipment (Phase 26, per-unit): the guns THIS unit carries raise the
      // damage it deals; the victim's own kit absorbs some of what lands
      // (hp); better small arms also slow morale drain (a unit that can
      // shoot back holds longer).
      const dmgToDef = K_COMBAT * a.strength * (0.7 + 0.6 * rng()) * (a.atk || 1) * dmgMod * unitMul(war, a, 'dmg') / unitMul(war, d, 'hp');
      const dmgToAtt = K_COMBAT * d.strength * (0.7 + 0.6 * rng()) * defBonus * dmgMod * unitMul(war, d, 'dmg') / unitMul(war, a, 'hp');
      d.strength = Math.max(0, round1(d.strength - dmgToDef));
      a.strength = Math.max(0, round1(a.strength - dmgToAtt));
      war.stats.defLosses += dmgToDef; war.stats.attLosses += dmgToAtt;
      a.org = clamp(a.org - ORG_DRAIN / unitMul(war, a, 'morale'), 0, 100);
      d.org = clamp(d.org - ORG_DRAIN * 0.7 / unitMul(war, d, 'morale'), 0, 100);
      if (a.org < ROUT_ORG && a.state !== 'routed') { a.state = 'routed'; pushEvent(war, 'battle', a.pos.slice(), `${a.name} breaks and routs.`); }
      // Garrisons used to never rout (dug in = infinitely stubborn); now a
      // garrison's morale can still fully collapse, just at a much lower
      // threshold (GARRISON_ROUT_ORG) than a field unit's ROUT_ORG — a
      // garrison keeps fighting well past the point a mobile unit would break,
      // but total organisational collapse still routs it.
      const dRoutOrg = d.garrison ? GARRISON_ROUT_ORG : ROUT_ORG;
      if (d.org < dRoutOrg && d.state !== 'routed') { d.state = 'routed'; pushEvent(war, 'battle', d.pos.slice(), `${d.name} breaks and routs.`); }
      if (a.strength <= 0) killUnit(war, a);
      if (d.strength <= 0) killUnit(war, d);
      engagedDefs.add(d.id);
    }
    // Defenders whose state says 'fighting' but who had no attacker in range
    // this tick stand down. Attackers get the same reset inline in the loop
    // above (the `nd > COMBAT_RANGE` branch), but nothing ever visited a
    // dest-less defender after its attacker died/left — it stayed 'fighting'
    // forever, which since Phase 20 also silently blocked its supply healing
    // (stepSupply skips units in 'fighting').
    for (const d of defs) {
      if (isLive(d) && d.state === 'fighting' && !engagedDefs.has(d.id)) d.state = d.dest ? 'moving' : 'holding';
    }
    pruneCorpses(war);
    if (!anyFight) {
      // Both sides recover morale while the whole front is quiet — the regen
      // used to be attacker-only, which left a garrison that had fought
      // parked at low org forever (and, with garrison routs now possible,
      // one org-drain away from breaking on the next engagement).
      for (const u of war.units) if (isLive(u) && u.state !== 'routed') u.org = clamp(u.org + ORG_REGEN, 0, 100);
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
          if (u.side === 'def') {
            // liberate captured Republic ground…
            const held = war.cells[key];
            if (held && held.o === 'att') { delete war.cells[key]; continue; }
            // …and OCCUPY attacker home soil (Phase 22: the defence can
            // invade too — enemyCells maps att-side homeland cells).
            if (!held && war.grid.enemyCells && war.grid.enemyCells[key]) {
              war.cells[key] = { o: 'def', c: war.grid.enemyCells[key] };
            }
            continue;
          }
          const existing = war.cells[key];
          if (existing && existing.o === 'att') continue;
          if (existing && existing.o === 'def') { delete war.cells[key]; continue; } // attacker retakes its homeland
          const pid = provinceAt(db.provinces, [centerX, centerY]);
          if (!pid) continue;
          war.cells[key] = { o: 'att', p: 1, pid };
        }
      }
    }
  }

  // ---------- supply corridors + resupply healing ----------
  // Fixed 8-neighbour offset order — BFS visits neighbours in this exact
  // order every time, which combined with the deterministic seed set below
  // (built by iterating war.cells, an insertion-ordered object — the same
  // guarantee stepTerritory/recomputeProvinceControl already lean on) makes
  // the flood fill itself deterministic even though it never needs to be
  // replayed bit-for-bit (only membership in the resulting set matters).
  const SUPPLY_NEIGHBOR_OFFSETS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  // Generic array-queue BFS: `seeds` (cell-key strings) are ALWAYS included in
  // the result regardless of `held(key)`; expansion to a neighbour requires
  // held(neighbourKey) to be true. Shared by both sides below.
  function floodFillCells(seeds, held) {
    const visited = new Set();
    const queue = [];
    for (const key of seeds) { if (!visited.has(key)) { visited.add(key); queue.push(key); } }
    let qi = 0;
    while (qi < queue.length) {
      const key = queue[qi++];
      const comma = key.indexOf(',');
      const cx = Number(key.slice(0, comma)), cy = Number(key.slice(comma + 1));
      for (const off of SUPPLY_NEIGHBOR_OFFSETS) {
        const nkey = cellKey(cx + off[0], cy + off[1]);
        if (visited.has(nkey)) continue;
        if (!held(nkey)) continue;
        visited.add(nkey);
        queue.push(nkey);
      }
    }
    return visited;
  }
  // war.supplyAnchor is minted once at startWar (landing objective's pos for
  // a naval scenario, staging-box centre for land:true — see server/war.js).
  // Falls back to a live `landing` objective's pos for a war doc that predates
  // this field; returns null (caller then treats every attacker unit as
  // supplied) only for a legacy doc with neither.
  function attackerSupplyAnchorCell(war) {
    let anchor = war.supplyAnchor;
    if (!anchor) {
      const landingObj = (war.objectives || []).find(o => o.kind === 'landing');
      anchor = landingObj ? landingObj.pos : null;
    }
    if (!anchor) return null;
    const cs = war.grid.cell;
    return [Math.floor(anchor[0] / cs), Math.floor(anchor[1] / cs)];
  }
  function stepSupply(db, war) {
    const cs = war.grid.cell;

    // Attacker: seed with the anchor cell itself plus every att-held cell
    // within 2 cells (Chebyshev) of it, flood-fill outward staying on
    // attacker-held ground. "Held" for SUPPLY purposes (Phase 26 fix) means
    // captured Republic cells AND the attacker's own homeland
    // (grid.enemyCells) wherever the defence hasn't planted its flag — a
    // land-border invasion anchors its supply in the homeland itself, which
    // lives in neither war.cells nor the old predicate, so the fill started
    // EMPTY and every attacker read permanently CUT OFF. Seeding the anchor
    // unconditionally also covers the first ticks of a naval landing before
    // any beach cell is formally captured.
    let attSupply = null;
    const anchorCell = attackerSupplyAnchorCell(war);
    if (anchorCell) {
      const attHeld = (k) => {
        const c = war.cells[k];
        if (c) return c.o === 'att';
        return !!(war.grid.enemyCells && war.grid.enemyCells[k]);
      };
      const seeds = [cellKey(anchorCell[0], anchorCell[1])];
      for (const key in war.cells) {
        const c = war.cells[key];
        if (c.o !== 'att') continue;
        const comma = key.indexOf(',');
        const cx = Number(key.slice(0, comma)), cy = Number(key.slice(comma + 1));
        if (Math.max(Math.abs(cx - anchorCell[0]), Math.abs(cy - anchorCell[1])) <= 2) seeds.push(key);
      }
      attSupply = floodFillCells(seeds, attHeld);
    }

    // Defender: every LAND cell (built fresh each call — a few thousand
    // entries, cheap relative to the rest of a tick, see docs/WAR.md) minus
    // whatever the attacker currently holds is "defender-controlled land";
    // flood-fill that from the capital's cell so a cut-off pocket beyond
    // attacker-held ground reads as unsupplied even though no unit sits on it.
    let defSupply = null;
    const capital = (db.cities || []).find(c => c.isCapital && c.pos) || (db.cities || []).find(c => c.pos);
    if (capital && war.grid && war.grid.provinceCells) {
      const landCells = new Set();
      for (const pid in war.grid.provinceCells) {
        for (const cell of war.grid.provinceCells[pid]) landCells.add(cellKey(cell[0], cell[1]));
      }
      // Symmetric to attHeld above (Phase 26): enemy-homeland cells the
      // defence has captured (o:'def') carry defender supply too, so an
      // invading defender column stays supplied through the ground it took.
      const defHeld = (k) => (landCells.has(k) && (!war.cells[k] || war.cells[k].o !== 'att')) ||
        (!!war.cells[k] && war.cells[k].o === 'def');
      const capCell = cellKey(Math.floor(capital.pos[0] / cs), Math.floor(capital.pos[1] / cs));
      defSupply = floodFillCells([capCell], defHeld);
    }

    // A unit counts as in-supply when its own cell OR any 8-neighbour is in
    // the supplied set — a unit standing at the coastline can sit on a cell
    // whose CENTRE falls in the sea (so it's in neither side's cell set at
    // all); without the neighbour tolerance a garrison in a harbour city
    // could read permanently cut off.
    const suppliedNear = (set, cx, cy) => {
      if (set.has(cellKey(cx, cy))) return true;
      for (const off of SUPPLY_NEIGHBOR_OFFSETS) if (set.has(cellKey(cx + off[0], cy + off[1]))) return true;
      return false;
    };
    for (const u of war.units) {
      if (!isLive(u)) continue;
      if (u.state === 'embarked') { u.supplied = true; continue; }
      const cx = Math.floor(u.pos[0] / cs), cy = Math.floor(u.pos[1] / cs);
      if (u.side === 'att') {
        // Membership in attSupply already implies att-held (seeds and every
        // expansion step require it), so no separate war.cells check needed.
        u.supplied = anchorCell ? suppliedNear(attSupply, cx, cy) : true; // legacy war doc with no anchor at all — see attackerSupplyAnchorCell
      } else {
        u.supplied = defSupply ? suppliedNear(defSupply, cx, cy) : true; // no cities at all (legacy/malformed doc) — treat as supplied
      }
      if (u.supplied && u.state !== 'fighting') {
        u.strength = round1(Math.min(u.maxStrength || u.strength, u.strength + (u.maxStrength || u.strength) * SUPPLY_HEAL_FRAC));
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
    const enemyCounts = {};
    for (const key in war.cells) {
      const c = war.cells[key];
      if (c.o === 'att' && c.pid) counts[c.pid] = (counts[c.pid] || 0) + 1;
      else if (c.o === 'def' && c.c) enemyCounts[c.c] = (enemyCounts[c.c] || 0) + 1; // defender-occupied attacker homeland (Phase 22)
    }
    const out = {};
    for (const pid in war.grid.provinceLandCells) {
      const total = war.grid.provinceLandCells[pid] || 0;
      out[pid] = total ? Math.round((counts[pid] || 0) / total * 100) : 0;
    }
    war.stats.provinceControl = out;
    // % of each ATT-side homeland the defence has overrun — additive: absent
    // for wars whose grid predates countryLandCells.
    const enemyOut = {};
    for (const cid in enemyCounts) {
      const total = (war.grid.countryLandCells || {})[cid] || 0;
      if (total) enemyOut[cid] = Math.round(enemyCounts[cid] / total * 100);
    }
    war.stats.enemyControl = enemyOut;
  }

  // Total war (Phase 22): completing the scenario objectives no longer ends
  // the war — it UNLOCKS the drive for total victory. From then on the war
  // ends only when one side completely wins: the attacker holds effectively
  // every province with no defender left standing, or the invasion force is
  // annihilated outright (the AI's collapse rule remains the other defender
  // win, unchanged — a shattered army IS a complete defeat).
  function checkVictory(db, war, ctx) {
    if (!war.active) return;
    const allDone = war.objectives.every(o => o.status === 'done');
    if (allDone && !war.totalWar) {
      war.totalWar = true;
      if (war.ai) war.ai.phase = 'total';
      const anchor = war.units.find(u => u.side === 'att' && isLive(u));
      pushEvent(war, 'milestone', anchor ? anchor.pos.slice() : [1920, 1080], 'All objectives secured — the invader now drives for total conquest.');
      ctx.log('event', 'The war enters its total phase', `${war.name}: every objective has fallen; nothing short of total victory ends this now.`, 'WAR ENGINE', [war.attackerId, war.defenderId]);
      ctx.news('NO TERMS: WAR ENTERS ITS TOTAL PHASE', 'With every strategic objective fallen, the invading command has announced it will accept nothing short of total capitulation. The war goes on.');
    }
    const attAlive = war.units.some(u => u.side === 'att' && isLive(u));
    if (!attAlive) {
      war.active = false;
      war.result = { winner: 'def', endedAt: new Date().toISOString(), reason: 'Invasion force annihilated' };
      ctx.log('event', 'The invasion is annihilated', war.name, 'WAR ENGINE', [war.attackerId, war.defenderId]);
      ctx.news('THE INVADER IS DESTROYED', 'Not one invading formation remains in the field. The war is over.');
      return;
    }
    if (war.totalWar) {
      const ctl = war.stats.provinceControl || {};
      const pids = Object.keys(war.grid.provinceLandCells || {});
      const allProvinces = pids.length > 0 && pids.every(pid => (ctl[pid] || 0) >= TOTAL_VICTORY_PCT);
      const defAlive = war.units.some(u => u.side === 'def' && isLive(u));
      if (allProvinces && !defAlive) {
        war.active = false;
        war.result = { winner: 'att', endedAt: new Date().toISOString(), reason: 'Total conquest' };
        ctx.log('event', 'Total victory for the invader', war.name, 'WAR ENGINE', [war.attackerId, war.defenderId]);
        ctx.news('THE REPUBLIC FALLS', 'The last defending formation has been destroyed and the whole of the national territory is under occupation. The Republic has ceased to exist as a fighting power.');
      }
    }
  }

  // ---------- player orders (pure — shared by the server route and optimistic client apply) ----------
  // An order carries `dest` (plain move — road/rail routing applies), `path`
  // (a player-drawn freehand polyline, ≥2 points — see setManualPath and
  // docs/WAR.md "Manual paths"), or `attackId` (chase a specific enemy unit —
  // see stepChase above). Precedence when more than one is present: path >
  // attackId > dest; in practice an order only ever carries one of the three.
  function applyOrders(db, side, orders) {
    const war = db.war;
    if (!war || !Array.isArray(orders)) return;
    for (const o of orders) {
      if (!o || !o.unitId) continue;
      const hasPath = Array.isArray(o.path) && o.path.length >= 2 &&
        o.path.every(p => Array.isArray(p) && p.length === 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])));
      const hasDest = Array.isArray(o.dest) && o.dest.length === 2 && Number.isFinite(Number(o.dest[0])) && Number.isFinite(Number(o.dest[1]));
      const hasAttack = typeof o.attackId === 'string' && o.attackId;
      if (!hasPath && !hasDest && !hasAttack) continue;
      const u = war.units.find(x => x.id === o.unitId && x.side === side);
      if (!u || !isLive(u)) continue;
      if (u.side === 'def' && !u.speed) u.speed = DEF_MOVE_SPEED;
      if (hasPath) {
        setManualPath(db, u, o.path);
      } else if (hasAttack) {
        // Target must exist, be alive, and be on the OPPOSITE side — an
        // invalid attackId drops the whole order silently (same pattern as
        // every other malformed-order case in this function).
        const target = war.units.find(x => x.id === o.attackId);
        if (!target || !isLive(target) || target.side === u.side) continue;
        clearDest(u);
        u.attackId = target.id;
        if (u.state !== 'routed') u.state = 'moving';
      } else {
        setDest(db, u, [Number(o.dest[0]), Number(o.dest[1])], u.speed);
      }
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
    // Re-derive neutral/enemy soil when the belligerent set changed (joinWar)
    // — no-op when the key matches, so this is a cheap per-tick guard that
    // keeps server and predicting client in step without extra sync plumbing.
    refreshWarZones(db, war);
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
    stepSupply(db, war);
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
    parseShape, polygonOf, pointInPolygon, provinceAt, countryAt,
    // grid / pathing / world bounds
    buildGrid, cellKey, randomProvincePoint, worldBounds, clampToWorld,
    countryIdForEntity, refreshWarZones, neutralAt, equipMul, unitMul,
    transportFingerprint, getTransportGraph, computePath, setDest, setManualPath, clearDest,
    // sim
    pushEvent, killUnit, pruneCorpses, applyOrders, warTick, maybeWarTick
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.WarEngine = api;
})(typeof self !== 'undefined' ? self : this);
