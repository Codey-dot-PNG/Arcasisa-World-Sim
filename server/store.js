'use strict';
// World store with two interchangeable backends:
//
//   file      — single node process; world in memory, flushed atomically to
//               data/world.json; per-turn snapshot files. (local hosting)
//   supabase  — serverless; world doc in a Postgres JSONB row, append-only
//               timeline/transaction tables, snapshot rows. Each request
//               begin()s (load or reuse warm cache) and commit()s (flush
//               pending writes + realtime "sync" ping). (Vercel hosting)
//
// The mutation API is synchronous in both modes so sim.js/api.js stay
// identical: handlers mutate the in-memory db, and persistence happens at
// the edges (debounced save locally, commit() per request in the cloud).
const fs = require('fs');
const path = require('path');
const sb = require('./supabase');

const MODE = sb.enabled ? 'supabase' : 'file';

// DATA_DIR is relocatable so the world file can live on a mounted persistent
// volume rather than inside the app directory.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'world.json');
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
const SNAP_KEEP = 60;
const TIMELINE_CAP = 8000;
const LOG_FETCH = 400; // recent timeline/transactions loaded per request in cloud mode

let db = null;
let seedFn = null;
let version = 0;            // cloud: value of world.version we loaded
let dirty = false;
let broadcastPending = false;
let pendingTimeline = [];
let pendingTxns = [];
let pendingSnapshot = null; // at most one snapshot per request
let saveTimer = null;

