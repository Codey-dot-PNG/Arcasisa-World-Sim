'use strict';
/* Armed forces — the nation-level layer over the war engine.

   The war engine fights with units; this module answers the questions a
   defence ministry asks about a NATION: what is in its arsenal (stock in its
   own inventory, in its military depots, carried by its units in the field),
   how that has moved over time, and the standing orders it has given:

   · the DEPLOYMENT PLAN — where its garrisons stand when a war starts (a
     weight per city and military site), where the armour musters, which port
     the fleet sails from, and which cities the police hold in a protest;
   · the SUPPLY DOCTRINE — the order its units draw weapons in (best first, or
     spare the best), and how full they are topped up with arms and fuel.

   Both live on the entity (`entity.militaryPlan`, shipped only to whoever
   may see that entity's inventory — api.filterState) and are read by
   server/war.js at war/protest start and in every resupply pass. Generic:
   "a nation" is any entity, nothing here names a world.

   History: `db.militaryLog` — one row per turn plus a row every
   LIVE_SAMPLE_TICKS of a running conflict:
     { at, turn, why: 'turn'|'war'|'protest'|'start'|'end',
       n: { [entityId]: [arms, tanks, ships, aircraft, fuel, men] } }
   (arms/tanks/ships/aircraft/fuel = everything the nation holds, wherever it
   sits; men = its soldiers in the field). Turn rows and conflict rows are
   capped separately so a long war never pushes the peacetime record out. */
const store = require('./store');

const KINDS = ['smallarms', 'tank', 'warship', 'aircraft', 'fuel'];
const TURN_CAP = 120, LIVE_CAP = 150;
const LIVE_SAMPLE_TICKS = 30;   // a nation row every 30 conflict ticks
const SERIES_TICKS = 10;        // a field-strength point every 10 ticks
const SERIES_CAP = 160;

const live = (u) => u && !u.dead && u.state !== 'dead' && u.strength > 0;

function armsKind(item) {
  const w = item && item.meta && item.meta.weapon;
  if (!w) return null;
  const k = w.kind || 'smallarms';
  return KINDS.includes(k) ? k : 'smallarms';
}
function kindIndex(db) {
  const idx = {};
  for (const it of db.items || []) { const k = armsKind(it); if (k) idx[it.id] = k; }
  return idx;
}
// the side's principal: whoever a unit without a nationId fights for
function principalOf(doc, side) {
  if (side === 'att') return (doc.kind === 'protest' && doc.protest && doc.protest.organizerId) || doc.attackerId;
  return doc.defenderId;
}
function nationOfUnit(doc, u) { return u.nationId || principalOf(doc, u.side); }
function liveDocs(db) {
  return [['war', db.war], ['protest', db.protest]].filter(([, d]) => d && d.active);
}
function depotsOf(db, nid) {
  return (db.properties || []).filter(p => p.type === 'military' && p.ownerId === nid);
}

// Everything one nation holds, by where it sits: { stock, depots, field } of
// { kind: qty }, plus men/units in the field and per-model rows.
function totals(db, nid, idx) {
  idx = idx || kindIndex(db);
  const blank = () => ({ smallarms: 0, tank: 0, warship: 0, aircraft: 0, fuel: 0 });
  const out = { stock: blank(), depots: blank(), field: blank(), men: 0, units: 0, models: {} };
  const add = (bucket, r) => {
    const k = idx[r.itemId];
    if (!k || !(r.qty > 0)) return;
    out[bucket][k] += r.qty;
    const m = out.models[r.itemId] || (out.models[r.itemId] = { stock: 0, depots: 0, field: 0 });
    m[bucket] += r.qty;
  };
  const e = (db.entities || []).find(x => x.id === nid);
  for (const r of (e && e.inventory) || []) add('stock', r);
  for (const p of depotsOf(db, nid)) for (const r of p.inventory || []) add('depots', r);
  for (const [, doc] of liveDocs(db)) {
    for (const u of doc.units || []) {
      if (!live(u) || nationOfUnit(doc, u) !== nid) continue;
      out.men += u.strength; out.units++;
      for (const r of u.inv || []) add('field', r);
    }
  }
  return out;
}
function rowOf(t) {
  const sum = (k) => Math.round(t.stock[k] + t.depots[k] + t.field[k]);
  return [sum('smallarms'), sum('tank'), sum('warship'), sum('aircraft'), sum('fuel'), Math.round(t.men)];
}

