'use strict';
/* Domestic economy & fiscal overhaul — Phase 1..4 (DOC-ARC-ECON-001).
   The household collection is a REPRESENTATIVE model: each province × group
   splits into five quintile households (175 total), each owning its own
   account (never ent_gov). These passes turn that data into behaviour:

     runWages        — wages flow from owners to households instead of being
                       destroyed at the world edge (§6.2).
     runConsumption  — household spending against cash & income (§6).
     runFoodSupply   — real circulating food stock: direct market sales feed a
                       province-level foodStock, the government releases stock-
                       pile staples into circulation, households buy against
                       real supply so famine is a supply fact, not a spending
                       one (§6.4).
     runInequality   — Gini + deciles + poverty line/rate/gap from household
                       income distributions (§9 PressureIndex).
     syncDemographics— the actual "revamp": legacy p.demographics scalars are
                       nudged (never overwritten) toward the population-
                       weighted household aggregate (§4.4).
     runMobility     — Students graduate into Working Class; Working Class ages
                       into Retired.
     runMortality    — old age, disease (linked to healthcare) and famine.

   All state lives on the db doc (serverless-safe); money only through
   sim.ledgerTxn / sim.txn. Everything is generic — engine owes no knowledge
   of Arcasia-specific ids beyond the sanctioned entity-type rules. */

const store = require('./store');
const sim = require('./sim');

const clamp01 = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = (n) => Math.round(n * 100) / 100;
const fmtNum = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function cfg(db) {
  return db.settings.households || {};
}
function enabled(db) {
  return !!(db.settings && db.settings.households && db.settings.households.enabled !== false);
}

function provById(db, id) {
  return db.provinces.find(p => p.id === id);
}

// Wages (Phase 1). runEconomy no longer subtracts the wage bill from the
// owner's money-in (that bill was destroyed at the world edge — the leak);
// instead the wage money is REMOVED from the owner's account and deposited
// across every working-age group's households in the property's province,
// weighted by household population. A real balance-reducing debit on the owner
// side means the money is conserved — no double mint. The AVERAGE wage in the
// economy IS whatever the companies pay: runEconomy stores the employee-
// weighted wagePerTurn as globalVars.averageDailyWage/wageIndex each turn, and
// household income here tracks the wages they actually receive (upward only),
// so raising company pay measurably lifts the class statistics it feeds.
function payWages(db, owner, actor, received) {
  const hcfg = cfg(db);
  const working = hcfg.workingGroups || [];
  const props = db.properties.filter(pr => pr.ownerId === owner.id && (pr.employees || 0) > 0);
  if (!props.length) return 0;
  const acct = sim.primaryAccount(owner.id, true);
  if (!acct) return 0;

  // Build a per-property wage bill the same way runEconomy does (property
  // override wins, company policy default fills in, hard default ₳1).
  let total = 0;
  const bills = [];
  for (const pr of props) {
    const wagePerTurn = pr.wagePerTurn !== undefined
      ? Math.max(0, Number(pr.wagePerTurn) || 0)
      : (owner.type === 'company'
        ? Math.max(0, Number(owner.wagePerTurn === undefined ? 1 : owner.wagePerTurn) || 0) : 0);
    const bill = (pr.employees || 0) * wagePerTurn;
    if (!(bill > 0)) continue;
    bills.push({ pr, bill });
    total += bill;
  }
  if (!total) return 0;

  // Cap the transfer at the owner's balance PLUS any that the per-turn
  // expense draw already overran — an employer short on cash simply pays less
  // (the plan's design allows overdraw for engine events; wages are the one
  // place we prefer a soft shortfall so whole businesses don't go deeply
  // negative overnight). allowNegative accounts (government) pay in full.
  const allowNeg = !!(acct.meta && acct.meta.allowNegative);
  let available = allowNeg ? total : Math.min(total, Math.max(0, Math.round(acct.balance * 100) / 100));
  // If we can't cover everything, proportionally scale the whole turn's
  // disbursement rather than stiffing whole provinces. The scale is computed
  // ONCE up front: the old `(available + paid) / total` rose as `paid`
  // accumulated, so late bills were paid at a HIGHER rate than early ones and
  // the total overshot `available` — exactly the deep-negative balances this
  // cap exists to prevent. The company's own wagePerTurn IS the wage — no
  // global multiplier layers on top of it.
  const shareScale = Math.min(1, available / total);
  let paid = 0;

  for (const { pr, bill } of bills) {
    const prov = provById(db, pr.provinceId);
    if (!prov) continue;
    const pool = db.households.filter(h => h.provinceId === pr.provinceId && working.includes(h.group));
    const totalPop = pool.reduce((s, h) => s + (h.population || 0), 0);
    if (!(totalPop > 0)) continue;
    const provShare = bill * shareScale;
    paid += provShare;
    for (const h of pool) {
      const amt = round2(provShare * (h.population || 0) / totalPop);
      if (!(amt > 0)) continue;
      sim.ledgerTxn(acct.id, h.accountId, amt, 'Wages', actor || 'ENGINE', 'deposit');
      if (received) received.set(h.id, (received.get(h.id) || 0) + amt);
    }
  }

  return paid;
}

