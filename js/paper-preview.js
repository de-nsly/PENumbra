/* ================================================================
   paper-preview.js — the on-screen paper pane
   Pan/zoom state for the paper sheet preview (pv/applyPv/resetPv),
   the pointer handlers that let the user drag/zoom, and the reset
   button (#reset2dBtn) that restores the default pan/zoom. Generalized
   to work on whichever sheet is currently active — #sheet (Preview) or
   #layoutSheet (Layout) — via activeSheetId, which layout-canvas.js's
   tab-switch handler updates; only one sheet is ever visible/interactive
   at a time, so a single shared pv state is enough, reset on tab switch.
   Paper-layout math itself (computePaperLayout, baseSheetSize) lives in
   svg-export.js since computePaperLayout is shared with the actual SVG
   export; computeLayoutPaperDims (the Layout-tab equivalent, no solver
   viewport to fit) lives in layout-canvas.js.
   ================================================================ */
const pane2 = $('paperPane');
const pv = { z: 1, tx: 0, ty: 0 };            // tx/ty: sheet-center offset from pane-center, in CSS px
let activeSheetId = 'sheet';
function currentLayoutDims(){
  return activeSheetId === 'sheet' ? computePaperLayout() : computeLayoutPaperDims();
}
function resetPv(){ pv.z = 1; pv.tx = 0; pv.ty = 0; }
/* previewOverlaySvg/layoutOverlaySvg are position:fixed;inset:0, covering
   the ENTIRE browser viewport — needed so the viewport-relative coordinates
   getBoundingClientRect() already hands back everywhere else in this file
   (previewMmToScreen, updateRuler, layout-canvas.js's selection handles)
   can be used directly as SVG coordinates with no extra offset math. But
   that also means anything drawn in them — the ruler, the texture gizmo,
   selection handles — renders over WHATEVER is underneath in screen space,
   including the 3D viewport pane, if the page has been panned far enough
   that overlay content geometrically lands there; every other panel
   correctly occludes them because those have a real DOM box the overlay
   happens not to overlap, not because of any z-index relationship with
   the 3D viewport specifically. clip-path constrains the overlay's own
   VISIBLE area to #paperPane's actual current bounds, without touching any
   of that existing viewport-relative coordinate math — the clip is
   relative to the overlay's own (full-viewport) box, computed fresh
   whenever the pane could plausibly have moved/resized. */
