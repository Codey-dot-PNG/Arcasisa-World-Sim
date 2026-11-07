#!/usr/bin/env node
'use strict';
/* Sort a world's authored changes from engine content and play state, and
   build a baseline (the world a reset starts from). Same logic as GM Studio
   › World › Baseline (server/canon.js). Zero dependencies.

     node tools/world-canon.js scan <export.json> [more exports…] [--json out.json]
         Compare each export with the world a reset produces today (the seed
         + migrations + any canon already saved) and list what was authored
         since: new records (as first created), edits (at their latest
         value), removals and settings — oldest export first. With --json,
         also write the merged list (it can be fed to `keep`).

     node tools/world-canon.js keep <world.json> <review.json> [--all | --suggested]
         Save candidates from a `scan --json` file into <world.json>'s
         baseline canon (world.canon) — every candidate with --all, the
         suggested ones with --suggested (default).

     node tools/world-canon.js bake <world.json> [--out data/baseline-world.json]
         Write a whole baseline file: the seed + migrations + the canon the
         given world holds. Commit it and every fresh deploy starts there.

   The seed is data/baseline-world.json; run from the repository root. */
const fs = require('fs');
const path = require('path');

process.env.ARCASIA_TOOL = '1';
const canon = require('../server/canon');

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s == null ? '∅' : s.length > 60 ? s.slice(0, 57) + '…' : s; };

if (cmd === 'scan') {
  const out = flag('--json');
  if (!args.length) { console.error('usage: scan <export.json> […]'); process.exit(1); }
  const ref = canon.reference(null);
  const scans = args.map((f) => {
    const w = canon.prepare(read(f));
    return { name: path.basename(f), turn: ((w.settings || {}).time || {}).turn || 0, candidates: canon.scanOne(ref, w) };
  });
  const merged = canon.merge(scans);
  const by = {};
  for (const c of merged) (by[c.kind] = by[c.kind] || []).push(c);
  const TITLE = { add: 'New records', text: 'Text & look edits', setup: 'Setup edits', ownership: 'Ownership edits', remove: 'Removed since the seed', setting: 'Settings' };
  for (const k of ['add', 'text', 'setup', 'ownership', 'remove', 'setting']) {
    const list = by[k] || [];
    if (!list.length) continue;
    console.log(`\n## ${TITLE[k]} (${list.length})`);
    for (const c of list) {
      const mark = c.suggest ? '[x]' : '[ ]';
      const tags = [c.coll, c.origin && c.origin !== 'gm' ? c.origin : '', !c.inLatest ? 'gone in latest' : '', 'since ' + c.firstSeen].filter(Boolean).join(' · ');
      let detail = '';
      if (c.fields) detail = Object.keys(c.fields).map(f => `${f}: ${short(c.from && c.from[f])} → ${short(c.fields[f])}`).join(' | ');
      console.log(`${mark} ${c.label} — ${tags}${detail ? '\n      ' + detail : ''}`);
    }
  }
  console.log(`\n${merged.length} candidates, ${merged.filter(c => c.suggest).length} suggested.`);
  if (out) { fs.writeFileSync(out, JSON.stringify(merged, null, 1)); console.log('wrote', out); }
} else if (cmd === 'keep') {
  const [worldFile, reviewFile] = args;
  if (!worldFile || !reviewFile) { console.error('usage: keep <world.json> <review.json> [--all|--suggested]'); process.exit(1); }
  const all = has('--all');
  const world = read(worldFile);
  const picks = read(reviewFile).filter(c => all || c.suggest);
  const saved = canon.save(world, picks, 'world-canon tool');
  fs.writeFileSync(worldFile, JSON.stringify(world));
  console.log(`kept ${saved.length} entries in ${worldFile} (canon now ${Object.keys(world.canon.entries).length})`);
} else if (cmd === 'bake') {
  const worldFile = args[0];
  const out = flag('--out') || path.join(__dirname, '..', 'data', 'baseline-world.json');
  if (!worldFile) { console.error('usage: bake <world.json> [--out file]'); process.exit(1); }
  const baked = canon.bake(read(worldFile));
  const rep = (baked.canon && baked.canon.lastApplied) || {};
  fs.writeFileSync(out, JSON.stringify(baked, null, 1));
  console.log(`wrote ${out}: ${rep.applied || 0} canon entries applied` + ((rep.skipped || []).length ? `, ${rep.skipped.length} skipped:` : ''));
  for (const s of rep.skipped || []) console.log('  -', s.key, '—', s.why);
} else {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('\n').slice(1).map(l => l.replace(/^\s?\/?\*?\s?/, '')).join('\n'));
}
