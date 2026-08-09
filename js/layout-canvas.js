/* ================================================================
   layout-canvas.js — the Layout tab
   A fixed-order stack of frozen "blocks" (user-facing name: "layers" —
   see the naming note further down), each one a full snapshot of a past
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

   Load order: after panel-controls.js (needs markStale/activeTab) and
   svg-export.js (needs applyLayerStyle/computePaperLayout/
   baseSheetSize/PAPERS/LAYERS/layerEls/scaledDash), before scene-io.js
   (which calls renderBlocksList/renderLayoutCanvas on scene import).
   ================================================================ */

const SVG_NS = 'http://www.w3.org/2000/svg';

let blocks = [];
let blockCounter = 0;                 // names only ever climb, never renumbered (same policy as Saved Views)
// Session-only multi-select — a Set, not a persistent named group. Single
// selection is just the size===1 case throughout, not a separate code
// path, EXCEPT where noted (rotate/scale hit-testing and math keep an
// entirely separate, untouched single-block path specifically so existing,
// already-tested single-block behavior can't regress from the new group
// math sharing a codepath with it).
let selectedBlocks = new Set();
let pendingCollapseTo = null;         // see the pointerdown handler: clicking an already-selected member of a
                                       // multi-selection defers collapsing to just that one block until pointerup,
                                       // and only if no drag actually happened — otherwise grabbing one member of
                                       // a group to drag the whole group would be impossible.
let interaction = null;               // {mode:'move'|'rotate'|'scale', ...} while a drag is in progress, else null

// Screen-pixel constants for handle/rotate-zone sizing and snap threshold —
// converted to canvas-mm at whatever the CURRENT zoom is via mmPerScreenPx(),
// so they feel the same regardless of how zoomed in/out the layout canvas is.
// Custom SVG cursor for the rotate gizmo hover state — replaces the native
// cursor:grab keyword, which has a known Chromium+Windows bug where the
// cursor can render solid white with no outline. This is a user-provided
// rotate/refresh icon (two circular arrows), given a white fill + dark
// outline for contrast against any background, matching this app's cursor
// conventions. Used for HOVER only — once a rotate drag actually starts,
// the cursor switches to the plain default arrow instead (see the
// pointerdown handler below), rather than a second custom "active" icon.
const CURSOR_ROTATE = 'url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyOSIgaGVpZ2h0PSIyMiIgdmlld0JveD0iMCAwIDI5IDIyIj48ZyB0cmFuc2Zvcm09Im1hdHJpeCgxLDAsMCwxLC0xLjk5NDU0NCwtNS4wMjg2OSkiIGZpbGw9IiNmZmZmZmYiIHN0cm9rZT0iIzE0MTQxNCIgc3Ryb2tlLXdpZHRoPSIwLjkiIHN0eWxlPSJmaWxsLXJ1bGU6ZXZlbm9kZDtjbGlwLXJ1bGU6ZXZlbm9kZDtzdHJva2UtbGluZWpvaW46cm91bmQ7c3Ryb2tlLW1pdGVybGltaXQ6MjsiPjxwYXRoIGQ9Ik05LjAxNiwxMi45MDRMMTEuNzE4LDExLjQ4OUMxMi41MzMsMTEuMDYzIDEzLjU0MSwxMS4zNzggMTMuOTY3LDEyLjE5M0MxNC4zOTQsMTMuMDA4IDE0LjA3OSwxNC4wMTYgMTMuMjY0LDE0LjQ0M0w3LjQ2OCwxNy40NzdDNi42NTMsMTcuOTAzIDUuNjQ1LDE3LjU4OCA1LjIxOSwxNi43NzNMMi4xODUsMTAuOTc4QzEuNzU4LDEwLjE2MyAyLjA3Myw5LjE1NSAyLjg4OCw4LjcyOEMzLjcwMyw4LjMwMSA0LjcxMSw4LjYxNyA1LjEzOCw5LjQzMkw2LjEsMTEuMjdDNy44NjgsNy41OCAxMS42MzgsNS4wMjkgMTYsNS4wMjlDMTkuMDgsNS4wMjkgMjEuODY1LDYuMyAyMy44NTgsOC4zNDZDMjQuNSw5LjAwNSAyNC40ODYsMTAuMDYxIDIzLjgyNywxMC43MDNDMjMuMTY4LDExLjM0NSAyMi4xMTIsMTEuMzMxIDIxLjQ3LDEwLjY3MkMyMC4wODMsOS4yNDggMTguMTQ0LDguMzYyIDE2LDguMzYyQzEyLjg4Niw4LjM2MiAxMC4yMDUsMTAuMjI5IDkuMDE2LDEyLjkwNFpNMjUuOSwyMC43M0MyNC4xMzIsMjQuNDIgMjAuMzYyLDI2Ljk3MSAxNiwyNi45NzFDMTIuOTIsMjYuOTcxIDEwLjEzNSwyNS43IDguMTQyLDIzLjY1NEM3LjUsMjIuOTk1IDcuNTE0LDIxLjkzOSA4LjE3MywyMS4yOTdDOC44MzIsMjAuNjU1IDkuODg4LDIwLjY2OSAxMC41MywyMS4zMjhDMTEuOTE3LDIyLjc1MiAxMy44NTYsMjMuNjM4IDE2LDIzLjYzOEMxOS4xMTQsMjMuNjM4IDIxLjc5NSwyMS43NzEgMjIuOTg0LDE5LjA5NkwyMC4yODIsMjAuNTExQzE5LjQ2NywyMC45MzcgMTguNDU5LDIwLjYyMiAxOC4wMzMsMTkuODA3QzE3LjYwNiwxOC45OTIgMTcuOTIxLDE3Ljk4NCAxOC43MzYsMTcuNTU3TDI0LjUzMiwxNC41MjNDMjUuMzQ3LDE0LjA5NyAyNi4zNTUsMTQuNDEyIDI2Ljc4MSwxNS4yMjdMMjkuODE1LDIxLjAyMkMzMC4yNDIsMjEuODM3IDI5LjkyNywyMi44NDUgMjkuMTEyLDIzLjI3MkMyOC4yOTcsMjMuNjk5IDI3LjI4OSwyMy4zODMgMjYuODYyLDIyLjU2OEwyNS45LDIwLjczWiIvPjwvZz48L3N2Zz4K") 15 11, pointer';
const HANDLE_PX = 8;                  // visual size (side length) of each corner handle square
const HANDLE_HIT_PX = 11;             // slightly larger than visual, for easier grabbing
const ROTATE_GIZMO_OFFSET_PX = 24;    // distance from the top edge to the rotate gizmo circle
const ROTATE_GIZMO_RADIUS_PX = 4.8;   // visual radius of the gizmo circle
const ROTATE_GIZMO_HIT_PX = 10;       // hit radius for the gizmo — larger than visual, for easier grabbing
const DIM_LABEL_OFFSET_PX = 16;       // distance from the right/bottom edge midpoint to its dimension label
const SNAP_THRESHOLD_PX = 8;
const MIN_BLOCK_SCALE = 0.05;

// Layout-tab equivalent of computePaperLayout() — there's no solver
// viewport to fit here (a block isn't sized to any particular generation
// the way the live preview's content is), just the current paper size,
// orientation and margin as plain physical dimensions in mm.
function computeLayoutPaperDims(){
  const [pl, ps] = PAPERS[$('paperSize').value];
  const landscape = $('orient').value === 'landscape';
  const paperW = landscape ? pl : ps, paperH = landscape ? ps : pl;
  const margin = getMargins();
  return { paperW, paperH, margin };
}

