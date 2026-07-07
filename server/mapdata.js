'use strict';
/* The world-map model for the 3840×2160 grid.
   Geometry (country/province shapes, city marker centres) comes from
   server/map-geometry.js, generated from the master SVG by
   tools/build-mapdata.js. Everything hand-authored — grey shades for foreign
   powers, text labels, roads and railways — lives here.

   applyMap(db) upgrades a world from the old 1200×675 grid in place: it is
   called by the seed for fresh worlds and by tools/migrate-world.js for an
   existing world.json. */

const GEO = require('./map-geometry');

const SCALE = 3.2; // old 1200×675 grid → 3840×2160 grid

/* ---------- foreign powers (international borders, in distinct greys) ---- */
const COUNTRIES = [
  { id: 'karaznia', name: 'Karaznia', entityId: 'for_karaznia', fill: '#a9a294' },
  { id: 'aragonia', name: 'Aragonia', entityId: 'for_aragonia', fill: '#bab3a5' },
  { id: 'madrosia', name: 'Madrosia', entityId: 'for_madrosia', fill: '#9c958a' },
  { id: 'mazon', name: 'Mazon', entityId: 'for_mazon', fill: '#b1aa9e' },
  { id: 'valksland', name: 'Valksland', entityId: 'for_valksland', fill: '#b5aea1' },
  { id: 'delcasia', name: 'Del’ Casia', entityId: 'for_delcasia', fill: '#a49d92' },
  { id: 'solme', name: 'Solme', entityId: 'for_solme', fill: '#90897e' },
  { id: 'aldonesia', name: 'Aldonesia', entityId: 'for_aldonesia', fill: '#9d968b' },
  { id: 'iceland', name: 'Iceland', entityId: 'for_iceland', fill: '#c2bbb0' }
];

/* foreign entities that don't exist in older worlds */
const NEW_FOREIGN_ENTITIES = [
  { id: 'for_karaznia', type: 'foreign', name: 'Karaznia', color: '#6f6a5e', stance: 'Neutral', description: 'Northern neighbour beyond the Mazon marches. Old kingdoms, cold harbours.', vars: {}, inventory: [] },
  { id: 'for_aragonia', type: 'foreign', name: 'Aragonia', color: '#847f70', stance: 'Neutral', description: 'North-eastern power on the far shore of the border hills.', vars: {}, inventory: [] },
  { id: 'for_iceland', type: 'foreign', name: 'Iceland', color: '#8c8779', stance: 'Neutral', description: 'A remote southern island territory, mostly fog.', vars: {}, inventory: [] }
];

/* ---------- province label typography (position, tilt, size) ------------- */
const PROV_LABELS = {
  prov_grazi: { labelPos: [1450, 690], labelRot: -12, labelSize: 88 },
  prov_lachevan: { labelPos: [2140, 760], labelRot: -33, labelSize: 92 },
  prov_mezdov: { labelPos: [1392, 1114], labelRot: -27, labelSize: 84 },
  prov_korota: { labelPos: [2198, 1142], labelRot: -12, labelSize: 84 },
  prov_kordi: { labelPos: [1900, 1480], labelRot: -7, labelSize: 72 }
};

/* ---------- editable text markers (GM can move / edit / delete) ---------- */
const LABELS = [
  { id: 'lbl_karaznia', text: 'KARAZNIA', kind: 'country', pos: [1133, 96], rot: -8, size: 60 },
  { id: 'lbl_aragonia', text: 'ARAGONIA', kind: 'country', pos: [1609, 80], rot: -6, size: 60 },
  { id: 'lbl_madrosia', text: 'Madrosia', kind: 'country', pos: [1839, 190], rot: -4, size: 44 },
  { id: 'lbl_mazon', text: 'Mazon', kind: 'country', pos: [803, 280], rot: -10, size: 44 },
  { id: 'lbl_valksland', text: 'VALKSLAND', kind: 'country', pos: [3322, 420], rot: -13, size: 120 },
  { id: 'lbl_aldonesia', text: 'ALDONESIA', kind: 'country', pos: [1068, 1801], rot: -33, size: 58 },
  { id: 'lbl_solme', text: 'SOLME', kind: 'country', pos: [1622, 1834], rot: -60, size: 62 },
  { id: 'lbl_delcasia', text: "DEL' CASIA", kind: 'country', pos: [2367, 1740], rot: -10, size: 86 },
  { id: 'lbl_kordi_sub', text: 'SEMI-AUTONOMOUS REGION', kind: 'note', pos: [1930, 1528], rot: -7, size: 22 },
  { id: 'lbl_valgos_strait', text: 'STRAIT OF VALGOS', kind: 'sea', pos: [2700, 680], rot: 77, size: 42 },
  { id: 'lbl_casa_strait', text: 'STRAIT OF CASA', kind: 'sea', pos: [1943, 2083], rot: -3, size: 34 },
  { id: 'lbl_antacean', text: 'ANTACEAN SEA', kind: 'sea', pos: [430, 1180], rot: -78, size: 46 }
];