function updatePaneClip(){
  const r = pane2.getBoundingClientRect();
  const clip = 'inset(' + r.top.toFixed(1) + 'px ' + (window.innerWidth - r.right).toFixed(1) + 'px ' +
    (window.innerHeight - r.bottom).toFixed(1) + 'px ' + r.left.toFixed(1) + 'px)';
  $('previewOverlaySvg').style.clipPath = clip;
  $('layoutOverlaySvg').style.clipPath = clip;
}
window.addEventListener('resize', updatePaneClip);
updatePaneClip();
function applyPv(layout){
  layout = layout || currentLayoutDims();
  if (!layout) return;
  updatePaneClip();   // pane bounds can change on tab switch (Layout widens #paperPane via CSS grid), not just window resize
  const base = baseSheetSize(layout);
  const dispW = base.w * pv.z, dispH = base.h * pv.z;
  const cx = pane2.clientWidth/2 + pv.tx, cy = pane2.clientHeight/2 + pv.ty;
  const sheet = $(activeSheetId);
  sheet.style.width  = dispW.toFixed(1) + 'px';
  sheet.style.height = dispH.toFixed(1) + 'px';
  sheet.style.left = (cx - dispW/2).toFixed(1) + 'px';
  sheet.style.top  = (cy - dispH/2).toFixed(1) + 'px';
  // The Layout tab's selection overlay is drawn from the selected block's
  // world position converted through the sheet's current on-screen
  // placement — whenever that placement changes (pan, zoom, or a paper
  // size/orientation/margin change via renderPaper), the overlay needs
  // redrawing too, or it visually detaches from the block/page it's
  // supposed to be tracking.
  if (activeSheetId === 'layoutSheet' && typeof selectedBlocks !== 'undefined' && selectedBlocks.size){
    updateSelectionOverlay();
  }
  if (activeSheetId === 'sheet' && typeof updateTextureGizmo === 'function') updateTextureGizmo();
  updateRuler(layout);
}
pane2.addEventListener('wheel', e => {
  const layout = currentLayoutDims();
  if (!layout) return;
  e.preventDefault();
  const base = baseSheetSize(layout);
  const r = pane2.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;         // pane-local px
  const cx0 = pane2.clientWidth/2 + pv.tx, cy0 = pane2.clientHeight/2 + pv.ty;
  const dispW0 = base.w * pv.z, dispH0 = base.h * pv.z;
  const fx = (mx - (cx0 - dispW0/2)) / dispW0;                   // fraction of sheet under cursor
  const fy = (my - (cy0 - dispH0/2)) / dispH0;
  pv.z = Math.min(40, Math.max(0.1, pv.z * Math.exp(-e.deltaY * 0.0014)));
  const dispW1 = base.w * pv.z, dispH1 = base.h * pv.z;
  const cx1 = mx - fx*dispW1 + dispW1/2, cy1 = my - fy*dispH1 + dispH1/2;
  pv.tx = cx1 - pane2.clientWidth/2;
  pv.ty = cy1 - pane2.clientHeight/2;
  applyPv(layout);
}, { passive: false });
let panDrag = false, plx = 0, ply = 0;
// Touch pans with TWO fingers, not one — a single finger is left free for
// other touch interaction (tap-select, etc.) rather than immediately
// panning like a mouse-drag would. Tracked separately from the mouse/pen
// middle-button path below since touch delivers one pointerdown/up PER
// finger, each with its own pointerId, rather than a single button state.
const touchPointers = new Map();   // pointerId -> {x,y}, active touch contacts only
function touchMidpoint(){
  let sx = 0, sy = 0;
  for (const p of touchPointers.values()){ sx += p.x; sy += p.y; }
  return [sx / touchPointers.size, sy / touchPointers.size];
}
// Called after touchPointers changes (finger added or removed) — resyncs
// the pan reference point to the new midpoint whenever 2+ fingers are down,
// so a 3rd finger landing (or one of 3 lifting back to 2) doesn't cause the
// view to jump by the midpoint's shift, and stops panning cleanly once
// fewer than 2 fingers remain.
function syncTouchPan(){
  if (touchPointers.size >= 2){
    panDrag = true;
    [plx, ply] = touchMidpoint();
  } else {
    panDrag = false;
  }
}
pane2.addEventListener('pointerdown', e => {
  if (e.pointerType === 'touch'){
    touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pane2.setPointerCapture(e.pointerId);
    syncTouchPan();
    e.preventDefault();
    return;
  }
  // Mouse/pen: only the middle button pans — left and right click no
  // longer do, freeing them up for selection/context-menu use without an
  // accidental drag.
  if (e.button !== 1) return;
  panDrag = true; plx = e.clientX; ply = e.clientY;
  pane2.setPointerCapture(e.pointerId);
  e.preventDefault();   // suppress the browser's default middle-click autoscroll behavior
});
pane2.addEventListener('pointermove', e => {
  if (e.pointerType === 'touch'){
    if (!touchPointers.has(e.pointerId)) return;
    touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!panDrag) return;
    const [cx, cy] = touchMidpoint();
    pv.tx += cx - plx; pv.ty += cy - ply;
    plx = cx; ply = cy;
    applyPv();
    return;
  }
  if (!panDrag) return;
  pv.tx += e.clientX - plx; pv.ty += e.clientY - ply;
  plx = e.clientX; ply = e.clientY;
  applyPv();
});
function endPanPointer(e){
  if (e.pointerType === 'touch'){
    touchPointers.delete(e.pointerId);
    syncTouchPan();
    return;
  }
  panDrag = false;
}
pane2.addEventListener('pointerup', endPanPointer);
pane2.addEventListener('pointercancel', endPanPointer);
// The reset button sits on top of the pannable/zoomable pane — swallow its
// own pointerdown so it never reaches pane2's handler above and triggers a
// pan-drag + pointer-capture on what's really a button click. Pointer
// capture redirects subsequent pointer events to pane2, which interferes
// with the browser's click-event synthesis for the original target (the
// button) on mouse input — the same problem #genExportFloat already guards
// against, for the same reason.
['pointerdown','wheel'].forEach(t => $('reset2dBtn').addEventListener(t, e => e.stopPropagation()));
function reset2dView(){ resetPvFitWithRulers(); applyPv(); }
$('reset2dBtn').addEventListener('click', reset2dView);
// same reset via a double middle-click anywhere on the pane (Preview + Layout)
onMiddleDblClick(pane2, reset2dView);

