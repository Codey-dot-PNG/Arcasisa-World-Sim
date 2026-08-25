'use strict';
// Ownership-chain resolution — the single source of truth for "who ultimately
// controls whom". Used by transfers, filterState visibility (accounts,
// inventories, timeline) and any permission that turns on control rather than
// direct ownership.
//
// A controller reaches an entity through any of these one-hop links:
//   · entity.ownerId  — direct owner
//   · entity.ceoId    — the CEO controls the company (and the head of the
//                        government controls the government)
//   · party.leaderId  — a party's leader controls the party
//   · majority shares  — >50% of sharesOutstanding via the shareholder register
// Chains compose: President → Government → ARC → … Depth is capped and a
// visited set makes cycles harmless.
//
// Phase 35 — roster grants: entity.roster[].grants.scopes lets an owner
// delegate specific capabilities (property_controls, trade, campaign_minor,
// command_units, …) without full ownership-chain control. canAct() checks
// the chain first, then falls back to roster grants. Over-cap requests
// flow through entity.pendingRequests for owner approval.
const store = require('./store');

const MAX_DEPTH = 6;

// Does `controllerId` directly control `entity` in a single hop?
function directlyControls(controllerId, entity) {
  if (!entity || !controllerId) return false;
  if (entity.ownerId && entity.ownerId === controllerId) return true;
  if (entity.ceoId && entity.ceoId === controllerId) return true;
  if (entity.type === 'party' && entity.leaderId === controllerId) return true;
  // Government-type entities: the president(s) sitting in `executives` control
  // it (mirrors ceoId but supports co-presidencies). Scoped to type
  // 'government' so a company's `executives` array keeps its non-controlling
  // meaning elsewhere.
  if (entity.type === 'government' && Array.isArray(entity.executives) && entity.executives.includes(controllerId)) return true;
  if (entity.sharesOutstanding && Array.isArray(entity.shareholders)) {
    const held = entity.shareholders
      .filter(s => s.entityId === controllerId)
      .reduce((sum, s) => sum + (s.shares || 0), 0);
    if (held > entity.sharesOutstanding / 2) return true;
  }
  return false;
}

// The set of entity ids `rootEntityId` controls, directly or transitively.
// Always includes the root itself. Cycle-safe (visited set) and depth-capped.
function controlledSet(rootEntityId) {
  const set = new Set();
  if (!rootEntityId) return set;
  const db = store.get();
  set.add(rootEntityId);
  let frontier = [rootEntityId];
  let depth = 0;
  while (frontier.length && depth < MAX_DEPTH) {
    const next = [];
    for (const controllerId of frontier) {
      for (const e of db.entities) {
        if (set.has(e.id)) continue;
        if (directlyControls(controllerId, e)) { set.add(e.id); next.push(e.id); }
      }
    }
    frontier = next;
    depth++;
  }
  return set;
}

// Convenience boolean wrapper.
function controls(rootEntityId, targetEntityId) {
  if (!rootEntityId || !targetEntityId) return false;
  if (rootEntityId === targetEntityId) return true;
  return controlledSet(rootEntityId).has(targetEntityId);
}

// ---- Phase 35 — roster grant resolution ----

// Find a live (non-expired) roster entry for `userId` on `entity`.
function findGrant(entity, userId) {
  if (!entity || !userId || !Array.isArray(entity.roster)) return null;
  const now = Date.now();
  return entity.roster.find(r =>
    r.userId === userId && (!r.expiresAt || r.expiresAt > now)
  ) || null;
}

// Check if a roster grant covers a given scope. The grant's scopes array
// contains strings like 'property_controls', 'trade', 'campaign_minor',
// 'command_units', 'all'. 'all' matches everything.
function grantCoversScope(grant, scope) {
  if (!grant || !grant.grants || !Array.isArray(grant.grants.scopes)) return false;
  if (grant.grants.scopes.includes('all')) return true;
  return grant.grants.scopes.includes(scope);
}

// Check if a roster grant covers a spend amount. Returns true if there is
// no cap or the amount is within the cap.
function grantCoversAmount(grant, amount) {
  if (!grant || !grant.grants) return true; // no grants obj = unlimited
  const limit = grant.grants.spendLimitPerTurn;
  if (limit === null || limit === undefined) return true; // null = unlimited
  if (!(amount > 0)) return true; // zero/negative spend is always allowed
  return amount <= Number(limit);
}

// Check if a roster grant covers a specific property.
function grantCoversProperty(grant, propertyId) {
  if (!grant || !grant.grants || !Array.isArray(grant.grants.properties)) return true;
  if (!grant.grants.properties.length) return true; // empty = all properties
  return grant.grants.properties.includes(propertyId);
}

// Check if a roster grant covers a specific account.
function grantCoversAccount(grant, accountId) {
  if (!grant || !grant.grants || !Array.isArray(grant.grants.accounts)) return true;
  if (!grant.grants.accounts.length) return true; // empty = all accounts
  return grant.grants.accounts.includes(accountId);
}

