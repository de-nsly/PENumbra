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
   ================================================================ */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { openScene, DEFAULT_VIEWPORT } from './app.mjs';
import { layerPathD } from './svg.mjs';

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
      changed.push({ view, layer,
        dSegs: y.segs - x.segs, dLen: y.len - x.len,
        note: (y.len > x.len + 1e-6 ? 'INK ADDED' : y.len < x.len - 1e-6 ? 'INK LOST' : 'reordered / same length') });
    }
  }
  console.log('identical: ' + same + ' (view,layer) pairs');
  console.log('changed  : ' + changed.length);
  const lost = changed.filter(c => c.note === 'INK LOST');
  for (const c of changed)
    console.log('   ' + c.view.padEnd(22) + c.layer.padEnd(4) +
      (c.note === 'missing in second run' ? c.note
        : c.note.padEnd(26) + 'segs ' + (c.dSegs>=0?'+':'') + c.dSegs + '   len ' + (c.dLen>=0?'+':'') + c.dLen.toFixed(2) + 'px'));
  console.log(lost.length
    ? '\n*** ' + lost.length + ' (view,layer) pair(s) LOST ink — investigate before accepting ***'
    : '\nno ink lost anywhere.');
  process.exit(0);
}

/* ---------------- capture mode ---------------- */
const pen = argv.find(a => !a.startsWith('--') );
const outAt = argv.indexOf('--out');
const vpAt = argv.indexOf('--vp');
if (!pen || outAt < 0){
  console.error('usage: node tools/harness/sweep.mjs <scene.pen> --out fingerprint.json [--vp WxH]\n' +
                '       node tools/harness/sweep.mjs --diff before.json after.json');
  process.exit(1);
}
const vp = vpAt >= 0 ? (([w,h]) => ({w,h}))(argv[vpAt+1].split('x').map(Number)) : DEFAULT_VIEWPORT;

const D = Math.PI/180;
/* The six exact axis-aligned poles, as the app's own view-preset buttons set
   them (see GIZMO_AXES / setProjMode in js/viewport3d.js): +/-Y goes through
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
const out = { scene: pen, vp, views: {} };
for (const v of views){
  app.setProjMode(v.ortho ? 'ortho' : 'persp');
  app.orbit.theta = v.theta; app.orbit.phi = v.phi; app.orbit.exactPole = v.pole;
  app.orbit.apply();
  const m = app.generate();
  const mmToPx = 1/app.computePaperLayout({ w: m.w, h: m.h }).scale;
  const rec = {};
  for (const k of LAYERS){
    const d = layerPathD(m, k, { mmToPx });
    rec[k] = { hash: createHash('sha1').update(d).digest('hex').slice(0, 12),
               segs: m.groups[k].length/4, len: +lenOf(d).toFixed(4) };
  }
  out.views[v.name] = rec;
  process.stdout.write('.');
}
writeFileSync(argv[outAt+1], JSON.stringify(out, null, 1));
console.log('\n' + views.length + ' views x ' + LAYERS.length + ' layers -> ' + argv[outAt+1]);