/* ---------- transport network (GM-editable with the map pen tool) --------
   Digitised from the reference PNG; junction points sit on the city markers. */
const ROADS = [
  { id: 'road_north_continent', pts: [[0, 140], [420, 112], [900, 120], [1250, 142], [1560, 116], [1770, 176], [1853, 282]] },
  { id: 'road_mazon_kradon', pts: [[1104, 257], [1122, 380], [1108, 500], [1110, 611]] },
  { id: 'road_kradon_grazile', pts: [[1110, 611], [1178, 722], [1240, 853]] },
  { id: 'road_grazile_mezdov', pts: [[1240, 853], [1172, 1020], [1116, 1226]] },
  { id: 'road_grazile_airport', pts: [[1240, 853], [1452, 742], [1682, 600], [1910, 518]] },
  { id: 'road_madrosia_airport', pts: [[1853, 282], [1878, 400], [1910, 518]] },
  { id: 'road_airport_lachevan', pts: [[1910, 518], [2122, 500], [2364, 456]] },
  { id: 'road_lachevan_valgos', pts: [[2364, 456], [2456, 570], [2583, 670]] },
  { id: 'road_lachevan_razno', pts: [[2364, 456], [2412, 662], [2445, 893]] },
  { id: 'road_airport_kradeno', pts: [[1910, 518], [1936, 700], [1941, 919]] },
  { id: 'road_kradeno_razno', pts: [[1941, 919], [2182, 906], [2445, 893]] },
  { id: 'road_kradeno_surat', pts: [[1941, 919], [1862, 1050], [1769, 1181]] },
  { id: 'road_surat_mezdov', pts: [[1769, 1181], [1452, 1216], [1116, 1226]] },
  { id: 'road_surat_fork', pts: [[1769, 1181], [1802, 1352], [1750, 1520]] },
  { id: 'road_fork_delcasia', pts: [[1750, 1520], [2082, 1502], [2406, 1465]] },
  { id: 'road_fork_solme', pts: [[1750, 1520], [1782, 1790], [1795, 2035]] },
  { id: 'road_fork_southwest', pts: [[1750, 1520], [1572, 1642], [1452, 1770]] },
  { id: 'road_delcasia_interior', pts: [[2406, 1465], [2520, 1622], [2516, 1830], [2400, 1980]] },
  { id: 'road_solme_interior', pts: [[1795, 2035], [1930, 2090], [2080, 2105]] }
];
const RAILS = [
  { id: 'rail_western', pts: [[1110, 611], [1240, 853], [1520, 760], [1910, 518], [2364, 456]] },
  { id: 'rail_valgos', pts: [[2364, 456], [2470, 572], [2583, 670]] },
  { id: 'rail_eastern', pts: [[2364, 456], [2418, 680], [2445, 893]] },
  { id: 'rail_southern', pts: [[2445, 893], [2182, 912], [1941, 919], [1862, 1060], [1769, 1181]] },
  { id: 'rail_kordi', pts: [[1769, 1181], [1444, 1220], [1116, 1226]] },
  { id: 'rail_madrosia_intl', pts: [[1853, 282], [1880, 405], [1910, 518]] }
];

/* ---------- cities ----------
   Marker centres from the SVG are authoritative for existing cities;
   Grazile and Kradeno are new towns introduced by the map. */
