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

  /* ═══════════ INSPECTOR — edit mode (Phase 2) ═══════════
     GM can inline-edit any inspected record via the generic
     /api/gm/coll/<collection> PATCH endpoint. Non-GM entity owners get a
     reduced field set on entities they control, saved via /api/entity/:id.
     The collection name for each inspector "kind" (note: plural, matching
     the server's COLLS map in api.js). */
  EDIT_COLL: { province: 'provinces', city: 'cities', property: 'properties', entity: 'entities', item: 'items' },

  // Approximate client-side "do I control this entity" check. The server is
  // the real authority (ownership.controls) — this only decides whether to
  // show the pencil / reduced-field form.
  canEditEntity(id) {
    if (isGM()) return true;
    const mine = myEntity();
    if (!mine) return false;
    if (mine.id === id) return true;
    const e = entById(id);
    if (!e) return false;
    if (e.ownerId === mine.id || e.ceoId === mine.id) return true;
    if (e.type === 'party' && e.leaderId === mine.id) return true;
    // one level of indirection: anything my controlled companies own/run
    return S().entities.some(c => (c.ownerId === mine.id || c.ceoId === mine.id) && (e.ownerId === c.id || e.ceoId === c.id));
  },
  canEdit(kind, id) {
    if (isGM()) return true;
    if (kind === 'entity') return this.canEditEntity(id);
    return false;
  },

  editBar(onSave, onCancel) {
    return el('div.btn-row.insp-edit-bar',
      el('button.solid-btn', {
        onclick: async (e) => {
          const btn = e.currentTarget; btn.disabled = true;
          try { await onSave(); W.inspEdit = false; W.inspDraft = null; toast('Saved.'); }
          catch (err) { toast(err.message, true); btn.disabled = false; }
        }
      }, 'Save'),
      el('button.dash-btn', {
        onclick: () => { W.inspEdit = false; W.inspDraft = null; if (onCancel) onCancel(); this.inspect(W.selection.kind, W.selection.id); }
      }, 'Cancel'));
  },

  // small editable grid of a vars-like object {key: number}
  editVarsGrid(draft, key, scope) {
    draft[key] = draft[key] || {};
    const defs = (S().variables || []).filter(v => v.scope === scope);
    const box = el('div');
    box.appendChild(this.secLabel(key === 'demographics' ? 'Demographics' : 'Variables'));
    const table = el('div.form-grid');
    const keys = new Set([...defs.map(d => d.key), ...Object.keys(draft[key])]);
    for (const k of keys) {
      const def = defs.find(d => d.key === k);
      table.appendChild(Forms.field(def ? def.label : k, Forms.num(draft[key], k)));
    }
    box.appendChild(table);
    return box;
  },

  /* ---- per-kind edit-mode renderers ---- */
  editProvince(id) {
    const p = provById(id);
    const d = W.inspDraft || (W.inspDraft = JSON.parse(JSON.stringify(p)));
    const wrap = el('div');
    wrap.appendChild(this.secLabel('Editing — ' + p.name));
    wrap.appendChild(el('div.form-grid',
      Forms.field('Name', Forms.text(d, 'name')),
      Forms.field('Map colour', Forms.color(d, 'color')),
      Forms.field('Label position "x,y"', el('input.text-input', { value: (d.labelPos || []).join(','), oninput: (e) => d.labelPos = e.target.value.split(',').map(Number) })),
      Forms.field('Label rotation (°)', Forms.num(d, 'labelRot')),
      Forms.field('Label size', Forms.num(d, 'labelSize'))));
    wrap.appendChild(Forms.field('Description', Forms.area(d, 'description')));
    wrap.appendChild(this.editVarsGrid(d, 'vars', 'province'));

    d.demographics = d.demographics || {};
    const groups = Object.keys(d.demographics);
    if (groups.length) {
      const metrics = S().settings.demographics.metrics || [];
      wrap.appendChild(this.secLabel('Demographics'));
      const head = el('tr', el('th', 'Group'));
      metrics.forEach(mDef => head.appendChild(el('th.num', mDef.label)));
      const tbody = el('tbody');
      for (const gname of groups) {
        const grp = d.demographics[gname];
        const row = el('tr', el('td', gname));
        for (const mDef of metrics) {
          row.appendChild(el('td.num', el('input', { value: grp[mDef.key] ?? 0, oninput: (e) => grp[mDef.key] = Number(e.target.value) || 0 })));
        }
        tbody.appendChild(row);
      }
      wrap.appendChild(el('div', { style: 'overflow-x:auto;' }, el('table.data.demo-table', el('thead', head), tbody)));
    }

    wrap.appendChild(this.editBar(async () => {
      await PATCH(`/api/gm/coll/provinces/${id}`, {
        name: d.name, color: d.color, description: d.description, labelPos: d.labelPos, labelRot: Number(d.labelRot) || 0,
        labelSize: Number(d.labelSize) || 0, vars: d.vars, demographics: d.demographics
      });
    }));
    return wrap;
  },

  editCity(id) {
    const c = cityById(id);
    const d = W.inspDraft || (W.inspDraft = JSON.parse(JSON.stringify(c)));
    const wrap = el('div');
    wrap.appendChild(this.secLabel('Editing — ' + c.name));
    wrap.appendChild(el('div.form-grid',
      Forms.field('Name', Forms.text(d, 'name')),
      Forms.field('Province', Forms.sel(d, 'provinceId', Forms.provOptions())),
      Forms.field('Size (1–3)', Forms.num(d, 'size')),
      Forms.field('Position "x,y"', el('input.text-input', { value: (d.pos || []).join(','), oninput: (e) => d.pos = e.target.value.split(',').map(Number) }))));
    wrap.appendChild(Forms.check(d, 'isCapital', 'National capital'));
    wrap.appendChild(Forms.field('Description', Forms.area(d, 'description')));
    wrap.appendChild(this.editBar(async () => {
      await PATCH(`/api/gm/coll/cities/${id}`, { name: d.name, provinceId: d.provinceId, size: Number(d.size) || 1, isCapital: !!d.isCapital, description: d.description, pos: d.pos });
    }));
    return wrap;
  },

  editProperty(id) {
    const pr = propById(id);
    const d = W.inspDraft || (W.inspDraft = JSON.parse(JSON.stringify(pr)));
    const wrap = el('div');
    wrap.appendChild(this.secLabel('Editing — ' + pr.name));
    wrap.appendChild(el('div.form-grid',
      Forms.field('Name', Forms.text(d, 'name')),
      Forms.field('Owner', Forms.sel(d, 'ownerId', Forms.entOptions(null, true))),
      Forms.field('Category', Forms.sel(d, 'type', [['residential', 'Residential'], ['commercial', 'Commercial'], ['industrial', 'Industrial'], ['agricultural', 'Agricultural'], ['government', 'Government'], ['military', 'Military'], ['infrastructure', 'Infrastructure']])),
      Forms.field('Kind (marker glyph)', Forms.sel(d, 'kind', Object.keys(KIND_GLYPH).map(k => [k, k.replace('_', ' ') + ' [' + KIND_GLYPH[k] + ']']))),
      Forms.field('Icon', Forms.sel(d, 'icon', [['', '— none (letter glyph) —'], ...ICON_MANIFEST.map(i => [i, i])])),
      Forms.field('Position "x,y"', el('input.text-input', { value: (d.pos || []).join(','), oninput: (e) => d.pos = e.target.value.split(',').map(Number) })),
      Forms.field('Assessed value', Forms.num(d, 'value')),
      Forms.field('Employees', Forms.num(d, 'employees')),
      Forms.field('Monthly income', Forms.num(d, 'income')),
      Forms.field('Monthly expenses', Forms.num(d, 'expenses'))));
    wrap.appendChild(Forms.field('Description', Forms.area(d, 'description')));
    wrap.appendChild(this.editBar(async () => {
      await PATCH(`/api/gm/coll/properties/${id}`, {
        name: d.name, ownerId: d.ownerId, type: d.type, kind: d.kind, icon: d.icon, pos: d.pos,
        value: Number(d.value) || 0, employees: Number(d.employees) || 0, income: Number(d.income) || 0, expenses: Number(d.expenses) || 0,
        description: d.description
      });
    }));
    return wrap;
  },

  editEntity(id) {
    const e = entById(id);
    const gm = isGM();
    const d = W.inspDraft || (W.inspDraft = JSON.parse(JSON.stringify(e)));
    const wrap = el('div');
    wrap.appendChild(this.secLabel('Editing — ' + e.name));

    if (!gm) {
      // reduced field set for non-GM owners
      wrap.appendChild(el('div.form-grid',
        Forms.field('Name', el('input.text-input', { value: e.name, disabled: true })),
        Forms.field('Marker colour', Forms.color(d, 'color')),
        Forms.field('Logo / image path', Forms.text(d, 'logo', '/assets/…'))));
      wrap.appendChild(Forms.field('Description', Forms.area(d, 'description')));
      wrap.appendChild(this.editBar(async () => {
        await PATCH(`/api/entity/${id}`, { description: d.description, color: d.color, logo: d.logo });
      }));
      return wrap;
    }

    wrap.appendChild(el('div.form-grid',
      Forms.field('Name', Forms.text(d, 'name')),
      Forms.field('Marker colour', Forms.color(d, 'color')),
      Forms.field('Logo / image path', Forms.text(d, 'logo', '/assets/…')),
      e.type === 'company' ? Forms.field('Industry', Forms.text(d, 'industry')) : null,
      e.type === 'company' ? Forms.field('Controlled by', Forms.sel(d, 'ownerId', Forms.entOptions(null, true))) : null,
      e.type === 'company' ? Forms.field('Chief Executive', Forms.sel(d, 'ceoId', Forms.entOptions(['person'], true))) : null,
      e.type === 'company' ? Forms.field('Shares outstanding', Forms.num(d, 'sharesOutstanding')) : null,
      e.type === 'party' ? Forms.field('Leader', Forms.sel(d, 'leaderId', Forms.entOptions(['person'], true))) : null,
      e.type === 'person' ? Forms.field('Title', Forms.text(d, 'title')) : null,
      (e.type === 'foreign' || e.type === 'org') ? Forms.field('Stance / relations', Forms.text(d, 'stance')) : null
    ));
    if (e.type === 'party') {
      d.ideology = d.ideology || { econ: 0, soc: 0 };
      wrap.appendChild(el('div.form-grid',
        Forms.field('Ideology — economic (−100…+100)', Forms.num(d.ideology, 'econ')),
        Forms.field('Ideology — social (−100…+100)', Forms.num(d.ideology, 'soc'))));
      wrap.appendChild(Forms.check(d, 'inGovernment', 'Currently in government'));
    }

    /* Phase 4.4 — GM-only market levers: sharePrice/trust/publicFloat aren't
       set by any other editor, so the GM needs a direct hand on them (events
       and the market-maker endpoints adjust them at runtime otherwise). */
    if (e.type === 'company') {
      wrap.appendChild(this.secLabel('Market (GM)'));
      wrap.appendChild(el('div.form-grid',
        Forms.field('Share price (' + CUR() + ')', Forms.num(d, 'sharePrice')),
        Forms.field('Trust (0–100)', Forms.num(d, 'trust')),
        Forms.field('Public float (0–100 %)', Forms.num(d, 'publicFloat'))));
    }

    wrap.appendChild(Forms.field('Description', Forms.area(d, 'description')));

    wrap.appendChild(this.editBar(async () => {
      const body = { name: d.name, color: d.color, logo: d.logo, description: d.description };
      if (e.type === 'company') Object.assign(body, {
        industry: d.industry, ownerId: d.ownerId, ceoId: d.ceoId, sharesOutstanding: Number(d.sharesOutstanding) || 0,
        sharePrice: Number(d.sharePrice) || 0, trust: Number(d.trust) || 0, publicFloat: Number(d.publicFloat) || 0
      });
      if (e.type === 'party') Object.assign(body, { leaderId: d.leaderId, ideology: d.ideology, inGovernment: !!d.inGovernment });
      if (e.type === 'person') body.title = d.title;
      if (e.type === 'foreign' || e.type === 'org') body.stance = d.stance;
      await PATCH(`/api/gm/coll/entities/${id}`, body);
    }));
    return wrap;
  },

  editItem(id) {
    const it = itemById(id);
    const d = W.inspDraft || (W.inspDraft = JSON.parse(JSON.stringify(it)));
    const wrap = el('div');
    wrap.appendChild(this.secLabel('Editing — ' + it.name));
    wrap.appendChild(el('div.form-grid',
      Forms.field('Name', Forms.text(d, 'name')),
      Forms.field('Category', Forms.text(d, 'category')),
      Forms.field('Market value (' + CUR() + ')', Forms.num(d, 'marketValue'))));
    wrap.appendChild(Forms.check(d, 'tradable', 'Tradable between entities'));
    wrap.appendChild(Forms.field('Description', Forms.area(d, 'description')));
    wrap.appendChild(this.editBar(async () => {
      await PATCH(`/api/gm/coll/items/${id}`, { name: d.name, category: d.category, marketValue: Number(d.marketValue) || 0, tradable: !!d.tradable, description: d.description });
    }));
    return wrap;
  },

  /* ═══════════ INSPECTOR ═══════════ */
  inspect(kind, id) {
    const panel = document.getElementById('inspector');
    const body = document.getElementById('insp-body');
    const kicker = document.getElementById('insp-kicker');
    panel.classList.remove('hidden');
    clear(body);
    let node = null, kick = 'DOSSIER';
    const editing = W.inspEdit && this.canEdit(kind, id) && this.EDIT_COLL[kind];
    if (editing) {
      if (kind === 'province') { node = this.editProvince(id); kick = 'EDITING — PROVINCE'; }
      else if (kind === 'city') { node = this.editCity(id); kick = 'EDITING — CITY'; }
      else if (kind === 'property') { node = this.editProperty(id); kick = 'EDITING — PROPERTY'; }
      else if (kind === 'entity') { node = this.editEntity(id); kick = 'EDITING — ENTITY'; }
      else if (kind === 'item') { node = this.editItem(id); kick = 'EDITING — ITEM'; }
      if (!node) { W.inspEdit = false; } // record vanished mid-edit — fall through
    }
    if (!node) {
      if (kind === 'province') { node = this.inspProvince(id); kick = 'PROVINCE FILE'; }
      else if (kind === 'city') { node = this.inspCity(id); kick = 'CITY FILE'; }
      else if (kind === 'property') { node = this.inspProperty(id); kick = 'PROPERTY FILE'; }
      else if (kind === 'entity') { const e = entById(id); node = this.inspEntity(id); kick = (TYPE_LABEL[e && e.type] || 'ENTITY').toUpperCase() + ' FILE'; }
      else if (kind === 'item') { node = this.inspItem(id); kick = 'MARKET FILE'; }
      else if (kind === 'marker') { node = this.inspMarker(id); kick = 'MAP MARKER'; }
    }
    kicker.textContent = kick;
    const editBtn = document.getElementById('insp-edit');
    if (editBtn) {
      const showPencil = !editing && this.EDIT_COLL[kind] && this.canEdit(kind, id);
      editBtn.classList.toggle('hidden', !showPencil);
      editBtn.onclick = () => { W.inspEdit = true; W.inspDraft = null; this.inspect(kind, id); };
    }
    if (node) body.appendChild(node);
  },
  closeInspector() {
    document.getElementById('inspector').classList.add('hidden');
    W.selection = null;
    W.inspEdit = false; W.inspDraft = null;
    if (GameMap.ready) GameMap.highlight();
    renderExplorer();
  },

  // province.voterBase ({ partyId: pct }) as pie rows, or null when unset
  voterBaseRows(p) {
    const vb = (p && p.voterBase) || {};
    const rows = S().entities.filter(e => e.type === 'party')
      .map(pt => ({ label: pt.abbrev || pt.name, value: Math.max(0, Number(vb[pt.id]) || 0), color: pt.color }))
      .filter(r => r.value > 0);
    return rows.length ? rows : null;
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

    // voter base — public political knowledge, set by the GM per province
    const vbRows = this.voterBaseRows(p);
    if (vbRows) {
      wrap.appendChild(this.secLabel('Voter Base'));
      wrap.appendChild(Charts.chartPie(vbRows, { width: 300, height: 160, title: 'Party Support' }));
    }

    if (p.demographics && perms().statistics) {
      wrap.appendChild(this.secLabel('Population Groups'));
      wrap.appendChild(Charts.chartPie(Object.keys(p.demographics).map(gname => ({
        label: gname, value: (p.demographics[gname] || {}).population || 0
      })), { width: 300, height: 160, title: 'Population Mix', valueFormat: undefined }));
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
      const vbRows = this.voterBaseRows(p);
      if (vbRows) wrap.appendChild(Charts.chartPie(vbRows, { width: 300, height: 150, title: p.name + ' — Party Support' }));
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
    if ((pr.income || 0) > 0 || (pr.expenses || 0) > 0) {
      wrap.appendChild(Charts.chartBars([
        { label: 'Income', value: pr.income || 0, color: '#4a6a48' },
        { label: 'Expenses', value: pr.expenses || 0, color: '#8a3c34' },
        { label: 'Net', value: Math.max(0, (pr.income || 0) - (pr.expenses || 0)), color: 'var(--ink-soft)' }
      ], { width: 300, height: 140, title: 'Monthly P&L', valueFormat: (v) => CUR() + fmtCompact(v) }));
    }
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
      /* Phase 7.3 — small share-price sparkline, drawn from S().history's
         per-turn shares[companyId] snapshots (only present when statistics
         perms sent history, and only once the company is actually listed). */
      if (e.sharePrice !== undefined) {
        const hist = S().history || [];
        const priceHist = hist.filter(h => h.shares && h.shares[e.id] !== undefined).map(h => ({ x: h.turn, y: h.shares[e.id] }));
        if (priceHist.length) {
          wrap.appendChild(this.secLabel('Share Price'));
          wrap.appendChild(Charts.chartLine(priceHist, { width: 260, height: 70, title: 'SHARE PRICE', yFormat: v => CUR() + v }));
        }
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
      actions.appendChild(el('button.outline-btn', { onclick: () => this.transferModal(accts[0].id) }, CUR() + ' Transfer Funds'));
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

  inspMarker(id) {
    const m = markerById(id);
    if (!m) return el('div', 'Not on file.');
    const wrap = el('div');
    wrap.appendChild(el('div.insp-title', (m.icon && m.icon.length <= 3 ? m.icon + ' ' : '') + (m.title || 'Marker')));
    wrap.appendChild(el('div.insp-sub', 'Event marker' + (m.createdTurn !== undefined ? ' · placed turn ' + m.createdTurn : '')));
    if (m.description) wrap.appendChild(el('div.insp-desc', m.description));
    if (isGM()) {
      wrap.appendChild(el('div.insp-actions',
        el('button.outline-btn', { onclick: () => this.markerEditor(m) }, '✎ Edit Marker'),
        el('button.dash-btn', {
          onclick: () => confirmModal('REMOVE MARKER', 'Delete this marker from the map?', async () => {
            await DEL('/api/gm/coll/markers/' + m.id); toast('Marker removed.'); Views.closeInspector();
          })
        }, 'Delete')));
    }
    return wrap;
  },

  markerEditor(m) {
    const title = el('input.text-input', { value: m.title || '' });
    const icon = el('input.text-input', { value: m.icon || '◈', placeholder: 'emoji or symbol' });
    const desc = el('textarea.text-input', { style: 'min-height:120px;' }, m.description || '');
    openModal('MAP MARKER', el('div',
      el('label.field-label', 'Title'), title,
      el('label.field-label', 'Icon (emoji or symbol)'), icon,
      el('label.field-label', 'Description'), desc
    ), [
      { label: 'Save', onClick: async () => { await PATCH('/api/gm/coll/markers/' + m.id, { title: title.value, icon: icon.value, description: desc.value }); toast('Saved.'); } },
      { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }
    ]);
  },

  /* ═══════════ money & items modals ═══════════ */
  /* Phase 4.2 — searchable From (controlled accounts) / To (entities + accounts,
     one search box) with recent-recipient chips derived from the last ~20
     visible transactions. Posts to the unchanged /api/transfer endpoint. */
  recentRecipients() {
    const myAccts = new Set(this.accountsOf(W.me.entityId).map(a => a.id));
    const seen = new Set(), out = [];
    const txns = [...(S().transactions || [])].reverse().slice(0, 20);
    for (const t of txns) {
      // "recipient" = the other side of a transaction I sent from one of my accounts
      let otherAcctId = null;
      if (t.from && myAccts.has(t.from) && t.to) otherAcctId = t.to;
      if (!otherAcctId) continue;
      const acct = acctById(otherAcctId);
      if (!acct || acct.ownerId === W.me.entityId || seen.has(acct.ownerId)) continue;
      seen.add(acct.ownerId);
      out.push({ entityId: acct.ownerId, acctId: acct.id, name: entName(acct.ownerId) });
      if (out.length >= 6) break;
    }
    return out;
  },
  transferModal(prefToAcct) {
    // "my" accounts = the whole ownership chain (own entity + controlled
    // companies + their subsidiaries), matching what the server lets us move
    const mine = ownershipSetClient();
    const my = isGM() ? S().accounts : (S().accounts || []).filter(a => mine.has(a.ownerId));
    if (!my.length) return toast('You control no accounts.', true);

    let fromId = my[0].id;
    let to = null; // { kind:'account'|'entity', id, label }
    if (prefToAcct) {
      const a = acctById(prefToAcct);
      if (a) to = { kind: 'account', id: a.id, label: `${entName(a.ownerId)} — ${a.name}` };
    }

    const acctLabel = (a) => `${entName(a.ownerId)} — ${a.name} (${fmtMoney(a.balance)})`;

    // ---- From: searchable pick-list of controlled accounts ----
    const fromList = el('div.pick-list');
    const fromSearch = el('input.text-input', { placeholder: 'Search your accounts…' });
    const renderFromList = () => {
      const q = fromSearch.value.trim().toLowerCase();
      clear(fromList);
      my.filter(a => !q || acctLabel(a).toLowerCase().includes(q)).forEach(a => {
        fromList.appendChild(el('div.pick-item', { class: a.id === fromId ? 'selected' : '', onclick: () => { fromId = a.id; renderFromList(); } },
          el('span', entName(a.ownerId) + ' — ' + a.name), el('span.pi-sub', fmtMoney(a.balance))));
      });
      if (!fromList.children.length) fromList.appendChild(el('div', { style: 'padding:10px; color:var(--ink-faint); font-size:12px;' }, 'No match.'));
    };
    fromSearch.addEventListener('input', renderFromList);

    // ---- To: one search box over entities AND accounts ----
    const toList = el('div.pick-list');
    const toSearch = el('input.text-input', { placeholder: 'Search recipients (people, companies, accounts)…', value: to ? to.label : '' });
    const canSeeAccounts = isGM() || perms().accounts === 'all';
    const renderToList = () => {
      const q = toSearch.value.trim().toLowerCase();
      clear(toList);
      const rows = [];
      if (canSeeAccounts) {
        for (const a of S().accounts) {
          if (a.ownerId === W.me.entityId) continue;
          const label = acctLabel(a);
          if (q && !label.toLowerCase().includes(q)) continue;
          rows.push({ kind: 'account', id: a.id, label: `${entName(a.ownerId)} — ${a.name}`, sub: fmtMoney(a.balance) });
        }
      } else {
        for (const e of S().entities) {
          if (e.id === W.me.entityId) continue;
          if (q && !e.name.toLowerCase().includes(q)) continue;
          rows.push({ kind: 'entity', id: e.id, label: e.name, sub: TYPE_LABEL[e.type] || e.type });
        }
      }
      rows.slice(0, 40).forEach(r => {
        toList.appendChild(el('div.pick-item', { class: (to && to.kind === r.kind && to.id === r.id) ? 'selected' : '', onclick: () => { to = r; toSearch.value = r.label; renderToList(); } },
          el('span', r.label), el('span.pi-sub', r.sub)));
      });
      if (!rows.length) toList.appendChild(el('div', { style: 'padding:10px; color:var(--ink-faint); font-size:12px;' }, 'No match.'));
    };
    toSearch.addEventListener('input', () => { to = null; renderToList(); });

    // ---- recent recipients as one-click chips ----
    const recents = this.recentRecipients();
    const chipRow = recents.length ? el('div.chip-row', recents.map(r =>
      el('span.recip-chip', { onclick: () => { to = { kind: 'entity', id: r.entityId, label: r.name }; toSearch.value = r.name; renderToList(); } }, '↺ ' + r.name)
    )) : null;

    const amount = el('input.text-input', { type: 'number', min: '0.01', step: '0.01', placeholder: '0.00' });
    const memo = el('input.text-input', { placeholder: 'Purpose of transfer' });

    renderFromList(); renderToList();

    openModal('WIRE TRANSFER', el('div',
      el('label.field-label', 'From account'), fromSearch, fromList,
      el('label.field-label', 'To'), toSearch, toList,
      chipRow ? el('div', el('label.field-label', 'Recent recipients'), chipRow) : null,
      el('label.field-label', 'Amount (' + CUR() + ')'), amount,
      el('label.field-label', 'Memo'), memo
    ), [{
      label: 'Send Wire', onClick: async () => {
        if (!to) throw new Error('Choose a recipient.');
        const body = { fromAccountId: fromId, amount: Number(amount.value), memo: memo.value };
        if (to.kind === 'account') body.toAccountId = to.id; else body.toEntityId = to.id;
        await POST('/api/transfer', body);
        toast('Wire sent.');
      }
    }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }], true);
  },

  tradeModal(prefItem, prefTo) {
    // sender can be any entity in the controlled chain that holds something
    const mine = ownershipSetClient();
    const sources = S().entities.filter(e => (isGM() || mine.has(e.id)) && (e.inventory || []).length);
    if (!sources.length) return toast('No inventory to send — you and your companies hold nothing.', true);
    let fromId = sources.some(s => s.id === W.me.entityId) ? W.me.entityId : sources[0].id;

    const fromSel = el('select.text-input', sources.map(e =>
      el('option', { value: e.id, selected: e.id === fromId ? 'selected' : undefined }, e.name)));
    const itemSel = el('select.text-input');
    const renderItems = () => {
      const src = entById(fromSel.value);
      clear(itemSel);
      for (const r of (src && src.inventory) || []) {
        const it = itemById(r.itemId);
        if (it) itemSel.appendChild(el('option', { value: it.id, selected: it.id === prefItem ? 'selected' : undefined }, `${it.name} (×${fmtNum(r.qty)})`));
      }
    };
    fromSel.addEventListener('change', renderItems);
    renderItems();

    const toSel = el('select.text-input', S().entities.filter(e => e.id !== fromId).map(e =>
      el('option', { value: e.id, selected: e.id === prefTo ? 'selected' : undefined }, e.name)));
    const qty = el('input.text-input', { type: 'number', min: '1', step: '1', value: '1' });
    openModal('TRANSFER OF GOODS', el('div',
      el('label.field-label', 'From'), fromSel,
      el('label.field-label', 'Item'), itemSel,
      el('label.field-label', 'Recipient'), toSel,
      el('label.field-label', 'Quantity'), qty
    ), [{
      label: 'Transfer', onClick: async () => {
        if (fromSel.value === toSel.value) throw new Error('Sender and recipient are the same entity.');
        await POST('/api/trade', { fromEntityId: fromSel.value, itemId: itemSel.value, toEntityId: toSel.value, qty: Number(qty.value) });
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

      /* Phase 7.3 — polling-over-time, one series per party, drawn only from
         the weekly rows that carry a polling snapshot (r.polling). */
      const hist = S().history;
      if (hist && hist.length) {
        const pollRows = hist.filter(r => r.polling);
        if (pollRows.length >= 2) {
          inner.appendChild(this.secLabel('Polling Over Time'));
          inner.appendChild(Charts.chartLine(parties.map(p => ({
            name: p.abbrev || p.name, color: p.color,
            points: pollRows.map(r => ({ x: r.turn, y: r.polling[p.id] }))
          })), { title: 'NATIONAL POLLING', yFormat: v => v + '%' }));
        }
      }
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

      /* Phase 7.3 — election results bar chart (seats by party). */
      inner.appendChild(Charts.chartBars((lastElec.national || []).map(r => {
        const party = parties.find(p => p.id === r.partyId);
        return { label: party ? (party.abbrev || party.name) : entName(r.partyId), value: r.seats, color: party ? party.color : undefined };
      }), { title: 'SEATS', valueFormat: v => v + ' seats' }));
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
  /* count of open trade offers addressed to entities I control — used for the
     Economy tab badge and the Trade sub-tab badge */
  openIncomingTrades() {
    if (!W.me || !W.me.entityId) return [];
    const mine = ownershipSetClient();
    return (S().trades || []).filter(t => t.status === 'open' && mine.has(t.toEntityId));
  },

  viewEconomy(inner) {
    if (!W.ecoTab) W.ecoTab = 'overview';
    const incoming = this.openIncomingTrades();
    inner.appendChild(el('div.doc-title', 'The Economy'));
    inner.appendChild(el('div.doc-sub', S().settings.currencyName + ' (' + CUR() + ') · turn ' + S().settings.time.turn));

    const tabs = el('div.chip-row',
      el('button.chip', { class: W.ecoTab === 'overview' ? 'active' : '', onclick: () => { W.ecoTab = 'overview'; App.renderView(); } }, 'Overview'),
      el('button.chip', { class: W.ecoTab === 'exchange' ? 'active' : '', onclick: () => { W.ecoTab = 'exchange'; App.renderView(); } }, 'Exchange'),
      el('button.chip', { class: W.ecoTab === 'trade' ? 'active' : '', onclick: () => { W.ecoTab = 'trade'; App.renderView(); } },
        'Trade', incoming.length ? el('span.count-badge', String(incoming.length)) : null)
    );
    inner.appendChild(tabs);

    if (W.ecoTab === 'exchange') return this.viewExchange(inner);
    if (W.ecoTab === 'trade') return this.viewTrade(inner);
    this.viewEconomyOverview(inner);
  },

  viewEconomyOverview(inner) {
    const g = S().globalVars || {};
    const cells = [];
    if (g.gdp !== undefined) cells.push(['National GDP', CUR() + fmtCompact((g.gdp || 0) * 1e6)]);
    if (g.moneySupply !== undefined) cells.push(['Money Supply', CUR() + fmtCompact(g.moneySupply)]);
    if (g.treasury !== undefined) cells.push(['Federal Treasury', CUR() + fmtCompact(g.treasury)]);
    cells.push(['Visible Accounts', fmtNum(S().accounts.length)]);
    inner.appendChild(this.statStrip(cells));

    // at-a-glance pies: who holds the (visible) money, and how the exchange
    // values the listed companies
    const pies = el('div', { style: 'display:flex; gap:16px; flex-wrap:wrap;' });
    const byOwner = {};
    for (const a of S().accounts) byOwner[a.ownerId] = (byOwner[a.ownerId] || 0) + a.balance;
    const holderRows = Object.keys(byOwner)
      .map(oid => ({ label: entName(oid), value: byOwner[oid], color: (entById(oid) || {}).color }));
    if (holderRows.filter(r => r.value > 0).length > 1) {
      pies.appendChild(Charts.chartPie(holderRows, { width: 340, height: 180, title: (perms().accounts === 'all' || isGM()) ? 'Money by Holder' : 'Your Money by Holder' }));
    }
    const capRows = S().entities
      .filter(e => e.type === 'company' && e.sharePrice !== undefined && e.sharesOutstanding)
      .map(c => ({ label: c.abbrev || c.name, value: c.sharePrice * c.sharesOutstanding, color: c.color }));
    if (capRows.length) pies.appendChild(Charts.chartPie(capRows, { width: 340, height: 180, title: 'Market Capitalisation' }));
    if (pies.children.length) inner.appendChild(pies);

    /* Phase 7.3 — GDP & money-supply history, gated on statistics clearance
       (filterState strips gdp/moneySupply from state.history without
       perms.statistics — only share prices survive for the Exchange tab). */
    const hist = S().history;
    if (hist && hist.length && hist.some(h => h.gdp !== undefined || h.moneySupply !== undefined)) {
      const xLabels = hist.map(h => 'T' + h.turn);
      inner.appendChild(this.secLabel('National GDP Over Time'));
      inner.appendChild(Charts.chartLine(hist.map(h => ({ x: h.turn, y: (h.gdp || 0) })), {
        title: 'GDP (' + CUR() + 'M)', xLabels, yFormat: (v) => fmtCompact(v)
      }));
      inner.appendChild(this.secLabel('Money Supply Over Time'));
      inner.appendChild(Charts.chartLine(hist.map(h => ({ x: h.turn, y: (h.moneySupply || 0) })), {
        title: 'Money Supply (' + CUR() + ')', xLabels, yFormat: (v) => fmtCompact(v)
      }));
    }

    // your accounts = the whole ownership chain: own entity plus any company
    // you own or run as CEO, and their subsidiaries
    const mineSet = ownershipSetClient();
    const myAccts = (S().accounts || []).filter(a => mineSet.has(a.ownerId));
    if (myAccts.length) {
      inner.appendChild(this.secLabel('Your Accounts'));
      const box = el('div.stage');
      myAccts.forEach(a => box.appendChild(this.kv((a.ownerId === W.me.entityId ? '' : entName(a.ownerId) + ' — ') + a.name, fmtMoney(a.balance))));
      box.appendChild(el('div.btn-row', el('button.solid-btn', { onclick: () => this.transferModal() }, CUR() + ' Wire Transfer')));
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

  /* ---- Exchange (Phase 4.4) ---- */
  viewExchange(inner) {
    const companies = S().entities.filter(e => e.type === 'company' && e.sharePrice !== undefined);
    inner.appendChild(el('div.doc-sub', { style: 'margin-top:-8px;' }, 'Lachevan Exchange — market maker, no order book'));
    if (!companies.length) {
      inner.appendChild(el('div', { style: 'color:var(--ink-faint); padding:20px 0;' }, 'No listed companies on file.'));
      return;
    }
    const hist = S().history || [];
    const controlsCompany = (c) => isGM() || (W.me.entityId && (c.ownerId === W.me.entityId || c.ceoId === W.me.entityId || ownership_controlsClient(W.me.entityId, c.id)));

    for (const c of companies) {
      const row = el('div.trade-row');
      const priceHist = hist.filter(h => h.shares && h.shares[c.id] !== undefined).map(h => ({ x: h.turn, y: h.shares[c.id] }));
      // day/week change from recorded history, else '—'
      const chg = (n) => {
        if (priceHist.length < n + 1) return '—';
        const now = priceHist[priceHist.length - 1].y, then = priceHist[priceHist.length - 1 - n].y;
        if (!then) return '—';
        const pct = (now - then) / then * 100;
        return (pct >= 0 ? '+' : '') + fmtNum(pct, 1) + '%';
      };
      const myHold = (() => {
        const sh = (c.shareholders || []).find(x => x.entityId === W.me.entityId);
        return sh ? sh.shares : 0;
      })();

      const head = el('div', { style: 'display:flex; justify-content:space-between; align-items:flex-start; gap:16px;' },
        el('div',
          el('div.tr-parties', c.name + ' — ' + (c.abbrev || c.industry || '')),
          el('div.tr-meta', `PRICE ${CUR()}${fmtNum(c.sharePrice)} · DAY ${chg(1)} · WEEK ${chg(7)} · FLOAT ${c.publicFloat || 0}% · TRUST ${c.trust !== undefined ? c.trust : '—'}`)),
        el('div', { style: 'text-align:right;' },
          el('div', { style: 'font-family:var(--font-mono); font-size:11px;' }, 'Your holding: ' + fmtNum(myHold) + ' shares')));
      row.appendChild(head);

      const cols = el('div', { style: 'display:flex; gap:18px; align-items:flex-start; margin-top:8px; flex-wrap:wrap;' });
      const sparkWrap = el('div.sparkline-cell');
      sparkWrap.appendChild(priceHist.length ? Charts.chartLine(priceHist, { width: 320, height: 110, title: 'Price History' }) : Charts.chartLine([], { width: 320, height: 110, title: 'Price History' }));
      cols.appendChild(sparkWrap);

      const btns = el('div.btn-row', { style: 'flex-direction:column; align-items:flex-start; gap:8px;' });
      const floatExhausted = market_treasuryPoolClient(c) <= 0;
      btns.appendChild(el('div.btn-row',
        el('button.solid-btn', { onclick: () => this.marketBuyModal(c) }, 'Buy'),
        el('button.dash-btn', { onclick: () => this.marketSellModal(c) }, 'Sell')
      ));
      if (floatExhausted) btns.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:9.5px; color:var(--ink-faint);' }, 'Public float fully subscribed — buying may be rejected.'));
      if (controlsCompany(c)) {
        btns.appendChild(el('button.outline-btn', { onclick: () => this.marketIssueModal(c) }, '⊕ Issue Shares'));
      }
      cols.appendChild(btns);
      row.appendChild(cols);
      inner.appendChild(row);
    }
  },

  marketBuyModal(c) {
    const shares = el('input.text-input', { type: 'number', min: '1', step: '1', placeholder: 'Number of shares' });
    openModal('BUY SHARES — ' + c.name, el('div',
      el('div', { style: 'margin-bottom:10px; font-size:12.5px; color:var(--ink-soft);' }, `Price ${CUR()}${fmtNum(c.sharePrice)} per share.`),
      el('label.field-label', 'Shares to buy'), shares
    ), [{
      label: 'Buy', onClick: async () => {
        const n = Math.round(Number(shares.value));
        if (!(n > 0)) throw new Error('Enter a positive share count.');
        const r = await POST('/api/market/buy', { companyId: c.id, shares: n });
        toast(`Bought ${r.shares} shares for ${fmtMoney(r.cost)}.`);
      }
    }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }]);
  },
  marketSellModal(c) {
    const shares = el('input.text-input', { type: 'number', min: '1', step: '1', placeholder: 'Number of shares' });
    openModal('SELL SHARES — ' + c.name, el('div',
      el('div', { style: 'margin-bottom:10px; font-size:12.5px; color:var(--ink-soft);' }, `Price ${CUR()}${fmtNum(c.sharePrice)} per share.`),
      el('label.field-label', 'Shares to sell'), shares
    ), [{
      label: 'Sell', onClick: async () => {
        const n = Math.round(Number(shares.value));
        if (!(n > 0)) throw new Error('Enter a positive share count.');
        const r = await POST('/api/market/sell', { companyId: c.id, shares: n });
        toast(`Sold ${r.shares} shares for ${fmtMoney(r.proceeds)}.`);
      }
    }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }]);
  },
  marketIssueModal(c) {
    const newShares = el('input.text-input', { type: 'number', min: '1', step: '1', placeholder: 'New shares to issue' });
    const floatPct = el('input.text-input', { type: 'number', min: '0', max: '100', step: '1', value: c.publicFloat || 0 });
    openModal('ISSUE SHARES — ' + c.name, el('div',
      el('div', { style: 'margin-bottom:10px; font-size:12.5px; color:var(--ink-soft);' }, `Currently ${fmtNum(c.sharesOutstanding)} shares outstanding, ${c.publicFloat || 0}% public float.`),
      el('label.field-label', 'New shares to issue'), newShares,
      el('label.field-label', 'New public float (%)'), floatPct
    ), [{
      label: 'Issue', onClick: async () => {
        const n = Math.round(Number(newShares.value));
        if (!(n > 0)) throw new Error('Enter a positive share count.');
        await POST('/api/market/issue', { companyId: c.id, newShares: n, floatPct: Number(floatPct.value) });
        toast('Shares issued.');
      }
    }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }]);
  },

  /* ---- Trade offers (Phase 4.3) ---- */
  viewTrade(inner) {
    const myEnt = myEntity();
    const mine = ownershipSetClient();
    const trades = [...(S().trades || [])].reverse();
    const open = trades.filter(t => t.status === 'open');
    const closed = trades.filter(t => t.status !== 'open').slice(0, 20);

    inner.appendChild(el('div.btn-row',
      el('button.solid-btn', { onclick: () => this.tradeOfferComposer() }, '⇄ New Trade Offer'),
      myEnt ? el('button.dash-btn', { onclick: () => this.tradeModal() }, '▣ Send Items (instant)') : null));

    inner.appendChild(this.secLabel('Open Offers (' + open.length + ')'));
    if (!open.length) inner.appendChild(el('div', { style: 'color:var(--ink-faint);' }, 'No open offers.'));
    for (const t of open) inner.appendChild(this.tradeOfferRow(t, mine));

    if (closed.length) {
      inner.appendChild(this.secLabel('Recently Closed'));
      for (const t of closed) inner.appendChild(this.tradeOfferRow(t, mine));
    }
  },

  tradeOfferRow(t, mine) {
    const from = entById(t.fromEntityId), to = entById(t.toEntityId);
    const rowsText = (rows) => rows.length ? rows.map(r => (itemById(r.itemId) || { name: r.itemId }).name + ' ×' + fmtNum(r.qty)).join(', ') : '—';
    const row = el('div.trade-row');
    row.appendChild(el('div.tr-parties', (from ? from.name : '—') + '  →  ' + (to ? to.name : '—')));
    row.appendChild(el('div.tr-meta', `T${t.turn} · ${fmtDate ? '' : ''}STATUS ${t.status.toUpperCase()}${t.memo ? ' · ' + t.memo : ''}`));
    const cols = el('div.trade-cols',
      el('div', el('div.tc-head', from ? from.name + ' gives' : 'They give'),
        el('div', { style: 'font-size:12.5px;' }, rowsText(t.give)),
        t.money.give ? el('div', { style: 'font-size:12.5px; margin-top:4px;' }, 'Plus ' + fmtMoney(t.money.give)) : null),
      el('div', el('div.tc-head', to ? to.name + ' gives' : 'You give'),
        el('div', { style: 'font-size:12.5px;' }, rowsText(t.get)),
        t.money.get ? el('div', { style: 'font-size:12.5px; margin-top:4px;' }, 'Plus ' + fmtMoney(t.money.get)) : null));
    row.appendChild(cols);

    if (t.status === 'open') {
      const canAccept = isGM() || mine.has(t.toEntityId);
      const canCancel = isGM() || mine.has(t.fromEntityId);
      const btns = el('div.btn-row');
      if (canAccept) {
        btns.appendChild(el('button.solid-btn', {
          onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await POST(`/api/trades/${t.id}/accept`); toast('Trade accepted.'); } catch (err) { toast(err.message, true); b.disabled = false; } }
        }, 'Accept'));
        btns.appendChild(el('button.dash-btn', {
          onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await POST(`/api/trades/${t.id}/decline`); toast('Trade declined.'); } catch (err) { toast(err.message, true); b.disabled = false; } }
        }, 'Decline'));
      }
      if (canCancel) {
        btns.appendChild(el('button.dash-btn', {
          onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await POST(`/api/trades/${t.id}/cancel`); toast('Trade cancelled.'); } catch (err) { toast(err.message, true); b.disabled = false; } }
        }, 'Cancel'));
      }
      if (btns.children.length) row.appendChild(btns);
    }
    return row;
  },

  tradeOfferComposer() {
    const myEnt = myEntity();
    if (!myEnt && !isGM()) return toast('You have no entity to trade from.', true);
    // offer can come from any entity in the controlled chain
    const mine = ownershipSetClient();
    const sources = S().entities.filter(e => isGM() || mine.has(e.id));
    if (!sources.length) return toast('You have no entity to trade from.', true);
    const fromSel = el('select.text-input', sources.map(e =>
      el('option', { value: e.id, selected: e.id === W.me.entityId ? 'selected' : undefined }, e.name)));
    const toSel = el('select.text-input', S().entities.map(e => el('option', { value: e.id }, e.name)));
    const memo = el('input.text-input', { placeholder: 'Memo (optional)' });
    const moneyGive = el('input.text-input', { type: 'number', min: '0', step: '0.01', value: '0' });
    const moneyGet = el('input.text-input', { type: 'number', min: '0', step: '0.01', value: '0' });

    // give: checkboxes + qty over the offering entity's inventory, rebuilt
    // whenever the From entity changes
    let giveRows = [];
    const giveBox = el('div');
    const renderGive = () => {
      const src = entById(fromSel.value);
      clear(giveBox);
      giveRows = ((src && src.inventory) || []).map(r => {
        const it = itemById(r.itemId);
        if (!it) return null;
        const check = el('input', { type: 'checkbox' });
        const qty = el('input.text-input', { type: 'number', min: '1', max: String(r.qty), step: '1', value: '1', style: 'width:80px;' });
        return { itemId: it.id, check, qty, node: el('div', { style: 'display:flex; align-items:center; gap:8px; padding:3px 0;' }, check, el('span', { style: 'flex:1;' }, it.name + ' (have ×' + fmtNum(r.qty) + ')'), qty) };
      }).filter(Boolean);
      if (giveRows.length) giveRows.forEach(r => giveBox.appendChild(r.node));
      else giveBox.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'That entity holds no items.'));
    };
    fromSel.addEventListener('change', renderGive);
    renderGive();

    // get: any tradable item + free qty (validated server-side at accept time)
    const getRows = [];
    const getBox = el('div');
    const addGetRow = () => {
      const itemSel = el('select.text-input', Forms.itemOptions().map(o => el('option', { value: o[0] }, o[1])));
      const qty = el('input.text-input', { type: 'number', min: '1', step: '1', value: '1', style: 'width:80px;' });
      const rowNode = el('div', { style: 'display:flex; align-items:center; gap:8px; padding:3px 0;' }, itemSel, qty,
        el('button.icon-btn', { onclick: () => { getBox.removeChild(rowNode); getRows.splice(getRows.indexOf(entry), 1); } }, '✕'));
      const entry = { itemSel, qty };
      getRows.push(entry);
      getBox.appendChild(rowNode);
    };

    openModal('NEW TRADE OFFER', el('div',
      el('label.field-label', 'Offer from'), fromSel,
      el('label.field-label', 'Offer to'), toSel,
      el('label.field-label', 'You give (items)'), giveBox,
      el('label.field-label', 'Plus money you give (' + CUR() + ')'), moneyGive,
      el('label.field-label', 'You request (items)'), getBox,
      el('button.dash-btn', { style: 'margin:4px 0 10px;', onclick: addGetRow }, '+ Add requested item'),
      el('label.field-label', 'Plus money you request (' + CUR() + ')'), moneyGet,
      el('label.field-label', 'Memo'), memo
    ), [{
      label: 'Send Offer', onClick: async () => {
        if (fromSel.value === toSel.value) throw new Error('Offerer and recipient are the same entity.');
        const give = giveRows.filter(r => r.check.checked).map(r => ({ itemId: r.itemId, qty: Number(r.qty.value) }));
        const get = getRows.map(r => ({ itemId: r.itemSel.value, qty: Number(r.qty.value) })).filter(r => r.itemId && r.qty > 0);
        await POST('/api/trades', {
          fromEntityId: fromSel.value, toEntityId: toSel.value, give, get,
          money: { give: Number(moneyGive.value) || 0, get: Number(moneyGet.value) || 0 },
          memo: memo.value
        });
        toast('Trade offer sent.');
      }
    }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }], true);
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

    /* Phase 7.3 — happiness & approval over time for the selected province,
       gated on statistics clearance (filterState only sends state.history
       when perms.statistics is set). Needs at least 2 recorded rows with
       data for this province to be worth plotting. */
    const hist = S().history;
    if (hist && hist.length) {
      const provRows = hist.filter(r => r.provinces && r.provinces[p.id]);
      if (provRows.length >= 2) {
        inner.appendChild(this.secLabel(p.name + ' — Happiness & Approval Over Time'));
        inner.appendChild(Charts.chartLine([
          { name: 'Happiness', color: 'var(--good)', points: provRows.map(r => ({ x: r.turn, y: (r.provinces[p.id] || {}).happiness })) },
          { name: 'Approval', color: 'var(--accent)', points: provRows.map(r => ({ x: r.turn, y: (r.provinces[p.id] || {}).approval })) }
        ], { title: 'HAPPINESS & APPROVAL', yFormat: v => v + '%' }));
      }
    }

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

  /* ---- News (Phase 5: four fixed papers) ---- */
  papers() { return (S().settings.newspapers || []); },
  paperById(id) { return this.papers().find(p => p.id === id); },

  viewNews(inner) {
    const papers = this.papers();
    if (!W.newsPaper || !papers.some(p => p.id === W.newsPaper)) W.newsPaper = 'paper_today';
    const paper = this.paperById(W.newsPaper) || papers[0];
    const isGmUser = isGM();
    // A journalist may file only to their own paper; the GM may file to any.
    const canManage = (perms().manageNews || isGmUser) && (isGmUser || W.me.newspaperId === paper.id);

    // ---- masthead switcher: four cards, one per paper ----
    const switcher = el('div.paper-switcher');
    papers.forEach(p => {
      // A paper with a logo image shows the wordmark itself; otherwise fall
      // back to the CSS-art masthead. (Herald fallback sets a small "THE"
      // above the big red name, matching the reference art.)
      let nameEl;
      if (p.logo) {
        nameEl = el('div.pm-logo', el('img', { src: p.logo, alt: p.name }));
      } else {
        const theMatch = p.style === 'herald' ? String(p.name || '').match(/^(the)\s+(.*)$/i) : null;
        nameEl = theMatch
          ? el('div.pm-name', el('span.pm-the', theMatch[1]), theMatch[2])
          : el('div.pm-name', p.name);
      }
      switcher.appendChild(el(`div.paper-mast.paper-mast-${p.style}`, {
        class: (p.id === W.newsPaper ? 'active' : '') + (p.logo ? ' has-logo' : ''),
        onclick: () => { W.newsPaper = p.id; W.newsCat = 'All'; W.newsQ = ''; App.renderView(); }
      },
        nameEl,
        el('div.pm-tagline', p.tagline || '')));
    });
    inner.appendChild(switcher);

    if (!W.newsCat) W.newsCat = 'All';
    if (W.newsTab === undefined) W.newsTab = 'published';
    const paperNews = S().news.filter(n => (n.paperId || 'paper_today') === paper.id);
    const publishedNews = paperNews.filter(n => n.status === 'published');
    const leadCat = publishedNews.length ? publishedNews[publishedNews.length - 1].category : 'General';
    inner.appendChild(el('div.paper-strapline',
      el('span', (paper.city || '').toUpperCase()),
      el('span.pm-mid', paper.tagline || ''),
      el('span', leadCat)));

    const cats = ['All', ...new Set(paperNews.map(n => n.category))];
    const bar = el('div.chip-row');
    cats.forEach(c => bar.appendChild(el('button.chip', { class: c === W.newsCat ? 'active' : '', onclick: () => { W.newsCat = c; App.renderView(); } }, c)));
    const search = el('input.text-input', { placeholder: 'Search the archive…', style: 'max-width:260px;', value: W.newsQ || '', oninput: (e) => { W.newsQ = e.target.value; clearTimeout(W._nq); W._nq = setTimeout(() => App.renderView(), 250); } });
    bar.appendChild(el('span', { style: 'flex:1' }));
    bar.appendChild(search);
    inner.appendChild(bar);

    if (canManage) {
      const tabs = el('div.chip-row',
        el('button.chip', { class: W.newsTab === 'published' ? 'active' : '', onclick: () => { W.newsTab = 'published'; App.renderView(); } }, 'Published'),
        el('button.chip', { class: W.newsTab === 'draft' ? 'active' : '', onclick: () => { W.newsTab = 'draft'; App.renderView(); } }, 'Drafts (' + paperNews.filter(n => n.status === 'draft').length + ')'),
        el('button.dash-btn', { onclick: () => this.newsEditor(null, paper.id) }, '✎ New Article'));
      inner.appendChild(tabs);
    } else if ((perms().manageNews || isGmUser) && !isGmUser) {
      inner.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:10px; letter-spacing:.08em; color:var(--ink-faint); margin:4px 0 10px;' },
        `Press credentials filed with ${this.paperById(W.me.newspaperId) ? this.paperById(W.me.newspaperId).name : 'no paper'}. Switch to that masthead to write.`));
    }

    const canSeeDrafts = perms().manageNews || isGmUser;
    const q = (W.newsQ || '').toLowerCase();
    let list = paperNews.filter(n =>
      (canSeeDrafts ? n.status === W.newsTab : n.status === 'published') &&
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
          el('button.dash-btn', { onclick: () => this.newsEditor(n, paper.id) }, 'Edit'),
          n.status === 'published' ? el('button.dash-btn', { onclick: async () => { await PATCH('/api/news/' + n.id, { status: 'draft' }); toast('Retracted to drafts.'); } }, 'Retract') : null,
          el('button.dash-btn', { onclick: () => confirmModal('DESTROY RECORD', 'Delete this article permanently?', async () => { await DEL('/api/news/' + n.id); toast('Deleted.'); }) }, 'Delete')));
      }
      inner.appendChild(art);
    });
  },

  newsEditor(article, paperId) {
    const isGmUser = isGM();
    const headline = el('input.text-input', { value: article ? article.headline : '', placeholder: 'HEADLINE' });
    const category = el('input.text-input', { value: article ? article.category : 'Politics', placeholder: 'Category' });
    const body = el('textarea.text-input', { style: 'min-height:180px;' }, article ? article.body : '');
    const targetPaperId = article ? (article.paperId || 'paper_today') : (paperId || W.newsPaper || 'paper_today');
    // GM may retarget which paper an article runs in; journalists are locked
    // to their own masthead (the server enforces this regardless).
    const paperSel = isGmUser
      ? el('select.text-input', this.papers().map(p => el('option', { value: p.id, selected: p.id === targetPaperId ? 'selected' : undefined }, p.name)))
      : null;
    openModal(article ? 'EDIT ARTICLE' : 'NEW ARTICLE', el('div',
      isGmUser ? el('label.field-label', 'Newspaper') : null,
      isGmUser ? paperSel : null,
      el('label.field-label', 'Headline'), headline,
      el('label.field-label', 'Category'), category,
      el('label.field-label', 'Body'), body
    ), [
      {
        label: article ? 'Save' : 'Publish', onClick: async () => {
          const pid = isGmUser ? paperSel.value : targetPaperId;
          if (article) await PATCH('/api/news/' + article.id, { headline: headline.value, category: category.value, body: body.value, paperId: pid });
          else await POST('/api/news', { headline: headline.value, category: category.value, body: body.value, publish: true, paperId: pid });
          toast('Filed.');
        }
      },
      !article ? {
        label: 'Save as Draft', cls: 'dash-btn', onClick: async () => {
          const pid = isGmUser ? paperSel.value : targetPaperId;
          await POST('/api/news', { headline: headline.value, category: category.value, body: body.value, publish: false, paperId: pid });
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
    if (!isGM()) inner.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:10px; letter-spacing:.08em; color:var(--ink-faint); margin:6px 0 2px;' },
      'You see the public record and files concerning your own holdings.'));
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
