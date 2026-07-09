'use strict';
/* Phase 10 — Audio & Presentation: shared playback driven by settings.music.
   Every client applies the same settings (via sync broadcast) so a GM's
   playlist/force-track changes propagate immediately.

   Data shape (server/seed.js, server/store.js migrate):
     settings.music = {
       enabled: bool, shuffle: bool, volume: 0..1,
       library: [{ id, title, url, forcedOnly? }],
       playlists: [{ id, name, tracks: [trackId, ...] }],
       activePlaylist: id|null,
       forcedTrack: id|null
     }

   Playback backends — chosen per track by URL:
   - YouTube links (watch/youtu.be/embed/shorts) play through a hidden
     YouTube IFrame API player, so the default soundtrack can stream
     straight from YouTube with no saved asset files.
   - Anything else is treated as a direct audio file URL (.mp3/.ogg/…)
     and plays through a plain <audio> element.

   Forced-vs-normal enforcement:
   - Tracks with forcedOnly:true are excluded from every normal playlist/
     shuffle queue (buildQueue() filters them out).
   - A forcedTrack (any library track, including forcedOnly ones) always
     wins: apply() checks it first, loops it, and only falls back to the
     active playlist once forcedTrack is cleared — this is how the GM
     "runs an event" with a specific score under it.

   This module never mutates the server; it only reads S().settings.music
   and reflects it into the players + a small top-bar widget. */
