'use strict';
/* The peace table — loaded after war-air.js and folded into War.

   Either side of a war or a protest may put terms on the table; the other
   side accepts, rejects or counters; the proposer may revise or withdraw.
   Offers live in state.peaceOffers (server/peace.js) and every step
   broadcasts, so both War Rooms — and the HUD on the map — update live.
   Who speaks for a side is cmdAccess.negotiate ('att' | 'def'; the GM
   'both', picking the side). Terms:
     · reparations — an amount and who pays it;
     · held property — what the occupier holds (state.peaceHeld: occupied
       ground in a war, seized districts in a protest): keep all, return
       all, or keep a chosen few;
     · borders — drawn with the border painter in PEACE MODE (borders.js
       startPeace: only the two sides' own regions move; a protest movement
       can carve out a new state), previewed on the map for the other side;
     · (protest) the government concedes the demands;
     · a message.
   Accepting an offer applies it and ends the conflict. Acceptance carries the
   revision the reader saw, so terms revised under them are never accepted
   blind. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const other = (s) => (s === 'att' ? 'def' : 'att');
  const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'; };

  Object.assign(War, {
    _peaceDraft: {},
    // the two sides of a conflict: { att: entity, def: entity }
    peaceSides(war) {
      const attId = war.kind === 'protest' ? ((war.protest || {}).organizerId || war.attackerId) : war.attackerId;
      return { att: entById(attId), def: entById(war.defenderId) };
    },
    peaceSideName(war, side) { const e = this.peaceSides(war)[side]; return e ? e.name : (side === 'att' ? 'the attacker' : 'the defender'); },
    peaceOffers(war, key) {
      return (S().peaceOffers || []).filter(o => o.conflict === key && o.talks === war.startedAt);
    },
    peaceHeld(key) { return ((S().peaceHeld || {})[key]) || []; },
    // the regions each side may redraw (mirror of server peace.regionSides)
    peaceRegionKeys(war, key) {
      const sides = this.peaceSides(war);
      const isGov = (e) => !!e && (e.type === 'government' || e.id === 'ent_gov');
      const out = {};
      const gov = isGov(sides.def) ? 'def' : isGov(sides.att) ? 'att' : null;
      if (gov) for (const p of S().provinces) out['p:' + p.id] = gov;
      for (const c of ((S().settings.map || {}).countries || [])) {
        if (sides.att && c.entityId === sides.att.id) out['c:' + c.id] = 'att';
        else if (sides.def && c.entityId === sides.def.id) out['c:' + c.id] = 'def';
      }
      if (key === 'protest') out['c:__new'] = 'att';
      return out;
    },
    peaceTermsText(war, key, t) {
      t = t || {};
      const nm = (s) => this.peaceSideName(war, s);
      const out = [];
      if (t.reparations) out.push(`${nm(t.reparations.payer)} pays ${fmtMoney(t.reparations.amount)} to ${nm(other(t.reparations.payer))}`);
      if (t.holdings) {
        const n = this.peaceHeld(key).length;
        out.push(t.holdings.mode === 'keep' ? `${nm('att')} keeps every held property${n ? ` (${n})` : ''}`
          : t.holdings.mode === 'some' ? `${nm('att')} keeps ${t.holdings.keep.length} held propert${t.holdings.keep.length === 1 ? 'y' : 'ies'}: ${t.holdings.keep.map(id => (S().properties.find(p => p.id === id) || {}).name || id).join(', ')} — the rest go back`
            : 'every held property goes back to its owner');
      }
      if (t.borders && t.borders.regions && t.borders.regions.length) {
        const names = t.borders.regions.map(r => r.kind === 'new' ? `${(t.borders.newState || {}).name || 'a new state'} (new state)`
          : r.kind === 'province' ? ((provById(r.id) || {}).name || r.id) + (r.shape ? '' : ' (dissolved)')
            : ((((S().settings.map || {}).countries || []).find(c => c.id === r.id) || {}).name || r.id));
        out.push('redrawn borders: ' + names.join(', '));
      }
      if (t.concede) out.push(`the government concedes to ${nm('att')}’s demands`);
      return out;
    },
    // a short signature of the open offers (HUD redraws on change)
    peaceSig(war) {
      const key = war.kind === 'protest' ? 'protest' : 'war';
      return this.peaceOffers(war, key).filter(o => o.status === 'open').map(o => o.id + ':' + o.rev).join(',');
    },
    // the War Room composer holds focus while a sync lands: Views.render
    // skips the rebuild (and redraws on blur) so a half-typed offer survives
    peaceBusy() {
      const a = document.activeElement;
      return !!(a && a.closest && a.closest('.peace-composer') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
    },
    _peaceBlur() {
      setTimeout(() => { if (this._peaceSkipped && !this.peaceBusy()) { this._peaceSkipped = false; if (W.view === 'war') App.renderView(); } }, 0);
    },

    /* ---------- live news: offers addressed to me, answers to mine ---------- */
    peaceWatch() {
      const offers = S() && S().peaceOffers;
      if (!offers) return;
      const mine = (o) => {
        const doc = o.conflict === 'protest' ? S().protest : S().war;
        if (!doc || doc.startedAt !== o.talks) return null;
        const n = (doc.cmdAccess || {}).negotiate;
        return n === 'both' ? 'gm' : n || null;
      };
      const seen = this._peaceSeen;
      const now = {};
      for (const o of offers) now[o.id] = o.status + ':' + o.rev;
      this._peaceSeen = now;
      if (!seen) return; // first look: no fanfare for what was already there
      for (const o of offers) {
        const me = mine(o);
        if (!me || seen[o.id] === now[o.id]) continue;
        const doc = o.conflict === 'protest' ? S().protest : S().war;
        const from = doc ? this.peaceSideName(doc, o.side) : 'The other side';
        const to = doc ? this.peaceSideName(doc, other(o.side)) : '';
        if (me !== 'gm' && o.side === me) {
          if (o.status === 'accepted') toast(`🕊 ${to} accepted your peace terms.`);
          else if (o.status === 'rejected') toast(`🕊 ${to} rejected your peace terms${o.response ? ' — “' + o.response + '”' : ''}.`, true);
        } else if (o.status === 'open') {
          toast(`🕊 ${from} ${seen[o.id] ? 'revised its' : 'offers'} peace terms — see the War Room.`);
        } else if (o.status === 'accepted') toast(`🕊 Peace agreed: ${o.conflictName}.`);
      }
    },

    /* ---------- the HUD row on the map ---------- */
    _peaceHudRow(hud, war, row) {
      const key = war.kind === 'protest' ? 'protest' : 'war';
      if (!war.active) return;
      const open = this.peaceOffers(war, key).filter(o => o.status === 'open');
      if (!open.length) return;
      const o = open[open.length - 1];
      hud.appendChild(row('Peace', el('span', `${this.peaceSideName(war, o.side)} has terms on the table `,
        el('button.dash-btn.btn-xs', { onclick: (e) => { e.stopPropagation(); W.warRoomPeace = key; App.go('war'); } }, 'Review'))));
    },

    /* ---------- the War Room's peace table ---------- */
    renderPeaceTable(inner, war, key) {
      const offers = this.peaceOffers(war, key).slice().sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.updatedAt - a.updatedAt);
      if (!war.active && !offers.length) return;
      const ca = this.access(war);
      const neg = isGM() ? 'both' : ca.negotiate || null;
      const box = el('div.peace-table');
      inner.appendChild(Views.secLabel('🕊 Peace table'));
      inner.appendChild(box);
      const sides = this.peaceSides(war);
      const who = neg === 'both' ? 'You may speak for either side (GM).'
        : neg ? `You speak for ${this.peaceSideName(war, neg)}.`
          : `Negotiations are between ${sides.att ? sides.att.name : 'the attacker'} and ${sides.def ? sides.def.name : 'the defender'}.`;
      box.appendChild(el('div.peace-who', who));
      if (!offers.length) box.appendChild(el('div.peace-empty', 'No terms on the table yet.'));
      for (const o of offers.slice(0, 8)) box.appendChild(this._peaceCard(war, key, o, neg));
      const draft = this._peaceDraft[key];
      if (war.active && neg) {
        if (draft) box.appendChild(this._peaceComposer(war, key, draft, neg));
        else box.appendChild(el('div.btn-row', el('button.solid-btn.btn-xs', { onclick: () => this._peaceOpen(war, key, neg) }, '🕊 Propose terms…')));
      }
      if (W.warRoomPeace === key) { W.warRoomPeace = null; setTimeout(() => box.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60); }
    },
    _peaceCard(war, key, o, neg) {
      const from = this.peaceSideName(war, o.side), to = this.peaceSideName(war, other(o.side));
      const mineToAnswer = o.status === 'open' && (neg === 'both' || neg === other(o.side));
      const mineToRevise = o.status === 'open' && (neg === 'both' || neg === o.side);
      const statusLabel = { open: 'on the table', accepted: 'accepted — peace', rejected: 'rejected', withdrawn: 'withdrawn', superseded: 'replaced by a newer offer', void: 'void' }[o.status] || o.status;
      const terms = this.peaceTermsText(war, key, o.terms);
      const card = el('div.peace-offer', { class: 'st-' + o.status },
        el('div.peace-offer-head',
          el('span.peace-offer-from', from, el('span.peace-arrow', ' → '), to),
          el('span.peace-offer-status', statusLabel),
          el('span.peace-offer-meta', (o.rev > 1 ? `rev ${o.rev} · ` : '') + ago(o.updatedAt) + (o.by ? ' · ' + o.by : ''))),
        terms.length ? el('ul.peace-terms', terms.map(t => el('li', t))) : null,
        o.terms && o.terms.note ? el('div.peace-note', '“' + o.terms.note + '”') : null,
        o.response ? el('div.peace-response', 'Reply: “' + o.response + '”') : null);
      const acts = el('div.btn-row.peace-acts');
      const hasMap = o.status === 'open' && o.terms && o.terms.borders && (o.terms.borders.regions || []).some(r => r.shape && r.shape !== '…');
      if (hasMap) acts.appendChild(el('button.dash-btn.btn-xs', { onclick: () => this.peacePreview(o) }, '◎ See the borders on the map'));
      if (mineToAnswer) {
        acts.appendChild(el('button.solid-btn.btn-xs', { onclick: () => this._peaceAccept(war, key, o) }, 'Accept — make peace'));
        acts.appendChild(el('button.dash-btn.btn-xs', { onclick: () => this._peaceOpen(war, key, neg === 'both' ? other(o.side) : neg, o, true) }, 'Counter-offer…'));
        acts.appendChild(el('button.dash-btn.btn-xs', { onclick: () => this._peaceReject(o) }, 'Reject'));
      }
      if (mineToRevise && neg !== 'both') {
        acts.appendChild(el('button.dash-btn.btn-xs', { onclick: () => this._peaceOpen(war, key, o.side, o) }, 'Revise…'));
        acts.appendChild(el('button.dash-btn.btn-xs', { onclick: () => this._peaceAct(o, 'withdraw', {}) }, 'Withdraw'));
      }
      if (acts.childNodes.length) card.appendChild(acts);
      return card;
    },
    async _peaceAct(o, verb, body) {
      try { await POST('/api/war/peace/' + encodeURIComponent(o.id) + '/' + verb, body || {}); }
      catch (e) { toast(e.message, true); }
    },
    _peaceAccept(war, key, o) {
      const terms = this.peaceTermsText(war, key, o.terms);
      openModal('MAKE PEACE', el('div',
        el('p', { style: 'font-family:var(--font-voice); font-size:15px; line-height:1.6;' }, `Accept ${this.peaceSideName(war, o.side)}’s terms and end ${o.conflictName}?`),
        terms.length ? el('ul.peace-terms', terms.map(t => el('li', t))) : el('p', 'No conditions — the fighting simply stops.'),
        o.terms && o.terms.borders ? el('p.peace-warn', 'The border clause redraws the map the moment you accept.') : null),
        [{ label: 'Accept — make peace', cls: 'danger-btn', onClick: async () => {
          await POST('/api/war/peace/' + encodeURIComponent(o.id) + '/accept', { rev: o.rev });
          toast('🕊 Peace agreed.');
          if (W.peacePreview && W.peacePreview.offerId === o.id) W.peacePreview = null;
        } }, { label: 'Not yet', cls: 'dash-btn', onClick: () => {} }]);
    },
    _peaceReject(o) {
      const note = el('textarea.text-input', { placeholder: 'A reply (optional)', maxlength: '400' });
      openModal('REJECT THE TERMS', el('div', note), [
        { label: 'Reject', cls: 'danger-btn', onClick: () => this._peaceAct(o, 'reject', { note: note.value }) },
        { label: 'Cancel', cls: 'dash-btn', onClick: () => {} }]);
    },

    /* ---------- the composer ---------- */
    // open a fresh draft — or one seeded from an offer (revise / counter)
    _peaceOpen(war, key, side, from, counter) {
      const t = (from && from.terms) || {};
      const borders = t.borders && (t.borders.regions || []).every(r => r.shape !== '…') ? JSON.parse(JSON.stringify(t.borders)) : null;
      this._peaceDraft[key] = {
        side: side === 'both' ? 'def' : side,
        editing: from && !counter ? from.id : null,
        repAmount: t.reparations ? t.reparations.amount : '',
        repPayer: t.reparations ? t.reparations.payer : other(side === 'both' ? 'def' : side),
        holdMode: t.holdings ? t.holdings.mode : 'return',
        keep: new Set(t.holdings ? t.holdings.keep : []),
        borders,
        newName: borders && borders.newState ? borders.newState.name : '',
        concede: !!t.concede,
        note: counter ? '' : (t.note || '')
      };
      App.renderView();
    },
    _peaceComposer(war, key, d, neg) {
      const box = el('div.peace-composer');
      const sides = this.peaceSides(war);
      const blur = () => this._peaceBlur();
      box.appendChild(el('div.peace-composer-title', d.editing ? 'Revise your terms' : 'Your terms'));
      if (neg === 'both') {
        box.appendChild(Forms.field('Speaking for', el('select.text-input', { onchange: (e) => { d.side = e.target.value; App.renderView(); }, onblur: blur },
          ['att', 'def'].map(s => el('option', { value: s, selected: d.side === s ? 'selected' : undefined }, this.peaceSideName(war, s))))));
      }
      // reparations
      box.appendChild(el('div.peace-row',
        Forms.field('Reparations (' + CUR() + ')', el('input.text-input', { type: 'number', min: '0', step: '1000', value: d.repAmount, placeholder: 'none', oninput: (e) => { d.repAmount = e.target.value; }, onblur: blur })),
        Forms.field('Paid by', el('select.text-input', { onchange: (e) => { d.repPayer = e.target.value; }, onblur: blur },
          ['att', 'def'].map(s => el('option', { value: s, selected: d.repPayer === s ? 'selected' : undefined }, this.peaceSideName(war, s)))))));
      // held property
      const held = this.peaceHeld(key);
      const occ = this.peaceSideName(war, 'att');
      if (held.length) {
        const modes = [['return', 'All go back to their owners'], ['keep', `${occ} keeps them all`], ['some', `${occ} keeps the ones ticked`]];
        box.appendChild(el('div.peace-sub', `Property ${occ} holds (${held.length})`));
        box.appendChild(el('div.chip-row', modes.map(([m, label]) => el('button.chip', { class: d.holdMode === m ? 'active' : '', onclick: () => { d.holdMode = m; App.renderView(); } }, label))));
        if (d.holdMode === 'some') {
          box.appendChild(el('div.peace-held', held.map(h => el('label.peace-held-row',
            el('input', { type: 'checkbox', checked: d.keep.has(h.propId), onchange: (e) => { if (e.target.checked) d.keep.add(h.propId); else d.keep.delete(h.propId); }, onblur: blur }),
            el('span', h.name), el('span.peace-held-from', 'from ' + entName(h.formerOwnerId))))));
        }
      }
      // borders
      box.appendChild(el('div.peace-sub', 'Borders'));
      const nb = d.borders ? d.borders.regions.length : 0;
      box.appendChild(el('div.peace-borders',
        el('span', nb ? `${nb} region${nb === 1 ? '' : 's'} redrawn` : 'No change to the map'),
        el('button.dash-btn.btn-xs', { onclick: () => this.peaceDraw(war, key) }, nb ? '✎ Edit the border' : '✎ Draw new borders'),
        nb ? el('button.dash-btn.btn-xs', { onclick: () => this.peacePreview({ id: '__draft_' + key, terms: { borders: d.borders } }) }, '◎ Preview') : null,
        nb ? el('button.dash-btn.btn-xs', { onclick: () => { d.borders = null; App.renderView(); } }, 'Clear') : null));
      if (key === 'protest' && d.borders && d.borders.regions.some(r => r.kind === 'new')) {
        box.appendChild(Forms.field('Name of the new state', el('input.text-input', { value: d.newName, placeholder: (sides.att ? sides.att.name : 'The movement') + ' Free State', maxlength: '60', oninput: (e) => { d.newName = e.target.value; }, onblur: blur })));
      }
      if (key === 'protest') box.appendChild(Forms.check(d, 'concede', 'The government concedes the movement’s demands'));
      const note = el('textarea.text-input', { placeholder: 'A message to the other side (optional)', maxlength: '800', oninput: (e) => { d.note = e.target.value; }, onblur: blur });
      note.value = d.note || '';
      box.appendChild(Forms.field('Message', note));
      box.appendChild(el('div.btn-row',
        el('button.solid-btn.btn-xs', { onclick: () => this._peaceSend(war, key, d) }, d.editing ? 'Send the revision' : 'Put the offer on the table'),
        el('button.dash-btn.btn-xs', { onclick: () => { delete this._peaceDraft[key]; App.renderView(); } }, 'Cancel')));
      return box;
    },
    _peaceTerms(d) {
      const t = {};
      if (Number(d.repAmount) > 0) t.reparations = { amount: Number(d.repAmount), payer: d.repPayer };
      t.holdings = { mode: d.holdMode, keep: [...d.keep] };
      if (d.borders && d.borders.regions.length) t.borders = { regions: d.borders.regions, newState: d.newName ? { name: d.newName } : undefined };
      if (d.concede) t.concede = true;
      if (d.note && d.note.trim()) t.note = d.note.trim();
      return t;
    },
    async _peaceSend(war, key, d) {
      const terms = this._peaceTerms(d);
      try {
        if (d.editing) await POST('/api/war/peace/' + encodeURIComponent(d.editing) + '/revise', { terms });
        else await POST('/api/war/peace/offer', { conflict: key, side: d.side, terms });
        delete this._peaceDraft[key];
        toast(d.editing ? '🕊 Revision sent.' : '🕊 Your terms are on the table.');
        App.renderView();
      } catch (e) { toast(e.message, true); }
    },

    /* ---------- drawing the border (Borders peace mode) ---------- */
    peaceDraw(war, key) {
      const d = this._peaceDraft[key];
      if (!d || !window.Borders) return;
      const owners = this.peaceRegionKeys(war, key);
      const sides = this.peaceSides(war);
      const keys = Object.keys(owners);
      if (!keys.length) return toast('Neither side holds territory on the map to redraw.', true);
      Borders.startPeace({
        keys,
        sideOf: owners,
        sideName: (s) => this.peaceSideName(war, s),
        virtual: key === 'protest' ? { key: 'c:__new', name: d.newName || ((sides.att ? sides.att.name : 'The movement') + ' Free State'), color: (sides.att && /^#[0-9a-f]{6}$/i.test(sides.att.color || '')) ? sides.att.color : '#9a8a6a' } : null,
        initial: d.borders ? d.borders.regions : [],
        prefer: d.side,
        onDone: (regions) => {
          d.borders = regions.length ? { regions } : null;
          W.warRoomPeace = key;
          App.go('war');
        },
        onCancel: () => { W.warRoomPeace = key; App.go('war'); }
      });
    },

    /* ---------- previewing an offer's borders on the map ---------- */
    peacePreview(o) {
      W.peacePreview = { offerId: o.id, borders: o.terms.borders };
      if (W.layer === 'war') W.layer = 'political';
      if (W.view !== 'map') App.go('map'); else GameMap.render();
    }
  });

  // the map draws the previewed borders over the sheet (GameMap.render)
  GameMap.renderPeacePreview = function () {
    const pv = W.peacePreview;
    if (!pv || !pv.borders || !this.world) return;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'peace-preview');
    g.setAttribute('pointer-events', 'none');
    const countries = (S().settings.map || {}).countries || [];
    const labels = [];
    for (const r of pv.borders.regions || []) {
      if (!r.shape || r.shape === '…') continue;
      const color = r.kind === 'province' ? ((provById(r.id) || {}).color || '#8a6a4a')
        : r.kind === 'new' ? ((pv.borders.newState || {}).fill || '#9a8a6a')
          : (this.countryInk ? this.countryInk(countries.find(c => c.id === r.id) || { id: r.id }) : '#6a6a6a');
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', r.shape); p.setAttribute('fill-rule', 'evenodd');
      p.setAttribute('class', 'peace-prev-shape');
      p.setAttribute('vector-effect', 'non-scaling-stroke');
      p.style.fill = color; p.style.stroke = color;
      if (r.kind === 'new') p.classList.add('peace-prev-new');
      g.appendChild(p);
      if (Array.isArray(r.labelPos)) {
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', r.labelPos[0]); t.setAttribute('y', r.labelPos[1]);
        t.setAttribute('class', 'peace-prev-label'); t.setAttribute('text-anchor', 'middle');
        t.textContent = r.kind === 'new' ? ((pv.borders.newState || {}).name || 'New state') : r.kind === 'province' ? (provById(r.id) || {}).name || '' : ((countries.find(c => c.id === r.id) || {}).name || '');
        labels.push([t, p]);
      }
    }
    this.world.appendChild(g);
    // names on top, each sized to its own region's width
    for (const [t, p] of labels) {
      let w = 0; try { w = p.getBBox().width; } catch (e) { /* not laid out */ }
      if (w) t.style.fontSize = Math.max(14, Math.min(40, w * 0.55 / Math.max(4, t.textContent.length))) + 'px';
      g.appendChild(t);
    }
  };
})();
