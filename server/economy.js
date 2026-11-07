'use strict';
/* The national economy (Economy v2) — one coherent model of the people the
   players govern, employ, feed and sell to.

   Why it was rebuilt: the old passes (households.js + runDemographics + the
   seeded "drift" events) kept 175 household BANK ACCOUNTS that received wages
   and never spent them, minted company revenue from nothing at a fixed price
   whatever anyone could afford, pooled every grain of domestic food into the
   government stockpile so provinces only ate when the President clicked
   "release", killed people without births, ratcheted incomes upward only and
   let half a dozen independent nudges push happiness around. A year of that
   halved the population while approval climbed to 94%.

   The model now:

   · THE PEOPLE ARE A SECTOR, NOT ACCOUNTS. Every province × demographic group
     ("segment") carries income (₳ per person per month), savings (₳ per
     person), spending, food access, unemployment and attitudes. Real money
     lives only in the accounts of the game's actors (government, bank,
     companies, characters, parties). Money crosses between the two at the
     edge, metered: payroll leaves employers' accounts, consumer spending
     arrives as sales revenue, taxes reach the treasury, welfare leaves it.

   · REPRESENTATIVE SITES. Each employee at a listed site stands for
     `jobsPerEmployee` jobs in that industry and its suppliers (the old
     recompute_employment k). The rest of each province's work is the LOCAL
     ECONOMY (shops, services, small farms), which grows and shrinks with what
     people spend there. Employment = (listed + local jobs) / labour force.

   · WAGES. Each province has a market wage (₳/day for its reference group)
     that rises when labour is tight, follows consumer prices, and is pulled by
     what the listed employers pay (in proportion to their share of the jobs).
     Each group earns a calibrated multiple of it, times its own employment.
     Students and retirees live on a calibrated share of working incomes.

   · DEMAND & PRICES. Every good sold on the home market has a demand curve
     (base quantity × an economy index × relative price ^ −elasticity). Sellers
     share what is demanded; whatever is not bought stays in the site's stock.
     Prices move with the gap between demand and supply, within bounds.
     Staple food demand follows the population's need and what it can afford;
     consumer goods follow real non-food spending; industrial goods follow
     real output; military goods the state's (and a war's) appetite.

   · FOOD. Farms sell to the people. Rural groups feed themselves in part.
     The state reserve (government inventory) is filled only by what the state
     buys or keeps, and released by policy (releaseFood). Shortage and high
     prices show up as food access per group, food security per province and
     — only when it is real and sustained — excess deaths.

   · POPULATION. Births, deaths (age, disease by healthcare, famine), aging
     into retirement, schooling, class mobility in both directions and
     urbanisation — all calibrated so the starting structure is a steady
     state, so change comes from conditions, not from the rules drifting.

   · ATTITUDES come from lived experience: real income against expectations,
     unemployment, inflation, food, public services, war, inequality.
     Government support follows happiness and confidence plus how far the
     governing parties sit from each group. GM/event adjustments to province
     happiness or approval are folded into the groups as shocks that fade.

   Everything is calibrated from the world as it stands the first time it
   runs (economy.migrate / the lazy ensure* helpers), so switching models
   does not jump the numbers; only change moves them. All state lives on the
   world doc (serverless-safe). Generic: group names come from
   settings.economy (groupRoles, referenceGroup, ladder, urbanize); the only
   well-known ids are the sanctioned ent_gov / acct_treasury. */

const store = require('./store');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;
const cleanQ = (n) => Math.round(n * 1000000) / 1000000;
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const fmtNum = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const Z5 = [-1.2816, -0.5244, 0, 0.5244, 1.2816]; // quintile mid-points of a standard normal

// Engine defaults — every one GM-tunable under settings.economy.
const DEF = {
  jobsPerEmployee: 200,      // jobs each listed employee stands for (industry + suppliers)
  referenceWage: 1,          // ₳/day the reference group earns at calibration (= the default company wage)
  localAdjust: 0.03,         // per day: local jobs close this share of the gap to their target
  wageFlex: 0.01,            // wage level +1% per point of employment above its normal level
  wageAdjust: 0.02,          // per day: share of the gap to the target wage closed
  wageIndexation: 0.85,      // elasticity of wages to the consumer price level
  productivityGrowth: 0.015, // per year
  labourLeadMax: 3,          // listed pay counts up to this multiple of the market wage
  priceAdjust: 0.05,         // price response to ln(demand/supply)
  priceStepMax: 0.03,        // max price move per turn
  priceFloor: 0.3, priceCeil: 3, // bounds, × the good's base price
  elasticity: { staple: 0.15, consumer: 0.6, industrial: 0.3, military: 0.2 },
  subsistenceShare: 0.5,     // share of a rural group's food it grows itself
  foodMargin: 1.03,          // commercial food supply ÷ need at calibration
  reliefDecay: 0.10,         // per turn: released relief food that spoils
  famineMortalityK: 0.5,     // excess deaths per year at total food loss (scales with shortfall²)
  birthRate: 0.034,          // per year
  adultDeathRate: 0.007,     // per year, non-retired
  oldAgeRate: 0.075,         // per year, retired
  diseaseK: 0.012,           // extra deaths per year at healthcare 0 (none at 100)
  graduationRate: 0.12,      // per year, students who finish
  mobility: [0.02, 0.008],   // per year, up each rung of the ladder at baseline
  urbanization: 0.01,        // per year, rural → urban at baseline
  incomeSpread: 0.5,         // lognormal σ of income within a group (poverty, Gini)
  importMarkup: 0.25,        // world price × this (+ import tariff) = the price at which imports flow
  exportDiscount: 0.20,      // world price × (1 − this − export tariff) = where surplus goes abroad
  importCap: 0.3,            // background imports cover at most this share of a good's demand
  exportCap: 0.5,            // … and exports take at most this share of it
  reorderTurns: 10,          // sites with input needs keep about this many turns of stock
  labourShare: 0.5,          // wages ÷ GDP — GDP is the wage bill grossed up by this
  stapleStepMax: 0.015,      // staples' max price move per turn (food prices are sticky)
  unemploymentBenefit: 0,    // share of lost wages the treasury replaces (0 = none)
};
function settings(db) { return (db.settings && db.settings.economy) || {}; }
function opt(db, k) { const s = settings(db); return s[k] !== undefined ? s[k] : DEF[k]; }
function roleOf(db, gname) { const r = settings(db).groupRoles || {}; return r[gname] || 'worker'; }
const inLabour = (role) => role === 'worker' || role === 'rural';

function daysPerTurn(db) {
  const t = (db.settings && db.settings.time) || {};
  const n = Math.max(1, Number(t.perTurn) || 1);
  return t.unit === 'hour' ? n / 24 : t.unit === 'week' ? 7 * n : n;
}

function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
function spreadOf(db, gname) {
  const s = settings(db).incomeSpreadByGroup || {};
  return num(s[gname], num(opt(db, 'incomeSpread'), 0.5));
}
// Share of a group below the poverty line, its income spread lognormal.
function povertyShare(income, line, sigma) {
  if (!(income > 0)) return 1;
  if (!(line > 0)) return 0;
  const median = income / Math.exp(sigma * sigma / 2);
  return normCdf((Math.log(line) - Math.log(median)) / sigma);
}
// Gini over weighted points (pairwise form — exact for a few dozen rows).
function gini(points) {
  const pts = points.filter(p => p.w > 0 && p.x >= 0);
  const N = pts.reduce((s, p) => s + p.w, 0);
  if (!(N > 0)) return 0;
  const mu = pts.reduce((s, p) => s + p.w * p.x, 0) / N;
  if (!(mu > 0)) return 0;
  let sum = 0;
  for (const a of pts) for (const b of pts) sum += a.w * b.w * Math.abs(a.x - b.x);
  return clamp(sum / (2 * N * N * mu), 0, 1);
}
function quintilePoints(income, pop, sigma) {
  if (!(pop > 0) || !(income > 0)) return [];
  const median = income / Math.exp(sigma * sigma / 2);
  return Z5.map(z => ({ x: median * Math.exp(sigma * z), w: pop / 5 }));
}

// ---------- national state ----------------------------------------------------
function national(db) {
  db.econ = db.econ || {};
  const E = db.econ;
  if (E.cpi === undefined) E.cpi = 1;
  if (E.idx === undefined) E.idx = { staple: 1, consumer: 1, industrial: 1, military: 1 };
  return E;
}

// The government's reference ideology for "how far is the government from
// me": the seat-weighted economic position of the parties in government.
function govEcon(db) {
  let w = 0, s = 0;
  for (const e of db.entities) {
    if (e.type !== 'party' || !e.inGovernment) continue;
    const seats = Math.max(1, e.mpCount || 0);
    w += seats; s += seats * num(e.ideology && e.ideology.econ, 0);
  }
  return w ? s / w : 0;
}

