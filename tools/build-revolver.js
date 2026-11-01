#!/usr/bin/env node
'use strict';
/* Build the revolver asset for the client (public/js/revolver.js) from the
   source glTF (Sketchfab "Revolver with a bullet", 3DRaizar — used with the
   author's permission).

     node tools/build-revolver.js path/to/scene.gltf [path/to/scene.bin]

   Writes public/assets/models/revolver.json (parts, materials, chamber
   layout, pivots) + revolver.bin (quantised geometry). Zero dependencies.

   What it does to the source:
   · bakes every node transform into the vertices (normals by the inverse-
     transpose — the source scales non-uniformly) and recentres the model on
     the CYLINDER AXIS, which becomes the model's +X axis through the origin
     (barrel toward −X, grip toward +X/−Y, up +Y; the shooter's left is +Z);
   · separates the moving parts: frame (steel), grip (black), cylinder
     (Revolver.001), trigger (Revolver.002), hammer (Revolver.003);
   · finds the six chambers on the cylinder's rear face (angle + radius);
   · REBUILDS the bullet: the source cartridge is ~220k triangles (more than
     twice the whole gun) and lies loose beside the frame. Its profile —
     radius along its own axis — is sampled from the source vertices and
     lathed into a ~2k-triangle cartridge (case, rim, bullet head, primer)
     whose base sits at x=0 and tip toward −x, ready to drop into a chamber.

   Binary layout per part: Int16 positions ×3 (× 1/POS_Q), Int8 normals ×3
   + pad, then Uint16 indices; offsets in the JSON. */
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
if (!src) { console.error('usage: node tools/build-revolver.js scene.gltf [scene.bin]'); process.exit(1); }
const g = JSON.parse(fs.readFileSync(src, 'utf8'));
const binPath = process.argv[3] || path.join(path.dirname(src), g.buffers[0].uri);
const B = fs.readFileSync(binPath);
const OUT = path.join(__dirname, '..', 'public', 'assets', 'models');
const POS_Q = 4096;

// ---------- glTF reading ----------
function accessor(i) {
  const a = g.accessors[i], bv = g.bufferViews[a.bufferView];
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const size = a.componentType === 5126 || a.componentType === 5125 ? 4 : 2;
  const stride = bv.byteStride || n * size;
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const out = new Float64Array(a.count * n);
  for (let k = 0; k < a.count; k++) {
    for (let c = 0; c < n; c++) {
      const o = base + k * stride + c * size;
      out[k * n + c] = a.componentType === 5126 ? B.readFloatLE(o)
        : a.componentType === 5125 ? B.readUInt32LE(o) : B.readUInt16LE(o);
    }
  }
  return out;
}
const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// column-major 4×4 multiply
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function nodeMatrix(n) {
  if (n.matrix) return n.matrix.slice();
  let m = I4();
  if (n.translation) m = mul(m, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...n.translation, 1]);
  if (n.rotation) {
    const [x, y, z, w] = n.rotation;
    m = mul(m, [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
      2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
      2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, 0, 0, 0, 1]);
  }
  if (n.scale) m = mul(m, [n.scale[0], 0, 0, 0, 0, n.scale[1], 0, 0, 0, 0, n.scale[2], 0, 0, 0, 0, 1]);
  return m;
}
// inverse-transpose of the upper 3×3 (for normals)
function normalMatrix(m) {
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = a;
  const b01 = a22 * a11 - a12 * a21, b11 = -a22 * a10 + a12 * a20, b21 = a21 * a10 - a11 * a20;
  const det = a00 * b01 + a01 * b11 + a02 * b21;
  const inv = [b01, -a22 * a01 + a02 * a21, a12 * a01 - a02 * a11,
    b11, a22 * a00 - a02 * a20, -a12 * a00 + a02 * a10,
    b21, -a21 * a00 + a01 * a20, a11 * a00 - a01 * a10].map(v => v / det);
  // transpose
  return [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]];
}

