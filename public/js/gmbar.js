'use strict';
/* Phase 3 — GM Command Bar: a slim always-available toolbar shown at the
   bottom of the screen (any view) when the current operator has GM
   clearance. Complements GM Studio (bulk editor) with day-to-day one-click
   actions: advance turns, find a player/entity, and a quick-actions menu
   (trigger event, mint/transfer, assign ownership, influence, announcement,
   call election).

   This file only ever touches its own DOM subtree (#gm-bar, appended once to
   document.body) — it does not read or write views.js/gm.js state. */

const GMBar = {
  root: null,
  menuOpen: false,

  render() {
    if (!isGM() || !S()) {
      if (this.root) this.root.classList.add('hidden');
      return;
    }
    if (!this.root) this.mount();
    this.root.classList.remove('hidden');
    this.renderFindResults(); // keep an open results list in sync with fresh state
  },

  mount() {
    const findInput = el('input.text-input.gmbar-find', { placeholder: 'Find a player or entity…' });
    findInput.addEventListener('input', () => this.renderFindResults());
    findInput.addEventListener('focus', () => this.renderFindResults());
    this.findInput = findInput;
    this.findResults = el('div.gmbar-find-results.hidden');

    const menuBtn = el('button.dash-btn', { onclick: (e) => { e.stopPropagation(); this.toggleMenu(); } }, 'Quick Actions ▾');
    this.menu = el('div.gmbar-menu.hidden',
      el('div.gmbar-menu-item', { onclick: () => { this.closeMenu(); this.triggerEventModal(); } }, 'Trigger Event…'),
      el('div.gmbar-menu-item', { onclick: () => { this.closeMenu(); Views.transferModal(); } }, 'Transfer Funds…'),
      el('div.gmbar-menu-item', { onclick: () => { this.closeMenu(); this.mintModal(); } }, 'Mint / Withdraw…'),
      el('div.gmbar-menu-item', { onclick: () => { this.closeMenu(); this.assignOwnershipModal(); } }, 'Assign Ownership…'),
      el('div.gmbar-menu-item', { onclick: () => { this.closeMenu(); this.influenceModal(); } }, 'Influence…'),
      el('div.gmbar-menu-item', { onclick: () => { this.closeMenu(); this.partySupportModal(); } }, 'Party Support…'),
      el('div.gmbar-menu-item', { onclick: () => { this.closeMenu(); this.electionModal(); } }, 'Call Election…'),
      el('div.gmbar-menu-item', { onclick: () => { this.closeMenu(); this.announcementModal(); } }, 'Announcement…')
    );

    this.root = el('div#gm-bar.gm-bar.hidden',
      el('span.gmbar-kicker', 'GM'),
      el('div.gmbar-group',
        el('span.gmbar-label', 'Advance'),
        el('button.gmbar-btn', { onclick: () => this.advance(1) }, '+1'),
        el('button.gmbar-btn', { onclick: () => this.advance(7) }, '+7'),
        el('button.gmbar-btn', { onclick: () => this.advance(30) }, '+30'),
        el('button.gmbar-btn', { title: 'Preview the next turn without committing it', onclick: () => this.previewTurn() }, '🔍')
      ),
      el('div.gmbar-group.gmbar-find-wrap',
        findInput,
        this.findResults
      ),
      el('div.gmbar-group', { style: 'position:relative;' },
        menuBtn,
        this.menu
      )
    );
    document.body.appendChild(this.root);

    // close the menu / results when clicking elsewhere
    document.addEventListener('click', (e) => {
      if (this.menu && !this.menu.contains(e.target) && e.target !== menuBtn) this.closeMenu();
      if (this.findResults && !this.findResults.contains(e.target) && e.target !== findInput) this.findResults.classList.add('hidden');
    });
  },

  toggleMenu() { this.menuOpen ? this.closeMenu() : this.openMenu(); },
  openMenu() { this.menuOpen = true; this.menu.classList.remove('hidden'); },
  closeMenu() { this.menuOpen = false; if (this.menu) this.menu.classList.add('hidden'); },

  async advance(steps) {
    try { await POST('/api/gm/advance', { steps }); toast(steps === 1 ? 'One turn passes.' : `${steps} turns pass.`); }
    catch (e) { toast(e.message, true); }
  },

  // Turn preview (Phase 25 QoL) — dry-run the next turn server-side and show
  // the diff (nothing is committed; see /api/gm/advance b.preview).
  async previewTurn() {
    let r;
    try { r = await POST('/api/gm/advance', { steps: 1, preview: true }); }
    catch (e) { return toast(e.message, true); }
    const d = r.diff || {};
    const rows = [];
    const fmtV = (v) => typeof v === 'number' ? fmtNum(Math.round(v * 100) / 100) : String(v);
    for (const g of (d.globalVars || []).slice(0, 14)) rows.push(el('div.var-row', el('span.var-label', g.key), el('span.var-value', fmtV(g.from) + ' → ' + fmtV(g.to))));
    for (const p of (d.provinces || []).slice(0, 6)) {
      rows.push(el('div', { style: 'font-family:var(--font-mono); font-size:10px; letter-spacing:.08em; color:var(--ink-faint); margin-top:8px;' }, p.name.toUpperCase()));
      for (const c of p.changes.slice(0, 6)) rows.push(el('div.var-row', el('span.var-label', c.key), el('span.var-value', fmtV(c.from) + ' → ' + fmtV(c.to))));
    }
    if (d.moneyMoved) rows.push(el('div.var-row', el('span.var-label', 'Money moved'), el('span.var-value', fmtMoney(d.moneyMoved))));
    for (const n of (d.news || []).slice(0, 5)) rows.push(el('div', { style: 'font-size:12px; color:var(--ink-soft); margin-top:4px;' }, '¶ ' + n.headline));
    if (r.error) rows.unshift(el('div', { style: 'color:var(--accent);' }, 'Preview error: ' + r.error));
    if (!rows.length) rows.push(el('div', { style: 'color:var(--ink-faint);' }, 'The next turn changes nothing visible.'));
    openModal('NEXT TURN — PREVIEW (not committed)', el('div', rows), [{ label: 'Close', cls: 'dash-btn', onClick: () => { } }], true);
  },

  /* ---------- Find: fuzzy search over users + entities ---------- */
  renderFindResults() {
    if (!this.findInput || !this.findResults) return;
    const q = this.findInput.value.trim().toLowerCase();
    clear(this.findResults);
    if (!q) { this.findResults.classList.add('hidden'); return; }

    const rows = [];
    for (const u of (S().users || [])) {
      if ((u.username && u.username.toLowerCase().includes(q)) || (u.displayName && u.displayName.toLowerCase().includes(q))) {
        rows.push({ kind: 'user', id: u.id, label: u.displayName || u.username, sub: '@' + u.username, obj: u });
      }
    }
    for (const e of S().entities) {
      if (e.name && e.name.toLowerCase().includes(q)) {
        rows.push({ kind: 'entity', id: e.id, label: e.name, sub: TYPE_LABEL[e.type] || e.type });
      }
    }
    rows.slice(0, 24).forEach(r => {
      this.findResults.appendChild(el('div.pick-item', {
        onclick: () => {
          if (r.kind === 'user') {
            if (r.obj.entityId) { App.go('map'); select('entity', r.obj.entityId); }
            else toast('That user has no linked persona entity.', true);
          } else {
            App.go('map'); select('entity', r.id);
          }
          this.findInput.value = '';
          this.findResults.classList.add('hidden');
        }
      }, el('span', r.label), el('span.pi-sub', r.sub)));
    });
    if (!rows.length) this.findResults.appendChild(el('div', { style: 'padding:10px; color:var(--ink-faint); font-size:12px;' }, 'No match.'));
    this.findResults.classList.remove('hidden');
  },

  /* ---------- Trigger Event ---------- */
  triggerEventModal() {
    const manual = (S().events || []).filter(e => e.trigger && e.trigger.type === 'manual');
    if (!manual.length) return toast('No manual-trigger events are defined.', true);
    openModal('TRIGGER EVENT', el('div.pick-list',
      manual.map(e => el('div.pick-item', {
        onclick: async () => {
          try {
            const r = await POST('/api/gm/run-event', { id: e.id });
            toast(r.ran ? `Ran “${e.name}”.` : `“${e.name}” did not run — conditions were not met.`, !r.ran);
          } catch (err) { toast(err.message, true); }
        }
      }, el('span', e.name), el('span.pi-sub', e.description || '')))
    ), [{ label: 'Close', cls: 'dash-btn', onClick: () => {} }]);
  },

  /* ---------- Mint / Withdraw ---------- */
  mintModal() {
    const d = { accountId: (S().accounts[0] || {}).id, amount: '', memo: '' };
    const acctLabel = (a) => `${entName(a.ownerId)} — ${a.name} (${fmtMoney(a.balance)})`;
    openModal('MINT / WITHDRAW', el('div',
      el('label.field-label', 'Account'),
      Forms.sel(d, 'accountId', S().accounts.map(a => [a.id, acctLabel(a)])),
      el('label.field-label', 'Amount (' + CUR() + ') — positive mints, negative withdraws'),
      Forms.num(d, 'amount'),
      el('label.field-label', 'Memo'),
      Forms.text(d, 'memo')
    ), [{
      label: 'Apply', onClick: async () => {
        if (!d.accountId || !d.amount) throw new Error('Account and non-zero amount required.');
        await POST('/api/gm/mint', { accountId: d.accountId, amount: Number(d.amount), memo: d.memo });
        toast('Ledger updated.');
      }
    }, { label: 'Cancel', cls: 'dash-btn', onClick: () => {} }]);
  },

  /* ---------- 3.2 Assign Ownership ---------- */
  assignOwnershipModal(prefTarget) {
    const targets = [
      ...S().entities.filter(e => ['company', 'org', 'party'].includes(e.type)).map(e => ({ kind: 'entity', id: e.id, label: `${e.name} (${TYPE_LABEL[e.type] || e.type})`, entType: e.type })),
      ...S().properties.map(p => ({ kind: 'property', id: p.id, label: `${p.name} (Property)` }))
    ];
    if (!targets.length) return toast('Nothing to reassign yet.', true);
    const d = { targetKey: prefTarget || (targets[0].kind + ':' + targets[0].id) };
    const targetOptions = targets.map(t => [t.kind + ':' + t.id, t.label]);

    const body = el('div');
    const ownerRow = el('div');
    const leaderRow = el('div');
    const rerenderExtras = () => {
      clear(ownerRow); clear(leaderRow);
      const [kind, id] = d.targetKey.split(':');
      ownerRow.appendChild(el('label.field-label', 'New owner'));
      ownerRow.appendChild(Forms.sel(d, 'ownerId', [['__null__', '— none —'], ...Forms.entOptions()]));
      if (kind === 'entity') {
        const e = entById(id);
        if (e && e.type === 'company') {
          leaderRow.appendChild(el('label.field-label', 'New CEO (optional)'));
          leaderRow.appendChild(Forms.sel(d, 'leaderId', [['__null__', '— unchanged —'], ...Forms.entOptions(['person'])]));
        } else if (e && e.type === 'party') {
          leaderRow.appendChild(el('label.field-label', 'New party leader (optional)'));
          leaderRow.appendChild(Forms.sel(d, 'leaderId', [['__null__', '— unchanged —'], ...Forms.entOptions(['person'])]));
        }
      }
    };
    body.appendChild(el('label.field-label', 'Target'));
    body.appendChild(Forms.sel(d, 'targetKey', targetOptions, () => rerenderExtras()));
    body.appendChild(ownerRow);
    body.appendChild(leaderRow);
    rerenderExtras();

    openModal('ASSIGN OWNERSHIP', body, [{
      label: 'Save', onClick: async () => {
        const [kind, id] = d.targetKey.split(':');
        if (kind === 'property') {
          await PATCH('/api/gm/coll/properties/' + id, { ownerId: d.ownerId === '__null__' ? null : d.ownerId || null });
        } else {
          const e = entById(id);
          const patch = { ownerId: d.ownerId === '__null__' ? null : d.ownerId || null };
          if (e && e.type === 'company' && d.leaderId && d.leaderId !== '__null__') patch.ceoId = d.leaderId;
          if (e && e.type === 'party' && d.leaderId && d.leaderId !== '__null__') patch.leaderId = d.leaderId;
          await PATCH('/api/gm/coll/entities/' + id, patch);
        }
        toast('Ownership updated.');
      }
    }, { label: 'Cancel', cls: 'dash-btn', onClick: () => {} }]);
  },

  /* ---------- 3.3 Influence ---------- */
  influenceModal() {
    const metrics = [
      ...(S().settings.demographics.metrics || []).filter(m => m.key !== 'population').map(m => [m.key, m.label]),
      ['approval', 'Approval (province)']
    ];
    const d = { province: 'all', group: 'all', metric: metrics[0][0], amount: 1 };
    const groupOpts = [['all', '— all groups —'], ...(S().settings.demographics.groups || []).map(g => [g, g])];
    const provOpts = Forms.provOptions([['all', '— all provinces —']]);

    const groupRow = el('div');
    const renderGroupRow = () => {
      clear(groupRow);
      if (d.metric === 'approval') return; // province-level var, no demographic group
      groupRow.appendChild(el('label.field-label', 'Group'));
      groupRow.appendChild(Forms.sel(d, 'group', groupOpts));
    };

    const body = el('div',
      el('label.field-label', 'Province'), Forms.sel(d, 'province', provOpts),
      el('label.field-label', 'Metric'), Forms.sel(d, 'metric', metrics, () => renderGroupRow()),
      groupRow,
      el('label.field-label', 'Amount (+/-)'), Forms.num(d, 'amount', '0.1')
    );
    renderGroupRow();

    openModal('INFLUENCE', body, [{
      label: 'Apply', onClick: async () => {
        const amt = Number(d.amount);
        if (!amt) throw new Error('Enter a non-zero amount.');
        let effect;
        if (d.metric === 'approval') {
          effect = { type: 'adjust_var', scope: 'province', target: d.province, key: 'approval', op: 'add', value: String(amt) };
        } else {
          effect = { type: 'adjust_demo', province: d.province, group: d.group, metric: d.metric, op: 'add', value: String(amt) };
        }
        await POST('/api/gm/effect', { effect });
        toast('Influence applied.');
      }
    }, { label: 'Cancel', cls: 'dash-btn', onClick: () => {} }]);
  },

  /* ---------- Party Support ----------
     Adds a lasting bonus/penalty to how the population scores one party
     (party.support[provId].all, read by scoreParty at ×1.2 weight). Unlike a
     scripted voterBase this does NOT freeze anything: demographics, approval
     and every other influence keep moving the polls on top of it. */
  partySupportModal() {
    const parties = S().entities.filter(e => e.type === 'party');
    if (!parties.length) return toast('No parties on file.', true);
    const d = { partyId: parties[0].id, province: 'all', amount: 5 };
    openModal('PARTY SUPPORT', el('div',
      el('div', { style: 'font-size:12.5px; color:var(--ink-soft); margin-bottom:10px; line-height:1.5;' },
        'Shifts how voters score this party from now on — a nudge, not a lock. The simulation keeps drifting on top of it; apply a negative amount to undo. Roughly: +5 is a clear boost, +15 is a landslide-maker.'),
      el('label.field-label', 'Party'), Forms.sel(d, 'partyId', parties.map(p => [p.id, p.name])),
      el('label.field-label', 'Province'), Forms.sel(d, 'province', Forms.provOptions([['all', '— all provinces —']])),
      el('label.field-label', 'Support shift (+/- points)'), Forms.num(d, 'amount', '0.5')
    ), [{
      label: 'Apply', onClick: async () => {
        const amt = Number(d.amount);
        if (!amt) throw new Error('Enter a non-zero amount.');
        const party = entById(d.partyId);
        if (!party) throw new Error('Unknown party.');
        const support = JSON.parse(JSON.stringify(party.support || {}));
        const provIds = d.province === 'all' ? S().provinces.map(p => p.id) : [d.province];
        for (const pid of provIds) {
          support[pid] = support[pid] || {};
          support[pid].all = Math.round(((support[pid].all || 0) + amt) * 10) / 10;
          if (!support[pid].all) delete support[pid];
        }
        await PATCH('/api/gm/coll/entities/' + party.id, { support });
        toast('Support shifted — polls will move with the next refresh.');
      }
    }, { label: 'Cancel', cls: 'dash-btn', onClick: () => {} }]);
  },

  /* ---------- 3.4 Call Election ---------- */
  async electionModal() {
    let tab = 'simulate';
    const parties = S().entities.filter(e => e.type === 'party');
    let polling = null;
    try { polling = await GET('/api/polling'); } catch (e) { /* fall back to blank rows */ }

    const rows = parties.map(p => {
      const pct = polling && polling.national ? (polling.national[p.id] || 0) : 0;
      const totalSeats = S().settings.parliamentSeats || 150;
      return { partyId: p.id, name: p.name, votes: Math.round(pct * 10000), seats: Math.round(pct / 100 * totalSeats) };
    });
    let turnout = 60;

    const body = el('div');
    const tabRow = el('div.btn-row');
    const simulateBtn = el('button.dash-btn', { onclick: () => { tab = 'simulate'; renderTabs(); renderBody(); } }, 'Simulate');
    const manualBtn = el('button.dash-btn', { onclick: () => { tab = 'manual'; renderTabs(); renderBody(); } }, 'Manual entry');
    tabRow.appendChild(simulateBtn); tabRow.appendChild(manualBtn);
    const content = el('div');
    body.appendChild(tabRow);
    body.appendChild(content);

    function renderTabs() {
      simulateBtn.classList.toggle('active', tab === 'simulate');
      manualBtn.classList.toggle('active', tab === 'manual');
    }
    function renderBody() {
      clear(content);
      if (tab === 'simulate') {
        content.appendChild(el('p', { style: 'font-family:var(--font-voice); font-size:14px; line-height:1.6;' },
          'Runs the full simulation: current polling, demographic turnout and D’Hondt seat apportionment decide the result.'));
      } else {
        const table = el('table.data',
          el('thead', el('tr', el('th', 'Party'), el('th.num', 'Votes'), el('th.num', 'Seats'))),
          el('tbody', rows.map(r => el('tr',
            el('td', r.name),
            el('td.num', el('input.text-input', { type: 'number', min: '0', value: r.votes, style: 'width:110px;', oninput: (e) => r.votes = Number(e.target.value) || 0 })),
            el('td.num', el('input.text-input', { type: 'number', min: '0', value: r.seats, style: 'width:70px;', oninput: (e) => r.seats = Number(e.target.value) || 0 }))
          )))
        );
        content.appendChild(table);
        content.appendChild(el('label.field-label', 'Turnout %'));
        const turnoutInput = el('input.text-input', { type: 'number', min: '0', max: '100', value: turnout, oninput: (e) => turnout = Number(e.target.value) || 0 });
        content.appendChild(turnoutInput);
        const totalSeats = S().settings.parliamentSeats || 150;
        content.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:10px; color:var(--ink-faint); margin-top:6px;' },
          `Parliament has ${totalSeats} seats. Seats assigned must not exceed this total.`));
      }
    }
    renderTabs(); renderBody();

    openModal('CALL ELECTION', body, [{
      label: 'Run Election', onClick: async () => {
        if (tab === 'simulate') {
          const r = await POST('/api/gm/election', {});
          toast('Election held: ' + (r.election && r.election.national[0] ? r.election.national[0].partyId : 'result recorded') + '.');
        } else {
          const seatSum = rows.reduce((s, r) => s + (r.seats || 0), 0);
          const totalSeats = S().settings.parliamentSeats || 150;
          if (seatSum > totalSeats) throw new Error(`Seats assigned (${seatSum}) exceed the ${totalSeats}-seat parliament.`);
          await POST('/api/gm/election', { manual: { rows: rows.map(r => ({ partyId: r.partyId, votes: r.votes, seats: r.seats })), turnout } });
          toast('Manual election result recorded.');
        }
      }
    }, { label: 'Cancel', cls: 'dash-btn', onClick: () => {} }], true);
  },

  /* ---------- Announcement (stub-ish, Phase 10 territory) ---------- */
  announcementModal() {
    const papers = S().settings.newspapers || [];
    const d = { headline: '', body: '', category: 'General', paperId: (papers[0] || {}).id, publish: true };
    openModal('ANNOUNCEMENT', el('div',
      el('label.field-label', 'Newspaper'),
      Forms.sel(d, 'paperId', papers.map(p => [p.id, p.name])),
      el('label.field-label', 'Headline'), Forms.text(d, 'headline'),
      el('label.field-label', 'Category'), Forms.text(d, 'category', 'Politics'),
      el('label.field-label', 'Body'), Forms.area(d, 'body'),
      Forms.check(d, 'publish', 'Publish immediately (otherwise saved as a draft)')
    ), [{
      label: 'Send', onClick: async () => {
        if (!d.headline.trim()) throw new Error('A headline is required.');
        await POST('/api/news', { headline: d.headline, body: d.body, category: d.category, paperId: d.paperId, publish: !!d.publish });
        toast('Announcement filed.');
      }
    }, { label: 'Cancel', cls: 'dash-btn', onClick: () => {} }]);
  }
};