// ---------- calibration ---------------------------------------------------------
// Expected per-turn domestic offer of every good, with no random wobble —
// what the market is sized to at calibration (sold units = made − kept).
function expectedOffers(db) {
  const sim = require('./sim');
  const offers = new Map();
  for (const pr of db.properties) {
    if (!pr.ownerId || pr.prodMode !== 'goods' || !Array.isArray(pr.produces)) continue;
    const ctx = sim.productionContext(db, pr, { noise: false });
    const cond = pr.vars && pr.vars.condition !== undefined ? pr.vars.condition / 100 : 1;
    const reqMult = pr.vars && pr.vars.supplyFulfillment !== undefined && pr.vars.supplyFulfillment !== null ? pr.vars.supplyFulfillment : 1;
    for (const e of pr.produces) {
      const keep = sim.keepPctFor(pr, ctx, e.itemId);
      const units = (e.perTurn || 0) * ctx.f * cond * reqMult * (1 - keep / 100);
      if (units > 0) offers.set(e.itemId, (offers.get(e.itemId) || 0) + units);
    }
  }
  return offers;
}

function demandKind(it) {
  if (it.meta && it.meta.stapleFood) return 'staple';
  const c = String(it.category || '');
  if (/military/i.test(c)) return 'military';
  if (/goods/i.test(c)) return 'consumer';
  return 'industrial';
}

// Size every produced good's home market to what is offered now, and the
// food need per head to the food the farms (plus subsistence) supply now.
function calibrateMarket(db) {
  const E = national(db);
  const offers = expectedOffers(db);
  const inputs = new Map(); // what the sites with supply chains use per turn
  for (const w of inputUse(db)) inputs.set(w.itemId, (inputs.get(w.itemId) || 0) + w.perTurn);
  let food = 0;
  for (const it of db.items) {
    const off = offers.get(it.id) || 0;
    it.meta = it.meta || {};
    const m = it.meta;
    if (m.companyId || m.propertyId || m.bond) continue;
    if (!(m.basePrice > 0) && it.marketValue > 0) m.basePrice = it.marketValue;
    m._lastPrice = it.marketValue;
    if ((off > 0 || inputs.get(it.id) > 0) && !m.demand) {
      // final demand = what is offered today, less what industry itself buys
      m.demand = { kind: demandKind(it), base: r4(Math.max(0, off - (inputs.get(it.id) || 0))), home0: r4(off), backlog: 0 };
    }
    if (m.demand && m.demand.kind === 'staple') food += off * (m.foodCalorieWeight || 1);
  }
  // need per head: commercial supply covers commercial need × margin
  let fed = 0;
  const sub = opt(db, 'subsistenceShare');
  for (const p of db.provinces) for (const g in (p.demographics || {})) {
    const pop = p.demographics[g].population || 0;
    fed += pop * (roleOf(db, g) === 'rural' ? (1 - sub) : 1);
  }
  E.needPerCap = fed > 0 && food > 0 ? food / (fed * opt(db, 'foodMargin')) : 0;
  E.foodBase = food;
}

// One province: read today's numbers as the baseline the model holds steady.
function calibrateProvince(db, p) {
  const demo = p.demographics || {};
  const E = p.econ = p.econ || {};
  E.seg = E.seg || {};
  const N = num(opt(db, 'jobsPerEmployee'), 200);
  const refG = settings(db).referenceGroup;
  const nat = national(db);
  // province reference wage: the reference group's earnings per employed day
  let w0 = null;
  if (refG && demo[refG] && demo[refG].income > 0) {
    w0 = demo[refG].income / 30 / Math.max(0.3, num(demo[refG].employment, 90) / 100);
  }
  if (!(w0 > 0)) w0 = nat.w0Nat || num(opt(db, 'referenceWage'), 1);
  let lf = 0, emp = 0, wb = 0, wInc = 0, wPop = 0;
  for (const g in demo) {
    const S = demo[g];
    if (!inLabour(roleOf(db, g))) continue;
    const pop = S.population || 0;
    lf += pop; emp += pop * num(S.employment, num(p.vars.employment, 90)) / 100;
    wb += pop * (S.income || 0) / 30;
    wInc += pop * (S.income || 0); wPop += pop;
  }
  const empP = lf > 0 ? emp / lf * 100 : num(p.vars.employment, 90);
  const uP = Math.max(0.5, 100 - empP);
  const avgWorkerInc = wPop > 0 ? wInc / wPop : w0 * 30;
  const sub = opt(db, 'subsistenceShare');
  const line = num(db.globalVars && db.globalVars.povertyLine, 23);
  for (const g in demo) {
    const S = demo[g];
    const role = roleOf(db, g);
    const seg = E.seg[g] = E.seg[g] || {};
    const inc = Math.max(1, S.income || 1);
    const e = num(S.employment, empP);
    if (inLabour(role)) {
      seg.wageMult = r4(inc / (30 * w0 * Math.max(0.05, e / 100)));
      seg.u0 = r2(100 - e);
      seg.exposure = r4(Math.max(0.05, (100 - e) / uP));
    } else {
      seg.transferRatio = r4(inc / Math.max(1, avgWorkerInc));
    }
    seg.income0 = r2(inc);
    seg.ref = r2(inc); seg.ref3 = r2(inc); seg.cPrev = undefined;
    seg.h0 = num(S.happiness, 50); seg.ec0 = num(S.economicConfidence, 50); seg.gs0 = num(S.governmentSupport, 50);
    seg.tH = seg.h0; seg.tEC = seg.ec0; seg.tGS = seg.gs0;
    // share of income spent on a full (bought) diet: poorer groups spend more
    const share = clamp(0.62 - 0.13 * Math.log(inc / Math.max(1, line)), 0.08, 0.65);
    seg.f0 = r4(role === 'rural' ? share * (1 - sub) : share);
    if (S.savings === undefined) S.savings = r2(inc * 2);
    if (S.foodAccess === undefined) S.foodAccess = 100;
    S.unemployment = r2(100 - e);
  }
  const listed = db.properties.filter(pr => pr.provinceId === p.id && pr.ownerId)
    .reduce((s, pr) => s + (pr.employees || 0), 0) * N;
  const E0 = lf * empP / 100;
  E.lf0 = lf; E.emp0 = r2(empP);
  E.localJobs0 = Math.max(0.15 * E0, E0 - listed);
  E.localJobs = E.localJobs0;
  E.w0 = r4(w0); E.wMarket = r4(w0);
  // GDP from first principles (the wage bill ÷ labour share), not the
  // authored figure — which sat below what households earn
  E.gdpK = 1 / clamp(num(opt(db, 'labourShare'), 0.5), 0.2, 0.9);
  E.hc0 = num(p.vars.healthcare, 50); E.edu0 = num(p.vars.education, 50); E.crime0 = num(p.vars.crime, 45);
  E.svcIdx = 1;
  E.lead0 = undefined; E.spend0 = undefined; E.listedGross0 = undefined; E.gini0 = undefined;
  E.fsSum = 0; E.fsN = 0;
  calibratePopulation(db, p);
  E.v = 1;
}

// Flow rates that make the province's current structure a steady state.
function calibratePopulation(db, p) {
  const E = p.econ;
  const demo = p.demographics || {};
  let W = 0, S = 0, R = 0;
  for (const g in demo) {
    const role = roleOf(db, g), pop = demo[g].population || 0;
    if (role === 'student') S += pop; else if (role === 'retired') R += pop; else W += pop;
  }
  const pop = W + S + R;
  if (!(pop > 0) || !(W > 0)) { E.retire = 0; E.enroll = 0; E.mob = []; return; }
  const hc = num(p.vars.healthcare, 50);
  const dis = opt(db, 'diseaseK') * Math.max(0, 100 - hc) / 100;
  const dA = opt(db, 'adultDeathRate') + dis, dR = opt(db, 'oldAgeRate') + dis;
  const g0 = (opt(db, 'birthRate') * pop - dA * (W + S) - dR * R) / pop;
  E.retire = r4((g0 + dR) * R / W);
  E.enroll = r4((g0 + opt(db, 'graduationRate') + dA) * S / W);
  // class ladder: baseline upward flow balanced by the same downward flow
  const ladder = (settings(db).ladder || []).filter(g => demo[g]);
  const up = opt(db, 'mobility') || [];
  E.mob = [];
  for (let i = 0; i + 1 < ladder.length; i++) {
    const lo = demo[ladder[i]].population || 0, hi = demo[ladder[i + 1]].population || 0;
    const u = num(up[i], up[up.length - 1] || 0.01);
    E.mob.push({ up: u, down: hi > 0 ? r4(u * lo / hi) : 0 });
  }
  const urb = settings(db).urbanize || {};
  if (urb.from && urb.to && demo[urb.from] && demo[urb.to]) {
    const rInc = demo[urb.from].income || 1, uInc = demo[urb.to].income || 1;
    E.gap0 = r4(uInc / rInc);
  }
}

