'use strict';
// Building textures — every property carries a `texture` (a filename under
// public/assets/buildings/) chosen automatically from the variants available
// for its structural kind; which variant it gets is random. The GM can still
// PATCH an explicit texture; changing a property's kind re-rolls it so the
// art always matches the structure.
//
// Files come from the "Buildings" source folder, copied to
// public/assets/buildings/ with slugged names. Keep this table in step with
// that directory.
const TEXTURES = {
  office: ['civ-tall.png', 'civ-tall-2.png', 'civ-tall-3.png', 'civ-tall-4.png', 'civ-supertall.png'],
  house: ['civ-small.png', 'civ-wide.png', 'civ-wide-2.png'],
  bank: ['bank-court.png'],
  government: ['bank-court.png'],
  university: ['civ-wide.png', 'civ-wide-2.png'],
  factory: ['industrial.png', 'industrial-complex.png', 'industrial-complex-2.png'],
  mine: ['industrial.png', 'industrial-complex.png'],
  infrastructure: ['industrial.png'],
  farm: ['farm-1.png', 'farm-big-field.png'],
  military_base: ['military-1.png', 'military-complex-1.png', 'military-complex-2.png'],
  fort: ['military-fort.png'],
  port: ['ports.png'],
  airport: ['airport.png'],
  prison: ['prison.png', 'prison-2.png']
};

function randomTexture(kind) {
  const pool = TEXTURES[kind];
  if (!pool || !pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Assign a texture if the property has none (or its current one doesn't fit
// the kind, e.g. after a kind change). Returns true if it changed.
function assignTexture(prop, force) {
  const pool = TEXTURES[prop.kind] || [];
  if (!force && prop.texture && pool.includes(prop.texture)) return false;
  const tex = randomTexture(prop.kind);
  if (!tex) { if (prop.texture) { delete prop.texture; return true; } return false; }
  prop.texture = tex;
  return true;
}

// Migration hook: give every existing property a fitting texture.
function syncAllTextures(world) {
  let changed = false;
  for (const prop of (world.properties || [])) {
    if (assignTexture(prop)) changed = true;
  }
  return changed;
}

module.exports = { TEXTURES, randomTexture, assignTexture, syncAllTextures };
