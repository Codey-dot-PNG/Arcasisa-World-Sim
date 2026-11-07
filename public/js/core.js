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
const CUR = () => (W.state ? W.state.settings.currency : '₳');
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
// HTML-escape a string for safe interpolation into innerHTML templates.
// (This used to be an identity function with an escaper's name — a footgun
// waiting for its first caller; nothing calls it yet.)
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ---------- lookups ---------- */
const S = () => W.state;
const entById = (id) => S() && S().entities.find(e => e.id === id);
const provById = (id) => S() && S().provinces.find(p => p.id === id);
// The going wage (₳/day, the economy's reference worker) in a province — public
// labour-market data (filterState ships vars.wage to everyone) — or across
// the country when the province has none.
function goingWageClient(provinceId) {
  const p = provinceId && provById(provinceId);
  if (p && p.vars && p.vars.wage > 0) return p.vars.wage;
  const ws = ((S() && S().provinces) || []).map(x => x.vars && x.vars.wage).filter(w => w > 0);
  return ws.length ? ws.reduce((a, b) => a + b, 0) / ws.length : 0;
}
// What a site pays each employee per turn — mirrors server sim.wageFor: its
// own wage, else its company's, else (state, character or party sites) the
// going wage in its province.
function wageForClient(pr) {
  if (!pr) return 0;
  if (pr.wagePerTurn !== undefined) return Math.max(0, Number(pr.wagePerTurn) || 0);
  const owner = entById(pr.ownerId);
  if (owner && owner.type === 'company') return Math.max(0, Number(owner.wagePerTurn === undefined ? goingWageClient(pr.provinceId) : owner.wagePerTurn) || 0);
  return goingWageClient(pr.provinceId);
}
const cityById = (id) => S() && S().cities.find(c => c.id === id);
const propById = (id) => S() && S().properties.find(p => p.id === id);
const markerById = (id) => S() && (S().markers || []).find(m => m.id === id);
const itemById = (id) => S() && S().items.find(i => i.id === id);
const acctById = (id) => S() && S().accounts.find(a => a.id === id);
// Global GM economy levers (Economy tab): records keep their authored values,
// so these return the EFFECTIVE numbers the engine actually charges/pays this
// turn. effPrice is the domestic sale price (domesticMultiplier). Securities/
// deeds are market-driven instruments (day price / property value) — the price
// levers deliberately do not touch them.
const econMult = (key) => {
  const e = (S() && S().settings && S().settings.economy) || {};
  const v = e[key];
  return v !== undefined && isFinite(Number(v)) ? Number(v) : 1;
};
const effPrice = (it) => {
  if (!it) return 0;
  if (it.category === 'Securities' || it.category === 'Deeds') return it.marketValue || 0;
  return (it.marketValue || 0) * econMult('domesticMultiplier');
};
const effUpkeep = (pr) => (pr && pr.expenses || 0) * econMult('expensesMultiplier');
const entName = (id) => { const e = entById(id); return e ? e.name : '—'; };
const perms = () => (W.me ? W.me.role.perms : { pages: [], mapLayers: [] });
const can = (page) => perms().pages && perms().pages.includes(page);
const isGM = () => !!perms().gm;
const myEntity = () => (W.me && W.me.entityId ? entById(W.me.entityId) : null);

/* ---------- ownership & market mirrors ----------
   Client-side mirrors of server/ownership.js and server/market.js, used by
   views to gate UI without a round-trip. Same one-hop links: ownerId, ceoId,
   party leaderId, majority shareholding. Chains compose; depth-capped and
   cycle-safe. The server re-checks everything, so these only affect what is
   shown, never what is allowed. */
