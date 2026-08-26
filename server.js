'use strict';
// The Arcasia Simulation Engine — zero-dependency Node.js server.
//   node server.js            start (seeds data/world.json on first run)
//   node server.js --reseed   wipe the world and reseed
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./server/store');
const sim = require('./server/sim');
const api = require('./server/api');
const { seed } = require('./server/seed');
const mapdata = require('./server/mapdata');

const PORT = process.env.PORT || 4820;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.gif': 'image/gif'
};

// ---------- static assets: in-memory cache + gzip + ETag ----------
// Local-mode static serving only (Vercel serves public/ itself, so api/index.js
// never runs this). The frontend is ~1MB of hand-written JS; serving it raw
// from disk per request wasted the most bandwidth in the app. Text assets are
// pre-compressed once into memory and revalidated with ETags — a repeat visit
// costs a 304 instead of a full re-read, and first visits transfer ~70% less.
// mtime+size validation keeps hot-reload during development correct: an edit
// bumps the ETag, the cache entry is replaced, never served stale.
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt']);
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const staticCache = new Map(); // absolute path -> { etag, raw, gz }
let staticCacheBytes = 0;

function cacheEntryBytes(entry) { return entry.raw.length + (entry.gz ? entry.gz.length : 0); }

function cachePut(full, entry) {
  const prev = staticCache.get(full);
  if (prev) { staticCacheBytes -= cacheEntryBytes(prev); staticCache.delete(full); }
  staticCache.set(full, entry); // Map iteration order = insertion order → LRU eviction below
  staticCacheBytes += cacheEntryBytes(entry);
  while (staticCacheBytes > CACHE_MAX_BYTES && staticCache.size > 1) {
    const oldestKey = staticCache.keys().next().value;
    staticCacheBytes -= cacheEntryBytes(staticCache.get(oldestKey));
    staticCache.delete(oldestKey);
  }
}

function sendStatic(res, req, ext, entry) {
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.woff2' ? 'public, max-age=86400' : 'no-cache',
    'Vary': 'Accept-Encoding',
    'ETag': entry.etag
  };
  if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); return res.end(); }
  let body = entry.raw;
  if (entry.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    headers['Content-Encoding'] = 'gzip';
    body = entry.gz;
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(body);
}

