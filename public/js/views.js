'use strict';
/* Module views + the contextual inspector panel. */

const Views = {

  /* ═══════════ shared bits ═══════════ */
  kv(label, value, cls) {
    return el('div.var-row', el('span.var-label', label), el('span.var-value', { class: cls || '' }, value));
  },
  secLabel(t, extra) { return el('div.section-label', t, extra || null); },
  barRow(label, pct, color, valueText) {
    return el('div', { style: 'display:flex; align-items:center; gap:10px; padding:4px 0;' },
      el('span', { style: 'width:170px; font-size:12.5px; color:var(--ink-soft); flex-shrink:0;' }, label),
      el('div.bar-track', { style: 'flex:1;' }, el('div.bar-fill', { style: `width:${Math.min(100, Math.max(0, pct))}%; background:${color || 'var(--accent)'};` })),
      el('span', { style: 'font-family:var(--font-mono); font-size:11px; width:64px; text-align:right;' }, valueText !== undefined ? valueText : (Math.round(pct * 10) / 10 + '%'))
    );
  },
  ideologyLabel(ideo) {
    if (!ideo) return '—';
    const e = ideo.econ || 0, s = ideo.soc || 0;
    const ec = e < -50 ? 'Far-left' : e < -15 ? 'Left' : e <= 15 ? 'Centre' : e <= 50 ? 'Right' : 'Far-right';
    const so = s < -30 ? 'libertarian' : s <= 30 ? 'moderate' : 'authoritarian';
    return `${ec} · ${so}`;
  },
  activityFor(id, n) {
    const rows = (S().timeline || []).filter(t => t.refs && t.refs.includes(id)).slice(-(n || 7)).reverse();
    if (!rows.length) return el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'No recorded activity.');
    return el('div', rows.map(t => el('div.activity-item',
      el('span.when', `T${t.turn} · ${fmtDate(t.simDate)}`), t.title + (t.detail ? ' — ' + t.detail : ''))));
  },
  accountsOf(entId) { return (S().accounts || []).filter(a => a.ownerId === entId); },
  inventoryTable(inv, ownerEntId) {
    if (!inv || !inv.length) return el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'Empty.');
    const mine = W.me.entityId === ownerEntId;
    return el('table.data', el('thead', el('tr', el('th', 'Item'), el('th.num', 'Qty'), el('th.num', 'Market Value'), mine ? el('th', '') : null)),
      el('tbody', inv.map(row => {
        const it = itemById(row.itemId);
        if (!it) return null;
        return el('tr.row-link', { onclick: () => select('item', it.id) },
          el('td', it.name),
          el('td.num', fmtNum(row.qty)),
          el('td.num', fmtMoney(row.qty * it.marketValue)),
          mine ? el('td', el('button.outline-btn', { onclick: (e) => { e.stopPropagation(); Views.tradeModal(it.id); } }, 'Trade')) : null
        );
      })));
  },
  ownerLink(id) {
    const e = entById(id);
    return e ? el('span', { style: 'cursor:pointer; border-bottom:1px dotted var(--rule-strong);', onclick: () => select('entity', e.id) }, e.name) : '—';
  },
  gmJump(kind, id) {
    if (!isGM()) return null;
    const tabByKind = { province: 'provinces', city: 'mapobjects', property: 'mapobjects', entity: 'registry', item: 'items' };
    return el('button.dash-btn', {
      onclick: () => { W.gmTab = tabByKind[kind] || 'world'; W.gmSel[W.gmTab] = id; App.go('gm'); }
    }, '✎ Open in GM Studio');
  },

  /* ═══════════ INSPECTOR ═══════════ */
  inspect(kind, id) {
    const panel = document.getElementById('inspector');
    const body = document.getElementById('insp-body');
    const kicker = document.getElementById('insp-kicker');
    panel.classList.remove('hidden');
    clear(body);
    let node = null, kick = 'DOSSIER';
    if (kind === 'province') { node = this.inspProvince(id); kick = 'PROVINCE FILE'; }
    else if (kind === 'city') { node = this.inspCity(id); kick = 'CITY FILE'; }
    else if (kind === 'property') { node = this.inspProperty(id); kick = 'PROPERTY FILE'; }
    else if (kind === 'entity') { const e = entById(id); node = this.inspEntity(id); kick = (TYPE_LABEL[e && e.type] || 'ENTITY').toUpperCase() + ' FILE'; }
    else if (kind === 'item') { node = this.inspItem(id); kick = 'MARKET FILE'; }
    kicker.textContent = kick;
    if (node) body.appendChild(node);
  },
  closeInspector() {
    document.getElementById('inspector').classList.add('hidden');
    W.selection = null;
    if (GameMap.ready) GameMap.highlight();
    renderExplorer();
  },

  inspProvince(id) {
    const p = provById(id);
    if (!p) return el('div', 'Not on file.');
    const varDefs = (S().variables || []).filter(v => v.scope === 'province');
    const wrap = el('div');
    wrap.appendChild(el('div.insp-title', p.name));
    wrap.appendChild(el('div.insp-sub', 'Province · pop. ' + fmtNum(p.vars.population)));
    if (p.description) wrap.appendChild(el('div.insp-desc', p.description));

    wrap.appendChild(this.secLabel('Variables'));
    const shown = new Set();
    for (const v of varDefs) {
      if (p.vars[v.key] === undefined) continue;
      shown.add(v.key);
      wrap.appendChild(this.kv(v.label, fmtVal(p.vars[v.key], v.format)));
    }
    for (const k in p.vars) if (!shown.has(k)) wrap.appendChild(this.kv(k, fmtNum(p.vars[k])));
    if (!perms().statistics) wrap.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:9.5px; color:var(--ink-faint); margin-top:8px;' }, 'FULL STATISTICS REQUIRE CLEARANCE.'));

    if (p.demographics && perms().statistics) {
      wrap.appendChild(this.secLabel('Population Groups'));
      for (const gname in p.demographics) {
        const g = p.demographics[gname];
        wrap.appendChild(this.barRow(gname, (g.population / (p.vars.population || 1)) * 100, 'var(--ink-soft)', fmtCompact(g.population)));
      }
    }

    const cities = S().cities.filter(c => c.provinceId === id);
    if (cities.length) {
      wrap.appendChild(this.secLabel('Cities'));
      cities.forEach(c => wrap.appendChild(el('div.var-row',
        el('span.var-label', { style: 'cursor:pointer;', onclick: () => select('city', c.id) }, (c.isCapital ? '★ ' : '') + c.name),
        el('span.var-value', ''))));
    }
    const props = S().properties.filter(pr => pr.provinceId === id);
    if (props.length) {
      wrap.appendChild(this.secLabel('Properties (' + props.length + ')'));
      props.slice(0, 14).forEach(pr => wrap.appendChild(el('div.var-row',
        el('span.var-label', { style: 'cursor:pointer;', onclick: () => select('property', pr.id) }, pr.name),
        el('span.var-value', entName(pr.ownerId)))));
    }
    wrap.appendChild(this.secLabel('Recent Activity'));
    wrap.appendChild(this.activityFor(id));
    const actions = el('div.insp-actions', this.gmJump('province', id));
    wrap.appendChild(actions);
    return wrap;
  },

  inspCity(id) {
    const c = cityById(id);
    if (!c) return el('div', 'Not on file.');
    const p = provById(c.provinceId);
    const wrap = el('div');
    wrap.appendChild(el('div.insp-title', (c.isCapital ? '★ ' : '') + c.name));
    wrap.appendChild(el('div.insp-sub', (c.isCapital ? 'National capital · ' : 'City · ') + (p ? p.name : '—')));
    if (c.description) wrap.appendChild(el('div.insp-desc', c.description));
    const props = S().properties.filter(pr => pr.provinceId === c.provinceId);
    if (p) {
      wrap.appendChild(this.secLabel('Province'));
      wrap.appendChild(el('div.var-row', el('span.var-label', { style: 'cursor:pointer;', onclick: () => select('province', p.id) }, p.name), el('span.var-value', fmtCompact(p.vars.population))));
    }
    if (props.length) {
      wrap.appendChild(this.secLabel('Nearby Properties'));
      props.slice(0, 12).forEach(pr => wrap.appendChild(el('div.var-row',
        el('span.var-label', { style: 'cursor:pointer;', onclick: () => select('property', pr.id) }, pr.name),
        el('span.var-value', entName(pr.ownerId)))));
    }
    wrap.appendChild(el('div.insp-actions', this.gmJump('city', id)));
    return wrap;
  },

  inspProperty(id) {
    const pr = propById(id);
    if (!pr) return el('div', 'Not on file.');
    const p = provById(pr.provinceId);
    const wrap = el('div');
    wrap.appendChild(el('div.insp-title', pr.name));
    wrap.appendChild(el('div.insp-sub', (pr.kind || pr.type || '').replace('_', ' ') + (p ? ' · ' + p.name : '')));
    if (pr.description) wrap.appendChild(el('div.insp-desc', pr.description));
    wrap.appendChild(this.secLabel('Record'));
    wrap.appendChild(this.kv('Owner', this.ownerLink(pr.ownerId)));
    wrap.appendChild(this.kv('Assessed Value', fmtMoney(pr.value)));
    wrap.appendChild(this.kv('Employees', fmtNum(pr.employees)));
    wrap.appendChild(this.kv('Monthly Income', fmtMoney(pr.income), 'pos'));
    wrap.appendChild(this.kv('Monthly Expenses', fmtMoney(pr.expenses), 'neg'));
    for (const k in (pr.vars || {})) wrap.appendChild(this.kv(k, fmtNum(pr.vars[k])));
    if (pr.inventory) {
      wrap.appendChild(this.secLabel('Site Inventory'));
      wrap.appendChild(this.inventoryTable(pr.inventory, pr.ownerId));
    }
    wrap.appendChild(this.secLabel('Recent Activity'));
    wrap.appendChild(this.activityFor(id));
    wrap.appendChild(el('div.insp-actions', this.gmJump('property', id)));
    return wrap;
  },

  inspEntity(id) {
    const e = entById(id);
    if (!e) return el('div', 'Not on file.');
    const wrap = el('div');
    if (e.logo) wrap.appendChild(el('img.insp-logo', { src: e.logo, alt: '' }));
    wrap.appendChild(el('div.insp-title', e.name));
    const subBits = [TYPE_LABEL[e.type] || e.type];
    if (e.industry) subBits.push(e.industry);
    if (e.title) subBits.push(e.title);
    if (e.stance) subBits.push('Relations: ' + e.stance);
    wrap.appendChild(el('div.insp-sub', subBits.join(' · ')));
    if (e.description) wrap.appendChild(el('div.insp-desc', e.description));

    if (e.type === 'company') {
      wrap.appendChild(this.secLabel('Corporate Record'));
      wrap.appendChild(this.kv('Controlled by', this.ownerLink(e.ownerId)));
      if (e.ceoId) wrap.appendChild(this.kv('Chief Executive', this.ownerLink(e.ceoId)));
      if (e.executives && e.executives.length) wrap.appendChild(this.kv('Executives', e.executives.map(x => entName(x)).join(', ')));
      const siteEmployees = S().properties.filter(pr => pr.ownerId === e.id).reduce((s, pr) => s + (pr.employees || 0), 0);
      if (siteEmployees) wrap.appendChild(this.kv('Employees (sites)', fmtNum(siteEmployees)));
      if (e.vars && Object.keys(e.vars).length) {
        wrap.appendChild(this.secLabel('Financials'));
        const defs = (S().variables || []).filter(v => v.scope === 'company');
        const covered = new Set();
        defs.forEach(v => { if (e.vars[v.key] !== undefined) { covered.add(v.key); wrap.appendChild(this.kv(v.label, fmtVal(e.vars[v.key], v.format))); } });
        for (const k in e.vars) if (!covered.has(k)) wrap.appendChild(this.kv(k, fmtNum(e.vars[k])));
      }
      if (e.shareholders) {
        wrap.appendChild(this.secLabel('Share Register'));
        const total = e.sharesOutstanding || e.shareholders.reduce((s, x) => s + x.shares, 0) || 1;
        e.shareholders.forEach(sh => wrap.appendChild(this.barRow(entName(sh.entityId), sh.shares / total * 100, (entById(sh.entityId) || {}).color)));
        wrap.appendChild(this.kv('Shares Outstanding', fmtNum(e.sharesOutstanding)));
      }
      if (!e.vars && !e.shareholders) wrap.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:9.5px; color:var(--ink-faint); margin-top:10px;' }, 'FINANCIAL RECORDS REQUIRE CLEARANCE.'));
    }

    if (e.type === 'party') {
      wrap.appendChild(this.secLabel('Party Record'));
      if (e.leaderId) wrap.appendChild(this.kv('Leader', this.ownerLink(e.leaderId)));
      wrap.appendChild(this.kv('Seats in Parliament', fmtNum(e.mpCount) + ' / ' + (S().settings.parliamentSeats || 150)));
      wrap.appendChild(this.kv('Position', this.ideologyLabel(e.ideology)));
      wrap.appendChild(this.kv('In Government', e.inGovernment ? 'Yes' : 'No'));
    }

    const accts = this.accountsOf(id);
    if (accts.length) {
      wrap.appendChild(this.secLabel('Bank Accounts'));
      accts.forEach(a => wrap.appendChild(this.kv(a.name, fmtMoney(a.balance))));
    }
    if (e.inventory) {
      wrap.appendChild(this.secLabel('Inventory'));
      wrap.appendChild(this.inventoryTable(e.inventory, e.id));
    }
    const owned = S().properties.filter(pr => pr.ownerId === id);
    if (owned.length) {
      wrap.appendChild(this.secLabel('Properties (' + owned.length + ')'));
      owned.slice(0, 14).forEach(pr => wrap.appendChild(el('div.var-row',
        el('span.var-label', { style: 'cursor:pointer;', onclick: () => select('property', pr.id) }, pr.name),
        el('span.var-value', fmtMoney(pr.value)))));
    }
    const holdings = S().entities.filter(c => c.type === 'company' && c.shareholders && c.shareholders.some(sh => sh.entityId === id));
    if (holdings.length) {
      wrap.appendChild(this.secLabel('Shareholdings'));
      holdings.forEach(c => {
        const sh = c.shareholders.find(x => x.entityId === id);
        wrap.appendChild(this.kv(c.name, fmtNum(sh.shares) + ' shares'));
      });
    }
    wrap.appendChild(this.secLabel('Recent Activity'));
    wrap.appendChild(this.activityFor(id));

    const actions = el('div.insp-actions');
    const my = this.accountsOf(W.me.entityId);
    if (my.length && accts.length && id !== W.me.entityId) {
      actions.appendChild(el('button.outline-btn', { onclick: () => this.transferModal(accts[0].id) }, '₳ Transfer Funds'));
    }
    const myEnt = myEntity();
    if (myEnt && myEnt.inventory && myEnt.inventory.length && id !== W.me.entityId) {
      actions.appendChild(el('button.outline-btn', { onclick: () => this.tradeModal(null, id) }, '▣ Send Items'));
    }
    actions.appendChild(this.gmJump('entity', id));
    wrap.appendChild(actions);
    return wrap;
  },

  inspItem(id) {
    const it = itemById(id);
    if (!it) return el('div', 'Not on file.');
    const wrap = el('div');
    wrap.appendChild(el('div.insp-title', it.name));
    wrap.appendChild(el('div.insp-sub', it.category + (it.tradable ? ' · tradable' : ' · restricted')));
    if (it.description) wrap.appendChild(el('div.insp-desc', it.description));
    wrap.appendChild(this.secLabel('Market'));
    wrap.appendChild(this.kv('Market Value', fmtMoney(it.marketValue)));
    // circulation visible to this operator
    let qty = 0;
    for (const e of S().entities) if (e.inventory) for (const r of e.inventory) if (r.itemId === id) qty += r.qty;
    for (const pr of S().properties) if (pr.inventory) for (const r of pr.inventory) if (r.itemId === id) qty += r.qty;
    wrap.appendChild(this.kv('In circulation (visible)', fmtNum(qty)));
    wrap.appendChild(this.kv('Combined value', fmtMoney(qty * it.marketValue)));
    wrap.appendChild(this.secLabel('Recent Activity'));
    wrap.appendChild(this.activityFor(id));
    wrap.appendChild(el('div.insp-actions', this.gmJump('item', id)));
    return wrap;
  },

  /* ═══════════ money & items modals ═══════════ */
  transferModal(prefToAcct) {
    const my = isGM() || perms().accounts === 'all' ? S().accounts : this.accountsOf(W.me.entityId);
    if (!my.length) return toast('You control no accounts.', true);
    const acctLabel = (a) => `${entName(a.ownerId)} — ${a.name} (${fmtMoney(a.balance)})`;
    const fromSel = el('select.text-input', my.map(a => el('option', { value: a.id }, acctLabel(a))));
    const toSel = el('select.text-input', S().accounts.map(a => el('option', { value: a.id, selected: a.id === prefToAcct ? 'selected' : undefined }, acctLabel(a))));
    // citizens may not see other accounts — offer entity targets instead
    const entSel = el('select.text-input', S().entities.filter(e => e.id !== W.me.entityId).map(e => el('option', { value: e.id }, e.name + ' (' + (TYPE_LABEL[e.type] || e.type) + ')')));
    const useEntities = S().accounts.length <= my.length;
    const amount = el('input.text-input', { type: 'number', min: '0.01', step: '0.01', placeholder: '0.00' });
    const memo = el('input.text-input', { placeholder: 'Purpose of transfer' });
    openModal('WIRE TRANSFER', el('div',
      el('label.field-label', 'From account'), fromSel,
      el('label.field-label', 'To ' + (useEntities ? 'recipient' : 'account')), useEntities ? entSel : toSel,
      el('label.field-label', 'Amount (' + CUR() + ')'), amount,
      el('label.field-label', 'Memo'), memo
    ), [{
      label: 'Send Wire', onClick: async () => {
        const body = { fromAccountId: fromSel.value, amount: Number(amount.value), memo: memo.value };
        if (useEntities) body.toEntityId = entSel.value; else body.toAccountId = toSel.value;
        await POST('/api/transfer', body);
        toast('Wire sent.');
      }
    }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }]);
  },

  tradeModal(prefItem, prefTo) {
    const myEnt = myEntity();
    if (!myEnt || !myEnt.inventory || !myEnt.inventory.length) return toast('Your inventory is empty.', true);
    const itemSel = el('select.text-input', myEnt.inventory.map(r => {
      const it = itemById(r.itemId);
      return it ? el('option', { value: it.id, selected: it.id === prefItem ? 'selected' : undefined }, `${it.name} (×${fmtNum(r.qty)})`) : null;
    }));
    const toSel = el('select.text-input', S().entities.filter(e => e.id !== myEnt.id).map(e =>
      el('option', { value: e.id, selected: e.id === prefTo ? 'selected' : undefined }, e.name)));
    const qty = el('input.text-input', { type: 'number', min: '1', step: '1', value: '1' });
    openModal('TRANSFER OF GOODS', el('div',
      el('label.field-label', 'Item'), itemSel,
      el('label.field-label', 'Recipient'), toSel,
      el('label.field-label', 'Quantity'), qty
    ), [{
      label: 'Transfer', onClick: async () => {
        await POST('/api/trade', { itemId: itemSel.value, toEntityId: toSel.value, qty: Number(qty.value) });
        toast('Goods transferred.');
      }
    }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }]);
  },

  /* ═══════════ MODULE VIEWS ═══════════ */
  render(container) {
    if (W.view === 'map') { GameMap.mount(container); return; }
    const doc = el('div.doc-view', el('div.doc-inner'));
    clear(container).appendChild(doc);
    const inner = doc.firstChild;
    if (W.view === 'parliament') this.viewParliament(inner);
    else if (W.view === 'companies') this.viewCompanies(inner);
    else if (W.view === 'economy') this.viewEconomy(inner);
    else if (W.view === 'population') this.viewPopulation(inner);
    else if (W.view === 'news') this.viewNews(inner);
    else if (W.view === 'timeline') this.viewTimeline(inner);
    else if (W.view === 'gm') GM.render(container);
  },

  statStrip(cells) {
    return el('div.stat-strip', cells.map(c => el('div.stat-cell', el('div.k', c[0]), el('div.v', c[1]), c[2] ? el('div.d', c[2]) : null)));
  },

  /* ---- Parliament ---- */
  seatArc(parties, totalSeats) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 420 230');
    svg.setAttribute('width', '420'); svg.setAttribute('height', '230');
    svg.setAttribute('id', 'seat-arc');
    const sorted = [...parties].sort((a, b) => (a.ideology ? a.ideology.econ : 0) - (b.ideology ? b.ideology.econ : 0));
    const seatColors = [];
    sorted.forEach(p => { for (let i = 0; i < (p.mpCount || 0); i++) seatColors.push(p.color || '#888'); });
    while (seatColors.length < totalSeats) seatColors.push('var(--paper-line)');
    const rows = 6, inner = 88, outer = 196;
    const rowSeats = [];
    let alloc = 0;
    for (let r = 0; r < rows; r++) {
      const share = (inner + (outer - inner) * r / (rows - 1));
      rowSeats.push(share);
      alloc += share;
    }
    const counts = rowSeats.map(s => Math.round(s / alloc * totalSeats));
    let diff = totalSeats - counts.reduce((a, b) => a + b, 0);
    counts[rows - 1] += diff;
    let idx = 0;
    for (let r = 0; r < rows; r++) {
      const radius = inner + (outer - inner) * r / (rows - 1);
      const n = counts[r];
      for (let iSeat = 0; iSeat < n && idx < totalSeats; iSeat++, idx++) {
        const angle = Math.PI - (n === 1 ? Math.PI / 2 : iSeat / (n - 1) * Math.PI);
        const cx = 210 + Math.cos(angle) * radius;
        const cy = 216 - Math.sin(angle) * radius;
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', 4.6);
        c.setAttribute('fill', seatColors[idx]);
        c.setAttribute('stroke', 'rgba(34,29,21,.4)'); c.setAttribute('stroke-width', '.5');
        svg.appendChild(c);
      }
    }
    return svg;
  },

  async viewParliament(inner) {
    const parties = S().entities.filter(e => e.type === 'party');
    const totalSeats = S().settings.parliamentSeats || 150;
    const lastElec = (S().elections || []).slice(-1)[0];
    const gov = parties.filter(p => p.inGovernment).map(p => p.name).join(', ') || '—';
    inner.appendChild(el('div.doc-title', 'Parliament of the Republic'));
    inner.appendChild(el('div.doc-sub', totalSeats + ' seats · unicameral · ' + fmtDate(S().settings.time.date)));
    inner.appendChild(this.statStrip([
      ['Seats', fmtNum(totalSeats)],
      ['Government', gov],
      ['Last Election', lastElec ? fmtDate(lastElec.simDate) : '—', lastElec ? 'turnout ' + lastElec.turnout + '%' : ''],
      ['Opposition Seats', fmtNum(parties.filter(p => !p.inGovernment).reduce((s, p) => s + (p.mpCount || 0), 0))]
    ]));

    const stage = el('div.stage', { style: 'margin-top:16px; text-align:center;' });
    stage.appendChild(this.seatArc(parties, totalSeats));
    inner.appendChild(stage);

    inner.appendChild(this.secLabel('Parties'));
    const list = el('div');
    for (const p of [...parties].sort((a, b) => (b.mpCount || 0) - (a.mpCount || 0))) {
      list.appendChild(el('div.party-row', { onclick: () => select('entity', p.id) },
        p.logo ? el('img', { src: p.logo, alt: '' }) : el('span.exp-dot', { style: 'background:' + p.color }),
        el('div',
          el('div.pr-name', p.name),
          el('div.pr-meta', `${p.leaderId ? entName(p.leaderId) + ' · ' : ''}${this.ideologyLabel(p.ideology)}${p.inGovernment ? ' · IN GOVERNMENT' : ''}`)),
        el('div.pr-seats', String(p.mpCount || 0))));
    }
    inner.appendChild(list);

    if (isGM()) {
      inner.appendChild(el('div.btn-row',
        el('button.solid-btn', {
          onclick: () => confirmModal('DISSOLUTION', 'Dissolve Parliament and hold a general election? Results are computed from the simulated population.', async () => {
            await POST('/api/gm/election');
            toast('The Republic has voted.');
          }, 'Call Election')
        }, '⚑ Call General Election')));
    }

    if (perms().statistics || isGM()) {
      inner.appendChild(this.secLabel('Current Polling (national)'));
      const pollBox = el('div.stage', { style: 'margin-top:4px;' });
      inner.appendChild(pollBox);
      try {
        const poll = await GET('/api/polling');
        for (const p of [...parties].sort((a, b) => (poll.national[b.id] || 0) - (poll.national[a.id] || 0))) {
          pollBox.appendChild(this.barRow(p.name, poll.national[p.id] || 0, p.color));
        }
      } catch (e) { pollBox.appendChild(el('div', { style: 'color:var(--ink-faint)' }, 'Polling unavailable: ' + e.message)); }
    }

    if (lastElec) {
      inner.appendChild(this.secLabel('Election Record — ' + (lastElec.name || fmtDate(lastElec.simDate))));
      const tbl = el('table.data',
        el('thead', el('tr', el('th', 'Party'), el('th.num', 'Votes'), el('th.num', 'Share'), el('th.num', 'Seats'))),
        el('tbody', (lastElec.national || []).map(r => el('tr',
          el('td', entName(r.partyId)),
          el('td.num', fmtNum(r.votes)),
          el('td.num', r.pct + '%'),
          el('td.num', String(r.seats))))));
      inner.appendChild(tbl);
    }
  },

  /* ---- Companies ---- */
  viewCompanies(inner) {
    const companies = S().entities.filter(e => e.type === 'company');
    inner.appendChild(el('div.doc-title', 'Companies of the Republic'));
    inner.appendChild(el('div.doc-sub', companies.length + ' registered concerns'));
    const grid = el('div.card-grid');
    for (const c of companies) {
      grid.appendChild(el('div.entity-card', { onclick: () => select('entity', c.id) },
        el('div.logo', c.logo ? el('img', { src: c.logo, alt: c.name }) : el('div.monogram', { style: 'background:' + (c.color || '#555') }, c.name[0])),
        el('div.nm', c.name),
        el('div.ind', c.industry || ''),
        el('div.desc', (c.description || '').slice(0, 130) + ((c.description || '').length > 130 ? '…' : '')),
        el('div', { style: 'margin-top:10px; font-family:var(--font-mono); font-size:10px; color:var(--ink-faint);' },
          'CEO ' + (c.ceoId ? entName(c.ceoId) : '—') + (c.vars && c.vars.valuation ? ' · VAL ' + CUR() + fmtCompact(c.vars.valuation) : ''))
      ));
    }
    inner.appendChild(grid);
  },

  /* ---- Economy ---- */
  viewEconomy(inner) {
    const g = S().globalVars || {};
    inner.appendChild(el('div.doc-title', 'The Economy'));
    inner.appendChild(el('div.doc-sub', S().settings.currencyName + ' (' + CUR() + ') · turn ' + S().settings.time.turn));
    const cells = [];
    if (g.gdp !== undefined) cells.push(['National GDP', CUR() + fmtCompact((g.gdp || 0) * 1e6)]);
    if (g.moneySupply !== undefined) cells.push(['Money Supply', CUR() + fmtCompact(g.moneySupply)]);
    if (g.treasury !== undefined) cells.push(['Federal Treasury', CUR() + fmtCompact(g.treasury)]);
    cells.push(['Visible Accounts', fmtNum(S().accounts.length)]);
    inner.appendChild(this.statStrip(cells));

    const myAccts = this.accountsOf(W.me.entityId);
    if (myAccts.length) {
      inner.appendChild(this.secLabel('Your Accounts'));
      const box = el('div.stage');
      myAccts.forEach(a => box.appendChild(this.kv(a.name, fmtMoney(a.balance))));
      box.appendChild(el('div.btn-row', el('button.solid-btn', { onclick: () => this.transferModal() }, '₳ Wire Transfer')));
      inner.appendChild(box);
    }

    if (perms().accounts === 'all' || isGM()) {
      inner.appendChild(this.secLabel('All Accounts'));
      inner.appendChild(el('table.data',
        el('thead', el('tr', el('th', 'Holder'), el('th', 'Account'), el('th.num', 'Balance'))),
        el('tbody', [...S().accounts].sort((a, b) => b.balance - a.balance).slice(0, 40).map(a => el('tr.row-link', { onclick: () => select('entity', a.ownerId) },
          el('td', entName(a.ownerId)), el('td', a.name), el('td.num', fmtMoney(a.balance)))))));
    }

    inner.appendChild(this.secLabel('Ledger — Recent Transactions'));
    const txns = [...(S().transactions || [])].slice(-80).reverse();
    if (!txns.length) inner.appendChild(el('div', { style: 'color:var(--ink-faint);' }, 'No transactions on record.'));
    else inner.appendChild(el('table.data',
      el('thead', el('tr', el('th', 'When'), el('th', 'From'), el('th', 'To'), el('th.num', 'Amount'), el('th', 'Memo'))),
      el('tbody', txns.map(t => {
        const fa = acctById(t.from), ta = acctById(t.to);
        return el('tr',
          el('td', { style: 'font-family:var(--font-mono); font-size:10px; white-space:nowrap;' }, `T${t.turn} · ${fmtDate(t.simDate)}`),
          el('td', fa ? entName(fa.ownerId) : (t.from ? '(account)' : '—')),
          el('td', ta ? entName(ta.ownerId) : (t.to ? '(account)' : '—')),
          el('td.num', fmtMoney(t.amount)),
          el('td', { style: 'color:var(--ink-soft); font-size:12px;' }, t.memo || ''));
      }))));

    inner.appendChild(this.secLabel('Market Values'));
    inner.appendChild(el('table.data',
      el('thead', el('tr', el('th', 'Item'), el('th', 'Category'), el('th.num', 'Market Value'), el('th', 'Tradable'))),
      el('tbody', S().items.map(it => el('tr.row-link', { onclick: () => select('item', it.id) },
        el('td', it.name), el('td', it.category), el('td.num', fmtMoney(it.marketValue)), el('td', it.tradable ? 'yes' : 'no'))))));
  },

  /* ---- Population ---- */
  viewPopulation(inner) {
    inner.appendChild(el('div.doc-title', 'Population of the Republic'));
    const g = S().globalVars || {};
    inner.appendChild(el('div.doc-sub', fmtNum(g.population) + ' citizens across ' + S().provinces.length + ' provinces'));
    if (!perms().statistics && !isGM()) {
      inner.appendChild(el('div.stage', el('div', { style: 'font-family:var(--font-mono); font-size:11px; letter-spacing:.1em;' }, 'DEMOGRAPHIC RECORDS REQUIRE STATISTICS CLEARANCE.')));
      return;
    }
    inner.appendChild(this.statStrip([
      ['Population', fmtCompact(g.population)],
      ['Avg. Happiness', (g.avgHappiness !== undefined ? g.avgHappiness + '%' : '—')],
      ['Avg. Approval', (g.avgApproval !== undefined ? g.avgApproval + '%' : '—')],
      ['GDP', CUR() + fmtCompact((g.gdp || 0) * 1e6)]
    ]));

    if (!W.popProv || !provById(W.popProv)) W.popProv = S().provinces[0] && S().provinces[0].id;
    const chips = el('div.chip-row');
    for (const p of S().provinces) {
      chips.appendChild(el('button.chip', { class: p.id === W.popProv ? 'active' : '', onclick: () => { W.popProv = p.id; App.renderView(); } }, p.name));
    }
    inner.appendChild(chips);

    const p = provById(W.popProv);
    if (!p || !p.demographics) return;
    const metrics = (S().settings.demographics.metrics || []);
    inner.appendChild(this.secLabel(p.name + ' — Population Groups'));
    const head = el('tr', el('th', 'Group'));
    metrics.forEach(mDef => head.appendChild(el('th.num', mDef.label)));
    const tbody = el('tbody');
    for (const gname in p.demographics) {
      const row = el('tr', el('td', gname));
      const grp = p.demographics[gname];
      metrics.forEach(mDef => row.appendChild(el('td.num', fmtVal(grp[mDef.key], mDef.format))));
      tbody.appendChild(row);
    }
    inner.appendChild(el('table.data', el('thead', head), tbody));

    inner.appendChild(this.secLabel('Support of Government by Group'));
    const box = el('div.stage');
    for (const gname in p.demographics) {
      box.appendChild(this.barRow(gname, p.demographics[gname].governmentSupport || 0, 'var(--good)'));
    }
    inner.appendChild(box);
  },

  /* ---- News ---- */
  viewNews(inner) {
    const canManage = perms().manageNews || isGM();
    inner.appendChild(el('div.paper-masthead',
      el('div.nm', 'The Arcasian Herald'),
      el('div.et', 'EST. 1899 · PAPER OF RECORD · ' + fmtDate(S().settings.time.date).toUpperCase())));

    if (!W.newsCat) W.newsCat = 'All';
    if (W.newsTab === undefined) W.newsTab = 'published';
    const cats = ['All', ...new Set(S().news.map(n => n.category))];
    const bar = el('div.chip-row');
    cats.forEach(c => bar.appendChild(el('button.chip', { class: c === W.newsCat ? 'active' : '', onclick: () => { W.newsCat = c; App.renderView(); } }, c)));
    const search = el('input.text-input', { placeholder: 'Search the archive…', style: 'max-width:260px;', value: W.newsQ || '', oninput: (e) => { W.newsQ = e.target.value; clearTimeout(W._nq); W._nq = setTimeout(() => App.renderView(), 250); } });
    bar.appendChild(el('span', { style: 'flex:1' }));
    bar.appendChild(search);
    inner.appendChild(bar);

    if (canManage) {
      const tabs = el('div.chip-row',
        el('button.chip', { class: W.newsTab === 'published' ? 'active' : '', onclick: () => { W.newsTab = 'published'; App.renderView(); } }, 'Published'),
        el('button.chip', { class: W.newsTab === 'draft' ? 'active' : '', onclick: () => { W.newsTab = 'draft'; App.renderView(); } }, 'Drafts (' + S().news.filter(n => n.status === 'draft').length + ')'),
        el('button.dash-btn', { onclick: () => this.newsEditor() }, '✎ New Article'));
      inner.appendChild(tabs);
    }

    const q = (W.newsQ || '').toLowerCase();
    let list = S().news.filter(n =>
      (canManage ? n.status === W.newsTab : n.status === 'published') &&
      (W.newsCat === 'All' || n.category === W.newsCat) &&
      (!q || n.headline.toLowerCase().includes(q) || (n.body || '').toLowerCase().includes(q)));
    list = [...list].reverse();
    if (!list.length) inner.appendChild(el('div', { style: 'color:var(--ink-faint); padding:30px 0; text-align:center; font-family:var(--font-mono); font-size:11px; letter-spacing:.14em;' }, 'NOTHING ON FILE.'));

    list.forEach((n, i) => {
      const isLead = i === 0 && !q && W.newsCat === 'All';
      const art = el('div.news-article', { class: isLead ? 'lead' : '' });
      art.appendChild(el('div.headline', { onclick: () => { art.querySelector('.body').classList.toggle('hidden'); } }, n.headline,
        n.status === 'draft' ? el('span.status-stamp.draft', 'DRAFT') : null));
      art.appendChild(el('div.meta', `${n.category} · ${n.author} · ${fmtDate(n.simDate)} · TURN ${n.turn}`));
      const bodyEl = el('div.body', { class: isLead ? '' : 'hidden' });
      if (isLead && n.body) {
        bodyEl.appendChild(el('span.drop', n.body[0]));
        bodyEl.appendChild(document.createTextNode(n.body.slice(1)));
      } else bodyEl.textContent = n.body || '';
      art.appendChild(bodyEl);
      if (canManage) {
        art.appendChild(el('div.btn-row',
          n.status === 'draft' ? el('button.solid-btn', { onclick: async () => { await PATCH('/api/news/' + n.id, { status: 'published' }); toast('Published.'); } }, 'Publish') : null,
          el('button.dash-btn', { onclick: () => this.newsEditor(n) }, 'Edit'),
          n.status === 'published' ? el('button.dash-btn', { onclick: async () => { await PATCH('/api/news/' + n.id, { status: 'draft' }); toast('Retracted to drafts.'); } }, 'Retract') : null,
          el('button.dash-btn', { onclick: () => confirmModal('DESTROY RECORD', 'Delete this article permanently?', async () => { await DEL('/api/news/' + n.id); toast('Deleted.'); }) }, 'Delete')));
      }
      inner.appendChild(art);
    });
  },

  newsEditor(article) {
    const headline = el('input.text-input', { value: article ? article.headline : '', placeholder: 'HEADLINE' });
    const category = el('input.text-input', { value: article ? article.category : 'Politics', placeholder: 'Category' });
    const body = el('textarea.text-input', { style: 'min-height:180px;' }, article ? article.body : '');
    openModal(article ? 'EDIT ARTICLE' : 'NEW ARTICLE', el('div',
      el('label.field-label', 'Headline'), headline,
      el('label.field-label', 'Category'), category,
      el('label.field-label', 'Body'), body
    ), [
      {
        label: article ? 'Save' : 'Publish', onClick: async () => {
          if (article) await PATCH('/api/news/' + article.id, { headline: headline.value, category: category.value, body: body.value });
          else await POST('/api/news', { headline: headline.value, category: category.value, body: body.value, publish: true });
          toast('Filed.');
        }
      },
      !article ? {
        label: 'Save as Draft', cls: 'dash-btn', onClick: async () => {
          await POST('/api/news', { headline: headline.value, category: category.value, body: body.value, publish: false });
          toast('Draft saved.');
        }
      } : null,
      { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }
    ].filter(Boolean), true);
  },

  /* ---- Timeline ---- */
  viewTimeline(inner) {
    inner.appendChild(el('div.doc-title', 'The Record'));
    inner.appendChild(el('div.doc-sub', 'Every event, transfer and decision · newest first'));
    if (!W.tlType) W.tlType = 'all';
    const types = ['all', ...new Set((S().timeline || []).map(t => t.type))];
    const bar = el('div.chip-row');
    types.forEach(t => bar.appendChild(el('button.chip', { class: t === W.tlType ? 'active' : '', onclick: () => { W.tlType = t; App.renderView(); } }, t)));
    const search = el('input.text-input', { placeholder: 'Search the record…', style: 'max-width:240px;', value: W.tlQ || '', oninput: (e) => { W.tlQ = e.target.value; clearTimeout(W._tq); W._tq = setTimeout(() => App.renderView(), 250); } });
    bar.appendChild(el('span', { style: 'flex:1' }));
    bar.appendChild(search);
    inner.appendChild(bar);

    const q = (W.tlQ || '').toLowerCase();
    const rows = [...(S().timeline || [])].reverse().filter(t =>
      (W.tlType === 'all' || t.type === W.tlType) &&
      (!q || t.title.toLowerCase().includes(q) || (t.detail || '').toLowerCase().includes(q) || (t.actor || '').toLowerCase().includes(q))
    ).slice(0, 250);
    const box = el('div');
    rows.forEach(t => box.appendChild(el('div.tl-row',
      el('span.tl-when', `T${t.turn} · ${fmtDate(t.simDate)}`),
      el('span.tl-badge', t.type),
      el('span', el('span.tl-title', t.title), t.detail ? el('span.tl-detail', ' — ' + t.detail) : null),
      el('span.tl-actor', t.actor || ''))));
    if (!rows.length) box.appendChild(el('div', { style: 'color:var(--ink-faint); padding:24px 0;' }, 'Nothing matches.'));
    inner.appendChild(box);
  }
};