function ownership_directlyControlsClient(controllerId, e) {
  if (!e || !controllerId) return false;
  if (e.ownerId && e.ownerId === controllerId) return true;
  if (e.ceoId && e.ceoId === controllerId) return true;
  if (e.type === 'party' && e.leaderId === controllerId) return true;
  // presidency: executives on government-type entities share control
  // (mirrors server/ownership.js — supports co-presidents)
  if (e.type === 'government' && Array.isArray(e.executives) && e.executives.includes(controllerId)) return true;
  if (e.sharesOutstanding && Array.isArray(e.shareholders)) {
    const held = e.shareholders.filter(s => s.entityId === controllerId).reduce((sum, s) => sum + (s.shares || 0), 0);
    if (held > e.sharesOutstanding / 2) return true;
  }
  return false;
}
// The set of entity ids the current user's entity controls (incl. itself).
function ownershipSetClient(rootEntityId) {
  const root = rootEntityId || (W.me && W.me.entityId);
  const set = new Set();
  if (!root || !S()) return set;
  set.add(root);
  let frontier = [root], depth = 0;
  while (frontier.length && depth < 6) {
    const next = [];
    for (const controllerId of frontier) {
      for (const e of S().entities) {
        if (set.has(e.id)) continue;
        if (ownership_directlyControlsClient(controllerId, e)) { set.add(e.id); next.push(e.id); }
      }
    }
    frontier = next; depth++;
  }
  return set;
}
function ownership_controlsClient(rootEntityId, targetEntityId) {
  if (!rootEntityId || !targetEntityId) return false;
  if (rootEntityId === targetEntityId) return true;
  return ownershipSetClient(rootEntityId).has(targetEntityId);
}
// Phase 36 — delegated authority. S().myGrants (server filterState) holds
// the live roster grants this operator has on entities OUTSIDE their own
// chain; until now the desks only ever offered chain entities, so a member
// delegated "Spend money" or "Buy/sell items" could never find what they
// had been trusted with. Mirrors server ownership.canAct: chain first, then
// the grant's scopes (plus its account/property narrowing).
function grantCoversClient(entityId, scope) {
  const g = ((S() && S().myGrants) || {})[entityId];
  return !!g && (g.scopes.includes('all') || g.scopes.includes(scope));
}
// The chain plus every entity whose grant covers `scope`.
function actsForSetClient(scope) {
  const set = ownershipSetClient();
  for (const id in ((S() && S().myGrants) || {})) if (grantCoversClient(id, scope)) set.add(id);
  return set;
}
// May this operator move money out of account `a`? (chain, or a 'spend'
// grant whose account list — empty = all — includes it)
function canSpendFromClient(a, chain) {
  if (!a) return false;
  if (isGM() || (chain || ownershipSetClient()).has(a.ownerId)) return true;
  if (!grantCoversClient(a.ownerId, 'spend')) return false;
  const g = S().myGrants[a.ownerId];
  return !g.accounts.length || g.accounts.includes(a.id);
}
// Shares not yet allocated to any holder — what the market maker sells from.
// Mirrors server market.heldTotal: the X100 leveraged book also holds real
// float shares, so it counts against the sellable float (market.js).
function market_treasuryPoolClient(co) {
  const held = (co.shareholders || []).reduce((s, r) => s + (r.shares || 0), 0)
    + Object.values(co.x100 || {}).reduce((s, p) => s + ((p && p.qty) || 0), 0);
  return Math.max(0, (co.sharesOutstanding || 0) - held);
}
// X100 leveraged position value at a given day quote — mirrors
// server/market.js's x100Value (Phase 34): each position tracks the day price
// with the GM-tuned multiplier (settings.economy.x100Mult, shipped in S().x100)
// from its entry price, floored at 0.
function market_x100ValueClient(pos, price) {
  const m = (S().x100 && S().x100.mult) || 100;
  if (!pos || !(pos.qty > 0) || !(pos.entry > 0)) return 0;
  return pos.qty * pos.entry * Math.max(0, 1 + m * (price / pos.entry - 1));
}
function market_x100LockSec() {
  const x = S().x100;
  return x && x.lockSec !== undefined ? Number(x.lockSec) : 60;
}
// Real seconds still locked before a leveraged position can be sold (0 =
// unlocked). Mirrors the server's sell() gate (real wall-clock seconds, GM
// tunable via settings.economy.x100LockSec).
function market_x100LockLeftClient(pos) {
  const lock = market_x100LockSec() * 1000;
  if (!pos || !pos.at) return 0;
  return Math.max(0, (pos.at + lock - Date.now()) / 1000);
}
function market_x100HoldingOfClient(co, entityId) {
  const p = (co.x100 || {})[entityId];
  return p ? p.qty : 0;
}
function market_x100EntryOfClient(co, entityId) {
  return (co.x100 || {})[entityId] || null;
}
// Ordinary-share cost basis from the register row (Phase 34: buy() records
// the holder's average entry price) — null when unknown/never bought.
function market_holdEntryOfClient(co, entityId) {
  const sh = (co.shareholders || []).find(x => x.entityId === entityId);
  return sh && sh.entry ? sh.entry : null;
}
// Shares that count toward valuation / market cap: all outstanding EXCEPT
// freshly-floated primary stock no real investor has subscribed to yet (mirrors
// server market.valuedShares — floating unsold stock must not inflate cap).
function market_valuedSharesClient(co) {
  const primary = Math.min((co.vars && co.vars.primaryPool) || 0, market_treasuryPoolClient(co));
  return Math.max(0, (co.sharesOutstanding || 0) - primary);
}
// Effective government tariff (%) on an open-market trade — mirrors
// sim.tradeTariffRate: global + per-country + per-company, import/export apart.
function tradeTariffRateClient(side, holder, partnerId, itemId) {
  const tf = S().settings.trade && S().settings.trade.tariffs;
  if (!tf || !holder) return 0;
  if (holder.type === 'government' || holder.id === 'ent_gov') return 0;
  const key = side === 'sell' ? 'export' : 'import';
  const num = (o) => (o && Number(o[key])) || 0;
  const rate = num(tf.global) + num(tf.byCountry && tf.byCountry[partnerId]) + num(tf.byCompany && tf.byCompany[holder.id]) + num(tf.byItem && tf.byItem[itemId]);
  return Math.max(0, Math.min(90, rate));
}

const TYPE_LABEL = { person: 'Person', company: 'Company', party: 'Political Party', government: 'Government', foreign: 'Foreign Power', org: 'Organisation' };
// property kinds that serve as airfields (server/war.js AIRFIELD_KINDS)
const MAP_AIRFIELD_KINDS = { airport: true, airbase: true, military_base: true };
const KIND_GLYPH = { factory: 'F', office: 'O', bank: 'B', house: 'H', mine: 'M', farm: 'A', government: 'G', military_base: 'X', fort: 'T', port: 'P', airport: 'V', airbase: 'W', university: 'U', infrastructure: 'I', prison: 'J' };
// Assignable SVG map icons (Phase 1.5). Filenames (no extension) under
// public/assets/icons/. Properties and event markers may carry an `icon`
// naming one of these; the map renders /assets/icons/<icon>.svg in place of the
// letter glyph / emoji. Hardcoded manifest — no directory listing.
const ICON_MANIFEST = ['airport', 'factory', 'port', 'military', 'mine', 'farm', 'bank', 'government', 'university', 'rail-station', 'radio-mast', 'star'];
const iconHref = (name) => '/assets/icons/' + name + '.svg';

