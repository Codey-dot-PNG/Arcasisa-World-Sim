'use strict';
/* Boot, auth, navigation, shell orchestration. */

// Tracks the view renderAll last painted, so periodic-refresh re-renders can
// restore scroll positions while a real view switch (App.go) still lands at
// the top as expected.
let lastRenderedView = null;
let worldClockTimer = null;

// Content fingerprint over everything GameMap.render() draws from. A sync
// that leaves these byte-identical cannot change the map, so renderView may
// keep the existing SVG. W._localRev covers optimistic local mutations
// (which change state without a new server version); the war layer redraws
// itself through War.refreshLayer, so only war start/end matters here.
let lastMapFp = null;
function mapFingerprint() {
  const s = S();
  if (!s) return '';
  try {
    return [
      W.layer, W.dataVar, W._localRev || 0,
      (window.MapEdit && MapEdit.active) ? 1 : 0,
      s.war ? (s.war.active ? 'w1' : 'w0') : 'w-',
      JSON.stringify([s.provinces, s.cities, s.properties, s.markers,
        s.settings.map, s.settings.worldName, s.variables,
        s.settings.ambience,
        s.entities.map(e => [e.id, e.name, e.color])])
    ].join('|');
  } catch (e) { return 'nofp:' + Math.random(); } // can't fingerprint — always render
}

// The scrolling elements aren't #view itself (it's overflow:hidden — a pan/
// zoom surface for the map) but a child rebuilt from scratch on every render:
// .doc-view for the document-style views, .gm-main for GM Studio. Both are
// class-selected since they carry no id and are torn down/recreated each call.
function captureScroll() {
  const saved = {};
  const nodes = {
    'exp-body': document.getElementById('exp-body'),
    'insp-body': document.getElementById('insp-body'),
    'view-inner': document.querySelector('#view .doc-view, #view .gm-main')
  };
  for (const key in nodes) {
    const n = nodes[key];
    if (n && (n.scrollTop || n.scrollLeft)) {
      saved[key] = { top: n.scrollTop, left: n.scrollLeft, cls: n.classList.contains('doc-view') ? '.doc-view' : '.gm-main' };
    }
  }
  return saved;
}
function restoreScroll(saved) {
  for (const key in saved) {
    const n = key === 'view-inner' ? document.querySelector('#view ' + saved[key].cls) : document.getElementById(key);
    if (n) { n.scrollTop = saved[key].top; n.scrollLeft = saved[key].left; }
  }
}

