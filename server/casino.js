'use strict';
// Entertainment & gambling (Phase 12). All outcomes are decided HERE on the
// server — the client only animates toward the result it is told, so a player
// cannot rig a spin or peek the dealer's hole card (blackjack hands live in
// db.casinoHands, which filterState never ships to clients). Money settles
// through sim.txn: the player's primary account against the venue owner's, and
// the treasury takes the GM-set gambling tax on the house's net win.
const store = require('./store');
const sim = require('./sim');

function venues(db) { return ((db.settings.entertainment || {}).venues) || []; }
function venueById(db, id) { return venues(db).find(v => v.id === id) || null; }

// Settle a resolved round. playerDelta > 0: player won (house pays); < 0:
// player lost (house keeps, treasury skims the gambling tax). Returns the
// player's new balance for the client.
function settle(db, venue, entityId, playerDelta, memo, actor) {
  const playerAcct = sim.primaryAccount(entityId, true);
  const houseAcct = sim.primaryAccount(venue.ownerId, true);
  if (playerDelta > 0) {
    sim.txn(houseAcct.id, playerAcct.id, Math.round(playerDelta), memo + ' — winnings', actor, 'transfer');
  } else if (playerDelta < 0) {
    const loss = Math.round(-playerDelta);
    sim.txn(playerAcct.id, houseAcct.id, loss, memo + ' — stake', actor, 'transfer');
    const gr = ((db.settings.taxation || {}).gamblingRate) || 0;
    if (gr > 0) {
      const treasury = db.accounts.find(a => a.id === 'acct_treasury');
      const tax = Math.round(loss * gr / 100);
      if (treasury && tax > 0) sim.txn(houseAcct.id, treasury.id, tax, `Gambling duty (${gr}%) — ${venue.name}`, 'TREASURY', 'transfer');
    }
  }
  const fresh = db.accounts.find(a => a.id === playerAcct.id);
  return fresh ? fresh.balance : 0;
}

function requireFunds(db, entityId, amount) {
  const acct = sim.primaryAccount(entityId, false);
  if (!acct || acct.balance < amount) throw new Error('Insufficient funds for that stake.');
}

/* ---------- Roulette (single spin, server-authoritative) ---------- */
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
function playRoulette(db, venue, entityId, bets, actor) {
  const min = venue.minBet || 1, max = venue.maxBet || 1e9;
  const clean = (bets || []).map(b => ({ type: String(b.type), value: b.value, amount: Math.round(Number(b.amount) || 0) }))
    .filter(b => b.amount > 0);
  if (!clean.length) throw new Error('Place at least one bet.');
  const staked = clean.reduce((s, b) => s + b.amount, 0);
  for (const b of clean) if (b.amount < min || b.amount > max) throw new Error(`Each stake must be between ${min} and ${max}.`);
  requireFunds(db, entityId, staked);

  const greens = Math.max(1, Math.round((venue.roulette || {}).greenSlots || 1));
  const slots = 37 + (greens - 1);            // 0..36 plus extra greens (37, 38…) act as more zeros
  const n = Math.floor(Math.random() * slots);
  const isGreen = n === 0 || n > 36;
  const color = isGreen ? 'green' : (RED.has(n) ? 'red' : 'black');

  let returned = 0; // includes the stake on winning bets
  for (const b of clean) {
    let win = false, mult = 0;
    switch (b.type) {
      case 'straight': win = Number(b.value) === n; mult = 35; break;
      case 'red': win = color === 'red'; mult = 1; break;
      case 'black': win = color === 'black'; mult = 1; break;
      case 'odd': win = !isGreen && n % 2 === 1; mult = 1; break;
      case 'even': win = !isGreen && n % 2 === 0; mult = 1; break;
      case 'low': win = !isGreen && n >= 1 && n <= 18; mult = 1; break;
      case 'high': win = !isGreen && n >= 19 && n <= 36; mult = 1; break;
      case 'dozen': win = !isGreen && Math.ceil(n / 12) === Number(b.value); mult = 2; break;
      case 'column': win = !isGreen && (n % 3 === (Number(b.value) % 3)) && n !== 0; mult = 2; break;
      default: throw new Error('Unknown bet type: ' + b.type);
    }
    if (win) returned += b.amount * (mult + 1);
  }
  const playerDelta = returned - staked;
  const balance = settle(db, venue, entityId, playerDelta, `Roulette at ${venue.name}`, actor);
  return { number: n, color, staked, returned, playerDelta, balance };
}