// Welfare stipends (opt-in, Phase 2f): a government that raises
// settings.households.dependentStipend above 0 buys subsistence AND a
// happiness uplift for the TARGETED demographics (dependentGroups is a
// GM-tunable list). Zero by default — welfare is a budget decision, not an
// engine entitlement. Light, silent (ledgerTxn).
function payStipends(db, actor) {
  const hcfg = cfg(db);
  const stip = Math.max(0, Number(hcfg.dependentStipend) || 0);
  if (!(stip > 0)) return 0;
  const dg = hcfg.dependentGroups || [];
  const gov = db.entities.find(e => e.type === 'government' && e.id === 'ent_gov');
  const treasury = db.accounts.find(a => a.ownerId === gov.id);
  if (!treasury) return 0;
  const happyK = Number(hcfg.stipendHappinessK) || 1.5;
  const upliftTarget = Math.min(100, 50 + 20 * Math.min(1, stip / 60) + happyK);
  let paid = 0;
  for (const h of db.households) {
    if (!dg.includes(h.group)) continue;
    const amt = round2(stip * (h.population || 0) / 1000);
    if (!(amt > 0)) continue;
    sim.ledgerTxn(treasury.id, h.accountId, amt, 'Welfare stipend', actor || 'ENGINE', 'deposit');
    paid += amt;
    if (happyK > 0) {
      h.vars = h.vars || {};
      const h0 = h.vars.happiness === undefined ? 50 : h.vars.happiness;
      h.vars.happiness = round2(clamp01(h0 + (upliftTarget - h0) * 0.05, 0, 100));
    }
  }
  return paid;
}

function runWages(db, actor) {
  if (!enabled(db)) return;
  const g = db.globalVars;
  // Track what each household actually received so income can track the
  // labour market (below).
  const received = new Map();
  let wages = 0;
  for (const owner of db.entities) {
    try { wages += payWages(db, owner, actor, received); } catch (e) { /* one employer must never break the wage pass */ }
  }
  // Household income follows the wages they really get: anchor = realised
  // daily wage ×30 (≈ monthly), blended UPWARD only so a company wage rise
  // measurably lifts class incomes (poverty/Gini/consumption feed from here)
  // without dragging the existing equilibrium down on a wage shortfall.
  const k = clamp01(Number(cfg(db).wageIncomeK) || 0.2, 0, 1);
  if (k > 0) for (const [hid, tot] of received) {
    const h = db.households.find(x => x.id === hid);
    if (!h || !(h.population > 0)) continue;
    const anchor = (tot / h.population) * 30;
    if (anchor > (h.income || 0)) h.income = round2((h.income || 0) + (anchor - (h.income || 0)) * k);
  }
  const stipends = payStipends(db, actor);
  g.lastWageSpend = round2(wages);
  g.lastStipendSpend = round2(stipends);
  if (wages + stipends > 0) {
    store.log('economy', `Daily wages paid: ${fmtNum(wages + stipends)}`,
      `${fmtNum(wages)} wages to workers${stipends ? ` · ${fmtNum(stipends)} welfare stipends` : ''}`, actor || 'ENGINE', []);
  }
}

