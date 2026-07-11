'use strict';
// War authority layer. The SIMULATION lives in server/war-engine.js (a
// deterministic, dependency-free module shared byte-for-byte with the
// browser copy at public/js/war-engine.js — the client runs the same engine
// locally to predict between authoritative snapshots). This file is what
// remains server-only:
//   - startWar/endWar     — scenario spawning (store.uid, Math.random staging
//                           scatter, war.seed minting) and lifecycle logging
//   - dropBomb            — ORDERS a cinematic airstrike: enqueues onto
//                           war.airstrikes; the deterministic blast (unit
//                           damage, crater, event) is applied by the engine's
//                           stepAirstrikes, not here — see applyAirstrike-
//                           GroundEffects below for what stays server-only
//   - commandUnits        — thin auth shim over engine.applyOrders
//   - warTick/maybeWarTick— engine ticks bound to the SERVER ctx, so
//                           milestones write the real timeline + news wire,
//                           and a landing airstrike's ground effects
//                           (destroyed properties, cut roads) apply via the
//                           ctx.onAirstrike hook
//
// State shape, tick pipeline and tuning are documented in docs/WAR.md.
const store = require('./store');
const sim = require('./sim');
const engine = require('./war-engine');

// Interactive-layer tunables that stay server-side (bombs mutate the world
// beyond db.war, so the engine knows nothing about them). BOMB_RADIUS/
// BOMB_UNIT_DMG themselves moved INTO the engine (see war-engine.js) since
// stepAirstrikes — the deterministic blast — needs to run identically on a
// predicting client; read via engine.BOMB_RADIUS below where still needed
// (finding what a strike will destroy on the ground).
const BOMB_COOLDOWN_MS = 12000;       // per-side cooldown between airstrike orders — starts at ORDER time, not impact
const AIRSTRIKE_FLIGHT_TICKS = 4;     // ticks between order and impact — 4 × the default 2000ms tickMs ≈ 8s at 1×, within the ~6–10s cinematic window
const TUNING_MIN = 0.1, TUNING_MAX = 10; // clamp range for GM global tuning sliders (war.mods)

// GM spawn/join tunables (Feature: mid-war reinforcements) — clamp ranges
// for the /api/gm/war/spawn and /api/gm/war/join routes.
const SPAWN_MIN_COUNT = 1, SPAWN_MAX_COUNT = 12;
const SPAWN_MIN_STR = 50, SPAWN_MAX_STR = 20000;
const SPAWN_MIN_ATK = 0.2, SPAWN_MAX_ATK = 10;
const SPAWN_MIN_SPD = 0, SPAWN_MAX_SPD = 12;
const JOIN_MIN_COUNT = 1, JOIN_MAX_COUNT = 10, JOIN_DEFAULT_COUNT = 4;

const isLive = engine.isLive;
const dist = engine.dist;
const round1 = engine.round1;
function rand(a, b) { return a + Math.random() * (b - a); }

// The server ctx: engine milestones land on the real timeline and the news
// wire. A predicting client passes no ctx and gets no-ops — that asymmetry
// is the whole point of the split (predicted milestones never publish).
const SERVER_CTX = {
  log: (kind, title, body, actor, refs) => store.log(kind, title, body, actor, refs),
  news: (headline, body) => sim.draftNews(headline, body, 'Foreign', true, 'Wire Service')
};

