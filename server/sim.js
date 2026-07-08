'use strict';
// Simulation engine. Everything here is generic: it executes configurable
// events made of triggers, conditions and effects. No Arcasia-specific rules.
const store = require('./store');

let broadcast = () => {};
function init(broadcastFn) { broadcast = broadcastFn; }

// ---------- tiny safe expression language --------------------------------
// numbers, + - * / %, parentheses, $var (target variable), bare identifiers
// (strings, used as function arguments), and a small function library.
function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i; while (j < src.length && /[0-9.eE]/.test(src[j])) j++;
      toks.push({ t: 'num', v: parseFloat(src.slice(i, j)) }); i = j; continue;
    }
    if (c === '$') {
      let j = i + 1; while (j < src.length && /[\w]/.test(src[j])) j++;
      toks.push({ t: 'var', v: src.slice(i + 1, j) }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < src.length && /[\w]/.test(src[j])) j++;
      toks.push({ t: 'name', v: src.slice(i, j) }); i = j; continue;
    }
    if ('+-*/%(),'.includes(c)) { toks.push({ t: c }); i++; continue; }
    throw new Error('Bad character in expression: ' + c);
  }
  return toks;
}

function evalExpr(src, ctx) {
  if (src === undefined || src === null || src === '') return 0;
  if (typeof src === 'number') return src;
  const toks = tokenize(String(src));
  let pos = 0;
  const peek = () => toks[pos];
  const eat = (t) => { const k = toks[pos]; if (!k || (t && k.t !== t)) throw new Error('Expression syntax error near token ' + pos); pos++; return k; };
  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : 0;

  function atom() {
    const k = peek();
    if (!k) throw new Error('Unexpected end of expression');
    if (k.t === 'num') { pos++; return k.v; }
    if (k.t === 'var') { pos++; return num(ctx.vars ? ctx.vars[k.v] : 0); }
    if (k.t === '(') { pos++; const v = expr(); eat(')'); return v; }
    if (k.t === '-') { pos++; return -num(atom()); }
    if (k.t === 'name') {
      pos++;
      if (peek() && peek().t === '(') {
        pos++;
        const args = [];
        if (peek() && peek().t !== ')') { args.push(expr()); while (peek() && peek().t === ',') { pos++; args.push(expr()); } }
        eat(')');
        return callFn(k.v, args, ctx);
      }
      return k.v; // bare identifier = string (for function args)
    }
    throw new Error('Unexpected token in expression');
  }
  function term() {
    let v = atom();
    while (peek() && ['*', '/', '%'].includes(peek().t)) {
      const op = eat().t; const r = atom();
      const a = num(v), b = num(r);
      v = op === '*' ? a * b : op === '/' ? (b === 0 ? 0 : a / b) : (b === 0 ? 0 : a % b);
    }
    return v;
  }
  function expr() {
    let v = term();
    while (peek() && ['+', '-'].includes(peek().t)) {
      const op = eat().t; const r = term();
      v = op === '+' ? (num(v) + num(r)) : (num(v) - num(r));
    }
    return v;
  }
  const out = expr();
  if (pos !== toks.length) throw new Error('Trailing tokens in expression');
  return typeof out === 'number' && isFinite(out) ? out : 0;
}

function findByRef(list, ref, prefixes) {
  if (!ref) return null;
  ref = String(ref);
  let hit = list.find(x => x.id === ref);
  if (hit) return hit;
  for (const p of prefixes) { hit = list.find(x => x.id === p + ref); if (hit) return hit; }
  const low = ref.toLowerCase();
  return list.find(x => (x.name && x.name.toLowerCase() === low) || (x.abbrev && x.abbrev.toLowerCase() === low)) || null;
}
const findProv = (ref) => findByRef(store.get().provinces, ref, ['prov_']);
const findEnt = (ref) => findByRef(store.get().entities, ref, ['ent_', 'per_', 'party_', 'for_', 'org_']);
const findItem = (ref) => findByRef(store.get().items, ref, ['item_', 'item_share_']);

function callFn(name, args, ctx) {
  const db = store.get();
  const n = (v) => (typeof v === 'number' && isFinite(v)) ? v : 0;
  switch (name) {
    case 'rand': return n(args[0]) + Math.random() * (n(args[1]) - n(args[0]));
    case 'round': return Math.round(n(args[0]));
    case 'floor': return Math.floor(n(args[0]));
    case 'ceil': return Math.ceil(n(args[0]));
    case 'abs': return Math.abs(n(args[0]));
    case 'sqrt': return Math.sqrt(Math.max(0, n(args[0])));
    case 'min': return Math.min(n(args[0]), n(args[1]));
    case 'max': return Math.max(n(args[0]), n(args[1]));
    case 'clamp': return Math.min(Math.max(n(args[0]), n(args[1])), n(args[2]));
    case 'turn': return db.settings.time.turn;
    case 'g': return n(db.globalVars[String(args[0])]);
    case 'prov': { const p = findProv(args[0]); return p ? n(p.vars[String(args[1])]) : 0; }
    case 'ent': { const e = findEnt(args[0]); return e ? n((e.vars || {})[String(args[1])]) : 0; }
    case 'item': { const it = findItem(args[0]); return it ? n(it.marketValue) : 0; }
    case 'pop': {
      if (String(args[0]) === 'all') return db.provinces.reduce((s, p) => s + n(p.vars.population), 0);
      const p = findProv(args[0]); return p ? n(p.vars.population) : 0;
    }
    case 'balance': { const e = findEnt(args[0]); if (!e) return 0; return db.accounts.filter(a => a.ownerId === e.id).reduce((s, a) => s + n(a.balance), 0); }
    default: throw new Error('Unknown function: ' + name);
  }
}

function interpolate(str, ctx) {
  if (!str) return '';
  const db = store.get();
  return String(str).replace(/\{([^}]+)\}/g, (m, inner) => {
    inner = inner.trim();
    if (inner === 'date') return db.settings.time.date;
    if (inner === 'turn') return String(db.settings.time.turn);
    if (inner === 'world') return db.settings.worldName;
    try {
      const v = evalExpr(inner, ctx || {});
      return typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
    } catch (e) { return m; }
  });
}