function serveFile(req, res, full, fallbackToIndex) {
  const ext = path.extname(full).toLowerCase();
  fs.stat(full, (statErr, st) => {
    const notFound = () => {
      if (fallbackToIndex) return serveFile(req, res, path.join(PUBLIC, 'index.html'), false);
      res.writeHead(404); res.end('Not found');
    };
    if (statErr || !st.isFile()) return notFound();
    const etag = '"' + st.size.toString(36) + '-' + Math.round(st.mtimeMs).toString(36) + '"';
    const cached = staticCache.get(full);
    if (cached && cached.etag === etag) return sendStatic(res, req, ext, cached);
    fs.readFile(full, (readErr, data) => {
      if (readErr) return notFound();
      const entry = {
        etag,
        raw: data,
        gz: COMPRESSIBLE.has(ext) && data.length > 1024 ? zlib.gzipSync(data, { level: 6 }) : null
      };
      cachePut(full, entry);
      sendStatic(res, req, ext, entry);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    // in supabase mode each request loads fresh state and commits its writes
    if (store.MODE !== 'file') await store.begin();
    const handled = await api.handle(req, res, pathname, req.method);
    if (store.MODE !== 'file') await store.commit().catch(e => console.error('commit failed:', e.message));
    if (handled) return;
  }

  // static files
  let file = pathname === '/' ? '/index.html' : pathname;
  file = path.normalize(file).replace(/^([.\\/])+/, '');
  const full = path.join(PUBLIC, file);
  // require the resolved path to sit INSIDE public/ (a plain startsWith on the
  // directory name would also admit siblings like "public-extra")
  if (full !== PUBLIC && !full.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  serveFile(req, res, full, !path.extname(full)); // extensionless unknown paths fall back to the SPA shell
});

(async () => {
  await store.load(seed, process.argv.includes('--reseed'));
  // self-heal: a world file loaded from disk (or a rollback target) may
  // predate the SVG map — upgrade it in place rather than surface
  // "no map document" errors in the client.
  if (mapdata.applyMap(store.get())) { store.saveNow(); console.log('  Map document upgraded on load.'); }
  sim.setLongLived(true); // enables real auto-advance timers in this process
  sim.init(api.broadcast);
  sim.updateDerived();
  sim.scheduleAuto();
  // Phase 35 — register default cadence handlers (hourly production,
  // demographics drift, trade-desk reroll). Must run after all modules are loaded.
  try { require('./server/cadence').registerDefaults(); } catch (e) { /* cadence optional */ }

  server.listen(PORT, () => {
    const t = store.get().settings.time;
    console.log('');
    console.log('  ARCASIA SIMULATION ENGINE');
    console.log('  ─────────────────────────');
    console.log(`  World:   ${store.get().settings.worldName}`);
    console.log(`  Time:    turn ${t.turn} · ${t.date} (1 turn = ${t.perTurn} ${t.unit})`);
    console.log(`  Storage: ${store.MODE === 'supabase' ? 'Supabase (' + process.env.SUPABASE_URL + ')' : 'local file (' + store.DATA_DIR + ')'}`);
    console.log(`  Server:  http://localhost:${PORT}`);
    console.log('  Seed accounts: gm · president · journalist · executive · citizen (passphrase: arcasia)');
    console.log('');
  });
})().catch((e) => { console.error('Failed to start:', e); process.exit(1); });

let saving = false;
function shutdown() {
  if (saving) return; saving = true;
  try { store.saveNow(); console.log('World saved.'); } catch (e) { console.error(e.message); }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(() => { try { store.saveNow(); } catch (e) { /* disk hiccup; retry next tick */ } }, 60000).unref();

// Day Market — in this LONG-LIVED process (local `node server.js`) a timer
// advances the market every 5s even when nobody is fetching, so it feels live
// during solo testing. On SERVERLESS hosting (Vercel) there is no persistent
// process and this file never runs; there the market advances via the same
// gated `maybeDayTick` ridden by GET /api/state (see server/api.js) plus once
// per turn. Both paths share the `_lastDayTick` gate, so they never double-tick.
setInterval(() => {
  try {
    const market = require('./server/market');
    // Save without broadcast (same rule as the api.js call site): per-tick
    // sync broadcasts made every client refetch the whole world every ~5s.
    // Exchange watchers refresh via startPriceTicker's overdue nudge instead.
    if (market.maybeDayTick(store.get())) { store.save(); }
  } catch (e) { /* transient; retry next tick */ }
}, 5000).unref();

// War engine — same serverless-safe pattern as the Day Market above, just on
// a faster ~1s cadence so the local process feels like a live RTS. The actual
// tick rate is gated on db.war.tickMs/speed (maybeWarTick), so this timer is
// just how often we check whether a tick is due; on Vercel there is no timer
// at all and GET /api/state rides the same gate (see server/api.js).
setInterval(() => {
  try {
    const war = require('./server/war');
    // Save on any tick; broadcast only on milestones — war-watching clients
    // pull routine tick churn via their own /api/war/state heartbeat, and
    // per-tick broadcasts forced every client into full refetches at tick
    // rate (see server/war.js maybeWarTickSignal).
    const sig = war.maybeWarTickSignal(store.get());
    if (sig.ticked) { store.save(); if (sig.milestone) api.broadcast('sync'); }
  } catch (e) { /* transient; retry next tick */ }
}, 1000).unref();

// Election count — same serverless-safe, self-gated pattern as the Day
// Market and War Engine above. The count runs off the continuous world
// clock (sim.worldClockNow), not world turns, so — like the market and war
// engines — it needs its own wall-clock poll here for this long-lived local
// process, plus its own gated ride on GET /api/state for serverless (see
// server/election.js's maybeTick and server/api.js's GET /api/state
// handler). Both paths share maybeTick's own _lastTickRealMs gate, so
// running from both places never double-ticks.
setInterval(() => {
  try {
    const election = require('./server/election');
    const sig = election.maybeTick(store.get(), 'ENGINE');
    if (sig.ticked) { store.save(); if (sig.milestone) api.broadcast('sync'); }
  } catch (e) { /* transient; retry next tick */ }
}, 3000).unref();

// Phase 35 — Cadence scheduler: polls less frequently than war/market (these
// are hour-scale world-time cadences, not sub-second ticks) and runs any
// cadence whose world-clock interval has elapsed. Same serverless-safe,
// self-gated pattern as the other timers.
setInterval(() => {
  try {
    const cadence = require('./server/cadence');
    if (cadence.maybeRunCadences(store.get())) { store.save(); api.broadcast('sync'); }
  } catch (e) { /* transient; retry next tick */ }
}, 10000).unref();
