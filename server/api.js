'use strict';
const crypto = require('crypto');
const store = require('./store');
const sim = require('./sim');
const sb = require('./supabase');
const { seed, hashPassword } = require('./seed');

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
function readBody(req) {
  // Vercel's Node runtime pre-parses JSON bodies onto req.body.
  if (req.body !== undefined && req.body !== null) {
    return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body);
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 4e6) { reject(new Error('Body too large')); req.destroy(); } });
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
    entityId: u.user.entityId, roleId: u.user.roleId,
    role: { id: u.role.id, name: u.role.name, perms: u.role.perms }
  };
}

// ---------- permission-filtered world view --------------------------------
function filterState(u) {
  const db = store.get();
  const p = u.role.perms;
  const own = u.user.entityId;

  const accounts = p.accounts === 'all' ? db.accounts
    : p.accounts === 'own' ? db.accounts.filter(a => a.ownerId === own) : [];
  const visAcct = new Set(accounts.map(a => a.id));

  const transactions = (p.accounts === 'all' ? db.transactions
    : db.transactions.filter(t => (t.from && visAcct.has(t.from)) || (t.to && visAcct.has(t.to)))).slice(-400);

  const seeInv = (ownerId) => p.inventories === 'all' || (p.inventories === 'own' && ownerId === own);
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

  return {
    settings: db.settings,
    globalVars: p.statistics ? db.globalVars : { population: db.globalVars.population },
    variables: db.variables,
    entities, provinces, properties, accounts, transactions, news,
    cities: db.cities,
    items: db.items,
    timeline: db.timeline.slice(-400),
    elections: db.elections,
    events: p.gm ? db.events : undefined,
    roles: p.gm ? db.roles : db.roles.map(r => ({ id: r.id, name: r.name })),
    users: p.gm ? db.users.map(x => ({ id: x.id, username: x.username, displayName: x.displayName, roleId: x.roleId, entityId: x.entityId, lastLogin: x.lastLogin })) : undefined
  };
}

// ---------- GM collection CRUD -------------------------------------------
const COLLS = {
  entities: 'ent', provinces: 'prov', cities: 'city', properties: 'prop',
  items: 'item', events: 'ev', variables: 'var', roles: 'role', accounts: 'acct'
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
    if (pathname === '/api/state' && method === 'GET') return json(res, 200, { user: userPayload(u), state: filterState(u) });

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
      if (!u.role.perms.statistics && !u.role.perms.gm) return deny('Polling data requires statistics clearance.');
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
      if (!isGm && from.ownerId !== u.user.entityId) return deny('You do not control the source account.');
      if (!isGm && from.balance < amount) return bad('Insufficient funds.');
      sim.txn(from.id, to.id, amount, String(b.memo || '').slice(0, 140), u.user.displayName, 'transfer');
      store.save(); broadcast('sync');
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/trade' && method === 'POST') {
      const b = await readBody(req);
      const fromEnt = db.entities.find(e => e.id === (u.role.perms.gm && b.fromEntityId ? b.fromEntityId : u.user.entityId));
      const toEnt = db.entities.find(e => e.id === b.toEntityId);
      const item = db.items.find(i => i.id === b.itemId);
      const qty = Math.round(Number(b.qty));
      if (!fromEnt || !toEnt || !item) return bad('Unknown entity or item.');
      if (fromEnt.id === toEnt.id) return bad('Cannot trade with yourself.');
      if (!(qty > 0)) return bad('Quantity must be positive.');
      if (!item.tradable && !u.role.perms.gm) return deny('That item is not tradable.');
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

    // ---- newsroom ----
    if (pathname === '/api/news' && method === 'POST') {
      if (!u.role.perms.manageNews && !u.role.perms.gm) return deny('Press credentials required.');
      const b = await readBody(req);
      if (!b.headline) return bad('A headline is required.');
      const a = sim.draftNews(String(b.headline).slice(0, 200), String(b.body || '').slice(0, 8000), String(b.category || 'General').slice(0, 40), !!b.publish, u.user.displayName);
      store.save(); broadcast('sync');
      return json(res, 200, { article: a });
    }
    let m = pathname.match(/^\/api\/news\/([\w-]+)$/);
    if (m && (method === 'PATCH' || method === 'DELETE')) {
      if (!u.role.perms.manageNews && !u.role.perms.gm) return deny('Press credentials required.');
      const idx = db.news.findIndex(n => n.id === m[1]);
      if (idx < 0) return bad('No such article.');
      if (method === 'DELETE') {
        const [gone] = db.news.splice(idx, 1);
        store.log('news', 'Article deleted: ' + gone.headline, '', u.user.displayName, []);
      } else {
        const b = await readBody(req);
        const a = db.news[idx];
        for (const k of ['headline', 'body', 'category', 'status']) if (b[k] !== undefined) a[k] = String(b[k]);
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
        const ran = sim.runEvent(ev, actor);
        if (!ran) store.log('simulation', `Event “${ev.name}” did not run`, 'Conditions were not met.', actor, [ev.id]);
        sim.updateDerived();
        store.save(); broadcast('sync');
        return json(res, 200, { ran });
      }
      if (pathname === '/api/gm/election' && method === 'POST') {
        const rec = sim.runElection(actor);
        return json(res, 200, { election: rec });
      }
      if (pathname === '/api/gm/test-expr' && method === 'POST') {
        const b = await readBody(req);
        try { return json(res, 200, { value: sim.evalExpr(String(b.expr || ''), { vars: db.globalVars }) }); }
        catch (e) { return json(res, 200, { error: e.message }); }
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
      if (pathname === '/api/gm/snapshots' && method === 'GET') return json(res, 200, { snapshots: await store.listSnapshots() });
      if (pathname === '/api/gm/export' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="arcasia-world.json"' });
        return res.end(JSON.stringify(db, null, 1));
      }
      if (pathname === '/api/gm/rollback' && method === 'POST') {
        const b = await readBody(req);
        await store.rollback(Math.round(Number(b.turn)));
        store.log('system', `World rolled back to turn ${b.turn}`, 'By order of the Gamemaster.', actor, []);
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
        if (b.demographics) Object.assign(s.demographics, b.demographics);
        if (b.mapDecor) Object.assign(s.mapDecor, b.mapDecor);
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
        const nu = { id: store.uid('user'), username, displayName: String(b.displayName || username).slice(0, 60), salt, passHash: hash, roleId: b.roleId || 'citizen', entityId: b.entityId || null, created: Date.now(), lastLogin: null };
        db.users.push(nu);
        store.log('system', `Account created: ${nu.username} (${nu.roleId})`, '', actor, []);
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
          if (b.password) { const { salt, hash } = hashPassword(String(b.password)); target.salt = salt; target.passHash = hash; }
          store.log('system', `Account updated: ${target.username}`, '', actor, []);
        }
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
          b.id = b.id && !db[coll].some(x => x.id === b.id) ? String(b.id) : store.uid(COLLS[coll]);
          db[coll].push(b);
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
          Object.assign(obj, b);
          if (coll === 'provinces' && obj.demographics) {
            obj.vars.population = Object.values(obj.demographics).reduce((s, g) => s + (g.population || 0), 0);
          }
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