// ---------- money ---------------------------------------------------------
function primaryAccount(entityId, create) {
  const db = store.get();
  let acct = db.accounts.find(a => a.ownerId === entityId);
  if (!acct && create) {
    const ent = db.entities.find(e => e.id === entityId);
    acct = { id: store.uid('acct'), ownerId: entityId, name: (ent ? ent.name + ' ' : '') + 'Account', balance: 0 };
    db.accounts.push(acct);
  }
  return acct;
}

// Move money between accounts (null = created/destroyed at the edge of the
// world). Enforcement of balances is the caller's business — engine events
// are allowed to overdraw so the world never jams.
function txn(fromAcctId, toAcctId, amount, memo, actor, kind) {
  const db = store.get();
  amount = Math.round(amount * 100) / 100;
  if (!(amount > 0)) return null;
  const from = fromAcctId ? db.accounts.find(a => a.id === fromAcctId) : null;
  const to = toAcctId ? db.accounts.find(a => a.id === toAcctId) : null;
  if (fromAcctId && !from) throw new Error('Unknown source account');
  if (toAcctId && !to) throw new Error('Unknown destination account');
  if (from) from.balance = Math.round((from.balance - amount) * 100) / 100;
  if (to) to.balance = Math.round((to.balance + amount) * 100) / 100;
  const t = {
    id: store.uid('txn'), ts: Date.now(), turn: db.settings.time.turn, simDate: db.settings.time.date,
    from: from ? from.id : null, to: to ? to.id : null, amount, memo: memo || '', actor: actor || 'SYSTEM', kind: kind || 'transfer'
  };
  store.recordTxn(t);
  const ownerName = (a) => { if (!a) return '—'; const e = db.entities.find(x => x.id === a.ownerId); return e ? e.name : a.name; };
  store.log('economy', `${db.settings.currency}${fmtNum(amount)} ${kind === 'deposit' ? 'deposited' : kind === 'withdraw' ? 'withdrawn' : 'transferred'}`,
    `${ownerName(from)} → ${ownerName(to)}${memo ? ' · ' + memo : ''}`, actor, [from && from.ownerId, to && to.ownerId].filter(Boolean));
  if (kind === 'transfer' && amount >= (db.settings.newsThresholds.transaction || Infinity)) {
    draftNews(`Large transfer moves ${db.settings.currency}${fmtNum(amount)}`,
      `Financial circles report a transfer of ${db.settings.currency}${fmtNum(amount)} from ${ownerName(from)} to ${ownerName(to)}.${memo ? ' The stated purpose: ' + memo + '.' : ''}`, 'Business');
  }
  return t;
}

