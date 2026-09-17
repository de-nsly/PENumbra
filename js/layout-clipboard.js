/* ================================================================
   layout-clipboard.js — copy / paste of Layout blocks
   Ctrl/Cmd+C copies the interactive part of the selection to the SYSTEM
   clipboard as JSON; Ctrl/Cmd+V rebuilds those blocks from it. The
   payload is self-contained — it carries the frozen path data itself,
   so a paste into another window (or another scene) reproduces the
   layers without needing the source document.
   ================================================================ */
import { $, DASH_KEYS, PEN_LIBRARY, isTextEntryTarget } from './main.js';
import { layers } from './layers.js';
import { activeTab } from './panel-controls.js';
import { resolveOverridePen, syncPenLibraryUI } from './pen-library.js';
import { MIN_BLOCK_SCALE, addBlocks, blockCountLabel, blocks, interaction, interactiveSelection, nextBlockId } from './layout-canvas.js';
/* ================= clipboard (copy / paste layers) =================
   Ctrl/Cmd+C copies the interactive part of the selection to the SYSTEM
   clipboard as JSON; Ctrl/Cmd+V rebuilds those layers from it. The payload
   is self-contained (it carries the frozen path data itself, not a
   reference), so a paste restores exactly what was copied even if the
   source layer has since been moved, restyled or deleted — and a layer can
   be carried between two PENumbra tabs, or into a different scene.

   WHY THE `copy`/`paste` EVENTS AND NOT navigator.clipboard: the async
   Clipboard API's readText() doesn't exist for web content in Firefox at
   all and prompts for a permission in Chrome. The paste event hands over
   the same text with no permission, no secure-context requirement (so this
   still works when the page is served from a LAN IP rather than localhost),
   and no async. Using the copy event for the write side keeps both
   directions on one mechanism.

   Locked and hidden layers are never copied — this is a canvas feature, and
   those are exactly the layers the canvas doesn't touch (see
   interactiveSelection). Nothing here is persisted: the clipboard is the
   system's, and the .pen scene format is untouched. */
