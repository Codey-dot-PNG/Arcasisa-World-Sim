'use strict';
/* Border painter — the GM's territory brush (map editor mode "Borders").

   Every region (a Republic province or a foreign country) is rasterised
   into a soft ownership field on a 4-unit grid (canvas anti-aliasing gives
   true coverage, so the 50% line IS the drawn border). The brush never
   paints colour: each stamp raises the chosen region's share of the land
   under it and lowers everyone else's by the same proportion, so the 50%
   line — the border — is PUSHED across the land as you drag. A seeded
   value-noise field modulates how fast each patch of ground gives way, which
   is what makes a pushed border wander like a real one instead of tracing
   the brush's circle.

   Touched regions are re-traced (marching squares → closed loops →
   Douglas-Peucker) from min(region field, LAND field), where LAND is the
   pristine coastline (GET /api/gm/map/land), so coasts stay put however
   often a region is repainted. Untouched regions keep their exact original
   paths. Saving sends only the touched regions' new `shape` strings (plus
   regions dissolved by "give to country" / "annex") to PUT /api/gm/territory
   — every consumer of `shape` (map, war engine, province lookup) just works.

   Nothing here mutates state locally except the preview overrides
   (Borders.shapeFor), which GameMap.render consults so a sync arriving
   mid-session can't wipe unsaved work.

   PEACE MODE (startPeace — war-peace.js): the same brush for the two sides
   of a war or protest drawing the border clause of a peace offer, open to
   any negotiator (not the GM's editor). Only the two sides' own regions are
   loaded and the brush only moves land the two sides hold between them —
   a third country's ground never changes hands. A protest may carve out a
   NEW state (the virtual region 'c:__new', drawn from nothing). "Attach to
   the offer" hands the traced shapes back; nothing is saved here — the
   border applies only if the other side accepts the deal (server/peace.js). */

