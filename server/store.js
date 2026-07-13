'use strict';
// World store with two interchangeable backends:
//
//   file      — single node process; world in memory, flushed atomically to
//               data/world.json; per-turn snapshot files. (local hosting)
//   supabase  — serverless; world doc in a Postgres JSONB row, append-only
//               timeline/transaction tables, snapshot rows. Each request
//               begin()s (load or reuse warm cache) and commit()s (flush
//               pending writes + realtime "sync" ping). (Vercel hosting)
//
// The mutation API is synchronous in both modes so sim.js/api.js stay
// identical: handlers mutate the in-memory db, and persistence happens at
// the edges (debounced save locally, commit() per request in the cloud).
const fs = require('fs');
const path = require('path');
const sb = require('./supabase');

const MODE = sb.enabled ? 'supabase' : 'file';

// A serverless/container host in file mode has no durable storage — the world
// is lost on every redeploy or cold start. Make that impossible to miss.
if (MODE === 'file' && (process.env.VERCEL || process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.K_SERVICE)) {
  console.error('\n  ############################################################');
  console.error('  ##  NO DATABASE CONFIGURED — DATA WILL NOT SURVIVE       ##');
  console.error('  ##  redeploys or cold starts on this host.               ##');
  console.error('  ##  Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and     ##');
  console.error('  ##  redeploy. See DEPLOY.md.                             ##');
  console.error('  ############################################################\n');
}

// DATA_DIR is relocatable so the world file can live on a mounted persistent
// volume rather than inside the app directory.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'world.json');
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
const SNAP_KEEP = 60;
const TIMELINE_CAP = 8000;
const LOG_FETCH = 400; // recent timeline/transactions loaded per request in cloud mode

let db = null;
let seedFn = null;
let version = 0;            // cloud: value of world.version we loaded
let fileRev = Date.now();   // file mode: bumped on every save so getVersion() means something there too
let dirty = false;
let broadcastPending = false;
let pendingTimeline = [];
let pendingTxns = [];
let pendingSnapshot = null; // at most one snapshot per request
let saveTimer = null;

