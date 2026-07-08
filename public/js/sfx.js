'use strict';
/* Tiny WebAudio sound-effects engine for the Entertainment module (and any
   other UI that wants a click). Everything is synthesised on the fly — no
   asset files, no network fetches, nothing to 404 — and the whole engine is
   inert until the first user gesture (browsers gate AudioContext on one).

   Volume rides the user's LOCAL music volume (Music.vol) so one slider rules
   all audio; a separate on/off toggle is persisted in localStorage. */
const SFX = {
  ctx: null,
  enabled: localStorage.getItem('arcasia-sfx') !== '0',

  ac() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!this.ctx) { try { this.ctx = new AC(); } catch (e) { return null; } }
    if (this.ctx.state === 'suspended') { try { this.ctx.resume(); } catch (e) {} }
    return this.ctx;
  },
  vol() {
    const base = (window.Music && typeof Music.vol === 'number') ? Music.vol : 0.7;
    return Math.max(0.05, Math.min(1, base));
  },
  setEnabled(on) {
    this.enabled = !!on;
    try { localStorage.setItem('arcasia-sfx', on ? '1' : '0'); } catch (e) {}
  },

  /* ---------- primitives ---------- */
  // One enveloped oscillator note.
  tone(freq, dur, opts) {
    if (!this.enabled) return;
    const ctx = this.ac(); if (!ctx) return;
    const o = opts || {};
    const t0 = ctx.currentTime + (o.delay || 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (o.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.slide), t0 + dur);
    const peak = (o.gain || 0.12) * this.vol();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + (o.attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  },
  // Enveloped filtered noise burst (clicks, swishes, thuds).
  noise(dur, opts) {
    if (!this.enabled) return;
    const ctx = this.ac(); if (!ctx) return;
    const o = opts || {};
    const t0 = ctx.currentTime + (o.delay || 0);
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = o.filter || 'bandpass';
    filt.frequency.setValueAtTime(o.freq || 2000, t0);
    if (o.sweep) filt.frequency.exponentialRampToValueAtTime(Math.max(40, o.sweep), t0 + dur);
    filt.Q.value = o.q || 1;
    const g = ctx.createGain();
    const peak = (o.gain || 0.1) * this.vol();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + (o.attack || 0.003));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt).connect(g).connect(ctx.destination);
    src.start(t0); src.stop(t0 + dur + 0.02);
  },

  /* ---------- vocabulary ---------- */
  click() { this.noise(0.03, { freq: 2600, q: 3, gain: 0.07 }); },                    // generic UI press
  chip() {                                                                            // chip lands on the felt
    this.noise(0.035, { freq: 1800, q: 4, gain: 0.1 });
    this.tone(1150, 0.05, { type: 'triangle', gain: 0.06, delay: 0.012 });
  },
  tick() { this.noise(0.018, { freq: 3400, q: 5, gain: 0.05 }); },                    // wheel pocket passing the pin
  spinPush() { this.noise(0.5, { filter: 'highpass', freq: 900, sweep: 2600, gain: 0.05, attack: 0.08 }); },
  ballDrop() {                                                                        // ball rattles into a pocket
    [0, 0.09, 0.17, 0.24].forEach((d, i) =>
      this.noise(0.03, { freq: 2800 - i * 380, q: 4, gain: 0.09 - i * 0.015, delay: d }));
  },
  card() { this.noise(0.07, { filter: 'bandpass', freq: 900, sweep: 2400, q: 0.8, gain: 0.09 }); }, // card swish
  win(big) {                                                                          // payout arpeggio (+ coins if big)
    const notes = big ? [523, 659, 784, 1047, 1319] : [523, 659, 784];
    notes.forEach((f, i) => this.tone(f, 0.22, { type: 'triangle', gain: 0.09, delay: i * 0.09 }));
    if (big) [0.5, 0.62, 0.76].forEach(d => this.tone(2093, 0.12, { type: 'sine', gain: 0.05, delay: d }));
  },
  lose() {
    this.tone(220, 0.3, { type: 'triangle', gain: 0.08, slide: 155 });
    this.tone(147, 0.35, { type: 'sine', gain: 0.07, delay: 0.16, slide: 110 });
  },
  push() { this.tone(440, 0.12, { type: 'sine', gain: 0.06 }); this.tone(440, 0.12, { type: 'sine', gain: 0.05, delay: 0.16 }); },
  coin() { this.tone(1568, 0.1, { type: 'square', gain: 0.035 }); this.tone(2093, 0.16, { type: 'square', gain: 0.03, delay: 0.07 }); },
  pick() { this.tone(880, 0.05, { type: 'triangle', gain: 0.05 }); },
  jackpot() {
    [523, 659, 784, 1047, 784, 1047, 1319, 1568].forEach((f, i) =>
      this.tone(f, 0.25, { type: 'triangle', gain: 0.09, delay: i * 0.11 }));
  }
};
window.SFX = SFX;
