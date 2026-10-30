'use strict';
/* The Office (Phase 36) — every operator's own desk: a free-placement canvas
   of widgets they add, drag anywhere, resize and restyle, to run their
   business from one page. Widgets only RENDER state the server already filtered for this
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
    military: { label: 'Armed Forces', icon: '✠', desc: 'A nation’s arsenal and forces in the field, with the record over time.', size: [2, 's'], settings: 'nation',
      avail: () => !!(window.War && War.milNations && War.milNations().length),
      render(body, w) {
        const list = window.War && War.milNations ? War.milNations() : [];
        if (!list.length) return Office.empty(body, 'No arsenal is on file with you.');
        const n = list.find(x => x.id === (w.opts && w.opts.entityId)) || list[0];
        const t = War.milTotals(n.id);
        body.appendChild(el('div', { style: 'font-size:12.5px; margin-bottom:4px;' }, el('b', n.name),
          el('span', { style: 'color:var(--ink-faint); font-family:var(--font-mono); font-size:10px;' }, War.milAccess(n.id) ? '  · your forces' : '  · on file')));
        const rows = (S().militaryLog || []).filter(r => r.n[n.id]);
        const cell = (label, v, col) => el('div.ow-mil-cell', el('div.k', label), el('div.v', v),
          rows.length >= 2 ? Views.miniSpark(rows.map(r => r.n[n.id][col]), 70, 16) : null);
        body.appendChild(el('div.ow-mil-grid',
          cell('Soldiers', fmtCompact(t.men), 5), cell('Rifles', fmtCompact(t.all('smallarms')), 0), cell('Tanks', fmtCompact(t.all('tank')), 1),
          cell('Ships', fmtCompact(t.all('warship')), 2), cell('Aircraft', fmtCompact(t.all('aircraft')), 3), cell('Fuel', fmtCompact(t.all('fuel')), 4)));
        const fronts = War.milLiveDocs().filter(d => (d.units || []).some(u => War.milNationOf(d, u) === n.id && !u.dead && u.strength > 0));
        for (const d of fronts) {
          const us = d.units.filter(u => War.milNationOf(d, u) === n.id && !u.dead && u.strength > 0);
          const cut = us.filter(u => u.supplied === false).length;
          body.appendChild(el('div', { style: 'font-size:12px; color:var(--ink-soft); margin-top:4px;' },
            (d.kind === 'protest' ? '⚒ ' : '⚔ ') + `${d.name}: ${us.length} formation${us.length === 1 ? '' : 's'} in the field${cut ? ` · ${cut} cut off` : ''}`));
        }
        body.appendChild(el('div.btn-row', el('button.dash-btn.btn-xs', { onclick: () => { W.warTab = 'military'; W.milNation = n.id; App.go('war'); } }, 'Military desk →')));
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
    holdings: { label: 'Holdings Desk', icon: '⌘', desc: 'Run and trade what you control — companies, properties, parties and groups, shares.', size: [2, 'm'],
      avail: () => Office.holdings().total > 0 || isGM(),
      render(body, w) {
        const H = Office.holdings();
        const tabs = [['companies', 'Companies', H.companies], ['properties', 'Properties', H.properties], ['groups', 'Groups', H.groups], ['shares', 'Shares', H.shares]];
        let tab = (w.opts && w.opts.tab) || (tabs.find(t => t[2].length) || tabs[0])[0];
        const setTab = (k) => Office.update(() => { w.opts = Object.assign({}, w.opts, { tab: k }); });
        body.appendChild(el('div.chip-row.ow-chips', tabs.map(([k, label, list]) =>
          el('button.chip', { class: tab === k ? 'active' : '', onclick: () => setTab(k) }, label + (list.length ? ' ' + list.length : '')))));
        // desk-wide actions: the same modals the Economy desks use
        body.appendChild(el('div.btn-row.ow-actions',
          el('button.dash-btn.btn-xs', { onclick: () => Views.tradeOfferComposer() }, '⇄ Trade offer'),
          el('button.dash-btn.btn-xs', { onclick: () => Views.tradeModal() }, '▣ Send goods'),
          el('button.dash-btn.btn-xs', { onclick: () => Views.transferModal() }, '₳ Wire money')));
        const btn = (label, title, fn) => el('button.ow-btn.ow-act', { title, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
        const balOf = (id) => (S().accounts || []).filter(a => a.ownerId === id).reduce((s, a) => s + (a.balance || 0), 0);
        const table = (head, rows) => body.appendChild(el('table.data.ow-table',
          el('thead', el('tr', head.map(h => el(h.startsWith('#') ? 'th.num' : 'th', h.replace(/^#/, ''))))), el('tbody', rows)));
        const more = (n) => n > 40 ? body.appendChild(el('div.ow-empty', `…and ${n - 40} more — see the Economy desks.`)) : null;
        if (tab === 'companies') {
          if (!H.companies.length) return Office.empty(body, 'You direct no company.');
          table(['Company', '#Price', '#Cash', ''], H.companies.slice(0, 40).map(c => el('tr.row-link', { onclick: () => select('entity', c.id) },
            el('td', c.abbrev || c.name),
            el('td.num', c.sharesOutstanding ? el('span.live-price', { 'data-co': c.id }, CUR() + fmtNum(Views.livePrice(c))) : '—'),
            el('td.num', fmtMoney(balOf(c.id))),
            el('td.ow-acts',
              btn('⚙', 'Operations desk', () => { W.ecoTab = 'company'; W.opsCo = c.id; W.opsDraft = null; App.go('economy'); }),
              btn('⇄', 'Trade offer from ' + c.name, () => Views.tradeOfferComposer(c.id)),
              c.sharesOutstanding && ownership_controlsClient(W.me.entityId, c.id) || (isGM() && c.sharesOutstanding) ? btn('＋', 'Raise capital (issue shares)', () => Views.marketOfferModal(c)) : null))));
          more(H.companies.length);
        } else if (tab === 'properties') {
          if (!H.properties.length) return Office.empty(body, 'You control no property.');
          table(['Property', 'Owner', '#Staff', ''], H.properties.slice(0, 40).map(pr => {
            const deed = (S().items || []).find(i => i.meta && i.meta.propertyId === pr.id);
            return el('tr.row-link', { onclick: () => select('property', pr.id) },
              el('td', pr.name, el('div.ow-sub-line', (pr.kind || '') + (provById(pr.provinceId) ? ' · ' + provById(pr.provinceId).name : ''))),
              el('td', entName(pr.ownerId)),
              el('td.num', fmtNum(pr.employees || 0)),
              el('td.ow-acts',
                btn('⚙', 'Property operations', () => { W.ecoTab = 'property'; W.opsProp = pr.id; W.propOpsDraft = null; App.go('economy'); }),
                btn('◎', 'Show on the map', () => { App.go('map'); setTimeout(() => select('property', pr.id), 300); }),
                deed ? btn('⇄', 'Sell or transfer the deed', () => Views.tradeModal(deed.id, null, pr.ownerId)) : null));
          }));
          more(H.properties.length);
        } else if (tab === 'groups') {
          if (!H.groups.length) return Office.empty(body, 'You lead no party, organisation or government.');
          table(['Group', 'Type', '#Funds', ''], H.groups.slice(0, 40).map(g => el('tr.row-link', { onclick: () => select('entity', g.id) },
            el('td', g.name),
            el('td', (TYPE_LABEL[g.type] || g.type) + (g.type === 'party' ? ' · ' + (g.mpCount || 0) + ' MPs' : '')),
            el('td.num', fmtMoney(balOf(g.id))),
            el('td.ow-acts',
              btn('⇄', 'Trade offer from ' + g.name, () => Views.tradeOfferComposer(g.id)),
              (g.inventory || []).length ? btn('▣', 'Send goods from ' + g.name, () => Views.tradeModal(null, null, g.id)) : null,
              btn('₳', 'Wire money', () => Views.transferModal())))));
          more(H.groups.length);
        } else {
          if (!H.shares.length) return Office.empty(body, 'No shareholdings across your holdings.');
          table(['Holding', 'Holder', '#Shares', '#Value', ''], H.shares.slice(0, 40).map(({ c, holder, shares }) => el('tr.row-link', { onclick: () => Office.openExchange(c.id) },
            el('td', c.abbrev || c.name),
            el('td', entName(holder)),
            el('td.num', fmtNum(shares)),
            el('td.num', CUR() + fmtNum(shares * Views.livePrice(c))),
            el('td.ow-acts',
              btn('＋', 'Buy more', () => Views.marketBuyModal(c)),
              btn('−', 'Sell', () => Views.marketSellModal(c))))));
          more(H.shares.length);
        }
      } },
    ledger: { label: 'Ledger', icon: '≡', desc: 'Everything you did and everything that touched your holdings — money, trades, goods, shares, politics.', size: [2, 'm'],
      render(body, w) {
        const view = (w.opts && w.opts.view) || 'all';
        const me = W.me.displayName;
        const byMe = (t) => t.actor === me || t.actor === 'GM ' + me;
        const chain = ownershipSetClient();
        const mineAcct = new Set((S().accounts || []).filter(a => chain.has(a.ownerId)).map(a => a.id));
        const chips = el('div.chip-row.ow-chips');
        for (const [k, label] of [['all', 'All'], ['money', 'Money'], ['record', 'Record'], ['mine', 'By me']]) {
          chips.appendChild(el('button.chip', { class: view === k ? 'active' : '', onclick: () => Office.update(() => { w.opts = Object.assign({}, w.opts, { view: k }); }) }, label));
        }
        body.appendChild(chips);
        const rows = [];
        if (view === 'all' || view === 'money') {
          for (const t of (S().transactions || [])) {
            if (!mineAcct.has(t.from) && !mineAcct.has(t.to)) continue;
            const out = mineAcct.has(t.from) && !mineAcct.has(t.to);
            const internal = mineAcct.has(t.from) && mineAcct.has(t.to);
            const other = out ? acctById(t.to) : acctById(t.from);
            const who = internal ? 'between your accounts' : other ? (out ? 'to ' : 'from ') + entName(other.ownerId) : '';
            rows.push({ ts: t.ts, turn: t.turn, badge: '₳', text: [who, t.memo || (out ? 'paid out' : 'income')].filter(Boolean).join(' · '),
              amt: (internal ? '' : out ? '−' : '+') + fmtMoney(t.amount), color: internal ? 'var(--ink-soft)' : out ? 'var(--accent)' : 'var(--good)', actor: t.actor });
          }
        }
        if (view !== 'money') {
          // money lines the engine mirrors into the record are already shown
          // above as signed amounts — skip their timeline echo in "All"
          const txnEcho = (t) => t.type === 'economy' && /(transferred|deposited|withdrawn)$/.test(t.title);
          for (const t of (S().timeline || [])) {
            const mine = byMe(t);
            if (view === 'mine' ? !mine : !(mine || (t.refs && t.refs.some(r => chain.has(r))))) continue;
            if (view === 'all' && txnEcho(t)) continue;
            rows.push({ ts: t.ts, turn: t.turn, badge: t.type, text: t.title + (t.detail ? ' — ' + t.detail : ''), actor: t.actor });
          }
        }
        rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        if (!rows.length) return Office.empty(body, view === 'mine' ? 'Nothing done by you on record yet.' : 'Nothing on record yet.');
        body.appendChild(el('table.data.ow-table', el('tbody', rows.slice(0, 40).map(r => el('tr',
          el('td', { style: 'font-family:var(--font-mono); font-size:10px; white-space:nowrap; vertical-align:top;' }, 'T' + r.turn),
          el('td', { style: 'vertical-align:top;' }, el('span.tl-badge', r.badge)),
          el('td', { style: 'font-size:12px;' }, r.text, r.actor && view !== 'mine' && !byMe(r) && !/^[A-Z][A-Z ]+$/.test(r.actor) ? el('span', { style: 'color:var(--ink-faint); font-size:10.5px;' }, ' · ' + r.actor) : null),
          el('td.num', { style: 'white-space:nowrap; vertical-align:top;' + (r.color ? 'color:' + r.color : '') }, r.amt || ''))))));
        if (can('timeline')) body.appendChild(el('div', { style: 'margin-top:6px; font-size:11.5px;' }, el('a', { href: '#', onclick: (e) => { e.preventDefault(); App.go('timeline'); } }, 'The full Record →')));
      } }
  },

  // ---- layout state ----
  defaults() {
    const out = ['accounts', 'clock', 'trades', 'portfolio', 'news', 'quotes'];
    if (Views.canFood()) out.splice(2, 0, 'food');
    if ((S().war && S().war.active) || (S().protest && S().protest.active)) out.splice(1, 0, 'conflict');
    if (this.holdings().total > 0) out.splice(out.indexOf('portfolio'), 1, 'holdings');
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
  // Everything this operator can run: the same lists the Economy desks use
  // (opsCompanies/opsProperties honour the control chain and delegated
  // grants), plus parties/organisations/governments they control or lead,
  // plus every share position held anywhere in their chain.
  holdings() {
    const st = S();
    if (!st) return { companies: [], properties: [], groups: [], shares: [], total: 0 };
    const me = W.me && W.me.entityId;
    const chain = ownershipSetClient();
    const companies = Views.opsCompanies();
    const properties = Views.opsProperties();
    const groups = st.entities.filter(e => ['party', 'org', 'government'].includes(e.type) &&
      (isGM() || (me && (chain.has(e.id) || e.leaderId === me || e.ceoId === me || grantCoversClient(e.id, 'trade')))));
    const shares = [];
    for (const c of st.entities) {
      if (c.type !== 'company') continue;
      for (const h of (c.shareholders || [])) if (h.shares > 0 && chain.has(h.entityId)) shares.push({ c, holder: h.entityId, shares: h.shares });
    }
    return { companies, properties, groups, shares, total: companies.length + properties.length + groups.length + shares.length };
  },
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
    const res = this.arrange(grid);
    // first desktop render of widgets that have no spot yet (new, or saved
    // before free placement): keep the slot they were packed into
    if (res.g.cols === 4 && res.items.some(it => !Number.isFinite(it.w.y))) {
      for (const it of res.items) if (!Number.isFinite(it.w.y)) { it.w.x = it.rx; it.w.y = it.ry; }
      this.save();
    }
    requestAnimationFrame(() => grid.classList.add('ready')); // animate moves from now on, not the first paint
    this.observe(grid);
    if (widgets.some(w => ['quotes', 'portfolio', 'dossier', 'holdings'].includes(w.type))) Views.startPriceTicker();
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
    if (T.settings === 'nation' && window.War && War.milNations) box.appendChild(Forms.field('Nation', Forms.sel(opts, 'entityId', War.milNations().map(e => [e.id, e.name]))));
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

  // ---- free-placement canvas ----
  // Widgets sit on a canvas of N columns (4 on a desk, 2 on a tablet, 1 on a
  // phone) at absolute positions: x = column, y = pixels from the top. On
  // the 4-column desk placement is FREE — a window stays wherever it was
  // dropped, empty space included; overlaps are resolved by pushing the
  // lower window down. Narrower screens can't honour desk coordinates, so
  // they keep the desk's reading order and pack windows upward (gravity).
  // Heights are whatever the content measures (ResizeObserver re-arranges
  // when a widget grows), so only x/y/w/h are stored.
  GAP: 14,
  SNAP: 10,
  geom(grid) {
    const width = grid.clientWidth || 1;
    const cols = width >= 860 ? 4 : width >= 480 ? 2 : 1;
    const gap = cols === 1 ? 10 : this.GAP;
    return { width, cols, gap, colW: (width - gap * (cols - 1)) / cols };
  },
  spanFor(w, cols) { return Math.max(1, Math.min(Math.round(w.w) || 1, cols)); },
  xFor(w, cols, span) {
    if (cols === 1) return 0;
    const x = Number.isFinite(w.x) ? w.x : 0;
    return Math.max(0, Math.min(cols === 4 ? x : (x >= 2 ? 1 : 0), cols - span));
  },
  // items: [{ id, x, y|null, span, h, pinned }] → Map id → { x, y }
  solve(items, cols, gap, free) {
    const placed = [];
    const out = new Map();
    const hits = (x, span, y, h) => placed.filter(p => x < p.x + p.span && p.x < x + span && y < p.y + p.h + gap && p.y < y + h + gap);
    const put = (it, x, y) => { placed.push({ x, span: it.span, y, h: it.h }); out.set(it.id, { x, y }); };
    const settle = (it, y) => { for (let guard = 0; guard < 500; guard++) { const hs = hits(it.x, it.span, y, it.h); if (!hs.length) break; y = Math.max(...hs.map(p => p.y + p.h + gap)); } return y; };
    for (const it of items) if (it.pinned) put(it, it.x, it.y);
    const rest = items.filter(i => !i.pinned && i.y !== null).sort((a, b) => a.y - b.y || a.x - b.x);
    const fresh = items.filter(i => !i.pinned && i.y === null);
    if (!free) {
      // narrow screens: keep reading order — no window may sit above the one
      // before it (else a short widget leaps into an earlier hole); windows
      // without a desk spot take whichever column lets them sit highest
      let floor = 0;
      for (const it of rest.concat(fresh)) {
        const xs = it.y === null ? [...Array(cols - it.span + 1).keys()] : [it.x];
        let best = null;
        for (const x of xs) { it.x = x; const y = settle(it, floor); if (!best || y < best.y) best = { x, y }; }
        it.x = best.x;
        put(it, best.x, best.y);
        floor = best.y;
      }
      return out;
    }
    for (const it of rest) put(it, it.x, settle(it, it.y));
    // windows with no spot yet take the first gap, top-to-bottom, left-to-right
    for (const it of fresh) {
      const ys = [0, ...placed.map(p => p.y + p.h + gap)].sort((a, b) => a - b);
      let spot = null;
      for (const y of ys) {
        for (let x = 0; x + it.span <= cols; x++) if (!hits(x, it.span, y, it.h).length) { spot = { x, y }; break; }
        if (spot) break;
      }
      it.x = spot ? spot.x : 0;
      put(it, it.x, spot ? spot.y : Math.max(0, ...placed.map(p => p.y + p.h + gap)));
    }
    return out;
  },
  // Lay the canvas out. opts.pin {id,x,y,float} holds one window at a spot
  // (float: it is being dragged — leave its DOM position to the pointer);
  // opts.span {id,span} overrides a width mid-resize; opts.heights reuses
  // measurements taken at drag start (no layout thrash per frame).
  arrange(grid, opts) {
    opts = opts || {};
    const g = this.geom(grid);
    const cards = new Map([...grid.children].filter(c => c.classList.contains('ow')).map(c => [c.getAttribute('data-ow'), c]));
    const items = [];
    for (const w of this._local || []) {
      const c = cards.get(w.id);
      if (!c) continue;
      const span = opts.span && opts.span.id === w.id ? opts.span.span : this.spanFor(w, g.cols);
      const floating = opts.pin && opts.pin.float && opts.pin.id === w.id;
      if (!floating) c.style.width = (span * g.colW + (span - 1) * g.gap) + 'px';
      items.push({ id: w.id, w, c, span, x: this.xFor(w, g.cols, span), y: Number.isFinite(w.y) ? w.y : null });
    }
    for (const it of items) it.h = (opts.heights && opts.heights.get(it.id)) || it.c.offsetHeight;
    if (opts.pin) {
      const it = items.find(i => i.id === opts.pin.id);
      if (it) { it.pinned = true; it.x = opts.pin.x; it.y = opts.pin.y; }
    }
    const pos = this.solve(items, g.cols, g.gap, g.cols === 4);
    let bottom = 0;
    for (const it of items) {
      const p = pos.get(it.id);
      it.rx = p.x; it.ry = p.y;
      bottom = Math.max(bottom, p.y + it.h);
      if (opts.pin && opts.pin.float && it.id === opts.pin.id) continue;
      it.c.style.left = (p.x * (g.colW + g.gap)) + 'px';
      it.c.style.top = p.y + 'px';
    }
    grid.style.height = Math.max(bottom, opts.minHeight || 0) + 'px';
    return { g, items, pos, bottom };
  },
  // Re-arrange when the canvas width changes (window resize → column
  // count) or a widget's content grows/shrinks.
  observe(grid) {
    if (this._ro) this._ro.disconnect();
    if (typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const ro = this._ro = new ResizeObserver(() => {
      if (this._drag || raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!grid.isConnected) { ro.disconnect(); return; }
        if (!this._drag) this.arrange(grid);
      });
    });
    ro.observe(grid);
    for (const c of grid.children) if (c.classList.contains('ow')) ro.observe(c);
  },
  // Persist a finished arrangement. The desk stores exact spots; a narrow
  // screen only changes ORDER, so it hands the desk's existing slots out in
  // the new visual order (the desk view stays tidy instead of inheriting
  // phone-stacked coordinates).
  commit(res) {
    const { g, items } = res;
    if (g.cols === 4) {
      for (const it of items) { it.w.x = it.rx; it.w.y = it.ry; }
    } else {
      const slots = items.map(it => ({ x: Number.isFinite(it.w.x) ? it.w.x : 0, y: Number.isFinite(it.w.y) ? it.w.y : null }))
        .sort((a, b) => (a.y === null) - (b.y === null) || a.y - b.y || a.x - b.x);
      const order = items.slice().sort((a, b) => a.ry - b.ry || a.rx - b.rx);
      order.forEach((it, i) => { it.w.x = slots[i].x; if (slots[i].y === null) delete it.w.y; else it.w.y = slots[i].y; });
      // keep the list in visual order too (catalogue/reset logic reads it)
      this._local = order.map(it => it.w).concat(this._local.filter(w => !order.some(it => it.w === w)));
    }
    this.save();
  },

  // ---- drag (pointer events: mouse, pen and touch alike) ----
  // Past a 5px threshold the window lifts and follows the pointer freely; a
  // dashed placeholder shows the snapped spot (column + 10px rows) and the
  // other windows glide out of its way (CSS transitions on left/top).
  // Release settles the window into the placeholder.
  dragStart(e, card) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const grid = card.parentNode;
    const id = card.getAttribute('data-ow');
    const st = this._drag = { pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastY: e.clientY, started: false, raf: 0, target: null, res: null };
    const begin = () => {
      st.started = true;
      const gr = grid.getBoundingClientRect();
      st.grabX = st.x0 - gr.left - card.offsetLeft;
      st.grabY = st.y0 - gr.top - card.offsetTop;
      st.g = this.geom(grid);
      st.heights = new Map([...grid.children].filter(c => c.classList.contains('ow')).map(c => [c.getAttribute('data-ow'), c.offsetHeight]));
      const w = this._local.find(x => x.id === id);
      st.span = this.spanFor(w, st.g.cols);
      st.ph = el('div.ow-placeholder');
      Object.assign(st.ph.style, { width: card.offsetWidth + 'px', height: card.offsetHeight + 'px', left: card.style.left, top: card.style.top });
      grid.appendChild(st.ph);
      card.classList.add('ow-floating');
      document.body.classList.add('ow-dragging-cursor');
    };
    const place = () => {
      st.raf = 0;
      const g = st.g, gr = grid.getBoundingClientRect();
      const left = Math.max(0, Math.min(g.width - card.offsetWidth, st.lastX - gr.left - st.grabX));
      const top = Math.max(0, st.lastY - gr.top - st.grabY);
      card.style.left = left + 'px';
      card.style.top = top + 'px';
      const x = Math.max(0, Math.min(g.cols - st.span, Math.round(left / (g.colW + g.gap))));
      const y = Math.max(0, Math.round(top / this.SNAP) * this.SNAP);
      const room = top + card.offsetHeight + 160; // canvas grows so you can drop below the last window
      if (!st.target || st.target.x !== x || st.target.y !== y) {
        st.target = { x, y };
        st.res = this.arrange(grid, { pin: { id, x, y, float: true }, heights: st.heights, minHeight: room });
        const p = st.res.pos.get(id);
        st.ph.style.left = (p.x * (g.colW + g.gap)) + 'px';
        st.ph.style.top = p.y + 'px';
      } else if (room > (parseFloat(grid.style.height) || 0)) grid.style.height = room + 'px';
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
      // glide into the placeholder (the canvas transitions left/top)
      const p = st.res && st.res.pos.get(id);
      card.classList.remove('ow-floating');
      document.body.classList.remove('ow-dragging-cursor');
      st.ph.remove();
      if (p) {
        card.style.left = (p.x * (st.g.colW + st.g.gap)) + 'px';
        card.style.top = p.y + 'px';
      }
      this._drag = null;
      if (st.res) this.commit(st.res);
      setTimeout(() => this.rerender(), 230);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  },

  // ---- drag-to-scale ----
  // Width snaps to whole columns as you drag (live), height follows the
  // pointer freely (80–1100px); neighbours are pushed out of the way live.
  // On a 2-column screen a "full" span keeps the widget wide on the desk
  // too; phones only resize height.
  resizeStart(e, card, w) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const grid = card.parentNode;
    const g = this.geom(grid);
    const body = card.querySelector('.ow-body');
    const span0 = this.spanFor(w, g.cols);
    const x0 = Math.round((parseFloat(card.style.left) || 0) / (g.colW + g.gap));
    const y0 = parseFloat(card.style.top) || 0;
    const st = this._drag = { resize: true, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY,
      w0: card.offsetWidth, h0: body.getBoundingClientRect().height, span: span0, h: null, raf: 0, res: null };
    card.classList.add('ow-resizing');
    document.body.classList.add('ow-resize-cursor');
    const badge = el('span.ow-size-badge');
    card.appendChild(badge);
    let lastX = e.clientX, lastY = e.clientY;
    const apply = () => {
      st.raf = 0;
      const span = Math.max(1, Math.min(g.cols, Math.round((st.w0 + lastX - st.x0 + g.gap) / (g.colW + g.gap))));
      const h = Math.max(80, Math.min(1100, Math.round(st.h0 + lastY - st.y0)));
      st.span = span; st.h = h;
      body.style.height = h + 'px'; body.style.maxHeight = 'none';
      st.res = this.arrange(grid, { pin: { id: w.id, x: Math.min(x0, g.cols - span), y: y0 }, span: { id: w.id, span } });
      badge.textContent = (g.cols > 1 ? span + ' col' + (span > 1 ? 's' : '') + ' · ' : '') + h + 'px';
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
      w.h = st.h;
      if (g.cols === 4) { w.w = st.span; this.commit(st.res); }
      else {
        if (g.cols === 2) w.w = st.span === 2 ? Math.max(2, w.w) : 1;
        this.save();
      }
      this.rerender();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }
};