const Music = {
  audio: null,
  widget: null,
  queue: [],        // shuffled/ordered list of library track ids for normal playback
  queuePos: -1,
  curTrackId: null,  // id of the track currently loaded
  curForced: null,   // forcedTrack id we last applied, or null
  curPlaylist: null, // activePlaylist id we last built the queue from
  curShuffle: null,
  armed: false,      // first-interaction unlock done
  mode: null,        // 'yt' | 'audio' — backend of the current track
  vol: 0.7,
  volTouched: false, // user moved the local slider — GM/global volume no longer overrides
  muted: false,
  yt: null,          // hidden YT.Player instance
  ytReady: false,
  curYtId: null,     // video id currently loaded into the YT player

  init() {
    if (this.audio) return; // idempotent
    // The volume slider is a personal, per-browser preference. Restore it
    // before the first apply() so a sync never snaps it back to the default.
    const savedVol = localStorage.getItem('arcasia-music-vol');
    if (savedVol !== null && !isNaN(Number(savedVol))) {
      this.vol = Math.max(0, Math.min(1, Number(savedVol)));
      this.volTouched = true;
    }
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.addEventListener('ended', () => this.onEnded());
    this.audio.addEventListener('play', () => this.renderWidget());
    this.audio.addEventListener('pause', () => this.renderWidget());

    // Browsers block autoplay-with-sound until the user interacts with the
    // page at least once. Arm playback on the first pointerdown/keydown and
    // immediately re-apply so a track already "wanted" starts.
    const unlock = () => {
      if (this.armed) return;
      this.armed = true;
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
      this.apply(true);
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);

    this.mountWidget();
    this.apply();
  },

  cfg() {
    return (S() && S().settings && S().settings.music) || null;
  },
  library() { const c = this.cfg(); return (c && c.library) || []; },
  trackById(id) { return this.library().find(t => t.id === id); },

  /* ---------- per-player playlist choice (Phase 10.1) ----------
     The GM still owns the library, playlists, forced track and an
     activePlaylist default. Each player may *locally* pick any playlist the
     GM allows (settings.music.allowedPlaylists); that choice lives only in
     this browser's localStorage and never touches the server. When the GM
     turns on settings.music.lockPlaylist the pick is ignored and everyone is
     pinned to the GM's activePlaylist. */
  allowedPlaylistIds(cfg) {
    const all = (cfg.playlists || []).map(p => p.id);
    // undefined = every playlist allowed (older worlds / never configured)
    if (!Array.isArray(cfg.allowedPlaylists)) return all;
    return all.filter(id => cfg.allowedPlaylists.includes(id));
  },
  localPlaylist() {
    try { return localStorage.getItem('arcasia-music-playlist') || null; } catch (e) { return null; }
  },
  setLocalPlaylist(id) {
    try {
      if (id) localStorage.setItem('arcasia-music-playlist', id);
      else localStorage.removeItem('arcasia-music-playlist'); // null = follow the GM's pick
    } catch (e) {}
    this.apply(true);
  },
  // Which playlist this client should actually play right now.
  effectivePlaylistId(cfg) {
    if (!cfg) return null;
    if (cfg.lockPlaylist) return cfg.activePlaylist || null; // GM forces it
    const pick = this.localPlaylist();
    if (pick && this.allowedPlaylistIds(cfg).includes(pick) &&
        (cfg.playlists || []).some(p => p.id === pick)) return pick;
    return cfg.activePlaylist || null; // no/invalid local pick → GM default
  },

  /* ---------- YouTube backend ---------- */
  ytIdOf(url) {
    const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{6,})/);
    return m ? m[1] : null;
  },
  // Lazily load the IFrame API and create one hidden, reusable player.
  ensureYT() {
    if (this.yt && this.ytReady) return Promise.resolve(this.yt);
    if (this._ytLoading) return this._ytLoading;
    this._ytLoading = new Promise((resolve) => {
      const make = () => {
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed; left:-9999px; bottom:0; width:1px; height:1px; overflow:hidden;';
        document.body.appendChild(host);
        this.yt = new YT.Player(host, {
          width: 1, height: 1,
          playerVars: { autoplay: 0, controls: 0, disablekb: 1, playsinline: 1 },
          events: {
            onReady: () => { this.ytReady = true; resolve(this.yt); },
            onStateChange: (e) => {
              if (e.data === YT.PlayerState.ENDED) this.onEnded();
              else this.renderWidget();
            },
            // deleted/region-blocked/non-embeddable video — skip it rather
            // than leaving every client silent
            onError: () => { if (this.mode === 'yt' && !this.curForced) this.advanceQueue(true); }
          }
        });
      };
      if (window.YT && window.YT.Player) make();
      else {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { if (prev) prev(); make(); };
        loadScript('https://www.youtube.com/iframe_api').catch(() => {});
      }
    });
    return this._ytLoading;
  },

  /* Build the normal-shuffle/ordered track-id list for the active playlist
     (falling back to the whole library when there's no playlist), always
     excluding forcedOnly tracks. */
  buildQueue(cfg) {
    const lib = cfg.library || [];
    const playlists = cfg.playlists || [];
    const pl = playlists.find(p => p.id === this.effectivePlaylistId(cfg));
    let ids;
    if (pl) ids = (pl.tracks || []).filter(id => lib.some(t => t.id === id));
    else ids = lib.map(t => t.id);
    // never let a forcedOnly track slip into normal rotation
    ids = ids.filter(id => { const t = this.trackById(id); return t && !t.forcedOnly; });
    if (cfg.shuffle) ids = this.shuffleArr(ids.slice());
    return ids;
  },
  shuffleArr(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  },

  /* Called on init() and from App.renderAll() (i.e. every sync). Cheap and
     idempotent — only rebuilds/restarts playback when something that
     matters actually changed, so unrelated syncs don't stutter the audio. */
  apply(forceRestart) {
    const cfg = this.cfg();
    this.renderWidget();
    if (!this.audio) return;

    if (!cfg || !cfg.enabled) {
      this.stopAll();
      this.curTrackId = null; this.curForced = null; this.curPlaylist = null;
      this.renderWidget();
      return;
    }

    // settings.music.volume is only the world DEFAULT. Once the user touches
    // their local slider (persisted in localStorage) it wins forever — the
    // old behaviour re-applied the global volume on EVERY sync/re-render,
    // resetting the slider each page update.
    if (!this.volTouched) {
      this.setVolume(Math.max(0, Math.min(1, cfg.volume === undefined ? 0.7 : Number(cfg.volume))), true);
    } else {
      this.setVolume(this.vol, true); // keep backends in sync with the local choice
    }

    // ---- forced track wins over everything ----
    if (cfg.forcedTrack) {
      const t = this.trackById(cfg.forcedTrack);
      if (t) {
        const changed = this.curForced !== cfg.forcedTrack || this.curTrackId !== t.id;
        this.curForced = cfg.forcedTrack;
        this.curPlaylist = null; // playlist state invalidated; rebuilt when forced clears
        this.audio.loop = true;  // YT looping is handled in onEnded()
        if (changed || forceRestart) this.loadAndPlay(t, forceRestart || changed);
        return;
      }
      // forcedTrack id referenced a track no longer in the library — fall
      // through to normal playback rather than getting stuck silent.
    }

    // ---- forced track just cleared: resume/rebuild the active playlist ----
    const wasForced = this.curForced !== null;
    this.curForced = null;
    this.audio.loop = false;

    const effId = this.effectivePlaylistId(cfg);
    const playlistChanged = this.curPlaylist !== effId || this.curShuffle !== !!cfg.shuffle;
    if (wasForced || playlistChanged || !this.queue.length || forceRestart) {
      this.queue = this.buildQueue(cfg);
      this.queuePos = this.queue.indexOf(this.curTrackId);
      this.curPlaylist = effId;
      this.curShuffle = !!cfg.shuffle;
      if (this.queuePos === -1) {
        // current track isn't part of the (new) rotation — start fresh
        this.advanceQueue(forceRestart);
      } else if (forceRestart && !this.isPlaying() && this.armed) {
        this.resume();
      }
      return;
    }
    // nothing structurally changed and a track is already loaded/playing —
    // leave it alone (avoid restarting audio on unrelated syncs).
    if (!this.curTrackId && this.queue.length) this.advanceQueue(forceRestart);
  },

  /* The ordered track list of the effective playlist (for the picker UI),
     excluding forcedOnly tracks and never shuffled — this is what the player
     sees and clicks, independent of the shuffled playback `queue`. */
  effectiveTracks(cfg) {
    const lib = cfg.library || [];
    const pl = (cfg.playlists || []).find(p => p.id === this.effectivePlaylistId(cfg));
    let ids = pl ? (pl.tracks || []).filter(id => lib.some(t => t.id === id)) : lib.map(t => t.id);
    ids = ids.filter(id => { const t = this.trackById(id); return t && !t.forcedOnly; });
    return ids.map(id => this.trackById(id)).filter(Boolean);
  },

  /* Personal, local jump to a specific track in the current playlist. Like
     the playlist pick it never touches the server; a GM forcedTrack still
     overrides (apply() re-loops it on the next sync). */
  playTrackById(id) {
    if (!this.audio) return;
    this.armed = true;
    const cfg = this.cfg();
    if (!cfg || !cfg.enabled) return;
    if (cfg.forcedTrack) return; // GM is forcing a track — local choice is ignored
    const t = this.trackById(id);
    if (!t) return;
    // make sure the playback queue reflects the effective playlist, then
    // position it on the chosen track so next/prev continue from here.
    const effId = this.effectivePlaylistId(cfg);
    if (this.curPlaylist !== effId || !this.queue.length) {
      this.queue = this.buildQueue(cfg);
      this.curPlaylist = effId;
      this.curShuffle = !!cfg.shuffle;
    }
    const idx = this.queue.indexOf(id);
    if (idx !== -1) this.queuePos = idx;
    this.loadAndPlay(t, true);
    this.renderWidget();
  },

  advanceQueue(forceRestart) {
    if (!this.queue.length) { this.curTrackId = null; this.stopAll(); this.renderWidget(); return; }
    this.queuePos = (this.queuePos + 1) % this.queue.length;
    if (this.queuePos === 0 && this.curShuffle) this.queue = this.shuffleArr(this.queue.slice());
    const t = this.trackById(this.queue[this.queuePos]);
    if (t) this.loadAndPlay(t, forceRestart);
  },

  loadAndPlay(track, forceRestart) {
    if (!track || !track.url) { this.curTrackId = track ? track.id : null; this.renderWidget(); return; }
    const changed = this.curTrackId !== track.id || forceRestart;
    this.curTrackId = track.id;
    const ytId = this.ytIdOf(track.url);

    if (ytId) {
      this.mode = 'yt';
      if (!this.audio.paused) this.audio.pause();
      this.ensureYT().then(p => {
        if (this.curTrackId !== track.id) return; // superseded while the API loaded
        p.setVolume(Math.round(this.vol * 100));
        if (this.muted) p.mute(); else p.unMute();
        if (changed || this.curYtId !== ytId) {
          this.curYtId = ytId;
          // cueing (not loading) while unarmed avoids a blocked-autoplay error
          if (this.armed) p.loadVideoById(ytId); else p.cueVideoById(ytId);
        } else if (this.armed) p.playVideo();
        this.renderWidget();
      });
    } else {
      this.mode = 'audio';
      this.pauseYT();
      if (changed) this.audio.src = track.url;
      if (this.armed) this.audio.play().catch(() => { /* still locked or bad URL — widget shows a play button */ });
    }
    this.renderWidget();
  },

  onEnded() {
    if (this.curForced) { this.restartCurrent(); return; }
    this.advanceQueue(true);
  },
  restartCurrent() {
    if (this.mode === 'yt' && this.yt && this.ytReady) { this.yt.seekTo(0, true); this.yt.playVideo(); }
    else { this.audio.currentTime = 0; this.audio.play().catch(() => {}); }
  },

  /* ---------- backend-agnostic transport ---------- */
  isPlaying() {
    if (this.mode === 'yt') {
      try { return !!(this.yt && this.ytReady && this.yt.getPlayerState() === YT.PlayerState.PLAYING); }
      catch (e) { return false; }
    }
    return !!(this.audio && !this.audio.paused);
  },
  pauseYT() { if (this.yt && this.ytReady) { try { this.yt.pauseVideo(); } catch (e) {} } },
  stopAll() {
    if (!this.audio.paused) this.audio.pause();
    this.pauseYT();
  },
  resume() {
    if (this.mode === 'yt') { if (this.yt && this.ytReady) this.yt.playVideo(); }
    else this.audio.play().catch(() => {});
  },
  togglePlay() {
    if (!this.audio) return;
    this.armed = true;
    if (this.isPlaying()) this.stopAll();
    else if (this.curTrackId) this.resume();
    else this.apply(true);
    this.renderWidget();
  },
  next() {
    if (!this.audio) return;
    this.armed = true;
    if (this.curForced) return; // forced track has no "next" — GM controls it
    this.advanceQueue(true);
  },
  setVolume(v, fromSync) {
    this.vol = v;
    if (this.audio) this.audio.volume = v;
    if (this.yt && this.ytReady) { try { this.yt.setVolume(Math.round(v * 100)); } catch (e) {} }
    if (!fromSync) {
      // user-initiated: remember it locally so syncs stop overriding it
      this.volTouched = true;
      try { localStorage.setItem('arcasia-music-vol', String(v)); } catch (e) {}
      this.renderWidget();
    }
  },
  toggleMute() {
    this.muted = !this.muted;
    if (this.audio) this.audio.muted = this.muted;
    if (this.yt && this.ytReady) { try { this.muted ? this.yt.mute() : this.yt.unMute(); } catch (e) {} }
    this.renderWidget();
  },

  /* ---------- compact top-bar widget ---------- */
  mountWidget() {
    if (this.widget) return;
    const topbar = document.getElementById('topbar');
    const playBtn = el('button.icon-btn.music-play', { title: 'Play/pause', onclick: () => this.togglePlay() }, '▶');
    const nextBtn = el('button.icon-btn.music-next', { title: 'Next track', onclick: () => this.next() }, '⏭');
    // Replaces the old mute button (which only duplicated pause/volume): opens
    // a menu of the playlists the GM allows players to choose between.
    const plBtn = el('button.icon-btn.music-pl-btn', { title: 'Choose playlist', onclick: (e) => this.togglePlaylistMenu(e) }, '♫');
    const title = el('span.music-title', 'No music');
    const volume = el('input.music-volume', {
      type: 'range', min: '0', max: '1', step: '0.05', value: '0.7',
      oninput: (e) => this.setVolume(Number(e.target.value))
    });
    const plMenu = el('div.music-pl-menu.hidden');
    this.playlistMenu = plMenu;
    this.els = { playBtn, nextBtn, plBtn, title, volume };
    this.widget = el('div#music-widget.music-widget.hidden',
      plBtn, playBtn, nextBtn, title, volume, plMenu
    );
    // Insert before the palette swatches if the topbar is laid out as
    // expected; otherwise just append — either way it's a small fixed-style
    // inline widget so it never breaks layout.
    const anchor = document.getElementById('palette');
    if (topbar && anchor) topbar.insertBefore(this.widget, anchor);
    else if (topbar) topbar.appendChild(this.widget);
    else document.body.appendChild(this.widget);
  },

  /* ---------- playlist picker menu ---------- */
  togglePlaylistMenu(e) {
    if (e) e.stopPropagation();
    this.armed = true;
    if (!this.playlistMenu) return;
    if (this.playlistMenu.classList.contains('hidden')) {
      this.buildPlaylistMenu();
      this.playlistMenu.classList.remove('hidden');
      // close on the next outside click/tap
      this._plOutside = (ev) => { if (!this.widget.contains(ev.target)) this.closePlaylistMenu(); };
      setTimeout(() => document.addEventListener('pointerdown', this._plOutside, true), 0);
    } else {
      this.closePlaylistMenu();
    }
  },
  closePlaylistMenu() {
    if (this.playlistMenu) this.playlistMenu.classList.add('hidden');
    if (this._plOutside) { document.removeEventListener('pointerdown', this._plOutside, true); this._plOutside = null; }
  },
  buildPlaylistMenu() {
    const menu = this.playlistMenu;
    if (!menu) return;
    clear(menu);
    const cfg = this.cfg();
    if (!cfg) return;

    // GM has locked playback — players cannot choose the playlist, but they
    // may still pick which track within the pinned playlist plays for them.
    if (cfg.lockPlaylist) {
      const pl = (cfg.playlists || []).find(p => p.id === cfg.activePlaylist);
      menu.appendChild(el('div.music-pl-locked',
        '🔒 The gamemaster is controlling the music' + (pl ? ' — ' + pl.name : '') + '.'));
      this.appendTrackMenu(menu, cfg);
      return;
    }

    const allowed = this.allowedPlaylistIds(cfg);
    const pick = this.localPlaylist();
    const followingGM = !pick || !allowed.includes(pick);
    const gmPl = (cfg.playlists || []).find(p => p.id === cfg.activePlaylist);

    const mkRow = (id, label, selected) =>
      el('div.music-pl-item', { class: selected ? 'selected' : '', onclick: () => { this.setLocalPlaylist(id); this.closePlaylistMenu(); } },
        el('span.music-pl-check', selected ? '●' : '○'), el('span', label));

    menu.appendChild(el('div.music-pl-head', 'Playlist'));
    menu.appendChild(mkRow(null, 'Gamemaster’s pick' + (gmPl ? ' (' + gmPl.name + ')' : ' (none)'), followingGM));
    const rows = (cfg.playlists || []).filter(p => allowed.includes(p.id));
    rows.forEach(p => menu.appendChild(mkRow(p.id, p.name, !followingGM && pick === p.id)));
    if (!rows.length) menu.appendChild(el('div.music-pl-empty', 'The gamemaster has not shared any playlists.'));
    this.appendTrackMenu(menu, cfg);
  },

  /* Track picker: list the effective playlist's tracks so a player can jump
     straight to one. Disabled while a GM forcedTrack is active (it would just
     be overridden). Keep it local — no server writes. */
  appendTrackMenu(menu, cfg) {
    const tracks = this.effectiveTracks(cfg);
    if (!tracks.length) return;
    menu.appendChild(el('div.music-pl-head', 'Tracks'));
    if (cfg.forcedTrack) {
      menu.appendChild(el('div.music-pl-empty', 'The gamemaster is forcing a track.'));
      return;
    }
    tracks.forEach(t => {
      const selected = !this.curForced && this.curTrackId === t.id;
      menu.appendChild(el('div.music-pl-item', {
        class: selected ? 'selected' : '',
        onclick: () => { this.playTrackById(t.id); this.closePlaylistMenu(); }
      }, el('span.music-pl-check', selected ? '▶' : '○'), el('span', t.title || 'Untitled track')));
    });
  },

  renderWidget() {
    if (!this.widget) return;
    const cfg = this.cfg();
    if (!cfg || !cfg.enabled) { this.widget.classList.add('hidden'); this.closePlaylistMenu(); return; }
    this.widget.classList.remove('hidden');
    const t = this.trackById(this.curForced || this.curTrackId);
    this.els.title.textContent = t ? (t.title || 'Untitled track') + (this.curForced ? ' (forced)' : '') : 'No track';
    this.els.title.title = this.els.title.textContent;
    this.els.playBtn.textContent = this.isPlaying() ? '⏸' : '▶';
    this.els.nextBtn.disabled = !!this.curForced;
    // lock glyph + tooltip when the GM is forcing the playlist
    const locked = !!cfg.lockPlaylist;
    this.els.plBtn.textContent = locked ? '🔒' : '♫';
    this.els.plBtn.title = locked ? 'Gamemaster is controlling the music' : 'Choose playlist';
    this.els.plBtn.classList.toggle('locked', locked);
    if (document.activeElement !== this.els.volume) this.els.volume.value = String(this.vol);
    // keep an open menu in sync with live GM changes (lock toggles, renames)
    if (this.playlistMenu && !this.playlistMenu.classList.contains('hidden')) this.buildPlaylistMenu();
  }
};

document.addEventListener('DOMContentLoaded', () => Music.init());
