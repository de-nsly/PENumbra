/* ================================================================
   svg-export.js — turning solved geometry into SVG
   Layer pen/dash styling (colour + width come from the layer's pen,
   see PEN_LIBRARY in main.js), paper layout math shared by the
   preview and the real export, renderPaper() (builds the on-screen
   SVG from the worker's result), the segment post-processing used
   by onResult (chaining/merging/splitting), and the final
   export-to-.svg-file handler.
   The tail of this file also holds the two export-time geometry
   passes — dash splitting and "Trim SVG export to margins" — built on
   a shared segment path model (parsePathD/emitPathD/segSub) that
   treats the Circles layer's cubic arcs as curves throughout and never
   flattens them to polylines. Export SVG has two modes, picked by the
   Pen library tab's "Export one path per pen": off, a cleaned-up CLONE of
   the on-screen SVG (one group per layer); on, buildPenPathsExport, a
   freshly built file with one <path> per pen baked into page mm. Both
   passes run on export data only in either mode: the
   live document always keeps its full geometry, and the trim is merely
   SIMULATED on screen by a page-coloured mask over the band outside
   the margins (buildTrimMaskGroup/syncPreviewTrimMask here, with
   syncLayoutTrimMask in layout-canvas.js as its Layout-tab twin).
   If a line ends up in the wrong place on the page, the chaining and
   merge passes below (chainSegments, mergeSilhouetteClose,
   mergeContourRunSplits, mergeAdjacentTouching, mergeCreaseScreenSpace,
   splitSelfTouching, simplifyCollinear) are the main-thread suspects;
   worldOnFace()/intersectSegs()/subtractCovered are the worker's.
   ================================================================ */
import { $, DASH_KEYS, DASH_RATIOS, MAX_DASH_SLOTS, PEN_LIBRARY, SVG_NS, dashOnFraction, dashPattern, downloadFile, penById, scaledDash, svgEl } from './main.js';
import { FILL_TYPES, LAYER_TYPES, copyLayer, filterSupports, layerById, layerName, layerType, layers, newFillLayer, nextFillId, replaceLayers, stackEntry } from './layers.js';
import { formatValue } from './settings.js';
import { activeTab, gatherSettings, generateFinished, lastGen, makeSliderValueEditable, markStale, syncLineLayerUI, updateGroundPatternSliderRange } from './panel-controls.js';
import { renderTextureStack } from './texture-stack.js';
import { blockLayerPenId, blocks, computeLayoutPaperDims, computeLayoutStats, createBlockDom, gridGuidePositions, layoutOverlayOn, refreshAllBlockStyles, renderPreviewLayoutOverlay, syncLayoutPaperFrame, syncLayoutTrimMask, updateBlockStyle } from './layout-canvas.js';
import { applyPv, resetPv, resetPvFitWithRulers, updateTextureGizmo } from './paper-preview.js';
import { exportSoIvOverlayNow, takePendingSoIvExport } from './scene-io.js';
import { modelName } from './viewport3d.js';

// Pen widths are mm values entered to plotter-nib precision (0.15, 0.25,
// 0.35mm etc.) — display up to 2 decimals, trimming trailing zeros rather
// than padding to a fixed width, so 1 shows as "1", 1.1 as "1.1", and 1.05
// as "1.05". Nothing in the native <input type=number> widget guarantees
// this on its own (its own internal step/display arithmetic can otherwise
// show a value rounded to fewer decimals than were actually typed or
// stepped to), so this is applied explicitly after every edit.
export function fmtWidth(n){ return (Math.round(n*100)/100).toString(); }
// Shared by every per-layer dash <select> (built below) AND by addDashSlot
// further down, which appends a fresh <option> to each already-built one
// when a new slot is created — 'solid' is always first and isn't part of
// DASH_KEYS itself (see its own comment in main.js).
export function dashOptionsHtml(){
  return '<option value="solid">—</option>' + DASH_KEYS.map(k => '<option value="' + k + '">' + k + '</option>').join('');
}
// The pen counterpart of dashOptionsHtml, but (re)fills an existing <select>
// in place rather than returning markup: pen names are user-typed, so they
// go in via textContent, never through innerHTML. Every pen dropdown (layer
// rows here, the Layout Override menu) carries the .penSelect class, which
// is how pen-library.js finds them all again after an add/rename/delete.
// Keeps the select's current pen when it still exists, else lands on
// `fallbackId` (if that exists) or the first pen.
export function fillPenSelect(select, fallbackId){
  const prev = select.value;
  select.replaceChildren(...PEN_LIBRARY.map(p => {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.name;
    return opt;
  }));
  const has = id => PEN_LIBRARY.some(p => p.id === id);
  select.value = has(prev) ? prev : has(fallbackId) ? fallbackId : PEN_LIBRARY[0].id;
}
// The layer rows' DOM, keyed by layer id: { chk, pen, dash, sw }. A VIEW of
// the instances in layers.js — the instance is the state; a row's own
// listeners write into it (see buildLayerRows) and applyLayerStyle pushes
// the instance back into the row.
export const layerEls = {};

/* ================= Dash section (Pen library tab) =================
   D1/D2 are user-editable 6-value patterns (dash,gap,dash,gap,dash,gap),
   each value an absolute length in mm, independent of pen width — see
   DASH_RATIOS/scaledDash/dashPattern in main.js. Editing a field here
   refreshes every layer currently on this pattern (any layer could be
   using it, not just one), the same reason a paper-size change already
   re-runs applyLayerStyle for every layer elsewhere. */
const DASH_FIELD_LABELS = ['dash','gap','dash','gap','dash','gap'];
export function refreshDashPreview(key){
  const line = $('dashPreview' + key).querySelector('line');
  const pattern = dashPattern(key);
  const PREVIEW_PX_PER_UNIT = 6;    // arbitrary — this preview isn't tied to any real layer's width
  if (pattern) line.setAttribute('stroke-dasharray', pattern.map(v => v*PREVIEW_PX_PER_UNIT).join(' '));
  else line.removeAttribute('stroke-dasharray');
}
function buildDashFields(key){
  const container = $('dashFields' + key);
  container.innerHTML = DASH_FIELD_LABELS.map((lbl, i) =>
    '<div class="dashField">' +
      '<input type="number" min="0" step="0.1" value="' + DASH_RATIOS[key][i] + '" ' +
        'id="dash' + key + '_' + i + '" aria-label="' + key + ' ' + lbl + ' ' + (Math.floor(i/2)+1) + '">' +
      '<span>' + lbl + '</span>' +
    '</div>'
  ).join('');
  [...container.children].forEach((field, i) => {
    const input = field.firstElementChild;
    input.addEventListener('input', () => {
      DASH_RATIOS[key][i] = Math.max(0, +input.value || 0);
      refreshDashPreview(key);
      for (const L of layers) applyLayerStyle(L.id);
      refreshStatusR();
    });
  });
  refreshDashPreview(key);
}
/* "+ Add dash style" — only ever grows DASH_KEYS (never removes), up to
   MAX_DASH_SLOTS. New slot starts at a plain, visibly non-solid default
   ([2,2,0,0,0,0]) purely so it's not all-zeros (which scaledDash would
   otherwise silently render as solid) until the user actually customizes
   it via the sliders buildDashFields just built. */
export function addDashSlot(){
  if (DASH_KEYS.length >= MAX_DASH_SLOTS) return;
  const newKey = 'D' + (DASH_KEYS.length + 1);
  DASH_RATIOS[newKey] = [2, 2, 0, 0, 0, 0];
  DASH_KEYS.push(newKey);

  const group = document.createElement('div');
  group.className = 'dashGroup';
  group.innerHTML =
    '<div class="dashGroupLabel"><span>Dash ' + DASH_KEYS.length + '</span>' +
      '<svg class="dashPreview" id="dashPreview' + newKey + '" viewBox="0 0 180 10" aria-hidden="true"><line x1="2" y1="5" x2="178" y2="5"/></svg>' +
    '</div>' +
    '<div class="dashFieldsRow" id="dashFields' + newKey + '"></div>';
  $('dashGroupsContainer').appendChild(group);
  buildDashFields(newKey);

  // every already-built per-layer dash <select> needs the new option too —
  // appending (rather than rebuilding) preserves each one's current value
  for (const L of layers){
    const opt = document.createElement('option');
    opt.value = newKey; opt.textContent = newKey;
    layerEls[L.id].dash.appendChild(opt);
  }
  if (DASH_KEYS.length >= MAX_DASH_SLOTS) $('addDashBtn').disabled = true;
}
// The layer instance's on/pen/dash with color/width resolved through its
// pen (see PEN_LIBRARY in main.js) — callers keep seeing the same flat
// shape they always did.
export function layerStyle(id){
  const L = layerById(id);
  const pen = penById(L.pen);
  return { on: L.on, color: pen.color, width: pen.width, dash: L.dash };
}
// Renders one layer's instance state: its row (checkbox, pen and dash
// dropdowns, swatch) and its group in the on-screen SVG.
export function applyLayerStyle(id){
  const s = layerStyle(id), el = layerEls[id], L = layerById(id);
  el.chk.checked = L.on;
  if (PEN_LIBRARY.some(p => p.id === L.pen)) el.pen.value = L.pen;
  el.dash.value = L.dash;
  const swWidth = Math.max(0.6, s.width);
  el.sw.setAttribute('stroke', s.color);
  el.sw.setAttribute('stroke-width', swWidth);
  el.sw.setAttribute('stroke-dasharray', scaledDash(s.dash, swWidth));
  const g = document.getElementById('g_' + id);
  if (g){
    g.setAttribute('stroke', s.color);
    // s.width is a true mm value (the pen's W[mm] — see PEN_LIBRARY).
    // Path coordinates are in solver-px and rely on the ancestor
    // #paperContent transform (translate + scale, where scale = mm per
    // solver-px for the CURRENT paper/margins/model fit) to land at the
    // right physical size — and stroke-width goes through that exact same
    // transform automatically, which is what we WANT: it's what makes the
    // stroke zoom and pan together with the page, same as before. The only
    // thing that needs correcting is what the width represents once that
    // scaling happens — pre-dividing by the current scale here means the
    // transform's multiplication lands back on exactly the mm value typed,
    // regardless of how much the model happens to be scaled to fit the
    // current paper. (Deliberately NOT vector-effect:non-scaling-stroke —
    // that cancels the transform entirely, which also kills the zoom/pan
    // scaling that's supposed to stay intact.)
    const k = pxPerMm();
    const gWidth = s.width * k;
    g.setAttribute('stroke-width', gWidth);
    // Dash/gap are true mm lengths (DASH_RATIOS), independent of pen width —
    // scale by the SAME mm->px factor as the width above, NOT by gWidth
    // itself, or a 10mm dash would come out as 10x-the-pen-width instead.
    const dash = scaledDash(s.dash, k);
    if (dash) g.setAttribute('stroke-dasharray', dash); else g.removeAttribute('stroke-dasharray');
    g.style.display = s.on ? '' : 'none';
  }
  // Blocks freeze geometry but read color/width/dash/on live (see
  // layout-canvas.js) — only worth the redraw while Layout is the tab
  // actually being looked at; switching TO Layout already does a full
  // render on its own.
  if (activeTab === 'layout') refreshAllBlockStyles();
  // The Preview tab's Layout overlay clones each block's current DOM rather
  // than referencing it live (see renderPreviewLayoutOverlay's own comment
  // for why), so a color/width/dash panel tweak needs an explicit rebuild
  // to show up in the overlay — it re-applies updateBlockStyle to each
  // block itself before re-cloning, so this alone is enough even though
  // refreshAllBlockStyles() above didn't run.
  if (layoutOverlayOn) renderPreviewLayoutOverlay();
}

/* ================= paper layout =================
   The preview pane represents the true selected paper sheet (size +
   orientation), not the raw solver viewport aspect ratio. The drawing is
   scaled to fit within the margins and centered on the page — this is the
   single source of truth shared by both the on-screen preview and export,
   so they can never drift apart. */
export const PAPERS = { A0:[1189,841], A1:[841,594], A2:[594,420], A3:[420,297], A4:[297,210], A5:[210,148], A6:[148,105] };
// Single source of truth for margins — always returns all four sides,
// regardless of whether Independent margins is on. When it's off, all four
// are just the one shared marginMm value; when it's on, each is read from
// its own input. Every consumer (computePaperLayout, computeLayoutPaperDims,
// both margin guides, the Layout snap-guide targets) uses this shape
// unconditionally rather than branching on the toggle itself, so none of
// them need to know or care which mode is active.
export function getMargins(){
  if ($('marginIndependent').checked){
    return {
      top: Math.max(0, +$('marginTopMm').value || 0),
      bottom: Math.max(0, +$('marginBottomMm').value || 0),
      left: Math.max(0, +$('marginLeftMm').value || 0),
      right: Math.max(0, +$('marginRightMm').value || 0),
    };
  }
  const m = Math.max(0, +$('marginMm').value || 0);
  return { top: m, bottom: m, left: m, right: m };
}
export function computePaperLayout(dims){
  const d = dims || lastGen;
  if (!d) return null;
  const [pl, ps] = PAPERS[$('paperSize').value];
  const o = $('orient').value;
  const landscape = o === 'landscape';
  const paperW = landscape ? pl : ps, paperH = landscape ? ps : pl;
  const margin = getMargins();
  const availW = Math.max(0.01, paperW - margin.left - margin.right), availH = Math.max(0.01, paperH - margin.top - margin.bottom);
  const scale = Math.min(availW / d.w, availH / d.h);
  const drawW = d.w * scale, drawH = d.h * scale;
  // Centered within the margin-inset AVAILABLE area, not the full page —
  // for symmetric margins these are the same point, but for independent
  // ones the drawing should sit centered in whatever space is actually
  // left between the (possibly unequal) margins, not centered on the page
  // while ignoring them.
  return { paperW, paperH, margin, scale,
    offX: margin.left + (availW-drawW)/2, offY: margin.top + (availH-drawH)/2, drawW, drawH };
}
// Local (solver-px) units per mm at the current paper layout — the factor
// mm-authored values (pen widths, dash lengths, texture lengths) are
// multiplied by to land in path-coordinate units. 1 before the first
// generate, when there is no layout yet.
export function pxPerMm(){
  const layout = computePaperLayout();
  return layout ? 1 / Math.max(1e-6, layout.scale) : 1;
}
// Base "fit to pane" size in CSS px, before the current zoom factor is applied.
// Explicit JS sizing rather than CSS aspect-ratio/flex-centering: those don't
// reliably "contain" a box against an arbitrary pane size across engines.
export function baseSheetSize(layout){
  const pane = $('paperPane');
  const availW = Math.max(20, pane.clientWidth - 20), availH = Math.max(20, pane.clientHeight - 20);
  const ratio = layout.paperW / layout.paperH;
  let w = availW, h = w / ratio;
  if (h > availH){ h = availH; w = h * ratio; }
  return { w, h };
}
export function renderPaper(){
  const layout = computePaperLayout();
  if (!layout) return;
  updateGroundPatternSliderRange();
  // viewBox is always the FULL page — zoom never crops it, it resizes the whole sheet instead
  $('plot').setAttribute('viewBox', '0 0 ' + layout.paperW.toFixed(3) + ' ' + layout.paperH.toFixed(3));
  const content = $('paperContent');
  if (content) content.setAttribute('transform',
    'translate(' + layout.offX + ',' + layout.offY + ') scale(' + layout.scale + ')');
  let guide = document.getElementById('marginGuide');
  if (!guide){
    guide = svgEl('rect');
    guide.id = 'marginGuide';
    guide.setAttribute('class', 'pvMarginGuide');
    $('plot').insertBefore(guide, $('plot').firstChild);
  }
  guide.setAttribute('x', layout.margin.left); guide.setAttribute('y', layout.margin.top);
  guide.setAttribute('width', Math.max(0, layout.paperW - layout.margin.left - layout.margin.right));
  guide.setAttribute('height', Math.max(0, layout.paperH - layout.margin.top - layout.margin.bottom));
  // Guide Grid — same visual reference lines as the Layout tab (see
  // gridGuidePositions in layout-canvas.js, the shared source of truth for
  // where a guide actually sits), but display-only here: Preview has no
  // interactive placement to snap, so this never feeds into any geometry
  // or export math, just drawn for eyeballing composition against the model.
  let gridGuides = document.getElementById('pvGridGuides');
  if (!gridGuides){
    gridGuides = svgEl('g');
    gridGuides.id = 'pvGridGuides';
    $('plot').insertBefore(gridGuides, $('plot').firstChild);
  }
  gridGuides.innerHTML = '';
  {
    const { xs, ys } = gridGuidePositions({ paperW: layout.paperW, paperH: layout.paperH, margin: layout.margin });
    for (const x of xs){
      const line = svgEl('line');
      line.setAttribute('class', 'pvGridGuide');
      line.setAttribute('x1', x); line.setAttribute('x2', x);
      line.setAttribute('y1', 0); line.setAttribute('y2', layout.paperH);
      gridGuides.appendChild(line);
    }
    for (const y of ys){
      const line = svgEl('line');
      line.setAttribute('class', 'pvGridGuide');
      line.setAttribute('y1', y); line.setAttribute('y2', y);
      line.setAttribute('x1', 0); line.setAttribute('x2', layout.paperW);
      gridGuides.appendChild(line);
    }
  }
  applyPv(layout);
  // Stroke width is anchored to a true mm value via layout.scale (see
  // applyLayerStyle) — when the layout itself changes (paper size,
  // orientation, margin), that scale changes too, so widths need
  // refreshing right away rather than looking wrong until the next
  // regenerate. Geometry positioning already updates immediately above
  // (the content transform); this keeps stroke width in step with it.
  for (const L of layers) applyLayerStyle(L.id);
  // Layout overlay — same "recreate on every renderPaper() call" pattern as
  // marginGuide/pvGridGuides above, since #plot's entire subtree (including
  // whatever this drew last time) gets wiped on every regenerate (see
  // onResult's while-loop).
  renderPreviewLayoutOverlay();
  syncPreviewTrimMask();   // must stay the LAST child of #plot — see its own comment
  return layout;
}

/* ================= "Trim SVG export to margins" preview mask =================
   The trim itself is an export-only step (trimCloneToMargins, further
   down) — nothing is ever clipped out of the live document, so geometry
   stays whole while generating and while arranging blocks in Layout. What
   this draws is the VISUAL equivalent of it, using exactly the mechanism
   the page border already uses: the drawing isn't cut, it's covered. The
   sheet's own background hides everything past the page edge; this frame
   hides everything past the margin, painted in the same page colour
   (--paper, via .trimMaskFrame) so the band reads as bare paper.
   Drawn LAST inside the SVG so it sits above every layer, including the
   Preview tab's Layout overlay — which is why renderPreviewLayoutOverlay()
   re-calls this after it appends itself, or the overlay would land on top
   of the mask and show the very geometry that's about to be clipped away.
   The margin guide is redrawn on top of the frame: the frame's inner edge
   IS the margin line, so the guide that already sits underneath the
   drawing would otherwise have half its stroke buried by the mask.
   ============================================================================ */