function buildGrid(db) { return engine.buildGrid(db); }

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
  // Land invasions (`scenario.land: true`) spawn troops already on their own
  // soil, marching cross-border on tick one — no sea transit, no `landing`
  // objective (the scenario simply omits one). The engine only special-cases
  // state 'embarked'; any other non-routed state is picked up by the next AI
  // replan exactly like a unit that just finished landing (see runAI/
  // stepMovement in war-engine.js — 'moving' units with no dest just wait a
  // few ticks for the AI cycle instead of needing a dedicated code path).
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
      state: scenario.land ? 'moving' : 'embarked',
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

  // Supply corridors (Feature: resupply healing) — the point the attacker's
  // flood-fill seeds from each tick: the landing objective's position for a
  // naval scenario, or the staging box's own centre for a land:true one
  // (there is no landing objective to point at). Minted once here, like
  // `seed`, so it never drifts mid-war even if objectives/positions change.
  const landingObj = objectives.find(o => o.kind === 'landing');
  const supplyAnchor = scenario.land
    ? [(stage.x0 + stage.x1) / 2, (stage.y0 + stage.y1) / 2]
    : (landingObj ? landingObj.pos.slice() : null);

  db.war = {
    active: true, paused: false, speed: 1,
    tickMs: 2000, _lastTick: Date.now(),
    tick: 0, startedAt: new Date().toISOString(),
    // Minted ONCE here, then immutable: every tick's combat rolls and sweep
    // waypoints derive from (seed ^ tick), which is what keeps the client's
    // predicted simulation in step with the server's authoritative one.
    seed: (Math.floor(Math.random() * 0xffffffff)) >>> 0 || 1,
    scenarioId: scenario.id, name: scenario.name, attackerId: attacker.id, defenderId: defender.id,
    grid, cells: {}, units, objectives,
    supplyAnchor,
    ai: { phase: 'landing', lastPlanTick: 0, notes: [], attackerStartStrength: attackerTotal,
      consolidateFrac: (scenario.tuning || {}).consolidateFrac || 0.35,
      collapseFrac: (scenario.tuning || {}).collapseFrac || 0.12 },
    events: [],
    stats: { attLosses: 0, defLosses: 0, provinceControl: {}, citiesHeld: [] },
    bombs: { att: { cooldownUntil: 0 }, def: { cooldownUntil: 0 } },
    craters: [],
    // GM global tuning (Feature: war.mods) — defaults are also the engine's
    // fallback (`(war.mods && war.mods.dmg) || 1`), so a legacy war missing
    // this field behaves identically without needing a migration.
    mods: { dmg: 1, bombDmg: 1, hp: 1 },
    // Foreign nations that joined an ongoing war via joinWar (Feature:
    // intervention) — additive/absent-safe, mirrors `mods` above: a war doc
    // predating this feature simply has no allies of either side.
    allies: { att: [], def: [] },
    result: null
  };
  if (scenario.land) {
    engine.pushEvent(db.war, 'battle', units[0].pos, `${attacker.name} forces cross the border — invasion begins.`);
    SERVER_CTX.news(`WAR: ${attacker.name} FORCES CROSS THE BORDER`,
      `Armed columns belonging to ${attacker.name} have crossed into Arcasian territory. The government has not yet issued a statement.`);
  } else {
    engine.pushEvent(db.war, 'landing', units[0].pos, `${attacker.name} war fleet sighted offshore — invasion begins.`);
    SERVER_CTX.news(`WAR: ${attacker.name} FORCES SIGHTED OFF THE COAST`,
      `Naval assets belonging to ${attacker.name} have been sighted massing offshore. The government has not yet issued a statement.`);
  }
  store.log('event', `${attacker.name} launches an invasion`, scenario.name, 'WAR ENGINE', [attacker.id, defender.id]);
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

// ---------- player command entry point ----------
// Pure order application lives in the engine (the client applies the same
// orders optimistically); this shim only exists so api.js keeps one import.
function commandUnits(db, side, orders, actor) {
  engine.applyOrders(db, side, orders);
}

