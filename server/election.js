'use strict';
/* Phase 34 — Real-time elections with province-by-province counting.
   Once the GM opens the polls the count runs on the world-time system:
   every turn advances the count continuously (no discrete "batches"),
   and provinces report one at a time in shuffled order for drama.

   Campaigns use free-form investment: a party inputs how much money and/or
   materials to spend, the engine returns a diminishing-returns estimate
   of support gained, and the party confirms.

   All transient state lives on the election doc (no module-level state),
   so the count is serverless-safe per docs/CONVENTIONS.md. The engine
   itself is generic — party/type lookups only. */

const store = require('./store');
const sim = require('./sim');

const COUNT_NOISE = 0.55;    // per-delta wobble fraction
const STEPS_CAP = 300;       // counting history rows
const LOG_CAP = 120;           // campaign / Commission log rows

// Campaign-investment constants (GM-overridable via settings.election).
// Curve: support = scale × √(value / base), calibrated so a full party
// war-chest (~₳10M + 3000 tons of grain) lands around +3 support.
const DEFAULT_MONEY_SUPPORT_BASE = 40000000;   // Koren per sqrt-unit
const DEFAULT_MATERIAL_CAMPAIGN_RATE = 200;   // Koren-equivalent per unit of material
const DEFAULT_SUPPORT_SCALE = 6;              // multiplier on sqrt

const fmtNum = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fmtMoneyOf = (db, n) => `${db.settings.currency || '₳'}${fmtNum(n)}`;
const clampPct = (n) => Math.max(0, Math.min(50, Number(n) || 0));

// Deterministic LCG (same as Phase 33 — seeded on the doc, so any
// serverless instance resumes exactly where the last one left off).
function rand(el) {
  el.rng = ((el.rng || 1) * 1664525 + 1013904223) >>> 0;
  return el.rng / 4294967296;
}

// ---------- helpers ----------------------------------------------------------

function partyAccount(db, party) {
  return db.accounts.find(a => a.ownerId === party.id);
}

function qtyOf(entity, itemId) {
  const r = (entity.inventory || []).find(x => x.itemId === itemId);
  return r ? r.qty : 0;
}

