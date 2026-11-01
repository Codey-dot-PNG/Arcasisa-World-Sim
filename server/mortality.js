'use strict';
/* Mortality — a player may end their character's life (the revolver on the
   world map, public/js/revolver.js). Generic: nothing here names a world.

   The cylinder is the SERVER's: the client says which chambers it loaded
   when it closes the gun; the server spins it (`user.revolver = { loaded,
   pos, at }`) and decides every pull. A pull on an empty chamber advances
   the cylinder; a pull on a loaded one kills the character:

   · the account's role becomes 'dead' (seeded by store.migrate — no pages,
     no powers; every mutating route refuses a dead account) and the change
     joins `user.roleHistory`;
   · the character's entity is marked `deceased = { at, turn, date }`. Its
     money, property and offices stay where they are — what becomes of them
     is the Game Master's to play out;
   · the record of the run — `user.obituary` — is written once, at death,
     from the world and the full logs (store.history), and shown to the
     player in place of the game from then on.

   A GM can bring an account back by giving it another role. */
const store = require('./store');
const ownership = require('./ownership');

const CHAMBERS = 6;

const clean = (loaded) => [...new Set((Array.isArray(loaded) ? loaded : []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < CHAMBERS))].sort();

function close(user, loaded) {
  user.revolver = { loaded: clean(loaded), pos: Math.floor(Math.random() * CHAMBERS), at: Date.now() };
  return { pos: user.revolver.pos, loaded: user.revolver.loaded };
}
function stow(user) { delete user.revolver; }

// One pull of the trigger. → { fired:false, pos } or { fired:true }
function pull(user) {
  const r = user.revolver;
  if (!r) throw new Error('The revolver is not loaded and closed.');
  const at = r.pos;
  if (r.loaded.includes(at)) return { fired: true, chamber: at };
  r.pos = (at + 1) % CHAMBERS;
  return { fired: false, chamber: at, pos: r.pos };
}

const money = (db, n) => (db.settings.currency || '') + Math.round(n).toLocaleString('en-US');
const fmt = (n) => Math.round(n).toLocaleString('en-US');

// What one entity is worth: cash, goods, property, shares at the day price.
function worth(db, ids) {
  const set = new Set(ids);
  const price = (it) => (it && (it.marketValue || 0)) || 0;
  const itemById = new Map((db.items || []).map(i => [i.id, i]));
  let cash = 0, goods = 0, property = 0, shares = 0;
  for (const a of db.accounts || []) if (set.has(a.ownerId)) cash += a.balance || 0;
  for (const e of db.entities || []) {
    if (!set.has(e.id)) continue;
    for (const r of e.inventory || []) {
      const it = itemById.get(r.itemId);
      if (!it || it.category === 'Securities' || it.category === 'Deeds' || (it.meta && (it.meta.companyId || it.meta.propertyId))) continue;
      goods += (r.qty || 0) * price(it);
    }
  }
  for (const p of db.properties || []) if (set.has(p.ownerId)) property += p.value || 0;
  for (const c of db.entities || []) {
    if (c.type !== 'company' || set.has(c.id)) continue;
    const px = c.dayPrice || c.sharePrice || 0;
    for (const h of c.shareholders || []) if (set.has(h.entityId)) shares += (h.shares || 0) * px;
  }
  return { cash, goods, property, shares, total: cash + goods + property + shares };
}

// The offices and posts held at death, in words.
function positions(db, eid) {
  const out = [];
  if (!eid) return out;
  const me = (db.entities || []).find(e => e.id === eid);
  if (me && me.title) out.push(me.title);
  for (const e of db.entities || []) {
    if (e.id === eid) continue;
    const titled = me && me.title && me.title.includes(e.name); // already said by their title
    if (e.ceoId === eid) { if (!titled) out.push((e.type === 'government' ? 'Head of ' : 'Chief executive of ') + e.name); }
    else if (e.ownerId === eid) out.push('Owner of ' + e.name);
    if (e.type === 'party' && e.leaderId === eid) out.push('Leader of ' + e.name);
    if (Array.isArray(e.executives) && e.executives.includes(eid) && e.ceoId !== eid) out.push('Executive of ' + e.name);
    if (e.sharesOutstanding && Array.isArray(e.shareholders)) {
      const held = e.shareholders.filter(h => h.entityId === eid).reduce((s, h) => s + (h.shares || 0), 0);
      if (held > e.sharesOutstanding / 2 && e.ownerId !== eid) out.push('Majority shareholder of ' + e.name);
    }
    for (const m of e.roster || []) if (m.userId === eid) out.push((m.title || 'Delegate') + ', ' + e.name);
  }
  return [...new Set(out)];
}