// The nations worth a row: every government and foreign power, every
// belligerent, and anyone else holding arms.
function trackedNations(db, idx) {
  const ids = new Set();
  for (const e of db.entities || []) {
    if (e.type === 'government' || e.type === 'foreign') { ids.add(e.id); continue; }
    if ((e.inventory || []).some(r => idx[r.itemId] && r.qty > 0)) ids.add(e.id);
  }
  for (const [, doc] of liveDocs(db)) { ids.add(principalOf(doc, 'att')); ids.add(doc.defenderId); for (const u of doc.units || []) if (u.nationId) ids.add(u.nationId); }
  ids.delete(undefined); ids.delete(null);
  return [...ids];
}

function sample(db, why) {
  const idx = kindIndex(db);
  const n = {};
  for (const nid of trackedNations(db, idx)) {
    const row = rowOf(totals(db, nid, idx));
    if (row.some(v => v > 0)) n[nid] = row;
  }
  db.militaryLog = Array.isArray(db.militaryLog) ? db.militaryLog : [];
  const log = db.militaryLog;
  log.push({ at: Date.now(), turn: ((db.settings || {}).time || {}).turn || 0, why, n });
  // turn rows and conflict rows keep separate budgets
  const isTurn = (r) => r.why === 'turn';
  let turns = log.filter(isTurn).length, lives = log.length - turns;
  for (let i = 0; i < log.length && (turns > TURN_CAP || lives > LIVE_CAP);) {
    if (isTurn(log[i]) ? turns > TURN_CAP : lives > LIVE_CAP) {
      if (isTurn(log[i])) turns--; else lives--;
      log.splice(i, 1);
    } else i++;
  }
}

// After every authoritative conflict tick: the public field-strength series
// on the conflict doc, and now and then a nation row.
// (a call can advance several ticks at speed, so the gates compare against
// the last sampled tick rather than a tick modulo)
function afterTick(db, doc, key) {
  if (!doc || !(doc.tick > 0)) return;
  if (doc.tick - (doc._seriesTick || 0) >= SERIES_TICKS) {
    doc._seriesTick = doc.tick;
    let a = 0, d = 0;
    for (const u of doc.units || []) if (live(u)) { if (u.side === 'att') a += u.strength; else d += u.strength; }
    const st = doc.stats || {};
    doc.series = Array.isArray(doc.series) ? doc.series : [];
    doc.series.push([doc.tick, Math.round(a), Math.round(d), Math.round(st.attLosses || 0), Math.round(st.defLosses || 0)]);
    // full: thin the older half to every other point (the recent past stays sharp)
    if (doc.series.length > SERIES_CAP) {
      const half = Math.floor(doc.series.length / 2);
      doc.series = doc.series.slice(0, half).filter((_, i) => i % 2 === 0).concat(doc.series.slice(half));
    }
  }
  if (doc.tick - (doc._milTick || 0) >= LIVE_SAMPLE_TICKS) { doc._milTick = doc.tick; sample(db, key); }
}

// ---------- the standing orders ----------
const DOCTRINE_DEFAULTS = { issue: 'best', arms: 1, fuel: 1 };
const POST_MAX = 3;           // 0 = leave unmanned · 1 normal · 2 reinforced · 3 fortress
const POLICE_PER_MAX = 4;

