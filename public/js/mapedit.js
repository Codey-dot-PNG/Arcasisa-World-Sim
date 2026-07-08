'use strict';
/* Gamemaster map editor. Lives on top of GameMap and edits settings.map:
     · labels — the free text markers (country names, seas, notes):
                add, drag to move, click to edit text/style/rotation, delete
     · roads / rails — pen tool: draw new lines point by point, drag vertex
                handles, insert points on the ◆ midpoints, double-click a
                vertex to remove it, delete whole lines
   Everything saves through PATCH /api/gm/settings { map: … } (GM only). */

const MapEdit = {
  active: false,
  mode: 'labels',       // labels | roads | rails | properties
  sel: null,            // selected road/rail id (within current mode)
  selLabel: null,
  drawing: null,        // { pts: [...] } while the pen is down
  addingLabel: false,
  addingProperty: false,
  addingMarker: false,
  dragging: false,      // true while a vertex/marker/label is being dragged (suppresses GameMap.render)
  saveTimer: null,

  map() { return S().settings.map; },
  coll() { return this.mode === 'rails' ? this.map().rails : this.map().roads; },
  uid(p) { return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },

  toggle(on) {
    if (!isGM()) return;
    if (!this.map()) return toast('This world has no map document — reset or migrate it first.', true);
    this.active = on === undefined ? !this.active : on;
    this.sel = null; this.selLabel = null; this.drawing = null; this.addingLabel = false; this.addingProperty = false; this.addingMarker = false;
    GameMap.render();
  },
  setMode(m) {
    this.mode = m;
    this.sel = null; this.selLabel = null; this.drawing = null; this.addingLabel = false; this.addingProperty = false; this.addingMarker = false;
    GameMap.render();
  },

  save(immediate) {
    clearTimeout(this.saveTimer);
    // Snapshot the payload NOW: `this.map()` reads W.state, and any sync that
    // lands before a debounced save fires replaces W.state with server data —
    // reading at run time would silently save the unedited world back.
    const m = this.map();
    const payload = { labels: m.labels, roads: m.roads, rails: m.rails };
    const run = async () => {
      this.saveTimer = null; // fired (or immediate) — no longer an unsaved-changes signal
      try { await PATCH('/api/gm/settings', { map: payload }); }
      catch (e) { toast(e.message, true); }
    };
    if (immediate) run(); else this.saveTimer = setTimeout(run, 700);
  },

  /* ---------- toolbar (rendered into #map-layerbar by GameMap) ---------- */
  toolbar(bar) {
    if (!isGM()) return;
    if (!this.active) {
      bar.appendChild(el('button.chip', { onclick: () => this.toggle(true) }, '✎ Edit map'));
      return;
    }
    bar.appendChild(el('span.chip', { style: 'border-color:var(--accent); color:var(--accent); cursor:default;' }, '✎ MAP EDITOR'));
    for (const [m, label] of [['labels', 'Labels'], ['roads', 'Roads'], ['rails', 'Railways'], ['properties', 'Properties'], ['markers', 'Markers']]) {
      bar.appendChild(el('button.chip', { class: this.mode === m ? 'active' : '', onclick: () => this.setMode(m) }, label));
    }
    if (this.mode === 'labels') {
      bar.appendChild(el('button.chip', { class: this.addingLabel ? 'active' : '', onclick: () => { this.addingLabel = !this.addingLabel; GameMap.renderLayerBar(); } },
        this.addingLabel ? '⌖ click the map…' : '+ Label'));
    } else if (this.mode === 'properties') {
      bar.appendChild(el('button.chip', { class: this.addingProperty ? 'active' : '', onclick: () => { this.addingProperty = !this.addingProperty; GameMap.renderLayerBar(); } },
        this.addingProperty ? '⌖ click the map…' : '+ Property'));
    } else if (this.mode === 'markers') {
      bar.appendChild(el('button.chip', { class: this.addingMarker ? 'active' : '', onclick: () => { this.addingMarker = !this.addingMarker; GameMap.renderLayerBar(); } },
        this.addingMarker ? '⌖ click the map…' : '+ Marker'));
    } else {
      const noun = this.mode === 'roads' ? 'road' : 'railway';
      if (this.drawing) {
        bar.appendChild(el('span.chip', { style: 'cursor:default;' }, '⌖ click to add points (' + this.drawing.pts.length + ')'));
        bar.appendChild(el('button.chip', { onclick: () => this.finishDraw() }, '✓ Finish ' + noun));
        bar.appendChild(el('button.chip', { onclick: () => { this.drawing = null; GameMap.render(); } }, '✕ Cancel'));
      } else {
        bar.appendChild(el('button.chip', { onclick: () => { this.drawing = { pts: [] }; this.sel = null; GameMap.render(); } }, '+ Draw ' + noun));
        if (this.sel) bar.appendChild(el('button.chip', { style: 'color:var(--accent);', onclick: () => this.deleteSel() }, '🗑 Delete ' + noun));
      }
    }
    bar.appendChild(el('button.chip', { onclick: () => this.toggle(false) }, 'Done'));
    const hints = {
      labels: 'drag a label to move · click one to edit or delete',
      roads: 'click a road to select · drag ○ · ◆ inserts a point · double-click ○ removes it',
      rails: 'click a railway to select · drag ○ · ◆ inserts a point · double-click ○ removes it',
      properties: 'drag a marker to move it · click one to open its file · "+ Property" places a new one',
      markers: 'drag a pin to move it · click one to edit or delete · "+ Marker" places a new one'
    };
    bar.appendChild(el('span.map-edit-hint', hints[this.mode]));
  },

  /* ---------- events routed from GameMap ---------- */
  mapClick(pt, e) {
    if (!this.active) return;
    pt = [Math.round(pt[0]), Math.round(pt[1])];
    if (this.mode === 'labels') {
      if (this.addingLabel) {
        this.addingLabel = false;
        const lbl = { id: this.uid('lbl'), text: 'NEW LABEL', kind: 'note', pos: pt, rot: 0, size: 40 };
        this.map().labels.push(lbl);
        this.save();
        GameMap.render();
        this.editLabel(lbl.id);
      } else if (this.selLabel) {
        this.selLabel = null;
        GameMap.render();
      }
      return;
    }
    if (this.mode === 'properties') {
      if (this.addingProperty) {
        this.addingProperty = false;
        this.createProperty(pt);
      }
      return;
    }
    if (this.mode === 'markers') {
      if (this.addingMarker) {
        this.addingMarker = false;
        this.createMarker(pt);
      }
      return;
    }
    if (this.drawing) {
      this.drawing.pts.push(pt);
      GameMap.render();
    } else if (this.sel) {
      this.sel = null;
      GameMap.render();
    }
  },

  // double-click on the map finishes the line being drawn
  dblclick() {
    if (this.drawing) { this.finishDraw(); return true; }
    return false;
  },

  finishDraw() {
    if (!this.drawing) return;
    if (this.drawing.pts.length < 2) { this.drawing = null; GameMap.render(); return toast('A line needs at least two points.', true); }
    const obj = { id: this.uid(this.mode === 'rails' ? 'rail' : 'road'), pts: this.drawing.pts };
    this.coll().push(obj);
    this.drawing = null;
    this.sel = obj.id;
    this.save();
    GameMap.render();
    toast(this.mode === 'rails' ? 'Railway laid.' : 'Road built.');
  },

  selectPath(mode, id) {
    this.mode = mode;
    this.sel = id;
    GameMap.render();
  },

  deleteSel() {
    const arr = this.coll();
    const i = arr.findIndex(r => r.id === this.sel);
    if (i < 0) return;
    arr.splice(i, 1);
    this.sel = null;
    this.save();
    GameMap.render();
    toast('Removed from the map.');
  },

  /* ---------- labels: drag to move, click to edit ---------- */
  labelPointerDown(e, id) {
    if (!this.active || this.mode !== 'labels') return;
    e.stopPropagation();
    const node = e.target;
    const lbl = this.map().labels.find(l => l.id === id);
    if (!lbl) return;
    const start = GameMap.clientToWorld(e.clientX, e.clientY);
    const orig = lbl.pos.slice();
    let moved = false;
    this.dragging = true;
    const onMove = (ev) => {
      const cur = GameMap.clientToWorld(ev.clientX, ev.clientY);
      const nx = Math.round(orig[0] + cur[0] - start[0]);
      const ny = Math.round(orig[1] + cur[1] - start[1]);
      if (!moved && Math.abs(nx - orig[0]) + Math.abs(ny - orig[1]) > 2) moved = true;
      lbl.pos = [nx, ny];
      node.setAttribute('x', nx);
      node.setAttribute('y', ny);
      if (lbl.rot) node.setAttribute('transform', `rotate(${lbl.rot} ${nx} ${ny})`);
    };
    const onUp = () => {
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      this.dragging = false;
      // a sync may have swapped W.state mid-drag, orphaning `lbl` — re-apply
      // the final position to whatever the current state holds for this id
      if (moved) { this.patchLabel(id, { pos: lbl.pos }); }
      else { this.selLabel = id; this.editLabel(id); }
    };
    try { node.setPointerCapture(e.pointerId); } catch (err) { /* stylus/touch edge cases */ }
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
  },

  // Apply changes to a label by id against the CURRENT state, then save
  // immediately. Never holds onto a label object across awaits/timers — the
  // object may belong to a stale W.state after any sync.
  patchLabel(id, changes) {
    const arr = this.map().labels;
    let lbl = arr.find(l => l.id === id);
    if (!lbl) { lbl = { id, text: '…', kind: 'note', pos: [0, 0], rot: 0, size: 40 }; arr.push(lbl); }
    Object.assign(lbl, changes);
    this.save(true);
    GameMap.render();
  },

  editLabel(id) {
    const lbl = this.map().labels.find(l => l.id === id);
    if (!lbl) return;
    const d = { text: lbl.text, kind: lbl.kind || 'note', size: lbl.size || 40, rot: lbl.rot || 0 };
    const kindSel = el('select.text-input',
      [['country', 'Country name (big, white)'], ['sea', 'Sea / strait / ocean'], ['note', 'Small note']].map(([v, t]) =>
        el('option', { value: v, selected: d.kind === v ? 'selected' : undefined }, t)));
    kindSel.addEventListener('change', () => d.kind = kindSel.value);
    openModal('MAP LABEL', el('div',
      el('label.field-label', 'Text'), el('input.text-input', { value: d.text, oninput: (e) => d.text = e.target.value }),
      el('label.field-label', 'Style'), kindSel,
      el('div.form-grid',
        el('div', el('label.field-label', 'Size'), el('input.text-input', { type: 'number', value: d.size, oninput: (e) => d.size = Number(e.target.value) })),
        el('div', el('label.field-label', 'Rotation (°)'), el('input.text-input', { type: 'number', value: d.rot, oninput: (e) => d.rot = Number(e.target.value) })))
    ), [
      {
        label: 'Save', onClick: () => {
          // patchLabel re-finds by id: `lbl` may be stale if the world synced
          // while the modal was open (the old cause of "text doesn't save")
          this.selLabel = null;
          this.patchLabel(id, { text: d.text || '…', kind: d.kind, size: Math.max(8, Number(d.size) || 40), rot: Number(d.rot) || 0, pos: lbl.pos });
        }
      },
      {
        label: 'Delete', cls: 'danger-btn', onClick: () => {
          const arr = this.map().labels;
          const i = arr.findIndex(l => l.id === id);
          if (i >= 0) arr.splice(i, 1);
          this.selLabel = null;
          this.save(true);
          GameMap.render();
        }
      },
      { label: 'Cancel', cls: 'dash-btn', onClick: () => { this.selLabel = null; GameMap.render(); } }
    ]);
  },

  /* ---------- properties: place new ones, drag existing ones ---------- */
  nearestProvinceId(pt) {
    // properties don't carry their own boundary test on the client, so pick
    // the province of whichever city marker sits closest to the drop point
    let best = null, bd = Infinity;
    for (const c of S().cities) {
      if (!c.pos || !c.provinceId) continue;
      const d = (c.pos[0] - pt[0]) ** 2 + (c.pos[1] - pt[1]) ** 2;
      if (d < bd) { bd = d; best = c.provinceId; }
    }
    return best || (S().provinces[0] || {}).id;
  },

  async createProperty(pt) {
    // no provinceId: the server assigns it by point-in-polygon geometry
    // (the old nearest-CITY guess here mis-registered provinces whenever the
    // closest city belonged to a neighbour)
    const body = {
      name: 'New Property', type: 'commercial', kind: 'office',
      pos: pt, ownerId: null,
      value: 100000, employees: 0, income: 0, expenses: 0, description: '', inventory: [], vars: {}
    };
    try {
      const r = await POST('/api/gm/coll/properties', body);
      const id = (r.obj && r.obj.id) || r.id;
      toast('Property placed — edit its details.');
      // open the inline inspector editor (Phase 2) so the GM never leaves the map
      select('property', id, { noPan: true });
      W.inspEdit = true; W.inspDraft = null;
      Views.inspect('property', id);
    } catch (e) { toast(e.message, true); }
  },

  propertyPointerDown(e, pr, g) {
    this.dragging = true;
    const rect = g.querySelector('.prop-marker');
    const start = GameMap.clientToWorld(e.clientX, e.clientY);
    const orig = pr.pos.slice();
    let moved = false;
    const onMove = (ev) => {
      const cur = GameMap.clientToWorld(ev.clientX, ev.clientY);
      const nx = Math.round(orig[0] + cur[0] - start[0]);
      const ny = Math.round(orig[1] + cur[1] - start[1]);
      if (!moved && Math.abs(nx - orig[0]) + Math.abs(ny - orig[1]) > 2) moved = true;
      pr.pos = [nx, ny];
      g.setAttribute('data-x', nx); g.setAttribute('data-y', ny);
      GameMap.updateMarkerScale();
    };
    const onUp = async () => {
      rect.removeEventListener('pointermove', onMove);
      rect.removeEventListener('pointerup', onUp);
      if (moved) {
        // Keep `dragging` set across the PATCH: clearing it first lets a
        // deferred refresh swap W.state mid-round-trip, and the render below
        // would then draw the marker at its pre-drag position until the next
        // sync (the property "snap-back" desync).
        try { await PATCH('/api/gm/coll/properties/' + pr.id, { pos: pr.pos }); toast('Property moved.'); }
        catch (err) { toast(err.message, true); }
        finally { this.dragging = false; }
      } else {
        this.dragging = false;
        select('property', pr.id, { noPan: true });
      }
      GameMap.render();
    };
    try { rect.setPointerCapture(e.pointerId); } catch (err) { /* stylus/touch edge cases */ }
    rect.addEventListener('pointermove', onMove);
    rect.addEventListener('pointerup', onUp);
  },

  /* ---------- event markers: place, drag, edit ---------- */
  async createMarker(pt) {
    const body = { title: 'New Marker', icon: '◈', description: '', pos: pt, createdTurn: (S().settings.time || {}).turn || 0 };
    try {
      const r = await POST('/api/gm/coll/markers', body);
      toast('Marker placed.');
      select('marker', (r.obj && r.obj.id) || r.id, { noPan: true });
    } catch (e) { toast(e.message, true); }
  },

  markerPointerDown(e, mrk, g) {
    this.dragging = true;
    const circ = g.querySelector('.event-marker');
    const start = GameMap.clientToWorld(e.clientX, e.clientY);
    const orig = mrk.pos.slice();
    let moved = false;
    const onMove = (ev) => {
      const cur = GameMap.clientToWorld(ev.clientX, ev.clientY);
      const nx = Math.round(orig[0] + cur[0] - start[0]);
      const ny = Math.round(orig[1] + cur[1] - start[1]);
      if (!moved && Math.abs(nx - orig[0]) + Math.abs(ny - orig[1]) > 2) moved = true;
      mrk.pos = [nx, ny];
      g.setAttribute('data-x', nx); g.setAttribute('data-y', ny);
      GameMap.updateMarkerScale();
    };
    const onUp = async () => {
      circ.removeEventListener('pointermove', onMove);
      circ.removeEventListener('pointerup', onUp);
      if (moved) {
        // Hold `dragging` across the PATCH (see propertyPointerDown): clearing
        // it first lets a deferred refresh swap W.state mid-round-trip and the
        // render below would revert the pin to its pre-drag spot until sync.
        try { await PATCH('/api/gm/coll/markers/' + mrk.id, { pos: mrk.pos }); toast('Marker moved.'); }
        catch (err) { toast(err.message, true); }
        finally { this.dragging = false; }
      } else {
        this.dragging = false;
        select('marker', mrk.id, { noPan: true });
      }
      GameMap.render();
    };
    try { circ.setPointerCapture(e.pointerId); } catch (err) { /* stylus/touch edge cases */ }
    circ.addEventListener('pointermove', onMove);
    circ.addEventListener('pointerup', onUp);
  },

  /* ---------- pen-tool overlay (vertex + midpoint handles) ---------- */
  renderOverlay(gm) {
    const NS = 'http://www.w3.org/2000/svg';
    gm.editLayer = document.createElementNS(NS, 'g');
    gm.world.appendChild(gm.editLayer);
    const mk = (tag, attrs) => {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) if (attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
      gm.editLayer.appendChild(n);
      return n;
    };
    if (this.mode === 'labels') return;

    if (this.drawing && this.drawing.pts.length) {
      if (this.drawing.pts.length > 1) {
        mk('polyline', { points: this.drawing.pts.map(p => p.join(',')).join(' '), class: 'edit-preview', 'vector-effect': 'non-scaling-stroke' });
      }
      for (const p of this.drawing.pts) {
        const g = mk('g', { 'data-x': p[0], 'data-y': p[1] });
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('r', 16); c.setAttribute('class', 'edit-handle');
        g.appendChild(c);
      }
      return;
    }

    const sel = this.sel && this.coll().find(r => r.id === this.sel);
    if (!sel) return;
    // repaint the selected line in accent so it is obvious what is being edited
    for (const node of gm.svg.querySelectorAll(`[data-mapedit="${this.mode}:${sel.id}"]`)) node.classList.add('editing');

    // midpoints (insert) first so vertex handles draw on top
    for (let i = 0; i < sel.pts.length - 1; i++) {
      const mx = Math.round((sel.pts[i][0] + sel.pts[i + 1][0]) / 2);
      const my = Math.round((sel.pts[i][1] + sel.pts[i + 1][1]) / 2);
      const g = mk('g', { 'data-x': mx, 'data-y': my });
      const c = document.createElementNS(NS, 'rect');
      c.setAttribute('x', -10); c.setAttribute('y', -10);
      c.setAttribute('width', 20); c.setAttribute('height', 20);
      c.setAttribute('transform', 'rotate(45)');
      c.setAttribute('class', 'edit-mid');
      g.appendChild(c);
      g.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        sel.pts.splice(i + 1, 0, [mx, my]);
        this.startVertexDrag(e, g, sel, i + 1);
      });
    }
    // vertex handles
    sel.pts.forEach((p, i) => {
      const g = mk('g', { 'data-x': p[0], 'data-y': p[1] });
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', 16); c.setAttribute('class', 'edit-handle');
      g.appendChild(c);
      g.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.startVertexDrag(e, g, sel, i); });
      g.addEventListener('dblclick', (e) => {
        e.stopPropagation(); e.preventDefault();
        if (sel.pts.length <= 2) return toast('A line needs at least two points.', true);
        sel.pts.splice(i, 1);
        this.save();
        GameMap.render();
      });
    });
    // counter-scale the freshly-created handles/midpoints immediately so they
    // are the right size on first paint, not only after the next applyTransform
    gm.updateMarkerScale();
  },

  startVertexDrag(e, handle, obj, idx) {
    this.dragging = true;
    const lines = GameMap.svg.querySelectorAll(`[data-mapedit="${this.mode}:${obj.id}"]`);
    const onMove = (ev) => {
      const cur = GameMap.clientToWorld(ev.clientX, ev.clientY);
      obj.pts[idx] = [Math.round(cur[0]), Math.round(cur[1])];
      handle.setAttribute('data-x', obj.pts[idx][0]);
      handle.setAttribute('data-y', obj.pts[idx][1]);
      handle.setAttribute('transform', `translate(${obj.pts[idx][0]},${obj.pts[idx][1]}) scale(${1 / GameMap.view.k})`);
      const ptsAttr = obj.pts.map(p => p.join(',')).join(' ');
      for (const ln of lines) ln.setAttribute('points', ptsAttr);
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      this.dragging = false;
      // a sync may have replaced W.state mid-drag, orphaning `obj` — write the
      // dragged points back into whatever the current state holds for this id
      const cur = this.coll().find(r => r.id === obj.id);
      if (cur && cur !== obj) cur.pts = obj.pts;
      this.save();
      GameMap.render();
    };
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* stylus/touch edge cases */ }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  }
};

window.MapEdit = MapEdit; // map.js feature-detects the editor via window

// pen-tool keys: Enter finishes a line, Escape cancels / deselects, Delete removes
document.addEventListener('keydown', (e) => {
  if (!MapEdit.active || W.view !== 'map') return;
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
  if (typing) return;
  if (e.key === 'Enter' && MapEdit.drawing) { e.preventDefault(); MapEdit.finishDraw(); }
  else if (e.key === 'Escape') {
    if (MapEdit.drawing) { MapEdit.drawing = null; GameMap.render(); }
    else if (MapEdit.addingLabel) { MapEdit.addingLabel = false; GameMap.renderLayerBar(); }
    else if (MapEdit.addingProperty) { MapEdit.addingProperty = false; GameMap.renderLayerBar(); }
    else if (MapEdit.addingMarker) { MapEdit.addingMarker = false; GameMap.renderLayerBar(); }
    else if (MapEdit.sel || MapEdit.selLabel) { MapEdit.sel = null; MapEdit.selLabel = null; GameMap.render(); }
    else MapEdit.toggle(false);
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && MapEdit.sel) { e.preventDefault(); MapEdit.deleteSel(); }
});
