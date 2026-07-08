'use strict';
/* Phase 12 — Entertainment & gambling. Venue tabs (newspaper-style) across the
   top; each venue is a casino (roulette + blackjack) or a lottery. Every
   outcome is decided by the server (/api/casino/*) — this module only animates
   toward the result it is handed, so nothing here can be cheated by editing
   client state. Money settles server-side; balances refresh on the sync that
   follows each call. */
const Entertainment = {
  venue: null,      // active venue id
  game: 'roulette', // active game within a casino
  bets: [],         // roulette bet slip: {type, value, amount, label}
  stake: 100,       // current chip size
  spinning: false,

  venues() { return ((S().settings.entertainment || {}).venues || []).filter(v => v.enabled || isGM()); },
  active() { const vs = this.venues(); return vs.find(v => v.id === this.venue) || vs[0] || null; },

  myBalance() {
    const mine = ownershipSetClient();
    const acct = (S().accounts || []).find(a => a.ownerId === W.me.entityId) || (S().accounts || []).find(a => mine.has(a.ownerId));
    return acct ? acct.balance : null;
  },

  render(inner) {
    inner.appendChild(el('div.doc-title', 'Entertainment'));
    const vs = this.venues();
    if (!vs.length) { inner.appendChild(el('div.doc-sub', 'No venues are open. A Gamemaster can add casinos and lotteries in GM Studio.')); return; }
    if (!this.active()) this.venue = vs[0].id;
    const v = this.active();
    inner.appendChild(el('div.doc-sub', 'a flutter for the Republic · ' + (this.myBalance() !== null ? 'your balance ' + fmtMoney(this.myBalance()) : 'no account')));

    // venue switcher (like the newspaper mastheads)
    const switcher = el('div.venue-switcher');
    vs.forEach(x => switcher.appendChild(el('div.venue-tab', {
      class: (x.id === v.id ? 'active' : '') + (x.enabled ? '' : ' disabled'),
      onclick: () => { this.venue = x.id; this.game = (x.games || [])[0] || 'roulette'; this.bets = []; App.renderView(); }
    }, el('div.vt-name', x.name), el('div.vt-kind', x.kind === 'lottery' ? 'National Lottery' : 'Casino'))));
    inner.appendChild(switcher);

    inner.appendChild(el('div.venue-blurb', v.blurb || ''));

    // CEO / GM odds control
    if (isGM() || (W.me.entityId && ownership_controlsClient(W.me.entityId, v.ownerId))) {
      inner.appendChild(el('div.btn-row', { style: 'margin-bottom:12px;' },
        el('button.dash-btn', { onclick: () => this.oddsModal(v) }, '⚙ House Settings')));
    }

    if (v.kind === 'lottery') return this.renderLottery(inner, v);

    // casino: game tabs
    const games = v.games || [];
    const gbar = el('div.chip-row');
    if (!games.includes(this.game)) this.game = games[0];
    games.forEach(g => gbar.appendChild(el('button.chip', { class: this.game === g ? 'active' : '', onclick: () => { this.game = g; App.renderView(); } }, g === 'roulette' ? 'Roulette' : 'Blackjack')));
    inner.appendChild(gbar);

    if (this.game === 'roulette') this.renderRoulette(inner, v);
    else this.renderBlackjack(inner, v);
  },

  /* ═══════════ ROULETTE ═══════════ */
  WHEEL: [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26],
  RED: new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]),
  colorOf(n) { return n === 0 ? 'green' : (this.RED.has(n) ? 'red' : 'black'); },

  renderRoulette(inner, v) {
    const wrap = el('div.roulette');
    // wheel
    const wheelWrap = el('div.wheel-wrap',
      el('div.wheel-pointer', '▼'),
      this.buildWheel());
    this.wheelEl = wheelWrap.querySelector('.wheel');
    wrap.appendChild(wheelWrap);

    // result banner
    this.resultEl = el('div.roulette-result', '');
    wrap.appendChild(this.resultEl);

    // bet slip
    const slip = el('div.bet-slip');
    const stakeIn = el('input.text-input', { type: 'number', min: String(v.minBet || 1), value: this.stake, style: 'width:120px;', oninput: (e) => this.stake = Math.max(v.minBet || 1, Number(e.target.value) || 0) });
    slip.appendChild(el('div.bet-stake-row', el('label.field-label', 'Chip size (' + CUR() + ')'), stakeIn,
      el('span', { style: 'color:var(--ink-faint); font-size:11px;' }, `min ${fmtMoney(v.minBet || 1)} · max ${fmtMoney(v.maxBet || 0)}`)));

    // outside bets
    const outside = el('div.bet-outside');
    const addBet = (type, value, label) => this.addBet(type, value, label);
    [['red', null, 'RED'], ['black', null, 'BLACK'], ['odd', null, 'ODD'], ['even', null, 'EVEN'], ['low', null, '1–18'], ['high', null, '19–36'],
    ['dozen', 1, '1st 12'], ['dozen', 2, '2nd 12'], ['dozen', 3, '3rd 12']].forEach(([t, val, lab]) =>
      outside.appendChild(el('button', { class: 'bet-btn bet-' + t, onclick: () => addBet(t, val, lab) }, lab)));
    slip.appendChild(outside);

    // number grid (straight bets)
    const grid = el('div.bet-grid');
    grid.appendChild(el('button.bet-cell.bet-green', { onclick: () => addBet('straight', 0, '0') }, '0'));
    for (let n = 1; n <= 36; n++) grid.appendChild(el('button', { class: 'bet-cell ' + (this.RED.has(n) ? 'bet-red' : 'bet-black'), onclick: () => addBet('straight', n, String(n)) }, String(n)));
    slip.appendChild(grid);

    // current slip
    this.slipList = el('div.slip-list');
    this.renderSlip();
    slip.appendChild(this.slipList);

    slip.appendChild(el('div.btn-row', { style: 'margin-top:10px;' },
      el('button.solid-btn', { onclick: () => this.spin(v) }, '🎯 Spin'),
      el('button.dash-btn', { onclick: () => { this.bets = []; this.renderSlip(); } }, 'Clear bets')));
    wrap.appendChild(slip);
    inner.appendChild(wrap);
  },

  buildWheel() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 200 200'); svg.setAttribute('class', 'wheel');
    const cx = 100, cy = 100, r = 96, ri = 62;
    const n = this.WHEEL.length, step = 360 / n;
    this.WHEEL.forEach((num, i) => {
      const a0 = (i * step - 90 - step / 2) * Math.PI / 180;
      const a1 = ((i + 1) * step - 90 - step / 2) * Math.PI / 180;
      const p = (rad, ang) => `${cx + rad * Math.cos(ang)},${cy + rad * Math.sin(ang)}`;
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', `M ${p(ri, a0)} L ${p(r, a0)} A ${r} ${r} 0 0 1 ${p(r, a1)} L ${p(ri, a1)} A ${ri} ${ri} 0 0 0 ${p(ri, a0)} Z`);
      path.setAttribute('fill', this.colorOf(num) === 'green' ? '#2f7a44' : this.colorOf(num) === 'red' ? '#a3241c' : '#1c1c1c');
      path.setAttribute('stroke', '#d8caa8'); path.setAttribute('stroke-width', '0.5');
      svg.appendChild(path);
      const am = ((i + 0.5) * step - 90) * Math.PI / 180;
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', cx + (r - 9) * Math.cos(am)); t.setAttribute('y', cy + (r - 9) * Math.sin(am));
      t.setAttribute('fill', '#f5eede'); t.setAttribute('font-size', '7'); t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'central');
      t.setAttribute('transform', `rotate(${(i + 0.5) * step} ${cx + (r - 9) * Math.cos(am)} ${cy + (r - 9) * Math.sin(am)})`);
      t.textContent = String(num);
      svg.appendChild(t);
    });
    const hub = document.createElementNS(NS, 'circle');
    hub.setAttribute('cx', cx); hub.setAttribute('cy', cy); hub.setAttribute('r', ri - 2);
    hub.setAttribute('fill', '#5c3a1e'); hub.setAttribute('stroke', '#d8caa8');
    svg.appendChild(hub);
    return svg;
  },

  addBet(type, value, label) {
    if (!(this.stake > 0)) return toast('Set a chip size first.', true);
    this.bets.push({ type, value, amount: this.stake, label });
    this.renderSlip();
  },
  renderSlip() {
    if (!this.slipList) return;
    clear(this.slipList);
    if (!this.bets.length) { this.slipList.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'No bets on the table.')); return; }
    let total = 0;
    this.bets.forEach((b, i) => {
      total += b.amount;
      this.slipList.appendChild(el('div.slip-row',
        el('span', b.label), el('span', fmtMoney(b.amount)),
        el('button.icon-btn', { onclick: () => { this.bets.splice(i, 1); this.renderSlip(); } }, '✕')));
    });
    this.slipList.appendChild(el('div.slip-total', 'Total staked: ' + fmtMoney(total)));
  },

  async spin(v) {
    if (this.spinning) return;
    if (!this.bets.length) return toast('Place a bet first.', true);
    this.spinning = true;
    if (this.resultEl) this.resultEl.textContent = '';
    try {
      const r = await POST('/api/casino/roulette', { venueId: v.id, bets: this.bets.map(b => ({ type: b.type, value: b.value, amount: b.amount })) });
      await this.animateWheel(r.number);
      const c = r.color.toUpperCase();
      const net = r.playerDelta;
      this.resultEl.className = 'roulette-result ' + (net > 0 ? 'win' : net < 0 ? 'lose' : '');
      this.resultEl.textContent = `${r.number} ${c} — ${net > 0 ? 'You win ' + fmtMoney(net) : net < 0 ? 'You lose ' + fmtMoney(-net) : 'Push'}. Balance ${fmtMoney(r.balance)}`;
      this.bets = []; this.renderSlip();
    } catch (e) { toast(e.message, true); }
    finally { this.spinning = false; }
  },
  animateWheel(number) {
    return new Promise(resolve => {
      const idx = this.WHEEL.indexOf(number);
      const step = 360 / this.WHEEL.length;
      // land the winning slot under the top pointer, plus 5 full turns
      const target = 360 * 5 + (360 - idx * step);
      if (!this.wheelEl) return resolve();
      this.wheelEl.style.transition = 'none';
      this.wheelEl.style.transform = 'rotate(0deg)';
      // force reflow so the reset applies before the animated transform
      void this.wheelEl.getBoundingClientRect();
      this.wheelEl.style.transition = 'transform 3.4s cubic-bezier(.17,.67,.2,1)';
      this.wheelEl.style.transform = `rotate(${target}deg)`;
      setTimeout(resolve, 3500);
    });
  },

  /* ═══════════ BLACKJACK ═══════════ */
  bjState: null,
  renderBlackjack(inner, v) {
    const wrap = el('div.blackjack');
    const table = el('div.bj-table');
    this.bjDealerRow = el('div.bj-hand');
    this.bjPlayerRow = el('div.bj-hand');
    this.bjMsg = el('div.bj-msg', 'Place your bet and deal.');
    table.appendChild(el('div.bj-label', 'Dealer'));
    table.appendChild(this.bjDealerRow);
    table.appendChild(el('div.bj-label', 'You'));
    table.appendChild(this.bjPlayerRow);
    table.appendChild(this.bjMsg);
    wrap.appendChild(table);

    const bet = el('input.text-input', { type: 'number', min: String(v.minBet || 1), value: this.stake, style: 'width:120px;', oninput: (e) => this.stake = Math.max(v.minBet || 1, Number(e.target.value) || 0) });
    const controls = el('div.bj-controls');
    const inPlay = this.bjState && !this.bjState.done;
    if (!inPlay) {
      controls.appendChild(el('label.field-label', 'Bet (' + CUR() + ')'));
      controls.appendChild(bet);
      controls.appendChild(el('button.solid-btn', { onclick: () => this.bjAction(v, 'deal', Number(bet.value)) }, 'Deal'));
    } else {
      controls.appendChild(el('button.solid-btn', { onclick: () => this.bjAction(v, 'hit') }, 'Hit'));
      controls.appendChild(el('button.dash-btn', { onclick: () => this.bjAction(v, 'stand') }, 'Stand'));
      if (this.bjState.player.length === 2) controls.appendChild(el('button.outline-btn', { onclick: () => this.bjAction(v, 'double') }, 'Double'));
    }
    wrap.appendChild(controls);
    inner.appendChild(wrap);
    if (this.bjState) this.paintBlackjack();
  },
  card(c, hidden) {
    if (hidden) return el('div.card.back', '');
    const suits = ['♠', '♥', '♦', '♣'];
    const ranks = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
    const s = suits[c.s], red = c.s === 1 || c.s === 2;
    return el('div.card' + (red ? '.red' : ''), el('span.card-r', ranks[c.r] || String(c.r)), el('span.card-s', s));
  },
  paintBlackjack() {
    const st = this.bjState;
    clear(this.bjDealerRow); clear(this.bjPlayerRow);
    st.dealer.forEach((c, i) => this.bjDealerRow.appendChild(this.card(c, !st.done && i === 1 && c === null)));
    // dealer hole card comes as a real card only when revealed; while hidden the
    // server sends just the up-card, so pad with a face-down back
    if (!st.done && st.dealer.length === 1) this.bjDealerRow.appendChild(el('div.card.back', ''));
    st.player.forEach(c => this.bjPlayerRow.appendChild(this.card(c)));
    this.bjDealerRow.appendChild(el('div.hand-val', st.done ? String(st.dealerValue) : String(st.dealerValue) + ' +'));
    this.bjPlayerRow.appendChild(el('div.hand-val', String(st.playerValue)));
    if (st.done && st.outcome) {
      const map = { blackjack: ['BLACKJACK! ✦', 'win'], win: ['You win', 'win'], dealer_bust: ['Dealer busts — you win', 'win'], lose: ['Dealer wins', 'lose'], bust: ['Bust!', 'lose'], push: ['Push', ''] };
      const [txt, cls] = map[st.outcome] || ['', ''];
      this.bjMsg.className = 'bj-msg ' + cls;
      this.bjMsg.textContent = txt + (st.lastDelta !== undefined ? ` — balance ${fmtMoney(st.lastBalance)}` : '');
    } else { this.bjMsg.className = 'bj-msg'; this.bjMsg.textContent = 'Hit or stand?'; }
  },
  async bjAction(v, action, bet) {
    try {
      const r = await POST('/api/casino/blackjack', { venueId: v.id, action, bet });
      this.bjState = r.state;
      if (r.playerDelta !== undefined) { this.bjState.lastDelta = r.playerDelta; this.bjState.lastBalance = r.balance; }
      App.renderView(); // re-render controls; paintBlackjack runs after
    } catch (e) { toast(e.message, true); }
  },

  /* ═══════════ LOTTERY ═══════════ */
  lotto: [],
  renderLottery(inner, v) {
    const wrap = el('div.lottery');
    const next = (Math.floor(S().settings.time.turn / (v.drawEveryTurns || 3)) + 1) * (v.drawEveryTurns || 3);
    wrap.appendChild(el('div.lotto-head',
      el('div.lotto-pot', el('span', 'JACKPOT'), el('strong', fmtMoney(v.pot || 0))),
      el('div.lotto-meta',
        el('div', `Ticket ${fmtMoney(v.ticketPrice || 0)} · pick ${v.pick || 3} of ${v.maxNumber || 40}`),
        el('div', `Drawn every ${v.drawEveryTurns || 3} turns · next at turn ${next}`))));

    if (v.lastResult) {
      wrap.appendChild(el('div.lotto-last', 'Last draw (turn ' + v.lastResult.turn + '): ' +
        v.lastResult.drawn.join(' · ') + ' — ' + (v.lastResult.winners ? v.lastResult.winners + ' winner(s), ' + fmtMoney(v.lastResult.jackpot) : 'no winner, rolled over')));
    }

    // number picker
    if (!this.lotto) this.lotto = [];
    const grid = el('div.lotto-grid');
    for (let i = 1; i <= (v.maxNumber || 40); i++) {
      const on = this.lotto.includes(i);
      grid.appendChild(el('button', {
        class: 'lotto-num' + (on ? ' picked' : ''),
        onclick: () => {
          if (on) this.lotto = this.lotto.filter(x => x !== i);
          else { if (this.lotto.length >= (v.pick || 3)) return toast(`Pick only ${v.pick || 3} numbers.`, true); this.lotto.push(i); }
          App.renderView();
        }
      }, String(i)));
    }
    wrap.appendChild(grid);
    wrap.appendChild(el('div.btn-row', { style: 'margin-top:12px;' },
      el('button.solid-btn', {
        onclick: async () => {
          if (this.lotto.length !== (v.pick || 3)) return toast(`Pick exactly ${v.pick || 3} numbers.`, true);
          try { const r = await POST('/api/casino/lottery', { venueId: v.id, numbers: this.lotto }); toast('Ticket bought: ' + r.ticket.join(' · ') + '. Pot now ' + fmtMoney(r.pot)); this.lotto = []; }
          catch (e) { toast(e.message, true); }
        }
      }, '🎟 Buy Ticket (' + fmtMoney(v.ticketPrice || 0) + ')'),
      el('button.dash-btn', { onclick: () => { this.lotto = []; App.renderView(); } }, 'Clear')));
    inner.appendChild(wrap);
  },

  /* ═══════════ House settings (CEO / GM) ═══════════ */
  oddsModal(v) {
    const d = JSON.parse(JSON.stringify(v));
    const body = el('div');
    if (v.kind === 'lottery') {
      body.appendChild(el('label.field-label', 'Ticket price (' + CUR() + ')'));
      body.appendChild(el('input.text-input', { type: 'number', min: '1', value: d.ticketPrice, oninput: (e) => d.ticketPrice = Number(e.target.value) }));
      body.appendChild(el('label.field-label', 'House cut (%) — rest is the jackpot'));
      body.appendChild(el('input.text-input', { type: 'number', min: '0', max: '90', value: d.houseCutPct, oninput: (e) => d.houseCutPct = Number(e.target.value) }));
    } else {
      body.appendChild(el('label.field-label', 'Minimum bet (' + CUR() + ')'));
      body.appendChild(el('input.text-input', { type: 'number', min: '1', value: d.minBet, oninput: (e) => d.minBet = Number(e.target.value) }));
      body.appendChild(el('label.field-label', 'Maximum bet (' + CUR() + ')'));
      body.appendChild(el('input.text-input', { type: 'number', min: '1', value: d.maxBet, oninput: (e) => d.maxBet = Number(e.target.value) }));
      if ((v.games || []).includes('roulette')) {
        body.appendChild(el('label.field-label', 'Green (zero) slots — more favours the house'));
        body.appendChild(el('input.text-input', { type: 'number', min: '1', max: '6', value: (d.roulette || {}).greenSlots, oninput: (e) => { d.roulette = d.roulette || {}; d.roulette.greenSlots = Number(e.target.value); } }));
      }
      if ((v.games || []).includes('blackjack')) {
        body.appendChild(el('label.field-label', 'Blackjack payout (×) — 1.5 is standard 3:2'));
        body.appendChild(el('input.text-input', { type: 'number', min: '1', max: '3', step: '0.1', value: (d.blackjack || {}).blackjackPays, oninput: (e) => { d.blackjack = d.blackjack || {}; d.blackjack.blackjackPays = Number(e.target.value); } }));
        body.appendChild(el('label.field-label', 'Dealer stands on'));
        body.appendChild(el('input.text-input', { type: 'number', min: '15', max: '21', value: (d.blackjack || {}).dealerStandsOn, oninput: (e) => { d.blackjack = d.blackjack || {}; d.blackjack.dealerStandsOn = Number(e.target.value); } }));
      }
    }
    if (isGM()) body.appendChild(Forms.check(d, 'enabled', 'Venue open for business'));
    openModal('HOUSE SETTINGS — ' + v.name, body, [{
      label: 'Save', onClick: async () => {
        await PATCH('/api/casino/venue/' + v.id, d);
        toast('House settings saved.');
      }
    }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }]);
  }
};
window.Entertainment = Entertainment;