// ---------- GM unit spawner (Feature: mid-war reinforcements) ----------
// Spawns `count` fresh units of `kind` for `side` scattered in a small ring
// around `pos`, using UNIT_DEFAULTS for any stat the GM didn't override.
// Respects war.mods.hp exactly like setWarTuning's rescale (spawned strength
// is multiplied by the CURRENT hp multiplier, so a mid-war-buffed scenario
// stays consistent) and marks every unit `spawned: true` for provenance.
const SPAWN_SCATTER_R = 50; // px — random ring radius units land in around the requested point
function spawnUnits(db, opts, actor) {
  const war = db.war;
  if (!war || !war.active) return { ok: false, error: 'No war is active.' };
  const side = opts.side === 'att' ? 'att' : (opts.side === 'def' ? 'def' : null);
  if (!side) return { ok: false, error: 'Side must be att or def.' };
  const pos = opts.pos;
  const [W, H] = engine.worldBounds(war);
  if (!Array.isArray(pos) || pos.length !== 2 ||
      !Number.isFinite(Number(pos[0])) || !Number.isFinite(Number(pos[1])) ||
      pos[0] < 0 || pos[0] > W || pos[1] < 0 || pos[1] > H) {
    return { ok: false, error: 'Invalid spawn position.' };
  }
  const count = engine.clamp(Math.round(Number(opts.count) || 1), SPAWN_MIN_COUNT, SPAWN_MAX_COUNT);
  const unitDefaults = (require('./war-scenarios').UNIT_DEFAULTS) || {};
  const kind = (typeof opts.kind === 'string' && opts.kind.trim()) || 'infantry';
  const def = unitDefaults[kind] || { strength: 2000, speed: 4, atk: 1 };
  const strengthIn = Number(opts.strength);
  const baseStrength = Number.isFinite(strengthIn) ? engine.clamp(strengthIn, SPAWN_MIN_STR, SPAWN_MAX_STR) : def.strength;
  const atkIn = Number(opts.atk);
  const atk = Number.isFinite(atkIn) ? engine.clamp(atkIn, SPAWN_MIN_ATK, SPAWN_MAX_ATK) : (def.atk || 1);
  const speedIn = Number(opts.speed);
  const speed = Number.isFinite(speedIn) ? engine.clamp(speedIn, SPAWN_MIN_SPD, SPAWN_MAX_SPD) : def.speed;
  const hpMod = (war.mods && war.mods.hp) || 1;
  const strength = round1(baseStrength * hpMod);
  const namePrefix = (typeof opts.name === 'string' && opts.name.trim()) ||
    `GM-spawned ${side === 'att' ? 'Attacker' : 'Defender'} ${kind[0].toUpperCase()}${kind.slice(1)}`;

  const spawned = [];
  for (let i = 0; i < count; i++) {
    const ang = rand(0, Math.PI * 2);
    const r = rand(0, SPAWN_SCATTER_R);
    const spawnPos = engine.clampToWorld(war, [pos[0] + Math.cos(ang) * r, pos[1] + Math.sin(ang) * r]);
    const u = {
      id: store.uid('warunit'), side,
      name: count > 1 ? `${namePrefix} ${i + 1}` : namePrefix,
      kind, pos: spawnPos, dest: null,
      strength, maxStrength: strength, org: 100,
      speed, atk, state: 'holding', objectiveId: null,
      garrison: side === 'def' && kind === 'garrison',
      spawned: true
    };
    war.units.push(u);
    spawned.push(u.id);
  }
  engine.pushEvent(war, 'milestone', pos.slice(), `${count} ${kind} unit${count === 1 ? '' : 's'} deployed for the ${side === 'att' ? 'attacker' : 'defender'} by GM order.`);
  store.log('gm', `GM spawned ${count} unit${count === 1 ? '' : 's'}`,
    `${kind} × ${count} for the ${side === 'att' ? 'attacker' : 'defender'} at (${Math.round(pos[0])}, ${Math.round(pos[1])})`,
    actor || 'WAR ENGINE', []);
  return { ok: true, unitIds: spawned };
}

