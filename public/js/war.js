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
   authority checks keep reading the authoritative S().war. The map layer is
   RETAINED: front line and occupied ground live in #map-svg and are rebuilt
   only when the captured cells change; units, orders and FX live in the
   overlay svg (GameMap.overSvg) as keyed nodes patched in place, tweened by
   one rAF loop that writes only what changed — see docs/WAR.md "Client". */

const WAR_KIND_GLYPH = { marine: '⚓', infantry: '◆', armored: '▣', garrison: '⛊', reserve: '☰', boat: '⛵', warship: '🚢', protestor: '⚒', police: '⛨' };
// Transport ships & Boats feature: a land unit whose state reads 'transport'
// (drifting/stranded over water — see war-engine.js's stepTransportState)
// renders with this glyph instead of its normal kind glyph, so a column
// crossing a strait visibly becomes a little ship for the duration.
const WAR_TRANSPORT_GLYPH = '⛴';
// Fallback shown for the one render before the real list arrives (or if the
// fetch fails) — see War._ensureScenarioList / GET /api/gm/war/scenarios,
// which is the source of truth so this file doesn't have to hardcode every
// scenario id in server/war-scenarios.js.
const WAR_SCENARIOS_FALLBACK = [{ id: 'valksland_invasion', name: 'The Valgos Crisis', attackerName: 'Valksland', defenderName: 'the Republic' }];
const WAR_SPAWN_KINDS = [['infantry', 'Infantry'], ['armored', 'Armored'], ['marine', 'Marine'], ['garrison', 'Garrison'], ['boat', 'Boat'], ['warship', 'Warship'], ['protestor', 'Protestor'], ['police', 'Police']];
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
const EXPLOSION_LIFE_MS = 5600;  // a blast's flash, fireball and lingering smoke
const WAR_STICK_STAGGER_MS = 160; // a squadron's stick of bombs walks along its run

// Feature: unit damage feedback — how long the hit-jitter/flash plays after a
// live unit's strength is observed to drop between renderUnits passes.
const WAR_HIT_FX_MS = 450;
// Matches the engine's rout threshold (war-engine.js: org < 25 → routed) —
// used purely for the client's morale-bar/info-card color, not gameplay.
const WAR_ROUT_ORG = 25;
// The GM's speed slider stops (server/war.js clamps to [0.5, 8]).
const WAR_SPEEDS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
function warSpeedLabel(v) { const n = Number(v) || 1; return String(n >= 0.01 ? Math.round(n * 1000) / 1000 : Number(n.toPrecision(2))) + '×'; }
const WAR_GROUND_MIN_MS = 1500; // see renderGround
const MAX_PROTEST_UNITS_CLIENT = 300; // server/war.js MAX_PROTEST_UNITS
// Protest unit glyphs (see War._symbol): a crowd pill holding three figures,
// a police shield holding a star badge.
const WAR_CROWD_FRAME = 'M-10,-11 H10 Q18,-11 18,-3 V3 Q18,11 10,11 H-10 Q-18,11 -18,3 V-3 Q-18,-11 -10,-11 Z';
const WAR_CROWD_FIGS = 'M-11.4,-1 a2.4,2.4 0 1 0 4.8,0 a2.4,2.4 0 1 0 -4.8,0 M-14,9 Q-14,3.5 -9,3.5 Q-4,3.5 -4,9 Z' +
  ' M6.6,-1 a2.4,2.4 0 1 0 4.8,0 a2.4,2.4 0 1 0 -4.8,0 M4,9 Q4,3.5 9,3.5 Q14,3.5 14,9 Z' +
  ' M-3,-4 a3,3 0 1 0 6,0 a3,3 0 1 0 -6,0 M-6,9 Q-6,1 0,1 Q6,1 6,9 Z';
const WAR_POLICE_FRAME = 'M-15,-11 H15 V-2 Q15,6 0,11 Q-15,6 -15,-2 Z';
const WAR_POLICE_BADGE = 'M' + Array.from({ length: 10 }, (_, i) => {
  const a = (-90 + i * 36) * Math.PI / 180, r = i % 2 ? 2.7 : 6.4;
  return (Math.cos(a) * r).toFixed(2) + ',' + (Math.sin(a) * r - 1.5).toFixed(2);
}).join(' L') + ' Z';
// A crowd's marker grows with its headcount (police with their detachment).
function warCrowdScale(u) {
  if (u.kind !== 'protestor' && u.kind !== 'police') return 1;
  const s = 0.82 + Math.sqrt(Math.max(0, u.strength || 0) / 2000) * 0.24;
  return Math.round(Math.max(0.82, Math.min(u.kind === 'police' ? 1.25 : 1.5, s)) * 20) / 20;
}
// A protest's posture is two independent choices — do the crowds fight, has
// the government authorized force — so it reads as a 2×2: each cell what
// that combination does (server/war.js applyProtestPolitics + canFight).
const PROTEST_POSTURE = {
  peaceful: { label: 'Peaceful', status: 'PEACEFUL', short: 'Nobody can strike. Sympathy for the movement builds.',
    text: 'A peaceful demonstration: neither side can strike. Every minute in the streets wins the movement sympathy and costs the government approval.' },
  riot: { label: 'Riot', status: 'RIOTING', short: 'Police fight back. The public turns on the movement.',
    text: 'The crowds are fighting and the police defend themselves. Rioting costs the movement public support, kills bystanders and drives people from their homes.' },
  crackdown: { label: 'Crackdown', status: 'CRACKDOWN', short: 'Force on a peaceful crowd — approval collapses.',
    text: 'Force against a peaceful crowd: sympathy for the movement doubles and government approval falls several times faster. The air wing is cleared.' },
  clashes: { label: 'Open clashes', status: 'CLASHES', short: 'Both sides fighting. Air wing cleared.',
    text: 'Both sides are fighting and the air wing is cleared. Expect casualties and refugees; the rioting still costs the movement support.' }
};
function protestPosture(p) {
  p = p || {};
  return p.protestorsViolent ? (p.govViolent ? 'clashes' : 'riot') : (p.govViolent ? 'crackdown' : 'peaceful');
}
// "≈2.4k" — compact headcount for crowd markers and their tooltips
function warHeads(n) {
  n = Math.max(0, Math.round(n || 0));
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
}

