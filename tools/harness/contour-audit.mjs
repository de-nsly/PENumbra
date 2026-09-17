#!/usr/bin/env node
/* ================================================================
   tools/harness/contour-audit.mjs — where did Contour ink go?
   Two checks over one scene, both aimed at the "a stretch of Contour
   is simply absent" class of bug:

   1. FOLD-BACKS — re-runs simplifyCollinear's own sweep and reports
      every point whose projection onto the a→c line lands OUTSIDE the
      a..c span. For a genuinely straight run that never happens (the
      point always sits between its neighbours); when a chain doubles
      back on itself along a near-coincident line, it does, and
      dropping such a point would erase the whole out-and-back
      excursion rather than a redundant midpoint. Each is reported with
      its excursion length and whether the CURRENT rule collapses it
      (it may, below SIMPLIFY_FOLDBACK_TOL, where the excursion is too
      short to be a pen mark at all). A "COLLAPSED" line above that
      floor is the bug this check exists for.

   2. COLLINEAR HOLES — clusters all emitted ink onto infinite lines
      and reports gaps in the middle of an otherwise continuous run.
      A straight edge that is partly hidden should hand off to the
      hidden layer, not leave a hole, so a hole here means ink was lost
      somewhere in the pipeline (worker or main thread).

     node tools/harness/contour-audit.mjs pen_files/arches.pen
     node tools/harness/contour-audit.mjs scene.pen --hidden   # audit sv+sh together
     node tools/harness/contour-audit.mjs scene.pen --png out.png
   ================================================================ */
import { writeFileSync } from 'node:fs';
import { openScene, DEFAULT_VIEWPORT } from './app.mjs';
import { chainByRun, mergeContourRunSplits, splitSelfTouching, layerPathD, pathDToSegs,
         SIMPLIFY_COLLINEAR_TOL, SIMPLIFY_FOLDBACK_TOL } from './svg.mjs';
import { Raster } from './raster.mjs';

const argv = process.argv.slice(2);
const pen = argv.find(a => !a.startsWith('--'));
if (!pen){
  console.error('usage: node tools/harness/contour-audit.mjs <scene.pen> [--hidden] [--png file] [--vp WxH]');
  process.exit(1);
}
const withHidden = argv.includes('--hidden');
const pngAt = argv.indexOf('--png');
const vpAt = argv.indexOf('--vp');
const vp = vpAt >= 0
  ? (([w,h]) => ({w,h}))(argv[vpAt+1].split('x').map(Number))
  : DEFAULT_VIEWPORT;

// the real tolerances, lifted from js/chain.js — never a second copy
const TOL = SIMPLIFY_COLLINEAR_TOL, FOLD_TOL = SIMPLIFY_FOLDBACK_TOL;

const app = await openScene(pen, { viewport: vp });
app.setLayers({ so:false, iv:false, ih:false, cv:false, ch:false, sv:true, sh:withHidden });
const m = app.generate();

/* ---- 1. fold-back drops ---- */
// A transcription of simplifyCollinear's sweep (js/chain.js) that
// records, rather than performs, each drop — the audit needs the a/b/c
// triple and the projection parameter, which the real function doesn't
// return. Any change to the real sweep must be mirrored here.
function auditSimplify(pts, closed){
  const n = pts.length, drops = [];
  if (n < 3) return drops;
  let work = pts;
  if (closed){
    let bestI = 0, bestCross = -1;
    for (let i=0;i<n;i++){
      const a=pts[(i-1+n)%n], b=pts[i], c=pts[(i+1)%n];
      const cr = Math.abs((b[0]-a[0])*(c[1]-b[1]) - (b[1]-a[1])*(c[0]-b[0]));
      if (cr > bestCross){ bestCross = cr; bestI = i; }
    }
    work = pts.slice(bestI).concat(pts.slice(0, bestI));
  }
  const out = [work[0]], last = closed ? n : n-1;
  for (let i=1;i<last;i++){
    const a = out[out.length-1], b = work[i], c = work[(i+1)%n];
    const acx = c[0]-a[0], acy = c[1]-a[1], lenAC = Math.hypot(acx, acy);
    if (lenAC > 1e-9){
      const cross = (b[0]-a[0])*acy - (b[1]-a[1])*acx;
      const t = ((b[0]-a[0])*acx + (b[1]-a[1])*acy) / (lenAC*lenAC);
      const excursion = t < 0 ? -t*lenAC : t > 1 ? (t-1)*lenAC : 0;
      const nearLine = Math.abs(cross)/lenAC <= TOL;
      if (nearLine && excursion > 0)
        drops.push({ a, b, c, t, excursion, perp: Math.abs(cross)/lenAC,
                     collapsed: excursion <= FOLD_TOL });
      if (nearLine && excursion <= FOLD_TOL) continue;   // mirrors simplifyCollinear
    }
    out.push(b);
  }
  return drops;
}