// The record of a run, written at the moment of death.
async function obituary(db, user) {
  const eid = user.entityId;
  const ent = (db.entities || []).find(e => e.id === eid) || null;
  const chain = eid ? [...ownership.controlledSet(eid)] : [];
  const ownAccts = (db.accounts || []).filter(a => a.ownerId === eid).map(a => a.id);
  const chainAccts = (db.accounts || []).filter(a => chain.includes(a.ownerId)).map(a => a.id);
  const roleName = (id) => ((db.roles || []).find(r => r.id === id) || {}).name || id;
  const t = db.settings.time || {};
  let hist = { timeline: [], transactions: [] };
  try { hist = await store.history({ actor: user.displayName, refs: chain, accounts: chainAccts }); } catch (e) { /* logs unavailable — the record uses what the world holds */ }
  const mine = hist.timeline.filter(e => e.actor === user.displayName);

  // actions, by kind
  const byType = {};
  for (const e of mine) byType[e.type] = (byType[e.type] || 0) + 1;
  const firstTurn = mine.length ? mine[0].turn : null;

  // money through their own hands
  let inflow = 0, outflow = 0, biggest = null;
  for (const x of hist.transactions) {
    const out = ownAccts.includes(x.from), inn = ownAccts.includes(x.to);
    if (out && !inn) outflow += x.amount;
    if (inn && !out) inflow += x.amount;
    if ((out || inn) && (!biggest || x.amount > biggest.amount)) biggest = x;
  }
  const w = worth(db, chain.length ? chain : [eid]);
  const own = worth(db, [eid]);
  // what the concerns they ran held (their own stake in them is in `own`)
  const held = worth(db, chain.filter(id => id !== eid));

  // deaths on their watch: accidents at their sites, and the fighting in
  // conflicts their side waged
  let accidentDeaths = 0;
  const accidents = [];
  for (const e of hist.timeline) {
    if (e.type !== 'accident' || !(e.refs || []).some(r => chain.includes(r))) continue;
    const m = /([\d,]+)\s+dead/.exec(e.detail || '');
    const n = m ? Number(m[1].replace(/,/g, '')) : 0;
    accidentDeaths += n;
    accidents.push({ title: e.title, deaths: n, turn: e.turn, date: e.simDate });
  }
  const conflicts = [];
  for (const doc of [db.war, db.protest]) {
    if (!doc || !doc.stats) continue;
    const att = [doc.attackerId, doc.protest && doc.protest.organizerId].filter(Boolean);
    const def = [doc.defenderId].filter(Boolean);
    const facs = Object.keys(doc.factions || {});
    const onAtt = att.some(id => chain.includes(id)), onDef = def.some(id => chain.includes(id));
    const onFac = facs.some(id => chain.includes(id));
    if (!onAtt && !onDef && !onFac) continue;
    const enemy = onAtt ? (doc.stats.defLosses || 0) : onDef ? (doc.stats.attLosses || 0) : 0;
    const own = onAtt ? (doc.stats.attLosses || 0) : onDef ? (doc.stats.defLosses || 0) : 0;
    conflicts.push({ name: doc.name || (doc.kind === 'protest' ? 'Protest' : 'War'), side: onAtt ? 'attacker' : onDef ? 'defender' : 'intervener',
      enemyKilled: Math.round(enemy), ownLost: Math.round(own), civilians: Math.round(doc.stats.civilianDeaths || 0), active: !!doc.active });
  }
  const combatDeaths = conflicts.reduce((s, c) => s + c.enemyKilled, 0);
  const civilianDeaths = conflicts.reduce((s, c) => s + c.civilians, 0);

  // what they held, traded and ran
  const companies = (db.entities || []).filter(e => e.type === 'company' && chain.includes(e.id) && e.id !== eid).map(e => e.name);
  const groups = (db.entities || []).filter(e => e.type !== 'company' && e.type !== 'person' && chain.includes(e.id)).map(e => e.name);
  const sites = (db.properties || []).filter(p => chain.includes(p.ownerId)).length;
  const trades = (db.trades || []).filter(x => chain.includes(x.fromEntityId) || chain.includes(x.toEntityId));
  const roles = (user.roleHistory || []).map(r => ({ role: roleName(r.roleId), at: r.at, turn: r.turn }));
  const pos = positions(db, eid);

  const record = {
    name: (ent && ent.name) || user.displayName, username: user.username, entityId: eid,
    title: ent && ent.title || null, color: ent && ent.color || null, logo: ent && ent.logo || null,
    role: roleName(user.roleId), roles,
    joinedAt: user.created || null, firstTurn,
    diedAt: Date.now(), diedTurn: t.turn, diedDate: t.date,
    positions: pos, companies, groups, sites,
    worth: w, ownWorth: own, controlledWorth: held,
    money: { inflow, outflow, transfers: hist.transactions.filter(x => ownAccts.includes(x.from) || ownAccts.includes(x.to)).length,
      biggest: biggest ? { amount: biggest.amount, memo: biggest.memo, turn: biggest.turn, out: ownAccts.includes(biggest.from) } : null },
    actions: { total: mine.length, byType, recent: mine.slice(-14).reverse().map(e => ({ title: e.title, detail: e.detail, turn: e.turn, date: e.simDate, type: e.type })) },
    trades: { total: trades.length, accepted: trades.filter(x => x.status === 'accepted').length },
    deaths: { total: accidentDeaths + combatDeaths, accidents: accidentDeaths, combat: combatDeaths, civilians: civilianDeaths, accidentList: accidents.slice(-8), conflicts }
  };
  record.summary = summarise(db, record);
  return record;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : d;
}
function summarise(db, r) {
  const bits = [];
  const who = r.name + (r.title ? ', ' + r.title : '');
  const span = r.firstTurn !== null && r.firstTurn !== undefined ? ` after ${Math.max(0, r.diedTurn - r.firstTurn)} turns in public life` : '';
  bits.push(`${who}, died by their own hand on ${longDate(r.diedDate) || 'turn ' + r.diedTurn}${span}.`);
  if (r.positions.length) bits.push(`At the end they held ${r.positions.length === 1 ? 'one post' : r.positions.length + ' posts'}: ${r.positions.slice(0, 4).join('; ')}${r.positions.length > 4 ? '; and more' : ''}.`);
  if (r.companies.length) bits.push(`They controlled ${r.companies.length === 1 ? r.companies[0] : r.companies.length + ' companies'}${r.sites ? ' and ' + r.sites + ' sites' : ''}.`);
  bits.push(`They leave ${money(db, r.ownWorth.total)} in their own name${r.controlledWorth.total > 0 ? ', and the concerns they ran hold ' + money(db, r.controlledWorth.total) : ''}.`);
  if (r.actions.total) bits.push(`The record holds ${fmt(r.actions.total)} acts of theirs${r.trades.total ? ' and ' + fmt(r.trades.total) + ' trade offers' : ''}.`);
  if (r.deaths.total) bits.push(`${fmt(r.deaths.total)} people died on their watch${r.deaths.accidents ? ' — ' + fmt(r.deaths.accidents) + ' of them in industrial accidents' : ''}${r.deaths.combat ? (r.deaths.accidents ? ', ' : ' — ') + fmt(r.deaths.combat) + ' in the fighting' : ''}.`);
  return bits.join(' ');
}

// The death itself. Mutates db (caller logs/saves/broadcasts).
async function die(db, user) {
  const t = db.settings.time || {};
  const record = await obituary(db, user);
  user.obituary = record;
  user.deadAt = record.diedAt;
  if (user.roleId !== 'dead') {
    user.roleHistory = Array.isArray(user.roleHistory) ? user.roleHistory : [];
    user.roleHistory.push({ roleId: 'dead', at: Date.now(), turn: t.turn });
    record.roles.push({ role: 'Dead', at: Date.now(), turn: t.turn });
  }
  user.roleId = 'dead';
  delete user.revolver;
  const ent = (db.entities || []).find(e => e.id === user.entityId);
  if (ent) ent.deceased = { at: Date.now(), turn: t.turn, date: t.date };
  return record;
}

module.exports = { CHAMBERS, close, stow, pull, die, obituary, worth, longDate };
