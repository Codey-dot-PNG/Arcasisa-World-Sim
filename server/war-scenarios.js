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
  reserve:  { strength: 2400, speed: 3.2, atk: 1.0 },
  // Transport ships & Boats / Warships feature — naval-only kinds (see
  // war-engine.js's NAVAL_KINDS). `boat` is light, fast and only able to
  // fight while afloat (a beached boat can't deal damage — canFight in the
  // engine). `warship` is the naval-only, RANGED (WARSHIP_RANGE, 180px)
  // heavy hitter that hunts transports/boats — its stats are normally
  // overridden per-spawn from the warship item's meta.weapon (see
  // server/war.js's startWar deployment), these are just the UNIT_DEFAULTS
  // fallback for a GM manual spawn or a legacy/undersupplied item.
  boat:     { strength: 900,  speed: 6.5, atk: 0.8 },
  warship:  { strength: 3600, speed: 3.0, atk: 1.6 }
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
  // Qinal has no map homeland polygon (a distant power — see the comment
  // above), so war.js's dynamic staging (Task 5) can't derive a bearing from
  // a country shape; `bearingHint` is the generic escape hatch for exactly
  // this case — any off-map scenario can supply a compass side ('east',
  // 'west', 'north', 'south') and war.js walks outward from the defender's
  // landmass centroid along that bearing to find open sea, same as it would
  // from a real homeland centroid. Qinal approaches from the EAST (the
  // Antacean ocean side); the old static `staging` box below is now only a
  // last-resort fallback if the dynamic walk fails for any reason (e.g. a
  // future map edit boxes the coast in).
  bearingHint: 'east',
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

