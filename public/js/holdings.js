'use strict';
/* Your Holdings — one control board for everything this operator runs.
   Loaded after views.js; folded into Views.

   Left: a rail of cards, one per entity you can act for — yourself, the
   companies and groups in your ownership chain, the entities whose roster
   delegates you powers, and the companies you hold a minority stake in. Each
   wears a CONTROL BADGE that says how you hold it (Owner, CEO, Majority 54%,
   Via Astra Holdings, Delegated, Stake 12%) and a one-line purse (cash ·
   sites · goods).

   Right: the chosen entity laid open — what your control lets you do there
   (lit power chips), then its money, goods, properties and shares as visible
   cards with the action on each one, who holds it and whom it has delegated
   to. Its operations desk folds in as a second pane (company policy) and any
   site opens as a third (that site's levers).

   Replaces the Economy's old Inventory / Company Ops / Property Ops tabs; the
   old entry points (W.ecoTab 'inventory' | 'company' | 'property', with
   W.opsCo / W.opsProp) are mapped onto it by viewEconomy. Every gate here is
   a display hint only — the server re-checks each action. */
(function () {
  // whether a pointer is held down (Views.render's held-sync redraw waits
  // for the click that blurred a field to land)
  document.addEventListener('pointerdown', () => { Views._ptrDown = true; }, true);
  document.addEventListener('pointerup', () => { Views._ptrDown = false; }, true);
  document.addEventListener('pointercancel', () => { Views._ptrDown = false; }, true);
  const SCOPES = [
    ['spend', 'Spend money'], ['trade', 'Trade goods'], ['company_controls', 'Run the company'],
    ['property_controls', 'Run sites'], ['campaign_minor', 'Minor campaigns'], ['campaign_major', 'Major campaigns'],
    ['command_units', 'Command units'], ['manage_tenders', 'Tenders']];
  const SCOPE_NAME = Object.fromEntries(SCOPES);
  const isInstrument = (it) => it && (it.category === 'Securities' || it.category === 'Deeds' || (it.meta && (it.meta.companyId || it.meta.propertyId)));

  Object.assign(Views, {
    /* ---------- the facts about one entity ---------- */
    cashOf(id) { return this.accountsOf(id).reduce((s, a) => s + (a.balance || 0), 0); },
    goodsOf(e) {
      return ((e && e.inventory) || []).filter(r => r.qty > 0 && itemById(r.itemId) && !isInstrument(itemById(r.itemId)));
    },
    goodsValue(rows) { return rows.reduce((s, r) => s + r.qty * effPrice(itemById(r.itemId)), 0); },
    propsOf(id) { return (S().properties || []).filter(pr => pr.ownerId === id); },
    // share positions the entity holds: [{ c, shares, pct, value }]
    stakesOf(id) {
      const out = [];
      for (const c of S().entities) {
        if (c.type !== 'company' || !Array.isArray(c.shareholders)) continue;
        const shares = c.shareholders.filter(h => h.entityId === id).reduce((s, h) => s + (h.shares || 0), 0);
        if (!(shares > 0)) continue;
        const total = c.sharesOutstanding || c.shareholders.reduce((s, h) => s + (h.shares || 0), 0) || 1;
        out.push({ c, shares, pct: shares / total * 100, value: shares * this.livePrice(c) });
      }
      return out.sort((a, b) => b.value - a.value);
    },
    // the share of company `e` held across a set of holders, in %
    sharePctBy(e, holders) {
      if (!e || !Array.isArray(e.shareholders)) return 0;
      const total = e.sharesOutstanding || e.shareholders.reduce((s, h) => s + (h.shares || 0), 0);
      if (!(total > 0)) return 0;
      return e.shareholders.filter(h => holders.has(h.entityId)).reduce((s, h) => s + (h.shares || 0), 0) / total * 100;
    },
    // a sum for a stat cell: exact below ₳10M, compact above (₳2.60B)
    bigMoney(n) { return Math.abs(n) >= 1e7 ? CUR() + fmtCompact(n) : fmtMoney(n); },
    // after a pane change, bring the pane's top into view if it scrolled away
    holdFocus() {
      requestAnimationFrame(() => {
        const t = document.querySelector('.hold-pane'), doc = document.querySelector('.doc-view');
        if (t && doc && t.getBoundingClientRect().top < doc.getBoundingClientRect().top) t.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    },
    pctText(p) { return p >= 10 || p === 0 ? Math.round(p) + '%' : p >= 1 ? p.toFixed(1) + '%' : '<1%'; },

    /* ---------- how you hold it ----------
       { level: 'gm'|'self'|'full'|'deleg'|'stake'|'none', label, detail,
         scopes: [...], grant, pct } — `full` is anything in the ownership
       chain (one hop or through a parent), `deleg` a live roster grant,
       `stake` a minority shareholding with no control. */
    controlOf(id) {
      const e = entById(id);
      const me = W.me && W.me.entityId;
      const chain = ownershipSetClient();
      const pct = e && e.type === 'company' ? this.sharePctBy(e, chain) : 0;
      const out = { level: 'none', label: '', detail: '', scopes: [], grant: null, pct };
      if (!e) return out;
      if (isGM()) return Object.assign(out, { level: 'gm', label: 'Game Master', detail: 'You hold every lever on every record.' });
      if (!me) return out;
      if (id === me) return Object.assign(out, { level: 'self', label: 'You', detail: 'Your own character — your money, goods and property.' });
      const how = this.directHold(me, e);
      if (how) return Object.assign(out, { level: 'full', label: how[0], detail: how[1] });
      if (chain.has(id)) {
        // the link in your chain that holds it
        const parent = [...chain].find(cid => cid !== id && ownership_directlyControlsClient(cid, e));
        const pe = entById(parent);
        const via = pe ? (pe.abbrev || pe.name) : 'your companies';
        const why = pe ? this.directHold(parent, e) : null;
        return Object.assign(out, { level: 'full', label: 'Via ' + via,
          detail: `You control it through ${pe ? pe.name : 'your companies'}${why ? ' (' + why[0].toLowerCase() + ')' : ''} — full authority.` });
      }
      const g = ((S() && S().myGrants) || {})[id];
      if (g) {
        const scopes = g.scopes.includes('all') ? SCOPES.map(s => s[0]) : g.scopes.slice();
        const bits = [];
        if (g.title) bits.push('your post: ' + g.title);
        if (g.spendLimitPerTurn !== null && g.spendLimitPerTurn !== undefined && scopes.includes('spend')) bits.push('spending capped at ' + fmtMoney(g.spendLimitPerTurn) + ' a turn');
        if (g.accounts.length && scopes.includes('spend')) bits.push(g.accounts.length + ' account' + (g.accounts.length === 1 ? '' : 's') + ' only');
        if (g.properties.length && scopes.includes('property_controls')) bits.push(g.properties.length + ' site' + (g.properties.length === 1 ? '' : 's') + ' only');
        if (g.expiresAt) bits.push('until ' + new Date(g.expiresAt).toLocaleDateString());
        return Object.assign(out, { level: 'deleg', label: g.title ? 'Delegated · ' + g.title : 'Delegated', scopes, grant: g,
          detail: 'The owners have delegated you ' + (scopes.length ? scopes.map(s => SCOPE_NAME[s] || s).join(', ').toLowerCase() : 'no powers yet') + (bits.length ? ' — ' + bits.join(' · ') : '') + '.' });
      }
      if (pct > 0) return Object.assign(out, { level: 'stake', label: 'Stake ' + this.pctText(pct),
        detail: `Your side holds ${this.pctText(pct)} of the shares — a voice at the table, no control. Past 50% the company is yours.` });
      return out;
    },
    // [badge, sentence] for a one-hop hold, else null (mirror of
    // ownership_directlyControlsClient, but saying WHICH link it is)
    directHold(who, e) {
      if (!who || !e) return null;
      if (e.ownerId === who) return ['Owner', 'You own it outright — full authority.'];
      if (e.ceoId === who) return ['CEO', 'You are its chief executive — full authority over money, goods and operations.'];
      if (e.type === 'party' && e.leaderId === who) return ['Leader', 'You lead the party — its funds and assets are yours to direct.'];
      if (e.type === 'government' && Array.isArray(e.executives) && e.executives.includes(who)) return ['Executive', 'You sit in its executive — full authority.'];
      if (e.sharesOutstanding && Array.isArray(e.shareholders)) {
        const p = this.sharePctBy(e, new Set([who]));
        if (p > 50) return ['Majority ' + this.pctText(p), `You hold ${this.pctText(p)} of the shares — majority control.`];
      }
      return null;
    },
    ctlBadge(ctl, big) {
      if (!ctl || ctl.level === 'none') return null;
      return el('span.ctl-badge', { class: 'ctl-' + ctl.level + (big ? ' ctl-big' : ''), title: ctl.detail }, ctl.label);
    },
    // What this operator may do with entity e, per lever.
    holdPowers(e, ctl) {
      const full = ctl.level === 'gm' || ctl.level === 'self' || ctl.level === 'full';
      const has = (s) => full || (ctl.level === 'deleg' && ctl.scopes.includes(s));
      const chain = ownershipSetClient();
      const accts = this.accountsOf(e.id);
      return {
        full,
        spend: accts.some(a => canSpendFromClient(a, chain)),
        spendAccts: accts.filter(a => canSpendFromClient(a, chain)),
        trade: has('trade'),
        ops: e.type === 'company' && this.opsCompanies().some(c => c.id === e.id),
        sites: has('property_controls'),
        siteIds: new Set(this.opsProperties().filter(p => p.ownerId === e.id).map(p => p.id)),
        delegate: isGM() || ownership_controlsClient(W.me && W.me.entityId, e.id),
        capital: !!e.sharesOutstanding && full
      };
    },
    avatar(e, size) {
      const s = size || 34;
      if (e && e.logo) return el('span.hold-av', { style: `width:${s}px; height:${s}px;` }, el('img', { src: e.logo, alt: '' }));
      const ini = String((e && (e.abbrev || e.name)) || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
      return el('span.hold-av.mono', { style: `width:${s}px; height:${s}px; background:${(e && e.color) || 'var(--ink-faint)'}; font-size:${Math.round(s * 0.4)}px;` }, ini);
    },

    /* ---------- the rail: what you hold, grouped ---------- */
    holdGroups() {
      const st = S();
      const me = W.me && W.me.entityId;
      if (isGM()) {
        const holds = (e) => this.accountsOf(e.id).length || (e.inventory || []).length || st.properties.some(p => p.ownerId === e.id);
        const by = {};
        for (const e of st.entities) if (holds(e)) (by[e.type] = by[e.type] || []).push(e.id);
        const LABEL = { government: 'Government', person: 'People', company: 'Companies', party: 'Political parties', org: 'Organisations', foreign: 'Foreign powers' };
        return Object.keys(LABEL).filter(t => by[t]).map(t => ({ key: t, label: LABEL[t], ids: by[t] }))
          .concat(Object.keys(by).filter(t => !LABEL[t]).map(t => ({ key: t, label: TYPE_LABEL[t] || t, ids: by[t] })));
      }
      const chain = ownershipSetClient();
      const groups = [];
      if (me && entById(me)) groups.push({ key: 'self', label: 'You', ids: [me] });
      const ranked = (ids) => ids.sort((a, b) => this.cashOf(b) - this.cashOf(a));
      const cos = ranked([...chain].filter(id => id !== me && (entById(id) || {}).type === 'company'));
      const grp = ranked([...chain].filter(id => id !== me && entById(id) && entById(id).type !== 'company'));
      if (cos.length) groups.push({ key: 'cos', label: 'Companies you control', ids: cos });
      if (grp.length) groups.push({ key: 'grp', label: 'Groups you lead', ids: grp });
      const deleg = Object.keys(st.myGrants || {}).filter(id => !chain.has(id) && entById(id));
      if (deleg.length) groups.push({ key: 'deleg', label: 'Delegated to you', ids: deleg });
      const stakes = st.entities.filter(c => c.type === 'company' && !chain.has(c.id) && !deleg.includes(c.id) && this.sharePctBy(c, chain) > 0)
        .sort((a, b) => this.sharePctBy(b, chain) - this.sharePctBy(a, chain)).map(c => c.id);
      if (stakes.length) groups.push({ key: 'stake', label: 'Stakes (no control)', ids: stakes });
      return groups;
    },
    holdCard(id) {
      const e = entById(id);
      if (!e) return null;
      const ctl = this.controlOf(id);
      const cash = this.cashOf(id), sites = this.propsOf(id).length;
      const goods = this.goodsValue(this.goodsOf(e));
      const bits = [];
      if (this.accountsOf(id).length) bits.push(fmtMoney(cash));
      if (sites) bits.push(sites + ' site' + (sites === 1 ? '' : 's'));
      if (goods > 0) bits.push('goods ' + CUR() + fmtCompact(goods));
      return el('button.hold-card', { type: 'button', class: W.holdSel === id ? 'active' : '', 'data-hold': id,
        onclick: () => { if (W.holdSel !== id) { W.holdSel = id; W.holdPane = 'overview'; W.holdSite = null; } App.renderView(); this.holdFocus(); } },
        this.avatar(e, 32),
        el('span.hc-body',
          el('span.hc-name', e.name),
          el('span.hc-line', isGM() ? el('span.hc-type', TYPE_LABEL[e.type] || e.type) : this.ctlBadge(ctl), el('span.hc-purse', bits.filter(Boolean).join(' · ')))));
    },

    /* ---------- the board ---------- */
    viewHoldings(inner) {
      const groups = this.holdGroups();
      const all = groups.flatMap(g => g.ids);
      if (!all.length) {
        inner.appendChild(el('div.hold-empty', 'You hold nothing yet — no accounts, goods, property or shares. Buy shares on the Markets tab, or ask a company to delegate you a post.'));
        return;
      }
      const me = W.me && W.me.entityId;
      if (!W.holdSel || !entById(W.holdSel) || (!isGM() && !all.includes(W.holdSel))) W.holdSel = all.includes(me) ? me : all[0];

      // your whole side at a glance (GM: the selected entity only — a sum of
      // the world is no use to anyone)
      if (!isGM()) {
        const chain = ownershipSetClient();
        let cash = 0, goods = 0, prop = 0, shares = 0;
        for (const id of chain) {
          const e = entById(id); if (!e) continue;
          cash += this.cashOf(id);
          goods += this.goodsValue(this.goodsOf(e));
          prop += this.propsOf(id).reduce((s, p) => s + (p.value || 0), 0);
        }
        for (const id of chain) for (const s of this.stakesOf(id)) if (!chain.has(s.c.id)) shares += s.value;
        const deleg = Object.keys(S().myGrants || {}).filter(id => !chain.has(id)).length;
        inner.appendChild(this.statStrip([
          ['Net worth', this.bigMoney(cash + goods + prop + shares), 'everything your side owns'],
          ['Cash', this.bigMoney(cash)], ['Goods', this.bigMoney(goods)], ['Property', this.bigMoney(prop)],
          ['Shares (outside)', this.bigMoney(shares), 'in companies you don’t control'],
          ['You control', fmtNum(chain.size), (chain.size === 1 ? 'entity' : 'entities') + (deleg ? ' · +' + deleg + ' delegated to you' : '')]
        ]));
      }

      const board = el('div.hold-board');
      // rail
      const rail = el('div.hold-rail');
      const list = el('div.hold-rail-list');
      const paintRail = () => {
        clear(list);
        const q = (W.holdQ || '').trim().toLowerCase();
        for (const g of groups) {
          const ids = q ? g.ids.filter(id => (entById(id).name || '').toLowerCase().includes(q)) : g.ids;
          if (!ids.length) continue;
          const cap = q ? 60 : isGM() ? 12 : 40;
          const open = W.holdOpenGroup === g.key;
          list.appendChild(el('div.hold-group', g.label, el('span.hg-n', String(ids.length))));
          const shown = open || ids.length <= cap ? ids : ids.slice(0, cap);
          if (!shown.includes(W.holdSel) && ids.includes(W.holdSel)) shown.push(W.holdSel);
          for (const id of shown) { const c = this.holdCard(id); if (c) list.appendChild(c); }
          if (shown.length < ids.length) list.appendChild(el('button.hold-more', { type: 'button', onclick: () => { W.holdOpenGroup = g.key; paintRail(); } }, `Show all ${ids.length}`));
        }
        if (!list.children.length) list.appendChild(el('div.hold-empty', 'No match.'));
      };
      if (all.length > 8) {
        rail.appendChild(el('input.text-input.hold-search', { placeholder: isGM() ? 'Find anyone…' : 'Find a holding…', value: W.holdQ || '',
          oninput: (ev) => { W.holdQ = ev.target.value; paintRail(); } }));
      }
      paintRail();
      rail.appendChild(list);
      board.appendChild(rail);

      const pane = el('div.hold-pane');
      this.holdDetail(pane, W.holdSel);
      board.appendChild(pane);
      inner.appendChild(board);
    },

    holdDetail(pane, id) {
      const e = entById(id);
      if (!e) return;
      const ctl = this.controlOf(id);
      const P = this.holdPowers(e, ctl);

      // ---- header: who, how you hold it, the actions you have ----
      const sub = [TYPE_LABEL[e.type] || e.type, e.industry, e.title].filter(Boolean).join(' · ');
      pane.appendChild(el('div.hold-head',
        this.avatar(e, 52),
        el('div.hh-id',
          el('div.hh-name', { onclick: () => select('entity', e.id), title: 'Open the file' }, e.name),
          el('div.hh-sub', sub),
          el('div.hh-ctl', this.ctlBadge(ctl, true), ctl.detail ? el('span.hh-why', ctl.detail) : null))));

      // the levers, lit where you hold them
      const powers = [
        ['Spend money', P.spend], ['Trade goods', P.trade],
        e.type === 'company' ? ['Run the company', P.ops] : null,
        this.propsOf(id).length ? ['Run sites', P.sites || P.siteIds.size > 0] : null,
        ['Delegate', P.delegate]
      ].filter(Boolean);
      if (ctl.level !== 'stake' && ctl.level !== 'none') {
        pane.appendChild(el('div.hold-powers', powers.map(([label, on]) =>
          el('span.hp', { class: on ? 'on' : '' }, (on ? '✓ ' : '✕ ') + label))));
      }

      const acts = el('div.hold-acts');
      const act = (label, title, fn, solid) => acts.appendChild(el(solid ? 'button.solid-btn' : 'button.dash-btn', { type: 'button', title, onclick: fn }, label));
      if (P.spend) act(CUR() + ' Send money', 'Wire money from ' + e.name, () => this.transferModal(null, P.spendAccts[0].id), true);
      if (P.trade && this.goodsOf(e).length) act('▣ Send goods', 'Ship goods from ' + e.name, () => this.tradeModal(null, null, e.id));
      if (P.trade) act('⇄ Trade offer', 'Propose a swap from ' + e.name, () => this.tradeOfferComposer(e.id));
      if (P.capital) act('＋ Raise capital', 'Issue new shares', () => this.marketOfferModal(e));
      if (e.type === 'company' && e.sharePrice !== undefined) act('◷ On the exchange', 'Open the stock', () => { W.ecoTab = 'markets'; W.mktTab = 'exchange'; W.exchOpen = e.id; App.renderView(); });
      if (acts.children.length) pane.appendChild(acts);

      // ---- panes: the holdings, the company desk, one site's desk ----
      const site = W.holdSite && propById(W.holdSite);
      const siteOk = site && site.ownerId === id && P.siteIds.has(site.id);
      const panes = [['overview', 'Holdings']];
      if (P.ops) panes.push(['ops', '⚙ Company operations']);
      if (siteOk) panes.push(['site', '⚙ ' + site.name]);
      if (!panes.some(p => p[0] === W.holdPane)) W.holdPane = 'overview';
      if (panes.length > 1) {
        pane.appendChild(el('div.hold-tabs', panes.map(([k, label]) => el('button.hold-tab', { type: 'button', class: W.holdPane === k ? 'active' : '',
          onclick: () => { W.holdPane = k; App.renderView(); this.holdFocus(); } }, label,
          k === 'site' ? el('span.ht-x', { title: 'Close the site', onclick: (ev) => { ev.stopPropagation(); W.holdSite = null; W.holdPane = 'overview'; App.renderView(); } }, '✕') : null))));
      }
      const body = el('div.hold-body');
      pane.appendChild(body);
      if (W.holdPane === 'ops') return this.viewCompanyOps(body, e.id);
      if (W.holdPane === 'site') return this.viewPropertyOps(body, site.id);
      this.holdOverview(body, e, ctl, P);
    },

    holdOverview(body, e, ctl, P) {
      const id = e.id;
      const accts = this.accountsOf(id);
      const goods = this.goodsOf(e);
      const props = this.propsOf(id);
      const stakes = this.stakesOf(id);
      const cash = accts.reduce((s, a) => s + (a.balance || 0), 0);
      const goodsV = this.goodsValue(goods);
      const propV = props.reduce((s, p) => s + (p.value || 0), 0);
      const sharesV = stakes.reduce((s, x) => s + x.value, 0);
      body.appendChild(this.statStrip([
        ['Cash', accts.length ? this.bigMoney(cash) : '—', accts.length + ' account' + (accts.length === 1 ? '' : 's')],
        ['Goods', this.bigMoney(goodsV), goods.length + ' line' + (goods.length === 1 ? '' : 's')],
        ['Property', this.bigMoney(propV), props.length + ' site' + (props.length === 1 ? '' : 's')],
        ['Shares held', this.bigMoney(sharesV), stakes.length + ' compan' + (stakes.length === 1 ? 'y' : 'ies')]
      ]));

      // a stake with no control: what you own of it, and how to grow it
      if (ctl.level === 'stake') {
        const chain = ownershipSetClient();
        body.appendChild(this.secLabel('Your stake'));
        const rows = (e.shareholders || []).filter(h => chain.has(h.entityId) && h.shares > 0);
        body.appendChild(el('div.hold-list', rows.map(h => this.holdShareRow({ c: e, shares: h.shares, pct: this.sharePctBy(e, new Set([h.entityId])), value: h.shares * this.livePrice(e) }, h.entityId, true))));
      }

      // ---- money ----
      if (accts.length) {
        body.appendChild(this.secLabel('Money'));
        body.appendChild(el('div.hold-grid.accts', accts.map(a => {
          const spend = P.spendAccts.includes(a);
          return el('div.acct-card',
            el('div.ac-name', a.name),
            el('div.ac-bal', { class: a.balance < 0 ? 'neg' : '' }, fmtMoney(a.balance)),
            el('div.ac-foot',
              el('span.ac-note', spend ? (ctl.grant && ctl.grant.spendLimitPerTurn != null ? 'cap ' + fmtMoney(ctl.grant.spendLimitPerTurn) + '/turn' : 'yours to spend') : 'view only'),
              spend ? el('button.dash-btn.btn-xs', { type: 'button', onclick: () => this.transferModal(null, a.id) }, 'Send') : null));
        })));
      }

      // ---- goods ----
      if (goods.length || P.trade) {
        body.appendChild(this.secLabel('Goods' + (goods.length ? ' · ' + fmtMoney(goodsV) : '')));
        if (!goods.length) body.appendChild(el('div.hold-empty', 'Nothing on the shelves.'));
        else {
          const grid = el('div.hold-grid.goods');
          const paint = () => {
            clear(grid);
            const q = (W.holdGoodsQ || '').trim().toLowerCase();
            const rows = goods.filter(r => !q || itemById(r.itemId).name.toLowerCase().includes(q))
              .sort((a, b) => b.qty * effPrice(itemById(b.itemId)) - a.qty * effPrice(itemById(a.itemId)));
            for (const r of rows.slice(0, 80)) grid.appendChild(this.goodsTile(r, e, P));
            if (!rows.length) grid.appendChild(el('div.hold-empty', 'No match.'));
          };
          if (goods.length > 12) body.appendChild(el('input.text-input.hold-search', { placeholder: 'Find goods…', value: W.holdGoodsQ || '', oninput: (ev) => { W.holdGoodsQ = ev.target.value; paint(); } }));
          paint();
          body.appendChild(grid);
        }
      }

      // ---- properties ----
      if (props.length) {
        body.appendChild(this.secLabel('Properties · ' + fmtMoney(propV)));
        body.appendChild(el('div.hold-grid.props', props.slice(0, 60).map(pr => this.siteCard(pr, e, P))));
        if (props.length > 60) body.appendChild(el('div.hold-empty', `…and ${props.length - 60} more — open the file for the full register.`));
      }

      // ---- shares this entity holds ----
      if (stakes.length) {
        body.appendChild(this.secLabel('Shares held · ' + fmtMoney(sharesV)));
        body.appendChild(el('div.hold-list', stakes.map(s => this.holdShareRow(s, id, P.trade || P.full))));
      }

      // ---- who holds it, and whom it trusts ----
      if (e.type !== 'person' || (e.roster || []).length) {
        body.appendChild(this.secLabel('Control'));
        const ctlRows = [];
        if (e.ownerId) ctlRows.push(['Owner', this.ownerLink(e.ownerId)]);
        if (e.ceoId) ctlRows.push(['Chief executive', this.ownerLink(e.ceoId)]);
        if (e.leaderId) ctlRows.push(['Leader', this.ownerLink(e.leaderId)]);
        if (Array.isArray(e.executives) && e.executives.length) ctlRows.push(['Executive', el('span', e.executives.map((x, i) => [i ? ', ' : '', this.ownerLink(x)]).flat())]);
        if (Array.isArray(e.shareholders) && e.shareholders.length) {
          const total = e.sharesOutstanding || e.shareholders.reduce((s, h) => s + (h.shares || 0), 0) || 1;
          const top = [...e.shareholders].sort((a, b) => b.shares - a.shares).slice(0, 5);
          const reg = el('div.hold-reg', top.map(h => {
            const p = h.shares / total * 100;
            return el('div.hr-row', el('span.hr-name', { onclick: () => select('entity', h.entityId) }, entName(h.entityId)),
              el('span.hr-bar', el('span', { style: `width:${Math.min(100, p)}%; background:${(entById(h.entityId) || {}).color || 'var(--ink-soft)'};` }), p > 50 ? el('i') : null),
              el('span.hr-pct', this.pctText(p)));
          }));
          ctlRows.push(['Shareholders', reg]);
        }
        for (const [k, v] of ctlRows) body.appendChild(this.kv(k, v));
        this.orgChartSection(body, e);
      }
    },

    goodsTile(r, e, P) {
      const it = itemById(r.itemId);
      return el('div.goods-tile', { title: it.description || it.name },
        el('div.gt-top', { onclick: () => select('item', it.id) }, this.itemIcon(it),
          el('div.gt-id', el('div.gt-name', it.name), el('div.gt-qty', '×' + fmtNum(r.qty)))),
        el('div.gt-val', fmtMoney(r.qty * effPrice(it)), el('span', ' · ' + CUR() + fmtNum(effPrice(it)) + ' ea')),
        P.trade ? el('div.gt-acts',
          el('button.dash-btn.btn-xs', { type: 'button', title: 'Ship it to someone', onclick: () => this.tradeModal(it.id, null, e.id) }, 'Send'),
          el('button.dash-btn.btn-xs', { type: 'button', title: 'Offer it in a trade', onclick: () => this.tradeOfferComposer(e.id, it.id) }, 'Offer')) : null);
    },

    // one site, as a card: what it is, how it runs, what you may do with it
    siteCard(pr, owner, P) {
      const prov = provById(pr.provinceId);
      const maxEmp = pr.maxEmployees !== undefined ? Math.max(0, Math.round(pr.maxEmployees)) : Math.max(1, pr.employees || 1);
      const co = owner && owner.type === 'company' ? owner : null;
      const wf = this.wfMult({
        hours: pr.workHours !== undefined ? pr.workHours : (co && co.workHours !== undefined ? co.workHours : 8),
        safety: pr.safety !== undefined ? pr.safety : (co && co.safety !== undefined ? co.safety : 'standard'),
        employees: pr.employees || 0, cap: maxEmp, invested: pr.upgradeInvested, value: pr.value });
      const rev = pr.prodMode === 'goods' ? (pr.produces || []).reduce((s, x) => s + (x.perTurn || 0) * effPrice(itemById(x.itemId)), 0) * wf
        : pr.prodMode === 'cash' ? (Number(pr.cashPerTurn) || 0) * wf : 0;
      const wage = pr.wagePerTurn !== undefined ? pr.wagePerTurn : (co ? (co.wagePerTurn === undefined ? 1 : co.wagePerTurn) : 0);
      const net = rev - effUpkeep(pr) - (pr.employees || 0) * (Number(wage) || 0);
      const makes = pr.prodMode === 'goods' ? (pr.produces || []).map(x => fmtNum(x.perTurn * wf, 1) + ' ' + ((itemById(x.itemId) || {}).name || x.itemId)).join(', ') + ' / turn'
        : pr.prodMode === 'cash' ? fmtMoney(rev) + ' / turn' : 'upkeep only';
      const cond = pr.vars && pr.vars.condition !== undefined ? Math.round(pr.vars.condition) : null;
      const stock = (pr.inventory || []).reduce((s, x) => s + (x.qty || 0) * effPrice(itemById(x.itemId)), 0);
      const canRun = P.siteIds.has(pr.id);
      const deed = (owner.inventory || []).map(x => itemById(x.itemId)).find(it => it && it.meta && it.meta.propertyId === pr.id);
      const flags = [];
      if (pr.vars && pr.vars.strike) flags.push(el('span.sc-flag.bad', 'On strike'));
      if (pr.accident && pr.accident.turn >= ((S().settings.time || {}).turn || 0) - 2) flags.push(el('span.sc-flag.bad', 'Accident'));
      if (pr.vars && pr.vars.supplyFulfillment !== undefined && pr.vars.supplyFulfillment !== null && pr.vars.supplyFulfillment < 0.99) flags.push(el('span.sc-flag', 'Inputs ' + Math.round(pr.vars.supplyFulfillment * 100) + '%'));
      return el('div.site-card', { class: W.holdSite === pr.id ? 'active' : '' },
        el('div.sc-head', { onclick: () => select('property', pr.id), title: 'Open the site file' },
          el('div.sc-name', pr.name), el('div.sc-val', fmtMoney(pr.value))),
        el('div.sc-sub', [(pr.kind || pr.type || 'property').replace(/_/g, ' '), prov ? prov.name : null].filter(Boolean).join(' · '), ...flags),
        el('div.sc-makes', makes),
        el('div.sc-stats',
          el('span', { title: 'Staff / capacity' }, '👷 ' + fmtNum(pr.employees || 0) + '/' + fmtNum(maxEmp)),
          el('span', { class: net >= 0 ? 'pos' : 'neg', title: 'Net per turn (output − upkeep − wages)' }, (net >= 0 ? '+' : '') + fmtMoney(net)),
          stock > 0 ? el('span', { title: 'Stock held at the site' }, '▣ ' + CUR() + fmtCompact(stock)) : null),
        cond !== null && pr.prodMode !== 'none' ? el('div.sc-cond', { title: 'Site condition ' + cond + '%' }, el('span', { style: `width:${cond}%; background:${cond >= 70 ? 'var(--good)' : cond >= 40 ? 'var(--ink-soft)' : 'var(--accent)'};` })) : null,
        el('div.sc-acts',
          canRun ? el('button.dash-btn.btn-xs', { type: 'button', onclick: () => { W.holdSite = pr.id; W.holdPane = 'site'; W.propOpsDraft = null; App.renderView(); this.holdFocus(); } }, '⚙ Run') : null,
          el('button.dash-btn.btn-xs', { type: 'button', title: 'Show on the map', onclick: () => { App.go('map'); setTimeout(() => select('property', pr.id), 300); } }, '◎ Map'),
          deed && P.trade ? el('button.dash-btn.btn-xs', { type: 'button', title: 'Sell or hand over the deed', onclick: () => this.tradeModal(deed.id, null, owner.id) }, '⇄ Deed') : null));
    },

    /* ---------- open pickers for the money & goods modals ----------
       Everything visible at once instead of a dropdown: the parties you can
       act for as avatar chips, a searchable recipient list with your recent
       counterparties on top, goods as tiles with their quantity and worth,
       and a quantity box with one-click presets. */

    // One of a few entities: avatar chips (a searchable list when many).
    partyChoice(state, key, ids, onchange, sub) {
      ids = ids.filter(id => entById(id));
      if (!ids.includes(state[key])) state[key] = ids[0];
      const me = W.me && W.me.entityId;
      if (ids.length > 8) {
        return Forms.pick(state, key, ids.map(id => [id, entById(id).name, sub ? sub(id) : TYPE_LABEL[entById(id).type]]),
          { placeholder: 'Search your side…', height: 150, onchange });
      }
      const row = el('div.party-chips');
      const paint = () => { for (const b of row.children) b.classList.toggle('active', b.dataset.id === state[key]); };
      for (const id of ids) {
        const e = entById(id);
        row.appendChild(el('button.party-chip', { type: 'button', 'data-id': id, title: e.name,
          onclick: () => { if (state[key] === id) return; state[key] = id; paint(); if (onchange) onchange(id); } },
          this.avatar(e, 20), el('span.pc-name', id === me ? 'You' : (e.abbrev || e.name)), sub ? el('span.pc-sub', sub(id)) : null));
      }
      paint();
      return row;
    },
    // Anyone in the world: recent counterparties as chips over a searchable list.
    recipientPick(state, key, exclude, onchange) {
      const ex = new Set([].concat(exclude || []));
      const opts = S().entities.filter(e => !ex.has(e.id)).map(e => [e.id, e.name, TYPE_LABEL[e.type] || e.type]);
      const pick = Forms.pick(state, key, opts, { placeholder: 'Search people, companies, nations…', height: 170, onchange });
      const recents = this.recentRecipients().filter(r => !ex.has(r.entityId));
      if (!recents.length) return pick;
      return el('div',
        el('div.chip-row.recips', recents.map(r => el('span.recip-chip', { onclick: () => { state[key] = r.entityId; pick._render(); if (onchange) onchange(r.entityId); } }, '↺ ' + r.name))),
        pick);
    },
    // Goods as tiles: rows [{ itemId, qty }] (qty null = any amount).
    // mode 'one' keeps state[key] = itemId; 'add' calls onPick(itemId) per click.
    itemTiles(rows, state, key, opts) {
      opts = opts || {};
      const wrap = el('div.item-tiles-wrap');
      const grid = el('div.item-tiles', { style: opts.height ? `max-height:${opts.height}px;` : undefined });
      let q = '';
      const paint = () => {
        clear(grid);
        const list = rows.filter(r => itemById(r.itemId) && (!q || itemById(r.itemId).name.toLowerCase().includes(q))).slice(0, opts.max || 48);
        for (const r of list) {
          const it = itemById(r.itemId);
          const on = opts.isOn ? opts.isOn(r.itemId) : state && state[key] === r.itemId;
          grid.appendChild(el('button.item-tile', { type: 'button', class: on ? 'active' : '', title: it.name,
            onclick: () => {
              if (opts.onPick) opts.onPick(r.itemId);
              else { state[key] = r.itemId; if (opts.onchange) opts.onchange(r.itemId); }
              paint();
            } },
            this.itemIcon(it),
            el('span.it-name', it.name),
            el('span.it-qty', r.qty === null || r.qty === undefined ? CUR() + fmtNum(effPrice(it)) : '×' + fmtNum(r.qty))));
        }
        if (!list.length) grid.appendChild(el('div.hold-empty', rows.length ? 'No match.' : (opts.empty || 'Nothing here.')));
      };
      if (rows.length > (opts.searchFrom || 10)) {
        wrap.appendChild(el('input.text-input.tile-search', { placeholder: opts.placeholder || 'Find goods…',
          oninput: (ev) => { q = ev.target.value.trim().toLowerCase(); paint(); } }));
      }
      paint();
      wrap.appendChild(grid);
      wrap._render = paint;
      return wrap;
    },
    // A quantity box with presets; max() gives the most there is (or null).
    qtyField(state, key, max) {
      const input = el('input.text-input.qty-input', { type: 'number', min: '0', step: 'any', value: state[key] !== undefined ? String(state[key]) : '1',
        oninput: (ev) => { state[key] = Number(ev.target.value); } });
      state[key] = Number(input.value);
      const set = (v) => { const r = Math.round(v * 1e6) / 1e6; state[key] = r; input.value = String(r); };
      const chips = el('div.qty-chips');
      const paintChips = () => {
        clear(chips);
        const m = max ? max() : null;
        const preset = (label, fn) => chips.appendChild(el('button.chip.chip-xs', { type: 'button', onclick: () => set(fn()) }, label));
        preset('1', () => 1); preset('10', () => 10);
        if (m !== null && m > 0) {
          if (m >= 200) preset('100', () => 100);
          preset('25%', () => m / 4); preset('Half', () => m / 2); preset('All · ' + fmtNum(m), () => m);
        }
      };
      paintChips();
      const wrap = el('div.qty-field', input, chips);
      wrap._refresh = () => { paintChips(); const m = max ? max() : null; if (m !== null && state[key] > m) set(m); };
      return wrap;
    },

    holdShareRow(s, holderId, canTrade) {
      const c = s.c;
      const entry = market_holdEntryOfClient(c, holderId);
      const px = this.livePrice(c);
      const gain = entry ? (px - entry) / entry * 100 : null;
      const asMe = holderId === (W.me && W.me.entityId);
      return el('div.share-row',
        this.avatar(c, 26),
        el('div.sr-id', el('div.sr-name', { onclick: () => select('entity', c.id) }, c.name),
          el('div.sr-sub', fmtNum(s.shares) + ' shares · ' + this.pctText(s.pct) + ' of the company' + (asMe ? '' : ' · held by ' + entName(holderId)))),
        el('div.sr-val', CUR() + fmtNum(s.value), gain !== null ? el('span', { class: gain >= 0 ? 'pos' : 'neg' }, ' ' + (gain >= 0 ? '+' : '') + fmtNum(gain, 1) + '%') : null),
        canTrade && c.sharePrice !== undefined ? el('div.sr-acts',
          el('button.dash-btn.btn-xs', { type: 'button', onclick: () => this.marketBuyModal(c, holderId) }, 'Buy'),
          el('button.dash-btn.btn-xs', { type: 'button', onclick: () => this.marketSellModal(c, holderId) }, 'Sell')) : null);
    }
  });
})();
