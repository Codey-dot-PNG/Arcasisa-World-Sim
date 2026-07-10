'use strict';
/* Interactive map. SVG world on the 3840×2160 master-map grid, smooth
   pan/zoom, data-driven layers. Everything drawn here comes from state:
   settings.map (foreign countries, text labels, roads, railways),
   provinces (SVG shapes), cities and properties (markers).
   GM editing of labels/roads/rails lives in mapedit.js. */

const GameMap = {
  ready: false,
  VIEW: { w: 3840, h: 2160 },
  // fixed world-unit scale for texture buildings — constant at every zoom
  TEX_SCALE: 0.7,
  view: { x: 0, y: 0, k: 1 },
  svg: null, world: null, markerLayer: null, cityLayer: null, editLayer: null,
  drag: null,

  mount(container) {
    clear(container);
    const wrap = el('div#map-wrap');
    container.appendChild(wrap);

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('id', 'map-svg');
    this.svg.setAttribute('viewBox', `0 0 ${this.VIEW.w} ${this.VIEW.h}`);
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    wrap.appendChild(this.svg);

    // controls
    wrap.appendChild(el('div#map-controls',
      el('button', { title: 'Zoom in', onclick: () => this.zoomBy(1.5) }, '+'),
      el('button', { title: 'Zoom out', onclick: () => this.zoomBy(1 / 1.5) }, '−'),
      el('button', { title: 'Reset view', onclick: () => this.reset() }, '⌂')
    ));
    wrap.appendChild(el('div#map-layerbar'));
    wrap.appendChild(el('div#map-legend'));
    wrap.appendChild(el('div#map-compass', el('div.n', 'N'), el('div', '▲')));

    this.bindPanZoom(wrap);
    this.ready = true;
    this.reset(true);
    this.render();
  },

  reset(silent) {
    // frame the island with its neighbours, whatever the window shape
    const R = { x: 560, y: 80, w: 2340, h: 2040 }; // Arcasia + nearby coasts
    let view = { x: -375, y: -170, k: 1.22 };
    const w = this.svg.clientWidth, h = this.svg.clientHeight;
    this._fitted = !!(w && h); // false while the app shell is still hidden
    if (w && h) {
      const s0 = Math.max(w / this.VIEW.w, h / this.VIEW.h); // slice scale
      const vw = w / s0, vh = h / s0;                        // visible viewBox units
      const k = Math.min(32, Math.max(0.55, Math.min(vw / R.w, vh / R.h)));
      view = { k, x: this.VIEW.w / 2 - (R.x + R.w / 2) * k, y: this.VIEW.h / 2 - (R.y + R.h / 2) * k };
    }
    this.view = view;
    if (!silent) this.applyTransform();
  },

  editing() { return !!(window.MapEdit && MapEdit.active); },

  /* ---------- pan & zoom ---------- */
  clientToWorld(cx, cy) {
    const pt = this.svg.createSVGPoint();
    pt.x = cx; pt.y = cy;
    const sp = pt.matrixTransform(this.svg.getScreenCTM().inverse());
    return [(sp.x - this.view.x) / this.view.k, (sp.y - this.view.y) / this.view.k];
  },
  bindPanZoom(wrap) {
    const svg = this.svg;
    // Two-finger pinch bookkeeping (touch). Live pointers are tracked so a
    // second finger switches panning into pinch-zoom. clientToSvgUnits maps a
    // screen point into the svg's user-unit system (independent of this.view,
    // which transforms the inner group), matching the wheel-zoom math.
    this.pointers = new Map();
    this.pinch = null;
    const clientToSvgUnits = (cx, cy) => {
      const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy;
      return pt.matrixTransform(svg.getScreenCTM().inverse());
    };
    const pinchDist = () => {
      const p = [...this.pointers.values()];
      return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    };
    const pinchMid = () => {
      const p = [...this.pointers.values()];
      return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
    };
    svg.addEventListener('pointerdown', (e) => {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        // second finger down — abandon any single-finger pan/click and pinch
        this.drag = null;
        this.lastDragMoved = true; // suppress the click that would otherwise fire on lift
        svg.classList.remove('dragging');
        const mid = pinchMid();
        this.pinch = { prevDist: pinchDist(), prevSp: clientToSvgUnits(mid.x, mid.y) };
        return;
      }
      if (this.pointers.size > 2) return;
      // capture is deferred to the first real move (see pointermove below):
      // capturing here unconditionally would re-target every click's
      // pointerup at the svg itself (per the Pointer Events spec), so a
      // plain click on a province/city/property never reaches its own
      // listener. Deferring lets an un-captured click hit the real target
      // while a genuine drag still captures once movement starts.
      this.drag = { sx: e.clientX, sy: e.clientY, ox: this.view.x, oy: this.view.y, moved: false, pid: e.pointerId };
      this.lastDragMoved = false;
    });
    svg.addEventListener('pointermove', (e) => {
      // ---- pinch-zoom (two fingers) ----
      if (this.pinch && this.pointers.has(e.pointerId)) {
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.pointers.size < 2) return;
        const mid = pinchMid();
        const sp = clientToSvgUnits(mid.x, mid.y);
        const dist = pinchDist();
        const k2 = Math.min(32, Math.max(0.55, this.view.k * (dist / this.pinch.prevDist)));
        // zoom about the current midpoint, then pan by how far it travelled
        this.view.x = sp.x - (sp.x - this.view.x) * (k2 / this.view.k);
        this.view.y = sp.y - (sp.y - this.view.y) * (k2 / this.view.k);
        this.view.k = k2;
        this.view.x += sp.x - this.pinch.prevSp.x;
        this.view.y += sp.y - this.pinch.prevSp.y;
        this.pinch.prevDist = dist;
        this.pinch.prevSp = sp;
        this.applyTransform();
        return;
      }
      if (!this.drag || e.pointerId !== this.drag.pid) return;
      // belt & braces: if the button was released outside the window we never
      // saw the pointerup — the buttons bitmask being 0 means nothing is held.
      if (e.buttons === 0) { this.endDrag(); return; }
      if (!this.drag.moved && Math.abs(e.clientX - this.drag.sx) + Math.abs(e.clientY - this.drag.sy) > 4) {
        this.drag.moved = true;
        try { svg.setPointerCapture(this.drag.pid); } catch (err) { /* pointer already gone */ }
        svg.classList.add('dragging');
      }
      if (!this.drag.moved) return;
      const ctm = svg.getScreenCTM();
      const dx = (e.clientX - this.drag.sx) / ctm.a;
      const dy = (e.clientY - this.drag.sy) / ctm.d;
      this.view.x = this.drag.ox + dx;
      this.view.y = this.drag.oy + dy;
      this.applyTransform();
    });
    // End the drag from a WINDOW-level capture listener: children clickable
    // elements call stopPropagation() in their own pointerup, which would stop
    // the svg's bubble-phase listener from ever clearing this.drag — leaving
    // the next pointermove panning with no button held. A capture-phase
    // listener on window runs before any target/bubble handler, so no
    // stopPropagation can bypass it. It records whether we panned into
    // lastDragMoved (read by child click handlers, which fire afterwards).
    // mount() re-runs bindPanZoom on every visit to the map, but svg-scoped
    // listeners die with the recreated svg. Window listeners would pile up, so
    // bind them exactly once against the GameMap singleton.
    if (!this._winPanBound) {
      const endFromWindow = (e) => {
        // drop the lifted finger; end an active pinch once fewer than two remain
        if (this.pointers && e.pointerId !== undefined) this.pointers.delete(e.pointerId);
        if (this.pinch && (!this.pointers || this.pointers.size < 2)) this.pinch = null;
        if (!this.drag) return;
        if (e.pointerId !== undefined && this.drag.pid !== undefined && e.pointerId !== this.drag.pid) return;
        this.endDrag();
      };
      window.addEventListener('pointerup', endFromWindow, true);
      window.addEventListener('pointercancel', endFromWindow, true);
      this._winPanBound = true;
    }
    // The map-click action (place / edit) stays on the svg's own bubble-phase
    // pointerup so a child's stopPropagation still suppresses it. By now the
    // window-capture handler has already cleared this.drag and set
    // lastDragMoved, so consult that flag to tell a click from a pan.
    svg.addEventListener('pointerup', (e) => {
      if (this.lastDragMoved) return;
      if (W.placing) {
        const [wx, wy] = this.clientToWorld(e.clientX, e.clientY);
        const cb = W.placing.cb;
        this.setPlacing(null);
        cb([Math.round(wx), Math.round(wy)]);
      } else if (this.editing()) {
        MapEdit.mapClick(this.clientToWorld(e.clientX, e.clientY), e);
      }
    });
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const pt = this.svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const sp = pt.matrixTransform(this.svg.getScreenCTM().inverse());
      const k2 = Math.min(32, Math.max(0.55, this.view.k * Math.exp(-e.deltaY * 0.0014)));
      this.view.x = sp.x - (sp.x - this.view.x) * (k2 / this.view.k);
      this.view.y = sp.y - (sp.y - this.view.y) * (k2 / this.view.k);
      this.view.k = k2;
      this.applyTransform();
    }, { passive: false });
    svg.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (this.editing() && MapEdit.dblclick()) return;
      this.zoomBy(1.6);
    });
  },
  zoomBy(f) {
    const k2 = Math.min(32, Math.max(0.55, this.view.k * f));
    // zoom about viewBox centre
    const cx = this.VIEW.w / 2, cy = this.VIEW.h / 2;
    this.view.x = cx - (cx - this.view.x) * (k2 / this.view.k);
    this.view.y = cy - (cy - this.view.y) * (k2 / this.view.k);
    this.view.k = k2;
    this.applyTransform();
  },
  focus(pos, minK) {
    const targetK = Math.max(this.view.k, minK || 8);
    const from = { ...this.view };
    const to = { k: targetK, x: this.VIEW.w / 2 - pos[0] * targetK, y: this.VIEW.h / 2 - pos[1] * targetK };
    const t0 = performance.now();
    const anim = (t) => {
      const u = Math.min(1, (t - t0) / 340);
      const ease = u * (2 - u);
      this.view.x = from.x + (to.x - from.x) * ease;
      this.view.y = from.y + (to.y - from.y) * ease;
      this.view.k = from.k + (to.k - from.k) * ease;
      this.applyTransform();
      if (u < 1) requestAnimationFrame(anim);
    };
    requestAnimationFrame(anim);
  },
  applyTransform() {
    if (!this.world) return;
    this.world.setAttribute('transform', `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
    this.updateMarkerScale();
  },

  /* ---------- layers ---------- */
  permittedLayers() {
    const l = perms().mapLayers || [];
    const out = [];
    if (l.includes('political')) out.push({ id: 'political', label: 'Political' });
    if (l.includes('data') && perms().statistics) out.push({ id: 'data', label: 'Data' });
    if (l.includes('ownership')) out.push({ id: 'ownership', label: 'Ownership' });
    if (!out.length) out.push({ id: 'plain', label: 'Terrain' });
    return out;
  },

  provFill(p) {
    if (W.layer === 'data') {
      const vals = S().provinces.map(x => Number(x.vars[W.dataVar]) || 0);
      const min = Math.min(...vals), max = Math.max(...vals);
      const t = max > min ? ((Number(p.vars[W.dataVar]) || 0) - min) / (max - min) : 0.5;
      return { fill: 'rgb(122,35,24)', opacity: 0.14 + t * 0.62 };
    }
    if (W.layer === 'ownership' || W.layer === 'plain') return { fill: 'var(--paper-deep)', opacity: 0.94 };
    return { fill: p.color || 'var(--paper-deep)', opacity: 0.9 };
  },

  /* ---------- isometric building glyphs ----------
     Small pseudo-3D block clusters standing in for each property kind, in the
     spirit of the little white extruded buildings on the reference clippings
     (Newspaper examples/Isometric reference buildings.png). Pure SVG, no
     assets: every box is three polygons (top / left-wall / right-wall) built
     from a fixed isometric basis so they all read as the same "camera angle".
     Walls stay paper-white; only the roof (top face) picks up a faint tint
     of the owner's colour so ownership is still readable at a glance. */
  isoBuilding(kind, color) {
    const NS = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'iso-building');
    // isometric basis: ground-plane "right" and "left" edge vectors (both
    // point downward on screen, since screen y grows down); "up" is
    // simply -y. A box's footprint is the diamond bx,by ± R ± L.
    const RX = 0.87, RY = 0.5, LX = -0.87, LY = 0.5;
    const poly = (pts, cls) => {
      const p = document.createElementNS(NS, 'polygon');
      p.setAttribute('points', pts.map(pt => pt.join(',')).join(' '));
      p.setAttribute('class', cls);
      return p;
    };
    // One box: (bx,by) is the footprint centre at ground level; hw/hd are
    // the half-width/half-depth (iso units) of the footprint diamond; h is
    // the wall height in screen px. Only the roof takes the owner tint.
    const box = (bx, by, hw, hd, h, roofTint) => {
      const rx = RX * hw, ry = RY * hw;
      const lx = LX * hd, ly = LY * hd;
      const N = [bx, by - ry - ly];           // far ground corner
      const S = [bx, by + ry + ly];           // near ground corner
      const Wc = [bx - rx + lx, by - ry + ly]; // left ground corner
      const Ec = [bx + rx - lx, by + ry - ly]; // right ground corner
      const up = (pt) => [pt[0], pt[1] - h];
      const Nt = up(N), St = up(S), Wt = up(Wc), Et = up(Ec);
      const bg = document.createElementNS(NS, 'g');
      bg.appendChild(poly([Nt, Et, St, Wt], 'iso-top'));      // roof parallelogram
      bg.appendChild(poly([Wc, Wt, St, S], 'iso-front'));     // left-facing wall (mid tone)
      bg.appendChild(poly([S, St, Et, Ec], 'iso-side'));      // right-facing wall (darkest)
      if (roofTint) bg.querySelector('.iso-top').style.fill = roofTint;
      return bg;
    };
    const roofTint = color || 'var(--ink-soft)';
    switch (kind) {
      case 'factory': {
        g.appendChild(box(-6, 6, 17, 11, 15, roofTint));
        g.appendChild(box(10, -3, 4, 4, 28, roofTint)); // chimney
        break;
      }
      case 'office': {
        g.appendChild(box(0, 5, 10, 10, 40, roofTint));
        break;
      }
      case 'bank': {
        g.appendChild(box(0, 7, 16, 13, 18, roofTint));
        g.appendChild(box(0, -2, 8, 7, 12, roofTint)); // portico block on top
        break;
      }
      case 'government': {
        g.appendChild(box(0, 7, 17, 14, 17, roofTint));
        g.appendChild(box(0, -1, 7, 6, 16, roofTint)); // small dome/attic block
        break;
      }
      case 'university': {
        g.appendChild(box(-5, 7, 14, 11, 16, roofTint));
        g.appendChild(box(11, 1, 5, 5, 25, roofTint)); // bell tower
        break;
      }
      case 'house': {
        const bx = 0, by = 9, hw = 12, hd = 10, h = 14;
        g.appendChild(box(bx, by, hw, hd, h, null)); // white walls, no roof tint on the box itself
        // simple prism/gable roof sitting on top of the box
        const rx = RX * hw, ry = RY * hw, lx = LX * hd, ly = LY * hd;
        const Wc = [bx - rx + lx, by - ry + ly - h];
        const Ec = [bx + rx - lx, by + ry - ly - h];
        const N = [bx, by - ry - ly - h];
        const S = [bx, by + ry + ly - h];
        const ridge = 9;
        const apexN = [N[0], N[1] - ridge];
        const apexS = [S[0], S[1] - ridge];
        g.appendChild(poly([Wc, apexN, apexS, S], 'iso-front iso-roof'));
        g.appendChild(poly([S, apexS, apexN, Ec], 'iso-side iso-roof'));
        g.appendChild(poly([Wc, N, apexN], 'iso-top iso-roof'));
        g.appendChild(poly([N, Ec, apexN], 'iso-top iso-roof'));
        if (roofTint) for (const n of g.querySelectorAll('.iso-roof')) n.style.fill = roofTint;
        break;
      }
      case 'military_base':
      case 'military': {
        g.appendChild(box(-8, 8, 13, 9, 9, roofTint));
        g.appendChild(box(9, 6, 8, 8, 7, roofTint));
        break;
      }
      case 'fort': {
        // squat keep with four corner turrets
        g.appendChild(box(0, 7, 15, 13, 12, roofTint));
        g.appendChild(box(-13, 2, 3.4, 3.4, 18, roofTint));
        g.appendChild(box(13, 2, 3.4, 3.4, 18, roofTint));
        g.appendChild(box(-4, 14, 3.4, 3.4, 18, roofTint));
        g.appendChild(box(4, 14, 3.4, 3.4, 18, roofTint));
        break;
      }
      case 'port': {
        g.appendChild(box(-5, 10, 14, 10, 8, roofTint));
        // crane: a thin mast + angled jib, drawn as slim polygons
        const mastX = 11, mastY = 10;
        g.appendChild(poly([[mastX - 1.6, mastY], [mastX + 1.6, mastY], [mastX + 1.6, mastY - 34], [mastX - 1.6, mastY - 34]], 'iso-crane'));
        g.appendChild(poly([[mastX - 1.4, mastY - 33], [mastX + 1.4, mastY - 33], [mastX + 15, mastY - 27], [mastX + 13, mastY - 25]], 'iso-crane'));
        break;
      }
      case 'airport': {
        // runway strip hint, low and flat, behind the terminal block
        g.appendChild(poly([[-17, 15], [17, 15], [11, 21], [-11, 21]], 'iso-runway'));
        g.appendChild(box(-6, 8, 14, 8, 11, roofTint));
        break;
      }
      case 'mine': {
        g.appendChild(box(-3, 9, 12, 10, 8, roofTint));
        g.appendChild(box(9, 1, 3.4, 3.4, 24, roofTint)); // headframe tower
        break;
      }
      case 'farm': {
        g.appendChild(box(-5, 9, 12, 9, 8, roofTint));
        g.appendChild(box(9, 6, 3.6, 3.6, 17, roofTint)); // silo, approximated as a slim box
        break;
      }
      case 'infrastructure': {
        g.appendChild(box(0, 8, 14, 12, 10, roofTint));
        break;
      }
      default: {
        g.appendChild(box(0, 7, 15, 15, 18, roofTint));
      }
    }
    return g;
  },

  /* ---------- render ---------- */
  render() {
    if (!this.ready || !S()) return;
    // While a vertex/marker/label is being dragged in the editor, a sync
    // arriving mid-drag would replace the node the pointer is captured on and
    // strand the drag. Skip the render; MapEdit re-renders on pointerup.
    if (window.MapEdit && MapEdit.dragging) { this._renderQueued = true; return; }
    this._renderQueued = false;
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs, parent) => {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) if (attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
      (parent || this.world).appendChild(n);
      return n;
    };
    this.mk = mk;
    if (!this._fitted) this.reset(true); // first visible render: fit the island
    clear(this.svg);
    this.world = document.createElementNS(NS, 'g');
    this.svg.appendChild(this.world);

    const map = S().settings.map || { countries: [], labels: [], roads: [], rails: [] };
    const editing = this.editing();
    const ptsStr = (pts) => pts.map(p => p.join(',')).join(' ');
    const title = (node, text) => {
      const t = document.createElementNS(NS, 'title');
      t.textContent = text;
      node.appendChild(t);
    };

    // ocean, graticule and the map boundary frame
    mk('rect', { x: -8000, y: -8000, width: this.VIEW.w + 16000, height: this.VIEW.h + 16000, class: 'map-ocean' });
    for (let x = 0; x <= this.VIEW.w; x += 320) mk('line', { x1: x, y1: -1400, x2: x, y2: this.VIEW.h + 1400, class: 'graticule' });
    for (let y = -1280; y <= this.VIEW.h + 1280; y += 320) mk('line', { x1: -1400, y1: y, x2: this.VIEW.w + 1400, y2: y, class: 'graticule' });
    mk('rect', { x: 0, y: 0, width: this.VIEW.w, height: this.VIEW.h, class: 'map-frame' });

    // foreign powers — international borders in their shades of grey
    this.countryNodes = {};
    for (const c of (map.countries || [])) {
      if (!c.shape) continue;
      const node = mk('path', { d: c.shape, 'fill-rule': 'evenodd', class: 'country-shape', fill: c.fill || '#a8a196', 'vector-effect': 'non-scaling-stroke' });
      node.addEventListener('pointerup', (e) => {
        if (this.dragMoved() || W.placing || this.editing()) return;
        e.stopPropagation();
        if (c.entityId && entById(c.entityId)) select('entity', c.entityId, { noPan: true });
        else toast(c.name + ' — no dossier on file.');
      });
      title(node, c.name);
      if (c.entityId) this.countryNodes[c.entityId] = node;
    }

    // island drop shadow, then the provinces themselves
    for (const p of S().provinces) {
      if (p.shape) mk('path', { d: p.shape, 'fill-rule': 'evenodd', fill: 'rgba(24,26,30,0.3)', transform: 'translate(9,12)' });
      else if (p.path && p.path.length > 2) mk('polygon', { points: ptsStr(p.path), fill: 'rgba(24,26,30,0.3)', transform: 'translate(9,12)' });
    }
    this.provNodes = {};
    for (const p of S().provinces) {
      const f = this.provFill(p);
      let poly = null;
      if (p.shape) poly = mk('path', { d: p.shape, 'fill-rule': 'evenodd', class: 'prov-shape', fill: f.fill, 'fill-opacity': f.opacity, 'vector-effect': 'non-scaling-stroke' });
      else if (p.path && p.path.length > 2) poly = mk('polygon', { points: ptsStr(p.path), class: 'prov-shape', fill: f.fill, 'fill-opacity': f.opacity, 'vector-effect': 'non-scaling-stroke' });
      if (!poly) continue;
      poly.addEventListener('pointerup', (e) => {
        if (this.dragMoved() || W.placing || this.editing()) return;
        e.stopPropagation();
        select('province', p.id, { noPan: true });
      });
      title(poly, p.name);
      this.provNodes[p.id] = poly;
    }

    // transport — roads, then railways (casing + sleeper dashes)
    for (const r of (map.roads || [])) {
      if (!r.pts || r.pts.length < 2) continue;
      mk('polyline', { points: ptsStr(r.pts), class: 'map-road', 'vector-effect': 'non-scaling-stroke', 'data-mapedit': 'roads:' + r.id });
    }
    for (const r of (map.rails || [])) {
      if (!r.pts || r.pts.length < 2) continue;
      mk('polyline', { points: ptsStr(r.pts), class: 'map-rail-base', 'vector-effect': 'non-scaling-stroke', 'data-mapedit': 'rails:' + r.id });
      mk('polyline', { points: ptsStr(r.pts), class: 'map-rail-dash', 'vector-effect': 'non-scaling-stroke', 'data-mapedit': 'rails:' + r.id });
    }
    // wide invisible strokes so the pen tool can pick a line up easily
    if (editing && (MapEdit.mode === 'roads' || MapEdit.mode === 'rails')) {
      for (const r of (map[MapEdit.mode] || [])) {
        if (!r.pts || r.pts.length < 2) continue;
        const hit = mk('polyline', { points: ptsStr(r.pts), class: 'edit-hit', 'vector-effect': 'non-scaling-stroke' });
        hit.addEventListener('pointerup', (e) => {
          if (this.dragMoved() || MapEdit.drawing) return;
          e.stopPropagation();
          MapEdit.selectPath(MapEdit.mode, r.id);
        });
      }
    }

    // editable text markers (country names, seas, notes)
    for (const lbl of (map.labels || [])) {
      const canEdit = editing && MapEdit.mode === 'labels';
      const t = mk('text', {
        x: lbl.pos[0], y: lbl.pos[1],
        class: 'map-label map-label-' + (lbl.kind || 'note') + (canEdit ? ' editable' : '') + (canEdit && MapEdit.selLabel === lbl.id ? ' selected' : ''),
        'font-size': lbl.size || 40, 'text-anchor': 'middle',
        transform: lbl.rot ? `rotate(${lbl.rot} ${lbl.pos[0]} ${lbl.pos[1]})` : '',
        'data-label': lbl.id
      });
      t.textContent = lbl.text;
      if (canEdit) t.addEventListener('pointerdown', (e) => MapEdit.labelPointerDown(e, lbl.id));
    }

    // province names (+ data value when the data layer is active)
    for (const p of S().provinces) {
      if (!p.labelPos) continue;
      const size = p.labelSize || 46;
      const rot = p.labelRot ? `rotate(${p.labelRot} ${p.labelPos[0]} ${p.labelPos[1]})` : '';
      const t = mk('text', { x: p.labelPos[0], y: p.labelPos[1], class: 'prov-label', 'font-size': size, 'text-anchor': 'middle', transform: rot });
      t.textContent = p.name.toUpperCase();
      if (W.layer === 'data') {
        const vdef = (S().variables || []).find(v => v.scope === 'province' && v.key === W.dataVar);
        const st = mk('text', { x: p.labelPos[0], y: p.labelPos[1] + size * 0.72, class: 'prov-stat', 'font-size': Math.max(24, size * 0.34), 'text-anchor': 'middle', transform: rot });
        st.textContent = fmtVal(p.vars[W.dataVar], vdef ? vdef.format : 'number');
      }
    }

    // property markers (counter-scaled)
    this.markerLayer = document.createElementNS(NS, 'g');
    this.world.appendChild(this.markerLayer);
    this._tintDefs = null; this._tintFilters = {}; // per-render owner-tint filter cache
    for (const pr of S().properties) {
      if (!pr.pos) continue;
      const owner = entById(pr.ownerId);
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('data-marker', pr.id);
      g.setAttribute('data-x', pr.pos[0]); g.setAttribute('data-y', pr.pos[1]);
      // textured buildings render at a fixed map scale and never show the flat
      // square — flagged here so updateMarkerScale can treat them specially.
      if (pr.texture) g.setAttribute('data-textured', '1');
      const rect = document.createElementNS(NS, 'rect');
      if (pr.texture) {
        // invisible hit target sized to the building art (never drawn), so the
        // whole structure is clickable / draggable
        rect.setAttribute('x', -40); rect.setAttribute('y', -84);
        rect.setAttribute('width', 80); rect.setAttribute('height', 98);
      } else {
        rect.setAttribute('x', -17.6); rect.setAttribute('y', -17.6);
        rect.setAttribute('width', 35.2); rect.setAttribute('height', 35.2);
      }
      rect.setAttribute('class', 'prop-marker');
      rect.setAttribute('fill', owner ? owner.color || '#5c5340' : '#5c5340');
      if (W.selection && W.selection.kind === 'property' && W.selection.id === pr.id) rect.classList.add('selected');
      const draggableHere = editing && MapEdit.mode === 'properties';
      if (draggableHere) rect.classList.add('edit-draggable');
      rect.addEventListener('pointerdown', (e) => {
        if (!draggableHere) return;
        e.stopPropagation();
        MapEdit.propertyPointerDown(e, pr, g);
      });
      rect.addEventListener('pointerup', (e) => {
        if (draggableHere || this.dragMoved() || W.placing || this.editing()) return;
        e.stopPropagation();
        select('property', pr.id, { noPan: true });
      });
      title(rect, `${pr.name} — ${owner ? owner.name : 'unowned'}`);
      // an assigned SVG icon replaces the letter glyph on the flat marker
      let glyph;
      if (pr.icon && typeof ICON_MANIFEST !== 'undefined' && ICON_MANIFEST.includes(pr.icon)) {
        glyph = document.createElementNS(NS, 'image');
        glyph.setAttribute('class', 'prop-glyph prop-icon');
        glyph.setAttribute('href', iconHref(pr.icon));
        glyph.setAttributeNS('http://www.w3.org/1999/xlink', 'href', iconHref(pr.icon));
        glyph.setAttribute('width', 28); glyph.setAttribute('height', 28);
        glyph.setAttribute('x', -14); glyph.setAttribute('y', -14);
      } else {
        glyph = document.createElementNS(NS, 'text');
        glyph.setAttribute('class', 'prop-glyph');
        glyph.setAttribute('font-size', 25.6);
        glyph.setAttribute('text-anchor', 'middle');
        glyph.setAttribute('y', 9.6);
        glyph.textContent = KIND_GLYPH[pr.kind] || '•';
      }
      g.appendChild(rect); g.appendChild(glyph);
      // isometric building — shown instead of the flat square once zoomed in
      // close enough to read it (toggled in updateMarkerScale). The flat
      // rect stays in the DOM (and stays the pointerdown/pointerup target
      // for select + edit-drag) even while hidden, so none of the existing
      // interaction wiring above needs to change.
      // .iso-building is pointer-events:none (see style.css) so the
      // transparent .prop-marker rect underneath stays the sole hit target
      // and its <title> (set above) still supplies the hover tooltip.
      // A property with an assigned building texture (auto-picked per kind on
      // the server) renders that art instead of the procedural block set —
      // deliberately large so structures dominate the close-up map.
      let iso;
      if (pr.texture) {
        iso = document.createElementNS(NS, 'image');
        iso.setAttribute('class', 'iso-building tex-building');
        const href = '/assets/buildings/' + pr.texture;
        iso.setAttribute('href', href);
        iso.setAttributeNS('http://www.w3.org/1999/xlink', 'href', href);
        iso.setAttribute('width', 120); iso.setAttribute('height', 120);
        iso.setAttribute('x', -60); iso.setAttribute('y', -100); // art's feet stand on the map point
        iso.setAttribute('preserveAspectRatio', 'xMidYMax meet');
      } else {
        iso = this.isoBuilding(pr.kind, owner ? owner.color || '#5c5340' : '#5c5340');
      }
      iso.classList.add('iso-hidden');
      if (W.selection && W.selection.kind === 'property' && W.selection.id === pr.id) iso.classList.add('selected');
      g.appendChild(iso);
      // Ownership layer: the PNG building art carries no owner colour, so a
      // second copy of the same art is stamped over it, reduced to a solid
      // silhouette in the owner's colour (feFlood ∩ SourceAlpha) at partial
      // opacity — the structure stays readable, the colour matches the key.
      // Procedural (untextured) buildings already draw in the owner colour.
      if (pr.texture) {
        const tint = document.createElementNS(NS, 'image');
        tint.setAttribute('class', 'iso-building tex-building tex-tint');
        const href = '/assets/buildings/' + pr.texture;
        tint.setAttribute('href', href);
        tint.setAttributeNS('http://www.w3.org/1999/xlink', 'href', href);
        tint.setAttribute('width', 120); tint.setAttribute('height', 120);
        tint.setAttribute('x', -60); tint.setAttribute('y', -100);
        tint.setAttribute('preserveAspectRatio', 'xMidYMax meet');
        tint.setAttribute('filter', 'url(#' + this.tintFilterId(owner ? owner.color || '#5c5340' : '#5c5340') + ')');
        tint.setAttribute('opacity', '0.55');
        tint.classList.add('iso-hidden');
        g.appendChild(tint);
      }
      this.markerLayer.appendChild(g);
    }

    // cities
    this.cityLayer = document.createElementNS(NS, 'g');
    this.world.appendChild(this.cityLayer);
    for (const c of S().cities) {
      if (!c.pos) continue;
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('data-city', c.id);
      g.setAttribute('data-x', c.pos[0]); g.setAttribute('data-y', c.pos[1]);
      const r = c.size === 3 ? 14.7 : c.size === 2 ? 11.5 : 8.6;
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('r', r);
      dot.setAttribute('class', 'city-dot');
      if (W.selection && W.selection.kind === 'city' && W.selection.id === c.id) dot.classList.add('selected');
      dot.addEventListener('pointerup', (e) => {
        if (this.dragMoved() || W.placing || this.editing()) return;
        e.stopPropagation();
        select('city', c.id, { noPan: true });
      });
      title(dot, c.name);
      g.appendChild(dot);
      if (c.isCapital) {
        const ring = document.createElementNS(NS, 'circle');
        ring.setAttribute('r', r + 8.3);
        ring.setAttribute('class', 'city-ring');
        g.appendChild(ring);
      }
      const lbl = document.createElementNS(NS, 'text');
      lbl.setAttribute('class', 'city-label');
      lbl.setAttribute('x', r + 13);
      lbl.setAttribute('y', 9.6);
      lbl.textContent = (c.isCapital ? '★ ' : '') + c.name;
      g.appendChild(lbl);
      this.cityLayer.appendChild(g);
    }

    // event markers (counter-scaled pins — visible to everyone)
    this.eventLayer = document.createElementNS(NS, 'g');
    this.world.appendChild(this.eventLayer);
    for (const mrk of (S().markers || [])) {
      if (!mrk.pos) continue;
      const editingHere = editing && MapEdit.mode === 'markers';
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('data-eventmarker', mrk.id);
      g.setAttribute('data-x', mrk.pos[0]); g.setAttribute('data-y', mrk.pos[1]);
      const circ = document.createElementNS(NS, 'circle');
      circ.setAttribute('r', 20);
      circ.setAttribute('class', 'event-marker' + (editingHere ? ' edit-draggable' : ''));
      if (W.selection && W.selection.kind === 'marker' && W.selection.id === mrk.id) circ.classList.add('selected');
      circ.addEventListener('pointerdown', (e) => {
        if (!editingHere) return;
        e.stopPropagation();
        MapEdit.markerPointerDown(e, mrk, g);
      });
      circ.addEventListener('pointerup', (e) => {
        if (editingHere || this.dragMoved() || W.placing || this.editing()) return;
        e.stopPropagation();
        select('marker', mrk.id, { noPan: true });
      });
      title(circ, mrk.title || 'Event marker');
      let glyph;
      if (mrk.icon && typeof ICON_MANIFEST !== 'undefined' && ICON_MANIFEST.includes(mrk.icon)) {
        glyph = document.createElementNS(NS, 'image');
        glyph.setAttribute('class', 'event-glyph event-icon');
        glyph.setAttribute('href', iconHref(mrk.icon));
        glyph.setAttributeNS('http://www.w3.org/1999/xlink', 'href', iconHref(mrk.icon));
        glyph.setAttribute('width', 26); glyph.setAttribute('height', 26);
        glyph.setAttribute('x', -13); glyph.setAttribute('y', -13);
      } else {
        glyph = document.createElementNS(NS, 'text');
        glyph.setAttribute('class', 'event-glyph');
        glyph.setAttribute('font-size', 22);
        glyph.setAttribute('text-anchor', 'middle');
        glyph.setAttribute('y', 8);
        glyph.textContent = (mrk.icon && mrk.icon.length <= 3) ? mrk.icon : '◈';
      }
      g.appendChild(circ); g.appendChild(glyph);
      const lbl = document.createElementNS(NS, 'text');
      lbl.setAttribute('class', 'event-label');
      lbl.setAttribute('x', 27); lbl.setAttribute('y', 7);
      lbl.textContent = mrk.title || '';
      g.appendChild(lbl);
      this.eventLayer.appendChild(g);
    }

    // war overlay (territory fracture, unit markers, battle flashes) — drawn
    // above cities/markers so the front line is never hidden underneath them
    this.warLayer = null;
    if (window.War) War.renderMapLayer(this, mk, NS);

    // GM pen-tool overlay (vertex handles, in-progress lines)
    this.editLayer = null;
    if (editing) MapEdit.renderOverlay(this);

    this.renderLayerBar();
    this.renderLegend();
    this.applyTransform();
  },

  // One <filter> per owner colour, created lazily inside the marker layer
  // (rebuilt every render, so ids never go stale). feFlood ∩ SourceAlpha turns
  // the building PNG into a solid silhouette of the owner's colour.
  tintFilterId(color) {
    const NS = 'http://www.w3.org/2000/svg';
    const key = String(color || '').replace(/[^a-zA-Z0-9]/g, '') || 'default';
    this._tintFilters = this._tintFilters || {};
    if (this._tintFilters[key]) return this._tintFilters[key];
    if (!this._tintDefs) {
      this._tintDefs = document.createElementNS(NS, 'defs');
      this.markerLayer.appendChild(this._tintDefs);
    }
    const id = 'owner-tint-' + key;
    const f = document.createElementNS(NS, 'filter');
    f.setAttribute('id', id);
    f.setAttribute('x', '-10%'); f.setAttribute('y', '-10%');
    f.setAttribute('width', '120%'); f.setAttribute('height', '120%');
    const flood = document.createElementNS(NS, 'feFlood');
    flood.setAttribute('flood-color', color || '#5c5340');
    const comp = document.createElementNS(NS, 'feComposite');
    comp.setAttribute('in2', 'SourceAlpha');
    comp.setAttribute('operator', 'in');
    f.appendChild(flood); f.appendChild(comp);
    this._tintDefs.appendChild(f);
    this._tintFilters[key] = id;
    return id;
  },

  // Called from the window-level pointerup/pointercancel capture listeners and
  // the buttons===0 guard. Records the moved state (child click handlers read
  // lastDragMoved right after) and clears the drag so no phantom pan follows.
  endDrag() {
    this.lastDragMoved = !!(this.drag && this.drag.moved);
    this.drag = null;
    if (this.svg) this.svg.classList.remove('dragging');
  },

  dragMoved() { return this.lastDragMoved; },

  updateMarkerScale() {
    const k = this.view.k;
    const showProps = k >= 6.7 || W.layer === 'ownership' || (this.editing() && MapEdit.mode === 'properties');
    if (this.markerLayer) {
      for (const g of this.markerLayer.children) {
        const x = g.getAttribute('data-x'), y = g.getAttribute('data-y');
        // Textured buildings are locked to the map: one fixed world-unit scale
        // at every zoom level (no counter-scaling), and the texture is always
        // shown — the flat square is never used for them.
        if (g.getAttribute('data-textured') === '1') {
          g.setAttribute('transform', `translate(${x},${y}) scale(${this.TEX_SCALE})`);
          const rect = g.querySelector('.prop-marker');
          const glyph = g.querySelector('.prop-glyph');
          const iso = g.querySelector('.iso-building');
          if (iso) iso.classList.remove('iso-hidden');
          // owner-colour overlay reads only on the ownership layer
          const tint = g.querySelector('.tex-tint');
          if (tint) tint.classList.toggle('iso-hidden', W.layer !== 'ownership');
          if (rect) rect.style.opacity = '0';
          if (glyph) glyph.style.display = 'none';
          continue;
        }
        const sel = W.selection && W.selection.kind === 'property' && W.selection.id === g.getAttribute('data-marker');
        const shown = showProps || sel;
        const s = shown ? 1 / k : 0.32 / k;
        g.setAttribute('transform', `translate(${x},${y}) scale(${Math.max(s, 0.034)})`);
        const glyph = g.querySelector('.prop-glyph');
        const rect = g.querySelector('.prop-marker');
        const iso = g.querySelector('.iso-building');
        // Zoomed in (or ownership layer / property-edit mode): show the iso
        // building, hide the flat square + glyph. Zoomed out: flat square
        // reads better at tiny scale, so show that instead — including for
        // a selected-but-distant property, so the selection ring stays
        // visible even before the camera has zoomed in on it.
        // The rect is only made transparent (never display:none): it must
        // stay hit-testable for click-to-select and edit-mode dragging
        // (MapEdit.propertyPointerDown / the pointerup select() handler are
        // both wired to this exact node), even while the iso building is the
        // visible thing standing over it.
        const useIso = showProps;
        if (iso) iso.classList.toggle('iso-hidden', !useIso);
        if (rect) rect.style.opacity = useIso ? '0' : '1';
        if (glyph) glyph.style.display = (!useIso && shown) ? '' : 'none';
      }
    }
    if (this.cityLayer) {
      for (const g of this.cityLayer.children) {
        const x = g.getAttribute('data-x'), y = g.getAttribute('data-y');
        g.setAttribute('transform', `translate(${x},${y}) scale(${1 / Math.max(1, k * 0.72)})`);
      }
    }
    if (this.eventLayer) {
      for (const g of this.eventLayer.children) {
        const x = g.getAttribute('data-x'), y = g.getAttribute('data-y');
        g.setAttribute('transform', `translate(${x},${y}) scale(${1 / Math.max(1, k * 0.72)})`);
      }
    }
    if (this.editLayer) {
      for (const g of this.editLayer.children) {
        if (!g.hasAttribute('data-x')) continue;
        const x = g.getAttribute('data-x'), y = g.getAttribute('data-y');
        g.setAttribute('transform', `translate(${x},${y}) scale(${1 / k})`);
      }
    }
  },

  highlight() {
    if (!this.ready || !this.provNodes) return;
    for (const id in this.provNodes) this.provNodes[id].classList.toggle('selected', !!(W.selection && W.selection.kind === 'province' && W.selection.id === id));
    for (const id in (this.countryNodes || {})) this.countryNodes[id].classList.toggle('selected', !!(W.selection && W.selection.kind === 'entity' && W.selection.id === id));
    if (this.markerLayer) for (const g of this.markerLayer.children) {
      const isSel = !!(W.selection && W.selection.kind === 'property' && W.selection.id === g.getAttribute('data-marker'));
      const r = g.querySelector('.prop-marker');
      if (r) r.classList.toggle('selected', isSel);
      const iso = g.querySelector('.iso-building');
      if (iso) iso.classList.toggle('selected', isSel);
    }
    if (this.cityLayer) for (const g of this.cityLayer.children) {
      const d = g.querySelector('.city-dot');
      if (d) d.classList.toggle('selected', !!(W.selection && W.selection.kind === 'city' && W.selection.id === g.getAttribute('data-city')));
    }
    if (this.eventLayer) for (const g of this.eventLayer.children) {
      const c = g.querySelector('.event-marker');
      if (c) c.classList.toggle('selected', !!(W.selection && W.selection.kind === 'marker' && W.selection.id === g.getAttribute('data-eventmarker')));
    }
    this.updateMarkerScale();
  },

  renderLayerBar() {
    const bar = document.getElementById('map-layerbar');
    if (!bar) return;
    clear(bar);
    const layers = this.permittedLayers();
    if (!layers.some(l => l.id === W.layer)) W.layer = layers[0].id;
    for (const l of layers) {
      bar.appendChild(el('button.chip', { class: W.layer === l.id ? 'active' : '', onclick: () => { W.layer = l.id; this.render(); } }, l.label));
    }
    if (W.layer === 'data') {
      const sel = el('select', { onchange: (e) => { W.dataVar = e.target.value; this.render(); } });
      for (const v of (S().variables || []).filter(v => v.scope === 'province')) {
        sel.appendChild(el('option', { value: v.key, selected: v.key === W.dataVar ? 'selected' : undefined }, v.label));
      }
      bar.appendChild(sel);
    }
    if (W.placing) {
      bar.appendChild(el('span.chip', { style: 'border-color:var(--accent); color:var(--accent);' }, '⌖ CLICK MAP: ' + W.placing.label));
      bar.appendChild(el('button.chip', { onclick: () => this.setPlacing(null) }, 'cancel'));
    }
    if (window.MapEdit) MapEdit.toolbar(bar);
  },

  setPlacing(p) { W.placing = p; this.renderLayerBar(); },

  renderLegend() {
    const lg = document.getElementById('map-legend');
    if (!lg) return;
    clear(lg);
    if (W.legendHidden) {
      lg.classList.add('collapsed');
      lg.appendChild(el('button.chip', { onclick: () => { W.legendHidden = false; this.renderLegend(); } }, '☰ Show Key'));
      return;
    }
    lg.classList.remove('collapsed');
    lg.appendChild(el('button.icon-btn.lg-hide', { title: 'Hide key', onclick: () => { W.legendHidden = true; this.renderLegend(); } }, '✕'));
    if (W.layer === 'data') {
      const vdef = (S().variables || []).find(v => v.scope === 'province' && v.key === W.dataVar);
      lg.appendChild(el('div.lg-title', 'DATA LAYER — ' + (vdef ? vdef.label : W.dataVar)));
      const ramp = el('div', { style: 'height:8px; background:linear-gradient(90deg, rgba(122,35,24,.08), rgba(122,35,24,.68)); border:1px solid var(--rule-strong); margin:4px 0;' });
      lg.appendChild(ramp);
      const vals = S().provinces.map(x => Number(x.vars[W.dataVar]) || 0);
      lg.appendChild(el('div', { style: 'display:flex; justify-content:space-between;' },
        el('span', fmtCompact(Math.min(...vals))), el('span', fmtCompact(Math.max(...vals)))));
    } else if (W.layer === 'ownership') {
      lg.appendChild(el('div.lg-title', 'PROPERTY OWNERS'));
      // owners sorted by holdings, with counts; click a row to open the dossier
      const counts = new Map();
      for (const pr of S().properties) {
        if (!pr.ownerId || !entById(pr.ownerId)) continue;
        counts.set(pr.ownerId, (counts.get(pr.ownerId) || 0) + 1);
      }
      const owners = [...counts.entries()]
        .map(([id, n]) => ({ ent: entById(id), n }))
        .sort((a, b) => b.n - a.n || a.ent.name.localeCompare(b.ent.name));
      const MAXROWS = 14;
      owners.slice(0, MAXROWS).forEach(({ ent: o, n }) =>
        lg.appendChild(el('div.lg-row', { style: 'cursor:pointer;', title: 'Open dossier', onclick: () => select('entity', o.id) },
          el('span.lg-swatch', { style: 'background:' + (o.color || '#888') }),
          el('span', { style: 'flex:1;' }, o.name),
          el('span', { style: 'color:var(--ink-faint); font-family:var(--font-mono); font-size:9px; margin-left:6px;' }, String(n)))));
      if (owners.length > MAXROWS) {
        lg.appendChild(el('div', { style: 'color:var(--ink-faint); margin-top:2px;' }, '+' + (owners.length - MAXROWS) + ' more owners'));
      }
      const total = S().properties.length;
      lg.appendChild(el('div', { style: 'margin-top:6px; color:var(--ink-faint);' }, total + ' properties · click a name for its file'));
    } else {
      lg.appendChild(el('div.lg-title', S().settings.worldName.toUpperCase()));
      for (const p of S().provinces) {
        lg.appendChild(el('div.lg-row', el('span.lg-swatch', { style: 'background:' + (p.color || '#ccc') }), el('span', p.name)));
      }
      const countries = (S().settings.map || {}).countries || [];
      if (countries.length) {
        lg.appendChild(el('div.lg-title', { style: 'margin-top:8px;' }, 'FOREIGN POWERS'));
        for (const c of countries) {
          lg.appendChild(el('div.lg-row', el('span.lg-swatch', { style: 'background:' + c.fill }), el('span', c.name)));
        }
      }
      lg.appendChild(el('div', { style: 'margin-top:6px; color:var(--ink-faint);' }, 'zoom in for properties · ★ capital'));
    }
  }
};