// Household consumption (Phase 1). Each household earns its (per-capita,
// income/30 ≈ daily) income into its CASH box and spends its expense rate on
// living costs. Food is supply-constrained separately (runFoodSupply); this
// pass covers non-food consumption, keeps the cash box honest, and nudges
// household mood with affordability. Layered ON TOP of the existing abstract
// retail mint — deliberately conservative, per design principle.
function runConsumption(db, actor) {
  if (!enabled(db)) return;
  const econC = db.globalVars.econConfidence === undefined ? 50 : db.globalVars.econConfidence;
  const confF = 0.7 + 0.006 * econC; // mirrors runEconomy's consumer-confidence scaling
  let spentTotal = 0;
  for (const h of db.households) {
    const daily = Math.round(((h.income || 0) / 30) * 100) / 100;
    h.cash = round2((h.cash || 0) + daily);
    // expenses is the monthly non-food spend; daily = /30, scaled by the
    // same confidence factor the retail economy uses so consumer mood and
    // company domestic revenue move together.
    const spend = round2(((h.expenses || 0) / 30) * confF);
    const afford = Math.min(spend, Math.max(0, h.cash || 0));
    h.cash = round2((h.cash || 0) - afford);
    spentTotal += afford;
    if (h.vars.happiness !== undefined) {
      const fed = clamp01(h.foodAccess || 50, 0, 100);
      const target = 45 + fed * 0.35 + (afford >= spend ? 6 : 0);
      h.vars.happiness = round2(clamp01((h.vars.happiness || 50) + (target - (h.vars.happiness || 50)) * 0.05, 0, 100));
    }
  }
  db.globalVars.lastConsumerSpend = round2(spentTotal);
}

// Circulating food stock (Phase 1, §6.4). Simplified flow:
//   1. Domestic-market sales of staple foods feed the NATIONAL POOL
//      (gov.inventory) instead of per-province stock. All food produced
//      domestically concentrates in one place.
//   2. Per-turn consumption: each province drains its own foodStock against
//      real need; famine is a supply fact. Spoilage decays leftovers.
//   Food is released from the national pool to provinces via the explicit
//   /api/food/release endpoint (player-driven, not automatic).
function runFoodSupply(db, actor) {
  if (!enabled(db)) return;
  const hcfg = cfg(db);
  const items = db.items || [];
  const stapleMeta = (itemId) => {
    const it = items.find(i => i.id === itemId);
    return (it && it.meta && it.meta.stapleFood) ? it.meta : null;
  };

  // 1. domestic-market sales feed the national stockpile (gov.inventory)
  const gov = db.entities.find(e => e.id === 'ent_gov') || db.entities.find(e => e.type === 'government');
  if (gov) {
    gov.inventory = gov.inventory || [];
    for (const pr of db.properties) {
      const sales = pr._domesticMarketSalesThisTurn;
      if (!Array.isArray(sales) || !sales.length) continue;
      for (const s of sales) {
        const meta = stapleMeta(s.itemId);
        if (!meta || !(s.qty > 0)) continue;
        // Store raw quantity; calorie weight is applied on release to provinces
        const row = gov.inventory.find(r => r.itemId === s.itemId);
        if (row) row.qty = round2(row.qty + s.qty);
        else gov.inventory.push({ itemId: s.itemId, qty: round2(s.qty) });
      }
    }
  }

  // 2. households consume from their provincial foodStock; famine is a supply
  //    fact. Spoilage decays what's left.
  for (const p of db.provinces) {
    const need = (p.vars.population || 0) * (hcfg.foodReqPerCapPerTurn || 0);
    const stock = p.vars.foodStock || 0;
    const served = Math.min(stock, need);
    p.vars.foodSecurity = need > 0 ? Math.round(100 * served / need) : 100;
    p.vars.foodStock = Math.max(0, round2(stock - served));
    p.vars.foodStock = Math.max(0, round2(p.vars.foodStock * (1 - (hcfg.foodStockDecayRate || 0))));
    if (p.vars.foodSecurity < 30) applyFamineMortality(db, p, actor);
  }
}

