'use strict';
/* Phase 33 — Live elections. A generic electoral engine on top of the
   simulated population (sim.computePolling): the GM calls an election
   (campaign season), then opens the polls. From then on each world turn
   counts one batch of ballots towards a pre-derived "true" result, so the
   Parliament page becomes a live count with all the drama of the real thing —
   early batches wobble, leaders overtake and fall behind, and the final batch
   lands exactly on the official total.

   The GM's levers:
   · settings.election.durationTurns — how long the count runs, in world
     turns (calibrated to the world time system: one batch per turn).
   · settings.election.deviationPct — how far the true result may depart from
     the polling shown on the Elections page (per-party share nudge, seeded).
   · settings.election.supportToVotes — what a campaign's support points are
     worth in late ballots while the count runs.
   · settings.election.campaigns[] — the campaign templates parties can buy
     (money + item costs, "or" alternatives per row), GM-editable/addable.
   · /api/gm/election/adjust — the Commission can add or remove votes
     mid-count; the count converges to whatever it amends.

   Every piece of transient state (targets, counted ballots, the seeded LCG
   state) lives ON the election doc, so the count rides turns without a
   process timer and is serverless-safe (docs/CONVENTIONS.md). The engine
   itself is generic — party/type lookups only, no Arcasia-specific data. */

const store = require('./store');
const sim = require('./sim');

const BATCH_NOISE = 0.6;   // per-batch wobble, as a fraction of a party's expected batch
const STEPS_CAP = 240;     // counting history rows (the count chart)
const LOG_CAP = 120;       // campaign / Commission log rows

const fmtNum = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fmtMoneyOf = (db, n) => `${db.settings.currency || '₳'}${fmtNum(n)}`;
const clampPct = (n) => Math.max(0, Math.min(50, Number(n) || 0));

// Deterministic single-word LCG: the count's wobble and the deviation draws
// derive from the doc's `rng` field, so any serverless instance resumes the
// count exactly where the last one left it. (Docs/CONVENTIONS: no module
// state that would desync across requests.)
function rand(el) {
  el.rng = ((el.rng || 1) * 1664525 + 1013904223) >>> 0;
  return el.rng / 4294967296;
}

// ---------- campaign templates / costs ------------------------------------

function partyAccount(db, party) {
  return db.accounts.find(a => a.ownerId === party.id);
}

function qtyOf(entity, itemId) {
  const r = (entity.inventory || []).find(x => x.itemId === itemId);
  return r ? r.qty : 0;
}

// An item-cost row may offer alternatives ("grain OR livestock"): the party
// pays whichever option it actually holds. All rows are required.
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

// Campaign support lands in party.support (moving the public polls, exactly
// like the GM's Support Shift tool) and accumulates in vars.campaignPoints so
// finalize()/cancel() can return the province baselines to pre-campaign levels.
function applySupport(db, party, strength) {
  party.support = party.support || {};
  for (const p of db.provinces) {
    party.support[p.id] = party.support[p.id] || {};
    party.support[p.id].all = Math.round(((party.support[p.id].all || 0) + strength) * 10) / 10;
  }
  party.vars = party.vars || {};
  party.vars.campaignPoints = Math.round(((party.vars.campaignPoints || 0) + strength) * 10) / 10;
}

function decayCampaignSupport(db, parties) {
  for (const pt of parties) {
    const pts = (pt.vars && pt.vars.campaignPoints) || 0;
    if (!pts) continue;
    for (const provId in (pt.support || {})) {
      const s = pt.support[provId];
      if (s && s.all !== undefined) s.all = Math.round((s.all - pts) * 10) / 10;
      if (!s || !s.all) delete pt.support[provId];
    }
    pt.vars.campaignPoints = 0;
  }
}

