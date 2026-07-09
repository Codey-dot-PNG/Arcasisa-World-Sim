'use strict';
// Simplified stock market (Phase 4.4). The shareholder register
// (company.shareholders) is the CANONICAL ownership record; share-certificate
// items (item.meta.companyId) mirror it so shares can be traded like any other
// inventory item. `setHolding` is the single choke point that keeps the two in
// lockstep — every buy/sell/transfer/issue and any share-item trade flows
// through it.
//
// Model: sharesOutstanding is fixed except on issue. The "treasury pool" is the
// shares not yet allocated to any holder (outstanding − Σ register) — that is
// what the market maker sells from and buys back into, at company.sharePrice,
// with cash moving to/from the company's own account. Public float caps how
// many shares ordinary (person) investors may hold.
const store = require('./store');
const sim = require('./sim');
const pricepath = require('./pricepath'); // byte-identical with public/js/pricepath.js (client copy)

// The Exchange (Workstream A1) is the system counterparty for every SECONDARY
// (float) transaction — buy/sell/buyback cash flows through it, never back to
// the company. The company itself is only paid on a primary offering.
const EXCHANGE_ID = 'ent_exchange';
const DEFAULT_DEPTH = 5;   // price impact per unit of (qty / sharesOutstanding)
const MAX_TICK = 0.25;     // a single trade can move the quote at most ±25%
const DEFAULT_VOL = 0.02;  // intra-turn wiggle amplitude

