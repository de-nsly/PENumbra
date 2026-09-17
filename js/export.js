/* ================================================================
   export.js — writing the .svg file
   The Export button. Two modes, picked by the Pen library tab's
   "Export one path per pen":
     off — a cleaned-up CLONE of the on-screen SVG (one group per
           layer, per block per layer in Layout), with the preview-only
           chrome stripped out.
     on  — buildPenPathsExport, a freshly built file holding one <path>
           per pen, baked into page mm, so an importer that makes one
           object per path (Blender's) gets one object per pen.
   Both run dash splitting and the margin trim (path-model.js) on the
   EXPORT data only: the live document always keeps its full geometry,
   and the on-screen trim is merely the page-coloured mask over the band
   outside the margins (buildTrimMaskGroup in paper-layout.js).
   ================================================================ */
import { $, PEN_LIBRARY, SVG_NS, downloadFile, penById, svgEl } from './main.js';
import { layers } from './layers.js';
import { clipPathDToMargins, ctmWithinRoot, emitPathD, matApply, matInvert, parsePathD, splitDashedPathD, trimCloneToMargins } from './path-model.js';
import { activeTab, gatherSettings, lastGen } from './panel-controls.js';
import { blockLayerPenId, blocks, computeLayoutPaperDims, createBlockDom, updateBlockStyle } from './layout-canvas.js';
import { computePaperLayout } from './svg-export.js';
import { modelName } from './viewport3d.js';
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

/* The Export button. Named rather than the anonymous listener it used to
   be inside initSvgExport, so the two export modes have one entry point
   the rest of the app (and a future menu item) can call. */
export function exportSvg(){
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
}
export function initExport(){
  $('exportBtn').addEventListener('click', exportSvg);
}
