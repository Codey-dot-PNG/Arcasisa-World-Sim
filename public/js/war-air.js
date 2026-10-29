'use strict';
/* The air force on the war map — loaded after war.js and war-map.js and
   folded into the War object. The simulation is the shared engine's
   (war-engine.js stepAir: squadrons, fuel, dogfights, ground fire); this file
   only draws it and sends orders (POST /api/war/air):

     · airfields — a runway mark per base with its ready / rearming planes;
     · squadrons in flight — a finger-four of jets with contrails, turned to
       their heading and glided between ticks (_airFrame, from the rAF loop),
       a label with the planes left and a fuel gauge; patrol circles and
       strike runs for the side you command (the GM sees both); tracers where
       squadrons dogfight, flak puffs where ground fire reaches them;
     · the AIR WING dock (#war-air-dock) — every squadron of your wing with
       its state, a fuel / rearm bar and live countdowns, the fuel stock and
       the automatic (air staff) switch;
     · the MISSION PLANNER — pick Patrol or Strike, then the map shows the
       base's range ring and, under the cursor, the distance, time out and
       time over the target that fuel allows (or why it can't go); a click
       sends the order.
   Times are real seconds at the conflict's current speed. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const a in attrs) if (attrs[a] !== undefined && attrs[a] !== null) n.setAttribute(a, attrs[a]);
    if (parent) parent.appendChild(n);
    return n;
  };
  const AIRBORNE = { out: 1, station: 1, return: 1 };
  const STATE_LABEL = { ready: 'Ready', out: 'Airborne', station: 'On patrol', return: 'Returning', rearm: 'Rearming', lost: 'Lost' };
  // a top-down jet, nose along +x, ~23 px long
  const JET = 'M11.5,0 L5,-1.7 L1.2,-1.9 L-2,-9 L-4.8,-9 L-3.6,-1.9 L-8.2,-1.5 L-10.6,-4.4 L-12.2,-4.4 L-11,0 L-12.2,4.4 L-10.6,4.4 L-8.2,1.5 L-3.6,1.9 L-4.8,9 L-2,9 L1.2,1.9 L5,1.7 Z';
  // finger-four (and two more) — leader at the front, wingmen staggered back
  const SLOTS = [[0, 0], [-15, -16], [-15, 16], [-30, 32], [-30, -32], [-45, 0]];
  const eng = () => window.WarEngine || {};

  Object.assign(War, {
    /* ---------- who flies what ---------- */
    airSidesFor(war) {
      if (!war || !war.air) return [];
      const ca = this.access(war);
      const out = [];
      if (ca.air) out.push('def');
      if (war.kind !== 'protest' && (ca.att || ca.attLead)) out.push('att');
      return out;
    },
    // the wing the dock shows: the GM's command side, else the one you fly
    _airSide(war) {
      const sides = this.airSidesFor(war);
      if (!sides.length) return null;
      if (isGM() && sides.includes(this._gmSide)) return this._gmSide;
      return sides[0];
    },
    _airSideName(war, side) {
      if (war.kind === 'protest') return side === 'def' ? 'Security forces' : 'Crowds';
      return entName(side === 'att' ? war.attackerId : war.defenderId) || (side === 'att' ? 'Invader' : 'Defence');
    },
    _tickFrac(war) {
      if (!war || war.paused || !war.active) return 0;
      const interval = Math.max(200, (war.tickMs || 2000) / (war.speed || 1));
      return Math.max(0, Math.min(1, (Date.now() - (war._lastTick || Date.now())) / interval));
    },
    // live numbers for one squadron: fuel / rearm countdowns in real seconds
    _sqInfo(war, sq) {
      const secs = this._tickSeconds(war), f = this._tickFrac(war);
      const rearmTicks = eng().AIR_REARM_TICKS || 60;
      if (AIRBORNE[sq.state]) {
        const left = Math.max(0, (sq.fuel || 0) - f);
        return { bar: left / (sq.endurance || 1), secs: left * secs, kind: 'fuel', low: left <= 4 };
      }
      if (sq.state === 'rearm') {
        const left = Math.max(0, (sq.readyTick || 0) - war.tick - f);
        return { bar: 1 - left / rearmTicks, secs: left * secs, kind: 'rearm' };
      }
      return { bar: sq.state === 'ready' ? 1 : 0, secs: 0, kind: sq.state };
    },
    _airBase(war, sq) { return ((war.air && war.air.bases) || []).find(b => b.id === sq.baseId) || null; },

    /* ---------- the map ---------- */
    renderAir(map, NS_, war, D, key) {
      const air = war.air;
      this._sqNodes = this._sqNodes || new Map();
      this._sqAnim = this._sqAnim || {};
      if (!D.air._parts || !D.air._parts.bases.isConnected) {
        clear(D.air);
        D.air._parts = { bases: sv('g', { class: 'war-air-bases' }, D.air), mis: sv('g', { class: 'war-air-missions' }, D.air), sqs: sv('g', { class: 'war-air-sqs' }, D.air) };
        this._airDefs();
      }
      const P = D.air._parts;
      const seen = new Set();
      if (air && Array.isArray(air.squadrons)) {
        const side = this.commandableSide(war);
        const omni = isGM();
        // --- airfields: runway, name once zoomed, ready / rearming planes
        const ready = {}, rearm = {};
        for (const sq of air.squadrons) {
          if (sq.planes <= 0) continue;
          if (sq.state === 'ready') ready[sq.baseId] = (ready[sq.baseId] || 0) + sq.planes;
          if (sq.state === 'rearm') rearm[sq.baseId] = (rearm[sq.baseId] || 0) + sq.planes;
        }
        const bk = (air.bases || []).map(b => [b.id, b.pos.join(','), ready[b.id] || 0, rearm[b.id] || 0].join(':')).join('|');
        if (P._bk !== bk) {
          P._bk = bk;
          clear(P.bases);
          for (const b of air.bases || []) {
            const g = this._scaledGroup(NS, P.bases, b.pos, 'war-airfield war-airfield-' + b.side);
            sv('path', { d: 'M-15,4 L11,-11 L15,-4 L-11,11 Z', class: 'war-airfield-strip' }, g);
            sv('path', { d: 'M-9,4.5 L-3,1 M1,-1.4 L7,-4.9', class: 'war-airfield-dash' }, g);
            const n = ready[b.id] || 0, r = rearm[b.id] || 0;
            if (n || r) {
              const txt = (n ? '✈' + n : '') + (n && r ? ' ' : '') + (r ? '⟳' + r : '');
              sv('rect', { x: 11, y: -24, width: (txt.length * 6.2 + 8).toFixed(0), height: 13, rx: 6.5, class: 'war-airfield-badge' }, g);
              sv('text', { x: 15, y: -14.4, class: 'war-airfield-count' }, g).textContent = txt;
            }
            sv('text', { y: 24, 'text-anchor': 'middle', class: 'war-airfield-name' }, g).textContent = b.name;
            sv('title', {}, g).textContent = `${b.name} — ${this._airSideName(war, b.side)} airfield` + (n ? ` · ${n} plane${n === 1 ? '' : 's'} ready` : '') + (r ? ` · ${r} rearming` : '');
          }
        }
        // --- missions (own side; the GM sees both) + dogfight / flak FX
        clear(P.mis);
        const k = (GameMap.view && GameMap.view.k) || 1;
        for (const sq of air.squadrons) {
          if (sq.planes <= 0 || !AIRBORNE[sq.state]) continue;
          const mine = sq.side === side;
          const m = sq.mission;
          if (m && (mine || omni) && sq.state !== 'return') {
            if (m.kind === 'patrol') {
              sv('circle', { cx: m.target[0], cy: m.target[1], r: m.radius, class: 'war-cap war-cap-' + sq.side + (mine ? '' : ' war-cap-foe'), 'vector-effect': 'non-scaling-stroke' }, P.mis);
              const g = this._scaledGroup(NS, P.mis, [m.target[0], m.target[1] - m.radius], 'war-cap-tag war-cap-tag-' + sq.side);
              sv('text', { y: -4, 'text-anchor': 'middle' }, g).textContent = 'CAP · ' + sq.name.replace(' Squadron', ' Sqn');
            } else {
              sv('path', { d: `M${sq.pos[0].toFixed(1)} ${sq.pos[1].toFixed(1)} L${m.target[0]} ${m.target[1]}`, class: 'war-strike-run war-strike-run-' + sq.side, 'vector-effect': 'non-scaling-stroke' }, P.mis);
              const g = this._scaledGroup(NS, P.mis, m.target, 'war-reticle war-reticle-' + sq.side);
              sv('circle', { r: 11 }, g);
              sv('path', { d: 'M-17,0 H-6 M6,0 H17 M0,-17 V-6 M0,6 V17' }, g);
              sv('title', {}, g).textContent = `${sq.name} strike target · ${this.gridRef(m.target)}`;
            }
          }
          if ((sq.dogfightTick || -9) >= war.tick - 1) {
            let foe = null, fd = Infinity;
            for (const e of air.squadrons) {
              if (e.side === sq.side || e.planes <= 0 || !AIRBORNE[e.state]) continue;
              const d = Math.hypot(e.pos[0] - sq.pos[0], e.pos[1] - sq.pos[1]);
              if (d < fd) { fd = d; foe = e; }
            }
            if (foe && fd < 120) {
              sv('path', { d: `M${sq.pos[0]} ${sq.pos[1]} L${foe.pos[0]} ${foe.pos[1]}`, class: 'war-tracer', 'vector-effect': 'non-scaling-stroke' }, P.mis);
              const mid = [(sq.pos[0] + foe.pos[0]) / 2, (sq.pos[1] + foe.pos[1]) / 2];
              const g = this._scaledGroup(NS, P.mis, mid, 'war-dogfight');
              sv('path', { d: 'M0,-12 L3,-3 L12,0 L3,3 L0,12 L-3,3 L-12,0 L-3,-3 Z' }, g);
              sv('title', {}, g).textContent = `Dogfight — ${sq.name} and ${foe.name}`;
            }
          }
          if ((sq.flakTick || -9) >= war.tick - 1) {
            const h = sq.id.length * 7;
            for (let i = 0; i < 4; i++) {
              const a = (h + i * 97) % 360 * Math.PI / 180, r = (14 + (i * 9) % 18) / Math.max(0.6, k / 2);
              sv('circle', { cx: (sq.pos[0] + Math.cos(a) * r).toFixed(1), cy: (sq.pos[1] + Math.sin(a) * r).toFixed(1), r: (3 + i % 2) / Math.max(0.6, k / 2), class: 'war-flak' }, P.mis);
            }
          }
        }
        // --- squadrons in flight (keyed nodes, glided by _airFrame)
        for (const sq of air.squadrons) {
          if (sq.planes <= 0 || !AIRBORNE[sq.state]) continue;
          const kk = key + ':' + sq.id;
          seen.add(kk);
          let rec = this._sqNodes.get(kk);
          if (!rec) {
            const g = sv('g', { 'data-sq': kk });
            const rot = sv('g', { class: 'war-sq-rot' }, g);
            const trails = sv('g', { class: 'war-sq-trails' }, rot);
            const jets = sv('g', { class: 'war-sq-jets' }, rot);
            const label = sv('g', { class: 'war-sq-label' }, g);
            const lbBg = sv('rect', { x: -26, y: 14, width: 52, height: 17, rx: 2, class: 'war-sq-label-bg' }, label);
            const lbText = sv('text', { y: 23.5, 'text-anchor': 'middle', class: 'war-sq-label-text' }, label);
            sv('rect', { x: -22, y: 26.5, width: 44, height: 2.4, class: 'war-sq-fuel-bg' }, label);
            const fuel = sv('rect', { x: -22, y: 26.5, width: 44, height: 2.4, class: 'war-sq-fuel' }, label);
            const title = sv('title', {}, g);
            rec = { g, rot, trails, jets, lbBg, lbText, fuel, title, v: {} };
            g.addEventListener('pointerup', (e) => {
              if (e.button !== 0 || GameMap.lastDragMoved) return;
              e.stopPropagation();
              this._airSel = rec.sqId;
              W.warAirDock = true;
              this.renderAirDock(true);
            });
            this._sqNodes.set(kk, rec);
          }
          if (rec.g.parentNode !== P.sqs) P.sqs.appendChild(rec.g);
          rec.sqId = sq.id;
          const v = rec.v;
          const n = Math.min(SLOTS.length, sq.planes);
          if (v.n !== n) {
            v.n = n;
            clear(rec.jets); clear(rec.trails);
            for (let i = 0; i < n; i++) {
              const [sx, sy] = SLOTS[i];
              sv('path', { d: `M${sx - 11} ${sy} H${sx - 52}`, class: 'war-contrail' }, rec.trails);
              sv('path', { d: JET, transform: `translate(${sx},${sy})`, class: 'war-jet' }, rec.jets);
            }
          }
          const info = this._sqInfo(war, sq);
          const mine = sq.side === side;
          const cls = 'war-sq war-sq-' + sq.side + (mine ? ' war-sq-own' : '') + (info.low ? ' war-sq-low' : '') +
            ((sq.dogfightTick || -9) >= war.tick - 1 ? ' war-sq-fight' : '') + (this._airSel === sq.id ? ' war-sq-sel' : '');
          if (v.cls !== cls) { v.cls = cls; rec.g.setAttribute('class', cls); }
          const lt = `${sq.name.replace(' Squadron', ' Sqn')} · ${sq.planes}`;
          if (v.lt !== lt) { v.lt = lt; rec.lbText.textContent = lt; rec.lbBg.setAttribute('width', (lt.length * 5.6 + 10).toFixed(0)); rec.lbBg.setAttribute('x', (-(lt.length * 5.6 + 10) / 2).toFixed(0)); }
          const tip = `${sq.name} (${this._airSideName(war, sq.side)}) — ${sq.planes} × ${sq.modelName || 'aircraft'} · ${STATE_LABEL[sq.state] || sq.state}` +
            (sq.mission ? ` · ${sq.mission.kind} at ${this.gridRef(sq.mission.target)}` : '') + ` · ${sq.kills || 0} kills, ${sq.losses || 0} lost`;
          if (v.tip !== tip) { v.tip = tip; rec.title.textContent = tip; }
          this._sqAnim[kk] = { rec, sq, war };
        }
      }
      for (const [kk, rec] of this._sqNodes) {
        if (kk.startsWith(key + ':') && !seen.has(kk)) { rec.g.remove(); this._sqNodes.delete(kk); delete this._sqAnim[kk]; }
      }
    },
    _airDefs() {
      const root = this._O && this._O.root;
      if (!root || root.querySelector('#war-contrail-grad')) return;
      const defs = root.querySelector('defs') || sv('defs', {}, root);
      const lg = sv('linearGradient', { id: 'war-contrail-grad', gradientUnits: 'userSpaceOnUse', x1: -11, y1: 0, x2: -95, y2: 0 }, defs);
      sv('stop', { offset: 0, 'stop-color': '#fbf7ee', 'stop-opacity': 0.95 }, lg);
      sv('stop', { offset: 1, 'stop-color': '#fbf7ee', 'stop-opacity': 0 }, lg);
    },
    // per frame: glide each squadron between its last two tick positions
    _airFrame() {
      const anim = this._sqAnim;
      if (!anim) return false;
      let any = false;
      const scale = warMarkerScale(GameMap.view ? GameMap.view.k : 1);
      for (const kk in anim) {
        const a = anim[kk];
        if (!a.rec.g.isConnected) { delete anim[kk]; continue; }
        any = true;
        const sq = a.sq, f = this._tickFrac(a.war);
        const p0 = sq.prevPos || sq.pos, p1 = sq.pos;
        const x = p0[0] + (p1[0] - p0[0]) * f, y = p0[1] + (p1[1] - p0[1]) * f;
        const moved = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) > 0.5;
        const hdg = moved ? Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) * 180 / Math.PI : (sq.heading || 0);
        const tf = `translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${scale})`;
        if (a.rec.v.tf !== tf) { a.rec.v.tf = tf; a.rec.g.setAttribute('transform', tf); }
        const rt = `rotate(${hdg.toFixed(0)}) scale(0.8)`;
        if (a.rec.v.rt !== rt) { a.rec.v.rt = rt; a.rec.rot.setAttribute('transform', rt); }
        const info = this._sqInfo(a.war, sq);
        const fw = (44 * Math.max(0, Math.min(1, info.bar))).toFixed(1);
        if (a.rec.v.fw !== fw) { a.rec.v.fw = fw; a.rec.fuel.setAttribute('width', fw); }
      }
      return any;
    },

    /* ---------- the air wing dock ---------- */
    _removeAirDock() {
      const d = document.getElementById('war-air-dock');
      if (d) d.remove();
      this._airDockSig = null;
    },
    renderAirDock(force) {
      const wrap = document.getElementById('map-wrap');
      const auth = this.activeAuth();
      const war = auth && ((window.WarEngine && this.predictedDoc(auth)) || auth);
      const side = war && war.active && this._airSide(war);
      if (!wrap || !war || !side || !W.warAirDock) { this._removeAirDock(); return; }
      const key = this.docKeyOf(auth);
      const air = war.air;
      const sqs = air.squadrons.filter(s => s.side === side && (s.planes > 0 || s.losses));
      const sig = [key, side, W.warAirDock, this._airSel, this._airPlan && (this._airPlan.sqId + this._airPlan.kind), !!(air.auto || {})[side],
        Math.round((air.fuel || {})[side] || 0), sqs.map(s => [s.id, s.planes, s.state, s.mission && s.mission.kind].join(':')).join('|'),
        isGM() && this._gmSide, war.kind === 'protest' && !!(war.protest || {}).govViolent].join('#');
      const old = document.getElementById('war-air-dock');
      if (!force && old && old.isConnected && this._airDockSig === sig) { this._patchAirDock(old, war); return; }
      this._airDockSig = sig;
      if (old) old.remove();
      const dock = el('div#war-air-dock.war-air-dock', { class: this._airPlan ? 'planning' : '' });
      const grounded = war.kind === 'protest' && !(war.protest || {}).govViolent;
      const per = air.fuelPerPlane || 10;
      const fuel = (air.fuel || {})[side] || 0;
      // head: whose wing, (GM) switch, close
      const sides = this.airSidesFor(war);
      dock.appendChild(el('div.air-head',
        el('span.air-title', '✈ Air wing'),
        sides.length > 1 ? el('div.seg', sides.slice().sort().reverse().map(s => el('button', {
          class: s === side ? 'active' : '', onclick: () => { this._gmSide = s; this._sel.clear(); this._airPlan = null; this._airPlanClear(); this.refreshLayer(true); this.renderAirDock(true); }
        }, war.kind === 'protest' ? 'Police' : s === 'def' ? 'Defence' : 'Invader'))) : el('span.air-side', this._airSideName(war, side)),
        el('button.air-close', { title: 'Close', onclick: () => { W.warAirDock = false; this._airPlan = null; this._airPlanClear(); this._removeAirDock(); this.renderToolbar(); } }, '×')));
      const sortieNeed = Math.max(...sqs.filter(s => s.planes > 0).map(s => s.planes), 0) * per;
      dock.appendChild(el('div.air-meta',
        el('span.air-fuel', { class: fuel < sortieNeed ? 'short' : '', title: 'Refined fuel in this side\'s stockpiles — every sortie fills the tanks' },
          '⛽ ' + Math.floor(fuel).toLocaleString('en-US') + ' bbl', el('span.air-faint', ` · ${per} per plane per sortie`)),
        war.kind === 'protest' ? null : el('label.air-auto', { title: 'Hand the wing to the air staff: they keep a patrol over your forces and strike the heaviest enemy concentrations in range.' },
          el('input', { type: 'checkbox', checked: (air.auto || {})[side] ? 'checked' : undefined,
            onchange: async (e) => {
              try { await POST('/api/war/air/auto', { conflict: key, side, on: e.target.checked }); toast(e.target.checked ? 'The air staff takes over the wing.' : 'The wing flies on your orders.'); }
              catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; }
            } }), 'Auto')));
      if (grounded) dock.appendChild(el('div.air-warn', 'Grounded — force has not been authorized against the protest.'));
      else if (fuel < per) dock.appendChild(el('div.air-warn', 'No refined fuel — the wing cannot take off. Buy or move Refined Fuel into your stockpile.'));
      if ((air.auto || {})[side]) dock.appendChild(el('div.air-note', 'The air staff is flying this wing. Orders you give still go out.'));
      const list = el('div.air-list');
      if (!sqs.length) list.appendChild(el('div.air-empty', 'No aircraft. Military aircraft in this side\'s stockpiles form squadrons automatically.'));
      for (const sq of sqs) list.appendChild(this._airRow(war, key, sq, grounded, fuel, per));
      dock.appendChild(list);
      dock.appendChild(el('div.air-foot', `Tanks hold ${this.fmtDur(((sqs[0] || {}).endurance || 15) * this._tickSeconds(war))} of flight — the farther the target, the less time over it · ${this.fmtDur((eng().AIR_REARM_TICKS || 60) * this._tickSeconds(war))} to refuel and rearm after landing.`));
      wrap.appendChild(dock);
      this._patchAirDock(dock, war);
    },
    // desktop: the dock stacks under the situation HUD and ends above the
    // toolbar (phones: a full-width sheet, CSS)
    _placeAirDock(dock) {
      const wrap = document.getElementById('map-wrap');
      if (!wrap || window.innerWidth <= 640) { dock.style.top = dock.style.maxHeight = dock.style.bottom = ''; return; }
      const hud = document.getElementById('war-hud');
      const tb = document.getElementById('war-toolbar');
      const top = hud ? hud.offsetTop + hud.offsetHeight + 8 : 66;
      let limit = wrap.clientHeight - 30;
      if (tb) {
        const tl = tb.offsetLeft, tr = tl + tb.offsetWidth;
        if (tl < dock.offsetLeft + dock.offsetWidth && tr > dock.offsetLeft) limit = Math.min(limit, tb.offsetTop - 8);
      }
      dock.style.top = top + 'px';
      dock.style.bottom = 'auto';
      dock.style.maxHeight = Math.max(140, limit - top) + 'px';
    },
    _airRow(war, key, sq, grounded, fuel, per) {
      const base = this._airBase(war, sq);
      const lost = sq.planes <= 0;
      const row = el('div.air-row', { 'data-sq': sq.id, class: (this._airSel === sq.id ? 'sel ' : '') + 'st-' + sq.state,
        onmouseenter: () => { if (!this._airPlan) this._airPreviewRange(war, sq); },
        onmouseleave: () => { if (!this._airPlan) this._airPlanClear(); },
        onclick: (e) => { if (e.target.closest('button')) return; this._airSel = this._airSel === sq.id ? null : sq.id; this.renderAirDock(true); this.refreshLayer(true);
          if (AIRBORNE[sq.state] && GameMap.focus) GameMap.focus(sq.pos, Math.max(GameMap.view.k, 1.4)); } });
      const planes = el('span.air-planes', { title: `${sq.planes} × ${sq.modelName || 'aircraft'}` });
      for (let i = 0; i < Math.max(sq.planes, 1) && i < 6; i++) planes.appendChild(el('span.air-plane' + (i < sq.planes ? '' : '.gone'), '✈'));
      if (sq.planes > 6) planes.appendChild(el('span.air-faint', '+' + (sq.planes - 6)));
      row.appendChild(el('div.air-row-top',
        el('span.air-name', sq.name), planes, el('span.air-state', { 'data-state': sq.state }, STATE_LABEL[sq.state] || sq.state)));
      const mission = sq.mission ? ` · ${sq.mission.kind === 'patrol' ? 'patrol' : 'strike'} at ${this.gridRef(sq.mission.target)}` : '';
      row.appendChild(el('div.air-row-sub', (base ? base.name : 'no airfield') + ' · ' + (sq.modelName || 'aircraft') + mission +
        ((sq.kills || sq.losses) ? ` · ${sq.kills || 0} down / ${sq.losses || 0} lost` : '')));
      if (!lost) row.appendChild(el('div.air-bar', el('div.air-bar-fill')));
      const acts = el('div.air-row-act');
      const need = sq.planes * per;
      const canLaunch = sq.state === 'ready' && !grounded && fuel >= need && !!base;
      const arm = (kind) => el('button.btn-xs', {
        class: this._airPlan && this._airPlan.sqId === sq.id && this._airPlan.kind === kind ? 'solid-btn active' : 'dash-btn',
        title: kind === 'patrol' ? 'Fly a patrol: defend an area against enemy aircraft' : 'Bomb a target: one bomb per plane, then home',
        onclick: () => this._airPlanArm(key, sq.id, kind)
      }, kind === 'patrol' ? '◯ Patrol' : '✕ Strike');
      if (lost) acts.appendChild(el('span.air-faint', 'Squadron lost'));
      else if (sq.state === 'ready') {
        if (canLaunch) { acts.appendChild(arm('patrol')); acts.appendChild(arm('strike')); }
        else acts.appendChild(el('span.air-faint', grounded ? 'Grounded' : !base ? 'No airfield' : `Needs ${need} bbl to fly`));
      } else if (AIRBORNE[sq.state]) {
        if (!grounded) { acts.appendChild(arm('patrol')); acts.appendChild(arm('strike')); }
        if (sq.state !== 'return') acts.appendChild(el('button.dash-btn.btn-xs', { title: 'Break off and fly home', onclick: () => this._airOrder(key, sq, { kind: 'recall' }) }, '↩ Recall'));
      }
      row.appendChild(acts);
      return row;
    },
    // once a second: countdowns and bars, in place (no rebuild under a tap)
    _patchAirDock(dock, war) {
      this._placeAirDock(dock);
      const air = war.air || {};
      for (const row of dock.querySelectorAll('.air-row')) {
        const sq = (air.squadrons || []).find(s => s.id === row.getAttribute('data-sq'));
        if (!sq) continue;
        const info = this._sqInfo(war, sq);
        const st = row.querySelector('.air-state');
        const txt = (STATE_LABEL[sq.state] || sq.state) + (info.kind === 'fuel' ? ' · ⛽ ' + this.fmtDur(info.secs) : info.kind === 'rearm' ? ' · ' + this.fmtDur(info.secs) : '');
        if (st && st.textContent !== txt) st.textContent = txt;
        const fill = row.querySelector('.air-bar-fill');
        if (fill) {
          fill.style.width = (Math.max(0, Math.min(1, info.bar)) * 100).toFixed(1) + '%';
          fill.className = 'air-bar-fill ' + (info.kind === 'fuel' ? (info.low ? 'low' : 'fuel') : info.kind === 'rearm' ? 'rearm' : 'full');
        }
      }
    },
    async _airOrder(key, sq, order) {
      try {
        await POST('/api/war/air', Object.assign({ conflict: key, squadronId: sq.id }, order));
        // fly it in the local prediction now (and keep it there until a
        // snapshot reflects it — the air outbox in War._rebase)
        const auth = this.authDocs().find(d => this.docKeyOf(d) === key);
        const pred = auth && window.WarEngine && this.predictedDoc(auth);
        const psq = pred && ((pred.air || {}).squadrons || []).find(x => x.id === sq.id);
        if (psq) psq.order = JSON.parse(JSON.stringify(order));
        const st = this._preds[key];
        if (st) (st.airOutbox = st.airOutbox || []).push({ sqId: sq.id, order: JSON.parse(JSON.stringify(order)), exp: Date.now() + 8000 });
        toast(order.kind === 'recall' ? `${sq.name} turns for home.` : `${sq.name} — ${order.kind === 'patrol' ? 'patrol' : 'strike'} ordered at ${this.gridRef(order.target)}.`);
      } catch (e) { toast(e.message, true); }
    },

    /* ---------- the mission planner ---------- */
    _airPlanArm(key, sqId, kind) {
      if (this._airPlan && this._airPlan.sqId === sqId && this._airPlan.kind === kind) { this._airPlan = null; this._airPlanClear(); }
      else { this._airPlan = { key, sqId, kind, radius: (eng().AIR_PATROL_R || 200) }; this._tool = null; this._measure = null; if (this._drawMeasure) this._drawMeasure(); this._airSel = sqId; }
      this.renderAirDock(true);
      this.renderToolbar();
      const war = this._airPlanWar();
      const sq = war && war.air.squadrons.find(s => s.id === sqId);
      if (this._airPlan && sq) this._airPreviewRange(war, sq);
    },
    _airPlanWar() {
      const auth = this.authDocs().find(d => this._airPlan && this.docKeyOf(d) === this._airPlan.key);
      return auth && ((window.WarEngine && this.predictedDoc(auth)) || auth);
    },
    _planLayer() {
      const host = this._O && this._O.air;
      if (!host) return null;
      if (!this._planG || !this._planG.isConnected) this._planG = sv('g', { class: 'war-air-plan' }, host);
      return this._planG;
    },
    _airPlanClear() { const g = this._planLayer(); if (g) clear(g); },
    // the range ring of a squadron's base (what it can reach from there)
    _airPreviewRange(war, sq, keep) {
      const g = this._planLayer();
      if (!g) return null;
      if (!keep) clear(g);
      const base = this._airBase(war, sq);
      if (!base || !eng().airRange) return null;
      const R = eng().airRange(sq);
      sv('circle', { cx: base.pos[0], cy: base.pos[1], r: R.toFixed(1), class: 'war-range-ring war-air-range war-air-range-' + sq.side, 'vector-effect': 'non-scaling-stroke' }, g);
      const tag = this._screenGroup(g, [base.pos[0], base.pos[1] - R], 'war-air-range-tag');
      sv('text', { y: -5, 'text-anchor': 'middle' }, tag).textContent = `${sq.name} range · ${this.fmtKm(R * this.kmPerPx())} from ${base.name}`;
      return { base, R };
    },
    // what a sortie to `target` would look like: reach, time out, time over
    _airEstimate(war, sq, target) {
      const E = eng();
      const secs = this._tickSeconds(war);
      const base = this._airBase(war, sq);
      if (!base) return { ok: false, why: 'No airfield to fly from.' };
      const speed = sq.speed || 200;
      if (AIRBORNE[sq.state]) {
        const out = Math.hypot(target[0] - sq.pos[0], target[1] - sq.pos[1]) / speed;
        const home = Math.hypot(target[0] - base.pos[0], target[1] - base.pos[1]) / speed;
        const over = (sq.fuel || 0) - Math.ceil(out) - Math.ceil(home) - 1;
        return { ok: over >= 0, why: over >= 0 ? '' : 'Not enough fuel left — it would have to turn back.', out: out * secs, over: Math.max(0, over) * secs, from: sq.pos, km: Math.hypot(target[0] - sq.pos[0], target[1] - sq.pos[1]) * this.kmPerPx() };
      }
      const d = Math.hypot(target[0] - base.pos[0], target[1] - base.pos[1]);
      const R = E.airRange ? E.airRange(sq) : Infinity;
      const outT = Math.ceil(d / speed);
      const over = (sq.endurance || 15) - outT - outT - 1;
      return { ok: d <= R + 1, why: d <= R + 1 ? '' : `Out of range — ${this.fmtKm(R * this.kmPerPx())} max from ${base.name}.`, out: outT * secs, over: Math.max(0, over) * secs, from: base.pos, km: d * this.kmPerPx() };
    },
    _airPlanHover(world) {
      const war = this._airPlanWar();
      const plan = this._airPlan;
      const sq = war && war.air.squadrons.find(s => s.id === plan.sqId);
      if (!sq || sq.planes <= 0) { this._airPlan = null; this._airPlanClear(); return; }
      const g = this._planLayer();
      if (!g) return;
      clear(g);
      this._airPreviewRange(war, sq, true);
      const est = this._airEstimate(war, sq, world);
      sv('line', { x1: est.from[0], y1: est.from[1], x2: world[0], y2: world[1], class: 'war-air-plan-line' + (est.ok ? '' : ' bad'), 'vector-effect': 'non-scaling-stroke' }, g);
      if (plan.kind === 'patrol') sv('circle', { cx: world[0], cy: world[1], r: plan.radius, class: 'war-cap war-cap-' + sq.side + ' war-cap-plan' + (est.ok ? '' : ' bad'), 'vector-effect': 'non-scaling-stroke' }, g);
      else {
        const rg = this._scaledGroup(NS, g, world, 'war-reticle war-reticle-' + sq.side + (est.ok ? '' : ' bad'));
        sv('circle', { r: 11 }, rg); sv('path', { d: 'M-17,0 H-6 M6,0 H17 M0,-17 V-6 M0,6 V17' }, rg);
      }
      const rows = [[`${sq.name} · ${plan.kind === 'patrol' ? 'PATROL' : 'STRIKE'} · ${this.gridRef(world)}`, 'big'], [this.fmtKm(est.km)]];
      if (est.ok) rows.push([`out ${this.fmtDur(est.out)} · over target ${this.fmtDur(est.over)}`]);
      else rows.push([est.why, 'bad']);
      rows.push([plan.target ? 'tap ✓ Send — or tap elsewhere to move it' : 'click to send · Esc cancels', 'faint']);
      this._measureCard(g, world, rows, est.ok ? '' : 'bad');
    },
    // Desktop: the hover preview is already up, so a click sends. Touch has
    // no hover — a tap places the target and shows the preview, and the
    // toolbar's ✓ Send confirms (tap elsewhere to move it).
    _airPlanClick(world) {
      if (window.matchMedia && matchMedia('(pointer: coarse)').matches) {
        this._airPlan.target = world;
        this._airPlanHover(world);
        this.renderToolbar();
        return;
      }
      this._airPlanSend(world);
    },
    _airPlanSend(world) {
      const war = this._airPlanWar();
      const plan = this._airPlan;
      if (!plan) return;
      world = world || plan.target;
      if (!world) return;
      const sq = war && war.air.squadrons.find(s => s.id === plan.sqId);
      if (!sq) { this._airPlan = null; this._airPlanClear(); return; }
      const est = this._airEstimate(war, sq, world);
      if (!est.ok && !AIRBORNE[sq.state]) { toast(est.why, true); return; }
      const order = { kind: plan.kind, target: this._clamp(world), radius: plan.kind === 'patrol' ? plan.radius : undefined };
      this._airPlan = null;
      this._airPlanClear();
      this._airOrder(plan.key, sq, order);
      this.renderAirDock(true);
      this.renderToolbar();
    },

    /* ---------- summaries: toolbar badge, HUD row, War Room ---------- */
    airCounts(war, side) {
      const out = { aloft: 0, ready: 0, rearm: 0, planes: 0, lost: ((war.air || {}).lost || {})[side] || 0, sorties: 0, kills: 0 };
      for (const s of ((war.air || {}).squadrons || [])) {
        if (s.side !== side) continue;
        out.sorties += s.sorties || 0; out.kills += s.kills || 0;
        if (s.planes <= 0) continue;
        out.planes += s.planes;
        if (AIRBORNE[s.state]) out.aloft += s.planes; else if (s.state === 'ready') out.ready += s.planes; else if (s.state === 'rearm') out.rearm += s.planes;
      }
      return out;
    },
    airHudText(war) {
      if (!war.air) return null;
      const parts = [];
      for (const side of (war.kind === 'protest' ? ['def'] : ['def', 'att'])) {
        const c = this.airCounts(war, side);
        if (!c.planes && !c.lost) continue;
        parts.push(`${this._airSideName(war, side)}: ${c.aloft} aloft · ${c.ready} ready` + (c.rearm ? ` · ${c.rearm} rearming` : '') + (c.lost ? ` · ${c.lost} lost` : ''));
      }
      return parts.length ? parts.join(' — ') : null;
    },
    renderAirReport(inner, war, key) {
      const air = war.air;
      if (!air || !(air.squadrons || []).length) return;
      inner.appendChild(Views.secLabel('Air war'));
      const sides = war.kind === 'protest' ? ['def'] : ['def', 'att'];
      const can = new Set(war.active ? this.airSidesFor(war) : []);
      for (const side of sides) {
        const c = this.airCounts(war, side);
        if (!c.planes && !c.lost && !c.sorties) continue;
        const name = this._airSideName(war, side);
        inner.appendChild(el('div.air-report-side',
          el('b', name), ' — ', `${c.planes} aircraft (${c.aloft} aloft, ${c.ready} ready, ${c.rearm} rearming)`,
          el('span.air-faint', ` · ${c.sorties} sorties · ${c.kills} shot down · ${c.lost} lost · ⛽ ${Math.floor((air.fuel || {})[side] || 0).toLocaleString('en-US')} bbl`),
          can.has(side) && war.kind !== 'protest' ? el('label.air-auto', { title: 'Let the air staff fly this wing' },
            el('input', { type: 'checkbox', checked: (air.auto || {})[side] ? 'checked' : undefined,
              onchange: async (e) => { try { await POST('/api/war/air/auto', { conflict: key, side, on: e.target.checked }); } catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; } } }), 'Auto') : null));
      }
      const live = (air.squadrons || []).filter(s => s.planes > 0 || s.losses);
      inner.appendChild(Views.ledgerFold('wrAir_' + key, `Squadrons — ${live.filter(s => s.planes > 0).length} flying`, () => el('table.data.war-orbat',
        el('thead', el('tr', el('th', 'Squadron'), el('th', 'Side'), el('th', 'Base'), el('th.num', 'Planes'), el('th', 'State'), el('th.num', 'Sorties'), el('th.num', 'Down / lost'), el('th', ''))),
        el('tbody', live.map(s => { const b = this._airBase(war, s); return el('tr', { class: s.side === 'att' ? 'war-orbat-att' : 'war-orbat-def' },
          el('td', s.name), el('td', this._airSideName(war, s.side)), el('td', b ? b.name : '—'), el('td.num', String(s.planes)),
          el('td', (STATE_LABEL[s.state] || s.state) + (s.mission ? ` · ${s.mission.kind} ${this.gridRef(s.mission.target)}` : '')),
          el('td.num', String(s.sorties || 0)), el('td.num', `${s.kills || 0} / ${s.losses || 0}`),
          el('td', war.active ? el('button.ow-btn.ow-act', { title: 'Show on the map', onclick: () => this.openBattleMap(AIRBORNE[s.state] ? s.pos : (b ? b.pos : s.pos), key) }, '◎') : null)); })))));
      inner.appendChild(el('div.protest-note', `Sorties burn ${air.fuelPerPlane || 10} barrels of refined fuel per plane. A squadron flies about ${this.fmtDur(15 * 2)} at 1× speed — distant targets leave little time over them — then needs ${this.fmtDur(120)} on the ground. Squadrons are lost in dogfights and, rarely, to ground fire.`));
    }
  });
})();
