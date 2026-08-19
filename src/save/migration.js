const { generateProfiles } = require('../demographics/groups');
const { configureFatigue } = require('../election/fatigue');

const MIGRATION_ID = 'demographics_matrix_v2';

function needsMigration(save) {
  return !save?._migrations?.includes(MIGRATION_ID);
}

function migrate(save) {
  console.log(`[MIGRATION] Applying ${MIGRATION_ID}...`);
  const oldHouseholds = Array.isArray(save.households) ? save.households : [];

  // FIX (critical): the original migration compared new composite labels
  // ("Urban Working Class") against legacy flat groups — never matched —
  // and read legacy?.vars?.happiness though legacy stats are top-level.
  // Result: everything silently reset to 50 and account balances were
  // dropped. We now seed from keyword matches with population-weighted
  // province averages as fallback.
  const legacy = {};
  for (const hh of oldHouseholds) {
    if (!hh?.provinceId) continue;
    const a = (legacy[hh.provinceId] ||= { pop: 0, happiness: 0, support: 0, confidence: 0, food: 0, income: 0 });
    const w = hh.population || 0;
    a.pop += w;
    a.happiness += pickNum(hh.happiness, hh.vars?.happiness, 50) * w;
    a.support += pickNum(hh.governmentSupport, hh.vars?.governmentSupport, 50) * w;
    a.confidence += pickNum(hh.economicConfidence, hh.vars?.economicConfidence, 50) * w;
    a.food += pickNum(hh.foodAccess, hh.vars?.foodAccess, 90) * w;
    a.income += pickNum(hh.income, 0) * w;
  }

  const newHouseholds = [];
  for (const province of save.provinces || []) {
    const stats = legacy[province.id];
    const census = {
      totalPopulation: stats?.pop || province.vars?.population || 100000,
      urbanization: province.vars?.urbanization
    };
    for (const profile of generateProfiles(province.id, census)) {
      const src = bestLegacyMatch(oldHouseholds, province.id, profile.axes, stats);
      newHouseholds.push({
        id: `hh_${profile.id}`,
        provinceId: province.id,
        axes: profile.axes,
        group: deriveLegacyLabel(profile.axes),
        quintile: profile.axes.quintile,
        population: profile.population,
        income: src.income ?? profile.income,
        happiness: src.happiness ?? 50,
        governmentSupport: src.support ?? 50,
        economicConfidence: src.confidence ?? 50,
        foodAccess: src.food ?? 90,
        ideology: profile.ideology,
        sensitivity: profile.sensitivity,
        fatigue: {},
        accountId: `acct_hh_${profile.id}`
      });
    }
  }
  save.households = newHouseholds;

  reconcileAccounts(save, oldHouseholds);

  if (save.settings?.demographics?.groups) {
    save.settings.demographics.legacyGroups = save.settings.demographics.groups;
    delete save.settings.demographics.groups;
  }
  save.settings = save.settings || {};
  if (!save.settings.partyPositions) {
    save.settings.partyPositions = {
      party_ua:  { economic:  0.2,  cultural:  0.15 },
      party_pfj: { economic: -0.35, cultural: -0.3  },
      party_nf:  { economic:  0.3,  cultural:  0.65 },
      party_acp: { economic: -0.8,  cultural: -0.3  },
      party_kff: { economic:  0.2,  cultural: -0.15 }
    };
  }
  if (save.settings.fatigueConfig) configureFatigue(save.settings.fatigueConfig);

  if (!Array.isArray(save._migrations)) save._migrations = [];
  save._migrations.push(MIGRATION_ID);

  console.log(`[MIGRATION] ${MIGRATION_ID} complete: ${newHouseholds.length} household segments.`);
  return save;
}

function legacyMatchScore(hh, axes) {
  const g = String(hh.group || '').toLowerCase();
  if (!g) return 0;
  let s = 0;
  if (hh.quintile === axes.quintile) s += 2;
  if (axes.lifecycle === 'student' && g === 'students') s += 4;
  if (axes.lifecycle === 'retired' && g === 'retired') s += 4;
  if (axes.class === 'working_class' && g.includes('working')) s += 3;
  if (axes.class === 'middle_class' && g.includes('middle')) s += 3;
  if (axes.class === 'upper_class' && g.includes('upper')) s += 3;
  if (axes.location === 'rural' && g === 'rural') s += 2;
  if (axes.location === 'urban' && g === 'urban') s += 2;
  return s;
}

function bestLegacyMatch(oldHouseholds, provinceId, axes, stats) {
  const avg = (key, fallback) => (stats && stats.pop > 0) ? stats[key] / stats.pop : fallback;
  let best = null, bestScore = 0;
  for (const hh of oldHouseholds) {
    if (hh.provinceId !== provinceId) continue;
    const score = legacyMatchScore(hh, axes);
    if (score > bestScore) { bestScore = score; best = hh; }
  }
  if (!best) {
    return {
      happiness: avg('happiness', 50), support: avg('support', 50),
      confidence: avg('confidence', 50), food: avg('food', 90), income: avg('income', null)
    };
  }
  return {
    happiness: pickNum(best.happiness, best.vars?.happiness, avg('happiness', 50)),
    support: pickNum(best.governmentSupport, best.vars?.governmentSupport, avg('support', 50)),
    confidence: pickNum(best.economicConfidence, best.vars?.economicConfidence, avg('confidence', 50)),
    food: pickNum(best.foodAccess, best.vars?.foodAccess, avg('food', 90)),
    income: pickNum(best.income, avg('income', null))
  };
}

// If an account ledger map exists, redistribute old balances across the new
// household accounts proportionally to population. Best effort, never throws.
function reconcileAccounts(save, oldHouseholds) {
  try {
    const ledger = save.accounts;
    if (!ledger || typeof ledger !== 'object') return;
    const total = oldHouseholds.reduce((sum, hh) => {
      const id = hh.accountId || hh.id;
      return sum + (typeof ledger[id] === 'number' ? ledger[id] : 0);
    }, 0);
    if (total <= 0) return;
    const newPop = save.households.reduce((s, hh) => s + (hh.population || 0), 0) || 1;
    for (const hh of oldHouseholds) delete ledger[hh.accountId || hh.id];
    for (const hh of save.households) {
      ledger[hh.accountId] = Math.floor(total * (hh.population || 0) / newPop);
    }
    console.log(`[MIGRATION] Redistributed ${total} across new household accounts.`);
  } catch (err) {
    console.warn('[MIGRATION] Account reconciliation skipped:', err.message);
  }
}

function pickNum(...vals) {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return vals[vals.length - 1];
}

function deriveLegacyLabel(axes) {
  const flat = { student: 'Students', retired: 'Retired' }[axes.lifecycle];
  if (flat) return flat;
  const loc = axes.location === 'urban' ? 'Urban' : 'Rural';
  const cls = {
    working_class: 'Working Class', middle_class: 'Middle Class', upper_class: 'Upper Class'
  }[axes.class] || 'Working Class';
  return `${loc} ${cls}`;
}

module.exports = { needsMigration, migrate, MIGRATION_ID };

