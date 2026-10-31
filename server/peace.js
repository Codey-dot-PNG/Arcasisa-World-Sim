'use strict';
// Peace negotiations — the two sides of a war or a protest make, revise,
// accept, reject and withdraw offers of peace (db.peaceOffers). Generic: a
// "side" is a conflict doc's attacker ('att' — the invader, or the protest's
// organizer) or defender ('def'); who may speak for a side is decided by the
// route (api.js cmdAccessOf → negotiate), the GM for either.
//
// TERMS (all optional, validated against the world on every use):
//   reparations  { amount, payer:'att'|'def' } — money from one side's
//                entity to the other's, paid on acceptance
//   holdings     { mode:'keep'|'return'|'some', keep:[propId] } — what
//                becomes of the property the occupier holds (war.js
//                heldProperties: occupied ground in a war, seized districts
//                in a protest). Unmentioned → returned.
//   borders      { regions:[{kind:'province'|'country'|'new', id, shape,
//                labelPos?}], newState?:{name, fill} } — a redrawn map drawn
//                with the border painter's peace mode. Only the two sides'
//                own regions may move (the Republic's provinces for the
//                government; a side's map country). In a protest the
//                movement may carve out a NEW state ('new' — founded on
//                acceptance as a foreign entity + map country). A province
//                drawn down to nothing (shape '') is dissolved.
//   concede      (protest) the government accepts the movement's demands —
//                the same political payoff as the War Room's Concede
//   note         free text
//
// Accepting an offer applies it in one step: reparations, holdings, the
// conflict ends ("Peace agreed"), then the borders — validated BEFORE
// anything moves, so a deal that can't apply changes nothing.
//
// DEALS (multi-way conflicts — kind:'pact', from/to entity ids). Once a third
// power has intervened (doc.factions), ANY party may strike a deal with ANY
// other, whichever side either is on: an intervener with the movement it was
// sent to crush, two interveners with each other, the government with an
// intervener. A deal between the two principals is the peace offer above
// (it ends the conflict); every other deal binds only its two parties, and
// the conflict goes on. Terms (any mix, at least one):
//   peace     true — they stop fighting each other (both stances 'ally')
//   against   [entityId] — a joint war: both declare these parties enemies
//   reparations { amount, payer: entityId } — money from one to the other
//   goods     [{ itemId, qty, from: entityId }] — anything they hold
//             (weapons, fuel, food… — not deeds or share certificates)
//   ground    { from, to } — every cell one holds passes to the other (the
//             buildings on it follow); the defender's own soil is ceded by
//             a border clause instead
//   withdraw  entityId — that party (an intervener) leaves the conflict
//   borders   { regions } — redrawn map between the two parties' own lands
//             (the Republic's provinces if the government is one; each
//             party's map country); a region can't be erased mid-conflict
//   note      free text
const store = require('./store');
const sim = require('./sim');
const war = require('./war');
const territory = require('./territory');
const geometry = require('./geometry');

const MAX_REGIONS = 40;
const MAX_OFFERS = 120;

const docOf = (db, key) => (key === 'protest' ? db.protest : db.war);
const otherSide = (s) => (s === 'att' ? 'def' : 'att');
const isGov = (e) => !!e && (e.type === 'government' || e.id === 'ent_gov');

// A founded state's name label sized to its land (the default country label
// is drawn for a whole nation and would sprawl across a small breakaway).
function fitLabelSize(shape, text) {
  let w = 0;
  for (const pts of geometry.parseShape(shape)) {
    if (pts.length < 3) continue;
    const xs = pts.map(p => p[0]);
    w = Math.max(w, Math.max(...xs) - Math.min(...xs));
  }
  return Math.round(Math.max(16, Math.min(54, (w * 0.8) / Math.max(4, String(text).length))));
}

