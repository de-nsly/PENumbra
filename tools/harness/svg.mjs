/* ================================================================
   tools/harness/svg.mjs — the main thread's half of the pipeline
   renderResult() (js/render-result.js) turns the worker's flat per-layer
   segment arrays into the actual <path> data that gets exported. For
   Contour (sv/sh) that is chainByRun -> mergeContourRunSplits ->
   splitSelfTouching -> simplifyCollinear; Silhouette (so/iv/ih) and
   Crease (cv/ch) each have their own chain path. All of those are pure
   geometry functions imported straight from the real module — if the
   app's chaining changes, the harness changes with it.

   Two emit modes:
     'chained' — what the app actually exports (post-chaining).
     'raw'     — one <path> subpath per worker segment, nothing joined.
                 Use this to tell "the worker never emitted it" apart
                 from "the chaining lost it".
   ================================================================ */
import './app-env.mjs';   // first: the app modules need its globals at import time
import {
  chainByRun, mergeContourRunSplits, splitSelfTouching, simplifyCollinear,
  chainSegments, mergeAdjacentTouching, mergeCreaseScreenSpace, buildChainedPathD,
  SIMPLIFY_COLLINEAR_TOL, SIMPLIFY_FOLDBACK_TOL, trimTipFoldback,
  trimContourFoldbacks, dropRedundantContourSlivers,
  appendContourPathD, appendCreasePathD,
} from '../../js/chain.js';
export {
  chainByRun, mergeContourRunSplits, splitSelfTouching, simplifyCollinear,
  chainSegments, mergeAdjacentTouching, mergeCreaseScreenSpace, buildChainedPathD,
  SIMPLIFY_COLLINEAR_TOL, SIMPLIFY_FOLDBACK_TOL, trimTipFoldback,
  trimContourFoldbacks, dropRedundantContourSlivers,
  appendContourPathD, appendCreasePathD,
};

const CHAIN_LAYERS = { so:1, iv:1, ih:1 };
const SEQ_CHAIN_LAYERS = { cv:1, ch:1 };

/* The per-layer branch of renderResult's LAYERS loop, for one layer key —
   calling the same per-layer builders renderResult calls. Returns the layer's
   `d` string in solver-px units, exactly as the app would put it on the
   <path>. */
export function layerPathD(m, key, { mmToPx = 1, mode = 'chained' } = {}){
  const segs = m.groups[key];
  if (!segs || !segs.length) return '';
  const d = [];
  if (mode === 'raw'){
    for (let i=0;i<segs.length;i+=4)
      d.push('M', segs[i].toFixed(2), segs[i+1].toFixed(2), 'L', segs[i+2].toFixed(2), segs[i+3].toFixed(2));
    return d.join(' ');
  }
  if (key === 'sv' || key === 'sh'){
    appendContourPathD(d, segs, m.runIds[key], m.seqs[key], m.counts && m.counts.contourAdjacency, null);
  } else if (CHAIN_LAYERS[key]){
    d.push(buildChainedPathD(segs, null, { tolMerge: 0.25 * mmToPx, foldbackAngleThreshDeg: 150 }));
  } else if (SEQ_CHAIN_LAYERS[key]){
    appendCreasePathD(d, segs, null);
  } else {
    for (let i=0;i<segs.length;i+=4){
      d.push('M', segs[i].toFixed(2), segs[i+1].toFixed(2), 'L', segs[i+2].toFixed(2), segs[i+3].toFixed(2));
    }
  }
  return d.join(' ');
}

/* Flattens a `d` string back into a flat [x0,y0,x1,y1,…] segment list.
   Use this, not m.groups[key], whenever you want to LOOK at what the app
   actually exports: the worker's raw segments and the emitted path differ by
   the whole chaining/merge/simplify tail, which is exactly where ink can go
   missing. */
export function pathDToSegs(d){
  const t = d.trim().split(/[\s,]+/);
  const out = [];
  let c = null, s = null;
  for (let i = 0; i < t.length;){
    if (t[i] === 'M'){ c = [+t[i+1], +t[i+2]]; s = c; i += 3; }
    else if (t[i] === 'L'){ const p = [+t[i+1], +t[i+2]]; out.push(c[0], c[1], p[0], p[1]); c = p; i += 3; }
    else if (t[i] === 'Z' || t[i] === 'z'){ out.push(c[0], c[1], s[0], s[1]); c = s; i += 1; }
    else i += 1;
  }
  return out;
}

/* A paper-space SVG of the given layers, laid out through the app's own
   computePaperLayout — the same page a real export produces, so the output
   overlays 1:1 on anything exported from the browser.
   `layers`: [{ key, color, width, dash }]. */
export function buildPaperSvg(m, layers, layout, extra = []){
  const mmToPx = 1/Math.max(1e-6, layout.scale);
  const parts = [];
  for (const L of layers.slice().reverse()){         // same reverse paint order as renderResult
    const d = layerPathD(m, L.key, { mmToPx, mode: L.mode });
    if (!d) continue;
    parts.push('<path data-layer="' + L.key + '" d="' + d + '" fill="none" stroke="' +
      (L.color || '#000') + '" stroke-width="' + ((L.width || 0.3) * mmToPx).toFixed(4) +
      '" stroke-linecap="round" stroke-linejoin="round"' +
      (L.opacity != null ? ' stroke-opacity="' + L.opacity + '"' : '') + '/>');
  }
  for (const e of extra) parts.push(e);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + layout.paperW.toFixed(2) + 'mm" height="' +
    layout.paperH.toFixed(2) + 'mm" viewBox="0 0 ' + layout.paperW.toFixed(3) + ' ' + layout.paperH.toFixed(3) + '">' +
    '<rect width="100%" height="100%" fill="#fbf9f3"/>' +
    '<g transform="translate(' + layout.offX.toFixed(3) + ',' + layout.offY.toFixed(3) +
    ') scale(' + layout.scale.toFixed(6) + ')">' + parts.join('') + '</g></svg>';
}
