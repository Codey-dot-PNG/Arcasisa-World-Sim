'use strict';
/* Core: global state, API client, live stream, DOM + formatting helpers,
   explorer sidebar, ticker, modal and toast plumbing. */

const W = {
  me: null,          // {id, username, displayName, entityId, role:{perms}}
  state: null,       // permission-filtered world
  view: 'map',
  selection: null,   // {kind, id}
  inspEdit: false,   // inspector inline-edit mode toggle (Phase 2)
  inspDraft: null,   // draft object being edited in the inspector
  layer: 'political',
  dataVar: 'gdp',
  placing: null,     // GM map-placement callback
  gmTab: 'world',
  gmSel: {},
  expOpen: {},
  refreshTimer: null
};

/* ---------- DOM helper ---------- */
function el(spec, attrs, ...children) {
  const parts = String(spec).split(/(?=[.#])/);
  const node = document.createElement(parts[0] || 'div');
  for (const p of parts.slice(1)) {
    if (p[0] === '.') node.classList.add(p.slice(1));
    if (p[0] === '#') node.id = p.slice(1);
  }
  // second argument may be a child rather than an attribute bag
  if (attrs && (typeof attrs === 'string' || typeof attrs === 'number' || attrs instanceof Node || Array.isArray(attrs))) {
    children = [attrs, ...children];
    attrs = null;
  }
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className += (node.className ? ' ' : '') + v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked') node.checked = !!v;
      else if (k === 'disabled') node.disabled = !!v;
      else if (k === 'html') node.innerHTML = v;
      else node.setAttribute(k, v);
    }
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) return c.forEach(add);
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  };
  children.forEach(add);
  return node;
}
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };

/* ---------- formatting ---------- */
const CUR = () => (W.state ? W.state.settings.currency : 'K');
function fmtNum(n, dec) {
  if (n === undefined || n === null || isNaN(n)) return '—';
  const d = dec === undefined ? (Math.abs(n) < 10 && n % 1 !== 0 ? 2 : 0) : dec;
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtMoney(n) { return n === undefined || n === null || isNaN(n) ? '—' : CUR() + fmtNum(Math.round(n * 100) / 100); }
function fmtCompact(n) {
  if (n === undefined || n === null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e4) return (n / 1e3).toFixed(0) + 'K';
  return fmtNum(n);
}
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function fmtDate(s) {
  if (!s) return '—';
  const [datePart, timePart] = String(s).split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  let out = `${d} ${MONTHS[(m || 1) - 1]} ${y}`;
  if (timePart) out += ' ' + timePart.slice(0, 5);
  return out;
}
function fmtVal(v, format) {
  if (format === 'money') return fmtMoney(v);
  if (format === 'percent') return v === undefined || v === null ? '—' : fmtNum(v, Math.abs(v) % 1 ? 1 : 0) + '%';
  if (format === 'text') return v === undefined ? '—' : String(v);
  return fmtNum(v);
}
function esc(s) { return String(s ?? ''); }

/* ---------- lookups ---------- */
const S = () => W.state;
const entById = (id) => S() && S().entities.find(e => e.id === id);
const provById = (id) => S() && S().provinces.find(p => p.id === id);
const cityById = (id) => S() && S().cities.find(c => c.id === id);
const propById = (id) => S() && S().properties.find(p => p.id === id);
const markerById = (id) => S() && (S().markers || []).find(m => m.id === id);
const itemById = (id) => S() && S().items.find(i => i.id === id);
const acctById = (id) => S() && S().accounts.find(a => a.id === id);
const entName = (id) => { const e = entById(id); return e ? e.name : '—'; };
const perms = () => (W.me ? W.me.role.perms : { pages: [], mapLayers: [] });
const can = (page) => perms().pages && perms().pages.includes(page);
const isGM = () => !!perms().gm;
const myEntity = () => (W.me && W.me.entityId ? entById(W.me.entityId) : null);

const TYPE_LABEL = { person: 'Person', company: 'Company', party: 'Political Party', government: 'Government', foreign: 'Foreign Power', org: 'Organisation' };
const KIND_GLYPH = { factory: 'F', office: 'O', bank: 'B', house: 'H', mine: 'M', farm: 'A', government: 'G', military_base: 'X', port: 'P', airport: 'V', university: 'U', infrastructure: 'I' };
// Assignable SVG map icons (Phase 1.5). Filenames (no extension) under
// public/assets/icons/. Properties and event markers may carry an `icon`
// naming one of these; the map renders /assets/icons/<icon>.svg in place of the
// letter glyph / emoji. Hardcoded manifest — no directory listing.
const ICON_MANIFEST = ['airport', 'factory', 'port', 'military', 'mine', 'farm', 'bank', 'government', 'university', 'rail-station', 'radio-mast', 'star'];
const iconHref = (name) => '/assets/icons/' + name + '.svg';

/* ---------- API ---------- */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* stream or empty */ }
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  // on cloud hosting the realtime ping can lag a moment behind our own
  // mutations, so refetch state directly after any successful write
  if (method !== 'GET' && !path.startsWith('/api/auth/')) scheduleRefresh();
  return data;
}
const GET = (p) => api('GET', p);
const POST = (p, b) => api('POST', p, b || {});
const PATCH = (p, b) => api('PATCH', p, b || {});
const DEL = (p) => api('DELETE', p);

