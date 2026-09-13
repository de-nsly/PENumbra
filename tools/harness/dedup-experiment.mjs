#!/usr/bin/env node
/* ================================================================
   tools/harness/dedup-experiment.mjs — is dedupCollinear still unsafe
   on Contour?

   sv/sh are excluded from dedupCollinear (js/worker/solver.js, Step 7 /
   Phase 3b) on the strength of a measurement taken when Contour was
   generated a different way: a self-crossing torus knot went from 22
   paths (one closed) to 81 fragmented ones purely by enabling it. This
   re-runs that question against the CURRENT pipeline without touching
   the app: the real dedupCollinear is imported and applied to the real
   worker's sv/sh output, and the emitted path is rebuilt through the
   real chaining tail.

   Applied at the END of the pipeline (after the cross-layer cascade),
   not at Step 7's original position — running a duplicate-removal pass
   before the cascade lets the segment it keeps be subtracted away by a
   higher layer a moment later, which was measured to take real ink off
   the page. That makes this a slightly different question from the
   original, in the safer direction.

   Four things get measured per view, because "does it help" and "is it
   safe" are different questions and the historical objection was about
   neither ink nor coverage but CHAIN QUALITY:
     doubled  - overlapping near-coincident ink (the thing to remove)
     gap      - coverage cells inked before, empty after, AND with no ink
                in any neighbouring cell either: ink actually gone from
                the page. Cells that merely moved into a neighbour are
                counted as `shift` instead, because a surviving strand
                sits up to offTol from the one it replaced and that is
                not a defect.
     moved    - how far the drawn line shifts (dedupCollinear MERGES
                strands into a new backbone, so it can displace ink
                that no coverage measure at grid resolution would catch)
     paths    - emitted subpaths / closed subpaths (the 81-vs-22 metric)

     node tools/harness/dedup-experiment.mjs pen_files/pipe_X_aligned.pen
     node tools/harness/dedup-experiment.mjs scene.pen --all-layers
   ================================================================ */
import { openScene, DEFAULT_VIEWPORT } from './app.mjs';
import { layerPathD, pathDToSegs } from './svg.mjs';
import { dedupCollinear, dedupCrossRunCoincident } from '../../js/worker/dedup.js';
import { findDoubleInk } from './double-ink.mjs';

const argv = process.argv.slice(2);
const pen = argv.find(a => !a.startsWith('--'));
if (!pen){
  console.error('usage: node tools/harness/dedup-experiment.mjs <scene.pen|demo> [--all-layers]');
  process.exit(1);
}
const allLayers = argv.includes('--all-layers');
const KEYS = ['sv','sh'];

const app = await openScene(pen, { viewport: DEFAULT_VIEWPORT });
app.setLayers(allLayers
  ? { so:true, iv:true, ih:true, sv:true, sh:true, cv:true, ch:true }
  : { so:false, iv:false, ih:false, sv:true, sh:true, cv:false, ch:false });

/* The worker's own per-call tolerances, recomputed here from the same
   inputs (js/worker/solver.js — worldNoiseFloor / pxPerWorldUnit /
   effOffTol / effGapTol) so the experiment feeds dedupCollinear exactly
   what generate() would have. */
function tolerances(cam){
  const P = cam.proj, V = cam.view, W = cam.w;
  const c = app.loaded.center;
  let pxPerWorldUnit;
  if (cam.ortho) pxPerWorldUnit = Math.abs(P[0]) * 0.5 * W;
  else {
    const mvz = V[2]*c[0] + V[6]*c[1] + V[10]*c[2] + V[14];
    pxPerWorldUnit = Math.abs(P[0]) * 0.5 * W / Math.max(1e-6, -mvz);
  }
  const clampPx = (v,lo,hi) => Math.max(lo, Math.min(hi, v));
  const baseOffTol = clampPx(app.loaded.radius * 1.1e-3 * pxPerWorldUnit, 0.03, 1.5);
  const baseGapTol = clampPx(baseOffTol * 2, 0.06, 3);
  return { off: baseOffTol * 0.5, gap: baseGapTol };     // dedupOffMult/dedupGapMult are 1 in this scene
}

