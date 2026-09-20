/* ================================================================
   render-result.js — the worker's result becomes the on-screen SVG
   renderResult() is what the app does with a finished solve: it rebuilds
   #plot from scratch, one <g id="g_<layerId>"> per layer in REVERSE
   layer order (so the highest-priority layer paints last, on top),
   each holding one <path>. Which builder turns a layer's flat segments
   into that path is its type's `chain` (LAYER_TYPES in layers.js):
   contour, silhouette and crease go through chain.js, a fill layer's
   pieces through its texture stack (hatch-texture.js). Paper transform,
   pen styling and the pan/zoom fit are then re-applied by renderPaper()
   and applyLayerStyle().
   refreshStatusR() is the bottom-right stats readout for whichever tab
   is showing geometry — the live counts cached here by renderResult, or
   computeLayoutStats() for the Layout tab.
   ================================================================ */
import { $, dashOnFraction, svgEl } from './main.js';
import { layerById, layerType, layers } from './layers.js';
import { appendContourPathD, appendCreasePathD, buildChainedPathD } from './chain.js';
import { appendTexturedPolylinesD, applyTextureStack, arcToBezierSegments, hatchFamilyAngleDeg } from './hatch-texture.js';
import { activeTab, generateFinished } from './panel-controls.js';
import { computeLayoutStats } from './layout/layout-model.js';
import { resetPaperViewFit } from './paper-preview.js';
import { exportSoIvOverlayNow, takePendingSoIvExport } from './scene-io.js';
import { blendMultiplyOn, computePaperLayout, pxPerMm, renderPaper } from './paper-layout.js';
import { applyLayerStyle, layerStyle } from './layer-rows.js';
export function renderResult(m){
  generateFinished(m);
  if (takePendingSoIvExport()) exportSoIvOverlayNow();

  const svg = $('plot');
  const firstEverGen = !svg.dataset.rendered;
  svg.dataset.rendered = '1';
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // path data stays in solver-pixel units; a single wrapper <g> maps that
  // whole drawing onto the paper (translate + scale), so paper size/orientation/
  // margin changes are pure re-layout — no path data is ever touched or rebuilt.
  const content = svgEl('g');
  content.id = 'paperContent';
  content.classList.toggle('blendMultiply', blendMultiplyOn);
  svg.appendChild(content);

  // Silhouette and Silhouette individual (so/iv/ih) segments already trace
  // connected curves geometrically — they're just emitted as independent 2-point
  // pieces. Chain touching pieces into maximal polylines (open where a curve is
  // genuinely broken by occlusion, closed where it loops back on itself) so the
  // SVG holds one continuous pen stroke per curve instead of many.
  // Crease/hidden-crease get a TWO-STAGE version of the same idea, since —
  // unlike silhouette/outline — crease networks have genuine branching
  // junctions: first mergeAdjacentTouching (conservative, LOCAL, trusts the
  // worker's world-space topology ordering), then mergeCreaseScreenSpace
  // (a screen-space fallback that mops up whatever the first pass couldn't
  // place, e.g. the extra arms pairJunctionArms left unpaired at a 3+-way
  // junction, which arrive as separate chains meeting at one point). See each
  // function's own comment for why neither one alone is safe/sufficient on
  // its own. Hatch is untouched — it already has its own, different
  // optimization (straight-line runs reduced to 2 points per carrier).
  // Contour (sv/sh) chains by the worker's run identity instead — see
  // appendContourPathD. Which treatment an edge layer gets is its type's
  // `chain` (LAYER_TYPES in layers.js).

  // Tracks the FINAL, post-processing picture — one entry per actual pen
  // stroke (subpath) in the rendered SVG, not per raw 2-point input
  // segment. `pts` passed to accumulatePathStats never repeats the closing
  // point for a closed path (matching the convention splitSelfTouching/
  // mergeAdjacentTouching already use elsewhere in this file) — the closing
  // segment's length is added separately here instead.
  const pathStats = { paths: 0, closedPaths: 0, segments: 0, lenPx: 0 };
  // Per-layer RAW (dash-independent) length, so the dash "ink fraction"
  // (see dashOnFraction in main.js) can be reapplied later using whatever
  // dash is selected AT READ TIME, not whatever it was at solve time —
  // otherwise the cached lastLiveStats mm figure would go stale the moment
  // the user changes a dash setting without re-generating. See refreshStatusR.
  const rawLenByLayer = {};
  // Paint order is the REVERSE of the hierarchy in layers: the highest-
  // priority layer (Silhouette, first) must end up LAST in the SVG so it
  // paints on top, and the lowest (Circles, last) paints first/underneath
  // everything else.
  for (const L of layers.slice().reverse()){
    const lenBefore = pathStats.lenPx;
    const T = layerType(L);
    if (L.type === 'circles'){
      const pieces = m.circlePatternSegs && m.circlePatternSegs[L.id];
      if (!L.on || !pieces || !pieces.length) continue;
      const tex = applyTextureStack({ rep: 'arcs', pieces }, L.texture,
        { geometry: T.geometry, mmToPx: pxPerMm() });
      const d = [];
      if (tex.rep === 'polylines'){
        // Wobbled: no longer circles — emitted as dense polylines.
        appendTexturedPolylinesD(d, tex.polylines, pathStats);
      } else {
        // Every piece is still a genuine circular arc all the way through,
        // so it can be emitted as a handful of Bezier curves instead of a
        // dense polyline.
        for (const piece of tex.pieces){
          const segs = arcToBezierSegments(piece.cx, piece.cy, piece.radius, piece.u0, piece.u1);
          if (!segs.length) continue;
          const sweep = Math.abs(piece.u1 - piece.u0) * 2 * Math.PI;   // u is a fraction of a full turn, not radians
          pathStats.paths++;
          if (Math.abs(sweep - 2*Math.PI) < 1e-4) pathStats.closedPaths++;
          pathStats.segments += segs.length;   // one per emitted C token, matching computeDStats
          pathStats.lenPx += piece.radius * sweep;
          d.push('M', segs[0].p0[0].toFixed(2), segs[0].p0[1].toFixed(2));
          for (const seg of segs){
            d.push('C', seg.c1[0].toFixed(2), seg.c1[1].toFixed(2),
                        seg.c2[0].toFixed(2), seg.c2[1].toFixed(2),
                        seg.p3[0].toFixed(2), seg.p3[1].toFixed(2));
          }
        }
      }
      const g = svgEl('g');
      g.id = 'g_' + L.id;
      g.setAttribute('fill', 'none');
      g.setAttribute('stroke-linecap', 'round');
      g.setAttribute('stroke-linejoin', 'round');
      const p = svgEl('path');
      p.setAttribute('d', d.join(' '));
      g.appendChild(p);
      content.appendChild(g);
      rawLenByLayer[L.id] = pathStats.lenPx - lenBefore;
      continue;
    }
    const segs = m.groups[L.id];
    if (!segs || !segs.length) continue;
    // The 'd' string/DOM group is always built regardless of this layer's
    // on/off checkbox (display:none just hides it visually — see
    // applyLayerStyle — and freezeCurrentGeneration relies on the geometry
    // still being there so a layer switched off before "Add to Layout" can
    // be re-enabled per-block later). Stats, though, should only count what's
    // actually visible right now — matching computeLayoutStats, which only
    // sums a block's layers that are currently layerVisible — so an off
    // layer's contribution is deliberately excluded from pathStats below.
    const layerOn = L.on;
    const g = svgEl('g');
    g.id = 'g_' + L.id;
    g.setAttribute('fill', 'none');
    g.setAttribute('stroke-linecap', 'round');
    g.setAttribute('stroke-linejoin', 'round');
    const d = [];
    const stats = layerOn ? pathStats : null;
    if (T.chain === 'contour'){
      appendContourPathD(d, segs, m.runIds[L.id], m.seqs[L.id],
        m.counts && m.counts.contourAdjacency, stats);
    } else if (T.chain === 'silhouette'){
      const mmToPx = pxPerMm();
      // Silhouette and Individual Silhouette get identical treatment here —
      // no exceptions, every gap gets closed.
      const silMergeOpts = { tolMerge: 0.25 * mmToPx, foldbackAngleThreshDeg: 150 };
      d.push(buildChainedPathD(segs, stats, silMergeOpts));
    } else if (T.chain === 'crease'){
      appendCreasePathD(d, segs, stats);
    } else {
      // Hatch: one path per layer, one subpath per segment: subpaths stay
      // separate pen strokes for plotter software; nothing is joined or
      // reordered. The layer's texture stack is applied here; what comes
      // back is always polylines (a segment no filter touched is its own
      // 2-point polyline).
      const tex = applyTextureStack(
        { rep: 'segments', segs, carrier: (m.hatchCarrier && m.hatchCarrier[L.id]) || null }, L.texture,
        { geometry: T.geometry, mmToPx: pxPerMm(), familyAngleDeg: hatchFamilyAngleDeg(L) });
      appendTexturedPolylinesD(d, tex.polylines, stats);
    }
    const p = svgEl('path');
    p.setAttribute('d', d.join(' '));
    g.appendChild(p);
    content.appendChild(g);
    applyLayerStyle(L.id);
    rawLenByLayer[L.id] = pathStats.lenPx - lenBefore;
  }
  if (firstEverGen) resetPaperViewFit();   // first drawing ever shown: fit the whole page, rulers included
  renderPaper();                        // regenerating an existing view keeps the user's pan/zoom
  lastLiveStats = {
    segments: pathStats.segments, paths: pathStats.paths, closedPaths: pathStats.closedPaths,
    rawLenByLayer, ms: m.ms,
    hatchCapped: m.counts.hatchCapped, shadowCapped: m.counts.shadowCapped,
  };
  refreshStatusR();
}
// Bottom-right stats readout — reflects whichever tab is actually showing
// geometry right now (live preview vs. Layout), not just whatever last
// finished solving. Live-preview segment/path counts and per-layer RAW
// (dash-independent, PAPER-SCALE-independent) lengths are cached in
// lastLiveStats by renderResult (only recomputed on an actual solve); the mm
// figure re-applies each layer's CURRENT dash setting AND the CURRENT
// paper layout scale to that raw length every call. Paper size/orientation/
// margin changes retransform the on-screen drawing immediately (see
// renderPaper(), called straight from the ['paperSize',...] input handler)
// but only mark the solve stale rather than re-running it synchronously —
// caching layout.scale at solve time would leave the readout showing the
// PREVIOUS paper scale even once the visible drawing (and a freshly-frozen
// Layout block, which reads paper layout fresh at freeze time) has already
// moved to the new one. Layout numbers are recomputed fresh every call via
// computeLayoutStats since block/layer visibility (and dash) can change at
// any time without a solve. Call this any time the active tab, the set of
// visible blocks/layers, any dash setting, or the paper layout changes.
let lastLiveStats = null;
export function refreshStatusR(){
  if (activeTab === 'layout'){
    const s = computeLayoutStats();
    $('statusR').textContent = s.segments.toLocaleString() + ' segments · ' +
      s.paths.toLocaleString() + ' paths (' + s.closedPaths.toLocaleString() + ' closed) · ' +
      s.lenMm.toLocaleString(undefined, {maximumFractionDigits:0}) + ' mm';
  } else if (lastLiveStats){
    const s = lastLiveStats;
    const layout = computePaperLayout();
    const scaleNow = layout ? layout.scale : 1;
    let lenMm = 0;
    for (const key in s.rawLenByLayer){
      if (!layerById(key)) continue;   // a scene import since that solve removed this layer
      lenMm += s.rawLenByLayer[key] * dashOnFraction(layerStyle(key).dash) * scaleNow;
    }
    $('statusR').textContent = s.segments.toLocaleString() + ' segments · ' +
      s.paths.toLocaleString() + ' paths (' + s.closedPaths.toLocaleString() + ' closed) · ' +
      lenMm.toLocaleString(undefined, {maximumFractionDigits:0}) + ' mm · ' + s.ms + ' ms' +
      (s.hatchCapped ? ' · hatch capped' : '') + (s.shadowCapped ? ' · shadow budget hit (partial)' : '');
  }
}