// ---------- foreign intervention (Feature: nation joins an ongoing war) ----------
function toRoman(n) {
  const table = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, sym] of table) while (n >= v) { out += sym; n -= v; }
  return out || 'I';
}
// A joining nation's contingent lands near the attacker's existing staging
// (any live attacker unit's position — the original scenario staging box is
// not kept on war.war after startWar, so an existing unit is the simplest
// live anchor) or, for the defence, near the capital / any held city.
function joinEntryPoint(db, war, side) {
  const [W, H] = engine.worldBounds(war);
  if (side === 'att') {
    const anchor = war.units.find(u => u.side === 'att' && isLive(u)) || war.units.find(u => u.side === 'att');
    return anchor ? anchor.pos.slice() : [W / 2, 40];
  }
  const capital = db.cities.find(c => c.isCapital && c.pos) || db.cities.find(c => c.pos);
  return capital ? capital.pos.slice() : [W / 2, H / 2];
}
function joinWar(db, opts, actor) {
  const war = db.war;
  if (!war || !war.active) return { ok: false, error: 'No war is active.' };
  const side = opts.side === 'att' ? 'att' : (opts.side === 'def' ? 'def' : null);
  if (!side) return { ok: false, error: 'Side must be att or def.' };
  const entity = db.entities.find(e => e.id === opts.entityId);
  if (!entity || entity.type !== 'foreign') return { ok: false, error: 'Unknown foreign power.' };
  if (entity.id === war.attackerId) return { ok: false, error: `${entity.name} is already the attacker.` };
  if (entity.id === war.defenderId) return { ok: false, error: `${entity.name} is already the defender.` };
  war.allies = war.allies || { att: [], def: [] };
  war.allies.att = war.allies.att || []; war.allies.def = war.allies.def || [];
  if (war.allies.att.includes(entity.id) || war.allies.def.includes(entity.id)) {
    return { ok: false, error: `${entity.name} has already entered the war.` };
  }

  const count = engine.clamp(Math.round(Number(opts.count) || JOIN_DEFAULT_COUNT), JOIN_MIN_COUNT, JOIN_MAX_COUNT);
  const unitDefaults = (require('./war-scenarios').UNIT_DEFAULTS) || {};
  const def = unitDefaults.infantry || { strength: 2100, speed: 3.2, atk: 1 };
  const hpMod = (war.mods && war.mods.hp) || 1;
  const strength = round1(def.strength * hpMod);
  const entryPos = joinEntryPoint(db, war, side);

  const spawned = [];
  for (let i = 0; i < count; i++) {
    const ang = rand(0, Math.PI * 2);
    const r = rand(40, 100);
    const pos = engine.clampToWorld(war, [entryPos[0] + Math.cos(ang) * r, entryPos[1] + Math.sin(ang) * r]);
    const u = {
      id: store.uid('warunit'), side,
      name: `${entity.name} Expeditionary ${toRoman(i + 1)}`,
      kind: side === 'att' ? 'infantry' : 'garrison',
      pos, dest: null, strength, maxStrength: strength, org: 100,
      speed: side === 'att' ? (def.speed || 3.2) : 0,
      atk: def.atk || 1, state: 'holding', objectiveId: null,
      nationId: entity.id, garrison: side === 'def', spawned: true
    };
    war.units.push(u);
    spawned.push(u.id);
  }
  war.allies[side].push(entity.id);

  const attackerEnt = db.entities.find(e => e.id === war.attackerId);
  const defenderEnt = db.entities.find(e => e.id === war.defenderId);
  const sideEnt = side === 'att' ? attackerEnt : defenderEnt;
  const sideName = sideEnt ? sideEnt.name : (side === 'att' ? 'the attacker' : 'the defender');
  engine.pushEvent(war, 'milestone', entryPos.slice(), `${entity.name} enters the war on the side of ${sideName}.`);
  store.log('event', `${entity.name} enters the war`,
    `${entity.name} commits ${count} unit(s) on the side of ${sideName}.`, actor || 'WAR ENGINE', [entity.id]);
  SERVER_CTX.news(`${entity.name.toUpperCase()} ENTERS THE WAR`,
    `${entity.name} has entered the conflict on the side of ${sideName}. An expeditionary contingent is reported joining the front.`);
  return { ok: true, unitIds: spawned };
}

