#!/usr/bin/env node
/* ================================================================
   tools/harness/run.mjs — CLI for the headless harness
   Loads a .pen scene exactly as the browser app would, runs the real
   HLR worker, and writes per-layer SVGs on the scene's own paper.

     node tools/harness/run.mjs pen_files/pipe_X_aligned.pen
     node tools/harness/run.mjs scene.pen --layers sv,sh,so --out dir/
     node tools/harness/run.mjs scene.pen --raw          # no chaining
     node tools/harness/run.mjs scene.pen --vp 798x947   # viewport size
     node tools/harness/run.mjs scene.pen --json         # counts only

   --layers defaults to whatever the .pen file had switched on.
   ================================================================ */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { openScene, DEFAULT_VIEWPORT } from './app.mjs';
import { buildPaperSvg } from './svg.mjs';

function parseArgs(argv){
  const out = { pen: null, layers: null, outDir: '.', raw: false, json: false, viewport: null,
                combined: false, on: [], off: [] };
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (a === '--layers') out.layers = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--out') out.outDir = argv[++i];
    else if (a === '--raw') out.raw = true;
    else if (a === '--json') out.json = true;
    else if (a === '--combined') out.combined = true;
    else if (a === '--on')  out.on  = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--off') out.off = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--vp'){
      const [w, h] = argv[++i].split('x').map(Number);
      out.viewport = { w, h };
    }
    else if (!out.pen) out.pen = a;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.pen){
  console.error('usage: node tools/harness/run.mjs <scene.pen> [--layers sv,sh] [--out dir] [--raw] [--json] [--vp WxH]');
  process.exit(1);
}

const vp = args.viewport || DEFAULT_VIEWPORT;
const app = await openScene(args.pen, { viewport: vp });
// --on/--off tick pen checkboxes before the (single) solve, so the
// cross-layer ink-avoidance cascade sees exactly the requested set
for (const k of args.on  || []) app.setLayer(k, true);
for (const k of args.off || []) app.setLayer(k, false);
const t0 = Date.now();
const m = app.generate();
const wallMs = Date.now() - t0;

const layout = app.computePaperLayout({ w: m.w, h: m.h });
const keys = args.layers || Object.keys(app.layers).filter(k => app.layers[k].on);

console.log('scene    : ' + path.basename(args.pen) + '  (' + app.modelName + ')');
console.log('mesh     : ' + app.loaded.stats.tris + ' tris, ' + app.loaded.stats.verts +
            ' welded verts, ' + app.loaded.stats.shells + ' shells');
console.log('viewport : ' + vp.w + 'x' + vp.h + '  camera: ' +
            (app.scene.camera.ortho ? 'ortho' : 'persp') +
            '  theta=' + app.scene.camera.theta.toFixed(6) + ' phi=' + app.scene.camera.phi.toFixed(6));
console.log('paper    : ' + layout.paperW + 'x' + layout.paperH + 'mm  scale=' + layout.scale.toFixed(6) +
            '  off=(' + layout.offX.toFixed(3) + ',' + layout.offY.toFixed(3) + ')');
console.log('solve    : ' + m.ms + 'ms (wall ' + wallMs + 'ms)');
console.log('segments : ' + Object.keys(m.groups).map(k => k + '=' + (m.groups[k].length/4)).join(' '));
for (const e of app.errors) console.log('warning  : ' + e);

if (args.json){
  console.log(JSON.stringify({ counts: m.counts, w: m.w, h: m.h }, null, 1));
} else {
  mkdirSync(args.outDir, { recursive: true });
  const base = path.basename(args.pen).replace(/\.pen$/i, '');
  const mode = args.raw ? 'raw' : 'chained';
  const written = [];
  const styleFor = k => ({ key: k, mode,
    color: (app.layers[k] && app.layers[k].color) || '#000000',
    width: (app.layers[k] && app.layers[k].width) || 0.35 });
  if (args.combined){
    const f = path.join(args.outDir, base + '-' + keys.join('+') + (args.raw ? '-raw' : '') + '.svg');
    writeFileSync(f, buildPaperSvg(m, keys.map(styleFor), layout));
    written.push(f);
  } else {
    for (const k of keys){
      const f = path.join(args.outDir, base + '-' + k + (args.raw ? '-raw' : '') + '.svg');
      writeFileSync(f, buildPaperSvg(m, [styleFor(k)], layout));
      written.push(f);
    }
  }
  console.log('wrote    : ' + written.join('\n           '));
}