function sidesOf(db, key, doc) {
  const attId = key === 'protest' ? ((doc.protest || {}).organizerId || doc.attackerId) : doc.attackerId;
  const att = db.entities.find(e => e.id === attId) || null;
  const def = db.entities.find(e => e.id === doc.defenderId) || null;
  return { att, def };
}
// Which map regions each side may redraw: region key ('p:id' / 'c:id' /
// 'new') → owning side.
function regionSides(db, key, doc) {
  const { att, def } = sidesOf(db, key, doc);
  const out = {};
  const gov = isGov(def) ? 'def' : isGov(att) ? 'att' : null;
  if (gov) for (const p of db.provinces || []) out['p:' + p.id] = gov;
  for (const c of ((db.settings.map || {}).countries || [])) {
    if (att && c.entityId === att.id) out['c:' + c.id] = 'att';
    else if (def && c.entityId === def.id) out['c:' + c.id] = 'def';
  }
  if (key === 'protest') out.new = 'att';
  return out;
}

function cleanTerms(db, key, doc, raw) {
  raw = raw || {};
  const t = {};
  const { att } = sidesOf(db, key, doc);
  const rep = raw.reparations;
  if (rep && Number(rep.amount) > 0) {
    t.reparations = { amount: Math.min(1e13, Math.round(Number(rep.amount) * 100) / 100), payer: rep.payer === 'att' ? 'att' : 'def' };
  }
  const held = war.heldProperties(db, key);
  if (held.length) {
    const h = raw.holdings || {};
    const mode = ['keep', 'return', 'some'].includes(h.mode) ? h.mode : 'return';
    const ids = new Set(held.map(x => x.propId));
    t.holdings = { mode, keep: mode === 'some' ? [...new Set((Array.isArray(h.keep) ? h.keep : []).filter(id => ids.has(id)))] : [] };
  }
  const b = raw.borders;
  if (b && Array.isArray(b.regions) && b.regions.length) {
    if (b.regions.length > MAX_REGIONS) throw new Error('Too many regions in the border clause.');
    const owners = regionSides(db, key, doc);
    const seen = new Set();
    const regions = [];
    for (const r of b.regions) {
      if (!r || !['province', 'country', 'new'].includes(r.kind)) throw new Error('Malformed border clause.');
      const rk = r.kind === 'new' ? 'new' : (r.kind === 'province' ? 'p:' : 'c:') + r.id;
      if (!owners[rk]) throw new Error('The border clause may only redraw the two sides’ own territory.');
      if (seen.has(rk)) throw new Error('A region appears twice in the border clause.');
      seen.add(rk);
      const shape = typeof r.shape === 'string' ? r.shape : '';
      if (!territory.validShape(shape)) throw new Error('Malformed border in the clause.');
      if (r.kind === 'new' && !shape) continue; // an empty new state is no new state
      const out = { kind: r.kind, id: r.kind === 'new' ? 'new' : String(r.id), shape };
      if (Array.isArray(r.labelPos) && r.labelPos.length === 2 && r.labelPos.every(Number.isFinite)) out.labelPos = r.labelPos.map(v => Math.round(v));
      regions.push(out);
    }
    if (regions.length) {
      t.borders = { regions };
      if (regions.some(r => r.kind === 'new')) {
        const ns = b.newState || {};
        t.borders.newState = {
          name: String(ns.name || '').trim().slice(0, 60) || ((att ? att.name : 'The movement') + ' Free State'),
          fill: /^#[0-9a-f]{6}$/i.test(String(ns.fill || '')) ? ns.fill : ((att && /^#[0-9a-f]{6}$/i.test(att.color || '')) ? att.color : '#9a8a6a')
        };
      }
    }
  }
  if (key === 'protest' && raw.concede) t.concede = true;
  const note = String(raw.note || '').trim().slice(0, 800);
  if (note) t.note = note;
  if (!t.reparations && !t.holdings && !t.borders && !t.concede && !t.note) throw new Error('An offer needs at least one term (or a message).');
  return t;
}

