// ============================================================
// GOVERNMENT ACTIONS — Population tab
// Welfare stimulus, food release into national supply, rationing,
// pensions, public works, tax rebates, bank recapitalisation.
// Treasury/inventory adapters match live entity naming
// ("Government of Arcasia", "Bank of Arcasia") and emit wire-service
// transfer news in the live template. Every action:
// validate -> pay -> mutate. No free effects on failed payment.
// ============================================================

const { clamp } = require('../demographics/groups');
const { computeTargetMatch } = require('../election/preferences');
const { recomputeProvinceFoodAccess } = require('../events/census');
const { pushNews, wireTransfer, fmtMoney, resolveItemName } = require('../news/wire');

const GOV_LABEL = 'Government of Arcasia';

const GOV_ACTIONS = {
  welfare_stimulus: {
    id: 'welfare_stimulus', name: 'Welfare Stimulus',
    description: 'Direct cash payments to low-income households. Strongest on the working class.',
    durationMinutes: 10, cooldownTurns: 1, maxPerTurn: 2,
    fixedCost: 250000, costPerCapita: 25, stipendPerCapita: 20,
    targeting: { class: ['working_class', 'middle_class'], quintile: [1, 2, 3] },
    effects: { happiness: 6, governmentSupport: 7, economicConfidence: 2 },
    newsRecipient: 'The Arcasian People', newsPurpose: 'Welfare stimulus payments'
  },
  pension_boost: {
    id: 'pension_boost', name: 'Pension Increase',
    description: 'Raise state pensions for retired households.',
    durationMinutes: 10, cooldownTurns: 1, maxPerTurn: 1,
    fixedCost: 500000, costPerCapita: 30,
    targeting: { lifecycle: ['retired'] },
    effects: { happiness: 8, governmentSupport: 9, economicConfidence: 1 },
    newsRecipient: 'State Pension Fund', newsPurpose: 'Pension payments'
  },
  food_release: {
    id: 'food_release', name: 'Release Food into National Supply',
    description: 'Move grain from the national stockpile into provincial food supply. Modes: shortfall (default, worst-fed first), equal, or explicit provinceIds.',
    durationMinutes: 15, cooldownTurns: 0, maxPerTurn: 5,
    item: 'item_grain', minQty: 100
  },
  public_works: {
    id: 'public_works', name: 'Public Works Program',
    description: 'Government jobs for the urban working class.',
    durationMinutes: 30, cooldownTurns: 1, maxPerTurn: 1,
    fixedCost: 1000000, costPerCapita: 15,
    targeting: { class: ['working_class'], lifecycle: ['working_age'], location: ['urban'] },
    effects: { happiness: 4, governmentSupport: 5, employment: 6 },
    newsRecipient: 'Public Works Programme', newsPurpose: 'Public works employment'
  },
  tax_rebate: {
    id: 'tax_rebate', name: 'Tax Rebate',
    description: 'One-off rebate that mainly reassures the middle and upper class.',
    durationMinutes: 5, cooldownTurns: 2, maxPerTurn: 1,
    fixedCost: 0, costPerCapita: 60,
    targeting: { class: ['middle_class', 'upper_class'] },
    effects: { happiness: 2, governmentSupport: 4, economicConfidence: 8 },
    newsRecipient: 'Arcasian Taxpayers', newsPurpose: 'Tax rebate'
  },
  bank_recapitalize: {
    id: 'bank_recapitalize', name: 'Bank Recapitalisation',
    description: 'Emergency transfer to the Bank of Arcasia to restore its reserve. Observed live: ₳200,000,000, purpose "To ensure that the Bank of Arcasia still has reserves."',
    durationMinutes: 10, cooldownTurns: 1, maxPerTurn: 1,
    minAmount: 1000000, confidenceBoost: 5
  }
};

// ---------- resource adapters (the ONLY places touching money/items) ----------

function findNamedEntity(worldState, needles) {
  return (worldState.entities || []).find(e => {
    const hay = `${e.id || ''} ${e.displayName || ''} ${e.name || ''}`.toLowerCase();
    return needles.some(n => hay.includes(n));
  }) || null;
}
const findGovernmentEntity = ws => findNamedEntity(ws, ['government of arcasia', 'ent_government', 'ent_gov']);
const findBankEntity = ws => findNamedEntity(ws, ['bank of arcasia', 'ent_bank']);