/* ---------- live stream + refresh ---------- */
// Local hosting pushes over SSE. Cloud hosting (Vercel + Supabase) has no
// held-open connections, so we subscribe to a Supabase Realtime broadcast
// channel instead — with a slow poll as belt-and-braces.
let sse = null, pollTimer = null;
function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => fail(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}
async function connectStream() {
  let cfg = { realtime: 'sse' };
  try { cfg = await GET('/api/config'); } catch (e) { /* older server: default to SSE */ }

  if (cfg.ephemeral && isGM()) {
    toast('⚠ No database configured — the world will reset on redeploy. Set Supabase env vars (see DEPLOY.md).', true);
  }

  if (cfg.realtime === 'supabase' && cfg.supabaseUrl && cfg.supabaseAnonKey) {
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
      const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      client.channel('world')
        .on('broadcast', { event: 'sync' }, () => scheduleRefresh())
        .subscribe();
    } catch (e) { console.warn('Realtime unavailable, polling instead:', e.message); }
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => scheduleRefresh(), 60000);
    return;
  }

  if (sse) sse.close();
  sse = new EventSource('/api/stream');
  sse.addEventListener('sync', () => scheduleRefresh());
  sse.onerror = () => { /* EventSource retries automatically */ };
}
function scheduleRefresh() {
  if (W.refreshTimer) return;
  W.refreshTimer = setTimeout(async () => {
    W.refreshTimer = null;
    try { await refreshState(); } catch (e) { /* transient */ }
  }, 250);
}
async function refreshState() {
  const data = await GET('/api/state');
  W.me = data.user;
  W.state = data.state;
  App.renderAll();
}

/* ---------- shared form helpers (bind into a draft object) ---------- */
/* Used by both GM Studio (gm.js) and the inspector's inline edit mode
   (views.js). Keep signatures stable — both call sites depend on them. */
const Forms = {
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
};

/* ---------- toast & modal ---------- */
function toast(msg, isErr) {
  const t = el('div.toast', { class: isErr ? 'err' : '' }, msg);
  document.getElementById('toast-root').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; setTimeout(() => t.remove(), 400); }, isErr ? 5200 : 3200);
}
function openModal(title, body, actions, wide) {
  const root = document.getElementById('modal-root');
  clear(root);
  const closeFn = () => clear(root);
  const btns = (actions || []).map(a => el('button', {
    class: a.cls || 'solid-btn',
    onclick: async () => {
      try { const r = await a.onClick(); if (r !== false) closeFn(); }
      catch (e) { toast(e.message, true); }
    }
  }, a.label));
  root.appendChild(el('div.modal', { class: wide ? 'wide' : '' },
    el('div.modal-head', el('span.modal-title', title), el('button.icon-btn', { onclick: closeFn }, '✕')),
    body,
    el('div.btn-row', { style: 'margin-top:20px; justify-content:flex-end;' }, el('span', { style: 'flex:1' }), btns)
  ));
  return closeFn;
}
function confirmModal(title, text, onYes, yesLabel) {
  openModal(title, el('p', { style: 'font-family:var(--font-voice); font-size:15px; line-height:1.6;' }, text),
    [{ label: yesLabel || 'Confirm', cls: 'danger-btn', onClick: onYes }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }]);
}

/* ---------- selection ---------- */
function select(kind, id, opts) {
  // switching the inspected record always discards any in-progress edit
  if (!W.selection || W.selection.kind !== kind || W.selection.id !== id) { W.inspEdit = false; W.inspDraft = null; }
  W.selection = { kind, id };
  Views.inspect(kind, id);
  if (W.view === 'map' && GameMap.ready) {
    GameMap.highlight();
    const pos = kind === 'province' ? (provById(id) || {}).labelPos
      : kind === 'city' ? (cityById(id) || {}).pos
        : kind === 'property' ? (propById(id) || {}).pos
          : kind === 'marker' ? (markerById(id) || {}).pos : null;
    if (pos && (!opts || !opts.noPan)) GameMap.focus(pos);
  }
  renderExplorer();
}