// Plain-language clauses for the record, the wire and the clients.
function describeTerms(db, key, doc, t) {
  const { att, def } = sidesOf(db, key, doc);
  const nm = (s) => (s === 'att' ? (att ? att.name : 'the attacker') : (def ? def.name : 'the defender'));
  const out = [];
  if (t.reparations) out.push(`${nm(t.reparations.payer)} pays ${db.settings.currency || ''}${Number(t.reparations.amount).toLocaleString('en-US')} to ${nm(otherSide(t.reparations.payer))}`);
  if (t.holdings) {
    const n = war.heldProperties(db, key).length;
    out.push(t.holdings.mode === 'keep' ? `${nm('att')} keeps all ${n} held propert${n === 1 ? 'y' : 'ies'}`
      : t.holdings.mode === 'some' ? `${nm('att')} keeps ${t.holdings.keep.length} of ${n} held properties; the rest return`
        : `all held properties return to their owners`);
  }
  if (t.borders) {
    const names = t.borders.regions.map(r => r.kind === 'new' ? t.borders.newState.name + ' (new state)'
      : r.kind === 'province' ? ((db.provinces.find(p => p.id === r.id) || {}).name || r.id) + (r.shape ? '' : ' (dissolved)')
        : ((((db.settings.map || {}).countries || []).find(c => c.id === r.id) || {}).name || r.id));
    out.push('new borders for ' + names.join(', '));
  }
  if (t.concede) out.push(`the government concedes to ${nm('att')}'s demands`);
  return out;
}

// What a client sees: offers of the conflicts underway plus the latest few
// settled; shapes ship only while an offer is open (they're for review).
function publicOffers(db) {
  const live = new Set([db.war && db.war.active && 'war:' + db.war.startedAt, db.protest && db.protest.active && 'protest:' + db.protest.startedAt].filter(Boolean));
  const all = db.peaceOffers || [];
  const recent = all.filter(o => !live.has(o.conflict + ':' + o.talks)).slice(-6);
  return all.filter(o => live.has(o.conflict + ':' + o.talks)).concat(recent).map(o => {
    if (o.status === 'open' || !(o.terms && o.terms.borders)) return o;
    return { ...o, terms: { ...o.terms, borders: { ...o.terms.borders, regions: o.terms.borders.regions.map(r => ({ kind: r.kind, id: r.id, shape: r.shape ? '…' : '' })) } } };
  });
}
function heldView(db) {
  return {
    war: db.war && db.war.active ? war.heldProperties(db, 'war') : [],
    protest: db.protest && db.protest.active ? war.heldProperties(db, 'protest') : []
  };
}

function liveDoc(db, key) {
  const doc = docOf(db, key);
  if (!doc || !doc.active) throw new Error(key === 'protest' ? 'No protest is underway.' : 'No war is underway.');
  return doc;
}
function findOffer(db, id) {
  const o = (db.peaceOffers || []).find(x => x.id === id);
  if (!o) throw new Error('No such peace offer.');
  return o;
}

function propose(db, key, side, raw, actor) {
  key = key === 'protest' ? 'protest' : 'war';
  const doc = liveDoc(db, key);
  if (side !== 'att' && side !== 'def') throw new Error('Choose the side making the offer.');
  const terms = cleanTerms(db, key, doc, raw);
  db.peaceOffers = Array.isArray(db.peaceOffers) ? db.peaceOffers : [];
  for (const o of db.peaceOffers) {
    if (o.status === 'open' && o.conflict === key && o.talks === doc.startedAt && o.side === side) { o.status = 'superseded'; o.decidedAt = Date.now(); }
  }
  const sides = sidesOf(db, key, doc);
  const offer = {
    id: store.uid('peace'), conflict: key, talks: doc.startedAt, conflictName: doc.name || (key === 'protest' ? 'the protest' : 'the war'),
    side, byEntityId: sides[side] ? sides[side].id : null, toEntityId: sides[otherSide(side)] ? sides[otherSide(side)].id : null,
    by: actor, status: 'open', rev: 1, ts: Date.now(), updatedAt: Date.now(), terms
  };
  db.peaceOffers.push(offer);
  while (db.peaceOffers.length > MAX_OFFERS) db.peaceOffers.shift();
  store.log('politics', `Peace offer: ${nm(sides, side)} → ${nm(sides, otherSide(side))}`,
    describeTerms(db, key, doc, terms).join('; ') || 'A message', actor, [offer.byEntityId, offer.toEntityId].filter(Boolean));
  return offer;
}
function nm(sides, s) { return sides[s] ? sides[s].name : (s === 'att' ? 'the attacker' : 'the defender'); }

