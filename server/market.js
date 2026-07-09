'use strict';
// Stock market. The shareholder register (company.shareholders) is the
// CANONICAL ownership record; share-certificate items (item.meta.companyId)
// mirror it so shares trade like any other inventory item. `setHolding` is the
// single choke point that keeps the two in lockstep.
//
// TWO PRICES per company:
//   · sharePrice — the TURN price ("Company Value"). Repriced once per turn from
//     earnings/economic confidence (server/sim.js). Reflects real value; the
//     left exchange graph plots its per-turn history.
//   · dayPrice   — the DAY MARKET price. A consumer/speculator price that ticks
//     every ~5s and on every trade, driven ONLY by speculation, economic
//     confidence and player order flow — never directly by earnings. Players BUY
//     and SELL here; the right exchange graph plots co.dayHistory.
//
// COUNTERPARTY: the National Bank (ent_bank). Buys pay the bank; sells and
// primary offerings are paid BY the bank from its finite, fully-visible reserve;
// buybacks pay the bank. Flooding the market with offerings drains the bank — a
// real, tracked consequence.
const store = require('./store');
const sim = require('./sim');
const pricepath = require('./pricepath'); // byte-identical with public/js/pricepath.js (client copy)

const BANK_ID = 'ent_bank';
const DEFAULT_DEPTH = 5;   // price impact per unit of (qty / sharesOutstanding)
const MAX_TICK = 0.25;     // a single trade can move the day quote at most ±25%
const DEFAULT_VOL = 0.02;  // per-tick speculative wiggle amplitude
// Day-Market circuit breakers: speculation may range this far from fundamental
// value before it is clamped, so the day price can diverge widely from earnings
// (that is the point) without running away to zero or infinity.
const DAY_BAND_LO = 0.25, DAY_BAND_HI = 4;

