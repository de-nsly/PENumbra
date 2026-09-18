/* ================================================================
   layout-model.js — the Layout tab's blocks, and the canvas they sit on
   The core of the Layout tab: the block list itself, each block's DOM,
   and the sheet they are arranged on. The panels around it are
   layout-list.js, the gestures layout-interaction.js, copy/paste
   layout-clipboard.js.
   A fixed-order stack of frozen "blocks" (user-facing name: "layers" —
   see the naming note in CLAUDE.md), each one a full snapshot of a past
   generation's geometry, arranged on the same paper sheet the live
   preview uses. A block's GEOMETRY is frozen at the moment it's added
   (the already-merged per-layer path data, exactly as it existed then),
   but its color/width/dash/on-off are read LIVE from the layer panel on
   every render — identical to how the live preview already treats those
   same controls. A block cannot be edited element-by-element; the whole
   thing moves/rotates/scales as one unit.

   PERFORMANCE ARCHITECTURE (this is the point of this whole rewrite):
   each block gets ONE persistent SVG <g> tree, created once and kept
   around for the block's lifetime. Interacting with a block (drag,
   rotate, scale) only ever mutates that one block's own transform
   attribute, every frame — nothing else in the DOM is touched, nothing
   is torn down and rebuilt. A live style change (color/width/dash/on)
   only updates the specific attributes on the specific existing layer-
   groups affected, for every block, not a full re-render. Adding/
   deleting a block is an incremental DOM append/remove of that one
   block's node. The selection overlay (dashed rect, corner handles,
   snap guides) is a separate top-level layer, updated independently, so
   selecting/dragging never touches block content nodes and vice versa.
   ================================================================ */
import { $, dashOnFraction, penById, scaledDash, svgEl } from '../main.js';
import { layerById, layers } from '../layers.js';
import { computeDStats } from '../path-model.js';
import { refreshStatusR } from '../render-result.js';
import { PAPERS, buildTrimMaskGroup, computePaperLayout, getMargins, renderPaper, syncPreviewTrimMask } from '../paper-layout.js';
import { activeTab, setActiveTab, lastResult, markStale } from '../panel-controls.js';
import { setActiveSheet, applyPv, resetPvFitWithRulers } from '../paper-preview.js';
import { clearSelection, resetHoverCursor, selectedBlocks, selectionFrame, setSelection, setSelectionAnchor, updateSelectionOverlay } from './layout-interaction.js';
import { closeBlockContextMenu, contextMenuBlock, layoutOverlayFront, layoutOverlayOn, layoutOverlayOpacity, renderBlocksList, syncBlocksFloatVisibility } from './layout-list.js';


export let blocks = [];
export let blockCounter = 0;                 // names only ever climb, never renumbered (same policy as Saved Views)
// A block's OWN identity for lookups (row <-> block, e.g. refreshSelectionHighlight)
// — separate from blockCounter/name because name is user-editable and, since
// duplicating a block deliberately doesn't advance blockCounter (see
// duplicateBlock), two blocks can legitimately end up with the same name.
// Never reset except by a fresh page load; scene import reassigns every
// block a new id off this same counter rather than trusting whatever was in
// the file, so it stays valid however many times a scene gets re-imported.
let blockIdCounter = 0;
// The counter is this module's to advance; a block built elsewhere (a
// clipboard paste) takes its id through here rather than reaching in.
export function nextBlockId(){ return ++blockIdCounter; }

export const MIN_BLOCK_SCALE = 0.05;

// Layout-tab equivalent of computePaperLayout() — there's no solver
// viewport to fit here (a block isn't sized to any particular generation
// the way the live preview's content is), just the current paper size,
// orientation and margin as plain physical dimensions in mm.
export function computeLayoutPaperDims(){
  const [pl, ps] = PAPERS[$('paperSize').value];
  const landscape = $('orient').value === 'landscape';
  const paperW = landscape ? pl : ps, paperH = landscape ? ps : pl;
  const margin = getMargins();
  return { paperW, paperH, margin };
}
// Guide Grid mm positions — N guides on an axis split that axis into N+1
// equal parts, so guide i (1-indexed) sits at i/(N+1) of the page's full
// span, e.g. N=1 -> one guide at the midpoint, N=2 -> guides at the thirds.
// Shared by drawing (syncLayoutGridGuides) and snapping (computeMoveSnap/
// computeScaleSnap add these alongside the existing page-edge/margin/
// center reference lines) so the two can never disagree about where a
// guide actually sits.
export function gridGuidePositions(dims){
  if (!$('gridGuideEnabled').checked) return { xs: [], ys: [] };
  const nx = Math.max(0, Math.round(+$('gridGuideX').value || 0));
  const ny = Math.max(0, Math.round(+$('gridGuideY').value || 0));
  const xs = [], ys = [];
  for (let i = 1; i <= nx; i++) xs.push(dims.paperW * i / (nx + 1));
  for (let i = 1; i <= ny; i++) ys.push(dims.paperH * i / (ny + 1));
  return { xs, ys };
}

