'use strict';
/* Interactive map. SVG world on the 3840×2160 master-map grid, smooth
   pan/zoom, data-driven layers. Everything drawn here comes from state:
   settings.map (foreign countries, text labels, roads, railways),
   provinces (SVG shapes), cities and properties (markers).
   GM editing of labels/roads/rails lives in mapedit.js. */

const GameMap = {
  ready: false,
  VIEW: { w: 3840, h: 2160 },
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
      if (moved) return;
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

  /* ---------- render ---------- */
  render() {
    if (!this.ready || !S()) return;
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
    for (const pr of S().properties) {
      if (!pr.pos) continue;
      const owner = entById(pr.ownerId);
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('data-marker', pr.id);
      g.setAttribute('data-x', pr.pos[0]); g.setAttribute('data-y', pr.pos[1]);
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', -17.6); rect.setAttribute('y', -17.6);
      rect.setAttribute('width', 35.2); rect.setAttribute('height', 35.2);
      rect.setAttribute('class', 'prop-marker');
      rect.setAttribute('fill', owner ? owner.color || '#5c5340' : '#5c5340');
      if (W.selection && W.selection.kind === 'property' && W.selection.id === pr.id) rect.classList.add('selected');
      rect.addEventListener('pointerup', (e) => {
        if (this.dragMoved() || W.placing || this.editing()) return;
        e.stopPropagation();
        select('property', pr.id, { noPan: true });
      });
      title(rect, `${pr.name} — ${owner ? owner.name : 'unowned'}`);
      const glyph = document.createElementNS(NS, 'text');
      glyph.setAttribute('class', 'prop-glyph');
      glyph.setAttribute('font-size', 25.6);
      glyph.setAttribute('text-anchor', 'middle');
      glyph.setAttribute('y', 9.6);
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

    // GM pen-tool overlay (vertex handles, in-progress lines)
    this.editLayer = null;
    if (editing) MapEdit.renderOverlay(this);

    this.renderLayerBar();
    this.renderLegend();
    this.applyTransform();
  },

  dragMoved() { return this.lastDragMoved; },

  updateMarkerScale() {
    const k = this.view.k;
    const showProps = k >= 6.7 || W.layer === 'ownership';
    if (this.markerLayer) {
      for (const g of this.markerLayer.children) {
        const x = g.getAttribute('data-x'), y = g.getAttribute('data-y');
        const sel = W.selection && W.selection.kind === 'property' && W.selection.id === g.getAttribute('data-marker');
        const s = (showProps || sel) ? 1 / k : 0.32 / k;
        g.setAttribute('transform', `translate(${x},${y}) scale(${Math.max(s, 0.034)})`);
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
    if (window.MapEdit) MapEdit.toolbar(bar);
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

// track whether last pointer interaction was a drag (used by child click handlers)
document.addEventListener('pointermove', () => { if (GameMap.drag && GameMap.drag.moved) GameMap.lastDragMoved = true; });
document.addEventListener('pointerdown', () => { GameMap.lastDragMoved = false; });