/* ================= texture pattern gizmo =================
   Draggable center-point marker for the ground-shadow texture pattern,
   overlaid on the Preview pane only. Position: the Center X/Y sliders are
   mm offsets from the PAGE's own center (0,0 = page center, regardless of
   paper size/orientation) — a page-space definition, so placing the gizmo
   only needs layout.paperW/paperH, not the solver-origin/offX/offY
   conversion gatherSettings uses to translate this into what the worker
   actually receives. previewMmToScreen/screenToPreviewMm mirror
   canvasMmToScreen/screenToCanvasMm's exact pattern from layout-canvas.js
   — the SVG's own getBoundingClientRect() already reflects the pane's
   current pan/zoom (applied via CSS position/size, not an SVG-internal
   transform), so no separate pv.z/tx/ty math is needed here at all. */
function previewMmToScreen(mmX, mmY){
  const rect = $('plot').getBoundingClientRect();
  const layout = computePaperLayout();
  if (!layout) return null;
  return [
    rect.left + (mmX / layout.paperW) * rect.width,
    rect.top  + (mmY / layout.paperH) * rect.height,
  ];
}
function screenToPreviewMm(clientX, clientY){
  const rect = $('plot').getBoundingClientRect();
  const layout = computePaperLayout();
  if (!layout) return null;
  return [
    (clientX - rect.left) / Math.max(1e-6, rect.width)  * layout.paperW,
    (clientY - rect.top)  / Math.max(1e-6, rect.height) * layout.paperH,
  ];
}
/* ================================================================
   drawPathEndpointMarkers — debug aid behind #debugShowPathEndpoints.
   Puts a dot on both ends of every OPEN subpath in the Silhouette (so),
   Individual Silhouette (iv/ih) and Contour (sv/sh) layers, for eyeballing
   where strokes actually start and stop — which trims fired, which gaps
   merged, where the pen lifts. Closed subpaths have no endpoints and get
   nothing, so "no dots on a loop" reads as "that loop closed cleanly".

   Reads the FINAL rendered d-strings rather than any intermediate chain
   data, so what it shows is exactly what would be plotted, after every
   cleanup/split/simplify pass has had its say.

   Lives in previewOverlaySvg, which is a screen-space overlay covering the
   whole viewport (see the comment on updatePaneClip): dots therefore sit
   above all plot content whatever its layer order, keep a fixed pixel size
   under zoom for free, and — being outside #plot — cannot reach the
   exported file, which clones #plot alone.

   Emitted as ONE path element built from per-dot arc subpaths instead of N
   circle elements: this redraws on every pan/zoom frame, and a drawing can
   easily carry thousands of endpoints.
   ================================================================ */
