'use strict';
// Phase 35 — generalized real-time cadence scheduler.
// A single reusable scheduler for subsystems that run on world-clock
// intervals (hourly production slices, demographic drift, foreign-trade
// order rerolls) instead of duplicating wall-clock gate logic.
//
// Cadences are defined in WORLD-TIME, not real time, so
// settings.time.clock.minutesPerRealMinute scales everything together and a
// paused clock pauses every cadence with it. State lives at
// world._cadence = { [name]: { lastWorldMs, nextWorldMs } } and tick counts
// for the turn-end fallback at world._cadenceTicks = { [name]: n }.
//
// Deliberately NOT a cadence: the Day Market's speculative walk. It already
// advances on market.maybeDayTick's ~5s request/timer gate plus once per turn
// inside runEconomy; adding a world-hour trigger here would triple-drive
// price discovery, so no stockTicker handler exists.

const store = require('./store');
const sim = require('./sim');

const HOUR_MS = 3600000;

// ---- default cadence intervals (world-ms) ----
const CADENCES = {
  production:   { worldMs: HOUR_MS,          setting: 'productionHours',   defHours: 1  }, // every world-hour
  demographics: { worldMs: 4 * HOUR_MS,      setting: 'demographicsHours', defHours: 4  }, // every 4 world-hours
  tradeReset:   { worldMs: HOUR_MS,          setting: 'tradeResetHours',   defHours: 1  }, // every world-hour
};

const MAX_CATCHUP = 50; // cap so a long sleep doesn't replay forever

// ---- handler registry ----
const handlers = {};

function register(name, fn) {
  handlers[name] = fn;
}

// ---- world-clock helper ----
// Derives "now" in world-time from the existing clock anchor via
// sim.worldClockNow — the same math that drives auto-advancing turns.
function currentWorldMs(db) {
  db = db || store.get();
  return sim.worldClockNow((db.settings || {}).time, Date.now());
}

// ---- interval resolution ----
// GM-tunable via settings.cadence.<name>Hours, clamped to sane bounds so a
// typo can't stall or machine-gun a subsystem (same spirit as war tuning).
function intervalOf(db, name) {
  const def = CADENCES[name];
  if (!def) return HOUR_MS;
  const cfgDb = db && db.settings && db.settings.cadence;
  let h = cfgDb && cfgDb[def.setting] !== undefined ? Number(cfgDb[def.setting]) : def.defHours;
  if (!Number.isFinite(h)) h = def.defHours;
  h = Math.max(0.25, Math.min(72, h));
  return Math.round(h * HOUR_MS);
}

// Length of one turn in world-ms — shared math with sim.advanceTurn.
function turnWorldMs(db) {
  const t = ((db || store.get()).settings || {}).time || {};
  const unit = t.unit || 'day';
  const perTurn = t.perTurn || 1;
  if (unit === 'hour') return HOUR_MS * perTurn;
  if (unit === 'week') return 604800000 * perTurn;
  return 86400000 * perTurn;
}

function hoursPerTurnOf(db, name) {
  return turnWorldMs(db) / Math.max(1, intervalOf(db, name));
}

// ---- migration seed ----
// Idempotent and additive; runs on EVERY load (called unconditionally from
// store.migrate, outside any schema gate) so cadences added in later updates
// seed themselves on existing worlds too. Old worlds start the clock from
// "now" rather than firing everything immediately on upgrade.
function migrate(db) {
  if (!db || !db.settings) return false;
  let changed = false;
  if (!db._cadence) { db._cadence = {}; changed = true; }
  if (!db._cadenceTicks) { db._cadenceTicks = {}; changed = true; }
  let now;
  try { now = currentWorldMs(db); } catch (e) { now = Date.now(); }
  for (const name in CADENCES) {
    if (!db._cadence[name]) {
      db._cadence[name] = { lastWorldMs: now, nextWorldMs: now + CADENCES[name].worldMs };
      changed = true;
    }
    // An existing state may predate an interval change — nextWorldMs is
    // always advanced by the CURRENT interval when it fires, so nothing to
    // repair here.
  }
  return changed;
}