const Borders = {
  CELL: 4, GW: 960, GH: 540,
  ready: false, loading: null,
  land: null,              // Uint16Array — pristine land coverage
  regions: [],             // { key, kind, id, field: Uint16Array, bbox:[x0,y0,x1,y1]|null }
  byKey: {},
  target: null,            // region key the brush paints with
  radius: 70, strength: 0.35, organic: 0.6,
  tool: 'brush',           // 'brush' | 'pan'
  spaceHeld: false,
  overrides: {},           // key → traced shape ('' = dissolved) while unsaved
  touched: new Set(),
  removed: new Set(),
  created: [],             // region keys founded this session (dropped on discard if never drawn)
  undoStack: [],
  stroke: null,
  _change: null, _changed: new Set(), _raf: 0,
  panelOpen: true,
  peace: null,             // peace-mode session (startPeace) — null for the GM's editor

  // the painter is live: the GM's map editor in Borders mode, or a peace draw
  isOn() { return !!this.peace || !!(window.MapEdit && MapEdit.active && MapEdit.mode === 'borders'); },
  key(kind, id) { return (kind === 'province' ? 'p:' : 'c:') + id; },
  regionInfo(key) {
    if (this.peace && this.peace.virtual && key === this.peace.virtual.key) {
      const v = this.peace.virtual;
      return { kind: 'new', id: 'new', name: v.name, color: v.color, shape: '', obj: null };
    }
    const id = key.slice(2);
    if (key[0] === 'p') { const p = provById(id); return p ? { kind: 'province', id, name: p.name, color: p.color || '#8a8a6a', shape: p.shape, obj: p } : null; }
    const c = ((S().settings.map || {}).countries || []).find(x => x.id === id);
    return c ? { kind: 'country', id, name: c.name, color: c.fill || '#a8a196', shape: c.shape, obj: c } : null;
  },
  allKeys() {
    if (this.peace) return this.peace.keys.slice();
    return [...S().provinces.map(p => 'p:' + p.id), ...((S().settings.map || {}).countries || []).map(c => 'c:' + c.id)];
  },
  dirty() { return this.touched.size > 0 || this.removed.size > 0; },
  // GameMap.render asks this for every region path while the tool is open
  shapeFor(kind, id) {
    const k = this.key(kind, id);
    return Object.prototype.hasOwnProperty.call(this.overrides, k) ? this.overrides[k] : undefined;
  },

  /* ---------- rasterising ---------- */
  raster(paths) {
    const { GW, GH, CELL } = this;
    const cv = this._cv || (this._cv = document.createElement('canvas'));
    cv.width = GW; cv.height = GH;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, GW, GH);
    ctx.setTransform(1 / CELL, 0, 0, 1 / CELL, 0, 0);
    ctx.fillStyle = '#000';
    for (const d of paths) { if (!d) continue; try { ctx.fill(new Path2D(d), 'evenodd'); } catch (e) { /* malformed path — skip */ } }
    const px = ctx.getImageData(0, 0, GW, GH).data;
    const f = new Uint16Array(GW * GH);
    let x0 = GW, y0 = GH, x1 = -1, y1 = -1;
    for (let i = 0, n = GW * GH; i < n; i++) {
      const a = px[i * 4 + 3];
      if (!a) continue;
      f[i] = a * 257;
      const x = i % GW, y = (i / GW) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { field: f, bbox: x1 < 0 ? null : [x0, y0, x1, y1] };
  },
  addRegion(key) {
    if (this.byKey[key]) return this.byKey[key];
    const info = this.regionInfo(key);
    if (!info) return null;
    const r = this.raster([info.shape]);
    const R = { key, kind: info.kind, id: info.id, field: r.field, bbox: r.bbox };
    this.regions.push(R); this.byKey[key] = R;
    return R;
  },
  async open() {
    if (this.ready) { this.syncRegions(); return; }
    if (this.loading) return this.loading;
    this.loading = (async () => {
      toast('Preparing the territory map…');
      const { land } = await GET(this.peace ? '/api/war/peace/land' : '/api/gm/map/land');
      this.land = this.raster(land || []).field;
      this.regions = []; this.byKey = {};
      for (const k of this.allKeys()) this.addRegion(k);
      if (!this.target || !this.byKey[this.target]) this.target = this.regions[0] ? this.regions[0].key : null;
      this.ready = true;
      this.loading = null;
      this.renderPanel();
    })().catch(e => { this.loading = null; toast('Border painter unavailable: ' + e.message, true); });
    return this.loading;
  },
  // regions founded or deleted elsewhere since the fields were built
  syncRegions() {
    const keys = new Set(this.allKeys());
    for (const k of keys) if (!this.byKey[k]) this.addRegion(k);
    this.regions = this.regions.filter(R => keys.has(R.key));
    for (const k of Object.keys(this.byKey)) if (!keys.has(k)) delete this.byKey[k];
  },
  reset() {
    this.ready = false; this.land = null; this.regions = []; this.byKey = {};
    this.overrides = {}; this.touched = new Set(); this.removed = new Set(); this.created = [];
    this.undoStack = []; this.stroke = null; this._changed = new Set();
  },

  /* ---------- organic noise (seeded value noise, two octaves) ---------- */
  hash(x, y) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  },
  vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = this.hash(xi, yi), b = this.hash(xi + 1, yi), c = this.hash(xi, yi + 1), d = this.hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  },
  noise(wx, wy) { return 0.68 * this.vnoise(wx / 42, wy / 42) + 0.32 * this.vnoise(wx / 13 + 91, wy / 13 + 37); },

  /* ---------- change tracking (undo) ---------- */
  beginChange() { this._change = { fields: new Map(), removed: new Set(this.removed), touched: new Set(this.touched) }; },
  snap(R) {
    if (this._change && !this._change.fields.has(R.key)) this._change.fields.set(R.key, { field: R.field.slice(), bbox: R.bbox && R.bbox.slice() });
  },
  endChange() {
    if (this._change && (this._change.fields.size || this._change.removed.size !== this.removed.size)) {
      this.undoStack.push(this._change);
      if (this.undoStack.length > 12) this.undoStack.shift();
    }
    this._change = null;
  },
  undo() {
    const ch = this.undoStack.pop();
    if (!ch) return toast('Nothing to undo.');
    for (const [k, s] of ch.fields) {
      const R = this.byKey[k];
      if (!R) continue;
      R.field = s.field; R.bbox = s.bbox;
      this._changed.add(k);
    }
    this.removed = ch.removed; this.touched = ch.touched;
    for (const k of Object.keys(this.overrides)) if (!this.touched.has(k) && !this.removed.has(k)) delete this.overrides[k];
    this.schedulePreview(true);
  },
  growBox(R, x0, y0, x1, y1) {
    if (!R.bbox) R.bbox = [x0, y0, x1, y1];
    else { if (x0 < R.bbox[0]) R.bbox[0] = x0; if (y0 < R.bbox[1]) R.bbox[1] = y0; if (x1 > R.bbox[2]) R.bbox[2] = x1; if (y1 > R.bbox[3]) R.bbox[3] = y1; }
  },

  /* ---------- the brush ---------- */
  stamp(wx, wy) {
    const T = this.byKey[this.target];
    if (!T || this.removed.has(T.key)) return;
    const { GW, GH, CELL } = this;
    const r = this.radius, r2 = r * r;
    const x0 = Math.max(0, Math.floor((wx - r) / CELL)), x1 = Math.min(GW - 1, Math.ceil((wx + r) / CELL));
    const y0 = Math.max(0, Math.floor((wy - r) / CELL)), y1 = Math.min(GH - 1, Math.ceil((wy + r) / CELL));
    if (x1 < x0 || y1 < y0) return;
    const others = this.regions.filter(R => R !== T && R.bbox && !(R.bbox[2] < x0 || R.bbox[0] > x1 || R.bbox[3] < y0 || R.bbox[1] > y1));
    this.snap(T); for (const R of others) this.snap(R);
    const org = this.organic, land = this.land, tf = T.field;
    let hit = false;
    const hitOthers = new Set();
    for (let y = y0; y <= y1; y++) {
      const py = (y + 0.5) * CELL - wy;
      for (let x = x0; x <= x1; x++) {
        const pxx = (x + 0.5) * CELL - wx;
        const d2 = pxx * pxx + py * py;
        if (d2 >= r2) continue;
        const i = y * GW + x;
        if (!land[i]) continue; // open sea is nobody's — the coastline is fixed
        // peace: only ground the two sides hold between them changes hands
        if (this.peace) { let held = 0; for (const R of this.regions) held += R.field[i]; if (held < 32768) continue; }
        const q = 1 - d2 / r2;
        let a = this.strength * q * q;
        if (org) a *= (1 - org) + org * 1.7 * this.noise((x + 0.5) * CELL, (y + 0.5) * CELL);
        if (a <= 0) continue;
        if (a > 1) a = 1;
        const cur = tf[i];
        if (cur < 65535) { tf[i] = Math.min(65535, Math.round(cur + a * (65535 - cur))); hit = true; }
        for (const R of others) {
          const v = R.field[i];
          if (v) { R.field[i] = Math.round(v * (1 - a)); hitOthers.add(R); }
        }
      }
    }
    if (hit) { this.growBox(T, x0, y0, x1, y1); this.touched.add(T.key); this._changed.add(T.key); }
    for (const R of hitOthers) { this.touched.add(R.key); this._changed.add(R.key); }
    this.schedulePreview();
  },

  /* ---------- tracing (marching squares → loops → simplified path) ---------- */
  trace(R) {
    if (!R.bbox) return { d: '', label: null };
    const { GW, GH, CELL } = this;
    const X0 = R.bbox[0] - 1, Y0 = R.bbox[1] - 1, X1 = R.bbox[2] + 1, Y1 = R.bbox[3] + 1;
    const W = X1 - X0 + 1, H = Y1 - Y0 + 1;
    const v = new Float32Array(W * H);
    const f = R.field, land = this.land;
    for (let y = 0; y < H; y++) {
      const gy = y + Y0;
      if (gy < 0 || gy >= GH) continue;
      for (let x = 0; x < W; x++) {
        const gx = x + X0;
        if (gx < 0 || gx >= GW) continue;
        const i = gy * GW + gx, a = f[i], b = land[i];
        v[y * W + x] = (a < b ? a : b) / 65535;
      }
    }
    const T = 0.5;
    const segA = [], segB = [];
    const seg = (e1, e2) => { segA.push(e1); segB.push(e2); };
    for (let y = 0; y < H - 1; y++) {
      for (let x = 0; x < W - 1; x++) {
        const o = y * W + x;
        const tl = v[o], tr = v[o + 1], br = v[o + W + 1], bl = v[o + W];
        const code = (tl > T ? 1 : 0) | (tr > T ? 2 : 0) | (br > T ? 4 : 0) | (bl > T ? 8 : 0);
        if (code === 0 || code === 15) continue;
        const top = o * 2, left = o * 2 + 1, right = (o + 1) * 2 + 1, bottom = (o + W) * 2;
        switch (code) {
          case 1: case 14: seg(left, top); break;
          case 2: case 13: seg(top, right); break;
          case 3: case 12: seg(left, right); break;
          case 4: case 11: seg(right, bottom); break;
          case 6: case 9: seg(top, bottom); break;
          case 7: case 8: seg(left, bottom); break;
          case 5: if ((tl + tr + br + bl) / 4 > T) { seg(top, right); seg(bottom, left); } else { seg(left, top); seg(right, bottom); } break;
          case 10: if ((tl + tr + br + bl) / 4 > T) { seg(left, top); seg(right, bottom); } else { seg(top, right); seg(bottom, left); } break;
        }
      }
    }
    if (!segA.length) return { d: '', label: null };
    const ptOf = (e) => {
      const base = e >> 1, x = base % W, y = (base / W) | 0;
      if ((e & 1) === 0) { // horizontal edge (x,y)-(x+1,y)
        const a = v[base], b = v[base + 1], t = (T - a) / ((b - a) || 1e-9);
        return [(X0 + x + t + 0.5) * CELL, (Y0 + y + 0.5) * CELL];
      }
      const a = v[base], b = v[base + W], t = (T - a) / ((b - a) || 1e-9);
      return [(X0 + x + 0.5) * CELL, (Y0 + y + t + 0.5) * CELL];
    };
    const adj = new Map();
    const link = (e, s) => { const l = adj.get(e); if (l) l.push(s); else adj.set(e, [s]); };
    for (let s = 0; s < segA.length; s++) { link(segA[s], s); link(segB[s], s); }
    const used = new Uint8Array(segA.length);
    const loops = [];
    for (let s0 = 0; s0 < segA.length; s0++) {
      if (used[s0]) continue;
      used[s0] = 1;
      const start = segA[s0];
      const loop = [ptOf(start)];
      let cur = s0, e = segB[s0];
      for (let guard = 0; guard < 2e6 && e !== start; guard++) {
        loop.push(ptOf(e));
        const l = adj.get(e) || [];
        const nx = l[0] === cur ? l[1] : l[0];
        if (nx === undefined || used[nx]) break;
        used[nx] = 1;
        e = segA[nx] === e ? segB[nx] : segA[nx];
        cur = nx;
      }
      if (loop.length >= 3) loops.push(loop);
    }
    const area = (p) => { let s = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]); return s / 2; };
    let d = '', best = null, bestA = 0;
    for (const raw of loops) {
      const a = Math.abs(area(raw));
      if (a < 30) continue; // specks
      const p = this.simplify(raw, 0.6);
      if (p.length < 3) continue;
      if (a > bestA) { bestA = a; best = p; }
      let px = Math.round(p[0][0] * 10), py = Math.round(p[0][1] * 10);
      d += (d ? ' ' : '') + 'M' + (px / 10) + ' ' + (py / 10) + 'l';
      const parts = [];
      for (let i = 1; i < p.length; i++) {
        const nx = Math.round(p[i][0] * 10), ny = Math.round(p[i][1] * 10);
        if (nx === px && ny === py) continue;
        parts.push(((nx - px) / 10) + ' ' + ((ny - py) / 10));
        px = nx; py = ny;
      }
      d += parts.join(' ').replace(/ -/g, '-') + 'z';
    }
    return { d, label: best ? this.centroid(best) : null };
  },
  // Douglas-Peucker on a closed ring (split at the point farthest from p0)
  simplify(pts, eps) {
    const n = pts.length;
    if (n < 6) return pts;
    let far = 0, fd = -1;
    for (let i = 1; i < n; i++) { const dx = pts[i][0] - pts[0][0], dy = pts[i][1] - pts[0][1], dd = dx * dx + dy * dy; if (dd > fd) { fd = dd; far = i; } }
    const run = (idx) => {
      const keep = new Uint8Array(idx.length); keep[0] = 1; keep[idx.length - 1] = 1;
      const stack = [[0, idx.length - 1]];
      while (stack.length) {
        const [a, b] = stack.pop();
        const A = pts[idx[a]], B = pts[idx[b]];
        const dx = B[0] - A[0], dy = B[1] - A[1], len = Math.hypot(dx, dy) || 1e-9;
        let md = -1, mi = -1;
        for (let i = a + 1; i < b; i++) {
          const P = pts[idx[i]];
          const dist = Math.abs(dy * P[0] - dx * P[1] + B[0] * A[1] - B[1] * A[0]) / len;
          if (dist > md) { md = dist; mi = i; }
        }
        if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
      }
      return idx.filter((_, i) => keep[i]);
    };
    const first = run([...Array(far + 1).keys()]);
    const second = run([...Array(n - far).keys()].map(i => far + i).concat([0]));
    return first.concat(second.slice(1, -1)).map(i => pts[i]);
  },
  centroid(p) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const c = p[j][0] * p[i][1] - p[i][0] * p[j][1];
      a += c; cx += (p[j][0] + p[i][0]) * c; cy += (p[j][1] + p[i][1]) * c;
    }
    if (!a) return [Math.round(p[0][0]), Math.round(p[0][1])];
    return [Math.round(cx / (3 * a)), Math.round(cy / (3 * a))];
  },

  /* ---------- live preview ---------- */
  schedulePreview(full) {
    if (full) this._needFull = true;
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.preview(); });
  },
  preview() {
    let needRender = !!this._needFull;
    this._needFull = false;
    for (const k of this._changed) {
      const R = this.byKey[k];
      if (!R) continue;
      const t = this.removed.has(k) ? { d: '' } : this.trace(R);
      this.overrides[k] = t.d;
      R.label = t.label || null;
      const nodes = GameMap.regionNodes && GameMap.regionNodes[k];
      if (nodes && nodes.length) for (const n of nodes) n.setAttribute('d', t.d || 'M0 0');
      else if (t.d) needRender = true; // first appearance of a new region
    }
    this._changed.clear();
    if (needRender && !this.stroke) GameMap.render();
    else if (needRender) this._renderAfterStroke = true;
    this.renderPanel();
  },

  /* ---------- pointer input (hooked from GameMap's svg pointerdown) ---------- */
  pointerDown(e) {
    if (this.stroke) return true; // a second finger mid-stroke is swallowed (use ✋ Pan to pinch)
    if (!this.ready || e.button !== 0 || this.tool === 'pan' || this.spaceHeld || !this.target) return false;
    if (e.pointerType === 'touch' && GameMap.pointers && GameMap.pointers.size) return false;
    e.preventDefault();
    const st = this.stroke = { id: e.pointerId, last: GameMap.clientToWorld(e.clientX, e.clientY) };
    MapEdit.dragging = true; // hold off sync re-renders mid-stroke
    this.beginChange();
    this.stamp(st.last[0], st.last[1]);
    const move = (ev) => {
      if (ev.pointerId !== st.id) return;
      const p = GameMap.clientToWorld(ev.clientX, ev.clientY);
      this.moveCursor(p);
      const dx = p[0] - st.last[0], dy = p[1] - st.last[1], dist = Math.hypot(dx, dy);
      const step = Math.max(3, this.radius * 0.2);
      if (dist < step) return;
      const n = Math.floor(dist / step);
      for (let i = 1; i <= n; i++) this.stamp(st.last[0] + dx * i / n, st.last[1] + dy * i / n);
      st.last = p;
    };
    const up = (ev) => {
      if (ev.pointerId !== st.id) return;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      this.stroke = null;
      this.endChange();
      MapEdit.dragging = false;
      GameMap.lastDragMoved = true; // the svg's click handler must not treat the stroke as a click
      if (this._renderAfterStroke || GameMap._renderQueued) { this._renderAfterStroke = false; GameMap.render(); }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    return true;
  },
  // brush outline drawn into the editor overlay; follows the pointer
  overlay(gm, layer) {
    const NS = 'http://www.w3.org/2000/svg';
    this._cursor = document.createElementNS(NS, 'circle');
    this._cursor.setAttribute('class', 'brush-cursor');
    this._cursor.setAttribute('r', this.radius);
    this._cursor.setAttribute('vector-effect', 'non-scaling-stroke');
    if (this._lastPt) { this._cursor.setAttribute('cx', this._lastPt[0]); this._cursor.setAttribute('cy', this._lastPt[1]); }
    else this._cursor.setAttribute('display', 'none');
    layer.appendChild(this._cursor);
    if (this._svg !== gm.svg) {
      this._svg = gm.svg;
      gm.svg.addEventListener('pointermove', (ev) => {
        if (!this.isOn()) return;
        this.moveCursor(GameMap.clientToWorld(ev.clientX, ev.clientY));
      });
      gm.svg.addEventListener('pointerleave', () => { if (this._cursor) this._cursor.setAttribute('display', 'none'); });
    }
    if (!this._keysBound) {
      this._keysBound = true;
      const typing = () => { const a = document.activeElement; return a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
      window.addEventListener('keydown', (ev) => {
        if (!this.isOn() || typing()) return;
        if (ev.code === 'Space') { this.spaceHeld = true; document.body.classList.add('brush-panning'); ev.preventDefault(); }
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); this.undo(); }
        if (ev.key === '[') { this.radius = Math.max(15, Math.round(this.radius / 1.2)); this.moveCursor(this._lastPt); this.renderPanel(); }
        if (ev.key === ']') { this.radius = Math.min(400, Math.round(this.radius * 1.2)); this.moveCursor(this._lastPt); this.renderPanel(); }
      });
      window.addEventListener('keyup', (ev) => { if (ev.code === 'Space') { this.spaceHeld = false; document.body.classList.remove('brush-panning'); } });
    }
  },
  moveCursor(p) {
    if (!p) return;
    this._lastPt = p;
    const c = this._cursor;
    if (!c || !c.isConnected) return;
    c.removeAttribute('display');
    c.setAttribute('cx', p[0]); c.setAttribute('cy', p[1]); c.setAttribute('r', this.radius);
    const T = this.regionInfo(this.target || '');
    c.style.stroke = T ? T.color : '';
  },

  /* ---------- region operations ---------- */
  // Hand a whole province to a foreign country: its land joins the country
  // field (one region, no seam) and the province is dissolved on save.
  giveProvince(pKey, cKey) {
    const P = this.byKey[pKey], C = this.byKey[cKey];
    if (!P || !C) return;
    this.beginChange(); this.snap(P); this.snap(C);
    for (let i = 0; i < P.field.length; i++) if (P.field[i]) { C.field[i] = Math.min(65535, C.field[i] + P.field[i]); P.field[i] = 0; }
    if (P.bbox) this.growBox(C, ...P.bbox);
    this.removed.add(pKey); this.touched.add(cKey); this.touched.add(pKey);
    this._changed.add(pKey); this._changed.add(cKey);
    this.endChange();
    if (this.target === pKey) this.target = cKey;
    this.schedulePreview(true);
  },
  // Turn a foreign country into a Republic province (founded server-side).
  async annexCountry(cKey) {
    const info = this.regionInfo(cKey);
    if (!info) return;
    const d = { name: info.name, population: 1000000 };
    openModal('ANNEX ' + info.name.toUpperCase(), el('div',
      el('p', { style: 'font-size:13px; color:var(--ink-soft);' }, `${info.name}'s land becomes a new Republic province when you save the borders. Its foreign dossier (the entity) stays on file.`),
      Forms.field('Province name', Forms.text(d, 'name')),
      Forms.field('Population', Forms.num(d, 'population'))),
    [{ label: 'Annex', onClick: async () => {
      try {
        const r = await POST('/api/gm/territory/province', { name: d.name, color: info.color, population: d.population, description: `Former territory of ${info.name}.` });
        const pKey = 'p:' + r.id;
        this.created.push(pKey);
        const P = this.addRegion(pKey) || this.byKey[pKey];
        const C = this.byKey[cKey];
        this.beginChange(); this.snap(P); this.snap(C);
        P.field.set(C.field); P.bbox = C.bbox && C.bbox.slice();
        C.field.fill(0);
        this.removed.add(cKey); this.touched.add(cKey); this.touched.add(pKey);
        this._changed.add(cKey); this._changed.add(pKey);
        this.endChange();
        this.target = pKey;
        this.schedulePreview(true);
        toast(info.name + ' annexed — save the borders to make it final.');
      } catch (e) { toast(e.message, true); }
    } }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }]);
  },
  newRegion(kind) {
    const isProv = kind === 'province';
    const freeForeign = S().entities.filter(e => e.type === 'foreign' && !((S().settings.map || {}).countries || []).some(c => c.entityId === e.id));
    const d = { name: '', color: isProv ? '#7f8f6a' : '#a59e90', population: 500000, entityId: '' };
    const body = el('div',
      el('p', { style: 'font-size:13px; color:var(--ink-soft);' }, isProv
        ? 'The province is founded now with no land; paint its territory out of its neighbours, then save the borders.'
        : 'The country is founded now with no land; paint its territory, then save the borders.'),
      Forms.field('Name', Forms.text(d, 'name')),
      Forms.field(isProv ? 'Map colour' : 'Map shade', Forms.color(d, 'color')),
      isProv ? Forms.field('Population', Forms.num(d, 'population')) : null,
      !isProv && freeForeign.length ? Forms.field('Dossier', Forms.sel(d, 'entityId', [['', '— create a new foreign power —'], ...freeForeign.map(e => [e.id, e.name])])) : null);
    openModal(isProv ? 'FOUND A PROVINCE' : 'FOUND A COUNTRY', body, [{ label: 'Found', onClick: async () => {
      if (!String(d.name).trim() && !d.entityId) return toast('Give it a name.', true);
      try {
        const name = String(d.name).trim() || (entById(d.entityId) || {}).name;
        const r = isProv
          ? await POST('/api/gm/territory/province', { name, color: d.color, population: d.population })
          : await POST('/api/gm/territory/country', { name, fill: d.color, entityId: d.entityId || undefined });
        const key = (isProv ? 'p:' : 'c:') + r.id;
        this.created.push(key);
        this.addRegion(key);
        this.target = key;
        this.renderPanel();
        toast(name + ' founded — paint its land.');
      } catch (e) { toast(e.message, true); }
    } }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }]);
  },

  /* ---------- save / discard ---------- */
  async save() {
    if (!this.dirty()) return toast('No border changes to save.');
    const regions = [], remove = [];
    for (const k of this.touched) {
      if (this.removed.has(k)) continue;
      const R = this.byKey[k];
      if (!R) continue;
      const t = this.trace(R);
      const isNew = this.created.includes(k);
      regions.push({ kind: R.kind, id: R.id, shape: t.d, labelPos: isNew && t.label ? t.label : undefined });
    }
    for (const k of this.removed) { const R = this.byKey[k]; if (R) remove.push({ kind: R.kind, id: R.id }); }
    const empties = regions.filter(r => !r.shape).map(r => (this.regionInfo(this.key(r.kind, r.id)) || {}).name);
    const go = async () => {
      try {
        const r = await PUT('/api/gm/territory', { regions, remove });
        toast('Borders saved' + (r.moved ? ` · ${r.moved} place(s) changed province` : '') + (r.abroad ? ` · ${r.abroad} now abroad` : '') + '.');
        this.reset();
        GameMap.render();
        this.open();
      } catch (e) { toast(e.message, true); }
    };
    if (empties.length || remove.length) {
      const lines = [];
      if (remove.length) lines.push('Dissolved: ' + remove.map(r => (this.regionInfo(this.key(r.kind, r.id)) || {}).name).join(', ') + '. Cities and properties on that land stay on the map but leave their province.');
      if (empties.length) lines.push('Left with no land: ' + empties.join(', ') + '.');
      confirmModal('SAVE BORDERS', lines.join(' '), go, 'Save borders');
    } else go();
  },
  discard() {
    const run = async () => {
      // drop regions founded this session that never got land
      const drop = this.created.filter(k => { const i = this.regionInfo(k); return i && !i.shape; }).map(k => ({ kind: k[0] === 'p' ? 'province' : 'country', id: k.slice(2) }));
      if (drop.length) { try { await PUT('/api/gm/territory', { regions: [], remove: drop }); } catch (e) { /* already gone */ } }
      this.reset();
      GameMap.render();
      this.open();
    };
    if (this.dirty() || this.created.length) confirmModal('DISCARD BORDER CHANGES', 'Throw away every unsaved border change' + (this.created.length ? ' and the regions founded this session' : '') + '?', run, 'Discard');
  },

  setTool(t) {
    this.tool = t;
    if (GameMap.svg) GameMap.svg.classList.toggle('brush-mode', t === 'brush');
    this.renderPanel();
  },

  /* ---------- the panel (floats over the map while the mode is on) ---------- */
  renderPanel() {
    const wrap = document.getElementById('map-wrap');
    if (!wrap) return;
    let panel = document.getElementById('border-panel');
    if (!this.isOn()) { if (panel) panel.remove(); return; }
    if (!panel) { panel = el('div#border-panel'); wrap.appendChild(panel); }
    clear(panel);
    if (this.peace) return this.renderPeacePanel(wrap, panel);
    // sit just below the (possibly wrapped) layer/editor toolbar
    const bar = document.getElementById('map-layerbar');
    if (bar && window.innerWidth > 640) panel.style.top = (bar.offsetTop + bar.offsetHeight + 8) + 'px';
    panel.classList.toggle('collapsed', !this.panelOpen);
    panel.appendChild(el('div.bp-head',
      el('span.bp-title', 'Territory'),
      el('span.bp-status', this.dirty() ? `${this.touched.size} region(s) unsaved` : this.ready ? 'saved' : 'loading…'),
      el('button.ow-btn', { title: this.panelOpen ? 'Collapse' : 'Expand', onclick: () => { this.panelOpen = !this.panelOpen; this.renderPanel(); } }, this.panelOpen ? '▾' : '▸')));
    if (!this.panelOpen) return;
    if (!this.ready) { panel.appendChild(el('div.ow-empty', 'Preparing the territory map…')); return; }
    const slider = (label, key, min, max, step, fmt) => {
      const out = el('span.bp-val', fmt(this[key]));
      const input = el('input', { type: 'range', min, max, step, value: this[key], oninput: (e) => { this[key] = Number(e.target.value); out.textContent = fmt(this[key]); if (key === 'radius') this.moveCursor(this._lastPt); } });
      return el('label.bp-slider', el('span', label), input, out);
    };
    panel.appendChild(el('div.chip-row.bp-tools',
      el('button.chip', { class: this.tool === 'brush' ? 'active' : '', onclick: () => this.setTool('brush') }, '🖌 Push borders'),
      el('button.chip', { class: this.tool === 'pan' ? 'active' : '', onclick: () => this.setTool('pan') }, '✋ Pan')));
    panel.appendChild(slider('Brush', 'radius', 15, 400, 5, v => Math.round(v)));
    panel.appendChild(slider('Push', 'strength', 0.05, 1, 0.05, v => Math.round(v * 100) + '%'));
    panel.appendChild(slider('Organic', 'organic', 0, 1, 0.05, v => Math.round(v * 100) + '%'));
    panel.appendChild(el('div.bp-hint', 'Pick who gains land, then drag across a border. Space = pan · [ ] = size · Ctrl+Z = undo'));

    const row = (key) => {
      const info = this.regionInfo(key);
      if (!info) return null;
      const gone = this.removed.has(key);
      const acts = el('span.bp-acts');
      if (!gone && info.kind === 'province') {
        const countries = ((S().settings.map || {}).countries || []).filter(c => !this.removed.has('c:' + c.id));
        const sel = el('select.bp-give', { title: 'Give this province to a country', onclick: (e) => e.stopPropagation(), onchange: (e) => {
          const cid = e.target.value; e.target.value = '';
          if (!cid) return;
          const cn = (countries.find(c => c.id === cid) || {}).name;
          confirmModal('GIVE ' + info.name.toUpperCase(), `Hand all of ${info.name} to ${cn}? The province is dissolved when you save; its cities and properties stay on the map under foreign sovereignty.`, () => this.giveProvince(key, 'c:' + cid), 'Give');
        } }, el('option', { value: '' }, 'give to…'), countries.map(c => el('option', { value: c.id }, c.name)));
        acts.appendChild(sel);
      }
      if (!gone && info.kind === 'country') acts.appendChild(el('button.ow-btn.ow-act', { title: 'Annex as a Republic province', onclick: (e) => { e.stopPropagation(); this.annexCountry(key); } }, 'annex'));
      return el('div.bp-row', {
        class: (this.target === key ? 'active ' : '') + (gone ? 'gone' : ''),
        onclick: () => { if (gone) return; this.target = key; this.moveCursor(this._lastPt); this.renderPanel(); }
      },
        el('span.bp-swatch', { style: 'background:' + info.color }),
        el('span.bp-name', info.name + (gone ? ' — dissolving' : '') + (this.touched.has(key) && !gone ? ' •' : '') + (!info.shape && !this.overrides[key] ? ' (no land)' : '')),
        acts);
    };
    panel.appendChild(el('div.mono-label.bp-group', 'Republic provinces'));
    panel.appendChild(el('div.bp-list', S().provinces.map(p => row('p:' + p.id))));
    panel.appendChild(el('div.mono-label.bp-group', 'Foreign countries'));
    panel.appendChild(el('div.bp-list', ((S().settings.map || {}).countries || []).map(c => row('c:' + c.id))));
    panel.appendChild(el('div.btn-row.bp-new',
      el('button.dash-btn.btn-xs', { onclick: () => this.newRegion('province') }, '+ Province'),
      el('button.dash-btn.btn-xs', { onclick: () => this.newRegion('country') }, '+ Country')));
    panel.appendChild(el('div.btn-row.bp-foot',
      el('button.dash-btn.btn-xs', { onclick: () => this.undo(), disabled: this.undoStack.length ? undefined : 'disabled' }, '↶ Undo'),
      el('button.dash-btn.btn-xs', { onclick: () => this.discard() }, 'Discard'),
      el('button.solid-btn.btn-xs', { onclick: () => this.save(), disabled: this.dirty() ? undefined : 'disabled' }, 'Save borders')));
  }
};