// every mesh primitive, baked to world space
const meshes = [];
(function walk(i, parent) {
  const n = g.nodes[i];
  const W = mul(parent, nodeMatrix(n));
  if (n.mesh !== undefined) {
    const N3 = normalMatrix(W);
    for (const pr of g.meshes[n.mesh].primitives) {
      const p = accessor(pr.attributes.POSITION), nr = accessor(pr.attributes.NORMAL);
      const cnt = p.length / 3, P = new Float64Array(p.length), N = new Float64Array(p.length);
      for (let k = 0; k < cnt; k++) {
        const x = p[k * 3], y = p[k * 3 + 1], z = p[k * 3 + 2];
        P[k * 3] = W[0] * x + W[4] * y + W[8] * z + W[12];
        P[k * 3 + 1] = W[1] * x + W[5] * y + W[9] * z + W[13];
        P[k * 3 + 2] = W[2] * x + W[6] * y + W[10] * z + W[14];
        const a = nr[k * 3], b = nr[k * 3 + 1], c = nr[k * 3 + 2];
        let u = N3[0] * a + N3[3] * b + N3[6] * c, v = N3[1] * a + N3[4] * b + N3[7] * c, w = N3[2] * a + N3[5] * b + N3[8] * c;
        const l = Math.hypot(u, v, w) || 1;
        N[k * 3] = u / l; N[k * 3 + 1] = v / l; N[k * 3 + 2] = w / l;
      }
      meshes.push({ node: n.name, material: pr.material, P, N, idx: accessor(pr.indices) });
    }
  }
  for (const c of n.children || []) walk(c, W);
})(g.scenes[g.scene || 0].nodes[0], I4());

const byNode = (name) => meshes.filter(m => m.node === name);
const bounds = (P) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < P.length; k += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], P[k + c]); hi[c] = Math.max(hi[c], P[k + c]); }
  return { lo, hi };
};

// ---------- recentre on the cylinder axis ----------
const cylSrc = byNode('Revolver.001_Material.005_0')[0];
if (!cylSrc) throw new Error('cylinder (Revolver.001) not found');
const cb = bounds(cylSrc.P);
const O = [(cb.lo[0] + cb.hi[0]) / 2, (cb.lo[1] + cb.hi[1]) / 2, (cb.lo[2] + cb.hi[2]) / 2];
const shift = (m) => { for (let k = 0; k < m.P.length; k += 3) for (let c = 0; c < 3; c++) m.P[k + c] -= O[c]; return m; };
meshes.forEach(shift);

// ---------- chambers: the six holes in the cylinder's faces ----------
// The source cylinder is a hollow shell — no bore walls run its length; each
// chamber is a hole in the front and rear faces. Each hole's edge is a dense
// ring of vertices, so it is found by iterated circle fits on the front face
// (the cleaner of the two), then the six are regularised to a true 60° wheel.
const cyl = bounds(cylSrc.P);
const rearX = cyl.hi[0], frontX = cyl.lo[0];
const facePts = [];
for (let k = 0; k < cylSrc.P.length; k += 3) if (cylSrc.P[k] < frontX + 0.03) facePts.push([cylSrc.P[k + 1], cylSrc.P[k + 2]]);
function circleFit(pts) {
  // algebraic (Kåsa) fit: solve for 2cy, 2cz, r² − |c|²
  let a11 = 0, a12 = 0, a13 = 0, a22 = 0, a23 = 0, a33 = 0, b1 = 0, b2 = 0, b3 = 0;
  for (const [y, z] of pts) {
    const q = y * y + z * z;
    a11 += 4 * y * y; a12 += 4 * y * z; a13 += 2 * y; a22 += 4 * z * z; a23 += 2 * z; a33 += 1;
    b1 += 2 * y * q; b2 += 2 * z * q; b3 += q;
  }
  const M = [[a11, a12, a13, b1], [a12, a22, a23, b2], [a13, a23, a33, b3]];
  for (let i = 0; i < 3; i++) {
    let p = i; for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    [M[i], M[p]] = [M[p], M[i]];
    for (let r = 0; r < 3; r++) if (r !== i) { const f = M[r][i] / M[i][i]; for (let c = i; c < 4; c++) M[r][c] -= f * M[i][c]; }
  }
  const cy = M[0][3] / M[0][0], cz = M[1][3] / M[1][1], w = M[2][3] / M[2][2];
  return { cy, cz, r: Math.sqrt(Math.max(0, w + cy * cy + cz * cz)) };
}
// coarse: the face's vertices bunch in the solid webs BETWEEN the holes (a
// hole is empty), so the webs' angular phase + 30° is the holes' phase
let bestPhase = 0, bestScore = -1;
for (let ph = 0; ph < 60; ph += 0.25) {
  let s = 0;
  for (const [y, z] of facePts) {
    const r = Math.hypot(y, z); if (r < 0.33 || r > 0.62) continue;
    const a = Math.atan2(z, y) * 180 / Math.PI;
    s += Math.max(0, 12 - Math.abs(((a - ph) % 60 + 90) % 60 - 30));
  }
  if (s > bestScore) { bestScore = s; bestPhase = ph; }
}
const fitted = [];
for (let i = 0; i < 6; i++) {
  const a0 = (bestPhase + 30 + i * 60) * Math.PI / 180;
  let c = { cy: 0.48 * Math.cos(a0), cz: 0.48 * Math.sin(a0), r: 0.14 };
  for (let it = 0; it < 10; it++) {
    const ring = facePts.filter(([y, z]) => Math.abs(Math.hypot(y - c.cy, z - c.cz) - c.r) < 0.025);
    if (ring.length < 8) break;
    c = circleFit(ring);
  }
  fitted.push(c);
}
// regularise: one radius, one hole size, exact 60° spacing (best phase)
const meanR = fitted.reduce((s, c) => s + Math.hypot(c.cy, c.cz), 0) / 6;
const holeR = fitted.reduce((s, c) => s + c.r, 0) / 6;
const phase = Math.atan2(fitted.reduce((s, c, i) => s + Math.sin(Math.atan2(c.cz, c.cy) - i * Math.PI / 3), 0),
  fitted.reduce((s, c, i) => s + Math.cos(Math.atan2(c.cz, c.cy) - i * Math.PI / 3), 0)) * 180 / Math.PI;