function fmtNum(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ---------- presidency ----------------------------------------------------
// Keep ent_gov's ceoId/executives in sync with whoever holds the 'president'
// role. Multiple presidents (co-presidency) share ent_gov via `executives`;
// ownership.js grants control to anyone in that array. Idempotent — returns
// false (and touches nothing) when the desired state already matches, so
// callers (including store.js migrate(), which runs on every load) never
// dirty the doc needlessly. quiet=true skips the audit-log entry (used from
// migrate, where logging on every boot would be noise).
function syncPresidency(db, quiet) {
  const gov = db.entities.find(e => e.id === 'ent_gov');
  if (!gov) return false;
  const entityIds = new Set(db.entities.map(e => e.id));
  const seen = new Set();
  const presidents = [];
  for (const u of db.users) {
    if (u.roleId === 'president' && u.entityId && entityIds.has(u.entityId) && !seen.has(u.entityId)) {
      seen.add(u.entityId);
      presidents.push(u.entityId);
    }
  }
  const prevExecutives = Array.isArray(gov.executives) ? gov.executives : [];
  const newCeo = presidents[0] || null;
  const sameSet = presidents.length === prevExecutives.length && presidents.every(id => prevExecutives.includes(id));
  if (gov.ceoId === newCeo && sameSet) return false;

  gov.ceoId = newCeo;
  gov.executives = presidents;

  if (db.settings && db.settings.country) {
    const names = presidents.map(id => { const e = db.entities.find(x => x.id === id); return e ? e.name : null; }).filter(Boolean);
    db.settings.country.leader = names.length ? names.join(' & ') : null;
  }

  for (const id of presidents) {
    const p = db.entities.find(e => e.id === id);
    if (p && p.title !== 'President of the Republic') p.title = 'President of the Republic';
  }
  for (const id of prevExecutives) {
    if (presidents.includes(id)) continue;
    const p = db.entities.find(e => e.id === id);
    if (p && p.title === 'President of the Republic') p.title = 'Former President';
  }

  if (!quiet) {
    const label = presidents.length ? presidents.map(id => { const e = db.entities.find(x => x.id === id); return e ? e.name : id; }).join(' & ') : 'vacant';
    store.log('system', `Presidency updated: ${label}`, '', 'REGISTRY', [gov.id, ...presidents]);
  }
  return true;
}

// Phase 5 — newspapers. `paperId` is optional; when the caller doesn't know
// (or care) which paper an auto-drafted article belongs to, it's derived from
// settings.newspaperRouting[category], falling back to paper_today. Existing
// call sites are unaffected: they simply omit the new last argument and get
// the routed default, same publish/draft behaviour as before.
function draftNews(headline, body, category, publish, author, paperId) {
  const db = store.get();
  const cat = category || 'General';
  const newspapers = (db.settings.newspapers || []);
  const validPaperIds = new Set(newspapers.map(p => p.id));
  const routing = db.settings.newspaperRouting || {};
  const fallback = validPaperIds.has('paper_today') ? 'paper_today' : (newspapers[0] && newspapers[0].id) || 'paper_today';
  const resolvedPaperId = (paperId && validPaperIds.has(paperId)) ? paperId : (routing[cat] || fallback);
  const a = {
    id: store.uid('news'), headline, body, category: cat,
    status: publish ? 'published' : 'draft', author: author || 'Wire Service',
    paperId: resolvedPaperId,
    ts: Date.now(), simDate: db.settings.time.date, turn: db.settings.time.turn
  };
  db.news.push(a);
  if (db.news.length > 400) db.news.splice(0, db.news.length - 400);
  store.log('news', (publish ? 'Published: ' : 'Drafted: ') + headline, cat, author || 'Wire Service', [a.id]);
  return a;
}

// ---------- effects -------------------------------------------------------
function applyOp(cur, op, val) {
  const c = typeof cur === 'number' && isFinite(cur) ? cur : 0;
  const v = op === 'set' ? val : op === 'mul' ? c * val : c + val;
  return Math.round(v * 10000) / 10000;
}

function resolveProvinceTargets(target) {
  const db = store.get();
  if (!target || target === 'all') return db.provinces.slice();
  if (target === 'random') return db.provinces.length ? [db.provinces[Math.floor(Math.random() * db.provinces.length)]] : [];
  const p = findProv(target);
  return p ? [p] : [];
}

function applyEffect(fx, meta) {
  const db = store.get();
  const actor = meta.actor || 'ENGINE';
  const src = meta.eventName || 'event';
  switch (fx.type) {
    case 'adjust_var': {
      const key = fx.key;
      if (!key) throw new Error('adjust_var needs a variable key');
      if (fx.scope === 'global') {
        db.globalVars[key] = applyOp(db.globalVars[key], fx.op, evalExpr(fx.value, { vars: db.globalVars }));
        break;
      }
      if (fx.scope === 'province') {
        const targets = resolveProvinceTargets(fx.target);
        for (const p of targets) {
          const v = evalExpr(fx.value, { vars: p.vars });
          p.vars[key] = applyOp(p.vars[key], fx.op, v);
          if (key === 'population') p.vars[key] = Math.round(p.vars[key]);
        }
        if (targets.length) store.log('simulation', `${src}: ${key} ${fx.op} on ${targets.length === db.provinces.length ? 'all provinces' : targets.map(p => p.name).join(', ')}`, '', actor, targets.map(p => p.id));
        break;
      }
      if (fx.scope === 'entity') {
        const targets = fx.target === 'all' ? db.entities : [findEnt(fx.target)].filter(Boolean);
        for (const e of targets) {
          e.vars = e.vars || {};
          e.vars[key] = applyOp(e.vars[key], fx.op, evalExpr(fx.value, { vars: e.vars }));
        }
        break;
      }
      if (fx.scope === 'property') {
        const targets = fx.target === 'all' ? db.properties : db.properties.filter(pr => pr.id === fx.target);
        for (const pr of targets) {
          const bag = { ...pr.vars, value: pr.value, income: pr.income, expenses: pr.expenses, employees: pr.employees };
          const v = evalExpr(fx.value, { vars: bag });
          if (['value', 'income', 'expenses', 'employees'].includes(key)) pr[key] = applyOp(pr[key], fx.op, v);
          else pr.vars[key] = applyOp(pr.vars[key], fx.op, v);
        }
        break;
      }
      throw new Error('Unknown adjust_var scope: ' + fx.scope);
    }
    case 'adjust_demo': {
      const provs = resolveProvinceTargets(fx.province);
      const metric = fx.metric;
      let touched = 0;
      for (const p of provs) {
        const pctx = {};
        for (const k in p.vars) pctx['p_' + k] = p.vars[k];
        for (const gname in p.demographics) {
          if (fx.group && fx.group !== 'all' && fx.group !== gname) continue;
          const g = p.demographics[gname];
          const v = evalExpr(fx.value, { vars: { ...g, ...pctx } });
          g[metric] = applyOp(g[metric], fx.op, v);
          if (metric === 'population') g[metric] = Math.round(g[metric]);
          if (['governmentSupport', 'happiness', 'economicConfidence', 'employment'].includes(metric)) g[metric] = Math.min(100, Math.max(0, g[metric]));
          touched++;
        }
        if (metric === 'population') p.vars.population = Object.values(p.demographics).reduce((s, g) => s + g.population, 0);
      }
      if (touched) store.log('simulation', `${src}: ${metric} ${fx.op} across ${touched} population group(s)`, '', actor, provs.map(p => p.id));
      break;
    }
    case 'money': {
      const amount = evalExpr(fx.amount, { vars: db.globalVars });
      if (!(amount > 0)) break;
      const fromEnt = fx.kind !== 'deposit' ? findEnt(fx.from) : null;
      const toEnt = fx.kind !== 'withdraw' ? findEnt(fx.to) : null;
      if (fx.kind !== 'deposit' && !fromEnt) throw new Error('money: unknown source entity ' + fx.from);
      if (fx.kind !== 'withdraw' && !toEnt) throw new Error('money: unknown destination entity ' + fx.to);
      txn(fromEnt ? primaryAccount(fromEnt.id, true).id : null, toEnt ? primaryAccount(toEnt.id, true).id : null,
        amount, fx.memo || src, actor, fx.kind || 'transfer');
      break;
    }
    case 'spawn_item': {
      const ent = findEnt(fx.entity); const it = findItem(fx.item);
      if (!ent || !it) throw new Error('spawn_item: unknown entity or item');
      const qty = Math.round(evalExpr(fx.qty, { vars: db.globalVars }));
      if (!qty) break;
      ent.inventory = ent.inventory || [];
      const row = ent.inventory.find(r => r.itemId === it.id);
      if (row) row.qty += qty; else ent.inventory.push({ itemId: it.id, qty });
      ent.inventory = ent.inventory.filter(r => r.qty > 0);
      store.log('inventory', `${qty > 0 ? '+' : ''}${qty} × ${it.name}`, `Inventory of ${ent.name}`, actor, [ent.id, it.id]);
      break;
    }
    case 'set_item_value': {
      const targets = fx.item === 'all'
        ? db.items.filter(it => !fx.category || it.category === fx.category)
        : [findItem(fx.item)].filter(Boolean);
      for (const it of targets) {
        const v = evalExpr(fx.value, { vars: { value: it.marketValue } });
        it.marketValue = Math.max(0, Math.round(v * 100) / 100);
      }
      if (targets.length) store.log('market', `${src}: repriced ${targets.length} item(s)`, targets.slice(0, 6).map(t => `${t.name} → ${db.settings.currency}${t.marketValue}`).join(' · '), actor, targets.map(t => t.id));
      break;
    }
    case 'transfer_property': {
      const pr = db.properties.find(p => p.id === fx.property) || findByRef(db.properties, fx.property, ['prop_']);
      const to = findEnt(fx.to);
      if (!pr || !to) throw new Error('transfer_property: unknown property or entity');
      const prev = db.entities.find(e => e.id === pr.ownerId);
      pr.ownerId = to.id;
      store.log('ownership', `${pr.name} changes hands`, `${prev ? prev.name : 'Unknown'} → ${to.name}`, actor, [pr.id, to.id]);
      draftNews(`${pr.name} changes hands`, `${pr.name} has been transferred from ${prev ? prev.name : 'unknown ownership'} to ${to.name}. The parties did not disclose terms.`, 'Business');
      break;
    }
    case 'transfer_company': {
      const co = findEnt(fx.company); const to = findEnt(fx.to);
      if (!co || !to) throw new Error('transfer_company: unknown company or entity');
      const prev = db.entities.find(e => e.id === co.ownerId);
      co.ownerId = to.id;
      store.log('ownership', `Control of ${co.name} passes to ${to.name}`, prev ? 'Previously held by ' + prev.name : '', actor, [co.id, to.id]);
      draftNews(`Control of ${co.name} changes`, `${to.name} has taken control of ${co.name}.`, 'Business');
      break;
    }
    case 'adjust_support': {
      const party = findEnt(fx.party);
      if (!party || party.type !== 'party') throw new Error('adjust_support: unknown party');
      const provs = resolveProvinceTargets(fx.province);
      const v = evalExpr(fx.value, { vars: db.globalVars });
      party.support = party.support || {};
      for (const p of provs) {
        party.support[p.id] = party.support[p.id] || {};
        const key = fx.group && fx.group !== 'all' ? fx.group : 'all';
        party.support[p.id][key] = Math.round(((party.support[p.id][key] || 0) + v) * 100) / 100;
      }
      store.log('politics', `${party.name} support ${v >= 0 ? '+' : ''}${Math.round(v * 10) / 10} in ${provs.length === db.provinces.length ? 'all provinces' : provs.map(p => p.name).join(', ')}`, '', actor, [party.id]);
      break;
    }
    case 'news': {
      draftNews(interpolate(fx.headline, {}), interpolate(fx.body, {}), fx.category, !!fx.publish, fx.author, fx.paperId);
      break;
    }
    case 'election': runElection(actor); break;
    case 'property_pl': {
      const perOwner = {};
      for (const pr of db.properties) {
        const net = (pr.income || 0) - (pr.expenses || 0);
        if (!net || !pr.ownerId) continue;
        perOwner[pr.ownerId] = perOwner[pr.ownerId] || { net: 0, n: 0 };
        perOwner[pr.ownerId].net += net; perOwner[pr.ownerId].n++;
        // Property activity IS province economic output: the monthly net flows
        // into the province's GDP figure (₳M), and national GDP / gdpGrowth
        // follow through updateDerived — so property income moves the whole
        // economy, not just a bank balance.
        const prov = db.provinces.find(x => x.id === pr.provinceId);
        if (prov && prov.vars) prov.vars.gdp = Math.max(0, Math.round(((prov.vars.gdp || 0) + net / 1e6) * 100) / 100);
      }
      for (const ownerId in perOwner) {
        const { net, n } = perOwner[ownerId];
        const acct = primaryAccount(ownerId, true);
        if (net > 0) txn(null, acct.id, net, `Net income from ${n} propert${n === 1 ? 'y' : 'ies'}`, actor, 'deposit');
        else txn(acct.id, null, -net, `Net upkeep of ${n} propert${n === 1 ? 'y' : 'ies'}`, actor, 'withdraw');
        // Company owners: property earnings are company earnings. Annual
        // profit = static base (stashed once from the seeded figure) +
        // annualised property net — reprice_shares reads profit/valuation,
        // so productive properties lift the share price and loss-makers
        // drag it, without profit growing unboundedly.
        const co = db.entities.find(e => e.id === ownerId && e.type === 'company');
        if (co) {
          co.vars = co.vars || {};
          if (co.vars.profitBase === undefined) co.vars.profitBase = co.vars.profit || 0;
          co.vars.profit = Math.round(co.vars.profitBase + net * 12);
        }
      }
      break;
    }
    case 'log': {
      store.log('event', interpolate(fx.title, {}), interpolate(fx.detail, {}), actor, []);
      break;
    }
    case 'recompute_employment': {
      // Jobs → employment. Labour demand = Σ employees of the province's
      // properties; labour force ≈ workingShare of population. All coefficients
      // are effect data, not code. `blend` (0..1) drifts toward the target
      // rather than hard-setting, keeping the world stable while GMs calibrate.
      const k = evalExpr(fx.k !== undefined ? fx.k : 1, { vars: db.globalVars });
      const workingShare = fx.workingShare !== undefined ? Number(fx.workingShare) : 0.6;
      const blend = fx.blend !== undefined ? Math.min(1, Math.max(0, Number(fx.blend))) : 1;
      for (const p of db.provinces) {
        const demand = db.properties.filter(pr => pr.provinceId === p.id).reduce((s, pr) => s + (pr.employees || 0), 0);
        const force = (p.vars.population || 0) * workingShare;
        const target = force > 0 ? Math.min(98, Math.max(40, 100 * demand * k / force)) : (p.vars.employment || 60);
        const cur = p.vars.employment !== undefined ? p.vars.employment : target;
        p.vars.employment = Math.round((cur + (target - cur) * blend) * 100) / 100;
        for (const gname in (p.demographics || {})) {
          const g = p.demographics[gname];
          const gc = g.employment !== undefined ? g.employment : p.vars.employment;
          g.employment = Math.round((gc + (p.vars.employment - gc) * blend) * 100) / 100;
        }
      }
      store.log('simulation', `${src}: employment recomputed from labour demand`, '', actor, []);
      break;
    }
    case 'adjust_trust': {
      // Move company trust toward a target expression. The context exposes the
      // company's own vars plus `trust` and `avghappiness` (mean happiness of
      // provinces where the company holds property) so events can wire the
      // "trust follows local mood" chain without naming any world in code.
      const rate = fx.rate !== undefined ? Math.min(1, Math.max(0, Number(fx.rate))) : 0.1;
      const targets = fx.company === 'all'
        ? db.entities.filter(e => e.type === 'company')
        : [findEnt(fx.company)].filter(Boolean);
      for (const co of targets) {
        if (co.trust === undefined) co.trust = 50;
        const owned = new Set(db.properties.filter(pr => pr.ownerId === co.id).map(pr => pr.provinceId));
        const provs = db.provinces.filter(p => owned.has(p.id));
        const avghappiness = provs.length
          ? provs.reduce((s, p) => s + (p.vars.happiness || 0), 0) / provs.length
          : (db.globalVars.avgHappiness || 50);
        const target = evalExpr(fx.value, { vars: { ...(co.vars || {}), trust: co.trust, avghappiness } });
        co.trust = Math.round(Math.min(100, Math.max(0, co.trust + (target - co.trust) * rate)) * 100) / 100;
      }
      break;
    }
    case 'reprice_shares': {
      // price *= 1 + a·(profit/valuation) + b·gdpGrowth + c·((trust-50)/100) + rand(-e,e)
      // Coefficients come from the effect data. gdpGrowth is a global var
      // maintained monthly by advanceTurn.
      const a = Number(fx.a || 0), b = Number(fx.b || 0), c = Number(fx.c || 0), e = Number(fx.e || 0);
      const gdpGrowth = Number(db.globalVars.gdpGrowth || 0);
      const targets = fx.company === 'all'
        ? db.entities.filter(x => x.type === 'company' && x.sharePrice !== undefined)
        : [findEnt(fx.company)].filter(Boolean);
      const touched = [];
      for (const co of targets) {
        if (co.sharePrice === undefined) continue;
        const profit = (co.vars && co.vars.profit) || 0;
        const valuation = (co.vars && co.vars.valuation) || 1;
        const trust = co.trust === undefined ? 50 : co.trust;
        const factor = 1 + a * (profit / valuation) + b * gdpGrowth + c * ((trust - 50) / 100) + (Math.random() * 2 - 1) * e;
        co.sharePrice = Math.max(0.01, Math.round(co.sharePrice * factor * 100) / 100);
        // keep the certificate item's market value in step with the share price
        const shareItem = db.items.find(it => it.meta && it.meta.companyId === co.id);
        if (shareItem) shareItem.marketValue = co.sharePrice;
        touched.push(co);
      }
      // the new prices are captured in the next per-turn history entry (7.1)
      if (touched.length) store.log('market', `${src}: share prices repriced`, touched.slice(0, 6).map(t => `${t.abbrev || t.name} → ${db.settings.currency}${t.sharePrice}`).join(' · '), actor, touched.map(t => t.id));
      break;
    }
    case 'set_share_price': {
      const co = findEnt(fx.company);
      if (!co) throw new Error('set_share_price: unknown company');
      co.sharePrice = Math.max(0.01, Math.round(evalExpr(fx.value, { vars: { price: co.sharePrice || 0, ...(co.vars || {}) } }) * 100) / 100);
      break;
    }
    default: throw new Error('Unknown effect type: ' + fx.type);
  }
}

function checkConditions(ev) {
  for (const c of (ev.conditions || [])) {
    let a, b;
    try { a = evalExpr(c.a, { vars: store.get().globalVars }); b = evalExpr(c.b, { vars: store.get().globalVars }); }
    catch (e) { return false; }
    const ok = c.op === '>' ? a > b : c.op === '<' ? a < b : c.op === '>=' ? a >= b : c.op === '<=' ? a <= b : c.op === '!=' ? a !== b : a === b;
    if (!ok) return false;
  }
  return true;
}

function runEvent(ev, actor) {
  if (!checkConditions(ev)) return false;
  for (const fx of (ev.effects || [])) {
    try { applyEffect(fx, { actor: actor || 'ENGINE', eventName: ev.name }); }
    catch (e) { store.log('error', `Effect failed in “${ev.name}”`, e.message, 'ENGINE', [ev.id]); }
  }
  ev.lastTurn = store.get().settings.time.turn;
  ev.runs = (ev.runs || 0) + 1;
  return true;
}

// ---------- time ----------------------------------------------------------
function dateToMs(s) {
  if (!s) return Date.UTC(1962, 0, 1);
  if (s.length <= 10) { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }
  return new Date(s.endsWith('Z') ? s : s + 'Z').getTime();
}
function msToDate(ms, unit) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return unit === 'hour' ? `${base}T${pad(d.getUTCHours())}:00` : base;
}
const weekIndex = (ms) => Math.floor((Math.floor(ms / 86400000) - 4) / 7);
const monthIndex = (ms) => { const d = new Date(ms); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };

function updateDerived() {
  const db = store.get();
  const g = db.globalVars;
  g.population = db.provinces.reduce((s, p) => s + (p.vars.population || 0), 0);
  g.gdp = Math.round(db.provinces.reduce((s, p) => s + (p.vars.gdp || 0), 0) * 100) / 100;
  const n = db.provinces.length || 1;
  g.avgHappiness = Math.round(db.provinces.reduce((s, p) => s + (p.vars.happiness || 0), 0) / n * 10) / 10;
  g.avgApproval = Math.round(db.provinces.reduce((s, p) => s + (p.vars.approval || 0), 0) / n * 10) / 10;
  g.moneySupply = Math.round(db.accounts.reduce((s, a) => s + a.balance, 0));
  const treasury = db.accounts.find(a => a.id === 'acct_treasury') || db.accounts.find(a => { const e = db.entities.find(x => x.id === a.ownerId); return e && e.type === 'government'; });
  g.treasury = treasury ? Math.round(treasury.balance) : 0;
}

// ---------- taxation -------------------------------------------------------
// Monthly, GM-gated. Corporate tax on companies' net property income;
// property tax on everyone else's (persons, parties — not the government
// itself). Both flow into acct_treasury. Skips entirely (no log) when
// nothing was collected.
function collectTaxes(db, actor) {
  const t = db.settings.taxation;
  const treasury = db.accounts.find(a => a.id === 'acct_treasury');
  if (!treasury) return;
  const netIncomeOf = (entityId) => db.properties
    .filter(p => p.ownerId === entityId)
    .reduce((sum, p) => sum + ((p.income || 0) - (p.expenses || 0)), 0);

  let total = 0, payers = 0;
  for (const e of db.entities) {
    if (e.id === 'ent_gov' || e.id === 'ent_bank' || e.type === 'government') continue;
    const isCompany = e.type === 'company';
    const rate = isCompany ? (t.corporateRate || 0) : (t.propertyRate || 0);
    if (!(rate > 0)) continue;
    const net = netIncomeOf(e.id);
    if (!(net > 0)) continue;
    const tax = Math.round(net * rate / 100);
    if (!(tax > 0)) continue;
    const acct = primaryAccount(e.id, false);
    if (!acct || !(acct.balance > 0)) continue;
    const amount = Math.min(tax, acct.balance);
    if (!(amount > 0)) continue;
    const kindLabel = isCompany ? 'Corporate' : 'Property';
    txn(acct.id, treasury.id, amount, `${kindLabel} tax (${rate}%)`, 'TREASURY', 'transfer');
    total += amount;
    payers++;
  }
  if (total > 0) {
    store.log('economy', `Taxes collected: ${db.settings.currency}${fmtNum(total)}`, `${payers} payer${payers === 1 ? '' : 's'}`, 'TREASURY', []);
  }
}

