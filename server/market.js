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
  const price = co.sharePrice || 0;
  const cost = Math.round(price * shares * 100) / 100;
  const buyAcct = sim.primaryAccount(buyerEntityId, true);
  const coAcct = sim.primaryAccount(co.id, true);
  const gm = opts && opts.gm;
  if (!gm && buyAcct.balance < cost) throw new Error('Insufficient funds');
  sim.txn(buyAcct.id, coAcct.id, cost, `Bought ${shares} ${co.abbrev || co.name} shares @ ${db.settings.currency}${price}`, actor, 'transfer');
  setHolding(co, buyerEntityId, holdingOf(co, buyerEntityId) + shares);
  store.log('market', `${buyer.name} bought ${shares} ${co.abbrev || co.name} shares`, `${db.settings.currency}${price} each`, actor, [co.id, buyerEntityId]);
  return { shares, cost, price };
}

// Player sells `shares` back into the float; company account pays out.
function sell(companyId, sellerEntityId, shares, actor, opts) {
  const db = store.get();
  const co = findCompany(companyId);
  shares = Math.round(Number(shares));
  if (!(shares > 0)) throw new Error('Share count must be positive');
  if (holdingOf(co, sellerEntityId) < shares) throw new Error('You do not hold that many shares');
  const price = co.sharePrice || 0;
  const proceeds = Math.round(price * shares * 100) / 100;
  const coAcct = sim.primaryAccount(co.id, true);
  const sellAcct = sim.primaryAccount(sellerEntityId, true);
  if (coAcct.balance < proceeds) throw new Error('The company cannot cover the buy-back');
  sim.txn(coAcct.id, sellAcct.id, proceeds, `Sold ${shares} ${co.abbrev || co.name} shares @ ${db.settings.currency}${price}`, actor, 'transfer');
  setHolding(co, sellerEntityId, holdingOf(co, sellerEntityId) - shares);
  const seller = db.entities.find(e => e.id === sellerEntityId);
  store.log('market', `${seller ? seller.name : sellerEntityId} sold ${shares} ${co.abbrev || co.name} shares`, `${db.settings.currency}${price} each`, actor, [co.id, sellerEntityId]);
  return { shares, proceeds, price };
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

// Company issues new shares into its own treasury pool and (re)sets its float.
function issue(companyId, newShares, floatPct, actor) {
  const db = store.get();
  const co = findCompany(companyId);
  newShares = Math.round(Number(newShares));
  if (!(newShares > 0)) throw new Error('Issue count must be positive');
  co.sharesOutstanding = (co.sharesOutstanding || 0) + newShares;
  if (floatPct !== undefined && floatPct !== null && !isNaN(Number(floatPct))) {
    co.publicFloat = Math.min(100, Math.max(0, Number(floatPct)));
  }
  // new shares sit in the treasury pool (outstanding − Σ register) automatically
  store.log('market', `${co.name} issued ${newShares} new shares`, `Outstanding now ${newShares + (co.sharesOutstanding - newShares)}; public float ${co.publicFloat}%`, actor, [co.id]);
  return { sharesOutstanding: co.sharesOutstanding, publicFloat: co.publicFloat };
}

module.exports = {
  shareItemFor, holdingOf, treasuryPool, personPublicHeld, maxPublic,
  setHolding, syncAllCertificates, buy, sell, transfer, issue
};