const keys = withHidden ? ['sv','sh'] : ['sv'];
const foldbacks = [];
for (const k of keys){
  if (k === 'sh' && !m.groups.sh.length) continue;
  const chains = mergeContourRunSplits(
    chainByRun(m.groups[k], m.runIds[k], m.seqs[k]), m.counts.contourAdjacency);
  for (const c of chains)
    for (const p of splitSelfTouching(c.pts, c.closed))
      for (const d of auditSimplify(p.pts, p.closed)) foldbacks.push({ ...d, layer: k });
}
foldbacks.sort((x,y) => y.excursion - x.excursion);
const significant = foldbacks.filter(d => d.excursion >= 1);
const erased = foldbacks.filter(d => d.collapsed && d.excursion > FOLD_TOL);
console.log('== simplifyCollinear fold-backs ==');
console.log('   ' + foldbacks.length + ' total, ' + significant.length + ' with an excursion >= 1px' +
            '  (line tol=' + TOL + 'px, fold-back tol=' + FOLD_TOL + 'px)');
for (const d of significant)
  console.log('   [' + d.layer + '] ' + (d.collapsed ? 'COLLAPSED' : 'preserved') +
    '  excursion ' + d.excursion.toFixed(2) + 'px  perpendicular offset ' + d.perp.toFixed(4) + 'px\n' +
    '        a=(' + d.a[0].toFixed(2) + ',' + d.a[1].toFixed(2) + ')  ' +
    'b=(' + d.b[0].toFixed(2) + ',' + d.b[1].toFixed(2) + ')  ' +
    'c=(' + d.c[0].toFixed(2) + ',' + d.c[1].toFixed(2) + ')   t=' + d.t.toFixed(3));
if (erased.length) console.log('   *** ' + erased.length + ' fold-back(s) still collapsed above the floor — real ink is being deleted ***');

/* ---- 2. holes in collinear runs ---- */
const segs = [];
for (const k of keys){ const g = m.groups[k];
  for (let i=0;i<g.length;i+=4) segs.push([g[i],g[i+1],g[i+2],g[i+3]]); }
const ANG_TOL = 0.004, OFF_TOL = 0.35, JOIN = 0.35;
const lines = [];
for (const s of segs){
  const dx=s[2]-s[0], dy=s[3]-s[1]; if (Math.hypot(dx,dy) < 1e-9) continue;
  let ang = Math.atan2(dy,dx); if (ang < 0) ang += Math.PI; if (ang >= Math.PI-1e-12) ang -= Math.PI;
  const nx = -Math.sin(ang), ny = Math.cos(ang), off = s[0]*nx + s[1]*ny;
  let L = lines.find(l => Math.abs(((l.ang-ang+Math.PI/2)%Math.PI)-Math.PI/2) < ANG_TOL && Math.abs(l.off-off) < OFF_TOL);
  if (!L){ L = { ang, off, nx, ny, ux: Math.cos(ang), uy: Math.sin(ang), iv: [] }; lines.push(L); }
  const t0 = s[0]*L.ux + s[1]*L.uy, t1 = s[2]*L.ux + s[3]*L.uy;
  L.iv.push([Math.min(t0,t1), Math.max(t0,t1)]);
}
const holes = [];
for (const L of lines){
  L.iv.sort((p,q) => p[0]-q[0]);
  const merged = [];
  for (const v of L.iv){
    const last = merged[merged.length-1];
    if (last && v[0] <= last[1] + JOIN) last[1] = Math.max(last[1], v[1]); else merged.push(v.slice());
  }
  for (let i=0;i+1<merged.length;i++){
    const gap = merged[i+1][0] - merged[i][1];
    if (gap < 2 || gap > 250) continue;
    holes.push({ gap,
      p: [L.ux*merged[i][1] + L.nx*L.off,   L.uy*merged[i][1] + L.ny*L.off],
      q: [L.ux*merged[i+1][0] + L.nx*L.off, L.uy*merged[i+1][0] + L.ny*L.off] });
  }
}
holes.sort((x,y) => y.gap - x.gap);
console.log('\n== holes in otherwise-continuous straight runs (' + keys.join('+') + ') ==');
console.log('   ' + holes.length + ' found');
for (const h of holes.slice(0, 15))
  console.log('   gap ' + h.gap.toFixed(2).padStart(7) + 'px  (' + h.p[0].toFixed(1) + ',' + h.p[1].toFixed(1) +
    ') -> (' + h.q[0].toFixed(1) + ',' + h.q[1].toFixed(1) + ')');

if (pngAt >= 0){
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for (const s of segs){ x0=Math.min(x0,s[0],s[2]); x1=Math.max(x1,s[0],s[2]);
                         y0=Math.min(y0,s[1],s[3]); y1=Math.max(y1,s[1],s[3]); }
  // the EMITTED path, not m.groups — the chaining tail is where ink vanishes,
  // so a picture of the raw worker output would hide exactly what's being audited
  const mmToPx = 1/app.computePaperLayout({ w: m.w, h: m.h }).scale;
  const r = new Raster({x0,y0,x1,y1}, 1.13);
  if (withHidden) r.segs(pathDToSegs(layerPathD(m, 'sh', { mmToPx })), [175,178,184], 1.0);
  r.segs(pathDToSegs(layerPathD(m, 'sv', { mmToPx })), [20,20,20], 1.2);
  for (const d of significant){ r.line(d.a[0],d.a[1],d.b[0],d.b[1],[0,150,235],3);
                                r.line(d.b[0],d.b[1],d.c[0],d.c[1],[0,150,235],3); }
  writeFileSync(argv[pngAt+1], r.png());
  console.log('\nwrote ' + argv[pngAt+1] + '  (erased fold-backs in blue)');
}