function balanceAccess(entity) {
  if (!entity) return null;
  const v = entity.vars || {};
  for (const key of ['money', 'balance', 'funds', 'treasury']) {
    if (typeof v[key] === 'number') {
      return { get: () => v[key], set: x => { v[key] = x; } };
    }
  }
  if (typeof entity.money === 'number') {
    return { get: () => entity.money, set: x => { entity.money = x; } };
  }
  return null;
}

function spendMoney(worldState, amount, purpose, recipient) {
  if (amount <= 0) return { ok: true };
  const gv = (worldState.globalVars = worldState.globalVars || {});
  const acc = balanceAccess(findGovernmentEntity(worldState)) ||
    (typeof gv.treasury === 'number'
      ? { get: () => gv.treasury, set: x => { gv.treasury = x; } }
      : null);
  if (!acc) {
    return { ok: true, warning: 'No government treasury found — cost not deducted. Wire spendMoney() in src/government/actions.js.' };
  }
  if (acc.get() < amount) return { ok: false, have: acc.get() };
  acc.set(acc.get() - amount);
  if (recipient) wireTransfer(worldState, GOV_LABEL, recipient, amount, purpose || 'Government programme.');
  return { ok: true };
}

function countItem(worldState, itemId) {
  const gov = findGovernmentEntity(worldState);
  const inv = (gov && (gov.vars?.inventory || gov.inventory)) || null;
  if (inv && typeof inv[itemId] === 'number') return inv[itemId];
  const gv = worldState.globalVars || {};
  return (gv.nationalStock && gv.nationalStock[itemId]) ||
         (gv.stockpile && gv.stockpile[itemId]) || 0;
}

function spendItem(worldState, itemId, qty) {
  const gov = findGovernmentEntity(worldState);
  const inv = (gov && (gov.vars?.inventory || gov.inventory)) || null;
  if (inv && typeof inv[itemId] === 'number') {
    if (inv[itemId] < qty) return { ok: false, have: inv[itemId] };
    inv[itemId] -= qty;
    return { ok: true };
  }
  const gv = (worldState.globalVars = worldState.globalVars || {});
  gv.nationalStock = gv.nationalStock || {};
  if ((gv.nationalStock[itemId] || 0) < qty) {
    return { ok: false, have: gv.nationalStock[itemId] || 0 };
  }
  gv.nationalStock[itemId] -= qty;
  return { ok: true };
}

// ---------- state / bookkeeping ----------

function ensureGovState(worldState) {
  worldState._government = worldState._government || {};
  worldState._government.usesThisTurn = worldState._government.usesThisTurn || {};
  worldState._government.lastUsedTurn = worldState._government.lastUsedTurn || {};
  return worldState._government;
}

function resetGovernmentTurnState(worldState) {
  if (worldState?._government) worldState._government.usesThisTurn = {};
}

function logAction(worldState, def, params, result, actor) {
  const gv = (worldState.globalVars = worldState.globalVars || {});
  if (!Array.isArray(gv.governmentLog)) gv.governmentLog = [];
  gv.governmentLog.push({
    ts: Date.now(), date: worldState.date, turn: worldState.turn || 0,
    actor: (actor && actor.displayName) || GOV_LABEL,
    actionId: def.id, actionName: def.name,
    params: { ...params },
    message: result.message || '',
    cost: result.cost || 0
  });
  if (gv.governmentLog.length > 200) gv.governmentLog.splice(0, gv.governmentLog.length - 200);
}

const fmt = n => Number(n || 0).toLocaleString('en-US');

// ---------- main entry ----------

