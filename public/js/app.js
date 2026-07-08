'use strict';
/* Boot, auth, navigation, shell orchestration. */

// Tracks the view renderAll last painted, so periodic-refresh re-renders can
// restore scroll positions while a real view switch (App.go) still lands at
// the top as expected.
let lastRenderedView = null;

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
    ['timeline', 'Timeline'], ['gm', 'GM Studio']
  ],

  async boot() {
    // palette
    const mood = localStorage.getItem('arcasia-mood');
    if (mood && mood !== 'paper') document.body.setAttribute('data-mood', mood);
    document.querySelectorAll('.swatch').forEach(btn => {
      btn.classList.toggle('active', (mood || 'paper') === btn.dataset.mood);
      btn.addEventListener('click', () => {
        document.querySelectorAll('.swatch').forEach(b => b.classList.remove('active'));
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
      this.renderTabs();
      this.renderView(true);
    }
  },

  renderTabs() {
    const tabs = document.getElementById('tabs');
    clear(tabs);
    for (const [id, label] of this.PAGES) {
      if (!can(id)) continue;
      tabs.appendChild(el('button.tab', { class: W.view === id ? 'active' : '', onclick: () => this.go(id) }, label));
    }
  },

  renderTopbar() {
    const t = S().settings.time;
    document.getElementById('brand-world').textContent = (S().settings.worldName || 'ARCASIA').toUpperCase();
    document.getElementById('clock-turn').textContent = 'TURN ' + t.turn;
    document.getElementById('clock-date').textContent = fmtDate(t.date);
    document.getElementById('clock-auto').classList.toggle('hidden', !(t.auto && t.auto.enabled));
    document.getElementById('advance-btn').classList.toggle('hidden', !isGM());
    document.getElementById('user-name').textContent = W.me.displayName;
    document.getElementById('user-role').textContent = W.me.role.name;
  },

  renderView(fresh) {
    const container = document.getElementById('view');
    if (W.view === 'map') {
      if (fresh || !document.getElementById('map-wrap')) GameMap.mount(container);
      else GameMap.render();
      return;
    }
    if (W.view === 'gm') { GM.render(container); return; }
    Views.render(container);
  },

  renderAll() {
    if (!W.me || !S()) return;
    // only preserve scroll when this is a re-render of the same view (a
    // periodic refresh) — an actual view switch should land at the top
    const sameView = W.view === lastRenderedView;
    const saved = sameView ? captureScroll() : null;
    this.renderTopbar();
    this.renderTabs();
    renderExplorer();
    renderTicker();
    this.renderView();
    // refresh open inspector with new data
    if (W.selection && !document.getElementById('inspector').classList.contains('hidden')) {
      Views.inspect(W.selection.kind, W.selection.id);
    }
    // Phase 3 — GM Command Bar: slim always-visible toolbar, GM-only, any view.
    if (typeof GMBar !== 'undefined') GMBar.render();
    // Phase 10 — reflect settings.music into the shared <audio> element +
    // top-bar widget on every state refresh / sync broadcast.
    if (typeof Music !== 'undefined') Music.apply();
    if (saved) restoreScroll(saved);
    lastRenderedView = W.view;
  }
};

window.addEventListener('DOMContentLoaded', () => App.boot());