const CLIPBOARD_FORMAT = 1;   // bumped only if the record shape below stops being readable as-is
const isFiniteNum = v => typeof v === 'number' && Number.isFinite(v);
// A clipboard record is the block minus its live `dom` reference — exactly
// the shape a .pen scene already stores per block (see the blocksOut map in
// scene-io.js's export path), so there's no second serialization format to
// keep in step with the first. `id` rides along and is ignored on the way
// back in, same as .pen import already does.
// `pens` carries the definition of every pen the copied blocks' overrides
// point at: the paste target may be another document with a different pen
// library, where those ids mean something else or nothing — see
// resolveOverridePen (pen-library.js) for how they're matched back in.
function blocksToClipboardText(list){
  const penIds = new Set();
  for (const b of list){
    for (const key in b.overrideStyle){
      if (b.overrideStyle[key]) penIds.add(b.overrideStyle[key].pen);
    }
  }
  return JSON.stringify({
    penumbraClipboard: CLIPBOARD_FORMAT,
    blocks: list.map(({ dom, ...rest }) => rest),
    pens: PEN_LIBRARY.filter(p => penIds.has(p.id)),
  });
}
// Rebuilds one block from a clipboard record, or returns null if the record
// can't produce a usable one. Structure is VALIDATED (anything that would
// leave an undrawable or unclickable block on the page is rejected outright)
// while the rest is merely coerced — the realistic case to defend against is
// "the clipboard holds unrelated text", not a hand-crafted payload, and .pen
// import trusts its own input entirely. srcPens is the payload's own `pens`.
function clipboardRecordToBlock(rec, srcPens){
  if (!rec || typeof rec !== 'object') return null;
  // Geometry: at least one real path, under a layer key THIS build knows.
  const src = rec.layerPaths;
  if (!src || typeof src !== 'object') return null;
  const layerPaths = {};
  for (const L of layers){
    const d = src[L.id];
    if (typeof d === 'string' && d.trim()) layerPaths[L.id] = d;
  }
  if (!Object.keys(layerPaths).length) return null;
  // Placement — every number the transform math divides or rotates by.
  const bb = rec.bboxLocal;
  if (!bb || typeof bb !== 'object') return null;
  if (![bb.x0, bb.y0, bb.x1, bb.y1].every(isFiniteNum)) return null;
  if (![rec.x, rec.y, rec.rotationDeg, rec.scale, rec.freezeOffX, rec.freezeOffY, rec.freezeScale].every(isFiniteNum)) return null;
  if (rec.freezeScale <= 0) return null;   // a divisor in every stroke-width/dash computation (see updateBlockStyle)
  const layerVisible = {};
  for (const key in layerPaths) layerVisible[key] = !(rec.layerVisible && rec.layerVisible[key] === false);
  const srcOv = (rec.overrideStyle && typeof rec.overrideStyle === 'object') ? rec.overrideStyle : {};
  const overrideStyle = {};
  for (const key in layerPaths){
    const ov = srcOv[key];
    if (!ov || typeof ov !== 'object') continue;
    overrideStyle[key] = {
      // Matched into THIS library (may append a pen) — also reads a
      // pre-pen-library payload's own color/width.
      pen: resolveOverridePen(ov, key, srcPens),
      // A dash slot from a session that had added more of them (DASH_KEYS is
      // growable — see main.js) may not exist here. scaledDash already reads
      // an unknown key as solid, but the Override menu's <select> would sit
      // on a value with no matching option, so normalize it up front.
      dash: (ov.dash === 'solid' || DASH_KEYS.includes(ov.dash)) ? ov.dash : 'solid',
    };
  }
  return {
    id: nextBlockId(),
    // Kept verbatim, NOT suffixed the way duplicateBlocks does: a paste is a
    // restore, and duplicate already covers "make me another one". Pasting
    // into the document it was copied from therefore gives two rows with the
    // same name — names aren't a uniqueness key here (see blockIdCounter),
    // and double-click-to-rename covers it.
    name: (typeof rec.name === 'string' && rec.name.trim()) ? rec.name : 'Layer',
    visible: rec.visible !== false,
    locked: !!rec.locked,
    x: rec.x, y: rec.y,
    rotationDeg: rec.rotationDeg,
    scale: Math.max(MIN_BLOCK_SCALE, rec.scale),
    freezeOffX: rec.freezeOffX, freezeOffY: rec.freezeOffY, freezeScale: rec.freezeScale,
    layerPaths, layerVisible,
    override: !!rec.override, overrideStyle,
    bboxLocal: { x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1 },
    dom: null,
  };
}
// Empty array = "this isn't ours", for every reason: not text, not JSON, not
// our format, or nothing in it survived validation. Callers treat all of
// those identically — do nothing at all, and leave the event alone so a
// perfectly ordinary text paste still behaves like one.
function blocksFromClipboardText(text){
  if (typeof text !== 'string' || !text) return [];
  let data;
  try { data = JSON.parse(text); } catch (err) { return []; }
  if (!data || data.penumbraClipboard !== CLIPBOARD_FORMAT || !Array.isArray(data.blocks)) return [];
  const out = [];
  for (const rec of data.blocks){
    const b = clipboardRecordToBlock(rec, data.pens);
    if (b) out.push(b);
  }
  return out;
}
// Shared by both directions: Layout tab only, never while typing (native
// copy/paste has to keep working in the name field and the Override menu's
// number boxes — but a focused slider or checkbox holds no text, so it does
// NOT block these), and never mid-drag.
function clipboardShortcutsActive(){
  return activeTab === 'layout' && !isTextEntryTarget() && !interaction;
}

/* The two document-level shortcuts. Registered after the list's own
   document handlers and before nothing else that reads the same events —
   app.js calls this init last of the four, as these were the last of the
   clipboard-related listeners the single Layout init registered. */
export function initLayoutClipboard(){
  document.addEventListener('copy', e => {
    if (!clipboardShortcutsActive() || !e.clipboardData) return;
    // A real text selection wins — selecting a label and hitting Ctrl+C should
    // still copy that text rather than silently copying layers instead.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const active = interactiveSelection();
    if (!active.length) return;   // nothing copyable — let the browser's own copy proceed untouched
    e.clipboardData.setData('text/plain', blocksToClipboardText(active));
    e.preventDefault();   // without this the browser's own (empty) copy overwrites what was just set
    $('statusL').textContent = 'copied ' + blockCountLabel(active);
  });
  document.addEventListener('paste', e => {
    if (!clipboardShortcutsActive() || !e.clipboardData) return;
    const pasted = blocksFromClipboardText(e.clipboardData.getData('text/plain'));
    if (!pasted.length) return;
    e.preventDefault();
    syncPenLibraryUI();   // matching the pasted overrides' pens may have appended some
    // Placed verbatim — same position, rotation, scale and overrides as when
    // copied, with no offset nudge. Pasting into the source document lands the
    // copy exactly on top of the original; addBlocks selects it, which is what
    // makes it immediately draggable (or nudgeable) off.
    addBlocks(pasted, 'pasted');
  });
}
