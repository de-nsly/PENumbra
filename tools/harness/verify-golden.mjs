#!/usr/bin/env node
/* ================================================================
   tools/harness/verify-golden.mjs — "did this change alter any output?"
   Re-runs every golden capture and compares against tools/harness/golden:
     · sweep.mjs fingerprints for the demo mesh and pen_files/arches.pen
       (28 views x 7 line layers each), diffed with sweep.mjs --diff
     · one all-layers combined SVG per scene (line layers + h1/h2/h3),
       compared by SHA-256 against combined-sha256.txt
   Exit code 0 only when nothing moved. The .pen scenes themselves are not
   in the repo (pen_files/ is local); a missing scene is reported and
   skipped rather than failing the run.

     node tools/harness/verify-golden.mjs

   To re-capture after an INTENDED output change:
     node tools/harness/sweep.mjs demo --out tools/harness/golden/demo.json
     node tools/harness/sweep.mjs pen_files/arches.pen --out tools/harness/golden/arches.json
     node tools/harness/verify-golden.mjs --recapture-hashes
   ================================================================ */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const GOLDEN = path.join(HERE, 'golden');
const ALL_LAYERS = 'so,iv,ih,sv,sh,cv,ch,h1,h2,h3';
const SCENES = [
  { name: 'demo',   arg: 'demo' },
  { name: 'arches', arg: 'pen_files/arches.pen' },
];
const recapture = process.argv.includes('--recapture-hashes');

const node = (script, args) =>
  execFileSync(process.execPath, [path.join(HERE, script), ...args], { cwd: REPO, encoding: 'utf8' });
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

const tmp = mkdtempSync(path.join(tmpdir(), 'penumbra-golden-'));
let failed = false;
const hashLines = [];

for (const scene of SCENES){
  if (scene.arg !== 'demo' && !existsSync(path.join(REPO, scene.arg))){
    console.log(`[${scene.name}] ${scene.arg} not present locally — skipped`);
    continue;
  }
  // 1 · sweep fingerprint
  const after = path.join(tmp, scene.name + '.json');
  node('sweep.mjs', [scene.arg, '--out', after]);
  const diff = node('sweep.mjs', ['--diff', path.join(GOLDEN, scene.name + '.json'), after]);
  const changed = /changed\s*:\s*(\d+)/.exec(diff);
  const nChanged = changed ? +changed[1] : NaN;
  const lost = /coverage lost/.test(diff) && !/no per-layer coverage lost anywhere/.test(diff);
  if (nChanged !== 0 || lost){ failed = true; console.log(`[${scene.name}] sweep: CHANGED\n` + diff); }
  else console.log(`[${scene.name}] sweep: identical (${/identical:\s*(\d+)/.exec(diff)[1]} pairs)`);

  // 2 · combined all-layers SVG hash
  const outDir = path.join(tmp, scene.name + '-svg');
  node('run.mjs', [scene.arg, '--combined', '--on', ALL_LAYERS, '--layers', ALL_LAYERS, '--out', outDir]);
  const svg = readdirSync(outDir).find(f => f.endsWith('.svg'));
  const hash = sha256(path.join(outDir, svg));
  hashLines.push(`${hash} *${svg}`);
  const expected = existsSync(path.join(GOLDEN, 'combined-sha256.txt'))
    ? readFileSync(path.join(GOLDEN, 'combined-sha256.txt'), 'utf8').split('\n')
        .map(l => l.trim().split(/\s+\*?/)).find(([, f]) => f === svg)
    : null;
  if (recapture) continue;
  if (!expected){ failed = true; console.log(`[${scene.name}] combined svg: no golden hash for ${svg}`); }
  else if (expected[0] !== hash){ failed = true; console.log(`[${scene.name}] combined svg: HASH CHANGED (${svg})`); }
  else console.log(`[${scene.name}] combined svg: identical`);
}

if (recapture){
  writeFileSync(path.join(GOLDEN, 'combined-sha256.txt'), hashLines.join('\n') + '\n');
  console.log('re-captured combined-sha256.txt');
}
console.log(failed ? '\nRESULT: OUTPUT CHANGED' : '\nRESULT: all golden outputs identical');
process.exit(failed ? 1 : 0);
