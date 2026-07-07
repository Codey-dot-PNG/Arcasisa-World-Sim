'use strict';
/* Parses the master map SVG ("Arcasia extra resources/Territories, borders.svg",
   3840×2160) and emits server/map-geometry.js — the raw geometry the engine
   ships: one combined SVG path per country / province, plus the centre point
   of every city marker.

   Run once after editing the SVG:  node tools/build-mapdata.js               */

const fs = require('fs');
const path = require('path');

const SVG_FILE = path.join(__dirname, '..', 'Arcasia extra resources', 'Territories, borders.svg');
const OUT_FILE = path.join(__dirname, '..', 'server', 'map-geometry.js');

const svg = fs.readFileSync(SVG_FILE, 'utf8');

/* ---------- collect paths with their group stack ---------- */
const tagRe = /<g\s+id="([^"]*)"|<\/g>|<path\b[^>]*?\/>/g;
const stack = [];
const paths = []; // { groups:[...], id, d }
let m;
while ((m = tagRe.exec(svg))) {
  const tok = m[0];
  if (tok.startsWith('<g')) { stack.push(m[1]); continue; }
  if (tok === '</g>') { stack.pop(); continue; }
  const idM = tok.match(/\bid="([^"]*)"/);
  const dM = tok.match(/\bd="([^"]*)"/);
  if (!dM) continue;
  paths.push({ groups: stack.slice(), id: idM ? idM[1] : '', d: dM[1].trim() });
}

/* ---------- flatten path data to points (for bounding boxes) ---------- */
function pathPoints(d) {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const pts = [];
  let i = 0, cmd = null, cx = 0, cy = 0, sx = 0, sy = 0;
  const num = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toLowerCase()) {
      case 'm': {
        const x = num(), y = num();
        cx = rel ? cx + x : x; cy = rel ? cy + y : y;
        sx = cx; sy = cy; pts.push([cx, cy]);
        cmd = rel ? 'l' : 'L'; // subsequent pairs are implicit linetos
        break;
      }
      case 'l': { const x = num(), y = num(); cx = rel ? cx + x : x; cy = rel ? cy + y : y; pts.push([cx, cy]); break; }
      case 'h': { const x = num(); cx = rel ? cx + x : x; pts.push([cx, cy]); break; }
      case 'v': { const y = num(); cy = rel ? cy + y : y; pts.push([cx, cy]); break; }
      case 'c': {
        const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
        const bx = rel ? cx : 0, by = rel ? cy : 0;
        pts.push([bx + x1, by + y1], [bx + x2, by + y2]);
        cx = bx + x; cy = by + y; pts.push([cx, cy]);
        break;
      }
      case 'z': cx = sx; cy = sy; break;
      default: throw new Error('Unhandled path command "' + cmd + '" in SVG');
    }
  }
  return pts;
}
function bbox(d) {
  const pts = pathPoints(d);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/* A path attribute's leading relative "m" is absolute (first command of the
   path), but when we concatenate several paths into one, it must become "M". */
const absHead = (d) => d.replace(/^\s*m/, 'M');
const joinShapes = (list) => list.map(p => absHead(p.d)).join(' ');

/* ---------- classify ---------- */
const COUNTRY_KEYS = {
  'Karaznia': 'karaznia',
  'Argonia': 'aragonia',
  'iceland': 'iceland',
  'Islands of Aldonesia': 'aldonesia',
  "Del'Casia Borders": 'delcasia',
  'Mazon Borders': 'mazon',
  'Madrosia Borders': 'madrosia',
  'Solme Borders': 'solme',
  'Valkslands Mainland and Islands': 'valksland'
};
const PROVINCE_KEYS = {
  'Mezdov': 'prov_mezdov', 'Grazi': 'prov_grazi', 'Lachaven': 'prov_lachevan',
  'Korota': 'prov_korota', 'Kordi': 'prov_kordi'
};

const countryParts = {}, provinceParts = {}, markers = {};
for (const p of paths) {
  const top = p.groups[0], inner = p.groups[p.groups.length - 1];
  if (top === 'International Borders') {
    // paths nested in a named sub-group belong to that country; direct
    // children of the top group are classified by their own id
    const key = p.groups.length > 1 ? COUNTRY_KEYS[inner] : COUNTRY_KEYS[p.id];
    if (inner === 'Irrelevant') continue;
    if (!key) throw new Error('Unmapped international border: ' + (p.groups.length > 1 ? inner : p.id));
    (countryParts[key] = countryParts[key] || []).push(p);
  } else if (top === 'Province Arcasia Borders') {
    const key = PROVINCE_KEYS[inner];
    if (!key) throw new Error('Unmapped province group: ' + inner);
    (provinceParts[key] = provinceParts[key] || []).push(p);
  } else if (top === 'Map Markers') {
    const b = bbox(p.d);
    markers[p.id] = [Math.round(b.cx * 10) / 10, Math.round(b.cy * 10) / 10];
  }
}

const COUNTRIES = {}, PROVINCES = {};
for (const k in countryParts) COUNTRIES[k] = joinShapes(countryParts[k]);
for (const k in provinceParts) PROVINCES[k] = joinShapes(provinceParts[k]);

/* ---------- sanity report ---------- */
console.log('countries:', Object.keys(COUNTRIES).length, Object.keys(COUNTRIES).join(', '));
console.log('provinces:', Object.keys(PROVINCES).length, Object.keys(PROVINCES).join(', '));
console.log('markers  :', Object.keys(markers).length);
for (const [name, pos] of Object.entries(markers)) console.log('  •', name, pos);
for (const [k, d] of Object.entries({ ...COUNTRIES, ...PROVINCES })) {
  const b = bbox(d);
  if (b.x0 < -5 || b.y0 < -5 || b.x1 > 3845 || b.y1 > 2165) console.warn('  ! out of canvas:', k, b);
}

/* ---------- emit ---------- */
const out = `'use strict';
/* AUTO-GENERATED by tools/build-mapdata.js from
   "Arcasia extra resources/Territories, borders.svg" — do not edit by hand.
   Canvas: 3840×2160. Shapes are SVG path data (fill-rule: evenodd). */
module.exports = {
  VIEW: { w: 3840, h: 2160 },
  COUNTRIES: ${JSON.stringify(COUNTRIES, null, 2)},
  PROVINCES: ${JSON.stringify(PROVINCES, null, 2)},
  MARKERS: ${JSON.stringify(markers, null, 2)}
};
`;
fs.writeFileSync(OUT_FILE, out);
console.log('\nwrote', OUT_FILE);
