'use strict';
/* War Room — realtime battlefield RTS client. Two responsibilities:
     1. War.renderMapLayer(map, mk, NS)  — called from GameMap.render() to draw
        the territory-fracture overlay, unit markers and battle flashes.
     2. War.renderPanel(inner)           — called from Views.render() for the
        'war' tab: status, objectives, casualties, province control, events,
        and (GM only) start/pause/speed/end controls.

   The server is authoritative for everything (unit positions, combat,
   territory) — this module only ANIMATES what GET /api/state already
   confirmed. Positions are tweened client-side between syncs so units don't
   visibly teleport every tick; a persistent requestAnimationFrame loop keyed
   by unit id survives GameMap's from-scratch DOM rebuilds because the
   interpolation state (_anim) lives in this module, not in the DOM. */

const WAR_KIND_GLYPH = { marine: '⚓', infantry: '◆', armored: '▣', garrison: '⛊', reserve: '☰' };
const WAR_SCENARIOS = [['valksland_invasion', 'The Valgos Crisis — Valksland invades across the Strait']];
// Above this map zoom, unit markers render at a CONSTANT WORLD scale (scale 1
// — a fixed 40×28 world-unit symbol whose on-screen size grows as you zoom,
// exactly matching the server's 40px collision/combat range, so "what touches
// fights" reads literally). Below it, the marker keeps a constant SCREEN size
// (counter-scaled) so units stay readable over the whole island.
// FIXED_MODE_K/k is continuous at the threshold — no visual pop mid-zoom.
const WAR_FIXED_MODE_K = 3;
function warMarkerScale(k) { return Math.max(1, WAR_FIXED_MODE_K / Math.max(0.01, k)); }

