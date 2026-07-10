'use strict';
/* GM Studio: visual editors for every collection. No SQL, no code. */

// Phase 13 — quick-start templates so a GM can stand up a producing property or
// a new item in one click. Property patches reference the default commodity
// items; if an item is missing in a custom world the GM just repicks it.
const PROP_TEMPLATES = [
  ['', '— start from a template —'],
  ['factory', 'Factory — produces a good'],
  ['mine', 'Mine — produces ore'],
  ['oil', 'Oil field — produces crude'],
  ['refinery', 'Refinery — produces fuel'],
  ['farm', 'Farm — produces grain'],
  ['casino', 'Casino — generates cash'],
  ['office', 'Office / HQ — generates cash'],
  ['bank', 'Bank — generates cash'],
  ['port', 'Port / infrastructure — cash'],
  ['residential', 'Residential — upkeep only'],
  ['govbuilding', 'Government building — upkeep only']
];
const PROP_TEMPLATE_PATCH = {
  factory: { type: 'industrial', kind: 'factory', prodMode: 'goods', produces: [{ itemId: 'item_radio', perTurn: 100 }], expenses: 5000, employees: 800 },
  mine: { type: 'industrial', kind: 'mine', prodMode: 'goods', produces: [{ itemId: 'item_ore', perTurn: 150 }], expenses: 4000, employees: 600 },
  oil: { type: 'industrial', kind: 'mine', prodMode: 'goods', produces: [{ itemId: 'item_crude', perTurn: 3000 }], expenses: 6000, employees: 700 },
  refinery: { type: 'industrial', kind: 'factory', prodMode: 'goods', produces: [{ itemId: 'item_fuel', perTurn: 1500 }], expenses: 7000, employees: 900 },
  farm: { type: 'agricultural', kind: 'farm', prodMode: 'goods', produces: [{ itemId: 'item_grain', perTurn: 200 }], expenses: 1500, employees: 500 },
  casino: { type: 'commercial', kind: 'office', prodMode: 'cash', produces: [], cashPerTurn: 10000, expenses: 4500, employees: 650 },
  office: { type: 'commercial', kind: 'office', prodMode: 'cash', produces: [], cashPerTurn: 6000, expenses: 3000, employees: 400 },
  bank: { type: 'commercial', kind: 'bank', prodMode: 'cash', produces: [], cashPerTurn: 8000, expenses: 2000, employees: 450 },
  port: { type: 'infrastructure', kind: 'port', prodMode: 'cash', produces: [], cashPerTurn: 5000, expenses: 3000, employees: 800 },
  residential: { type: 'residential', kind: 'house', prodMode: 'none', produces: [], cashPerTurn: 0, expenses: 2, employees: 0 },
  govbuilding: { type: 'government', kind: 'government', prodMode: 'none', produces: [], cashPerTurn: 0, expenses: 4000, employees: 500 }
};
const ITEM_TEMPLATES = [
  ['', '— start from a template —'],
  ['commodity', 'Commodity (raw material)'],
  ['consumer', 'Consumer good'],
  ['industrial', 'Industrial good'],
  ['military', 'Military hardware'],
  ['reserve', 'Reserve / bullion']
];
const ITEM_TEMPLATE_PATCH = {
  commodity: { category: 'Commodities', tradable: true, marketValue: 10, icon: 'C' },
  consumer: { category: 'Goods', tradable: true, marketValue: 50, icon: 'G' },
  industrial: { category: 'Goods', tradable: true, marketValue: 200, icon: 'I' },
  military: { category: 'Military', tradable: false, marketValue: 5000, icon: 'M' },
  reserve: { category: 'Reserves', tradable: true, marketValue: 1000, icon: 'R' }
};

// Ready-made whole-event templates. Picking one fills in the trigger and a set
// of sensible effects the GM can then tweak — so a GM never has to write a
// formula from a blank card. Each patch is a full event body (minus id/runs).
const EVENT_TEMPLATES = [
  ['', '— start from a template —'],
  ['boom', 'Economic boom (monthly)'],
  ['recession', 'Recession (monthly)'],
  ['scandal', 'Government scandal'],
  ['popularity', 'Popularity surge'],
  ['aid', 'Foreign aid windfall'],
  ['disaster', 'Natural disaster (random province)'],
  ['price_shock', 'Commodity price shock'],
  ['babyboom', 'Baby boom'],
  ['unrest', 'Civil unrest (conditional)']
];
const EVENT_TEMPLATE_PATCH = {
  boom: {
    name: 'Economic boom', description: 'A broad upswing lifts output and mood.',
    trigger: { type: 'monthly' }, conditions: [],
    effects: [
      { type: 'adjust_var', scope: 'global', op: 'mul', key: 'gdp', value: '1.02' },
      { type: 'adjust_var', scope: 'province', target: 'all', op: 'add', key: 'happiness', value: 'rand(0.5, 1.5)' },
      { type: 'adjust_var', scope: 'province', target: 'all', op: 'add', key: 'employment', value: 'rand(0.2, 0.8)' },
      { type: 'news', headline: 'Economy surges as output climbs', category: 'Economy', body: 'Factories and ports report a busy month across the Republic.', publish: true }
    ]
  },
  recession: {
    name: 'Recession', description: 'A downturn drags on growth and jobs.',
    trigger: { type: 'monthly' }, conditions: [],
    effects: [
      { type: 'adjust_var', scope: 'global', op: 'mul', key: 'gdp', value: '0.98' },
      { type: 'adjust_var', scope: 'province', target: 'all', op: 'add', key: 'employment', value: 'rand(-1.2, -0.4)' },
      { type: 'adjust_var', scope: 'province', target: 'all', op: 'add', key: 'happiness', value: 'rand(-1.5, -0.5)' },
      { type: 'news', headline: 'Downturn bites as growth stalls', category: 'Economy', body: 'Businesses warn of a harder quarter ahead.', publish: true }
    ]
  },
  scandal: {
    name: 'Government scandal', description: 'A scandal dents public approval.',
    trigger: { type: 'manual' }, conditions: [],
    effects: [
      { type: 'adjust_var', scope: 'province', target: 'all', op: 'add', key: 'approval', value: 'rand(-6, -2)' },
      { type: 'news', headline: 'Scandal engulfs the government', category: 'Politics', body: 'Revelations dominate the front pages and the order paper.', publish: true }
    ]
  },
  popularity: {
    name: 'Popularity surge', description: 'A win for the government lifts approval.',
    trigger: { type: 'manual' }, conditions: [],
    effects: [
      { type: 'adjust_var', scope: 'province', target: 'all', op: 'add', key: 'approval', value: 'rand(2, 6)' },
      { type: 'news', headline: 'Government rides a wave of goodwill', category: 'Politics', body: 'Ministers enjoy a rare stretch of favourable coverage.', publish: true }
    ]
  },
  aid: {
    name: 'Foreign aid windfall', description: 'An ally wires funds to the treasury.',
    trigger: { type: 'manual' }, conditions: [],
    effects: [
      { type: 'money', kind: 'deposit', to: 'ent_gov', amount: 'rand(20000000, 80000000)', memo: 'Foreign aid grant' },
      { type: 'news', headline: 'Ally pledges major aid package', category: 'Foreign', body: 'The funds are earmarked for the budget.', publish: true }
    ]
  },
  disaster: {
    name: 'Natural disaster', description: 'A disaster strikes one province at random.',
    trigger: { type: 'manual' }, conditions: [],
    effects: [
      { type: 'adjust_var', scope: 'province', target: 'random', op: 'add', key: 'happiness', value: 'rand(-8, -3)' },
      { type: 'adjust_var', scope: 'province', target: 'random', op: 'add', key: 'infrastructure', value: 'rand(-6, -2)' },
      { type: 'news', headline: 'Disaster strikes a province', category: 'Regional', body: 'Emergency crews are on the scene; damage is being assessed.', publish: true }
    ]
  },
  price_shock: {
    name: 'Commodity price shock', description: 'Prices of a whole category jump.',
    trigger: { type: 'manual' }, conditions: [],
    effects: [
      { type: 'set_item_value', item: 'all', category: 'Commodities', value: '$value * rand(1.1, 1.4)' },
      { type: 'news', headline: 'Commodity prices spike', category: 'Economy', body: 'Traders scramble as raw material costs climb.', publish: true }
    ]
  },
  babyboom: {
    name: 'Baby boom', description: 'Population growth across the classes.',
    trigger: { type: 'monthly' }, conditions: [],
    effects: [
      { type: 'adjust_demo', province: 'all', group: 'all', metric: 'population', op: 'mul', value: '1.004' }
    ]
  },
  unrest: {
    name: 'Civil unrest', description: 'When approval falls too low, unrest spreads.',
    trigger: { type: 'every_turn' },
    conditions: [{ a: 'g(avgApproval)', op: '<', b: '35' }],
    effects: [
      { type: 'adjust_var', scope: 'province', target: 'all', op: 'add', key: 'happiness', value: 'rand(-1.5, -0.3)' },
      { type: 'adjust_var', scope: 'province', target: 'all', op: 'add', key: 'crime', value: 'rand(0.3, 1.2)' },
      { type: 'news', headline: 'Unrest spreads amid discontent', category: 'Politics', body: 'Protests are reported in several provinces.', publish: false }
    ]
  }
};

// Ready-made variable definitions — pick one and just rename if wanted.
const VAR_TEMPLATES = [
  ['', '— start from a template —'],
  ['prov_pct', 'Province percentage metric (0–100)'],
  ['prov_index', 'Province index (arbitrary number)'],
  ['global_money', 'Global money figure'],
  ['global_pct', 'Global percentage'],
  ['company_num', 'Company number'],
  ['entity_flag', 'Entity flag (0/1)']
];
const VAR_TEMPLATE_PATCH = {
  prov_pct: { scope: 'province', key: 'newMetric', label: 'New Metric', format: 'percent', default: 50 },
  prov_index: { scope: 'province', key: 'newIndex', label: 'New Index', format: 'number', default: 0 },
  global_money: { scope: 'global', key: 'newFund', label: 'New Fund', format: 'money', default: 0 },
  global_pct: { scope: 'global', key: 'newRate', label: 'New Rate', format: 'percent', default: 0 },
  company_num: { scope: 'company', key: 'newFigure', label: 'New Figure', format: 'number', default: 0 },
  entity_flag: { scope: 'entity', key: 'newFlag', label: 'New Flag', format: 'number', default: 0 }
};