function ensure(db) {
  const E = national(db);
  if (E.needPerCap === undefined) calibrateMarket(db);
  if (E.w0Nat === undefined) {
    // national reference wage = LF-weighted mean of province reference wages
    let s = 0, w = 0;
    for (const p of db.provinces) if (p.econ && p.econ.w0) { s += p.econ.w0 * (p.econ.lf0 || 1); w += p.econ.lf0 || 1; }
    E.w0Nat = w ? s / w : num(opt(db, 'referenceWage'), 1);
  }
  for (const p of db.provinces) {
    p.vars = p.vars || {};
    if (!p.econ || p.econ.v !== 1) calibrateProvince(db, p);
    // groups added later (GM edits) calibrate on first sight
    for (const g in (p.demographics || {})) if (!p.econ.seg[g]) { calibrateProvince(db, p); break; }
  }
}

// ---------- industrial purchasing ----------------------------------------------
// Every site with supply-chain inputs (property.requires) and its own buying
// left on (autoSupply !== false) — expected use per turn of each input.
function inputUse(db) {
  const sim = require('./sim');
  const out = [];
  for (const pr of db.properties) {
    if (!pr.ownerId || pr.prodMode !== 'goods' || !Array.isArray(pr.requires) || !pr.requires.length) continue;
    const primary = (pr.produces || [])[0];
    if (!primary || !(primary.perTurn > 0)) continue;
    const ctx = sim.productionContext(db, pr, { noise: false });
    const cond = pr.vars && pr.vars.condition !== undefined ? pr.vars.condition / 100 : 1;
    const units = primary.perTurn * ctx.f * cond;
    for (const r of pr.requires) {
      if (!r.itemId || !(r.perUnit > 0)) continue;
      out.push({ pr, itemId: r.itemId, perTurn: r.perUnit * units });
    }
  }
  return out;
}
// What each site will try to buy this turn: up to `reorderTurns` of stock,
// at most three turns' use at a time.
function procurementWants(db) {
  const sim = require('./sim');
  const T = num(opt(db, 'reorderTurns'), 10);
  const wants = [];
  for (const w of inputUse(db)) {
    if (w.pr.autoSupply === false) continue;
    const stock = sim.inventoryQty(w.pr, w.itemId);
    const want = Math.min(Math.max(0, w.perTurn * T - stock), w.perTurn * 3);
    if (want > 1e-6) wants.push({ pr: w.pr, itemId: w.itemId, units: want });
  }
  return wants;
}

// ---------- the domestic market (called by sim.runEconomy) ----------------------
// offers: Map itemId → units offered for sale this turn. Returns Map itemId →
// { phi (share sold), price (the price trade happened at) }. Moves prices and
// records each good's market on item.meta.market (public market data).
function clearMarket(db, offers) {
  ensure(db);
  const E = national(db);
  const els = Object.assign({}, DEF.elasticity, settings(db).elasticity || {});
  const adj = opt(db, 'priceAdjust'), maxStep = opt(db, 'priceStepMax');
  const lo = opt(db, 'priceFloor'), hi = opt(db, 'priceCeil');
  const turn = db.settings.time.turn;
  const out = new Map();
  let foodSold = 0, foodOffered = 0, foodDemand = 0, foodImported = 0, importValue = 0, exportValue = 0;
  const tr = (db.settings.trade && db.settings.trade.tariffs) || {};
  const tariffs = Object.assign({ import: 0, export: 0 }, tr.global || {}, { byItem: tr.byItem || {} });
  let warSev = 0;
  try { warSev = require('./market').warSeverity(db); } catch (e) { /* market optional */ }
  const sim = require('./sim');
  const procure = new Map(); // itemId -> [{ pr, units }]
  for (const w of procurementWants(db)) {
    if (!procure.has(w.itemId)) procure.set(w.itemId, []);
    procure.get(w.itemId).push(w);
  }
  let procured = 0;
  for (const it of db.items) {
    const m = it.meta = it.meta || {};
    if (m.companyId || m.propertyId || m.bond) continue;
    const off = Math.max(0, offers.get(it.id) || 0);
    const buyers = procure.get(it.id) || [];
    // what firms can afford to buy this turn (never more than half their cash)
    const p0b = it.marketValue > 0 ? it.marketValue : (m.basePrice || 1);
    for (const b of buyers) {
      const acct = sim.primaryAccount(b.pr.ownerId, true);
      const allowNeg = !!(acct && acct.meta && acct.meta.allowNegative);
      const cash = acct ? (allowNeg ? Infinity : Math.max(0, acct.balance) * 0.5) : 0;
      b.units = Math.min(b.units, cash / Math.max(1e-9, p0b));
      b.acct = acct;
    }
    const Dp = buyers.reduce((t, b) => t + b.units, 0);
    if (!m.demand) {
      if (!(off > 0) && !(Dp > 0)) continue;
      // a good nobody made at calibration: its market is sized to its first seller
      m.demand = { kind: demandKind(it), base: r4(off), home0: r4(off), backlog: 0 };
    }
    if (!(m.basePrice > 0)) m.basePrice = it.marketValue > 0 ? it.marketValue : 1;
    // the GM or an event repriced it since last turn: that is the new fundamental
    if (m._lastPrice > 0 && it.marketValue > 0 && Math.abs(it.marketValue - m._lastPrice) > 1e-9) {
      m.basePrice = m.basePrice * it.marketValue / m._lastPrice;
    }
    const d = m.demand;
    const p0 = it.marketValue > 0 ? it.marketValue : m.basePrice;
    const rel = p0 / (m.basePrice * (E.cpi || 1));
    const idx = num(E.idx[d.kind], 1);
    const el = num(els[d.kind], 0.3);
    const Dc = Math.max(0, d.base * idx * Math.pow(Math.max(0.05, rel), -el)); // final demand
    const D = Dc + Dp;                                                            // + what industry buys
    // Lumpy goods (a hull every fifty turns) sell against demand that built up
    // while nothing was offered; perishable staples never carry over.
    const carry = d.kind === 'staple' ? 0 : Math.max(0, d.backlog || 0);
    const want = D + carry;
    // The rest of the world: once the home price reaches import parity (world
    // price + markup + tariff) imports fill part of a shortage; once it sinks
    // to export parity, part of a glut is sold abroad. Both have limited
    // capacity (a blockade cuts imports), so a real shortage still bites —
    // but a few percent of noise no longer runs away into inflation. State
    // procurement goods (military) have no background trade.
    let imports = 0, exports = 0;
    if (d.kind !== 'military') {
      const tImp = num(tariffs.import, 0) / 100 + num((tariffs.byItem[it.id] || {}).import, 0) / 100;
      const tExp = num(tariffs.export, 0) / 100 + num((tariffs.byItem[it.id] || {}).export, 0) / 100;
      const pImp = m.basePrice * (1 + opt(db, 'importMarkup') + tImp);
      const pExp = m.basePrice * Math.max(0.05, 1 - opt(db, 'exportDiscount') - tExp);
      // a good the country hardly makes can be imported in full; one it does
      // make only up to the cap (so a home shortage is a real shortage)
      const impCap = (opt(db, 'importCap') * D + Math.max(0, D - num(d.home0, d.base))) * (1 - 0.7 * warSev);
      if (want > off && p0 >= pImp * 0.999) imports = Math.min(want - off, impCap);
      if (off > want && p0 <= pExp * 1.001) exports = Math.min(off - want, opt(db, 'exportCap') * d.base);
      importValue += imports * p0; exportValue += exports * p0;
    }
    const soldHome = Math.min(off, want);
    const sold = soldHome + exports;
    const phi = off > 0 ? sold / off : 1;
    // industry's share of what reached buyers (home sales + imports) is
    // delivered to the buying sites and paid for by their owners
    const avail = soldHome + imports;
    if (Dp > 0 && avail > 0) {
      const share = Math.min(1, avail / Math.max(1e-9, want)) ;
      for (const b of buyers) {
        const units = cleanQ(b.units * share);
        if (!(units > 0)) continue;
        const cost = r2(units * p0);
        sim.addInventory(b.pr, it.id, units);
        if (cost > 0 && b.acct) sim.ledgerTxn(b.acct.id, null, cost, `Inputs: ${it.name} for ${b.pr.name}`, 'MARKET', 'withdraw');
        procured += cost;
      }
    }
    if (d.kind !== 'staple') {
      const cap = Math.max(d.base * 60, 1.5);
      d.backlog = r4(clamp((carry + D - soldHome - imports) * 0.97, 0, cap));
    }
    // price: smoothed demand ÷ (home supply + imports − exports), so a lumpy
    // good does not lurch
    const supplyEff = off + imports - exports;
    d.sEma = d.sEma === undefined ? supplyEff : d.sEma + (supplyEff - d.sEma) * 0.2;
    d.dEma = d.dEma === undefined ? D : d.dEma + (D - d.dEma) * 0.2;
    const ratio = d.sEma > 1e-9 ? d.dEma / d.sEma : (d.dEma > 1e-9 ? 4 : 1);
    let price = p0;
    if (Math.abs(ratio - 1) > 1e-6) {
      const cap = d.kind === 'staple' ? Math.min(maxStep, opt(db, 'stapleStepMax')) : maxStep;
      const step = clamp(adj * Math.log(Math.max(1e-6, ratio)), -cap, cap);
      price = clamp(p0 * Math.exp(step), m.basePrice * lo, m.basePrice * hi);
      it.marketValue = price < 10 ? r4(price) : r2(price);
    }
    m._lastPrice = it.marketValue;
    m.market = { offered: r2(off), demand: r2(D), sold: r2(soldHome), imports: r2(imports), exports: r2(exports), price: it.marketValue, base: r4(m.basePrice), turn };
    out.set(it.id, { phi, price: p0 });
    if (d.kind === 'staple') {
      const w = m.foodCalorieWeight || 1;
      const toPeople = D > 0 ? Dc / D : 1;
      foodSold += (soldHome + imports) * toPeople * w; foodOffered += off * w; foodDemand += Dc * w; foodImported += imports * toPeople * w;
    }
  }
  E.food = { sold: foodSold, offered: foodOffered, demand: foodDemand, imported: foodImported };
  E.trade = { imports: r2(importValue), exports: r2(exportValue), procured: r2(procured) };
  return out;
}