// ---------- the live election doc -----------------------------------------

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
  db.election = {
    id: store.uid('elec'), active: true, phase: 'campaign',
    calledTurn: t.turn, calledDate: t.date, calledAt: Date.now(),
    pollingAtCall: pollingSnapshot(db),
    durationTurns: Math.max(1, Math.round(Number(cfg.durationTurns) || 14)),
    deviationPct: clampPct(cfg.deviationPct),
    supportToVotes: Math.max(0, Math.round(Number(cfg.supportToVotes) || 2500)),
    rng: (Math.random() * 4294967296) >>> 0,
    steps: [], log: [], progress: 0, totalBallots: 0
  };
  sim.draftNews('ELECTION CALLED — CAMPAIGN SEASON OPENS',
    `The Republic goes to the country. Parliament is dissolved and the campaign trail opens; the Election Commission will announce polling day in due course. ` +
    `The party treasuries are open — expect rallies, pamphlets and promises between now and the count.`,
    'Politics', true, 'Election Commission');
  store.log('election', 'General election called — campaign season opens', `Polling at call: ${fmtNum(db.election.pollingAtCall[Object.keys(db.election.pollingAtCall)[0]] || 0)}% for the leading party`, actor || 'GM', [db.election.id]);
}

// The "true" per-province result the count will converge to: the simulated
// poll (with noise) nudged by the GM's deviation lever. Seeded draws only —
// recomputed identically whenever the GM changes the deviation mid-count.
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
      const nudge = 1 + (rand(el) * 2 - 1) * dev;   // ±deviation of each party's own share
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
  const { parties, byProvince, national, totalVotes } = sim.computePolling(true);
  el.baseTargets = byProvince;
  el.targets = deviationTargets(el, byProvince, parties);
  el.counted = {};
  for (const pid in el.targets) {
    const c = {};
    for (const pt of parties) c[pt.id] = 0;
    el.counted[pid] = c;
  }
  el.electorate = totalVotes;
  el.phase = 'voting';
  el.votingTurn = db.settings.time.turn;
  el.votingDate = db.settings.time.date;
  el.step = 0;
  el.steps = [];
  el.loggedPct = 0;
  updateProgress(el);
  sim.draftNews('POLLING STATIONS CLOSE — THE COUNT BEGINS',
    `Polls have closed across the Republic and the count is underway. The Election Commission will release the tally in batches over the coming days; ` +
    `${fmtNum(el.electorate)} ballots are expected in total.`,
    'Politics', true, 'Election Commission');
  store.log('election', 'Polling stations close — the count begins', `${fmtNum(el.electorate)} ballots to be counted over ${el.durationTurns} turns`, actor || 'GM', [el.id]);
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

// One counting step = one batch of ballots per province, wobbled around each
// party's expected share (so the lead can change hands) and renormalised to
// the batch total. The final step snaps the count exactly onto the official
// totals — every Commission amendment and late campaign ballot is absorbed.
function advanceCount(db, el, actor) {
  const parties = db.entities.filter(e => e.type === 'party');
  const duration = Math.max(1, el.durationTurns || 1);
  el.step = (el.step || 0) + 1;
  const isFinal = el.step >= duration;
  const batchSize = el.electorate / duration;
  for (const pid in el.targets) {
    const targets = el.targets[pid];
    const counted = el.counted[pid];
    if (isFinal) {
      for (const pt of parties) counted[pt.id] = Math.max(0, Math.round(targets[pt.id] || 0));
      continue;
    }
    const provTotal = Object.values(targets).reduce((s, v) => s + v, 0) || 1;
    // Each province contributes only its OWN share of the batch (provTotal /
    // electorate of the national batch) — counting a full national batch per
    // province would run the count at N× speed and mix provinces by equal
    // weight instead of by population, skewing the national tally.
    const provBatch = batchSize * provTotal / (nationalTargetsTotal(el) || 1);
    const raw = {};
    let sum = 0;
    for (const pt of parties) {
      const share = (targets[pt.id] || 0) / provTotal;
      const v = share * provBatch * (1 + (rand(el) * 2 - 1) * BATCH_NOISE);
      raw[pt.id] = Math.max(0, v);
      sum += raw[pt.id];
    }
    const scale = sum > 0 ? provBatch / sum : 1;
    for (const pt of parties) counted[pt.id] = (counted[pt.id] || 0) + raw[pt.id] * scale;
  }
  el.steps.push({ turn: db.settings.time.turn, date: db.settings.time.date, counted: nationalCounts(el) });
  if (el.steps.length > STEPS_CAP) el.steps.splice(0, el.steps.length - STEPS_CAP);
  updateProgress(el);
  const pct = Math.round(el.progress * 100);
  const pctTotal = Object.values(nationalCounts(el)).reduce((s, v) => s + v, 0);
  if (pct >= 25 && (el.loggedPct || 0) < 25) { el.loggedPct = 25; store.log('election', `The count passes a quarter — ${fmtNum(pctTotal)} ballots in`, '', actor || 'ENGINE', [el.id]); }
  else if (pct >= 50 && (el.loggedPct || 0) < 50) { el.loggedPct = 50; store.log('election', `The count passes the halfway mark — ${fmtNum(pctTotal)} ballots in`, '', actor || 'ENGINE', [el.id]); }
  else if (pct >= 75 && (el.loggedPct || 0) < 75) { el.loggedPct = 75; store.log('election', `The count passes three quarters — ${fmtNum(pctTotal)} ballots in`, '', actor || 'ENGINE', [el.id]); }
  if (isFinal) finalize(db, actor);
}

