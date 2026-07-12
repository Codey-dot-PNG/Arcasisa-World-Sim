'use strict';
/* War Room — realtime battlefield RTS client. Two responsibilities:
     1. War.renderMapLayer(map, mk, NS)  — called from GameMap.render() to draw
        the territory-fracture overlay, unit markers and battle flashes.
     2. War.renderPanel(inner)           — called from Views.render() for the
        'war' tab: status, objectives, casualties, province control, events,
        and (GM only) start/pause/speed/end controls.

   The server is authoritative for everything (unit positions, combat,
   territory) — but the client no longer merely animates it. Phase 18 adds
   CLIENT-SIDE PREDICTION on top of the authoritative stream:

     · A deep copy of the last authoritative war doc (the "predicted war")
       is ticked locally by the SAME deterministic engine the server runs
       (public/js/war-engine.js — byte-identical to server/war-engine.js,
       seeded PRNG per tick), so units keep moving/fighting at full cadence
       between server snapshots instead of freezing until the next sync.
     · Move orders apply to the predicted war INSTANTLY (optimistically),
       before the POST round-trips — an outbox re-applies them across
       rebases until the server state reflects them.
     · A lightweight heartbeat (GET /api/war/state, ~one tick interval)
       drives the server's wall-clock tick gate and returns just the war
       doc; without it, serverless deployments only tick when something
       else polls (the 20s fallback), which is why wars used to advance in
       slow bursts. Each response REBASES the predicted war, discarding any
       prediction error — the server always wins.

   Rendering reads the predicted war; the War Room panel and command
   authority checks keep reading the authoritative S().war. Positions are
   additionally tweened (~900ms ease) between renders, exactly as before; a
   persistent requestAnimationFrame loop keyed by unit id survives GameMap's
   from-scratch DOM rebuilds because the interpolation state (_anim) lives
   in this module, not in the DOM. */

const WAR_KIND_GLYPH = { marine: '⚓', infantry: '◆', armored: '▣', garrison: '⛊', reserve: '☰' };
// Fallback shown for the one render before the real list arrives (or if the
// fetch fails) — see War._ensureScenarioList / GET /api/gm/war/scenarios,
// which is the source of truth so this file doesn't have to hardcode every
// scenario id in server/war-scenarios.js.
const WAR_SCENARIOS_FALLBACK = [{ id: 'valksland_invasion', name: 'The Valgos Crisis', attackerName: 'Valksland', defenderName: 'the Republic' }];
const WAR_SPAWN_KINDS = [['infantry', 'Infantry'], ['armored', 'Armored'], ['marine', 'Marine'], ['garrison', 'Garrison']];
// Above this map zoom, unit markers render at a CONSTANT WORLD scale (scale 1
// — a fixed 40×28 world-unit symbol whose on-screen size grows as you zoom,
// exactly matching the server's 40px collision/combat range, so "what touches
// fights" reads literally). Below it, the marker keeps a constant SCREEN size
// (counter-scaled) so units stay readable over the whole island.
// FIXED_MODE_K/k is continuous at the threshold — no visual pop mid-zoom.
const WAR_FIXED_MODE_K = 3;
function warMarkerScale(k) { return Math.max(1, WAR_FIXED_MODE_K / Math.max(0.01, k)); }

// Feature: cinematic airstrikes — client-only flight-path shaping (the
// server/engine only know orderedTick/strikeTick; everything about HOW the
// plane gets from `from` to `pos` is cosmetic and lives here).
const AIRSTRIKE_FAR_OFFSET = 220;  // px — how far out the plane climbs before turning onto the attack run
const AIRSTRIKE_EGRESS_TICKS = 3;  // ticks after impact the plane is still visible egressing/fading
// Total lifetime of the impact FX. Modelled frame-by-frame on neal.fun's
// Asteroid Launcher impact (~2.9s at 24fps in the reference capture): bloom
// wash 0-650ms, shockwave bubble 480-2750ms, ember lingering to the end.
const EXPLOSION_LIFE_MS = 2900;

// Feature: unit damage feedback — how long the hit-jitter/flash plays after a
// live unit's strength is observed to drop between renderUnits passes.
const WAR_HIT_FX_MS = 450;
// Matches the engine's rout threshold (war-engine.js: org < 25 → routed) —
// used purely for the client's morale-bar/info-card color, not gameplay.
const WAR_ROUT_ORG = 25;

