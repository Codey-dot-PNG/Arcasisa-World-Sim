// ============================================================
// CAMPAIGN CATALOG — costs/durations verified against live wire
// reports (turn 6: Grazi, Lachevan, Mezdov, Korota):
//   soup:     ₳5,000 plus Grain (tonne) ×625, 15 min
//   radio:    ₳2,500,000, 5 min
//   youth:    ₳1,500,000, 5 min
//   pamphlet: ₳8,000,000, 5 min
//   rally:    ₳4,500,000 plus The Commie Bus ×1, 25 min
// Live data also shows per-party-per-province cost AND effect
// multipliers (NF & ACP paid 2x and delivered ~2x in Grazi;
// KFF paid base rate in Mezdov/Korota). resolveCampaignModifier()
// is the hook for that (worldState.partyOrg[party][province] =
// { multiplier } or { costMultiplier, effectMultiplier }).
// ============================================================

const PARTY_INFO = {
  party_ua:  { name: 'United Alliance', abbr: 'UA' }, // TODO: confirm live display name
  party_pfj: { name: "People's Freedom and Justice", abbr: 'PFJ' },
  party_nf:  { name: 'National Front', abbr: 'NF' },
  party_acp: { name: 'Arcasian Communist Party', abbr: 'ACP' },
  party_kff: { name: 'Kordish Freedom Front', abbr: 'KFF' }
};

const partyName = id => (PARTY_INFO[id] && PARTY_INFO[id].name) || id;
const partyAbbr = id => (PARTY_INFO[id] && PARTY_INFO[id].abbr) || String(id).toUpperCase();

const CAMPAIGNS = {
  camp_soup: {
    id: 'camp_soup', name: 'Food for the people Initiative',
    strength: 1, moneyCost: 5000,
    itemCosts: [{ itemId: 'item_grain', qty: 625 }],   // live-verified
    durationMinutes: 15, stimulusType: 'materialBenefit',
    targeting: { class: ['working_class'], lifecycle: ['working_age', 'student'] },
    description: 'Open community soup kitchens. Feeds the needy and your polling.',
    maxUsesPerTurnPerProvince: 2
  },
  camp_radio: {
    id: 'camp_radio', name: 'Radio Address',
    strength: 1, moneyCost: 2500000, itemCosts: [],
    durationMinutes: 5, stimulusType: 'culturalAppeal', targeting: {},
    description: 'Radio speeches beamed across the Republic.',
    maxUsesPerTurnPerProvince: 3
  },
  camp_youth: {
    id: 'camp_youth', name: 'Youth Pioneers Initiative',
    strength: 0.5, moneyCost: 1500000, itemCosts: [],
    durationMinutes: 5, stimulusType: 'culturalAppeal',
    targeting: { lifecycle: ['student'] },
    description: 'Flag waving, singing and boundless enthusiasm.',
    maxUsesPerTurnPerProvince: 2
  },
  camp_rally: {
    id: 'camp_rally', name: 'Grand Rally Tour',
    strength: 3, moneyCost: 4500000,
    // FIX: was malformed { or: [...], itemId: 'item_msuazzdcammju4', ... }
    // blob. Live wire report: "₳4,500,000 plus The Commie Bus ×1",
    // 25 world minutes (not 45).
    itemCosts: [{ itemId: 'item_msuazzdcammju4', qty: 1 }],
    durationMinutes: 25, stimulusType: 'culturalAppeal',
    targeting: { location: ['urban'] },
    description: 'A whistle-stop tour of motorcades and rallies.',
    maxUsesPerTurnPerProvince: 1
  },
  camp_pamphlet: {
    id: 'camp_pamphlet', name: 'Pamphlets & Papers Program',
    strength: 1.2, moneyCost: 8000000, itemCosts: [],
    durationMinutes: 5, stimulusType: 'economicConfidence',
    targeting: { class: ['middle_class', 'upper_class'] },
    description: 'Flood the mailboxes with glossy manifesto pamphlets.',
    maxUsesPerTurnPerProvince: 2
  },
  camp_vote_buying: {
    id: 'camp_vote_buying', name: 'Vote Buying',
    strength: 8, moneyCost: 12000000, itemCosts: [],
    durationMinutes: 1, stimulusType: 'materialBenefit',
    targeting: { class: ['working_class'], location: ['rural'] },
    description: 'A 50 ARK "donation" to mailboxes. Technically legal.',
    maxUsesPerTurnPerProvince: 1,
    scandalRisk: 0.15 // now actually rolled — see engine.js
  }
};

function resolveCampaignModifier(worldState, partyId, provinceId) {
  const org = worldState?.partyOrg?.[partyId]?.[provinceId];
  if (org && typeof org === 'object') {
    return {
      costMultiplier: org.costMultiplier ?? org.multiplier ?? 1,
      effectMultiplier: org.effectMultiplier ?? org.multiplier ?? 1
    };
  }
  return { costMultiplier: 1, effectMultiplier: 1 };
}

function validateCampaignLaunch(campaignId, provinceId, partyId, turnState) {
  const campaign = CAMPAIGNS[campaignId];
  if (!campaign) return { valid: false, reason: 'Unknown campaign' };
  const key = `${provinceId}_${partyId}_${campaignId}`;
  const uses = turnState.campaignUsesThisTurn?.[key] || 0;
  if (uses >= (campaign.maxUsesPerTurnPerProvince || 999)) {
    return {
      valid: false,
      reason: `Campaign limit reached: ${campaign.name} max ${campaign.maxUsesPerTurnPerProvince} uses/turn in ${provinceId}`
    };
  }
  return { valid: true };
}

module.exports = {
  CAMPAIGNS, PARTY_INFO, partyName, partyAbbr,
  resolveCampaignModifier, validateCampaignLaunch
};