export function buildTrimMaskGroup(id, dims, guideClass){
  const x0 = dims.margin.left, y0 = dims.margin.top;
  const x1 = Math.max(x0, dims.paperW - dims.margin.right);
  const y1 = Math.max(y0, dims.paperH - dims.margin.bottom);
  const g = svgEl('g');
  g.id = id;
  g.setAttribute('class', 'trimMask');
  // Two rectangles in one path + fill-rule:evenodd — the page rect with the
  // margin rect punched out of it, i.e. a frame with a genuine hole rather
  // than four separate bars that could leave hairline seams at the corners.
  const frame = svgEl('path');
  frame.setAttribute('class', 'trimMaskFrame');
  frame.setAttribute('d',
    'M 0 0 H ' + dims.paperW + ' V ' + dims.paperH + ' H 0 Z ' +
    'M ' + x0 + ' ' + y0 + ' H ' + x1 + ' V ' + y1 + ' H ' + x0 + ' Z');
  g.appendChild(frame);
  const guide = svgEl('rect');
  guide.setAttribute('class', guideClass);
  guide.setAttribute('x', x0); guide.setAttribute('y', y0);
  guide.setAttribute('width', x1 - x0); guide.setAttribute('height', y1 - y0);
  g.appendChild(guide);
  return g;
}
export function syncPreviewTrimMask(){
  const plot = document.getElementById('plot');
  if (!plot) return;
  const old = document.getElementById('pvTrimMask');
  if (old) old.remove();
  if (!$('trimToMargins').checked) return;
  const layout = computePaperLayout();
  if (!layout) return;
  plot.appendChild(buildTrimMaskGroup('pvTrimMask', layout, 'pvMarginGuide'));
}
// Purely cosmetic (the --paper CSS custom property backs both #sheet and
// #layoutSheet's background, per .sheet in styles.css, so Preview and
// Layout always match with a single setting) — no geometry, scale, or
// hatch-spacing math depends on it, so unlike the layout controls above
// this never needs resetPv()/renderPaper()/markStale().
export function applyPageColor(){
  document.documentElement.style.setProperty('--paper', $('pageColor').value);
  updateGuideColor();
  updateSelColor();
}
// Picks whichever of a near-black/near-white guide tone has the higher WCAG
// contrast ratio against the current page color, so the margin/grid guides
// (in both Preview and Layout — both read the same --guide-color custom
// property, see .pvMarginGuide/.pvGridGuide/.layoutMarginGuide/
// .layoutGridGuide in styles.css) never wash out against a similarly-toned
// page, whatever color the user picks.
const GUIDE_DARK = '#4a4436', GUIDE_LIGHT = '#f5f0e4';
function hexToRgb(hex){
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c+c).join('');
  const n = parseInt(hex, 16);
  return [(n>>16)&255, (n>>8)&255, n&255];
}
function relLuminance([r, g, b]){
  const f = c => { c /= 255; return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
  return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b);
}
function contrastRatio(hexA, hexB){
  const lA = relLuminance(hexToRgb(hexA)) + 0.05, lB = relLuminance(hexToRgb(hexB)) + 0.05;
  return lA > lB ? lA/lB : lB/lA;
}
function updateGuideColor(){
  const bg = $('pageColor').value;
  const guideColor = contrastRatio(bg, GUIDE_DARK) >= contrastRatio(bg, GUIDE_LIGHT) ? GUIDE_DARK : GUIDE_LIGHT;
  document.documentElement.style.setProperty('--guide-color', guideColor);
}
// "redmean" perceptual RGB distance — deliberately NOT contrastRatio()
// above: WCAG contrast is luminance-only, so a bright page color (like the
// default off-white) already reads as "low contrast" against the bright
// accent cyan even though the two are nowhere near the same HUE and the
// accent is still perfectly visible on screen. What actually washes the
// selection dashes out is the page color genuinely approaching the accent
// color itself, which needs a real color-distance check, not a lightness one.
function colorDistance(hexA, hexB){
  const [r1,g1,b1] = hexToRgb(hexA), [r2,g2,b2] = hexToRgb(hexB);
  const rmean = (r1+r2)/2, dr = r1-r2, dg = g1-g2, db = b1-b2;
  return Math.sqrt((2 + rmean/256)*dr*dr + 4*dg*dg + (2 + (255-rmean)/256)*db*db);
}
// The Layout selection chrome (--sel-color, read by .layoutSelRect/
// .layoutSelRectMember/.layoutRotateConnector) normally just uses the plain
// accent color — it already reads fine against most page colors, so there's
// no need to pick between two tones the way the guides above do. Only when
// the page color actually drifts close to the accent color itself (the case
// that genuinely washes the dashes out) does this swap to the same dark ink
// already used for the handles' outline stroke, instead.
const ACCENT_HEX = '#58b8d6', ACCENT_INK_HEX = '#0c1a20';
const SEL_CLOSE_THRESHOLD = 140;   // redmean units out of a ~765 max — tuned so only genuinely near-accent hues trigger the swap
function updateSelColor(){
  const bg = $('pageColor').value;
  const selColor = colorDistance(bg, ACCENT_HEX) < SEL_CLOSE_THRESHOLD ? ACCENT_INK_HEX : ACCENT_HEX;
  document.documentElement.style.setProperty('--sel-color', selColor);
}
export function syncMarginMode(){
  const on = $('marginIndependent').checked;
  $('marginSingleRow').style.display = on ? 'none' : '';
  $('marginIndependentRows').style.display = on ? '' : 'none';
  resetPv(); renderPaper();
  markStale();
  syncLayoutPaperFrame();
}

/* ================= segment chaining =================
   Chains touching 2-point segments into maximal polylines. A segment's own
   endpoints already carry all the information needed — no extra data from
   the solver required. Open chains (a curve broken by real occlusion, or a
   boundary that's genuinely cut off) keep two distinct ends; closed chains
   (loop back to their own start) get flagged so the caller can emit an
   SVG "Z" instead of a duplicate closing point. */
export function chainSegments(segs){
  const key = (x,y) => Math.round(x*50) + '_' + Math.round(y*50);   // ~0.02px buckets
  const n = segs.length / 4;
  if (!n) return [];
  const P0 = i => [segs[i*4], segs[i*4+1]];
  const P1 = i => [segs[i*4+2], segs[i*4+3]];
  const TWO_PI = Math.PI * 2;
  // Each vertex's adjacency now also carries the outgoing angle of that
  // half-edge — needed to resolve junctions (3+ segment-ends sharing a
  // vertex) by a stable rule rather than by arrival order: take the next
  // half-edge in consistent rotational order from the reverse of the
  // direction just arrived on, rather than "first unused candidate" in
  // whatever order they happened to be pushed. (The worker resolves its own
  // junctions on a different signal — pairJunctionArms takes the straightest
  // continuation from world-space tangents, so its choice stays stable as the
  // camera orbits. This pass only ever sees screen coordinates, so rotational
  // order is the strongest signal available to it.) The naive first-match choice
  // at a junction can walk onto the wrong branch, stranding the actual
  // continuation to be discovered later as its own separate, disconnected
  // chain — confirmed directly against real output: two subpaths sharing
  // an EXACT shared vertex (zero distance) were still emitted as separate,
  // unconnected paths, which only a wrong turn at that vertex explains.
  const adj = new Map();
  const push = (k, rec) => { let a = adj.get(k); if (!a){ a=[]; adj.set(k,a); } a.push(rec); };
  for (let i=0; i<n; i++){
    const a=P0(i), b=P1(i);
    push(key(a[0],a[1]), { i, end:0, ang: Math.atan2(b[1]-a[1], b[0]-a[0]), toKey: key(b[0],b[1]) });
    push(key(b[0],b[1]), { i, end:1, ang: Math.atan2(a[1]-b[1], a[0]-b[0]), toKey: key(a[0],a[1]) });
  }
  const used = new Uint8Array(n);
  const findNext = (atKey, inAng) => {
    const arr = adj.get(atKey);
    if (!arr || !arr.length) return null;
    const rev = ((inAng + Math.PI) % TWO_PI + TWO_PI) % TWO_PI;
    let best=null, bestDiff=Infinity;
    for (const h of arr){
      if (used[h.i]) continue;
      const a = ((h.ang % TWO_PI) + TWO_PI) % TWO_PI;
      let diff = a - rev; if (diff <= 1e-9) diff += TWO_PI;
      if (diff < bestDiff){ bestDiff = diff; best = h; }
    }
    return best;
  };
  const chains = [];
  function walkFrom(segIdx, startEnd){
    used[segIdx] = 1;
    const a = P0(segIdx), b = P1(segIdx);
    const startPt = startEnd===0 ? a : b;
    const startKey = key(startPt[0], startPt[1]);
    const pts = [startPt, startEnd===0 ? b : a];
    let curAng = startEnd===0 ? Math.atan2(b[1]-a[1], b[0]-a[0]) : Math.atan2(a[1]-b[1], a[0]-b[0]);
    let curToKey = startEnd===0 ? key(b[0],b[1]) : key(a[0],a[1]);
    let closed = false;
    for (let guard=n+2; guard>0; guard--){
      if (curToKey === startKey && pts.length > 2){ closed = true; break; }
      const next = findNext(curToKey, curAng);
      if (!next) break;
      used[next.i] = 1;
      const nb = next.end===0 ? P1(next.i) : P0(next.i);
      pts.push(nb);
      curAng = next.ang; curToKey = next.toKey;
    }
    if (!closed && pts.length >= 3){
      // dead-ended a hair's width from start — see CHAIN_CLOSE_SNAP_TOL above
      const last = pts[pts.length-1], first = pts[0];
      const dx = last[0]-first[0], dy = last[1]-first[1];
      if (dx*dx+dy*dy <= CHAIN_CLOSE_SNAP_TOL*CHAIN_CLOSE_SNAP_TOL) closed = true;
    }
    if (closed) pts.pop();               // drop duplicate closing point — caller emits Z instead
    return { pts, closed };
  }
  // Pass 1: open chains start at a true endpoint (degree exactly 1) —
  // walking from there only ever needs to go one direction.
  for (const [k, list] of adj){
    if (list.length !== 1) continue;
    const { i, end } = list[0];
    if (!used[i]) chains.push(walkFrom(i, end));
  }
  // Pass 2: anything left has no degree-1 point at all, so it's a closed loop —
  // any unused segment is a valid place to start.
  for (let s=0; s<n; s++) if (!used[s]) chains.push(walkFrom(s, 0));
  return chains;
}

/* Collapses a chain's redundant interior points — mesh vertices that happen
   to fall on a perfectly (or near-perfectly) straight run, e.g. a subdivided
   facade edge or window-frame side, and so add nothing but visual noise
   (extra dots/joints) beyond the two real endpoints of that straight run.
   This is deliberately separate from dedupCollinear (worker-side): that one
   removes ink duplicated by a SEPARATE original edge; this one only ever
   drops a point when its own two neighbors already define the same line, so
   it can never change a curve's shape, only its point count.
   Tolerance is a fixed constant, not user-exposed (unlike the Dedup
   sliders) — tune SIMPLIFY_COLLINEAR_TOL directly if the default proves too
   tight/loose. Kept tiny and unscaled by zoom on purpose: this is meant to
   catch only genuine (near-)exact collinearity from mesh topology, not a
   perceptual "close enough" judgment the way the dedup tolerances are. */
export const SIMPLIFY_COLLINEAR_TOL = 0.05;   // px, perpendicular deviation allowed
// The pipeline's "not worth a separate pen mark" floor, in px — the same
// value as the worker's MIN_SEG (js/worker/dedup.js), which this thread can't
// import. Every main-thread tolerance defined as "MIN_SEG" derives from it.
export const MIN_SEG_PX = 0.3;
/* How far past its own neighbors a point may stick out and still count as
   redundant. The perpendicular test below asks whether b sits on the a→c
   LINE; on its own it says nothing about whether b sits BETWEEN a and c. For
   an ordinary straight run that distinction is empty — b always does — but a
   chain that doubles back on itself along a near-coincident line puts b far
   PAST c on that same line, and dropping it there doesn't remove a redundant
   midpoint, it erases the entire out-and-back excursion. That happens exactly
   where two parts of the mesh at different depths project onto the same
   screen line, i.e. constantly in axis-snapped orthographic views: measured
   on an X-aligned view of the pipe model, one such drop deleted a 55.5px
   stretch of Contour that the worker had emitted correctly (the two strands
   were 0.03px apart in y, well inside the perpendicular tolerance, while b
   sat 105px beyond c).
   Set to MIN_SEG rather than to SIMPLIFY_COLLINEAR_TOL so a fold-back too
   short to be a pen mark at all — fp noise between two independently-computed
   representations of the same point — still collapses exactly as it did
   before, and only excursions a plotter would actually draw are kept. */
export const SIMPLIFY_FOLDBACK_TOL = MIN_SEG_PX;
// A walk that dead-ends a hair's width from its own start point (confirmed
// against real output: gaps on the order of 1e-5 units after unit
// conversion — far below anything a plotter, or a person, could ever
// perceive) is floating-point noise from two independently-arrived-at
// representations of what's geometrically the same point, not a genuine
// open curve. Snap-close onto it rather than leaving a curve that's closed
// in every way that matters except its own SVG markup. Deliberately much
// smaller than any real feature this pipeline draws (MIN_SEG is 0.3px).
export const CHAIN_CLOSE_SNAP_TOL = 0.05;   // px
export function simplifyCollinear(pts, closed, tol=SIMPLIFY_COLLINEAR_TOL){
  const n = pts.length;
  if (n < 3) return pts;
  let work = pts;
  if (closed){
    // Rotate to start at the sharpest corner first, so the seam between
    // last and first point never lands in the middle of a straight run —
    // lets the same single open-chain sweep below handle closed loops with
    // no separate wraparound case to get subtly wrong.
    let bestI = 0, bestCross = -1;
    for (let i=0;i<n;i++){
      const a=pts[(i-1+n)%n], b=pts[i], c=pts[(i+1)%n];
      const cross = Math.abs((b[0]-a[0])*(c[1]-b[1]) - (b[1]-a[1])*(c[0]-b[0]));
      if (cross > bestCross){ bestCross = cross; bestI = i; }
    }
    work = pts.slice(bestI).concat(pts.slice(0, bestI));
  }
  const out = [work[0]];
  const last = closed ? n : n-1;      // closed: test every point incl. wrap; open: last point always kept
  for (let i=1; i<last; i++){
    const a = out[out.length-1], b = work[i], c = work[(i+1) % n];
    const acx=c[0]-a[0], acy=c[1]-a[1];
    const lenAC = Math.hypot(acx,acy);
    if (lenAC > 1e-9){
      const cross = (b[0]-a[0])*acy - (b[1]-a[1])*acx;
      const t = ((b[0]-a[0])*acx + (b[1]-a[1])*acy) / (lenAC*lenAC);
      const overshoot = t < 0 ? -t*lenAC : t > 1 ? (t-1)*lenAC : 0;
      // both tests together are "b is close to the a→c SEGMENT", not merely to
      // its infinite line — see SIMPLIFY_FOLDBACK_TOL
      if (Math.abs(cross)/lenAC <= tol && overshoot <= SIMPLIFY_FOLDBACK_TOL) continue;   // redundant, drop it
    }
    out.push(b);
  }
  if (!closed) out.push(work[n-1]);
  return out;
}

/* Shared by any flat [x0,y0,x1,y1,...] segment list that needs reconstructing
   into proper chained/closed SVG path data — the exact same chainSegments →
   splitSelfTouching → simplifyCollinear pipeline the real Silhouette/Scene-
   Outline layers use (chain:'silhouette' in layers.js). Used for the parallel
   topological-pipeline debug exports too, so their output can go through
   the person's own closed-vs-open coloring check the same way a real
   layer's export would. */
// Shared by every rendering branch below — one entry per actual pen stroke
// (subpath) in the FINAL, post-processing SVG, not per raw 2-point input
// segment. `pts` must never repeat the closing point for a closed path
// (matching the convention splitSelfTouching/mergeAdjacentTouching already
// use elsewhere in this file) — the closing segment's length is added
// separately here instead.
// stats.segments counts one per actual "L" pen-stroke drawn between two
// points (pts.length-1) — the SAME convention computeDStats uses when it
// counts L/C tokens in a frozen block's d-string (the implicit closing
// edge of a closed path, added via a trailing Z, contributes length but
// not its own segment — matching computeDStats there too). Deliberately
// NOT the raw pre-chain/pre-simplify segment count the worker originally
// emitted — that would count every tiny sub-segment the chaining/collinear-
// simplify passes below just finished merging away, which is exactly the
// mismatch a saved Layout block (built from the post-processing d-string)
// doesn't have.
export function accumulatePathStats(stats, pts, closed){
  stats.paths++;
  if (closed) stats.closedPaths++;
  stats.segments += pts.length - 1;
  let len = 0;
  for (let i=1;i<pts.length;i++) len += Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]);
  if (closed) len += Math.hypot(pts[0][0]-pts[pts.length-1][0], pts[0][1]-pts[pts.length-1][1]);
  stats.lenPx += len;
}

/* ================================================================
   mergeSilhouetteClose — post-chain cleanup for Silhouette (so/iv/ih).
   Deliberately permissive: no angle-continuity discrimination at all —
   every open chain, by nature, is expected to be part of a closed boundary,
   so any nearby tip (including a chain's own OTHER end, for self-closure)
   is a legitimate merge target. Two small steps:

   1. trimTipFoldback — a narrow, targeted fix for a specific artifact:
      occasionally a chain's very last segment folds back almost 180° over
      its own previous segment, with the true tip ending up projected back
      onto that prior segment (see the fold-back diagram this was built
      from). Contour has no equivalent pass: it chains by run identity
      carried from the worker (chainByRun) rather than by coordinate
      re-matching, and is deliberately excluded from dedupCollinear.
      Left alone, the spurious extra point sits between the chain's real
      endpoint and its neighbor, hiding what would otherwise be an exact
      (zero-gap) merge point. Trimmed before any merge search runs.

   2. mergeClose — proximity-merges every open chain tip within tolMerge
      of another (any other chain's tip, or its own opposite tip for
      self-closure), producing interpolated midpoints, then walks the
      resulting pairing graph (multi-hop runs and full closed loops alike)
      into final chains. so/iv/ih all get identical treatment — no
      exceptions, every gap within tolerance gets closed. Individual
      Silhouette only ever hides on same-shell self-occlusion (see the
      dropSelf test in the worker's 6.9), so it has no cross-shell cut
      endpoints that would need protecting from this merge.
   ================================================================ */
