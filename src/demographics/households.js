const { generateProfiles } = require('./groups');

// FIX: backward-compatible signature. Legacy worldgen callers passed
// (province, groupsArray, quintiles) — that used to crash.
function generateHouseholds(province, censusDataOrGroups, _legacyQuintiles) {
  let censusData = censusDataOrGroups;
  if (Array.isArray(censusDataOrGroups) || censusData == null) {
    censusData = {
      totalPopulation: province?.vars?.population || 100000,
      urbanization: province?.vars?.urbanization
    };
  }
  return generateProfiles(province.id, censusData).map(toHousehold);
}

function toHousehold(profile) {
  return {
    id: `hh_${profile.id}`,
    provinceId: profile.provinceId,
    axes: profile.axes,
    group: deriveLegacyGroup(profile.axes),
    quintile: profile.axes.quintile,
    population: profile.population,
    income: profile.income,
    happiness: profile.happiness,
    governmentSupport: profile.governmentSupport,
    economicConfidence: profile.economicConfidence,
    foodAccess: profile.foodAccess,
    ideology: profile.ideology,
    sensitivity: profile.sensitivity,
    fatigue: profile.fatigue,
    accountId: `acct_hh_${profile.id}`
  };
}

function deriveLegacyGroup(axes) {
  const loc = axes.location === 'urban' ? 'Urban' : 'Rural';
  const cls = {
    working_class: 'Working Class',
    middle_class: 'Middle Class',
    upper_class: 'Upper Class'
  }[axes.class] || 'Working Class';
  const lc = { student: 'Student', working_age: '', retired: 'Retired' }[axes.lifecycle] || '';
  return lc ? `${loc} ${cls} (${lc})` : `${loc} ${cls}`;
}

module.exports = { generateHouseholds, deriveLegacyGroup, toHousehold };