const CITY_MARKERS = {
  city_lachevan: 'Lachaven',
  city_kradon: 'Port Kradon',
  city_razno: 'Razno',
  city_surat: 'Surat',
  city_mezdov: 'Mezdov',
  city_valgos: 'Cape Valgos'
};
const NEW_CITIES = [
  { id: 'city_grazile', provinceId: 'prov_grazi', name: 'Grazile', marker: 'Grazile', size: 1, isCapital: false, description: 'Coastal junction town of southern Grazi, where the western road meets the highland passes.' },
  { id: 'city_kradeno', provinceId: 'prov_lachevan', name: 'Kradeno', marker: 'Kradeno', size: 1, isCapital: false, description: 'Crossroads town where the Lachevan, Kordi and Korota roads meet.' }
];

const rnd = (p) => [Math.round(p[0]), Math.round(p[1])];
const deep = (o) => JSON.parse(JSON.stringify(o));

/* the settings.map document stored on the world */
function buildMapSettings() {
  return {
    schema: 1,
    width: GEO.VIEW.w,
    height: GEO.VIEW.h,
    countries: COUNTRIES.map(c => ({ ...c, shape: GEO.COUNTRIES[c.id] })),
    labels: deep(LABELS),
    roads: deep(ROADS),
    rails: deep(RAILS)
  };
}

/* Upgrade a world in place. Returns false when it is already on the new map. */
function applyMap(db) {
  if (db.settings.map && db.settings.map.schema >= 1) return false;

  // anchors: existing cities on the old grid → their SVG marker centres.
  // Everything placed on the old map moves with its nearest city so property
  // clusters stay glued to the towns they were drawn around.
  const anchors = [];
  for (const c of db.cities) {
    const mk = CITY_MARKERS[c.id];
    if (mk && GEO.MARKERS[mk] && Array.isArray(c.pos)) anchors.push({ old: c.pos.slice(), nw: GEO.MARKERS[mk].slice() });
  }
  const up = (pos) => {
    if (!Array.isArray(pos) || pos.length < 2) return pos;
    const base = [pos[0] * SCALE, pos[1] * SCALE];
    let best = null, bd = Infinity;
    for (const a of anchors) {
      const d = (pos[0] - a.old[0]) ** 2 + (pos[1] - a.old[1]) ** 2;
      if (d < bd) { bd = d; best = a; }
    }
    if (!best) return rnd(base);
    return rnd([base[0] + best.nw[0] - best.old[0] * SCALE, base[1] + best.nw[1] - best.old[1] * SCALE]);
  };

  for (const pr of db.properties) if (pr.pos) pr.pos = up(pr.pos);
  for (const c of db.cities) if (!CITY_MARKERS[c.id] && c.pos) c.pos = up(c.pos);
  for (const c of db.cities) {
    const mk = CITY_MARKERS[c.id];
    if (mk && GEO.MARKERS[mk]) c.pos = rnd(GEO.MARKERS[mk]);
  }
  for (const nc of NEW_CITIES) {
    if (db.cities.some(c => c.id === nc.id)) continue;
    const { marker, ...city } = nc;
    db.cities.push({ ...city, pos: rnd(GEO.MARKERS[marker]) });
  }

  // province geometry from the SVG (multi-polygon path data replaces the old
  // hand-drawn single polygons)
  for (const p of db.provinces) {
    if (GEO.PROVINCES[p.id]) {
      p.shape = GEO.PROVINCES[p.id];
      delete p.path;
      Object.assign(p, PROV_LABELS[p.id]);
    } else if (p.path) {
      // custom province from an older world: carry it across at scale
      p.path = p.path.map(pt => rnd([pt[0] * SCALE, pt[1] * SCALE]));
      if (p.labelPos) p.labelPos = rnd([p.labelPos[0] * SCALE, p.labelPos[1] * SCALE]);
    }
  }

  // foreign powers that the map shows but older worlds never had on file
  for (const e of NEW_FOREIGN_ENTITIES) {
    if (!db.entities.some(x => x.id === e.id)) db.entities.push(deep(e));
  }

  db.settings.map = buildMapSettings();
  delete db.settings.mapDecor;
  return true;
}

module.exports = { SCALE, COUNTRIES, LABELS, ROADS, RAILS, PROV_LABELS, buildMapSettings, applyMap, GEO };