const chambers = [];
for (let i = 0; i < 6; i++) {
  let a = phase + i * 60; if (a > 180) a -= 360;
  chambers.push({ angle: +a.toFixed(2), radius: +meanR.toFixed(4) });
}

// ---------- the bullet, re-lathed ----------
const bulletParts = meshes.filter(m => /^BulletRevolver/.test(m.node));
let bAll = [];
for (const m of bulletParts) for (let k = 0; k < m.P.length; k += 3) bAll.push([m.P[k], m.P[k + 1], m.P[k + 2], m.material]);
const bb = bounds(Float64Array.from(bAll.flatMap(v => v.slice(0, 3))));
// axis: along x through the yz centre of the case
const by0 = (bb.lo[1] + bb.hi[1]) / 2, bz0 = (bb.lo[2] + bb.hi[2]) / 2;
const bx0 = bb.hi[0]; // base (primer) end
let blen = bb.hi[0] - bb.lo[0];
const tipMat = 3, primerMat = 4;
let tipStart = Infinity; // x (from the base) where the head begins
const BINS = 64, prof = new Array(BINS + 1).fill(0);
let primerR = 0;
for (const [x, y, z, mat] of bAll) {
  const t = (bx0 - x) / blen; // 0 at base → 1 at tip (blen still the source length here)
  const r = Math.hypot(y - by0, z - bz0);
  const bi = Math.min(BINS, Math.max(0, Math.round(t * BINS)));
  prof[bi] = Math.max(prof[bi], r);
  if (mat === tipMat) tipStart = Math.min(tipStart, t);
  if (mat === primerMat) primerR = Math.max(primerR, r);
}
// fill gaps, then a light smoothing pass (keeps the rim step)
for (let i = 1; i <= BINS; i++) if (!prof[i]) prof[i] = prof[i - 1];
prof[BINS] = 0; // pointed-round tip closes
const ringT = [], ringR = [];
for (let i = 0; i <= BINS; i++) { ringT.push(i / BINS); ringR.push(prof[i]); }
const SEG = 28;
function lathe(i0, i1, mat, name) {
  const P = [], N = [], idx = [];
  for (let i = i0; i <= i1; i++) {
    const x = -ringT[i] * blen, r = ringR[i];
    // profile normal from neighbours (dr/dx)
    const ia = Math.max(0, i - 1), ib = Math.min(BINS, i + 1);
    const dx = -(ringT[ib] - ringT[ia]) * blen, dr = ringR[ib] - ringR[ia];
    let nx = dr, nr = -dx; const l = Math.hypot(nx, nr) || 1; nx /= l; nr /= l;
    if (nr < 0) { nx = -nx; nr = -nr; }
    for (let s = 0; s <= SEG; s++) {
      const a = s / SEG * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      P.push(x, r * ca, r * sa); N.push(nx, nr * ca, nr * sa);
    }
  }
  const rows = i1 - i0;
  for (let i = 0; i < rows; i++) for (let s = 0; s < SEG; s++) {
    const a = i * (SEG + 1) + s, b = a + SEG + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  return { name, material: mat, P: Float64Array.from(P), N: Float64Array.from(N), idx: Float64Array.from(idx) };
}
// The source cartridge was modelled loose, at its own size — wider than the
// cylinder's holes. Scale it so the case body (its radius just above the
// rim) is 96% of the hole: the rim, wider, then rests on the rear face like a
// seated round.
const caseBodyR = Math.max(...ringR.slice(Math.round(BINS * 0.15), Math.round(BINS * 0.6)));
const fitK = holeR * 0.96 / caseBodyR;
for (let i = 0; i <= BINS; i++) ringR[i] *= fitK;
primerR *= fitK;
const blenRaw = blen;
blen = blenRaw * fitK;
const tipBin = Math.round(tipStart * BINS);
const caseMesh = lathe(0, tipBin, 2, 'bullet_case');
const tipMesh = lathe(tipBin, BINS, 3, 'bullet_tip');
// the base disc (case head) with the primer as an inner disc
function disc(r0, r1, x, mat, name) {
  const P = [], N = [], idx = [];
  for (let s = 0; s <= SEG; s++) {
    const a = s / SEG * Math.PI * 2;
    P.push(x, r0 * Math.cos(a), r0 * Math.sin(a), x, r1 * Math.cos(a), r1 * Math.sin(a));
    N.push(1, 0, 0, 1, 0, 0);
  }
  for (let s = 0; s < SEG; s++) { const a = s * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  return { name, material: mat, P: Float64Array.from(P), N: Float64Array.from(N), idx: Float64Array.from(idx) };
}
const headMesh = disc(primerR, ringR[0], 0.0005, 2, 'bullet_head');
const primerMesh = disc(0, primerR, 0.003, 4, 'bullet_primer');

// ---------- assemble parts ----------
const join = (list, name, material) => {
  const P = [], N = [], idx = []; let base = 0;
  for (const m of list) { P.push(...m.P); N.push(...m.N); for (const i of m.idx) idx.push(i + base); base += m.P.length / 3; }
  return { name, material, P, N, idx };
};
const one = (node, name) => { const m = byNode(node)[0]; if (!m) throw new Error('missing ' + node); return { name, material: m.material, P: m.P, N: m.N, idx: m.idx }; };
const parts = [
  one('Revolver_Material.005_0', 'frame'),
  one('Revolver_Material.010_0', 'grip'),
  one('Revolver.001_Material.005_0', 'cylinder'),
  one('Revolver.002_Material.005_0', 'trigger'),
  one('Revolver.003_Material.005_0', 'hammer'),
  caseMesh, tipMesh, headMesh, primerMesh
];

// pivots (model space) for the moving parts
const pb = (name) => bounds(Float64Array.from(parts.find(p => p.name === name).P));
const hb = pb('hammer'), tb = pb('trigger');
const pivots = {
  // the hammer turns on a pin low at its front (spur at the top-back)
  hammer: [+(hb.lo[0] + 0.12).toFixed(4), +(hb.lo[1] + 0.12).toFixed(4), 0],
  // the trigger hangs from a pin at its top
  trigger: [+((tb.lo[0] + tb.hi[0]) / 2).toFixed(4), +(tb.hi[1] - 0.06).toFixed(4), 0],
  // the crane: the cylinder swings out to the shooter's left (+Z) on an
  // axis parallel to the bore, just under the cylinder
  crane: [0, +(cyl.lo[1] + 0.05).toFixed(4), 0]
};

// ---------- the barrel: muzzle face → bore centre and radius ----------
const frameP = parts.find(p => p.name === 'frame').P;
let fminX = Infinity;
for (let k = 0; k < frameP.length; k += 3) fminX = Math.min(fminX, frameP[k]);
const face = [];
for (let k = 0; k < frameP.length; k += 3) if (frameP[k] < fminX + 0.03) face.push([frameP[k + 1], frameP[k + 2]]);
// the bore sits on the line of the top chamber (angle 0 → +Y), at the
// chamber radius; refine its centre from the ring of muzzle vertices near it
const guess = [chambers.reduce((s, c) => s + c.radius, 0) / chambers.length, 0];
const ring = face.filter(([y, z]) => Math.hypot(y - guess[0], z - guess[1]) < 0.45);
const by = ring.reduce((s, v) => s + v[0], 0) / (ring.length || 1), bz = ring.reduce((s, v) => s + v[1], 0) / (ring.length || 1);
const boreR = Math.min(...ring.map(([y, z]) => Math.hypot(y - by, z - bz)).filter(d => d > 0.05));
const barrel = { y: +by.toFixed(4), z: +bz.toFixed(4), bore: +boreR.toFixed(4), muzzleX: +fminX.toFixed(4) };
// The source barrel is a hollow shell: its bore wall is only ~0.33 deep, and
// past it you see the inside of the shell — a bright disc where a dark hole
// should be. A dull black plug just inside the wall makes it a bore.
{
  const P = [], N = [], idx = [], x = fminX + 0.3, r = boreR * 1.08;
  P.push(x, by, bz); N.push(-1, 0, 0);
  for (let s2 = 0; s2 <= SEG; s2++) { const a = s2 / SEG * Math.PI * 2; P.push(x, by + r * Math.cos(a), bz + r * Math.sin(a)); N.push(-1, 0, 0); }
  for (let s2 = 1; s2 <= SEG; s2++) idx.push(0, s2, s2 + 1);
  parts.push({ name: 'bore', material: 1, P: Float64Array.from(P), N: Float64Array.from(N), idx: Float64Array.from(idx) });
}

// ---------- write ----------
const chunks = []; let off = 0;
const meta = [];
for (const p of parts) {
  const vc = p.P.length / 3;
  if (vc > 65535) throw new Error(p.name + ' has too many vertices for Uint16 indices');
  const vb = Buffer.alloc(vc * 10);
  for (let k = 0; k < vc; k++) {
    for (let c = 0; c < 3; c++) vb.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(p.P[k * 3 + c] * POS_Q))), k * 10 + c * 2);
    for (let c = 0; c < 3; c++) vb.writeInt8(Math.max(-127, Math.min(127, Math.round(p.N[k * 3 + c] * 127))), k * 10 + 6 + c);
  }
  const ib = Buffer.alloc(p.idx.length * 2);
  for (let k = 0; k < p.idx.length; k++) ib.writeUInt16LE(p.idx[k], k * 2);
  // keep each block 4-byte aligned
  const pad = (b) => b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - b.length % 4)]) : b;
  const v = pad(vb), i = pad(ib);
  meta.push({ name: p.name, material: p.material, vertexOffset: off, vertexCount: vc, indexOffset: off + v.length, indexCount: p.idx.length });
  chunks.push(v, i); off += v.length + i.length;
}
const mats = g.materials.map(m => {
  const pbr = m.pbrMetallicRoughness || {};
  return { name: m.name, color: (pbr.baseColorFactor || [1, 1, 1, 1]).slice(0, 3).map(v => +v.toFixed(4)),
    metallic: +(pbr.metallicFactor === undefined ? 1 : pbr.metallicFactor).toFixed(3), roughness: +(pbr.roughnessFactor === undefined ? 1 : pbr.roughnessFactor).toFixed(3) };
});
const json = {
  source: 'Revolver with a bullet — 3DRaizar (Sketchfab), used with permission',
  posQuant: POS_Q, vertexStride: 10,
  axes: 'cylinder axis = +X through the origin; barrel toward −X; up +Y; shooter’s left +Z',
  materials: mats, parts: meta,
  cylinder: { rearX: +rearX.toFixed(4), frontX: +frontX.toFixed(4), radius: +((cyl.hi[1] - cyl.lo[1]) / 2).toFixed(4) },
  chambers, pivots, barrel,
  bullet: { length: +blen.toFixed(4), radius: +ringR[0].toFixed(4), caseRadius: +(caseBodyR * fitK).toFixed(4), scale: +fitK.toFixed(4) },
  chamberHole: +holeR.toFixed(4),
  bounds: (() => { const all = []; for (const p of parts.slice(0, 5)) all.push(...p.P); const b = bounds(Float64Array.from(all)); return { min: b.lo.map(v => +v.toFixed(3)), max: b.hi.map(v => +v.toFixed(3)) }; })()
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'revolver.bin'), Buffer.concat(chunks));
fs.writeFileSync(path.join(OUT, 'revolver.json'), JSON.stringify(json, null, 1));
console.log('parts', meta.map(m => `${m.name}:${m.vertexCount}v/${m.indexCount / 3}t`).join(' '));
console.log('chambers', JSON.stringify(chambers), 'pivots', JSON.stringify(pivots));
console.log('barrel', JSON.stringify(barrel), 'hole', holeR.toFixed(4), 'bullet scale', fitK.toFixed(3));
console.log('bin', off, 'bytes');
