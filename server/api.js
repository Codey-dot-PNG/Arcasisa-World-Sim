'use strict';
const crypto = require('crypto');
const zlib = require('zlib');
const store = require('./store');
const sim = require('./sim');
const ownership = require('./ownership');
const market = require('./market');
const deeds = require('./deeds');
const buildings = require('./buildings');
const casino = require('./casino');
const geometry = require('./geometry');
const sb = require('./supabase');
const { seed, hashPassword } = require('./seed');
const mapdata = require('./mapdata');
const war = require('./war');
const warScenarios = require('./war-scenarios');
const election = require('./election');
const cadence = require('./cadence');
const { currentWorldMs } = cadence;

// Phase 35 — register default cadence handlers. Safe to call multiple times
// (idempotent). Must run after all modules are imported above.
cadence.registerDefaults();

const COOKIE_EXTRA = (process.env.VERCEL || process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.K_SERVICE) ? '; Secure' : '';
const cleanQty = (v) => Math.round((Number(v) || 0) * 1000000) / 1000000;

// ---------- SSE hub (file mode) / realtime ping (cloud mode) ---------------
const sseClients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data || {})}\n\n`;
  for (const c of sseClients) { try { c.res.write(msg); } catch (e) { sseClients.delete(c); } }
  if (type === 'sync') store.requestBroadcast(); // flushed by store.commit() in cloud mode
}
setInterval(() => broadcast('ping', { t: Date.now() }), 25000).unref();

// ---------- helpers -------------------------------------------------------
// Mutating endpoints that must stay lean: war orders/heartbeat AND GM war
// actions (tuning-slider drags, mid-battle spawns) ride the war prediction +
// heartbeat channel (docs/WAR.md) — attaching a full state payload to each
// would undo the payload diet; auth precedes a full page boot;
// stream/config/cron are not world mutations at all.
const SYNC_SKIP = /^\/api\/(auth\/|war\/|gm\/war\/|stream$|config$|cron$|news\/read$)/;

// Response-sync (Phase 21): every successful world-mutating response carries
// the freshly-mutated, permission-filtered world, so the client applies its
// own write in ONE round-trip instead of POST → debounce → GET /api/state →
// GET /api/polling. handle() tags the response object with the authed user;
// tagging res (per-request object) rather than module state keeps concurrent
// file-mode requests from reading each other's identity mid-await.
function attachSync(res, code, obj) {
  if (code !== 200 || !obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  if (obj.error || obj.sync) return obj;
  const u = res._syncUser;
  if (!u) return obj;
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(res._syncMethod)) return obj;
  if (SYNC_SKIP.test(res._syncPath || '')) return obj;
  try {
    obj.sync = { v: store.getVersion(), user: userPayload(u), state: filterState(u), polling: pollingPayload() };
  } catch (e) { /* a sync payload is a bonus — never break the real response */ }
  return obj;
}
function json(res, code, obj) {
  obj = attachSync(res, code, obj);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  // Cloud mode commits AFTER the handler runs, so any world version embedded
  // here is pre-commit. Mark the buffered response; api/index.js rewrites
  // v/sync.v to the post-commit version before flushing. File mode needs no
  // patch — save() bumps the version synchronously inside the handler.
  if (store.MODE === 'supabase' && obj && typeof obj === 'object' && !Array.isArray(obj) && ('v' in obj || obj.sync)) {
    headers['X-World-V'] = 'pending';
  }
  let body = JSON.stringify(obj);
  // gzip (Phase 21, stdlib zlib — the zero-dep rule is intact): only in file
  // mode (Vercel already compresses at the edge) and only for bodies big
  // enough to beat the CPU cost. A ~600KB state payload shrinks ~8-10x.
  if (store.MODE === 'file' && res._gzipOk && body.length > 2048) {
    try {
      body = zlib.gzipSync(Buffer.from(body, 'utf8'));
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
    } catch (e) { body = JSON.stringify(obj); } // fall back to plain
  }
  res.writeHead(code, headers);
  res.end(body);
  return true; // handled — the static server must not touch this response
}

// What changed between two world snapshots — global vars, province vars,
// money moved, news drafted. Shared by the event Simulate button and the
// GM turn preview (Phase 25).
function computeWorldDiff(before, after) {
  const diff = { globalVars: [], provinces: [], moneyMoved: 0, news: [] };
  const beforeG = before.globalVars || {}, afterG = after.globalVars || {};
  for (const k of new Set([...Object.keys(beforeG), ...Object.keys(afterG)])) {
    if (beforeG[k] !== afterG[k]) diff.globalVars.push({ key: k, from: beforeG[k], to: afterG[k] });
  }
  for (const bp of before.provinces || []) {
    const ap = (after.provinces || []).find(p => p.id === bp.id);
    if (!ap) continue;
    const changes = [];
    for (const k of new Set([...Object.keys(bp.vars || {}), ...Object.keys(ap.vars || {})])) {
      if ((bp.vars || {})[k] !== (ap.vars || {})[k]) changes.push({ key: k, from: (bp.vars || {})[k], to: (ap.vars || {})[k] });
    }
    if (changes.length) diff.provinces.push({ id: bp.id, name: bp.name, changes });
  }
  const newTxns = (after.transactions || []).slice((before.transactions || []).length);
  diff.moneyMoved = newTxns.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);
  const beforeNewsIds = new Set((before.news || []).map(a => a.id));
  diff.news = (after.news || []).filter(a => !beforeNewsIds.has(a.id)).map(a => ({ id: a.id, headline: a.headline, paperId: a.paperId }));
  return diff;
}

// Party-support percentages (national + per province) — public political
// knowledge. Shared by GET /api/polling, /api/state bundling, and attachSync.
function pollingPayload() {
  const { national, totalVotes, byProvince } = sim.computePolling(false);
  const pct = {}; for (const pid in national) pct[pid] = Math.round(national[pid] / (totalVotes || 1) * 1000) / 10;
  const provPct = {};
  for (const provId in byProvince) {
    const votes = byProvince[provId]; const tot = Object.values(votes).reduce((a, b) => a + b, 0) || 1;
    provPct[provId] = {}; for (const pid in votes) provPct[provId][pid] = Math.round(votes[pid] / tot * 1000) / 10;
  }
  return { national: pct, byProvince: provPct };
}

// Normalise & clamp a tariff schedule from the client. Shape:
//   { global:{import,export}, byCountry:{ entId:{import,export} }, byCompany:{...} }
// Rates are whole-percent, clamped [0,90]; zero rows are dropped so the object
// stays small. Returns a fresh, safe object regardless of what came in.
function sanitizeTariffs(raw) {
  const clamp = (n) => Math.max(0, Math.min(90, Math.round(Number(n) || 0)));
  const pair = (o) => ({ import: clamp(o && o.import), export: clamp(o && o.export) });
  const map = (o) => {
    const out = {};
    for (const id in (o || {})) {
      const p = pair(o[id]);
      if (p.import || p.export) out[id] = p; // drop all-zero overrides
    }
    return out;
  };
  raw = raw || {};
  const byItem = map(raw.byItem);
  const embargoes = {};
  for (const id in (raw.embargoes || {})) {
    const v = raw.embargoes[id] || {};
    if (v.import || v.export) embargoes[id] = { import: !!v.import, export: !!v.export };
  }
  return { global: pair(raw.global), byCountry: map(raw.byCountry), byCompany: map(raw.byCompany), byItem, embargoes };
}
function readBody(req, maxBytes) {
  const cap = maxBytes || 4e6;
  // Vercel's Node runtime pre-parses JSON bodies onto req.body.
  if (req.body !== undefined && req.body !== null) {
    return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body);
  }
  return new Promise((resolve, reject) => {
    // Accumulate raw buffers and decode ONCE — string concatenation per chunk
    // splits multi-byte UTF-8 characters across chunk boundaries and turned
    // them into U+FFFD garbage ("Invalid JSON" on valid payloads).
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { const data = Buffer.concat(chunks).toString('utf8'); resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
// Length-safe constant-time compare for fixed-digest hex strings; returns
// false (rather than throwing, like crypto.timingSafeEqual) on any mismatch.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length || !ba.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function getUser(req) {
  const db = store.get();
  const sid = getCookie(req, 'arcsid');
  if (!sid || !db.sessions[sid]) return null;
  const user = db.users.find(u => u.id === db.sessions[sid].userId);
  if (!user) return null;
  const role = db.roles.find(r => r.id === user.roleId) || db.roles.find(r => r.id === 'citizen');
  return { user, role, sid };
}
function userPayload(u) {
  return {
    id: u.user.id, username: u.user.username, displayName: u.user.displayName,
    entityId: u.user.entityId, roleId: u.user.roleId, newspaperId: u.user.newspaperId || null,
    lastReadNewsTs: u.user.lastReadNewsTs || 0,
    role: { id: u.role.id, name: u.role.name, perms: u.role.perms }
  };
}

// ---------- permission-filtered world view --------------------------------
// History as a role sees it: statistics clearance gets the full entries,
// everyone else only the public share-price series. Shared by filterState's
// recent window and GET /api/history's full archive.
// 60 turns rides every state fetch (enough for dossier sparklines and the
// first paint of any chart); long-range charts lazily pull GET /api/history
// once per turn (Views.histAll), so the hot path stays light.
const HIST_STATE_CAP = 60;
function histView(db, p) {
  const hist = db.history || [];
  return p.statistics ? hist : hist.map(h => ({ turn: h.turn, shares: h.shares }));
}
// The war doc as non-GM operators see it (fog of war). Each nation command's
// REASONING (war.command[side].nations[id].notes) stays GM-only intel, but
// the numeric plan state — phase/posture, doctrines, thresholds, the tier
// gates — ships to everyone: the client's predicted engine needs it to
// replay the commander AI (war-ai.js) deterministically, so enemy columns
// turn at the same tick locally as they do on the server. (Stripping it
// wholesale meant a player's prediction could never replan the attacker
// between snapshots; on slow serverless heartbeats every AI turn surfaced
// as a visible rubberband correction.) notes is [] not absent so the
// engine's note() can push into a predicted doc without guards. The legacy
// flat war.ai gets the same treatment for any pre-hierarchy doc still in
// flight. Shared by filterState and the GET /api/war/state heartbeat.
function warWithAircraftCapacity(w, db) {
  if (!w || !db || !w.bombs) return w;
  const aircraft = war.aircraftStock(db, w.defenderId || 'ent_gov', w);
  return { ...w, bombs: { ...w.bombs, def: { ...((w.bombs.def) || {}), aircraftRemaining: aircraft } } };
}
function warForPlayers(war, db, u) {
  if (!war) return war;
  let out = warWithAircraftCapacity(war, db);
  if (u) out = { ...out, cmdAccess: cmdAccessOf(db, war, u) };
  if (war.ai) {
    const { notes, ...aiRest } = war.ai;
    out = { ...out, ai: { ...aiRest, notes: [] } };
  }
  if (war.command) {
    const redactSide = (sideCmd) => {
      const nations = {};
      for (const nid in ((sideCmd || {}).nations || {})) {
        const { notes, ...natRest } = sideCmd.nations[nid];
        nations[nid] = { ...natRest, notes: [] };
      }
      return { ...(sideCmd || {}), nations };
    };
    if (out === war) out = { ...war };
    out.command = { ...war.command, att: redactSide(war.command.att), def: redactSide(war.command.def) };
  }
  return out;
}
// Who may command what in a conflict (Phase 31 protests): attacker-side
// commands belong to the GM or whichever operator CONTROLS the organizer
// entity (a party leader commands their own party's crowds — the ownership
// chain covers person → party leader); the defence belongs to the GM,
// controllers of the defender entity, government-clearance operators and
// anyone holding the 'military' map layer (the National Police file under
// the military staff). Enforced server-side on every command/bomb route and
// shipped inside warForPlayers so the client only offers command UI to
// operators with a side to command.
function cmdAccessOf(db, war, u) {
  const perms = u.role.perms;
  // Phase 35: use canAct with command_units scope; falls back to roster grants
  const def = !!(perms.gm || perms.government ||
    (perms.mapLayers || []).includes('military') ||
    (war && war.defenderId && ownership.canAct(db, u.user.entityId, war.defenderId, 'command_units')));
  const att = !!(perms.gm ||
    (war && war.kind === 'protest' && war.protest && war.protest.organizerId &&
      ownership.canAct(db, u.user.entityId, war.protest.organizerId, 'command_units')));
  return { att, def };
}

// Phase 35 — approval-queue replay. An over-cap request stores a snapshot of
// the exact mutation the requester wanted (action), so approving replays THE
// ORIGINAL intent — not "money to whoever happens to own the entity".
// Returns a human result string; throws on failure (caller keeps the request
// pending so the owner can retry or deny).
function executeRequestAction(db, rq, actor) {
  const a = rq.action || {};
  if (a.kind === 'transfer') {
    const from = db.accounts.find(x => x.id === a.fromAccountId);
    const to = db.accounts.find(x => x.id === a.toAccountId);
    if (!from || !to) throw new Error('The source or destination account no longer exists.');
    if (!(a.amount > 0)) throw new Error('Invalid amount.');
    if (from.balance < a.amount) throw new Error('Insufficient funds on the source account.');
    sim.txn(from.id, to.id, Math.round(a.amount * 100) / 100, String(a.memo || '').slice(0, 140), actor, 'transfer');
    return `Transferred ${db.settings.currency}${Math.round(a.amount * 100) / 100}.`;
  }
  if (a.kind === 'campaign') {
    election.runCampaign(db, a.partyId, a.province, a.campaignId, Math.round(Number(a.money) || 0),
      Array.isArray(a.materials) ? a.materials : [], actor,
      { targetGroup: a.targetGroup || undefined, defamePartyId: a.defamePartyId || undefined });
    return 'Campaign executed.';
  }
  // Permission-only scopes (property_controls etc.) have no mutation to
  // replay — the recorded approval itself is the grant of record.
  return null;
}
function filterState(u) {
  const db = store.get();
  const p = u.role.perms;
  const settings = { ...db.settings, time: { ...db.settings.time } };
  // Phase 33 — the GM's live-election levers are confidential Commission
  // business (the deviation and the campaign→votes exchange rate would spoil
  // the count); everyone else gets the public knobs only.
  if (!p.gm && settings.election) {
    settings.election = { ...settings.election };
    delete settings.election.deviationPct;
    delete settings.election.supportToVotes;
  }
  if (db.settings.time && db.settings.time.clock) {
    settings.time.clock = { ...db.settings.time.clock };
    settings.time.clock.nowMs = sim.worldClockNow(db.settings.time, Date.now());
    settings.time.clock.serverNowMs = Date.now();
  }
  const own = u.user.entityId;
  // The ownership chain the operator commands (own entity + everything it
  // controls). 'own' visibility follows this chain, so an owner sees the
  // accounts/inventories of controlled companies and the President sees the
  // government's holdings — the Bank of Arcasia included.
  const controlled = own ? ownership.controlledSet(own) : new Set();

  const accounts = p.accounts === 'all' ? db.accounts
    : p.accounts === 'own' ? db.accounts.filter(a => controlled.has(a.ownerId)) : [];
  const visAcct = new Set(accounts.map(a => a.id));

  const transactions = (p.accounts === 'all' ? db.transactions
    : db.transactions.filter(t => (t.from && visAcct.has(t.from)) || (t.to && visAcct.has(t.to)))).slice(-400);

  const seeInv = (ownerId) => p.inventories === 'all' || (p.inventories === 'own' && controlled.has(ownerId));
  const military = (p.mapLayers || []).includes('military');

  const entities = db.entities.map(e => {
    const out = { ...e };
    if (!seeInv(e.id)) delete out.inventory;
    if (e.type === 'company' && !p.companyFinancials && e.id !== own && e.ownerId !== own && e.ceoId !== own) {
      delete out.vars; delete out.shareholders; delete out.sharesOutstanding; delete out.x100;
    }
    // Phase 35 roster visibility: full list to owner chain + GM; own entry to
    // roster members not in the chain; strip entirely for everyone else.
    if (out.roster) {
      const isOwnerChain = p.gm || e.id === own || e.ownerId === own || e.ceoId === own || ownership.controls(own, e.id);
      if (isOwnerChain) {
        // Owner/GM sees full roster + pending requests
      } else {
        // Roster member sees only their own entry
        const myEntry = out.roster.find(r => r.userId === own);
        out.roster = myEntry ? [myEntry] : [];
        delete out.pendingRequests;
      }
    }
    return out;
  });

  const provinces = db.provinces.map(pr => {
    if (p.statistics) return pr;
    const out = { ...pr, vars: { population: pr.vars.population } };
    delete out.demographics;
    return out;
  });

  const properties = db.properties
    .filter(pr => military || pr.type !== 'military')
    .map(pr => {
      const out = { ...pr };
      if (!seeInv(pr.ownerId)) delete out.inventory;
      return out;
    });

  // News list ships METADATA ONLY (Phase 21 payload diet — bodies were ~100KB
  // of every state fetch). The full article body is fetched lazily via
  // GET /api/news/:id when a reader opens it (or a journalist edits it).
  const news = (p.manageNews ? db.news : db.news.filter(n => n.status === 'published')).slice(-300)
    .map(n => { const { body, ...meta } = n; return meta; });

  // Timeline visibility (Phase 6, tightened): the full record is GM-only.
  // Non-GM operators receive only transfer/trade/market/inventory entries
  // that concern their own ownership chain (their entity and companies it
  // controls) — no account creation, system notices or anyone else's
  // business. Cap kept at 400 after filtering.
  const playerTlTypes = new Set(['economy', 'ownership', 'market', 'inventory']);
  const timeline = (p.gm ? db.timeline
    : db.timeline.filter(e => playerTlTypes.has(e.type) && e.refs && e.refs.some(r => controlled.has(r)))).slice(-400);

  // Trade offers (Phase 4.3): a user sees offers where either side is in their
  // ownership chain; GM sees all.
  const trades = p.gm ? (db.trades || [])
    : (db.trades || []).filter(t => controlled.has(t.fromEntityId) || controlled.has(t.toEntityId));

  // Ongoing trade contracts: open-market orders are visible to whoever
  // controls the trading holder; player-to-player transfers to either party.
  // GM sees all.
  const contracts = p.gm ? (db.tradeContracts || [])
    : (db.tradeContracts || []).filter(c =>
      (c.holderId && controlled.has(c.holderId)) ||
      (c.fromEntityId && (controlled.has(c.fromEntityId) || controlled.has(c.toEntityId))));

  return {
    settings,
    // Economic confidence is public market information (like share prices), so
    // it is exposed even without the statistics clearance.
    globalVars: p.statistics ? db.globalVars : { population: db.globalVars.population, econConfidence: db.globalVars.econConfidence },
    variables: db.variables,
    entities, provinces, properties, accounts, transactions, news,
    cities: db.cities,
    items: db.items,
    markers: db.markers || [],
    // Share prices are public market information — everyone gets them so the
    // Exchange price-history graphs work for citizens. National statistics
    // (GDP, money supply, …) stay gated on the statistics clearance.
    // Phase 21 payload diet: the hot path carries only the recent window
    // (~180 turns — the full 1000-entry archive was ~300KB of every state
    // fetch); charts that want the whole record pull GET /api/history once.
    history: histView(db, p).slice(-HIST_STATE_CAP),
    timeline, trades,
    // Government tenders (6d): open tenders are public procurement — every
    // operator sees them and may bid through a company they control. Bid
    // detail ships with the tender (bid prices aren't sensitive; it's how a
    // market works), but only GMs see cancelled/expired history beyond 40.
    tenders: p.gm ? (db.tenders || []) : (db.tenders || []).filter(t => t.status === 'open' || t.status === 'awarded').slice(-40),
    contracts,
    tradeContracts: contracts,
    elections: db.elections,
    // Phase 33 — the live election is a public spectacle (everyone watches
    // the count, like the war front), but the official totals and the count's
    // seeded draws stay GM-only — see server/election.js forPlayers().
    election: db.election ? (p.gm ? db.election : election.forPlayers(db.election)) : null,
    // War (fog of war): every logged-in operator sees the front — territory,
    // units, objectives, casualties — plus the AI's numeric plan state so
    // client prediction can replay replans; only ai.notes (the reasoning)
    // stays GM-only. See warForPlayers above.
    war: db.war ? (p.gm ? warWithAircraftCapacity(db.war, db) : warForPlayers(db.war, db, u)) : null,
    // Protests (Phase 31): a second conflict document — same fog-of-war
    // treatment, and cmdAccess (att = organizer's control chain) rides along
    // for every operator via warForPlayers.
    protest: db.protest ? (p.gm ? warWithAircraftCapacity(db.protest, db) : warForPlayers(db.protest, db, u)) : null,
    // Day Market tick clock — same "expose the wall-clock gate so the client
    // can predict the next tick" idea as war.tick/tickMs (see docs/WAR.md's
    // heartbeat), applied read-only to market.maybeDayTick's gate: not
    // sensitive (a timestamp + an interval, nothing about price or money),
    // so it ships to every operator and drives a purely cosmetic "next tick
    // in ~Xs" countdown plus a live trailing point on the Day Market chart —
    // see public/js/views.js's viewExchange/dayChartNode. The server remains
    // the sole source of the actual next dayPrice (market.js's noise draw
    // uses Math.random(), deliberately NOT reproducible client-side).
    dayTick: { lastAt: db._lastDayTick || 0, intervalMs: (db.settings.economy && db.settings.economy.dayTickMs) || 5000 },
    // X100 leveraged trade tuning (Phase 34) — public constants so the client
    // renders the position value formula and lock countdown identically to the
    // server (GM-adjustable via settings.economy.x100Mult / x100LockSec). Note
    // the `=== undefined` guards: 0 is a valid lock setting (no lock), and
    // `|| fallback` would swallow it.
    x100: {
      mult: (db.settings.economy && db.settings.economy.x100Mult !== undefined) ? Number(db.settings.economy.x100Mult) : 100,
      lockSec: (db.settings.economy && db.settings.economy.x100LockSec !== undefined) ? Number(db.settings.economy.x100LockSec) : 60
    },
    // Phase 35 — cadence scheduler progress: per-cadence countdown timers
    // so the client can render progress bars without polling a separate endpoint.
    cadence: cadence.progress(db),
    events: p.gm ? db.events : undefined,
    roles: p.gm ? db.roles : db.roles.map(r => ({ id: r.id, name: r.name })),
    users: p.gm ? db.users.map(x => ({ id: x.id, username: x.username, displayName: x.displayName, roleId: x.roleId, entityId: x.entityId, newspaperId: x.newspaperId || null, lastLogin: x.lastLogin })) : undefined
  };
}

// ---------- GM collection CRUD -------------------------------------------
const COLLS = {
  entities: 'ent', provinces: 'prov', cities: 'city', properties: 'prop',
  items: 'item', events: 'ev', variables: 'var', roles: 'role', accounts: 'acct',
  markers: 'mark'
};

function cascadeDelete(coll, obj) {
  const db = store.get();
  if (coll === 'entities') {
    db.accounts = db.accounts.filter(a => a.ownerId !== obj.id);
    for (const pr of db.properties) if (pr.ownerId === obj.id) pr.ownerId = null;
    for (const e of db.entities) {
      if (e.ownerId === obj.id) e.ownerId = null;
      if (e.ceoId === obj.id) e.ceoId = null;
      if (e.shareholders) e.shareholders = e.shareholders.filter(s => s.entityId !== obj.id);
      // ×100 derivative book: phantom entries for a deleted entity inflated
      // heldTotal forever (unsellable shares permanently shrinking the float).
      if (e.x100) delete e.x100[obj.id];
    }
    for (const uu of db.users) if (uu.entityId === obj.id) uu.entityId = null;
    // A deleted COMPANY leaves its share certificates (and ×100 mirror items)
    // orphaned in inventories — untradeable items that detonated trade-accept
    // validation. Retire them like deeds.js retires deeds of dead properties.
    const goneCo = obj.type === 'company';
    for (const it of db.items.filter(i => i.meta && i.meta.companyId && goneCo && i.meta.companyId === obj.id)) {
      db.items = db.items.filter(x => x.id !== it.id);
      for (const e of db.entities) if (e.inventory) e.inventory = e.inventory.filter(r => r.itemId !== it.id);
    }
  }
  if (coll === 'items') {
    for (const e of db.entities) if (e.inventory) e.inventory = e.inventory.filter(r => r.itemId !== obj.id);
    for (const pr of db.properties) if (pr.inventory) pr.inventory = pr.inventory.filter(r => r.itemId !== obj.id);
  }
  if (coll === 'provinces') {
    for (const c of db.cities) if (c.provinceId === obj.id) c.provinceId = null;
    for (const pr of db.properties) if (pr.provinceId === obj.id) pr.provinceId = null;
  }
}

// Paginated transaction history. The state payload intentionally contains a
// recent window, but the ledger itself is append-only and can be browsed back
// indefinitely. Visibility follows the same account permissions as state.
async function ledgerPage(u, query) {
  const db = store.get();
  const p = u.role.perms;
  const controlled = u.user.entityId ? ownership.controlledSet(u.user.entityId) : new Set();
  const visible = p.accounts === 'all'
    ? db.accounts
    : p.accounts === 'own' ? db.accounts.filter(a => controlled.has(a.ownerId)) : [];
  const visibleIds = new Set(visible.map(a => a.id));
  const requested = query.get('account');
  const accountIds = requested ? new Set([requested].filter(id => visibleIds.has(id))) : visibleIds;
  const limit = Math.max(1, Math.min(100, Number(query.get('limit')) || 80));
  const before = Number(query.get('before'));
  const matches = (t) => {
    if (Number.isFinite(before) && before > 0 && Number(t.ts) >= before) return false;
    return (t.from && accountIds.has(t.from)) || (t.to && accountIds.has(t.to));
  };

  if (store.MODE === 'supabase') {
    if (!accountIds.size) return { transactions: [], hasMore: false, nextBefore: null };
    const ids = [...accountIds].join(',');
    const clauses = `or=(from_acct.in.(${ids}),to_acct.in.(${ids}))`;
    const cursor = Number.isFinite(before) && before > 0 ? `&ts=lt.${Math.floor(before)}` : '';
    const rows = await sb.select('transactions', `select=*&${clauses}${cursor}&order=ts.desc&limit=${limit + 1}`);
    const all = rows.map(r => ({ id: r.id, ts: Number(r.ts), turn: r.turn, simDate: r.sim_date, from: r.from_acct, to: r.to_acct, amount: Number(r.amount), memo: r.memo, actor: r.actor, kind: r.kind }));
    const hasMore = all.length > limit;
    const transactions = all.slice(0, limit);
    return { transactions, hasMore, nextBefore: hasMore && transactions.length ? transactions[transactions.length - 1].ts : null };
  }

  const all = db.transactions.filter(matches).slice().sort((a, b) => Number(b.ts) - Number(a.ts));
  const transactions = all.slice(0, limit);
  return { transactions, hasMore: all.length > limit, nextBefore: all.length > limit && transactions.length ? transactions[transactions.length - 1].ts : null };
}

// ---------- request handling ----------------------------------------------
async function handle(req, res, pathname, method) {
  if (!pathname.startsWith('/api/')) return false;
  const db = store.get();
  const u = getUser(req);
  // response-sync context (see attachSync) — per-response, never module state
  res._syncUser = u; res._syncMethod = method; res._syncPath = pathname;
  res._gzipOk = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const deny = (msg) => json(res, 403, { error: msg || 'Not permitted' });
  const bad = (msg) => json(res, 400, { error: msg || 'Bad request' });

  try {
    // ---- public: client bootstrap config ----
    if (pathname === '/api/config' && method === 'GET') {
      const ephemeral = store.MODE === 'file' && !!(process.env.VERCEL || process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.K_SERVICE);
      return json(res, 200, store.MODE === 'supabase'
        ? { storage: 'supabase', realtime: 'supabase', supabaseUrl: sb.url, supabaseAnonKey: sb.anonKey }
        : { storage: 'file', realtime: 'sse', ephemeral,
            warning: ephemeral ? 'No database configured. The world is stored on an ephemeral filesystem and will be lost on redeploy. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then redeploy.' : undefined });
    }

    // ---- cron: advance overdue auto-turns (Vercel Cron or any pinger) ----
    if (pathname === '/api/cron' && (method === 'GET' || method === 'POST')) {
      const secret = process.env.CRON_SECRET;
      const q = new URL(req.url, 'http://localhost').searchParams;
      const authed = (secret && (safeEqual(String(req.headers.authorization || ''), 'Bearer ' + secret)
        || safeEqual(q.get('key') || '', secret))) || (u && u.role.perms.gm);
      if (!authed) return deny('Cron secret or GM session required.');
      const result = sim.autoTick('AUTO');
      return json(res, 200, result);
    }

    // ---- auth ----
    if (pathname === '/api/auth/login' && method === 'POST') {
      const b = await readBody(req);
      const user = db.users.find(x => x.username.toLowerCase() === String(b.username || '').toLowerCase());
      if (!user) {
        // Burn a scrypt round for unknown users too so response timing doesn't
        // enumerate valid operator names.
        crypto.scryptSync(String(b.password || ''), 'timing-equalizer', 32);
        return json(res, 401, { error: 'Unknown operator or wrong passphrase.' });
      }
      const hash = crypto.scryptSync(String(b.password || ''), user.salt, 32).toString('hex');
      if (!safeEqual(hash, user.passHash)) return json(res, 401, { error: 'Unknown operator or wrong passphrase.' });
      // prune sessions past the cookie's own 30-day Max-Age — they can never
      // authenticate again but used to accumulate in the world doc forever
      const sessionCutoff = Date.now() - 2592000e3;
      for (const oldSid in db.sessions) if ((db.sessions[oldSid].ts || 0) < sessionCutoff) delete db.sessions[oldSid];
      const sid = crypto.randomBytes(24).toString('hex');
      db.sessions[sid] = { userId: user.id, ts: Date.now() };
      user.lastLogin = Date.now();
      store.save();
      res.setHeader('Set-Cookie', `arcsid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${COOKIE_EXTRA}`);
      const nu = getUser({ headers: { cookie: 'arcsid=' + sid } });
      return json(res, 200, { user: userPayload(nu) });
    }
    if (pathname === '/api/auth/logout' && method === 'POST') {
      if (u) { delete db.sessions[u.sid]; store.save(); }
      res.setHeader('Set-Cookie', `arcsid=; HttpOnly; Path=/; Max-Age=0${COOKIE_EXTRA}`);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/auth/register' && method === 'POST') {
      if (!db.settings.registration.open) return deny('Registration is closed. Apply to the Gamemaster.');
      const b = await readBody(req);
      const username = String(b.username || '').trim().toLowerCase();
      const display = String(b.displayName || b.username || '').trim().slice(0, 60);
      if (!/^[a-z0-9_.-]{3,24}$/.test(username)) return bad('Username: 3–24 chars, letters/digits/._-');
      if (String(b.password || '').length < 4) return bad('Passphrase too short.');
      if (db.users.some(x => x.username === username)) return bad('That operator name is taken.');
      const ent = { id: store.uid('per'), type: 'person', name: display || username, title: 'Citizen', color: '#5b5e2c', description: 'A citizen of the Republic.', vars: {}, inventory: [] };
      db.entities.push(ent);
      const { salt, hash } = hashPassword(String(b.password));
      const user = { id: store.uid('user'), username, displayName: display || username, salt, passHash: hash, roleId: db.settings.registration.defaultRole || 'citizen', entityId: ent.id, created: Date.now(), lastLogin: Date.now() };
      db.users.push(user);
      const acct = sim.primaryAccount(ent.id, true);
      const stipend = db.settings.registration.stipend || 0;
      if (stipend > 0) sim.txn(null, acct.id, stipend, 'Citizenship stipend', 'REGISTRY', 'deposit');
      store.log('system', `New citizen registered: ${user.displayName}`, '', 'REGISTRY', [ent.id]);
      const sid = crypto.randomBytes(24).toString('hex');
      db.sessions[sid] = { userId: user.id, ts: Date.now() };
      store.save();
      broadcast('sync');
      res.setHeader('Set-Cookie', `arcsid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${COOKIE_EXTRA}`);
      const nu = getUser({ headers: { cookie: 'arcsid=' + sid } });
      return json(res, 200, { user: userPayload(nu) });
    }

    // everything below requires a session
    if (!u) return json(res, 401, { error: 'Not authenticated' });

    if (pathname === '/api/me' && method === 'GET') return json(res, 200, { user: userPayload(u) });
    if (pathname === '/api/me/password' && method === 'PATCH') {
      const b = await readBody(req);
      const cur = crypto.scryptSync(String(b.old || ''), u.user.salt, 32).toString('hex');
      if (!safeEqual(cur, u.user.passHash)) return bad('Current passphrase incorrect.');
      if (String(b.new || '').length < 4) return bad('New passphrase too short.');
      const { salt, hash } = hashPassword(String(b.new));
      u.user.salt = salt; u.user.passHash = hash;
      store.save();
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/state' && method === 'GET') {
      // Serverless-friendly TURN advance: with no resident process the
      // auto-advance timer never runs and the Vercel cron only fires daily,
      // so overdue auto-turns ride state fetches through the same gated-tick
      // pattern as the Day Market below. autoTick is a no-op unless
      // settings.time.auto is enabled and a full interval has elapsed;
      // advanceTurn itself saves + broadcasts. Long-lived mode keeps the
      // real timer and skips this (riding both would double-advance).
      try { if (!sim.isLongLived()) sim.autoTick('AUTO'); } catch (e) { console.error('auto-turn tick failed:', e.message); }
      // Serverless-friendly Day Market advance: ride this fetch to tick the
      // market on wall-clock cadence (gated, so at most once per window).
      // Save WITHOUT broadcast — a per-tick broadcast forced every client
      // (map-watching or not) into a full refetch every ~5s, the same global
      // thrash per-tick war broadcasts caused. Clients actually LOOKING at
      // the exchange keep themselves fresh: the live wiggle is client-side
      // (pricepath) and views.js's startPriceTicker nudges a refetch once
      // the committed tick is overdue (which also drives this very gate).
      try { if (market.maybeDayTick(db)) { store.save(); } } catch (e) { /* market optional */ }
      // War ticks save (heartbeat pollers read the commit) but only broadcast
      // on milestones — per-tick broadcasts made every client refetch the full
      // world at tick rate during a war. See war.maybeWarTickSignal.
      try { const sig = war.maybeWarTickSignal(db); if (sig.ticked) { store.save(); if (sig.milestone) broadcast('sync'); } } catch (e) { /* war optional */ }
      // Serverless-friendly election count: the count runs off the
      // continuous world clock (sim.worldClockNow) now, not turns, so it
      // needs its own gated ride here — same self-throttled, safe-to-call-
      // from-anywhere pattern as market/war above. Broadcasts only on a
      // quarter/half/three-quarter milestone or when the count finalizes,
      // never on every tiny partial-progress tick.
      try { const sig = election.maybeTick(db, 'ENGINE'); if (sig.ticked) { store.save(); if (sig.milestone) broadcast('sync'); } } catch (e) { /* election optional */ }
      // Phase 35 — generalized cadence scheduler: runs any cadence whose
      // world-clock interval has elapsed. Same gated-tick pattern as
      // market/war/election above. Broadcasts on sync (handlers do their
      // own broadcast when world-visible state changes).
      try { if (cadence.maybeRunCadences(db)) { store.save(); broadcast('sync'); } } catch (e) { /* cadence optional */ }
      // ?ifv= fast-path: the client already holds this version — skip the
      // ~100KB filterState body and answer with a tiny "unchanged" envelope.
      // Never when this very request mutated the world (gated ticks above):
      // cloud-mode getVersion() is pre-commit then, so a match would lie.
      const ifv = new URL(req.url, 'http://localhost').searchParams.get('ifv');
      if (ifv !== null && ifv === String(store.getVersion()) && !store.hasUncommitted()) {
        return json(res, 200, { v: store.getVersion(), unchanged: true, user: userPayload(u) });
      }
      return json(res, 200, { user: userPayload(u), state: filterState(u), v: store.getVersion(), polling: pollingPayload() });
    }

    if (pathname === '/api/stream' && method === 'GET') {
      // serverless deployments use Supabase Realtime instead of a held-open response
      if (store.MODE !== 'file') return json(res, 404, { error: 'Live updates use Supabase Realtime on this deployment.' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
      res.write('retry: 3000\n\n');
      const client = { res, userId: u.user.id };
      sseClients.add(client);
      req.on('close', () => sseClients.delete(client));
      return true;
    }

    // Full stat-history archive (Phase 21 payload diet) — /api/state carries
    // only the recent HIST_STATE_CAP window; long-range charts pull this once
    // per turn and cache client-side. Same role filtering as filterState.
    if (pathname === '/api/history' && method === 'GET') {
      return json(res, 200, { history: histView(db, u.role.perms), turn: db.settings.time.turn });
    }
    if (pathname === '/api/ledger' && method === 'GET') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      return json(res, 200, await ledgerPage(u, q));
    }
    // Full article body (Phase 21 payload diet) — the state's news list is
    // metadata-only. Visibility mirrors filterState: drafts require manageNews.
    if (pathname.startsWith('/api/news/') && method === 'GET') {
      const id = pathname.slice('/api/news/'.length);
      const article = db.news.find(n => n.id === id);
      if (!article) return json(res, 404, { error: 'No such article.' });
      if (article.status !== 'published' && !u.role.perms.manageNews) return deny('Not published.');
      return json(res, 200, { article });
    }
    if (pathname === '/api/polling' && method === 'GET') {
      // public political knowledge — newspapers publish polls; every operator
      // may see the party-support landscape (national and per province).
      // Kept for older clients; new clients read the copy bundled into
      // /api/state and mutation sync payloads.
      return json(res, 200, pollingPayload());
    }

    // ---- player actions ----
    if (pathname === '/api/transfer' && method === 'POST') {
      const b = await readBody(req);
      const from = db.accounts.find(a => a.id === b.fromAccountId);
      let to = db.accounts.find(a => a.id === b.toAccountId);
      if (!to && b.toEntityId && db.entities.some(e => e.id === b.toEntityId)) to = sim.primaryAccount(b.toEntityId, true);
      const amount = Number(b.amount);
      if (!from || !to) return bad('Unknown account.');
      if (from.id === to.id) return bad('Cannot transfer to the same account.');
      if (!(amount > 0)) return bad('Amount must be positive.');
      const isGm = u.role.perms.gm;
      // Phase 35: canAct with the spend scope — roster grants narrow by
      // account and spendLimitPerTurn. Over-cap (but otherwise allowed)
      // requests go to the owner's approval queue with a snapshot of the
      // exact transfer, so approving replays the real intent.
      if (!isGm && !ownership.canAct(db, u.user.entityId, from.ownerId, 'spend', { amount, accountId: from.id })) {
        // Check if there's a roster grant but amount exceeds cap - create pending request
        // The grant must actually cover the SPEND scope — canAct can fail at
        // the scope gate (e.g. a trade-only grantee), and the queue must not
        // accept an action the grant was never allowed to perform.
        const grant = ownership.findGrant(db.entities.find(e => e.id === from.ownerId), u.user.entityId);
        if (grant && ownership.grantCoversScope(grant, 'spend') && grant.grants && grant.grants.spendLimitPerTurn !== null && grant.grants.spendLimitPerTurn !== undefined
            && ownership.grantCoversAccount(grant, from.id) && amount > grant.grants.spendLimitPerTurn) {
          const req = ownership.createRequest(db, from.ownerId, u.user.entityId, 'spend', {
            amount, accountId: from.id,
            description: b.memo || `Transfer ${db.settings.currency}${amount}`,
            action: { kind: 'transfer', fromAccountId: from.id, toAccountId: to.id, amount, memo: String(b.memo || '').slice(0, 140) },
          });
          store.log('economy', `Over-cap transfer request created`, `${db.settings.currency}${amount} from ${from.name}`, u.user.displayName, [from.ownerId]);
          store.save(); broadcast('sync');
          return json(res, 202, { ok: false, pending: true, requestId: req.id, message: 'Transfer exceeds your spend limit. Request submitted for owner approval.' });
        }
        return deny('You do not control the source account.');
      }
      if (!isGm && from.balance < amount) return bad('Insufficient funds.');
      sim.txn(from.id, to.id, amount, String(b.memo || '').slice(0, 140), u.user.displayName, 'transfer');
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true });
    }

    // ---- Entertainment & gambling (Phase 12) ----
    // Outcomes are computed server-side; the client only animates to them.
    if (pathname.startsWith('/api/casino/') && method === 'POST') {
      const b = await readBody(req);
      const entityId = u.user.entityId;
      if (!entityId) return deny('You need a citizen persona to play.');
      const venue = casino.venueById(db, b.venueId);
      if (!venue || !venue.enabled) return bad('That venue is not open.');
      try {
        let result;
        if (pathname === '/api/casino/roulette') {
          if (!(venue.games || []).includes('roulette')) return bad('No roulette here.');
          result = casino.playRoulette(db, venue, entityId, b.bets, u.user.displayName);
        } else if (pathname === '/api/casino/blackjack') {
          if (!(venue.games || []).includes('blackjack')) return bad('No blackjack here.');
          const act = b.action;
          if (act === 'deal') result = casino.bjDeal(db, venue, entityId, u.user.id, b.bet, u.user.displayName);
          else if (act === 'hit') result = casino.bjHit(db, venue, u.user.id, u.user.displayName);
          else if (act === 'stand') result = casino.bjStand(db, venue, u.user.id, u.user.displayName);
          else if (act === 'double') result = casino.bjDouble(db, venue, u.user.id, u.user.displayName);
          else return bad('Unknown blackjack action.');
        } else if (pathname === '/api/casino/lottery') {
          if (venue.kind !== 'lottery') return bad('Not a lottery.');
          result = casino.buyTicket(db, venue, entityId, u.user.id, b.numbers, u.user.displayName);
        } else return bad('Unknown casino action.');
        store.save(); broadcast('sync');
        return json(res, 200, result);
      } catch (e) { return bad(e.message); }
    }
    // CEO/GM tuning of a venue's odds & limits (must control the owner entity)
    {
      const mv = pathname.match(/^\/api\/casino\/venue\/([\w-]+)$/);
      if (mv && method === 'PATCH') {
        const b = await readBody(req);
        const venue = casino.venueById(db, mv[1]);
        if (!venue) return bad('No such venue.');
        // Regression note (Workstream B): a venue is editable by GM or by
        // whoever controls the venue's OWNING entity. The Satrom casino's owner
        // is `ent_satrom` (owned by the foreign `for_sarom`, CEO `per_hale`), so
        // the SATROM CEO passes here while the President — who only controls the
        // government/ARC chain, which never reaches `ent_satrom` — is denied.
        // The reported "CEO can't edit" bug was live-world DATA drift (venue
        // re-owned to a gov entity, or `ent_satrom.ceoId` cleared); store.migrate
        // now self-heals the casino owner, and the seed keeps ceoId=`per_hale`.
        // The client mirror (`ownership_controlsClient` in entertainment.js) uses
        // the identical rule — keep them in lockstep.
        if (!u.role.perms.gm && !ownership.controls(u.user.entityId, venue.ownerId)) return deny('You do not run this venue.');
        const num = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n)));
        if (b.enabled !== undefined && u.role.perms.gm) venue.enabled = !!b.enabled;
        // GM-only venue stewardship: rename, re-blurb, or hand the house to a
        // different company — the new owner's primary account starts paying
        // winnings and banking losses from the next round.
        if (u.role.perms.gm) {
          if (b.name !== undefined && String(b.name).trim()) venue.name = String(b.name).trim().slice(0, 80);
          if (b.blurb !== undefined) venue.blurb = String(b.blurb).slice(0, 240);
          if (b.ownerId !== undefined && b.ownerId !== venue.ownerId) {
            if (!db.entities.some(e => e.id === b.ownerId)) return bad('Unknown owner entity.');
            const prev = venue.ownerId;
            venue.ownerId = b.ownerId;
            store.log('ownership', `${venue.name} changes hands`, `House passes from ${(db.entities.find(e => e.id === prev) || {}).name || '—'} to ${(db.entities.find(e => e.id === b.ownerId) || {}).name || '—'}.`, 'GM ' + u.user.displayName, [venue.ownerId, prev].filter(Boolean));
          }
        }
        if (b.minBet !== undefined) venue.minBet = Math.max(1, Math.round(Number(b.minBet) || 1));
        if (b.maxBet !== undefined) venue.maxBet = Math.max(venue.minBet || 1, Math.round(Number(b.maxBet) || 1));
        if (b.roulette && venue.roulette) { if (b.roulette.greenSlots !== undefined) venue.roulette.greenSlots = num(b.roulette.greenSlots, 1, 6); }
        if (b.blackjack && venue.blackjack) {
          if (b.blackjack.blackjackPays !== undefined) venue.blackjack.blackjackPays = num(b.blackjack.blackjackPays, 1, 3);
          if (b.blackjack.dealerStandsOn !== undefined) venue.blackjack.dealerStandsOn = num(b.blackjack.dealerStandsOn, 15, 21);
        }
        if (b.ticketPrice !== undefined && venue.kind === 'lottery') venue.ticketPrice = Math.max(1, Math.round(Number(b.ticketPrice) || 1));
        if (b.houseCutPct !== undefined && venue.kind === 'lottery') venue.houseCutPct = num(b.houseCutPct, 0, 90);
        // Jackpot controls — the venue's owner (or GM) may set the pot and
        // the seed floor directly. Publicity money, not an accounting entry:
        // no funds move until a draw pays out.
        if (b.pot !== undefined && venue.kind === 'lottery') {
          const newPot = Math.max(0, Math.round(Number(b.pot) || 0));
          if (newPot !== (venue.pot || 0)) {
            venue.pot = newPot;
            store.log('economy', `${venue.name} jackpot set to ${db.settings.currency}${newPot}`, '', u.user.displayName, [venue.ownerId]);
          }
        }
        if (b.jackpotSeed !== undefined && venue.kind === 'lottery') venue.jackpotSeed = Math.max(0, Math.round(Number(b.jackpotSeed) || 0));
        store.save(); broadcast('sync');
        return json(res, 200, { venue });
      }
    }

    // ---- War: interactive command routes (Phase 16). Any logged-in operator
    // may command the defender; only the GM may pick 'att' (and only the GM
    // sees war.ai at all — see filterState). The client only sends orders;
    // the server is authoritative for everything that actually moves a unit
    // or detonates a bomb.
    // Lightweight war heartbeat (Phase 18 — client prediction). Clients
    // watching an active war poll this at ~tick cadence instead of the full
    // /api/state: it drives the wall-clock tick gate (the broadcast → refetch
    // loop is NOT self-sustaining on serverless — a refetch lands well inside
    // the next tick window and then nothing polls until the 20s fallback, so
    // without a dedicated driver the war advances in 20-second bursts) and
    // returns just the war doc, which the client rebases its local predicted
    // simulation onto. Same fog-of-war filtering as filterState.
    if (pathname === '/api/war/state' && method === 'GET') {
      try { const sig = war.maybeWarTickSignal(db); if (sig.ticked) { store.save(); if (sig.milestone) broadcast('sync'); } } catch (e) { /* war optional */ }
      const w = db.war ? (u.role.perms.gm ? warWithAircraftCapacity(db.war, db) : warForPlayers(db.war, db, u)) : null;
      const pt = db.protest ? (u.role.perms.gm ? warWithAircraftCapacity(db.protest, db) : warForPlayers(db.protest, db, u)) : null;
      return json(res, 200, { war: w, protest: pt, v: store.getVersion() });
    }
    if (pathname === '/api/war/command' && method === 'POST') {
      const b = await readBody(req);
      const key = b.conflict === 'protest' ? 'protest' : 'war';
      const doc = key === 'protest' ? db.protest : db.war;
      if (!doc || !doc.active) return bad('No conflict is active.');
      // Attacker-side commands need the GM or the organizer's control chain
      // (a party leader commands their party's protest); the defence needs
      // government/military clearance or control of the defender entity.
      const ca = cmdAccessOf(db, doc, u);
      const side = b.side === 'att' ? (ca.att ? 'att' : null) : (ca.def ? 'def' : null);
      if (!side) return deny('You cannot command that side of the conflict.');
      if (!Array.isArray(b.orders) || b.orders.length > 64) return bad('Invalid orders.');
      const inBounds = (p) => Array.isArray(p) && p.length === 2 &&
        Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
        p[0] >= 0 && p[0] <= 3840 && p[1] >= 0 && p[1] <= 2160;
      // Orders carry `dest` (plain move), `path` (a player-drawn freehand
      // polyline, ≥2 points, cap 200 — see docs/WAR.md "Manual paths"), or
      // `attackId` (chase a specific enemy unit id — see docs/WAR.md
      // "Explicit attack orders"). The engine (applyOrders) is the actual
      // choke point that clamps/caps everything again, and re-validates the
      // attackId target itself (exists, alive, opposite side) — this is just
      // the first filter so a malformed order never reaches it.
      const orders = b.orders.filter(o => {
        if (!o || typeof o.unitId !== 'string') return false;
        if (Array.isArray(o.path)) return o.path.length >= 2 && o.path.length <= 200 && o.path.every(inBounds);
        if (typeof o.attackId === 'string') return true;
        return inBounds(o.dest);
      });
      // Phase 5 delegation: a command_units roster grantee whose grant
      // carries unitFilter may only command the units its grant covers.
      // Chain/GM/government clearance commands everything, as before.
      const controllerId = side === 'def' ? doc.defenderId
        : (doc.kind === 'protest' && doc.protest ? doc.protest.organizerId : null);
      const perms = u.role.perms;
      const fullAccess = !!(perms.gm ||
        (side === 'def' && (perms.government || (perms.mapLayers || []).includes('military'))) ||
        (controllerId && ownership.controls(u.user.entityId, controllerId)));
      let finalOrders = orders;
      if (!fullAccess && controllerId) {
        finalOrders = orders.filter(o => ownership.canAct(db, u.user.entityId, controllerId, 'command_units', { unitId: o.unitId }));
        if (!finalOrders.length) return deny('Your command grant does not cover those units.');
      }
      war.commandUnits(db, side, finalOrders, u.user.displayName, key);
      // save WITHOUT broadcast: a move order only touches db.war.units, and
      // every war-watching client pulls that through its ~1s /api/war/state
      // heartbeat. A per-order broadcast forced EVERY client (war-watching or
      // not) into a full /api/state refetch + re-render — at order rates
      // during a battle that global thrash was the lag, same lesson as
      // per-tick broadcasts (docs/WAR.md "Milestone-only broadcasts").
      store.save();
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/war/bomb' && method === 'POST') {
      const b = await readBody(req);
      const key = b.conflict === 'protest' ? 'protest' : 'war';
      const doc = key === 'protest' ? db.protest : db.war;
      if (!doc || !doc.active) return bad('No conflict is active.');
      if (!cmdAccessOf(db, doc, u).def) return deny('You cannot call in airstrikes.');
      // Bombs are defender-only (server/war.js's dropBomb also enforces this
      // itself) — even a GM commanding the attacker side has no air arm to
      // call in for this scenario, so unlike /api/war/command there is no
      // GM 'att' branch here at all.
      const side = 'def';
      const pos = b.pos;
      if (!Array.isArray(pos) || pos.length !== 2 || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1]) ||
        pos[0] < 0 || pos[0] > 3840 || pos[1] < 0 || pos[1] > 2160) return bad('Invalid target position.');
      const result = war.dropBomb(db, side, pos, u.user.displayName, key);
      if (!result.ok) return bad(result.error);
      // save without broadcast — same reasoning as /api/war/command above:
      // the orderer splices the returned strike into its prediction, everyone
      // else learns of it from the next heartbeat; the blast's ground effects
      // fire at strikeTick inside warTick, whose milestone signal DOES
      // broadcast when something world-visible happens.
      store.save();
      // strike is returned so the client can insert it into the predicted
      // war immediately (plane/countdown start before the next heartbeat).
      return json(res, 200, { ok: true, cooldownUntil: doc.bombs[side].cooldownUntil, aircraftRemaining: result.aircraftRemaining, strike: result.strike });
    }

    if (pathname === '/api/protest/control' && method === 'POST') {
      const b = await readBody(req);
      if (!db.protest || !db.protest.active) return bad('No protest is active.');
      const ca = cmdAccessOf(db, db.protest, u);
      const patch = {};
      if (b.protestorsViolent !== undefined) {
        if (!ca.att) return deny('Only the organizer or the GM may direct the protestors.');
        patch.protestorsViolent = !!b.protestorsViolent;
      }
      if (b.captureMode !== undefined) {
        if (!ca.att) return deny('Only the organizer or the GM may set capture mode.');
        patch.captureMode = !!b.captureMode;
      }
      if (b.govViolent !== undefined) {
        if (!ca.def) return deny('Only the government or the GM may order the security forces.');
        patch.govViolent = !!b.govViolent;
      }
      if (!Object.keys(patch).length) return bad('Nothing to update.');
      const result = war.setProtestControl(db, patch, u.user.displayName);
      if (!result.ok) return bad(result.error);
      store.save(); broadcast('sync');
      // Same redaction as every other conflict view — never ship the raw doc
      // (ai notes / command bookkeeping must stay server-side).
      const p = db.protest ? (u.role.perms.gm ? warWithAircraftCapacity(db.protest, db) : warForPlayers(db.protest, db, u)) : null;
      return json(res, 200, { protest: p });
    }

    if (pathname === '/api/trade' && method === 'POST') {
      const b = await readBody(req);
      // A controller may send from any entity in their ownership chain (their
      // company, its subsidiaries, …), not just their own person.
      const fromEnt = db.entities.find(e => e.id === (b.fromEntityId || u.user.entityId));
      const toEnt = db.entities.find(e => e.id === b.toEntityId);
      const item = db.items.find(i => i.id === b.itemId);
      const qty = cleanQty(b.qty);
      if (!fromEnt || !toEnt || !item) return bad('Unknown entity or item.');
      if (!u.role.perms.gm && !ownership.controls(u.user.entityId, fromEnt.id)) return deny('You do not control that entity.');
      if (fromEnt.id === toEnt.id) return bad('Cannot trade with yourself.');
      if (!(qty > 0)) return bad('Quantity must be positive.');
      if (!item.tradable && !u.role.perms.gm) return deny('That item is not tradable.');
      // X100 leveraged certificates are positions on the derivative book, not
      // movable inventory — the only way out is selling back through the
      // exchange (Phase 34).
      if (item.meta && item.meta.leveraged) return bad('Leveraged positions cannot be traded — sell them back through the exchange.');
      // Share certificates are ownership records — route through the market so
      // the shareholder register moves in lockstep with the certificate item.
      if (item.meta && item.meta.companyId) {
        try { market.transfer(item.meta.companyId, fromEnt.id, toEnt.id, qty, u.user.displayName); store.save(); broadcast('sync'); return json(res, 200, { ok: true }); }
        catch (e) { return bad(e.message); }
      }
      // Property deeds likewise — moving the deed conveys the property itself.
      if (item.meta && item.meta.propertyId) {
        try { deeds.transfer(item.meta.propertyId, fromEnt.id, toEnt.id, u.user.displayName); store.save(); broadcast('sync'); return json(res, 200, { ok: true }); }
        catch (e) { return bad(e.message); }
      }
      fromEnt.inventory = fromEnt.inventory || [];
      const row = fromEnt.inventory.find(r => r.itemId === item.id);
      if (!row || row.qty < qty) return bad('Not enough in inventory.');
      row.qty -= qty;
      fromEnt.inventory = fromEnt.inventory.filter(r => r.qty > 0);
      toEnt.inventory = toEnt.inventory || [];
      const trow = toEnt.inventory.find(r => r.itemId === item.id);
      if (trow) trow.qty += qty; else toEnt.inventory.push({ itemId: item.id, qty });
      store.log('inventory', `${qty} × ${item.name} traded`, `${fromEnt.name} → ${toEnt.name}`, u.user.displayName, [fromEnt.id, toEnt.id, item.id]);
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true });
    }

    // ---- property site inventory: deposit/withdraw between a property and
    // its owner entity. Anyone in the owner's control chain may move goods
    // (the CEO stocking a company factory, the owner emptying a warehouse).
    if (pathname === '/api/property/items' && method === 'POST') {
      const b = await readBody(req);
      const pr = db.properties.find(p => p.id === b.propertyId);
      if (!pr) return bad('Unknown property.');
      const gm = u.role.perms.gm;
      if (!gm && (!pr.ownerId || !ownership.controls(u.user.entityId, pr.ownerId))) return deny('You do not control this property.');
      const owner = db.entities.find(e => e.id === pr.ownerId);
      if (!owner) return bad('The property has no owner entity to move goods to.');
      const item = db.items.find(i => i.id === b.itemId);
      const qty = cleanQty(b.qty);
      if (!item || !(qty > 0)) return bad('Item and a positive quantity are required.');
      if (item.meta && (item.meta.companyId || item.meta.propertyId)) return bad('Certificates and deeds are ownership records — they cannot be stored on site.');
      const withdraw = b.direction === 'withdraw'; // site → owner; otherwise owner → site
      const fromHolder = withdraw ? pr : owner;
      const toHolder = withdraw ? owner : pr;
      fromHolder.inventory = fromHolder.inventory || [];
      const row = fromHolder.inventory.find(r => r.itemId === item.id);
      if (!row || row.qty < qty) return bad('Not enough in ' + (withdraw ? 'the site inventory.' : `${owner.name}’s inventory.`));
      row.qty -= qty;
      fromHolder.inventory = fromHolder.inventory.filter(r => r.qty > 0);
      toHolder.inventory = toHolder.inventory || [];
      const trow = toHolder.inventory.find(r => r.itemId === item.id);
      if (trow) trow.qty += qty; else toHolder.inventory.push({ itemId: item.id, qty });
      store.log('inventory', `${qty} × ${item.name} ${withdraw ? 'withdrawn from' : 'deposited at'} ${pr.name}`, '', u.user.displayName, [pr.ownerId, pr.id, item.id]);
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true });
    }

    // ---- property operations (Phase 28) ---------------------------------
    // A property may be owned directly by a person, so operations cannot be
    // limited to the company desk. These controls are deliberately scoped to
    // the property: output, cash mode, stock policy and local payroll.
    // Sales & payroll policy (keep %, wages) follows the company desk's
    // access — anyone in the owner's control chain may tune it. The
    // production line itself (what the site makes, its mode, cash output)
    // is a Game Master lever.
    const propertyControlsMatch = pathname.match(/^\/api\/property\/([\w-]+)\/controls$/);
    if (propertyControlsMatch && method === 'PATCH') {
      const pr = db.properties.find(p => p.id === propertyControlsMatch[1]);
      if (!pr) return bad('No such property.');
      const gm = u.role.perms.gm;
      // Phase 35: canAct with property_controls scope, narrowed to THIS
      // property via the grant's properties list. Controls changes are not
      // spends, so there is nothing for the approval queue to replay — a
      // failed check is simply denied.
      if (!gm && !pr.ownerId) return deny('Property has no owner.');
      if (!gm && !ownership.canAct(db, u.user.entityId, pr.ownerId, 'property_controls', { propertyId: pr.id })) {
        return deny('You do not control this property.');
      }
      const b = await readBody(req);
      // Production line changes require company_controls or GM
      if (!gm && !ownership.canAct(db, u.user.entityId, pr.ownerId, 'company_controls') && (b.prodMode !== undefined || Array.isArray(b.produces) || b.cashPerTurn !== undefined)) {
        return deny('Only the Game Master or company controller may manage the production line.');
      }
      const clampPct = (n, fallback) => Math.max(0, Math.min(100, Number.isFinite(Number(n)) ? Number(n) : fallback));
      const cleanQty = (n) => Math.round((Number(n) || 0) * 1000000) / 1000000;
      if (b.keepPct !== undefined) pr.keepPct = clampPct(b.keepPct, 0);
      if (b.wagePerTurn !== undefined) pr.wagePerTurn = Math.max(0, Math.min(1000000, cleanQty(b.wagePerTurn)));
      // workforce & safety (Phase 28): hours, safety policy, staffing and
      // upgrade investment. Hours/safety default to the owning company's
      // policy when left untouched; the employee cap is the site's own.
      if (b.workHours !== undefined && b.workHours !== 'inherit') {
        const h = Number(b.workHours);
        if (!Number.isFinite(h) || h < 0 || h > 24) return bad('Work hours must be between 0 and 24.');
        pr.workHours = Math.round(h * 100) / 100;
      } else if (b.workHours === 'inherit') delete pr.workHours;
      if (b.safety !== undefined && b.safety !== 'inherit') {
        if (!['none', 'relaxed', 'standard', 'strict'].includes(b.safety)) return bad('Invalid safety policy.');
        pr.safety = b.safety;
      } else if (b.safety === 'inherit') delete pr.safety;
      // staffing vs employee cap (Phase 28b): `employees` is CEO-set staffing
      // and may EXCEED the cap (over-staffing — more output, exponentially more
      // accident risk); `maxEmployees` is the site's permanent capacity and a
      // Game Master lever. The cap is never derived from live staffing, so a
      // layoff can never shrink it.
      if (b.maxEmployees !== undefined) {
        if (!gm) return deny('Only the Game Master may change the employee cap.');
        pr.maxEmployees = Math.max(0, Math.round(Number(b.maxEmployees) || 0));
      }
      if (b.employees !== undefined) {
        pr.employees = Math.max(0, Math.min(1000000, Math.round(Number(b.employees) || 0)));
      }
      if (b.upgradeInvest !== undefined) {
        const amt = Math.round((Number(b.upgradeInvest) || 0) * 100) / 100;
        if (!(amt >= 1)) return bad('Invest at least ' + db.settings.currency + '1.');
        const acct = sim.primaryAccount(pr.ownerId, true);
        if (!acct || acct.balance < amt) return bad('The owning account lacks the funds for this investment.');
        sim.txn(acct.id, null, amt, 'Site upgrade investment — ' + pr.name, u.user.displayName, 'withdraw');
        pr.upgradeInvested = Math.round(((pr.upgradeInvested || 0) + amt) * 100) / 100;
      }
      if (b.keepPctByItem && typeof b.keepPctByItem === 'object') {
        pr.keepPctByItem = {};
        for (const iid of Object.keys(b.keepPctByItem)) {
          if (db.items.some(i => i.id === iid)) pr.keepPctByItem[iid] = clampPct(b.keepPctByItem[iid], pr.keepPct);
        }
      }
      if (b.prodMode !== undefined) {
        if (!['none', 'goods', 'cash'].includes(b.prodMode)) return bad('Invalid property operation mode.');
        pr.prodMode = b.prodMode;
      }
      if (Array.isArray(b.produces)) {
        pr.produces = b.produces.slice(0, 32).map(row => ({
          itemId: String(row.itemId || ''), perTurn: cleanQty(row.perTurn)
        })).filter(row => row.itemId && row.perTurn >= 0 && db.items.some(i => i.id === row.itemId));
      }
      // Phase 35 supply chains — input requirements (Part 4). perUnit is
      // expressed against ONE unit of the property's primary output; the
      // engine consumes inputs from the site inventory each production hour.
      if (Array.isArray(b.requires)) {
        pr.requires = b.requires.slice(0, 32).map(row => ({
          itemId: String(row.itemId || ''), perUnit: cleanQty(row.perUnit)
        })).filter(row => row.itemId && row.perUnit >= 0 && db.items.some(i => i.id === row.itemId));
        pr.vars = pr.vars || {};
        pr.vars.supplyFulfillment = null; // recomputed on the next hourly tick
      }
      if (b.cashPerTurn !== undefined) pr.cashPerTurn = Math.max(0, cleanQty(b.cashPerTurn));
      store.log('economy', `${pr.name} adjusts operations`,
        `${pr.prodMode || 'none'} · ${pr.keepPct || 0}% kept · wages ${pr.wagePerTurn || 0} per employee/turn`, u.user.displayName, [pr.id, pr.ownerId]);
      if (b.workHours !== undefined || b.safety !== undefined || b.employees !== undefined || b.upgradeInvest !== undefined || b.maxEmployees !== undefined) {
        const wfBits = [];
        if (b.workHours !== undefined) wfBits.push(pr.workHours + 'h shifts');
        if (b.safety !== undefined) wfBits.push(pr.safety + ' safety');
        if (b.employees !== undefined) wfBits.push(pr.employees + ' staff');
        if (b.maxEmployees !== undefined) wfBits.push('cap ' + pr.maxEmployees);
        if (b.upgradeInvest !== undefined) wfBits.push('invested ' + db.settings.currency + cleanQty(b.upgradeInvest) + ' in upgrades (total ' + db.settings.currency + (pr.upgradeInvested || 0) + ')');
        store.log('economy', `${pr.name} workforce & safety`, wfBits.join(' · '), u.user.displayName, [pr.id, pr.ownerId]);
      }
      // 6f. Training spend — dampens accident odds (see sim.js TRAINING_RISK_DIV)
      if (b.trainingSpend !== undefined) {
        pr.vars = pr.vars || {};
        pr.vars.trainingSpend = Math.max(0, cleanQty(b.trainingSpend));
      }
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true, property: {
        id: pr.id, prodMode: pr.prodMode, produces: pr.produces || [], requires: pr.requires || [], cashPerTurn: pr.cashPerTurn || 0,
        keepPct: pr.keepPct, keepPctByItem: pr.keepPctByItem || {}, wagePerTurn: pr.wagePerTurn,
        workHours: pr.workHours, safety: pr.safety, maxEmployees: pr.maxEmployees,
        employees: pr.employees, upgradeInvested: pr.upgradeInvested || 0,
        workerHappiness: pr.workerHappiness, accident: pr.accident || null
      }});
    }

    // ---- Phase 35 — roster management ----
    // GET /api/entity/:id/roster — list roster entries (visibility filtered in filterState)
    const rosterGetMatch = pathname.match(/^\/api\/entity\/([\w-]+)\/roster$/);
    if (rosterGetMatch && method === 'GET') {
      const entityId = rosterGetMatch[1];
      const entity = db.entities.find(e => e.id === entityId);
      if (!entity) return bad('Unknown entity.');
      const roster = Array.isArray(entity.roster) ? entity.roster : [];
      // Members see only their own entry; owners/GM see all
      const isOwner = u.user.entityId === entityId || ownership.controls(u.user.entityId, entityId);
      const visible = (u.role.perms.gm || isOwner) ? roster : roster.filter(r => r.userId === u.user.entityId);
      return json(res, 200, { roster: visible });
    }
    // PATCH /api/entity/:id/roster — add, update, or remove roster members
    const rosterPatchMatch = pathname.match(/^\/api\/entity\/([\w-]+)\/roster$/);
    if (rosterPatchMatch && method === 'PATCH') {
      const entityId = rosterPatchMatch[1];
      const entity = db.entities.find(e => e.id === entityId);
      if (!entity) return bad('Unknown entity.');
      if (!u.role.perms.gm && !ownership.controls(u.user.entityId, entityId)) return deny('Only the owner may manage the roster.');
      const b = await readBody(req);
      entity.roster = Array.isArray(entity.roster) ? entity.roster : [];
      const VALID_SCOPES = ['all', 'company_controls', 'property_controls', 'trade', 'spend', 'campaign_minor', 'campaign_major', 'command_units', 'manage_tenders'];
      if (b.add) {
        const entry = b.add;
        if (!entry.userId || !entry.grants || !Array.isArray(entry.grants.scopes)) return bad('Roster entry needs userId and grants.scopes.');
        // Prevent adding yourself
        if (entry.userId === u.user.entityId) return bad('Cannot add yourself to the roster.');
        const existing = entity.roster.find(r => r.userId === entry.userId);
        if (existing) return bad('User already on roster. Use update instead.');
        const cleanScopes = entry.grants.scopes.filter(s => VALID_SCOPES.includes(s));
        if (!cleanScopes.length) return bad('At least one valid scope required: ' + VALID_SCOPES.join(', '));
        const member = {
          userId: entry.userId,
          title: entry.title || '',
          grants: {
            scopes: cleanScopes,
            spendLimitPerTurn: entry.grants.spendLimitPerTurn !== undefined ? Math.max(0, Number(entry.grants.spendLimitPerTurn) || 0) : null,
            properties: Array.isArray(entry.grants.properties) ? entry.grants.properties : [],
            accounts: Array.isArray(entry.grants.accounts) ? entry.grants.accounts : [],
            unitFilter: entry.grants.unitFilter || null
          },
          expiresAt: entry.expiresAt || null,
          addedBy: u.user.entityId,
          addedAt: Date.now()
        };
        entity.roster.push(member);
        store.log('roster', `${entity.name} roster member added`, `${member.title || member.userId}: ${cleanScopes.join(', ')}`, u.user.displayName, [entityId]);
      } else if (b.update) {
        const upd = b.update;
        if (!upd.userId) return bad('update needs userId.');
        const member = entity.roster.find(r => r.userId === upd.userId);
        if (!member) return bad('User not on roster.');
        if (upd.title !== undefined) member.title = upd.title;
        if (upd.grants && Array.isArray(upd.grants.scopes)) {
          member.grants.scopes = upd.grants.scopes.filter(s => VALID_SCOPES.includes(s));
        }
        if (upd.grants && upd.grants.spendLimitPerTurn !== undefined) {
          member.grants.spendLimitPerTurn = upd.grants.spendLimitPerTurn === null ? null : Math.max(0, Number(upd.grants.spendLimitPerTurn) || 0);
        }
        if (upd.grants && Array.isArray(upd.grants.properties)) member.grants.properties = upd.grants.properties;
        if (upd.grants && Array.isArray(upd.grants.accounts)) member.grants.accounts = upd.grants.accounts;
        if (upd.grants && upd.grants.unitFilter !== undefined) member.grants.unitFilter = upd.grants.unitFilter;
        if (upd.expiresAt !== undefined) member.expiresAt = upd.expiresAt;
        store.log('roster', `${entity.name} roster member updated`, `${member.title || member.userId}: ${member.grants.scopes.join(', ')}`, u.user.displayName, [entityId]);
      } else if (b.remove) {
        const idx = entity.roster.findIndex(r => r.userId === b.remove);
        if (idx >= 0) {
          const removed = entity.roster.splice(idx, 1)[0];
          store.log('roster', `${entity.name} roster member removed`, `${removed.title || removed.userId}`, u.user.displayName, [entityId]);
        }
      }
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true, roster: entity.roster });
    }

    // ---- Phase 35 — approval queue (pending requests) ----
    // GET /api/entity/:id/requests — list pending requests (ownership chain + GM only)
    const requestsGetMatch = pathname.match(/^\/api\/entity\/([\w-]+)\/requests$/);
    if (requestsGetMatch && method === 'GET') {
      const entityId = requestsGetMatch[1];
      const entity = db.entities.find(e => e.id === entityId);
      if (!entity) return bad('Unknown entity.');
      const isOwner = u.user.entityId === entityId || ownership.controls(u.user.entityId, entityId);
      if (!u.role.perms.gm && !isOwner) return deny('Only the owner may view pending requests.');
      const requests = Array.isArray(entity.pendingRequests) ? entity.pendingRequests : [];
      return json(res, 200, { requests: requests.filter(r => r.status === 'pending') });
    }
    // POST /api/entity/:id/requests/:reqId/approve — replays the request's
    // original action with the cap bypassed (that is what the approval IS),
    // then removes the request. The audit timeline keeps the permanent
    // record. A failed replay leaves the request pending for a retry.
    const approveMatch = pathname.match(/^\/api\/entity\/([\w-]+)\/requests\/([\w-]+)\/approve$/);
    if (approveMatch && method === 'POST') {
      const entityId = approveMatch[1];
      const reqId = approveMatch[2];
      const entity = db.entities.find(e => e.id === entityId);
      if (!entity) return bad('Unknown entity.');
      if (!u.role.perms.gm && !ownership.controls(u.user.entityId, entityId)) return deny('Only the owner may approve requests.');
      const req = ownership.findRequest(entity, reqId);
      if (!req) return bad('Request not found or already processed.');
      let resultNote;
      try { resultNote = executeRequestAction(db, req, u.user.displayName); }
      catch (e) { return bad('Approval could not be executed: ' + e.message); }
      ownership.approveRequest(db, entity, req, u.user.entityId);
      entity.pendingRequests = entity.pendingRequests.filter(r => r.id !== reqId);
      store.log('roster', `${entity.name} request approved${resultNote ? ' — ' + resultNote : ''}`,
        `${req.scope} — ${req.description || req.amount}`, u.user.displayName, [entityId]);
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true });
    }
    // POST /api/entity/:id/requests/:reqId/deny — removes the request; the
    // denial lives on in the audit timeline.
    const denyMatch = pathname.match(/^\/api\/entity\/([\w-]+)\/requests\/([\w-]+)\/deny$/);
    if (denyMatch && method === 'POST') {
      const entityId = denyMatch[1];
      const reqId = denyMatch[2];
      const entity = db.entities.find(e => e.id === entityId);
      if (!entity) return bad('Unknown entity.');
      if (!u.role.perms.gm && !ownership.controls(u.user.entityId, entityId)) return deny('Only the owner may deny requests.');
      const req = ownership.findRequest(entity, reqId);
      if (!req) return bad('Request not found or already processed.');
      ownership.denyRequest(db, entity, req, u.user.entityId);
      entity.pendingRequests = entity.pendingRequests.filter(r => r.id !== reqId);
      store.log('roster', `${entity.name} request denied`, `${req.scope} — ${req.description || req.amount}`, u.user.displayName, [entityId]);
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true });
    }

    // ---- 6a. Property maintenance spend ----
    // Owner/manager sets maintenanceSpend per turn; controls condition decay.
    // Charged through runEconomy's expense settlement like any other spend.
    if (pathname.match(/^\/api\/property\/[\w-]+\/maintenance$/) && method === 'POST') {
      const propId = pathname.split('/')[3];
      const pr = db.properties.find(p => p.id === propId);
      if (!pr) return bad('No such property.');
      if (!u.role.perms.gm && !ownership.canAct(db, u.user.entityId, pr.ownerId, 'property_controls', { propertyId: pr.id })) return deny('No permission.');
      const b = await readBody(req);
      const spend = Math.max(0, Number(b.maintenanceSpend) || 0);
      pr.vars = pr.vars || {};
      pr.vars.maintenanceSpend = spend;
      store.log('economy', `${pr.name} maintenance set`, `${db.settings.currency}${spend}/turn`, u.user.displayName, [pr.id]);
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true, maintenanceSpend: spend, condition: pr.vars.condition });
    }

    // ---- 6d. Government tenders ----
    // Open a tender: GM or a manage_tenders grantee on the opener entity.
    if (pathname === '/api/tenders' && method === 'POST') {
      const b = await readBody(req);
      const openerEntityId = String(b.openerEntityId || 'ent_gov');
      if (!db.entities.some(e => e.id === openerEntityId)) return bad('Unknown opener entity.');
      if (!u.role.perms.gm && !ownership.canAct(db, u.user.entityId, openerEntityId, 'manage_tenders')) return deny('No permission to open tenders.');
      const itemId = String(b.itemId || '');
      if (!db.items.some(i => i.id === itemId)) return bad('Unknown item.');
      const qtyWanted = Math.round(Number(b.qtyWanted) || 0);
      if (!(qtyWanted > 0)) return bad('Quantity wanted must be positive.');
      db.tenders = Array.isArray(db.tenders) ? db.tenders : [];
      const tender = sim.createTenderObj(db, {
        itemId, qtyWanted,
        deadlineHours: b.deadlineHours,
        openerEntityId, openedBy: u.user.displayName,
        title: String(b.title || '').slice(0, 120),
      });
      db.tenders.push(tender);
      const item = db.items.find(x => x.id === itemId);
      store.log('economy', `Tender opened: ${item ? item.name : itemId}`,
        `${qtyWanted} units wanted · bids close in ${Math.round((tender.deadlineWorldMs - cadence.currentWorldMs(db)) / 3600000)}h`, u.user.displayName, [openerEntityId]);
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true, tender });
    }
    // Bid on an open tender through a company/entity you control.
    const bidMatch = pathname.match(/^\/api\/tenders\/([\w-]+)\/bids$/);
    if (bidMatch && method === 'POST') {
      const tender = (db.tenders || []).find(t => t.id === bidMatch[1]);
      if (!tender || tender.status !== 'open') return bad('Tender is not open.');
      if (cadence.currentWorldMs(db) >= tender.deadlineWorldMs) return bad('The bidding deadline has passed.');
      const b = await readBody(req);
      const entityId = String(b.entityId || '');
      if (!entityId) return bad('Choose which company is bidding.');
      if (!u.role.perms.gm && !ownership.controls(u.user.entityId, entityId)) return deny('You do not control that entity.');
      const price = Math.round(Number(b.price) * 100) / 100;
      if (!(price > 0)) return bad('Bid price must be positive.');
      tender.bids = Array.isArray(tender.bids) ? tender.bids : [];
      const existing = tender.bids.find(x => x.entityId === entityId);
      if (existing) { existing.price = price; existing.submittedAt = Date.now(); }
      else tender.bids.push({ entityId, price, submittedAt: Date.now() });
      const ent = db.entities.find(e => e.id === entityId);
      store.log('economy', `Tender bid: ${tender.title || tender.itemId}`,
        `${ent ? ent.name : entityId} bids ${db.settings.currency}${price}/unit`, u.user.displayName, [tender.openerEntityId, entityId]);
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true, tender });
    }
    // Close a tender immediately (opener chain / GM); award happens on the
    // next cadence pass otherwise.
    const closeMatch = pathname.match(/^\/api\/tenders\/([\w-]+)\/close$/);
    if (closeMatch && method === 'POST') {
      const tender = (db.tenders || []).find(t => t.id === closeMatch[1]);
      if (!tender || tender.status !== 'open') return bad('Tender is not open.');
      if (!u.role.perms.gm && !ownership.canAct(db, u.user.entityId, tender.openerEntityId, 'manage_tenders')) return deny('No permission to close this tender.');
      tender.deadlineWorldMs = cadence.currentWorldMs(db); // due now
      sim.closeDueTenders(db, u.user.displayName);
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true, tender });
    }

    // ---- negotiated trade offers (Phase 4.3) ----
    // Instant transfers (above) move goods immediately; these are proposals
    // ---- war bonds (Phase 25) ----
    // Float a series: whoever CONTROLS the government (President, or GM) mints
    // `count` certificates as a tradable Securities item priced at `price`,
    // paying `faceValue` per certificate `maturityTurns` turns out. Redemption
    // is automatic in sim.redeemMaturedBonds during the turn loop.
    if (pathname === '/api/gov/bonds' && method === 'POST') {
      const b = await readBody(req);
      if (!u.role.perms.gm && !ownership.controls(u.user.entityId, 'ent_gov')) return deny('Only the government may float a bond issue.');
      const face = Math.round(Number(b.faceValue) || 0);
      const price = Math.round(Number(b.price) || 0);
      const count = Math.round(Number(b.count) || 0);
      const maturityTurns = Math.round(Number(b.maturityTurns) || 0);
      if (!(face > 0) || !(price > 0) || !(count > 0 && count <= 1e6) || !(maturityTurns > 0 && maturityTurns <= 3650)) {
        return bad('A bond issue needs a positive face value, sale price, certificate count and maturity (in turns).');
      }
      const turn = db.settings.time.turn;
      const series = String.fromCharCode(65 + (db.items.filter(i => i.meta && i.meta.bond).length % 26));
      const item = {
        id: store.uid('item'), icon: 'B',
        name: `War Bond Series ${series} (T${turn + maturityTurns})`,
        category: 'Securities', tradable: true, marketValue: price,
        meta: { bond: { faceValue: face, maturityTurn: turn + maturityTurns, issuerId: 'ent_gov' } },
        description: `Government bond: pays ${db.settings.currency}${face.toLocaleString('en-US')} per certificate at turn ${turn + maturityTurns}. Floated at ${db.settings.currency}${price.toLocaleString('en-US')}.`
      };
      db.items.push(item);
      const gov = db.entities.find(e => e.id === 'ent_gov');
      gov.inventory = gov.inventory || [];
      gov.inventory.push({ qty: count, itemId: item.id });
      store.log('economy', 'War bond issue floated', `${count.toLocaleString('en-US')} certificates of ${item.name}.`, u.user.displayName, ['ent_gov']);
      sim.draftNews(`TREASURY FLOATS ${item.name.toUpperCase()}`,
        `The government has opened subscriptions for ${count.toLocaleString('en-US')} war bond certificates at ${db.settings.currency}${price.toLocaleString('en-US')} each, redeeming at ${db.settings.currency}${face.toLocaleString('en-US')} in ${maturityTurns} turns. Patriotism now pays interest.`, 'Economy', true, 'State Financial Desk');
      store.save(); broadcast('sync');
      return json(res, 200, { item });
    }
    // Subscribe to an open issue: cash to the issuer, certificates to you.
    if (pathname === '/api/gov/bonds/buy' && method === 'POST') {
      const b = await readBody(req);
      const item = db.items.find(i => i.id === b.itemId && i.meta && i.meta.bond);
      if (!item) return bad('Unknown bond series.');
      if (item.meta.bond.redeemed) return bad('That series has already matured.');
      const qty = Math.round(Number(b.qty) || 0);
      if (!(qty > 0)) return bad('Quantity must be positive.');
      const buyerId = u.user.entityId;
      if (!buyerId) return bad('No entity is linked to your operator.');
      if (buyerId === (item.meta.bond.issuerId || 'ent_gov')) return bad('The issuer cannot subscribe to its own bonds.');
      const gov = db.entities.find(e => e.id === (item.meta.bond.issuerId || 'ent_gov'));
      const row = gov && (gov.inventory || []).find(r => r.itemId === item.id);
      if (!row || row.qty < qty) return bad('Not enough certificates remain in the issue.');
      const cost = Math.round(item.marketValue * qty * 100) / 100;
      const buyerAcct = sim.primaryAccount(buyerId, true);
      if (!u.role.perms.gm && buyerAcct.balance < cost) return bad('Insufficient funds.');
      sim.txn(buyerAcct.id, sim.primaryAccount(gov.id, true).id, cost, `Subscription: ${qty} × ${item.name}`, u.user.displayName, 'transfer');
      row.qty -= qty;
      if (row.qty <= 0) gov.inventory = gov.inventory.filter(r => r !== row);
      const buyer = db.entities.find(e => e.id === buyerId);
      buyer.inventory = buyer.inventory || [];
      const brow = buyer.inventory.find(r => r.itemId === item.id);
      if (brow) brow.qty += qty; else buyer.inventory.push({ qty, itemId: item.id });
      store.log('economy', `${buyer.name} subscribes to ${item.name}`, `${qty} certificate(s) for ${db.settings.currency}${cost.toLocaleString('en-US')}.`, u.user.displayName, [buyerId, 'ent_gov']);
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true, cost, qty });
    }

    // ---- journalist investigation (Phase 25 QoL — scoops) ----
    // Once per turn a credentialed journalist can work their sources and get
    // a DRAFT article revealing something the public state doesn't show:
    // a company's true books, the invader's war-room posture, the real
    // treasury balance. The draft lands in their own paper, ready to edit.
    if (pathname === '/api/press/investigate' && method === 'POST') {
      if (!u.role.perms.manageNews) return deny('Press credentials required.');
      const turn = db.settings.time.turn;
      if ((u.user.lastInvestigateTurn ?? -1) >= turn) return bad('You have already worked your sources this turn — file again after the next turn.');
      const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
      const scoops = [];
      const cos = db.entities.filter(e => e.type === 'company');
      if (cos.length) {
        const c = cos[Math.floor(Math.random() * cos.length)];
        const profit = c.vars && (c.vars.lastProfit !== undefined ? c.vars.lastProfit : c.vars.profit);
        scoops.push({
          headline: `THE BOOKS AT ${String(c.name).toUpperCase()}`,
          body: `Documents passed to this desk show ${c.name} closed the last period ` +
            (profit !== undefined ? `with a net position of ${db.settings.currency}${fmt(profit)}. ` : 'in a state its directors would prefer stayed private. ') +
            `Market confidence stands at ${Math.round(c.confidence || 50)}, and the register lists ${(c.shareholders || []).length} holders of record.`
        });
      }
      if (db.war && db.war.active) {
        // The invader's National Command (war.command — see war-ai.js);
        // legacy flat war.ai for a pre-hierarchy doc still in flight.
        const natt = db.war.command && db.war.command.att && db.war.command.att.nations
          && db.war.command.att.nations[db.war.attackerId];
        const brain = natt || db.war.ai;
        if (brain) {
          const lastNote = (brain.notes || []).slice(-1)[0];
          scoops.push({
            headline: 'INSIDE THE INVADER’S WAR ROOM',
            body: `Sources close to the front say the invading command has entered its “${brain.phase}” posture.` +
              (lastNote ? ` A staff note passed to this paper reads: “${lastNote.text}”` : '')
          });
        }
      }
      const tre = db.accounts.find(a => a.id === 'acct_treasury');
      if (tre) {
        scoops.push({
          headline: 'WHAT THE TREASURY REALLY HOLDS',
          body: `A source inside the Finance Ministry puts the true federal balance at ${db.settings.currency}${fmt(tre.balance)} — a figure the government has never published.`
        });
      }
      if (!scoops.length) return bad('Your sources have nothing tonight.');
      // The once-per-turn token is only consumed when a scoop is actually
      // drafted — burning it before the bail-out wasted the turn on a 400
      // (and cloud mode commits even rejected responses).
      u.user.lastInvestigateTurn = turn;
      const scoop = scoops[Math.floor(Math.random() * scoops.length)];
      const article = sim.draftNews(scoop.headline, scoop.body, 'Politics', false, u.user.displayName, u.user.newspaperId || undefined);
      store.save(); broadcast('sync');
      return json(res, 200, { article });
    }

    // that sit in db.trades until the counterparty accepts/declines, or the
    // creator cancels. Nothing is escrowed — balances/inventories are only
    // checked (and moved) at accept time.
    if (pathname === '/api/trades' && method === 'POST') {
      const b = await readBody(req);
      const gm = u.role.perms.gm;
      // controllers may offer from any entity in their chain; the controls
      // check below enforces it for non-GM users
      const fromEntityId = b.fromEntityId || u.user.entityId;
      const fromEnt = db.entities.find(e => e.id === fromEntityId);
      const toEnt = db.entities.find(e => e.id === b.toEntityId);
      if (!fromEnt || !toEnt) return bad('Unknown entity.');
      if (fromEnt.id === toEnt.id) return bad('Cannot trade with yourself.');
      if (!gm && !ownership.controls(u.user.entityId, fromEnt.id)) return deny('You do not control that entity.');
      const cleanRows = (arr) => (Array.isArray(arr) ? arr : [])
        .map(r => ({ itemId: String(r.itemId || ''), qty: cleanQty(r.qty) }))
        .filter(r => {
          if (!r.itemId || !(r.qty > 0)) return false;
          const item = db.items.find(i => i.id === r.itemId);
          if (!item) return false;
          // Same rules as the instant /api/trade route — an untradable or
          // leveraged row used to sail through creation and detonate at
          // accept time, mid-move.
          if (item.meta && item.meta.leveraged) return false;
          if (!item.tradable && !gm) return false;
          return true;
        });
      const give = cleanRows(b.give);
      const get = cleanRows(b.get);
      const money = { give: Math.max(0, Number((b.money || {}).give) || 0), get: Math.max(0, Number((b.money || {}).get) || 0) };
      if (!give.length && !get.length && !money.give && !money.get) return bad('An offer needs at least one item or amount of money.');
      const trade = {
        id: store.uid('trade'), fromEntityId: fromEnt.id, toEntityId: toEnt.id,
        give, get, money, memo: String(b.memo || '').slice(0, 240),
        status: 'open', ts: Date.now(), turn: db.settings.time.turn
      };
      db.trades = db.trades || [];
      db.trades.push(trade);
      store.log('ownership', `Trade offer sent`, `${fromEnt.name} → ${toEnt.name}${trade.memo ? ' · ' + trade.memo : ''}`, u.user.displayName, [fromEnt.id, toEnt.id]);
      store.save(); broadcast('sync');
      return json(res, 200, { trade });
    }
    let m = pathname.match(/^\/api\/trades\/([\w-]+)\/(accept|decline|cancel)$/);
    if (m) {
      const trade = (db.trades || []).find(t => t.id === m[1]);
      if (!trade) return bad('No such trade offer.');
      const action = m[2];
      const gm = u.role.perms.gm;
      if (trade.status !== 'open') return bad('That offer is no longer open.');
      const fromEnt = db.entities.find(e => e.id === trade.fromEntityId);
      const toEnt = db.entities.find(e => e.id === trade.toEntityId);
      if (!fromEnt || !toEnt) return bad('A party to this trade no longer exists.');

      if (action === 'cancel') {
        if (!gm && !ownership.controls(u.user.entityId, trade.fromEntityId)) return deny('Only the offering party may cancel this trade.');
        trade.status = 'cancelled';
        store.log('ownership', 'Trade offer cancelled', `${fromEnt.name} → ${toEnt.name}`, u.user.displayName, [fromEnt.id, toEnt.id]);
        store.save(); broadcast('sync');
        return json(res, 200, { trade });
      }
      if (action === 'decline') {
        if (!gm && !ownership.controls(u.user.entityId, trade.toEntityId)) return deny('Only the receiving party may decline this trade.');
        trade.status = 'declined';
        store.log('ownership', 'Trade offer declined', `${toEnt.name} declined an offer from ${fromEnt.name}`, u.user.displayName, [fromEnt.id, toEnt.id]);
        store.save(); broadcast('sync');
        return json(res, 200, { trade });
      }

      // accept — validate everything before mutating anything
      if (!gm && !ownership.controls(u.user.entityId, trade.toEntityId)) return deny('Only the receiving party may accept this trade.');
      // Aggregate demand per item: two rows for the same item must not
      // individually pass a stock check that their SUM fails (the second
      // moveItem used to throw mid-trade with earlier rows already moved).
      const needBy = (rows) => {
        const need = {};
        for (const r of rows) need[r.itemId] = cleanQty((need[r.itemId] || 0) + r.qty);
        return need;
      };
      const giveNeed = needBy(trade.give), getNeed = needBy(trade.get);
      // Pre-flight every row's ROUTING too — moveItem throws on leveraged /
      // unroutable rows, and a mid-loop throw left earlier rows moved with no
      // compensation (file mode persisted the half-applied trade on the next
      // successful request's save).
      const routingProblem = (fromE, itemId, qty) => {
        const item = db.items.find(i => i.id === itemId);
        if (!item) return 'Unknown item.';
        if (item.meta && item.meta.leveraged) return 'Leveraged positions cannot be traded — sell them back through the exchange.';
        if (!item.tradable && !u.role.perms.gm) return `${item.name} is not tradable.`;
        if (item.meta && item.meta.companyId) {
          const co = db.entities.find(e => e.id === item.meta.companyId);
          if (!co || co.type !== 'company') return 'The issuing company no longer exists.';
          if (market.holdingOf(co, fromE.id) < qty) return `${fromE.name} holds fewer registered shares than the offer needs.`;
          return null; // register is authoritative for certificates
        }
        if (item.meta && item.meta.propertyId) {
          const prop = db.properties.find(p => p.id === item.meta.propertyId);
          if (!prop) return 'That deed’s property no longer exists.';
          if (prop.ownerId !== fromE.id) return 'Only the property’s owner may convey its deed.';
          return null; // deeds are qty-1 by construction
        }
        return null; // plain items: stock checked below
      };
      { // stock + routing checks for BOTH directions before any mutation
        for (const [ent, need] of [[fromEnt, giveNeed], [toEnt, getNeed]]) {
          for (const itemId of Object.keys(need)) {
            const item = db.items.find(i => i.id === itemId);
            const prob = routingProblem(ent, itemId, need[itemId]);
            if (prob) return bad(prob);
            if (item && item.meta && (item.meta.companyId || item.meta.propertyId)) continue;
            const row = (ent.inventory || []).find(r => r.itemId === itemId);
            if (!row || row.qty < need[itemId]) return bad(`${ent.name} no longer holds enough ${(item || {}).name || itemId}.`);
          }
        }
      }
      const fromAcct = sim.primaryAccount(fromEnt.id, false);
      const toAcct = sim.primaryAccount(toEnt.id, false);
      if (trade.money.give > 0 && !gm && (!fromAcct || fromAcct.balance < trade.money.give)) return bad(`${fromEnt.name} has insufficient funds.`);
      if (trade.money.get > 0 && !gm && (!toAcct || toAcct.balance < trade.money.get)) return bad(`${toEnt.name} has insufficient funds.`);

      const moveItem = (fromE, toE, itemId, qty) => {
        const item = db.items.find(i => i.id === itemId);
        if (item && item.meta && item.meta.leveraged) throw new Error('Leveraged positions cannot be traded — sell them back through the exchange.');
        if (item && item.meta && item.meta.companyId) { market.transfer(item.meta.companyId, fromE.id, toE.id, qty, u.user.displayName); return; }
        if (item && item.meta && item.meta.propertyId) { deeds.transfer(item.meta.propertyId, fromE.id, toE.id, u.user.displayName); return; }
        fromE.inventory = fromE.inventory || [];
        const row = fromE.inventory.find(r => r.itemId === itemId);
        row.qty -= qty;
        fromE.inventory = fromE.inventory.filter(r => r.qty > 0);
        toE.inventory = toE.inventory || [];
        const trow = toE.inventory.find(r => r.itemId === itemId);
        if (trow) trow.qty += qty; else toE.inventory.push({ itemId, qty });
      };
      for (const r of trade.give) moveItem(fromEnt, toEnt, r.itemId, r.qty);
      for (const r of trade.get) moveItem(toEnt, fromEnt, r.itemId, r.qty);
      if (trade.money.give > 0) sim.txn(sim.primaryAccount(fromEnt.id, true).id, sim.primaryAccount(toEnt.id, true).id, trade.money.give, trade.memo || 'Trade settlement', u.user.displayName, 'transfer');
      if (trade.money.get > 0) sim.txn(sim.primaryAccount(toEnt.id, true).id, sim.primaryAccount(fromEnt.id, true).id, trade.money.get, trade.memo || 'Trade settlement', u.user.displayName, 'transfer');

      // Workstream A5 — P2P re-mark. A share certificate traded for money moves
      // the public quote (implied price = money / shares, clamped ±25%). Only
      // re-mark when a single company's cert sits opposite the cash, so a bundle
      // trade doesn't produce a garbage implied price.
      try {
        const certGive = {}, certGet = {};
        for (const r of trade.give) { const it = db.items.find(i => i.id === r.itemId); if (it && it.meta && it.meta.companyId) certGive[it.meta.companyId] = (certGive[it.meta.companyId] || 0) + r.qty; }
        for (const r of trade.get) { const it = db.items.find(i => i.id === r.itemId); if (it && it.meta && it.meta.companyId) certGet[it.meta.companyId] = (certGet[it.meta.companyId] || 0) + r.qty; }
        const giveCos = Object.keys(certGive), getCos = Object.keys(certGet);
        if (giveCos.length === 1 && trade.money.get > 0) market.remarkFromTrade(giveCos[0], trade.money.get, certGive[giveCos[0]], u.user.displayName);
        if (getCos.length === 1 && trade.money.give > 0) market.remarkFromTrade(getCos[0], trade.money.give, certGet[getCos[0]], u.user.displayName);
      } catch (e) { /* re-mark is best-effort; never blocks a settled trade */ }

      trade.status = 'accepted';
      store.log('ownership', 'Trade offer accepted', `${fromEnt.name} ⇄ ${toEnt.name}${trade.memo ? ' · ' + trade.memo : ''}`, u.user.displayName, [fromEnt.id, toEnt.id]);
      store.save(); broadcast('sync');
      return json(res, 200, { trade });
    }

    // ---- owner-level entity editing (descriptive fields only) ----
    m = pathname.match(/^\/api\/entity\/([\w-]+)$/);
    if (m && method === 'PATCH') {
      const target = db.entities.find(e => e.id === m[1]);
      if (!target) return bad('No such entity.');
      const isGm = u.role.perms.gm;
      if (!isGm && !ownership.controls(u.user.entityId, target.id)) return deny('You do not control this entity.');
      const b = await readBody(req);
      const FIELDS = ['description', 'color', 'logo'];
      let changed = false;
      for (const k of FIELDS) {
        if (b[k] !== undefined) { target[k] = String(b[k]).slice(0, k === 'description' ? 4000 : 400); changed = true; }
      }
      if (!changed) return bad('No editable fields supplied.');
      store.log('gm', `Updated ${target.name || target.id}`, 'Description/appearance edited by owner.', u.user.displayName, [target.id]);
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true, entity: target });
    }

    // ---- CEO / owner company controls (Phase 15) ----
    // keepPct — % of production held back as company stock (the rest sells on
    // the domestic market) — and direct wages per employee per turn. Goods held as stock are traded
    // on the open market or via trade offers. Editable by the company's
    // controller (CEO or owner chain) or GM.
    m = pathname.match(/^\/api\/company\/([\w-]+)\/controls$/);
    if (m && method === 'PATCH') {
      const co = db.entities.find(e => e.id === m[1] && e.type === 'company');
      if (!co) return bad('No such company.');
      const gm = u.role.perms.gm;
      // Phase 35: use canAct with company_controls scope
      if (!gm && !ownership.canAct(db, u.user.entityId, co.id, 'company_controls')) {
        return deny('You do not control this company.');
      }
      const b = await readBody(req);
      const clampPct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
      const clampWage = (n) => Math.max(0, Math.min(1000000, Math.round((Number(n) || 0) * 100) / 100));
      if (b.keepPct !== undefined) co.keepPct = clampPct(b.keepPct);
      if (b.wagePerTurn !== undefined) co.wagePerTurn = clampWage(b.wagePerTurn);
      if (b.keepPctByItem && typeof b.keepPctByItem === 'object') {
        co.keepPctByItem = {};
        for (const iid of Object.keys(b.keepPctByItem)) co.keepPctByItem[iid] = clampPct(b.keepPctByItem[iid]);
      }
      // workforce policy defaults (Phase 28) — every property of this company
      // inherits these unless it carries its own override:
      if (b.workHours !== undefined) {
        const h = Number(b.workHours);
        if (!Number.isFinite(h) || h < 0 || h > 24) return bad('Work hours must be between 0 and 24.');
        co.workHours = Math.round(h * 100) / 100;
      }
      if (b.safety !== undefined) {
        if (!['none', 'relaxed', 'standard', 'strict'].includes(b.safety)) return bad('Invalid safety policy.');
        co.safety = b.safety;
      }
      // company-wide staffing: every site is (re)staffed to this share of its
      // own capacity. Rounded server-side; the desk mirrors the exact rows.
      // Phase 28b: past 100% the company over-staffs every site (linear extra
      // output, exponentially likelier accidents).
      let staffed = null;
      if (b.staffingPct !== undefined) {
        const pct = Math.max(0, Math.min(200, Math.round(Number(b.staffingPct) || 0)));
        staffed = [];
        for (const pr2 of db.properties) {
          if (pr2.ownerId !== co.id) continue;
          const cap = pr2.maxEmployees !== undefined ? Math.max(0, Math.round(pr2.maxEmployees)) : Math.max(1, Math.round(pr2.employees || 1));
          pr2.employees = Math.round(cap * pct / 100);
          staffed.push({ id: pr2.id, employees: pr2.employees });
        }
      }
      store.log('economy', `${co.name} adjusts operations`,
        `keep ${co.keepPct || 0}% in stock · wages ${co.wagePerTurn || 0} per employee/turn` +
        (b.workHours !== undefined || b.safety !== undefined || b.staffingPct !== undefined
          ? ` · ${co.workHours}h shifts · ${co.safety} safety${b.staffingPct !== undefined ? ' · staffed to ' + (b.staffingPct === 200 ? 200 : Math.min(200, Math.max(0, Math.round(Number(b.staffingPct) || 0)))) + '% of capacity' : ''}`
          : ''), u.user.displayName, [co.id]);
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true, company: {
        id: co.id, keepPct: co.keepPct, keepPctByItem: co.keepPctByItem || {}, wagePerTurn: co.wagePerTurn,
        workHours: co.workHours, safety: co.safety, staffed
      } });
    }

    // ---- government trade tariffs (Phase 16) ----
    // The President (controls the government) or GM sets import/export tariffs:
    // a global baseline plus additive per-country and per-company surcharges.
    // Collected into the treasury by sim.executeTrade. Body: { tariffs }.
    if (pathname === '/api/trade/tariffs' && method === 'PATCH') {
      const gm = u.role.perms.gm;
      if (!gm && !ownership.controls(u.user.entityId, 'ent_gov')) return deny('Only the government may set tariffs.');
      const b = await readBody(req);
      db.settings.trade = db.settings.trade || {};
      db.settings.trade.tariffs = sanitizeTariffs(b.tariffs || {});
      store.log('economy', 'Government tariff schedule updated',
        `global import ${db.settings.trade.tariffs.global.import}% · export ${db.settings.trade.tariffs.global.export}%`, u.user.displayName, ['ent_gov']);
      store.save(); broadcast('sync');
      return json(res, 200, { tariffs: db.settings.trade.tariffs });
    }

    // ---- open-market trade execution (Phase 15) ----
    // Fill part of a foreign partner's procedurally generated order. side
    // 'sell' exports the holder's stock into a foreign BUY order; side 'buy'
    // imports from a foreign SELL order. The government trades from the
    // national stockpile through the treasury (President/GM); a company trades
    // its own stock through its account (controller/GM). Volume moves the
    // price against the trader (see sim.executeTrade).
    if (pathname === '/api/trade/execute' && method === 'POST') {
      const b = await readBody(req);
      const side = b.side === 'buy' ? 'buy' : 'sell';
      const holder = db.entities.find(e => e.id === b.holderId);
      if (!holder) return bad('Unknown holder.');
      const gm = u.role.perms.gm;
      if (!gm && !ownership.controls(u.user.entityId, holder.id)) return deny('You do not control that holder.');
      try {
        const r = sim.executeTrade(side, String(b.orderId || ''), holder.id, b.qty, u.user.displayName);
        store.save(); broadcast('sync');
        return json(res, 200, r);
      } catch (e) { return bad(e.message); }
    }

    // ---- food release from national stockpile to provinces ----
    // The government (or anyone with GM perms) can release staple food from
    // the national stockpile (gov.inventory) to specific provinces, or all
    // provinces equally. Body: { itemId, qty, provinceIds? }.
    if (pathname === '/api/food/release' && method === 'POST') {
      const gm = u.role.perms.gm;
      if (!gm && !ownership.controls(u.user.entityId, 'ent_gov')) return deny('Only the government may release food.');
      const b = await readBody(req);
      try {
        const hh = require('./households');
        const r = hh.releaseFood(db, b.itemId, b.qty, b.provinceIds, u.user.displayName);
        store.save(); broadcast('sync');
        return json(res, 200, r);
      } catch (e) { return bad(e.message); }
    }

    // ---- ongoing trade contracts ----
    // Automate open-market fills: every turn the engine re-fills whichever
    // order matches partner + item + side through sim.executeTrade (identical
    // pricing/tariff/embargo/stock rules as a manual fill), for a chosen
    // number of turns or until cancelled. Creation mirrors /api/trade/execute's
    // permission model — only the holder entity's controller may sign.
    if (pathname === '/api/trade/contracts' && method === 'POST') {
      const b = await readBody(req);
      const gm = u.role.perms.gm;

      // ---- player-to-player / party-to-party recurring transfer ----
      // A standing trade that re-executes every turn until it expires or a
      // party cancels. Uses the SAME give/get/money shape as /api/trades
      // (negotiated trade offers), so contracts are simply "trades that repeat".
      // Back-compat: legacy single-item fields (itemId/qtyPerTurn/payByFrom/
      // payByTo) are still honoured and normalized into give/money.
      // Certificates/deeds/leveraged items are refused outright: they are
      // canonical-record mirrors that must move one-shot through
      // market.transfer / deeds.transfer.
      // The counterparty consents once: unless the creator controls BOTH ends
      // (or is GM), the contract starts 'proposed' and activates on accept.
      if (b.kind === 'transfer') {
        const fromEnt = db.entities.find(e => e.id === b.fromEntityId);
        const toEnt = db.entities.find(e => e.id === b.toEntityId);
        if (!fromEnt || !toEnt) return bad('Unknown entity.');
        if (!gm && !ownership.controls(u.user.entityId, fromEnt.id)) return deny('You do not control the offering entity.');
        if (fromEnt.id === toEnt.id) return bad('Cannot contract with yourself.');

        // Normalise into the trade shape: give[], get[], money{give,get}
        let give = [], get = [], money = { give: 0, get: 0 };
        const hasNewShape = Array.isArray(b.give) || Array.isArray(b.get) || (b.money && typeof b.money === 'object');
        if (hasNewShape) {
          const cleanRows = (arr) => (Array.isArray(arr) ? arr : [])
            .map(r => ({ itemId: String(r.itemId || ''), qty: cleanQty(r.qty) }))
            .filter(r => r.itemId && r.qty > 0);
          give = cleanRows(b.give);
          get = cleanRows(b.get);
          money = {
            give: Math.max(0, Math.round((Number((b.money || {}).give) || 0) * 100) / 100),
            get: Math.max(0, Math.round((Number((b.money || {}).get) || 0) * 100) / 100)
          };
          // Validate each row's routing (same checks as /api/trades creation)
          for (const r of [...give, ...get]) {
            const it = db.items.find(i => i.id === r.itemId);
            if (!it) return bad('Unknown item: ' + r.itemId);
            if (it.meta && it.meta.leveraged) return bad('Leveraged positions cannot be transferred — sell them back through the exchange.');
            if (it.meta && (it.meta.companyId || it.meta.propertyId)) return bad('Certificates and deeds must move one-shot through a trade offer or instant send.');
            if (!it.tradable && !gm) return deny(`${it.name} is not tradable.`);
          }
        } else if (b.itemId) {
          // Legacy single-item contract → normalize to give + money
          const item = db.items.find(i => i.id === b.itemId);
          if (!item) return bad('Unknown item.');
          if (!item.tradable && !gm) return deny('That item is not tradable.');
          if (item.meta && item.meta.leveraged) return bad('Leveraged positions cannot be transferred — sell them back through the exchange.');
          if (item.meta && (item.meta.companyId || item.meta.propertyId)) return bad('Certificates and deeds must move one-shot through a trade offer or instant send.');
          const qty = cleanQty(b.qtyPerTurn);
          if (!(qty > 0)) return bad('Quantity per turn must be positive.');
          const r2m = (v) => Math.round(Number(v) * 100) / 100;
          let payByFrom = r2m(b.payByFrom);
          let payByTo = r2m(b.payByTo);
          if (!isFinite(payByFrom) || payByFrom < 0) payByFrom = 0;
          if (!isFinite(payByTo) || payByTo < 0) payByTo = 0;
          give = [{ itemId: item.id, qty }];
          money = { give: payByFrom, get: payByTo };
        } else {
          // Also accept the old qtyPerTurn style without explicit kind distinction
          return bad('A contract needs at least one item or amount of money.');
        }
        if (!give.length && !get.length && !money.give && !money.get) return bad('An offer needs at least one item or amount of money.');
        // Aggregate duplicate item rows for cleaner storage / execution
        const agg = (rows) => {
          const m = {};
          for (const r of rows) m[r.itemId] = cleanQty((m[r.itemId] || 0) + r.qty);
          return Object.entries(m).map(([itemId, qty]) => ({ itemId, qty }));
        };
        give = agg(give);
        get = agg(get);

        let dur = null; // null = until cancelled
        if (b.durationTurns !== undefined && b.durationTurns !== null && b.durationTurns !== '') {
          dur = Math.floor(Number(b.durationTurns));
          if (!isFinite(dur) || dur < 1) return bad('Duration must be at least 1 turn, or run indefinitely.');
          if (dur > 9999) dur = 9999;
        }
        const memo = String(b.memo || '').slice(0, 300);
        const counterpartySigns = !gm && !ownership.controls(u.user.entityId, toEnt.id);
        db.tradeContracts = db.tradeContracts || [];
        const t = db.settings.time;
        const c = {
          id: store.uid('ctr'), kind: 'transfer',
          fromEntityId: fromEnt.id, toEntityId: toEnt.id,
          give, get, money, memo,
          // legacy fields kept for old clients / migration transparency
          ...(give.length === 1 && !get.length ? { itemId: give[0].itemId, qtyPerTurn: give[0].qty, payByFrom: money.give, payByTo: money.get } : {}),
          turnsLeft: dur, startedTurn: t.turn,
          executions: 0, totalQty: 0, totalValue: 0, lastUnit: null, lastTurnNote: null,
          status: counterpartySigns ? 'proposed' : 'active',
          createdBy: u.user.displayName, createdAt: Date.now()
        };
        db.tradeContracts.push(c);
        const fmtGive = give.length ? give.map(r => {
          const it = db.items.find(i => i.id === r.itemId);
          return `${r.qty} × ${(it || {}).name || r.itemId}`;
        }).join(', ') : '';
        const fmtGet = get.length ? get.map(r => {
          const it = db.items.find(i => i.id === r.itemId);
          return `${r.qty} × ${(it || {}).name || r.itemId}`;
        }).join(', ') : '';
        store.log('economy', counterpartySigns ? 'Ongoing contract proposed' : 'Ongoing contract signed',
          `${fromEnt.name} → ${toEnt.name}` +
          (fmtGive ? `: gives ${fmtGive}` : '') +
          (fmtGet ? `${fmtGive ? '; ' : ': '}gets ${fmtGet}` : '') +
          (money.give ? ` · pays ${db.settings.currency}${money.give}/turn` : '') +
          (money.get ? ` · rebated ${db.settings.currency}${money.get}/turn` : '') +
          `${memo ? ' · ' + memo : ''}` +
          (dur ? ` · runs ${dur} turn${dur === 1 ? '' : 's'}` : ' · until cancelled'),
          u.user.displayName, [fromEnt.id, toEnt.id]);
        store.save(); broadcast('sync');
        return json(res, 200, { contract: c });
      }

      // ---- open-market order automation ----
      const side = b.side === 'buy' ? 'buy' : 'sell';
      const holder = db.entities.find(e => e.id === b.holderId);
      if (!holder) return bad('Unknown holder.');
      if (!gm && !ownership.controls(u.user.entityId, holder.id)) return deny('You do not control that holder.');
      const partner = db.entities.find(e => e.id === b.partnerId);
      if (!partner) return bad('Unknown trading partner.');
      const item = db.items.find(i => i.id === b.itemId);
      if (!item || item.tradable === false) return bad('Unknown or untradable item.');
      const tradeCfg = db.settings.trade || {};
      if (!(tradeCfg.partners || []).some(p => p.entityId === partner.id)) return bad(partner.name + ' is not an active trade partner.');
      let qty = Number(b.qtyPerTurn);
      if (!isFinite(qty)) qty = 0;
      qty = Math.round(qty * 1000000) / 1000000;
      if (!(qty > 0)) return bad('Quantity per turn must be positive.');
      let dur = null; // null = until cancelled
      if (b.durationTurns !== undefined && b.durationTurns !== null && b.durationTurns !== '') {
        dur = Math.floor(Number(b.durationTurns));
        if (!isFinite(dur) || dur < 1) return bad('Duration must be at least 1 turn, or run indefinitely.');
        if (dur > 9999) dur = 9999;
      }
      // refuse contracts that can never fire: an embargoed direction is a
      // guaranteed idle-every-turn contract (the engine would just note it)
      const dir = side === 'sell' ? 'export' : 'import';
      const emb = tradeCfg.tariffs && tradeCfg.tariffs.embargoes && tradeCfg.tariffs.embargoes[item.id];
      if (emb && emb[dir]) return bad(`Trade is embargoed for ${item.name} (${dir}).`);
      db.tradeContracts = db.tradeContracts || [];
      const t = db.settings.time;
      const c = {
        id: store.uid('ctr'), kind: 'order', side, partnerId: partner.id, itemId: item.id, holderId: holder.id,
        qtyPerTurn: qty, turnsLeft: dur, startedTurn: t.turn,
        executions: 0, totalQty: 0, totalValue: 0, lastUnit: null, lastTurnNote: null,
        status: 'active', createdBy: u.user.displayName, createdAt: Date.now()
      };
      db.tradeContracts.push(c);
      store.log('economy', 'Ongoing contract signed',
        `${holder.name} will ${side === 'sell' ? 'export to' : 'import from'} ${partner.name}: ${qty} × ${item.name} each turn` +
        (dur ? ` · runs ${dur} turn${dur === 1 ? '' : 's'}` : ' · until cancelled'), u.user.displayName, [holder.id, partner.id]);
      store.save(); broadcast('sync');
      return json(res, 200, { contract: c });
    }
    if (pathname.startsWith('/api/trade/contracts/') && method === 'POST' && pathname.endsWith('/accept')) {
      const id = pathname.slice('/api/trade/contracts/'.length, -'/accept'.length);
      const c = (db.tradeContracts || []).find(x => x.id === id);
      if (!c) return bad('No such contract.');
      if (c.kind !== 'transfer') return bad('Only player-to-player contracts need acceptance.');
      if (c.status !== 'proposed') return bad('That contract is not awaiting approval.');
      const gm = u.role.perms.gm;
      // only the RECEIVING side (or GM) may accept a proposal — the offering
      // side authored it and can only cancel it
      if (!gm && !ownership.controls(u.user.entityId, c.toEntityId)) return deny('Only the receiving entity may accept.');
      c.status = 'active';
      c.acceptedBy = u.user.displayName;
      c.acceptedAtTurn = db.settings.time.turn;
      const fromEnt = db.entities.find(e => e.id === c.fromEntityId) || { name: c.fromEntityId };
      const toEnt = db.entities.find(e => e.id === c.toEntityId) || { name: c.toEntityId };
      store.log('economy', 'Ongoing contract accepted',
        `${toEnt.name} approved the standing ${c.qtyPerTurn} × item transfer from ${fromEnt.name}.`, u.user.displayName, [c.fromEntityId, c.toEntityId]);
      store.save(); broadcast('sync');
      return json(res, 200, { contract: c });
    }
    if (pathname.startsWith('/api/trade/contracts/') && method === 'POST' && pathname.endsWith('/cancel')) {
      const id = pathname.slice('/api/trade/contracts/'.length, -'/cancel'.length);
      const c = (db.tradeContracts || []).find(x => x.id === id);
      if (!c) return bad('No such contract.');
      const gm = u.role.perms.gm;
      // either party to a transfer — or the holder of an order contract — may
      // cancel; on a proposal this doubles as declining
      const partyControlled = c.kind === 'transfer'
        ? (ownership.controls(u.user.entityId, c.fromEntityId) || ownership.controls(u.user.entityId, c.toEntityId))
        : ownership.controls(u.user.entityId, c.holderId);
      if (!gm && !partyControlled) return deny('You are not a party to that contract.');
      if (c.status !== 'active' && c.status !== 'proposed') return bad('That contract is not running.');
      c.status = 'cancelled';
      c.cancelledBy = u.user.displayName;
      c.cancelledAtTurn = db.settings.time.turn;
      store.log('economy', c.status === 'cancelled' && c.executions === 0 && !c.acceptedAtTurn ? 'Ongoing contract declined' : 'Ongoing contract cancelled',
        `${c.executions} fill${c.executions === 1 ? '' : 's'} before cancellation.`, u.user.displayName,
        [c.holderId || c.fromEntityId, c.partnerId || c.toEntityId]);
      store.save(); broadcast('sync');
      return json(res, 200, { contract: c });
    }
    if (pathname.startsWith('/api/trade/contracts/') && method === 'DELETE') {
      const id = pathname.slice('/api/trade/contracts/'.length);
      const idx = (db.tradeContracts || []).findIndex(x => x.id === id);
      if (idx < 0) return bad('No such contract.');
      const c = db.tradeContracts[idx];
      const gm = u.role.perms.gm;
      const partyControlled = c.kind === 'transfer'
        ? (ownership.controls(u.user.entityId, c.fromEntityId) || ownership.controls(u.user.entityId, c.toEntityId))
        : ownership.controls(u.user.entityId, c.holderId);
      if (!gm && !partyControlled) return deny('You are not a party to that contract.');
      if (c.status === 'active' || c.status === 'proposed') return bad('Cancel the contract before removing it.');
      db.tradeContracts.splice(idx, 1);
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true });
    }

    // ---- stock market (Phase 4.4) ----
    if (pathname === '/api/market/buy' && method === 'POST') {
      const b = await readBody(req);
      const gm = u.role.perms.gm;
      // A requested-but-uncontrolled entityId is a DENY, not a silent fallback
      // to the caller's own entity (a mistyped company id used to spend YOUR
      // money instead of erroring).
      let buyerId = u.user.entityId;
      if (b.entityId && b.entityId !== buyerId) {
        if (!gm && !ownership.controls(u.user.entityId, b.entityId)) return deny('You do not control that holder.');
        buyerId = b.entityId;
      }
      if (!buyerId) return bad('No entity to trade for.');
      try { const r = market.buy(b.companyId, buyerId, b.shares, u.user.displayName, { gm, x100: !!b.x100 }); store.save(); broadcast('sync'); return json(res, 200, r); }
      catch (e) { return bad(e.message); }
    }
    if (pathname === '/api/market/sell' && method === 'POST') {
      const b = await readBody(req);
      const gm = u.role.perms.gm;
      let sellerId = u.user.entityId;
      if (b.entityId && b.entityId !== sellerId) {
        if (!gm && !ownership.controls(u.user.entityId, b.entityId)) return deny('You do not control that holder.');
        sellerId = b.entityId;
      }
      if (!sellerId) return bad('No entity to trade for.');
      try { const r = market.sell(b.companyId, sellerId, b.shares, u.user.displayName, { gm, x100: !!b.x100 }); store.save(); broadcast('sync'); return json(res, 200, r); }
      catch (e) { return bad(e.message); }
    }
    if (pathname === '/api/market/transfer' && method === 'POST') {
      const b = await readBody(req);
      const gm = u.role.perms.gm;
      let fromId = u.user.entityId;
      if (b.fromEntityId && b.fromEntityId !== fromId) {
        if (!gm && !ownership.controls(u.user.entityId, b.fromEntityId)) return deny('You do not control that holder.');
        fromId = b.fromEntityId;
      }
      if (!fromId) return bad('No entity to trade for.');
      if (!b.toEntityId) return bad('Recipient required.');
      try { const r = market.transfer(b.companyId, fromId, b.toEntityId, b.shares, u.user.displayName); store.save(); broadcast('sync'); return json(res, 200, r); }
      catch (e) { return bad(e.message); }
    }
    // Bonus mint (dilution). Kept at /api/market/issue for back-compat.
    if (pathname === '/api/market/issue' && method === 'POST') {
      const b = await readBody(req);
      const gm = u.role.perms.gm;
      if (!gm && !ownership.controls(u.user.entityId, b.companyId)) return deny('Only the company’s controller may issue shares.');
      try { const r = market.bonusMint(b.companyId, b.newShares, b.floatPct, u.user.displayName); store.save(); broadcast('sync'); return json(res, 200, r); }
      catch (e) { return bad(e.message); }
    }
    // Offering (Workstream A2) — primary capital raise: sell new shares for cash.
    if (pathname === '/api/market/offer' && method === 'POST') {
      const b = await readBody(req);
      const gm = u.role.perms.gm;
      if (!gm && !ownership.controls(u.user.entityId, b.companyId)) return deny('Only the company’s controller may raise capital.');
      try { const r = market.offer(b.companyId, b.newShares, b.floatPct, u.user.displayName); store.save(); broadcast('sync'); return json(res, 200, r); }
      catch (e) { return bad(e.message); }
    }
    // Buyback (Workstream A3) — retire shares from the float, price up.
    if (pathname === '/api/market/buyback' && method === 'POST') {
      const b = await readBody(req);
      const gm = u.role.perms.gm;
      if (!gm && !ownership.controls(u.user.entityId, b.companyId)) return deny('Only the company’s controller may buy back shares.');
      try { const r = market.buyback(b.companyId, b.shares, u.user.displayName, { gm }); store.save(); broadcast('sync'); return json(res, 200, r); }
      catch (e) { return bad(e.message); }
    }

    // ---- newsroom (Phase 5: four fixed papers, one journalist per paper) ----
    if (pathname === '/api/news' && method === 'POST') {
      const gm = u.role.perms.gm;
      if (!u.role.perms.manageNews && !gm) return deny('Press credentials required.');
      const b = await readBody(req);
      if (!b.headline) return bad('A headline is required.');
      const validPaperIds = new Set((db.settings.newspapers || []).map(p => p.id));
      let paperId = b.paperId && validPaperIds.has(b.paperId) ? b.paperId : undefined;
      if (b.paperId && !validPaperIds.has(b.paperId)) return bad('Unknown newspaper.');
      // A non-GM journalist may only publish/draft to their own paper. If they
      // sent no paperId, default it to their own paper so the check below and
      // sim.draftNews both land in the right place.
      if (!gm) {
        if (!paperId) paperId = u.user.newspaperId;
        if (!u.user.newspaperId || paperId !== u.user.newspaperId) return deny('You may only file to your own newspaper.');
      }
      const a = sim.draftNews(String(b.headline).slice(0, 200), String(b.body || '').slice(0, 8000), String(b.category || 'General').slice(0, 40), !!b.publish, u.user.displayName, paperId);
      // The author's own badge shouldn't go unread on the story they just ran.
      if (b.publish && (u.user.lastReadNewsTs || 0) < Date.now()) u.user.lastReadNewsTs = Date.now();
      store.save(); broadcast('sync');
      return json(res, 200, { article: a });
    }
    // Mark-news-as-read: one ping per News-tab visit that advances the user's
    // news waterline (the "News (n)" badge's only source of truth). High-
    // frequency like lastLogin, so no store.log and no broadcast — the route
    // is in SYNC_SKIP (see above), so the response carries no world payload.
    if (pathname === '/api/news/read' && method === 'POST') {
      const now = Date.now();
      if ((u.user.lastReadNewsTs || 0) < now) u.user.lastReadNewsTs = now;
      store.save();
      return json(res, 200, { ok: true });
    }
    m = pathname.match(/^\/api\/news\/([\w-]+)$/);
    if (m && (method === 'PATCH' || method === 'DELETE')) {
      const gm = u.role.perms.gm;
      if (!u.role.perms.manageNews && !gm) return deny('Press credentials required.');
      const idx = db.news.findIndex(n => n.id === m[1]);
      if (idx < 0) return bad('No such article.');
      const article = db.news[idx];
      if (!gm && (!u.user.newspaperId || article.paperId !== u.user.newspaperId)) return deny('You may only edit articles in your own newspaper.');
      if (method === 'DELETE') {
        const [gone] = db.news.splice(idx, 1);
        store.log('news', 'Article deleted: ' + gone.headline, '', u.user.displayName, []);
      } else {
        const b = await readBody(req);
        const validPaperIds = new Set((db.settings.newspapers || []).map(p => p.id));
        if (b.paperId !== undefined) {
          if (!validPaperIds.has(b.paperId)) return bad('Unknown newspaper.');
          if (!gm && b.paperId !== u.user.newspaperId) return deny('You may only file to your own newspaper.');
        }
        const a = db.news[idx];
        // Same caps as POST /api/news — an unbounded PATCH let a journalist
        // rewrite a body to the full 4MB request cap.
        if (b.headline !== undefined) a.headline = String(b.headline).slice(0, 200);
        if (b.body !== undefined) a.body = String(b.body).slice(0, 8000);
        if (b.category !== undefined) a.category = String(b.category).slice(0, 40);
        if (b.status !== undefined) a.status = String(b.status).slice(0, 20);
        if (b.paperId !== undefined) a.paperId = String(b.paperId);
        if (b.status === 'published') {
          store.log('news', 'Published: ' + a.headline, a.category, u.user.displayName, [a.id]);
          if ((u.user.lastReadNewsTs || 0) < Date.now()) u.user.lastReadNewsTs = Date.now();
        }
      }
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true });
    }

    // Phase 33/34 — parties run campaigns during the election season. Any
    // operator who controls the party (its leader chain) can spend the
    // treasury; the GM can too (checked inline — the route is player-facing).
    // Campaigns come from the GM's catalogue (settings.election.campaigns),
    // each targeted at ONE province with a per-campaign duration; the party
    // picks a budget and support scales linearly with it against the GM-set
    // base cost, consuming the campaign's required stock in the same
    // proportion (no freeform extras); party affinities (campaign.bonusParties)
    // multiply the whole lot.
    if (pathname === '/api/election/campaign' && method === 'POST') {
      const b = await readBody(req);
      const party = b && b.partyId ? db.entities.find(e => e.id === b.partyId) : null;
      if (!party || party.type !== 'party') return bad('Unknown party.');
      // Phase 35: campaign_minor for routine campaigns, full control for major ones
      const campaignCost = Math.round(Number(b.money) || 0);
      const MAJOR_THRESHOLD = db.settings.election && db.settings.election.majorCampaignCost || 50000;
      const scope = campaignCost >= MAJOR_THRESHOLD ? 'campaign_major' : 'campaign_minor';
      if (!u.role.perms.gm && !ownership.canAct(db, u.user.entityId, party.id, scope)) {
        // Over-cap spend by a capped grantee → approval queue with the full
        // campaign snapshot so the leader's approval can execute it verbatim.
        // The grant must cover THIS campaign's scope (minor vs major) — canAct
        // fails at the scope gate too, and a minor-scoped grantee must not be
        // able to queue a major campaign for one-click approval.
        const grant = ownership.findGrant(party, u.user.entityId);
        if (grant && ownership.grantCoversScope(grant, scope) && grant.grants && grant.grants.spendLimitPerTurn !== null && grant.grants.spendLimitPerTurn !== undefined && campaignCost > grant.grants.spendLimitPerTurn) {
          const req = ownership.createRequest(db, party.id, u.user.entityId, scope, {
            amount: campaignCost, description: `Campaign in ${b.province}`,
            action: { kind: 'campaign', partyId: party.id, province: b.province, campaignId: b.campaignId,
              money: campaignCost, materials: Array.isArray(b.materials) ? b.materials : [],
              targetGroup: b.targetGroup || null, defamePartyId: b.defamePartyId || null },
          });
          store.log('economy', `Over-cap campaign request created`, `${party.name} — ₳${campaignCost}`, u.user.displayName, [party.id]);
          store.save(); broadcast('sync');
          return json(res, 202, { ok: false, pending: true, requestId: req.id, message: 'Campaign exceeds your spend limit. Request submitted for party leader approval.' });
        }
        return deny('You do not control that party.');
      }
      if (!b.province || !db.provinces.some(p => p.id === b.province)) return bad('Choose a province to campaign in.');
      if (!b.campaignId) return bad('Choose a campaign from the catalogue.');
      try {
        const result = election.runCampaign(db, party.id, b.province, String(b.campaignId),
          Math.round(Number(b.money) || 0), b.materials || [], u.user.displayName,
          { targetGroup: b.targetGroup || undefined, defamePartyId: b.defamePartyId || undefined });
        store.save(); broadcast('sync');
        return json(res, 200, { election: db.election, ...result });
      } catch (e) { return bad(e.message); }
    }

    // Phase 34 — campaign estimate: catalogue campaign at the chosen budget,
    // no spending. Shows base strength, the scaled required stock, the
    // party-affinity multiplier and the late votes the drive would add while
    // the count is running. A GET (query params) so the client can preview
    // without a mutating POST — the GET never carries a sync payload, so
    // clicking "Estimate" no longer re-renders the world and wipes the form.
    // POST stays as a legacy alias.
    if (pathname === '/api/election/estimate' && (method === 'GET' || method === 'POST')) {
      const b = method === 'POST' ? await readBody(req) : Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
      if (typeof b.materials === 'string') { try { b.materials = JSON.parse(b.materials); } catch (e) { b.materials = []; } }
      const party = b && b.partyId ? db.entities.find(e => e.id === b.partyId) : null;
      if (!party || party.type !== 'party') return bad('Unknown party.');
      if (!u.role.perms.gm && !ownership.controls(u.user.entityId, party.id)) return deny('You do not control that party.');
      if (!b.province || !db.provinces.some(p => p.id === b.province)) return bad('Choose a province to campaign in.');
      if (!b.campaignId) return bad('Choose a campaign from the catalogue.');
      try {
        const est = election.estimateCampaign(db, party.id, b.province, String(b.campaignId),
          Math.round(Number(b.money) || 0), b.materials || [],
          { targetGroup: b.targetGroup || undefined, defamePartyId: b.defamePartyId || undefined });
        return json(res, 200, est);
      } catch (e) { return bad(e.message); }
    }

    // Backward-compat alias: the old freeform "invest" route now behaves
    // exactly like the catalogue campaign route (the client uses /campaign).
    if (pathname === '/api/election/invest' && method === 'POST') {
      const b = await readBody(req);
      const party = b && b.partyId ? db.entities.find(e => e.id === b.partyId) : null;
      if (!party || party.type !== 'party') return bad('Unknown party.');
      if (!u.role.perms.gm && !ownership.controls(u.user.entityId, party.id)) return deny('You do not control that party.');
      if (!b.province || !db.provinces.some(p => p.id === b.province)) return bad('Choose a province to campaign in.');
      if (!b.campaignId) return bad('Choose a campaign from the catalogue.');
      try {
        const result = election.runCampaign(db, party.id, b.province, String(b.campaignId),
          Math.round(Number(b.money) || 0), b.materials || [], u.user.displayName,
          { targetGroup: b.targetGroup || undefined, defamePartyId: b.defamePartyId || undefined });
        store.save(); broadcast('sync');
        return json(res, 200, { election: db.election, ...result });
      } catch (e) { return bad(e.message); }
    }

    // ---- GM ----
    if (pathname.startsWith('/api/gm/')) {
      if (!u.role.perms.gm) return deny('Gamemaster clearance required.');
      const actor = 'GM ' + u.user.displayName;

      if (pathname === '/api/gm/advance' && method === 'POST') {
        const b = await readBody(req);
        const steps = Math.round(Number(b.steps) || 1);
        if (b.preview) {
          // Turn preview (Phase 25 QoL): the event Simulate button's
          // snapshot → run → diff → restore dance, applied to a whole turn.
          // Snapshot suppression keeps the simulated turn from archiving a
          // cloud snapshot row over the real one for this turn. Same accepted
          // cloud-mode caveat as below: pending timeline/txn rows flush even
          // though the doc is restored.
          const before = JSON.parse(JSON.stringify(store.get()));
          let err = null;
          store.setSnapshotSuppression(true);
          try { sim.advanceTurn(steps, actor + ' (preview)'); } catch (e) { err = e.message; }
          store.setSnapshotSuppression(false);
          const diff = computeWorldDiff(before, store.get());
          const live = store.get();
          for (const k of Object.keys(live)) delete live[k];
          Object.assign(live, before);
          // Flush the restored doc NOW: store.log() inside the simulation
          // scheduled a debounced write, and relying on the 400ms timer
          // landing after the restore was a crash-window data-loss bet.
          if (store.MODE === 'file') { try { store.saveNow(); } catch (e) { /* retried by safety interval */ } }
          return json(res, 200, { preview: true, steps, error: err, diff });
        }
        const time = sim.advanceTurn(steps, actor);
        return json(res, 200, { time });
      }
      if (pathname === '/api/gm/run-event' && method === 'POST') {
        const b = await readBody(req);
        const ev = db.events.find(e => e.id === b.id);
        if (!ev) return bad('No such event.');
        if (b.dryRun) {
          // Phase 8 — Simulate button. Deep-snapshot the whole db, let the
          // event actually run (sim.runEvent mutates the live in-memory db —
          // there is no side-effect-free execution path), diff old vs. new,
          // then restore the live db from the snapshot before anyone can see
          // the mutation. We do NOT call store.save()/broadcast, so file mode
          // never persists it.
          // Cloud-mode caveat: store.log()/recordTxn() push copies into
          // module-level pending buffers (pendingTimeline/pendingTxns) that
          // live *outside* db and are NOT rolled back here — they are only
          // flushed to Supabase by store.commit() at the end of a real
          // request. Since a dry run never calls store.save() (which is what
          // marks the doc `dirty`), commit() will still ship the log/txn rows
          // even though the world doc itself was restored, so a dry run can
          // leave a phantom timeline/transaction entry behind in cloud mode.
          // Acceptable for now — flag if that drift becomes a problem.
          const before = JSON.parse(JSON.stringify(store.get()));
          let ran = false, err = null;
          store.setSnapshotSuppression(true);
          try { ran = sim.runEvent(ev, actor); } catch (e) { err = e.message; }
          store.setSnapshotSuppression(false);
          const diff = ran ? computeWorldDiff(before, store.get()) : { globalVars: [], provinces: [], moneyMoved: 0, news: [] };
          // restore the live db in place — callers elsewhere hold the same
          // reference returned by store.get(), so we mutate it rather than
          // reassign.
          const live = store.get();
          for (const k of Object.keys(live)) delete live[k];
          Object.assign(live, before);
          if (store.MODE === 'file') { try { store.saveNow(); } catch (e) { /* retried by safety interval */ } }
          if (err) return json(res, 200, { dryRun: true, ran: false, error: err, diff });
          return json(res, 200, { dryRun: true, ran, diff });
        }
        const ran = sim.runEvent(ev, actor);
        if (!ran) store.log('simulation', `Event “${ev.name}” did not run`, 'Conditions were not met.', actor, [ev.id]);
        sim.updateDerived();
        store.save(); broadcast('sync');
        return json(res, 200, { ran });
      }
      // ---- War (Phase 15 — realtime battlefield RTS) ----
      if (pathname === '/api/gm/war/start' && method === 'POST') {
        const b = await readBody(req);
        if (db.war && db.war.active) return json(res, 409, { error: 'A war is already active.' });
        const scenario = warScenarios.scenarios[b.scenario] || ((db.settings.warCustomScenarios || []).find(s => s.id === b.scenario));
        if (!scenario) return bad('Unknown scenario: ' + b.scenario);
        try {
          war.startWar(db, scenario);
        } catch (e) { return bad(e.message); }
        store.log('gm', `War started: ${scenario.name}`, '', actor, [scenario.attackerId, scenario.defenderId]);
        store.save(); broadcast('sync');
        return json(res, 200, { war: db.war });
      }
      if (pathname === '/api/gm/war/control' && method === 'POST') {
        const b = await readBody(req);
        const doc = b.conflict === 'protest' ? db.protest : db.war;
        if (!doc) return bad('No conflict is active.');
        if (b.paused !== undefined) doc.paused = !!b.paused;
        if (b.speed !== undefined) {
          const speed = Number(b.speed);
          if (![1, 2, 4, 8].includes(speed)) return bad('Speed must be one of 1, 2, 4, 8.');
          doc.speed = speed;
        }
        store.log('gm', 'Conflict control updated', `paused=${doc.paused} speed=${doc.speed}×`, actor, []);
        store.save(); broadcast('sync');
        return json(res, 200, { war: db.war, protest: db.protest });
      }
      if (pathname === '/api/gm/war/end' && method === 'POST') {
        const b = await readBody(req);
        const key = (b && b.conflict === 'protest') ? 'protest' : 'war';
        const doc = key === 'protest' ? db.protest : db.war;
        if (!doc) return bad('No conflict is active.');
        war.endWar(db, actor, key === 'protest' ? 'Protest ended by the Gamemaster' : 'Ended by the Gamemaster', key);
        store.save(); broadcast('sync');
        return json(res, 200, { war: db.war, protest: db.protest });
      }
      // GM global tuning sliders — combat/bomb damage and unit HP multipliers
      // (war.mods). Validated here (finite number, clamped 0.1-10); the HP
      // rescale of every live unit happens inside war.setWarTuning.
      if (pathname === '/api/gm/war/tuning' && method === 'POST') {
        const b = await readBody(req);
        const key = b.conflict === 'protest' ? 'protest' : 'war';
        const doc = key === 'protest' ? db.protest : db.war;
        if (!doc) return bad('No conflict is active.');
        const patch = {};
        for (const k of ['dmg', 'bombDmg', 'hp', 'warshipSpeed']) {
          if (b[k] === undefined) continue;
          const v = Number(b[k]);
          if (!Number.isFinite(v)) return bad(`Invalid ${k}.`);
          patch[k] = Math.max(0.1, Math.min(10, v));
        }
        let result;
        if (key === 'protest') result = war.setProtestTuning(db, patch, actor);
        else result = war.setWarTuning(db, patch, actor);
        if (!result.ok) return bad(result.error);
        store.save(); broadcast('sync');
        return json(res, 200, { war: db.war, protest: db.protest });
      }
      // Scenario picker data — {id, name, attacker/defender ids+names} for
      // every scenario in server/war-scenarios.js, so the War Room's Start
      // form doesn't have to hardcode the list client-side.
      if (pathname === '/api/gm/war/scenarios' && method === 'GET') {
        const list = [...Object.values(warScenarios.scenarios), ...(db.settings.warCustomScenarios || [])].map(s => {
          const att = db.entities.find(e => e.id === s.attackerId);
          const def = db.entities.find(e => e.id === s.defenderId);
          return {
            id: s.id, name: s.name, attackerId: s.attackerId, defenderId: s.defenderId,
            attackerName: att ? att.name : s.attackerId, defenderName: def ? def.name : s.defenderId
          };
        });
        return json(res, 200, { scenarios: list });
      }
      if (pathname === '/api/gm/war/scenarios/custom' && method === 'POST') {
        const b = await readBody(req);
        const attackerId = String(b.attackerId || ''), defenderId = String(b.defenderId || 'ent_gov');
        const attacker = db.entities.find(e => e.id === attackerId && e.type === 'foreign');
        const defender = db.entities.find(e => e.id === defenderId);
        if (!attacker || !defender) return bad('Choose a foreign attacker and a valid defender.');
        const count = (k) => Math.max(0, Math.min(30, Math.round(Number(b[k]) || 0)));
        const units = [];
        for (const [kind, label] of [['infantry','Infantry'],['armored','Armored'],['marine','Marines'],['boat','Boats'],['warship','Warships']]) for (let i = 0; i < count(kind); i++) units.push({ name: `Custom ${label} ${i + 1}`, kind });
        if (!units.length) return bad('Add at least one attacking unit.');
        const scenario = { id: 'custom_' + Date.now().toString(36), name: String(b.name || 'Custom War').slice(0, 80), attackerId, defenderId, staging: { x0: 2900, y0: 500, x1: 3100, y1: 900 }, objectives: [{ kind: 'seize_capital', priority: 1 }], units, defense: { citySizeStrength: { 1: 1300, 2: 2200, 3: 3800 }, militaryPropertyStrength: 2600 }, tuning: { consolidateFrac: .35, collapseFrac: .12 } };
        db.settings.warCustomScenarios = db.settings.warCustomScenarios || [];
        db.settings.warCustomScenarios.push(scenario);
        store.save(); broadcast('sync');
        return json(res, 200, { scenario });
      }
      // GM unit spawner — deploy fresh units mid-war for either side at an
      // arbitrary point, with adjustable stats (see war.spawnUnits).
      if (pathname === '/api/gm/war/spawn' && method === 'POST') {
        const b = await readBody(req);
        const key = b.conflict === 'protest' ? 'protest' : 'war';
        const doc = key === 'protest' ? db.protest : db.war;
        if (!doc || !doc.active) return bad('No conflict is active.');
        const result = war.spawnUnits(db, {
          side: b.side, pos: b.pos, kind: b.kind, name: b.name,
          count: b.count, strength: b.strength, atk: b.atk, speed: b.speed
        }, actor, key);
        if (!result.ok) return bad(result.error);
        store.save(); broadcast('sync');
        return json(res, 200, { war: db.war, protest: db.protest, unitIds: result.unitIds });
      }
      // ---- Protests & mass strikes (Phase 31) ----
      // A protest is a second conflict document (db.protest) sharing the war
      // stack; these routes start/end it and let the ORGANIZER'S controller
      // (via cmdAccessOf) or the GM flip the violence/capture-mode toggles
      // server-side. Tuning (violence damage, strike economics, casualties)
      // is GM-only.
      if (pathname === '/api/gm/protest/start' && method === 'POST') {
        const b = await readBody(req);
        if (db.protest && db.protest.active) return json(res, 409, { error: 'A protest is already underway.' });
        try {
          war.startProtest(db, b || {}, actor);
        } catch (e) { return bad(e.message); }
        store.save(); broadcast('sync');
        return json(res, 200, { protest: db.protest });
      }
      if (pathname === '/api/gm/protest/tuning' && method === 'POST') {
        const b = await readBody(req);
        if (!db.protest || !db.protest.active) return bad('No protest is active.');
        const patch = {};
        for (const k of ['strikeFrac', 'civFrac', 'refugeeFrac', 'refugeeEvery', 'dmg', 'hp', 'bombDmg']) {
          if (b[k] === undefined) continue;
          const v = Number(b[k]);
          if (!Number.isFinite(v)) return bad(`Invalid ${k}.`);
          patch[k] = v;
        }
        const result = war.setProtestTuning(db, patch, actor);
        if (!result.ok) return bad(result.error);
        store.save(); broadcast('sync');
        return json(res, 200, { protest: db.protest });
      }
      if (pathname === '/api/gm/protest/end' && method === 'POST') {
        if (!db.protest) return bad('No protest is active.');
        war.endWar(db, actor, 'Protest ended by the Gamemaster', 'protest');
        store.save(); broadcast('sync');
        return json(res, 200, { protest: db.protest });
      }
      // Peace treaty (Phase 24 — GM-only): reparations, province cession,
      // nation annexation, in any combination; an active war ends first.
      // See war.applyTreaty for the world mutations each clause performs.
      if (pathname === '/api/gm/war/treaty' && method === 'POST') {
        const b = await readBody(req);
        const applied = war.applyTreaty(db, b || {}, actor);
        if (!applied.length) return bad('The treaty contained no valid clauses.');
        store.save(); broadcast('sync');
        return json(res, 200, { ok: true, applied });
      }
      // Foreign intervention — an existing 'foreign' entity joins an ongoing
      // war on either side (see war.joinWar).
      if (pathname === '/api/gm/war/join' && method === 'POST') {
        const b = await readBody(req);
        if (!db.war || !db.war.active) return bad('No war is active.');
        const result = war.joinWar(db, { entityId: b.entityId, side: b.side, count: b.count }, actor);
        if (!result.ok) return bad(result.error);
        store.save(); broadcast('sync');
        return json(res, 200, { war: db.war, unitIds: result.unitIds });
      }
      if (pathname === '/api/gm/election' && method === 'POST') {
        // Phase 33 — this legacy route stays as the "instant election" escape
        // hatch, but refuses to run over a live campaign/count.
        if (db.election && db.election.active) return bad('An election is already underway — end or cancel it first.');
        const b = await readBody(req);
        try {
          const rec = sim.runElection(actor, b && b.manual ? b.manual : undefined);
          return json(res, 200, { election: rec });
        } catch (e) { return bad(e.message); }
      }
      // Phase 34 — live elections (see server/election.js): the Election
      // Commission's levers. The count now runs off the continuous world
      // clock rather than world turns — durationDays is real world-clock
      // days, ticked by election.maybeTick (ridden from GET /api/state and
      // a resident timer in server.js). Tuning knobs are saved as
      // settings.election from the GM Election tab (applyTuning applies them
      // to a live election too), so the routes here stay single-purpose.
      if (pathname === '/api/gm/election/campaign' && method === 'POST') {
        try { election.startCampaign(db, actor); } catch (e) { return bad(e.message); }
        store.save(); broadcast('sync');
        return json(res, 200, { election: db.election });
      }
      if (pathname === '/api/gm/election/vote' && method === 'POST') {
        try { election.startVoting(db, actor); } catch (e) { return bad(e.message); }
        store.save(); broadcast('sync');
        return json(res, 200, { election: db.election });
      }
      if (pathname === '/api/gm/election/adjust' && method === 'POST') {
        const b = await readBody(req);
        try { election.adjustVotes(db, b || {}, actor); } catch (e) { return bad(e.message); }
        store.save(); broadcast('sync');
        return json(res, 200, { election: db.election });
      }
      if (pathname === '/api/gm/election/tick-count' && method === 'POST') {
        try { election.tickCount(db, actor); } catch (e) { return bad(e.message); }
        store.save(); broadcast('sync');
        return json(res, 200, { election: db.election });
      }
      if (pathname === '/api/gm/election/cancel' && method === 'POST') {
        try { election.cancel(db, actor); } catch (e) { return bad(e.message); }
        store.save(); broadcast('sync');
        return json(res, 200, { election: null });
      }
      // Phase 3.3 — Influence dialog: a safe allow-list of one-off effects the
      // GM can fire without authoring a whole event.
      const SAFE_EFFECT_TYPES = ['adjust_demo', 'adjust_var', 'adjust_support'];
      if (pathname === '/api/gm/effect' && method === 'POST') {
        const b = await readBody(req);
        const fx = b && b.effect;
        if (!fx || !SAFE_EFFECT_TYPES.includes(fx.type)) return bad('Unknown or unsafe effect type.');
        try {
          sim.applyEffect(fx, { actor, eventName: 'GM influence' });
        } catch (e) { return bad(e.message); }
        sim.updateDerived();
        store.save(); broadcast('sync');
        return json(res, 200, { ok: true });
      }
      if (pathname === '/api/gm/test-expr' && method === 'POST') {
        const b = await readBody(req);
        try {
          let vars = db.globalVars;
          if (b.scope === 'province') {
            const p = (b.targetId && db.provinces.find(x => x.id === b.targetId)) || db.provinces[0];
            if (p) {
              // expose both bare keys ($employment) and p_-prefixed keys
              // ($p_employment), matching the adjust_demo effect convention
              // documented in the events tab.
              vars = { ...p.vars };
              for (const k in p.vars) vars['p_' + k] = p.vars[k];
            }
          } else if (b.scope === 'entity') {
            const e = (b.targetId && db.entities.find(x => x.id === b.targetId)) || db.entities[0];
            if (e) vars = { ...(e.vars || {}) };
          }
          return json(res, 200, { value: sim.evalExpr(String(b.expr || ''), { vars }) });
        } catch (e) { return json(res, 200, { error: e.message }); }
      }
      if (pathname === '/api/gm/mint' && method === 'POST') {
        const b = await readBody(req);
        const acct = db.accounts.find(a => a.id === b.accountId);
        const amount = Number(b.amount);
        if (!acct || !amount) return bad('Account and non-zero amount required.');
        if (amount > 0) sim.txn(null, acct.id, amount, b.memo || 'GM issuance', actor, 'deposit');
        else sim.txn(acct.id, null, -amount, b.memo || 'GM withdrawal', actor, 'withdraw');
        store.save(); broadcast('sync');
        return json(res, 200, { ok: true });
      }
      // Workstream C — GM Assets & Ownership front doors.
      // Move any item between holders (routes cert/deed items through the same
      // machinery as accept-trade's moveItem).
      if (pathname === '/api/gm/give-item' && method === 'POST') {
        const b = await readBody(req);
        const fromE = db.entities.find(e => e.id === b.fromEntityId);
        const toE = db.entities.find(e => e.id === b.toEntityId);
        const item = db.items.find(i => i.id === b.itemId);
        const qty = cleanQty(b.qty);
        if (!fromE || !toE) return bad('Pick a valid source and destination holder.');
        if (fromE.id === toE.id) return bad('Source and destination are the same.');
        if (!item) return bad('Unknown item.');
        if (!(qty > 0)) return bad('Quantity must be positive.');
        try {
          if (item.meta && item.meta.leveraged) return bad('Leveraged positions cannot be moved — sell them back through the exchange.');
          if (item.meta && item.meta.companyId) {
            market.transfer(item.meta.companyId, fromE.id, toE.id, qty, actor);
          } else if (item.meta && item.meta.propertyId) {
            deeds.transfer(item.meta.propertyId, fromE.id, toE.id, actor);
          } else {
            fromE.inventory = fromE.inventory || [];
            const row = fromE.inventory.find(r => r.itemId === item.id);
            if (!row || row.qty < qty) return bad(`${fromE.name} does not hold ${qty} × ${item.name}.`);
            row.qty -= qty;
            fromE.inventory = fromE.inventory.filter(r => r.qty > 0);
            toE.inventory = toE.inventory || [];
            const trow = toE.inventory.find(r => r.itemId === item.id);
            if (trow) trow.qty += qty; else toE.inventory.push({ itemId: item.id, qty });
            store.log('inventory', `${qty} × ${item.name} moved`, `${fromE.name} → ${toE.name}`, actor, [fromE.id, toE.id]);
          }
        } catch (e) { return bad(e.message); }
        store.save(); broadcast('sync');
        return json(res, 200, { ok: true });
      }
      // Assign / transfer shares. from|to may be 'float' (the Exchange-held
      // unallocated pool). This is the GM-friendly front door for A7.
      if (pathname === '/api/gm/set-holding' && method === 'POST') {
        const b = await readBody(req);
        const co = db.entities.find(e => e.id === b.companyId && e.type === 'company');
        if (!co) return bad('Unknown company.');
        const shares = Math.round(Number(b.shares));
        if (!(shares > 0)) return bad('Share count must be positive.');
        const from = b.fromEntityId, to = b.toEntityId;
        try {
          if ((!from || from === 'float') && to && to !== 'float') {
            if (market.treasuryPool(co) < shares) return bad('Not enough shares in the float.');
            market.setHolding(co, to, market.holdingOf(co, to) + shares);
          } else if (from && from !== 'float' && (!to || to === 'float')) {
            if (market.holdingOf(co, from) < shares) return bad('That holder does not have that many shares.');
            market.setHolding(co, from, market.holdingOf(co, from) - shares);
          } else if (from && to) {
            market.transfer(b.companyId, from, to, shares, actor);
          } else {
            return bad('Pick a source and destination (holder or float).');
          }
        } catch (e) { return bad(e.message); }
        market.syncAllCertificates(db);
        store.log('ownership', `${shares} ${co.abbrev || co.name} shares reassigned`,
          `${from === 'float' || !from ? 'float' : (db.entities.find(e => e.id === from) || {}).name || from} → ${to === 'float' || !to ? 'float' : (db.entities.find(e => e.id === to) || {}).name || to}`, actor, [co.id]);
        store.save(); broadcast('sync');
        return json(res, 200, { ok: true });
      }
      if (pathname === '/api/gm/snapshots' && method === 'GET') return json(res, 200, { snapshots: await store.listSnapshots() });
      if (pathname === '/api/gm/export' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="arcasia-world.json"' });
        return res.end(JSON.stringify(db, null, 1));
      }
      if (pathname === '/api/gm/rollback' && method === 'POST') {
        const b = await readBody(req);
        await store.rollback(Math.round(Number(b.turn)));
        // the restored snapshot may predate the SVG map document — upgrade
        // it in place so rolling back never resurfaces "no map document".
        // store.rollback() swaps in a new db object, so re-fetch it here
        // rather than mutate the stale `db` const captured above.
        if (mapdata.applyMap(store.get())) store.save();
        store.log('system', `World rolled back to turn ${b.turn}`, 'By order of the Gamemaster.', actor, []);
        sim.scheduleAuto();
        broadcast('sync');
        return json(res, 200, { ok: true });
      }
      if (pathname === '/api/gm/import' && method === 'POST') {
        const b = await readBody(req, 32e6); // world exports can be large
        if (!b || typeof b !== 'object' || !b.settings || !Array.isArray(b.entities) || !Array.isArray(b.provinces)) {
          return bad('That file is not an Arcasia world export.');
        }
        await store.importWorld(b, u.user);
        // an old export may predate the SVG map document — upgrade in place
        if (mapdata.applyMap(store.get())) store.save();
        store.log('system', 'World restored from an exported archive', '', actor, []);
        sim.scheduleAuto();
        broadcast('sync');
        return json(res, 200, { ok: true });
      }
      if (pathname === '/api/gm/reset' && method === 'POST') {
        await store.reset(seed);
        store.log('system', 'World reset to the seed of 1962', '', actor, []);
        sim.scheduleAuto();
        broadcast('sync');
        return json(res, 200, { ok: true });
      }
      if (pathname === '/api/gm/settings' && method === 'PATCH') {
        const b = await readBody(req);
        const s = db.settings;
        for (const k of ['worldName', 'currency', 'currencyName', 'parliamentSeats']) if (b[k] !== undefined) s[k] = b[k];
        if (b.time) {
          const oldDate = s.time.date;
          const oldClock = s.time.clock || {};
          const oldRate = Number(oldClock.minutesPerRealMinute);
          const oldWorldMs = sim.worldClockNow(s.time, Date.now());
          const requestedClock = b.time.clock && b.time.clock.currentTime;
          Object.assign(s.time, b.time);
          // b.time.clock is the Studio form's echo and carries no anchor
          // fields — restore the live ones so an unchanged save keeps the
          // clock running from where it is instead of resetting to t.date.
          s.time.clock.anchorRealMs = Number(oldClock.anchorRealMs) || Date.now();
          s.time.clock.anchorWorldMs = Number(oldClock.anchorWorldMs) || (Date.parse(String(s.time.date || '1970-01-01') + 'T00:00:00Z') || Date.now());
          s.time.clock = s.time.clock || { enabled: true, minutesPerRealMinute: 59.5 };
          s.time.clock.rateVersion = 1;
          // Continuity rule (Phase 35 fix): saving World settings must never
          // TELEPORT the world clock. The Studio form always echoes back a
          // date and a time-of-day it rendered earlier; anchoring the clock
          // to that echo used to yank world time to "turn-date midnight +
          // HH:MM" on every save. With auto-advance off, the turn date drifts
          // away from the continuous clock, so each save flung the clock
          // days/weeks forward or backward — a forward jump let the cadence
          // scheduler replay the whole gap at once, completing capital
          // projects in seconds and minting days of stock instantly.
          // Re-anchor ONLY when the GM actually moved a hand: a different
          // date, a deliberately edited time-of-day, or a new clock rate.
          const m = String(requestedClock || '').match(/^(\d{1,2}):(\d{2})$/);
          const curTodMin = Math.floor((((oldWorldMs % 86400000) + 86400000) % 86400000) / 60000);
          const reqMin = m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : null;
          let todDist = reqMin === null ? 0 : Math.abs(reqMin - curTodMin) % 1440;
          if (todDist > 720) todDist = 1440 - todDist;
          // Echo tolerance: between rendering the form and hitting save the
          // live clock moves on (a real minute ≈ an hour of world time at
          // the default rate), so only a difference beyond ~2 hours of world
          // time counts as a deliberate edit rather than echo lag.
          const todEdited = reqMin !== null && todDist > 120;
          const changedDate = b.time.date !== undefined && String(b.time.date) !== String(oldDate);
          const rateChanged = !!(b.time.clock && b.time.clock.minutesPerRealMinute !== undefined &&
            Number(b.time.clock.minutesPerRealMinute) !== oldRate);
          if (changedDate || todEdited || rateChanged) {
            const modDay = ((oldWorldMs % 86400000) + 86400000) % 86400000;
            let base;
            if (changedDate) {
              // A deliberate date move keeps the current time-of-day unless
              // the GM also set one explicitly.
              const parsedDay = Date.parse(String(s.time.date || oldDate || '1970-01-01') + 'T00:00:00Z');
              base = (Number.isFinite(parsedDay) ? parsedDay : oldWorldMs - modDay) + (todEdited ? reqMin * 60000 : modDay);
            } else if (todEdited) {
              base = oldWorldMs - modDay + reqMin * 60000; // same world day, new time-of-day
            } else {
              base = oldWorldMs; // rate-only change: rebase so the instant survives
            }
            s.time.clock.anchorRealMs = Date.now();
            s.time.clock.anchorWorldMs = base;
            if (s.time.auto) s.time.auto.lastWorldMs = sim.worldClockNow(s.time, Date.now());
          }
          delete s.time.clock.currentTime;
          // editing the auto schedule restarts its clock — otherwise a stale
          // lastTick from a previous enable makes the serverless autoTick
          // "catch up" with a burst of turns the moment auto is re-enabled
          if (b.time.auto) { Object.assign(s.time.auto, b.time.auto); s.time.auto.lastTick = Date.now(); s.time.auto.lastWorldMs = sim.worldClockNow(s.time, Date.now()); }
        }
        if (b.registration) Object.assign(s.registration, b.registration);
        if (b.newsThresholds) Object.assign(s.newsThresholds, b.newsThresholds);
        if (b.taxation) {
          const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));
          const t = s.taxation = s.taxation || {};
          if (b.taxation.enabled !== undefined) t.enabled = !!b.taxation.enabled;
          if (b.taxation.corporateRate !== undefined) t.corporateRate = clamp(b.taxation.corporateRate);
          if (b.taxation.propertyRate !== undefined) t.propertyRate = clamp(b.taxation.propertyRate);
          if (b.taxation.vatRate !== undefined) t.vatRate = clamp(b.taxation.vatRate);
          if (b.taxation.gamblingRate !== undefined) t.gamblingRate = clamp(b.taxation.gamblingRate);
        }
        if (b.cadence) { // Phase 35 cadence intervals (world hours), clamped to engine-safe ranges
          const cd = s.cadence = s.cadence || {};
          for (const k of ['productionHours', 'demographicsHours', 'tradeResetHours']) {
            if (b.cadence[k] === undefined) continue;
            const n = Number(b.cadence[k]);
            if (!Number.isFinite(n)) continue;
            cd[k] = Math.max(0.25, Math.min(72, n));
          }
          if (b.cadence.conditionDecayPerHour !== undefined) {
            s.economy = s.economy || {};
            s.economy.conditionDecayPerHour = Math.max(0, Math.min(20, Number(b.cadence.conditionDecayPerHour) || 0));
          }
        }
        if (b.demographics) Object.assign(s.demographics, b.demographics);
        if (b.households) { // Phase 3 household tunables — merge so a partial
          // save never wipes sibling knobs; clamp to engine-safe ranges.
          const hh = s.households = s.households || {};
          const num = (v, d = 0) => (v === undefined ? d : Number(v));
          const clamp = (v, lo, hi, d) => Math.max(lo, Math.min(hi, num(v, d)));
          hh.enabled = b.households.enabled !== undefined ? !!b.households.enabled : (hh.enabled !== false);
          if (b.households.foodReqPerCapPerTurn !== undefined) hh.foodReqPerCapPerTurn = clamp(b.households.foodReqPerCapPerTurn, 0.01, 10);
          if (b.households.govFoodReleaseRate !== undefined) hh.govFoodReleaseRate = Math.max(0, num(b.households.govFoodReleaseRate));
          if (b.households.dependentStipend !== undefined) hh.dependentStipend = Math.max(0, num(b.households.dependentStipend));
          if (b.households.wageIncomeK !== undefined) hh.wageIncomeK = clamp(b.households.wageIncomeK, 0, 1);
          if (b.households.demoSyncStrength !== undefined) hh.demoSyncStrength = clamp(b.households.demoSyncStrength, 0, 1);
          if (b.households.studentGraduationRate !== undefined) hh.studentGraduationRate = clamp(b.households.studentGraduationRate, 0, 1);
          if (b.households.retirementRate !== undefined) hh.retirementRate = clamp(b.households.retirementRate, 0, 1);
          if (b.households.wcToMcRate !== undefined) hh.wcToMcRate = clamp(b.households.wcToMcRate, 0, 1);
          if (b.households.mcToUcRate !== undefined) hh.mcToUcRate = clamp(b.households.mcToUcRate, 0, 1);
          if (b.households.educationMobilityK !== undefined) hh.educationMobilityK = Math.max(0, num(b.households.educationMobilityK));
          if (b.households.oldAgeMortalityRate !== undefined) hh.oldAgeMortalityRate = clamp(b.households.oldAgeMortalityRate, 0, 0.5);
          if (b.households.diseaseMortalityK !== undefined) hh.diseaseMortalityK = Math.max(0, num(b.households.diseaseMortalityK));
          if (b.households.famineMortalityRate !== undefined) hh.famineMortalityRate = clamp(b.households.famineMortalityRate, 0, 0.5);
          if (b.households.stipendHappinessK !== undefined) hh.stipendHappinessK = Math.max(0, num(b.households.stipendHappinessK));
        }
        if (b.ambience) {
          s.ambience = s.ambience || {};
          if (b.ambience.traffic) {
            const tr = s.ambience.traffic = s.ambience.traffic || {};
            for (const k of ['enabled', 'presence', 'speed', 'size', 'fadeOutSeconds', 'fadeDurationSeconds']) {
              if (b.ambience.traffic[k] !== undefined) tr[k] = b.ambience.traffic[k];
            }
            tr.presence = Math.max(0, Math.min(100, Number(tr.presence) || 0));
            tr.speed = Math.max(0.05, Math.min(10, Number(tr.speed) || 1));
            tr.size = Math.max(0.25, Math.min(4, Number(tr.size) || 1));
            tr.fadeOutSeconds = Math.max(0.5, Math.min(300, Number(tr.fadeOutSeconds) || 8));
            tr.fadeDurationSeconds = Math.max(0.2, Math.min(20, Number(tr.fadeDurationSeconds) || 1.5));
            tr.enabled = tr.enabled !== false;
          }
        }
        if (b.entertainment) s.entertainment = b.entertainment; // GM Studio entertainment editor writes the whole object
        if (b.mapDecor && s.mapDecor) Object.assign(s.mapDecor, b.mapDecor);
        if (b.map) Object.assign(s.map = s.map || {}, b.map); // labels / roads / rails from the map editor
        if (b.music) s.music = b.music; // Phase 10 — GM Studio Presentation tab writes the whole object
        if (b.trade) { // GM Trade desk. Merge ONLY the authored fields so the engine's live order book / lastFlows / history survive a save.
          s.trade = s.trade || {};
          if (b.trade.partners) s.trade.partners = b.trade.partners;
          if (b.trade.tariffs) s.trade.tariffs = sanitizeTariffs(b.trade.tariffs);
          // partner edits reshape the market — reopen the order book at once
          try { sim.generateTradeOrders(db); } catch (e) { /* orders regenerate next turn */ }
        }
        if (b.economy) { // Phase 13 economy tunables — merge so a partial save (e.g. the GM Economy tab) never wipes sibling knobs
          const e = s.economy = s.economy || {};
          for (const k in b.economy) e[k] = b.economy[k];
          // GM levers are unbounded above — a GM may type any multiplier they
          // want; only a safety floor keeps values from going negative/zero.
          for (const k of ['domesticMultiplier', 'exportMultiplier', 'importMultiplier', 'expensesMultiplier']) {
            if (e[k] !== undefined) e[k] = Math.max(0.05, Number(e[k]) || 0.05);
          }
          // X100 leveraged trades (Phase 34): lever ×1 upwards, sale lock a
          // sane non-negative seconds count (0 disables the lock).
          if (e.x100Mult !== undefined) e.x100Mult = Math.max(1, Number(e.x100Mult) || 100);
          if (e.x100LockSec !== undefined) e.x100LockSec = Math.max(0, Math.min(86400, Number(e.x100LockSec) || 0));
        }
        if (b.election) { // Phase 33/34 — Election Commission knobs + campaign
          // catalogue. Whole-object replace of the authored sub-fields (the
          // engine adds nothing live here), then applyTuning re-derives any
          // live count's unrevealed ballots from the new deviation.
          s.election = s.election || {};
          if (b.election.campaigns !== undefined) s.election.campaigns = b.election.campaigns;
          if (b.election.durationDays !== undefined) s.election.durationDays = Math.max(1, Math.min(365, Math.round(Number(b.election.durationDays) || 14)));
          if (b.election.durationTurns !== undefined) s.election.durationDays = Math.max(1, Math.min(365, Math.round(Number(b.election.durationTurns) || 14)));
          if (b.election.deviationPct !== undefined) s.election.deviationPct = Math.max(0, Math.min(50, Number(b.election.deviationPct) || 0));
          if (b.election.supportToVotes !== undefined) s.election.supportToVotes = Math.max(0, Math.round(Number(b.election.supportToVotes) || 0));
          if (b.election.moneySupportBase !== undefined) s.election.moneySupportBase = Math.max(1, Number(b.election.moneySupportBase) || 40000000);
          if (b.election.supportScale !== undefined) s.election.supportScale = Math.max(0.1, Number(b.election.supportScale) || 3);
          if (b.election.materialCampaignRate !== undefined) s.election.materialCampaignRate = Math.max(0, Number(b.election.materialCampaignRate) || 200);
          if (b.election.campaignDiminish !== undefined) s.election.campaignDiminish = Math.max(0.01, Math.min(1, Number(b.election.campaignDiminish) || 0.6));
          election.applyTuning(db, s.election);
        }
        sim.scheduleAuto();
        store.log('system', 'World settings updated', '', actor, []);
        store.save(); broadcast('sync');
        return json(res, 200, { settings: s });
      }

      // users management
      if (pathname === '/api/gm/users' && method === 'POST') {
        const b = await readBody(req);
        const username = String(b.username || '').trim().toLowerCase();
        if (!/^[a-z0-9_.-]{3,24}$/.test(username)) return bad('Bad username.');
        if (db.users.some(x => x.username === username)) return bad('Username taken.');
        const { salt, hash } = hashPassword(String(b.password || 'arcasia'));
        const validPaperIds = new Set((db.settings.newspapers || []).map(p => p.id));
        const nu = {
          id: store.uid('user'), username, displayName: String(b.displayName || username).slice(0, 60), salt, passHash: hash,
          roleId: b.roleId || 'citizen', entityId: b.entityId || null,
          newspaperId: (b.newspaperId && validPaperIds.has(b.newspaperId)) ? b.newspaperId : null,
          created: Date.now(), lastLogin: null
        };
        db.users.push(nu);
        store.log('system', `Account created: ${nu.username} (${nu.roleId})`, '', actor, []);
        sim.syncPresidency(db);
        store.save(); broadcast('sync');
        return json(res, 200, { user: { id: nu.id, username: nu.username } });
      }
      m = pathname.match(/^\/api\/gm\/users\/([\w-]+)$/);
      if (m && (method === 'PATCH' || method === 'DELETE')) {
        const target = db.users.find(x => x.id === m[1]);
        if (!target) return bad('No such user.');
        if (method === 'DELETE') {
          if (target.id === u.user.id) return bad('You cannot delete yourself.');
          db.users = db.users.filter(x => x.id !== target.id);
          for (const sid in db.sessions) if (db.sessions[sid].userId === target.id) delete db.sessions[sid];
          store.log('system', `Account deleted: ${target.username}`, '', actor, []);
        } else {
          const b = await readBody(req);
          if (b.displayName !== undefined) target.displayName = String(b.displayName).slice(0, 60);
          if (b.roleId !== undefined) target.roleId = b.roleId;
          if (b.entityId !== undefined) target.entityId = b.entityId || null;
          if (b.newspaperId !== undefined) {
            const validPaperIds = new Set((db.settings.newspapers || []).map(p => p.id));
            target.newspaperId = (b.newspaperId && validPaperIds.has(b.newspaperId)) ? b.newspaperId : null;
          }
          if (b.password) { const { salt, hash } = hashPassword(String(b.password)); target.salt = salt; target.passHash = hash; }
          store.log('system', `Account updated: ${target.username}`, '', actor, []);
        }
        sim.syncPresidency(db);
        store.save(); broadcast('sync');
        return json(res, 200, { ok: true });
      }

      // generic collection CRUD
      m = pathname.match(/^\/api\/gm\/coll\/(\w+)(?:\/([\w’'.-]+))?$/);
      if (m && COLLS[m[1]]) {
        const coll = m[1];
        if (method === 'POST') {
          const b = await readBody(req);
          if (!b || typeof b !== 'object') return bad();
          // place map objects into a province by geometry unless one was given
          if ((coll === 'properties' || coll === 'markers') && b.pos && !b.provinceId) {
            const pid = geometry.provinceAt(db.provinces, b.pos);
            if (pid) b.provinceId = pid;
            else if (coll === 'properties') {
              // point fell outside every polygon (coastline gaps etc.) —
              // fall back to the nearest city's province
              let best = null, bd = Infinity;
              for (const c of db.cities) {
                if (!c.pos || !c.provinceId) continue;
                const d2 = (c.pos[0] - b.pos[0]) ** 2 + (c.pos[1] - b.pos[1]) ** 2;
                if (d2 < bd) { bd = d2; best = c.provinceId; }
              }
              if (best) b.provinceId = best;
            }
          }
          b.id = b.id && !db[coll].some(x => x.id === b.id) ? String(b.id) : store.uid(COLLS[coll]);
          if (coll === 'entities' && b.type === 'company' && b.wagePerTurn === undefined) b.wagePerTurn = 1;
          if (coll === 'properties') {
            // staffing/cap split (Phase 28b): new sites start fully staffed —
            // the cap is seeded from the authored headcount and stays a GM
            // constant; staffing itself is CEO-editable afterwards.
            if (b.employees !== undefined) b.employees = Math.max(0, Math.min(1000000, Math.round(Number(b.employees) || 0)));
            if (b.maxEmployees !== undefined) b.maxEmployees = Math.max(0, Math.round(Number(b.maxEmployees) || 0));
            else b.maxEmployees = Math.max(1, Math.round(b.employees || 1));
            buildings.assignTexture(b); // random variant for the kind
          }
          db[coll].push(b);
          if (coll === 'properties') deeds.syncAllDeeds(db); // issue the deed item
          if (coll === 'entities') market.syncAllCertificates(db); // mirror register edits into inventories
          store.log('gm', `Created ${coll.slice(0, -1)}: ${b.name || b.key || b.id}`, '', actor, [b.id]);
          store.save(); broadcast('sync');
          return json(res, 200, { id: b.id, obj: b });
        }
        if (method === 'PATCH' && m[2]) {
          const obj = db[coll].find(x => x.id === m[2]);
          if (!obj) return bad('Not found: ' + m[2]);
          const b = await readBody(req);
          if (coll === 'properties' && b.employees !== undefined) {
            b.employees = Math.max(0, Math.min(1000000, Math.round(Number(b.employees) || 0)));
          }
          if (coll === 'properties' && b.maxEmployees !== undefined) {
            b.maxEmployees = Math.max(0, Math.round(Number(b.maxEmployees) || 0));
          }
          if (coll === 'entities' && (obj.type === 'company' || b.type === 'company') && b.wagePerTurn !== undefined) {
            b.wagePerTurn = Math.max(0, Math.min(1000000, Math.round((Number(b.wagePerTurn) || 0) * 100) / 100));
          }
          if (coll === 'items' && b.marketValue !== undefined && b.marketValue !== obj.marketValue) {
            store.log('market', `${obj.name} repriced: ${db.settings.currency}${obj.marketValue} → ${db.settings.currency}${b.marketValue}`, 'Every inventory holding this item updates automatically.', actor, [obj.id]);
          }
          // re-home a dragged property/marker by geometry when pos moved and
          // the client didn't send an explicit provinceId override
          const posMoved = b.pos !== undefined && b.provinceId === undefined && (coll === 'properties' || coll === 'markers');
          const kindChanged = coll === 'properties' && b.kind !== undefined && b.kind !== obj.kind && b.texture === undefined;
          Object.assign(obj, b);
          if (kindChanged) buildings.assignTexture(obj, true); // re-roll the art for the new kind
          if (posMoved) {
            const pid = geometry.provinceAt(db.provinces, obj.pos);
            if (pid) obj.provinceId = pid;
          }
          if (coll === 'provinces' && obj.demographics) {
            obj.vars.population = Object.values(obj.demographics).reduce((s, g) => s + (g.population || 0), 0);
          }
          if (coll === 'properties') deeds.syncAllDeeds(db); // rename/revalue/re-home the deed
          if (coll === 'entities') market.syncAllCertificates(db); // Share-Register edits mirror into inventories immediately (no restart)
          store.log('gm', `Updated ${coll.slice(0, -1)}: ${obj.name || obj.key || obj.id}`, '', actor, [obj.id]);
          store.save(); broadcast('sync');
          return json(res, 200, { obj });
        }
        if (method === 'DELETE' && m[2]) {
          const obj = db[coll].find(x => x.id === m[2]);
          if (!obj) return bad('Not found.');
          if (coll === 'roles' && db.users.some(x => x.roleId === obj.id)) return bad('Role is in use by accounts.');
          cascadeDelete(coll, obj);
          db[coll] = db[coll].filter(x => x.id !== obj.id);
          if (coll === 'properties') deeds.syncAllDeeds(db); // retire the deed item
          if (coll === 'entities') market.syncAllCertificates(db); // drop stale certs when a shareholder entity is removed
          store.log('gm', `Deleted ${coll.slice(0, -1)}: ${obj.name || obj.key || obj.id}`, '', actor, []);
          store.save(); broadcast('sync');
          return json(res, 200, { ok: true });
        }
      }
      return json(res, 404, { error: 'Unknown GM endpoint' });
    }

    return json(res, 404, { error: 'Unknown API endpoint' });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

module.exports = { handle, broadcast };
