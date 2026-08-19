const { clamp } = require('../demographics/groups');

const DEFAULTS = {
  famineMortalityRate: 0.0015,
  oldAgeMortalityRate: 0.012,
  birthRate: 0.0008,
  foodAccessPerCapitaScale: 1000,
  rationingFloor: 40
};

const settingsOf = ws => ({ ...DEFAULTS, ...(ws?.settings?.households || {}) });

function runCensusUpdate(worldState) {
  const s = settingsOf(worldState);
  const households = worldState.households;
  if (!Array.isArray(households)) return;

  // FIX: the original filtered all households per province inside the
  // household loop — O(provinces × households). Index once.
  const byProvince = new Map();
  for (const hh of households) {
    if (!byProvince.has(hh.provinceId)) byProvince.set(hh.provinceId, []);
    byProvince.get(hh.provinceId).push(hh);
  }

  let famineDeaths = 0, oldAgeDeaths = 0, births = 0;

  for (const province of worldState.provinces || []) {
    const provHHs = byProvince.get(province.id) || [];
    const popBefore = provHHs.reduce((sum, hh) => sum + (hh.population || 0), 0);

    const foodStock = province.vars?.foodStock || 0;
    const access = clamp(
      Math.floor((foodStock / Math.max(1, popBefore)) * s.foodAccessPerCapitaScale), 0, 100
    );

    for (const hh of provHHs) {
      if ((hh.population || 0) <= 0) { hh.population = 0; continue; }
      hh.foodAccess = province.vars?.rationing ? Math.max(access, s.rationingFloor) : access;

      let deaths = 0;
      if (hh.foodAccess < 50) {
        const severity = (50 - hh.foodAccess) / 50;
        const famine = Math.floor(hh.population * s.famineMortalityRate * severity);
        famineDeaths += famine;
        deaths += famine;
      }
      if (hh.axes?.lifecycle === 'retired') {
        const age = Math.floor(hh.population * s.oldAgeMortalityRate);
        oldAgeDeaths += age;
        deaths += age;
      }
      let born = 0;
      if (hh.axes?.lifecycle === 'working_age') {
        born = Math.floor(hh.population * s.birthRate);
        births += born;
      }
      hh.population = Math.max(0, hh.population - deaths + born);
    }

    province.vars = province.vars || {};
    province.vars.population = provHHs.reduce((sum, hh) => sum + (hh.population || 0), 0);
  }

  const gv = worldState.globalVars = worldState.globalVars || {};
  gv.population = households.reduce((sum, hh) => sum + (hh.population || 0), 0);
  // FIX: old-age deaths were previously counted as famine deaths.
  gv.famineDeaths = (gv.famineDeaths || 0) + famineDeaths;
  gv.oldAgeDeaths = (gv.oldAgeDeaths || 0) + oldAgeDeaths;
  gv.births = (gv.births || 0) + births;
}

// Used by government food releases for instant foodAccess feedback.
function recomputeProvinceFoodAccess(worldState, provinceId) {
  const s = settingsOf(worldState);
  const province = (worldState.provinces || []).find(p => p.id === provinceId);
  if (!province) return null;
  const provHHs = (worldState.households || []).filter(hh => hh.provinceId === provinceId);
  const pop = provHHs.reduce((sum, hh) => sum + (hh.population || 0), 0);
  const access = clamp(
    Math.floor(((province.vars?.foodStock || 0) / Math.max(1, pop)) * s.foodAccessPerCapitaScale),
    0, 100
  );
  for (const hh of provHHs) {
    hh.foodAccess = province.vars?.rationing ? Math.max(access, s.rationingFloor) : access;
  }
  return access;
}

module.exports = { runCensusUpdate, recomputeProvinceFoodAccess };