const GM = {
  draft: null, draftKey: null,

  TABS: [
    ['world', 'World & Time'],
    ['provinces', 'Provinces'],
    ['mapobjects', 'Cities & Properties'],
    ['registry', 'Entity Registry'],
    ['economy', 'Money & Accounts'],
    ['assets', 'Assets & Ownership'],
    ['items', 'Items & Market'],
    ['trade', 'Trade Desk'],
    ['variables', 'Variables'],
    ['events', 'Event Engine'],
    ['population', 'Population'],
    ['presentation', 'Presentation'],
    ['roles', 'Roles & Operators'],
    ['danger', 'Archive & Danger']
  ],

  render(container) {
    // Every sync (turn tick, another player's action) rebuilds the whole
    // studio, which used to snap the GM's scroll back to the top of whatever
    // long form they were editing. Carry the previous offset across.
    const prevMain = container.querySelector('.gm-main');
    const scrollTop = prevMain ? prevMain.scrollTop : 0;
    clear(container);
    // a re-render discards whatever DOM the expression popover (Phase 8) was
    // anchored to — drop the stale refs rather than leaving a dangling
    // mousedown listener on document.
    if (this._exprPopDoc) { document.removeEventListener('mousedown', this._exprPopDoc, true); }
    this._exprPop = null; this._exprPopDoc = null; this._exprPopFor = null;
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
      registry: this.tabRegistry, economy: this.tabEconomy, assets: this.tabAssets, items: this.tabItems,
      trade: this.tabTrade,
      variables: this.tabVariables, events: this.tabEvents, population: this.tabPopulation,
      presentation: this.tabPresentation,
      roles: this.tabRoles, danger: this.tabDanger
    }[W.gmTab] || this.tabWorld;
    fn.call(this, main);
    if (scrollTop) main.scrollTop = scrollTop;
  },

  /* ---------- form helpers (bind into a draft object) ----------
     These live in core.js as `Forms` so the inspector's inline edit mode
     (views.js) can share them. Thin aliases kept here so every existing
     `this.field(...)` etc. call site in this file keeps working unchanged. */
  field: Forms.field,
  text: Forms.text,
  num: Forms.num,
  area: Forms.area,
  check: Forms.check,
  sel: Forms.sel,
  color: Forms.color,
  entOptions: Forms.entOptions,
  provOptions: Forms.provOptions,
  itemOptions: Forms.itemOptions,

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
    // Share certificates (meta.companyId) and property deeds (meta.propertyId)
    // are driven by the Share Register / Properties — editing them here would
    // just be overwritten by syncAllCertificates/syncAllDeeds on save. Hide
    // them from the picker and from the rows, and point the GM at the register.
    const isDriven = (id) => { const it = S().items.find(x => x.id === id); return !!(it && it.meta && (it.meta.companyId || it.meta.propertyId)); };
    const opts = this.itemOptions().filter(([id]) => !isDriven(id));
    draft.inventory.forEach((row, i) => {
      if (isDriven(row.itemId)) return; // managed via Share Register / deeds
      box.appendChild(el('div', { style: 'display:flex; gap:10px; align-items:flex-end; margin-bottom:4px;' },
        el('div', { style: 'flex:1' }, this.sel(row, 'itemId', opts)),
        el('div', { style: 'width:110px' }, this.num(row, 'qty')),
        el('button.icon-btn', { onclick: () => { draft.inventory.splice(i, 1); App.renderView(); } }, '✕')));
    });
    const first = opts[0] && opts[0][0];
    box.appendChild(el('div.btn-row', el('button.dash-btn', {
      onclick: () => { if (first) { draft.inventory.push({ itemId: first, qty: 1 }); App.renderView(); } }
    }, '+ Add item')));
    box.appendChild(el('div', { style: 'font-size:11px; color:var(--ink-faint); margin-top:4px;' },
      'Assign shares via the Share Register; property deeds are issued automatically.'));
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
      newsTx: s.newsThresholds.transaction,
      // Taxation lives in the same draft object (not a second getDraft() key)
      // because tabWorld's single-slot draft cache is keyed on one string —
      // two live keys in the same render would thrash each other's cache on
      // every re-render (e.g. on 'sync' broadcasts) and drop unsaved edits.
      taxEnabled: (s.taxation || {}).enabled || false,
      taxCorporateRate: (s.taxation || {}).corporateRate || 0,
      taxPropertyRate: (s.taxation || {}).propertyRate || 0
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

    main.appendChild(Views.secLabel('Taxation'));
    d.taxVatRate = d.taxVatRate === undefined ? ((s.taxation || {}).vatRate || 0) : d.taxVatRate;
    d.taxGamblingRate = d.taxGamblingRate === undefined ? ((s.taxation || {}).gamblingRate || 0) : d.taxGamblingRate;
    main.appendChild(this.check(d, 'taxEnabled', 'Enable taxation (corporate/property monthly; VAT & gambling duty on every transaction)'));
    main.appendChild(el('div.form-grid',
      this.field('Corporate tax rate (%)', this.num(d, 'taxCorporateRate')),
      this.field('Property tax rate (%)', this.num(d, 'taxPropertyRate')),
      this.field('VAT on purchases (%)', this.num(d, 'taxVatRate')),
      this.field('Gambling duty (%)', this.num(d, 'taxGamblingRate'))));
    main.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px; margin-top:4px;' },
      'Corporate/property tax is collected monthly from net property income. VAT is added to market purchases; gambling duty skims the casinos’ winnings. All flow into the Federal Treasury (raising it, shrinking the money supply).'));
    main.appendChild(el('div.btn-row', { style: 'margin-top:14px;' }, el('button.solid-btn', {
      onclick: async () => {
        try {
          await PATCH('/api/gm/settings', {
            taxation: { enabled: !!d.taxEnabled, corporateRate: Number(d.taxCorporateRate) || 0, propertyRate: Number(d.taxPropertyRate) || 0, vatRate: Number(d.taxVatRate) || 0, gamblingRate: Number(d.taxGamblingRate) || 0 }
          });
          toast('Taxation settings saved.');
        } catch (e) { toast(e.message, true); }
      }
    }, 'Save Taxation')));

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
      ? { name: 'New Province', color: '#8a8a6a', description: '', shape: 'M1750 950 L2100 900 L2200 1120 L1900 1220 Z', labelPos: [1960, 1040], labelRot: 0, labelSize: 60, vars: {}, demographics: {} }
      : provById(selId);
    if (!source) return;
    const d = this.getDraft('prov:' + selId, source);
    if (d.shapeText === undefined) d.shapeText = d.shape || (d.path || []).map(p => p.join(',')).join(' ');

    main.appendChild(Views.secLabel(isNew ? 'New Province' : 'Edit — ' + source.name));
    main.appendChild(el('div.form-grid',
      this.field('Name', this.text(d, 'name')),
      this.field('Map colour', this.color(d, 'color')),
      this.field('Label position "x,y"', el('input.text-input', { value: (d.labelPos || []).join(','), oninput: (e) => d.labelPos = e.target.value.split(',').map(Number) })),
      this.field('Capital city', this.sel(d, 'capital', [['__null__', '— none —'], ...S().cities.map(c => [c.id, c.name])])),
      this.field('Label rotation (°)', this.num(d, 'labelRot')),
      this.field('Label size', this.num(d, 'labelSize'))));
    main.appendChild(this.field('Description', this.area(d, 'description')));
    main.appendChild(this.field('Boundary — SVG path data ("M x y L x y … Z") or points "x,y x,y …" on the 3840×2160 map grid', this.area(d, 'shapeText', 'min-height:64px; font-family:var(--font-mono); font-size:11px;')));
    main.appendChild(this.varsEditor(d, 'province'));

    // demographics — one metric at a time (the old grid crammed every metric
    // into one table and was unreadable). Chips switch the visible metric.
    main.appendChild(Views.secLabel('Demographics'));
    d.demographics = d.demographics || {};
    const groups = S().settings.demographics.groups || [];
    const metrics = S().settings.demographics.metrics || [];
    if (!W.gmDemoMetric || !metrics.some(mDef => mDef.key === W.gmDemoMetric)) W.gmDemoMetric = (metrics[0] || {}).key;
    const metricBar = el('div.chip-row');
    for (const mDef of metrics) {
      metricBar.appendChild(el('button.chip', {
        class: W.gmDemoMetric === mDef.key ? 'active' : '',
        onclick: () => { W.gmDemoMetric = mDef.key; App.renderView(); }
      }, mDef.label));
    }
    main.appendChild(metricBar);
    const mSel = metrics.find(mDef => mDef.key === W.gmDemoMetric) || metrics[0];
    if (mSel) {
      const tbody = el('tbody');
      for (const gname of groups) {
        d.demographics[gname] = d.demographics[gname] || {};
        const grp = d.demographics[gname];
        tbody.appendChild(el('tr',
          el('td', gname),
          el('td.num', el('input', {
            value: grp[mSel.key] ?? 0,
            oninput: (e) => grp[mSel.key] = Number(e.target.value) || 0
          }))));
      }
      main.appendChild(el('table.data.demo-table', { style: 'max-width:440px;' },
        el('thead', el('tr', el('th', 'Group'), el('th.num', mSel.label))), tbody));
    }

    // voter base — scripted party support for this province. When any
    // percentage is set (> 0), elections and polling use exactly this split
    // for the province instead of the demographic simulation.
    main.appendChild(Views.secLabel('Voter Base'));
    main.appendChild(el('div', { style: 'font-size:12px; color:var(--ink-faint); margin-bottom:8px;' },
      'Party support in this province, in percent (e.g. KFF 60). Leave everything at 0 to let the demographic simulation decide — the greyed value beside each party is what the demographics currently poll at. Percentages are normalised, so they don’t have to add to 100.'));
    d.voterBase = d.voterBase || {};
    const parties = S().entities.filter(e => e.type === 'party');
    const polled = (W.polling && W.polling.byProvince && W.polling.byProvince[selId]) || {};
    const vbGrid = el('div.form-grid');
    for (const pt of parties) {
      const hint = polled[pt.id] !== undefined ? 'polling ' + polled[pt.id] + '%' : null;
      vbGrid.appendChild(this.field((pt.abbrev || pt.name) + (hint ? ' — ' + hint : ''), el('input.text-input', {
        type: 'number', min: '0', max: '100', step: '1', value: d.voterBase[pt.id] ?? 0,
        oninput: (e) => { const v = Number(e.target.value) || 0; if (v > 0) d.voterBase[pt.id] = v; else delete d.voterBase[pt.id]; }
      })));
    }
    main.appendChild(vbGrid);

    const bar = this.saveBar('provinces', d, isNew);
    bar.firstChild.addEventListener('click', () => {
      const txt = String(d.shapeText || '').trim();
      if (/^[Mm]/.test(txt)) {
        // SVG path data
        d.shape = txt;
        d.path = null;
      } else if (txt) {
        // legacy "x,y x,y …" polygon
        try { d.path = txt.split(/\s+/).map(pair => pair.split(',').map(Number)).filter(p => p.length === 2 && !p.some(isNaN)); } catch (e) { }
        d.shape = null;
      }
      delete d.shapeText;
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
    const source = isNew ? { name: 'New City', provinceId: S().provinces[0] && S().provinces[0].id, pos: [1900, 1000], size: 1, isCapital: false, description: '' } : cityById(selId);
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
      ? { name: 'New Property', type: 'commercial', kind: 'office', provinceId: S().provinces[0] && S().provinces[0].id, pos: [1900, 1000], ownerId: null, value: 100000, employees: 0, income: 0, expenses: 0, prodMode: 'none', produces: [], cashPerTurn: 0, description: '', inventory: [], vars: {} }
      : propById(selId);
    if (!source) return;
    const d = this.getDraft('prop:' + selId, source);
    main.appendChild(Views.secLabel(isNew ? 'New Property' : 'Edit — ' + source.name));
    // one-click template (prefills category/kind/production)
    main.appendChild(this.field('Template', this.sel({ _t: '' }, '_t', PROP_TEMPLATES, (v) => {
      if (v && PROP_TEMPLATE_PATCH[v]) { Object.assign(d, JSON.parse(JSON.stringify(PROP_TEMPLATE_PATCH[v]))); App.renderView(); }
    }), 'Fills in category, kind and production — you can still tweak everything below.'));
    main.appendChild(el('div.form-grid',
      this.field('Name', this.text(d, 'name')),
      this.field('Owner', this.sel(d, 'ownerId', this.entOptions(null, true))),
      this.field('Category', this.sel(d, 'type', [['residential', 'Residential'], ['commercial', 'Commercial'], ['industrial', 'Industrial'], ['agricultural', 'Agricultural'], ['government', 'Government'], ['military', 'Military'], ['infrastructure', 'Infrastructure']])),
      this.field('Kind (marker glyph)', this.sel(d, 'kind', Object.keys(KIND_GLYPH).map(k => [k, k.replace('_', ' ') + ' [' + KIND_GLYPH[k] + ']']))),
      this.field('Province', this.sel(d, 'provinceId', this.provOptions())),
      this.field('Position', this.placeButton(d, d.name)),
      this.field('Assessed value', this.num(d, 'value')),
      this.field('Employees', this.num(d, 'employees'))));
    main.appendChild(this.field('Description', this.area(d, 'description')));
    main.appendChild(this.productionEditor(d));
    main.appendChild(this.varsEditor(d, 'property'));
    main.appendChild(this.inventoryEditor(d));
    main.appendChild(this.saveBar('properties', d, isNew));
  },

  /* Production section (Phase 13). A property either mints goods (its owner
     sells them) or generates cash. For goods, the GM enters a target revenue
     and the units/turn are back-calculated from the item's market value. */
  productionEditor(d) {
    const F = this;
    const box = el('div');
    box.appendChild(Views.secLabel('Production (per turn)'));
    box.appendChild(el('div', { style: 'font-size:12px; color:var(--ink-faint); margin-bottom:8px;' },
      'Runs every turn. “Produces goods” mints items into this property’s stock for the owner to sell; “Generates cash” pays money directly (casinos, banks, offices). Enter a target revenue and the units/turn are computed from the item price.'));
    if (d.prodMode === undefined) d.prodMode = (d.produces && d.produces.length) ? 'goods' : (d.cashPerTurn ? 'cash' : 'none');
    box.appendChild(this.field('Mode', this.sel(d, 'prodMode',
      [['none', 'Nothing (upkeep only)'], ['goods', 'Produces goods'], ['cash', 'Generates cash']], () => App.renderView())));

    if (d.prodMode === 'goods') {
      const goods = S().items.filter(i => !['Securities', 'Deeds', 'Honours'].includes(i.category));
      d.produces = (d.produces && d.produces.length) ? d.produces : [{ itemId: (goods[0] || {}).id, perTurn: 1 }];
      d.produces.forEach((row, i) => {
        const priceNow = () => { const it = itemById(row.itemId); return it ? (it.marketValue || 0) : 0; };
        const unitOut = el('span', { style: 'font-family:var(--font-mono); font-size:11px; color:var(--ink-soft); padding-bottom:9px; white-space:nowrap;' }, '≈ ' + fmtNum(row.perTurn || 0) + '/turn');
        const revInput = el('input.text-input', {
          type: 'number', value: Math.round((row.perTurn || 0) * priceNow()),
          oninput: (e) => { const rev = Number(e.target.value) || 0; row.perTurn = priceNow() > 0 ? Math.max(0, Math.round(rev / priceNow())) : 0; unitOut.textContent = '≈ ' + fmtNum(row.perTurn) + '/turn'; }
        });
        box.appendChild(el('div', { style: 'display:flex; gap:10px; align-items:flex-end; margin-bottom:6px; flex-wrap:wrap;' },
          el('div', { style: 'flex:1 1 180px' }, F.field('Item produced', F.sel(row, 'itemId', goods.map(it => [it.id, it.name + ' (' + CUR() + fmtNum(it.marketValue) + ')']), () => App.renderView()))),
          el('div', { style: 'flex:1 1 150px' }, F.field('Target revenue / turn (' + CUR() + ')', revInput)),
          unitOut,
          el('button.icon-btn', { style: 'padding-bottom:8px;', onclick: () => { d.produces.splice(i, 1); App.renderView(); } }, '✕')));
      });
      box.appendChild(el('div.btn-row', el('button.dash-btn', {
        onclick: () => { const goods = S().items.filter(i => !['Securities', 'Deeds', 'Honours'].includes(i.category)); d.produces.push({ itemId: (goods[0] || {}).id, perTurn: 1 }); App.renderView(); }
      }, '+ Add produced item')));
    } else if (d.prodMode === 'cash') {
      box.appendChild(el('div.form-grid', this.field('Cash generated / turn (' + CUR() + ')', this.num(d, 'cashPerTurn'))));
    }
    box.appendChild(el('div.form-grid', this.field('Upkeep / turn (' + CUR() + ')', this.num(d, 'expenses'),
      'Wages + running costs debited from the owner each turn. Public buildings with no output are valued at this cost in GDP.')));
    return box;
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
      }, CUR() + ' Mint / Destroy'),
      el('button.dash-btn', { onclick: () => Views.transferModal() }, '⇄ Transfer')));

    main.appendChild(Views.secLabel('All Accounts'));
    main.appendChild(el('table.data',
      el('thead', el('tr', el('th', 'Holder'), el('th', 'Account'), el('th.num', 'Balance'), el('th', ''))),
      el('tbody', [...S().accounts].sort((a, b) => b.balance - a.balance).map(a => el('tr',
        el('td', entName(a.ownerId)), el('td', a.name), el('td.num', fmtMoney(a.balance)),
        el('td', el('button.icon-btn', { title: 'Close account', onclick: () => this.deleteColl('accounts', a.id, a.name) }, '✕')))))));
  },

  /* ═══════════ ASSETS & OWNERSHIP (Workstream C) ═══════════
     A single desk for moving items, assigning/transferring shares and
     reassigning company/property control — the ergonomic twin of Money &
     Accounts, so a GM never has to hand-edit an entity record for these. Every
     action hits a small /api/gm/* route that store.save()s + broadcasts and
     runs the relevant reconciliation (syncAllCertificates / syncAllDeeds). */
  tabAssets(main) {
    main.appendChild(el('div.doc-title', 'Assets & Ownership'));
    main.appendChild(el('div.doc-sub', 'move items, assign shares and reassign control — no record-editing required'));

    const ents = S().entities;
    const companies = ents.filter(e => e.type === 'company' && e.sharesOutstanding);

    // ---- Item transfer ----
    main.appendChild(Views.secLabel('Move an Item'));
    const it = this._assetItem || (this._assetItem = { fromEntityId: (ents[0] || {}).id, toEntityId: (ents[1] || {}).id, itemId: (S().items[0] || {}).id, qty: 1 });
    main.appendChild(el('div.form-grid',
      this.field('From holder', this.sel(it, 'fromEntityId', this.entOptions())),
      this.field('To holder', this.sel(it, 'toEntityId', this.entOptions())),
      this.field('Item', this.sel(it, 'itemId', this.itemOptions())),
      this.field('Quantity', this.num(it, 'qty'))));
    main.appendChild(el('div.btn-row', el('button.solid-btn', {
      onclick: async () => { try { await POST('/api/gm/give-item', it); toast('Item moved.'); } catch (e) { toast(e.message, true); } }
    }, 'Move Item')));

    // ---- Share transfer / assignment ----
    main.appendChild(Views.secLabel('Assign / Transfer Shares'));
    const sh = this._assetShare || (this._assetShare = { companyId: (companies[0] || {}).id, fromEntityId: 'float', toEntityId: (ents[0] || {}).id, shares: 1 });
    const holderOpts = [['float', '— Float (Exchange) —'], ...this.entOptions()];
    main.appendChild(el('div.form-grid',
      this.field('Company', this.sel(sh, 'companyId', companies.map(c => [c.id, c.name]), () => App.renderView())),
      this.field('From', this.sel(sh, 'fromEntityId', holderOpts)),
      this.field('To', this.sel(sh, 'toEntityId', holderOpts)),
      this.field('Shares', this.num(sh, 'shares'))));
    const co = entById(sh.companyId);
    if (co) {
      const pool = market_treasuryPoolClient(co);
      main.appendChild(el('div', { style: 'font-size:11px; color:var(--ink-soft); margin:2px 0 8px; font-family:var(--font-mono);' },
        'Outstanding ' + fmtNum(co.sharesOutstanding) + ' · Float ' + fmtNum(pool) +
        ((co.shareholders || []).length ? ' · ' + (co.shareholders || []).map(s => entName(s.entityId) + ' ' + fmtNum(s.shares)).join(' · ') : '')));
    }
    main.appendChild(el('div.btn-row', el('button.solid-btn', {
      onclick: async () => { try { await POST('/api/gm/set-holding', sh); toast('Shares reassigned.'); } catch (e) { toast(e.message, true); } }
    }, 'Assign Shares')));

    // ---- Company ownership ----
    main.appendChild(Views.secLabel('Company Ownership'));
    const ownCo = entById(W.gmAssetCo) || companies[0];
    if (ownCo) {
      const draft = (this._assetOwn && this._assetOwn.id === ownCo.id) ? this._assetOwn
        : (this._assetOwn = { id: ownCo.id, ownerId: ownCo.ownerId || '', ceoId: ownCo.ceoId || '' });
      main.appendChild(el('div.form-grid',
        this.field('Company', this.sel({ v: ownCo.id }, 'v', companies.map(c => [c.id, c.name]), (v) => { W.gmAssetCo = v; this._assetOwn = null; App.renderView(); })),
        this.field('Owner', this.sel(draft, 'ownerId', this.entOptions())),
        this.field('CEO', this.sel(draft, 'ceoId', this.entOptions()))));
      main.appendChild(el('div.btn-row', el('button.solid-btn', {
        onclick: async () => {
          try {
            await PATCH('/api/gm/coll/entities/' + ownCo.id, { ownerId: draft.ownerId, ceoId: draft.ceoId });
            this._assetOwn = null; toast('Ownership updated.');
          } catch (e) { toast(e.message, true); }
        }
      }, 'Save Ownership')));
    }

    // ---- Property ownership ----
    main.appendChild(Views.secLabel('Property Ownership'));
    const props = S().properties || [];
    if (props.length) {
      const prop = props.find(p => p.id === W.gmAssetProp) || props[0];
      const pd = (this._assetProp && this._assetProp.id === prop.id) ? this._assetProp
        : (this._assetProp = { id: prop.id, ownerId: prop.ownerId || '' });
      main.appendChild(el('div.form-grid',
        this.field('Property', this.sel({ v: prop.id }, 'v', props.map(p => [p.id, p.name]), (v) => { W.gmAssetProp = v; this._assetProp = null; App.renderView(); })),
        this.field('Owner', this.sel(pd, 'ownerId', this.entOptions()))));
      main.appendChild(el('div.btn-row', el('button.solid-btn', {
        onclick: async () => {
          try { await PATCH('/api/gm/coll/properties/' + prop.id, { ownerId: pd.ownerId }); this._assetProp = null; toast('Property reassigned.'); }
          catch (e) { toast(e.message, true); }
        }
      }, 'Save Property Owner')));
    }
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
    main.appendChild(this.field('Template', this.sel({ _t: '' }, '_t', ITEM_TEMPLATES, (v) => {
      if (v && ITEM_TEMPLATE_PATCH[v]) { Object.assign(d, JSON.parse(JSON.stringify(ITEM_TEMPLATE_PATCH[v]))); App.renderView(); }
    }), 'Fills in category, tradability and a starting market value.'));
    main.appendChild(el('div.form-grid',
      this.field('Name', this.text(d, 'name')),
      this.field('Category', this.text(d, 'category')),
      this.field('Market value (' + CUR() + ')', this.num(d, 'marketValue')),
      this.field('Icon (emoji, a letter, or an icon name)', this.text(d, 'icon'), 'e.g. 🛢, R, or one of: ' + (typeof ICON_MANIFEST !== 'undefined' ? ICON_MANIFEST.join(', ') : ''))));
    main.appendChild(this.check(d, 'tradable', 'Tradable between entities'));
    main.appendChild(this.field('Description', this.area(d, 'description')));
    main.appendChild(this.field('Metadata (JSON)', el('textarea.text-input', {
      style: 'font-family:var(--font-mono); font-size:11px;',
      oninput: (e) => { try { d.meta = JSON.parse(e.target.value || '{}'); e.target.style.borderColor = ''; } catch (x) { e.target.style.borderColor = 'var(--accent)'; } }
    }, JSON.stringify(d.meta || {}))));
    main.appendChild(this.saveBar('items', d, isNew));
  },

  /* ═══════════ TRADE DESK (Phase 13) ═══════════
     Edits settings.trade: what the government pays companies for goods routed
     to it, and the foreign partners it resells to (per-item price + tariff +
     the net-balance figure shown in the player Trade table). Saved as one whole
     object; the server merges it so the engine's live flow history survives. */
  saveTrade(d) {
    PATCH('/api/gm/settings', { trade: d })
      .then(() => { this.draftKey = null; toast('Trade desk saved.'); })
      .catch(e => toast(e.message, true));
  },
  tabTrade(main) {
    const F = this;
    const s = S().settings;
    const trade = this.getDraft('trade', s.trade || { partners: [], lastFlows: [], history: [] });
    trade.partners = trade.partners || [];

    main.appendChild(el('div.doc-title', 'Trade Desk'));
    main.appendChild(el('div.doc-sub', 'foreign partners · what they buy & sell · prices & demand levels'));

    const comms = S().items.filter(i => i.tradable && ['Commodities', 'Goods', 'Military'].includes(i.category));
    const foreigns = S().entities.filter(e => e.type === 'foreign' || e.type === 'org');

    main.appendChild(el('div', { style: 'font-size:12px; color:var(--ink-faint); margin-bottom:8px;' },
      'Author each foreign partner: which goods they buy from Arcasia (their demand), which they sell to it (their supply), the base price, and a High/Med/Low level that sizes the orders they post. Every turn the open market generates buy/sell orders from these settings; players fill them on Economy → International Trade.'));

    main.appendChild(Views.secLabel('Foreign trade partners'));
    trade.partners.forEach((p, pi) => {
      const ent = entById(p.entityId);
      const box = el('div.stage', { style: 'margin-bottom:12px;' });
      box.appendChild(el('div.stage-header',
        el('span.stage-chapter', ent ? ent.name : (p.entityId || 'Partner')),
        el('button.icon-btn', { title: 'Remove partner', onclick: () => { trade.partners.splice(pi, 1); App.renderView(); } }, '✕')));
      box.appendChild(el('div.form-grid',
        F.field('Partner', F.sel(p, 'entityId', foreigns.map(e => [e.id, e.name]), () => App.renderView())),
        F.field('Tariff', F.sel(p, 'tariff', [['Low', 'Low'], ['Med', 'Medium'], ['High', 'High']])),
        F.field('Net balance (Trade table)', F.num(p, 'netBalance')),
        F.field('Price drift ±', F.num(p, 'priceDrift', '0.01'))));
      p.exports = p.exports || []; p.imports = p.imports || []; p.prices = p.prices || {}; p.priceMult = p.priceMult || {}; p.demand = p.demand || {}; p.supply = p.supply || {};
      // implied multiplier for a legacy absolute price, so old worlds show a
      // sensible starting multiplier before they're re-authored
      const multOf = (it) => {
        if (p.priceMult[it.id] > 0) return p.priceMult[it.id];
        if (p.prices[it.id] > 0 && it.marketValue > 0) return Math.round(p.prices[it.id] / it.marketValue * 100) / 100;
        return 1;
      };
      // shared row builder: `listKey` is p.exports (goods they buy from us) or
      // p.imports (goods they sell to us). Price is now the item's global retail
      // value × a per-partner MULTIPLIER slider (with typing). `lvlKey` is the
      // demand/supply High/Med/Low level that sizes the orders.
      const commRows = (listKey, lvlKey, label) => {
        box.appendChild(el('div.mono-label', { style: 'margin-top:10px;' }, label));
        comms.forEach(it => {
          const on = p[listKey].includes(it.id);
          const cb = el('input', {
            type: 'checkbox', checked: on,
            onchange: (e) => { if (e.target.checked) { p[listKey] = [...new Set([...p[listKey], it.id])]; if (p.priceMult[it.id] === undefined) p.priceMult[it.id] = multOf(it); if (p[lvlKey][it.id] === undefined) p[lvlKey][it.id] = 'Med'; } else { p[listKey] = p[listKey].filter(x => x !== it.id); } App.renderView(); }
          });
          const row = el('div', { style: 'display:flex; gap:10px; align-items:center; padding:3px 0; flex-wrap:wrap;' },
            el('label', { style: 'display:flex; gap:8px; align-items:center; flex:1 1 200px; font-size:12.5px; cursor:pointer;' }, cb,
              el('span', it.name, el('span', { style: 'color:var(--ink-faint); font-family:var(--font-mono); font-size:10px;' }, ' · retail ' + CUR() + fmtNum(it.marketValue)))));
          if (on) {
            if (p.priceMult[it.id] === undefined) p.priceMult[it.id] = multOf(it);
            const priceOut = el('span', { style: 'font-family:var(--font-mono); font-size:11px; color:var(--accent); min-width:78px; text-align:right;' });
            const paint = () => { priceOut.textContent = '= ' + CUR() + fmtNum(Math.round(it.marketValue * (p.priceMult[it.id] || 1) * 100) / 100); };
            paint();
            const slider = Forms.sliderNum(p.priceMult, it.id, 0.5, 2, { step: 0.05, suffix: '×', onInput: () => { delete p.prices[it.id]; paint(); } });
            const lvlSel = F.sel(p[lvlKey], it.id, [['High', 'High'], ['Med', 'Med'], ['Low', 'Low']]);
            lvlSel.style.maxWidth = '84px';
            row.appendChild(el('div', { style: 'display:flex; gap:10px; align-items:center; flex:1 1 340px;' }, el('div', { style: 'flex:1;' }, slider), priceOut, lvlSel));
          }
          box.appendChild(row);
        });
      };
      commRows('exports', 'demand', 'Exports to this partner — price multiplier & their demand level (they buy these from us)');
      commRows('imports', 'supply', 'Imports from this partner — price multiplier & their supply level (they sell these to us)');
      main.appendChild(box);
    });
    main.appendChild(el('div.btn-row', el('button.dash-btn', {
      onclick: () => { const used = new Set(trade.partners.map(p => p.entityId)); const avail = foreigns.find(e => !used.has(e.id)) || foreigns[0]; trade.partners.push({ entityId: avail ? avail.id : null, tariff: 'Low', netBalance: 0, priceDrift: 0.05, exports: [], imports: [], prices: {}, demand: {}, supply: {} }); App.renderView(); }
    }, '+ Add partner')));

    main.appendChild(el('div.btn-row', { style: 'margin-top:18px; border-top:1px dashed var(--rule-strong); padding-top:14px;' },
      el('button.solid-btn', { onclick: () => F.saveTrade(trade) }, 'Save Trade Desk')));
  },

  /* ═══════════ VARIABLES ═══════════ */
  // Phase 8 — Variables tab usage scan. Walks every event's condition and
  // effect strings looking for "$key" (direct reads) and "(..., key)" as the
  // last argument of prov()/ent() calls (the two conventions evalExpr
  // supports), and returns the events that reference it. Best-effort string
  // scan only — it does not parse the expression, so it can't tell a real
  // reference from a coincidental substring inside another word, hence the
  // word-boundary regex.
  findVarUsage(key) {
    if (!key) return [];
    const dollarRe = new RegExp('\\$' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    const callRe = new RegExp('\\b(?:prov|ent)\\s*\\([^)]*,\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\)');
    const refs = (s) => typeof s === 'string' && (dollarRe.test(s) || callRe.test(s));
    const hits = [];
    for (const ev of S().events || []) {
      let hit = false;
      for (const c of ev.conditions || []) if (refs(c.a) || refs(c.b)) hit = true;
      for (const fx of ev.effects || []) {
        for (const v of Object.values(fx)) if (refs(v)) hit = true;
      }
      if (hit) hits.push(ev);
    }
    return hits;
  },

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
    main.appendChild(this.field('Start from a template', this.sel({ _t: '' }, '_t', VAR_TEMPLATES, (v) => {
      if (v && VAR_TEMPLATE_PATCH[v]) { Object.assign(d, JSON.parse(JSON.stringify(VAR_TEMPLATE_PATCH[v]))); App.renderView(); }
    }), 'Fills in scope, key, label, format and a default.'));
    main.appendChild(el('div.form-grid',
      this.field('Scope', this.sel(d, 'scope', [['province', 'Province'], ['company', 'Company'], ['entity', 'Entity'], ['property', 'Property'], ['global', 'Global']])),
      this.field('Key (used in expressions as $key)', this.text(d, 'key')),
      this.field('Label', this.text(d, 'label')),
      this.field('Format', this.sel(d, 'format', [['number', 'Number'], ['money', 'Money'], ['percent', 'Percent'], ['text', 'Text']])),
      this.field('Default value', this.num(d, 'default'))));
    main.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:9.5px; color:var(--ink-faint); margin-top:10px;' },
      'RENAMING A KEY DOES NOT MIGRATE EXISTING VALUES — SET THEM AGAIN ON EACH OBJECT.'));

    if (!isNew) {
      const usedIn = this.findVarUsage(source.key);
      main.appendChild(Views.secLabel('Used in'));
      if (usedIn.length) {
        main.appendChild(el('div.chip-row', usedIn.map(ev => el('button.chip', {
          onclick: () => { W.gmSel.events = ev.id; W.gmTab = 'events'; this.draftKey = null; App.renderView(); }
        }, ev.name))));
      } else {
        main.appendChild(el('div', { style: 'font-size:12px; color:var(--ink-faint);' }, 'No event currently references $' + source.key + '.'));
      }
    }

    const bar = el('div.btn-row', { style: 'margin-top:22px; border-top:1px dashed var(--rule-strong); padding-top:14px;' },
      el('button.solid-btn', {
        onclick: async () => {
          const renaming = !isNew && d.key !== source.key;
          const goSave = async () => { try { await this.saveColl('variables', d, isNew); } catch (e) { toast(e.message, true); } };
          if (renaming) {
            const usedIn = this.findVarUsage(source.key);
            if (usedIn.length) {
              confirmModal('RENAME REFERENCED VARIABLE',
                `${usedIn.length} event(s) still reference $${source.key} (${usedIn.map(e => e.name).join(', ')}). ` +
                `Renaming to $${d.key} does NOT update those expressions — they will start reading an unset variable. Rename anyway?`,
                goSave, 'Rename Anyway');
              return;
            }
          }
          await goSave();
        }
      }, isNew ? 'Create' : 'Save Changes'),
      !isNew ? el('button.dash-btn', {
        onclick: () => { const copy = JSON.parse(JSON.stringify(d)); delete copy.id; copy.key = copy.key + '_copy'; POST('/api/gm/coll/variables', copy).then(() => toast('Duplicated.')).catch(e => toast(e.message, true)); }
      }, 'Duplicate') : null,
      !isNew ? el('button.danger-btn', {
        onclick: () => {
          const usedIn = this.findVarUsage(source.key);
          const goDelete = () => this.deleteColl('variables', d.id, d.label || d.key);
          if (usedIn.length) {
            confirmModal('DESTROY REFERENCED VARIABLE',
              `${usedIn.length} event(s) still reference $${source.key} (${usedIn.map(e => e.name).join(', ')}). ` +
              `Deleting this definition leaves those expressions reading an unset (zero) variable. Delete anyway?`,
              goDelete, 'Delete Anyway');
          } else {
            confirmModal('DESTROY RECORD', `Delete “${d.label || d.key}” permanently?`, goDelete);
          }
        }
      }, 'Delete') : null
    );
    main.appendChild(bar);
  },

  /* ═══════════ EVENTS — expression authoring helpers (Phase 8) ═══════════
     `exprInput()` renders a normal Forms.text-bound input plus a small "ƒx"
     button opening a popover of $var / function chips and a live-eval line
     hitting POST /api/gm/test-expr. Insert-at-caret keeps the draft binding
     in sync by refiring the input's own 'input' event, so no new state is
     threaded through the draft objects — the effect/condition objects keep
     exactly the same shape sim.js already expects. */
  FN_TEMPLATES: [
    ['rand(a,b)', 'rand(,)'],
    ['clamp(x,a,b)', 'clamp(,,)'],
    ['min(a,b)', 'min(,)'],
    ['max(a,b)', 'max(,)'],
    ['round(x)', 'round()'],
    ['floor(x)', 'floor()'],
    ['ceil(x)', 'ceil()'],
    ['abs(x)', 'abs()'],
    ['sqrt(x)', 'sqrt()'],
    ['turn()', 'turn()'],
    ['g(key)', 'g()'],
    ['prov(id,key)', 'prov(,)'],
    ['ent(id,key)', 'ent(,)'],
    ['item(id)', 'item()'],
    ['pop(id)', 'pop()'],
    ['balance(id)', 'balance()']
  ],

  // vars available to the expression popover for a given effect/condition
  // scope — mirrors the $key / $p_key / prov()/ent() conventions documented
  // at the bottom of the events tab.
  scopeVarChips(scope) {
    const defs = S().variables || [];
    let chips = [];
    if (scope === 'province') chips = defs.filter(v => v.scope === 'province').map(v => v.key);
    else if (scope === 'entity' || scope === 'property') chips = defs.filter(v => v.scope === scope || v.scope === 'company').map(v => v.key);
    else chips = defs.filter(v => v.scope === 'global').map(v => v.key);
    return [...new Set(chips)];
  },

  closeExprPopover() {
    if (this._exprPop) { this._exprPop.remove(); this._exprPop = null; }
    if (this._exprPopDoc) { document.removeEventListener('mousedown', this._exprPopDoc, true); this._exprPopDoc = null; }
    this._exprPopFor = null;
  },

  // input: the bound <input>/<textarea> whose value is the expression.
  // scope: 'province' | 'entity' | 'property' | 'global' (chip source + eval context).
  // targetId(): optional fn returning the current target id for context (e.g. fx.target).
  exprInput(obj, key, ph, scope, targetIdFn) {
    const F = this;
    const input = F.text(obj, key, ph);
    input.style.fontFamily = 'var(--font-mono)';
    input.style.fontSize = '12px';
    const btn = el('button.icon-btn', { type: 'button', title: 'Expression helper', style: 'font-family:var(--font-mono); font-size:11px;' }, 'ƒx');
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const reopening = F._exprPop && F._exprPopFor === input;
      F.closeExprPopover();
      if (reopening) return; // click on the same field's button toggles closed
      F.openExprPopover(input, wrap, scope, targetIdFn);
    });
    const wrap = el('div', { style: 'position:relative; display:flex; gap:4px; align-items:flex-start;' }, el('div', { style: 'flex:1;' }, input), btn);
    return wrap;
  },

  openExprPopover(input, anchor, scope, targetIdFn) {
    const F = this;
    const pop = el('div', {
      style: 'position:absolute; top:100%; left:0; margin-top:4px; z-index:40; width:320px; max-width:60vw;' +
        'background:var(--paper); border:1px solid var(--rule-strong); box-shadow:0 12px 30px rgba(0,0,0,0.28); padding:10px 12px;'
    });
    F._exprPop = pop;
    F._exprPopFor = input;

    const insertAtCaret = (snippet, caretBack) => {
      const elIn = input;
      const start = elIn.selectionStart ?? elIn.value.length;
      const end = elIn.selectionEnd ?? elIn.value.length;
      const v = elIn.value || '';
      elIn.value = v.slice(0, start) + snippet + v.slice(end);
      const caret = start + snippet.length - (caretBack || 0);
      elIn.focus();
      elIn.setSelectionRange(caret, caret);
      elIn.dispatchEvent(new Event('input', { bubbles: true }));
    };

    pop.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:9px; letter-spacing:0.12em; text-transform:uppercase; color:var(--ink-faint); margin-bottom:4px;' }, 'Variables'));
    const varChips = el('div.chip-row', { style: 'margin:0 0 8px;' });
    // common global vars are always useful (growth trackers etc.) even when
    // no variable def of scope:'global' has been authored yet.
    const COMMON_GLOBALS = ['lastGdp', 'weekIndex', 'monthIndex'];
    const vchips = F.scopeVarChips(scope);
    const chipKeys = scope === 'global' ? [...new Set([...vchips, ...COMMON_GLOBALS])] : vchips;
    for (const k of chipKeys) {
      varChips.appendChild(el('button.chip', { type: 'button', onclick: () => insertAtCaret('$' + k) }, '$' + k));
    }
    if (!chipKeys.length) varChips.appendChild(el('span', { style: 'font-size:10.5px; color:var(--ink-faint);' }, 'no variables defined for this scope yet'));
    pop.appendChild(varChips);

    pop.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:9px; letter-spacing:0.12em; text-transform:uppercase; color:var(--ink-faint); margin-bottom:4px;' }, 'Functions'));
    const fnChips = el('div.chip-row', { style: 'margin:0 0 8px;' });
    for (const [label, tmpl] of F.FN_TEMPLATES) {
      fnChips.appendChild(el('button.chip', {
        type: 'button', title: label,
        onclick: () => insertAtCaret(tmpl, tmpl.endsWith(')') ? 1 : 0)
      }, label));
    }
    pop.appendChild(fnChips);

    pop.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:9px; letter-spacing:0.12em; text-transform:uppercase; color:var(--ink-faint); margin-bottom:4px;' }, 'Live evaluation'));
    const out = el('div', { style: 'font-family:var(--font-mono); font-size:12px; min-height:16px; color:var(--accent);' }, '—');
    pop.appendChild(out);
    pop.appendChild(el('div', { style: 'text-align:right; margin-top:6px;' },
      el('button.dash-btn', { type: 'button', onclick: () => F.closeExprPopover() }, 'Close')));

    let debounceTimer = null;
    const evaluate = async () => {
      const expr = input.value;
      if (!expr || !expr.trim()) { out.textContent = '—'; return; }
      try {
        const r = await POST('/api/gm/test-expr', { expr, scope, targetId: targetIdFn ? targetIdFn() : undefined });
        out.textContent = r.error ? '✕ ' + r.error : '= ' + (Math.round(r.value * 10000) / 10000);
        out.style.color = r.error ? 'var(--accent)' : 'var(--ink)';
      } catch (e) { out.textContent = '✕ ' + e.message; }
    };
    const onInput = () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(evaluate, 300); };
    input.addEventListener('input', onInput);
    evaluate();

    anchor.appendChild(pop);
    // click-outside closes
    const onDoc = (e) => { if (!pop.contains(e.target) && e.target !== input) F.closeExprPopover(); };
    F._exprPopDoc = onDoc;
    setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
    // stop the popover's own listener leaking after it's removed
    const origRemove = pop.remove.bind(pop);
    pop.remove = () => { input.removeEventListener('input', onInput); clearTimeout(debounceTimer); origRemove(); };
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

  // A small inline "word" of plain sentence text between controls.
  sw(text) { return el('span', { style: 'font-size:12.5px; color:var(--ink-soft); white-space:nowrap;' }, text); },
  // Wraps a control so it sits inline in the flowing sentence row.
  si(control, minWidth) { return el('span', { style: 'display:inline-flex; vertical-align:middle; min-width:' + (minWidth || '90px') + ';' }, control); },
  // Renders effect params as one flowing sentence row instead of a form grid.
  // `parts` is an array of strings (rendered as sw()) and DOM nodes/controls
  // (rendered inline via si()) — same fields/bindings as before, just laid
  // out differently.
  sentence(parts) {
    const row = el('div', { style: 'display:flex; flex-wrap:wrap; gap:6px 8px; align-items:center; line-height:2.1;' });
    for (const p of parts) {
      if (p === null || p === undefined) continue;
      // strings render as plain sentence words; anything already built by
      // si()/exprInput() (a Node) is appended as-is — callers wrap their own
      // controls so widths can vary per field.
      row.appendChild(typeof p === 'string' ? this.sw(p) : p);
    }
    return row;
  },

  effectParams(fx) {
    const F = this;
    const provTargets = this.provOptions([['all', '— all provinces —'], ['random', '— random province —']]);
    const groups = [['all', '— all groups —'], ...(S().settings.demographics.groups || []).map(g => [g, g])];
    const metrics = (S().settings.demographics.metrics || []).map(mDef => [mDef.key, mDef.label]);
    const ops = [['add', 'add (+)'], ['set', 'set (=)'], ['mul', 'multiply (×)']];
    const box = el('div');
    switch (fx.type) {
      case 'adjust_var': {
        const scopeSel = F.sel(fx, 'scope', [['province', 'province'], ['entity', 'entity'], ['property', 'property'], ['global', 'global']], () => App.renderView());
        let targetSel = null;
        if (fx.scope === 'province') targetSel = F.sel(fx, 'target', provTargets);
        else if (fx.scope === 'entity') targetSel = F.sel(fx, 'target', [['all', '— all entities —'], ...F.entOptions()]);
        else if (fx.scope === 'property') targetSel = F.sel(fx, 'target', [['all', '— all properties —'], ...S().properties.map(p => [p.id, p.name])]);
        box.appendChild(F.sentence([
          'Adjust variable', F.si(F.text(fx, 'key', 'gdp'), '120px'),
          'in', F.si(scopeSel, '110px'),
          targetSel ? F.si(targetSel, '160px') : null,
          F.si(F.sel(fx, 'op', ops), '110px'),
          'by', F.si(F.exprInput(fx, 'value', '$gdp * 0.001', fx.scope, () => fx.target), '240px')
        ]));
        break;
      }
      case 'adjust_demo':
        box.appendChild(F.sentence([
          'In', F.si(F.sel(fx, 'province', provTargets), '160px'),
          'adjust', F.si(F.sel(fx, 'group', groups), '140px'),
          F.si(F.sel(fx, 'metric', metrics), '140px'),
          F.si(F.sel(fx, 'op', ops), '110px'),
          'by', F.si(F.exprInput(fx, 'value', 'rand(-1,1)', 'province', () => fx.province), '220px')
        ]));
        box.appendChild(el('div', { style: 'font-size:9.5px; color:var(--ink-faint); margin-top:2px;' }, '$metric reads the group’s current value · $p_var reads the province variable'));
        break;
      case 'money': {
        const kindSel = F.sel(fx, 'kind', [['deposit', 'deposit (create money)'], ['withdraw', 'withdraw (destroy money)'], ['transfer', 'transfer']], () => App.renderView());
        box.appendChild(F.sentence([
          'Move money —', F.si(kindSel, '190px'),
          fx.kind !== 'deposit' ? 'from' : null, fx.kind !== 'deposit' ? F.si(F.sel(fx, 'from', F.entOptions()), '170px') : null,
          fx.kind !== 'withdraw' ? 'to' : null, fx.kind !== 'withdraw' ? F.si(F.sel(fx, 'to', F.entOptions()), '170px') : null,
          'amount', F.si(F.exprInput(fx, 'amount', 'rand(10000, 50000)', 'global'), '200px'),
          'memo', F.si(F.text(fx, 'memo'), '160px')
        ]));
        break;
      }
      case 'spawn_item':
        box.appendChild(F.sentence([
          'Give', F.si(F.sel(fx, 'entity', F.entOptions()), '170px'),
          F.si(F.sel(fx, 'item', F.itemOptions()), '160px'),
          'quantity', F.si(F.exprInput(fx, 'qty', '10', 'global'), '140px'),
          '(negative removes)'
        ]));
        break;
      case 'set_item_value':
        box.appendChild(F.sentence([
          'Set market value of', F.si(F.sel(fx, 'item', F.itemOptions([['all', '— all items —']]), () => App.renderView()), '170px'),
          fx.item === 'all' ? 'only category' : null, fx.item === 'all' ? F.si(F.text(fx, 'category', 'Securities'), '140px') : null,
          'to', F.si(F.exprInput(fx, 'value', '$value * rand(0.95, 1.05)', 'global'), '220px'),
          '($value = current)'
        ]));
        break;
      case 'transfer_property':
        box.appendChild(F.sentence([
          'Transfer property', F.si(F.sel(fx, 'property', S().properties.map(p => [p.id, p.name])), '190px'),
          'to new owner', F.si(F.sel(fx, 'to', F.entOptions()), '170px')
        ]));
        break;
      case 'transfer_company':
        box.appendChild(F.sentence([
          'Transfer control of company', F.si(F.sel(fx, 'company', F.entOptions(['company'])), '180px'),
          'to', F.si(F.sel(fx, 'to', F.entOptions()), '170px')
        ]));
        break;
      case 'adjust_support':
        box.appendChild(F.sentence([
          'Shift support for party', F.si(F.sel(fx, 'party', F.entOptions(['party'])), '160px'),
          'in', F.si(F.sel(fx, 'province', provTargets), '150px'),
          'among', F.si(F.sel(fx, 'group', groups), '140px'),
          'by', F.si(F.exprInput(fx, 'value', '2', 'province', () => fx.province), '160px')
        ]));
        break;
      case 'news':
        box.appendChild(F.sentence(['Publish news headline', F.si(F.text(fx, 'headline'), '100%')]));
        box.appendChild(F.sentence(['category', F.si(F.text(fx, 'category', 'Politics'), '160px')]));
        box.appendChild(el('div.full', F.field('Body ({expressions} interpolate)', F.area(fx, 'body'))));
        box.appendChild(F.check(fx, 'publish', 'Publish immediately (otherwise lands in drafts)'));
        break;
      case 'log':
        box.appendChild(F.sentence(['Write timeline entry titled', F.si(F.text(fx, 'title'), '220px')]));
        box.appendChild(F.sentence(['detail', F.si(F.text(fx, 'detail'), '100%')]));
        break;
    }
    return box;
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
    main.appendChild(this.field('Start from a template', this.sel({ _t: '' }, '_t', EVENT_TEMPLATES, (v) => {
      if (v && EVENT_TEMPLATE_PATCH[v]) {
        const patch = JSON.parse(JSON.stringify(EVENT_TEMPLATE_PATCH[v]));
        d.name = patch.name; d.description = patch.description;
        d.trigger = patch.trigger || { type: 'every_turn' };
        d.conditions = patch.conditions || [];
        d.effects = patch.effects || [];
        App.renderView();
      }
    }), 'Fills in the trigger, conditions and effects — then tweak the details. No formula-writing needed to start.'));
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
      const row = el('div', { style: 'display:flex; gap:8px; align-items:flex-start; margin-bottom:4px;' },
        this.sw('when'),
        el('div', { style: 'flex:1' }, this.exprInput(c, 'a', 'prov(kordi, approval)', 'global')),
        el('div', { style: 'width:70px' }, this.sel(c, 'op', [['<', '<'], ['<=', '≤'], ['>', '>'], ['>=', '≥'], ['==', '='], ['!=', '≠']])),
        el('div', { style: 'flex:1' }, this.exprInput(c, 'b', '30', 'global')),
        el('button.icon-btn', { onclick: () => { d.conditions.splice(i, 1); App.renderView(); } }, '✕'));
      main.appendChild(row);
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

    const simBox = el('div');
    const renderSimResult = (r) => {
      clear(simBox);
      if (!r) return;
      if (r.error) { simBox.appendChild(el('div', { style: 'color:var(--accent); font-family:var(--font-mono); font-size:11.5px; margin-top:10px;' }, '✕ ' + r.error)); return; }
      if (!r.ran) { simBox.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:11.5px; color:var(--ink-faint); margin-top:10px;' }, 'Conditions not met — nothing would run.')); return; }
      const box = el('div', { style: 'margin-top:10px; border:1px dashed var(--rule-strong); padding:10px 12px; background:rgba(34,29,21,0.02);' });
      box.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:9px; letter-spacing:0.12em; text-transform:uppercase; color:var(--ink-faint); margin-bottom:6px;' }, 'Simulated result (not saved)'));
      const diff = r.diff || {};
      const lines = [];
      for (const gv of diff.globalVars || []) lines.push(`$${gv.key}: ${fmtNum(gv.from)} → ${fmtNum(gv.to)}`);
      for (const p of diff.provinces || []) for (const c of p.changes) lines.push(`${p.name} · $${c.key}: ${fmtNum(c.from)} → ${fmtNum(c.to)}`);
      if (diff.moneyMoved) lines.push(`Money moved: ${fmtMoney(diff.moneyMoved)}`);
      for (const n of diff.news || []) lines.push(`News drafted: “${n.headline}”`);
      if (!lines.length) lines.push('No observable change.');
      for (const l of lines) box.appendChild(el('div', { style: 'font-size:12px; padding:2px 0;' }, l));
      simBox.appendChild(box);
    };

    const bar = this.saveBar('events', d, isNew);
    if (!isNew) {
      const anchor = bar.children[1]; // "Duplicate" — fixed reference, insert both new buttons before it
      const simulateBtn = el('button.outline-btn', {
        onclick: async () => {
          try {
            const r = await POST('/api/gm/run-event', { id: d.id, dryRun: true });
            renderSimResult(r);
          } catch (e) { toast(e.message, true); }
        }
      }, '◌ Simulate');
      const runBtn = el('button.outline-btn', {
        onclick: async () => {
          try { const r = await POST('/api/gm/run-event', { id: d.id }); toast(r.ran ? 'Event executed.' : 'Conditions not met — did not run.'); }
          catch (e) { toast(e.message, true); }
        }
      }, '▸ Run Now');
      bar.insertBefore(simulateBtn, anchor);
      bar.insertBefore(runBtn, anchor);
    }
    main.appendChild(bar);
    main.appendChild(simBox);
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

  /* ═══════════ PRESENTATION (Phase 10 — Music) ═══════════
     Everything here edits one draft of the whole settings.music object and
     saves it in one PATCH /api/gm/settings { music: <whole object> }. The
     sync broadcast that follows makes every client's Music.apply() react
     (active playlist swap, forced track, volume, shuffle, enable/disable). */
  musicDraft() {
    const m = S().settings.music || { enabled: false, shuffle: true, volume: 0.7, library: [], playlists: [], activePlaylist: null, forcedTrack: null };
    return this.getDraft('music', m);
  },
  async saveMusic(d) {
    try {
      await PATCH('/api/gm/settings', { music: d });
      this.draftKey = null;
      toast('Presentation settings saved.');
    } catch (e) { toast(e.message, true); }
  },

  tabPresentation(main) {
    const F = this;
    const d = this.musicDraft();
    d.library = d.library || [];
    d.playlists = d.playlists || [];
    // undefined allowedPlaylists means "all" — surface that as every box ticked
    if (d.allowedPlaylists === undefined) d.allowedPlaylists = d.playlists.map(p => p.id);

    main.appendChild(el('div.doc-title', 'Presentation'));
    main.appendChild(el('div.doc-sub', 'music library, playlists and live playback control'));

    /* ---------- transport ---------- */
    main.appendChild(Views.secLabel('Playback'));
    main.appendChild(this.check(d, 'enabled', 'Enable music (every connected client plays it)'));
    main.appendChild(el('div.form-grid',
      this.field('Active playlist', this.sel(d, 'activePlaylist',
        [['__null__', '— none (whole library) —'], ...d.playlists.map(p => [p.id, p.name])])),
      this.field('Force track (overrides playlist on every client)', this.sel(d, 'forcedTrack',
        [['__null__', '— not forced —'], ...d.library.map(t => [t.id, t.title + (t.forcedOnly ? ' [forced-only]' : '')])]))));
    main.appendChild(this.check(d, 'shuffle', 'Shuffle normal playback'));
    main.appendChild(el('div.form-grid',
      this.field('Volume', el('input', {
        type: 'range', min: '0', max: '1', step: '0.05', value: d.volume ?? 0.7, style: 'width:100%;',
        oninput: (e) => d.volume = Number(e.target.value)
      }))));
    main.appendChild(el('div', { style: 'font-family:var(--font-mono); font-size:9.5px; color:var(--ink-faint); margin-top:4px;' },
      'FORCED TRACKS NEVER APPEAR IN NORMAL SHUFFLE — ONLY WHEN SELECTED ABOVE. CLEARING THE FORCE RESUMES THE ACTIVE PLAYLIST.'));

    /* ---------- player playlist choice (Phase 10.1) ---------- */
    main.appendChild(Views.secLabel('Player Playlist Choice'));
    main.appendChild(el('div', { style: 'font-size:12px; color:var(--ink-faint); margin-bottom:8px;' },
      'Players pick from the playlists you tick below using the ♫ button in the top-bar music widget; their choice is personal (it never changes what anyone else hears). Turn on “Lock playlist” to override that and force the active playlist on everyone.'));
    main.appendChild(this.check(d, 'lockPlaylist', 'Lock playlist — force the active playlist on every client (players cannot choose their own)'));
    main.appendChild(el('div.mono-label', { style: 'margin-top:14px;' }, 'Playlists players may choose'));
    const allowGrid = el('div.perm-grid');
    d.playlists.forEach(p => {
      const checked = d.allowedPlaylists.includes(p.id);
      allowGrid.appendChild(el('label',
        el('input', {
          type: 'checkbox', checked,
          onchange: (e) => { d.allowedPlaylists = e.target.checked ? [...new Set([...d.allowedPlaylists, p.id])] : d.allowedPlaylists.filter(id => id !== p.id); }
        }),
        p.name));
    });
    if (!d.playlists.length) allowGrid.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'Create a playlist below first.'));
    main.appendChild(allowGrid);

    main.appendChild(el('div.btn-row', { style: 'margin-top:14px;' },
      el('button.solid-btn', { onclick: () => F.saveMusic(d) }, 'Save Presentation Settings')));

    /* ---------- music library ---------- */
    main.appendChild(Views.secLabel('Music Library'));
    main.appendChild(el('div', { style: 'font-size:12px; color:var(--ink-faint); margin-bottom:8px;' },
      'Every track available to the simulator. Paste a YouTube link (watch/youtu.be) or a direct audio file URL (.mp3/.ogg/.m4a/etc) and a title; add it to a playlist below. “Forced-only” tracks are hidden from normal shuffle and only play when explicitly forced above — force one to score an event.'));

    const libBox = el('div');
    d.library.forEach((t, i) => {
      libBox.appendChild(el('div', { style: 'display:flex; gap:8px; align-items:flex-end; margin-bottom:6px; flex-wrap:wrap;' },
        el('div', { style: 'flex:1 1 180px;' }, F.field('Title', F.text(t, 'title'))),
        el('div', { style: 'flex:2 1 260px;' }, F.field('Track URL (YouTube or audio file)', F.text(t, 'url', 'https://www.youtube.com/watch?v=…'))),
        el('div', { style: 'padding-bottom:8px;' }, F.check(t, 'forcedOnly', 'Forced-only')),
        el('button.icon-btn', {
          title: 'Remove from library', style: 'padding-bottom:8px;',
          onclick: () => {
            const usedIn = d.playlists.filter(p => (p.tracks || []).includes(t.id));
            const doRemove = () => {
              d.library.splice(i, 1);
              d.playlists.forEach(p => { p.tracks = (p.tracks || []).filter(id => id !== t.id); });
              if (d.forcedTrack === t.id) d.forcedTrack = null;
              App.renderView();
            };
            if (usedIn.length) confirmModal('REMOVE TRACK', `“${t.title || t.id}” is used in ${usedIn.length} playlist(s). Remove it everywhere?`, async () => doRemove());
            else doRemove();
          }
        }, '✕')));
    });
    if (!d.library.length) libBox.appendChild(el('div', { style: 'padding:10px 0; color:var(--ink-faint); font-size:12px;' }, 'No tracks yet.'));
    main.appendChild(libBox);
    main.appendChild(el('div.btn-row', el('button.dash-btn', {
      onclick: () => { d.library.push({ id: 'trk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: 'New Track', url: '', forcedOnly: false }); App.renderView(); }
    }, '+ Add track to library')));

    /* ---------- playlists ---------- */
    main.appendChild(Views.secLabel('Playlists'));
    main.appendChild(el('div', { style: 'font-size:12px; color:var(--ink-faint); margin-bottom:8px;' },
      'Playlists reference tracks from the library above by checkbox — no re-entering URLs.'));

    d.playlists.forEach((p, pi) => {
      const box = el('div.stage', { style: 'margin-bottom:12px;' });
      box.appendChild(el('div.stage-header',
        el('span.stage-chapter', el('span', { style: 'display:inline-block; min-width:220px;' }, F.text(p, 'name'))),
        el('button.icon-btn', { title: 'Delete playlist', onclick: () => { d.playlists.splice(pi, 1); if (d.activePlaylist === p.id) d.activePlaylist = null; if (d.allowedPlaylists) d.allowedPlaylists = d.allowedPlaylists.filter(id => id !== p.id); App.renderView(); } }, '✕')));
      p.tracks = p.tracks || [];
      const trackGrid = el('div.perm-grid');
      d.library.forEach(t => {
        const checked = p.tracks.includes(t.id);
        trackGrid.appendChild(el('label',
          el('input', {
            type: 'checkbox', checked,
            onchange: (e) => { p.tracks = e.target.checked ? [...new Set([...p.tracks, t.id])] : p.tracks.filter(id => id !== t.id); }
          }),
          t.title + (t.forcedOnly ? ' [forced-only]' : '')));
      });
      box.appendChild(trackGrid);
      if (!d.library.length) box.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'Add tracks to the library first.'));
      main.appendChild(box);
    });
    main.appendChild(el('div.btn-row', el('button.dash-btn', {
      onclick: () => { d.playlists.push({ id: 'plist_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: 'New Playlist', tracks: [] }); App.renderView(); }
    }, '+ New playlist')));

    main.appendChild(el('div.btn-row', { style: 'margin-top:18px; border-top:1px dashed var(--rule-strong); padding-top:14px;' },
      el('button.solid-btn', { onclick: () => F.saveMusic(d) }, 'Save Presentation Settings')));
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

    const PAGES = [['map', 'World Map'], ['parliament', 'Parliament'], ['companies', 'Companies'], ['economy', 'Economy'], ['population', 'Population'], ['news', 'News'], ['entertainment', 'Entertainment'], ['timeline', 'Timeline'], ['gm', 'GM Studio']];
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
    const paperOptions = () => [['', '— none —'], ...(S().settings.newspapers || []).map(p => [p.id, p.name])];
    main.appendChild(el('div.btn-row', el('button.solid-btn', {
      onclick: () => {
        const nd = { username: '', displayName: '', password: '', roleId: 'citizen', entityId: null, newspaperId: '' };
        openModal('NEW OPERATOR ACCOUNT', el('div',
          el('label.field-label', 'Username'), this.text(nd, 'username'),
          el('label.field-label', 'Display name'), this.text(nd, 'displayName'),
          el('label.field-label', 'Passphrase'), this.text(nd, 'password'),
          el('label.field-label', 'Role'), this.sel(nd, 'roleId', (S().roles || []).map(r => [r.id, r.name])),
          el('label.field-label', 'Linked entity (their persona)'), this.sel(nd, 'entityId', this.entOptions(null, true)),
          el('label.field-label', 'Newspaper (journalist affiliation)'), this.sel(nd, 'newspaperId', paperOptions())
        ), [{ label: 'Create Account', onClick: async () => { await POST('/api/gm/users', nd); toast('Account created.'); } }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }]);
      }
    }, '+ New Operator')));

    main.appendChild(el('table.data',
      el('thead', el('tr', el('th', 'Operator'), el('th', 'Display'), el('th', 'Role'), el('th', 'Persona'), el('th', 'Newspaper'), el('th', 'Last Seen'), el('th', ''))),
      el('tbody', (S().users || []).map(u2 => el('tr',
        el('td', { style: 'font-family:var(--font-mono);' }, u2.username),
        el('td', u2.displayName),
        el('td', ((S().roles || []).find(r => r.id === u2.roleId) || {}).name || u2.roleId),
        el('td', u2.entityId ? entName(u2.entityId) : '—'),
        el('td', u2.newspaperId ? (((S().settings.newspapers || []).find(p => p.id === u2.newspaperId) || {}).name || u2.newspaperId) : '—'),
        el('td', u2.lastLogin ? new Date(u2.lastLogin).toLocaleDateString() : 'never'),
        el('td',
          el('button.outline-btn', {
            onclick: () => {
              const nd = { displayName: u2.displayName, roleId: u2.roleId, entityId: u2.entityId, newspaperId: u2.newspaperId || '', password: '' };
              openModal('EDIT — ' + u2.username, el('div',
                el('label.field-label', 'Display name'), this.text(nd, 'displayName'),
                el('label.field-label', 'Role'), this.sel(nd, 'roleId', (S().roles || []).map(r => [r.id, r.name])),
                el('label.field-label', 'Linked entity'), this.sel(nd, 'entityId', this.entOptions(null, true)),
                el('label.field-label', 'Newspaper (journalist affiliation)'), this.sel(nd, 'newspaperId', paperOptions()),
                el('label.field-label', 'New passphrase (blank = keep)'), this.text(nd, 'password')
              ), [{
                label: 'Save', onClick: async () => {
                  const body = { displayName: nd.displayName, roleId: nd.roleId, entityId: nd.entityId, newspaperId: nd.newspaperId || null };
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

    // ---- import a previously exported world ----
    const filePick = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none;' });
    filePick.addEventListener('change', () => {
      const f = filePick.files && filePick.files[0];
      filePick.value = ''; // allow re-picking the same file
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        let world;
        try { world = JSON.parse(reader.result); } catch (e) { return toast('That file is not valid JSON.', true); }
        if (!world || !world.settings || !Array.isArray(world.entities)) return toast('That file is not an Arcasia world export.', true);
        confirmModal('RESTORE FROM ARCHIVE',
          `Replace the ENTIRE current world with “${f.name}” (${(world.settings || {}).worldName || 'unnamed world'}, turn ${((world.settings || {}).time || {}).turn ?? '?'})? Everything since your last export of that file is destroyed. Your operator account stays.`,
          async () => {
            await POST('/api/gm/import', world);
            toast('World restored from the archive.');
          }, 'Import & Replace');
      };
      reader.readAsText(f);
    });
    main.appendChild(el('div.stage', { style: 'margin-top:16px;' },
      el('div.stage-header', el('span.stage-chapter', 'Restore'), el('span.stage-year', '§2')),
      el('p', { style: 'font-family:var(--font-voice); font-size:15px; line-height:1.6;' }, 'Import a previously exported world file. The current world is replaced wholesale — provinces, accounts, articles, operators, everything. Export first if in doubt.'),
      el('div.btn-row', filePick, el('button.solid-btn', { onclick: () => filePick.click() }, '↑ Import World'))));

    main.appendChild(el('div.stage', { style: 'margin-top:16px;' },
      el('div.stage-header', el('span.stage-chapter', 'Total Reset'), el('span.stage-year', '§3')),
      el('p', { style: 'font-family:var(--font-voice); font-size:15px; line-height:1.6;' }, 'Reset the world to the seed of March 1962. Every change, account and article since is destroyed. Operator accounts are re-seeded too.'),
      el('div.btn-row', el('button.danger-btn', {
        onclick: () => confirmModal('BURN THE ARCHIVE', 'Reset the entire world to the 1962 seed? This cannot be undone (export first).', async () => {
          await POST('/api/gm/reset');
          toast('The world begins again. 1962.');
        }, 'Reset Everything')
      }, '⚠ Reset World'))));
  }
};