/* ---------- explorer ---------- */
function expSection(key, label, rows) {
  if (!rows.length) return null;
  const open = W.expOpen[key] !== false;
  return el('div.exp-section',
    el('div.exp-section-head', { onclick: () => { W.expOpen[key] = !open; renderExplorer(); } },
      el('span', (open ? '▾ ' : '▸ ') + label), el('span.exp-count', String(rows.length))),
    open ? rows : null
  );
}
function expItem(kind, id, name, sub, color, logo) {
  const selected = W.selection && W.selection.kind === kind && W.selection.id === id;
  return el('div.exp-item', { class: selected ? 'selected' : '', onclick: () => select(kind, id) },
    logo ? el('img.exp-img', { src: logo, alt: '' }) : el('span.exp-dot', { style: 'background:' + (color || 'var(--paper-line)') }),
    el('span', name),
    sub ? el('span.exp-sub', sub) : null
  );
}
function renderExplorer() {
  const body = document.getElementById('exp-body');
  if (!S()) return;
  const q = (document.getElementById('exp-search').value || '').trim().toLowerCase();
  const match = (s) => !q || String(s || '').toLowerCase().includes(q);
  clear(body);

  const provs = S().provinces.filter(p => match(p.name));
  const cities = S().cities.filter(c => match(c.name));
  const companies = S().entities.filter(e => e.type === 'company' && match(e.name));
  const parties = S().entities.filter(e => e.type === 'party' && match(e.name));
  const gov = S().entities.filter(e => e.type === 'government' && match(e.name));
  const people = S().entities.filter(e => e.type === 'person' && (match(e.name) || match(e.title)));
  const foreign = S().entities.filter(e => (e.type === 'foreign' || e.type === 'org') && match(e.name));
  const props = S().properties.filter(p => match(p.name));
  const items = S().items.filter(i => match(i.name));

  const sections = [
    expSection('prov', 'Provinces', provs.map(p => expItem('province', p.id, p.name, fmtCompact(p.vars.population), p.color))),
    expSection('city', 'Cities', cities.map(c => expItem('city', c.id, c.name, c.isCapital ? '★ capital' : '', 'var(--ink-faint)'))),
    expSection('co', 'Companies', companies.map(e => expItem('entity', e.id, e.name, e.industry, e.color, e.logo))),
    expSection('party', 'Political Parties', parties.map(e => expItem('entity', e.id, e.name, (e.mpCount || 0) + ' MPs', e.color, e.logo))),
    expSection('gov', 'Government', gov.map(e => expItem('entity', e.id, e.name, '', e.color))),
    expSection('ppl', 'People', people.map(e => expItem('entity', e.id, e.name, e.title, e.color))),
    expSection('for', 'Foreign Powers', foreign.map(e => expItem('entity', e.id, e.name, e.stance, e.color, e.logo))),
    expSection('prop', 'Properties', props.map(p => expItem('property', p.id, p.name, entName(p.ownerId), (entById(p.ownerId) || {}).color))),
    expSection('item', 'Items & Markets', items.map(i => expItem('item', i.id, i.name, fmtMoney(i.marketValue), 'var(--paper-line)')))
  ];
  sections.forEach(s => s && body.appendChild(s));
  if (!body.children.length) body.appendChild(el('div', { style: 'padding:20px 16px; color:var(--ink-faint); font-family:var(--font-mono); font-size:10px; letter-spacing:.1em;' }, 'NOTHING IN THE FILES.'));
}

/* ---------- ticker ---------- */
const TICK_GLYPH = { economy: 'K', news: '¶', politics: '⚑', election: '⚑', ownership: '⇄', simulation: '∴', system: '⚙', time: '◔', market: '％', inventory: '▣', gm: '✎', event: '∴', error: '!' };
function renderTicker() {
  const track = document.getElementById('ticker-track');
  clear(track);
  const items = (S().timeline || []).slice(-14).reverse();
  for (const t of items) {
    track.appendChild(el('span.tick-item', { onclick: () => App.go('timeline'), title: (t.detail || '') },
      el('span.tt', TICK_GLYPH[t.type] || '·'),
      el('span', `T${t.turn}`),
      el('span', t.title)
    ));
  }
}
