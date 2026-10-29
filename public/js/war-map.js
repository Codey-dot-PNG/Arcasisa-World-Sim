'use strict';
/* War map furniture — loaded after war.js and folded into the War object.

   The War layer reads as a staff officer's map sheet laid on the table:
     · a kilometre grid in the map itself (500 km squares lettered A, B, C…
       across and numbered down — "enemy armour in D4"; 100 km sub-lines once
       zoomed in), drawn ONCE per full map render in the base svg;
     · a printed frame around the viewport (#war-frame, screen space): a
       double neatline, graduated margins carrying the grid references, a
       scale bar that re-picks a round length as you zoom, and a compass rose;
     · paper (#war-paper): texture, vignette and fold creases — a static,
       composited layer that never repaints with the map;
     · measuring tools: a RULER (distance, bearing and what it takes to cover
       it — infantry, armour, by road, by air) and a RANGE compass (a circle
       and what stands inside it);
     · troop movement: every live unit's recent TRAIL (breadcrumbs — you see
       where any column has come from) and, on selected units, the remaining
       route's length and time to arrival.

   Distances come from settings.map.kmPerPx (world data — Arcasia is about
   the size of Brazil, 2.17 km per map pixel; see store.migrate). Times are
   real seconds at the conflict's current speed. Nothing here animates on its
   own: the frame redraws on pan/zoom (onViewChange), the rest on the war
   layer's normal refreshes — the map paint budget in docs/CONVENTIONS.md. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const GRID_MAJOR_KM = 500;
  const GRID_MINOR_KM = 100;
  const GRID_FINE_K = 1.25;          // zoom at which the 100 km sub-grid appears
  const TRAIL_POINTS = 10;           // breadcrumbs kept per unit (one per tick moved)

  const kmPerPx = () => Number((((S() || {}).settings || {}).map || {}).kmPerPx) || 2.17;
  const sv = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const a in attrs) if (attrs[a] !== undefined && attrs[a] !== null) n.setAttribute(a, attrs[a]);
    if (parent) parent.appendChild(n);
    return n;
  };
  // a round number of km ≥ target (1, 2, 5 × 10ⁿ)
  function niceKm(target) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, target))));
    for (const m of [1, 2, 5, 10]) if (m * p >= target) return m * p;
    return 10 * p;
  }
  const fmtKm = (km) => (km <= 0 ? '0' : km >= 100 ? Math.round(km).toLocaleString('en-US') : km >= 10 ? km.toFixed(0) : km.toFixed(1)) + ' km';
  const colName = (i) => (i >= 26 ? String.fromCharCode(65 + Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));
  const fmtDur = (s) => {
    if (!Number.isFinite(s)) return '—';
    s = Math.max(0, Math.round(s));
    if (s >= 3600) return Math.floor(s / 3600) + 'h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm';
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  Object.assign(War, {
    kmPerPx,
    fmtKm,
    fmtDur,
    // "D4" — the 500 km grid square a world point sits in
    gridRef(pos) {
      if (!Array.isArray(pos)) return '';
      const step = GRID_MAJOR_KM / kmPerPx();
      return colName(Math.max(0, Math.floor(pos[0] / step))) + (Math.max(0, Math.floor(pos[1] / step)) + 1);
    },
    // real seconds per tick at the doc's current speed
    _tickSeconds(war) {
      war = war || this.activeAuth() || {};
      return Math.max(200, (war.tickMs || 2000) / (war.speed || 1)) / 1000;
    },

    /* ---------- the grid (base svg, once per full render) ---------- */
    _renderGrid(layer) {
      clear(layer);
      const W_ = 3840, H_ = 2160;
      const major = GRID_MAJOR_KM / kmPerPx(), minor = GRID_MINOR_KM / kmPerPx();
      let dMinor = '', dMajor = '';
      for (let x = minor; x < W_; x += minor) {
        const isMajor = Math.abs(x / major - Math.round(x / major)) < 1e-6;
        const seg = `M${x.toFixed(1)} 0 V${H_} `;
        if (isMajor) dMajor += seg; else dMinor += seg;
      }
      for (let y = minor; y < H_; y += minor) {
        const isMajor = Math.abs(y / major - Math.round(y / major)) < 1e-6;
        const seg = `M0 ${y.toFixed(1)} H${W_} `;
        if (isMajor) dMajor += seg; else dMinor += seg;
      }
      sv('path', { d: dMinor, class: 'war-grid-minor', 'vector-effect': 'non-scaling-stroke' }, layer);
      sv('path', { d: dMajor, class: 'war-grid-major', 'vector-effect': 'non-scaling-stroke' }, layer);
    },

    /* ---------- the printed frame, paper and compass (screen space) ---------- */
    _mountFrame() {
      const wrap = document.getElementById('map-wrap');
      if (!wrap) return;
      if (!document.getElementById('war-paper')) wrap.appendChild(el('div#war-paper'));
      if (!document.getElementById('war-lamp')) wrap.appendChild(el('div#war-lamp'));
      let frame = document.getElementById('war-frame');
      if (!frame) {
        frame = el('div#war-frame');
        frame.innerHTML = '<svg class="war-frame-svg" xmlns="http://www.w3.org/2000/svg"></svg>';
        wrap.appendChild(frame);
        const rose = el('div#war-rose', { title: 'North' });
        rose.innerHTML = this._roseSvg();
        wrap.appendChild(rose);
        wrap.appendChild(el('div#war-scalebar'));
      }
      this._frameKey = null;
      this.onViewChange();
    },
    _unmountFrame() {
      for (const id of ['war-paper', 'war-lamp', 'war-frame', 'war-rose', 'war-scalebar']) { const n = document.getElementById(id); if (n) n.remove(); }
      this._frameKey = null;
      const svg = GameMap && GameMap.svg;
      if (svg) svg.classList.remove('war-grid-fine');
    },
    _roseSvg() {
      // an 8-point compass rose, half-shaded points, N on top
      const pts = [];
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4 - Math.PI / 2, r = i % 2 ? 17 : 30, w = i % 2 ? 4 : 6.5;
        const tip = [Math.cos(a) * r, Math.sin(a) * r];
        const l = [Math.cos(a - Math.PI / 2) * w, Math.sin(a - Math.PI / 2) * w];
        const rr = [Math.cos(a + Math.PI / 2) * w, Math.sin(a + Math.PI / 2) * w];
        const f = (p) => p[0].toFixed(1) + ',' + p[1].toFixed(1);
        pts.push(`<path d="M0,0 L${f(l)} L${f(tip)} Z" class="rose-light"/><path d="M0,0 L${f(rr)} L${f(tip)} Z" class="rose-dark"/>`);
      }
      return '<svg viewBox="-40 -46 80 86" xmlns="http://www.w3.org/2000/svg">' +
        '<circle r="33" class="rose-ring"/><circle r="22" class="rose-ring rose-ring-in"/>' + pts.join('') +
        '<circle r="2.4" class="rose-hub"/><text y="-36" text-anchor="middle" class="rose-n">N</text></svg>';
    },
    // pan/zoom: redraw the margins and the scale bar (rAF-coalesced)
    onViewChange() {
      if (this._frameRaf) return;
      this._frameRaf = requestAnimationFrame(() => { this._frameRaf = null; this._drawFrame(); this._rescaleScreenMarks(); });
    },
    _drawFrame() {
      const frame = document.getElementById('war-frame');
      const map = typeof GameMap !== 'undefined' ? GameMap : null;
      if (!frame || !map || !map.svg || !map.view) return;
      const box = frame.getBoundingClientRect();
      if (!box.width || !box.height) return;
      // world ↔ frame-local px (the map never rotates: an affine per axis)
      const w0 = map.clientToWorld(box.left, box.top), w1 = map.clientToWorld(box.right, box.bottom);
      const sx = box.width / ((w1[0] - w0[0]) || 1), sy = box.height / ((w1[1] - w0[1]) || 1);
      const toX = (wx) => (wx - w0[0]) * sx, toY = (wy) => (wy - w0[1]) * sy;
      const key = [Math.round(box.width), Math.round(box.height), w0.map(v => v.toFixed(1)).join(), sx.toFixed(5), kmPerPx()].join('|');
      if (key === this._frameKey) return;
      this._frameKey = key;
      const svg = frame.firstChild;
      clear(svg);
      const Wd = box.width, Hd = box.height, M = Wd < 640 ? 12 : 16; // margin strip
      svg.setAttribute('viewBox', `0 0 ${Wd} ${Hd}`);
      // the margin strips and the double neatline
      sv('path', { d: `M0 0 H${Wd} V${Hd} H0 Z M${M} ${M} V${Hd - M} H${Wd - M} V${M} Z`, class: 'war-frame-margin', 'fill-rule': 'evenodd' }, svg);
      sv('rect', { x: 1, y: 1, width: Wd - 2, height: Hd - 2, class: 'war-frame-outer' }, svg);
      sv('rect', { x: M, y: M, width: Wd - 2 * M, height: Hd - 2 * M, class: 'war-frame-inner' }, svg);
      const kpp = kmPerPx();
      const major = GRID_MAJOR_KM / kpp, minor = GRID_MINOR_KM / kpp;
      // graduations: minor ticks every 100 km (or coarser when zoomed far
      // out), major ticks on the grid lines; letters / numbers centred on
      // the visible part of each grid square
      const tickStepPx = (() => { let st = minor; while (st * sx < 7) st *= 5; return st; })();
      let ticks = '';
      for (let x = Math.ceil(w0[0] / tickStepPx) * tickStepPx; x <= w1[0]; x += tickStepPx) {
        const px = toX(x); if (px < M || px > Wd - M) continue;
        const big = Math.abs(x / major - Math.round(x / major)) < 1e-6;
        const len = big ? M : 5;
        ticks += `M${px.toFixed(1)} ${M} v${-len} M${px.toFixed(1)} ${Hd - M} v${len} `;
      }
      for (let y = Math.ceil(w0[1] / tickStepPx) * tickStepPx; y <= w1[1]; y += tickStepPx) {
        const py = toY(y); if (py < M || py > Hd - M) continue;
        const big = Math.abs(y / major - Math.round(y / major)) < 1e-6;
        const len = big ? M : 5;
        ticks += `M${M} ${py.toFixed(1)} h${-len} M${Wd - M} ${py.toFixed(1)} h${len} `;
      }
      sv('path', { d: ticks, class: 'war-frame-ticks' }, svg);
      const label = (x, y, t, cls) => { const n = sv('text', { x: x.toFixed(1), y: y.toFixed(1), 'text-anchor': 'middle', class: 'war-frame-ref' + (cls ? ' ' + cls : '') }, svg); n.textContent = t; };
      for (let c = Math.max(0, Math.floor(w0[0] / major)); c * major < w1[0]; c++) {
        const a = Math.max(M, toX(c * major)), b = Math.min(Wd - M, toX((c + 1) * major));
        if (b - a < 14) continue;
        label((a + b) / 2, M - 4.5, colName(c)); label((a + b) / 2, Hd - 4.5, colName(c));
      }
      for (let r = Math.max(0, Math.floor(w0[1] / major)); r * major < w1[1]; r++) {
        const a = Math.max(M, toY(r * major)), b = Math.min(Hd - M, toY((r + 1) * major));
        if (b - a < 14) continue;
        label(M / 2, (a + b) / 2 + 3.5, String(r + 1)); label(Wd - M / 2, (a + b) / 2 + 3.5, String(r + 1));
      }
      // the scale bar: a round length ~110–220 px long, four alternating cells
      const bar = document.getElementById('war-scalebar');
      if (bar) {
        const pxPerKm = sx / kpp;
        const km = niceKm(150 / pxPerKm);
        const len = km * pxPerKm;
        const cells = 4, cw = len / cells;
        let h = `<svg width="${Math.ceil(len) + 34}" height="34" xmlns="http://www.w3.org/2000/svg"><g transform="translate(8,12)">`;
        for (let i = 0; i < cells; i++) h += `<rect x="${(i * cw).toFixed(1)}" y="0" width="${cw.toFixed(1)}" height="6" class="${i % 2 ? 'sb-light' : 'sb-dark'}"/>`;
        h += `<rect x="0" y="0" width="${len.toFixed(1)}" height="6" class="sb-box"/>`;
        for (let i = 0; i <= cells; i += 2) h += `<text x="${(i * cw).toFixed(1)}" y="17" text-anchor="middle" class="sb-num">${fmtKm(km * i / cells).replace(' km', '')}</text>`;
        h += `<text x="${(len + 4).toFixed(1)}" y="5.5" class="sb-unit">km</text></g></svg>`;
        bar.innerHTML = h;
      }
      // the 100 km sub-grid only once it would be legible
      const fine = (GameMap.view.k || 1) >= GRID_FINE_K;
      if (fine !== this._gridFine) { this._gridFine = fine; map.svg.classList.toggle('war-grid-fine', fine); }
    },

    /* ---------- measuring tools: ruler and range compass ---------- */
    // Labels that must stay one size on screen whatever the zoom (.war-screen,
    // data-x/data-y their world anchor) — rescaled on view change.
    // world units per CSS pixel right now (zoom × the svg's viewBox fit)
    _screenScale() {
      const map = typeof GameMap !== 'undefined' ? GameMap : null;
      const ctm = map && map.svg && map.svg.getScreenCTM();
      return 1 / (((map && map.view && map.view.k) || 1) * ((ctm && ctm.a) || 1));
    },
    _rescaleScreenMarks() {
      const root = this._O && this._O.root;
      if (!root) return;
      const ss = this._screenScale().toFixed(4);
      for (const n of root.querySelectorAll('.war-screen')) {
        n.setAttribute('transform', `translate(${n.getAttribute('data-x')},${n.getAttribute('data-y')}) scale(${ss})`);
      }
      // ruler graduations are sized in screen pixels too
      if (this._measure && this._measure.kind === 'ruler' && !(this._input && this._input.mode === 'measure')) this._drawMeasure();
    },
    _screenGroup(parent, pos, cls) {
      return sv('g', { class: 'war-screen ' + (cls || ''), 'data-x': pos[0].toFixed(1), 'data-y': pos[1].toFixed(1),
        transform: `translate(${pos[0].toFixed(1)},${pos[1].toFixed(1)}) scale(${this._screenScale().toFixed(4)})` }, parent);
    },
    setTool(tool) {
      this._tool = this._tool === tool ? null : tool;
      if (!this._tool) { this._measure = null; this._drawMeasure(); }
      if (this._tool) { this._sel.clear(); this._airPlan = null; }
      this.refreshLayer(true);
      this.renderToolbar();
    },
    _measureDown(world) {
      this._swallowUp = true;
      this._measure = { kind: this._tool, a: world, b: world };
      this._input = { mode: 'measure', start: world, active: true };
      this._drawMeasure();
    },
    _measureMove(world) { if (this._measure) { this._measure.b = world; this._drawMeasure(); } },
    // A labelled card in screen units: rows of [text, cls]
    // ...placed beside the point on whichever side the screen has room for
    _measureCard(parent, pos, rows, cls) {
      const g = this._screenGroup(parent, pos, 'war-measure-card ' + (cls || ''));
      const w = Math.max(...rows.map(r => r[0].length * (r[1] === 'big' ? 7 : 6.2))) + 18, h = rows.length * 14 + 10;
      let x = 12, y = -h - 6;
      const host = GameMap.overWorld || GameMap.world, wrap = document.getElementById('map-wrap');
      const ctm = host && host.getScreenCTM && host.getScreenCTM();
      if (ctm && wrap) {
        const sx = pos[0] * ctm.a + ctm.e, sy = pos[1] * ctm.d + ctm.f, r = wrap.getBoundingClientRect();
        if (sx + x + w > r.right - 24) x = -12 - w;
        if (sy + y < r.top + 24) y = 10;
      }
      sv('rect', { x, y, width: w.toFixed(1), height: h, rx: 2, class: 'war-measure-box' }, g);
      rows.forEach((r, i) => { const t = sv('text', { x: x + 9, y: (y + 17 + i * 14), class: 'war-measure-text ' + (r[1] || '') }, g); t.textContent = r[0]; });
      return g;
    },
    _drawMeasure() {
      const layer = this._O && this._O.measure;
      if (!layer) return;
      clear(layer);
      const m = this._measure;
      if (!m) return;
      const kpp = kmPerPx();
      const dpx = Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]);
      const km = dpx * kpp;
      if (dpx < 1) return;
      const war = this.activeAuth();
      const secs = this._tickSeconds(war);
      if (m.kind === 'ruler') {
        sv('line', { x1: m.a[0], y1: m.a[1], x2: m.b[0], y2: m.b[1], class: 'war-ruler-case', 'vector-effect': 'non-scaling-stroke' }, layer);
        sv('line', { x1: m.a[0], y1: m.a[1], x2: m.b[0], y2: m.b[1], class: 'war-ruler-line', 'vector-effect': 'non-scaling-stroke' }, layer);
        // graduations every round step (~40 px apart on screen)
        const px = this._screenScale();
        const stepKm = niceKm(Math.max(1, 40 * px * kpp));
        const ux = (m.b[0] - m.a[0]) / dpx, uy = (m.b[1] - m.a[1]) / dpx;
        let d = '';
        for (let s = 0, i = 0; s <= km + 1e-6; s += stepKm, i++) {
          const p = s / kpp, cx = m.a[0] + ux * p, cy = m.a[1] + uy * p, len = (i % 2 ? 4 : 8) * px;
          d += `M${(cx - uy * len).toFixed(1)} ${(cy + ux * len).toFixed(1)} L${(cx + uy * len).toFixed(1)} ${(cy - ux * len).toFixed(1)} `;
        }
        sv('path', { d, class: 'war-ruler-ticks', 'vector-effect': 'non-scaling-stroke' }, layer);
        for (const p of [m.a, m.b]) sv('circle', { cx: p[0], cy: p[1], r: 3.5 * px, class: 'war-ruler-end' }, layer);
        const bearing = (Math.atan2(m.b[0] - m.a[0], -(m.b[1] - m.a[1])) * 180 / Math.PI + 360) % 360;
        const t = (speed) => fmtDur(dpx / speed * secs);
        const roadMult = (window.WarEngine && WarEngine.ROAD_SPEED_MULT) || 5;
        this._measureCard(layer, m.b, [
          [fmtKm(km) + ' · bearing ' + String(Math.round(bearing)).padStart(3, '0') + '°', 'big'],
          [`infantry ${t(3.2)} · armour ${t(4.6)}`],
          [`by road ${t(3.2 * roadMult)} · by air ${t(226)}`],
          [`${this.gridRef(m.a)} → ${this.gridRef(m.b)}`, 'faint']
        ]);
      } else {
        sv('circle', { cx: m.a[0], cy: m.a[1], r: dpx.toFixed(1), class: 'war-range-ring', 'vector-effect': 'non-scaling-stroke' }, layer);
        sv('line', { x1: m.a[0], y1: m.a[1], x2: m.b[0], y2: m.b[1], class: 'war-range-radius', 'vector-effect': 'non-scaling-stroke' }, layer);
        sv('circle', { cx: m.a[0], cy: m.a[1], r: 3.5 * this._screenScale(), class: 'war-ruler-end' }, layer);
        const pred = war && ((window.WarEngine && this.predictedDoc(war)) || war);
        const side = pred && this.commandableSide(pred);
        let mine = 0, foes = 0;
        for (const u of (pred ? pred.units : [])) {
          if (u.dead || !(u.strength > 0) || Math.hypot(u.pos[0] - m.a[0], u.pos[1] - m.a[1]) > dpx) continue;
          if (side && u.side === side) mine++; else if (side) foes++; else mine++;
        }
        const cities = (S().cities || []).filter(c => c.pos && Math.hypot(c.pos[0] - m.a[0], c.pos[1] - m.a[1]) <= dpx).length;
        this._measureCard(layer, m.b, [
          [fmtKm(km) + ' radius', 'big'],
          [side ? `${foes} enemy · ${mine} friendly units inside` : `${mine} units inside`],
          [`${cities} cit${cities === 1 ? 'y' : 'ies'} · ${Math.round(Math.PI * km * km).toLocaleString('en-US')} km²`]
        ]);
      }
    },

    /* ---------- troop movement: trails and route readouts ---------- */
    // One breadcrumb per tick a unit actually moved (predicted doc), so a
    // trail shows where a column has come from for the last few ticks.
    _sampleTrails(war, key) {
      this._trails = this._trails || {};
      this._trailTick = this._trailTick || {};
      if (this._trailTick[key] === war.tick) return;
      this._trailTick[key] = war.tick;
      const live = new Set();
      for (const u of war.units || []) {
        if (u.dead || u.state === 'dead' || !(u.strength > 0)) continue;
        const k = key + ':' + u.id;
        live.add(k);
        const t = this._trails[k] || (this._trails[k] = []);
        const last = t[t.length - 1];
        if (!last || Math.hypot(last[0] - u.pos[0], last[1] - u.pos[1]) > 3) {
          t.push([u.pos[0], u.pos[1]]);
          if (t.length > TRAIL_POINTS) t.shift();
        } else if (t.length > 1) t.shift(); // standing still: the trail fades out behind it
      }
      for (const k in this._trails) if (k.startsWith(key + ':') && !live.has(k)) delete this._trails[k];
    },
    _renderTrails(war, key, parent) {
      if (!this._trails) return;
      for (const u of war.units || []) {
        const t = this._trails[key + ':' + u.id];
        if (!t || t.length < 2 || u.dead || !(u.strength > 0)) continue;
        sv('path', { d: 'M' + t.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L'),
          class: 'war-trail war-trail-' + u.side, 'vector-effect': 'non-scaling-stroke' }, parent);
      }
    },
    // remaining route length (px) and an arrival estimate (seconds)
    routeEta(war, u) {
      if (!u || !u.dest) return null;
      const pts = [u.pos];
      let roadPx = 0;
      if (Array.isArray(u.path) && u.path.length) {
        for (let i = (u.pathIdx || 0); i < u.path.length; i++) { const a = pts[pts.length - 1]; roadPx += Math.hypot(u.path[i][0] - a[0], u.path[i][1] - a[1]); pts.push(u.path[i]); }
      }
      const a = pts[pts.length - 1];
      const offPx = Math.hypot(u.dest[0] - a[0], u.dest[1] - a[1]);
      const speed = u.speed > 0 ? u.speed : ((window.WarEngine && WarEngine.DEF_MOVE_SPEED) || 3.2);
      const roadMult = (window.WarEngine && WarEngine.ROAD_SPEED_MULT) || 5;
      const ticks = roadPx / (speed * roadMult) + offPx / speed;
      return { px: roadPx + offPx, secs: ticks * this._tickSeconds(war) };
    },
    _renderRouteLabels(war, parent) {
      const sel = [...this._sel].map(id => war.units.find(x => x.id === id)).filter(u => u && u.dest && !u.dead);
      if (!sel.length || sel.length > 8) return;
      // one label per destination: units sent to the same point share it
      // (the farthest one's distance and the last arrival)
      const groups = new Map();
      for (const u of sel) {
        const r = this.routeEta(war, u);
        if (!r || r.px < 8) continue;
        const k = Math.round(u.dest[0] / 12) + ',' + Math.round(u.dest[1] / 12);
        const gq = groups.get(k);
        if (gq) { gq.n++; gq.px = Math.max(gq.px, r.px); gq.secs = Math.max(gq.secs, r.secs); }
        else groups.set(k, { dest: u.dest, n: 1, px: r.px, secs: r.secs });
      }
      for (const r of groups.values()) {
        const g = this._screenGroup(parent, r.dest, 'war-route-label');
        const text = (r.n > 1 ? `${r.n} units · ` : '') + `${fmtKm(r.px * kmPerPx())} · ${fmtDur(r.secs)}`;
        sv('rect', { x: 8, y: -21, width: (text.length * 6 + 12).toFixed(0), height: 15, rx: 2, class: 'war-route-box' }, g);
        const t = sv('text', { x: 14, y: -10, class: 'war-route-text' }, g); t.textContent = text;
      }
    }
  });
})();
