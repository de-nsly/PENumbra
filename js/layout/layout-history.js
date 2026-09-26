/* ================================================================
   layout-history.js — undo / redo for the Layout tab
   Ctrl/Cmd+Z undoes, Ctrl/Cmd+Y (or Ctrl/Cmd+Shift+Z) redoes, Layout tab
   only. Session-only: nothing here is written into a .pen file or the
   clipboard, and a scene import starts the history over.

   SNAPSHOTS, NOT COMMANDS. Every step is a snapshot of the whole block list
   plus the selection, taken AFTER an action by commitLayoutChange() — the
   one call every mutating call site ends with. No per-action inverse to
   write or keep in step with its action: a call site that forgot its
   commit only folds its change into the next step instead of losing it.
   Snapshots are cheap because a block's geometry (layerPaths, bboxLocal,
   freezeOffX/Y, freezeScale) never changes after it's built — see
   blockStatsCache in layout-model.js — so a record keeps a reference to
   its block object for those, and copies only the few fields an action can
   actually change (BLOCK_FIELDS, layerVisible, overrideStyle). A hundred
   steps of a large layout copy no path data at all.

   `baseline` is the snapshot of the state as it stands right now. A commit
   compares the live blocks against it: equal (a click that never dragged,
   a rename to the same name, a reorder dropped in place) is a no-op;
   different pushes the baseline onto the undo stack as the step's "before"
   and takes a fresh baseline as its "after".

   The selection travels with each snapshot, and restoring a snapshot
   restores it: undo reselects what was selected when the undone action
   began, rigidly rotated group box included (see selectionFrame in
   layout-interaction.js). Changing the selection is not itself a step —
   setSelection calls noteSelectionChanged() below, which re-records the
   baseline's selection as long as the blocks still match it, so the
   "before" of the next action always carries the selection it started from.

   Restoring reconciles by object, never rebuilds: a block still alive gets
   its fields reassigned and its transform/style refreshed in place, a block
   brought back from a delete is the SAME object, rebuilt only in DOM, and a
   block absent from the snapshot has its DOM removed — the persistent-DOM
   rule layout-model.js is built around.
   ================================================================ */
import { $, isTextEntryTarget, penById } from '../main.js';
import { refreshStatusR } from '../render-result.js';
import { activeTab } from '../panel-controls.js';
import { blocks, createBlockDom, removeBlockDom, setBlocks, updateBlockStyle, updateBlockTransform } from './layout-model.js';
import { blockDragState, closeBlockContextMenu, renderBlocksList } from './layout-list.js';
import { interaction, multiSelectKey, selectedBlocks, selectionFrame, setSelection, setSelectionFrameCorners } from './layout-interaction.js';

const HISTORY_LIMIT = 100;       // steps kept; the oldest is dropped first
const NUDGE_MERGE_MS = 1000;     // arrow presses closer together than this merge into one step
// The plain-value fields an action can change. Everything else on a block
// is either frozen at creation (see the header) or the live `dom`.
const BLOCK_FIELDS = ['name', 'visible', 'locked', 'x', 'y', 'rotationDeg', 'scale', 'override'];

// A snapshot: { recs: [{ block, ...BLOCK_FIELDS, layerVisible, overrideStyle }]
// in blocks[] order, sel: [block, ...], frame: corners or null }.
let baseline = { recs: [], sel: [], frame: null };
let undoStack = [];              // [{ snap, label }] — snap is the state BEFORE the step
let redoStack = [];              // [{ snap, label }] — snap is the state AFTER the step
let lastMerge = null;            // { key, time, selKey } of the last mergeable commit, see commitLayoutChange

function copyOverrideStyle(ov){
  const out = {};
  for (const key in ov) out[key] = { pen: ov[key].pen, dash: ov[key].dash };
  return out;
}
function captureSelection(){
  return {
    sel: [...selectedBlocks],
    frame: selectionFrame ? selectionFrame.corners.map(c => c.slice()) : null,
  };
}
function capture(){
  const recs = blocks.map(b => {
    const rec = { block: b, layerVisible: { ...b.layerVisible }, overrideStyle: copyOverrideStyle(b.overrideStyle) };
    for (const f of BLOCK_FIELDS) rec[f] = b[f];
    return rec;
  });
  return { recs, ...captureSelection() };
}
// Same keys, and `same` holds for each key's pair of values.
function sameEntries(a, b, same){
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => k in b && same(a[k], b[k]));
}
const sameValue = (x, y) => x === y;
const samePenDash = (x, y) => x.pen === y.pen && x.dash === y.dash;
// Whether the live blocks are exactly what `snap` recorded — same blocks,
// same order, same values. The selection isn't compared: it's not a step.
function liveMatches(snap){
  if (snap.recs.length !== blocks.length) return false;
  return snap.recs.every((rec, i) => {
    const b = blocks[i];
    return rec.block === b &&
      BLOCK_FIELDS.every(f => rec[f] === b[f]) &&
      sameEntries(rec.layerVisible, b.layerVisible, sameValue) &&
      sameEntries(rec.overrideStyle, b.overrideStyle, samePenDash);
  });
}
const selectionKey = () => [...selectedBlocks].map(b => b.id).sort((a, b) => a - b).join(',');