// ---------- GM global tuning (Feature: war.mods) ----------
// Combat/bomb damage multipliers are read defensively straight off war.mods
// by the engine (server/war.js's bomb path too, above) — this function's only
// real job is the HP multiplier, which has to reach INTO every live unit
// immediately (unlike dmg/bombDmg, which just get read fresh next fight):
// scaling strength/maxStrength by the RATIO of new/old keeps each unit's
// current damage fraction (e.g. a unit at 40% HP stays at 40% HP after a
// rescale) rather than resetting everyone to full.
function setWarTuning(db, patch, actor) {
  const war = db.war;
  if (!war) return { ok: false, error: 'No war is active.' };
  war.mods = war.mods || { dmg: 1, bombDmg: 1, hp: 1 };
  const clampMod = (v) => engine.clamp(Number(v), TUNING_MIN, TUNING_MAX);
  const changes = [];
  if (patch.dmg !== undefined && Number.isFinite(Number(patch.dmg))) {
    war.mods.dmg = clampMod(patch.dmg);
    changes.push(`dmg=${war.mods.dmg}×`);
  }
  if (patch.bombDmg !== undefined && Number.isFinite(Number(patch.bombDmg))) {
    war.mods.bombDmg = clampMod(patch.bombDmg);
    changes.push(`bombDmg=${war.mods.bombDmg}×`);
  }
  if (patch.hp !== undefined && Number.isFinite(Number(patch.hp))) {
    const newHp = clampMod(patch.hp);
    const oldHp = war.mods.hp || 1;
    if (newHp !== oldHp) {
      const ratio = newHp / oldHp;
      for (const u of war.units) {
        if (!isLive(u)) continue;
        u.strength = round1(u.strength * ratio);
        u.maxStrength = round1((u.maxStrength || u.strength) * ratio);
      }
    }
    war.mods.hp = newHp;
    changes.push(`hp=${war.mods.hp}×`);
  }
  if (changes.length) store.log('gm', 'War tuning updated', changes.join(' '), actor || 'WAR ENGINE', []);
  return { ok: true, mods: war.mods };
}

// The airstrike's launch point: the seed's airport property (kind:'airport')
// at its CURRENT position — properties move (GM map edits) and can be
// destroyed outright (bombs level properties, including airports, so this is
// a real case), hence the fallback chain: capital city, then a fixed
// map-edge point derived from the war's own grid bounds (always in range).
function findAirstrikeOrigin(db) {
  const airport = (db.properties || []).find(p => p.kind === 'airport' && p.pos);
  if (airport) return airport.pos.slice();
  const capital = db.cities.find(c => c.isCapital && c.pos) || db.cities.find(c => c.pos);
  if (capital) return capital.pos.slice();
  const inset = engine.WORLD_BORDER_INSET || 8;
  return [inset, inset];
}

// ---------- dropBomb: ORDERS an airstrike (Feature: cinematic two-phase bombing) ----------
// Only ENQUEUES the strike onto war.airstrikes — the deterministic blast
// (unit damage, crater, event) and the strike's done:true flip happen in the
// engine's stepAirstrikes at war.tick >= strikeTick, so a predicting client
// detonates it on the same tick as the server. This function keeps the same
// name/route/auth/cooldown contract the client already calls.
function dropBomb(db, side, pos, actor) {
  // Bombs are DEFENDER-ONLY — the attacker AI never calls in an airstrike,
  // and even a GM commanding the attacker side directly has no air arm. This
  // is enforced here, not just hidden client-side, since the client is
  // untrusted.
  if (side !== 'def') return { ok: false, error: 'Only the defence has an air arm in this scenario.' };
  const war = db.war;
  if (!war || !war.active || war.paused) return { ok: false, error: 'No war is active.' };
  war.bombs = war.bombs || { att: { cooldownUntil: 0 }, def: { cooldownUntil: 0 } };
  const bomb = war.bombs[side] = war.bombs[side] || { cooldownUntil: 0 };
  const now = Date.now();
  if (now < bomb.cooldownUntil) return { ok: false, error: 'Bomb is on cooldown.' };
  if (!Array.isArray(pos) || pos.length !== 2) return { ok: false, error: 'Invalid target position.' };
  // Cooldown starts at ORDER time, same as the old instant bomb — a player
  // can't spam strikes just because the last one hasn't landed yet.
  bomb.cooldownUntil = now + BOMB_COOLDOWN_MS;

  war.airstrikes = war.airstrikes || [];
  const strike = {
    id: store.uid('airstrike'),
    side,
    pos: pos.slice(),
    from: findAirstrikeOrigin(db),
    orderedTick: war.tick,
    strikeTick: war.tick + AIRSTRIKE_FLIGHT_TICKS,
    orderedAt: now,
    done: false,
    groundApplied: false // guards applyAirstrikeGroundEffects against double-application
  };
  war.airstrikes.push(strike);
  return { ok: true, strike };
}

