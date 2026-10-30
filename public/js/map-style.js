'use strict';
/* Atlas map style — loaded after map.js and folded into GameMap.

   The default map reads as a printed period map lying on the desk (after
   Suzerain's sheets and old atlas plates):
     · warm cream paper on a muted blue-green sea whose coasts carry engraved
       WATER-LINES (three hairlines following the shore, fading outward);
     · foreign powers left as paper, each frontier drawn in its own ink with a
       soft band of the same ink just inside (their own colour when it has a
       real hue, else a stable period ink);
     · the Republic's provinces in mid-tone printing inks of their own colours
       (amber, sage, terracotta — never pastel), parted by dotted lines, the
       nation edged with one solid line, names in widely spaced capitals of
       the same hue, deep;
     · towns as red built-up areas taking in their own buildings; red
       railways, fine grey roads; hollow capitals for countries, muted teal
       italics for seas;
     · a faint conic graticule (meridians converging north);
     · the plate's furniture in SCREEN space (#atlas-*): paper grain, warm
       light and vignette, a double neatline, a compass rose, a scale bar
       and a locator inset (click/drag it to move the map).
   The sheet stays paper in every mood: the dark moods light it with a desk
   lamp (darker surround, warm pool) instead of inverting its colours.

   Light rides the same sheet. Building SHADOWS are pre-rendered silhouettes
   offset away from the sun — long at dawn and dusk, short at noon, swinging
   from west to east through the day, gone at night (onSun, fed by
   GameMap.setDayNight). After dark the buildings sink into blue shadow and
   light their WINDOWS (pre-rendered night variants cross-faded on
   --dn-night), roads glow sodium, towns and works pool light.

   GM switch: settings.ambience.mapStyle ('atlas' default | 'classic') and
   settings.ambience.shadows (default on) — GM Studio › World › Settings &
   Time. The War layer draws on the same sheet but keeps its own furniture
   (frame with grid references, rose, scale bar — war-map.js).

   PERFORMANCE (docs/CONVENTIONS.md "map paint budget"): everything here is
   static per render — no animations, no filters and no blend modes inside
   the map svg. Shadow silhouettes and night variants are baked ONCE per
   building texture per session on a canvas (blob URLs) and moved/faded by
   CSS variables; the coast's water-lines are computed once per coastline; the
   screen-space furniture is composited HTML that never repaints with the
   map. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const XLINK = 'http://www.w3.org/1999/xlink';
  const sv = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const a in attrs) if (attrs[a] !== undefined && attrs[a] !== null) n.setAttribute(a, attrs[a]);
    if (parent) parent.appendChild(n);
    return n;
  };

  /* ---------- colour ---------- */
  function rgbOf(c) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c || '').trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.split('').map(x => x + x).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function toHsl(rgb) {
    const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function hslHex(h, s, l) {
    const f = (n) => {
      const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
      const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  }
  // frontier inks for powers whose own colour is a grey — the muted greens,
  // oranges and rose of a printed 1960s sheet, not poster colours
  const BAND_INKS = ['#c9782f', '#5f9446', '#8a6f9e', '#b2553f', '#4a8a8f', '#c29a36', '#5d79a6', '#bf6f86', '#6f8f5c', '#9a7444'];

  // a round number of km ≥ target (1, 2, 5 × 10ⁿ)
  function niceKm(target) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, target))));
    for (const m of [1, 2, 5, 10]) if (m * p >= target) return m * p;
    return 10 * p;
  }
  const fmtKm = (km) => (km >= 100 ? Math.round(km).toLocaleString('en-US') : km >= 10 ? km.toFixed(0) : km.toFixed(1).replace(/\.0$/, ''));

  Object.assign(GameMap, {
    /* ---------- switches ---------- */
    atlasStyle() {
      const a = ((((S() || {}).settings) || {}).ambience) || {};
      return a.mapStyle === 'classic' ? 'classic' : 'atlas';
    },
    // the sheet itself — every layer, the War layer included
    atlasOn() { return !!S() && this.atlasStyle() === 'atlas'; },
    // the plate's screen furniture (paper, neatline, rose, scale, locator) —
    // the War layer brings its own frame, rose and scale bar (war-map.js)
    atlasChromeOn() { return this.atlasOn() && W.layer !== 'war'; },
    shadowsOn() {
      const a = ((((S() || {}).settings) || {}).ambience) || {};
      return this.atlasOn() && a.shadows !== false;
    },

    /* ---------- inks ----------
       The sheet is printed paper in every mood (the dark moods light it with a
       desk lamp instead of inverting it — style.css). Province inks are the
       province's own hue as a mid-tone printing ink: warm, moderately
       saturated, never pastel — the amber/sage/terracotta of a period map. */
    atlasProvColor(p) {
      const rgb = rgbOf(p && p.color);
      if (!rgb) return '#d9c99a';
      const [h, s, l] = toHsl(rgb);
      return hslHex(h, Math.min(0.54, Math.max(0.12, s * 0.85 + 0.05)), Math.min(0.67, Math.max(0.52, 0.58 + (l - 0.45) * 0.3)));
    },
    // its lettering: the same hue, deep (spaced capitals over the fill)
    atlasProvLabel(p) {
      const rgb = rgbOf(p && p.color);
      if (!rgb) return '#5a4630';
      const [h, s] = toHsl(rgb);
      return hslHex(h, Math.min(0.55, Math.max(0.15, s * 0.8 + 0.12)), 0.27);
    },
    countryInk(c) {
      const ent = c && c.entityId && typeof entById === 'function' ? entById(c.entityId) : null;
      const rgb = rgbOf(ent && ent.color);
      if (rgb) {
        const [h, s, l] = toHsl(rgb);
        if (s >= 0.28 && l > 0.18 && l < 0.86) return hslHex(h, Math.min(0.55, s), 0.46);
      }
      const list = (((S() || {}).settings || {}).map || {}).countries || [];
      const i = Math.max(0, list.findIndex(x => x.id === (c && c.id)));
      return BAND_INKS[i % BAND_INKS.length];
    },

    /* ---------- the sea's edge (before any land) ----------
       Engraved WATER-LINES: true offset contours of the coast at 10, 22 and
       38 world units out to sea, drawn as three hairlines. They are found
       once per coastline (cached on its fingerprint) off the main path: all
       land is rasterised at 3 units a cell (Path2D), an exact Euclidean
       distance transform (Felzenszwalb) measures every sea cell's distance
       to land, and marching squares traces the three distance levels into
       closed loops. Drawing them then costs three thin strokes — the first
       version stacked wide strokes over the whole coast and halved the pan
       frame rate. Lines are world-scaled, so they open out as you zoom in,
       as on a sea chart. */
    _coastCache: null,
    atlasCoast(world, shapes) {
      if (!shapes.length) return;
      let h = 2166136261;
      for (const d of shapes) for (let i = 0; i < d.length; i += 7) { h ^= d.charCodeAt(i); h = Math.imul(h, 16777619); }
      const key = shapes.length + ':' + (h >>> 0) + ':' + shapes.reduce((n, d) => n + d.length, 0);
      const g = sv('g', { class: 'at-coast', 'pointer-events': 'none' }, world);
      const draw = (rings) => {
        if (!g.isConnected && g.parentNode !== world) return;
        rings.forEach((d, i) => { if (d) sv('path', { d, class: 'at-ring at-ring-' + (i + 1), 'vector-effect': 'non-scaling-stroke' }, g); });
      };
      const c = this._coastCache;
      if (c && c.key === key) { if (c.rings) draw(c.rings); else c.wait.push(draw); return; }
      const job = this._coastCache = { key, rings: null, wait: [draw] };
      // off the render path: the coast appears a moment after the land
      setTimeout(() => {
        if (this._coastCache !== job) return;
        try { job.rings = this._coastRings(shapes); } catch (e) { job.rings = []; }
        for (const f of job.wait) f(job.rings);
        job.wait = [];
      }, 0);
    },
    _coastRings(shapes) {
      const C = 3, PAD = 40, LEVELS = [10, 22, 38];
      const gw = Math.ceil(this.VIEW.w / C) + 2 * PAD, gh = Math.ceil(this.VIEW.h / C) + 2 * PAD, N = gw * gh;
      const cv = document.createElement('canvas');
      cv.width = gw; cv.height = gh;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.setTransform(1 / C, 0, 0, 1 / C, PAD, PAD);
      ctx.fillStyle = '#000';
      for (const d of shapes) { try { ctx.fill(new Path2D(d), 'evenodd'); } catch (e) { /* malformed shape */ } }
      const px = ctx.getImageData(0, 0, gw, gh).data;
      // exact squared EDT: columns then rows (Felzenszwalb & Huttenlocher)
      const BIG = 1e12, f = new Float64Array(N);
      for (let i = 0; i < N; i++) f[i] = px[i * 4 + 3] > 127 ? 0 : BIG;
      const L = Math.max(gw, gh), line = new Float64Array(L), out = new Float64Array(L), v = new Int32Array(L), z = new Float64Array(L + 1);
      const pass = (n) => {
        let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
        for (let q = 1; q < n; q++) {
          let sx = ((line[q] + q * q) - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
          while (sx <= z[k]) { k--; sx = ((line[q] + q * q) - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
          k++; v[k] = q; z[k] = sx; z[k + 1] = Infinity;
        }
        k = 0;
        for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) * (q - v[k]) + line[v[k]]; }
      };
      for (let x = 0; x < gw; x++) {
        for (let y = 0; y < gh; y++) line[y] = f[y * gw + x];
        pass(gh);
        for (let y = 0; y < gh; y++) f[y * gw + x] = out[y];
      }
      for (let y = 0; y < gh; y++) {
        const o = y * gw;
        for (let x = 0; x < gw; x++) line[x] = f[o + x];
        pass(gw);
        for (let x = 0; x < gw; x++) f[o + x] = out[x];
      }
      const dist = new Float32Array(N);
      for (let i = 0; i < N; i++) dist[i] = Math.sqrt(f[i]) * C; // world units to the nearest land
      const toW = (gx, gy) => [(gx - PAD + 0.5) * C, (gy - PAD + 0.5) * C];
      return LEVELS.map(T => this._contour(dist, gw, gh, T, toW, C));
    },
    // marching squares: closed loops where the field crosses T, as path data
    _contour(F, W_, H_, T, toW, C) {
      const segA = [], segB = [];
      for (let y = 0; y < H_ - 1; y++) {
        for (let x = 0; x < W_ - 1; x++) {
          const o = y * W_ + x;
          const tl = F[o], tr = F[o + 1], br = F[o + W_ + 1], bl = F[o + W_];
          const code = (tl < T ? 1 : 0) | (tr < T ? 2 : 0) | (br < T ? 4 : 0) | (bl < T ? 8 : 0);
          if (code === 0 || code === 15) continue;
          const top = o * 2, left = o * 2 + 1, right = (o + 1) * 2 + 1, bottom = (o + W_) * 2;
          const sg = (a, b) => { segA.push(a); segB.push(b); };
          switch (code) {
            case 1: case 14: sg(left, top); break;
            case 2: case 13: sg(top, right); break;
            case 3: case 12: sg(left, right); break;
            case 4: case 11: sg(right, bottom); break;
            case 6: case 9: sg(top, bottom); break;
            case 7: case 8: sg(left, bottom); break;
            case 5: sg(left, top); sg(right, bottom); break;
            case 10: sg(top, right); sg(bottom, left); break;
          }
        }
      }
      if (!segA.length) return '';
      const ptOf = (e) => {
        const base = e >> 1, x = base % W_, y = (base / W_) | 0;
        if ((e & 1) === 0) { const a = F[base], b = F[base + 1], t = (T - a) / ((b - a) || 1e-9); return toW(x + t, y); }
        const a = F[base], b = F[base + W_], t = (T - a) / ((b - a) || 1e-9);
        return toW(x, y + t);
      };
      const adj = new Map();
      const link = (e, sIdx) => { const l = adj.get(e); if (l) l.push(sIdx); else adj.set(e, [sIdx]); };
      for (let i = 0; i < segA.length; i++) { link(segA[i], i); link(segB[i], i); }
      const used = new Uint8Array(segA.length);
      let d = '';
      for (let s0 = 0; s0 < segA.length; s0++) {
        if (used[s0]) continue;
        used[s0] = 1;
        const start = segA[s0], pts = [ptOf(start)];
        let cur = s0, e = segB[s0];
        for (let guard = 0; guard < 4e6 && e !== start; guard++) {
          pts.push(ptOf(e));
          const l = adj.get(e) || [];
          const nx = l[0] === cur ? l[1] : l[0];
          if (nx === undefined || used[nx]) break;
          used[nx] = 1;
          e = segA[nx] === e ? segB[nx] : segA[nx];
          cur = nx;
        }
        if (pts.length < 6) continue; // specks
        const p = this._simplify(pts, C * 0.25);
        d += 'M' + p.map(q => q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' L') + (e === start ? 'Z ' : ' ');
      }
      return d;
    },
    // Douglas-Peucker (open run; loops are closed by Z)
    _simplify(pts, eps) {
      if (pts.length < 4) return pts;
      const keep = new Uint8Array(pts.length); keep[0] = 1; keep[pts.length - 1] = 1;
      const stack = [[0, pts.length - 1]];
      while (stack.length) {
        const [a, b] = stack.pop();
        const A = pts[a], B = pts[b], dx = B[0] - A[0], dy = B[1] - A[1], len = Math.hypot(dx, dy) || 1e-9;
        let md = -1, mi = -1;
        for (let i = a + 1; i < b; i++) {
          const P = pts[i], dd = Math.abs(dy * P[0] - dx * P[1] + B[0] * A[1] - B[1] * A[0]) / len;
          if (dd > md) { md = dd; mi = i; }
        }
        if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
      }
      return pts.filter((_, i) => keep[i]);
    },

    /* ---------- frontier ribbons (after the country fills) ----------
       Each power's outline stroked wide in its ink and clipped to its own
       shape, so the ribbon runs just inside the frontier — along coasts too,
       as on the printed sheets. The border painter edits these paths in place
       (reg → GameMap.regionNodes). */
    atlasBands(world, items, reg) {
      if (!items.length) return;
      const g = sv('g', { class: 'at-bands', 'pointer-events': 'none' }, world);
      const defs = sv('defs', {}, g);
      for (const it of items) {
        const id = 'atc-' + String(it.c.id).replace(/[^\w-]/g, '_');
        const clip = sv('clipPath', { id }, defs);
        const cp = sv('path', { d: it.d, 'clip-rule': 'evenodd' }, clip);
        const ink = this.countryInk(it.c);
        const band = sv('path', { d: it.d, class: 'at-band', stroke: ink, 'clip-path': `url(#${id})`, 'vector-effect': 'non-scaling-stroke' }, g);
        const line = sv('path', { d: it.d, class: 'at-frontier', stroke: ink, 'vector-effect': 'non-scaling-stroke' }, g);
        reg(it.key, cp); reg(it.key, band); reg(it.key, line);
      }
    },

    // the Republic as one shape: land underlay (the data layer's ramps sit on
    // it) and a solid coast/frontier line — its inner half is covered by the
    // province fills, so only the outer edge survives
    atlasNation(world, dProv) {
      if (!dProv) return;
      sv('path', { d: dProv, class: 'at-nation', 'fill-rule': 'nonzero', 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }, world);
    },

    /* ---------- conic graticule (above the land, under the roads) ---------- */
    atlasGraticule(world) {
      const W_ = this.VIEW.w, H_ = this.VIEW.h, cx = W_ / 2, cy = -9000; // the cone's apex, far north
      const x0 = -1800, x1 = W_ + 1800;
      let d = '';
      for (let r = -cy - 900; r <= H_ - cy + 1500; r += 300) {
        const a0 = Math.asin(Math.max(-1, (x0 - cx) / r)), a1 = Math.asin(Math.min(1, (x1 - cx) / r));
        const p = (a) => (cx + r * Math.sin(a)).toFixed(0) + ' ' + (cy + r * Math.cos(a)).toFixed(0);
        d += `M${p(a0)} A${r} ${r} 0 0 0 ${p(a1)} `;
      }
      const rIn = -cy - 1400, rOut = H_ - cy + 1900;
      for (let x = cx - 3600; x <= cx + 3600; x += 300) {
        const a = Math.atan2(x - cx, H_ / 2 - cy);
        d += `M${(cx + rIn * Math.sin(a)).toFixed(0)} ${(cy + rIn * Math.cos(a)).toFixed(0)} L${(cx + rOut * Math.sin(a)).toFixed(0)} ${(cy + rOut * Math.cos(a)).toFixed(0)} `;
      }
      sv('path', { d, class: 'at-grat', 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }, world);
    },

    /* ---------- built-up areas (under the roads) ---------- */
    atlasUrban(world, dProv) {
      const g = sv('g', { class: 'at-urban', 'pointer-events': 'none' }, world);
      // built-up areas stop at the shore (one clip on the whole group)
      if (dProv) {
        const clip = sv('clipPath', { id: 'at-land-clip' }, sv('defs', {}, g));
        sv('path', { d: dProv }, clip);
        g.setAttribute('clip-path', 'url(#at-land-clip)');
      }
      const props = (S().properties || []).filter(p => Array.isArray(p.pos));
      for (const c of (S().cities || [])) {
        if (!Array.isArray(c.pos)) continue;
        const base = [0, 22, 34, 52][c.size || 1] || 22;
        // the footprint grows to take in the town's own buildings
        let r = base;
        for (const p of props) {
          const dd = Math.hypot(p.pos[0] - c.pos[0], p.pos[1] - c.pos[1]);
          if (dd < base * 3) r = Math.max(r, dd + 16);
        }
        r = Math.min(r, base * 2.4);
        const rand = this.seedRand('urb:' + c.id);
        const blob = this.blobShape(rand, r);
        sv('path', { d: blob.d, class: 'at-town', 'vector-effect': 'non-scaling-stroke',
          transform: `translate(${c.pos[0]},${c.pos[1]}) rotate(${(rand() * 360).toFixed(0)})` }, g);
      }
    },

    /* ---------- building textures: shadows and lit windows ----------
       Baked once per texture per session: a blurred dark SILHOUETTE (the
       shadow, offset by CSS variables per the sun) and a NIGHT variant (the
       block sunk into blue shadow with warm windows on its walls — pixels
       darker than the roof, the brightest face). Canvas → blob URL; until a
       bake lands (or where canvas is unavailable) the node simply shows
       nothing and the plain building art stands alone. */
    _tex: {},
    texDerived(tex) {
      let rec = this._tex[tex];
      if (rec) return rec;
      rec = this._tex[tex] = { done: false, shadow: null, night: null };
      rec.p = new Promise((resolve) => {
        const img = new Image();
        img.onload = async () => {
          try {
            rec.shadow = await this._bakeShadow(img);
            rec.night = await this._bakeNight(img, tex);
          } catch (e) { /* no canvas: the plain building art still shows */ }
          rec.done = true; resolve(rec);
        };
        img.onerror = () => { rec.done = true; resolve(rec); };
        img.src = '/assets/buildings/' + tex;
      });
      return rec;
    },
    texSet(node, tex, kind) {
      const rec = this.texDerived(tex);
      const apply = () => {
        const url = rec[kind];
        if (!url) { node.remove(); return; }
        node.setAttribute('href', url);
        node.setAttributeNS(XLINK, 'href', url);
      };
      if (rec.done) apply(); else rec.p.then(apply);
    },
    _blobUrl(canvas) {
      return new Promise((res) => {
        try { canvas.toBlob(b => res(b ? URL.createObjectURL(b) : null), 'image/png'); } catch (e) { res(null); }
      });
    },
    _bakeShadow(img) {
      const N = 192;
      const a = document.createElement('canvas'); a.width = a.height = N;
      const ca = a.getContext('2d');
      ca.drawImage(img, 0, 0, N, N);
      ca.globalCompositeOperation = 'source-in';
      ca.fillStyle = '#16131c'; ca.fillRect(0, 0, N, N);
      const b = document.createElement('canvas'); b.width = b.height = N;
      const cb = b.getContext('2d');
      if ('filter' in cb) cb.filter = 'blur(2.5px)';
      cb.drawImage(a, 0, 0);
      return this._blobUrl(b);
    },
    _bakeNight(img, tex) {
      const t = String(tex);
      if (/airport|ports/.test(t)) return null; // flat map icons: nothing to light
      const N = 360;
      const c = document.createElement('canvas'); c.width = c.height = N;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0, N, N);
      const px = x.getImageData(0, 0, N, N).data;
      const lum = new Float32Array(N * N);
      let maxL = 0;
      for (let i = 0; i < N * N; i++) {
        if (px[i * 4 + 3] < 210) { lum[i] = -1; continue; }
        const L = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
        lum[i] = L; if (L > maxL) maxL = L;
      }
      // the block sinks into blue night…
      x.globalCompositeOperation = 'source-atop';
      x.fillStyle = 'rgba(13,19,42,0.84)';
      x.fillRect(0, 0, N, N);
      // …and its walls light up, window by window
      const density = /farm/.test(t) ? 0.1 : /military|fort|prison/.test(t) ? 0.45 : /industrial/.test(t) ? 0.55 : 1;
      const want = Math.round(46 * density);
      const thr = maxL * 0.93;
      const rand = this.seedRand('win:' + t);
      const placed = [];
      const wall = (wx, wy) => { const L = lum[Math.min(N - 1, wy) * N + Math.min(N - 1, wx)]; return L >= 0 && L <= thr; };
      for (let tries = 0; tries < 5000 && placed.length < want; tries++) {
        const wx = Math.floor(rand() * N), wy = Math.floor(rand() * N);
        if (!wall(wx, wy) || !wall(wx + 5, wy + 6)) continue;
        if (placed.some(q => Math.abs(q[0] - wx) < 11 && Math.abs(q[1] - wy) < 10)) continue;
        placed.push([wx, wy]);
      }
      const tones = ['#ffd27a', '#ffe3a6', '#ffbf5e', '#fff2cf', '#ffc977'];
      x.shadowColor = 'rgba(255,178,80,1)';
      x.shadowBlur = 9;
      for (const [wx, wy] of placed) {
        x.globalAlpha = 0.7 + rand() * 0.3;
        x.fillStyle = tones[Math.floor(rand() * tones.length)];
        x.fillRect(wx, wy, 4, 5);
      }
      return this._blobUrl(c);
    },
    // how tall a texture stands (multiplies its shadow's reach)
    texHeight(tex) {
      const t = String(tex);
      if (/supertall/.test(t)) return 2.1;
      if (/tall/.test(t)) return 1.5;
      if (/farm/.test(t)) return 0.25;
      if (/airport|ports/.test(t)) return 0.4;
      if (/industrial|military|fort/.test(t)) return 0.8;
      return 1;
    },
    // every building's shadow, in one layer under all the buildings
    atlasShadows(world) {
      if (!this.shadowsOn()) return null;
      const g = sv('g', { class: 'at-shadows', 'pointer-events': 'none' }, world);
      for (const pr of (S().properties || [])) {
        if (!Array.isArray(pr.pos) || !pr.texture) continue;
        const holder = sv('g', { transform: `translate(${pr.pos[0]},${pr.pos[1]}) scale(${this.TEX_SCALE})` }, g);
        const img = sv('image', { class: 'at-shadow', x: -60, y: -100, width: 120, height: 120, preserveAspectRatio: 'xMidYMax meet', style: '--h:' + this.texHeight(pr.texture) }, holder);
        this.texSet(img, pr.texture, 'shadow');
      }
      return g;
    },
    // the lit-window variant stacked over a building's day art
    atlasNightArt(tex) {
      const img = sv('image', { class: 'tex-night', x: -60, y: -100, width: 120, height: 120, preserveAspectRatio: 'xMidYMax meet' });
      this.texSet(img, tex, 'night');
      return img;
    },

    /* ---------- the sun ----------
       Bearing due east at 06:00, south at noon, west at 18:00; the noon sun
       stands ~62° high. Shadows point away from it, length ∝ 1/tan(altitude)
       (long at dawn/dusk), foreshortened north–south for the map's oblique
       view, and fade out as the sun sets. Written as CSS variables only when
       the offset moves by a whole unit — each write repaints the map. With
       the day/night cycle off the sun holds at mid-afternoon. */
    onSun(wrap, sun) {
      if (!wrap || !this.atlasOn()) return;
      const m = sun ? sun.m : 900, daylight = sun ? sun.daylight : 1;
      const th = Math.max(0.05, Math.min(Math.PI - 0.05, ((m - 360) / 720) * Math.PI));
      const elev = Math.sin(th);
      const alt = Math.max(0.08, elev * 62 * Math.PI / 180);
      const len = Math.min(3.4, Math.max(0.45, 1 / Math.tan(alt)));
      const sx = -Math.cos(th) * len * 11, sy = -Math.sin(th) * len * 11 * 0.62;
      const o = 0.4 * Math.min(1, daylight * 1.25) * Math.min(1, elev * 3.2);
      const key = sx.toFixed(0) + ',' + sy.toFixed(0) + ',' + o.toFixed(2);
      if (key === wrap._sunKey) return;
      wrap._sunKey = key;
      wrap.style.setProperty('--sh-x', Math.round(sx) + 'px');
      wrap.style.setProperty('--sh-y', Math.round(sy) + 'px');
      wrap.style.setProperty('--sh-o', o.toFixed(2));
    },

    /* ---------- night extras (inside the glow group) ---------- */
    atlasLights(map) {
      const host = this.lightsInner;
      if (!host) return;
      const g = sv('g', { class: 'at-lights' }, host);
      // highways: a thread of sodium lamps along every road
      for (const r of (map.roads || [])) {
        if (!r.pts || r.pts.length < 2) continue;
        const pts = r.pts.map(p => p.join(',')).join(' ');
        sv('polyline', { points: pts, class: 'at-road-halo', 'vector-effect': 'non-scaling-stroke' }, g);
        sv('polyline', { points: pts, class: 'at-road-lamp', 'vector-effect': 'non-scaling-stroke' }, g);
      }
      // towns: a pool of light per city — unless the GM already lit it
      const gmLights = map.lights || [];
      for (const c of (S().cities || [])) {
        if (!Array.isArray(c.pos)) continue;
        const r = [0, 70, 110, 170][c.size || 1] || 70;
        if (gmLights.some(l => l.pos && Math.hypot(l.pos[0] - c.pos[0], l.pos[1] - c.pos[1]) < r * 0.7)) continue;
        const rand = this.seedRand('glow:' + c.id);
        const blob = this.blobShape(rand, r);
        sv('path', { d: blob.d, class: 'map-light-halo', transform: `translate(${c.pos[0]},${c.pos[1]}) rotate(${(rand() * 360).toFixed(0)})` }, g);
        sv('circle', { cx: c.pos[0], cy: c.pos[1], r: (r * 0.3).toFixed(0), class: 'map-light-bloom' }, g);
      }
      // works and blocks: light spilling onto the ground around each one
      for (const pr of (S().properties || [])) {
        if (!Array.isArray(pr.pos)) continue;
        const sodium = /factory|mine|port|infrastructure|military|airport|airbase|fort/.test(pr.kind || '');
        sv('ellipse', { cx: pr.pos[0], cy: pr.pos[1] - 8, rx: 50, ry: 32, class: 'at-spill', fill: sodium ? 'url(#lightSpeckSodium)' : 'url(#lightSpeckWarm)' }, g);
      }
    },

    /* ---------- the plate's furniture (screen space) ---------- */
    // on: the furniture; sheet: the atlas inks (their tokens hang off
    // #map-wrap.atlas, so the War layer keeps the class without the furniture)
    atlasChrome(on, sheet) {
      const wrap = document.getElementById('map-wrap');
      if (!wrap) return;
      this._atlasLive = !!on;
      wrap.classList.toggle('atlas', !!(sheet === undefined ? on : sheet));
      if (!on) {
        for (const id of ['atlas-paper', 'atlas-frame', 'atlas-scale', 'atlas-inset']) { const n = document.getElementById(id); if (n) n.remove(); }
        this._compassRose(false);
        return;
      }
      if (!document.getElementById('atlas-paper')) wrap.appendChild(el('div#atlas-paper'));
      let frame = document.getElementById('atlas-frame');
      if (!frame) { frame = el('div#atlas-frame'); wrap.appendChild(frame); }
      if (!document.getElementById('atlas-scale')) wrap.appendChild(el('div#atlas-scale'));
      this._inset(wrap);
      this._compassRose(true);
      wrap._scaleKey = null;
      this.onView();
    },
    _compassRose(on) {
      const c = document.getElementById('map-compass');
      if (!c) return;
      if (on === !!c._rose) return;
      c._rose = on;
      c.classList.toggle('at-rose', on);
      if (!on) { c.innerHTML = '<div class="n">N</div><div>▲</div>'; return; }
      const pts = [];
      for (let i = 0; i < 16; i++) {
        const a = i * Math.PI / 8 - Math.PI / 2, card = i % 4 === 0, r = card ? 31 : i % 2 ? 13 : 20, w = card ? 5.5 : i % 2 ? 2.4 : 3.6;
        const f = (p) => p[0].toFixed(1) + ',' + p[1].toFixed(1);
        const tip = [Math.cos(a) * r, Math.sin(a) * r];
        const l = [Math.cos(a - Math.PI / 2) * w, Math.sin(a - Math.PI / 2) * w];
        const rr = [Math.cos(a + Math.PI / 2) * w, Math.sin(a + Math.PI / 2) * w];
        pts.push(`<path d="M0,0 L${f(l)} L${f(tip)} Z" class="rose-light"/><path d="M0,0 L${f(rr)} L${f(tip)} Z" class="rose-dark"/>`);
      }
      c.innerHTML = '<svg viewBox="-42 -50 84 92" xmlns="http://www.w3.org/2000/svg">' +
        '<circle r="35" class="rose-ring"/><circle r="24" class="rose-ring rose-ring-in"/>' + pts.join('') +
        '<circle r="2.4" class="rose-hub"/><text y="-39" text-anchor="middle" class="rose-n">N</text></svg>';
    },
    // the locator: the whole sheet in miniature, the view as a red frame
    _inset(wrap) {
      if (window.innerWidth <= 640) { const n = document.getElementById('atlas-inset'); if (n) n.remove(); return; }
      const map = S().settings.map || {};
      const key = JSON.stringify([(map.countries || []).map(c => [c.id, (c.shape || '').length]),
        (S().provinces || []).map(p => [p.id, (p.shape || '').length, p.color])]);
      let box = document.getElementById('atlas-inset');
      if (box && box._key === key) return;
      if (!box) {
        box = el('div#atlas-inset', { title: 'Locator — click or drag to move the map' });
        wrap.appendChild(box);
        const go = (e) => {
          const svg = box.querySelector('svg');
          if (!svg) return;
          const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
          const p = pt.matrixTransform(svg.getScreenCTM().inverse());
          this.view.x = this.VIEW.w / 2 - p.x * this.view.k;
          this.view.y = this.VIEW.h / 2 - p.y * this.view.k;
          this.scheduleTransform();
        };
        box.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); box._drag = e.pointerId; try { box.setPointerCapture(e.pointerId); } catch (er) { /* gone */ } go(e); });
        box.addEventListener('pointermove', (e) => { if (box._drag === e.pointerId) go(e); });
        const end = (e) => { if (box._drag === e.pointerId) box._drag = null; };
        box.addEventListener('pointerup', end);
        box.addEventListener('pointercancel', end);
      }
      box._key = key;
      let h = `<svg viewBox="0 0 ${this.VIEW.w} ${this.VIEW.h}" preserveAspectRatio="xMidYMid meet" xmlns="${NS}"><rect x="-200" y="-200" width="${this.VIEW.w + 400}" height="${this.VIEW.h + 400}" class="ati-sea"/>`;
      for (const c of (map.countries || [])) if (c.shape) h += `<path d="${c.shape}" fill-rule="evenodd" class="ati-land"/>`;
      for (const p of (S().provinces || [])) if (p.shape) h += `<path d="${p.shape}" fill-rule="evenodd" class="ati-prov" fill="${this.atlasProvColor(p)}"/>`;
      h += '<rect class="ati-view" x="0" y="0" width="1" height="1"/></svg><div class="ati-cap">Locator</div>';
      box.innerHTML = h;
      wrap._scaleKey = null;
    },
    // pan/zoom: the scale bar and the locator's frame follow (rAF-coalesced)
    onView() {
      if (!this._atlasLive || this._atlasRaf) return;
      this._atlasRaf = requestAnimationFrame(() => { this._atlasRaf = null; this._atlasViewNow(); });
    },
    _atlasViewNow() {
      const wrap = document.getElementById('map-wrap');
      if (!wrap || !this.svg || !this._atlasLive) return;
      // the GM command bar floats over the map's foot: lift the plate's
      // bottom furniture (neatline, scale, locator, key) clear of it
      const gb = document.querySelector('.gm-bar:not(.hidden)');
      const foot = gb ? Math.max(0, Math.round(wrap.getBoundingClientRect().bottom - gb.getBoundingClientRect().top)) : 0;
      if (foot !== wrap._foot) { wrap._foot = foot; wrap.style.setProperty('--at-foot', foot + 'px'); }
      const ctm = this.svg.getScreenCTM();
      if (!ctm) return;
      const pxPerUnit = ctm.a * this.view.k;
      const kpp = Number(((S().settings || {}).map || {}).kmPerPx) || 2.17;
      const pxPerKm = pxPerUnit / kpp;
      const km = niceKm(120 / pxPerKm);
      const bar = document.getElementById('atlas-scale');
      if (bar && wrap._scaleKey !== km + '|' + pxPerKm.toFixed(4)) {
        wrap._scaleKey = km + '|' + pxPerKm.toFixed(4);
        const len = km * pxPerKm, cells = 4, cw = len / cells;
        let h = `<svg width="${Math.ceil(len) + 40}" height="36" xmlns="${NS}"><g transform="translate(9,13)">`;
        for (let i = 0; i < cells; i++) h += `<rect x="${(i * cw).toFixed(1)}" y="0" width="${cw.toFixed(1)}" height="5" class="${i % 2 ? 'sb-light' : 'sb-dark'}"/>`;
        h += `<rect x="0" y="0" width="${len.toFixed(1)}" height="5" class="sb-box"/>`;
        for (let i = 0; i <= cells; i += 2) h += `<text x="${(i * cw).toFixed(1)}" y="16" text-anchor="middle" class="sb-num">${fmtKm(km * i / cells)}</text>`;
        h += `<text x="${(len + 5).toFixed(1)}" y="5" class="sb-unit">km</text><text x="${(len / 2).toFixed(1)}" y="-4" text-anchor="middle" class="sb-cap">SCALE</text></g></svg>`;
        bar.innerHTML = h;
      }
      const vr = document.querySelector('#atlas-inset .ati-view');
      if (vr) {
        const r = this.svg.getBoundingClientRect();
        const a = this.clientToWorld(r.left, r.top), b = this.clientToWorld(r.right, r.bottom);
        vr.setAttribute('x', a[0].toFixed(0)); vr.setAttribute('y', a[1].toFixed(0));
        vr.setAttribute('width', Math.max(8, b[0] - a[0]).toFixed(0)); vr.setAttribute('height', Math.max(8, b[1] - a[1]).toFixed(0));
      }
    }
  });
})();