/* ---------- Blackjack (stateful, server-authoritative) ---------- */
function freshShoe() {
  const shoe = [];
  for (let d = 0; d < 4; d++) for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) shoe.push({ r, s });
  for (let i = shoe.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shoe[i], shoe[j]] = [shoe[j], shoe[i]]; }
  return shoe;
}
function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) { const v = c.r === 1 ? 11 : Math.min(10, c.r); total += v; if (c.r === 1) aces++; }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
const isNatural = (cards) => cards.length === 2 && handValue(cards) === 21;

function publicHand(h, reveal) {
  return {
    bet: h.bet, done: h.done, outcome: h.outcome || null,
    player: h.player, playerValue: handValue(h.player),
    dealer: reveal ? h.dealer : [h.dealer[0]],
    dealerValue: reveal ? handValue(h.dealer) : handValue([h.dealer[0]]),
    doubled: !!h.doubled
  };
}

function bjDeal(db, venue, entityId, userId, bet, actor) {
  bet = Math.round(Number(bet) || 0);
  const min = venue.minBet || 1, max = venue.maxBet || 1e9;
  if (bet < min || bet > max) throw new Error(`Stake must be between ${min} and ${max}.`);
  requireFunds(db, entityId, bet);
  db.casinoHands = db.casinoHands || {};
  const shoe = freshShoe();
  const h = { venueId: venue.id, entityId, bet, shoe, player: [shoe.pop(), shoe.pop()], dealer: [shoe.pop(), shoe.pop()], done: false, doubled: false };
  db.casinoHands[userId] = h;
  // naturals resolve immediately
  const pN = isNatural(h.player), dN = isNatural(h.dealer);
  if (pN || dN) return bjResolve(db, venue, userId, actor);
  return { state: publicHand(h, false) };
}
function bjHit(db, venue, userId, actor) {
  const h = db.casinoHands && db.casinoHands[userId];
  if (!h || h.done) throw new Error('No hand in play.');
  h.player.push(h.shoe.pop());
  if (handValue(h.player) >= 21) return bjResolve(db, venue, userId, actor);
  return { state: publicHand(h, false) };
}
function bjDouble(db, venue, userId, actor) {
  const h = db.casinoHands && db.casinoHands[userId];
  if (!h || h.done || h.player.length !== 2) throw new Error('Can only double on the opening two cards.');
  requireFunds(db, h.entityId, h.bet); // the extra stake
  h.bet *= 2; h.doubled = true;
  h.player.push(h.shoe.pop());
  return bjResolve(db, venue, userId, actor);
}
function bjStand(db, venue, userId, actor) {
  const h = db.casinoHands && db.casinoHands[userId];
  if (!h || h.done) throw new Error('No hand in play.');
  return bjResolve(db, venue, userId, actor);
}
function bjResolve(db, venue, userId, actor) {
  const h = db.casinoHands[userId];
  const standOn = (venue.blackjack || {}).dealerStandsOn || 17;
  const bjPays = (venue.blackjack || {}).blackjackPays || 1.5;
  const pv = handValue(h.player);
  if (pv <= 21) { while (handValue(h.dealer) < standOn) h.dealer.push(h.shoe.pop()); }
  const dv = handValue(h.dealer);
  const pN = isNatural(h.player), dN = isNatural(h.dealer);

  let delta;
  if (pN && !dN) { delta = Math.round(h.bet * bjPays); h.outcome = 'blackjack'; }
  else if (pv > 21) { delta = -h.bet; h.outcome = 'bust'; }
  else if (dv > 21) { delta = h.bet; h.outcome = 'dealer_bust'; }
  else if (pv > dv) { delta = h.bet; h.outcome = 'win'; }
  else if (pv < dv) { delta = -h.bet; h.outcome = 'lose'; }
  else { delta = 0; h.outcome = 'push'; }

  h.done = true;
  const balance = settle(db, venue, h.entityId, delta, `Blackjack at ${venue.name}`, actor);
  const state = publicHand(h, true);
  delete h.shoe; delete db.casinoHands[userId]; // clear the round
  return { state, playerDelta: delta, balance };
}

