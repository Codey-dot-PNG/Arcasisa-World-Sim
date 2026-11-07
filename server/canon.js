'use strict';
/* The baseline ("canon") layer — what survives a reset.

   A world mixes three kinds of data:
     · engine content — created by store.migrate on every load (weapons,
       arsenals, airbases…). A reset recreates it; nothing to keep.
     · authored content — names, descriptions, new characters, places,
       variables, events, roles, markers, settings tuning. Some of it is
       canon (keep it in the next world), some belongs to this campaign.
     · play state — balances, inventories, shares, news, elections. A reset
       throws it away.

   This module separates the second kind and keeps what the GM marks canon:

     reference(db)   the world a reset produces RIGHT NOW: the seed
                     (data/baseline-world.json) + migrate + the saved canon.
     scanOne(ref, w) every authored difference between a world (the live
                     one, or an old export) and the reference, as candidates.
     merge(scans)    many sources in time order → one list: new records as
                     first created, edits at their latest value, and where
                     each was first seen.
     save/remove     keep candidates in `db.canon.entries` (GM-only data —
                     filterState never ships it).
     apply(world)    write the saved canon into a world (store.reset calls it
                     after re-seeding, so the canon survives every reset).
     bake(db)        a whole baseline file: seed + migrate + canon applied.

   Generic: field groups name record fields, never a world. */
const store = require('./store');
const deeds = require('./deeds');
const market = require('./market');
const mapdata = require('./mapdata');

// Each collection's fields, by what they are. `text` is offered as kept by
// default; `setup` and `ownership` are offered unticked (they change in play
// as often as by design). Everything not listed is play state, never offered
// as an edit — but a NEW record is kept whole, as it was first created, minus
// `volatile` fields.
const GROUPS = {
  entities: {
    text: ['name', 'description', 'title', 'abbrev', 'industry', 'logo', 'color', 'stance', 'ideology'],
    setup: ['type', 'meta', 'militaryPlan'],
    ownership: ['ownerId', 'ceoId', 'leaderId', 'executives', 'inGovernment', 'shareholders', 'sharesOutstanding', 'publicFloat'],
    volatile: ['roster', 'pendingRequests', 'vol', 'dayHistory', 'dayAnchor', 'marketDepth', 'x100', 'whereabouts', 'deceased', 'confidence']
  },
  properties: {
    text: ['name', 'description', 'icon'],
    setup: ['pos', 'kind', 'type', 'provinceId', 'value', 'income', 'expenses', 'prodMode', 'produces', 'requires', 'cashPerTurn', 'maxEmployees', 'targetRevenue'],
    ownership: ['ownerId'],
    volatile: ['accident', 'texture', 'workerHappiness', 'upgradeInvested']
  },
  provinces: {
    text: ['name', 'description', 'color', 'capital', 'labelPos', 'labelRot', 'labelSize'],
    setup: ['shape', 'path'],
    volatile: []
  },
  cities: { text: ['name', 'description'], setup: ['pos', 'size', 'isCapital', 'provinceId'], volatile: [] },
  items: { text: ['name', 'description', 'icon', 'category'], setup: ['tradable', 'marketValue', 'meta'], volatile: [] },
  variables: { text: ['key', 'label', 'scope', 'format', 'default'], volatile: [] },
  events: { text: ['name', 'description', 'effects', 'trigger', 'conditions', 'enabled'], volatile: ['runs', 'lastTurn'] },
  roles: { text: ['name', 'perms'], volatile: [] },
  markers: { text: ['title', 'description', 'icon', 'pos', 'provinceId'], volatile: ['createdTurn'] }
};
const GROUP_LABEL = { text: 'Text & look', setup: 'Setup', ownership: 'Ownership' };
const DEFINITION_COLLS = new Set(['variables', 'events', 'roles', 'markers']);
// Settings worth keeping, as dotted paths. Clock, cadence and the trade
// order book are play state and never offered.
const SETTINGS_PATHS = [
  'worldName', 'currency', 'currencyName', 'parliamentSeats', 'economy', 'taxation', 'war', 'ambience', 'election',
  'demographics', 'entertainment', 'music', 'newspapers', 'newspaperRouting', 'newsThresholds',
  'registration', 'time.unit', 'time.perTurn', 'trade.partners', 'trade.tariffs',
  'map.countries', 'map.labels', 'map.roads', 'map.rails', 'map.lights'
];
const SETTINGS_OFF = /^(map\.|households|demographics|election)/; // offered unticked