/* Called at the end of every action that changes blocks, with the label the
   status line shows for it ("undo: Move 3 blocks"). `mergeKey` makes
   back-to-back commits of the same kind collapse into one step — used by
   the arrow-key nudge, so holding an arrow down undoes in one go. A merge
   needs the same key, the same selection, and the previous commit less
   than NUDGE_MERGE_MS ago; any other commit in between ends the run. */
export function commitLayoutChange(label, mergeKey){
  if (liveMatches(baseline)) return;
  const now = performance.now();
  const selKey = selectionKey();
  const merging = !!mergeKey && !!lastMerge && lastMerge.key === mergeKey &&
    lastMerge.selKey === selKey && now - lastMerge.time < NUDGE_MERGE_MS;
  if (!merging){
    undoStack.push({ snap: baseline, label });
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  }
  redoStack = [];
  baseline = capture();
  lastMerge = mergeKey ? { key: mergeKey, time: now, selKey } : null;
}
// setSelection's hook — see the header. While the blocks still match the
// baseline, a selection change just re-records the baseline's selection;
// once an action has started changing blocks (addBlocks and deleteBlocks
// both select mid-action), the baseline keeps the selection it began with.
// (A restore's own setSelection lands here too, and is skipped the same way:
// the blocks it just put back never match the baseline being left behind.)
export function noteSelectionChanged(){
  if (!liveMatches(baseline)) return;
  Object.assign(baseline, captureSelection());
}
// Scene import (the blocks are all new objects with new ids) and an
// orientation flip that carried the blocks along with the page (undoing
// past it would put them back at pre-flip coordinates on a page of the
// other shape): the history starts over from the current state.
export function resetLayoutHistory(){
  undoStack = [];
  redoStack = [];
  lastMerge = null;
  baseline = capture();
}
// A change made to blocks from outside the Layout tab's own actions that
// shouldn't become a step of its own — deleting a pen moves every override
// using it onto another pen. Older snapshots still hold the deleted id;
// restore() remaps it.
export function rebaseLayoutHistory(){
  lastMerge = null;
  baseline = capture();
}

function restore(snap){
  closeBlockContextMenu();
  const keep = new Set(snap.recs.map(r => r.block));
  for (const b of blocks) if (!keep.has(b)) removeBlockDom(b);
  const next = snap.recs.map(rec => {
    const b = rec.block;
    for (const f of BLOCK_FIELDS) b[f] = rec[f];
    // Copied again on the way out, so later in-place edits (the right-click
    // menu writes straight into these objects) can't reach back into the
    // record and change what a redo would restore.
    b.layerVisible = { ...rec.layerVisible };
    b.overrideStyle = copyOverrideStyle(rec.overrideStyle);
    // A pen deleted since this snapshot was taken resolves to the first pen
    // (penById's fallback) — the same one deletePen (pen-library.js) moved
    // the live overrides to.
    for (const key in b.overrideStyle) b.overrideStyle[key].pen = penById(b.overrideStyle[key].pen).id;
    return b;
  });
  setBlocks(next);
  // Paint order follows the array — re-appending an existing child moves it
  // to the end, same as the list's drag-reorder drop.
  const layer = $('layoutBlocksLayer');
  for (const b of blocks){
    if (!b.dom) createBlockDom(b);
    else { updateBlockTransform(b); updateBlockStyle(b); }
    layer.appendChild(b.dom.outer);
  }
  setSelection(snap.sel.filter(b => keep.has(b)));
  if (snap.frame) setSelectionFrameCorners(snap.frame);
  renderBlocksList();
  refreshStatusR();
}
// Undo and redo are the same move in opposite directions: take a step off
// one stack, leave the current state on the other in its place, restore.
function travel(from, to, verb){
  const step = from.pop();
  if (!step){ $('statusL').textContent = 'nothing to ' + verb; return; }
  to.push({ snap: capture(), label: step.label });
  restore(step.snap);
  baseline = step.snap;   // only now — see noteSelectionChanged
  lastMerge = null;
  $('statusL').textContent = verb + ': ' + step.label;
}

/* The shortcuts. Same guards as the clipboard's: Layout tab only, never
   while typing (the rename field keeps the browser's own undo — a focused
   slider holds no text, so it doesn't block these), and never mid-gesture,
   canvas or list drag alike. */
export function initLayoutHistory(){
  document.addEventListener('keydown', e => {
    if (activeTab !== 'layout' || !multiSelectKey(e) || e.altKey) return;
    const key = e.key.toLowerCase();
    const undo = key === 'z' && !e.shiftKey;
    const redo = (key === 'y' && !e.shiftKey) || (key === 'z' && e.shiftKey);
    if (!undo && !redo) return;
    if (isTextEntryTarget()) return;
    e.preventDefault();
    if (interaction || blockDragState) return;
    if (undo) travel(undoStack, redoStack, 'undo');
    else travel(redoStack, undoStack, 'redo');
  });
}