function materialValue(db, itemId) {
  const item = db.items.find(i => i.id === itemId);
  if (item && item.price) return item.price;
  const cfg = db.settings.election || {};
  return Number(cfg.materialCampaignRate) || DEFAULT_MATERIAL_CAMPAIGN_RATE;
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

// ---------- campaign-investment estimate & execution -------------------------

function estimateSupport(db, money, materials) {
  const cfg = db.settings.election || {};
  const base = Number(cfg.moneySupportBase) || DEFAULT_MONEY_SUPPORT_BASE;
  const scale = Number(cfg.supportScale) || DEFAULT_SUPPORT_SCALE;
  let totalValue = money;
  for (const m of (materials || [])) {
    if (!m.itemId || !m.qty || m.qty <= 0) continue;
    totalValue += m.qty * materialValue(db, m.itemId);
  }
  if (totalValue <= 0) return 0;
  return Math.round(Math.sqrt(totalValue / base) * scale * 10) / 10;
}

function investEstimate(db, partyId, money, materials) {
  const party = db.entities.find(e => e.id === partyId);
  if (!party || party.type !== 'party') throw new Error('Unknown party.');
  const support = estimateSupport(db, money, materials);
  let votes = 0;
  const el = db.election;
  if (el && el.active && el.phase === 'voting') {
    const vpp = Math.max(0, Math.round(Number(el.supportToVotes) || 2500));
    votes = Math.round(support * vpp);
  }
  return { support, votes };
}

function investCampaign(db, partyId, money, materials, actor) {
  const el = db.election;
  if (!el || !el.active) throw new Error('No election is active — campaigns run only during an election.');
  const party = db.entities.find(e => e.id === partyId);
  if (!party || party.type !== 'party') throw new Error('Unknown party.');

  money = Math.max(0, Math.round(Number(money) || 0));

  // Check money affordability
  if (money > 0) {
    const acct = partyAccount(db, party);
    if (!acct || acct.balance < money) throw new Error(`${party.name}'s treasury cannot cover this investment.`);
  }
  // Check material affordability
  for (const m of (materials || [])) {
    if (!m.itemId || !m.qty || m.qty <= 0) continue;
    const have = qtyOf(party, m.itemId);
    if (have < m.qty) {
      const it = db.items.find(i => i.id === m.itemId);
      throw new Error(`${party.name} lacks ${it ? it.name : m.itemId} — need ${m.qty}, have ${have}.`);
    }
  }

  // Deduct money
  if (money > 0) {
    sim.txn(partyAccount(db, party).id, null, money, 'Campaign investment', actor || party.name, 'withdraw');
  }
  // Deduct materials
  for (const m of (materials || [])) {
    if (!m.itemId || !m.qty || m.qty <= 0) continue;
    party.inventory = party.inventory || [];
    const row = party.inventory.find(r => r.itemId === m.itemId);
    if (row) {
      row.qty -= m.qty;
      if (row.qty <= 0) party.inventory = party.inventory.filter(r => r.qty > 0);
    }
  }

  // Apply support
  const support = estimateSupport(db, money, materials);
  if (support > 0) applySupport(db, party, support);

  // Late votes if count is running
  let votes = 0;
  if (el.phase === 'voting') {
    const vpp = Math.max(0, Math.round(Number(el.supportToVotes) || 2500));
    votes = Math.round(support * vpp);
    if (votes) addVotes(el, party.id, null, votes);
  }

  // Descriptions for the log
  const matDesc = (materials || []).filter(m => m.qty > 0).map(m => {
    const it = db.items.find(i => i.id === m.itemId);
    return `${it ? it.name : m.itemId} ×${m.qty}`;
  }).join(', ');

  el.log = el.log || [];
  el.log.push({ ts: Date.now(), turn: db.settings.time.turn, date: db.settings.time.date, kind: 'campaign',
    partyId: party.id, campaignName: 'Campaign Investment',
    money, materials: materials || [], strength: support, votes, materialDesc: matDesc,
    actor: actor || '—' });
  if (el.log.length > LOG_CAP) el.log.splice(0, el.log.length - LOG_CAP);

  store.log('election', `Campaign: ${party.name} invests ${fmtMoneyOf(db, money)}${matDesc ? ' + ' + matDesc : ''}`,
    `${support} support points${votes ? ' · ' + fmtNum(votes) + ' late votes' : ''}`,
    actor, [party.id]);

  sim.draftNews(`${party.abbrev || party.name} ${el.phase === 'voting' ? 'CAMPAIGNS INTO THE COUNT' : 'ON THE CAMPAIGN TRAIL'}`,
    `${party.name} has invested ${money ? fmtMoneyOf(db, money) : ''}${matDesc ? ' plus ' + matDesc : ''} ` +
    `${el.phase === 'voting' ? 'as the ballots are counted' : 'on the campaign trail'}, ` +
    `expected to gain ${support} support points.`,
    'Politics', false, 'Wire Service');

  return { money, strength: support, votes, materialDesc: matDesc };
}

// ---------- legacy campaign templates (kept for backward compat) --------------
// Old item-cost helpers used by runCampaign below.

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

function runCampaign(db, partyId, campaignId, actor) {
  const el = db.election;
  if (!el || !el.active) throw new Error('No election is active.');
  const party = db.entities.find(e => e.id === partyId);
  if (!party || party.type !== 'party') throw new Error('Unknown party.');
  const cfg = db.settings.election || {};
  const camp = (cfg.campaigns || []).find(c => c.id === campaignId);
  if (!camp) throw new Error('Unknown campaign.');
  if (camp.enabled === false) throw new Error('That campaign is not on offer.');
  const money = Math.max(0, Math.round(Number(camp.moneyCost) || 0));
  const acct = partyAccount(db, party);
  if (money > 0 && (!acct || acct.balance < money)) throw new Error(`${party.name}'s treasury cannot cover this campaign.`);
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
  store.log('election', `Campaign: ${party.name} runs "${camp.name}"`,
    `${money ? fmtMoneyOf(db, money) + ' · ' : ''}${strength} support points${votes ? ' · ' + fmtNum(votes) + ' late votes' : ''}`,
    actor, [party.id]);
  sim.draftNews(`${party.abbrev || party.name} ${el.phase === 'voting' ? 'CAMPAIGNS INTO THE COUNT' : 'ON THE CAMPAIGN TRAIL'}`,
    `${party.name} has launched "${camp.name}" ${el.phase === 'voting' ? 'as the ballots are counted' : 'on the campaign trail'}, at a cost of ${money ? fmtMoneyOf(db, money) : 'no money'}${camp.itemCosts && camp.itemCosts.length ? ' plus party stock' : ''}.`,
    'Politics', false, 'Wire Service');
  return { money, strength, votes };
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
    steps: [], log: [], progress: 0, totalBallots: 0
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
  el.votingTurn = db.settings.time.turn;
  el.votingDate = db.settings.time.date;
  el.startTurn = db.settings.time.turn;
  el._tickTurn = db.settings.time.turn;
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

// Advance the count: provinces report one at a time, each taking
// durationDays/numProvinces world days.  effectiveTurn is the turn to
// evaluate against (either the real world turn or the GM's manual tick).
function advanceRealtimeCount(db, el, effectiveTurn, actor) {
  const parties = db.entities.filter(e => e.type === 'party');
  const daysPerTurn = db.settings.time.perTurn || 1;
  const numProvs = el.provinceOrder.length;
  const daysPerProvince = el.durationDays / numProvs;
  const daysElapsed = (effectiveTurn - el.startTurn) * daysPerTurn;

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
    el._tickTurn = effectiveTurn;
    el.steps.push({
      turn: effectiveTurn, date: db.settings.time.date,
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

// Called from sim.advanceTurn once per turn while the count is live.
function onTurn(db, actor) {
  const el = db.election;
  if (!el || !el.active || el.phase !== 'voting') return;
  advanceRealtimeCount(db, el, db.settings.time.turn, actor);
}

// GM "advance one step" — advances the effective election turn by 1
// without changing the world clock.
function tickCount(db, actor) {
  const el = db.election;
  if (!el || !el.active) throw new Error('No election is active.');
  if (el.phase !== 'voting') throw new Error('The count has not started yet — open the polls first.');
  const nextTurn = Math.max(db.settings.time.turn, (el._tickTurn || db.settings.time.turn)) + 1;
  advanceRealtimeCount(db, el, nextTurn, actor);
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
  decayCampaignSupport(db, parties);

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
  decayCampaignSupport(db, db.entities.filter(e => e.type === 'party'));
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
  startCampaign, startVoting, onTurn, tickCount,
  runCampaign, investEstimate, investCampaign,
  adjustVotes, cancel, applyTuning, forPlayers
};