function advanceTurn(steps, actor) {
  const db = store.get();
  steps = Math.max(1, Math.min(60, steps || 1));
  for (let i = 0; i < steps; i++) {
    try { store.snapshot(); } catch (e) { /* snapshot failure must not stop the world */ }
    const t = db.settings.time;
    const oldMs = dateToMs(t.date);
    const stepMs = t.unit === 'hour' ? 3600000 * t.perTurn : t.unit === 'week' ? 604800000 * t.perTurn : 86400000 * t.perTurn;
    const newMs = oldMs + stepMs;
    t.turn++;
    t.date = msToDate(newMs, t.unit);

    for (const ev of db.events) {
      if (!ev.enabled) continue;
      const tr = ev.trigger || {};
      let due = false;
      if (tr.type === 'every_turn') due = true;
      else if (tr.type === 'interval') due = t.turn % Math.max(1, Math.round(tr.n || 1)) === 0;
      else if (tr.type === 'weekly') due = weekIndex(newMs) !== weekIndex(oldMs);
      else if (tr.type === 'monthly') due = monthIndex(newMs) !== monthIndex(oldMs);
      else if (tr.type === 'date') due = tr.date && dateToMs(tr.date) > oldMs && dateToMs(tr.date) <= newMs;
      if (due) runEvent(ev, actor || 'ENGINE');
    }

    const prevGdp = db.globalVars.gdp;
    updateDerived();
    const monthBoundary = monthIndex(newMs) !== monthIndex(oldMs);
    if (monthBoundary) {
      // month-over-month growth, exposed to events (reprice_shares etc.)
      const base = db.globalVars.gdpLastMonth || prevGdp || db.globalVars.gdp;
      db.globalVars.gdpGrowth = base ? Math.round((db.globalVars.gdp - base) / base * 10000) / 10000 : 0;
      db.globalVars.gdpLastMonth = db.globalVars.gdp;
    }
    if (monthBoundary && prevGdp) {
      const delta = ((db.globalVars.gdp - prevGdp) / prevGdp) * 100;
      draftNews(`Statistical Bureau: national output ${delta >= 0 ? 'up' : 'down'} ${Math.abs(delta).toFixed(1)}%`,
        `The State Statistical Bureau reports national GDP at ${db.settings.currency}${fmtNum(db.globalVars.gdp)}M, ` +
        `${delta >= 0 ? 'an increase' : 'a decline'} of ${Math.abs(delta).toFixed(1)}% for the month. ` +
        `Average approval of the government stands at ${db.globalVars.avgApproval}%.`, 'Economy', true, 'State Statistical Bureau');
    }
    if (monthBoundary && db.settings.taxation && db.settings.taxation.enabled) collectTaxes(db, actor || 'ENGINE');
    recordHistory(weekIndex(newMs) !== weekIndex(oldMs));
    store.log('time', `Turn ${t.turn} — ${t.date}`, '', actor || 'ENGINE', []);
  }
  store.save();
  broadcast('sync');
  return db.settings.time;
}

