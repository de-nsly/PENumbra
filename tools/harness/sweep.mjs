#!/usr/bin/env node
/* ================================================================
   tools/harness/sweep.mjs — golden-output regression sweep
   Solves one scene from many camera angles with every line layer on,
   and writes a fingerprint of the RESULT (per view, per layer: the
   emitted path data's hash, its segment count, and its total drawn
   length in solver px). Capture one before a change and one after,
   then `--diff` them: anything that moved shows up, with the direction
   of the change in ink length — which is the signal that matters for
   a "stop deleting ink" fix, since it must only ever ADD.

   Views deliberately include the degenerate ones this pipeline is
   fragile in: the six exact axis-aligned orthographic poles (where
   different parts of the mesh project onto each other exactly), plus
   a generic off-axis grid in both projections, plus the scene's own
   saved camera.

     node tools/harness/sweep.mjs scene.pen --out before.json
     …make the change…
     node tools/harness/sweep.mjs scene.pen --out after.json
     node tools/harness/sweep.mjs --diff before.json after.json

   Two different length numbers are recorded per (view, layer), because two
   different kinds of change need two different invariants:

     len — total pen travel. A stretch drawn twice counts twice.
     cov — the UNION of that ink: every distinct stretch of page that ends up
           with pen on it, counted once no matter how many strokes cover it.

   A fix that stops ink going missing must never DECREASE either. A fix that
   removes duplicate strokes must decrease `len` while leaving `cov` exactly
   alone — if `cov` drops, it deleted the last copy of something, which is a
   real regression however much cleaner the numbers look.
   ================================================================ */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { openScene, DEFAULT_VIEWPORT } from './app.mjs';
import { layerPathD, pathDToSegs } from './svg.mjs';

const argv = process.argv.slice(2);
const diffAt = argv.indexOf('--diff');

/* ---------------- diff mode ---------------- */
if (diffAt >= 0){
  const A = JSON.parse(readFileSync(argv[diffAt+1], 'utf8'));
  const B = JSON.parse(readFileSync(argv[diffAt+2], 'utf8'));
  if (A.scene !== B.scene) console.log('NOTE: different scenes (' + A.scene + ' vs ' + B.scene + ')');
  let same = 0; const changed = [];
  for (const view of Object.keys(A.views)){
    const a = A.views[view], b = B.views[view];
    if (!b){ changed.push({ view, layer: '*', note: 'missing in second run' }); continue; }
    for (const layer of Object.keys(a)){
      const x = a[layer], y = b[layer];
      if (!y){ changed.push({ view, layer, note: 'missing in second run' }); continue; }
      if (x.hash === y.hash){ same++; continue; }
      const dCov = (y.cov ?? 0) - (x.cov ?? 0);
      changed.push({ view, layer,
        dSegs: y.segs - x.segs, dLen: y.len - x.len, dCov,
        note: dCov < -1e-3 ? 'COVERAGE LOST'
            : dCov > 1e-3 ? 'COVERAGE GAINED'
            : y.len < x.len - 1e-6 ? 'duplicate ink removed'
            : y.len > x.len + 1e-6 ? 'ink added (same coverage)'
            : 'reordered / same length' });
    }
  }
  console.log('identical: ' + same + ' (view,layer) pairs');
  console.log('changed  : ' + changed.length);
  // whole-page coverage, per view — the one number a change must not reduce
  const pageLoss = [];
  for (const view of Object.keys(A.views)){
    const x = A.views[view]._all, y = B.views[view] && B.views[view]._all;
    if (!x || !y) continue;
    if (y.cov < x.cov - 1e-3) pageLoss.push({ view, d: y.cov - x.cov });
  }
  console.log('whole-page coverage: ' + (pageLoss.length
    ? pageLoss.length + ' view(s) LOST — ' + pageLoss.map(p => p.view + ' ' + p.d.toFixed(2) + 'px').join(', ')
    : 'not reduced in any view'));
  const lost = changed.filter(c => c.note === 'COVERAGE LOST' && c.layer !== '_all');
  for (const c of changed)
    console.log('   ' + c.view.padEnd(22) + c.layer.padEnd(4) +
      (c.note === 'missing in second run' ? c.note
        : c.note.padEnd(24) + 'segs ' + (c.dSegs>=0?'+':'') + String(c.dSegs).padEnd(6) +
          'len ' + (c.dLen>=0?'+':'') + c.dLen.toFixed(2).padEnd(10) +
          'cov ' + (c.dCov>=0?'+':'') + c.dCov.toFixed(3)));
  console.log(lost.length
    ? '\n' + lost.length + ' (view,layer) pair(s) lost coverage in their OWN layer — check the whole-page line above ' +
      'to tell "moved to another layer" from "gone from the page".'
    : '\nno per-layer coverage lost anywhere.');
  process.exit(0);
}

