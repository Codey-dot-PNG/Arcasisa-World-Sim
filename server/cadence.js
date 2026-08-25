'use strict';
// Phase 35 — Generalized real-time cadence scheduler.
// Replaces one-off wall-clock gates (market.maybeDayTick, war.maybeWarTick)
// with a single reusable scheduler so every subsystem can run on its own
// interval without duplicating gate logic. Cadences are defined in
// WORLD-TIME, not real-world-time, so settings.time.clock.minutesPerRealMinute
// scales everything together.
//
// State lives at world._cadence = { [name]: { lastWorldMs, nextWorldMs } }.
// Handlers are registered via register() and run via maybeRunCadences().

const store = require('./store');
const sim = require('./sim');

// ---- cadence definitions (world-ms intervals) ----
const CADENCES = {
  production:   { worldMs: 60 * 60 * 1000 },       // every world-hour
  stockTicker:  { worldMs: 4 * 60 * 60 * 1000 },    // every 4 world-hours
  demographics: { worldMs: 4 * 60 * 60 * 1000 },    // every 4 world-hours
  tradeReset:   { worldMs: 60 * 60 * 1000 },         // every world-hour
};

const MAX_CATCHUP = 50; // cap so a long sleep doesn't replay forever

// ---- handler registry ----
const handlers = {};

function register(name, fn) {
  handlers[name] = fn;
}

// ---- world-clock helper ----
// Derives "now" in world-time from the existing clock anchor. Reuses
// sim.worldClockNow — do NOT duplicate that math.
function currentWorldMs(db) {
  db = db || store.get();
  return sim.worldClockNow(db.settings.time, Date.now());
}

// ---- turn-length helper ----
// Returns the length of one turn in world-ms, for deriving hoursPerTurn.
function turnWorldMs(db) {
  db = db || store.get();
  const t = db.settings.time;
  const unit = t.unit || 'day';
  const perTurn = t.perTurn || 1;
  if (unit === 'hour') return 3600000 * perTurn;
  if (unit === 'week') return 604800000 * perTurn;
  return 86400000 * perTurn; // default: day
}

// ---- migration seed ----
// Called from store.migrate() — seeds _cadence state if missing, gated on
// world.schema. Idempotent and additive.
function migrate(db) {
  if (!db) return false;
  let changed = false;
  if (!db._cadence) {
    db._cadence = {};
    changed = true;
  }
  const now = currentWorldMs(db);
  for (const name in CADENCES) {
    if (!db._cadence[name]) {
      db._cadence[name] = { lastWorldMs: now, nextWorldMs: now + CADENCES[name].worldMs };
      changed = true;
    }
  }
  return changed;
}

// ---- main tick entry point ----
// Called from the same places maybeDayTick/maybeWarTick are called today
// (state fetch, cron endpoint, local server interval). For each cadence
// whose currentWorldMs >= nextWorldMs, run its handler possibly multiple
// times (catch-up loop, capped at MAX_CATCHUP) so a long serverless sleep
// doesn't lose ticks. Advance lastWorldMs += worldMs each iteration (not
// "jump to now") so cumulative fractional effects stay correct.
function maybeRunCadences(db) {
  db = db || store.get();
  const now = currentWorldMs(db);
  let anyRan = false;
  for (const name in CADENCES) {
    const def = CADENCES[name];
    const state = db._cadence[name];
    if (!state) continue;
    const handler = handlers[name];
    if (!handler) continue;
    let steps = 0;
    while (now >= state.nextWorldMs && steps < MAX_CATCHUP) {
      handler(db);
      state.lastWorldMs += def.worldMs;
      state.nextWorldMs += def.worldMs;
      steps++;
      anyRan = true;
    }
  }
  return anyRan;
}