const ENDPOINT_DOT_R = 3;                                    // screen px
const ENDPOINT_DOT_LAYERS = ['so', 'iv', 'ih', 'sv', 'sh'];
const ENDPOINT_DOT_CAP = 8000;                               // sanity bound on one redraw
function openSubpathEndpoints(d){
  const out = [];
  const tok = d.split(/\s+/);
  let first = null, last = null, closed = false;
  const flush = () => { if (first && !closed) out.push(first, last); first = null; last = null; closed = false; };
  for (let i = 0; i < tok.length; i++){
    if (tok[i] === 'M'){ flush(); first = [+tok[i+1], +tok[i+2]]; last = first; i += 2; }
    else if (tok[i] === 'L'){ last = [+tok[i+1], +tok[i+2]]; i += 2; }
    else if (tok[i] === 'Z' || tok[i] === 'z') closed = true;
  }
  flush();
  return out;
}
function drawPathEndpointMarkers(){
  if (activeTab !== 'preview' || !$('debugShowPathEndpoints').checked) return;
  const d = [], r = ENDPOINT_DOT_R;
  let n = 0;
  for (const key of ENDPOINT_DOT_LAYERS){
    // The group is built even for a layer that is switched off (it is only
    // display:none — see applyLayerStyle), so the checkbox is the thing to
    // test, not the group's existence. getScreenCTM would return null on a
    // hidden element anyway.
    if (!layerEls[key] || !layerStyle(key).on) continue;
    const path = document.querySelector('#g_' + key + ' path');
    if (!path) continue;
    const m = path.getScreenCTM();      // folds in #paperContent's transform AND the sheet's current pan/zoom
    if (!m) continue;
    for (const [x, y] of openSubpathEndpoints(path.getAttribute('d') || '')){
      if (n++ >= ENDPOINT_DOT_CAP) break;
      const sx = m.a*x + m.c*y + m.e, sy = m.b*x + m.d*y + m.f;
      // Two same-sweep semicircle arcs = one circle. Same sweep throughout so
      // coincident dots never punch a nonzero-fill hole in each other; the Z
      // closes it for the stroke, which would otherwise show a seam at the join.
      d.push('M', (sx-r).toFixed(1), sy.toFixed(1),
             'a', r, r, 0, 1, 0, 2*r, 0, 'a', r, r, 0, 1, 0, -2*r, 0, 'Z');
    }
  }
  if (!d.length) return;
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('class', 'pathEndpointDot');
  p.setAttribute('d', d.join(' '));
  $('previewOverlaySvg').appendChild(p);
}
function updateTextureGizmo(){
  const ov = $('previewOverlaySvg');
  ov.innerHTML = '';
  // This wipe takes every other overlay consumer out with it, so they all get
  // redrawn here, before any of the gizmo's own early returns below.
  updateRuler();
  drawPathEndpointMarkers();
  const visible = activeTab === 'preview' && layerEls['cr'].chk.checked && $('texGizmoShow').checked;
  if (!visible) return;
  const layout = computePaperLayout();
  if (!layout) return;
  const pos = previewMmToScreen(
    layout.paperW/2 + (+$('texGroundPatternCenterX').value || 0),
    layout.paperH/2 + (+$('texGroundPatternCenterY').value || 0)
  );
  if (!pos) return;
  const [gx, gy] = pos;
  const SVG_NS_LOCAL = 'http://www.w3.org/2000/svg';
  const c = document.createElementNS(SVG_NS_LOCAL, 'circle');
  c.setAttribute('class', 'textureGizmo');
  c.setAttribute('cx', gx); c.setAttribute('cy', gy); c.setAttribute('r', 9);
  const cross1 = document.createElementNS(SVG_NS_LOCAL, 'line');
  cross1.setAttribute('class', 'textureGizmoCross');
  cross1.setAttribute('x1', gx-5); cross1.setAttribute('y1', gy); cross1.setAttribute('x2', gx+5); cross1.setAttribute('y2', gy);
  const cross2 = document.createElementNS(SVG_NS_LOCAL, 'line');
  cross2.setAttribute('class', 'textureGizmoCross');
  cross2.setAttribute('x1', gx); cross2.setAttribute('y1', gy-5); cross2.setAttribute('x2', gx); cross2.setAttribute('y2', gy+5);
  ov.appendChild(c); ov.appendChild(cross1); ov.appendChild(cross2);
  c.addEventListener('pointerdown', e => {
    e.stopPropagation();   // don't also start a pane pan-drag underneath
    e.preventDefault();
    gizmoDragging = true;
    c.setPointerCapture(e.pointerId);
  });
}
let gizmoDragging = false;
document.addEventListener('pointermove', e => {
  if (!gizmoDragging) return;
  const layout = computePaperLayout();
  if (!layout) return;
  const mm = screenToPreviewMm(e.clientX, e.clientY);
  if (!mm) return;
  const xSlider = $('texGroundPatternCenterX'), ySlider = $('texGroundPatternCenterY');
  xSlider.value = Math.min(+xSlider.max, Math.max(+xSlider.min, mm[0] - layout.paperW/2));
  ySlider.value = Math.min(+ySlider.max, Math.max(+ySlider.min, mm[1] - layout.paperH/2));
  // Dispatching real 'input' events reuses the existing slider pipeline
  // (markStale + refreshValLabel) instead of duplicating it — markStale's
  // own debounce means the actual regenerate naturally only fires once
  // the drag settles, not on every pointermove.
  xSlider.dispatchEvent(new Event('input'));
  ySlider.dispatchEvent(new Event('input'));
  updateTextureGizmo();
});
document.addEventListener('pointerup', () => { gizmoDragging = false; });
document.addEventListener('pointercancel', () => { gizmoDragging = false; });
$('texGroundPatternCenterX').addEventListener('input', updateTextureGizmo);
$('texGroundPatternCenterY').addEventListener('input', updateTextureGizmo);
$('texGizmoShow').addEventListener('change', updateTextureGizmo);
// updateTextureGizmo is the single redraw entry point for previewOverlaySvg —
// it owns the wipe — so toggling the endpoint markers goes through it too.
// Nothing needs re-solving: the dots are read off the already-rendered paths.
$('debugShowPathEndpoints').addEventListener('change', updateTextureGizmo);