// Release food from the national stockpile (gov.inventory) to specific
// provinces. Called by the /api/food/release endpoint. Returns a summary
// object on success or throws on validation error.
function releaseFood(db, itemId, qty, provinceIds, actor) {
  const items = db.items || [];
  const item = items.find(i => i.id === itemId);
  if (!item) throw new Error('Unknown item.');
  const meta = item.meta && item.meta.stapleFood ? item.meta : null;
  if (!meta) throw new Error(item.name + ' is not a staple food.');
  const gov = db.entities.find(e => e.id === 'ent_gov') || db.entities.find(e => e.type === 'government');
  if (!gov) throw new Error('No government entity found.');
  gov.inventory = gov.inventory || [];
  const row = gov.inventory.find(r => r.itemId === itemId);
  const weight = meta.foodCalorieWeight || 1;
  const stockUnits = row ? row.qty : 0;
  const requested = Math.round(Number(qty) || 0);
  if (!(requested > 0)) throw new Error('Quantity must be positive.');
  if (stockUnits < requested) throw new Error('Not enough in national stockpile (' + fmtNum(Math.round(stockUnits)) + ' available).');

  // Resolve target provinces
  const provs = (provinceIds && provinceIds.length)
    ? provinceIds.map(id => db.provinces.find(p => p.id === id)).filter(Boolean)
    : db.provinces.filter(p => (p.vars.population || 0) > 0);
  if (!provs.length) throw new Error('No valid target provinces.');

  // Distribute evenly across targets
  const perProv = round2(requested / provs.length);
  const delivered = {};
  for (const p of provs) {
    p.vars.foodStock = round2((p.vars.foodStock || 0) + perProv * weight);
    delivered[p.id] = perProv;
  }

  // Debit the national stockpile
  row.qty = round2(row.qty - requested);
  if (row.qty <= 0) gov.inventory = gov.inventory.filter(r => r !== row);

  const totalDelivered = round2(perProv * provs.length);
  store.log('simulation', 'Food released to provinces',
    fmtNum(totalDelivered) + ' × ' + item.name + ' → ' + provs.map(p => p.name).join(', '),
    actor || 'ENGINE', ['ent_gov']);
  return { itemId, qty: totalDelivered, weight, provinces: delivered };
}

// Famine thinning — capped, logged, counted in globalVars.famineDeaths.
function applyFamineMortality(db, prov, actor) {
  const hcfg = cfg(db);
  const rate = hcfg.famineMortalityRate || 0.0015;
  const severity = (100 - prov.vars.foodSecurity) / 70; // 30..0 security → 1..~1.43
  const deaths = Math.max(1, Math.round((prov.vars.population || 0) * rate * severity));
  if (!deaths) return;
  slimPopulation(db, prov.id, deaths, 'famine');
  db.globalVars.famineDeaths = (db.globalVars.famineDeaths || 0) + deaths;
  if (!db.globalVars._famineWarnedAt || db.settings.time.turn - db.globalVars._famineWarnedAt > 6) {
    db.globalVars._famineWarnedAt = db.settings.time.turn;
    sim.draftNews(`FOOD CRISIS IN ${(prov.name || prov.id).toUpperCase()}`,
      `Food security in ${prov.name} has collapsed to ${Math.round(prov.vars.foodSecurity)}% — ${fmtNum(deaths)} more deaths this turn. ` +
      `The government's grain and livestock stockpile is the difference between scarcity and catastrophe.`, 'Economy', false, 'State Statistical Bureau');
    store.log('simulation', `Famine strikes ${prov.name}`, `foodSecurity ${Math.round(prov.vars.foodSecurity)}% · ${fmtNum(deaths)} deaths this turn`, actor || 'ENGINE', [prov.id]);
  } else {
    store.log('simulation', `Famine in ${prov.name}`, `${fmtNum(deaths)} deaths this turn`, actor || 'ENGINE', [prov.id]);
  }
}

