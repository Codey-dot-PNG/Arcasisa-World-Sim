const { computeVoteShares } = require('./voteCount'); // preserved from original
const {
  CAMPAIGNS, validateCampaignLaunch, resolveCampaignModifier,
  partyName, partyAbbr
} = require('./campaigns');
const {
  computeBasePreferences, applyCampaignStimulus,
  computeTargetMatch, DEFAULT_PARTY_POSITIONS
} = require('./preferences');
const {
  recordCampaignUse, checkBacklash, applyCrossPartyInterference, decayFatigue
} = require('./fatigue');
const { clamp } = require('../demographics/groups');
const { pushNews, wireTransfer, fmtMoney, itemCostPhrase } = require('../news/wire');

const fmtPoints = p => String(Math.round(p * 10) / 10);

function ensureTurnState(election) {
  if (!election._turnState) election._turnState = {};
  if (!election._turnState.campaignUsesThisTurn) election._turnState.campaignUsesThisTurn = {};
  return election._turnState;
}

// --- optional cost payment -------------------------------------------
// Live behaviour charges the payer outside the engine (wire reports show
// players transferring funds to parties, purpose "Campaign."), so the
// engine does NOT pay by default. Enable with
// settings.election.enginePaysCosts = true.
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

function payCampaignCost(worldState, partyEntity, campaign, modifier) {
  const cost = Math.round((campaign.moneyCost || 0) * (modifier.costMultiplier || 1));
  if (cost <= 0) return { ok: true, cost: 0 };
  const bal = balanceAccess(partyEntity);
  if (!bal) return { ok: true, cost, warning: 'No party balance found; cost not deducted.' };
  if (bal.get() < cost) return { ok: false, cost, have: bal.get() };
  bal.set(bal.get() - cost);
  wireTransfer(worldState, partyName(partyEntity.id), 'Bank of Arcasia', cost, `Campaign: ${campaign.name}`);
  return { ok: true, cost };
}

function executeCampaign(election, campaignId, provinceId, partyId, actor, worldState) {
  const campaign = CAMPAIGNS[campaignId];
  if (!campaign) return { success: false, error: `Unknown campaign: ${campaignId}` };

  const turnState = ensureTurnState(election);
  const validation = validateCampaignLaunch(campaignId, provinceId, partyId, turnState);
  if (!validation.valid) return { success: false, error: validation.reason };

  const partyEntity = (worldState.entities || []).find(e => e.id === partyId);
  if (!partyEntity) return { success: false, error: `Party not found: ${partyId}` };

  const modifier = resolveCampaignModifier(worldState, partyId, provinceId);
  const moneyCost = Math.round((campaign.moneyCost || 0) * (modifier.costMultiplier || 1));

  if (worldState.settings?.election?.enginePaysCosts) {
    const payment = payCampaignCost(worldState, partyEntity, campaign, modifier);
    if (!payment.ok) {
      return { success: false, error: `Insufficient party funds: need ${fmtMoney(payment.cost)}, have ${fmtMoney(payment.have)}.` };
    }
  }

  const province = (worldState.provinces || []).find(p => p.id === provinceId);
  const provinceName = (province && (province.name || province.displayName)) || provinceId;

  // FIX (critical): the original patch read election._profiles[provinceId],
  // which was never populated anywhere — campaigns silently affected
  // nobody. The canonical household store is worldState.households.
  const households = (worldState.households || []).filter(hh =>
    hh.provinceId === provinceId && (hh.population || 0) > 0
  );
  const migrated = households.filter(hh => hh.axes && hh.ideology);

  // Calibrated against live wire reports (youth ≈ 1-2, radio ≈ 1-10,
  // pamphlet ≈ 2.5, rally ≈ 12 with org bonus). Tunable.
  const scale = worldState.settings?.election?.voteToSupportScale ?? 150;
  let supportPoints;
  let profilesAffected = 0;
  let votesGained = null;

  if (!migrated.length) {
    // Legacy save (households lack axes): flat fallback until the save
    // migration runs, so campaigns still function.
    supportPoints = clamp(campaign.strength * (modifier.effectMultiplier || 1), -10, 25);
    applyVotesToElection(election, provinceId, partyId, supportPoints);
  } else {
    const partyPositions = worldState.settings?.partyPositions || DEFAULT_PARTY_POSITIONS;
    const turn = worldState.turn || 0;
    const effective = {
      ...campaign,
      strength: (campaign.strength || 1) * (modifier.effectMultiplier || 1)
    };

    for (const profile of migrated) {
      // FIX: fatigue/interference recorded only for voters the campaign
      // actually reaches (targeting), not everyone in the province.
      if (computeTargetMatch(profile.axes, campaign.targeting) <= 0) continue;

      const basePrefs = computeBasePreferences(profile, partyPositions);
      recordCampaignUse(profile, partyId, campaignId, turn);
      const modified = applyCampaignStimulus(profile, effective, partyId, basePrefs);

      votesGained = (votesGained || 0) +
        ((modified[partyId] || 0) - (basePrefs[partyId] || 0)) * profile.population;
      profilesAffected++;
      applyCrossPartyInterference(profile, partyId);
      const backlash = checkBacklash(profile, partyId);
      if (backlash !== 0) votesGained += backlash * profile.population;
    }

    if (profilesAffected === 0) {
      return { success: false, error: `No households in ${provinceName} match this campaign's targeting.` };
    }

    const reachedPopulation = migrated
      .filter(hh => computeTargetMatch(hh.axes, campaign.targeting) > 0)
      .reduce((s, hh) => s + hh.population, 0) || 1;

    // FIX: the original formula could award more votes than there are
    // voters and dumped population-scale numbers into election.counted.
    votesGained = clamp(votesGained, -reachedPopulation * 0.1, reachedPopulation);
    supportPoints = clamp((votesGained / reachedPopulation) * scale, -10, 25);
    applyVotesToElection(election, provinceId, partyId, supportPoints);
  }

  const key = `${provinceId}_${partyId}_${campaignId}`;
  turnState.campaignUsesThisTurn[key] = (turnState.campaignUsesThisTurn[key] || 0) + 1;

  election.log = election.log || [];
  election.log.push({
    ts: Date.now(), date: worldState.date, kind: 'campaign', turn: worldState.turn || 0,
    actor: (actor && actor.displayName) || 'Unknown',
    partyId, campaignId, provinceId, campaignName: campaign.name,
    strength: supportPoints,
    votesGained: votesGained === null ? null : Math.round(votesGained),
    profilesAffected,
    money: moneyCost,
    materials: campaign.itemCosts,
    durationMinutes: campaign.durationMinutes
  });

  // Wire news — exact live template:
  // "[Party] has launched "X" in [Province] on the campaign trail, at a
  //  cost of ₳N plus Item ×Q. The drive runs for N world minutes and
  //  delivers N.N permanent support points."
  pushNews(worldState, {
    author: 'Wire Service',
    paperId: 'paper_today',
    category: 'Politics',
    headline: `${partyAbbr(partyId)} ON THE CAMPAIGN TRAIL IN ${String(provinceName).toUpperCase()}`,
    body: `${partyName(partyId)} has launched "${campaign.name}" in ${provinceName} on the campaign trail, at a cost of ${fmtMoney(moneyCost)}${itemCostPhrase(worldState, campaign.itemCosts)}. The drive runs for ${campaign.durationMinutes} world minutes and delivers ${fmtPoints(supportPoints)} permanent support points.`
  });

  // FIX: scandalRisk was declared but never rolled in the original patch.
  let scandal = null;
  if (campaign.scandalRisk && Math.random() < campaign.scandalRisk) {
    scandal = triggerScandal(election, worldState, provinceId, provinceName, partyId, campaign, migrated, actor);
  }

  return {
    success: true,
    supportGain: supportPoints,   // backward-compatible alias
    supportPoints,
    votesGained: votesGained === null ? null : Math.round(votesGained),
    profilesAffected,
    scandal
  };
}