function uid(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Default soundtrack (Phase 10): the Suzerain: Rizia OST, streamed from
// YouTube (public/js/music.js plays YouTube URLs through a hidden IFrame
// player). Mirrors the fresh-seed library in seed.js — keep the two in sync.
const DEFAULT_MUSIC_TRACKS = [
  ['C8Yu0WTLdXo', 'Main Theme'], ['EKoRsKcOGd0', 'Toras'], ['NNkSTtpTsdw', 'Map of Rizia'],
  ['L0bN8DipxkY', 'For The People'], ['1bzoIqSiT8Q', 'Breather'], ['m_vUofSSndo', 'Alliances'],
  ['8lBrodCyNnw', 'By The People'], ['apLRHhlwNrY', 'Negotiations'], ['vZDT1vaCUqE', 'Stress'],
  ['wvY9x4xVDOs', 'Up In The Air'], ['TF7rCp33DLA', 'Impasse'], ['pfgA7WOmuwk', 'Solitude'],
  ['OZjHv84YT1A', 'Falling Into Place'], ['s6Zx6ss8RIM', 'Uncertainty'], ['Nhw4BLy6Pas', 'Crisis'],
  ['lKraHXwJWls', 'Sunrise'], ['h8c-p2SRvBQ', 'Gridlock'], ['FktZOO-LNpM', 'Still'],
  ['y-WZ3baw71I', 'Traitor'], ['yPBeqdCk33U', 'Continuation'], ['k_Zy9EcY4j0', 'Consequence'],
  ['MekX0DZrhEM', 'Fruition']
];
function defaultMusic() {
  const library = DEFAULT_MUSIC_TRACKS.map(([vid, name], i) => ({
    id: 'trk_rizia' + String(i + 1).padStart(2, '0'),
    title: 'Suzerain: Rizia OST — ' + name,
    url: 'https://www.youtube.com/watch?v=' + vid
  }));
  return {
    enabled: true, shuffle: false, volume: 0.7,
    library,
    playlists: [{ id: 'plist_default', name: 'Default Soundtrack', tracks: library.map(t => t.id) }],
    activePlaylist: 'plist_default',
    forcedTrack: null,
    // Phase 10.1 — per-player playlist choice. allowedPlaylists lists the
    // playlist ids a player may switch to from the top-bar widget; lockPlaylist
    // forces the GM's activePlaylist on everyone (players can't choose).
    allowedPlaylists: ['plist_default'],
    lockPlaylist: false
  };
}

// Bring a world loaded from disk/DB up to the current schema. Idempotent and
// additive — safe to run on every load. Returns true if anything changed so
// callers can persist. New collections/fields introduced by later phases add
// their defaults here so live worlds upgrade without a reset.
function migrate(world) {
  if (!world) return false;
  let changed = false;
  const need = (key, def) => { if (world[key] === undefined) { world[key] = def; changed = true; } };
  need('markers', []);                    // Phase 1.4 — event markers
  need('history', []);                    // Phase 7.1 — time-series for charts
  need('trades', []);                     // Phase 4.3 — negotiated trade offers

  // Phase 23 — weapons & fuel as tradable items with combat stats. Seeded
  // once (flag-gated); the GM freely edits stats/names or mints new models
  // from the template afterwards, so re-running must never re-add or reset.
  if (!world._weaponsSeeded && Array.isArray(world.items)) {
    const mkGun = (id, name, originId, dmg, hp, morale, value, desc) => ({
      id, icon: 'W', name, category: 'Military', tradable: true, marketValue: value,
      meta: { weapon: { kind: 'smallarms', dmg, hp, morale }, originId },
      description: desc
    });
    const guns = [
      mkGun('item_gun_arc_m58', 'ARC M-58 Service Rifle', null, 0.18, 0.12, 0.08, 260, 'Standard-issue Arcasian battle rifle. Honest, heavy, everywhere.'),
      mkGun('item_gun_sarom55', 'Saromese Model 55 Auto', 'for_sarom', 0.35, 0.22, 0.15, 520, 'Select-fire Saromese automatic. The gold standard of the region’s small arms.'),
      mkGun('item_gun_narinco38', 'Narinco ’38 Bolt-Action', 'for_madrosia', 0.08, 0.05, 0.02, 90, 'Madrosia’s ageing bolt gun. Better than bare hands, barely.'),
      mkGun('item_gun_valks_vk3', 'Valkslander VK-3 Carbine', 'for_valksland', 0.30, 0.18, 0.12, 460, 'Compact assault carbine of the Valksland expeditionary corps.'),
      mkGun('item_gun_delcasia_df1', 'Del’ Casian DF-1 Field Rifle', 'for_delcasia', 0.16, 0.10, 0.06, 210, 'Del’ Casia’s licence-built field rifle. Rugged and plentiful.'),
      mkGun('item_gun_qinal_type7', 'Qinal Type-7 Infantry Rifle', 'for_qinal', 0.14, 0.12, 0.05, 180, 'Mass-produced Qinal service rifle. Quantity is its own quality.'),
      mkGun('item_gun_karaz_kz44', 'Karaznian KZ-44 Machine Carbine', 'for_karaznia', 0.26, 0.14, 0.10, 380, 'Karaznia’s stamped-steel machine carbine. Cheap, fast, loud.'),
      mkGun('item_gun_estal_e9', 'Estal E-9 Marksman Rifle', 'for_estal', 0.22, 0.08, 0.09, 340, 'Precision Estal marksman rifle in limited runs.')
    ];
    for (const g of guns) if (!world.items.some(i => i.id === g.id)) world.items.push(g);
    // Refined Fuel powers army mobility from here on.
    const fuel = world.items.find(i => i.id === 'item_fuel');
    if (fuel && !(fuel.meta && fuel.meta.weapon)) {
      fuel.meta = fuel.meta || {};
      fuel.meta.weapon = { kind: 'fuel', speed: 0.5 };
    }
    // Starting stocks: the Republic fields its own rifle + a fuel reserve;
    // each armed foreign power stocks its national model.
    const grant = (entId, itemId, qty) => {
      const e = world.entities.find(x => x.id === entId);
      if (!e) return;
      e.inventory = e.inventory || [];
      const row = e.inventory.find(r => r.itemId === itemId);
      if (row) row.qty = (row.qty || 0) + qty; else e.inventory.push({ qty, itemId });
    };
    grant('ent_gov', 'item_gun_arc_m58', 30000);
    grant('ent_gov', 'item_fuel', 900);
    grant('for_sarom', 'item_gun_sarom55', 25000);
    grant('for_madrosia', 'item_gun_narinco38', 12000);
    grant('for_valksland', 'item_gun_valks_vk3', 45000);
    grant('for_delcasia', 'item_gun_delcasia_df1', 40000);
    grant('for_qinal', 'item_gun_qinal_type7', 35000);
    grant('for_karaznia', 'item_gun_karaz_kz44', 20000);
    grant('for_estal', 'item_gun_estal_e9', 8000);
    world._weaponsSeeded = true;
    changed = true;
  }
  // Phase 5 — newspapers. Fixed four-paper list; additive so a GM rename of
  // an existing paper is never clobbered by re-running this migration.
  if (world.settings && !world.settings.newspapers) {
    world.settings.newspapers = [
      { id: 'paper_today', name: 'Arcasia Today', tagline: '-HEART OF ARCASIA-', city: 'Lachevan', style: 'today', owner: 'This newspaper is owned by the State corporation ARC' },
      { id: 'paper_herald', name: 'The National Herald', tagline: 'VOICE OF THE NATION', city: 'Lachevan', style: 'herald', owner: 'This newspaper is funded by the NFP' },
      { id: 'paper_economists', name: 'Economists', tagline: 'MARKETS · TRADE · INDUSTRY', city: 'Lachevan', style: 'economists', owner: 'This newspaper is owned by the Satrom group' },
      { id: 'paper_radical', name: 'Radical', tagline: '-THE VOICE OF ARCASIA-', city: 'Kordi', style: 'radical', owner: 'This is an independent newspaper' }
    ];
    changed = true;
  }
  if (world.settings && !world.settings.newspaperRouting) {
    world.settings.newspaperRouting = { Politics: 'paper_today', Regional: 'paper_herald', Foreign: 'paper_herald', Economy: 'paper_economists', Business: 'paper_economists' };
    changed = true;
  }
  // Phase 10 — Audio & Presentation. Same default shape as a fresh seed
  // (see seed.js) so a live world upgrades with a usable Music Library /
  // playlist instead of an empty one. Never overwrites a GM's own config:
  // the upgrade branch only fires when every library track still has an
  // empty URL (the old unplayable placeholder state).
  if (world.settings && !world.settings.music) {
    world.settings.music = defaultMusic();
    changed = true;
  } else if (world.settings && world.settings.music &&
    (world.settings.music.library || []).length &&
    world.settings.music.library.every(t => !t.url)) {
    const vol = world.settings.music.volume;
    world.settings.music = defaultMusic();
    if (vol !== undefined) world.settings.music.volume = vol;
    changed = true;
  }
  // Phase 10.1 — per-player playlist choice fields. Additive; a GM's config is
  // left alone. allowedPlaylists defaults to every existing playlist (so the
  // picker is populated) and lockPlaylist to off.
  if (world.settings && world.settings.music) {
    const mus = world.settings.music;
    if (mus.allowedPlaylists === undefined) {
      mus.allowedPlaylists = (mus.playlists || []).map(p => p.id);
      changed = true;
    }
    if (mus.lockPlaylist === undefined) { mus.lockPlaylist = false; changed = true; }
  }
  if (world.settings) {
    const validPaperIds = new Set((world.settings.newspapers || []).map(p => p.id));
    const routing = world.settings.newspaperRouting || {};
    const defaultPaper = validPaperIds.has('paper_today') ? 'paper_today' : (world.settings.newspapers || [])[0] && world.settings.newspapers[0].id;
    for (const n of (world.news || [])) {
      if (!n.paperId || !validPaperIds.has(n.paperId)) {
        n.paperId = routing[n.category] || defaultPaper;
        changed = true;
      }
    }
    // journalist users (and any user otherwise missing one) default to the
    // state paper unless already assigned.
    for (const uu of (world.users || [])) {
      if (uu.newspaperId === undefined) {
        uu.newspaperId = uu.roleId === 'journalist' ? defaultPaper : null;
        changed = true;
      }
    }
  }
  // The old off-book "Exchange" (ent_exchange/acct_exchange) is retired — the
  // National Bank is now the market maker. Delete it from live worlds so its
  // (often negative) settlement book stops distorting the economy. Historical
  // transactions referencing acct_exchange are left as-is (name lookups degrade
  // gracefully).
  if (world.entities && world.entities.some(e => e.id === 'ent_exchange')) {
    world.entities = world.entities.filter(e => e.id !== 'ent_exchange'); changed = true;
  }
  if (world.accounts && world.accounts.some(a => a.id === 'acct_exchange')) {
    world.accounts = world.accounts.filter(a => a.id !== 'acct_exchange'); changed = true;
  }
  // Economic confidence — the Day-Market feedback aggregate.
  if (world.globalVars && world.globalVars.econConfidence === undefined) { world.globalVars.econConfidence = 50; changed = true; }

  // Stock-market fields on companies (trust also used by Phase 9).
  for (const e of (world.entities || [])) {
    if (e.type !== 'company') continue;
    if (e.trust === undefined) { e.trust = 50; changed = true; }
    if (e.publicFloat === undefined) { e.publicFloat = 15; changed = true; }
    if (e.sharePrice === undefined) {
      const val = (e.vars && e.vars.valuation) || 0;
      e.sharePrice = e.sharesOutstanding ? Math.max(1, Math.round(val / e.sharesOutstanding * 100) / 100) : 100;
      changed = true;
    }
    // Day-Market fields: tradeable speculative price + its rolling history +
    // company confidence + the live-wander anchor. Additive; a GM's tuned depth/
    // vol are never clobbered. (Retires the old single priceAnchor.)
    if (e.marketDepth === undefined) { e.marketDepth = 5; changed = true; }
    if (e.vol === undefined) { e.vol = 0.02; changed = true; }
    if (e.confidence === undefined) { e.confidence = 50; changed = true; }
    if (e.dayPrice === undefined) { e.dayPrice = e.sharePrice; changed = true; }
    if (!Array.isArray(e.dayHistory)) { e.dayHistory = [e.dayPrice]; changed = true; }
    if (!e.dayAnchor || e.dayAnchor.price === undefined) {
      e.dayAnchor = { price: e.dayPrice, t0: Date.now(), seed: (Math.floor(Math.random() * 0x7fffffff) + 1) >>> 0 };
      changed = true;
    }
    if (e.priceAnchor !== undefined) { delete e.priceAnchor; changed = true; }
    // Unsold primary-offering pool (shares floated but not yet subscribed).
    // Existing worlds start at 0 — their current float is legitimate owner
    // stock, not an unsold offering, so it still counts toward valuation.
    if (e.vars && e.vars.primaryPool === undefined) { e.vars.primaryPool = 0; changed = true; }
  }
  // reconcile share certificates against the canonical register (Phase 4.4)
  try { if (require('./market').syncAllCertificates(world)) changed = true; }
  catch (e) { /* market module optional during early boot */ }
  // issue/reconcile property deed items against property.ownerId
  try { if (require('./deeds').syncAllDeeds(world)) changed = true; }
  catch (e) { /* deeds module optional during early boot */ }
  // give every property a building texture fitting its kind
  try { if (require('./buildings').syncAllTextures(world)) changed = true; }
  catch (e) { /* buildings module optional during early boot */ }

  // Masthead logo images for the four fixed papers (additive — a GM-set
  // logo is left alone).
  const PAPER_LOGOS = {
    paper_today: '/assets/newspapers/today.png',
    paper_herald: '/assets/newspapers/herald.png',
    paper_economists: '/assets/newspapers/economists.png',
    paper_radical: '/assets/newspapers/radical.png'
  };
  for (const paper of ((world.settings || {}).newspapers || [])) {
    if (!paper.logo && PAPER_LOGOS[paper.id]) { paper.logo = PAPER_LOGOS[paper.id]; changed = true; }
  }

  // The national profile card (settings.country) was removed from the UI —
  // drop the stale data from live worlds too.
  if (world.settings && world.settings.country !== undefined) {
    delete world.settings.country;
    changed = true;
  }

  // Market session runs every turn (was weekly). Only flips the stock event
  // if it still carries the default weekly trigger, so a GM's custom
  // schedule survives. Noise coefficient is halved to keep the random walk
  // comparable now that it applies ~7× as often.
  const evMarket = (world.events || []).find(e => e.id === 'ev_market');
  if (evMarket && evMarket.trigger && evMarket.trigger.type === 'weekly') {
    evMarket.trigger = { type: 'every_turn' };
    if (evMarket.name === 'Weekly Market Session') evMarket.name = 'Market Session';
    for (const fx of (evMarket.effects || [])) {
      if (fx.type === 'reprice_shares' && Number(fx.e) === 0.03) fx.e = 0.015;
    }
    changed = true;
  }
  // An older overhaul left ev_market repricing the certificate ITEMS
  // (set_item_value on Securities) instead of company.sharePrice, so the
  // Exchange price and its history never moved. Restore the canonical
  // reprice_shares effect — narrowly matched so a GM's own custom effect
  // list is never clobbered.
  if (evMarket && (evMarket.effects || []).length === 1 &&
    evMarket.effects[0].type === 'set_item_value' && evMarket.effects[0].category === 'Securities') {
    evMarket.effects = [{ type: 'reprice_shares', company: 'all', a: 0.6, b: 0.8, c: 0.15, e: 0.015 }];
    changed = true;
  }

  // Timeline tab is GM-only: strip the 'timeline' page from every non-GM
  // role so existing worlds pick up the tightened visibility. (The server
  // also filters timeline data itself in api.js filterState.)
  // Conversely, every role gets the full set of INFO tabs — all dossiers are
  // public knowledge; only the data inside them is clearance-filtered.
  const STD_PAGES = ['map', 'parliament', 'companies', 'economy', 'population', 'news', 'entertainment', 'war'];
  for (const r of (world.roles || [])) {
    if (!r.perms || !Array.isArray(r.perms.pages)) continue;
    if (r.perms.gm) { // GM keeps everything; just make sure it has entertainment/war
      if (!r.perms.pages.includes('entertainment')) { r.perms.pages.push('entertainment'); changed = true; }
      if (!r.perms.pages.includes('war')) { r.perms.pages.push('war'); changed = true; }
      continue;
    }
    if (r.perms.pages.includes('timeline')) {
      r.perms.pages = r.perms.pages.filter(pg => pg !== 'timeline');
      changed = true;
    }
    for (const pg of STD_PAGES) {
      if (!r.perms.pages.includes(pg)) { r.perms.pages.push(pg); changed = true; }
    }
  }

  // Currency → Arcasian Koren (₳, code ARK). Ungated: only flips the old
  // default 'K' symbol, so a GM's custom symbol is left alone.
  if (world.settings) {
    if (world.settings.currency === 'K') { world.settings.currency = '₳'; changed = true; }
    if (world.settings.currencyName === 'Arcasian Mark' || !world.settings.currencyName) {
      world.settings.currencyName = 'Arcasian Koren'; changed = true;
    }
  }
  // The currency was once named the "Arcasian Mark"; correct that phrase
  // wherever it was baked into free text (entity/place descriptions, news),
  // keeping the ₳ symbol. Idempotent string replace.
  const fixMark = (obj, ...keys) => {
    for (const k of keys) {
      if (typeof obj[k] === 'string' && obj[k].includes('Arcasian Mark')) {
        obj[k] = obj[k].replace(/Arcasian Mark/g, 'Arcasian Koren');
        changed = true;
      }
    }
  };
  for (const e of (world.entities || [])) fixMark(e, 'description');
  for (const p of (world.provinces || [])) fixMark(p, 'description');
  for (const c of (world.cities || [])) fixMark(c, 'description');
  for (const pr of (world.properties || [])) fixMark(pr, 'description');
  for (const it of (world.items || [])) fixMark(it, 'description', 'name');
  for (const n of (world.news || [])) fixMark(n, 'headline', 'body');

  // GM-adjustable taxation (additive default; off until a GM enables it)
  if (world.settings && !world.settings.taxation) {
    world.settings.taxation = { enabled: false, corporateRate: 10, propertyRate: 0 };
    changed = true;
  }
  // VAT + gambling tax extend the taxation object (added later than the base).
  if (world.settings && world.settings.taxation) {
    const t = world.settings.taxation;
    if (t.vatRate === undefined) { t.vatRate = 0; changed = true; }          // % added to market purchases → treasury
    if (t.gamblingRate === undefined) { t.gamblingRate = 15; changed = true; } // % of gambling losses → treasury
  }

  // Every dossier (company / nation / person) is public knowledge — flip
  // companyFinancials on for every non-GM role so the files are fully
  // viewable. It stays a per-role toggle in the Roles editor, so a GM can
  // still lock a role down later. Idempotent (only flips false→true once the
  // world hasn't been hand-tuned away from it).
  if (!world._dossiersOpened) {
    for (const r of (world.roles || [])) {
      if (r.perms && !r.perms.gm && !r.perms.companyFinancials) { r.perms.companyFinancials = true; changed = true; }
    }
    world._dossiersOpened = true; changed = true;
  }

  // Entertainment & gambling venues (Phase 12). Seed two: a Satrom casino
  // (roulette + blackjack) and an ARC national lottery drawn every 3 turns.
  // GMs add/remove venues and CEOs tune odds. Additive; never clobbers a
  // GM's edits.
  if (world.settings && !world.settings.entertainment) {
    world.settings.entertainment = {
      venues: [
        {
          id: 'venue_satrom', name: 'Satrom Grand Casino', kind: 'casino',
          ownerId: 'ent_satrom', enabled: true,
          blurb: 'The Republic’s glittering house of chance, on the Lachevan strip.',
          games: ['roulette', 'blackjack'],
          minBet: 10, maxBet: 100000,
          // house edge knobs (CEO/GM adjustable): roulette pays true 35:1 on a
          // wheel with `greenSlots` zeros; blackjack pays `blackjackPays`.
          roulette: { greenSlots: 1 },
          blackjack: { blackjackPays: 1.5, dealerStandsOn: 17 }
        },
        {
          id: 'venue_arc_lottery', name: 'ARC National Lottery', kind: 'lottery',
          ownerId: 'ent_arc', enabled: true,
          blurb: 'A flutter for the Republic. Drawn every third turn — pick 3 numbers, 1 to 40.',
          ticketPrice: 50, pick: 3, maxNumber: 40, drawEveryTurns: 3,
          houseCutPct: 40,     // % of the pot ARC keeps; rest is the jackpot
          jackpotSeed: 100000, // pot floor each draw
          lastDrawTurn: 0, pot: 100000, tickets: [] // tickets: {userId, entityId, numbers, turn}
        }
      ]
    };
    changed = true;
  }

  // Workstream B — self-heal casino edit permission. The Satrom Grand Casino
  // must be owned by `ent_satrom` (privately controlled, CEO `per_hale`), not by
  // a government-controlled entity — otherwise the President's gov/ARC control
  // chain leaks in and the SATROM CEO is locked out. Additive & idempotent: only
  // corrects a drifted owner when `ent_satrom` still exists.
  if (world.settings && world.settings.entertainment) {
    const venues = world.settings.entertainment.venues || [];
    const satromCo = (world.entities || []).find(e => e.id === 'ent_satrom');
    const casino = venues.find(v => v.id === 'venue_satrom');
    if (satromCo && casino && casino.ownerId !== 'ent_satrom') { casino.ownerId = 'ent_satrom'; changed = true; }
    // A CEO pointing at a non-existent entity would deny the real CEO; restore
    // the seed's `per_hale` when the referenced entity is gone.
    if (satromCo && satromCo.ceoId && !(world.entities || []).some(e => e.id === satromCo.ceoId)
        && (world.entities || []).some(e => e.id === 'per_hale')) {
      satromCo.ceoId = 'per_hale'; changed = true;
    }
  }

  // War (Phase 15). Nothing structural is required — db.war is simply absent
  // until a GM starts one — but a malformed/legacy war doc (predating this
  // feature, or a hand-edited export missing `tick`) would crash the tick
  // loop, so self-heal by dropping it rather than surfacing an error.
  if (world.war && typeof world.war.tick !== 'number') {
    delete world.war;
    changed = true;
  }
  // Phase 16 — interactive War layer (bombs/craters). Additive: a war started
  // before this change simply lacks these fields until the next tick/order.
  if (world.war && !world.war.bombs) { world.war.bombs = { att: { cooldownUntil: 0 }, def: { cooldownUntil: 0 } }; changed = true; }
  if (world.war && !world.war.craters) { world.war.craters = []; changed = true; }
  // Phase 18 — deterministic shared engine. A war started before the engine
  // split has no PRNG seed; default it to the same value the engine falls
  // back to ((seed>>>0)||1), so server and predicting clients agree.
  if (world.war && typeof world.war.seed !== 'number') { world.war.seed = 1; changed = true; }

  // Reconcile ent_gov's ceoId/executives with whoever holds the 'president'
  // role, so live worlds pick up role changes made outside the normal API
  // paths (or before this feature existed) on next load. Lazy require avoids
  // a require cycle (sim.js requires store.js at module scope).
  try { if (require('./sim').syncPresidency(world, true)) changed = true; }
  catch (e) { /* sim module optional during early boot */ }

  // ---- one-time lore corrections (July 2026) ----
  if (!world._loreFixes1) {
    // 1. Fix SATROM ownership and description
    const satrom = (world.entities || []).find(e => e.id === 'ent_satrom');
    if (satrom) {
      if (satrom.ownerId !== 'for_sarom') { satrom.ownerId = 'for_sarom'; changed = true; }
      if (satrom.industry !== 'Defence & Electronics (Saromite)') { satrom.industry = 'Defence & Electronics (Saromite)'; changed = true; }
      const newDesc = 'Saromite defence-electronics conglomerate, headquartered in the Federation of Sarom. Its Arcasian presence is regional offices at Razno and the Satrom Grand Casino on the Lachevan strip — SATROM builds no weapons for the Republic.';
      if (satrom.description !== newDesc) { satrom.description = newDesc; changed = true; }
      const newShareholders = [{ entityId: 'for_sarom', shares: 500000 }, { entityId: 'per_hale', shares: 100000 }];
      if (!satrom.shareholders || satrom.shareholders.length !== 2 || satrom.shareholders[0].entityId !== 'for_sarom') {
        satrom.shareholders = newShareholders; changed = true;
      }
    }

    // 2. Fix SATROM Radar Works description
    const satromWorks = (world.properties || []).find(p => p.id === 'prop_satrom_works');
    if (satromWorks) {
      const newDesc = 'Radar arrays and precision instruments, built for export to the Federation of Sarom. Restricted site.';
      if (satromWorks.description !== newDesc) { satromWorks.description = newDesc; changed = true; }
    }

    // 3. Add Satrom Grand Casino if not present
    if (!(world.properties || []).find(p => p.id === 'prop_satrom_casino')) {
      world.properties.push({
        id: 'prop_satrom_casino', name: 'Satrom Grand Casino', type: 'commercial', kind: 'office',
        provinceId: 'prov_lachevan', pos: [2278, 499], ownerId: 'ent_satrom', value: 24000000,
        employees: 650, income: 300000, expenses: 140000,
        description: 'The Republic\'s glittering house of chance on the Lachevan strip, operated by the Saromite SATROM group.',
        inventory: [], vars: {}
      });
      changed = true;
    }

    // 4. Remove Port of Razno
    if ((world.properties || []).find(p => p.id === 'prop_razno_port')) {
      world.properties = world.properties.filter(p => p.id !== 'prop_razno_port');
      changed = true;
    }

    // 5. Rename Assembly of Nations to United Nations
    const assembly = (world.entities || []).find(e => e.id === 'org_assembly' || (e.type === 'org' && e.name === 'Assembly of Nations'));
    if (assembly) {
      if (assembly.name !== 'United Nations') { assembly.name = 'United Nations'; changed = true; }
      if (assembly.description !== 'The United Nations. Arcasia is a founding member.') {
        assembly.description = 'The United Nations. Arcasia is a founding member.'; changed = true;
      }
    }

    // 6. Fix GRACE membership status
    const grace = (world.entities || []).find(e => e.id === 'org_grace');
    if (grace) {
      if (grace.stance === 'Member') { grace.stance = 'Observer'; changed = true; }
    }

    // 7. Add users for named persons
    const newUsers = [
      { id: 'user_verenne', username: 'verenne', displayName: 'Ilya Verenne', roleId: 'mp', entityId: 'per_verenne' },
      { id: 'user_stahl', username: 'stahl', displayName: 'Gregor Stahl', roleId: 'mp', entityId: 'per_stahl' },
      { id: 'user_kandel', username: 'kandel', displayName: 'Rosa Kandel', roleId: 'mp', entityId: 'per_kandel' },
      { id: 'user_suri', username: 'suri', displayName: 'Aran Suri', roleId: 'mp', entityId: 'per_suri' },
      { id: 'user_hale', username: 'hale', displayName: 'Viktor Hale', roleId: 'executive', entityId: 'per_hale' },
      { id: 'user_keller', username: 'keller', displayName: 'Dana Keller', roleId: 'executive', entityId: 'per_keller' },
      { id: 'user_odek', username: 'odek', displayName: 'Baran Odek', roleId: 'executive', entityId: 'per_odek' },
      { id: 'user_grazi', username: 'grazi', displayName: 'Marta Grazi', roleId: 'executive', entityId: 'per_grazi' },
      { id: 'user_orn', username: 'orn', displayName: 'Pavel Orn', roleId: 'executive', entityId: 'per_orn' },
      { id: 'user_krenn', username: 'krenn', displayName: 'Halvard Krenn', roleId: 'judge', entityId: 'per_krenn' },
      { id: 'user_voss', username: 'voss', displayName: 'Gen. Petra Voss', roleId: 'military', entityId: 'per_voss' },
      { id: 'user_falk', username: 'falk', displayName: 'Erik Falk', roleId: 'police', entityId: 'per_falk' }
    ];
    for (const nu of newUsers) {
      if (!(world.users || []).find(u => u.username === nu.username) && !(world.users || []).find(u => u.entityId === nu.entityId)) {
        try {
          const { salt, hash } = require('./seed').hashPassword('arcasia');
          world.users.push({
            id: nu.id, username: nu.username, displayName: nu.displayName, salt, passHash: hash,
            roleId: nu.roleId, entityId: nu.entityId, created: Date.now(), lastLogin: null
          });
          changed = true;
        } catch (e) { /* hashPassword not available during early boot */ }
      }
    }

    // the SATROM share register changed above — re-reconcile the certificate
    // items now rather than waiting for the next load's early sync pass
    try { if (require('./market').syncAllCertificates(world)) changed = true; }
    catch (e) { /* market module optional during early boot */ }

    world._loreFixes1 = true; changed = true;
  }

  // ---- Phase 11 — one-time world-data update -----------------------------
  // Gated on schema so this block runs exactly once per world: fresh seeds
  // are born at schema 2 (see seed.js) and skip it entirely; a live world
  // loaded at schema 1 (or missing schema) runs it here and is bumped to 2,
  // so a second migrate() pass over the same world is a no-op.
  if ((world.schema || 1) < 2) {
    // 1. Remove the Kordistan FOREIGN POWER only — the domestic Kordi
    //    province and its city are untouched.
    const kordistanEntity = (world.entities || []).find(e => e.id === 'for_kordistan' || (e.type === 'foreign' && /^kordistan$/i.test(e.name || '')));
    if (kordistanEntity) {
      const kid = kordistanEntity.id;
      world.entities = world.entities.filter(e => e.id !== kid);
      world.accounts = (world.accounts || []).filter(a => a.ownerId !== kid);
      if (world.settings && world.settings.map) {
        if (Array.isArray(world.settings.map.countries)) {
          world.settings.map.countries = world.settings.map.countries.filter(c => c.entityId !== kid && !/^kordistan$/i.test(c.name || ''));
        }
        if (Array.isArray(world.settings.map.labels)) {
          world.settings.map.labels = world.settings.map.labels.filter(l => !/kordistan/i.test(l.text || ''));
        }
      }
      changed = true;
    }

    // 2. Currency rename is handled by the ungated migration above.

    // 3. (retired) the national profile card was removed — see the ungated
    //    cleanup below that deletes settings.country from live worlds.

    // 4. Rescale province populations ×2.79 and GDP ×2.686 — ONCE, guarded by
    //    the schema check above so re-running migrate() (e.g. every request
    //    in cloud mode) never double-applies this.
    for (const p of (world.provinces || [])) {
      if (p.demographics) {
        for (const gname in p.demographics) {
          const grp = p.demographics[gname];
          if (grp && typeof grp.population === 'number') grp.population = Math.round(grp.population * 2.79);
        }
      }
      if (p.vars && typeof p.vars.gdp === 'number') p.vars.gdp = Math.round(p.vars.gdp * 2.686);
      if (p.vars && p.demographics) {
        p.vars.population = Object.values(p.demographics).reduce((s, g) => s + (g.population || 0), 0);
      }
    }

    // 5. Clear President Valen as national leader (persona stays on file).
    const valen = (world.entities || []).find(e => e.id === 'per_valen');
    if (valen) {
      if (valen.title === 'President of the Republic') valen.title = 'Former President';
      if (valen.description) {
        valen.description = valen.description
          .replace(/President since 1958\.\s*/i, '')
          .replace(/^President of the Republic\.?\s*/i, 'Former President. ');
      }
      changed = true;
    }

    world.schema = 2;
    changed = true;
  }

  // ---- Phase 13 — production economy overhaul (schema < 3) ---------------
  // Converts the old flat monthly income/expenses into a per-turn production
  // model: each property either mints goods (its owner sells them) or generates
  // cash. Calibrates globalVars.gdpScale so GDP recomputed from production
  // equals the authored figure at turn 0. Seeds company CEO controls, the
  // government trade desk (settings.trade), economy tunables, and retires the
  // old event-driven profit generators. Runs exactly once (idempotent).
  if ((world.schema || 1) < 3 && world.properties && world.settings) {
    const items = world.items || [];
    const priceOf = (id) => { const it = items.find(i => i.id === id); return it ? (it.marketValue || 0) : 0; };
    const isGood = (id) => { const it = items.find(i => i.id === id); return it && ['Commodities', 'Goods', 'Military'].includes(it.category); };
    const KIND_ITEM = { mine: 'item_ore', farm: 'item_grain' };
    const PER_MONTH = 30; // turns the old monthly figures assumed

    // GDP contribution of a property per turn — shared with sim.js runEconomy.
    // Private firms are valued at output (goods value / cash); pure-cost public
    // properties (parliament, military, university…) are valued at cost, which
    // is how government output enters national accounts — this is what "ties
    // expenses into GDP".
    const propGross = (pr) => {
      if (pr.prodMode === 'goods') return (pr.produces || []).reduce((s, e) => s + e.perTurn * priceOf(e.itemId), 0);
      if (pr.prodMode === 'cash') return pr.cashPerTurn || 0;
      return pr.expenses || 0; // per-turn upkeep of public/idle assets
    };

    for (const pr of world.properties) {
      pr.expenses = Math.round((pr.expenses || 0) / PER_MONTH); // monthly → per-turn
      const perTurnRevenue = (pr.income || 0) / PER_MONTH;
      let goodId = (pr.inventory || []).map(r => r.itemId).find(isGood) || KIND_ITEM[pr.kind];
      if (goodId && !items.find(i => i.id === goodId)) goodId = null;
      if (perTurnRevenue <= 0) {
        pr.prodMode = 'none'; pr.produces = []; pr.cashPerTurn = 0;
      } else if (goodId && priceOf(goodId) > 0) {
        pr.prodMode = 'goods';
        pr.produces = [{ itemId: goodId, perTurn: Math.max(1, Math.round(perTurnRevenue / priceOf(goodId))) }];
        pr.targetRevenue = Math.round(perTurnRevenue);
        pr.cashPerTurn = 0;
      } else {
        pr.prodMode = 'cash'; pr.produces = []; pr.cashPerTurn = Math.round(perTurnRevenue);
      }
    }

    const nationalGross = world.properties.reduce((s, pr) => s + propGross(pr), 0);
    const authoredGdp = (world.globalVars && world.globalVars.gdp) ||
      world.provinces.reduce((s, p) => s + ((p.vars && p.vars.gdp) || 0), 0);
    world.globalVars = world.globalVars || {};
    world.globalVars.gdpScale = nationalGross > 0 ? Math.round((authoredGdp / nationalGross) * 1e6) / 1e6 : 1;

    // CEO controls
    for (const e of world.entities) {
      if (e.type !== 'company') continue;
      if (e.sellPct === undefined) e.sellPct = 100;   // % of production sold domestically
      if (e.govPct === undefined) e.govPct = 0;       // % sold to the government
      if (e.wage === undefined) e.wage = 100;         // wage index (100 = baseline)
    }

    // economy tunables (GM-adjustable later)
    world.settings.economy = world.settings.economy || {
      baseDailyWage: 4,      // ₳/employee/turn that a full wage-index swing represents
      wageHappinessK: 0.03,  // happiness nudge per (wage-100)/100 in operating provinces
      wageEmploymentK: 0.03  // employment nudge per (wage-100)/100
    };

    // government trade desk
    if (!world.settings.trade) {
      const COMMS = ['item_crude', 'item_fuel', 'item_ore', 'item_copper', 'item_grain', 'item_timber', 'item_cement'].filter(id => items.find(i => i.id === id));
      const priceMap = (f) => { const o = {}; for (const id of COMMS) o[id] = Math.round(priceOf(id) * f * 100) / 100; return o; };
      const partners = world.entities.filter(e => e.type === 'foreign').slice(0, 8);
      world.settings.trade = {
        govBuyPrices: priceMap(0.9), // government pays companies ~10% under market
        partners: partners.map((p, i) => ({
          entityId: p.id,
          tariff: 'Low',
          exports: ['item_crude', 'item_fuel', 'item_ore'].filter(id => items.find(x => x.id === id)),
          imports: [],
          prices: priceMap(1.03 + (i % 3) * 0.05), // slight per-partner spread, above market
          priceDrift: 0.05
        })),
        lastFlows: [], // [{ itemId, partnerId, qty, value }] filled by the engine
        history: []    // rolling per-turn totals for the trade graphs
      };
    }

    // retire the old event-driven profit generators (their applyEffect handlers
    // stay in sim.js as manual GM tools; these auto-scheduled events are gone).
    if (Array.isArray(world.events)) {
      const RETIRE = new Set(['ev_oil_amco', 'ev_oil_alko', 'ev_market', 'ev_property_pl', 'ev_corporate']);
      world.events = world.events.filter(ev => !RETIRE.has(ev.id));
      // GDP is now recomputed from production — drop the old employment→GDP
      // driver but keep its happiness effect.
      const drift = world.events.find(ev => ev.id === 'ev_econ_drift');
      if (drift && Array.isArray(drift.effects)) {
        drift.effects = drift.effects.filter(fx => !(fx.type === 'adjust_var' && fx.key === 'gdp'));
        drift.name = 'Employment → Happiness';
      }
      changed = true;
    }

    world.schema = 3;
    changed = true;
  }

  // ---- Phase 14 — trade & company-sales overhaul (schema < 4) -------------
  // Retires the twin sell%/gov% company controls in favour of a single
  // domestic↔government mix plus a keep-in-inventory slider and a per-company
  // "price to the state" multiplier; adds the government's standing offer to buy
  // from local companies (trade.govBuy), export price multipliers (trade.exports)
  // and partner demand/supply levels; folds any leftover export pool back into
  // the national stockpile (goods now land directly in gov.inventory). Once.
  if ((world.schema || 1) < 4 && world.settings) {
    for (const e of (world.entities || [])) {
      if (e.type !== 'company') continue;
      if (e.govMix === undefined) {
        const sell = e.sellPct === undefined ? 100 : e.sellPct;
        const gov = e.govPct === undefined ? 0 : e.govPct;
        const sold = sell + gov;
        e.govMix = sold > 0 ? Math.round(gov / sold * 100) : 0;   // gov share of what was sold
        if (e.keepPct === undefined) e.keepPct = Math.max(0, 100 - sold); // remainder was stockpiled
      }
      if (e.keepPct === undefined) e.keepPct = 0;
      if (e.govPriceMult === undefined) e.govPriceMult = 1;        // ask = retail × this
      if (e.govPctByItem && !e.govMixByItem) { e.govMixByItem = { ...e.govPctByItem }; delete e.govPctByItem; }
    }

    const t = world.settings.trade = world.settings.trade || { partners: [], lastFlows: [], history: [] };
    t.partners = t.partners || [];
    // partner demand (goods they buy from us) / supply (goods they sell us) levels
    for (const p of t.partners) {
      p.demand = p.demand || {};
      p.supply = p.supply || {};
      for (const iid of (p.exports || [])) if (p.demand[iid] === undefined) p.demand[iid] = 'Med';
      for (const iid of (p.imports || [])) if (p.supply[iid] === undefined) p.supply[iid] = 'Med';
    }
    t.govBuy = t.govBuy || {};       // itemId -> { qty, maxMult, byCompany:{ coId:{qty,maxMult} } }
    t.exports = t.exports || {};     // itemId -> { mult, off, byCountry:{ pid:mult } }
    if (Array.isArray(t.imports)) t.imports = t.imports.map(r => ({ ...r, maxMult: r.maxMult != null ? r.maxMult : 1.5 }));
    // fold any residual export pool into the national stockpile, then retire it
    if (t.exportPool) {
      const gov = (world.entities || []).find(e => e.id === 'ent_gov') || (world.entities || []).find(e => e.type === 'government');
      if (gov) {
        gov.inventory = gov.inventory || [];
        for (const iid in t.exportPool) {
          const q = Math.floor(t.exportPool[iid] || 0);
          if (q <= 0) continue;
          const row = gov.inventory.find(r => r.itemId === iid);
          if (row) row.qty += q; else gov.inventory.push({ itemId: iid, qty: q });
        }
      }
      delete t.exportPool;
    }
    delete t.exportAlloc;            // export split is retired (stockpile is gov.inventory)
    world.schema = 4;
    changed = true;
  }

  // ---- Phase 15 — open-market trade (schema < 5) --------------------------
  // Government purchasing, standing import orders and export rules are all
  // retired: foreign partners now post procedural buy/sell ORDERS every turn
  // (settings.trade.orders) that players fill by hand, with volume-sensitive
  // pricing. Company controls shrink to keepPct (inventory ↔ domestic split)
  // + wage; class demographics gain per-province structure (shares re-derived
  // from province character so provinces stop looking identical).
  if ((world.schema || 1) < 5 && world.settings) {
    for (const e of (world.entities || [])) {
      if (e.type !== 'company') continue;
      if (e.keepPct === undefined) e.keepPct = 0;
      delete e.sellPct; delete e.govPct; delete e.govPctByItem;
      delete e.govMix; delete e.govPriceMult; delete e.govMixByItem;
      delete e.fulfil; delete e.govFulfil;
    }
    const t = world.settings.trade;
    if (t) {
      delete t.govBuy; delete t.exports; delete t.imports;
      delete t.stockIn; delete t.lastExportFill; delete t.govBuyPrices;
      t.orders = t.orders || { turn: (world.settings.time || {}).turn || 0, buys: [], sells: [] };
      // Government trade tariffs: a global baseline plus additive per-country
      // and per-company surcharges, separate import/export rates. Empty = free
      // trade. Collected into the treasury by sim.executeTrade.
      t.tariffs = t.tariffs || { global: { import: 0, export: 0 }, byCountry: {}, byCompany: {} };
    }
    // Re-derive demographic group SHARES per province from its character
    // (urbanisation stays as authored; class mix now follows industry,
    // agriculture, education and wealth), preserving each province's total
    // population and per-group metrics. This is what makes provinces stop
    // sharing one identical 30/22/5/8/12 class split.
    for (const p of (world.provinces || [])) {
      const d = p.demographics;
      if (!d || !d['Working Class']) continue;
      const total = Object.values(d).reduce((s, g) => s + (g.population || 0), 0);
      if (!(total > 0)) continue;
      const v = p.vars || {};
      const ind = (v.industry || 50) / 100, agr = (v.agriculture || 50) / 100, edu = (v.education || 50) / 100;
      const urbanNow = (d['Urban'] && d['Urban'].population || 0);
      const ruralNow = (d['Rural'] && d['Rural'].population || 0);
      const urbanFrac = (urbanNow + ruralNow) > 0 ? urbanNow / (urbanNow + ruralNow) : 0.5;
      const income = d['Middle Class'] ? d['Middle Class'].income : 1000;
      const wealth = Math.max(0, Math.min(1, (income - 700) / 900)); // per-province wealth proxy
      let shares = {
        'Working Class': 0.24 + ind * 0.16,            // industrial provinces skew working-class
        'Middle Class': 0.14 + wealth * 0.14 + edu * 0.06,
        'Upper Class': 0.02 + wealth * 0.05,
        'Students': 0.04 + edu * 0.07,
        'Retired': 0.10 + (1 - ind) * 0.05,
        'Rural': (0.20 + agr * 0.10) * (1 - urbanFrac) * 2,
        'Urban': (0.20 + agr * 0.10) * urbanFrac * 2
      };
      const sum = Object.values(shares).reduce((s, x) => s + x, 0);
      for (const gname in shares) {
        if (!d[gname]) continue;
        d[gname].population = Math.round(total * shares[gname] / sum);
      }
      p.vars.population = Object.values(d).reduce((s, g) => s + (g.population || 0), 0);
    }
    // Calibrate the jobs→employment coupling per province so the AUTHORED
    // employment level is the equilibrium at the authored job count. (The old
    // global k=200 predates the ×2.79 population rescale, which is why every
    // province's employment was sliding to the 40% clamp floor.)
    for (const p of (world.provinces || [])) {
      const v = p.vars || {};
      if (!(v.population > 0) || !(v.employment > 0)) continue;
      const demand = (world.properties || []).filter(pr => pr.provinceId === p.id).reduce((s, pr) => s + (pr.employees || 0), 0);
      if (!(demand > 0)) continue;
      const force = v.population * 0.6;
      v.employmentK = Math.round(v.employment * force / (100 * demand));
    }
    world.schema = 5;
    changed = true;
  }

  // ---- Phase 16 — trade price multipliers + tariffs (schema < 6) ----------
  // Foreign-partner prices move to a MULTIPLIER off each item's global retail
  // value (item.marketValue), so a GM sets prices in one place and just tunes a
  // per-partner premium/discount. Existing absolute prices convert to the
  // equivalent multiplier. Also backfills the tariff schedule.
  if ((world.schema || 1) < 6 && world.settings) {
    const t = world.settings.trade;
    if (t) {
      t.tariffs = t.tariffs || { global: { import: 0, export: 0 }, byCountry: {}, byCompany: {} };
      const priceOf = (iid) => { const it = (world.items || []).find(x => x.id === iid); return it ? (it.marketValue || 0) : 0; };
      for (const p of (t.partners || [])) {
        p.priceMult = p.priceMult || {};
        for (const iid in (p.prices || {})) {
          if (p.priceMult[iid] !== undefined) continue;
          const retail = priceOf(iid);
          p.priceMult[iid] = retail > 0 && p.prices[iid] > 0
            ? Math.round(p.prices[iid] / retail * 100) / 100 : 1;
        }
      }
    }
    world.schema = 6;
    changed = true;
  }

  // ---- Phase 26 — the Republic's arms industry + national fuel reserves ---
  // One-shot (flag-gated), additive; sits AFTER the schema<3 production
  // conversion so the factory's per-turn prodMode figures are never
  // re-interpreted as old monthly ones.
  //   · The seeded Arcasian service rifle becomes the ARC M38 Bolt Action —
  //     an older, humbler pattern (the GM tunes exact stats from the item
  //     Metadata editor whenever it likes).
  //   · ARC (the state corporation) gets an arms factory that PRODUCES the
  //     rifle every turn. Its keepPct slice accrues in the site inventory,
  //     and because the site is type 'military' that depot both garrisons in
  //     wartime and feeds the per-unit resupply pass (server/war.js
  //     nationPools) — bomb the factory and the army's rifle supply dies
  //     with it.
  //   · Every armed foreign power gets a fuel reserve, so its expeditionary
  //     units drain their OWN national stockpile exactly like the Republic's
  //     do (the Republic's reserve shipped with the weapons seed above).
  if (!world._arcArms && Array.isArray(world.items) && Array.isArray(world.properties)) {
    const rifle = world.items.find(i => i.id === 'item_gun_arc_m58');
    if (rifle) {
      rifle.name = 'ARC M38 Bolt Action';
      rifle.description = 'ARC-pattern bolt-action service rifle, model of 1938. Slow, honest, everywhere.';
      rifle.marketValue = 170;
      if (rifle.meta && rifle.meta.weapon) Object.assign(rifle.meta.weapon, { dmg: 0.12, hp: 0.08, morale: 0.05 });
    }
    if (!world.properties.some(p => p.id === 'prop_arc_arms')) {
      world.properties.push({
        id: 'prop_arc_arms', name: 'ARC Arms Works', type: 'military', kind: 'factory',
        provinceId: 'prov_mezdov', pos: [412, 356], ownerId: 'ent_arc',
        value: 20000000, employees: 1400, income: 0, expenses: 4500,
        prodMode: 'goods', produces: [{ itemId: 'item_gun_arc_m58', perTurn: 40 }], cashPerTurn: 0,
        description: 'State arsenal of the Republic — ARC-run production line for the M38 service rifle. Its yard depot feeds the army in wartime.',
        inventory: [], vars: {}
      });
    }
    // A keep-in-stock slice of production accrues on-site (sim.js runEconomy
    // reads the owning company's keepPct); ARC's other holdings produce no
    // goods, so this only shapes the arsenal.
    const arc = (world.entities || []).find(e => e.id === 'ent_arc');
    if (arc && !(arc.keepPct > 0)) arc.keepPct = 50;
    if (world.items.some(i => i.id === 'item_fuel')) {
      const fuelFor = ['for_sarom', 'for_madrosia', 'for_valksland', 'for_delcasia', 'for_qinal', 'for_karaznia', 'for_estal'];
      for (const fid of fuelFor) {
        const e = (world.entities || []).find(x => x.id === fid);
        if (!e) continue;
        e.inventory = e.inventory || [];
        if (!e.inventory.some(r => r.itemId === 'item_fuel')) e.inventory.push({ itemId: 'item_fuel', qty: 600 });
      }
    }
    world._arcArms = true;
    changed = true;
  }

  // Move ARC Arms Works from Mezdov to Lachevan. One-shot flag-gated.
  // v2: positions in a LIVE world are on the 3840×2160 master grid (applyMap
  // rescales seed coords), so hardcoded seed-space coords put the factory in
  // the wrong province — derive the spot from the capital city's CURRENT pos
  // instead, and fall back to the city's own provinceId if point-in-polygon
  // can't resolve.
  if (!world._armsWorksMoved2 && Array.isArray(world.properties)) {
    const armsWorks = world.properties.find(p => p.id === 'prop_arc_arms');
    const capital = (world.cities || []).find(c => c.id === 'city_lachevan') ||
                    (world.cities || []).find(c => c.isCapital);
    if (armsWorks && capital && Array.isArray(capital.pos)) {
      armsWorks.pos = [capital.pos[0] + 66, capital.pos[1] + 130]; // industrial fringe just south-east of the capital
      try {
        const geometry = require('./geometry');
        const pid = geometry.provinceAt(world.provinces || [], armsWorks.pos);
        armsWorks.provinceId = pid || capital.provinceId || armsWorks.provinceId;
      } catch (e) { armsWorks.provinceId = capital.provinceId || armsWorks.provinceId; }
      changed = true;
    }
    world._armsWorksMoved = true; // keep the legacy v1 flag set so the old block never fires on old worlds
    world._armsWorksMoved2 = true;
  }

  // ---- Phase 26 — retire the generic "Weapons (crate)" trade good ---------
  // Real gun models with meta.weapon stats ARE the military economy now
  // (national stockpiles arm units directly); a stats-less catch-all crate
  // just muddies the arsenal. One-shot, flag-gated: drop the item and scrub
  // every reference — inventories, production lines, foreign-trade config,
  // the open order book, and pending trade offers that promised crates.
  if (!world._weaponsCrateRetired) {
    const WID = 'item_weapons';
    if ((world.items || []).some(i => i.id === WID)) {
      world.items = world.items.filter(i => i.id !== WID);
      for (const holder of [...(world.entities || []), ...(world.properties || [])]) {
        if (Array.isArray(holder.inventory)) holder.inventory = holder.inventory.filter(r => r.itemId !== WID);
      }
      for (const p of (world.properties || [])) {
        if (Array.isArray(p.produces)) p.produces = p.produces.filter(x => x.itemId !== WID);
      }
      const t = (world.settings || {}).trade;
      if (t) {
        for (const p of (t.partners || [])) {
          for (const k of ['exports', 'imports']) if (Array.isArray(p[k])) p[k] = p[k].filter(id => id !== WID);
          for (const k of ['prices', 'priceMult', 'demand', 'supply']) if (p[k]) delete p[k][WID];
        }
        if (t.govBuyPrices) delete t.govBuyPrices[WID];
        if (t.orders) for (const k of ['buys', 'sells']) {
          if (Array.isArray(t.orders[k])) t.orders[k] = t.orders[k].filter(o => o.itemId !== WID);
        }
      }
      if (Array.isArray(world.trades)) {
        world.trades = world.trades.filter(tr => tr.status !== 'open' ||
          !([...(tr.give || []), ...(tr.get || [])].some(r => r.itemId === WID)));
      }
    }
    world._weaponsCrateRetired = true;
    changed = true;
  }

  // ---- Phase 27 — war overhaul: company profit tied strictly to properties -
  // Before this, a company that lost every property to war (or never had one
  // settled through runEconomy) just kept whatever vars.revenue/profit it was
  // last authored with — runEconomy only touches owners that own ≥1 property.
  // sim.js now zeroes revenue and bleeds cash for zero-property companies every
  // turn; this one-shot migration is the other half — it rebalances each
  // company's EXISTING properties (produces perTurn / cashPerTurn / employees /
  // expenses, scaled together so the ratio of revenue to cost is preserved) so
  // the property-derived annual revenue matches the company's authored
  // vars.revenue at the moment of migration. Without this, flipping runEconomy
  // to be property-only would have silently slashed every company's income to
  // whatever its (uncalibrated) properties happened to produce. Skips companies
  // with zero properties outright (nothing to scale) and companies whose
  // authored revenue is already ~0.
  if (!world._companyProfitRebalance && Array.isArray(world.entities) && Array.isArray(world.properties)) {
    const items = world.items || [];
    const priceOf = (id) => { const it = items.find(i => i.id === id); return it ? (it.marketValue || 0) : 0; };
    for (const co of (world.entities || [])) {
      if (co.type !== 'company') continue;
      co.vars = co.vars || {};
      const props = world.properties.filter(p => p.ownerId === co.id);
      if (!props.length) continue; // nothing to rebalance — sim.js's zero-property pass takes over
      let propRevenuePerTurn = 0, propExpensePerTurn = 0;
      for (const pr of props) {
        if (pr.prodMode === 'goods') propRevenuePerTurn += (pr.produces || []).reduce((s, e) => s + (e.perTurn || 0) * priceOf(e.itemId), 0);
        else if (pr.prodMode === 'cash') propRevenuePerTurn += pr.cashPerTurn || 0;
        propExpensePerTurn += pr.expenses || 0;
      }
      // NOTE (production-inflation fix): the earlier version of this block
      // scaled every property's physical produces/cashPerTurn UP so that
      // property output valued at wholesale `marketValue` matched the
      // company's annualised, RETAIL-priced vars.revenue. That compared two
      // different price bases and over-corrected 5–7×, which pumped Arcasian
      // oil output to absurd levels (a refinery minting ~15k barrels/turn) and
      // dragged national GDP from its authored ~13B up to ~68B (GDP is derived
      // from production). Physical output is now left at its schema<3 seed
      // calibration; profit is tied to properties purely through runEconomy
      // (a company that loses properties loses the revenue those properties
      // booked), and GDP is re-pinned to its authored target by the
      // `_gdpTargetRecal` block below. Only the overhead baseline is kept here.
      // Corporate overhead — a small admin-cost baseline independent of any one
      // property (HQ upkeep, executive salaries…), charged even with zero
      // properties left so a war that strips a company bare actually hurts its
      // cash, not just its income. Calibrated as a modest slice of its
      // pre-rebalance property expense footprint.
      co.vars.overheadPerTurn = Math.round(propExpensePerTurn * 0.12 * 100) / 100;
    }
    world._companyProfitRebalance = true;
    changed = true;
  }

  // ---- Phase 27 — war overhaul: armour & sea power items ------------------
  // Tank and warship items, following the Phase 23 gun template (meta.weapon,
  // meta.originId). Stats deliberately vary a great deal between models —
  // these feed the war engine's combat math (server/war-engine.js), which
  // this migration has no knowledge of. One-shot, flag-gated, additive.
  if (!world._armorNavySeeded && Array.isArray(world.items)) {
    const mkVeh = (id, name, kind, originId, stats, value, desc) => ({
      id, icon: kind === 'tank' ? 'V' : 'N', name, category: 'Military', tradable: true, marketValue: value,
      meta: { weapon: { kind, ...stats }, originId }, description: desc
    });
    const vehicles = [
      mkVeh('item_tank_m36griz', 'M36 "Griz" Tank', 'tank', null,
        { model: 'M36 Griz', dmg: 0.22, hp: 0.30, armor: 0.25, speed: 0.30, fuelUse: 0.5 }, 4200,
        'Arcasian heavy tank of 1936. A 76mm gun behind 100mm of frontal plate — cheap, simple, and thoroughly outclassed by 1962.'),
      mkVeh('item_tank_satrom42e', '"Muhit" Satrom Model \'42E Tank', 'tank', 'for_sarom',
        { model: "Satrom '42E", dmg: 0.45, hp: 0.55, armor: 0.50, speed: 0.35, fuelUse: 0.9 }, 9500,
        'Old Saromese export pattern. An 88mm cannon behind 180mm of frontal armour; the oil-hungry engine drinks fuel fast, but it is cheap and plentiful on the second-hand market.'),
      mkVeh('item_tank_type50m', 'Type 50M Tank', 'tank', 'for_qinal',
        { model: 'Type 50M', dmg: 0.78, hp: 0.85, armor: 0.70, speed: 0.40, fuelUse: 1.1 }, 32000,
        'Modern Qinali export. A stabilised 120mm gun with electronic sights behind 200mm of armour — expensive, thirsty, and far ahead of anything else in the region.'),
      mkVeh('item_warship_kradon', 'Kradon-class Cruiser', 'warship', null,
        { model: 'Kradon-class', dmg: 0.30, hp: 0.40, range: 0.30, speed: 0.25 }, 60000,
        'Very old Arcasian design out of the Kradon yards. Slow, lightly armed, and still the pride of the Eastern Fleet for lack of anything newer.'),
      mkVeh('item_warship_madrosian', 'Madrosian Frigate', 'warship', 'for_madrosia',
        { model: 'Madrosian Frigate', dmg: 0.50, hp: 0.60, range: 0.50, speed: 0.45 }, 95000,
        'Fast, well-armed frigate of the Madrosian merchant marine\'s escort fleet — the backbone of a small nation with an outsized navy.'),
      mkVeh('item_warship_valkslandic', 'Valkslandic Dreadnought', 'warship', 'for_valksland',
        { model: 'Valkslandic Dreadnought', dmg: 0.85, hp: 0.90, range: 0.70, speed: 0.40 }, 220000,
        'A capital ship of the Valksland fleet — heavily armoured, heavily gunned, and priced accordingly. Nothing in the region can match it hull-for-hull.')
    ];
    for (const v of vehicles) if (!world.items.some(i => i.id === v.id)) world.items.push(v);
    world._armorNavySeeded = true;
    changed = true;
  }

  // Republic standing arsenal — a modest peacetime stock of home-built armour
  // and hulls so that armour and warships actually take the field when a war
  // starts (the ARC Arms Works and Kradon Shipyards produce these only a
  // fraction at a time, so on a fresh 1962 world the national stockpile would
  // otherwise hold zero and deployArsenalUnits would field nothing). One-shot,
  // additive: only grants what isn't already there, and only if the items exist.
  if (!world._republicArsenalSeeded && Array.isArray(world.entities)) {
    const gov = world.entities.find(e => e.id === 'ent_gov');
    if (gov && world.items.some(i => i.id === 'item_tank_m36griz') && world.items.some(i => i.id === 'item_warship_kradon')) {
      gov.inventory = gov.inventory || [];
      const grant = (itemId, qty) => { const r = gov.inventory.find(x => x.itemId === itemId); if (r) r.qty = Math.max(r.qty || 0, qty); else gov.inventory.push({ itemId, qty }); };
      grant('item_tank_m36griz', 80);   // ~3 M36 "Griz" armoured divisions' worth (25 tanks each), the ageing home-built fleet
      grant('item_warship_kradon', 3);  // three Kradon-class cruisers — "the pride of the Eastern Fleet for lack of anything newer"
      world._republicArsenalSeeded = true;
      changed = true;
    }
  }

  // ---- Phase 27 — war overhaul: foreign military profiles ------------------
  // entity.meta.military = { navy, army, size, focus, alliance, allies,
  // importsFrom } drives BOTH the per-turn off-books production in sim.js
  // (runForeignMilitary) and whatever the war engine reads for grand-strategy
  // sizing. Purely data — skips gracefully if a nation isn't in this world.
  if (!world._militaryProfilesSeeded && Array.isArray(world.entities)) {
    const setMil = (id, mil) => {
      const e = world.entities.find(x => x.id === id);
      if (!e) return; // nation not present in this world — skip gracefully
      e.meta = e.meta || {};
      if (!e.meta.military) e.meta.military = mil;
    };
    setMil('ent_gov', { navy: 'weak', army: 'medium', size: 'medium', focus: 'size', alliance: null, allies: [], importsFrom: [] }); // Arcasia is independent — no standing alliances
    setMil('for_madrosia', { navy: 'strong', army: 'weak', size: 'small', focus: 'size', alliance: null, allies: [], importsFrom: [] });
    setMil('for_mazon', { navy: 'weak', army: 'weak', size: 'small', focus: 'size', alliance: null, allies: [], importsFrom: ['for_madrosia'] });
    setMil('for_karaznia', { navy: 'weak', army: 'medium', size: 'medium', focus: 'size', alliance: 'GRACE', allies: ['for_aragonia', 'for_markasia'], importsFrom: [] });
    setMil('for_aragonia', { navy: 'weak', army: 'medium', size: 'medium', focus: 'size', alliance: 'GRACE', allies: ['for_karaznia', 'for_markasia'], importsFrom: ['for_karaznia'] });
    setMil('for_markasia', { navy: 'weak', army: 'weak', size: 'medium', focus: 'size', alliance: 'GRACE', allies: ['for_karaznia', 'for_aragonia'], importsFrom: ['for_karaznia'] });
    setMil('for_valksland', { navy: 'strong', army: 'strong', size: 'big', focus: 'size', alliance: null, allies: ['for_qinal'], importsFrom: [] });
    setMil('for_solme', { navy: 'weak', army: 'medium', size: 'small', focus: 'size', alliance: null, allies: ['for_qinal', 'for_valksland'], importsFrom: [] });
    setMil('for_aldonesia', { navy: 'strong', army: 'strong', size: 'tiny', focus: 'quality', alliance: null, allies: ['for_sarom'], importsFrom: [] });
    setMil('for_iceland', { navy: 'none', army: 'none', size: 'tiny', focus: 'size', alliance: null, allies: ['for_sarom'], importsFrom: [] });
    // Not explicitly specced, but both nations own the tank export models
    // above and are alliance anchors for others — without a profile of their
    // own they would never actually produce the tanks their items imply.
    setMil('for_qinal', { navy: 'medium', army: 'strong', size: 'big', focus: 'quality', alliance: null, allies: ['for_valksland', 'for_solme'], importsFrom: [] });
    setMil('for_sarom', { navy: 'medium', army: 'strong', size: 'medium', focus: 'quality', alliance: null, allies: ['for_aldonesia', 'for_iceland'], importsFrom: [] });
    world._militaryProfilesSeeded = true;
    changed = true;
  }

  // Foreign starting arsenals — every foreign power with a military profile
  // begins with a peacetime stockpile matching its profile (feature: "starting
  // weapons profile"; and it keeps war units — including scenario attacker
  // armour — equipped from turn zero, now that units draw guns/tanks from the
  // national stockpile as supply). Quantities scale by size × army/navy; a
  // nation with `importsFrom` stocks the exporter's rifle/tank pattern; a
  // nation that already owns a pattern complements THAT rather than adding a
  // second type. MUST run AFTER the military-profile block above, since it
  // reads e.meta.military. One-shot, additive.
  if (!world._foreignArsenalsSeeded && Array.isArray(world.entities)) {
    const SIZE = { tiny: 0.4, small: 0.7, medium: 1, big: 1.8 };
    const STR = { none: 0, weak: 0.5, medium: 1, strong: 1.8 };
    const wpnOf = (kind, originId) => (world.items || []).find(i => i.meta && i.meta.weapon && i.meta.weapon.kind === kind && i.meta.originId === originId);
    const heldOf = (e, kind) => (e.inventory || []).map(r => (world.items || []).find(i => i.id === r.itemId)).find(i => i && i.meta && i.meta.weapon && i.meta.weapon.kind === kind);
    const genericGun = (world.items || []).find(i => i.meta && i.meta.weapon && (i.meta.weapon.kind || 'smallarms') === 'smallarms');
    for (const e of world.entities) {
      if (e.type !== 'foreign') continue;
      const mil = e.meta && e.meta.military; if (!mil) continue;
      const sm = SIZE[mil.size] !== undefined ? SIZE[mil.size] : 1;
      const army = STR[mil.army] !== undefined ? STR[mil.army] : 0;
      const navy = STR[mil.navy] !== undefined ? STR[mil.navy] : 0;
      if (!army && !navy) continue; // no armed forces (e.g. Iceland)
      e.inventory = e.inventory || [];
      const grant = (itemId, qty) => { if (!itemId || !(qty > 0)) return; const r = e.inventory.find(x => x.itemId === itemId); if (r) r.qty = (r.qty || 0) + Math.round(qty); else e.inventory.push({ itemId, qty: Math.round(qty) }); };
      // fuel
      grant('item_fuel', 400 * sm * ((army + navy) / 2 || 0.5));
      // rifles — own pattern, else imported, else the generic model; complement existing stock
      if (army > 0) {
        let gun = heldOf(e, 'smallarms') || wpnOf('smallarms', e.id);
        if (!gun && Array.isArray(mil.importsFrom)) for (const s of mil.importsFrom) { gun = wpnOf('smallarms', s); if (gun) break; }
        grant((gun || genericGun || {}).id, 900 * sm * army);
      }
      // tanks — strong armies / quality-focused mediums, own or imported
      // pattern, falling back to a generic export tank (the Satrom '42E is
      // literally "designated for export", else any tank in the catalogue) so a
      // tank-fielding power without its own model still puts armour in the field.
      const wantsTanks = mil.army === 'strong' || (mil.focus === 'quality' && army >= STR.medium);
      if (wantsTanks) {
        let tank = heldOf(e, 'tank') || wpnOf('tank', e.id);
        if (!tank && Array.isArray(mil.importsFrom)) for (const s of mil.importsFrom) { tank = wpnOf('tank', s); if (tank) break; }
        if (!tank && Array.isArray(mil.allies)) for (const s of mil.allies) { tank = wpnOf('tank', s); if (tank) break; }
        if (!tank) tank = (world.items || []).find(i => i.id === 'item_tank_satrom42e') || (world.items || []).find(i => i.meta && i.meta.weapon && i.meta.weapon.kind === 'tank');
        grant((tank || {}).id, 60 * sm * army);
      }
      // warships — strong navies, own pattern
      if (mil.navy === 'strong') {
        const ship = heldOf(e, 'warship') || wpnOf('warship', e.id);
        grant((ship || {}).id, Math.max(2, Math.round(3 * sm * navy)));
      }
    }
    world._foreignArsenalsSeeded = true;
    changed = true;
  }

  // ---- Valksland arsenal correction -----------------------------------------
  // The foreign-arsenals seeding armed Valksland with Saromese '42E tanks via
  // the generic export fallback — kit bought from a hostile power. Swap that
  // stock for Qinali Type-7 rifles (Qinal is Valksland's ally) of equivalent
  // market value. One-shot; a world whose Valksland never held the tanks (or
  // that was reseeded after the allies-aware fallback above) is a clean no-op.
  if (!world._valksArsenalFix && Array.isArray(world.entities)) {
    const valks = world.entities.find(e => e.id === 'for_valksland');
    const tank = (world.items || []).find(i => i.id === 'item_tank_satrom42e');
    const rifle = (world.items || []).find(i => i.id === 'item_gun_qinal_type7');
    if (valks && Array.isArray(valks.inventory) && rifle) {
      const row = valks.inventory.find(r => r.itemId === 'item_tank_satrom42e');
      if (row && row.qty > 0) {
        const rifles = Math.max(1, Math.round(((tank && tank.marketValue) || 9500) * row.qty / ((rifle.marketValue) || 180)));
        valks.inventory = valks.inventory.filter(r => r.itemId !== 'item_tank_satrom42e');
        const rr = valks.inventory.find(r => r.itemId === 'item_gun_qinal_type7');
        if (rr) rr.qty = (rr.qty || 0) + rifles; else valks.inventory.push({ itemId: 'item_gun_qinal_type7', qty: rifles });
      }
    }
    world._valksArsenalFix = true;
    changed = true;
  }

  // ---- Phase 27 — war overhaul: manufacture at properties -------------------
  // ARC Arms Works gains a slow tank line alongside its existing rifle line
  // (fractional perTurn — runEconomy's Math.round(perTurn × outputFactor)
  // already turns a 0.5/turn line into "about one every other turn" via the
  // existing per-turn output wobble, same mechanism the rest of the economy
  // uses). Kradon Shipyards switches from a flat cash office into a goods
  // producer of the Kradon-class warship, VERY slowly.
  if (!world._arcArmsTank && Array.isArray(world.properties)) {
    const arms = world.properties.find(p => p.id === 'prop_arc_arms');
    if (arms && world.items.some(i => i.id === 'item_tank_m36griz')) {
      arms.produces = arms.produces || [];
      if (!arms.produces.some(e => e.itemId === 'item_tank_m36griz')) {
        arms.produces.push({ itemId: 'item_tank_m36griz', perTurn: 0.5 });
      }
      arms.prodMode = 'goods';
    }
    world._arcArmsTank = true;
    changed = true;
  }
  if (!world._kradonShipyardWarship && Array.isArray(world.properties)) {
    const yard = world.properties.find(p => p.id === 'prop_shipyards');
    if (yard && world.items.some(i => i.id === 'item_warship_kradon')) {
      yard.prodMode = 'goods';
      yard.produces = [{ itemId: 'item_warship_kradon', perTurn: 0.02 }]; // ~1 hull every 50 turns
      yard.cashPerTurn = 0;
    }
    world._kradonShipyardWarship = true;
    changed = true;
  }

  // ---- Phase 27 — war overhaul: foreign tanks as an import option ----------
  // The government can buy Satrom '42E tanks from Sarom and Type 50M tanks
  // from Qinal through the same procedural order-book every other import
  // flows through (settings.trade.partners[].imports/supply/priceMult — see
  // generateTradeOrders in sim.js). Additive; skips a partner that isn't in
  // this world's trade desk.
  if (!world._tankTradeSeeded && world.settings && world.settings.trade && Array.isArray(world.settings.trade.partners)) {
    const addImport = (entityId, itemId, supplyLevel, mult) => {
      const p = world.settings.trade.partners.find(x => x.entityId === entityId);
      if (!p || !world.items.some(i => i.id === itemId)) return;
      p.imports = p.imports || [];
      if (!p.imports.includes(itemId)) p.imports.push(itemId);
      p.supply = p.supply || {}; if (p.supply[itemId] === undefined) p.supply[itemId] = supplyLevel;
      p.priceMult = p.priceMult || {}; if (p.priceMult[itemId] === undefined) p.priceMult[itemId] = mult;
    };
    addImport('for_sarom', 'item_tank_satrom42e', 'Low', 1.1);
    addImport('for_qinal', 'item_tank_type50m', 'Low', 1.25);
    world._tankTradeSeeded = true;
    changed = true;
  }

  // ---- GDP re-pin ----------------------------------------------------------
  // globalVars.gdpScale converts per-turn production gross into national GDP
  // (sim.js updateDerived/runEconomy). It was calibrated ONCE at the schema<3
  // block above against the seed's production — but later migrations (the
  // company-profit rebalance, the ARC/Kradon military production lines, the
  // arms/tank items) all changed total production WITHOUT re-deriving the
  // scale, so GDP drifted far from its authored figure (it had ballooned to
  // ~68B against a ~13B seed target). This block re-pins gdpScale so the
  // recomputed GDP lands on GDP_TARGET again, then writes the matching
  // province gdp vars + globalVars.gdp so the value is correct on load without
  // waiting for the first turn. Idempotent: it recomputes from CURRENT
  // production every run and converges (re-running with production unchanged
  // reproduces the same scale). Runs LAST so every other production-touching
  // migration has already settled.
  {
    const GDP_TARGET = 13000; // authored seed GDP (₳13B; see the pre-1962 history seed, ~13k at turn 0)
    const items = world.items || [];
    const priceOf = (id) => { const it = items.find(i => i.id === id); return it ? (it.marketValue || 0) : 0; };
    const propGross = (pr) => {
      if (pr.prodMode === 'goods') return (pr.produces || []).reduce((s, e) => s + (e.perTurn || 0) * priceOf(e.itemId), 0);
      if (pr.prodMode === 'cash') return pr.cashPerTurn || 0;
      return pr.expenses || 0;
    };
    if (Array.isArray(world.properties) && world.properties.length) {
      world.globalVars = world.globalVars || {};
      const nationalGross = world.properties.reduce((s, pr) => s + propGross(pr), 0);
      const newScale = nationalGross > 0 ? Math.round((GDP_TARGET / nationalGross) * 1e6) / 1e6 : (world.globalVars.gdpScale || 1);
      // Only rewrite when it actually moved (keeps `changed` honest and avoids
      // a save every boot once it has converged).
      if (Math.abs((world.globalVars.gdpScale || 0) - newScale) > 1e-6) {
        world.globalVars.gdpScale = newScale;
        // Re-derive each province's gdp var from the production sited in it,
        // then the national total — mirrors sim.js's per-turn computation so
        // the charts read right immediately.
        if (Array.isArray(world.provinces)) {
          const grossByProv = {};
          for (const pr of world.properties) { const pid = pr.provinceId; if (!pid) continue; grossByProv[pid] = (grossByProv[pid] || 0) + propGross(pr); }
          let total = 0;
          for (const p of world.provinces) { p.vars = p.vars || {}; p.vars.gdp = Math.round((grossByProv[p.id] || 0) * newScale * 100) / 100; total += p.vars.gdp; }
          world.globalVars.gdp = Math.round(total * 100) / 100;
        }
        changed = true;
      }
    }
  }

  return changed;
}

/* ---------- row mapping (cloud tables use snake_case columns) ---------- */
const tlRow = (e) => ({ id: e.id, ts: e.ts, turn: e.turn, sim_date: e.simDate, type: e.type, title: e.title, detail: e.detail, actor: e.actor, refs: e.refs || [] });
const fromTlRow = (r) => ({ id: r.id, ts: Number(r.ts), turn: r.turn, simDate: r.sim_date, type: r.type, title: r.title, detail: r.detail, actor: r.actor, refs: r.refs || [] });
const txRow = (t) => ({ id: t.id, ts: t.ts, turn: t.turn, sim_date: t.simDate, from_acct: t.from, to_acct: t.to, amount: t.amount, memo: t.memo, actor: t.actor, kind: t.kind });
const fromTxRow = (r) => ({ id: r.id, ts: Number(r.ts), turn: r.turn, simDate: r.sim_date, from: r.from_acct, to: r.to_acct, amount: Number(r.amount), memo: r.memo, actor: r.actor, kind: r.kind });

// The world doc stored in Postgres excludes the two append-only logs.
function coreDoc() {
  return { ...db, timeline: [], transactions: [] };
}

/* ---------- lifecycle ---------- */
function configure(seed) { seedFn = seed; }

// Long-lived entry point (server.js). In file mode this loads the world now;
// in cloud mode begin() does the work per request.
async function load(seed, reseed) {
  configure(seed);
  if (MODE === 'file') {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    if (!reseed && fs.existsSync(DB_FILE)) { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); if (migrate(db)) saveNow(); }
    else { db = seedFn(); migrate(db); saveNow(); } // run migrations on a fresh seed too, so structural upgrades live only in migrate()
    return db;
  }
  if (reseed) await reset(seedFn);
  else await begin();
  return db;
}