function executeGovernmentAction(worldState, actionId, params = {}, actor = null) {
  const def = GOV_ACTIONS[actionId];
  if (!def) return { success: false, error: `Unknown government action: ${actionId}` };

  const gov = ensureGovState(worldState);
  const turn = worldState.turn || 0;

  const last = gov.lastUsedTurn[actionId];
  if (def.cooldownTurns > 0 && last !== undefined && turn - last < def.cooldownTurns) {
    const remaining = def.cooldownTurns - (turn - last);
    return { success: false, error: `${def.name} is on cooldown for ${remaining} more turn(s).` };
  }
  if ((gov.usesThisTurn[actionId] || 0) >= def.maxPerTurn) {
    return { success: false, error: `${def.name} has already been used ${def.maxPerTurn} time(s) this turn.` };
  }

  const result =
    def.id === 'food_release'    ? runFoodRelease(worldState, def, params) :
    def.id === 'bank_recapitalize' ? runBankRecapitalize(worldState, def, params) :
    runTargetedStimulus(worldState, def, params);

  if (!result.success) return result;

  gov.usesThisTurn[actionId] = (gov.usesThisTurn[actionId] || 0) + 1;
  gov.lastUsedTurn[actionId] = turn;
  logAction(worldState, def, params, result, actor);
  return result;
}

// ---------- money-based stimulus ----------

function runTargetedStimulus(worldState, def, params) {
  const targeting = { ...def.targeting, ...(params.targeting || {}) };
  const scope = params.provinceId
    ? (worldState.households || []).filter(hh => hh.provinceId === params.provinceId)
    : (worldState.households || []);

  const targets = [];
  let coveredPop = 0;
  for (const hh of scope) {
    if ((hh.population || 0) <= 0) continue;
    if (computeTargetMatch(hh.axes, targeting) <= 0) continue;
    targets.push(hh);
    coveredPop += hh.population;
  }
  if (!targets.length) {
    return { success: false, error: 'No households match the targeting criteria.' };
  }

  const cost = (def.fixedCost || 0) + Math.ceil(coveredPop * (def.costPerCapita || 0));
  const payment = spendMoney(worldState, cost, def.newsPurpose, def.newsRecipient); // pay BEFORE mutating
  if (!payment.ok) {
    return { success: false, error: `Insufficient funds: need ${fmtMoney(cost)}, treasury holds ${fmtMoney(payment.have)}.` };
  }

  let stipendTotal = 0;
  let touchedEmployment = false;
  for (const hh of targets) {
    const sens = hh.sensitivity?.materialBenefit ?? 0.5;
    if (def.effects.happiness) hh.happiness = clamp((hh.happiness ?? 50) + def.effects.happiness * sens, 0, 100);
    if (def.effects.governmentSupport) hh.governmentSupport = clamp((hh.governmentSupport ?? 50) + def.effects.governmentSupport * sens, 0, 100);
    if (def.effects.economicConfidence) hh.economicConfidence = clamp((hh.economicConfidence ?? 50) + def.effects.economicConfidence * sens, 0, 100);
    if (def.effects.employment) {
      if (typeof hh.employment === 'number') {
        hh.employment = clamp(hh.employment + def.effects.employment * sens, 0, 100);
      }
      touchedEmployment = true;
    }
    if (def.stipendPerCapita) {
      // Wire hh.stipendPending into your household account ledger on the
      // next payout tick, then zero it.
      hh.stipendPending = (hh.stipendPending || 0) + def.stipendPerCapita * hh.population;
      stipendTotal += def.stipendPerCapita * hh.population;
    }
  }

  // Public works also nudges the province-level employment stat if tracked.
  if (touchedEmployment && params.provinceId) {
    const province = (worldState.provinces || []).find(p => p.id === params.provinceId);
    if (province && typeof province.vars?.employment === 'number') {
      province.vars.employment = clamp(province.vars.employment + def.effects.employment * 0.5, 0, 100);
    }
  }

  return {
    success: true, actionId: def.id, name: def.name, cost,
    coveredHouseholds: targets.length, coveredPopulation: coveredPop,
    stipendPaid: stipendTotal, warning: payment.warning,
    message: `${def.name}: ${fmt(coveredPop)} citizens covered (cost ${fmtMoney(cost)}).`
  };
}

// ---------- food release into national supply ----------

function averageFoodAccess(worldState, provinceId) {
  let sum = 0, pop = 0;
  for (const hh of worldState.households || []) {
    if (hh.provinceId !== provinceId || (hh.population || 0) <= 0) continue;
    sum += (hh.foodAccess ?? 90) * hh.population;
    pop += hh.population;
  }
  return pop > 0 ? sum / pop : 100;
}

