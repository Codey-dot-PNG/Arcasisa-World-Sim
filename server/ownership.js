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

module.exports = { controls, controlledSet, directlyControls };