const War = {
  _anim: {},        // unitId -> { from:[x,y], to:[x,y], t0, curPos:[x,y], node }
  _flashAnim: {},    // synthetic flash id -> { node, t0, life }
  _raf: null,

  // ---- interactive War layer input state (Phase 16) ----
  _sel: new Set(),   // selected unit ids (commandable side only)
  _input: null,      // current pointer gesture: {mode:'box'|'formation', start:[x,y], active, node?}
  _bombArmed: false,
  _gmSide: 'def',    // GM-only toggle: which side the GM is currently commanding

  active() { return !!(S() && S().war); },
  // A war OBJECT lingers after the fighting ends (active:false) so players can
  // review the final front — but its units are no longer commandable. Orders
  // against an inactive war are rejected server-side ("No war is active."), so
  // gate the command/bomb affordances on this, not on active() (= war exists).
  commandable() { const w = S() && S().war; return !!(w && w.active); },

  // Clamp a world point to the 3840×2160 map so orders/bombs never land
  // out of bounds — the ocean rect extends far past the map frame, so a
  // click in open water would otherwise send coordinates the server rejects
  // (bomb → "Invalid target position.") or silently drops (move order).
  _clamp(pt) { return [Math.max(0, Math.min(3840, pt[0])), Math.max(0, Math.min(2160, pt[1]))]; },

  /* ═══════════ AUTHORITY ═══════════
     Non-GM operators always command the defender — the server enforces this
     regardless of what the client sends, but the client mirrors it so the UI
     never even offers an 'att' toggle to a non-GM. */
  commandableSide() { return (isGM() && this._gmSide === 'att') ? 'att' : 'def'; },

  /* ═══════════ MAP INPUT (delegated from map.js's pointer handlers) ═══════════
     map.js only calls these while W.layer === 'war'. Each returns true when it
     consumed the gesture (map.js must then skip its own pan/click handling).

     The scheme (Phase 17 redesign — the old one consumed plain left-clicks,
     which blocked panning and forced a trip to the toolbar to deselect):
       · RIGHT-click            = move order for the current selection
       · RIGHT-drag             = formation line (ctrl-left-drag kept as alias)
       · LEFT-click on a soldier= select it (shift+click adds/toggles) —
                                  handled by per-marker listeners in renderUnits
       · SHIFT+left-drag        = box select
       · plain LEFT-click       = deselect (empty ground — see onMapClick,
                                  reached via map.js's svg pointerup once the
                                  dossier handlers stand down on the war layer)
       · plain LEFT-drag        = pan, exactly as the base map (never consumed)
       · Esc                    = clear selection + disarm bomb
       · Bomb                   = arm on the toolbar, then LEFT-click drops it */
  onMapPointerDown(e) {
    if (!this.active()) return false;
    const map = GameMap;
    const world = map.clientToWorld(e.clientX, e.clientY);
    if (e.button === 2) {
      // Right-button gesture: click = move order, drag = formation line.
      // Which one it is only becomes known on pointerup (>6 world px moved),
      // so start an 'order' gesture and grow the formation line lazily.
      this._input = { mode: 'order', start: world, active: true, node: null };
      return true;
    }
    if (e.button !== 0) return false;
    if (e.shiftKey) {
      this._input = { mode: 'box', start: world, active: true, node: this._marqueeNode(map) };
      return true;
    }
    if (e.ctrlKey || e.metaKey) { // bonus alias — right-drag is the primary formation gesture
      this._input = { mode: 'formation', start: world, active: true, node: this._formationNode(map) };
      return true;
    }
    if (this._bombArmed) {
      this._bombArmed = false;
      if (!this.commandable()) { toast('The war has concluded — no bombs can be dropped.', true); this.renderToolbar(); return true; }
      this._dropBomb(world);
      this.renderToolbar();
      return true;
    }
    // Plain left button: NOT consumed — map.js pans on drag; a motionless
    // click on empty ground deselects via onMapClick (svg pointerup).
    return false;
  },
  onMapPointerMove(e) {
    if (!this._input || !this._input.active) return;
    const map = GameMap;
    const world = map.clientToWorld(e.clientX, e.clientY);
    if (this._input.mode === 'box') this._updateMarquee(this._input.node, this._input.start, world);
    else if (this._input.mode === 'formation') this._updateFormationLine(this._input.node, this._input.start, world);
    else if (this._input.mode === 'order') {
      // Only materialise the formation line once the drag is unambiguous.
      const moved = Math.hypot(world[0] - this._input.start[0], world[1] - this._input.start[1]) >= 6;
      if (moved && !this._input.node) this._input.node = this._formationNode(map);
      if (this._input.node) this._updateFormationLine(this._input.node, this._input.start, world);
    }
  },
  onMapPointerUp(e) {
    if (!this._input || !this._input.active) return;
    const map = GameMap;
    const world = map.clientToWorld(e.clientX, e.clientY);
    const start = this._input.start;
    const tiny = Math.hypot(world[0] - start[0], world[1] - start[1]) < 6;
    if (this._input.mode === 'box') {
      if (this._input.node && this._input.node.parentNode) this._input.node.parentNode.removeChild(this._input.node);
      if (tiny) {
        this._sel.clear();
      } else {
        const x0 = Math.min(start[0], world[0]), x1 = Math.max(start[0], world[0]);
        const y0 = Math.min(start[1], world[1]), y1 = Math.max(start[1], world[1]);
        const side = this.commandableSide();
        const war = S().war;
        this._sel.clear();
        for (const u of (war ? war.units : [])) {
          if (u.side !== side || u.dead || u.state === 'dead' || !(u.strength > 0)) continue;
          if (u.pos[0] >= x0 && u.pos[0] <= x1 && u.pos[1] >= y0 && u.pos[1] <= y1) this._sel.add(u.id);
        }
      }
      if (map.render) map.render();
    } else if (this._input.mode === 'formation') {
      if (this._input.node && this._input.node.parentNode) this._input.node.parentNode.removeChild(this._input.node);
      if (!tiny && this._sel.size) this._issueFormation(start, world);
    } else if (this._input.mode === 'order') {
      if (this._input.node && this._input.node.parentNode) this._input.node.parentNode.removeChild(this._input.node);
      if (this._sel.size) {
        if (!this.commandable()) { toast('The war has concluded — no orders can be issued.', true); }
        else if (tiny) this._issueMove(world);
        else this._issueFormation(start, world);
      }
    }
    this._input = null;
  },

  // Plain left-click on empty ground (map.js's svg-level pointerup, after the
  // dossier select() handlers stand down on the war layer): clear selection.
  onMapClick(e) {
    if (e.button !== 0) return;
    if (this._sel.size) { this._sel.clear(); if (GameMap.render) GameMap.render(); }
  },

  // Left-click a commandable soldier: replace the selection; shift+click
  // toggles it in/out. Wired per-marker in renderUnits (only own live units).
  onUnitClick(unitId, e) {
    if (!this.commandable()) return;
    if (e.shiftKey) { if (!this._sel.delete(unitId)) this._sel.add(unitId); }
    else { this._sel.clear(); this._sel.add(unitId); }
    if (GameMap.render) GameMap.render();
  },

  // Esc clears selection + disarms the bomb while on the war layer. Bound
  // once against window (survives GameMap's DOM rebuilds).
  bindKeys() {
    if (this._keysBound) return;
    this._keysBound = true;
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || W.layer !== 'war') return;
      const had = this._sel.size || this._bombArmed;
      this._sel.clear(); this._bombArmed = false; this._input = null;
      if (had) { if (GameMap.render) GameMap.render(); this.renderToolbar(); }
    });
  },

  _marqueeNode(map) {
    const NS = 'http://www.w3.org/2000/svg';
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('class', 'war-marquee');
    map.world.appendChild(r);
    return r;
  },
  _updateMarquee(node, a, b) {
    if (!node) return;
    node.setAttribute('x', Math.min(a[0], b[0]));
    node.setAttribute('y', Math.min(a[1], b[1]));
    node.setAttribute('width', Math.abs(b[0] - a[0]));
    node.setAttribute('height', Math.abs(b[1] - a[1]));
  },
  _formationNode(map) {
    const NS = 'http://www.w3.org/2000/svg';
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('class', 'war-formation-line');
    map.world.appendChild(l);
    return l;
  },
  _updateFormationLine(node, a, b) {
    if (!node) return;
    node.setAttribute('x1', a[0]); node.setAttribute('y1', a[1]);
    node.setAttribute('x2', b[0]); node.setAttribute('y2', b[1]);
  },

  // Plain click with an existing selection: move all selected units toward
  // the click point (spread slightly in a small ring so they don't stack).
  async _issueMove(dest) {
    const ids = [...this._sel];
    const n = ids.length;
    const orders = ids.map((id, i) => {
      if (n === 1) return { unitId: id, dest: this._clamp(dest) };
      const ang = (i / n) * Math.PI * 2;
      const r = 24;
      return { unitId: id, dest: this._clamp([dest[0] + Math.cos(ang) * r, dest[1] + Math.sin(ang) * r]) };
    });
    try { await POST('/api/war/command', { side: this.commandableSide(), orders }); }
    catch (e) { toast(e.message, true); }
  },
  // Ctrl-drag formation: distribute the current selection along the line A→B,
  // nearest-in-order (sort both units and slots by their projection onto the
  // line direction, then pair them up 1:1) so units don't cross paths.
  async _issueFormation(a, b) {
    const war = S().war;
    if (!war) return;
    const ids = [...this._sel];
    const n = ids.length;
    if (n === 0) return;
    const dir = [b[0] - a[0], b[1] - a[1]];
    const units = ids.map(id => war.units.find(u => u.id === id)).filter(Boolean);
    const proj = (p) => (p[0] - a[0]) * dir[0] + (p[1] - a[1]) * dir[1];
    units.sort((u1, u2) => proj(u1.pos) - proj(u2.pos));
    const slots = [];
    for (let i = 0; i < units.length; i++) {
      const t = units.length > 1 ? i / (units.length - 1) : 0.5;
      slots.push([a[0] + dir[0] * t, a[1] + dir[1] * t]);
    }
    const orders = units.map((u, i) => ({ unitId: u.id, dest: this._clamp(slots[i]) }));
    try { await POST('/api/war/command', { side: this.commandableSide(), orders }); }
    catch (e) { toast(e.message, true); }
  },
  async _dropBomb(pos) {
    try {
      const r = await POST('/api/war/bomb', { side: this.commandableSide(), pos: this._clamp(pos) });
      toast('Bombing run away — impact incoming.');
    } catch (e) { toast(e.message, true); }
  },

  /* ---------- shared animation loop ----------
     One rAF loop, started lazily, that both tweens unit positions (~900ms
     ease between server syncs) and counter-scales markers with the current
     map zoom, and fades battle-flash rings. Runs continuously while there is
     anything to animate; stops itself once both registries are empty so an
     ended/never-started war costs nothing. */
  ensureLoop() {
    if (this._raf) return;
    const ease = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
    const step = (now) => {
      let any = false;
      for (const id in this._anim) {
        const e = this._anim[id];
        if (!e.node || !e.node.isConnected) { delete this._anim[id]; continue; }
        any = true;
        const u = Math.min(1, (now - e.t0) / 900);
        const k = ease(u);
        e.curPos = [e.from[0] + (e.to[0] - e.from[0]) * k, e.from[1] + (e.to[1] - e.from[1]) * k];
        // Fixed-world-size above WAR_FIXED_MODE_K, constant-screen-size below
        // — computed every frame from the live zoom so the mode switches
        // during a wheel-zoom without waiting for a re-render. HP bar,
        // selection ring and fight ring all inherit this group transform.
        const scale = warMarkerScale(GameMap.view ? GameMap.view.k : 1);
        e.node.setAttribute('transform', `translate(${e.curPos[0]},${e.curPos[1]}) scale(${scale})`);
      }
      for (const id in this._flashAnim) {
        const f = this._flashAnim[id];
        if (!f.node || !f.node.isConnected) { delete this._flashAnim[id]; continue; }
        any = true;
        const age = now - f.t0;
        if (age > f.life) { delete this._flashAnim[id]; continue; }
        f.node.style.opacity = String(1 - age / f.life);
      }
      this._raf = any ? requestAnimationFrame(step) : null;
    };
    this._raf = requestAnimationFrame(step);
  },

  /* ═══════════ MAP LAYER ═══════════ */
  renderMapLayer(map, mk, NS) {
    const war = S().war;
    if (!war) { this._anim = {}; this._flashAnim = {}; this._removeToolbar(); return; }
    map.warLayer = document.createElementNS(NS, 'g');
    map.warLayer.setAttribute('class', 'war-layer');
    map.world.appendChild(map.warLayer);

    this.renderCraters(map, mk, NS, war);
    this.renderTerritory(map, mk, NS, war);
    this.renderMoveArrows(map, mk, NS, war);
    this.renderUnits(map, mk, NS, war);
    this.renderFlashes(map, mk, NS, war);
    this.ensureLoop();
    this.bindKeys();
    if (W.layer === 'war') this.renderToolbar(); else this._removeToolbar();
  },

  // Dark scorch circles from recent bomb drops — drawn UNDER units/territory
  // so a crater reads as ground damage, not a marker. war.craters is capped
  // at 40 server-side so this stays cheap.
  renderCraters(map, mk, NS, war) {
    for (const c of (war.craters || [])) {
      const circ = document.createElementNS(NS, 'circle');
      circ.setAttribute('cx', c.pos[0]); circ.setAttribute('cy', c.pos[1]); circ.setAttribute('r', 95);
      circ.setAttribute('class', 'war-crater');
      map.warLayer.appendChild(circ);
    }
  },

  // Fracture overlay: captured cells grouped by province, drawn as a union of
  // 48px cell rects clipped to that province's real outline — the jagged
  // "territory eaten away" look, never spilling past the coastline.
  renderTerritory(map, mk, NS, war) {
    // The whole SVG is rebuilt from scratch every render (see GameMap.render),
    // so the hatch <pattern> def has to be recreated each time too — cheap,
    // and simpler than trying to persist defs across a full DOM teardown.
    const defs = document.createElementNS(NS, 'defs');
    map.warLayer.appendChild(defs);
    const pat = document.createElementNS(NS, 'pattern');
    pat.setAttribute('id', 'war-hatch');
    pat.setAttribute('width', '10'); pat.setAttribute('height', '10');
    pat.setAttribute('patternUnits', 'userSpaceOnUse');
    pat.setAttribute('patternTransform', 'rotate(45)');
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', '10'); bg.setAttribute('height', '10'); bg.setAttribute('fill', '#8a3030'); bg.setAttribute('fill-opacity', '0.32');
    const stripe = document.createElementNS(NS, 'rect');
    stripe.setAttribute('width', '4'); stripe.setAttribute('height', '10'); stripe.setAttribute('fill', '#8a3030'); stripe.setAttribute('fill-opacity', '0.55');
    pat.appendChild(bg); pat.appendChild(stripe);
    defs.appendChild(pat);

    const byProv = {};
    for (const key in (war.cells || {})) {
      const c = war.cells[key];
      if (c.o !== 'att' || !c.pid) continue;
      (byProv[c.pid] = byProv[c.pid] || []).push(key);
    }
    const cs = (war.grid && war.grid.cell) || 48;
    for (const pid in byProv) {
      const prov = provById(pid);
      if (!prov) continue;
      let d = '';
      for (const key of byProv[pid]) {
        const parts = key.split(',');
        const x = Number(parts[0]) * cs, y = Number(parts[1]) * cs;
        d += `M${x},${y} h${cs} v${cs} h${-cs} z `;
      }
      const clipId = 'warclip-' + pid;
      const cp = document.createElementNS(NS, 'clipPath');
      cp.setAttribute('id', clipId);
      const shapeNode = document.createElementNS(NS, prov.shape ? 'path' : 'polygon');
      if (prov.shape) shapeNode.setAttribute('d', prov.shape);
      else if (prov.path) shapeNode.setAttribute('points', prov.path.map(p => p.join(',')).join(' '));
      shapeNode.setAttribute('fill-rule', 'evenodd');
      cp.appendChild(shapeNode);
      defs.appendChild(cp);
      mk('path', { d, 'clip-path': `url(#${clipId})`, fill: 'url(#war-hatch)', class: 'war-territory' }, map.warLayer);
    }
  },

  // Movement arrows: a dashed polyline from each COMMANDABLE-SIDE live unit
  // with a dest, along its remaining transport-graph waypoints (u.path from
  // u.pathIdx on — straight to dest when there's no route), ending in an
  // arrowhead at the destination. Enemy movement intent is deliberately NOT
  // drawn — fog of war on where the other side is headed. Static per render
  // (the tweened marker chases the arrow's tail slightly — acceptable).
  renderMoveArrows(map, mk, NS, war) {
    const side = this.commandableSide();
    // Arrowhead <marker> defs — recreated per render, same reasoning as the
    // territory hatch <pattern> (the whole SVG is torn down every render).
    const defs = document.createElementNS(NS, 'defs');
    map.warLayer.appendChild(defs);
    for (const [id, cls] of [['war-arrowhead', 'war-move-arrowhead'], ['war-arrowhead-sel', 'war-move-arrowhead-sel']]) {
      const m = document.createElementNS(NS, 'marker');
      m.setAttribute('id', id);
      m.setAttribute('viewBox', '0 0 10 10');
      m.setAttribute('refX', '8'); m.setAttribute('refY', '5');
      m.setAttribute('markerWidth', '5'); m.setAttribute('markerHeight', '5');
      m.setAttribute('orient', 'auto-start-reverse');
      const tip = document.createElementNS(NS, 'path');
      tip.setAttribute('d', 'M0,0 L10,5 L0,10 z');
      tip.setAttribute('class', cls);
      m.appendChild(tip);
      defs.appendChild(m);
    }
    for (const u of war.units) {
      if (u.side !== side || u.dead || u.state === 'dead' || !(u.strength > 0) || !u.dest) continue;
      const anim = this._anim[u.id];
      const from = anim && anim.curPos ? anim.curPos : u.pos;
      const pts = [from];
      if (Array.isArray(u.path) && u.path.length) {
        for (let i = (u.pathIdx || 0); i < u.path.length; i++) pts.push(u.path[i]);
      }
      pts.push(u.dest);
      const sel = this._sel.has(u.id);
      const line = document.createElementNS(NS, 'polyline');
      line.setAttribute('points', pts.map(p => p[0] + ',' + p[1]).join(' '));
      line.setAttribute('class', sel ? 'war-move-arrow-sel' : 'war-move-arrow');
      line.setAttribute('marker-end', `url(#${sel ? 'war-arrowhead-sel' : 'war-arrowhead'})`);
      map.warLayer.appendChild(line);
    }
  },

  // NATO-ish rectangle markers, one per live unit. Position is animated by
  // the shared rAF loop (ensureLoop) — here we only decide the tween's `from`
  // (the last known interpolated position, so a mid-tween re-render never
  // snaps backward) and `to` (this sync's authoritative server position).
  // Commandable-side live markers are also the CLICK TARGETS for select /
  // shift-toggle (the group is the hitbox, so in fixed-world mode the hitbox
  // equals the visual symbol exactly); enemy and dead units get no handlers.
  renderUnits(map, mk, NS, war) {
    const liveIds = new Set();
    const cmdSide = this.commandableSide();
    const canCommand = this.commandable();
    const scaleNow = warMarkerScale(map.view ? map.view.k : 1);
    for (const u of war.units) {
      const isDead = u.dead || u.state === 'dead';
      const clickable = canCommand && !isDead && u.side === cmdSide;
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', `war-unit war-side-${u.side} war-state-${u.state}` +
        (isDead ? ' war-unit-dead' : '') + (this._sel.has(u.id) ? ' war-unit-sel' : '') +
        (clickable ? ' war-unit-cmd' : ''));
      g.setAttribute('data-warunit', u.id);
      if (clickable) {
        // Left-click selects / shift-toggles. Propagation is stopped on BOTH
        // pointerdown (so the map never starts pan bookkeeping under the
        // click) and pointerup (so the svg-level empty-ground deselect never
        // fires); the actual selection happens on pointerup, after which the
        // re-render can safely tear the node down. Right-clicks fall through
        // to the svg (a move order may target a friendly's position), and an
        // ARMED BOMB click also falls through so it drops on the map point.
        g.addEventListener('pointerdown', (e) => {
          if (e.button !== 0 || this._bombArmed) return;
          e.stopPropagation();
        });
        g.addEventListener('pointerup', (e) => {
          if (e.button !== 0 || this._bombArmed) return;
          e.stopPropagation();
          this.onUnitClick(u.id, e);
        });
      }

      if (isDead) {
        // Corpses don't tween and aren't kept in the anim registry — they
        // just sit where they fell, at reduced opacity, no HP bar, no ring.
        // They still take the current marker scale so they don't vanish at
        // low zoom (static — corpses don't need per-frame rescaling).
        g.setAttribute('transform', `translate(${u.pos[0]},${u.pos[1]}) scale(${scaleNow})`);
        const box = document.createElementNS(NS, 'rect');
        box.setAttribute('x', -20); box.setAttribute('y', -14); box.setAttribute('width', 40); box.setAttribute('height', 28);
        box.setAttribute('class', 'war-unit-box');
        g.appendChild(box);
        const glyph = document.createElementNS(NS, 'text');
        glyph.setAttribute('class', 'war-unit-glyph');
        glyph.setAttribute('text-anchor', 'middle'); glyph.setAttribute('y', 5);
        glyph.textContent = WAR_KIND_GLYPH[u.kind] || '?';
        g.appendChild(glyph);
        const title = document.createElementNS(NS, 'title');
        title.textContent = `${u.name} — destroyed`;
        g.appendChild(title);
        map.warLayer.appendChild(g);
        delete this._anim[u.id];
        continue;
      }

      liveIds.add(u.id);
      const prevAnim = this._anim[u.id];
      const from = prevAnim ? (prevAnim.curPos || prevAnim.to) : u.pos;
      g.setAttribute('transform', `translate(${from[0]},${from[1]}) scale(${scaleNow})`);

      if (u.state === 'fighting') {
        const ring = document.createElementNS(NS, 'circle');
        ring.setAttribute('r', 30); ring.setAttribute('class', 'war-fight-ring');
        g.appendChild(ring);
      }
      if (this._sel.has(u.id)) {
        const selRing = document.createElementNS(NS, 'circle');
        selRing.setAttribute('r', 30); selRing.setAttribute('class', 'war-sel-ring');
        g.appendChild(selRing);
      }
      const box = document.createElementNS(NS, 'rect');
      box.setAttribute('x', -20); box.setAttribute('y', -14); box.setAttribute('width', 40); box.setAttribute('height', 28);
      box.setAttribute('class', 'war-unit-box');
      g.appendChild(box);
      const glyph = document.createElementNS(NS, 'text');
      glyph.setAttribute('class', 'war-unit-glyph');
      glyph.setAttribute('text-anchor', 'middle'); glyph.setAttribute('y', 5);
      glyph.textContent = WAR_KIND_GLYPH[u.kind] || '?';
      g.appendChild(glyph);
      const pct = Math.max(0, Math.min(1, u.strength / (u.maxStrength || u.strength || 1)));
      const hpBg = document.createElementNS(NS, 'rect');
      hpBg.setAttribute('x', -20); hpBg.setAttribute('y', -22); hpBg.setAttribute('width', 40); hpBg.setAttribute('height', 4);
      hpBg.setAttribute('class', 'war-hp-bg');
      g.appendChild(hpBg);
      const hpFill = document.createElementNS(NS, 'rect');
      hpFill.setAttribute('x', -20); hpFill.setAttribute('y', -22); hpFill.setAttribute('width', 40 * pct); hpFill.setAttribute('height', 4);
      hpFill.setAttribute('class', 'war-hp-fill');
      g.appendChild(hpFill);
      const title = document.createElementNS(NS, 'title');
      title.textContent = `${u.name} — ${Math.round(u.strength)}/${u.maxStrength} · ${u.state}`;
      g.appendChild(title);
      map.warLayer.appendChild(g);

      this._anim[u.id] = { from: from.slice(), to: u.pos.slice(), t0: performance.now(), curPos: from.slice(), node: g };
    }
    for (const id in this._anim) if (!liveIds.has(id)) delete this._anim[id];
  },

  renderFlashes(map, mk, NS, war) {
    const now = Date.now();
    let i = 0;
    for (const ev of (war.events || [])) {
      i++;
      if (!ev.pos) continue;
      const age = now - ev.t;
      if (age > 4000) continue;
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', ev.pos[0]); c.setAttribute('cy', ev.pos[1]); c.setAttribute('r', 30);
      c.setAttribute('class', 'war-flash war-flash-' + ev.kind);
      c.style.opacity = String(1 - age / 4000);
      const title = document.createElementNS(NS, 'title'); title.textContent = ev.text;
      c.appendChild(title);
      map.warLayer.appendChild(c);
      const fid = ev.t + '_' + i;
      this._flashAnim[fid] = { node: c, t0: now - age, life: 4000 };
    }
  },

  /* ═══════════ WAR MAP TOOLBAR ═══════════
     Small floating control surface, only present while W.layer === 'war'.
     Rebuilt on every render (cheap — a handful of buttons); removed the
     instant the layer changes so it never lingers over another layer. */
  renderToolbar() {
    const bar0 = document.getElementById('war-toolbar');
    if (bar0 && bar0.parentNode) bar0.parentNode.removeChild(bar0);
    const war = S().war;
    if (!war) return;
    const live = this.commandable(); // false once the war has concluded
    const side = this.commandableSide();
    const bomb = (war.bombs || {})[side] || { cooldownUntil: 0 };
    const now = Date.now();
    const onCooldown = now < bomb.cooldownUntil;
    const bar = el('div#war-toolbar.war-toolbar');
    bar.appendChild(el('div.war-toolbar-hint', live
      ? 'Click soldier: select (Shift adds) · Right-click: move · Right-drag: formation · Shift-drag: box · Click ground / Esc: deselect'
      : 'This war has concluded — units can be reviewed but no longer commanded.'));
    const row = el('div.btn-row');
    // Bombs are DEFENDER-ONLY (server-enforced in dropBomb / the /api/war/bomb
    // route) — a GM commanding the attacker gets a disabled button + hint
    // instead of a bomb that would only bounce off the server.
    const bombBtn = (side === 'att')
      ? el('button.dash-btn', { disabled: 'disabled', title: 'The invader has no air arm.' }, '💣 No air arm')
      : el('button.dash-btn', {
          class: (this._bombArmed ? 'active' : '') , disabled: (onCooldown || !live) ? 'disabled' : undefined,
          onclick: () => { if (!live) return; this._bombArmed = !this._bombArmed; this.renderToolbar(); }
        }, !live ? '💣 Bomb' : onCooldown ? `Bomb (${Math.ceil((bomb.cooldownUntil - now) / 1000)}s)` : (this._bombArmed ? 'Bomb armed — click target' : '💣 Bomb'));
    row.appendChild(bombBtn);
    if (side === 'att') this._bombArmed = false; // never leave a bomb armed while commanding the side that has none
    row.appendChild(el('button.dash-btn', {
      onclick: () => { this._sel.clear(); this._bombArmed = false; if (GameMap.render) GameMap.render(); }
    }, 'Clear selection'));
    if (isGM()) {
      row.appendChild(el('button.dash-btn', {
        class: this._gmSide === 'def' ? 'active' : '',
        onclick: () => { this._gmSide = 'def'; this._sel.clear(); this.renderToolbar(); }
      }, 'Command: Defender'));
      row.appendChild(el('button.dash-btn', {
        class: this._gmSide === 'att' ? 'active' : '',
        onclick: () => { this._gmSide = 'att'; this._sel.clear(); this.renderToolbar(); }
      }, 'Command: Attacker'));
    }
    bar.appendChild(row);
    const wrap = document.getElementById('map-wrap');
    if (wrap) wrap.appendChild(bar);
    // Re-render the toolbar periodically so the bomb cooldown counts down
    // without waiting for the next server sync.
    if (!this._toolbarTimer) {
      this._toolbarTimer = setInterval(() => { if (W.layer === 'war' && this.active()) this.renderToolbar(); else this._removeToolbar(); }, 1000);
    }
  },
  _removeToolbar() {
    const bar = document.getElementById('war-toolbar');
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    if (this._toolbarTimer) { clearInterval(this._toolbarTimer); this._toolbarTimer = null; }
  },

  /* ═══════════ WAR ROOM PANEL ═══════════ */
  renderPanel(inner) {
    const war = S().war;
    inner.appendChild(el('div.doc-title', 'War Room'));
    if (!war) {
      inner.appendChild(el('div.doc-sub', 'No conflict is currently active.'));
      if (isGM()) this.renderStartForm(inner);
      return;
    }
    inner.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px; margin-bottom:6px;' },
      'Command your forces directly on the map — switch to the ⚔ War layer.'));

    const elapsed = Math.round((Date.now() - new Date(war.startedAt).getTime()) / 1000);
    const mm = Math.floor(elapsed / 60), ss = elapsed % 60;
    const statusText = war.result ? (war.result.winner === 'att' ? 'ENDED — INVASION SUCCEEDED' : war.result.winner === 'def' ? 'ENDED — INVASION REPELLED' : 'ENDED') : (war.paused ? 'PAUSED' : 'IN PROGRESS');
    inner.appendChild(el('div.doc-sub', `${war.name} · tick ${war.tick} · ${mm}m ${ss}s elapsed · ${statusText}`));

    inner.appendChild(Views.statStrip([
      ['Attacker Losses', fmtNum(Math.round(war.stats.attLosses))],
      ['Defender Losses', fmtNum(Math.round(war.stats.defLosses))],
      ['Cities Held', String((war.stats.citiesHeld || []).length)],
      ['Speed', war.speed + '×']
    ]));

    if (isGM()) this.renderControls(inner, war);

    inner.appendChild(Views.secLabel('Objectives'));
    const objTbl = el('table.data',
      el('thead', el('tr', el('th', 'Objective'), el('th', 'Target'), el('th', 'Status'))),
      el('tbody', [...war.objectives].sort((a, b) => a.priority - b.priority).map(o => el('tr',
        el('td', this.objLabel(o)),
        el('td', this.objTarget(o)),
        el('td', el('span.chip', { class: o.status === 'done' ? 'active' : '' }, o.status.toUpperCase()))
      ))));
    inner.appendChild(objTbl);

    inner.appendChild(Views.secLabel('Province Control'));
    const provBox = el('div');
    const control = war.stats.provinceControl || {};
    const provIds = Object.keys((war.grid || {}).provinceLandCells || control);
    for (const pid of provIds) {
      const prov = provById(pid);
      if (!prov) continue;
      provBox.appendChild(Views.barRow(prov.name, control[pid] || 0, prov.color));
    }
    inner.appendChild(provBox);

    inner.appendChild(Views.secLabel('Front-Line Report'));
    const evBox = el('div');
    const recent = (war.events || []).slice(-12).reverse();
    if (!recent.length) evBox.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'No engagements reported yet.'));
    for (const ev of recent) {
      evBox.appendChild(el('div.activity-item', el('span.when', new Date(ev.t).toLocaleTimeString()), ev.text));
    }
    inner.appendChild(evBox);
  },

  objLabel(o) {
    const KIND_LABEL = { landing: 'Establish beachhead', seize_city: 'Seize city', seize_capital: 'Seize the capital', control_province: 'Control province' };
    return KIND_LABEL[o.kind] || o.kind;
  },
  objTarget(o) {
    if (o.kind === 'control_province') { const p = provById(o.ref); return p ? p.name : (o.ref || '—'); }
    const c = cityById(o.ref);
    return c ? c.name : (o.ref || '—');
  },

  renderStartForm(inner) {
    inner.appendChild(Views.secLabel('Start a Scenario'));
    const sel = el('select.text-input', WAR_SCENARIOS.map(s => el('option', { value: s[0] }, s[1])));
    inner.appendChild(el('div.btn-row', sel, el('button.solid-btn', {
      onclick: async () => {
        try { await POST('/api/gm/war/start', { scenario: sel.value }); toast('The invasion begins.'); }
        catch (e) { toast(e.message, true); }
      }
    }, '⚔ Start War')));
  },

  renderControls(inner, war) {
    const row = el('div.btn-row');
    if (!war.result) {
      row.appendChild(el('button.solid-btn', {
        onclick: async () => { try { await POST('/api/gm/war/control', { paused: !war.paused }); } catch (e) { toast(e.message, true); } }
      }, war.paused ? '▶ Resume' : '⏸ Pause'));
      for (const s of [1, 2, 4, 8]) {
        row.appendChild(el('button.dash-btn', {
          class: war.speed === s ? 'active' : '',
          onclick: async () => { try { await POST('/api/gm/war/control', { speed: s }); } catch (e) { toast(e.message, true); } }
        }, s + '×'));
      }
      row.appendChild(el('button.danger-btn', {
        onclick: () => confirmModal('END WAR', 'End the war now? The result stays on record for review.', async () => {
          await POST('/api/gm/war/end');
          toast('War ended by GM order.');
        }, 'End War')
      }, '■ End War'));
    } else {
      row.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'This war has concluded. Start a new scenario below to run another.'));
    }
    inner.appendChild(row);
    if (war.result) this.renderStartForm(inner);
  }
};
window.War = War; // map.js feature-detects the War Room / map overlay via window, same as MapEdit/Entertainment