/* ---------- peace mode (war-peace.js) ---------- */
Object.assign(Borders, {
  // opts: { keys, sideOf:{key→'att'|'def'}, sideName(side), virtual?:{key,name,color},
  //         initial:[{kind,id,shape}], prefer:'att'|'def', onDone(regions), onCancel() }
  async startPeace(opts) {
    if (window.MapEdit && MapEdit.active) MapEdit.toggle(false);
    this.reset();
    this.peace = Object.assign({ prevLayer: W.layer }, opts);
    if (W.layer === 'war') W.layer = 'political';
    W.peacePreview = null;
    if (W.view !== 'map') App.go('map'); else GameMap.render();
    await this.open();
    if (!this.peace) return;
    // continue a draft: its traced shapes become the starting fields
    for (const r of (opts.initial || [])) {
      const k = r.kind === 'new' ? (opts.virtual && opts.virtual.key) : (r.kind === 'province' ? 'p:' : 'c:') + r.id;
      const R = k && this.byKey[k];
      if (!R) continue;
      const ras = this.raster([r.shape || '']);
      R.field = ras.field; R.bbox = ras.bbox;
      this.overrides[k] = r.shape || '';
      this.touched.add(k);
    }
    const mine = this.regions.find(R => opts.sideOf[R.key] === opts.prefer && R.key !== (opts.virtual || {}).key) || this.regions[0];
    this.target = opts.virtual && opts.prefer === 'att' ? opts.virtual.key : mine ? mine.key : null;
    GameMap.render();
    this.renderPanel();
  },
  // the drawn clause: every touched region's traced shape
  peaceRegions() {
    const v = this.peace && this.peace.virtual;
    const out = [];
    for (const k of this.touched) {
      const R = this.byKey[k];
      if (!R) continue;
      const shape = Object.prototype.hasOwnProperty.call(this.overrides, k) ? this.overrides[k] : '';
      const kind = v && k === v.key ? 'new' : k[0] === 'p' ? 'province' : 'country';
      if (kind === 'new' && !shape) continue;
      const r = { kind, id: kind === 'new' ? 'new' : k.slice(2), shape: shape || '' };
      if (Array.isArray(R.label)) r.labelPos = R.label.map(n => Math.round(n));
      out.push(r);
    }
    return out;
  },
  endPeace(done) {
    const pz = this.peace;
    if (!pz) return;
    const regions = done ? this.peaceRegions() : null;
    this.peace = null;
    this.reset();
    W.layer = pz.prevLayer && pz.prevLayer !== 'war' ? pz.prevLayer : W.layer;
    const panel = document.getElementById('border-panel');
    if (panel) panel.remove();
    if (GameMap.svg) GameMap.svg.classList.remove('brush-mode');
    if (done) pz.onDone(regions); else if (pz.onCancel) pz.onCancel();
  },
  renderPeacePanel(wrap, panel) {
    const pz = this.peace;
    const bar = document.getElementById('map-layerbar');
    if (bar && window.innerWidth > 640) panel.style.top = (bar.offsetTop + bar.offsetHeight + 8) + 'px';
    panel.classList.remove('collapsed');
    panel.appendChild(el('div.bp-head',
      el('span.bp-title', '🕊 Peace map'),
      el('span.bp-status', !this.ready ? 'loading…' : this.touched.size ? `${this.touched.size} region(s) redrawn` : 'no change yet')));
    if (!this.ready) { panel.appendChild(el('div.ow-empty', 'Preparing the map…')); return; }
    const slider = (label, key, min, max, step, fmt) => {
      const out = el('span.bp-val', fmt(this[key]));
      const input = el('input', { type: 'range', min, max, step, value: this[key], oninput: (e) => { this[key] = Number(e.target.value); out.textContent = fmt(this[key]); if (key === 'radius') this.moveCursor(this._lastPt); } });
      return el('label.bp-slider', el('span', label), input, out);
    };
    panel.appendChild(el('div.chip-row.bp-tools',
      el('button.chip', { class: this.tool === 'brush' ? 'active' : '', onclick: () => this.setTool('brush') }, '🖌 Push borders'),
      el('button.chip', { class: this.tool === 'pan' ? 'active' : '', onclick: () => this.setTool('pan') }, '✋ Pan')));
    panel.appendChild(slider('Brush', 'radius', 15, 400, 5, v => Math.round(v)));
    panel.appendChild(slider('Push', 'strength', 0.05, 1, 0.05, v => Math.round(v * 100) + '%'));
    panel.appendChild(el('div.bp-hint', 'Pick who gains the land, then drag across the border. Only the two sides’ own territory can change. Space = pan · [ ] = size · Ctrl+Z = undo'));
    const rows = this.regions.map(R => {
      const info = this.regionInfo(R.key);
      if (!info) return null;
      const side = pz.sideOf[R.key];
      return el('div.bp-row', { class: this.target === R.key ? 'active' : '', onclick: () => { this.target = R.key; this.moveCursor(this._lastPt); this.renderPanel(); } },
        el('span.bp-swatch', { style: 'background:' + info.color }),
        el('span.bp-name', info.name + (info.kind === 'new' ? ' (new state)' : '') + (this.touched.has(R.key) ? ' •' : '')),
        el('span.bp-side', pz.sideName ? pz.sideName(side) : side));
    });
    panel.appendChild(el('div.mono-label.bp-group', 'Who gains the land'));
    panel.appendChild(el('div.bp-list', rows));
    panel.appendChild(el('div.btn-row.bp-foot',
      el('button.dash-btn.btn-xs', { onclick: () => this.undo(), disabled: this.undoStack.length ? undefined : 'disabled' }, '↶ Undo'),
      el('button.dash-btn.btn-xs', { onclick: () => this.endPeace(false) }, 'Cancel'),
      el('button.solid-btn.btn-xs', { onclick: () => this.endPeace(true) }, 'Attach to the offer')));
  }
});
window.Borders = Borders; // map.js / mapedit.js feature-detect the painter via window
