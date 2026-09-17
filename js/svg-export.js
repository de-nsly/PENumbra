/* ================================================================
   svg-export.js — turning solved geometry into SVG
   Layer pen/dash styling (colour + width come from the layer's pen,
   see PEN_LIBRARY in main.js), paper layout math shared by the
   preview and the real export, and renderPaper() (re-lays out the
   on-screen SVG render-result.js builds).
   The trim outside the margins is genuine geometry only in the exported
   file (path-model.js, called from export.js); on screen it is merely
   SIMULATED by a page-coloured mask over the band outside the margins
   (buildTrimMaskGroup/syncPreviewTrimMask here, with syncLayoutTrimMask
   in layout-canvas.js as its Layout-tab twin).
   ================================================================ */
import { $, DASH_KEYS, DASH_RATIOS, MAX_DASH_SLOTS, PEN_LIBRARY, dashPattern, penById, scaledDash, svgEl } from './main.js';
import { FILL_TYPES, LAYER_TYPES, copyLayer, layerById, layerName, layerType, layers, newFillLayer, nextFillId, replaceLayers } from './layers.js';
import { refreshStatusR } from './render-result.js';
import { formatValue } from './settings.js';
import { activeTab, lastGen, makeSliderValueEditable, markStale, syncLineLayerUI, updateGroundPatternSliderRange } from './panel-controls.js';
import { renderTextureStack } from './texture-stack.js';
import { gridGuidePositions, layoutOverlayOn, refreshAllBlockStyles, renderPreviewLayoutOverlay, syncLayoutPaperFrame, syncLayoutTrimMask } from './layout-canvas.js';
import { applyPv, resetPv, updateTextureGizmo } from './paper-preview.js';

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
}