export function trimTipFoldback(chains, angleThreshDeg){
  const cosThresh = Math.cos(angleThreshDeg * Math.PI/180);
  function fix(pts, fromEnd){
    for (let guard=3; guard>0; guard--){
      if (pts.length < 3) break;
      const n = pts.length;
      const [cx,cy] = fromEnd ? pts[n-3] : pts[2];
      const [ax,ay] = fromEnd ? pts[n-2] : pts[1];
      const [bx,by] = fromEnd ? pts[n-1] : pts[0];
      const d1x=ax-cx, d1y=ay-cy, l1=Math.hypot(d1x,d1y)||1;
      const d2x=bx-ax, d2y=by-ay, l2=Math.hypot(d2x,d2y)||1;
      const cosAngle = (d1x/l1)*(d2x/l2) + (d1y/l1)*(d2y/l2);
      if (cosAngle > cosThresh) break;
      const t = ((bx-cx)*d1x+(by-cy)*d1y)/(l1*l1);
      if (t < 0 || t > 1) break;
      pts = fromEnd ? pts.slice(0, n-1) : pts.slice(1);
    }
    return pts;
  }
  return chains.map(c => {
    if (c.closed || c.pts.length < 3) return c;
    let pts = fix(c.pts, true);
    pts = fix(pts, false);
    return { pts, closed:false };
  });
}
export function mergeSilhouetteClose(chains, tolMerge){
  function mdist(a,b){ return Math.hypot(a[0]-b[0],a[1]-b[1]); }
  const open = [], closedOut = [];
  chains.forEach(c => { if (c.closed || c.pts.length < 2) closedOut.push(c); else open.push({ pts: c.pts.map(p=>p.slice()) }); });
  const N = open.length;
  const tips = [];
  for (let ci=0; ci<N; ci++){
    const p = open[ci].pts;
    tips.push({ pos:p[0] });
    tips.push({ pos:p[p.length-1] });
  }
  const cell = Math.max(tolMerge, 1e-6);
  const key = (x,y) => Math.floor(x/cell)+'_'+Math.floor(y/cell);
  const grid = new Map();
  tips.forEach((t,i) => { const k=key(t.pos[0],t.pos[1]); let a=grid.get(k); if(!a){a=[];grid.set(k,a);} a.push(i); });
  const paired = new Map();
  const used = new Set();
  const cand = [];
  for (let i=0;i<tips.length;i++){
    const cx=Math.floor(tips[i].pos[0]/cell), cy=Math.floor(tips[i].pos[1]/cell);
    for (let dx=-1;dx<=1;dx++) for (let dy=-1;dy<=1;dy++){
      const arr = grid.get((cx+dx)+'_'+(cy+dy)); if (!arr) continue;
      for (const j of arr){
        if (j<=i) continue;
        const d = mdist(tips[i].pos, tips[j].pos);
        if (d<=tolMerge) cand.push({i,j,d});
      }
    }
  }
  cand.sort((a,b)=>a.d-b.d);
  for (const c of cand){
    if (used.has(c.i) || used.has(c.j)) continue;
    used.add(c.i); used.add(c.j);
    paired.set(c.i, c.j); paired.set(c.j, c.i);
  }
  function ciOf(t){ return (t/2)|0; }
  function endOf(t){ return t%2; }
  function setTip(t, pt){
    const ci=ciOf(t), end=endOf(t);
    if (end===1) open[ci].pts[open[ci].pts.length-1] = pt.slice();
    else open[ci].pts[0] = pt.slice();
  }
  for (const [a,b] of paired){
    if (a>b) continue;
    const pa = tips[a].pos, pb = tips[b].pos;
    const mid = [(pa[0]+pb[0])/2, (pa[1]+pb[1])/2];
    setTip(a, mid); setTip(b, mid);
  }
  function orientedPts(ci, exitEnd){ const p = open[ci].pts; return exitEnd===1 ? p.slice() : p.slice().reverse(); }
  function tipKey(ci,end){ return ci*2+end; }
  const visited = new Uint8Array(N);
  const result = [];
  for (let ci=0; ci<N; ci++){
    if (visited[ci]) continue;
    const t0 = tipKey(ci,0), t1 = tipKey(ci,1);
    const p0 = paired.get(t0), p1 = paired.get(t1);
    if (p0 === t1 || p1 === t0){
      visited[ci] = 1;
      const pts = open[ci].pts.slice();
      pts.pop();
      result.push({ pts, closed:true });
      continue;
    }
    if (p0 != null && p1 != null) continue;
    visited[ci] = 1;
    const exitEnd = p0 != null ? 0 : 1;
    let pts = orientedPts(ci, exitEnd);
    let curTip = tipKey(ci, exitEnd);
    let closedLoop = false;
    for (let guard=N+2; guard>0; guard--){
      const partner = paired.get(curTip);
      if (partner == null) break;
      const nci = ciOf(partner), nend = endOf(partner);
      if (nci === ci){ closedLoop = true; break; }
      if (visited[nci]) break;
      visited[nci] = 1;
      const nextExitEnd = nend===1 ? 0 : 1;
      const nextPts = orientedPts(nci, nextExitEnd);
      pts = pts.concat(nextPts.slice(1));
      curTip = tipKey(nci, nextExitEnd);
    }
    if (closedLoop) pts.pop();
    result.push({ pts, closed: closedLoop });
  }
  for (let ci=0; ci<N; ci++){
    if (visited[ci]) continue;
    visited[ci] = 1;
    let pts = orientedPts(ci, 1);
    let curTip = tipKey(ci, 1);
    for (let guard=N+2; guard>0; guard--){
      const partner = paired.get(curTip);
      if (partner == null) break;
      const nci = ciOf(partner), nend = endOf(partner);
      if (visited[nci]) break;
      visited[nci] = 1;
      const nextExitEnd = nend===1 ? 0 : 1;
      const nextPts = orientedPts(nci, nextExitEnd);
      pts = pts.concat(nextPts.slice(1));
      curTip = tipKey(nci, nextExitEnd);
    }
    result.push({ pts, closed:true });
  }
  return result.concat(closedOut);
}

/* chainByRun — Contour (sv/sh) path assembly. Builds chains from the
   worker's own runId/seq identity (generate()'s Contour runs, solver.js 6.7) instead of
   chainSegments()'s global coordinate re-matching: segments sharing a
   runId are the SAME topological run the worker walked, in occlusion
   order; sorting by seq recovers it exactly, with no bucket/junction
   heuristics at all. A run can still arrive here with real gaps —
   subtractCovered punches holes when a higher-priority layer covers part
   of it — so consecutive same-run segments that don't actually share an
   endpoint (same ~0.02px tolerance chainSegments/splitSelfTouching use)
   start a fresh polyline rather than being stitched across the hole.
   Each returned chain carries the run.id its segments came from (multiple
   chains can share one runId, in seq order, when subtractCovered punched
   a hole) — mergeContourRunSplits below is the consumer. */
export function chainByRun(segs, runIds, seqs){
  const eq = (x1,y1,x2,y2) => Math.abs(x1-x2)<0.02 && Math.abs(y1-y2)<0.02;
  const n = segs.length/4;
  const byRun = new Map();
  for (let i=0;i<n;i++){
    const rid = runIds[i];
    let list = byRun.get(rid);
    if (!list){ list=[]; byRun.set(rid, list); }
    list.push(i);
  }
  const polys = [];
  for (const [rid, list] of byRun){
    list.sort((a,b) => seqs[a]-seqs[b]);
    let cur = null;
    for (const i of list){
      const x0=segs[i*4],y0=segs[i*4+1],x1=segs[i*4+2],y1=segs[i*4+3];
      if (cur && eq(cur[cur.length-1][0], cur[cur.length-1][1], x0,y0)) cur.push([x1,y1]);
      else { if (cur) polys.push({ pts: cur, runId: rid }); cur = [[x0,y0],[x1,y1]]; }
    }
    if (cur) polys.push({ pts: cur, runId: rid });
  }
  return polys.map(({ pts, runId }) => {
    const closed = pts.length>2 && eq(pts[0][0],pts[0][1], pts[pts.length-1][0],pts[pts.length-1][1]);
    return { pts: closed ? pts.slice(0,-1) : pts, closed, runId };
  });
}

/* mergeContourRunSplits — Contour run-identity merge, built on top of
   chainByRun's own runId-tagged chains. Two DIFFERENT run.ids can
   legitimately need joining into one visual stroke, and neither case is
   safe for chainByRun's own local touch-check to catch (that only ever
   looks within one runId's own segment list):

   (a) "sandwich" — a run that's (almost) entirely triangulation-diagonal
       artifact ends up with ALL its own material dropped by the worker's
       Contour cleanup (solver.js 6.5/6.8), so it never reaches here at all
       — but it used to sit, in the worker's own chain-walk order, between
       two OTHER runs that are now left with nothing between them. The
       worker posts every run's prevId/nextId (solver.js 6.7,
       counts.contourAdjacency) precisely so this can be recognized
       here: an id present in that adjacency table but absent from this
       layer's own chains is exactly such a vanished run, and its
       prevId/nextId (walked past any number of ALSO-vanished neighbors,
       in case several artifact runs sit back to back) name the two chains
       that should be bridged, in a known, non-ambiguous direction.
       Bridged ONLY from both runs' genuine endpoints (tipP0/tipP1, also
       posted by the worker before the cross-layer cascade runs). With a
       Silhouette layer enabled, subtractCovered can trim a Contour run's
       own head or tail away entirely, leaving this pass anchored to an
       arbitrary interior cut — see the check in the loop below for why
       that must not be bridged.
   (b) near-coincident endpoints — two runs whose emitted tips land within
       MIN_SEG_PX of each other regardless of adjacency, most likely two
       different chains sharing one mesh vertex (pairJunctionArms only
       pairs one straightest continuation per junction), or two
       independently-computed copies of what's really the same point.
       Averaged to a shared midpoint (mergeSilhouetteClose's own convention
       for exactly this) rather than bridged — MIN_SEG_PX is small enough that the averaging can never
       visibly displace real geometry, so this never needs to distinguish
       WHY the two tips are close, only that they are.

   Both resolve to an explicit (chain, tip) pairing, then get walked
   exactly like mergeSilhouetteClose's own tip graph (open runs only;
   closed loops need no merge, they already have no open tip) — reused
   here rather than reinvented, just driven by these specific pairs
   instead of a distance search. When several runs merge, the merged
   result is labeled with the LOWEST contributing run.id (bookkeeping
   only — the exported path is pure geometry and carries no id). */
export function mergeContourRunSplits(chains, adjacency){
  if (!adjacency || !adjacency.length) return chains;
  const EPS = 1e-4;   // exact-computation match, not a proximity tolerance — see dedup.js's EXACT_DUP_EPS
  const eq = (a,b) => Math.abs(a[0]-b[0])<EPS && Math.abs(a[1]-b[1])<EPS;

  const open = [], closedOut = [];
  chains.forEach(c => { if (c.closed || c.pts.length<2) closedOut.push(c); else open.push(c); });
  const N = open.length;
  if (N < 2) return chains;

  // first/last chain-piece index for each runId — chainByRun already
  // emits multiple pieces of one runId in seq order, so "first"/"last"
  // here are that run's own head/tail ends.
  const firstOfRun = new Map(), lastOfRun = new Map();
  open.forEach((c,i) => {
    if (!firstOfRun.has(c.runId)) firstOfRun.set(c.runId, i);
    lastOfRun.set(c.runId, i);
  });

  const tipKey = (ci,end) => ci*2+end;   // end: 0=start, 1=end
  const paired = new Map();
  const link = (ta, tb) => { paired.set(ta,tb); paired.set(tb,ta); };

  // (a) sandwich pairs — walk past any run of consecutively-vanished
  // neighbors to find the nearest run on each side that actually HAS
  // content, then bridge those two, in the known prevId→nextId direction.
  // Deliberately keyed on the worker's own hasContent flag, NOT on whether
  // a run's segments actually made it into `chains` — those are two
  // different questions. A run can have real, worker-computed content and
  // still be entirely absent from `chains` simply because its own layer
  // checkbox (Contour hidden, say) is off; that says nothing about
  // whether real occlusion put a genuine gap there, and bridging across it
  // would replace a deliberate hidden-line break with a false straight
  // line. Only a run the worker's cleanup itself left with nothing
  // (artifact, genuinely eliminated) is eligible to be walked past/bridged
  // over.
  const adjById = new Map(adjacency.map(a => [a.id, a]));
  const hasContentIds = new Set(adjacency.filter(a => a.hasContent).map(a => a.id));
  const nearestSurviving = (startId, dir) => {
    let cur = startId, guard = adjacency.length + 2;
    while (guard-- > 0){
      if (cur == null || cur < 0) return null;
      if (hasContentIds.has(cur)) return cur;
      const a = adjById.get(cur);
      if (!a) return null;
      cur = a[dir];
    }
    return null;
  };
  for (const a of adjacency){
    if (a.hasContent) continue;   // only start from a run the cleanup left with nothing at all
    const prevSurv = nearestSurviving(a.prevId, 'prevId');
    const nextSurv = nearestSurviving(a.nextId, 'nextId');
    if (prevSurv == null || nextSurv == null || prevSurv === nextSurv) continue;
    const ai = lastOfRun.get(prevSurv), bi = firstOfRun.get(nextSurv);
    if (ai == null || bi == null) continue;   // has content, but isn't drawn in THIS layer (own checkbox off) — nothing to bridge to
    // Only bridge from the two runs' GENUINE ends. When a higher-priority
    // layer is enabled, subtractCovered (worker, cross-layer cascade) trims
    // and deletes sv/sh segments — so one runId can arrive here as several
    // chains, and a run's own head or tail segments may be gone entirely.
    // lastOfRun/firstOfRun then point at a piece whose end/start is an
    // arbitrary interior cut rather than the run's real tip, and bridging
    // those draws a long straight line between two points that were never
    // adjacent. That is exactly the case that must NOT be bridged: a cut end
    // means higher-priority ink occupies the gap, so the gap is correct.
    // The worker posts each run's true tips (tipP0/tipP1) before the cascade
    // can touch them; compare exactly (EPS above), since nothing has moved
    // these coordinates yet — simplifyCollinear/splitSelfTouching run later.
    const prevAdj = adjById.get(prevSurv), nextAdj = adjById.get(nextSurv);
    if (!prevAdj || !prevAdj.tipP1 || !nextAdj || !nextAdj.tipP0) continue;
    const aPts = open[ai].pts, bPts = open[bi].pts;
    if (!eq(aPts[aPts.length-1], prevAdj.tipP1)) continue;   // prev run cut short at its tail
    if (!eq(bPts[0], nextAdj.tipP0)) continue;               // next run cut short at its head
    const ta = tipKey(ai,1), tb = tipKey(bi,0);
    if (!paired.has(ta) && !paired.has(tb)) link(ta, tb);
  }

  // (b) near-coincident tip pairs within MIN_SEG_PX, across DIFFERENT run.ids
  // only (same-run splits are already stitched by chainByRun's own touch
  // check). Unlike (a)'s deliberate bridge across real removed material,
  // a pair found here is treated as the SAME real point, just resolved to
  // slightly different coordinates by two independently-computed runs —
  // averaged to a shared midpoint (same convention mergeSilhouetteClose
  // already uses for its own proximity merges) so the walk below sees a
  // genuine touch, not a bridge. Candidates are collected and consumed
  // nearest-first (also mirroring mergeSilhouetteClose) so an ambiguous
  // 3-way near-coincidence resolves to its closest pairing rather than
  // whichever one happened to be tested first. MIN_SEG_PX is small enough
  // that averaging two points within it can never visibly displace real
  // geometry, regardless of whether the gap turns out to be occlusion noise,
  // a crossing-split trim, or a shared/near-shared mesh vertex.
  const tipPos = (ci,end) => end===1 ? open[ci].pts[open[ci].pts.length-1] : open[ci].pts[0];
  const setTip = (ci,end,pt) => { if (end===1) open[ci].pts[open[ci].pts.length-1] = pt.slice(); else open[ci].pts[0] = pt.slice(); };
  const proxCand = [];
  for (let i=0;i<N;i++){
    for (let ei=0; ei<2; ei++){
      const ta = tipKey(i,ei);
      if (paired.has(ta)) continue;
      const pa = tipPos(i,ei);
      for (let j=i+1;j<N;j++){
        if (open[i].runId === open[j].runId) continue;
        for (let ej=0; ej<2; ej++){
          const tb = tipKey(j,ej);
          if (paired.has(tb)) continue;
          const pb = tipPos(j,ej);
          const d = Math.hypot(pa[0]-pb[0], pa[1]-pb[1]);
          if (d < MIN_SEG_PX) proxCand.push({ ta, tb, d, ci:i, ei, cj:j, ej });
        }
      }
    }
  }
  proxCand.sort((x,y) => x.d - y.d);
  for (const c of proxCand){
    if (paired.has(c.ta) || paired.has(c.tb)) continue;
    const pa = tipPos(c.ci,c.ei), pb = tipPos(c.cj,c.ej);
    const mid = [(pa[0]+pb[0])/2, (pa[1]+pb[1])/2];
    setTip(c.ci,c.ei,mid); setTip(c.cj,c.ej,mid);
    link(c.ta, c.tb);
  }

  // Walk the pairing graph — same structure as mergeSilhouetteClose's own
  // walk (open-chain pass, then closed-loop-only fallback).
  function orientedPts(ci, exitEnd){ const p = open[ci].pts; return exitEnd===1 ? p.slice() : p.slice().reverse(); }
  const visited = new Uint8Array(N);
  // Joins chain ci (leaving through its exitEnd tip) with every unvisited
  // chain reachable along the pairing graph. Returns the joined points and
  // the lowest contributing run.id.
  const walkFrom = (ci, exitEnd) => {
    let pts = orientedPts(ci, exitEnd);
    let minRunId = open[ci].runId;
    let curTip = tipKey(ci, exitEnd);
    for (let guard=N+2; guard>0; guard--){
      const partner = paired.get(curTip);
      if (partner == null) break;
      const nci = (partner/2)|0, nend = partner%2;
      if (visited[nci]) break;
      visited[nci] = 1;
      if (open[nci].runId < minRunId) minRunId = open[nci].runId;
      const nextExitEnd = nend===1 ? 0 : 1;
      const nextPts = orientedPts(nci, nextExitEnd);
      // A (b) pair's tips were overwritten to one shared midpoint above, so
      // the neighbor's leading point is a duplicate and is dropped. An (a)
      // sandwich pair is a genuine BRIDGE across a real gap — its two
      // endpoints are deliberately different points, so the neighbor's
      // leading point is kept and the bridge segment itself gets emitted.
      const bridging = !eq(pts[pts.length-1], nextPts[0]);
      pts = pts.concat(bridging ? nextPts : nextPts.slice(1));
      curTip = tipKey(nci, nextExitEnd);
    }
    return { pts, minRunId };
  };
  const result = [];
  for (let ci=0; ci<N; ci++){
    if (visited[ci]) continue;
    const t0 = tipKey(ci,0), t1 = tipKey(ci,1);
    const p0 = paired.get(t0), p1 = paired.get(t1);
    if (p0 === t1 || p1 === t0){
      visited[ci] = 1;
      const pts = open[ci].pts.slice(); pts.pop();
      result.push({ pts, closed:true, runId: open[ci].runId });
      continue;
    }
    if (p0 != null && p1 != null) continue;   // interior of a longer run — reached from its own true end below
    visited[ci] = 1;
    const { pts, minRunId } = walkFrom(ci, p0 != null ? 0 : 1);
    result.push({ pts, closed:false, runId: minRunId });
  }
  for (let ci=0; ci<N; ci++){   // whatever's left must be pure cycles
    if (visited[ci]) continue;
    visited[ci] = 1;
    const { pts, minRunId } = walkFrom(ci, 1);
    result.push({ pts, closed:true, runId: minRunId });
  }
  return result.concat(closedOut);
}

/* Appends one polyline to the `d` token array as an SVG subpath (M/L, plus Z
   when closed — `pts` never repeats the first point), and counts it into
   `stats` when given. Every chained line layer's path is built through this. */
export function appendPolylineD(d, pts, closed, stats){
  if (stats) accumulatePathStats(stats, pts, closed);
  d.push('M', pts[0][0].toFixed(2), pts[0][1].toFixed(2));
  for (let i=1;i<pts.length;i++) d.push('L', pts[i][0].toFixed(2), pts[i][1].toFixed(2));
  if (closed) d.push('Z');
}

/* Silhouette / Silhouette individual (so/iv/ih) layer → path data string:
   global coordinate chaining, then Silhouette's own tip cleanup
   (trimTipFoldback + mergeSilhouetteClose, see silMergeOpts), then the
   shared split-self-touching / collinear-simplify tail. */
export function buildChainedPathD(segs, stats, silMergeOpts){
  const d = [];
  let chains = chainSegments(segs);
  chains = trimTipFoldback(chains, silMergeOpts.foldbackAngleThreshDeg);
  chains = mergeSilhouetteClose(chains, silMergeOpts.tolMerge);
  for (const chain of chains)
    for (const { pts: rawPts, closed } of splitSelfTouching(chain.pts, chain.closed))
      appendPolylineD(d, simplifyCollinear(rawPts, closed), closed, stats);
  return d.join(' ');
}

/* Crease/hidden-crease arrive here already topologically pre-ordered by the
   worker (see the crease-chain design spec): genuinely continuous runs are
   pushed as array-adjacent segments with matching endpoints, using
   straightness-based pairing at junctions rather than screen coincidence.
   Unlike chainSegments() above — a GLOBAL coordinate search, safe for
   so/iv/ih since those are always simple non-branching curves by
   construction — crease networks have real junctions, so a global search
   here could silently undo the worker's pairing by reconnecting to
   whichever OTHER candidate happens to sit at the same point first. This
   merge is deliberately LOCAL: it only ever looks at the immediately
   preceding array entry, so it can never produce a wrong connection —
   only, rarely (where cross-layer subtraction happened to reorder
   something), miss a merge it could have made, falling back to one
   segment per stroke there exactly like before this feature existed. */
export function mergeAdjacentTouching(segs){
  const n = segs.length/4;
  const eq = (x1,y1,x2,y2) => Math.abs(x1-x2)<0.02 && Math.abs(y1-y2)<0.02;
  const polys = [];
  let cur = null;
  for (let i=0;i<n;i++){
    const x0=segs[i*4],y0=segs[i*4+1],x1=segs[i*4+2],y1=segs[i*4+3];
    if (cur && eq(cur[cur.length-1][0], cur[cur.length-1][1], x0,y0)) cur.push([x1,y1]);
    else { if (cur) polys.push(cur); cur = [[x0,y0],[x1,y1]]; }
  }
  if (cur) polys.push(cur);
  return polys.map(pts => {
    const closed = pts.length>2 &&
      Math.abs(pts[0][0]-pts[pts.length-1][0])<0.02 && Math.abs(pts[0][1]-pts[pts.length-1][1])<0.02;
    return { pts: closed ? pts.slice(0,-1) : pts, closed };
  });
}