/* ================= page rulers =================
   Horizontal ruler above the page, vertical ruler to its left — screen
   pixels only, drawn into the SAME per-mode overlay SVG the texture gizmo
   / block-selection UI already use (previewOverlaySvg / layoutOverlaySvg,
   picked via activeSheetId exactly like updateTextureGizmo/
   updateSelectionOverlay above) rather than into #plot/#layoutPlot itself.
   Two reasons: that SVG's viewBox is locked to exactly the page's own
   paperW×paperH, so there's no room to draw 5mm outside it without
   growing the sheet's own visual box (which represents the physical page,
   border and background included) — the overlay approach already used
   for the selection handles/rotate gizmo, which also need to extend past
   the page edge sometimes, avoids that entirely; and it means the ruler
   is automatically screen-only, since export clones #plot/#layoutPlot
   directly and never touches these overlays.
   Called from applyPv above, so it repaints on every pan/zoom, on tab
   switch (activeSheetId changing), and on any paper size/orientation/
   margin change (renderPaper's own call to applyPv at the end) — the same
   trigger set the gizmo and selection overlay already rely on.
   Geometry (baseline gap, tick lengths, label font) is defined in real
   page mm, then multiplied through the sheet's OWN current on-screen
   scale (getBoundingClientRect(), same technique as previewMmToScreen
   above — already reflects pan/zoom via CSS position/size, no separate
   pv.z/tx/ty math needed) — so tick length, label size, and stroke width
   all shrink/grow with zoom exactly like real page content would, rather
   than staying a fixed screen size regardless of zoom. Deliberately no
   minimum-size floor on any of those: zooming out a lot is supposed to
   make the whole ruler (ticks, labels, line weight) shrink right along
   with the page, not clamp to some "still legible" minimum. */
