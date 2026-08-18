'use strict';
/* Phase 34 — Real-time elections with province-by-province counting.
   Once the GM opens the polls the count runs on the world-time system:
   every turn advances the count continuously (no discrete "batches"),
   and provinces report one at a time in shuffled order for drama.

   Campaigns come from the GM's catalogue: a party picks a campaign and a
   province, pays the base cost (money + stock), then may layer freeform
   extra money/materials on top for more strength. Each campaign has a
   duration in world minutes (world clock) — while one is running the party
   can't launch another — and optional per-party affinity multipliers.
   Support won by a campaign is PERMANENT: it stays on the party's books in
   that province (shaping polling) long after the drive itself winds down.
   The duration only gates the party's next launch, nothing more.

   All transient state lives on the election doc (no module-level state),
   so the count is serverless-safe per docs/CONVENTIONS.md. The engine
   itself is generic — party/type lookups only. */

const store = require('./store');
const sim = require('./sim');

const COUNT_NOISE = 0.55;    // per-delta wobble fraction
const STEPS_CAP = 300;       // counting history rows
const LOG_CAP = 120;           // campaign / Commission log rows

// Legacy campaign-investment constants (settings.election), retained for
// applyTuning tolerance only — the modern model anchors strength at each
// campaign's own moneyCost and diminishes above it.
const DEFAULT_MONEY_SUPPORT_BASE = 40000000;   // Koren per sqrt-unit (legacy)
const DEFAULT_MATERIAL_CAMPAIGN_RATE = 200;   // Koren-equivalent per unit (legacy)
const DEFAULT_SUPPORT_SCALE = 6;              // multiplier on sqrt (legacy)
const DEFAULT_CAMPAIGN_DIMINISH = 0.6;        // γ for excess budget above base

const fmtNum = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fmtMoneyOf = (db, n) => `${db.settings.currency || '₳'}${fmtNum(n)}`;
const clampPct = (n) => Math.max(0, Math.min(50, Number(n) || 0));

// Deterministic LCG (same as Phase 33 — seeded on the doc, so any
// serverless instance resumes exactly where the last one left off).
function rand(el) {
  el.rng = ((el.rng || 1) * 1664525 + 1013904223) >>> 0;
  return el.rng / 4294967296;
}

// settings.time.perTurn/unit no longer drive the count — see maybeTick
// below. The count is keyed to sim.worldClockNow(), the same continuous,
// turn-independent world-time clock the Day Market and War Engine already
// run on, so it advances by real elapsed world minutes/hours rather than
// waiting for a discrete turn to be advanced.

// ---------- helpers ----------------------------------------------------------

function partyAccount(db, party) {
  return db.accounts.find(a => a.ownerId === party.id);
}