/* SECOND, fallback pass for crease/hidden-crease — screen-space, deliberately
   more permissive than mergeAdjacentTouching() above.

   Why this is needed: the worker's crease topology pass (generate() 6.1)
   pairs at most ONE continuation per junction. pairJunctionArms maximises
   the NUMBER of pairs, but it deliberately refuses to pair a near-total
   fold-back, and an odd-valence junction always leaves at least one arm
   over regardless. So wherever three or more crease edges meet, the walk
   emits several SEPARATE chains that genuinely terminate at the same welded
   mesh vertex — and therefore at the same screen point.
   A right-angle box corner or window-frame rectangle is exactly this case:
   every corner is a 3-way junction, so the four sides arrive here as
   disconnected chains, and mergeAdjacentTouching's array-adjacency check
   can't place them next to each other because nothing ordered them that way.
   (Contour hits the identical phenomenon — see mergeContourRunSplits case
   (b) — but resolves it differently, since Contour carries run identity and
   Crease does not.)

   This pass repairs that by matching leftover polyline ENDPOINTS by screen
   coordinate — never interior points, so it can never splice into the
   middle of an already-correct chain, only extend from its two loose ends:
     - exactly 2 loose ends meet at one screen point → always joined.
     - 3+ loose ends at one point (a junction the topology pass never saw,
       since it never saw this edge at all) → no straightness scoring here,
       just take the first two in array order, join them, then re-examine
       the SAME point for any remaining ends — repeat until at most one is
       left there, same "arbitrary order, then move on" rule as any other
       junction pairing in this file.
   If a chain's two loose ends eventually meet at the same point (a merged
   window frame closing back on itself), it's emitted as a genuinely closed
   loop — coincident first/last point collapsed, `closed:true` — exactly
   like Silhouette/Scene-outline's chainSegments() above, rather than left
   as a duplicated coincident point.

   Trade-off, by design: this trusts screen-space coincidence for whatever
   mergeAdjacentTouching left as a loose end, so in principle two unrelated
   dangling ends that merely happen to project to the same pixel could be
   joined. In practice this only ever touches genuine chain termini (never
   interior points), and it only runs on ends the topology pass left unpaired
   and mergeAdjacentTouching couldn't join — the same trade-off the user asked
   for to fix box/building facades, where every corner is an exact on-screen
   coincidence anyway. */
export function mergeCreaseScreenSpace(polys){
  const key = (x,y) => Math.round(x*50) + '_' + Math.round(y*50);   // ~0.02px buckets, same as above

  const result = [];
  const allPolys = [];
  const buckets = new Map();     // screen point key → [{poly, end(0=start,1=end)}, ...]

  const addEnd = (poly, end) => {
    const pt = end===0 ? poly.pts[0] : poly.pts[poly.pts.length-1];
    const k = key(pt[0], pt[1]);
    let list = buckets.get(k);
    if (!list){ list=[]; buckets.set(k,list); }
    list.push({ poly, end });
    return k;
  };

  for (const p of polys){
    if (p.closed){ result.push(p); continue; }     // already a complete stroke — leave untouched
    const poly = { pts: p.pts, alive:true };
    allPolys.push(poly);
    addEnd(poly, 0);
    addEnd(poly, 1);
  }

  const queue = [...buckets.keys()];
  const queued = new Set(queue);
  const enqueue = k => { if (!queued.has(k)){ queued.add(k); queue.push(k); } };

  while (queue.length){
    const k = queue.shift();
    queued.delete(k);
    for (;;){
      const raw = buckets.get(k);
      if (!raw) break;
      const live = raw.filter(e => e.poly.alive);
      if (live.length < 2){ buckets.set(k, live); break; }

      const [A, B] = live;                 // "arbitrary order (index value)": first two, array order
      buckets.set(k, live.slice(2));

      if (A.poly === B.poly){              // both loose ends of ONE chain meet here → it closes
        A.poly.alive = false;
        result.push({ pts: A.poly.pts.slice(0, -1), closed:true });
        continue;                          // keep resolving any further ends still at this point
      }

      let ptsA = A.poly.pts, ptsB = B.poly.pts;
      if (A.end === 0) ptsA = ptsA.slice().reverse();   // orient so ptsA ENDS at the junction
      if (B.end === 1) ptsB = ptsB.slice().reverse();   // orient so ptsB STARTS at the junction
      const merged = { pts: ptsA.concat(ptsB.slice(1)), alive:true };   // drop duplicate junction point
      A.poly.alive = false; B.poly.alive = false;
      allPolys.push(merged);
      const k0 = addEnd(merged, 0), k1 = addEnd(merged, 1);
      if (k0 !== k) enqueue(k0);
      if (k1 !== k) enqueue(k1);
      // fall through and loop again: more loose ends may remain at this junction
    }
  }

  for (const poly of allPolys) if (poly.alive) result.push({ pts: poly.pts, closed:false });
  return result;
}

/* Final safety net, applied to every chained/merged polyline right before
   SVG serialization — Silhouette, Scene-outline, Crease, hidden-crease
   alike. Guarantees no emitted subpath ever revisits the SAME on-screen
   point at an INTERIOR position (as opposed to the expected start≈end
   coincidence of a genuinely closed loop, which this leaves alone).

   Why this exists: a subpath that touches itself mid-stroke — draws out to
   a point, keeps going, and later passes back through that exact point
   again before terminating — is valid SVG, and line-segment renderers (a
   pen plotter, Affinity's own renderer) draw it correctly since they just
   draw each segment independently. But curve-importing tools build ONE
   continuous spline object per subpath, and can't represent "pass through
   this vertex twice" — Blender's SVG importer in particular will silently
   drop or mis-merge the revisited vertex while building that spline,
   quietly losing a vertex/kink with no warning at all. This can happen
   whenever a merge pass has to choose a pairing at a 3+-way junction with
   no stronger signal than array order (see mergeCreaseScreenSpace's own
   comment) — occasionally it stitches a small closed loop together with a
   passing-through tail instead of letting the loop close on its own.

   Since revisiting a point mid-path means that point is a REAL junction
   (three or more strokes genuinely meet there), the safe fix is the same
   one used everywhere else in this file for junctions: split there. The
   part of the path that returns to the touch point becomes its own closed
   loop; whatever remains before/after stays as the (now simple) rest of
   the chain. Same ink, restructured into pieces no import tool can choke
   on. Nested self-touches (a loop that itself touches a point twice) are
   peeled off one at a time, so this holds for any number of them. */
export function splitSelfTouching(pts, closed){
  const key = (p) => Math.round(p[0]*50) + '_' + Math.round(p[1]*50);   // ~0.02px buckets, same as above
  const seen = new Map();          // point key → index within `out`
  const out = [];
  const loops = [];
  for (const p of pts){
    const k = key(p);
    if (seen.has(k)){
      const i = seen.get(k);
      loops.push(out.slice(i));                  // out[i]..out[end] is a simple closed loop
      for (let j=i+1;j<out.length;j++) seen.delete(key(out[j]));
      out.length = i+1;                           // keep the shared anchor point, drop the rest
    } else {
      seen.set(k, out.length);
      out.push(p);
    }
  }
  const pieces = [];
  if (out.length>=2) pieces.push({ pts: out, closed });
  for (const l of loops) if (l.length>=2) pieces.push({ pts: l, closed:true });
  return pieces;
}

/* Contour micro-geometry cleanup — the last two steps of appendContourPathD,
   run on finished pieces ({pts, closed}, after splitSelfTouching and
   simplifyCollinear).

   Where they come from: in an axis-aligned view many mesh edges run almost
   along the view direction (in the X-aligned pipe scene, 342 edges project
   to under 0.2px). At a tube end the silhouette genuinely travels along such
   an edge and back, so the worker's Contour carries a ~0.17px out-and-back
   stub at the junction where several runs meet. Chaining then turns each
   stub into one of: a whole run that is just the stub (emitted as a
   2-point closed "loop" the pen draws out and back), a single sub-MIN_SEG
   segment standing alone, a stub glued to the start or end of a real stroke
   (a near-180° fold), or — once two runs tracing the same stub are merged —
   a micro-loop that splitSelfTouching cuts out as its own closed piece.

   Both steps are bounded so they only ever remove ink that is still on the
   page, measured over 28 views of the pipe and demo scenes (0 gap cells).
   The unbounded versions of each were measured to delete real ink. */
export const CONTOUR_MICRO_TOL = MIN_SEG_PX;

/* Trims a path-end vertex that folds straight back (turn > 150°) onto the
   segment before it. Unlike trimTipFoldback (Silhouette's version), the tip
   must also lie within CONTOUR_MICRO_TOL of that segment's LINE, not just
   inside its span: without the distance check a genuine short edge meeting a
   long one at a shallow angle reads as a fold too, and gets cut (measured —
   a real 7px edge at 9° on the pipe, 107 cells of real ink on the demo mesh).
   Runs after simplifyCollinear on purpose: before it, the previous segment
   is usually a micro-segment shorter than the stub folding back over it, so
   the tip doesn't land inside its span and nothing is caught. */
export function trimContourFoldbacks(pieces){
  const cosThresh = Math.cos(150 * Math.PI/180);
  return pieces.map(piece => {
    if (piece.closed || piece.pts.length < 3) return piece;
    let pts = piece.pts;
    const fix = fromEnd => {
      for (let guard=3; guard>0 && pts.length>=3; guard--){
        const n = pts.length;
        const [cx,cy] = fromEnd ? pts[n-3] : pts[2];
        const [ax,ay] = fromEnd ? pts[n-2] : pts[1];
        const [bx,by] = fromEnd ? pts[n-1] : pts[0];
        const d1x=ax-cx, d1y=ay-cy, l1=Math.hypot(d1x,d1y);
        const d2x=bx-ax, d2y=by-ay, l2=Math.hypot(d2x,d2y);
        if (l1 < 1e-9 || l2 < 1e-9) break;
        if ((d1x*d2x + d1y*d2y)/(l1*l2) > cosThresh) break;                        // not a fold-back
        const t = ((bx-cx)*d1x + (by-cy)*d1y)/(l1*l1);
        if (t < 0 || t > 1) break;                                                   // doesn't land on the segment
        if (Math.abs((bx-cx)*d1y - (by-cy)*d1x)/l1 > CONTOUR_MICRO_TOL) break;       // doesn't retrace it
        pts = fromEnd ? pts.slice(0, n-1) : pts.slice(1);
      }
    };
    fix(true); fix(false);
    return { pts, closed:false };
  });
}

/* Drops pieces smaller than CONTOUR_MICRO_TOL across — but only when the
   rest of the layer already puts ink within CONTOUR_MICRO_TOL of every point
   of them, so nothing leaves the page. A micro-piece that is the only ink at
   its spot is kept: along hidden-contour curves some of them are exactly
   that, and dropping every tiny piece unconditionally was measured to punch
   holes there. Checked against the non-tiny pieces only, so two slivers can
   never vouch for each other and both disappear. */
export function dropRedundantContourSlivers(pieces){
  const extentOf = pts => {
    let x0=Infinity, y0=Infinity, x1=-Infinity, y1=-Infinity;
    for (const [x,y] of pts){ if (x<x0) x0=x; if (x>x1) x1=x; if (y<y0) y0=y; if (y>y1) y1=y; }
    return Math.hypot(x1-x0, y1-y0);
  };
  const tiny = pieces.map(p => extentOf(p.pts) < CONTOUR_MICRO_TOL);
  if (!tiny.some(Boolean)) return pieces;
  const G = 2, grid = new Map(), segs = [];
  pieces.forEach((p, pi) => {
    if (tiny[pi]) return;
    const q = p.closed ? [...p.pts, p.pts[0]] : p.pts;
    for (let i=0;i+1<q.length;i++){
      const s = segs.length;
      segs.push(q[i][0], q[i][1], q[i+1][0], q[i+1][1]);
      const xa=Math.min(q[i][0],q[i+1][0]), xb=Math.max(q[i][0],q[i+1][0]);
      const ya=Math.min(q[i][1],q[i+1][1]), yb=Math.max(q[i][1],q[i+1][1]);
      for (let gx=Math.floor(xa/G)-1; gx<=Math.floor(xb/G)+1; gx++)
        for (let gy=Math.floor(ya/G)-1; gy<=Math.floor(yb/G)+1; gy++){
          const k = gx + ',' + gy;
          let list = grid.get(k);
          if (!list){ list = []; grid.set(k, list); }
          list.push(s);
        }
    }
  });
  const covered = (x, y) => {
    const list = grid.get(Math.floor(x/G) + ',' + Math.floor(y/G));
    if (!list) return false;
    for (const s of list){
      const dx=segs[s+2]-segs[s], dy=segs[s+3]-segs[s+1], L2=dx*dx+dy*dy;
      let t = L2 > 1e-12 ? ((x-segs[s])*dx + (y-segs[s+1])*dy)/L2 : 0;
      t = Math.max(0, Math.min(1, t));
      if (Math.hypot(x-(segs[s]+t*dx), y-(segs[s+1]+t*dy)) <= CONTOUR_MICRO_TOL) return true;
    }
    return false;
  };
  return pieces.filter((p, pi) => {
    if (!tiny[pi]) return true;
    const q = p.closed ? [...p.pts, p.pts[0]] : p.pts;
    for (let i=0;i<q.length;i++){
      if (!covered(q[i][0], q[i][1])) return true;
      if (i+1 < q.length && !covered((q[i][0]+q[i+1][0])/2, (q[i][1]+q[i+1][1])/2)) return true;
    }
    return false;
  });
}

/* Contour (sv/sh) layer → path tokens appended to `d`. Built straight from
   the worker's own runId/seq chain identity (chainByRun), never from
   coordinate re-matching. mergeContourRunSplits then re-joins any run that's
   permanently split across a vanished-artifact run or a shared-vertex
   coincidence — `adjacency` is the FULL table (both sv and sh), since a
   vanished run's prevId/nextId can name runs of either state; entries that
   aren't relevant to this layer are no-ops. Then the shared
   split-self-touching / collinear-simplify tail, plus Contour's own
   micro-geometry cleanup (trimContourFoldbacks, dropRedundantContourSlivers). */
export function appendContourPathD(d, segs, runIds, seqs, adjacency, stats){
  const contourChains = mergeContourRunSplits(chainByRun(segs, runIds, seqs), adjacency);
  let pieces = [];
  for (const chain of contourChains)
    for (const { pts: rawPts, closed } of splitSelfTouching(chain.pts, chain.closed))
      pieces.push({ pts: simplifyCollinear(rawPts, closed), closed });
  pieces = dropRedundantContourSlivers(trimContourFoldbacks(pieces));
  for (const { pts, closed } of pieces) appendPolylineD(d, pts, closed, stats);
}

/* Crease (cv/ch) layer → path tokens appended to `d`:
   1) mergeAdjacentTouching — local, topology-trusting merge of array-adjacent
      touching pieces
   2) mergeCreaseScreenSpace — screen-space fallback that mops up whatever (1)
      couldn't place, e.g. the extra arms pairJunctionArms left unpaired at a
      3+-way junction (see its own comment for why)
   3) splitSelfTouching safety net — see its own comment for the
      Blender-import bug this specifically guards
   then collinear simplify. */
export function appendCreasePathD(d, segs, stats){
  for (const chain of mergeCreaseScreenSpace(mergeAdjacentTouching(segs)))
    for (const { pts: rawPts, closed } of splitSelfTouching(chain.pts, chain.closed))
      appendPolylineD(d, simplifyCollinear(rawPts, closed), closed, stats);
}

/* ================= texture effects =================
   The implementations of the texture filters a fill layer's stack can
   hold (TEXTURE_FILTERS in layers.js declares their parameters). Every
   length parameter is authored in mm and converted with the caller's
   mmToPx. A hatch layer's effects run on its flat segment list (plus the
   per-segment carrier index the worker sends, so fragments of one line
   jitter together); Circles has arc-aware variants of the first few and
   shares wobble/gaps once its arcs are polylines. applyTextureStack
   (further down) runs them in the layer's stack order. */
// The family angle of a hatch layer's lines — the same angle its pass was
// solved at (layers.js: angleDeg), so the texture's along-line direction
// matches the lines it is displacing.
function hatchFamilyAngleDeg(L){
  return +L.angleDeg || 0;
}
// Smooth 2D value noise: hash the 4 surrounding integer-grid corners
// pseudo-randomly, then smoothstep-interpolate between them. Continuous
// and deterministic — same (x,y) always gives the same value — which is
// what makes a "wobble" read as a gentle wave instead of visual static.
function hatchNoiseHash(ix, iy){
  let h = ix*374761393 + iy*668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}