// How many canvas-mm correspond to 1 on-screen CSS pixel, at the CURRENT
// pan/zoom — lets handle sizes/hit radii/snap thresholds be specified in
// screen px (where they actually need to feel consistent) and converted to
// the mm units everything on the canvas is actually drawn in.
export function mmPerScreenPx(){
  const rect = $('layoutSheet').getBoundingClientRect();
  if (!rect.width) return 1;
  const dims = computeLayoutPaperDims();
  return dims.paperW / rect.width;
}
export function screenToCanvasMm(clientX, clientY){
  const rect = $('layoutPlot').getBoundingClientRect();
  const dims = computeLayoutPaperDims();
  return [
    (clientX - rect.left) / Math.max(1e-6, rect.width)  * dims.paperW,
    (clientY - rect.top)  / Math.max(1e-6, rect.height) * dims.paperH,
  ];
}
// Inverse of the above — needed to position the fixed-position dimension
// labels (which live outside the SVG, in screen space) from world-mm
// coordinates computed on the canvas.
export function canvasMmToScreen(wx, wy){
  const rect = $('layoutPlot').getBoundingClientRect();
  const dims = computeLayoutPaperDims();
  return [
    rect.left + (wx / dims.paperW) * rect.width,
    rect.top  + (wy / dims.paperH) * rect.height,
  ];
}

/* ================= one-time SVG scaffold =================
   Persistent layers inside #layoutPlot, bottom to top: the margin
   guide, the blocks themselves, the trim-preview mask, and snap guides. Created once here; never
   torn down. The selection overlay (box/handles/gizmo) is deliberately
   NOT in here — it draws into the separate #layoutOverlaySvg instead,
   which isn't clipped to the paper, so a block positioned off-page still
   shows its selection chrome. */
function initLayoutPlot(){
  const svg = $('layoutPlot');
  // Explicit, full-paper-coverage invisible hit target — fill="transparent"
  // (not "none") deliberately: SVG shapes with fill:none don't register
  // pointer events over their fill area at all, only their stroke, which
  // would make empty canvas space unreliably clickable (needed so clicking
  // blank space correctly deselects). This guarantees pointerdown/pointermove
  // fire predictably everywhere within the paper, not just where a block
  // happens to have actual painted geometry.
  const hitBg = svgEl('rect');
  hitBg.id = 'layoutHitBg';
  hitBg.setAttribute('fill', 'transparent');
  svg.appendChild(hitBg);
  const guide = svgEl('rect');
  guide.id = 'layoutMarginGuide';
  guide.setAttribute('class', 'layoutMarginGuide');
  svg.appendChild(guide);
  const gridGuides = svgEl('g');
  gridGuides.id = 'layoutGridGuides';
  svg.appendChild(gridGuides);
  const blocksLayer = svgEl('g');
  blocksLayer.id = 'layoutBlocksLayer';
  svg.appendChild(blocksLayer);
  // "Trim SVG export to margins" mask — above the blocks (it has to cover
  // their ink to stand in for the export clip) but below the interaction
  // chrome, so snap/axis guides and anything drawn for a drag in progress
  // stay readable over it. Content is rebuilt by syncLayoutTrimMask; this
  // only reserves its place in the stacking order.
  const trimMask = svgEl('g');
  trimMask.id = 'layoutTrimMaskSlot';
  svg.appendChild(trimMask);
  const snapGuides = svgEl('g');
  snapGuides.id = 'layoutSnapGuides';
  svg.appendChild(snapGuides);
  const axisGuides = svgEl('g');
  axisGuides.id = 'layoutAxisGuides';
  svg.appendChild(axisGuides);
}

// Updates the viewBox + margin guide from the current paper settings —
// cheap, safe to call any time paper size/orientation/margin might have
// changed, or when switching into the Layout tab.
export function syncLayoutPaperFrame(){
  const dims = computeLayoutPaperDims();
  $('layoutPlot').setAttribute('viewBox', '0 0 ' + dims.paperW.toFixed(3) + ' ' + dims.paperH.toFixed(3));
  const hitBg = $('layoutHitBg');
  hitBg.setAttribute('x', 0); hitBg.setAttribute('y', 0);
  hitBg.setAttribute('width', dims.paperW); hitBg.setAttribute('height', dims.paperH);
  const guide = $('layoutMarginGuide');
  guide.setAttribute('x', dims.margin.left); guide.setAttribute('y', dims.margin.top);
  guide.setAttribute('width', Math.max(0, dims.paperW - dims.margin.left - dims.margin.right));
  guide.setAttribute('height', Math.max(0, dims.paperH - dims.margin.top - dims.margin.bottom));
  syncLayoutGridGuides(dims);
  syncLayoutTrimMask(dims);
}
// Layout's half of the trim preview — same frame, same page-colour fill,
// same "the export clips, the screen only masks" contract as the Preview
// tab (see buildTrimMaskGroup/syncPreviewTrimMask in paper-layout.js, the
// shared builder). Blocks keep their full geometry underneath: a block
// dragged half off the margin is still whole, still draggable back, just
// not visible (and not exported) past the margin.
export function syncLayoutTrimMask(dims){
  const slot = document.getElementById('layoutTrimMaskSlot');
  if (!slot) return;
  slot.innerHTML = '';
  if (!$('trimToMargins').checked) return;
  slot.appendChild(buildTrimMaskGroup('layoutTrimMask', dims || computeLayoutPaperDims(), 'layoutMarginGuide'));
}
function syncLayoutGridGuides(dims){
  dims = dims || computeLayoutPaperDims();
  const g = $('layoutGridGuides');
  g.innerHTML = '';
  const { xs, ys } = gridGuidePositions(dims);
  for (const x of xs){
    const line = svgEl('line');
    line.setAttribute('class', 'layoutGridGuide');
    line.setAttribute('x1', x); line.setAttribute('x2', x);
    line.setAttribute('y1', 0); line.setAttribute('y2', dims.paperH);
    g.appendChild(line);
  }
  for (const y of ys){
    const line = svgEl('line');
    line.setAttribute('class', 'layoutGridGuide');
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('x1', 0); line.setAttribute('x2', dims.paperW);
    g.appendChild(line);
  }
}