// UI icons — the interface's own pictograms, drawn in the same hand as the
// map icons above (24×24, solid, currentColor) and inlined so each takes the
// colour and size of the text it sits in. They stand where colour emoji used
// to: an emoji renders in the device's emoji font, in its own colours, and
// looks different on every platform — never in the paper-and-ink palette.
// ico(name) for HTML (el() children, toasts, labels, buttons); icoG() for
// drawing the same glyph inside an svg (map labels, war badges).
const ICO_LINE = ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const UI_ICONS = {
  warn: '<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>',
  gear: '<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>',
  brush: '<path d="M7 14c-1.66 0-3 1.34-3 3 0 1.31-1.16 2-2 2 .92 1.22 2.49 2 4 2 2.21 0 4-1.79 4-4 0-1.66-1.34-3-3-3zm13.71-9.37l-1.34-1.34c-.39-.39-1.02-.39-1.41 0L9 12.25 11.75 15l8.96-8.96c.39-.39.39-1.02 0-1.41z"/>',
  hand: '<path d="M23 5.5V20c0 2.2-1.8 4-4 4h-7.3c-1.08 0-2.1-.43-2.85-1.19L1 14.83s1.26-1.23 1.3-1.25c.22-.19.49-.29.79-.29.22 0 .42.06.6.16.04.01 4.31 2.46 4.31 2.46V4c0-.83.67-1.5 1.5-1.5S11 3.17 11 4v7h1V1.5c0-.83.67-1.5 1.5-1.5S15 .67 15 1.5V11h1V2.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5V11h1V5.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5z"/>',
  dove: '<path d="M21.5 6.2l-2.3-.9C18.4 4 16.6 3.6 15.3 4.6c-1 .8-1.4 2-1.4 3.2L9 3C8.4 6 9 8.7 10.6 10.6L4 9c.6 3 2.7 5.3 5.6 6l-3.1 3.2L2 19.4c3 1.6 6.6 1.3 9.3-.6l2.4 2.9.9-3.4c2.7-1.6 4.4-4.5 4.4-7.7V7.3z"/>',
  megaphone: '<path d="M3 9v6h4l6 4V5L7 9H3z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19.2 6a8.6 8.6 0 0 1 0 12"' + ICO_LINE + '/>',
  ticket: '<path d="M22 10V6c0-1.11-.9-2-2-2H4c-1.1 0-1.99.89-1.99 2v4c1.1 0 1.99.9 1.99 2s-.89 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2s.9-2 2-2zm-9 7.5h-2v-2h2v2zm0-4.5h-2v-2h2v2zm0-4.5h-2v-2h2v2z"/>',
  bolt: '<path d="M7 2v11h3v9l7-12h-4l4-8z"/>',
  search: '<path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>',
  worker: '<path d="M6 9.5a6 6 0 0 1 12 0z"/><rect x="4" y="9.5" width="16" height="2" rx="1"/><path d="M8.5 12.8a3.5 3.5 0 0 0 7 0z"/><path d="M4 22c0-3.6 3.6-5.8 8-5.8s8 2.2 8 5.8z"/>',
  radiation: '<path d="M7 3.34A10 10 0 0 1 17 3.34L13.8 8.88A3.6 3.6 0 0 0 10.2 8.88ZM22 12A10 10 0 0 1 17 20.66L13.8 15.12A3.6 3.6 0 0 0 15.6 12ZM7 20.66A10 10 0 0 1 2 12L8.4 12A3.6 3.6 0 0 0 10.2 15.12Z"/><circle cx="12" cy="12" r="2.2"/>',
  burst: '<path d="M12 0.8L13.99 7.2L19.92 4.08L16.8 10.01L23.2 12L16.8 13.99L19.92 19.92L13.99 16.8L12 23.2L10.01 16.8L4.08 19.92L7.2 13.99L0.8 12L7.2 10.01L4.08 4.08L10.01 7.2Z"/>',
  fire: '<path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z"/>',
  flood: '<path d="M2 7c2.5-2 4.5-2 7 0s4.5 2 7 0 4.5-2 6 0M2 12.5c2.5-2 4.5-2 7 0s4.5 2 7 0 4.5-2 6 0M2 18c2.5-2 4.5-2 7 0s4.5 2 7 0 4.5-2 6 0"' + ICO_LINE + '/>',
  quake: '<path d="M2 12h4l2.5-7 3.5 14 3-10 2 5 1.5-2H22"' + ICO_LINE + '/>',
  storm: '<circle cx="12" cy="12" r="3.6"' + ICO_LINE + ' stroke-width="2.4"/><path d="M12 8.4C12 4.6 15.4 2.4 20 3.6M12 15.6c0 3.8-3.4 6-8 4.8"' + ICO_LINE + ' stroke-width="2.4"/>',
  volcano: '<path d="M1.5 21.5l6.5-9.5h2.2l1.8 1.8 1.8-1.8H16l6.5 9.5z"/><circle cx="10.3" cy="7" r="2.1"/><circle cx="14.2" cy="4.6" r="2.6"/><circle cx="12.6" cy="9.4" r="1.5"/>',
  toxic: '<path d="M6.5 15.5a4.5 4.5 0 0 1-.6-8.96A6.5 6.5 0 0 1 18.3 7.1a4.2 4.2 0 0 1-.3 8.4z"/><circle cx="7.5" cy="19.6" r="1.5"/><circle cx="12" cy="21" r="1.5"/><circle cx="16.5" cy="19.6" r="1.5"/>',
  pin: '<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>',
  person: '<path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>',
  swords: '<g transform="rotate(45 12 12)"><path d="M10.7 3.6L12 1.2l1.3 2.4V14.8h-2.6z"/><path d="M7.4 14.8h9.2v2.1H7.4zM10.9 16.9h2.2v3.9h-2.2z"/><circle cx="12" cy="22" r="1.6"/></g><g transform="rotate(-45 12 12)"><path d="M10.7 3.6L12 1.2l1.3 2.4V14.8h-2.6z"/><path d="M7.4 14.8h9.2v2.1H7.4zM10.9 16.9h2.2v3.9h-2.2z"/><circle cx="12" cy="22" r="1.6"/></g>',
  tools: '<g transform="rotate(42 12 12)"><path d="M11 7.5h2V22h-2z"/><path d="M7.5 2.5h9v5h-9z"/></g><g transform="rotate(-42 12 12)"><path d="M11 6h2V22h-2z"/><path d="M3.5 7C7 3.4 17 3.4 20.5 7l-1.2 1.4C15.8 5.7 8.2 5.7 4.7 8.4z"/></g>',
  plane: '<path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>',
  fuel: '<path d="M5 3h8a1 1 0 0 1 1 1v17H4V4a1 1 0 0 1 1-1zm1 2v5h6V5z" fill-rule="evenodd"/><path d="M14 10.5h1.6a1 1 0 0 1 1 1V18a1.6 1.6 0 0 0 3.2 0V8.4L17.2 5.8"' + ICO_LINE + ' stroke-width="1.8"/>',
  trash: '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>',
  next: '<path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>',
  lock: '<path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>',
  unlock: '<path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/>',
  hourglass: '<path d="M6 2h12v2h-1v3.5L13.5 12l3.5 4.5V20h1v2H6v-2h1v-3.5l3.5-4.5L7 7.5V4H6z"/>',
  ruler: '<path d="M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 10H3V8h2v4h2V8h2v4h2V8h2v4h2V8h2v4h2V8h2v8z"/>',
  plus: '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>',
  helmet: '<path d="M3.5 14.5a8.5 8.5 0 0 1 17 0V16h2v2.5h-21V16h2z"/><path d="M7 19.6c1.6 2 8.4 2 10 0"' + ICO_LINE + ' stroke-width="1.6"/>',
  peace: '<circle cx="12" cy="12" r="9"' + ICO_LINE + '/><path d="M12 3v18M12 12l-6.36 6.36M12 12l6.36 6.36"' + ICO_LINE + '/>',
  flag: '<path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/>',
  pen: '<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>',
  undo: '<path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/>',
  spade: '<path d="M12 2C9 6 3 9.5 3 14a4.5 4.5 0 0 0 7.6 3.3L9.5 22h5l-1.1-4.7A4.5 4.5 0 0 0 21 14c0-4.5-6-8-9-12z"/>',
  heart: '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>',
  diamond: '<path d="M12 2l8 10-8 10-8-10z"/>',
  club: '<circle cx="12" cy="7" r="4.3"/><circle cx="6.8" cy="14" r="4.3"/><circle cx="17.2" cy="14" r="4.3"/><path d="M11 12h2l1.6 10H9.4z"/>'
};
function ico(name, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ico' + (cls ? ' ' + cls : ''));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = UI_ICONS[name] || '';
  return svg;
}
// a war or a protest, by its emblem (crossed swords · hammer and pick)
const conflictIco = (kind) => ico(kind === 'protest' ? 'tools' : 'swords');
// An authored icon field (item chips, map markers) as text: a letter or
// symbol stays as typed; an emoji falls back (it would render in colour).
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u;
function glyphText(icon, fallback) {
  return icon && !EMOJI_RE.test(icon) ? icon : fallback;
}
// The glyph as an svg <g>, `size` units square with its top-left at (x, y);
// fills with currentColor, so give it a class that sets `color` (or a fill).
function icoG(name, x, y, size, cls) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('transform', 'translate(' + x + ' ' + y + ') scale(' + (size / 24) + ')');
  g.setAttribute('fill', 'currentColor');
  if (cls) g.setAttribute('class', cls);
  g.innerHTML = UI_ICONS[name] || '';
  return g;
}

