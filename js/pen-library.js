/* ================================================================
   pen-library.js — the Pen library tab
   The UI over PEN_LIBRARY (main.js): one row per pen (preview, name,
   color, width, delete) plus "+ Add pen", and everything that keeps
   the rest of the app in step with the library — refilling every pen
   dropdown after an add/rename/delete, reassigning references off a
   deleted pen, and matching pen data that arrives from outside
   (resolvePen/resolveOverridePen/setPenLibrary: .pen scene import in
   scene-io.js, clipboard paste in layout-canvas.js). Also the "Export one
   path per pen" checkbox's tie to "Split dashes" (the export itself is
   buildPenPathsExport in export.js).
   ================================================================ */
import { $, PEN_LIBRARY, defaultPens, penById } from './main.js';
import { layerById, layers } from './layers.js';
import { applyLayerStyle, fillPenSelect, fmtWidth, layerEls } from './layer-rows.js';
import { makeNameEditable } from './panel-controls.js';
import { blocks } from './layout-canvas.js';


// Next pen id — only ever climbs (see newPenId), replaced wholesale by a
// scene import (setPenLibrary), saved in the scene alongside the pens.
export let penIdCounter = PEN_LIBRARY.length;
// Same stroke treatment as a layer row's own swatch (see applyLayerStyle),
// minus the dash — a pen has none of its own.
function paintPenSwatch(sw, pen){
  sw.setAttribute('stroke', pen.color);
  sw.setAttribute('stroke-width', Math.max(0.6, pen.width));
}
const clampPenWidth = v => Math.min(6, Math.max(0.1, v || 0.1));
// A pen edit can affect any layer (and any Layout block override), so every
// layer is restyled — the same full sweep a dash-field edit already does.
function restyleAllLayers(){
  for (const L of layers) applyLayerStyle(L.id);
}
// Refills every pen dropdown after the library's list itself changed (add,
// rename, delete, import). References are always reassigned BEFORE this runs,
// so a select only falls back when its pen is truly gone.
export function refreshPenSelects(){
  for (const L of layers) fillPenSelect(layerEls[L.id].pen, L.pen);
  document.querySelectorAll('#layerContextMenuList select.penSelect').forEach(sel => fillPenSelect(sel));
}
export function syncPenLibraryUI(){
  renderPenLibrary();
  refreshPenSelects();
}

export function renderPenLibrary(){
  const list = $('penLibList');
  list.innerHTML = '';
  for (const pen of PEN_LIBRARY){
    const row = document.createElement('div');
    row.className = 'layer penLibRow';
    row.innerHTML =
      '<svg class="swatch" viewBox="0 0 50 14" aria-hidden="true"><path d="M3 7 L47 7" fill="none"/></svg>' +
      '<span class="nm" title="Double-click to rename"></span>' +
      '<input type="color">' +
      '<input type="number" min="0.1" max="6" step="0.05">' +
      '<button type="button" class="svBtn svDelete">&#10005;</button>';
    const [swSvg, nm, col, wid, del] = row.children;
    const sw = swSvg.firstChild;
    // User-typed name — textContent/setAttribute only, never innerHTML.
    nm.textContent = pen.name;
    col.value = pen.color;
    col.setAttribute('aria-label', pen.name + ' color');
    wid.value = fmtWidth(pen.width);
    wid.setAttribute('aria-label', pen.name + ' width');
    del.title = PEN_LIBRARY.length > 1 ? 'Delete pen' : 'The library needs at least one pen';
    del.setAttribute('aria-label', 'Delete ' + pen.name);
    del.disabled = PEN_LIBRARY.length <= 1;
    paintPenSwatch(sw, pen);
    makeNameEditable(nm, () => pen.name, newName => {
      pen.name = newName;
      syncPenLibraryUI();
    });
    // Updated in place rather than re-rendering the list — a rebuild would
    // tear the color picker / width field out from under the user mid-edit.
    col.addEventListener('input', () => {
      pen.color = col.value;
      paintPenSwatch(sw, pen);
      restyleAllLayers();
    });
    wid.addEventListener('input', () => {
      pen.width = clampPenWidth(+wid.value);
      paintPenSwatch(sw, pen);
      restyleAllLayers();
    });
    // 'change', not 'input' — same reasoning as every other width field:
    // reformatting mid-typing would fight the user for the field.
    wid.addEventListener('change', () => { wid.value = fmtWidth(pen.width); });
    del.addEventListener('click', () => deletePen(pen));
    list.appendChild(row);
  }
}

// Never collides with an existing id, even one an imported scene chose.
function newPenId(){
  let id;
  do id = 'p' + (++penIdCounter); while (PEN_LIBRARY.some(p => p.id === id));
  return id;
}
// A new pen starts as a copy of the last one's values, so "+ Add pen" then
// a tweak is the quickest way to a variant.
function addPen(){
  const last = PEN_LIBRARY[PEN_LIBRARY.length - 1];
  PEN_LIBRARY.push({ id: newPenId(), name: 'Pen ' + (PEN_LIBRARY.length + 1), color: last.color, width: last.width });
  syncPenLibraryUI();
}