const RULER_GAP_MM = 5;          // baseline sits this far outside the page edge
const RULER_TICK_1MM = 0.8, RULER_TICK_5MM = 1.6, RULER_TICK_10MM = 2.6;
const RULER_LABEL_GAP_MM = 0.6, RULER_LABEL_GAP_TOP_MM = 1.4, RULER_LABEL_FONT_MM = 2.6, RULER_STROKE_MM = 0.15;
const PAGE_LABEL_GAP_MM = 10, PAGE_LABEL_FONT_MM = 70, PAGE_LABEL_COLOR = '#566276';
function updateRuler(layout){
  const ov = $(activeSheetId === 'sheet' ? 'previewOverlaySvg' : 'layoutOverlaySvg');
  const old = ov.querySelector('.pageRuler');
  if (old) old.remove();
  const oldLabel = ov.querySelector('.pageSizeLabel');
  if (oldLabel) oldLabel.remove();
  layout = layout || currentLayoutDims();
  if (!layout) return;
  const rect = $(activeSheetId).getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const scale = rect.width / layout.paperW;   // screen px per mm — same in both axes, baseSheetSize keeps aspect locked
  const toX = mmX => rect.left + mmX * scale;
  const toY = mmY => rect.top  + mmY * scale;

  const SVG_NS_LOCAL = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(SVG_NS_LOCAL, 'g');
  g.setAttribute('class', 'pageRuler');
  const d = [];
  const addTick = (horiz, posMm, lenMm) => {
    if (horiz){
      const x = toX(posMm), yBase = toY(-RULER_GAP_MM);
      d.push('M' + x.toFixed(1) + ',' + yBase.toFixed(1) + 'L' + x.toFixed(1) + ',' + (yBase - lenMm*scale).toFixed(1));
    } else {
      const y = toY(posMm), xBase = toX(-RULER_GAP_MM);
      d.push('M' + xBase.toFixed(1) + ',' + y.toFixed(1) + 'L' + (xBase - lenMm*scale).toFixed(1) + ',' + y.toFixed(1));
    }
  };
  const labels = [];
  const addLabel = (horiz, posMm, value) => {
    if (horiz) labels.push({ x: toX(posMm), y: toY(-RULER_GAP_MM - RULER_TICK_10MM - RULER_LABEL_GAP_TOP_MM), text: String(value), anchor: 'middle' });
    else labels.push({ x: toX(-RULER_GAP_MM - RULER_TICK_10MM - RULER_LABEL_GAP_MM), y: toY(posMm), text: String(value), anchor: 'end' });
  };
  for (const [horiz, extentMm] of [[true, layout.paperW], [false, layout.paperH]]){
    for (let mm = 0; mm <= extentMm + 1e-6; mm++){
      const major = mm % 10 === 0, mid = mm % 5 === 0;
      addTick(horiz, mm, major ? RULER_TICK_10MM : mid ? RULER_TICK_5MM : RULER_TICK_1MM);
      if (major) addLabel(horiz, mm, mm);
    }
  }
  // baseline itself, full length along each axis
  d.push('M' + toX(0).toFixed(1) + ',' + toY(-RULER_GAP_MM).toFixed(1) + 'L' + toX(layout.paperW).toFixed(1) + ',' + toY(-RULER_GAP_MM).toFixed(1));
  d.push('M' + toX(-RULER_GAP_MM).toFixed(1) + ',' + toY(0).toFixed(1) + 'L' + toX(-RULER_GAP_MM).toFixed(1) + ',' + toY(layout.paperH).toFixed(1));

  const path = document.createElementNS(SVG_NS_LOCAL, 'path');
  path.setAttribute('d', d.join(' '));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--muted)');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-width', Math.max(1e-3, RULER_STROKE_MM * scale).toFixed(2));
  g.appendChild(path);

  const fontPx = Math.max(1e-3, RULER_LABEL_FONT_MM * scale).toFixed(1);
  for (const L of labels){
    const t = document.createElementNS(SVG_NS_LOCAL, 'text');
    t.setAttribute('x', L.x.toFixed(1)); t.setAttribute('y', L.y.toFixed(1));
    t.setAttribute('text-anchor', L.anchor);
    t.setAttribute('dominant-baseline', 'middle');
    t.setAttribute('font-size', fontPx);
    t.setAttribute('fill', 'var(--muted)');
    t.textContent = L.text;
    g.appendChild(t);
  }
  ov.appendChild(g);

  /* Large page-size label (e.g. "A4") — bottom-aligned to the page's own
     bottom edge, 10mm to the right of its right edge, same real-world-mm
     scaling as everything else here. A separate group (own remove-before-
     redraw at the top of this function) so it can't end up stale if only
     one of the two ever needs to change — they don't currently have
     independent triggers, but there's no reason to couple them. */
  const label = document.createElementNS(SVG_NS_LOCAL, 'text');
  label.setAttribute('class', 'pageSizeLabel');
  label.setAttribute('x', toX(layout.paperW + PAGE_LABEL_GAP_MM).toFixed(1));
  label.setAttribute('y', toY(layout.paperH).toFixed(1));   // alphabetic baseline ~= visual bottom for plain size codes (no descenders)
  label.setAttribute('text-anchor', 'start');
  label.setAttribute('font-size', Math.max(1e-3, PAGE_LABEL_FONT_MM * scale).toFixed(1));
  label.setAttribute('font-weight', '700');
  label.setAttribute('fill', PAGE_LABEL_COLOR);
  label.textContent = $('paperSize').value;
  ov.appendChild(label);
}

