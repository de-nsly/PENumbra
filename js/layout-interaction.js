/* ================================================================
   layout-interaction.js — selecting and manipulating blocks on the canvas
   The selection itself (a Set shared with the block list), the marquee,
   hit testing, the move/rotate/scale gestures with their snapping and
   guides, the rotate-angle and dimension labels, the hover cursor, and
   the pointer and keyboard listeners that drive all of it.
   Selection is TWO TIERS: `selectedBlocks` is the list-level selection
   and holds any block at all; the canvas acts only on the interactive
   subset of it (visible and unlocked) — see interactiveSelection().
   The gesture in progress lives in `interaction`, and the group's box in
   `selectionFrame`: persistent state that rigid transforms are applied
   TO rather than recomputed from the blocks, which is what keeps a
   rotated group's box rotated.
   ================================================================ */
import { $, isFormControlTarget, isTextEntryTarget, svgEl } from './main.js';
import { refreshStatusR } from './render-result.js';
import { activeTab } from './panel-controls.js';
import { updateRuler } from './paper-preview.js';
import { MIN_BLOCK_SCALE, addBlocks, blockCorners, blocks, canvasMmToScreen, cloneBlock, computeLayoutPaperDims, deleteBlocks, gridGuidePositions, localToWorld, mmPerScreenPx, screenToCanvasMm, syncDuplicateBlockBtn, updateBlockStyle, updateBlockTransform, worldEnvelope, worldToLocal } from './layout-canvas.js';
// Session-only multi-select — a Set, not a persistent named group. Single
// selection is just the size===1 case throughout, not a separate code
// path, EXCEPT where noted (rotate/scale hit-testing and math keep an
// entirely separate, untouched single-block path specifically so existing,
// already-tested single-block behavior can't regress from the new group
// math sharing a codepath with it).
// This is the LIST-level selection and holds any block at all, hidden and
// locked ones included; the canvas acts on the interactive subset of it
// instead — see the two-tier note above interactiveSelection().
export let selectedBlocks = new Set();
// The block a Shift+click range extends FROM (Windows Explorer's "anchor").
// Deliberately NOT bookkept when blocks are deleted or the
// selection is cleared/replaced (marquee, scene import, Delete All) — it's
// validated at its single read site instead (extendSelectionTo), where a
// stale anchor simply degrades the gesture to a plain click. That keeps
// every existing selection mutator below untouched.
let selectionAnchor = null;
let pendingCollapseTo = null;       // see the pointerdown handler: clicking an already-selected member of a
                                       // multi-selection defers collapsing to just that one block until pointerup,
                                       // and only if no drag actually happened — otherwise grabbing one member of
                                       // a group to drag the whole group would be impossible.
