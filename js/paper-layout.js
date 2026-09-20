/* ================================================================
   paper-layout.js — the sheet the drawing sits on
   The paper the preview pane represents (size + orientation + margins,
   PAPERS/getMargins/computePaperLayout) and the transform that fits the
   solved drawing inside those margins — the single source of truth
   shared by the on-screen preview and the real export, so the two can
   never drift apart. pxPerMm() is that transform read backwards: how
   many local units 1mm is, which every mm-authored value (pen widths,
   dash lengths, texture lengths) is multiplied by.
   renderPaper() re-lays out the on-screen SVG for the current paper;
   the trim mask, the page colour and the guide/selection colours it
   drives live here too.
   ================================================================ */
import { $, svgEl } from './main.js';
import { layers } from './layers.js';
import { refreshStatusR } from './render-result.js';
import { lastResult, markStale, rescaleCirclesCentres } from './panel-controls.js';
import { gridGuidePositions, renderPreviewLayoutOverlay, syncLayoutPaperFrame, syncLayoutTrimMask } from './layout/layout-model.js';
import { applyPaperView, resetPaperView } from './paper-preview.js';
import { applyLayerStyle } from './layer-rows.js';
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
  const d = dims || lastResult;
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
  rescaleCirclesCentres();
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
  // gridGuidePositions in layout-model.js, the shared source of truth for
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
  applyPaperView(layout);
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
  // renderResult's while-loop).
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
// this never needs resetPaperView()/renderPaper()/markStale().
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
/* ================= "Blend colors" preview compositing =================
   Purely a preview compositing toggle — no geometry changes, so it flips a
   class directly on #plot itself (Preview mode — covers both the live
   drawing AND the Layout overlay, see styles.css) and on the shared Layout
   blocks container (Layout mode — one toggle there affects every block,
   since isolation lives at that one shared level, not per-block — again see
   styles.css), rather than going through markStale like every regen setting
   (settings.js). Lives in the Export panel, so it is reachable from both
   tabs. Session-only: never saved to a .pen scene, same as the Layout
   overlay switches (layout-list.js). */
export let blendMultiplyOn = false;
export function applyBlendMultiply(){
  const plot = document.getElementById('plot');
  if (plot) plot.classList.toggle('blendMultiply', blendMultiplyOn);
  const blocksLayer = document.getElementById('layoutBlocksLayer');
  if (blocksLayer) blocksLayer.classList.toggle('blendMultiplyLayout', blendMultiplyOn);
}
export function syncMarginMode(){
  const on = $('marginIndependent').checked;
  $('marginSingleRow').style.display = on ? 'none' : '';
  $('marginIndependentRows').style.display = on ? '' : 'none';
  resetPaperView(); renderPaper();
  markStale();
  syncLayoutPaperFrame();
}

/* The controls that change the sheet itself: the trim-mask toggle, paper
   size/orientation/margins, page colour and the preview compositing
   toggle. Called from app.js after initLayerRows, which is the order
   these listeners were registered in when they lived in it. */
export function initPaperLayout(){
  // Display-only, exactly like the mask it drives: no markStale(), no
  // regenerate, no re-layout — the geometry is identical either way and only
  // the export (and what's visible of it) changes.
  $('trimToMargins').addEventListener('change', () => {
    syncPreviewTrimMask();
    syncLayoutTrimMask();
  });
  ['paperSize','orient','marginMm','marginTopMm','marginBottomMm','marginLeftMm','marginRightMm'].forEach(id =>
    $(id).addEventListener('input', () => {
      resetPaperView(); renderPaper();
      markStale();   // paper scale now feeds the mm→px hatch-spacing conversion
      syncLayoutPaperFrame();
      refreshStatusR();   // mm figure depends on paper scale — keep it in step with the just-retransformed drawing
    }));
  $('pageColor').addEventListener('input', applyPageColor);
  updateGuideColor();   // seed --guide-color for the default page color at boot, before any user edit fires applyPageColor
  updateSelColor();     // same, for --sel-color
  $('marginIndependent').addEventListener('change', syncMarginMode);
  $('blendMultiplyBtn').addEventListener('click', () => {
    blendMultiplyOn = !blendMultiplyOn;
    $('blendMultiplyBtn').setAttribute('aria-checked', String(blendMultiplyOn));
    $('blendMultiplyBtn').classList.toggle('active', blendMultiplyOn);
    applyBlendMultiply();
  });
}