// Per-request entry point. Loads the world (or reuses the warm in-memory
// copy when the stored version hasn't changed) and resets pending buffers.
async function begin() {
  if (MODE === 'file') {
    if (!db) await load(seedFn);
    return db;
  }
  pendingTimeline = []; pendingTxns = []; pendingSnapshot = null;
  dirty = false; broadcastPending = false;

  const meta = await sb.select('world', 'id=eq.1&select=version');
  if (!meta || !meta.length) return firstSeed();

  if (!db || Number(meta[0].version) !== version) {
    const rows = await sb.select('world', 'id=eq.1&select=version,doc');
    version = Number(rows[0].version);
    db = rows[0].doc;
    const tl = await sb.select('timeline', `select=*&order=ts.desc&limit=${LOG_FETCH}`);
    db.timeline = tl.reverse().map(fromTlRow);
    const tx = await sb.select('transactions', `select=*&order=ts.desc&limit=${LOG_FETCH}`);
    db.transactions = tx.reverse().map(fromTxRow);
    if (migrate(db)) save();
  }
  return db;
}

async function firstSeed() {
  db = seedFn(); migrate(db);
  const seedTl = db.timeline.slice();
  const seedTx = db.transactions.slice();
  version = Date.now();
  await sb.insert('world', [{ id: 1, version, doc: coreDoc() }]);
  await sb.upsert('world_version', [{ id: 1, version }]).catch(() => { }); // realtime signal table; optional on older deployments
  if (seedTl.length) await sb.insert('timeline', seedTl.map(tlRow));
  if (seedTx.length) await sb.insert('transactions', seedTx.map(txRow));
  dirty = false;
  return db;
}