// ---------- authority-only ground effects, wired via ctx.onAirstrike ----------
// Everything the engine must NOT do (a predicting client's ctx omits this
// hook entirely — see war-engine.js's normCtx): destroying properties in the
// blast radius, cutting roads, and the audit-log entries for both. Called
// from the server's tick binding (see ctxFor below) the instant a strike
// crosses done:false → true. Idempotent via strike.groundApplied — the
// engine only calls this once per strike, but a defensive guard costs
// nothing and protects against any future double-tick edge case.
function applyAirstrikeGroundEffects(db, war, strike) {
  if (strike.groundApplied) return;
  strike.groundApplied = true;
  const pos = strike.pos;
  const radius = engine.BOMB_RADIUS;

  // Destroy properties within the blast; sync the deed mirror ONCE after —
  // properties are never hand-deleted from the deed register (see
  // docs/CONVENTIONS.md's canonical-record-+-mirror table).
  const destroyed = [];
  db.properties = (db.properties || []).filter(p => {
    if (!p.pos || dist(p.pos, pos) > radius) return true;
    destroyed.push(p);
    return false;
  });
  if (destroyed.length) {
    require('./deeds').syncAllDeeds(db);
    for (const p of destroyed) {
      store.log('event', `${p.name} destroyed`, 'Levelled by aerial bombardment', 'WAR ENGINE', []);
    }
  }

  // Cut roads: strip points within the blast, split surviving runs.
  const roads = ((db.settings || {}).map || {}).roads || [];
  const nextRoads = [];
  let roadsCut = 0;
  for (const r of roads) {
    const pts = r.pts || [];
    const inBlast = pts.some(p => dist(p, pos) <= radius);
    if (!inBlast) { nextRoads.push(r); continue; }
    roadsCut++;
    let run = [];
    const runs = [];
    for (const p of pts) {
      if (dist(p, pos) <= radius) { if (run.length) runs.push(run); run = []; }
      else run.push(p);
    }
    if (run.length) runs.push(run);
    for (const run2 of runs) if (run2.length >= 2) nextRoads.push({ id: store.uid('road'), pts: run2 });
  }
  if (roadsCut) {
    db.settings = db.settings || {}; db.settings.map = db.settings.map || {};
    db.settings.map.roads = nextRoads;
  }

  if (destroyed.length || roadsCut) {
    store.log('event', 'Airstrike impact',
      `${destroyed.length} structure${destroyed.length === 1 ? '' : 's'} levelled` +
      (roadsCut ? `, ${roadsCut} road${roadsCut === 1 ? '' : 's'} cut` : '') + '.',
      'WAR ENGINE', []);
  }
}

// ---------- ticks (engine bound to the server ctx) ----------
// onAirstrike needs `db` (to mutate db.properties/settings.map.roads), which
// log/news don't — SERVER_CTX stays a static object for those two, and this
// binds a fresh onAirstrike closure over the per-call `db` each tick.
function ctxFor(db) {
  return {
    log: SERVER_CTX.log,
    news: SERVER_CTX.news,
    onAirstrike: (war, strike) => applyAirstrikeGroundEffects(db, war, strike)
  };
}
function warTick(db) { return engine.warTick(db, ctxFor(db)); }
function maybeWarTick(db) { return engine.maybeWarTick(db, ctxFor(db)); }

// Milestone fingerprint — the changes worth a GLOBAL sync broadcast. Routine
// tick-to-tick churn (positions, strengths, cells) is delivered to
// war-watching clients by their own /api/war/state heartbeat; broadcasting
// every tick made every connected client refetch the full world at up to
// 1Hz during a war, which is what turned a fast war into a laggy app.
function milestoneKey(war) {
  if (!war) return 'none';
  return [
    war.active ? 1 : 0,
    war.result ? 1 : 0,
    war.objectives.filter(o => o.status === 'done').length,
    (war.stats.citiesHeld || []).length
  ].join(':');
}

// Tick + tell the caller how loudly to signal: save on any tick (the commit
// is what heartbeat pollers read), broadcast only on a milestone.
function maybeWarTickSignal(db) {
  const before = milestoneKey(db.war);
  const ticked = maybeWarTick(db);
  return { ticked, milestone: ticked && milestoneKey(db.war) !== before };
}

module.exports = { startWar, endWar, warTick, maybeWarTick, maybeWarTickSignal, buildGrid, dropBomb, commandUnits, setWarTuning, spawnUnits, joinWar, isLive };