// ---- progress for GET /api/state ----
// Returns { name: { progress: 0..1, nextAt: <epoch ms> } } per cadence so
// the client can render a countdown/progress bar per system.
function progress(db) {
  db = db || store.get();
  const now = currentWorldMs(db);
  const out = {};
  for (const name in CADENCES) {
    const def = CADENCES[name];
    const state = db._cadence[name];
    if (!state) continue;
    const elapsed = now - state.lastWorldMs;
    const progress = Math.min(1, Math.max(0, elapsed / def.worldMs));
    // Convert nextWorldMs back to real time via the clock anchor
    const t = db.settings.time;
    const c = t.clock || {};
    const anchorWorld = Number(c.anchorWorldMs) || 0;
    const anchorReal = Number(c.anchorRealMs) || Date.now();
    const rate = Math.max(0.001, Number(c.minutesPerRealMinute) || 59.5);
    const nextAt = anchorReal + (state.nextWorldMs - anchorWorld) / rate;
    out[name] = { progress: Math.round(progress * 1000) / 1000, nextAt: Math.round(nextAt) };
  }
  return out;
}

// ---- default handler registration ----
// Called once at boot (from server.js / api/index.js) after all modules are
// loaded. Uses lazy requires to avoid circular dependencies at module-scope.
let registered = false;
function registerDefaults() {
  if (registered) return;
  registered = true;

  // 2. Hourly production: runs runEconomy at a fraction of the per-turn budget
  // each world-hour. The scale factor is 1/hoursPerTurn so cumulative effects
  // per turn are preserved regardless of cadence frequency. Each run settles
  // wages, taxes, GDP and share repricing at the pro-rated amount. Also
  // advances build queues (6b) and standing contracts (6c).
  register('production', (db) => {
    const hoursPerTurn = turnWorldMs(db) / (CADENCES.production.worldMs || 1);
    try {
      require('./sim').runEconomy(db, 'CADENCE', 1 / hoursPerTurn);
    } catch (e) { /* sim optional */ }
    // 6b. Build queue advancement: progress += tickWorldMs / durationWorldMs
    const tickMs = CADENCES.production.worldMs;
    for (const pr of db.properties) {
      if (!Array.isArray(pr.projects) || !pr.projects.length) continue;
      for (let i = pr.projects.length - 1; i >= 0; i--) {
        const proj = pr.projects[i];
        if (proj.status !== 'active') continue;
        proj.progress = Math.min(1, (proj.progress || 0) + tickMs / Math.max(1, proj.durationWorldMs));
        if (proj.progress >= 1) {
          proj.status = 'completed';
          const oc = proj.onComplete || {};
          if (oc.maxEmployees !== undefined) pr.maxEmployees = Math.max(1, Math.round(oc.maxEmployees));
          if (Array.isArray(oc.produces)) pr.produces = oc.produces;
          if (oc.prodMode !== undefined) pr.prodMode = oc.prodMode;
          if (oc.cashPerTurn !== undefined) pr.cashPerTurn = oc.cashPerTurn;
          store.log('economy', `${pr.name} project completed`, proj.kind || 'upgrade', 'CADENCE', [pr.id, pr.ownerId]);
          pr.projects.splice(i, 1);
        }
      }
    }
    // 6c. Standing supply contracts: execute due contracts
    if (Array.isArray(db.contracts)) {
      for (let i = db.contracts.length - 1; i >= 0; i--) {
        const c = db.contracts[i];
        if (c.status !== 'active') continue;
        if (c.turnsRemaining !== undefined && c.turnsRemaining <= 0) {
          c.status = 'expired';
          continue;
        }
        // Move items and money
        const fromEnt = db.entities.find(e => e.id === c.fromEntityId);
        const toEnt = db.entities.find(e => e.id === c.toEntityId);
        if (fromEnt && toEnt && c.itemId && c.qtyPerTurn > 0) {
          const fromAcct = db.accounts.find(a => a.ownerId === c.fromEntityId);
          const toAcct = db.accounts.find(a => a.ownerId === c.toEntityId);
          if (fromAcct && toAcct && fromAcct.balance >= c.price * c.qtyPerTurn) {
            // Transfer items
            const fromInv = (fromEnt.inventory || []).find(r => r.itemId === c.itemId);
            if (fromInv && fromInv.qty >= c.qtyPerTurn) {
              fromInv.qty = Math.round((fromInv.qty - c.qtyPerTurn) * 1000000) / 1000000;
              if (fromInv.qty <= 0) fromEnt.inventory = fromEnt.inventory.filter(r => r !== fromInv);
              toEnt.inventory = toEnt.inventory || [];
              const toInv = toEnt.inventory.find(r => r.itemId === c.itemId);
              if (toInv) toInv.qty = Math.round((toInv.qty + c.qtyPerTurn) * 1000000) / 1000000;
              else toEnt.inventory.push({ itemId: c.itemId, qty: c.qtyPerTurn });
              // Transfer money
              require('./sim').txn(fromAcct.id, toAcct.id, c.price * c.qtyPerTurn, `Contract ${c.id}`, 'CADENCE', 'transfer');
              if (c.turnsRemaining !== undefined) c.turnsRemaining--;
              if (c.autoRenew && c.turnsRemaining !== undefined) c.turnsRemaining = c.renewTurns || c.turnsRemaining;
            }
          }
        }
      }
    }
    // 6e. Quality tier / R&D: spend accumulates toward quality with diminishing returns
    const rdK = db.settings.economy && db.settings.economy.rdQualityK !== undefined ? Number(db.settings.economy.rdQualityK) : 0.5;
    for (const pr of db.properties) {
      if (pr.prodMode !== 'goods') continue;
      pr.vars = pr.vars || {};
      const rdSpend = pr.vars.rdSpend || 0;
      if (rdSpend > 0) {
        const qualityGain = rdK * Math.sqrt(rdSpend / 1000) * scale;
        pr.vars.quality = Math.max(0, Math.min(100, (pr.vars.quality || 50) + qualityGain));
      }
      // 6f. Employee morale / training: training reduces turnover risk over time
      const trainingSpend = pr.vars.trainingSpend || 0;
      const wh = pr.workerHappiness !== undefined ? pr.workerHappiness : 50;
      const turnoverBase = Math.max(0, (50 - wh) / 100); // higher when unhappy
      const trainingReduction = trainingSpend > 0 ? Math.min(turnoverBase, trainingSpend / 5000 * scale) : 0;
      pr.vars.turnoverRisk = Math.max(0, Math.min(1, turnoverBase - trainingReduction));
    }
  });

  // 3a. Stock ticker: re-trigger the Day Market's speculative walk on the
  // stockTicker cadence instead of the old 5s wall-clock gate. The per-turn
  // call in advanceTurn stays (it also calls dayMarketTick once per turn);
  // this cadence just adds an additional, more-frequent trigger driven by
  // world-clock time.
  register('stockTicker', (db) => {
    try { require('./market').dayMarketTick(db); } catch (e) { /* market optional */ }
  });

  // 3b. Demographics: the per-turn demographic drift (class mood, employment,
  // monthly population growth) now fires on the demographics cadence. Each
  // drift amount is divided by hoursPerTurn so cumulative effects stay
  // correct when the cadence fires more or less often than once per turn.
  register('demographics', (db) => {
    const hoursPerTurn = turnWorldMs(db) / (CADENCES.demographics.worldMs || 1);
    const monthBoundary = false; // month boundaries are still gated by advanceTurn
    try {
      // runDemographics applies per-turn drift; we scale by 1/hoursPerTurn
      // so the cumulative drift per turn is preserved regardless of cadence
      // frequency. The function mutates db in place — that's fine.
      require('./sim').runDemographics(db, monthBoundary, 1 / hoursPerTurn);
    } catch (e) { /* sim optional */ }
  });

  // 3c. Trade desk hourly reset: re-roll the foreign order book on the
  // tradeReset cadence instead of gating on turn change. The existing
  // generateTradeOrders already resets lastFlows and rebuilds the book.
  register('tradeReset', (db) => {
    try { require('./sim').generateTradeOrders(db); } catch (e) { /* sim optional */ }
  });
}

module.exports = {
  CADENCES, register, registerDefaults, currentWorldMs, turnWorldMs, migrate, maybeRunCadences, progress
};