function qtyOf(entity, itemId) {
  const r = (entity.inventory || []).find(x => x.itemId === itemId);
  return r ? r.qty : 0;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- campaign support --------------------------------------------------

// Campaigns now target ONE province, chosen by whoever runs them — no more
// blanket national support bump. party.vars.campaignPointsByProvince keeps a
// cumulative tally of every support point the campaign drive earned in each
// province. Nothing ever unwinds it: campaign support is permanent and
// lingers in party.support (shaping the simulated polls) until something
// else moves those numbers.
function applySupport(db, party, provinceId, strength, group) {
  const prov = db.provinces.find(p => p.id === provinceId);
  if (!prov) throw new Error('Choose a province to campaign in.');
  party.support = party.support || {};
  party.support[provinceId] = party.support[provinceId] || {};
  // A campaign with a targetGroup narrows its support to that demographic
  // group's bucket; no target (or "all") keeps the original blanket `all`
  // bucket that voting already credits to every group.
  const bucket = group && group !== 'all' ? group : 'all';
  party.support[provinceId][bucket] = Math.round(((party.support[provinceId][bucket] || 0) + strength) * 10) / 10;
  party.vars = party.vars || {};
  party.vars.campaignPointsByProvince = party.vars.campaignPointsByProvince || {};
  party.vars.campaignPointsByProvince[provinceId] =
    Math.round(((party.vars.campaignPointsByProvince[provinceId] || 0) + strength) * 10) / 10;
}

// Defamation (Phase 4.4): a catalogue campaign may name a TARGET PARTY
// (camp.defamePartyId) — the "same system", but the strength it buys is
// DAMAGE: support is REMOVED from the victim in the targeted province (clamped
// at zero) and, once the count is running, the equivalent late ballots come
// OFF the victim's pile instead of onto the runner's. Purely negative: the
// runner gains nothing except the victim's lost ground.
function damageSupport(db, target, provinceId, damage, group, attacker, el, actor) {
  const prov = db.provinces.find(p => p.id === provinceId);
  if (!prov || !(damage > 0)) return;
  target.support = target.support || {};
  target.support[provinceId] = target.support[provinceId] || {};
  const bucket = group && group !== 'all' ? group : 'all';
  const cur = target.support[provinceId][bucket] || 0;
  target.support[provinceId][bucket] = Math.max(0, Math.round((cur - damage) * 10) / 10);
  attacker.vars = attacker.vars || {};
  attacker.vars.defamationDelivered = Math.round(((attacker.vars.defamationDelivered || 0) + damage) * 10) / 10;
  if (el && el.phase === 'voting') {
    const vpp = Math.max(0, Math.round(Number(el.supportToVotes) || 2500));
    const votes = Math.round(damage * vpp);
    if (votes) addVotes(el, target.id, provinceId, -votes);
  }
  store.log('election', `${attacker.name} runs a smear against ${target.name} in ${prov.name}`,
    `${damage} ${group && group !== 'all' ? group + ' ' : ''}support removed from ${target.abbrev || target.name}`, actor || 'ENGINE', [target.id, attacker.id]);
}

// ---------- campaign support (linear budget model) ---------------------------
// Support scales LINEARLY with the party's budget relative to the GM-set base
// cost: funding "Soup Kitchen" at its ₳12,000 base delivers its base strength
// (say 3); a ₳120,000 run delivers 10× that (30 points); a ₳1,200 run delivers
// 10% (0.3). The campaign's required materials (camp.itemCosts) are consumed
// in the same proportion — exactly what the campaign uses, nothing extra.

function campaignRatio(camp, money) {
  const base = Math.max(1, Math.round(Number(camp.moneyCost) || 0));
  return { base, ratio: Math.max(0, Math.round(Number(money) || 0)) / base };
}

// Required stock at a given budget ratio: each row of camp.itemCosts scales by
// the ratio (rounded up so a partial budget still pays for a usable run), with
// "or" alternatives scaled the same way.
function scaledMaterials(camp, ratio) {
  const out = [];
  for (const row of (camp.itemCosts || [])) {
    if (!row || !row.itemId) continue;
    const qty = Math.max(1, Math.ceil(Math.max(1, Number(row.qty) || 1) * ratio));
    const or = Array.isArray(row.or) && row.or.length
      ? row.or.map(o => ({ itemId: o.itemId, qty: Math.max(1, Math.ceil(Math.max(1, Number(o.qty) || 1) * ratio)) }))
      : undefined;
    out.push({ itemId: row.itemId, qty, or });
  }
  return out;
}

// Pre-affinity strength for a campaign at the given budget.
// Below/at the base cost the strength is exactly proportional (₳1,200 on a
// ₳12,000 base → 10% of base strength). Above the base, returns DIMINISH at a
// GM-adjustable rate (settings.election.campaignDiminish, 0..1): excess
// budget `e = ratio - 1` contributes e^γ, so γ = 1 is fully linear (10× budget
// → 10× strength) and γ < 1 saturates faster (γ = 0.6 → a 10× budget delivers
// 1 + 9^0.6 ≈ 4.7× the base strength).
function campaignStrength(db, camp, money) {
  const { base, ratio } = campaignRatio(camp, money);
  const baseStrength = Math.max(0, Number(camp.strength) || 0);
  if (ratio <= 1) return baseStrength * ratio;
  const cfg = db.settings.election || {};
  let gamma = Number(cfg.campaignDiminish);
  if (!Number.isFinite(gamma)) gamma = DEFAULT_CAMPAIGN_DIMINISH;
  gamma = Math.min(1, Math.max(0.01, gamma));
  const excess = Math.pow(ratio - 1, gamma);
  return baseStrength * (1 + excess);
}

// Campaigns come from the GM's catalogue (settings.election.campaigns). Each
// entry carries a base money cost, required stock, a base support strength,
// a duration in WORLD minutes (the drive runs for that long and only then
// may the party run another — the support itself is PERMANENT and is never
// unwound) and optional party affinities —
// bonusParties = { partyId: multiplier } — so e.g. a soup kitchen scores
// double for the communists and a radio address does more for the national
// front. Funding the campaign at its base cost delivers exactly the base
// strength; the party picks its own budget — below the base it scales down
// proportionally, ABOVE the base it grows with DIMINISHING returns (rate set
// by the GM: settings.election.campaignDiminish), with the required stock
// consumed in the same proportion as the budget — no free-form extras — and
// the whole lot multiplied by the party's affinity bonus.

function campaignBonus(db, camp, partyId) {
  const b = (camp && camp.bonusParties) || {};
  const v = Number(b[partyId]);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

// A campaign catalogue entry may pin itself to ONE province (targetProvince —
// a soup kitchen serving a seam town, a radio drive regionalised to a single
// province). A drive run anywhere lands its support — and only its support —
// in the pinned province. `"all"` (the migration default) means "any province,
// exactly as before".
function effectiveProvinceId(camp, provinceId) {
  const t = camp && camp.targetProvince;
  return t && t !== 'all' ? t : provinceId;
}

// §4.7 — the economic axis. An economic-framing campaign (camp.economicFraming
// true — opt-in per campaign, no existing row is affected) resonates harder
// where poverty is real: the multiplier grows with the targeted group's poverty
// rate (when targetGroup is set) or the targeted province's poverty rate
// (otherwise), scaled by the GM knob
// settings.election.economicAlignment.povertyResonanceK. No tag, no scheme, or
// no poverty data → multiplier exactly 1, legacy behaviour preserved.
function economicResonance(db, camp, provinceId) {
  const ea = (db.settings.election || {}).economicAlignment;
  if (!ea || ea.enabled === false || !camp || !camp.economicFraming) return 1;
  const K = Number(ea.povertyResonanceK);
  if (!(K > 0)) return 1;
  const prov = db.provinces.find(p => p.id === provinceId);
  if (!prov) return 1;
  const povertyLine = Number(db.globalVars && db.globalVars.povertyLine) || 400;
  const tgt = camp.targetGroup;
  let poverty = null;
  if (tgt && tgt !== 'all') {
    const homes = (db.households || []).filter(h => h.provinceId === provinceId && h.group === tgt && (h.population || 0) > 0);
    const total = homes.reduce((s, h) => s + (h.population || 0), 0);
    const poor = homes.filter(h => (h.income || 0) < povertyLine).reduce((s, h) => s + (h.population || 0), 0);
    if (total > 0) poverty = poor / total;
  } else {
    const rate = prov.vars && prov.vars.povertyRate;
    if (rate !== undefined) poverty = Math.min(1, Math.max(0, rate / 100));
  }
  if (poverty === null || poverty <= 0) return 1;
  return Math.round((1 + K * poverty) * 1000) / 1000;
}

// World-clock time now, in ms since the epoch.
function worldNowMs(db) {
  return sim.worldClockNow(db.settings.time, Date.now());
}

// Wind down campaigns whose duration has elapsed: the drive is over and the
// party's single slot frees up so it can run another campaign. The support
// points the drive earned are NOT unwound — support is permanent and stays on
// the party's books in that province (shaping polling) after the drive ends;
// only the slot lock is released. Late votes cast into the count while a
// campaign was live stay on the books too — ballots are ballots.
// Returns how many campaigns just wound down (for broadcast decisions).
function expireCampaigns(db, el, nowWorldMs, actor) {
  const pc = el.partyCampaigns || (el.partyCampaigns = {});
  let expired = 0;
  for (const partyId of Object.keys(pc)) {
    const c = pc[partyId];
    if (!c || (c.endsAtWorldMs !== undefined && nowWorldMs < c.endsAtWorldMs)) continue;
    const party = db.entities.find(e => e.id === partyId);
    const prov = db.provinces.find(p => p.id === c.provinceId);
    el.log = el.log || [];
    el.log.push({ ts: Date.now(), turn: db.settings.time.turn, date: db.settings.time.date, kind: 'campaignEnd',
      partyId, campaignId: c.campaignId, campaignName: c.name, provinceId: c.provinceId,
      provinceName: prov ? prov.name : c.provinceId, strength: c.strength, actor: actor || 'ENGINE' });
    if (el.log.length > LOG_CAP) el.log.splice(0, el.log.length - LOG_CAP);
    store.log('election', `Campaign winds down: ${party ? party.name : partyId}'s "${c.name}" has run its course in ${prov ? prov.name : c.provinceId}`,
      `${c.strength} support points stay on the books — the drive is over and a new one may launch`, actor || 'ENGINE', party ? [party.id] : []);
    delete pc[partyId];
    expired++;
  }
  return expired;
}

// Hours remaining until a party's running campaign slot opens, or null.
function activeCampaignInfo(el, partyId, nowWorldMs) {
  const c = (el && el.partyCampaigns && el.partyCampaigns[partyId]) || null;
  if (!c) return null;
  const minutesLeft = c.endsAtWorldMs !== undefined
    ? Math.max(0, (c.endsAtWorldMs - nowWorldMs) / 60000)
    : 0;
  return { campaignId: c.campaignId, name: c.name, provinceId: c.provinceId, strength: c.strength,
    durationMinutes: c.durationMinutes, endsAtWorldMs: c.endsAtWorldMs, minutesLeft };
}

// Estimate what a catalogue campaign would deliver for this party in this
// province at the given budget — no spending happens here. Support anchors at
// baseStrength when funded at the base cost; below the base it scales
// proportionally, above it returns diminish (campaignStrength). Materials are
// whatever the campaign needs at that budget, scaled from its required stock.
function estimateCampaign(db, partyId, provinceId, campaignId, money, materials) {
  const party = db.entities.find(e => e.id === partyId);
  if (!party || party.type !== 'party') throw new Error('Unknown party.');
  const prov = db.provinces.find(p => p.id === provinceId);
  if (!prov) throw new Error('Choose a province to campaign in.');
  const camp = (db.settings.election && db.settings.election.campaigns || []).find(c => c.id === campaignId);
  if (!camp) throw new Error('Unknown campaign.');
  if (camp.enabled === false) throw new Error('That campaign is not on offer.');
  const defameParty = camp.defamePartyId ? db.entities.find(e => e.id === camp.defamePartyId) : null;
  const baseStrength = Math.max(0, Number(camp.strength) || 0);
  const { base, ratio } = campaignRatio(camp, money);
  const needs = scaledMaterials(camp, ratio);
  const effProv = effectiveProvinceId(camp, provinceId);
  const strength0 = campaignStrength(db, camp, money);
  const bonus = campaignBonus(db, camp, party.id);
  const resonance = economicResonance(db, camp, effProv);
  const strength = Math.round(strength0 * bonus * resonance * 10) / 10;
  let votes = 0;
  const el = db.election;
  if (el && el.active && el.phase === 'voting') {
    const vpp = Math.max(0, Math.round(Number(el.supportToVotes) || 2500));
    votes = Math.round(strength * vpp);
  }
  const durationMinutes = Math.max(1, Math.min(1440, Math.round(Number(camp.durationMinutes) || 5)));
  const names = db.items || [];
  return {
    ok: true, campaignId: camp.id, campaignName: camp.name, description: camp.description || '',
    baseStrength, baseCost: base, money: Math.max(0, Math.round(Number(money) || 0)), ratio: Math.round(ratio * 1000) / 1000,
    multiplier: baseStrength > 0 ? Math.round(strength0 / baseStrength * 1000) / 1000 : 0,
    materials: needs.map(n => ({ itemId: n.itemId, qty: n.qty,
      or: n.or ? n.or.map(o => ({ itemId: o.itemId, qty: o.qty })) : undefined,
      name: (names.find(i => i.id === n.itemId) || {}).name || n.itemId })),
    bonus, resonance, strength, votes, provinceId: effProv, provinceName: (db.provinces.find(p => p.id === effProv) || prov).name,
    defame: defameParty ? { partyId: defameParty.id, name: defameParty.name, abbrev: defameParty.abbrev } : null,
    targetGroup: camp.targetGroup && camp.targetGroup !== 'all' ? camp.targetGroup : null,
    targetProvince: camp.targetProvince && camp.targetProvince !== 'all' ? camp.targetProvince : null,
    durationMinutes,
    active: activeCampaignInfo(el, party.id, worldNowMs(db))
  };
}

// Run a catalogue campaign: pay the party's budget (support anchors at the
// GM-set base cost, diminishing above it), consume the campaign's required
// stock in the same proportion, apply the resulting strength × affinity bonus
// support to ONE province, and — if the count is already running — convert
// the strength into late votes.
function runCampaign(db, partyId, provinceId, campaignId, money, materials, actor) {
  const el = db.election;
  if (!el || !el.active) throw new Error('No election is active — campaigns run only during an election.');
  const party = db.entities.find(e => e.id === partyId);
  if (!party || party.type !== 'party') throw new Error('Unknown party.');
  const prov = db.provinces.find(p => p.id === provinceId);
  if (!prov) throw new Error('Choose a province to campaign in.');
  const camp = (db.settings.election && db.settings.election.campaigns || []).find(c => c.id === campaignId);
  if (!camp) throw new Error('Unknown campaign.');
  if (camp.enabled === false) throw new Error('That campaign is not on offer.');
  // Defamation: the catalogue names the victim; the runner pays the budget.
  const defameParty = camp.defamePartyId ? db.entities.find(e => e.id === camp.defamePartyId) : null;
  if (camp.defamePartyId && !defameParty) throw new Error('Defamation target not found: ' + camp.defamePartyId);
  if (defameParty && defameParty.id === party.id) throw new Error('A party cannot run a smear against itself.');

  const nowWorldMs = worldNowMs(db);
  expireCampaigns(db, el, nowWorldMs, actor);

  // One campaign at a time per party — the running one must finish first.
  const running = activeCampaignInfo(el, party.id, nowWorldMs);
  if (running) {
    throw new Error(`"${running.name}" is still running in ${((provById(db, running.provinceId) || {}).name || running.provinceId)} — ` +
      `it ends in ~${Math.max(1, Math.ceil(running.minutesLeft))}m. Wait for it to wind down before launching another.`);
  }

  // The party's budget IS the total spend — support anchors at base strength
  // for the GM base cost, scales proportionally below it and with DIMINISHING
  // returns above it (campaignStrength, GM rate). Materials are whatever the
  // campaign needs at that budget, scaled from its required stock — no
  // freeform extras.
  money = Math.max(0, Math.round(Number(money) || 0));
  const { base, ratio } = campaignRatio(camp, money);
  const needs = scaledMaterials(camp, ratio);
  const effProv = effectiveProvinceId(camp, provinceId);
  const provEff = db.provinces.find(p => p.id === effProv) || prov;
  const bonus = campaignBonus(db, camp, party.id);
  const resonance = economicResonance(db, camp, effProv);
  const strength = Math.round(campaignStrength(db, camp, money) * bonus * resonance * 10) / 10;
  if (money <= 0) throw new Error('Choose a budget for the campaign (₳) — funding ' + fmtMoneyOf(db, base) + ' delivers its base support.');
  if (strength <= 0) throw new Error('A budget of ' + fmtMoneyOf(db, money) + ' delivers no support for this campaign — raise the budget.');

  // Affordability: the full budget in money, and the scaled required stock.
  const acct = partyAccount(db, party);
  if (!acct || acct.balance < money) throw new Error(`${party.name}'s treasury cannot cover this campaign (${fmtMoneyOf(db, money)}).`);
  const check = checkItemCosts(db, party, needs);
  if (!check.ok) throw new Error(`${party.name} lacks ${check.missing} at a ${fmtMoneyOf(db, money)} budget — the campaign needs stock in proportion to its funding.`);

  // Deduct the budget and exactly the scaled stock.
  sim.txn(acct.id, null, money, 'Campaign: ' + camp.name, actor || party.name, 'withdraw');
  deductItemCosts(party, needs);

  if (defameParty) damageSupport(db, defameParty, effProv, strength, camp.targetGroup, party, el, actor);
  else if (strength > 0) applySupport(db, party, effProv, strength, camp.targetGroup);

  // Late votes if the count is running — scoped to the effective province.
  // Defamation is purely negative: damageSupport subtracts the victim's votes,
  // the runner gains nothing.
  let votes = 0;
  if (el.phase === 'voting') {
    const vpp = Math.max(0, Math.round(Number(el.supportToVotes) || 2500));
    votes = Math.round(strength * vpp);
    if (votes && !defameParty) addVotes(el, party.id, effProv, votes);
  }

  // The campaign now occupies the party's single slot until its duration
  // (in world minutes, per the world clock) elapses — then the slot opens
  // and the party may launch another. The support itself is permanent:
  // expiring only releases the slot, never the support points.
  const durationMinutes = Math.max(1, Math.min(1440, Math.round(Number(camp.durationMinutes) || 5)));
  el.partyCampaigns = el.partyCampaigns || {};
  el.partyCampaigns[party.id] = {
    campaignId: camp.id, name: camp.name, provinceId: effProv,
    strength, startWorldMs: nowWorldMs, durationMinutes,
    endsAtWorldMs: nowWorldMs + durationMinutes * 60000
  };

  // Descriptions for the log (the scaled required stock at this budget).
  const matDesc = needs.map(m => {
    const it = db.items.find(i => i.id === m.itemId);
    return `${it ? it.name : m.itemId} ×${m.qty}`;
  }).join(', ');

  el.log = el.log || [];
  el.log.push({ ts: Date.now(), turn: db.settings.time.turn, date: db.settings.time.date, kind: 'campaign',
    partyId: party.id, campaignId: camp.id, campaignName: camp.name, provinceId: effProv, provinceName: provEff.name,
    money, materials: needs.map(m => ({ itemId: m.itemId, qty: m.qty })), strength, votes, materialDesc: matDesc,
    durationMinutes, bonus, resonance, defame: defameParty ? defameParty.id : null,
    targetGroup: camp.targetGroup && camp.targetGroup !== 'all' ? camp.targetGroup : null,
    targetProvince: camp.targetProvince && camp.targetProvince !== 'all' ? camp.targetProvince : null,
    actor: actor || '—' });
  if (el.log.length > LOG_CAP) el.log.splice(0, el.log.length - LOG_CAP);

  store.log('election', defameParty
      ? `Smear: ${party.name} attacks "${camp.name}" in ${provEff.name}`
      : `Campaign: ${party.name} runs "${camp.name}" in ${provEff.name}`,
    `${money ? fmtMoneyOf(db, money) : 'no money'}${matDesc ? ' + ' + matDesc : ''} · ` +
    (defameParty
      ? `${strength} support removed from ${defameParty.name}`
      : `${strength} permanent support points`) +
    ` for ${durationMinutes} world minute${durationMinutes > 1 ? 's' : ''}${bonus !== 1 ? ' · ×' + bonus + ' party affinity' : ''}${resonance !== 1 ? ' · ×' + resonance + ' poverty resonance' : ''}${votes ? ' · ' + fmtNum(votes) + ' late ballots affected' : ''}`,
    actor, [party.id].concat(defameParty ? [defameParty.id] : []));

  sim.draftNews(`${party.abbrev || party.name} ${defameParty
      ? 'HITS ' + (defameParty.abbrev || defameParty.name).toUpperCase() + ' WITH A SMEAR'
      : (el.phase === 'voting' ? 'CAMPAIGNS INTO THE COUNT' : 'ON THE CAMPAIGN TRAIL')} IN ${provEff.name.toUpperCase()}`,
    `${party.name} has launched "${camp.name}" in ${provEff.name}${defameParty ? ', an open campaign of defamation against ' + defameParty.name : ''}` +
    `${el.phase === 'voting' ? ' as the ballots are counted' : ' on the campaign trail'}` +
    `${money ? ', at a cost of ' + fmtMoneyOf(db, money) : ''}${matDesc ? ' plus ' + matDesc : ''}. ` +
    `The drive runs for ${durationMinutes} world minute${durationMinutes > 1 ? 's' : ''}` +
    (defameParty
      ? ` and strips ${defameParty.name} of ${strength} support points`
      : ` and delivers ${strength} permanent support points`) +
    `${el.phase === 'voting' ? ' — ' + fmtNum(votes) + ' late ballots affected' : ''}.`,
    'Politics', false, 'Wire Service');

  return { money, strength, votes, bonus, resonance, durationMinutes,
    materialDesc: matDesc, provinceId: effProv, provinceName: provEff.name,
    defame: defameParty ? { partyId: defameParty.id, name: defameParty.name, abbrev: defameParty.abbrev } : null,
    targetGroup: camp.targetGroup && camp.targetGroup !== 'all' ? camp.targetGroup : null,
    targetProvince: camp.targetProvince && camp.targetProvince !== 'all' ? camp.targetProvince : null };
}

function provById(db, id) {
  return db.provinces.find(p => p.id === id);
}

// ---------- item-cost helpers (base stock requirements) -----------------------
// Used by runCampaign for the catalogue's required goods, with "or"
// alternatives accepted per row.

function checkItemCosts(db, entity, rows) {
  for (const row of (rows || [])) {
    if (!row || !row.itemId) continue;
    const qty = Math.max(1, Number(row.qty) || 1);
    const options = Array.isArray(row.or) && row.or.length
      ? [{ itemId: row.itemId, qty }, ...row.or]
      : [row];
    const have = options.find(o => o && o.itemId && qtyOf(entity, o.itemId) >= Math.max(1, Number(o.qty) || 1));
    if (!have) {
      const it = db.items.find(i => i.id === row.itemId);
      return { ok: false, missing: it ? `${it.name} ×${qty}` : 'the required goods' };
    }
  }
  return { ok: true };
}

function deductItemCosts(entity, rows) {
  for (const row of (rows || [])) {
    if (!row || !row.itemId) continue;
    const options = Array.isArray(row.or) && row.or.length
      ? [{ itemId: row.itemId, qty: Math.max(1, Number(row.qty) || 1) }, ...row.or]
      : [row];
    const have = options.find(o => o && o.itemId && qtyOf(entity, o.itemId) >= Math.max(1, Number(o.qty) || 1));
    if (!have) continue;
    entity.inventory = entity.inventory || [];
    const r = entity.inventory.find(x => x.itemId === have.itemId);
    if (r) {
      r.qty -= Math.max(1, Number(have.qty) || 1);
      if (r.qty <= 0) entity.inventory = entity.inventory.filter(x => x.qty > 0);
    }
  }
}

// ---------- the live election doc ---------------------------------------------

function pollingSnapshot(db) {
  try {
    const { national, totalVotes } = sim.computePolling(false);
    const out = {};
    for (const pid in national) out[pid] = Math.round(national[pid] / (totalVotes || 1) * 1000) / 10;
    return out;
  } catch (e) { return {}; }
}

function startCampaign(db, actor) {
  if (db.election) throw new Error('An election is already underway — end or cancel it first.');
  const cfg = db.settings.election || {};
  const t = db.settings.time;
  const durationDays = Math.max(1, Math.round(Number(cfg.durationDays) || Number(cfg.durationTurns) || 14));

  db.election = {
    id: store.uid('elec'), active: true, phase: 'campaign',
    calledTurn: t.turn, calledDate: t.date, calledAt: Date.now(),
    pollingAtCall: pollingSnapshot(db),
    durationDays,
    deviationPct: clampPct(cfg.deviationPct),
    supportToVotes: Math.max(0, Math.round(Number(cfg.supportToVotes) || 2500)),
    rng: (Math.random() * 4294967296) >>> 0,
    steps: [], log: [], progress: 0, totalBallots: 0, partyCampaigns: {}
  };
  sim.draftNews('ELECTION CALLED — CAMPAIGN SEASON OPENS',
    `The Republic goes to the country. Parliament is dissolved and the campaign trail opens; the Election Commission will announce polling day in due course.`,
    'Politics', true, 'Election Commission');
  store.log('election', 'General election called — campaign season opens',
    `Polling at call: ${fmtNum(db.election.pollingAtCall[Object.keys(db.election.pollingAtCall)[0]] || 0)}% for the leading party`,
    actor || 'GM', [db.election.id]);
}

// The "true" per-province result the count will converge to: the simulated
// poll (with noise) nudged by the GM's deviation lever.
function deviationTargets(el, baseTargets, parties) {
  const dev = clampPct(el.deviationPct) / 100;
  const out = {};
  for (const pid in baseTargets) {
    const provVotes = baseTargets[pid];
    const provTotal = Object.values(provVotes).reduce((s, v) => s + v, 0);
    if (provTotal <= 0) continue;
    const shares = {};
    let sum = 0;
    for (const pt of parties) {
      const share = (provVotes[pt.id] || 0) / provTotal;
      const nudge = 1 + (rand(el) * 2 - 1) * dev;
      shares[pt.id] = Math.max(0, share * nudge);
      sum += shares[pt.id];
    }
    const t = {};
    for (const pt of parties) t[pt.id] = provTotal * (shares[pt.id] / (sum || 1));
    out[pid] = t;
  }
  return out;
}

function startVoting(db, actor) {
  const el = db.election;
  if (!el || !el.active) throw new Error('Call an election first — campaigning comes before the polls.');
  if (el.phase !== 'campaign') throw new Error('Voting is already underway.');
  // Any campaign whose duration elapsed during the campaign season winds
  // down before the true result is sealed — its support stays on the books
  // (campaign support is permanent); only the party's launch slot frees.
  expireCampaigns(db, el, worldNowMs(db), actor);
  const { parties, byProvince, national, totalVotes } = sim.computePolling(true);

  // Shuffled province order — provinces report one at a time for drama
  el.provinceOrder = shuffleArray(db.provinces.map(p => p.id));
  el.baseTargets = byProvince;
  el.targets = deviationTargets(el, byProvince, parties);
  el.counted = {};
  el.provProgress = {};
  el.provComplete = {};
  for (const pid of el.provinceOrder) {
    el.counted[pid] = {};
    for (const pt of parties) el.counted[pid][pt.id] = 0;
    el.provProgress[pid] = 0;
  }
  el.electorate = totalVotes;
  el.phase = 'voting';
  el.votingTurn = db.settings.time.turn;   // informational only — no longer drives the count
  el.votingDate = db.settings.time.date;
  el.startWorldMs = sim.worldClockNow(db.settings.time, Date.now());
  el.steps = [];
  el.loggedPct = 0;
  updateProgress(el);

  sim.draftNews('POLLING STATIONS CLOSE — THE COUNT BEGINS',
    `Polls have closed across the Republic and the count is underway. ` +
    `${fmtNum(el.electorate)} ballots are expected. ` +
    `Results will come in province by province over the next ${el.durationDays} days.`,
    'Politics', true, 'Election Commission');
  store.log('election', 'Polling stations close — the count begins',
    `${fmtNum(el.electorate)} ballots · ${el.durationDays} days · ${el.provinceOrder.length} provinces reporting sequentially`,
    actor || 'GM', [el.id]);
}

function nationalCounts(el) {
  const nat = {};
  for (const pid in el.counted) {
    for (const partyId in el.counted[pid]) nat[partyId] = (nat[partyId] || 0) + el.counted[pid][partyId];
  }
  return nat;
}

function nationalTargetsTotal(el) {
  let s = 0;
  for (const pid in el.targets) {
    for (const partyId in el.targets[pid]) s += el.targets[pid][partyId];
  }
  return s;
}

function updateProgress(el) {
  const countedSum = Object.values(nationalCounts(el)).reduce((s, v) => s + v, 0);
  const targetSum = nationalTargetsTotal(el);
  el.totalBallots = Math.max(el.electorate || 0, targetSum);
  el.progress = el.totalBallots ? Math.min(1, countedSum / el.totalBallots) : 0;
}

// Defensive self-heal: a `voting`-phase election doc that predates this
// realtime engine (e.g. a Phase 33 batch-count doc with no provinceOrder),
// or one otherwise missing its per-province scaffolding, makes the loop
// below run zero iterations forever — ballots never move, `anyChange` never
// fires, and nothing ever throws, so there's no error to catch and nobody
// is ever told. Rebuild the scaffolding from el.targets (always set
// alongside phase:'voting' by startVoting) instead of leaving the count
// silently stuck. Returns false only if there's truly nothing to rebuild
// from, in which case the caller bails without crashing the turn.
function ensureRealtimeScaffold(db, el, actor) {
  if (el.phase !== 'voting') return true;
  const broken = !Array.isArray(el.provinceOrder) || !el.provinceOrder.length
    || !el.provProgress || !el.provComplete || !el.counted || !el.startWorldMs;
  if (!broken) return true;
  if (!el.targets || !Object.keys(el.targets).length) {
    console.error('election: voting phase with no targets on the doc — cannot self-heal, count is stuck.');
    return false;
  }
  const parties = db.entities.filter(e => e.type === 'party');
  if (!Array.isArray(el.provinceOrder) || !el.provinceOrder.length) {
    el.provinceOrder = shuffleArray(Object.keys(el.targets));
  }
  el.provProgress = el.provProgress || {};
  el.provComplete = el.provComplete || {};
  el.counted = el.counted || {};
  for (const pid of el.provinceOrder) {
    if (el.provProgress[pid] === undefined) el.provProgress[pid] = 0;
    if (!el.counted[pid]) {
      const c = {};
      for (const pt of parties) c[pt.id] = 0;
      el.counted[pid] = c;
    }
  }
  if (!el.startWorldMs) el.startWorldMs = sim.worldClockNow(db.settings.time, Date.now());
  el.steps = el.steps || [];
  el.log = el.log || [];
  store.log('election', 'Election Commission repairs the live count',
    'The count was missing its province schedule and has been rebuilt from the sealed targets.',
    actor || 'ENGINE', [el.id]);
  return true;
}

// Advance the count: provinces report one at a time, each taking
// durationDays/numProvinces of REAL WORLD TIME (sim.worldClockNow), not
// world turns. nowWorldMs is the world-clock timestamp to evaluate against —
// calling this with the same or an earlier nowWorldMs than last time is a
// safe no-op (newProg <= prevProg guards below), so it's fine to call this
// as often as we like; how often just changes how chunky the visible
// updates are, never the final result.
function advanceRealtimeCount(db, el, nowWorldMs, actor) {
  if (!ensureRealtimeScaffold(db, el, actor)) return;
  expireCampaigns(db, el, nowWorldMs, actor);
  const parties = db.entities.filter(e => e.type === 'party');
  const numProvs = el.provinceOrder.length;
  const daysPerProvince = el.durationDays / numProvs;
  const daysElapsed = Math.max(0, (nowWorldMs - el.startWorldMs) / 86400000);

  let anyChange = false;

  for (let i = 0; i < numProvs; i++) {
    const pid = el.provinceOrder[i];
    if (el.provComplete[pid]) continue;

    const provStartDay = i * daysPerProvince;
    const provEndDay = (i + 1) * daysPerProvince;
    let newProg;

    if (daysElapsed >= provEndDay) {
      newProg = 1;
    } else if (daysElapsed > provStartDay) {
      newProg = (daysElapsed - provStartDay) / daysPerProvince;
    } else {
      continue; // province hasn't started yet
    }

    const prevProg = el.provProgress[pid] || 0;
    if (newProg <= prevProg) continue;

    const targets = el.targets[pid];
    const counted = el.counted[pid];
    const provTotal = Object.values(targets).reduce((s, v) => s + v, 0) || 1;

    if (newProg >= 1) {
      // Province complete — snap to final targets
      for (const pt of parties) counted[pt.id] = Math.max(0, Math.round(targets[pt.id] || 0));
      el.provProgress[pid] = 1;
      el.provComplete[pid] = true;
    } else {
      // Add delta votes with wobble
      const deltaVotes = provTotal * (newProg - prevProg);
      const raw = {};
      let sum = 0;
      for (const pt of parties) {
        const share = (targets[pt.id] || 0) / provTotal;
        const v = share * deltaVotes * (1 + (rand(el) * 2 - 1) * COUNT_NOISE);
        raw[pt.id] = Math.max(0, v);
        sum += raw[pt.id];
      }
      const scale = sum > 0 ? deltaVotes / sum : 1;
      for (const pt of parties) counted[pt.id] = (counted[pt.id] || 0) + raw[pt.id] * scale;
      el.provProgress[pid] = newProg;
    }
    anyChange = true;
  }

  if (anyChange) {
    el._tickWorldMs = nowWorldMs;
    el.steps.push({
      worldMs: nowWorldMs, turn: db.settings.time.turn, date: db.settings.time.date,
      counted: nationalCounts(el),
      provProgress: { ...el.provProgress },
      provComplete: { ...el.provComplete }
    });
    if (el.steps.length > STEPS_CAP) el.steps.splice(0, el.steps.length - STEPS_CAP);
    updateProgress(el);

    // Milestone logging
    const pct = Math.round(el.progress * 100);
    const pctTotal = Object.values(nationalCounts(el)).reduce((s, v) => s + v, 0);
    if (pct >= 25 && (el.loggedPct || 0) < 25) { el.loggedPct = 25; store.log('election', `The count passes a quarter — ${fmtNum(pctTotal)} ballots in`, '', actor || 'ENGINE', [el.id]); }
    else if (pct >= 50 && (el.loggedPct || 0) < 50) { el.loggedPct = 50; store.log('election', `The count passes the halfway mark — ${fmtNum(pctTotal)} ballots in`, '', actor || 'ENGINE', [el.id]); }
    else if (pct >= 75 && (el.loggedPct || 0) < 75) { el.loggedPct = 75; store.log('election', `The count passes three quarters — ${fmtNum(pctTotal)} ballots in`, '', actor || 'ENGINE', [el.id]); }

    // All provinces done → finalize
    if (Object.keys(el.provComplete).length === numProvs) {
      finalize(db, actor);
    }
  }
}

// Minimum real-world gap between actual count updates. The count's PACE is
// set entirely by sim.worldClockNow (world minutes/hours elapsing), not by
// how often this is called — this gate just throttles HOW OFTEN we bother
// doing the work, so a burst of concurrent /api/state requests (serverless)
// or the long-lived process's own poll (server.js) doesn't recompute on
// every single call or flood el.steps with near-duplicate rows. Safe to
// call from multiple places (self-gated, same pattern as market.js's
// _lastDayTick and war.js's tick gate).
const MIN_TICK_REAL_MS = 3000;

// The count's primary driver — ride this from GET /api/state (serverless)
// and from a resident timer (server.js, long-lived process), exactly like
// market.maybeDayTick / war.maybeWarTickSignal. Returns a signal so callers
// can decide whether to broadcast (milestones/finalize only — see those
// functions' own comments on why per-tick broadcasts are avoided).
function maybeTick(db, actor) {
  const el = db.election;
  if (!el || !el.active) return { ticked: false, milestone: false };
  const nowReal = Date.now();
  if (el._lastTickRealMs && (nowReal - el._lastTickRealMs) < MIN_TICK_REAL_MS) return { ticked: false, milestone: false };
  el._lastTickRealMs = nowReal;
  const nowWorldMs = sim.worldClockNow(db.settings.time, nowReal);
  if (el.phase !== 'voting') {
    // Campaign season: nothing to count, but finished campaigns must wind
    // down so the party's launch slot frees up (support stays permanent).
    const expired = expireCampaigns(db, el, nowWorldMs, actor);
    return { ticked: expired > 0, milestone: expired > 0 };
  }
  const beforePct = el.loggedPct || 0;
  advanceRealtimeCount(db, el, nowWorldMs, actor);
  const finalized = !db.election; // finalize() sets db.election = null
  const milestone = finalized || (db.election && (db.election.loggedPct || 0) > beforePct);
  return { ticked: true, milestone: !!milestone };
}

// Kept as a turn-advance nudge too — cheap, self-gated by maybeTick's own
// MIN_TICK_REAL_MS, and means a manual "Advance Turn" also gives the count
// a chance to catch up even in a setup with no other pollers running.
function onTurn(db, actor) {
  maybeTick(db, actor);
}

// GM "refresh now" — forces an immediate recompute against the current
// world-clock time, bypassing the MIN_TICK_REAL_MS gate. The count's actual
// progress is still governed entirely by elapsed world time (durationDays
// vs sim.worldClockNow), so this can't "add" ballots beyond what real time
// justifies — it just skips waiting for the next automatic poll.
function tickCount(db, actor) {
  const el = db.election;
  if (!el || !el.active) throw new Error('No election is active.');
  if (el.phase !== 'voting') throw new Error('The count has not started yet — open the polls first.');
  const nowReal = Date.now();
  const nowWorldMs = sim.worldClockNow(db.settings.time, nowReal);
  advanceRealtimeCount(db, el, nowWorldMs, actor);
  el._lastTickRealMs = nowReal;
  return db.election;
}

// ---------- finalize ---------------------------------------------------------

function finalize(db, actor) {
  const el = db.election;
  const parties = db.entities.filter(e => e.type === 'party');
  const totalSeats = db.settings.parliamentSeats || 150;
  const { seatTotals, provResults } = sim.apportionSeats(el.targets, totalSeats);
  parties.forEach(pt => { pt.mpCount = seatTotals[pt.id] || 0; });

  const national = {};
  for (const pid in el.targets) {
    for (const partyId in el.targets[pid]) national[partyId] = (national[partyId] || 0) + el.targets[pid][partyId];
  }
  const totalVotes = Math.round(Object.values(national).reduce((s, v) => s + v, 0)) || 1;
  const electorate = db.provinces.reduce((s, p) => s + (p.vars.population || 0), 0);
  const turnoutPct = Math.round(totalVotes / (electorate || 1) * 1000) / 10;

  const nationalRows = parties.map(pt => ({
    partyId: pt.id,
    votes: Math.round(national[pt.id] || 0),
    pct: Math.round((national[pt.id] || 0) / totalVotes * 1000) / 10,
    seats: seatTotals[pt.id] || 0
  })).sort((a, b) => b.seats - a.seats || b.votes - a.votes);

  const rec = {
    id: el.id, ts: Date.now(), turn: db.settings.time.turn, simDate: db.settings.time.date,
    name: `General Election — ${db.settings.time.date}`, seats: totalSeats, turnout: turnoutPct,
    national: nationalRows,
    byProvince: Object.fromEntries(db.provinces.map(p => [p.id, {
      seats: (provResults[p.id] || { seats: {} }).seats || {},
      votes: Object.fromEntries(Object.entries(el.targets[p.id] || {}).map(([pid, v]) => [pid, Math.round(v)]))
    }])),
    live: true
  };
  db.elections.push(rec);
  if (db.elections.length > 60) db.elections.splice(0, db.elections.length - 60);

  const winner = parties.find(pt => pt.id === nationalRows[0].partyId);
  const nameOf = (pid) => { const e = db.entities.find(x => x.id === pid); return e ? (e.abbrev || e.name) : pid; };
  const lines = nationalRows.map(r => `${nameOf(r.partyId)} — ${r.pct}% · ${r.seats} seats`).join('\n');
  sim.draftNews(`${winner ? winner.name.toUpperCase() : 'PARLIAMENT'} ${nationalRows[0] && nationalRows[0].seats >= Math.ceil(totalSeats / 2) ? 'WINS MAJORITY' : 'LEADS HUNG PARLIAMENT'}`,
    `The Republic has voted. On a turnout of ${turnoutPct}%, the count of ${totalSeats} seats stands:\n\n${lines}\n\n` +
    `${winner && nationalRows[0].seats >= Math.ceil(totalSeats / 2) ? winner.name + ' commands a majority and will govern alone.' : 'No party commands a majority; coalition talks begin at once.'}`,
    'Politics', true, 'Election Commission');
  store.log('election', `The count is complete: ${winner ? winner.name : '—'} leads with ${nationalRows[0] ? nationalRows[0].seats : 0} seats`,
    `Turnout ${turnoutPct}% · ${fmtNum(totalVotes)} ballots`, actor || 'ENGINE', [rec.id]);
  db.election = null;
}

// ---------- GM levers ---------------------------------------------------------

// Add or remove votes from the live count (and the official totals it will
// converge to). provinceId null → spread over all provinces by target share.
function addVotes(el, partyId, provinceId, votes) {
  if (provinceId) {
    const t = el.targets[provinceId];
    const c = el.counted[provinceId];
    if (t && c) {
      t[partyId] = Math.max(0, (t[partyId] || 0) + votes);
      c[partyId] = Math.max(0, (c[partyId] || 0) + votes);
    }
  } else {
    const provs = Object.keys(el.targets);
    const total = provs.reduce((s, pid) => s + (el.targets[pid][partyId] || 0), 0) || 1;
    let left = votes;
    for (const pid of provs) {
      const add = Math.round(votes * (el.targets[pid][partyId] || 0) / total);
      const t = el.targets[pid];
      const c = el.counted[pid];
      t[partyId] = Math.max(0, (t[partyId] || 0) + add);
      c[partyId] = Math.max(0, (c[partyId] || 0) + add);
      left -= add;
    }
    if (left && provs.length) {
      const t = el.targets[provs[0]];
      const c = el.counted[provs[0]];
      t[partyId] = Math.max(0, (t[partyId] || 0) + left);
      c[partyId] = Math.max(0, (c[partyId] || 0) + left);
    }
  }
  updateProgress(el);
}

function adjustVotes(db, b, actor) {
  const el = db.election;
  if (!el || !el.active) throw new Error('No election is active.');
  if (el.phase !== 'voting') throw new Error('Votes exist only once the count is running.');
  const party = db.entities.find(e => e.id === b.partyId);
  if (!party || party.type !== 'party') throw new Error('Unknown party.');
  const votes = Math.round(Number(b.votes) || 0);
  if (!votes) throw new Error('Votes must be a non-zero number.');
  let provName = 'the nation';
  if (b.province && b.province !== 'all') {
    const prov = db.provinces.find(p => p.id === b.province);
    if (!prov) throw new Error('Unknown province.');
    if (!el.targets[b.province]) throw new Error('No ballots are tallied in that province.');
    provName = prov.name;
    addVotes(el, party.id, b.province, votes);
  } else {
    addVotes(el, party.id, null, votes);
  }
  el.log = el.log || [];
  el.log.push({ ts: Date.now(), turn: db.settings.time.turn, date: db.settings.time.date, kind: 'adjust',
    partyId: party.id, votes, province: (b.province && b.province !== 'all') ? b.province : null, actor: actor || 'GM' });
  if (el.log.length > LOG_CAP) el.log.splice(0, el.log.length - LOG_CAP);
  store.log('election', `Election Commission ${votes > 0 ? 'adds' : 'removes'} ${fmtNum(Math.abs(votes))} votes ${votes > 0 ? 'to' : 'from'} ${party.name} (${provName})`, '', actor || 'GM', [el.id, party.id]);
}

function cancel(db, actor) {
  const el = db.election;
  if (!el || !el.active) throw new Error('No election is active.');
  store.log('election', 'Election called off by the Election Commission',
    `${el.phase === 'campaign' ? 'Campaign' : 'Count'} suspended at ${db.settings.time.date}`,
    actor || 'GM', [el.id]);
  sim.draftNews('ELECTION CALLED OFF',
    'The Election Commission has suspended the election. Further notice will follow from the Commission.',
    'Politics', true, 'Election Commission');
  db.election = null;
}

// The GM Election tab saves the whole settings.election object.  Tunable
// knobs also apply to a live election.
function applyTuning(db, b) {
  const cfg = db.settings.election = db.settings.election || {};
  if (b.durationDays !== undefined) cfg.durationDays = Math.max(1, Math.min(365, Math.round(Number(b.durationDays) || 14)));
  if (b.durationTurns !== undefined) cfg.durationDays = Math.max(1, Math.min(365, Math.round(Number(b.durationTurns) || 14)));
  if (b.deviationPct !== undefined) cfg.deviationPct = clampPct(b.deviationPct);
  if (b.supportToVotes !== undefined) cfg.supportToVotes = Math.max(0, Math.round(Number(b.supportToVotes) || 0));
  if (b.moneySupportBase !== undefined) cfg.moneySupportBase = Math.max(1, Number(b.moneySupportBase) || DEFAULT_MONEY_SUPPORT_BASE);
  if (b.supportScale !== undefined) cfg.supportScale = Math.max(0.1, Number(b.supportScale) || DEFAULT_SUPPORT_SCALE);
  if (b.materialCampaignRate !== undefined) cfg.materialCampaignRate = Math.max(0, Number(b.materialCampaignRate) || DEFAULT_MATERIAL_CAMPAIGN_RATE);
  if (b.campaignDiminish !== undefined) cfg.campaignDiminish = Math.min(1, Math.max(0.01, Number(b.campaignDiminish) || DEFAULT_CAMPAIGN_DIMINISH));

  // Catalogue entries are fully GM-authored — clamp the numeric fields so a
  // typo can't mint infinite strength or a zero-day campaign.
  if (Array.isArray(b.campaigns)) {
    cfg.campaigns = b.campaigns.map(c => {
      const bonus = {};
      for (const pid in (c && c.bonusParties) || {}) {
        const v = Number(c.bonusParties[pid]);
        if (Number.isFinite(v) && v >= 0) bonus[pid] = v;
      }
      return {
        id: String((c && c.id) || 'camp_' + Math.random().toString(36).slice(2, 8)),
        name: String((c && c.name) || 'Campaign'),
        description: String((c && c.description) || ''),
        moneyCost: Math.max(0, Math.round(Number(c && c.moneyCost) || 0)),
        strength: Math.max(0, Number(c && c.strength) || 0),
        durationMinutes: Math.max(1, Math.min(1440, Math.round(Number(c && c.durationMinutes) || 5))),
        enabled: !(c && c.enabled === false),
        itemCosts: Array.isArray(c && c.itemCosts) ? c.itemCosts.filter(r => r && r.itemId)
          .map(r => ({ itemId: r.itemId, qty: Math.max(1, Math.round(Number(r.qty) || 1)),
            or: Array.isArray(r.or) ? r.or.filter(o => o && o.itemId).map(o => ({ itemId: o.itemId, qty: Math.max(1, Math.round(Number(o.qty) || 1)) })) : undefined }))
          : [],
        bonusParties: bonus
      };
    }).filter(c => c.name);
  }

  const el = db.election;
  if (!el || !el.active) return;
  el.durationDays = cfg.durationDays || 14;
  el.supportToVotes = cfg.supportToVotes;
  el.deviationPct = cfg.deviationPct;
  if (el.phase === 'voting' && el.baseTargets) {
    el.targets = deviationTargets(el, el.baseTargets, db.entities.filter(e => e.type === 'party'));
    updateProgress(el);
  }
}

// ---------- visibility --------------------------------------------------------

// The live election is a public spectacle, but the true per-party totals and
// the seeded LCG stay GM-only.
function forPlayers(el) {
  if (!el) return null;
  const out = { ...el };
  delete out.targets;
  delete out.baseTargets;
  delete out.rng;
  delete out.deviationPct;
  delete out.supportToVotes;
  return out;
}

module.exports = {
  startCampaign, startVoting, onTurn, tickCount, maybeTick,
  runCampaign, estimateCampaign, expireCampaigns,
  adjustVotes, cancel, applyTuning, forPlayers
};
