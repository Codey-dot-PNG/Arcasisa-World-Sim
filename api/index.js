'use strict';
// Vercel serverless entry point. Every /api/* request is rewritten here
// (see vercel.json). Static files in public/ are served by Vercel itself.
//
// Per invocation: load the world (or reuse the warm cached copy when the
// stored version is unchanged), run the same handler the local server uses,
// then commit pending writes and ping clients over Supabase Realtime.
const store = require('../server/store');
const sim = require('../server/sim');
const api = require('../server/api');
const { seed } = require('../server/seed');

store.configure(seed);
sim.init(api.broadcast);

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    await store.begin();
    sim.updateDerived();
    const handled = await api.handle(req, res, pathname, req.method);
    if (handled !== true && !res.writableEnded) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not found' }));
    }
    await store.commit();
  } catch (e) {
    console.error('request failed:', e);
    try { await store.commit(); } catch (e2) { console.error('commit failed:', e2.message); }
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: e.message }));
    }
  }
};
