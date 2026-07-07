'use strict';
// Property deeds — property ownership as tradeable items. Every property has
// exactly one deed item (item.meta.propertyId) held (qty 1) by its owner
// entity, so properties can move through the same instant-trade and
// negotiated-offer flows as any other item. property.ownerId is the CANONICAL
// record; the deed item mirrors it. `transfer` is the single choke point that
// moves both together (mirroring how market.setHolding keeps share
// certificates in step with the shareholder register).
const store = require('./store');

function deedItemFor(propertyId) {
  return store.get().items.find(i => i.meta && i.meta.propertyId === propertyId) || null;
}

// Convey a property: move the deed item AND flip property.ownerId together.
// Called from the /api/trade and trade-accept item-move choke points.
function transfer(propertyId, fromEntityId, toEntityId, actor) {
  const db = store.get();
  const prop = db.properties.find(p => p.id === propertyId);
  if (!prop) throw new Error('Unknown property');
  const item = deedItemFor(propertyId);
  if (!item) throw new Error('No deed on file for that property');
  if (prop.ownerId !== fromEntityId) throw new Error('Only the property’s owner may convey its deed');
  const from = db.entities.find(e => e.id === fromEntityId);
  const to = db.entities.find(e => e.id === toEntityId);
  if (!from || !to) throw new Error('Unknown entity');
  from.inventory = (from.inventory || []).filter(r => r.itemId !== item.id);
  to.inventory = to.inventory || [];
  if (!to.inventory.some(r => r.itemId === item.id)) to.inventory.push({ itemId: item.id, qty: 1 });
  prop.ownerId = toEntityId;
  store.log('ownership', `${prop.name} conveyed`, `${from.name} → ${to.name}`, actor, [from.id, to.id, prop.id]);
}

// Idempotent reconciliation: ownerId is canonical. Creates missing deed
// items, retires deeds of deleted properties, keeps the deed's name/value in
// step with the property, and ensures exactly the owner holds it (qty 1).
// Run from store.migrate and after any GM property create/edit/delete.
function syncAllDeeds(world) {
  let changed = false;
  world.items = world.items || [];
  const props = world.properties || [];
  const propIds = new Set(props.map(p => p.id));

  // deeds whose property no longer exists — remove item + any holdings
  for (const it of world.items.filter(i => i.meta && i.meta.propertyId && !propIds.has(i.meta.propertyId))) {
    world.items = world.items.filter(x => x.id !== it.id);
    for (const e of (world.entities || [])) if (e.inventory) e.inventory = e.inventory.filter(r => r.itemId !== it.id);
    changed = true;
  }

  for (const prop of props) {
    let item = world.items.find(i => i.meta && i.meta.propertyId === prop.id);
    if (!item) {
      item = {
        id: 'item_deed_' + prop.id, name: 'Deed — ' + prop.name,
        description: 'Title deed to ' + prop.name + '. Whoever holds this deed owns the property.',
        icon: 'D', category: 'Deeds', marketValue: prop.value || 0, tradable: true,
        meta: { propertyId: prop.id }
      };
      world.items.push(item);
      changed = true;
    } else {
      const name = 'Deed — ' + prop.name;
      if (item.name !== name) { item.name = name; changed = true; }
      if (item.marketValue !== (prop.value || 0)) { item.marketValue = prop.value || 0; changed = true; }
    }
    for (const e of (world.entities || [])) {
      const row = (e.inventory || []).find(r => r.itemId === item.id);
      const should = prop.ownerId === e.id;
      if (row && !should) { e.inventory = e.inventory.filter(r => r.itemId !== item.id); changed = true; }
      else if (!row && should) { e.inventory = e.inventory || []; e.inventory.push({ itemId: item.id, qty: 1 }); changed = true; }
      else if (row && should && row.qty !== 1) { row.qty = 1; changed = true; }
    }
  }
  return changed;
}

module.exports = { deedItemFor, transfer, syncAllDeeds };
