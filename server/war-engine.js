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
  // ---- AI tactical planner (Phase 28) — see runAI's role assignment ----
  const OBJ_THREAT_R = 260;           // px — defenders inside this of an objective count as its garrison when planning
  const ENCIRCLE_R = 170;             // px — how wide the pincer arms swing around a defended objective
  const GARRISON_THREAT_R = 300;      // px — a captured city with live defenders inside this needs a rear guard
  const PURSUE_R = 220;               // px — spearhead units run down broken/weak defenders inside this
  const PURSUE_WEAK_FRAC = 0.35;      // a defender below this fraction of max strength is worth finishing off
  const INTERDICT_FRAC = 0.45;        // supply-cut post sits this far from the defender capital toward the objective
  // ---- refugee columns (Phase 28) — see stepRefugees ----
  const REFUGEE_SPEED = 7;            // px/tick — a column on the roads (faster than infantry: they drop everything)
  const REFUGEE_ARRIVE_R = 30;        // px — close enough to the destination to disperse into it
  const REFUGEE_FADE_TICKS = 4;       // ticks an arrived/annihilated column lingers so the client can fade it out
  const REFUGEE_MAX = 24;             // hard cap on simultaneous columns (perf — spawner settles overflow instantly)
  const REFUGEE_CROSSFIRE_R = 70;     // px — a column this close to a FIGHTING unit takes losses
  const REFUGEE_CROSSFIRE_FRAC = 0.02;// fraction of the column killed per fighting neighbour per tick
  const K_COMBAT = 0.0035;            // per-tick strength loss ~ k × enemy strength
  const ORG_DRAIN = 3.5;              // per-tick org loss while fighting
  const ORG_REGEN = 0.6;              // per-tick org recovery while not fighting
  const ROUT_ORG = 25;                // org threshold that triggers a rout
  const RALLY_ORG = 45;               // org a routed unit needs to rejoin the line
  const ROAD_SPEED_MULT = 5;          // speed multiplier while following the road/rail transport graph
  const ROAD_JUNCTION_RANGE = 50;     // px — nodes from different polylines within this range are linked
  const ROAD_PROXIMITY_MULT = 1.6;    // speed bonus for ANY movement whose cell is near a road/rail (grid.roadCells) — distinct from the 5× on-network follow bonus
  const ROAD_PROXIMITY_CELLS = 1;     // Chebyshev radius (in grid cells) around a road/rail point that counts as "near a road"
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
  const WARSHIP_RANGE = 180;          // px — warships engage in a separate RANGED pass at this reach, instead of the 40px collision range
  const WARSHIP_TRANSPORT_BONUS = 3;  // dmg multiplier a warship deals to a 'transport'-state unit or a 'boat' — warships hunt transports
  // Naval-only unit kinds (Transport ships & Boats feature): these never fight
  // via the normal 40px collision pass and refuse to advance onto land cells
  // (advanceToward below), mirroring how neutralCells are refused.
  const NAVAL_KINDS = { boat: true, warship: true };

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
    // Merged land lookup (Transport ships & Boats / Warships feature): every
    // land cell, Republic province OR foreign homeland, in one flat set keyed
    // by cellKey — a cheap O(1) "is this cell land or sea" test the engine
    // can run every tick for every unit without touching db/point-in-polygon
    // (which needs `db`, not just `war`). Built once here alongside the rest
    // of the grid so it's part of war state and replays identically on a
    // predicting client.
    const landCells = {};
    for (const pid in provinceCells) for (const cell of provinceCells[pid]) landCells[cellKey(cell[0], cell[1])] = true;
    for (const cid in countryCells) for (const cell of countryCells[cid]) landCells[cellKey(cell[0], cell[1])] = true;
    // Road/rail proximity (feature: "near a road speeds units up"): every cell
    // within ROAD_PROXIMITY_CELLS of a road/rail polyline point. Distinct from
    // the transport GRAPH (which gives the 5× on-network follow bonus): this is
    // a cheap flat "am I near a road" flag any movement mode can read in O(1),
    // so a unit crossing near a road at all moves faster even if it isn't
    // formally following the network. Part of war state, so it replays on a
    // predicting client identically.
    const roadCells = {};
    const map = (db.settings || {}).map || {};
    const lines = [].concat(map.roads || [], map.rails || []);
    for (const line of lines) {
      const pts = (line && line.pts) || [];
      if (!Array.isArray(pts)) continue;
      for (const pt of pts) {
        if (!pt || pt.length < 2) continue;
        const bx = Math.floor(pt[0] / CELL), by = Math.floor(pt[1] / CELL);
        for (let dx = -ROAD_PROXIMITY_CELLS; dx <= ROAD_PROXIMITY_CELLS; dx++)
          for (let dy = -ROAD_PROXIMITY_CELLS; dy <= ROAD_PROXIMITY_CELLS; dy++)
            roadCells[cellKey(bx + dx, by + dy)] = true;
      }
    }
    return { cell: CELL, cols, rows, provinceLandCells, provinceCells, totalLandCells, countryLandCells, countryCells, landCells, roadCells };
  }
  // Water test used by transport-state transitions (land units over water)
  // and naval movement (boats/warships refusing land) — a legacy war.grid
  // without landCells (pre-feature doc) reads as "no restriction" (false),
  // same permissive-default spirit as neutralAt.
  function isWaterAt(war, pos) {
    const g = war && war.grid;
    if (!g || !g.landCells) return false;
    const cs = g.cell;
    return !g.landCells[cellKey(Math.floor(pos[0] / cs), Math.floor(pos[1] / cs))];
  }
  // Speed multiplier from road/rail proximity (grid.roadCells). Legacy war docs
  // (no roadCells) read as no bonus (1×), same permissive default as isWaterAt.
  function roadProximityMul(war, pos) {
    const g = war && war.grid;
    if (!g || !g.roadCells) return 1;
    const cs = g.cell;
    return g.roadCells[cellKey(Math.floor(pos[0] / cs), Math.floor(pos[1] / cs))] ? ROAD_PROXIMITY_MULT : 1;
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
  // EVERY map country an entity owns — its homeland plus any ceded_* pieces
  // minted by a peace treaty (cedeProvince stamps entityId on those). The
  // singular countryIdForEntity above returns only the first match, which
  // made a belligerent's ceded territory read as NEUTRAL closed-border soil
  // in refreshWarZones — units staged there froze against their own ground.
  function countryIdsForEntity(db, entityId) {
    const e = (db.entities || []).find(x => x.id === entityId);
    if (!e) return [];
    const countries = ((db.settings || {}).map || {}).countries || [];
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const out = [];
    for (const c of countries) {
      if ((e.countryId && c.id === e.countryId) || c.entityId === e.id ||
          norm(c.name) === norm(e.name) || norm(c.id) === norm(e.name)) out.push(c.id);
    }
    return out;
  }
  function belligerentKey(db, war) {
    const attIds = [war.attackerId].concat((war.allies && war.allies.att) || []);
    const defIds = ((war.allies && war.allies.def) || []).slice();
    const collect = (ids) => {
      const s = [];
      for (const id of ids) for (const c of countryIdsForEntity(db, id)) if (s.indexOf(c) < 0) s.push(c);
      return s.sort();
    };
    return collect(attIds).join('+') + '|' + collect(defIds).join('+');
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
  // Neutral-territory hardening: the nearest non-neutral cell CENTRE to `pos`,
  // used to clamp player orders (setDest/setManualPath) and path termini
  // (computePath) away from closed borders BEFORE movement ever starts —
  // advanceToward's wall-follow only stops a unit that's already mid-step
  // into neutral soil; this stops an order from ever aiming one there in the
  // first place. Deterministic ring search (dx outer, dy inner, ring radius
  // ascending) so server and a predicting client agree on the exact same
  // substitute point. A position that isn't neutral is returned unchanged; a
  // war with no grid/neutralCells at all (legacy doc, pre-belligerent-set)
  // is permissive, same spirit as neutralAt above.
  function nearestNonNeutralPoint(war, pos) {
    const g = war && war.grid;
    if (!g || !neutralAt(war, pos)) return pos;
    const cs = g.cell;
    const cx0 = Math.floor(pos[0] / cs), cy0 = Math.floor(pos[1] / cs);
    for (let r = 1; r <= 60; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only — interior already checked at smaller r
          const cx = cx0 + dx, cy = cy0 + dy;
          if (cx < 0 || cy < 0 || cx >= g.cols || cy >= g.rows) continue;
          const key = cellKey(cx, cy);
          if (g.neutralCells && g.neutralCells[key]) continue;
          return clampToWorld(war, [(cx + 0.5) * cs, (cy + 0.5) * cs]);
        }
      }
    }
    return pos; // fully boxed in by neutral soil out to the search radius — give up rather than loop forever
  }
  // The nearest WATER cell centre to `pos` — the naval counterpart of
  // nearestNonNeutralPoint. Used to clamp a naval unit's ORDER so a warship/boat
  // can never be aimed onto land in the first place (advanceToward's land-refusal
  // only stops a unit mid-step; this stops the dest from ever sitting inland).
  // Same deterministic ring search; a pos already on water is returned as-is; a
  // legacy war with no landCells is permissive.
  function nearestWaterPoint(war, pos) {
    // Prefer the fine naval grid (exact polygon coastlines — see
    // ensureNavalGrid below) when it has been built; the coarse war.grid is
    // the legacy fallback. Ring radius scales so both cover the same ~3840px.
    const fg = _navalCache.grid;
    const g = fg || (war && war.grid);
    if (!g) return pos;
    const landMap = fg ? fg.land : g.landCells;
    if (!landMap) return pos;
    const cs = g.cell;
    if (!landMap[cellKey(Math.floor(pos[0] / cs), Math.floor(pos[1] / cs))]) return pos; // already water
    const maxR = Math.ceil(3840 / cs);
    const cx0 = Math.floor(pos[0] / cs), cy0 = Math.floor(pos[1] / cs);
    for (let r = 1; r <= maxR; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const cx = cx0 + dx, cy = cy0 + dy;
          if (cx < 0 || cy < 0 || cx >= g.cols || cy >= g.rows) continue;
          if (landMap[cellKey(cx, cy)]) continue; // want water
          return clampToWorld(war, [(cx + 0.5) * cs, (cy + 0.5) * cs]);
        }
      }
    }
    return pos;
  }
  // ---------- fine naval grid (feature: exact coastlines for ships) ----------
  // The 48px war grid marks a whole cell land/water from its CENTRE, which let
  // ships clip real coastline slivers (a half-covered coastal cell reads as
  // open water). Naval movement instead rasterises its OWN finer grid straight
  // from the authoritative border polygons — every province shape plus every
  // country shape, the same "perfectly on point" borders the map renders — so
  // the coastline ships respect IS the drawn coastline. A fine cell is water
  // only if its centre AND four inset corners all fall outside every land
  // polygon (conservative: partial coverage counts as land). Cached at module
  // level keyed on a cheap shape fingerprint; the content is a pure function
  // of the world's polygons, so server and predicting client derive the exact
  // same grid independently (nothing extra is synced). Legacy fallbacks: when
  // no polygons are loadable the coarse war.grid keeps working as before.
  const NAVAL_CELL = 24;
  let _navalCache = { key: '', grid: null };
  function navalFingerprint(db) {
    const provs = (db && db.provinces) || [];
    const countries = (((db || {}).settings || {}).map || {}).countries || [];
    let len = 0;
    for (const p of provs) len += String(p.shape || '').length;
    for (const c of countries) len += String(c.shape || '').length;
    return provs.length + ':' + countries.length + ':' + len;
  }
  // Every land polygon in the world (province + country subpaths), with
  // bounding boxes so point tests can reject cheaply.
  function collectLandPolys(db) {
    const out = [];
    const push = (shape) => {
      let polys;
      try { polys = parseShape(shape); } catch (e) { return; }
      for (const poly of polys || []) {
        if (!poly || poly.length < 3) continue;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of poly) {
          if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
          if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
        }
        out.push({ poly, x0, y0, x1, y1 });
      }
    };
    for (const p of ((db && db.provinces) || [])) if (p.shape) push(p.shape);
    for (const c of ((((db || {}).settings || {}).map || {}).countries || [])) if (c.shape) push(c.shape);
    return out;
  }
  function polyLandAt(polys, x, y) {
    for (const e of polys) {
      if (x < e.x0 || x > e.x1 || y < e.y0 || y > e.y1) continue;
      if (pointInPolygon([x, y], e.poly)) return true;
    }
    return false;
  }
  function ensureNavalGrid(db) {
    if (!db) return _navalCache.grid;
    const key = navalFingerprint(db);
    if (_navalCache.key === key) return _navalCache.grid;
    const polys = collectLandPolys(db);
    if (!polys.length) { _navalCache = { key, grid: null }; return null; }
    const cols = Math.ceil(3840 / NAVAL_CELL), rows = Math.ceil(2160 / NAVAL_CELL);
    const land = {};
    const inset = NAVAL_CELL * 0.25;
    for (let cx = 0; cx < cols; cx++) {
      for (let cy = 0; cy < rows; cy++) {
        const x = cx * NAVAL_CELL, y = cy * NAVAL_CELL;
        if (polyLandAt(polys, x + NAVAL_CELL / 2, y + NAVAL_CELL / 2)
          || polyLandAt(polys, x + inset, y + inset)
          || polyLandAt(polys, x + NAVAL_CELL - inset, y + inset)
          || polyLandAt(polys, x + inset, y + NAVAL_CELL - inset)
          || polyLandAt(polys, x + NAVAL_CELL - inset, y + NAVAL_CELL - inset)) {
          land[cellKey(cx, cy)] = true;
        }
      }
    }
    _navalCache = { key, grid: { cell: NAVAL_CELL, cols, rows, land, polys } };
    return _navalCache.grid;
  }
  // Water test at NAVAL fidelity — the fine grid when built (warTick and every
  // order path build it), else the coarse war.grid as legacy fallback. This is
  // what advanceToward's naval land-refusal and the path string-pulling use,
  // so even a straight-line fallback sail can no longer cross a real coastline.
  function navalWaterAt(war, pos) {
    const fg = _navalCache.grid;
    if (fg) return !fg.land[cellKey(Math.floor(pos[0] / fg.cell), Math.floor(pos[1] / fg.cell))];
    return isWaterAt(war, pos);
  }

  // ---------- naval pathfinding (feature: warships follow the coast) ----------
  // A* over WATER cells of the fine naval grid (coarse war.grid when polygons
  // are unavailable), so an ordered boat/warship sails AROUND land instead of
  // aiming a straight line through it. Fully deterministic — fixed neighbour
  // order, binary heap ordered by (f, cell index) — because the predicting
  // client replays orders through this exact function (both war-engine.js
  // copies stay byte-identical). Diagonal steps never cut a land corner (both
  // orthogonal neighbours must be water). Returns a SIMPLIFIED waypoint list
  // (greedy water-only line-of-sight string-pulling, sampled at 6px against
  // the SAME fidelity used for search) ending exactly on `to`, or null when no
  // all-water route exists / the trip stays in one cell — callers then fall
  // back to the straight-line move, where advanceToward's land-refusal (also
  // fine-grid-backed now) still applies as the last line of defence.
  function heapLess(a, b) { return a[0] < b[0] - 1e-9 || (a[0] - b[0] <= 1e-9 && a[1] < b[1]); }
  function heapPush(h, node) {
    h.push(node);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapLess(h[i], h[p])) { const t = h[i]; h[i] = h[p]; h[p] = t; i = p; } else break;
    }
  }
  function heapPop(h) {
    const top = h[0];
    const last = h.pop();
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && heapLess(h[l], h[m])) m = l;
        if (r < h.length && heapLess(h[r], h[m])) m = r;
        if (m === i) break;
        const t = h[i]; h[i] = h[m]; h[m] = t; i = m;
      }
    }
    return top;
  }
  function navalPath(db, war, from, to) {
    const fg = ensureNavalGrid(db);
    const g = war && war.grid;
    if (!fg && (!g || !g.landCells)) return null;
    const cs = fg ? fg.cell : g.cell;
    const cols = fg ? fg.cols : g.cols, rows = fg ? fg.rows : g.rows;
    const landMap = fg ? fg.land : g.landCells;
    const water = (cx, cy) => cx >= 0 && cy >= 0 && cx < cols && cy < rows && !landMap[cellKey(cx, cy)];
    let sx = Math.floor(from[0] / cs), sy = Math.floor(from[1] / cs);
    const tx = Math.floor(to[0] / cs), ty = Math.floor(to[1] / cs);
    if (!water(tx, ty)) return null;
    if (!water(sx, sy)) {
      // beached start (legacy doc, GM spawn) — route from the nearest water
      // cell; advanceToward already lets an on-land naval unit move freely, so
      // it can crawl to the path's first waypoint.
      const maxR = Math.ceil(480 / cs);
      let found = null;
      for (let r = 1; r <= maxR && !found; r++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          for (let dy = -r; dy <= r && !found; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            if (water(sx + dx, sy + dy)) found = [sx + dx, sy + dy];
          }
        }
      }
      if (!found) return null;
      sx = found[0]; sy = found[1];
    }
    if (sx === tx && sy === ty) return null; // same cell — the straight sail is fine
    const idxOf = (cx, cy) => cy * cols + cx;
    const startIdx = idxOf(sx, sy), goalIdx = idxOf(tx, ty);
    // octile-distance heuristic in cell units (admissible for the 1/√2 costs)
    const hOf = (cx, cy) => {
      const dx = Math.abs(cx - tx), dy = Math.abs(cy - ty);
      return Math.max(dx, dy) + 0.41421356 * Math.min(dx, dy);
    };
    const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, 1.41421356], [1, -1, 1.41421356], [-1, 1, 1.41421356], [-1, -1, 1.41421356]];
    const gScore = {}; const cameFrom = {}; const closed = {};
    gScore[startIdx] = 0;
    const open = [];
    heapPush(open, [hOf(sx, sy), startIdx, sx, sy]); // [f, cellIdx, cx, cy]
    let found = false;
    let guard = cols * rows * 8; // hard cap — the open set never legitimately outlives this
    while (open.length && guard-- > 0) {
      const cur = heapPop(open);
      const ci = cur[1], cx = cur[2], cy = cur[3];
      if (closed[ci]) continue;
      closed[ci] = true;
      if (ci === goalIdx) { found = true; break; }
      const gc = gScore[ci];
      for (const d of DIRS) {
        const nx = cx + d[0], ny = cy + d[1];
        if (!water(nx, ny)) continue;
        if (d[2] > 1 && (!water(cx + d[0], cy) || !water(cx, cy + d[1]))) continue; // no corner cutting past land
        const ni = idxOf(nx, ny);
        if (closed[ni]) continue;
        const ng = gc + d[2];
        if (gScore[ni] !== undefined && gScore[ni] <= ng) continue;
        gScore[ni] = ng; cameFrom[ni] = ci;
        heapPush(open, [ng + hOf(nx, ny), ni, nx, ny]);
      }
    }
    if (!found) return null;
    const cellsPath = [];
    let cur = goalIdx;
    while (cur !== undefined) { cellsPath.unshift(cur); if (cur === startIdx) break; cur = cameFrom[cur]; }
    const pts = cellsPath.map(i => [((i % cols) + 0.5) * cs, (Math.floor(i / cols) + 0.5) * cs]);
    pts[pts.length - 1] = [to[0], to[1]]; // sail to the exact ordered point, not its cell centre
    // Greedy string-pulling at the same fidelity the search used — 6px samples
    // so no simplified segment can clip a coastline sliver the cells caught.
    const clearWater = (a, b) => {
      const d = dist(a, b);
      const steps = Math.max(1, Math.ceil(d / 6));
      for (let i = 1; i <= steps; i++) {
        const px = a[0] + (b[0] - a[0]) * i / steps, py = a[1] + (b[1] - a[1]) * i / steps;
        if (landMap[cellKey(Math.floor(px / cs), Math.floor(py / cs))]) return false;
      }
      return true;
    };
    const out = [];
    let anchor = [from[0], from[1]];
    let i = 0;
    while (i < pts.length) {
      let j = pts.length - 1;
      while (j > i && !clearWater(anchor, pts[j])) j--;
      out.push(pts[j]);
      anchor = pts[j];
      i = j + 1;
    }
    return out.length ? out : null;
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
    // Long polyline segments are SUBDIVIDED (~64px pieces) so the graph has
    // nodes all along a road, not just at its authored vertices. This is what
    // makes nearestNode entry/exit points honest (a unit standing beside the
    // middle of a long straight highway used to "see" the road as hundreds of
    // px away, making computePath's route-vs-direct comparison reject it) and
    // what lets the junction pass below actually link two polylines that cross
    // mid-segment with no vertex near the crossing.
    const SUBDIV = 64;
    for (const r of lines) {
      const pts = r.pts || [];
      if (pts.length < 2) continue;
      let prevIdx = null;
      for (let pi = 0; pi < pts.length; pi++) {
        const p = pts[pi];
        if (prevIdx !== null) {
          const a = nodes[prevIdx];
          const segLen = dist(a, p);
          const pieces = Math.max(1, Math.ceil(segLen / SUBDIV));
          for (let s = 1; s < pieces; s++) {
            const mid = addNode([a[0] + (p[0] - a[0]) * s / pieces, a[1] + (p[1] - a[1]) * s / pieces]);
            addEdge(prevIdx, mid, dist(nodes[prevIdx], nodes[mid]) / ROAD_SPEED_MULT);
            prevIdx = mid;
          }
        }
        const idx = addNode(p);
        if (prevIdx !== null) addEdge(prevIdx, idx, dist(nodes[prevIdx], nodes[idx]) / ROAD_SPEED_MULT);
        prevIdx = idx;
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const d = dist(nodes[i], nodes[j]);
        // d === 0 is allowed: two polylines whose subdivided nodes land on the
        // exact same point (a perfect mid-segment crossing) still need the
        // zero-cost link, or the two roads stay disconnected.
        if (d <= ROAD_JUNCTION_RANGE) addEdge(i, j, d / ROAD_SPEED_MULT);
      }
    }
    return { nodes, adj };
  }
  function getTransportGraph(db) {
    const fp = transportFingerprint(db);
    if (_graphCache.fingerprint !== fp) _graphCache = { fingerprint: fp, graph: buildTransportGraph(db) };
    return _graphCache.graph;
  }
  // `blocked(idx)` (optional) — skip impassable nodes, so a unit near a road
  // whose closest node happens to sit on neutral soil still enters the network
  // at the nearest OPEN node instead of abandoning road routing entirely.
  function nearestNode(graph, pos, blocked) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < graph.nodes.length; i++) {
      if (blocked && blocked(i)) continue;
      const d = dist(graph.nodes[i], pos);
      if (d < bd) { bd = d; best = i; }
    }
    return { idx: best, dist: bd };
  }
  // `blocked(idx)` (optional) marks a graph node as impassable — never
  // visited, never relaxed into — used by computePath below to keep the
  // road/rail router off neutral-territory nodes (Neutral-territory
  // hardening) without needing a war-specific graph cache (the graph itself
  // stays keyed only on road/rail content; the blocklist is applied per call).
  function dijkstra(graph, startIdx, blocked) {
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
        if (blocked && blocked(v)) continue;
        if (distArr[u] + w < distArr[v]) { distArr[v] = distArr[u] + w; prev[v] = u; }
      }
    }
    return { dist: distArr, prev };
  }
  // Node → neutral-cell test, built fresh per call from db.war.grid.neutralCells
  // (absent-safe: no grid/neutralCells at all returns null — permissive,
  // same as neutralAt). Kept out of the cached graph itself since the
  // belligerent set (and therefore neutralCells) can change mid-war.
  function neutralNodeTest(war, graph) {
    const g = war && war.grid;
    if (!g || !g.neutralCells) return null;
    const cs = g.cell;
    return (idx) => !!g.neutralCells[cellKey(Math.floor(graph.nodes[idx][0] / cs), Math.floor(graph.nodes[idx][1] / cs))];
  }
  function computePath(db, from, to, baseSpeed) {
    const graph = getTransportGraph(db);
    if (!graph || graph.nodes.length < 2) return null;
    // Neutral (closed-border) nodes are excluded from entry/exit selection AND
    // from dijkstra's relaxation — the route uses the open part of the network
    // or none of it, but a blocked node near a terminus no longer aborts
    // routing outright (the old bail was why border-adjacent garrisons
    // "sometimes" marched cross-country instead of taking the highway).
    const blocked = neutralNodeTest(db.war, graph);
    const entry = nearestNode(graph, from, blocked);
    const exit = nearestNode(graph, to, blocked);
    if (entry.idx < 0 || exit.idx < 0 || entry.idx === exit.idx) return null;
    const { dist: distArr, prev } = dijkstra(graph, entry.idx, blocked);
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
    if (path.length < 3) return path;
    // Collinear merge: subdivision (buildTransportGraph) yields a node every
    // ~64px, but straight road stretches don't need the intermediate points —
    // dropping them keeps unit path arrays (synced in war state) small.
    // Triangle-inequality slack test, deterministic on both sides.
    const out = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
      const a = out[out.length - 1], b = path[i], c = path[i + 1];
      if (dist(a, b) + dist(b, c) - dist(a, c) < 0.5) continue; // b sits on the a→c line (or duplicates a corner)
      out.push(b);
    }
    out.push(path[path.length - 1]);
    return out;
  }
  function setDest(db, u, dest, baseSpeed) {
    const war = db.war;
    u.manualPath = false; // a normal order always restores road/rail routing over any earlier freehand path
    u.attackId = null; // a plain move order cancels any in-progress chase (Feature: explicit attack orders)
    // Naval kinds (boat/warship) never touch land: their dest is clamped to the
    // nearest WATER cell, and they NEVER take a transport-graph route (roads and
    // rails are on land — a road path would drag a warship onto the shore).
    // They sail an all-water A* route around any landmass in the way (see
    // navalPath above); only when no such route exists (or the trip stays in
    // one cell) do they fall back to the legacy straight line, where
    // advanceToward's land-refusal still wall-follows as a last resort.
    if (NAVAL_KINDS[u.kind]) {
      ensureNavalGrid(db); // fine coastline grid backs the clamp + the route
      u.dest = nearestWaterPoint(war, clampToWorld(war, dest));
      const np = navalPath(db, war, u.pos, u.dest);
      if (np && np.length) { u.path = np; u.pathIdx = 0; }
      else { u.path = null; u.pathIdx = 0; }
      return;
    }
    // Neutral-territory hardening: a dest that lands on closed-border soil is
    // clamped to the nearest open ground BEFORE anything else (routing,
    // movement) ever sees it — see nearestNonNeutralPoint.
    u.dest = nearestNonNeutralPoint(war, clampToWorld(war, dest));
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
    // Neutral-territory hardening: every hand-drawn waypoint is clamped off
    // closed-border soil too — a freehand path never consults the transport
    // graph, so this is the only gate a manual order passes through before
    // stepAlongPath walks it point-to-point. Naval kinds clamp each waypoint
    // to WATER instead (the naval counterpart — a drawn point on shore would
    // otherwise beach-block the whole path).
    if (NAVAL_KINDS[u.kind]) ensureNavalGrid(db); // waypoint clamp reads the fine coastline grid
    const clampPt = NAVAL_KINDS[u.kind]
      ? (p) => nearestWaterPoint(war, clampToWorld(war, p))
      : (p) => nearestNonNeutralPoint(war, clampToWorld(war, p));
    const pts = (waypoints || []).slice(0, MAX_MANUAL_PATH_POINTS)
      .map(p => clampPt([Number(p[0]), Number(p[1])]))
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
        // Naval paths (navalPath's water route) are open sea, not roads — base
        // speed too.
        const spd = (u.manualPath || NAVAL_KINDS[u.kind]) ? baseSpeed : (idx === 0 ? baseSpeed : baseSpeed * ROAD_SPEED_MULT);
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
    // Road/rail proximity bonus (feature: near a road → faster): a flat
    // multiplier when the unit currently sits in a grid.roadCells cell. Cheap
    // O(1) flag, applies to EVERY movement mode (unlike the transport graph's
    // 5× which only applies while formally following the network). Naval kinds
    // don't get it (roads are on land).
    let spd = speed * unitMul(war, u, 'speed');
    if (!NAVAL_KINDS[u.kind]) spd *= roadProximityMul(war, u.pos);
    // GM warship-speed slider (war.mods.warshipSpeed) — a live multiplier read
    // fresh here, like mods.dmg/bombDmg, so it applies to EVERY warship
    // regardless of when it spawned and needs no per-unit rescale. Absent on a
    // legacy war doc → 1× (no change). Boats are deliberately excluded — the
    // slider tunes the heavy hulls, not the light craft.
    else if (u.kind === 'warship') spd *= (war.mods && war.mods.warshipSpeed) || 1;
    const step = Math.min(spd, d);
    let next = clampToWorld(war, [u.pos[0] + dx / d * step, u.pos[1] + dy / d * step]);
    // Routed land units must never flee into open water (feature: "never route
    // into the sea"). Same wall-follow refusal the naval-vs-land / neutral
    // checks use — a routed unit already at sea (a transport caught mid-strait)
    // is let through so it can reach land rather than freeze.
    if (u.state === 'routed' && !NAVAL_KINDS[u.kind] && isWaterAt(war, next) && !isWaterAt(war, u.pos)) {
      const base = Math.atan2(dy, dx);
      let moved = false;
      for (const dAng of [Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI * 0.75, -Math.PI * 0.75]) {
        const cand = clampToWorld(war, [u.pos[0] + Math.cos(base + dAng) * step, u.pos[1] + Math.sin(base + dAng) * step]);
        if (!isWaterAt(war, cand)) { next = cand; moved = true; break; }
      }
      if (!moved) return;
    }
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
    // Naval kinds (boats/warships) never step onto land — same wall-follow
    // pattern as the neutral-border refusal above, but at NAVAL fidelity:
    // navalWaterAt reads the fine polygon-derived coastline grid when built
    // (warTick builds it every tick), so even a straight-line fallback sail
    // stops at the real drawn border instead of a coarse 48px cell's centre
    // verdict. A unit that's somehow ALREADY beached (legacy doc, GM spawn, a
    // boat run aground) is allowed to move freely so it can crawl back into
    // the water rather than freeze forever.
    if (NAVAL_KINDS[u.kind] && navalWaterAt(war, u.pos) && !navalWaterAt(war, next)) {
      const base = Math.atan2(dy, dx);
      let moved = false;
      for (const dAng of [Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI * 0.75, -Math.PI * 0.75]) {
        const cand = clampToWorld(war, [u.pos[0] + Math.cos(base + dAng) * step, u.pos[1] + Math.sin(base + dAng) * step]);
        if (navalWaterAt(war, cand)) { next = cand; moved = true; break; }
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
  // Sum of live defending strength within r of a point. Warships are
  // excluded — shore bombardment can't be cleared by land manoeuvre, so a
  // squadron offshore must not read as "the city is garrisoned".
  function defStrengthNear(war, pos, r) {
    let s = 0;
    for (const u of war.units) {
      if (u.side !== 'def' || !isLive(u) || u.kind === 'warship') continue;
      if (dist(u.pos, pos) <= r) s += u.strength;
    }
    return s;
  }
  // Slide a planned point along the straight line toward `toward` until it
  // sits on land — a pincer arm or supply-cut post computed in open water
  // would send a land column swimming (transport state: can't fight, prime
  // warship bait). Deterministic fixed-fraction march; `toward` itself is a
  // city/capital position, so the walk always terminates on land.
  function landward(war, point, toward) {
    if (!isWaterAt(war, point)) return point;
    const steps = Math.max(1, Math.ceil((dist(point, toward) || 1) / 16));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const cand = [point[0] + (toward[0] - point[0]) * t, point[1] + (toward[1] - point[1]) * t];
      if (!isWaterAt(war, cand)) return cand;
    }
    return toward.slice();
  }
  // Remove and return the pool unit nearest to `pos`. Ties break by pool
  // order, which follows war.units order — part of state, so the server and
  // a predicting client pick the exact same unit.
  function takeNearest(pool, pos) {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const d = dist(pool[i].pos, pos);
      if (d < bd) { bd = d; bi = i; }
    }
    return bi >= 0 ? pool.splice(bi, 1)[0] : null;
  }
  function runAI(db, war, ctx, rng) {
    const attTotal = war.units.filter(u => u.side === 'att' && isLive(u)).reduce((s, u) => s + u.strength, 0);
    const collapseAt = war.ai.attackerStartStrength * war.ai.collapseFrac;
    const consolidateAt = war.ai.attackerStartStrength * war.ai.consolidateFrac;

    if (attTotal <= collapseAt && !war.totalWar) {
      // A repelled invasion no longer ends the war on a negotiated collapse —
      // it goes TOTAL instead (feature: "repelled → total phase"): the
      // shattered invader refuses terms and its remnants fight to the last,
      // so the defence must destroy every remaining formation. checkVictory's
      // annihilation path (no live attacker units → winner 'def') is what
      // finally ends the war. One-shot: totalWar gates re-entry.
      war.totalWar = true;
      war.ai.phase = 'total';
      note(war, `Attacking force collapsed (${Math.round(attTotal)} strength remaining) — no terms; the remnants fight to the last.`);
      ctx.log('event', 'The invasion is repelled — the war turns total', war.name, 'WAR ENGINE', [war.attackerId, war.defenderId]);
      ctx.news('THE INVASION IS REPELLED', 'The invading expeditionary force has been shattered — yet its commanders refuse all terms. What remains digs in to fight to the last. The war enters its total phase.');
    }

    const landingObj = war.objectives.find(o => o.kind === 'landing');
    const wasPhase = war.ai.phase;
    // totalWar outranks consolidation: a total-phase force never digs in, it
    // hunts (that is also what keeps a collapsed-but-unbeaten remnant fighting).
    if (war.totalWar) war.ai.phase = 'total';
    else if (attTotal <= consolidateAt) war.ai.phase = 'consolidate';
    else if (landingObj && landingObj.status !== 'done') war.ai.phase = 'landing';
    else war.ai.phase = war.ai.phase === 'consolidate' ? 'consolidate' : (war.objectives.every(o => o.status === 'done') ? 'exploit' : 'breakout');
    if (war.ai.phase !== wasPhase) note(war, `Phase change: ${wasPhase} → ${war.ai.phase}`);

    // Total war (Phase 22): objectives are history — hunt down every
    // remaining defender, then sweep whatever ground is still uncontrolled.
    // Chase orders reuse stepChase; the sweep reuses randomProvincePoint on
    // the LEAST-controlled province, so the drive converges on 100%.
    if (war.ai.phase === 'total') {
      const defsLive = war.units.filter(x => x.side === 'def' && isLive(x));
      const ctl = war.stats.provinceControl || {};
      let sweepPid = null, low = 101;
      for (const pid in war.grid.provinceLandCells) {
        const c = ctl[pid] || 0;
        if (c < TOTAL_VICTORY_PCT && c < low) { low = c; sweepPid = pid; }
      }
      let hunting = 0, sweeping = 0;
      for (const u of war.units) {
        if (u.side !== 'att' || !isLive(u) || u.state === 'routed' || u.state === 'embarked') continue;
        if (u.orderedBy === 'player' && (u.playerHoldUntil || 0) > war.tick) continue;
        // A LAND unit only hunts land targets — sending infantry swimming
        // after a warship is suicide (see stepChase's matching refusal). If
        // only enemy warships remain afloat, the ground forces sweep territory
        // instead and leave the hulls to friendly boats/warships.
        const targets = NAVAL_KINDS[u.kind] ? defsLive : defsLive.filter(d => d.kind !== 'warship');
        if (targets.length) {
          let nearest = targets[0], nd = dist(u.pos, nearest.pos);
          for (const d of targets) { const dd = dist(u.pos, d.pos); if (dd < nd) { nd = dd; nearest = d; } }
          clearDest(u);
          u.attackId = nearest.id;
          u.objectiveId = null;
          if (u.state !== 'fighting') u.state = 'moving';
          hunting++;
        } else if (sweepPid && !NAVAL_KINDS[u.kind]) {
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

    /* ---- Role-based assault planner (Phase 28) ----
       The old plan was a single blob: every committed unit marched straight
       at the top objective, with a flat "every 4th unit sits on the last
       city taken" rear guard. The replan below splits the committed force
       into ROLES, each of which exploits a real engine mechanic rather than
       being flavour:
         · rear guard    — only where live defenders actually threaten a
                           captured city, sized to the threat (stepTerritory
                           recapture + city fall are what it protects);
         · interdiction  — a detachment posted on the ground between the
                           defender capital and the objective: the territory
                           it takes pinches the capital-rooted supply
                           flood-fill (stepSupply), so the objective's
                           garrison stops healing — a mechanical siege;
         · encirclement  — pincer arms swing wide around a DEFENDED
                           objective to close behind it: routed garrisons
                           retreating from the assault (retreatTarget) run
                           straight into them, and the flanks feed the same
                           supply pinch;
         · pursuit       — spearheads run down routed/mauled defenders near
                           the axis instead of marching past them (a routed
                           unit left alone rallies at RALLY_ORG and comes
                           straight back);
         · spearhead     — everyone left masses on the objective, exactly
                           the old behaviour.
       Everything is deterministic: pools iterate in war.units order (state),
       nearest-picks tie-break by pool order, and the only rng draws are the
       sweep-sector samples below — so a predicting client replays the same
       plan from the same snapshot. */

    // Keep embarked units pointed at the landing; split everyone else.
    const landForce = [], navalForce = [];
    for (const u of war.units) {
      if (u.side !== 'att' || !isLive(u) || u.state === 'routed') continue;
      if (u.orderedBy === 'player' && (u.playerHoldUntil || 0) > war.tick) continue;
      if (u.state === 'embarked') { u.objectiveId = landingObj ? landingObj.id : null; continue; }
      if (NAVAL_KINDS[u.kind]) navalForce.push(u); else landForce.push(u);
    }

    // Naval units: fire support. setDest clamps a naval dest to the nearest
    // water, so "go to the city" reads as "take station off its coast" and
    // stepWarshipFire does the rest — same effective behaviour the old
    // single-blob assignment produced, now stated as an explicit role.
    const navalAim = target || sweepObj;
    for (const u of navalForce) {
      if (navalAim) { setDest(db, u, navalAim.pos.slice(), u.speed); u.objectiveId = navalAim.id; }
    }

    if (!target && sweepObj) {
      // Exploit phase: fan the force out across the province in deterministic
      // SECTORS of its land-cell list instead of everyone sampling the same
      // random point independently — the old sweep could pile half the army
      // into one corner while the far side of the province stayed unswept
      // for several replans (the documented "already dense" rough edge).
      const cells = (war.grid.provinceCells || {})[sweepObj.ref] || [];
      const cs = war.grid.cell;
      let n = 0;
      for (const u of landForce) {
        let dest = null;
        if (cells.length) {
          const idx = Math.floor(((n + rng()) / Math.max(1, landForce.length)) * cells.length) % cells.length;
          dest = [cells[idx][0] * cs + cs / 2, cells[idx][1] * cs + cs / 2];
        }
        setDest(db, u, dest || sweepObj.pos.slice(), u.speed);
        u.objectiveId = sweepObj.id;
        n++;
      }
      const prov = (db.provinces || []).find(p => p.id === sweepObj.ref);
      note(war, `Sweeping ${n} unit(s) through ${prov ? prov.name : sweepObj.ref} in spread sectors to raise territorial control.`);
      return;
    }
    if (!target) { note(war, 'All objectives complete — mopping up.'); return; }

    const pool = landForce.slice();
    const cityById = (id) => (db.cities || []).find(c => c.id === id);

    // 1. Rear guard — threat-aware. Walk captured cities most-recent-first;
    //    only one with live defenders nearby gets a guard, 1–2 units by
    //    threat strength, chosen by proximity. No threat anywhere → the
    //    whole force stays forward (the old rule idled 25% of it always).
    const guardedNames = [];
    let guards = 0;
    const maxGuards = Math.floor(pool.length / 4);
    const heldIds = (war.stats.citiesHeld || []).slice().reverse();
    for (const cid of heldIds) {
      if (guards >= maxGuards) break;
      const city = cityById(cid);
      if (!city || !city.pos) continue;
      const threat = defStrengthNear(war, city.pos, GARRISON_THREAT_R);
      if (threat <= 0) continue;
      const want = Math.min(2, Math.max(1, Math.round(threat / 3000)), maxGuards - guards);
      let took = 0;
      for (let i = 0; i < want; i++) {
        const u = takeNearest(pool, city.pos);
        if (!u) break;
        clearDest(u);
        u.state = 'holding';
        u.objectiveId = null;
        guards++; took++;
      }
      if (took) guardedNames.push(city.name);
    }

    // 2. Supply interdiction — post a detachment between the defender
    //    capital (the root of stepSupply's defender flood-fill) and the
    //    objective. Pointless when the objective IS the capital (there is
    //    no line behind it to cut) or the force is too small to detach.
    let interdictors = 0;
    const capital = (db.cities || []).find(c => c.isCapital && c.pos);
    const targetIsCapital = !!(capital && dist(capital.pos, target.pos) < 60);
    if (capital && !targetIsCapital && pool.length >= 6) {
      const cut = landward(war, clampToWorld(war, [
        capital.pos[0] + (target.pos[0] - capital.pos[0]) * INTERDICT_FRAC,
        capital.pos[1] + (target.pos[1] - capital.pos[1]) * INTERDICT_FRAC
      ]), capital.pos);
      const want = pool.length >= 10 ? 2 : 1;
      for (let i = 0; i < want; i++) {
        const u = takeNearest(pool, cut);
        if (!u) break;
        setDest(db, u, cut.slice(), u.speed);
        u.objectiveId = target.id;
        interdictors++;
      }
    }

    // 3. Encirclement — only when the objective is actually defended. Pincer
    //    arms aim ENCIRCLE_R to each flank, biased slightly PAST the city
    //    along the approach axis so they close behind it, and landward-slid
    //    so a coastal objective never sends a column into the sea.
    let encirclers = 0;
    const defAtObj = defStrengthNear(war, target.pos, OBJ_THREAT_R);
    if (defAtObj > 0 && pool.length >= 4) {
      let cx = 0, cy = 0;
      for (const u of pool) { cx += u.pos[0]; cy += u.pos[1]; }
      cx /= pool.length; cy /= pool.length;
      let ax = target.pos[0] - cx, ay = target.pos[1] - cy;
      const am = Math.hypot(ax, ay) || 1; ax /= am; ay /= am;
      const arms = pool.length >= 8 ? 2 : 1;
      for (let i = 0; i < arms; i++) {
        const side = i === 0 ? 1 : -1;
        const pt = landward(war, clampToWorld(war, [
          target.pos[0] - ay * side * ENCIRCLE_R + ax * ENCIRCLE_R * 0.35,
          target.pos[1] + ax * side * ENCIRCLE_R + ay * ENCIRCLE_R * 0.35
        ]), target.pos);
        const u = takeNearest(pool, pt);
        if (!u) break;
        setDest(db, u, pt, u.speed);
        u.objectiveId = target.id;
        encirclers++;
      }
    }

    // 4. Pursuit — run down routed/mauled defenders within PURSUE_R of the
    //    remaining force rather than marching past them. Chase orders reuse
    //    stepChase; the next replan's setDest clears any stale attackId.
    let pursuers = 0;
    const maxPursuit = Math.ceil(pool.length / 3);
    for (const d of war.units) {
      if (pursuers >= maxPursuit || !pool.length) break;
      if (d.side !== 'def' || !isLive(d) || d.kind === 'warship') continue;
      if (!(d.state === 'routed' || d.strength < (d.maxStrength || d.strength) * PURSUE_WEAK_FRAC)) continue;
      let bi = -1, bd = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const dd = dist(pool[i].pos, d.pos);
        if (dd <= PURSUE_R && dd < bd) { bd = dd; bi = i; }
      }
      if (bi < 0) continue;
      const u = pool.splice(bi, 1)[0];
      clearDest(u);
      u.attackId = d.id;
      u.objectiveId = null;
      if (u.state !== 'fighting') u.state = 'moving';
      pursuers++;
    }

    // 5. Main effort — everyone left masses on the objective.
    for (const u of pool) {
      setDest(db, u, target.pos.slice(), u.speed);
      u.objectiveId = target.id;
    }

    const parts = [`${pool.length} on the assault`];
    if (encirclers) parts.push(`${encirclers} swinging wide to encircle`);
    if (interdictors) parts.push(`${interdictors} cutting the ${capital ? capital.name + ' ' : ''}supply line`);
    if (pursuers) parts.push(`${pursuers} running down broken formations`);
    if (guards) parts.push(`${guards} guarding ${guardedNames.join(', ')}`);
    if (navalForce.length && navalAim) parts.push(`${navalForce.length} squadron(s) on fire support`);
    note(war, `${target.kind} (priority ${target.priority}): ${parts.join('; ')}.`);
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
  // Where a routed unit runs TO (feature: "route towards their friendly
  // lines"): the strength-weighted centroid of its side's other live,
  // non-routed formations — i.e. the cohesive part of its own army it's trying
  // to fall back onto. Falls back to the side's supply anchor (attacker) and
  // finally to a point straight AWAY from the nearest enemy (the old blind
  // flee) when it's the last unit standing. The result is a direction target;
  // advanceToward clamps it in-bounds, refuses water (routed land units) and
  // refuses neutral soil, so this only chooses the heading.
  function retreatTarget(war, u) {
    let sx = 0, sy = 0, w = 0;
    for (const f of war.units) {
      if (f === u || f.side !== u.side || !isLive(f)) continue;
      if (f.state === 'routed' || f.state === 'embarked') continue;
      const s = f.strength || 1;
      sx += f.pos[0] * s; sy += f.pos[1] * s; w += s;
    }
    if (w > 0) {
      const c = [sx / w, sy / w];
      // Only rally toward friends if they're not essentially on top of us;
      // otherwise fall through to the away-from-enemy heading so we still peel
      // off the firing line rather than standing in it.
      if (dist(u.pos, c) > UNIT_RADIUS) return c;
    }
    if (u.side === 'att' && Array.isArray(war.supplyAnchor)) return war.supplyAnchor.slice();
    const near = nearestLiveEnemy(war, u);
    if (near.unit) {
      const dx = u.pos[0] - near.unit.pos[0], dy = u.pos[1] - near.unit.pos[1];
      const m = Math.hypot(dx, dy) || 1;
      return [u.pos[0] + dx / m * 120, u.pos[1] + dy / m * 120];
    }
    return u.pos.slice();
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
    // A LAND unit never chases a warship (feature: "transports don't go after
    // warships"): it would have to swim out as a defenceless transport into
    // WARSHIP_RANGE fire it cannot return — suicide, whether the order came
    // from the AI's hunt or a player click. Break the chase off cleanly; the
    // unit falls back to normal dest handling. Boats/warships still may.
    if (!NAVAL_KINDS[u.kind] && target.kind === 'warship') { u.attackId = null; u.state = 'holding'; return false; }
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
          // Fall back toward friendly lines (not just blindly away from the
          // enemy), never into the sea — advanceToward enforces both. Garrisons
          // spawn speed 0, so a broken one still scatters at the ordered-defender
          // pace rather than standing in the fire.
          advanceToward(war, u, retreatTarget(war, u), (u.speed || DEF_MOVE_SPEED) * 0.8);
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
        // Retreat toward friendly lines, never into the water (advanceToward
        // enforces both) — replaces the old blind flee-from-enemy heading.
        advanceToward(war, u, retreatTarget(war, u), u.speed * 0.8);
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
          // Neutral-territory hardening: the separation nudge must not shove
          // a friendly onto closed-border soil — only apply it when the
          // candidate spot isn't neutral (or the unit was already standing in
          // neutral ground, same "already there, let it move" exception used
          // throughout advanceToward). Naval hardening, same shape: the nudge
          // must never shove an AFLOAT naval unit onto land (this shove was
          // how ships got beached, after which the un-beach exception let
          // them drive cross-country) — checked at navalWaterAt fidelity, the
          // exact polygon coastline when the fine grid is built.
          const aNext = clampToWorld(war, [a.pos[0] - nx * push * 0.5, a.pos[1] - ny * push * 0.5]);
          const bNext = clampToWorld(war, [b.pos[0] + nx * push * 0.5, b.pos[1] + ny * push * 0.5]);
          const shoveOk = (u, next) =>
            (!neutralAt(war, next) || neutralAt(war, u.pos)) &&
            (!NAVAL_KINDS[u.kind] || navalWaterAt(war, next) || !navalWaterAt(war, u.pos));
          if (shoveOk(a, aNext)) a.pos = aNext;
          if (shoveOk(b, bNext)) b.pos = bNext;
        }
      }
    }
  }

  // ---------- transport state (Transport ships & Boats feature) ----------
  // A LAND unit (any kind that isn't a naval kind — boat/warship handle water
  // natively) whose position drifts over open sea (embarked→landing handoff
  // aside — this covers everything else: a road/rail route that briefly
  // crosses a strait, a unit pushed off a captured beach, etc.) becomes state
  // 'transport' — rendered client-side as a small transport-ship silhouette —
  // until it's back over land. A transport-state unit cannot INITIATE combat
  // (see stepCombat's aFights/dFights gating below) but can still be damaged
  // (e.g. by a warship's ranged pass). The unit's pre-transition state is
  // remembered so it resumes exactly what it was doing (moving/holding) the
  // moment it makes landfall again, rather than snapping to a fixed state.
  function stepTransportState(war) {
    for (const u of war.units) {
      if (!isLive(u)) continue;
      if (u.state === 'embarked' || u.state === 'dead' || u.state === 'routed') continue;
      if (NAVAL_KINDS[u.kind]) continue; // boats/warships are naval-native — not "transport"
      const water = isWaterAt(war, u.pos);
      if (water && u.state !== 'transport') {
        u._preTransportState = u.state;
        u.state = 'transport';
      } else if (!water && u.state === 'transport') {
        u.state = u._preTransportState || 'moving';
        u._preTransportState = null;
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
  // A unit stranded on land in transport state, or a boat sitting on land,
  // cannot initiate/deal damage in a fight — see stepTransportState and the
  // "boat kind" doc above. Warships never appear here at all (they fight
  // exclusively via stepWarshipFire's ranged pass below).
  function canFight(war, u) {
    if (u.state === 'transport') return false;
    if (u.kind === 'boat' && !isWaterAt(war, u.pos)) return false;
    return true;
  }
  function stepCombat(db, war, ctx, rng) {
    const atts = war.units.filter(u => u.side === 'att' && isLive(u) && u.state !== 'embarked' && u.kind !== 'warship');
    const defs = war.units.filter(u => u.side === 'def' && isLive(u) && u.kind !== 'warship');
    // GM global tuning (Feature 3) — read defensively so a war doc without
    // `mods` (every war predating this change) falls back to 1× exactly.
    const dmgMod = (war.mods && war.mods.dmg) || 1;
    let anyFight = false;
    const engagedDefs = new Set(); // defenders an attacker actually fought this tick — the rest stand down below
    for (const a of atts) {
      let nearest = null, nd = Infinity;
      // Re-check isLive here, NOT just in the tick-start `defs` snapshot: an
      // earlier attacker in this same loop may have just killed a defender,
      // and targeting the corpse both wasted this attacker's whole tick and
      // re-ran the rout/kill bookkeeping on a dead unit (duplicate
      // "destroyed" events, a corpse flipped back to state 'routed').
      for (const d of defs) { if (!isLive(d)) continue; const dd = dist(a.pos, d.pos); if (dd < nd) { nd = dd; nearest = d; } }
      if (!nearest || nd > COMBAT_RANGE) { if (a.state !== 'routed' && a.state !== 'transport') a.state = a.dest ? 'moving' : 'holding'; continue; }
      const d = nearest;
      anyFight = true;
      // Transport ships & Boats feature: a transport-state land unit (or a
      // beached boat) cannot DEAL damage but can still be damaged — each
      // side's dealt-damage term is independently zeroed by canFight, and
      // neither combatant's state is stomped to 'fighting' if it can't fight
      // (so a transport ship keeps rendering as a transport ship even while
      // under fire).
      const aFights = canFight(war, a), dFights = canFight(war, d);
      if (aFights) a.state = 'fighting';
      if (d.state !== 'routed' && dFights) d.state = 'fighting';
      const defStationary = d.garrison && !d.dest;
      const defBonus = defStationary ? 1.35 : 1;
      // Equipment (Phase 26, per-unit): the guns THIS unit carries raise the
      // damage it deals; the victim's own kit absorbs some of what lands
      // (hp); better small arms also slow morale drain (a unit that can
      // shoot back holds longer).
      const dmgToDef = aFights ? K_COMBAT * a.strength * (0.7 + 0.6 * rng()) * (a.atk || 1) * dmgMod * unitMul(war, a, 'dmg') / unitMul(war, d, 'hp') : 0;
      const dmgToAtt = dFights ? K_COMBAT * d.strength * (0.7 + 0.6 * rng()) * defBonus * dmgMod * unitMul(war, d, 'dmg') / unitMul(war, a, 'hp') : 0;
      d.strength = Math.max(0, round1(d.strength - dmgToDef));
      a.strength = Math.max(0, round1(a.strength - dmgToAtt));
      war.stats.defLosses += dmgToDef; war.stats.attLosses += dmgToAtt;
      if (aFights) a.org = clamp(a.org - ORG_DRAIN / unitMul(war, a, 'morale'), 0, 100);
      if (dFights) d.org = clamp(d.org - ORG_DRAIN * 0.7 / unitMul(war, d, 'morale'), 0, 100);
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
    stepWarshipFire(war, ctx, rng, dmgMod);
    pruneCorpses(war);
    if (!anyFight) {
      // Both sides recover morale while the whole front is quiet — the regen
      // used to be attacker-only, which left a garrison that had fought
      // parked at low org forever (and, with garrison routs now possible,
      // one org-drain away from breaking on the next engagement).
      for (const u of war.units) if (isLive(u) && u.state !== 'routed') u.org = clamp(u.org + ORG_REGEN, 0, 100);
    }
  }

  // ---------- warship ranged fire (Warships feature) ----------
  // Naval-only, ranged: a warship engages ANY live enemy (naval or land)
  // within WARSHIP_RANGE (180px, far beyond the 40px collision range other
  // kinds fight at) in a separate one-directional pass — the target doesn't
  // automatically shoot back here (it gets its own turn in this same pass, or
  // in the normal collision pass, if it's in range/adjacent). Warships deal a
  // heavy bonus to 'transport'-state units and 'boat' units — their whole
  // job is hunting transports and light naval craft.
  function stepWarshipFire(war, ctx, rng, dmgMod) {
    const warships = war.units.filter(u => u.kind === 'warship' && isLive(u) && u.state !== 'embarked');
    if (!warships.length) return;
    for (const w of warships) {
      let nearest = null, nd = Infinity;
      for (const e of war.units) {
        if (e.side === w.side || !isLive(e) || e.state === 'embarked') continue;
        if (e.kind === 'boat' && !isWaterAt(war, e.pos) && e.state !== 'transport') continue; // a beached boat isn't a naval target
        const d = dist(w.pos, e.pos);
        if (d < nd) { nd = d; nearest = e; }
      }
      if (!nearest || nd > WARSHIP_RANGE) { if (w.state !== 'routed') w.state = w.dest ? 'moving' : 'holding'; continue; }
      const target = nearest;
      w.state = 'fighting';
      const bonus = (target.state === 'transport' || target.kind === 'boat') ? WARSHIP_TRANSPORT_BONUS : 1;
      const dmg = K_COMBAT * w.strength * (0.7 + 0.6 * rng()) * (w.atk || 1) * dmgMod * unitMul(war, w, 'dmg') / unitMul(war, target, 'hp') * bonus;
      target.strength = Math.max(0, round1(target.strength - dmg));
      if (target.side === 'att') war.stats.attLosses += dmg; else war.stats.defLosses += dmg;
      const routOrg = target.garrison ? GARRISON_ROUT_ORG : ROUT_ORG;
      target.org = clamp(target.org - ORG_DRAIN * 0.5 / unitMul(war, target, 'morale'), 0, 100);
      if (target.org < routOrg && target.state !== 'routed') { target.state = 'routed'; pushEvent(war, 'battle', target.pos.slice(), `${target.name} breaks and routs.`); }
      if (target.strength <= 0) killUnit(war, target);
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
      // Refugee columns caught in the blast die by the same falloff curve —
      // count-scaled rather than strength-scaled (they have no armour, no
      // kit; a direct hit annihilates the column outright). Deaths land in
      // stats.civilianDeaths; the authority layer settles the survivors'
      // population on arrival (see server/war.js settleRefugees), so people
      // killed on the road never reach the destination province's books.
      if (Array.isArray(war.refugees)) {
        for (const r of war.refugees) {
          if (r.count <= 0 || r.arrived != null) continue;
          const rd = dist(r.pos, strike.pos);
          if (rd > BOMB_RADIUS) continue;
          const killed = Math.min(r.count, Math.round(r.count * airstrikeFalloff(rd)));
          if (!killed) continue;
          r.count -= killed;
          war.stats.civilianDeaths = (war.stats.civilianDeaths || 0) + killed;
          if (r.count <= 0) {
            r.deadTick = war.tick;
            pushEvent(war, 'battle', r.pos.slice(), `A refugee column from ${r.fromName || r.from} is wiped out in the blast.`);
          } else {
            pushEvent(war, 'battle', r.pos.slice(), `${killed.toLocaleString('en-US')} refugees from ${r.fromName || r.from} are killed in the blast.`);
          }
        }
      }
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

  // ---------- refugee columns (Phase 28) ----------
  // war.refugees: [{ id, from, fromName, to, toName, count, startCount,
  //   pos:[x,y], dest:[x,y], spawnedTick, arrived: tick|null, deadTick:
  //   tick|null, _settled? }] — spawned AUTHORITY-side by server/war.js's
  //   refugee waves (a predicting client only ever sees them via snapshots,
  //   like airstrikes), but MOVED here in the shared engine so prediction
  //   walks them tick-for-tick between heartbeats. Deliberately NOT units:
  //   they never enter combat rosters, AI pools, territory projection or the
  //   friendly-separation O(n²) pass — a capped array (REFUGEE_MAX) walked
  //   once per tick, so the perf cost is a handful of dist() calls.
  //   Deterministic: array order iteration, no rng draws (crossfire losses
  //   are a fixed fraction), so the per-tick PRNG stream is untouched.
  function stepRefugees(war) {
    const list = war.refugees;
    if (!Array.isArray(list) || !list.length) return;
    for (const r of list) {
      if (r.count <= 0 || r.arrived != null) continue;
      // Crossfire: a column hugging an active firefight bleeds people. No
      // targeting, no orders — proximity to any FIGHTING unit is enough.
      let fire = 0;
      for (const u of war.units) {
        if (!isLive(u) || u.state !== 'fighting') continue;
        if (dist(u.pos, r.pos) <= REFUGEE_CROSSFIRE_R) fire++;
      }
      if (fire) {
        const killed = Math.min(r.count, Math.max(20, Math.round(r.count * REFUGEE_CROSSFIRE_FRAC * fire)));
        r.count -= killed;
        war.stats.civilianDeaths = (war.stats.civilianDeaths || 0) + killed;
        if (r.count <= 0) {
          r.deadTick = war.tick;
          pushEvent(war, 'battle', r.pos.slice(), `A refugee column from ${r.fromName || r.from} is caught in the crossfire and destroyed.`);
          continue;
        }
      }
      // March toward the destination. The shim borrows advanceToward's
      // ROUTED branch on purpose: a routed land unit refuses to step into
      // the sea and wall-follows the coastline — exactly how a column of
      // civilians on foot should behave (the neutral-border refusal and the
      // world clamp apply the same way).
      const shim = { pos: r.pos, state: 'routed', kind: 'civilian' };
      advanceToward(war, shim, r.dest, REFUGEE_SPEED);
      r.pos = shim.pos;
      if (dist(r.pos, r.dest) <= REFUGEE_ARRIVE_R) r.arrived = war.tick;
    }
    // Prune columns whose fade-out window has passed. An ARRIVED column is
    // only dropped once the authority layer has settled its survivors into
    // the destination province (`_settled`, server/war.js settleRefugees) —
    // a burst catch-up (maybeWarTick can run many engine ticks before the
    // authority pass gets its turn) must never prune people who haven't
    // been credited yet. A predicting client never sets _settled, so its
    // arrived columns linger invisibly (opacity 0 after the fade) until the
    // next rebase delivers the server's settled/pruned truth — harmless.
    // Annihilated columns (count 0) have nothing to settle and prune freely.
    war.refugees = list.filter(r => {
      if (r.arrived != null) return !(r._settled && (war.tick - r.arrived) >= REFUGEE_FADE_TICKS);
      if (r.count <= 0) return (war.tick - (r.deadTick || war.tick)) < REFUGEE_FADE_TICKS;
      return true;
    });
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
      // Phase 28 supply rework — the corridor is no longer rooted ONLY at
      // the original landing/staging anchor:
      //  · HOMELAND ROOT (every attacker): the attacker's own soil
      //    (grid.enemyCells, minus anything the defence has captured) seeds
      //    the fill wholesale — occupied territory that CONNECTS back to the
      //    friendly border is supplied through it, and troops standing
      //    inside the homeland itself always are. (attHeld already treated
      //    homeland as traversable; it just could never be a ROOT, so a
      //    corridor pinched off from the anchor read cut even while it
      //    touched the border.)
      //  · COASTAL ROOT (naval invaders only — scenarios with a `landing`
      //    objective): every att-held captured cell adjacent to open sea is
      //    a beach the fleet can supply over, so a pocket that reaches ANY
      //    coastline is fed even if the corridor to the original beachhead
      //    is cut. Land-border invaders (`land: true`, no landing objective)
      //    get no sea lift. Needs grid.landCells to tell sea from land — a
      //    legacy grid without it skips coastal roots (permissive elsewhere,
      //    conservative here).
      const isNaval = war.objectives.some(o => o.kind === 'landing');
      if (war.grid.enemyCells) {
        for (const key in war.grid.enemyCells) {
          const c = war.cells[key];
          if (!c || c.o !== 'def') seeds.push(key);
        }
      }
      if (isNaval && war.grid.landCells) {
        for (const key in war.cells) {
          if (war.cells[key].o !== 'att') continue;
          const comma = key.indexOf(',');
          const cx = Number(key.slice(0, comma)), cy = Number(key.slice(comma + 1));
          const coastal =
            (cx > 0 && !war.grid.landCells[cellKey(cx - 1, cy)]) ||
            (cx < war.grid.cols - 1 && !war.grid.landCells[cellKey(cx + 1, cy)]) ||
            (cy > 0 && !war.grid.landCells[cellKey(cx, cy - 1)]) ||
            (cy < war.grid.rows - 1 && !war.grid.landCells[cellKey(cx, cy + 1)]);
          if (coastal) seeds.push(key);
        }
      }
      // Original near-anchor seeding kept: covers the first ticks of a
      // landing before any beach cell is formally captured.
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
      // Naval kinds AFLOAT are supplied by the fleet train, same rule as
      // embarked troops above — open sea belongs to neither side's cell set,
      // so without this a warship squadron (whose hulls load as supply, like
      // tanks — see server/war.js resupplyUnits) would read permanently cut
      // off the moment it left harbour and never take on its ships. A beached
      // boat gets no such grace.
      if (NAVAL_KINDS[u.kind] && navalWaterAt(war, u.pos)) { u.supplied = true; continue; }
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
  // Can this objective still be completed against the CURRENT world? A treaty
  // that cedes a province turns it into a foreign country (its cities leave
  // db.cities, the province leaves db.provinces and the war grid) — an
  // objective pointing at that ground can never resolve. Landing objectives
  // are always considered reachable (they resolve on the beach, not a city).
  function objectiveReachable(db, war, o) {
    if (o.kind === 'landing') return true;
    if (o.kind === 'control_province') {
      const prov = (db.provinces || []).find(p => p.id === o.ref);
      return !!prov && (war.grid.provinceLandCells[o.ref] || 0) > 0;
    }
    // seize_city / seize_capital
    const ref = (o.kind === 'seize_capital' && !o.ref)
      ? ((db.cities || []).find(c => c.isCapital) || {}).id
      : o.ref;
    return !!ref && (db.cities || []).some(c => c.id === ref);
  }
  function checkVictory(db, war, ctx) {
    if (!war.active) return;
    // Ceded-objective fallback: a still-pending objective whose city/province
    // has been ceded away can never complete, and the AI would march forever at
    // a stale point (a real regression when a new scenario's target was ceded
    // to another nation). Drop straight into total war — its hunt-the-defenders
    // + sweep-the-least-controlled-province drive works off whatever territory
    // and formations actually remain, so the campaign can still be won.
    if (!war.totalWar) {
      const stuck = war.objectives.some(o => o.status !== 'done' && !objectiveReachable(db, war, o));
      if (stuck) {
        war.totalWar = true;
        if (war.ai) war.ai.phase = 'total';
        const anchor = war.units.find(u => u.side === 'att' && isLive(u));
        pushEvent(war, 'milestone', anchor ? anchor.pos.slice() : [1920, 1080], 'An objective is no longer reachable — the invader drives for total conquest instead.');
        ctx.log('event', 'The war enters its total phase', `${war.name}: a strategic objective has been ceded away; the invasion presses on for total victory.`, 'WAR ENGINE', [war.attackerId, war.defenderId]);
        ctx.news('NO TERMS: WAR ENTERS ITS TOTAL PHASE', 'With a strategic objective now beyond reach, the invading command has announced it will accept nothing short of total capitulation. The war goes on.');
      }
    }
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
    // Fine naval coastline grid (exact borders) — built/refreshed here so BOTH
    // the server and every predicting client have it before any movement runs
    // this tick (advanceToward's naval refusal reads it via module cache).
    ensureNavalGrid(db);
    // Re-derive neutral/enemy soil when the belligerent set changed (joinWar)
    // — no-op when the key matches, so this is a cheap per-tick guard that
    // keeps server and predicting client in step without extra sync plumbing.
    refreshWarZones(db, war);
    // AI runs whenever war.ai is present: always on the server, and on every
    // predicting client too — players receive a REDACTED ai (numeric plan
    // state, notes emptied — see api.js) precisely so their local replay
    // makes the same deterministic replans the server makes. Before that, a
    // player client kept units marching on stale dests between snapshots and
    // every AI turn showed up as a rubberband correction. A legacy snapshot
    // with no ai at all still just coasts on existing dests.
    if (war.ai && war.tick - (war.ai.lastPlanTick || 0) >= AI_INTERVAL) {
      runAI(db, war, ctx, rng);
      war.ai.lastPlanTick = war.tick;
      if (!war.active) return true; // AI declared a collapse-defeat this tick
    }
    stepMovement(db, war, ctx, rng);
    stepTransportState(war);
    stepCombat(db, war, ctx, rng);
    stepAirstrikes(db, war, ctx);
    stepRefugees(war);
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
    // Advance the gate by the ticks actually consumed instead of snapping to
    // `now` — snapping threw away `elapsed % interval` on EVERY call, which
    // on a request-driven server (serverless: ticks ride ~heartbeat-cadence
    // requests, each arriving mid-window) stretched the effective tick
    // period to interval + avg(remainder). The 250ms-driven client predicted
    // at the true rate, drifted ahead to its cap, and every rebase became a
    // 10+ tick fast-forward — the visible "rubberband" on Vercel. The
    // `now - interval` clamp keeps a long stall (idle war, hidden tab) from
    // banking unbounded catch-up debt: at most one extra backlog tick
    // survives past the burst that MAX_TICKS_PER_CALL already allows.
    war._lastTick = Math.max(last + steps * interval, now - interval);
    return any;
  }

  const api = {
    // constants other modules need
    CELL, COMBAT_RANGE, CAPTURE_RANGE, DEF_MOVE_SPEED, PLAYER_HOLD_TICKS,
    ROAD_SPEED_MULT, MAX_TICKS_PER_CALL, MAX_MANUAL_PATH_POINTS, WORLD_BORDER_INSET,
    BOMB_RADIUS, BOMB_UNIT_DMG, AIRSTRIKE_PRUNE_TICKS, WARSHIP_RANGE, WARSHIP_TRANSPORT_BONUS, NAVAL_KINDS,
    REFUGEE_MAX, REFUGEE_FADE_TICKS, REFUGEE_SPEED,
    // helpers
    isLive, dist, clamp, round1, mulberry32, tickRng,
    // geometry
    parseShape, polygonOf, pointInPolygon, provinceAt, countryAt,
    // grid / pathing / world bounds
    buildGrid, cellKey, randomProvincePoint, worldBounds, clampToWorld,
    countryIdForEntity, refreshWarZones, neutralAt, nearestNonNeutralPoint, equipMul, unitMul, isWaterAt,
    nearestWaterPoint, navalPath, ensureNavalGrid, navalWaterAt,
    transportFingerprint, getTransportGraph, computePath, setDest, setManualPath, clearDest,
    // sim
    pushEvent, killUnit, pruneCorpses, applyOrders, warTick, maybeWarTick
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.WarEngine = api;
})(typeof self !== 'undefined' ? self : this);