// Madrosia (`for_madrosia`) — northern maritime republic to the north-east,
// launches a traditional amphibious assault across the coastal waters onto
// Mezdov province's western seaboard. Stages in open water north-west of
// Mezdov's harbor (coastal assault zone), driving south-east into the province.
const madrosia_invasion = {
  id: 'madrosia_invasion',
  name: 'The Mezdov Landings',
  attackerId: 'for_madrosia',
  defenderId: 'ent_gov',
  // Sea north-west of Mezdov harbor (Mezdov city at [1115, 1225], staging in
  // open water north of the city, between Mazon's island territory and the
  // Arcasian coast).
  staging: { x0: 900, y0: 800, x1: 1100, y1: 1000 },
  objectives: [
    { kind: 'landing', ref: 'city_mezdov', priority: 1 },
    { kind: 'seize_city', ref: 'city_mezdov', priority: 2 },
    { kind: 'control_province', ref: 'prov_mezdov', priority: 3 }
  ],
  units: [
    { name: '1st Madrosian Royal Marine Regiment', kind: 'marine' },
    { name: '2nd Madrosian Royal Marine Regiment', kind: 'marine' },
    { name: '1st Madrosian Naval Infantry Division', kind: 'infantry' },
    { name: '2nd Madrosian Naval Infantry Division', kind: 'infantry' },
    { name: '3rd Madrosian Naval Infantry Division', kind: 'infantry' },
    { name: '4th Madrosian Naval Infantry Division', kind: 'infantry' },
    { name: 'Madrosian Coastal Guard Regiment', kind: 'armored' },
    { name: 'Madrosian Imperial Armoured Squadron', kind: 'armored' },
    { name: 'Madrosian Imperial Reserve', kind: 'reserve' },
    { name: 'Madrosian Garrison Force', kind: 'reserve' },
    { name: 'Madrosian Naval Support Corps', kind: 'infantry' },
    { name: 'Madrosian Shock Contingent', kind: 'armored' }
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

// Solme (`for_solme`) — small south-western land-border neighbour (shares
// borders with Kordi province to the south-west). Launches a swift expeditionary
// raid across the border with light, fast-moving forces. Stages in Solme's own
// territory just south of the frontier (below the road_fork_delcasia and road_fork_solme
// junction). Designed as a rapid strike: few units, high mobility, tight tuning
// so it collapses quickly if momentum is lost.
const solme_invasion = {
  id: 'solme_invasion',
  name: 'The Solme Border Raid',
  attackerId: 'for_solme',
  defenderId: 'ent_gov',
  land: true,
  // Solme's own territory south-west of the Kordi border (Surat at [1768, 1180],
  // staging in Solme territory on the near side of the frontier).
  staging: { x0: 1500, y0: 1600, x1: 1750, y1: 1900 },
  objectives: [
    { kind: 'seize_city', ref: 'city_surat', priority: 1 },
    { kind: 'control_province', ref: 'prov_kordi', priority: 2 }
  ],
  units: [
    { name: 'Solme Light Marines', kind: 'marine' },
    { name: 'Solme 1st Border Infantry', kind: 'infantry' },
    { name: 'Solme 2nd Border Infantry', kind: 'infantry' },
    { name: 'Solme Coastal Armoured Squadron', kind: 'armored' },
    { name: 'Solme Border Guard Contingent', kind: 'reserve' }
  ],
  defense: {
    citySizeStrength: { 1: 1300, 2: 2200, 3: 3800 },
    militaryPropertyStrength: 2600
  },
  tuning: {
    consolidateFrac: 0.30, // digs in sooner — lighter invasion
    collapseFrac: 0.10     // collapses faster — no deep supply
  }
};

// Mazon (`for_mazon`) — island state off the north-western fjords, launches a
// naval assault on Grazi province's western coast, targeting the great port city
// and the heartland of Arcasia's shipyards. Stages in open water west of Port
// Kradon (Mazon sits at [803, 280], Kradon at [348, 186], staging between them
// in the open strait), drives inland to consolidate the maritime province.
const mazon_invasion = {
  id: 'mazon_invasion',
  name: 'The Port Kradon Offensive',
  attackerId: 'for_mazon',
  defenderId: 'ent_gov',
  // Sea west of Grazi, in the coastal waters north-west of Port Kradon,
  // between Mazon's island territory and the Arcasian coast.
  staging: { x0: 400, y0: 200, x1: 600, y1: 450 },
  objectives: [
    { kind: 'landing', ref: 'city_kradon', priority: 1 },
    { kind: 'seize_city', ref: 'city_kradon', priority: 2 },
    { kind: 'seize_city', ref: 'city_kradesh', priority: 3 },
    { kind: 'control_province', ref: 'prov_grazi', priority: 4 }
  ],
  units: [
    { name: '1st Mazon Island Defence Marines', kind: 'marine' },
    { name: '2nd Mazon Island Defence Marines', kind: 'marine' },
    { name: 'Mazon Naval Infantry 1st Regiment', kind: 'infantry' },
    { name: 'Mazon Naval Infantry 2nd Regiment', kind: 'infantry' },
    { name: 'Mazon Coastal Rangers', kind: 'infantry' },
    { name: 'Mazon Garrison Force', kind: 'armored' },
    { name: 'Mazon Naval Support Squadron', kind: 'armored' },
    { name: 'Mazon Island Reserve Corps', kind: 'reserve' }
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

// Aldonesia (`for_aldonesia`) — south-western archipelago power. Its islands
// are scattered across the Strait of Casa with NO land border to Arcasia, so
// this is a naval assault like valksland/qinal, not a land:true scenario:
// the fleet stages in open Antacean water south-west of Mezdov (verified sea
// on the master grid — the coastline reaches within ~100px of Mezdov on its
// south-western side, making it a viable beachhead), lands at the highland
// harbour, then drives east over the mountains into the Kordi interior. An
// ambitious two-city campaign that stretches the attacker across two
// provinces' worth of front.
const aldonesia_invasion = {
  id: 'aldonesia_invasion',
  name: 'The Aldonesian Offensive',
  attackerId: 'for_aldonesia',
  defenderId: 'ent_gov',
  // Open sea between the Aldonesian archipelago and the Mezdov coast — every
  // corner of this box is water (checked against the province/country
  // polygons in server/map-geometry.js).
  staging: { x0: 900, y0: 1400, x1: 1100, y1: 1600 },
  objectives: [
    { kind: 'landing', ref: 'city_mezdov', priority: 1 },
    { kind: 'seize_city', ref: 'city_mezdov', priority: 2 },
    { kind: 'seize_city', ref: 'city_surat', priority: 3 },
    { kind: 'control_province', ref: 'prov_kordi', priority: 4 }
  ],
  units: [
    { name: '1st Aldonesian Expeditionary Marines', kind: 'marine' },
    { name: 'Aldonesian 1st Infantry Brigade', kind: 'infantry' },
    { name: 'Aldonesian 2nd Infantry Brigade', kind: 'infantry' },
    { name: 'Aldonesian 3rd Infantry Brigade', kind: 'infantry' },
    { name: 'Aldonesian Heavy Armour Regiment', kind: 'armored' },
    { name: 'Aldonesian Armoured Squadron', kind: 'armored' },
    { name: 'Aldonesian Assault Armoured Column', kind: 'armored' },
    { name: 'Aldonesian Island Defence Corps', kind: 'reserve' },
    { name: 'Aldonesian Strategic Reserve', kind: 'reserve' },
    { name: 'Aldonesian Garrison Force', kind: 'infantry' },
    { name: 'Aldonesian Combined Operations Group', kind: 'reserve' }
  ],
  defense: {
    citySizeStrength: { 1: 1300, 2: 2200, 3: 3800 },
    militaryPropertyStrength: 2600
  },
  tuning: {
    consolidateFrac: 0.35,  // standard consolidation
    collapseFrac: 0.12      // standard collapse threshold
  }
};

module.exports = {
  scenarios: { valksland_invasion, delcasia_invasion, qinal_invasion, madrosia_invasion, solme_invasion, mazon_invasion, aldonesia_invasion },
  UNIT_DEFAULTS
};