/* ---------- optimistic outbox ----------
   The war layer's optimistic-order outbox (docs/WAR.md "Client-side
   prediction"), generalised: an action paints its EXPECTED result into
   W.state immediately, so the UI answers the click at 0ms instead of after a
   server round-trip. Entries re-apply across incoming authoritative state
   swaps until their own POST settles (the response's sync payload carries the
   real result, so the guess is discarded, never trusted). Purely cosmetic —
   the server re-checks everything; a wrong guess is corrected one round-trip
   later by server truth. */
const Optimistic = {
  _pending: [], _seq: 0,
  apply(fn) {
    const id = ++this._seq;
    this._pending.push({ id, fn, at: Date.now() });
    try { fn(W.state); W._localRev = (W._localRev || 0) + 1; } catch (e) { /* guess only */ }
    renderOrDefer();
    return id;
  },
  settle(id) { this._pending = this._pending.filter(p => p.id !== id); },
  // after every authoritative state swap: re-paint guesses whose POST is
  // still in flight (8s expiry — a hung request must not pin stale numbers)
  reapply() {
    const now = Date.now();
    this._pending = this._pending.filter(p => now - p.at < 8000);
    for (const p of this._pending) { try { p.fn(W.state); } catch (e) { /* guess only */ } }
    if (this._pending.length) W._localRev = (W._localRev || 0) + 1;
  }
};