// How many canvas-mm correspond to 1 on-screen CSS pixel, at the CURRENT
// pan/zoom — lets handle sizes/hit radii/snap thresholds be specified in
// screen px (where they actually need to feel consistent) and converted to
// the mm units everything on the canvas is actually drawn in.
function mmPerScreenPx(){
  const rect = $('layoutSheet').getBoundingClientRect();
  if (!rect.width) return 1;
  const dims = computeLayoutPaperDims();
  return dims.paperW / rect.width;
}
function screenToCanvasMm(clientX, clientY){
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
function canvasMmToScreen(wx, wy){
  const rect = $('layoutPlot').getBoundingClientRect();
  const dims = computeLayoutPaperDims();
  return [
    rect.left + (wx / dims.paperW) * rect.width,
    rect.top  + (wy / dims.paperH) * rect.height,
  ];
}

/* ================= one-time SVG scaffold =================
   Three persistent layers inside #layoutPlot, bottom to top: the margin
   guide, the blocks themselves, and snap guides. Created once here; never
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
  const hitBg = document.createElementNS(SVG_NS, 'rect');
  hitBg.id = 'layoutHitBg';
  hitBg.setAttribute('fill', 'transparent');
  svg.appendChild(hitBg);
  const guide = document.createElementNS(SVG_NS, 'rect');
  guide.id = 'layoutMarginGuide';
  guide.setAttribute('class', 'layoutMarginGuide');
  svg.appendChild(guide);
  const blocksLayer = document.createElementNS(SVG_NS, 'g');
  blocksLayer.id = 'layoutBlocksLayer';
  svg.appendChild(blocksLayer);
  const snapGuides = document.createElementNS(SVG_NS, 'g');
  snapGuides.id = 'layoutSnapGuides';
  svg.appendChild(snapGuides);
}
initLayoutPlot();

// Updates the viewBox + margin guide from the current paper settings —
// cheap, safe to call any time paper size/orientation/margin might have
// changed, or when switching into the Layout tab.
function syncLayoutPaperFrame(){
  const dims = computeLayoutPaperDims();
  $('layoutPlot').setAttribute('viewBox', '0 0 ' + dims.paperW.toFixed(3) + ' ' + dims.paperH.toFixed(3));
  const hitBg = $('layoutHitBg');
  hitBg.setAttribute('x', 0); hitBg.setAttribute('y', 0);
  hitBg.setAttribute('width', dims.paperW); hitBg.setAttribute('height', dims.paperH);
  const guide = $('layoutMarginGuide');
  guide.setAttribute('x', dims.margin.left); guide.setAttribute('y', dims.margin.top);
  guide.setAttribute('width', Math.max(0, dims.paperW - dims.margin.left - dims.margin.right));
  guide.setAttribute('height', Math.max(0, dims.paperH - dims.margin.top - dims.margin.bottom));
}

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
    activeTab = tab;
    document.querySelectorAll('.paperTab').forEach(b => b.classList.toggle('active', b === btn));
    document.body.classList.toggle('layoutMode', tab === 'layout');
    $('paperPaneLabel').textContent = tab === 'layout'
      ? 'Layout · drag pan · wheel zoom · right-click a layer to adjust individual layer visibility'
      : '2D · drag pan · wheel zoom';
    closeLayerContextMenu();
    $('sheet').style.display = tab === 'preview' ? '' : 'none';
    $('layoutSheet').style.display = tab === 'layout' ? '' : 'none';
    $('layoutOverlaySvg').style.display = tab === 'layout' ? '' : 'none';
    $('previewOverlaySvg').style.display = tab === 'preview' ? '' : 'none';
    $('addToLayoutBtn').style.display = tab === 'preview' ? '' : 'none';
    $('addToLayoutMsg').style.display = tab === 'preview' ? '' : 'none';
    $('genRow').style.display = tab === 'preview' ? '' : 'none';
    $('blocksFloat').style.display = tab === 'layout' ? '' : 'none';
    activeSheetId = tab === 'preview' ? 'sheet' : 'layoutSheet';
    if (tab === 'preview'){ $('paperPane').style.cursor = ''; lastCursor = null; }
    resetPv(); applyPv();
    if (tab === 'layout') renderLayoutCanvas();
    else markStale();
    refreshStatusR();
  });
});

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
   existing "layer" concept — the pen layers (LAYERS, layerEls,
   applyLayerStyle, the .layer CSS class for Crease/Hatch/etc rows).
   Reusing "layer" for the internal identifiers here too would collide
   with that existing system throughout these very functions (e.g. this
   function already reads layerEls per pen layer WHILE building one of
   these). Only user-visible strings say "layer"; every internal name
   stays "block" to keep the two concepts unambiguous in the code. */
function freezeCurrentGeneration(){
  if (!lastGen){ $('statusL').textContent = 'nothing generated yet'; return; }
  const layout = computePaperLayout();
  if (!layout) return;
  const layerPaths = {};
  const layerVisible = {};
  let any = false;
  for (const L of LAYERS){
    const g = document.getElementById('g_' + L.key);
    const path = g ? g.querySelector('path') : null;
    const d = path ? path.getAttribute('d') : '';
    if (d && d.trim()){
      layerPaths[L.key] = d;
      // Visibility is captured ONCE here and becomes the block's OWN,
      // independent state from this point on — unlike color/width/dash
      // (which stay live, read fresh from the panel on every render, unless
      // this block's Override is on — see updateBlockStyle and the
      // right-click layer menu), a layer toggled off in the panel later
      // should NOT retroactively hide it here, and vice versa. Per-block
      // visibility is edited afterward via the right-click layer menu.
      layerVisible[L.key] = layerEls[L.key].chk.checked;
      any = true;
    }
  }
  if (!any){ $('statusL').textContent = 'no visible geometry to add'; return; }

  const measureSvg = document.createElementNS(SVG_NS, 'svg');
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
  const measureOuter = document.createElementNS(SVG_NS, 'g');
  const measureG = document.createElementNS(SVG_NS, 'g');
  measureG.setAttribute('transform', 'translate(' + layout.offX + ',' + layout.offY + ') scale(' + layout.scale + ')');
  for (const key in layerPaths){
    const p = document.createElementNS(SVG_NS, 'path');
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
    name: 'Layer ' + String(blockCounter).padStart(2, '0'),
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
    // color/width/dash from overrideStyle below instead of the live panel —
    // set and edited via the right-click layer menu's "Override" checkbox,
    // never at creation time. overrideStyle starts empty and is populated
    // lazily, one layer at a time, the first time that specific layer is
    // shown with Override on for this block (see openLayerContextMenu) —
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
// named "X Copy") — names aren't a uniqueness key anywhere else in this
// file either, and the existing double-click-to-rename already covers it.
function duplicateBlock(block){
  const dup = {
    ...block,
    name: block.name + ' Copy',
    layerPaths: structuredClone(block.layerPaths),
    layerVisible: structuredClone(block.layerVisible),
    overrideStyle: structuredClone(block.overrideStyle),
    bboxLocal: { ...block.bboxLocal },
    dom: null,
  };
  blocks.push(dup);
  createBlockDom(dup);
  renderBlocksList();
  refreshStatusR();
  selectBlock(dup);
  $('statusL').textContent = 'duplicated ' + dup.name;
  showAddToLayoutMsg(dup.name + ' added to layout');
  return dup;
}
// Shown only once there's something to duplicate at all, disabled unless
// exactly one block is selected right now — duplicating a whole multi-
// selection at once is deferred to a later pass (per spec discussion), so
// for now this stays a single-block action, same as before, just gated on
// selectedBlocks.size===1 instead of a single selectedBlock reference.
function syncDuplicateBlockBtn(){
  const btn = $('duplicateBlockBtn');
  btn.style.display = blocks.length ? '' : 'none';
  btn.disabled = selectedBlocks.size !== 1;
}
$('duplicateBlockBtn').addEventListener('click', () => {
  const block = primarySelectedBlock();
  if (block) duplicateBlock(block);
});

/* ================= persistent per-block DOM ================= */
function createBlockDom(block){
  // Older .pen files (or in-memory blocks from before this field existed)
  // won't have layerVisible at all — default to all-visible rather than
  // letting updateBlockStyle below throw on a missing lookup.
  if (!block.layerVisible){
    block.layerVisible = {};
    for (const key in block.layerPaths) block.layerVisible[key] = true;
  }
  const outer = document.createElementNS(SVG_NS, 'g');
  const inner = document.createElementNS(SVG_NS, 'g');
  inner.setAttribute('transform',
    'translate(' + block.freezeOffX + ',' + block.freezeOffY + ') scale(' + block.freezeScale + ')');
  outer.appendChild(inner);
  const layerGroups = {};
  // LAYERS is ordered highest-priority-first (see main.js); paint order
  // needs the OPPOSITE — later-appended SVG elements draw on top, so
  // iterating in reverse here puts Scene Outline last/on top and Hatch/
  // Crosshatch/Deep shadow first/underneath, matching exactly how
  // svg-export.js's onResult() builds the live preview's paint order
  // (LAYERS.slice().reverse()). A previous version iterated forward here,
  // which inverted every block's layer stacking versus the live preview.
  for (const L of LAYERS.slice().reverse()){
    const d = block.layerPaths[L.key];
    if (!d) continue;
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('fill', 'none');
    g.setAttribute('stroke-linecap', 'round');
    g.setAttribute('stroke-linejoin', 'round');
    g.classList.add('layoutLayerStroke');   // target for the shared, cross-block blend rule — see styles.css
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    g.appendChild(p);
    inner.appendChild(g);
    layerGroups[L.key] = g;
  }
  block.dom = { outer, inner, layerGroups };
  $('layoutBlocksLayer').appendChild(outer);
  updateBlockTransform(block);
  updateBlockStyle(block);
}
function updateBlockTransform(block){
  if (!block.dom) return;
  const [cx, cy] = blockCenterLocal(block);
  block.dom.outer.setAttribute('transform',
    'translate(' + block.x + ',' + block.y + ') rotate(' + block.rotationDeg + ') scale(' + block.scale + ') ' +
    'translate(' + (-cx) + ',' + (-cy) + ')');
  block.dom.outer.style.display = block.visible ? '' : 'none';
}
function updateBlockStyle(block){
  if (!block.dom) return;
  const combinedScale = Math.max(1e-6, block.scale * block.freezeScale);
  for (const L of LAYERS){
    const g = block.dom.layerGroups[L.key];
    if (!g) continue;
    // Override reads this block's OWN per-layer style (set via the
    // right-click layer menu — see openLayerContextMenu) instead of the
    // live panel controls; an ordinary (synced) block keeps today's
    // behavior exactly. width still divides by the block's own current
    // combinedScale either way — that's not a "setting", it's what keeps
    // the stroke at the correct physical size as the block gets resized on
    // the layout sheet. dash is just a slot reference ("D3" etc.) in both
    // cases, same as the ordinary live dropdown — scaledDash resolves it
    // from the live DASH_RATIOS either way, so an overridden layer still
    // follows that slot's own pattern if it's edited later, exactly like a
    // synced layer would.
    const ov = block.override && block.overrideStyle ? block.overrideStyle[L.key] : null;
    const color = ov ? ov.color : layerEls[L.key].col.value;
    const widthMm = ov ? ov.width : +layerEls[L.key].wid.value;
    const dashKey = ov ? ov.dash : layerEls[L.key].dash.value;
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
    g.style.display = block.layerVisible[L.key] ? '' : 'none';
  }
}
function removeBlockDom(block){
  if (block.dom){ block.dom.outer.remove(); block.dom = null; }
}
function refreshAllBlockStyles(){
  for (const b of blocks) updateBlockStyle(b);
}
function renderLayoutCanvas(){
  syncLayoutPaperFrame();
  for (const b of blocks){
    if (!b.dom) createBlockDom(b);
    else { updateBlockTransform(b); updateBlockStyle(b); }
  }
}
// Feeds refreshStatusR() (svg-export.js) — sums computeDStats() over every
// visible layer of every visible block, skipping a hidden block entirely
// and, within a visible block, skipping any individual layer hidden via
// the right-click layer menu (block.layerVisible). freezeScale (px->mm at
// freeze time) combined with the block's own current on-page scale is the
// same combinedScale math updateBlockTransform already uses.
function computeLayoutStats(){
  const out = { segments: 0, paths: 0, closedPaths: 0, lenMm: 0 };
  for (const block of blocks){
    if (!block.visible) continue;
    for (const L of LAYERS){
      if (!block.layerVisible[L.key]) continue;
      const d = block.layerPaths[L.key];
      if (!d) continue;
      // Same override-vs-live dash resolution updateBlockStyle already uses.
      const dashKey = (block.override && block.overrideStyle[L.key]) ? block.overrideStyle[L.key].dash : layerEls[L.key].dash.value;
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
$('orient').addEventListener('input', () => {
  if ($('rotateBlocksWithPage').checked) rotateBlocksForOrientationFlip();
});

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
function localToWorld(block, lx, ly){
  const [cx, cy] = blockCenterLocal(block);
  const dx = lx - cx, dy = ly - cy;
  const sx = dx * block.scale, sy = dy * block.scale;
  const rad = block.rotationDeg * Math.PI/180, cos = Math.cos(rad), sin = Math.sin(rad);
  return [sx*cos - sy*sin + block.x, sx*sin + sy*cos + block.y];
}
function worldToLocal(block, wx, wy){
  const dx = wx - block.x, dy = wy - block.y;
  const rad = -block.rotationDeg * Math.PI/180, cos = Math.cos(rad), sin = Math.sin(rad);
  const rx = dx*cos - dy*sin, ry = dx*sin + dy*cos;
  const [cx, cy] = blockCenterLocal(block);
  return [rx / block.scale + cx, ry / block.scale + cy];
}
function blockCorners(block){
  const { x0, y0, x1, y1 } = block.bboxLocal;
  return [[x0,y0],[x1,y0],[x1,y1],[x0,y1]].map(([lx,ly]) => localToWorld(block, lx, ly));
}
function worldEnvelope(block){
  const c = blockCorners(block);
  const xs = c.map(p => p[0]), ys = c.map(p => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}
// The rotate gizmo sits a constant SCREEN distance beyond the block's
// current top-center point — "constant screen distance" specifically
// (not a constant amount in local/mm units, which would grow/shrink with
// block.scale the way the frozen geometry itself does). The direction used
// for that offset comes from the already-transformed top-center point
// relative to the block's own center, so it automatically follows the
// block's current rotation without any separate rotation math here.
// Returns [gizmoX, gizmoY, topCenterX, topCenterY] — the last two are the
// point where the dashed connector line should attach to the bounding box.
function rotateGizmoWorldPos(block){
  const { x0, x1, y0 } = block.bboxLocal;
  const topCenterWorld = localToWorld(block, (x0 + x1) / 2, y0);
  const dx = topCenterWorld[0] - block.x, dy = topCenterWorld[1] - block.y;
  const len = Math.max(1e-6, Math.hypot(dx, dy));
  const ux = dx / len, uy = dy / len;
  const offsetMm = ROTATE_GIZMO_OFFSET_PX * mmPerScreenPx();
  return [topCenterWorld[0] + ux * offsetMm, topCenterWorld[1] + uy * offsetMm, topCenterWorld[0], topCenterWorld[1]];
}

/* ================= selection ================= */
function primarySelectedBlock(){ return selectedBlocks.size === 1 ? [...selectedBlocks][0] : null; }
function selectionAnyLocked(){ for (const b of selectedBlocks) if (b.locked) return true; return false; }
// Union of every selected block's own world-space envelope — the group's
// own axis-aligned bounding box, freshly recomputed. Used ONLY to seed a
// NEW selectionFrame when the selected SET itself changes — for drawing
// the overlay and driving group interactions once a selection exists,
// selectionFrame (below) is what's actually used, not this.
function selectionEnvelope(){
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for (const b of selectedBlocks){
    const e = worldEnvelope(b);
    x0=Math.min(x0,e.x0); y0=Math.min(y0,e.y0); x1=Math.max(x1,e.x1); y1=Math.max(y1,e.y1);
  }
  return { x0, y0, x1, y1 };
}
// The multi-select bounding box's own 4 world-space corners — a genuinely
// separate, persistent piece of state from the individual blocks, NOT
// recomputed fresh every frame the way selectionEnvelope() is. It starts
// as a fresh axis-aligned box (via selectionEnvelope()) the moment the
// selected SET changes, but from then on transforms RIGIDLY right
// alongside the group during move/rotate/scale — including staying
// rotated after a group rotate — and keeps that shape/orientation across
// separate later gestures until the set itself changes again (a block
// added to or removed from the selection). Corner order is always
// [top-left, top-right, bottom-right, bottom-left] AT THE MOMENT IT WAS
// (re)seeded — "top-left" etc. stop being literally true once the frame
// has been rotated, but the ORDER (and therefore which edge is "the top
// edge" for the rotate gizmo) is preserved through every rigid transform.
let selectionFrame = null;
function resetSelectionFrame(){
  if (selectedBlocks.size <= 1){ selectionFrame = null; return; }
  const env = selectionEnvelope();
  selectionFrame = { corners: [[env.x0,env.y0],[env.x1,env.y0],[env.x1,env.y1],[env.x0,env.y1]] };
}
// Same "constant screen distance beyond top-center" idea as the single-
// block rotateGizmoWorldPos — generalized from an axis-aligned env to an
// arbitrary (possibly rotated) frame by using corners[0]/[1] (the frame's
// own "top edge", in whatever orientation it currently has) instead of
// assuming world-up is always the box's own up.
// The frame's own current "top edge" (corners[0]->corners[1]) angle, in
// degrees — 0 for a freshly (re)seeded axis-aligned frame, and whatever it
// rotated to after a group rotate gesture (see selectionFrame's own
// comment). Shared by the overlay's handle-square rotation and the resize
// cursor lookup so both agree on the frame's current orientation.
function selectionFrameAngleDeg(frame){
  const c = frame.corners;
  return Math.atan2(c[1][1]-c[0][1], c[1][0]-c[0][0]) * 180/Math.PI;
}
function groupRotateGizmoWorldPos(frame){
  const c = frame.corners;
  const topCenter = [(c[0][0]+c[1][0])/2, (c[0][1]+c[1][1])/2];
  const center = [(c[0][0]+c[2][0])/2, (c[0][1]+c[2][1])/2];
  const dx = topCenter[0]-center[0], dy = topCenter[1]-center[1];
  const len = Math.max(1e-6, Math.hypot(dx,dy));
  const ux = dx/len, uy = dy/len;
  const offsetMm = ROTATE_GIZMO_OFFSET_PX * mmPerScreenPx();
  return [topCenter[0]+ux*offsetMm, topCenter[1]+uy*offsetMm, topCenter[0], topCenter[1]];
}
function setSelection(blocksArr){
  selectedBlocks = new Set(blocksArr);
  resetSelectionFrame();
  updateSelectionOverlay();
  refreshSelectionHighlight();
  syncDuplicateBlockBtn();
}
function clearSelection(){ if (selectedBlocks.size) setSelection([]); }
function toggleSelection(block){
  const next = new Set(selectedBlocks);
  if (next.has(block)) next.delete(block); else next.add(block);
  setSelection([...next]);
}
// Removes ONE block from the selection if present, leaving the rest of the
// selection untouched — for when a specific block is hidden or deleted
// (via its own row button, independent of what else is currently
// selected), not for anything that should clear the whole selection.
function deselectBlock(block){
  if (!selectedBlocks.has(block)) return;
  const next = new Set(selectedBlocks);
  next.delete(block);
  setSelection([...next]);
}
// Back-compat single-block convenience wrapper — block===null clears.
function selectBlock(block){ setSelection(block ? [block] : []); }
function updateSelectionOverlay(){
  const ov = $('layoutOverlaySvg');
  ov.innerHTML = '';
  updateRuler();   // this wipe just took the ruler out with it — put it back before any of the early returns below
  if (selectedBlocks.size === 0) return;
  if (selectedBlocks.size === 1){
    // Exactly the original single-block rendering, unchanged — handles sit
    // at the block's OWN (possibly rotated) corners, not an axis-aligned
    // box, so a single rotated block's selection outline still hugs it
    // exactly rather than showing a needlessly larger axis-aligned box.
    const block = primarySelectedBlock();
    const corners = blockCorners(block).map(([wx, wy]) => canvasMmToScreen(wx, wy));
    const rectPath = document.createElementNS(SVG_NS, 'path');
    rectPath.setAttribute('class', 'layoutSelRect');
    rectPath.setAttribute('d', 'M' + corners.map(p => p[0] + ',' + p[1]).join('L') + 'Z');
    ov.appendChild(rectPath);
    if (block.locked) return;   // outline only — no handles/gizmo for something that can't be transformed
    for (const [cx, cy] of corners){
      const sq = document.createElementNS(SVG_NS, 'rect');
      sq.setAttribute('class', 'layoutSelHandle');
      sq.setAttribute('x', cx - HANDLE_PX/2); sq.setAttribute('y', cy - HANDLE_PX/2);
      sq.setAttribute('width', HANDLE_PX); sq.setAttribute('height', HANDLE_PX);
      sq.setAttribute('transform', 'rotate(' + block.rotationDeg + ' ' + cx + ' ' + cy + ')');
      ov.appendChild(sq);
    }
    const [gwx, gwy, twx, twy] = rotateGizmoWorldPos(block);
    const [gx, gy] = canvasMmToScreen(gwx, gwy), [tx, ty] = canvasMmToScreen(twx, twy);
    const connector = document.createElementNS(SVG_NS, 'line');
    connector.setAttribute('class', 'layoutRotateConnector');
    connector.setAttribute('x1', tx); connector.setAttribute('y1', ty);
    connector.setAttribute('x2', gx); connector.setAttribute('y2', gy);
    ov.appendChild(connector);
    const gizmo = document.createElementNS(SVG_NS, 'circle');
    gizmo.setAttribute('class', 'layoutRotateGizmo');
    gizmo.setAttribute('cx', gx); gizmo.setAttribute('cy', gy);
    gizmo.setAttribute('r', ROTATE_GIZMO_RADIUS_PX);
    ov.appendChild(gizmo);
    return;
  }
  // Multi-select: each member's own (possibly rotated) outline, thin, no
  // handles — just "here's what's included" — plus the group's own
  // selectionFrame box (see its own comment: axis-aligned only until the
  // first group rotate, after which it stays in that rotated orientation)
  // carrying the actual handles/gizmo.
  for (const b of selectedBlocks){
    const corners = blockCorners(b).map(([wx, wy]) => canvasMmToScreen(wx, wy));
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('class', 'layoutSelRectMember');
    p.setAttribute('d', 'M' + corners.map(pt => pt[0] + ',' + pt[1]).join('L') + 'Z');
    ov.appendChild(p);
  }
  const frameWorld = selectionFrame.corners;
  const corners = frameWorld.map(([wx,wy]) => canvasMmToScreen(wx,wy));
  const rectPath = document.createElementNS(SVG_NS, 'path');
  rectPath.setAttribute('class', 'layoutSelRect');
  rectPath.setAttribute('d', 'M' + corners.map(p => p[0] + ',' + p[1]).join('L') + 'Z');
  ov.appendChild(rectPath);
  if (selectionAnyLocked()) return;   // outline(s) only — same rule as a single locked block
  // Handle squares rotate to match the frame's own current edge angle (the
  // corners[0]->corners[1] "top edge," whatever orientation it's actually
  // in right now), same visual language as a single block's own rotated
  // handles — not left axis-aligned once the frame itself is rotated.
  const frameAngleDeg = selectionFrameAngleDeg(selectionFrame);
  for (const [cx, cy] of corners){
    const sq = document.createElementNS(SVG_NS, 'rect');
    sq.setAttribute('class', 'layoutSelHandle');
    sq.setAttribute('x', cx - HANDLE_PX/2); sq.setAttribute('y', cy - HANDLE_PX/2);
    sq.setAttribute('width', HANDLE_PX); sq.setAttribute('height', HANDLE_PX);
    sq.setAttribute('transform', 'rotate(' + frameAngleDeg + ' ' + cx + ' ' + cy + ')');
    ov.appendChild(sq);
  }
  const [gwx, gwy, twx, twy] = groupRotateGizmoWorldPos({ corners: frameWorld });
  const [gx, gy] = canvasMmToScreen(gwx, gwy), [tx, ty] = canvasMmToScreen(twx, twy);
  const connector = document.createElementNS(SVG_NS, 'line');
  connector.setAttribute('class', 'layoutRotateConnector');
  connector.setAttribute('x1', tx); connector.setAttribute('y1', ty);
  connector.setAttribute('x2', gx); connector.setAttribute('y2', gy);
  ov.appendChild(connector);
  const gizmo = document.createElementNS(SVG_NS, 'circle');
  gizmo.setAttribute('class', 'layoutRotateGizmo');
  gizmo.setAttribute('cx', gx); gizmo.setAttribute('cy', gy);
  gizmo.setAttribute('r', ROTATE_GIZMO_RADIUS_PX);
  ov.appendChild(gizmo);
}
function refreshSelectionHighlight(){
  for (const row of $('blocksList').children){
    const block = blocks.find(b => b.name === row.dataset.blockName);
    row.classList.toggle('svRowSelected', !!block && selectedBlocks.has(block));
  }
}

/* ================= snapping ================= */
// Move-snapping, generalized to an arbitrary envelope + exclusion set —
// used for both a single block (env = that block's own worldEnvelope(),
// excludeSet = {that block}) and a whole multi-selection (env =
// selectionEnvelope(), excludeSet = every selected block) via the exact
// same code, not two parallel implementations. This works because
// translating a shape by (dx,dy) without touching its rotation or scale
// translates its envelope by the exact same (dx,dy) — true for a single
// block's own envelope AND for a union of several blocks' envelopes
// (union commutes with a shared translation) — so the caller can just pass
// in the START envelope once and a candidate delta, rather than this
// function needing to know anything about individual blocks at all.
function computeMoveSnap(startEnv, excludeSet, dx, dy){
  const thresholdMm = SNAP_THRESHOLD_PX * mmPerScreenPx();
  const env = { x0: startEnv.x0+dx, x1: startEnv.x1+dx, y0: startEnv.y0+dy, y1: startEnv.y1+dy };
  const cx = (env.x0 + env.x1) / 2, cy = (env.y0 + env.y1) / 2;
  let bestDX = null, bestDY = null, guideX = null, guideY = null, guideYRange = null, guideXRange = null;
  for (const other of blocks){
    if (excludeSet.has(other) || !other.visible) continue;
    const oe = worldEnvelope(other);
    const ocx = (oe.x0 + oe.x1) / 2, ocy = (oe.y0 + oe.y1) / 2;
    for (const myV of [env.x0, cx, env.x1]){
      for (const oV of [oe.x0, ocx, oe.x1]){
        const d = oV - myV;
        if (Math.abs(d) <= thresholdMm && (bestDX === null || Math.abs(d) < Math.abs(bestDX))){
          bestDX = d; guideX = oV; guideYRange = [Math.min(env.y0, oe.y0), Math.max(env.y1, oe.y1)];
        }
      }
    }
    for (const myV of [env.y0, cy, env.y1]){
      for (const oV of [oe.y0, ocy, oe.y1]){
        const d = oV - myV;
        if (Math.abs(d) <= thresholdMm && (bestDY === null || Math.abs(d) < Math.abs(bestDY))){
          bestDY = d; guideY = oV; guideXRange = [Math.min(env.x0, oe.x0), Math.max(env.x1, oe.x1)];
        }
      }
    }
  }
  // Page edges and margins — fixed reference lines, not tied to any other
  // block, so the guide spans the FULL page rather than a localized range
  // between two aligned elements (that reads as "page reference," distinct
  // from the shorter block-to-block alignment guides above).
  const dims = computeLayoutPaperDims();
  const pageXRefs = [0, dims.margin.left, dims.paperW - dims.margin.right, dims.paperW, dims.paperW / 2];
  const pageYRefs = [0, dims.margin.top, dims.paperH - dims.margin.bottom, dims.paperH, dims.paperH / 2];
  for (const myV of [env.x0, cx, env.x1]){
    for (const oV of pageXRefs){
      const d = oV - myV;
      if (Math.abs(d) <= thresholdMm && (bestDX === null || Math.abs(d) < Math.abs(bestDX))){
        bestDX = d; guideX = oV; guideYRange = [0, dims.paperH];
      }
    }
  }
  for (const myV of [env.y0, cy, env.y1]){
    for (const oV of pageYRefs){
      const d = oV - myV;
      if (Math.abs(d) <= thresholdMm && (bestDY === null || Math.abs(d) < Math.abs(bestDY))){
        bestDY = d; guideY = oV; guideXRange = [0, dims.paperW];
      }
    }
  }
  return {
    dx: dx + (bestDX || 0), dy: dy + (bestDY || 0),
    guideX: bestDX !== null ? guideX : null, guideYRange,
    guideY: bestDY !== null ? guideY : null, guideXRange,
  };
}
// Scale-snapping: unlike move (independent X/Y offsets), only ONE scale
// value can be chosen, so X-axis and Y-axis candidates compete in a single
// pool and whichever gets closest to a target within the threshold wins —
// there's no way to satisfy both an X-snap and a Y-snap simultaneously
// unless they coincidentally require the same scale.
//
// Parametrized by a RELATIVE factor k (resultingScale = startScale * k),
// not an absolute scale value — necessary once more than one block can be
// involved, since different selected blocks can have different starting
// scales, and only a shared multiplicative factor keeps them all scaling
// together rigidly (a shared ABSOLUTE target scale would instead force
// every block to the same final size, destroying their relative sizes).
// This isn't a special case bolted onto the single-block math — a single
// block is just the N=1 case of exactly the same formula: k=1 always
// reproduces the block's own start position/size regardless of what its
// startScale happens to be, so every corner's world position is still
// simply anchorWorld + k*(startCornerWorld-anchorWorld) whether N is 1 or
// many, which is what interaction.corners (every corner of every member,
// captured once at drag start) already expresses directly — no per-block
// unscaling/rescaling needed to make the two cases share this one function.
function computeScaleSnap(interaction, k){
  const { anchorWorld, corners, minStartScale, excludeSet } = interaction;
  const thresholdMm = SNAP_THRESHOLD_PX * mmPerScreenPx();
  const dims = computeLayoutPaperDims();
  const minVx = Math.min(...corners.map(c => c[0])), maxVx = Math.max(...corners.map(c => c[0]));
  const minVy = Math.min(...corners.map(c => c[1])), maxVy = Math.max(...corners.map(c => c[1]));
  const naturalX0 = anchorWorld[0] + k*minVx, naturalX1 = anchorWorld[0] + k*maxVx;
  const naturalY0 = anchorWorld[1] + k*minVy, naturalY1 = anchorWorld[1] + k*maxVy;

  const xTargets = [];   // {value, range} for the guide line's perpendicular span
  const yTargets = [];
  for (const other of blocks){
    if (excludeSet.has(other) || !other.visible) continue;
    const oe = worldEnvelope(other);
    const ocx = (oe.x0 + oe.x1) / 2, ocy = (oe.y0 + oe.y1) / 2;
    for (const v of [oe.x0, ocx, oe.x1]) xTargets.push({ value: v, range: [oe.y0, oe.y1] });
    for (const v of [oe.y0, ocy, oe.y1]) yTargets.push({ value: v, range: [oe.x0, oe.x1] });
  }
  for (const v of [0, dims.margin.left, dims.paperW - dims.margin.right, dims.paperW, dims.paperW / 2]) xTargets.push({ value: v, range: [0, dims.paperH] });
  for (const v of [0, dims.margin.top, dims.paperH - dims.margin.bottom, dims.paperH, dims.paperH / 2]) yTargets.push({ value: v, range: [0, dims.paperW] });

  // The most-constrained member (smallest startScale) sets the floor on k —
  // clamping the SHARED k once here, rather than each block's resulting
  // scale independently, is what keeps the whole group shrinking together
  // and stopping together, instead of some members hitting the floor
  // before others and the group silently losing its rigid proportions.
  const minK = MIN_BLOCK_SCALE / minStartScale;
  let best = null;   // {dist, k, guideX, guideY, guideXRange, guideYRange}
  const EPS = 1e-9;
  // X-axis: naturalX0 moves via minVx, naturalX1 moves via maxVx — skip
  // whichever is ~0 (that edge is pinned to the anchor, can't be scaled to a target).
  for (const [naturalEdge, V] of [[naturalX0, minVx], [naturalX1, maxVx]]){
    if (Math.abs(V) < EPS) continue;
    for (const t of xTargets){
      const dist = Math.abs(naturalEdge - t.value);
      if (dist <= thresholdMm && (!best || dist < best.dist)){
        const candK = (t.value - anchorWorld[0]) / V;
        if (candK >= minK) best = { dist, k: candK, guideX: t.value, guideYRange: t.range, guideY: null, guideXRange: null };
      }
    }
  }
  for (const [naturalEdge, V] of [[naturalY0, minVy], [naturalY1, maxVy]]){
    if (Math.abs(V) < EPS) continue;
    for (const t of yTargets){
      const dist = Math.abs(naturalEdge - t.value);
      if (dist <= thresholdMm && (!best || dist < best.dist)){
        const candK = (t.value - anchorWorld[1]) / V;
        if (candK >= minK) best = { dist, k: candK, guideY: t.value, guideXRange: t.range, guideX: null, guideYRange: null };
      }
    }
  }
  // Scale-to-100% (each block's original, as-added size) — only meaningful
  // for a single block; with several blocks at potentially different
  // starting scales, "everyone's own 100%" isn't a single shared k, so
  // this bonus target is skipped entirely once more than one is involved.
  if (corners.length === 4){
    const dragDistPerScale = interaction.startDist / interaction.startScale;
    const origDist = dragDistPerScale * Math.abs(k*interaction.startScale - 1);
    if (origDist <= thresholdMm && (!best || origDist < best.dist)){
      best = { dist: origDist, k: 1/interaction.startScale, isOriginalScale: true,
        guideX: null, guideY: null, guideXRange: null, guideYRange: null };
    }
  }
  return best ? best : { k: Math.max(minK, k), guideX: null, guideY: null, guideXRange: null, guideYRange: null };
}
function drawSnapGuides(snap){
  const g = $('layoutSnapGuides');
  g.innerHTML = '';
  if (snap.guideX !== null){
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('class', 'layoutSnapGuide');
    line.setAttribute('x1', snap.guideX); line.setAttribute('x2', snap.guideX);
    line.setAttribute('y1', snap.guideYRange[0]); line.setAttribute('y2', snap.guideYRange[1]);
    g.appendChild(line);
  }
  if (snap.guideY !== null){
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('class', 'layoutSnapGuide');
    line.setAttribute('y1', snap.guideY); line.setAttribute('y2', snap.guideY);
    line.setAttribute('x1', snap.guideXRange[0]); line.setAttribute('x2', snap.guideXRange[1]);
    g.appendChild(line);
  }
}
function clearSnapGuides(){ $('layoutSnapGuides').innerHTML = ''; }

/* ================= rotate angle label ================= */
function showRotateLabel(deg, clientX, clientY){
  const el = $('rotateAngleLabel');
  el.textContent = Math.round(deg) + '\u00B0';
  el.style.left = clientX + 'px';
  el.style.top = clientY + 'px';
  el.style.display = 'block';
}
function hideRotateLabel(){ $('rotateAngleLabel').style.display = 'none'; }

/* ================= scale dimension labels =================
   Shown during a scale drag, styled identically to the rotate angle label.
   Always anchored to the block's own LOCAL right edge (between corner
   indices 1 and 2) and LOCAL bottom edge (indices 2 and 3) — regardless of
   the block's current rotation, so the same physical edge always carries
   the same label, rather than whichever edge happens to look "right" or
   "bottom" on screen at the moment. */
function edgeLabelWorldPos(block, cornerA, cornerB){
  const midX = (cornerA[0] + cornerB[0]) / 2, midY = (cornerA[1] + cornerB[1]) / 2;
  const dx = midX - block.x, dy = midY - block.y;
  const len = Math.max(1e-6, Math.hypot(dx, dy));
  const ux = dx / len, uy = dy / len;
  const offsetMm = DIM_LABEL_OFFSET_PX * mmPerScreenPx();
  return [midX + ux * offsetMm, midY + uy * offsetMm];
}
function updateDimensionLabels(block){
  const corners = blockCorners(block);
  const width  = (block.bboxLocal.x1 - block.bboxLocal.x0) * block.scale;
  const height = (block.bboxLocal.y1 - block.bboxLocal.y0) * block.scale;
  const [rwx, rwy] = edgeLabelWorldPos(block, corners[1], corners[2]);   // local right edge
  const [bwx, bwy] = edgeLabelWorldPos(block, corners[2], corners[3]);   // local bottom edge
  const [rsx, rsy] = canvasMmToScreen(rwx, rwy);
  const [bsx, bsy] = canvasMmToScreen(bwx, bwy);
  const wEl = $('widthDimLabel'), hEl = $('heightDimLabel');
  const atOriginalScale = Math.abs(block.scale - 1) < 1e-9;
  wEl.textContent = width.toFixed(1) + ' mm' + (atOriginalScale ? ' (100%)' : '');
  wEl.style.left = rsx + 'px'; wEl.style.top = rsy + 'px'; wEl.style.display = 'block';
  hEl.textContent = height.toFixed(1) + ' mm';
  hEl.style.left = bsx + 'px'; hEl.style.top = bsy + 'px'; hEl.style.display = 'block';
}
function hideDimensionLabels(){
  $('widthDimLabel').style.display = 'none';
  $('heightDimLabel').style.display = 'none';
}

/* ================= hit testing ================= */
// Locked blocks are click-through — not selectable, not right-clickable,
// never picked up here at all, as if they were transparent to interaction
// (their drawn geometry stays fully visible, just not interactive). Both
// the canvas click-select path AND the right-click context-menu path route
// through this same function, so excluding locked blocks here is the one
// change that covers both.
function hitTestBlockBody(wx, wy){
  for (let i = blocks.length - 1; i >= 0; i--){
    const b = blocks[i];
    if (!b.visible || b.locked) continue;
    const [lx, ly] = worldToLocal(b, wx, wy);
    if (lx >= b.bboxLocal.x0 && lx <= b.bboxLocal.x1 && ly >= b.bboxLocal.y0 && ly <= b.bboxLocal.y1){
      return b;
    }
  }
  return null;
}
function hitTest(wx, wy){
  if (selectedBlocks.size === 1){
    const block = primarySelectedBlock();
    if (block.visible && !block.locked){
      const [gx, gy] = rotateGizmoWorldPos(block);
      const gizmoHitMm = ROTATE_GIZMO_HIT_PX * mmPerScreenPx();
      if (Math.hypot(wx - gx, wy - gy) <= gizmoHitMm) return { type: 'rotate', block };
      const corners = blockCorners(block);
      const handleHitMm = HANDLE_HIT_PX * mmPerScreenPx();
      for (let i = 0; i < 4; i++){
        const dist = Math.hypot(wx - corners[i][0], wy - corners[i][1]);
        if (dist <= handleHitMm) return { type: 'scale', block, cornerIndex: i };
      }
    }
  } else if (selectedBlocks.size > 1 && !selectionAnyLocked() && [...selectedBlocks].every(b => b.visible)){
    const [gx, gy] = groupRotateGizmoWorldPos(selectionFrame);
    const gizmoHitMm = ROTATE_GIZMO_HIT_PX * mmPerScreenPx();
    if (Math.hypot(wx - gx, wy - gy) <= gizmoHitMm) return { type: 'rotateGroup' };
    const corners = selectionFrame.corners;
    const handleHitMm = HANDLE_HIT_PX * mmPerScreenPx();
    for (let i = 0; i < 4; i++){
      const dist = Math.hypot(wx - corners[i][0], wy - corners[i][1]);
      if (dist <= handleHitMm) return { type: 'scaleGroup', cornerIndex: i };
    }
  }
  const bodyHit = hitTestBlockBody(wx, wy);
  return bodyHit ? { type: 'move', block: bodyHit } : null;
}
// The two resize cursors represent UNDIRECTED diagonal lines (nwse-resize =
// the NW<->SE line, nesw-resize = the NE<->SW line) — each is unchanged by
// a 180-degree rotation (that just swaps which END of the same line a
// corner sits on), and the two lines are 90 degrees apart from each other.
// So as a corner's on-screen direction sweeps through a full 180-degree
// half-turn, which line it's closer to flips exactly once, at the halfway
// point — a period-180 pattern, not period-90. Verified directly against
// rotationDeg=0 (unflipped), 90 (flipped — a corner that started pointing
// NW now points NE), and 180/270 (still consistent) rather than assumed.
function cornerCursorForRotation(cornerIndex, rotationDeg){
  const r = ((rotationDeg % 180) + 180) % 180;      // 0..180, period 180
  const flip = r > 45 && r < 135;
  const isDefaultNwse = (cornerIndex === 0 || cornerIndex === 2);
  const useNwse = flip ? !isDefaultNwse : isDefaultNwse;
  return useNwse ? 'nwse-resize' : 'nesw-resize';
}
let lastCursor = null;
function updateHoverCursor(wx, wy){
  const hit = hitTest(wx, wy);
  const cursor = !hit ? 'default'
    : hit.type === 'scale' ? cornerCursorForRotation(hit.cornerIndex, hit.block.rotationDeg)
    // group box starts axis-aligned but stays rigidly rotated after a group
    // rotate gesture (see selectionFrame's own comment) — use its actual
    // current angle, same as the handle squares themselves already do.
    : hit.type === 'scaleGroup' ? cornerCursorForRotation(hit.cornerIndex, selectionFrameAngleDeg(selectionFrame))
    : hit.type === 'rotate' || hit.type === 'rotateGroup' ? CURSOR_ROTATE
    : hit.block.locked ? 'default'
    : 'move';
  // Reassigning style.cursor on every pointermove even when the value hasn't
  // changed is a known trigger for cursor-rendering glitches in some
  // browsers — the icon can flicker or briefly render without its outline.
  // Only touching it on an actual change avoids that entirely.
  if (cursor !== lastCursor){
    $('paperPane').style.cursor = cursor;
    lastCursor = cursor;
  }
}

/* ================= pointer interaction =================
   Listeners live on #paperPane now (not #layoutPlot), and pointerdown/
   contextmenu use the CAPTURE phase specifically — both changes exist for
   the same reason: a block (and its selection handles/gizmo) can now be
   positioned partially or fully outside the paper, in the wider pane area
   that also hosts panning (paper-preview.js's pan handler, also on
   #paperPane, bubble phase) and the floating UI panels. Capture fires
   before any bubble-phase listener regardless of DOM depth, which is what
   lets this correctly intercept a handle/block hit before panning would
   otherwise start — a same-element, same-phase listener registered later
   (which is what this would be, since paper-preview.js loads first) can't
   achieve that; only capture-phase priority can. */
const LAYOUT_UI_CHROME_SELECTOR = '#paperPanelStack, #paperTabs, #reset2dBtn, #layerContextMenu';
$('paperPane').addEventListener('pointerdown', e => {
  if (activeTab !== 'layout') return;
  if (e.button !== 0) return;      // left-click only — right-click is handled separately by the contextmenu listener
  // Floating UI panels sit visually on top of the canvas but hit-testing
  // below is purely mm-coordinate-based, with no notion of DOM z-order —
  // without this check, a block positioned underneath one of these panels
  // could swallow a click meant for the panel's own button.
  if (e.target.closest(LAYOUT_UI_CHROME_SELECTOR)) return;
  const [wx, wy] = screenToCanvasMm(e.clientX, e.clientY);
  const hit = hitTest(wx, wy);
  if (!hit){
    if (!e.shiftKey) clearSelection();   // shift+click on empty space is a no-op, same as most design tools
    return;                        // let it bubble — empty-space pan still works, on-page or off
  }
  e.stopPropagation();
  e.preventDefault();
  $('paperPane').setPointerCapture(e.pointerId);
  pendingCollapseTo = null;

  if (hit.type === 'move'){
    const block = hit.block;
    if (e.shiftKey){
      toggleSelection(block);
    } else if (selectedBlocks.has(block)){
      // Already part of the current selection — don't collapse to just this
      // one yet. If a drag actually happens, the whole group should move;
      // collapsing immediately would make it impossible to drag a group by
      // grabbing one of its own members. Only resolved at pointerup, and
      // only if no drag occurred (see endInteraction).
      pendingCollapseTo = block;
    } else {
      setSelection([block]);
    }
    if (selectedBlocks.size && !selectionAnyLocked()){
      const startEnv = selectionEnvelope();
      const members = [...selectedBlocks].map(b => ({ block: b, startX: b.x, startY: b.y }));
      interaction = { mode: 'move', members, startEnv, startWorld: [wx, wy], moved: false,
        startFrameCorners: selectedBlocks.size > 1 ? selectionFrame.corners.map(c => c.slice()) : null };
    }
  } else if (hit.type === 'scale'){
    const corners = blockCorners(hit.block);
    const localCorners = [
      [hit.block.bboxLocal.x0, hit.block.bboxLocal.y0], [hit.block.bboxLocal.x1, hit.block.bboxLocal.y0],
      [hit.block.bboxLocal.x1, hit.block.bboxLocal.y1], [hit.block.bboxLocal.x0, hit.block.bboxLocal.y1],
    ];
    const anchorIdx = (hit.cornerIndex + 2) % 4;
    const anchorWorld = corners[anchorIdx], anchorLocal = localCorners[anchorIdx];
    const draggedWorld = corners[hit.cornerIndex];
    const startDist = Math.max(1e-6, Math.hypot(draggedWorld[0]-anchorWorld[0], draggedWorld[1]-anchorWorld[1]));
    // With the anchor fixed and rotation fixed for the duration of the
    // drag, EVERY corner's world position is an affine function of scale s:
    // worldCorner_i(s) = anchorWorld + s*V_i, where V_i is this fixed,
    // rotated offset from the anchor to corner i. That makes each envelope
    // edge (the min/max of these over the 4 corners) ALSO linear in s —
    // which is what lets computeScaleSnap solve directly for the scale
    // that puts a given edge exactly on a snap target, rather than just
    // measuring distance the way move-snapping does. Verified numerically
    // against a direct forward-transform computation, including on a
    // rotated block, before wiring this in.
    const rad = hit.block.rotationDeg * Math.PI/180, cos = Math.cos(rad), sin = Math.sin(rad);
    const V = localCorners.map(([lx, ly]) => {
      const dx = lx - anchorLocal[0], dy = ly - anchorLocal[1];
      return [dx*cos - dy*sin, dx*sin + dy*cos];
    });
    // corners here (world-space, anchor-relative) feed the same
    // computeScaleSnap() a multi-block scale uses — see its own comment for
    // why a single block is just the N=1 case of that same function.
    interaction = { mode: 'scale', anchorWorld, anchorLocal, startDist,
      startScale: hit.block.scale, rotationDeg: hit.block.rotationDeg,
      corners: V, minStartScale: hit.block.scale, excludeSet: new Set([hit.block]),
      members: [{ block: hit.block, startX: hit.block.x, startY: hit.block.y, startScale: hit.block.scale }] };
  } else if (hit.type === 'rotate'){
    const startAngle = Math.atan2(wy - hit.block.y, wx - hit.block.x) * 180/Math.PI;
    interaction = { mode: 'rotate', block: hit.block, startAngle, startRotation: hit.block.rotationDeg };
    $('paperPane').style.cursor = 'default';
    lastCursor = 'default';
  } else if (hit.type === 'scaleGroup'){
    const envCorners = selectionFrame.corners;
    const anchorIdx = (hit.cornerIndex + 2) % 4;
    const anchorWorld = envCorners[anchorIdx];
    const draggedWorld = envCorners[hit.cornerIndex];
    const startDist = Math.max(1e-6, Math.hypot(draggedWorld[0]-anchorWorld[0], draggedWorld[1]-anchorWorld[1]));
    const members = [...selectedBlocks].map(b => ({ block: b, startX: b.x, startY: b.y, startScale: b.scale }));
    // Every corner of every selected block, as an offset from the SAME
    // shared group anchor — this is what makes computeScaleSnap solve for
    // one shared k that keeps the whole group rigid (see its own comment).
    const corners = [];
    for (const b of selectedBlocks) for (const c of blockCorners(b)) corners.push([c[0]-anchorWorld[0], c[1]-anchorWorld[1]]);
    const minStartScale = Math.min(...members.map(m => m.startScale));
    interaction = { mode: 'scaleGroup', anchorWorld, startDist, members,
      corners, minStartScale, excludeSet: new Set(selectedBlocks),
      startFrameCorners: envCorners.map(c => c.slice()) };
  } else if (hit.type === 'rotateGroup'){
    const c = selectionFrame.corners;
    const pivot = [(c[0][0]+c[2][0])/2, (c[0][1]+c[2][1])/2];   // diagonal midpoint — the frame's own center, rotated or not
    const startAngle = Math.atan2(wy - pivot[1], wx - pivot[0]) * 180/Math.PI;
    const members = [...selectedBlocks].map(b => ({ block: b, startX: b.x, startY: b.y, startRotationDeg: b.rotationDeg }));
    interaction = { mode: 'rotateGroup', pivot, startAngle, members,
      startFrameCorners: c.map(pt => pt.slice()) };
    $('paperPane').style.cursor = 'default';
    lastCursor = 'default';
  }
}, { capture: true });
$('paperPane').addEventListener('pointermove', e => {
  if (activeTab !== 'layout') return;
  const [wx, wy] = screenToCanvasMm(e.clientX, e.clientY);
  if (!interaction){
    if (e.target.closest(LAYOUT_UI_CHROME_SELECTOR)){
      if (lastCursor !== null){ $('paperPane').style.cursor = ''; lastCursor = null; }
      return;
    }
    updateHoverCursor(wx, wy);
    return;
  }
  if (interaction.mode === 'move'){
    let dx = wx - interaction.startWorld[0], dy = wy - interaction.startWorld[1];
    if (Math.hypot(dx, dy) > 1e-6) interaction.moved = true;
    if (e.shiftKey){
      // Constrain to whichever axis has the larger total drag delta from
      // the start — re-evaluated every frame (not locked to whichever was
      // dominant when shift was first pressed), so it can flip near the
      // diagonal the same way Illustrator/Figma's does.
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0;
    }
    const excludeSet = new Set(interaction.members.map(m => m.block));
    const snap = computeMoveSnap(interaction.startEnv, excludeSet, dx, dy);
    let { dx: finalDx, dy: finalDy, guideX, guideY, guideXRange, guideYRange } = snap;
    if (e.shiftKey){
      // Re-apply the axis lock AFTER snapping too — snapping alone could
      // otherwise reintroduce a small amount of cross-axis movement.
      if (dy === 0){ finalDy = 0; guideY = null; guideXRange = null; }
      else { finalDx = 0; guideX = null; guideYRange = null; }
    }
    for (const m of interaction.members){
      m.block.x = m.startX + finalDx;
      m.block.y = m.startY + finalDy;
      updateBlockTransform(m.block);
    }
    if (interaction.startFrameCorners){
      selectionFrame.corners = interaction.startFrameCorners.map(([x,y]) => [x+finalDx, y+finalDy]);
    }
    drawSnapGuides({ guideX, guideY, guideXRange, guideYRange });
  } else if (interaction.mode === 'rotate'){
    const b = interaction.block;
    const curAngle = Math.atan2(wy - b.y, wx - b.x) * 180/Math.PI;
    const raw = interaction.startRotation + (curAngle - interaction.startAngle);
    const snapped = Math.round(raw / 5) * 5;
    b.rotationDeg = ((snapped % 360) + 360) % 360;
    updateBlockTransform(b);
    showRotateLabel(b.rotationDeg, e.clientX, e.clientY);
  } else if (interaction.mode === 'rotateGroup'){
    // The snapped DELTA is what gets shared across every member — not each
    // one's own absolute resulting rotation snapped independently, which
    // (since members can start at different rotations) would give each
    // block a different actual delta and break the group's rigidity. See
    // the spec discussion this was built from.
    const curAngle = Math.atan2(wy - interaction.pivot[1], wx - interaction.pivot[0]) * 180/Math.PI;
    const rawDelta = curAngle - interaction.startAngle;
    const snappedDelta = Math.round(rawDelta / 5) * 5;
    const rad = snappedDelta * Math.PI/180, cos = Math.cos(rad), sin = Math.sin(rad);
    const [px, py] = interaction.pivot;
    for (const m of interaction.members){
      m.block.rotationDeg = ((m.startRotationDeg + snappedDelta) % 360 + 360) % 360;
      const dx = m.startX - px, dy = m.startY - py;
      m.block.x = px + (dx*cos - dy*sin);
      m.block.y = py + (dx*sin + dy*cos);
      updateBlockTransform(m.block);
    }
    // The selection box itself rotates rigidly right along with the group
    // — not recomputed as a fresh axis-aligned union — and this rotated
    // shape is what persists in selectionFrame for subsequent gestures,
    // until the selected SET itself changes (see resetSelectionFrame).
    selectionFrame.corners = interaction.startFrameCorners.map(([x,y]) => {
      const dx = x - px, dy = y - py;
      return [px + (dx*cos - dy*sin), py + (dx*sin + dy*cos)];
    });
    showRotateLabel(((snappedDelta % 360) + 360) % 360, e.clientX, e.clientY);
  } else if (interaction.mode === 'scale' || interaction.mode === 'scaleGroup'){
    const curDist = Math.hypot(wx - interaction.anchorWorld[0], wy - interaction.anchorWorld[1]);
    const minK = MIN_BLOCK_SCALE / interaction.minStartScale;
    const naturalK = Math.max(minK, curDist / interaction.startDist);
    const scaleSnap = computeScaleSnap(interaction, naturalK);
    const k = scaleSnap.k;
    drawSnapGuides(scaleSnap);
    const [ax, ay] = interaction.anchorWorld;
    for (const m of interaction.members){
      m.block.scale = m.startScale * k;
      m.block.x = ax + (m.startX - ax) * k;
      m.block.y = ay + (m.startY - ay) * k;
      updateBlockTransform(m.block);
      updateBlockStyle(m.block);
      updateDimensionLabels(m.block);
    }
    if (interaction.mode === 'scaleGroup'){
      selectionFrame.corners = interaction.startFrameCorners.map(([x,y]) => [ax + (x-ax)*k, ay + (y-ay)*k]);
    }
  }
  updateSelectionOverlay();
});
function endInteraction(){
  // Resolved independent of whether an interaction/drag was actually
  // created — clicking an already-selected member of a group that also
  // contains a locked block sets pendingCollapseTo but never creates a
  // move interaction (locked groups can't be transformed at all), so
  // gating this behind "interaction exists" would silently skip the
  // collapse for exactly that case.
  const hadInteraction = !!interaction;   // a scale drag changes on-page length — refresh stats once it settles
  if (pendingCollapseTo && !(interaction && interaction.mode === 'move' && interaction.moved)){
    setSelection([pendingCollapseTo]);
  }
  pendingCollapseTo = null;
  if (!interaction) return;
  interaction = null;
  clearSnapGuides();
  hideRotateLabel();
  hideDimensionLabels();
  if (hadInteraction) refreshStatusR();
}
$('paperPane').addEventListener('pointerup', endInteraction);
$('paperPane').addEventListener('pointercancel', endInteraction);

/* ================= per-block layer visibility context menu =================
   Right-clicking a block overrides the browser's default context menu with
   a small list of just that block's OWN layers (only the ones it actually
   has geometry for — layerPaths keys — not every entry in LAYERS), each
   toggleable independently. This is where the per-block visibility state
   introduced above actually gets edited after the fact.
   The "Override" checkbox at the bottom (static — see index.html, not
   rebuilt every time this function runs, so its own listener stays a
   single, permanent one rather than accumulating a fresh copy on every
   rebuild) switches the WHOLE block between reading color/width/dash live
   from the panel (today's default, unchanged) and reading its own
   independent per-layer values instead — editable right here, inline, once
   Override is checked. Those per-layer values (block.overrideStyle) are
   populated lazily, one layer at a time, the first time that layer is shown
   with Override on for this block — not all at once, and not re-snapshotted
   on every subsequent toggle — and then persist even if Override gets
   switched off again, so re-checking it later restores what was last set. */
let contextMenuBlock = null;
let contextMenuPos = { x: 0, y: 0 };
function openLayerContextMenu(block, clientX, clientY){
  contextMenuBlock = block;
  contextMenuPos = { x: clientX, y: clientY };
  $('layerContextOverrideChk').checked = !!block.override;
  $('layerContextMenu').classList.toggle('overrideActive', !!block.override);
  const list = $('layerContextMenuList');
  list.innerHTML = '';
  for (const L of LAYERS){
    if (!(L.key in block.layerPaths)) continue;
    const row = document.createElement('div');
    row.className = 'savedView';
    let html =
      '<span class="svName">' + L.name + '</span>' +
      '<button type="button" class="svBtn svEye" title="Toggle visibility" aria-label="Toggle ' + L.name + ' visibility">' +
        (block.layerVisible[L.key] ? '&#9673;' : '&#9675;') + '</button>';
    if (block.override){
      if (!block.overrideStyle[L.key]){
        const els = layerEls[L.key];
        block.overrideStyle[L.key] = { color: els.col.value, width: +els.wid.value, dash: els.dash.value };
      }
      const st = block.overrideStyle[L.key];
      html +=
        // Empty spacer — occupies the extra grid column between the eye
        // toggle and these settings (see .overrideActive CSS), visually
        // separating "visibility" from "the rest of the per-layer style".
        '<span class="ctxSpacer" aria-hidden="true"></span>' +
        '<input type="color" value="' + st.color + '" aria-label="' + L.name + ' override color">' +
        '<input type="number" value="' + fmtWidth(st.width) + '" min="0.1" max="6" step="0.05" aria-label="' + L.name + ' override width">' +
        '<select aria-label="' + L.name + ' override dash">' + dashOptionsHtml() + '</select>';
    }
    // Assigned ONCE, in full, before any listener gets attached below — an
    // earlier version built this with a second row.innerHTML += for the
    // override controls, which re-serializes and re-parses the WHOLE row
    // (including the eye button set up in the first assignment), silently
    // destroying that original element and its listener along with it.
    // That was exactly why the eye toggle stopped responding whenever
    // Override was on.
    row.innerHTML = html;
    row.querySelector('.svEye').addEventListener('click', () => {
      block.layerVisible[L.key] = !block.layerVisible[L.key];
      updateBlockStyle(block);
      refreshStatusR();
      openLayerContextMenu(block, clientX, clientY);   // cheap full rebuild — refreshes the toggled icon
    });
    if (block.override){
      const st = block.overrideStyle[L.key];
      const colorInput = row.children[3], widthInput = row.children[4], dashSelect = row.children[5];
      dashSelect.value = st.dash;
      colorInput.addEventListener('input', () => { st.color = colorInput.value; updateBlockStyle(block); });
      widthInput.addEventListener('input', () => { st.width = Math.max(0.1, +widthInput.value || 0.1); updateBlockStyle(block); });
      widthInput.addEventListener('change', () => { widthInput.value = fmtWidth(+widthInput.value); });
      dashSelect.addEventListener('change', () => { st.dash = dashSelect.value; updateBlockStyle(block); refreshStatusR(); });
    }
    list.appendChild(row);
  }
  const menu = $('layerContextMenu');
  menu.style.display = 'block';
  // Clamp on-screen so the menu never renders partly off the viewport edge
  const menuRect = menu.getBoundingClientRect();
  const x = Math.min(clientX, window.innerWidth - menuRect.width - 8);
  const y = Math.min(clientY, window.innerHeight - menuRect.height - 8);
  menu.style.left = Math.max(8, x) + 'px';
  menu.style.top = Math.max(8, y) + 'px';
}
$('layerContextOverrideChk').addEventListener('change', e => {
  if (!contextMenuBlock) return;
  contextMenuBlock.override = e.target.checked;
  updateBlockStyle(contextMenuBlock);
  refreshStatusR();   // switches which dash (live panel vs. this block's own override) governs the ink length
  openLayerContextMenu(contextMenuBlock, contextMenuPos.x, contextMenuPos.y);   // rebuild to show/hide the expanded controls
});
function closeLayerContextMenu(){
  contextMenuBlock = null;
  $('layerContextMenu').style.display = 'none';
}
$('paperPane').addEventListener('contextmenu', e => {
  if (activeTab !== 'layout') return;
  if (e.target.closest(LAYOUT_UI_CHROME_SELECTOR)) return;
  const [wx, wy] = screenToCanvasMm(e.clientX, e.clientY);
  const hit = hitTestBlockBody(wx, wy);
  if (!hit){ closeLayerContextMenu(); return; }   // let the browser's default menu show over empty canvas
  e.preventDefault();
  // Deliberately does NOT change the current selection — right-click edits
  // whichever block is under the cursor, independent of a broader multi-
  // selection, so you can peek at one layer's overrides without losing it.
  openLayerContextMenu(hit, e.clientX, e.clientY);
}, { capture: true });
document.addEventListener('pointerdown', e => {
  if (contextMenuBlock && !$('layerContextMenu').contains(e.target)) closeLayerContextMenu();
});
const NUDGE_KEYS = { ArrowUp: [0,-1], ArrowDown: [0,1], ArrowLeft: [-1,0], ArrowRight: [1,0] };
document.addEventListener('keydown', e => {
  if (contextMenuBlock && e.key === 'Escape') closeLayerContextMenu();
  if (NUDGE_KEYS[e.key] && activeTab === 'layout' && selectedBlocks.size && !selectionAnyLocked()){
    // Arrow keys have native meaning in text inputs (cursor movement) and
    // number inputs (increment/decrement) — e.g. the block name field or
    // any of the Override menu's inline color/width/dash controls — so
    // this only fires when focus isn't inside one of those.
    const a = document.activeElement;
    const isTyping = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
    if (!isTyping){
      e.preventDefault();
      const amount = e.shiftKey ? 5 : 0.5;
      const [dx, dy] = NUDGE_KEYS[e.key];
      for (const b of selectedBlocks){
        b.x += dx * amount;
        b.y += dy * amount;
        updateBlockTransform(b);
      }
      updateSelectionOverlay();
    }
  }
});
['pointerdown','wheel'].forEach(t => $('layerContextMenu').addEventListener(t, e => e.stopPropagation()));

/* ================= block list UI ================= */
/* ================= block list drag-reorder =================
   Dedicated grip handle (not the whole row) starts a drag — the row
   already has several other click targets (select, eye, lock, delete,
   double-click-to-rename), so a whole-row drag would create ambiguity
   with those. Tracked with plain pointer events (matching how block move/
   rotate/scale on the canvas itself already work in this file) rather
   than native HTML5 drag-and-drop, which isn't used anywhere else here
   and tends to fight custom insertion-line feedback like this.
   The dragged row stays in place, dimmed, while an insertion line shows
   where it would land among the OTHER rows; the actual reorder only
   happens on drop. Reordering is done entirely in "visual" (displayed)
   order — a reversed copy of blocks[] — then reversed back once at the
   end, rather than computing array-index arithmetic under the reversal,
   which is easy to get off-by-one on. */
let blockDragState = null;
function startBlockDrag(e, block, row){
  e.preventDefault();
  e.stopPropagation();
  const rows = [...$('blocksList').children].filter(el => el.classList.contains('savedView'));
  const insertLine = document.createElement('div');
  insertLine.className = 'svInsertLine';
  row.classList.add('svDragging');
  blockDragState = { block, row, rows, insertLine, target: null };
  e.target.setPointerCapture(e.pointerId);
}
document.addEventListener('pointermove', e => {
  if (!blockDragState) return;
  const { row, rows, insertLine } = blockDragState;
  const list = $('blocksList');
  const others = rows.filter(r => r !== row);
  let target = null;
  for (const r of others){
    const rect = r.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height/2){ target = r; break; }
  }
  blockDragState.target = target;   // null means "after every other row"
  if (!insertLine.parentNode) list.appendChild(insertLine);
  // Positioned via absolute top offset (see .svInsertLine — out of normal
  // flow entirely) rather than DOM insertion order, specifically so it
  // never adds to the list's own content height: inserting it as a real
  // flow element was occasionally enough to tip the list over its
  // max-height and pop the scrollbar open mid-drag.
  const listRect = list.getBoundingClientRect();
  const INSERT_LINE_HEIGHT = 2;   // keep in sync with .svInsertLine's own height in styles.css
  let lineTop;
  if (target) lineTop = target.getBoundingClientRect().top - listRect.top + list.scrollTop;
  else if (others.length){
    // Bottom-of-list case — anchor the line's BOTTOM edge (not top) to the
    // last row's bottom, so the line's own height stays within the
    // existing content bounds instead of extending past it. Anchoring by
    // top here (matching the target case above) would put the line's
    // bottom 2px beyond the true content edge — even fully absolutely-
    // positioned, that still counts toward the list's scrollable overflow,
    // which was popping the scrollbar open specifically in this one case.
    lineTop = others[others.length-1].getBoundingClientRect().bottom - listRect.top + list.scrollTop - INSERT_LINE_HEIGHT;
  }
  else lineTop = 0;
  insertLine.style.top = lineTop + 'px';
});
document.addEventListener('pointerup', () => {
  if (!blockDragState) return;
  const { block, row, rows, insertLine, target } = blockDragState;
  insertLine.remove();
  row.classList.remove('svDragging');
  blockDragState = null;

  const others = rows.filter(r => r !== row);
  const insertAt = target ? others.indexOf(target) : others.length;

  const visualOrder = blocks.slice().reverse();
  const fromIdx = visualOrder.indexOf(block);
  if (fromIdx === -1) return;   // block was deleted mid-drag — nothing to do
  visualOrder.splice(fromIdx, 1);
  visualOrder.splice(insertAt, 0, block);
  blocks = visualOrder.slice().reverse();

  // Sync actual SVG paint order to match — re-appending an already-present
  // child moves it to the end, so appending every block in the new array
  // order, in sequence, reproduces that order in the DOM.
  const blocksLayer = $('layoutBlocksLayer');
  for (const b of blocks) if (b.dom) blocksLayer.appendChild(b.dom.outer);
  renderBlocksList();
});

function renderBlocksList(){
  const list = $('blocksList');
  list.innerHTML = '';
  $('blocksFloat').classList.toggle('svEmpty', blocks.length === 0);
  syncDuplicateBlockBtn();
  // Displayed top-to-bottom in front-to-back order (top of list = drawn on
  // top, matching the common layers-panel convention) — the reverse of
  // blocks[]'s own storage order (index 0 = drawn first/underneath,
  // matching how new blocks are appended to the END of both the array and
  // the DOM). Reversed only for this display — blocks[] itself, and every
  // other place that iterates it, is untouched.
  for (const block of blocks.slice().reverse()){
    const row = document.createElement('div');
    row.className = 'savedView' + (block.visible ? '' : ' svRowHidden') +
      (selectedBlocks.has(block) ? ' svRowSelected' : '');
    row.dataset.blockName = block.name;
    row.innerHTML =
      '<span class="svDragHandle" title="Drag to reorder" aria-label="Drag to reorder ' + block.name + '">' +
        '<svg viewBox="0 0 10 16" width="8" height="14" fill="currentColor">' +
          '<circle cx="2" cy="2" r="1.3"/><circle cx="8" cy="2" r="1.3"/>' +
          '<circle cx="2" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/>' +
          '<circle cx="2" cy="14" r="1.3"/><circle cx="8" cy="14" r="1.3"/>' +
        '</svg>' +
      '</span>' +
      '<span class="svName">' + block.name + '</span>' +
      '<button type="button" class="svBtn svEye" title="Toggle visibility" aria-label="Toggle ' + block.name + ' visibility">' +
        (block.visible ? '&#9673;' : '&#9675;') + '</button>' +
      '<button type="button" class="svBtn svLock' + (block.locked ? ' svLockActive' : '') + '" title="' + (block.locked ? 'Unlock' : 'Lock') +
        ' — prevents move/rotate/scale on the canvas" aria-label="' + (block.locked ? 'Unlock' : 'Lock') + ' ' + block.name + '">' +
        (block.locked
          ? '<svg viewBox="0 0 134 134" width="13" height="13" fill="currentColor"><g transform="matrix(1.091075,0,0,1.179063,-6.236398,-17.854001)"><path d="M96.925,58.247C103.393,59.463 108.267,64.76 108.267,71.102L108.267,99.68C108.267,106.92 101.915,112.797 94.092,112.797L39.543,112.797C31.72,112.797 25.368,106.92 25.368,99.68L25.368,71.102C25.368,64.76 30.242,59.463 36.71,58.247L36.71,47.771C36.71,38.278 45.038,30.572 55.296,30.572L78.339,30.572C88.597,30.572 96.925,38.278 96.925,47.771L96.925,58.247ZM50.839,57.984L82.796,57.984L82.796,47.771C82.796,45.494 80.799,43.646 78.339,43.646L55.296,43.646C52.836,43.646 50.839,45.494 50.839,47.771L50.839,57.984Z"/></g></svg>'
          : '<svg viewBox="0 0 134 134" width="13" height="13" fill="currentColor"><g transform="matrix(1.091075,0,0,1.179063,-6.236398,-11.738486)"><path d="M96.925,58.247C103.393,59.463 108.267,64.76 108.267,71.102L108.267,99.68C108.267,106.92 101.915,112.797 94.092,112.797L39.543,112.797C31.72,112.797 25.368,106.92 25.368,99.68L25.368,71.102C25.368,63.862 31.72,57.984 39.543,57.984L82.796,57.984L82.796,37.397C82.796,35.121 80.799,33.273 78.339,33.273L55.296,33.273C52.836,33.273 50.839,35.121 50.839,37.397L50.839,49.019L36.71,49.019L36.71,37.397C36.71,27.905 45.038,20.198 55.296,20.198L78.339,20.198C88.597,20.198 96.925,27.905 96.925,37.397L96.925,58.247Z"/></g></svg>'
        ) + '</button>' +
      '<button type="button" class="svBtn svDelete" title="Delete layer" aria-label="Delete ' + block.name + '">&#10005;</button>';
    row.querySelector('.svDragHandle').addEventListener('pointerdown', e => startBlockDrag(e, block, row));
    // Shift+click is also the browser's native "extend text selection"
    // gesture — without this, shift-selecting rows in quick succession
    // also highlights the row's own text (name/buttons) as a side effect.
    // preventDefault on mousedown (before any selection is even started)
    // is the standard fix; excludes the same interactive sub-elements the
    // click handler below already excludes, so button presses and the
    // drag handle keep their own normal behavior.
    row.addEventListener('mousedown', e => {
      if (e.shiftKey && !e.target.closest('button') && !e.target.closest('.svDragHandle')) e.preventDefault();
    });
    row.addEventListener('click', e => {
      if (e.target.closest('button') || e.target.closest('.svDragHandle')) return;   // Eye/Lock/Delete/drag clicks bubble here too — don't also select
      if (block.locked) return;   // never selectable, same rule as the canvas — see hitTestBlockBody
      // Same shift-click-toggles / plain-click-replaces rule as the canvas
      // (see the pointerdown handler there) — deliberately NOT the deferred
      // collapse-on-drag refinement, since a list row click can't "drag the
      // whole group" the way grabbing a canvas block can.
      if (e.shiftKey) toggleSelection(block); else setSelection([block]);
    });
    makeNameEditable(row.querySelector('.svName'), () => block.name, newName => {
      block.name = newName;
      renderBlocksList();
    });
    row.querySelector('.svEye').addEventListener('click', () => {
      block.visible = !block.visible;
      if (!block.visible) deselectBlock(block);
      updateBlockTransform(block);
      refreshStatusR();
      renderBlocksList();
    });
    row.querySelector('.svLock').addEventListener('click', () => {
      block.locked = !block.locked;
      // Locked blocks are never selectable at all — deselect immediately
      // rather than leave a now-locked block lingering in the selection.
      if (block.locked) deselectBlock(block); else if (selectedBlocks.has(block)) updateSelectionOverlay();
      renderBlocksList();
    });
    row.querySelector('.svDelete').addEventListener('click', () => {
      const i = blocks.indexOf(block);
      if (i >= 0) blocks.splice(i, 1);
      deselectBlock(block);
      if (contextMenuBlock === block) closeLayerContextMenu();
      removeBlockDom(block);
      refreshStatusR();
      renderBlocksList();
    });
    list.appendChild(row);
  }
}
renderBlocksList();   // sets the initial empty-state class — no other call site runs unconditionally at load

$('addToLayoutBtn').addEventListener('click', () => freezeCurrentGeneration());
$('clearBlocksBtn').addEventListener('click', () => {
  if (!blocks.length) return;
  if (!confirm('Delete all ' + blocks.length + ' layer(s)? This cannot be undone.')) return;
  for (const b of blocks) removeBlockDom(b);
  blocks = [];
  selectBlock(null);
  closeLayerContextMenu();
  refreshStatusR();
  renderBlocksList();
});

['pointerdown','wheel'].forEach(t => {
  $('blocksFloat').addEventListener(t, e => e.stopPropagation());
  $('paperTabs').addEventListener(t, e => e.stopPropagation());
  $('addToLayoutBtn').addEventListener(t, e => e.stopPropagation());
});
