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
const geometry = require('./geometry');

// ---------- occupation devastation (Phase 22) ----------
// AUTHORITY-ONLY, like ctx.onAirstrike: everything here mutates the world
// beyond db.war (province populations, demographics), so a predicting client
// never runs it — the tick wrappers at the bottom of this file call
// applyDevastation after each real engine tick. All numbers are data:
// settings.war overrides any of these defaults (engine-generic, rule 7).
const DEVASTATION_DEFAULTS = {
  civPerFightTick: 6,      // civilians killed per FIGHTING unit per tick, scaled by unit strength/2000
  civPerStrike: 500,       // civilians killed by one airstrike impact (× war.mods.bombDmg)
  refugeeStages: [25, 50, 75, 95], // provinceControl % thresholds that trigger a flight wave
  refugeeFrac: 0.05,       // fraction of a province's remaining population fleeing per wave
  civNewsEvery: 15000      // wire piece every N cumulative civilian deaths
};
// Equipment/resupply knobs (Phase 26) — same override rule as devastation:
// settings.war wins over any of these.
const EQUIP_DEFAULTS = {
  fuelPerStrength: 0.01,   // fuel units a unit's full tank holds per point of strength
  fuelBurnFrac: 0.02,      // fraction of a full tank burned per authoritative call while moving/fighting
  // What the UNARMED fraction of a unit is worth (fists vs rifles): each
  // soldier without a gun contributes these factors to the unit's kit
  // instead of the armed 1×(+weapon stats). A fully unarmed division deals a
  // quarter damage, takes double (hp 0.5) and breaks three times faster.
  unarmedDmg: 0.25,
  unarmedHp: 0.5,
  unarmedMorale: 0.3
};
function warCfg(db) { return Object.assign({}, DEVASTATION_DEFAULTS, EQUIP_DEFAULTS, (db.settings && db.settings.war) || {}); }

