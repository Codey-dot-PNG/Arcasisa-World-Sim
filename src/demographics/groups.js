// ============================================================
// DEMOGRAPHIC MATRIX SYSTEM v2.1
// 2 locations x 3 classes x 3 lifecycle stages x 5 quintiles
// = 90 household segments per province.
// ============================================================

const DEMOGRAPHIC_AXES = {
  location:  { key: 'location',  values: ['urban', 'rural'], label: 'Location' },
  class:     { key: 'class',     values: ['working_class', 'middle_class', 'upper_class'], label: 'Social Class' },
  lifecycle: { key: 'lifecycle', values: ['student', 'working_age', 'retired'], label: 'Life Stage' }
};

const QUINTILE_COUNT = 5;

const AXIS_IDEOLOGY = {
  location: {
    urban: { economic: -0.2, cultural: -0.1 },
    rural: { economic:  0.1, cultural:  0.4 }
  },
  class: {
    working_class: { economic: -0.6, cultural:  0.0 },
    middle_class:  { economic:  0.0, cultural:  0.1 },
    upper_class:   { economic:  0.5, cultural:  0.3 }
  },
  lifecycle: {
    student:     { economic: -0.3, cultural: -0.4 },
    working_age: { economic:  0.0, cultural:  0.0 },
    retired:     { economic:  0.2, cultural:  0.5 }
  }
};

const AXIS_SENSITIVITY = {
  location: {
    urban: { materialBenefit: 0.7, culturalAppeal: 0.6, economicConfidence: 0.8 },
    rural: { materialBenefit: 0.9, culturalAppeal: 0.8, economicConfidence: 0.5 }
  },
  class: {
    working_class: { materialBenefit: 0.9, culturalAppeal: 0.3, economicConfidence: 0.7 },
    middle_class:  { materialBenefit: 0.5, culturalAppeal: 0.5, economicConfidence: 0.9 },
    upper_class:   { materialBenefit: 0.2, culturalAppeal: 0.4, economicConfidence: 0.6 }
  },
  lifecycle: {
    student:     { materialBenefit: 0.4, culturalAppeal: 0.9, economicConfidence: 0.5 },
    working_age: { materialBenefit: 0.8, culturalAppeal: 0.4, economicConfidence: 0.8 },
    retired:     { materialBenefit: 0.6, culturalAppeal: 0.7, economicConfidence: 0.4 }
  }
};

// FIX: weights are no longer hardcoded — urbanization is per-province
// (live map has 4 core states: Korota, Lachevan, Grazi, Mezdov).
const DEFAULT_WEIGHTS = {
  urbanization: 0.6,
  class:     { working_class: 0.45, middle_class: 0.35, upper_class: 0.20 },
  lifecycle: { student: 0.15, working_age: 0.65, retired: 0.20 }
};

const URBAN_INCOME_MULTIPLIER = 1.15;

function generateProfiles(provinceId, censusData = {}) {
  const profiles = [];
  const total = censusData.totalPopulation || 100000;
  const urbanization = clamp(
    censusData.urbanization ?? DEFAULT_WEIGHTS.urbanization, 0.05, 0.95
  );
  const locWeight = { urban: urbanization, rural: 1 - urbanization };

  for (const loc of DEMOGRAPHIC_AXES.location.values) {
    for (const cls of DEMOGRAPHIC_AXES.class.values) {
      for (const lc of DEMOGRAPHIC_AXES.lifecycle.values) {
        for (let q = 1; q <= QUINTILE_COUNT; q++) {
          profiles.push({
            id: `${provinceId}_${loc}_${cls}_${lc}_q${q}`,
            provinceId,
            axes: { location: loc, class: cls, lifecycle: lc, quintile: q },
            ideology: composeIdeology(loc, cls, lc),
            sensitivity: composeSensitivity(loc, cls, lc),
            population: estimateProfilePopulation(total, locWeight[loc], cls, lc),
            happiness: 50,
            economicConfidence: 50,
            governmentSupport: 50,
            foodAccess: 90,
            income: estimateIncome(cls, q, loc),
            fatigue: {}
          });
        }
      }
    }
  }
  return profiles;
}

function composeIdeology(loc, cls, lc) {
  const l = AXIS_IDEOLOGY.location[loc];
  const c = AXIS_IDEOLOGY.class[cls];
  const s = AXIS_IDEOLOGY.lifecycle[lc];
  return {
    economic: clamp((l.economic + c.economic + s.economic) / 3, -1, 1),
    cultural:  clamp((l.cultural + c.cultural + s.cultural) / 3, -1, 1)
  };
}

function composeSensitivity(loc, cls, lc) {
  const l = AXIS_SENSITIVITY.location[loc];
  const c = AXIS_SENSITIVITY.class[cls];
  const s = AXIS_SENSITIVITY.lifecycle[lc];
  return {
    materialBenefit:    (l.materialBenefit + c.materialBenefit + s.materialBenefit) / 3,
    culturalAppeal:     (l.culturalAppeal + c.culturalAppeal + s.culturalAppeal) / 3,
    economicConfidence: (l.economicConfidence + c.economicConfidence + s.economicConfidence) / 3
  };
}

function estimateProfilePopulation(total, locW, cls, lc) {
  const cw = DEFAULT_WEIGHTS.class[cls] ?? 0.33;
  const lw = DEFAULT_WEIGHTS.lifecycle[lc] ?? 0.33;
  return Math.max(0, Math.floor(total * locW * cw * lw / QUINTILE_COUNT));
}

function estimateIncome(cls, q, loc) {
  const base = { working_class: 200, middle_class: 600, upper_class: 2500 }[cls] || 400;
  const mult = [0.4, 0.7, 1.0, 1.4, 2.0][q - 1] || 1;
  return Math.floor(base * mult * (loc === 'urban' ? URBAN_INCOME_MULTIPLIER : 1));
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

module.exports = {
  DEMOGRAPHIC_AXES, QUINTILE_COUNT, AXIS_IDEOLOGY, AXIS_SENSITIVITY,
  DEFAULT_WEIGHTS, generateProfiles, composeIdeology, composeSensitivity, clamp
};

