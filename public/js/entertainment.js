'use strict';
/* Phase 12 — Entertainment & gambling. Venue tabs (newspaper-style) across the
   top; each venue is a casino (roulette + blackjack) or a lottery. Every
   outcome is decided by the server (/api/casino/*) — this module only animates
   toward the result it is handed, so nothing here can be cheated by editing
   client state. Money settles server-side; balances refresh on the sync that
   follows each call. Sound effects come from the synthesised SFX engine
   (sfx.js) — no audio assets, everything works offline. */
const Entertainment = {
  venue: null,      // active venue id
  game: 'roulette', // active game within a casino
  bets: [],         // roulette bet slip: {type, value, amount, label}
  stake: 100,       // current chip size
  spinning: false,
  wheelAngle: 0,    // last landed wheel rotation — survives re-renders
  history: [],      // recent roulette results (client-side, this session)

  venues() { return ((S().settings.entertainment || {}).venues || []).filter(v => v.enabled || isGM()); },
  active() { const vs = this.venues(); return vs.find(v => v.id === this.venue) || vs[0] || null; },

  myBalance() {
    const mine = ownershipSetClient();
    const acct = (S().accounts || []).find(a => a.ownerId === W.me.entityId) || (S().accounts || []).find(a => mine.has(a.ownerId));
    return acct ? acct.balance : null;
  },

  render(inner) {
    const head = el('div.ent-head',
      el('div', el('div.doc-title', 'Entertainment'),
        el('div.doc-sub', 'a flutter for the Republic · ' + (this.myBalance() !== null ? 'your balance ' + fmtMoney(this.myBalance()) : 'no account'))),
      el('button.dash-btn.sfx-toggle', {
        title: 'Table sound effects on/off',
        onclick: (e) => { SFX.setEnabled(!SFX.enabled); if (SFX.enabled) SFX.chip(); e.currentTarget.textContent = SFX.enabled ? '♪ SFX ON' : '♪ SFX OFF'; }
      }, SFX.enabled ? '♪ SFX ON' : '♪ SFX OFF'));
    inner.appendChild(head);

    const vs = this.venues();
    if (!vs.length) { inner.appendChild(el('div.doc-sub', 'No venues are open. A Gamemaster can add casinos and lotteries in GM Studio.')); return; }
    if (!this.active()) this.venue = vs[0].id;
    const v = this.active();

    // venue switcher (like the newspaper mastheads)
    const switcher = el('div.venue-switcher');
    vs.forEach(x => switcher.appendChild(el('div.venue-tab', {
      class: (x.id === v.id ? 'active' : '') + (x.enabled ? '' : ' disabled'),
      onclick: () => { SFX.click(); this.venue = x.id; this.game = (x.games || [])[0] || 'roulette'; this.bets = []; App.renderView(); }
    }, el('div.vt-name', x.name), el('div.vt-kind', (x.kind === 'lottery' ? 'National Lottery' : 'Casino') + ' · house: ' + entName(x.ownerId)))));
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
    games.forEach(g => gbar.appendChild(el('button.chip', { class: this.game === g ? 'active' : '', onclick: () => { SFX.click(); this.game = g; App.renderView(); } }, g === 'roulette' ? 'Roulette' : 'Blackjack')));
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

    // ---- left: the wheel stage ----
    const stage = el('div.roulette-stage');
    const wheelWrap = el('div.wheel-wrap',
      this.buildWheel(),
      el('div.ball-layer', el('div.ball')),
      el('div.wheel-pointer'));
    this.wheelEl = wheelWrap.querySelector('.wheel');
    this.ballLayer = wheelWrap.querySelector('.ball-layer');
    this.ballEl = wheelWrap.querySelector('.ball');
    // restore the last landed orientation so a sync re-render doesn't snap
    // the wheel back to zero
    this.wheelEl.style.transform = `rotate(${this.wheelAngle || 0}deg)`;
    stage.appendChild(wheelWrap);

    // the sync that follows every spin re-renders this view — restore the
    // last result banner and leave the ball sitting in the winning pocket
    this.resultEl = el('div.roulette-result', '');
    if (this.lastResult) {
      this.resultEl.className = 'roulette-result ' + (this.lastResult.cls || '');
      this.resultEl.textContent = this.lastResult.text;
      this.ballEl.classList.add('settled');
    }
    stage.appendChild(this.resultEl);

    this.histEl = el('div.spin-history');
    stage.appendChild(this.histEl);
    this.renderHistory();
    wrap.appendChild(stage);

    // ---- right: the betting panel ----
    const panel = el('div.bet-panel');

    const stakeIn = el('input.text-input', { type: 'number', min: String(v.minBet || 1), value: this.stake, style: 'width:100px;', oninput: (e) => this.stake = Math.max(v.minBet || 1, Number(e.target.value) || 0) });
    const presets = el('div.chip-presets', [10, 50, 100, 500, 1000, 5000].map(amt =>
      el('button.chip-preset', { onclick: () => { SFX.click(); this.stake = amt; stakeIn.value = amt; } }, CUR() + fmtCompact(amt))));
    panel.appendChild(el('div.bet-stake-row', el('label.field-label', { style: 'margin:0;' }, 'Chip size (' + CUR() + ')'), stakeIn));
    panel.appendChild(presets);
    panel.appendChild(el('div.bet-limits', `table limits ${fmtMoney(v.minBet || 1)} – ${fmtMoney(v.maxBet || 0)} per bet`));

    // outside bets
    const outside = el('div.bet-outside');
    const addBet = (type, value, label) => this.addBet(type, value, label);
    [['red', null, 'RED'], ['black', null, 'BLACK'], ['odd', null, 'ODD'], ['even', null, 'EVEN'], ['low', null, '1–18'], ['high', null, '19–36'],
    ['dozen', 1, '1st 12'], ['dozen', 2, '2nd 12'], ['dozen', 3, '3rd 12']].forEach(([t, val, lab]) =>
      outside.appendChild(el('button', { class: 'bet-btn bet-' + t, onclick: () => addBet(t, val, lab) }, lab)));
    panel.appendChild(outside);

    // number table — classic 3×12 layout, zero on the left, 2:1 column bets
    // on the right (server bet type 'column': value 3 = top row, 2 = middle,
    // 1 = bottom, matching n % 3).
    const table = el('div.bet-table');
    this.gridCells = {};
    const zero = el('button.bet-cell.bet-green', { style: 'grid-row:1 / span 3; grid-column:1;', onclick: () => addBet('straight', 0, '0') }, '0');
    this.gridCells[0] = zero;
    table.appendChild(zero);
    for (let row = 0; row < 3; row++) {          // row 0 = top (3,6,…,36)
      for (let col = 0; col < 12; col++) {
        const n = (col + 1) * 3 - row;
        const cell = el('button', {
          class: 'bet-cell ' + (this.RED.has(n) ? 'bet-red' : 'bet-black'),
          style: `grid-row:${row + 1}; grid-column:${col + 2};`,
          onclick: () => addBet('straight', n, String(n))
        }, String(n));
        this.gridCells[n] = cell;
        table.appendChild(cell);
      }
      const colVal = 3 - row; // top row: n%3===0 → value 3, middle 2, bottom 1
      table.appendChild(el('button.bet-cell.bet-col', {
        style: `grid-row:${row + 1}; grid-column:14;`,
        onclick: () => addBet('column', colVal, `Col ${colVal} (2:1)`)
      }, '2:1'));
    }
    panel.appendChild(table);

    // current slip
    this.slipList = el('div.slip-list');
    this.renderSlip();
    panel.appendChild(this.slipList);

    this.spinBtn = el('button.solid-btn', { disabled: this.spinning, onclick: () => this.spin(v) }, '◉ Spin the wheel');
    panel.appendChild(el('div.btn-row', { style: 'margin-top:10px;' },
      this.spinBtn,
      el('button.dash-btn', { onclick: () => { SFX.click(); this.bets = []; this.renderSlip(); } }, 'Clear bets')));
    wrap.appendChild(panel);
    inner.appendChild(wrap);
  },

  buildWheel() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 240 240'); svg.setAttribute('class', 'wheel');
    const cx = 120, cy = 120;
    const rimOuter = 118, r = 108, ri = 72;
    const n = this.WHEEL.length, step = 360 / n;

    // wooden rim (the ball track lives on it)
    const rim = document.createElementNS(NS, 'circle');
    rim.setAttribute('cx', cx); rim.setAttribute('cy', cy); rim.setAttribute('r', (rimOuter + r) / 2);
    rim.setAttribute('fill', 'none'); rim.setAttribute('stroke', '#4a2c14'); rim.setAttribute('stroke-width', rimOuter - r);
    svg.appendChild(rim);

    this.WHEEL.forEach((num, i) => {
      const a0 = (i * step - 90 - step / 2) * Math.PI / 180;
      const a1 = ((i + 1) * step - 90 - step / 2) * Math.PI / 180;
      const p = (rad, ang) => `${cx + rad * Math.cos(ang)},${cy + rad * Math.sin(ang)}`;
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', `M ${p(ri, a0)} L ${p(r, a0)} A ${r} ${r} 0 0 1 ${p(r, a1)} L ${p(ri, a1)} A ${ri} ${ri} 0 0 0 ${p(ri, a0)} Z`);
      path.setAttribute('fill', this.colorOf(num) === 'green' ? '#2f7a44' : this.colorOf(num) === 'red' ? '#a3241c' : '#1c1c1c');
      path.setAttribute('stroke', '#d8caa8'); path.setAttribute('stroke-width', '0.6');
      svg.appendChild(path);
      // number labels sit in the OUTER half of the pocket, clear of the hub
      const am = ((i + 0.5) * step - 90) * Math.PI / 180;
      const tr = r - 11;
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', cx + tr * Math.cos(am)); t.setAttribute('y', cy + tr * Math.sin(am));
      t.setAttribute('fill', '#f5eede'); t.setAttribute('font-size', '10'); t.setAttribute('font-weight', '700');
      t.setAttribute('font-family', 'JetBrains Mono, monospace');
      t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'central');
      t.setAttribute('transform', `rotate(${(i + 0.5) * step} ${cx + tr * Math.cos(am)} ${cy + tr * Math.sin(am)})`);
      t.textContent = String(num);
      svg.appendChild(t);
    });

    // hub with cross-spokes and spindle
    const hub = document.createElementNS(NS, 'circle');
    hub.setAttribute('cx', cx); hub.setAttribute('cy', cy); hub.setAttribute('r', ri - 2);
    hub.setAttribute('fill', '#5c3a1e'); hub.setAttribute('stroke', '#d8caa8'); hub.setAttribute('stroke-width', '1');
    svg.appendChild(hub);
    for (let k = 0; k < 4; k++) {
      const ang = (k * 90 + 45) * Math.PI / 180;
      const spoke = document.createElementNS(NS, 'line');
      spoke.setAttribute('x1', cx + 10 * Math.cos(ang)); spoke.setAttribute('y1', cy + 10 * Math.sin(ang));
      spoke.setAttribute('x2', cx + (ri - 8) * Math.cos(ang)); spoke.setAttribute('y2', cy + (ri - 8) * Math.sin(ang));
      spoke.setAttribute('stroke', '#d8caa8'); spoke.setAttribute('stroke-width', '2.4'); spoke.setAttribute('stroke-linecap', 'round'); spoke.setAttribute('opacity', '0.75');
      svg.appendChild(spoke);
    }
    const spindle = document.createElementNS(NS, 'circle');
    spindle.setAttribute('cx', cx); spindle.setAttribute('cy', cy); spindle.setAttribute('r', 9);
    spindle.setAttribute('fill', '#d8caa8'); spindle.setAttribute('stroke', '#4a2c14'); spindle.setAttribute('stroke-width', '2');
    svg.appendChild(spindle);
    return svg;
  },

  addBet(type, value, label) {
    if (this.spinning) return;
    if (!(this.stake > 0)) return toast('Set a chip size first.', true);
    SFX.chip();
    // stacking the same bet grows the stake instead of adding a duplicate row
    const dup = this.bets.find(b => b.type === type && b.value === value);
    if (dup) dup.amount += this.stake;
    else this.bets.push({ type, value, amount: this.stake, label });
    this.renderSlip();
  },
  renderSlip() {
    if (!this.slipList) return;
    clear(this.slipList);
    if (!this.bets.length) { this.slipList.appendChild(el('div', { style: 'color:var(--ink-faint); font-size:12px;' }, 'No bets on the table — pick a colour, dozen or number.')); return; }
    let total = 0;
    this.bets.forEach((b, i) => {
      total += b.amount;
      this.slipList.appendChild(el('div.slip-row',
        el('span', b.label), el('span', fmtMoney(b.amount)),
        el('button.icon-btn', { onclick: () => { SFX.click(); this.bets.splice(i, 1); this.renderSlip(); } }, '✕')));
    });
    this.slipList.appendChild(el('div.slip-total', 'Total staked: ' + fmtMoney(total)));
    if (this.spinBtn) this.spinBtn.textContent = '◉ Spin — ' + fmtMoney(total) + ' on the table';
  },
  renderHistory() {
    if (!this.histEl) return;
    clear(this.histEl);
    if (!this.history.length) return;
    this.histEl.appendChild(el('span.sh-label', 'LAST SPINS'));
    this.history.slice(0, 12).forEach(n =>
      this.histEl.appendChild(el('span.sh-num', { class: 'sh-' + this.colorOf(n) }, String(n))));
  },

  async spin(v) {
    if (this.spinning) return;
    if (!this.bets.length) return toast('Place a bet first.', true);
    this.spinning = true;
    if (this.spinBtn) { this.spinBtn.disabled = true; this.spinBtn.textContent = '… no more bets'; }
    if (this.resultEl) { this.resultEl.className = 'roulette-result'; this.resultEl.textContent = 'No more bets — the wheel spins…'; }
    try {
      const r = await POST('/api/casino/roulette', { venueId: v.id, bets: this.bets.map(b => ({ type: b.type, value: b.value, amount: b.amount })) });
      await this.animateWheel(r.number);
      const c = r.color.toUpperCase();
      const net = r.playerDelta;
      const cls = net > 0 ? 'win' : net < 0 ? 'lose' : '';
      const text = `${r.number} ${c} — ${net > 0 ? 'You win ' + fmtMoney(net) : net < 0 ? 'You lose ' + fmtMoney(-net) : 'Push'}. Balance ${fmtMoney(r.balance)}`;
      this.lastResult = { text, cls };
      this.resultEl.className = 'roulette-result ' + cls;
      this.resultEl.textContent = text;
      if (net > 0) SFX.win(net >= r.staked * 5); else if (net < 0) SFX.lose(); else SFX.push();
      this.history.unshift(r.number);
      if (this.history.length > 20) this.history.length = 20;
      this.renderHistory();
      const hit = this.gridCells && this.gridCells[r.number];
      if (hit) { hit.classList.add('hit'); setTimeout(() => hit.classList.remove('hit'), 4200); }
      this.bets = []; this.renderSlip();
    } catch (e) { toast(e.message, true); if (this.resultEl) this.resultEl.textContent = ''; }
    finally {
      this.spinning = false;
      if (this.spinBtn) { this.spinBtn.disabled = false; this.spinBtn.textContent = '◉ Spin the wheel'; }
    }
  },

  // Read the live rotation angle (deg) of an element mid-transition.
  currentAngle(elm) {
    const tr = getComputedStyle(elm).transform;
    if (!tr || tr === 'none') return 0;
    const m = tr.match(/matrix\(([-\d.e]+),\s*([-\d.e]+)/);
    if (!m) return 0;
    return Math.atan2(Number(m[2]), Number(m[1])) * 180 / Math.PI;
  },

  /* The anticipation package: the wheel takes a long, hard-braking spin one
     way while the ball orbits the rim the other way, drops into the pockets
     near the end, and the pocket separators tick past the ball the whole
     time (ticks derived from the real animated angles, so they naturally
     slow with the wheel). */
  animateWheel(number) {
    return new Promise(resolve => {
      if (!this.wheelEl) return resolve();
      const idx = this.WHEEL.indexOf(number);
      const step = 360 / this.WHEEL.length;
      const WHEEL_MS = 6400, BALL_MS = 5600;

      // normalise the wheel's angle so consecutive spins never accumulate
      const from = ((this.wheelAngle || 0) % 360 + 360) % 360;
      this.wheelEl.style.transition = 'none';
      this.wheelEl.style.transform = `rotate(${from}deg)`;
      if (this.ballLayer) {
        this.ballLayer.style.transition = 'none';
        this.ballLayer.style.transform = 'rotate(0deg)';
        this.ballEl.classList.remove('drop', 'settled');
      }
      void this.wheelEl.getBoundingClientRect(); // commit the reset

      // land the winning pocket under the top pointer, plus 5 full turns
      const target = from + 360 * 5 + ((360 - idx * step) - from + 720) % 360;
      this.wheelEl.style.transition = `transform ${WHEEL_MS}ms cubic-bezier(.11,.72,.14,1)`;
      this.wheelEl.style.transform = `rotate(${target}deg)`;
      if (this.ballLayer) {
        // counter-rotation, whole turns only, so the ball finishes back at
        // the top — exactly where the winning pocket stops
        this.ballLayer.style.transition = `transform ${BALL_MS}ms cubic-bezier(.13,.68,.17,1)`;
        this.ballLayer.style.transform = `rotate(${-360 * 7}deg)`;
      }
      SFX.spinPush();

      // pocket ticks from the true relative angle of ball vs wheel
      let lastPocket = null, lastTick = 0;
      const tickLoop = (now) => {
        if (!this.spinning || !this.wheelEl || !this.wheelEl.isConnected) return;
        const rel = this.currentAngle(this.wheelEl) - (this.ballLayer ? this.currentAngle(this.ballLayer) : 0);
        const pocket = Math.floor((((rel % 360) + 360) % 360) / step);
        if (pocket !== lastPocket) {
          lastPocket = pocket;
          if (now - lastTick > 26) { SFX.tick(); lastTick = now; }
        }
        if (now < tickEnd) requestAnimationFrame(tickLoop);
      };
      const tickEnd = performance.now() + WHEEL_MS - 250;
      requestAnimationFrame(tickLoop);

      // ball drops off the rim into the pockets as everything slows
      setTimeout(() => {
        if (this.ballEl) this.ballEl.classList.add('drop');
        SFX.ballDrop();
      }, BALL_MS - 1150);

      setTimeout(() => {
        this.wheelAngle = target % 360;
        resolve();
      }, WHEEL_MS + 220);
    });
  },

  /* ═══════════ BLACKJACK ═══════════ */
  bjState: null,
  bjBusy: false,
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
    if (this.bjBusy) return;
    this.bjBusy = true;
    try {
      if (action === 'deal') SFX.chip();
      const prevCards = (this.bjState && !this.bjState.done)
        ? this.bjState.player.length + this.bjState.dealer.length : 0;
      const r = await POST('/api/casino/blackjack', { venueId: v.id, action, bet });
      this.bjState = r.state;
      if (r.playerDelta !== undefined) { this.bjState.lastDelta = r.playerDelta; this.bjState.lastBalance = r.balance; }
      // card swishes: one per newly visible card, softly staggered
      const nowCards = this.bjState.player.length + this.bjState.dealer.length;
      const dealt = Math.max(1, Math.min(4, nowCards - prevCards));
      for (let i = 0; i < dealt; i++) setTimeout(() => SFX.card(), i * 130);
      if (this.bjState.done && this.bjState.outcome) {
        const o = this.bjState.outcome;
        setTimeout(() => {
          if (o === 'blackjack') SFX.win(true);
          else if (o === 'win' || o === 'dealer_bust') SFX.win(false);
          else if (o === 'push') SFX.push();
          else SFX.lose();
        }, dealt * 130 + 150);
      }
      App.renderView(); // re-render controls; paintBlackjack runs after
    } catch (e) { toast(e.message, true); }
    finally { this.bjBusy = false; }
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
          SFX.pick();
          App.renderView();
        }
      }, String(i)));
    }
    wrap.appendChild(grid);
    wrap.appendChild(el('div.btn-row', { style: 'margin-top:12px;' },
      el('button.solid-btn', {
        onclick: async () => {
          if (this.lotto.length !== (v.pick || 3)) return toast(`Pick exactly ${v.pick || 3} numbers.`, true);
          try { const r = await POST('/api/casino/lottery', { venueId: v.id, numbers: this.lotto }); SFX.coin(); toast('Ticket bought: ' + r.ticket.join(' · ') + '. Pot now ' + fmtMoney(r.pot)); this.lotto = []; }
          catch (e) { toast(e.message, true); }
        }
      }, '🎟 Buy Ticket (' + fmtMoney(v.ticketPrice || 0) + ')'),
      el('button.dash-btn', { onclick: () => { SFX.click(); this.lotto = []; App.renderView(); } }, 'Clear')));
    inner.appendChild(wrap);
  },

  /* ═══════════ House settings (CEO / GM) ═══════════ */
  oddsModal(v) {
    const d = JSON.parse(JSON.stringify(v));
    const gm = isGM();
    const body = el('div');

    if (gm) {
      // GM-only: rename the house, rewrite the blurb, and hand the whole
      // venue to a different company — the new owner's account becomes the
      // house account (pays winnings, keeps losses) and the venue tab shows
      // the new proprietor.
      body.appendChild(el('label.field-label', 'Venue name'));
      body.appendChild(Forms.text(d, 'name'));
      body.appendChild(el('label.field-label', 'Blurb'));
      body.appendChild(Forms.text(d, 'blurb'));
      body.appendChild(el('label.field-label', 'Owned & operated by (the house account)'));
      body.appendChild(Forms.sel(d, 'ownerId', Forms.entOptions(['company', 'government', 'person', 'foreign'])));
    }

    if (v.kind === 'lottery') {
      body.appendChild(el('label.field-label', 'Ticket price (' + CUR() + ')'));
      body.appendChild(el('input.text-input', { type: 'number', min: '1', value: d.ticketPrice, oninput: (e) => d.ticketPrice = Number(e.target.value) }));
      body.appendChild(el('label.field-label', 'House cut (%) — rest is the jackpot'));
      body.appendChild(el('input.text-input', { type: 'number', min: '0', max: '90', value: d.houseCutPct, oninput: (e) => d.houseCutPct = Number(e.target.value) }));
      body.appendChild(el('label.field-label', 'Current jackpot (' + CUR() + ') — set it directly'));
      body.appendChild(el('input.text-input', { type: 'number', min: '0', value: d.pot || 0, oninput: (e) => d.pot = Number(e.target.value) }));
      body.appendChild(el('label.field-label', 'Jackpot seed (' + CUR() + ') — the pot floor after every draw'));
      body.appendChild(el('input.text-input', { type: 'number', min: '0', value: d.jackpotSeed || 0, oninput: (e) => d.jackpotSeed = Number(e.target.value) }));
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
    if (gm) body.appendChild(Forms.check(d, 'enabled', 'Venue open for business'));
    openModal('HOUSE SETTINGS — ' + v.name, body, [{
      label: 'Save', onClick: async () => {
        await PATCH('/api/casino/venue/' + v.id, d);
        toast('House settings saved.');
      }
    }, { label: 'Cancel', cls: 'dash-btn', onClick: () => { } }]);
  }
};
window.Entertainment = Entertainment;