// ---- main tick entry point ----
// Called from GET /api/state and the local server timer. For each cadence
// whose world-time has come due, runs its handler once per scheduled slice,
// possibly multiple times (catch-up capped at MAX_CATCHUP) so a long
// serverless sleep doesn't lose ticks. lastWorldMs/nextWorldMs advance by
// one interval per slice (never "jump to now") so fractional accumulators
// stay correct.
//
// A FORWARD clock jump (GM moving the date, an import, a rate rebase) can
// leave the schedule far behind the clock. The backlog is then collapsed
// into at most MAX_CATCHUP handler calls whose world-time WINDOWS widen
// proportionally — handlers scale their slice math to the window argument,
// so totals still match elapsed world time, but a jump can never
// machine-gun hundreds of full-effect slices per request (that burst was
// completing days of accrued work in seconds and dumping days of stock at
// once). No single window exceeds one turn (runHourlyProductionTick clamps
// its slice at 1 turn, so wider windows would overpay), and work older
// than MAX_CATCHUP turns is dropped rather than replayed — a multi-month
// blackout should not mint years of stock in one poll.
//
// Each handler is individually guarded: one broken subsystem neither blocks
// the others nor skips the save/broadcast signal for what did run.
function maybeRunCadences(db) {
  db = db || store.get();
  const now = currentWorldMs(db);
  let anyRan = false;
  for (const name in CADENCES) {
    const state = db._cadence && db._cadence[name];
    if (!state) continue; // pre-migration doc; migrate() will seed on next load
    const handler = handlers[name];
    if (!handler) continue;
    // Resolve the interval live so a GM tuning settings.cadence takes effect
    // immediately, even mid catch-up.
    const interval = intervalOf(db, name);
    if (!(interval > 0)) continue;
    const steps = now >= state.nextWorldMs
      ? Math.floor((now - state.nextWorldMs) / interval) + 1
      : 0;
    if (steps <= 0) continue;
    const windowCap = Math.max(interval, turnWorldMs(db)); // ≤ one turn per call
    const span = steps * interval;                          // scheduled world-ms
    const skipped = Math.max(0, span - windowCap * MAX_CATCHUP); // ancient excess
    let done = skipped;
    while (done < span) {
      const width = Math.min(windowCap, span - done);
      try { handler(db, width); } catch (e) { /* keep the scheduler alive */ }
      done += width;
    }
    // Grid-preserving advance: both marks move by exactly the scheduled span
    // (skipped slices included) so the schedule keeps its original phase.
    state.lastWorldMs += span;
    state.nextWorldMs += span;
    anyRan = true;
    // Turn-end fallback counter: advanceTurn checks whether each cadence
    // fired since the last turn and skips its legacy pass accordingly.
    db._cadenceTicks = db._cadenceTicks || {};
    db._cadenceTicks[name] = (db._cadenceTicks[name] || 0) + steps;
  }
  return anyRan;
}

// How many times a cadence fired since the last turn boundary (read+reset by
// sim.advanceTurn to decide between cadence-driven and legacy passes).
function ticksSinceTurn(db, name) {
  return (db && db._cadenceTicks && db._cadenceTicks[name]) || 0;
}
function resetTicksSinceTurn(db, name) {
  if (db && db._cadenceTicks) db._cadenceTicks[name] = 0;
}

// ---- progress for GET /api/state ----
// { name: { progress: 0..1, nextAt: <epoch ms> } } — lets the client render
// countdowns/progress bars without polling anything else. nextAt converts
// nextWorldMs back to real time through the clock anchor (inverse of
// sim.worldClockNow).
function progress(db) {
  db = db || store.get();
  const now = currentWorldMs(db);
  const out = {};
  const t = (db.settings || {}).time || {};
  const c = t.clock || {};
  const anchorWorld = Number(c.anchorWorldMs) || 0;
  const anchorReal = Number(c.anchorRealMs) || Date.now();
  const rate = Math.max(0.001, Number(c.minutesPerRealMinute) || 59.5);
  for (const name in CADENCES) {
    const def = CADENCES[name];
    const state = db._cadence && db._cadence[name];
    if (!state) continue;
    const interval = intervalOf(db, name);
    const elapsed = now - state.lastWorldMs;
    const p = Math.min(1, Math.max(0, elapsed / interval));
    const nextAt = anchorReal + (state.nextWorldMs - anchorWorld) / rate;
    out[name] = { progress: Math.round(p * 1000) / 1000, nextAt: Math.round(nextAt), hours: Math.round(interval / HOUR_MS * 100) / 100 };
  }
  return out;
}

// ---- default handler registration ----
// Called once at boot (server.js local mode; api.js module load covers
// serverless). Lazy requires keep the store→cadence→sim cycle out of boot.
let registered = false;
function registerDefaults() {
  if (registered) return;
  registered = true;

  // Hourly production slice (Parts 2 & 4) plus everything that rides the
  // same heartbeat: condition decay/maintenance (6a) and tender closing
  // (6d). All of the actual math lives in sim.js — this is just wiring.
  register('production', (db, widthWorldMs) => {
    // Hand the handler its real world-time width so the slice math scales with
    // the configured interval (productionHours) instead of always assuming one
    // hour per tick — and with a catch-up window when a clock jump collapsed
    // several scheduled slices into one call.
    const width = Number(widthWorldMs) > 0 ? Number(widthWorldMs) : intervalOf(db, 'production');
    require('./sim').runHourlyProductionTick(db, 'CADENCE', width);
  });

  // Demographic fast drift (Part 3b): the per-turn drift moved off
  // advanceTurn onto the demographics cadence, scaled so cumulative drift
  // per turn is preserved whatever the interval. Month-boundary passes stay
  // on advanceTurn (see runDemographics' scale=0 mode). The scale follows
  // the window argument so a collapsed catch-up backlog drifts by exactly
  // the elapsed share instead of one slice's worth.
  register('demographics', (db, widthWorldMs) => {
    const width = Number(widthWorldMs) > 0 ? Number(widthWorldMs) : intervalOf(db, 'demographics');
    const scale = width / turnWorldMs(db);
    require('./sim').runDemographics(db, false, scale);
  });

  // Trade desk reroll (Part 3c): rebuild the foreign order book hourly
  // instead of only at turn boundaries. Per-turn flow accounting (lastFlows,
  // export/import totals, diplomacy inputs) stays turn-scoped — see
  // rerollTradeBook vs generateTradeOrders in sim.js.
  register('tradeReset', (db) => {
    require('./sim').rerollTradeBook(db);
  });
}

module.exports = {
  CADENCES, register, registerDefaults,
  currentWorldMs, turnWorldMs, hoursPerTurnOf, intervalOf,
  migrate, maybeRunCadences, progress,
  ticksSinceTurn, resetTicksSinceTurn,
};