/* ---------------- compare mode ----------------
   Runs each view TWICE in one process — once with the --base overrides (the
   "before"), once with the --set overrides (the "after") — and compares the
   two coverage cell sets. Either side may be empty, i.e. the scene as the app
   solves it by default. To check a pass that is ON by default, turn it off on
   the base side: --compare --base contourCoincidentDedup=false. Compares
   exactly. This is the check a duplicate-removal change has to pass: cells
   marked before and not after are ink that left the page, no matter how the
   layers rearranged themselves. Kept separate from the fingerprint files
   because an exact set difference can't be reconstructed from a stored
   summary. */
const compareMode = argv.includes('--compare');

/* ---------------- capture mode ---------------- */
const pen = argv.find(a => !a.startsWith('--') && !/=/.test(a));
const outAt = argv.indexOf('--out');
const vpAt = argv.indexOf('--vp');
if (!pen || (outAt < 0 && !compareMode)){
  console.error('usage: node tools/harness/sweep.mjs <scene.pen> --out fingerprint.json [--vp WxH]\n' +
                '       node tools/harness/sweep.mjs <scene.pen> --compare [--base key=value] [--set key=value]\n' +
                '       node tools/harness/sweep.mjs --diff before.json after.json');
  process.exit(1);
}
const vp = vpAt >= 0 ? (([w,h]) => ({w,h}))(argv[vpAt+1].split('x').map(Number)) : DEFAULT_VIEWPORT;
// --set k=v overrides one solver setting for every view in the sweep, so a
// change that lives behind a flag can be A/B'd without editing anything
const overrides = {}, baseOverrides = {};
for (let i = 0; i < argv.length; i++) if (argv[i] === '--set' || argv[i] === '--base'){
  const [k, v] = argv[i+1].split('=');
  (argv[i] === '--set' ? overrides : baseOverrides)[k] =
    v === 'true' ? true : v === 'false' ? false : isNaN(+v) ? v : +v;
}

const D = Math.PI/180;
/* The six exact axis-aligned poles, as the app's own view-preset buttons set
   them (see GIZMO_AXES / setProjMode in js/viewport/viewport3d.js): +/-Y goes through
   orbit.exactPole, the four side views through plain theta/phi. These are the
   views where coincident projection is the norm rather than the exception. */
const AXIS_VIEWS = [
  { name: 'axis+X',  theta: 90*D,  phi: 90*D, pole: 0 },
  { name: 'axis-X',  theta: -90*D, phi: 90*D, pole: 0 },
  { name: 'axis+Z',  theta: 0,     phi: 90*D, pole: 0 },
  { name: 'axis-Z',  theta: 180*D, phi: 90*D, pole: 0 },
  { name: 'axis+Y',  theta: 0,     phi: 0,    pole: 1 },
  { name: 'axis-Y',  theta: 0,     phi: 180*D, pole: -1 },
];
const views = [];
for (const v of AXIS_VIEWS){ views.push({ ...v, ortho: true }); views.push({ ...v, name: v.name+'p', ortho: false }); }
// generic off-axis grid — nothing coincident, so these are the "did the fix
// disturb ordinary output?" control group
for (const th of [17, 63, 128, 214, 305])
  for (const ph of [38, 72, 115])
    views.push({ name: 'gen' + th + '_' + ph, theta: th*D, phi: ph*D, pole: 0, ortho: th < 200 });