/* ---------- Lottery ---------- */
function buyTicket(db, venue, entityId, userId, numbers, actor) {
  const pick = venue.pick || 3, maxN = venue.maxNumber || 40;
  const nums = (numbers || []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= maxN);
  const uniq = [...new Set(nums)];
  if (uniq.length !== pick) throw new Error(`Pick exactly ${pick} distinct numbers from 1 to ${maxN}.`);
  const price = venue.ticketPrice || 0;
  requireFunds(db, entityId, price);
  const houseAcct = sim.primaryAccount(venue.ownerId, true);
  const playerAcct = sim.primaryAccount(entityId, true);
  sim.txn(playerAcct.id, houseAcct.id, price, `Lottery ticket — ${venue.name}`, actor, 'transfer');
  venue.pot = (venue.pot || 0) + price;
  venue.tickets = venue.tickets || [];
  venue.tickets.push({ userId, entityId, numbers: uniq.sort((a, b) => a - b), turn: db.settings.time.turn });
  return { pot: venue.pot, ticket: uniq };
}
// Called each turn from advanceTurn. Draws any lottery venue whose interval is
// due, pays matching tickets from the pot, keeps the house cut for the owner.
function drawDueLotteries(db, actor) {
  for (const v of venues(db)) {
    if (v.kind !== 'lottery' || !v.enabled) continue;
    const every = Math.max(1, v.drawEveryTurns || 3);
    const turn = db.settings.time.turn;
    if (turn <= (v.lastDrawTurn || 0) || (turn % every) !== 0) continue;
    v.lastDrawTurn = turn;
    const pick = v.pick || 3, maxN = v.maxNumber || 40;
    const pool = []; for (let i = 1; i <= maxN; i++) pool.push(i);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const drawn = pool.slice(0, pick).sort((a, b) => a - b);
    const key = drawn.join(',');
    const winners = (v.tickets || []).filter(t => t.numbers.join(',') === key);
    const houseAcct = sim.primaryAccount(v.ownerId, true);
    const cut = Math.round((v.pot || 0) * (v.houseCutPct || 0) / 100);
    const jackpot = Math.max(0, (v.pot || 0) - cut);
    if (winners.length) {
      const share = Math.floor(jackpot / winners.length);
      for (const w of winners) {
        const acct = sim.primaryAccount(w.entityId, true);
        if (share > 0) sim.txn(houseAcct.id, acct.id, share, `Lottery win — ${v.name}`, actor, 'transfer');
      }
      store.log('economy', `${v.name}: drew ${key}`, `${winners.length} winner(s) share ${db.settings.currency}${jackpot}`, actor, [v.ownerId]);
      v.pot = v.jackpotSeed || 0;
    } else {
      store.log('economy', `${v.name}: drew ${key}`, `No winner — jackpot rolls over`, actor, [v.ownerId]);
      // no winner: house keeps its cut, jackpot rolls into next draw
      v.pot = jackpot + (v.jackpotSeed || 0);
    }
    v.lastResult = { turn, drawn, winners: winners.length, jackpot };
    v.tickets = [];
    sim.draftNews(`${v.name} draws ${key}`, winners.length ? `${winners.length} lucky ticket-holder(s) share a jackpot of ${db.settings.currency}${jackpot}.` : `No winning ticket this round — the jackpot rolls over.`, 'General', true, v.name);
  }
}

module.exports = { venues, venueById, playRoulette, bjDeal, bjHit, bjStand, bjDouble, buyTicket, drawDueLotteries };