// ---------- history (time-series for charts) ------------------------------
// One row per turn, appended at the end of advanceTurn. Polling is O(n) so it
// is only sampled on week boundaries. Capped so the world doc stays bounded.
function recordHistory(weekly) {
  const db = store.get();
  db.history = db.history || [];
  const g = db.globalVars;
  const provinces = {};
  for (const p of db.provinces) {
    provinces[p.id] = {
      gdp: p.vars.gdp || 0, happiness: p.vars.happiness || 0,
      approval: p.vars.approval || 0, employment: p.vars.employment || 0
    };
  }
  const shares = {};
  for (const e of db.entities) if (e.type === 'company' && e.sharePrice !== undefined) shares[e.id] = e.sharePrice;
  const entry = {
    turn: db.settings.time.turn, date: db.settings.time.date,
    gdp: g.gdp || 0, population: g.population || 0,
    avgHappiness: g.avgHappiness || 0, avgApproval: g.avgApproval || 0,
    moneySupply: g.moneySupply || 0, treasury: g.treasury || 0,
    provinces, shares
  };
  if (weekly) {
    try {
      const { national, totalVotes } = computePolling(false);
      const polling = {};
      for (const pid in national) polling[pid] = Math.round(national[pid] / (totalVotes || 1) * 1000) / 10;
      entry.polling = polling;
    } catch (e) { /* polling is optional data */ }
  }
  db.history.push(entry);
  if (db.history.length > 1000) db.history.splice(0, db.history.length - 1000);
}

// ---------- elections -----------------------------------------------------
// Support is computed from the simulated population: every demographic group
// in every province scores every party, votes split by softmax.
function scoreParty(party, group, provId) {
  const ideo = party.ideology || { econ: 0, soc: 0 };
  let s = 50;
  s -= 0.5 * Math.abs((group.politicalLeaning || 0) - (ideo.econ || 0));
  s += (50 - (group.education || 50)) * (ideo.soc || 0) * 0.006;
  const gs = group.governmentSupport || 50;
  s += party.inGovernment ? (gs - 50) * 0.35 : (50 - gs) * 0.12;
  const sup = (party.support || {})[provId];
  if (sup) s += (sup.all || 0) * 1.2;
  return s;
}