const War = {
  _anim: {},        // unitId -> { from:[x,y], to:[x,y], t0, dur, curPos:[x,y], node }
  _arrowAnim: {},    // unitId -> { node, tail:'x,y x,y …' } — the marker end of each move arrow chases the tweened position every frame
  _flashAnim: {},    // synthetic flash id -> { node, t0, life }
  _raf: null,

  // ---- cinematic airstrikes (Feature: two-phase bombing) ----
  _airstrikeAnim: {}, // strikeId -> { node, strike, timing:{tick,lastTick,tickMs,speed} } — plane marker, position is a pure function of predicted tick, no tween needed
  _explosionAnim: {}, // strikeId -> { node, streak, bloom, ring, rim, core, t0, life, bombR } — the soft bloom/shockwave/ember impact FX, same recreate-each-render pattern as _flashAnim
  _strikeImpactAt: {}, // strikeId -> epoch ms of the first render where we observed strike.done === true (drives the one-shot explosion FX trigger)

  // ---- unit damage feedback (Feature: hit jitter/flash + morale) ----
  _lastStrength: {}, // unitId -> strength as of the last renderUnits pass, to detect a drop between renders
  _hitAt: {},        // unitId -> epoch ms the last strength drop was observed; drives war-unit-hit while recent

  // ---- interactive War layer input state (Phase 16) ----
  _sel: new Set(),   // selected unit ids (commandable side only)
  _input: null,      // current pointer gesture: {mode:'box'|'formation', start:[x,y], active, node?}
  _bombArmed: false,
  _gmSide: 'def',    // GM-only toggle: which side the GM is currently commanding
  _inspect: null,    // Feature: unit info card — enemy unit id under inspection (own-side uses _sel instead)

  // ---- GM unit spawner (Feature: mid-war reinforcements) ----
  _spawnArmed: false,        // "arm placement" mode: next war-layer left-click places the spawn
  _spawnDraft: { side: 'att', kind: 'infantry', count: 3, strength: 2000, atk: 1, speed: 3.5 },
  // ---- Foreign intervention (Feature: nation joins an ongoing war) ----
  _joinDraft: null,          // { entityId, side } — lazily seeded once a candidate nation list exists
  // ---- GM scenario picker (Feature: dynamic scenario list) ----
  _scenarioList: null,       // null = not yet fetched; [] = fetched empty/failed
  _scenarioFetchInFlight: false,

  // ---- client-side prediction state (Phase 18) ----
  _pred: null,       // { war: <deep copy>, authRef: <the S().war object it was rebased from>, baseTick, outbox: [{side,unitId,dest,exp}] }
  _warV: 0,          // last /api/war/state version applied — rejects out-of-order heartbeat responses
  _rtTimer: null,    // 250ms realtime driver (local predicted ticks + heartbeat gate)
  _hbDue: 0,         // epoch ms the next heartbeat poll is due
  _hbBusy: false,    // a heartbeat fetch is in flight
  _lastDraw: 0,      // performance.now() of the last prediction-triggered map redraw (throttle)

  active() { return !!(S() && S().war); },
  // A war OBJECT lingers after the fighting ends (active:false) so players can
  // review the final front — but its units are no longer commandable. Orders
  // against an inactive war are rejected server-side ("No war is active."), so
  // gate the command/bomb affordances on this, not on active() (= war exists).
  commandable() { const w = S() && S().war; return !!(w && w.active); },

  // Clamp a world point to the map so orders/bombs never land out of bounds
  // — the ocean rect extends far past the map frame, so a click in open
  // water would otherwise send coordinates the server rejects (bomb →
  // "Invalid target position.") or silently drops (move order). Delegates to
  // the shared engine's own clampToWorld (grid-derived bounds MINUS
  // WORLD_BORDER_INSET) whenever a predicted war is available, instead of a
  // hand-rolled [0,3840]x[0,2160] clamp with no inset — the mismatch used to
  // mean a near-edge order's optimistic `dest` never matched what
  // engine.setDest/setManualPath actually clamped it to server-side (off by
  // up to WORLD_BORDER_INSET px), so the order's outbox entry never read as
  // "confirmed" and kept re-applying itself every rebase until its 5s expiry
  // (harmless — both sides converged on the same final position — but wasted
  // cycles and could show a flickering arrow near the map edge).
  _clamp(pt) {
    const war = window.WarEngine && this._pred && this._pred.war;
    if (war) return WarEngine.clampToWorld(war, pt);
    return [Math.max(0, Math.min(3840, pt[0])), Math.max(0, Math.min(2160, pt[1]))];
  },

  /* ═══════════ AUTHORITY ═══════════
     Non-GM operators always command the defender — the server enforces this
     regardless of what the client sends, but the client mirrors it so the UI
     never even offers an 'att' toggle to a non-GM. */
  commandableSide() { return (isGM() && this._gmSide === 'att') ? 'att' : 'def'; },

  /* ═══════════ CLIENT-SIDE PREDICTION (Phase 18) ═══════════
     The predicted war is a deep copy of the last authoritative snapshot,
     ticked locally by WarEngine (same deterministic engine as the server,
     no ctx = milestone logs/news are no-ops). Every new authoritative war
     object — full /api/state refetch or /api/war/state heartbeat — REBASES
     the prediction: server truth replaces local guesswork wholesale, then
     any optimistic orders the server hasn't reflected yet are re-applied. */

  // The engine's db-shaped view over client state: the predicted war plus
  // the world data the tick pipeline reads (provinces for territory/geometry,
  // cities for the AI's garrison rule, settings.map for the transport graph).
  _dbLike(war) {
    const s = S() || {};
    return { war, provinces: s.provinces || [], cities: s.cities || [], settings: s.settings || {} };
  },

  // The war doc the MAP renders: predicted when available, else authoritative.
  // Rebases lazily whenever the authoritative object identity changed (every
  // state refetch swaps W.state wholesale, so identity is a reliable signal).
  predictedWar() {
    const auth = S() && S().war;
    if (!auth) { this._pred = null; return null; }
    if (!this._pred || this._pred.authRef !== auth) this._rebase(auth);
    return this._pred.war;
  },

  _rebase(auth) {
    const prev = this._pred;
    // Ignore a STALE snapshot of the same war (overlapping refetches can
    // resolve out of order; core.js guards its own path, but the heartbeat
    // and full-state fetches race each other). Ticks only move forward.
    if (prev && prev.war && auth.startedAt === prev.war.startedAt &&
        typeof auth.tick === 'number' && auth.tick < prev.baseTick) {
      prev.authRef = auth; // don't thrash re-checking it every render
      return;
    }
    const war = JSON.parse(JSON.stringify(auth));
    const sameWar = !!(prev && prev.war && prev.war.startedAt === war.startedAt);
    const now = Date.now();
    // AIRSTRIKE OUTBOX: _dropBomb splices the strike POST /api/war/bomb
    // returns straight into the predicted war so the plane/countdown start
    // immediately (see docs/WAR.md "Prediction"). But dropBomb saves
    // server-side SYNCHRONOUSLY before that response returns, and this
    // client also polls GET /api/war/state on its own ~1 tick-interval timer
    // — a heartbeat request already in flight the instant the order lands
    // can resolve with a snapshot from just BEFORE the strike existed. Left
    // alone, adopting that snapshot here would silently drop the strike
    // (no plane, no countdown) until the NEXT heartbeat/refetch arrives, a
    // whole interval later. Re-splice any outbox strike this snapshot
    // doesn't know about yet — BEFORE the fast-forward below, so if the
    // snapshot needs catching up it ticks the strike through stepAirstrikes
    // exactly like the server would (it may even resolve it, same as the
    // server, if the catch-up crosses strikeTick).
    const strikeOutbox = ((prev && prev.strikeOutbox) || []).filter(o =>
      o.exp > now && !(auth.airstrikes || []).some(s => s.id === o.strike.id));
    if (strikeOutbox.length) {
      war.airstrikes = war.airstrikes || [];
      for (const o of strikeOutbox) {
        if (!war.airstrikes.some(s => s.id === o.strike.id)) war.airstrikes.push(JSON.parse(JSON.stringify(o.strike)));
      }
    }
    // ROLLBACK RECONCILIATION: a snapshot describes the war as of the
    // server's last tick, which on live deployments is usually BEHIND the
    // local simulation (the heartbeat round-trips while prediction keeps
    // ticking). Adopting it raw would teleport every unit backward — the
    // "troops jump around on every sync" failure mode. Instead fast-forward
    // the snapshot deterministically to the tick the player is already
    // watching: same engine, same seed ⇒ near-identical state, so the swap
    // is visually seamless while still folding in everything the server
    // knew that we didn't (other players' orders, bombs, AI replans).
    if (sameWar && war.active && !war.paused && prev.war.tick > (war.tick || 0)) {
      const ahead = Math.min(prev.war.tick - (war.tick || 0), 12); // cap the catch-up CPU; beyond it, accept the jump
      const dbl = this._dbLike(war);
      for (let i = 0; i < ahead && war.active && !war.paused; i++) WarEngine.warTick(dbl);
    }
    // Carry the local tick PHASE across rebases — resetting it to "now" on
    // every snapshot (the original design) meant snapshots arriving faster
    // than the tick interval starved prediction completely: the client never
    // ticked at all and the war degraded to raw server bursts. A phase older
    // than ~2 intervals (hidden tab, stalled driver) is clamped so the next
    // maybeWarTick can't burst-run a huge catch-up past the divergence bound.
    const interval = Math.max(200, (war.tickMs || 2000) / (war.speed || 1));
    let phase = sameWar ? (prev.war._lastTick || 0) : 0;
    if (!phase || now - phase > interval * 2) phase = now;
    war._lastTick = phase;
    const outbox = (prev ? prev.outbox : []).filter(o => o.exp > now);
    this._pred = { war, authRef: auth, baseTick: auth.tick || 0, lastAuthTick: auth.tick || 0, outbox: [], strikeOutbox };
    // Re-apply optimistic orders the server hasn't reflected yet, so an
    // in-flight command's arrow doesn't flicker away on an older snapshot.
    // `o.dest` is always populated (for a path order it's the path's LAST
    // point — exactly what engine.setManualPath assigns to unit.dest), so
    // the "did the server pick this up yet" check works identically for
    // both plain-move and path orders.
    const unconfirmed = outbox.filter(o => {
      const u = war.units.find(x => x.id === o.unitId);
      return !(u && u.dest && Math.hypot(u.dest[0] - o.dest[0], u.dest[1] - o.dest[1]) < 2);
    });
    for (const o of unconfirmed) {
      const order = o.path ? { unitId: o.unitId, path: o.path } : { unitId: o.unitId, dest: o.dest };
      WarEngine.applyOrders(this._dbLike(war), o.side, [order]);
    }
    this._pred.outbox = unconfirmed;
  },

  // Apply orders to the predicted war IMMEDIATELY (the POST confirms later);
  // remember them so rebases re-apply until the server state shows them.
  _optimistic(side, orders) {
    const war = this.predictedWar();
    if (!war) return;
    WarEngine.applyOrders(this._dbLike(war), side, orders);
    const exp = Date.now() + 5000; // a write refetch lands well inside this
    for (const o of orders) {
      // A path order's effective "confirmed yet?" anchor is its last
      // waypoint (see the comment in _rebase) — dest is always populated.
      const dest = (Array.isArray(o.path) && o.path.length) ? o.path[o.path.length - 1] : o.dest;
      this._pred.outbox.push({ side, unitId: o.unitId, dest, path: o.path || null, exp });
    }
    this.refreshLayer(true);
  },

  // One 250ms driver while a war doc exists: (1) advance the local predicted
  // simulation on the same wall-clock gate the server uses, (2) poll the
  // lightweight heartbeat route at ~tick cadence so the SERVER keeps ticking
  // too (serverless deployments have no timer — without a poller the war
  // advances only on the 20s fallback, in ugly catch-up bursts).
  _ensureRealtime() {
    if (this._rtTimer) return;
    this._rtTimer = setInterval(() => this._realtimeStep(), 250);
  },
  _stopRealtime() {
    if (this._rtTimer) { clearInterval(this._rtTimer); this._rtTimer = null; }
  },
  _realtimeStep() {
    const auth = S() && S().war;
    if (!auth) { this._stopRealtime(); this._pred = null; return; }
    if (!auth.active || auth.paused || document.hidden) return;
    // 1. local predicted tick(s) — but never run unboundedly ahead of the
    //    last authoritative tick (if heartbeats stall, divergence would grow
    //    and every eventual reconciliation would be a visible teleport).
    const war = this.predictedWar();
    if (war && window.WarEngine &&
        war.tick - (this._pred.lastAuthTick || 0) < 10 &&
        WarEngine.maybeWarTick(this._dbLike(war))) {
      this.refreshLayer();
    }
    // 2. authoritative heartbeat, one tick interval apart (never below 1s —
    //    at 8× speed prediction carries the smoothness, not the network)
    const interval = Math.max(1000, (auth.tickMs || 2000) / (auth.speed || 1));
    const now = Date.now();
    if (now >= this._hbDue && !this._hbBusy) {
      this._hbDue = now + interval;
      this._heartbeat();
    }
  },
  async _heartbeat() {
    this._hbBusy = true;
    try {
      const res = await fetch('/api/war/state');
      if (res.ok) {
        const data = await res.json();
        // Version-guarded like core.js's refreshState: never apply a war
        // older than one already applied (out-of-order responses).
        if (data && data.v !== undefined && !(data.v <= this._warV)) {
          this._warV = data.v;
          if (W.state && data.war) {
            W.state.war = data.war; // identity change → predictedWar() rebases
            this.refreshLayer(true);
            this._maybeRefreshPanel();
          }
        }
      }
    } catch (e) { /* transient — next heartbeat retries */ }
    this._hbBusy = false;
  },

  // Rebuild ONLY the war layer group from the predicted war — never the whole
  // map SVG. A full GameMap.render() per predicted tick (the original design)
  // tore down and rebuilt every province/property/label up to 4× a second at
  // 8× speed; that DOM churn WAS the lag. Throttled so a heartbeat rebase and
  // a predicted tick landing together don't rebuild twice back-to-back.
  refreshLayer(force) {
    const now = performance.now();
    if (!force && now - this._lastDraw < 150) return;
    // NB: GameMap is a top-level `const` in map.js — a script-scope global
    // that is NOT a window property, so it must be referenced bare (a
    // `window.GameMap` guard is always undefined and silently no-ops).
    const map = typeof GameMap !== 'undefined' ? GameMap : null;
    // Only redraw when the map is actually on screen — prediction and the
    // heartbeat keep running on other views (so the war stays current and
    // the server keeps ticking), but there's nothing to draw there.
    if (!(map && map.svg && map.svg.isConnected && map.world && map.world.isConnected && map.mk)) return;
    if (window.MapEdit && MapEdit.dragging) return; // same guard as GameMap.render
    this._lastDraw = now;
    if (map.warLayer && map.warLayer.parentNode) map.warLayer.parentNode.removeChild(map.warLayer);
    this.renderMapLayer(map, map.mk, 'http://www.w3.org/2000/svg');
  },

  // The War Room panel (view 'war') reads the authoritative doc that the
  // heartbeat just swapped in — re-render it occasionally so tick/casualty
  // counters stay live now that war ticks no longer broadcast a full sync.
  _maybeRefreshPanel() {
    if (typeof W === 'undefined' || W.view !== 'war' || typeof App === 'undefined') return;
    if (typeof editingBusy === 'function' && editingBusy()) return;
    const now = Date.now();
    if (now - (this._panelAt || 0) < 2500) return;
    this._panelAt = now;
    this._reRenderPanel();
  },
  // Re-render the War Room panel in place, preserving scroll position — used
  // by the heartbeat refresh above and by UI-only state toggles (spawn/join
  // side buttons) that need to repaint their active state without a full
  // world refetch.
  _reRenderPanel() {
    if (typeof App === 'undefined') return;
    const dv = document.querySelector('#view .doc-view');
    const st = dv ? dv.scrollTop : 0;
    App.renderView();
    const dv2 = document.querySelector('#view .doc-view');
    if (dv2) dv2.scrollTop = st;
  },

  // GM scenario picker data (Feature: dynamic scenario list) — fetched once
  // and cached; a failed/incomplete fetch just leaves the fallback showing.
  async _ensureScenarioList() {
    if (this._scenarioList || this._scenarioFetchInFlight) return;
    this._scenarioFetchInFlight = true;
    try {
      const data = await GET('/api/gm/war/scenarios');
      this._scenarioList = (data && data.scenarios) || [];
    } catch (e) { this._scenarioList = []; }
    this._scenarioFetchInFlight = false;
    if (typeof W !== 'undefined' && W.view === 'war') this._reRenderPanel();
  },

  /* ═══════════ MAP INPUT (delegated from map.js's pointer handlers) ═══════════
     map.js only calls these while W.layer === 'war'. Each returns true when it
     consumed the gesture (map.js must then skip its own pan/click handling).

     The scheme (Phase 19 redesign — right-drag used to be the formation
     gesture; it now draws a freehand custom path instead, since that's the
     more frequently wanted tool. Formation survives via its ctrl-left-drag
     alias, which was already there):
       · RIGHT-click            = move order for the current selection
       · RIGHT-drag             = draw a custom path for the current selection
                                  (ctrl-left-drag = formation line, unchanged)
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
      // Right-button gesture: click = move order, drag = freehand custom
      // path. Which one it is only becomes known on pointerup (>=12 world px
      // moved — see PATH_CLICK_THRESHOLD below), so start a 'path' gesture
      // and sample waypoints lazily as the drag grows.
      this._input = { mode: 'path', start: world, active: true, node: null, points: [world] };
      return true;
    }
    if (e.button !== 0) return false;
    if (e.shiftKey) {
      this._input = { mode: 'box', start: world, active: true, node: this._marqueeNode(map) };
      return true;
    }
    if (e.ctrlKey || e.metaKey) { // formation's surviving gesture, now that right-drag draws a path instead
      this._input = { mode: 'formation', start: world, active: true, node: this._formationNode(map) };
      return true;
    }
    if (this._spawnArmed && isGM()) {
      this._spawnArmed = false;
      if (!this.commandable()) { toast('The war has concluded — no units can be spawned.', true); this.renderToolbar(); return true; }
      this._doSpawn(world);
      this.renderToolbar();
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
    else if (this._input.mode === 'path') {
      const pts = this._input.points;
      const last = pts[pts.length - 1];
      // Sample waypoints ~25 world px apart — a point per pixel of mouse
      // movement would balloon the order (the engine caps at 200 anyway).
      if (Math.hypot(world[0] - last[0], world[1] - last[1]) >= this._pathSampleDist()) pts.push(world);
      if (!this._input.node) this._input.node = this._pathPreviewNode(map);
      this._updatePathPreview(this._input.node, pts, world);
    }
  },
  // Below this drag distance a right-button gesture is treated as a plain
  // click (move order), not a drawn path — matches the box/formation "tiny"
  // threshold in spirit but a bit larger since a path is a deliberate draw.
  _pathClickThreshold() { return 12; },
  _pathSampleDist() { return 25; },
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
        const war = (window.WarEngine && this.predictedWar()) || S().war;
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
    } else if (this._input.mode === 'path') {
      if (this._input.node && this._input.node.parentNode) this._input.node.parentNode.removeChild(this._input.node);
      if (this._sel.size) {
        if (!this.commandable()) { toast('The war has concluded — no orders can be issued.', true); }
        else if (Math.hypot(world[0] - start[0], world[1] - start[1]) < this._pathClickThreshold()) {
          // Task 5: a plain right-click (not a drag) with a selection first
          // hit-tests against enemy live units — clicking an enemy soldier
          // issues an attack/chase order instead of a plain move.
          const target = this._hitEnemyAt(world);
          if (target) this._issueAttack(target.id);
          else this._issueMove(world);
        } else {
          const pts = this._input.points.slice();
          const last = pts[pts.length - 1];
          if (Math.hypot(world[0] - last[0], world[1] - last[1]) >= 1) pts.push(world);
          if (pts.length >= 2) this._issuePath(pts); else this._issueMove(world);
        }
      }
    }
    this._input = null;
  },

  // Plain left-click on empty ground (map.js's svg-level pointerup, after the
  // dossier select() handlers stand down on the war layer): clear selection.
  onMapClick(e) {
    if (e.button !== 0) return;
    let changed = false;
    if (this._sel.size) { this._sel.clear(); changed = true; }
    if (this._inspect) { this._inspect = null; changed = true; } // Feature: unit info card — ground click clears inspection too
    if (changed && GameMap.render) GameMap.render();
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
      const had = this._sel.size || this._bombArmed || this._spawnArmed || this._inspect;
      this._sel.clear(); this._bombArmed = false; this._spawnArmed = false; this._input = null; this._inspect = null;
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
  _pathPreviewNode(map) {
    const NS = 'http://www.w3.org/2000/svg';
    const p = document.createElementNS(NS, 'polyline');
    p.setAttribute('class', 'war-path-preview');
    p.setAttribute('fill', 'none');
    map.world.appendChild(p);
    return p;
  },
  _updatePathPreview(node, points, cursor) {
    if (!node) return;
    const pts = points.concat([cursor]);
    node.setAttribute('points', pts.map(p => p[0] + ',' + p[1]).join(' '));
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
    const side = this.commandableSide();
    if (window.WarEngine) this._optimistic(side, orders); // arrows + movement start NOW; the POST confirms
    try { await POST('/api/war/command', { side, orders }); }
    catch (e) { toast(e.message, true); }
  },
  // Ctrl-drag formation: distribute the current selection along the line A→B,
  // nearest-in-order (sort both units and slots by their projection onto the
  // line direction, then pair them up 1:1) so units don't cross paths.
  async _issueFormation(a, b) {
    const war = (window.WarEngine && this.predictedWar()) || S().war;
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
    const side = this.commandableSide();
    if (window.WarEngine) this._optimistic(side, orders);
    try { await POST('/api/war/command', { side, orders }); }
    catch (e) { toast(e.message, true); }
  },
  // Right-drag custom path: every selected unit gets the SAME hand-drawn
  // polyline (clamped world points) and ignores road/rail routing entirely —
  // see engine.setManualPath / stepAlongPath's `manualPath` branch. Unlike
  // _issueMove/_issueFormation there's no per-unit spread; units that stack
  // up on the drawn line separate visually via the engine's FRIENDLY_SEP nudge.
  async _issuePath(points) {
    const ids = [...this._sel];
    if (!ids.length) return;
    const path = points.map(p => this._clamp(p));
    const orders = ids.map(id => ({ unitId: id, path }));
    const side = this.commandableSide();
    if (window.WarEngine) this._optimistic(side, orders); // arrows + movement start NOW; the POST confirms
    try { await POST('/api/war/command', { side, orders }); }
    catch (e) { toast(e.message, true); }
  },
  // Task 5: hit-test a world point against ENEMY live units of the predicted
  // war, using the same fixed-world symbol math the marker hitbox itself uses
  // (30 world px base radius, counter-scaled below WAR_FIXED_MODE_K) so "did
  // I click the enemy soldier" agrees with what's actually drawn on screen.
  _hitEnemyAt(pt) {
    const war = (window.WarEngine && this.predictedWar()) || S().war;
    if (!war) return null;
    const side = this.commandableSide();
    const k = GameMap.view ? GameMap.view.k : 1;
    const threshold = 30 * warMarkerScale(k);
    let best = null, bestD = threshold;
    for (const u of war.units) {
      if (u.side === side || u.dead || u.state === 'dead' || !(u.strength > 0)) continue;
      const d = Math.hypot(u.pos[0] - pt[0], u.pos[1] - pt[1]);
      if (d <= bestD) { best = u; bestD = d; }
    }
    return best;
  },
  // Explicit attack/chase order: every selected unit gets { unitId, attackId }
  // (the shape server/war.js's commandUnits + the engine's applyOrders accept
  // for a chase order — see docs/WAR.md "Explicit attack command"). Applied
  // optimistically ONCE, not pushed onto the outbox like _issueMove/_issuePath:
  // the outbox's "confirmed?" check reads o.dest, but a chasing unit's dest is
  // engine-managed state that the engine itself keeps re-targeting every tick
  // as the enemy moves — there's no stable point to compare against, so
  // re-applying a stale order on every rebase would fight the engine's own
  // tracking instead of just letting the next rebase/heartbeat reconcile it
  // (worst case: one tick of visual lag before the arrow appears, not a stuck
  // order).
  async _issueAttack(targetId) {
    const ids = [...this._sel];
    if (!ids.length) return;
    const orders = ids.map(id => ({ unitId: id, attackId: targetId }));
    const side = this.commandableSide();
    if (window.WarEngine) {
      const w = this.predictedWar();
      if (w) WarEngine.applyOrders(this._dbLike(w), side, orders);
      this.refreshLayer(true);
    }
    try { await POST('/api/war/command', { side, orders }); }
    catch (e) { toast(e.message, true); }
  },
  async _dropBomb(pos) {
    try {
      const r = await POST('/api/war/bomb', { side: this.commandableSide(), pos: this._clamp(pos) });
      // Insert the server-created strike into the predicted war IMMEDIATELY
      // (same optimistic-order spirit as _issueMove) — the plane and the
      // toolbar countdown start now instead of waiting for the next
      // heartbeat; the engine's deterministic stepAirstrikes then predicts
      // the blast locally at strikeTick, and rebases reconcile as usual.
      if (window.WarEngine && r && r.strike) {
        const war = this.predictedWar();
        if (war) {
          war.airstrikes = war.airstrikes || [];
          if (!war.airstrikes.some(s => s.id === r.strike.id)) war.airstrikes.push(JSON.parse(JSON.stringify(r.strike)));
          // Remember it in the "strike outbox" too — see _rebase's comment —
          // so a heartbeat that was already in flight when this order landed
          // (and therefore resolves with a snapshot from just before it)
          // doesn't silently drop the strike for a whole interval.
          if (this._pred) {
            (this._pred.strikeOutbox = this._pred.strikeOutbox || [])
              .push({ strike: JSON.parse(JSON.stringify(r.strike)), exp: Date.now() + 8000 });
          }
          this.refreshLayer(true);
        }
      }
      toast('Air wing scrambles — strike inbound.');
    } catch (e) { toast(e.message, true); }
  },
  // GM unit spawner (Feature: mid-war reinforcements) — placement click after
  // "Arm placement" in the War Room GM panel (see renderSpawner). Authority
  // (validation, clamping, war.mods.hp scaling) all lives server-side in
  // war.spawnUnits; this is just the click-to-position UI.
  async _doSpawn(pos) {
    const d = this._spawnDraft;
    try {
      await POST('/api/gm/war/spawn', {
        side: d.side, pos: this._clamp(pos), kind: d.kind,
        count: d.count, strength: d.strength, atk: d.atk, speed: d.speed
      });
      toast(`${d.count} ${d.kind} unit${d.count === 1 ? '' : 's'} deployed.`);
    } catch (e) { toast(e.message, true); }
  },

  // Tween duration ≈ one tick interval, so a unit glides continuously into
  // each new simulated position instead of the old fixed 900ms ease that left
  // it parked for the back half of every 2s tick (visible stop-start motion).
  _tweenMs() {
    const w = S() && S().war;
    const interval = ((w && w.tickMs) || 2000) / ((w && w.speed) || 1);
    return Math.min(2200, Math.max(250, interval));
  },

  /* ---------- shared animation loop ----------
     One rAF loop, started lazily, that both tweens unit positions (~900ms
     ease between server syncs) and counter-scales markers with the current
     map zoom, and fades battle-flash rings. Runs continuously while there is
     anything to animate; stops itself once both registries are empty so an
     ended/never-started war costs nothing. */
  ensureLoop() {
    if (this._raf) return;
    const step = (now) => {
      let any = false;
      for (const id in this._anim) {
        const e = this._anim[id];
        if (!e.node || !e.node.isConnected) { delete this._anim[id]; continue; }
        any = true;
        // LINEAR interpolation, deliberately not eased: legs chain tick to
        // tick, and an ease curve restarting on every leg made units
        // accelerate/decelerate 1-4× a second — visible stutter. Constant
        // velocity across chained legs reads as continuous marching.
        const k = Math.min(1, (now - e.t0) / (e.dur || 900));
        e.curPos = [e.from[0] + (e.to[0] - e.from[0]) * k, e.from[1] + (e.to[1] - e.from[1]) * k];
        const ar = this._arrowAnim[id];
        if (ar) {
          if (!ar.node.isConnected) delete this._arrowAnim[id];
          else ar.node.setAttribute('points', e.curPos[0] + ',' + e.curPos[1] + (ar.tail ? ' ' + ar.tail : ''));
        }
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
      // Airstrike planes — position is a pure function of predicted tick, so
      // every frame just recomputes it from the entry's captured timing/strike
      // rather than interpolating toward a stored target.
      for (const id in this._airstrikeAnim) {
        const e = this._airstrikeAnim[id];
        if (!e.node || !e.node.isConnected) { delete this._airstrikeAnim[id]; continue; }
        any = true;
        this._updatePlanePose(e);
      }
      // Impact explosion FX (fireball/shockwave/debris) — same recreate-
      // each-render + rAF-driven animation as the battle-flash rings above,
      // but keyed off Date.now() (matching _strikeImpactAt's epoch), NOT the
      // rAF timestamp `now` (which is performance.now()-based — a different
      // clock epoch entirely; mixing the two would make age wildly wrong).
      for (const id in this._explosionAnim) {
        const e = this._explosionAnim[id];
        if (!e.node || !e.node.isConnected) { delete this._explosionAnim[id]; continue; }
        any = true;
        const age = Date.now() - e.t0;
        if (age > e.life) { delete this._explosionAnim[id]; continue; }
        this._updateExplosion(e, age);
      }
      this._raf = any ? requestAnimationFrame(step) : null;
    };
    this._raf = requestAnimationFrame(step);
  },

  /* ═══════════ MAP LAYER ═══════════ */
  renderMapLayer(map, mk, NS) {
    // Render the PREDICTED war (rebased-on-authority + locally ticked), so
    // the front line the player sees is always at full cadence. Falls back
    // to the raw authoritative doc if the engine script failed to load.
    const war = (window.WarEngine && this.predictedWar()) || S().war;
    if (!war) {
      this._anim = {}; this._flashAnim = {};
      this._airstrikeAnim = {}; this._explosionAnim = {}; this._strikeImpactAt = {};
      this._lastStrength = {}; this._hitAt = {};
      this._removeToolbar(); this._removeUnitCard(); this._inspect = null;
      this._stopRealtime(); this._pred = null; return;
    }
    if (window.WarEngine) this._ensureRealtime();
    map.warLayer = document.createElementNS(NS, 'g');
    map.warLayer.setAttribute('class', 'war-layer');
    map.world.appendChild(map.warLayer);

    this.renderCraters(map, mk, NS, war);
    this.renderTerritory(map, mk, NS, war);
    this.renderMoveArrows(map, mk, NS, war);
    this.renderAttackArrows(map, mk, NS, war);
    this.renderUnits(map, mk, NS, war);
    this._checkAirstrikeLandings(war);
    this.renderAirstrikePlanes(map, mk, NS, war);
    this.renderExplosions(map, mk, NS, war);
    this.renderFlashes(map, mk, NS, war);
    this.ensureLoop();
    this.bindKeys();
    if (W.layer === 'war') { this.renderToolbar(); this.renderUnitCard(); }
    else { this._removeToolbar(); this._removeUnitCard(); }
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

    // Defender counter-occupation of attacker homeland (Phase 22) — a second
    // hatch in the defence's blue, drawn unclipped (country polygons aren't
    // per-province clip targets; the cells themselves are already rasterised
    // to the homeland, so a plain cell fill reads fine at map scale).
    const defPat = pat.cloneNode(true);
    defPat.setAttribute('id', 'war-hatch-def');
    for (const r of defPat.childNodes) r.setAttribute('fill', '#2f4a6e');
    defs.appendChild(defPat);
    let defD = '';
    const csDef = (war.grid && war.grid.cell) || 48;
    for (const key in (war.cells || {})) {
      const c = war.cells[key];
      if (c.o !== 'def') continue;
      const parts = key.split(',');
      defD += `M${Number(parts[0]) * csDef},${Number(parts[1]) * csDef} h${csDef} v${csDef} h${-csDef} z `;
    }
    if (defD) mk('path', { d: defD, fill: 'url(#war-hatch-def)', class: 'war-territory' }, map.warLayer);

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
    this._arrowAnim = {}; // rebuilt per layer render; the rAF loop keeps each tail pinned to its tweened marker
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
      this._arrowAnim[u.id] = { node: line, tail: pts.slice(1).map(p => p[0] + ',' + p[1]).join(' ') };
    }
  },

  // Task 5 (Explicit attack command): a red dashed arrow from every LIVE unit
  // chasing a target (u.attackId set, either by a player order or the AI/
  // engine) to that target's current position — distinct from the amber move
  // arrows above, drawn for BOTH sides (fog-of-war on intent only applies to
  // plain movement; an ongoing attack is already visible via combat itself).
  // `attackId` is absent until the engine agent's applyOrders wires it up —
  // this loop is then simply a no-op, same "additive/absent-safe" contract as
  // every other new war field.
  renderAttackArrows(map, mk, NS, war) {
    const defs = document.createElementNS(NS, 'defs');
    map.warLayer.appendChild(defs);
    const m = document.createElementNS(NS, 'marker');
    m.setAttribute('id', 'war-attackhead');
    m.setAttribute('viewBox', '0 0 10 10');
    m.setAttribute('refX', '8'); m.setAttribute('refY', '5');
    m.setAttribute('markerWidth', '5'); m.setAttribute('markerHeight', '5');
    m.setAttribute('orient', 'auto-start-reverse');
    const tip = document.createElementNS(NS, 'path');
    tip.setAttribute('d', 'M0,0 L10,5 L0,10 z');
    tip.setAttribute('class', 'war-attack-arrowhead');
    m.appendChild(tip);
    defs.appendChild(m);

    for (const u of war.units) {
      if (u.dead || u.state === 'dead' || !(u.strength > 0) || !u.attackId) continue;
      const target = war.units.find(t => t.id === u.attackId);
      if (!target || target.dead || target.state === 'dead' || !(target.strength > 0)) continue;
      const anim = this._anim[u.id];
      const from = anim && anim.curPos ? anim.curPos : u.pos;
      const tAnim = this._anim[target.id];
      const to = tAnim && tAnim.curPos ? tAnim.curPos : target.pos;
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', from[0]); line.setAttribute('y1', from[1]);
      line.setAttribute('x2', to[0]); line.setAttribute('y2', to[1]);
      line.setAttribute('class', 'war-attack-arrow');
      line.setAttribute('marker-end', 'url(#war-attackhead)');
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
    const seenIds = new Set(); // every unit id this pass, dead or alive — drives _lastStrength/_hitAt pruning
    const cmdSide = this.commandableSide();
    const canCommand = this.commandable();
    const scaleNow = warMarkerScale(map.view ? map.view.k : 1);
    // Task 5: units currently being chased (attackId points at them) get a
    // pulsing red ring, regardless of which side is doing the chasing.
    const attackTargets = new Set();
    for (const a of war.units) {
      if (a.attackId && !(a.dead || a.state === 'dead') && a.strength > 0) attackTargets.add(a.attackId);
    }
    for (const u of war.units) {
      seenIds.add(u.id);
      const isDead = u.dead || u.state === 'dead';
      const clickable = canCommand && !isDead && u.side === cmdSide;
      // Task 4: enemy LIVE markers become inspectable (own-side units already
      // select via `clickable` above) — crosshair cursor doubles as the
      // attack-targeting affordance once a friendly selection exists.
      const inspectable = !isDead && u.side !== cmdSide;
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', `war-unit war-side-${u.side} war-state-${u.state}` +
        (isDead ? ' war-unit-dead' : '') + (this._sel.has(u.id) ? ' war-unit-sel' : '') +
        (clickable ? ' war-unit-cmd' : '') + (u.nationId ? ' war-unit-ally' : '') +
        (inspectable ? ' war-unit-inspect' + (this._sel.size > 0 ? ' war-attackable' : '') : '') +
        (!isDead && u.supplied === false ? ' war-unit-cutoff' : ''));
      g.setAttribute('data-warunit', u.id);
      if (clickable) {
        // Left-click selects / shift-toggles. Propagation is stopped on BOTH
        // pointerdown (so the map never starts pan bookkeeping under the
        // click) and pointerup (so the svg-level empty-ground deselect never
        // fires); the actual selection happens on pointerup, after which the
        // re-render can safely tear the node down. Right-clicks fall through
        // to the svg (a move order may target a friendly's position), and an
        // ARMED BOMB or ARMED SPAWN click also falls through so it lands on
        // the map point rather than selecting the unit underneath it.
        g.addEventListener('pointerdown', (e) => {
          if (e.button !== 0 || this._bombArmed || this._spawnArmed) return;
          e.stopPropagation();
        });
        g.addEventListener('pointerup', (e) => {
          if (e.button !== 0 || this._bombArmed || this._spawnArmed) return;
          e.stopPropagation();
          this.onUnitClick(u.id, e);
        });
      } else if (inspectable) {
        // Task 4: enemy inspection — mirrors the own-unit listener pattern,
        // but LEFT-BUTTON ONLY and deliberately no pointerdown handler at all
        // (unlike the own-unit case above) so a plain left-drag starting over
        // an enemy marker still pans the map normally; only pointerup (a
        // motionless click) is intercepted, and only enough to stop it
        // reaching the svg-level empty-ground deselect.
        g.addEventListener('pointerup', (e) => {
          if (e.button !== 0 || this._bombArmed || this._spawnArmed) return;
          e.stopPropagation();
          this._inspect = u.id;
          if (GameMap.render) GameMap.render();
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

      // Feature: unit damage feedback — compare this pass's strength against
      // the last one seen for this unit; a drop (from combat OR an airstrike)
      // stamps _hitAt, which drives the war-unit-hit jitter/flash below for
      // ~WAR_HIT_FX_MS. Read over the PREDICTED war, same as everything else
      // this method reads, so the flash fires the instant a local tick
      // predicts the hit, not only after the next server snapshot.
      const prevStrength = this._lastStrength[u.id];
      if (prevStrength !== undefined && u.strength < prevStrength - 0.001) this._hitAt[u.id] = Date.now();
      this._lastStrength[u.id] = u.strength;
      const hitAge = Date.now() - (this._hitAt[u.id] || -1e9);
      const isHit = hitAge < WAR_HIT_FX_MS;

      liveIds.add(u.id);
      const prevAnim = this._anim[u.id];
      // If the unit's target hasn't changed since the last render (a war-layer
      // refresh mid-leg — heartbeat rebase, selection change, toolbar render),
      // KEEP the in-flight leg and just rebind the fresh node: recreating the
      // leg from curPos restarted the motion clock and made units crawl-and-
      // freeze instead of gliding. A new target starts a new linear leg.
      const sameLeg = prevAnim && prevAnim.to &&
        Math.abs(prevAnim.to[0] - u.pos[0]) < 0.5 && Math.abs(prevAnim.to[1] - u.pos[1]) < 0.5;
      const from = prevAnim ? (prevAnim.curPos || prevAnim.to) : u.pos;
      // NB: this outer <g>'s transform is rewritten every rAF frame by
      // ensureLoop — the hit jitter/flash below deliberately lives on an
      // INNER <g> instead (see war-unit-inner), never here.
      g.setAttribute('transform', `translate(${from[0]},${from[1]}) scale(${scaleNow})`);

      if (u.state === 'fighting') {
        const ring = document.createElementNS(NS, 'circle');
        ring.setAttribute('r', 30); ring.setAttribute('class', 'war-fight-ring');
        g.appendChild(ring);
        // Optional tasteful flourish: a couple of small blinking muzzle ticks
        // while actively engaged, beyond the existing pulsing fight ring.
        const muzzle = document.createElementNS(NS, 'g');
        muzzle.setAttribute('class', 'war-muzzle');
        muzzle.setAttribute('transform', 'translate(15,-6)');
        const tick1 = document.createElementNS(NS, 'line');
        tick1.setAttribute('x1', 0); tick1.setAttribute('y1', 0); tick1.setAttribute('x2', 7); tick1.setAttribute('y2', -3);
        tick1.setAttribute('class', 'war-muzzle-tick');
        muzzle.appendChild(tick1);
        const tick2 = document.createElementNS(NS, 'line');
        tick2.setAttribute('x1', 0); tick2.setAttribute('y1', 0); tick2.setAttribute('x2', 6); tick2.setAttribute('y2', 4);
        tick2.setAttribute('class', 'war-muzzle-tick');
        muzzle.appendChild(tick2);
        g.appendChild(muzzle);
      }
      if (attackTargets.has(u.id)) {
        const aRing = document.createElementNS(NS, 'circle');
        aRing.setAttribute('r', 34); aRing.setAttribute('class', 'war-attack-ring');
        g.appendChild(aRing);
      }
      if (this._sel.has(u.id)) {
        const selRing = document.createElementNS(NS, 'circle');
        selRing.setAttribute('r', 30); selRing.setAttribute('class', 'war-sel-ring');
        g.appendChild(selRing);
      }

      // Feature: unit damage feedback — box+glyph live inside an inner <g> so
      // the war-unit-hit jitter (a CSS transform animation) never fights the
      // outer group's JS-driven translate/scale attribute (rewritten by
      // ensureLoop every frame).
      const inner = document.createElementNS(NS, 'g');
      inner.setAttribute('class', 'war-unit-inner' + (isHit ? ' war-unit-hit' : ''));
      g.appendChild(inner);
      const box = document.createElementNS(NS, 'rect');
      box.setAttribute('x', -20); box.setAttribute('y', -14); box.setAttribute('width', 40); box.setAttribute('height', 28);
      box.setAttribute('class', 'war-unit-box');
      inner.appendChild(box);
      if (isHit) {
        const flash = document.createElementNS(NS, 'rect');
        flash.setAttribute('x', -20); flash.setAttribute('y', -14); flash.setAttribute('width', 40); flash.setAttribute('height', 28);
        flash.setAttribute('class', 'war-hit-flash');
        inner.appendChild(flash);
      }
      const glyph = document.createElementNS(NS, 'text');
      glyph.setAttribute('class', 'war-unit-glyph');
      glyph.setAttribute('text-anchor', 'middle'); glyph.setAttribute('y', 5);
      glyph.textContent = WAR_KIND_GLYPH[u.kind] || '?';
      inner.appendChild(glyph);

      // Task 6: supply cut-off glyph, top-right corner of the symbol.
      if (u.supplied === false) {
        const warn = document.createElementNS(NS, 'text');
        warn.setAttribute('x', 15); warn.setAttribute('y', -11);
        warn.setAttribute('class', 'war-unit-cutoff-glyph');
        warn.textContent = '⚠';
        g.appendChild(warn);
      }

      // Task 3: morale bar, above the HP bar (HP sits at y=-22 h4).
      const org = typeof u.org === 'number' ? u.org : 100;
      const orgPct = Math.max(0, Math.min(100, org));
      const routed = u.state === 'routed';
      const moraleBg = document.createElementNS(NS, 'rect');
      moraleBg.setAttribute('x', -20); moraleBg.setAttribute('y', -28); moraleBg.setAttribute('width', 40); moraleBg.setAttribute('height', 3);
      moraleBg.setAttribute('class', 'war-morale-bg');
      g.appendChild(moraleBg);
      const moraleFill = document.createElementNS(NS, 'rect');
      moraleFill.setAttribute('x', -20); moraleFill.setAttribute('y', -28); moraleFill.setAttribute('width', 40 * orgPct / 100); moraleFill.setAttribute('height', 3);
      moraleFill.setAttribute('class', 'war-morale-fill' + (orgPct < WAR_ROUT_ORG ? ' war-morale-danger' : '') + (routed ? ' war-morale-pulse' : ''));
      g.appendChild(moraleFill);

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
      title.textContent = `${u.name} — ${Math.round(u.strength)}/${u.maxStrength} · ${u.state} · Morale ${Math.round(orgPct)}%` +
        (u.nationId ? ` · ${entName(u.nationId)} contingent` : '') +
        (u.supplied === false ? ' · CUT OFF' : '');
      g.appendChild(title);
      map.warLayer.appendChild(g);

      if (sameLeg) { prevAnim.node = g; }
      else this._anim[u.id] = { from: from.slice(), to: u.pos.slice(), t0: performance.now(), dur: this._tweenMs(), curPos: from.slice(), node: g };
    }
    for (const id in this._anim) if (!liveIds.has(id)) delete this._anim[id];
    for (const id in this._lastStrength) if (!seenIds.has(id)) { delete this._lastStrength[id]; delete this._hitAt[id]; }
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

  /* ═══════════ CINEMATIC AIRSTRIKES (Feature: two-phase bombing) ═══════════
     A strike's DAMAGE is decided by the shared engine (stepAirstrikes) at
     strikeTick — identically on server and predicting client. Everything
     below is purely cosmetic dressing around that moment: a plane that flies
     from the airport out to a turn-in point and back through the target
     timed to strikeTick, then a fireball/shockwave/debris explosion the
     instant the strike's `done` flag is first observed true. None of it
     feeds back into
     gameplay, so it's safe to get wrong on any given client — the next
     rebase just carries on from wherever the predicted war actually is. */

  // Continuous (fractional) predicted tick — same idea as the rest of the
  // client's tick-driven interpolation (_tweenMs et al): war.tick is the last
  // whole tick, war._lastTick is the wall-clock moment that tick landed, so
  // "how far into the NEXT tick are we" comes from elapsed real time.
  _continuousTick(war) {
    const interval = Math.max(200, (war.tickMs || 2000) / (war.speed || 1));
    const since = Date.now() - (war._lastTick || Date.now());
    return (war.tick || 0) + Math.max(0, Math.min(1, since / interval));
  },

  // Where the plane is (world pos), which way it's facing (degrees, for the
  // silhouette's rotation) and how opaque it should be, purely as a function
  // of the strike's timing fields and "now". Three legs:
  //   1. [0, 0.3)  climb-out: `from` → a turn-in point FAR from the target
  //   2. [0.3, 1]  attack run: turn-in point → `pos`, arriving exactly at
  //                strikeTick (t=1) — this is what makes the plane cross the
  //                target as the blast (computed by the engine) lands.
  //   3. (1, ∞)    egress: peel away back toward `from`, fading out over
  //                AIRSTRIKE_EGRESS_TICKS.
  _planeState(strike, timing) {
    const interval = Math.max(200, timing.tickMs / timing.speed);
    const nowTick = timing.tick + Math.max(0, Math.min(1, (Date.now() - timing.lastTick) / interval));
    const span = Math.max(1, strike.strikeTick - strike.orderedTick);
    const tOverall = (nowTick - strike.orderedTick) / span;
    const from = strike.from, target = strike.pos;
    const dx = from[0] - target[0], dy = from[1] - target[1];
    const dm = Math.hypot(dx, dy) || 1;
    const away = [dx / dm, dy / dm];
    const far = [from[0] + away[0] * AIRSTRIKE_FAR_OFFSET, from[1] + away[1] * AIRSTRIKE_FAR_OFFSET];
    const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    const heading = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
    if (tOverall <= 0) return { pos: from.slice(), angle: heading(from, far), opacity: 1 };
    if (tOverall < 0.3) {
      const k = tOverall / 0.3;
      return { pos: lerp(from, far, k), angle: heading(from, far), opacity: 1 };
    }
    if (tOverall <= 1) {
      const k = (tOverall - 0.3) / 0.7;
      return { pos: lerp(far, target, k), angle: heading(far, target), opacity: 1 };
    }
    const k = Math.min(1, ((tOverall - 1) * span) / AIRSTRIKE_EGRESS_TICKS);
    return { pos: lerp(target, from, k * 0.6), angle: heading(target, from), opacity: 1 - k, egressDone: k >= 1 };
  },
  _updatePlanePose(e) {
    if (!e.node || !e.node.isConnected) return;
    const st = this._planeState(e.strike, e.timing);
    const scale = warMarkerScale(GameMap.view ? GameMap.view.k : 1);
    e.node.setAttribute('transform', `translate(${st.pos[0]},${st.pos[1]}) scale(${scale}) rotate(${st.angle})`);
    e.node.style.opacity = String(Math.max(0, st.opacity));
  },
  // A swept-wing dart silhouette pointing along +X at rotate(0), so `angle`
  // from _planeState (an atan2 in degrees) can be applied directly.
  _makePlaneNode(map, NS) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'war-plane');
    const body = document.createElementNS(NS, 'path');
    body.setAttribute('d', 'M12,0 L-7,-7 L-2,0 L-7,7 Z');
    body.setAttribute('class', 'war-plane-body');
    g.appendChild(body);
    map.warLayer.appendChild(g);
    return g;
  },
  // One node per in-flight strike, recreated each render pass (the whole
  // war-layer group is torn down and rebuilt every render — same reasoning
  // as renderUnits/renderMoveArrows). Position itself is recomputed by the
  // rAF loop every frame from `timing` + `strike`, not tweened, since it's a
  // pure function of predicted tick rather than a snapshot-to-snapshot leg.
  renderAirstrikePlanes(map, mk, NS, war) {
    const activeIds = new Set();
    const timing = { tick: war.tick || 0, lastTick: war._lastTick || Date.now(), tickMs: war.tickMs || 2000, speed: war.speed || 1 };
    for (const s of (war.airstrikes || [])) {
      const span = Math.max(1, s.strikeTick - s.orderedTick);
      const state = this._planeState(s, timing);
      if (state.egressDone) continue; // fully faded — nothing to draw
      activeIds.add(s.id);
      const node = this._makePlaneNode(map, NS);
      const entry = { node, strike: s, timing };
      this._airstrikeAnim[s.id] = entry;
      this._updatePlanePose(entry);
    }
    for (const id in this._airstrikeAnim) if (!activeIds.has(id)) delete this._airstrikeAnim[id];
  },

  // Detect the FIRST render where a strike's `done` flag reads true (works
  // identically whether that came from a real predicted tick or a rebase
  // catch-up) and stamp the one-shot impact FX timing exactly once per strike
  // — idempotent across re-renders and rebases since it's keyed by strike id,
  // not by any per-frame state. The actual explosion is built by
  // renderExplosions below, keyed off this same map.
  _checkAirstrikeLandings(war) {
    for (const s of (war.airstrikes || [])) {
      if (s.done && !(s.id in this._strikeImpactAt)) {
        this._strikeImpactAt[s.id] = Date.now();
      }
    }
  },
  // A radialGradient helper — stops is an array of [offset(0-1), color, opacity].
  _radialGrad(NS, id, stops) {
    const grad = document.createElementNS(NS, 'radialGradient');
    grad.setAttribute('id', id);
    for (const [off, color, op] of stops) {
      const stop = document.createElementNS(NS, 'stop');
      stop.setAttribute('offset', String(off));
      stop.setAttribute('stop-color', color);
      stop.setAttribute('stop-opacity', String(op));
      grad.appendChild(stop);
    }
    return grad;
  },
  // Task 1: soft nuclear-flash impact FX, modelled directly on neal.fun's
  // Asteroid Launcher (frame-by-frame from a 24fps reference capture):
  //   · 0-650ms   a huge soft warm-white BLOOM (pure radial-gradient falloff,
  //               no hard edges) washes over ~3× the blast radius, with a
  //               flattened horizontal lens streak — the anamorphic-flare look;
  //   · 250ms+    a bright CORE ball sits at ground zero and slowly shrinks
  //               into a small warm ember that lingers to the very end;
  //   · 480-2750ms a delicate soap-bubble SHOCKWAVE ring detaches and expands
  //               slowly to ~2.6× the blast radius — a blurred wide band plus
  //               a thinner bright rim, never a crisp stroke;
  //   · no debris lines, no turbulence displacement — the reference reads as
  //   pure light, and the soft gradients are also far cheaper to composite.
  // Recreated each render (the whole war-layer is torn down every render,
  // same reasoning as the hatch pattern / arrowhead defs) and then animated
  // frame-to-frame by ensureLoop → _updateExplosion, keyed off
  // _strikeImpactAt so it survives full-layer rebuilds without restarting.
  renderExplosions(map, mk, NS, war) {
    const now = Date.now();
    const byId = {};
    for (const s of (war.airstrikes || [])) byId[s.id] = s;
    const bombR = (window.WarEngine && WarEngine.BOMB_RADIUS) || 95;
    let defs = null; // built lazily — only when at least one explosion is live this pass
    for (const id in this._strikeImpactAt) {
      const strike = byId[id];
      // Forget the impact stamp ONLY once the strike has left the war doc
      // entirely (the engine prunes it AIRSTRIKE_PRUNE_TICKS after impact).
      // The old code deleted it the moment the FX finished — but the strike
      // was still in war.airstrikes with done:true, so _checkAirstrikeLandings
      // immediately re-stamped it on the next render and the explosion
      // REPLAYED every EXPLOSION_LIFE_MS until the prune finally caught up.
      if (!strike) { delete this._strikeImpactAt[id]; delete this._explosionAnim[id]; continue; }
      const t0 = this._strikeImpactAt[id];
      const age = now - t0;
      if (age > EXPLOSION_LIFE_MS) { delete this._explosionAnim[id]; continue; } // FX over — keep the stamp (see above)

      if (!defs) {
        defs = document.createElementNS(NS, 'defs');
        map.warLayer.appendChild(defs);
        // Shared by every simultaneous explosion — the reference effect has
        // no per-strike variance (every neal.fun impact looks the same), so
        // fixed ids are fine and per-strike turbulence seeds are gone.
        defs.appendChild(this._radialGrad(NS, 'war-nuke-bloom', [
          [0, '#ffffff', .95], [0.25, '#fff4dc', .8], [0.5, '#ffdfbc', .5], [0.75, '#ffc9a6', .22], [1, '#ffc9a6', 0]
        ]));
        defs.appendChild(this._radialGrad(NS, 'war-nuke-core', [
          [0, '#ffffff', 1], [0.55, '#fff1cf', .95], [0.85, '#ffc38f', .5], [1, '#ffc38f', 0]
        ]));
        const soft = document.createElementNS(NS, 'filter');
        soft.setAttribute('id', 'war-nuke-soft');
        soft.setAttribute('x', '-50%'); soft.setAttribute('y', '-50%');
        soft.setAttribute('width', '200%'); soft.setAttribute('height', '200%');
        const blur = document.createElementNS(NS, 'feGaussianBlur');
        blur.setAttribute('stdDeviation', '5');
        soft.appendChild(blur);
        defs.appendChild(soft);
      }

      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'war-explosion');
      g.setAttribute('transform', `translate(${strike.pos[0]},${strike.pos[1]})`);

      // 1. horizontal lens streak (under the bloom, same gradient — a
      //    radialGradient in objectBoundingBox units stretches to the
      //    ellipse's own box, giving the flattened flare for free)
      const streak = document.createElementNS(NS, 'ellipse');
      streak.setAttribute('fill', 'url(#war-nuke-bloom)');
      g.appendChild(streak);
      // 2. the big soft bloom wash
      const bloom = document.createElementNS(NS, 'circle');
      bloom.setAttribute('fill', 'url(#war-nuke-bloom)');
      g.appendChild(bloom);
      // 3. shockwave bubble: a blurred wide band + a thinner bright rim
      const ring = document.createElementNS(NS, 'circle');
      ring.setAttribute('fill', 'none'); ring.setAttribute('stroke', '#ffffff');
      ring.setAttribute('filter', 'url(#war-nuke-soft)');
      g.appendChild(ring);
      const rim = document.createElementNS(NS, 'circle');
      rim.setAttribute('fill', 'none'); rim.setAttribute('stroke', '#ffffff');
      g.appendChild(rim);
      // 4. the core ball / lingering ember (on top of everything)
      const core = document.createElementNS(NS, 'circle');
      core.setAttribute('fill', 'url(#war-nuke-core)');
      g.appendChild(core);

      map.warLayer.appendChild(g);
      const entry = { node: g, streak, bloom, ring, rim, core, t0, life: EXPLOSION_LIFE_MS, bombR };
      this._explosionAnim[id] = entry;
      this._updateExplosion(entry, age);
    }
  },
  // Age-driven pose for one explosion — called once at creation (renderExplosions)
  // and then every rAF frame (ensureLoop) so the FX keeps animating between
  // the (throttled) war-layer rebuilds. All timings below are the reference
  // capture's, scaled to EXPLOSION_LIFE_MS = 2900.
  _updateExplosion(e, age) {
    const bombR = e.bombR;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const easeOut = (k) => 1 - Math.pow(1 - clamp01(k), 3);

    // 1+2. bloom wash (and its lens streak): grows fast to ~3× blast radius
    // with a slow residual creep, full brightness almost instantly, holds to
    // ~650ms, then bleeds away by ~1600ms.
    const bloomR = Math.max(0.01, bombR * 3.0 * (0.92 * easeOut(age / 450) + 0.08 * clamp01(age / e.life)));
    const bloomOp = age < 650 ? clamp01(age / 120) : clamp01(1 - (age - 650) / 950);
    e.bloom.setAttribute('r', String(bloomR));
    e.bloom.style.opacity = String(bloomOp);
    e.streak.setAttribute('rx', String(bloomR * 1.9));
    e.streak.setAttribute('ry', String(Math.max(0.01, bloomR * 0.22)));
    e.streak.style.opacity = String(bloomOp * 0.65);

    // 3. shockwave bubble: detaches at ~480ms, expands slowly (ease-out) to
    // ~2.6× blast radius by ~2750ms, softening and fading the whole way.
    const rt = clamp01((age - 480) / (2750 - 480));
    const rk = 1 - Math.pow(1 - rt, 2);
    const ringR = Math.max(0.01, bombR * (0.55 + 2.05 * rk));
    const ringW = Math.max(1, bombR * (0.30 - 0.20 * rk));
    const ringOp = clamp01((age - 480) / 150) * (1 - rt) * 0.9;
    e.ring.setAttribute('r', String(ringR));
    e.ring.setAttribute('stroke-width', String(ringW));
    e.ring.style.opacity = String(ringOp);
    e.rim.setAttribute('r', String(ringR * 0.985));
    e.rim.setAttribute('stroke-width', String(Math.max(0.5, ringW * 0.35)));
    e.rim.style.opacity = String(Math.min(1, ringOp * 1.25));

    // 4. core → ember: swells to ~0.55× blast radius by 250ms, then shrinks
    // steadily into a small warm ember (~0.1×) that only fades out at the
    // very end — the lingering glow at ground zero in the reference.
    const coreR = Math.max(0.01, bombR * 0.55 * easeOut(age / 250) * (1 - 0.82 * clamp01((age - 250) / 2250)));
    const coreOp = age < 1700 ? 1 : clamp01(1 - (age - 1700) / 1050);
    e.core.setAttribute('r', String(coreR));
    e.core.style.opacity = String(coreOp);
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
    // The predicted war (when available) gives a smoother countdown than the
    // authoritative doc — same reasoning as every other tick-driven readout.
    const predWar = (window.WarEngine && this.predictedWar()) || war;
    const bar = el('div#war-toolbar.war-toolbar');
    bar.appendChild(el('div.war-toolbar-hint', live
      ? 'Click soldier: select (Shift adds) · Right-click: move · Right-click enemy: attack · Right-drag: draw path · Ctrl-drag: formation · Shift-drag: box · Click ground / Esc: deselect'
      : 'This war has concluded — units can be reviewed but no longer commanded.'));
    const row = el('div.btn-row');
    // Airstrikes are DEFENDER-ONLY (server-enforced in dropBomb / the
    // /api/war/bomb route) — a GM commanding the attacker gets a disabled
    // button + hint instead of a call that would only bounce off the server.
    const bombBtn = (side === 'att')
      ? el('button.dash-btn', { disabled: 'disabled', title: 'The invader has no air arm.' }, '✈ No air arm')
      : el('button.dash-btn', {
          class: (this._bombArmed ? 'active' : '') , disabled: (onCooldown || !live) ? 'disabled' : undefined,
          onclick: () => { if (!live) return; this._bombArmed = !this._bombArmed; if (this._bombArmed) this._spawnArmed = false; this.renderToolbar(); }
        }, !live ? '✈ Call Airstrike' : onCooldown ? `Air wing rearming — ${Math.ceil((bomb.cooldownUntil - now) / 1000)}s` : (this._bombArmed ? 'Airstrike armed — click the target' : '✈ Call Airstrike'));
    row.appendChild(bombBtn);
    if (side === 'att') this._bombArmed = false; // never leave an airstrike armed while commanding the side that has none
    // Countdown chip for a pending (not-yet-landed) strike this side ordered —
    // visible even after clicking away from the arming flow, since the plane
    // is airborne for several seconds.
    const pendingStrike = (predWar.airstrikes || []).find(s => !s.done && s.side === side);
    if (pendingStrike) {
      const remainingTicks = Math.max(0, pendingStrike.strikeTick - this._continuousTick(predWar));
      const interval = Math.max(200, (predWar.tickMs || 2000) / (predWar.speed || 1));
      const remainingS = Math.ceil((remainingTicks * interval) / 1000);
      row.appendChild(el('div.chip.active', `✈ Strike inbound — ${remainingS}s`));
    }
    row.appendChild(el('button.dash-btn', {
      onclick: () => { this._sel.clear(); this._bombArmed = false; this._spawnArmed = false; if (GameMap.render) GameMap.render(); }
    }, 'Clear selection'));
    // GM unit spawner (Feature: mid-war reinforcements) — the "Arm placement"
    // button lives in the War Room GM panel (renderSpawner), but the armed
    // state and its cancel action surface here too since arming happens on
    // one view and the placement click happens on the map layer.
    if (isGM() && this._spawnArmed) {
      row.appendChild(el('button.dash-btn.active', {
        onclick: () => { this._spawnArmed = false; this.renderToolbar(); }
      }, `🪖 Spawn armed (${this._spawnDraft.side === 'att' ? 'Att' : 'Def'}) — click target`));
    }
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
    // Re-render the toolbar (+ the unit info card, same lifecycle) periodically
    // so the bomb cooldown / HP / morale / supply readouts stay live without
    // waiting for the next server sync.
    if (!this._toolbarTimer) {
      this._toolbarTimer = setInterval(() => {
        if (W.layer === 'war' && this.active()) { this.renderToolbar(); this.renderUnitCard(); }
        else { this._removeToolbar(); this._removeUnitCard(); }
      }, 1000);
    }
  },
  _removeToolbar() {
    const bar = document.getElementById('war-toolbar');
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    if (this._toolbarTimer) { clearInterval(this._toolbarTimer); this._toolbarTimer = null; }
  },

  // Task 4: floating unit info card — shown while exactly one unit is
  // selected (own side) OR an enemy unit is under _inspect (no single
  // selection active). Re-read the unit fresh from the predicted war each
  // call so it reflects the latest HP/morale/supply, and so a unit that died
  // since the card was opened degrades gracefully instead of showing stale
  // stats. Same lifecycle as the toolbar: rebuilt on every war-layer render
  // and on the toolbar's 1s timer, removed the instant the layer changes.
  renderUnitCard() {
    const old = document.getElementById('war-unit-card');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const war = (window.WarEngine && this.predictedWar()) || S().war;
    if (!war) return;
    let unitId = null;
    if (this._sel.size === 1) unitId = [...this._sel][0];
    else if (this._inspect) unitId = this._inspect;
    if (!unitId) return;
    const u = war.units.find(x => x.id === unitId);
    const wrap = document.getElementById('map-wrap');
    if (!wrap) return;
    const card = el('div#war-unit-card.war-unit-card');
    if (!u) {
      card.appendChild(el('div.war-card-title', 'Unit unavailable'));
      card.appendChild(el('div.war-card-row', 'This unit has been destroyed or is no longer tracked.'));
      wrap.appendChild(card);
      return;
    }
    const isDead = u.dead || u.state === 'dead';
    const glyph = WAR_KIND_GLYPH[u.kind] || '?';
    const kindLabel = (u.kind || '?').replace(/^./, (c) => c.toUpperCase());
    card.appendChild(el('div.war-card-title', `${glyph} ${u.name}`));
    card.appendChild(el('div.war-card-sub',
      `${kindLabel} · ${u.side === 'att' ? 'Attacker' : 'Defender'}` +
      (u.nationId ? ` · ${entName(u.nationId)} contingent` : '')));
    if (isDead) {
      card.appendChild(el('div.war-card-row', 'Status: destroyed'));
    } else {
      const pct = Math.max(0, Math.min(1, u.strength / (u.maxStrength || u.strength || 1)));
      card.appendChild(el('div.war-card-row', `HP: ${Math.round(u.strength)}/${u.maxStrength}`));
      card.appendChild(el('div.war-card-bar', el('div.war-card-bar-fill', { style: `width:${Math.round(pct * 100)}%;` })));
      const org = typeof u.org === 'number' ? u.org : 100;
      const orgPct = Math.max(0, Math.min(100, org));
      card.appendChild(el('div.war-card-row', `Morale: ${Math.round(orgPct)}%`));
      card.appendChild(el('div.war-card-bar', el('div.war-card-bar-fill.war-card-bar-morale',
        { class: orgPct < WAR_ROUT_ORG ? 'danger' : '', style: `width:${orgPct}%;` })));
      card.appendChild(el('div.war-card-row', `State: ${u.state}${u.garrison ? ' · garrison' : ''}`));
      card.appendChild(el('div.war-card-row', `Speed: ${u.speed} · Atk: ${u.atk}`));
      card.appendChild(el('div.war-card-row',
        u.supplied === false ? el('span.war-card-cutoff', '⚠ CUT OFF') : 'In supply'));
    }
    wrap.appendChild(card);
  },
  _removeUnitCard() {
    const card = document.getElementById('war-unit-card');
    if (card && card.parentNode) card.parentNode.removeChild(card);
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
    // A viewer parked on this panel (map not mounted) still drives the
    // heartbeat, keeping the authoritative war ticking and the counters live.
    if (war.active && window.WarEngine) this._ensureRealtime();

    const elapsed = Math.round((Date.now() - new Date(war.startedAt).getTime()) / 1000);
    const mm = Math.floor(elapsed / 60), ss = elapsed % 60;
    const statusText = war.result ? (war.result.winner === 'att' ? 'ENDED — TOTAL VICTORY FOR THE INVADER' : war.result.winner === 'def' ? 'ENDED — INVASION REPELLED' : 'ENDED') : (war.paused ? 'PAUSED' : (war.totalWar ? 'TOTAL WAR — NO TERMS' : 'IN PROGRESS'));
    inner.appendChild(el('div.doc-sub', `${war.name} · tick ${war.tick} · ${mm}m ${ss}s elapsed · ${statusText}`));

    inner.appendChild(Views.statStrip([
      ['Attacker Losses', fmtNum(Math.round(war.stats.attLosses))],
      ['Defender Losses', fmtNum(Math.round(war.stats.defLosses))],
      ['Civilian Dead', fmtCompact(war.stats.civilianDeaths || 0)],
      ['Refugees', fmtCompact(war.stats.refugees || 0)],
      ['Cities Held', String((war.stats.citiesHeld || []).length)],
      ['Speed', war.speed + '×']
    ]));

    // Equipment quality (Phase 23) — what each army's arsenal is worth in the
    // field. Multipliers come from war.equip (guns/fuel stocks, server-computed).
    if (war.equip && (war.equip.att || war.equip.def)) {
      const fmtEq = (e) => e ? `dmg ${e.dmg}× · armour ${e.hp}× · morale ${e.morale}× · speed ${e.speed}×` : '—';
      inner.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:10px; color:var(--ink-faint); margin:4px 0 8px; letter-spacing:.04em;' },
        el('div', 'ATTACKER ARSENAL  ' + fmtEq(war.equip.att)),
        el('div', 'DEFENDER ARSENAL  ' + fmtEq(war.equip.def))));
    }

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

    // Defender counter-invasion of attacker home soil (Phase 22)
    const enemyCtl = war.stats.enemyControl || {};
    const enemyIds = Object.keys(enemyCtl).filter(cid => enemyCtl[cid] > 0);
    if (enemyIds.length) {
      inner.appendChild(Views.secLabel('Enemy Homeland Occupied'));
      const box = el('div');
      const countries = ((S().settings || {}).map || {}).countries || [];
      for (const cid of enemyIds) {
        const c = countries.find(x => x.id === cid);
        box.appendChild(Views.barRow(c ? c.name : cid, enemyCtl[cid], '#2f4a6e'));
      }
      inner.appendChild(box);
    }

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
    if (!this._scenarioList) this._ensureScenarioList(); // kicks off the fetch; this render uses the fallback until it resolves
    const list = (this._scenarioList && this._scenarioList.length) ? this._scenarioList : WAR_SCENARIOS_FALLBACK;
    const sel = el('select.text-input', list.map(s => el('option', { value: s.id },
      `${s.name} — ${s.attackerName} invades ${s.defenderName}`)));
    inner.appendChild(el('div.btn-row', sel, el('button.solid-btn', {
      onclick: async () => {
        try { await POST('/api/gm/war/start', { scenario: sel.value }); toast('The invasion begins.'); }
        catch (e) { toast(e.message, true); }
      }
    }, '⚔ Start War')));
  },

  // GM unit spawner (Feature: mid-war reinforcements) — side/kind/count/HP/
  // damage/speed controls, then "Arm placement" hands off to a map click
  // (see onMapPointerDown's _spawnArmed branch and _doSpawn). Mirrors the
  // bomb-arming flow: armed state shows on the floating war toolbar too, and
  // Esc disarms it (see bindKeys).
  renderSpawner(inner, war) {
    inner.appendChild(Views.secLabel('Spawn Units'));
    const d = this._spawnDraft;
    const box = el('div');
    box.appendChild(Forms.field('Side', el('div.btn-row',
      el('button.dash-btn', { class: d.side === 'att' ? 'active' : '', onclick: () => { d.side = 'att'; this._reRenderPanel(); } }, 'Attacker'),
      el('button.dash-btn', { class: d.side === 'def' ? 'active' : '', onclick: () => { d.side = 'def'; this._reRenderPanel(); } }, 'Defender')
    )));
    box.appendChild(Forms.field('Kind', Forms.sel(d, 'kind', WAR_SPAWN_KINDS)));
    box.appendChild(Forms.field('Count', Forms.sliderNum(d, 'count', 1, 12, { step: 1 })));
    box.appendChild(Forms.field('HP (strength)', Forms.sliderNum(d, 'strength', 50, 20000, { step: 50 })));
    box.appendChild(Forms.field('Damage (atk ×)', Forms.sliderNum(d, 'atk', 0.2, 10, { step: 0.1 })));
    box.appendChild(Forms.field('Speed', Forms.sliderNum(d, 'speed', 0, 12, { step: 0.1 })));
    box.appendChild(el('div.btn-row', el('button.solid-btn', {
      class: this._spawnArmed ? 'active' : '',
      onclick: () => {
        this._spawnArmed = !this._spawnArmed;
        if (this._spawnArmed) this._bombArmed = false;
        this._reRenderPanel();
        this.renderToolbar();
      }
    }, this._spawnArmed ? 'Armed — click the map to place (Esc cancels)' : '➕ Arm placement')));
    inner.appendChild(box);
  },

  // Foreign intervention (Feature: nation joins an ongoing war) — a plain
  // nation/side picker; the actual spawn/allies bookkeeping is all
  // server-side in war.joinWar.
  renderIntervention(inner, war) {
    inner.appendChild(Views.secLabel('Foreign Intervention'));
    const allies = war.allies || { att: [], def: [] };
    const excluded = new Set([war.attackerId, war.defenderId, ...(allies.att || []), ...(allies.def || [])]);
    const options = (S().entities || []).filter(e => e.type === 'foreign' && !excluded.has(e.id)).map(e => [e.id, e.name]);
    if (!options.length) {
      inner.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'No further foreign powers are available to intervene.'));
      return;
    }
    if (!this._joinDraft || !options.some(o => o[0] === this._joinDraft.entityId)) {
      this._joinDraft = { entityId: options[0][0], side: (this._joinDraft && this._joinDraft.side) || 'att' };
    }
    const d = this._joinDraft;
    const box = el('div');
    box.appendChild(Forms.field('Nation', Forms.sel(d, 'entityId', options)));
    box.appendChild(Forms.field('Side', el('div.btn-row',
      el('button.dash-btn', { class: d.side === 'att' ? 'active' : '', onclick: () => { d.side = 'att'; this._reRenderPanel(); } }, 'Join Attacker'),
      el('button.dash-btn', { class: d.side === 'def' ? 'active' : '', onclick: () => { d.side = 'def'; this._reRenderPanel(); } }, 'Join Defender')
    )));
    box.appendChild(el('div.btn-row', el('button.solid-btn', {
      onclick: async () => {
        try { await POST('/api/gm/war/join', { entityId: d.entityId, side: d.side }); toast('Intervention ordered.'); }
        catch (e) { toast(e.message, true); }
      }
    }, '🤝 Join War')));
    inner.appendChild(box);
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
    if (!war.result) {
      this.renderTuning(inner, war);
      this.renderSpawner(inner, war);
      this.renderIntervention(inner, war);
    }
    this.renderTreaty(inner, war);
    if (war.result) this.renderStartForm(inner);
  },

  // ---------- peace treaty desk (Phase 24 — GM-only) ----------
  // Any combination of clauses in one signing: reparations, ceding a Republic
  // province to a foreign nation, annexing a map nation as a new province.
  // Signing during an active war ends it first (server-side).
  _treatyDraft: null,
  renderTreaty(inner, war) {
    inner.appendChild(Views.secLabel('Peace Treaty (GM)'));
    const d = this._treatyDraft = this._treatyDraft || { repFrom: '', repTo: '', repAmount: 0, cedeProv: '', cedeTo: '', annex: '' };
    const box = el('div');
    const nations = S().entities.filter(e => e.type === 'foreign');
    const natOpts = (allowNone) => [(allowNone ? ['', '— none —'] : null), ...nations.map(n => [n.id, n.name])].filter(Boolean);
    const parties = [['', '— none —'], ['ent_gov', 'The Republic (Government)'], ...nations.map(n => [n.id, n.name])];
    const sel = (obj, key, opts) => {
      const s = el('select.text-input', opts.map(o => el('option', { value: o[0], selected: String(obj[key]) === String(o[0]) ? 'selected' : undefined }, o[1])));
      s.addEventListener('change', () => { obj[key] = s.value; });
      return s;
    };
    box.appendChild(Forms.field('Reparations — payer', sel(d, 'repFrom', parties)));
    box.appendChild(Forms.field('Reparations — recipient', sel(d, 'repTo', parties)));
    box.appendChild(Forms.field('Reparations — amount (' + CUR() + ')',
      el('input.text-input', { type: 'number', min: '0', step: '1000', value: d.repAmount || '', oninput: (e) => { d.repAmount = Number(e.target.value) || 0; } })));
    box.appendChild(Forms.field('Cede province', sel(d, 'cedeProv', [['', '— none —'], ...S().provinces.map(p => [p.id, p.name])]), 'The province leaves the Republic and becomes the recipient nation’s territory.'));
    box.appendChild(Forms.field('Cede to', sel(d, 'cedeTo', natOpts(true))));
    const countries = ((S().settings || {}).map || {}).countries || [];
    box.appendChild(Forms.field('Annex nation', sel(d, 'annex', [['', '— none —'], ...countries.map(c => [c.id, c.name])]), 'The nation becomes a new Republic province — shape, people, a namesake city.'));
    box.appendChild(el('div.btn-row', el('button.danger-btn', {
      onclick: () => {
        const clauses = [];
        if (d.repFrom && d.repTo && d.repAmount > 0) clauses.push(`${fmtMoney(d.repAmount)} reparations`);
        if (d.cedeProv && d.cedeTo) clauses.push('cede ' + ((provById(d.cedeProv) || {}).name || d.cedeProv));
        if (d.annex) clauses.push('annex ' + d.annex);
        if (!clauses.length) return toast('The treaty has no clauses.', true);
        confirmModal('SIGN TREATY', 'Sign and execute: ' + clauses.join(' · ') + '? This redraws the world and cannot be undone.', async () => {
          const body = {};
          if (d.repFrom && d.repTo && d.repAmount > 0) body.reparations = { fromEntityId: d.repFrom, toEntityId: d.repTo, amount: d.repAmount };
          if (d.cedeProv && d.cedeTo) body.cede = { provinceId: d.cedeProv, toEntityId: d.cedeTo };
          if (d.annex) body.annex = { countryId: d.annex };
          const r = await POST('/api/gm/war/treaty', body);
          this._treatyDraft = null;
          toast('Treaty executed: ' + r.applied.join(' · '));
        }, 'Sign Treaty');
      }
    }, '✒ Sign Treaty…')));
    inner.appendChild(box);
  },

  // GM global tuning sliders (war.mods) — combat damage, bomb damage and unit
  // HP multipliers, all defaulting to 1×. Posts to /api/gm/war/tuning on a
  // short debounce so dragging the slider doesn't spam the route on every
  // 'input' tick; server/war.js's setWarTuning does the actual clamp/rescale.
  _tuneTimers: {},
  renderTuning(inner, war) {
    inner.appendChild(Views.secLabel('Global Tuning'));
    const mods = Object.assign({ dmg: 1, bombDmg: 1, hp: 1 }, war.mods || {});
    const box = el('div');
    box.appendChild(this._tuningRow('Combat damage ×', mods, 'dmg'));
    box.appendChild(this._tuningRow('Bomb damage ×', mods, 'bombDmg'));
    box.appendChild(this._tuningRow('Unit HP ×', mods, 'hp'));
    inner.appendChild(box);
  },
  _tuningRow(label, mods, key) {
    const slider = Forms.slider(mods, key, 0.1, 5, {
      step: 0.1,
      format: (v) => Number(v).toFixed(1) + '×',
      onInput: (v) => this._debounceTuning(key, v)
    });
    return Forms.field(label, slider);
  },
  _debounceTuning(key, value) {
    clearTimeout(this._tuneTimers[key]);
    this._tuneTimers[key] = setTimeout(async () => {
      try { await POST('/api/gm/war/tuning', { [key]: value }); }
      catch (e) { toast(e.message, true); }
    }, 300);
  }
};
window.War = War; // map.js feature-detects the War Room / map overlay via window, same as MapEdit/Entertainment