function round2(n) { return Math.round(n * 100) / 100; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function newSeed() { return (Math.floor(Math.random() * 0x7fffffff) + 1) >>> 0; }

function exchangeAccount() { return sim.primaryAccount(EXCHANGE_ID, true); }

// Re-anchor the deterministic price path to the currently committed price with
// a fresh seed. Called after every commit (turn reprice, trade, offer, buyback,
// P2P re-mark) so the live ticker resumes wandering from the real number.
function reanchor(co) {
  co.priceAnchor = { price: co.sharePrice, t0: Date.now(), seed: newSeed() };
}

// The live quote right now: evaluate the seeded path at Date.now(). All trades
// execute at this price. Falls back to the committed sharePrice if no anchor
// has been set yet (older worlds before migration).
function currentPrice(co) {
  const base = co.sharePrice || 0.01;
  if (!co.priceAnchor) return round2(base);
  const a = co.priceAnchor;
  return pricepath.price(a.price, a.t0, a.seed, Date.now(), co.vol === undefined ? DEFAULT_VOL : co.vol, base);
}

// Live price impact (Workstream A4). signedQty: +buy pressure, −sell pressure.
// Moves the committed quote from the executed price and re-anchors the path.
function applyImpact(co, signedQty, execPrice) {
  const depth = co.marketDepth || DEFAULT_DEPTH;
  const frac = signedQty / Math.max(1, co.sharesOutstanding || 1);
  const next = execPrice * (1 + clamp(depth * frac, -MAX_TICK, MAX_TICK));
  co.sharePrice = Math.max(0.01, round2(next));
  reanchor(co);
  const it = shareItemFor(co.id);
  if (it) it.marketValue = co.sharePrice;
}

function shareItemFor(companyId) {
  return store.get().items.find(i => i.meta && i.meta.companyId === companyId) || null;
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

// Player buys `shares` from the float at sharePrice; cash → company account.
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
  // secondary trades execute at the live (wandered) price, not the flat quote
  const price = currentPrice(co);
  const cost = Math.round(price * shares * 100) / 100;
  const buyAcct = sim.primaryAccount(buyerEntityId, true);
  const exAcct = exchangeAccount();
  const gm = opts && opts.gm;
  // VAT (Phase 12): a GM-set percentage of the purchase flows to the treasury
  // on top of the price paid for the float.
  const tax = db.settings.taxation || {};
  const vat = tax.enabled && tax.vatRate > 0 ? Math.round(cost * tax.vatRate / 100) : 0;
  if (!gm && buyAcct.balance < cost + vat) throw new Error('Insufficient funds (incl. VAT)');
  // cash flows to the Exchange (the float's counterparty), never to the company
  sim.txn(buyAcct.id, exAcct.id, cost, `Bought ${shares} ${co.abbrev || co.name} shares @ ${db.settings.currency}${price}`, actor, 'transfer');
  if (vat > 0) {
    const treasury = db.accounts.find(a => a.id === 'acct_treasury');
    if (treasury) sim.txn(buyAcct.id, treasury.id, vat, `VAT (${tax.vatRate}%) on share purchase`, 'TREASURY', 'transfer');
  }
  setHolding(co, buyerEntityId, holdingOf(co, buyerEntityId) + shares);
  applyImpact(co, +shares, price); // buying pressure nudges the quote up
  store.log('market', `${buyer.name} bought ${shares} ${co.abbrev || co.name} shares`, `${db.settings.currency}${price} each${vat ? ' + VAT ' + db.settings.currency + vat : ''}`, actor, [co.id, buyerEntityId]);
  return { shares, cost, price, vat, sharePrice: co.sharePrice };
}

// Player sells `shares` back into the float; the Exchange pays out.
function sell(companyId, sellerEntityId, shares, actor, opts) {
  const db = store.get();
  const co = findCompany(companyId);
  shares = Math.round(Number(shares));
  if (!(shares > 0)) throw new Error('Share count must be positive');
  if (holdingOf(co, sellerEntityId) < shares) throw new Error('You do not hold that many shares');
  const price = currentPrice(co);
  const proceeds = Math.round(price * shares * 100) / 100;
  const exAcct = exchangeAccount();
  const sellAcct = sim.primaryAccount(sellerEntityId, true);
  // The Exchange is the market maker for the float; it always absorbs a sale
  // (system holder — allowed to run its book negative), so a player can always
  // exit a position.
  sim.txn(exAcct.id, sellAcct.id, proceeds, `Sold ${shares} ${co.abbrev || co.name} shares @ ${db.settings.currency}${price}`, actor, 'transfer');
  setHolding(co, sellerEntityId, holdingOf(co, sellerEntityId) - shares);
  applyImpact(co, -shares, price); // selling pressure nudges the quote down
  const seller = db.entities.find(e => e.id === sellerEntityId);
  store.log('market', `${seller ? seller.name : sellerEntityId} sold ${shares} ${co.abbrev || co.name} shares`, `${db.settings.currency}${price} each`, actor, [co.id, sellerEntityId]);
  return { shares, proceeds, price, sharePrice: co.sharePrice };
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

// Offering (Workstream A2) — primary capital raise. The company SELLS new
// shares and is paid cash immediately; those shares land in the Exchange-held
// float. Because value (cash) came in, the price stays ≈ flat: market cap rises
// by exactly the cash raised. This is NOT dilution.
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
  // pay the company immediately, from the Exchange (books balance; the Exchange
  // now holds the float it just "sold" on the company's behalf).
  const coAcct = sim.primaryAccount(co.id, true);
  sim.txn(exchangeAccount().id, coAcct.id, raised, `Share offering: ${newShares} new ${co.abbrev || co.name} shares @ ${db.settings.currency}${price}`, actor, 'transfer');
  // new shares sit in the float (outstanding − Σ register) automatically, held
  // by the Exchange. Market cap rises by the cash raised → price flat.
  co.vars = co.vars || {};
  co.vars.valuation = (co.vars.valuation || 0) + raised;
  if (floatPct !== undefined && floatPct !== null && !isNaN(Number(floatPct))) {
    co.publicFloat = Math.min(100, Math.max(0, Number(floatPct)));
  }
  reanchor(co); // price unchanged, but re-seed the live path off the new state
  const it = shareItemFor(co.id); if (it) it.marketValue = co.sharePrice;
  store.log('market', `${co.name} raised ${db.settings.currency}${raised.toLocaleString()}`,
    `Sold ${newShares} new shares @ ${db.settings.currency}${price}; outstanding now ${newOutstanding}`, actor, [co.id]);
  return { sharesOutstanding: co.sharesOutstanding, raised, price, sharePrice: co.sharePrice, publicFloat: co.publicFloat };
}

// Bonus mint (Workstream A2) — free new shares, NO cash. Market cap is
// preserved, so spreading it over more shares DILUTES the price. This is the
// corrected form of the old broken issue() (which minted shares and left the
// price frozen).
function bonusMint(companyId, newShares, floatPct, actor) {
  const db = store.get();
  const co = findCompany(companyId);
  newShares = Math.round(Number(newShares));
  if (!(newShares > 0)) throw new Error('Bonus issue size must be positive');
  const oldOutstanding = co.sharesOutstanding || 0;
  const newOutstanding = oldOutstanding + newShares;
  if (newOutstanding > Number.MAX_SAFE_INTEGER) throw new Error('Share count would overflow');

  co.sharesOutstanding = newOutstanding;
  // preserve market cap (price × outstanding) → dilute the per-share price
  const oldPrice = co.sharePrice || 0.01;
  co.sharePrice = Math.max(0.01, Math.round(oldPrice * oldOutstanding / newOutstanding * 100) / 100);
  if (floatPct !== undefined && floatPct !== null && !isNaN(Number(floatPct))) {
    co.publicFloat = Math.min(100, Math.max(0, Number(floatPct)));
  }
  reanchor(co);
  const it = shareItemFor(co.id); if (it) it.marketValue = co.sharePrice;
  store.log('market', `${co.name} issued ${newShares} bonus shares`,
    `Diluted: ${db.settings.currency}${oldPrice} → ${db.settings.currency}${co.sharePrice}; outstanding now ${newOutstanding}`, actor, [co.id]);
  return { sharesOutstanding: co.sharesOutstanding, sharePrice: co.sharePrice, publicFloat: co.publicFloat };
}

// Back-compat: the old issue() name now performs a bonus mint (the corrected
// dilution behaviour). The /api/market/issue route points here.
function issue(companyId, newShares, floatPct, actor) {
  return bonusMint(companyId, newShares, floatPct, actor);
}

// Buyback (Workstream A3) — the mirror of an offering. The company spends cash
// to pull shares out of the Exchange float and RETIRE them (sharesOutstanding
// drops), pushing the price up. Route enforces controller/GM.
function buyback(companyId, shares, actor, opts) {
  const db = store.get();
  const co = findCompany(companyId);
  shares = Math.round(Number(shares));
  if (!(shares > 0)) throw new Error('Buyback size must be positive');
  const float = treasuryPool(co);
  if (float <= 0) throw new Error('No shares in the float to buy back');
  // cap to the available float (the tender path — buying from holders at a
  // premium — is left as a future opts.tender stretch).
  if (shares > float) shares = float;
  const price = currentPrice(co);
  const cost = Math.round(price * shares * 100) / 100;
  const coAcct = sim.primaryAccount(co.id, true);
  const gm = opts && opts.gm;
  if (!gm && coAcct.balance < cost) throw new Error('The company cannot fund that buyback');
  // pay the Exchange, then retire the shares
  sim.txn(coAcct.id, exchangeAccount().id, cost, `Buyback: ${shares} ${co.abbrev || co.name} shares @ ${db.settings.currency}${price}`, actor, 'transfer');
  co.sharesOutstanding = Math.max(0, (co.sharesOutstanding || 0) - shares);
  co.vars = co.vars || {};
  co.vars.valuation = Math.max(0, (co.vars.valuation || 0) - cost); // cash left the business
  applyImpact(co, +shares, price); // retiring float pushes the quote up
  store.log('market', `${co.name} bought back ${shares} shares`,
    `Spent ${db.settings.currency}${cost.toLocaleString()}; outstanding now ${co.sharesOutstanding}; ${db.settings.currency}${price} → ${db.settings.currency}${co.sharePrice}`, actor, [co.id]);
  return { shares, cost, price, sharesOutstanding: co.sharesOutstanding, sharePrice: co.sharePrice };
}

// P2P re-mark (Workstream A5). When a share certificate changes hands for money
// through the trade-offer system, the implied price (money / shares) re-marks
// the quote, clamped to ±25% of the current price, then re-anchors. This is
// where the big, headline moves come from.
function remarkFromTrade(companyId, money, shares, actor) {
  const co = store.get().entities.find(e => e.id === companyId);
  if (!co || co.type !== 'company') return;
  shares = Math.round(Number(shares));
  money = Number(money);
  if (!(shares > 0) || !(money > 0)) return;
  const implied = money / shares;
  const cur = currentPrice(co);
  const target = clamp(implied, cur * (1 - MAX_TICK), cur * (1 + MAX_TICK));
  co.sharePrice = Math.max(0.01, round2(target));
  reanchor(co);
  const it = shareItemFor(co.id); if (it) it.marketValue = co.sharePrice;
  store.log('market', `${co.abbrev || co.name} re-marked by a block trade`,
    `Implied ${store.get().settings.currency}${round2(implied)} → quote ${store.get().settings.currency}${co.sharePrice}`, actor, [co.id]);
}

module.exports = {
  shareItemFor, holdingOf, treasuryPool, personPublicHeld, maxPublic,
  setHolding, syncAllCertificates, buy, sell, transfer, issue,
  offer, bonusMint, buyback, remarkFromTrade,
  currentPrice, applyImpact, reanchor, EXCHANGE_ID,
  DEFAULT_DEPTH, DEFAULT_VOL
};