const CELL = 0.5;
const cellsOf = (segs) => {
  const s = new Set();
  for (let i=0;i<segs.length;i+=4){
    const n = Math.max(1, Math.ceil(Math.hypot(segs[i+2]-segs[i], segs[i+3]-segs[i+1]) / (CELL/2)));
    for (let k=0;k<=n;k++){
      const t=k/n;
      s.add(Math.round((segs[i]+(segs[i+2]-segs[i])*t)/CELL) + ',' +
            Math.round((segs[i+1]+(segs[i+3]-segs[i+1])*t)/CELL));
    }
  }
  return s;
};
// split cells present in `before` and absent from `after` into ink that
// merely moved into a neighbouring cell, and ink that is simply gone
function lostBreakdown(before, after){
  let shift = 0, gap = 0;
  for (const key of before){
    if (after.has(key)) continue;
    const [cx, cy] = key.split(',').map(Number);
    let near = false;
    for (let dx=-1; dx<=1 && !near; dx++) for (let dy=-1; dy<=1; dy++)
      if (after.has((cx+dx) + ',' + (cy+dy))){ near = true; break; }
    if (near) shift++; else gap++;
  }
  return { shift, gap };
}
/* How far the drawn line moved: for every point of the AFTER ink, the
   distance to the nearest BEFORE segment. dedupCollinear replaces a cluster
   of strands with one backbone, so this is the measure that catches a line
   sliding sideways — coverage on a 0.5px grid mostly cannot. */
function maxDisplacement(before, after){
  const G = 4, grid = new Map();
  for (let i=0;i<before.length;i+=4){
    const x0=Math.min(before[i],before[i+2]), x1=Math.max(before[i],before[i+2]);
    const y0=Math.min(before[i+1],before[i+3]), y1=Math.max(before[i+1],before[i+3]);
    for (let cx=Math.floor(x0/G);cx<=Math.floor(x1/G);cx++)
      for (let cy=Math.floor(y0/G);cy<=Math.floor(y1/G);cy++){
        const k=cx+'_'+cy; let l=grid.get(k); if(!l){l=[];grid.set(k,l);} l.push(i);
      }
  }
  const distTo = (px,py) => {
    let best = Infinity;
    const cx=Math.floor(px/G), cy=Math.floor(py/G);
    for (let r=0;r<=2 && best===Infinity || r<=1;r++){
      for (let ix=cx-r;ix<=cx+r;ix++) for (let iy=cy-r;iy<=cy+r;iy++){
        const l=grid.get(ix+'_'+iy); if(!l) continue;
        for (const i of l){
          const dx=before[i+2]-before[i], dy=before[i+3]-before[i+1], L2=dx*dx+dy*dy;
          let t = L2>1e-12 ? ((px-before[i])*dx+(py-before[i+1])*dy)/L2 : 0;
          t = Math.max(0, Math.min(1, t));
          best = Math.min(best, Math.hypot(px-(before[i]+t*dx), py-(before[i+1]+t*dy)));
        }
      }
    }
    return best;
  };
  let worst = 0;
  for (let i=0;i<after.length;i+=4){
    const n = Math.max(1, Math.ceil(Math.hypot(after[i+2]-after[i], after[i+3]-after[i+1])/2));
    for (let k=0;k<=n;k++){
      const t=k/n;
      const d = distTo(after[i]+(after[i+2]-after[i])*t, after[i+1]+(after[i+3]-after[i+1])*t);
      if (Number.isFinite(d)) worst = Math.max(worst, d);
    }
  }
  return worst;
}

// emitted path for a possibly-substituted set of groups
function emit(m, override){
  const mm = { ...m, groups: { ...m.groups }, runIds: { ...m.runIds }, seqs: { ...m.seqs } };
  if (override) for (const k of KEYS){
    mm.groups[k] = override[k].arr; mm.runIds[k] = override[k].runIds; mm.seqs[k] = override[k].seqs;
  }
  const mmToPx = 1/app.computePaperLayout({ w: m.w, h: m.h }).scale;
  let segs = [], paths = 0, closed = 0;
  for (const k of KEYS){
    const d = layerPathD(mm, k, { mmToPx });
    if (!d) continue;
    segs = segs.concat(pathDToSegs(d));
    paths += (d.match(/M/g) || []).length;
    closed += (d.match(/Z/g) || []).length;
  }
  return { segs, paths, closed, groups: mm.groups };
}