function hatchNoiseSmooth(t){ return t*t*(3-2*t); }
function hatchNoise2D(x, y){
  const x0=Math.floor(x), y0=Math.floor(y), x1=x0+1, y1=y0+1;
  const sx=hatchNoiseSmooth(x-x0), sy=hatchNoiseSmooth(y-y0);
  const n00=hatchNoiseHash(x0,y0), n10=hatchNoiseHash(x1,y0);
  const n01=hatchNoiseHash(x0,y1), n11=hatchNoiseHash(x1,y1);
  const nx0 = n00 + (n10-n00)*sx, nx1 = n01 + (n11-n01)*sx;
  return nx0 + (nx1-nx0)*sy;
}
// Subdivides each segment (spacing controls how finely — a short fragment
// naturally gets fewer subdivisions than a long one) and displaces each
// interior point perpendicular to the segment by noise mapped to
// [-amp/2, amp/2], so wobble is symmetric around the original line rather
// than always pushing one direction. sharedSeed (when set) makes every
// segment sample the SAME patch of the noise field at its true position,
// so nearby lines wobble in a correlated, flowing way; without it, each
// segment draws its own large random offset into an unrelated patch of
// the same field, so neighboring lines wobble independently — real
// hand-drawn lines don't share a noise field with each other.
// Poisson-process gaps: exponential inter-gap intervals (mean = minLenPx)
// naturally give the "sometimes several breaks, sometimes just one or
// two" clustering behavior — pure chance means some stretches draw
// several short intervals in a row while others draw one long one.
// minLenPx does double duty as both that average spacing AND a hard
// floor: a total length shorter than it is left completely untouched,
// since it wouldn't statistically expect even one gap anyway. Shared by
// applyHatchGaps (generic polylines) and applyCircleGaps (circle arcs) —
// this only deals in abstract cumulative-length units, with no
// knowledge of what the underlying curve actually is, so both can use
// the exact same random-interval logic rather than duplicating it.
function generateGapIntervals(total, minLenPx, maxGapPx){
  if (maxGapPx <= 0 || minLenPx <= 0 || total < minLenPx) return null;
  const gaps = [];
  let pos = -minLenPx * Math.log(1 - Math.random());
  while (pos < total){
    const gEnd = Math.min(total, pos + Math.random()*maxGapPx);
    if (gEnd > pos) gaps.push([pos, gEnd]);
    pos = gEnd - minLenPx * Math.log(1 - Math.random());
  }
  return gaps.length ? gaps : null;
}
function applyHatchGaps(polylines, minLenPx, maxGapPx){
  if (maxGapPx <= 0 || minLenPx <= 0) return polylines;
  const out = [];
  for (const poly of polylines){
    const nPts = poly.length/2;
    const cum = [0];
    for (let i=1; i<nPts; i++){
      cum.push(cum[i-1] + Math.hypot(poly[i*2]-poly[(i-1)*2], poly[i*2+1]-poly[(i-1)*2+1]));
    }
    const total = cum[nPts-1];
    if (nPts < 2){ out.push(poly); continue; }
    const gaps = generateGapIntervals(total, minLenPx, maxGapPx);
    if (!gaps){ out.push(poly); continue; }
    let idx = 1;
    function interpAt(s){
      while (idx < nPts-1 && cum[idx] < s) idx++;
      const segLen = cum[idx]-cum[idx-1];
      const t = segLen > 1e-9 ? (s-cum[idx-1])/segLen : 0;
      return [poly[(idx-1)*2] + (poly[idx*2]-poly[(idx-1)*2])*t,
              poly[(idx-1)*2+1] + (poly[idx*2+1]-poly[(idx-1)*2+1])*t];
    }
    let onStart = 0;
    for (const [gs, ge] of gaps){
      if (gs > onStart + 1e-6){
        const first = interpAt(onStart);
        const startIdx = idx;
        const last = interpAt(gs);
        const chain = [first[0], first[1]];
        for (let k=startIdx; k<idx; k++) chain.push(poly[k*2], poly[k*2+1]);
        chain.push(last[0], last[1]);
        out.push(chain);
      } else {
        interpAt(gs);   // gap starts at/before current cursor — just advance past it
      }
      onStart = ge;
    }
    if (onStart < total - 1e-6){
      const first = interpAt(onStart);
      const startIdx = idx;
      const last = interpAt(total);
      const chain = [first[0], first[1]];
      for (let k=startIdx; k<idx; k++) chain.push(poly[k*2], poly[k*2+1]);
      chain.push(last[0], last[1]);
      out.push(chain);
    }
  }
  return out;
}
// The Wobble and Gaps stack entries of one layer as local-px parameters —
// read the same way for the hatch layers and the Circles layer in
// onResult. Noise seeds are drawn only when "Same noise field per layer"
// is on.
function readWobbleParams(entry, mmToPx){
  const isShared = !!entry.shared;
  return {
    spacingPx: (+entry.spacing || 1) * mmToPx,
    ampPx: (+entry.amp || 0) * mmToPx,
    variationAmount: +entry.variation || 0,
    envScalePx: (+entry.varScale || 10) * mmToPx,
    sharedSeed: isShared ? [Math.random()*10000, Math.random()*10000] : null,
    sharedEnvSeed: isShared ? [Math.random()*10000, Math.random()*10000] : null,
  };
}
function readGapParams(entry, mmToPx){
  return {
    minLenPx: (+entry.spacing || 30) * mmToPx,
    maxGapPx: (+entry.max || 2) * mmToPx,
  };
}
function applyHatchWobble(segs, spacingPx, ampPx, sharedSeed, variationAmount, envScalePx, sharedEnvSeed){
  const out = [];
  const freq = 1 / Math.max(1e-6, spacingPx*3);   // noise "grid cell" spans ~3 subdivision points
  const envFreq = 1 / Math.max(1e-6, envScalePx); // one envelope cycle spans envScalePx mm
  for (let i=0; i<segs.length; i+=4){
    const x0=segs[i], y0=segs[i+1], x1=segs[i+2], y1=segs[i+3];
    const dx=x1-x0, dy=y1-y0, len=Math.hypot(dx,dy);
    if (ampPx<=0 || spacingPx<=0 || len<1e-6){ out.push([x0,y0,x1,y1]); continue; }
    const ux=dx/len, uy=dy/len, nx=-uy, ny=ux;
    const nSub = Math.max(1, Math.round(len/spacingPx));
    const offX = sharedSeed ? sharedSeed[0] : Math.random()*10000;
    const offY = sharedSeed ? sharedSeed[1] : Math.random()*10000;
    // Separate offset for the envelope noise (a different random patch of
    // the same underlying field) — so "where it wobbles" and "how much it
    // wobbles" vary independently, not always in lockstep.
    const envOffX = sharedEnvSeed ? sharedEnvSeed[0] : Math.random()*10000;
    const envOffY = sharedEnvSeed ? sharedEnvSeed[1] : Math.random()*10000;
    const poly = [];
    for (let k=0; k<=nSub; k++){
      const t = k/nSub;
      const bx = x0+dx*t, by = y0+dy*t;    // point on the straight, un-wobbled segment
      let disp = (hatchNoise2D(bx*freq+offX, by*freq+offY) - 0.5) * ampPx;
      if (variationAmount > 0){
        const env = hatchNoise2D(bx*envFreq+envOffX, by*envFreq+envOffY);
        disp *= 1 - variationAmount*(1-env);   // 0 -> always ×1 (uniform); 1 -> ranges 0..1 (can go fully calm)
      }
      poly.push(bx+nx*disp, by+ny*disp);
    }
    out.push(poly);
  }
  return out;
}
function applyHatchRegularWobble(polylines, familyAngleDeg, amplitudePx, wavelengthPx){
  if (amplitudePx <= 0 || wavelengthPx <= 0) return polylines;
  const rad = familyAngleDeg * Math.PI/180;
  const dirX = Math.cos(rad), dirY = Math.sin(rad);   // family's shared along-line axis
  const nx = -dirY, ny = dirX;                         // perpendicular — same displacement direction as noise wobble
  const targetSpacing = wavelengthPx / 12;              // ~12 samples per wave, so the curve reads smoothly
  const out = [];
  for (const poly of polylines){
    const nPts = poly.length/2;
    if (nPts < 2){ out.push(poly); continue; }
    const newPoly = [];
    for (let i=0; i<nPts-1; i++){
      const x0=poly[i*2], y0=poly[i*2+1], x1=poly[(i+1)*2], y1=poly[(i+1)*2+1];
      const segLen = Math.hypot(x1-x0, y1-y0);
      const nSub = Math.max(1, Math.ceil(segLen/targetSpacing));
      for (let k=(i===0?0:1); k<=nSub; k++){
        const t = k/nSub;
        const bx = x0+(x1-x0)*t, by = y0+(y1-y0)*t;
        const proj = bx*dirX + by*dirY;
        const disp = amplitudePx * Math.sin(2*Math.PI*proj/wavelengthPx);
        newPoly.push(bx+nx*disp, by+ny*disp);
      }
    }
    out.push(newPoly);
  }
  return out;
}
// Constant (non-random) trim/extend applied to both ends of every hatch
// segment before the rest of the texture stack runs. Negative shortens
// each end by |trimPx| (a segment shorter than 2*|trimPx| would invert,
// so it's dropped entirely instead); positive extends each end outward
// by trimPx, unconditionally. carrierIdx is filtered in lockstep with
// segs — dropping a segment must drop its corresponding carrier entry
// too, or applyHatchTexture's index-based lookup would silently
// misattribute every segment after the first dropped one.
function applyHatchTrimExtend(segs, carrierIdx, trimPx){
  if (trimPx === 0) return { segs, carrierIdx };
  const outSegs = [];
  const outCarrier = carrierIdx ? [] : null;
  for (let i = 0, si = 0; i < segs.length; i += 4, si++){
    const x0=segs[i], y0=segs[i+1], x1=segs[i+2], y1=segs[i+3];
    const dx=x1-x0, dy=y1-y0, len=Math.hypot(dx,dy);
    if (len < 1e-6) continue;
    const ux=dx/len, uy=dy/len;
    if (len + 2*trimPx <= 0) continue;   // would collapse/invert — drop entirely
    outSegs.push(x0-ux*trimPx, y0-uy*trimPx, x1+ux*trimPx, y1+uy*trimPx);
    if (outCarrier) outCarrier.push(carrierIdx[si]);
  }
  return { segs: new Float32Array(outSegs), carrierIdx: outCarrier };
}
// Overshoot, spacing jitter and angle jitter, from the layer's stack.
function applyHatchTexture(segs, carrierIdx, familyAngleDeg, mmToPx, stack){
  const overshoot = stackEntry(stack, 'overshoot');
  const spacing = stackEntry(stack, 'spacingJitter');
  const angle = stackEntry(stack, 'angleJitter');
  const overshootOn = !!overshoot, spacingOn = !!spacing, angleOn = !!angle;
  const oMin = overshootOn ? (+overshoot.min || 0) * mmToPx : 0;
  const oMax = overshootOn ? (+overshoot.max || 0) * mmToPx : 0;
  const sMin = spacingOn ? (+spacing.min || 0) * mmToPx : 0;
  const sMax = spacingOn ? (+spacing.max || 0) * mmToPx : 0;
  const aMin = angleOn ? (+angle.min || 0) : 0;
  const aMax = angleOn ? (+angle.max || 0) : 0;
  if (!overshootOn && !spacingOn && !angleOn) return segs;   // all off — skip untouched
  const rad = familyAngleDeg * Math.PI/180;
  const nx = -Math.sin(rad), ny = Math.cos(rad);          // hatch family's shared normal direction
  // One shared jitter draw per unique carrier line — fragments of the same
  // original line (split by occlusion into several visible pieces) move
  // together, rather than each piece scattering independently, which would
  // read as broken debris instead of a shifted/rotated line.
  const carrierJitter = new Map();
  function jitterFor(k){
    let j = carrierJitter.get(k);
    if (j) return j;
    const spacingMag = spacingOn ? sMin + Math.random()*(sMax-sMin) : 0;
    const angleMag = angleOn ? aMin + Math.random()*(aMax-aMin) : 0;
    j = { spacing: spacingMag * (Math.random()<0.5?-1:1), angle: angleMag * (Math.random()<0.5?-1:1) };
    carrierJitter.set(k, j);
    return j;
  }
  const out = new Float32Array(segs.length);
  for (let i=0, si=0; i<segs.length; i+=4, si++){
    let x0=segs[i], y0=segs[i+1], x1=segs[i+2], y1=segs[i+3];
    const j = jitterFor(carrierIdx[si]);
    if (j.angle){
      const mx=(x0+x1)/2, my=(y0+y1)/2;
      const th=j.angle*Math.PI/180, c=Math.cos(th), s=Math.sin(th);
      const rx0=x0-mx, ry0=y0-my, rx1=x1-mx, ry1=y1-my;
      x0=mx+rx0*c-ry0*s; y0=my+rx0*s+ry0*c;
      x1=mx+rx1*c-ry1*s; y1=my+rx1*s+ry1*c;
    }
    if (j.spacing){
      x0+=nx*j.spacing; y0+=ny*j.spacing;
      x1+=nx*j.spacing; y1+=ny*j.spacing;
    }
    if (overshootOn){
      // Signed draw directly from [oMin,oMax] — no separate random sign.
      // Positive extends the endpoint outward (overshoot), negative pulls
      // it inward (undershoot), each endpoint drawn independently.
      const dx=x1-x0, dy=y1-y0, len=Math.hypot(dx,dy) || 1, ux=dx/len, uy=dy/len;
      const maxUndershoot = 0.3 * len;   // cap shortening so both ends can't collapse/invert a short segment
      let m0 = oMin + Math.random()*(oMax-oMin);
      let m1 = oMin + Math.random()*(oMax-oMin);
      if (m0 < -maxUndershoot) m0 = -maxUndershoot;
      if (m1 < -maxUndershoot) m1 = -maxUndershoot;
      x0-=ux*m0; y0-=uy*m0;
      x1+=ux*m1; y1+=uy*m1;
    }
    out[i]=x0; out[i+1]=y0; out[i+2]=x1; out[i+3]=y1;
  }
  return out;
}
// Re-samples a piece's poly at a given (possibly widened/shrunk) angular
// span and/or radius — shared by trim/extend, overshoot/undershoot, and
// spacing jitter below, since all three are "recompute u0/u1 and/or
// radius, then resample the arc," just with different adjustments.
function resampleArcPiece(piece, newU0, newU1, newRadius){
  const { cx, cy } = piece;
  const nSub = Math.max(2, Math.ceil((newU1-newU0)*2*Math.PI*newRadius / 2));
  const poly = [];
  for (let k=0; k<=nSub; k++){
    const u = newU0 + (newU1-newU0)*k/nSub;
    poly.push(cx+newRadius*Math.cos(u*2*Math.PI), cy+newRadius*Math.sin(u*2*Math.PI));
  }
  return { ...piece, poly, u0: newU0, u1: newU1, radius: newRadius };
}
// Extends/trims a piece's two ends ALONG the circle's own path (more arc-
// length at the same radius), not in a straight line — trimPx of linear
// distance corresponds to trimPx/radius radians of additional angular
// span. Only applies to pieces actually cut by shadow clipping (or
// density thinning, which cuts the same way) — a fully-intact ring has no
// real endpoints for this to act on, so it passes through untouched,
// exactly as agreed.
function applyCircleTrimExtend(pieces, trimPx){
  if (trimPx === 0) return pieces;
  const out = [];
  for (const piece of pieces){
    if (piece.closed){ out.push(piece); continue; }
    const du = (trimPx/piece.radius) / (2*Math.PI);
    const newU0 = piece.u0 - du, newU1 = piece.u1 + du;
    if (newU1 - newU0 <= 0) continue;   // would collapse/invert — drop entirely, mirrors hatch's own rule
    out.push(resampleArcPiece(piece, newU0, newU1, piece.radius));
  }
  return out;
}
// Same idea as hatch's own overshoot/undershoot — each end drawn
// independently from [oMin,oMax] (signed: positive extends, negative
// trims), undershoot capped at 30% of the piece's own arc length so it
// can't invert a short arc. Only applies to shadow-cut pieces, same as
// trim/extend above.
function applyCircleOvershootUndershoot(pieces, oMin, oMax){
  if (oMin === 0 && oMax === 0) return pieces;
  const out = [];
  for (const piece of pieces){
    if (piece.closed){ out.push(piece); continue; }
    const arcLen = (piece.u1-piece.u0)*2*Math.PI*piece.radius;
    const maxUndershoot = 0.3*arcLen;
    let m0 = oMin + Math.random()*(oMax-oMin);
    let m1 = oMin + Math.random()*(oMax-oMin);
    if (m0 < -maxUndershoot) m0 = -maxUndershoot;
    if (m1 < -maxUndershoot) m1 = -maxUndershoot;
    const du0 = (m0/piece.radius)/(2*Math.PI), du1 = (m1/piece.radius)/(2*Math.PI);
    const newU0 = piece.u0 - du0, newU1 = piece.u1 + du1;
    if (newU1 - newU0 <= 0) continue;
    out.push(resampleArcPiece(piece, newU0, newU1, piece.radius));
  }
  return out;
}
// Radial equivalent of hatch's per-carrier spacing jitter: one shared
// random radius offset per RING (not per piece — every fragment a single
// ring got split into by shadow/density thinning moves together), applied
// by shifting the whole ring's radius and resampling.
// Keyed by ring index ALONE, deliberately: ring r of the ground set and
// ring r of the model-surface set are not two rings that happen to share a
// number, they are the same circle (same center, same spacing) seen on two
// different receiving surfaces. Keying them apart gave the two halves of
// one ring different radii, which tore it open at exactly the boundary
// mergeRingPieces (worker) now joins. Unlike trim/extend and
// overshoot, this applies to both closed and cut pieces — the user's
// exception was specifically for the two end-focused effects, not this
// one.
function applyCircleSpacingJitter(pieces, sMin, sMax){
  if (sMin === 0 && sMax === 0) return pieces;
  const jitterByRing = new Map();
  function jitterFor(key){
    if (jitterByRing.has(key)) return jitterByRing.get(key);
    const mag = sMin + Math.random()*(sMax-sMin);
    const j = mag * (Math.random()<0.5?-1:1);
    jitterByRing.set(key, j);
    return j;
  }
  const out = [];
  for (const piece of pieces){
    const j = jitterFor(piece.ringIdx);
    if (j === 0){ out.push(piece); continue; }
    const newRadius = Math.max(0.01, piece.radius + j);
    out.push(resampleArcPiece(piece, piece.u0, piece.u1, newRadius));
  }
  return out;
}
// Radial version of applyHatchWobble — same noise field, same envelope-
// variation logic, but displacement direction is "away from center at
// this point" instead of a fixed perpendicular, and position along the
// piece is measured as arc-length (u * circumference) instead of linear
// distance along a straight segment. Returns plain polylines (not
// pieces), matching applyHatchWobble's own output shape, since gaps
// (the next stage) only needs the point data.
function applyCircleWobble(pieces, spacingPx, ampPx, sharedSeed, variationAmount, envScalePx, sharedEnvSeed){
  const out = [];
  const freq = 1 / Math.max(1e-6, spacingPx*3);
  const envFreq = 1 / Math.max(1e-6, envScalePx);
  for (const piece of pieces){
    const { cx, cy, radius, u0, u1 } = piece;
    const arcLen = (u1-u0)*2*Math.PI*radius;
    if (ampPx<=0 || spacingPx<=0 || arcLen<1e-6){ out.push(piece.poly); continue; }
    const nSub = Math.max(1, Math.round(arcLen/spacingPx));
    const offX = sharedSeed ? sharedSeed[0] : Math.random()*10000;
    const offY = sharedSeed ? sharedSeed[1] : Math.random()*10000;
    const envOffX = sharedEnvSeed ? sharedEnvSeed[0] : Math.random()*10000;
    const envOffY = sharedEnvSeed ? sharedEnvSeed[1] : Math.random()*10000;
    const poly = [];
    for (let k=0; k<=nSub; k++){
      const t = k/nSub;
      const u = u0 + (u1-u0)*t;
      const ang = u*2*Math.PI;
      const bx = cx+radius*Math.cos(ang), by = cy+radius*Math.sin(ang);
      const rx = Math.cos(ang), ry = Math.sin(ang);   // radial direction at this point — the "perpendicular" for a circle
      let disp = (hatchNoise2D(bx*freq+offX, by*freq+offY) - 0.5) * ampPx;
      if (variationAmount > 0){
        const env = hatchNoise2D(bx*envFreq+envOffX, by*envFreq+envOffY);
        disp *= 1 - variationAmount*(1-env);
      }
      poly.push(bx+rx*disp, by+ry*disp);
    }
    out.push(poly);
  }
  return out;
}
// Circle-specific gaps — operates directly on the rich piece objects
// (cx, cy, radius, u0, u1) rather than generic polylines. For a perfect
// circle, cumulative arc length from u0 to any u is simply
// (u-u0)*2*PI*radius (linear in u, since arc length is proportional to
// angle at constant radius) — no point-by-point interpolation needed at
// all, unlike the generic polyline case. Reuses the exact same Poisson-
// gap interval generator as applyHatchGaps, just interpreting the
// resulting length-ranges as arc positions. Returns pieces with narrowed
// u0/u1 (radius/cx/cy unchanged, closed forced false since a gap-split
// piece is never a whole intact loop anymore) — still full piece
// objects, so Bezier conversion downstream has everything it needs.
function applyCircleGaps(pieces, minLenPx, maxGapPx){
  if (maxGapPx <= 0 || minLenPx <= 0) return pieces;
  const out = [];
  for (const piece of pieces){
    const { u0, u1, radius } = piece;
    const total = (u1-u0) * 2*Math.PI*radius;
    const gaps = generateGapIntervals(total, minLenPx, maxGapPx);
    if (!gaps){ out.push(piece); continue; }
    const uAt = s => u0 + s/(2*Math.PI*radius);
    let onStart = 0;
    for (const [gs, ge] of gaps){
      if (gs > onStart + 1e-6) out.push({ ...piece, u0: uAt(onStart), u1: uAt(gs), closed: false });
      onStart = ge;
    }
    if (onStart < total - 1e-6) out.push({ ...piece, u0: uAt(onStart), u1: uAt(total), closed: false });
  }
  return out;
}
// Standard circular-arc-to-cubic-Bezier conversion: splits the u0..u1
// span into sub-arcs of at most 90 degrees each (the well-known accuracy
// limit for this formula — verified numerically at ~0.027% max radial
// error at exactly 90 degrees, dropping off sharply for smaller spans),
// using the standard control-point distance k = (4/3)*tan(span/4) along
// each endpoint's tangent direction. Returns an array of {p0,c1,c2,p3}
// segments (each a [x,y] pair) ready to emit as SVG "C" commands.
function arcToBezierSegments(cx, cy, radius, u0, u1){
  const nSeg = Math.max(1, Math.ceil(Math.abs((u1-u0)*2*Math.PI) / (Math.PI/2)));
  const segs = [];
  for (let i=0; i<nSeg; i++){
    const a0 = (u0 + (u1-u0)*i/nSeg) * 2*Math.PI;
    const a1 = (u0 + (u1-u0)*(i+1)/nSeg) * 2*Math.PI;
    const k = (4/3) * Math.tan((a1-a0)/4);
    const p0 = [cx+radius*Math.cos(a0), cy+radius*Math.sin(a0)];
    const p3 = [cx+radius*Math.cos(a1), cy+radius*Math.sin(a1)];
    const c1 = [p0[0] - k*radius*Math.sin(a0), p0[1] + k*radius*Math.cos(a0)];
    const c2 = [p3[0] + k*radius*Math.sin(a1), p3[1] - k*radius*Math.cos(a1)];
    segs.push({ p0, c1, c2, p3 });
  }
  return segs;
}