const App = {
  PAGES: [
    ['map', 'World Map'], ['parliament', 'Parliament'], ['companies', 'Companies'],
    ['economy', 'Economy'], ['population', 'Population'], ['news', 'News'],
    ['entertainment', 'Entertainment'], ['war', 'War Room'], ['timeline', 'Timeline'], ['gm', 'GM Studio']
  ],

  async boot() {
    // palette
    const mood = localStorage.getItem('arcasia-mood') || 'paper';
    const daynight = localStorage.getItem('arcasia-daynight') === '1';
    if (mood !== 'paper') document.body.setAttribute('data-mood', mood);
    document.body.dataset.daynight = daynight ? 'on' : 'off';
    document.querySelectorAll('.swatch').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mood === 'daynight' ? daynight : mood === btn.dataset.mood);
      btn.addEventListener('click', () => {
        if (btn.dataset.mood === 'daynight') {
          const on = document.body.dataset.daynight !== 'on';
          document.body.dataset.daynight = on ? 'on' : 'off';
          localStorage.setItem('arcasia-daynight', on ? '1' : '0');
          btn.classList.toggle('active', on);
          this.renderWorldClock();
          return;
        }
        document.querySelectorAll('.swatch:not([data-mood=\"daynight\"])').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (btn.dataset.mood === 'paper') document.body.removeAttribute('data-mood');
        else document.body.setAttribute('data-mood', btn.dataset.mood);
        localStorage.setItem('arcasia-mood', btn.dataset.mood);
      });
    });

    this.bindShell();
    try {
      await refreshState(true); // first paint must never be skipped by the v-unchanged fast path
      this.enter();
    } catch (e) {
      document.getElementById('login-screen').classList.remove('hidden');
    }
  },

  bindShell() {
    // login / register
    let registering = false;
    const form = document.getElementById('login-form');
    const errBox = document.getElementById('login-error');
    document.getElementById('register-toggle').addEventListener('click', () => {
      registering = !registering;
      document.getElementById('register-fields').classList.toggle('hidden', !registering);
      document.getElementById('login-submit').textContent = registering ? 'Register & Enter' : 'Authenticate';
      document.getElementById('register-toggle').textContent = registering ? 'Back to sign-in' : 'Request citizenship';
      errBox.textContent = '';
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.textContent = '';
      const username = document.getElementById('login-user').value.trim();
      const password = document.getElementById('login-pass').value;
      try {
        if (registering) {
          await POST('/api/auth/register', { username, password, displayName: document.getElementById('login-display').value.trim() });
        } else {
          await POST('/api/auth/login', { username, password });
        }
        await refreshState(true); // first paint must never be skipped by the v-unchanged fast path
        this.enter();
      } catch (err) {
        errBox.textContent = '✕ ' + err.message;
      }
    });

    document.getElementById('logout-btn').addEventListener('click', async () => {
      try { await POST('/api/auth/logout'); } catch (e) { }
      location.reload();
    });
    document.getElementById('explorer-toggle').addEventListener('click', () => {
      document.getElementById('explorer').classList.toggle('collapsed');
    });
    document.getElementById('insp-close').addEventListener('click', () => Views.closeInspector());
    document.getElementById('exp-search').addEventListener('input', () => renderExplorer());
    document.getElementById('advance-btn').addEventListener('click', async () => {
      try { await POST('/api/gm/advance', { steps: 1 }); toast('One turn passes.'); }
      catch (e) { toast(e.message, true); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && W.placing) GameMap.setPlacing(null);
    });
  },

  enter() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    connectStream();
    if (!can(W.view)) W.view = (perms().pages || [])[0] || 'map';
    this.renderAll();
  },

  go(view) {
    if (view !== W.view) {
      W.view = view;
      // An intentional switch lands at the top, but mark it rendered so the
      // next periodic refresh treats it as the SAME view and preserves the
      // reader's scroll instead of snapping to the top.
      lastRenderedView = view;
      this.renderTabs();
      this.renderView(true);
    }
  },

  // News (n) unread badge — published articles newer than the user's
  // news-read waterline (raised server-side by visiting the News tab or
  // publishing). Re-counted on every renderAll, so an SSE sync that lands
  // while the user is elsewhere re-arms the badge in place.
  unreadNews() {
    if (!W.me || !S() || !Array.isArray(S().news)) return 0;
    const since = Number(W.me.lastReadNewsTs) || 0;
    return S().news.reduce((c, n) => c + (n.status === 'published' && Number(n.ts) > since ? 1 : 0), 0);
  },

  renderTabs() {
    const tabs = document.getElementById('tabs');
    clear(tabs);
    const elc = S() && S().election;
    for (const [id, label] of this.PAGES) {
      if (!can(id)) continue;
      let text = label;
      // Phase 33 — while an election is live the Parliament page becomes the
      // Elections desk: campaign trail during the season, live count once the
      // polls open. The tab reverts to "Parliament" the moment it ends.
      if (id === 'parliament' && elc && elc.active) text = 'Elections';
      if (id === 'news') {
        const unread = this.unreadNews();
        if (unread > 0) text = label + ' (' + unread + ')';
      }
      tabs.appendChild(el('button.tab', { class: W.view === id ? 'active' : '', onclick: () => this.go(id) }, text));
    }
  },

  renderTopbar() {
    const t = S().settings.time;
    document.getElementById('brand-world').textContent = (S().settings.worldName || 'ARCASIA').toUpperCase();
    document.getElementById('clock-turn').textContent = 'TURN ' + t.turn;
    document.getElementById('clock-date').textContent = fmtDate(t.date);
    this.renderWorldClock();
    document.getElementById('clock-auto').classList.toggle('hidden', !(t.auto && t.auto.enabled));
    document.getElementById('advance-btn').classList.toggle('hidden', !isGM());
    document.getElementById('user-name').textContent = W.me.displayName;
    document.getElementById('user-role').textContent = W.me.role.name;
    if (!worldClockTimer) worldClockTimer = setInterval(() => this.renderWorldClock(), 1000);
  },

  renderWorldClock() {
    const out = document.getElementById('clock-world');
    const state = S();
    if (!out || !state) return;
    const t = state.settings.time || {};
    const c = t.clock || {};
    if (!c.enabled) { out.textContent = 'WORLD PAUSED'; if (window.GameMap) GameMap.setDayNight(null); return; }
    const rate = Math.max(0, Number(c.minutesPerRealMinute) || 59.5);
    const sample = Number(c.nowMs);
    const sampleAt = Number(c.serverNowMs);
    const base = Number(c.anchorWorldMs) || Date.parse(String(t.date || '1970-01-01') + 'T00:00:00Z') || Date.now();
    const anchor = Number(c.anchorRealMs) || Date.now();
    const worldMs = Number.isFinite(sample) && Number.isFinite(sampleAt)
      ? sample + (Date.now() - sampleAt) * rate
      : base + (Date.now() - anchor) * rate;
    const d = new Date(worldMs);
    const iso = d.toISOString();
    out.textContent = 'WORLD ' + iso.slice(11, 16);
    if (window.GameMap) GameMap.setDayNight(worldMs);
  },

  renderView(fresh) {
    const container = document.getElementById('view');
    if (W.view === 'map') {
      if (fresh || !document.getElementById('map-wrap')) { GameMap.mount(container); lastMapFp = mapFingerprint(); return; }
      // The full-SVG map rebuild is the most expensive render in the app
      // (the war layer learned this first — docs/WAR.md "war-layer-only
      // redraws"). Most syncs don't touch anything the map draws (market
      // trades, news, casino…), so skip the rebuild unless the map's actual
      // inputs changed. Direct GameMap.render() callers (map editor, layer
      // buttons) bypass this and always render.
      const fp = mapFingerprint();
      if (fp !== lastMapFp) { lastMapFp = fp; GameMap.render(); }
      return;
    }
    if (W.view === 'gm') { GM.render(container); return; }
    return Views.render(container);
  },

  async renderAll() {
    if (!W.me || !S()) return;
    // only preserve scroll when this is a re-render of the same view (a
    // periodic refresh) — an actual view switch should land at the top
    const sameView = W.view === lastRenderedView;
    const saved = sameView ? captureScroll() : null;
    this.renderTopbar();
    this.renderTabs();
    renderExplorer();
    renderTicker();
    // Wait for the view render to finish: async views (Elections desk,
    // Entertainment) append content after their first frame, and restoring
    // the scroll before that happens clamps it toward the top (a browser
    // can't scroll past the end of a momentarily-short page).
    await this.renderView();
    // refresh open inspector with new data
    if (W.selection && !document.getElementById('inspector').classList.contains('hidden')) {
      Views.inspect(W.selection.kind, W.selection.id);
    }
    // Phase 3 — GM Command Bar: slim always-visible toolbar, GM-only, any view.
    if (typeof GMBar !== 'undefined') GMBar.render();
    // Phase 10 — reflect settings.music into the shared <audio> element +
    // top-bar widget on every state refresh / sync broadcast.
    if (typeof Music !== 'undefined') Music.apply();
    // Phase 25 QoL — toast timeline entries touching the player's own chain
    if (typeof Notify !== 'undefined') Notify.check();
    if (saved) restoreScroll(saved);
    lastRenderedView = W.view;
  }
};

window.addEventListener('DOMContentLoaded', () => App.boot());
