'use strict';
// The Arcasia Simulation Engine — zero-dependency Node.js server.
//   node server.js            start (seeds data/world.json on first run)
//   node server.js --reseed   wipe the world and reseed
const http = require('http');
const fs = require('fs');
const path = require('path');
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
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA fallback for unknown non-asset paths
      if (!path.extname(full)) {
        return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, idx) => {
          if (e2) { res.writeHead(404); return res.end('Not found'); }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(idx);
        });
      }
      res.writeHead(404); return res.end('Not found');
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.png' || ext === '.jpg' ? 'public, max-age=86400' : 'no-cache'
    });
    res.end(data);
  });
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
    if (market.maybeDayTick(store.get())) { store.save(); api.broadcast('sync'); }
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
    if (war.maybeWarTick(store.get())) { store.save(); api.broadcast('sync'); }
  } catch (e) { /* transient; retry next tick */ }
}, 1000).unref();