// Province services demand for cash-mode sites (shops, offices, casinos):
// read by sim.productionContext. 1 = the calibrated level.
function servicesIndex(db, provinceId) {
  const p = provinceId && db.provinces.find(x => x.id === provinceId);
  return p && p.econ && p.econ.svcIdx > 0 ? p.econ.svcIdx : 1;
}
// The going wage in a province (₳/day for its reference group) — what a site
// whose owner sets no wage pays, and what worker morale is measured against.
function marketWage(db, provinceId) {
  const p = provinceId && db.provinces.find(x => x.id === provinceId);
  if (p && p.econ && p.econ.w > 0) return p.econ.w;
  if (p && p.econ && p.econ.w0 > 0) return p.econ.w0;
  const E = db.econ;
  return E && E.w0Nat > 0 ? E.w0Nat : num(opt(db, 'referenceWage'), 1);
}

// ---------- income tax -----------------------------------------------------------
function pitOf(db, monthly) {
  const tax = db.settings.taxation;
  if (!tax || !tax.enabled || !tax.pitEnabled || !Array.isArray(tax.pitBrackets)) return 0;
  let t = 0, lower = 0;
  for (const b of tax.pitBrackets) {
    const upTo = b.upTo === null || b.upTo === undefined || !Number.isFinite(Number(b.upTo)) ? Infinity : Number(b.upTo);
    if (monthly > lower) t += (Math.min(monthly, upTo) - lower) * num(b.rate, 0);
    lower = upTo;
    if (monthly <= upTo) break;
  }
  return Math.max(0, t);
}