// Check if a roster grant covers a specific war unit (by prefix filter).
function grantCoversUnit(grant, unitId) {
  if (!grant || !grant.grants || !grant.grants.unitFilter) return true;
  if (!grant.grants.unitFilter) return true;
  return String(unitId).startsWith(grant.grants.unitFilter);
}

// ---- Phase 35 — canAct (the core authorization function) ----
//
// Returns true if `userId` may perform `scope` on `entity`, optionally
// constrained by `opts` (amount, propertyId, accountId, unitId).
//
// Check order:
// 1. Ownership chain (controlledSet) — full access, no caps
// 2. Roster grant — scope must match, amount/property/account/unit filters apply
// 3. If amount exceeds spendLimitPerTurn, the caller should create a
//    pendingRequest instead of 403-ing (see api.js)
//
// `opts` shape: { amount, propertyId, accountId, unitId, corpsTag }
function canAct(db, userId, entityId, scope, opts) {
  if (!userId || !entityId || !scope) return false;
  db = db || store.get();
  const entity = db.entities.find(e => e.id === entityId);
  if (!entity) return false;

  // 1. Ownership chain — always allowed, no caps
  if (controls(userId, entityId)) return true;

  // 2. Roster grant
  const grant = findGrant(entity, userId);
  if (!grant) return false;
  if (!grantCoversScope(grant, scope)) return false;

  // Property-scoped checks
  if (opts && opts.propertyId && !grantCoversProperty(grant, opts.propertyId)) return false;

  // Account-scoped checks
  if (opts && opts.accountId && !grantCoversAccount(grant, opts.accountId)) return false;

  // Unit-scoped checks (war commands)
  if (opts && opts.unitId && !grantCoversUnit(grant, opts.unitId)) return false;

  // Amount check — if amount exceeds the cap, the route should create a
  // pendingRequest rather than rejecting. canAct still returns false here
  // so the route knows to redirect to the approval queue.
  if (opts && opts.amount !== undefined && opts.amount > 0) {
    if (!grantCoversAmount(grant, opts.amount)) return false;
  }

  return true;
}

// ---- Phase 35 — pending requests (approval queue) ----

// Create a pending request. Returns the request object.
function createRequest(db, entityId, userId, scope, opts) {
  db = db || store.get();
  const entity = db.entities.find(e => e.id === entityId);
  if (!entity) return null;
  entity.pendingRequests = Array.isArray(entity.pendingRequests) ? entity.pendingRequests : [];
  const req = {
    id: store.uid('req'),
    userId,
    scope,
    amount: opts && opts.amount ? Number(opts.amount) : 0,
    propertyId: opts && opts.propertyId || null,
    accountId: opts && opts.accountId || null,
    unitId: opts && opts.unitId || null,
    description: opts && opts.description || '',
    createdAt: Date.now(),
    status: 'pending'
  };
  entity.pendingRequests.push(req);
  return req;
}

// Find a pending request by id.
function findRequest(entity, reqId) {
  if (!entity || !Array.isArray(entity.pendingRequests)) return null;
  return entity.pendingRequests.find(r => r.id === reqId && r.status === 'pending') || null;
}

// Approve a pending request — returns { ok, req } or { ok: false, error }.
function approveRequest(db, entity, req, approverId) {
  if (!req || req.status !== 'pending') return { ok: false, error: 'Request not found or already processed.' };
  req.status = 'approved';
  req.approvedBy = approverId;
  req.approvedAt = Date.now();
  return { ok: true, req };
}

// Deny a pending request.
function denyRequest(db, entity, req, denierId) {
  if (!req || req.status !== 'pending') return { ok: false, error: 'Request not found or already processed.' };
  req.status = 'denied';
  req.deniedBy = denierId;
  req.deniedAt = Date.now();
  return { ok: true, req };
}

// Clean up expired requests (call during migration or periodically).
function cleanExpiredRequests(entity) {
  if (!entity || !Array.isArray(entity.pendingRequests)) return;
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
  entity.pendingRequests = entity.pendingRequests.filter(r =>
    r.status === 'pending' ? r.createdAt > cutoff : true
  );
}

// Backward-compatible wrapper: maps old permission names to canAct scopes.
function hasPermission(userId, targetEntityId, perm) {
  const scopeMap = { manage: 'property_controls', trade: 'trade', hire: 'property_controls', finance: 'trade', all: 'company_controls' };
  const scope = scopeMap[perm] || perm;
  return canAct(store.get(), userId, targetEntityId, scope);
}

module.exports = {
  controls, controlledSet, directlyControls, hasPermission,
  findGrant, grantCoversScope, grantCoversAmount, grantCoversProperty,
  grantCoversAccount, grantCoversUnit,
  canAct, createRequest, findRequest, approveRequest, denyRequest, cleanExpiredRequests
};
