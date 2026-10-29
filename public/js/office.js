'use strict';
/* The Office (Phase 36) — every operator's own desk: a grid of widgets they
   add, drag into place, resize and restyle, to run their business from one
   page. Widgets only RENDER state the server already filtered for this
   operator and reuse the existing desks' actions (transfer/trade modals,
   trade accept/decline, the food release form…) — no new authority here.

   Layout persists on the user record (PUT /api/me/office — validated against
   the same TYPES/STYLES whitelist server-side, see server/api.js
   OFFICE_TYPES), so it follows the operator across devices. Keep TYPES' keys
   in lockstep with OFFICE_TYPES. */

const OFFICE_STYLES = [
  ['ledger', 'Ledger'], ['card', 'Card'], ['dark', 'Night desk'], ['telegram', 'Telegram'], ['accent', 'Dispatch']
];

const Office = {
  _local: null,        // this tab's latest layout — authoritative over W.me.office once edited
  _saveTimer: null,
  _drag: null,         // active pointer drag { card, pointerId }
  _settingsOpen: {},   // widget id → settings panel open
  _clockTimer: null,

  // ---- widget catalogue ----
  // avail(): whether this operator may add it (the server re-checks every
  // action anyway). render(body, w): fill the widget body.
  TYPES: {
    accounts: { label: 'Accounts', icon: '₳', desc: 'Your balances and a wire transfer button.', size: [1, 's'],
      render(body) {
        const chain = ownershipSetClient();
        const accts = (S().accounts || []).filter(a => isGM() ? a.ownerId === W.me.entityId : canSpendFromClient(a, chain));
        if (!accts.length) return Office.empty(body, 'You hold no accounts.');
        body.appendChild(el('table.data.ow-table', el('tbody', accts.map(a => el('tr',
          el('td', (a.ownerId === W.me.entityId ? '' : entName(a.ownerId) + ' — ') + a.name + (chain.has(a.ownerId) ? '' : ' (delegated)')),
          el('td.num', fmtMoney(a.balance)))))));
        body.appendChild(el('div.btn-row', el('button.solid-btn.btn-xs', { onclick: () => Views.transferModal() }, CUR() + ' Wire Transfer')));
      } },
    portfolio: { label: 'Portfolio', icon: '％', desc: 'Your shareholdings at live prices.', size: [2, 's'],
      render(body) {
        const me = W.me.entityId;
        const rows = S().entities.filter(c => c.type === 'company' && ((c.shareholders || []).some(x => x.entityId === me && x.shares > 0) || market_x100EntryOfClient(c, me)));
        if (!rows.length) return Office.empty(body, 'You hold no shares. Buy on the Exchange.');
        body.appendChild(el('table.data.ow-table',
          el('thead', el('tr', el('th', 'Company'), el('th.num', 'Shares'), el('th.num', 'Value'), el('th.num', 'Gain'))),
          el('tbody', rows.map(c => {
            const reg = (c.shareholders || []).find(x => x.entityId === me) || { shares: 0 };
            const entry = market_holdEntryOfClient(c, me);
            return el('tr.row-link', { onclick: () => Office.openExchange(c.id) },
              el('td', c.abbrev || c.name),
              el('td.num', fmtNum(reg.shares)),
              el('td.num', el('span', { 'data-hold-value': c.id }, CUR() + fmtNum(reg.shares * Views.livePrice(c)))),
              el('td.num', el('span', { 'data-hold-gain': c.id }, entry ? Views.holdGainText(reg.shares, entry, Views.livePrice(c)) : '—')));
          }))));
      } },
    quotes: { label: 'Market Watch', icon: '⇅', desc: 'Live quotes for the companies you pick.', size: [2, 'm'], settings: 'companies',
      render(body, w) {
        const pick = (w.opts && w.opts.companies) || [];
        const cos = S().entities.filter(c => c.type === 'company' && c.sharePrice !== undefined && (!pick.length || pick.includes(c.id)));
        if (!cos.length) return Office.empty(body, 'No listed companies.');
        body.appendChild(el('table.data.ow-table',
          el('tbody', cos.map(c => el('tr.row-link', { onclick: () => Office.openExchange(c.id) },
            el('td', el('b', c.abbrev || c.name)),
            el('td.num', Views.livePriceEl(c)),
            el('td', Views.miniSpark((c.dayHistory || []).concat([Views.livePrice(c)]), 80, 18)),
            el('td', el('div.qb-actions',
              el('button.solid-btn.btn-xs', { onclick: (e) => { e.stopPropagation(); Views.marketBuyModal(c); } }, 'Buy'),
              el('button.dash-btn.btn-xs', { onclick: (e) => { e.stopPropagation(); Views.marketSellModal(c); } }, 'Sell'))))))));
      } },
    inventory: { label: 'Stock Room', icon: '▣', desc: 'What you and your companies hold.', size: [2, 'm'],
      render(body) {
        const mine = actsForSetClient('trade');
        const rows = [];
        for (const e of S().entities) {
          if (!(isGM() ? e.id === W.me.entityId : mine.has(e.id))) continue;
          for (const r of (e.inventory || [])) {
            const it = itemById(r.itemId);
            if (it && r.qty > 0) rows.push({ e, it, qty: r.qty, val: r.qty * effPrice(it) });
          }
        }
        if (!rows.length) return Office.empty(body, 'Nothing on the shelves.');
        rows.sort((a, b) => b.val - a.val);
        body.appendChild(el('table.data.ow-table',
          el('thead', el('tr', el('th', 'Item'), el('th', 'Holder'), el('th.num', 'Qty'), el('th.num', 'Value'))),
          el('tbody', rows.slice(0, 30).map(r => el('tr.row-link', { onclick: () => select('item', r.it.id) },
            el('td', r.it.name), el('td', { style: 'color:var(--ink-soft);' }, r.e.abbrev || r.e.name),
            el('td.num', fmtNum(r.qty)), el('td.num', fmtMoney(r.val)))))));
        body.appendChild(el('div.btn-row', el('button.solid-btn.btn-xs', { onclick: () => Views.tradeModal() }, '▣ Send Items')));
      } },
    news: { label: 'Headlines', icon: '¶', desc: 'The latest published stories.', size: [2, 'm'],
      render(body) {
        const news = (S().news || []).filter(n => n.status === 'published').slice(-8).reverse();
        if (!news.length) return Office.empty(body, 'The presses are quiet.');
        for (const n of news) {
          const paper = (S().settings.newspapers || []).find(p => p.id === n.paperId);
          body.appendChild(el('div.ow-news', { onclick: () => App.go('news') },
            el('div.ow-news-h', n.headline),
            el('div.ow-news-m', [(paper && paper.name) || n.category || '', 'T' + (n.turn || '')].filter(Boolean).join(' · '))));
        }
      } },
    trades: { label: 'Trade Inbox', icon: '⇄', desc: 'Offers waiting on you — accept or decline here.', size: [2, 's'],
      render(body) {
        const inbox = Views.openIncomingTrades();
        const mine = actsForSetClient('trade');
        const sent = (S().trades || []).filter(t => t.status === 'open' && mine.has(t.fromEntityId)).length;
        if (!inbox.length) Office.empty(body, 'No offers waiting on you.');
        const itemTxt = (rows) => (rows || []).map(r => fmtNum(r.qty) + '× ' + ((itemById(r.itemId) || {}).name || r.itemId)).join(', ');
        for (const t of inbox) {
          const give = [itemTxt(t.give), t.money && t.money.give ? fmtMoney(t.money.give) : ''].filter(Boolean).join(' + ') || 'nothing';
          const get = [itemTxt(t.get), t.money && t.money.get ? fmtMoney(t.money.get) : ''].filter(Boolean).join(' + ') || 'nothing';
          body.appendChild(el('div.ow-trade',
            el('div', el('b', entName(t.fromEntityId)), ' → ', entName(t.toEntityId)),
            el('div', { style: 'font-size:12px; color:var(--ink-soft);' }, 'They give ' + give + ' · you give ' + get + (t.memo ? ' · “' + t.memo + '”' : '')),
            el('div.btn-row',
              el('button.solid-btn.btn-xs', { onclick: async () => { try { await POST('/api/trades/' + t.id + '/accept'); toast('Trade accepted.'); } catch (e) { toast(e.message, true); } } }, 'Accept'),
              el('button.dash-btn.btn-xs', { onclick: async () => { try { await POST('/api/trades/' + t.id + '/decline'); toast('Trade declined.'); } catch (e) { toast(e.message, true); } } }, 'Decline'))));
        }
        body.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:10px; color:var(--ink-faint); margin-top:6px;' },
          sent + ' offer(s) of yours awaiting a reply · ',
          el('a', { href: '#', onclick: (e) => { e.preventDefault(); W.ecoTab = 'trade'; App.go('economy'); } }, 'Player Trades →')));
      } },
    polling: { label: 'Polling', icon: '⚑', desc: 'National party support.', size: [1, 'm'], avail: () => !!(perms().statistics || isGM()),
      render(body) {
        const nat = (W.polling && W.polling.national) || {};
        const parties = S().entities.filter(e => e.type === 'party').sort((a, b) => (nat[b.id] || 0) - (nat[a.id] || 0));
        if (!parties.length) return Office.empty(body, 'No parties on file.');
        const top = Math.max(1, ...parties.map(p => nat[p.id] || 0));
        body.appendChild(el('table.data.ow-table', el('tbody', parties.map(p => el('tr.row-link', { onclick: () => select('entity', p.id) },
          el('td', { style: 'white-space:nowrap;' }, p.abbrev || p.name),
          el('td', { style: 'width:100%;' }, el('div.ow-bar', el('div', { style: `width:${(nat[p.id] || 0) / top * 100}%; background:${p.color || 'var(--accent)'};` }))),
          el('td.num', fmtNum(nat[p.id] || 0, 1) + '%'))))));
      } },
    parliament: { label: 'The Chamber', icon: '⌂', desc: 'Seats, government and majority at a glance.', size: [1, 's'],
      render(body) {
        const parties = S().entities.filter(e => e.type === 'party').sort((a, b) => (b.mpCount || 0) - (a.mpCount || 0));
        const seats = S().settings.parliamentSeats || 150;
        const gov = parties.filter(p => p.inGovernment);
        const govSeats = gov.reduce((t, p) => t + (p.mpCount || 0), 0);
        body.appendChild(el('div', { style: 'font-size:12px; margin-bottom:6px;' },
          'Government: ', el('b', gov.map(p => p.abbrev || p.name).join(' + ') || '—'), ` · ${govSeats}/${seats} seats (majority ${Math.floor(seats / 2) + 1})`));
        body.appendChild(el('table.data.ow-table', el('tbody', parties.map(p => el('tr.row-link', { onclick: () => select('entity', p.id) },
          el('td', el('span.exp-dot', { style: 'background:' + p.color }), ' ', p.abbrev || p.name),
          el('td.num', String(p.mpCount || 0)))))));
      } },
    food: { label: 'Food Distribution', icon: '❦', desc: 'Release grain and livestock from the national stockpile.', size: [2, 'm'],
      avail: () => Views.canFood(),
      render(body) {
        if (!Views.canFood()) return Office.empty(body, 'Your role does not run the food programme.');
        Views.foodDistribution(body);
      } },
    conflict: { label: 'Situation Room', icon: '⚔', desc: 'Live war and protest status, and what you may do.', size: [2, 's'],
      render(body) {
        const docs = [S().war, S().protest].filter(d => d && d.active);
        if (!docs.length) return Office.empty(body, 'No war or protest is under way.');
        for (const d of docs) {
          const st = d.stats || {};
          const p = d.protest || {};
          body.appendChild(el('div.ow-trade',
            el('div', el('b', (d.kind === 'protest' ? '⚒ ' : '⚔ ') + d.name), ' · tick ' + d.tick + (d.paused ? ' · PAUSED' : '')),
            el('div', { style: 'font-size:12px; color:var(--ink-soft);' }, d.kind === 'protest'
              ? `${p.protestorsViolent ? 'violent' : 'peaceful'} crowds · ${p.govViolent ? 'force authorized' : 'police holding'} · ${fmtNum((st.unrestCities || []).length)} cities in unrest`
              : `losses ${fmtNum(Math.round(st.attLosses || 0))} / ${fmtNum(Math.round(st.defLosses || 0))} · ${fmtNum((st.citiesHeld || []).length)} cities held`),
            el('div', { style: 'font-family:var(--font-mono); font-size:10px; color:var(--ink-faint);' }, War.authorityText(d))));
        }
        body.appendChild(el('div.btn-row', el('button.dash-btn.btn-xs', { onclick: () => App.go('war') }, 'War Room →')));
      } },
    notes: { label: 'Notepad', icon: '✎', desc: 'Private notes — only you see them.', size: [1, 'm'],
      render(body, w) {
        const t = el('textarea.text-input.ow-notes', { placeholder: 'Plans, deals, reminders…' });
        t.value = (w.opts && w.opts.text) || '';
        t.addEventListener('input', () => { w.opts = Object.assign({}, w.opts, { text: t.value.slice(0, 2500) }); Office.save(); });
        body.appendChild(t);
      } },
    clock: { label: 'Desk Clock', icon: '◔', desc: 'Turn, date, world time and market confidence.', size: [1, 's'],
      render(body) {
        const t = S().settings.time || {};
        const g = S().globalVars || {};
        body.appendChild(el('div.ow-clock', el('div.ow-clock-big', { 'data-office-clock': '1' }, Office.worldTime()),
          el('div', 'Turn ' + t.turn + ' · ' + fmtDate(t.date))));
        if (g.econConfidence !== undefined) body.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:10.5px; color:var(--ink-soft); margin-top:4px;' }, 'Economic confidence ' + fmtNum(g.econConfidence, 0) + '%'));
        Office.startClock();
      } },
    province: { label: 'Province Watch', icon: '◈', desc: 'Key figures for one province.', size: [1, 's'], settings: 'province',
      render(body, w) {
        const p = provById((w.opts && w.opts.provinceId) || '') || (S().provinces || [])[0];
        if (!p) return Office.empty(body, 'No provinces.');
        const v = p.vars || {};
        const rows = [['Population', fmtNum(v.population || 0)]];
        for (const [k, label] of [['happiness', 'Happiness'], ['approval', 'Gov. approval'], ['employment', 'Employment'], ['foodSecurity', 'Food security']]) {
          if (v[k] !== undefined) rows.push([label, fmtNum(v[k], 1) + '%']);
        }
        body.appendChild(el('div.ow-sub', { onclick: () => select('province', p.id) }, p.name + ' →'));
        body.appendChild(el('table.data.ow-table', el('tbody', rows.map(r => el('tr', el('td', r[0]), el('td.num', r[1]))))));
      } },
    dossier: { label: 'Pinned File', icon: '❐', desc: 'Pin any company, party, person or nation.', size: [1, 's'], settings: 'entity',
      render(body, w) {
        const e = entById((w.opts && w.opts.entityId) || '') || entById(W.me.entityId);
        if (!e) return Office.empty(body, 'Choose a file to pin (⚙).');
        const acct = (S().accounts || []).find(a => a.ownerId === e.id);
        body.appendChild(el('div.ow-sub', { onclick: () => select('entity', e.id) }, e.name + ' →'));
        const rows = [['Type', TYPE_LABEL[e.type] || e.type]];
        if (e.title) rows.push(['Title', e.title]);
        if (e.type === 'company') { rows.push(['Day price', CUR() + fmtNum(Views.livePrice(e))]); if (e.ceoId) rows.push(['CEO', entName(e.ceoId)]); }
        if (e.type === 'party') { rows.push(['Seats', String(e.mpCount || 0)]); if (e.leaderId) rows.push(['Leader', entName(e.leaderId)]); }
        if (acct) rows.push(['Balance', fmtMoney(acct.balance)]);
        body.appendChild(el('table.data.ow-table', el('tbody', rows.map(r => el('tr', el('td', r[0]), el('td.num', r[1]))))));
        if (e.description) body.appendChild(el('div', { style: 'font-size:12px; color:var(--ink-soft); margin-top:4px;' }, String(e.description).slice(0, 220)));
      } },
    ledger: { label: 'Ledger', icon: '≡', desc: 'Your most recent transactions.', size: [2, 'm'],
      render(body) {
        const chain = ownershipSetClient();
        const mineAcct = new Set((S().accounts || []).filter(a => chain.has(a.ownerId)).map(a => a.id));
        const txns = (S().transactions || []).filter(t => mineAcct.has(t.from) || mineAcct.has(t.to)).slice(-15).reverse();
        if (!txns.length) return Office.empty(body, 'No transactions on record.');
        body.appendChild(el('table.data.ow-table',
          el('tbody', txns.map(t => {
            const out = mineAcct.has(t.from) && !mineAcct.has(t.to);
            const other = out ? acctById(t.to) : acctById(t.from);
            return el('tr',
              el('td', { style: 'font-family:var(--font-mono); font-size:10px; white-space:nowrap;' }, 'T' + t.turn),
              el('td', (out ? 'to ' : 'from ') + (other ? entName(other.ownerId) : '—')),
              el('td.num', { style: 'color:' + (out ? 'var(--accent)' : 'var(--good)') }, (out ? '−' : '+') + fmtMoney(t.amount)),
              el('td', { style: 'font-size:11px; color:var(--ink-soft);' }, t.memo || ''));
          }))));
      } }
  },

  // ---- layout state ----
  defaults() {
    const out = ['accounts', 'clock', 'trades', 'portfolio', 'news', 'quotes'];
    if (Views.canFood()) out.splice(2, 0, 'food');
    if ((S().war && S().war.active) || (S().protest && S().protest.active)) out.splice(1, 0, 'conflict');
    if (perms().statistics || isGM()) out.push('polling');
    return out.map(t => this.make(t));
  },
  make(type) {
    const T = this.TYPES[type];
    return { id: 'ow' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type, w: T.size[0], h: T.size[1], style: 'ledger', title: '', opts: {} };
  },
  layout() {
    if (!this._local) {
      const saved = W.me && W.me.office && Array.isArray(W.me.office.widgets) ? W.me.office.widgets : null;
      this._local = saved ? JSON.parse(JSON.stringify(saved)).filter(w => this.TYPES[w.type]) : this.defaults();
    }
    return this._local;
  },
  // Debounced persist; the local copy is already live, so the page never
  // waits on the network (and a slow save can't snap a widget back).
  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(async () => {
      try {
        const r = await PUT('/api/me/office', { widgets: this._local });
        if (W.me) W.me.office = r.office;
      } catch (e) { toast('Office layout not saved: ' + e.message, true); }
    }, 500);
  },
  update(mut) { mut(this._local); this.save(); this.rerender(); },
  rerender() { if (W.view === 'office') App.renderView(); },
  // A sync re-render must not tear the page down mid-drag or mid-typing.
  busy() {
    if (this._drag) return true;
    const a = document.activeElement;
    return !!(a && a.closest && a.closest('.office-grid') && /^(TEXTAREA|INPUT|SELECT)$/.test(a.tagName));
  },

  // ---- helpers ----
  empty(body, text) { body.appendChild(el('div.ow-empty', text)); },
  openExchange(id) { W.ecoTab = 'exchange'; W.exchOpen = id; App.go('economy'); },
  worldTime() {
    const t = S().settings.time || {}, c = t.clock || {};
    if (!c.enabled) return 'paused';
    const rate = Math.max(0, Number(c.minutesPerRealMinute) || 59.5);
    const ms = Number.isFinite(Number(c.nowMs)) && Number.isFinite(Number(c.serverNowMs))
      ? Number(c.nowMs) + (Date.now() - Number(c.serverNowMs)) * rate
      : (Number(c.anchorWorldMs) || Date.now()) + (Date.now() - (Number(c.anchorRealMs) || Date.now())) * rate;
    return new Date(ms).toISOString().slice(11, 16);
  },
  startClock() {
    if (this._clockTimer) return;
    this._clockTimer = setInterval(() => {
      const nodes = document.querySelectorAll('[data-office-clock]');
      if (!nodes.length) { clearInterval(this._clockTimer); this._clockTimer = null; return; }
      nodes.forEach(n => { n.textContent = this.worldTime(); });
    }, 1000);
  },

  // ---- page ----
  render(inner) {
    const widgets = this.layout();
    const locked = (() => { try { return localStorage.getItem('arcasia-office-locked') === '1'; } catch (e) { return false; } })();
    inner.appendChild(el('div.doc-title', 'Your Office'));
    inner.appendChild(el('div.doc-sub', locked ? 'Layout locked — unlock to rearrange'
      : 'Drag a title bar to move a window · drag its corner ◢ to resize · ⚙ settings · ◐ style'));
    inner.appendChild(el('div.btn-row.office-bar',
      el('button.solid-btn', { onclick: () => this.catalogue() }, '+ Add widget'),
      el('button.dash-btn', { onclick: () => { try { localStorage.setItem('arcasia-office-locked', locked ? '0' : '1'); } catch (e) { } this.rerender(); } }, locked ? '🔓 Unlock layout' : '🔒 Lock layout'),
      el('button.dash-btn', { onclick: () => confirmModal('RESET OFFICE', 'Replace your widgets with the default desk for your role?', async () => { this._local = this.defaults(); this.save(); this.rerender(); }, 'Reset') }, 'Reset')));
    if (!widgets.length) {
      inner.appendChild(el('div.ow-empty', { style: 'padding:30px 0;' }, 'An empty desk. Add a widget to start.'));
      return;
    }
    const grid = el('div.office-grid', { class: locked ? 'locked' : '' });
    for (const w of widgets) grid.appendChild(this.card(w, locked));
    inner.appendChild(grid);
    if (widgets.some(w => w.type === 'quotes' || w.type === 'portfolio' || w.type === 'dossier')) Views.startPriceTicker();
  },

  card(w, locked) {
    const T = this.TYPES[w.type];
    const pxH = typeof w.h === 'number';
    const card = el('div.ow', { class: `ow-w${w.w} ${pxH ? 'ow-h-px' : 'ow-h-' + w.h} ow-style-${w.style}`, 'data-ow': w.id });
    const head = el('div.ow-head');
    if (!locked) {
      // the whole title bar is the drag handle (buttons excepted)
      head.classList.add('ow-draggable');
      head.title = 'Drag to move';
      head.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) this.dragStart(e, card); });
      head.appendChild(el('span.ow-handle', '⠿'));
    }
    head.appendChild(el('span.ow-title', (T.icon ? T.icon + ' ' : '') + (w.title || T.label)));
    if (!locked) {
      const btn = (label, title, fn) => el('button.ow-btn', { title, onclick: fn }, label);
      head.appendChild(el('span.ow-tools',
        btn('⚙', 'Settings', () => { this._settingsOpen[w.id] = !this._settingsOpen[w.id]; this.rerender(); }),
        btn('◐', 'Window style', () => this.update(() => {
          const i = OFFICE_STYLES.findIndex(s => s[0] === w.style);
          w.style = OFFICE_STYLES[(i + 1) % OFFICE_STYLES.length][0];
        })),
        btn('✕', 'Remove', () => this.update(list => { list.splice(list.indexOf(w), 1); }))));
    }
    card.appendChild(head);
    if (!locked && this._settingsOpen[w.id]) card.appendChild(this.settings(w));
    const body = el('div.ow-body');
    if (pxH) body.style.height = w.h + 'px';
    try { T.render(body, w); } catch (e) { body.appendChild(el('div.ow-empty', 'This widget could not draw: ' + e.message)); }
    card.appendChild(body);
    if (!locked) {
      // drag-to-scale: width snaps to grid columns, height is free;
      // double-click returns the window to its natural size
      const grip = el('span.ow-resize', { title: 'Drag to resize · double-click to reset' });
      grip.addEventListener('pointerdown', (e) => this.resizeStart(e, card, w));
      grip.addEventListener('dblclick', () => this.update(() => { w.h = this.TYPES[w.type].size[1]; }));
      card.appendChild(grip);
    }
    return card;
  },

  settings(w) {
    const T = this.TYPES[w.type];
    const box = el('div.ow-settings');
    const d = { title: w.title, style: w.style };
    box.appendChild(Forms.field('Title', Forms.text(d, 'title', T.label)));
    box.appendChild(Forms.field('Window style', Forms.sel(d, 'style', OFFICE_STYLES)));
    const opts = Object.assign({}, w.opts);
    if (T.settings === 'province') box.appendChild(Forms.field('Province', Forms.sel(opts, 'provinceId', S().provinces.map(p => [p.id, p.name]))));
    if (T.settings === 'entity') box.appendChild(Forms.field('File', Forms.sel(opts, 'entityId', Forms.entOptions())));
    if (T.settings === 'companies') {
      opts.companies = Array.isArray(opts.companies) ? opts.companies.slice() : [];
      const row = el('div.chip-row');
      for (const c of S().entities.filter(e => e.type === 'company')) {
        row.appendChild(el('button.chip', { class: opts.companies.includes(c.id) ? 'active' : '', onclick: (e) => {
          const i = opts.companies.indexOf(c.id);
          if (i >= 0) opts.companies.splice(i, 1); else opts.companies.push(c.id);
          e.currentTarget.classList.toggle('active');
        } }, c.abbrev || c.name));
      }
      box.appendChild(Forms.field('Companies (none = all)', row));
    }
    box.appendChild(el('div.btn-row',
      el('button.solid-btn.btn-xs', { onclick: () => {
        this._settingsOpen[w.id] = false;
        this.update(() => { w.title = String(d.title || '').slice(0, 40); w.style = d.style; w.opts = opts; });
      } }, 'Apply'),
      el('button.dash-btn.btn-xs', { onclick: () => { this._settingsOpen[w.id] = false; this.rerender(); } }, 'Cancel')));
    return box;
  },

  catalogue() {
    const have = new Set(this.layout().map(w => w.type));
    const list = el('div.ow-catalogue');
    for (const [type, T] of Object.entries(this.TYPES)) {
      if (T.avail && !T.avail()) continue;
      list.appendChild(el('div.ow-cat-item', { onclick: () => {
        if (this.layout().length >= 24) return toast('An office holds at most 24 widgets.', true);
        this.update(l => l.push(this.make(type)));
        clear(document.getElementById('modal-root'));
        toast(T.label + ' added.');
      } },
        el('span.ow-cat-icon', T.icon || '•'),
        el('span', el('b', T.label), have.has(type) ? el('span.qb-sub', 'on your desk — add another') : null, el('div', { style: 'font-size:12px; color:var(--ink-soft);' }, T.desc))));
    }
    openModal('ADD A WIDGET', list, [{ label: 'Done', cls: 'dash-btn', onClick: () => { } }], true);
  },

  // ---- drag & drop (pointer events: mouse, pen and touch alike) ----
  // The card lifts out of the grid and follows the pointer (position:fixed,
  // translated per frame); a dashed placeholder holds its slot, and the
  // other cards glide out of the way (FLIP: measure, move, animate the
  // difference). Release settles the card into the placeholder. A 5px
  // threshold keeps a plain click on the title bar a click.
  _flip(grid, mutate) {
    const kids = [...grid.children];
    const before = new Map(kids.map(k => [k, k.getBoundingClientRect()]));
    mutate();
    for (const k of kids) {
      const a = before.get(k), b = k.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (!dx && !dy) continue;
      k.style.transition = 'none';
      k.style.transform = `translate(${dx}px, ${dy}px)`;
      k.getBoundingClientRect(); // commit the inverted position before animating
      k.style.transition = 'transform 180ms cubic-bezier(.2,.7,.3,1)';
      k.style.transform = '';
    }
  },
  dragStart(e, card) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const grid = card.parentNode;
    const st = this._drag = { card, grid, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, started: false, ph: null, raf: 0, lastX: e.clientX, lastY: e.clientY };
    const begin = () => {
      st.started = true;
      const r = card.getBoundingClientRect();
      st.rect = r;
      st.ph = el('div.ow-placeholder', { class: [...card.classList].filter(c => /^ow-w\d$/.test(c)).join(' ') });
      st.ph.style.height = r.height + 'px';
      grid.insertBefore(st.ph, card);
      grid.parentNode.appendChild(card); // out of the grid, still inside the view's styles
      Object.assign(card.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', zIndex: 200, margin: 0, pointerEvents: 'none' });
      card.classList.add('ow-floating');
      document.body.classList.add('ow-dragging-cursor');
    };
    const place = () => {
      st.raf = 0;
      card.style.transform = `translate(${st.lastX - st.x0}px, ${st.lastY - st.y0}px) rotate(.6deg) scale(1.02)`;
      // Hit-test on layout boxes (offsetLeft/Top ignore the FLIP transforms
      // of cards still gliding), and treat "over the placeholder" as settled
      // so cards of different widths can't bounce the slot back and forth.
      const gr = grid.getBoundingClientRect();
      const x = st.lastX - gr.left, y = st.lastY - gr.top;
      const hit = (k) => x >= k.offsetLeft && x <= k.offsetLeft + k.offsetWidth && y >= k.offsetTop && y <= k.offsetTop + k.offsetHeight;
      if (!hit(st.ph)) {
        const kids = [...grid.querySelectorAll('.ow')];
        const over = kids.find(hit);
        if (over) {
          const after = x > over.offsetLeft + over.offsetWidth / 2;
          const ref = after ? over.nextSibling : over;
          if (ref !== st.ph && (after ? over.nextSibling : over.previousSibling) !== st.ph) {
            this._flip(grid, () => grid.insertBefore(st.ph, ref));
          }
        } else if (kids.length && y > Math.max(...kids.map(k => k.offsetTop + k.offsetHeight)) && grid.lastChild !== st.ph) {
          this._flip(grid, () => grid.appendChild(st.ph)); // below everything: drop at the end
        }
      }
      // keep the page scrolling while the pointer rests near its edges
      const dv = grid.closest('.doc-view');
      if (dv) {
        const r = dv.getBoundingClientRect();
        const dy = st.lastY < r.top + 60 ? -12 : st.lastY > r.bottom - 60 ? 12 : 0;
        if (dy) { dv.scrollTop += dy; st.raf = requestAnimationFrame(place); }
      }
    };
    const move = (ev) => {
      if (ev.pointerId !== st.pointerId) return;
      st.lastX = ev.clientX; st.lastY = ev.clientY;
      if (!st.started) {
        if (Math.hypot(ev.clientX - st.x0, ev.clientY - st.y0) < 5) return;
        begin();
      }
      if (!st.raf) st.raf = requestAnimationFrame(place);
    };
    const up = (ev) => {
      if (ev.pointerId !== st.pointerId) return;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      if (st.raf) cancelAnimationFrame(st.raf);
      if (!st.started) { this._drag = null; return; }
      // glide into the placeholder, then drop it in for real
      const gr = grid.getBoundingClientRect();
      const target = { left: gr.left + st.ph.offsetLeft, top: gr.top + st.ph.offsetTop };
      card.style.transition = 'transform 160ms ease-out';
      card.style.transform = `translate(${target.left - st.rect.left}px, ${target.top - st.rect.top}px)`;
      setTimeout(() => {
        grid.insertBefore(card, st.ph);
        st.ph.remove();
        card.removeAttribute('style');
        card.classList.remove('ow-floating');
        document.body.classList.remove('ow-dragging-cursor');
        this._drag = null;
        const order = [...grid.querySelectorAll('.ow')].map(n => n.getAttribute('data-ow'));
        const byId = Object.fromEntries(this._local.map(w => [w.id, w]));
        const next = order.map(id => byId[id]).filter(Boolean);
        if (next.length === this._local.length && next.some((w, i) => w !== this._local[i])) {
          this._local = next;
          this.save();
        }
        this.rerender();
      }, 170);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  },

  // ---- drag-to-scale ----
  // Width snaps to whole grid columns as you drag (live), height follows the
  // pointer freely (80–1100px). On a 2-column screen a "full" span keeps the
  // widget wide on desktop too; phones only resize height.
  resizeStart(e, card, w) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const grid = card.parentNode;
    const gs = getComputedStyle(grid);
    const cols = gs.gridTemplateColumns.split(' ').filter(Boolean).length || 1;
    const gap = parseFloat(gs.columnGap) || 14;
    const colW = (grid.getBoundingClientRect().width - gap * (cols - 1)) / cols;
    const body = card.querySelector('.ow-body');
    const r = card.getBoundingClientRect();
    const st = this._drag = { resize: true, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY,
      w0: r.width, h0: body.getBoundingClientRect().height, span: Math.max(1, Math.round((r.width + gap) / (colW + gap))), h: null, raf: 0 };
    card.classList.add('ow-resizing');
    document.body.classList.add('ow-resize-cursor');
    const badge = el('span.ow-size-badge');
    card.appendChild(badge);
    let lastX = e.clientX, lastY = e.clientY;
    const apply = () => {
      st.raf = 0;
      const span = Math.max(1, Math.min(cols, Math.round((st.w0 + lastX - st.x0 + gap) / (colW + gap))));
      const h = Math.max(80, Math.min(1100, Math.round(st.h0 + lastY - st.y0)));
      if (cols > 1 && span !== st.span) this._flip(grid, () => { card.style.gridColumn = 'span ' + span; });
      st.span = span; st.h = h;
      body.style.height = h + 'px'; body.style.maxHeight = 'none';
      badge.textContent = (cols > 1 ? span + ' col' + (span > 1 ? 's' : '') + ' · ' : '') + h + 'px';
    };
    const move = (ev) => {
      if (ev.pointerId !== st.pointerId) return;
      lastX = ev.clientX; lastY = ev.clientY;
      if (!st.raf) st.raf = requestAnimationFrame(apply);
    };
    const up = (ev) => {
      if (ev.pointerId !== st.pointerId) return;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      if (st.raf) { cancelAnimationFrame(st.raf); apply(); }
      document.body.classList.remove('ow-resize-cursor');
      card.classList.remove('ow-resizing');
      badge.remove();
      this._drag = null;
      // a plain click leaves the DOM alone so a double-click can still reset
      if (st.h === null) return;
      if (cols === 4) w.w = st.span;
      else if (cols === 2) w.w = st.span === 2 ? Math.max(2, w.w) : 1;
      w.h = st.h;
      this.save();
      this.rerender();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }
};
