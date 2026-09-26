/* ================================================================
   layout-clipboard.js — copy / paste of Layout blocks
   Ctrl/Cmd+C copies the interactive part of the selection to the SYSTEM
   clipboard as JSON; Ctrl/Cmd+V rebuilds those blocks from it. The
   payload is self-contained — it carries the frozen path data itself,
   so a paste into another window (or another scene) reproduces the
   layers without needing the source document.
   ================================================================ */
import { $, DASH_KEYS, DASH_RATIOS, MAX_DASH_SLOTS, PEN_LIBRARY, isTextEntryTarget } from '../main.js';
import { layerById, layers } from '../layers.js';
import { addDashSlot } from '../layer-rows.js';
import { activeTab } from '../panel-controls.js';
import { resolveOverridePen, syncPenLibraryUI } from '../pen-library.js';
import { MIN_BLOCK_SCALE, addBlocks, blockCountLabel, blocks, nextBlockId } from './layout-model.js';
import { interaction, interactiveSelection } from './layout-interaction.js';
import { commitLayoutChange } from './layout-history.js';
/* ================= clipboard (copy / paste layers) =================
   Ctrl/Cmd+C copies the interactive part of the selection to the SYSTEM
   clipboard as JSON; Ctrl/Cmd+V rebuilds those layers from it. The payload
   is self-contained (it carries the frozen path data itself, not a
   reference), so a paste restores exactly what was copied even if the
   source layer has since been moved, restyled or deleted — and a layer can
   be carried between two PENumbra tabs, or into a different scene. That
   includes how it looked: the pens and dash patterns it drew with travel
   along, are matched into the target's pen library and dash slots, and are
   imported wherever the target has nothing identical (see pastedSourceStyle
   and clipboardRecordToBlock).

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
const isObj = v => !!v && typeof v === 'object';
// A clipboard record is the block minus its live `dom` reference — exactly
// the shape a .pen scene already stores per block (see the blocksOut map in
// scene-io.js's export path), so there's no second serialization format to
// keep in step with the first. `id` rides along and is ignored on the way
// back in, same as .pen import already does.
// A block draws with its own override style while Override is on, and with
// the live layer's pen and dash otherwise (or for a layer its Override never
// filled in — see blockLayerPenId in layout-model.js). So besides the blocks,
// the payload records `layerStyles`: the pen and dash every layer the blocks
// have was drawn with HERE. `pens` and `dashes` then carry the definition of
// every pen and dash slot any of that points at, since the paste target may
// be another document whose pen library and dash slots differ — where those
// ids and keys mean something else, or nothing. An inactive override's pen
// isn't carried: the paste drops inactive overrides (see pastedSourceStyle).
function blocksToClipboardText(list){
  const penIds = new Set(), dashKeys = new Set(), layerStyles = {};
  const note = st => { penIds.add(st.pen); dashKeys.add(st.dash); };
  for (const b of list){
    for (const key in b.layerPaths){
      const L = layerById(key);   // a block can outlive a fill layer it was frozen with
      if (!L || layerStyles[key]) continue;
      layerStyles[key] = { pen: L.pen, dash: L.dash };
      note(layerStyles[key]);
    }
    if (b.override) for (const key in b.overrideStyle) note(b.overrideStyle[key]);
  }
  const dashes = {};
  for (const key of dashKeys) if (DASH_RATIOS[key]) dashes[key] = DASH_RATIOS[key];   // 'solid' has no pattern
  return JSON.stringify({
    penumbraClipboard: CLIPBOARD_FORMAT,
    blocks: list.map(({ dom, ...rest }) => rest),
    pens: PEN_LIBRARY.filter(p => penIds.has(p.id)),
    layerStyles, dashes,
  });
}
// The dash slot HERE that draws what the source's `key` drew (its pattern is
// in the payload's `dashes`): that same key if the pattern matches, else the
// first slot with that pattern, else a new slot holding it — or, with every
// slot already taken, the first slot, noted for the status line. A payload
// from before dashes were carried keeps the key if it exists here and falls
// back to solid otherwise: scaledDash would read an unknown key as solid
// anyway, but the Override menu's <select> can't sit on a value it has no
// option for.
function resolveDash(key, ctx){
  if (typeof key !== 'string' || key === 'solid') return 'solid';
  const src = ctx.dashes[key];
  if (!Array.isArray(src) || src.length !== 6 || !src.every(isFiniteNum)) return DASH_KEYS.includes(key) ? key : 'solid';
  const ratios = src.map(v => Math.max(0, v));
  const same = k => DASH_RATIOS[k].every((v, i) => v === ratios[i]);
  if (DASH_KEYS.includes(key) && same(key)) return key;
  const hit = DASH_KEYS.find(same) || addDashSlot(ratios);
  if (hit) return hit;
  ctx.dashSlotsFull = true;
  return DASH_KEYS[0];
}
// The style one layer of a pasted block drew with in the source document:
// its override entry while Override was on, the source layer's own
// otherwise — and for a layer an active Override never filled in. null when
// the payload doesn't say (one from before layerStyles, for a block without
// Override). An inactive override entry is never read: its pen wasn't
// carried, and switching Override on later snapshots fresh entries anyway.
function pastedSourceStyle(rec, key, ctx){
  if (rec.override && isObj(rec.overrideStyle) && isObj(rec.overrideStyle[key])) return rec.overrideStyle[key];
  return isObj(ctx.layerStyles[key]) ? ctx.layerStyles[key] : null;
}
// Rebuilds one block from a clipboard record, or returns null if the record
// can't produce a usable one. Structure is VALIDATED (anything that would
// leave an undrawable or unclickable block on the page is rejected outright)
// while the rest is merely coerced — the realistic case to defend against is
// "the clipboard holds unrelated text", not a hand-crafted payload, and .pen
// import trusts its own input entirely. ctx is the payload's pens,
// layerStyles and dashes, plus what the paste had to do (see
// blocksFromClipboardText).
function clipboardRecordToBlock(rec, ctx){
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
  let overrideStyle = {};
  for (const key in layerPaths){
    const st = pastedSourceStyle(rec, key, ctx);
    if (!st) continue;
    overrideStyle[key] = {
      // Matched into THIS library (may append a pen) — also reads a
      // pre-pen-library payload's own color/width.
      pen: resolveOverridePen(st, key, ctx.pens),
      dash: resolveDash(st.dash, ctx),   // may add a dash slot
    };
  }
  // A block without Override follows this document's own layers, which is
  // only right if they draw exactly what the source's did. Any difference
  // turns Override on instead, so the paste keeps the look it was copied
  // with — the status line says so, and switching Override off hands the
  // block back to the live layers. Nothing matched here was imported (a new
  // pen or dash slot can't be what a layer already uses), so a block that
  // stays live leaves nothing unused behind.
  let override = !!rec.override;
  if (!override){
    const differs = Object.keys(overrideStyle).some(key => {
      const L = layerById(key);
      return overrideStyle[key].pen !== L.pen || overrideStyle[key].dash !== L.dash;
    });
    if (differs){ override = true; ctx.overridden++; }
    else overrideStyle = {};
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
    override, overrideStyle,
    bboxLocal: { x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1 },
    dom: null,
  };
}
// No blocks = "this isn't ours", for every reason: not text, not JSON, not
// our format, or nothing in it survived validation. Callers treat all of
// those identically — do nothing at all, and leave the event alone so a
// perfectly ordinary text paste still behaves like one. `notes` are what
// the paste had to do on the way in, for the status line.
function blocksFromClipboardText(text){
  const none = { blocks: [], notes: [] };
  if (typeof text !== 'string' || !text) return none;
  let data;
  try { data = JSON.parse(text); } catch (err) { return none; }
  if (!data || data.penumbraClipboard !== CLIPBOARD_FORMAT || !Array.isArray(data.blocks)) return none;
  const ctx = {
    pens: data.pens,
    layerStyles: isObj(data.layerStyles) ? data.layerStyles : {},
    dashes: isObj(data.dashes) ? data.dashes : {},
    overridden: 0,          // blocks whose Override the paste turned on
    dashSlotsFull: false,   // a dash couldn't be imported — see resolveDash
  };
  const out = [];
  for (const rec of data.blocks){
    const b = clipboardRecordToBlock(rec, ctx);
    if (b) out.push(b);
  }
  const notes = [];
  if (ctx.overridden) notes.push('Override turned on for ' + (ctx.overridden === 1 ? '1 block' : ctx.overridden + ' blocks') + ' to keep the source pens and dashes');
  if (ctx.dashSlotsFull) notes.push('all ' + MAX_DASH_SLOTS + ' dash slots are taken, so ' + DASH_KEYS[0] + ' was used instead');
  return { blocks: out, notes };
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
    const { blocks: pasted, notes } = blocksFromClipboardText(e.clipboardData.getData('text/plain'));
    if (!pasted.length) return;
    e.preventDefault();
    syncPenLibraryUI();   // matching the pasted pens may have appended some (new dash slots add their own options)
    // Placed verbatim — same position, rotation, scale and overrides as when
    // copied, with no offset nudge. Pasting into the source document lands the
    // copy exactly on top of the original; addBlocks selects it, which is what
    // makes it immediately draggable (or nudgeable) off.
    addBlocks(pasted, 'pasted');
    if (notes.length) $('statusL').textContent += ' — ' + notes.join('; ');
    commitLayoutChange('Paste ' + blockCountLabel(pasted));
  });
}
