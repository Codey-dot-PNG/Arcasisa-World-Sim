'use strict';
// Deterministic divergence harness for the war client-prediction pipeline
// (see docs/WAR.md "Client-side prediction (Phase 18)"). Ticks a "server"
// copy of the shared engine (server/war-engine.js — the exact module
// server/war.js requires), replays the same order/airstrike sequence the
// browser client would send, and separately runs a PORTED copy of
// public/js/war.js's _rebase/_dropBomb/_optimistic logic against snapshots
// delivered on a scripted schedule — including a deliberately RACED snapshot
// that predates an airstrike order, reproducing the exact race a war
// heartbeat (GET /api/war/state) already in flight when POST /api/war/bomb
// resolves can hit. No network, no running server needed.
//
//   node tools/war-divergence-check.js
//
// This is a measurement tool, not a unit test framework — it prints
// before/after divergence numbers with the strikeOutbox fix toggled, and
// exits non-zero if the fix regresses. Keep the ported rebase logic below in
// sync BY EYE with public/js/war.js if that file's _rebase/_dropBomb changes
// shape — it's a faithful port for measurement purposes, not a shared module
// (public/js/war.js is browser-only: DOM, S(), GameMap, etc).

const engine = require('../server/war-engine.js');

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

function freshWar(seed) {
  return {
    active: true, paused: false, speed: 1, tickMs: 2000, _lastTick: 0,
    tick: 0, startedAt: '2026-01-01T00:00:00.000Z', seed,
    scenarioId: 'test', name: 'Divergence Test', attackerId: 'for_test', defenderId: 'ent_gov',
    grid: { cell: 48, cols: 80, rows: 45, provinceLandCells: {}, provinceCells: {}, totalLandCells: 0 },
    cells: {},
    units: [
      { id: 'u_att1', side: 'att', name: 'Att 1', kind: 'infantry', pos: [500, 500], dest: null, path: null, pathIdx: 0, strength: 3000, maxStrength: 3000, org: 90, speed: 4, atk: 1, state: 'moving', objectiveId: null },
      { id: 'u_att2', side: 'att', name: 'Att 2', kind: 'armored', pos: [520, 540], dest: null, path: null, pathIdx: 0, strength: 4000, maxStrength: 4000, org: 90, speed: 5, atk: 1.2, state: 'moving', objectiveId: null },
      { id: 'u_def1', side: 'def', name: 'Def 1', kind: 'garrison', pos: [1500, 900], dest: null, strength: 3500, maxStrength: 3500, org: 100, speed: 0, atk: 1, state: 'holding', objectiveId: null, garrison: true },
    ],
    // A never-completing dummy objective — checkVictory's `every()` over an
    // EMPTY objectives array is vacuously true, which would end the war on
    // tick 1. `ref` points at a city that doesn't exist in this harness's
    // empty `db.cities`, so stepObjectives's `if (!city) continue` leaves it
    // pending forever (see server/war-engine.js's stepObjectives).
    objectives: [{ id: 'dummy_obj', kind: 'seize_city', ref: 'city_none', pos: [0, 0], priority: 1, status: 'pending', holdTicks: 0 }],
    events: [], craters: [],
    stats: { attLosses: 0, defLosses: 0, provinceControl: {}, citiesHeld: [] },
    bombs: { att: { cooldownUntil: 0 }, def: { cooldownUntil: 0 } },
    airstrikes: [],
    mods: { dmg: 1, bombDmg: 1, hp: 1 },
    allies: { att: [], def: [] },
    result: null
  };
}
const DB_SHELL = { provinces: [], cities: [], settings: { map: { roads: [], rails: [] } } };
function dbLike(war) { return Object.assign({ war }, DB_SHELL); }

const NOOP_CTX = {};                        // predicting client: no hooks (matches normCtx defaults)
const SERVER_CTX = { onAirstrike: (war, strike) => { strike.groundApplied = true; } };

// ---- ported client prediction (mirrors public/js/war.js's War._rebase / War._optimistic / War._dropBomb) ----
function makeClient() { return { pred: null }; }

