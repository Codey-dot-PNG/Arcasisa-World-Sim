'use strict';
// Point-in-polygon province lookup for placing map objects server-side. Given a
// point on the 3840×2160 map grid, find which province polygon contains it — so
// a placed/dragged property or marker gets its provinceId from geometry rather
// than a nearest-city guess.
//
// (The filename `map-geometry.js` referenced in the plan is already taken by
// auto-generated map data, so this lives in geometry.js.)
//
// Provinces carry either `path` (array of [x,y] vertices) or `shape` (an SVG
// path 'd' string). For `shape` we extract every coordinate pair as a vertex;
// province outlines are near-polylines so this is accurate enough for a
// "which province did I click" test.

function parseShape(d) {
  const pts = [];
  const re = /(-?\d*\.?\d+)[ ,]+(-?\d*\.?\d+)/g;
  let m;
  while ((m = re.exec(String(d)))) pts.push([parseFloat(m[1]), parseFloat(m[2])]);
  return pts;
}

function polygonOf(prov) {
  if (Array.isArray(prov.path) && prov.path.length > 2) return prov.path;
  if (typeof prov.shape === 'string') return parseShape(prov.shape);
  return null;
}

function pointInPolygon(pt, poly) {
  if (!pt || !poly || poly.length < 3) return false;
  const x = pt[0], y = pt[1];
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Id of the province whose polygon contains pt, or null if none.
function provinceAt(provinces, pt) {
  if (!pt || !Array.isArray(provinces)) return null;
  for (const p of provinces) {
    const poly = polygonOf(p);
    if (poly && poly.length > 2 && pointInPolygon(pt, poly)) return p.id;
  }
  return null;
}

module.exports = { provinceAt, pointInPolygon, polygonOf, parseShape };
