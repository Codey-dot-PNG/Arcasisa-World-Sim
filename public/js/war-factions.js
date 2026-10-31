'use strict';
/* Multi-way conflicts — the parties to a war or protest. Loaded after
   war-military.js; folded into `War`.

   Any nation can enter a running war or protest as a party of its own
   (server/war.js intervene; the engine's war.factions). Each party has a
   camp (whose machinery it uses), a stance toward every other party — ally
   or enemy, and it takes only one 'enemy' to make war — and a rule for
   whose ground it seizes: its enemies' only, or anyone's, allies included.

   This file draws:
   · the "Parties to the conflict" section of each War Room report — every
     party with its colour, camp, troops in the field, ground held and
     losses, its stance toward each other party (a chip the party's own
     command can flip), its seizing rule and field commander, and Withdraw;
   · the intervention form (the GM, or whoever runs a nation not yet in) —
     whom it fights alongside / against, whose ground it takes, what it
     sends and where it lands;
   · the colours the map paints interveners and their ground in
     (`facColor`; war.js renderUnits / renderGround).
   The server decides everything; every button posts to /api/war/factions/*. */
(function () {
  const PALETTE = ['#3f7a3a', '#7b3f8f', '#2f708f', '#a0661c', '#8f2f52', '#4f6b2a'];
  const live = (u) => u && !u.dead && u.state !== 'dead' && u.strength > 0;

  Object.assign(War, {
    _facDraft: {},

    facPrincipal(doc, side) { return side === 'att' ? ((doc.kind === 'protest' && doc.protest && doc.protest.organizerId) || doc.attackerId) : doc.defenderId; },
    facOfUnit(doc, u) { return u.fac || u.nationId || this.facPrincipal(doc, u.side); },
    // a party the war machinery of its camp doesn't speak for — drawn in its own colour
    isIntervener(doc, fid) {
      if (!doc || !doc.factions || !fid) return false;
      const f = doc.factions[fid];
      return !!f && !f.principal && !f.sworn;
    },
    facHostile(doc, a, b) { return window.WarEngine ? WarEngine.facHostile(doc, a, b) : false; },
    // a party's colour: the defence's blue, the attacker's red (a protest's
    // amber), an intervener its own map colour
    facColor(doc, fid) {
      if (fid === doc.defenderId) return '#1f3a5c';
      if (fid === this.facPrincipal(doc, 'att')) return doc.kind === 'protest' ? '#9a6418' : '#7a2418';
      const c = (((S().settings || {}).map || {}).countries || []).find(x => x.entityId === fid);
      if (c) { const ink = GameMap.countryInk ? GameMap.countryInk(c) : c.fill; if (ink) return ink; }
      const ids = Object.keys(doc.factions || {});
      return PALETTE[Math.max(0, ids.indexOf(fid)) % PALETTE.length];
    },
    // a light tint of a colour for marker fills
    facTint(hex, t) {
      const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
      if (!m) return '#e8e0cc';
      const n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
      const mix = (c, p) => Math.round(c * t + p * (1 - t));
      return '#' + [mix(r, 244), mix(g, 236), mix(b, 220)].map(v => v.toString(16).padStart(2, '0')).join('');
    },
    // the party this operator fights for on `side`: an intervening power they
    // run there, else that side's principal
    _cmdFaction(doc, side) {
      const run = ((doc.cmdAccess || {}).factions || []).find(id => doc.factions && doc.factions[id] && doc.factions[id].side === side);
      return !isGM() && run ? run : this.facPrincipal(doc, side);
    },
    // may this operator speak for party `fid`?
    facRuns(doc, fid) {
      if (isGM()) return true;
      const ca = doc.cmdAccess || {};
      if ((ca.factions || []).indexOf(fid) >= 0) return true;
      if (fid === doc.defenderId) return ca.negotiate === 'def';
      if (fid === this.facPrincipal(doc, 'att')) return ca.negotiate === 'att';
      return false;
    },

    /* ---------- the parties ---------- */
    renderFactions(inner, doc, key) {
      if (!doc.active) return;
      const F = doc.factions;
      const label = Views.secLabel('⚑ Parties to the conflict');
      inner.appendChild(label);
      if (!F) {
        inner.appendChild(el('div.protest-note', doc.kind === 'protest'
          ? 'Two parties so far: the movement and the government. Another nation may intervene on either side — or against both.'
          : 'Two camps so far. Another nation may intervene — alongside either side, or against everyone.'));
      } else {
        const ids = Object.keys(F);
        const men = {}, units = {};
        for (const u of doc.units || []) if (live(u)) { const f = this.facOfUnit(doc, u); men[f] = (men[f] || 0) + u.strength; units[f] = (units[f] || 0) + 1; }
        const ground = {};
        for (const c of Object.values(doc.cells || {})) { const f = c.f || (c.o === 'att' ? this.facPrincipal(doc, 'att') : null); if (f && c.pid) ground[f] = (ground[f] || 0) + 1; }
        const landTotal = Object.values((doc.grid || {}).provinceLandCells || {}).reduce((a, b) => a + b, 0) || 1;
        const losses = (doc.stats || {}).facLosses || {};
        const rows = ids.map(fid => {
          const f = F[fid], col = this.facColor(doc, fid), mine = this.facRuns(doc, fid);
          const role = f.principal ? (fid === doc.defenderId ? 'defending' : doc.kind === 'protest' ? 'the movement' : 'attacking')
            : f.sworn ? 'sworn ally' : `intervening · ${f.side === 'def' ? 'defending camp' : 'attacking camp'}`;
          const stances = ids.filter(o => o !== fid).map(o => {
            const enemy = this.facHostile(doc, fid, o);
            const stated = (f.stance || {})[o];
            const locked = (f.principal && F[o] && F[o].principal);
            return el('button.chip.chip-xs.fac-stance', {
              class: enemy ? 'fac-enemy' : 'fac-ally', disabled: mine && !locked ? undefined : 'disabled',
              title: locked ? 'The two sides settle this at the peace table' : mine ? `Click to ${enemy ? 'stand with' : 'turn on'} ${entName(o)}` : (stated ? `${entName(fid)} has declared ${entName(o)} ${stated === 'enemy' ? 'an enemy' : 'an ally'}` : 'by camp'),
              onclick: () => this._facPost('stance', { conflict: key, from: fid, to: o, stance: enemy ? 'ally' : 'enemy' },
                enemy ? `${entName(fid)} stands with ${entName(o)}.` : `${entName(fid)} turns on ${entName(o)}.`)
            }, el('span.fac-dot', { style: 'background:' + this.facColor(doc, o) }), `${enemy ? 'vs' : 'with'} ${entById(o) ? (entById(o).abbrev || entName(o)) : o}`);
          });
          const controls = [];
          if (!f.principal && mine) {
            controls.push(el('button.chip.chip-xs', { class: f.seize === 'all' ? 'active' : '', title: 'Seize ground from anyone, allies included',
              onclick: () => this._facPost('policy', { conflict: key, entityId: fid, seize: f.seize === 'all' ? 'enemies' : 'all' }, f.seize === 'all' ? 'Now seizing ground from enemies only.' : 'Now seizing ground from anyone.') },
              f.seize === 'all' ? 'Seizes from anyone' : 'Seizes from enemies'));
            if (!f.sworn) controls.push(el('button.chip.chip-xs', { class: f.ai !== false ? 'active' : '', title: 'Its own field commander picks fights and objectives; off, its troops wait for orders',
              onclick: () => this._facPost('policy', { conflict: key, entityId: fid, ai: f.ai === false }, f.ai === false ? 'The field commander takes over.' : 'Its troops now await orders.') },
              f.ai !== false ? 'Field commander: on' : 'Field commander: off'));
            controls.push(el('button.dash-btn.btn-xs.danger-text', { onclick: () => confirmModal('WITHDRAW', `${entName(fid)} pulls out of ${doc.name}: its troops go home with their kit, and the ground and buildings it holds are given up.`,
              () => this._facPost('withdraw', { conflict: key, entityId: fid }, `${entName(fid)} withdraws.`), 'Withdraw') }, 'Withdraw'));
          } else if (!f.principal) {
            controls.push(el('span.fac-meta', f.seize === 'all' ? 'seizes ground from anyone' : 'seizes ground from its enemies'));
          }
          return el('div.fac-row', { style: '--fac:' + col },
            el('div.fac-head',
              el('span.fac-swatch'),
              el('b', entName(fid)), el('span.fac-role', role),
              el('span.fac-stats', `${fmtCompact(men[fid] || 0)} in the field · ${units[fid] || 0} formation${units[fid] === 1 ? '' : 's'} · ${((ground[fid] || 0) / landTotal * 100).toFixed(1)}% of the land · ${fmtCompact(losses[fid] || 0)} lost`)),
            el('div.fac-stances', el('span.mono-label', 'Stance'), stances),
            controls.length ? el('div.fac-controls', controls) : null);
        });
        inner.appendChild(el('div.fac-list', rows));
      }
      this._renderInterveneForm(inner, doc, key);
    },
    async _facPost(verb, body, msg) {
      try { await POST('/api/war/factions/' + verb, body); if (msg) toast(msg); }
      catch (e) { toast(e.message, true); }
    },

    /* ---------- bringing a nation in ---------- */
    _interveners(doc) {
      const parties = new Set([this.facPrincipal(doc, 'att'), doc.defenderId].concat(Object.keys(doc.factions || {}), (doc.allies && doc.allies.att) || [], (doc.allies && doc.allies.def) || []));
      const cmd = S().milCommand || {};
      return (S().entities || []).filter(e => !parties.has(e.id) && (isGM() ? e.type === 'foreign' : cmd[e.id] === 'all' && (e.type === 'foreign' || e.type === 'government')));
    },
    _renderInterveneForm(inner, doc, key) {
      const cands = this._interveners(doc);
      if (!cands.length) return;
      inner.appendChild(Views.ledgerFold('wrIntervene_' + key, '+ Send a nation in', () => {
        const box = el('div.fac-form');
        const d = this._facDraft[key] = this._facDraft[key] || {};
        if (!cands.some(c => c.id === d.entityId)) d.entityId = cands[0].id;
        const parties = [this.facPrincipal(doc, 'att'), doc.defenderId].concat(Object.keys(doc.factions || {}).filter(id => id !== doc.defenderId && id !== this.facPrincipal(doc, 'att')));
        d.allies = (d.allies || []).filter(id => parties.includes(id));
        d.enemies = (d.enemies || []).filter(id => parties.includes(id) && !d.allies.includes(id));
        if (!d.allies.length && !d.enemies.length) { d.allies = [doc.defenderId]; d.enemies = [this.facPrincipal(doc, 'att')]; }
        if (d.infantry === undefined) d.infantry = 3;
        if (d.armour === undefined) d.armour = 1;
        if (!d.seize) d.seize = 'enemies';
        if (d.ai === undefined) d.ai = true;
        if (!d.entry) d.entry = 'city';
        const re = () => App.renderView();
        const chip = (id, list, other) => el('button.chip.chip-xs', {
          class: d[list].includes(id) ? 'active' : '',
          onclick: () => { if (d[list].includes(id)) d[list] = d[list].filter(x => x !== id); else { d[list] = d[list].concat(id); d[other] = d[other].filter(x => x !== id); } re(); }
        }, el('span.fac-dot', { style: 'background:' + this.facColor(doc, id) }), entName(id));
        const cities = (S().cities || []).filter(c => Array.isArray(c.pos));
        const ent = entById(d.entityId);
        const stock = (ent && ent.inventory) ? ent.inventory : null;
        const qty = (rx) => stock ? stock.filter(r => rx.test(r.itemId)).reduce((a, r) => a + r.qty, 0) : null;
        const rifles = qty(/gun/), tanks = qty(/tank/);
        box.appendChild(el('div.mil-order', el('div.mil-order-k', 'Nation'),
          el('select', { onchange: (e) => { d.entityId = e.target.value; re(); } }, cands.map(c => el('option', { value: c.id, selected: c.id === d.entityId ? 'selected' : undefined }, c.name))),
          stock ? el('div.mil-order-d', `In its arsenal: ${fmtNum(Math.round(rifles))} rifles · ${fmtNum(Math.round(tanks))} tanks. Its troops are armed from that stock.`) : null));
        box.appendChild(el('div.mil-order', el('div.mil-order-k', 'Fights alongside'), el('span.chip-row.mil-chips', parties.map(id => chip(id, 'allies', 'enemies')))));
        box.appendChild(el('div.mil-order', el('div.mil-order-k', 'Fights against'), el('span.chip-row.mil-chips', parties.map(id => chip(id, 'enemies', 'allies'))),
          el('div.mil-order-d', 'Parties left unpicked are friends of its camp and foes of the other. Any party can change its stance later.')));
        box.appendChild(el('div.mil-order', el('div.mil-order-k', 'Seizes ground from'),
          el('span.chip-row.mil-chips',
            el('button.chip.chip-xs', { class: d.seize === 'enemies' ? 'active' : '', onclick: () => { d.seize = 'enemies'; re(); } }, 'Its enemies'),
            el('button.chip.chip-xs', { class: d.seize === 'all' ? 'active' : '', onclick: () => { d.seize = 'all'; re(); } }, 'Anyone, allies too')),
          el('div.mil-order-d', d.seize === 'all' ? 'It plants its flag wherever its troops stand — on its allies’ land too — and the buildings there pass to it.' : 'It takes ground, and the buildings on it, only from those it fights.')));
        const num = (k, max, lbl) => el('select', { onchange: (e) => { d[k] = Number(e.target.value); } }, Array.from({ length: max + 1 }, (_, i) => el('option', { value: i, selected: d[k] === i ? 'selected' : undefined }, `${i} ${lbl}`)));
        box.appendChild(el('div.mil-order', el('div.mil-order-k', 'Sends'), el('span.fac-inline', num('infantry', 8, 'infantry brigades'), num('armour', 4, 'armoured brigades'))));
        box.appendChild(el('div.mil-order', el('div.mil-order-k', 'Lands at'),
          el('select', { onchange: (e) => { const v = e.target.value; if (v === '__home') d.entry = 'homeland'; else { d.entry = 'city'; d.cityId = v; } } },
            cities.map(c => el('option', { value: c.id, selected: d.entry === 'city' && (d.cityId ? d.cityId === c.id : c.isCapital) ? 'selected' : undefined }, c.name + (c.isCapital ? ' (capital)' : ''))),
            el('option', { value: '__home', selected: d.entry === 'homeland' ? 'selected' : undefined }, 'its own border'))));
        box.appendChild(el('div.mil-order', el('div.mil-order-k', 'Field commander'),
          el('span.chip-row.mil-chips',
            el('button.chip.chip-xs', { class: d.ai ? 'active' : '', onclick: () => { d.ai = true; re(); } }, 'Fights on its own'),
            el('button.chip.chip-xs', { class: !d.ai ? 'active' : '', onclick: () => { d.ai = false; re(); } }, 'Awaits orders'))));
        box.appendChild(el('div.btn-row', el('button.solid-btn.btn-xs', {
          onclick: async (e) => {
            const b = e.currentTarget; b.disabled = true;
            try {
              await POST('/api/war/factions/intervene', { conflict: key, entityId: d.entityId, allies: d.allies, enemies: d.enemies, seize: d.seize, ai: d.ai, infantry: d.infantry, armour: d.armour, entry: d.entry, cityId: d.cityId });
              toast(`${entName(d.entityId)} enters ${doc.name}.`);
              delete this._facDraft[key];
            } catch (err) { toast(err.message, true); b.disabled = false; }
          }
        }, `Send ${ent ? ent.name : 'them'} in`)));
        return box;
      }));
    }
  });
})();