// Reset-view fit — deliberately separate from baseSheetSize's own plain
// page fit (used everywhere else pv.z=1 is the reference scale): the Reset
// button is specifically supposed to bring the WHOLE view back into frame,
// and the ruler (drawn only above/left of the page, see updateRuler above)
// sits outside the page's own box, so fitting the bare page alone can leave
// its ticks/labels clipped off the top/left edge of the pane. Margin
// estimates are deliberately generous (assumes the longest tick label
// across every supported paper size, ~4 digits) rather than exact — a
// little extra breathing room is harmless, clipping isn't.
const RULER_FIT_LABEL_CHARS = 4;          // "1189" — the longest tick label across PAPERS
const RULER_FIT_CHAR_WIDTH_EM = 0.6;      // generous monospace-ish width estimate relative to font-size
function rulerFitMarginMm(){
  return {
    left: RULER_GAP_MM + RULER_TICK_10MM + RULER_LABEL_GAP_MM
      + RULER_FIT_LABEL_CHARS * RULER_FIT_CHAR_WIDTH_EM * RULER_LABEL_FONT_MM,
    top: RULER_GAP_MM + RULER_TICK_10MM + RULER_LABEL_GAP_TOP_MM + RULER_LABEL_FONT_MM * 0.6,
  };
}
function resetPvFitWithRulers(){
  const layout = currentLayoutDims();
  if (!layout){ resetPv(); return; }
  const margin = rulerFitMarginMm();
  const pane = $('paperPane');
  const availW = Math.max(20, pane.clientWidth - 20), availH = Math.max(20, pane.clientHeight - 20);
  const scale = Math.min(availW / (layout.paperW + margin.left), availH / (layout.paperH + margin.top));
  const base = baseSheetSize(layout);
  const baseScale = base.w / layout.paperW;     // the scale baseSheetSize's own z=1 fit represents
  pv.z = scale / baseScale;
  // Shifts the page right/down by half the ruler margin so the page+ruler
  // BOUNDING BOX ends up centered in the pane, not just the bare page —
  // since the ruler only extends outward on the top/left, centering the
  // page alone would crowd the ruler against one side while leaving unused
  // empty space on the opposite side.
  pv.tx = (margin.left * scale) / 2;
  pv.ty = (margin.top * scale) / 2;
}