// Inequality (Phase 2). Gini (population-weighted) on the household income
// distribution per province and nationally; poverty line (globalVars.povertyLine)
// drives povertyRate + povertyGap. Named player-citizens are EXCLUDED from the
// distribution (they're specific people, not aggregates) but their wealth is
// surfaced via globalVars.namedCitizenWealth. A gentle inequality happiness
// drag pulls province happiness toward (1 - gini×2)×50.
// Gini via the classic pairwise absolute-difference formula on the
// population-weighted income distribution:
//   G = Σᵢ Σⱼ wᵢ wⱼ |xᵢ − xⱼ| / (2 N² μ),   μ = Σ wᵢ xᵢ / N
// Exact for these few weighted rows and robust to the ±1 rounding drift that
// mobility/mortality rescaling leaves on household populations.
function computeGini(rows) {
  const filtered = rows.filter(r => (r.population || 0) > 0 && Number.isFinite(r.income || 0));
  const N = filtered.reduce((s, r) => s + r.population, 0);
  if (N <= 1) return 0;
  let weightedSum = 0, pairSum = 0;
  for (const a of filtered) {
    const wa = a.population;
    const xa = a.income || 0;
    weightedSum += wa * xa;
    for (const b of filtered) pairSum += wa * b.population * Math.abs(xa - (b.income || 0));
  }
  const mu = weightedSum / N;
  if (!(mu > 0)) return 0;
  return round2(Math.max(0, Math.min(1, pairSum / (2 * N * N * mu))));
}

function runInequality(db, actor) {
  if (!enabled(db)) return;
  const povertyLine = Number(db.globalVars.povertyLine) || 400;
  const excluded = new Set(db.entities.filter(e => e.meta && e.meta.excludeFromHouseholds).map(e => e.id));
  const hhRows = (provinceId) => db.households.filter(h => h.provinceId === provinceId);

  let natRows = [];
  let natPoor = 0, natPoorGap = 0;
  for (const p of db.provinces) {
    const rows = hhRows(p.id)
      .map(h => ({ income: h.income || 0, population: h.population || 0 }))
      .filter(r => r.population > 0);
    p.vars = p.vars || {};
    p.vars.giniIndex = computeGini(rows);
    const totalPop = rows.reduce((s, r) => s + r.population, 0) || 1;
    const poor = rows.filter(r => r.income < povertyLine);
    p.vars.povertyRate = Math.round(100 * poor.reduce((s, r) => s + r.population, 0) / totalPop * 100) / 100;
    const gap = poor.reduce((s, r) => s + r.population * Math.max(0, povertyLine - r.income) / povertyLine, 0);
    p.vars.povertyGap = Math.round(100 * gap / totalPop * 100) / 100;
    // Inequality happiness drag: pull toward (1 - gini×2)×50, gently
    if (p.vars.happiness !== undefined && p.vars.giniIndex !== undefined) {
      const target = Math.max(20, Math.min(80, (1 - p.vars.giniIndex * 2) * 50));
      p.vars.happiness = Math.round(clamp01((p.vars.happiness || 50) + (target - (p.vars.happiness || 50)) * 0.01, 0, 100) * 10) / 10;
    }
    natRows = natRows.concat(rows);
  }

  db.globalVars = db.globalVars || {};
  db.globalVars.giniNational = computeGini(natRows);
  const natPop = natRows.reduce((s, r) => s + r.population, 0) || 1;
  const natPoor2 = natRows.filter(r => r.income < povertyLine);
  db.globalVars.povertyRateNational = Math.round(100 * natPoor2.reduce((s, r) => s + r.population, 0) / natPop * 100) / 100;
  db.globalVars.totalHouseholds = db.households.length;
  db.globalVars.welfareSpending = db.globalVars.welfareSpending || 0;
  db.globalVars.pitRevenue = db.globalVars.pitRevenue || 0;
  // Named-citizen wealth — the richest, most legible people of the game must
  // stay visible to statistics, just excluded from the anonymous distribution.
  db.globalVars.namedCitizenWealth = round2(db.accounts
    .filter(a => excluded.has(a.ownerId))
    .reduce((s, a) => s + (a.balance || 0), 0));
}