// FIX (critical): the original patch called this without defining it —
// ReferenceError on every campaign launch.
function applyVotesToElection(election, provinceId, partyId, amount) {
  if (!election.counted) election.counted = {};
  if (!election.counted[provinceId]) election.counted[provinceId] = {};
  const cur = election.counted[provinceId][partyId] || 0;
  election.counted[provinceId][partyId] = Math.max(0, cur + amount);
}
const applySupportToProvince = applyVotesToElection; // legacy alias

function triggerScandal(election, worldState, provinceId, provinceName, partyId, campaign, households, actor) {
  const penalty = 10;
  for (const hh of households) {
    hh.happiness = clamp((hh.happiness ?? 50) - 6, 0, 100);
    hh.governmentSupport = clamp((hh.governmentSupport ?? 50) - 8, 0, 100);
  }
  applyVotesToElection(election, provinceId, partyId, -penalty);

  const entry = {
    ts: Date.now(), date: worldState.date, kind: 'scandal', turn: worldState.turn || 0,
    actor: (actor && actor.displayName) || 'Unknown',
    partyId, provinceId, campaignId: campaign.id,
    message: `${campaign.name} scandal exposed in ${provinceName}! Public trust damaged.`
  };
  election.log.push(entry);
  pushNews(worldState, {
    author: 'Wire Service', paperId: 'paper_today', category: 'Politics',
    headline: `CAMPAIGN SCANDAL IN ${String(provinceName).toUpperCase()}`,
    body: `Irregularities in ${partyName(partyId)}'s "${campaign.name}" have been exposed in ${provinceName}. Investigators are probing the ${partyAbbr(partyId)} operation; public trust has been damaged.`
  });
  return { penalty, logEntry: entry };
}

// FIX (critical): the original imported this from ./fatigue (crash) and
// iterated election._profiles (never populated). Takes worldState now.
function endTurnFatigueDecay(worldState) {
  for (const hh of worldState.households || []) decayFatigue(hh);
  if (worldState.election?._turnState) {
    worldState.election._turnState.campaignUsesThisTurn = {};
  }
}

module.exports = {
  executeCampaign,
  applyVotesToElection,
  applySupportToProvince,
  endTurnFatigueDecay
};

