'use strict';
/* Territory editing (GM border painter). The GM's browser does the painting:
   it rasterises every region (province / foreign country) into a soft
   ownership field, lets the brush push borders around, and re-traces the
   regions it touched as smooth contours clipped to the pristine coastline
   (see public/js/borders.js). This module only VALIDATES and STORES the
   result, so every existing consumer of `shape` — the map, the war engine's
   land grid, geometry.provinceAt — keeps working unchanged.

   settings.map.land holds the pristine land outline (every region shape as
   it stood before the first border edit). The painter clips to it so a
   coastline never erodes no matter how many times its region is repainted.
   It is GM tooling data: api.filterState strips it from every payload. */

const store = require('./store');
const geometry = require('./geometry');

const MAX_SHAPE = 400000;                      // chars per region path
const SHAPE_RE = /^[MmLlZzHhVv0-9eE.,\s+-]*$/;  // contour output: M/l/z (+h/v tolerated)

function mapDoc(db) {
  db.settings.map = db.settings.map || {};
  db.settings.map.countries = db.settings.map.countries || [];
  db.settings.map.labels = db.settings.map.labels || [];
  return db.settings.map;
}

// Every land shape currently on the map — the pristine outline the painter
// clips against until one is stored.
function currentLand(db) {
  const out = [];
  for (const p of db.provinces || []) if (p.shape) out.push(p.shape);
  for (const c of mapDoc(db).countries) if (c.shape) out.push(c.shape);
  return out;
}
function landOf(db) {
  const m = mapDoc(db);
  return Array.isArray(m.land) && m.land.length ? m.land : currentLand(db);
}

const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'land';
const hex = (c, dflt) => /^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c) : dflt;

// A new province record with sensible defaults: variables from the
// definitions (or the first province), demographics shaped like the first
// province's mix and scaled to `population`.
function createProvince(db, opts) {
  opts = opts || {};
  const name = String(opts.name || '').trim().slice(0, 60);
  if (!name) throw new Error('A province needs a name.');
  const pop = Math.max(0, Math.round(Number(opts.population) || 0));
  const template = db.provinces[0];
  const vars = {};
  for (const v of (db.variables || [])) if (v.scope === 'province') vars[v.key] = Number(v.default) || 0;
  if (template && template.vars) for (const k in template.vars) if (vars[k] === undefined) vars[k] = template.vars[k];
  vars.population = pop;
  const demographics = {};
  if (template && template.demographics) {
    const tPop = Object.values(template.demographics).reduce((s, g) => s + (g.population || 0), 0) || 1;
    for (const g in template.demographics) {
      demographics[g] = Object.assign({}, template.demographics[g], { population: Math.round((template.demographics[g].population || 0) / tPop * pop) });
    }
  } else {
    for (const g of ((db.settings.demographics || {}).groups || [])) demographics[g] = { population: 0 };
  }
  const prov = {
    id: store.uid('prov'),
    name,
    color: hex(opts.color, '#8a8a6a'),
    shape: '',
    labelPos: Array.isArray(opts.labelPos) ? opts.labelPos.slice(0, 2).map(Number) : [1920, 1080],
    labelRot: 0,
    labelSize: 56,
    capital: null,
    description: String(opts.description || '').slice(0, 2000),
    vars,
    demographics
  };
  db.provinces.push(prov);
  return prov;
}

// A new foreign country on the map: its entity (an existing one, or a fresh
// 'foreign' entity), the map region and a country-name label.
function createCountry(db, opts) {
  opts = opts || {};
  const name = String(opts.name || '').trim().slice(0, 60);
  if (!name) throw new Error('A country needs a name.');
  const m = mapDoc(db);
  let entity = opts.entityId ? db.entities.find(e => e.id === opts.entityId) : null;
  if (opts.entityId && !entity) throw new Error('Unknown entity.');
  if (entity && m.countries.some(c => c.entityId === entity.id)) throw new Error(entity.name + ' already has territory on the map.');
  const fill = hex(opts.fill, '#a8a196');
  if (!entity) {
    entity = { id: store.uid('for'), type: 'foreign', name, color: hex(opts.color, '#6f6a5e'), stance: 'Neutral', description: String(opts.description || '').slice(0, 2000), vars: {}, inventory: [] };
    db.entities.push(entity);
  }
  let id = slug(name);
  while (m.countries.some(c => c.id === id)) id = slug(name) + '_' + Math.random().toString(36).slice(2, 5);
  const country = { id, name, entityId: entity.id, fill, shape: '' };
  m.countries.push(country);
  if (!m.labels.some(l => l.id === 'lbl_' + id)) {
    m.labels.push({ id: 'lbl_' + id, text: name.toUpperCase(), kind: 'country', pos: [1920, 1080], rot: 0, size: 54 });
  }
  return { country, entity };
}