function splitEvenly(provinces, qty) {
  const out = [];
  const base = Math.floor(qty / provinces.length);
  let rem = qty - base * provinces.length;
  for (const p of provinces) out.push([p, base + (rem-- > 0 ? 1 : 0)]);
  return out;
}

function runFoodRelease(worldState, def, params) {
  const itemId = params.itemId || def.item;
  const qty = Math.floor(Number(params.qty) || 0);
  if (qty < def.minQty) {
    return { success: false, error: `Minimum release quantity is ${def.minQty} ${itemId}.` };
  }

  let provinces = worldState.provinces || [];
  if (params.provinceIds?.length) {
    const wanted = new Set(params.provinceIds);
    provinces = provinces.filter(p => wanted.has(p.id));
  }
  if (!provinces.length) {
    return { success: false, error: 'No valid provinces to distribute to.' };
  }

  const payment = spendItem(worldState, itemId, qty);
  if (!payment.ok) {
    const hint = (payment.have ?? 0) === 0
      ? ' If your national stockpile lives elsewhere, wire countItem()/spendItem() in src/government/actions.js.'
      : '';
    return { success: false, error: `Insufficient national stock of ${itemId}: have ${fmt(payment.have ?? 0)}, need ${fmt(qty)}.${hint}` };
  }

  const mode = params.mode || (params.provinceIds?.length ? 'province' : 'shortfall');
  const accessByProvince = new Map(provinces.map(p => [p.id, averageFoodAccess(worldState, p.id)]));

  let allocations;
  if (mode === 'equal') {
    allocations = splitEvenly(provinces, qty);
  } else {
    // 'shortfall' (default): send food where access is worst.
    const weights = provinces.map(p => Math.max(0, 60 - (accessByProvince.get(p.id) ?? 100)));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    if (totalWeight <= 0) {
      allocations = splitEvenly(provinces, qty); // nobody in deficit
    } else {
      allocations = [];
      let allocated = 0;
      provinces.forEach((p, i) => {
        const share = Math.floor((qty * weights[i]) / totalWeight);
        allocations.push([p, share]);
        allocated += share;
      });
      const remainder = qty - allocated;
      if (remainder > 0 && allocations.length) {
        let worst = allocations[0];
        for (const a of allocations) {
          if ((accessByProvince.get(a[0].id) ?? 100) < (accessByProvince.get(worst[0].id) ?? 100)) worst = a;
        }
        worst[1] += remainder;
      }
    }
  }

  const perProvince = {};
  for (const [province, share] of allocations) {
    if (share <= 0) continue;
    province.vars = province.vars || {};
    province.vars.foodStock = (province.vars.foodStock || 0) + share;
    recomputeProvinceFoodAccess(worldState, province.id); // instant feedback
    perProvince[province.id] = share;
  }

  const gv = (worldState.globalVars = worldState.globalVars || {});
  gv.foodReleasedTotal = (gv.foodReleasedTotal || 0) + qty;

  if (!params.silent) {
    pushNews(worldState, {
      author: 'State Statistical Bureau', paperId: 'paper_today', category: 'Government',
      headline: 'GOVERNMENT RELEASES FOOD INTO NATIONAL SUPPLY',
      body: `The Government of Arcasia has released ${fmt(qty)} ${resolveItemName(worldState, itemId)} from the national stockpile into the provincial food supply (${mode} distribution).`
    });
  }

  return {
    success: true, actionId: def.id, name: def.name,
    item: itemId, qty, mode, perProvince, warning: payment.warning,
    message: `Released ${fmt(qty)} ${itemId} into the national supply (${mode}).`
  };
}

// ---------- bank recapitalisation (observed live, turn 5) ----------