// The demographics revamp (§4.4): the legacy p.demographics scalars are a real
// mirror now, not an independent drift. Four household-linked metrics are
// NUDGED (never overwritten — a GM's adjust_demo corrections keep their bite)
// toward the population-weighted household aggregate each month boundary.
function syncDemographics(db, actor) {
  if (!enabled(db)) return;
  const k = clamp01(Number(cfg(db).demoSyncStrength) || 0.5, 0, 1);
  if (!(k > 0)) return;
  const map = {
    income: (h) => h.income || 0,
    happiness: (h) => (h.vars && h.vars.happiness) || 0,
    governmentSupport: (h) => (h.vars && h.vars.governmentSupport) || 0,
    economicConfidence: (h) => (h.vars && h.vars.economicConfidence) || 0
  };
  for (const p of db.provinces) {
    if (!p.demographics) continue;
    for (const gname in p.demographics) {
      const homes = db.households.filter(h => h.provinceId === p.id && h.group === gname && (h.population || 0) > 0);
      const totalPop = homes.reduce((s, h) => s + h.population, 0);
      if (!(totalPop > 0)) continue;
      const g = p.demographics[gname];
      for (const metric in map) {
        if (g[metric] === undefined) continue;
        const target = homes.reduce((s, h) => s + map[metric](h) * h.population, 0) / totalPop;
        let next = g[metric] + (target - g[metric]) * k;
        if (metric === 'income') next = Math.max(40, next);
        else next = Math.min(100, Math.max(0, next));
        g[metric] = Math.round(next * 100) / 100;
      }
    }
  }
}

// Class mobility (Phase 3): Students graduate into Working Class, Working
// Class ages into Retired, at GM-tunable ANNUAL rates converted to monthly.
// Migration between provinces is out of scope (the seed's Rural/Urban split
// already moves via runDemographics). Group populations stay population-
// conserving; each group's household quintiles rescale proportionally.
// Move a cohort between two demographic groups (start → end of the class
// ladder). The sender's EDUCATION scales its annual advancement rate
// (0.5 + education/100 × educationMobilityK), so schooling genuinely buys
// social mobility. Annual rate ÷ 12 = monthly, clamped hard at 50%. Target
// groups (Students/Retired/… anyone) are generic strings — the engine never
// assumes class names.
function ladderMove(db, p, fromName, toName, annualRate, edK) {
  const from = p.demographics && p.demographics[fromName];
  const to = p.demographics && p.demographics[toName];
  if (!from || !to || !(from.population > 0) || !(annualRate > 0)) return 0;
  const rate = Math.min(0.5, annualRate * (0.5 + ((from.education || 50) / 100) * edK) / 12);
  const moving = Math.max(0, Math.round(from.population * rate));
  if (!(moving > 0)) return 0;
  from.population -= moving;
  to.population += moving;
  return moving;
}

function runMobility(db, actor) {
  if (!enabled(db)) return;
  const hcfg = cfg(db);
  const edK = Number(hcfg.educationMobilityK) || 1.5;
  const annual = (v, def) => Number(v === undefined ? def : v) || 0;
  const gA = annual(hcfg.studentGraduationRate, 0.10);
  const rA = annual(hcfg.retirementRate, 0.04);
  const wA = annual(hcfg.wcToMcRate, 0.05);   // career ladder: Working → Middle
  const uA = annual(hcfg.mcToUcRate, 0.02);   // career ladder: Middle → Upper
  let moved = 0;
  const touched = new Set(['Students', 'Working Class', 'Retired', 'Middle Class', 'Upper Class']);
  for (const p of db.provinces) {
    if (!p.demographics) continue;
    moved += ladderMove(db, p, 'Students', 'Working Class', gA, edK);
    moved += ladderMove(db, p, 'Working Class', 'Retired', rA, edK);
    moved += ladderMove(db, p, 'Working Class', 'Middle Class', wA, edK);
    moved += ladderMove(db, p, 'Middle Class', 'Upper Class', uA, edK);
    if (moved) {
      p.vars.population = Object.values(p.demographics).reduce((s, g) => s + (g.population || 0), 0);
      for (const gname of touched) rescaleGroupHouseholds(db, p, gname);
    }
  }
  db.globalVars.population = db.provinces.reduce((s, p) => s + (p.vars.population || 0), 0);
  if (moved > 0) {
    store.log('simulation', 'Class mobility this month',
      `${fmtNum(moved)} citizens changed class this month — students graduating, workers retiring, and the career ladder in motion`, actor || 'ENGINE', []);
  }
}

