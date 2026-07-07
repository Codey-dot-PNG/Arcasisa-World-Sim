'use strict';
/* Phase 10 — Audio & Presentation: a single shared <audio> element playing
   from settings.music. Every client applies the same settings (via sync
   broadcast) so a GM's playlist/force-track changes propagate immediately.

   Data shape (server/seed.js, server/store.js migrate):
     settings.music = {
       enabled: bool, shuffle: bool, volume: 0..1,
       library: [{ id, title, url, forcedOnly? }],
       playlists: [{ id, name, tracks: [trackId, ...] }],
       activePlaylist: id|null,
       forcedTrack: id|null
     }

   Forced-vs-normal enforcement:
   - Tracks with forcedOnly:true are excluded from every normal playlist/
     shuffle queue (buildQueue() filters them out).
   - A forcedTrack (any library track, including forcedOnly ones) always
     wins: apply() checks it first, loops it, and only falls back to the
     active playlist once forcedTrack is cleared.

   This module never mutates the server; it only reads S().settings.music
   and reflects it into the <audio> element + a small top-bar widget. */
const Music = {
  audio: null,
  widget: null,
  queue: [],        // shuffled/ordered list of library track ids for normal playback
  queuePos: -1,
  curTrackId: null,  // id of the track currently loaded into audio.src
  curForced: null,   // forcedTrack id we last applied, or null
  curPlaylist: null, // activePlaylist id we last built the queue from
  curShuffle: null,
  armed: false,      // first-interaction unlock done

  init() {
    if (this.audio) return; // idempotent
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

  /* Build the normal-shuffle/ordered track-id list for the active playlist
     (falling back to the whole library when there's no playlist), always
     excluding forcedOnly tracks. */
  buildQueue(cfg) {
    const lib = cfg.library || [];
    const playlists = cfg.playlists || [];
    const pl = playlists.find(p => p.id === cfg.activePlaylist);
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
      if (!this.audio.paused) this.audio.pause();
      this.curTrackId = null; this.curForced = null; this.curPlaylist = null;
      this.renderWidget();
      return;
    }

    this.audio.volume = Math.max(0, Math.min(1, cfg.volume === undefined ? 0.7 : Number(cfg.volume)));

    // ---- forced track wins over everything ----
    if (cfg.forcedTrack) {
      const t = this.trackById(cfg.forcedTrack);
      if (t) {
        const changed = this.curForced !== cfg.forcedTrack || this.curTrackId !== t.id;
        this.curForced = cfg.forcedTrack;
        this.curPlaylist = null; // playlist state invalidated; rebuilt when forced clears
        this.audio.loop = true;
        if (changed || forceRestart) this.loadAndPlay(t);
        return;
      }
      // forcedTrack id referenced a track no longer in the library — fall
      // through to normal playback rather than getting stuck silent.
    }

    // ---- forced track just cleared: resume/rebuild the active playlist ----
    const wasForced = this.curForced !== null;
    this.curForced = null;
    this.audio.loop = false;

    const playlistChanged = this.curPlaylist !== (cfg.activePlaylist || null) || this.curShuffle !== !!cfg.shuffle;
    if (wasForced || playlistChanged || !this.queue.length || forceRestart) {
      this.queue = this.buildQueue(cfg);
      this.queuePos = this.queue.indexOf(this.curTrackId);
      this.curPlaylist = cfg.activePlaylist || null;
      this.curShuffle = !!cfg.shuffle;
      if (this.queuePos === -1) {
        // current track isn't part of the (new) rotation — start fresh
        this.advanceQueue(forceRestart);
      } else if (forceRestart && this.audio.paused && this.armed) {
        this.audio.play().catch(() => {});
      }
      return;
    }
    // nothing structurally changed and a track is already loaded/playing —
    // leave it alone (avoid restarting audio on unrelated syncs).
    if (!this.curTrackId && this.queue.length) this.advanceQueue(forceRestart);
  },

  advanceQueue(forceRestart) {
    if (!this.queue.length) { this.curTrackId = null; this.audio.pause(); this.renderWidget(); return; }
    this.queuePos = (this.queuePos + 1) % this.queue.length;
    if (this.queuePos === 0 && this.curShuffle) this.queue = this.shuffleArr(this.queue.slice());
    const t = this.trackById(this.queue[this.queuePos]);
    if (t) this.loadAndPlay(t, forceRestart);
  },

  loadAndPlay(track, forceRestart) {
    if (!track || !track.url) { this.curTrackId = track ? track.id : null; this.renderWidget(); return; }
    if (this.curTrackId !== track.id || forceRestart) {
      this.curTrackId = track.id;
      this.audio.src = track.url;
    }
    if (this.armed) this.audio.play().catch(() => { /* still locked or bad URL — widget shows a play button */ });
    this.renderWidget();
  },

  onEnded() {
    if (this.curForced) { this.audio.currentTime = 0; this.audio.play().catch(() => {}); return; } // loop handles it, but belt-and-braces
    this.advanceQueue(true);
  },

  /* ---------- transport used by the widget ---------- */
  togglePlay() {
    if (!this.audio) return;
    this.armed = true;
    if (this.audio.paused) {
      if (!this.curTrackId) this.apply(true);
      else this.audio.play().catch(() => {});
    } else this.audio.pause();
  },
  next() {
    if (!this.audio) return;
    this.armed = true;
    if (this.curForced) return; // forced track has no "next" — GM controls it
    this.advanceQueue(true);
  },
  setVolume(v) {
    if (this.audio) this.audio.volume = v;
  },
  toggleMute() {
    if (!this.audio) return;
    this.audio.muted = !this.audio.muted;
    this.renderWidget();
  },

  /* ---------- compact top-bar widget ---------- */
  mountWidget() {
    if (this.widget) return;
    const topbar = document.getElementById('topbar');
    const playBtn = el('button.icon-btn.music-play', { title: 'Play/pause', onclick: () => this.togglePlay() }, '▶');
    const nextBtn = el('button.icon-btn.music-next', { title: 'Next track', onclick: () => this.next() }, '⏭');
    const muteBtn = el('button.icon-btn.music-mute', { title: 'Mute/unmute', onclick: () => this.toggleMute() }, '♪');
    const title = el('span.music-title', 'No music');
    const volume = el('input.music-volume', {
      type: 'range', min: '0', max: '1', step: '0.05', value: '0.7',
      oninput: (e) => this.setVolume(Number(e.target.value))
    });
    this.els = { playBtn, nextBtn, muteBtn, title, volume };
    this.widget = el('div#music-widget.music-widget.hidden',
      muteBtn, playBtn, nextBtn, title, volume
    );
    // Insert before the palette swatches if the topbar is laid out as
    // expected; otherwise just append — either way it's a small fixed-style
    // inline widget so it never breaks layout.
    const anchor = document.getElementById('palette');
    if (topbar && anchor) topbar.insertBefore(this.widget, anchor);
    else if (topbar) topbar.appendChild(this.widget);
    else document.body.appendChild(this.widget);
  },

  renderWidget() {
    if (!this.widget) return;
    const cfg = this.cfg();
    if (!cfg || !cfg.enabled) { this.widget.classList.add('hidden'); return; }
    this.widget.classList.remove('hidden');
    const t = this.trackById(this.curForced || this.curTrackId);
    this.els.title.textContent = t ? (t.title || 'Untitled track') + (this.curForced ? ' (forced)' : '') : 'No track';
    this.els.title.title = this.els.title.textContent;
    const playing = this.audio && !this.audio.paused;
    this.els.playBtn.textContent = playing ? '⏸' : '▶';
    this.els.nextBtn.disabled = !!this.curForced;
    this.els.muteBtn.classList.toggle('active', !!(this.audio && this.audio.muted));
    if (this.audio && document.activeElement !== this.els.volume) this.els.volume.value = String(this.audio.volume);
  }
};

document.addEventListener('DOMContentLoaded', () => Music.init());
