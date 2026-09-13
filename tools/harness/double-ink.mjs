#!/usr/bin/env node
/* ================================================================
   tools/harness/double-ink.mjs — where does the plotter re-stroke?
   Finds pairs of near-parallel, near-coincident, OVERLAPPING segments
   within one layer: ink the pen draws twice. Reports the overlap in
   both solver px and real mm on the scene's paper, and whether the two
   sides come from the same Contour run or different ones — the
   distinction that matters, since a run can't duplicate itself (the
   worker's own run identity guarantees that), so anything found here
   is by construction cross-run.

   Two parts of the mesh whose silhouettes project onto the same screen
   line produce exactly this, which is routine in axis-aligned
   orthographic views and essentially absent in generic ones — so the
   sweep across views is the interesting output, not the single number.

     node tools/harness/double-ink.mjs pen_files/pipe_X_aligned.pen
     node tools/harness/double-ink.mjs scene.pen --layer sh
     node tools/harness/double-ink.mjs scene.pen --views     # sweep the standard views
     node tools/harness/double-ink.mjs scene.pen --set contourCoincidentDedup=false   # without the dedup pass
   ================================================================ */
import { pathToFileURL } from 'node:url';
import { openScene, DEFAULT_VIEWPORT } from './app.mjs';

/* Near-parallel + near-coincident + overlapping. Tolerances are deliberately
   loose (0.25px apart, 0.3px = MIN_SEG of overlap) so nothing is missed; the
   actual separation of each pair is reported so you can judge it yourself. */
const PERP_MAX = 0.25, MIN_OVERLAP = 0.3, PARALLEL_COS = 0.99995;
export function findDoubleInk(segArr, runIds){
  const n = segArr.length/4, out = [];
  for (let i = 0; i < n; i++){
    const ax0=segArr[i*4], ay0=segArr[i*4+1], ax1=segArr[i*4+2], ay1=segArr[i*4+3];
    const adx=ax1-ax0, ady=ay1-ay0, aL=Math.hypot(adx,ady);
    if (aL < 1e-9) continue;
    const ux=adx/aL, uy=ady/aL;
    for (let j = i+1; j < n; j++){
      const bx0=segArr[j*4], by0=segArr[j*4+1], bx1=segArr[j*4+2], by1=segArr[j*4+3];
      const bdx=bx1-bx0, bdy=by1-by0, bL=Math.hypot(bdx,bdy);
      if (bL < 1e-9) continue;
      if (Math.abs((adx*bdx+ady*bdy)/(aL*bL)) < PARALLEL_COS) continue;
      const d0=Math.abs((bx0-ax0)*uy-(by0-ay0)*ux), d1=Math.abs((bx1-ax0)*uy-(by1-ay0)*ux);
      if (Math.max(d0,d1) > PERP_MAX) continue;
      const t0=(bx0-ax0)*ux+(by0-ay0)*uy, t1=(bx1-ax0)*ux+(by1-ay0)*uy;
      const lo=Math.max(0, Math.min(t0,t1)), hi=Math.min(aL, Math.max(t0,t1));
      if (hi - lo <= MIN_OVERLAP) continue;
      out.push({ i, j, overlap: hi-lo, sep: (d0+d1)/2,
                 sameRun: runIds ? runIds[i] === runIds[j] : null,
                 runA: runIds ? runIds[i] : null, runB: runIds ? runIds[j] : null,
                 mid: [ax0+ux*(lo+hi)/2, ay0+uy*(lo+hi)/2] });
    }
  }
  return out;
}

/* findDoubleInk above is imported by other harness tools, so the CLI only
   runs when this file IS the program. */
if (!process.argv[1] || import.meta.url !== pathToFileURL(process.argv[1]).href) {
  // imported as a library — nothing else to do
} else {

const argv = process.argv.slice(2);
const pen = argv.find(a => !a.startsWith('--') && !/=/.test(a));
if (!pen){
  console.error('usage: node tools/harness/double-ink.mjs <scene.pen|demo> [--layer sv] [--views] [--set k=v]');
  process.exit(1);
}
const at = f => argv.indexOf(f);
const layer = at('--layer') >= 0 ? argv[at('--layer')+1] : 'sv';
const doViews = argv.includes('--views');
const overrides = {};
for (let i = 0; i < argv.length; i++) if (argv[i] === '--set'){
  const [k, v] = argv[i+1].split('=');
  overrides[k] = v === 'true' ? true : v === 'false' ? false : isNaN(+v) ? v : +v;
}

const app = await openScene(pen, { viewport: DEFAULT_VIEWPORT });
app.setLayers({ so:false, iv:false, ih:false, cv:false, ch:false,
                sv: layer === 'sv' || layer === 'sh', sh: layer === 'sh' });

const D = Math.PI/180;
const VIEWS = doViews
  ? [['scene',null,null,0], ['axis+X',90*D,90*D,0], ['axis-X',-90*D,90*D,0],
     ['axis+Z',0,90*D,0], ['axis-Z',180*D,90*D,0], ['axis+Y',0,0,1], ['axis-Y',0,180*D,-1],
     ['off 1deg',91*D,90*D,0], ['off 5deg',95*D,90*D,0],
     ['generic a',63*D,72*D,0], ['generic b',214*D,115*D,0], ['generic c',305*D,38*D,0]]
  : [['scene',null,null,0]];

console.log('layer ' + layer + (Object.keys(overrides).length ? '   overrides: ' + JSON.stringify(overrides) : ''));
console.log('view          segs   pairs   x-run   doubled(px)   doubled(mm)   max sep(µm)');
let worst = null;
for (const [name, th, ph, pole] of VIEWS){
  if (th !== null){
    app.setProjMode('ortho');
    app.orbit.theta = th; app.orbit.phi = ph; app.orbit.exactPole = pole;
    app.orbit.apply();
  }
  const m = app.generate(overrides);
  const mmPerPx = app.computePaperLayout({ w: m.w, h: m.h }).scale;
  const pairs = findDoubleInk(m.groups[layer], m.runIds[layer]);
  let len = 0, maxSep = 0;
  for (const p of pairs){ len += p.overlap; maxSep = Math.max(maxSep, p.sep); }
  const xrun = pairs.filter(p => !p.sameRun).length;
  console.log(name.padEnd(13) + String(m.groups[layer].length/4).padStart(5) +
    String(pairs.length).padStart(8) + String(xrun).padStart(8) +
    len.toFixed(1).padStart(14) + (len*mmPerPx).toFixed(2).padStart(14) +
    (maxSep*mmPerPx*1000).toFixed(1).padStart(14));
  if (!worst || len > worst.len) worst = { name, len, pairs, mmPerPx };
}
if (worst && worst.pairs.length){
  console.log('\nworst view (' + worst.name + ') — largest doubled stretches:');
  for (const p of worst.pairs.sort((a,b) => b.overlap - a.overlap).slice(0, 10))
    console.log('   ' + p.overlap.toFixed(2).padStart(7) + 'px (' + (p.overlap*worst.mmPerPx).toFixed(2).padStart(6) + 'mm)' +
      '  sep ' + (p.sep*worst.mmPerPx*1000).toFixed(1).padStart(5) + 'µm' +
      '  runs ' + p.runA + (p.sameRun ? ' == ' : ' / ') + p.runB +
      '  at (' + p.mid[0].toFixed(1) + ',' + p.mid[1].toFixed(1) + ')');
}

}
