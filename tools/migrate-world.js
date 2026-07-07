'use strict';
/* One-time upgrade of an existing data/world.json to the SVG-based
   3840×2160 map (provinces get real shapes, cities snap to their markers,
   properties move with their nearest city, settings.map is created).

   A backup is written next to the world file first.

   Run with the server STOPPED:  node tools/migrate-world.js                 */

const fs = require('fs');
const path = require('path');
const mapdata = require('../server/mapdata');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'world.json');

if (!fs.existsSync(FILE)) {
  console.log('No world file at', FILE, '— nothing to migrate (a fresh seed already uses the new map).');
  process.exit(0);
}
const db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
if (db.settings.map && db.settings.map.schema >= 1) {
  console.log('World is already on the new map. Nothing to do.');
  process.exit(0);
}

const backup = path.join(DATA_DIR, 'world.backup-premap.json');
fs.writeFileSync(backup, JSON.stringify(db));
console.log('backup written:', backup);

mapdata.applyMap(db);
fs.writeFileSync(FILE, JSON.stringify(db));

console.log('migrated:', FILE);
console.log('  provinces :', db.provinces.map(p => p.name).join(', '));
console.log('  cities    :', db.cities.map(c => `${c.name} @ ${c.pos}`).join(' | '));
console.log('  countries :', db.settings.map.countries.map(c => c.name).join(', '));
console.log('  labels/roads/rails:', db.settings.map.labels.length, '/', db.settings.map.roads.length, '/', db.settings.map.rails.length);
console.log('\nNote: snapshots taken before this migration still hold the old map;');
console.log('rolling back to one will bring the old map back.');