const LAYERS = ['so','iv','ih','sv','sh','cv','ch'];
const app = await openScene(pen, { viewport: vp });
app.setLayers(Object.fromEntries(LAYERS.map(k => [k, true])));
views.unshift({ name: 'scene', theta: app.orbit.theta, phi: app.orbit.phi,
                pole: app.orbit.exactPole, ortho: app.scene.camera.ortho });

/* Union of ink: cluster every segment onto an infinite line (direction mod π
   + perpendicular offset), then merge overlapping intervals along each line
   and total what's left. The offset tolerance has to match the scale at
   which two strokes count as "the same line on the page" — deliberately the
   same order as the solver's own dedup tolerance, since that is the claim a
   duplicate-removal fix is making when it deletes one of them. */
/* Coverage as a set of marked cells on a fixed grid, NOT as clustered
   collinear intervals. Clustering was tried first and is actively misleading
   here: deciding which strokes lie on "the same line" is a greedy,
   seed-order-dependent judgment, and the strokes under test are 0.02-0.3px
   apart — precisely the regime where that judgment flips between two runs
   and reports ink as lost that is plainly still on the page. A grid has no
   such decision in it. Cells are 0.5px, comfortably above the separations
   that count as duplicate ink and below MIN_SEG, so two strokes a hair apart
   mark the same cells and removing one changes nothing. */
const COV_CELL = 0.5;
const coverageCells = (segs) => {
  const cells = new Set();
  for (let i = 0; i < segs.length; i += 4){
    const x0 = segs[i], y0 = segs[i+1], x1 = segs[i+2], y1 = segs[i+3];
    const len = Math.hypot(x1-x0, y1-y0);
    const steps = Math.max(1, Math.ceil(len / (COV_CELL/2)));
    for (let s = 0; s <= steps; s++){
      const t = s/steps;
      const cx = Math.round((x0 + (x1-x0)*t) / COV_CELL);
      const cy = Math.round((y0 + (y1-y0)*t) / COV_CELL);
      cells.add(cx + ',' + cy);         // string key so neighbours can be probed by name
    }
  }
  return cells;
};
const lenOf = (d) => {
  const t = d.trim().split(/[\s,]+/);
  let len = 0, c = null, s = null;
  for (let i = 0; i < t.length;){
    if (t[i] === 'M'){ c = [+t[i+1], +t[i+2]]; s = c; i += 3; }
    else if (t[i] === 'L'){ const p = [+t[i+1], +t[i+2]]; len += Math.hypot(p[0]-c[0], p[1]-c[1]); c = p; i += 3; }
    else if (t[i] === 'Z' || t[i] === 'z'){ len += Math.hypot(s[0]-c[0], s[1]-c[1]); c = s; i += 1; }
    else i += 1;
  }
  return len;
};
const allInk = (m) => {
  const mmToPx = 1/app.computePaperLayout({ w: m.w, h: m.h }).scale;
  const everything = [], perLayer = {};
  for (const k of LAYERS){
    const d = layerPathD(m, k, { mmToPx });
    const segs = pathDToSegs(d);
    everything.push(...segs);
    perLayer[k] = { d, segs, workerSegs: m.groups[k].length/4 };
  }
  return { everything, perLayer };
};

