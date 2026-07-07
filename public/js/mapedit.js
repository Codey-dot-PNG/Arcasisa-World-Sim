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
  mode: 'labels',       // labels | roads | rails
  sel: null,            // selected road/rail id (within current mode)
  selLabel: null,
  drawing: null,        // { pts: [...] } while the pen is down
  addingLabel: false,
  saveTimer: null,

  map() { return S().settings.map; },
  coll() { return this.mode === 'rails' ? this.map().rails : this.map().roads; },
  uid(p) { return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },

  toggle(on) {
    if (!isGM()) return;
    if (!this.map()) return toast('This world has no map document — reset or migrate it first.', true);
    this.active = on === undefined ? !this.active : on;
    this.sel = null; this.selLabel = null; this.drawing = null; this.addingLabel = false;
    GameMap.render();
  },
  setMode(m) {
    this.mode = m;
    this.sel = null; this.selLabel = null; this.drawing = null; this.addingLabel = false;
    GameMap.render();
  },

  save(immediate) {
    clearTimeout(this.saveTimer);
    const run = async () => {
      try {
        const m = this.map();
        await PATCH('/api/gm/settings', { map: { labels: m.labels, roads: m.roads, rails: m.rails } });
      } catch (e) { toast(e.message, true); }
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
    for (const [m, label] of [['labels', 'Labels'], ['roads', 'Roads'], ['rails', 'Railways']]) {
      bar.appendChild(el('button.chip', { class: this.mode === m ? 'active' : '', onclick: () => this.setMode(m) }, label));
    }
    if (this.mode === 'labels') {
      bar.appendChild(el('button.chip', { class: this.addingLabel ? 'active' : '', onclick: () => { this.addingLabel = !this.addingLabel; GameMap.renderLayerBar(); } },
        this.addingLabel ? '⌖ click the map…' : '+ Label'));
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
      rails: 'click a railway to select · drag ○ · ◆ inserts a point · double-click ○ removes it'
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
      if (moved) { this.save(); GameMap.render(); }
      else { this.selLabel = id; this.editLabel(id); }
    };
    try { node.setPointerCapture(e.pointerId); } catch (err) { /* stylus/touch edge cases */ }
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
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
          Object.assign(lbl, { text: d.text || '…', kind: d.kind, size: Math.max(8, Number(d.size) || 40), rot: Number(d.rot) || 0 });
          this.selLabel = null;
          this.save(true);
          GameMap.render();
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
  },

  startVertexDrag(e, handle, obj, idx) {
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
    else if (MapEdit.sel || MapEdit.selLabel) { MapEdit.sel = null; MapEdit.selLabel = null; GameMap.render(); }
    else MapEdit.toggle(false);
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && MapEdit.sel) { e.preventDefault(); MapEdit.deleteSel(); }
});
