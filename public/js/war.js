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

const War = {
  _anim: {},        // unitId -> { from:[x,y], to:[x,y], t0, curPos:[x,y], node }
  _flashAnim: {},    // synthetic flash id -> { node, t0, life }
  _raf: null,

  active() { return !!(S() && S().war); },

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
        const scale = 1 / Math.max(1, (GameMap.view ? GameMap.view.k : 1) * 0.85);
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
    if (!war) { this._anim = {}; this._flashAnim = {}; return; }
    map.warLayer = document.createElementNS(NS, 'g');
    map.warLayer.setAttribute('class', 'war-layer');
    map.world.appendChild(map.warLayer);

    this.renderTerritory(map, mk, NS, war);
    this.renderUnits(map, mk, NS, war);
    this.renderFlashes(map, mk, NS, war);
    this.ensureLoop();
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

  // NATO-ish rectangle markers, one per live unit. Position is animated by
  // the shared rAF loop (ensureLoop) — here we only decide the tween's `from`
  // (the last known interpolated position, so a mid-tween re-render never
  // snaps backward) and `to` (this sync's authoritative server position).
  renderUnits(map, mk, NS, war) {
    const liveIds = new Set();
    for (const u of war.units) {
      liveIds.add(u.id);
      const prevAnim = this._anim[u.id];
      const from = prevAnim ? (prevAnim.curPos || prevAnim.to) : u.pos;
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', `war-unit war-side-${u.side} war-state-${u.state}`);
      g.setAttribute('data-warunit', u.id);
      g.setAttribute('transform', `translate(${from[0]},${from[1]})`);

      if (u.state === 'fighting') {
        const ring = document.createElementNS(NS, 'circle');
        ring.setAttribute('r', 20); ring.setAttribute('class', 'war-fight-ring');
        g.appendChild(ring);
      }
      const box = document.createElementNS(NS, 'rect');
      box.setAttribute('x', -13); box.setAttribute('y', -9); box.setAttribute('width', 26); box.setAttribute('height', 18);
      box.setAttribute('class', 'war-unit-box');
      g.appendChild(box);
      const glyph = document.createElementNS(NS, 'text');
      glyph.setAttribute('class', 'war-unit-glyph');
      glyph.setAttribute('text-anchor', 'middle'); glyph.setAttribute('y', 4);
      glyph.textContent = WAR_KIND_GLYPH[u.kind] || '?';
      g.appendChild(glyph);
      const pct = Math.max(0, Math.min(1, u.strength / (u.maxStrength || u.strength || 1)));
      const hpBg = document.createElementNS(NS, 'rect');
      hpBg.setAttribute('x', -13); hpBg.setAttribute('y', 10); hpBg.setAttribute('width', 26); hpBg.setAttribute('height', 3);
      hpBg.setAttribute('class', 'war-hp-bg');
      g.appendChild(hpBg);
      const hpFill = document.createElementNS(NS, 'rect');
      hpFill.setAttribute('x', -13); hpFill.setAttribute('y', 10); hpFill.setAttribute('width', 26 * pct); hpFill.setAttribute('height', 3);
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

  /* ═══════════ WAR ROOM PANEL ═══════════ */
  renderPanel(inner) {
    const war = S().war;
    inner.appendChild(el('div.doc-title', 'War Room'));
    if (!war) {
      inner.appendChild(el('div.doc-sub', 'No conflict is currently active.'));
      if (isGM()) this.renderStartForm(inner);
      return;
    }

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
