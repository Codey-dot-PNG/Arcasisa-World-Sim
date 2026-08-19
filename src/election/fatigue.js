const FATIGUE_CONFIG = {
  perUseIncrement: 0.15,
  sameMethodIncrement: 0.25,
  differentMethodIncrement: 0.05,
  decayPerTurn: 0.10,
  maxFatigue: 1.0,
  minEffectiveness: 0.1,
  backlashThreshold: 0.8,
  backlashPenalty: -0.05,
  crossPartyInterference: 0.05,
  cooldownTurns: 2
};

// Lets settings.fatigueConfig override defaults at world load.
function configureFatigue(overrides = {}) {
  Object.assign(FATIGUE_CONFIG, overrides);
  return FATIGUE_CONFIG;
}

function recordCampaignUse(profile, partyId, campaignId, currentTurn) {
  if (!profile.fatigue) profile.fatigue = {};
  if (!profile.fatigue[partyId]) profile.fatigue[partyId] = {};
  if (!profile.fatigue[partyId][campaignId]) {
    profile.fatigue[partyId][campaignId] = { uses: 0, cumulative: 0, lastTurn: -999 };
  }
  const state = profile.fatigue[partyId][campaignId];
  const turnsSince = currentTurn - state.lastTurn;

  if (turnsSince > 1) {
    state.cumulative = Math.max(0, state.cumulative - FATIGUE_CONFIG.decayPerTurn * (turnsSince - 1));
  }

  let increment;
  if (turnsSince <= 1) {
    increment = FATIGUE_CONFIG.perUseIncrement + FATIGUE_CONFIG.sameMethodIncrement;
  } else if (turnsSince <= FATIGUE_CONFIG.cooldownTurns) {
    increment = FATIGUE_CONFIG.perUseIncrement + FATIGUE_CONFIG.differentMethodIncrement;
  } else {
    increment = FATIGUE_CONFIG.perUseIncrement;
  }

  state.uses += 1;
  state.cumulative = Math.min(FATIGUE_CONFIG.maxFatigue, state.cumulative + increment);
  state.lastTurn = currentTurn;
  return getEffectivenessMultiplier(state.cumulative);
}

function getEffectivenessMultiplier(cumulativeFatigue) {
  return Math.max(FATIGUE_CONFIG.minEffectiveness, 1.0 - cumulativeFatigue);
}

function getFatigueMultiplier(profile, partyId, campaignId) {
  const state = profile.fatigue?.[partyId]?.[campaignId];
  return state ? getEffectivenessMultiplier(state.cumulative) : 1.0;
}

function checkBacklash(profile, partyId) {
  if (!profile.fatigue?.[partyId]) return 0;
  const maxCumulative = Math.max(...Object.values(profile.fatigue[partyId]).map(m => m.cumulative), 0);
  return maxCumulative >= FATIGUE_CONFIG.backlashThreshold
    ? FATIGUE_CONFIG.backlashPenalty : 0;
}

function applyCrossPartyInterference(profile, campaigningPartyId) {
  if (!profile.fatigue) return;
  for (const [partyId, methods] of Object.entries(profile.fatigue)) {
    if (partyId === campaigningPartyId) continue;
    for (const state of Object.values(methods)) {
      state.cumulative = Math.min(FATIGUE_CONFIG.maxFatigue,
        state.cumulative + FATIGUE_CONFIG.crossPartyInterference);
    }
  }
}

function decayFatigue(profile) {
  if (!profile.fatigue) return;
  for (const methods of Object.values(profile.fatigue)) {
    for (const state of Object.values(methods)) {
      state.cumulative = Math.max(0, state.cumulative - FATIGUE_CONFIG.decayPerTurn);
    }
  }
}

module.exports = {
  FATIGUE_CONFIG, configureFatigue,
  recordCampaignUse, getEffectivenessMultiplier, getFatigueMultiplier,
  checkBacklash, applyCrossPartyInterference, decayFatigue
};

