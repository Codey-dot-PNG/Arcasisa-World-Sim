'use strict';
/* War Room › Military — a nation's armed forces at a glance and at hand.
   Loaded after war-peace.js; folded into `War`.

   The War Room has two tabs (W.warTab): the SITUATION reports (war.js) and
   this desk. Pick a nation (every one whose stock this operator may see —
   the server only ships those inventories, api.filterState) and read:

   · the arsenal — small arms, tanks, warships, aircraft and fuel, wherever
     they sit (national stock, military depots, carried by units in the
     field), with readiness bars and the record over time (state.militaryLog,
     one row per turn and every 30 conflict ticks — server/military.js);
   · each live conflict it fights in — strength over time (doc.series), its
     formations with their kit, fuel and whereabouts;

   and, where the operator runs those forces (state.milCommand), act:

   · field orders — send formations to a city, hold, stand them down (kit back
     to stock), issue a weapon model, raise new divisions from stock (police
     detachments in a protest) — /api/war/command and /api/military/*;
   · standing orders — the supply doctrine (draw order, arms and fuel
     rations) and, for a government, the deployment plan a war or protest
     starts from (garrison posts, armour muster, fleet base, police posts) —
     POST /api/military/plan;
   · depots — move stock between the national store and its military sites
     (POST /api/property/items; a depot lost to the enemy is lost with it).

   Nothing here decides an outcome: every order goes to the server, which
   re-checks authority and applies it; the desk only renders what came back. */