// Called from sim.advanceTurn once per turn while the count is live. The
// world-time calibration is deliberate: the GM's durationTurns setting is the
// count's length, not a wall-clock one.
function onTurn(db, actor) {
  const el = db.election;
  if (!el || !el.active || el.phase !== 'voting') return;
  advanceCount(db, el, actor);
}

// GM "count one batch now" — lets a GM pace the suspense without advancing
// the world clock.
function tickCount(db, actor) {
  const el = db.election;
  if (!el || !el.active) throw new Error('No election is active.');
  if (el.phase !== 'voting') throw new Error('The count has not started yet — open the polls first.');
  advanceCount(db, el, actor);
  return db.election;
}

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
  decayCampaignSupport(db, parties);
  const winner = parties.find(pt => pt.id === nationalRows[0].partyId);
  const nameOf = (pid) => { const e = db.entities.find(x => x.id === pid); return e ? (e.abbrev || e.name) : pid; };
  const lines = nationalRows.map(r => `${nameOf(r.partyId)} — ${r.pct}% · ${r.seats} seats`).join('\n');
  sim.draftNews(`${winner ? winner.name.toUpperCase() : 'PARLIAMENT'} ${nationalRows[0] && nationalRows[0].seats >= Math.ceil(totalSeats / 2) ? 'WINS MAJORITY' : 'LEADS HUNG PARLIAMENT'}`,
    `The Republic has voted. On a turnout of ${turnoutPct}%, the count of ${totalSeats} seats stands:\n\n${lines}\n\n` +
    `${winner && nationalRows[0].seats >= Math.ceil(totalSeats / 2) ? winner.name + ' commands a majority and will govern alone.' : 'No party commands a majority; coalition talks begin at once.'}`,
    'Politics', true, 'Election Commission');
  store.log('election', `The count is complete: ${winner ? winner.name : '—'} leads with ${nationalRows[0] ? nationalRows[0].seats : 0} seats`, `Turnout ${turnoutPct}% · ${fmtNum(totalVotes)} ballots`, actor || 'ENGINE', [rec.id]);
  db.election = null;
}

// ---------- player action: run a campaign ---------------------------------