// ---------- the per-turn pass (after sim.runEconomy) ------------------------------
function runTurn(db, actor, monthBoundary, opts) {
  ensure(db);
  opts = opts || {};
  actor = actor || 'ENGINE';
  const sim = require('./sim');
  const E = national(db);
  const g = db.globalVars;
  const dt = daysPerTurn(db);
  E.days = num(E.days, 0) + dt;
  const N = num(opt(db, 'jobsPerEmployee'), 200);
  const tax = db.settings.taxation || {};
  const vat = tax.enabled ? num(tax.vatRate, 0) / 100 : 0;
  const line0 = num(g.povertyLine, 23);
  const lineNom = line0 * E.cpi;
  const sub = opt(db, 'subsistenceShare');
  const ub = clamp(num(opt(db, 'unemploymentBenefit'), 0), 0, 1);
  const stip = Math.max(0, num(settings(db).dependentStipend, 0));
  const stipGroups = settings(db).dependentGroups || [];
  const gEcon = govEcon(db);
  if (E.govEcon0 === undefined) E.govEcon0 = gEcon;
  const war = db.war && db.war.active ? db.war : null;
  const ctl = (war && war.stats && war.stats.provinceControl) || {};
  let warSev = 0;
  try { warSev = require('./market').warSeverity(db); } catch (e) { /* market optional */ }
  const crisis = g.bankCrisis ? num(g.bankCrisisSeverity, 0.5) : 0;
  const mktConf = num(g.econConfidence, 50);

  // listed jobs & pay per province (strikes keep people on the payroll)
  const listed = {};
  for (const pr of db.properties) {
    if (!pr.ownerId || !pr.provinceId || !(pr.employees > 0)) continue;
    const L = listed[pr.provinceId] = listed[pr.provinceId] || { emp: 0, pay: 0 };
    L.emp += pr.employees;
    L.pay += pr.employees * sim.wageFor(db, pr);
  }

  // ---- phase A: jobs, wages, incomes, what each group can afford ----
  const rows = []; // { p, gname, S, seg, role, ... } for the food & spending phases
  let natNeed0 = 0;
  for (const p of db.provinces) {
    const PE = p.econ, demo = p.demographics || {};
    // fold outside edits of province mood (events, GM) into the groups
    if (PE.last) {
      const dH = num(p.vars.happiness, PE.last.happiness) - PE.last.happiness;
      const dA = num(p.vars.approval, PE.last.approval) - PE.last.approval;
      if (Math.abs(dH) > 1e-6 || Math.abs(dA) > 1e-6) for (const gname in demo) {
        const S = demo[gname];
        if (dH) S.happiness = clamp(num(S.happiness, 50) + dH, 0, 100);
        if (dA) S.governmentSupport = clamp(num(S.governmentSupport, 50) + dA, 0, 100);
      }
    }
    let lf = 0;
    for (const gname in demo) if (inLabour(roleOf(db, gname))) lf += demo[gname].population || 0;
    const L = listed[p.id] || { emp: 0, pay: 0 };
    const listedJobs = L.emp * N;
    const occ = clamp(num(ctl[p.id], 0), 0, 100) / 100;
    // local economy follows what people spend here (last turn), the
    // population it serves, war on its streets and a banking collapse
    const popF = PE.lf0 > 0 ? lf / PE.lf0 : 1;
    const target = PE.localJobs0 * popF * Math.pow(clamp(num(PE.svcIdx, 1), 0.2, 3), 0.5) * (1 - 0.35 * occ) * (1 - 0.10 * crisis);
    PE.localJobs = Math.max(0, PE.localJobs + (target - PE.localJobs) * (1 - Math.pow(1 - opt(db, 'localAdjust'), dt)));
    const jobs = listedJobs + PE.localJobs;
    const empP = lf > 0 ? clamp(jobs / lf * 100, 0, 99) : num(p.vars.employment, 0);
    const uP = 100 - empP;
    // wages: the market wage heads for a level set by prices, productivity
    // growth and how tight labour is (a level, so it cannot drift away for
    // ever); listed employers pull it in proportion to their share of the jobs
    const gap = empP - num(PE.emp0, empP);
    const wTarget = PE.w0 * Math.pow(E.cpi || 1, opt(db, 'wageIndexation'))
      * Math.exp(opt(db, 'productivityGrowth') * num(E.days, 0) / 365)
      * clamp(1 + opt(db, 'wageFlex') * gap, 0.6, 1.4);
    PE.wMarket = PE.wMarket + (wTarget - PE.wMarket) * (1 - Math.pow(1 - opt(db, 'wageAdjust'), dt));
    const share = jobs > 0 ? clamp(listedJobs / jobs, 0, 1) : 0;
    const leadMax = opt(db, 'labourLeadMax');
    const listedAvg = L.emp > 0 ? clamp(L.pay / L.emp, PE.wMarket * 0.2, PE.wMarket * leadMax) : PE.wMarket;
    const lead = Math.pow(listedAvg / PE.wMarket, share);
    if (PE.lead0 === undefined) PE.lead0 = lead;
    PE.w = r4(PE.wMarket * lead / (PE.lead0 || 1));
    // unemployment by group: the calibrated exposure, renormalised to the province rate
    let uSum = 0;
    for (const gname in demo) if (inLabour(roleOf(db, gname))) uSum += (demo[gname].population || 0) * uP * num(PE.seg[gname].exposure, 1);
    const uNorm = uSum > 0 ? uP * lf / uSum : 1;
    let wInc = 0, wPop = 0, wageBill = 0;
    for (const gname in demo) {
      const role = roleOf(db, gname);
      if (!inLabour(role)) continue;
      const S = demo[gname], seg = PE.seg[gname], pop = S.population || 0;
      const u = clamp(uP * num(seg.exposure, 1) * uNorm, 0, 95);
      S.unemployment = r2(u); S.employment = r2(100 - u);
      const wageMonth = PE.w * num(seg.wageMult, 1) * 30;
      S.income = r2(wageMonth * (100 - u) / 100 + ub * wageMonth * u / 100);
      wInc += pop * S.income; wPop += pop;
      wageBill += pop * PE.w * num(seg.wageMult, 1) * (100 - u) / 100;
    }
    const avgWorkerInc = wPop > 0 ? wInc / wPop : PE.w * 30;
    for (const gname in demo) {
      const role = roleOf(db, gname);
      if (inLabour(role)) continue;
      const S = demo[gname];
      S.income = r2(num(PE.seg[gname].transferRatio, 0.4) * avgWorkerInc);
      S.employment = r2(empP); S.unemployment = r2(uP);
    }
    PE.employment = empP; PE.lf = lf; PE.jobs = jobs; PE.wageBill = wageBill; PE.occ = occ;
    // need & affordability
    for (const gname in demo) {
      const S = demo[gname], seg = PE.seg[gname], role = roleOf(db, gname), pop = S.population || 0;
      // opt-in welfare: settings.economy.dependentStipend is ₳ per 1,000 people per turn
      if (stip > 0 && stipGroups.includes(gname)) S.income = r2(S.income + stip / 1000 * 30 / dt);
      const T = pitOf(db, S.income);
      const Y = Math.max(0, S.income - T);
      const need = pop * E.needPerCap; // food units per turn (the farms' perTurn scale)
      const subsist = role === 'rural' ? need * sub * (1 - 0.6 * occ) : 0;
      const comNeed = Math.max(0, need - subsist);
      const reqFood = num(seg.f0, 0.4) * num(seg.income0, S.income) * num(E.fpi, 1); // ₳/month for a full bought diet
      const canSpend = 0.85 * Y + Math.min(num(S.savings, 0) * 0.1, Y);
      const afford = reqFood > 0 ? clamp(canSpend / reqFood, 0, 1) : 1;
      rows.push({ p, PE, gname, S, seg, role, pop, T, Y, need, subsist, comNeed, reqFood, afford, demand: comNeed * afford });
      natNeed0 += comNeed;
    }
  }

  // ---- phase B: food — the market's sales, then relief stocks, by need & means ----
  const F = E.food ? num(E.food.sold, 0) : 0; // food units the farms sold this turn
  const totalDemand = rows.reduce((s, r) => s + r.demand, 0);
  // Households and shops hold a few days' food: a day's shortfall is eaten
  // out of the pantry, a sustained one empties it (smoothed fill).
  const fillRaw = totalDemand > 0 ? Math.min(1, F / totalDemand) : 1;
  E.fillEma = E.fillEma === undefined ? fillRaw : E.fillEma + (fillRaw - E.fillEma) * Math.min(1, 0.2 * dt);
  const fill = Math.min(1, E.fillEma);
  const reliefDecay = num(settings(db).reliefDecay, opt(db, 'reliefDecay'));
  const byProv = {};
  for (const r of rows) {
    r.bought = r.demand * fill;
    (byProv[r.p.id] = byProv[r.p.id] || []).push(r);
  }
  let natFed = 0, natNeed = 0;
  for (const p of db.provinces) {
    const list = byProv[p.id] || [];
    let stock = Math.max(0, num(p.vars.foodStock, 0));
    const gaps = list.map(r => Math.max(0, r.need - r.subsist - r.bought));
    const gapSum = gaps.reduce((s, x) => s + x, 0);
    const used = Math.min(stock, gapSum);
    let fed = 0, need = 0;
    list.forEach((r, i) => {
      r.relief = gapSum > 0 ? used * gaps[i] / gapSum : 0;
      const got = r.subsist + r.bought + r.relief;
      r.access = r.need > 0 ? clamp(got / r.need, 0, 1) : 1;
      r.S.foodAccess = r2(r.access * 100);
      fed += got; need += r.need;
    });
    stock = Math.max(0, (stock - used) * (1 - reliefDecay));
    p.vars.foodStock = r2(stock);
    p.vars.foodSecurity = need > 0 ? Math.round(clamp(fed / need, 0, 1) * 1000) / 10 : 100;
    p.econ.fsSum = num(p.econ.fsSum, 0) + p.vars.foodSecurity; p.econ.fsN = num(p.econ.fsN, 0) + 1;
    natFed += fed; natNeed += need;
  }

  // ---- phase C: spending, saving, taxes, the indices the market reads next turn ----
  let pit = 0, vatRev = 0, stipPaid = 0, ubPaid = 0, spendAll = 0, nonFoodReal = 0, savingsTot = 0;
  const provSpend = {};
  for (const r of rows) {
    const { S, seg, pop } = r;
    const foodSpend = r.reqFood * (r.comNeed > 0 ? r.bought / r.comNeed : 0);
    const avail = Math.max(0, r.Y - foodSpend);
    const sRate = clamp(0.3 * (1 - 2.5 * lineNom / Math.max(1, S.income)), 0, 0.3);
    let C = avail * (1 - sRate);
    // consumption smoothing: fall back on savings when income drops
    if (seg.cPrev !== undefined && C < 0.9 * seg.cPrev && S.savings > 0) {
      C += Math.min(S.savings * 0.03, 0.9 * seg.cPrev - C);
    }
    seg.cPrev = C;
    S.savings = r2(Math.max(0, num(S.savings, 0) + (r.Y - foodSpend - C) * dt / 30));
    S.netIncome = r2(r.Y);
    S.incomeTax = r2(r.T);
    const perDay = pop / 30 * dt;
    pit += r.T * perDay;
    // VAT is inside what people pay: the state takes vat/(1+vat) of it, and
    // only the rest buys goods (real consumption falls with the rate)
    vatRev += C * vat / (1 + vat) * perDay;
    if (stip > 0 && stipGroups.includes(r.gname)) stipPaid += pop * stip / 1000;
    if (ub > 0 && inLabour(r.role)) ubPaid += pop * ub * r.PE.w * num(seg.wageMult, 1) * num(S.unemployment, 0) / 100 * dt;
    spendAll += (foodSpend + C) * perDay;
    nonFoodReal += C / (1 + vat) * perDay / (E.gpi || 1);
    provSpend[r.p.id] = (provSpend[r.p.id] || 0) + (foodSpend + C) * perDay / (E.cpi || 1);
    savingsTot += S.savings * pop;
  }
  // treasury flows (real money): taxes in, welfare out — one entry each
  const treasury = db.accounts.find(a => a.id === 'acct_treasury');
  if (treasury) {
    if (pit > 0.005) sim.ledgerTxn(null, treasury.id, r2(pit), 'Personal income tax', 'TREASURY', 'deposit');
    if (vatRev > 0.005) sim.ledgerTxn(null, treasury.id, r2(vatRev), 'Value-added tax', 'TREASURY', 'deposit');
    if (stipPaid > 0.005) sim.ledgerTxn(treasury.id, null, r2(stipPaid), 'Welfare stipends', actor, 'withdraw');
    if (ubPaid > 0.005) sim.ledgerTxn(treasury.id, null, r2(ubPaid), 'Unemployment benefit', actor, 'withdraw');
  }

  // ---- prices: food, goods, services → consumer price index ----
  const pIndex = (kind) => {
    let w = 0, s = 0;
    for (const it of db.items) {
      const m = it.meta;
      if (!m || !m.demand || m.demand.kind !== kind || !(m.basePrice > 0)) continue;
      const wt = m.demand.base * m.basePrice;
      w += wt; s += wt * (it.marketValue / m.basePrice);
    }
    return w > 0 ? s / w : null;
  };
  const fpi = pIndex('staple'), gpi = pIndex('consumer');
  let spW = 0, spS = 0;
  for (const p of db.provinces) if (p.econ.w0 > 0) { spW += p.econ.lf || 0; spS += (p.econ.lf || 0) * p.econ.w / p.econ.w0; }
  const spi = spW > 0 ? spS / spW : 1;
  const parts = [[0.35, fpi], [0.25, gpi], [0.40, spi]].filter(x => x[1] !== null);
  const wsum = parts.reduce((s, x) => s + x[0], 0) || 1;
  const cpi = parts.reduce((s, x) => s + x[0] * x[1], 0) / wsum;
  const prevCpi = E.cpi || 1;
  E.inflDaily = dt > 0 ? Math.log(cpi / prevCpi) / dt : 0;
  E.inflEma = num(E.inflEma, 0) + (E.inflDaily - num(E.inflEma, 0)) * Math.min(1, dt / 30);
  E.cpi = cpi; E.fpi = fpi === null ? 1 : fpi; E.gpi = gpi === null ? 1 : gpi; E.spi = spi;

  // demand indices for next turn's market
  if (E.nonFoodReal0 === undefined && nonFoodReal > 0) E.nonFoodReal0 = nonFoodReal;
  if (E.comNeed0 === undefined && natNeed0 > 0) E.comNeed0 = natNeed0;
  E.idx.staple = E.comNeed0 > 0 ? clamp(totalDemand / E.comNeed0, 0, 5) : 1;
  E.idx.consumer = E.nonFoodReal0 > 0 ? clamp(nonFoodReal / E.nonFoodReal0, 0.1, 5) : 1;
  E.idx.military = 1 + (war ? 0.6 : 0) + (db.protest && db.protest.active ? 0.1 : 0);

  // ---- phase D: output, attitudes, statistics per province ----
  const actualWar = warSev;
  let gdpNom = 0, natJobs = 0, natLf = 0, natW = 0, natW0 = 0, natInc = 0, natPop = 0, natPoor = 0;
  const natPts = [];
  for (const p of db.provinces) {
    const PE = p.econ, demo = p.demographics || {};
    // services index: real local spending vs the calibrated level
    const real = provSpend[p.id] || 0;
    if (PE.spend0 === undefined && real > 0) PE.spend0 = real;
    PE.svcIdx = PE.spend0 > 0 ? r4(clamp(real / PE.spend0, 0.2, 3)) : 1;
    // GDP: the wage bill grossed up, tilted by what the listed sites made
    // (listed output smoothed over a few weeks — a hull every fifty turns or a
    // site waiting on inputs must not jerk a province's GDP around)
    PE.listedEma = PE.listedEma === undefined ? num(PE.listedGross, 0) : PE.listedEma + (num(PE.listedGross, 0) - PE.listedEma) * Math.min(1, dt / 20);
    if (PE.listedGross0 === undefined && PE.listedEma > 0) PE.listedGross0 = PE.listedEma;
    const lIdx = PE.listedGross0 > 0 ? clamp(PE.listedEma / PE.listedGross0, 0.2, 3) : 1;
    const gdp = PE.wageBill * 365 / 1e6 * PE.gdpK * (0.9 + 0.1 * lIdx);
    p.vars.gdp = r2(gdp);
    p.vars.gdpReal = r2(gdp / (E.cpi || 1));
    gdpNom += gdp;
    // poverty & inequality from each group's income spread
    const pts = [];
    let poor = 0, pop = 0, gap = 0, inc = 0;
    for (const gname in demo) {
      const S = demo[gname], n = S.population || 0;
      if (!(n > 0)) continue;
      const sg = spreadOf(db, gname);
      const ps = povertyShare(S.income, lineNom, sg);
      S.poverty = r2(ps * 100);
      poor += ps * n; pop += n; inc += S.income * n;
      gap += n * ps * clamp(1 - S.income / Math.max(1, lineNom * 2), 0, 1);
      for (const q of quintilePoints(S.income, n, sg)) { pts.push(q); natPts.push(q); }
    }
    p.vars.povertyRate = pop ? r2(poor / pop * 100) : 0;
    p.vars.povertyGap = pop ? r2(gap / pop * 100) : 0;
    p.vars.giniIndex = r2(gini(pts));
    if (PE.gini0 === undefined) PE.gini0 = p.vars.giniIndex;
    p.vars.income = pop ? r2(inc / pop) : 0;
    p.vars.wage = r2(PE.w);
    p.vars.employment = r2(PE.employment);
    p.vars.unemployment = r2(100 - PE.employment);
    natPop += pop; natPoor += poor; natInc += inc;
    natJobs += Math.min(PE.jobs, PE.lf); natLf += PE.lf;
    natW += (PE.lf || 0) * PE.w; natW0 += (PE.lf || 0) * PE.w0;
    // attitudes: targets from lived conditions; drift toward them
    const hc = num(p.vars.healthcare, PE.hc0), edu = num(p.vars.education, PE.edu0), crime = num(p.vars.crime, PE.crime0);
    const svcTerm = 0.12 * (hc - PE.hc0) + 0.08 * (edu - PE.edu0) - 0.12 * (crime - PE.crime0);
    const warTerm = -20 * actualWar - 25 * PE.occ;
    const ineqTerm = -40 * (p.vars.giniIndex - num(PE.gini0, p.vars.giniIndex));
    // inflation reaches happiness through real incomes; confidence also
    // reads the rate itself (a month-smoothed annual pace)
    const inflA = E.inflEma * 365 * 100;
    const priceTerm = -clamp((inflA - 5) * 0.3, 0, 12);
    for (const gname in demo) {
      const S = demo[gname], seg = PE.seg[gname];
      // what the group lives on: income after income tax, at today's prices
      // (VAT is in the prices people pay)
      const realInc = Math.max(0.01, num(S.netIncome, S.income) / ((E.cpi || 1) * (1 + vat)));
      // expectations adapt over about a year; the short reference over a season
      seg.ref = seg.ref + (realInc - seg.ref) * Math.min(1, dt / 365);
      seg.ref3 = seg.ref3 + (realInc - seg.ref3) * Math.min(1, dt / 90);
      const incomeTerm = clamp(30 * Math.log(realInc / Math.max(0.01, seg.ref)), -25, 25);
      const shortTerm = clamp(30 * Math.log(realInc / Math.max(0.01, seg.ref3)), -20, 20);
      const jobTerm = inLabour(roleOf(db, gname)) ? -0.6 * (num(S.unemployment, 0) - num(seg.u0, 0)) : -0.25 * (100 - PE.employment - (100 - num(PE.emp0, PE.employment)));
      const foodTerm = -0.7 * Math.max(0, 97 - num(S.foodAccess, 100));
      seg.tH = clamp(seg.h0 + incomeTerm + jobTerm + foodTerm + svcTerm + warTerm + ineqTerm, 3, 97);
      seg.tEC = clamp(seg.ec0 + 0.8 * shortTerm + 1.2 * jobTerm + priceTerm + 0.2 * (mktConf - 50) - 25 * crisis + 0.5 * warTerm, 3, 97);
      const lean = num(S.politicalLeaning, 0);
      const ideoTerm = -0.15 * (Math.abs(lean - gEcon) - Math.abs(lean - E.govEcon0));
      seg.tGS = clamp(seg.gs0 + 0.55 * (num(S.happiness, seg.h0) - seg.h0) + 0.25 * (num(S.economicConfidence, seg.ec0) - seg.ec0) + ideoTerm, 3, 97);
    }
    if (!opts.demoTicked) drift(db, dt, p);
    // province aggregates
    let h = 0, a = 0, ec = 0;
    for (const gname in demo) {
      const S = demo[gname], n = S.population || 0;
      h += n * num(S.happiness, 50); a += n * num(S.governmentSupport, 50); ec += n * num(S.economicConfidence, 50);
    }
    p.vars.happiness = pop ? r2(h / pop) : 50;
    p.vars.approval = pop ? r2(a / pop) : 50;
    p.vars.economicConfidence = pop ? r2(ec / pop) : 50;
    p.vars.population = Object.values(demo).reduce((s, x) => s + (x.population || 0), 0);
    PE.last = { happiness: p.vars.happiness, approval: p.vars.approval };
  }

  // industrial demand follows real output
  const gdpRealNow = gdpNom / (E.cpi || 1);
  if (E.gdpReal0 === undefined && gdpRealNow > 0) E.gdpReal0 = gdpRealNow;
  E.idx.industrial = E.gdpReal0 > 0 ? r4(clamp(gdpRealNow / E.gdpReal0, 0.2, 5)) : 1;

  settle(db, { nonFoodReal, natNeed0, gdpRealNow, provSpend });

  // ---- monthly: real growth, then population ----
  if (monthBoundary) {
    E.cpiMonths = (E.cpiMonths || []).concat([E.cpi]).slice(-13);
    const real = db.provinces.reduce((s, p) => s + num(p.vars.gdpReal, 0), 0);
    if (E.gdpRealLastMonth > 0 && real > 0) g.realGrowthAnnual = r4(Math.pow(real / E.gdpRealLastMonth, 12) - 1);
    E.gdpRealLastMonth = real;
    runPopulation(db, actor);
  }

  // ---- national statistics ----
  const avgW = natLf ? natW / natLf : 0;
  g.population = db.provinces.reduce((s, p) => s + (p.vars.population || 0), 0);
  g.gdp = r2(gdpNom);
  g.gdpReal = r2(gdpNom / (E.cpi || 1));
  g.cpi = r2(E.cpi * 100);
  // inflation over the last twelve months (annualised over fewer while the
  // record is shorter); confidence reads the month-smoothed pace instead
  const cm = E.cpiMonths || [];
  g.inflation = cm.length >= 5 ? r2((Math.pow(E.cpi / cm[0], 12 / Math.min(12, cm.length - 1)) - 1) * 100) : r2(E.inflEma * 365 * 100);
  g.foodPriceIndex = r2((E.fpi || 1) * 100);
  g.averageDailyWage = r2(avgW);
  g.wageIndex = natW0 ? r2(natW / natW0 * 100) : 100;
  g.realWageIndex = natW0 ? r2(natW / natW0 / (E.cpi || 1) * 100) : 100;
  g.laborForce = Math.round(natLf);
  g.totalEmployment = Math.round(natJobs);
  g.unemploymentRate = natLf ? r2((1 - natJobs / natLf) * 100) : 0;
  g.avgIncome = natPop ? r2(natInc / natPop) : 0;
  g.consumerSpending = r2(spendAll / Math.max(1e-9, dt)); // ₳ per day
  g.householdSavings = Math.round(savingsTot);
  g.povertyLineNominal = r2(lineNom);
  g.povertyRateNational = natPop ? r2(natPoor / natPop * 100) : 0;
  g.giniNational = r2(gini(natPts));
  g.foodSecurity = natNeed > 0 ? Math.round(clamp(natFed / natNeed, 0, 1) * 1000) / 10 : 100;
  g.foodSupplied = r2(F); g.foodNeed = r2(natNeed);
  g.foodImported = r2((E.food && E.food.imported) || 0);
  g.bgImports = r2((E.trade && E.trade.imports) || 0);   // the rest of the economy's imports/exports this turn (₳)
  g.bgExports = r2((E.trade && E.trade.exports) || 0);
  g.pitRevenue = r2(pit); g.vatRevenue = r2(vatRev);
  g.welfareSpending = r2(stipPaid + ubPaid); g.lastStipendSpend = r2(stipPaid);
  g.warSeverity = r2(actualWar);
  const named = new Set(db.entities.filter(e => e.type === 'person').map(e => e.id));
  g.namedCitizenWealth = r2(db.accounts.filter(a => named.has(a.ownerId)).reduce((s, a) => s + (a.balance || 0), 0));
  refreshHealthStats(db);
}

