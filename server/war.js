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
  fuelBurnFrac: 0.09,      // fraction of a full tank burned per authoritative call while moving/fighting (raised — war fuel drain was far too slow to matter)
  weaponBurnFrac: 0.03,    // fraction of a FIGHTING unit's carried weapons (guns/tanks) expended/lost per tick — makes arsenals drain visibly during battle, not just through casualties
  tankCapacity: 25,        // tanks that fill one armoured unit (best-quality-first, stats average across the complement; a partial fill fights worse)
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

// ---------- occupation ownership (Task 2: occupation transfers property) ----------
// AUTHORITY-ONLY, like applyDevastation — property ownership lives outside
// db.war, so a predicting client never runs this. Throttled (every
// OCCUPATION_CHECK_TICKS ticks) since it walks every property in the world;
// combined with the deed choke point (deeds.transfer) this is what makes an
// occupied factory/farm/depot change hands mid-war and stay changed after the
// war ends — the "companies losing these properties" devastation another
// agent tied profits to.
const OCCUPATION_CHECK_TICKS = 5;
function applyOccupationTransfers(db) {
  const war = db.war;
  if (!war || !war.active || !war.grid) return;
  if (war.tick % OCCUPATION_CHECK_TICKS !== 0) return;
  const deedsMod = require('./deeds');
  const cs = war.grid.cell;
  let seized = 0, restored = 0;
  for (const prop of db.properties) {
    if (!prop.pos) continue;
    const key = engine.cellKey(Math.floor(prop.pos[0] / cs), Math.floor(prop.pos[1] / cs));
    const cell = war.cells[key];
    const attHeld = !!(cell && cell.o === 'att');
    prop.vars = prop.vars || {};
    const wasStashed = Object.prototype.hasOwnProperty.call(prop.vars, '_preWarOwnerId');
    if (attHeld) {
      if (prop.ownerId !== war.attackerId) {
        if (!wasStashed) prop.vars._preWarOwnerId = prop.ownerId;
        try { deedsMod.transfer(prop.id, prop.ownerId, war.attackerId, 'WAR ENGINE'); seized++; }
        catch (e) { /* unowned/malformed deed — skip, keep the stash for a later retry */ }
      }
    } else if (wasStashed) {
      // Recaptured — no longer attacker-held. Restore to the pre-occupation
      // owner and clear the stash so a later re-occupation stashes fresh.
      const orig = prop.vars._preWarOwnerId;
      if (orig && prop.ownerId !== orig) {
        try { deedsMod.transfer(prop.id, prop.ownerId, orig, 'WAR ENGINE'); restored++; delete prop.vars._preWarOwnerId; }
        catch (e) { /* leave the stash in place — try again next sweep */ }
      } else {
        delete prop.vars._preWarOwnerId;
      }
    }
  }
  if (seized || restored) {
    store.log('event', 'Occupation changes property ownership',
      `${seized} propert${seized === 1 ? 'y' : 'ies'} seized by the occupying force` +
      (restored ? `, ${restored} restored to their former owner${restored === 1 ? '' : 's'}` : '') + '.',
      'WAR ENGINE', []);
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
// Quality score used to rank weapons "best first" for both attrition-shedding
// (worst goes first) and resupply (best drawn first) — a unit always carries
// the highest-quality kit it can (feature: "always prioritise the highest
// quality supply first").
function gunQuality(w) { return (Number(w.dmg) || 0) + (Number(w.hp) || 0) + (Number(w.morale) || 0); }
function tankQuality(w) { return (Number(w.dmg) || 0) + (Number(w.hp) || 0) + (Number(w.armor) || 0); }
function shipQuality(w) { return (Number(w.dmg) || 0) + (Number(w.hp) || 0) + (Number(w.range) || 0); }
function weaponCatalog(db) {
  const guns = [], fuels = [], tanks = [], ships = [];
  for (const it of db.items) {
    if (!(it.meta && it.meta.weapon)) continue;
    const k = it.meta.weapon.kind || 'smallarms';
    if (k === 'fuel') fuels.push(it);
    else if (k === 'tank') tanks.push(it);
    else if (k === 'warship') ships.push(it); // hulls supply warship squadrons exactly like tanks supply armour
    else guns.push(it);
  }
  guns.sort((a, b) => gunQuality(b.meta.weapon) - gunQuality(a.meta.weapon));
  tanks.sort((a, b) => tankQuality(b.meta.weapon) - tankQuality(a.meta.weapon));
  ships.sort((a, b) => shipQuality(b.meta.weapon) - shipQuality(a.meta.weapon));
  fuels.sort((a, b) => (Number(b.meta.weapon.speed) || 0) - (Number(a.meta.weapon.speed) || 0));
  return { guns, fuels, tanks, ships };
}
// Morale a full tank complement lends its crews (tanks are frightening and
// steady the line) — folded into the armoured-unit kit below.
const TANK_MORALE_BONUS = 0.6;
// Same idea for a full squadron of hulls under a warship crew's feet.
const SHIP_MORALE_BONUS = 0.4;
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
// The primary weapon pool for a unit: armoured units run on TANKS (feature:
// "tanks use the same supply system infantry use for guns") and warship
// squadrons run on HULLS (feature: "ships take on supply the same way as
// tanks") — both a fixed capacity (tankCapacity/shipCapacity, default 25) per
// unit regardless of strength; every other land kind runs on small arms, one
// per soldier. Boats carry no primary weapon (their strength IS the boat).
function primaryWeaponSpec(u, catalog, troops, tankCapacity, shipCapacity) {
  if (u.kind === 'warship') return { list: catalog.ships, ids: catalog.shipIds, capacity: shipCapacity, isShip: true };
  if (u.kind === 'boat') return null;
  if (u.kind === 'armored') return { list: catalog.tanks, ids: catalog.tankIds, capacity: tankCapacity, isTank: true };
  return { list: catalog.guns, ids: catalog.gunIds, capacity: troops, isTank: false };
}
function resupplyUnits(db, war) {
  const cfg = warCfg(db);
  const fuelPerStrength = Number(cfg.fuelPerStrength) || 0.01;
  const burnFrac = Number(cfg.fuelBurnFrac) || 0;
  const weaponBurnFrac = Number(cfg.weaponBurnFrac) || 0;
  const tankCapacity = Math.max(1, Number(cfg.tankCapacity) || 25);
  const shipCapacity = Math.max(1, Number(cfg.shipCapacity) || 25);
  const catalog = weaponCatalog(db);
  const { guns, fuels, tanks, ships } = catalog;
  catalog.gunIds = new Set(guns.map(g => g.id));
  catalog.tankIds = new Set(tanks.map(t => t.id));
  catalog.shipIds = new Set(ships.map(s => s.id));
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
    const spec = primaryWeaponSpec(u, catalog, troops, tankCapacity, shipCapacity);
    // Oil-hungry armour (feature): a unit's fuel tank grows with the average
    // fuelUse of the tanks it carries — a Type 50M column drinks far more than
    // an M36 Griz one. Non-armour uses the flat strength-based tank.
    let fuelUseMul = 1;
    if (spec && spec.isTank) {
      let fu = 0, fn = 0;
      for (const t of tanks) { const row = invGet(u.inv, t.id); if (row && row.qty > 0) { fu += (Number(t.meta.weapon.fuelUse) || 0.5) * row.qty; fn += row.qty; } }
      if (fn > 0) fuelUseMul = 0.5 + fu / fn; // ~1 for a mid tank, up to ~1.6 for the thirstiest
    }
    const tankSize = (u.strength || 0) * fuelPerStrength * fuelUseMul;

    if (spec) {
      const fighting = u.state === 'fighting';
      // 1. Attrition + expenditure — casualties take their weapons with them
      //    (carry at most `capacity`), and a FIGHTING unit additionally burns
      //    through weaponBurnFrac of what it carries each tick (losses, wear,
      //    ammunition). Worst-quality models are shed first, so a unit always
      //    keeps its best kit. Both drain the national arsenal via resupply
      //    below (feature: "weapon drain is too slow" — now it drains in
      //    combat, not only on death).
      let carried = 0;
      for (const r of u.inv) if (spec.ids.has(r.itemId)) carried += (r.qty || 0);
      let excess = carried - spec.capacity;
      if (fighting && weaponBurnFrac > 0) excess += carried * weaponBurnFrac;
      for (let i = spec.list.length - 1; i >= 0 && excess > 0; i--) excess -= invTake(u.inv, spec.list[i].id, excess);
    }

    // 2. Fuel burn — moving or fighting eats into the tank (holding still or
    //    riding the fleet doesn't). Naval kinds burn too (they move under power).
    if (burnFrac > 0 && u.state !== 'holding' && u.state !== 'embarked') {
      let burn = tankSize * burnFrac;
      for (const f of fuels) { if (burn <= 0) break; burn -= invTake(u.inv, f.id, burn); }
    }

    // 3. Resupply — only inside the supply corridor, only out of the unit's
    //    own nation's stockpile. Embarked invaders load out at sea (supplied
    //    by the fleet), so nobody hits the beach empty-handed. BEST QUALITY is
    //    drawn first (spec.list is quality-sorted), so a unit re-arms with the
    //    finest weapons its nation still has in stock.
    if (u.supplied !== false) {
      const nid = u.nationId || (u.side === 'att' ? war.attackerId : war.defenderId);
      const pools = poolCache[nid] || (poolCache[nid] = nationPools(db, war, nid));
      if (spec) {
        let carriedNow = 0;
        for (const r of u.inv) if (spec.ids.has(r.itemId)) carriedNow += (r.qty || 0);
        let need = spec.capacity - carriedNow;
        for (const g of spec.list) {
          if (need <= 0) break;
          const got = drawFromPools(pools, g.id, need);
          if (got > 0) { invAdd(u.inv, g.id, got); need -= got; }
        }
      }
      let fuelNow = 0;
      for (const r of u.inv) if (fuelIds.has(r.itemId)) fuelNow += (r.qty || 0);
      let fuelNeed = Math.floor(tankSize - fuelNow);
      for (const f of fuels) {
        if (fuelNeed <= 0) break;
        const got = drawFromPools(pools, f.id, fuelNeed);
        if (got > 0) { invAdd(u.inv, f.id, got); fuelNeed -= got; }
      }
    }

    // 4. Fold the unit's own packs into its combat kit (consumed by the
    //    engine's unitMul). Each ARMED slot contributes the 1× baseline plus
    //    its weapon's stats (AVERAGED across a mixed complement — different
    //    models just average out); each EMPTY slot contributes the (savage)
    //    settings.war.unarmed* factors — an under-strength unit (fewer weapons
    //    than its capacity) is correspondingly weaker. A tank contributes its
    //    armour to hp and a steadying morale bonus; a rifle its own stats.
    const kit = { dmg: 0, hp: 0, morale: 0, speed: 1 };
    if (spec) {
      const cap = spec.capacity;
      let filled = 0;
      for (const g of spec.list) {
        if (filled >= cap) break;
        const row = invGet(u.inv, g.id);
        if (!row || !(row.qty > 0)) continue;
        const n = Math.min(cap - filled, row.qty);
        const frac = n / cap;
        const wpn = g.meta.weapon;
        if (spec.isTank) {
          kit.dmg += frac * (1 + (Number(wpn.dmg) || 0));
          kit.hp += frac * (1 + (Number(wpn.hp) || 0) + (Number(wpn.armor) || 0));
          kit.morale += frac * (1 + TANK_MORALE_BONUS);
        } else if (spec.isShip) {
          // A hull contributes its guns to dmg, its armour + reach to hp
          // (standoff range keeps the squadron alive), and steadies the crews
          // — a Dreadnought squadron reads far above a Kradon-class one.
          kit.dmg += frac * (1 + (Number(wpn.dmg) || 0));
          kit.hp += frac * (1 + (Number(wpn.hp) || 0) + (Number(wpn.range) || 0) * 0.5);
          kit.morale += frac * (1 + SHIP_MORALE_BONUS);
        } else {
          kit.dmg += frac * (1 + (Number(wpn.dmg) || 0));
          kit.hp += frac * (1 + (Number(wpn.hp) || 0));
          kit.morale += frac * (1 + (Number(wpn.morale) || 0));
        }
        filled += n;
      }
      const emptyFrac = Math.max(0, cap - filled) / cap;
      if (emptyFrac > 0) {
        kit.dmg += emptyFrac * (Number(cfg.unarmedDmg) || 0.25);
        kit.hp += emptyFrac * (Number(cfg.unarmedHp) || 0.5);
        kit.morale += emptyFrac * (Number(cfg.unarmedMorale) || 0.3);
      }
    } else {
      // Boats have no supply pool — their built-in stats stand alone.
      kit.dmg = 1; kit.hp = 1; kit.morale = 1;
    }
    let fuelQty = 0, fuelBonus = 0;
    for (const r of u.inv) {
      if (!fuelIds.has(r.itemId)) continue;
      fuelQty += (r.qty || 0);
      fuelBonus = Math.max(fuelBonus, fuelSpeedOf[r.itemId] || 0);
    }
    if (fuelBonus > 0 && tankSize > 0) kit.speed += fuelBonus * Math.min(1, fuelQty / tankSize);
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
  // Transport ships & Boats / Warships feature — a war started before this
  // change lacks the merged land lookup buildGrid now computes; upgrade in
  // place so isWaterAt (transport-state transitions, naval land-refusal)
  // works on an in-progress war too, same additive spirit as countryCells
  // above.
  if (!war.grid.landCells) {
    const fresh = engine.buildGrid(db);
    war.grid.landCells = fresh.landCells;
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

// ---------- population-scaled defender roster (Task: population scaling) ----------
// Baseline calibration: the 1962 seed world (data/baseline-world.json) has a
// total province population of 39,060,001 and the OLD one-garrison-per-city-
// or-military-property rule produces exactly 12 garrisons (9 cities + 3
// military properties) — so POP_PER_GARRISON is hardcoded to that ratio,
// which is exactly what makes "today's seed population" reproduce today's
// exact roster (the calibration this feature was asked to preserve). A world
// that has grown or shrunk since seed (turns, treaties, annexations) scales
// the roster up or down from there.
const POP_PER_GARRISON = 3255000;
function totalPopulation(db) {
  let pop = 0;
  for (const p of (db.provinces || [])) pop += Number((p.vars || {}).population) || 0;
  return pop;
}
// Distributes `count` garrisons across weighted `sites` (largest-remainder
// method — deterministic, and the totals always sum to exactly `count`
// rather than drifting from independent rounding per site).
function distributeByWeight(count, sites) {
  const totalWeight = sites.reduce((s, x) => s + x.weight, 0) || 1;
  const raw = sites.map(s => count * s.weight / totalWeight);
  const base = raw.map(Math.floor);
  let assigned = base.reduce((a, b) => a + b, 0);
  let remainder = count - assigned;
  const order = raw.map((r, i) => ({ i, frac: r - base[i] })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder && order.length; k++) base[order[k % order.length].i]++;
  return base;
}
// Builds the defender garrison roster: one weighted site per city (weight =
// city size) and one per type:'military' property (weight matched to a
// size-2 city, since militaryPropertyStrength already sits between the
// size-1/size-2 defaults) — same site set the old flat "one per site" rule
// used, just with COUNT now scaled by national population instead of fixed
// at 1. Per-unit strength is UNCHANGED (still sizeStrength[size] /
// militaryPropertyStrength exactly as before); population growth adds MORE
// garrisons of the same strength at busier sites, not stronger ones.
function buildGarrisonUnits(db, scenarioDefense) {
  const def = scenarioDefense || {};
  const sizeStrength = def.citySizeStrength || { 1: 1300, 2: 2200, 3: 3800 };
  const militaryStrength = def.militaryPropertyStrength || 2600;
  const sites = [];
  for (const c of db.cities) {
    if (!c.pos) continue;
    sites.push({ kind: 'city', name: c.name, pos: c.pos, weight: Math.max(1, c.size || 1), strength: sizeStrength[c.size] || sizeStrength[1] || 1300 });
  }
  for (const p of db.properties) {
    if (p.type !== 'military' || !p.pos) continue;
    sites.push({ kind: 'military', name: p.name, pos: p.pos, weight: 2, strength: militaryStrength });
  }
  if (!sites.length) return [];
  const pop = totalPopulation(db);
  // Never below the site count (a defenceless world would be game-breaking);
  // never above a sane multiple of the historical baseline either, so a
  // wildly inflated population doesn't spawn thousands of garrison units.
  const target = engine.clamp(Math.round(pop / POP_PER_GARRISON) || sites.length, sites.length, sites.length * 8);
  const counts = distributeByWeight(target, sites);
  const units = [];
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    const n = counts[i];
    for (let k = 0; k < n; k++) {
      units.push({
        id: store.uid('warunit'), side: 'def',
        name: n > 1 ? `${site.name} Garrison ${toRoman(k + 1)}` : `${site.name} Garrison`,
        kind: 'garrison', pos: [site.pos[0], site.pos[1]], dest: null,
        strength: site.strength, maxStrength: site.strength, org: 100,
        speed: 0, atk: 1, state: 'holding', objectiveId: null, garrison: true
      });
    }
  }
  return units;
}

// ---------- tank & warship deployment at war start (Task: armour/navy) ----------
// The defender's national arsenal (the defending entity's own inventory —
// conventionally ent_gov, the Republic's stockpile) is walked for weapon
// items carrying meta.weapon.kind === 'tank' / 'warship', mirroring the
// gun/fuel arsenal-walk shape resupplyUnits already uses (weaponCatalog/
// nationPools above), and turned into fresh defender units at war start.
// Entirely defensive: a world with no such items seeded yet (this feature
// ships ahead of the parallel item-seeding work) simply deploys nothing here
// — the existing per-city/military-property garrisons still stand.
function arsenalWeaponsOf(db, entity, kind) {
  const inv = (entity && Array.isArray(entity.inventory)) ? entity.inventory : [];
  const out = [];
  for (const row of inv) {
    if (!(row && row.qty > 0)) continue;
    const item = (db.items || []).find(it => it.id === row.itemId);
    if (!item || !(item.meta && item.meta.weapon) || item.meta.weapon.kind !== kind) continue;
    out.push({ item, qty: row.qty });
  }
  return out;
}
// toRoman is defined once, further down (foreign-intervention naming) — JS
// hoists function declarations within a scope regardless of source order, so
// it's available here too.
// The nearest coastline point to `from`: a LAND cell adjacent to at least one
// WATER cell, searched outward from `from`'s own cell. Used when there's no
// seeded port property to anchor a warship spawn on.
// The nearest WATER cell adjacent to land (a harbour tile), searched outward
// from `from`. Warships must spawn AFLOAT — the engine refuses to let a naval
// kind step onto land, so a ship placed on a land coastline cell would be
// beached and unable to move or fight (this was why warships "didn't spawn"
// visibly: they deployed onto the port's land tile and sat inert).
function nearestHarbourWater(grid, from) {
  if (!grid || !grid.landCells) return null;
  const cs = grid.cell;
  const fx = Math.floor(from[0] / cs), fy = Math.floor(from[1] / cs);
  const R = 90;
  let best = null, bd = Infinity;
  for (let dx = -R; dx <= R; dx++) {
    for (let dy = -R; dy <= R; dy++) {
      const cx = fx + dx, cy = fy + dy;
      if (cx < 0 || cy < 0 || cx >= grid.cols || cy >= grid.rows) continue;
      if (grid.landCells[engine.cellKey(cx, cy)]) continue; // must be WATER
      let coastal = false;
      for (const off of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (grid.landCells[engine.cellKey(cx + off[0], cy + off[1])]) { coastal = true; break; }
      }
      if (!coastal) continue;
      const p = [(cx + 0.5) * cs, (cy + 0.5) * cs];
      const d = dist(p, from);
      if (d < bd) { bd = d; best = p; }
    }
  }
  return best;
}
// The water tile the Republic's warships spawn on: ALWAYS Port Kradon (the
// Republic's principal deep-water port and home of the Kradon Shipyards) in
// every scenario, per design — the harbour water nearest the Port of Kradon
// property (or the Port Kradon city, then any port, then the capital as
// last-ditch fallbacks so a world that lacks it still floats its ships). Always
// resolves to a WATER cell so the ship is afloat and mobile from tick one.
function findPortPos(db, grid, capitalPos) {
  const props = db.properties || [];
  const cities = db.cities || [];
  const anchor =
    (props.find(p => p.id === 'prop_kradon_port' && p.pos) || {}).pos ||
    (cities.find(c => c.id === 'city_kradon' && c.pos) || {}).pos ||
    (props.find(p => p.pos && (p.kind === 'port' || /\bport\b|harbou?r/i.test(p.name || ''))) || {}).pos ||
    capitalPos;
  return nearestHarbourWater(grid, anchor) || nearestHarbourWater(grid, capitalPos) || anchor;
}
// Groups the defender's tank/warship arsenal into fresh war units at the
// capital (armour) and the nearest port (navy). Called once, at startWar,
// AFTER db.war exists (so engine.setDest/clampToWorld etc. can see the grid)
// — units are pushed straight onto war.units.
function deployArsenalUnits(db, war, defender, attacker, stage, landStart) {
  const capital = db.cities.find(c => c.id === 'city_lachevan') || db.cities.find(c => c.isCapital && c.pos) || db.cities.find(c => c.pos);
  const capitalPos = capital ? capital.pos : [war.grid.cols * war.grid.cell / 2, war.grid.rows * war.grid.cell / 2];
  const unitDefaults = (require('./war-scenarios').UNIT_DEFAULTS) || {};
  const armDef = unitDefaults.armored || { strength: 2800, speed: 4.6, atk: 1.25 };
  const cfg = warCfg(db);
  const tankCapacity = Math.max(1, Number(cfg.tankCapacity) || 25);
  const hpMod = (war.mods && war.mods.hp) || 1;

  // --- armour: 25 tanks = 1 unit, but capped at 50% of the Republic's other
  // formations (feature: "limit the republic's tanks to at most 50% of the
  // regular units it has"). Tanks are LEFT in the national stockpile so the
  // supply system (resupplyUnits) loads each armoured unit best-tank-first —
  // its combat stats then come from the kit those tanks form, so a Type 50M
  // column is far stronger than an M36 Griz one. Units get the standard
  // armoured HP pool; the tank kit multiplies it.
  const tanks = arsenalWeaponsOf(db, defender, 'tank');
  let totalTanks = 0;
  for (const { qty } of tanks) totalTanks += qty;
  const otherDefUnits = war.units.filter(u => u.side === 'def' && u.kind !== 'armored' && u.kind !== 'warship').length;
  const wanted = Math.ceil(totalTanks / tankCapacity);
  const cap = Math.floor(otherDefUnits * 0.5);
  const numArmoured = Math.max(0, Math.min(wanted, cap));
  const bestTankName = tanks.length ? tanks.slice().sort((a, b) => tankQuality(b.item.meta.weapon) - tankQuality(a.item.meta.weapon))[0].item.name : 'Armour';
  for (let i = 0; i < numArmoured; i++) {
    const s = Math.round(armDef.strength * hpMod);
    const spawnPos = engine.clampToWorld(war, [capitalPos[0] + rand(-45, 45), capitalPos[1] + rand(-45, 45)]);
    war.units.push({
      id: store.uid('warunit'), side: 'def',
      name: `${toRoman(i + 1)} Armoured Division`,
      kind: 'armored', pos: spawnPos, dest: null,
      strength: s, maxStrength: s, org: 100,
      speed: armDef.speed, atk: armDef.atk, state: 'holding', objectiveId: null,
      inv: [], spawned: true
    });
  }

  // --- navies: hulls form SQUADRONS exactly like tanks form armoured units
  // (feature: "ships take on supply the same way as tanks"). One warship unit
  // per shipCapacity (25) hulls, rounded UP — 25 dreadnoughts = 1 squadron,
  // 26 = 2, 51 = 3. Hulls are LEFT in the national stockpile so resupplyUnits
  // loads each squadron best-hull-first as its kit; a squadron's combat power
  // scales with how many hulls it actually carries (an under-filled one
  // fights far below par). Base stats come from UNIT_DEFAULTS.warship; the
  // kit multiplies them.
  const navDef = unitDefaults.warship || { strength: 3600, speed: 5.0, atk: 1.6 };
  const shipCapacity = Math.max(1, Number(cfg.shipCapacity) || 25);
  const deployFleet = (entity, side, anchor, scatterR) => {
    if (!entity || !anchor) return;
    const hulls = arsenalWeaponsOf(db, entity, 'warship');
    let totalHulls = 0;
    for (const { qty } of hulls) totalHulls += Math.floor(qty);
    if (!(totalHulls > 0)) return;
    const numSquadrons = Math.ceil(totalHulls / shipCapacity);
    const bestHullName = hulls.slice().sort((a, b) => shipQuality(b.item.meta.weapon) - shipQuality(a.item.meta.weapon))[0].item.name;
    for (let i = 0; i < numSquadrons; i++) {
      const s = Math.round(navDef.strength * hpMod);
      const spawnPos = engine.nearestWaterPoint(war,
        engine.clampToWorld(war, [anchor[0] + rand(-scatterR, scatterR), anchor[1] + rand(-scatterR, scatterR)]));
      war.units.push({
        id: store.uid('warunit'), side,
        name: `${bestHullName} Squadron ${toRoman(i + 1)}`,
        kind: 'warship', pos: spawnPos, dest: null,
        strength: s, maxStrength: s, org: 100,
        speed: navDef.speed, atk: navDef.atk, state: 'holding', objectiveId: null,
        inv: [], spawned: true
      });
    }
  };
  // Defender fleet musters in the harbour water nearest its principal port.
  deployFleet(defender, 'def', findPortPos(db, war.grid, capitalPos), 40);
  // Attacker fleet sails with the invasion force (feature: the invader's
  // fleet actually shows up — before this only the defender's arsenal was
  // walked, so a naval power like Valksland invaded with no fleet at all):
  // afloat around the staging box for a sea assault, or in the harbour water
  // nearest the staging ground when the force starts ashore (land scenario /
  // ceded-territory staging).
  if (attacker && stage) {
    const centre = [(stage.x0 + stage.x1) / 2, (stage.y0 + stage.y1) / 2];
    deployFleet(attacker, 'att', landStart ? (nearestHarbourWater(war.grid, centre) || centre) : centre, 60);
  }
}

// ---------- dynamic attacker staging (Task: correct-border staging) ----------
// Centroid of every LAND cell in the defender's own provinces (from the
// grid's provinceCells, already rasterised by buildGrid).
function defenderLandCentroid(grid) {
  let sx = 0, sy = 0, n = 0;
  const cs = grid.cell;
  for (const pid in (grid.provinceCells || {})) {
    for (const c of grid.provinceCells[pid]) { sx += (c[0] + 0.5) * cs; sy += (c[1] + 0.5) * cs; n++; }
  }
  return n ? [sx / n, sy / n] : null;
}
// Centroid of a country polygon's primary (largest) subpath.
function countryCentroid(shape) {
  let polys;
  try { polys = engine.parseShape(shape); } catch (e) { return null; }
  if (!polys || !polys.length) return null;
  let best = polys[0];
  for (const p of polys) if (p.length > best.length) best = p;
  if (!best || !best.length) return null;
  let sx = 0, sy = 0;
  for (const p of best) { sx += p[0]; sy += p[1]; }
  return [sx / best.length, sy / best.length];
}
const BEARING_DIRS = { east: [1, 0], west: [-1, 0], north: [0, -1], south: [0, 1] };
// Walk outward from `from` along [dirX,dirY] one grid cell at a time until
// hitting open sea (not land, not a third nation's neutral soil) — the
// staging box's centre. Returns null if the walk runs off the map or never
// clears land/neutral ground.
function walkToOpenSea(grid, from, dir, neutral) {
  const cs = grid.cell;
  const maxSteps = Math.max(grid.cols, grid.rows) + 4;
  for (let step = 1; step <= maxSteps; step++) {
    const px = from[0] + dir[0] * step * cs, py = from[1] + dir[1] * step * cs;
    const cx = Math.floor(px / cs), cy = Math.floor(py / cs);
    if (cx < 0 || cy < 0 || cx >= grid.cols || cy >= grid.rows) return null;
    const key = engine.cellKey(cx, cy);
    if (grid.landCells && grid.landCells[key]) continue;
    if (neutral && neutral[key]) continue;
    return [px, py];
  }
  return null;
}
// Every cell belonging to a foreign homeland OTHER than the attacker's own —
// closed-border soil no staging box may sit on (mirrors engine.refreshWarZones'
// neutralCells, computed directly here since war.allies doesn't exist yet at
// startWar time — the attacker has no allies on turn zero).
function neutralCellsExcept(grid, attackerCountryId) {
  const neutral = {};
  for (const cid in (grid.countryCells || {})) {
    if (cid === attackerCountryId) continue;
    for (const cell of grid.countryCells[cid]) neutral[engine.cellKey(cell[0], cell[1])] = cid;
  }
  return neutral;
}
// Computes a fresh staging box for the attacker from CURRENT map data
// (province/country shapes — so ceded provinces or map edits are picked up
// automatically), or returns null to fall back to scenario.staging. Two
// shapes: a land-neighbour stages just inside its own territory nearest the
// campaign's first objective; a naval attacker stages in open sea along the
// bearing from the defender's landmass to its own homeland (or, for an
// off-map power with no homeland polygon, along scenario.bearingHint — see
// war-scenarios.js's qinal_invasion for why that escape hatch exists).
function computeDynamicStaging(db, grid, scenario, attacker, firstObjPos) {
  const cid = engine.countryIdForEntity(db, attacker.id);
  const countriesAll = (((db.settings || {}).map || {}).countries) || [];
  const country = cid && countriesAll.find(c => c.id === cid);
  const defCentroid = defenderLandCentroid(grid);
  if (!defCentroid) return null;

  // Ceded ex-defender territory held by the attacker (a ceded_* country entry
  // carrying its entityId — see cedeProvince): rasterised cells of every such
  // piece. A land neighbour treats them as extra homeland to stage from; a
  // NAVAL attacker that holds one stages ON it (land:true) — the province it
  // won in the last treaty is its beachhead now, so subsequent invasions
  // march out of it rather than mounting a fresh amphibious assault.
  const cededCells = [];
  for (const c of countriesAll) {
    if (c.entityId !== attacker.id || String(c.id).indexOf('ceded_') !== 0) continue;
    for (const cell of (grid.countryCells && grid.countryCells[c.id]) || []) cededCells.push(cell);
  }
  const cs = grid.cell;
  const nearestCellTo = (cells, target) => {
    let best = null, bd = Infinity;
    for (const cell of cells) {
      const p = [(cell[0] + 0.5) * cs, (cell[1] + 0.5) * cs];
      const d = dist(p, target);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };

  if (scenario.land) {
    const homeCells = (country && grid.countryCells && grid.countryCells[cid]) || [];
    const best = nearestCellTo(homeCells.concat(cededCells), firstObjPos || defCentroid);
    if (!best) return null;
    const size = 130;
    return { x0: best[0] - size, y0: best[1] - size, x1: best[0] + size, y1: best[1] + size };
  }

  if (cededCells.length) {
    const best = nearestCellTo(cededCells, firstObjPos || defCentroid);
    if (best) {
      const size = 130;
      return { x0: best[0] - size, y0: best[1] - size, x1: best[0] + size, y1: best[1] + size, land: true };
    }
  }

  const neutral = neutralCellsExcept(grid, cid);
  let found = null;
  if (country) {
    const homeCentroid = countryCentroid(country.shape);
    if (homeCentroid) {
      // Mass the fleet in HOME waters: walk from the attacker's own landmass
      // toward the defender to the first open sea — just off the attacker's
      // coast. (The old walk went OUTWARD from the DEFENDER's centroid and
      // stopped at the first sea cell off the defender's own beaches, which is
      // why the Valkish invasion force materialised on top of Port Valgos —
      // half its staging box overlapped the Arcasian coast.)
      const dx = defCentroid[0] - homeCentroid[0], dy = defCentroid[1] - homeCentroid[1];
      const m = Math.hypot(dx, dy) || 1;
      found = walkToOpenSea(grid, homeCentroid, [dx / m, dy / m], neutral);
    }
  }
  if (!found && scenario.bearingHint && BEARING_DIRS[scenario.bearingHint]) {
    // off-map power with no homeland polygon — legacy outward walk from the
    // defender's landmass along the scenario's compass hint
    found = walkToOpenSea(grid, defCentroid, BEARING_DIRS[scenario.bearingHint], neutral);
  }
  if (!found) return null;
  const size = 100;
  return { x0: found[0] - size, y0: found[1] - size, x1: found[0] + size, y1: found[1] + size };
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
  engine.ensureNavalGrid(db); // fine coastline grid — spawn/dest water clamps use exact borders

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
  // Dynamic attacker staging (Task 5): computed fresh from CURRENT map data
  // (so ceded provinces/annexations are picked up automatically) — falls
  // back to the scenario's static `staging` box if the dynamic walk can't
  // resolve a homeland/bearing or a safe patch of open sea/border ground.
  const firstObj = objectives.slice().sort((a, b) => a.priority - b.priority)[0];
  const dynamicStage = computeDynamicStaging(db, grid, scenario, attacker, firstObj ? firstObj.pos : null);
  const stage = dynamicStage || scenario.staging;
  // A force starts ashore for a land scenario OR when dynamic staging put a
  // naval attacker on its own ceded territory (stage.land — see
  // computeDynamicStaging). Ashore means: spawn 'moving' on the staging
  // ground, no sea transit, and any landing objective is already satisfied.
  const landStart = !!(scenario.land || (dynamicStage && dynamicStage.land));
  if (landStart) for (const o of objectives) if (o.kind === 'landing') o.status = 'done';
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
    // An embarked force spawns AFLOAT: the staging box's edge can brush a
    // coastline (it is only a box), so each scatter position is clamped to the
    // nearest water cell — no more transports sitting on the beach at tick 0.
    const scatter = [rand(stage.x0, stage.x1), rand(stage.y0, stage.y1)];
    return {
      id: store.uid('warunit'),
      side: 'att',
      name: u.name,
      kind: u.kind,
      pos: landStart ? scatter : engine.nearestWaterPoint({ grid }, scatter),
      dest: null,
      strength, maxStrength: strength,
      org: 100,
      speed: u.speed || def.speed,
      atk: u.atk || def.atk || 1,
      state: landStart ? 'moving' : 'embarked',
      objectiveId: null
    };
  });

  // Defender garrisons: population-scaled (Task 4) across the same site set
  // as before — one weighted site per city (by size) and one per
  // type:'military' property — see buildGarrisonUnits above.
  for (const gu of buildGarrisonUnits(db, scenario.defense)) units.push(gu);

  const attackerTotal = units.filter(u => u.side === 'att').reduce((s, u) => s + u.strength, 0);

  // Supply corridors (Feature: resupply healing) — the point the attacker's
  // flood-fill seeds from each tick: the landing objective's position for a
  // naval scenario, or the staging box's own centre for a land:true one
  // (there is no landing objective to point at). Minted once here, like
  // `seed`, so it never drifts mid-war even if objectives/positions change.
  const landingObj = objectives.find(o => o.kind === 'landing');
  const supplyAnchor = landStart
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
    mods: { dmg: 3, bombDmg: 5, hp: 1 },
    // Foreign nations that joined an ongoing war via joinWar (Feature:
    // intervention) — additive/absent-safe, mirrors `mods` above: a war doc
    // predating this feature simply has no allies of either side.
    allies: { att: [], def: [] },
    result: null
  };
  // Tank & warship deployment (Task 3): defender's national arsenal
  // (defender.inventory — conventionally ent_gov's stockpile) is walked for
  // meta.weapon.kind:'tank'/'warship' items and turned into fresh armoured/
  // naval units. No-op on a world where those items haven't been seeded yet.
  deployArsenalUnits(db, db.war, defender, attacker, stage, landStart);
  // Alliance-aware wars (Task 3): nations allied with the attacker/defender
  // (entity.meta.military.allies) auto-join via the existing joinWar
  // mechanics — contingent size from their military profile, mustering from
  // their own homeland when they have one. scenario.allies:false opts a
  // scenario out; scenario.coAttackers force-joins specific entities.
  autoJoinAllies(db, db.war, scenario, attacker, defender, 'WAR ENGINE');
  if (landStart) {
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
  // Task 2: occupied properties stay with their occupier permanently — this
  // does NOT touch property.ownerId, only clears the stash so a FUTURE war
  // re-stashes fresh original owners instead of reaching back through this one.
  for (const prop of (db.properties || [])) {
    if (prop.vars && Object.prototype.hasOwnProperty.call(prop.vars, '_preWarOwnerId')) delete prop.vars._preWarOwnerId;
  }
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

// ---------- alliance-aware wars (Task 3) ----------
// Two entities are allied if either lists the other in
// entity.meta.military.allies — the seeded profiles (server/store.js
// migrate()) are mutual (e.g. for_valksland.allies includes for_qinal AND
// for_qinal.allies includes for_valksland), but reading either direction
// keeps this correct even for a hand-edited, one-sided allies array.
function alliedWith(entities, aId, bId) {
  const a = (entities || []).find(e => e.id === aId);
  const b = (entities || []).find(e => e.id === bId);
  const aAllies = (a && a.meta && a.meta.military && a.meta.military.allies) || [];
  const bAllies = (b && b.meta && b.meta.military && b.meta.military.allies) || [];
  return aAllies.includes(bId) || bAllies.includes(aId);
}
// Contingent size from a military profile: tiny-weak reads 1, big-strong
// reads 6 — see docs comment on the task. army:'none' (Iceland) always
// contributes ZERO units, even if allied, per the task spec — the caller
// skips joinWar entirely and logs a flavour line instead. A joining nation
// with no profile at all (hand-authored scenario.coAttackers naming an
// entity the seed never gave a military.* to) falls back to the ordinary
// JOIN_DEFAULT_COUNT.
const ALLY_SIZE_BASE = { tiny: 1, small: 2, medium: 3, big: 4 };
const ALLY_ARMY_BONUS = { none: -99, weak: 0, medium: 1, strong: 2 };
function allyContingentSize(mil) {
  if (!mil) return JOIN_DEFAULT_COUNT;
  if (mil.army === 'none') return 0;
  const base = ALLY_SIZE_BASE[mil.size] || 2;
  const bonus = ALLY_ARMY_BONUS[mil.army] || 0;
  return engine.clamp(base + bonus, JOIN_MIN_COUNT, JOIN_MAX_COUNT);
}
// Brings ONLY explicitly-invited belligerents into a war at start (feature
// change: alliances no longer auto-drag nations in — Arcasia and everyone else
// stay out unless invited). A scenario can hand-author joint operations with
// `coAttackers: [entityId,…]` / `coDefenders: [entityId,…]`; a mid-war GM
// invitation still works through joinWar directly, for ANY nation onto EITHER
// side regardless of alliance. Contingent size comes from the invitee's
// military profile (army:'none' commits nobody, with a flavour line). The
// `alliedWith`/profile check is intentionally NOT consulted here anymore.
function autoJoinAllies(db, war, scenario, attacker, defender, actor) {
  if (scenario.allies === false) return;
  const invited = [];
  for (const id of (scenario.coAttackers || [])) invited.push({ id, side: 'att' });
  for (const id of (scenario.coDefenders || [])) invited.push({ id, side: 'def' });
  for (const { id, side } of invited) {
    const e = (db.entities || []).find(x => x.id === id && x.type === 'foreign');
    if (!e || e.id === attacker.id || e.id === defender.id) continue;
    const mil = e.meta && e.meta.military;
    const count = allyContingentSize(mil);
    if (count <= 0) {
      engine.pushEvent(war, 'milestone', joinEntryPoint(db, war, side, e.id),
        `${e.name} was called upon but has no forces to commit to the war.`);
      continue;
    }
    joinWar(db, { side, entityId: e.id, count }, actor);
  }
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
    entityId: recipient.id,
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
  if (ticked) { resupplyUnits(db, db.war); applyDevastation(db); applyOccupationTransfers(db); }
  return ticked;
}
function maybeWarTick(db) {
  ensureWarGrid(db);
  const ticked = engine.maybeWarTick(db, ctxFor(db));
  if (ticked) { resupplyUnits(db, db.war); applyDevastation(db); applyOccupationTransfers(db); }
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