function runBankRecapitalize(worldState, def, params) {
  const amount = Math.floor(Number(params.amount) || 0);
  if (amount < def.minAmount) {
    return { success: false, error: `Minimum recapitalisation is ${fmtMoney(def.minAmount)}.` };
  }
  const payment = spendMoney(
    worldState, amount,
    'To ensure that the Bank of Arcasia still has reserves.', // live-verbatim purpose
    'Bank of Arcasia'
  );
  if (!payment.ok) {
    return { success: false, error: `Insufficient funds: need ${fmtMoney(amount)}, treasury holds ${fmtMoney(payment.have)}.` };
  }

  const bank = findBankEntity(worldState);
  const gv = (worldState.globalVars = worldState.globalVars || {});
  let credited = false;
  if (bank) {
    bank.vars = bank.vars || {};
    for (const key of ['reserve', 'reserves', 'balance', 'money']) {
      if (typeof bank.vars[key] === 'number') { bank.vars[key] += amount; credited = true; break; }
    }
  }
  if (!credited) {
    const base = typeof gv.bankReserve === 'number'
      ? gv.bankReserve
      : (bank?.vars?.reserve ?? 0);
    gv.bankReserve = base + amount;
  }

  if (typeof gv.marketConfidence === 'number') {
    gv.marketConfidence = clamp(gv.marketConfidence + def.confidenceBoost, 0, 100);
  }
  for (const hh of worldState.households || []) {
    if ((hh.population || 0) > 0) {
      hh.economicConfidence = clamp((hh.economicConfidence ?? 50) + 2, 0, 100);
    }
  }

  if (!params.silent) {
    pushNews(worldState, {
      author: 'State Statistical Bureau', paperId: 'paper_economists', category: 'Economy',
      headline: 'Bank of Arcasia recapitalised by the Government',
      body: `The Government of Arcasia has moved ${fmtMoney(amount)} to the Bank of Arcasia. Ministers moved to reassure markets that the emergency has passed.`
    });
  }

  return {
    success: true, actionId: def.id, name: def.name, cost: amount,
    warning: payment.warning,
    message: `Recapitalised the Bank of Arcasia with ${fmtMoney(amount)}.`
  };
}

// ---------- rationing toggle ----------

function setRationing(worldState, provinceId, enabled) {
  const province = (worldState.provinces || []).find(p => p.id === provinceId);
  if (!province) return { success: false, error: `Unknown province: ${provinceId}` };
  province.vars = province.vars || {};
  province.vars.rationing = !!enabled;
  const access = recomputeProvinceFoodAccess(worldState, provinceId);

  if (enabled) {
    // Rationing guarantees a floor but annoys the well-off.
    for (const hh of worldState.households || []) {
      if (hh.provinceId !== provinceId || (hh.population || 0) <= 0) continue;
      if ((hh.axes?.quintile || 0) >= 4) {
        hh.happiness = clamp((hh.happiness ?? 50) - 4, 0, 100);
      }
    }
  }
  const gv = (worldState.globalVars = worldState.globalVars || {});
  gv.rationingProvinces = (worldState.provinces || []).filter(p => p.vars?.rationing).map(p => p.id);
  logAction(worldState,
    { id: 'rationing', name: enabled ? 'Rationing Enabled' : 'Rationing Lifted' },
    { provinceId }, { success: true, message: '' }, null);

  return {
    success: true, provinceId, rationing: !!enabled, foodAccess: access,
    message: `Rationing ${enabled ? 'imposed on' : 'lifted in'} ${provinceId}.`
  };
}

// ---------- UI preview API ----------

function estimateGovernmentActionCost(worldState, actionId, params = {}) {
  const def = GOV_ACTIONS[actionId];
  if (!def) return null;
  if (def.id === 'food_release') {
    return { money: 0, items: [{ itemId: params.itemId || def.item, qty: Math.floor(Number(params.qty) || 0) }] };
  }
  if (def.id === 'bank_recapitalize') {
    return { money: Math.floor(Number(params.amount) || 0), items: [] };
  }
  const targeting = { ...def.targeting, ...(params.targeting || {}) };
  const scope = params.provinceId
    ? (worldState.households || []).filter(hh => hh.provinceId === params.provinceId)
    : (worldState.households || []);
  let coveredPop = 0;
  for (const hh of scope) {
    if ((hh.population || 0) <= 0) continue;
    if (computeTargetMatch(hh.axes, targeting) <= 0) continue;
    coveredPop += hh.population;
  }
  return {
    money: (def.fixedCost || 0) + Math.ceil(coveredPop * (def.costPerCapita || 0)),
    coveredPopulation: coveredPop,
    items: []
  };
}

module.exports = {
  GOV_ACTIONS,
  executeGovernmentAction,
  setRationing,
  estimateGovernmentActionCost,
  resetGovernmentTurnState
};

