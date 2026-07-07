'use strict';
/* Interactive map. SVG world 1200×675, smooth pan/zoom, data-driven layers.
   Everything drawn here comes from state: provinces (polygons), cities,
   properties (markers), and settings.mapDecor (foreign coasts, roads, rails). */

const GameMap = {
  ready: false,
  view: { x: 0, y: 0, k: 1 },
  svg: null, world: null, markerLayer: null, cityLayer: null,
  drag: null,

  mount(container) {
    clear(container);
    const wrap = el('div#map-wrap');
    container.appendChild(wrap);

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('id', 'map-svg');
    this.svg.setAttribute('viewBox', '0 0 1200 675');
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
    // fit island with a little margin
    this.view = { x: -60, y: 20, k: 1.12 };
    if (!silent) this.applyTransform();
  },

  /* ---------- pan & zoom ---------- */
  clientToWorld(cx, cy) {
    const pt = this.svg.createSVGPoint();
    pt.x = cx; pt.y = cy;
    const sp = pt.matrixTransform(this.svg.getScreenCTM().inverse());
    return [(sp.x - this.view.x) / this.view.k, (sp.y - this.view.y) / this.view.k];
  },
  bindPanZoom(wrap) {
    const svg = this.svg;
    svg.addEventListener('pointerdown', (e) => {
      this.drag = { sx: e.clientX, sy: e.clientY, ox: this.view.x, oy: this.view.y, moved: false };
      svg.setPointerCapture(e.pointerId);
      svg.classList.add('dragging');
    });
    svg.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const ctm = svg.getScreenCTM();
      const dx = (e.clientX - this.drag.sx) / ctm.a;
      const dy = (e.clientY - this.drag.sy) / ctm.d;
      if (Math.abs(e.clientX - this.drag.sx) + Math.abs(e.clientY - this.drag.sy) > 4) this.drag.moved = true;
      this.view.x = this.drag.ox + dx;
      this.view.y = this.drag.oy + dy;
      this.applyTransform();
    });
    svg.addEventListener('pointerup', (e) => {
      const moved = this.drag && this.drag.moved;
      this.drag = null;
      svg.classList.remove('dragging');
      if (!moved && W.placing) {
        const [wx, wy] = this.clientToWorld(e.clientX, e.clientY);
        const cb = W.placing.cb;
        this.setPlacing(null);
        cb([Math.round(wx), Math.round(wy)]);
      }
    });
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const pt = this.svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const sp = pt.matrixTransform(this.svg.getScreenCTM().inverse());
      const k2 = Math.min(9, Math.max(0.7, this.view.k * Math.exp(-e.deltaY * 0.0014)));
      this.view.x = sp.x - (sp.x - this.view.x) * (k2 / this.view.k);
      this.view.y = sp.y - (sp.y - this.view.y) * (k2 / this.view.k);
      this.view.k = k2;
      this.applyTransform();
    }, { passive: false });
    svg.addEventListener('dblclick', (e) => { e.preventDefault(); this.zoomBy(1.6); });
  },
  zoomBy(f) {
    const k2 = Math.min(9, Math.max(0.7, this.view.k * f));
    // zoom about viewBox centre
    const cx = 600, cy = 337;
    this.view.x = cx - (cx - this.view.x) * (k2 / this.view.k);
    this.view.y = cy - (cy - this.view.y) * (k2 / this.view.k);
    this.view.k = k2;
    this.applyTransform();
  },
  focus(pos, minK) {
    const targetK = Math.max(this.view.k, minK || 2.6);
    const from = { ...this.view };
    const to = { k: targetK, x: 600 - pos[0] * targetK, y: 337 - pos[1] * targetK };
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
      return { fill: 'rgb(122,35,24)', opacity: 0.08 + t * 0.6 };
    }
    if (W.layer === 'ownership' || W.layer === 'plain') return { fill: 'var(--paper-deep)', opacity: 0.9 };
    return { fill: p.color || 'var(--paper-deep)', opacity: 0.55 };
  },

  /* ---------- render ---------- */
  render() {
    if (!this.ready || !S()) return;
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs, parent) => {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      (parent || this.world).appendChild(n);
      return n;
    };
    clear(this.svg);
    this.world = document.createElementNS(NS, 'g');
    this.svg.appendChild(this.world);

    // graticule
    for (let x = 0; x <= 1200; x += 100) mk('line', { x1: x, y1: -400, x2: x, y2: 1100, class: 'graticule' });
    for (let y = -300; y <= 1000; y += 100) mk('line', { x1: -400, y1: y, x2: 1600, y2: y, class: 'graticule' });

    const decor = S().settings.mapDecor || {};
    const ptsStr = (pts) => pts.map(p => p.join(',')).join(' ');

    // foreign landmasses + labels
    for (const land of (decor.lands || [])) {
      if (land.pts && land.pts.length > 2) mk('polygon', { points: ptsStr(land.pts), class: 'foreign-land' });
      if (land.label) {
        const t = mk('text', {
          x: land.label[0], y: land.label[1], class: 'foreign-label', 'font-size': 15,
          'text-anchor': 'middle', transform: land.rot ? `rotate(${land.rot} ${land.label[0]} ${land.label[1]})` : ''
        });
        t.textContent = land.name;
      }
    }
    for (const isl of (decor.islets || [])) {
      const [cx, cy] = isl.c, r = isl.r;
      const pts = [];
      for (let a = 0; a < 7; a++) {
        const ang = a / 7 * Math.PI * 2;
        pts.push([cx + Math.cos(ang) * r * (0.75 + ((a * 37) % 10) / 20), cy + Math.sin(ang) * r * (0.8 + ((a * 53) % 10) / 25)]);
      }
      mk('polygon', { points: ptsStr(pts), class: 'foreign-land' });
    }
    for (const lb of (decor.isletLabels || [])) {
      const t = mk('text', { x: lb.pos[0], y: lb.pos[1], class: 'foreign-label', 'font-size': 10, 'text-anchor': 'middle' });
      t.textContent = lb.text;
    }
    for (const sl of (decor.seaLabels || [])) {
      const t = mk('text', {
        x: sl.pos[0], y: sl.pos[1], class: 'sea-label', 'font-size': 11, 'text-anchor': 'middle',
        transform: sl.rot ? `rotate(${sl.rot} ${sl.pos[0]} ${sl.pos[1]})` : ''
      });
      t.textContent = sl.text;
    }

    // island shadow (all provinces merged silhouette effect)
    for (const p of S().provinces) {
      if (p.path && p.path.length > 2) mk('polygon', { points: ptsStr(p.path), fill: 'rgba(34,29,21,0.28)', stroke: 'rgba(34,29,21,0.28)', 'stroke-width': 5, transform: 'translate(2.5,3.5)' });
    }
    // province polygons
    this.provNodes = {};
    for (const p of S().provinces) {
      if (!p.path || p.path.length < 3) continue;
      const f = this.provFill(p);
      const poly = mk('polygon', { points: ptsStr(p.path), class: 'prov-shape', fill: f.fill, 'fill-opacity': f.opacity });
      poly.addEventListener('pointerup', (e) => { if (!this.dragMoved() && !W.placing) { e.stopPropagation(); select('province', p.id, { noPan: true }); } });
      const title = document.createElementNS(NS, 'title');
      title.textContent = p.name;
      poly.appendChild(title);
      this.provNodes[p.id] = poly;
    }

    // roads & rails
    for (const r of (decor.roads || [])) mk('polyline', { points: ptsStr(r), class: 'map-road' });
    for (const r of (decor.rails || [])) mk('polyline', { points: ptsStr(r), class: 'map-rail' });

    // province labels (+ data value when data layer active)
    for (const p of S().provinces) {
      if (!p.labelPos) continue;
      const t = mk('text', { x: p.labelPos[0], y: p.labelPos[1], class: 'prov-label', 'font-size': 14, 'text-anchor': 'middle' });
      t.textContent = p.name.toUpperCase();
      if (W.layer === 'data') {
        const vdef = (S().variables || []).find(v => v.scope === 'province' && v.key === W.dataVar);
        const st = mk('text', { x: p.labelPos[0], y: p.labelPos[1] + 14, class: 'prov-stat', 'font-size': 9, 'text-anchor': 'middle' });
        st.textContent = fmtVal(p.vars[W.dataVar], vdef ? vdef.format : 'number');
      }
    }

    // property markers (counter-scaled)
    this.markerLayer = document.createElementNS(NS, 'g');
    this.world.appendChild(this.markerLayer);
    for (const pr of S().properties) {
      if (!pr.pos) continue;
      const owner = entById(pr.ownerId);
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('data-marker', pr.id);
      g.setAttribute('data-x', pr.pos[0]); g.setAttribute('data-y', pr.pos[1]);
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', -5.5); rect.setAttribute('y', -5.5);
      rect.setAttribute('width', 11); rect.setAttribute('height', 11);
      rect.setAttribute('class', 'prop-marker');
      rect.setAttribute('fill', owner ? owner.color || '#5c5340' : '#5c5340');
      if (W.selection && W.selection.kind === 'property' && W.selection.id === pr.id) rect.classList.add('selected');
      rect.addEventListener('pointerup', (e) => { if (!this.dragMoved() && !W.placing) { e.stopPropagation(); select('property', pr.id, { noPan: true }); } });
      const title = document.createElementNS(NS, 'title');
      title.textContent = `${pr.name} — ${owner ? owner.name : 'unowned'}`;
      rect.appendChild(title);
      const glyph = document.createElementNS(NS, 'text');
      glyph.setAttribute('class', 'prop-glyph');
      glyph.setAttribute('font-size', 8);
      glyph.setAttribute('text-anchor', 'middle');
      glyph.setAttribute('y', 3);
      glyph.textContent = KIND_GLYPH[pr.kind] || '•';
      g.appendChild(rect); g.appendChild(glyph);
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
      const r = c.size === 3 ? 4.6 : c.size === 2 ? 3.6 : 2.7;
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('r', r);
      dot.setAttribute('class', 'city-dot');
      if (W.selection && W.selection.kind === 'city' && W.selection.id === c.id) dot.classList.add('selected');
      dot.addEventListener('pointerup', (e) => { if (!this.dragMoved() && !W.placing) { e.stopPropagation(); select('city', c.id, { noPan: true }); } });
      const title = document.createElementNS(NS, 'title');
      title.textContent = c.name;
      dot.appendChild(title);
      g.appendChild(dot);
      if (c.isCapital) {
        const ring = document.createElementNS(NS, 'circle');
        ring.setAttribute('r', r + 2.6);
        ring.setAttribute('class', 'city-ring');
        g.appendChild(ring);
      }
      const lbl = document.createElementNS(NS, 'text');
      lbl.setAttribute('class', 'city-label');
      lbl.setAttribute('x', r + 4);
      lbl.setAttribute('y', 3);
      lbl.textContent = (c.isCapital ? '★ ' : '') + c.name;
      g.appendChild(lbl);
      this.cityLayer.appendChild(g);
    }

    this.renderLayerBar();
    this.renderLegend();
    this.applyTransform();
  },

  dragMoved() { return this.lastDragMoved; },

  updateMarkerScale() {
    const k = this.view.k;
    const showProps = k >= 2.1 || W.layer === 'ownership';
    if (this.markerLayer) {
      for (const g of this.markerLayer.children) {
        const x = g.getAttribute('data-x'), y = g.getAttribute('data-y');
        const sel = W.selection && W.selection.kind === 'property' && W.selection.id === g.getAttribute('data-marker');
        const s = (showProps || sel) ? 1 / k : 0.32 / k;
        g.setAttribute('transform', `translate(${x},${y}) scale(${Math.max(s, 0.11)})`);
        const glyph = g.querySelector('.prop-glyph');
        if (glyph) glyph.style.display = (showProps || sel) ? '' : 'none';
      }
    }
    if (this.cityLayer) {
      for (const g of this.cityLayer.children) {
        const x = g.getAttribute('data-x'), y = g.getAttribute('data-y');
        g.setAttribute('transform', `translate(${x},${y}) scale(${1 / Math.max(1, k * 0.72)})`);
      }
    }
  },

  highlight() {
    if (!this.ready || !this.provNodes) return;
    for (const id in this.provNodes) this.provNodes[id].classList.toggle('selected', !!(W.selection && W.selection.kind === 'province' && W.selection.id === id));
    if (this.markerLayer) for (const g of this.markerLayer.children) {
      const r = g.querySelector('.prop-marker');
      if (r) r.classList.toggle('selected', !!(W.selection && W.selection.kind === 'property' && W.selection.id === g.getAttribute('data-marker')));
    }
    if (this.cityLayer) for (const g of this.cityLayer.children) {
      const d = g.querySelector('.city-dot');
      if (d) d.classList.toggle('selected', !!(W.selection && W.selection.kind === 'city' && W.selection.id === g.getAttribute('data-city')));
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
  },

  setPlacing(p) { W.placing = p; this.renderLayerBar(); },

  renderLegend() {
    const lg = document.getElementById('map-legend');
    if (!lg) return;
    clear(lg);
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
      const owners = new Map();
      for (const pr of S().properties) { const o = entById(pr.ownerId); if (o && !owners.has(o.id)) owners.set(o.id, o); }
      [...owners.values()].slice(0, 10).forEach(o =>
        lg.appendChild(el('div.lg-row', el('span.lg-swatch', { style: 'background:' + (o.color || '#888') }), el('span', o.name))));
    } else {
      lg.appendChild(el('div.lg-title', S().settings.worldName.toUpperCase()));
      for (const p of S().provinces) {
        lg.appendChild(el('div.lg-row', el('span.lg-swatch', { style: 'background:' + (p.color || '#ccc') }), el('span', p.name)));
      }
      lg.appendChild(el('div', { style: 'margin-top:6px; color:var(--ink-faint);' }, 'zoom in for properties · ★ capital'));
    }
  }
};

// track whether last pointer interaction was a drag (used by child click handlers)
document.addEventListener('pointermove', () => { if (GameMap.drag && GameMap.drag.moved) GameMap.lastDragMoved = true; });
document.addEventListener('pointerdown', () => { GameMap.lastDragMoved = false; });