/* ---------- API ---------- */
// opts.optimistic: fn(state) applied locally before the request round-trips —
// see Optimistic above. Used by hot gameplay actions (transfers, market
// orders) so a slow backend never sits between a click and its feedback.
async function api(method, path, body, opts) {
  opts = opts || {};
  const opt = opts.optimistic ? Optimistic.apply(opts.optimistic) : null;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    if (opt) { Optimistic.settle(opt); scheduleRefresh(true); } // roll the guess back to server truth
    throw e;
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* stream or empty */ }
  // settle BEFORE applying the response sync: the payload already contains
  // this write's real effect, so re-applying the guess would double-count it.
  if (opt) Optimistic.settle(opt);
  if (!res.ok) {
    if (opt) scheduleRefresh(true); // the guess painted a result that didn't happen — refetch truth
    throw new Error((data && data.error) || ('HTTP ' + res.status));
  }
  if (method !== 'GET' && !path.startsWith('/api/auth/')) {
    // Response-sync: mutating responses carry the freshly-committed,
    // permission-filtered world (server/api.js attachSync) — apply it here
    // and the write is on screen in ONE round-trip, no refetch. Fallback to
    // the old forced refetch when the payload is absent. The fallback MUST
    // mirror the server's SYNC_SKIP list: those endpoints deliberately opt
    // out of carrying a sync payload, and forcing a refetch for them anyway
    // defeated that (every News "mark read" ping re-fetched + re-rendered
    // the whole app). War orders do neither: the war heartbeat +
    // client prediction own that path, and the old per-order full refetch
    // was pure overhead on top of them.
    const SYNC_SKIP = /^\/api\/(auth\/|war\/|gm\/war\/|stream$|config$|cron$|news\/read$|me\/office$)/;
    if (data && data.sync) applySync(data.sync);
    else if (!SYNC_SKIP.test(path)) scheduleRefresh(true);
  }
  return data;
}
const GET = (p) => api('GET', p);
const POST = (p, b, opts) => api('POST', p, b || {}, opts);
const PATCH = (p, b, opts) => api('PATCH', p, b || {}, opts);
const PUT = (p, b, opts) => api('PUT', p, b || {}, opts);
const DEL = (p, opts) => api('DELETE', p, undefined, opts);

