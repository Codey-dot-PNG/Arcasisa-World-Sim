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
  // Cap kept deliberately low: full article bodies live in the world doc, and
  // every commit rewrites the entire doc to Postgres — 400×2-4KB bodies were a
  // big chunk of each PATCH during heavy traffic. The state payload only ships
  // metadata; bodies are fetched on demand via /api/news/:id.
  if (db.news.length > 200) db.news.splice(0, db.news.length - 200);
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
      // ownerId is canonical but the deed item mirrors it — reconcile both
      // sides through the choke point's sync pass so the old owner doesn't
      // keep holding a deed the register says they no longer own.
      try { require('./deeds').syncAllDeeds(db); } catch (e) { /* deed sync optional */ }
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
        // per-province calibration (vars.employmentK, written by migration so
        // the authored employment level is the equilibrium at the authored
        // job count) beats the one-size global k — a single k cannot fit
        // provinces whose listed jobs per capita differ 2×.
        const kp = p.vars.employmentK > 0 ? p.vars.employmentK : k;
        const target = force > 0 ? Math.min(98, Math.max(40, 100 * demand * kp / force)) : (p.vars.employment || 60);
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
      const econC = db.globalVars.econConfidence === undefined ? 50 : db.globalVars.econConfidence;
      const targets = fx.company === 'all'
        ? db.entities.filter(x => x.type === 'company' && x.sharePrice !== undefined)
        : [findEnt(fx.company)].filter(Boolean);
      const touched = [];
      for (const co of targets) {
        if (co.sharePrice === undefined) continue;
        const profit = (co.vars && co.vars.profit) || 0;
        const valuation = (co.vars && co.vars.valuation) || 1;
        const trust = co.trust === undefined ? 50 : co.trust;
        // TURN price = fundamentals: earnings yield, growth, trust, and economic
        // confidence (the knock-on from the Day Market). Not the day price — that
        // lives in market.js and moves on its own.
        const factor = 1 + a * (profit / valuation) + b * gdpGrowth + c * ((trust - 50) / 100) + 0.05 * ((econC - 50) / 100) + (Math.random() * 2 - 1) * e;
        co.sharePrice = Math.max(0.01, Math.round(co.sharePrice * factor * 100) / 100);
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
  let succeeded = 0;
  for (const fx of (ev.effects || [])) {
    try { applyEffect(fx, { actor: actor || 'ENGINE', eventName: ev.name }); succeeded++; }
    catch (e) { store.log('error', `Effect failed in “${ev.name}”`, e.message, 'ENGINE', [ev.id]); }
  }
  // Interval events whose EVERY effect failed keep their cadence slot: marking
  // lastTurn here would let a broken event silently skip turn after turn.
  if ((ev.effects || []).length && succeeded === 0) return false;
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
  // Domestic money supply only — a handful of accounts belong to foreign
  // powers/trade blocs (e.g. acct_markasia) and must not inflate the national
  // aggregate charts. Foreign per-turn military production (runForeignMilitary)
  // is off-books materiel with no cash leg, so this is a static/defensive
  // exclusion rather than a fix for an active leak.
  g.moneySupply = Math.round(db.accounts.reduce((s, a) => {
    const owner = db.entities.find(e => e.id === a.ownerId);
    if (owner && (owner.type === 'foreign' || owner.type === 'org')) return s;
    return s + a.balance;
  }, 0));
  const treasury = db.accounts.find(a => a.id === 'acct_treasury') || db.accounts.find(a => { const e = db.entities.find(x => x.id === a.ownerId); return e && e.type === 'government'; });
  g.treasury = treasury ? Math.round(treasury.balance) : 0;
  // Economic confidence is written live by the Day Market; keep the derived
  // aggregate fresh here too (cap-weighted mean of company confidence).
  try { require('./market').recomputeEconConfidence(db); } catch (e) { /* market optional at early boot */ }
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

// ---------- production economy (Phase 13) ----------------------------------
// Runs EVERY turn (replaces the old event-driven profit generators). Each
// property either mints goods — sold by its owner, split between the domestic
// market (abstract money-in) and the government (paid from the treasury) — or
// generates cash directly (casinos, offices, banks). Wages/upkeep are debited;
// corporate/property tax (if enabled) is skimmed on net; province GDP is
// recomputed from production using globalVars.gdpScale (fixed at migration).

const clampPct = (v, def) => { const n = Number(v); return isNaN(n) ? def : Math.max(0, Math.min(100, n)); };
const clamp01 = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const cleanQty = (v) => Math.round((Number(v) || 0) * 1000000) / 1000000;
function addInventory(holder, itemId, qty) {
  if (!holder || !(qty > 0)) return;
  holder.inventory = holder.inventory || [];
  const row = holder.inventory.find(r => r.itemId === itemId);
  if (row) row.qty = cleanQty((row.qty || 0) + qty); else holder.inventory.push({ itemId, qty: cleanQty(qty) });
}
function removeInventory(holder, itemId, qty) {
  if (!holder || !holder.inventory || !(qty > 0)) return 0;
  const row = holder.inventory.find(r => r.itemId === itemId);
  if (!row) return 0;
  const take = Math.min(row.qty || 0, qty);
  row.qty = cleanQty(row.qty - take);
  if (row.qty <= 0) holder.inventory = holder.inventory.filter(r => r !== row);
  return take;
}
function inventoryQty(holder, itemId) {
  if (!holder || !holder.inventory) return 0;
  const row = holder.inventory.find(r => r.itemId === itemId);
  return row ? (row.qty || 0) : 0;
}
// How many units of an item a foreign partner will trade per turn. A GM can pin
// an exact figure in p.capacity[itemId]; otherwise it derives from the authored
// demand/supply level (High/Med/Low) attached to that item on the partner.
const DEMAND_CAP = { Low: 250, Med: 750, High: 2500 };
function partnerCap(p, itemId, kind /* 'demand' | 'supply' */) {
  const explicit = p.capacity && Number(p.capacity[itemId]);
  const demandMult = kind === 'demand' ? partnerDemandMultiplier(p, itemId) : 1;
  if (explicit > 0) return explicit * demandMult;
  const lvlMap = (kind === 'supply' ? p.supply : p.demand) || {};
  return (DEMAND_CAP[lvlMap[itemId]] || DEMAND_CAP.Med) * demandMult;
}
// Demand can be tuned globally for a partner and then multiplied again for an
// individual item. A missing item override is neutral (1×), so old worlds keep
// their authored demand exactly.
function partnerDemandMultiplier(p, itemId) {
  const total = Number(p.demandMultiplier === undefined ? 1 : p.demandMultiplier);
  const byItem = p.demandMultiplierByItem && p.demandMultiplierByItem[itemId];
  const item = byItem === undefined ? 1 : Number(byItem);
  if (!Number.isFinite(total) || !Number.isFinite(item)) return 1;
  return Math.max(0, total) * Math.max(0, item);
}
// Audit-ledger money move without the per-call timeline entry (routine daily
// ops would otherwise flood the wire). Balances still move and the transaction
// is recorded; runEconomy emits one summary log per turn instead.
function ledgerTxn(fromAcctId, toAcctId, amount, memo, actor, kind) {
  const db = store.get();
  amount = Math.round(amount * 100) / 100;
  if (!(amount > 0)) return;
  const from = fromAcctId ? db.accounts.find(a => a.id === fromAcctId) : null;
  const to = toAcctId ? db.accounts.find(a => a.id === toAcctId) : null;
  // An unresolvable non-null endpoint is a data bug (e.g. a dangling household
  // accountId after a GM deletion) — silently skipping the leg used to make
  // wages/stipends vanish without a trace. Surface it; skip the move so a bad
  // row can't wedge the whole turn.
  if (fromAcctId && !from) {
    console.error('ledgerTxn: unknown source account ' + fromAcctId + ' (' + memo + ')');
    store.log('error', 'Ledger move skipped — unknown account', `${memo || kind || 'transfer'}: source ${fromAcctId} no longer exists`, 'ENGINE', []);
    return;
  }
  if (toAcctId && !to) {
    console.error('ledgerTxn: unknown destination account ' + toAcctId + ' (' + memo + ')');
    store.log('error', 'Ledger move skipped — unknown account', `${memo || kind || 'transfer'}: destination ${toAcctId} no longer exists`, 'ENGINE', []);
    return;
  }
  if (from) from.balance = Math.round((from.balance - amount) * 100) / 100;
  if (to) to.balance = Math.round((to.balance + amount) * 100) / 100;
  store.recordTxn({
    id: store.uid('txn'), ts: Date.now(), turn: db.settings.time.turn, simDate: db.settings.time.date,
    from: from ? from.id : null, to: to ? to.id : null, amount, memo: memo || '', actor: actor || 'ENGINE', kind: kind || 'transfer'
  });
}

// ---------- strikes (Phase 31 — protest economy impact) ----------
// Peaceful and violent protests alike hit the economy: while a protestor
// crowd stands within STRIKE_RADIUS of a property, its workforce is out on
// strike and output scales by (1 − degree), where degree grows with crowd
// strength up to the GM-tunable strikeFrac (live protests carry their own
// protest.tuning; settings.war.protest holds the defaults). Runs at the top
// of runEconomy; transitions (strike starts / work resumes) log with refs to
// the owner so the CEO's timeline and company view surface them through the
// existing management UI. Employees stay EMPLOYED — nobody is fired for
// striking, and the strike ends when the crowd moves on or the protest ends.
const STRIKE_RADIUS = 120; // px — crowds this close to a site stop its workforce
function strikeAlive(u) {
  return !!u && !u.dead && u.state !== 'dead' && (u.strength || 0) > 0;
}
function applyStrikes(db) {
  const protest = db.protest;
  const turn = ((db.settings || {}).time || {}).turn || 0;
  if (!protest || !protest.active) {
    // No active protest: clear every lingering strike flag with a closing
    // audit entry, so a strike never outlives the crowd that caused it.
    for (const pr of db.properties) {
      if (pr.vars && pr.vars.strike) {
        store.log('economy', `Work resumes at ${pr.name}`, 'The strike is over and the workforce has returned to the job.', 'STRIKE', [pr.ownerId]);
        delete pr.vars.strike;
      }
    }
    return;
  }
  const cap = ((protest.protest || {}).tuning || {}).strikeFrac;
  if (!(cap > 0)) {
    // strikeFrac tuned to zero disables the economic effect entirely.
    for (const pr of db.properties) {
      if (pr.vars && pr.vars.strike) delete pr.vars.strike;
    }
    return;
  }
  const R2 = STRIKE_RADIUS * STRIKE_RADIUS;
  const struck = new Set(); // propertyIds still under a live strike this turn
  let firstStruck = null;
  for (const pr of db.properties) {
    if (!pr || !pr.pos || !pr.prodMode || !pr.ownerId) continue;
    const px = pr.pos[0], py = pr.pos[1];
    let degree = 0;
    for (const u of protest.units) {
      if (u.side !== 'att' || u.kind !== 'protestor' || !strikeAlive(u)) continue;
      const dx = u.pos[0] - px, dy = u.pos[1] - py;
      if (dx * dx + dy * dy > R2) continue;
      degree += Math.min(1, (u.strength || 0) / 5000);
    }
    if (degree <= 0) continue;
    degree = Math.min(cap, degree);
    pr.vars = pr.vars || {};
    const was = pr.vars.strike;
    struck.add(pr.id);
    if (was) {
      was.degree = degree; // intensity tracks the crowd while it lasts
    } else {
      pr.vars.strike = { degree, sinceTurn: turn };
      if (!firstStruck) firstStruck = pr;
      store.log('economy', `Work stoppage at ${pr.name}`,
        'The workforce has joined the strike and downed tools. Production is suspended until the crowds disperse.', 'STRIKE', [pr.ownerId]);
    }
  }
  // One wire piece per protest — the first site to shut down is the story.
  if (firstStruck && !protest._strikeNewsAt) {
    protest._strikeNewsAt = turn;
    draftNews(`${(protest.name || 'THE PROTESTS').toUpperCase()}: WORKERS DOWN TOOLS`,
      `Workers at ${firstStruck.name} have joined the demonstrations, halting production. Management has been notified; owners are watching the crowds for signs of how long the stoppage may last.`, 'Business', false, 'Wire Service');
  }
  // Clear strikes on sites the crowds have left (no unit within the radius).
  for (const pr of db.properties) {
    if (pr.vars && pr.vars.strike && !struck.has(pr.id)) {
      store.log('economy', `Work resumes at ${pr.name}`,
        'The crowds have moved on and the workforce has returned to the job.', 'STRIKE', [pr.ownerId]);
      delete pr.vars.strike;
    }
  }
}
// Workforce levers (Phase 28): output multiplier and per-turn accident odds
// by safety policy; morale drift happens per property inside the passes that
// use them. Module scope so the turn pass and the hourly cadence share one
// definition (docs/CONVENTIONS.md — no duplicated engine math).
const SAFETY_MULT = { none: 1.5, relaxed: 1.3, standard: 1, strict: 0.7 };
const SAFETY_RISK = { none: 0.20, relaxed: 0.10, standard: 0.05, strict: 0.01 };
// Training (6f): accident-odds dampening divisor — risk × 1/(1 + spend/this).
// Each full divisor's worth of training halves the remaining risk.
const TRAINING_RISK_DIV = 10000;

// Shared per-property production context — the single source of truth for
// the output-multiplier stack (province happiness × daily wobble × work
// hours × safety policy × staffing × upgrades − strikes), plus the wage,
// keep-stock policy and staffing ratio every consumer needs. Used by BOTH
// runEconomy's turn-end pass and the hourly production cadence
// (runHourlyProductionTick), so the two can never drift apart.
function productionContext(db, pr) {
  const econ = db.settings.economy || {};
  const variance = econ.dailyVariance !== undefined ? Number(econ.dailyVariance) : 0.06;
  const hapK = econ.happinessOutputK !== undefined ? Number(econ.happinessOutputK) : 0.15;
  const owner = db.entities.find(e => e.id === pr.ownerId);
  const co = owner && owner.type === 'company' ? owner : null;
  const keepPct = pr.keepPct !== undefined
    ? clampPct(pr.keepPct, 0)
    : (co ? clampPct(co.keepPct, 0) : 0); // property override, then company policy
  // Direct currency wages replace the old relative wage index. Keep the
  // derived index for the existing province happiness/employment nudges.
  const wagePerTurn = pr.wagePerTurn !== undefined
    ? Math.max(0, Number(pr.wagePerTurn) || 0)
    : (co ? Math.max(0, Number(co.wagePerTurn === undefined ? 1 : co.wagePerTurn) || 0) : 0);
  const wageIdx = co ? wagePerTurn * 100 : 100;
  const hoursRaw = pr.workHours !== undefined ? pr.workHours : (co && co.workHours !== undefined ? co.workHours : 8);
  const hoursNum = Number(hoursRaw);
  const hoursMult = (Number.isFinite(hoursNum) ? Math.max(0, Math.min(24, hoursNum)) : 8) / 8;
  const safetyRaw = pr.safety !== undefined ? pr.safety : (co && co.safety !== undefined ? co.safety : 'standard');
  const maxEmp = pr.maxEmployees !== undefined
    ? Math.max(0, Math.round(pr.maxEmployees))
    : Math.max(1, Math.round(pr.employees || 1));
  // Staffing fulfilment (Phase 28b): production scales LINEARLY with the
  // staffing ratio; the exponential accident pricing below is the brake.
  const staffRatio = maxEmp > 0 ? (pr.employees || 0) / maxEmp : 0;
  const staffMult = Math.max(0, Math.min(5, staffRatio));
  const upgradeMult = 1 + ((pr.upgradeInvested || 0) / Math.max(50, pr.value || 100));
  const active = pr.prodMode === 'goods' || pr.prodMode === 'cash';
  const strikeOf = (pr.vars && pr.vars.strike && pr.vars.strike.degree) || 0;
  const prov = pr.provinceId ? db.provinces.find(p => p.id === pr.provinceId) : null;
  const hap = prov && prov.vars.happiness !== undefined ? Number(prov.vars.happiness) : 50;
  const provF = 1 + ((hap - 50) / 50) * hapK;
  // Output breathes with the citizenry: province happiness scales production
  // around its authored baseline, and a small wobble keeps profits from being
  // a flat line. The wobble floor applies to the output base only, so
  // safety/staffing/upgrade decisions always move production exactly as much
  // as they promise.
  const f = active
    ? Math.max(0.4, provF * (1 + (Math.random() * 2 - 1) * variance)) * hoursMult * (SAFETY_MULT[safetyRaw] || 1) * staffMult * upgradeMult * Math.max(0, 1 - strikeOf)
    : 1;
  return { owner, co, active, f, keepPct, wagePerTurn, wageIdx, hoursMult, safetyRaw, staffRatio };
}

// Condition factor (6a) off the persisted vars. Default is neutral (100), so
// worlds that never tick the production cadence behave exactly as before.
function conditionFactorOf(pr) {
  const pv = pr.vars || {};
  return activePr(pr) && pv.condition !== undefined ? pv.condition / 100 : 1;
}
function activePr(pr) { return pr.prodMode === 'goods' || pr.prodMode === 'cash'; }

// Part 4 — supply chains. Consumes required inputs from the SITE inventory
// proportionally to ACTUAL output and returns the 0..1 scaling factor (null
// when the property declares no requirements). `primaryUnits` is the intended
// output quantity of the property's PRIMARY product (produces[0]); perUnit is
// expressed against it, and ALL outputs scale by the same worst-input ratio.
// Runs identically in both the hourly cadence slice and the legacy turn lump,
// so supply chains work regardless of how fast the world clock runs.
function applyRequires(db, pr, primaryUnits) {
  const reqs = pr.requires;
  if (!Array.isArray(reqs) || !reqs.length || !(primaryUnits > 0)) return null;
  let worst = 1;
  for (const req of reqs) {
    if (!req.itemId || !(req.perUnit > 0)) continue;
    const needed = req.perUnit * primaryUnits;
    const stock = inventoryQty(pr, req.itemId);
    const ratio = needed > 0 ? Math.min(1, stock / needed) : 1;
    if (ratio < worst) worst = ratio;
  }
  for (const req of reqs) {
    if (!req.itemId || !(req.perUnit > 0)) continue;
    const used = cleanQty(req.perUnit * primaryUnits * worst);
    if (used > 0) removeInventory(pr, req.itemId, used);
  }
  pr.vars = pr.vars || {};
  pr.vars.supplyFulfillment = Math.round(worst * 1000) / 1000;
  return worst;
}

function runEconomy(db, actor, scale) {
  scale = typeof scale === 'number' && isFinite(scale) ? scale : 1;
  // Strikes (Phase 31): while an active protest's crowds sit on a property,
  // its workforce is out — output scales by the strike degree below. Runs
  // first so every revenue path (goods/cash/province GDP) sees it.
  try { applyStrikes(db); } catch (e) { /* strikes are optional */ }
  const g = db.globalVars;
  const items = db.items;
  const priceOf = (id) => { const it = items.find(i => i.id === id); return it ? (it.marketValue || 0) : 0; };
  const econ = db.settings.economy || { baseDailyWage: 4, wageHappinessK: 0.03, wageEmploymentK: 0.03 };
  // Global GM levers (Economy tab): domestic sale price and property expense
  // multipliers. Records keep their authored values; the engine scales here.
  const domMult = econ.domesticMultiplier !== undefined ? Number(econ.domesticMultiplier) : 1;
  const expMult = econ.expensesMultiplier !== undefined ? Number(econ.expensesMultiplier) : 1;
  const gdpScale = g.gdpScale || 1;
  const gov = db.entities.find(e => e.id === 'ent_gov') || db.entities.find(e => e.type === 'government');
  const treasury = db.accounts.find(a => a.id === 'acct_treasury') || (gov && db.accounts.find(a => a.ownerId === gov.id));
  const tax = db.settings.taxation && db.settings.taxation.enabled ? db.settings.taxation : null;
  // Phase 35: when the hourly production cadence fired since the last turn
  // boundary, goods were already minted/sold (and cash-mode revenue already
  // deposited) in world-hourly slices — this pass then only SETTLES what
  // accrued. When it didn't (paused clock, manual turn advance), fall back
  // to the legacy full lump production so the turn economy never stalls.
  const hourlyAccrued = (db._prodTicksThisTurn || 0) > 0;

  const perOwner = {};      // ownerId -> { dom, upkeep, wage, gross }
  const provGross = {};     // provinceId -> production value this turn
  const provWage = {};      // provinceId -> { wSum, emp } employee-weighted wage index
  const own = (id) => (perOwner[id] = perOwner[id] || { dom: 0, upkeep: 0, wage: 0, gross: 0 });
  let payEmp = 0, payWageSum = 0; // nationwide payroll → averageDailyWage / wageIndex

  for (const pr of db.properties) {
    if (!pr.ownerId) continue;
    const ctx = productionContext(db, pr);
    const owner = ctx.owner;
    const co = ctx.co;
    const f = ctx.f;
    const conditionFactor = conditionFactorOf(pr);
    // Supply-chain fulfillment (Part 4): computed once against the primary
    // output and applied to every product line. Works in BOTH paths — hourly
    // slices and this legacy lump — so requirements bite even when the world
    // clock is paused and turns advance manually.
    let fulfillment = null;
    if (pr.prodMode === 'goods' && (pr.produces || []).length) {
      fulfillment = applyRequires(db, pr, (pr.produces[0].perTurn || 0) * f * scale * conditionFactor);
    }
    const reqMult = fulfillment === null ? 1 : fulfillment;

    // gross production value (drives GDP): private at output, public at cost.
    // With hourly accrual active, goods-mode GDP reads what the cadence
    // actually minted this turn (kept + sold slices); cash-mode uses the
    // same formula as legacy for its GDP proxy either way.
    let gross;
    if (pr.prodMode === 'goods') {
      gross = hourlyAccrued
        ? Object.keys(pr._prodMade || {}).reduce((s, itemId) => s + (pr._prodMade[itemId] || 0) * priceOf(itemId), 0)
        : (pr.produces || []).reduce((s, e) => s + (e.perTurn || 0) * f * priceOf(e.itemId) * scale * reqMult * conditionFactor, 0);
    } else if (pr.prodMode === 'cash') gross = (pr.cashPerTurn || 0) * f * scale * conditionFactor;
    else gross = (pr.expenses || 0) * scale;
    if (pr.provinceId) provGross[pr.provinceId] = (provGross[pr.provinceId] || 0) + gross;

    const o = own(pr.ownerId);
    o.gross += gross;

    // revenue — one split per item: keep a slice as company stock (tradable on
    // the open market / via trade offers), sell the rest at domestic retail.
    // Government purchases are no longer routed here: the state buys goods
    // through the trade-offer system or the open market like everyone else.
    if (pr.prodMode === 'goods') {
      // record what actually reached the domestic market this turn — the
      // household food pass (households.js runFoodSupply) turns these sales
      // into real circulating food stock instead of letting them vanish.
      pr._domesticMarketSalesThisTurn = [];
      if (hourlyAccrued) {
        // The hourly cadence minted whole-unit slices onto the site and
        // accumulated what it sold; settle that revenue here, once per turn.
        const salesAcc = pr._salesAccum || {};
        for (const itemId in salesAcc) {
          const sold = salesAcc[itemId];
          if (!(sold > 0)) continue;
          pr._domesticMarketSalesThisTurn.push({ itemId, qty: sold });
          o.dom += sold * priceOf(itemId) * domMult;
        }
        pr._salesAccum = null;
        pr._prodMade = null;
      } else {
        for (const e of (pr.produces || [])) {
          const retail = priceOf(e.itemId);
          const produced = cleanQty((e.perTurn || 0) * f * scale * reqMult * conditionFactor);
          if (produced <= 0) continue;
          const itemKeepPct = pr.keepPctByItem && pr.keepPctByItem[e.itemId] !== undefined
            ? clampPct(pr.keepPctByItem[e.itemId], ctx.keepPct)
            : (co && co.keepPctByItem && co.keepPctByItem[e.itemId] !== undefined
              ? clampPct(co.keepPctByItem[e.itemId], ctx.keepPct) : ctx.keepPct);
          const keep = cleanQty(produced * itemKeepPct / 100);
          const sold = cleanQty(produced - keep);
          if (keep > 0) addInventory(pr, e.itemId, keep); // stock accrues on site
          if (sold > 0) pr._domesticMarketSalesThisTurn.push({ itemId: e.itemId, qty: sold });
          o.dom += sold * retail * domMult;
        }
      }
    } else if (pr.prodMode === 'cash') {
      // With hourly accrual active the cash was already deposited in
      // world-hourly slices by runHourlyProductionTick — do not pay twice.
      if (!hourlyAccrued) o.dom += (pr.cashPerTurn || 0) * f * scale * conditionFactor;
    }

    // workforce (Phase 28): morale drifts toward the wage anchor, and an
    // industrial accident — odds by safety policy — kills/maims a slice of the
    // crew. The dead drop off payroll here (employees is read below), dent
    // morale, thin the province's population and post a notice for the desk.
    // Runs once per turn here only — never on the hourly cadence — so the
    // accident odds and morale convergence stay exactly as authored.
    if (ctx.active && ctx.hoursMult > 0 && (pr.employees || 0) > 0) {
      const target = 50 + clamp01((ctx.wagePerTurn - 1) * 25, -30, 30); // ₳1 wage anchors at 50
      const h0 = pr.workerHappiness === undefined ? 50 : pr.workerHappiness;
      pr.workerHappiness = Math.round(clamp01(h0 + (target - h0) * 0.03 + (Math.random() * 2 - 1) * 0.5, 0, 100) * 10) / 10;
      // Accident odds (Phase 28b): the policy base is multiplied by a
      // staffing factor that grows EXPONENTIALLY — every extra 100% of
      // capacity on the payroll doubles the risk, so a 200%-over-staffed
      // 'standard' site (5% base) rolls at 10%, 300% at 20%, and so on.
      // Under-staffing halves risk per 100% below the cap (floor 10% of base).
      // Training spend (6f) dampens the result — each ₳10,000/turn of
      // sustained training halves the remaining risk (asymptotic, never zero).
      const riskMult = Math.max(0.1, Math.min(1e6, Math.pow(2, ctx.staffRatio - 1)));
      const trainDampen = 1 / (1 + ((pr.vars && pr.vars.trainingSpend) || 0) / TRAINING_RISK_DIV);
      if (Math.random() < (SAFETY_RISK[ctx.safetyRaw] || 0.05) * riskMult * trainDampen) {
        const deaths = Math.min(
          Math.max(1, Math.round(pr.employees * (0.04 + Math.random() * 0.06))),
          Math.max(1, Math.round(pr.employees * 0.5)));
        const injuries = Math.min(pr.employees, Math.round(pr.employees * (0.10 + Math.random() * 0.15)));
        pr.employees -= deaths;
        pr.workerHappiness = Math.round(clamp01(pr.workerHappiness - 20, 0, 100) * 10) / 10;
        const prov = db.provinces.find(p => p.id === pr.provinceId);
        if (prov) {
          if (prov.vars) prov.vars.population = Math.max(0, (prov.vars.population || 0) - deaths);
          const wc = prov.demographics && prov.demographics['Working Class'];
          if (wc) wc.population = Math.max(0, Math.round((wc.population || 0) - deaths));
        }
        pr.accident = {
          turn: db.settings.time.turn, date: db.settings.time.date, safety: ctx.safetyRaw,
          hours: Math.round(ctx.hoursMult * 8), deaths, injuries, fulfilment: Math.round(ctx.staffRatio * 100)
        };
        store.log('accident', `Industrial accident at ${pr.name}`,
          `${fmtNum(deaths)} dead, ${fmtNum(injuries)} injured (${ctx.safetyRaw} safety)`, actor || 'ENGINE', [pr.id, pr.ownerId]);
      }
    }

    // expenses: property upkeep, direct company payroll, and the per-turn
    // controllable spends (6a maintenance / 6f training) — charged here
    // through the same settlement draw as every other expense so the stats
    // actually cost money instead of being free buffs.
    const pv = pr.vars || {};
    o.upkeep += (pr.expenses || 0) * expMult
      + (pv.maintenanceSpend || 0) + (pv.trainingSpend || 0);
    o.wage += (pr.employees || 0) * ctx.wagePerTurn;
    if ((pr.employees || 0) > 0 && ctx.wagePerTurn > 0) { payEmp += (pr.employees || 0); payWageSum += (pr.employees || 0) * ctx.wagePerTurn; }

    // wage pressure on the province (employee-weighted)
    if (pr.provinceId && pr.employees) {
      const w = provWage[pr.provinceId] = provWage[pr.provinceId] || { wSum: 0, emp: 0 };
      w.wSum += ctx.wageIdx * pr.employees; w.emp += pr.employees;
    }
  }

  // settle each owner: net abstract money-in, government purchases, tax.
  // Revenue is tied to economic confidence (the Day-Market knock-on): a confident
  // economy spends, a spooked one doesn't. Domestic consumer sales scale by
  // confFactor.
  const econC = db.globalVars.econConfidence === undefined ? 50 : db.globalVars.econConfidence;
  const confFactor = 0.7 + 0.006 * econC; // conf 50→1.0, 100→1.3, 0→0.7
  let settledOwners = 0, netTotal = 0, taxTotal = 0;
  for (const ownerId in perOwner) {
    const o = perOwner[ownerId];
    const owner = db.entities.find(e => e.id === ownerId);
    const acct = primaryAccount(ownerId, true);
    const dom = o.dom * confFactor; // consumer revenue, confidence-scaled
    // The wage bill is NO LONGER deducted here at the mint: previously the
    // wages money was destroyed at the market edge and nobody actually got
    // paid. It rides the revenue into the owner's account, and the household
    // pass (households.js runWages) then DEBITS that account into real
    // household wallets — money conserved, wages paid with real balances.
    // o.wage still feeds vars.expenses/vars.profit below for the accounting.
    let netAbstract = dom - o.upkeep;

    // Settle the abstract net FIRST (mint on profit, capped draw on loss), then
    // collect tax as a straight account→treasury transfer. The previous order
    // (withhold t from the deposit AND debit t from the account) taxed every
    // profitable owner twice: balance delta was net − 2·rate% instead of
    // net − rate%, silently impoverishing companies and landowners each turn.
    if (netAbstract > 0) ledgerTxn(null, acct.id, netAbstract, 'Daily operations', actor, 'deposit');
    else if (netAbstract < 0) {
      const draw = Math.min(-netAbstract, Math.max(0, acct.balance)); // never overdraw below zero
      if (draw > 0) ledgerTxn(acct.id, null, draw, 'Daily upkeep', actor, 'withdraw');
    }

    // per-turn tax on positive operating net (rates are the same %; net is 1/30
    // of the old monthly figure, so the monthly burden matches the old system)
    if (tax && netAbstract > 0 && owner && owner.id !== 'ent_gov' && owner.id !== 'ent_bank' && owner.type !== 'government') {
      const rate = owner.type === 'company' ? (tax.corporateRate || 0) : (tax.propertyRate || 0);
      if (rate > 0 && treasury) {
        const t = Math.round(netAbstract * rate / 100 * 100) / 100;
        if (t > 0) { ledgerTxn(acct.id, treasury.id, t, 'Tax', 'TREASURY', 'transfer'); taxTotal += t; }
      }
    }

    // company earnings vars (annualised run-rate keeps parity with authored figures)
    if (owner && owner.type === 'company') {
      owner.vars = owner.vars || {};
      owner.vars.revenue = Math.round(dom * 365);
      owner.vars.expenses = Math.round((o.upkeep + o.wage) * 365);
      owner.vars.profit = Math.round((dom - o.upkeep - o.wage) * 365);
    }
    settledOwners++;
    netTotal += netAbstract;
  }

  // War overhaul — companies with ZERO properties (lost to war, sold off,
  // whatever) must not keep coasting on a stale pre-war vars.revenue/profit:
  // only owners that appeared in perOwner above (i.e. own ≥1 property) were
  // just settled. Everyone else earns nothing this turn, still pays a small
  // corporate-overhead drag (Phase 27 migration sets vars.overheadPerTurn from
  // the company's pre-rebalance expense footprint) and its paper valuation
  // decays toward the zero property-backed value it can actually justify.
  for (const co of db.entities) {
    if (co.type !== 'company' || perOwner[co.id]) continue;
    co.vars = co.vars || {};
    co.vars.revenue = 0;
    const overhead = co.vars.overheadPerTurn || 0;
    if (overhead > 0) {
      const acct = primaryAccount(co.id, true);
      const draw = Math.min(overhead, Math.max(0, acct.balance));
      if (draw > 0) ledgerTxn(acct.id, null, draw, 'Corporate overhead (no producing assets)', actor, 'withdraw');
      co.vars.profit = Math.round(-overhead * 365 * 100) / 100;
    } else {
      co.vars.profit = 0;
    }
    co.vars.valuation = Math.max(0, Math.round((co.vars.valuation || 0) * 0.995 * 100) / 100);
  }

  // GDP: province output × calibration scale (global gdp summed by updateDerived)
  for (const p of db.provinces) {
    p.vars.gdp = Math.round((provGross[p.id] || 0) * gdpScale * 100) / 100;
  }

  // wage pressure → happiness & employment nudges (small, per turn, clamped)
  for (const p of db.provinces) {
    const w = provWage[p.id];
    if (!w || !w.emp) continue;
    const delta = (w.wSum / w.emp - 100) / 100; // avg (wage-100)/100 in this province
    if (delta === 0) continue;
    if (p.vars.happiness !== undefined) p.vars.happiness = clamp01(Math.round((p.vars.happiness + econ.wageHappinessK * delta) * 100) / 100, 0, 100);
    if (p.vars.employment !== undefined) p.vars.employment = clamp01(Math.round((p.vars.employment + econ.wageEmploymentK * delta) * 100) / 100, 0, 100);
  }

  // economic confidence → civilian mood (other-systems knock-on). A confident
  // economy lifts happiness/approval; a market crash drags them down hard. The
  // strength is a GM knob (economy.happinessConfK); the default makes confidence
  // a MAJOR happiness driver — a deep slump (conf 20) costs ~0.48 happiness/turn.
  const confK = econ.happinessConfK !== undefined ? Number(econ.happinessConfK) : 1.6;
  const cShift = Math.round(((econC - 50) / 100) * confK * 100) / 100;
  if (cShift !== 0) for (const p of db.provinces) {
    if (p.vars.happiness !== undefined) p.vars.happiness = clamp01(Math.round((p.vars.happiness + cShift) * 100) / 100, 0, 100);
    if (p.vars.approval !== undefined) p.vars.approval = clamp01(Math.round((p.vars.approval + cShift * 0.6) * 100) / 100, 0, 100);
  }

  // War overhaul — a live war depresses civilian mood: occupied provinces take
  // a per-turn hit scaled by how much of them is under enemy control, plus a
  // smaller nationwide malus everywhere while any war is active at all.
  applyWarHappinessImpact(db);

  // advance the Day Market one step per turn too, so speculation keeps moving in
  // deployments without the long-lived 5s ticker (e.g. serverless).
  try { require('./market').dayMarketTick(db); } catch (e) { /* market optional at early boot */ }

  // built-in daily share reprice (folds in the retired Market Session event).
  // Workstream A6 — coefficients halved so a single turn of live TRADING now
  // dominates the fundamentals drift; the noise term stays tiny.
  repriceAllShares(db, 0.3, 0.4, 0.075, 0.015, actor);

  // per-turn government income samples for the finance graphs (recordHistory)
  g.lastTaxIncome = Math.round(taxTotal * 100) / 100;

  // The nation's average wage comes straight off the payroll: employee-
  // weighted mean of what companies actually pay (a ₳1/day baseline anchors
  // wageIndex at 100, keeping the wage happiness/employment nudges stable).
  // Household income tracks this via households.js's upward income nudge, so
  // raising company wages measurably lifts the class statistics it feeds.
  if (payEmp > 0 && payWageSum > 0) {
    const avg = Math.round(payWageSum / payEmp * 100) / 100;
    g.averageDailyWage = avg;
    g.wageIndex = Math.round(avg * 100 * 100) / 100;
    g.totalEmployment = payEmp;
  }

  if (settledOwners) {
    store.log('economy', `Daily economy settled`,
      `${settledOwners} operators · net ${db.settings.currency}${fmtNum(netTotal)}${taxTotal ? ' · tax ' + db.settings.currency + fmtNum(taxTotal) : ''}`, actor || 'ENGINE', []);
  }
}

// ---------- Phase 35 — hourly production engine (cadence-driven) -----------
// Runs on the `production` cadence (every world-hour by default) and owns
// everything that accrues in world-hourly slices:
//   · Part 2 — perTurn budgets paid out hourly via fractional accumulators
//     (`_prodAccum` for items, `_cashAccum` for cash-mode sites). perTurn
//     KEEPS meaning "per turn" for balancing; the cadence just delivers it
//     smoothly. Whole units land on the site inventory; the sold slice is
//     accumulated and settled into revenue once per turn by runEconomy.
//   · Part 4 — supply chains: requires[].perUnit (inputs per 1 unit of the
//     primary output) are consumed from the site inventory through the same
//     removeInventory path /api/property/items uses; the worst input ratio
//     scales ALL outputs, and persists as vars.supplyFulfillment for UI.
//   · 6a — condition decay vs maintenanceSpend (training's accident effect
//     lives in runEconomy's accident roll — it is a per-turn mechanic).
//   · 6d — tender closing/award.
// When the clock is paused or turns advance manually, nothing here fires and
// runEconomy's legacy lump pass covers production instead (see its
// `hourlyAccrued` flag), so a stopped world still has a working economy.
const HOUR_MS = 3600000;
// tickWorldMs: the world-time width ONE call covers (the cadence's configured
// interval). Callers that don't pass it get the legacy one-hour slice. Without
// this, a GM raising productionHours to 2 got HALF the perTurn economy (12
// one-hour slices per turn regardless), and lowering it to 0.25 minted 4×.
function runHourlyProductionTick(db, actor, tickWorldMs) {
  actor = actor || 'CADENCE';
  tickWorldMs = Number(tickWorldMs) > 0 ? Number(tickWorldMs) : HOUR_MS;
  db._prodTicksThisTurn = (db._prodTicksThisTurn || 0) + 1;
  const econ = db.settings.economy || {};
  const decayRate = econ.conditionDecayPerHour !== undefined ? Number(econ.conditionDecayPerHour) : 0.5;
  const slice = Math.min(1, tickWorldMs / require('./cadence').turnWorldMs(db));

  for (const pr of db.properties) {
    if (!pr.ownerId) continue;
    const ctx = productionContext(db, pr);
    pr.vars = pr.vars || {};
    const pv = pr.vars;

    // 6a. Condition decays toward ruin unless maintenance spend covers the
    // required upkeep share; condition feeds straight into output below.
    if (pv.condition === undefined) pv.condition = 100;
    const requiredUpkeep = Math.max(0, (pr.expenses || 0) * 0.3);
    const shortfall = Math.max(0, requiredUpkeep - (pv.maintenanceSpend || 0));
    if (shortfall > 0 && requiredUpkeep > 0) {
      const decay = decayRate * slice * (shortfall / requiredUpkeep);
      pv.condition = Math.round(Math.max(0, Math.min(100, pv.condition - decay)) * 100) / 100;
    }
    const conditionFactor = conditionFactorOf(pr);

    if (!ctx.active) continue;

    // Part 4 — supply-chain fulfillment BEFORE accumulation, so partial
    // supply under-produces smoothly hour to hour. Same helper the turn-end
    // pass uses.
    const produces = pr.produces || [];
    let fulfillment = null;
    if (pr.prodMode === 'goods' && produces.length) {
      fulfillment = applyRequires(db, pr, (produces[0].perTurn || 0) * ctx.f * slice * conditionFactor);
    }
    const reqMult = fulfillment === null ? 1 : fulfillment;

    if (pr.prodMode === 'goods') {
      pv._prodAccum = pv._prodAccum || {};
      pr._prodMade = pr._prodMade || {};      // whole units minted this turn (GDP basis)
      pr._salesAccum = pr._salesAccum || {};  // units sold this turn (settled by runEconomy)
      for (const e of produces) {
        const intended = (e.perTurn || 0) * ctx.f * slice * reqMult * conditionFactor;
        const acc = (pv._prodAccum[e.itemId] || 0) + intended;
        const whole = Math.floor(acc + 1e-9); // floor to whole units on deposit
        pv._prodAccum[e.itemId] = acc - whole;
        if (!(whole > 0)) continue;
        const itemKeepPct = pr.keepPctByItem && pr.keepPctByItem[e.itemId] !== undefined
          ? clampPct(pr.keepPctByItem[e.itemId], ctx.keepPct)
          : (ctx.co && ctx.co.keepPctByItem && ctx.co.keepPctByItem[e.itemId] !== undefined
            ? clampPct(ctx.co.keepPctByItem[e.itemId], ctx.keepPct) : ctx.keepPct);
        const keep = cleanQty(whole * itemKeepPct / 100);
        const sold = cleanQty(whole - keep);
        if (keep > 0) addInventory(pr, e.itemId, keep); // stock accrues on site
        if (sold > 0) pr._salesAccum[e.itemId] = cleanQty((pr._salesAccum[e.itemId] || 0) + sold);
        pr._prodMade[e.itemId] = (pr._prodMade[e.itemId] || 0) + whole;
      }
    } else { // cash mode: hourly deposits of whole koren, remainder carried
      pv._cashAccum = Number(pv._cashAccum) || 0;
      pv._cashAccum += (pr.cashPerTurn || 0) * ctx.f * slice * conditionFactor;
      const whole = Math.floor(pv._cashAccum);
      if (whole >= 1) {
        pv._cashAccum -= whole;
        const acct = primaryAccount(pr.ownerId, true);
        if (acct) ledgerTxn(null, acct.id, whole, `${pr.name} operations`, actor, 'deposit');
      }
    }
  }

  closeDueTenders(db, actor);
}

// ---- 6d. Government tenders (competitive bidding) --------------------------
// The state (or any GM-delegated opener with the manage_tenders scope) posts
// what it wants to buy; companies bid a unit price before the world-clock
// deadline; lowest bid wins and the full order is delivered and paid in one
// shot at award time. Deliberately simple v1 rules.
function createTenderObj(db, opts) {
  const nowWorld = worldClockNow(db.settings.time, Date.now());
  const deadlineHours = Math.max(1, Math.min(336, Number(opts.deadlineHours) || 48));
  return {
    id: store.uid('tnd'),
    title: String(opts.title || '').slice(0, 120),
    itemId: opts.itemId, qtyWanted: Math.max(1, Math.round(Number(opts.qtyWanted) || 1)),
    deadlineWorldMs: nowWorld + deadlineHours * HOUR_MS,
    status: 'open', bids: [], awardedTo: null,
    openerEntityId: opts.openerEntityId || 'ent_gov',
    openedBy: opts.openedBy || 'SYSTEM',
    createdAt: Date.now(),
  };
}
function closeDueTenders(db, actor) {
  if (!Array.isArray(db.tenders)) return;
  const nowWorld = worldClockNow(db.settings.time, Date.now());
  for (const t of db.tenders) {
    if (t.status !== 'open') continue;
    if (nowWorld < t.deadlineWorldMs) continue;
    const valid = (t.bids || []).filter(b => b.price > 0 && db.entities.some(e => e.id === b.entityId))
      .sort((a, b) => a.price - b.price || a.submittedAt - b.submittedAt);
    if (!valid.length) {
      t.status = 'expired';
      store.log('economy', `Tender ${t.id} expired`, 'No qualifying bids received.', actor || 'ENGINE', [t.openerEntityId]);
      continue;
    }
    const winner = valid[0];
    const winnerEnt = db.entities.find(e => e.id === winner.entityId);
    const openerEnt = db.entities.find(e => e.id === t.openerEntityId);
    // One-shot settlement at award: goods move through the pooled-stock trade
    // helpers, money through txn. A winner that cannot deliver simply loses
    // the award (recorded, no partial delivery).
    const cost = Math.round(winner.price * t.qtyWanted * 100) / 100;
    const fromAcct = winnerEnt ? primaryAccount(winnerEnt.id, true) : null;
    const toAcct = openerEnt ? primaryAccount(openerEnt.id, true) : null;
    let note = 'no qualifying delivery';
    if (winnerEnt && openerEnt && fromAcct && toAcct) {
      const drawn = drawHolderStock(db, winnerEnt, t.itemId, t.qtyWanted);
      if (drawn >= t.qtyWanted - 1e-6) {
        addInventory(openerEnt, t.itemId, t.qtyWanted);
        txn(fromAcct.id, toAcct.id, cost, `Tender ${t.id} fulfilment`, actor || 'ENGINE', 'transfer');
        note = `delivered ${t.qtyWanted} × ${t.itemId}`;
      } else {
        if (drawn > 0) addInventory(winnerEnt, t.itemId, drawn); // return the short draw
      }
    }
    t.status = 'awarded';
    t.awardedTo = winner.entityId;
    t.awardPrice = winner.price;
    t.deliveryNote = note;
    const item = db.items.find(x => x.id === t.itemId);
    store.log('economy', `Tender ${t.id} awarded`, `${(winnerEnt || {}).name || winner.entityId} wins at ${db.settings.currency}${winner.price}/unit — ${note}`, actor || 'ENGINE', [t.openerEntityId, winner.entityId]);
    draftNews(`State tender awarded: ${item ? item.name : t.itemId}`,
      `The ${t.qtyWanted}-unit order has been placed with ${(winnerEnt || {}).name || 'the winning bidder'} at ${db.settings.currency}${winner.price} per unit.`, 'Business', false, 'Procurement Office');
  }
}

// War overhaul — civilian mood under fire. `war.stats.provinceControl` maps
// provinceId -> attacker occupation % (0-100); any province with a nonzero
// figure takes a happiness/approval hit that scales with how occupied it is,
// on top of a small national malus that applies everywhere the moment a war
// goes active (people worry about a war on the far side of the country too).
// Generic: reads only db.war/db.provinces, no scenario-specific knowledge.
function applyWarHappinessImpact(db) {
  const war = db.war;
  if (!war || !war.active) return;
  const ctl = (war.stats && war.stats.provinceControl) || {};
  const NATIONWIDE = 0.05; // happiness/turn everywhere, any active war
  for (const p of db.provinces) {
    const occ = clamp01(Number(ctl[p.id]) || 0, 0, 100);
    const occHit = (occ / 100) * 0.6; // up to ~0.6 happiness/turn at full occupation
    const hit = occHit + NATIONWIDE;
    if (p.vars.happiness !== undefined) p.vars.happiness = clamp01(Math.round((p.vars.happiness - hit) * 100) / 100, 0, 100);
    if (p.vars.approval !== undefined) p.vars.approval = clamp01(Math.round((p.vars.approval - hit * 0.6) * 100) / 100, 0, 100);
  }
}

// ---------- foreign military production (Phase 27) -------------------------
// Every foreign power with an authored entity.meta.military profile slowly
// accrues off-books materiel into its OWN inventory each turn — no money
// changes hands, this is not trade, just the world quietly re-arming itself
// in the background. Entirely data-driven (profile + item.meta.originId), so
// the engine carries no per-nation special cases; the roster lives in the
// seed/migration data (server/store.js), per docs/CONVENTIONS.md.
const MIL_SIZE_MULT = { tiny: 0.4, small: 0.7, medium: 1, big: 1.8 };
const MIL_STRENGTH_MULT = { none: 0, weak: 0.5, medium: 1, strong: 1.8 };
// Per-turn off-books military production, base rates at size=medium /
// strength=1 (scaled by MIL_SIZE_MULT × MIL_STRENGTH_MULT below). Raised an
// order of magnitude over the original trickle so a genuine regional power
// (Valksland: big×strong ⇒ ~52 fuel, ~145 rifles/turn) actually fields a
// stockpile comparable to Arcasia's own arsenal, instead of sitting on a few
// hundred barrels while the Republic's oil economy dwarfs it.
const MIL_FUEL_BASE = 16;    // barrels/turn at size=medium, strength=1
const MIL_GUN_BASE = 45;     // rifles/turn at size=medium, army=1
const MIL_TANK_BASE = 0.15;  // tanks/turn at size=medium, army=1 (strong/quality only)
const MIL_SHIP_BASE = 0.06;  // hulls/turn at size=medium, navy=1 (strong only)
function runForeignMilitary(db, actor) {
  const items = db.items || [];
  const findByOrigin = (kind, originId) => items.find(i => i.meta && i.meta.weapon && i.meta.weapon.kind === kind && i.meta.originId === originId);
  const findAnyHeld = (holder, kind) => {
    const inv = holder.inventory || [];
    for (const row of inv) {
      if (!(row.qty > 0)) continue;
      const it = items.find(i => i.id === row.itemId);
      if (it && it.meta && it.meta.weapon && it.meta.weapon.kind === kind) return it;
    }
    return null;
  };
  for (const e of db.entities) {
    if (e.type !== 'foreign') continue; // Arcasia's own arms come from properties (ARC Arms Works, Kradon Shipyards)
    const mil = e.meta && e.meta.military;
    if (!mil) continue;
    const sizeMult = MIL_SIZE_MULT[mil.size] !== undefined ? MIL_SIZE_MULT[mil.size] : 1;
    const armyMult = MIL_STRENGTH_MULT[mil.army] !== undefined ? MIL_STRENGTH_MULT[mil.army] : 0;
    const navyMult = MIL_STRENGTH_MULT[mil.navy] !== undefined ? MIL_STRENGTH_MULT[mil.navy] : 0;
    if (!armyMult && !navyMult) continue; // 'none'/'none' fields no armed forces at all
    e.vars = e.vars || {};
    const acc = e.vars.milAccum = e.vars.milAccum || { fuel: 0, guns: 0, tanks: 0, ships: 0 };

    // fuel — every armed power keeps a reserve moving
    acc.fuel += MIL_FUEL_BASE * sizeMult * ((armyMult + navyMult) / 2);
    if (acc.fuel >= 1) { const q = Math.floor(acc.fuel); acc.fuel -= q; addInventory(e, 'item_fuel', q); }

    // small arms — a nation with importsFrom buys the exporter's national
    // pattern instead of fielding its own; otherwise it re-arms with whatever
    // model it already owns (complements existing stock, never a second type).
    if (armyMult > 0) {
      let gunItem = findByOrigin('smallarms', e.id);
      if (!gunItem && Array.isArray(mil.importsFrom)) {
        for (const srcId of mil.importsFrom) { gunItem = findByOrigin('smallarms', srcId); if (gunItem) break; }
      }
      if (!gunItem) gunItem = findAnyHeld(e, 'smallarms');
      if (gunItem) {
        acc.guns += MIL_GUN_BASE * sizeMult * armyMult;
        if (acc.guns >= 1) { const q = Math.floor(acc.guns); acc.guns -= q; addInventory(e, gunItem.id, q); }
      }
    }

    // tanks — strong armies (or quality-focused, medium-and-up) fielding an
    // owned or imported tank pattern
    const wantsTanks = mil.army === 'strong' || (mil.focus === 'quality' && armyMult >= MIL_STRENGTH_MULT.medium);
    if (wantsTanks) {
      let tankItem = findByOrigin('tank', e.id);
      if (!tankItem && Array.isArray(mil.importsFrom)) {
        for (const srcId of mil.importsFrom) { tankItem = findByOrigin('tank', srcId); if (tankItem) break; }
      }
      if (!tankItem) tankItem = findAnyHeld(e, 'tank');
      if (tankItem) {
        acc.tanks += MIL_TANK_BASE * sizeMult * armyMult;
        if (acc.tanks >= 1) { const q = Math.floor(acc.tanks); acc.tanks -= q; addInventory(e, tankItem.id, q); }
      }
    }

    // warships — strong navies only, fielding an owned pattern (no import path
    // is authored for hulls the way there is for rifles)
    if (mil.navy === 'strong') {
      let shipItem = findByOrigin('warship', e.id) || findAnyHeld(e, 'warship');
      if (shipItem) {
        acc.ships += MIL_SHIP_BASE * sizeMult * navyMult;
        if (acc.ships >= 1) { const q = Math.floor(acc.ships); acc.ships -= q; addInventory(e, shipItem.id, q); }
      }
    }
  }
}

// Share reprice extracted so both the daily engine and the manual reprice_shares
// effect share one implementation.
function repriceAllShares(db, a, b, c, e, actor) {
  const gdpGrowth = Number(db.globalVars.gdpGrowth || 0);
  const econC = db.globalVars.econConfidence === undefined ? 50 : db.globalVars.econConfidence;
  for (const co of db.entities) {
    if (co.type !== 'company' || co.sharePrice === undefined) continue;
    const profit = (co.vars && co.vars.profit) || 0;
    const valuation = (co.vars && co.vars.valuation) || 1;
    const trust = co.trust === undefined ? 50 : co.trust;
    // TURN price (fundamental company value). Economic confidence (the Day-Market
    // knock-on) feeds in here; the day price itself is handled in market.js.
    const factor = 1 + a * (profit / valuation) + b * gdpGrowth + c * ((trust - 50) / 100) + 0.05 * ((econC - 50) / 100) + (Math.random() * 2 - 1) * e;
    co.sharePrice = Math.max(0.01, Math.round(co.sharePrice * factor * 100) / 100);
  }
}

// ---------- the open market (foreign trade) --------------------------------
// Nothing settles automatically any more. Each turn every foreign partner
// posts procedural ORDERS derived from its authored demand/supply levels:
//   BUY orders  — goods the partner wants to import from Arcasia (our exports);
//   SELL orders — goods the partner offers to Arcasia (our imports).
// Players (the President from the national stockpile, CEOs from company stock)
// fill them by hand via executeTrade(). Price responds to volume: the more of
// an order you fill, the worse your price gets (see TRADE_IMPACT below).
// Reset the per-turn trade-flow accumulators (called at the turn boundary
// AFTER recordTradeHistory has archived them).
function resetTradeFlows(db) {
  const trade = db.settings.trade;
  if (!trade) return;
  trade.lastFlows = [];
  db.globalVars.lastExportIncome = 0;
  db.globalVars.lastImportSpend = 0;
  db.globalVars.lastTariffIncome = 0;
}
function generateTradeOrders(db) {
  const trade = db.settings.trade;
  if (!trade || !Array.isArray(trade.partners)) return;
  resetTradeFlows(db);
  rerollTradeBook(db);
}
// Rebuild the order book WITHOUT touching per-turn flow accounting — this is
// the Part-3c hourly cadence entry point, so the desk refreshes on world
// time while export/import history stays turn-scoped. `orders.seq` is a
// monotonic stamp clients key draft-clearing off (the turn no longer changes
// on an intra-turn reroll).
function rerollTradeBook(db) {
  const trade = db.settings.trade;
  if (!trade || !Array.isArray(trade.partners)) return;
  // Global GM price levers (Economy tab): demand orders are OUR EXPORTS
  // (partners buying from us), supply orders OUR IMPORTS (we buy from them).
  const econ = db.settings.economy || {};
  const exportMult = econ.exportMultiplier !== undefined ? Number(econ.exportMultiplier) : 1;
  const importMult = econ.importMultiplier !== undefined ? Number(econ.importMultiplier) : 1;
  const buys = [], sells = [];
  const LVL_PRICE = { High: 1.08, Med: 1, Low: 0.92 }; // hungrier buyers pay more
  for (const p of trade.partners) {
    if (!db.entities.some(e => e.id === p.entityId)) continue;
    const mk = (iid, kind) => {
      const item = db.items.find(i => i.id === iid);
      if (!item || item.tradable === false) return null;
      // Price = the item's GLOBAL retail value × this partner's per-item
      // MULTIPLIER (1 = at retail; >1 pays a premium, <1 a discount). Legacy
      // absolute prices are honoured as an implied multiplier so old worlds
      // keep their numbers until re-authored.
      const retail = item.marketValue || 0;
      const mult = (p.priceMult && p.priceMult[iid] > 0) ? p.priceMult[iid]
        : (p.prices && p.prices[iid] > 0 && retail > 0 ? p.prices[iid] / retail : 1);
      // Diplomacy (Phase 25): warm partners bid over the odds for our goods
      // and undercut when selling to us; frosty ones do the reverse. ±10%
      // across the whole 0-100 relations range — see relationsPriceMult.
      const relMult = kind === 'demand' ? relationsPriceMult(db, p.entityId) : 1 / relationsPriceMult(db, p.entityId);
      const base = retail * mult * relMult * (kind === 'demand' ? exportMult : importMult);
      if (!(base > 0)) return null;
      const lvl = ((kind === 'demand' ? p.demand : p.supply) || {})[iid] || 'Med';
      // demand level scales the ask/bid: eager buyers bid over the odds,
      // abundant suppliers undercut (inverted for supply)
      const lvlMult = kind === 'demand' ? (LVL_PRICE[lvl] || 1) : (1 / (LVL_PRICE[lvl] || 1));
      const drift = 1 + (Math.random() * 2 - 1) * (p.priceDrift || 0.05);
      const cap = partnerCap(p, iid, kind);
      if (!(cap > 0)) return null;
      let qty = Math.max(1, Math.round(cap * (0.55 + Math.random() * 0.9)));
      // Heavy military hardware is scarce on the world market (feature:
      // "reduce their stock — at most, high supply, 100 tanks and 5 ships on
      // the international exchange"): whatever the partner's generic capacity
      // says, a tank order is clamped to at most 100 vehicles and a warship
      // order to at most 5 hulls, and only at HIGH supply/demand — Med and Low
      // listings shrink further. Applies to both sides of the book (a partner
      // buying our tanks is no less constrained by hulls-in-yards realities).
      const wkind = item.meta && item.meta.weapon && item.meta.weapon.kind;
      if (wkind === 'tank' || wkind === 'warship') {
        const HW_MAX = wkind === 'tank' ? 100 : 5;
        const HW_LVL = { High: 1, Med: 0.6, Low: 0.3 };
        qty = Math.max(1, Math.min(qty, Math.round(HW_MAX * (HW_LVL[lvl] || 0.6))));
      }
      return {
        id: store.uid('ord'), partnerId: p.entityId, itemId: iid,
        qty, filled: 0, level: lvl,
        price: Math.round(base * lvlMult * drift * 100) / 100
      };
    };
    const dSet = new Set([...(p.exports || []), ...Object.keys(p.demand || {})]);
    const sSet = new Set([...(p.imports || []), ...Object.keys(p.supply || {})]);
    for (const iid of dSet) { const o = mk(iid, 'demand'); if (o) buys.push(o); }
    for (const iid of sSet) { const o = mk(iid, 'supply'); if (o) sells.push(o); }
  }
  trade.orderSeq = (trade.orderSeq || 0) + 1;
  trade.orders = { turn: db.settings.time.turn, seq: trade.orderSeq, buys, sells };
}

// Volume→price impact: filling 100% of an order moves your effective unit
// price 35% against you (linearly, averaged over the fill window).
const TRADE_IMPACT = 0.35;
function tradeUnitPrice(order, qty, side) {
  const f0 = (order.filled || 0) / order.qty;
  const f1 = ((order.filled || 0) + qty) / order.qty;
  const avgF = (f0 + f1) / 2;
  const k = side === 'sell' ? (1 - TRADE_IMPACT * avgF) : (1 + TRADE_IMPACT * avgF);
  return Math.round(order.price * k * 100) / 100;
}

// Aggregate stock of an item across a holder's own inventory and (for
// companies) the inventories of the properties it owns — production accrues on
// site, but the market treats it as one pool.
function holderStock(db, holder, itemId) {
  let qty = ((holder.inventory || []).find(r => r.itemId === itemId) || {}).qty || 0;
  for (const pr of db.properties) {
    if (pr.ownerId !== holder.id) continue;
    qty += ((pr.inventory || []).find(r => r.itemId === itemId) || {}).qty || 0;
  }
  return qty;
}
function drawHolderStock(db, holder, itemId, qty) {
  let need = qty;
  need -= removeInventory(holder, itemId, need);
  if (need > 0) for (const pr of db.properties) {
    if (pr.ownerId !== holder.id) continue;
    need -= removeInventory(pr, itemId, need);
    if (need <= 0) break;
  }
  return qty - need; // actually drawn
}

// Effective government tariff (%) on a trade. Additive levels, so the state can
// set one baseline and refine it: global (everyone) + a per-COUNTRY surcharge
// (the foreign partner) + a per-COMPANY surcharge (the domestic trader). Import
// and export are tracked separately. The government never tariffs its own
// stockpile trades (it IS the taxing authority). Clamped to [0, 90]%.
function tradeTariffRate(db, side, holder, partnerId, itemId) {
  const tf = db.settings.trade && db.settings.trade.tariffs;
  if (!tf || !holder) return 0;
  if (holder.type === 'government' || holder.id === 'ent_gov') return 0;
  const key = side === 'sell' ? 'export' : 'import';
  const num = (o) => (o && Number(o[key])) || 0;
  const rate = num(tf.global)
    + num(tf.byCountry && tf.byCountry[partnerId])
    + num(tf.byCompany && tf.byCompany[holder.id])
    + num(tf.byItem && tf.byItem[itemId]);
  return Math.max(0, Math.min(90, rate));
}

// Execute a player trade against an open order. side 'sell' = fill a foreign
// BUY order from the holder's stock (money in); side 'buy' = take from a
// foreign SELL order (money out, goods into the holder's own inventory).
// The government trades through the treasury; companies through their account.
function executeTrade(side, orderId, holderId, qty, actor) {
  const db = store.get();
  const trade = db.settings.trade;
  const book = trade && trade.orders;
  if (!book) throw new Error('The order book has not opened yet — advance a turn');
  const order = (side === 'sell' ? book.buys : book.sells).find(o => o.id === orderId);
  if (!order) throw new Error('That order is no longer on the book');
  const holder = db.entities.find(e => e.id === holderId);
  if (!holder) throw new Error('Unknown holder');
  const item = db.items.find(i => i.id === order.itemId);
  if (!item) throw new Error('Unknown item');
  if (item.tradable === false) throw new Error('That item is no longer tradable.');
  qty = cleanQty(qty);
  const remaining = order.qty - (order.filled || 0);
  if (!(qty > 0)) throw new Error('Quantity must be positive');
  if (qty > remaining) qty = remaining;
  if (qty <= 0) throw new Error('That order is already filled');

  const isGov = holder.type === 'government' || holder.id === 'ent_gov';
  const acct = isGov
    ? (db.accounts.find(a => a.id === 'acct_treasury') || primaryAccount(holder.id, true))
    : primaryAccount(holder.id, true);
  const unit = tradeUnitPrice(order, qty, side);
  const value = Math.round(unit * qty * 100) / 100;
  const partnerName = (db.entities.find(e => e.id === order.partnerId) || {}).name || order.partnerId;
  const embargo = trade.tariffs && trade.tariffs.embargoes && trade.tariffs.embargoes[item.id];
  const direction = side === 'sell' ? 'export' : 'import';
  if (embargo && embargo[direction]) throw new Error(`Trade embargoed for ${item.name}.`);
  const tariffRate = tradeTariffRate(db, side, holder, order.partnerId, item.id);
  const tariff = Math.round(value * tariffRate / 100 * 100) / 100;
  const treasury = tariff > 0 ? (db.accounts.find(a => a.id === 'acct_treasury')) : null;
  const cur = db.settings.currency;

  if (side === 'sell') {
    if (holderStock(db, holder, order.itemId) < qty) throw new Error('Not enough stock to sell');
    drawHolderStock(db, holder, order.itemId, qty);
    // export duty is skimmed from the proceeds into the treasury
    const net = Math.round((value - tariff) * 100) / 100;
    ledgerTxn(null, acct.id, net, `Export of ${item.name} to ${partnerName}${tariff ? ` (net of ${tariffRate}% duty)` : ''}`, actor, 'deposit');
    if (treasury && tariff > 0) ledgerTxn(null, treasury.id, tariff, `Export duty (${tariffRate}%) — ${holder.name} → ${partnerName}`, 'TREASURY', 'deposit');
    // the buying partner actually receives the goods — mirrors the import
    // side below, which already lands purchases in the holder's inventory
    const partner = db.entities.find(en => en.id === order.partnerId);
    if (partner) addInventory(partner, order.itemId, qty);
    db.globalVars.lastExportIncome = Math.round(((db.globalVars.lastExportIncome || 0) + value) * 100) / 100;
    trade.lastFlows = trade.lastFlows || [];
    trade.lastFlows.push({ itemId: order.itemId, partnerId: order.partnerId, qty, value, tariff });
  } else {
    // import tariff is added on top of the purchase price, paid to the treasury
    const total = Math.round((value + tariff) * 100) / 100;
    if (acct.balance < total) throw new Error(`Insufficient funds for that purchase${tariff ? ' (incl. ' + tariffRate + '% tariff)' : ''}`);
    ledgerTxn(acct.id, null, value, `Import of ${item.name} from ${partnerName}`, actor, 'withdraw');
    if (treasury && tariff > 0) ledgerTxn(acct.id, treasury.id, tariff, `Import tariff (${tariffRate}%) — ${holder.name} ← ${partnerName}`, 'TREASURY', 'transfer');
    addInventory(holder, order.itemId, qty);
    db.globalVars.lastImportSpend = Math.round(((db.globalVars.lastImportSpend || 0) + value) * 100) / 100;
    trade.lastFlows = trade.lastFlows || [];
    trade.lastFlows.push({ itemId: order.itemId, partnerId: order.partnerId, qty, value: -value, tariff });
  }
  if (tariff > 0) db.globalVars.lastTariffIncome = Math.round(((db.globalVars.lastTariffIncome || 0) + tariff) * 100) / 100;
  order.filled = (order.filled || 0) + qty;
  store.log('economy', `${holder.name} ${side === 'sell' ? 'exported' : 'imported'} ${qty} × ${item.name}`,
    `${side === 'sell' ? 'to' : 'from'} ${partnerName} @ ${cur}${unit}/unit — ${cur}${fmtNum(value)}${tariff ? ` · ${side === 'sell' ? 'duty' : 'tariff'} ${cur}${fmtNum(tariff)} (${tariffRate}%)` : ''}`, actor, [holder.id, order.partnerId]);
  return { qty, unit, value, tariff, tariffRate, filled: order.filled, orderQty: order.qty };
}

// ---------- ongoing trade contracts ----------------------------------------
// A contract automates the open market: every turn, right after the fresh
// order book opens (advanceTurn), each active contract re-fills its chosen
// listing — matched by partner + item + side, because order ids are
// regenerated every turn — through the SAME executeTrade() path as a manual
// fill. Volume pricing impact, tariffs, embargoes, stock and funds checks are
// therefore identical by construction. A turn whose book has no matching
// order (or an already-filled / embargoed / unaffordable one) just idles: the
// miss is noted on the record for its dossier row, and one turn of duration
// burns anyway. turnsLeft === null means "until cancelled".
function runTradeContracts(db, actor) {
  const list = db.tradeContracts || [];
  if (!list.length) return;
  const book = db.settings.trade && db.settings.trade.orders;
  const cur = db.settings.currency;
  const nameOf = (id) => { const e = db.entities.find(x => x.id === id); return e ? e.name : id; };
  const itemName = (id) => { const it = db.items.find(x => x.id === id); return it ? it.name : id; };
  const r2 = (v) => Math.round(v * 100) / 100;
  for (const c of list) {
    if (c.status !== 'active') continue;
    c.lastTurnNote = null;
    // duration accounting runs regardless of whether the trade fires: N turns
    // means N turn-openings, the last of which still trades before expiry.
    let expiring = false;
    if (c.turnsLeft !== null && c.turnsLeft !== undefined) {
      if (c.turnsLeft <= 0) { c.status = 'done'; continue; }
      c.turnsLeft--;
      expiring = c.turnsLeft <= 0;
    }

    if (c.kind === 'transfer') {
      // ---- standing player-to-player trade (the repeat of a negotiated offer) ----
      // Mirrors the one-shot /api/trades flow but as a standing agreement:
      // every active turn the engine replays the same give/get/money that a
      // manual trade would have moved, drawn from pooled stock (entity +
      // its sites, like any export) and through the ledger. Short stock
      // delivers partially, broke payers are noted — neither crashes the turn
      // nor voids the rest of the agreement. Legacy contracts (single
      // itemId/qtyPerTurn/payByFrom/payByTo) are normalized on the fly.
      // Normalize legacy → trade shape
      if (!c.give && c.itemId) {
        c.give = [{ itemId: c.itemId, qty: c.qtyPerTurn || 0 }];
        c.get = c.get || [];
        c.money = c.money || { give: c.payByFrom || 0, get: c.payByTo || 0 };
      }
      if (!Array.isArray(c.give)) c.give = [];
      if (!Array.isArray(c.get)) c.get = [];
      if (!c.money || typeof c.money !== 'object') c.money = { give: 0, get: 0 };
      const from = db.entities.find(e => e.id === c.fromEntityId);
      const to = db.entities.find(e => e.id === c.toEntityId);
      if (!from || !to) {
        c.lastTurnNote = 'a party no longer exists';
      } else {
        const notes = [];
        let deliveredAny = false;
        // Give: from → to
        for (const r of c.give) {
          const it = db.items.find(i => i.id === r.itemId);
          if (!it) { notes.push('unknown item ' + r.itemId); continue; }
          const want = cleanQty(r.qty);
          if (!(want > 0)) continue;
          const drawn = drawHolderStock(db, from, r.itemId, want);
          if (drawn > 0) {
            addInventory(to, r.itemId, drawn);
            c.totalQty = r2((c.totalQty || 0) + drawn);
            deliveredAny = true;
          }
          if (drawn < want) notes.push((it.name || r.itemId) + ' short — delivered ' + drawn + ' of ' + want + ' from ' + from.name);
        }
        // Get: to → from (the counter-give)
        for (const r of c.get) {
          const it = db.items.find(i => i.id === r.itemId);
          if (!it) { notes.push('unknown item ' + r.itemId); continue; }
          const want = cleanQty(r.qty);
          if (!(want > 0)) continue;
          const drawn = drawHolderStock(db, to, r.itemId, want);
          if (drawn > 0) {
            addInventory(from, r.itemId, drawn);
            c.totalQty = r2((c.totalQty || 0) + drawn);
            deliveredAny = true;
          }
          if (drawn < want) notes.push((it.name || r.itemId) + ' short — delivered ' + drawn + ' of ' + want + ' from ' + to.name);
        }
        const pay = (payer, payee, amount, label) => {
          if (!(amount > 0)) return;
          const fa = primaryAccount(payer.id, true);
          const ta = primaryAccount(payee.id, true);
          if (fa.balance < amount) { notes.push(label + ' failed — ' + payer.name + ' lacks funds'); return; }
          // Use generic contract payment memo so the ledger stays readable
          const memo = 'Contract payment' + (c.memo ? ' — ' + c.memo : '');
          ledgerTxn(fa.id, ta.id, amount, memo, actor || 'ENGINE', 'transfer');
          deliveredAny = true;
        };
        const mGive = Math.round(Number(c.money.give) * 100) / 100;
        const mGet = Math.round(Number(c.money.get) * 100) / 100;
        if (mGive > 0) pay(from, to, mGive, 'payment');
        if (mGet > 0) pay(to, from, mGet, 'rebate');
        // Legacy money fields kept for old UI, but prefer c.money
        if ((!c.money || (!mGive && !mGet)) && (c.payByFrom || c.payByTo)) {
          if (c.payByFrom > 0) pay(from, to, c.payByFrom, 'payment');
          if (c.payByTo > 0) pay(to, from, c.payByTo, 'rebate');
        }
        if (deliveredAny) c.executions = (c.executions || 0) + 1;
        c.lastTurnNote = notes.join(' · ') || null;
        const giveDesc = c.give.map(r => {
          const it = db.items.find(i => i.id === r.itemId);
          return (it ? it.name : r.itemId) + ' ×' + r.qty;
        }).join(', ');
        const getDesc = c.get.map(r => {
          const it = db.items.find(i => i.id === r.itemId);
          return (it ? it.name : r.itemId) + ' ×' + r.qty;
        }).join(', ');
        store.log('inventory', `Contract delivery — ${giveDesc || 'no goods'}${getDesc ? ' ⇄ ' + getDesc : ''}`,
          `${from.name} → ${to.name}${mGive ? ' · paid ' + cur + mGive : ''}${mGet ? ' · rebated ' + cur + mGet : ''}${c.memo ? ' · ' + c.memo : ''}${notes.length ? ' · ' + notes.join('; ') : ''}`,
          actor || 'ENGINE', [from.id, to.id, ...c.give.map(r => r.itemId), ...c.get.map(r => r.itemId)]);
      }
    } else {
      // ---- open-market order automation (matched by partner+item+side,
      // because order ids regenerate every turn) ----
      const orders = book ? ((c.side === 'sell' ? book.buys : book.sells) || []) : [];
      const order = orders.find(o => o.partnerId === c.partnerId && o.itemId === c.itemId);
      if (!order) {
        c.lastTurnNote = book ? 'no matching order on this turn’s book' : 'order book closed';
      } else {
        try {
          const r = executeTrade(c.side, order.id, c.holderId, c.qtyPerTurn, actor || 'ENGINE');
          c.executions++;
          c.totalQty = r2((c.totalQty || 0) + r.qty);
          c.totalValue = r2((c.totalValue || 0) + (c.side === 'sell' ? r.value : -r.value));
          c.lastUnit = r.unit;
        } catch (e) { c.lastTurnNote = e.message; } // unfunded, out of stock, embargoed… — idle, never crash the turn
      }
    }

    if (expiring) {
      c.status = 'done';
      // For transfer contracts, build a give/get summary (handles both legacy and new shape)
      const transferSummary = (() => {
        if (c.give && c.give.length) {
          const g = c.give.map(r => `${itemName(r.itemId)} ×${r.qty}`).join(', ');
          const gg = c.get && c.get.length ? ' ⇄ ' + c.get.map(r => `${itemName(r.itemId)} ×${r.qty}`).join(', ') : '';
          return `${g}${gg}`;
        }
        if (c.itemId) return `${itemName(c.itemId)} ×${c.qtyPerTurn}/turn`;
        return 'standing trade';
      })();
      store.log('economy', 'Ongoing contract completed',
        c.kind === 'transfer'
          ? `${nameOf(c.fromEntityId)} → ${nameOf(c.toEntityId)} (${transferSummary}${c.memo ? ' · ' + c.memo : ''}) ran its course: ${c.executions} deliver${c.executions === 1 ? 'y' : 'ies'}.`
          : `${nameOf(c.holderId)} — ${itemName(c.itemId)} ${c.side === 'sell' ? 'exports to' : 'imports from'} ${nameOf(c.partnerId)} ran its course: ${c.executions} fill${c.executions === 1 ? '' : 's'}, ${db.settings.currency}${fmtNum(Math.abs(c.totalValue || 0))} total.`,
        actor || 'ENGINE', [c.holderId || c.fromEntityId, c.partnerId || c.toEntityId]);
    }
  }
}

// Bank-of-Arcasia solvency → economic crash. The Bank is the market-maker for
// the Day Market: it funds every share sale and every capital raise from a
// finite reserve. If players drain it below zero it can no longer honour its
// book, and the whole economy seizes: company confidence collapses (dragging
// economic confidence and share prices), and civilian happiness, employment and
// approval slide every turn until the reserve is recapitalised. The hit deepens
// with the size of the shortfall relative to the money supply. Runs each turn
// after trade settles, before updateDerived (so the confidence hit propagates).
function runBankCrisis(db, actor) {
  const g = db.globalVars;
  const bank = db.accounts.find(a => a.ownerId === 'ent_bank') || db.accounts.find(a => a.id === 'acct_bank');
  if (!bank) return;
  const bal = bank.balance;
  if (bal > 0) {
    if (g.bankCrisis) {
      g.bankCrisis = false; g.bankCrisisSeverity = 0;
      draftNews('Bank of Arcasia reserve restored',
        `The Bank of Arcasia has pulled its reserve back above zero, to ${db.settings.currency}${fmtNum(bal)}. Ministers moved to reassure markets that the emergency has passed; employers and households will take longer to be convinced.`,
        'Economy', true, 'State Statistical Bureau');
      store.log('economy', 'Bank reserve restored — crisis over', `reserve ${db.settings.currency}${fmtNum(bal)}`, actor || 'ENGINE', ['ent_bank']);
    }
    return;
  }
  // reserve exhausted — severity scales with the depth of the shortfall
  const ms = Math.max(1, g.moneySupply || 1);
  const depth = Math.min(1, -bal / (ms * 0.04)); // 4% of money supply underwater ⇒ full severity
  const sev = 0.35 + 0.65 * depth;
  for (const co of db.entities) {
    if (co.type !== 'company' || co.confidence === undefined) continue;
    co.confidence = clamp01(Math.round((co.confidence - 12 * sev) * 10) / 10, 0, 100);
    if (co.dayPrice !== undefined) {
      co.dayPrice = Math.max(0.01, Math.round(co.dayPrice * (1 - 0.05 * sev) * 100) / 100);
      // Direct day-price writes must reanchor the pricepath wander and sync
      // the certificate item's marketValue (two-price invariants) — otherwise
      // trades kept filling near pre-crash quotes until the next day-tick,
      // which on an idle serverless deployment could be a long time.
      try {
        const market = require('./market');
        market.dayReanchor(co);
        const it = market.shareItemFor(co.id);
        if (it) it.marketValue = co.dayPrice;
      } catch (e) { /* market optional */ }
    }
  }
  const hHit = 2.2 * sev, eHit = 1.6 * sev, aHit = 1.4 * sev;
  for (const p of db.provinces) {
    if (p.vars.happiness !== undefined) p.vars.happiness = clamp01(Math.round((p.vars.happiness - hHit) * 100) / 100, 0, 100);
    if (p.vars.employment !== undefined) p.vars.employment = clamp01(Math.round((p.vars.employment - eHit) * 100) / 100, 0, 100);
    if (p.vars.approval !== undefined) p.vars.approval = clamp01(Math.round((p.vars.approval - aHit) * 100) / 100, 0, 100);
  }
  g.bankCrisisSeverity = Math.round(sev * 100) / 100;
  if (!g.bankCrisis) {
    g.bankCrisis = true;
    draftNews('ECONOMIC CRISIS: Bank of Arcasia reserve exhausted',
      `The Bank of Arcasia has run its reserve to ${db.settings.currency}${fmtNum(bal)} — below zero. Unable to honour its market book, the Bank has frozen and share prices are sliding. Employers are shedding labour and public confidence has collapsed. The government is under mounting pressure to recapitalise the Bank before the slump deepens.`,
      'Economy', true, 'State Statistical Bureau');
  }
  store.log('economy', 'Bank reserve exhausted — economic crash', `reserve ${db.settings.currency}${fmtNum(bal)} · severity ${(sev * 100).toFixed(0)}%`, actor || 'ENGINE', ['ent_bank']);
}

// Demographics breathe with the economy. Each turn every province's
// demographic groups drift toward the anchors the economy is setting
// (employment, happiness, approval, global economic confidence) — with
// class-specific sensitivity, so a market boom lifts the Upper Class mood
// before the Working Class feels it. On month boundaries the slower forces
// act: incomes track GDP growth and confidence, populations grow (or stall)
// with wellbeing, and a confident economy pulls villagers into the cities.
// Phase 35: `scale` parameter (default 1) multiplies all drift rates so
// the cadence scheduler can fire this at sub-turn intervals while preserving
// cumulative per-turn effects.
const DEMO_SENS = { 'Upper Class': 1.6, 'Middle Class': 1.2, 'Urban': 1.2, 'Working Class': 0.9, 'Students': 0.8, 'Rural': 0.7, 'Retired': 0.6 };
function runDemographics(db, monthBoundary, scale) {
  scale = typeof scale === 'number' && isFinite(scale) ? scale : 1;
  const econC = db.globalVars.econConfidence === undefined ? 50 : db.globalVars.econConfidence;
  const gdpGrowth = Number(db.globalVars.gdpGrowth || 0);
  const crisis = db.globalVars.bankCrisis ? (db.globalVars.bankCrisisSeverity || 0.5) : 0;
  const r1 = (v) => Math.round(v * 10) / 10;
  const clampB = (v) => Math.max(0, Math.min(100, v));
  // Jitter scales with sqrt of the drift scale so a cadence firing N times
  // per turn accumulates roughly the same per-turn randomness as one full
  // call, and scale=0 (month-boundary-only mode) jitters not at all.
  const jitter = 0.15 * Math.sqrt(Math.max(0, Math.min(1, scale)));
  const pull = (cur, target, k) => cur + (target - cur) * k + (Math.random() * 2 - 1) * jitter;
  for (const p of db.provinces) {
    if (!p.demographics) continue;
    const hapA = p.vars.happiness !== undefined ? p.vars.happiness : 50;
    const empA = p.vars.employment !== undefined ? p.vars.employment : 85;
    const appA = p.vars.approval !== undefined ? p.vars.approval : 50;
    for (const gname in p.demographics) {
      const d = p.demographics[gname];
      const sens = DEMO_SENS[gname] || 1;
      // fast per-turn drift toward the province/economy anchors (scaled by
      // `scale` for sub-turn cadence ticks — Phase 35)
      d.economicConfidence = r1(clampB(pull(d.economicConfidence, econC, 0.06 * sens * scale)));
      d.employment = r1(clampB(pull(d.employment, empA - crisis * 3 * sens, 0.05 * scale)));
      d.happiness = r1(clampB(pull(d.happiness, hapA + (d.employment - empA) * 0.15, 0.04 * scale)));
      d.governmentSupport = r1(clampB(pull(d.governmentSupport, appA - crisis * 4, 0.025 * scale)));
      if (monthBoundary) {
        // incomes ride GDP growth and confidence, with class sensitivity
        const incF = 1 + gdpGrowth * 0.5 * sens + ((econC - 50) / 50) * 0.012 * sens - crisis * 0.02;
        d.income = Math.max(50, Math.round(d.income * incF));
        // population growth: wellbeing-driven, roughly −2%…+5% a year
        const r = Math.max(-0.002, Math.min(0.004,
          0.0012 + (d.happiness - 50) * 0.00003 + (d.employment - 85) * 0.00002 - crisis * 0.0015));
        d.population = Math.max(0, Math.round(d.population * (1 + r)));
      }
    }
    // monthly rural→urban migration: a confident economy urbanises
    if (monthBoundary && p.demographics['Rural'] && p.demographics['Urban']) {
      const rate = Math.max(0, Math.min(0.004, 0.001 + (econC - 50) * 0.00004 - crisis * 0.001));
      const movers = Math.round(p.demographics['Rural'].population * rate);
      if (movers > 0) {
        p.demographics['Rural'].population -= movers;
        p.demographics['Urban'].population += movers;
      }
    }
    p.vars.population = Object.values(p.demographics).reduce((s, d) => s + (d.population || 0), 0);
  }
  db.globalVars.population = db.provinces.reduce((s, p) => s + (p.vars.population || 0), 0);
}

// Append a compact trade sample for the graphs (kept bounded).
function recordTradeHistory(db) {
  const trade = db.settings.trade;
  if (!trade) return;
  trade.history = trade.history || [];
  const flows = trade.lastFlows || [];
  const byItem = {};
  for (const f of flows) if (f.value > 0) byItem[f.itemId] = (byItem[f.itemId] || 0) + f.value;
  trade.history.push({
    turn: db.settings.time.turn, date: db.settings.time.date,
    exportValue: flows.reduce((s, f) => s + Math.max(0, f.value), 0),
    importValue: flows.reduce((s, f) => s + Math.max(0, -f.value), 0),
    byItem
  });
  if (trade.history.length > 90) trade.history.splice(0, trade.history.length - 90);
}

// ---------- foreign relations (Phase 25 — diplomacy) ----------
// Every foreign power carries vars.relations (0-100, default 50). It moves
// from OBSERVABLE acts, never GM whim alone: trading with the Republic warms
// ties a little every turn it happens, tariffs aimed at a partner cool them,
// and war shocks (invading, intervening) land as one-shots from server/war.js.
// Relations feed straight back into trade pricing (relationsPriceMult above).
function relationsOf(e) {
  const v = e && e.vars && Number(e.vars.relations);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 50;
}
function relationsPriceMult(db, partnerId) {
  const e = db.entities.find(x => x.id === partnerId);
  return e ? 0.9 + relationsOf(e) / 500 : 1; // 0.9× at 0 … 1.1× at 100
}
function shiftRelations(db, entityId, delta, why, actor) {
  const e = db.entities.find(x => x.id === entityId);
  if (!e || e.type !== 'foreign') return;
  e.vars = e.vars || {};
  const before = relationsOf(e);
  e.vars.relations = Math.round(Math.max(0, Math.min(100, before + delta)) * 100) / 100;
  if (Math.abs(delta) >= 10) {
    store.log('politics', `Relations with ${e.name} ${delta > 0 ? 'improve' : 'deteriorate'}`,
      `${why || ''} (${Math.round(before)} → ${Math.round(e.vars.relations)})`, actor || 'ENGINE', [e.id]);
  }
}
function runDiplomacy(db) {
  const trade = db.settings.trade || {};
  const tariffs = (trade.tariffs && trade.tariffs.byCountry) || {};
  const tradedWith = new Set((trade.lastFlows || []).map(f => f.partnerId).filter(Boolean));
  for (const e of db.entities) {
    if (e.type !== 'foreign') continue;
    e.vars = e.vars || {};
    let r = relationsOf(e);
    if (tradedWith.has(e.id)) r += 0.4;                       // commerce warms ties
    const tf = tariffs[e.id];
    if (tf && ((tf.import || 0) + (tf.export || 0)) > 0) r -= 0.5; // targeted tariffs cool them
    if (!tradedWith.has(e.id) && !(tf && ((tf.import || 0) + (tf.export || 0)) > 0)) {
      r += (50 - r) * 0.01;                                    // otherwise drift slowly back to neutral
    }
    e.vars.relations = Math.round(Math.max(0, Math.min(100, r)) * 100) / 100;
  }
}

// ---------- war bonds (Phase 25) ----------
// A bond is an ordinary Securities item carrying meta.bond = { faceValue,
// maturityTurn, issuerId }. Certificates are sold/traded through the normal
// item plumbing; at maturity every outstanding certificate redeems from the
// issuer's primary account automatically — the engine's only special
// knowledge of bonds is this per-turn sweep.
function redeemMaturedBonds(db, actor) {
  const turn = db.settings.time.turn;
  const due = db.items.filter(i => i.meta && i.meta.bond && !i.meta.bond.redeemed && Number(i.meta.bond.maturityTurn) <= turn);
  for (const bond of due) {
    const face = Number(bond.meta.bond.faceValue) || 0;
    const issuerId = bond.meta.bond.issuerId || 'ent_gov';
    let redeemed = 0;
    for (const e of db.entities) {
      if (!Array.isArray(e.inventory)) continue;
      const row = e.inventory.find(r => r.itemId === bond.id);
      if (!row || !(row.qty > 0)) continue;
      e.inventory = e.inventory.filter(r => r !== row);
      if (e.id === issuerId) continue; // the issuer's own unsold stock just expires
      const payout = Math.round(face * row.qty * 100) / 100;
      if (payout > 0) {
        txn(primaryAccount(issuerId, true).id, primaryAccount(e.id, true).id, payout,
          `${bond.name} matured — ${row.qty} certificate${row.qty === 1 ? '' : 's'} at face value`, actor || 'ENGINE', 'transfer');
        redeemed += row.qty;
      }
    }
    bond.meta.bond.redeemed = true;
    store.log('economy', `${bond.name} matures`,
      redeemed ? `${redeemed} certificate(s) redeemed at ${db.settings.currency}${fmtNum(face)} face value.` : 'No certificates were outstanding.',
      actor || 'ENGINE', [issuerId]);
    if (redeemed) {
      draftNews(`${bond.name.toUpperCase()} REACHES MATURITY`,
        `The Treasury has begun honouring ${bond.name} at full face value. Holders are being paid out through the National Bank.`, 'Economy', true, 'State Financial Desk');
    }
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

    // Production economy (replaces the retired profit events): settle the
    // turn's revenue/upkeep/wages/tax and reprice shares. When the hourly
    // cadence already minted this turn's output in world-hourly slices,
    // runEconomy only settles; when the clock was paused it falls back to
    // the legacy lump pass so manual "Advance Turn" keeps working.
    try { runEconomy(db, actor || 'ENGINE'); } catch (e) { console.error('runEconomy failed:', e.message); }
    db._prodTicksThisTurn = 0;
    // Foreign powers quietly re-arm off-books, in proportion to their authored
    // military profile (Phase 27) — no money involved, just materiel.
    try { runForeignMilitary(db, actor || 'ENGINE'); } catch (e) { console.error('runForeignMilitary failed:', e.message); }
    // Bank solvency check → economy-wide crash while its reserve is underwater.
    try { runBankCrisis(db, actor || 'ENGINE'); } catch (e) { console.error('runBankCrisis failed:', e.message); }
    // Phase 34 — live elections: the count now runs off the continuous world
    // clock (sim.worldClockNow), not turns — see election.js's maybeTick,
    // which is the count's real driver, ridden from GET /api/state and a
    // resident timer in server.js. This onTurn call is just a bonus nudge so
    // a manual "Advance Turn" also gives the count a chance to catch up.
    // Lazy require keeps the sim↔election cycle out of boot.
    try { require('./election').onTurn(db, actor || 'ENGINE'); }
    catch (e) {
      console.error('election tick failed:', e.message);
      // Also surface it in the in-app log — a GM without access to the
      // server console would otherwise never learn the count is stuck.
      try { store.log('election', 'Election tick failed', e.message, 'ENGINE', []); } catch (e2) { /* logging must never break the turn */ }
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
    // taxation is now collected per-turn inside runEconomy (on real net), so the
    // old monthly collectTaxes pass is retired.
    // lottery draws (Phase 12) — lazy require avoids a sim↔casino cycle
    try { require('./casino').drawDueLotteries(db, actor || 'ENGINE'); } catch (e) { /* casino optional */ }
    recordHistory(weekIndex(newMs) !== weekIndex(oldMs));
    // archive the closing turn's executed trades, then open a fresh order
    // book — unless the tradeReset cadence has been rerolling it hourly all
    // turn, in which case only the flow accounting resets here (Part 3c).
    recordTradeHistory(db);
    if ((db._cadenceTicks && db._cadenceTicks.tradeReset > 0)) {
      try { resetTradeFlows(db); } catch (e) { console.error('resetTradeFlows failed:', e.message); }
      db._cadenceTicks.tradeReset = 0;
    } else {
      try { generateTradeOrders(db); } catch (e) { console.error('generateTradeOrders failed:', e.message); }
    }
    // ongoing contracts re-fill their orders against the CURRENT book — fresh
    // when generateTradeOrders just reopened it, otherwise the one the hourly
    // tradeReset cadence has been rerolling all turn (either way it matches by
    // partner + item + side, never by order id)
    try { runTradeContracts(db, actor || 'ENGINE'); } catch (e) { console.error('runTradeContracts failed:', e.message); }
    // demographics breathe with the economy. Fast drift lives on the
    // demographics cadence now (scaled world-hourly slices); when that
    // cadence fired this turn, the pass here runs drift-free and only
    // applies month-boundary growth. When it didn't (paused clock), fall
    // back to the legacy full-strength per-turn drift.
    const demoTicked = db._cadenceTicks && db._cadenceTicks.demographics > 0;
    try { runDemographics(db, monthBoundary, demoTicked ? 0 : undefined); }
    catch (e) { console.error('runDemographics failed:', e.message); }
    if (demoTicked) db._cadenceTicks.demographics = 0;
    // matured war bonds pay out; foreign relations drift with trade/tariffs
    try { redeemMaturedBonds(db, actor || 'ENGINE'); } catch (e) { console.error('redeemMaturedBonds failed:', e.message); }
    try { runDiplomacy(db); } catch (e) { console.error('runDiplomacy failed:', e.message); }
    // Domestic economy & fiscal overhaul (Phases 1–4): wages flow from owners
    // to household wallets, household consumption, real circulating food stock
    // (famine is now a supply fact), inequality stats, and the monthly class-
    // mobility / mortality / demographic-sync passes. Lazy require keeps the
    // sim↔households cycle out of boot. After runEconomy's settlement so the
    // wage money is already sitting in owner accounts when it debits out.
    try {
      const hh = require('./households');
      hh.runWages(db, actor || 'ENGINE');
      hh.runConsumption(db, actor || 'ENGINE');
      hh.runFoodSupply(db, actor || 'ENGINE');
      hh.runInequality(db, actor || 'ENGINE');
      // Health descriptor stats (life expectancy / infant mortality) are cheap
      // and healthcare-driven — refresh every turn so dashboards never sit on
      // stale or missing values. Mortality THINNING stays monthly below.
      hh.refreshHealthStats(db);
      if (monthBoundary) {
        hh.runMobility(db, actor || 'ENGINE');
        hh.runMortality(db, actor || 'ENGINE');
        hh.syncDemographics(db, actor || 'ENGINE');
      }
    } catch (e) { console.error('households pass failed:', e.message); }
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
  const shares = {}, profits = {}, revenues = {};
  for (const e of db.entities) {
    if (e.type !== 'company') continue;
    if (e.sharePrice !== undefined) shares[e.id] = e.sharePrice;
    if (e.vars && e.vars.profit !== undefined) profits[e.id] = e.vars.profit;
    if (e.vars && e.vars.revenue !== undefined) revenues[e.id] = e.vars.revenue;
  }
  const entry = {
    turn: db.settings.time.turn, date: db.settings.time.date,
    gdp: g.gdp || 0, population: g.population || 0,
    avgHappiness: g.avgHappiness || 0, avgApproval: g.avgApproval || 0,
    moneySupply: g.moneySupply || 0, treasury: g.treasury || 0,
    tax: g.lastTaxIncome || 0, exports: g.lastExportIncome || 0, imports: g.lastImportSpend || 0,
    provinces, shares, profits, revenues,
    expenses: Object.fromEntries(db.entities.filter(e => e.type === 'company' && e.vars && e.vars.expenses !== undefined).map(e => [e.id, e.vars.expenses]))
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
  // Cap kept deliberately low: every commit rewrites the whole doc to Postgres,
  // and 1000 per-turn snapshots (with per-province/per-company objects) were
  // 1-2MB of each PATCH. The state payload ships only the last 60; /api/history
  // serves this archive to the long-range charts once per turn.
  if (db.history.length > 240) db.history.splice(0, db.history.length - 240);
}

// ---------- elections -----------------------------------------------------
// Support is computed from the simulated population: every demographic group
// in every province scores every party, votes split by softmax.
function scoreParty(party, gname, group, provId) {
  const ideo = party.ideology || { econ: 0, soc: 0 };
  let s = 50;
  s -= 0.5 * Math.abs((group.politicalLeaning || 0) - (ideo.econ || 0));
  s += (50 - (group.education || 50)) * (ideo.soc || 0) * 0.006;
  const gs = group.governmentSupport || 50;
  s += party.inGovernment ? (gs - 50) * 0.35 : (50 - gs) * 0.12;
  const sup = (party.support || {})[provId];
  if (sup) {
    // `all` is the legacy blanket bucket (untargeted drives, unchanged);
    // a group key is support a targeted campaign won from that demographic
    // bucket specifically. Both count toward the group being scored.
    const credit = (sup.all || 0) + (sup[gname] || 0);
    if (credit > 0) s += credit * 1.2;
  }
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
      const scores = parties.map(pt => scoreParty(pt, gname, g, p.id) + (noise ? (Math.random() * 6 - 3) : 0));
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

// Apportion the parliament's seats to provinces by population (largest
// remainder, min 2) and allocate each province's seats by D'Hondt from the
// per-province vote tallies. Shared by runElection (instant results) and the
// live election count's finalize (server/election.js).
function apportionSeats(byProvince, totalSeats) {
  const db = store.get();
  const totalPop = db.provinces.reduce((s, p) => s + (p.vars.population || 0), 0) || 1;

  // apportion seats to provinces by population (largest remainder, min 2)
  const quotas = db.provinces.map(p => ({ id: p.id, q: (p.vars.population || 0) / totalPop * totalSeats }));
  const seatsByProv = {};
  let used = 0;
  quotas.forEach(x => { seatsByProv[x.id] = Math.max(2, Math.floor(x.q)); used += seatsByProv[x.id]; });
  quotas.sort((a, b) => (b.q - Math.floor(b.q)) - (a.q - Math.floor(a.q)));
  let k = 0;
  while (used < totalSeats) { seatsByProv[quotas[k % quotas.length].id]++; used++; k++; }
  // The over-allocation drain must bail when a full rotation removes nothing
  // — with min 2 seats/province and parliamentSeats < 2×provinces every
  // province sits at its floor and the loop never terminated (it ran inside
  // election finalize, freezing the whole process on a GM-set seat count).
  while (used > totalSeats) {
    let removed = false;
    for (const q of quotas) {
      if (used <= totalSeats) break;
      if (seatsByProv[q.id] > 2) { seatsByProv[q.id]--; used--; removed = true; }
    }
    if (!removed) break; // floor-bound: accept the small overshoot rather than hang
    if (++k > 100000) break; // absolute paranoia bound
  }

  const seatTotals = {}; db.entities.filter(e => e.type === 'party').forEach(p => seatTotals[p.id] = 0);
  const provResults = {};
  for (const p of db.provinces) {
    // byProvince can lack a province that joined/ceded mid-count — an empty
    // tally beats Object.keys(undefined) throwing inside finalize.
    const won = dhondt(byProvince[p.id] || {}, seatsByProv[p.id]);
    provResults[p.id] = { seats: won, votes: byProvince[p.id] };
    for (const pid in won) seatTotals[pid] += won[pid];
  }
  return { seatTotals, provResults };
}

function runElection(actor, manual) {
  if (manual) return runManualElection(actor, manual);
  const db = store.get();
  const { parties, byProvince, national, totalVotes } = computePolling(true);
  const totalSeats = db.settings.parliamentSeats || 150;
  const { seatTotals, provResults } = apportionSeats(byProvince, totalSeats);

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
// Whether a resident process owns the auto-advance timer. When it doesn't
// (serverless / cloud mode), overdue turns ride ordinary /api/state fetches
// through the gated autoTick below — same pattern as market.maybeDayTick.
// Riding requests in long-lived mode too would DOUBLE-advance (the timer
// doesn't maintain auto.lastTick), hence the guard.
function isLongLived() { return longLived; }

function worldClockNow(t, now) {
  t = t || {};
  const c = t.clock || {};
  const base = Number(c.anchorWorldMs) || Date.parse(String(t.date || '1970-01-01') + 'T00:00:00Z') || Date.now();
  const anchor = Number(c.anchorRealMs) || Date.now();
  // Both sides are milliseconds after conversion: N world minutes per real
  // minute means N world milliseconds per real millisecond. An explicitly
  // configured 0 must PAUSE the clock (rate 0), not fall back to the default
  // — `Number(x) || 59.5` turned a deliberate pause into fast-forward.
  const cfgRate = Number(c.minutesPerRealMinute);
  const rate = Number.isFinite(cfgRate) ? Math.max(0, cfgRate) : 59.5;
  return base + ((Number(now) || Date.now()) - anchor) * rate;
}

function parseClockMinutes(value) {
  const m = String(value || '08:00').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 8 * 60;
  return Math.min(1439, Math.max(0, Number(m[1]) * 60 + Number(m[2])));
}

function clockTurnsDue(t, now) {
  const current = worldClockNow(t, now);
  const previous = Number(t.auto.lastWorldMs) || current;
  const at = parseClockMinutes(t.auto.at);
  const day = 86400000;
  const firstDay = Math.floor(previous / day) * day + at * 60000;
  const first = firstDay <= previous ? firstDay + day : firstDay;
  if (first > current) return { due: 0, current };
  return { due: Math.min(30, Math.floor((current - first) / day) + 1), current };
}

function scheduleAuto() {
  if (!longLived) return;
  const db = store.get();
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  const auto = db.settings.time.auto;
  if (auto && auto.enabled) {
    const pollSeconds = auto.mode === 'clock'
      ? Math.min(60, Math.max(15, auto.seconds || 60))
      : Math.max(15, auto.seconds || 3600);
    autoTimer = setInterval(() => {
      try { autoTick('AUTO'); } catch (e) { console.error('auto-advance failed:', e); }
    }, pollSeconds * 1000);
  }
}

function autoTick(actor) {
  const t = store.get().settings.time;
  if (!t.auto || !t.auto.enabled) return { advanced: 0, enabled: false };
  if (t.auto.mode === 'clock') {
    if (!t.clock || !t.clock.enabled) return { advanced: 0, enabled: true, mode: 'clock', turn: t.turn };
    const hit = clockTurnsDue(t, Date.now());
    if (!t.auto.lastWorldMs) t.auto.lastWorldMs = hit.current;
    if (hit.due > 0) {
      advanceTurn(hit.due, actor || 'AUTO');
      // Move the watermark to now so a dormant serverless app catches up once
      // rather than replaying the same wall-clock crossings on every request.
      t.auto.lastWorldMs = hit.current;
      store.save();
      return { advanced: hit.due, enabled: true, mode: 'clock', turn: t.turn, worldMs: hit.current };
    }
    return { advanced: 0, enabled: true, mode: 'clock', turn: t.turn, worldMs: hit.current };
  }
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
  runEconomy, runElection, apportionSeats, computePolling, txn, ledgerTxn, primaryAccount, draftNews, updateDerived,
  scheduleAuto, setLongLived, isLongLived, autoTick, syncPresidency,
  generateTradeOrders, rerollTradeBook, resetTradeFlows, executeTrade, holderStock, tradeTariffRate,
  shiftRelations, relationsOf, worldClockNow, runDemographics,
  runHourlyProductionTick,
  createTenderObj, closeDueTenders,
  findProv, findEnt, findItem
};
