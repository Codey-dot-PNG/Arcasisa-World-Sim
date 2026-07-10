'use strict';
// War scenario data. Pure data — no engine logic lives here (server/war.js
// stays generic; this file is where a specific world's invasion lore lives,
// same split as server/seed.js vs the rest of the engine).
//
// Shape consumed by war.startWar(db, scenario):
//   id, name, attackerId, defenderId          — entity ids (attacker must be
//                                                a 'foreign' entity)
//   staging: { x0, y0, x1, y1 }                — sea box attacker units are
//                                                scattered into at spawn, all
//                                                'embarked'
//   objectives: [{ kind, ref?, priority }]     — ref is a city/province id;
//                                                'seize_capital' may omit ref
//                                                and let war.js resolve
//                                                whichever city carries
//                                                isCapital: true
//   units: [{ name, kind }]                    — kind drives strength/speed
//                                                defaults (unitDefaults below)
//   defense: { citySizeStrength: {1,2,3}, militaryPropertyStrength }
//            — war.js spawns one defender garrison per city (by `size`) and
//              one per property with type:'military', using these numbers.
//              Generic: no city/property ids are named here.
//   tuning: { consolidateFrac, collapseFrac }  — fractions of the attacker's
//            starting total strength that trigger the AI's consolidate phase
//            / the defender's outright victory.

// Per-kind unit defaults. `atk` is a damage-dealt multiplier (armour hits
// harder per engagement); `speed` is in px/tick on the 3840×2160 grid.
const UNIT_DEFAULTS = {
  marine:   { strength: 130, speed: 5.2, atk: 1.0 },
  infantry: { strength: 210, speed: 3.2, atk: 1.0 },
  armored:  { strength: 280, speed: 4.6, atk: 1.25 },
  reserve:  { strength: 240, speed: 3.2, atk: 1.0 }
};

const valksland_invasion = {
  id: 'valksland_invasion',
  name: 'The Valgos Crisis',
  attackerId: 'for_valksland',
  defenderId: 'ent_gov',
  // East of every Arcasian province (the mainland's easternmost points sit
  // around x≈2790 near Cape Valgos) and west of Valksland proper (the label
  // for Valksland sits at x≈3324) — open water in the Strait of Valgos.
  staging: { x0: 2900, y0: 500, x1: 3100, y1: 900 },
  objectives: [
    // Beachhead just off Cape Valgos, the harbour town on the Strait.
    { kind: 'landing', ref: 'city_valgos', priority: 1 },
    { kind: 'seize_city', ref: 'city_valgos', priority: 2 },
    // city_lachevan IS the capital (isCapital: true in the world doc) — one
    // objective covers it, resolved generically by war.js via isCapital
    // rather than naming it twice.
    { kind: 'seize_capital', priority: 3 },
    { kind: 'seize_city', ref: 'city_razno', priority: 4 },
    { kind: 'control_province', ref: 'prov_lachevan', priority: 5 }
  ],
  units: [
    { name: '1st Valks Marine Brigade', kind: 'marine' },
    { name: '2nd Valks Marine Brigade', kind: 'marine' },
    { name: '4th Valks Marine Brigade', kind: 'marine' },
    { name: '12th Valks Infantry Division', kind: 'infantry' },
    { name: '15th Valks Infantry Division', kind: 'infantry' },
    { name: '23rd Valks Infantry Division', kind: 'infantry' },
    { name: '31st Valks Infantry Division', kind: 'infantry' },
    { name: '44th Valks Infantry Division', kind: 'infantry' },
    { name: '58th Valks Infantry Division', kind: 'infantry' },
    { name: '7th Valks Armoured Regiment', kind: 'armored' },
    { name: '9th Valks Armoured Regiment', kind: 'armored' },
    { name: 'Valks Expeditionary Reserve Corps', kind: 'reserve' }
  ],
  defense: {
    citySizeStrength: { 1: 130, 2: 220, 3: 380 },
    militaryPropertyStrength: 260
  },
  tuning: {
    consolidateFrac: 0.35, // AI digs in and stops pushing below this fraction of its starting strength
    collapseFrac: 0.12     // below this, the defender is declared the winner and the war ends
  }
};

module.exports = { scenarios: { valksland_invasion }, UNIT_DEFAULTS };