/* ---------- live stream + refresh ---------- */
// Local hosting pushes over SSE. Cloud hosting (Vercel + Supabase) has no
// held-open connections, so we subscribe to a Supabase Realtime broadcast
// channel instead — with a slow poll as belt-and-braces.
let sse = null, pollTimer = null;
let rtBackoff = 2000;
let winWakeBound = false; // guards against double-registering visibilitychange/focus across reconnects
function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => fail(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}
// Subscribes to both the app's own broadcast pings and postgres_changes on
// world_version (belt-and-braces — broadcasts sometimes never arrive on
// Supabase's free tier). Re-subscribes with backoff on any non-SUBSCRIBED
// status instead of silently going dark.
function subscribeRealtime(client) {
  const ch = client.channel('world')
    .on('broadcast', { event: 'sync' }, () => scheduleRefresh())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'world_version' }, () => scheduleRefresh())
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') { rtBackoff = 2000; scheduleRefresh(); } // catch up on anything missed while offline
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setTimeout(() => { try { client.removeChannel(ch); } catch (e) { } subscribeRealtime(client); }, rtBackoff);
        rtBackoff = Math.min(rtBackoff * 2, 30000);
      }
    });
}
async function connectStream() {
  let cfg = { realtime: 'sse' };
  try { cfg = await GET('/api/config'); } catch (e) { /* older server: default to SSE */ }

  if (cfg.ephemeral && isGM() && !document.getElementById('ephemeral-banner')) {
    // a toast is missable — this stays up until dismissed, every session,
    // because the world WILL be lost on the next redeploy or cold start
    const banner = el('div#ephemeral-banner', {
      style: 'position:fixed; top:0; left:50%; transform:translateX(-50%); z-index:9999;' +
        'background:#7a2620; color:#f5eede; padding:8px 16px; font-family:var(--font-mono);' +
        'font-size:11px; letter-spacing:.06em; display:flex; gap:14px; align-items:center;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.35);'
    },
      el('span', ico('warn'), ' NO DATABASE — THE WORLD RESETS ON EVERY REDEPLOY. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (see DEPLOY.md), or export the world regularly.'),
      el('button', { style: 'background:none; border:1px solid #f5eede; color:#f5eede; cursor:pointer; padding:2px 8px; font-family:inherit;', onclick: () => banner.remove() }, 'DISMISS'));
    document.body.appendChild(banner);
  }

  if (!winWakeBound) {
    winWakeBound = true;
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleRefresh(); });
    window.addEventListener('focus', () => scheduleRefresh());
  }

  if (cfg.realtime === 'supabase' && cfg.supabaseUrl && cfg.supabaseAnonKey) {
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
      const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      subscribeRealtime(client);
    } catch (e) { console.warn('Realtime unavailable, polling instead:', e.message); }
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => scheduleRefresh(), 20000);
    return;
  }

  if (sse) sse.close();
  sse = new EventSource('/api/stream');
  sse.addEventListener('sync', () => scheduleRefresh());
  // after a dropped connection reconnects, catch up on anything missed
  sse.onopen = () => scheduleRefresh();
  sse.onerror = () => { /* EventSource retries automatically */ };
}
// True while the map editor holds unsaved local edits INSIDE W.state (pointer
// drags, half-drawn lines, a pending debounced save) — swapping in fresh
// server state would orphan those edits, so the fetch itself must wait.
function mapEditBusy() {
  return !!(window.MapEdit && MapEdit.active && (MapEdit.drawing || MapEdit.dragging || MapEdit.saveTimer));
}
// True while a re-RENDER would clobber in-progress editing or destroy
// keystrokes mid-type. Fetching fresh state is safe during all of these
// (drafts live in their own objects, not in W.state) — only the rebuild of
// the DOM has to wait. This is what makes saves stick: after a write the
// client always holds the server-confirmed world, so any later interaction
// re-renders from CURRENT data instead of silently reverting to stale state.
function editingBusy() {
  if (mapEditBusy()) return true;
  if (window.Entertainment && Entertainment.spinning) return true; // don't rebuild the roulette table mid-spin
  // A casino round or a freshly-shown result is on screen: an unrelated sync
  // (another player, an autosave, a turn) must not tear down and re-animate the
  // cards/wheel out from under the player. State still updates underneath; only
  // the re-render waits (Workstream E1).
  if (window.Entertainment && Entertainment.busy && Entertainment.busy()) return true;
  if (W.inspEdit) return true;   // inspector inline-edit draft open
  const ae = document.activeElement;
  if (ae && ae.id === 'exp-search') return false; // search box shouldn't block sync
  if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return true;  // typing anywhere (forms, modals, GM studio)
  return false;
}
// One pending "render when the user frees up" loop. Armed by refreshState
// when a render had to be deferred; collapses any number of refreshes.
let renderPending = false;
function tryDeferredRender() {
  if (!renderPending) return;
  if (editingBusy()) { setTimeout(tryDeferredRender, 800); return; }
  renderPending = false;
  App.renderAll();
}
let pendingForce = false;
function scheduleRefresh(force) {
  if (force) pendingForce = true; // a write's own refetch must apply, version guard or not
  // Never swap in fresh state mid-interaction in the map editor: pointer
  // drags and half-drawn lines mutate objects inside the CURRENT state, and
  // replacing it would orphan those edits (the old "edits reset / don't
  // apply" bug). Retry shortly — the interaction ends within a second or two.
  if (mapEditBusy()) {
    if (!W._refreshRetry) W._refreshRetry = setTimeout(() => { W._refreshRetry = null; scheduleRefresh(); }, 900);
    return;
  }
  if (W.refreshTimer) return;
  W.refreshTimer = setTimeout(async () => {
    W.refreshTimer = null;
    const f = pendingForce; pendingForce = false;
    try { await refreshState(f); } catch (e) { /* transient */ }
  }, 250);
}
// Render now unless the user is mid-edit/mid-type — then arm the deferred
// loop. Every authoritative or optimistic state change funnels through this.
function renderOrDefer() {
  if (editingBusy()) { renderPending = true; tryDeferredRender(); return; }
  renderPending = false;
  App.renderAll();
}
// Apply a response-sync payload (mutation responses carry {v, user, state,
// polling} — see server/api.js attachSync). Same guards as refreshState:
// never during a map-editor interaction, never a world older than rendered.
function applySync(sync) {
  if (!sync || !sync.state) return;
  if (mapEditBusy()) { scheduleRefresh(true); return; } // let the deferring refetch path handle it
  if (sync.v !== undefined && lastV !== undefined && sync.v < lastV) return; // stale — a newer world is already on screen
  if (sync.user) W.me = sync.user;
  W.state = sync.state;
  if (sync.v !== undefined) lastV = lastV === undefined ? sync.v : Math.max(lastV, sync.v);
  if (sync.polling !== undefined) W.polling = sync.polling;
  Optimistic.reapply();
  renderOrDefer();
}
let lastV = undefined, refreshSeq = 0;
async function refreshState(force) {
  const seq = ++refreshSeq;
  // ?ifv=: tell the server which version we already hold — when unchanged it
  // answers with a tiny envelope instead of the full filtered world, which
  // makes the 20s fallback poll and post-write broadcast echoes nearly free.
  // Forced refreshes always fetch in full (they exist to re-pull our own
  // write even when versions look equal).
  const useIfv = !force && lastV !== undefined && W.state;
  const data = await GET('/api/state' + (useIfv ? '?ifv=' + encodeURIComponent(lastV) : ''));
  // overlapping refreshes (realtime ping + poll + post-write refetch) can
  // resolve out of order — only the newest issued request may apply, and never
  // a world OLDER than one already rendered (v is monotonic server-side).
  // Applying a late stale response is what made turns "reverse" and fresh
  // road edits vanish.
  if (seq !== refreshSeq) return;
  // a map-editor interaction may have started while this GET was in flight —
  // re-check right before the swap and defer the same way scheduleRefresh does.
  if (mapEditBusy()) {
    if (!W._refreshRetry) W._refreshRetry = setTimeout(() => { W._refreshRetry = null; scheduleRefresh(); }, 900);
    return;
  }
  if (data.unchanged) {
    W.me = data.user || W.me; // identity/role stay fresh even on the cheap path
    return;
  }
  if (data.v !== undefined && lastV !== undefined && W.state) {
    // force may re-apply the SAME version (its whole point: own writes must
    // stick) but even a forced apply must never regress to an older world.
    if (force ? data.v < lastV : data.v <= lastV) { W.me = data.user; return; }
  }
  W.me = data.user;
  W.state = data.state;
  if (data.v !== undefined) lastV = data.v;
  // per-province party support (public political knowledge) — cached so the
  // province/city dossiers can draw voter-base pies synchronously. Bundled
  // into /api/state now; the separate endpoint remains as a fallback.
  if (data.polling !== undefined) W.polling = data.polling;
  else { try { W.polling = await GET('/api/polling'); } catch (e) { W.polling = null; } }
  Optimistic.reapply();
  // Rendering waits until the user stops typing/editing, but the fresh state
  // above is already live — no interaction can revert to pre-save data.
  renderOrDefer();
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
  // Open choices instead of a dropdown: every option visible as a chip, the
  // chosen one lit. For short lists (a policy level, a province, a side).
  // options: [[value, label, hint?]]; hint shows as the chip's tooltip.
  seg(obj, key, options, onchange) {
    if (obj[key] === undefined && options.length) obj[key] = options[0][0];
    const row = el('div.seg-row');
    const paint = () => { for (const b of row.children) b.classList.toggle('active', String(obj[key]) === b.dataset.v); };
    for (const o of options) {
      row.appendChild(el('button.seg-opt', { type: 'button', 'data-v': String(o[0]), title: o[2] || undefined,
        onclick: () => { obj[key] = o[0]; paint(); if (onchange) onchange(o[0]); } }, o[1]));
    }
    paint();
    return row;
  },
  // A searchable, always-open pick list for long lists (people, companies,
  // items): type to narrow, click to choose. options: [[value, label, sub?]].
  pick(obj, key, options, opts) {
    opts = opts || {};
    const wrap = el('div.pick-wrap');
    const search = el('input.text-input', { placeholder: opts.placeholder || 'Search…' });
    const list = el('div.pick-list', { style: opts.height ? `max-height:${opts.height}px;` : undefined });
    const render = () => {
      const q = search.value.trim().toLowerCase();
      clear(list);
      let rows = options.filter(o => !q || String(o[1]).toLowerCase().includes(q) || String(o[2] || '').toLowerCase().includes(q)).slice(0, opts.max || 60);
      // the current choice stays in view even past the cap
      const cur = options.find(o => String(o[0]) === String(obj[key]));
      if (cur && !q && !rows.includes(cur)) rows = [cur, ...rows];
      for (const o of rows) {
        list.appendChild(el('div.pick-item', { class: String(obj[key]) === String(o[0]) ? 'selected' : '',
          onclick: () => { obj[key] = o[0] === '__null__' ? null : o[0]; render(); if (opts.onchange) opts.onchange(obj[key]); } },
          el('span', o[1]), o[2] ? el('span.pi-sub', o[2]) : null));
      }
      if (!rows.length) list.appendChild(el('div', { style: 'padding:10px; color:var(--ink-faint); font-size:12px;' }, 'No match.'));
    };
    search.addEventListener('input', render);
    render();
    wrap.appendChild(search); wrap.appendChild(list);
    wrap._render = render; // callers that change obj[key] from outside repaint with this
    return wrap;
  },
  color(obj, key) {
    return el('input', { type: 'color', value: obj[key] || '#5c5340', style: 'width:52px; height:28px; border:1px solid var(--rule-strong); background:transparent; cursor:pointer;', oninput: (e) => obj[key] = e.target.value });
  },
  // range slider bound into a draft, with a live mono readout. opts: { suffix,
  // step, format(v), onInput } — writes Number into obj[key] on input.
  slider(obj, key, min, max, opts) {
    opts = opts || {};
    const fmt = opts.format || ((v) => v + (opts.suffix || ''));
    const val = Number(obj[key]);
    const readout = el('span.slider-val', fmt(isFinite(val) ? val : min));
    const input = el('input.slider-input', {
      type: 'range', min: String(min), max: String(max), step: String(opts.step || 1),
      value: String(isFinite(val) ? val : min),
      oninput: (e) => {
        obj[key] = Number(e.target.value);
        readout.textContent = fmt(obj[key]);
        if (opts.onInput) opts.onInput(obj[key]);
      }
    });
    return el('div.slider-row', input, readout);
  },
  // Draggable slider WITH a typing box — both bound to obj[key], kept in sync.
  // opts: { step, suffix, onInput, allowBeyondRange }. Used anywhere a value
  // wants both a quick drag and an exact keyed entry (tariffs, GM editors,
  // trade multipliers, …). When allowBeyondRange is true there is NO upper
  // cap: typed values beyond the slider's quick-pick range are kept verbatim
  // and the track itself stretches to follow them.
  sliderNum(obj, key, min, max, opts) {
    opts = opts || {};
    const step = opts.step || 1;
    const clampRange = (v) => Math.max(min, Math.min(max, isFinite(v) ? v : min));
    const clamp = (v) => opts.allowBeyondRange
      ? Math.max(min, isFinite(v) ? v : min)
      : clampRange(v);
    const val = clamp(Number(obj[key]));
    obj[key] = val;
    const grow = (v) => { if (opts.allowBeyondRange && isFinite(v) && v > max) return v; return max; };
    const range = el('input.slider-input', { type: 'range', min: String(min), max: String(grow(val)), step: String(step), value: String(clampRange(Math.min(val, grow(val)))), style: 'flex:1;' });
    const box = el('input.text-input', { type: 'number', min: opts.allowBeyondRange ? undefined : String(min), max: opts.allowBeyondRange ? undefined : String(max), step: String(step), value: String(val), style: 'width:72px; flex:0 0 auto; text-align:right;' });
    const suffix = opts.suffix ? el('span', { style: 'font-family:var(--font-mono); font-size:11px; color:var(--ink-faint);' }, opts.suffix) : null;
    const sync = (v, from) => {
      v = clamp(Number(v)); obj[key] = v;
      range.max = String(grow(v));
      if (from !== 'range') range.value = String(clampRange(Math.min(v, grow(v))));
      if (from !== 'box') box.value = String(v);
      if (opts.onInput) opts.onInput(v);
    };
    range.addEventListener('input', () => sync(range.value, 'range'));
    box.addEventListener('input', () => sync(box.value, 'box'));
    return el('div', { style: 'display:flex; align-items:center; gap:10px;' }, range, box, suffix);
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
// Phase 36 UX: long sections (properties, items, people…) start folded so
// the sidebar reads as an index rather than a 250-row scroll; a search opens
// every matching section, and a section the operator toggled stays as set.
const EXP_FOLD_OVER = 12;
function expSection(key, label, rows, searching) {
  if (!rows.length) return null;
  const open = searching || (W.expOpen[key] !== undefined ? W.expOpen[key] : rows.length <= EXP_FOLD_OVER);
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
    expSection('prov', 'Provinces', provs.map(p => expItem('province', p.id, p.name, fmtCompact(p.vars.population), p.color)), !!q),
    expSection('city', 'Cities', cities.map(c => expItem('city', c.id, c.name, c.isCapital ? '★ capital' : '', 'var(--ink-faint)')), !!q),
    expSection('co', 'Companies', companies.map(e => expItem('entity', e.id, e.name, e.industry, e.color, e.logo)), !!q),
    expSection('party', 'Political Parties', parties.map(e => expItem('entity', e.id, e.name, (e.mpCount || 0) + ' MPs', e.color, e.logo)), !!q),
    expSection('gov', 'Government', gov.map(e => expItem('entity', e.id, e.name, '', e.color)), !!q),
    expSection('ppl', 'People', people.map(e => expItem('entity', e.id, e.name, e.title, e.color)), !!q),
    expSection('for', 'Foreign Powers', foreign.map(e => expItem('entity', e.id, e.name, e.stance, e.color, e.logo)), !!q),
    expSection('prop', 'Properties', props.map(p => expItem('property', p.id, p.name, entName(p.ownerId), (entById(p.ownerId) || {}).color)), !!q),
    expSection('item', 'Items & Markets', items.map(i => expItem('item', i.id, i.name, fmtMoney(i.marketValue), 'var(--paper-line)')), !!q)
  ];

  sections.forEach(s => s && body.appendChild(s));
  if (!body.children.length) body.appendChild(el('div', { style: 'padding:20px 16px; color:var(--ink-faint); font-family:var(--font-mono); font-size:10px; letter-spacing:.1em;' }, 'NOTHING IN THE FILES.'));
}

/* ---------- personal notifications (Phase 25 QoL) ---------- */
// Toast timeline entries that touch YOUR ownership chain (money received,
// shares moved, goods delivered…) as they arrive. Client-only: the timeline
// is already permission-filtered server-side; this just remembers the newest
// entry each operator has seen (localStorage) and toasts the delta. First
// boot seeds the marker silently so history is never replayed.
const Notify = {
  _key() { return 'arc-notif-' + (W.me ? W.me.id : 'anon'); },
  check() {
    if (!W.me || !S()) return;
    const mine = ownershipSetClient();
    if (!mine.size) return;
    const rows = (S().timeline || []).filter(t => t.refs && t.refs.some(r => mine.has(r)));
    if (!rows.length) return;
    const newest = rows[rows.length - 1].ts || 0;
    const seen = Number(localStorage.getItem(this._key()));
    if (!Number.isFinite(seen) || !seen) { localStorage.setItem(this._key(), String(newest || 1)); return; }
    const fresh = rows.filter(t => (t.ts || 0) > seen && t.actor !== W.me.displayName);
    for (const t of fresh.slice(-3)) toast([ico('megaphone'), ' ' + t.title]);
    if (newest > seen) localStorage.setItem(this._key(), String(newest));
  }
};

/* ---------- ticker ---------- */
const TICK_ICON = { system: 'gear' };
const TICK_GLYPH = { economy: '₳', news: '¶', politics: '⚑', election: '⚑', ownership: '⇄', simulation: '∴', time: '◔', market: '％', inventory: '▣', gm: '✎', event: '∴', error: '!' };
function renderTicker() {
  const track = document.getElementById('ticker-track');
  clear(track);
  const items = (S().timeline || []).slice(-14).reverse();
  for (const t of items) {
    track.appendChild(el('span.tick-item', { onclick: () => { if (can('timeline')) App.go('timeline'); }, title: (t.detail || '') },
      el('span.tt', TICK_ICON[t.type] ? ico(TICK_ICON[t.type]) : (TICK_GLYPH[t.type] || '·')),
      el('span', `T${t.turn}`),
      el('span', t.title)
    ));
  }
}