(function () {
  const KINDS = ['smallarms', 'tank', 'warship', 'aircraft', 'fuel'];
  const KIND = {
    smallarms: { label: 'Small arms', short: 'Rifles', unit: '' },
    tank: { label: 'Tanks', short: 'Tanks', unit: '' },
    warship: { label: 'Warships', short: 'Warships', unit: '' },
    aircraft: { label: 'Aircraft', short: 'Aircraft', unit: '' },
    fuel: { label: 'Fuel', short: 'Fuel', unit: ' bbl' },
    men: { label: 'Soldiers in the field', short: 'Soldiers', unit: '' }
  };
  const LOG_COL = { smallarms: 0, tank: 1, warship: 2, aircraft: 3, fuel: 4, men: 5 };
  const POST_LABEL = ['None', 'Normal', 'Strong', 'Fortress'];
  const RATIONS = [[1, 'Full'], [0.75, '75%'], [0.5, '50%'], [0.25, '25%']];
  const live = (u) => u && !u.dead && u.state !== 'dead' && u.strength > 0;
  const fmtN = (n) => Math.round(n || 0).toLocaleString('en-US');

  Object.assign(War, {
    _milSel: new Set(),      // picked formation ids (survive re-renders)
    _milDraft: null,         // { nid, plan } — standing orders being edited

    milKindOf(item) {
      const w = item && item.meta && item.meta.weapon;
      if (!w) return null;
      return KINDS.includes(w.kind) ? w.kind : 'smallarms';
    },
    milIndex() {
      const idx = {};
      for (const it of S().items || []) { const k = this.milKindOf(it); if (k) idx[it.id] = k; }
      return idx;
    },
    _milPrincipal(doc, side) {
      return side === 'att' ? ((doc.kind === 'protest' && doc.protest && doc.protest.organizerId) || doc.attackerId) : doc.defenderId;
    },
    milNationOf(doc, u) { return u.nationId || this._milPrincipal(doc, u.side); },
    milLiveDocs() { return [S().war, S().protest].filter(d => d && d.active); },
    // the nations this operator may open: the ones whose stock they can see
    // that are nations (a government, a foreign power) or fight in a live
    // conflict; the ones they run first
    milNations() {
      const idx = this.milIndex(), cmd = S().milCommand || {};
      const fighting = new Set();
      for (const d of this.milLiveDocs()) { fighting.add(d.defenderId); fighting.add(this._milPrincipal(d, 'att')); for (const u of d.units || []) if (u.nationId) fighting.add(u.nationId); }
      const armed = (e) => e.inventory.some(r => idx[r.itemId] && r.qty > 0);
      const out = S().entities.filter(e => Array.isArray(e.inventory) && (fighting.has(e.id) ||
        ((e.type === 'government' || e.type === 'foreign') && (armed(e) || e.militaryPlan || this.milDepots(e.id).length))));
      const rank = (e) => (cmd[e.id] ? 0 : 4) + (fighting.has(e.id) ? 0 : 2) + (e.type === 'government' ? 0 : 1);
      return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    },
    milAccess(nid) { return (S().milCommand || {})[nid] || null; },
    milDepots(nid) { return (S().properties || []).filter(p => p.type === 'military' && p.ownerId === nid); },
    // mirrors server/military.js totals(): stock / depots / field by kind
    milTotals(nid) {
      const idx = this.milIndex();
      const blank = () => ({ smallarms: 0, tank: 0, warship: 0, aircraft: 0, fuel: 0 });
      const t = { stock: blank(), depots: blank(), field: blank(), men: 0, units: 0, models: {} };
      const add = (bucket, r) => {
        const k = idx[r.itemId];
        if (!k || !(r.qty > 0)) return;
        t[bucket][k] += r.qty;
        const m = t.models[r.itemId] || (t.models[r.itemId] = { stock: 0, depots: 0, field: 0 });
        m[bucket] += r.qty;
      };
      const e = entById(nid);
      for (const r of (e && e.inventory) || []) add('stock', r);
      for (const p of this.milDepots(nid)) for (const r of p.inventory || []) add('depots', r);
      for (const d of this.milLiveDocs()) for (const u of d.units || []) {
        if (!live(u) || this.milNationOf(d, u) !== nid) continue;
        t.men += u.strength; t.units++;
        for (const r of u.inv || []) add('field', r);
      }
      t.all = (k) => t.stock[k] + t.depots[k] + t.field[k];
      return t;
    },
    milCfg() {
      const w = (S().settings || {}).war || {};
      return { tankCap: Number(w.tankCapacity) || 25, shipCap: Number(w.shipCapacity) || 25, fuelPer: Number(w.fuelPerStrength) || 0.01, raiseMax: Number(w.raiseMax) || 12 };
    },
    // a unit's primary weapon kind and how full it is
    milKit(u) {
      const idx = this.milIndex(), cfg = this.milCfg();
      const kind = u.kind === 'armored' ? 'tank' : u.kind === 'warship' ? 'warship' : u.kind === 'boat' ? null : 'smallarms';
      let carried = 0, fuel = 0, top = null, topQ = 0;
      for (const r of u.inv || []) {
        const k = idx[r.itemId];
        if (k === 'fuel') fuel += r.qty;
        else if (k && k === kind) { carried += r.qty; if (r.qty > topQ) { topQ = r.qty; top = r.itemId; } }
      }
      const cap = kind === 'tank' ? cfg.tankCap : kind === 'warship' ? cfg.shipCap : Math.max(1, Math.ceil(u.strength));
      const tank = (u.strength || 0) * cfg.fuelPer;
      return { kind, armed: kind ? Math.min(1, carried / cap) : null, carried, cap, fuel: tank > 0 ? Math.min(1, fuel / tank) : null, top };
    },
    milNear(pos) {
      let best = null, bd = Infinity;
      for (const c of S().cities || []) {
        if (!Array.isArray(c.pos)) continue;
        const d = Math.hypot(c.pos[0] - pos[0], c.pos[1] - pos[1]);
        if (d < bd) { bd = d; best = c; }
      }
      return best ? (bd < 45 ? best.name : 'near ' + best.name) : '—';
    },

    /* ---------- the tab row ---------- */
    renderWarTabs(inner) {
      const tab = W.warTab === 'military' ? 'military' : 'situation';
      inner.appendChild(el('div.chip-row.war-tabs',
        el('button.chip', { class: tab === 'situation' ? 'active' : '', onclick: () => { W.warTab = 'situation'; App.renderView(); } }, 'Situation'),
        el('button.chip', { class: tab === 'military' ? 'active' : '', onclick: () => { W.warTab = 'military'; App.renderView(); } }, 'Military')));
      return tab;
    },

    /* ---------- the desk ---------- */
    renderMilitary(inner) {
      const nations = this.milNations();
      inner.appendChild(el('div.doc-sub', 'the armed forces · arsenal, readiness, deployment and standing orders'));
      if (!nations.length) {
        inner.appendChild(el('div.protest-note', 'You run no armed forces, and their arsenals are not shared with you. What is public — the formations in the field — follows.'));
        for (const d of this.milLiveDocs()) this._milPublicConflict(inner, d);
        if (!this.milLiveDocs().length) inner.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'No conflict is under way.'));
        return;
      }
      if (!nations.some(n => n.id === W.milNation)) W.milNation = nations[0].id;
      // war ticks don't broadcast, so the arsenal record (state.militaryLog)
      // would sit still mid-war — pull the world now and then while watching
      if (this.milLiveDocs().length && typeof refreshState === 'function' && Date.now() - (this._milFetchAt || 0) > 30000) {
        this._milFetchAt = Date.now();
        setTimeout(() => refreshState().catch(() => {}), 0);
      }
      const nation = entById(W.milNation);
      if (nations.length > 1) {
        inner.appendChild(el('div.chip-row.mil-nations', nations.map(n => el('button.chip', {
          class: n.id === nation.id ? 'active' : '',
          onclick: () => { W.milNation = n.id; this._milSel.clear(); App.renderView(); }
        }, n.abbrev || n.name, this.milAccess(n.id) ? null : el('span.mil-ro', ' · intel')))));
      }
      const acc = this.milAccess(nation.id);
      const t = this.milTotals(nation.id);
      inner.appendChild(Views.secLabel((nation.type === 'government' ? '★ ' : '◆ ') + nation.name));
      inner.appendChild(el('div.war-authority', acc === 'all' ? 'You run these forces: field orders, standing orders and depots.'
        : Array.isArray(acc) ? 'You run the police posts. Everything else is read-only.'
          : 'Read-only — the arsenal is on file with you, but these are not your forces.'));
      const cell = (k) => [KIND[k].short, fmtCompact(t.all(k)) + KIND[k].unit, t.field[k] ? `${fmtCompact(t.field[k])} in the field` : t.depots[k] ? `${fmtCompact(t.depots[k])} in depots` : 'in stock'];
      inner.appendChild(Views.statStrip([
        ['Soldiers in the field', fmtCompact(t.men), `${t.units} formation${t.units === 1 ? '' : 's'}`],
        cell('smallarms'), cell('tank'), cell('warship'), cell('aircraft'), cell('fuel')
      ]));
      this._milReadiness(inner, nation, t);
      this._milCharts(inner, nation);
      for (const d of this.milLiveDocs()) {
        const sides = ['att', 'def'].filter(s => this._milPrincipal(d, s) === nation.id || (d.units || []).some(u => u.side === s && u.nationId === nation.id));
        if (sides.length) this._milConflict(inner, nation, d, sides[0]);
      }
      this._milArsenal(inner, nation, t);
      this._milOrders(inner, nation, acc);
    },

    // what the stock can still do
    _milReadiness(inner, nation, t) {
      const cfg = this.milCfg();
      inner.appendChild(Views.secLabel('Readiness'));
      let soldiers = 0, rifles = 0, fuelHeld = 0, fuelCap = 0;
      for (const d of this.milLiveDocs()) for (const u of d.units || []) {
        if (!live(u) || this.milNationOf(d, u) !== nation.id) continue;
        const k = this.milKit(u);
        if (k.kind === 'smallarms') { soldiers += k.cap; rifles += Math.min(k.carried, k.cap); }
        if (k.fuel !== null) { fuelCap += u.strength * cfg.fuelPer; fuelHeld += k.fuel * u.strength * cfg.fuelPer; }
      }
      const spare = t.stock.smallarms + t.depots.smallarms, spareTanks = t.stock.tank + t.depots.tank;
      const rows = [];
      if (soldiers) rows.push(Views.barRow('Soldiers with a rifle', rifles / soldiers * 100, '#5d6b3c', Math.round(rifles / soldiers * 100) + '%'));
      if (fuelCap) rows.push(Views.barRow('Fuel in the tanks', fuelHeld / fuelCap * 100, '#8a6a2e', Math.round(fuelHeld / fuelCap * 100) + '%'));
      for (const r of rows) inner.appendChild(r);
      const facts = [
        `${fmtN(Math.floor(spare / 2100))} more infantry division${Math.floor(spare / 2100) === 1 ? '' : 's'} could be armed from stock (${fmtN(spare)} rifles)`,
        spareTanks ? `${fmtN(Math.floor(spareTanks / cfg.tankCap))} armoured division${Math.floor(spareTanks / cfg.tankCap) === 1 ? '' : 's'} (${fmtN(spareTanks)} tanks in stock)` : 'no tanks in stock',
        this._milFuelOutlook(nation.id, t)
      ].filter(Boolean);
      inner.appendChild(el('div.mil-facts', facts.map(f => el('div', '· ' + f))));
    },
    // fuel burn from the conflict rows of the record: how long the stock lasts
    _milFuelOutlook(nid, t) {
      const rows = (S().militaryLog || []).filter(r => r.why !== 'turn' && r.n[nid]).slice(-6);
      if (rows.length < 2) return null;
      const a = rows[0], b = rows[rows.length - 1];
      const used = a.n[nid][4] - b.n[nid][4], mins = (b.at - a.at) / 60000;
      if (!(used > 0) || !(mins > 0)) return null;
      const left = (t.all('fuel')) / (used / mins);
      return `fuel burning at ${fmtN(used / mins)} bbl a minute — about ${left > 120 ? Math.round(left / 60) + ' h' : Math.round(left) + ' min'} of stock left`;
    },

    // the record over time + each live conflict's strength
    _milCharts(inner, nation) {
      const rows = (S().militaryLog || []).filter(r => r.n[nation.id]);
      const metric = KIND[W.milMetric] ? W.milMetric : 'smallarms';
      inner.appendChild(Views.secLabel('The record', el('span.mil-metrics', ['smallarms', 'tank', 'warship', 'aircraft', 'fuel', 'men'].map(k =>
        el('button.chip.chip-xs', { class: k === metric ? 'active' : '', onclick: () => { W.milMetric = k; App.renderView(); } }, KIND[k].short)))));
      if (rows.length < 2) {
        inner.appendChild(el('div.protest-note', 'The record starts with the next turn (and every half-minute of a running conflict).'));
        return;
      }
      const pts = rows.map(r => ({ x: r.why === 'turn' ? 'T' + r.turn : new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), y: r.n[nation.id][LOG_COL[metric]] }));
      inner.appendChild(el('div.mil-chart', Charts.chartLine(pts, { width: 640, height: 190, title: `${nation.abbrev || nation.name} — ${KIND[metric].label}`, color: 'var(--accent)', yMin: 0, yFormat: v => fmtCompact(v) + KIND[metric].unit })));
    },

    // one live conflict as this nation fights it
    _milConflict(inner, nation, doc, side) {
      const key = this.docKeyOf(doc);
      const ca = doc.cmdAccess || {};
      const commands = side === 'att' ? ca.att : ca.def;
      const leads = side === 'att' ? ca.attLead : ca.defAll;
      const view = (window.WarEngine && this.predictedDoc && this.predictedDoc(doc)) || doc;
      inner.appendChild(Views.secLabel((doc.kind === 'protest' ? '⚒ ' : '⚔ ') + doc.name + ' — in the field'));
      // strength over time (public)
      const ser = doc.series || [];
      if (ser.length >= 2) {
        const nm = [entName(this._milPrincipal(doc, 'att')), entName(doc.defenderId)];
        inner.appendChild(el('div.mil-chart', Charts.chartLine([
          { name: nm[0] + ' strength', color: '#9a3324', points: ser.map(p => ({ x: 't' + p[0], y: p[1] })) },
          { name: nm[1] + ' strength', color: '#2f4a6e', points: ser.map(p => ({ x: 't' + p[0], y: p[2] })) },
          { name: nm[0] + ' losses', color: '#d08a7c', points: ser.map(p => ({ x: 't' + p[0], y: p[3] })) },
          { name: nm[1] + ' losses', color: '#8fa3bf', points: ser.map(p => ({ x: 't' + p[0], y: p[4] })) }
        ], { width: 640, height: 200, title: 'Strength and losses', yMin: 0, yFormat: v => fmtCompact(v) })));
      }
      const units = (view.units || []).filter(u => live(u) && u.side === side && this.milNationOf(view, u) === nation.id)
        .sort((a, b) => (a.kind || '').localeCompare(b.kind || '') || b.strength - a.strength);
      for (const id of [...this._milSel]) if (!units.some(u => u.id === id)) this._milSel.delete(id);
      // the field orders this operator holds
      if (commands && units.length) inner.appendChild(this._milFieldBar(nation, doc, key, side, units, leads));
      if (!units.length) inner.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'No formations of yours in the field.'));
      else {
        const idx = this.milIndex();
        const issueOpts = (kind) => (S().items || []).filter(it => idx[it.id] === kind);
        inner.appendChild(el('div.mil-table-wrap', el('table.data.war-orbat.mil-units',
          el('thead', el('tr',
            commands ? el('th', el('input', { type: 'checkbox', title: 'Pick all', checked: units.every(u => this._milSel.has(u.id)) ? 'checked' : undefined,
              onchange: (e) => { for (const u of units) { if (e.target.checked) this._milSel.add(u.id); else this._milSel.delete(u.id); } App.renderView(); } })) : null,
            el('th', 'Formation'), el('th.num', doc.kind === 'protest' ? 'People' : 'Men'), el('th', 'Kit'), el('th.num', 'Armed'), el('th.num', 'Fuel'), el('th', 'Where'), el('th', 'State'), el('th', ''))),
          el('tbody', units.map(u => {
            const k = this.milKit(u);
            const kitCell = !k.kind ? '—' : commands
              ? el('select.mil-issue', { title: 'Issue a weapon model — drawn first on resupply', onchange: async (e) => {
                try { const r = await POST('/api/military/issue', { conflict: key, unitId: u.id, itemId: e.target.value || null }); toast(e.target.value ? `${u.name}: ${itemById(e.target.value).name} issued${r.swapped ? ` — ${fmtN(r.swapped)} older weapons handed in` : ''}.` : `${u.name}: standard issue.`); }
                catch (err) { toast(err.message, true); }
              } }, el('option', { value: '' }, u.issue ? 'Standard issue' : (k.top ? (itemById(k.top) || {}).name || 'Standard issue' : 'Standard issue')),
              issueOpts(k.kind).map(it => el('option', { value: it.id, selected: u.issue === it.id ? 'selected' : undefined }, it.name)))
              : (k.top ? (itemById(k.top) || {}).name : 'none');
            return el('tr', { class: side === 'att' ? 'war-orbat-att' : 'war-orbat-def' },
              commands ? el('td', el('input', { type: 'checkbox', checked: this._milSel.has(u.id) ? 'checked' : undefined,
                onchange: (e) => { if (e.target.checked) this._milSel.add(u.id); else this._milSel.delete(u.id); App.renderView(); } })) : null,
              el('td', u.name, u.raised ? el('span.mil-tag', 'raised') : null, u.garrison && !u.dest && u.kind !== 'police' ? el('span.mil-tag', 'post') : null),
              el('td.num', fmtN(u.strength)),
              el('td', kitCell),
              el('td.num', k.armed === null ? '—' : Math.round(k.armed * 100) + '%'),
              el('td.num', k.fuel === null ? '—' : Math.round(k.fuel * 100) + '%'),
              el('td', this.milNear(u.pos)),
              el('td', u.state + (u.supplied === false ? ' · cut off' : '')),
              el('td', el('button.ow-btn.ow-act', { title: 'Show on the map', onclick: () => this.openBattleMap(u.pos, key) }, '◎')));
          })))));
      }
      // a movement doesn't mobilise divisions; everyone else may raise
      if (leads && !(doc.kind === 'protest' && side === 'att')) inner.appendChild(this._milRaiseForm(nation, doc, key, side));
      if (doc.kind !== 'protest' && doc.air && this.airCounts) {
        const c = this.airCounts(doc, side);
        if (c.planes || c.lost) inner.appendChild(el('div.mil-facts', el('div', `· Air wing: ${c.planes} aircraft — ${c.aloft} aloft, ${c.ready} ready, ${c.rearm} rearming · ${c.lost} lost`,
          ' ', el('button.dash-btn.btn-xs', { onclick: () => this.openBattleMap(null, key) }, 'Air wing on the map →'))));
      }
    },
    // select → send to a city / hold / stand down
    _milFieldBar(nation, doc, key, side, units, leads) {
      const picked = units.filter(u => this._milSel.has(u.id));
      const held = (c) => { const cs = (doc.grid || {}).cell || 48; const cell = (doc.cells || {})[`${Math.floor(c.pos[0] / cs)},${Math.floor(c.pos[1] / cs)}`]; return !(cell && cell.o === (side === 'att' ? 'def' : 'att')); };
      const cities = (S().cities || []).filter(c => Array.isArray(c.pos));
      const pickCity = el('select.mil-city', { onchange: (e) => { this._milDest = e.target.value; } }, el('option', { value: '' }, 'Send to…'),
        cities.map(c => el('option', { value: c.id, selected: this._milDest === c.id ? 'selected' : undefined }, c.name + (held(c) ? '' : ' (enemy-held)'))));
      const order = async (orders, msg) => {
        try { await POST('/api/war/command', { side, conflict: key, orders }); toast(msg); }
        catch (e) { toast(e.message, true); }
      };
      return el('div.mil-fieldbar',
        el('span.mil-picked', picked.length ? `${picked.length} picked` : 'Pick formations below'),
        pickCity,
        el('button.solid-btn.btn-xs', { disabled: picked.length ? undefined : 'disabled', onclick: () => {
          const c = cities.find(x => x.id === pickCity.value);
          if (!c) return toast('Choose a city to send them to.', true);
          order(picked.map((u, i) => ({ unitId: u.id, dest: [c.pos[0] + Math.cos(i * 2.4) * 18 * Math.sqrt(i), c.pos[1] + Math.sin(i * 2.4) * 18 * Math.sqrt(i)] })), `${picked.length} formation${picked.length === 1 ? '' : 's'} marching on ${c.name}.`);
        } }, 'Send →'),
        el('button.dash-btn.btn-xs', { disabled: picked.length ? undefined : 'disabled', onclick: () => order(picked.map(u => ({ unitId: u.id, dest: u.pos.slice() })), 'Holding position.') }, '■ Hold'),
        leads ? el('button.dash-btn.btn-xs.danger-text', { disabled: picked.length ? undefined : 'disabled', onclick: () => confirmModal('STAND DOWN',
          `${picked.length} formation${picked.length === 1 ? '' : 's'} will leave the field and hand their weapons and fuel back to ${nation.name}'s stockpile. Formations under fire or at sea cannot disengage.`,
          async () => {
            const r = await POST('/api/military/standdown', { conflict: key, side, unitIds: picked.map(u => u.id) });
            picked.forEach(u => this._milSel.delete(u.id));
            toast(`${r.stoodDown} formation${r.stoodDown === 1 ? '' : 's'} stood down${r.busy ? ` · ${r.busy} engaged, still fighting` : ''}.`);
          }, 'Stand down') }, 'Stand down') : null);
    },
    _milRaiseForm(nation, doc, key, side) {
      const protest = doc.kind === 'protest';
      const kinds = protest ? [['police', 'Police detachment']] : [['infantry', 'Infantry division'], ['armored', 'Armoured division']];
      const t = this.milTotals(nation.id), cfg = this.milCfg();
      const d = this._milRaise || (this._milRaise = { kind: kinds[0][0], cityId: '', count: 1 });
      if (!kinds.some(k => k[0] === d.kind)) d.kind = kinds[0][0];
      const cost = () => d.kind === 'armored' ? `${cfg.tankCap} tanks each · ${fmtN(t.stock.tank + t.depots.tank)} in stock`
        : d.kind === 'infantry' ? `2,100 rifles each · ${fmtN(t.stock.smallarms + t.depots.smallarms)} in stock` : 'from the police reserve';
      const costEl = el('span.mil-cost', cost());
      const cities = side === 'def' ? (S().cities || []).filter(c => Array.isArray(c.pos)) : [];
      return el('div.mil-raise',
        el('span.mono-label', protest ? 'Raise police' : 'Mobilise'),
        el('select', { onchange: (e) => { d.kind = e.target.value; costEl.textContent = cost(); } }, kinds.map(([k, l]) => el('option', { value: k, selected: d.kind === k ? 'selected' : undefined }, l))),
        el('select', { onchange: (e) => { d.count = Number(e.target.value); } }, [1, 2, 3, 4].map(n => el('option', { value: n, selected: d.count === n ? 'selected' : undefined }, '× ' + n))),
        side === 'def' ? el('select', { onchange: (e) => { d.cityId = e.target.value; } }, el('option', { value: '' }, 'Muster at…'),
          cities.map(c => el('option', { value: c.id, selected: d.cityId === c.id ? 'selected' : undefined }, c.name))) : el('span.mil-cost', 'lands at the beachhead'),
        el('button.solid-btn.btn-xs', { onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true;
          try {
            const r = await POST('/api/military/raise', { conflict: key, side, kind: d.kind, cityId: d.cityId, count: d.count });
            toast(`${r.unitIds.length} formation${r.unitIds.length === 1 ? '' : 's'} raised and armed from stock.`);
          } catch (err) { toast(err.message, true); b.disabled = false; }
        } }, 'Raise'),
        costEl);
    },
    // the public picture for an operator with no arsenal on file
    _milPublicConflict(inner, doc) {
      inner.appendChild(Views.secLabel((doc.kind === 'protest' ? '⚒ ' : '⚔ ') + doc.name));
      const sides = ['att', 'def'].map(s => {
        const us = (doc.units || []).filter(u => live(u) && u.side === s);
        return [entName(this._milPrincipal(doc, s)), us.length, us.reduce((a, u) => a + u.strength, 0)];
      });
      inner.appendChild(Views.statStrip(sides.map(([n, c, m]) => [n, fmtCompact(m), `${c} formation${c === 1 ? '' : 's'}`])));
      const ser = doc.series || [];
      if (ser.length >= 2) inner.appendChild(el('div.mil-chart', Charts.chartLine([
        { name: sides[0][0], color: '#9a3324', points: ser.map(p => ({ x: 't' + p[0], y: p[1] })) },
        { name: sides[1][0], color: '#2f4a6e', points: ser.map(p => ({ x: 't' + p[0], y: p[2] })) }
      ], { width: 640, height: 180, title: 'Strength in the field', yMin: 0, yFormat: v => fmtCompact(v) })));
    },

    // every model, wherever it sits; the depots
    _milArsenal(inner, nation, t) {
      const ids = Object.keys(t.models);
      inner.appendChild(Views.ledgerFold('milArsenal', `Arsenal — ${ids.length} model${ids.length === 1 ? '' : 's'}`, () => {
        const idx = this.milIndex();
        const stat = (w) => ['dmg', 'hp', 'armor', 'morale', 'range', 'speed'].filter(k => w[k] !== undefined).map(k => `${k} ${w[k]}`).join(' · ');
        ids.sort((a, b) => KINDS.indexOf(idx[a]) - KINDS.indexOf(idx[b]));
        return el('table.data.mil-arsenal',
          el('thead', el('tr', el('th', 'Model'), el('th', 'Kind'), el('th.num', 'In stock'), el('th.num', 'Depots'), el('th.num', 'In the field'), el('th', 'Quality'))),
          el('tbody', ids.map(id => { const it = itemById(id) || { name: id, meta: {} }; const m = t.models[id]; return el('tr',
            el('td', it.name), el('td', KIND[idx[id]].label), el('td.num', fmtN(m.stock)), el('td.num', fmtN(m.depots)), el('td.num', fmtN(m.field)),
            el('td.mil-q', stat((it.meta || {}).weapon || {}))); })));
      }));
      const depots = this.milDepots(nation.id);
      if (!depots.length) return;
      const canMove = isGM() || (typeof ownershipSetClient === 'function' && ownershipSetClient().has(nation.id));
      inner.appendChild(Views.ledgerFold('milDepots', `Depots — ${depots.length} military site${depots.length === 1 ? '' : 's'}`, () => {
        const idx = this.milIndex();
        const box = el('div');
        box.appendChild(el('div.protest-note', 'Units inside their supply lines also draw on these depots. A depot overrun by the enemy is lost with everything in it.'));
        box.appendChild(el('table.data', el('tbody', depots.map(p => el('tr',
          el('td', p.name), el('td', (p.inventory || []).filter(r => idx[r.itemId] && r.qty > 0).map(r => `${fmtN(r.qty)} × ${(itemById(r.itemId) || {}).name || r.itemId}`).join(' · ') || 'empty'))))));
        if (canMove) {
          const f = this._milMove && depots.some(p => p.id === this._milMove.depot) ? this._milMove : (this._milMove = { depot: depots[0].id, item: '', qty: '', dir: 'deposit' });
          const items = (S().items || []).filter(it => idx[it.id] && (t.models[it.id] || {}).stock + (t.models[it.id] || {}).depots > 0);
          box.appendChild(el('div.mil-raise',
            el('select', { onchange: (e) => { f.dir = e.target.value; } }, el('option', { value: 'deposit' }, 'Send to'), el('option', { value: 'withdraw', selected: f.dir === 'withdraw' ? 'selected' : undefined }, 'Bring back from')),
            el('select', { onchange: (e) => { f.depot = e.target.value; } }, depots.map(p => el('option', { value: p.id, selected: f.depot === p.id ? 'selected' : undefined }, p.name))),
            el('select', { onchange: (e) => { f.item = e.target.value; } }, el('option', { value: '' }, 'What…'), items.map(it => el('option', { value: it.id, selected: f.item === it.id ? 'selected' : undefined }, it.name))),
            el('input.text-input', { type: 'number', min: 1, placeholder: 'How many', value: f.qty, style: 'width:110px;', oninput: (e) => { f.qty = e.target.value; } }),
            el('button.solid-btn.btn-xs', { onclick: async () => {
              if (!f.item || !(Number(f.qty) > 0)) return toast('Pick what to move and how many.', true);
              try { await POST('/api/property/items', { propertyId: f.depot, itemId: f.item, qty: Number(f.qty), direction: f.dir }); toast('Stock moved.'); }
              catch (e) { toast(e.message, true); }
            } }, 'Move')));
        }
        return box;
      }));
    },

    /* ---------- standing orders ---------- */
    _milPlanOf(nation) {
      const p = nation.militaryPlan || {};
      return {
        posts: Object.assign({}, p.posts || {}), armourAt: p.armourAt || '', fleetAt: p.fleetAt || '',
        police: { cities: ((p.police || {}).cities || []).slice(), per: (p.police || {}).per || 2 },
        doctrine: Object.assign({ issue: 'best', arms: 1, fuel: 1 }, p.doctrine || {})
      };
    },
    _milOrders(inner, nation, acc) {
      const all = acc === 'all', police = all || (Array.isArray(acc) && acc.includes('police'));
      // an untouched draft follows the server (another commander may have
      // changed the orders); an edited one is kept until issued or discarded
      if (!this._milDraft || this._milDraft.nid !== nation.id || !this._milDraft.dirty) this._milDraft = { nid: nation.id, plan: this._milPlanOf(nation), dirty: false };
      const D = this._milDraft, P = D.plan;
      const touch = () => { D.dirty = true; App.renderView(); };
      const chips = (opts, cur, set, on) => el('span.chip-row.mil-chips', opts.map(([v, l]) => el('button.chip.chip-xs', {
        class: cur === v ? 'active' : '', disabled: on ? undefined : 'disabled', onclick: () => { set(v); touch(); } }, l)));
      const box = el('div.mil-orders');
      inner.appendChild(Views.secLabel('Standing orders', D.dirty ? el('span.mil-dirty', 'unsaved') : null));
      // supply doctrine — every nation
      box.appendChild(el('div.mil-order',
        el('div.mil-order-k', 'Weapons are drawn'),
        chips([['best', 'Best first'], ['conserve', 'Spare the best']], P.doctrine.issue, (v) => { P.doctrine.issue = v; }, all),
        el('div.mil-order-d', P.doctrine.issue === 'conserve' ? 'Units take the oldest models first — the finest stay in reserve.' : 'Units always carry the finest weapons left in stock.')));
      box.appendChild(el('div.mil-order', el('div.mil-order-k', 'Arms ration'), chips(RATIONS, P.doctrine.arms, (v) => { P.doctrine.arms = v; }, all),
        el('div.mil-order-d', P.doctrine.arms < 1 ? `Units are topped up to ${Math.round(P.doctrine.arms * 100)}% of a full complement — the unarmed fight far worse.` : 'Every soldier gets a weapon while stock lasts.')));
      box.appendChild(el('div.mil-order', el('div.mil-order-k', 'Fuel ration'), chips(RATIONS, P.doctrine.fuel, (v) => { P.doctrine.fuel = v; }, all),
        el('div.mil-order-d', P.doctrine.fuel < 1 ? `Tanks filled to ${Math.round(P.doctrine.fuel * 100)}% — slower columns, longer-lasting stock.` : 'Full tanks — full speed.')));
      // deployment plan — a government's, used when a war or protest starts
      if (nation.type === 'government') {
        const cities = (S().cities || []).filter(c => Array.isArray(c.pos));
        const sites = cities.map(c => ['city:' + c.id, c.name + (c.isCapital ? ' ★' : '')])
          // the military sites a war garrisons: on our own soil, not a foreign power's (server: buildGarrisonUnits)
          .concat((S().properties || []).filter(p => p.type === 'military' && p.provinceId && provById(p.provinceId) && (entById(p.ownerId) || {}).type !== 'foreign').map(p => ['prop:' + p.id, p.name]));
        box.appendChild(el('div.mil-order', el('div.mil-order-k', 'Garrisons when war comes'),
          el('div.mil-order-d', 'How each post is held at the outbreak of war. The number of garrisons follows the population; this decides where they stand.')));
        box.appendChild(el('div.mil-posts', sites.map(([k, label]) => {
          const v = Object.prototype.hasOwnProperty.call(P.posts, k) ? P.posts[k] : 1;
          return el('div.mil-post', el('span.mil-post-name', label),
            chips(POST_LABEL.map((l, i) => [i, l]), v, (nv) => { if (nv === 1) delete P.posts[k]; else P.posts[k] = nv; }, all));
        })));
        const citySel = (cur, set, on, none) => el('select', { disabled: on ? undefined : 'disabled', onchange: (e) => { set(e.target.value); touch(); } },
          el('option', { value: '' }, none), cities.map(c => el('option', { value: c.id, selected: cur === c.id ? 'selected' : undefined }, c.name)));
        box.appendChild(el('div.mil-order', el('div.mil-order-k', 'Armour musters at'), citySel(P.armourAt, (v) => { P.armourAt = v; }, all, 'the capital')));
        box.appendChild(el('div.mil-order', el('div.mil-order-k', 'The fleet sails from'), citySel(P.fleetAt, (v) => { P.fleetAt = v; }, all, 'the principal port')));
        box.appendChild(el('div.mil-order', el('div.mil-order-k', 'Police posts in a protest'),
          el('span.chip-row.mil-chips', cities.map(c => el('button.chip.chip-xs', {
            class: P.police.cities.includes(c.id) ? 'active' : '', disabled: police ? undefined : 'disabled',
            onclick: () => { const i = P.police.cities.indexOf(c.id); if (i >= 0) P.police.cities.splice(i, 1); else P.police.cities.push(c.id); touch(); } }, c.name))),
          el('div.mil-order-d', 'Used when a protest starts without the GM naming police cities. Detachments per post: ',
            chips([[1, '1'], [2, '2'], [3, '3'], [4, '4']], P.police.per, (v) => { P.police.per = v; }, police))));
      }
      if (all || police) {
        box.appendChild(el('div.btn-row',
          el('button.solid-btn.btn-xs', { disabled: D.dirty ? undefined : 'disabled', onclick: async (e) => {
            const b = e.currentTarget; b.disabled = true;
            const plan = all ? { posts: P.posts, armourAt: P.armourAt || null, fleetAt: P.fleetAt || null, police: P.police, doctrine: P.doctrine } : { police: P.police };
            if (nation.type !== 'government') { delete plan.posts; delete plan.armourAt; delete plan.fleetAt; delete plan.police; }
            try { await POST('/api/military/plan', { entityId: nation.id, plan }); this._milDraft = null; toast('Standing orders issued.'); }
            catch (err) { toast(err.message, true); b.disabled = false; }
          } }, 'Issue standing orders'),
          D.dirty ? el('button.dash-btn.btn-xs', { onclick: () => { this._milDraft = null; App.renderView(); } }, 'Discard') : null));
      }
      inner.appendChild(box);
    }
  });
})();