function runCampaign(db, partyId, campaignId, actor) {
  const el = db.election;
  if (!el || !el.active) throw new Error('No election is active — campaigns run only during an election.');
  const party = db.entities.find(e => e.id === partyId);
  if (!party || party.type !== 'party') throw new Error('Unknown party.');
  const cfg = db.settings.election || {};
  const camp = (cfg.campaigns || []).find(c => c.id === campaignId);
  if (!camp) throw new Error('Unknown campaign.');
  if (camp.enabled === false) throw new Error('That campaign is not on offer.');
  const money = Math.max(0, Math.round(Number(camp.moneyCost) || 0));
  const acct = partyAccount(db, party);
  if (money > 0 && (!acct || acct.balance < money)) throw new Error(`${party.name}’s treasury cannot cover this campaign.`);
  const check = checkItemCosts(db, party, camp.itemCosts);
  if (!check.ok) throw new Error(`${party.name} lacks ${check.missing} — the campaign needs stock.`);
  if (money > 0) sim.txn(acct.id, null, money, 'Campaign: ' + camp.name, actor || party.name, 'withdraw');
  deductItemCosts(party, camp.itemCosts);
  const strength = Math.max(0, Number(camp.strength) || 0);
  if (strength > 0) applySupport(db, party, strength);
  let votes = 0;
  if (el.phase === 'voting') {
    const vpp = Math.max(0, Math.round(Number(el.supportToVotes) || 2500));
    votes = Math.round(strength * vpp);
    if (votes) addVotes(el, party.id, null, votes);
  }
  el.log = el.log || [];
  el.log.push({ ts: Date.now(), turn: db.settings.time.turn, date: db.settings.time.date, kind: 'campaign',
    partyId: party.id, campaignId: camp.id, campaignName: camp.name, money, strength, votes, actor: actor || '—' });
  if (el.log.length > LOG_CAP) el.log.splice(0, el.log.length - LOG_CAP);
  store.log('election', `Campaign: ${party.name} runs “${camp.name}”`,
    `${money ? fmtMoneyOf(db, money) + ' · ' : ''}${strength} support points${votes ? ' · ' + fmtNum(votes) + ' late votes' : ''}`, actor, [party.id]);
  sim.draftNews(`${party.abbrev || party.name} ${el.phase === 'voting' ? 'CAMPAIGNS INTO THE COUNT' : 'ON THE CAMPAIGN TRAIL'}`,
    `${party.name} has launched “${camp.name}” ${el.phase === 'voting' ? 'as the ballots are counted' : 'on the campaign trail'}, at a cost of ${money ? fmtMoneyOf(db, money) : 'no money'}${camp.itemCosts && camp.itemCosts.length ? ' plus party stock' : ''}.`,
    'Politics', false, 'Wire Service');
  return { money, strength, votes };
}

// ---------- GM levers -----------------------------------------------------

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
  decayCampaignSupport(db, db.entities.filter(e => e.type === 'party'));
  store.log('election', 'Election called off by the Election Commission', `${el.phase === 'campaign' ? 'Campaign' : 'Count'} suspended at ${db.settings.time.date}`, actor || 'GM', [el.id]);
  sim.draftNews('ELECTION CALLED OFF',
    'The Election Commission has suspended the election. Further notice will follow from the Commission.',
    'Politics', true, 'Election Commission');
  db.election = null;
}

// The GM Election tab saves the whole settings.election object; the tunable
// knobs also apply to a live election (a mid-count deviation change re-derives
// the unrevealed ballots — the ending moves, the revealed count stays).
function applyTuning(db, b) {
  const cfg = db.settings.election = db.settings.election || {};
  if (b.durationTurns !== undefined) cfg.durationTurns = Math.max(1, Math.min(365, Math.round(Number(b.durationTurns) || 1)));
  if (b.deviationPct !== undefined) cfg.deviationPct = clampPct(b.deviationPct);
  if (b.supportToVotes !== undefined) cfg.supportToVotes = Math.max(0, Math.round(Number(b.supportToVotes) || 0));
  const el = db.election;
  if (!el || !el.active) return;
  el.durationTurns = cfg.durationTurns;
  el.supportToVotes = cfg.supportToVotes;
  el.deviationPct = cfg.deviationPct;
  if (el.phase === 'voting' && el.baseTargets) {
    el.targets = deviationTargets(el, el.baseTargets, db.entities.filter(e => e.type === 'party'));
    updateProgress(el);
  }
}

// ---------- visibility -----------------------------------------------------

// The live election is a public spectacle (like the war room), but the true
// per-party totals and the seeded LCG stay GM-only — players watch the count,
// they don't read the ending.
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

module.exports = { startCampaign, startVoting, onTurn, tickCount, runCampaign, adjustVotes, cancel, applyTuning, forPlayers };