// Settling: calibration reads the world's RATED output, but sites run a
// little below it in practice (accidents and rehiring, moods, inputs). For
// the first SETTLE_TURNS turns the engine watches what actually happens, then
// re-reads "normal" from it once: each good's market, the food need per
// head, and the spending/output baselines the indices measure against.
const SETTLE_SKIP = 15, SETTLE_TURNS = 30;
function settle(db, now) {
  const E = national(db);
  if (E.settled) return;
  const S = E.settling = E.settling || { seen: 0, n: 0, offers: {}, food: 0, nonFood: 0, need: 0, gdp: 0, spend: {}, emp: {} };
  S.seen++;
  if (S.seen <= SETTLE_SKIP) return; // let accidents, rehiring and moods find their level first
  S.n++;
  for (const p of db.provinces) if (p.econ) S.emp[p.id] = (S.emp[p.id] || 0) + num(p.econ.employment, 0);
  for (const it of db.items) {
    const m = it.meta;
    if (m && m.demand && m.market && m.market.turn === db.settings.time.turn) S.offers[it.id] = (S.offers[it.id] || 0) + num(m.market.offered, 0);
  }
  S.food += num(E.food && E.food.offered, 0);
  S.nonFood += num(now.nonFoodReal, 0); S.need += num(now.natNeed0, 0); S.gdp += num(now.gdpRealNow, 0);
  for (const pid in now.provSpend) S.spend[pid] = (S.spend[pid] || 0) + now.provSpend[pid];
  if (S.n < SETTLE_TURNS) return;
  const n = S.n;
  for (const it of db.items) {
    const d = it.meta && it.meta.demand;
    if (!d || !(d.home0 > 0) || S.offers[it.id] === undefined) continue;
    const ratio = clamp((S.offers[it.id] / n) / d.home0, 0.5, 1.5);
    d.base = r4(d.base * ratio); d.home0 = r4(d.home0 * ratio);
    d.sEma = undefined; d.dEma = undefined; d.backlog = 0;
  }
  if (E.foodBase > 0 && S.food > 0) {
    E.needPerCap = E.needPerCap * clamp((S.food / n) / E.foodBase, 0.5, 1.5);
    E.foodBase = S.food / n;
  }
  E.comNeed0 = undefined; // re-read next turn at the settled need
  if (S.nonFood > 0) E.nonFoodReal0 = S.nonFood / n;
  if (S.gdp > 0) E.gdpReal0 = S.gdp / n;
  for (const p of db.provinces) {
    if (!p.econ) continue;
    if (S.spend[p.id] > 0) p.econ.spend0 = S.spend[p.id] / n;
    if (S.emp[p.id] > 0) p.econ.emp0 = r2(S.emp[p.id] / n); // the province's normal employment
  }
  E.fillEma = undefined;
  E.settled = true;
  delete E.settling;
}

