'use strict';
// Point-in-polygon province lookup for placing map objects server-side. Given a
// point on the 3840×2160 map grid, find which province polygon contains it — so
// a placed/dragged property or marker gets its provinceId from geometry rather
// than a nearest-city guess.
//
// (The filename `map-geometry.js` referenced in the plan is already taken by
// auto-generated map data, so this lives in geometry.js.)
//
// Provinces carry either `path` (array of [x,y] vertices — a single simple
// polygon) or `shape` (an SVG path 'd' string, drawn fill-rule:evenodd).
// Real province outlines are COMPOUND paths — several "M…z" subpaths per
// province (mainland plus small coastal fragments/islands) — and use the
// relative lineto/horizontal/vertical commands (l/h/v), not just absolute
// M/L pairs. A naive "grab every number in the string" parse (the original
// implementation here) silently produces garbage polygons for any shape
// using relative commands, which is most of them — verified against the
// real world data: known landmarks like city positions and province
// label points were resolving to `null`. parseShape below is a small but
// correct SVG path parser (M/m, L/l, H/h, V/v, Z/z — the only commands the
// map data actually uses) that returns one polygon PER SUBPATH; pointInPolygon
// accepts either a single flat polygon or that list of subpaths and applies
// the same even-odd rule SVG itself uses for compound paths.

// Curve commands (c/C and the smooth/quadratic family) appear in a few shapes
// (e.g. prov_mezdov, the Valksland outline). We don't tessellate them — for a
// point-in-polygon test at map-cell resolution a straight line to the segment's
// ENDPOINT is accurate enough — but they MUST be consumed as their own command
// so their control-point numbers don't leak in as stray vertices on the
// preceding line command.
function parseShape(d) {
  const subpaths = [];
  const cmdRe = /([MmLlHhVvCcSsQqTtZz])([^MmLlHhVvCcSsQqTtZz]*)/g;
  let cur = null, x = 0, y = 0, startX = 0, startY = 0, m;
  while ((m = cmdRe.exec(String(d || '')))) {
    const cmd = m[1];
    const nums = (m[2].match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);
    let i = 0;
    switch (cmd) {
      case 'M':
        x = nums[i++]; y = nums[i++];
        cur = [[x, y]]; subpaths.push(cur);
        startX = x; startY = y;
        while (i < nums.length - 1) { x = nums[i++]; y = nums[i++]; cur.push([x, y]); }
        break;
      case 'm':
        x += nums[i++]; y += nums[i++];
        cur = [[x, y]]; subpaths.push(cur);
        startX = x; startY = y;
        while (i < nums.length - 1) { x += nums[i++]; y += nums[i++]; cur.push([x, y]); }
        break;
      case 'L':
        if (!cur) { cur = [[x, y]]; subpaths.push(cur); }
        while (i < nums.length - 1) { x = nums[i++]; y = nums[i++]; cur.push([x, y]); }
        break;
      case 'l':
        if (!cur) { cur = [[x, y]]; subpaths.push(cur); }
        while (i < nums.length - 1) { x += nums[i++]; y += nums[i++]; cur.push([x, y]); }
        break;
      case 'H':
        if (!cur) { cur = [[x, y]]; subpaths.push(cur); }
        while (i < nums.length) { x = nums[i++]; cur.push([x, y]); }
        break;
      case 'h':
        if (!cur) { cur = [[x, y]]; subpaths.push(cur); }
        while (i < nums.length) { x += nums[i++]; cur.push([x, y]); }
        break;
      case 'V':
        if (!cur) { cur = [[x, y]]; subpaths.push(cur); }
        while (i < nums.length) { y = nums[i++]; cur.push([x, y]); }
        break;
      case 'v':
        if (!cur) { cur = [[x, y]]; subpaths.push(cur); }
        while (i < nums.length) { y += nums[i++]; cur.push([x, y]); }
        break;
      // Curves: step to each segment's endpoint (last coord pair of the
      // segment), approximating the curve by a chord. Segment sizes: C/c = 3
      // pairs, S/s & Q/q = 2 pairs, T/t = 1 pair.
      case 'C': case 'S': case 'Q': case 'T': {
        if (!cur) { cur = [[x, y]]; subpaths.push(cur); }
        const pairs = cmd === 'C' ? 3 : cmd === 'T' ? 1 : 2;
        while (i + pairs * 2 <= nums.length) { i += (pairs - 1) * 2; x = nums[i++]; y = nums[i++]; cur.push([x, y]); }
        break;
      }
      case 'c': case 's': case 'q': case 't': {
        if (!cur) { cur = [[x, y]]; subpaths.push(cur); }
        const pairs = cmd === 'c' ? 3 : cmd === 't' ? 1 : 2;
        while (i + pairs * 2 <= nums.length) { i += (pairs - 1) * 2; x += nums[i++]; y += nums[i++]; cur.push([x, y]); }
        break;
      }
      case 'Z': case 'z':
        x = startX; y = startY;
        break;
    }
  }
  return subpaths; // array of polygons: number[][][]
}

function polygonOf(prov) {
  if (Array.isArray(prov.path) && prov.path.length > 2) return prov.path; // single flat polygon
  if (typeof prov.shape === 'string') return parseShape(prov.shape);       // subpaths (compound)
  return null;
}

function rayCross(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Accepts either a single flat polygon ([x,y][]) or a list of subpaths
// ([x,y][][], as returned by parseShape) and applies the even-odd rule
// across every subpath together — exactly what fill-rule:evenodd means for a
// compound SVG path, so a point inside an odd number of overlapping ring
// crossings (e.g. a lake cut out of a landmass) is correctly excluded.
function pointInPolygon(pt, poly) {
  if (!pt || !poly || !poly.length) return false;
  const x = pt[0], y = pt[1];
  const isCompound = Array.isArray(poly[0][0]);
  const subpaths = isCompound ? poly : [poly];
  let inside = false;
  for (const sp of subpaths) {
    if (!sp || sp.length < 3) continue;
    if (rayCross(x, y, sp)) inside = !inside;
  }
  return inside;
}

// Id of the province whose polygon contains pt, or null if none.
function provinceAt(provinces, pt) {
  if (!pt || !Array.isArray(provinces)) return null;
  for (const p of provinces) {
    const poly = polygonOf(p);
    if (poly && poly.length && pointInPolygon(pt, poly)) return p.id;
  }
  return null;
}

module.exports = { provinceAt, pointInPolygon, polygonOf, parseShape };