const D = Math.PI/180;
const VIEWS = [['scene',null,null,0,null],
  ['axis+X',90*D,90*D,0,true], ['axis+Xp',90*D,90*D,0,false],
  ['axis-X',-90*D,90*D,0,true], ['axis+Z',0,90*D,0,true], ['axis-Z',180*D,90*D,0,true],
  ['axis+Y',0,0,1,true], ['axis-Y',0,180*D,-1,true],
  ['off 1deg',91*D,90*D,0,true], ['off 5deg',95*D,90*D,0,true],
  ['gen 63/72',63*D,72*D,0,true], ['gen 214/115',214*D,115*D,0,false],
  ['gen 305/38',305*D,38*D,0,true], ['gen 17/38',17*D,38*D,0,false]];

console.log('scene: ' + pen + '   layers: ' + (allLayers ? 'all seven' : 'sv + sh only'));
console.log('pass applied at the END of the pipeline, with the worker\'s own effOffTol/effGapTol\n');
const hdr = 'view          variant      segs  doubled(mm)    gap  shift  gained   moved(px)  paths  closed';
console.log(hdr);
console.log('-'.repeat(hdr.length));
const totals = {};
for (const [name, th, ph, pole, ortho] of VIEWS){
  if (th !== null){
    app.setProjMode(ortho ? 'ortho' : 'persp');
    app.orbit.theta = th; app.orbit.phi = ph; app.orbit.exactPole = pole;
    app.orbit.apply();
  }
  // the pass is on by default in the worker now — turn it off so the
  // baseline is the raw Contour both variants below start from
  const m = app.generate({ contourCoincidentDedup: false });
  const tol = tolerances(app.lastCam);
  const mmPerPx = app.computePaperLayout({ w: m.w, h: m.h }).scale;

  const variants = { baseline: null };
  variants.dedupCollinear = Object.fromEntries(KEYS.map(k => [k,
    m.groups[k].length
      ? dedupCollinear(Array.from(m.groups[k]), tol.off, tol.gap, Array.from(m.runIds[k]), Array.from(m.seqs[k]))
      : { arr: [], runIds: [], seqs: [] }]));
  variants.crossRunOnly = Object.fromEntries(KEYS.map(k => [k,
    m.groups[k].length
      ? dedupCrossRunCoincident(Array.from(m.groups[k]), Array.from(m.runIds[k]), Array.from(m.seqs[k]), tol.off)
      : { arr: [], runIds: [], seqs: [] }]));

  const base = emit(m, null);
  const baseCells = cellsOf(base.segs);
  for (const [label, ov] of Object.entries(variants)){
    const r = ov ? emit(m, ov) : base;
    const cells = cellsOf(r.segs);
    const { shift, gap } = lostBreakdown(baseCells, cells);
    let gained = 0;
    for (const c of cells) if (!baseCells.has(c)) gained++;
    let dbl = 0;
    for (const k of KEYS){
      const g = r.groups[k];
      if (!g || !g.length) continue;
      for (const p of findDoubleInk(g, r.groups === base.groups ? m.runIds[k] : (ov ? ov[k].runIds : m.runIds[k])))
        dbl += p.overlap;
    }
    const moved = ov ? maxDisplacement(base.segs, r.segs) : 0;
    const segs = KEYS.reduce((t,k) => t + (r.groups[k] ? r.groups[k].length/4 : 0), 0);
    console.log(name.padEnd(13) + label.padEnd(14) + String(segs).padStart(5) +
      (dbl*mmPerPx).toFixed(2).padStart(12) + String(gap).padStart(7) + String(shift).padStart(7) +
      String(gained).padStart(8) + moved.toFixed(3).padStart(12) + String(r.paths).padStart(7) +
      String(r.closed).padStart(8));
    const t = totals[label] || (totals[label] = { dbl:0, gap:0, shift:0, moved:0, paths:0, closed:0 });
    t.dbl += dbl*mmPerPx; t.gap += gap; t.shift += shift; t.moved = Math.max(t.moved, moved);
    t.paths += r.paths; t.closed += r.closed;
  }
  console.log('');
}
console.log('=== totals across ' + VIEWS.length + ' views ===');
console.log('variant          doubled(mm)    gap cells   shift cells   worst move(px)   paths   closed');
for (const [label, t] of Object.entries(totals))
  console.log(label.padEnd(17) + t.dbl.toFixed(1).padStart(11) + String(t.gap).padStart(12) +
    String(t.shift).padStart(14) + t.moved.toFixed(3).padStart(17) + String(t.paths).padStart(8) +
    String(t.closed).padStart(9));