function validShape(s) {
  return typeof s === 'string' && s.length <= MAX_SHAPE && SHAPE_RE.test(s);
}

// Re-home the cities and properties whose ground actually changed hands:
// only when the province containing a point BEFORE the save differs from
// the one containing it AFTER (so a GM's manual assignment elsewhere on the
// map is never second-guessed). Ground now on foreign soil keeps no
// province (provinceId null).
function rehome(db, before, removedIds) {
  let moved = 0, abroad = 0;
  const fix = (o) => {
    if (!Array.isArray(o.pos)) return;
    const was = geometry.provinceAt(before, o.pos);
    const now = geometry.provinceAt(db.provinces, o.pos);
    if (was === now && !removedIds.has(o.provinceId)) return;
    if (now) { if (now !== o.provinceId) { o.provinceId = now; moved++; } }
    else { if (o.provinceId) o.provinceId = null; abroad++; }
  };
  for (const c of db.cities || []) fix(c);
  for (const pr of db.properties || []) fix(pr);
  for (const p of db.provinces) if (p.capital && !(db.cities || []).some(c => c.id === p.capital && c.provinceId === p.id)) p.capital = null;
  return { moved, abroad };
}

/* Apply a painter save:
     { regions: [{ kind:'province'|'country', id, shape, labelPos? }],
       remove:  [{ kind, id }] }   — regions given away / annexed
   Returns a summary for the response and the audit log. */
function applyTerritory(db, body) {
  const m = mapDoc(db);
  const regions = Array.isArray(body && body.regions) ? body.regions : [];
  const remove = Array.isArray(body && body.remove) ? body.remove : [];
  if (!regions.length && !remove.length) throw new Error('Nothing to save.');
  if (regions.length > 200 || remove.length > 200) throw new Error('Too many regions in one save.');
  const findRegion = (r) => r.kind === 'province' ? db.provinces.find(p => p.id === r.id)
    : r.kind === 'country' ? m.countries.find(c => c.id === r.id) : null;
  for (const r of regions) {
    if (!r || !findRegion(r)) throw new Error('Unknown region: ' + (r && r.id));
    if (!validShape(r.shape)) throw new Error('Malformed border for ' + r.id + '.');
  }
  for (const r of remove) if (!r || !findRegion(r)) throw new Error('Unknown region: ' + (r && r.id));
  // a live election counts by province, and a running conflict's grid was
  // built from today's provinces — don't dissolve one out from under them
  if (remove.some(r => r.kind === 'province')) {
    if (db.election && db.election.active) throw new Error('An election is underway — dissolve provinces after it ends.');
    if ((db.war && db.war.active) || (db.protest && db.protest.active)) throw new Error('A conflict is underway — dissolve provinces after it ends.');
  }
  // first border edit: freeze the pristine coastline before anything moves
  if (!Array.isArray(m.land) || !m.land.length) m.land = currentLand(db);
  const before = db.provinces.map(p => ({ id: p.id, shape: p.shape, path: p.path }));

  const names = [];
  for (const r of regions) {
    const obj = findRegion(r);
    obj.shape = r.shape;
    if (r.kind === 'province') delete obj.path;
    if (Array.isArray(r.labelPos) && r.labelPos.length === 2 && r.labelPos.every(Number.isFinite)) {
      const pos = r.labelPos.map(v => Math.round(v));
      if (r.kind === 'province') obj.labelPos = pos;
      else { const lbl = m.labels.find(l => l.id === 'lbl_' + obj.id); if (lbl) lbl.pos = pos; }
    }
    names.push(obj.name);
  }
  const removedNames = [];
  const removedProv = new Set();
  for (const r of remove) {
    if (r.kind === 'province') {
      const p = db.provinces.find(x => x.id === r.id);
      removedNames.push(p.name);
      removedProv.add(p.id);
      db.provinces = db.provinces.filter(x => x.id !== p.id);
    } else {
      const c = m.countries.find(x => x.id === r.id);
      removedNames.push(c.name);
      m.countries = m.countries.filter(x => x.id !== c.id);
      m.labels = m.labels.filter(l => l.id !== 'lbl_' + c.id);
    }
  }
  const homes = rehome(db, before, removedProv);
  return { reshaped: names, removed: removedNames, moved: homes.moved, abroad: homes.abroad };
}

module.exports = { landOf, currentLand, createProvince, createCountry, applyTerritory, validShape };
