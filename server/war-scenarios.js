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
// Strengths ×10 (Phase 17 — collision-only combat + 10× HP, see docs/WAR.md):
// paired with server/war.js's K_COMBAT ÷10, this stretches time-to-kill
// roughly 10× so engagements grind instead of resolving in a couple of ticks.
// Applies to NEW wars only — an in-progress war keeps whatever strengths it
// was started with (no migration of a live war.units array).
const UNIT_DEFAULTS = {
  marine:   { strength: 1300, speed: 5.2, atk: 1.0 },
  infantry: { strength: 2100, speed: 3.2, atk: 1.0 },
  armored:  { strength: 2800, speed: 4.6, atk: 1.25 },
  reserve:  { strength: 2400, speed: 3.2, atk: 1.0 }
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
    citySizeStrength: { 1: 1300, 2: 2200, 3: 3800 },
    militaryPropertyStrength: 2600
  },
  tuning: {
    consolidateFrac: 0.35, // AI digs in and stops pushing below this fraction of its starting strength
    collapseFrac: 0.12     // below this, the defender is declared the winner and the war ends
  }
};

// Del' Casia (`for_delcasia`) — southern land-border neighbour on the same
// island (see server/mapdata.js's `delcasia` country shape and the
// road_fork_delcasia/road_delcasia_interior polylines that cross the border
// south of Kordi). `land: true` tells war.js to spawn these units already on
// land, state 'moving', with NO `landing` objective in the list below — see
// docs/WAR.md "Land invasions" and startWar's `scenario.land` branch.
const delcasia_invasion = {
  id: 'delcasia_invasion',
  name: 'The Kordi Incursion',
  attackerId: 'for_delcasia',
  defenderId: 'ent_gov',
  land: true,
  // Del' Casia's own territory just south-east of the Kordi border crossing
  // — units spawn scattered here and march north-west over the frontier.
  staging: { x0: 2380, y0: 1600, x1: 2600, y1: 1850 },
  objectives: [
    { kind: 'seize_city', ref: 'city_surat', priority: 1 },
    { kind: 'control_province', ref: 'prov_kordi', priority: 2 }
  ],
  units: [
    { name: '1st Del’ Casia Infantry Regiment', kind: 'infantry' },
    { name: '2nd Del’ Casia Infantry Regiment', kind: 'infantry' },
    { name: '3rd Del’ Casia Infantry Regiment', kind: 'infantry' },
    { name: '5th Del’ Casia Infantry Regiment', kind: 'infantry' },
    { name: '1st Del’ Casia Armoured Column', kind: 'armored' },
    { name: '2nd Del’ Casia Armoured Column', kind: 'armored' },
    { name: 'Del’ Casia Border Reserve', kind: 'reserve' }
  ],
  defense: {
    citySizeStrength: { 1: 1300, 2: 2200, 3: 3800 },
    militaryPropertyStrength: 2600
  },
  tuning: {
    consolidateFrac: 0.35,
    collapseFrac: 0.12
  }
};

// People's Republic of Qinal (`for_qinal`) — distant hostile power, no shared
// border on the map, so this is a standard embarked naval assault like
// valksland_invasion but staged in the strait north of Port Kradon (between
// the Mazon landmass and Arcasia's north-western coast), driving inland
// through Grazi province instead of east toward the capital.
const qinal_invasion = {
  id: 'qinal_invasion',
  name: 'The Kradon Landings',
  attackerId: 'for_qinal',
  defenderId: 'ent_gov',
  staging: { x0: 850, y0: 330, x1: 1050, y1: 520 },
  objectives: [
    { kind: 'landing', ref: 'city_kradon', priority: 1 },
    { kind: 'seize_city', ref: 'city_kradon', priority: 2 },
    { kind: 'seize_city', ref: 'city_kradesh', priority: 3 },
    { kind: 'control_province', ref: 'prov_grazi', priority: 4 }
  ],
  units: [
    { name: '1st Qinal People’s Marine Brigade', kind: 'marine' },
    { name: '2nd Qinal People’s Marine Brigade', kind: 'marine' },
    { name: '4th Qinal Infantry Division', kind: 'infantry' },
    { name: '7th Qinal Infantry Division', kind: 'infantry' },
    { name: '11th Qinal Infantry Division', kind: 'infantry' },
    { name: '19th Qinal Infantry Division', kind: 'infantry' },
    { name: '2nd Qinal Armoured Regiment', kind: 'armored' },
    { name: 'Qinal Revolutionary Reserve Corps', kind: 'reserve' }
  ],
  defense: {
    citySizeStrength: { 1: 1300, 2: 2200, 3: 3800 },
    militaryPropertyStrength: 2600
  },
  tuning: {
    consolidateFrac: 0.35,
    collapseFrac: 0.12
  }
};

module.exports = {
  scenarios: { valksland_invasion, delcasia_invasion, qinal_invasion },
  UNIT_DEFAULTS
};
