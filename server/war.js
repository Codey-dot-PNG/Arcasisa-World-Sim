'use strict';
// War authority layer. The SIMULATION lives in server/war-engine.js (a
// deterministic, dependency-free module shared byte-for-byte with the
// browser copy at public/js/war-engine.js — the client runs the same engine
// locally to predict between authoritative snapshots). This file is what
// remains server-only:
//   - startWar/endWar     — scenario spawning (store.uid, Math.random staging
//                           scatter, war.seed minting) and lifecycle logging
//   - dropBomb            — mutates db.properties/roads and syncs deeds
//   - commandUnits        — thin auth shim over engine.applyOrders
//   - warTick/maybeWarTick— engine ticks bound to the SERVER ctx, so
//                           milestones write the real timeline + news wire
//
// State shape, tick pipeline and tuning are documented in docs/WAR.md.
const store = require('./store');
const sim = require('./sim');
const engine = require('./war-engine');

// Interactive-layer tunables that stay server-side (bombs mutate the world
// beyond db.war, so the engine knows nothing about them).
const BOMB_RADIUS = 95;               // px — blast radius
const BOMB_UNIT_DMG = 90;             // max strength damage at the blast centre (falls off to 0 at BOMB_RADIUS)
const BOMB_COOLDOWN_MS = 12000;       // per-side cooldown between bomb drops

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
    // Minted ONCE here, then immutable: every tick's combat rolls and sweep
    // waypoints derive from (seed ^ tick), which is what keeps the client's
    // predicted simulation in step with the server's authoritative one.
    seed: (Math.floor(Math.random() * 0xffffffff)) >>> 0 || 1,
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
  engine.pushEvent(db.war, 'landing', units[0].pos, `${attacker.name} war fleet sighted in the Strait — invasion begins.`);
  store.log('event', `${attacker.name} launches an invasion`, scenario.name, 'WAR ENGINE', [attacker.id, defender.id]);
  SERVER_CTX.news(`WAR: ${attacker.name} FORCES SIGHTED OFF THE COAST`,
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

// ---------- player command entry point ----------
// Pure order application lives in the engine (the client applies the same
// orders optimistically); this shim only exists so api.js keeps one import.
function commandUnits(db, side, orders, actor) {
  engine.applyOrders(db, side, orders);
}

// Falloff 1 at blast centre → 0 at BOMB_RADIUS.
function bombFalloff(d) { return engine.clamp(1 - d / BOMB_RADIUS, 0, 1); }

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
    if (u.strength <= 0) engine.killUnit(war, u);
  }
  engine.pruneCorpses(war);

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
  engine.pushEvent(war, 'battle', pos.slice(), `Bombing run — ${destroyed.length} structure${destroyed.length === 1 ? '' : 's'} levelled.`);

  return { ok: true };
}

// ---------- ticks (engine bound to the server ctx) ----------
function warTick(db) { return engine.warTick(db, SERVER_CTX); }
function maybeWarTick(db) { return engine.maybeWarTick(db, SERVER_CTX); }

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

module.exports = { startWar, endWar, warTick, maybeWarTick, maybeWarTickSignal, buildGrid, dropBomb, commandUnits, isLive };