/* ================= texture stack =================
   applyTextureStack(input, stack, ctx) is the one entry point every layer's
   texture goes through: it walks the layer's stack IN ORDER and hands each
   entry to its implementation for the representation the pieces are in
   right now. Representations ("rep"):
     segments   { segs, carrier }  a hatch layer's flat Float32Array
                [x0,y0,x1,y1,…] and the worker's per-segment carrier index
                (null when absent — the carrier-coherent jitters then skip)
     arcs       { pieces }  Circles pieces {cx, cy, radius, u0, u1, …}
     polylines  { polylines, closed }  flat [x0,y0,x1,y1,…] arrays; closed is
                a per-polyline boolean array, or null for "all open"
   A filter can change the rep (wobble turns segments or arcs into
   polylines). When a filter has no implementation for segments but has one
   for polylines, the segments become 2-point polylines first. A filter
   whose type the layer's geometry doesn't support (ctx.geometry — see
   TEXTURE_FILTERS in layers.js), or that has no implementation for the
   current rep, is skipped. Segments still left at the end become
   polylines; arcs stay arcs (onResult emits them as Béziers).
   Closed paths: a filter that keeps the polylines one-to-one passes
   `closed` through; one that can split a path (gaps) returns closed:null,
   i.e. every output path open, since a gap opens a ring. Only hatch and
   circles call this today; an edge layer's chained polylines could come
   in as rep:'polylines' with their Z flags as `closed`, and with its empty
   stack come back untouched (refactor plan §4e).
   Overshoot, spacing jitter and angle jitter on segments are ONE combined
   step (applyHatchTexture), run where the first of them sits in the stack:
   they share per-carrier random draws and are applied rotate → shift →
   overshoot per segment, so running them as three separate passes would
   change the output. The editor keeps them adjacent (texture-stack.js). */