function computePolling(noise) {
  const db = store.get();
  const parties = db.entities.filter(e => e.type === 'party');
  const byProvince = {};
  const national = {};
  let totalVotes = 0;
  for (const p of db.provinces) {
    const provVotes = {};
    // GM-scripted voter base: province.voterBase = { partyId: percent }.
    // When set (any positive entry), that split IS the province's vote —
    // normalised over the given percentages, flat 55% turnout, a little
    // wobble when polling noise is on. The demographic simulation below
    // only runs for provinces without a scripted base.
    const vb = p.voterBase || {};
    const vbTotal = parties.reduce((s, pt) => s + Math.max(0, Number(vb[pt.id]) || 0), 0);
    if (vbTotal > 0) {
      const voters = (p.vars.population || 0) * 0.55;
      for (const pt of parties) {
        const share = Math.max(0, Number(vb[pt.id]) || 0) / vbTotal;
        if (share > 0) provVotes[pt.id] = voters * share * (noise ? 1 + (Math.random() * 0.06 - 0.03) : 1);
      }
    } else for (const gname in p.demographics) {
      const g = p.demographics[gname];
      const turnout = Math.min(0.92, Math.max(0.25, 0.42 + (g.happiness || 50) * 0.004 + (g.education || 40) * 0.0015));
      const voters = (g.population || 0) * turnout;
      const scores = parties.map(pt => scoreParty(pt, g, p.id) + (noise ? (Math.random() * 6 - 3) : 0));
      const exps = scores.map(s => Math.exp(s / 9));
      const sum = exps.reduce((a, b) => a + b, 0) || 1;
      parties.forEach((pt, i) => { provVotes[pt.id] = (provVotes[pt.id] || 0) + voters * (exps[i] / sum); });
    }
    byProvince[p.id] = provVotes;
    for (const pid in provVotes) { national[pid] = (national[pid] || 0) + provVotes[pid]; totalVotes += provVotes[pid]; }
  }
  return { parties, byProvince, national, totalVotes };
}

function dhondt(votes, seats) {
  const won = {}; Object.keys(votes).forEach(k => won[k] = 0);
  for (let i = 0; i < seats; i++) {
    let best = null, bestQ = -1;
    for (const pid in votes) {
      const q = votes[pid] / (won[pid] + 1);
      if (q > bestQ) { bestQ = q; best = pid; }
    }
    if (best) won[best]++;
  }
  return won;
}

// Phase 3.4 — manual election entry. When `manual` is supplied the GM has
// typed in the result directly (e.g. a scripted/roleplayed outcome): we skip
// computePolling entirely, trust the given rows, and still write the same
// election record / news / log the simulated path produces. `manual` shape:
// { rows: [{ partyId, votes, seats }], turnout }.
function runManualElection(actor, manual) {
  const db = store.get();
  const totalSeats = db.settings.parliamentSeats || 150;
  const rows = Array.isArray(manual.rows) ? manual.rows : [];
  if (!rows.length) throw new Error('Manual election needs at least one party row.');

  const seatSum = rows.reduce((s, r) => s + (Math.round(Number(r.seats)) || 0), 0);
  if (seatSum > totalSeats) throw new Error(`Seats assigned (${seatSum}) exceed the ${totalSeats}-seat parliament.`);

  const nationalRows = rows.map(r => {
    const party = findEnt(r.partyId);
    if (!party || party.type !== 'party') throw new Error('Unknown party: ' + r.partyId);
    const votes = Math.max(0, Math.round(Number(r.votes) || 0));
    const seats = Math.max(0, Math.round(Number(r.seats) || 0));
    return { partyId: party.id, votes, seats };
  });
  const totalVotes = nationalRows.reduce((s, r) => s + r.votes, 0);
  nationalRows.forEach(r => { r.pct = Math.round(r.votes / (totalVotes || 1) * 1000) / 10; });
  nationalRows.sort((a, b) => b.seats - a.seats || b.votes - a.votes);

  nationalRows.forEach(r => { const p = findEnt(r.partyId); if (p) p.mpCount = r.seats; });

  const turnoutPct = manual.turnout !== undefined && manual.turnout !== null && manual.turnout !== ''
    ? Math.round(Number(manual.turnout) * 10) / 10
    : (() => { const electorate = db.provinces.reduce((s, p) => s + (p.vars.population || 0), 0); return Math.round(totalVotes / (electorate || 1) * 1000) / 10; })();

  const rec = {
    id: store.uid('elec'), ts: Date.now(), turn: db.settings.time.turn, simDate: db.settings.time.date,
    name: `General Election — ${db.settings.time.date}`, seats: totalSeats, turnout: turnoutPct,
    national: nationalRows, byProvince: {}, manual: true
  };
  db.elections.push(rec);
  if (db.elections.length > 60) db.elections.splice(0, db.elections.length - 60);

  const winner = nationalRows[0] ? db.entities.find(e => e.id === nationalRows[0].partyId) : null;
  const nameOf = (pid) => { const e = db.entities.find(x => x.id === pid); return e ? (e.abbrev || e.name) : pid; };
  const lines = nationalRows.map(r => `${nameOf(r.partyId)} — ${r.pct}% · ${r.seats} seats`).join('\n');
  store.log('election', `General election (manual entry): ${winner ? winner.name : '—'} leads with ${nationalRows[0] ? nationalRows[0].seats : 0} seats`, `Turnout ${turnoutPct}%`, actor || 'GM', [rec.id]);
  draftNews(`${winner ? winner.name.toUpperCase() : 'PARLIAMENT'} ${nationalRows[0] && nationalRows[0].seats >= Math.ceil(totalSeats / 2) ? 'WINS MAJORITY' : 'LEADS HUNG PARLIAMENT'}`,
    `The Republic has voted. On a turnout of ${turnoutPct}%, the count of ${totalSeats} seats stands:\n\n${lines}\n\n` +
    `${winner && nationalRows[0].seats >= Math.ceil(totalSeats / 2) ? winner.name + ' commands a majority and will govern alone.' : 'No party commands a majority; coalition talks begin at once.'}`,
    'Politics', true, 'Election Commission');
  store.save();
  broadcast('sync');
  return rec;
}