/* ================= add current generation to the layout =================
   Called from #addToLayoutBtn, which only exists in Preview mode — this is
   the deliberate fix for the original workflow gap: orbit around, hit "Add
   to layout" repeatedly without ever switching tabs, THEN switch to Layout
   once to arrange everything that was added. Reads the LIVE preview's
   already-merged per-layer <path d="..."> strings straight out of the DOM
   (rather than reaching into the worker's raw segment data) — chainSegments/
   mergeAdjacentTouching/mergeCreaseScreenSpace have already done their job
   by the time anything is on screen, so this is just capturing their
   output, not redoing any of that work.
   The frozen offX/offY/scale (a snapshot of computePaperLayout() at THIS
   moment) convert the path data's solver-px coordinates into the same mm
   position the live preview was showing when added — baked in once, never
   recomputed even if paper size changes later. The block's OWN placement
   (x/y/rotation/scale) is a separate, further transform layered on top,
   defaulted to identity so a freshly-added block first appears exactly
   where the live preview showed it.
   NOTE ON NAMING: the user-facing term for one of these is "layer" (a
   saved/arrangeable snapshot on the layout canvas) — but internally this
   file keeps calling it "block" throughout (blocks[], blockCounter,
   renderBlocksList, #blocksFloat, etc). That's deliberate, not an
   oversight: this codebase already has a completely different, pre-
   existing "layer" concept — the pen layers (layers.js, layerEls,
   applyLayerStyle, the .layer CSS class for Crease/Hatch/etc rows).
   Reusing "layer" for the internal identifiers here too would collide
   with that existing system throughout these very functions (e.g. this
   function already reads every pen layer WHILE building one of
   these). Only user-visible strings say "layer"; every internal name
   stays "block" to keep the two concepts unambiguous in the code. */