// Mortality (Phase 3): old age (Retired cohort), disease (scaled by
// 100 - province healthcare), plus famine which runFoodSupply already applied
// turn-by-turn. Updates province health vars and the life-expectancy proxy.
// The THINNING only happens monthly (monthBoundary gates the call) — health
// DESCRIPTOR stats (lifeExpectancy/infantMortality) refresh every turn via
// refreshHealthStats so dashboards always show live numbers.
function runMortality(db, actor) {
  if (!enabled(db)) return;
  const hcfg = cfg(db);
  const oldRate = clamp01(Number(hcfg.oldAgeMortalityRate) || 0.012, 0, 0.2);
  const disK = clamp01(Number(hcfg.diseaseMortalityK) || 0.0004, 0, 0.01);
  let deaths = 0;
  for (const p of db.provinces) {
    if (!p.demographics) continue;
    const healthcare = p.vars.healthcare !== undefined ? Number(p.vars.healthcare) : 50;
    const diseaseRate = disK * Math.max(0, 100 - healthcare) / 50; // 0 at 100 healthcare
    let provDeaths = 0;
    for (const gname in p.demographics) {
      const g = p.demographics[gname];
      if (!g || !(g.population > 0)) continue;
      let rate = 0;
      if (gname === 'Retired') rate += oldRate;
      rate += diseaseRate;
      if (!(rate > 0)) continue;
      const d = Math.max(0, Math.min(g.population, Math.round(g.population * rate)));
      if (d > 0) { g.population -= d; provDeaths += d; }
    }
    if (provDeaths > 0) {
      p.vars.population = Object.values(p.demographics).reduce((s, g) => s + (g.population || 0), 0);
      p.vars.mortalityRate = Math.round(provDeaths / (p.vars.population || 1) * 1000 * 100) / 100; // deaths per 1000
      rescaleAllHouseholds(db, p);
    }
    deaths += provDeaths;
  }
  db.globalVars.population = db.provinces.reduce((s, p) => s + (p.vars.population || 0), 0);
  if (deaths > 0) {
    db.globalVars.lastMortalityDeaths = deaths;
  }
  refreshHealthStats(db);
}

// Health DESCRIPTOR stats, refreshed every turn (cheap, healthcare-driven):
// life expectancy and infant mortality are the population's vital-signs proxy.
// mortalityRate normally comes from the monthly thinning pass (observed deaths
// per 1000); before the first month end — or in a month nobody died — it falls
// back to the EXPECTED annual rate from the same old-age/disease formula, so
// dashboards always read a real number instead of a dash.
function refreshHealthStats(db) {
  const hcfg = cfg(db);
  const oldRate = clamp01(Number(hcfg.oldAgeMortalityRate) || 0.012, 0, 0.2);
  const disK = clamp01(Number(hcfg.diseaseMortalityK) || 0.0004, 0, 0.01);
  for (const p of db.provinces) {
    if (!p.vars) continue;
    const healthcare = p.vars.healthcare !== undefined ? Number(p.vars.healthcare) : 50;
    if (p.vars.mortalityRate === undefined) {
      const dis = disK * Math.max(0, 100 - healthcare) / 50;
      let expected = 0;
      const total = Object.values(p.demographics || {}).reduce((s, g) => s + (g.population || 0), 0) || 1;
      for (const gname in (p.demographics || {})) {
        const g = p.demographics[gname];
        if (!g || !(g.population > 0)) continue;
        const rate = (gname === 'Retired' ? oldRate : 0) + dis;
        expected += rate * (g.population || 0) / total;
      }
      p.vars.mortalityRate = Math.round(expected * 12 * 1000 * 100) / 100; // per 1000 / year
    }
    p.vars.lifeExpectancy = Math.round(clamp01(60 + (healthcare - 40) * 0.3 - (p.vars.mortalityRate || 0) * 0.02, 35, 95));
    p.vars.infantMortality = Math.round(clamp01(45 - (healthcare - 40) * 0.6, 5, 80));
  }
}