function round2(n) { return Math.round(n * 100) / 100; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function newSeed() { return (Math.floor(Math.random() * 0x7fffffff) + 1) >>> 0; }

// Counterparty account for all share cash flows (the National Bank reserve).
function bankAccount() { return sim.primaryAccount(BANK_ID, true); }

function shareItemFor(companyId) {
  return store.get().items.find(i => i.meta && i.meta.companyId === companyId) || null;
}

// ---- Day Market (speculation) --------------------------------------------
function softBand(co, price) {
  const fv = co.sharePrice || price || 0.01;
  return clamp(price, fv * DAY_BAND_LO, fv * DAY_BAND_HI);
}
function dayReanchor(co) {
  co.dayAnchor = { price: co.dayPrice, t0: Date.now(), seed: newSeed() };
}
// The live day quote right now — the committed dayPrice with a small seeded
// wander so it feels alive between 5s ticks. All trades execute here.
function currentDayPrice(co) {
  const base = (co.dayPrice === undefined ? co.sharePrice : co.dayPrice) || 0.01;
  if (!co.dayAnchor) return round2(base);
  const a = co.dayAnchor;
  return pricepath.price(a.price, a.t0, a.seed, Date.now(), co.vol === undefined ? DEFAULT_VOL : co.vol, base);
}
// Asymmetric confidence response to a fractional price move: sharp DROPS knock
// confidence ~2.3× harder than equal rises lift it.
function nudgeConfidence(co, ret) {
  if (!isFinite(ret)) return;
  const cur = co.confidence === undefined ? 50 : co.confidence;
  const gain = ret >= 0 ? ret * 35 : ret * 80;
  co.confidence = clamp(Math.round((cur + gain) * 10) / 10, 0, 100);
}
// Order-flow impact on the DAY price. signedQty: +buy, −sell.
function applyDayImpact(co, signedQty, execPrice) {
  const depth = co.marketDepth || DEFAULT_DEPTH;
  const frac = signedQty / Math.max(1, co.sharesOutstanding || 1);
  const prev = co.dayPrice || execPrice;
  let next = execPrice * (1 + clamp(depth * frac, -MAX_TICK, MAX_TICK));
  next = softBand(co, next);
  co.dayPrice = Math.max(0.01, round2(next));
  nudgeConfidence(co, (co.dayPrice - prev) / (prev || 1));
  dayReanchor(co);
  const it = shareItemFor(co.id);
  if (it) it.marketValue = co.dayPrice;
}
// Global economic confidence = market-cap-weighted mean of company confidence,
// smoothed. Written live by the tick and on trades; read by the per-turn economy
// (revenue), the reprice, and the happiness drift.
function recomputeEconConfidence(db) {
  db = db || store.get();
  db.globalVars = db.globalVars || {};
  let wsum = 0, w = 0;
  for (const co of db.entities) {
    if (co.type !== 'company' || !co.sharesOutstanding) continue;
    const cap = ((co.dayPrice === undefined ? co.sharePrice : co.dayPrice) || 0) * co.sharesOutstanding;
    wsum += (co.confidence === undefined ? 50 : co.confidence) * cap; w += cap;
  }
  const target = w ? wsum / w : 50;
  const prev = db.globalVars.econConfidence === undefined ? 50 : db.globalVars.econConfidence;
  db.globalVars.econConfidence = clamp(Math.round((prev + (target - prev) * 0.3) * 10) / 10, 0, 100);
  return db.globalVars.econConfidence;
}
// One Day-Market tick (~5s from server.js, plus one per turn). Speculative walk
// biased by economic confidence, clamped to the circuit-breaker band. Updates
// each company's confidence, appends to dayHistory, and recomputes econ
// confidence. Returns true if any company was ticked.
function dayMarketTick(db) {
  db = db || store.get();
  db.globalVars = db.globalVars || {};
  const conf = db.globalVars.econConfidence === undefined ? 50 : db.globalVars.econConfidence;
  const confBias = (conf - 50) / 50 * 0.008; // ±0.8%/tick at the extremes
  let any = false;
  for (const co of db.entities) {
    if (co.type !== 'company' || co.sharePrice === undefined) continue;
    any = true;
    if (co.dayPrice === undefined) co.dayPrice = co.sharePrice;
    const prev = co.dayPrice;
    const noise = (Math.random() * 2 - 1) * (co.vol === undefined ? DEFAULT_VOL : co.vol);
    co.dayPrice = Math.max(0.01, round2(softBand(co, co.dayPrice * (1 + confBias + noise))));
    nudgeConfidence(co, (co.dayPrice - prev) / (prev || 1));
    // slow confidence decay toward neutral so old shocks fade
    const c = co.confidence === undefined ? 50 : co.confidence;
    co.confidence = Math.round((c + (50 - c) * 0.01) * 10) / 10;
    co.dayHistory = co.dayHistory || [];
    co.dayHistory.push(co.dayPrice);
    if (co.dayHistory.length > 120) co.dayHistory.shift();
    dayReanchor(co);
    const it = shareItemFor(co.id);
    if (it) it.marketValue = co.dayPrice;
  }
  if (any) recomputeEconConfidence(db);
  return any;
}

// Wall-clock-gated advance. This is what makes the Day Market work on SERVERLESS
// hosting (Vercel), where there is no long-lived process to run a setInterval:
// every request (notably GET /api/state, which clients poll and refetch on the
// realtime signal) calls this, and it runs one tick per elapsed `dayTickMs`
// window (default 5s) — so while anyone is connected the market advances ~every
// 5s and pings everyone, and when nobody is watching it simply idles. The gate
// (`db._lastDayTick`) also dedupes concurrent requests (CAS reloads fresh state
// on retry, so only one advance lands per window). Returns true if it ticked.
const DAY_TICK_MS = 5000;
const DAY_TICK_MAX_STEPS = 12; // cap catch-up after a long idle gap
function maybeDayTick(db) {
  db = db || store.get();
  const now = Date.now();
  const interval = (db.settings && db.settings.economy && db.settings.economy.dayTickMs) || DAY_TICK_MS;
  const last = db._lastDayTick || 0;
  const elapsed = now - last;
  if (elapsed < interval) return false;
  const steps = Math.min(DAY_TICK_MAX_STEPS, Math.max(1, Math.floor(elapsed / interval)));
  let any = false;
  for (let i = 0; i < steps; i++) if (dayMarketTick(db)) any = true;
  db._lastDayTick = now;
  return any;
}

function heldTotal(co) {
  return (co.shareholders || []).reduce((s, r) => s + (r.shares || 0), 0);
}
function treasuryPool(co) {
  return Math.max(0, (co.sharesOutstanding || 0) - heldTotal(co));
}
function holdingOf(co, entityId) {
  const r = (co.shareholders || []).find(s => s.entityId === entityId);
  return r ? r.shares : 0;
}
// Shares held by ordinary investors (person entities other than the company's
// controller). This is what the public-float cap limits.
function personPublicHeld(co) {
  const db = store.get();
  return (co.shareholders || []).reduce((sum, r) => {
    if (r.entityId === co.ownerId || r.entityId === co.ceoId) return sum;
    const e = db.entities.find(x => x.id === r.entityId);
    return e && e.type === 'person' ? sum + (r.shares || 0) : sum;
  }, 0);
}
function maxPublic(co) {
  return Math.floor((co.publicFloat || 0) / 100 * (co.sharesOutstanding || 0));
}

// Set an entity's holding to an absolute share count, mirroring the change into
// the certificate item inventory. Register is canonical.
function setHolding(co, entityId, shares) {
  shares = Math.max(0, Math.round(shares));
  co.shareholders = co.shareholders || [];
  const rec = co.shareholders.find(s => s.entityId === entityId);
  if (shares <= 0) co.shareholders = co.shareholders.filter(s => s.entityId !== entityId);
  else if (rec) rec.shares = shares;
  else co.shareholders.push({ entityId, shares });

  const item = shareItemFor(co.id);
  if (!item) return;
  const holder = store.get().entities.find(e => e.id === entityId);
  if (!holder) return;
  holder.inventory = holder.inventory || [];
  const row = holder.inventory.find(r => r.itemId === item.id);
  if (shares <= 0) holder.inventory = holder.inventory.filter(r => r.itemId !== item.id);
  else if (row) row.qty = shares;
  else holder.inventory.push({ itemId: item.id, qty: shares });
}

// One-time (idempotent) reconciliation: make certificate items match the
// register exactly. Register wins. Returns true if anything changed. Run from
// store.migrate so live worlds converge without a reset.
function syncAllCertificates(world) {
  let changed = false;
  const companies = (world.entities || []).filter(e => e.type === 'company' && e.sharesOutstanding);
  for (const co of companies) {
    const item = (world.items || []).find(i => i.meta && i.meta.companyId === co.id);
    if (!item) continue;
    const registered = new Set((co.shareholders || []).map(s => s.entityId));
    // register → certificate: ensure each shareholder holds a matching cert
    for (const s of (co.shareholders || [])) {
      const holder = (world.entities || []).find(e => e.id === s.entityId);
      if (!holder) continue;
      holder.inventory = holder.inventory || [];
      const row = holder.inventory.find(r => r.itemId === item.id);
      if (!row) { holder.inventory.push({ itemId: item.id, qty: s.shares }); changed = true; }
      else if (row.qty !== s.shares) { row.qty = s.shares; changed = true; }
    }
    // certificate → register: a cert with no register entry is stale; drop it
    for (const holder of (world.entities || [])) {
      if (!holder.inventory) continue;
      const row = holder.inventory.find(r => r.itemId === item.id);
      if (row && !registered.has(holder.id)) {
        holder.inventory = holder.inventory.filter(r => r.itemId !== item.id);
        changed = true;
      }
    }
  }
  return changed;
}

function findCompany(companyId) {
  const co = store.get().entities.find(e => e.id === companyId);
  if (!co || co.type !== 'company') throw new Error('Unknown company');
  return co;
}

// Player buys `shares` from the float at the live day price; cash → the Bank.
function buy(companyId, buyerEntityId, shares, actor, opts) {
  const db = store.get();
  const co = findCompany(companyId);
  shares = Math.round(Number(shares));
  if (!(shares > 0)) throw new Error('Share count must be positive');
  if (treasuryPool(co) < shares) throw new Error('Not enough shares available in the float');
  const buyer = db.entities.find(e => e.id === buyerEntityId);
  if (!buyer) throw new Error('Unknown buyer');
  if (buyer.type === 'person' || (opts && opts.enforceFloat)) {
    if (personPublicHeld(co) + shares > maxPublic(co)) throw new Error('That would exceed the company’s public float');
  }
  // trades execute at the live Day-Market price
  const price = currentDayPrice(co);
  const cost = Math.round(price * shares * 100) / 100;
  const buyAcct = sim.primaryAccount(buyerEntityId, true);
  const bankAcct = bankAccount();
  const gm = opts && opts.gm;
  // VAT (Phase 12): a GM-set percentage of the purchase flows to the treasury.
  const tax = db.settings.taxation || {};
  const vat = tax.enabled && tax.vatRate > 0 ? Math.round(cost * tax.vatRate / 100) : 0;
  if (!gm && buyAcct.balance < cost + vat) throw new Error('Insufficient funds (incl. VAT)');
  // cash flows to the National Bank (market maker), never to the company
  sim.txn(buyAcct.id, bankAcct.id, cost, `Bought ${shares} ${co.abbrev || co.name} shares @ ${db.settings.currency}${price}`, actor, 'transfer');
  if (vat > 0) {
    const treasury = db.accounts.find(a => a.id === 'acct_treasury');
    if (treasury) sim.txn(buyAcct.id, treasury.id, vat, `VAT (${tax.vatRate}%) on share purchase`, 'TREASURY', 'transfer');
  }
  setHolding(co, buyerEntityId, holdingOf(co, buyerEntityId) + shares);
  applyDayImpact(co, +shares, price); // buying pressure nudges the day quote up
  store.log('market', `${buyer.name} bought ${shares} ${co.abbrev || co.name} shares`, `${db.settings.currency}${price} each${vat ? ' + VAT ' + db.settings.currency + vat : ''}`, actor, [co.id, buyerEntityId]);
  return { shares, cost, price, vat, dayPrice: co.dayPrice, sharePrice: co.sharePrice };
}

// Player sells `shares` back into the float; the National Bank pays out.
function sell(companyId, sellerEntityId, shares, actor, opts) {
  const db = store.get();
  const co = findCompany(companyId);
  shares = Math.round(Number(shares));
  if (!(shares > 0)) throw new Error('Share count must be positive');
  if (holdingOf(co, sellerEntityId) < shares) throw new Error('You do not hold that many shares');
  const price = currentDayPrice(co);
  const proceeds = Math.round(price * shares * 100) / 100;
  const bankAcct = bankAccount();
  const sellAcct = sim.primaryAccount(sellerEntityId, true);
  // The Bank is the market maker; it always absorbs a sale (it may run its
  // reserve negative — a visible consequence), so a player can always exit.
  sim.txn(bankAcct.id, sellAcct.id, proceeds, `Sold ${shares} ${co.abbrev || co.name} shares @ ${db.settings.currency}${price}`, actor, 'transfer');
  setHolding(co, sellerEntityId, holdingOf(co, sellerEntityId) - shares);
  applyDayImpact(co, -shares, price); // selling pressure nudges the day quote down
  const seller = db.entities.find(e => e.id === sellerEntityId);
  store.log('market', `${seller ? seller.name : sellerEntityId} sold ${shares} ${co.abbrev || co.name} shares`, `${db.settings.currency}${price} each`, actor, [co.id, sellerEntityId]);
  return { shares, proceeds, price, dayPrice: co.dayPrice, sharePrice: co.sharePrice };
}

// Private transfer of shares between holders (no cash) — like moving any item.
function transfer(companyId, fromEntityId, toEntityId, shares, actor) {
  const db = store.get();
  const co = findCompany(companyId);
  shares = Math.round(Number(shares));
  if (!(shares > 0)) throw new Error('Share count must be positive');
  if (fromEntityId === toEntityId) throw new Error('Cannot transfer to the same holder');
  if (holdingOf(co, fromEntityId) < shares) throw new Error('The sender does not hold that many shares');
  setHolding(co, fromEntityId, holdingOf(co, fromEntityId) - shares);
  setHolding(co, toEntityId, holdingOf(co, toEntityId) + shares);
  const nm = (id) => { const e = db.entities.find(x => x.id === id); return e ? e.name : id; };
  store.log('ownership', `${shares} ${co.abbrev || co.name} shares transferred`, `${nm(fromEntityId)} → ${nm(toEntityId)}`, actor, [co.id, fromEntityId, toEntityId]);
  return { shares };
}

// Offering — primary capital raise. The company SELLS new shares and is paid
// cash immediately, from the National Bank, which now holds the new float. Value
// (cash) came in, so the price stays ≈ flat: market cap rises by the cash raised.
// NOT dilution — but it DRAINS the bank until the float is bought up.
function offer(companyId, newShares, price, floatPct, actor) {
  const db = store.get();
  const co = findCompany(companyId);
  newShares = Math.round(Number(newShares));
  price = Math.round(Number(price) * 100) / 100;
  if (!(newShares > 0)) throw new Error('Offering size must be positive');
  if (!(price > 0)) throw new Error('Offering price must be positive');
  const newOutstanding = (co.sharesOutstanding || 0) + newShares;
  if (newOutstanding > Number.MAX_SAFE_INTEGER) throw new Error('Share count would overflow');
  const raised = Math.round(newShares * price * 100) / 100;

  co.sharesOutstanding = newOutstanding;
  const coAcct = sim.primaryAccount(co.id, true);
  // the Bank fronts the capital and holds the float; it recoups as players buy.
  sim.txn(bankAccount().id, coAcct.id, raised, `Share offering: ${newShares} new ${co.abbrev || co.name} shares @ ${db.settings.currency}${price}`, actor, 'transfer');
  co.vars = co.vars || {};
  co.vars.valuation = (co.vars.valuation || 0) + raised;
  if (floatPct !== undefined && floatPct !== null && !isNaN(Number(floatPct))) {
    co.publicFloat = Math.min(100, Math.max(0, Number(floatPct)));
  }
  // Fundamental VALUE stays flat (cash came in), but the DAY MARKET reacts to
  // the supply flood: dumping a lot of new float onto speculators marks the day
  // price down (and dents confidence). Flooding offerings now has a visible
  // consequence — a crash — on top of draining the Bank.
  applyDayImpact(co, -newShares, currentDayPrice(co));
  store.log('market', `${co.name} raised ${db.settings.currency}${raised.toLocaleString()}`,
    `Sold ${newShares} new shares @ ${db.settings.currency}${price} (funded by the Bank of Arcasia); outstanding now ${newOutstanding}`, actor, [co.id]);
  return { sharesOutstanding: co.sharesOutstanding, raised, price, sharePrice: co.sharePrice, dayPrice: co.dayPrice, publicFloat: co.publicFloat };
}

// Bonus mint — free new shares, NO cash. Market cap preserved, so both prices
// DILUTE proportionally.
function bonusMint(companyId, newShares, floatPct, actor) {
  const db = store.get();
  const co = findCompany(companyId);
  newShares = Math.round(Number(newShares));
  if (!(newShares > 0)) throw new Error('Bonus issue size must be positive');
  const oldOutstanding = co.sharesOutstanding || 0;
  const newOutstanding = oldOutstanding + newShares;
  if (newOutstanding > Number.MAX_SAFE_INTEGER) throw new Error('Share count would overflow');

  co.sharesOutstanding = newOutstanding;
  const ratio = oldOutstanding / newOutstanding;
  const oldPrice = co.sharePrice || 0.01;
  co.sharePrice = Math.max(0.01, Math.round(oldPrice * ratio * 100) / 100);
  if (co.dayPrice !== undefined) co.dayPrice = Math.max(0.01, round2(co.dayPrice * ratio));
  if (floatPct !== undefined && floatPct !== null && !isNaN(Number(floatPct))) {
    co.publicFloat = Math.min(100, Math.max(0, Number(floatPct)));
  }
  dayReanchor(co);
  const it = shareItemFor(co.id); if (it) it.marketValue = co.dayPrice === undefined ? co.sharePrice : co.dayPrice;
  store.log('market', `${co.name} issued ${newShares} bonus shares`,
    `Diluted: ${db.settings.currency}${oldPrice} → ${db.settings.currency}${co.sharePrice}; outstanding now ${newOutstanding}`, actor, [co.id]);
  return { sharesOutstanding: co.sharesOutstanding, sharePrice: co.sharePrice, dayPrice: co.dayPrice, publicFloat: co.publicFloat };
}

// Back-compat: the old issue() name now performs a bonus mint. /api/market/issue
// points here.
function issue(companyId, newShares, floatPct, actor) {
  return bonusMint(companyId, newShares, floatPct, actor);
}

// Buyback — the mirror of an offering. The company spends cash to pull shares
// out of the float and RETIRE them (sharesOutstanding drops), pushing the day
// price up. The cash goes to the Bank. Route enforces controller/GM.
function buyback(companyId, shares, actor, opts) {
  const db = store.get();
  const co = findCompany(companyId);
  shares = Math.round(Number(shares));
  if (!(shares > 0)) throw new Error('Buyback size must be positive');
  const float = treasuryPool(co);
  if (float <= 0) throw new Error('No shares in the float to buy back');
  if (shares > float) shares = float; // cap to the float (tender path is a future stretch)
  const price = currentDayPrice(co);
  const cost = Math.round(price * shares * 100) / 100;
  const coAcct = sim.primaryAccount(co.id, true);
  const gm = opts && opts.gm;
  if (!gm && coAcct.balance < cost) throw new Error('The company cannot fund that buyback');
  sim.txn(coAcct.id, bankAccount().id, cost, `Buyback: ${shares} ${co.abbrev || co.name} shares @ ${db.settings.currency}${price}`, actor, 'transfer');
  co.sharesOutstanding = Math.max(0, (co.sharesOutstanding || 0) - shares);
  co.vars = co.vars || {};
  co.vars.valuation = Math.max(0, (co.vars.valuation || 0) - cost);
  applyDayImpact(co, +shares, price); // retiring float pushes the day quote up
  store.log('market', `${co.name} bought back ${shares} shares`,
    `Spent ${db.settings.currency}${cost.toLocaleString()}; outstanding now ${co.sharesOutstanding}; ${db.settings.currency}${price} → ${db.settings.currency}${co.dayPrice}`, actor, [co.id]);
  return { shares, cost, price, sharesOutstanding: co.sharesOutstanding, dayPrice: co.dayPrice };
}

// P2P re-mark. When a share certificate changes hands for money through the
// trade-offer system, the implied price (money / shares) re-marks the DAY quote,
// clamped to ±25% of the current day price, then re-anchors. Big block trades.
function remarkFromTrade(companyId, money, shares, actor) {
  const co = store.get().entities.find(e => e.id === companyId);
  if (!co || co.type !== 'company') return;
  shares = Math.round(Number(shares));
  money = Number(money);
  if (!(shares > 0) || !(money > 0)) return;
  const implied = money / shares;
  const cur = currentDayPrice(co);
  const prev = co.dayPrice || cur;
  const target = softBand(co, clamp(implied, cur * (1 - MAX_TICK), cur * (1 + MAX_TICK)));
  co.dayPrice = Math.max(0.01, round2(target));
  nudgeConfidence(co, (co.dayPrice - prev) / (prev || 1));
  dayReanchor(co);
  const it = shareItemFor(co.id); if (it) it.marketValue = co.dayPrice;
  store.log('market', `${co.abbrev || co.name} re-marked by a block trade`,
    `Implied ${store.get().settings.currency}${round2(implied)} → day quote ${store.get().settings.currency}${co.dayPrice}`, actor, [co.id]);
}

module.exports = {
  shareItemFor, holdingOf, treasuryPool, personPublicHeld, maxPublic,
  setHolding, syncAllCertificates, buy, sell, transfer, issue,
  offer, bonusMint, buyback, remarkFromTrade,
  currentDayPrice, applyDayImpact, dayReanchor, dayMarketTick, maybeDayTick, recomputeEconConfidence, nudgeConfidence,
  BANK_ID, DEFAULT_DEPTH, DEFAULT_VOL
};
