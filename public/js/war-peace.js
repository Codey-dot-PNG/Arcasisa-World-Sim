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
   blind.

   DEALS (multi-way conflicts — once a nation has intervened): any party may
   strike a deal with any other, whichever side either is on (server
   peace.js kind:'pact'). The composer then asks who you speak for and with
   whom; between the two original sides it is the peace offer above, any
   other pair gets the deal terms — peace between the two, a joint war
   against others, money, goods, one handing its ground to the other, one
   withdrawing, borders between their own lands, a message. A deal binds only
   its two parties; the conflict goes on. */
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
    // every party to the conflict (the two sides, then any interveners)
    peaceParties(war) {
      const s = this.peaceSides(war);
      const ids = [s.att && s.att.id, s.def && s.def.id].filter(Boolean);
      for (const id of Object.keys(war.factions || {})) if (!ids.includes(id)) ids.push(id);
      return ids;
    },
    // the parties this viewer may speak for in deals
    peaceVoices(war) {
      if (isGM()) return this.peaceParties(war);
      const ca = war.cmdAccess || {}, s = this.peaceSides(war), out = [];
      if (ca.negotiate === 'att' && s.att) out.push(s.att.id);
      if (ca.negotiate === 'def' && s.def) out.push(s.def.id);
      for (const id of ca.factions || []) if (!out.includes(id)) out.push(id);
      return out;
    },
    _isPrincipalPair(war, a, b) {
      const s = this.peaceSides(war);
      const att = s.att && s.att.id, def = s.def && s.def.id;
      return (a === att && b === def) || (a === def && b === att);
    },
    // mirror of server peace.describePact
    dealTermsText(t, from, to) {
      t = t || {};
      const n = (id) => entName(id);
      const other = (id) => (id === from ? to : from);
      const out = [];
      if (t.peace) out.push(`${n(from)} and ${n(to)} stop fighting each other`);
      if (t.against && t.against.length) out.push(`together against ${t.against.map(n).join(', ')}`);
      if (t.reparations) out.push(`${n(t.reparations.payer)} pays ${fmtMoney(t.reparations.amount)} to ${n(other(t.reparations.payer))}`);
      for (const g of t.goods || []) out.push(`${n(g.from)} hands ${fmtNum(g.qty)} × ${(itemById(g.itemId) || {}).name || g.itemId} to ${n(other(g.from))}`);
      if (t.ground) out.push(`${n(t.ground.from)} hands the ground it holds to ${n(t.ground.to)}`);
      if (t.withdraw) out.push(`${n(t.withdraw)} withdraws from the conflict`);
      if (t.borders && t.borders.regions && t.borders.regions.length) {
        out.push('redrawn borders: ' + t.borders.regions.map(r => r.kind === 'province' ? ((provById(r.id) || {}).name || r.id)
          : ((((S().settings.map || {}).countries || []).find(c => c.id === r.id) || {}).name || r.id)).join(', '));
      }
      return out;
    },
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
        if (o.kind === 'pact') {
          if (seen[o.id] === now[o.id]) continue;
          const doc = o.conflict === 'protest' ? S().protest : S().war;
          if (!doc || doc.startedAt !== o.talks) continue;
          const voices = this.peaceVoices(doc);
          if (o.status === 'open' && voices.includes(o.to) && !isGM()) toast(`🕊 ${entName(o.from)} ${seen[o.id] ? 'revised its' : 'offers'} a deal to ${entName(o.to)} — see the War Room.`);
          else if (voices.includes(o.from) && !isGM() && o.status === 'accepted') toast(`🕊 ${entName(o.to)} accepted your deal.`);
          else if (voices.includes(o.from) && !isGM() && o.status === 'rejected') toast(`🕊 ${entName(o.to)} rejected your deal${o.response ? ' — “' + o.response + '”' : ''}.`, true);
          else if (o.status === 'accepted' && seen[o.id]) toast(`🕊 Deal struck: ${entName(o.from)} and ${entName(o.to)}.`);
          continue;
        }
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
      hud.appendChild(row('Peace', el('span', `${o.kind === 'pact' ? entName(o.from) : this.peaceSideName(war, o.side)} has terms on the table `,
        el('button.dash-btn.btn-xs', { onclick: (e) => { e.stopPropagation(); W.warRoomPeace = key; App.go('war'); } }, 'Review'))));
    },

    /* ---------- the War Room's peace table ---------- */
    renderPeaceTable(inner, war, key) {
      const offers = this.peaceOffers(war, key).slice().sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.updatedAt - a.updatedAt);
      if (!war.active && !offers.length) return;
      const ca = this.access(war);
      const neg = isGM() ? 'both' : ca.negotiate || null;
      const multi = !!war.factions;
      const voices = multi ? this.peaceVoices(war) : [];
      const box = el('div.peace-table');
      inner.appendChild(Views.secLabel('🕊 Peace table'));
      inner.appendChild(box);
      const sides = this.peaceSides(war);
      const who = neg === 'both' ? (multi ? 'You may speak for any party (GM).' : 'You may speak for either side (GM).')
        : voices.length ? `You speak for ${voices.map(id => entName(id)).join(' and ')}. Any party may strike a deal with any other.`
          : neg ? `You speak for ${this.peaceSideName(war, neg)}.`
            : multi ? 'Every party to the conflict may strike deals with any other.'
              : `Negotiations are between ${sides.att ? sides.att.name : 'the attacker'} and ${sides.def ? sides.def.name : 'the defender'}.`;
      box.appendChild(el('div.peace-who', who));
      if (!offers.length) box.appendChild(el('div.peace-empty', 'No terms on the table yet.'));
      for (const o of offers.slice(0, 10)) box.appendChild(o.kind === 'pact' ? this._dealCard(war, key, o, voices) : this._peaceCard(war, key, o, neg));
      const draft = this._peaceDraft[key];
      if (war.active && (neg || voices.length)) {
        if (draft) box.appendChild(draft.deal ? this._dealComposer(war, key, draft) : this._peaceComposer(war, key, draft, neg));
        else box.appendChild(el('div.btn-row', el('button.solid-btn.btn-xs', {
          onclick: () => multi ? this._dealOpen(war, key, voices[0], this.peaceParties(war).find(id => id !== voices[0])) : this._peaceOpen(war, key, neg)
        }, multi ? '🕊 Propose terms or a deal…' : '🕊 Propose terms…')));
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
      if (war.factions && !d.editing) {
        const s = this.peaceSides(war);
        box.appendChild(this._partyPicker(war, key, { from: (s[d.side] || {}).id, to: (s[other(d.side)] || {}).id }));
        box.appendChild(el('div.peace-sub', 'Between the two sides: accepted, this ends the conflict.'));
      } else if (neg === 'both') {
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

    /* ---------- deals between any two parties (multi-way) ---------- */
    // "Speaking for … With …": picking the two original sides switches to
    // the peace offer, any other pair to a deal
    _partyPicker(war, key, cur) {
      const voices = this.peaceVoices(war), parties = this.peaceParties(war);
      const pick = (from, to) => {
        if (from === to) to = parties.find(id => id !== from);
        if (this._isPrincipalPair(war, from, to)) {
          const s = this.peaceSides(war);
          this._peaceOpen(war, key, s.def && s.def.id === from ? 'def' : 'att');
        } else this._dealOpen(war, key, from, to);
      };
      return el('div.peace-row',
        Forms.field('Speaking for', el('select.text-input', { onchange: (e) => pick(e.target.value, cur.to), onblur: () => this._peaceBlur() },
          voices.map(id => el('option', { value: id, selected: id === cur.from ? 'selected' : undefined }, entName(id))))),
        Forms.field('With', el('select.text-input', { onchange: (e) => pick(cur.from, e.target.value), onblur: () => this._peaceBlur() },
          parties.filter(id => id !== cur.from).map(id => el('option', { value: id, selected: id === cur.to ? 'selected' : undefined }, entName(id))))));
    },
    _dealOpen(war, key, from, to, offer, counter) {
      const t = (offer && offer.terms) || {};
      const borders = t.borders && (t.borders.regions || []).every(r => r.shape !== '…') ? JSON.parse(JSON.stringify(t.borders)) : null;
      this._peaceDraft[key] = {
        deal: true, from, to,
        editing: offer && !counter ? offer.id : null,
        peace: offer ? !!t.peace : true,
        against: new Set(t.against || []),
        repAmount: t.reparations ? t.reparations.amount : '',
        repPayer: t.reparations ? t.reparations.payer : from,
        goods: (t.goods || []).map(g => ({ itemId: g.itemId, qty: g.qty, from: g.from })),
        ground: t.ground ? t.ground.from : '',
        withdraw: t.withdraw || '',
        borders,
        note: counter ? '' : (t.note || '')
      };
      App.renderView();
    },
    // mirror of server peace.pactRegionOwners
    _dealRegionOwners(war, a, b) {
      const out = {};
      const gov = [a, b].find(id => id === war.defenderId && ((entById(id) || {}).type === 'government' || id === 'ent_gov'));
      if (gov) for (const p of S().provinces) out['p:' + p.id] = gov;
      for (const c of ((S().settings.map || {}).countries || [])) if (c.entityId === a || c.entityId === b) out['c:' + c.id] = c.entityId;
      return out;
    },
    _dealCard(war, key, o, voices) {
      const isGm = isGM();
      const mineToAnswer = o.status === 'open' && (isGm || voices.includes(o.to));
      const mineToRevise = o.status === 'open' && (isGm || voices.includes(o.from));
      const statusLabel = { open: 'on the table', accepted: 'accepted — deal struck', rejected: 'rejected', withdrawn: 'withdrawn', superseded: 'replaced', void: 'void' }[o.status] || o.status;
      const terms = this.dealTermsText(o.terms, o.from, o.to);
      const card = el('div.peace-offer.peace-deal', { class: 'st-' + o.status },
        el('div.peace-offer-head',
          el('span.peace-offer-from', entName(o.from), el('span.peace-arrow', ' → '), entName(o.to)),
          el('span.peace-offer-status', 'deal · ' + statusLabel),
          el('span.peace-offer-meta', (o.rev > 1 ? `rev ${o.rev} · ` : '') + ago(o.updatedAt) + (o.by ? ' · ' + o.by : ''))),
        terms.length ? el('ul.peace-terms', terms.map(t => el('li', t))) : null,
        o.terms && o.terms.note ? el('div.peace-note', '“' + o.terms.note + '”') : null,
        o.response ? el('div.peace-response', 'Reply: “' + o.response + '”') : null);
      const acts = el('div.btn-row.peace-acts');
      const hasMap = o.status === 'open' && o.terms && o.terms.borders && (o.terms.borders.regions || []).some(r => r.shape && r.shape !== '…');
      if (hasMap) acts.appendChild(el('button.dash-btn.btn-xs', { onclick: () => this.peacePreview(o) }, '◎ See the borders on the map'));
      if (mineToAnswer) {
        acts.appendChild(el('button.solid-btn.btn-xs', { onclick: () => this._dealAccept(war, key, o) }, 'Accept the deal'));
        acts.appendChild(el('button.dash-btn.btn-xs', { onclick: () => this._dealOpen(war, key, o.to, o.from, o, true) }, 'Counter-offer…'));
        acts.appendChild(el('button.dash-btn.btn-xs', { onclick: () => this._peaceReject(o) }, 'Reject'));
      }
      if (mineToRevise) {
        acts.appendChild(el('button.dash-btn.btn-xs', { onclick: () => this._dealOpen(war, key, o.from, o.to, o) }, 'Revise…'));
        acts.appendChild(el('button.dash-btn.btn-xs', { onclick: () => this._peaceAct(o, 'withdraw', {}) }, 'Withdraw'));
      }
      if (acts.childNodes.length) card.appendChild(acts);
      return card;
    },
    _dealAccept(war, key, o) {
      const terms = this.dealTermsText(o.terms, o.from, o.to);
      openModal('STRIKE THE DEAL', el('div',
        el('p', { style: 'font-family:var(--font-voice); font-size:15px; line-height:1.6;' }, `Accept ${entName(o.from)}’s deal with ${entName(o.to)}? It binds only the two of you — ${o.conflictName} goes on.`),
        terms.length ? el('ul.peace-terms', terms.map(t => el('li', t))) : el('p', 'An understanding, nothing more.'),
        o.terms && o.terms.borders ? el('p.peace-warn', 'The border clause redraws the map the moment you accept.') : null),
        [{ label: 'Accept the deal', cls: 'danger-btn', onClick: async () => {
          await POST('/api/war/peace/' + encodeURIComponent(o.id) + '/accept', { rev: o.rev });
          toast('🕊 Deal struck.');
          if (W.peacePreview && W.peacePreview.offerId === o.id) W.peacePreview = null;
        } }, { label: 'Not yet', cls: 'dash-btn', onClick: () => {} }]);
    },
    _dealComposer(war, key, d) {
      const box = el('div.peace-composer.deal-composer');
      const blur = () => this._peaceBlur();
      const re = () => App.renderView();
      const pair = [d.from, d.to];
      const n = (id) => entName(id);
      box.appendChild(el('div.peace-composer-title', d.editing ? 'Revise your deal' : 'A deal'));
      if (!d.editing) box.appendChild(this._partyPicker(war, key, d));
      else box.appendChild(el('div.peace-sub', `${n(d.from)} → ${n(d.to)}`));
      box.appendChild(el('div.peace-sub', `It binds only ${n(d.from)} and ${n(d.to)} — the conflict goes on.`));
      // peace / joint war
      box.appendChild(Forms.check(d, 'peace', `${n(d.from)} and ${n(d.to)} stop fighting each other`));
      const others = this.peaceParties(war).filter(id => !pair.includes(id));
      if (others.length) {
        box.appendChild(el('div.peace-sub', 'Together against'));
        box.appendChild(el('div.chip-row', others.map(id => el('button.chip.chip-xs', { class: d.against.has(id) ? 'active' : '',
          onclick: () => { if (d.against.has(id)) d.against.delete(id); else d.against.add(id); re(); } }, n(id)))));
      }
      // money
      box.appendChild(el('div.peace-row',
        Forms.field('Money (' + CUR() + ')', el('input.text-input', { type: 'number', min: '0', step: '1000', value: d.repAmount, placeholder: 'none', oninput: (e) => { d.repAmount = e.target.value; }, onblur: blur })),
        Forms.field('Paid by', el('select.text-input', { onchange: (e) => { d.repPayer = e.target.value; }, onblur: blur },
          pair.map(id => el('option', { value: id, selected: d.repPayer === id ? 'selected' : undefined }, n(id)))))));
      // goods
      box.appendChild(el('div.peace-sub', 'Goods'));
      const tradable = (S().items || []).filter(it => !(it.meta && (it.meta.companyId || it.meta.propertyId)));
      const holds = (id, itemId) => { const e = entById(id); const r = e && Array.isArray(e.inventory) ? e.inventory.find(x => x.itemId === itemId) : null; return e && Array.isArray(e.inventory) ? (r ? r.qty : 0) : null; };
      d.goods.forEach((g, i) => {
        const h = holds(g.from, g.itemId);
        box.appendChild(el('div.peace-row.deal-goods',
          el('select.text-input', { onchange: (e) => { g.from = e.target.value; re(); }, onblur: blur }, pair.map(id => el('option', { value: id, selected: g.from === id ? 'selected' : undefined }, n(id) + ' gives'))),
          el('input.text-input', { type: 'number', min: '1', step: '1', value: g.qty, style: 'max-width:120px;', oninput: (e) => { g.qty = e.target.value; }, onblur: blur }),
          el('select.text-input', { onchange: (e) => { g.itemId = e.target.value; re(); }, onblur: blur },
            tradable.map(it => el('option', { value: it.id, selected: g.itemId === it.id ? 'selected' : undefined }, it.name))),
          el('span.peace-held-from', h === null ? '' : `holds ${fmtNum(Math.floor(h))}`),
          el('button.dash-btn.btn-xs', { onclick: () => { d.goods.splice(i, 1); re(); } }, '✕')));
      });
      if (d.goods.length < 12) box.appendChild(el('div.btn-row', el('button.dash-btn.btn-xs', { onclick: () => {
        const weapon = tradable.find(it => it.meta && it.meta.weapon) || tradable[0];
        d.goods.push({ itemId: weapon ? weapon.id : '', qty: 1000, from: d.from }); re();
      } }, '+ Goods')));
      // ground and withdrawal
      const canGive = pair.filter(id => id !== war.defenderId);
      box.appendChild(el('div.peace-row',
        Forms.field('Ground', el('select.text-input', { onchange: (e) => { d.ground = e.target.value; }, onblur: blur },
          el('option', { value: '' }, 'stays as it is'),
          canGive.map(id => el('option', { value: id, selected: d.ground === id ? 'selected' : undefined }, `${n(id)} hands its ground to ${n(pair.find(x => x !== id))}`)))),
        Forms.field('Withdrawal', el('select.text-input', { onchange: (e) => { d.withdraw = e.target.value; }, onblur: blur },
          el('option', { value: '' }, 'nobody leaves'),
          pair.filter(id => war.factions && war.factions[id] && !war.factions[id].principal).map(id => el('option', { value: id, selected: d.withdraw === id ? 'selected' : undefined }, `${n(id)} withdraws`))))));
      // borders between their own lands
      const owners = this._dealRegionOwners(war, d.from, d.to);
      if (Object.keys(owners).length) {
        box.appendChild(el('div.peace-sub', 'Borders'));
        const nb = d.borders ? d.borders.regions.length : 0;
        box.appendChild(el('div.peace-borders',
          el('span', nb ? `${nb} region${nb === 1 ? '' : 's'} redrawn` : 'No change to the map'),
          el('button.dash-btn.btn-xs', { onclick: () => this.dealDraw(war, key) }, nb ? '✎ Edit the border' : '✎ Draw new borders'),
          nb ? el('button.dash-btn.btn-xs', { onclick: () => this.peacePreview({ id: '__draft_' + key, terms: { borders: d.borders } }) }, '◎ Preview') : null,
          nb ? el('button.dash-btn.btn-xs', { onclick: () => { d.borders = null; re(); } }, 'Clear') : null));
      }
      const note = el('textarea.text-input', { placeholder: 'A message (optional)', maxlength: '800', oninput: (e) => { d.note = e.target.value; }, onblur: blur });
      note.value = d.note || '';
      box.appendChild(Forms.field('Message', note));
      box.appendChild(el('div.btn-row',
        el('button.solid-btn.btn-xs', { onclick: () => this._dealSend(war, key, d) }, d.editing ? 'Send the revision' : 'Put the deal on the table'),
        el('button.dash-btn.btn-xs', { onclick: () => { delete this._peaceDraft[key]; re(); } }, 'Cancel')));
      return box;
    },
    _dealTerms(d) {
      const t = {};
      if (d.peace) t.peace = true;
      if (d.against.size) t.against = [...d.against];
      if (Number(d.repAmount) > 0) t.reparations = { amount: Number(d.repAmount), payer: d.repPayer };
      const goods = d.goods.filter(g => g.itemId && Number(g.qty) > 0).map(g => ({ itemId: g.itemId, qty: Math.floor(Number(g.qty)), from: g.from }));
      if (goods.length) t.goods = goods;
      if (d.ground) t.ground = { from: d.ground, to: d.ground === d.from ? d.to : d.from };
      if (d.withdraw) t.withdraw = d.withdraw;
      if (d.borders && d.borders.regions.length) t.borders = { regions: d.borders.regions };
      if (d.note && d.note.trim()) t.note = d.note.trim();
      return t;
    },
    async _dealSend(war, key, d) {
      const terms = this._dealTerms(d);
      try {
        if (d.editing) await POST('/api/war/peace/' + encodeURIComponent(d.editing) + '/revise', { terms });
        else await POST('/api/war/peace/offer', { conflict: key, from: d.from, to: d.to, terms });
        delete this._peaceDraft[key];
        toast(d.editing ? '🕊 Revision sent.' : `🕊 Your deal is on the table for ${entName(d.to)}.`);
        App.renderView();
      } catch (e) { toast(e.message, true); }
    },
    dealDraw(war, key) {
      const d = this._peaceDraft[key];
      if (!d || !window.Borders) return;
      const owners = this._dealRegionOwners(war, d.from, d.to);
      const keys = Object.keys(owners);
      if (!keys.length) return toast('Neither party holds territory on the map to redraw.', true);
      Borders.startPeace({
        keys, sideOf: owners, sideName: (id) => entName(id), virtual: null,
        initial: d.borders ? d.borders.regions : [], prefer: d.from,
        onDone: (regions) => { d.borders = regions.length ? { regions: regions.filter(r => r.shape) } : null; W.warRoomPeace = key; App.go('war'); },
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
