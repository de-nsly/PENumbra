/* ================================================================
   svg-export.js — turning solved geometry into SVG
   Layer color/width/dash styling, paper layout math shared by the
   preview and the real export, renderPaper() (builds the on-screen
   SVG from the worker's result), the segment post-processing used
   by onResult (chaining/merging/splitting), and the final
   export-to-.svg-file handler.
   NOTE: this is the most likely place to look for the line-shift
   bug — worldOnFace()/intersectSegs() live in the worker, but the
   chaining/dedup/clip steps below (chainSegments,
   mergeAdjacentTouching, mergeCreaseScreenSpace, splitSelfTouching)
   are the other classic source of segment-position drift.
   ================================================================ */
// Pen widths are mm values entered to plotter-nib precision (0.15, 0.25,
// 0.35mm etc.) — display up to 2 decimals, trimming trailing zeros rather
// than padding to a fixed width, so 1 shows as "1", 1.1 as "1.1", and 1.05
// as "1.05". Nothing in the native <input type=number> widget guarantees
// this on its own (its own internal step/display arithmetic can otherwise
// show a value rounded to fewer decimals than were actually typed or
// stepped to), so this is applied explicitly after every edit.
function fmtWidth(n){ return (Math.round(n*100)/100).toString(); }
// Shared by every per-layer dash <select> (built below) AND by addDashSlot
// further down, which appends a fresh <option> to each already-built one
// when a new slot is created — 'solid' is always first and isn't part of
// DASH_KEYS itself (see its own comment in main.js).
function dashOptionsHtml(){
  return '<option value="solid">—</option>' + DASH_KEYS.map(k => '<option value="' + k + '">' + k + '</option>').join('');
}
const layerEls = {};
for (const L of LAYERS){
  const row = document.createElement('div');
  row.className = 'layer';
  row.innerHTML =
    '<input type="checkbox" ' + (L.on ? 'checked' : '') + ' aria-label="' + L.name + ' on">' +
    '<svg class="swatch" viewBox="0 0 50 14" aria-hidden="true"><path d="M3 7 L47 7" fill="none"/></svg>' +
    '<span class="nm' + (L.name.startsWith('·') ? ' hid' : '') + '">' + L.name + '</span>' +
    '<input type="color" value="' + L.color + '" aria-label="' + L.name + ' color">' +
    '<input type="number" value="' + fmtWidth(L.width) + '" min="0.1" max="6" step="0.05" aria-label="' + L.name + ' width">' +
    '<select aria-label="' + L.name + ' dash">' + dashOptionsHtml() + '</select>';
  $(L.host).appendChild(row);
  const [chk, , , col, wid, dash] = row.children;
  const sw = row.children[1].firstChild;
  dash.value = L.dash;
  layerEls[L.key] = { chk, col, wid, dash, sw };
  const restyle = () => applyLayerStyle(L.key);
  col.addEventListener('input', restyle);
  wid.addEventListener('input', restyle);
  // 'change' (fires on blur/Enter, and on every spinner-arrow click) rather
  // than 'input' (fires per keystroke) — reformatting mid-typing would fight
  // the user for control of the field while they're still entering a value
  wid.addEventListener('change', () => { wid.value = fmtWidth(+wid.value); });
  dash.addEventListener('change', () => { restyle(); refreshStatusR(); });
  chk.addEventListener('change', () => { L.solve ? markStale() : applyLayerStyle(L.key); });
  applyLayerStyle(L.key);
}

/* ================= Dash section (cog tab) =================
   D1/D2 are user-editable 6-value patterns (dash,gap,dash,gap,dash,gap),
   each value a multiple of whatever layer's own line width is using it —
   see scaledDash/trimTrailingZeroPairs in main.js. Editing a field here
   refreshes every layer currently on this pattern (any layer could be
   using it, not just one), the same reason a paper-size change already
   re-runs applyLayerStyle for the whole LAYERS list elsewhere. */
const DASH_FIELD_LABELS = ['dash','gap','dash','gap','dash','gap'];
function refreshDashPreview(key){
  const line = $('dashPreview' + key).querySelector('line');
  const trimmed = trimTrailingZeroPairs(DASH_RATIOS[key]);
  const PREVIEW_PX_PER_UNIT = 6;    // arbitrary — this preview isn't tied to any real layer's width
  if (trimmed[0] > 0) line.setAttribute('stroke-dasharray', trimmed.map(v => v*PREVIEW_PX_PER_UNIT).join(' '));
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
      for (const L of LAYERS) applyLayerStyle(L.key);
      refreshStatusR();
    });
  });
  refreshDashPreview(key);
}
buildDashFields('D1');
buildDashFields('D2');
/* "+ Add dash style" — only ever grows DASH_KEYS (never removes), up to
   MAX_DASH_SLOTS. New slot starts at a plain, visibly non-solid default
   ([2,2,0,0,0,0]) purely so it's not all-zeros (which scaledDash would
   otherwise silently render as solid) until the user actually customizes
   it via the sliders buildDashFields just built. */
function addDashSlot(){
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
  for (const L of LAYERS){
    const opt = document.createElement('option');
    opt.value = newKey; opt.textContent = newKey;
    layerEls[L.key].dash.appendChild(opt);
  }
  if (DASH_KEYS.length >= MAX_DASH_SLOTS) $('addDashBtn').disabled = true;
}
$('addDashBtn').addEventListener('click', addDashSlot);
if (DASH_KEYS.length >= MAX_DASH_SLOTS) $('addDashBtn').disabled = true;   // defensive — e.g. a restored scene that already has all 9
function layerStyle(key){
  const el = layerEls[key];
  return { on: el.chk.checked, color: el.col.value, width: +el.wid.value, dash: el.dash.value };
}
function applyLayerStyle(key){
  const s = layerStyle(key), el = layerEls[key];
  const swWidth = Math.max(0.6, s.width);
  el.sw.setAttribute('stroke', s.color);
  el.sw.setAttribute('stroke-width', swWidth);
  el.sw.setAttribute('stroke-dasharray', scaledDash(s.dash, swWidth));
  const g = document.getElementById('g_' + key);
  if (g){
    g.setAttribute('stroke', s.color);
    // s.width is a true mm value (see LAYERS defaults / the W[mm] label).
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
    const layout = computePaperLayout();
    const scale = layout ? layout.scale : 1;
    const pxPerMm = 1 / Math.max(1e-6, scale);
    const gWidth = s.width * pxPerMm;
    g.setAttribute('stroke-width', gWidth);
    // Dash/gap are true mm lengths (DASH_RATIOS), independent of pen width —
    // scale by the SAME mm->px factor as the width above, NOT by gWidth
    // itself, or a 10mm dash would come out as 10x-the-pen-width instead.
    const dash = scaledDash(s.dash, pxPerMm);
    if (dash) g.setAttribute('stroke-dasharray', dash); else g.removeAttribute('stroke-dasharray');
    g.style.display = s.on ? '' : 'none';
  }
  // Blocks freeze geometry but read color/width/dash/on live (see
  // layout-canvas.js) — only worth the redraw while Layout is the tab
  // actually being looked at; switching TO Layout already does a full
  // render on its own.
  if (typeof activeTab !== 'undefined' && activeTab === 'layout') refreshAllBlockStyles();
}

/* ================= paper layout =================
   The preview pane represents the true selected paper sheet (size +
   orientation), not the raw solver viewport aspect ratio. The drawing is
   scaled to fit within the margins and centered on the page — this is the
   single source of truth shared by both the on-screen preview and export,
   so they can never drift apart. */