export function freezeCurrentGeneration(){
  if (!lastResult){ $('statusL').textContent = 'nothing generated yet'; return; }
  const layout = computePaperLayout();
  if (!layout) return;
  const layerPaths = {};
  const layerVisible = {};
  let any = false;
  for (const L of layers){
    const g = document.getElementById('g_' + L.id);
    const path = g ? g.querySelector('path') : null;
    const d = path ? path.getAttribute('d') : '';
    if (d && d.trim()){
      layerPaths[L.id] = d;
      // Visibility is captured ONCE here and becomes the block's OWN,
      // independent state from this point on — unlike color/width/dash
      // (which stay live, read fresh from the panel on every render, unless
      // this block's Override is on — see updateBlockStyle and the
      // right-click layer menu), a layer toggled off in the panel later
      // should NOT retroactively hide it here, and vice versa. Per-block
      // visibility is edited afterward via the right-click layer menu.
      layerVisible[L.id] = L.on;
      any = true;
    }
  }
  if (!any){ $('statusL').textContent = 'no visible geometry to add'; return; }

  const measureSvg = svgEl('svg');
  measureSvg.style.position = 'absolute'; measureSvg.style.width = '0'; measureSvg.style.height = '0';
  measureSvg.style.overflow = 'hidden'; measureSvg.setAttribute('aria-hidden', 'true');
  // measureOuter has NO transform of its own — getBBox() excludes the
  // QUERIED element's own transform (that's the whole bug this fixes: a
  // previous version queried measureG itself, which HAD the freeze
  // transform, so getBBox() silently ignored it and returned raw,
  // untransformed solver-px coordinates instead of mm space). Querying the
  // untransformed wrapper instead correctly includes measureG's transform,
  // since from the wrapper's point of view it's a DESCENDANT's transform,
  // which getBBox() does account for.
  const measureOuter = svgEl('g');
  const measureG = svgEl('g');
  measureG.setAttribute('transform', 'translate(' + layout.offX + ',' + layout.offY + ') scale(' + layout.scale + ')');
  for (const key in layerPaths){
    const p = svgEl('path');
    p.setAttribute('d', layerPaths[key]);
    measureG.appendChild(p);
  }
  measureOuter.appendChild(measureG);
  measureSvg.appendChild(measureOuter);
  document.body.appendChild(measureSvg);
  const bb = measureOuter.getBBox();
  document.body.removeChild(measureSvg);

  blockCounter++;
  const bboxLocal = { x0: bb.x, y0: bb.y, x1: bb.x + bb.width, y1: bb.y + bb.height };
  const block = {
    id: ++blockIdCounter,
    name: 'Block ' + String(blockCounter).padStart(2, '0'),
    visible: true,
    // Prevents accidental move/rotate/scale via the canvas — selection and
    // the right-click layer-visibility menu are unaffected either way (see
    // hitTest, updateHoverCursor, updateSelectionOverlay, and the
    // pointerdown handler below). Orthogonal to `override` below — this is
    // about the block's on-page TRANSFORM, not its pen style.
    locked: false,
    // (x,y) is the world-space position of the block's CENTER (see the
    // transform model comment above blockCenterLocal) — initializing it to
    // the bbox's own center makes rotation=0/scale=1 collapse to an exact
    // identity transform, so a freshly-added block appears pixel-for-pixel
    // where the live preview showed it, not offset by wherever the
    // geometry happens to sit within its own bounding box.
    x: (bboxLocal.x0 + bboxLocal.x1) / 2, y: (bboxLocal.y0 + bboxLocal.y1) / 2,
    rotationDeg: 0, scale: 1,
    freezeOffX: layout.offX, freezeOffY: layout.offY, freezeScale: layout.scale,
    layerPaths,
    layerVisible,
    // override: true makes each layer in this block read its OWN
    // pen/dash from overrideStyle below instead of the live panel —
    // set and edited via the right-click layer menu's "Override" checkbox,
    // never at creation time. overrideStyle starts empty and is populated
    // lazily, one layer at a time, the first time that specific layer is
    // shown with Override on for this block (see openBlockContextMenu) —
    // and then persists in memory (and in the saved scene) even if Override
    // gets toggled off again, so re-enabling it later restores what was
    // last set rather than re-snapshotting fresh live values.
    override: false,
    overrideStyle: {},
    bboxLocal,
  };
  blocks.push(block);
  createBlockDom(block);
  renderBlocksList();
  refreshStatusR();
  $('statusL').textContent = 'saved ' + block.name;
  showAddToLayoutMsg(block.name + ' added to layout');
}
let addToLayoutMsgTimer = null;
function showAddToLayoutMsg(text){
  const el = $('addToLayoutMsg');
  clearTimeout(addToLayoutMsgTimer);
  el.textContent = text;
  el.classList.add('show');
  addToLayoutMsgTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

// Same place, rotation, scale, visibility, lock state, and layer overrides
// as the source block — but structuredClone on layerPaths/layerVisible/
// overrideStyle (and dom explicitly nulled out, createBlockDom builds a
// fresh one) means the two share no references at all afterward; editing
// either block's overrides, geometry, or DOM later can never touch the
// other. Name is the source's own name with " Copy" appended, NOT a fresh
// blockCounter value — duplicating doesn't advance the "Layer NN" sequence
// a later Add to Layout would use, so numbering stays contiguous whether
// or not anything got duplicated in between. Not de-duplicated against
// existing names (duplicating the same block twice gives two blocks both
// named "X Copy") — names aren't a uniqueness key (see blockIdCounter/id
// above), and the existing double-click-to-rename already covers it.
export function cloneBlock(block){
  return {
    ...block,
    id: ++blockIdCounter,
    name: block.name + ' Copy',
    layerPaths: structuredClone(block.layerPaths),
    layerVisible: structuredClone(block.layerVisible),
    overrideStyle: structuredClone(block.overrideStyle),
    bboxLocal: { ...block.bboxLocal },
    dom: null,
  };
}
// "Layer 04" for one, "3 layers" for several — the phrasing every status
// line about a batch of blocks uses, in one place so they all match.
export function blockCountLabel(list){
  return list.length === 1 ? list[0].name : list.length + ' blocks';
}
// The shared tail of every action that brings NEW blocks onto the page —
// duplicate and paste. Appends them in the given order, so they land as one
// contiguous run on top of the existing stack with their relative stacking
// intact, builds each one's persistent DOM, and makes them the new
// selection ("what you just made is what you're now holding"): both actions
// can leave a block sitting exactly on top of another, and being selected
// is what lets it be dragged straight off.
export function addBlocks(newBlocks, verb){
  if (!newBlocks.length) return [];
  for (const b of newBlocks){ blocks.push(b); createBlockDom(b); }
  renderBlocksList();
  refreshStatusR();
  setSelectionAnchor(newBlocks[newBlocks.length - 1]);
  setSelection(newBlocks);
  $('statusL').textContent = verb + ' ' + blockCountLabel(newBlocks);
  return newBlocks;
}
// Duplicates one block or a whole multi-selection in a single action.
// Sources are taken in blocks[] order rather than selection order so the
// copies keep their sources' relative stacking (see addBlocks for the rest).
export function duplicateBlocks(list){
  const wanted = new Set(list);
  const sources = blocks.filter(b => wanted.has(b));
  if (!sources.length) return [];
  const dups = addBlocks(sources.map(cloneBlock), 'duplicated');
  showAddToLayoutMsg(blockCountLabel(dups) + ' added to layout');
  return dups;
}
// The one delete path — the row's own X button, the Delete/Backspace key,
// and anything added later all route through here, so the bookkeeping (DOM
// teardown, context menu, surviving selection, stats, list refresh) can't
// drift between them. No confirmation, deliberately: this only ever touches
// blocks explicitly aimed at, unlike Delete All, which does confirm.
export function deleteBlocks(list){
  const doomed = new Set(list);
  if (!doomed.size) return;
  for (const b of doomed){
    const i = blocks.indexOf(b);
    if (i >= 0) blocks.splice(i, 1);
    if (contextMenuBlock === b) closeBlockContextMenu();
    removeBlockDom(b);
  }
  // Whatever's still around stays selected — deleting a row that ISN'T part
  // of the current selection must leave that selection alone (see
  // rowActionScope). Membership in blocks[] is the test here, not
  // isInteractiveBlock: a deleted block is still visible/unlocked, it just
  // no longer exists.
  setSelection(blocks.filter(b => selectedBlocks.has(b)));
  refreshStatusR();
  renderBlocksList();
}
// Shown only once there's something to duplicate at all, disabled unless
// at least one block is selected — a multi-selection duplicates as a whole
// (see duplicateBlocks).
export function syncDuplicateBlockBtn(){
  const btn = $('duplicateBlockBtn');
  btn.style.display = blocks.length ? '' : 'none';
  btn.disabled = selectedBlocks.size === 0;
}

/* ================= persistent per-block DOM ================= */
export function createBlockDom(block){
  // Older .pen files (or in-memory blocks from before this field existed)
  // won't have layerVisible at all — default to all-visible rather than
  // letting updateBlockStyle below throw on a missing lookup.
  if (!block.layerVisible){
    block.layerVisible = {};
    for (const key in block.layerPaths) block.layerVisible[key] = true;
  }
  const outer = svgEl('g');
  const inner = svgEl('g');
  inner.setAttribute('transform',
    'translate(' + block.freezeOffX + ',' + block.freezeOffY + ') scale(' + block.freezeScale + ')');
  outer.appendChild(inner);
  const layerGroups = {};
  // layers is ordered highest-priority-first (see layers.js); paint order
  // needs the OPPOSITE — later-appended SVG elements draw on top, so
  // iterating in reverse here puts Silhouette last/on top and Hatch/
  // Crosshatch/Deep shadow first/underneath, matching exactly how
  // render-result.js's renderResult() builds the live preview's paint order
  // (layers.slice().reverse()). A previous version iterated forward here,
  // which inverted every block's layer stacking versus the live preview.
  for (const L of layers.slice().reverse()){
    const d = block.layerPaths[L.id];
    if (!d) continue;
    const g = svgEl('g');
    g.setAttribute('fill', 'none');
    g.setAttribute('stroke-linecap', 'round');
    g.setAttribute('stroke-linejoin', 'round');
    g.classList.add('layoutLayerStroke');   // target for the shared, cross-block blend rule — see styles.css
    const p = svgEl('path');
    p.setAttribute('d', d);
    g.appendChild(p);
    inner.appendChild(g);
    layerGroups[L.id] = g;
  }
  block.dom = { outer, inner, layerGroups };
  $('layoutBlocksLayer').appendChild(outer);
  updateBlockTransform(block);
  updateBlockStyle(block);
}
// The block's placement as an SVG transform — world = (x,y) + R·S·(local −
// center), see the transform-model comment above blockCenterLocal.
function blockTransformAttr(block){
  const [cx, cy] = blockCenterLocal(block);
  return 'translate(' + block.x + ',' + block.y + ') rotate(' + block.rotationDeg + ') scale(' + block.scale + ') ' +
    'translate(' + (-cx) + ',' + (-cy) + ')';
}
export function updateBlockTransform(block){
  if (!block.dom) return;
  block.dom.outer.setAttribute('transform', blockTransformAttr(block));
  block.dom.outer.style.display = block.visible ? '' : 'none';
}
export function updateBlockStyle(block){
  if (!block.dom) return;
  const combinedScale = Math.max(1e-6, block.scale * block.freezeScale);
  for (const L of layers){
    const g = block.dom.layerGroups[L.id];
    if (!g) continue;
    // Override reads this block's OWN per-layer style (set via the
    // right-click layer menu — see openBlockContextMenu) instead of the
    // live panel controls; an ordinary (synced) block keeps today's
    // behavior exactly. width still divides by the block's own current
    // combinedScale either way — that's not a "setting", it's what keeps
    // the stroke at the correct physical size as the block gets resized on
    // the layout sheet. pen and dash are both just references (a pen id,
    // a slot like "D3") in both cases, same as the ordinary live dropdowns —
    // penById/scaledDash resolve them from the live PEN_LIBRARY/DASH_RATIOS
    // either way, so an overridden layer still follows its pen's and its
    // slot's own values if either is edited later, exactly like a synced
    // layer would.
    const ov = block.override && block.overrideStyle ? block.overrideStyle[L.id] : null;
    const pen = penById(blockLayerPenId(block, L.id));
    const color = pen.color;
    const widthMm = pen.width;
    const dashKey = ov ? ov.dash : L.dash;
    const width = widthMm / combinedScale;
    // Dash/gap are true mm lengths, independent of pen width — scale by the
    // same mm->local-unit factor as width above, NOT by width itself (see
    // scaledDash's own comment in main.js), or dash length would come out
    // proportional to widthMm instead of the literal mm value typed.
    const dash = scaledDash(dashKey, 1 / combinedScale);
    g.setAttribute('stroke', color);
    g.setAttribute('stroke-width', width);
    if (dash) g.setAttribute('stroke-dasharray', dash); else g.removeAttribute('stroke-dasharray');
    // Visibility is the block's OWN frozen state (see freezeCurrentGeneration),
    // not the live panel checkbox — for a synced block, color/width/dash
    // above stay live on purpose; only on/off is decoupled per the
    // per-block layer menu, for every block regardless of override state.
    g.style.display = block.layerVisible[L.id] ? '' : 'none';
  }
}
// The pen one of a block's layers draws with: its own override pen while
// Override is on, the live panel's otherwise. Shared by updateBlockStyle
// and the one-path-per-pen export (buildPenPathsExport, export.js), so
// the file can never group a layer under a different pen than it shows.
export function blockLayerPenId(block, key){
  const ov = block.override && block.overrideStyle ? block.overrideStyle[key] : null;
  return ov ? ov.pen : layerById(key).pen;
}
export function removeBlockDom(block){
  if (block.dom){ block.dom.outer.remove(); block.dom = null; }
}
// Scene import: the incoming list REPLACES every block. The outgoing blocks'
// persistent DOM and any selection referencing them are torn down first —
// reassigning `blocks` alone would orphan their <g> trees in
// #layoutBlocksLayer (renderLayoutCanvas creates DOM for blocks that lack
// one, it never removes DOM for blocks no longer in the array). Ids are
// reassigned fresh: older scenes predate the id field, and a scene can be
// re-imported twice in one session, so only the live counter keeps them
// unique. The caller then resolves override pens and re-renders the list.
export function replaceBlocks(list, counter){
  clearSelection();
  closeBlockContextMenu();
  for (const b of blocks) removeBlockDom(b);
  blocks = list;
  for (const b of blocks) b.id = ++blockIdCounter;
  blockCounter = counter;
}
// Replaces the block array itself, for the two callers that reorder or empty
// it wholesale (the list's drag-reorder and Delete All, layout-list.js). The
// blocks are already built — unlike replaceBlocks above, nothing is
// re-identified or re-counted here.
export function setBlocks(list){ blocks = list; }
export function refreshAllBlockStyles(){
  for (const b of blocks) updateBlockStyle(b);
}
export function renderLayoutCanvas(){
  syncLayoutPaperFrame();
  for (const b of blocks){
    if (!b.dom) createBlockDom(b);
    else { updateBlockTransform(b); updateBlockStyle(b); }
  }
}
// Static, non-interactive re-rendering of every saved block into the
// Preview tab's own #plot — for live-compositing reference only (see the
// "Layout overlay" toggle further down). Always fully torn down and rebuilt
// rather than incrementally patched: #plot itself gets wiped on every
// regenerate (see renderResult in render-result.js), and blocks can only ever
// change while the Layout tab is active anyway (Preview/Layout are mutually
// exclusive), so there's no continuous sync to maintain — just a refresh on
// tab-switch/regenerate/control-change (see the call sites of this
// function). Each block becomes a fresh <g> carrying the exact same
// placement transform updateBlockTransform computes, wrapping a CLONE of
// the block's own `inner` group (its per-layer stroke groups, each still
// carrying the .layoutLayerStroke class used by the "blend overlapping
// colors" toggle — see styles.css) — deliberately a real cloneNode, not a
// <use> reference: mix-blend-mode inside a <use> shadow tree has known
// cross-browser inconsistency about whether it blends with content OUTSIDE
// the <use>, which is exactly what this needs (blending against the live
// drawing). A plain clone has no such ambiguity. block.dom's OWN style is
// refreshed right before cloning (updateBlockStyle) because Preview being
// the active tab means refreshAllBlockStyles() isn't otherwise called for
// it (see applyLayerStyle in layer-rows.js) — without this a live color/
// width/dash edit would clone stale style. Block-level visibility
// (block.visible, which block.dom.outer's OWN display:none tracks) is
// applied here directly to this function's own wrapper instead, since
// `outer` itself is never touched. A block's world-mm (x,y) lands at the
// same physical position here as in #layoutPlot because
// computePaperLayout() and computeLayoutPaperDims() share the exact same
// paperW/paperH/margin source of truth — no extra coordinate conversion
// needed, only a shared viewBox (both #plot and #layoutPlot use
// "0 0 paperW paperH").
export function renderPreviewLayoutOverlay(){
  const plot = document.getElementById('plot');
  if (!plot) return;
  const old = document.getElementById('previewLayoutOverlay');
  if (old) old.remove();
  if (!layoutOverlayOn || !blocks.length) return;
  const g = svgEl('g');
  g.id = 'previewLayoutOverlay';
  g.style.pointerEvents = 'none';
  g.style.opacity = String(layoutOverlayOpacity);
  for (const block of blocks){
    if (!block.dom) createBlockDom(block);   // e.g. a scene import that never visited the Layout tab
    else updateBlockStyle(block);
    const wrap = svgEl('g', { transform: blockTransformAttr(block) });
    wrap.style.display = block.visible ? '' : 'none';
    wrap.appendChild(block.dom.inner.cloneNode(true));
    g.appendChild(wrap);
  }
  // "Behind"/"in front" is relative to the live drawing (#paperContent)
  // specifically, not the margin/grid guides — appending after content
  // paints on top of it; inserting before it sits behind the drawing but
  // still in front of the guides (which are always the very back layer).
  const content = document.getElementById('paperContent');
  if (layoutOverlayFront || !content) plot.appendChild(g);
  else plot.insertBefore(g, content);
  // The trim mask has to stay the last child of #plot to cover everything,
  // and the append above just moved this overlay past it.
  syncPreviewTrimMask();
}
// Feeds refreshStatusR() (render-result.js) — sums computeDStats() over every
// visible layer of every visible block, skipping a hidden block entirely
// and, within a visible block, skipping any individual layer hidden via
// the right-click layer menu (block.layerVisible). freezeScale (px->mm at
// freeze time) combined with the block's own current on-page scale is the
// same combinedScale math updateBlockTransform already uses.
export function computeLayoutStats(){
  const out = { segments: 0, paths: 0, closedPaths: 0, lenMm: 0 };
  for (const block of blocks){
    if (!block.visible) continue;
    for (const L of layers){
      if (!block.layerVisible[L.id]) continue;
      const d = block.layerPaths[L.id];
      if (!d) continue;
      // Same override-vs-live dash resolution updateBlockStyle already uses.
      const dashKey = (block.override && block.overrideStyle[L.id]) ? block.overrideStyle[L.id].dash : L.dash;
      const s = computeDStats(d, dashOnFraction(dashKey));
      out.segments += s.segments;
      out.paths += s.paths;
      out.closedPaths += s.closedPaths;
      out.lenMm += s.lenPx * block.freezeScale * block.scale;
    }
  }
  return out;
}

/* ================= "Rotate layers with page" (Page settings) =================
   In-session-only convenience, off by default: when checked, flipping
   Orientation between Portrait/Landscape rigidly carries every block's
   position AND rotation along with the page, exactly as if a physical
   sheet had been picked up and given a quarter turn. Left unchecked (the
   old, default behavior), a block's (x,y) is simply never touched by an
   orientation change — which, since the Layout coordinate system is always
   anchored to the page's OWN top-left corner, reads as "stays near the old
   top-left corner" once the page's own shape swaps out from under it.
   Nothing here is persisted per-block or in the .pen file (see scene-io.js's
   save path) — it's a one-shot transform applied at the moment orientation
   changes, same as if the user had manually rotated/moved each block. */
function rotateBlocksForOrientationFlip(){
  if (!blocks.length) return;
  const nowLandscape = $('orient').value === 'landscape';
  const [pl, ps] = PAPERS[$('paperSize').value];
  const newW = nowLandscape ? pl : ps, newH = nowLandscape ? ps : pl;
  // Portrait and Landscape are always exactly width/height swapped, so the
  // page's PRE-flip dimensions are just the post-flip ones swapped back —
  // no need to have cached the previous orientation separately.
  const oldW = newH, oldH = newW;
  // Portrait->Landscape is a physical counter-clockwise turn (a portrait
  // sheet's top-left corner ends up at the landscape sheet's bottom-left
  // corner); Landscape->Portrait is the exact reverse turn. This app's
  // rotationDeg/SVG rotate() convention is positive=clockwise (see the
  // rotate/rotateGroup interaction handlers above), so CCW here is -90.
  const deltaDeg = nowLandscape ? -90 : 90;
  const rad = deltaDeg * Math.PI/180, cos = Math.cos(rad), sin = Math.sin(rad);
  const oldCx = oldW/2, oldCy = oldH/2, newCx = newW/2, newCy = newH/2;
  const rotatePoint = (x, y) => {
    const dx = x - oldCx, dy = y - oldCy;
    return [newCx + (dx*cos - dy*sin), newCy + (dx*sin + dy*cos)];
  };
  for (const b of blocks){
    [b.x, b.y] = rotatePoint(b.x, b.y);
    b.rotationDeg = ((b.rotationDeg + deltaDeg) % 360 + 360) % 360;
    if (b.dom) updateBlockTransform(b);
  }
  // The multi-select bounding frame is its own persistent piece of state
  // (see selectionFrame's own comment) — carry it along rigidly too, same
  // as every block, so a current group selection doesn't end up pointing
  // at stale coordinates relative to the blocks it's supposed to enclose.
  if (selectionFrame) selectionFrame.corners = selectionFrame.corners.map(([x,y]) => rotatePoint(x,y));
  updateSelectionOverlay();
}

/* ================= geometry helpers =================
   Transform model: world = (x,y) + R(rotationDeg) * S(scale) * (local - center),
   where center is the block's own bboxLocal center. This is deliberately
   NOT a plain "translate then rotate then scale" chain around the local
   origin — (x,y) represents where the block's CENTER should end up in
   world space, so rotation and scale correctly pivot around that center
   regardless of where the frozen geometry happens to sit within its own
   bbox (which is essentially never at the local origin). */
function blockCenterLocal(block){
  const { x0, y0, x1, y1 } = block.bboxLocal;
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}
export function localToWorld(block, lx, ly){
  const [cx, cy] = blockCenterLocal(block);
  const dx = lx - cx, dy = ly - cy;
  const sx = dx * block.scale, sy = dy * block.scale;
  const rad = block.rotationDeg * Math.PI/180, cos = Math.cos(rad), sin = Math.sin(rad);
  return [sx*cos - sy*sin + block.x, sx*sin + sy*cos + block.y];
}
export function worldToLocal(block, wx, wy){
  const dx = wx - block.x, dy = wy - block.y;
  const rad = -block.rotationDeg * Math.PI/180, cos = Math.cos(rad), sin = Math.sin(rad);
  const rx = dx*cos - dy*sin, ry = dx*sin + dy*cos;
  const [cx, cy] = blockCenterLocal(block);
  return [rx / block.scale + cx, ry / block.scale + cy];
}
export function blockCorners(block){
  const { x0, y0, x1, y1 } = block.bboxLocal;
  return [[x0,y0],[x1,y0],[x1,y1],[x0,y1]].map(([lx,ly]) => localToWorld(block, lx, ly));
}
export function worldEnvelope(block){
  const c = blockCorners(block);
  const xs = c.map(p => p[0]), ys = c.map(p => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/* ================= init =================
   Everything above only declares. This wires the DOM and starts the
   module's live behaviour — called once by app.js, in script order. */
export function initLayoutModel(){
  initLayoutPlot();
  ['gridGuideEnabled','gridGuideX','gridGuideY'].forEach(id =>
    $(id).addEventListener('input', () => {
      syncLayoutPaperFrame();
      // Preview draws the same guides (display-only there, see renderPaper in
      // paper-layout.js) — keep it in step even while Layout is the active tab.
      renderPaper();
    }));
  /* ================= tab switching =================
     Preview and Layout are mutually exclusive — only one sheet is ever
     visible, and the live 3D->SVG pipeline is fully paused while Layout is
     active (see activeTab / markStale gating in panel-controls.js). Coming
     back to Preview calls markStale() once to catch up on anything changed
     while paused, rather than leaving stale output on screen. Block DOM is
     persistent (see renderLayoutCanvas), so switching to Layout is just a
     paper-frame sync, never a rebuild. */
  document.querySelectorAll('.paperTab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === activeTab) return;
      setActiveTab(tab);
      document.querySelectorAll('.paperTab').forEach(b => b.classList.toggle('active', b === btn));
      document.body.classList.toggle('layoutMode', tab === 'layout');
      closeBlockContextMenu();
      $('sheet').style.display = tab === 'preview' ? '' : 'none';
      $('layoutSheet').style.display = tab === 'layout' ? '' : 'none';
      $('layoutOverlaySvg').style.display = tab === 'layout' ? '' : 'none';
      $('previewOverlaySvg').style.display = tab === 'preview' ? '' : 'none';
      $('addToLayoutFloat').style.display = tab === 'preview' ? '' : 'none';
      $('addToLayoutMsg').style.display = tab === 'preview' ? '' : 'none';
      $('genRow').style.display = tab === 'preview' ? '' : 'none';
      syncBlocksFloatVisibility();
      setActiveSheet(tab === 'preview' ? 'sheet' : 'layoutSheet');
      if (tab === 'preview') resetHoverCursor();
      resetPvFitWithRulers(); applyPv();
      if (tab === 'layout') renderLayoutCanvas();
      else markStale();
      // Blocks can only ever change while Layout is active — refresh the
      // Preview-tab overlay here so it's never stale after editing blocks,
      // even if Auto-generate is off and markStale() above doesn't trigger an
      // actual regenerate (which would otherwise be the only other refresh).
      renderPreviewLayoutOverlay();
      refreshStatusR();
    });
  });
  $('orient').addEventListener('input', () => {
    if ($('rotateBlocksWithPage').checked) rotateBlocksForOrientationFlip();
  });
}