// Attitudes drift toward their lived-condition targets. `days` is the
// world-time width (a turn, or a demographics-cadence slice).
function drift(db, days, onlyProvince) {
  const kH = 1 - Math.pow(1 - 0.04, days), kE = 1 - Math.pow(1 - 0.08, days), kS = 1 - Math.pow(1 - 0.025, days);
  for (const p of (onlyProvince ? [onlyProvince] : db.provinces)) {
    if (!p.econ || !p.econ.seg) continue;
    for (const gname in (p.demographics || {})) {
      const S = p.demographics[gname], seg = p.econ.seg[gname];
      if (!seg || seg.tH === undefined) continue;
      S.happiness = r2(num(S.happiness, seg.tH) + (seg.tH - num(S.happiness, seg.tH)) * kH);
      S.economicConfidence = r2(num(S.economicConfidence, seg.tEC) + (seg.tEC - num(S.economicConfidence, seg.tEC)) * kE);
      S.governmentSupport = r2(num(S.governmentSupport, seg.tGS) + (seg.tGS - num(S.governmentSupport, seg.tGS)) * kS);
    }
  }
}

// ---------- population (monthly) ----------
function runPopulation(db, actor) {
  const g = db.globalVars;
  let births = 0, deaths = 0, famine = 0;
  const warSev = num(g.warSeverity, 0);
  for (const p of db.provinces) {
    const PE = p.econ, demo = p.demographics || {};
    if (!PE) continue;
    const fsAvg = PE.fsN > 0 ? PE.fsSum / PE.fsN : num(p.vars.foodSecurity, 100);
    PE.fsSum = 0; PE.fsN = 0;
    const hc = num(p.vars.healthcare, 50);
    const dis = opt(db, 'diseaseK') * Math.max(0, 100 - hc) / 100;
    const dA = opt(db, 'adultDeathRate') + dis, dR = opt(db, 'oldAgeRate') + dis;
    let W = 0, Spop = 0, R = 0, total = 0, hap = 0;
    const workers = [], students = [], retired = [];
    for (const gname in demo) {
      const S = demo[gname], role = roleOf(db, gname), n = S.population || 0;
      total += n; hap += n * num(S.happiness, 50);
      if (role === 'student') { Spop += n; students.push(gname); }
      else if (role === 'retired') { R += n; retired.push(gname); }
      else { W += n; workers.push(gname); }
    }
    if (!(total > 0)) continue;
    const avgHap = hap / total;
    const fsF = clamp(fsAvg / 90, 0.5, 1);
    const bRate = opt(db, 'birthRate') * clamp(1 + 0.004 * (avgHap - 50), 0.7, 1.3) * fsF * (1 - 0.3 * warSev);
    const m = 1 / 12;
    const delta = {};
    const add = (gname, v) => { delta[gname] = (delta[gname] || 0) + v; };
    // births join the working-age groups in proportion (childhood abstracted)
    const B = bRate * total * m;
    for (const gname of workers) add(gname, B * (demo[gname].population || 0) / Math.max(1, W));
    births += B;
    // deaths: age, disease, and famine where food access has failed
    for (const gname in demo) {
      const S = demo[gname], n = S.population || 0, role = roleOf(db, gname);
      const base = role === 'retired' ? dR : dA;
      // hunger kills only once access falls below 90% (a lean month is not a famine)
      const acc = Math.min(num(S.foodAccess, 100), fsAvg + 10) / 100;
      const short = Math.max(0, (0.9 - acc) / 0.9);
      const fam = opt(db, 'famineMortalityK') * short * short;
      const d = n * (base + fam) * m;
      add(gname, -d);
      deaths += d; famine += n * fam * m;
    }
    // ageing into retirement, entering and leaving school
    const ret = num(PE.retire, 0) * m, enr = num(PE.enroll, 0) * m, grad = opt(db, 'graduationRate') * m;
    const out = (ret + enr);
    for (const gname of workers) {
      const n = demo[gname].population || 0;
      add(gname, -n * out);
    }
    for (const gname of retired) add(gname, W * ret * (R > 0 ? (demo[gname].population || 0) / R : 1 / retired.length));
    for (const gname of students) add(gname, W * enr * (demo[gname].population || 0) / Math.max(1, Spop) - (demo[gname].population || 0) * grad);
    for (const gname of workers) add(gname, Spop * grad * (demo[gname].population || 0) / Math.max(1, W));
    // the class ladder: up with schooling and growth, down with unemployment
    const ladder = (settings(db).ladder || []).filter(x => demo[x]);
    const growth = clamp(num(g.realGrowthAnnual, 0), -0.2, 0.2);
    for (let i = 0; i + 1 < ladder.length && i < (PE.mob || []).length; i++) {
      const lo = demo[ladder[i]], hi = demo[ladder[i + 1]], mob = PE.mob[i];
      const upR = mob.up * clamp(num(lo.education, 50) / 50, 0.3, 2) * clamp(1 + 3 * growth, 0.3, 2) * m;
      const downR = mob.down * clamp(num(hi.unemployment, 0) / Math.max(0.5, num(PE.seg[ladder[i + 1]] && PE.seg[ladder[i + 1]].u0, 5)), 0.3, 3) * m;
      const flow = (lo.population || 0) * upR - (hi.population || 0) * downR;
      add(ladder[i], -flow); add(ladder[i + 1], flow);
    }
    // urbanisation: faster when towns pay better than they used to
    const urb = settings(db).urbanize || {};
    if (urb.from && urb.to && demo[urb.from] && demo[urb.to]) {
      const gapNow = (demo[urb.to].income || 1) / Math.max(1, demo[urb.from].income || 1);
      const rate = opt(db, 'urbanization') * clamp(1 + 2 * (gapNow / num(PE.gap0, gapNow) - 1), 0, 3) * m;
      const mv = (demo[urb.from].population || 0) * rate;
      add(urb.from, -mv); add(urb.to, mv);
    }
    for (const gname in delta) {
      const S = demo[gname];
      S.population = Math.max(0, Math.round((S.population || 0) + delta[gname]));
    }
    const newTotal = Object.values(demo).reduce((s, x) => s + (x.population || 0), 0);
    p.vars.population = newTotal;
    p.vars.birthRate = r2(bRate * 1000);
    PE.lastBirths = Math.round(B);
  }
  g.lastMonthBirths = Math.round(births);
  g.lastMortalityDeaths = Math.round(deaths);
  g.famineDeaths = Math.round(num(g.famineDeaths, 0) + famine);
  const pop = db.provinces.reduce((s, p) => s + (p.vars.population || 0), 0);
  g.population = pop;
  g.populationGrowthAnnual = pop > 0 ? r2((births - deaths) * 12 / pop * 100) : 0;
  if (famine >= 100) {
    const worst = [...db.provinces].sort((a, b) => num(a.vars.foodSecurity, 100) - num(b.vars.foodSecurity, 100))[0];
    const sim = require('./sim');
    if (!g._famineNewsAt || db.settings.time.turn - g._famineNewsAt > 25) {
      g._famineNewsAt = db.settings.time.turn;
      sim.draftNews(`HUNGER IN ${String(worst.name || worst.id).toUpperCase()}`,
        `Food security in ${worst.name} averaged ${Math.round(num(worst.vars.foodSecurity, 0))}% this month. The State Statistical Bureau attributes ${fmtNum(famine)} excess deaths nationwide to hunger. ` +
        'Prices for staples are rising; the government holds the national reserve.', 'Economy', false, 'State Statistical Bureau');
    }
    store.log('simulation', 'Hunger deaths this month', `${fmtNum(famine)} excess deaths from food shortage`, actor || 'ENGINE', []);
  }
}