// Population changes always move vars.population AND demographics together
// (pro-rata), so the election model sees the same world the map does.
function scalePopulation(prov, ratio) {
  for (const g in (prov.demographics || {})) {
    const grp = prov.demographics[g];
    if (grp && Number.isFinite(Number(grp.population))) grp.population = Math.max(0, Math.round(grp.population * ratio));
  }
}
function killCivilians(db, war, provId, amount) {
  const prov = db.provinces.find(p => p.id === provId);
  if (!prov || !(amount > 0)) return 0;
  const pop = Math.max(0, Math.round(Number(prov.vars.population) || 0));
  const loss = Math.min(pop, Math.round(amount));
  if (!loss) return 0;
  prov.vars.population = pop - loss;
  scalePopulation(prov, (pop - loss) / (pop || 1));
  war.stats.civilianDeaths = (war.stats.civilianDeaths || 0) + loss;
  return loss;
}
// A flight wave: frac of the source province's people move "inward" — split
// across the up-to-3 LEAST-occupied other provinces, weighted equally.
function moveRefugees(db, war, sourceProv, frac) {
  if (!sourceProv) return 0;
  const pop = Math.max(0, Math.round(Number(sourceProv.vars.population) || 0));
  const moving = Math.round(pop * frac);
  if (!moving) return 0;
  const ctl = war.stats.provinceControl || {};
  const dests = db.provinces
    .filter(p => p.id !== sourceProv.id)
    .sort((a, b) => (ctl[a.id] || 0) - (ctl[b.id] || 0))
    .slice(0, 3);
  if (!dests.length) return 0;
  sourceProv.vars.population = pop - moving;
  scalePopulation(sourceProv, (pop - moving) / (pop || 1));
  const share = Math.floor(moving / dests.length);
  for (const d of dests) {
    const dPop = Math.max(0, Math.round(Number(d.vars.population) || 0));
    d.vars.population = dPop + share;
    scalePopulation(d, dPop ? (dPop + share) / dPop : 1);
  }
  war.stats.refugees = (war.stats.refugees || 0) + moving;
  return moving;
}
function applyDevastation(db) {
  const war = db.war;
  if (!war || !war.active) return;
  const cfg = warCfg(db);
  war.stats._refStage = war.stats._refStage || {};

  // 1. Ground combat kills civilians where the fighting is.
  const tolls = {};
  for (const u of war.units) {
    if (!isLive(u) || u.state !== 'fighting') continue;
    const pid = geometry.provinceAt(db.provinces, u.pos);
    if (!pid) continue;
    tolls[pid] = (tolls[pid] || 0) + cfg.civPerFightTick * Math.max(0.3, (u.strength || 0) / 2000);
  }
  for (const pid in tolls) killCivilians(db, war, pid, tolls[pid]);

  // 2. Occupation crossing a threshold sends a refugee wave inward.
  const ctl = war.stats.provinceControl || {};
  for (const pid in ctl) {
    const stages = cfg.refugeeStages;
    let stage = war.stats._refStage[pid] || 0;
    while (stage < stages.length && (ctl[pid] || 0) >= stages[stage]) {
      stage++;
      const prov = db.provinces.find(p => p.id === pid);
      const moved = moveRefugees(db, war, prov, cfg.refugeeFrac);
      if (moved > 0 && prov) {
        store.log('event', `Refugees flee ${prov.name}`,
          `${moved.toLocaleString('en-US')} civilians flee inward as occupation of ${prov.name} reaches ${ctl[pid]}%.`,
          'WAR ENGINE', []);
        SERVER_CTX.news(`COLUMNS OF REFUGEES POUR OUT OF ${prov.name.toUpperCase()}`,
          `An estimated ${moved.toLocaleString('en-US')} civilians are on the roads out of ${prov.name} as the front advances. Interior provinces are opening schools and church halls to the displaced.`);
      }
    }
    war.stats._refStage[pid] = stage;
  }

  // 3. Periodic wire coverage of the mounting toll.
  const civ = war.stats.civilianDeaths || 0;
  if (civ - (war.stats._civNewsAt || 0) >= cfg.civNewsEvery) {
    war.stats._civNewsAt = civ;
    SERVER_CTX.news('CIVILIAN TOLL OF THE WAR MOUNTS',
      `Officials now put the number of civilians killed since the invasion began at more than ${Math.round(civ / 1000) * 1000}. Hospitals near the front report they are past capacity.`);
  }
}

