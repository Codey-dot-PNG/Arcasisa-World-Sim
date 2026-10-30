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
  if (verdict === 'withdraw') {
    if (side !== o.side) throw new Error('Only the side that made an offer can withdraw it.');
    o.status = 'withdrawn';
  } else {
    if (side !== otherSide(o.side)) throw new Error('Only the other side can answer this offer.');
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

module.exports = { propose, revise, decide, accept, publicOffers, heldView, regionSides, describeTerms };
