'use strict';
/* Map effects — loaded after map-style.js and folded into GameMap.

   The GM can stage a disaster anywhere on the map: a NUCLEAR STRIKE, an
   EXPLOSION, a FIRE, a FLOOD, an EARTHQUAKE, a HURRICANE, a VOLCANIC
   ERUPTION or a TOXIC CLOUD. They are PURELY VISUAL and reversible — the
   server keeps a list (state.mapFx: {id, kind, pos, r, at, label}) that
   nothing in the simulation reads; remove one, or clear them all, and the
   map is as it was (POST /api/gm/mapfx, DELETE /api/gm/mapfx/:id,
   POST /api/gm/mapfx/clear).

   Every effect plays out from its own start time `at`: each animation's
   delay is offset by the effect's age (--age, negative), so a player who
   opens the map ten seconds after a detonation sees the mushroom cloud
   already climbing, and one who arrives an hour later sees the aftermath —
   scorched ground, the dissipating cloud — never a replay. Whoever is
   watching at the moment of a strike also gets the flash, the shake and the
   boom.

   PERFORMANCE: effects live in the transparent overlay svg (#war-overlay,
   under the war's own marks), never in the map svg, so their motion repaints
   only themselves. One-shot phases run once; the aftermath of a strike is
   static. Only ongoing disasters (fire, flood ripples, the hurricane's spin,
   the eruption's ash, the toxic cloud) keep moving, and nothing moves under
   prefers-reduced-motion. Nodes are keyed by effect id and kept across
   syncs, so an animation never restarts because the world changed. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const a in attrs) if (attrs[a] !== undefined && attrs[a] !== null) n.setAttribute(a, attrs[a]);
    if (parent) parent.appendChild(n);
    return n;
  };
  const f1 = (n) => (Math.round(n * 10) / 10).toString();

  const KINDS = {
    nuke: { icon: '☢', name: 'Nuclear strike', r: 110, blurb: 'flash, shockwave, mushroom cloud; scorched ground after' },
    explosion: { icon: '✹', name: 'Explosion', r: 40, blurb: 'fireball, debris and a smoking crater' },
    fire: { icon: '🔥', name: 'Fire', r: 70, blurb: 'a burning district under a smoke plume' },
    flood: { icon: '🌊', name: 'Flood', r: 150, blurb: 'water spreading over the land' },
    quake: { icon: '〰', name: 'Earthquake', r: 160, blurb: 'seismic waves, cracks and a shaking map' },
    storm: { icon: '🌀', name: 'Hurricane', r: 220, blurb: 'a turning cyclone with its eye' },
    eruption: { icon: '🌋', name: 'Volcanic eruption', r: 90, blurb: 'lava flows and an ash plume' },
    toxic: { icon: '☣', name: 'Toxic cloud', r: 110, blurb: 'a drifting chemical cloud' },
  };

  Object.assign(GameMap, {
    FX_KINDS: KINDS,

    /* ---------- the layer (overlay svg, keyed by effect id) ---------- */
    renderFx() {
      const host = this.overWorld;
      if (!host || !S()) return;
      let L = this.fxLayer;
      if (!L || L.parentNode !== host) {
        L = this.fxLayer = sv('g', { class: 'mfx-layer', 'pointer-events': 'none' });
        host.insertBefore(L, host.firstChild); // under the war's own marks
        this._fxNodes = new Map();
        this._fxDefs(L);
      }
      const list = S().mapFx || [];
      const seen = new Set();
      for (const fx of list) {
        if (!KINDS[fx.kind] || !Array.isArray(fx.pos)) continue;
        seen.add(fx.id);
        const key = [fx.kind, fx.r, fx.pos.join(','), fx.at, fx.label || ''].join('|');
        const old = this._fxNodes.get(fx.id);
        if (old && old.key === key) continue;
        if (old) old.node.remove();
        const node = this._fxBuild(fx);
        L.appendChild(node);
        this._fxNodes.set(fx.id, { node, key });
      }
      for (const [id, rec] of this._fxNodes) if (!seen.has(id)) { rec.node.remove(); this._fxNodes.delete(id); }
      if (W.fxPanel) this.renderFxPanel();
    },
    _fxDefs(L) {
      const defs = sv('defs', {}, L);
      const radial = (id, stops) => {
        const g = sv('radialGradient', { id }, defs);
        for (const [o, c, a] of stops) sv('stop', { offset: o, 'stop-color': c, 'stop-opacity': a }, g);
      };
      radial('mfxFlash', [['0%', '#ffffff', 1], ['25%', '#fffbe6', 0.9], ['55%', '#ffe9b0', 0.4], ['100%', '#ffd27a', 0]]);
      radial('mfxGlow', [['0%', '#ffd27a', 0.95], ['40%', '#ff8a2a', 0.55], ['100%', '#ff5a14', 0]]);
      radial('mfxCloud', [['0%', '#ffffff', 0.85], ['60%', '#e8eef3', 0.55], ['100%', '#d5dee6', 0]]);
      radial('mfxLava', [['0%', '#fff1a8', 1], ['45%', '#ff9a2a', 0.9], ['100%', '#d2380c', 0]]);
      radial('mfxWater', [['0%', '#4f8fc0', 0.55], ['70%', '#3f7fb2', 0.45], ['100%', '#3a76a8', 0.3]]);
    },

    /* ---------- one effect ---------- */
    _fxBuild(fx) {
      const r = Math.max(10, Number(fx.r) || 80);
      const age = Math.max(0, (Date.now() - Number(fx.at || 0)) / 1000);
      const g = sv('g', {
        class: 'mfx mfx-' + fx.kind, 'data-fx': fx.id,
        transform: `translate(${f1(fx.pos[0])},${f1(fx.pos[1])})`,
        style: `--age:${(-age).toFixed(2)}s; --r:${f1(r)}`,
      });
      const rand = this.seedRand('fx:' + fx.id);
      const build = this['_fx_' + fx.kind];
      if (build) build.call(this, g, r, rand);
      if (fx.label) {
        const t = sv('text', { y: f1(r * 1.32 + 12), 'text-anchor': 'middle', class: 'mfx-label', 'font-size': f1(Math.max(15, Math.min(48, r * 0.17))) }, g);
        t.textContent = fx.label;
      }
      if (age < 3) this._fxArrive(fx);
      return g;
    },
    // a strike seen live: the flash across the map, the shake, the boom
    _fxArrive(fx) {
      this._fxHeard = this._fxHeard || new Set();
      if (this._fxHeard.has(fx.id)) return;
      this._fxHeard.add(fx.id);
      const big = fx.kind === 'nuke', shake = big || fx.kind === 'quake' || fx.kind === 'eruption' || (fx.kind === 'explosion' && fx.r >= 60);
      const wrap = document.getElementById('map-wrap');
      if (wrap && (big || fx.kind === 'explosion')) {
        let x = '50%', y = '50%';
        try {
          const m = this.overWorld.getScreenCTM(), b = wrap.getBoundingClientRect();
          x = Math.round(m.a * fx.pos[0] + m.e - b.left) + 'px';
          y = Math.round(m.d * fx.pos[1] + m.f - b.top) + 'px';
        } catch (e) { /* off-screen: centre */ }
        const fl = el('div.mfx-flash' + (big ? '.big' : ''), { style: `--fx-x:${x}; --fx-y:${y}` });
        wrap.appendChild(fl);
        setTimeout(() => fl.remove(), big ? 2600 : 1100);
      }
      if (shake && this.svg) {
        const els = [this.svg, this.overSvg].filter(Boolean);
        for (const n of els) { n.classList.remove('mfx-shaking'); void n.getBoundingClientRect(); n.classList.add('mfx-shaking'); }
        setTimeout(() => els.forEach(n => n.classList.remove('mfx-shaking')), fx.kind === 'quake' ? 2400 : 1300);
      }
      try {
        if (typeof SFX !== 'undefined') {
          if (big) SFX.boom && SFX.boom(true);
          else if (fx.kind === 'explosion' || fx.kind === 'eruption') SFX.boom && SFX.boom(false);
          else if (fx.kind === 'quake') SFX.rumble && SFX.rumble();
        }
      } catch (e) { /* audio is optional */ }
    },

    /* ---------- organic sprites ----------
       Smoke, fire and scorched ground are never drawn as SVG primitives (they
       read as geometry). Each is BAKED once per session on a canvas from
       seeded fractal noise — a billowing puff lit from the upper left, a
       turbulent fireball, flame tongues licking upward, a mushroom cap and
       stem built from puffs and lit from beneath, burnt ground, a dust surge
       — and used as <image> sprites that only move, scale and fade (no
       filters in the overlay). Bakes run off the render path; until one
       lands its sprites simply have no picture yet. */
    _fxCv: {},
    _fxSpr: {},
    _fxSprite(name) {
      let rec = this._fxSpr[name];
      if (rec) return rec;
      rec = this._fxSpr[name] = { url: null, done: false };
      rec.p = new Promise((resolve) => setTimeout(() => {
        let cv = null;
        try { cv = this._fxCanvas(name); } catch (e) { cv = null; }
        if (!cv || !cv.toBlob) { rec.done = true; resolve(rec); return; }
        cv.toBlob((bl) => { rec.url = bl ? URL.createObjectURL(bl) : null; rec.done = true; resolve(rec); }, 'image/png');
      }, 0));
      return rec;
    },
    _fxCanvas(name) {
      if (!this._fxCv[name]) this._fxCv[name] = this._fxBake(name);
      return this._fxCv[name];
    },
    // seeded value-noise fBm in [0,1]
    _fxNoise(seed) {
      const H = (x, y) => { let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 982451653)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
      const n = (x, y) => {
        const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
        const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
        const a = H(xi, yi), b = H(xi + 1, yi), c = H(xi, yi + 1), d = H(xi + 1, yi + 1);
        return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
      };
      return (x, y, oct) => { let sum = 0, amp = 0.5, fr = 1, norm = 0; for (let o = 0; o < (oct || 4); o++) { sum += amp * n(x * fr, y * fr); norm += amp; amp *= 0.5; fr *= 2.03; } return sum / norm; };
    },
    _fxPixels(w, h, fn) {
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      const img = ctx.createImageData(w, h), d = img.data;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const c = fn(x, y);
        if (!c) continue;
        const i = (y * w + x) * 4;
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3];
      }
      ctx.putImageData(img, 0, 0);
      return cv;
    },
    _fxBake(name) {
      const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
      const sstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
      const ramp = (stops, t) => { // [[t, r,g,b], …] ascending
        if (t <= stops[0][0]) return stops[0].slice(1);
        for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
          const A = stops[i - 1], B = stops[i], k = (t - A[0]) / (B[0] - A[0]);
          return [A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k, A[3] + (B[3] - A[3]) * k];
        }
        return stops[stops.length - 1].slice(1);
      };
      const m = /^(smoke|dark|dust|ash|toxic)(\d)$/.exec(name);
      if (m) {
        // a billowing puff, lit from the upper left
        const base = { smoke: [138, 130, 121], dark: [74, 67, 61], dust: [196, 184, 160], ash: [92, 84, 78], toxic: [150, 178, 70] }[m[1]];
        const N = 192, c = N / 2, R = N * 0.4, nz = this._fxNoise(7 + Number(m[2]) * 31 + m[1].length * 101);
        return this._fxPixels(N, N, (x, y) => {
          const dx = (x - c) / R, dy = (y - c) / R, dd = Math.hypot(dx, dy);
          if (dd > 1.6) return null;
          const n1 = nz(x / N * 3.3, y / N * 3.3, 4), n2 = nz(x / N * 8 + 17, y / N * 8 + 5, 3);
          const edge = dd + (n1 - 0.5) * 0.9;
          const a = sstep(1.05, 0.55, edge) * clamp(0.62 + (n2 - 0.5) * 0.9, 0, 1);
          if (a <= 0.004) return null;
          const lit = clamp(0.78 - 0.3 * (dx * 0.55 + dy * 0.8) + (n1 - 0.5) * 0.55 + (n2 - 0.5) * 0.25, 0.32, 1.25);
          const hi = Math.max(0, lit - 1) * 0.9;
          return [clamp(base[0] * lit + 255 * hi, 0, 255), clamp(base[1] * lit + 255 * hi, 0, 255), clamp(base[2] * lit + 240 * hi, 0, 255), a * 235];
        });
      }
      if (name === 'fireball') {
        const N = 256, c = N / 2, R = N * 0.42, nz = this._fxNoise(91);
        const stops = [[0, 70, 18, 8], [0.18, 150, 34, 10], [0.36, 220, 82, 22], [0.55, 255, 150, 44], [0.74, 255, 214, 110], [1, 255, 250, 228]];
        return this._fxPixels(N, N, (x, y) => {
          const dx = (x - c) / R, dy = (y - c) / R, dd = Math.hypot(dx, dy);
          if (dd > 1.5) return null;
          const n1 = nz(x / N * 3, y / N * 3, 4), n2 = nz(x / N * 9 + 3, y / N * 9 + 9, 3);
          const edge = dd + (n1 - 0.5) * 0.7;
          const heat = clamp(1 - edge + (n2 - 0.5) * 0.45, 0, 1);
          const a = sstep(1.08, 0.7, edge);
          if (a <= 0.004) return null;
          const col = ramp(stops, heat);
          return [col[0], col[1], col[2], a * 255];
        });
      }
      const fm = /^flame(\d)$/.exec(name);
      if (fm) {
        // a tongue of flame: widest low down, licked sideways by turbulence
        const Wd = 96, Hd = 192, nz = this._fxNoise(300 + Number(fm[1]) * 17);
        const stops = [[0, 120, 20, 6], [0.2, 200, 52, 14], [0.42, 245, 112, 26], [0.62, 255, 172, 50], [0.82, 255, 222, 120], [1, 255, 248, 214]];
        return this._fxPixels(Wd, Hd, (x, y) => {
          const v = 1 - y / Hd, u = (x - Wd / 2) / (Wd / 2);
          const wob = (nz(u * 1.2 + 3, v * 3.2 + Number(fm[1]), 3) - 0.5) * 1.1 * Math.pow(v, 1.2);
          const uu = u - wob;
          const rr = v < 0.18 ? 0.8 * Math.sqrt(Math.max(0, v / 0.18)) : 0.8 * Math.pow(Math.max(0, (1 - v) / 0.82), 0.95);
          if (rr <= 0.01) return null;
          const inside = 1 - Math.abs(uu) / rr;
          if (inside <= 0) return null;
          const n2 = nz(x / Wd * 4 + 9, y / Hd * 6, 3);
          const heat = clamp(inside * 0.95 * (1 - v * 0.55) + (n2 - 0.5) * 0.35, 0, 1);
          const a = clamp(inside * 1.7, 0, 1) * Math.pow(clamp((1 - v) * 2.2, 0, 1), 0.6) * clamp(0.75 + (n2 - 0.5) * 0.8, 0, 1);
          if (a <= 0.004) return null;
          const col = ramp(stops, heat);
          return [col[0], col[1], col[2], a * 255];
        });
      }
      if (name === 'scorch') {
        const N = 384, c = N / 2, R = N * 0.44, nz = this._fxNoise(55);
        return this._fxPixels(N, N, (x, y) => {
          const dx = (x - c) / R, dy = (y - c) / R, dd = Math.hypot(dx, dy);
          if (dd > 1.5) return null;
          const n1 = nz(x / N * 4, y / N * 4, 4), n2 = nz(x / N * 14 + 2, y / N * 14 + 7, 3);
          const edge = dd + (n1 - 0.5) * 0.8;
          const a = sstep(1.05, 0.35, edge) * clamp(0.7 + (n2 - 0.5) * 0.8, 0, 1) * 0.9;
          if (a <= 0.004) return null;
          const ash = n2 > 0.68 ? (n2 - 0.68) * 2.6 : 0;
          return [clamp(30 + ash * 90 + n1 * 26, 0, 255), clamp(22 + ash * 84 + n1 * 18, 0, 255), clamp(16 + ash * 76 + n1 * 12, 0, 255), a * 255];
        });
      }
      if (name === 'surge' || name === 'shock') {
        // a ring of dust thrown out along the ground / the bright shock front
        const N = 384, c = N / 2, nz = this._fxNoise(name === 'surge' ? 77 : 78);
        const R0 = name === 'surge' ? 0.68 : 0.88, W0 = name === 'surge' ? 0.16 : 0.045;
        const col = name === 'surge' ? [200, 186, 160] : [255, 248, 226];
        return this._fxPixels(N, N, (x, y) => {
          const dx = (x - c) / (N / 2), dy = (y - c) / (N / 2), dd = Math.hypot(dx, dy);
          if (dd > 1) return null;
          const n1 = nz(x / N * 6, y / N * 6, 4);
          const k = (dd - R0 + (n1 - 0.5) * W0 * 1.6) / W0;
          const a = Math.exp(-k * k) * clamp(0.55 + (n1 - 0.5) * 1.1, 0, 1);
          if (a <= 0.004) return null;
          const lit = clamp(0.85 - 0.18 * (dx + dy) + (n1 - 0.5) * 0.4, 0.5, 1.15);
          return [clamp(col[0] * lit, 0, 255), clamp(col[1] * lit, 0, 255), clamp(col[2] * lit, 0, 255), a * 235];
        });
      }
      if (name === 'cap' || name === 'stem') {
        // built from baked puffs, then lit from beneath by the fire
        const cap = name === 'cap', Wd = cap ? 512 : 160, Hd = cap ? 300 : 512;
        const cv = document.createElement('canvas'); cv.width = Wd; cv.height = Hd;
        const ctx = cv.getContext('2d');
        const rnd = this.seedRand(name + ':puffs');
        const puff = (x, y, sz) => { const t = rnd(); const src = this._fxCanvas((t < 0.4 ? 'dark' : 'smoke') + Math.floor(rnd() * 3)); ctx.drawImage(src, x - sz / 2, y - sz / 2, sz, sz); };
        if (cap) {
          for (let i = 0; i < 46; i++) { const a = Math.PI + rnd() * Math.PI, rr = Math.sqrt(rnd()); puff(256 + Math.cos(a) * 190 * rr, 172 + Math.sin(a) * 120 * rr, 95 + rnd() * 90); }
          for (let i = 0; i < 12; i++) puff(66 + i * 34 + (rnd() - 0.5) * 14, 186 + (rnd() - 0.5) * 22, 90 + rnd() * 40); // the rolling skirt
          for (let i = 0; i < 10; i++) puff(150 + rnd() * 212, 100 + rnd() * 60, 110 + rnd() * 50);
        } else {
          // a column that billows: broad where it leaves the ground, waisted
          // through the middle, flaring into the cap
          for (let y = 470; y > 40; y -= 9) { const t = (470 - y) / 430, w = 104 - 34 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.85) + (t > 0.82 ? (t - 0.82) * 220 : 0); puff(80 + (rnd() - 0.5) * 16, y, w + rnd() * 24); }
        }
        ctx.globalCompositeOperation = 'source-atop';
        const glow = ctx.createLinearGradient(0, Hd, 0, cap ? Hd * 0.3 : Hd * 0.45);
        glow.addColorStop(0, 'rgba(255,128,40,.62)'); glow.addColorStop(0.45, 'rgba(255,160,70,.28)'); glow.addColorStop(1, 'rgba(255,170,90,0)');
        ctx.fillStyle = glow; ctx.fillRect(0, 0, Wd, Hd);
        if (cap) {
          const hi = ctx.createRadialGradient(Wd * 0.38, Hd * 0.2, 10, Wd * 0.38, Hd * 0.2, Wd * 0.45);
          hi.addColorStop(0, 'rgba(255,248,232,.32)'); hi.addColorStop(1, 'rgba(255,248,232,0)');
          ctx.fillStyle = hi; ctx.fillRect(0, 0, Wd, Hd);
        }
        return cv;
      }
      return null;
    },
    // one sprite, centred on (cx, cy) — or standing on it (anchor 'b') — in
    // its own group so its animations scale/turn about that point
    _spr(parent, name, cx, cy, w, h, cls, style, anchor) {
      const g = sv('g', { transform: `translate(${f1(cx)},${f1(cy)})` }, parent);
      const img = sv('image', { x: f1(-w / 2), y: f1(anchor === 'b' ? -h : -h / 2), width: f1(w), height: f1(h), preserveAspectRatio: 'none', class: cls || null, style: style || null }, g);
      const rec = this._fxSprite(name);
      const set = () => { if (rec.url) img.setAttribute('href', rec.url); };
      if (rec.done) set(); else rec.p.then(set);
      return img;
    },

    /* nuclear strike: flash → fireball → shock front and dust surge → the
       column climbs and the cap boils up; then burnt ground under a cloud
       that thins and drifts downwind */
    _fx_nuke(g, r, rand) {
      this._spr(g, 'scorch', 0, 0, r * 2.7, r * 2.2, 'mfx-a mfx-fadein', '--d:.4s; --t:4s');
      for (let i = 0; i < 18; i++) {
        const a = rand() * Math.PI * 2, d = r * (0.15 + rand() * 0.7);
        sv('circle', { cx: f1(Math.cos(a) * d), cy: f1(Math.sin(a) * d * 0.8), r: f1(r * (0.025 + rand() * 0.04)), fill: 'url(#mfxGlow)', class: 'mfx-a mfx-fadein', style: `--d:${(3 + rand() * 3).toFixed(1)}s; --t:2s` }, g);
      }
      // the dust surge rolls out along the ground and settles as a low haze
      this._spr(g, 'surge', 0, 0, r * 3.4, r * 2.6, 'mfx-surge mfx-a', '--d:.3s; --t:9s');
      this._spr(g, 'shock', 0, 0, r * 6.4, r * 5, 'mfx-shockwave mfx-a', '--d:.05s; --t:4.2s');
      sv('circle', { r: f1(r * 4), fill: 'url(#mfxFlash)', class: 'mfx-flashdisc mfx-a', style: '--d:0s; --t:1.8s' }, g);
      const H = r * 1.9;
      const cloud = sv('g', { class: 'mfx-thin mfx-a', style: `--d:14s; --t:120s; --wind:${f1(r * 0.6)}px` }, g);
      this._spr(cloud, 'stem', 0, 0, r * 0.8, H * 1.06, 'mfx-stem mfx-a', '--d:.8s; --t:5.5s', 'b');
      const cap = sv('g', { class: 'mfx-cap mfx-a', style: `--d:.6s; --t:7s; --rise:${f1(H)}px` }, cloud);
      const capAt = sv('g', { transform: `translate(0,${f1(-H)})` }, cap);
      this._spr(capAt, 'cap', 0, 0, r * 2.3, r * 1.35, 'mfx-capgrow mfx-a', '--d:.6s; --t:7s');
      // a condensation collar round the column, early on
      this._spr(cloud, 'dust1', 0, -H * 0.56, r * 1.1, r * 0.34, 'mfx-collar mfx-a', '--d:2.4s; --t:16s');
      this._spr(g, 'fireball', 0, 0, r * 1.15, r * 1.15, 'mfx-ball mfx-a', `--d:0s; --t:9s; --rise:${f1(H)}px`);
    },
    _fx_explosion(g, r, rand) {
      this._spr(g, 'scorch', 0, 0, r * 1.9, r * 1.45, 'mfx-a mfx-fadein', '--d:.2s; --t:1.5s');
      this._spr(g, 'surge', 0, 0, r * 2.6, r * 2, 'mfx-surge mfx-a', '--d:.05s; --t:4s');
      for (let i = 0; i < 12; i++) {
        const a = rand() * Math.PI * 2, d = r * (0.9 + rand() * 1.1);
        sv('circle', { r: f1(r * (0.025 + rand() * 0.03)), class: 'mfx-debris mfx-a', style: `--d:${(rand() * 0.15).toFixed(2)}s; --t:1.3s; --dx:${f1(Math.cos(a) * d)}px; --dy:${f1(Math.sin(a) * d)}px` }, g);
      }
      this._spr(g, 'fireball', 0, 0, r * 2, r * 2, 'mfx-pop mfx-a', '--d:0s; --t:1.6s');
      // smouldering: wisps for about a minute, then still
      for (let i = 0; i < 5; i++) {
        this._spr(g, (i % 2 ? 'dark' : 'smoke') + (i % 3), (rand() - 0.5) * r * 0.5, 0, r * 0.8, r * 0.8, 'mfx-wisp mfx-a', `--d:${(0.6 + i * 1.3).toFixed(1)}s; --t:6.5s; --n:9; --rise:${f1(r * 1.7)}px; --drift:${f1(r * 0.6)}px`);
      }
    },
    _fx_fire(g, r, rand) {
      this._spr(g, 'scorch', 0, 0, r * 2.5, r * 2, 'mfx-a mfx-fadein', '--d:0s; --t:20s');
      sv('ellipse', { rx: f1(r * 1.05), ry: f1(r * 0.8), fill: 'url(#mfxGlow)', class: 'mfx-pulse' }, g);
      // the burning bed the flames rise from
      this._spr(g, 'fireball', 0, r * 0.05, r * 1.7, r * 1.05, 'mfx-pulse', 'opacity:.55');
      const n = Math.max(10, Math.min(34, Math.round(r / 5)));
      const spots = [];
      for (let i = 0; i < n; i++) {
        const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * r * 0.78;
        spots.push([Math.cos(a) * d, Math.sin(a) * d * 0.72]);
      }
      // the smoke plume rides above and behind the fire, drifting downwind
      for (let i = 0; i < 7; i++) {
        const [x, y] = spots[Math.floor(rand() * spots.length)];
        this._spr(g, (i % 3 === 0 ? 'smoke' : 'dark') + (i % 3), x, y - r * 0.2, r * 0.9, r * 0.9, 'mfx-wisp loop', `--d:${(-i * 1.15).toFixed(2)}s; --t:8s; --rise:${f1(r * 2.6)}px; --drift:${f1(r * 1.1)}px`);
      }
      spots.sort((p, q) => p[1] - q[1]); // far flames first
      for (const [x, y] of spots) {
        const h = r * (0.3 + rand() * 0.38), w = h * (0.5 + rand() * 0.25);
        this._spr(g, 'flame' + Math.floor(rand() * 3), x, y, w, h, 'mfx-flame', `animation-duration:${(0.7 + rand() * 0.7).toFixed(2)}s; animation-delay:${(-rand() * 2).toFixed(2)}s`, 'b');
      }
      for (let i = 0; i < 8; i++) {
        const [x, y] = spots[Math.floor(rand() * spots.length)];
        sv('circle', { cx: f1(x), cy: f1(y - r * 0.2), r: f1(Math.max(1.5, r * 0.018)), class: 'mfx-ember', style: `animation-delay:${(-rand() * 3).toFixed(2)}s; --dx:${f1((rand() - 0.2) * r * 0.8)}px; --h:${f1(r * (0.8 + rand() * 0.9))}px` }, g);
      }
    },
    _fx_flood(g, r, rand) {
      const sp = sv('g', { class: 'mfx-spread mfx-a', style: '--d:0s; --t:10s' }, g);
      const blob = this.blobShape(rand, r);
      sv('path', { d: blob.d, fill: 'url(#mfxWater)', class: 'mfx-water' }, sp);
      const inner = this.blobShape(rand, r * 0.62);
      sv('path', { d: inner.d, class: 'mfx-water-deep', transform: `translate(${f1((rand() - 0.5) * r * 0.3)},${f1((rand() - 0.5) * r * 0.2)})` }, sp);
      for (let i = 0; i < 4; i++) {
        const a = rand() * Math.PI * 2, d = rand() * r * 0.55;
        sv('circle', { cx: f1(Math.cos(a) * d), cy: f1(Math.sin(a) * d), r: f1(r * 0.28), class: 'mfx-ripple', style: `animation-delay:${(-i * 1.1).toFixed(1)}s` }, sp);
      }
    },
    _fx_quake(g, r, rand) {
      for (const k of [0.33, 0.66, 1]) sv('circle', { r: f1(r * k), class: 'mfx-iso mfx-a mfx-fadein', style: `--d:${(1 + k * 2).toFixed(1)}s; --t:2s` }, g);
      for (let i = 0; i < 3; i++) sv('circle', { r: f1(r), class: 'mfx-seismic mfx-a', style: `--d:${i}s; --t:3s; --n:20` }, g);
      const cracks = sv('g', { class: 'mfx-jolt mfx-a', style: '--d:0s; --t:6s' }, g);
      const n = 6 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) {
        let a = (i / n) * Math.PI * 2 + rand() * 0.5, d = r * 0.06;
        let pts = [[Math.cos(a) * d, Math.sin(a) * d]];
        const len = r * (0.45 + rand() * 0.45);
        while (d < len) { d += r * (0.06 + rand() * 0.08); a += (rand() - 0.5) * 0.7; pts.push([Math.cos(a) * d, Math.sin(a) * d]); }
        sv('path', { d: 'M' + pts.map(p => f1(p[0]) + ' ' + f1(p[1])).join(' L'), pathLength: 1, class: 'mfx-crack mfx-a', style: `--d:${(rand() * 0.8).toFixed(2)}s; --t:2.4s; stroke-width:${f1(Math.max(1.5, r * 0.018))}` }, cracks);
      }
      sv('circle', { r: f1(Math.max(5, r * 0.05)), class: 'mfx-epi' }, cracks);
      sv('circle', { r: f1(Math.max(9, r * 0.1)), class: 'mfx-epi-ring' }, cracks);
    },
    _fx_storm(g, r, rand) {
      sv('circle', { r: f1(r * 1.12), fill: 'url(#mfxCloud)', class: 'mfx-haze' }, g);
      const spin = sv('g', { class: 'mfx-spin' }, g);
      for (let k = 0; k < 4; k++) {
        const a0 = k * Math.PI / 2 + rand() * 0.3, pts = [];
        for (let i = 0; i <= 28; i++) {
          const t = i / 28, rr = r * (1.02 - t * 0.9), a = a0 + t * Math.PI * 1.75;
          pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
        }
        const d = 'M' + pts.map(p => f1(p[0]) + ' ' + f1(p[1])).join(' L');
        sv('path', { d, class: 'mfx-arm', 'stroke-width': f1(r * 0.16) }, spin);
        sv('path', { d, class: 'mfx-rain', 'stroke-width': f1(r * 0.04) }, spin);
      }
      sv('circle', { r: f1(r * 0.1), class: 'mfx-eye' }, g);
    },
    _fx_eruption(g, r, rand) {
      sv('circle', { r: f1(r * 1.5), class: 'mfx-ashfall mfx-a mfx-fadein', style: '--d:2s; --t:20s' }, g);
      const top = -r * 0.42;
      sv('path', { d: `M${f1(-r * 0.62)} ${f1(r * 0.12)} Q${f1(-r * 0.3)} ${f1(top * 0.2)} ${f1(-r * 0.14)} ${f1(top)} L${f1(r * 0.14)} ${f1(top)} Q${f1(r * 0.3)} ${f1(top * 0.2)} ${f1(r * 0.62)} ${f1(r * 0.12)} Z`, class: 'mfx-cone' }, g);
      for (let k = 0; k < 3; k++) {
        let x = (k - 1) * r * 0.06, y = top, pts = [[x, y]];
        const dir = (k - 1) * 0.55 + (rand() - 0.5) * 0.3;
        for (let i = 0; i < 7; i++) { x += dir * r * 0.12 + (rand() - 0.5) * r * 0.06; y += r * 0.09; pts.push([x, y]); }
        const d = 'M' + pts.map(p => f1(p[0]) + ' ' + f1(p[1])).join(' L');
        sv('path', { d, class: 'mfx-lava-glow', 'stroke-width': f1(r * 0.13) }, g);
        sv('path', { d, pathLength: 1, class: 'mfx-lava mfx-a', 'stroke-width': f1(r * 0.045), style: `--d:${(0.4 + k * 0.5).toFixed(1)}s; --t:6s` }, g);
      }
      sv('ellipse', { cy: f1(top), rx: f1(r * 0.17), ry: f1(r * 0.06), fill: 'url(#mfxLava)', class: 'mfx-pulse' }, g);
      for (let i = 0; i < 7; i++) {
        this._spr(g, 'ash' + (i % 3), (rand() - 0.5) * r * 0.1, top, r * 0.75, r * 0.75, 'mfx-wisp loop', `--d:${(-i * 0.95).toFixed(2)}s; --t:6.6s; --rise:${f1(r * 2.6)}px; --drift:${f1(r * 0.8)}px`);
      }
      for (let i = 0; i < 5; i++) {
        sv('circle', { cy: f1(top), r: f1(Math.max(2, r * 0.025)), class: 'mfx-bomb', style: `animation-delay:${(-rand() * 2.4).toFixed(2)}s; --dx:${f1((rand() - 0.5) * r * 1.1)}px; --h:${f1(r * (0.5 + rand() * 0.6))}px` }, g);
      }
    },
    _fx_toxic(g, r, rand) {
      sv('circle', { r: f1(r * 1.18), class: 'mfx-hazard' }, g);
      const cl = sv('g', { class: 'mfx-spread mfx-a', style: '--d:0s; --t:12s' }, g);
      const drift = sv('g', { class: 'mfx-breathe' }, cl);
      for (let i = 0; i < 9; i++) {
        const a = rand() * Math.PI * 2, d = rand() * r * 0.55, sz = r * (0.9 + rand() * 0.5);
        this._spr(drift, 'toxic' + (i % 3), Math.cos(a) * d, Math.sin(a) * d * 0.8, sz, sz * 0.85, null, 'opacity:.8');
      }
    },

    /* ---------- the GM's panel ---------- */
    toggleFxPanel(on) {
      W.fxPanel = on === undefined ? !W.fxPanel : !!on;
      if (!W.fxPanel && W.placing && W.placing.fx) this.setPlacing(null);
      this.renderFxPanel();
      this.renderLayerBar();
    },
    renderFxPanel() {
      const wrap = document.getElementById('map-wrap');
      let p = document.getElementById('fx-panel');
      if (!wrap || !isGM() || !W.fxPanel) { if (p) p.remove(); return; }
      if (!p) { p = el('div#fx-panel'); wrap.appendChild(p); }
      clear(p);
      const kpp = Number(((S().settings || {}).map || {}).kmPerPx) || 2.17;
      if (!W.fxKind) W.fxKind = 'nuke';
      if (!W.fxSize) W.fxSize = KINDS[W.fxKind].r;
      p.appendChild(el('div.fx-head',
        el('div', el('div.fx-title', 'Disasters & effects'), el('div.fx-sub', 'Visual only — no one is harmed. Remove any time.')),
        el('button.icon-btn', { title: 'Close', onclick: () => this.toggleFxPanel(false) }, '✕')));
      const grid = el('div.fx-kinds');
      for (const k in KINDS) {
        const K = KINDS[k];
        grid.appendChild(el('button.fx-kind', {
          class: W.fxKind === k ? 'active' : '', title: K.blurb,
          onclick: () => { W.fxKind = k; W.fxSize = K.r; this.armFx(); }
        }, el('span.fx-icon', K.icon), el('span', K.name)));
      }
      p.appendChild(grid);
      const sizeOut = el('span.fx-size-out', '≈ ' + Math.round(W.fxSize * kpp).toLocaleString('en-US') + ' km radius');
      p.appendChild(el('div.fx-row',
        el('label.field-label', 'Size'),
        el('input', { type: 'range', min: '15', max: '600', step: '5', value: String(W.fxSize), style: 'flex:1;',
          oninput: (e) => { W.fxSize = Number(e.target.value); sizeOut.textContent = '≈ ' + Math.round(W.fxSize * kpp).toLocaleString('en-US') + ' km radius'; } }),
        sizeOut));
      const lbl = el('input.text-input', { placeholder: 'Caption on the map (optional)', value: W.fxLabel || '', maxlength: '60', oninput: (e) => { W.fxLabel = e.target.value; } });
      p.appendChild(lbl);
      const armed = W.placing && W.placing.fx;
      p.appendChild(el('button.solid-btn.fx-go', { onclick: () => (armed ? this.setPlacing(null) : this.armFx()) },
        armed ? '⌖ Click the map… (cancel)' : KINDS[W.fxKind].icon + '  Place ' + KINDS[W.fxKind].name.toLowerCase()));

      const list = (S().mapFx || []).slice().sort((a, b) => b.at - a.at);
      p.appendChild(el('div.fx-list-head', el('span', 'On the map (' + list.length + ')'),
        list.length ? el('button.dash-btn', { onclick: () => confirmModal('CLEAR ALL EFFECTS', 'Remove every effect from the map? The map returns to normal for everyone.', async () => {
          try { await POST('/api/gm/mapfx/clear', {}); toast('Map effects cleared.'); } catch (e) { toast(e.message, true); }
        }) }, 'Clear all') : null));
      if (!list.length) p.appendChild(el('div.fx-empty', 'Nothing staged. Pick an effect, set its size, then click the map.'));
      for (const fx of list) {
        const K = KINDS[fx.kind] || { icon: '•', name: fx.kind };
        p.appendChild(el('div.fx-item',
          el('span.fx-icon', K.icon),
          el('div.fx-item-body', { title: 'Show on the map', onclick: () => this.focus(fx.pos, Math.max(this.view.k, Math.min(4, 520 / Math.max(30, fx.r)))) },
            el('div', fx.label || K.name),
            el('div.fx-item-sub', [this._fxNear(fx.pos), this._fxAgo(fx.at), Math.round(fx.r * kpp) + ' km'].filter(Boolean).join(' · '))),
          el('button.icon-btn', { title: 'Remove — the map goes back to normal here', onclick: async () => {
            try { await DEL('/api/gm/mapfx/' + encodeURIComponent(fx.id)); } catch (e) { toast(e.message, true); }
          } }, '✕')));
      }
    },
    armFx() {
      const k = W.fxKind, K = KINDS[k];
      if (!K) return;
      this.setPlacing({ fx: true, label: K.name.toUpperCase(), cb: async (pos) => {
        try {
          await POST('/api/gm/mapfx', { kind: k, pos, r: W.fxSize || K.r, label: (W.fxLabel || '').trim() || undefined });
        } catch (e) { toast(e.message, true); }
        this.renderFxPanel();
      } });
      this.renderFxPanel();
    },
    _fxNear(pos) {
      let best = null, bd = Infinity;
      for (const c of (S().cities || [])) {
        if (!Array.isArray(c.pos)) continue;
        const d = Math.hypot(c.pos[0] - pos[0], c.pos[1] - pos[1]);
        if (d < bd) { bd = d; best = c; }
      }
      return best && bd < 400 ? 'near ' + best.name : '';
    },
    _fxAgo(at) {
      const s = Math.max(0, (Date.now() - Number(at || 0)) / 1000);
      return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago';
    },
  });
})();