// ---------- equipment & resupply (Phase 26: per-unit kit) ----------
// An army fights with what each COLUMN actually carries, not with a national
// average. Guns and fuel are ordinary tradable items with meta.weapon stats
// (the GM mints new models from the item template and edits stats freely);
// every unit holds its own inventory (u.inv — the same {itemId, qty} row
// shape as entity inventories) and its combat multipliers (u.kit) are folded
// from THAT before every authoritative tick:
//   Small arms (kind != 'smallarms' is fuel): the unit's soldiers are armed
//   best-gun-first from its own packs; each model contributes its stats ×
//   the fraction of THIS unit it arms.
//   Fuel: mobility scales with how full the unit's tank is (full tank =
//   strength × settings.war.fuelPerStrength) × the best fuel grade carried.
// Resupply is the physical link to the item economy: a unit inside its
// side's supply corridor (u.supplied — the engine's stepSupply verdict from
// last tick) tops up to one gun per soldier and refills its tank, DRAWN DOWN
// from its own nation's stockpile — the entity inventory of u.nationId
// (falling back to the side's principal belligerent); Republic units also
// eat from military-property depots. Casualties destroy their weapons and
// movement burns fuel, so a long war drains national arsenals tick by tick —
// which is exactly what makes an arms factory (or an ally's shipments) war
// infrastructure.
// AUTHORITY-ONLY, like applyDevastation: stockpiles live outside db.war, so
// a predicting client never runs this — it replays the u.kit multipliers
// carried in war state (see war-engine.js unitMul).
function weaponCatalog(db) {
  const guns = [], fuels = [];
  for (const it of db.items) {
    if (!(it.meta && it.meta.weapon)) continue;
    if ((it.meta.weapon.kind || 'smallarms') === 'fuel') fuels.push(it); else guns.push(it);
  }
  guns.sort((a, b) => (Number(b.meta.weapon.dmg) || 0) - (Number(a.meta.weapon.dmg) || 0));
  fuels.sort((a, b) => (Number(b.meta.weapon.speed) || 0) - (Number(a.meta.weapon.speed) || 0));
  return { guns, fuels };
}
function invGet(inv, itemId) { return inv.find(r => r.itemId === itemId); }
function invAdd(inv, itemId, qty) {
  if (!(qty > 0)) return;
  const row = invGet(inv, itemId);
  if (row) row.qty = (row.qty || 0) + qty; else inv.push({ itemId, qty });
}
// Take up to qty of itemId out of inv; returns how much actually came out.
function invTake(inv, itemId, qty) {
  const row = invGet(inv, itemId);
  if (!row || !(row.qty > 0) || !(qty > 0)) return 0;
  const take = Math.min(row.qty, qty);
  row.qty -= take;
  if (row.qty <= 0) inv.splice(inv.indexOf(row), 1);
  return take;
}
function nationPools(db, war, nationId) {
  const pools = [];
  const e = db.entities.find(x => x.id === nationId);
  if (e) { e.inventory = e.inventory || []; pools.push(e.inventory); }
  // the defending nation also draws on its military depots
  if (nationId === war.defenderId) {
    for (const p of db.properties) if (p.type === 'military' && Array.isArray(p.inventory)) pools.push(p.inventory);
  }
  return pools;
}
function drawFromPools(pools, itemId, qty) {
  let got = 0;
  for (const pool of pools) {
    if (got >= qty) break;
    got += invTake(pool, itemId, qty - got);
  }
  return got;
}
const r3 = (v) => Math.round(v * 1000) / 1000;
function resupplyUnits(db, war) {
  const cfg = warCfg(db);
  const fuelPerStrength = Number(cfg.fuelPerStrength) || 0.01;
  const burnFrac = Number(cfg.fuelBurnFrac) || 0;
  const { guns, fuels } = weaponCatalog(db);
  const gunIds = new Set(guns.map(g => g.id));
  const fuelIds = new Set(fuels.map(f => f.id));
  const fuelSpeedOf = {};
  for (const f of fuels) fuelSpeedOf[f.id] = Number(f.meta.weapon.speed) || 0;
  const poolCache = {};
  // strength-weighted side means, kept as war.equip for the War Room arsenal
  // readout and as the engine's fallback for any kit-less legacy unit
  const agg = { att: { dmg: 0, hp: 0, morale: 0, speed: 0 }, def: { dmg: 0, hp: 0, morale: 0, speed: 0 } };
  const aggW = { att: 0, def: 0 };

  for (const u of war.units) {
    if (!isLive(u)) continue;
    u.inv = Array.isArray(u.inv) ? u.inv : [];
    const troops = Math.max(1, Math.ceil(u.strength || 0));
    const tank = (u.strength || 0) * fuelPerStrength;

    // 1. Attrition — the dead take their rifles with them: carry at most one
    //    gun per remaining soldier, shedding the WORST models first.
    let carried = 0;
    for (const r of u.inv) if (gunIds.has(r.itemId)) carried += (r.qty || 0);
    let excess = carried - troops;
    for (let i = guns.length - 1; i >= 0 && excess > 0; i--) excess -= invTake(u.inv, guns[i].id, excess);

    // 2. Fuel burn — moving or fighting eats into the tank (holding still or
    //    riding the fleet doesn't).
    if (burnFrac > 0 && u.state !== 'holding' && u.state !== 'embarked') {
      let burn = tank * burnFrac;
      for (const f of fuels) { if (burn <= 0) break; burn -= invTake(u.inv, f.id, burn); }
    }

    // 3. Resupply — only inside the supply corridor, only out of the unit's
    //    own nation's stockpile. Embarked invaders load out at sea (supplied
    //    by the fleet), so nobody hits the beach empty-handed. Draws are kept
    //    integral so national inventories never go fractional.
    if (u.supplied !== false) {
      const nid = u.nationId || (u.side === 'att' ? war.attackerId : war.defenderId);
      const pools = poolCache[nid] || (poolCache[nid] = nationPools(db, war, nid));
      let carriedNow = 0;
      for (const r of u.inv) if (gunIds.has(r.itemId)) carriedNow += (r.qty || 0);
      let gunNeed = troops - carriedNow;
      for (const g of guns) {
        if (gunNeed <= 0) break;
        const got = drawFromPools(pools, g.id, gunNeed);
        if (got > 0) { invAdd(u.inv, g.id, got); gunNeed -= got; }
      }
      let fuelNow = 0;
      for (const r of u.inv) if (fuelIds.has(r.itemId)) fuelNow += (r.qty || 0);
      let fuelNeed = Math.floor(tank - fuelNow);
      for (const f of fuels) {
        if (fuelNeed <= 0) break;
        const got = drawFromPools(pools, f.id, fuelNeed);
        if (got > 0) { invAdd(u.inv, f.id, got); fuelNeed -= got; }
      }
    }

    // 4. Fold the unit's own packs into its combat kit (consumed by the
    //    engine's unitMul). Each ARMED soldier contributes the 1× baseline
    //    plus his weapon's stats; each UNARMED one contributes the (savage)
    //    settings.war.unarmed* factors instead — a division with empty racks
    //    is fighting with fists, and its dmg/hp/morale collapse accordingly.
    const kit = { dmg: 0, hp: 0, morale: 0, speed: 1 };
    let unarmed = troops;
    for (const g of guns) {
      if (unarmed <= 0) break;
      const row = invGet(u.inv, g.id);
      if (!row || !(row.qty > 0)) continue;
      const armed = Math.min(unarmed, row.qty);
      const frac = armed / troops;
      const wpn = g.meta.weapon;
      kit.dmg += frac * (1 + (Number(wpn.dmg) || 0));
      kit.hp += frac * (1 + (Number(wpn.hp) || 0));
      kit.morale += frac * (1 + (Number(wpn.morale) || 0));
      unarmed -= armed;
    }
    const unarmedFrac = Math.max(0, unarmed) / troops;
    if (unarmedFrac > 0) {
      kit.dmg += unarmedFrac * (Number(cfg.unarmedDmg) || 0.25);
      kit.hp += unarmedFrac * (Number(cfg.unarmedHp) || 0.5);
      kit.morale += unarmedFrac * (Number(cfg.unarmedMorale) || 0.3);
    }
    let fuelQty = 0, fuelBonus = 0;
    for (const r of u.inv) {
      if (!fuelIds.has(r.itemId)) continue;
      fuelQty += (r.qty || 0);
      fuelBonus = Math.max(fuelBonus, fuelSpeedOf[r.itemId] || 0);
    }
    if (fuelBonus > 0 && tank > 0) kit.speed += fuelBonus * Math.min(1, fuelQty / tank);
    for (const k in kit) kit[k] = r3(kit[k]);
    u.kit = kit;

    const w = u.strength || 0;
    for (const k in kit) agg[u.side][k] += kit[k] * w;
    aggW[u.side] += w;
  }
  const out = {};
  for (const side of ['att', 'def']) {
    const a = agg[side], w = aggW[side];
    out[side] = w > 0
      ? { dmg: r3(a.dmg / w), hp: r3(a.hp / w), morale: r3(a.morale / w), speed: r3(a.speed / w) }
      : { dmg: 1, hp: 1, morale: 1, speed: 1 };
  }
  war.equip = out;
}