function clientRebase(client, auth, fixEnabled, now) {
  const prev = client.pred;
  if (prev && prev.war && auth.startedAt === prev.war.startedAt &&
      typeof auth.tick === 'number' && auth.tick < prev.baseTick) { prev.authRef = auth; return; }
  const war = deepClone(auth);
  const sameWar = !!(prev && prev.war && prev.war.startedAt === war.startedAt);

  // FIX under test: re-splice any outbox airstrike this snapshot doesn't
  // know about yet, BEFORE the fast-forward — see public/js/war.js's
  // _rebase comment for the full race description.
  const prevStrikeOutbox = (prev && prev.strikeOutbox) || [];
  const strikeOutbox = prevStrikeOutbox.filter(o => o.exp > now && !(auth.airstrikes || []).some(s => s.id === o.strike.id));
  if (fixEnabled && strikeOutbox.length) {
    war.airstrikes = war.airstrikes || [];
    for (const o of strikeOutbox) if (!war.airstrikes.some(s => s.id === o.strike.id)) war.airstrikes.push(deepClone(o.strike));
  }

  if (sameWar && war.active && !war.paused && prev.war.tick > (war.tick || 0)) {
    const ahead = Math.min(prev.war.tick - (war.tick || 0), 12);
    const dl = dbLike(war);
    for (let i = 0; i < ahead && war.active && !war.paused; i++) engine.warTick(dl, NOOP_CTX);
  }
  war._lastTick = now;

  const outbox = (prev ? prev.outbox : []).filter(o => o.exp > now);
  client.pred = { war, authRef: auth, baseTick: auth.tick || 0, lastAuthTick: auth.tick || 0, outbox: [], strikeOutbox: fixEnabled ? strikeOutbox : [] };
  const unconfirmed = outbox.filter(o => {
    const u = war.units.find(x => x.id === o.unitId);
    return !(u && u.dest && Math.hypot(u.dest[0] - o.dest[0], u.dest[1] - o.dest[1]) < 2);
  });
  for (const o of unconfirmed) {
    const order = o.path ? { unitId: o.unitId, path: o.path } : { unitId: o.unitId, dest: o.dest };
    engine.applyOrders(dbLike(war), o.side, [order]);
  }
  client.pred.outbox = unconfirmed;
}

function clientOptimisticOrder(client, side, orders, now) {
  if (!client.pred) return;
  engine.applyOrders(dbLike(client.pred.war), side, orders);
  const exp = now + 5000;
  for (const o of orders) {
    const dest = (Array.isArray(o.path) && o.path.length) ? o.path[o.path.length - 1] : o.dest;
    client.pred.outbox.push({ side, unitId: o.unitId, dest, path: o.path || null, exp });
  }
}

function clientOptimisticStrike(client, strike, now, fixEnabled) {
  if (!client.pred) return;
  const war = client.pred.war;
  war.airstrikes = war.airstrikes || [];
  if (!war.airstrikes.some(s => s.id === strike.id)) war.airstrikes.push(deepClone(strike));
  if (fixEnabled) (client.pred.strikeOutbox = client.pred.strikeOutbox || []).push({ strike: deepClone(strike), exp: now + 8000 });
}

function clientLocalTick(client) {
  if (!client.pred) return;
  const war = client.pred.war;
  if (!war.active || war.paused) return;
  if (war.tick - (client.pred.lastAuthTick || 0) >= 10) return;
  engine.warTick(dbLike(war), NOOP_CTX);
}

