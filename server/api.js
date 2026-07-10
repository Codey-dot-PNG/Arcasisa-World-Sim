'use strict';
const crypto = require('crypto');
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

const COOKIE_EXTRA = process.env.VERCEL ? '; Secure' : '';

// ---------- SSE hub (file mode) / realtime ping (cloud mode) ---------------
const sseClients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data || {})}\n\n`;
  for (const c of sseClients) { try { c.res.write(msg); } catch (e) { sseClients.delete(c); } }
  if (type === 'sync') store.requestBroadcast(); // flushed by store.commit() in cloud mode
}
setInterval(() => broadcast('ping', { t: Date.now() }), 25000).unref();

// ---------- helpers -------------------------------------------------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
  return true; // handled — the static server must not touch this response
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
  return { global: pair(raw.global), byCountry: map(raw.byCountry), byCompany: map(raw.byCompany) };
}
function readBody(req, maxBytes) {
  const cap = maxBytes || 4e6;
  // Vercel's Node runtime pre-parses JSON bodies onto req.body.
  if (req.body !== undefined && req.body !== null) {
    return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body);
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > cap) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('Invalid JSON')); } });
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
    role: { id: u.role.id, name: u.role.name, perms: u.role.perms }
  };
}

// ---------- permission-filtered world view --------------------------------
function filterState(u) {
  const db = store.get();
  const p = u.role.perms;
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
      delete out.vars; delete out.shareholders; delete out.sharesOutstanding;
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

  const news = (p.manageNews ? db.news : db.news.filter(n => n.status === 'published')).slice(-300);

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

  return {
    settings: db.settings,
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
    history: p.statistics ? (db.history || []) : (db.history || []).map(h => ({ turn: h.turn, shares: h.shares })),
    timeline, trades,
    elections: db.elections,
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
    }
    for (const uu of db.users) if (uu.entityId === obj.id) uu.entityId = null;
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

// ---------- request handling ----------------------------------------------
async function handle(req, res, pathname, method) {
  if (!pathname.startsWith('/api/')) return false;
  const db = store.get();
  const u = getUser(req);
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
      const authed = (secret && (req.headers.authorization === 'Bearer ' + secret || q.get('key') === secret)) || (u && u.role.perms.gm);
      if (!authed) return deny('Cron secret or GM session required.');
      const result = sim.autoTick('AUTO');
      return json(res, 200, result);
    }

    // ---- auth ----
    if (pathname === '/api/auth/login' && method === 'POST') {
      const b = await readBody(req);
      const user = db.users.find(x => x.username.toLowerCase() === String(b.username || '').toLowerCase());
      if (!user) return json(res, 401, { error: 'Unknown operator or wrong passphrase.' });
      const hash = crypto.scryptSync(String(b.password || ''), user.salt, 32).toString('hex');
      if (hash !== user.passHash) return json(res, 401, { error: 'Unknown operator or wrong passphrase.' });
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
      if (cur !== u.user.passHash) return bad('Current passphrase incorrect.');
      if (String(b.new || '').length < 4) return bad('New passphrase too short.');
      const { salt, hash } = hashPassword(String(b.new));
      u.user.salt = salt; u.user.passHash = hash;
      store.save();
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/state' && method === 'GET') {
      // Serverless-friendly Day Market advance: ride this fetch to tick the
      // market on wall-clock cadence (gated, so at most once per window). On a
      // real tick, persist + signal so every client refetches the new prices —
      // this is what gives Vercel deployments a live ~5s market with no timer.
      try { if (market.maybeDayTick(db)) { store.save(); broadcast('sync'); } } catch (e) { /* market optional */ }
      return json(res, 200, { user: userPayload(u), state: filterState(u), v: store.getVersion() });
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

    if (pathname === '/api/polling' && method === 'GET') {
      // public political knowledge — newspapers publish polls; every operator
      // may see the party-support landscape (national and per province)
      const { national, totalVotes, byProvince } = sim.computePolling(false);
      const pct = {}; for (const pid in national) pct[pid] = Math.round(national[pid] / (totalVotes || 1) * 1000) / 10;
      const provPct = {};
      for (const provId in byProvince) {
        const votes = byProvince[provId]; const tot = Object.values(votes).reduce((a, b) => a + b, 0) || 1;
        provPct[provId] = {}; for (const pid in votes) provPct[provId][pid] = Math.round(votes[pid] / tot * 1000) / 10;
      }
      return json(res, 200, { national: pct, byProvince: provPct });
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
      if (!isGm && !ownership.controls(u.user.entityId, from.ownerId)) return deny('You do not control the source account.');
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

    if (pathname === '/api/trade' && method === 'POST') {
      const b = await readBody(req);
      // A controller may send from any entity in their ownership chain (their
      // company, its subsidiaries, …), not just their own person.
      const fromEnt = db.entities.find(e => e.id === (b.fromEntityId || u.user.entityId));
      const toEnt = db.entities.find(e => e.id === b.toEntityId);
      const item = db.items.find(i => i.id === b.itemId);
      const qty = Math.round(Number(b.qty));
      if (!fromEnt || !toEnt || !item) return bad('Unknown entity or item.');
      if (!u.role.perms.gm && !ownership.controls(u.user.entityId, fromEnt.id)) return deny('You do not control that entity.');
      if (fromEnt.id === toEnt.id) return bad('Cannot trade with yourself.');
      if (!(qty > 0)) return bad('Quantity must be positive.');
      if (!item.tradable && !u.role.perms.gm) return deny('That item is not tradable.');
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
      const qty = Math.round(Number(b.qty));
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

    // ---- negotiated trade offers (Phase 4.3) ----
    // Instant transfers (above) move goods immediately; these are proposals
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
        .map(r => ({ itemId: String(r.itemId || ''), qty: Math.round(Number(r.qty)) }))
        .filter(r => r.itemId && r.qty > 0 && db.items.some(i => i.id === r.itemId));
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
      const hasQty = (ent, itemId, qty) => {
        const row = (ent.inventory || []).find(r => r.itemId === itemId);
        return row && row.qty >= qty;
      };
      for (const r of trade.give) if (!hasQty(fromEnt, r.itemId, r.qty)) return bad(`${fromEnt.name} no longer holds enough ${(db.items.find(i => i.id === r.itemId) || {}).name || r.itemId}.`);
      for (const r of trade.get) if (!hasQty(toEnt, r.itemId, r.qty)) return bad(`${toEnt.name} no longer holds enough ${(db.items.find(i => i.id === r.itemId) || {}).name || r.itemId}.`);
      const fromAcct = sim.primaryAccount(fromEnt.id, false);
      const toAcct = sim.primaryAccount(toEnt.id, false);
      if (trade.money.give > 0 && !gm && (!fromAcct || fromAcct.balance < trade.money.give)) return bad(`${fromEnt.name} has insufficient funds.`);
      if (trade.money.get > 0 && !gm && (!toAcct || toAcct.balance < trade.money.get)) return bad(`${toEnt.name} has insufficient funds.`);

      const moveItem = (fromE, toE, itemId, qty) => {
        const item = db.items.find(i => i.id === itemId);
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
    // the domestic market) — and the wage index. Goods held as stock are traded
    // on the open market or via trade offers. Editable by the company's
    // controller (CEO or owner chain) or GM.
    m = pathname.match(/^\/api\/company\/([\w-]+)\/controls$/);
    if (m && method === 'PATCH') {
      const co = db.entities.find(e => e.id === m[1] && e.type === 'company');
      if (!co) return bad('No such company.');
      const gm = u.role.perms.gm;
      if (!gm && !ownership.controls(u.user.entityId, co.id)) return deny('You do not control this company.');
      const b = await readBody(req);
      const clampPct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
      const clampWage = (n) => Math.max(0, Math.min(300, Math.round(Number(n) || 0)));
      if (b.keepPct !== undefined) co.keepPct = clampPct(b.keepPct);
      if (b.wage !== undefined) co.wage = clampWage(b.wage);
      store.log('economy', `${co.name} adjusts operations`, `keep ${co.keepPct || 0}% in stock · wage ${co.wage}`, u.user.displayName, [co.id]);
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true, company: { id: co.id, keepPct: co.keepPct, wage: co.wage } });
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

    // ---- stock market (Phase 4.4) ----
    if (pathname === '/api/market/buy' && method === 'POST') {
      const b = await readBody(req);
      const gm = u.role.perms.gm;
      const buyerId = b.entityId && (gm || ownership.controls(u.user.entityId, b.entityId)) ? b.entityId : u.user.entityId;
      if (!buyerId) return bad('No entity to trade for.');
      try { const r = market.buy(b.companyId, buyerId, b.shares, u.user.displayName, { gm }); store.save(); broadcast('sync'); return json(res, 200, r); }
      catch (e) { return bad(e.message); }
    }
    if (pathname === '/api/market/sell' && method === 'POST') {
      const b = await readBody(req);
      const gm = u.role.perms.gm;
      const sellerId = b.entityId && (gm || ownership.controls(u.user.entityId, b.entityId)) ? b.entityId : u.user.entityId;
      if (!sellerId) return bad('No entity to trade for.');
      if (!gm && !ownership.controls(u.user.entityId, sellerId)) return deny('You do not control that holder.');
      try { const r = market.sell(b.companyId, sellerId, b.shares, u.user.displayName, { gm }); store.save(); broadcast('sync'); return json(res, 200, r); }
      catch (e) { return bad(e.message); }
    }
    if (pathname === '/api/market/transfer' && method === 'POST') {
      const b = await readBody(req);
      const gm = u.role.perms.gm;
      const fromId = b.fromEntityId && (gm || ownership.controls(u.user.entityId, b.fromEntityId)) ? b.fromEntityId : u.user.entityId;
      if (!gm && !ownership.controls(u.user.entityId, fromId)) return deny('You do not control that holder.');
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
      store.save(); broadcast('sync');
      return json(res, 200, { article: a });
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
        for (const k of ['headline', 'body', 'category', 'status', 'paperId']) if (b[k] !== undefined) a[k] = String(b[k]);
        if (b.status === 'published') store.log('news', 'Published: ' + a.headline, a.category, u.user.displayName, [a.id]);
      }
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true });
    }

    // ---- GM ----
    if (pathname.startsWith('/api/gm/')) {
      if (!u.role.perms.gm) return deny('Gamemaster clearance required.');
      const actor = 'GM ' + u.user.displayName;

      if (pathname === '/api/gm/advance' && method === 'POST') {
        const b = await readBody(req);
        const time = sim.advanceTurn(Math.round(Number(b.steps) || 1), actor);
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
          try { ran = sim.runEvent(ev, actor); } catch (e) { err = e.message; }
          const after = store.get();
          const diff = { globalVars: [], provinces: [], moneyMoved: 0, news: [] };
          if (ran) {
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
            const beforeTxCount = (before.transactions || []).length;
            const newTxns = (after.transactions || []).slice(beforeTxCount);
            diff.moneyMoved = newTxns.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);
            const beforeNewsIds = new Set((before.news || []).map(a => a.id));
            diff.news = (after.news || []).filter(a => !beforeNewsIds.has(a.id)).map(a => ({ id: a.id, headline: a.headline, paperId: a.paperId }));
          }
          // restore the live db in place — callers elsewhere hold the same
          // reference returned by store.get(), so we mutate it rather than
          // reassign.
          const live = store.get();
          for (const k of Object.keys(live)) delete live[k];
          Object.assign(live, before);
          if (err) return json(res, 200, { dryRun: true, ran: false, error: err, diff });
          return json(res, 200, { dryRun: true, ran, diff });
        }
        const ran = sim.runEvent(ev, actor);
        if (!ran) store.log('simulation', `Event “${ev.name}” did not run`, 'Conditions were not met.', actor, [ev.id]);
        sim.updateDerived();
        store.save(); broadcast('sync');
        return json(res, 200, { ran });
      }
      if (pathname === '/api/gm/election' && method === 'POST') {
        const b = await readBody(req);
        try {
          const rec = sim.runElection(actor, b && b.manual ? b.manual : undefined);
          return json(res, 200, { election: rec });
        } catch (e) { return bad(e.message); }
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
        const qty = Math.round(Number(b.qty));
        if (!fromE || !toE) return bad('Pick a valid source and destination holder.');
        if (fromE.id === toE.id) return bad('Source and destination are the same.');
        if (!item) return bad('Unknown item.');
        if (!(qty > 0)) return bad('Quantity must be positive.');
        try {
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
        if (b.time) { Object.assign(s.time, b.time); if (b.time.auto) Object.assign(s.time.auto, b.time.auto); }
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
        if (b.demographics) Object.assign(s.demographics, b.demographics);
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
        if (b.economy) s.economy = b.economy; // Phase 13 — economy tunables (baseDailyWage, wage nudges)
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
          if (coll === 'properties') buildings.assignTexture(b); // random variant for the kind
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