// Active wars started before Phase 22 lack country cells in their grid —
// upgrade in place, once, additively (same spirit as store.migrate()).
function ensureWarGrid(db) {
  const war = db.war;
  if (!war || !war.active || !war.grid) return;
  if (!war.grid.countryCells) {
    const fresh = engine.buildGrid(db);
    war.grid.countryCells = fresh.countryCells;
    war.grid.countryLandCells = fresh.countryLandCells;
    war._zonesKey = null; // force refreshWarZones to derive enemy/neutral sets next tick
  }
}

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
    stats: { attLosses: 0, defLosses: 0, provinceControl: {}, citiesHeld: [], civilianDeaths: 0, refugees: 0, enemyControl: {} },
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
  // invading someone is the fastest way to ruin a relationship (Phase 25)
  try { sim.shiftRelations(db, attacker.id, -40, 'Launched an invasion of the Republic', 'WAR ENGINE'); } catch (e) { /* diplomacy optional */ }
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
// Where a joining nation's contingent musters. Phase 22: a nation whose
// homeland is ON the map actually mobilises FROM that homeland — the home
// cell nearest to where it's needed (the front for an attacker ally, the
// capital for a defender ally). Off-map nations keep the old behaviour:
// appearing near the attacker staging / near the capital.
function joinEntryPoint(db, war, side, entityId) {
  const [W, H] = engine.worldBounds(war);
  let target;
  if (side === 'att') {
    const anchor = war.units.find(u => u.side === 'att' && isLive(u)) || war.units.find(u => u.side === 'att');
    target = anchor ? anchor.pos.slice() : [W / 2, 40];
  } else {
    const capital = db.cities.find(c => c.isCapital && c.pos) || db.cities.find(c => c.pos);
    target = capital ? capital.pos.slice() : [W / 2, H / 2];
  }
  const cid = entityId ? engine.countryIdForEntity(db, entityId) : null;
  const homeCells = (cid && war.grid && war.grid.countryCells) ? war.grid.countryCells[cid] : null;
  if (homeCells && homeCells.length) {
    const cs = war.grid.cell;
    let best = null, bd = Infinity;
    for (const cell of homeCells) {
      const p = [(cell[0] + 0.5) * cs, (cell[1] + 0.5) * cs];
      const d = dist(p, target);
      if (d < bd) { bd = d; best = p; }
    }
    return best || target;
  }
  return target;
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
  ensureWarGrid(db); // homeland muster needs grid.countryCells on a pre-Phase-22 war
  const entryPos = joinEntryPoint(db, war, side, entity.id);
  // A nation mobilising FROM its own map homeland fields mobile infantry on
  // both sides (a speed-0 garrison stuck on home soil would never reach the
  // war); off-map defenders keep the old static-garrison behaviour.
  const homeland = !!engine.countryIdForEntity(db, entity.id);
  const mobile = side === 'att' || homeland;
  // Defender allies marching from home need somewhere to march TO.
  const capital = db.cities.find(c => c.isCapital && c.pos) || db.cities.find(c => c.pos);
  const marchTo = side === 'def' && homeland && capital ? capital.pos : null;

  const spawned = [];
  for (let i = 0; i < count; i++) {
    const ang = rand(0, Math.PI * 2);
    const r = rand(40, 100);
    const pos = engine.clampToWorld(war, [entryPos[0] + Math.cos(ang) * r, entryPos[1] + Math.sin(ang) * r]);
    const u = {
      id: store.uid('warunit'), side,
      name: `${entity.name} Expeditionary ${toRoman(i + 1)}`,
      kind: mobile ? 'infantry' : 'garrison',
      pos, dest: null, strength, maxStrength: strength, org: 100,
      speed: mobile ? (def.speed || 3.2) : 0,
      atk: def.atk || 1, state: 'holding', objectiveId: null,
      nationId: entity.id, garrison: side === 'def' && !mobile, spawned: true
    };
    war.units.push(u);
    spawned.push(u.id);
    if (marchTo) engine.setDest(db, u, [marchTo[0] + rand(-60, 60), marchTo[1] + rand(-60, 60)], u.speed);
  }
  war.allies[side].push(entity.id);
  war._zonesKey = null; // belligerent set changed — refreshWarZones re-derives neutral/enemy soil next tick
  // intervention is a diplomatic statement (Phase 25): joining the defence
  // wins hearts, joining the invader burns them
  try { sim.shiftRelations(db, entity.id, side === 'def' ? 25 : -30, side === 'def' ? 'Intervened in defence of the Republic' : 'Joined the invasion of the Republic', 'WAR ENGINE'); } catch (e) { /* diplomacy optional */ }

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

// ---------- peace treaties (Phase 24 — GM-only) ----------
// A treaty is the GM's pen redrawing the world after (or during) a war:
// reparations move money, cession hands a Republic province to a foreign
// nation (the land becomes that nation's territory on the map; its cities
// and properties pass out of the Republic's books), and annexation turns a
// whole map nation INTO a new province — shape, generated demographics,
// a namesake city — ready for the economy/elections to pick up next turn.
// Everything here is ordinary data mutation: no engine changes, no schema.
function applyTreaty(db, terms, actor) {
  const applied = [];
  if (db.war && db.war.active) {
    endWar(db, actor, 'Peace treaty signed');
    applied.push('active war ended');
  }
  if (terms && terms.reparations) {
    const t = terms.reparations;
    const amount = Math.round(Number(t.amount) || 0);
    const from = db.entities.find(e => e.id === t.fromEntityId);
    const to = db.entities.find(e => e.id === t.toEntityId);
    if (amount > 0 && from && to && from.id !== to.id) {
      const fromAcct = sim.primaryAccount(from.id, true);
      const toAcct = sim.primaryAccount(to.id, true);
      sim.txn(fromAcct.id, toAcct.id, amount, 'War reparations under the peace treaty', actor, 'transfer');
      applied.push(`reparations of ${amount} from ${from.name} to ${to.name}`);
      SERVER_CTX.news('REPARATIONS AGREED UNDER THE TREATY',
        `${from.name} will pay ${to.name} substantial reparations under the settlement's financial clauses.`);
    }
  }
  if (terms && terms.cede) cedeProvince(db, terms.cede.provinceId, terms.cede.toEntityId, actor, applied);
  if (terms && terms.annex) annexCountry(db, terms.annex.countryId, actor, applied);
  return applied;
}
function cedeProvince(db, provinceId, toEntityId, actor, applied) {
  const prov = db.provinces.find(p => p.id === provinceId);
  const recipient = db.entities.find(e => e.id === toEntityId);
  if (!prov || !recipient || !prov.shape) return;
  db.settings.map = db.settings.map || {};
  db.settings.map.countries = db.settings.map.countries || [];
  const recipientCountry = db.settings.map.countries.find(c => c.id === engine.countryIdForEntity(db, recipient.id));
  db.settings.map.countries.push({
    id: 'ceded_' + prov.id,
    name: recipient.name,
    fill: (recipientCountry && recipientCountry.fill) || recipient.color || '#8a8474',
    shape: prov.shape
  });
  const lostCities = db.cities.filter(c => c.provinceId === prov.id).length;
  db.cities = db.cities.filter(c => c.provinceId !== prov.id);
  const lostProps = db.properties.filter(p => p.provinceId === prov.id).length;
  db.properties = db.properties.filter(p => p.provinceId !== prov.id);
  if (lostProps) require('./deeds').syncAllDeeds(db);
  db.provinces = db.provinces.filter(p => p.id !== prov.id);
  applied.push(`ceded ${prov.name} to ${recipient.name}`);
  store.log('event', `${prov.name} ceded to ${recipient.name}`,
    `Under the treaty, ${prov.name} passes out of the Republic — ${lostCities} cities and ${lostProps} properties with it.`,
    actor || 'TREATY', [recipient.id]);
  SERVER_CTX.news(`${String(prov.name).toUpperCase()} IS CEDED TO ${String(recipient.name).toUpperCase()}`,
    `By the terms of the settlement, the province of ${prov.name} passes under the sovereignty of ${recipient.name}. Border posts are already changing flags.`);
}
function annexCountry(db, countryId, actor, applied) {
  db.settings.map = db.settings.map || {};
  const countries = db.settings.map.countries || [];
  const idx = countries.findIndex(c => c.id === countryId);
  if (idx < 0) return;
  const country = countries[idx];
  const cfg = warCfg(db);
  let centroid = [1920, 1080];
  try {
    const poly = engine.parseShape(country.shape);
    const pts = (poly && poly[0]) || [];
    if (pts.length) {
      centroid = [Math.round(pts.reduce((s, p) => s + p[0], 0) / pts.length),
        Math.round(pts.reduce((s, p) => s + p[1], 0) / pts.length)];
    }
  } catch (e) { /* malformed shape — centre of the map */ }
  // demographics: the Republic's own mix, scaled to the annexed population —
  // conquered subjects start poorer, unhappier and colder to the government
  const template = db.provinces[0];
  const pop = Math.round(Number(cfg.annexPopulation) || 1200000);
  const demographics = {};
  if (template && template.demographics) {
    const tPop = Object.values(template.demographics).reduce((s, g) => s + (g.population || 0), 0) || 1;
    for (const gName in template.demographics) {
      const g = template.demographics[gName];
      demographics[gName] = Object.assign({}, g, {
        population: Math.round((g.population || 0) / tPop * pop),
        happiness: 30, governmentSupport: 12
      });
    }
  }
  const baseVars = Object.assign({}, (template && template.vars) || {});
  Object.assign(baseVars, { population: pop, happiness: 30, approval: 12, employment: 62, infrastructure: Math.min(40, baseVars.infrastructure || 40) });
  const prov = {
    id: store.uid('prov'),
    name: country.name,
    color: country.fill || '#9a927e',
    shape: country.shape,
    labelPos: centroid,
    labelSize: 40,
    capital: null,
    description: `Former sovereign territory of ${country.name}, annexed into the Republic by treaty.`,
    vars: baseVars,
    demographics,
    annexedFrom: countryId
  };
  db.provinces.push(prov);
  db.cities.push({ id: store.uid('city'), name: country.name, provinceId: prov.id, pos: centroid.slice(), size: 2, isCapital: false });
  countries.splice(idx, 1);
  applied.push(`annexed ${country.name} as a province`);
  store.log('event', `${country.name} annexed`,
    `The territory of ${country.name} is incorporated into the Republic as a new province of ${pop.toLocaleString('en-US')} people.`,
    actor || 'TREATY', []);
  SERVER_CTX.news(`${String(country.name).toUpperCase()} IS ANNEXED`,
    `Under the treaty's territorial clauses, ${country.name} ceases to exist as a sovereign state and is incorporated into the Republic as a province. Occupation authorities are standing up a civil administration.`);
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

  // Civilian toll (Phase 22 devastation) — bombing a populated province
  // kills far more civilians than ground fighting does.
  const cfg = warCfg(db);
  const pid = geometry.provinceAt(db.provinces, pos);
  if (pid) {
    const deaths = killCivilians(db, war, pid, cfg.civPerStrike * ((war.mods && war.mods.bombDmg) || 1));
    if (deaths) {
      store.log('event', 'Civilians killed in air raid',
        `${deaths.toLocaleString('en-US')} civilians confirmed dead after the strike.`, 'WAR ENGINE', []);
    }
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
// resupplyUnits runs only when a real tick actually happened (its stockpile
// draws/fuel burn MUTATE the world — the old pure computeEquip could safely
// run on every heartbeat call, this can't): it consumes the tick's fresh
// u.supplied verdicts and writes the u.kit the NEXT tick(s) fight with.
// maybeWarTick can burn through several catch-up ticks per call — resupply
// applies once per call, same accepted coarseness as applyDevastation.
function warTick(db) {
  ensureWarGrid(db);
  const ticked = engine.warTick(db, ctxFor(db));
  if (ticked) { resupplyUnits(db, db.war); applyDevastation(db); }
  return ticked;
}
function maybeWarTick(db) {
  ensureWarGrid(db);
  const ticked = engine.maybeWarTick(db, ctxFor(db));
  if (ticked) { resupplyUnits(db, db.war); applyDevastation(db); }
  return ticked;
}

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
    war.totalWar ? 1 : 0, // the shift to total war is front-page news for every client
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

module.exports = { startWar, endWar, warTick, maybeWarTick, maybeWarTickSignal, buildGrid, dropBomb, commandUnits, setWarTuning, spawnUnits, joinWar, applyTreaty, isLive };