function planOf(entity) {
  const p = (entity && entity.militaryPlan) || {};
  return {
    posts: p.posts || {},
    armourAt: p.armourAt || null,
    fleetAt: p.fleetAt || null,
    police: { cities: (p.police && p.police.cities) || [], per: (p.police && p.police.per) || 2 },
    doctrine: Object.assign({}, DOCTRINE_DEFAULTS, p.doctrine || {})
  };
}
function doctrineOf(db, nid) {
  const e = (db.entities || []).find(x => x.id === nid);
  return planOf(e).doctrine;
}
const clampNum = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
const RATIONS = [0.25, 0.5, 0.75, 1];
const nearestRation = (v) => RATIONS.reduce((b, r) => Math.abs(r - v) < Math.abs(b - v) ? r : b, 1);

// Validate a patch onto the entity's plan; `only` limits which parts may
// change (a police chief edits the police posts and nothing else). Returns
// the new plan and a list of what changed, for the audit line.
function applyPlan(db, entity, raw, only) {
  raw = raw || {};
  const may = (part) => !only || only.includes(part);
  const cur = planOf(entity);
  const cityIds = new Set((db.cities || []).map(c => c.id));
  const changed = [];
  if (may('posts') && raw.posts && typeof raw.posts === 'object') {
    const posts = {};
    for (const k of Object.keys(raw.posts).slice(0, 200)) {
      const [kind, id] = k.split(':');
      const ok = kind === 'city' ? cityIds.has(id) : kind === 'prop' ? (db.properties || []).some(p => p.id === id && p.type === 'military') : false;
      if (!ok) continue;
      const w = Math.round(clampNum(raw.posts[k], 0, POST_MAX, 1));
      if (w !== 1) posts[k] = w;
    }
    cur.posts = posts; changed.push('garrison posts');
  }
  if (may('armourAt') && raw.armourAt !== undefined) {
    cur.armourAt = raw.armourAt && cityIds.has(raw.armourAt) ? raw.armourAt : null; changed.push('armour muster');
  }
  if (may('fleetAt') && raw.fleetAt !== undefined) {
    cur.fleetAt = raw.fleetAt && cityIds.has(raw.fleetAt) ? raw.fleetAt : null; changed.push('fleet base');
  }
  if (may('police') && raw.police && typeof raw.police === 'object') {
    const cities = Array.isArray(raw.police.cities) ? [...new Set(raw.police.cities.filter(id => cityIds.has(id)))].slice(0, 40) : cur.police.cities;
    cur.police = { cities, per: Math.round(clampNum(raw.police.per, 1, POLICE_PER_MAX, cur.police.per || 2)) };
    changed.push('police posts');
  }
  if (may('doctrine') && raw.doctrine && typeof raw.doctrine === 'object') {
    const d = raw.doctrine;
    cur.doctrine = {
      issue: d.issue === 'conserve' ? 'conserve' : d.issue === 'best' ? 'best' : cur.doctrine.issue,
      arms: d.arms !== undefined ? nearestRation(clampNum(d.arms, 0.25, 1, 1)) : cur.doctrine.arms,
      fuel: d.fuel !== undefined ? nearestRation(clampNum(d.fuel, 0.25, 1, 1)) : cur.doctrine.fuel
    };
    changed.push('supply doctrine');
  }
  entity.militaryPlan = cur;
  return { plan: cur, changed };
}

// One view row of the log as `see(entityId)` may read it.
function logView(db, see, limit) {
  const rows = [];
  for (const r of (db.militaryLog || []).slice(-(limit || 160))) {
    const n = {};
    for (const id in r.n || {}) if (see(id)) n[id] = r.n[id];
    if (Object.keys(n).length) rows.push({ at: r.at, turn: r.turn, why: r.why, n });
  }
  return rows;
}

module.exports = {
  KINDS, POST_MAX, POLICE_PER_MAX, DOCTRINE_DEFAULTS,
  armsKind, kindIndex, totals, sample, afterTick, planOf, doctrineOf, applyPlan, logView, depotsOf, nationOfUnit
};
