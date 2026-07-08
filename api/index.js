'use strict';
// Vercel serverless entry point. Every /api/* request is rewritten here
// (see vercel.json). Static files in public/ are served by Vercel itself.
//
// Per invocation: load the world (or reuse the warm cached copy when the
// stored version is unchanged), run the same handler the local server uses,
// then commit pending writes and ping clients over Supabase Realtime.
//
// Writes are transactional with a retry: the handler runs against a buffered
// response so nothing reaches the real client until commit() has durably
// landed. On a version conflict (another invocation committed first) the
// whole attempt re-runs against fresh state — safe because the request body
// is read once up front and store.begin()/invalidate() reset all mutable
// state between attempts.
const store = require('../server/store');
const sim = require('../server/sim');
const api = require('../server/api');
const { seed } = require('../server/seed');

store.configure(seed);
sim.init(api.broadcast);

const MAX_BODY = 4 * 1024 * 1024; // 4MB cap

// Reads the raw request body exactly once, before any retry attempt, so a
// re-run of the handler never tries to consume the stream twice.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

// Minimal buffered response: handlers only ever call setHeader/getHeader/
// removeHeader/writeHead/write/end, so that's all this needs to implement.
// Nothing reaches the real client until a commit() has succeeded.
class BufferedRes {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.ended = false;
  }
  setHeader(k, v) { this.headers[k] = v; }
  getHeader(k) { return this.headers[k]; }
  removeHeader(k) { delete this.headers[k]; }
  writeHead(code, hdrs) {
    this.statusCode = code;
    if (hdrs) Object.assign(this.headers, hdrs);
    return this;
  }
  write(c) { this.chunks.push(c); }
  end(c) { if (c !== undefined) this.chunks.push(c); this.ended = true; }
  get writableEnded() { return this.ended; }
}

// Vercel's fluid compute can run several requests CONCURRENTLY in one
// instance. The store's world cache, version and pending buffers are shared
// module state, so requests must be serialized per instance — cross-instance
// safety is the CAS commit's job, in-instance safety is this mutex's.
let chain = Promise.resolve();

module.exports = (req, res) => {
  const run = chain.then(() => handleRequest(req, res));
  chain = run.catch(() => { }); // one failed request must not poison the queue
  return run;
};

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    // Read the body once, up front, so re-running the handler on a conflict
    // retry is safe (server/api.js readBody() prefers req.body when set).
    if (req.body === undefined && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
      const raw = await readRawBody(req);
      try { req.body = raw ? JSON.parse(raw) : {}; }
      catch (e) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'invalid JSON body' }));
        return;
      }
    }

    for (let attempt = 0; ; attempt++) {
      await store.begin();
      sim.updateDerived();
      const bres = new BufferedRes();
      let handled;
      try {
        handled = await api.handle(req, bres, pathname, req.method);
      } catch (e) {
        store.invalidate(); // half-applied mutations must not be committed or reused
        throw e;
      }
      if (handled !== true && !bres.ended) {
        bres.statusCode = 404;
        bres.setHeader('Content-Type', 'application/json');
        bres.end(JSON.stringify({ error: 'Not found' }));
      }
      try {
        await store.commit();
      } catch (e) {
        if (e && e.code === 'WORLD_CONFLICT' && attempt < 2) continue; // begin() will reload fresh state
        store.invalidate();
        throw e;
      }
      // Flush only after a durable commit.
      for (const [k, v] of Object.entries(bres.headers)) res.setHeader(k, v);
      res.statusCode = bres.statusCode;
      res.end(bres.chunks.join(''));
      return;
    }
  } catch (e) {
    console.error('request failed:', e);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: e.message }));
    }
  }
};
