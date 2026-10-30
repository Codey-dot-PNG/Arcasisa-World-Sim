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
      const linear = (id, stops, attrs) => {
        const g = sv('linearGradient', Object.assign({ id, x1: 0, y1: 0, x2: 0, y2: 1 }, attrs || {}), defs);
        for (const [o, c, a] of stops) sv('stop', { offset: o, 'stop-color': c, 'stop-opacity': a }, g);
      };
      radial('mfxFlash', [['0%', '#ffffff', 1], ['25%', '#fffbe6', 0.9], ['55%', '#ffe9b0', 0.4], ['100%', '#ffd27a', 0]]);
      radial('mfxBall', [['0%', '#fffef2', 1], ['22%', '#fff1a8', 1], ['45%', '#ffb341', 0.97], ['70%', '#e2521c', 0.85], ['100%', '#7a1a0c', 0]]);
      radial('mfxScorch', [['0%', '#1c120c', 0.85], ['38%', '#2d1b10', 0.7], ['70%', '#4a2e18', 0.35], ['100%', '#4a2e18', 0]]);
      radial('mfxGlow', [['0%', '#ffd27a', 0.95], ['40%', '#ff8a2a', 0.55], ['100%', '#ff5a14', 0]]);
      radial('mfxSmoke', [['0%', '#5d5650', 0.75], ['55%', '#6f6862', 0.45], ['100%', '#7c756e', 0]]);
      radial('mfxSmokeLight', [['0%', '#b9b1a6', 0.8], ['55%', '#a39b91', 0.45], ['100%', '#8f877e', 0]]);
      radial('mfxCap', [['0%', '#ffcf7a', 0.95], ['30%', '#e88a3a', 0.9], ['62%', '#8a6a58', 0.85], ['100%', '#5c5450', 0]]);
      radial('mfxCloud', [['0%', '#ffffff', 0.85], ['60%', '#e8eef3', 0.55], ['100%', '#d5dee6', 0]]);
      radial('mfxToxic', [['0%', '#c7e04a', 0.7], ['55%', '#8fb52e', 0.42], ['100%', '#6d8f1c', 0]]);
      radial('mfxLava', [['0%', '#fff1a8', 1], ['45%', '#ff9a2a', 0.9], ['100%', '#d2380c', 0]]);
      radial('mfxWater', [['0%', '#4f8fc0', 0.55], ['70%', '#3f7fb2', 0.45], ['100%', '#3a76a8', 0.3]]);
      linear('mfxStem', [['0%', '#7d6f66', 0.9], ['70%', '#8a6a52', 0.92], ['100%', '#e2732c', 0.95]]);
      linear('mfxFlame', [['0%', '#fff4b0', 0.95], ['35%', '#ffc23a', 0.95], ['70%', '#f2621c', 0.85], ['100%', '#b8240e', 0.2]], { y1: 1, y2: 0 });
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

    /* nuclear strike: flash → fireball → shockwaves → mushroom cloud, then
       scorched ground under a slowly thinning cloud */
    _fx_nuke(g, r, rand) {
      sv('circle', { r: f1(r * 1.25), fill: 'url(#mfxScorch)', class: 'mfx-a mfx-fadein', style: '--d:.3s; --t:3s' }, g);
      sv('circle', { r: f1(r * 0.55), class: 'mfx-ring-scar mfx-a mfx-fadein', style: '--d:2s; --t:4s' }, g);
      sv('circle', { r: f1(r), class: 'mfx-ring-scar faint mfx-a mfx-fadein', style: '--d:2.5s; --t:4s' }, g);
      for (let i = 0; i < 16; i++) {
        const a = rand() * Math.PI * 2, d = r * (0.2 + rand() * 0.75);
        sv('circle', { cx: f1(Math.cos(a) * d), cy: f1(Math.sin(a) * d * 0.8), r: f1(r * (0.04 + rand() * 0.05)), fill: 'url(#mfxGlow)', class: 'mfx-a mfx-fadein', style: `--d:${(3 + rand() * 3).toFixed(1)}s; --t:2s` }, g);
      }
      sv('circle', { r: f1(r * 3.2), class: 'mfx-shock mfx-a', style: '--d:.05s; --t:4.5s' }, g);
      sv('circle', { r: f1(r * 2.4), class: 'mfx-shock thin mfx-a', style: '--d:.7s; --t:4s' }, g);
      sv('circle', { r: f1(r * 4), fill: 'url(#mfxFlash)', class: 'mfx-flashdisc mfx-a', style: '--d:0s; --t:1.8s' }, g);
      // the column and its cap rise together; the cloud then thins for a minute and a half
      const H = r * 1.9;
      const cloud = sv('g', { class: 'mfx-thin mfx-a', style: '--d:12s; --t:90s' }, g);
      sv('path', { d: `M${f1(-r * 0.15)} 0 C${f1(-r * 0.12)} ${f1(-H * 0.4)} ${f1(-r * 0.07)} ${f1(-H * 0.75)} ${f1(-r * 0.09)} ${f1(-H)} L${f1(r * 0.09)} ${f1(-H)} C${f1(r * 0.07)} ${f1(-H * 0.75)} ${f1(r * 0.12)} ${f1(-H * 0.4)} ${f1(r * 0.15)} 0 Z`,
        fill: 'url(#mfxStem)', class: 'mfx-stem mfx-a', style: '--d:.9s; --t:5s' }, cloud);
      // the cap climbs from the ground (outer group) while it swells about
      // its own centre (inner group)
      const cap = sv('g', { class: 'mfx-cap mfx-a', style: `--d:.6s; --t:7s; --rise:${f1(H)}px` }, cloud);
      const capAt = sv('g', { transform: `translate(0,${f1(-H)})` }, cap);
      const capG = sv('g', { class: 'mfx-capgrow mfx-a', style: '--d:.6s; --t:7s' }, capAt);
      sv('ellipse', { rx: f1(r * 0.95), ry: f1(r * 0.42), cy: f1(r * 0.08), fill: 'url(#mfxCap)' }, capG);
      for (let i = 0; i < 9; i++) {
        const a = Math.PI + (i / 8) * Math.PI, d = r * 0.55;
        sv('circle', { cx: f1(Math.cos(a) * d), cy: f1(Math.sin(a) * d * 0.55 - r * 0.05), r: f1(r * (0.3 + rand() * 0.12)), fill: i % 3 ? 'url(#mfxSmoke)' : 'url(#mfxCap)' }, capG);
      }
      sv('ellipse', { rx: f1(r * 0.6), ry: f1(r * 0.3), cy: f1(-r * 0.12), fill: 'url(#mfxSmokeLight)' }, capG);
      sv('ellipse', { cy: f1(-H * 0.55), rx: f1(r * 0.42), ry: f1(r * 0.1), class: 'mfx-condense mfx-a', style: '--d:2.2s; --t:14s' }, cloud);
      sv('circle', { r: f1(r * 0.5), fill: 'url(#mfxBall)', class: 'mfx-ball mfx-a', style: `--d:0s; --t:9s; --rise:${f1(H)}px` }, g);
    },
    _fx_explosion(g, r, rand) {
      sv('ellipse', { rx: f1(r * 0.75), ry: f1(r * 0.55), fill: 'url(#mfxScorch)', class: 'mfx-a mfx-fadein', style: '--d:.2s; --t:1.5s' }, g);
      sv('ellipse', { rx: f1(r * 0.36), ry: f1(r * 0.26), class: 'mfx-crater mfx-a mfx-fadein', style: '--d:.4s; --t:1s' }, g);
      sv('circle', { r: f1(r * 2.2), class: 'mfx-shock thin mfx-a', style: '--d:0s; --t:1.8s' }, g);
      for (let i = 0; i < 12; i++) {
        const a = rand() * Math.PI * 2, d = r * (0.9 + rand() * 1.1);
        sv('circle', { r: f1(r * (0.03 + rand() * 0.03)), class: 'mfx-debris mfx-a', style: `--d:${(rand() * 0.15).toFixed(2)}s; --t:1.3s; --dx:${f1(Math.cos(a) * d)}px; --dy:${f1(Math.sin(a) * d)}px` }, g);
      }
      sv('circle', { r: f1(r), fill: 'url(#mfxBall)', class: 'mfx-pop mfx-a', style: '--d:0s; --t:1.4s' }, g);
      // smouldering: wisps for about a minute, then still
      for (let i = 0; i < 4; i++) {
        sv('circle', { cx: f1((rand() - 0.5) * r * 0.5), r: f1(r * 0.32), fill: 'url(#mfxSmoke)', class: 'mfx-wisp mfx-a', style: `--d:${(1 + i * 1.6).toFixed(1)}s; --t:6.5s; --n:9; --rise:${f1(r * 1.6)}px; --drift:${f1(r * 0.5)}px` }, g);
      }
    },
    _fx_fire(g, r, rand) {
      sv('circle', { r: f1(r * 1.1), fill: 'url(#mfxScorch)', class: 'mfx-a mfx-fadein', style: '--d:0s; --t:20s' }, g);
      sv('ellipse', { rx: f1(r * 0.95), ry: f1(r * 0.75), fill: 'url(#mfxGlow)', class: 'mfx-pulse' }, g);
      const n = Math.max(6, Math.min(22, Math.round(r / 8)));
      const spots = [];
      for (let i = 0; i < n; i++) {
        const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * r * 0.78;
        spots.push([Math.cos(a) * d, Math.sin(a) * d * 0.75]);
      }
      spots.sort((p, q) => p[1] - q[1]); // far flames first
      for (const [x, y] of spots) {
        const h = r * (0.22 + rand() * 0.18), w = h * 0.34;
        const fg = sv('g', { transform: `translate(${f1(x)},${f1(y)})` }, g);
        sv('path', { d: `M${f1(-w)} 0 C${f1(-w)} ${f1(-h * 0.5)} ${f1(-w * 0.2)} ${f1(-h * 0.7)} 0 ${f1(-h)} C${f1(w * 0.2)} ${f1(-h * 0.7)} ${f1(w)} ${f1(-h * 0.5)} ${f1(w)} 0 Z`,
          fill: 'url(#mfxFlame)', class: 'mfx-flame', style: `animation-duration:${(0.8 + rand() * 0.8).toFixed(2)}s; animation-delay:${(-rand() * 2).toFixed(2)}s` }, fg);
      }
      for (let i = 0; i < 5; i++) {
        const [x, y] = spots[Math.floor(rand() * spots.length)];
        sv('circle', { cx: f1(x), cy: f1(y), r: f1(r * 0.3), fill: 'url(#mfxSmoke)', class: 'mfx-wisp loop', style: `--d:${(-i * 1.5).toFixed(1)}s; --t:7.5s; --rise:${f1(r * 2.4)}px; --drift:${f1(r * 0.9)}px` }, g);
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
      for (let i = 0; i < 6; i++) {
        sv('circle', { cx: f1((rand() - 0.5) * r * 0.1), cy: f1(top), r: f1(r * 0.28), fill: 'url(#mfxSmoke)', class: 'mfx-wisp loop', style: `--d:${(-i * 1.1).toFixed(1)}s; --t:6.6s; --rise:${f1(r * 2.6)}px; --drift:${f1(r * 0.7)}px` }, g);
      }
      for (let i = 0; i < 5; i++) {
        sv('circle', { cy: f1(top), r: f1(Math.max(2, r * 0.025)), class: 'mfx-bomb', style: `animation-delay:${(-rand() * 2.4).toFixed(2)}s; --dx:${f1((rand() - 0.5) * r * 1.1)}px; --h:${f1(r * (0.5 + rand() * 0.6))}px` }, g);
      }
    },
    _fx_toxic(g, r, rand) {
      sv('circle', { r: f1(r * 1.18), class: 'mfx-hazard' }, g);
      const cl = sv('g', { class: 'mfx-spread mfx-a', style: '--d:0s; --t:12s' }, g);
      const drift = sv('g', { class: 'mfx-breathe' }, cl);
      for (let i = 0; i < 7; i++) {
        const a = rand() * Math.PI * 2, d = rand() * r * 0.5;
        sv('circle', { cx: f1(Math.cos(a) * d), cy: f1(Math.sin(a) * d * 0.8), r: f1(r * (0.45 + rand() * 0.25)), fill: 'url(#mfxToxic)' }, drift);
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