function runElection(actor, manual) {
  if (manual) return runManualElection(actor, manual);
  const db = store.get();
  const { parties, byProvince, national, totalVotes } = computePolling(true);
  const totalSeats = db.settings.parliamentSeats || 150;
  const totalPop = db.provinces.reduce((s, p) => s + (p.vars.population || 0), 0) || 1;

  // apportion seats to provinces by population (largest remainder, min 2)
  const quotas = db.provinces.map(p => ({ id: p.id, q: (p.vars.population || 0) / totalPop * totalSeats }));
  const seatsByProv = {};
  let used = 0;
  quotas.forEach(x => { seatsByProv[x.id] = Math.max(2, Math.floor(x.q)); used += seatsByProv[x.id]; });
  quotas.sort((a, b) => (b.q - Math.floor(b.q)) - (a.q - Math.floor(a.q)));
  let k = 0;
  while (used < totalSeats) { seatsByProv[quotas[k % quotas.length].id]++; used++; k++; }
  while (used > totalSeats) { const q = quotas[quotas.length - 1 - (k % quotas.length)]; if (seatsByProv[q.id] > 2) { seatsByProv[q.id]--; used--; } k++; }

  const seatTotals = {}; parties.forEach(p => seatTotals[p.id] = 0);
  const provResults = {};
  for (const p of db.provinces) {
    const won = dhondt(byProvince[p.id], seatsByProv[p.id]);
    provResults[p.id] = { seats: won, votes: byProvince[p.id] };
    for (const pid in won) seatTotals[pid] += won[pid];
  }

  const electorate = db.provinces.reduce((s, p) => s + (p.vars.population || 0), 0);
  const turnoutPct = Math.round(totalVotes / (electorate || 1) * 1000) / 10;
  const nationalRows = parties.map(pt => ({
    partyId: pt.id,
    votes: Math.round(national[pt.id] || 0),
    pct: Math.round((national[pt.id] || 0) / (totalVotes || 1) * 1000) / 10,
    seats: seatTotals[pt.id] || 0
  })).sort((a, b) => b.seats - a.seats || b.votes - a.votes);

  parties.forEach(pt => { pt.mpCount = seatTotals[pt.id] || 0; });

  const rec = {
    id: store.uid('elec'), ts: Date.now(), turn: db.settings.time.turn, simDate: db.settings.time.date,
    name: `General Election — ${db.settings.time.date}`, seats: totalSeats, turnout: turnoutPct,
    national: nationalRows,
    byProvince: Object.fromEntries(db.provinces.map(p => [p.id, {
      seats: provResults[p.id].seats,
      votes: Object.fromEntries(Object.entries(provResults[p.id].votes).map(([pid, v]) => [pid, Math.round(v)]))
    }]))
  };
  db.elections.push(rec);
  if (db.elections.length > 60) db.elections.splice(0, db.elections.length - 60);

  const winner = parties.find(pt => pt.id === nationalRows[0].partyId);
  const nameOf = (pid) => { const e = db.entities.find(x => x.id === pid); return e ? (e.abbrev || e.name) : pid; };
  const lines = nationalRows.map(r => `${nameOf(r.partyId)} — ${r.pct}% · ${r.seats} seats`).join('\n');
  store.log('election', `General election: ${winner ? winner.name : '—'} leads with ${nationalRows[0].seats} seats`, `Turnout ${turnoutPct}%`, actor || 'ENGINE', [rec.id]);
  draftNews(`${winner ? winner.name.toUpperCase() : 'PARLIAMENT'} ${nationalRows[0].seats >= Math.ceil(totalSeats / 2) ? 'WINS MAJORITY' : 'LEADS HUNG PARLIAMENT'}`,
    `The Republic has voted. On a turnout of ${turnoutPct}%, the count of ${totalSeats} seats stands:\n\n${lines}\n\n` +
    `${winner && nationalRows[0].seats >= Math.ceil(totalSeats / 2) ? winner.name + ' commands a majority and will govern alone.' : 'No party commands a majority; coalition talks begin at once.'}`,
    'Politics', true, 'Election Commission');
  store.save();
  broadcast('sync');
  return rec;
}

// ---------- auto-advance --------------------------------------------------
// In a long-lived process (server.js) a real timer ticks the world. In
// serverless deployments there is no resident process, so a cron endpoint
// calls autoTick() instead, which advances however many turns have become
// due since the last tick.
let longLived = false;
let autoTimer = null;
function setLongLived(v) { longLived = !!v; }

function scheduleAuto() {
  if (!longLived) return;
  const db = store.get();
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  const auto = db.settings.time.auto;
  if (auto && auto.enabled) {
    autoTimer = setInterval(() => {
      try { advanceTurn(1, 'AUTO'); } catch (e) { console.error('auto-advance failed:', e); }
    }, Math.max(15, auto.seconds || 3600) * 1000);
  }
}

function autoTick(actor) {
  const t = store.get().settings.time;
  if (!t.auto || !t.auto.enabled) return { advanced: 0, enabled: false };
  const now = Date.now();
  const stepMs = Math.max(15, t.auto.seconds || 3600) * 1000;
  if (!t.auto.lastTick) {
    t.auto.lastTick = now;
    store.save();
    return { advanced: 0, enabled: true };
  }
  const due = Math.min(30, Math.floor((now - t.auto.lastTick) / stepMs));
  if (due > 0) {
    advanceTurn(due, actor || 'AUTO');
    t.auto.lastTick += due * stepMs;
    store.save();
  }
  return { advanced: due, enabled: true, turn: t.turn };
}

module.exports = {
  init, evalExpr, interpolate, applyEffect, runEvent, checkConditions, advanceTurn,
  runElection, computePolling, txn, primaryAccount, draftNews, updateDerived,
  scheduleAuto, setLongLived, autoTick, syncPresidency,
  findProv, findEnt, findItem
};
