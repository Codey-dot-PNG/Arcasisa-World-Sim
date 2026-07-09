'use strict';
// Deterministic intra-turn price path (Workstream A5). A pure function of its
// arguments: given a committed anchor (price + timestamp + seed) it returns a
// bounded, seeded wiggle that gently mean-reverts toward `target`. Because it
// is pure and seeded, the server and every client evaluating it at the same
// `now` produce the SAME number — clients render the live ticker, they never
// invent it. This file MUST stay behaviourally identical to
// public/js/pricepath.js (browser copy).
//
//   price(anchorPrice, anchorTurnMs, seed, nowMs, vol, meanRevTarget) -> number
(function (global) {
  function price(anchorPrice, anchorTurnMs, seed, nowMs, vol, meanRevTarget) {
    anchorPrice = Number(anchorPrice);
    if (!(anchorPrice > 0)) anchorPrice = 0.01;
    vol = (vol === undefined || vol === null || isNaN(Number(vol))) ? 0.02 : Number(vol);
    var target = Number(meanRevTarget);
    if (!(target > 0) || !isFinite(target)) target = anchorPrice;
    var s = (Number(seed) >>> 0) || 1;
    var t0 = Number(anchorTurnMs) || 0;
    var now = Number(nowMs) || 0;
    // minutes since the anchor was committed
    var dt = Math.max(0, now - t0) / 60000;
    // seed-derived phases so each company wanders on its own path
    var p1 = (s % 997) / 997 * Math.PI * 2;
    var p2 = ((Math.floor(s / 8)) % 997) / 997 * Math.PI * 2;
    var p3 = ((Math.floor(s / 128)) % 997) / 997 * Math.PI * 2;
    // sum of three sine terms at different rates, in [-1, 1]
    var wiggle = Math.sin(dt * 0.9 + p1) * 0.6
      + Math.sin(dt * 2.3 + p2) * 0.3
      + Math.sin(dt * 5.1 + p3) * 0.1;
    // gentle mean reversion toward `target` over ~30 minutes
    var revert = 1 - Math.exp(-dt / 30);
    var base = anchorPrice + (target - anchorPrice) * revert;
    var out = base * (1 + vol * wiggle);
    if (!(out > 0)) out = 0.01;
    return Math.max(0.01, Math.round(out * 100) / 100);
  }

  var api = { price: price };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PricePath = api;
})(typeof self !== 'undefined' ? self : this);