function revise(db, id, side, raw, actor) {
  const o = findOffer(db, id);
  if (o.status !== 'open') throw new Error('That offer is no longer on the table.');
  if (side !== o.side) throw new Error('Only the side that made an offer can revise it.');
  const doc = liveDoc(db, o.conflict);
  o.terms = cleanTerms(db, o.conflict, doc, raw);
  o.rev += 1;
  o.updatedAt = Date.now();
  o.by = actor;
  store.log('politics', 'Peace offer revised', describeTerms(db, o.conflict, doc, o.terms).join('; ') || 'A message', actor, [o.byEntityId, o.toEntityId].filter(Boolean));
  return o;
}

function decide(db, id, side, verdict, note, actor) {
  const o = findOffer(db, id);
  if (o.status !== 'open') throw new Error('That offer is no longer on the table.');
  // (a deal's `side` here is the party id speaking — the route checked it)
  const proposer = o.kind === 'pact' ? o.from : o.side, answerer = o.kind === 'pact' ? o.to : otherSide(o.side);
  if (verdict === 'withdraw') {
    if (side !== proposer) throw new Error('Only the party that made an offer can withdraw it.');
    o.status = 'withdrawn';
  } else {
    if (side !== answerer) throw new Error('Only the other party can answer this offer.');
    o.status = 'rejected';
    const r = String(note || '').trim().slice(0, 400);
    if (r) o.response = r;
  }
  o.decidedAt = Date.now(); o.decidedBy = actor;
  store.log('politics', `Peace offer ${o.status}`, o.response || '', actor, [o.byEntityId, o.toEntityId].filter(Boolean));
  return o;
}