// Deleting a pen that's in use — by a line layer, or by any Layout block's
// override entry (counted whether that block's Override is currently on or
// not, since the entry persists either way) — asks first, then moves every
// such reference to the first remaining pen. The last pen can't be deleted.
function deletePen(pen){
  const i = PEN_LIBRARY.indexOf(pen);
  if (i < 0 || PEN_LIBRARY.length <= 1) return;
  const fallback = PEN_LIBRARY.find(p => p !== pen);
  const usedLayers = layers.filter(L => L.pen === pen.id);
  const usedOverrides = [];
  for (const b of blocks){
    for (const key in b.overrideStyle){
      const ov = b.overrideStyle[key];
      if (ov && ov.pen === pen.id) usedOverrides.push(ov);
    }
  }
  if (usedLayers.length || usedOverrides.length){
    const parts = [];
    if (usedLayers.length) parts.push(usedLayers.length + ' line layer(s)');
    if (usedOverrides.length) parts.push(usedOverrides.length + ' Layout override(s)');
    if (!confirm('"' + pen.name + '" is used by ' + parts.join(' and ') +
      '. Delete it and switch them to "' + fallback.name + '"?')) return;
  }
  PEN_LIBRARY.splice(i, 1);
  for (const L of usedLayers) L.pen = fallback.id;
  for (const ov of usedOverrides) ov.pen = fallback.id;
  syncPenLibraryUI();
  restyleAllLayers();
}

/* ================= pen data from outside the library =================
   Old scenes (saved before pens existed) carry a colour + width per layer
   and per Layout override; clipboard pastes carry the definitions of the
   pens their overrides used in the SOURCE document, whose library may
   differ. Both are matched into this library rather than blindly added. */
function normPenColor(c){
  return (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) ? c.toLowerCase() : null;
}
function normPenWidth(w){
  return (typeof w === 'number' && Number.isFinite(w) && w > 0) ? w : null;
}
// Returns the id of the pen matching `src` ({id?, name?, color, width}),
// appending a new pen when nothing matches. Match order: same id AND same
// values (the very pen it was copied from, unchanged), then the first pen
// with the same values. Widths compare exactly, not rounded, so a migrated
// layer renders with precisely the width it was saved with. A missing or
// invalid color/width takes fallbackPen's.
export function resolvePen(src, fallbackPen){
  const color = normPenColor(src.color) || fallbackPen.color;
  const width = normPenWidth(src.width) ?? fallbackPen.width;
  const same = p => p.color === color && p.width === width;
  const hit = PEN_LIBRARY.find(p => p.id === src.id && same(p)) || PEN_LIBRARY.find(same);
  if (hit) return hit.id;
  const name = (typeof src.name === 'string' && src.name.trim()) ? src.name.trim() : color + ' ' + fmtWidth(width);
  const pen = { id: newPenId(), name, color, width };
  PEN_LIBRARY.push(pen);
  return pen.id;
}
// Pen id for one incoming Layout override entry. srcPens is the pen list
// that travelled with it (clipboard), or null for a scene import — by then
// the library has already been replaced by the scene's own, so a plain id
// is authoritative. An entry from before pens existed has color/width
// instead of a pen. Anything unresolvable follows the layer's current pen.
export function resolveOverridePen(ov, layerKey, srcPens){
  const layerPen = penById(layerById(layerKey).pen);
  if (typeof ov.pen === 'string'){
    const src = Array.isArray(srcPens) ? srcPens.find(p => p && p.id === ov.pen) : null;
    if (src) return resolvePen(src, layerPen);
    return PEN_LIBRARY.some(p => p.id === ov.pen) ? ov.pen : layerPen.id;
  }
  return resolvePen({ color: ov.color, width: ov.width }, layerPen);
}
// Scene import: replaces the whole library. Malformed entries are dropped; a
// scene with no usable pens (every scene saved before pens existed) restarts
// from the built-in set, which its per-layer colours then match into.
// Does not touch the UI — the caller syncs once everything is resolved.
export function setPenLibrary(srcPens, srcCounter){
  const pens = [];
  if (Array.isArray(srcPens)){
    for (const p of srcPens){
      if (!p || typeof p.id !== 'string' || !p.id || pens.some(q => q.id === p.id)) continue;
      const color = normPenColor(p.color), width = normPenWidth(p.width);
      if (!color || width === null) continue;
      pens.push({ id: p.id, name: (typeof p.name === 'string' && p.name.trim()) ? p.name : p.id, color, width });
    }
  }
  PEN_LIBRARY.splice(0, PEN_LIBRARY.length, ...(pens.length ? pens : defaultPens()));
  const idNums = PEN_LIBRARY.map(p => { const m = /^p(\d+)$/.exec(p.id); return m ? +m[1] : 0; });
  penIdCounter = Math.max(Number.isFinite(srcCounter) ? srcCounter : 0, ...idNums);
}

export let splitDashChoice;
// Scene import sets the checkbox by assignment (no change event), so it
// re-syncs the remembered choice explicitly.
export function syncSplitDashChoiceFromDom(){ splitDashChoice = $('splitDashBtn').checked; }
export function syncPenPathsExportUI(){
  const on = $('penPathsExport').checked;
  const split = $('splitDashBtn');
  split.checked = on ? true : splitDashChoice;
  split.disabled = on;
  split.closest('.chk').classList.toggle('ctlDisabled', on);
}

/* ================= init =================
   Everything above only declares. This wires the DOM and starts the
   module's live behaviour — called once by app.js, in script order. */
export function initPenLibrary(){
  $('addPenBtn').addEventListener('click', addPen);
  /* ================= "Export one path per pen" =================
     While on, Export SVG builds one path per pen (buildPenPathsExport in
     export.js), which always splits dashes — so "Split dashes" is shown
     ticked and locked. The user's own choice is remembered separately in
     splitDashChoice and put back when this is switched off; that remembered
     value, not the forced tick, is also what a scene saves (scene-io.js). */
  splitDashChoice = $('splitDashBtn').checked;
  $('splitDashBtn').addEventListener('change', () => { splitDashChoice = $('splitDashBtn').checked; });
  $('penPathsExport').addEventListener('change', syncPenPathsExportUI);
  syncPenPathsExportUI();
  renderPenLibrary();
}