const War = {
  _anim: {},        // unitId -> { from:[x,y], to:[x,y], t0, dur, curPos:[x,y], node }
  _arrowAnim: {},    // unitId -> { node, tail:'x,y x,y …' } — the marker end of each move arrow chases the tweened position every frame
  _flashAnim: {},    // synthetic flash id -> { node, t0, life }
  // Refugee columns (Phase 28) — own registry, NOT _anim: renderUnits prunes
  // _anim against its unit ids every pass and would drop these. Same tween
  // shape plus the per-frame fade opacity (see renderRefugees/_refOpacity).
  _refAnim: {},      // refugeeId -> { from, to, t0, dur, curPos, node, r, war }
  _inspectRef: null, // refugee column id under inspection (unit info card)
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
  _gmSide: 'def',    // GM-only toggle: which side the GM is currently commanding
  _inspect: null,    // Feature: unit info card — enemy unit id under inspection (own-side uses _sel instead)
  // Tap orders: a left-click/tap on ground moves the selection and a tap on
  // an enemy attacks it — on by default on touch screens (no right button),
  // a toolbar toggle everywhere.
  _tapOrders: (typeof matchMedia === 'function') && matchMedia('(pointer: coarse)').matches,
  _unitNodes: new Map(), // keyed unit nodes of the retained war layer (see renderUnits)

  // ---- GM unit spawner (Feature: mid-war reinforcements) ----
  _spawnArmed: false,        // "arm placement" mode: next war-layer left-click places the spawn
  _spawnDraft: { side: 'att', kind: 'infantry', name: '', count: 3, strength: 2000, atk: 1, speed: 3.5 },
  // ---- Foreign intervention (Feature: nation joins an ongoing war) ----
  _joinDraft: null,          // { entityId, side } — lazily seeded once a candidate nation list exists
  // ---- GM scenario picker (Feature: dynamic scenario list) ----
  _scenarioList: null,       // null = not yet fetched; [] = fetched empty/failed
  _scenarioFetchInFlight: false,

  // ---- client-side prediction state (Phase 18) ----
  // Phase 31 — a protest is a SECOND conflict doc (S().protest), predicted
  // and commanded exactly like the war. `_preds` holds one prediction state
  // per conflict key ('war'|'protest'); `_activeKey` is the conflict the
  // toolbar/commands currently target (the map renders BOTH at once).
  _preds: {},      // key -> { war: <deep copy>, authRef, baseTick, lastAuthTick, outbox, airOutbox }
  _activeKey: 'war',
  _warV: 0,          // last /api/war/state version applied — rejects out-of-order heartbeat responses
  _rtTimer: null,    // 250ms realtime driver (local predicted ticks + heartbeat gate)
  _hbDue: 0,         // epoch ms the next heartbeat poll is due
  _hbBusy: false,    // a heartbeat fetch is in flight
  _lastDraw: 0,      // performance.now() of the last prediction-triggered map redraw (throttle)

  docKeyOf(doc) { return (doc && doc.kind === 'protest') ? 'protest' : 'war'; },
  authDocs() {
    const s = S() || {};
    const out = [];
    if (s.war) out.push(s.war);
    if (s.protest) out.push(s.protest);
    return out;
  },
  activeAuth() {
    const s = S() || {};
    this._ensureActiveKey();
    if (this._activeKey === 'protest' && s.protest && s.protest.active) return s.protest;
    if (s.war && s.war.active) return s.war;
    if (s.protest && s.protest.active) return s.protest;
    return null;
  },
  _ensureActiveKey() {
    const s = S() || {};
    if (this._activeKey === 'protest' && s.protest && s.protest.active) return;
    if (this._activeKey === 'war' && s.war && s.war.active) return;
    const warActive = !!(s.war && s.war.active);
    const protestActive = !!(s.protest && s.protest.active);
    this._activeKey = warActive ? 'war' : (protestActive ? 'protest' : 'war');
  },
  active() { const s = S(); return !!((s && (s.war && s.war.active || s.protest && s.protest.active))); },
  // A conflict OBJECT lingers after the fighting ends (active:false) so
  // players can review the final front — but its units are no longer
  // commandable. Orders against an inactive conflict are rejected
  // server-side, so gate the command/bomb affordances on this, not on
  // active() (= a conflict exists).
  commandable(doc) { const w = doc || this.activeAuth(); return !!(w && w.active); },

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
    const war = window.WarEngine && this.activePred();
    if (war) return WarEngine.clampToWorld(war, pt);
    return [Math.max(0, Math.min(3840, pt[0])), Math.max(0, Math.min(2160, pt[1]))];
  },

  /* ═══════════ AUTHORITY ═══════════
     Who commands what is decided SERVER-side and shipped per conflict as
     doc.cmdAccess { att, def } (see api.js cmdAccessOf): GM commands either
     side (via the toolbar toggle); otherwise a protest's organizer
     controllers command 'att' and government/military operators command
     'def'. The client mirrors it so the UI never offers a side the server
     would refuse. */
  commandableSide(doc) {
    doc = doc || this.activeAuth();
    if (!doc) return 'def';
    const ca = doc.cmdAccess || {};
    if (isGM()) return this._gmSide === 'att' ? 'att' : 'def';
    return ca.att ? 'att' : (ca.def ? 'def' : null);
  },
  // The caller's full cmdAccess for a doc (Phase 36: att/attLead/def/force/
  // air/concede — see api.js cmdAccessOf). The server ships it on every
  // conflict view, the GM's included; the isGM fallback only covers a doc
  // that predates this change in a long-open tab.
  access(doc) {
    const ca = (doc && doc.cmdAccess) || {};
    if (isGM()) return Object.assign({ att: true, attLead: true, def: true, defAll: true, force: true, air: true, concede: true }, ca);
    return ca;
  },
  // One line naming what this operator may do in a conflict — the War Room
  // and toolbar used to show observers the same command hints and airstrike
  // button as commanders, which the server then refused.
  authorityText(doc) {
    const protest = doc.kind === 'protest';
    const ca = this.access(doc);
    if (isGM()) return 'Gamemaster — you hold every lever on both sides.';
    const can = [];
    if (ca.attLead) can.push(protest ? 'lead the protest (violence, territory, calling it off)' : 'command the invading forces');
    else if (ca.att) can.push(protest ? 'marshal the crowds' : 'command attacking units');
    if (ca.def) can.push(protest ? 'command the police' : 'command the national defence');
    if (ca.force) can.push('authorize force');
    if (ca.air) can.push('order airstrikes' + (protest ? ' once force is authorized' : ''));
    if (ca.concede) can.push('concede to the demands');
    if (!can.length) return 'You are observing — your role holds no command in this conflict.';
    return 'Your authority: you may ' + can.join(', ') + '.';
  },

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
  // The db shell a predicted tick runs against. The OTHER live conflict's
  // predicted doc rides along (db.protest for the war, db.otherWar for the
  // protest) so cross-conflict fighting predicts like the server's — except
  // during a rebase fast-forward (`solo`), which replays ticks whose effects
  // on the other doc it already shows.
  _dbLike(war, solo) {
    const s = S() || {};
    const db = { war, provinces: s.provinces || [], cities: s.cities || [], settings: s.settings || {} };
    if (!solo && war) {
      const otherKey = this.docKeyOf(war) === 'protest' ? 'war' : 'protest';
      const o = this._preds[otherKey] && this._preds[otherKey].war;
      if (o && o.active && o !== war) { if (otherKey === 'protest') db.protest = o; else db.otherWar = o; }
    }
    return db;
  },

  // The war doc the MAP renders: predicted when available, else authoritative.
  // Rebases lazily whenever the authoritative object identity changed (every
  // state refetch swaps W.state wholesale, so identity is a reliable signal).
  predictedDoc(auth) {
    if (!auth) { delete this._preds[this.docKeyOf(auth)]; return null; }
    const key = this.docKeyOf(auth);
    const st = this._preds[key];
    if (!st || st.authRef !== auth) this._rebase(key, auth);
    return this._preds[key].war;
  },
  predictedWar() { return this.predictedDoc(S() && S().war); },
  predictedProtest() { return this.predictedDoc(S() && S().protest); },
  // Predicted doc of whichever conflict the toolbar/commands target.
  activePred() {
    const auth = this.activeAuth();
    return auth ? this.predictedDoc(auth) : null;
  },

  _rebase(key, auth) {
    const prev = this._preds[key];
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
    // AIR OUTBOX: a squadron order (war-air.js _airOrder) is applied to the
    // predicted doc the moment POST /api/war/air returns, so the squadron
    // takes off locally on the next predicted tick. A heartbeat already in
    // flight can still resolve with a snapshot from just BEFORE the order —
    // re-apply any order such a snapshot doesn't reflect yet (the squadron
    // still sits ready with no order) BEFORE the fast-forward below, so the
    // catch-up launches it exactly as the server will.
    const airOutbox = ((prev && prev.airOutbox) || []).filter(o => o.exp > now);
    for (const o of airOutbox) {
      const sq = ((war.air || {}).squadrons || []).find(x => x.id === o.sqId);
      if (sq && !sq.order && (o.order.kind === 'recall' ? (sq.state === 'out' || sq.state === 'station') : (sq.state === 'ready' && !sq.mission))) sq.order = JSON.parse(JSON.stringify(o.order));
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
      const dbl = this._dbLike(war, true);
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
    this._preds[key] = { war, authRef: auth, baseTick: auth.tick || 0, lastAuthTick: auth.tick || 0, outbox: [], airOutbox };
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
    this._preds[key].outbox = unconfirmed;
  },

  // Apply orders to the predicted war IMMEDIATELY (the POST confirms later);
  // remember them so rebases re-apply until the server state shows them.
  _optimistic(side, orders, key) {
    key = key || this._activeKey;
    const auth = S() && S()[key === 'protest' ? 'protest' : 'war'];
    const war = this.predictedDoc(auth);
    if (!war) return;
    WarEngine.applyOrders(this._dbLike(war), side, orders);
    const exp = Date.now() + 5000; // a write refetch lands well inside this
    for (const o of orders) {
      // A path order's effective "confirmed yet?" anchor is its last
      // waypoint (see the comment in _rebase) — dest is always populated.
      const dest = (Array.isArray(o.path) && o.path.length) ? o.path[o.path.length - 1] : o.dest;
      this._preds[this.docKeyOf(war)].outbox.push({ side, unitId: o.unitId, dest, path: o.path || null, exp });
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
  // Is the player actually LOOKING at the war right now? The battlefield
  // only renders on the map's ⚔ War layer, and the War Room panel is the
  // only other reader of live tick data. Anywhere else, predicting ticks
  // burns CPU on a simulation nobody can see and the per-tick heartbeat
  // spams the network for state nothing renders — the war still advances
  // server-side (any /api/state poll rides maybeWarTick's burst catch-up,
  // and milestones still broadcast), and coming back to the layer rebases
  // through the usual bounded fast-forward, so nothing is lost by pausing.
  _watchingWar() {
    if (typeof W === 'undefined') return false;
    return W.view === 'war' || (W.view === 'map' && W.layer === 'war');
  },
  _realtimeStep() {
    const docs = this.authDocs();
    if (!docs.length) { this._stopRealtime(); this._preds = {}; return; }
    if (document.hidden) return;
    if (!this._watchingWar()) return;
    // 1. local predicted tick(s) — but never run unboundedly ahead of the
    //    last authoritative tick (if heartbeats stall, divergence would grow
    //    and every eventual reconciliation would be a visible teleport).
    //    Each conflict doc has its OWN wall-clock gate + divergence bound.
    for (const auth of docs) {
      if (!auth.active || auth.paused) continue;
      const key = this.docKeyOf(auth);
      const war = this.predictedDoc(auth);
      if (war && window.WarEngine &&
          war.tick - (this._preds[key].lastAuthTick || 0) < 10 &&
          WarEngine.maybeWarTick(this._dbLike(war))) {
        this.refreshLayer();
      }
    }
    // 2. authoritative heartbeat, one tick interval apart (never below 1s —
    //    at 8× speed prediction carries the smoothness, not the network)
    // (capped at 4s: a slow conflict — 0.05× ticks every 40s — must still
    // bring other players' orders and the server's results in promptly)
    const interval = Math.min(4000, Math.max(1000, (docs[0].tickMs || 2000) / (docs[0].speed || 1)));
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
          let touched = false;
          if (W.state) {
            if (data.war && W.state.war !== data.war) { W.state.war = data.war; touched = true; } // identity change → predictedWar() rebases
            if (data.protest && W.state.protest !== data.protest) { W.state.protest = data.protest; touched = true; }
          }
          if (touched) {
            this.refreshLayer(true);
            this._maybeRefreshPanel();
          }
        }
      }
    } catch (e) { /* transient — next heartbeat retries */ }
    this._hbBusy = false;
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
    // the air mission planner (war-air.js): a click is the target
    this._swallowUp = false;
    if (this._airPlan && this._airPlanClick) { e.preventDefault(); this._swallowUp = true; this._airPlanClick(world); return true; }
    // measuring tools (war-map.js): a left drag measures instead of panning
    // (no text selection either while dragging across the page)
    if (this._tool && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); this._measureDown(world); return true; }
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
    // Plain left button: NOT consumed — map.js pans on drag; a motionless
    // click on empty ground deselects via onMapClick (svg pointerup).
    return false;
  },
  onMapPointerMove(e) {
    if (!this._input || !this._input.active) return;
    const map = GameMap;
    const world = map.clientToWorld(e.clientX, e.clientY);
    if (this._input.mode === 'measure') this._measureMove(world);
    else if (this._input.mode === 'box') this._updateMarquee(this._input.node, this._input.start, world);
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
    if (this._input.mode === 'measure') {
      this._measureMove(world);
      if (tiny) { this._measure = null; this._drawMeasure(); } // a click clears the last measurement
      this._input = null;
      return;
    }
    if (this._input.mode === 'box') {
      if (this._input.node && this._input.node.parentNode) this._input.node.parentNode.removeChild(this._input.node);
      if (tiny) {
        this._sel.clear();
      } else {
        const x0 = Math.min(start[0], world[0]), x1 = Math.max(start[0], world[0]);
        const y0 = Math.min(start[1], world[1]), y1 = Math.max(start[1], world[1]);
        const war = (window.WarEngine && this.activePred()) || this.activeAuth();
        const side = this.commandableSide(war);
        this._sel.clear();
        for (const u of (war ? war.units : [])) {
          if (u.side !== side || u.dead || u.state === 'dead' || !(u.strength > 0)) continue;
          if (u.pos[0] >= x0 && u.pos[0] <= x1 && u.pos[1] >= y0 && u.pos[1] <= y1) this._sel.add(u.id);
        }
      }
      this.refreshLayer(true);
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
  // Plain pointer movement over the map (map.js, never consumed) — drives the
  // air mission planner's live preview.
  onMapHover(e) {
    if (this._airPlan && this._airPlanHover) this._airPlanHover(GameMap.clientToWorld(e.clientX, e.clientY));
  },
  onMapClick(e) {
    if (e.button !== 0) return;
    if (this._swallowUp) { this._swallowUp = false; return; } // the press was a tool/planner gesture
    if (this._tool) return; // measuring: clicks belong to the tool
    // Tap orders (the touch-friendly scheme — no right button on a phone):
    // with units selected, a tap on open ground is a move order.
    if (this._tapOrders && this._sel.size && this.commandable()) {
      this._issueMove(GameMap.clientToWorld(e.clientX, e.clientY));
      return;
    }
    let changed = false;
    if (this._sel.size) { this._sel.clear(); changed = true; }
    if (this._inspect) { this._inspect = null; changed = true; } // Feature: unit info card — ground click clears inspection too
    if (this._inspectRef) { this._inspectRef = null; changed = true; } // refugee columns clear the same way
    if (changed) this.refreshLayer(true);
  },

  // Left-click a commandable soldier: replace the selection; shift+click
  // toggles it in/out. Wired per-marker in renderUnits (only own live units).
  onUnitClick(unitId, e) {
    if (!this.commandable()) return;
    if (e.shiftKey) { if (!this._sel.delete(unitId)) this._sel.add(unitId); }
    else { this._sel.clear(); this._sel.add(unitId); }
    this._inspectRef = null; // picking a unit supersedes a refugee inspection
    this._inspect = null;
    this.refreshLayer(true);
  },

  // Esc clears selection + disarms the bomb while on the war layer. Bound
  // once against window (survives GameMap's DOM rebuilds).
  bindKeys() {
    if (this._keysBound) return;
    this._keysBound = true;
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || W.layer !== 'war') return;
      const had = this._sel.size || this._spawnArmed || this._inspect || this._inspectRef || this._tool || this._measure || this._airPlan;
      this._sel.clear(); this._spawnArmed = false; this._input = null; this._inspect = null; this._inspectRef = null;
      this._tool = null; this._measure = null; this._airPlan = null;
      if (this._drawMeasure) this._drawMeasure();
      if (this._airPlanClear) this._airPlanClear();
      if (had) { this.refreshLayer(true); this.renderToolbar(); }
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
    try { await POST('/api/war/command', { side, orders, conflict: this._activeKey }); }
    catch (e) { toast(e.message, true); }
  },
  // Ctrl-drag formation: distribute the current selection along the line A→B,
  // nearest-in-order (sort both units and slots by their projection onto the
  // line direction, then pair them up 1:1) so units don't cross paths.
  async _issueFormation(a, b) {
    const war = (window.WarEngine && this.activePred()) || this.activeAuth();
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
    try { await POST('/api/war/command', { side, orders, conflict: this._activeKey }); }
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
    try { await POST('/api/war/command', { side, orders, conflict: this._activeKey }); }
    catch (e) { toast(e.message, true); }
  },
  // Task 5: hit-test a world point against ENEMY live units of the predicted
  // war, using the same fixed-world symbol math the marker hitbox itself uses
  // (30 world px base radius, counter-scaled below WAR_FIXED_MODE_K) so "did
  // I click the enemy soldier" agrees with what's actually drawn on screen.
  _hitEnemyAt(pt) {
    const war = (window.WarEngine && this.activePred()) || this.activeAuth();
    if (!war) return null;
    const side = this.commandableSide(war);
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
      const w = this.activePred();
      if (w) WarEngine.applyOrders(this._dbLike(w), side, orders);
      this.refreshLayer(true);
    }
    try { await POST('/api/war/command', { side, orders, conflict: this._activeKey }); }
    catch (e) { toast(e.message, true); }
  },
  // GM unit spawner (Feature: mid-war reinforcements) — placement click after
  // "Arm placement" in the War Room GM panel (see renderSpawner). Authority
  // (validation, clamping, war.mods.hp scaling) all lives server-side in
  // war.spawnUnits; this is just the click-to-position UI.
  async _doSpawn(pos) {
    const d = this._spawnDraft;
    try {
      const name = (d.name || '').trim();
      await POST('/api/gm/war/spawn', {
        side: d.side, pos: this._clamp(pos), kind: d.kind, name: name || undefined,
        count: d.count, strength: d.strength, atk: d.atk, speed: d.speed,
        conflict: d.conflict || this._activeKey
      });
      toast(`${d.count} ${d.kind} unit${d.count === 1 ? '' : 's'} deployed${name ? ` as ${name}` : ''}.`);
    } catch (e) { toast(e.message, true); }
  },

  // Tween duration ≈ one tick interval, so a unit glides continuously into
  // each new simulated position instead of the old fixed 900ms ease that left
  // it parked for the back half of every 2s tick (visible stop-start motion).
  _tweenMs() {
    const docs = this.authDocs();
    const w = docs[0] || {};
    const interval = (w.tickMs || 2000) / (w.speed || 1);
    // a full tick's glide, however long: at slow speeds units creep
    // continuously instead of hopping and then standing still
    return Math.min(60000, Math.max(250, interval));
  },

  /* ---------- shared animation loop ----------
     One rAF loop that tweens unit/refugee positions, keeps the screen-size
     symbols counter-scaled to the zoom, and drives the airstrike plane and
     impact FX. It only WRITES to the DOM when something actually changed —
     a unit that has finished its leg is skipped until the next leg or a zoom
     change (an idle battlefield used to rewrite every transform 60×/s, which
     made the browser repaint the whole map SVG continuously). */
  ensureLoop() {
    if (this._raf) return;
    const step = (now) => {
      let any = false;
      const k = GameMap.view ? GameMap.view.k : 1;
      const scale = warMarkerScale(k);
      const zoomChanged = scale !== this._loopScale;
      this._loopScale = scale;
      // name labels and other zoom-only detail switch on as you zoom in
      const layer = this._O && this._O.root;
      if (layer && layer.isConnected) {
        any = true;
        const zoomed = k >= 2.4;
        if (zoomed !== this._zoomed || zoomChanged) { this._zoomed = zoomed; layer.classList.toggle('war-zoomed', zoomed); }
        if (zoomChanged) {
          for (const n of layer.querySelectorAll('.war-scaled')) {
            n.setAttribute('transform', `translate(${n.getAttribute('data-x')},${n.getAttribute('data-y')}) scale(${scale})`);
          }
        }
      }
      for (const id in this._anim) {
        const e = this._anim[id];
        if (!e.node || !e.node.isConnected) { delete this._anim[id]; continue; }
        any = true;
        // LINEAR interpolation, deliberately not eased: legs chain tick to
        // tick, and an ease curve restarting on every leg made units
        // accelerate/decelerate 1-4× a second — visible stutter.
        const t = Math.min(1, (now - e.t0) / (e.dur || 900));
        if (e.settled && !zoomChanged) continue;
        e.curPos = [e.from[0] + (e.to[0] - e.from[0]) * t, e.from[1] + (e.to[1] - e.from[1]) * t];
        e.settled = t >= 1;
        const ar = this._arrowAnim[id];
        if (ar) {
          if (!ar.node.isConnected) delete this._arrowAnim[id];
          else {
            const d = 'M' + e.curPos[0].toFixed(1) + ' ' + e.curPos[1].toFixed(1) + (ar.tail ? ' ' + ar.tail : '');
            ar.node.setAttribute('d', d);
            if (ar.casing) ar.casing.setAttribute('d', d);
          }
        }
        e.node.setAttribute('transform', `translate(${e.curPos[0].toFixed(1)},${e.curPos[1].toFixed(1)}) scale(${scale})`);
      }
      // Refugee columns — same tween plus a fade driven by the predicted
      // tick clock (smooth between war-layer refreshes).
      for (const id in this._refAnim) {
        const e = this._refAnim[id];
        if (!e.node || !e.node.isConnected) { delete this._refAnim[id]; continue; }
        any = true;
        const t = Math.min(1, (now - e.t0) / (e.dur || 900));
        e.curPos = [e.from[0] + (e.to[0] - e.from[0]) * t, e.from[1] + (e.to[1] - e.from[1]) * t];
        e.node.setAttribute('transform', `translate(${e.curPos[0].toFixed(1)},${e.curPos[1].toFixed(1)}) scale(${scale})`);
        e.node.style.opacity = String(this._refOpacity(e.war, e.r));
      }
      // Squadrons in flight (war-air.js) — interpolated on the tick clock.
      if (this._airFrame && this._airFrame()) any = true;
      // Airstrike planes — a pure function of the predicted tick clock.
      for (const id in this._airstrikeAnim) {
        const e = this._airstrikeAnim[id];
        if (!e.node || !e.node.isConnected) { delete this._airstrikeAnim[id]; continue; }
        any = true;
        this._updatePlanePose(e);
      }
      // Impact FX — keyed off Date.now() (the _strikeImpactAt epoch), NOT the
      // rAF timestamp (performance.now()-based — a different clock epoch).
      for (const id in this._explosionAnim) {
        const e = this._explosionAnim[id];
        if (!e.node || !e.node.isConnected) { delete this._explosionAnim[id]; continue; }
        any = true;
        const age = Date.now() - e.t0;
        if (age > e.life) { delete this._explosionAnim[id]; continue; }
        this._updateExplosion(e, age);
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

  /* ═══════════ MAP LAYER (retained mode) ═══════════
     The war layer is a set of PERSISTENT sublayers, updated in place:

       war-veil      a parchment wash over the base map (War layer only), so
                     the situation overlay reads like a staff map
       war-ground    occupied ground, the front line, craters — rebuilt only
                     when the captured-cell set changes (fingerprinted)
       war-marks     objectives and captured-city flags — rebuilt when their
                     status changes
       war-orders    movement/attack arrows, warship fire, clash markers —
                     cheap, rebuilt per refresh
       war-refugees  refugee columns
       war-units     one KEYED node per unit, created once and patched in
                     place (attributes are only written when they change)
       war-fx        planes, impact explosions, event flashes

     GameMap.render() (a full map rebuild) calls renderMapLayer, which builds
     the sublayers afresh; every predicted tick / heartbeat goes through
     refreshLayer → _paint, which patches them. Both conflict docs (war and
     protest) draw into per-doc groups inside each sublayer. */
  renderMapLayer(map, mk, NS) {
    const docs = this.authDocs();
    if (!docs.length) {
      this._anim = {}; this._flashAnim = {};
      this._airstrikeAnim = {}; this._explosionAnim = {}; this._strikeImpactAt = {};
      this._refAnim = {}; this._inspectRef = null;
      this._lastStrength = {}; this._hitAt = {};
      this._removeToolbar(); this._removeUnitCard(); this._removeHud(); this._inspect = null;
      this._unmountFrame(); if (this._removeAirDock) this._removeAirDock();
      if (this._O) { this._O.root.remove(); this._O = null; this._unitNodes = new Map(); }
      this._stopRealtime(); this._preds = {}; return;
    }
    if (window.WarEngine) this._ensureRealtime();
    NS = NS || 'http://www.w3.org/2000/svg';
    // base part, inside #map-svg (rebuilt with every full map render): the
    // veil and the ground — they change rarely, and live under the map's
    // cities/labels in the same paint
    const layer = document.createElementNS(NS, 'g');
    layer.setAttribute('class', 'war-layer');
    map.world.appendChild(layer);
    map.warLayer = layer;
    this._L = { root: layer, docs: {} };
    for (const name of ['veil', 'grid', 'ground']) {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'war-' + name);
      layer.appendChild(g);
      this._L[name] = g;
    }
    this._defs(NS, layer, 'patterns');
    this._overlay(map, NS);
    this._paint(map, NS);
  },
  // The moving parts live in GameMap's overlay svg (#war-overlay) and
  // PERSIST across full map renders — units keep their nodes and glide on.
  _overlay(map, NS) {
    const host = map.overWorld || map.world; // (no overlay svg → old single-svg behaviour)
    if (this._O && this._O.root.parentNode === host) return this._O;
    if (this._O) this._O.root.remove();
    this._unitNodes = new Map();
    for (const k in this._L.docs) delete this._L.docs[k];
    const root = document.createElementNS(NS, 'g');
    root.setAttribute('class', 'war-overlay-root');
    host.appendChild(root);
    this._O = { root, docs: {} };
    for (const name of ['marks', 'airfields', 'orders', 'refugees', 'units', 'air', 'fx', 'measure']) {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'war-' + name);
      root.appendChild(g);
      this._O[name] = g;
    }
    this._defs(NS, root, 'markers');
    this._bindUnitEvents(this._O.units);
    if (map.overSvg && this._overSvgBound !== map.overSvg) { this._overSvgBound = map.overSvg; this._forwardToMap(map); }
    this._zoomed = null; this._loopScale = null; // force the loop to restyle the new nodes
    return this._O;
  },
  // Events that land on the overlay's interactive marks (enemy units,
  // objectives, refugees…) but mean "the map" — a pan starting over an
  // enemy, a right-click order, the wheel, a double-click zoom — are
  // re-dispatched to the map svg so its own handlers run as before. Own
  // units consume their left press (select) and are not forwarded.
  _forwardToMap(map) {
    const svg = map.overSvg;
    const fwd = (ctor) => (e) => {
      if (e._warFwd) return;
      if (e.type === 'pointerdown' && e.button === 0) {
        const n = e.target.closest && e.target.closest('[data-wu]');
        const rec = n && this._unitNodes.get(n.getAttribute('data-wu'));
        if (rec && rec.own && !this._airPlan && !this._spawnArmed && !this._tool) return;
      }
      const ev = new ctor(e.type, e);
      ev._warFwd = true;
      map.svg.dispatchEvent(ev);
      if (e.type === 'wheel' || e.type === 'contextmenu') e.preventDefault();
    };
    svg.addEventListener('pointerdown', fwd(PointerEvent));
    svg.addEventListener('pointermove', fwd(PointerEvent));
    svg.addEventListener('wheel', fwd(WheelEvent), { passive: false });
    svg.addEventListener('dblclick', fwd(MouseEvent));
    svg.addEventListener('contextmenu', fwd(MouseEvent));
  },

  // Patch the existing layer in place; rebuild it only if the map SVG was
  // replaced underneath us (a full GameMap.render since the last paint).
  refreshLayer(force) {
    const now = performance.now();
    if (!force && now - this._lastDraw < 150) return;
    // NB: GameMap is a top-level `const` in map.js — a script-scope global
    // that is NOT a window property, so it must be referenced bare.
    const map = typeof GameMap !== 'undefined' ? GameMap : null;
    if (!(map && map.svg && map.svg.isConnected && map.world && map.world.isConnected && map.mk)) return;
    if (window.MapEdit && MapEdit.dragging) return; // same guard as GameMap.render
    this._lastDraw = now;
    if (this._L && this._L.root.isConnected && this._L.root.parentNode === map.world && this._O && this._O.root.isConnected) this._paint(map, 'http://www.w3.org/2000/svg');
    else this.renderMapLayer(map, map.mk, 'http://www.w3.org/2000/svg');
  },

  _paint(map, NS) {
    const docs = this.authDocs();
    if (!docs.length) { this.renderMapLayer(map, map.mk, NS); return; }
    const onWar = W.layer === 'war';
    // the parchment veil mutes the base map so the overlay reads at a glance
    if (onWar && !this._L.veil.firstChild) {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', -8000); r.setAttribute('y', -8000); r.setAttribute('width', 3840 + 16000); r.setAttribute('height', 2160 + 16000);
      r.setAttribute('class', 'war-veil-rect');
      this._L.veil.appendChild(r);
    } else if (!onWar && this._L.veil.firstChild) clear(this._L.veil);
    // the kilometre grid (war-map.js) — static, drawn once per full render
    if (onWar && !this._L.grid.firstChild) this._renderGrid(this._L.grid);
    else if (!onWar && this._L.grid.firstChild) clear(this._L.grid);
    const seen = new Set();
    const anyLive = docs.some(d => d.active);
    for (const auth of docs) {
      const key = this.docKeyOf(auth);
      // an ended conflict's ground stays up for review — unless another one
      // is live, whose map it would bury (a finished invasion's occupation
      // hatch under a running protest)
      if (anyLive && !auth.active) { this._hideDoc(key); continue; }
      // Render the PREDICTED doc (rebased-on-authority + locally ticked), so
      // the front line the player sees is always at full cadence.
      const war = (window.WarEngine && this.predictedDoc(auth)) || auth;
      const D = this._docLayers(NS, key, war);
      // the per-paint layers start empty — clear the doc's OWN groups (clearing
      // the shared sublayer would detach them, and nothing drawn into them
      // afterwards would ever reach the screen)
      clear(D.orders); clear(D.refugees); clear(D.fx);
      this.renderGround(map, NS, war, D, key);
      this.renderMarks(map, NS, war, D);
      // Once a conflict concludes the soldiers leave the field — arrows and
      // markers only while it's active; ground and marks stay for review.
      if (war.active) {
        this._sampleTrails(war, key);
        this.renderOrders(map, NS, war, D);
        this.renderRefugees(map, null, NS, war, D.refugees);
        this.renderUnits(map, NS, war, D, key, seen);
        if (this.renderAir) this.renderAir(map, NS, war, D, key, seen);
      } else if (this.renderAir) { clear(D.air); clear(D.airfields); D.airfields._bk = null; }
      this._fx = D.fx;
      this._checkAirstrikeLandings(war);
      this.renderAirstrikePlanes(map, null, NS, war);
      this.renderExplosions(map, null, NS, war);
      this.renderFlashes(map, null, NS, war);
      this._fx = null;
    }
    // drop keyed nodes of units no longer in any doc
    for (const [k, n] of this._unitNodes) if (!seen.has(k)) { n.g.remove(); this._unitNodes.delete(k); delete this._anim[k]; }
    if (!docs.some(d => d.active)) {
      this._anim = {}; this._flashAnim = {}; this._arrowAnim = {};
      this._refAnim = {}; this._inspectRef = null;
      this._lastStrength = {}; this._hitAt = {}; this._sel.clear();
    }
    this.ensureLoop();
    this.bindKeys();
    if (onWar) {
      if (!document.getElementById('war-frame')) this._mountFrame();
      if (this._measure && this._O.measure && !this._O.measure.firstChild) this._drawMeasure();
      this.renderToolbar(); this.renderUnitCard(); this.renderHud();
      if (this.renderAirDock) this.renderAirDock();
    } else {
      this._unmountFrame();
      this._removeToolbar(); this._removeUnitCard(); this._removeHud();
      if (this._removeAirDock) this._removeAirDock();
    }
  },

  _hideDoc(key) {
    const B = this._L.docs[key], O = this._O && this._O.docs[key];
    if (B) { clear(B.ground); clear(B.halo); B._groundKey = null; B._haloKey = null; }
    if (O) { clear(O.marks); O._marksKey = null; clear(O.orders); clear(O.refugees); clear(O.fx); if (O.air) clear(O.air); if (O.airfields) { clear(O.airfields); O.airfields._bk = null; } }
  },
  // one group per conflict doc inside each sublayer (z-order: every doc's
  // ground under every doc's units)
  _docLayers(NS, key, war) {
    const mkG = (parent) => { const g = document.createElementNS(NS, 'g'); g.setAttribute('data-doc', key); parent.appendChild(g); return g; };
    let B = this._L.docs[key];
    if (!B) { B = this._L.docs[key] = { halo: mkG(this._L.ground) }; B.ground = mkG(this._L.ground); }
    let O = this._O.docs[key];
    if (!O) { O = this._O.docs[key] = {}; for (const name of ['marks', 'airfields', 'orders', 'refugees', 'units', 'air', 'fx']) O[name] = mkG(this._O[name]); }
    const D = Object.assign(O, { ground: B.ground });
    D._groundKey = B._groundKey;
    D._base = B;
    const cls = 'war-doc-' + (war.kind === 'protest' ? 'protest' : 'war');
    for (const name of ['ground', 'marks', 'orders', 'units', 'air']) if (D[name].getAttribute('class') !== cls) D[name].setAttribute('class', cls);
    if (B.halo.getAttribute('class') !== cls) B.halo.setAttribute('class', cls);
    return D;
  },

  // Shared <defs>: hatch patterns, arrowheads. Built once per layer.
  _defs(NS, layer, which) {
    const defs = document.createElementNS(NS, 'defs');
    const pattern = (id, color, op1, op2) => {
      const pat = document.createElementNS(NS, 'pattern');
      pat.setAttribute('id', id);
      pat.setAttribute('width', '11'); pat.setAttribute('height', '11');
      pat.setAttribute('patternUnits', 'userSpaceOnUse');
      pat.setAttribute('patternTransform', 'rotate(45)');
      const bg = document.createElementNS(NS, 'rect');
      bg.setAttribute('width', '11'); bg.setAttribute('height', '11'); bg.setAttribute('fill', color); bg.setAttribute('fill-opacity', op1);
      const stripe = document.createElementNS(NS, 'rect');
      stripe.setAttribute('width', '2'); stripe.setAttribute('height', '11'); stripe.setAttribute('fill', color); stripe.setAttribute('fill-opacity', op2);
      pat.appendChild(bg); pat.appendChild(stripe);
      defs.appendChild(pat);
    };
    if (which !== 'markers') {
      pattern('war-hatch', '#9b2c22', '0.16', '0.30');
      pattern('war-hatch-def', '#24466e', '0.16', '0.30');
      pattern('war-hatch-protest', '#b0701c', '0.14', '0.30');
      defs.appendChild(this._radialGrad(NS, 'war-scorch', [[0, '#1e150e', 0.5], [0.45, '#2e2216', 0.3], [0.8, '#3a2a1a', 0.1], [1, '#3a2a1a', 0]]));
      defs.appendChild(this._radialGrad(NS, 'war-unrest-glow', [[0, '#e3a03c', 0.42], [0.55, '#e3a03c', 0.2], [1, '#e3a03c', 0]]));
      defs.appendChild(this._radialGrad(NS, 'war-unrest-riot', [[0, '#d2502a', 0.45], [0.55, '#d2502a', 0.22], [1, '#d2502a', 0]]));
    }
    const head = (id, cls) => {
      const m = document.createElementNS(NS, 'marker');
      m.setAttribute('id', id);
      m.setAttribute('viewBox', '0 0 10 10');
      m.setAttribute('refX', '7'); m.setAttribute('refY', '5');
      m.setAttribute('markerWidth', '4'); m.setAttribute('markerHeight', '4');
      m.setAttribute('orient', 'auto-start-reverse');
      const tip = document.createElementNS(NS, 'path');
      tip.setAttribute('d', 'M0,0 L10,5 L0,10 z');
      tip.setAttribute('class', cls);
      m.appendChild(tip);
      defs.appendChild(m);
    };
    if (which !== 'patterns') {
      head('war-head-att', 'war-head war-head-att');
      head('war-head-def', 'war-head war-head-def');
      head('war-head-sel', 'war-head war-head-sel');
      head('war-head-strike', 'war-head war-head-strike');
    }
    layer.insertBefore(defs, layer.firstChild);
  },

  /* ---------- ground: occupied territory + the front line ----------
     Every land cell of the war grid gets an owner: captured cells from
     war.cells, the attacker's homeland (grid.enemyCells) for the attacker,
     the Republic's provinces for the defender; sea and neutral cells take
     their nearest belligerent's value (multi-source BFS), so the 50% line
     only ever runs BETWEEN the two sides. Marching squares + Chaikin
     smoothing turn that into smooth loops: the attacker's loops fill the
     occupied provinces (clipped to them), and the same loops — clipped to
     belligerent land — are stroked as the front line. */
  _groundKey(war) {
    let h = 0;
    for (const k in (war.cells || {})) {
      const c = war.cells[k];
      for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0;
      h = (h * 7 + (c.o === 'att' ? 1 : 2)) | 0;
    }
    return [war.startedAt, Object.keys(war.cells || {}).length, h, (war.craters || []).length, (S().provinces || []).length, W.layer === 'war'].join(':');
  },
  renderGround(map, NS, war, D, key) {
    this._renderHalos(NS, war, D._base);
    const gk = this._groundKey(war);
    if (D._base._groundKey === gk) return;
    // the ground lives in the base map, so every rebuild repaints the whole
    // map: a front that moves every tick redraws at most every
    // WAR_GROUND_MIN_MS (a timer catches the last change up)
    const now = performance.now(), since = now - (D._base._groundAt || 0);
    if (D._base._groundKey && since < WAR_GROUND_MIN_MS) {
      if (!this._groundTimer) this._groundTimer = setTimeout(() => { this._groundTimer = null; this.refreshLayer(true); }, WAR_GROUND_MIN_MS - since + 30);
      return;
    }
    D._base._groundAt = now;
    D._base._groundKey = gk;
    clear(D.ground);
    const add = (tag, attrs) => {
      const n = document.createElementNS(NS, tag);
      for (const a in attrs) if (attrs[a] !== undefined && attrs[a] !== null) n.setAttribute(a, attrs[a]);
      D.ground.appendChild(n);
      return n;
    };
    for (const c of (war.craters || [])) this._crater(NS, D.ground, c);
    const g = war.grid;
    if (!g || !g.cols || !g.rows) return;
    const protest = war.kind === 'protest';
    const field = this._controlField(war, 'att');
    if (!field) return;
    const attD = this._loopsToPath(this._contours(field, g.cols, g.rows), g.cell);
    // clip targets: the Republic's provinces, and the belligerents' homelands
    const provShapes = (S().provinces || []).map(p => p.shape || (p.path ? 'M' + p.path.map(q => q.join(' ')).join(' L') + ' Z' : '')).filter(Boolean);
    const enemyIds = new Set(protest ? [] : Object.values(g.enemyCells || {}));
    const countries = ((S().settings || {}).map || {}).countries || [];
    const enemyShapes = countries.filter(c => enemyIds.has(c.id) && c.shape).map(c => c.shape);
    const defs = add('defs', {});
    const clip = (id, shapes) => {
      const cp = document.createElementNS(NS, 'clipPath');
      cp.setAttribute('id', id);
      for (const s of shapes) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', s); p.setAttribute('fill-rule', 'evenodd'); cp.appendChild(p); }
      defs.appendChild(cp);
      return `url(#${id})`;
    };
    const clipProv = clip('war-clip-prov-' + key, provShapes);
    const clipAll = clip('war-clip-bel-' + key, provShapes.concat(enemyShapes));
    if (attD) add('path', { d: attD, 'fill-rule': 'evenodd', 'clip-path': clipProv, fill: protest ? 'url(#war-hatch-protest)' : 'url(#war-hatch)', class: 'war-occupied' });
    // the defence's counter-occupation of enemy homeland
    if (!protest && enemyShapes.length && Object.values(war.cells || {}).some(c => c.o === 'def')) {
      const defField = this._controlField(war, 'def');
      const defD = defField && this._loopsToPath(this._contours(defField, g.cols, g.rows), g.cell);
      if (defD) add('path', { d: defD, 'fill-rule': 'evenodd', 'clip-path': clip('war-clip-enemy-' + key, enemyShapes), fill: 'url(#war-hatch-def)', class: 'war-occupied' });
    }
    // the front line: a heavy line with "teeth" (short bars) along it
    if (attD) {
      add('path', { d: attD, 'clip-path': clipAll, class: 'war-front war-front-base' + (protest ? ' war-front-protest' : ''), 'vector-effect': 'non-scaling-stroke' });
      add('path', { d: attD, 'clip-path': clipAll, class: 'war-front war-front-teeth' + (protest ? ' war-front-protest' : ''), 'vector-effect': 'non-scaling-stroke' });
    }
  },
  // Civil unrest glows where it is: a soft amber halo (the server's unrest
  // radius) round every city with a crowd in its streets. Drawn in the base
  // map under the city labels, rebuilt only when the set of cities changes.
  _renderHalos(NS, war, B) {
    const ids = war.kind === 'protest' && war.active ? ((war.stats || {}).unrestCities || []) : [];
    const hk = ids.join(',') + '|' + (war.protest && war.protest.protestorsViolent ? 1 : 0);
    if (B._haloKey === hk) return;
    B._haloKey = hk;
    clear(B.halo);
    for (const cid of ids) {
      const c = cityById(cid);
      if (!c || !c.pos) continue;
      const n = document.createElementNS(NS, 'circle');
      n.setAttribute('cx', c.pos[0]); n.setAttribute('cy', c.pos[1]); n.setAttribute('r', 150);
      n.setAttribute('class', 'war-unrest' + (war.protest && war.protest.protestorsViolent ? ' war-unrest-riot' : ''));
      B.halo.appendChild(n);
    }
  },
  // A crater: a scorch mark, a jagged bowl with a lighter rim and a scatter
  // of ejecta — shaped deterministically from its position, sized by its
  // blast, softening as it ages.
  _crater(NS, parent, c) {
    const r = c.r || 95;
    let h = Math.round(c.pos[0] * 7.13 + c.pos[1] * 13.7) | 0;
    const rnd = () => { h = (h * 1103515245 + 12345) | 0; return ((h >>> 8) & 0xffff) / 0xffff; };
    const ageMin = c.t ? (Date.now() - c.t) / 60000 : 0;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'war-crater');
    g.setAttribute('transform', `translate(${c.pos[0].toFixed(1)},${c.pos[1].toFixed(1)}) rotate(${Math.round(rnd() * 360)})`);
    g.style.opacity = String(Math.max(0.45, 1 - ageMin / 90).toFixed(2));
    const el2 = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const a in attrs) n.setAttribute(a, attrs[a]); g.appendChild(n); return n; };
    el2('ellipse', { rx: (r * 1.05).toFixed(1), ry: (r * (0.85 + rnd() * 0.2)).toFixed(1), fill: 'url(#war-scorch)', class: 'war-crater-scorch' });
    const pts = [];
    const n = 11;
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2, rr = r * 0.3 * (0.78 + rnd() * 0.44); pts.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
    const poly = (k) => 'M' + pts.map(p => (p[0] * k).toFixed(1) + ' ' + (p[1] * k).toFixed(1)).join(' L') + ' Z';
    el2('path', { d: poly(1.28), class: 'war-crater-rim', 'vector-effect': 'non-scaling-stroke' });
    el2('path', { d: poly(1), class: 'war-crater-bowl' });
    let ej = '';
    for (let i = 0; i < 9; i++) {
      const a = rnd() * Math.PI * 2, d = r * (0.48 + rnd() * 0.42), s = r * (0.025 + rnd() * 0.035);
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      ej += `M${(x - s).toFixed(1)} ${y.toFixed(1)} a${s.toFixed(1)},${s.toFixed(1)} 0 1 0 ${(2 * s).toFixed(1)},0 a${s.toFixed(1)},${s.toFixed(1)} 0 1 0 ${(-2 * s).toFixed(1)},0 `;
    }
    el2('path', { d: ej, class: 'war-crater-ejecta' });
    parent.appendChild(g);
  },
  // 1 where `side` holds the ground, 0 where the other side does; everything
  // else (sea, neutral soil) takes its nearest belligerent cell's value.
  _controlField(war, side) {
    const g = war.grid;
    const W_ = g.cols, H_ = g.rows, N = W_ * H_;
    const f = new Float32Array(N).fill(-1);
    const idx = (cx, cy) => (cx >= 0 && cy >= 0 && cx < W_ && cy < H_) ? cy * W_ + cx : -1;
    const set = (key, v) => { const p = key.indexOf(','); const i = idx(+key.slice(0, p), +key.slice(p + 1)); if (i >= 0) f[i] = v; };
    const att = side === 'att' ? 1 : 0, def = 1 - att;
    for (const pid in (g.provinceCells || {})) for (const c of g.provinceCells[pid]) { const i = idx(c[0], c[1]); if (i >= 0) f[i] = def; }
    const protest = war.kind === 'protest';
    if (!protest) for (const k in (g.enemyCells || {})) set(k, att);
    let any = false;
    for (const k in (war.cells || {})) {
      const o = war.cells[k].o;
      if (o === 'att' || o === 'def') { set(k, o === side ? 1 : 0); if (o === side) any = true; }
    }
    // for 'att' the homeland alone already draws the border front; for the
    // defence's counter-occupation we need at least one captured cell
    if (!any && side === 'def') return null;
    if (side === 'att' && !any && (protest || !Object.keys(g.enemyCells || {}).length)) return null;
    // multi-source BFS: unknown cells copy the nearest known value
    const q = new Int32Array(N); let qh = 0, qt = 0;
    for (let i = 0; i < N; i++) if (f[i] >= 0) q[qt++] = i;
    while (qh < qt) {
      const i = q[qh++], x = i % W_, y = (i / W_) | 0, v = f[i];
      if (x > 0 && f[i - 1] < 0) { f[i - 1] = v; q[qt++] = i - 1; }
      if (x < W_ - 1 && f[i + 1] < 0) { f[i + 1] = v; q[qt++] = i + 1; }
      if (y > 0 && f[i - W_] < 0) { f[i - W_] = v; q[qt++] = i - W_; }
      if (y < H_ - 1 && f[i + W_] < 0) { f[i + W_] = v; q[qt++] = i + W_; }
    }
    for (let i = 0; i < N; i++) if (f[i] < 0) f[i] = 0;
    return f;
  },
  // Marching squares at 0.5 over a W×H cell field (cell-centre lattice,
  // padded with 0 so every loop closes) → loops in cell units.
  _contours(f, W_, H_) {
    const val = (x, y) => (x < 0 || y < 0 || x >= W_ || y >= H_) ? 0 : f[y * W_ + x];
    const PW = W_ + 2; // padded lattice: vertex (x,y) for x∈[-1,W_]
    const eid = (x, y, vert) => (((y + 1) * PW + (x + 1)) * 2) + (vert ? 1 : 0);
    const pts = new Map();
    const ptOf = (id) => {
      if (pts.has(id)) return pts.get(id);
      const base = id >> 1, x = (base % PW) - 1, y = ((base / PW) | 0) - 1;
      const a = val(x, y), b = (id & 1) ? val(x, y + 1) : val(x + 1, y);
      const t = Math.max(0, Math.min(1, (0.5 - a) / ((b - a) || 1e-9)));
      const p = (id & 1) ? [x + 0.5, y + t + 0.5] : [x + t + 0.5, y + 0.5];
      pts.set(id, p);
      return p;
    };
    const segA = [], segB = [];
    const seg = (a, b) => { segA.push(a); segB.push(b); };
    for (let y = -1; y < H_; y++) {
      for (let x = -1; x < W_; x++) {
        const tl = val(x, y), tr = val(x + 1, y), br = val(x + 1, y + 1), bl = val(x, y + 1);
        const code = (tl > 0.5 ? 1 : 0) | (tr > 0.5 ? 2 : 0) | (br > 0.5 ? 4 : 0) | (bl > 0.5 ? 8 : 0);
        if (code === 0 || code === 15) continue;
        const top = eid(x, y, false), left = eid(x, y, true), right = eid(x + 1, y, true), bottom = eid(x, y + 1, false);
        switch (code) {
          case 1: case 14: seg(left, top); break;
          case 2: case 13: seg(top, right); break;
          case 3: case 12: seg(left, right); break;
          case 4: case 11: seg(right, bottom); break;
          case 6: case 9: seg(top, bottom); break;
          case 7: case 8: seg(left, bottom); break;
          case 5: seg(left, top); seg(right, bottom); break;
          case 10: seg(top, right); seg(bottom, left); break;
        }
      }
    }
    const adj = new Map();
    const link = (e, s) => { const l = adj.get(e); if (l) l.push(s); else adj.set(e, [s]); };
    for (let s = 0; s < segA.length; s++) { link(segA[s], s); link(segB[s], s); }
    const used = new Uint8Array(segA.length);
    const loops = [];
    for (let s0 = 0; s0 < segA.length; s0++) {
      if (used[s0]) continue;
      used[s0] = 1;
      const start = segA[s0];
      const loop = [ptOf(start)];
      let cur = s0, e = segB[s0];
      for (let guard = 0; guard < 100000 && e !== start; guard++) {
        loop.push(ptOf(e));
        const l = adj.get(e) || [];
        const nx = l[0] === cur ? l[1] : l[0];
        if (nx === undefined || used[nx]) break;
        used[nx] = 1;
        e = segA[nx] === e ? segB[nx] : segA[nx];
        cur = nx;
      }
      if (loop.length >= 3) loops.push(loop);
    }
    return loops;
  },
  // Chaikin-smoothed closed loops → SVG path in world units
  _loopsToPath(loops, cell) {
    let d = '';
    for (let loop of loops) {
      for (let it = 0; it < 3; it++) {
        const out = [];
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i], b = loop[(i + 1) % loop.length];
          out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
        }
        loop = out;
      }
      d += 'M' + loop.map(p => (p[0] * cell).toFixed(1) + ' ' + (p[1] * cell).toFixed(1)).join(' L') + ' Z ';
    }
    return d;
  },

  /* ---------- marks: objectives and fallen cities ---------- */
  _scaledGroup(NS, parent, pos, cls) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'war-scaled ' + cls);
    g.setAttribute('data-x', pos[0]); g.setAttribute('data-y', pos[1]);
    g.setAttribute('transform', `translate(${pos[0]},${pos[1]}) scale(${warMarkerScale(GameMap.view ? GameMap.view.k : 1)})`);
    parent.appendChild(g);
    return g;
  },
  renderMarks(map, NS, war, D) {
    if (war.kind === 'protest') { this._renderProtestMarks(NS, war, D); return; }
    const objs = (war.objectives || []).filter(o => o.pos);
    const held = (war.stats && war.stats.citiesHeld) || [];
    const mk = [war.startedAt, objs.map(o => o.id + o.status).join(','), held.join(',')].join('|');
    if (D._marksKey === mk) return;
    D._marksKey = mk;
    clear(D.marks);
    const add = (parent, tag, attrs, text) => {
      const n = document.createElementNS(NS, tag);
      for (const a in attrs) n.setAttribute(a, attrs[a]);
      if (text !== undefined) n.textContent = text;
      parent.appendChild(n);
      return n;
    };
    // fallen cities: a small flag in the occupier's colour
    for (const cid of held) {
      const c = cityById(cid);
      if (!c || !c.pos) continue;
      const g = this._scaledGroup(NS, D.marks, c.pos, 'war-fallen');
      add(g, 'path', { d: 'M-1,-2 V-24', class: 'war-fallen-pole' });
      add(g, 'path', { d: 'M-1,-24 h13 l-3,4.5 l3,4.5 h-13 z', class: 'war-fallen-flag' });
      add(g, 'title', {}, (c.name || cid) + ' — held by the invader');
    }
    // objectives: a numbered target; the next one pending is emphasised
    const pending = objs.filter(o => o.status !== 'done').sort((a, b) => a.priority - b.priority);
    const next = pending[0];
    const seenPos = new Set();
    for (const o of [...objs].sort((a, b) => a.priority - b.priority)) {
      const pk = Math.round(o.pos[0]) + ',' + Math.round(o.pos[1]);
      if (seenPos.has(pk) && o !== next) continue; // landing + seize on one city: one marker
      seenPos.add(pk);
      const done = o.status === 'done';
      const g = this._scaledGroup(NS, D.marks, o.pos, 'war-obj' + (done ? ' war-obj-done' : '') + (o === next ? ' war-obj-next' : ''));
      add(g, 'circle', { r: 15, class: 'war-obj-ring' });
      add(g, 'path', { d: 'M-21,0 h9 M12,0 h9 M0,-21 v9 M0,12 v9', class: 'war-obj-cross' });
      add(g, 'text', { y: 4, 'text-anchor': 'middle', class: 'war-obj-num' }, done ? '✓' : String(o.priority));
      if (o === next) add(g, 'text', { y: -25, 'text-anchor': 'middle', class: 'war-obj-tag' }, 'NEXT OBJECTIVE');
      add(g, 'title', {}, `Objective ${o.priority}: ${this.objLabel(o)} — ${this.objTarget(o)} · ${done ? 'achieved' : 'pending'}`);
    }
  },

  // A protest's map furniture: the movement's rally points (where the crowds
  // first gathered), the police posts, and a STRIKE sign on every workplace
  // the crowds have shut (property.vars.strike, set by the economy turn).
  // Live only while the protest runs; a finished one leaves the map clean.
  _renderProtestMarks(NS, war, D) {
    const p = war.protest || {};
    const strikes = war.active ? (S().properties || []).filter(pr => pr.vars && pr.vars.strike && Array.isArray(pr.pos)) : [];
    // a rally point / police post is marked once its people have moved off
    // it (while they stand there, their own markers say it)
    const vacant = (ids, side) => (ids || []).filter(cid => {
      const c = cityById(cid);
      return c && c.pos && !(war.units || []).some(u => u.side === side && !u.dead && u.strength > 0 && Math.hypot(u.pos[0] - c.pos[0], u.pos[1] - c.pos[1]) < 70);
    });
    const rally = vacant(p.baseCities, 'att'), posts = vacant(p.policeCities, 'def');
    const mk = [war.startedAt, war.active, rally.join(','), posts.join(','),
      strikes.map(pr => pr.id + ':' + Math.round(pr.vars.strike.degree * 100)).join(',')].join('|');
    if (D._marksKey === mk) return;
    D._marksKey = mk;
    clear(D.marks);
    if (!war.active) return;
    const add = (parent, tag, attrs, text) => {
      const n = document.createElementNS(NS, tag);
      for (const a in attrs) n.setAttribute(a, attrs[a]);
      if (text !== undefined) n.textContent = text;
      parent.appendChild(n);
      return n;
    };
    const org = entById(p.organizerId || war.attackerId);
    for (const cid of rally) {
      const c = cityById(cid);
      const g = this._scaledGroup(NS, D.marks, c.pos, 'war-rally');
      add(g, 'path', { d: 'M-12,-4 V-34', class: 'war-rally-pole' });
      add(g, 'path', { d: 'M-12,-34 H14 L9,-27.5 L14,-21 H-12 Z', class: 'war-rally-flag' });
      add(g, 'text', { x: 0, y: -24.6, 'text-anchor': 'middle', class: 'war-rally-text' }, 'RALLY');
      add(g, 'title', {}, `${c.name} — rally point${org ? ' of ' + org.name : ''}. The crowds gathered here first.`);
    }
    for (const cid of posts) {
      const c = cityById(cid);
      const g = this._scaledGroup(NS, D.marks, c.pos, 'war-post');
      add(g, 'rect', { x: -21, y: -33, width: 42, height: 12, rx: 2, class: 'war-post-box' });
      add(g, 'path', { d: 'M-17,-30.5 H-9 V-27 Q-9,-23.5 -13,-22 Q-17,-23.5 -17,-27 Z', class: 'war-post-shield' });
      add(g, 'text', { x: 4, y: -24.2, 'text-anchor': 'middle', class: 'war-post-text' }, 'POLICE');
      add(g, 'path', { d: 'M0,-21 V-6', class: 'war-post-stem' });
      add(g, 'title', {}, `${c.name} — police post. Detachments were stationed here when the protest began.`);
    }
    for (const pr of strikes) {
      const pct = Math.round((pr.vars.strike.degree || 0) * 100);
      const g = this._scaledGroup(NS, D.marks, pr.pos, 'war-strike-sign');
      add(g, 'path', { d: 'M0,-1 V-12', class: 'war-strike-stick' });
      add(g, 'rect', { x: -15, y: -23, width: 30, height: 11, rx: 1.5, class: 'war-strike-board' });
      add(g, 'text', { x: 0, y: -15.3, 'text-anchor': 'middle', class: 'war-strike-text' }, 'STRIKE');
      add(g, 'text', { x: 0, y: -26, 'text-anchor': 'middle', class: 'war-strike-pct' }, '−' + pct + '% output');
      add(g, 'title', {}, `${pr.name} — on strike since turn ${pr.vars.strike.sinceTurn}: output down ${pct}% while the crowds stay within reach.`);
    }
  },

  /* ---------- orders: arrows, warship fire, clash markers ----------
     Own-side movement arrows only (fog of war on enemy intent); attack
     arrows for both sides (an attack is visible through the fighting
     itself). Clash markers sit between engaged enemies, one per cluster —
     they replace the old per-unit pulsing rings, which animated (and
     repainted the map) forever. */
  renderOrders(map, NS, war, D) {
    const side = this.commandableSide(war);
    const live = (u) => u && !u.dead && u.state !== 'dead' && u.strength > 0;
    const posOf = (u) => { const a = this._anim[this._ukey(war, u)]; return a && a.curPos ? a.curPos : u.pos; };
    const add = (tag, attrs) => {
      const n = document.createElementNS(NS, tag);
      for (const a in attrs) if (attrs[a] !== undefined) n.setAttribute(a, attrs[a]);
      D.orders.appendChild(n);
      return n;
    };
    this._arrowAnim = this._arrowAnim || {};
    // trails under everything: where every column has come from (war-map.js)
    this._renderTrails(war, this.docKeyOf(war), D.orders);
    // routes: the whole remaining road a unit will take. Your own side's
    // always; the enemy's only for the GM (fog of war on intent — you see
    // where they have been, not where they are going).
    const omniscient = isGM();
    for (const u of war.units) {
      if (!live(u) || !u.dest || u.attackId) continue;
      const own = u.side === side;
      if (!own && !omniscient) continue;
      const key = this._ukey(war, u);
      const pts = [];
      if (Array.isArray(u.path) && u.path.length) for (let i = (u.pathIdx || 0); i < u.path.length; i++) pts.push(u.path[i]);
      pts.push(u.dest);
      const from = posOf(u);
      const tail = pts.map(p => 'L' + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
      const sel = this._sel.has(u.id);
      const d = 'M' + from[0].toFixed(1) + ' ' + from[1].toFixed(1) + ' ' + tail;
      const casing = own ? add('path', { d, class: 'war-move-case' + (sel ? ' war-move-case-sel' : ''), 'vector-effect': 'non-scaling-stroke' }) : null;
      const node = add('path', {
        d, class: 'war-move ' + (sel ? 'war-move-sel' : 'war-move-' + u.side) + (own ? '' : ' war-move-foe'),
        'marker-end': `url(#war-head-${sel ? 'sel' : u.side})`, 'vector-effect': 'non-scaling-stroke'
      });
      this._arrowAnim[key] = { node, casing, tail };
    }
    this._renderRouteLabels(war, D.orders);
    for (const u of war.units) {
      if (!live(u) || !u.attackId) continue;
      const t = war.units.find(x => x.id === u.attackId);
      if (!live(t)) continue;
      const a = posOf(u), b = posOf(t);
      add('path', { d: `M${a[0].toFixed(1)} ${a[1].toFixed(1)} L${b[0].toFixed(1)} ${b[1].toFixed(1)}`, class: 'war-strike-arrow war-strike-' + u.side, 'marker-end': 'url(#war-head-strike)', 'vector-effect': 'non-scaling-stroke' });
    }
    // warships firing at range (cosmetic — the engine resolved the shot)
    const range = (window.WarEngine && WarEngine.WARSHIP_RANGE) || 180;
    for (const w of war.units) {
      if (w.kind !== 'warship' || w.state !== 'fighting' || !live(w)) continue;
      let best = null, bd = Infinity;
      for (const e of war.units) {
        if (e.side === w.side || !live(e) || e.state === 'embarked') continue;
        const d = Math.hypot(e.pos[0] - w.pos[0], e.pos[1] - w.pos[1]);
        if (d < bd) { bd = d; best = e; }
      }
      if (!best || bd > range) continue;
      const a = posOf(w), b = posOf(best);
      add('path', { d: `M${a[0].toFixed(1)} ${a[1].toFixed(1)} L${b[0].toFixed(1)} ${b[1].toFixed(1)}`, class: 'war-shellfire', 'vector-effect': 'non-scaling-stroke' });
    }
    // clash markers: engaged enemy pairs, clustered
    const clashes = [];
    const atts = war.units.filter(u => live(u) && u.side === 'att');
    const defs = war.units.filter(u => live(u) && u.side === 'def');
    for (const a of atts) {
      for (const d of defs) {
        if (a.state !== 'fighting' && d.state !== 'fighting') continue;
        const dist = Math.hypot(a.pos[0] - d.pos[0], a.pos[1] - d.pos[1]);
        if (dist > 75) continue;
        const mid = [(a.pos[0] + d.pos[0]) / 2, (a.pos[1] + d.pos[1]) / 2];
        const near = clashes.find(c => Math.hypot(c.pos[0] - mid[0], c.pos[1] - mid[1]) < 90);
        if (near) { near.n++; near.str += a.strength + d.strength; }
        else clashes.push({ pos: mid, n: 1, str: a.strength + d.strength });
      }
    }
    // ...and fights across the two conflicts (war troops vs protest crowds or
    // police — resolved by the engine's stepCrossCombat), drawn by the war doc
    if (war.kind !== 'protest') {
      const P = this._preds.protest && this._preds.protest.war;
      if (P && P.active) {
        for (const a of war.units) {
          if (!live(a) || a.state !== 'fighting') continue;
          for (const b of P.units) {
            if (!live(b) || b.state !== 'fighting' || Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]) > 60) continue;
            const mid = [(a.pos[0] + b.pos[0]) / 2, (a.pos[1] + b.pos[1]) / 2];
            const near = clashes.find(c => Math.hypot(c.pos[0] - mid[0], c.pos[1] - mid[1]) < 90);
            if (near) { near.n++; near.str += a.strength + b.strength; } else clashes.push({ pos: mid, n: 1, str: a.strength + b.strength, cross: true });
          }
        }
      }
    }
    // protests: a crowd face to face with a police line while neither side
    // may fight is a standoff — two opposed chevrons between them
    if (war.kind === 'protest' && protestPosture(war.protest) === 'peaceful') {
      const stand = [];
      for (const a of atts) {
        if (a.state === 'fighting') continue;
        for (const d of defs) {
          if (d.state === 'fighting') continue;
          const dist = Math.hypot(a.pos[0] - d.pos[0], a.pos[1] - d.pos[1]);
          if (dist > 70) continue;
          const mid = [(a.pos[0] + d.pos[0]) / 2, (a.pos[1] + d.pos[1]) / 2];
          if (clashes.some(c => Math.hypot(c.pos[0] - mid[0], c.pos[1] - mid[1]) < 60)) continue;
          const near = stand.find(c => Math.hypot(c.pos[0] - mid[0], c.pos[1] - mid[1]) < 90);
          if (near) near.n++; else stand.push({ pos: mid, n: 1 });
        }
      }
      for (const c of stand) {
        const g = this._scaledGroup(NS, D.orders, c.pos, 'war-standoff');
        g.innerHTML = '<rect x="-15" y="-9" width="30" height="18" rx="9" class="war-standoff-bg"/>' +
          '<path d="M-10,-5 L-3,0 L-10,5" class="war-standoff-att"/><path d="M10,-5 L3,0 L10,5" class="war-standoff-def"/>' +
          '<title>Standoff — the crowd faces the police line. No one can strike until one side escalates.</title>';
      }
    }
    for (const c of clashes) {
      const g = this._scaledGroup(NS, D.orders, c.pos, 'war-clash');
      const big = c.n > 2 || c.str > 12000;
      const s = big ? 1.25 : 1;
      const star = document.createElementNS(NS, 'path');
      const pts = [];
      for (let i = 0; i < 16; i++) { const r = (i % 2 ? 7 : 14) * s, ang = i * Math.PI / 8; pts.push((Math.cos(ang) * r).toFixed(1) + ' ' + (Math.sin(ang) * r).toFixed(1)); }
      star.setAttribute('d', 'M' + pts.join(' L') + ' Z');
      star.setAttribute('class', 'war-clash-burst');
      g.appendChild(star);
      const x = document.createElementNS(NS, 'path');
      x.setAttribute('d', `M${-6 * s},${-6 * s} L${6 * s},${6 * s} M${6 * s},${-6 * s} L${-6 * s},${6 * s}`);
      x.setAttribute('class', 'war-clash-x');
      g.appendChild(x);
      const t = document.createElementNS(NS, 'title');
      t.textContent = c.cross ? `Street fighting — the war's troops and the protest in contact (${c.n})` : `Engagement — ${c.n} unit pair${c.n === 1 ? '' : 's'} in contact`;
      g.appendChild(t);
    }
  },

  // Refugee-column fade: opacity as a pure function of the predicted tick
  // clock (fade in over ~1.5 ticks after spawn; fade out over the engine's
  // REFUGEE_FADE_TICKS window after arrival or annihilation).
  _refOpacity(war, r) {
    const interval = Math.max(200, (war.tickMs || 2000) / (war.speed || 1));
    const frac = Math.max(0, Math.min(1, (Date.now() - (war._lastTick || Date.now())) / interval));
    const tickF = (war.tick || 0) + frac;
    const fadeTicks = (window.WarEngine && WarEngine.REFUGEE_FADE_TICKS) || 4;
    let o = Math.min(1, Math.max(0, (tickF - (r.spawnedTick || 0)) / 1.5));
    const endTick = r.arrived != null ? r.arrived : (r.count <= 0 ? r.deadTick : null);
    if (endTick != null) o = Math.min(o, Math.max(0, 1 - (tickF - endTick) / Math.max(1, fadeTicks - 1)));
    return Math.max(0, Math.min(0.92, o));
  },
  // Refugee columns (Phase 28) — civilian flight made visible: a small
  // neutral marker per war.refugees entry walking toward shelter. Clickable
  // for the info card, never commandable. A capped array (REFUGEE_MAX).
  renderRefugees(map, mk, NS, war, parent) {
    const list = war.refugees;
    const liveIds = new Set();
    if (Array.isArray(list) && list.length) {
      const scaleNow = warMarkerScale(map.view ? map.view.k : 1);
      for (const r of list) {
        liveIds.add(r.id);
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', 'war-refugee' + (this._inspectRef === r.id ? ' war-refugee-sel' : ''));
        const prevAnim = this._refAnim[r.id];
        const sameLeg = prevAnim && prevAnim.to &&
          Math.abs(prevAnim.to[0] - r.pos[0]) < 0.5 && Math.abs(prevAnim.to[1] - r.pos[1]) < 0.5;
        const from = prevAnim ? (prevAnim.curPos || prevAnim.to) : r.pos;
        g.setAttribute('transform', `translate(${from[0]},${from[1]}) scale(${scaleNow})`);
        g.style.opacity = String(this._refOpacity(war, r));
        const box = document.createElementNS(NS, 'rect');
        box.setAttribute('x', -15); box.setAttribute('y', -8); box.setAttribute('width', 30); box.setAttribute('height', 16);
        box.setAttribute('rx', 8);
        box.setAttribute('class', 'war-refugee-box');
        g.appendChild(box);
        // three walking figures (dots) — no emoji, cheap to paint
        const figs = document.createElementNS(NS, 'path');
        figs.setAttribute('d', 'M-7,-1 a2,2 0 1 0 0.01,0 M0,-1 a2,2 0 1 0 0.01,0 M7,-1 a2,2 0 1 0 0.01,0 M-9,4 h4 M-2,4 h4 M5,4 h4');
        figs.setAttribute('class', 'war-refugee-figs');
        g.appendChild(figs);
        const label = document.createElementNS(NS, 'text');
        label.setAttribute('class', 'war-refugee-count');
        label.setAttribute('text-anchor', 'middle'); label.setAttribute('y', 18);
        const n = Math.max(0, Math.round(r.count || 0));
        label.textContent = '≈' + (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));
        g.appendChild(label);
        const title = document.createElementNS(NS, 'title');
        title.textContent = `Refugee column — ≈${n.toLocaleString('en-US')} civilians fleeing ${r.fromName || r.from} for ${r.toName || r.to}`;
        g.appendChild(title);
        g.addEventListener('pointerup', (e) => {
          if (e.button !== 0 || this._airPlan || this._spawnArmed || this._tool || GameMap.lastDragMoved) return;
          e.stopPropagation();
          this._inspectRef = r.id;
          this._inspect = null;
          this.refreshLayer(true);
        });
        parent.appendChild(g);
        if (sameLeg) { prevAnim.node = g; prevAnim.r = r; prevAnim.war = war; }
        else this._refAnim[r.id] = { from: from.slice(), to: r.pos.slice(), t0: performance.now(), dur: this._tweenMs(), curPos: from.slice(), node: g, r, war };
      }
    }
    for (const id in this._refAnim) if (!liveIds.has(id)) delete this._refAnim[id];
    if (this._inspectRef && !liveIds.has(this._inspectRef)) this._inspectRef = null;
  },

  /* ---------- units (keyed, patched in place) ----------
     NATO-style symbols: a light-filled frame in the side's colour (land
     units a rectangle, naval units a rounded hull frame), the branch symbol
     drawn in ink inside it (infantry ✕, armour track, marines ✕ + waves,
     garrison ✕ + bastion, police shield, crowd flag…), the size marker above
     (I/II/III/X/XX from the unit's establishment strength), and a strength
     bar + thin morale bar below. Name labels appear once you zoom in. */
  _ukey(war, u) { return this.docKeyOf(war) + ':' + u.id; },
  // Protestors march under the organizing entity's own flag: whenever the
  // organizer ships a logo (party/company/nation), crowd markers show that
  // emblem instead of the generic crowd symbol.
  _protestorFlag(war, u) {
    if (!u || u.kind !== 'protestor' || u.state === 'transport') return null;
    const orgId = war && war.protest && war.protest.organizerId;
    if (!orgId) return null;
    const ent = S() && S().entities && S().entities.find(e => e.id === orgId);
    return (ent && ent.logo) || null;
  },
  _echelon(u) {
    const s = u.maxStrength || u.strength || 0;
    return s >= 8000 ? 'XX' : s >= 3000 ? 'X' : s >= 1200 ? 'III' : s >= 400 ? 'II' : 'I';
  },
  _symbol(u) {
    const naval = u.kind === 'boat' || u.kind === 'warship';
    const afloat = u.state === 'transport';
    // Civil unrest reads as people, not formations: a crowd is a rounded
    // pill of figures, the police a shield with a badge.
    if (!afloat && u.kind === 'protestor') return { frame: WAR_CROWD_FRAME, sym: WAR_CROWD_FIGS, naval: false };
    if (!afloat && u.kind === 'police') return { frame: WAR_POLICE_FRAME, sym: WAR_POLICE_BADGE, naval: false };
    const frame = (naval || afloat)
      ? 'M-16,-6 Q-16,-11 -11,-11 H11 Q16,-11 16,-6 V3 Q16,11 0,11 Q-16,11 -16,3 Z'
      : 'M-17,-11 H17 V11 H-17 Z';
    const X = 'M-17,-11 L17,11 M17,-11 L-17,11';
    const sym = {
      infantry: X,
      armored: 'M-9,-5 H9 A5,5 0 0 1 9,5 H-9 A5,5 0 0 1 -9,-5 Z',
      marine: X + ' M-12,7 q3,-3 6,0 t6,0 t6,0 t6,0',
      garrison: X + ' M-6,-6 H6 V6 H-6 Z',
      reserve: X + ' M0,-11 V11',
      boat: 'M-9,1 H9 L5,6 H-5 Z M0,1 V-7 L5,-2',
      warship: 'M-11,1 H11 L7,6 H-7 Z M-4,1 V-4 H4 V1 M4,-2 H10',
      protestor: 'M-6,7 V-8 L7,-4 L-6,0 M-11,7 H11',
      police: 'M0,-8 L7,-5 V0 Q7,6 0,9 Q-7,6 -7,0 V-5 Z'
    }[u.kind] || X;
    return { frame, sym: afloat ? 'M-9,1 H9 L5,6 H-5 Z M0,1 V-7 L5,-2' : sym, naval: naval || afloat };
  },
  _bindUnitEvents(layer) {
    const hit = (e) => {
      const n = e.target.closest && e.target.closest('[data-wu]');
      if (!n) return null;
      const rec = this._unitNodes.get(n.getAttribute('data-wu'));
      return rec ? rec : null;
    };
    layer.addEventListener('pointerdown', (e) => {
      const rec = hit(e);
      if (!rec || e.button !== 0 || this._airPlan || this._spawnArmed || this._tool) return;
      if (rec.own) e.stopPropagation(); // never start a pan under a click on your own unit
    });
    layer.addEventListener('pointerup', (e) => {
      if (this._swallowUp) { this._swallowUp = false; return; } // the press was a tool/planner gesture
      const rec = hit(e);
      if (!rec || e.button !== 0 || this._airPlan || this._spawnArmed || this._tool) return;
      if (!rec.own && GameMap.lastDragMoved) return; // the press over an enemy became a pan
      e.stopPropagation();
      if (rec.own) { this.onUnitClick(rec.unitId, e); return; }
      if (rec.enemy) {
        // tap-orders: with a selection, a tap on an enemy is an attack order
        if (this._tapOrders && this._sel.size && this.commandable()) { this._issueAttack(rec.unitId); return; }
        this._inspect = rec.unitId; this._inspectRef = null;
        this.refreshLayer(true);
      }
    });
  },
  renderUnits(map, NS, war, D, key, seen) {
    this._unitNodes = this._unitNodes || new Map();
    const cmdSide = this.commandableSide(war);
    const canCommand = this.commandable(war);
    const isActiveDoc = this.activeAuth() && this.docKeyOf(this.activeAuth()) === key;
    const scaleNow = warMarkerScale(map.view ? map.view.k : 1);
    const now = Date.now();
    const flagOf = (u) => this._protestorFlag(war, u);
    for (const u of war.units) {
      const isDead = u.dead || u.state === 'dead';
      // corpses fade from the map after a while (the record keeps them)
      if (isDead && (war.tick - (u.deadAt || war.tick)) > 60) continue;
      const k = this._ukey(war, u);
      seen.add(k);
      let rec = this._unitNodes.get(k);
      if (!rec) {
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('data-wu', k);
        // body: the (crowd-size) scale; inner: the hit jolt (a CSS transform)
        const body = document.createElementNS(NS, 'g');
        const inner = document.createElementNS(NS, 'g');
        inner.setAttribute('class', 'wu-inner');
        const ring = document.createElementNS(NS, 'circle'); ring.setAttribute('r', 25); ring.setAttribute('class', 'wu-ring');
        const frame = document.createElementNS(NS, 'path'); frame.setAttribute('class', 'wu-frame');
        const sym = document.createElementNS(NS, 'path'); sym.setAttribute('class', 'wu-sym');
        const ech = document.createElementNS(NS, 'text'); ech.setAttribute('class', 'wu-ech'); ech.setAttribute('y', -14); ech.setAttribute('text-anchor', 'middle');
        const cut = document.createElementNS(NS, 'path'); cut.setAttribute('class', 'wu-cut'); cut.setAttribute('d', 'M17,-17 l6,10 h-12 z');
        const bars = document.createElementNS(NS, 'g');
        const hpBg = document.createElementNS(NS, 'rect'); hpBg.setAttribute('class', 'wu-bar-bg'); hpBg.setAttribute('x', -17); hpBg.setAttribute('y', 13); hpBg.setAttribute('width', 34); hpBg.setAttribute('height', 6);
        const hp = document.createElementNS(NS, 'rect'); hp.setAttribute('class', 'wu-hp'); hp.setAttribute('x', -17); hp.setAttribute('y', 13); hp.setAttribute('height', 3.5);
        const org = document.createElementNS(NS, 'rect'); org.setAttribute('class', 'wu-org'); org.setAttribute('x', -17); org.setAttribute('y', 17); org.setAttribute('height', 2);
        const label = document.createElementNS(NS, 'text'); label.setAttribute('class', 'wu-label'); label.setAttribute('y', 30); label.setAttribute('text-anchor', 'middle');
        const title = document.createElementNS(NS, 'title');
        inner.appendChild(frame); inner.appendChild(sym); inner.appendChild(ech);
        body.appendChild(inner);
        bars.appendChild(hpBg); bars.appendChild(hp); bars.appendChild(org); bars.appendChild(label);
        g.appendChild(ring); g.appendChild(body); g.appendChild(cut); g.appendChild(bars); g.appendChild(title);
        rec = { g, ring, body, inner, bars, frame, sym, ech, hp, org, label, title, img: null, extra: null, v: {} };
        this._unitNodes.set(k, rec);
      }
      if (rec.g.parentNode !== D.units) D.units.appendChild(rec.g);
      const v = rec.v;
      rec.unitId = u.id;
      rec.own = isActiveDoc && canCommand && !isDead && u.side === cmdSide;
      rec.enemy = isActiveDoc && !isDead && u.side !== cmdSide;
      // shape: kind/state-dependent frame + symbol (or the organiser's flag)
      const flag = !isDead && flagOf(u);
      const civil = (u.kind === 'protestor' || u.kind === 'police') && u.state !== 'transport';
      const shapeSig = u.kind + '|' + (u.state === 'transport') + '|' + (flag || '') + '|' + this._echelon(u) + '|' + isDead;
      if (v.shape !== shapeSig) {
        v.shape = shapeSig;
        const s = this._symbol(u);
        rec.frame.setAttribute('d', s.frame);
        rec.sym.setAttribute('d', isDead ? 'M-11,-7 L11,7 M11,-7 L-11,7' : s.sym);
        v.ech = null;
        if (rec.img) { rec.img.remove(); rec.img = null; }
        if (rec.extra) { rec.extra.remove(); rec.extra = null; }
        if (!isDead && u.kind === 'protestor' && civil) {
          // a crowd carries placards while peaceful; flames show once it riots
          // (CSS swaps them on .wu-riot); the organizer's banner flies above
          const x = rec.extra = document.createElementNS(NS, 'g');
          x.setAttribute('class', 'wu-extra');
          x.innerHTML = '<path class="wu-placard-stick" d="M13,-10 V-21"/><path class="wu-placard" d="M7,-27 H19 V-20 H7 Z"/>' +
            '<path class="wu-fire" d="M14,-9 C8,-12 9,-19 13,-25 C14,-20 16,-19 17,-22 C21,-16 20,-11 14,-9 Z"/>' +
            (flag ? '<path class="wu-banner-pole" d="M-16,-10 V-29"/><rect class="wu-banner" x="-16" y="-29" width="11" height="8"/>' : '');
          if (flag) {
            rec.img = document.createElementNS(NS, 'image');
            rec.img.setAttribute('class', 'wu-flag');
            rec.img.setAttribute('href', flag);
            rec.img.setAttribute('x', -16); rec.img.setAttribute('y', -29); rec.img.setAttribute('width', 11); rec.img.setAttribute('height', 8);
            rec.img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
            x.appendChild(rec.img);
          }
          rec.inner.insertBefore(x, rec.frame);
        } else if (flag) {
          rec.img = document.createElementNS(NS, 'image');
          rec.img.setAttribute('class', 'wu-flag');
          rec.img.setAttribute('href', flag);
          rec.img.setAttribute('x', -9); rec.img.setAttribute('y', -9); rec.img.setAttribute('width', 18); rec.img.setAttribute('height', 18);
          rec.inner.appendChild(rec.img);
          rec.sym.setAttribute('d', '');
        }
      }
      // size marker: a headcount for crowds and police, the echelon otherwise
      const ech = isDead ? '' : civil ? warHeads(u.strength) : this._echelon(u);
      if (v.ech !== ech) { v.ech = ech; rec.ech.textContent = ech; }
      const sc = isDead || !civil ? 1 : warCrowdScale(u);
      if (v.scale !== sc) {
        v.scale = sc;
        rec.body.setAttribute('transform', sc === 1 ? '' : `scale(${sc})`);
        rec.bars.setAttribute('transform', sc === 1 ? '' : `translate(0,${(11 * (sc - 1)).toFixed(1)})`);
        rec.ring.setAttribute('r', Math.round(25 * Math.max(1, sc)));
      }
      // state classes
      const fighting = u.state === 'fighting';
      const pp = war.protest || {};
      const cls = 'wu wu-' + u.side + ' wu-k-' + (civil ? u.kind : 'mil') +
        (civil && u.kind === 'protestor' && pp.protestorsViolent ? ' wu-riot' : '') +
        (civil && u.kind === 'police' && (pp.govViolent || pp.protestorsViolent) ? ' wu-force' : '') +
        (isDead ? ' wu-dead' : '') + (this._sel.has(u.id) && isActiveDoc ? ' wu-sel' : '') +
        (rec.own ? ' wu-cmd' : '') + (rec.enemy ? ' wu-inspect' + (this._sel.size ? ' wu-attackable' : '') : '') +
        (u.nationId && !civil ? ' wu-ally' : '') + (fighting ? ' wu-fight' : '') + (u.state === 'routed' ? ' wu-routed' : '') +
        (!isDead && u.supplied === false ? ' wu-cutoff' : '') + (this._inspect === u.id && isActiveDoc ? ' wu-inspected' : '');
      if (v.cls !== cls) { v.cls = cls; rec.g.setAttribute('class', cls); }
      // bars
      const pct = isDead ? 0 : Math.max(0, Math.min(1, u.strength / (u.maxStrength || u.strength || 1)));
      const hpW = Math.round(pct * 34 * 2) / 2;
      if (v.hpW !== hpW) { v.hpW = hpW; rec.hp.setAttribute('width', hpW); }
      const hpCls = 'wu-hp ' + (pct > 0.6 ? 'wu-hp-ok' : pct > 0.3 ? 'wu-hp-mid' : 'wu-hp-low');
      if (v.hpCls !== hpCls) { v.hpCls = hpCls; rec.hp.setAttribute('class', hpCls); }
      const orgPct = Math.max(0, Math.min(100, typeof u.org === 'number' ? u.org : 100));
      const orgW = isDead ? 0 : Math.round(orgPct * 0.34 * 2) / 2;
      if (v.orgW !== orgW) { v.orgW = orgW; rec.org.setAttribute('width', orgW); rec.org.setAttribute('class', 'wu-org' + (orgPct < WAR_ROUT_ORG ? ' wu-org-low' : '')); }
      if (v.name !== u.name) { v.name = u.name; rec.label.textContent = u.name.length > 26 ? u.name.slice(0, 25) + '…' : u.name; }
      const tip = isDead ? `${u.name} — ${civil ? 'dispersed' : 'destroyed'}`
        : civil ? `${u.name} — ${u.kind === 'protestor' ? 'crowd of ≈' + warHeads(u.strength) + (pp.protestorsViolent ? ' · rioting' : ' · peaceful') : warHeads(u.strength) + ' officers' + (pp.govViolent ? ' · force authorized' : pp.protestorsViolent ? ' · defending' : ' · holding the line')}` +
          (u.state === 'fighting' ? ' · in clashes' : u.state === 'routed' ? ' · scattering' : u.dest ? ' · on the move' : '') + ` · morale ${Math.round(orgPct)}%`
        : `${u.name} — ${Math.round(u.strength).toLocaleString('en-US')}/${(u.maxStrength || 0).toLocaleString('en-US')} · ${u.state} · morale ${Math.round(orgPct)}%` +
          (u.nationId ? ` · ${entName(u.nationId)} contingent` : '') + (u.supplied === false ? ' · CUT OFF' : '');
      if (v.tip !== tip) { v.tip = tip; rec.title.textContent = tip; }
      // damage feedback: a drop in strength plays a one-shot jolt
      const prevStrength = this._lastStrength[k];
      if (!isDead && prevStrength !== undefined && u.strength < prevStrength - 0.001) {
        this._hitAt[k] = now;
        // alternate between two identical animations so a fresh hit restarts
        // the jolt without forcing a synchronous layout of the whole map
        rec.hitAlt = !rec.hitAlt;
        rec.inner.classList.remove('wu-hit', 'wu-hit2');
        rec.inner.classList.add(rec.hitAlt ? 'wu-hit2' : 'wu-hit');
        clearTimeout(rec.hitTimer);
        rec.hitTimer = setTimeout(() => rec.inner.classList.remove('wu-hit', 'wu-hit2'), WAR_HIT_FX_MS);
      }
      this._lastStrength[k] = u.strength;
      // position: corpses stay put; the living glide (tweened by the loop)
      if (isDead) {
        delete this._anim[k];
        const tf = `translate(${u.pos[0].toFixed(1)},${u.pos[1].toFixed(1)}) scale(${scaleNow})`;
        if (v.tf !== tf) { v.tf = tf; rec.g.setAttribute('transform', tf); }
        continue;
      }
      const prev = this._anim[k];
      const sameLeg = prev && prev.to && Math.abs(prev.to[0] - u.pos[0]) < 0.5 && Math.abs(prev.to[1] - u.pos[1]) < 0.5;
      if (sameLeg) { prev.node = rec.g; continue; }
      const from = prev ? (prev.curPos || prev.to) : u.pos;
      if (!prev) rec.g.setAttribute('transform', `translate(${from[0].toFixed(1)},${from[1].toFixed(1)}) scale(${scaleNow})`);
      this._anim[k] = { from: from.slice(), to: u.pos.slice(), t0: performance.now(), dur: prev ? this._tweenMs() : 1, curPos: from.slice(), node: rec.g, settled: false };
    }
    for (const id in this._lastStrength) if (id.startsWith(key + ':') && !seen.has(id)) { delete this._lastStrength[id]; delete this._hitAt[id]; }
  },

  renderFlashes(map, mk, NS, war) {
    const now = Date.now();
    let i = 0;
    const parent = this._fx || map.warLayer;
    for (const ev of (war.events || [])) {
      i++;
      if (!ev.pos) continue;
      // 'battle' events fire constantly mid-war — the clash markers carry
      // them; only rarer kinds (capture/landing/milestone) flash.
      if (ev.kind === 'battle') continue;
      const age = now - ev.t;
      if (age > 4000) continue;
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', ev.pos[0]); c.setAttribute('cy', ev.pos[1]); c.setAttribute('r', 34);
      c.setAttribute('class', 'war-flash war-flash-' + ev.kind);
      c.setAttribute('vector-effect', 'non-scaling-stroke');
      c.style.opacity = String(1 - age / 4000);
      const title = document.createElementNS(NS, 'title'); title.textContent = ev.text;
      c.appendChild(title);
      parent.appendChild(c);
      const fid = ev.t + '_' + i;
      this._flashAnim[fid] = { node: c, t0: performance.now() - age, life: 4000 };
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
    (this._fx || map.warLayer).appendChild(g);
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
      if (s.squadronId) continue; // a squadron's bombs — the squadron itself is drawn by war-air.js
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
  // Stamps are keyed per conflict doc ('war|<id>'): with a war and a protest
  // both live, a shared key space let one doc's pass forget the other's.
  _checkAirstrikeLandings(war) {
    const pre = this.docKeyOf(war) + '|';
    for (const s of (war.airstrikes || [])) {
      if (s.done && !((pre + s.id) in this._strikeImpactAt)) {
        this._strikeImpactAt[pre + s.id] = Date.now();
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
  // Impact FX — a conventional bomb, top-down, per blast (a squadron's stick
  // detonates bomb by bomb along its run, WAR_STICK_STAGGER_MS apart):
  //   · 0–140ms    a white-hot FLASH and a ground SHOCK RING racing out to
  //                ~1.8× the blast radius;
  //   · 0–700ms    SPARKS — burning debris thrown outward;
  //   · 0–1300ms   the FIREBALL: three churning gradient blobs that swell,
  //                then shrink and darken into the smoke;
  //   · 250ms–end  the SMOKE plume: grey-brown puffs billowing up and
  //                drifting downwind, lingering ~5s.
  // No filters (a blur repaints expensively every frame) — gradients only.
  // Recreated each paint and posed from the impact time (ensureLoop →
  // _updateExplosion), so it survives layer rebuilds without restarting.
  renderExplosions(map, mk, NS, war) {
    const now = Date.now();
    const byId = {};
    for (const s of (war.airstrikes || [])) byId[s.id] = s;
    const bombR = (window.WarEngine && WarEngine.BOMB_RADIUS) || 95;
    let defs = null; // built lazily — only when at least one explosion is live this pass
    const pre = this.docKeyOf(war) + '|';
    for (const sid in this._strikeImpactAt) {
      if (!sid.startsWith(pre)) continue; // the other conflict's blasts
      const id = sid.slice(pre.length);
      const strike = byId[id];
      // Forget the impact stamp ONLY once the strike has left the war doc
      // entirely (the engine prunes it AIRSTRIKE_PRUNE_TICKS after impact) —
      // forgetting it when the FX ended let the still-done strike re-stamp
      // and REPLAY the explosion until the prune caught up.
      if (!strike) { delete this._strikeImpactAt[sid]; delete this._explosionAnim[sid]; continue; }
      const delay = strike.squadronId ? (Number(String(id).split('-').pop()) || 0) * WAR_STICK_STAGGER_MS : 0;
      const t0 = this._strikeImpactAt[sid] + delay;
      const age = now - t0;
      if (age > EXPLOSION_LIFE_MS) { delete this._explosionAnim[sid]; continue; } // FX over — keep the stamp (see above)

      if (!defs) {
        defs = document.createElementNS(NS, 'defs');
        (this._fx || map.warLayer).appendChild(defs);
        defs.appendChild(this._radialGrad(NS, 'war-blast-glow', [[0, '#fff2c4', 0.9], [0.35, '#ffb347', 0.45], [1, '#ff7a1a', 0]]));
        defs.appendChild(this._radialGrad(NS, 'war-blast-fire', [[0, '#fffbe6', 1], [0.25, '#ffd45c', 0.95], [0.55, '#ff7b1c', 0.85], [0.8, '#b8320f', 0.55], [1, '#5a1a08', 0]]));
        defs.appendChild(this._radialGrad(NS, 'war-blast-smoke', [[0, '#3a332c', 0.85], [0.55, '#5b5248', 0.55], [1, '#6b6156', 0]]));
      }
      const R = strike.radius || bombR;
      // a deterministic little scatter per blast, so a stick never looks stamped
      let h = 0;
      for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
      const rnd = () => { h = (h * 1103515245 + 12345) | 0; return ((h >>> 8) & 0xffff) / 0xffff; };
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'war-explosion');
      g.setAttribute('transform', `translate(${strike.pos[0]},${strike.pos[1]})`);
      const mkc = (cls, fill) => { const c = document.createElementNS(NS, 'circle'); c.setAttribute('class', cls); if (fill) c.setAttribute('fill', fill); c.setAttribute('r', '0.01'); g.appendChild(c); return c; };
      const smoke = [];
      for (let i = 0; i < 5; i++) smoke.push({ n: mkc('war-blast-smoke', 'url(#war-blast-smoke)'), a: rnd() * Math.PI * 2, d: 0.15 + rnd() * 0.35, s: 0.75 + rnd() * 0.5, lag: rnd() * 400 });
      const glow = mkc('war-blast-glow', 'url(#war-blast-glow)');
      const fire = [];
      for (let i = 0; i < 3; i++) fire.push({ n: mkc('war-blast-fire', 'url(#war-blast-fire)'), a: rnd() * Math.PI * 2, d: 0.12 + rnd() * 0.18, s: 0.7 + rnd() * 0.45 });
      const ring = mkc('war-blast-ring');
      const sparks = document.createElementNS(NS, 'path');
      sparks.setAttribute('class', 'war-blast-sparks');
      g.appendChild(sparks);
      const sparkDirs = [];
      for (let i = 0; i < 9; i++) sparkDirs.push({ a: (i / 9) * Math.PI * 2 + rnd() * 0.5, v: 0.8 + rnd() * 0.7 });
      const flash = mkc('war-blast-flash');
      (this._fx || map.warLayer).appendChild(g);
      const entry = { node: g, glow, fire, smoke, ring, sparks, sparkDirs, flash, t0, life: EXPLOSION_LIFE_MS, R, wind: [0.55, -0.85] };
      this._explosionAnim[sid] = entry;
      this._updateExplosion(entry, age);
    }
  },
  // Age-driven pose for one blast — at creation and then every rAF frame.
  _updateExplosion(e, age) {
    const R = e.R;
    const c01 = (v) => Math.max(0, Math.min(1, v));
    const easeOut = (k) => 1 - Math.pow(1 - c01(k), 3);
    const set = (n, r, op, cx, cy) => {
      n.setAttribute('r', Math.max(0.01, r).toFixed(1));
      n.style.opacity = c01(op).toFixed(3);
      if (cx !== undefined) { n.setAttribute('cx', cx.toFixed(1)); n.setAttribute('cy', cy.toFixed(1)); }
    };
    if (age < 0) { e.node.style.opacity = '0'; return; } // a stick bomb still falling
    e.node.style.opacity = '1';
    // flash + glow
    set(e.flash, R * 0.4 * easeOut(age / 60), 1 - age / 140);
    set(e.glow, R * (0.6 + 1.1 * easeOut(age / 350)), age < 180 ? 1 : 1 - (age - 180) / 520);
    // ground shock ring: fast, thin, gone in under half a second
    const rk = c01(age / 450);
    set(e.ring, R * (0.3 + 1.5 * easeOut(rk)), (1 - rk) * 0.85);
    e.ring.setAttribute('stroke-width', (R * 0.07 * (1 - rk) + 0.6).toFixed(2));
    // fireball: swell, churn, shrink into the smoke
    const fk = c01(age / 1300);
    for (const f of e.fire) {
      const grow = easeOut(age / 280), shrink = 1 - 0.75 * c01((age - 350) / 950);
      const drift = R * f.d * (0.4 + 0.6 * fk);
      set(f.n, R * 0.62 * f.s * grow * shrink, 1 - Math.pow(fk, 1.6), Math.cos(f.a + fk * 0.8) * drift, Math.sin(f.a + fk * 0.8) * drift);
    }
    // sparks: burning debris flung outward
    const sk = c01(age / 700);
    if (sk < 1) {
      let d = '';
      for (const sp of e.sparkDirs) {
        const r1 = R * (0.25 + 1.1 * sp.v * easeOut(sk)), r0 = r1 - R * 0.22 * (1 - sk);
        d += `M${(Math.cos(sp.a) * r0).toFixed(1)} ${(Math.sin(sp.a) * r0).toFixed(1)} L${(Math.cos(sp.a) * r1).toFixed(1)} ${(Math.sin(sp.a) * r1).toFixed(1)} `;
      }
      e.sparks.setAttribute('d', d);
      e.sparks.style.opacity = (1 - sk).toFixed(3);
    } else if (e.sparks.getAttribute('d')) e.sparks.setAttribute('d', '');
    // smoke: billows up from the fireball and drifts downwind, lingering
    for (const sm of e.smoke) {
      const a = age - 250 - sm.lag;
      if (a <= 0) { set(sm.n, 0.01, 0); continue; }
      const k = c01(a / (e.life - 250 - sm.lag));
      const rr = R * (0.3 + 0.75 * sm.s * easeOut(k * 1.6));
      const op = (a < 500 ? a / 500 : 1) * (1 - Math.pow(k, 1.4)) * 0.8;
      const dx = Math.cos(sm.a) * R * sm.d + e.wind[0] * R * 0.9 * k, dy = Math.sin(sm.a) * R * sm.d + e.wind[1] * R * 0.9 * k;
      set(sm.n, rr, op, dx, dy);
    }
  },

  /* ═══════════ WAR MAP CONTROLS ═══════════
     Three small floating surfaces, present only while W.layer === 'war':
       · the toolbar (bottom) — one contextual hint line + the commands this
         operator actually holds;
       · the situation HUD (top-left) — what is happening, at a glance;
       · the unit card (top-right) — the selected / inspected unit or group.
     Each is rebuilt on the 1s UI timer ONLY when its content signature
     changes (rebuilding every second used to swallow taps mid-press). */
  _uiTimer() {
    if (this._toolbarTimer) return;
    this._toolbarTimer = setInterval(() => {
      if (W.layer === 'war' && this.active() && document.getElementById('map-wrap')) { this.renderToolbar(); this.renderUnitCard(); this.renderHud(); if (this.renderAirDock) this.renderAirDock(); }
      else { this._removeToolbar(); this._removeUnitCard(); this._removeHud(); if (this._removeAirDock) this._removeAirDock(); }
    }, 1000);
  },
  renderToolbar() {
    const wrap = document.getElementById('map-wrap');
    const war = this.activeAuth();
    if (!wrap || !war) { this._removeToolbar(); return; }
    this._uiTimer();
    const key = this.docKeyOf(war);
    const live = this.commandable(war);
    const side = this.commandableSide(war);
    const protest = war.kind === 'protest';
    const ca = this.access(war);
    // the air wing (war-air.js): squadrons ready across the sides you fly
    const predWar = (window.WarEngine && this.predictedDoc(war)) || war;
    const airSides = this.airSidesFor ? this.airSidesFor(predWar) : [];
    const airReady = airSides.reduce((n, sd) => n + this.airCounts(predWar, sd).ready, 0);
    const airAloft = airSides.reduce((n, sd) => n + this.airCounts(predWar, sd).aloft, 0);
    const plan = this._airPlan;
    const other = this.authDocs().find(d => d !== war && d.active);
    const p = war.protest || {};
    const sig = [key, live, side, this._sel.size, this._spawnArmed, this._tapOrders, airSides.join(), airReady, airAloft, !!W.warAirDock,
      plan && plan.sqId + plan.kind + !!plan.target, this._tool, protest ? this._armyDeployed(war) : 0, !!other, isGM() && this._gmSide, p.protestorsViolent, p.captureMode, p.govViolent, JSON.stringify(ca)].join('|');
    const old = document.getElementById('war-toolbar');
    if (old && old.isConnected && this._toolbarSig === sig) return;
    this._toolbarSig = sig;
    if (old) old.remove();

    const n = this._sel.size;
    const hint = this._tool === 'ruler' ? '📏 Ruler — drag on the map to measure a distance and the time to cover it. A click clears it; Esc puts the ruler away.'
      : this._tool === 'range' ? '◎ Range — drag out a circle to see what lies within reach. A click clears it; Esc puts the compass away.'
      : !live ? 'This conflict has concluded — the field can be reviewed but no longer commanded.'
      : plan ? `✈ ${plan.kind === 'patrol' ? 'Patrol' : 'Strike'} — move over the map to see reach and time over the target, then click to send. Esc cancels.`
        : this._spawnArmed ? '➕ Reinforcements armed — click where they should appear. Esc cancels.'
          : !side ? this.authorityText(war) + ' Click a unit for details.'
            : protest && !n ? (side === 'att'
              ? (this._tapOrders ? 'Tap your crowds' : 'Click your crowds (Shift adds)') + ' and march them to factories and offices — workplaces next to a crowd walk out at turn end.'
              : (this._tapOrders ? 'Tap police detachments' : 'Click police detachments (Shift adds)') + ' to move them. They only fight once the crowds riot or force is authorized.')
            : n ? `${n} ${protest ? (side === 'att' ? 'crowd' : 'detachment') : 'unit'}${n === 1 ? '' : 's'} selected — ` + (this._tapOrders
              ? 'tap ground to move · tap an enemy to attack · right-drag draws a route'
              : 'right-click to move · right-click an enemy to attack · right-drag draws a route · Ctrl-drag a line')
              : (this._tapOrders ? 'Tap your units to select them, or Select all.' : 'Click your units to select (Shift adds) · Shift-drag to box-select · or Select all.');
    const bar = el('div#war-toolbar.war-toolbar');
    bar.appendChild(el('div.war-toolbar-hint', hint));
    const row = el('div.war-toolbar-row');
    if (other) {
      row.appendChild(el('div.seg',
        el('button', { class: key === 'war' ? 'active' : '', onclick: () => { this._activeKey = 'war'; this._sel.clear(); this.refreshLayer(true); } }, '⚔ War'),
        el('button', { class: key === 'protest' ? 'active' : '', onclick: () => { this._activeKey = 'protest'; this._sel.clear(); this.refreshLayer(true); } }, '⚒ Protest')));
    }
    if (live && side) {
      row.appendChild(el('button.dash-btn.btn-xs', { onclick: () => this._selectAll() }, 'Select all'));
      if (n) row.appendChild(el('button.dash-btn.btn-xs', { onclick: () => { this._sel.clear(); this._inspect = null; this.refreshLayer(true); } }, `Clear (${n})`));
      row.appendChild(el('button.dash-btn.btn-xs', {
        class: this._tapOrders ? 'active' : '', title: 'Left-click / tap gives orders: ground = move, enemy = attack',
        onclick: () => { this._tapOrders = !this._tapOrders; this.renderToolbar(); }
      }, (this._tapOrders ? '✓ ' : '') + 'Tap orders'));
    }
    if (plan) {
      if (plan.target) row.appendChild(el('button.solid-btn.btn-xs', { onclick: () => this._airPlanSend() }, '✓ Send'));
      row.appendChild(el('button.dash-btn.btn-xs', { onclick: () => { this._airPlan = null; this._airPlanClear(); this.renderAirDock(true); this.renderToolbar(); } }, '✕ Cancel mission'));
    }
    if (airSides.length && live) {
      row.appendChild(el('button.btn-xs', {
        class: (W.warAirDock ? 'solid-btn active' : 'dash-btn') + ' war-air-btn', title: 'Your air wing: squadrons, fuel, patrols and strikes',
        onclick: () => { W.warAirDock = !W.warAirDock; if (!W.warAirDock) { this._airPlan = null; this._airPlanClear(); } this.renderAirDock(true); this.renderToolbar(); }
      }, `✈ Air wing · ${airReady} ready` + (airAloft ? ` · ${airAloft} aloft` : '')));
    }
    if (protest && live) {
      // levers are named for what a click DOES; the solid style marks the
      // escalation in force, and the tooltip says what it costs
      for (const lv of this._protestLevers(war, key, ca)) {
        row.appendChild(el('button.btn-xs', { class: lv.on ? 'solid-btn active' : (lv.danger ? 'danger-btn' : 'dash-btn'), title: lv.title,
          onclick: async () => { await lv.run(); this.renderToolbar(); } }, lv.label));
      }
      if (ca.force) {
        const n = this._armyDeployed(war);
        row.appendChild(el('button.btn-xs.dash-btn', { title: 'Call out the army: battalions join the security forces', onclick: () => this._armyModal(war) }, '🪖 Army' + (n ? ` · ${n}` : '')));
      }
    }
    if (isGM() && this._spawnArmed) row.appendChild(el('button.dash-btn.btn-xs.active', { onclick: () => { this._spawnArmed = false; this.renderToolbar(); } }, '➕ Placing — cancel'));
    if (isGM()) {
      row.appendChild(el('div.seg', { title: 'Which side your orders command' },
        el('button', { class: this._gmSide === 'def' ? 'active' : '', onclick: () => { this._gmSide = 'def'; this._sel.clear(); this.refreshLayer(true); } }, protest ? 'Police' : 'Defence'),
        el('button', { class: this._gmSide === 'att' ? 'active' : '', onclick: () => { this._gmSide = 'att'; this._sel.clear(); this.refreshLayer(true); } }, protest ? 'Crowds' : 'Invader')));
    }
    row.appendChild(el('div.seg', { title: 'Measuring tools' },
      el('button', { class: this._tool === 'ruler' ? 'active' : '', title: 'Ruler: distance, bearing and travel times', onclick: () => this.setTool('ruler') }, '📏 Ruler'),
      el('button', { class: this._tool === 'range' ? 'active' : '', title: 'Range compass: a circle and what lies inside it', onclick: () => this.setTool('range') }, '◎ Range')));
    row.appendChild(el('button.dash-btn.btn-xs', { title: 'How to command', onclick: () => this._helpModal() }, '?'));
    bar.appendChild(row);
    wrap.appendChild(bar);
  },
  _removeToolbar() {
    const bar = document.getElementById('war-toolbar');
    if (bar) bar.remove();
    this._toolbarSig = null;
    if (this._toolbarTimer && !(W.layer === 'war' && this.active())) { clearInterval(this._toolbarTimer); this._toolbarTimer = null; }
  },
  // The government calls out the army (POST /api/protest/army): pick a city
  // and how many battalions; the troops join the security side and follow
  // the same rules as the police (no firing on a peaceful crowd until force
  // is authorized).
  _armyDeployed(war) { return (war.units || []).filter(u => u.side === 'def' && u.army && !u.dead && u.strength > 0).length; },
  _armyModal(war) {
    const p = war.protest || {};
    const cfgMax = Number((((S().settings || {}).war || {}).protest || {}).armyMax) || 8;
    const have = this._armyDeployed(war);
    const d = { cityId: (p.baseCities || [])[0] || ((S().cities || [])[0] || {}).id, count: Math.min(2, Math.max(1, cfgMax - have)) };
    const chips = this._cityChips(S().cities || [], (cid) => cid === d.cityId ? 'police' : '', (cid) => { d.cityId = cid; });
    openModal('CALL OUT THE ARMY', el('div',
      el('div.protest-note', `Army battalions join the security forces in the chosen city. They draw rifles from the government's stockpiles, and fight under the same rules as the police — they won't fire on a peaceful crowd until force is authorized. ${have}/${cfgMax} battalions on the streets now.`),
      Forms.field('Deploy to', chips),
      Forms.field('Battalions', Forms.sliderNum(d, 'count', 1, 4, { step: 1 })),
      p.govViolent ? null : el('div.protest-note', 'Force is not authorized yet: the troops will hold the streets but not attack.')),
      [{ label: '🪖 Deploy', cls: 'danger-btn', onClick: async () => {
        await POST('/api/protest/army', { cityId: d.cityId, count: d.count });
        toast(`The army deploys to ${(cityById(d.cityId) || {}).name || 'the city'}.`);
      } }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }]);
  },
  async _armyWithdraw() {
    try { const r = await POST('/api/protest/army', { withdraw: true }); toast(`${r.withdrawn} battalion${r.withdrawn === 1 ? '' : 's'} return to barracks.`); }
    catch (e) { toast(e.message, true); }
  },
  // The protest's escalation levers this viewer holds (cmdAccess), each a
  // toggle POSTed with an optimistic flip so the button answers at once.
  _protestLevers(war, key, ca) {
    const p = war.protest || {};
    const flip = (prop) => (s) => { const d = s && s[key]; if (d && d.protest) d.protest[prop] = !d.protest[prop]; };
    const lever = (prop, on, off, title, danger) => ({
      prop, on: !!p[prop], label: p[prop] ? on : off, title, danger,
      run: async () => {
        try { await POST('/api/protest/control', { [prop]: !p[prop], conflict: key }, { optimistic: flip(prop) }); }
        catch (e) { toast(e.message, true); }
      }
    });
    const out = [];
    if (ca.attLead) {
      out.push(lever('protestorsViolent', '☮ Call for calm', '⚒ Turn violent', p.protestorsViolent
        ? 'The crowds are rioting. Calling for calm stops their attacks — the police then stand down unless force is authorized.'
        : 'Let the crowds fight. The police fight back, bystanders get hurt, and the public turns against the movement.'));
      out.push(lever('captureMode', '⚑ Give up ground', '⚑ Seize districts', p.captureMode
        ? 'The crowds are seizing the districts they stand in. Click to stop claiming ground.'
        : 'Let the crowds occupy the districts they stand in, behind barricades.'));
    }
    if (ca.force) {
      out.push(lever('govViolent', '⛨ Stand police down', '⛨ Use force', p.govViolent
        ? 'Force is authorized. Standing the police down stops them attacking (they still defend themselves against a riot).'
        : (p.protestorsViolent ? 'Authorize the police to attack and clear the air wing.' : 'Force against a PEACEFUL crowd is a crackdown: sympathy for the movement doubles and approval falls fast.'), true));
    }
    return out;
  },
  _selectAll() {
    const war = (window.WarEngine && this.activePred()) || this.activeAuth();
    const side = this.commandableSide(war);
    this._sel.clear();
    for (const u of (war ? war.units : [])) if (u.side === side && !u.dead && u.state !== 'dead' && u.strength > 0) this._sel.add(u.id);
    this._inspect = null; this._inspectRef = null;
    this.refreshLayer(true);
  },
  _helpModal() {
    const war = this.activeAuth();
    if (war && war.kind === 'protest') {
      const rows = [
        ['Select', 'Click a crowd or police detachment (Shift adds) · Shift-drag a box · Select all'],
        ['March', 'Right-click the ground — or with Tap orders on, just click / tap it. Right-drag draws a route.'],
        ['Strike', 'Park a crowd next to factories, offices and shops: within reach, the workforce walks out at the end of each turn (output drops, the owner loses money).'],
        ['Unrest', 'Every city with a crowd in its streets is in unrest. Peaceful crowds win the movement sympathy and cost the government approval.'],
        ['Escalate', 'Turn violent (organizers) or Use force (security) — see the War Room for what each combination does.'],
        ['Air wing', 'Grounded until force is authorized; then ✈ Air wing sends squadrons on patrols or strikes.'],
        ['Cancel', 'Esc, or click open ground']
      ];
      openModal('LEADING A PROTEST', el('div',
        el('table.data', el('tbody', rows.map(r => el('tr', el('td', el('b', r[0])), el('td', r[1])))))),
        [{ label: 'Close', cls: 'dash-btn', onClick: () => { } }]);
      return;
    }
    const rows = [
      ['Select', 'Click a unit (Shift adds) · Shift-drag a box · Select all'],
      ['Move', 'Right-click the ground — or with Tap orders on, just click / tap it'],
      ['Attack', 'Right-click (or tap) an enemy unit — your selection chases it'],
      ['Route', 'Right-drag to draw the exact road your units should take'],
      ['Line up', 'Ctrl-drag a line — the selection spreads out along it'],
      ['Hold', 'Hold position on the unit card stops a unit where it stands'],
      ['Air wing', '✈ Air wing opens your squadrons: Patrol defends an area against enemy aircraft, Strike bombs a target. The planner shows reach and time over the target before you click.'],
      ['Fuel', 'Each sortie burns refined fuel; tanks last ~30s at 1× and the farther the target the less time over it. Landed squadrons need 2 min to refuel and rearm.'],
      ['Measure', '📏 Ruler: drag for distance, bearing and travel times · ◎ Range: drag a circle to see what lies inside'],
      ['Cancel', 'Esc, or click open ground']
    ];
    openModal('COMMANDING YOUR FORCES', el('div',
      el('table.data', el('tbody', rows.map(r => el('tr', el('td', el('b', r[0])), el('td', r[1]))))),
      el('div', { style: 'font-size:12px; color:var(--ink-faint); margin-top:10px;' }, 'Fights happen on contact: units that touch an enemy stop and fight until one side breaks. Units outside their supply corridor (⚠) slowly lose strength and morale.')),
      [{ label: 'Close', cls: 'dash-btn', onClick: () => { } }]);
  },

  // ---- the situation HUD ----
  _legendRows(protest) {
    const sw = (inner) => el('span.war-legend-sw', { html: `<svg viewBox="-20 -14 40 28" width="30" height="21">${inner}</svg>` });
    if (protest) {
      const crowd = (fill, ink, stroke) => `<g transform="scale(.62) translate(0,2)"><path d="${WAR_CROWD_FRAME}" fill="${fill}" stroke="${stroke}" stroke-width="2"/><path d="${WAR_CROWD_FIGS}" fill="${ink}" stroke="${fill}"/></g>`;
      return [
        [sw(crowd('#f0d8a6', '#5a3a10', '#7a5418')), 'Peaceful crowd'],
        [sw(crowd('#eaa27a', '#4a1a0c', '#9b2c22') + '<path d="M9,-3 C5,-5 6,-10 8,-13 C9,-10 10,-10 11,-11 C13,-8 12,-5 9,-3 Z" fill="#e8742a" stroke="#9b2c22" stroke-width=".8"/>'), 'Rioting crowd'],
        [sw(`<g transform="scale(.7) translate(0,1)"><path d="${WAR_POLICE_FRAME}" fill="#c6d6ea" stroke="#1f3a5c" stroke-width="2"/><path d="${WAR_POLICE_BADGE}" fill="#1f3a5c"/></g>`), 'Police'],
        [sw('<rect x="-15" y="-9" width="30" height="18" rx="9" fill="#f4ecdc" stroke="#6b6250"/><path d="M-10,-5 L-3,0 L-10,5" fill="none" stroke="#9a5a12" stroke-width="2.4"/><path d="M10,-5 L3,0 L10,5" fill="none" stroke="#24466e" stroke-width="2.4"/>'), 'Standoff'],
        [sw('<path d="M14,0 L7,3 L10,10 L3,6 L0,14 L-3,6 L-10,10 L-7,3 L-14,0 L-7,-3 L-10,-10 L-3,-6 L0,-14 L3,-6 L10,-10 L7,-3 Z" fill="#f6d27a" stroke="#8c1f15" stroke-width="1.2"/>'), 'Clashes'],
        [sw('<path d="M0,12 V2" stroke="#3b2a20" stroke-width="2"/><rect x="-15" y="-9" width="30" height="11" fill="#f6efe0" stroke="#9b2c22" stroke-width="1.4"/><text y="-1" text-anchor="middle" font-size="7" font-weight="700" fill="#9b2c22">STRIKE</text>'), 'Workplace on strike'],
        [sw('<circle r="12" fill="#e3a03c" fill-opacity=".35" stroke="#9a5a12" stroke-dasharray="4 3"/>'), 'City in unrest'],
        [sw('<rect x="-18" y="-11" width="36" height="22" fill="#b0701c" fill-opacity=".25"/><path d="M-18,6 Q-4,-12 18,-4" fill="none" stroke="#8a4e10" stroke-width="2.4" stroke-dasharray="7 3"/>'), 'Seized ground']
      ];
    }
    return [
      [sw('<path d="M-18,4 Q-6,-8 4,0 T18,-4" fill="none" stroke="#8c1f15" stroke-width="3"/><path d="M-18,4 Q-6,-8 4,0 T18,-4" fill="none" stroke="#8c1f15" stroke-width="8" stroke-dasharray="1.5 6"/>'), 'Front line'],
      [sw('<rect x="-18" y="-11" width="36" height="22" fill="#9b2c22" fill-opacity=".3"/><path d="M-18,6 L-6,-11 M-10,11 L6,-11 M-2,11 L14,-11 M6,11 L18,-6" stroke="#9b2c22" stroke-opacity=".6" stroke-width="2.5"/>'), 'Occupied ground'],
      [sw('<rect x="-15" y="-9" width="30" height="18" fill="#b8cee4" stroke="#1f3a5c" stroke-width="1.5"/><path d="M-15,-9 L15,9 M15,-9 L-15,9" stroke="#173050" stroke-width="1.3"/>'), 'Defence unit'],
      [sw('<rect x="-15" y="-9" width="30" height="18" fill="#ebb5ac" stroke="#7a2418" stroke-width="1.5"/><path d="M-15,-9 L15,9 M15,-9 L-15,9" stroke="#5a1a10" stroke-width="1.3"/>'), 'Invading unit'],
      [sw('<path d="M14,0 L7,3 L10,10 L3,6 L0,14 L-3,6 L-10,10 L-7,3 L-14,0 L-7,-3 L-10,-10 L-3,-6 L0,-14 L3,-6 L10,-10 L7,-3 Z" fill="#f6d27a" stroke="#8c1f15" stroke-width="1.2"/>'), 'Fighting'],
      [sw('<circle r="9" fill="#f4ecdc" stroke="#8c1f15" stroke-width="2"/><text y="4" text-anchor="middle" font-size="11" font-weight="700" fill="#8c1f15">1</text>'), 'Objective'],
      [sw('<path d="M-2,10 V-12" stroke="#3b2a20" stroke-width="2"/><path d="M-2,-12 h13 l-3,4.5 l3,4.5 h-13 z" fill="#9b2c22"/>'), 'Fallen city'],
      [sw('<path d="M-3,-10 l9,16 h-18 z" fill="#e0a458" stroke="#7a5418"/>'), 'Cut off from supply'],
      [sw('<g transform="rotate(-20) scale(.55)"><path d="M-11,0 H-40" stroke="#c9c2b0" stroke-width="3"/><path d="M11.5,0 L5,-1.7 L1.2,-1.9 L-2,-9 L-4.8,-9 L-3.6,-1.9 L-8.2,-1.5 L-10.6,-4.4 L-12.2,-4.4 L-11,0 L-12.2,4.4 L-10.6,4.4 L-8.2,1.5 L-3.6,1.9 L-4.8,9 L-2,9 L1.2,1.9 L5,1.7 Z" fill="#24466e"/></g>'), 'Squadron in flight'],
      [sw('<path d="M-15,4 L11,-11 L15,-4 L-11,11 Z" fill="#6b6250"/><path d="M-9,4.5 L-3,1 M1,-1.4 L7,-4.9" stroke="#f4ecdc" stroke-width="1.4"/>'), 'Airfield'],
      [sw('<circle r="11" fill="#24466e" fill-opacity=".08" stroke="#24466e" stroke-dasharray="4 3"/>'), 'Patrol area'],
      [sw('<path d="M-16,8 L10,-6" stroke="#b0251a" stroke-dasharray="4 3" stroke-width="1.6"/><circle cx="10" cy="-6" r="5" fill="none" stroke="#b0251a" stroke-width="1.6"/>'), 'Strike run & target']
    ];
  },
  renderHud() {
    const wrap = document.getElementById('map-wrap');
    const auth = this.activeAuth() || this.authDocs()[0];
    if (!wrap || !auth) { this._removeHud(); return; }
    const war = (window.WarEngine && this.predictedDoc(auth)) || auth;
    const protest = war.kind === 'protest';
    const open = W.warHudOpen !== undefined ? W.warHudOpen : window.innerWidth > 640;
    if (protest) { this._renderProtestHud(wrap, war, open); return; }
    const st = war.stats || {};
    const live = (u) => !u.dead && u.state !== 'dead' && u.strength > 0;
    let attStr = 0, defStr = 0, attN = 0, defN = 0;
    for (const u of war.units || []) if (live(u)) { if (u.side === 'att') { attStr += u.strength; attN++; } else { defStr += u.strength; defN++; } }
    const control = Object.entries(st.provinceControl || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const next = [...(war.objectives || [])].filter(o => o.status !== 'done').sort((a, b) => a.priority - b.priority)[0];
    const evs = war.events || [];
    const lastEv = [...evs].reverse().find(e => e.kind !== 'battle') || evs[evs.length - 1];
    const sig = [war.startedAt, war.speed, war.paused, war.active, open, W.warLegend, fmtCompact(attStr), fmtCompact(defStr), attN, defN, control.join(), next && next.id, lastEv && lastEv.t,
      fmtCompact(st.attLosses || 0), fmtCompact(st.defLosses || 0), fmtCompact(st.civilianDeaths || 0), (war.result || {}).winner, war.totalWar,
      this.airHudText ? this.airHudText(war) : '', this.peaceSig ? this.peaceSig(war) : ''].join('|');
    const old = document.getElementById('war-hud');
    const statusText = () => (war.result ? 'ENDED' : war.paused ? 'PAUSED' : protest ? ((war.protest || {}).protestorsViolent ? 'VIOLENT' : 'PEACEFUL') : war.totalWar ? 'TOTAL WAR' : 'LIVE') + ' · T' + war.tick + (war.speed !== 1 ? ' · ' + warSpeedLabel(war.speed) : '');
    if (old && old.isConnected && this._hudSig === sig) {
      const stEl = old.querySelector('.war-hud-status');
      if (stEl && stEl.textContent !== statusText()) stEl.textContent = statusText();
      return;
    }
    this._hudSig = sig;
    if (old) old.remove();
    const names = protest ? ['Crowds', 'Police'] : [entName(war.attackerId) || 'Invader', entName(war.defenderId) || 'Defence'];
    const hud = el('div#war-hud.war-hud', { class: open ? '' : 'collapsed' });
    hud.appendChild(el('div.war-hud-head', { onclick: () => { W.warHudOpen = !open; this.renderHud(); } },
      el('span.war-hud-title', (protest ? '⚒ ' : '⚔ ') + war.name),
      el('span.war-hud-status', { class: war.result ? 'ended' : war.paused ? 'paused' : 'live' }, statusText()),
      el('span.war-hud-caret', open ? '▾' : '▸')));
    if (!open) { wrap.appendChild(hud); return; }
    const row = (label, ...v) => el('div.war-hud-row', el('span.war-hud-k', label), el('span.war-hud-v', ...v));
    // balance of forces: one bar, the two sides' live strength
    const tot = attStr + defStr || 1;
    hud.appendChild(row('Forces', el('div.war-balance',
      el('div.war-balance-att', { style: `width:${(attStr / tot * 100).toFixed(1)}%` }),
      el('div.war-balance-def', { style: `width:${(defStr / tot * 100).toFixed(1)}%` }))));
    hud.appendChild(el('div.war-hud-sub', `${names[0]} ${fmtCompact(attStr)} (${attN}) · ${names[1]} ${fmtCompact(defStr)} (${defN})`));
    hud.appendChild(row(protest ? 'Seized' : 'Occupied', control.length
      ? control.slice(0, 3).map(([pid, v]) => `${(provById(pid) || {}).name || pid} ${v}%`).join(' · ')
      : el('span', { style: 'color:var(--ink-faint)' }, protest ? 'no district seized' : 'no ground lost yet')));
    hud.appendChild(row('Losses', `${names[0]} ${fmtCompact(st.attLosses || 0)} · ${names[1]} ${fmtCompact(st.defLosses || 0)}` + (st.civilianDeaths ? ` · civilians ${fmtCompact(st.civilianDeaths)}` : '')));
    if (!protest) hud.appendChild(row('Next', next ? `${next.priority}. ${this.objLabel(next)} — ${this.objTarget(next)}` : (war.result ? '—' : 'all objectives achieved')));
    const airText = this.airHudText && this.airHudText(war);
    if (airText) hud.appendChild(row('Air', airText));
    if (this._peaceHudRow) this._peaceHudRow(hud, war, row);
    if (war.result) hud.appendChild(row('Result', (war.result.reason || 'ended')));
    if (lastEv) {
      const ago = Math.max(0, Math.round((Date.now() - lastEv.t) / 1000));
      hud.appendChild(row('Latest', el('span', lastEv.text, el('span.war-hud-ago', ago < 90 ? ` ${ago}s ago` : ` ${Math.round(ago / 60)}m ago`))));
    }
    hud.appendChild(el('div.war-hud-foot',
      el('button.dash-btn.btn-xs', { onclick: () => { W.warLegend = !W.warLegend; this.renderHud(); } }, W.warLegend ? 'Hide legend' : 'Legend'),
      el('button.dash-btn.btn-xs', { onclick: () => App.go('war') }, 'War Room →')));
    if (W.warLegend) hud.appendChild(el('div.war-legend', this._legendRows().map(([sw, label]) => el('div.war-legend-row', sw, el('span', label)))));
    wrap.appendChild(hud);
  },
  // What a protest amounts to right now — shared by the HUD and the War Room.
  _protestSummary(war) {
    const live = (u) => !u.dead && u.state !== 'dead' && u.strength > 0;
    let crowd = 0, crowdN = 0, police = 0, policeN = 0;
    for (const u of war.units || []) if (live(u)) { if (u.side === 'att') { crowd += u.strength; crowdN++; } else { police += u.strength; policeN++; } }
    const st = war.stats || {};
    const pol = st.politics || null;
    const sum = (o) => Object.values(o || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    const strikes = war.active ? (S().properties || []).filter(pr => pr.vars && pr.vars.strike) : [];
    // the party the movement builds: the organizer itself, or the party it leads
    const orgId = (war.protest || {}).organizerId || war.attackerId;
    const org = entById(orgId);
    const party = (pol && pol.partyId && entById(pol.partyId)) ||
      (org && org.type === 'party' ? org : (S().entities || []).find(e => e.type === 'party' && e.leaderId === orgId)) || null;
    return {
      crowd, crowdN, police, policeN, pol, party, org,
      support: pol ? sum(pol.support) : 0, approval: pol ? sum(pol.approval) : 0,
      strikes, maxCut: strikes.reduce((m, pr) => Math.max(m, pr.vars.strike.degree || 0), 0),
      unrest: war.active ? (st.unrestCities || []) : [],
      control: Object.entries(st.provinceControl || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    };
  },
  _signed(v) { const r = Math.round(v * 100) / 100; return (r > 0 ? '+' : r < 0 ? '−' : '±') + Math.abs(r); },
  _renderProtestHud(wrap, war, open) {
    const p = war.protest || {};
    const st = war.stats || {};
    const sm = this._protestSummary(war);
    const posture = protestPosture(p);
    const P = PROTEST_POSTURE[posture];
    const evs = war.events || [];
    const lastEv = [...evs].reverse().find(e => e.kind !== 'battle') || evs[evs.length - 1];
    const sig = ['protest', war.startedAt, war.speed, war.paused, war.active, open, W.warLegend, posture, p.captureMode,
      warHeads(sm.crowd), warHeads(sm.police), sm.crowdN, sm.policeN, sm.control.join(), lastEv && lastEv.t,
      Math.round(sm.support * 10), Math.round(sm.approval * 10), sm.strikes.length, Math.round(sm.maxCut * 100), sm.unrest.join(),
      fmtCompact(st.civilianDeaths || 0), fmtCompact(st.refugees || 0), fmtCompact(st.attLosses || 0), fmtCompact(st.defLosses || 0), (war.result || {}).winner,
      this.peaceSig ? this.peaceSig(war) : ''].join('|');
    const old = document.getElementById('war-hud');
    const statusText = () => (war.result ? 'ENDED' : war.paused ? 'PAUSED' : P.status) + ' · T' + war.tick + (war.speed !== 1 ? ' · ' + warSpeedLabel(war.speed) : '');
    if (old && old.isConnected && this._hudSig === sig) {
      const stEl = old.querySelector('.war-hud-status');
      if (stEl && stEl.textContent !== statusText()) stEl.textContent = statusText();
      return;
    }
    this._hudSig = sig;
    if (old) old.remove();
    const hud = el('div#war-hud.war-hud.war-hud-protest', { class: open ? '' : 'collapsed' });
    hud.appendChild(el('div.war-hud-head', { onclick: () => { W.warHudOpen = !open; this.renderHud(); } },
      el('span.war-hud-title', '⚒ ' + war.name),
      el('span.war-hud-status', { class: war.result ? 'ended' : war.paused ? 'paused' : 'live posture-' + posture }, statusText()),
      el('span.war-hud-caret', open ? '▾' : '▸')));
    if (!open) { wrap.appendChild(hud); return; }
    const faint = (t) => el('span', { style: 'color:var(--ink-faint)' }, t);
    const row = (label, ...v) => el('div.war-hud-row', el('span.war-hud-k', label), el('span.war-hud-v', ...v));
    if (!war.result) hud.appendChild(el('div.war-hud-posture', { class: 'posture-' + posture }, el('b', P.label + ' — '), P.short));
    const tot = sm.crowd + sm.police || 1;
    hud.appendChild(row('Streets', el('div.war-balance',
      el('div.war-balance-crowd', { style: `width:${(sm.crowd / tot * 100).toFixed(1)}%` }),
      el('div.war-balance-police', { style: `width:${(sm.police / tot * 100).toFixed(1)}%` }))));
    hud.appendChild(el('div.war-hud-sub', `≈${warHeads(sm.crowd)} marching (${sm.crowdN}) · ${fmtNum(Math.round(sm.police))} ${this._armyDeployed(war) ? 'police & troops' : 'police'} (${sm.policeN})`));
    const tone = (v, goodWhenUp) => el('span', { style: 'color:' + ((goodWhenUp ? v >= 0 : v < 0) ? 'var(--good)' : 'var(--accent)') }, this._signed(v));
    hud.appendChild(row('Opinion', sm.pol
      ? el('span', sm.party ? el('span', (sm.party.abbrev || sm.party.name) + ' support ', tone(sm.support, true), ' · ') : null, 'gov. approval ', tone(sm.approval, true))
      : faint(war.active ? 'first reading within the minute' : 'no measurable shift')));
    hud.appendChild(row('Strikes', sm.strikes.length
      ? `${sm.strikes.length} workplace${sm.strikes.length === 1 ? '' : 's'} out · up to −${Math.round(sm.maxCut * 100)}% output`
      : faint(war.active ? 'none yet — sites near a crowd walk out at turn end' : '—')));
    hud.appendChild(row('Unrest', sm.unrest.length ? sm.unrest.map(id => (cityById(id) || {}).name || id).join(', ') : faint('the streets are quiet')));
    if (p.captureMode || sm.control.length) {
      hud.appendChild(row('Seized', sm.control.length
        ? sm.control.slice(0, 3).map(([pid, v]) => `${(provById(pid) || {}).name || pid} ${v}%`).join(' · ')
        : faint('crowds are moving to seize ground')));
    }
    const hurt = (st.attLosses || 0) + (st.defLosses || 0);
    if (hurt > 0 || st.civilianDeaths || st.refugees) {
      hud.appendChild(row('Toll', [st.civilianDeaths ? `${fmtCompact(st.civilianDeaths)} civilians dead` : null,
        st.refugees ? `${fmtCompact(st.refugees)} fled` : null,
        hurt > 0 ? `crowds −${fmtCompact(st.attLosses || 0)} · police −${fmtCompact(st.defLosses || 0)}` : null].filter(Boolean).join(' · ')));
    }
    if (this._peaceHudRow) this._peaceHudRow(hud, war, row);
    if (war.result) hud.appendChild(row('Result', (war.result.reason || 'ended')));
    if (lastEv) {
      const ago = Math.max(0, Math.round((Date.now() - lastEv.t) / 1000));
      hud.appendChild(row('Latest', el('span', lastEv.text, el('span.war-hud-ago', ago < 90 ? ` ${ago}s ago` : ` ${Math.round(ago / 60)}m ago`))));
    }
    hud.appendChild(el('div.war-hud-foot',
      el('button.dash-btn.btn-xs', { onclick: () => { W.warLegend = !W.warLegend; this.renderHud(); } }, W.warLegend ? 'Hide legend' : 'Legend'),
      el('button.dash-btn.btn-xs', { onclick: () => App.go('war') }, 'War Room →')));
    if (W.warLegend) hud.appendChild(el('div.war-legend', this._legendRows(true).map(([sw, label]) => el('div.war-legend-row', sw, el('span', label)))));
    wrap.appendChild(hud);
  },
  _removeHud() {
    const h = document.getElementById('war-hud');
    if (h) h.remove();
    this._hudSig = null;
  },

  // ---- the unit card (selection / inspection) ----
  renderUnitCard() {
    const wrap = document.getElementById('map-wrap');
    const war = (window.WarEngine && this.activePred()) || this.activeAuth();
    if (!wrap || !war) { this._removeUnitCard(); return; }
    const old = document.getElementById('war-unit-card');
    const shown = (id) => { const u = war.units.find(x => x.id === id); return u ? [Math.round(u.strength), Math.round(u.org || 0), u.state, u.supplied, u.dead, JSON.stringify(u.kit || ''), (u.inv || []).map(r => Math.round(r.qty)).join(),
      war.kind === 'protest' ? Math.round(u.pos[0] / 25) + ':' + Math.round(u.pos[1] / 25) + ':' + !!u.dest : ''].join(',') : 'gone'; };
    const ids = this._sel.size ? [...this._sel] : [this._inspect];
    const pp = war.protest || {};
    const sigBase = [this._sel.size, ids.join(), this._inspect, this._inspectRef, this.commandable(), ids.map(shown).join(';'),
      war.kind === 'protest' ? [pp.protestorsViolent, pp.govViolent, (S().properties || []).filter(pr => pr.vars && pr.vars.strike).length].join() : '',
      this._inspectRef ? JSON.stringify((war.refugees || []).find(x => x.id === this._inspectRef) || null) : ''].join('|');
    if (old && old.isConnected && this._cardSig === sigBase) return;
    this._cardSig = sigBase;
    if (old) old.remove();
    const card = el('div#war-unit-card.war-unit-card');
    const bar = (label, pct, cls, text) => el('div.war-card-stat',
      el('div.war-card-stat-head', el('span', label), el('span', text)),
      el('div.war-card-bar', el('div.war-card-bar-fill', { class: cls || '', style: `width:${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%` })));
    // a refugee column under inspection
    if (this._inspectRef) {
      const r = (war.refugees || []).find(x => x.id === this._inspectRef);
      if (!r) { this._inspectRef = null; }
      else {
        const n = Math.max(0, Math.round(r.count || 0));
        const lost = Math.max(0, Math.round((r.startCount || n) - n));
        card.appendChild(el('div.war-card-title', 'Refugee column'));
        card.appendChild(el('div.war-card-sub', `Civilians fleeing ${r.fromName || r.from} for ${r.toName || r.to}`));
        card.appendChild(el('div.war-card-row', `≈${n.toLocaleString('en-US')} people on the road` + (lost ? ` · ${lost.toLocaleString('en-US')} lost` : '')));
        card.appendChild(el('div.war-card-row', r.count <= 0 ? 'The column was destroyed.' : r.arrived != null ? 'Dispersing into shelter.' : 'On the road.'));
        wrap.appendChild(card);
        this._dockCard(card, wrap);
        return;
      }
    }
    const live = (u) => u && !u.dead && u.state !== 'dead' && u.strength > 0;
    // a group: totals and group commands
    if (this._sel.size > 1) {
      const us = [...this._sel].map(id => war.units.find(u => u.id === id)).filter(live);
      if (!us.length) { this._sel.clear(); return; }
      const str = us.reduce((s, u) => s + u.strength, 0), max = us.reduce((s, u) => s + (u.maxStrength || u.strength), 0);
      const org = us.reduce((s, u) => s + (typeof u.org === 'number' ? u.org : 100), 0) / us.length;
      const fighting = us.filter(u => u.state === 'fighting').length, cut = us.filter(u => u.supplied === false).length;
      card.appendChild(el('div.war-card-title', `${us.length} units selected`));
      card.appendChild(el('div.war-card-sub', [fighting ? `${fighting} in contact` : 'none in contact', cut ? `${cut} cut off` : null].filter(Boolean).join(' · ')));
      card.appendChild(bar('Strength', str / (max || 1), str / (max || 1) < 0.3 ? 'low' : '', `${fmtCompact(str)} / ${fmtCompact(max)}`));
      card.appendChild(bar('Morale', org / 100, org < WAR_ROUT_ORG ? 'low morale' : 'morale', Math.round(org) + '%'));
      card.appendChild(el('div.btn-row.war-card-actions', el('button.dash-btn.btn-xs', { onclick: () => this._holdSelection() }, '■ Hold position')));
      wrap.appendChild(card);
      this._dockCard(card, wrap);
      return;
    }
    const unitId = this._sel.size === 1 ? [...this._sel][0] : this._inspect;
    if (!unitId) return;
    const u = war.units.find(x => x.id === unitId);
    if (!u) {
      card.appendChild(el('div.war-card-title', 'Unit lost'));
      card.appendChild(el('div.war-card-row', 'This unit has been destroyed or is no longer tracked.'));
      wrap.appendChild(card);
      return;
    }
    const isDead = !live(u);
    if ((u.kind === 'protestor' || u.kind === 'police') && u.state !== 'transport') { this._civilCard(card, wrap, war, u, isDead, bar); return; }
    const kindLabel = (u.state === 'transport' ? 'At sea — ' : '') + (u.kind || '?').replace(/^./, (c) => c.toUpperCase());
    const sideName = war.kind === 'protest' ? (u.side === 'att' ? 'Crowd' : 'Police') : (u.side === 'att' ? 'Invader' : 'Defence');
    const own = this._sel.has(u.id);
    card.classList.add(u.side === 'att' ? 'war-card-att' : 'war-card-def');
    card.appendChild(el('div.war-card-title', u.name));
    card.appendChild(el('div.war-card-sub', `${kindLabel} · ${this._echelon(u)} · ${sideName}` + (u.nationId ? ` · ${entName(u.nationId)}` : '') + (own ? '' : ' · enemy') + (this.gridRef ? ' · ' + this.gridRef(u.pos) : '')));
    if (isDead) {
      card.appendChild(el('div.war-card-row', 'Destroyed in action.'));
    } else {
      const pct = u.strength / (u.maxStrength || u.strength || 1);
      card.appendChild(bar('Strength', pct, pct < 0.3 ? 'low' : '', `${Math.round(u.strength).toLocaleString('en-US')} / ${(u.maxStrength || 0).toLocaleString('en-US')}`));
      const org = Math.max(0, Math.min(100, typeof u.org === 'number' ? u.org : 100));
      card.appendChild(bar('Morale', org / 100, org < WAR_ROUT_ORG ? 'low morale' : 'morale', Math.round(org) + '%'));
      const stateText = { fighting: 'In contact — fighting', routed: 'Routed — falling back', holding: 'Holding', moving: 'On the move', transport: 'Embarked at sea', idle: 'Idle' }[u.state] || u.state;
      card.appendChild(el('div.war-card-row', stateText + (u.garrison ? ' · garrison' : '') + ' · ',
        u.supplied === false ? el('span.war-card-cutoff', '⚠ cut off') : 'in supply'));
      if (u.kit) card.appendChild(el('div.war-card-row.war-card-kit', `Kit ×${u.kit.dmg} fire · ×${u.kit.hp} armour · ×${u.kit.morale} morale · ×${u.kit.speed} speed`));
      const rows = (u.inv || []).filter(r => r.qty >= 0.5).map(r => { const it = itemById(r.itemId); return `${fmtNum(Math.round(r.qty))} × ${it ? it.name : r.itemId}`; });
      if (u.kit || rows.length) card.appendChild(el('div.war-card-row.war-card-kit', rows.length ? 'Carrying ' + rows.join(' · ') : 'Carrying nothing — awaiting resupply'));
      if (own && this.commandable()) card.appendChild(el('div.btn-row.war-card-actions', el('button.dash-btn.btn-xs', { onclick: () => this._holdSelection() }, '■ Hold position')));
    }
    wrap.appendChild(card);
    this._dockCard(card, wrap);
  },
  // A crowd or police detachment: people, not a formation — headcount and
  // resolve, what it is doing, and (for a crowd) the workplaces it has shut.
  _civilCard(card, wrap, war, u, isDead, bar) {
    const p = war.protest || {};
    const crowd = u.kind === 'protestor';
    const own = this._sel.has(u.id);
    card.classList.add(crowd ? 'war-card-crowd' : 'war-card-def');
    card.appendChild(el('div.war-card-title', u.name));
    const who = entName(crowd ? (p.organizerId || war.attackerId) : war.defenderId);
    card.appendChild(el('div.war-card-sub', (crowd ? 'Crowd' : 'Police detachment') + (who ? ' · ' + who : '') + (own ? '' : this.commandableSide(war) ? ' · other side' : '')));
    if (isDead) {
      card.appendChild(el('div.war-card-row', crowd ? 'This crowd has dispersed.' : 'This detachment has been overrun.'));
      wrap.appendChild(card); this._dockCard(card, wrap); return;
    }
    const pct = u.strength / (u.maxStrength || u.strength || 1);
    card.appendChild(bar(crowd ? 'People' : 'Officers', pct, pct < 0.3 ? 'low' : '', `${Math.round(u.strength).toLocaleString('en-US')} of ${(u.maxStrength || 0).toLocaleString('en-US')}`));
    const org = Math.max(0, Math.min(100, typeof u.org === 'number' ? u.org : 100));
    card.appendChild(bar('Resolve', org / 100, org < WAR_ROUT_ORG ? 'low morale' : 'morale', Math.round(org) + '%'));
    const doing = u.state === 'fighting' ? (crowd ? 'Rioting — in clashes with the police' : 'In clashes with the crowds')
      : u.state === 'routed' ? (crowd ? 'Scattering — the crowd is breaking up' : 'Falling back in disorder')
        : u.dest ? (crowd ? 'Marching' : 'Redeploying')
          : crowd ? (p.protestorsViolent ? 'Rioting where it stands' : 'Demonstrating peacefully') : (p.govViolent ? 'Cleared to use force' : p.protestorsViolent ? 'Defending itself' : 'Holding the line');
    card.appendChild(el('div.war-card-row', doing));
    if (crowd) {
      const R = 120; // the economy's strike radius (server/sim.js STRIKE_RADIUS)
      const near = (S().properties || []).filter(pr => Array.isArray(pr.pos) && Math.hypot(pr.pos[0] - u.pos[0], pr.pos[1] - u.pos[1]) <= R);
      const out = near.filter(pr => pr.vars && pr.vars.strike);
      card.appendChild(el('div.war-card-row.war-card-kit', near.length
        ? `${near.length} workplace${near.length === 1 ? '' : 's'} within reach · ${out.length} on strike` + (out.length < near.length ? ' — the rest walk out at turn end' : '')
        : 'No workplaces within reach — march closer to factories and offices to strike.'));
    }
    if (own && this.commandable()) card.appendChild(el('div.btn-row.war-card-actions', el('button.dash-btn.btn-xs', { onclick: () => this._holdSelection() }, crowd ? '■ Stay put' : '■ Hold the line')));
    wrap.appendChild(card);
    this._dockCard(card, wrap);
  },
  // phones: the card sits just above the (wrapping) toolbar
  _dockCard(card, wrap) {
    const tb = document.getElementById('war-toolbar');
    if (window.innerWidth > 640 || !tb || !card) return;
    card.style.top = 'auto';
    card.style.bottom = Math.max(8, wrap.clientHeight - tb.offsetTop + 8) + 'px';
  },
  _removeUnitCard() {
    const card = document.getElementById('war-unit-card');
    if (card) card.remove();
    this._cardSig = null;
  },
  // Stop the selection where it stands (a move order to its own position).
  _holdSelection() {
    const war = (window.WarEngine && this.activePred()) || this.activeAuth();
    if (!war || !this._sel.size) return;
    const orders = [...this._sel].map(id => war.units.find(u => u.id === id)).filter(u => u && !u.dead && u.strength > 0)
      .map(u => ({ unitId: u.id, dest: this._clamp(u.pos) }));
    if (!orders.length) return;
    const side = this.commandableSide();
    if (window.WarEngine) this._optimistic(side, orders);
    POST('/api/war/command', { side, orders, conflict: this._activeKey }).then(() => toast('Holding position.')).catch(e => toast(e.message, true));
  },

  /* ═══════════ WAR ROOM PANEL ═══════════ */
  // Phase 31: the War Room covers BOTH conflict docs — the invasion war and
  // any protest — each with its own status strip, controls and front-line
  // report, stacked in one panel.
  // A collapsible GM tool section (Views.ledgerFold); the tool's own section
  // heading is dropped since the fold's summary already names it. Open/closed
  // is remembered per session, so a re-render never snaps a tool shut.
  _fold(inner, key, label, render) {
    inner.appendChild(Views.ledgerFold(key, label, () => {
      const box = el('div');
      render(box);
      const first = box.firstChild;
      if (first && first.classList && first.classList.contains('section-label')) box.removeChild(first);
      return box;
    }));
  },

  renderPanel(inner) {
    inner.appendChild(el('div.doc-title', 'War Room'));
    const docs = this.authDocs();
    if (!docs.length) {
      inner.appendChild(el('div.doc-sub', 'No conflict is currently active.'));
      if (isGM()) {
        this.renderApplicationQueue(inner);
        this.renderStartForm(inner);
        this._fold(inner, 'wrProtestStart', 'Start a Protest', (b) => this.renderProtestStartForm(b));
        this._fold(inner, 'wrProtestRules', 'Protest Rules', (b) => this.renderProtestRules(b));
      } else this.renderProtestApplications(inner);
      return;
    }
    inner.appendChild(el('div.doc-sub', 'situation reports · the battle itself is fought on the map'));
    // A viewer parked on this panel (map not mounted) still drives the
    // heartbeat, keeping the authoritative docs ticking and the counters live.
    if (docs.some(d => d.active) && window.WarEngine) this._ensureRealtime();
    // Phase 36 UX: a conflict that has ENDED folds into one line (its full
    // after-action report is still a click away) so live business and the
    // start forms aren't pushed below a screen of zeros.
    for (const auth of [...docs].sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0))) {
      const key = this.docKeyOf(auth);
      if (auth.active) { this.renderDocPanel(inner, auth, key); continue; }
      const what = auth.kind === 'protest' ? 'Protest' : 'War';
      const why = (auth.result && auth.result.reason) || 'ended';
      inner.appendChild(Views.ledgerFold('wrEnded_' + key + '_' + (auth.startedAt || ''), `Last ${what.toLowerCase()} — ${auth.name} · ${why}`,
        () => { const box = el('div'); this.renderDocPanel(box, auth, key); return box; }));
    }
    // Both conflicts run simultaneously — the GM can start the OTHER kind
    // even while one is live (a protest mid-invasion, or a war mid-strike).
    if (isGM()) {
      this.renderApplicationQueue(inner);
      if (!S().war || !S().war.active) this.renderStartForm(inner);
      if (!S().protest || !S().protest.active) this._fold(inner, 'wrProtestStart', 'Start a Protest', (b) => this.renderProtestStartForm(b));
      this._fold(inner, 'wrProtestRules', 'Protest Rules', (b) => this.renderProtestRules(b));
    } else this.renderProtestApplications(inner);
  },

  // Open the battle map on the War layer (optionally centred on a point).
  openBattleMap(focus, key) {
    if (key) this._activeKey = key;
    const already = W.view === 'map' && GameMap.svg && GameMap.svg.isConnected;
    W.layer = 'war';
    App.go('map');
    // already on the map: App.go is a no-op, so redraw the base map in the
    // war layer (veil, grid, layer bar) ourselves
    if (already && W.layer === 'war') GameMap.render();
    if (focus) setTimeout(() => { if (GameMap.focus) GameMap.focus(focus, 3.2); }, 120);
  },

  // One conflict's situation report: what is happening, who is winning,
  // what comes next — then the detail in folds (order of battle, arsenal,
  // the full report) and the GM's levers.
  renderDocPanel(inner, war, key) {
    if (war.kind === 'protest') { this.renderProtestReport(inner, war, key); return; }
    const st = war.stats || {};
    const names = [entName(war.attackerId) || 'Invader', entName(war.defenderId) || 'Defence'];
    const statusText = war.result
      ? (war.result.winner === 'att' ? 'Ended — total victory for the invader' : war.result.winner === 'def' ? 'Ended — invasion repelled' : 'Ended')
      : (war.paused ? 'Paused' : war.totalWar ? 'Total war — no terms' : 'Fighting in progress');
    this._reportHead(inner, war, key, '⚔ ', statusText, '');
    const allyLists = war.allies || { att: [], def: [] };
    const lines = [allyLists.att && allyLists.att.length ? `Also attacking: ${allyLists.att.map(entName).join(', ')}` : null,
      allyLists.def && allyLists.def.length ? `Also defending: ${allyLists.def.map(entName).join(', ')}` : null].filter(Boolean);
    if (lines.length) inner.appendChild(el('div.doc-sub', lines.join(' · ')));

    // balance of forces + the headline numbers
    const live = (u) => !u.dead && u.state !== 'dead' && u.strength > 0;
    let attStr = 0, defStr = 0, attN = 0, defN = 0, cut = 0;
    for (const u of war.units || []) if (live(u)) { if (u.side === 'att') { attStr += u.strength; attN++; } else { defStr += u.strength; defN++; } if (u.supplied === false) cut++; }
    if (war.active) {
      const tot = attStr + defStr || 1;
      inner.appendChild(el('div.war-report-balance',
        el('div.war-report-side', el('b', names[0]), ` ${fmtCompact(attStr)} · ${attN} unit${attN === 1 ? '' : 's'}`),
        el('div.war-balance.war-balance-lg',
          el('div.war-balance-att', { style: `width:${(attStr / tot * 100).toFixed(1)}%` }),
          el('div.war-balance-def', { style: `width:${(defStr / tot * 100).toFixed(1)}%` })),
        el('div.war-report-side.right', `${defN} unit${defN === 1 ? '' : 's'} · ${fmtCompact(defStr)} `, el('b', names[1]))));
    }
    inner.appendChild(Views.statStrip([
      [names[0] + ' losses', fmtCompact(st.attLosses || 0)],
      [names[1] + ' losses', fmtCompact(st.defLosses || 0)],
      ['Civilian dead', fmtCompact(st.civilianDeaths || 0)],
      ['Refugees', fmtCompact(st.refugees || 0)],
      ['Cities fallen', String((st.citiesHeld || []).length)]
    ]));

    if (isGM()) this.renderControls(inner, war, key);
    if (this.renderPeaceTable) this.renderPeaceTable(inner, war, key);

    // objectives as a checklist, the next one called out
    if ((war.objectives || []).length) {
      inner.appendChild(Views.secLabel('Objectives'));
      const objs = [...war.objectives].sort((a, b) => a.priority - b.priority);
      const next = objs.find(o => o.status !== 'done');
      inner.appendChild(el('div.war-objectives', objs.map(o => el('div.war-objective', { class: o.status === 'done' ? 'done' : o === next ? 'next' : '' },
        el('span.war-objective-mark', o.status === 'done' ? '✓' : String(o.priority)),
        el('span.war-objective-text', this.objLabel(o) + ' — ', el('b', this.objTarget(o))),
        o === next ? el('span.war-objective-tag', 'next') : null,
        o.pos && war.active ? el('button.ow-btn.ow-act', { title: 'Show on the battle map', onclick: () => this.openBattleMap(o.pos, key) }, '◎') : null))));
    }

    // ground held
    const control = st.provinceControl || {};
    inner.appendChild(Views.secLabel('Province control'));
    const provBox = el('div');
    for (const pid of Object.keys((war.grid || {}).provinceLandCells || control)) {
      const prov = provById(pid);
      if (prov) provBox.appendChild(Views.barRow(prov.name, control[pid] || 0, prov.color, (control[pid] || 0) + '%'));
    }
    inner.appendChild(provBox);
    const enemyCtl = st.enemyControl || {};
    const enemyIds = Object.keys(enemyCtl).filter(cid => enemyCtl[cid] > 0);
    if (enemyIds.length) {
      inner.appendChild(Views.secLabel('Enemy homeland occupied'));
      const countries = ((S().settings || {}).map || {}).countries || [];
      for (const cid of enemyIds) {
        const c = countries.find(x => x.id === cid);
        inner.appendChild(Views.barRow(c ? c.name : cid, enemyCtl[cid], '#2f4a6e'));
      }
    }

    this._reportEvents(inner, war, key, 'Front-line reports', 'No engagements reported yet.');
    this._reportOrbat(inner, war, key, names, cut);
    if (war.equip && (war.equip.att || war.equip.def)) {
      inner.appendChild(Views.ledgerFold('wrArsenal_' + key, 'Arsenal & supply', () => {
        const fmtEq = (e) => e ? `fire ×${e.dmg} · armour ×${e.hp} · morale ×${e.morale} · speed ×${e.speed}` : '—';
        return el('table.data', el('tbody',
          el('tr', el('td', names[0]), el('td', fmtEq(war.equip.att))),
          el('tr', el('td', names[1]), el('td', fmtEq(war.equip.def))),
          el('tr', el('td', 'Cut off from supply'), el('td', `${cut} unit${cut === 1 ? '' : 's'}`))));
      }));
    }
    if (this.renderAirReport) this.renderAirReport(inner, (window.WarEngine && this.predictedDoc(war)) || war, key);
  },

  // The report's masthead, shared by wars and protests: name, status, clock,
  // the way onto the map, and who may command what.
  _reportHead(inner, war, key, glyph, statusText, statusCls) {
    const endMs = war.result && war.result.endedAt ? new Date(war.result.endedAt).getTime() : Date.now();
    const elapsed = Math.max(0, Math.round((endMs - new Date(war.startedAt).getTime()) / 1000));
    const hh = Math.floor(elapsed / 3600), mm = Math.floor((elapsed % 3600) / 60), ss = elapsed % 60;
    const lasted = hh >= 48 ? `${Math.floor(hh / 24)}d ${hh % 24}h` : hh ? `${hh}h ${mm}m` : `${mm}m ${ss}s`;
    inner.appendChild(Views.secLabel(glyph + war.name));
    inner.appendChild(el('div.war-report-head',
      el('span.war-report-status', { class: (war.result ? 'ended' : war.paused ? 'paused' : 'live') + (statusCls ? ' ' + statusCls : '') }, statusText),
      el('span.war-report-meta', `tick ${war.tick} · ${lasted} ${war.active ? 'elapsed' : 'long'} · ${war.speed}×`),
      war.active ? el('button.solid-btn.btn-xs', { onclick: () => this.openBattleMap(null, key) }, war.kind === 'protest' ? 'Open the street map →' : 'Open the battle map →') : null));
    if (war.active) inner.appendChild(el('div.war-authority', this.authorityText(war)));
  },
  // the latest reports; the full log folds
  _reportEvents(inner, war, key, title, empty) {
    inner.appendChild(Views.secLabel(title));
    const evs = [...(war.events || [])].reverse();
    const evRow = (ev) => el('div.activity-item', el('span.when', new Date(ev.t).toLocaleTimeString()), ev.text,
      ev.pos && war.active ? el('button.ow-btn.ow-act', { title: 'Show on the map', onclick: () => this.openBattleMap(ev.pos, key) }, '◎') : null);
    if (!evs.length) inner.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, empty));
    // routine rout/kill chatter collapses so captures and landings stand out
    const notable = evs.filter(e => e.kind !== 'battle').slice(0, 5);
    for (const ev of (notable.length ? notable : evs.slice(0, 5))) inner.appendChild(evRow(ev));
    if (evs.length > 5) inner.appendChild(Views.ledgerFold('wrLog_' + key, `Full report — ${evs.length} entries`, () => el('div', evs.slice(0, 60).map(evRow))));
  },
  // order of battle, folded
  _reportOrbat(inner, war, key, names, cut) {
    const live = (u) => !u.dead && u.state !== 'dead' && u.strength > 0;
    const units = (war.units || []).filter(live);
    if (!units.length) return;
    const protest = war.kind === 'protest';
    const label = protest ? `Who is on the streets — ${units.length} crowd${units.length === 1 ? '' : 's'} & detachments`
      : `Order of battle — ${units.length} units in the field${cut ? ` · ${cut} cut off` : ''}`;
    inner.appendChild(Views.ledgerFold('wrOrbat_' + key, label, () => {
      const sorted = units.slice().sort((a, b) => (a.side === b.side ? b.strength - a.strength : a.side === 'def' ? -1 : 1));
      return el('table.data.war-orbat',
        el('thead', el('tr', el('th', protest ? 'Crowd / detachment' : 'Unit'), el('th', 'Side'), el('th', 'Type'), el('th.num', protest ? 'People' : 'Strength'), el('th.num', protest ? 'Resolve' : 'Morale'), el('th', 'State'), el('th', ''))),
        el('tbody', sorted.map(u => {
          const pct = Math.round(u.strength / (u.maxStrength || u.strength || 1) * 100);
          return el('tr', { class: u.side === 'att' ? 'war-orbat-att' : 'war-orbat-def' },
            el('td', u.name),
            el('td', u.side === 'att' ? names[0] : names[1]),
            el('td', protest ? (u.kind === 'protestor' ? 'Crowd' : u.kind === 'police' ? 'Police' : (u.kind || '').replace(/^./, c => c.toUpperCase())) : (u.kind || '').replace(/^./, c => c.toUpperCase()) + ' ' + this._echelon(u)),
            el('td.num', protest ? fmtNum(Math.round(u.strength)) : `${pct}%`),
            el('td.num', Math.round(typeof u.org === 'number' ? u.org : 100) + '%'),
            el('td', u.state + (u.supplied === false && !protest ? ' · cut off' : '')),
            el('td', war.active ? el('button.ow-btn.ow-act', { title: 'Show on the map', onclick: () => this.openBattleMap(u.pos, key) }, '◎') : null));
        })));
    }));
  },

  // ═══ A protest's situation report ═══
  // Who marches and why, where the standoff sits on the 2×2 escalation grid
  // (with the levers this viewer holds), what the streets look like, what it
  // is doing to opinion and to the economy (strikes) — then the log.
  renderProtestReport(inner, war, key) {
    const p = war.protest || {};
    const st = war.stats || {};
    const sm = this._protestSummary(war);
    const posture = protestPosture(p);
    const endText = !war.result ? '' : war.result.winner === 'def' ? 'Ended — crowds dispersed'
      : war.result.winner === 'att' ? 'Ended — demands conceded'
        : /called off/i.test(war.result.reason || '') ? 'Ended — called off by the organizers' : 'Ended';
    const statusText = war.result ? endText : war.paused ? 'Paused' : PROTEST_POSTURE[posture].label + (posture === 'peaceful' ? ' demonstration' : '');
    this._reportHead(inner, war, key, '⚒ ', statusText, war.result ? '' : 'posture-' + posture);

    // the movement
    const org = sm.org;
    const cityNames = (ids) => (ids || []).map(cityById).filter(Boolean).map(c => c.name).join(', ');
    inner.appendChild(el('div.protest-banner',
      org && org.logo ? el('img.protest-banner-logo', { src: org.logo, alt: '' }) : el('span.protest-banner-glyph', '⚒'),
      el('div.protest-banner-body',
        el('div.protest-banner-org', 'Organized by ', el('b', org ? org.name : '—'),
          sm.party && org && sm.party.id !== org.id ? ` · marching for ${sm.party.name}` : ''),
        p.demands ? el('div.war-demands', '“' + p.demands + '”') : el('div.protest-banner-where', 'No demands were published.'),
        el('div.protest-banner-where', 'Rallied in ' + (cityNames(p.baseCities) || 'several cities') +
          ((p.policeCities || []).length ? ' · police posted to ' + cityNames(p.policeCities) : '')))));

    if (war.active) this._postureGrid(inner, war, key);
    else if (war.result && war.result.reason) inner.appendChild(el('div.protest-outcome', war.result.reason + '.'));
    if (isGM()) this.renderControls(inner, war, key);
    if (this.renderPeaceTable) this.renderPeaceTable(inner, war, key);

    // the streets
    inner.appendChild(Views.secLabel('The streets'));
    if (war.active) {
      const tot = sm.crowd + sm.police || 1;
      inner.appendChild(el('div.war-report-balance',
        el('div.war-report-side', el('b', 'Crowds'), ` ≈${warHeads(sm.crowd)} · ${sm.crowdN}`),
        el('div.war-balance.war-balance-lg',
          el('div.war-balance-crowd', { style: `width:${(sm.crowd / tot * 100).toFixed(1)}%` }),
          el('div.war-balance-police', { style: `width:${(sm.police / tot * 100).toFixed(1)}%` })),
        el('div.war-report-side.right', `${sm.policeN} · ${fmtNum(Math.round(sm.police))} `, el('b', 'Police'))));
    }
    inner.appendChild(Views.statStrip([
      ['Cities in unrest', String(sm.unrest.length)],
      ['Workplaces on strike', String(sm.strikes.length)],
      ['Civilian dead', fmtCompact(st.civilianDeaths || 0)],
      ['Fled their homes', fmtCompact(st.refugees || 0)],
      ['Crowd / police hurt', `${fmtCompact(st.attLosses || 0)} / ${fmtCompact(st.defLosses || 0)}`]
    ]));
    if (war.active && sm.unrest.length) {
      inner.appendChild(el('div.protest-places', el('span.mono-label', 'In unrest'),
        sm.unrest.map(cid => { const c = cityById(cid); return c ? el('button.chip', { title: 'Show on the map', onclick: () => this.openBattleMap(c.pos, key) }, c.name + ' ◎') : null; })));
    }

    this.renderProtestOpinion(inner, war, sm);

    // strikes
    inner.appendChild(Views.secLabel('Strikes'));
    const cap = Number(((p.tuning || {}).strikeFrac));
    if (!(cap > 0)) {
      inner.appendChild(el('div.protest-note', 'The strike effect is switched off for this protest (GM tuning).'));
    } else if (sm.strikes.length) {
      const sorted = sm.strikes.slice().sort((a, b) => (b.vars.strike.degree || 0) - (a.vars.strike.degree || 0));
      const table = (rows) => el('table.data.protest-strikes',
        el('thead', el('tr', el('th', 'Workplace'), el('th', 'Owner'), el('th.num', 'Output'), el('th.num', 'Since'), el('th', ''))),
        el('tbody', rows.map(pr => el('tr',
          el('td', pr.name),
          el('td', entName(pr.ownerId) || '—'),
          el('td.num', { style: 'color:var(--accent)' }, '−' + Math.round((pr.vars.strike.degree || 0) * 100) + '%'),
          el('td.num', 'T' + pr.vars.strike.sinceTurn),
          el('td', war.active && pr.pos ? el('button.ow-btn.ow-act', { title: 'Show on the map', onclick: () => this.openBattleMap(pr.pos, key) }, '◎') : null)))));
      inner.appendChild(table(sorted.slice(0, 5)));
      if (sorted.length > 5) inner.appendChild(Views.ledgerFold('wrStrikes_' + (war.startedAt || ''), `All ${sorted.length} workplaces on strike`, () => table(sorted)));
    } else {
      inner.appendChild(el('div.protest-note', war.active
        ? `No workplace is out yet. At the end of each turn, every factory, office or shop within reach of a crowd walks out — its output drops by up to ${Math.round(cap * 100)}% while the crowd stays.`
        : 'Work has resumed everywhere.'));
    }

    // seized ground — only once the crowds claim any
    if (p.captureMode || sm.control.length) {
      inner.appendChild(Views.secLabel('Seized districts'));
      if (!sm.control.length) inner.appendChild(el('div.protest-note', 'The crowds are moving to seize ground — no district has fallen yet.'));
      for (const [pid, v] of sm.control) { const prov = provById(pid); if (prov) inner.appendChild(Views.barRow(prov.name, v, prov.color, v + '%')); }
    }

    if (this.renderAirReport) this.renderAirReport(inner, (window.WarEngine && this.predictedDoc(war)) || war, key);
    this._reportEvents(inner, war, key, 'Reports from the streets', 'Nothing to report yet.');
    this._reportOrbat(inner, war, key, ['Crowds', 'Police'], 0);
  },
  // The 2×2: crowds peaceful/violent × police holding/force — the current
  // cell lit, what it means spelled out, then this viewer's levers.
  _postureGrid(inner, war, key) {
    const p = war.protest || {};
    const ca = this.access(war);
    const cur = protestPosture(p);
    inner.appendChild(Views.secLabel('Escalation'));
    const cell = (k) => el('div.posture-cell', { class: 'posture-' + k + (k === cur ? ' current' : '') },
      el('div.posture-cell-head', PROTEST_POSTURE[k].label, k === cur ? el('span.posture-now', 'now') : null),
      el('div.posture-cell-text', PROTEST_POSTURE[k].short));
    inner.appendChild(el('div.posture-grid',
      el('div'), el('div.posture-axis', 'Police hold back'), el('div.posture-axis', 'Force authorized'),
      el('div.posture-axis.posture-row', 'Crowds peaceful'), cell('peaceful'), cell('crackdown'),
      el('div.posture-axis.posture-row', 'Crowds violent'), cell('riot'), cell('clashes')));
    inner.appendChild(el('div.protest-note', PROTEST_POSTURE[cur].text));
    const row = el('div.btn-row.protest-levers');
    for (const lv of this._protestLevers(war, key, ca)) {
      row.appendChild(el('button', { class: lv.on ? 'solid-btn active' : (lv.danger ? 'danger-btn' : 'dash-btn'), title: lv.title, onclick: () => lv.run() }, lv.label));
    }
    if (ca.force) {
      const n = this._armyDeployed(war);
      row.appendChild(el('button.danger-btn', { title: 'Send army battalions into the streets beside the police', onclick: () => this._armyModal(war) }, '🪖 Deploy the army'));
      if (n) row.appendChild(el('button.dash-btn', { title: 'Send the troops back to barracks', onclick: () => this._armyWithdraw() }, `Withdraw troops (${n})`));
    }
    if (ca.attLead && !isGM()) {
      row.appendChild(el('button.dash-btn', {
        title: 'End the protest. The opinion it has already won stays won.',
        onclick: () => confirmModal('CALL OFF THE PROTEST', 'Send the crowds home? The protest ends now; the opinion it has already won stays won.', async () => {
          await POST('/api/protest/disband', {});
          toast('The organizers call the protest off.');
        }, 'Call It Off')
      }, '✋ Call it off'));
    }
    if (ca.concede) {
      const cs = Number((((S().settings || {}).war || {}).protest || {}).concedeSupport);
      row.appendChild(el('button.dash-btn', {
        title: 'Give the protestors what they ask. The protest ends in their victory.',
        onclick: () => confirmModal('CONCEDE TO THE DEMANDS', 'Give the protestors what they ask' + (p.demands ? ` (“${p.demands}”)` : '') + '? The protest ends in their victory' +
          (cs > 0 ? ` and the movement's party gains +${cs} support in every province it marched in.` : '.'), async () => {
          await POST('/api/protest/concede', {});
          toast('The government concedes.');
        }, 'Concede')
      }, '🤝 Concede the demands'));
    }
    if (row.childNodes.length) inner.appendChild(row);
    else inner.appendChild(el('div.protest-note', 'Only the organizers can escalate or call the protest off, and only cleared security officials can authorize force.'));
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
    this._fold(inner, 'wrCustomScenario', 'Custom Scenario Creator', (b) => this.renderCustomScenarioForm(b));
  },

  _customDraft: { name: 'Custom War', attackerId: '', defenderId: 'ent_gov', infantry: 3, armored: 1, marine: 0, boat: 0, warship: 0 },
  renderCustomScenarioForm(inner) {
    inner.appendChild(Views.secLabel('Custom Scenario Creator'));
    const d = this._customDraft;
    const attackers = S().entities.filter(e => e.type === 'foreign').map(e => [e.id, e.name]);
    const defenders = S().entities.filter(e => ['government','foreign'].includes(e.type)).map(e => [e.id, e.name]);
    if (!d.attackerId && attackers.length) d.attackerId = attackers[0][0];
    const box = el('div.form-grid',
      Forms.field('Scenario name', Forms.text(d, 'name')),
      Forms.field('Attacker', Forms.sel(d, 'attackerId', attackers)),
      Forms.field('Defender', Forms.sel(d, 'defenderId', defenders)),
      Forms.field('Infantry', Forms.num(d, 'infantry')),
      Forms.field('Armored', Forms.num(d, 'armored')),
      Forms.field('Marines', Forms.num(d, 'marine')),
      Forms.field('Boats', Forms.num(d, 'boat')),
      Forms.field('Warships', Forms.num(d, 'warship')));
    inner.appendChild(box);
    inner.appendChild(el('div.btn-row', el('button.solid-btn', { onclick: async () => {
      try { const r = await POST('/api/gm/war/scenarios/custom', d); this._scenarioList = null; toast(`${r.scenario.name} created.`); this._ensureScenarioList(); }
      catch (e) { toast(e.message, true); }
    } }, 'Create Custom Scenario')));
  },

  // GM protest starter — pick an organizer (party / person / company / org /
  // foreign power), name the movement, choose the cities where crowds gather
  // and where police deploy. POSTs /api/gm/protest/start (server/war.js
  // startProtest); both conflict docs run simultaneously, so a protest can
  // begin mid-war.
  _protestDraft: null,
  // A city picker as tappable chips (wrapping, thumb-sized). stateOf(cid)
  // names a chip's state ('' | 'rally' | 'police'); onTap(cid) changes it.
  // Chips repaint in place, so a pick never re-renders the form mid-edit.
  _cityChips(cities, stateOf, onTap) {
    const box = el('div.city-chips');
    const paint = () => {
      for (const b of box.children) {
        const st = stateOf(b.getAttribute('data-city'));
        b.setAttribute('class', 'city-chip' + (st ? ' city-chip-' + st : ''));
      }
    };
    for (const c of cities) {
      box.appendChild(el('button', { type: 'button', 'data-city': c.id, 'data-name': String(c.name || '').toLocaleLowerCase(),
        onclick: () => { onTap(c.id); paint(); } }, c.name + (c.isCapital ? ' ★' : '')));
    }
    paint();
    return box;
  },
  _citySearch(inner, box) {
    return el('input.text-input.city-chip-search', {
      type: 'search', placeholder: 'Filter cities…',
      oninput: (e) => {
        const q = e.target.value.trim().toLocaleLowerCase();
        for (const b of box.children) b.style.display = !q || b.getAttribute('data-name').includes(q) ? '' : 'none';
      }
    });
  },
  renderProtestStartForm(inner) {
    inner.appendChild(Views.secLabel('Start a Protest'));
    const d = this._protestDraft = this._protestDraft || {
      name: 'Popular unrest', organizerId: '', demands: '', baseCities: [], policeCities: [],
      crowds: 2, perCity: 2000
    };
    const organizerOpts = (S().entities || [])
      .filter(e => ['party', 'person', 'company', 'org', 'foreign'].includes(e.type))
      .map(e => [e.id, e.name + ' (' + e.type + ')']);
    if (!d.organizerId && organizerOpts.length) d.organizerId = organizerOpts[0][0];
    const cities = S().cities || [];
    const maxUnits = MAX_PROTEST_UNITS_CLIENT;
    const plan = el('div.protest-plan');
    let startButton;
    const update = () => {
      const crowds = d.baseCities.length * (Number(d.crowds) || 1);
      const posts = d.policeCities.length * 2;
      const count = crowds + posts;
      const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
      clear(plan);
      plan.appendChild(el('span', d.baseCities.length
        ? `${n(crowds, 'crowd', 'crowds')} · ≈${warHeads(crowds * (Number(d.perCity) || 0))} people in ${n(d.baseCities.length, 'city', 'cities')}`
        : 'Tap at least one city for a rally.'));
      plan.appendChild(el('span', d.policeCities.length ? ` · ${n(posts, 'police detachment', 'police detachments')} in ${n(d.policeCities.length, 'city', 'cities')}` : ' · no police posted'));
      plan.appendChild(el('span', { class: count > maxUnits ? 'over' : '' }, ` · ${count}/${maxUnits} units`));
      if (startButton) startButton.disabled = !d.baseCities.length || count > maxUnits;
    };
    inner.appendChild(el('div.form-grid',
      Forms.field('Movement name', Forms.text(d, 'name')),
      Forms.field('Organizer', Forms.sel(d, 'organizerId', organizerOpts)),
      Forms.field('Crowds per rally city', Forms.sliderNum(d, 'crowds', 1, 6, { step: 1, onInput: update })),
      Forms.field('People per crowd', Forms.sliderNum(d, 'perCity', 500, 20000, { step: 500, onInput: update }))));
    inner.appendChild(Forms.field('Demands', Forms.area(d, 'demands', 'min-height:44px;'), 'What would send the crowds home? Printed on the wire and in the War Room.'));
    // one list, three states: tap → rally, tap again → police post, again → clear
    const chips = this._cityChips(cities,
      (cid) => d.baseCities.includes(cid) ? 'rally' : d.policeCities.includes(cid) ? 'police' : '',
      (cid) => {
        if (d.baseCities.includes(cid)) { d.baseCities = d.baseCities.filter(x => x !== cid); d.policeCities = [...d.policeCities, cid]; }
        else if (d.policeCities.includes(cid)) d.policeCities = d.policeCities.filter(x => x !== cid);
        else d.baseCities = [...d.baseCities, cid];
        update();
      });
    inner.appendChild(Forms.field('Where', el('div',
      el('div.city-chip-key', el('span.city-chip.city-chip-rally', 'Rally'), ' tap once · ', el('span.city-chip.city-chip-police', 'Police'), ' tap twice · again to clear'),
      cities.length > 12 ? this._citySearch(inner, chips) : null,
      chips)));
    inner.appendChild(plan);
    startButton = el('button.solid-btn', {
      onclick: async () => {
        if (!d.baseCities.length) return toast('Tap at least one city for a rally.', true);
        try { await POST('/api/gm/protest/start', d); this._protestDraft = null; toast('The crowds take to the streets.'); }
        catch (e) { toast(e.message, true); }
      }
    }, '⚒ Start the protest');
    inner.appendChild(el('div.btn-row', startButton));
    update();
  },

  // GM unit spawner (Feature: mid-war reinforcements) — side/kind/count/HP/
  // damage/speed controls, then "Arm placement" hands off to a map click
  // (see onMapPointerDown's _spawnArmed branch and _doSpawn). Mirrors the
  // bomb-arming flow: armed state shows on the floating war toolbar too, and
  // Esc disarms it (see bindKeys).
  renderSpawner(inner, war, key) {
    inner.appendChild(Views.secLabel('Spawn Units'));
    const d = this._spawnDraft;
    const box = el('div');
    box.appendChild(Forms.field('Side', el('div.btn-row',
      el('button.dash-btn', { class: d.side === 'att' ? 'active' : '', onclick: () => { d.side = 'att'; this._reRenderPanel(); } }, 'Attacker'),
      el('button.dash-btn', { class: d.side === 'def' ? 'active' : '', onclick: () => { d.side = 'def'; this._reRenderPanel(); } }, 'Defender')
    )));
    box.appendChild(Forms.field('Kind', Forms.sel(d, 'kind', WAR_SPAWN_KINDS)));
    // Division name — optional; the server numbers multi-unit spawns
    // ("<name> 1..N") and falls back to its generic GM-spawned label when
    // left blank (see server/war.js spawnUnits' namePrefix).
    box.appendChild(Forms.field('Division name', Forms.text(d, 'name', 'e.g. 3rd Lachevan Rifles (optional)')));
    box.appendChild(Forms.field('Count', Forms.sliderNum(d, 'count', 1, 12, { step: 1 })));
    box.appendChild(Forms.field('HP (strength)', Forms.sliderNum(d, 'strength', 50, 20000, { step: 50 })));
    box.appendChild(Forms.field('Damage (atk ×)', Forms.sliderNum(d, 'atk', 0.2, 10, { step: 0.1 })));
    box.appendChild(Forms.field('Speed', Forms.sliderNum(d, 'speed', 0, 12, { step: 0.1 })));
    box.appendChild(el('div.btn-row', el('button.solid-btn', {
      class: this._spawnArmed ? 'active' : '',
      onclick: () => {
        this._spawnDraft.conflict = key; // placement lands in THIS conflict's doc
        this._spawnArmed = !this._spawnArmed;
        if (this._spawnArmed) { this._airPlan = null; this._tool = null; }
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

  // The conflict clock as a slider (log-spaced stops 0.01×–8×) plus a number
  // box for any exact positive value up to 8× — as slow as the GM likes: the
  // label follows the thumb, the POST goes on release / on commit of the box.
  _speedSlider(war, key) {
    const cur = Number(war.speed) || 1;
    let idx = 0;
    WAR_SPEEDS.forEach((v, i) => { if (Math.abs(Math.log(v / cur)) < Math.abs(Math.log(WAR_SPEEDS[idx] / cur))) idx = i; });
    const tickMs = war.tickMs || 2000;
    const per = (v) => {
      const ms = Math.max(200, tickMs / v), s = ms / 1000;
      return s >= 86400 ? Math.round(s / 8640) / 10 + ' days' : s >= 3600 ? Math.round(s / 360) / 10 + 'h' : s >= 60 ? Math.round(s / 6) / 10 + ' min' : s >= 1 ? Math.round(s * 10) / 10 + 's' : Math.round(ms) + 'ms';
    };
    const hi = WAR_SPEEDS[WAR_SPEEDS.length - 1];
    const label = el('span.war-speed-label', warSpeedLabel(cur), el('span.war-speed-per', ` · a tick every ${per(cur)}`));
    const show = (v) => { label.firstChild.textContent = warSpeedLabel(v); label.lastChild.textContent = ` · a tick every ${per(v)}`; };
    const send = async (v) => {
      try { await POST('/api/gm/war/control', { speed: v, conflict: key }); toast(`Speed ${warSpeedLabel(v)} — a tick every ${per(v)}.`); }
      catch (err) { toast(err.message, true); }
    };
    let box;
    const input = el('input.war-speed-range', { type: 'range', min: 0, max: WAR_SPEEDS.length - 1, step: 1, value: idx, title: 'Conflict speed',
      oninput: (e) => { const v = WAR_SPEEDS[+e.target.value]; show(v); box.value = v; },
      onchange: (e) => send(WAR_SPEEDS[+e.target.value]) });
    box = el('input.war-speed-num', { type: 'number', min: 0, max: hi, step: 'any', value: cur, title: `Exact speed — any positive value up to ${hi}×`,
      onchange: (e) => {
        const n = Number(e.target.value);
        if (!(n > 0)) { e.target.value = cur; return toast('Speed must be above 0 — use Pause to stop the clock.', true); }
        const v = Number(Math.min(hi, n).toPrecision(4));
        e.target.value = v; show(v);
        let j = 0; WAR_SPEEDS.forEach((s, i) => { if (Math.abs(Math.log(s / v)) < Math.abs(Math.log(WAR_SPEEDS[j] / v))) j = i; });
        input.value = j;
        send(v);
      } });
    return el('label.war-speed', el('span.mono-label', 'Speed'), input, box, el('span.war-speed-x', '×'), label);
  },
  renderControls(inner, war, key) {
    const protest = war.kind === 'protest';
    const row = el('div.btn-row.war-gm-row');
    if (!war.result) {
      row.appendChild(el('span.mono-label', 'GM'));
      row.appendChild(el('button.solid-btn.btn-xs', {
        onclick: async () => { try { await POST('/api/gm/war/control', { paused: !war.paused, conflict: key }); } catch (e) { toast(e.message, true); } }
      }, war.paused ? '▶ Resume' : '⏸ Pause'));
      row.appendChild(this._speedSlider(war, key));
      row.appendChild(el('button.danger-btn.btn-xs', {
        onclick: () => confirmModal(protest ? 'END PROTEST' : 'END WAR', protest ? 'End the protest now? The crowds stand down and production resumes.' : 'End the war now? The result stays on record for review.', async () => {
          await POST(protest ? '/api/gm/protest/end' : '/api/gm/war/end', { conflict: key });
          toast(protest ? 'Protest ended by GM order.' : 'War ended by GM order.');
        }, protest ? 'End Protest' : 'End War')
      }, protest ? '■ End Protest' : '■ End War'));
    } else {
      row.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'This conflict has concluded.'));
    }
    inner.appendChild(row);
    if (!war.result) {
      // Phase 36 UX: GM tools fold away so the live status stays on top
      // (the panel used to be a ~3000px scroll of open forms).
      this._fold(inner, protest ? 'wrProtestTune' : 'wrWarTune', protest ? 'Protest Tuning' : 'Global Tuning',
        (b) => protest ? this.renderProtestTuning(b, war, key) : this.renderTuning(b, war));
      this._fold(inner, 'wrSpawn_' + key, 'Spawn Units', (b) => this.renderSpawner(b, war, key));
      if (!protest) this._fold(inner, 'wrJoin', 'Foreign Intervention', (b) => this.renderIntervention(b, war));
    }
    if (!protest) {
      this._fold(inner, 'wrTreaty', 'Peace Treaty', (b) => this.renderTreaty(b, war));
      // (the scenario picker is NOT repeated here — renderPanel already
      // shows it whenever no war is live; an ended war used to show it twice)
    }
  },

  // Phase 36 — what the protest is doing to public opinion (server/war.js
  // applyProtestPolitics keeps running totals on war.stats.politics).
  renderProtestOpinion(inner, war, sm) {
    sm = sm || this._protestSummary(war);
    inner.appendChild(Views.secLabel('Public opinion'));
    const pol = sm.pol;
    if (!pol) {
      inner.appendChild(el('div.protest-note',
        war.active ? 'Opinion shifts while the crowds hold the streets — the first reading arrives within the minute.' : 'The protest left no measurable mark on public opinion.'));
      return;
    }
    const MOOD = {
      sympathy: 'The public is sympathetic — peaceful crowds are winning hearts.',
      crackdown: 'The crackdown is turning the public against the government.',
      backlash: 'The rioting is turning the public against the movement.'
    };
    const party = sm.party;
    if (war.active && pol.mood) inner.appendChild(el('div.protest-mood', { class: 'mood-' + pol.mood }, MOOD[pol.mood] || ''));
    inner.appendChild(el('div.protest-opinion',
      el('div.protest-op', el('div.protest-op-v', { class: sm.support >= 0 ? 'up' : 'down' }, party ? this._signed(sm.support) : '—'),
        el('div.protest-op-k', party ? (party.abbrev || party.name) + ' support' : 'No party behind it')),
      el('div.protest-op', el('div.protest-op-v', { class: sm.approval >= 0 ? 'up' : 'down' }, this._signed(sm.approval) + ' pts'),
        el('div.protest-op-k', 'Government approval'))));
    const provIds = [...new Set([...Object.keys(pol.support || {}), ...Object.keys(pol.approval || {})])];
    if (provIds.length) {
      const signed = (v) => this._signed(v || 0);
      inner.appendChild(Views.ledgerFold('wrOpinion_' + (war.startedAt || ''), `By province — summed over ${provIds.length} province${provIds.length === 1 ? '' : 's'}`, () => el('table.data',
        el('thead', el('tr', el('th', 'Province'), el('th.num', party ? (party.abbrev || party.name) + ' support' : 'Party support'), el('th.num', 'Gov. approval'))),
        el('tbody', provIds.map(pid => el('tr',
          el('td', (provById(pid) || {}).name || pid),
          el('td.num', { style: 'color:' + ((pol.support || {})[pid] >= 0 ? 'var(--good)' : 'var(--accent)') }, party ? signed((pol.support || {})[pid]) : '—'),
          el('td.num', { style: 'color:' + ((pol.approval || {})[pid] < 0 ? 'var(--accent)' : 'var(--good)') }, signed((pol.approval || {})[pid]) + ' pts')))))));
    }
    if (!party) inner.appendChild(el('div.protest-note', 'No party leads this movement, so its sympathy builds no party support.'));
  },

  // Phase 36 — player-called protests. Anyone leading a party, organisation,
  // company — or just themselves — may petition the GM; the server checks
  // control (api.js /api/protest/apply) and sizes the petition (≤3 cities ×
  // ≤3 crowds × ≤5000). The GM rules from renderApplicationQueue.
  _appDraft: null,
  renderProtestApplications(inner) {
    const s = S();
    const apps = (s.protestApplications || []).slice().reverse();
    const mine = ownershipSetClient();
    const orgs = (s.entities || []).filter(e => mine.has(e.id) && ['party', 'org', 'company', 'person'].includes(e.type))
      .sort((a, b) => (a.type === 'party' ? 0 : 1) - (b.type === 'party' ? 0 : 1));
    if (!orgs.length && !apps.length) return;
    const accepting = (((s.settings || {}).war || {}).protest || {}).applications !== false;
    inner.appendChild(Views.secLabel('Call a Protest'));
    const STATUS = { pending: 'AWAITING THE GM', approved: 'APPROVED', denied: 'DENIED', withdrawn: 'WITHDRAWN' };
    for (const a of apps) {
      const cities = (a.baseCities || []).map(id => (cityById(id) || {}).name || id).join(', ');
      inner.appendChild(el('div.war-app',
        el('div', el('b', a.name), ' · ', entName(a.organizerId), ' · ', cities,
          ' ', el('span.chip', { class: a.status === 'approved' ? 'active' : '' }, STATUS[a.status] || a.status)),
        a.demands ? el('div.war-demands', '“' + a.demands + '”') : null,
        a.note ? el('div', { style: 'font-size:12px; color:var(--ink-soft);' }, 'GM: ' + a.note) : null,
        a.status === 'pending' ? el('div.btn-row', el('button.dash-btn', {
          onclick: async () => { try { await POST('/api/protest/applications/' + a.id + '/withdraw', {}); toast('Application withdrawn.'); } catch (e) { toast(e.message, true); } }
        }, 'Withdraw')) : null));
    }
    if (!orgs.length) return;
    if (!accepting) {
      inner.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'The Gamemaster is not accepting protest applications right now.'));
      return;
    }
    // The petition form folds away (open by default only while the streets
    // are quiet) — it used to sit fully open under a live protest.
    const live = !!(s.protest && s.protest.active);
    inner.appendChild(Views.ledgerFold('wrPetition', 'File a petition', () => { const box = el('div'); this._petitionForm(box, orgs); return box; }, !live));
  },
  _petitionForm(inner, orgs) {
    const s = S();
    const d = this._appDraft = this._appDraft || { organizerId: orgs[0].id, name: '', demands: '', baseCities: [], crowds: 2, perCity: 2000 };
    if (!orgs.some(o => o.id === d.organizerId)) d.organizerId = orgs[0].id;
    inner.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px; margin-bottom:4px;' },
      'Petition the Gamemaster to let your movement take to the streets. Peaceful crowds build sympathy for the party that leads them; riots cost it.'));
    inner.appendChild(el('div.form-grid',
      Forms.field('Organized by', Forms.sel(d, 'organizerId', orgs.map(e => [e.id, e.name + ' (' + e.type + ')']))),
      Forms.field('Movement name', Forms.text(d, 'name', 'e.g. March for Bread')),
      Forms.field('Crowds per city', Forms.sliderNum(d, 'crowds', 1, 3, { step: 1 })),
      Forms.field('People per crowd', Forms.sliderNum(d, 'perCity', 500, 5000, { step: 250 }))));
    inner.appendChild(Forms.field('Demands', Forms.area(d, 'demands', 'min-height:54px;'), 'What would make the crowds go home? Shown on the wire if approved.'));
    const chips = this._cityChips(s.cities || [], (cid) => d.baseCities.includes(cid) ? 'rally' : '', (cid) => {
      if (d.baseCities.includes(cid)) d.baseCities = d.baseCities.filter(id => id !== cid);
      else if (d.baseCities.length >= 3) toast('A petition may name at most 3 cities.', true);
      else d.baseCities = [...d.baseCities, cid];
    });
    inner.appendChild(Forms.field('Rally cities — up to 3', chips));
    inner.appendChild(el('div.btn-row', el('button.solid-btn', {
      onclick: async () => {
        if (!d.baseCities.length) return toast('Choose at least one city to rally in.', true);
        try {
          await POST('/api/protest/apply', d);
          this._appDraft = null;
          toast('Petition filed — the Gamemaster will rule on it.');
        } catch (e) { toast(e.message, true); }
      }
    }, '⚒ File petition')));
  },

  // GM — standing protest rules (settings.war.protest): whether players may
  // petition, how hard protests move opinion, and the defaults every NEW
  // protest starts from. A live protest's own tuning sliders are separate.
  _rulesDraft: null,
  renderProtestRules(inner) {
    const cur = ((S().settings || {}).war || {}).protest || {};
    const d = this._rulesDraft = this._rulesDraft || JSON.parse(JSON.stringify(cur));
    inner.appendChild(Views.secLabel('Protest Rules'));
    const box = el('div');
    box.appendChild(Forms.check(d, 'applications', 'Players may petition to start protests'));
    box.appendChild(el('div.form-grid',
      Forms.field('Opinion pass every (ticks)', Forms.sliderNum(d, 'politicsEvery', 2, 120, { step: 1 })),
      Forms.field('Full-intensity crowd size', Forms.sliderNum(d, 'refCrowd', 1000, 100000, { step: 500 })),
      Forms.field('Sympathy per pass (support pts)', Forms.sliderNum(d, 'sympathyPerPass', 0, 2, { step: 0.01 })),
      Forms.field('Approval lost per pass (pts)', Forms.sliderNum(d, 'pressurePerPass', 0, 2, { step: 0.01 })),
      Forms.field('Riot backlash per pass (support pts)', Forms.sliderNum(d, 'backlashPerPass', 0, 2, { step: 0.01 })),
      Forms.field('Crackdown multiplier', Forms.sliderNum(d, 'crackdownMult', 1, 10, { step: 0.5, suffix: '×' })),
      Forms.field('Support won on concession', Forms.sliderNum(d, 'concedeSupport', 0, 20, { step: 0.5 })),
      Forms.field('Default strike output drop', Forms.sliderNum(d, 'strikeFrac', 0, 1, { step: 0.05 }))));
    box.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:11px; margin-top:4px;' },
      'Each pass weighs every province’s crowd against the full-intensity size (capped 1.5×). Peaceful crowds win their party sympathy and cost the government approval; force against a peaceful crowd doubles the sympathy and multiplies the approval loss; rioting costs the party support.'));
    box.appendChild(el('div.btn-row',
      el('button.solid-btn', { onclick: async () => {
        try { await PATCH('/api/gm/settings', { war: { protest: d } }); this._rulesDraft = null; toast('Protest rules saved.'); }
        catch (e) { toast(e.message, true); }
      } }, 'Save rules'),
      el('button.dash-btn', { onclick: () => { this._rulesDraft = null; this._reRenderPanel(); } }, 'Revert')));
    inner.appendChild(box);
  },

  // GM side of player petitions: approve (choosing where police deploy —
  // defaults to the capital) or deny with a note the applicant will read.
  _appDecision: {},
  renderApplicationQueue(inner) {
    const pending = (S().protestApplications || []).filter(a => a.status === 'pending');
    if (!pending.length) return;
    inner.appendChild(Views.secLabel(`Protest Applications (${pending.length})`));
    const busy = !!(S().protest && S().protest.active);
    if (busy) inner.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'A protest is already underway — end it before approving another.'));
    const cities = S().cities || [];
    const cap = cities.find(c => c.isCapital) || cities[0];
    for (const a of pending) {
      const dec = this._appDecision[a.id] = this._appDecision[a.id] ||
        { policeCities: cap && !a.baseCities.includes(cap.id) ? [cap.id] : [], note: '' };
      const box = el('div.war-app');
      box.appendChild(el('div', el('b', a.name), ' · ', entName(a.organizerId), ` · filed by ${a.filedBy || '—'} · T${a.turn}`));
      box.appendChild(el('div', { style: 'font-size:12px;' },
        `Rally in ${a.baseCities.map(id => (cityById(id) || {}).name || id).join(', ')} · ${a.crowds} crowd(s) of ${fmtNum(a.perCity)} per city`));
      if (a.demands) box.appendChild(el('div.war-demands', '“' + a.demands + '”'));
      box.appendChild(Forms.field('Post police to', this._cityChips(cities.filter(c => !a.baseCities.includes(c.id)),
        (cid) => dec.policeCities.includes(cid) ? 'police' : '',
        (cid) => { dec.policeCities = dec.policeCities.includes(cid) ? dec.policeCities.filter(id => id !== cid) : [...dec.policeCities, cid]; })));
      box.appendChild(Forms.field('Note to the applicant (optional)', Forms.text(dec, 'note')));
      box.appendChild(el('div.btn-row',
        el('button.solid-btn', { disabled: busy ? 'disabled' : undefined, onclick: async () => {
          try { await POST('/api/gm/protest/applications/' + a.id + '/approve', dec); toast('Approved — the crowds take to the streets.'); }
          catch (e) { toast(e.message, true); }
        } }, '✓ Approve & start'),
        el('button.danger-btn', { onclick: async () => {
          try { await POST('/api/gm/protest/applications/' + a.id + '/deny', { note: dec.note }); toast('Application denied.'); }
          catch (e) { toast(e.message, true); }
        } }, '✕ Deny')));
      inner.appendChild(box);
    }
  },

  // GM tuning for an active protest — violence damage, strike economic impact,
  // civilian casualties and refugee scale (see server/war.js setProtestTuning).
  // The sliders bind to a PERSISTENT draft (_protestTuneDraft, same pattern as
  // the treaty desk's _treatyDraft): seeded from the authoritative doc once per
  // protest and reused across re-renders, so an intervening sync (heartbeat
  // tick, another player, the toolbar's 1s loop) rebuilding the panel can't
  // snap a slider back to a not-yet-committed server value mid-edit — the
  // debounced POST confirms it in the background and the slider never waits.
  _protestTuneTimers: {},
  _protestTuneDraft: null, // { id, t, mods } of the protest currently being tuned
  renderProtestTuning(inner, war, key) {
    inner.appendChild(Views.secLabel('Protest Tuning'));
    const pid = war.startedAt || war.id || 'protest';
    let d = this._protestTuneDraft;
    if (!d || d.id !== pid) {
      const tun = (war.protest || {}).tuning || {};
      d = this._protestTuneDraft = {
        id: pid,
        t: Object.assign({ strikeFrac: 0.5, civFrac: 0.6, refugeeFrac: 0.04, refugeeEvery: 4, policeMult: 3, armyResolve: 4 }, tun),
        mods: Object.assign({ dmg: 1, hp: 1 }, war.mods || {}),
        // strikeFrac shown on a 0–100 scale in the number box; converted back to a fraction on post.
        pct: { strikeFrac: Math.round((tun.strikeFrac !== undefined ? tun.strikeFrac : 0.5) * 100) }
      };
    }
    const box = el('div');
    const post = (patch) => {
      POST('/api/gm/protest/tuning', Object.assign({}, patch, { conflict: key }))
        .catch(e => toast(e.message, true));
    };
    const debounced = (field, value) => {
      clearTimeout(this._protestTuneTimers[field]);
      this._protestTuneTimers[field] = setTimeout(() => post({ [field]: value }), 300);
    };
    // Sliders write straight into the persistent draft (Forms.sliderNum mutates
    // obj[key] on input), so a re-render reseeds them from the user's own
    // value — never from stale server state. Each slider also carries a number
    // box that accepts any value (allowBeyondRange) — the server clamps to
    // sane bounds on save.
    const sl = (field, obj, key, min, max, step, suffix, onInput) =>
      Forms.field(field, Forms.sliderNum(obj, key, min, max, {
        step, suffix, allowBeyondRange: true, onInput
      }));
    box.appendChild(sl('Violence damage ×', d.mods, 'dmg', 0.1, 5, 0.1, '×', (v) => debounced('dmg', v)));
    box.appendChild(sl('Unit HP ×', d.mods, 'hp', 0.1, 5, 0.1, '×', (v) => debounced('hp', v)));
    box.appendChild(sl('Police dispersal power ×', d.t, 'policeMult', 0.1, 10, 0.1, '×', (v) => debounced('policeMult', v)));
    box.appendChild(sl('Army resolve vs crowds ×', d.t, 'armyResolve', 1, 20, 0.5, '×', (v) => debounced('armyResolve', v)));
    box.appendChild(sl('Aircraft bombing damage ×', d.mods, 'bombDmg', 0.1, 5, 0.1, '×', (v) => debounced('bombDmg', v)));
    box.appendChild(sl('Strike output drop (0–100%)', d.pct, 'strikeFrac', 0, 100, 1, '%', (v) => debounced('strikeFrac', v / 100)));
    box.appendChild(sl('Civilian deaths per fight tick (×)', d.t, 'civFrac', 0, 10, 0.1, '×', (v) => debounced('civFrac', v)));
    box.appendChild(sl('Fleeing civilians fraction', d.t, 'refugeeFrac', 0, 0.5, 0.01, '', (v) => debounced('refugeeFrac', v)));
    box.appendChild(sl('Refugee wave every N ticks', d.t, 'refugeeEvery', 2, 12, 1, ' ticks', (v) => debounced('refugeeEvery', v)));
    inner.appendChild(box);
    inner.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px;' },
      'Strike output: production in cities touched by the crowds is reduced by up to this fraction.'));
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
    const mods = Object.assign({ dmg: 1, bombDmg: 1, hp: 1, warshipSpeed: 1 }, war.mods || {});
    const box = el('div');
    box.appendChild(this._tuningRow('Combat damage ×', mods, 'dmg'));
    box.appendChild(this._tuningRow('Bomb damage ×', mods, 'bombDmg'));
    box.appendChild(this._tuningRow('Unit HP ×', mods, 'hp'));
    box.appendChild(this._tuningRow('Warship speed ×', mods, 'warshipSpeed'));
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
