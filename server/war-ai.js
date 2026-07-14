'use strict';
// Hierarchical commander AI — the GRAND-STRATEGY brain the tick pipeline runs
// every tick (war-engine.js calls WarAI.run where the old flat runAI lived).
// Same sharing contract as the engine itself: this file MUST stay
// behaviourally identical to public/js/war-ai.js (browser copy — edit both
// together, same rule as war-engine.js/pricepath.js), because a predicting
// client replays every replan deterministically between snapshots.
//
// ZERO requires, mirroring war-engine.js: everything this module needs from
// the engine (setDest, note, isLive, NAVAL_KINDS, the tick PRNG's draws, …)
// is INJECTED as the `E` parameter — the engine passes its own exported api
// bundle. That keeps the dependency arrow one-way (engine → ai) in Node and
// lets the browser load the two files as plain script tags (war-ai.js first;
// the engine picks it up off the global).
//
// ---------------------------------------------------------------------------
// The command hierarchy — three tiers over war.command
// ---------------------------------------------------------------------------
// war.command = {
//   lastPlanTick, lastStratTick,             // tier gates (see run() below)
//   att: { nations: { [entityId]: natCmd } },
//   def: { nations: { [entityId]: natCmd } }
// }
// natCmd = {
//   principal: bool,                          // the war's named attacker/defender (vs. a joinWar ally)
//   doctrine: 'aggressive'                    // attacker-side default (today's behaviour)
//           | 'static'|'defensive'|'opportunistic', // defender-side; 'static' = no AI (pre-hierarchy behaviour)
//   phase,                                    // principal att: landing|breakout|consolidate|exploit|total
//                                             // att ally POSTURE: fight|hold|withdraw
//                                             // def nation POSTURE: hold|counterattack|fallback
//   startStrength, consolidateFrac, collapseFrac, // Tier-1 thresholds, per NATION (an ally is judged on its
//                                             // own committed strength, not the whole side's)
//   notes: [{t, text, p?, c?}],               // GM intel feed, cap NOTE_CAP per nation (E.note pushes; `c` = corps tag)
//   corps: [{name, objective, units}]         // display summary of the last operational plan (GM War Room)
//   // + numeric-only authority bookkeeping (_noteSeenTick/_noteLogAt/_noteLogHash — server/war.js logAiNotes)
// }
//
// Tier 1 — NATIONAL COMMAND (strategic, every STRATEGIC_INTERVAL ticks): one
//   per belligerent nation. Owns posture: an attacker ALLY judged on its own
//   contingent (fight → hold + reinforcement request → withdraw home), a
//   defender nation's stance (hold → counterattack when the invader is spent /
//   fallback to the capital line when the defence is). The PRINCIPAL
//   attacker's campaign phase stays on the operational cadence below — it is
//   the war's heartbeat and slowing it to 40 ticks would visibly change
//   every existing scenario's pacing.
// Tier 2 — CORPS COMMAND (operational, every AI_INTERVAL ticks): the
//   role-based assault planner (rear guard / interdiction / encirclement /
//   pursuit / spearhead), now run PER NATION over that nation's own units —
//   and split into multiple corps when the force is large and a second
//   objective is pending (see planNationAssault). Defending nations with an
//   active doctrine get the mirror-image pass (reserve commitment,
//   counter-attacks, fallback lines — see planNationDefence).
// Tier 3 — UNIT/TACTICAL: unchanged — stepChase/stepMovement/stepCombat in
//   the engine execute whatever dests/attackIds the corps tier assigned.
//
// Determinism contract (same as the engine): nation iteration follows
// war.command insertion order (attacker first, allies in join order — part
// of state), pools iterate in war.units order, nearest-picks tie-break by
// pool order, and the only rng draws are the sweep-sector samples — so a
// predicting client replays the identical plan from the same snapshot.
(function (global) {

  // ---------- tier cadence ----------
  const STRATEGIC_INTERVAL = 40;      // ticks between Tier-1 posture reviews (coarser than the operational AI_INTERVAL)

  // ---------- attacker corps planner (moved from war-engine.js runAI) ----------
  const OBJ_THREAT_R = 260;           // px — defenders inside this of an objective count as its garrison when planning
  const ENCIRCLE_R = 170;             // px — how wide the pincer arms swing around a defended objective
  const GARRISON_THREAT_R = 300;      // px — a captured city with live defenders inside this needs a rear guard
  const PURSUE_R = 220;               // px — units run down broken/weak enemies inside this
  const PURSUE_WEAK_FRAC = 0.35;      // an enemy below this fraction of max strength is worth finishing off
  const INTERDICT_FRAC = 0.45;        // supply-cut post sits this far from the defender capital toward the objective
  const MULTI_CORPS_MIN = 10;         // committed land units a nation needs before a SECOND corps forms
  const SECONDARY_CORPS_FRAC = 0.35;  // share of the nation's force the second corps takes to the second objective

  // ---------- defender doctrine (net-new — defenders used to be static) ----------
  const DEF_THREAT_R = 300;           // px — attacker strength inside this of a city counts as a threat to it
  const DEF_HELD_R = 140;             // px — defenders inside this of a city count as already holding it
  const DEF_RESERVE_R = 800;          // px — how far Home Defence will pull a reserve formation from
  const DEF_COMMIT_MAX = 3;           // reserve formations committed to one threatened city per replan
  const DEF_STACK_R = 80;             // px — a garrison may leave its post only if another defender stands this close (the site keeps one)
  const DEF_FALLBACK_FRAC = 0.45;     // defender side strength below this frac of its start → fallback posture
  const DEF_COUNTER_RATIO = 0.55;     // attacker side total below this frac of the defender's → counterattack posture (opportunistic doctrine)
  const DEF_CAPITAL_RING_R = 90;      // px — radius of the capital fallback line units form on

  function roman(n) {
    const table = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let out = '';
    for (const p of table) while (n >= p[0]) { out += p[1]; n -= p[0]; }
    return out || 'I';
  }
  function principalId(war, side) { return side === 'att' ? war.attackerId : war.defenderId; }
  // Sum of live strength of `side` within r of a point. Warships are
  // excluded — shore bombardment can't be cleared by land manoeuvre, so a
  // squadron offshore must not read as "the city is garrisoned" (and the
  // defender AI must not commit land reserves against an offshore fleet).
  function sideStrengthNear(E, war, side, pos, r) {
    let s = 0;
    for (const u of war.units) {
      if (u.side !== side || !E.isLive(u) || u.kind === 'warship') continue;
      if (E.dist(u.pos, pos) <= r) s += u.strength;
    }
    return s;
  }
  // Slide a planned point along the straight line toward `toward` until it
  // sits on land — a pincer arm or supply-cut post computed in open water
  // would send a land column swimming (transport state: can't fight, prime
  // warship bait). Deterministic fixed-fraction march; `toward` itself is a
  // city/capital position, so the walk always terminates on land.
  function landward(E, war, point, toward) {
    if (!E.isWaterAt(war, point)) return point;
    const steps = Math.max(1, Math.ceil((E.dist(point, toward) || 1) / 16));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const cand = [point[0] + (toward[0] - point[0]) * t, point[1] + (toward[1] - point[1]) * t];
      if (!E.isWaterAt(war, cand)) return cand;
    }
    return toward.slice();
  }
  // Remove and return the pool unit nearest to `pos`. Ties break by pool
  // order, which follows war.units order — part of state, so the server and
  // a predicting client pick the exact same unit.
  function takeNearest(E, pool, pos) {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const d = E.dist(pool[i].pos, pos);
      if (d < bd) { bd = d; bi = i; }
    }
    return bi >= 0 ? pool.splice(bi, 1)[0] : null;
  }
  function liveSideTotal(E, war, side) {
    let s = 0;
    for (const u of war.units) if (u.side === side && E.isLive(u)) s += u.strength;
    return s;
  }
  function nationStrength(E, war, side, nid) {
    const prin = principalId(war, side);
    let s = 0;
    for (const u of war.units) {
      if (u.side !== side || !E.isLive(u)) continue;
      if ((u.nationId || prin) === nid) s += u.strength;
    }
    return s;
  }
  function capitalCity(db) {
    return (db.cities || []).find(c => c.isCapital && c.pos) || (db.cities || []).find(c => c.pos) || null;
  }

  // ---------- war.command construction ----------
  // Built by the authority at startWar (initialCommand below); ensureCommand
  // is the engine-side self-heal that (a) wraps a legacy war.ai doc in flight
  // (store.migrate does the same on load — this covers hand-built test wars
  // and any snapshot that slipped through) and (b) backfills a command entry
  // for a nation that joined mid-war (joinWar only pushes units; both the
  // server and every predicting client derive the SAME entry here from the
  // same war state on the next tick, so nothing extra needs syncing).
  function freshNation(opts) {
    return {
      principal: !!opts.principal,
      doctrine: opts.doctrine || (opts.side === 'att' ? 'aggressive' : 'static'),
      phase: opts.phase || (opts.side === 'att' ? (opts.principal ? 'landing' : 'fight') : 'hold'),
      startStrength: opts.startStrength || 0,
      consolidateFrac: opts.consolidateFrac || 0.35,
      collapseFrac: opts.collapseFrac || 0.12,
      notes: [],
      corps: []
    };
  }
  function initialCommand(opts) {
    const cmd = { lastPlanTick: 0, lastStratTick: 0, att: { nations: {} }, def: { nations: {} } };
    cmd.att.nations[opts.attackerId] = freshNation({
      side: 'att', principal: true, phase: 'landing',
      doctrine: opts.attDoctrine,
      startStrength: opts.attackerStartStrength,
      consolidateFrac: opts.consolidateFrac, collapseFrac: opts.collapseFrac
    });
    cmd.def.nations[opts.defenderId] = freshNation({
      side: 'def', principal: true,
      doctrine: opts.defDoctrine,
      startStrength: opts.defenderStartStrength
    });
    return cmd;
  }
  function ensureCommand(E, db, war) {
    // Legacy wrap: a pre-hierarchy war doc carries the old flat war.ai —
    // promote it to the attacker's National Command in place, preserving the
    // phase/thresholds/notes so an in-flight campaign doesn't skip a beat.
    if (!war.command && war.ai) {
      const ai = war.ai;
      war.command = { lastPlanTick: ai.lastPlanTick || 0, lastStratTick: 0, att: { nations: {} }, def: { nations: {} } };
      war.command.att.nations[war.attackerId] = {
        principal: true, doctrine: 'aggressive',
        phase: ai.phase || 'breakout',
        startStrength: ai.attackerStartStrength || 0,
        consolidateFrac: ai.consolidateFrac || 0.35,
        collapseFrac: ai.collapseFrac || 0.12,
        notes: Array.isArray(ai.notes) ? ai.notes : [],
        corps: []
      };
      delete war.ai;
    }
    if (!war.command) return null;
    const cmd = war.command;
    cmd.att = cmd.att || { nations: {} }; cmd.att.nations = cmd.att.nations || {};
    cmd.def = cmd.def || { nations: {} }; cmd.def.nations = cmd.def.nations || {};
    // Backfill in a FIXED order (principal, then allies in war.allies order)
    // so the server and a predicting client insert entries identically —
    // object key order is part of the determinism contract.
    const backfill = (side) => {
      const sideCmd = side === 'att' ? cmd.att : cmd.def;
      const prin = principalId(war, side);
      const prinNat = sideCmd.nations[prin];
      // A defending ally fights under the principal defender's doctrine — a
      // static Home Front keeps its allies static too (pre-hierarchy
      // behaviour), an active one directs the whole coalition.
      const inheritDoctrine = side === 'def' ? ((prinNat && prinNat.doctrine) || 'static') : 'aggressive';
      const ids = [prin].concat((war.allies && war.allies[side]) || []);
      for (const id of ids) {
        if (!id || sideCmd.nations[id]) continue;
        sideCmd.nations[id] = freshNation({
          side, principal: id === prin,
          doctrine: id === prin ? undefined : inheritDoctrine,
          // A mid-war joiner's start strength is its contingent as it stands
          // the first tick its command forms — same state on both sides of
          // the prediction boundary.
          startStrength: nationStrength(E, war, side, id)
        });
      }
    };
    backfill('att');
    backfill('def');
    return cmd;
  }

  // ---------- Tier 1 — strategic posture review ----------
  function strategicPass(E, db, war, ctx) {
    const cmd = war.command;
    const entName = (id) => { const e = (db.entities || []).find(x => x.id === id); return e ? e.name : id; };

    // Attacker ALLIES: each judged on its OWN contingent against its own
    // thresholds (the principal's campaign phase lives in the operational
    // pass — see operateAttackers). fight → hold (+ a reinforcement request
    // the GM sees) → withdraw (the contingent falls back toward home and
    // digs in — the nation is bowing out of a losing war).
    for (const nid in cmd.att.nations) {
      const nat = cmd.att.nations[nid];
      if (nat.principal) continue;
      const own = nationStrength(E, war, 'att', nid);
      const was = nat.phase;
      if (own <= nat.startStrength * nat.collapseFrac) nat.phase = 'withdraw';
      else if (own <= nat.startStrength * nat.consolidateFrac) nat.phase = 'hold';
      else nat.phase = nat.phase === 'withdraw' ? 'withdraw' : 'fight'; // a withdrawal, once ordered, is not reversed by stragglers healing up
      if (nat.phase !== was) {
        E.note(war, 'att', nid, `Posture change: ${was} → ${nat.phase}`, { plan: true });
        if (nat.phase === 'hold') E.note(war, 'att', nid, `${entName(nid)} halts its contingent and requests reinforcement from its partners.`, { plan: true });
        if (nat.phase === 'withdraw') {
          E.note(war, 'att', nid, `${entName(nid)}'s expeditionary force is spent — it is withdrawing from the war.`, { plan: true });
          ctx.log('event', `${entName(nid)} withdraws from the war`, `Its expeditionary contingent has been bled below fighting strength and is falling back toward home soil.`, 'WAR ENGINE', [nid]);
        }
      }
    }

    // Defender nations: one stance for the whole defence (it is a unified
    // front), stamped on every nation whose doctrine is active. 'static'
    // doctrine (the default — see docs/WAR.md) opts a nation out entirely,
    // which is exactly the pre-hierarchy behaviour.
    const defTotal = liveSideTotal(E, war, 'def');
    const attTotal = liveSideTotal(E, war, 'att');
    let defStart = 0;
    for (const nid in cmd.def.nations) defStart += cmd.def.nations[nid].startStrength || 0;
    for (const nid in cmd.def.nations) {
      const nat = cmd.def.nations[nid];
      if (nat.doctrine === 'static' || !nat.doctrine) continue;
      const was = nat.phase;
      if (defStart > 0 && defTotal <= defStart * DEF_FALLBACK_FRAC) nat.phase = 'fallback';
      else if (nat.doctrine === 'opportunistic' && attTotal <= defTotal * DEF_COUNTER_RATIO) nat.phase = 'counterattack';
      else nat.phase = 'hold';
      if (nat.phase !== was) E.note(war, 'def', nid, `Posture change: ${was} → ${nat.phase}`, { plan: true });
    }
  }

  // ---------- Tier 2 — attacker side (operational) ----------
  function totalWarHunt(E, db, war, rng, prinId) {
    // Objectives are history — every attacker (allies included) hunts down
    // the remaining defenders, then sweeps the least-controlled province.
    const defsLive = war.units.filter(x => x.side === 'def' && E.isLive(x));
    const ctl = war.stats.provinceControl || {};
    let sweepPid = null, low = 101;
    for (const pid in war.grid.provinceLandCells) {
      const c = ctl[pid] || 0;
      if (c < E.TOTAL_VICTORY_PCT && c < low) { low = c; sweepPid = pid; }
    }
    let hunting = 0, sweeping = 0;
    for (const u of war.units) {
      if (u.side !== 'att' || !E.isLive(u) || u.state === 'routed' || u.state === 'embarked') continue;
      if (u.orderedBy === 'player' && (u.playerHoldUntil || 0) > war.tick) continue;
      // A LAND unit only hunts land targets — sending infantry swimming
      // after a warship is suicide (see stepChase's matching refusal). If
      // only enemy warships remain afloat, the ground forces sweep territory
      // instead and leave the hulls to friendly boats/warships.
      const targets = E.NAVAL_KINDS[u.kind] ? defsLive : defsLive.filter(d => d.kind !== 'warship');
      if (targets.length) {
        let nearest = targets[0], nd = E.dist(u.pos, nearest.pos);
        for (const d of targets) { const dd = E.dist(u.pos, d.pos); if (dd < nd) { nd = dd; nearest = d; } }
        E.clearDest(u);
        u.attackId = nearest.id;
        u.objectiveId = null;
        if (u.state !== 'fighting') u.state = 'moving';
        hunting++;
      } else if (sweepPid && !E.NAVAL_KINDS[u.kind]) {
        u.attackId = null;
        E.setDest(db, u, E.randomProvincePoint(war, sweepPid, rng) || u.pos.slice(), u.speed);
        sweeping++;
      }
    }
    if (defsLive.length) E.note(war, 'att', prinId, `Total war: ${hunting} unit(s) hunting the ${defsLive.length} defending formation(s) still in the field.`, { plan: true });
    else if (sweepPid) E.note(war, 'att', prinId, `Total war: ${sweeping} unit(s) sweeping the last uncontrolled ground.`, { plan: true });
  }

  // Where a withdrawing ally falls back TO: its own homeland cell nearest the
  // unit (grid.countryCells), else the side's supply anchor, else it just
  // digs in where it stands. Deterministic — pure state/map lookups.
  function withdrawPoint(E, db, war, nid, u) {
    const cid = E.countryIdForEntity(db, nid);
    const cells = (cid && war.grid && war.grid.countryCells) ? war.grid.countryCells[cid] : null;
    if (cells && cells.length) {
      const cs = war.grid.cell;
      let best = null, bd = Infinity;
      for (const cell of cells) {
        const p = [(cell[0] + 0.5) * cs, (cell[1] + 0.5) * cs];
        const d = E.dist(p, u.pos);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    }
    if (Array.isArray(war.supplyAnchor)) return war.supplyAnchor.slice();
    return null;
  }

  // The role-based corps planner, run over ONE corps' pool against ONE
  // objective. Everything here exploits a real engine mechanic rather than
  // being flavour — see the role notes inline (rear guard is handled at
  // nation level before the corps split; see planNationAssault).
  function planCorpsAssault(E, db, war, pool, target) {
    const out = { interdictors: 0, encirclers: 0, pursuers: 0, assault: 0, capitalName: null };

    // Supply interdiction — post a detachment between the defender capital
    // (the root of stepSupply's defender flood-fill) and the objective: the
    // territory it captures pinches the capital-rooted supply flood-fill, so
    // the objective's garrison stops healing — a mechanical siege. Pointless
    // when the objective IS the capital (no line behind it to cut) or the
    // corps is too small to detach.
    const capital = capitalCity(db);
    const targetIsCapital = !!(capital && E.dist(capital.pos, target.pos) < 60);
    if (capital && !targetIsCapital && pool.length >= 6) {
      out.capitalName = capital.name;
      const cut = landward(E, war, E.clampToWorld(war, [
        capital.pos[0] + (target.pos[0] - capital.pos[0]) * INTERDICT_FRAC,
        capital.pos[1] + (target.pos[1] - capital.pos[1]) * INTERDICT_FRAC
      ]), capital.pos);
      const want = pool.length >= 10 ? 2 : 1;
      for (let i = 0; i < want; i++) {
        const u = takeNearest(E, pool, cut);
        if (!u) break;
        E.setDest(db, u, cut.slice(), u.speed);
        u.objectiveId = target.id;
        out.interdictors++;
      }
    }

    // Encirclement — only when the objective is actually defended. Pincer
    // arms aim ENCIRCLE_R to each flank, biased slightly PAST the city along
    // the approach axis so they close behind it (routed garrisons retreating
    // from the assault run straight into them), landward-slid so a coastal
    // objective never sends a column into the sea.
    const defAtObj = sideStrengthNear(E, war, 'def', target.pos, OBJ_THREAT_R);
    if (defAtObj > 0 && pool.length >= 4) {
      let cx = 0, cy = 0;
      for (const u of pool) { cx += u.pos[0]; cy += u.pos[1]; }
      cx /= pool.length; cy /= pool.length;
      let ax = target.pos[0] - cx, ay = target.pos[1] - cy;
      const am = Math.hypot(ax, ay) || 1; ax /= am; ay /= am;
      const arms = pool.length >= 8 ? 2 : 1;
      for (let i = 0; i < arms; i++) {
        const side = i === 0 ? 1 : -1;
        const pt = landward(E, war, E.clampToWorld(war, [
          target.pos[0] - ay * side * ENCIRCLE_R + ax * ENCIRCLE_R * 0.35,
          target.pos[1] + ax * side * ENCIRCLE_R + ay * ENCIRCLE_R * 0.35
        ]), target.pos);
        const u = takeNearest(E, pool, pt);
        if (!u) break;
        E.setDest(db, u, pt, u.speed);
        u.objectiveId = target.id;
        out.encirclers++;
      }
    }

    // Pursuit — run down routed/mauled defenders within PURSUE_R of the
    // corps rather than marching past them (a routed unit left alone rallies
    // at RALLY_ORG and comes straight back). Chase orders reuse stepChase.
    const maxPursuit = Math.ceil(pool.length / 3);
    for (const d of war.units) {
      if (out.pursuers >= maxPursuit || !pool.length) break;
      if (d.side !== 'def' || !E.isLive(d) || d.kind === 'warship') continue;
      if (!(d.state === 'routed' || d.strength < (d.maxStrength || d.strength) * PURSUE_WEAK_FRAC)) continue;
      let bi = -1, bd = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const dd = E.dist(pool[i].pos, d.pos);
        if (dd <= PURSUE_R && dd < bd) { bd = dd; bi = i; }
      }
      if (bi < 0) continue;
      const u = pool.splice(bi, 1)[0];
      E.clearDest(u);
      u.attackId = d.id;
      u.objectiveId = null;
      if (u.state !== 'fighting') u.state = 'moving';
      out.pursuers++;
    }

    // Main effort — everyone left masses on the objective.
    out.assault = pool.length;
    for (const u of pool) {
      E.setDest(db, u, target.pos.slice(), u.speed);
      u.objectiveId = target.id;
    }
    return out;
  }
  function corpsParts(r) {
    const parts = [`${r.assault} on the assault`];
    if (r.encirclers) parts.push(`${r.encirclers} swinging wide to encircle`);
    if (r.interdictors) parts.push(`${r.interdictors} cutting the ${r.capitalName ? r.capitalName + ' ' : ''}supply line`);
    if (r.pursuers) parts.push(`${r.pursuers} running down broken formations`);
    return parts;
  }

  // One attacking nation's operational replan: rear guard at nation level,
  // then the committed force split into corps — one per pending objective
  // front when the force is big enough to fight on two axes at once
  // (MULTI_CORPS_MIN), otherwise the single corps of the pre-hierarchy
  // planner. Sweep/exploit stays nation-level (the sectors already spread).
  function planNationAssault(E, db, war, ctx, rng, nid, nat, landForce, navalForce, landingObj) {
    const pendingSeize = war.objectives
      .filter(o => o.status !== 'done' && o.kind !== 'control_province' && o.kind !== 'landing')
      .sort((a, b) => a.priority - b.priority);
    const target = pendingSeize[0] || null;
    const secondary = pendingSeize[1] || null;
    const sweepObj = !target ? war.objectives.find(o => o.status !== 'done' && o.kind === 'control_province') : null;
    const cityById = (id) => (db.cities || []).find(c => c.id === id);

    // Naval units: fire support. setDest clamps a naval dest to the nearest
    // water, so "go to the city" reads as "take station off its coast" and
    // stepWarshipFire does the rest.
    const navalAim = target || sweepObj;
    for (const u of navalForce) {
      if (navalAim) { E.setDest(db, u, navalAim.pos.slice(), u.speed); u.objectiveId = navalAim.id; }
    }

    if (!target && sweepObj) {
      // Exploit phase: fan the force out across the province in deterministic
      // SECTORS of its land-cell list instead of everyone sampling the same
      // random point independently — the old sweep could pile half the army
      // into one corner while the far side stayed unswept for several replans.
      const cells = (war.grid.provinceCells || {})[sweepObj.ref] || [];
      const cs = war.grid.cell;
      let n = 0;
      for (const u of landForce) {
        let dest = null;
        if (cells.length) {
          const idx = Math.floor(((n + rng()) / Math.max(1, landForce.length)) * cells.length) % cells.length;
          dest = [cells[idx][0] * cs + cs / 2, cells[idx][1] * cs + cs / 2];
        }
        E.setDest(db, u, dest || sweepObj.pos.slice(), u.speed);
        u.objectiveId = sweepObj.id;
        n++;
      }
      const prov = (db.provinces || []).find(p => p.id === sweepObj.ref);
      nat.corps = [{ name: 'I Corps', objective: prov ? prov.name : sweepObj.ref, units: n }];
      E.note(war, 'att', nid, `Sweeping ${n} unit(s) through ${prov ? prov.name : sweepObj.ref} in spread sectors to raise territorial control.`, { plan: true });
      return;
    }
    if (!target) { nat.corps = []; E.note(war, 'att', nid, 'All objectives complete — mopping up.', { plan: true }); return; }

    const pool = landForce.slice();

    // Rear guard — nation-level, threat-aware. Walk captured cities
    // most-recent-first; only one with live defenders nearby gets a guard,
    // 1–2 units by threat strength (chosen by proximity), capped at ¼ of the
    // force. No rear threat anywhere → the whole force stays forward.
    const guardedNames = [];
    let guards = 0;
    const maxGuards = Math.floor(pool.length / 4);
    const heldIds = (war.stats.citiesHeld || []).slice().reverse();
    for (const cid of heldIds) {
      if (guards >= maxGuards) break;
      const city = cityById(cid);
      if (!city || !city.pos) continue;
      const threat = sideStrengthNear(E, war, 'def', city.pos, GARRISON_THREAT_R);
      if (threat <= 0) continue;
      const want = Math.min(2, Math.max(1, Math.round(threat / 3000)), maxGuards - guards);
      let took = 0;
      for (let i = 0; i < want; i++) {
        const u = takeNearest(E, pool, city.pos);
        if (!u) break;
        E.clearDest(u);
        u.state = 'holding';
        u.objectiveId = null;
        guards++; took++;
      }
      if (took) guardedNames.push(city.name);
    }

    // Corps split — a second front only opens when the force can afford it:
    // the second corps takes SECONDARY_CORPS_FRAC of the pool (nearest units
    // first, so the split respects the map) to the next objective in priority
    // order while I Corps presses the primary axis.
    const corps = [];
    if (secondary && pool.length >= MULTI_CORPS_MIN) {
      const take = Math.max(2, Math.floor(pool.length * SECONDARY_CORPS_FRAC));
      const second = [];
      for (let i = 0; i < take; i++) {
        const u = takeNearest(E, pool, secondary.pos);
        if (!u) break;
        second.push(u);
      }
      corps.push({ name: 'I Corps', target, pool });
      corps.push({ name: 'II Corps', target: secondary, pool: second });
    } else {
      corps.push({ name: 'I Corps', target, pool });
    }

    nat.corps = [];
    const nationParts = [];
    for (const c of corps) {
      const size = c.pool.length;
      const r = planCorpsAssault(E, db, war, c.pool, c.target);
      const objName = (cityById(c.target.ref) || {}).name || c.target.ref || c.target.kind;
      nat.corps.push({ name: c.name, objective: objName, units: size });
      nationParts.push(`${c.name} (${size}) on ${objName}`);
      // Per-corps detail notes only when the front actually split — a single
      // corps' plan reads better as the one nation-level line below. The
      // corps name rides the `c` tag, NOT the text — every reader (the
      // Timeline title, the War Room) prefixes it from there.
      if (corps.length > 1) {
        E.note(war, 'att', nid, `${c.target.kind} (priority ${c.target.priority}): ${corpsParts(r).join('; ')}.`, { plan: true, corps: c.name });
      } else {
        const parts = corpsParts(r);
        if (guards) parts.push(`${guards} guarding ${guardedNames.join(', ')}`);
        if (navalForce.length && navalAim) parts.push(`${navalForce.length} squadron(s) on fire support`);
        E.note(war, 'att', nid, `${c.target.kind} (priority ${c.target.priority}): ${parts.join('; ')}.`, { plan: true });
      }
    }
    if (corps.length > 1) {
      if (guards) nationParts.push(`${guards} guarding ${guardedNames.join(', ')}`);
      if (navalForce.length && navalAim) nationParts.push(`${navalForce.length} squadron(s) on fire support`);
      E.note(war, 'att', nid, `Front split: ${nationParts.join('; ')}.`, { plan: true });
    }
  }

  function operateAttackers(E, db, war, ctx, rng) {
    const cmd = war.command;
    const nations = cmd.att.nations;
    const prinId = principalId(war, 'att');
    const prin = nations[prinId] || ensurePrincipalFallback(nations, prinId);

    const attTotal = liveSideTotal(E, war, 'att');
    const collapseAt = prin.startStrength * prin.collapseFrac;
    const consolidateAt = prin.startStrength * prin.consolidateFrac;

    if (attTotal <= collapseAt && !war.totalWar) {
      // A repelled invasion no longer ends the war on a negotiated collapse —
      // it goes TOTAL instead: the shattered invader refuses terms and its
      // remnants fight to the last, so the defence must destroy every
      // remaining formation. checkVictory's annihilation path (no live
      // attacker units → winner 'def') is what finally ends the war.
      // One-shot: totalWar gates re-entry. Judged on the WHOLE side (allies
      // included), exactly as before the hierarchy — the invasion as a
      // venture collapses, not one contingent.
      war.totalWar = true;
      prin.phase = 'total';
      E.note(war, 'att', prinId, `Attacking force collapsed (${Math.round(attTotal)} strength remaining) — no terms; the remnants fight to the last.`);
      ctx.log('event', 'The invasion is repelled — the war turns total', war.name, 'WAR ENGINE', [war.attackerId, war.defenderId]);
      ctx.news('THE INVASION IS REPELLED', 'The invading expeditionary force has been shattered — yet its commanders refuse all terms. What remains digs in to fight to the last. The war enters its total phase.');
    }

    const landingObj = war.objectives.find(o => o.kind === 'landing');
    const wasPhase = prin.phase;
    // totalWar outranks consolidation: a total-phase force never digs in, it
    // hunts (that is also what keeps a collapsed-but-unbeaten remnant fighting).
    if (war.totalWar) prin.phase = 'total';
    else if (attTotal <= consolidateAt) prin.phase = 'consolidate';
    else if (landingObj && landingObj.status !== 'done') prin.phase = 'landing';
    else prin.phase = prin.phase === 'consolidate' ? 'consolidate' : (war.objectives.every(o => o.status === 'done') ? 'exploit' : 'breakout');
    if (prin.phase !== wasPhase) E.note(war, 'att', prinId, `Phase change: ${wasPhase} → ${prin.phase}`, { plan: true });

    if (prin.phase === 'total') { totalWarHunt(E, db, war, rng, prinId); return; }

    // Per-nation execution. Iteration follows command insertion order
    // (principal first, allies in join order) — part of state, deterministic.
    for (const nid in nations) {
      const nat = nations[nid];
      // Gather this nation's committed force (skips embarked units — they
      // stay pointed at the landing — routed units, and player-held ones).
      const landForce = [], navalForce = [];
      for (const u of war.units) {
        if (u.side !== 'att' || !E.isLive(u) || u.state === 'routed') continue;
        if ((u.nationId || prinId) !== nid) continue;
        if (u.orderedBy === 'player' && (u.playerHoldUntil || 0) > war.tick) continue;
        if (u.state === 'embarked') { u.objectiveId = landingObj ? landingObj.id : null; continue; }
        if (E.NAVAL_KINDS[u.kind]) navalForce.push(u); else landForce.push(u);
      }

      // Tier-1 posture: the principal digs in when ITS campaign phase says
      // consolidate; an ally holds or withdraws on its own posture.
      const posture = nat.principal ? prin.phase : nat.phase;
      if (posture === 'consolidate' || posture === 'hold') {
        for (const u of landForce.concat(navalForce)) {
          E.clearDest(u);
          if (u.state !== 'routed') u.state = 'holding';
        }
        nat.corps = [];
        E.note(war, 'att', nid, 'Digging in on captured ground — no further advances ordered.', { plan: true });
        continue;
      }
      if (posture === 'withdraw') {
        let n = 0;
        for (const u of landForce.concat(navalForce)) {
          const home = withdrawPoint(E, db, war, nid, u);
          if (home) { E.setDest(db, u, home, u.speed); u.objectiveId = null; n++; }
          else { E.clearDest(u); if (u.state !== 'routed') u.state = 'holding'; }
        }
        nat.corps = [];
        E.note(war, 'att', nid, `Withdrawing ${n} formation(s) toward home soil.`, { plan: true });
        continue;
      }

      planNationAssault(E, db, war, ctx, rng, nid, nat, landForce, navalForce, landingObj);
    }
  }
  // A malformed command doc (hand-edited export) missing the principal's
  // entry — synthesize a permissive one rather than crashing the tick loop.
  function ensurePrincipalFallback(nations, prinId) {
    nations[prinId] = {
      principal: true, doctrine: 'aggressive', phase: 'breakout',
      startStrength: 0, consolidateFrac: 0.35, collapseFrac: 0.12, notes: [], corps: []
    };
    return nations[prinId];
  }

  // ---------- Tier 2 — defender doctrine (operational) ----------
  // The mirror image of the assault planner, and the genuinely NEW engine
  // work: defenders used to be static garrisons unless a player moved them.
  // A defending nation whose doctrine is active gets, each replan:
  //   · fallback of CUT-OFF units — an unsupplied formation that isn't
  //     pinned walks back toward the capital (the root of its side's supply
  //     flood-fill) instead of dying in a pocket;
  //   · reserve commitment — a city with more attacker strength bearing down
  //     on it than defenders holding it pulls the nearest uncommitted
  //     reserves in (a garrison may leave its post only when the site keeps
  //     at least one other defender — DEF_STACK_R);
  //   · counter-attacks — routed/mauled attackers near the line are chased
  //     down (posture 'counterattack', or any posture for broken units —
  //     the same attackId orders players issue);
  //   · the capital line — posture 'fallback' pulls every field formation
  //     onto a deterministic ring around the capital and lets the garrisons
  //     hold their sites to the last.
  // Player agency is preserved HARD: a unit a player has EVER ordered
  // (u.playerControlled — stamped by applyOrders) is never re-tasked by Home
  // Defence, unlike the attacker AI's expiring 12-tick hold. The players ARE
  // the defence's field commanders; the AI only picks up what nobody drives.
  function planNationDefence(E, db, war, ctx, rng, nid, nat) {
    const prinId = principalId(war, 'def');
    const capital = capitalCity(db);

    // Committable pool: this nation's live, unengaged, un-player-touched land
    // units. Warships are left alone (they already fight at range on their
    // own; steaming the fleet into a massed landing is a losing trade the
    // players can still choose to make themselves).
    const pool = [];
    for (const u of war.units) {
      if (u.side !== 'def' || !E.isLive(u)) continue;
      if ((u.nationId || prinId) !== nid) continue;
      if (u.state === 'routed' || u.state === 'fighting' || u.state === 'embarked') continue;
      if (u.playerControlled || (u.orderedBy === 'player' && (u.playerHoldUntil || 0) > war.tick)) continue;
      if (u.kind === 'warship' || u.kind === 'boat') continue;
      pool.push(u);
    }
    if (!pool.length) { nat.corps = []; return; }

    // Which garrisons may leave their post at all: only one whose site keeps
    // another live defender within DEF_STACK_R — a city is never stripped to
    // zero by its own Home Defence.
    const mayMove = (u) => {
      if (!u.garrison) return true;
      for (const o of war.units) {
        if (o === u || o.side !== 'def' || !E.isLive(o)) continue;
        if (E.dist(o.pos, u.pos) <= DEF_STACK_R) return true;
      }
      return false;
    };

    let fellBack = 0, committed = 0, counter = 0;
    const committedTo = [];

    // 1. Cut-off units walk home — supply is healing, and a pocket that
    //    can't heal only shrinks. Garrisons hold their site regardless (dug
    //    in is what they're for); this is for field formations.
    if (capital) {
      for (let i = pool.length - 1; i >= 0; i--) {
        const u = pool[i];
        if (u.supplied !== false || u.garrison) continue;
        E.setDest(db, u, capital.pos.slice(), u.speed);
        u.objectiveId = null;
        pool.splice(i, 1);
        fellBack++;
      }
    }

    // 2. Posture fallback: every remaining field formation converges on a
    //    deterministic ring around the capital (index-spaced angles — no rng
    //    draws) and the garrisons hold their sites to the last.
    if (nat.phase === 'fallback' && capital) {
      const fielded = pool.filter(u => !u.garrison);
      let i = 0;
      for (const u of fielded) {
        const ang = (i / Math.max(1, fielded.length)) * Math.PI * 2;
        const pt = landward(E, war, E.clampToWorld(war, [
          capital.pos[0] + Math.cos(ang) * DEF_CAPITAL_RING_R,
          capital.pos[1] + Math.sin(ang) * DEF_CAPITAL_RING_R
        ]), capital.pos);
        E.setDest(db, u, pt, u.speed);
        u.objectiveId = null;
        const idx = pool.indexOf(u);
        if (idx >= 0) pool.splice(idx, 1);
        i++;
      }
      fellBack += i;
    }

    // 3. Reserve commitment: cities with more attacker strength bearing down
    //    than defenders holding them, worst deficit first, pull the nearest
    //    eligible reserves. A reserve already holding some threatened city is
    //    never poached for another.
    const threats = [];
    for (const c of (db.cities || [])) {
      if (!c.pos) continue;
      const att = sideStrengthNear(E, war, 'att', c.pos, DEF_THREAT_R);
      if (att <= 0) continue;
      // "Held" counts defenders standing at the city AND reserves already
      // ORDERED to it (dest inside the held radius) — without the inbound
      // half, every replan re-raised the same deficit and re-issued the
      // same relief order while the column was still on the road.
      let held = sideStrengthNear(E, war, 'def', c.pos, DEF_HELD_R);
      for (const u of war.units) {
        if (u.side !== 'def' || !E.isLive(u) || !u.dest) continue;
        if (E.dist(u.pos, c.pos) > DEF_HELD_R && E.dist(u.dest, c.pos) <= DEF_HELD_R) held += u.strength;
      }
      if (held >= att * 1.15) continue; // adequately held already
      threats.push({ city: c, deficit: att - held });
    }
    threats.sort((a, b) => b.deficit - a.deficit); // stable sort — ties keep db.cities order
    if (nat.phase !== 'fallback') {
      for (const t of threats) {
        if (!pool.length) break;
        const want = Math.min(DEF_COMMIT_MAX, Math.max(1, Math.round(t.deficit / 2500)));
        let took = 0;
        for (let i = 0; i < want && pool.length; i++) {
          // Eligible: movable, within reach, and not itself standing on a
          // threatened city (that would strip one fire to feed another).
          let bi = -1, bd = Infinity;
          for (let j = 0; j < pool.length; j++) {
            const u = pool[j];
            if (!mayMove(u)) continue;
            const d = E.dist(u.pos, t.city.pos);
            if (d > DEF_RESERVE_R || d <= DEF_HELD_R) continue; // too far, or already there
            let holdingOther = false;
            for (const t2 of threats) {
              if (t2 !== t && E.dist(u.pos, t2.city.pos) <= DEF_HELD_R) { holdingOther = true; break; }
            }
            if (holdingOther) continue;
            if (d < bd) { bd = d; bi = j; }
          }
          if (bi < 0) break;
          const u = pool.splice(bi, 1)[0];
          E.setDest(db, u, t.city.pos.slice(), u.speed);
          u.objectiveId = null;
          took++; committed++;
        }
        if (took) committedTo.push(t.city.name);
      }
    }

    // 4. Counter-attacks: broken or badly mauled attackers near the line are
    //    run down before they rally — any posture chases ROUTED units;
    //    posture 'counterattack' also commits against weak-but-standing ones.
    const maxCounter = Math.ceil(pool.length / 3);
    for (const a of war.units) {
      if (counter >= maxCounter || !pool.length) break;
      if (a.side !== 'att' || !E.isLive(a) || a.kind === 'warship' || a.state === 'embarked') continue;
      const weak = a.strength < (a.maxStrength || a.strength) * PURSUE_WEAK_FRAC;
      if (!(a.state === 'routed' || (nat.phase === 'counterattack' && weak))) continue;
      let bi = -1, bd = Infinity;
      for (let j = 0; j < pool.length; j++) {
        const u = pool[j];
        if (!mayMove(u)) continue;
        const dd = E.dist(u.pos, a.pos);
        if (dd <= PURSUE_R && dd < bd) { bd = dd; bi = j; }
      }
      if (bi < 0) continue;
      const u = pool.splice(bi, 1)[0];
      E.clearDest(u);
      u.attackId = a.id;
      u.objectiveId = null;
      if (u.state !== 'fighting') u.state = 'moving';
      counter++;
    }

    nat.corps = [{ name: 'Home Defence', objective: nat.phase, units: fellBack + committed + counter }];
    if (fellBack || committed || counter) {
      const parts = [];
      if (committed) parts.push(`committing ${committed} reserve formation(s) to ${committedTo.join(', ')}`);
      if (counter) parts.push(`${counter} counter-attacking broken invaders`);
      if (fellBack) parts.push(`${fellBack} falling back on the ${capital ? capital.name + ' ' : ''}line`);
      E.note(war, 'def', nid, `Home Defence (${nat.phase}): ${parts.join('; ')}.`, { plan: true });
    }
  }

  function operateDefenders(E, db, war, ctx, rng) {
    const nations = war.command.def.nations;
    for (const nid in nations) {
      const nat = nations[nid];
      if (!nat.doctrine || nat.doctrine === 'static') continue; // pre-hierarchy behaviour: nobody moves until a player says so
      planNationDefence(E, db, war, ctx, rng, nid, nat);
    }
  }

  // ---------- entry point (called from the engine's warTick) ----------
  function run(E, db, war, ctx, rng) {
    // A legacy snapshot with neither ai nor command (a non-GM predicted doc
    // from a pre-redaction server, or a hand-stripped export) simply coasts
    // on existing dests — exactly the old `if (war.ai)` behaviour.
    if (!war.command && !war.ai) return;
    ensureCommand(E, db, war);
    const cmd = war.command;
    if (!cmd) return;
    const strategic = war.tick - (cmd.lastStratTick || 0) >= STRATEGIC_INTERVAL;
    const operational = war.tick - (cmd.lastPlanTick || 0) >= E.AI_INTERVAL;
    if (strategic) { strategicPass(E, db, war, ctx); cmd.lastStratTick = war.tick; }
    if (operational) {
      operateAttackers(E, db, war, ctx, rng);
      if (war.active) operateDefenders(E, db, war, ctx, rng);
      cmd.lastPlanTick = war.tick;
    }
  }

  const api = { run, ensureCommand, initialCommand, STRATEGIC_INTERVAL, roman };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.WarAI = api;
})(typeof self !== 'undefined' ? self : this);