// Flush everything this request changed, then ping clients. Cloud mode only;
// in file mode the debounced save() already covers persistence and SSE covers
// the ping.
async function commit() {
  if (MODE === 'file') return;
  try {
    if (dirty) {
      // CAS write: only succeeds if nobody else committed since our begin()
      // loaded `version`. A 0-row result means a concurrent request won —
      // throw so the caller retries against fresh state instead of clobbering it.
      const newVersion = Math.max(Date.now(), version + 1);
      const rows = await sb.updateRep('world', 'id=eq.1&version=eq.' + version, { version: newVersion, doc: coreDoc() });
      if (!rows || !rows.length) {
        const err = new Error('world version conflict');
        err.code = 'WORLD_CONFLICT';
        throw err;
      }
      version = newVersion;
    }
    // Only reached once the CAS above has succeeded (or wasn't needed) — on a
    // conflict nothing below must run, so a retry never duplicates log rows.
    if (pendingSnapshot) {
      await sb.upsert('snapshots', [pendingSnapshot]);
      await sb.rpc('prune_arcasia').catch(() => { }); // keeps logs/snapshots bounded
    }
    if (pendingTimeline.length) await sb.insert('timeline', pendingTimeline.map(tlRow));
    if (pendingTxns.length) await sb.insert('transactions', pendingTxns.map(txRow));
    // Ping clients only when a handler explicitly asked (broadcast('sync') →
    // requestBroadcast). Pinging on ANY dirty commit made cloud hosting
    // broadcast-storm every client during a war: each war-tick save (ridden
    // by /api/state and the ~1Hz heartbeats) pinged everyone into a full
    // refetch + re-render, drowning the app at exactly the moment players
    // were most active. The world_version upsert rides the same gate — its
    // UPDATE is itself a realtime signal (postgres_changes), so bumping it on
    // silent saves would ping clients through the back door. Handlers that
    // matter to other players all broadcast explicitly; tick churn (war
    // movement, day-market gates) is pulled by the clients that watch it.
    if (broadcastPending) {
      await sb.upsert('world_version', [{ id: 1, version }]).catch(() => { }); // table may not exist on older deployments
      await sb.broadcast('world', 'sync');
    }
  } finally {
    pendingTimeline = []; pendingTxns = []; pendingSnapshot = null;
    dirty = false; broadcastPending = false;
  }
}

