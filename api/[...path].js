'use strict';
// Catch-all Vercel function for /api/* — Vercel routes these straight to
// this file by its filesystem rules, so the handler sees the ORIGINAL url
// (/api/auth/login). The vercel.json rewrite to /api/index handed the
// function its rewritten url on the live deployment and every route 404'd.
// Same handler as api/index.js (which stays as the rewrite fallback).
module.exports = require('./index');