function accept(db, id, side, rev, actor) {
  const o = findOffer(db, id);
  if (o.status !== 'open') throw new Error('That offer is no longer on the table.');
  if (side !== otherSide(o.side)) throw new Error('Only the other side can accept this offer.');
  if (Number(rev) !== o.rev) throw new Error('The terms changed while you were reading them — review the revised offer first.');
  const key = o.conflict;
  const doc = liveDoc(db, key);
  if (doc.startedAt !== o.talks) throw new Error('That offer belongs to an earlier conflict.');
  const terms = cleanTerms(db, key, doc, Object.assign({}, o.terms));
  const sides = sidesOf(db, key, doc);
  // ---- checks first: nothing moves unless the whole deal can apply ----
  let payFrom = null, payTo = null;
  if (terms.reparations) {
    const payer = sides[terms.reparations.payer], payee = sides[otherSide(terms.reparations.payer)];
    if (!payer || !payee) throw new Error('A party to the reparations no longer exists.');
    payFrom = sim.primaryAccount(payer.id, true);
    payTo = sim.primaryAccount(payee.id, true);
    if ((payFrom.balance || 0) < terms.reparations.amount) throw new Error(`${payer.name} cannot pay the reparations (${db.settings.currency || ''}${Math.floor(payFrom.balance || 0).toLocaleString('en-US')} available).`);
  }
  const regions = [], remove = [];
  let newRegion = null;
  if (terms.borders) {
    for (const r of terms.borders.regions) {
      if (r.kind === 'new') newRegion = r;
      else if (r.shape) regions.push({ kind: r.kind, id: r.id, shape: r.shape, labelPos: r.labelPos });
      else remove.push({ kind: r.kind, id: r.id });
    }
    const other = key === 'protest' ? db.war : db.protest;
    if (remove.some(r => r.kind === 'province') && ((other && other.active) || (db.election && db.election.active))) {
      throw new Error('This deal dissolves a province — it can only take effect once the other conflict and any election are over.');
    }
  }
  // ---- apply ----
  const summary = describeTerms(db, key, doc, terms);
  if (terms.reparations) sim.txn(payFrom.id, payTo.id, terms.reparations.amount, `Reparations under the peace of ${o.conflictName}`, actor, 'transfer');
  if (terms.holdings) war.settleHoldings(db, key, terms.holdings.mode === 'keep' ? 'all' : terms.holdings.mode === 'some' ? terms.holdings.keep : 'none');
  else war.settleHoldings(db, key, 'none');
  if (key === 'protest' && terms.concede) war.concludeProtest(db, 'concede', actor);
  else {
    doc.result = { winner: null, endedAt: new Date().toISOString(), reason: 'Peace agreed' };
    war.endWar(db, actor, 'Peace agreed', key, { quiet: true });
  }
  doc.result = Object.assign({}, doc.result, { peaceOfferId: o.id, terms: summary });
  if (newRegion) {
    const ns = terms.borders.newState;
    const made = territory.createCountry(db, { name: ns.name, fill: ns.fill, color: ns.fill, description: `Founded by the peace that ended ${o.conflictName}.` });
    regions.push({ kind: 'country', id: made.country.id, shape: newRegion.shape, labelPos: newRegion.labelPos });
    const lbl = ((db.settings.map || {}).labels || []).find(l => l.id === 'lbl_' + made.country.id);
    if (lbl) lbl.size = fitLabelSize(newRegion.shape, lbl.text);
  }
  if (regions.length || remove.length) territory.applyTerritory(db, { regions, remove });
  o.status = 'accepted'; o.decidedAt = Date.now(); o.decidedBy = actor; o.terms = terms;
  for (const x of db.peaceOffers) {
    if (x !== o && x.status === 'open' && x.conflict === key && x.talks === o.talks) { x.status = 'void'; x.decidedAt = Date.now(); }
  }
  store.log('event', `Peace agreed — ${o.conflictName}`, summary.join('; ') || 'The fighting stops.', actor, [o.byEntityId, o.toEntityId].filter(Boolean));
  war.SERVER_CTX.news(`PEACE AGREED: ${String(o.conflictName).toUpperCase()} IS OVER`,
    `${nm(sides, 'att')} and ${nm(sides, 'def')} have agreed terms of peace${summary.length ? ': ' + summary.join('; ') : ''}.${terms.note ? ' “' + terms.note + '”' : ''}`);
  return { offer: o, applied: summary };
}