// Rescue group households to match a group's (new) population while preserving
// each household's quintile weight within the group.
function rescaleGroupHouseholds(db, prov, group) {
  const groupPop = (prov.demographics && prov.demographics[group] && prov.demographics[group].population) || 0;
  const homes = db.households.filter(h => h.provinceId === prov.id && h.group === group);
  const sum = homes.reduce((s, h) => s + (h.population || 0), 0);
  if (!homes.length || !(sum > 0)) return;
  const scale = groupPop / sum;
  homes.forEach(h => { h.population = Math.max(1, Math.round((h.population || 0) * scale)); });
  // rebalance rounding drift so the group's households sum exactly to groupPop
  let cur = homes.reduce((s, h) => s + h.population, 0);
  let i = 0;
  while (cur !== groupPop) {
    if (cur < groupPop) { homes[i % homes.length].population += 1; cur += 1; }
    else if (homes[i % homes.length].population > 1) { homes[i % homes.length].population -= 1; cur -= 1; }
    else { i++; if (i > homes.length * 4) break; }
    i++;
    if (i > homes.length * 20) break;
  }
}

function rescaleAllHouseholds(db, prov) {
  for (const gname in (prov.demographics || {})) rescaleGroupHouseholds(db, prov, gname);
}

// Remove `deaths` people from a province's demographic groups PROPORTIONALLY
// (famine is no respecter of class — it thins the populous majority working
// classes hardest, exactly as the news copy claims), largest-remainder rounding
// so the true total leaves, then rebalance the household quintiles.
function slimPopulation(db, provinceId, deaths, cause) {
  const prov = provById(db, provinceId);
  if (!prov || !(deaths > 0)) return 0;
  const active = Object.entries(prov.demographics || {}).filter(([, g]) => (g.population || 0) > 0);
  const total = active.reduce((s, [, g]) => s + g.population, 0);
  if (!(total > 0)) return 0;
  // base allocation (floor), then largest-remainder top-ups for the fraction
  let allocated = 0;
  const alloc = active.map(([name, g]) => {
    const exact = g.population * deaths / total;
    const base = Math.floor(exact);
    allocated += base;
    return { name, g, base, frac: exact - base };
  });
  const byRemainder = alloc.slice().sort((a, b) => b.frac - a.frac);
  let i = 0;
  while (allocated < deaths) { byRemainder[i % byRemainder.length].base += 1; allocated++; i++; }
  for (const { name, g, base } of alloc) {
    const take = Math.min(g.population, base);
    g.population = Math.max(0, Math.round(g.population - take));
  }
  prov.vars.population = Object.values(prov.demographics || {}).reduce((s, g) => s + (g.population || 0), 0);
  rescaleAllHouseholds(db, prov);
  return allocated;
}

// ---------- visibility helpers (used by sim effects / GM tooling) ----------

// Population-weighted average of a metric across a province (or its group).
function weightedAvg(db, provinceId, group, metricPicker) {
  const homes = db.households.filter(h => h.provinceId === provinceId && (!group || h.group === group) && (h.population || 0) > 0);
  const totalPop = homes.reduce((s, h) => s + h.population, 0);
  if (!(totalPop > 0)) return 0;
  return homes.reduce((s, h) => s + metricPicker(h) * h.population, 0) / totalPop;
}

module.exports = {
  runWages, payWages, runConsumption, runFoodSupply, releaseFood,
  runInequality, syncDemographics, runMobility, runMortality, refreshHealthStats,
  weightedAvg, slimPopulation, computeGini, enabled
};