function uid(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- row mapping (cloud tables use snake_case columns) ---------- */
const tlRow = (e) => ({ id: e.id, ts: e.ts, turn: e.turn, sim_date: e.simDate, type: e.type, title: e.title, detail: e.detail, actor: e.actor, refs: e.refs || [] });
const fromTlRow = (r) => ({ id: r.id, ts: Number(r.ts), turn: r.turn, simDate: r.sim_date, type: r.type, title: r.title, detail: r.detail, actor: r.actor, refs: r.refs || [] });
const txRow = (t) => ({ id: t.id, ts: t.ts, turn: t.turn, sim_date: t.simDate, from_acct: t.from, to_acct: t.to, amount: t.amount, memo: t.memo, actor: t.actor, kind: t.kind });
const fromTxRow = (r) => ({ id: r.id, ts: Number(r.ts), turn: r.turn, simDate: r.sim_date, from: r.from_acct, to: r.to_acct, amount: Number(r.amount), memo: r.memo, actor: r.actor, kind: r.kind });

// The world doc stored in Postgres excludes the two append-only logs.
function coreDoc() {
  return { ...db, timeline: [], transactions: [] };
}

/* ---------- lifecycle ---------- */
function configure(seed) { seedFn = seed; }

// Long-lived entry point (server.js). In file mode this loads the world now;
// in cloud mode begin() does the work per request.
async function load(seed, reseed) {
  configure(seed);
  if (MODE === 'file') {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    if (!reseed && fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    else { db = seedFn(); saveNow(); }
    return db;
  }
  if (reseed) await reset(seedFn);
  else await begin();
  return db;
}

// Per-request entry point. Loads the world (or reuses the warm in-memory
// copy when the stored version hasn't changed) and resets pending buffers.
async function begin() {
  if (MODE === 'file') {
    if (!db) await load(seedFn);
    return db;
  }
  pendingTimeline = []; pendingTxns = []; pendingSnapshot = null;
  dirty = false; broadcastPending = false;

  const meta = await sb.select('world', 'id=eq.1&select=version');
  if (!meta || !meta.length) return firstSeed();

  if (!db || Number(meta[0].version) !== version) {
    const rows = await sb.select('world', 'id=eq.1&select=version,doc');
    version = Number(rows[0].version);
    db = rows[0].doc;
    const tl = await sb.select('timeline', `select=*&order=ts.desc&limit=${LOG_FETCH}`);
    db.timeline = tl.reverse().map(fromTlRow);
    const tx = await sb.select('transactions', `select=*&order=ts.desc&limit=${LOG_FETCH}`);
    db.transactions = tx.reverse().map(fromTxRow);
  }
  return db;
}

async function firstSeed() {
  db = seedFn();
  const seedTl = db.timeline.slice();
  const seedTx = db.transactions.slice();
  version = Date.now();
  await sb.insert('world', [{ id: 1, version, doc: coreDoc() }]);
  if (seedTl.length) await sb.insert('timeline', seedTl.map(tlRow));
  if (seedTx.length) await sb.insert('transactions', seedTx.map(txRow));
  dirty = false;
  return db;
}

// Flush everything this request changed, then ping clients. Cloud mode only;
// in file mode the debounced save() already covers persistence and SSE covers
// the ping.
async function commit() {
  if (MODE === 'file') return;
  try {
    if (pendingSnapshot) {
      await sb.upsert('snapshots', [pendingSnapshot]);
      await sb.rpc('prune_arcasia').catch(() => { }); // keeps logs/snapshots bounded
    }
    if (pendingTimeline.length) await sb.insert('timeline', pendingTimeline.map(tlRow));
    if (pendingTxns.length) await sb.insert('transactions', pendingTxns.map(txRow));
    if (dirty) {
      version = Date.now();
      await sb.update('world', 'id=eq.1', { version, doc: coreDoc() });
    }
    if (dirty || broadcastPending) await sb.broadcast('world', 'sync');
  } finally {
    pendingTimeline = []; pendingTxns = []; pendingSnapshot = null;
    dirty = false; broadcastPending = false;
  }
}

function get() { return db; }

/* ---------- persistence primitives ---------- */
function saveNow() {
  if (MODE !== 'file' || !db) return;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

// Universal "something changed" marker. File mode debounces a disk write;
// cloud mode flags the doc for commit().
function save() {
  dirty = true;
  if (MODE !== 'file') return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { saveNow(); } catch (e) { console.error('save failed:', e.message); }
  }, 400);
}

function requestBroadcast() { broadcastPending = true; }

/* ---------- snapshots ---------- */
function snapshot() {
  if (MODE === 'file') {
    const file = path.join(SNAP_DIR, `turn-${String(db.settings.time.turn).padStart(5, '0')}.json`);
    fs.writeFileSync(file, JSON.stringify(db));
    // prune by write time, not turn number — after a rollback or reset the
    // freshest snapshots can carry lower turn numbers than stale ones
    const all = fs.readdirSync(SNAP_DIR).filter(f => f.startsWith('turn-'))
      .map(f => ({ f, mtime: fs.statSync(path.join(SNAP_DIR, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    while (all.length > SNAP_KEEP) fs.unlinkSync(path.join(SNAP_DIR, all.shift().f));
    return;
  }
  // one snapshot per request: a multi-turn advance archives the state it started from
  if (!pendingSnapshot) pendingSnapshot = { turn: db.settings.time.turn, ts: Date.now(), doc: { ...db } };
}

async function listSnapshots() {
  if (MODE === 'file') {
    return fs.readdirSync(SNAP_DIR).filter(f => f.startsWith('turn-')).sort().map(f => {
      const st = fs.statSync(path.join(SNAP_DIR, f));
      return { turn: parseInt(f.slice(5, 10), 10), bytes: st.size, mtime: st.mtimeMs };
    });
  }
  const rows = await sb.select('snapshots', 'select=turn,ts&order=turn.asc');
  return rows.map(r => ({ turn: r.turn, mtime: Number(r.ts) }));
}

async function rollback(turn) {
  let restored;
  if (MODE === 'file') {
    const file = path.join(SNAP_DIR, `turn-${String(turn).padStart(5, '0')}.json`);
    if (!fs.existsSync(file)) throw new Error('No snapshot for turn ' + turn);
    restored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    const rows = await sb.select('snapshots', `turn=eq.${Math.round(turn)}&select=doc`);
    if (!rows.length) throw new Error('No snapshot for turn ' + turn);
    restored = rows[0].doc;
    // the audit log is permanent — keep the current view of it
    restored.timeline = db.timeline;
    restored.transactions = db.transactions;
  }
  // keep operator accounts/sessions/roles from the live world so nobody is locked out
  restored.users = db.users;
  restored.sessions = db.sessions;
  restored.roles = db.roles;
  db = restored;
  if (MODE === 'file') saveNow(); else save();
  return db;
}

async function reset(seed) {
  db = (seed || seedFn)();
  if (MODE === 'file') {
    // a new world starts with a clean archive
    for (const f of fs.readdirSync(SNAP_DIR)) {
      if (f.startsWith('turn-')) { try { fs.unlinkSync(path.join(SNAP_DIR, f)); } catch (e) { } }
    }
    saveNow();
    return db;
  }
  const seedTl = db.timeline.slice();
  const seedTx = db.transactions.slice();
  await sb.del('timeline', 'ts=gt.0');
  await sb.del('transactions', 'ts=gt.0');
  await sb.del('snapshots', 'turn=gte.0');
  if (seedTl.length) await sb.insert('timeline', seedTl.map(tlRow));
  if (seedTx.length) await sb.insert('transactions', seedTx.map(txRow));
  save();
  return db;
}

/* ---------- audit log ---------- */
// Central audit log: every mutation of consequence goes through here.
function log(type, title, detail, actor, refs) {
  const e = {
    id: uid('tl'),
    ts: Date.now(),
    turn: db.settings.time.turn,
    simDate: db.settings.time.date,
    type, title,
    detail: detail || '',
    actor: actor || 'SYSTEM',
    refs: refs || []
  };
  db.timeline.push(e);
  if (db.timeline.length > TIMELINE_CAP) db.timeline.splice(0, db.timeline.length - TIMELINE_CAP);
  if (MODE !== 'file') pendingTimeline.push(e);
  save();
  return e;
}

// Transactions are appended here so the cloud backend can mirror them into
// their own table.
function recordTxn(t) {
  db.transactions.push(t);
  if (db.transactions.length > 12000) db.transactions.splice(0, db.transactions.length - 12000);
  if (MODE !== 'file') pendingTxns.push(t);
}

function byId(coll, id) { return (db[coll] || []).find(x => x.id === id); }

module.exports = {
  MODE, configure, load, begin, commit, get, save, saveNow, requestBroadcast,
  snapshot, listSnapshots, rollback, reset, log, recordTxn, uid, byId, DATA_DIR
};