// ---------- deals between any two parties (multi-way conflicts) ----------
const MAX_GOODS = 12;
function partyName(db, id) { return (db.entities.find(e => e.id === id) || {}).name || id; }
function isPrincipalPair(doc, a, b) {
  const attP = war.partiesOf(doc)[0], defP = doc.defenderId;
  return (a === attP && b === defP) || (a === defP && b === attP);
}
function partyOf(doc, id) { return war.partiesOf(doc).indexOf(id) >= 0; }
// region key → owning party, for a deal between `a` and `b`
function pactRegionOwners(db, doc, a, b) {
  const out = {};
  const gov = [a, b].find(id => id === doc.defenderId && isGov(db.entities.find(e => e.id === id)));
  if (gov) for (const p of db.provinces || []) out['p:' + p.id] = gov;
  for (const c of ((db.settings.map || {}).countries || [])) if (c.entityId === a || c.entityId === b) out['c:' + c.id] = c.entityId;
  return out;
}
function cleanPactTerms(db, key, doc, from, to, raw) {
  raw = raw || {};
  const pair = [from, to];
  const t = {};
  if (raw.peace) t.peace = true;
  if (Array.isArray(raw.against)) {
    const against = [...new Set(raw.against.filter(id => partyOf(doc, id) && pair.indexOf(id) < 0))];
    if (against.length) t.against = against;
  }
  const rep = raw.reparations;
  if (rep && Number(rep.amount) > 0) {
    if (pair.indexOf(rep.payer) < 0) throw new Error('One of the two parties pays the reparations.');
    t.reparations = { amount: Math.min(1e13, Math.round(Number(rep.amount) * 100) / 100), payer: rep.payer };
  }
  if (Array.isArray(raw.goods) && raw.goods.length) {
    if (raw.goods.length > MAX_GOODS) throw new Error(`At most ${MAX_GOODS} lines of goods in one deal.`);
    const goods = [];
    for (const g of raw.goods) {
      const item = db.items.find(i => i.id === (g && g.itemId));
      const qty = Math.floor(Number(g && g.qty));
      if (!item || !(qty > 0)) continue;
      if (pair.indexOf(g.from) < 0) throw new Error('Goods change hands between the two parties only.');
      if (item.meta && (item.meta.companyId || item.meta.propertyId)) throw new Error('Deeds and share certificates are ownership records — they change hands on the market, not in a deal.');
      goods.push({ itemId: item.id, qty, from: g.from });
    }
    if (goods.length) t.goods = goods;
  }
  if (raw.ground && raw.ground.from) {
    const g = raw.ground;
    if (pair.indexOf(g.from) < 0 || pair.indexOf(g.to) < 0 || g.from === g.to) throw new Error('Ground passes between the two parties only.');
    if (g.from === doc.defenderId) throw new Error(`${partyName(db, g.from)} cedes its own soil with a border clause, not a ground clause.`);
    t.ground = { from: g.from, to: g.to };
  }
  if (raw.withdraw) {
    if (pair.indexOf(raw.withdraw) < 0) throw new Error('Only one of the two parties can agree to withdraw.');
    const f = (doc.factions || {})[raw.withdraw];
    if (!f || f.principal) throw new Error(`${partyName(db, raw.withdraw)} is a principal side — it leaves at the peace table.`);
    t.withdraw = raw.withdraw;
  }
  const b = raw.borders;
  if (b && Array.isArray(b.regions) && b.regions.length) {
    if (b.regions.length > MAX_REGIONS) throw new Error('Too many regions in the border clause.');
    const owners = pactRegionOwners(db, doc, from, to);
    const seen = new Set();
    const regions = [];
    for (const r of b.regions) {
      if (!r || !['province', 'country'].includes(r.kind)) throw new Error('Malformed border clause.');
      const rk = (r.kind === 'province' ? 'p:' : 'c:') + r.id;
      if (!owners[rk]) throw new Error('A deal may only redraw the two parties’ own territory.');
      if (seen.has(rk)) throw new Error('A region appears twice in the border clause.');
      seen.add(rk);
      const shape = typeof r.shape === 'string' ? r.shape : '';
      if (!shape) throw new Error('A deal struck mid-conflict can move a border but not erase a region.');
      if (!territory.validShape(shape)) throw new Error('Malformed border in the clause.');
      const out = { kind: r.kind, id: String(r.id), shape };
      if (Array.isArray(r.labelPos) && r.labelPos.length === 2 && r.labelPos.every(Number.isFinite)) out.labelPos = r.labelPos.map(v => Math.round(v));
      regions.push(out);
    }
    if (regions.length) t.borders = { regions };
  }
  const note = String(raw.note || '').trim().slice(0, 800);
  if (note) t.note = note;
  if (!t.peace && !t.against && !t.reparations && !t.goods && !t.ground && !t.withdraw && !t.borders && !t.note) throw new Error('A deal needs at least one term (or a message).');
  return t;
}
function describePact(db, t, from, to) {
  const n = (id) => partyName(db, id);
  const other = (id) => (id === from ? to : from);
  const out = [];
  if (t.peace) out.push(`${n(from)} and ${n(to)} stop fighting each other`);
  if (t.against) out.push(`together against ${t.against.map(n).join(', ')}`);
  if (t.reparations) out.push(`${n(t.reparations.payer)} pays ${db.settings.currency || ''}${Number(t.reparations.amount).toLocaleString('en-US')} to ${n(other(t.reparations.payer))}`);
  for (const g of t.goods || []) out.push(`${n(g.from)} hands ${g.qty.toLocaleString('en-US')} × ${(db.items.find(i => i.id === g.itemId) || {}).name || g.itemId} to ${n(other(g.from))}`);
  if (t.ground) out.push(`${n(t.ground.from)} hands the ground it holds to ${n(t.ground.to)}`);
  if (t.withdraw) out.push(`${n(t.withdraw)} withdraws from the conflict`);
  if (t.borders) {
    const names = t.borders.regions.map(r => r.kind === 'province' ? ((db.provinces.find(p => p.id === r.id) || {}).name || r.id)
      : ((((db.settings.map || {}).countries || []).find(c => c.id === r.id) || {}).name || r.id));
    out.push('new borders for ' + names.join(', '));
  }
  return out;
}
function proposePact(db, key, from, to, raw, actor) {
  key = key === 'protest' ? 'protest' : 'war';
  const doc = liveDoc(db, key);
  if (!doc.factions) throw new Error('Deals between parties open once another power has entered the conflict.');
  if (!partyOf(doc, from) || !partyOf(doc, to) || from === to) throw new Error('Pick two parties to the conflict.');
  if (isPrincipalPair(doc, from, to)) throw new Error('The two sides make peace at the peace table.');
  const terms = cleanPactTerms(db, key, doc, from, to, raw);
  db.peaceOffers = Array.isArray(db.peaceOffers) ? db.peaceOffers : [];
  for (const o of db.peaceOffers) {
    if (o.status === 'open' && o.kind === 'pact' && o.conflict === key && o.talks === doc.startedAt && o.from === from && o.to === to) { o.status = 'superseded'; o.decidedAt = Date.now(); }
  }
  const offer = {
    id: store.uid('peace'), kind: 'pact', conflict: key, talks: doc.startedAt, conflictName: doc.name || (key === 'protest' ? 'the protest' : 'the war'),
    from, to, byEntityId: from, toEntityId: to, by: actor, status: 'open', rev: 1, ts: Date.now(), updatedAt: Date.now(), terms
  };
  db.peaceOffers.push(offer);
  while (db.peaceOffers.length > MAX_OFFERS) db.peaceOffers.shift();
  store.log('politics', `Deal offered: ${partyName(db, from)} → ${partyName(db, to)}`, describePact(db, terms, from, to).join('; ') || 'A message', actor, [from, to]);
  return offer;
}
function revisePact(db, o, raw, actor) {
  if (o.status !== 'open') throw new Error('That deal is no longer on the table.');
  const doc = liveDoc(db, o.conflict);
  o.terms = cleanPactTerms(db, o.conflict, doc, o.from, o.to, raw);
  o.rev += 1; o.updatedAt = Date.now(); o.by = actor;
  store.log('politics', 'Deal revised', describePact(db, o.terms, o.from, o.to).join('; ') || 'A message', actor, [o.from, o.to]);
  return o;
}
function acceptPact(db, o, rev, actor) {
  if (o.status !== 'open') throw new Error('That deal is no longer on the table.');
  if (Number(rev) !== o.rev) throw new Error('The terms changed while you were reading them — review the revised deal first.');
  const key = o.conflict;
  const doc = liveDoc(db, key);
  if (doc.startedAt !== o.talks) throw new Error('That deal belongs to an earlier conflict.');
  if (!partyOf(doc, o.from) || !partyOf(doc, o.to)) throw new Error('One of the parties has left the conflict.');
  const t = cleanPactTerms(db, key, doc, o.from, o.to, JSON.parse(JSON.stringify(o.terms)));
  const other = (id) => (id === o.from ? o.to : o.from);
  // ---- checks: nothing moves unless the whole deal can apply ----
  let payFrom = null, payTo = null;
  if (t.reparations) {
    payFrom = sim.primaryAccount(t.reparations.payer, true);
    payTo = sim.primaryAccount(other(t.reparations.payer), true);
    if (!payFrom || !payTo) throw new Error('A party to the payment has no account.');
    if ((payFrom.balance || 0) < t.reparations.amount) throw new Error(`${partyName(db, t.reparations.payer)} cannot pay (${db.settings.currency || ''}${Math.floor(payFrom.balance || 0).toLocaleString('en-US')} available).`);
  }
  const ents = {};
  for (const id of [o.from, o.to]) { ents[id] = db.entities.find(e => e.id === id); if (!ents[id]) throw new Error('A party no longer exists.'); }
  const need = {};
  for (const g of t.goods || []) { const k = g.from + '|' + g.itemId; need[k] = (need[k] || 0) + g.qty; }
  for (const k in need) {
    const [who, itemId] = k.split('|');
    const have = ((ents[who].inventory || []).find(r => r.itemId === itemId) || {}).qty || 0;
    if (have < need[k]) throw new Error(`${ents[who].name} holds only ${Math.floor(have).toLocaleString('en-US')} × ${(db.items.find(i => i.id === itemId) || {}).name || itemId}.`);
  }
  // ---- apply ----
  const summary = describePact(db, t, o.from, o.to);
  if (t.reparations) sim.txn(payFrom.id, payTo.id, t.reparations.amount, `Under a deal in ${o.conflictName}`, actor, 'transfer');
  for (const g of t.goods || []) {
    const giver = ents[g.from], taker = ents[other(g.from)];
    const row = giver.inventory.find(r => r.itemId === g.itemId);
    row.qty -= g.qty;
    giver.inventory = giver.inventory.filter(r => r.qty > 0);
    taker.inventory = taker.inventory || [];
    const trow = taker.inventory.find(r => r.itemId === g.itemId);
    if (trow) trow.qty += g.qty; else taker.inventory.push({ itemId: g.itemId, qty: g.qty });
    store.log('inventory', `${g.qty} × ${(db.items.find(i => i.id === g.itemId) || {}).name || g.itemId} handed over`, `${giver.name} → ${taker.name}, under a deal in ${o.conflictName}`, actor, [giver.id, taker.id, g.itemId]);
  }
  if (t.ground) war.handOverGround(db, doc, t.ground.from, t.ground.to);
  if (t.peace) { war.dealStance(doc, o.from, o.to, 'ally'); war.dealStance(doc, o.to, o.from, 'ally'); }
  for (const id of t.against || []) { war.dealStance(doc, o.from, id, 'enemy'); war.dealStance(doc, o.to, id, 'enemy'); }
  if (t.borders) territory.applyTerritory(db, { regions: t.borders.regions.map(r => ({ kind: r.kind, id: r.id, shape: r.shape, labelPos: r.labelPos })), remove: [] });
  o.status = 'accepted'; o.decidedAt = Date.now(); o.decidedBy = actor; o.terms = t;
  // anything else still open between these two is moot now
  for (const x of db.peaceOffers) {
    if (x !== o && x.status === 'open' && x.kind === 'pact' && x.conflict === key && x.talks === o.talks &&
      ((x.from === o.from && x.to === o.to) || (x.from === o.to && x.to === o.from))) { x.status = 'superseded'; x.decidedAt = Date.now(); }
  }
  if (t.withdraw) war.withdrawFaction(db, { conflict: key, entityId: t.withdraw }, actor);
  const a = partyName(db, o.from), b = partyName(db, o.to);
  store.log('event', `Deal struck — ${a} and ${b}`, summary.join('; ') || 'An understanding.', actor, [o.from, o.to]);
  war.SERVER_CTX.news(`${a.toUpperCase()} AND ${b.toUpperCase()} STRIKE A DEAL`,
    `In ${o.conflictName}, ${a} and ${b} have come to terms${summary.length ? ': ' + summary.join('; ') : ''}.${t.note ? ' “' + t.note + '”' : ''}`);
  return { offer: o, applied: summary };
}

module.exports = { propose, revise, decide, accept, publicOffers, heldView, regionSides, describeTerms,
  proposePact, revisePact, acceptPact, isPrincipalPair, pactRegionOwners, describePact };
