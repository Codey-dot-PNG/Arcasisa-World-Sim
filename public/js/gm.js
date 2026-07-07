'use strict';
/* GM Studio: visual editors for every collection. No SQL, no code. */

const GM = {
  draft: null, draftKey: null,

  TABS: [
    ['world', 'World & Time'],
    ['provinces', 'Provinces'],
    ['mapobjects', 'Cities & Properties'],
    ['registry', 'Entity Registry'],
    ['economy', 'Money & Accounts'],
    ['items', 'Items & Market'],
    ['variables', 'Variables'],
    ['events', 'Event Engine'],
    ['population', 'Population'],
    ['roles', 'Roles & Operators'],
    ['danger', 'Archive & Danger']
  ],

  render(container) {
    clear(container);
    const layout = el('div.gm-layout');
    const nav = el('div.gm-nav');
    for (const [id, label] of this.TABS) {
      nav.appendChild(el('button.gm-nav-item', { class: W.gmTab === id ? 'active' : '', onclick: () => { W.gmTab = id; this.draftKey = null; App.renderView(); } }, label));
    }
    const main = el('div.gm-main');
    layout.appendChild(nav); layout.appendChild(main);
    container.appendChild(layout);
    const fn = {
      world: this.tabWorld, provinces: this.tabProvinces, mapobjects: this.tabMapObjects,
      registry: this.tabRegistry, economy: this.tabEconomy, items: this.tabItems,
      variables: this.tabVariables, events: this.tabEvents, population: this.tabPopulation,
      roles: this.tabRoles, danger: this.tabDanger
    }[W.gmTab] || this.tabWorld;
    fn.call(this, main);
  },

  /* ---------- form helpers (bind into a draft object) ---------- */
  field(label, input, hint) {
    return el('div', el('label.field-label', label), input, hint ? el('div', { style: 'font-family:var(--font-mono); font-size:9px; color:var(--ink-faint); margin-top:3px;' }, hint) : null);
  },
  text(obj, key, ph) { return el('input.text-input', { value: obj[key] ?? '', placeholder: ph || '', oninput: (e) => obj[key] = e.target.value }); },
  num(obj, key, step) { return el('input.text-input', { type: 'number', step: step || 'any', value: obj[key] ?? '', oninput: (e) => obj[key] = e.target.value === '' ? undefined : Number(e.target.value) }); },
  area(obj, key, style) { const t = el('textarea.text-input', { style: style || '', oninput: (e) => obj[key] = e.target.value }); t.value = obj[key] ?? ''; return t; },
  check(obj, key, label) {
    return el('label', { style: 'display:flex; gap:8px; align-items:center; margin-top:12px; font-size:13px; cursor:pointer;' },
      el('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => obj[key] = e.target.checked }), label);
  },
  sel(obj, key, options, onchange) {
    const s = el('select.text-input', options.map(o => el('option', { value: o[0], selected: String(obj[key]) === String(o[0]) ? 'selected' : undefined }, o[1])));
    s.addEventListener('change', () => { obj[key] = s.value === '__null__' ? null : s.value; if (onchange) onchange(s.value); });
    if (obj[key] === undefined && options.length) obj[key] = options[0][0] === '__null__' ? null : options[0][0];
    return s;
  },
  color(obj, key) {
    return el('input', { type: 'color', value: obj[key] || '#5c5340', style: 'width:52px; height:28px; border:1px solid var(--rule-strong); background:transparent; cursor:pointer;', oninput: (e) => obj[key] = e.target.value });
  },
  entOptions(types, allowNull) {
    const opts = S().entities.filter(e => !types || types.includes(e.type)).map(e => [e.id, e.name + ' (' + (TYPE_LABEL[e.type] || e.type) + ')']);
    return allowNull ? [['__null__', '— none —'], ...opts] : opts;
  },
  provOptions(extra) { return [...(extra || []), ...S().provinces.map(p => [p.id, p.name])]; },
  itemOptions(extra) { return [...(extra || []), ...S().items.map(i => [i.id, i.name])]; },

  getDraft(key, source) {
    if (this.draftKey !== key) { this.draft = JSON.parse(JSON.stringify(source)); this.draftKey = key; }
    return this.draft;
  },

  async saveColl(coll, draft, isNew) {
    if (isNew) await POST('/api/gm/coll/' + coll, draft);
    else await PATCH(`/api/gm/coll/${coll}/${draft.id}`, draft);
    this.draftKey = null;
    toast('Saved to the record.');
  },
  deleteColl(coll, id, name) {
    confirmModal('DESTROY RECORD', `Delete “${name}” permanently? References will be cleared.`, async () => {
      await DEL(`/api/gm/coll/${coll}/${id}`);
      if (W.gmSel[W.gmTab] === id) W.gmSel[W.gmTab] = null;
      this.draftKey = null;
      toast('Deleted.');
    });
  },

  listPane(items, selId, onSelect, labelFn, subFn, addLabel, onAdd) {
    const box = el('div');
    if (onAdd) box.appendChild(el('div.btn-row', { style: 'margin:0 0 10px;' }, el('button.dash-btn', { onclick: onAdd }, '+ ' + addLabel)));
    const list = el('div.gm-list');
    for (const it of items) {
      list.appendChild(el('div.gm-list-item', { class: it.id === selId ? 'selected' : '', onclick: () => onSelect(it.id) },
        el('span', labelFn(it)), el('span.sub', subFn ? subFn(it) : '')));
    }
    if (!items.length) list.appendChild(el('div', { style: 'padding:14px; color:var(--ink-faint); font-size:12px;' }, 'None on file.'));
    box.appendChild(list);
    return box;
  },

  varsEditor(draft, scope) {
    const defs = (S().variables || []).filter(v => v.scope === scope);
    draft.vars = draft.vars || {};
    const box = el('div');
    box.appendChild(Views.secLabel('Variables'));
    const table = el('div.form-grid');
    const keys = new Set([...defs.map(d => d.key), ...Object.keys(draft.vars)]);
    for (const k of keys) {
      const def = defs.find(d => d.key === k);
      table.appendChild(this.field(def ? def.label : k, this.num(draft.vars, k)));
    }
    box.appendChild(table);
    const nk = el('input.text-input', { placeholder: 'new variable key', style: 'max-width:200px;' });
    box.appendChild(el('div.btn-row', nk, el('button.dash-btn', {
      onclick: () => { if (nk.value.trim()) { draft.vars[nk.value.trim()] = 0; App.renderView(); } }
    }, '+ Add custom variable')));
    return box;
  },

  inventoryEditor(draft) {
    draft.inventory = draft.inventory || [];
    const box = el('div');
    box.appendChild(Views.secLabel('Inventory'));
    draft.inventory.forEach((row, i) => {
      box.appendChild(el('div', { style: 'display:flex; gap:10px; align-items:flex-end; margin-bottom:4px;' },
        el('div', { style: 'flex:1' }, this.sel(row, 'itemId', this.itemOptions())),
        el('div', { style: 'width:110px' }, this.num(row, 'qty')),
        el('button.icon-btn', { onclick: () => { draft.inventory.splice(i, 1); App.renderView(); } }, '✕')));
    });
    box.appendChild(el('div.btn-row', el('button.dash-btn', {
      onclick: () => { if (S().items.length) { draft.inventory.push({ itemId: S().items[0].id, qty: 1 }); App.renderView(); } }
    }, '+ Add item')));
    return box;
  },

  saveBar(coll, draft, isNew, nameForDelete) {
    return el('div.btn-row', { style: 'margin-top:22px; border-top:1px dashed var(--rule-strong); padding-top:14px;' },
      el('button.solid-btn', { onclick: async () => { try { await this.saveColl(coll, draft, isNew); } catch (e) { toast(e.message, true); } } }, isNew ? 'Create' : 'Save Changes'),
      !isNew ? el('button.dash-btn', {
        onclick: () => { const copy = JSON.parse(JSON.stringify(draft)); delete copy.id; copy.name = (copy.name || '') + ' (copy)'; POST('/api/gm/coll/' + coll, copy).then(() => toast('Duplicated.')).catch(e => toast(e.message, true)); }
      }, 'Duplicate') : null,
      !isNew ? el('button.danger-btn', { onclick: () => this.deleteColl(coll, draft.id, nameForDelete || draft.name || draft.id) }, 'Delete') : null
    );
  },

  /* ═══════════ WORLD & TIME ═══════════ */
  tabWorld(main) {
    const s = S().settings;
    const d = this.getDraft('world', {
      worldName: s.worldName, currency: s.currency, currencyName: s.currencyName, parliamentSeats: s.parliamentSeats,
      unit: s.time.unit, perTurn: s.time.perTurn, date: s.time.date,
      autoEnabled: s.time.auto.enabled, autoSeconds: s.time.auto.seconds,
      regOpen: s.registration.open, regRole: s.registration.defaultRole, regStipend: s.registration.stipend,
      newsTx: s.newsThresholds.transaction
    });
    main.appendChild(el('div.doc-title', 'World & Time'));
    main.appendChild(el('div.doc-sub', 'turn ' + s.time.turn + ' · ' + fmtDate(s.time.date)));

    main.appendChild(el('div.stage', el('div.stage-header', el('span.stage-chapter', 'Advance the Simulation'), el('span.stage-year', 'T' + s.time.turn)),
      el('div.btn-row',
        el('button.solid-btn', { onclick: () => POST('/api/gm/advance', { steps: 1 }).then(() => toast('One turn passes.')).catch(e => toast(e.message, true)) }, '▸ 1 Turn'),
        el('button.solid-btn', { onclick: () => POST('/api/gm/advance', { steps: 7 }).then(() => toast('A week passes.')).catch(e => toast(e.message, true)) }, '▸▸ 7 Turns'),
        el('button.solid-btn', { onclick: () => POST('/api/gm/advance', { steps: 30 }).then(() => toast('A month passes.')).catch(e => toast(e.message, true)) }, '▸▸▸ 30 Turns'))));

    main.appendChild(Views.secLabel('World'));
    const g1 = el('div.form-grid',
      this.field('World name', this.text(d, 'worldName')),
      this.field('Parliament seats', this.num(d, 'parliamentSeats')),
      this.field('Currency symbol', this.text(d, 'currency')),
      this.field('Currency name', this.text(d, 'currencyName')));
    main.appendChild(g1);

    main.appendChild(Views.secLabel('Time'));
    main.appendChild(el('div.form-grid',
      this.field('Unit of one turn', this.sel(d, 'unit', [['hour', 'Hour'], ['day', 'Day'], ['week', 'Week']])),
      this.field('Units per turn', this.num(d, 'perTurn')),
      this.field('Current date (YYYY-MM-DD)', this.text(d, 'date')),
      this.field('', el('span'))));
    main.appendChild(this.check(d, 'autoEnabled', 'Auto-advance the simulation'));
    main.appendChild(el('div.form-grid', this.field('Real seconds per turn (auto)', this.num(d, 'autoSeconds'))));

    main.appendChild(Views.secLabel('Registration & Wire Service'));
    main.appendChild(this.check(d, 'regOpen', 'Open registration (players can request citizenship)'));
    main.appendChild(el('div.form-grid',
      this.field('Default role for new players', this.sel(d, 'regRole', (S().roles || []).map(r => [r.id, r.name]))),
      this.field('Citizenship stipend (' + CUR() + ')', this.num(d, 'regStipend')),
      this.field('Auto-news threshold for transfers', this.num(d, 'newsTx'), 'Transfers at or above this amount draft a news story.')));

    main.appendChild(el('div.btn-row', { style: 'margin-top:20px;' }, el('button.solid-btn', {
      onclick: async () => {
        try {
          await PATCH('/api/gm/settings', {
            worldName: d.worldName, currency: d.currency, currencyName: d.currencyName, parliamentSeats: Number(d.parliamentSeats) || 150,
            time: { unit: d.unit, perTurn: Number(d.perTurn) || 1, date: d.date, auto: { enabled: !!d.autoEnabled, seconds: Number(d.autoSeconds) || 3600 } },
            registration: { open: !!d.regOpen, defaultRole: d.regRole, stipend: Number(d.regStipend) || 0 },
            newsThresholds: { transaction: Number(d.newsTx) || 5000000 }
          });
          this.draftKey = null;
          toast('World settings saved.');
        } catch (e) { toast(e.message, true); }
      }
    }, 'Save World Settings')));

    main.appendChild(Views.secLabel('Snapshots & Rollback'));
    const snapBox = el('div', el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'Consulting the archive…'));
    main.appendChild(snapBox);
    GET('/api/gm/snapshots').then(({ snapshots }) => {
      clear(snapBox);
      const snaps = [...(snapshots || [])].reverse().slice(0, 20);
      if (!snaps.length) return snapBox.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'A snapshot is written before every turn advance. None yet.'));
      snapBox.appendChild(el('table.data', el('thead', el('tr', el('th', 'Turn'), el('th', 'Size'), el('th', 'Taken'), el('th', ''))),
        el('tbody', snaps.map(sn => el('tr',
          el('td', 'T' + sn.turn),
          el('td', sn.bytes ? Math.round(sn.bytes / 1024) + ' KB' : '—'),
          el('td', new Date(sn.mtime).toLocaleString()),
          el('td', el('button.outline-btn', {
            onclick: () => confirmModal('ROLL BACK THE WORLD', `Restore the world as it stood at the start of turn ${sn.turn}? Operator accounts and roles are preserved.`, async () => {
              await POST('/api/gm/rollback', { turn: sn.turn });
              toast('The world rolls back to turn ' + sn.turn + '.');
            }, 'Roll Back')
          }, '↺ Roll back')))))));
    }).catch(e => { clear(snapBox); snapBox.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'Archive unavailable: ' + e.message)); });
  },

  /* ═══════════ PROVINCES ═══════════ */
  tabProvinces(main) {
    main.appendChild(el('div.doc-title', 'Provinces'));
    main.appendChild(el('div.doc-sub', 'geometry · variables · demographics'));
    const selId = W.gmSel.provinces;
    main.appendChild(this.listPane(S().provinces, selId, (id) => { W.gmSel.provinces = id; this.draftKey = null; App.renderView(); },
      p => p.name, p => fmtCompact(p.vars.population), 'New Province',
      () => { W.gmSel.provinces = '__new__'; this.draftKey = null; App.renderView(); }));

    if (!selId) return;
    const isNew = selId === '__new__';
    const source = isNew
      ? { name: 'New Province', color: '#8a8a6a', description: '', path: [[100, 100], [200, 80], [240, 160], [140, 190]], labelPos: [170, 135], vars: {}, demographics: {} }
      : provById(selId);
    if (!source) return;
    const d = this.getDraft('prov:' + selId, source);
    d.pathText = d.pathText || (d.path || []).map(p => p.join(',')).join(' ');

    main.appendChild(Views.secLabel(isNew ? 'New Province' : 'Edit — ' + source.name));
    main.appendChild(el('div.form-grid',
      this.field('Name', this.text(d, 'name')),
      this.field('Map colour', this.color(d, 'color')),
      this.field('Label position "x,y"', el('input.text-input', { value: (d.labelPos || []).join(','), oninput: (e) => d.labelPos = e.target.value.split(',').map(Number) })),
      this.field('Capital city', this.sel(d, 'capital', [['__null__', '— none —'], ...S().cities.map(c => [c.id, c.name])]))));
    main.appendChild(this.field('Description', this.area(d, 'description')));
    main.appendChild(this.field('Boundary polygon — points "x,y x,y …" on the 1200×675 map grid', this.area(d, 'pathText', 'min-height:64px; font-family:var(--font-mono); font-size:11px;')));
    main.appendChild(this.varsEditor(d, 'province'));

    // demographics grid
    main.appendChild(Views.secLabel('Demographics'));
    d.demographics = d.demographics || {};
    const groups = S().settings.demographics.groups || [];
    const metrics = S().settings.demographics.metrics || [];
    const head = el('tr', el('th', 'Group'));
    metrics.forEach(mDef => head.appendChild(el('th.num', mDef.label)));
    const tbody = el('tbody');
    for (const gname of groups) {
      d.demographics[gname] = d.demographics[gname] || {};
      const row = el('tr', el('td', gname));
      for (const mDef of metrics) {
        const grp = d.demographics[gname];
        row.appendChild(el('td.num', el('input', {
          value: grp[mDef.key] ?? 0,
          oninput: (e) => grp[mDef.key] = Number(e.target.value) || 0
        })));
      }
      tbody.appendChild(row);
    }
    main.appendChild(el('div', { style: 'overflow-x:auto;' }, el('table.data.demo-table', el('thead', head), tbody)));

    const bar = this.saveBar('provinces', d, isNew);
    bar.firstChild.addEventListener('click', () => {
      try { d.path = d.pathText.trim().split(/\s+/).map(pair => pair.split(',').map(Number)).filter(p => p.length === 2 && !p.some(isNaN)); } catch (e) { }
      delete d.pathText;
    }, { capture: true });
    main.appendChild(bar);
  },

  /* ═══════════ CITIES & PROPERTIES ═══════════ */
  tabMapObjects(main) {
    main.appendChild(el('div.doc-title', 'Cities & Properties'));
    main.appendChild(el('div.doc-sub', 'everything that sits on the map'));
    if (!W.gmSub) W.gmSub = 'properties';
    main.appendChild(el('div.chip-row',
      el('button.chip', { class: W.gmSub === 'properties' ? 'active' : '', onclick: () => { W.gmSub = 'properties'; this.draftKey = null; App.renderView(); } }, 'Properties'),
      el('button.chip', { class: W.gmSub === 'cities' ? 'active' : '', onclick: () => { W.gmSub = 'cities'; this.draftKey = null; App.renderView(); } }, 'Cities')));

    if (W.gmSub === 'cities') return this.cityEditor(main);
    return this.propertyEditor(main);
  },

  placeButton(d, label) {
    return el('button.dash-btn', {
      onclick: () => {
        const returnTab = W.gmTab;
        App.go('map');
        GameMap.setPlacing({
          label: label || 'position', cb: (pt) => {
            d.pos = pt;
            toast('Position captured: ' + pt.join(', '));
            W.gmTab = returnTab;
            App.go('gm');
          }
        });
      }
    }, '⌖ Place on map' + (d.pos ? ' (' + d.pos.join(',') + ')' : ''));
  },

  cityEditor(main) {
    const selId = W.gmSel.mapobjects;
    main.appendChild(this.listPane(S().cities, selId, (id) => { W.gmSel.mapobjects = id; this.draftKey = null; App.renderView(); },
      c => (c.isCapital ? '★ ' : '') + c.name, c => (provById(c.provinceId) || {}).name || '', 'New City',
      () => { W.gmSel.mapobjects = '__newcity__'; this.draftKey = null; App.renderView(); }));
    if (!selId) return;
    const isNew = selId === '__newcity__';
    const source = isNew ? { name: 'New City', provinceId: S().provinces[0] && S().provinces[0].id, pos: [600, 340], size: 1, isCapital: false, description: '' } : cityById(selId);
    if (!source) return;
    const d = this.getDraft('city:' + selId, source);
    main.appendChild(Views.secLabel(isNew ? 'New City' : 'Edit — ' + source.name));
    main.appendChild(el('div.form-grid',
      this.field('Name', this.text(d, 'name')),
      this.field('Province', this.sel(d, 'provinceId', this.provOptions())),
      this.field('Size (1–3)', this.num(d, 'size')),
      this.field('Position', this.placeButton(d, d.name))));
    main.appendChild(this.check(d, 'isCapital', 'National capital'));
    main.appendChild(this.field('Description', this.area(d, 'description')));
    main.appendChild(this.saveBar('cities', d, isNew));
  },

  propertyEditor(main) {
    const selId = W.gmSel.mapobjects;
    const props = S().properties;
    main.appendChild(this.listPane(props, selId, (id) => { W.gmSel.mapobjects = id; this.draftKey = null; App.renderView(); },
      p => p.name, p => entName(p.ownerId), 'New Property',
      () => { W.gmSel.mapobjects = '__newprop__'; this.draftKey = null; App.renderView(); }));
    if (!selId) return;
    const isNew = selId === '__newprop__';
    const source = isNew
      ? { name: 'New Property', type: 'commercial', kind: 'office', provinceId: S().provinces[0] && S().provinces[0].id, pos: [600, 340], ownerId: null, value: 100000, employees: 0, income: 0, expenses: 0, description: '', inventory: [], vars: {} }
      : propById(selId);
    if (!source) return;
    const d = this.getDraft('prop:' + selId, source);
    main.appendChild(Views.secLabel(isNew ? 'New Property' : 'Edit — ' + source.name));
    main.appendChild(el('div.form-grid',
      this.field('Name', this.text(d, 'name')),
      this.field('Owner', this.sel(d, 'ownerId', this.entOptions(null, true))),
      this.field('Category', this.sel(d, 'type', [['residential', 'Residential'], ['commercial', 'Commercial'], ['industrial', 'Industrial'], ['agricultural', 'Agricultural'], ['government', 'Government'], ['military', 'Military'], ['infrastructure', 'Infrastructure']])),
      this.field('Kind (marker glyph)', this.sel(d, 'kind', Object.keys(KIND_GLYPH).map(k => [k, k.replace('_', ' ') + ' [' + KIND_GLYPH[k] + ']']))),
      this.field('Province', this.sel(d, 'provinceId', this.provOptions())),
      this.field('Position', this.placeButton(d, d.name)),
      this.field('Assessed value', this.num(d, 'value')),
      this.field('Employees', this.num(d, 'employees')),
      this.field('Monthly income', this.num(d, 'income')),
      this.field('Monthly expenses', this.num(d, 'expenses'))));
    main.appendChild(this.field('Description', this.area(d, 'description')));
    main.appendChild(this.varsEditor(d, 'property'));
    main.appendChild(this.inventoryEditor(d));
    main.appendChild(this.saveBar('properties', d, isNew));
  },

  /* ═══════════ ENTITY REGISTRY ═══════════ */
  tabRegistry(main) {
    main.appendChild(el('div.doc-title', 'Entity Registry'));
    main.appendChild(el('div.doc-sub', 'companies · parties · people · governments · foreign powers'));
    if (!W.gmEntType) W.gmEntType = 'company';
    const types = ['company', 'party', 'person', 'government', 'foreign', 'org'];
    main.appendChild(el('div.chip-row', types.map(t =>
      el('button.chip', { class: W.gmEntType === t ? 'active' : '', onclick: () => { W.gmEntType = t; this.draftKey = null; App.renderView(); } }, TYPE_LABEL[t] || t))));

    const list = S().entities.filter(e => e.type === W.gmEntType);
    const selId = W.gmSel.registry;
    main.appendChild(this.listPane(list, selId, (id) => { W.gmSel.registry = id; this.draftKey = null; App.renderView(); },
      e => e.name, e => e.industry || e.title || e.stance || '', 'New ' + (TYPE_LABEL[W.gmEntType] || 'Entity'),
      () => { W.gmSel.registry = '__new__'; this.draftKey = null; App.renderView(); }));
    if (!selId) return;
    const isNew = selId === '__new__';
    const source = isNew
      ? { name: 'New ' + (TYPE_LABEL[W.gmEntType] || 'Entity'), type: W.gmEntType, color: '#5c5340', description: '', vars: {}, inventory: [] }
      : entById(selId);
    if (!source) return;
    const d = this.getDraft('ent:' + selId, source);

    main.appendChild(Views.secLabel(isNew ? 'New Record' : 'Edit — ' + source.name));
    main.appendChild(el('div.form-grid',
      this.field('Name', this.text(d, 'name')),
      this.field('Type', this.sel(d, 'type', types.map(t => [t, TYPE_LABEL[t] || t]))),
      this.field('Marker colour', this.color(d, 'color')),
      this.field('Logo / image path', this.text(d, 'logo', '/assets/…')),
      d.type === 'company' ? this.field('Industry', this.text(d, 'industry')) : null,
      d.type === 'company' ? this.field('Controlled by', this.sel(d, 'ownerId', this.entOptions(null, true))) : null,
      d.type === 'company' ? this.field('Chief Executive', this.sel(d, 'ceoId', this.entOptions(['person'], true))) : null,
      d.type === 'company' ? this.field('Shares outstanding', this.num(d, 'sharesOutstanding')) : null,
      d.type === 'party' ? this.field('Leader', this.sel(d, 'leaderId', this.entOptions(['person'], true))) : null,
      d.type === 'party' ? this.field('Abbreviation', this.text(d, 'abbrev')) : null,
      d.type === 'party' ? this.field('Seats (MPs)', this.num(d, 'mpCount')) : null,
      d.type === 'person' ? this.field('Title', this.text(d, 'title')) : null,
      (d.type === 'foreign' || d.type === 'org') ? this.field('Stance / relations', this.text(d, 'stance')) : null
    ));
    if (d.type === 'party') {
      d.ideology = d.ideology || { econ: 0, soc: 0 };
      main.appendChild(el('div.form-grid',
        this.field('Ideology — economic (−100 left … +100 right)', this.num(d.ideology, 'econ')),
        this.field('Ideology — social (−100 lib … +100 auth)', this.num(d.ideology, 'soc'))));
      main.appendChild(this.check(d, 'inGovernment', 'Currently in government'));
    }
    main.appendChild(this.field('Description', this.area(d, 'description')));

    if (d.type === 'company') {
      main.appendChild(Views.secLabel('Share Register'));
      d.shareholders = d.shareholders || [];
      d.shareholders.forEach((sh, i) => {
        main.appendChild(el('div', { style: 'display:flex; gap:10px; align-items:flex-end; margin-bottom:4px;' },
          el('div', { style: 'flex:1' }, this.sel(sh, 'entityId', this.entOptions())),
          el('div', { style: 'width:130px' }, this.num(sh, 'shares')),
          el('button.icon-btn', { onclick: () => { d.shareholders.splice(i, 1); App.renderView(); } }, '✕')));
      });
      main.appendChild(el('div.btn-row', el('button.dash-btn', {
        onclick: () => { d.shareholders.push({ entityId: S().entities[0].id, shares: 0 }); App.renderView(); }
      }, '+ Add shareholder')));
      main.appendChild(this.varsEditor(d, 'company'));
    } else {
      main.appendChild(this.varsEditor(d, 'entity'));
    }
    main.appendChild(this.inventoryEditor(d));
    main.appendChild(this.saveBar('entities', d, isNew));
  },

  /* ═══════════ MONEY ═══════════ */
  tabEconomy(main) {
    main.appendChild(el('div.doc-title', 'Money & Accounts'));
    main.appendChild(el('div.doc-sub', 'the Bank of Arcasia answers to you alone'));
    main.appendChild(el('div.btn-row',
      el('button.solid-btn', {
        onclick: () => {
          const nd = { ownerId: S().entities[0].id, name: 'New Account', balance: 0 };
          openModal('OPEN ACCOUNT', el('div',
            el('label.field-label', 'Holder'), this.sel(nd, 'ownerId', this.entOptions()),
            el('label.field-label', 'Account name'), this.text(nd, 'name'),
            el('label.field-label', 'Opening balance'), this.num(nd, 'balance')
          ), [{ label: 'Open Account', onClick: async () => { await POST('/api/gm/coll/accounts', nd); toast('Account opened.'); } }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }]);
        }
      }, '+ Open Account'),
      el('button.dash-btn', {
        onclick: () => {
          const nd = { accountId: S().accounts[0] && S().accounts[0].id, amount: 0, memo: '' };
          openModal('CENTRAL BANK OPERATION', el('div',
            el('div', { style: 'font-size:12px; color:var(--ink-soft); margin-top:8px;' }, 'Positive amount mints money into the account; negative destroys it. Fully logged.'),
            el('label.field-label', 'Account'), this.sel(nd, 'accountId', S().accounts.map(a => [a.id, entName(a.ownerId) + ' — ' + a.name])),
            el('label.field-label', 'Amount (±)'), this.num(nd, 'amount'),
            el('label.field-label', 'Memo'), this.text(nd, 'memo')
          ), [{ label: 'Execute', onClick: async () => { await POST('/api/gm/mint', nd); toast('Executed.'); } }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }]);
        }
      }, '₳ Mint / Destroy'),
      el('button.dash-btn', { onclick: () => Views.transferModal() }, '⇄ Transfer')));

    main.appendChild(Views.secLabel('All Accounts'));
    main.appendChild(el('table.data',
      el('thead', el('tr', el('th', 'Holder'), el('th', 'Account'), el('th.num', 'Balance'), el('th', ''))),
      el('tbody', [...S().accounts].sort((a, b) => b.balance - a.balance).map(a => el('tr',
        el('td', entName(a.ownerId)), el('td', a.name), el('td.num', fmtMoney(a.balance)),
        el('td', el('button.icon-btn', { title: 'Close account', onclick: () => this.deleteColl('accounts', a.id, a.name) }, '✕')))))));
  },

  /* ═══════════ ITEMS ═══════════ */
  tabItems(main) {
    main.appendChild(el('div.doc-title', 'Items & Market'));
    main.appendChild(el('div.doc-sub', 'changing a market value updates every inventory in the world'));
    const selId = W.gmSel.items;
    main.appendChild(this.listPane(S().items, selId, (id) => { W.gmSel.items = id; this.draftKey = null; App.renderView(); },
      i => i.name, i => CUR() + fmtNum(i.marketValue), 'New Item',
      () => { W.gmSel.items = '__new__'; this.draftKey = null; App.renderView(); }));
    if (!selId) return;
    const isNew = selId === '__new__';
    const source = isNew ? { name: 'New Item', description: '', icon: '?', category: 'Goods', marketValue: 1, tradable: true, meta: {} } : itemById(selId);
    if (!source) return;
    const d = this.getDraft('item:' + selId, source);
    main.appendChild(Views.secLabel(isNew ? 'New Item' : 'Edit — ' + source.name));
    main.appendChild(el('div.form-grid',
      this.field('Name', this.text(d, 'name')),
      this.field('Category', this.text(d, 'category')),
      this.field('Market value (' + CUR() + ')', this.num(d, 'marketValue')),
      this.field('Marker glyph (1 char)', this.text(d, 'icon'))));
    main.appendChild(this.check(d, 'tradable', 'Tradable between entities'));
    main.appendChild(this.field('Description', this.area(d, 'description')));
    main.appendChild(this.field('Metadata (JSON)', el('textarea.text-input', {
      style: 'font-family:var(--font-mono); font-size:11px;',
      oninput: (e) => { try { d.meta = JSON.parse(e.target.value || '{}'); e.target.style.borderColor = ''; } catch (x) { e.target.style.borderColor = 'var(--accent)'; } }
    }, JSON.stringify(d.meta || {}))));
    main.appendChild(this.saveBar('items', d, isNew));
  },

  /* ═══════════ VARIABLES ═══════════ */
  tabVariables(main) {
    main.appendChild(el('div.doc-title', 'Variable Definitions'));
    main.appendChild(el('div.doc-sub', 'define what the world measures — nothing is hardcoded'));
    const selId = W.gmSel.variables;
    const list = [...(S().variables || [])].sort((a, b) => a.scope.localeCompare(b.scope));
    main.appendChild(this.listPane(list, selId, (id) => { W.gmSel.variables = id; this.draftKey = null; App.renderView(); },
      v => v.label + ' ($' + v.key + ')', v => v.scope, 'New Variable',
      () => { W.gmSel.variables = '__new__'; this.draftKey = null; App.renderView(); }));
    if (!selId) return;
    const isNew = selId === '__new__';
    const source = isNew ? { scope: 'province', key: 'newVariable', label: 'New Variable', format: 'number', default: 0 } : list.find(v => v.id === selId);
    if (!source) return;
    const d = this.getDraft('var:' + selId, source);
    main.appendChild(Views.secLabel(isNew ? 'New Variable' : 'Edit — ' + source.label));
    main.appendChild(el('div.form-grid',
      this.field('Scope', this.sel(d, 'scope', [['province', 'Province'], ['company', 'Company'], ['entity', 'Entity'], ['property', 'Property'], ['global', 'Global']])),
      this.field('Key (used in expressions as $key)', this.text(d, 'key')),
      this.field('Label', this.text(d, 'label')),
      this.field('Format', this.sel(d, 'format', [['number', 'Number'], ['money', 'Money'], ['percent', 'Percent'], ['text', 'Text']])),
      this.field('Default value', this.num(d, 'default'))));
    main.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:9.5px; color:var(--ink-faint); margin-top:10px;' },
      'RENAMING A KEY DOES NOT MIGRATE EXISTING VALUES — SET THEM AGAIN ON EACH OBJECT.'));
    main.appendChild(this.saveBar('variables', d, isNew, d.label));
  },

  /* ═══════════ EVENTS ═══════════ */
  EFFECT_TYPES: [
    ['adjust_var', 'Adjust variable'],
    ['adjust_demo', 'Adjust demographics'],
    ['money', 'Money (deposit / withdraw / transfer)'],
    ['spawn_item', 'Spawn / remove items'],
    ['set_item_value', 'Set item market value'],
    ['transfer_property', 'Transfer property'],
    ['transfer_company', 'Transfer company control'],
    ['adjust_support', 'Adjust party support'],
    ['news', 'Publish news article'],
    ['election', 'Hold general election'],
    ['property_pl', 'Run property income & upkeep'],
    ['log', 'Write timeline entry']
  ],

  effectParams(fx) {
    const grid = el('div.form-grid');
    const F = this;
    const provTargets = this.provOptions([['all', '— all provinces —'], ['random', '— random province —']]);
    const groups = [['all', '— all groups —'], ...(S().settings.demographics.groups || []).map(g => [g, g])];
    const metrics = (S().settings.demographics.metrics || []).map(mDef => [mDef.key, mDef.label]);
    const ops = [['add', 'add (+)'], ['set', 'set (=)'], ['mul', 'multiply (×)']];
    switch (fx.type) {
      case 'adjust_var':
        grid.appendChild(F.field('Scope', F.sel(fx, 'scope', [['province', 'Province'], ['entity', 'Entity'], ['property', 'Property'], ['global', 'Global']], () => App.renderView())));
        if (fx.scope === 'province') grid.appendChild(F.field('Target', F.sel(fx, 'target', provTargets)));
        else if (fx.scope === 'entity') grid.appendChild(F.field('Target', F.sel(fx, 'target', [['all', '— all entities —'], ...F.entOptions()])));
        else if (fx.scope === 'property') grid.appendChild(F.field('Target', F.sel(fx, 'target', [['all', '— all properties —'], ...S().properties.map(p => [p.id, p.name])])));
        grid.appendChild(F.field('Variable key', F.text(fx, 'key', 'gdp')));
        grid.appendChild(F.field('Operation', F.sel(fx, 'op', ops)));
        grid.appendChild(F.field('Value (expression — $key reads the target)', F.text(fx, 'value', '$gdp * 0.001')));
        break;
      case 'adjust_demo':
        grid.appendChild(F.field('Province', F.sel(fx, 'province', provTargets)));
        grid.appendChild(F.field('Group', F.sel(fx, 'group', groups)));
        grid.appendChild(F.field('Metric', F.sel(fx, 'metric', metrics)));
        grid.appendChild(F.field('Operation', F.sel(fx, 'op', ops)));
        grid.appendChild(F.field('Value ($metric = group, $p_var = province)', F.text(fx, 'value', 'rand(-1,1)')));
        break;
      case 'money':
        grid.appendChild(F.field('Kind', F.sel(fx, 'kind', [['deposit', 'Deposit (create money)'], ['withdraw', 'Withdraw (destroy money)'], ['transfer', 'Transfer']], () => App.renderView())));
        if (fx.kind !== 'deposit') grid.appendChild(F.field('From entity', F.sel(fx, 'from', F.entOptions())));
        if (fx.kind !== 'withdraw') grid.appendChild(F.field('To entity', F.sel(fx, 'to', F.entOptions())));
        grid.appendChild(F.field('Amount (expression)', F.text(fx, 'amount', 'rand(10000, 50000)')));
        grid.appendChild(F.field('Memo', F.text(fx, 'memo')));
        break;
      case 'spawn_item':
        grid.appendChild(F.field('Entity', F.sel(fx, 'entity', F.entOptions())));
        grid.appendChild(F.field('Item', F.sel(fx, 'item', F.itemOptions())));
        grid.appendChild(F.field('Quantity (expression, negative removes)', F.text(fx, 'qty', '10')));
        break;
      case 'set_item_value':
        grid.appendChild(F.field('Item', F.sel(fx, 'item', F.itemOptions([['all', '— all items —']]))));
        if (fx.item === 'all') grid.appendChild(F.field('Only category (optional)', F.text(fx, 'category', 'Securities')));
        grid.appendChild(F.field('New value ($value = current)', F.text(fx, 'value', '$value * rand(0.95, 1.05)')));
        break;
      case 'transfer_property':
        grid.appendChild(F.field('Property', F.sel(fx, 'property', S().properties.map(p => [p.id, p.name]))));
        grid.appendChild(F.field('New owner', F.sel(fx, 'to', F.entOptions())));
        break;
      case 'transfer_company':
        grid.appendChild(F.field('Company', F.sel(fx, 'company', F.entOptions(['company']))));
        grid.appendChild(F.field('New controller', F.sel(fx, 'to', F.entOptions())));
        break;
      case 'adjust_support':
        grid.appendChild(F.field('Party', F.sel(fx, 'party', F.entOptions(['party']))));
        grid.appendChild(F.field('Province', F.sel(fx, 'province', provTargets)));
        grid.appendChild(F.field('Group', F.sel(fx, 'group', groups)));
        grid.appendChild(F.field('Support shift (expression)', F.text(fx, 'value', '2')));
        break;
      case 'news':
        grid.appendChild(F.field('Headline ({expressions} interpolate)', F.text(fx, 'headline')));
        grid.appendChild(F.field('Category', F.text(fx, 'category', 'Politics')));
        grid.appendChild(el('div.full', F.field('Body', F.area(fx, 'body'))));
        grid.appendChild(F.check(fx, 'publish', 'Publish immediately (otherwise lands in drafts)'));
        break;
      case 'log':
        grid.appendChild(F.field('Title', F.text(fx, 'title')));
        grid.appendChild(F.field('Detail', F.text(fx, 'detail')));
        break;
    }
    return grid;
  },

  tabEvents(main) {
    main.appendChild(el('div.doc-title', 'Event Engine'));
    main.appendChild(el('div.doc-sub', 'triggers · conditions · effects — the machinery of history'));

    // expression tester
    const exprIn = el('input.text-input', { placeholder: 'test an expression, e.g.  prov(kordi, approval) * 2 + rand(0,5)', style: 'font-family:var(--font-mono); font-size:12px;' });
    const exprOut = el('span', { style: 'font-family:var(--font-mono); font-size:12px; color:var(--accent); white-space:nowrap;' });
    main.appendChild(el('div', { style: 'display:flex; gap:10px; align-items:center; margin-bottom:14px;' }, exprIn,
      el('button.dash-btn', {
        onclick: async () => {
          const r = await POST('/api/gm/test-expr', { expr: exprIn.value });
          exprOut.textContent = r.error ? '✕ ' + r.error : '= ' + (Math.round(r.value * 10000) / 10000);
        }
      }, 'Evaluate'), exprOut));

    const events = S().events || [];
    const selId = W.gmSel.events;
    main.appendChild(this.listPane(events, selId, (id) => { W.gmSel.events = id; this.draftKey = null; App.renderView(); },
      ev => (ev.enabled ? '● ' : '○ ') + ev.name, ev => ev.trigger.type + (ev.runs ? ' · ran ' + ev.runs + '×' : ''), 'New Event',
      () => { W.gmSel.events = '__new__'; this.draftKey = null; App.renderView(); }));
    if (!selId) return;
    const isNew = selId === '__new__';
    const source = isNew
      ? { name: 'New Event', description: '', enabled: true, trigger: { type: 'every_turn' }, conditions: [], effects: [], lastTurn: 0, runs: 0 }
      : events.find(e => e.id === selId);
    if (!source) return;
    const d = this.getDraft('ev:' + selId, source);

    main.appendChild(Views.secLabel(isNew ? 'New Event' : 'Edit — ' + source.name));
    main.appendChild(el('div.form-grid',
      this.field('Name', this.text(d, 'name')),
      this.field('Trigger', this.sel(d.trigger, 'type', [['every_turn', 'Every turn'], ['interval', 'Every N turns'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['date', 'On a specific date'], ['manual', 'Manual only']], () => App.renderView())),
      d.trigger.type === 'interval' ? this.field('N (turns)', this.num(d.trigger, 'n')) : null,
      d.trigger.type === 'date' ? this.field('Date (YYYY-MM-DD)', this.text(d.trigger, 'date')) : null));
    main.appendChild(this.check(d, 'enabled', 'Enabled'));
    main.appendChild(this.field('Description', this.area(d, 'description')));

    main.appendChild(Views.secLabel('Conditions (all must hold)'));
    d.conditions = d.conditions || [];
    d.conditions.forEach((c, i) => {
      main.appendChild(el('div', { style: 'display:flex; gap:8px; align-items:flex-end; margin-bottom:4px;' },
        el('div', { style: 'flex:1' }, this.text(c, 'a', 'prov(kordi, approval)')),
        el('div', { style: 'width:70px' }, this.sel(c, 'op', [['<', '<'], ['<=', '≤'], ['>', '>'], ['>=', '≥'], ['==', '='], ['!=', '≠']])),
        el('div', { style: 'flex:1' }, this.text(c, 'b', '30')),
        el('button.icon-btn', { onclick: () => { d.conditions.splice(i, 1); App.renderView(); } }, '✕')));
    });
    main.appendChild(el('div.btn-row', el('button.dash-btn', { onclick: () => { d.conditions.push({ a: '', op: '>', b: '' }); App.renderView(); } }, '+ Add condition')));

    main.appendChild(Views.secLabel('Effects (run in order)'));
    d.effects = d.effects || [];
    d.effects.forEach((fx, i) => {
      const card = el('div.effect-card');
      card.appendChild(el('div.fx-head',
        el('div', { style: 'flex:1; max-width:340px;' }, this.sel(fx, 'type', this.EFFECT_TYPES, () => App.renderView())),
        el('button.icon-btn', { title: 'Remove effect', onclick: () => { d.effects.splice(i, 1); App.renderView(); } }, '✕')));
      card.appendChild(this.effectParams(fx));
      main.appendChild(card);
    });
    main.appendChild(el('div.btn-row', el('button.dash-btn', { onclick: () => { d.effects.push({ type: 'adjust_var', scope: 'province', target: 'all', op: 'add' }); App.renderView(); } }, '+ Add effect')));

    const bar = this.saveBar('events', d, isNew);
    if (!isNew) {
      bar.insertBefore(el('button.outline-btn', {
        onclick: async () => {
          try { const r = await POST('/api/gm/run-event', { id: d.id }); toast(r.ran ? 'Event executed.' : 'Conditions not met — did not run.'); }
          catch (e) { toast(e.message, true); }
        }
      }, '▸ Run Now'), bar.children[1]);
    }
    main.appendChild(bar);
    main.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:9.5px; color:var(--ink-faint); margin-top:14px; line-height:1.8;' },
      'EXPRESSIONS: numbers, + − × ÷ %, $key (target variable), rand(a,b), round, floor, ceil, abs, min, max, clamp(x,a,b), ',
      'prov(id, key), ent(id, key), item(id), balance(id), g(key), pop(all), turn().'));
  },

  /* ═══════════ POPULATION ═══════════ */
  tabPopulation(main) {
    main.appendChild(el('div.doc-title', 'Population Design'));
    main.appendChild(el('div.doc-sub', 'define the groups the census counts — values live on each province'));
    const s = S().settings.demographics;
    const d = this.getDraft('popcfg', { groups: s.groups.slice(), metrics: JSON.parse(JSON.stringify(s.metrics)) });

    main.appendChild(Views.secLabel('Demographic Groups'));
    d.groups.forEach((g, i) => {
      main.appendChild(el('div', { style: 'display:flex; gap:8px; align-items:center; margin-bottom:4px; max-width:420px;' },
        el('input.text-input', { value: g, oninput: (e) => d.groups[i] = e.target.value }),
        el('button.icon-btn', { onclick: () => { d.groups.splice(i, 1); App.renderView(); } }, '✕')));
    });
    main.appendChild(el('div.btn-row', el('button.dash-btn', { onclick: () => { d.groups.push('New Group'); App.renderView(); } }, '+ Add group')));

    main.appendChild(Views.secLabel('Group Metrics'));
    d.metrics.forEach((mDef, i) => {
      main.appendChild(el('div', { style: 'display:flex; gap:8px; align-items:center; margin-bottom:4px; max-width:640px;' },
        el('input.text-input', { value: mDef.key, style: 'max-width:180px; font-family:var(--font-mono); font-size:12px;', oninput: (e) => mDef.key = e.target.value }),
        el('input.text-input', { value: mDef.label, oninput: (e) => mDef.label = e.target.value }),
        this.sel(mDef, 'format', [['number', 'number'], ['money', 'money'], ['percent', 'percent']]),
        el('button.icon-btn', { onclick: () => { d.metrics.splice(i, 1); App.renderView(); } }, '✕')));
    });
    main.appendChild(el('div.btn-row', el('button.dash-btn', { onclick: () => { d.metrics.push({ key: 'newMetric', label: 'New Metric', format: 'number' }); App.renderView(); } }, '+ Add metric')));

    main.appendChild(el('div.btn-row', { style: 'margin-top:18px;' }, el('button.solid-btn', {
      onclick: async () => {
        try {
          await PATCH('/api/gm/settings', { demographics: { groups: d.groups.filter(Boolean), metrics: d.metrics } });
          this.draftKey = null;
          toast('Census definitions saved.');
        } catch (e) { toast(e.message, true); }
      }
    }, 'Save Definitions')));
    main.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:9.5px; color:var(--ink-faint); margin-top:10px;' },
      'GROUP VALUES ARE EDITED PER PROVINCE UNDER “PROVINCES”. NEW GROUPS START AT ZERO THERE.'));
  },

  /* ═══════════ ROLES & OPERATORS ═══════════ */
  tabRoles(main) {
    main.appendChild(el('div.doc-title', 'Roles & Operators'));
    main.appendChild(el('div.doc-sub', 'who may see what — actions stay generic, information is clearance'));

    if (!W.gmSub2) W.gmSub2 = 'roles';
    main.appendChild(el('div.chip-row',
      el('button.chip', { class: W.gmSub2 === 'roles' ? 'active' : '', onclick: () => { W.gmSub2 = 'roles'; this.draftKey = null; App.renderView(); } }, 'Roles'),
      el('button.chip', { class: W.gmSub2 === 'users' ? 'active' : '', onclick: () => { W.gmSub2 = 'users'; this.draftKey = null; App.renderView(); } }, 'Operator Accounts')));

    if (W.gmSub2 === 'users') return this.usersEditor(main);

    const selId = W.gmSel.roles;
    main.appendChild(this.listPane(S().roles || [], selId, (id) => { W.gmSel.roles = id; this.draftKey = null; App.renderView(); },
      r => r.name, r => (S().users || []).filter(u2 => u2.roleId === r.id).length + ' accounts', 'New Role',
      () => { W.gmSel.roles = '__new__'; this.draftKey = null; App.renderView(); }));
    if (!selId) return;
    const isNew = selId === '__new__';
    const source = isNew
      ? { name: 'New Role', perms: { pages: ['map', 'news', 'timeline'], inventories: 'own', accounts: 'own', companyFinancials: false, government: false, statistics: false, mapLayers: ['political'], manageNews: false, gm: false } }
      : (S().roles || []).find(r => r.id === selId);
    if (!source) return;
    const d = this.getDraft('role:' + selId, source);
    d.perms = d.perms || {};

    main.appendChild(Views.secLabel(isNew ? 'New Role' : 'Edit — ' + source.name));
    main.appendChild(el('div.form-grid', this.field('Role name', this.text(d, 'name'))));

    const PAGES = [['map', 'World Map'], ['parliament', 'Parliament'], ['companies', 'Companies'], ['economy', 'Economy'], ['population', 'Population'], ['news', 'News'], ['timeline', 'Timeline'], ['gm', 'GM Studio']];
    main.appendChild(Views.secLabel('Pages Visible'));
    const pageGrid = el('div.perm-grid');
    d.perms.pages = d.perms.pages || [];
    for (const [pid, plabel] of PAGES) {
      pageGrid.appendChild(el('label',
        el('input', { type: 'checkbox', checked: d.perms.pages.includes(pid), onchange: (e) => { d.perms.pages = e.target.checked ? [...new Set([...d.perms.pages, pid])] : d.perms.pages.filter(x => x !== pid); } }),
        plabel));
    }
    main.appendChild(pageGrid);

    main.appendChild(Views.secLabel('Information Clearance'));
    main.appendChild(el('div.form-grid',
      this.field('Inventories visible', this.sel(d.perms, 'inventories', [['own', 'Own only'], ['all', 'All'], ['none', 'None']])),
      this.field('Bank accounts visible', this.sel(d.perms, 'accounts', [['own', 'Own only'], ['all', 'All'], ['none', 'None']]))));
    const flagGrid = el('div.perm-grid');
    const FLAGS = [['companyFinancials', 'Company financials'], ['government', 'Government information'], ['statistics', 'Statistics & demographics'], ['manageNews', 'Manage the newspaper'], ['gm', 'GAMEMASTER (full control)']];
    for (const [fid, flabel] of FLAGS) {
      flagGrid.appendChild(el('label',
        el('input', { type: 'checkbox', checked: !!d.perms[fid], onchange: (e) => d.perms[fid] = e.target.checked }),
        flabel));
    }
    main.appendChild(flagGrid);

    main.appendChild(Views.secLabel('Map Layers'));
    const layerGrid = el('div.perm-grid');
    d.perms.mapLayers = d.perms.mapLayers || [];
    for (const [lid, llabel] of [['political', 'Political'], ['data', 'Data layers'], ['ownership', 'Ownership'], ['military', 'Military sites']]) {
      layerGrid.appendChild(el('label',
        el('input', { type: 'checkbox', checked: d.perms.mapLayers.includes(lid), onchange: (e) => { d.perms.mapLayers = e.target.checked ? [...new Set([...d.perms.mapLayers, lid])] : d.perms.mapLayers.filter(x => x !== lid); } }),
        llabel));
    }
    main.appendChild(layerGrid);
    main.appendChild(this.saveBar('roles', d, isNew));
  },

  usersEditor(main) {
    main.appendChild(el('div.btn-row', el('button.solid-btn', {
      onclick: () => {
        const nd = { username: '', displayName: '', password: '', roleId: 'citizen', entityId: null };
        openModal('NEW OPERATOR ACCOUNT', el('div',
          el('label.field-label', 'Username'), this.text(nd, 'username'),
          el('label.field-label', 'Display name'), this.text(nd, 'displayName'),
          el('label.field-label', 'Passphrase'), this.text(nd, 'password'),
          el('label.field-label', 'Role'), this.sel(nd, 'roleId', (S().roles || []).map(r => [r.id, r.name])),
          el('label.field-label', 'Linked entity (their persona)'), this.sel(nd, 'entityId', this.entOptions(null, true))
        ), [{ label: 'Create Account', onClick: async () => { await POST('/api/gm/users', nd); toast('Account created.'); } }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }]);
      }
    }, '+ New Operator')));

    main.appendChild(el('table.data',
      el('thead', el('tr', el('th', 'Operator'), el('th', 'Display'), el('th', 'Role'), el('th', 'Persona'), el('th', 'Last Seen'), el('th', ''))),
      el('tbody', (S().users || []).map(u2 => el('tr',
        el('td', { style: 'font-family:var(--font-mono);' }, u2.username),
        el('td', u2.displayName),
        el('td', ((S().roles || []).find(r => r.id === u2.roleId) || {}).name || u2.roleId),
        el('td', u2.entityId ? entName(u2.entityId) : '—'),
        el('td', u2.lastLogin ? new Date(u2.lastLogin).toLocaleDateString() : 'never'),
        el('td',
          el('button.outline-btn', {
            onclick: () => {
              const nd = { displayName: u2.displayName, roleId: u2.roleId, entityId: u2.entityId, password: '' };
              openModal('EDIT — ' + u2.username, el('div',
                el('label.field-label', 'Display name'), this.text(nd, 'displayName'),
                el('label.field-label', 'Role'), this.sel(nd, 'roleId', (S().roles || []).map(r => [r.id, r.name])),
                el('label.field-label', 'Linked entity'), this.sel(nd, 'entityId', this.entOptions(null, true)),
                el('label.field-label', 'New passphrase (blank = keep)'), this.text(nd, 'password')
              ), [{
                label: 'Save', onClick: async () => {
                  const body = { displayName: nd.displayName, roleId: nd.roleId, entityId: nd.entityId };
                  if (nd.password) body.password = nd.password;
                  await PATCH('/api/gm/users/' + u2.id, body);
                  toast('Account updated.');
                }
              }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }]);
            }
          }, 'Edit'),
          ' ',
          el('button.icon-btn', { title: 'Delete', onclick: () => confirmModal('REVOKE ACCESS', `Delete operator “${u2.username}”?`, async () => { await DEL('/api/gm/users/' + u2.id); toast('Revoked.'); }) }, '✕')))))));
  },

  /* ═══════════ DANGER ═══════════ */
  tabDanger(main) {
    main.appendChild(el('div.doc-title', 'Archive & Danger'));
    main.appendChild(el('div.doc-sub', 'export, restore, or burn it all down'));
    main.appendChild(el('div.stage',
      el('div.stage-header', el('span.stage-chapter', 'Archive'), el('span.stage-year', '§1')),
      el('p', { style: 'font-family:var(--font-voice); font-size:15px; line-height:1.6;' }, 'Download the complete world as a single JSON file — every province, account, article and log entry. Keep it somewhere safe; paper burns.'),
      el('div.btn-row', el('a.solid-btn', { href: '/api/gm/export', download: 'arcasia-world.json', style: 'text-decoration:none; display:inline-block;' }, '↓ Export World'))));
    main.appendChild(el('div.stage', { style: 'margin-top:16px;' },
      el('div.stage-header', el('span.stage-chapter', 'Total Reset'), el('span.stage-year', '§2')),
      el('p', { style: 'font-family:var(--font-voice); font-size:15px; line-height:1.6;' }, 'Reset the world to the seed of March 1962. Every change, account and article since is destroyed. Operator accounts are re-seeded too.'),
      el('div.btn-row', el('button.danger-btn', {
        onclick: () => confirmModal('BURN THE ARCHIVE', 'Reset the entire world to the 1962 seed? This cannot be undone (export first).', async () => {
          await POST('/api/gm/reset');
          toast('The world begins again. 1962.');
        }, 'Reset Everything')
      }, '⚠ Reset World'))));
  }
};