if (compareMode){
  if (!Object.keys(overrides).length && !Object.keys(baseOverrides).length){
    console.error('--compare needs a --base and/or --set key=value, or both sides are the same solve');
    process.exit(1);
  }
  console.log('comparing: ' + (JSON.stringify(baseOverrides) === '{}' ? 'default' : JSON.stringify(baseOverrides)) +
              ' -> ' + (JSON.stringify(overrides) === '{}' ? 'default' : JSON.stringify(overrides)));
  /* `gap` is ink gone from the page; `shift` is ink that moved into a
     neighbouring cell. The split matters: a pass that removes one of two
     strokes 0.2px apart leaves the surviving one slightly off where the
     removed one was, so a raw "cell was inked, now isn't" count reports that
     as loss when nothing is missing. Only `gap` is a defect. */
  console.log('view                 cells     gap   shift  gained   len before -> after');
  let anyLoss = false, totalLen = 0, totalLen2 = 0;
  for (const v of views){
    app.setProjMode(v.ortho ? 'ortho' : 'persp');
    app.orbit.theta = v.theta; app.orbit.phi = v.phi; app.orbit.exactPole = v.pole;
    app.orbit.apply();
    const A = allInk(app.generate(baseOverrides));
    const B = allInk(app.generate(overrides));
    const ca = coverageCells(A.everything), cb = coverageCells(B.everything);
    let gap = 0, shift = 0;
    for (const key of ca){
      if (cb.has(key)) continue;
      const [cx, cy] = key.split(',').map(Number);
      let near = false;
      for (let dx=-1; dx<=1 && !near; dx++) for (let dy=-1; dy<=1; dy++)
        if (cb.has((cx+dx) + ',' + (cy+dy))){ near = true; break; }
      if (near) shift++; else gap++;
    }
    let gained = 0; for (const c of cb) if (!ca.has(c)) gained++;
    const la = LAYERS.reduce((t,k) => t + lenOf(A.perLayer[k].d), 0);
    const lb = LAYERS.reduce((t,k) => t + lenOf(B.perLayer[k].d), 0);
    totalLen += la; totalLen2 += lb;
    if (gap) anyLoss = true;
    console.log(v.name.padEnd(18) + String(ca.size).padStart(8) + String(gap).padStart(7) +
      String(shift).padStart(8) + String(gained).padStart(8) + '   ' + la.toFixed(0).padStart(7) +
      ' -> ' + lb.toFixed(0).padStart(7) + (gap ? '   <-- INK GONE' : ''));
  }
  console.log('\ntotal pen travel: ' + totalLen.toFixed(0) + 'px -> ' + totalLen2.toFixed(0) + 'px  (' +
    (100*(totalLen2-totalLen)/totalLen).toFixed(1) + '%)');
  console.log(anyLoss
    ? '*** some views have gap cells — the change deletes ink nothing else redraws ***'
    : 'no view lost any ink (every changed cell is ink that moved < 0.5px, not ink removed).');
  process.exit(0);
}

const out = { scene: pen, vp, views: {} };
for (const v of views){
  app.setProjMode(v.ortho ? 'ortho' : 'persp');
  app.orbit.theta = v.theta; app.orbit.phi = v.phi; app.orbit.exactPole = v.pole;
  app.orbit.apply();
  const m = app.generate(overrides);
  const mmToPx = 1/app.computePaperLayout({ w: m.w, h: m.h }).scale;
  const { everything, perLayer } = allInk(m);
  const rec = {};
  for (const k of LAYERS)
    rec[k] = { hash: createHash('sha1').update(perLayer[k].d).digest('hex').slice(0, 12),
               segs: perLayer[k].workerSegs, len: +lenOf(perLayer[k].d).toFixed(4),
               cov: coverageCells(perLayer[k].segs).size };
  /* The invariant that actually matters: the union of ink across EVERY layer.
     A per-layer coverage drop is not by itself a regression — the cross-layer
     cascade legitimately moves a stretch from one layer to another, and the
     page looks the same. Only a drop in this total means something the
     drawing used to have is now missing from the page entirely. */
  rec._all = { hash: '-', segs: 0, len: 0, cov: coverageCells(everything).size };
  out.views[v.name] = rec;
  process.stdout.write('.');
}
writeFileSync(argv[outAt+1], JSON.stringify(out, null, 1));
console.log('\n' + views.length + ' views x ' + LAYERS.length + ' layers -> ' + argv[outAt+1]);