const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const norm = (v) => (v === undefined || v === null || v === '') ? null : v;
// Compare by meaning, not spelling: cloud exports come back from Postgres
// (jsonb) with object keys reordered, and simple lists (a role's pages, a
// board's members) in a different order with the same contents.
function canonical(v) {
  if (Array.isArray(v)) {
    const c = v.map(canonical);
    return c.every(x => x === null || typeof x !== 'object') ? c.slice().sort((a, b) => String(a).localeCompare(String(b))) : c;
  }
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]); return o; }
  return v;
}
const same = (a, b) => JSON.stringify(canonical(norm(a))) === JSON.stringify(canonical(norm(b)));
const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
function setPath(o, p, v) {
  const ks = p.split('.');
  let x = o;
  for (const k of ks.slice(0, -1)) { if (!x[k] || typeof x[k] !== 'object') x[k] = {}; x = x[k]; }
  if (v === undefined) delete x[ks[ks.length - 1]]; else x[ks[ks.length - 1]] = v;
}
const words = (n) => String(n || '').toLowerCase().split(/[^a-z\u00c0-\u024f']+/).filter(w => w.length > 2);
const sharesAWord = (a, b) => { const A = new Set(words(a)); return words(b).some(w => A.has(w)); };
const labelOf = (r) => (r && (r.name || r.title || r.label || r.key || r.id)) || '?';
// derived items mirror canonical records (deeds ↔ property owner, share
// certificates ↔ register) — they are rebuilt, never kept on their own
const isDerivedItem = (it) => !!(it && it.meta && (it.meta.propertyId || it.meta.companyId || it.meta.leveraged || it.meta.bond));

/* ---------- the reference: what a reset gives now ---------- */
function freshSeed() {
  const seedMod = require('./seed');
  const w = seedMod.seed();
  store.migrate(w);
  mapdata.applyMap(w);
  return w;
}
function reference(db) {
  const w = freshSeed();
  if (db && db.canon) { w.canon = clone(db.canon); apply(w); }
  return w;
}
// bring an old export up to the current shape before comparing (the same
// steps an import takes), on a copy
function prepare(world) {
  const w = clone(world);
  try { store.migrate(w); } catch (e) { /* compare as it is */ }
  try { mapdata.applyMap(w); } catch (e) { /* idem */ }
  return w;
}

/* ---------- one source vs the reference ---------- */
// Economy v2: a good's home-market state (meta.demand/market/basePrice) is
// play state the engine rewrites every turn, and its marketValue moves with
// demand. What a GM authors is its normal price — meta.basePrice, which the
// engine moves only when the GM or an event reprices — so items compare on
// that, and on meta without the engine's keys.
const ENGINE_META = ['demand', 'market', 'basePrice', '_lastPrice'];
function fieldOf(coll, rec, f) {
  if (coll === 'items' && rec) {
    if (f === 'meta' && rec.meta) { const m = { ...rec.meta }; for (const k of ENGINE_META) delete m[k]; return m; }
    if (f === 'marketValue' && rec.meta && rec.meta.basePrice > 0) return Math.round(rec.meta.basePrice * 100) / 100;
  }
  return rec[f];
}
function cleanRecord(coll, rec, derivedIds) {
  const g = GROUPS[coll];
  const out = clone(rec);
  for (const k of Object.keys(out)) if (k[0] === '_' || g.volatile.includes(k)) delete out[k];
  if (coll === 'items') { out.meta = fieldOf(coll, rec, 'meta'); out.marketValue = fieldOf(coll, rec, 'marketValue'); }
  if (Array.isArray(out.inventory)) out.inventory = out.inventory.filter(r => !derivedIds.has(r.itemId));
  return out;
}
function originOf(coll, rec, src, ref) {
  const name = String(labelOf(rec)).trim();
  if (!name || name.length < 2 || /^(.)\1{3,}$/i.test(name)) return 'junk';
  if (coll === 'entities') {
    const seedUsers = new Set((ref.users || []).map(u => u.id));
    if ((src.users || []).some(u => u.entityId === rec.id && !seedUsers.has(u.id))) return 'player';
  }
  return 'gm';
}
function scanOne(ref, src) {
  const out = [];
  const derivedIds = new Set((src.items || []).filter(isDerivedItem).map(i => i.id));
  for (const coll of Object.keys(GROUPS)) {
    const g = GROUPS[coll];
    const R = new Map((ref[coll] || []).map(r => [r.id, r]));
    const S = new Map((src[coll] || []).map(r => [r.id, r]));
    for (const [id, rec] of S) {
      if (coll === 'items' && isDerivedItem(rec)) continue;
      const base = R.get(id);
      if (!base) {
        const record = cleanRecord(coll, rec, derivedIds);
        const extras = {};
        if (coll === 'entities') {
          extras.accounts = clone((src.accounts || []).filter(a => a.ownerId === id));
          // a new company's share items ride along (holdings are rebuilt from its register)
          extras.items = clone((src.items || []).filter(i => i.meta && i.meta.companyId === id));
        }
        out.push({ key: `${coll}/${id}#add`, kind: 'add', coll, id, label: labelOf(rec), record, extras, origin: originOf(coll, rec, src, ref) });
        continue;
      }
      for (const grp of ['text', 'setup', 'ownership']) {
        if (!g[grp]) continue;
        const fields = {}, from = {};
        for (const f of g[grp]) {
          const a = fieldOf(coll, rec, f), b = fieldOf(coll, base, f);
          if (!same(a, b)) { fields[f] = clone(norm(a)); from[f] = clone(norm(b)); }
        }
        if (!Object.keys(fields).length) continue;
        const c = { key: `${coll}/${id}#${grp}`, kind: grp, coll, id, label: labelOf(rec), fields, from };
        // a seed character given a whole new name was most likely handed to
        // a player in this campaign, not rewritten as canon
        if (coll === 'entities' && grp === 'text' && base.type === 'person' && fields.name !== undefined && !sharesAWord(base.name, rec.name)) c.origin = 'renamed';
        out.push(c);
      }
    }
    for (const [id, base] of R) {
      if (S.has(id) || (coll === 'items' && isDerivedItem(base))) continue;
      out.push({ key: `${coll}/${id}#remove`, kind: 'remove', coll, id, label: labelOf(base) });
    }
  }
  for (const p of SETTINGS_PATHS) {
    const v = getPath(src.settings, p), b = getPath(ref.settings, p);
    if (v === undefined || same(v, b)) continue;
    out.push({ key: `settings/${p}`, kind: 'setting', coll: 'settings', id: p, label: p, value: clone(v) });
  }
  return out;
}

/* ---------- many sources → one list ---------- */
// scans: [{ name, turn, live?, candidates }] in any order; sorted oldest →
// newest by turn, then by the order given — the live world always last.
function merge(scans) {
  // the live world is always the newest, whatever its turn (a fresh campaign
  // can be at turn 0 while an old export sat at turn 15)
  const ordered = scans.map((s, i) => ({ s, i })).sort((a, b) => ((a.s.live ? 1 : 0) - (b.s.live ? 1 : 0)) || ((a.s.turn || 0) - (b.s.turn || 0)) || (a.i - b.i)).map(x => x.s);
  const latest = ordered[ordered.length - 1];
  const byKey = new Map();
  for (const s of ordered) {
    for (const c of s.candidates || []) {
      const m = byKey.get(c.key);
      if (!m) byKey.set(c.key, { first: c, last: c, firstSeen: s.name, lastSeen: s.name, inLatest: s === latest });
      else { m.last = c; m.lastSeen = s.name; m.inLatest = s === latest; }
    }
  }
  const out = [];
  for (const [, m] of byKey) {
    const c = clone(m.last);
    if (c.kind === 'add') {
      // as first created — with its latest wording
      c.record = clone(m.first.record);
      const tf = (GROUPS[c.coll] || {}).text || [];
      for (const f of tf) if (m.last.record && m.last.record[f] !== undefined) c.record[f] = clone(m.last.record[f]);
      c.extras = clone(m.first.extras);
    }
    c.firstSeen = m.firstSeen; c.lastSeen = m.lastSeen; c.inLatest = m.inLatest;
    c.suggest = suggest(c);
    c.groupLabel = c.kind === 'text' && DEFINITION_COLLS.has(c.coll) ? 'Definition' : (GROUP_LABEL[c.kind] || c.kind);
    out.push(c);
  }
  const order = { add: 0, text: 1, setup: 2, ownership: 3, remove: 4, setting: 5 };
  out.sort((a, b) => (order[a.kind] - order[b.kind]) || a.coll.localeCompare(b.coll) || String(a.label).localeCompare(String(b.label)));
  return out;
}
// a starting suggestion only — the GM decides every row
function suggest(c) {
  if (!c.inLatest) return false;                  // changed once, gone now
  if (c.kind === 'text') return c.origin !== 'renamed';
  if (c.kind === 'add') return c.origin === 'gm';
  if (c.kind === 'setting') return !SETTINGS_OFF.test(c.id);
  return false;                                    // setup, ownership, removals
}

/* ---------- keeping ---------- */
function ensure(db) {
  if (!db.canon || typeof db.canon !== 'object') db.canon = { v: 1, entries: {} };
  if (!db.canon.entries) db.canon.entries = {};
  return db.canon;
}
// validate one candidate from the client into a stored entry
function entryOf(c, by) {
  if (!c || typeof c.key !== 'string') throw new Error('Bad entry.');
  const at = Date.now();
  if (c.kind === 'setting') {
    if (!SETTINGS_PATHS.includes(c.id)) throw new Error('Unknown setting: ' + c.id);
    return { key: `settings/${c.id}`, kind: 'setting', coll: 'settings', id: c.id, label: c.id, value: clone(c.value), savedAt: at, savedBy: by };
  }
  const g = GROUPS[c.coll];
  if (!g || typeof c.id !== 'string') throw new Error('Unknown collection: ' + c.coll);
  const base = { coll: c.coll, id: c.id, label: String(c.label || c.id).slice(0, 120), savedAt: at, savedBy: by };
  if (c.kind === 'add') {
    if (!c.record || c.record.id !== c.id) throw new Error('A new record needs its data.');
    const ex = c.extras || {};
    return { ...base, key: `${c.coll}/${c.id}#add`, kind: 'add', record: clone(c.record),
      extras: { accounts: clone(Array.isArray(ex.accounts) ? ex.accounts.filter(a => a.ownerId === c.id) : []), items: clone(Array.isArray(ex.items) ? ex.items : []) } };
  }
  if (c.kind === 'remove') return { ...base, key: `${c.coll}/${c.id}#remove`, kind: 'remove' };
  if (!g[c.kind]) throw new Error('Unknown group: ' + c.kind);
  const fields = {};
  for (const f of Object.keys(c.fields || {})) if (g[c.kind].includes(f)) fields[f] = clone(c.fields[f]);
  if (!Object.keys(fields).length) throw new Error('Nothing to keep in ' + c.key);
  return { ...base, key: `${c.coll}/${c.id}#${c.kind}`, kind: c.kind, fields };
}
function save(db, candidates, by) {
  const canon = ensure(db);
  const saved = [];
  for (const c of candidates) {
    const e = entryOf(c, by);
    // a field edit adds to an earlier one for the same record and group
    const prev = canon.entries[e.key];
    if (prev && prev.fields && e.fields) e.fields = Object.assign({}, prev.fields, e.fields);
    // keeping a record also drops a stale "remove" of it, and vice versa
    if (e.kind === 'remove') { for (const k of Object.keys(canon.entries)) if (k.startsWith(`${e.coll}/${e.id}#`)) delete canon.entries[k]; }
    else delete canon.entries[`${e.coll}/${e.id}#remove`];
    canon.entries[e.key] = e;
    saved.push(e);
  }
  canon.updatedAt = Date.now();
  return saved;
}
function remove(db, keys) {
  const canon = ensure(db);
  let n = 0;
  for (const k of keys || []) if (canon.entries[k]) { delete canon.entries[k]; n++; }
  canon.updatedAt = Date.now();
  return n;
}
// "Save to baseline" on one record: everything about it that differs from
// the reference, as it is now (a new record whole).
function recordCandidates(db, coll, id) {
  const ref = reference(db);
  return scanOne(ref, db).filter(c => c.coll === coll && c.id === id && c.kind !== 'remove');
}

/* ---------- writing the canon into a world ---------- */
function referrers(world, id) {
  const out = [];
  for (const e of world.entities || []) {
    if (e.id === id) continue;
    if (e.ownerId === id) out.push('owns ' + e.name);
    if (e.ceoId === id) out.push('runs ' + e.name);
    if (e.leaderId === id) out.push('leads ' + e.name);
    if ((e.executives || []).includes(id)) out.push('sits on ' + e.name);
    if ((e.shareholders || []).some(s => s.entityId === id)) out.push('holds shares in ' + e.name);
  }
  for (const p of world.properties || []) if (p.ownerId === id) out.push('owns ' + p.name);
  for (const u of world.users || []) if (u.entityId === id) out.push('is the persona of account ' + u.username);
  return out;
}
function apply(world) {
  const entries = Object.values((world.canon && world.canon.entries) || {});
  const report = { applied: 0, skipped: [] };
  if (!entries.length) return report;
  const coll = (c) => (world[c] = Array.isArray(world[c]) ? world[c] : []);
  const touched = new Set();
  // 1. new records, as first created
  for (const e of entries.filter(x => x.kind === 'add')) {
    const arr = coll(e.coll);
    const cur = arr.find(r => r.id === e.id);
    if (cur) Object.assign(cur, clone(e.record)); else arr.push(clone(e.record));
    for (const a of (e.extras && e.extras.accounts) || []) if (!coll('accounts').some(x => x.id === a.id)) world.accounts.push(clone(a));
    for (const it of (e.extras && e.extras.items) || []) if (!coll('items').some(x => x.id === it.id)) world.items.push(clone(it));
    touched.add(e.coll + '/' + e.id); report.applied++;
  }
  // 2. field edits
  for (const e of entries.filter(x => x.fields)) {
    const rec = coll(e.coll).find(r => r.id === e.id);
    if (!rec) { report.skipped.push({ key: e.key, why: 'not in this world' }); continue; }
    for (const [k, v] of Object.entries(e.fields)) { if (v === null) delete rec[k]; else rec[k] = clone(v); }
    touched.add(e.coll + '/' + e.id); report.applied++;
  }
  // 3. settings
  for (const e of entries.filter(x => x.kind === 'setting')) {
    world.settings = world.settings || {};
    setPath(world.settings, e.id, clone(e.value));
    report.applied++;
  }
  // 4. removals — only of records nothing else points at
  for (const e of entries.filter(x => x.kind === 'remove')) {
    const arr = coll(e.coll);
    if (!arr.some(r => r.id === e.id)) continue;
    if (e.coll === 'entities') {
      const refs = referrers(world, e.id);
      if (refs.length) { report.skipped.push({ key: e.key, why: 'still ' + refs.slice(0, 3).join(', ') }); continue; }
      world.accounts = (world.accounts || []).filter(a => a.ownerId !== e.id);
    }
    world[e.coll] = arr.filter(r => r.id !== e.id);
    report.applied++;
  }
  // 5. references from kept records to people/places that are not here
  const ents = new Set((world.entities || []).map(e => e.id));
  const fix = (rec, label) => {
    for (const k of ['ownerId', 'ceoId', 'leaderId']) if (rec[k] && !ents.has(rec[k])) { report.skipped.push({ key: label, why: `${k} → ${rec[k]} is not in this world; cleared` }); delete rec[k]; }
    if (Array.isArray(rec.executives)) rec.executives = rec.executives.filter(x => ents.has(x));
    if (Array.isArray(rec.shareholders)) rec.shareholders = rec.shareholders.filter(s => ents.has(s.entityId));
  };
  for (const t of touched) {
    const [c, id] = t.split('/');
    const rec = (world[c] || []).find(r => r.id === id);
    if (rec && (c === 'entities' || c === 'properties')) fix(rec, t);
  }
  // 6. mirrors follow their canonical records
  try { deeds.syncAllDeeds(world); } catch (e) { report.skipped.push({ key: 'deeds', why: e.message }); }
  try { market.syncAllCertificates(world); } catch (e) { report.skipped.push({ key: 'certificates', why: e.message }); }
  world.canon.lastApplied = { at: Date.now(), applied: report.applied, skipped: report.skipped.slice(0, 50) };
  return report;
}

// A whole baseline file: the seed + migrate + this world's canon applied.
function bake(db) {
  const w = freshSeed();
  w.canon = clone((db && db.canon) || { v: 1, entries: {} });
  apply(w);
  w.sessions = {};
  return w;
}

function summary(db) {
  const entries = Object.values(((db && db.canon) || {}).entries || {});
  const by = {};
  for (const e of entries) by[e.kind] = (by[e.kind] || 0) + 1;
  return { count: entries.length, byKind: by, updatedAt: (db.canon || {}).updatedAt || null, lastApplied: (db.canon || {}).lastApplied || null };
}

module.exports = { GROUPS, SETTINGS_PATHS, reference, prepare, scanOne, merge, save, remove, recordCandidates, apply, bake, summary, freshSeed };
