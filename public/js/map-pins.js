'use strict';
/* Player pins — where each player's character is in the world. Loaded after
   map-fx.js; folded into GameMap.

   A player puts their character on the map with the layer bar's
   "📍 Place me on the map" (it lands in the middle of the view), picks the
   pin up and drags it where they are, and takes it off with
   "✕ Clear my pin". Everyone sees everyone's pin; clicking one opens that
   character's file. The pin lives on the character's entity
   (`entity.whereabouts = { pos, at, provinceId, near }`, PUT/DELETE
   /api/me/pin); the GM may move or clear anyone's.

   The pins are HTML in #map-pins, stacked over the map svgs and kept on
   their spot by positionPins() on every pan/zoom frame (applyTransform), so
   they stay the same size at any zoom and a drag never repaints the map.
   Dragging works like moving a window in the Office: the pin lifts
   (raised, tilted, its shadow left on the ground), follows the hand frame
   by frame, the map scrolls when you carry it to an edge, and on release
   it drops with a little bounce onto the spot — kept there locally while
   the server confirms. */
(function () {
  const EDGE = 44, EDGE_SPEED = 14;

  Object.assign(GameMap, {
    _pinLocal: {},   // entity id → [x,y] dropped here, awaiting the server

    pinLayer() {
      const wrap = document.getElementById('map-wrap');
      if (!wrap || !this.overSvg) return null;
      let L = wrap.querySelector('#map-pins');
      if (!L) {
        L = el('div#map-pins');
        this.overSvg.after(L); // above the map and the war overlay, under the controls
      }
      return L;
    },
    myPinId() { return (W.me && W.me.entityId) || null; },
    _canDragPin(id) { return isGM() || id === this.myPinId(); },

    /* ---------- drawing ---------- */
    renderPins() {
      const L = this.pinLayer();
      if (!L || !S()) return;
      L.classList.toggle('hidden', W.showPins === false);
      const me = this.myPinId();
      const seen = new Set();
      for (const e of S().entities || []) {
        const wb = e.whereabouts;
        const local = this._pinLocal[e.id];
        if (local && wb && wb.pos && Math.hypot(wb.pos[0] - local[0], wb.pos[1] - local[1]) < 0.5) delete this._pinLocal[e.id];
        if (!(wb && Array.isArray(wb.pos)) && !this._pinLocal[e.id]) continue;
        seen.add(e.id);
        let n = L.querySelector(`[data-pin="${CSS.escape(e.id)}"]`);
        if (!n) { n = this._buildPin(e.id); L.appendChild(n); }
        const sig = [e.name, e.color, e.logo || '', e.id === me, this._canDragPin(e.id), wb && wb.near].join('|');
        if (n._sig !== sig) { n._sig = sig; this._fillPin(n, e, wb, e.id === me); }
        if (!(this._pinDrag && this._pinDrag.id === e.id && this._pinDrag.started)) n._pos = this._pinLocal[e.id] || (wb && wb.pos);
      }
      for (const n of [...L.children]) if (!seen.has(n.getAttribute('data-pin'))) n.remove();
      this.positionPins();
    },
    _buildPin(id) {
      const n = el('div.map-pin', { 'data-pin': id },
        el('div.mp-shadow'),
        el('div.mp-body', el('div.mp-head'), el('div.mp-tip')),
        el('div.mp-name'));
      n.addEventListener('pointerdown', (e) => this._pinDown(e, n, id));
      // the wheel still zooms the map over a pin
      n.addEventListener('wheel', (e) => { if (this.svg) { e.preventDefault(); this.svg.dispatchEvent(new WheelEvent('wheel', e)); } }, { passive: false });
      return n;
    },
    _fillPin(n, e, wb, mine) {
      n.classList.toggle('mine', mine);
      n.classList.toggle('draggable', this._canDragPin(e.id));
      n.style.setProperty('--pin', e.color || '#5b5e2c');
      const head = n.querySelector('.mp-head');
      clear(head);
      if (e.logo) head.appendChild(el('img', { src: e.logo, alt: '' }));
      else head.appendChild(document.createTextNode(String(e.name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()));
      n.querySelector('.mp-name').textContent = mine ? 'You' : e.name;
      n.title = `${e.name}${e.title ? ' — ' + e.title : ''}${wb && wb.near ? ' · ' + wb.near : ''}` + (this._canDragPin(e.id) ? ' · drag to move' : ' · click for their file');
    },
    // every pin onto its spot for the current view (each pan/zoom frame)
    positionPins() {
      const L = this._pinLayerEl || (this._pinLayerEl = document.getElementById('map-pins'));
      if (!L || !L.isConnected) { this._pinLayerEl = null; return; }
      if (!L.children.length || !this.svg) return;
      const m = this.svg.getScreenCTM();
      if (!m) return;
      const wr = L.getBoundingClientRect(), v = this.view;
      for (const n of L.children) {
        if (!n._pos || (this._pinDrag && this._pinDrag.n === n && this._pinDrag.started)) continue;
        const x = m.a * (n._pos[0] * v.k + v.x) + m.e - wr.left;
        const y = m.d * (n._pos[1] * v.k + v.y) + m.f - wr.top;
        n.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
      }
    },

    /* ---------- pick up, carry, drop ---------- */
    _pinDown(e, n, id) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const L = n.parentNode;
      const wr = L.getBoundingClientRect();
      const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(n.style.transform || '');
      const tipX = m ? +m[1] : 0, tipY = m ? +m[2] : 0;
      const st = this._pinDrag = { id, n, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastY: e.clientY,
        // where on the pin it was grabbed, so the tip keeps its offset from the hand
        offX: e.clientX - wr.left - tipX, offY: e.clientY - wr.top - tipY, started: false, raf: 0 };
      try { (e.target.closest('.mp-body, .mp-name') || n).setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
      const draggable = this._canDragPin(id);
      const frame = () => {
        st.raf = 0;
        const r = L.getBoundingClientRect();
        // carried to an edge: the map scrolls under the pin
        let dx = 0, dy = 0;
        if (st.lastX < r.left + EDGE) dx = EDGE_SPEED; else if (st.lastX > r.right - EDGE) dx = -EDGE_SPEED;
        if (st.lastY < r.top + EDGE) dy = EDGE_SPEED; else if (st.lastY > r.bottom - EDGE) dy = -EDGE_SPEED;
        if (dx || dy) { this.view.x += dx; this.view.y += dy; this.applyTransform(); }
        n.style.transform = `translate(${(st.lastX - r.left - st.offX).toFixed(1)}px,${(st.lastY - r.top - st.offY).toFixed(1)}px)`;
        if (dx || dy) st.raf = requestAnimationFrame(frame);
      };
      const move = (ev) => {
        if (ev.pointerId !== st.pointerId) return;
        st.lastX = ev.clientX; st.lastY = ev.clientY;
        if (!draggable) return;
        if (!st.started) {
          if (Math.hypot(ev.clientX - st.x0, ev.clientY - st.y0) < 4) return;
          st.started = true;
          n.classList.remove('dropped', 'spawned');
          n.classList.add('lifted');
          document.body.classList.add('pin-dragging');
        }
        if (!st.raf) st.raf = requestAnimationFrame(frame);
      };
      const up = async (ev) => {
        if (ev.pointerId !== st.pointerId) return;
        n.removeEventListener('pointermove', move);
        n.removeEventListener('pointerup', up);
        n.removeEventListener('pointercancel', up);
        if (st.raf) cancelAnimationFrame(st.raf);
        document.body.classList.remove('pin-dragging');
        this._pinDrag = null;
        if (!st.started) { if (ev.type === 'pointerup') select('entity', id); return; }
        // the tip's spot on the map
        const pos = this.clientToWorld(st.lastX - st.offX, st.lastY - st.offY);
        pos[0] = Math.max(0, Math.min(this.VIEW.w, pos[0]));
        pos[1] = Math.max(0, Math.min(this.VIEW.h, pos[1]));
        const before = n._pos;
        n._pos = pos;
        this._pinLocal[id] = pos;
        n.classList.remove('lifted');
        void n.offsetWidth;
        n.classList.add('dropped');
        setTimeout(() => n.classList.remove('dropped'), 460);
        this.positionPins();
        try {
          await PUT('/api/me/pin', id === this.myPinId() ? { pos } : { pos, entityId: id });
        } catch (err) {
          toast(err.message, true);
          delete this._pinLocal[id];
          n._pos = before;
          this.renderPins();
        }
      };
      n.addEventListener('pointermove', move);
      n.addEventListener('pointerup', up);
      n.addEventListener('pointercancel', up);
    },

    /* ---------- the layer bar's buttons ---------- */
    pinButtons(bar) {
      const me = this.myPinId();
      const ents = (S() && S().entities) || [];
      const placed = ents.filter(e => e.whereabouts && Array.isArray(e.whereabouts.pos));
      if (me) {
        const mine = ents.find(e => e.id === me);
        if (mine && !mine.whereabouts && !this._pinLocal[me]) {
          bar.appendChild(el('button.chip', { title: 'Put your character on the map — then drag the pin to where you are', onclick: () => this.placeMyPin() }, '📍 Place me on the map'));
        } else if (mine) {
          bar.appendChild(el('button.chip', { title: 'Centre the map on your pin', onclick: () => { const p = this._pinLocal[me] || (mine.whereabouts || {}).pos; if (p) this.focus(p, 2.5); } }, '◎ Me'));
          bar.appendChild(el('button.chip', { title: 'Take your character off the map', onclick: () => this.clearMyPin() }, '✕ Clear my pin'));
        }
      }
      if (placed.length) {
        bar.appendChild(el('button.chip', { class: W.showPins === false ? '' : 'active', title: 'Show or hide everyone’s pins',
          onclick: () => { W.showPins = W.showPins === false; this.renderPins(); this.renderLayerBar(); } }, `👤 People · ${placed.length}`));
      }
    },
    async placeMyPin() {
      const me = this.myPinId();
      if (!me || !this.svg) return;
      const r = this.svg.getBoundingClientRect();
      const pos = this.clientToWorld(r.left + r.width / 2, r.top + r.height / 2);
      pos[0] = Math.max(0, Math.min(this.VIEW.w, pos[0]));
      pos[1] = Math.max(0, Math.min(this.VIEW.h, pos[1]));
      this._pinLocal[me] = pos;
      W.showPins = true;
      this.renderPins();
      this.renderLayerBar();
      const n = this.pinLayer() && this.pinLayer().querySelector(`[data-pin="${CSS.escape(me)}"]`);
      if (n) { n.classList.add('spawned'); setTimeout(() => n.classList.remove('spawned'), 560); }
      try {
        await PUT('/api/me/pin', { pos });
        toast('You are on the map — drag your pin to where you are.');
      } catch (err) { toast(err.message, true); delete this._pinLocal[me]; this.renderPins(); this.renderLayerBar(); }
    },
    async clearMyPin() {
      const me = this.myPinId();
      if (!me) return;
      try {
        delete this._pinLocal[me];
        await DEL('/api/me/pin');
        toast('Your pin is off the map.');
      } catch (err) { toast(err.message, true); }
    }
  });
})();