export let interaction = null;               // {mode:'move'|'rotate'|'scale', ...} while a drag is in progress, else null
// Screen-pixel constants for handle/rotate-zone sizing and snap threshold —
// converted to canvas-mm at whatever the CURRENT zoom is via mmPerScreenPx(),
// so they feel the same regardless of how zoomed in/out the layout canvas is.
const HANDLE_PX = 8;                  // visual size (side length) of each corner handle square
const HANDLE_HIT_PX = 11;             // slightly larger than visual, for easier grabbing
const ROTATE_GIZMO_OFFSET_PX = 24;    // distance from the top edge to the rotate gizmo circle
const ROTATE_GIZMO_RADIUS_PX = 4.8;   // visual radius of the gizmo circle
const ROTATE_GIZMO_HIT_PX = 10;       // hit radius for the gizmo — larger than visual, for easier grabbing
const DIM_LABEL_OFFSET_PX = 16;       // distance from the right/bottom edge midpoint to its dimension label
const SNAP_THRESHOLD_PX = 8;
// How far the pointer must travel before a gesture counts as a real drag
// rather than a click — in screen px, so it feels the same at every zoom.
// Shared by the marquee (below which a click still just selects/deselects)
// and by Alt+drag-to-duplicate (below which an Alt+click leaves no stray
// copy behind).
const DRAG_THRESHOLD_PX = 3;
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
// The one definition of "can this block be touched ON THE CANVAS" — hidden
// blocks aren't there to grab, and locking exists precisely to make a block
// unclickable/undraggable while leaving it drawn. Note what this is NOT: a
// rule about being SELECTED. See the two-tier note directly below.
function isInteractiveBlock(b){ return !!b && b.visible && !b.locked; }
// Selection is TWO TIERS, and the difference is the whole reason the rest
// of this section reads the way it does:
//   * selectedBlocks — the LIST-level selection. ANY block can be in it,
//     hidden and locked ones included, so that a whole batch of them can be
//     un-hidden/unlocked/deleted in one go from the Layers panel.
//   * interactiveSelection() — the subset the CANVAS acts on: selected AND
//     visible AND unlocked. This is what draws the overlay, seeds the
//     selection frame, hit-tests, and drives every move/rotate/scale/nudge.
// A hidden or locked block therefore shows as selected in the list while
// being completely inert on the page: no outline, no handles, never moved
// by a group drag or the arrow keys. Returned in blocks[] order rather than
// Set-insertion order, so anything that cares about stacking is stable.
export function interactiveSelection(){
  return blocks.filter(b => selectedBlocks.has(b) && isInteractiveBlock(b));
}
// The interactive subset can change without the SELECTION changing — the
// eye and lock buttons do exactly that. Reseeding the frame and redrawing
// the overlay is then all that's needed; the list highlight is untouched
// because those blocks stay selected.
export function refreshInteractiveSelection(){
  resetSelectionFrame();
  updateSelectionOverlay();
}
// Platform-correct multi-select modifier: Cmd on macOS, Ctrl everywhere
// else. Deliberately NOT "ctrlKey || metaKey" — on macOS Ctrl+click is the
// system secondary-click gesture and also fires `contextmenu`, so accepting
// Ctrl there would toggle the selection AND open a context menu from one
// click (the per-block layer menu on the canvas, the browser's own on a
// list row).
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(
  (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent);
export function multiSelectKey(e){ return IS_MAC ? e.metaKey : e.ctrlKey; }
// Union of every INTERACTIVE selected block's own world-space envelope —
// the group's own axis-aligned bounding box, freshly recomputed. Used ONLY
// to seed a NEW selectionFrame when that set changes — for drawing the
// overlay and driving group interactions once a selection exists,
// selectionFrame (below) is what's actually used, not this.
function selectionEnvelope(){
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for (const b of interactiveSelection()){
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
export let selectionFrame = null;
function resetSelectionFrame(){
  if (interactiveSelection().length <= 1){ selectionFrame = null; return; }
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
export function setSelection(blocksArr){
  selectedBlocks = new Set(blocksArr);
  resetSelectionFrame();
  updateSelectionOverlay();
  refreshSelectionHighlight();
  syncDuplicateBlockBtn();
}
export function clearSelection(){ if (selectedBlocks.size) setSelection([]); }
// Ctrl/Cmd+click: add or remove one block, leaving the rest of the
// selection alone. Explorer moves the anchor to whatever was just
// Ctrl+clicked (so a following Shift+click extends from there), including
// when that click REMOVED the block from the selection.
export function toggleSelection(block){
  const next = new Set(selectedBlocks);
  if (next.has(block)) next.delete(block); else next.add(block);
  selectionAnchor = block;
  setSelection([...next]);
}
// Plain click: this block and nothing else, and it becomes the new anchor.
export function selectOnly(block){
  selectionAnchor = block;
  setSelection([block]);
}
// The anchor a following Shift+click extends from, for the one caller outside
// this module: adding blocks (layout-canvas.js) makes the last one the anchor
// as well as the selection, so a Shift+click after a paste behaves as if that
// block had just been clicked.
export function setSelectionAnchor(block){ selectionAnchor = block; }
// Shift+click: every block from the anchor to `block` inclusive, replacing
// the current selection — or, with Ctrl/Cmd also held, unioned with it.
// Computed in blocks[] index space even though the list renders reversed
// (see renderBlocksList): reversing an array preserves contiguity, so
// min..max here is the same SET as the visually contiguous run. That is
// specifically unlike the drag-reorder code further down, which does need
// its own visualOrder copy because there the resulting POSITION matters,
// not just which blocks are included.
export function extendSelectionTo(block, additive){
  const fromIdx = selectionAnchor ? blocks.indexOf(selectionAnchor) : -1;
  const toIdx = blocks.indexOf(block);
  // No usable anchor (never set, or it was since deleted) — fall back to
  // treating this as a plain click rather than guessing.
  if (fromIdx < 0 || toIdx < 0){ selectOnly(block); return; }
  const lo = Math.min(fromIdx, toIdx), hi = Math.max(fromIdx, toIdx);
  const next = new Set(additive ? selectedBlocks : []);
  // Hidden and locked blocks in the span are included like any other — the
  // list-level selection has no eligibility rule (see interactiveSelection).
  for (let i = lo; i <= hi; i++) next.add(blocks[i]);
  // Anchor deliberately left where it is — successive Shift+clicks all
  // extend from the same origin, growing and shrinking one range rather
  // than walking it along.
  setSelection([...next]);
}
// Which blocks a per-row button (eye / lock / delete) acts on: the whole
// selection when the clicked row is part of it, otherwise just that one
// row, with the selection left alone — the same rule Explorer uses for
// acting on a file inside vs. outside the current selection. Returned in
// blocks[] order, not Set-insertion order, so callers that care about
// stacking get a stable, meaningful sequence.
export function rowActionScope(block){
  return selectedBlocks.has(block) ? blocks.filter(b => selectedBlocks.has(b)) : [block];
}
export function updateSelectionOverlay(){
  const ov = $('layoutOverlaySvg');
  ov.innerHTML = '';
  updateRuler();   // this wipe just took the ruler out with it — put it back before any of the early returns below
  // Everything below is driven by the INTERACTIVE subset, never the raw
  // selection — a hidden or locked block is selected in the list but draws
  // no chrome at all here (see interactiveSelection).
  const active = interactiveSelection();
  if (active.length === 0) return;
  if (active.length === 1){
    // Exactly the original single-block rendering, unchanged — handles sit
    // at the block's OWN (possibly rotated) corners, not an axis-aligned
    // box, so a single rotated block's selection outline still hugs it
    // exactly rather than showing a needlessly larger axis-aligned box.
    const block = active[0];
    const corners = blockCorners(block).map(([wx, wy]) => canvasMmToScreen(wx, wy));
    const rectPath = svgEl('path');
    rectPath.setAttribute('class', 'layoutSelRect');
    rectPath.setAttribute('d', 'M' + corners.map(p => p[0] + ',' + p[1]).join('L') + 'Z');
    ov.appendChild(rectPath);
    for (const [cx, cy] of corners){
      const sq = svgEl('rect');
      sq.setAttribute('class', 'layoutSelHandle');
      sq.setAttribute('x', cx - HANDLE_PX/2); sq.setAttribute('y', cy - HANDLE_PX/2);
      sq.setAttribute('width', HANDLE_PX); sq.setAttribute('height', HANDLE_PX);
      sq.setAttribute('transform', 'rotate(' + block.rotationDeg + ' ' + cx + ' ' + cy + ')');
      ov.appendChild(sq);
    }
    const [gwx, gwy, twx, twy] = rotateGizmoWorldPos(block);
    const [gx, gy] = canvasMmToScreen(gwx, gwy), [tx, ty] = canvasMmToScreen(twx, twy);
    const connector = svgEl('line');
    connector.setAttribute('class', 'layoutRotateConnector');
    connector.setAttribute('x1', tx); connector.setAttribute('y1', ty);
    connector.setAttribute('x2', gx); connector.setAttribute('y2', gy);
    ov.appendChild(connector);
    const gizmo = svgEl('circle');
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
  for (const b of active){
    const corners = blockCorners(b).map(([wx, wy]) => canvasMmToScreen(wx, wy));
    const p = svgEl('path');
    p.setAttribute('class', 'layoutSelRectMember');
    p.setAttribute('d', 'M' + corners.map(pt => pt[0] + ',' + pt[1]).join('L') + 'Z');
    ov.appendChild(p);
  }
  const frameWorld = selectionFrame.corners;
  const corners = frameWorld.map(([wx,wy]) => canvasMmToScreen(wx,wy));
  const rectPath = svgEl('path');
  rectPath.setAttribute('class', 'layoutSelRect');
  rectPath.setAttribute('d', 'M' + corners.map(p => p[0] + ',' + p[1]).join('L') + 'Z');
  ov.appendChild(rectPath);
  // Handle squares rotate to match the frame's own current edge angle (the
  // corners[0]->corners[1] "top edge," whatever orientation it's actually
  // in right now), same visual language as a single block's own rotated
  // handles — not left axis-aligned once the frame itself is rotated.
  const frameAngleDeg = selectionFrameAngleDeg(selectionFrame);
  for (const [cx, cy] of corners){
    const sq = svgEl('rect');
    sq.setAttribute('class', 'layoutSelHandle');
    sq.setAttribute('x', cx - HANDLE_PX/2); sq.setAttribute('y', cy - HANDLE_PX/2);
    sq.setAttribute('width', HANDLE_PX); sq.setAttribute('height', HANDLE_PX);
    sq.setAttribute('transform', 'rotate(' + frameAngleDeg + ' ' + cx + ' ' + cy + ')');
    ov.appendChild(sq);
  }
  const [gwx, gwy, twx, twy] = groupRotateGizmoWorldPos({ corners: frameWorld });
  const [gx, gy] = canvasMmToScreen(gwx, gwy), [tx, ty] = canvasMmToScreen(twx, twy);
  const connector = svgEl('line');
  connector.setAttribute('class', 'layoutRotateConnector');
  connector.setAttribute('x1', tx); connector.setAttribute('y1', ty);
  connector.setAttribute('x2', gx); connector.setAttribute('y2', gy);
  ov.appendChild(connector);
  const gizmo = svgEl('circle');
  gizmo.setAttribute('class', 'layoutRotateGizmo');
  gizmo.setAttribute('cx', gx); gizmo.setAttribute('cy', gy);
  gizmo.setAttribute('r', ROTATE_GIZMO_RADIUS_PX);
  ov.appendChild(gizmo);
}
// The eye/lock/delete buttons' labels live here rather than in
// renderBlocksList's row markup because they depend on the CURRENT
// selection — each button acts on the whole selection when its own row is
// part of one (see rowActionScope), and a click that hides or deletes five
// layers at once should say so before it happens, not after. Owned in one
// place so the two states can't word the same action differently.
function applyRowBtnLabels(row, block, selCount){
  const target = (selCount > 1 && selectedBlocks.has(block)) ? 'all ' + selCount + ' selected layers' : block.name;
  const label = (sel, text) => {
    const btn = row.querySelector(sel);
    if (!btn) return;
    btn.title = text;
    btn.setAttribute('aria-label', text);
  };
  label('.svEye', 'Toggle visibility — ' + target);
  label('.svLock', (block.locked ? 'Unlock ' : 'Lock ') + target + ' — prevents move/rotate/scale on the canvas');
  label('.svDelete', 'Delete ' + target);
}
// The block a list row stands for, or undefined for anything in the list
// that isn't a row (the drag-reorder insertion line carries no blockId).
// id, not name or position: names are user-editable and duplicable, and rows
// get rebuilt from scratch constantly — see blockIdCounter.
export function blockForRow(row){
  return blocks.find(b => b.id === +row.dataset.blockId);
}
export function refreshSelectionHighlight(){
  const selCount = selectedBlocks.size;
  for (const row of $('blocksList').children){
    const block = blockForRow(row);
    row.classList.toggle('svRowSelected', !!block && selectedBlocks.has(block));
    // Skips the drag-reorder insertion line, which lives in this same list
    // but carries no blockId of its own.
    if (block) applyRowBtnLabels(row, block, selCount);
  }
}

/* ================= marquee (rubber-band) select =================
   Left-drag starting on empty canvas — same gesture as Illustrator/
   Photoshop: any VISIBLE, UNLOCKED block whose envelope overlaps the
   marquee rect (any amount counts) is selected, live, as the rect grows or
   shrinks, using plain axis-aligned envelope overlap — the same box
   worldEnvelope() already gives every other selection/snap computation in
   this file, not exact rotated-shape intersection. Shift- (or Ctrl/Cmd-)
   drag is additive:
   the live selection becomes preSelection (whatever was selected when the
   drag started) UNION whatever's currently overlapping, so blocks selected
   before the marquee began stay selected even once the marquee moves away
   from them. */
function marqueeRectWorld(interaction){
  const [x0, y0] = interaction.startWorld, [x1, y1] = interaction.curWorld;
  return { x0: Math.min(x0,x1), x1: Math.max(x0,x1), y0: Math.min(y0,y1), y1: Math.max(y0,y1) };
}
function envelopesOverlap(a, b){
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}
function updateMarqueeSelection(interaction, additive){
  const rect = marqueeRectWorld(interaction);
  const next = new Set(additive ? interaction.preSelection : []);
  for (const b of blocks){
    if (!isInteractiveBlock(b)) continue;
    if (envelopesOverlap(rect, worldEnvelope(b))) next.add(b);
  }
  setSelection([...next]);
}
// Drawn AFTER updateSelectionOverlay() (called separately, once per
// pointermove frame, right after the mode dispatch below) since that
// function wipes and rebuilds #layoutOverlaySvg from scratch every time it
// runs — appending the marquee rect here keeps it on top instead of having
// it erased by the very selection-set change it just caused.
function drawMarqueeRect(interaction){
  const rect = marqueeRectWorld(interaction);
  const corners = [[rect.x0,rect.y0],[rect.x1,rect.y0],[rect.x1,rect.y1],[rect.x0,rect.y1]]
    .map(([wx, wy]) => canvasMmToScreen(wx, wy));
  const rectPath = svgEl('path');
  rectPath.setAttribute('class', 'layoutSelRect');   // same dashed/contrast-aware styling as the ordinary selection box
  rectPath.setAttribute('d', 'M' + corners.map(p => p[0] + ',' + p[1]).join('L') + 'Z');
  $('layoutOverlaySvg').appendChild(rectPath);
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
  const gridGuides = gridGuidePositions(dims);
  const pageXRefs = [0, dims.margin.left, dims.paperW - dims.margin.right, dims.paperW, dims.paperW / 2, ...gridGuides.xs];
  const pageYRefs = [0, dims.margin.top, dims.paperH - dims.margin.bottom, dims.paperH, dims.paperH / 2, ...gridGuides.ys];
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
  const gridGuides = gridGuidePositions(dims);
  for (const v of [0, dims.margin.left, dims.paperW - dims.margin.right, dims.paperW, dims.paperW / 2, ...gridGuides.xs]) xTargets.push({ value: v, range: [0, dims.paperH] });
  for (const v of [0, dims.margin.top, dims.paperH - dims.margin.bottom, dims.paperH, dims.paperH / 2, ...gridGuides.ys]) yTargets.push({ value: v, range: [0, dims.paperW] });

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
    const line = svgEl('line');
    line.setAttribute('class', 'layoutSnapGuide');
    line.setAttribute('x1', snap.guideX); line.setAttribute('x2', snap.guideX);
    line.setAttribute('y1', snap.guideYRange[0]); line.setAttribute('y2', snap.guideYRange[1]);
    g.appendChild(line);
  }
  if (snap.guideY !== null){
    const line = svgEl('line');
    line.setAttribute('class', 'layoutSnapGuide');
    line.setAttribute('y1', snap.guideY); line.setAttribute('y2', snap.guideY);
    line.setAttribute('x1', snap.guideXRange[0]); line.setAttribute('x2', snap.guideXRange[1]);
    g.appendChild(line);
  }
}
function clearSnapGuides(){ $('layoutSnapGuides').innerHTML = ''; }

// Shift-drag axis-lock indicator — a full page-spanning line through the
// selection's center on whichever axis the drag is currently constrained
// to, distinct from drawSnapGuides()'s object/margin alignment guides
// above. 'x' means movement is locked to the X axis (dragging
// horizontally, so a horizontal line through the center); 'y' means
// locked to the Y axis (a vertical line). Colors intentionally mirror the
// axis-lock direction rather than reusing the accent color, so it reads
// as a distinct kind of guide from ordinary snap alignment.
function drawAxisLockGuide(axis, cx, cy){
  const g = $('layoutAxisGuides');
  g.innerHTML = '';
  const dims = computeLayoutPaperDims();
  const line = svgEl('line');
  line.setAttribute('class', 'layoutAxisLockGuide layoutAxisLockGuide-' + axis);
  if (axis === 'x'){
    line.setAttribute('x1', 0); line.setAttribute('x2', dims.paperW);
    line.setAttribute('y1', cy); line.setAttribute('y2', cy);
  } else {
    line.setAttribute('y1', 0); line.setAttribute('y2', dims.paperH);
    line.setAttribute('x1', cx); line.setAttribute('x2', cx);
  }
  g.appendChild(line);
}
function clearAxisLockGuide(){ $('layoutAxisGuides').innerHTML = ''; }

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
// Locked blocks are click-through ON THE CANVAS — not clickable, not
// right-clickable, never picked up here at all, as if they were transparent
// to interaction (their drawn geometry stays fully visible, just not
// interactive). They remain perfectly selectable from the Layers list; it's
// only the page that ignores them. Both the canvas click-select path AND
// the right-click context-menu path route through this same function, so
// excluding locked blocks here is the one change that covers both.
export function hitTestBlockBody(wx, wy){
  for (let i = blocks.length - 1; i >= 0; i--){
    const b = blocks[i];
    if (!isInteractiveBlock(b)) continue;
    const [lx, ly] = worldToLocal(b, wx, wy);
    if (lx >= b.bboxLocal.x0 && lx <= b.bboxLocal.x1 && ly >= b.bboxLocal.y0 && ly <= b.bboxLocal.y1){
      return b;
    }
  }
  return null;
}
function hitTest(wx, wy){
  // Chrome is hit-tested against the INTERACTIVE subset, matching exactly
  // what updateSelectionOverlay drew — a hidden or locked block is selected
  // in the list but has no handles or gizmo here to grab.
  const active = interactiveSelection();
  if (active.length === 1){
    const block = active[0];
    const [gx, gy] = rotateGizmoWorldPos(block);
    const gizmoHitMm = ROTATE_GIZMO_HIT_PX * mmPerScreenPx();
    if (Math.hypot(wx - gx, wy - gy) <= gizmoHitMm) return { type: 'rotate', block };
    const corners = blockCorners(block);
    const handleHitMm = HANDLE_HIT_PX * mmPerScreenPx();
    for (let i = 0; i < 4; i++){
      const dist = Math.hypot(wx - corners[i][0], wy - corners[i][1]);
      if (dist <= handleHitMm) return { type: 'scale', block, cornerIndex: i };
    }
  } else if (active.length > 1){
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
// Back to the pane's own default cursor, forgetting whatever shape the last
// hover left. For leaving the canvas behind entirely (the Preview tab), where
// there is no pointer position to re-derive a cursor from.
export function resetHoverCursor(){
  $('paperPane').style.cursor = '';
  lastCursor = null;
}
function updateHoverCursor(wx, wy, altKey){
  const hit = hitTest(wx, wy);
  const cursor = !hit ? 'default'
    : hit.type === 'scale' ? cornerCursorForRotation(hit.cornerIndex, hit.block.rotationDeg)
    // group box starts axis-aligned but stays rigidly rotated after a group
    // rotate gesture (see selectionFrame's own comment) — use its actual
    // current angle, same as the handle squares themselves already do.
    : hit.type === 'scaleGroup' ? cornerCursorForRotation(hit.cornerIndex, selectionFrameAngleDeg(selectionFrame))
    : hit.type === 'rotate' || hit.type === 'rotateGroup' ? 'grab'
    : hit.block.locked ? 'default'
    // Only refreshed on pointer movement, so it appears as soon as the
    // pointer stirs with Alt down rather than the instant Alt is pressed —
    // enough of an affordance without a pair of keydown/keyup listeners
    // whose only job would be repainting a cursor.
    : altKey ? 'copy'
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
export const LAYOUT_UI_CHROME_SELECTOR = '#paperPanelStack, #paperTabs, #reset2dBtn, #layerContextMenu';
/* Alt+drag duplicates instead of moving (Illustrator's gesture): the
   ORIGINALS stay exactly where they were and the copies become what's being
   dragged. Called from the move handler below, at most once per gesture.
   Two things make it correct wherever in the drag it fires:
     * the originals are put back at their start positions first — the move
       handler applies its delta on every frame, including the sub-threshold
       ones before this fires, so by now they've already drifted a few px;
     * the copies are cloned AFTER that restore, so they start at the
       sources' original positions, and the delta the handler applies right
       after (still measured from the gesture's own startWorld) carries them
       the full distance to the cursor in one frame.
   Press Alt before you start and the copies track the pointer from the very
   first pixel; press it halfway through and the originals snap back while
   the copies keep the drag — both correct, neither special-cased. */
function startAltDuplicate(interaction){
  interaction.altDone = true;
  for (const m of interaction.members){
    m.block.x = m.startX; m.block.y = m.startY;
    updateBlockTransform(m.block);
  }
  const copies = addBlocks(interaction.members.map(m => cloneBlock(m.block)), 'duplicated');
  interaction.members = copies.map(b => ({ block: b, startX: b.x, startY: b.y }));
  // startEnv still holds: the copies sit exactly where the sources did.
  // The group frame does NOT — addBlocks reselected around the copies, so
  // selectionFrame is a different object (and freshly axis-aligned), and
  // the drag's snapshot of it has to be retaken or the box would jump.
  interaction.startFrameCorners = (copies.length > 1 && selectionFrame)
    ? selectionFrame.corners.map(c => c.slice()) : null;
  $('paperPane').style.cursor = 'copy';
  lastCursor = 'copy';
}
function endInteraction(e){
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
  if (interaction.mode === 'marquee'){
    if (!interaction.moved){
      // A plain click with no drag — same "shift+click on empty space is a
      // no-op, otherwise clear" rule the old immediate-clear code used at
      // pointerdown, just resolved here now that the decision is deferred
      // until it's actually known whether a drag happened. Ctrl/Cmd counts
      // as the same "don't touch the selection" modifier as Shift, matching
      // the additive-marquee check above.
      if (!(e && (e.shiftKey || multiSelectKey(e)))) clearSelection();
    }
    updateSelectionOverlay();   // wipe the marquee rect itself — nothing else clears it once dragging stops
  }
  interaction = null;
  clearSnapGuides();
  clearAxisLockGuide();
  hideRotateLabel();
  hideDimensionLabels();
  if (hadInteraction) refreshStatusR();
}

const NUDGE_KEYS = { ArrowUp: [0,-1], ArrowDown: [0,1], ArrowLeft: [-1,0], ArrowRight: [1,0] };
/* The canvas listeners. app.js calls this after initLayoutList, so the
   list's own document handlers still register first, exactly as they did
   when the Layout tab had a single init. */
export function initLayoutInteraction(){
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
      // Marquee-select: deferred entirely to pointermove/pointerup below — a
      // plain click with no drag still needs to behave as "clear selection
      // unless shift", but that's only knowable once the gesture ends up
      // without ever crossing the move threshold (see endInteraction).
      e.preventDefault();
      $('paperPane').setPointerCapture(e.pointerId);
      interaction = { mode: 'marquee', startWorld: [wx, wy], curWorld: [wx, wy],
        preSelection: new Set(selectedBlocks), moved: false };
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    $('paperPane').setPointerCapture(e.pointerId);
    pendingCollapseTo = null;

    if (hit.type === 'move'){
      const block = hit.block;
      // Ctrl/Cmd toggles, same as in the list. Shift ALSO toggles here rather
      // than extending a range: the canvas has no linear order for a range to
      // run along (that's a list-only notion — see extendSelectionTo), and
      // Shift already carries several drag-time meanings on this canvas
      // (axis-lock while moving, 5-degree rotate steps, additive marquee), so
      // it keeps its existing click meaning here unchanged.
      if (e.shiftKey || multiSelectKey(e)){
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
      // Only the interactive members come along for the drag — a hidden or
      // locked block that's also selected in the list stays exactly where it
      // is, and doesn't contribute to the group's envelope or snapping.
      const active = interactiveSelection();
      if (active.length){
        const startEnv = selectionEnvelope();
        const members = active.map(b => ({ block: b, startX: b.x, startY: b.y }));
        interaction = { mode: 'move', members, startEnv, startWorld: [wx, wy], moved: false,
          // Alt held at pointerdown arms duplicate-instead-of-move; it can
          // also be pressed later, mid-drag (see startAltDuplicate).
          altDuplicate: e.altKey, altDone: false,
          startFrameCorners: active.length > 1 ? selectionFrame.corners.map(c => c.slice()) : null };
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
      // Scaled by the block's CURRENT scale here so V ends up in the same
      // world-space-offset units computeScaleSnap expects (worldCorner_i(k) =
      // anchorWorld + k*V_i) — matching how the scaleGroup path below builds
      // its corners from blockCorners(), which already bakes in each block's
      // own scale. Omitting this only breaks once block.scale != 1, i.e. from
      // a block's second scale drag onward, since the first drag starts at
      // scale 1 where the missing factor doesn't matter.
      const rad = hit.block.rotationDeg * Math.PI/180, cos = Math.cos(rad), sin = Math.sin(rad);
      const V = localCorners.map(([lx, ly]) => {
        const dx = (lx - anchorLocal[0]) * hit.block.scale, dy = (ly - anchorLocal[1]) * hit.block.scale;
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
      $('paperPane').style.cursor = 'grabbing';
      lastCursor = 'grabbing';
    } else if (hit.type === 'scaleGroup'){
      const envCorners = selectionFrame.corners;
      const anchorIdx = (hit.cornerIndex + 2) % 4;
      const anchorWorld = envCorners[anchorIdx];
      const draggedWorld = envCorners[hit.cornerIndex];
      const startDist = Math.max(1e-6, Math.hypot(draggedWorld[0]-anchorWorld[0], draggedWorld[1]-anchorWorld[1]));
      const active = interactiveSelection();
      const members = active.map(b => ({ block: b, startX: b.x, startY: b.y, startScale: b.scale }));
      // Every corner of every interactive member, as an offset from the SAME
      // shared group anchor — this is what makes computeScaleSnap solve for
      // one shared k that keeps the whole group rigid (see its own comment).
      const corners = [];
      for (const b of active) for (const c of blockCorners(b)) corners.push([c[0]-anchorWorld[0], c[1]-anchorWorld[1]]);
      const minStartScale = Math.min(...members.map(m => m.startScale));
      interaction = { mode: 'scaleGroup', anchorWorld, startDist, members,
        corners, minStartScale, excludeSet: new Set(active),
        startFrameCorners: envCorners.map(c => c.slice()) };
    } else if (hit.type === 'rotateGroup'){
      const c = selectionFrame.corners;
      const pivot = [(c[0][0]+c[2][0])/2, (c[0][1]+c[2][1])/2];   // diagonal midpoint — the frame's own center, rotated or not
      const startAngle = Math.atan2(wy - pivot[1], wx - pivot[0]) * 180/Math.PI;
      const members = interactiveSelection().map(b => ({ block: b, startX: b.x, startY: b.y, startRotationDeg: b.rotationDeg }));
      interaction = { mode: 'rotateGroup', pivot, startAngle, members,
        startFrameCorners: c.map(pt => pt.slice()) };
      $('paperPane').style.cursor = 'grabbing';
      lastCursor = 'grabbing';
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
      updateHoverCursor(wx, wy, e.altKey);
      return;
    }
    if (interaction.mode === 'move'){
      let dx = wx - interaction.startWorld[0], dy = wy - interaction.startWorld[1];
      if (Math.hypot(dx, dy) > 1e-6) interaction.moved = true;
      // Gated on a real screen-px drag, not on `moved` above (which trips on
      // any sub-pixel jitter) — an Alt+click that never actually drags must
      // leave no stray copy sitting on top of the original.
      if ((interaction.altDuplicate || e.altKey) && !interaction.altDone &&
          Math.hypot(dx, dy) / mmPerScreenPx() > DRAG_THRESHOLD_PX){
        startAltDuplicate(interaction);
      }
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
      if (e.shiftKey){
        const cx = (interaction.startEnv.x0 + interaction.startEnv.x1) / 2 + finalDx;
        const cy = (interaction.startEnv.y0 + interaction.startEnv.y1) / 2 + finalDy;
        // dy===0 means the drag is constrained to move along the X axis
        // (horizontal), so the indicator is a horizontal line through the
        // selection's center — and the mirror for dx===0/Y.
        drawAxisLockGuide(dy === 0 ? 'x' : 'y', cx, cy);
      } else {
        clearAxisLockGuide();
      }
    } else if (interaction.mode === 'rotate'){
      const b = interaction.block;
      const curAngle = Math.atan2(wy - b.y, wx - b.x) * 180/Math.PI;
      const raw = interaction.startRotation + (curAngle - interaction.startAngle);
      const rotateStep = e.shiftKey ? 5 : 1;
      const snapped = Math.round(raw / rotateStep) * rotateStep;
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
      const rotateStep = e.shiftKey ? 5 : 1;
      const snappedDelta = Math.round(rawDelta / rotateStep) * rotateStep;
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
    } else if (interaction.mode === 'marquee'){
      interaction.curWorld = [wx, wy];
      if (!interaction.moved){
        // Small screen-px move threshold (not a raw mm one, so it stays
        // consistent across zoom levels) — below it, this still reads as a
        // plain click rather than a drag, same idea as every other
        // interaction mode's own .moved flag.
        const dragPx = Math.hypot(wx - interaction.startWorld[0], wy - interaction.startWorld[1]) / mmPerScreenPx();
        if (dragPx > DRAG_THRESHOLD_PX) interaction.moved = true;
      }
      if (interaction.moved) updateMarqueeSelection(interaction, e.shiftKey || multiSelectKey(e));
    }
    updateSelectionOverlay();
    if (interaction.mode === 'marquee' && interaction.moved) drawMarqueeRect(interaction);
  });
  $('paperPane').addEventListener('pointerup', endInteraction);
  $('paperPane').addEventListener('pointercancel', endInteraction);
  /* Every shortcut below (and both clipboard handlers further down) keeps out
     of the way of whatever the focused element does with that same key — see
     isTextEntryTarget / isFormControlTarget in main.js for the two different
     questions that involves. */
  /* Restores the blur the browser would have done on its own. Clicking a
     slider or checkbox in a settings panel leaves it focused; this file's own
     pointerdown handlers then call preventDefault (to stop text selection and
     native drags), and preventDefault on pointerdown ALSO suppresses the
     focus change the browser would otherwise make. So the control stays
     focused indefinitely — through clicking the canvas, dragging a block,
     selecting rows — and every shortcut above keeps deferring to a control
     the user stopped touching several clicks ago: arrows adjust the slider
     instead of nudging blocks, Ctrl+A selects the whole page's text.
     Capture phase, so it runs before any of those preventDefaults. Nothing is
     focused in its place: activeElement falls back to <body>, exactly the
     state a plain click on non-focusable chrome would have produced anyway. */
  document.addEventListener('pointerdown', e => {
    if (!isFormControlTarget()) return;   // nothing focused that could swallow a shortcut
    // Clicking a control (or the still-open rename field) must let it keep or
    // take focus — this only fires for clicks on everything else.
    if (e.target.closest && e.target.closest('input, select, textarea, [contenteditable="true"]')) return;
    document.activeElement.blur();
  }, { capture: true });
  document.addEventListener('keydown', e => {
    if (NUDGE_KEYS[e.key] && activeTab === 'layout' && interactiveSelection().length){
      // The WIDE guard — an arrow key belongs to any focused form control,
      // a slider or <select> included, not just a text field.
      if (!isFormControlTarget()){
        e.preventDefault();
        const amount = e.shiftKey ? 5 : 0.5;
        const [dx, dy] = NUDGE_KEYS[e.key];
        // Interactive members only — a selected but hidden/locked block is
        // inert on the canvas, arrow keys included.
        for (const b of interactiveSelection()){
          b.x += dx * amount;
          b.y += dy * amount;
          updateBlockTransform(b);
        }
        // The group box is persistent state, NOT recomputed from the blocks on
        // every draw (see selectionFrame's own comment) — so it has to be
        // translated by the same delta here, exactly as a move drag, a group
        // rotate/scale and an orientation flip already do. Without this the
        // box and its handles sit still while the blocks walk out from under
        // them. A single selected block was never affected: its overlay is
        // drawn straight from its own live corners, with no frame involved.
        if (selectionFrame){
          selectionFrame.corners = selectionFrame.corners.map(([x, y]) => [x + dx * amount, y + dy * amount]);
        }
        updateSelectionOverlay();
      }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && activeTab === 'layout' && selectedBlocks.size){
      // Routes through the same deleteBlocks() a row's own X button uses —
      // see there for why there's no confirmation dialog.
      // Deletes only the INTERACTIVE members, unlike the list's own delete
      // buttons, which delete everything selected: a keystroke shouldn't be
      // able to destroy a layer that was deliberately locked (or hidden, and
      // so not even on screen to be missed) — protecting it from the canvas
      // is the entire point of locking it.
      if (!isTextEntryTarget()){
        e.preventDefault();
        deleteBlocks(interactiveSelection());
      }
    }
    // Ctrl/Cmd+A — select every block, hidden and locked included (the list
    // selection has no eligibility rule; only the canvas does). Leaves the
    // anchor alone: it's validated at use anyway, and whatever was last
    // clicked stays the natural origin for a following Shift+click.
    if (multiSelectKey(e) && (e.key === 'a' || e.key === 'A') && activeTab === 'layout' && blocks.length){
      if (!isTextEntryTarget()){
        e.preventDefault();
        setSelection(blocks.slice());
      }
    }
  });
}