function segmentsToPolylines(st){
  const polylines = [];
  for (let i = 0; i < st.segs.length; i += 4) polylines.push([st.segs[i], st.segs[i+1], st.segs[i+2], st.segs[i+3]]);
  return { rep: 'polylines', polylines, closed: null };
}
const LINE_JITTER_TYPES = { overshoot: 1, spacingJitter: 1, angleJitter: 1 };
function lineJitter(st, f, ctx, stack){
  if (!st.carrier) return st;
  return { rep: 'segments', segs: applyHatchTexture(st.segs, st.carrier, ctx.familyAngleDeg, ctx.mmToPx, stack), carrier: st.carrier };
}
const TEXTURE_IMPL = {
  trim: {
    segments: (st, f, ctx) => {
      const r = applyHatchTrimExtend(st.segs, st.carrier, (+f.value || 0) * ctx.mmToPx);
      return { rep: 'segments', segs: r.segs, carrier: r.carrierIdx };
    },
    arcs: (st, f, ctx) => ({ rep: 'arcs', pieces: applyCircleTrimExtend(st.pieces, (+f.value || 0) * ctx.mmToPx) }),
  },
  overshoot: {
    segments: lineJitter,
    arcs: (st, f, ctx) => ({ rep: 'arcs', pieces: applyCircleOvershootUndershoot(st.pieces, (+f.min || 0) * ctx.mmToPx, (+f.max || 0) * ctx.mmToPx) }),
  },
  spacingJitter: {
    segments: lineJitter,
    arcs: (st, f, ctx) => ({ rep: 'arcs', pieces: applyCircleSpacingJitter(st.pieces, (+f.min || 0) * ctx.mmToPx, (+f.max || 0) * ctx.mmToPx) }),
  },
  angleJitter: { segments: lineJitter },
  // Wobble displaces points along a line or arc, so the result is a dense
  // polyline — a wobbled arc is no longer a circle.
  wobble: {
    segments: (st, f, ctx) => {
      const wb = readWobbleParams(f, ctx.mmToPx);
      return { rep: 'polylines', closed: null,
        polylines: applyHatchWobble(st.segs, wb.spacingPx, wb.ampPx, wb.sharedSeed, wb.variationAmount, wb.envScalePx, wb.sharedEnvSeed) };
    },
    arcs: (st, f, ctx) => {
      const wb = readWobbleParams(f, ctx.mmToPx);
      return { rep: 'polylines', closed: null,
        polylines: applyCircleWobble(st.pieces, wb.spacingPx, wb.ampPx, wb.sharedSeed, wb.variationAmount, wb.envScalePx, wb.sharedEnvSeed) };
    },
  },
  regularWobble: {
    polylines: (st, f, ctx) => ({ rep: 'polylines', closed: st.closed,
      polylines: applyHatchRegularWobble(st.polylines, ctx.familyAngleDeg, (+f.amp || 0) * ctx.mmToPx, (+f.wavelength || 5) * ctx.mmToPx) }),
  },
  gaps: {
    arcs: (st, f, ctx) => {
      const gp = readGapParams(f, ctx.mmToPx);
      return { rep: 'arcs', pieces: applyCircleGaps(st.pieces, gp.minLenPx, gp.maxGapPx) };
    },
    polylines: (st, f, ctx) => {
      const gp = readGapParams(f, ctx.mmToPx);
      return { rep: 'polylines', closed: null, polylines: applyHatchGaps(st.polylines, gp.minLenPx, gp.maxGapPx) };
    },
  },
};
// ctx: { geometry ('lines' | 'arcs' | null for edge layers), mmToPx,
// familyAngleDeg (lines: the hatch family's angle) }
export function applyTextureStack(input, stack, ctx){
  let st = input;
  let lineJitterDone = false;
  for (const f of stack){
    const impl = TEXTURE_IMPL[f.type];
    if (!impl || !filterSupports(f.type, ctx.geometry)) continue;
    if (LINE_JITTER_TYPES[f.type] && st.rep === 'segments'){
      if (lineJitterDone) continue;     // the combined step already ran for this group
      lineJitterDone = true;
    }
    let run = impl[st.rep];
    if (!run && st.rep === 'segments' && impl.polylines){ st = segmentsToPolylines(st); run = impl.polylines; }
    if (!run) continue;
    st = run(st, f, ctx, stack);
  }
  return st.rep === 'segments' ? segmentsToPolylines(st) : st;
}
// Appends polylines to a path's d tokens, one subpath each, counting them
// into pathStats when given. A polyline whose ends meet (within 0.02px) is
// counted as closed.
function appendTexturedPolylinesD(d, polylines, pathStats){
  for (const poly of polylines){
    const pts = []; for (let i=0;i<poly.length;i+=2) pts.push([poly[i],poly[i+1]]);
    const closed = pts.length>2 && Math.hypot(pts[0][0]-pts[pts.length-1][0], pts[0][1]-pts[pts.length-1][1]) < 0.02;
    if (pathStats) accumulatePathStats(pathStats, closed ? pts.slice(0,-1) : pts, closed);
    d.push('M', poly[0].toFixed(2), poly[1].toFixed(2));
    for (let i = 2; i < poly.length; i += 2) d.push('L', poly[i].toFixed(2), poly[i+1].toFixed(2));
  }
}
export function onResult(m){
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
  content.classList.toggle('blendMultiply', $('blendMultiplyOn').checked);
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
      if (!layerStyle(L.id).on || !pieces || !pieces.length) continue;
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
    const layerOn = layerStyle(L.id).on;
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
  if (firstEverGen) resetPvFitWithRulers();   // first drawing ever shown: fit the whole page, rulers included
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
// lastLiveStats by onResult (only recomputed on an actual solve); the mm
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

/* ================================================================
   Segment path model — the shared representation both export-time
   geometry passes (dash splitting and the margin trim) work on.
   Parses this app's own d-string format (space-separated M/L/C/Z
   tokens — see onResult's path-building above) into subpaths of
   typed SEGMENTS rather than a flat vertex list. The distinction
   matters entirely because of the Circles layer: its arcs are
   emitted as genuine cubic Beziers (see arcToBezierSegments), and
   both passes below have to cut them without ever degrading them
   into polylines. Every operation here is therefore expressed as
   "restrict a segment to a sub-range of its own parameter t", which
   for a cubic is a de Casteljau split — exact, shape-preserving,
   still a cubic — and for a line is plain interpolation.
   A closed subpath keeps `closed:true` and does NOT carry an
   explicit closing segment; callers that need to walk the closing
   edge materialize it via segsWithClose().
   ================================================================ */
function parsePathD(d){
  const tokens = (d || '').trim().split(/\s+/);
  const subpaths = [];
  let cur = null;
  const num = i => parseFloat(tokens[i]);
  for (let i = 0; i < tokens.length; ){
    const t = tokens[i];
    if (t === 'M'){
      cur = { start: [num(i+1), num(i+2)], segs: [], closed: false };
      subpaths.push(cur);
      i += 3;
    } else if (t === 'L'){
      if (cur) cur.segs.push({ t: 'L', p: [num(i+1), num(i+2)] });
      i += 3;
    } else if (t === 'C'){
      if (cur) cur.segs.push({ t: 'C', c1: [num(i+1), num(i+2)], c2: [num(i+3), num(i+4)], p: [num(i+5), num(i+6)] });
      i += 7;
    } else if (t === 'Z' || t === 'z'){
      if (cur) cur.closed = true;
      i += 1;
    } else {
      i += 1;   // unexpected token — skip defensively rather than throw
    }
  }
  return subpaths;
}
// Inverse of parsePathD. Coordinate precision deliberately matches the
// 2 decimals every d-string in this file is already written with
// (onResult's own path building) — in solver-px, 0.01px is a small
// fraction of any plotter's resolution, and re-emitting at a different
// precision than the rest of the pipeline would only make diffs noisy.
// digits: 2 everywhere the path stays in its own (solver-px / block-local)
// units; the one-path-per-pen export writes page mm, where 3 is needed to
// keep the same effective precision (see buildPenPathsExport).
function emitPathD(subpaths, digits = 2){
  const f = n => n.toFixed(digits);
  const out = [];
  for (const sp of subpaths){
    if (!sp.segs.length) continue;
    out.push('M', f(sp.start[0]), f(sp.start[1]));
    for (const s of sp.segs){
      if (s.t === 'C') out.push('C', f(s.c1[0]), f(s.c1[1]), f(s.c2[0]), f(s.c2[1]), f(s.p[0]), f(s.p[1]));
      else out.push('L', f(s.p[0]), f(s.p[1]));
    }
    if (sp.closed) out.push('Z');
  }
  return out.join(' ');
}
// A closed subpath's closing edge is implicit (a bare Z). Both passes
// below need to treat it as a real segment — it carries ink, so it can be
// dashed and it can cross a margin — so materialize it as a plain line
// back to the start point, unless the path already ends there.
function segsWithClose(sp){
  if (!sp.closed || !sp.segs.length) return sp.segs;
  const last = sp.segs[sp.segs.length-1].p;
  if (last[0] === sp.start[0] && last[1] === sp.start[1]) return sp.segs;
  return sp.segs.concat([{ t: 'L', p: sp.start.slice() }]);
}
function lerpPt(a, b, t){ return [a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t]; }
// de Casteljau split at t: the two halves together reproduce the original
// curve exactly (no approximation anywhere in this), each as its own cubic.
function bezSplit(p0, c1, c2, p3, t){
  const a = lerpPt(p0,c1,t), b = lerpPt(c1,c2,t), c = lerpPt(c2,p3,t);
  const d = lerpPt(a,b,t), e = lerpPt(b,c,t);
  const m = lerpPt(d,e,t);
  return { left: [p0,a,d,m], right: [m,e,c,p3] };
}
// The piece of a segment covering parameter range [t0,t1], returned as its
// own start point plus a segment of the SAME type — a cut cubic stays a
// cubic. Splitting off the tail first reparametrizes [0,t1] onto [0,1],
// which is why t0 has to be rescaled by t1 for the second cut.
function segSub(p0, seg, t0, t1){
  if (seg.t === 'C'){
    let pts = [p0, seg.c1, seg.c2, seg.p];
    if (t1 < 1) pts = bezSplit(pts[0],pts[1],pts[2],pts[3], t1).left;
    if (t0 > 0){
      const tt = t1 > 1e-12 ? Math.min(1, t0/Math.min(1,t1)) : 0;
      pts = bezSplit(pts[0],pts[1],pts[2],pts[3], tt).right;
    }
    return { start: pts[0], seg: { t:'C', c1: pts[1], c2: pts[2], p: pts[3] } };
  }
  return { start: lerpPt(p0, seg.p, t0), seg: { t:'L', p: lerpPt(p0, seg.p, t1) } };
}
// Arc-length table for one segment: exact for a line, sampled for a cubic
// (sample count scaled off the control polygon, which bounds the true arc
// length from above). Used only to convert a dash DISTANCE into a curve
// parameter — a stray fraction of a percent there shifts a dash boundary
// by a hair and nothing else, so sampling is entirely adequate.
const BEZ_LENGTH_SAMPLES_PER_PX = 0.5, BEZ_LENGTH_SAMPLES_MIN = 8, BEZ_LENGTH_SAMPLES_MAX = 64;
function segLengthTable(p0, seg){
  if (seg.t === 'L'){
    const total = Math.hypot(seg.p[0]-p0[0], seg.p[1]-p0[1]);
    return { total, tAt: s => total > 1e-12 ? Math.max(0, Math.min(1, s/total)) : 0 };
  }
  const poly = Math.hypot(seg.c1[0]-p0[0], seg.c1[1]-p0[1]) +
               Math.hypot(seg.c2[0]-seg.c1[0], seg.c2[1]-seg.c1[1]) +
               Math.hypot(seg.p[0]-seg.c2[0], seg.p[1]-seg.c2[1]);
  const n = Math.max(BEZ_LENGTH_SAMPLES_MIN, Math.min(BEZ_LENGTH_SAMPLES_MAX, Math.ceil(poly*BEZ_LENGTH_SAMPLES_PER_PX)));
  const ts = [0], ls = [0];
  let prev = p0, acc = 0;
  for (let k=1; k<=n; k++){
    const t = k/n, v = 1-t;
    const x = v*v*v*p0[0] + 3*v*v*t*seg.c1[0] + 3*v*t*t*seg.c2[0] + t*t*t*seg.p[0];
    const y = v*v*v*p0[1] + 3*v*v*t*seg.c1[1] + 3*v*t*t*seg.c2[1] + t*t*t*seg.p[1];
    acc += Math.hypot(x-prev[0], y-prev[1]);
    ts.push(t); ls.push(acc);
    prev = [x,y];
  }
  return {
    total: acc,
    tAt(s){
      if (acc <= 1e-12) return 0;
      const target = Math.max(0, Math.min(acc, s));
      let i = 1;
      while (i < ls.length-1 && ls[i] < target) i++;
      const span = ls[i] - ls[i-1];
      const f = span > 1e-12 ? (target - ls[i-1]) / span : 0;
      return ts[i-1] + (ts[i]-ts[i-1])*f;
    },
  };
}
// Layout-tab equivalent of the inline segment/path accumulation onResult
// does per-layer via accumulatePathStats — Layout only has each block's
// already-frozen, already-merged d-string to work from (not the raw
// per-edge segments), so it needs its own self-contained walk over the
// d-string tokens instead. Handles M/L/Z (everything but Circles) and C
// (Circles layer, emitted as cubic-Bezier arcs — see arcToBezierSegments)
// tokens. Arc length for C is approximated by sampling the cubic Bezier at
// a handful of points, which is plenty accurate for a stats readout.
// inkFraction: fraction of the geometric length that's actually pen-down
// for this d-string's dash setting (see dashOnFraction in main.js) —
// applied as a flat multiplier at the end since it's uniform across the
// whole d-string (one dash setting per layer, not per-segment).
const D_STATS_BEZIER_SAMPLES = 8;
export function computeDStats(d, inkFraction){
  const out = { segments: 0, paths: 0, closedPaths: 0, lenPx: 0 };
  const tokens = d.trim().split(/\s+/);
  let cur = null, start = null;
  for (let i = 0; i < tokens.length; ){
    const t = tokens[i];
    if (t === 'M'){
      cur = [parseFloat(tokens[i+1]), parseFloat(tokens[i+2])];
      start = cur;
      out.paths++;
      i += 3;
    } else if (t === 'L'){
      const p = [parseFloat(tokens[i+1]), parseFloat(tokens[i+2])];
      out.segments++;
      out.lenPx += Math.hypot(p[0]-cur[0], p[1]-cur[1]);
      cur = p;
      i += 3;
    } else if (t === 'C'){
      const c1 = [parseFloat(tokens[i+1]), parseFloat(tokens[i+2])];
      const c2 = [parseFloat(tokens[i+3]), parseFloat(tokens[i+4])];
      const p3 = [parseFloat(tokens[i+5]), parseFloat(tokens[i+6])];
      out.segments++;
      let prev = cur;
      for (let s = 1; s <= D_STATS_BEZIER_SAMPLES; s++){
        const u = s / D_STATS_BEZIER_SAMPLES, v = 1 - u;
        const x = v*v*v*cur[0] + 3*v*v*u*c1[0] + 3*v*u*u*c2[0] + u*u*u*p3[0];
        const y = v*v*v*cur[1] + 3*v*v*u*c1[1] + 3*v*u*u*c2[1] + u*u*u*p3[1];
        out.lenPx += Math.hypot(x-prev[0], y-prev[1]);
        prev = [x, y];
      }
      cur = p3;
      i += 7;
    } else if (t === 'Z' || t === 'z'){
      if (cur && start && (cur[0] !== start[0] || cur[1] !== start[1])){
        out.lenPx += Math.hypot(start[0]-cur[0], start[1]-cur[1]);
      }
      out.closedPaths++;
      cur = start;
      i += 1;
    } else {
      i += 1;   // unexpected token — skip defensively rather than throw
    }
  }
  out.lenPx *= (inkFraction === undefined ? 1 : inkFraction);
  return out;
}
// Splits a dashed path into real geometry: only the "on" portions of the
// dash/gap pattern survive, each as its own subpath, so a plotter reads
// genuine pen-up gaps instead of a solid line styled to LOOK dashed.
// The pattern restarts at the beginning of every subpath — matching native
// SVG stroke-dasharray behavior exactly, rather than continuing across the
// (pen-up) gap between two already-disconnected subpaths.
// Walks the segment model above rather than a flat vertex list, so a
// Circles-layer arc on a dashed pen survives as a series of shorter ARCS.
// (The previous vertex-list version simply had no case for a C token and
// skipped straight past it, so a dashed Circles layer exported as a set of
// bare M points with no ink between them at all — the whole layer silently
// vanished from the file. Nothing else emits curves, which is why it went
// unnoticed for so long.) A closed subpath's closing edge is dashed like
// any other segment via segsWithClose(); the resulting dash pieces are all
// open by nature, so nothing is ever re-emitted with a Z.
// pattern is the FULL dash/gap list ([dash, gap, dash, gap, ...], in the
// path's own units — i.e. exactly what its stroke-dasharray says), walked
// cyclically. An earlier version took only the first dash/gap pair, so any
// pattern using a second or third pair exported differently from what the
// preview drew. A 0 gap between two dashes simply joins them into one run
// (the continuation check below); a 0-length dash never emits anything.
function splitDashedPathD(d, pattern){
  if (pattern.length % 2) pattern = pattern.concat(pattern);   // SVG's own rule for an odd-length dasharray
  let period = 0;
  const runs = [];            // [offset within one period, length] of every "on" run
  for (let i = 0; i + 1 < pattern.length; i += 2){
    if (pattern[i] > 1e-6) runs.push([period, pattern[i]]);
    period += pattern[i] + pattern[i+1];
  }
  if (!(period > 1e-6) || !runs.length) return d;   // degenerate pattern — leave unchanged
  const out = [];
  for (const sp of parsePathD(d)){
    const segs = segsWithClose(sp);
    if (!segs.length) continue;
    let p0 = sp.start;
    let pos = 0;               // distance from this subpath's own start — the dash phase
    let cur = null, curEnd = 0;
    const flush = () => { if (cur && cur.segs.length) out.push(cur); cur = null; };
    for (const seg of segs){
      const tbl = segLengthTable(p0, seg);
      const L = tbl.total;
      if (L > 1e-9){
        for (let k = Math.floor(pos/period); k*period < pos + L - 1e-9; k++){
          for (const [off, len] of runs){
            const onStart = k*period + off, onEnd = onStart + len;
            if (onStart >= pos + L - 1e-9) break;
            const s = Math.max(onStart, pos), e = Math.min(onEnd, pos + L);
            if (e <= s + 1e-9) continue;
            const sub = segSub(p0, seg, tbl.tAt(s-pos), tbl.tAt(e-pos));
            if (cur && Math.abs(s - curEnd) < 1e-9) cur.segs.push(sub.seg);   // same "on" run continuing across a segment join (or a 0 gap)
            else { flush(); cur = { start: sub.start, segs: [sub.seg], closed: false }; }
            curEnd = e;
          }
        }
      }
      pos += L;
      p0 = seg.p;
    }
    flush();
  }
  return emitPathD(out);
}

/* ================================================================
   Trim to margins — the export-only clip behind the "Trim SVG export
   to margins" checkbox. Runs on the export CLONE as the very last
   geometry step (after dash splitting, so each dash piece is clipped
   individually and the dash rhythm matches what the preview showed),
   and never touches the live document: on screen the same result is
   only simulated, by masking the band outside the margins in the page
   colour (see syncPreviewTrimMask/syncLayoutTrimMask).

   Clipping happens in each path's OWN local coordinate system, not in
   page-mm space: the margin rectangle is mapped backwards through the
   path's accumulated transform instead. That keeps every surviving
   coordinate in the units it was authored in, leaves the ancestor
   translate/scale transforms (and therefore the mm-anchored stroke
   widths that depend on them — see applyLayerStyle) completely
   untouched, and means a fully-inside path can be left byte-for-byte
   as it was. A rotated Layout block simply turns the rectangle into a
   rotated one in local space, which is still four half-planes, so
   rotation needs no special case.

   Half-plane clipping is exact for both segment types: a line's
   signed distance to a clip line is linear in t, and a cubic's is a
   cubic in t (signed distance is affine in the point, the point is a
   cubic in t), so the crossings are true roots and the surviving
   pieces are de Casteljau splits — curves stay curves.
   ================================================================ */
const MAT_IDENTITY = { a:1, b:0, c:0, d:1, e:0, f:0 };
// Applies q first, then p — the order an SVG transform chain composes in
// when walking from an ancestor down to the element.
function matMul(p, q){
  return {
    a: p.a*q.a + p.c*q.b,
    b: p.b*q.a + p.d*q.b,
    c: p.a*q.c + p.c*q.d,
    d: p.b*q.c + p.d*q.d,
    e: p.a*q.e + p.c*q.f + p.e,
    f: p.b*q.e + p.d*q.f + p.f,
  };
}
function matApply(m, p){ return [m.a*p[0] + m.c*p[1] + m.e, m.b*p[0] + m.d*p[1] + m.f]; }
function matInvert(m){
  const det = m.a*m.d - m.b*m.c;
  if (Math.abs(det) < 1e-12) return null;
  return {
    a:  m.d/det, b: -m.b/det,
    c: -m.c/det, d:  m.a/det,
    e: (m.c*m.f - m.d*m.e)/det,
    f: (m.b*m.e - m.a*m.f)/det,
  };
}
// Deliberately a plain text parse rather than SVGGraphicsElement.transform
// /getCTM(): the element being measured lives in a DETACHED clone that was
// never inserted into the document, where the DOM's own matrix plumbing is
// not dependable across engines. Everything it has to understand is written
// by this codebase itself (translate/scale/rotate, see updateBlockTransform
// and renderPaper), with matrix/skew accepted for completeness.
function parseTransformAttr(str){
  let m = MAT_IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let hit;
  while ((hit = re.exec(str))){
    const v = hit[2].trim().split(/[\s,]+/).map(parseFloat);
    const n = i => (isFinite(v[i]) ? v[i] : 0);
    let t = MAT_IDENTITY;
    if (hit[1] === 'matrix') t = { a:n(0), b:n(1), c:n(2), d:n(3), e:n(4), f:n(5) };
    else if (hit[1] === 'translate') t = { a:1, b:0, c:0, d:1, e:n(0), f:v.length>1 ? n(1) : 0 };
    else if (hit[1] === 'scale'){ const sx = n(0), sy = v.length>1 ? n(1) : sx; t = { a:sx, b:0, c:0, d:sy, e:0, f:0 }; }
    else if (hit[1] === 'rotate'){
      const th = n(0)*Math.PI/180, cos = Math.cos(th), sin = Math.sin(th);
      t = { a:cos, b:sin, c:-sin, d:cos, e:0, f:0 };
      if (v.length >= 3){        // rotate(angle cx cy) — translate to the pivot, rotate, translate back
        const cx = n(1), cy = n(2);
        t = matMul(matMul({ a:1,b:0,c:0,d:1,e:cx,f:cy }, t), { a:1,b:0,c:0,d:1,e:-cx,f:-cy });
      }
    }
    else if (hit[1] === 'skewX') t = { a:1, b:0, c:Math.tan(n(0)*Math.PI/180), d:1, e:0, f:0 };
    else if (hit[1] === 'skewY') t = { a:1, b:Math.tan(n(0)*Math.PI/180), c:0, d:1, e:0, f:0 };
    m = matMul(m, t);
  }
  return m;
}
// Element -> root user space (the viewBox space, which for both #plot and
// #layoutPlot IS page mm — see renderPaper/syncLayoutPaperFrame, both of
// which set "0 0 paperW paperH"). The root's own attributes are excluded,
// since the viewBox mapping is exactly what makes that space mm in the
// first place.
function ctmWithinRoot(el, root){
  const chain = [];
  for (let n = el; n && n !== root; n = n.parentNode) chain.push(n);
  let m = MAT_IDENTITY;
  for (let i = chain.length-1; i >= 0; i--){
    const t = chain[i].getAttribute && chain[i].getAttribute('transform');
    if (t) m = matMul(m, parseTransformAttr(t));
  }
  return m;
}
// The margin rectangle expressed as four inward half-planes in some path's
// own local space. value(p) >= 0 means "inside" for all four. The inward
// direction is taken from the mapped rectangle's own centroid rather than
// from a winding assumption, so a mirroring transform can't quietly invert
// the whole test and clip away precisely the wrong half.
function marginHalfPlanes(dims, inv){
  const x0 = dims.margin.left, y0 = dims.margin.top;
  const x1 = Math.max(x0, dims.paperW - dims.margin.right);
  const y1 = Math.max(y0, dims.paperH - dims.margin.bottom);
  const q = [[x0,y0],[x1,y0],[x1,y1],[x0,y1]].map(p => matApply(inv, p));
  const cx = (q[0][0]+q[1][0]+q[2][0]+q[3][0])/4, cy = (q[0][1]+q[1][1]+q[2][1]+q[3][1])/4;
  const planes = [];
  for (let i=0; i<4; i++){
    const a = q[i], b = q[(i+1)%4];
    let nx = -(b[1]-a[1]), ny = b[0]-a[0];
    const len = Math.hypot(nx, ny);
    if (len < 1e-12) return null;             // degenerate mapping — caller leaves the path alone
    nx /= len; ny /= len;
    let c = -(nx*a[0] + ny*a[1]);
    if (nx*cx + ny*cy + c < 0){ nx = -nx; ny = -ny; c = -c; }
    planes.push({ nx, ny, c });
  }
  return planes;
}
// Roots of a cubic given in Bernstein form, found by splitting [0,1] at the
// derivative's own roots (so every piece is monotonic) and bisecting the
// pieces that change sign. Deliberately not the closed-form cubic solution:
// the analytic formula's near-degenerate cases (triple roots, a vanishing
// leading coefficient — both entirely ordinary here, since a straight-ish
// arc or a curve tangent to a margin produces exactly those) need careful
// handling to stay accurate, while monotonic bisection is unconditionally
// stable and still lands within ~1e-15 after the iterations below.
const CUBIC_BISECT_ITERS = 60;
function cubicRootsInUnit(b0, b1, b2, b3){
  const a0 = b0, a1 = 3*(b1-b0), a2 = 3*(b2 - 2*b1 + b0), a3 = b3 - 3*b2 + 3*b1 - b0;
  const f = t => ((a3*t + a2)*t + a1)*t + a0;
  const crit = [];
  const A = 3*a3, B = 2*a2, C = a1;
  if (Math.abs(A) < 1e-12){
    if (Math.abs(B) > 1e-12){ const t = -C/B; if (t > 0 && t < 1) crit.push(t); }
  } else {
    const disc = B*B - 4*A*C;
    if (disc > 0){
      const s = Math.sqrt(disc);
      for (const t of [(-B-s)/(2*A), (-B+s)/(2*A)]) if (t > 0 && t < 1) crit.push(t);
    }
  }
  crit.sort((x,y) => x-y);
  const knots = [0, ...crit, 1];
  const roots = [];
  for (let i=0; i<knots.length-1; i++){
    let lo = knots[i], hi = knots[i+1];
    let flo = f(lo), fhi = f(hi);
    if (flo === 0) roots.push(lo);
    if (flo*fhi < 0){
      for (let k=0; k<CUBIC_BISECT_ITERS; k++){
        const mid = (lo+hi)/2, fm = f(mid);
        if (flo*fm <= 0){ hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
      }
      roots.push((lo+hi)/2);
    }
  }
  return { f, roots };
}
// The sub-ranges of one segment's parameter that lie inside a half-plane.
function segInsideIntervals(p0, seg, hp){
  const val = p => hp.nx*p[0] + hp.ny*p[1] + hp.c;
  if (seg.t === 'L'){
    const f0 = val(p0), f1 = val(seg.p);
    if (f0 >= 0 && f1 >= 0) return [[0,1]];
    if (f0 < 0 && f1 < 0) return [];
    const t = f0/(f0-f1);
    return f0 >= 0 ? [[0,t]] : [[t,1]];
  }
  const b0 = val(p0), b1 = val(seg.c1), b2 = val(seg.c2), b3 = val(seg.p);
  // Convex hull property: a Bezier never leaves its control polygon's hull,
  // so all-four-inside (or all-four-outside) settles the whole curve without
  // touching the root finder.
  if (b0 >= 0 && b1 >= 0 && b2 >= 0 && b3 >= 0) return [[0,1]];
  if (b0 < 0 && b1 < 0 && b2 < 0 && b3 < 0) return [];
  const { f, roots } = cubicRootsInUnit(b0, b1, b2, b3);
  const knots = [0, ...roots.filter(r => r > 1e-12 && r < 1-1e-12), 1];
  const out = [];
  for (let i=0; i<knots.length-1; i++){
    const a = knots[i], b = knots[i+1];
    if (b - a < 1e-12) continue;
    if (f((a+b)/2) < 0) continue;
    if (out.length && Math.abs(out[out.length-1][1] - a) < 1e-12) out[out.length-1][1] = b;   // merge across a tangential touch
    else out.push([a, b]);
  }
  return out;
}
// One subpath clipped against one half-plane -> zero or more subpaths.
function clipSubpathHalfPlane(sp, hp){
  const segs = segsWithClose(sp);
  if (!segs.length) return [];
  const EPS = 1e-9;
  // Wholly-inside fast path, and the ONLY way a closed subpath survives as
  // a closed one: returning the very same object (identity, not a copy) is
  // what lets the caller recognize "nothing was cut here" and re-emit the
  // original d-data untouched, Z and all, instead of rebuilding it.
  const val = p => hp.nx*p[0] + hp.ny*p[1] + hp.c;
  let allIn = val(sp.start) >= 0;
  for (const s of segs){
    if (!allIn) break;
    if (s.t === 'C') allIn = val(s.c1) >= 0 && val(s.c2) >= 0 && val(s.p) >= 0;
    else allIn = val(s.p) >= 0;
  }
  if (allIn) return [sp];
  const out = [];
  let cur = null, p0 = sp.start;
  // Tracked as the piece OBJECTS themselves rather than as flags, so the
  // closed-path rejoin below can compare identity against what actually
  // survived: a run reaching the seam can still be dropped as a sliver by
  // the length filter, and a flag would then rejoin the wrong two pieces.
  let headPiece = null, tailPiece = null;
  // A path that merely grazes a margin (or whose dash piece ends exactly on
  // one) yields a piece of no length at all. It isn't nothing on a plotter:
  // with stroke-linecap:round a zero-length stroke is a visible dot of ink
  // the size of the nib, so these are dropped rather than exported. The
  // threshold is half the precision emitPathD writes at — below that a piece
  // cannot even be represented as two distinct points in the file.
  const CLIP_MIN_PIECE = 0.005;
  const pieceLen = piece => {
    let total = 0, q = piece.start;
    for (const s of piece.segs){ total += Math.hypot(s.p[0]-q[0], s.p[1]-q[1]); q = s.p; }
    return total;
  };
  const flush = () => { if (cur && cur.segs.length && pieceLen(cur) > CLIP_MIN_PIECE) out.push(cur); cur = null; };
  for (let i=0; i<segs.length; i++){
    const seg = segs[i];
    const ivs = segInsideIntervals(p0, seg, hp);
    if (!ivs.length) flush();
    for (const [ta, tb] of ivs){
      if (ta > EPS) flush();          // a gap in the ink before this piece — previous run ends here
      const sub = segSub(p0, seg, ta, tb);
      if (!cur){
        cur = { start: sub.start, segs: [], closed: false };
        if (i === 0 && ta <= EPS) headPiece = cur;
      }
      cur.segs.push(sub.seg);
      tailPiece = (i === segs.length-1 && tb >= 1-EPS) ? cur : null;
      if (tb < 1-EPS) flush();
    }
    p0 = seg.p;
  }
  flush();
  // A closed path cut open still shouldn't be reported as two strokes when
  // the cut fell somewhere other than its own start point: the run that ends
  // at the seam and the run that begins there are one continuous stroke, so
  // rejoin them (the start point is only an artifact of where the d-string
  // happened to begin).
  if (sp.closed && out.length > 1 && out[0] === headPiece && out[out.length-1] === tailPiece){
    const last = out.pop();
    out[0] = { start: last.start, segs: last.segs.concat(out[0].segs), closed: false };
  }
  return out;
}
// Clips one d-string against the margin rectangle, seen from `inv` (the
// inverse of that path's own accumulated transform). Returns null when the
// whole path is inside and nothing needs rewriting, '' when nothing of it
// survives at all.
function clipPathDToMargins(d, dims, inv){
  const planes = marginHalfPlanes(dims, inv);
  if (!planes) return null;
  const subpaths = parsePathD(d);
  if (!subpaths.length) return null;
  let changed = false;
  const out = [];
  for (const sp of subpaths){
    let pieces = [sp];
    for (const hp of planes){
      const next = [];
      for (const piece of pieces) next.push(...clipSubpathHalfPlane(piece, hp));
      pieces = next;
      if (!pieces.length) break;
    }
    // Untouched is the common case (a drawing that fits inside its own
    // margins) and is worth detecting explicitly: clipSubpathHalfPlane
    // hands back the identical object when a subpath is wholly inside a
    // plane, so surviving all four unchanged means nothing was cut and the
    // ORIGINAL data is kept rather than a re-rounded rebuild of it.
    if (pieces.length === 1 && pieces[0] === sp){
      out.push(sp);
    } else {
      changed = true;
      for (const piece of pieces) out.push(piece);   // push, not concat: a hatch layer runs this tens of thousands of times
    }
  }
  if (!changed) return null;
  return emitPathD(out);
}
// Applies the trim to every path in an export clone. dims is whichever
// paper description the export is built from — computePaperLayout() for
// Preview, computeLayoutPaperDims() for Layout; both carry paperW/paperH/
// margin in mm, which is all this needs.
function trimCloneToMargins(root, dims){
  root.querySelectorAll('path').forEach(p => {
    const inv = matInvert(ctmWithinRoot(p, root));
    if (!inv) return;                       // collapsed transform — nothing sane to clip against, leave it
    const d = clipPathDToMargins(p.getAttribute('d') || '', dims, inv);
    if (d === null) return;                 // entirely inside — untouched
    if (d) p.setAttribute('d', d);
    else p.remove();                        // entirely outside the margins — never exported
  });
}

/* ================= one path per pen (export) =================
   The export used while "Export one path per pen" (Pen library tab) is on:
   instead of cloning the on-screen SVG, a fresh file is built holding ONE
   <path> per pen that has visible ink — no groups, no transforms — so an
   importer that makes one object per path (Blender's) gets one object per
   pen, and everything for one pen plots in a single run. Nothing on screen
   is touched.
   Each visible layer's path (Preview: #g_<key> in #plot; Layout: every
   visible block's visible layer groups) goes through the same per-path
   steps the ordinary export applies, in the path's OWN units — dash split
   from its own stroke-dasharray (always: a pen's one path can mix solid
   and dashed layers, so dashes must be real geometry), then the margin
   trim — and only then is baked into page mm through its transform chain
   (ctmWithinRoot, the same matrix the trim already uses). Baking is exact
   for curves too: an affine map of a cubic's control points is that
   cubic's image. Subpaths are appended in paint order (Preview: fills
   first, silhouette last; Layout: blocks bottom to top, same layer order
   within each), so that is also the plot order within a pen.
   Coordinates are written with 3 decimals: page mm is a much coarser unit
   than the solver-px the ordinary export writes at 2.
   A pen's id is its 1-based library position (zero-padded to at least two
   digits, so ids sort in library order as plain text) plus its name with
   anything outside [A-Za-z0-9_.-] replaced — "pen05_Blue_0.2". The "pen"
   prefix keeps it a valid XML id (which can't start with a digit), and the
   number alone keeps every id unique. Blender names each imported curve
   after it. */
function penExportId(pen){
  const digits = Math.max(2, String(PEN_LIBRARY.length).length);
  const n = String(PEN_LIBRARY.indexOf(pen) + 1).padStart(digits, '0');
  return 'pen' + n + '_' + pen.name.replace(/[^A-Za-z0-9_.-]/g, '_');
}
function buildPenPathsExport(isLayout, dims){
  // Every visible layer group, in paint order, with the pen it draws with.
  const sources = [];
  if (isLayout){
    const root = $('layoutPlot');
    for (const block of blocks){
      if (!block.visible) continue;
      // Same guard renderPreviewLayoutOverlay uses; refreshing the style
      // makes sure the stroke-dasharray read below is the current one.
      if (!block.dom) createBlockDom(block); else updateBlockStyle(block);
      for (const L of layers.slice().reverse()){
        const g = block.dom.layerGroups[L.id];
        if (!g || !block.layerVisible[L.id]) continue;
        sources.push({ g, root, pen: penById(blockLayerPenId(block, L.id)) });
      }
    }
  } else {
    const root = $('plot');
    for (const L of layers.slice().reverse()){
      const g = document.getElementById('g_' + L.id);
      if (!g || !L.on) continue;
      sources.push({ g, root, pen: penById(L.pen) });
    }
  }
  const trim = $('trimToMargins').checked;
  const byPen = new Map();   // pen object -> its subpaths in page mm, in paint order
  for (const { g, root, pen } of sources){
    const dash = g.getAttribute('stroke-dasharray');
    const pattern = dash ? dash.trim().split(/[\s,]+/).map(Number) : null;
    for (const p of g.querySelectorAll('path')){
      let d = p.getAttribute('d') || '';
      if (pattern) d = splitDashedPathD(d, pattern);
      const m = ctmWithinRoot(p, root);
      if (trim){
        const inv = matInvert(m);
        if (inv){
          const clipped = clipPathDToMargins(d, dims, inv);
          if (clipped !== null) d = clipped;   // null = entirely inside, untouched
        }
      }
      if (!d) continue;                        // dashed or trimmed away entirely
      if (!byPen.has(pen)) byPen.set(pen, []);
      const out = byPen.get(pen);
      // A plain loop rather than push(...array): a hatch layer can hold far
      // more subpaths than a spread argument list is allowed to.
      for (const sp of parsePathD(d)){
        out.push({
          start: matApply(m, sp.start),
          segs: sp.segs.map(s => s.t === 'C'
            ? { t: 'C', c1: matApply(m, s.c1), c2: matApply(m, s.c2), p: matApply(m, s.p) }
            : { t: 'L', p: matApply(m, s.p) }),
          closed: sp.closed,
        });
      }
    }
  }
  const svg = svgEl('svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('width',  dims.paperW.toFixed(2) + 'mm');
  svg.setAttribute('height', dims.paperH.toFixed(2) + 'mm');
  svg.setAttribute('viewBox', '0 0 ' + dims.paperW.toFixed(3) + ' ' + dims.paperH.toFixed(3));
  for (const pen of PEN_LIBRARY){
    const subpaths = byPen.get(pen);
    const d = subpaths ? emitPathD(subpaths, 3) : '';
    if (!d) continue;                          // this pen has no visible ink — no path at all
    const path = svgEl('path');
    path.setAttribute('id', penExportId(pen));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', pen.color);
    path.setAttribute('stroke-width', String(pen.width));
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/* ================= layer rows (Lines tab) =================
   One row per layer instance, built from `layers` (layers.js) at boot and
   again whenever the list itself changes — a scene import, or the user
   adding, duplicating, deleting or reordering a fill layer. A row is a
   VIEW: its controls write straight into the instance, and applyLayerStyle
   renders the instance back into the row.
   An edge row is the plain five-column .layer grid (checkbox, swatch,
   name, pen, dash). A fill row adds a disclosure triangle in front and
   duplicate/delete buttons at the end, and owns a settings panel beneath
   it holding that layer's own solve settings (its type's `settings`
   schema), shown while the row is expanded. One row at a time is
   expanded; the circles centre gizmo follows the expanded layer.
   Fill rows can be dragged to reorder among themselves; edge rows keep
   the fixed hierarchy above them. Order is drawing priority and, for the
   hatch passes, the order the shared segment cap runs out in, so a
   reorder re-solves. */
let expandedId = null;
export function expandedLayerId(){ return expandedId; }
// Every fill row's settings sliders, by layer id then setting key, so the
// gizmo / a paper change / the Soft shadows toggle can refresh them
// without rebuilding the rows.
const fillRowEls = {};
// Half the page in each axis — the range of a circles centre slider.
function paperHalf(axis){
  const layout = computePaperLayout();
  if (!layout) return 150;
  return (axis === 'w' ? layout.paperW : layout.paperH) / 2;
}
function settingRange(spec){
  return spec.paperHalf ? { min: -paperHalf(spec.paperHalf), max: paperHalf(spec.paperHalf) } : { min: spec.min, max: spec.max };
}
// Pushes a layer's stored values back into its own sliders (after a gizmo
// drag, or a paper change that rescaled a centre).
export function syncFillRowValues(id){
  const els = fillRowEls[id], L = layerById(id);
  if (!els || !L) return;
  for (const key in els){ els[key].input.value = L[key]; els[key].refresh(); }
}
// Re-applies every circles centre slider's range after a paper change.
export function syncFillRowRanges(){
  for (const L of layers){
    const els = fillRowEls[L.id];
    if (!els) continue;
    for (const spec of layerType(L).settings || []){
      const el = els[spec.key];
      if (!el || !spec.paperHalf) continue;
      const r = settingRange(spec);
      el.input.min = r.min; el.input.max = r.max;
      L[spec.key] = Math.min(r.max, Math.max(r.min, L[spec.key]));
      el.input.value = L[spec.key];
      el.refresh();
    }
  }
}
// Dims every "below" threshold slider while Soft shadows is off, the same
// .ctlDisabled treatment the shadow controls get — fillPasses forces those
// thresholds to 0, so the sliders are genuinely inert.
export function syncFillRowSoftState(){
  const on = $('softShadows').checked;
  for (const id in fillRowEls)
    for (const key in fillRowEls[id]){
      const el = fillRowEls[id][key];
      if (el.spec.soft) el.ctl.classList.toggle('ctlDisabled', !on);
    }
}
// The settings panel under one fill row: a .ctl slider per entry in the
// type's schema, each writing its own field on the instance.
function buildFillSettings(L){
  const wrap = document.createElement('div');
  wrap.className = 'layerSettings';
  wrap.hidden = L.id !== expandedId;
  const els = {};
  for (const spec of layerType(L).settings){
    const id = 'ls_' + L.id + '_' + spec.key;
    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = spec.label;
    const input = document.createElement('input');
    input.type = 'range'; input.id = id; input.step = spec.step;
    const r = settingRange(spec);
    input.min = r.min; input.max = r.max;
    input.value = L[spec.key];
    const val = document.createElement('span');
    val.className = 'val';
    const refresh = () => { val.textContent = formatValue(spec, input.value); };
    refresh();
    input.addEventListener('input', () => {
      L[spec.key] = +input.value;
      refresh();
      markStale();
      if (spec.paperHalf) updateTextureGizmo();   // the centre moved
    });
    makeSliderValueEditable(input, val, spec, refresh);
    ctl.append(label, input, val);
    wrap.appendChild(ctl);
    els[spec.key] = { input, val, ctl, spec, refresh };
  }
  fillRowEls[L.id] = els;
  return wrap;
}
// Everything that has to happen when the LIST changes (add, duplicate,
// delete, reorder): rows rebuilt, the texture tab's layer picker refilled,
// the gizmo re-pointed, and a re-solve, since order and membership both
// change what the worker draws.
function fillLayersChanged(){
  buildLayerRows();
  renderTextureStack();
  updateTextureGizmo();
  markStale();
  refreshStatusR();
}
function addFillLayer(type){
  layers.push(newFillLayer(type, nextFillId(), { on: true }));
  expandedId = layers[layers.length-1].id;
  fillLayersChanged();
}
function duplicateFillLayer(L){
  const copy = copyLayer(L, nextFillId());
  layers.splice(layers.indexOf(L) + 1, 0, copy);
  expandedId = copy.id;
  fillLayersChanged();
}
function deleteFillLayer(L){
  layers.splice(layers.indexOf(L), 1);
  if (expandedId === L.id) expandedId = null;
  delete fillRowEls[L.id];
  // Its geometry is still in the live SVG until the next solve.
  const g = document.getElementById('g_' + L.id);
  if (g) g.remove();
  fillLayersChanged();
}
/* Drag-reorder among fill rows — the same gesture and feedback as the
   Layout blocks list (see its own handler in layout-canvas.js): plain
   pointer events rather than native drag-and-drop, the dragged row dimmed
   in place, and an accent insertion line showing where it would land among
   the rows that aren't moving. The reorder happens on release.
   A drag starts anywhere on the row except its own controls, so the name,
   the swatch and the empty space are all grips while the checkbox, the
   dropdowns and the buttons keep working.
   Fill layers can never move above the edge layers, so only positions
   within the fill run are offered. */
const INSERT_LINE_HEIGHT = 2;
let fillDragState = null;
function startFillRowDrag(e, row, L){
  if (e.button !== 0 || e.target.closest('input,select,button')) return;
  const host = row.parentNode;
  const others = [...host.querySelectorAll('.fillRow')].filter(r => r !== row);
  fillDragState = { L, row, host, others, insertLine: svgInsertLine(), target: null, moved: false, startY: e.clientY };
  row.setPointerCapture(e.pointerId);
}
// How far the pointer must travel before a press on a row counts as a drag
// rather than a click on the row's own controls.
const FILL_DRAG_SLOP = 4;
function svgInsertLine(){
  const line = document.createElement('div');
  line.className = 'svInsertLine';
  return line;
}
function onFillRowDragMove(e){
  if (!fillDragState) return;
  const { host, others, insertLine, row } = fillDragState;
  if (!fillDragState.moved){
    if (Math.abs(e.clientY - fillDragState.startY) < FILL_DRAG_SLOP) return;
    fillDragState.moved = true;
    row.classList.add('svDragging');
  }
  let target = null;
  for (const r of others){
    const rect = r.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height/2){ target = r; break; }
  }
  fillDragState.target = target;          // null means "after every other row"
  if (!insertLine.parentNode) host.appendChild(insertLine);
  const hostRect = host.getBoundingClientRect();
  let top = 0;
  if (target) top = target.getBoundingClientRect().top - hostRect.top;
  else if (others.length) top = others[others.length-1].getBoundingClientRect().bottom - hostRect.top - INSERT_LINE_HEIGHT;
  insertLine.style.top = top + 'px';
}
function endFillRowDrag(){
  if (!fillDragState) return;
  const { L, row, others, insertLine, target, moved } = fillDragState;
  insertLine.remove();
  row.classList.remove('svDragging');
  fillDragState = null;
  if (!moved) return;                     // pressed but never dragged
  // `others` is the fill run without the dragged layer, in the same order,
  // so the row index carries straight over to the layer list.
  const before = layers.filter(e2 => layerType(e2).kind === 'fill');
  const rest = before.filter(e2 => e2 !== L);
  const at = target ? others.indexOf(target) : others.length;
  rest.splice(at, 0, L);
  if (rest.every((e2, i) => e2 === before[i])) return;   // dropped where it already was
  replaceLayers([...layers.filter(e2 => layerType(e2).kind !== 'fill'), ...rest]);
  fillLayersChanged();
}
// (Re)builds every row from the current instances.
export function buildLayerRows(){
  for (const id in layerEls) delete layerEls[id];
  for (const id in fillRowEls) delete fillRowEls[id];
  for (const host of new Set(Object.values(LAYER_TYPES).map(T => T.host))) $(host).replaceChildren();
  for (const L of layers){
    const T = layerType(L);
    const isFill = T.kind === 'fill';
    const name = layerName(L);
    const row = document.createElement('div');
    row.className = 'layer' + (isFill ? ' fillRow' : '');
    row.innerHTML =
      (isFill ? '<button type="button" class="rowExpand" aria-label="' + name + ' settings">&#9656;</button>' : '') +
      '<input type="checkbox" aria-label="' + name + ' on">' +
      '<svg class="swatch" viewBox="0 0 50 14" aria-hidden="true"><path d="M3 7 L47 7" fill="none"/></svg>' +
      '<span class="nm' + (name.startsWith('·') ? ' hid' : '') + '"></span>' +
      '<select class="penSelect" aria-label="' + name + ' pen"></select>' +
      '<select aria-label="' + name + ' dash">' + dashOptionsHtml() + '</select>' +
      (isFill
        ? '<button type="button" class="svBtn rowDup" title="Duplicate layer" aria-label="Duplicate ' + name + '">&#10697;</button>' +
          '<button type="button" class="svBtn svDelete" title="Delete layer" aria-label="Delete ' + name + '">&#10005;</button>'
        : '');
    const host = $(T.host);
    host.appendChild(row);
    const expand = isFill ? row.children[0] : null;
    const chk = row.querySelector('input[type=checkbox]');
    const sw = row.querySelector('.swatch').firstChild;
    const [pen, dash] = row.querySelectorAll('select');
    row.querySelector('.nm').textContent = name;
    fillPenSelect(pen, L.pen);
    layerEls[L.id] = { chk, pen, dash, sw };
    pen.addEventListener('change', () => { L.pen = pen.value; applyLayerStyle(L.id); });
    dash.addEventListener('change', () => { L.dash = dash.value; applyLayerStyle(L.id); refreshStatusR(); });
    chk.addEventListener('change', () => {
      L.on = chk.checked;
      markStale();
      // Fades the Lines-section sliders that belong to a layer group once that
      // group draws nothing (panel-controls.js).
      syncLineLayerUI();
      updateTextureGizmo();   // the Circles centre gizmo follows its layer's checkbox
    });
    if (isFill){
      const panel = buildFillSettings(L);
      host.appendChild(panel);
      row.classList.toggle('rowExpanded', L.id === expandedId);
      expand.addEventListener('click', () => {
        expandedId = expandedId === L.id ? null : L.id;
        for (const other of host.querySelectorAll('.fillRow')) other.classList.remove('rowExpanded');
        for (const other of host.querySelectorAll('.layerSettings')) other.hidden = true;
        if (expandedId === L.id){ row.classList.add('rowExpanded'); panel.hidden = false; }
        updateTextureGizmo();   // the gizmo follows whichever circles layer is open
      });
      row.querySelector('.rowDup').addEventListener('click', () => duplicateFillLayer(L));
      row.querySelector('.svDelete').addEventListener('click', () => deleteFillLayer(L));
      row.addEventListener('pointerdown', e => startFillRowDrag(e, row, L));
    }
    applyLayerStyle(L.id);
  }
  syncFillRowSoftState();
}

/* ================= init =================
   Everything above only declares. This wires the DOM and starts the
   module's live behaviour — called once by app.js, in script order. */
export function initSvgExport(){
  buildLayerRows();
  // "+ Add layer": one option per fill type, and back to the placeholder
  // after each pick (it is an action, not a stored choice).
  const addSel = $('addLayerSelect');
  addSel.replaceChildren(...[['', '+ Add layer…'], ...FILL_TYPES.map(t => [t, LAYER_TYPES[t].name])].map(([value, text]) => {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = text;
    return opt;
  }));
  addSel.addEventListener('change', () => {
    const type = addSel.value;
    addSel.value = '';
    if (type) addFillLayer(type);
  });
  // The fill rows' drag-reorder (startFillRowDrag) tracks and ends here, so
  // a release outside the row still finishes the gesture.
  document.addEventListener('pointermove', onFillRowDragMove);
  document.addEventListener('pointerup', endFillRowDrag);
  document.addEventListener('pointercancel', endFillRowDrag);
  buildDashFields('D1');
  buildDashFields('D2');
  $('addDashBtn').addEventListener('click', addDashSlot);
  if (DASH_KEYS.length >= MAX_DASH_SLOTS) $('addDashBtn').disabled = true;   // defensive — e.g. a restored scene that already has all 9
  // Display-only, exactly like the mask it drives: no markStale(), no
  // regenerate, no re-layout — the geometry is identical either way and only
  // the export (and what's visible of it) changes.
  $('trimToMargins').addEventListener('change', () => {
    syncPreviewTrimMask();
    syncLayoutTrimMask();
  });
  ['paperSize','orient','marginMm','marginTopMm','marginBottomMm','marginLeftMm','marginRightMm'].forEach(id =>
    $(id).addEventListener('input', () => {
      resetPv(); renderPaper();
      markStale();   // paper scale now feeds the mm→px hatch-spacing conversion
      syncLayoutPaperFrame();
      refreshStatusR();   // mm figure depends on paper scale — keep it in step with the just-retransformed drawing
    }));
  $('pageColor').addEventListener('input', applyPageColor);
  updateGuideColor();   // seed --guide-color for the default page color at boot, before any user edit fires applyPageColor
  updateSelColor();     // same, for --sel-color
  $('marginIndependent').addEventListener('change', syncMarginMode);
  // Purely a preview compositing toggle — no geometry changes, so this
  // flips the class directly on #plot itself (Preview mode — covers both the
  // live drawing AND the Layout overlay, see styles.css) and the shared
  // Layout blocks container (Layout mode — a single toggle there affects
  // every block, since isolation lives at that one shared level, not
  // per-block — see styles.css), rather than going through markStale like
  // every regen setting (settings.js).
  $('blendMultiplyOn').addEventListener('change', () => {
    const on = $('blendMultiplyOn').checked;
    const plot = document.getElementById('plot');
    if (plot) plot.classList.toggle('blendMultiply', on);
    const blocksLayer = document.getElementById('layoutBlocksLayer');
    if (blocksLayer) blocksLayer.classList.toggle('blendMultiplyLayout', on);
  });
  $('exportBtn').addEventListener('click', () => {
    const isLayout = activeTab === 'layout';
    if (isLayout){
      if (!blocks.length){ $('statusL').textContent = 'no layers to export'; return; }
    } else if (!lastGen){ $('statusL').textContent = 'generate first'; return; }

    const layout = isLayout ? computeLayoutPaperDims() : computePaperLayout();
    let out;
    if ($('penPathsExport').checked){
      out = buildPenPathsExport(isLayout, layout);
    } else {
      // The ordinary export: a cleaned-up clone of the on-screen SVG, one group
      // per layer (per block per layer in Layout), exactly as drawn.
      const sourceSvg = isLayout ? $('layoutPlot') : $('plot');

      const clone = sourceSvg.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width',  layout.paperW.toFixed(2) + 'mm');
      clone.setAttribute('height', layout.paperH.toFixed(2) + 'mm');
      clone.setAttribute('viewBox', '0 0 ' + layout.paperW.toFixed(3) + ' ' + layout.paperH.toFixed(3));
      const guide = clone.querySelector('#marginGuide');
      if (guide) guide.remove();            // preview-only reference rect, not part of the plot
      const pvGrid = clone.querySelector('#pvGridGuides');
      if (pvGrid) pvGrid.remove();          // preview-only guide grid, not part of the plot
      // The trim masks are the on-screen STAND-IN for the clip below — in the
      // exported file the geometry is genuinely cut, so the paper-coloured
      // frame (which would otherwise export as a real filled rectangle, plotted
      // as a solid block of ink) has no business being there. Removed for both
      // tabs regardless of which one is exporting, since only one exists at a
      // time and neither belongs in a plot file.
      ['#pvTrimMask', '#layoutTrimMaskSlot'].forEach(sel => {
        const el = clone.querySelector(sel);
        if (el) el.remove();
      });
      const overlay = clone.querySelector('#previewLayoutOverlay');
      if (overlay) overlay.remove();        // preview-only Layout overlay reference, not part of the plot
      // .blendMultiply now lives on #plot itself (see the toggle's own comment)
      // — for a Preview export, `clone` IS that root element, which
      // querySelectorAll below can't reach (it only matches descendants), so
      // the root's own class has to be stripped separately first.
      clone.classList.remove('blendMultiply');
      clone.querySelectorAll('.blendMultiply').forEach(el => el.classList.remove('blendMultiply'));   // preview-only compositing, inert anyway with no stylesheet, but kept clean
      if (isLayout){
        // These are all Layout-tab-only UI chrome (selection box/handles/gizmo,
        // the invisible full-paper click-catcher, the dashed margin reference,
        // and any leftover snap-guide lines) — never part of the actual plot.
        // Also matters because the exported file has no access to the app's
        // stylesheet: elements styled only via CSS classes (like the margin
        // guide's fill:none) would otherwise fall back to SVG's default black
        // fill in the standalone file instead of being invisible.
        ['#layoutSelOverlay', '#layoutHitBg', '#layoutMarginGuide', '#layoutGridGuides', '#layoutSnapGuides', '#layoutAxisGuides'].forEach(sel => {
          const el = clone.querySelector(sel);
          if (el) el.remove();
        });
      }
      clone.querySelectorAll('g[style*="display: none"], g[style*="display:none"]').forEach(g => g.remove());
      if ($('splitDashBtn').checked){
        clone.querySelectorAll('g[stroke-dasharray]').forEach(g => {
          const pattern = g.getAttribute('stroke-dasharray').trim().split(/[\s,]+/).map(Number);
          g.querySelectorAll('path').forEach(p => {
            p.setAttribute('d', splitDashedPathD(p.getAttribute('d'), pattern));
          });
          g.removeAttribute('stroke-dasharray');
        });
      }
      // Deliberately the very last geometry step, after dash splitting: each
      // dash piece is then clipped in its own right, so the dash rhythm in the
      // file is the one the preview showed rather than one that restarts at
      // wherever the margin happened to cut a path. Same paper description the
      // rest of this export is built from, so the clip lands exactly on the
      // margin guide the preview draws.
      if ($('trimToMargins').checked) trimCloneToMargins(clone, layout);
      out = clone;
    }
    const meta = document.createComment(' Penumbra plot · ' + modelName + ' · ' +
      new Date().toISOString() + ' · ' + (isLayout
        ? ('layout: ' + blocks.length + ' layer(s)')
        : ('settings: ' + JSON.stringify(gatherSettings()))) + ' ');
    out.insertBefore(meta, out.firstChild);

    downloadFile(modelName.replace(/\.(stl|obj)$/i, '') + (isLayout ? '-layout.svg' : '-plot.svg'),
      '<?xml version="1.0" encoding="UTF-8"?>\n' + out.outerHTML, 'image/svg+xml');
  });
}