// Life expectancy & infant mortality track healthcare and hunger; mortality
// per 1000 a year from the same death rates the population pass uses.
function refreshHealthStats(db) {
  for (const p of db.provinces) {
    if (!p.vars) continue;
    const hc = num(p.vars.healthcare, 50);
    const fs = num(p.vars.foodSecurity, 100);
    const dis = opt(db, 'diseaseK') * Math.max(0, 100 - hc) / 100;
    let n = 0, d = 0;
    for (const gname in (p.demographics || {})) {
      const S = p.demographics[gname], pop = S.population || 0, role = roleOf(db, gname);
      const short = Math.max(0, (0.9 - num(S.foodAccess, 100) / 100) / 0.9);
      d += pop * ((role === 'retired' ? opt(db, 'oldAgeRate') : opt(db, 'adultDeathRate')) + dis + opt(db, 'famineMortalityK') * short * short);
      n += pop;
    }
    p.vars.mortalityRate = n ? r2(d / n * 1000) : 0;
    p.vars.lifeExpectancy = Math.round(clamp(60 + (hc - 40) * 0.3 - Math.max(0, 95 - fs) * 0.4, 35, 95));
    p.vars.infantMortality = Math.round(clamp(45 - (hc - 40) * 0.6 + Math.max(0, 95 - fs) * 0.8, 5, 150));
  }
}

// ---------- the national food reserve ----------
// Release staple food from the government's inventory into provinces' relief
// stock (eaten first wherever people cannot buy enough). Split by population.
function releaseFood(db, itemId, qty, provinceIds, actor) {
  const item = (db.items || []).find(i => i.id === itemId);
  if (!item) throw new Error('Unknown item.');
  const meta = item.meta && item.meta.stapleFood ? item.meta : null;
  if (!meta) throw new Error(item.name + ' is not a staple food.');
  const gov = db.entities.find(e => e.id === 'ent_gov') || db.entities.find(e => e.type === 'government');
  if (!gov) throw new Error('No government entity found.');
  gov.inventory = gov.inventory || [];
  const row = gov.inventory.find(r => r.itemId === itemId);
  const weight = meta.foodCalorieWeight || 1;
  const requested = Math.round(Number(qty) || 0);
  if (!(requested > 0)) throw new Error('Quantity must be positive.');
  if (!row || row.qty < requested) throw new Error('Not enough in the national reserve (' + fmtNum(Math.round(row ? row.qty : 0)) + ' available).');
  const provs = (provinceIds && provinceIds.length)
    ? provinceIds.map(id => db.provinces.find(p => p.id === id)).filter(Boolean)
    : db.provinces.filter(p => (p.vars.population || 0) > 0);
  if (!provs.length) throw new Error('No valid target provinces.');
  const popTot = provs.reduce((t, p) => t + Math.max(0, Number(p.vars.population) || 0), 0);
  const delivered = {};
  let left = requested;
  provs.forEach((p, i) => {
    const share = i === provs.length - 1 ? left
      : r2(requested * (popTot > 0 ? Math.max(0, Number(p.vars.population) || 0) / popTot : 1 / provs.length));
    left = r2(left - share);
    p.vars.foodStock = r2((p.vars.foodStock || 0) + share * weight);
    delivered[p.id] = share;
  });
  row.qty = r2(row.qty - requested);
  if (row.qty <= 0) gov.inventory = gov.inventory.filter(r => r !== row);
  store.log('simulation', 'Food released to provinces',
    fmtNum(requested) + ' × ' + item.name + ' → ' + provs.map(p => p.name).join(', '), actor || 'ENGINE', ['ent_gov']);
  return { itemId, qty: requested, weight, provinces: delivered };
}

// Days of food the relief stock in a province covers at its current need.
function reliefDays(db, p) {
  const E = db.econ;
  const need = (p.vars.population || 0) * ((E && E.needPerCap) || 0);
  return need > 0 ? (p.vars.foodStock || 0) / need : null;
}

// Campaign targeting (election.js): share of a group (or a whole province)
// below the poverty line, 0..1 — null when there is no such data.
function povertyOf(db, provinceId, group) {
  const p = db.provinces.find(x => x.id === provinceId);
  if (!p) return null;
  if (group && group !== 'all') {
    const S = p.demographics && p.demographics[group];
    return S && S.poverty !== undefined ? clamp(S.poverty / 100, 0, 1) : null;
  }
  return p.vars && p.vars.povertyRate !== undefined ? clamp(p.vars.povertyRate / 100, 0, 1) : null;
}

module.exports = {
  DEF, ensure, calibrateMarket, calibrateProvince, clearMarket, runTurn, drift, runPopulation,
  releaseFood, reliefDays, servicesIndex, marketWage, povertyOf, pitOf, daysPerTurn, roleOf,
  povertyShare, gini
};