// ---- scripted scenario ----
// Tick 5: a manual (right-drag) path order.
// Tick 9: capture the "in-flight heartbeat response body" (no strike yet).
// Tick 10: a bomb is ordered — server enqueues it AND the client splices it
//          in optimistically (mirrors the POST /api/war/bomb response).
// Tick 11: the RACED heartbeat resolves with the tick-9 snapshot — this is
//          the exact scenario the fix targets.
// Tick 15/20/...: normal, up-to-date heartbeats.
function run(fixEnabled) {
  const server = freshWar(0xC0FFEE);
  const client = makeClient();
  clientRebase(client, deepClone(server), fixEnabled, 0); // initial snapshot at tick 0

  let maxPosDivergence = 0, maxStrDivergence = 0;
  let strikeGapTicks = 0;
  let strikeOrderedTick = null, strikeConfirmedTick = null, strikeId = null;
  let snap9 = null;

  const TOTAL_TICKS = 30;
  let simTime = 0;
  for (let t = 1; t <= TOTAL_TICKS; t++) {
    simTime += 100; // ms per simulated tick
    engine.warTick(dbLike(server), SERVER_CTX);

    if (t === 5) {
      const path = [[600, 600], [900, 700], [1300, 850]];
      engine.applyOrders(dbLike(server), 'att', [{ unitId: 'u_att1', path }]);
      clientOptimisticOrder(client, 'att', [{ unitId: 'u_att1', path }], simTime);
    }
    if (t === 9) snap9 = deepClone(server);
    if (t === 10) {
      strikeId = 'strike_test';
      const strike = { id: strikeId, side: 'def', pos: [520, 540], from: [50, 50], orderedTick: server.tick, strikeTick: server.tick + 4, orderedAt: simTime, done: false, groundApplied: false };
      server.airstrikes.push(strike);
      strikeOrderedTick = t;
      clientOptimisticStrike(client, strike, simTime, fixEnabled);
    }
    if (t === 11) clientRebase(client, snap9, fixEnabled, simTime); // the raced, stale response

    clientLocalTick(client);
    if (t % 5 === 0 && t !== 10 && t !== 11) clientRebase(client, deepClone(server), fixEnabled, simTime);

    if (client.pred && client.pred.war.tick === server.tick) {
      for (const su of server.units) {
        const cu = client.pred.war.units.find(u => u.id === su.id);
        if (!cu) continue;
        maxPosDivergence = Math.max(maxPosDivergence, Math.hypot(su.pos[0] - cu.pos[0], su.pos[1] - cu.pos[1]));
        maxStrDivergence = Math.max(maxStrDivergence, Math.abs(su.strength - cu.strength));
      }
    }
    if (strikeId && !strikeConfirmedTick) {
      const present = client.pred && (client.pred.war.airstrikes || []).some(s => s.id === strikeId);
      if (!present) strikeGapTicks++;
      const serverStrike = server.airstrikes.find(s => s.id === strikeId);
      if (serverStrike && serverStrike.done) strikeConfirmedTick = t;
    }
  }

  return { maxPosDivergence: Math.round(maxPosDivergence * 100) / 100, maxStrDivergence: Math.round(maxStrDivergence * 100) / 100, strikeGapTicks, strikeOrderedTick, strikeConfirmedTick };
}

console.log('War prediction divergence check — server/war-engine.js vs a ported public/js/war.js rebase\n');
const before = run(false);
const after = run(true);
console.log('Without strikeOutbox fix:', before);
console.log('With    strikeOutbox fix:', after);

let ok = true;
if (before.strikeGapTicks > 0 && after.strikeGapTicks === 0) {
  console.log('\nPASS — strikeOutbox fix eliminates the airstrike-disappears-after-a-raced-snapshot gap (' +
    before.strikeGapTicks + ' tick(s) of gap before the fix, 0 after).');
} else if (before.strikeGapTicks === 0) {
  console.log('\nWARN — this scripted race did not reproduce a gap even without the fix; timing constants may need adjustment to keep covering the regression.');
  ok = false;
} else {
  console.log('\nFAIL — the fix did not eliminate the gap.');
  ok = false;
}
console.log('\nPosition/strength divergence stays near-zero in both runs because every measurement point follows a rebase — ' +
  'the fix targets VISIBLE CONTINUITY of an in-flight strike, not steady-state positional divergence, which the ' +
  'existing rebase/fast-forward machinery already keeps tight.');
process.exit(ok ? 0 : 1);
