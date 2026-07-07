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

// A serverless/container host in file mode has no durable storage — the world
// is lost on every redeploy or cold start. Make that impossible to miss.
if (MODE === 'file' && (process.env.VERCEL || process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.K_SERVICE)) {
  console.error('\n  ############################################################');
  console.error('  ##  NO DATABASE CONFIGURED — DATA WILL NOT SURVIVE       ##');
  console.error('  ##  redeploys or cold starts on this host.               ##');
  console.error('  ##  Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and     ##');
  console.error('  ##  redeploy. See DEPLOY.md.                             ##');
  console.error('  ############################################################\n');
}

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

// Bring a world loaded from disk/DB up to the current schema. Idempotent and
// additive — safe to run on every load. Returns true if anything changed so
// callers can persist. New collections/fields introduced by later phases add
// their defaults here so live worlds upgrade without a reset.
function migrate(world) {
  if (!world) return false;
  let changed = false;
  const need = (key, def) => { if (world[key] === undefined) { world[key] = def; changed = true; } };
  need('markers', []);                    // Phase 1.4 — event markers
  need('history', []);                    // Phase 7.1 — time-series for charts
  need('trades', []);                     // Phase 4.3 — negotiated trade offers
  // Phase 5 — newspapers. Fixed four-paper list; additive so a GM rename of
  // an existing paper is never clobbered by re-running this migration.
  if (world.settings && !world.settings.newspapers) {
    world.settings.newspapers = [
      { id: 'paper_today', name: 'Arcasia Today', tagline: '-HEART OF ARCASIA-', city: 'Lachevan', style: 'today', owner: 'This newspaper is owned by the State corporation ARC' },
      { id: 'paper_herald', name: 'The National Herald', tagline: 'VOICE OF THE NATION', city: 'Lachevan', style: 'herald', owner: 'This newspaper is funded by the NFP' },
      { id: 'paper_economists', name: 'Economists', tagline: 'MARKETS · TRADE · INDUSTRY', city: 'Lachevan', style: 'economists', owner: 'This newspaper is owned by the Satrom group' },
      { id: 'paper_radical', name: 'Radical', tagline: '-THE VOICE OF ARCASIA-', city: 'Kordi', style: 'radical', owner: 'This is an independent newspaper' }
    ];
    changed = true;
  }
  if (world.settings && !world.settings.newspaperRouting) {
    world.settings.newspaperRouting = { Politics: 'paper_today', Regional: 'paper_herald', Foreign: 'paper_herald', Economy: 'paper_economists', Business: 'paper_economists' };
    changed = true;
  }
  // Phase 10 — Audio & Presentation. Same default shape as a fresh seed
  // (see seed.js) so a live world upgrades with a usable Music Library /
  // playlist instead of an empty one. Additive only — never overwrites a
  // GM's existing music config.
  if (world.settings && !world.settings.music) {
    world.settings.music = {
      enabled: false,
      shuffle: true,
      volume: 0.7,
      library: [
        { id: 'trk_seed1', title: 'Suzerain: Rizia OST — Stress', url: '' },
        { id: 'trk_seed2', title: 'Suzerain: Rizia OST — Assembly', url: '' },
        { id: 'trk_seed3', title: 'Suzerain: Rizia OST — The Republic', url: '' },
        { id: 'trk_seed4', title: 'Suzerain: Rizia OST — Election Night', url: '' },
        { id: 'trk_seed5', title: 'Suzerain: Rizia OST — Reflection', url: '' }
      ],
      playlists: [
        { id: 'plist_default', name: 'Default Soundtrack', tracks: ['trk_seed1', 'trk_seed2', 'trk_seed3', 'trk_seed4', 'trk_seed5'] }
      ],
      activePlaylist: 'plist_default',
      forcedTrack: null
    };
    changed = true;
  }
  if (world.settings) {
    const validPaperIds = new Set((world.settings.newspapers || []).map(p => p.id));
    const routing = world.settings.newspaperRouting || {};
    const defaultPaper = validPaperIds.has('paper_today') ? 'paper_today' : (world.settings.newspapers || [])[0] && world.settings.newspapers[0].id;
    for (const n of (world.news || [])) {
      if (!n.paperId || !validPaperIds.has(n.paperId)) {
        n.paperId = routing[n.category] || defaultPaper;
        changed = true;
      }
    }
    // journalist users (and any user otherwise missing one) default to the
    // state paper unless already assigned.
    for (const uu of (world.users || [])) {
      if (uu.newspaperId === undefined) {
        uu.newspaperId = uu.roleId === 'journalist' ? defaultPaper : null;
        changed = true;
      }
    }
  }
  // Phase 4.4 — stock-market fields on companies (trust also used by Phase 9)
  for (const e of (world.entities || [])) {
    if (e.type !== 'company') continue;
    if (e.trust === undefined) { e.trust = 50; changed = true; }
    if (e.publicFloat === undefined) { e.publicFloat = 15; changed = true; }
    if (e.sharePrice === undefined) {
      const val = (e.vars && e.vars.valuation) || 0;
      e.sharePrice = e.sharesOutstanding ? Math.max(1, Math.round(val / e.sharesOutstanding * 100) / 100) : 100;
      changed = true;
    }
  }
  // reconcile share certificates against the canonical register (Phase 4.4)
  try { if (require('./market').syncAllCertificates(world)) changed = true; }
  catch (e) { /* market module optional during early boot */ }

  // Currency → Arcasian Koren (₳, code ARK). Ungated: only flips the old
  // default 'K' symbol, so a GM's custom symbol is left alone.
  if (world.settings) {
    if (world.settings.currency === 'K') { world.settings.currency = '₳'; changed = true; }
    if (world.settings.currencyName === 'Arcasian Mark' || !world.settings.currencyName) {
      world.settings.currencyName = 'Arcasian Koren'; changed = true;
    }
  }

  // ---- Phase 11 — one-time world-data update -----------------------------
  // Gated on schema so this block runs exactly once per world: fresh seeds
  // are born at schema 2 (see seed.js) and skip it entirely; a live world
  // loaded at schema 1 (or missing schema) runs it here and is bumped to 2,
  // so a second migrate() pass over the same world is a no-op.
  if ((world.schema || 1) < 2) {
    // 1. Remove the Kordistan FOREIGN POWER only — the domestic Kordi
    //    province and its city are untouched.
    const kordistanEntity = (world.entities || []).find(e => e.id === 'for_kordistan' || (e.type === 'foreign' && /^kordistan$/i.test(e.name || '')));
    if (kordistanEntity) {
      const kid = kordistanEntity.id;
      world.entities = world.entities.filter(e => e.id !== kid);
      world.accounts = (world.accounts || []).filter(a => a.ownerId !== kid);
      if (world.settings && world.settings.map) {
        if (Array.isArray(world.settings.map.countries)) {
          world.settings.map.countries = world.settings.map.countries.filter(c => c.entityId !== kid && !/^kordistan$/i.test(c.name || ''));
        }
        if (Array.isArray(world.settings.map.labels)) {
          world.settings.map.labels = world.settings.map.labels.filter(l => !/kordistan/i.test(l.text || ''));
        }
      }
      changed = true;
    }

    // 2. Currency rename is handled by the ungated migration above.

    // 3. Arcasia national profile card (Population view + Government dossier).
    if (world.settings && !world.settings.country) {
      world.settings.country = {
        leader: null,
        government: 'Semi-Presidential Republic (no Prime Minister)',
        economy: 'Mixed State Capitalism & Planned Economy',
        gdpRank: '20th / 103',
        urbanisation: 60,
        lifeExpectancy: 55,
        schooling: 4,
        hdi: 0.534,
        populationGrowth: 'high'
      };
      changed = true;
    }

    // 4. Rescale province populations ×2.79 and GDP ×2.686 — ONCE, guarded by
    //    the schema check above so re-running migrate() (e.g. every request
    //    in cloud mode) never double-applies this.
    for (const p of (world.provinces || [])) {
      if (p.demographics) {
        for (const gname in p.demographics) {
          const grp = p.demographics[gname];
          if (grp && typeof grp.population === 'number') grp.population = Math.round(grp.population * 2.79);
        }
      }
      if (p.vars && typeof p.vars.gdp === 'number') p.vars.gdp = Math.round(p.vars.gdp * 2.686);
      if (p.vars && p.demographics) {
        p.vars.population = Object.values(p.demographics).reduce((s, g) => s + (g.population || 0), 0);
      }
    }

    // 5. Clear President Valen as national leader (persona stays on file).
    const valen = (world.entities || []).find(e => e.id === 'per_valen');
    if (valen) {
      if (valen.title === 'President of the Republic') valen.title = 'Former President';
      if (valen.description) {
        valen.description = valen.description
          .replace(/President since 1958\.\s*/i, '')
          .replace(/^President of the Republic\.?\s*/i, 'Former President. ');
      }
      changed = true;
    }

    world.schema = 2;
    changed = true;
  }

  return changed;
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
    if (!reseed && fs.existsSync(DB_FILE)) { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); if (migrate(db)) saveNow(); }
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
    if (migrate(db)) save();
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