const PAPERS = { A0:[1189,841], A1:[841,594], A2:[594,420], A3:[420,297], A4:[297,210], A5:[210,148], A6:[148,105] };
// Single source of truth for margins — always returns all four sides,
// regardless of whether Independent margins is on. When it's off, all four
// are just the one shared marginMm value; when it's on, each is read from
// its own input. Every consumer (computePaperLayout, computeLayoutPaperDims,
// both margin guides, the Layout snap-guide targets) uses this shape
// unconditionally rather than branching on the toggle itself, so none of
// them need to know or care which mode is active.
function getMargins(){
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
function computePaperLayout(dims){
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
// Base "fit to pane" size in CSS px, before the current zoom factor is applied.
// Explicit JS sizing rather than CSS aspect-ratio/flex-centering: those don't
// reliably "contain" a box against an arbitrary pane size across engines.
function baseSheetSize(layout){
  const pane = $('paperPane');
  const availW = Math.max(20, pane.clientWidth - 20), availH = Math.max(20, pane.clientHeight - 20);
  const ratio = layout.paperW / layout.paperH;
  let w = availW, h = w / ratio;
  if (h > availH){ h = availH; w = h * ratio; }
  return { w, h };
}
function renderPaper(){
  const layout = computePaperLayout();
  if (!layout) return;
  if (typeof updateGroundPatternSliderRange === 'function') updateGroundPatternSliderRange();
  // viewBox is always the FULL page — zoom never crops it, it resizes the whole sheet instead
  $('plot').setAttribute('viewBox', '0 0 ' + layout.paperW.toFixed(3) + ' ' + layout.paperH.toFixed(3));
  const content = $('paperContent');
  if (content) content.setAttribute('transform',
    'translate(' + layout.offX + ',' + layout.offY + ') scale(' + layout.scale + ')');
  let guide = document.getElementById('marginGuide');
  if (!guide){
    guide = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
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
    gridGuides = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    gridGuides.id = 'pvGridGuides';
    $('plot').insertBefore(gridGuides, $('plot').firstChild);
  }
  gridGuides.innerHTML = '';
  if (typeof gridGuidePositions === 'function'){
    const { xs, ys } = gridGuidePositions({ paperW: layout.paperW, paperH: layout.paperH, margin: layout.margin });
    for (const x of xs){
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'pvGridGuide');
      line.setAttribute('x1', x); line.setAttribute('x2', x);
      line.setAttribute('y1', 0); line.setAttribute('y2', layout.paperH);
      gridGuides.appendChild(line);
    }
    for (const y of ys){
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
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
  for (const L of LAYERS) applyLayerStyle(L.key);
  return layout;
}
['paperSize','orient','marginMm','marginTopMm','marginBottomMm','marginLeftMm','marginRightMm'].forEach(id =>
  $(id).addEventListener('input', () => {
    resetPv(); renderPaper();
    markStale();   // paper scale now feeds the mm→px hatch-spacing conversion
    if (typeof syncLayoutPaperFrame === 'function') syncLayoutPaperFrame();
    refreshStatusR();   // mm figure depends on paper scale — keep it in step with the just-retransformed drawing
  }));
// Purely cosmetic (the --paper CSS custom property backs both #sheet and
// #layoutSheet's background, per .sheet in styles.css, so Preview and
// Layout always match with a single setting) — no geometry, scale, or
// hatch-spacing math depends on it, so unlike the layout controls above
// this never needs resetPv()/renderPaper()/markStale().
function applyPageColor(){
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
$('pageColor').addEventListener('input', applyPageColor);
updateGuideColor();   // seed --guide-color for the default page color at boot, before any user edit fires applyPageColor
updateSelColor();     // same, for --sel-color
function syncMarginMode(){
  const on = $('marginIndependent').checked;
  $('marginSingleRow').style.display = on ? 'none' : '';
  $('marginIndependentRows').style.display = on ? '' : 'none';
  resetPv(); renderPaper();
  markStale();
  if (typeof syncLayoutPaperFrame === 'function') syncLayoutPaperFrame();
}
$('marginIndependent').addEventListener('change', syncMarginMode);

/* ================= 2D preview pan / zoom =================
   The whole page grows/shrinks with zoom — like Illustrator — rather than a
   fixed-size page with a camera cropping into it. The SVG's viewBox stays
   fixed at the full page extent always; zoom instead resizes the sheet's
   actual on-screen pixel box, which is a genuine layout resize (the browser
   re-renders the vector content at the new resolution), not a CSS-transform
   scale of a cached compositor bitmap — so it stays crisp. Pan is a plain
   pixel offset via transform:translate, which is safe to do with CSS
   transform since translation never resamples pixels, only repositions them. */

function chainSegments(segs){
  const key = (x,y) => Math.round(x*50) + '_' + Math.round(y*50);   // ~0.02px buckets
  const n = segs.length / 4;
  if (!n) return [];
  const P0 = i => [segs[i*4], segs[i*4+1]];
  const P1 = i => [segs[i*4+2], segs[i*4+3]];
  const TWO_PI = Math.PI * 2;
  // Each vertex's adjacency now also carries the outgoing angle of that
  // half-edge — needed to resolve junctions (3+ segment-ends sharing a
  // vertex) the same way chainWithZ (worker side) already does: take the
  // next half-edge in consistent rotational order from the reverse of the
  // direction just arrived on, rather than "first unused candidate" in
  // whatever order they happened to be pushed. The naive first-match choice
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
const SIMPLIFY_COLLINEAR_TOL = 0.05;   // px, perpendicular deviation allowed
// A walk that dead-ends a hair's width from its own start point (confirmed
// against real output: gaps on the order of 1e-5 units after unit
// conversion — far below anything a plotter, or a person, could ever
// perceive) is floating-point noise from two independently-arrived-at
// representations of what's geometrically the same point, not a genuine
// open curve. Snap-close onto it rather than leaving a curve that's closed
// in every way that matters except its own SVG markup. Deliberately much
// smaller than any real feature this pipeline draws (MIN_SEG is 0.3px).
const CHAIN_CLOSE_SNAP_TOL = 0.05;   // px
function simplifyCollinear(pts, closed, tol=SIMPLIFY_COLLINEAR_TOL){
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
      if (Math.abs(cross)/lenAC <= tol) continue;   // b sits on the a→c line — redundant, drop it
    }
    out.push(b);
  }
  if (!closed) out.push(work[n-1]);
  return out;
}

/* Shared by any flat [x0,y0,x1,y1,...] segment list that needs reconstructing
   into proper chained/closed SVG path data — the exact same chainSegments →
   splitSelfTouching → simplifyCollinear pipeline the real Silhouette/Scene-
   Outline layers use (see CHAIN_LAYERS below). Used for the parallel
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
function accumulatePathStats(stats, pts, closed){
  stats.paths++;
  if (closed) stats.closedPaths++;
  stats.segments += pts.length - 1;
  let len = 0;
  for (let i=1;i<pts.length;i++) len += Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]);
  if (closed) len += Math.hypot(pts[0][0]-pts[pts.length-1][0], pts[0][1]-pts[pts.length-1][1]);
  stats.lenPx += len;
}
/* ================================================================
   cleanupContourRelay — post-chain cleanup for Contour (sv/sh) only.
   Cleans up the "fuzzy" stray micro-geometry occlude() leaves at bends on
   curved/faceted meshes: adjacent facet edges occasionally produce several
   near-duplicate, near-parallel candidate chains covering slightly
   different lengths of the same true smooth curve, plus short spurious
   whisker chains. Operates on chainSegments()'s own {pts, closed} output,
   before splitSelfTouching/simplifyCollinear run.

   Model: each open chain end is classified as
     - coincident: within tolMerge of another chain's endpoint
     - on-polyline: within tolS (perpendicular) of another chain's line,
       landing strictly inside that chain's own span (excluding a tolMerge
       margin at ITS endpoints, to avoid double-classifying a near-shared
       vertex as a mid-span touch)
     - free: neither
   Anchoring gates trimming at two levels. Chain level: a chain anchored at
   BOTH ends (any combination of the two kinds) is never trimmed at either
   end — both its tips are already tied into the drawing, so neither can be
   the loose overshoot trimming exists to retract. End level: an ON-POLYLINE
   end is never trimmed regardless of what the far end is doing, because it
   sits mid-span on another chain and retracting it can only tear a real
   T-junction apart. A COINCIDENT end stays trimmable when the far end is
   free — its trim is bounded by tolMerge and produces the exact zero-gap
   snap the ordinary relay depends on — as does a genuinely free end, which
   is what this step is for in the first place.
   (Known limitation 1: `anchored` is computed once, before whisker deletion
   is resolved, so an end anchored solely to a chain that is later deleted
   keeps its now-stale anchored flag and stays protected from trimming.
   Accepted deliberately to keep this a single-shot pass.)
   (Known limitation 2, the cost of the on-polyline gate: an EXACTLY collinear
   overshoot also lands mid-span on its neighbour, so it reads as on-polyline
   and is now protected too, leaving that short doubled run in place. Nothing
   here distinguishes "crosses me" from "is my own line drawn again" — that
   needs a direction test findOnPolyline does not do. Faceted geometry usually
   kinks enough at the join to stay outside tolS and trim normally: on
   pipe.obj the overshooting tip measured 0.205px off its neighbour's line
   against a tolS of 0.0798px.)
   Free ends search their own LAST segment for another chain's endpoint
   landing on it (perpendicular <= tolS, projecting within [0,1], and
   continuing in roughly the same direction — within angleThreshDeg of
   straight-through — ruling out genuine perpendicular T-junctions, which
   must never get trimmed toward). The closest such candidate to the free
   tip is used ("shortest trim"): the tip snaps to that candidate's EXACT
   coordinate (zero-gap) and a hard link is recorded for the merge step.
   "Shortest" is only relative to the end segment, though, and one segment is
   one mesh edge — on a straight run that can be tens of mm, so even the
   closest candidate on it may sit most of the way along. maxTrimLen caps how
   much a single trim may remove from a chain of TRIM_CAP_MIN_VERTS or more
   vertices: a chain that substantial is a real contour line, and no amount of
   fuzz cleanup should be eating centimetres of one. (On pipe.obj a candidate
   27.7deg off straight — inside the 40deg threshold, but really a Y-branch —
   retracted 23mm of a 21-vertex chain.) Whiskers are exempt: the deletion
   pass judges those as a whole, and capping their trim would strand the scrap
   rather than retract it.
   2-vertex whisker chains get deleted outright in two cases:
     (a) exactly one end anchored, the other free, and nothing lands on the
         whisker itself (hasLandingOn) — deleted at ANY length, since a bare
         2-point spur that dangles into nothing and carries no junction of
         its own is not a real feature however long it happens to be. The
         landing test is what protects it, not maxWhiskerLen;
     (b) both ends anchored (even to different neighbors) AND at or under
         maxWhiskerLen — a short connector between two already-anchored
         points is redundant duplicate ink, not a real feature.
   Deletion is fully resolved before any surviving chain's actual trim
   target is chosen, so a deleted whisker never leaves a "phantom" trim
   behind on the chain that would otherwise have used it as a landing point.
   Merging (a separate step, after all trims are applied) resolves hard
   links from trims first (already exact), then remaining coincident
   tip-to-tip pairs within tolMerge (interpolated to their midpoint).
   On-polyline anchors that were never trimmed are genuine T-junctions and
   are never merged — pen lift is correct there. Runs that need stitching
   at both ends (a chain acting as a middle link between two neighbors) are
   walked fully, and an all-paired closed loop is walked once as a closed
   chain rather than silently dropped.
   ================================================================ */
function cleanupContourRelay(chains, tolMerge, tolS, maxWhiskerLen, angleThreshDeg, maxTrimLen){
  // Vertex count at which a chain stops being a scrap and starts being a real
  // contour line that maxTrimLen protects.
  const TRIM_CAP_MIN_VERTS = 4;
  function clen(pts){ let t=0; for(let i=0;i<pts.length-1;i++) t+=Math.hypot(pts[i+1][0]-pts[i][0],pts[i+1][1]-pts[i][1]); return t; }
  function cdist(a,b){ return Math.hypot(a[0]-b[0],a[1]-b[1]); }
  const open = [], closedOut = [];
  chains.forEach((c) => { if (c.closed || c.pts.length < 2) closedOut.push(c); else open.push({ pts: c.pts.map(p=>p.slice()) }); });
  const N = open.length;

  function endPos(ci, end){ const p = open[ci].pts; return end===0 ? p[0] : p[p.length-1]; }
  function otherEnds(ci){ const out=[]; for (let j=0;j<N;j++) if (j!==ci){ out.push([j,0]); out.push([j,1]); } return out; }

  function findCoincident(pt, selfCi){
    let best=null, bestD=tolMerge;
    for (let j=0;j<N;j++){ if (j===selfCi) continue;
      for (const end of [0,1]){ const d = cdist(pt, endPos(j,end)); if (d<=bestD){ bestD=d; best=[j,end]; } }
    }
    return best;
  }
  function findOnPolyline(pt, selfCi){
    for (let j=0;j<N;j++){ if (j===selfCi) continue;
      const p = open[j].pts;
      for (let k=0;k<p.length-1;k++){
        const ax=p[k][0],ay=p[k][1], bx=p[k+1][0],by=p[k+1][1];
        const dx=bx-ax, dy=by-ay, L2=dx*dx+dy*dy || 1e-12, L=Math.sqrt(L2);
        let t = ((pt[0]-ax)*dx+(pt[1]-ay)*dy)/L2;
        const tc = Math.max(0,Math.min(1,t));
        const cx=ax+dx*tc, cy=ay+dy*tc;
        if (cdist(pt,[cx,cy]) > tolS) continue;
        const distFromChainStart = k===0 ? tc*L : Infinity;
        const distFromChainEnd = k===p.length-2 ? (1-tc)*L : Infinity;
        if (Math.min(distFromChainStart, distFromChainEnd) < tolMerge) continue;
        return true;
      }
    }
    return false;
  }
  /* The mirror image of findOnPolyline: does any OTHER chain's endpoint land
     on chain ci's own polyline, strictly inside its span? Same tolS
     perpendicular tolerance and same tolMerge margin at ci's own endpoints, so
     a neighbour clustered at ci's anchored tip reads as the anchor it is, not
     as a dependent landing. Deliberately direction-agnostic, unlike
     findTrimCandidates — a path meeting ci at a right angle is never a trim
     candidate, but it is absolutely something that depends on ci still being
     drawn. Like `anchored`, this ignores whether the landing chain is itself
     about to be deleted, which keeps deletion independent of chain order. */
  function hasLandingOn(ci){
    const p = open[ci].pts;
    for (let j=0;j<N;j++){ if (j===ci) continue;
      for (const e of [0,1]){
        const pt = endPos(j,e);
        for (let k=0;k<p.length-1;k++){
          const ax=p[k][0],ay=p[k][1], bx=p[k+1][0],by=p[k+1][1];
          const dx=bx-ax, dy=by-ay, L2=dx*dx+dy*dy || 1e-12, L=Math.sqrt(L2);
          const t = ((pt[0]-ax)*dx+(pt[1]-ay)*dy)/L2;
          const tc = Math.max(0,Math.min(1,t));
          if (cdist(pt,[ax+dx*tc, ay+dy*tc]) > tolS) continue;
          const distFromChainStart = k===0 ? tc*L : Infinity;
          const distFromChainEnd = k===p.length-2 ? (1-tc)*L : Infinity;
          if (Math.min(distFromChainStart, distFromChainEnd) < tolMerge) continue;
          return true;
        }
      }
    }
    return false;
  }
  function candidateDir(j, e){
    const p = open[j].pts;
    const from = e===1 ? p[p.length-1] : p[0];
    const to   = e===1 ? p[p.length-2] : p[1];
    const dx=to[0]-from[0], dy=to[1]-from[1], l=Math.hypot(dx,dy)||1;
    return [dx/l, dy/l];
  }
  function findTrimCandidates(ci, end){
    const p = open[ci].pts;
    const [ax,ay] = end===1 ? p[p.length-2] : p[1];
    const [bx,by] = end===1 ? p[p.length-1] : p[0];
    const dx=bx-ax, dy=by-ay, L2=dx*dx+dy*dy || 1e-12, L=Math.sqrt(L2);
    const myDir = [dx/L, dy/L];
    const cosThresh = Math.cos(angleThreshDeg * Math.PI/180);
    const out = [];
    for (const [j,e] of otherEnds(ci)){
      if (j===ci) continue;
      const pt = endPos(j,e);
      const t = ((pt[0]-ax)*dx+(pt[1]-ay)*dy)/L2;
      if (t < 0 || t > 1) continue;
      const cx=ax+dx*t, cy=ay+dy*t;
      if (cdist(pt,[cx,cy]) > tolS) continue;
      const cDir = candidateDir(j, e);
      const cosAngle = cDir[0]*myDir[0] + cDir[1]*myDir[1];
      if (cosAngle < cosThresh) continue;
      // "Shortest trim" is only short RELATIVE to the end segment, and a
      // segment here is one mesh edge — on a straight run that can be tens of
      // mm, so the closest candidate on it can still be most of its length.
      // A substantial chain is a real contour line, not fuzz, so cap how much
      // of one a single trim may eat. Whiskers are exempt: they are 2-3 point
      // scraps that the deletion pass judges as a whole, and capping them
      // would only strand the scrap instead of retracting it.
      if (p.length >= TRIM_CAP_MIN_VERTS && (1-t)*L > maxTrimLen) continue;
      out.push({ ci:j, end:e, pt, tFromB: 1-t });
    }
    return out;
  }

  const anchored = Array.from({length:N}, () => [false,false]);
  const onPoly = Array.from({length:N}, () => [false,false]);
  for (let ci=0; ci<N; ci++) for (const end of [0,1]){
    const pt = endPos(ci,end);
    if (findCoincident(pt, ci)) { anchored[ci][end] = true; continue; }
    if (findOnPolyline(pt, ci)) { anchored[ci][end] = true; onPoly[ci][end] = true; continue; }
  }

  const allCands = Array.from({length:N}, () => [null,null]);
  for (let ci=0; ci<N; ci++) for (const end of [0,1]){
    const cands = findTrimCandidates(ci, end);
    if (!cands.length) continue;
    cands.sort((a,b)=>a.tFromB-b.tFromB);
    allCands[ci][end] = cands;
  }
  const deleteChain = new Uint8Array(N);
  for (let ci=0; ci<N; ci++){
    if (open[ci].pts.length !== 2) continue;
    const a0 = anchored[ci][0], a1 = anchored[ci][1];
    if (a0 && a1 && !hasLandingOn(ci)){
      if (clen(open[ci].pts) <= maxWhiskerLen) deleteChain[ci] = 1;
      continue;
    }
    if (!a0 && !a1) continue;
    // Exactly one end anchored, the other dangling free. Length is irrelevant
    // here: what makes this a whisker rather than a feature is that it is a
    // bare 2-point spur nothing else depends on, so the only thing that can
    // save it is another path landing on it (a junction that would be left
    // stranded in mid-air by the deletion).
    if (hasLandingOn(ci)) continue;
    deleteChain[ci] = 1;
  }
  const trimLink = Array.from({length:N}, () => [null,null]);
  for (let ci=0; ci<N; ci++){
    // A chain anchored at BOTH ends is already tied into the drawing at each
    // tip, so neither end can be a redundant tail — trimming exists purely to
    // retract a loose overshoot, which by definition needs a free end. Without
    // this gate a genuine feature (commonly one bridging two T-junctions) gets
    // pulled back off a junction it legitimately belongs to, leaving a visible
    // gap. Deliberately chain-level, not per-end: a chain anchored at one end
    // with a free other end still trims that free end — that case is the whole
    // point of this step.
    if (anchored[ci][0] && anchored[ci][1]) continue;
    for (const end of [0,1]){
      // ...and on top of that, an ON-POLYLINE end is protected in its own
      // right, whatever the far end is doing. It is sitting mid-span on
      // another chain — a genuine T-junction — so retracting it can only tear
      // a real junction apart. The chain-level gate alone cannot express this:
      // it needs BOTH ends anchored, so a chain with one T-junction end and
      // one free end had its junction stripped of protection by the far end.
      // That is not hypothetical — on pipe.obj an end sitting 0.0027px onto
      // another chain's interior lost 41.9mm because the OTHER end missed the
      // coincident threshold by 0.066px. Coincident ends are deliberately not
      // covered here: their trim is bounded by tolMerge and gives the exact
      // zero-gap snap the ordinary relay depends on.
      if (onPoly[ci][end]) continue;
      const cands = allCands[ci][end];
      if (!cands) continue;
      const best = cands.find(c => !deleteChain[c.ci]);
      if (best) trimLink[ci][end] = { ci: best.ci, end: best.end, pt: best.pt };
    }
  }

  for (let ci=0; ci<N; ci++){
    if (deleteChain[ci]) continue;
    for (const end of [0,1]){
      const link = trimLink[ci][end];
      if (!link) continue;
      if (end === 1) open[ci].pts[open[ci].pts.length-1] = link.pt.slice();
      else open[ci].pts[0] = link.pt.slice();
    }
  }

  const paired = new Map();
  function tipKey(ci,end){ return ci*2+end; }
  function setPair(a,b){ paired.set(a,b); paired.set(b,a); }
  for (let ci=0; ci<N; ci++){
    if (deleteChain[ci]) continue;
    for (const end of [0,1]){
      const link = trimLink[ci][end];
      if (!link || deleteChain[link.ci]) continue;
      setPair(tipKey(ci,end), tipKey(link.ci, link.end));
    }
  }
  for (let ci=0; ci<N; ci++){
    if (deleteChain[ci]) continue;
    for (const end of [0,1]){
      if (paired.has(tipKey(ci,end))) continue;
      if (onPoly[ci][end]) continue;
      if (!anchored[ci][end]) continue;
      const pt = endPos(ci,end);
      let best=null, bestD=tolMerge;
      for (let cj=0; cj<N; cj++){ if (cj===ci || deleteChain[cj]) continue;
        for (const e2 of [0,1]){
          if (paired.has(tipKey(cj,e2))) continue;
          if (onPoly[cj][e2]) continue;
          if (!anchored[cj][e2]) continue;
          const d = cdist(pt, endPos(cj,e2));
          if (d<=bestD){ bestD=d; best=[cj,e2]; }
        }
      }
      if (best) setPair(tipKey(ci,end), tipKey(best[0],best[1]));
    }
  }
  const hardLinked = new Set();
  for (let ci=0; ci<N; ci++) for (const end of [0,1]) if (trimLink[ci][end] && !deleteChain[ci]) {
    hardLinked.add(tipKey(ci,end)); hardLinked.add(tipKey(trimLink[ci][end].ci, trimLink[ci][end].end));
  }
  for (const [a,b] of paired){
    if (a>b) continue;
    if (hardLinked.has(a) || hardLinked.has(b)) continue;
    const ca=(a/2)|0, ea=a%2, cb=(b/2)|0, eb=b%2;
    const pa = endPos(ca,ea), pb = endPos(cb,eb);
    const mid = [(pa[0]+pb[0])/2, (pa[1]+pb[1])/2];
    if (ea===1) open[ca].pts[open[ca].pts.length-1]=mid.slice(); else open[ca].pts[0]=mid.slice();
    if (eb===1) open[cb].pts[open[cb].pts.length-1]=mid.slice(); else open[cb].pts[0]=mid.slice();
  }

  function orientedPts(ci, exitEnd){ const p = open[ci].pts; return exitEnd===1 ? p.slice() : p.slice().reverse(); }
  const used = new Uint8Array(N);
  const result = [];
  for (let ci=0; ci<N; ci++){
    if (used[ci] || deleteChain[ci]) continue;
    const p0 = paired.get(tipKey(ci,0)), p1 = paired.get(tipKey(ci,1));
    if (p0 != null && p1 != null) continue;
    used[ci] = 1;
    const exitEnd = p0 != null ? 0 : 1;
    let pts = orientedPts(ci, exitEnd);
    let curTip = tipKey(ci, exitEnd);
    for (let guard=N+2; guard>0; guard--){
      const partner = paired.get(curTip);
      if (partner == null) break;
      const nci = (partner/2)|0, nend = partner%2;
      if (used[nci]) break;
      used[nci] = 1;
      const nextExitEnd = nend===1 ? 0 : 1;
      const nextPts = orientedPts(nci, nextExitEnd);
      pts = pts.concat(nextPts.slice(1));
      curTip = tipKey(nci, nextExitEnd);
    }
    result.push({ pts, closed:false });
  }
  for (let ci=0; ci<N; ci++){
    if (used[ci] || deleteChain[ci]) continue;
    used[ci] = 1;
    let pts = orientedPts(ci, 1);
    let curTip = tipKey(ci, 1);
    for (let guard=N+2; guard>0; guard--){
      const partner = paired.get(curTip);
      if (partner == null) break;
      const nci = (partner/2)|0, nend = partner%2;
      if (used[nci]) break;
      used[nci] = 1;
      const nextExitEnd = nend===1 ? 0 : 1;
      const nextPts = orientedPts(nci, nextExitEnd);
      pts = pts.concat(nextPts.slice(1));
      curTip = tipKey(nci, nextExitEnd);
    }
    result.push({ pts, closed:true });
  }
  return result.concat(closedOut);
}

/* ================================================================
   mergeSilhouetteClose — post-chain cleanup for Silhouette (so/iv/ih).
   Much simpler than Contour's relay-trim pass: no trimming, no whisker
   deletion, no angle-continuity discrimination — every open chain, by
   nature, is expected to be part of a closed boundary, so any nearby tip
   (including a chain's own OTHER end, for self-closure) is a legitimate
   merge target. Two small steps:

   1. trimTipFoldback — a narrow, targeted fix for a specific artifact:
      occasionally a chain's very last segment folds back almost 180° over
      its own previous segment, with the true tip ending up projected back
      onto that prior segment (see the fold-back diagram this was built
      from). This has no equivalent in Contour's pipeline since Silhouette
      never goes through Contour's own dedup/overlap-removal machinery.
      Left alone, the spurious extra point sits between the chain's real
      endpoint and its neighbor, hiding what would otherwise be an exact
      (zero-gap) merge point. Trimmed before any merge search runs.

   2. mergeClose — proximity-merges every open chain tip within tolMerge
      of another (any other chain's tip, or its own opposite tip for
      self-closure), producing interpolated midpoints, then walks the
      resulting pairing graph (multi-hop runs and full closed loops alike)
      into final chains. so/iv/ih all get identical treatment — no
      exceptions, every gap within tolerance gets closed. (An earlier
      version tried to protect genuine occlusion-cut endpoints for
      Individual Silhouette specifically, but per the actual dropSelf/keep
      formula in the worker, Individual Silhouette only ever hides on
      same-shell self-occlusion, never on being occluded by a different
      shell — so there was never a real cross-shell cut to protect, only
      self-occlusion noise indistinguishable from what so already merges
      through fine. Dropped as unnecessary; kept as a parameter in case
      that's worth revisiting if the underlying occlusion semantics ever
      change.)
   ================================================================ */
function trimTipFoldback(chains, angleThreshDeg){
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
function mergeSilhouetteClose(chains, tolMerge, protectedPoints){
  function mdist(a,b){ return Math.hypot(a[0]-b[0],a[1]-b[1]); }
  const PROT_EPS = 1e-4;   // exact-coordinate match (same computation, not independently-drifted geometry), not a proximity tolerance
  function isProtected(pt){
    if (!protectedPoints || !protectedPoints.length) return false;
    for (let i=0;i<protectedPoints.length;i+=2){
      if (mdist(pt, [protectedPoints[i],protectedPoints[i+1]]) < PROT_EPS) return true;
    }
    return false;
  }
  const open = [], closedOut = [];
  chains.forEach(c => { if (c.closed || c.pts.length < 2) closedOut.push(c); else open.push({ pts: c.pts.map(p=>p.slice()) }); });
  const N = open.length;
  const tips = [];
  for (let ci=0; ci<N; ci++){
    const p = open[ci].pts;
    tips.push({ pos:p[0], protected: isProtected(p[0]) });
    tips.push({ pos:p[p.length-1], protected: isProtected(p[p.length-1]) });
  }
  const cell = Math.max(tolMerge, 1e-6);
  const key = (x,y) => Math.floor(x/cell)+'_'+Math.floor(y/cell);
  const grid = new Map();
  tips.forEach((t,i) => { if (t.protected) return; const k=key(t.pos[0],t.pos[1]); let a=grid.get(k); if(!a){a=[];grid.set(k,a);} a.push(i); });
  const paired = new Map();
  const used = new Set();
  const cand = [];
  for (let i=0;i<tips.length;i++){
    if (tips[i].protected) continue;
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

function buildChainedPathD(segs, stats, relayCleanupTol, silMergeOpts){
  const d = [];
  let chains = chainSegments(segs);
  if (relayCleanupTol){
    chains = cleanupContourRelay(chains, relayCleanupTol.tolMerge, relayCleanupTol.tolS,
      relayCleanupTol.maxWhiskerLen, relayCleanupTol.angleThreshDeg, relayCleanupTol.maxTrimLen);
  } else if (silMergeOpts){
    chains = trimTipFoldback(chains, silMergeOpts.foldbackAngleThreshDeg);
    chains = mergeSilhouetteClose(chains, silMergeOpts.tolMerge, silMergeOpts.protectedPoints);
  }
  for (const chain of chains)
    for (const { pts: rawPts, closed } of splitSelfTouching(chain.pts, chain.closed)){
      const pts = simplifyCollinear(rawPts, closed);
      if (stats) accumulatePathStats(stats, pts, closed);
      d.push('M', pts[0][0].toFixed(2), pts[0][1].toFixed(2));
      for (let i=1;i<pts.length;i++) d.push('L', pts[i][0].toFixed(2), pts[i][1].toFixed(2));
      if (closed) d.push('Z');
    }
  return d.join(' ');
}


/* Crease/hidden-crease arrive here already topologically pre-ordered by the
   worker (see the crease-chain design spec): genuinely continuous runs are
   pushed as array-adjacent segments with matching endpoints, using
   straightness-based pairing at junctions rather than screen coincidence.
   Unlike chainSegments() above — a GLOBAL coordinate search, safe for
   sv/sh/so since those are always simple non-branching curves by
   construction — crease networks have real junctions, so a global search
   here could silently undo the worker's pairing by reconnecting to
   whichever OTHER candidate happens to sit at the same point first. This
   merge is deliberately LOCAL: it only ever looks at the immediately
   preceding array entry, so it can never produce a wrong connection —
   only, rarely (where cross-layer subtraction happened to reorder
   something), miss a merge it could have made, falling back to one
   segment per stroke there exactly like before this feature existed. */
function mergeAdjacentTouching(segs){
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

   Why this is needed: not every crease edge ever enters the worker's
   world-space topology graph. In particular, an edge that's classified as
   Silhouette at generate() time (because it sits on a front/back boundary)
   but later gets "demoted" back to Crease by the Contour Silhouette merge —
   because it turns out to be an interior fold rather than real outline, the
   `cFall` path in generate() §6.5 — is pushed straight into groups.cv/ch as
   a lone 2-point piece, never having been part of the topology pass at all.
   A right-angle box corner or window-frame rectangle is exactly this case:
   every edge of it can be a demoted silhouette edge, so all four sides land
   here disconnected, and mergeAdjacentTouching's array-adjacency check can't
   place them next to each other because nothing ordered them that way.

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
   interior points), and it only runs on segments the topology pass already
   couldn't place — the same trade-off the user asked for to fix box/building
   facades, where every corner is an exact on-screen coincidence anyway. */
function mergeCreaseScreenSpace(polys){
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
function splitSelfTouching(pts, closed){
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

const HATCH_ANGLE_OFFSET = { h1: 0, h2: 90, h3: 45 };
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
// Resolves a texture-effect base id to the actual element to read: if
// Individual texture settings is on, that specific layer's own suffixed
// copy; otherwise the single shared General control. Centralizes the
// "which copy of this setting applies to this layer" decision in one
// place, since every texture-effect read throughout this pipeline needs
// the same resolution.
function texId(baseId, layerKey){
  const individualOn = $('texIndividualOn') && $('texIndividualOn').checked;
  return individualOn ? baseId + '_' + layerKey : baseId;
}
function applyHatchTexture(segs, carrierIdx, familyAngleDeg, mmToPx, layerKey){
  const overshootOn = $(texId('texOvershootOn', layerKey)).checked;
  const spacingOn = $(texId('texSpacingOn', layerKey)).checked;
  const angleOn = $(texId('texAngleOn', layerKey)).checked;
  const oMin = overshootOn ? (+$(texId('texOvershootMin', layerKey)).value || 0) * mmToPx : 0;
  const oMax = overshootOn ? (+$(texId('texOvershootMax', layerKey)).value || 0) * mmToPx : 0;
  const sMin = spacingOn ? (+$(texId('texSpacingMin', layerKey)).value || 0) * mmToPx : 0;
  const sMax = spacingOn ? (+$(texId('texSpacingMax', layerKey)).value || 0) * mmToPx : 0;
  const aMin = angleOn ? (+$(texId('texAngleMin', layerKey)).value || 0) : 0;
  const aMax = angleOn ? (+$(texId('texAngleMax', layerKey)).value || 0) : 0;
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
// ring got split into by shadow/density thinning moves together, keyed
// by source+ringIdx so ground and cast rings never collide), applied by
// shifting the whole ring's radius and resampling. Unlike trim/extend and
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
    const j = jitterFor(piece.source+':'+piece.ringIdx);
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
function onResult(m){
  busy = false; $('genBtn').disabled = false;
  $('paperPane').classList.remove('busy');
  $('progressBar').style.width = '0';
  lastGen = m;
  if (pendingSoIvExport){
    pendingSoIvExport = false;
    exportSoIvOverlayNow();
  }
  if (genSeq === staleSeq) clearStale();
  else scheduleAuto();               // view moved while solving — stays stale, auto retries

  const svg = $('plot');
  const firstEverGen = !svg.dataset.rendered;
  svg.dataset.rendered = '1';
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // path data stays in solver-pixel units; a single wrapper <g> maps that
  // whole drawing onto the paper (translate + scale), so paper size/orientation/
  // margin changes are pure re-layout — no path data is ever touched or rebuilt.
  const content = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  content.id = 'paperContent';
  content.classList.toggle('blendMultiply', $('blendMultiplyOn').checked);
  svg.appendChild(content);

  // Silhouette (classic or contour) and Scene Outline segments already trace
  // connected curves geometrically — they're just emitted as independent 2-point
  // pieces. Chain touching pieces into maximal polylines (open where a curve is
  // genuinely broken by occlusion, closed where it loops back on itself) so the
  // SVG holds one continuous pen stroke per curve instead of many.
  // Crease/hidden-crease get a TWO-STAGE version of the same idea, since —
  // unlike silhouette/outline — crease networks have genuine branching
  // junctions: first mergeAdjacentTouching (conservative, LOCAL, trusts the
  // worker's world-space topology ordering), then mergeCreaseScreenSpace
  // (a screen-space fallback that mops up whatever the first pass couldn't
  // place, e.g. edges the topology graph never saw at all). See each
  // function's own comment for why neither one alone is safe/sufficient on
  // its own. Hatch is untouched — it already has its own, different
  // optimization (straight-line runs reduced to 2 points per carrier).
  const CHAIN_LAYERS = { sv:1, sh:1, so:1, iv:1, ih:1 };
  const SEQ_CHAIN_LAYERS = { cv:1, ch:1 };

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
  // Paint order is the REVERSE of the hierarchy in LAYERS: the highest-
  // priority layer (Scene outline, first in LAYERS) must end up LAST in the
  // SVG so it paints on top, and the lowest (Deep shadow, last in LAYERS)
  // paints first/underneath everything else.
  for (const L of LAYERS.slice().reverse()){
    const lenBefore = pathStats.lenPx;
    if (L.key === 'cr'){
      if (!layerStyle('cr').on || !m.circlePatternSegs || !m.circlePatternSegs.length) continue;
      const layout = computePaperLayout();
      const mmToPx = layout ? 1/Math.max(1e-6, layout.scale) : 1;
      let pieces = m.circlePatternSegs;
      if ($(texId('texTrimOn', 'cr')).checked){
        const trimPx = (+$(texId('texTrimValue', 'cr')).value || 0) * mmToPx;
        pieces = applyCircleTrimExtend(pieces, trimPx);
      }
      if ($(texId('texOvershootOn', 'cr')).checked){
        const oMin = (+$(texId('texOvershootMin', 'cr')).value || 0) * mmToPx;
        const oMax = (+$(texId('texOvershootMax', 'cr')).value || 0) * mmToPx;
        pieces = applyCircleOvershootUndershoot(pieces, oMin, oMax);
      }
      if ($(texId('texSpacingOn', 'cr')).checked){
        const sMin = (+$(texId('texSpacingMin', 'cr')).value || 0) * mmToPx;
        const sMax = (+$(texId('texSpacingMax', 'cr')).value || 0) * mmToPx;
        pieces = applyCircleSpacingJitter(pieces, sMin, sMax);
      }
      // texAngleOn is deliberately never read here — a circle has no
      // meaningful "angle" for that effect to act on (also skipped entirely
      // in the Circles per-layer clone — see data-skipforcircles).
      const wobbleOn = $(texId('texWobbleOn', 'cr')).checked;
      const d = [];
      if (wobbleOn){
        // Wobble displaces points along the arc, so the result is no longer
        // a circle — falls back to the original dense-polyline path, same
        // as before this feature existed.
        const spacingPx = (+$(texId('texWobbleSpacing', 'cr')).value || 1) * mmToPx;
        const ampPx = (+$(texId('texWobbleAmp', 'cr')).value || 0) * mmToPx;
        const variationAmount = +$(texId('texWobbleVariation', 'cr')).value || 0;
        const envScalePx = (+$(texId('texWobbleVarScale', 'cr')).value || 10) * mmToPx;
        const isShared = $(texId('texWobbleShared', 'cr')).checked;
        const sharedSeed = isShared ? [Math.random()*10000, Math.random()*10000] : null;
        const sharedEnvSeed = isShared ? [Math.random()*10000, Math.random()*10000] : null;
        let polylines = applyCircleWobble(pieces, spacingPx, ampPx, sharedSeed, variationAmount, envScalePx, sharedEnvSeed);
        if ($(texId('texGapsOn', 'cr')).checked){
          const minLenPx = (+$(texId('texGapsSpacing', 'cr')).value || 30) * mmToPx;
          const maxGapPx = (+$(texId('texGapsMax', 'cr')).value || 2) * mmToPx;
          polylines = applyHatchGaps(polylines, minLenPx, maxGapPx);
        }
        for (const poly of polylines){
          const pts = []; for (let i=0;i<poly.length;i+=2) pts.push([poly[i],poly[i+1]]);
          const closed = pts.length>2 && Math.hypot(pts[0][0]-pts[pts.length-1][0], pts[0][1]-pts[pts.length-1][1]) < 0.02;
          accumulatePathStats(pathStats, closed ? pts.slice(0,-1) : pts, closed);
          d.push('M', poly[0].toFixed(2), poly[1].toFixed(2));
          for (let i = 2; i < poly.length; i += 2) d.push('L', poly[i].toFixed(2), poly[i+1].toFixed(2));
        }
      } else {
        // No wobble — each piece is still a genuine circular arc all the
        // way through, so it can be emitted as a handful of Bezier curves
        // instead of a dense polyline.
        let gappedPieces = pieces;
        if ($(texId('texGapsOn', 'cr')).checked){
          const minLenPx = (+$(texId('texGapsSpacing', 'cr')).value || 30) * mmToPx;
          const maxGapPx = (+$(texId('texGapsMax', 'cr')).value || 2) * mmToPx;
          gappedPieces = applyCircleGaps(pieces, minLenPx, maxGapPx);
        }
        for (const piece of gappedPieces){
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
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.id = 'g_cr';
      g.setAttribute('fill', 'none');
      g.setAttribute('stroke-linecap', 'round');
      g.setAttribute('stroke-linejoin', 'round');
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d.join(' '));
      g.appendChild(p);
      content.appendChild(g);
      rawLenByLayer[L.key] = pathStats.lenPx - lenBefore;
      continue;
    }
    const segs = m.groups[L.key];
    if (!segs || !segs.length) continue;
    // The 'd' string/DOM group is always built regardless of this layer's
    // on/off checkbox (display:none just hides it visually — see
    // applyLayerStyle — and freezeCurrentGeneration relies on the geometry
    // still being there so a layer switched off before "Add to Layout" can
    // be re-enabled per-block later). Stats, though, should only count what's
    // actually visible right now — matching computeLayoutStats, which only
    // sums a block's layers that are currently layerVisible — so an off
    // layer's contribution is deliberately excluded from pathStats below.
    const layerOn = layerStyle(L.key).on;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.id = 'g_' + L.key;
    g.setAttribute('fill', 'none');
    g.setAttribute('stroke-linecap', 'round');
    g.setAttribute('stroke-linejoin', 'round');
    const d = [];
    if (CHAIN_LAYERS[L.key]){
      let relayCleanupTol = null, silMergeOpts = null;
      if ((L.key === 'sv' || L.key === 'sh') && !$('debugDisableContourRelayCleanup').checked){
        const layout = computePaperLayout();
        const mmToPx = layout ? 1/Math.max(1e-6, layout.scale) : 1;
        relayCleanupTol = {
          tolMerge: 0.3 * mmToPx,        // endpoint-proximity merge tolerance
          tolS: 0.02 * mmToPx,            // on-polyline perpendicular tolerance
          maxWhiskerLen: 1 * mmToPx,      // isolated-whisker deletion length cap
          angleThreshDeg: 20,             // redundant-tail relay vs. genuine T-junction
          maxTrimLen: 3 * mmToPx,         // most a single trim may eat off a 4+ vertex chain
        };
      } else if (L.key === 'so' || L.key === 'iv' || L.key === 'ih'){
        const layout = computePaperLayout();
        const mmToPx = layout ? 1/Math.max(1e-6, layout.scale) : 1;
        // Silhouette and Individual Silhouette get identical treatment here —
        // no exceptions, every gap gets closed, same as so.
        silMergeOpts = {
          tolMerge: 0.25 * mmToPx,
          foldbackAngleThreshDeg: 150,
          protectedPoints: null,
        };
      }
      d.push(buildChainedPathD(segs, layerOn ? pathStats : null, relayCleanupTol, silMergeOpts));
    } else if (SEQ_CHAIN_LAYERS[L.key]){
      // 1) local, topology-trusting merge of array-adjacent touching pieces
      // 2) screen-space fallback that mops up whatever (1) couldn't place —
      //    e.g. edges demoted from Silhouette to Crease by the Contour
      //    Silhouette merge, which never entered the worker's topology graph
      //    at all (see mergeCreaseScreenSpace's own comment for why)
      // 3) split-self-touching safety net — see splitSelfTouching's own
      //    comment for the Blender-import bug this specifically guards
      for (const chain of mergeCreaseScreenSpace(mergeAdjacentTouching(segs)))
        for (const { pts: rawPts, closed } of splitSelfTouching(chain.pts, chain.closed)){
          const pts = simplifyCollinear(rawPts, closed);
          if (layerOn) accumulatePathStats(pathStats, pts, closed);
          d.push('M', pts[0][0].toFixed(2), pts[0][1].toFixed(2));
          for (let i=1;i<pts.length;i++) d.push('L', pts[i][0].toFixed(2), pts[i][1].toFixed(2));
          if (closed) d.push('Z');
        }
    } else {
      // one path per layer, one subpath per segment: subpaths stay separate
      // pen strokes for plotter software; nothing is joined or reordered.
      let outSegs = segs;
      let outCarrier = (m.hatchCarrier && m.hatchCarrier[L.key]) || null;
      let mmToPx = 1;
      if (HATCH_ANGLE_OFFSET[L.key] !== undefined){
        const layout = computePaperLayout();
        mmToPx = layout ? 1/Math.max(1e-6, layout.scale) : 1;
        if ($(texId('texTrimOn', L.key)).checked){
          const trimPx = (+$(texId('texTrimValue', L.key)).value || 0) * mmToPx;
          const r = applyHatchTrimExtend(outSegs, outCarrier, trimPx);
          outSegs = r.segs; outCarrier = r.carrierIdx;
        }
        if (outCarrier){
          const familyAngleDeg = (+$('hatchAng').value || 0) + HATCH_ANGLE_OFFSET[L.key];
          outSegs = applyHatchTexture(outSegs, outCarrier, familyAngleDeg, mmToPx, L.key);
        }
      }
      // From here on everything is expressed as an array of polylines (each
      // a flat [x0,y0,x1,y1,...] array) — wobble subdivides into multi-point
      // polylines, gaps can split any polyline into several; a segment that
      // went through neither is just its own trivial 2-point polyline, so
      // the d-string builder below can treat every case uniformly.
      let polylines;
      if ($(texId('texWobbleOn', L.key)).checked && HATCH_ANGLE_OFFSET[L.key] !== undefined){
        const spacingPx = (+$(texId('texWobbleSpacing', L.key)).value || 1) * mmToPx;
        const ampPx = (+$(texId('texWobbleAmp', L.key)).value || 0) * mmToPx;
        const variationAmount = +$(texId('texWobbleVariation', L.key)).value || 0;
        const envScalePx = (+$(texId('texWobbleVarScale', L.key)).value || 10) * mmToPx;
        const isShared = $(texId('texWobbleShared', L.key)).checked;
        const sharedSeed = isShared ? [Math.random()*10000, Math.random()*10000] : null;
        const sharedEnvSeed = isShared ? [Math.random()*10000, Math.random()*10000] : null;
        polylines = applyHatchWobble(outSegs, spacingPx, ampPx, sharedSeed, variationAmount, envScalePx, sharedEnvSeed);
      } else {
        polylines = [];
        for (let i = 0; i < outSegs.length; i += 4) polylines.push([outSegs[i], outSegs[i+1], outSegs[i+2], outSegs[i+3]]);
      }
      if ($(texId('texRegWobbleOn', L.key)).checked && HATCH_ANGLE_OFFSET[L.key] !== undefined){
        const familyAngleDeg = (+$('hatchAng').value || 0) + HATCH_ANGLE_OFFSET[L.key];
        const regAmpPx = (+$(texId('texRegWobbleAmp', L.key)).value || 0) * mmToPx;
        const regWavelengthPx = (+$(texId('texRegWobbleWavelength', L.key)).value || 5) * mmToPx;
        polylines = applyHatchRegularWobble(polylines, familyAngleDeg, regAmpPx, regWavelengthPx);
      }
      if ($(texId('texGapsOn', L.key)).checked && HATCH_ANGLE_OFFSET[L.key] !== undefined){
        const minLenPx = (+$(texId('texGapsSpacing', L.key)).value || 30) * mmToPx;
        const maxGapPx = (+$(texId('texGapsMax', L.key)).value || 2) * mmToPx;
        polylines = applyHatchGaps(polylines, minLenPx, maxGapPx);
      }
      for (const poly of polylines){
        const pts = []; for (let i=0;i<poly.length;i+=2) pts.push([poly[i],poly[i+1]]);
        const closed = pts.length>2 && Math.hypot(pts[0][0]-pts[pts.length-1][0], pts[0][1]-pts[pts.length-1][1]) < 0.02;
        if (layerOn) accumulatePathStats(pathStats, closed ? pts.slice(0,-1) : pts, closed);
        d.push('M', poly[0].toFixed(2), poly[1].toFixed(2));
        for (let i = 2; i < poly.length; i += 2) d.push('L', poly[i].toFixed(2), poly[i+1].toFixed(2));
      }
    }
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d.join(' '));
    g.appendChild(p);
    content.appendChild(g);
    applyLayerStyle(L.key);
    rawLenByLayer[L.key] = pathStats.lenPx - lenBefore;
  }
  if (firstEverGen) resetPvFitWithRulers();   // first drawing ever shown: fit the whole page, rulers included
  renderPaper();                        // regenerating an existing view keeps the user's pan/zoom
  const outlineWarn = (m.counts.outlineTooComplex ? ' · scene outline skipped (too complex)' : '') +
    (m.counts.shadowCapped ? ' · shadow budget hit (partial)' : '');
  lastLiveStats = {
    segments: pathStats.segments, paths: pathStats.paths, closedPaths: pathStats.closedPaths,
    rawLenByLayer, ms: m.ms,
    hatchCapped: m.counts.hatchCapped, outlineWarn,
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
function refreshStatusR(){
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
    for (const key in s.rawLenByLayer) lenMm += s.rawLenByLayer[key] * dashOnFraction(layerStyle(key).dash) * scaleNow;
    $('statusR').textContent = s.segments.toLocaleString() + ' segments · ' +
      s.paths.toLocaleString() + ' paths (' + s.closedPaths.toLocaleString() + ' closed) · ' +
      lenMm.toLocaleString(undefined, {maximumFractionDigits:0}) + ' mm · ' + s.ms + ' ms' +
      (s.hatchCapped ? ' · hatch capped' : '') + s.outlineWarn;
  }
}

/* ================= file loading ================= */

/* -------- export the current paper page to a .svg file -------- */
// Converts this app's own d-string format (space-separated M/L/Z tokens —
// see onResult's path-building above) into an array of subpaths, each a
// plain list of [x,y] vertices. A closed subpath (trailing Z) gets an
// explicit final vertex equal to its first, so the closing edge
// participates in the dash-length walk like any other segment.
function parseSubpathsD(d){
  const tokens = d.trim().split(/\s+/);
  const subpaths = [];
  let cur = null;
  for (let i = 0; i < tokens.length; ){
    const t = tokens[i];
    if (t === 'M'){
      cur = [[parseFloat(tokens[i+1]), parseFloat(tokens[i+2])]];
      subpaths.push(cur);
      i += 3;
    } else if (t === 'L'){
      cur.push([parseFloat(tokens[i+1]), parseFloat(tokens[i+2])]);
      i += 3;
    } else if (t === 'Z' || t === 'z'){
      if (cur && cur.length &&
          (cur[0][0] !== cur[cur.length-1][0] || cur[0][1] !== cur[cur.length-1][1])){
        cur.push([cur[0][0], cur[0][1]]);
      }
      i += 1;
    } else {
      i += 1;   // unexpected token — skip defensively rather than throw
    }
  }
  return subpaths;
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
function computeDStats(d, inkFraction){
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
// dash/gap pattern survive, each as its own M...L... subpath, so a plotter
// reads genuine pen-up gaps instead of a solid line styled to LOOK dashed.
// The pattern restarts at the beginning of every subpath — matching native
// SVG stroke-dasharray behavior exactly, rather than continuing across the
// (pen-up) gap between two already-disconnected subpaths.
function splitDashedPathD(d, dashLen, gapLen){
  const period = dashLen + gapLen;
  if (!(period > 1e-6) || !(dashLen > 1e-6)) return d;   // degenerate pattern — leave unchanged
  const subpaths = parseSubpathsD(d);
  const outParts = [];
  for (const pts of subpaths){
    if (pts.length < 2) continue;
    const cum = [0];
    for (let i = 1; i < pts.length; i++){
      cum.push(cum[i-1] + Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]));
    }
    const total = cum[cum.length - 1];
    if (total < 1e-6) continue;
    let idx = 1;   // forward-only cursor: index of the vertex ending the segment currently under the walk
    function interpAt(s){
      while (idx < cum.length - 1 && cum[idx] < s) idx++;
      const segLen = cum[idx] - cum[idx-1];
      const t = segLen > 1e-9 ? (s - cum[idx-1]) / segLen : 0;
      return [pts[idx-1][0] + (pts[idx][0]-pts[idx-1][0])*t, pts[idx-1][1] + (pts[idx][1]-pts[idx-1][1])*t];
    }
    let pos = 0;
    while (pos < total - 1e-6){
      const onStart = pos, onEnd = Math.min(total, pos + dashLen);
      if (onEnd > onStart + 1e-6){
        const first = interpAt(onStart);
        const startIdx = idx;
        const last = interpAt(onEnd);          // advances idx further as the walk proceeds
        const chain = [first];
        for (let k = startIdx; k < idx; k++) chain.push(pts[k]);   // original vertices strictly inside (onStart, onEnd)
        chain.push(last);
        outParts.push('M ' + chain.map(p => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' L '));
      }
      pos += period;
    }
  }
  return outParts.join(' ');
}

// Purely a preview compositing toggle — no geometry changes, so this
// flips the class directly on the existing paperContent (Preview mode) and
// the shared Layout blocks container (Layout mode — a single toggle there
// affects every block, since isolation now lives at that one shared level,
// not per-block — see styles.css), rather than going through markStale/
// data-regen like every other setting.
$('blendMultiplyOn').addEventListener('change', () => {
  const on = $('blendMultiplyOn').checked;
  const content = document.getElementById('paperContent');
  if (content) content.classList.toggle('blendMultiply', on);
  const blocksLayer = document.getElementById('layoutBlocksLayer');
  if (blocksLayer) blocksLayer.classList.toggle('blendMultiplyLayout', on);
});
$('exportBtn').addEventListener('click', () => {
  const isLayout = activeTab === 'layout';
  if (isLayout){
    if (!blocks.length){ $('statusL').textContent = 'no layers to export'; return; }
  } else if (!lastGen){ $('statusL').textContent = 'generate first'; return; }

  const layout = isLayout ? computeLayoutPaperDims() : computePaperLayout();
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
      const [dashLen, gapLen] = g.getAttribute('stroke-dasharray').split(/[\s,]+/).map(Number);
      g.querySelectorAll('path').forEach(p => {
        p.setAttribute('d', splitDashedPathD(p.getAttribute('d'), dashLen, gapLen));
      });
      g.removeAttribute('stroke-dasharray');
    });
  }
  const meta = document.createComment(' Penumbra plot · ' + modelName + ' · ' +
    new Date().toISOString() + ' · ' + (isLayout
      ? ('layout: ' + blocks.length + ' layer(s)')
      : ('settings: ' + JSON.stringify(gatherSettings()))) + ' ');
  clone.insertBefore(meta, clone.firstChild);

  const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + clone.outerHTML],
    { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = modelName.replace(/\.(stl|obj)$/i, '') + (isLayout ? '-layout.svg' : '-plot.svg');
  a.click();
  URL.revokeObjectURL(a.href);
});