function get() { return db; }

// Current world version, usable by /api/state to let clients skip no-op
// re-renders. File mode has no CAS version, but fileRev still changes on
// every save so it serves the same purpose.
function getVersion() { return MODE === 'file' ? fileRev : version; }

// True when this request has mutated the world beyond what getVersion()
// reports. File mode is never "uncommitted": save() bumps fileRev
// synchronously, so the version already reflects every change. Cloud mode is
// dirty between a handler's save() and commit()'s CAS — a version-match
// short-circuit (/api/state?ifv=) must not fire then, and api/index.js uses
// the post-commit version to patch buffered responses instead.
function hasUncommitted() { return MODE === 'file' ? false : dirty; }

// Drop the warm cache so the next begin() reloads from Postgres. Used when a
// handler throws mid-mutation, so a half-applied in-memory db is never
// reused or committed.
function invalidate() { db = null; version = 0; }

/* ---------- persistence primitives ---------- */
function saveNow() {
  if (MODE !== 'file' || !db) return;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
  fileRev++;
}

// Universal "something changed" marker. File mode debounces a disk write;
// cloud mode flags the doc for commit().
function save() {
  dirty = true;
  if (MODE !== 'file') return;
  fileRev++;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { saveNow(); } catch (e) { console.error('save failed:', e.message); }
  }, 400);
}

