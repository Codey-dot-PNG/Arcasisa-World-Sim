const { clamp } = require('../demographics/groups');
const { getFatigueMultiplier } = require('./fatigue'); // FIX: single source of truth

const DEFAULT_PARTY_POSITIONS = {
  party_ua:  { economic:  0.2,  cultural:  0.15 },
  party_pfj: { economic: -0.35, cultural: -0.3  },
  party_nf:  { economic:  0.3,  cultural:  0.65 },
  party_acp: { economic: -0.8,  cultural: -0.3  },
  party_kff: { economic:  0.2,  cultural: -0.15 }
};

const AXIS_WEIGHTS = { economic: 0.6, cultural: 0.4 };

function computeBasePreferences(profile, partyPositions) {
  const positions = partyPositions || DEFAULT_PARTY_POSITIONS;
  const scores = {};
  let total = 0;
  for (const [partyId, pos] of Object.entries(positions)) {
    const raw = Math.max(0.01, 1.0 - ideologicalDistance(profile.ideology, pos));
    scores[partyId] = raw;
    total += raw;
  }
  if (total <= 0) {
    const n = Object.keys(positions).length || 1;
    for (const partyId of Object.keys(positions)) scores[partyId] = 1 / n;
    return scores;
  }
  for (const partyId of Object.keys(scores)) scores[partyId] /= total;
  return scores;
}

function ideologicalDistance(voter, party) {
  const de = (voter.economic - party.economic) * AXIS_WEIGHTS.economic;
  const dc = (voter.cultural - party.cultural) * AXIS_WEIGHTS.cultural;
  return Math.sqrt(de * de + dc * dc);
}

// FIX: untargeted campaigns reach everyone at full strength (the original
// returned 0.5, silently halving Radio Address); quintile targeting honoured.
function computeTargetMatch(profileAxes, targeting) {
  if (!targeting || Object.keys(targeting).length === 0) return 1.0;
  let matchCount = 0, criteriaCount = 0;
  for (const [axis, allowed] of Object.entries(targeting)) {
    criteriaCount++;
    const value = profileAxes ? profileAxes[axis] : undefined;
    const hit = Array.isArray(allowed) ? allowed.includes(value) : allowed === value;
    if (hit) matchCount++;
  }
  return criteriaCount > 0 ? matchCount / criteriaCount : 1.0;
}

function applyCampaignStimulus(profile, campaign, partyId, basePrefs) {
  const modified = { ...basePrefs };
  const match = computeTargetMatch(profile.axes, campaign.targeting);
  if (match <= 0) return modified;

  const stimulusType = campaign.stimulusType || 'culturalAppeal';
  const sensMult = profile.sensitivity?.[stimulusType] ?? 0.5;
  const strength = (campaign.strength || 1) * match;
  const fatigueMult = getFatigueMultiplier(profile, partyId, campaign.id);
  const shift = strength * fatigueMult * sensMult * 0.02;

  modified[partyId] = clamp((modified[partyId] || 0) + shift, 0, 1);

  const total = Object.values(modified).reduce((a, b) => a + b, 0);
  if (total > 0) for (const k of Object.keys(modified)) modified[k] /= total;
  return modified;
}

module.exports = {
  DEFAULT_PARTY_POSITIONS, AXIS_WEIGHTS,
  computeBasePreferences, ideologicalDistance,
  applyCampaignStimulus, computeTargetMatch
};