function requestBroadcast() { broadcastPending = true; }

/* ---------- snapshots ---------- */
function snapshot() {
  if (MODE === 'file') {
    const file = path.join(SNAP_DIR, `turn-${String(db.settings.time.turn).padStart(5, '0')}.json`);
    fs.writeFileSync(file, JSON.stringify(db));
    // prune by write time, not turn number — after a rollback or reset the
    // freshest snapshots can carry lower turn numbers than stale ones
    const all = fs.readdirSync(SNAP_DIR).filter(f => f.startsWith('turn-'))
      .map(f => ({ f, mtime: fs.statSync(path.join(SNAP_DIR, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    while (all.length > SNAP_KEEP) fs.unlinkSync(path.join(SNAP_DIR, all.shift().f));
    return;
  }
  // one snapshot per request: a multi-turn advance archives the state it started from
  if (!pendingSnapshot) pendingSnapshot = { turn: db.settings.time.turn, ts: Date.now(), doc: { ...db } };
}

async function listSnapshots() {
  if (MODE === 'file') {
    return fs.readdirSync(SNAP_DIR).filter(f => f.startsWith('turn-')).sort().map(f => {
      const st = fs.statSync(path.join(SNAP_DIR, f));
      return { turn: parseInt(f.slice(5, 10), 10), bytes: st.size, mtime: st.mtimeMs };
    });
  }
  const rows = await sb.select('snapshots', 'select=turn,ts&order=turn.asc');
  return rows.map(r => ({ turn: r.turn, mtime: Number(r.ts) }));
}

async function rollback(turn) {
  let restored;
  if (MODE === 'file') {
    const file = path.join(SNAP_DIR, `turn-${String(turn).padStart(5, '0')}.json`);
    if (!fs.existsSync(file)) throw new Error('No snapshot for turn ' + turn);
    restored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    const rows = await sb.select('snapshots', `turn=eq.${Math.round(turn)}&select=doc`);
    if (!rows.length) throw new Error('No snapshot for turn ' + turn);
    restored = rows[0].doc;
    // the audit log is permanent — keep the current view of it
    restored.timeline = db.timeline;
    restored.transactions = db.transactions;
  }
  // keep operator accounts/sessions/roles from the live world so nobody is locked out
  restored.users = db.users;
  restored.sessions = db.sessions;
  restored.roles = db.roles;
  db = restored;
  if (MODE === 'file') saveNow(); else save();
  return db;
}

// Replace the live world with an exported archive (the mirror of
// /api/gm/export). The file carries everything — users, roles, articles,
// logs — but we keep the live sessions and make sure the importing GM still
// has an operator account, so the import can never lock everyone out.
async function importWorld(world, currentGmUser) {
  migrate(world); // bring older exports up to the current schema
  world.sessions = db && db.sessions ? db.sessions : (world.sessions || {});
  world.users = world.users || [];
  if (currentGmUser && !world.users.some(x => x.id === currentGmUser.id || x.username === currentGmUser.username)) {
    world.users.push(currentGmUser);
  }
  db = world;
  if (MODE === 'file') {
    // imported world starts with a clean snapshot archive
    for (const f of fs.readdirSync(SNAP_DIR)) {
      if (f.startsWith('turn-')) { try { fs.unlinkSync(path.join(SNAP_DIR, f)); } catch (e) { } }
    }
    saveNow();
    return db;
  }
  await sb.del('snapshots', 'turn=gte.0');
  save();
  return db;
}

async function reset(seed) {
  db = (seed || seedFn)(); migrate(db);
  if (MODE === 'file') {
    // a new world starts with a clean archive
    for (const f of fs.readdirSync(SNAP_DIR)) {
      if (f.startsWith('turn-')) { try { fs.unlinkSync(path.join(SNAP_DIR, f)); } catch (e) { } }
    }
    saveNow();
    return db;
  }
  const seedTl = db.timeline.slice();
  const seedTx = db.transactions.slice();
  await sb.del('timeline', 'ts=gt.0');
  await sb.del('transactions', 'ts=gt.0');
  await sb.del('snapshots', 'turn=gte.0');
  if (seedTl.length) await sb.insert('timeline', seedTl.map(tlRow));
  if (seedTx.length) await sb.insert('transactions', seedTx.map(txRow));
  save();
  return db;
}

/* ---------- audit log ---------- */
// Central audit log: every mutation of consequence goes through here.
function log(type, title, detail, actor, refs) {
  const e = {
    id: uid('tl'),
    ts: Date.now(),
    turn: db.settings.time.turn,
    simDate: db.settings.time.date,
    type, title,
    detail: detail || '',
    actor: actor || 'SYSTEM',
    refs: refs || []
  };
  db.timeline.push(e);
  if (db.timeline.length > TIMELINE_CAP) db.timeline.splice(0, db.timeline.length - TIMELINE_CAP);
  if (MODE !== 'file') pendingTimeline.push(e);
  save();
  return e;
}

// Transactions are appended here so the cloud backend can mirror them into
// their own table.
function recordTxn(t) {
  db.transactions.push(t);
  if (db.transactions.length > 12000) db.transactions.splice(0, db.transactions.length - 12000);
  if (MODE !== 'file') pendingTxns.push(t);
}

function byId(coll, id) { return (db[coll] || []).find(x => x.id === id); }

module.exports = {
  MODE, configure, load, begin, commit, get, save, saveNow, requestBroadcast,
  snapshot, listSnapshots, rollback, reset, importWorld, log, recordTxn, uid, byId, DATA_DIR,
  getVersion, hasUncommitted, invalidate, migrate
};
