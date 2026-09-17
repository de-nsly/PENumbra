/* ================================================================
   svg-export.js — turning solved geometry into SVG
   Layer pen/dash styling (colour + width come from the layer's pen,
   see PEN_LIBRARY in main.js), paper layout math shared by the
   preview and the real export, and renderPaper() (re-lays out the
   on-screen SVG render-result.js builds).
   The trim outside the margins is genuine geometry only in the exported
   file (path-model.js, called from export.js); on screen it is merely
   SIMULATED by a page-coloured mask over the band outside the margins
   (buildTrimMaskGroup/syncPreviewTrimMask here, with syncLayoutTrimMask
   in layout-canvas.js as its Layout-tab twin).
   ================================================================ */
import { $, DASH_KEYS, DASH_RATIOS, MAX_DASH_SLOTS, PEN_LIBRARY, dashPattern, penById, scaledDash } from './main.js';
import { FILL_TYPES, LAYER_TYPES, copyLayer, layerById, layerName, layerType, layers, newFillLayer, nextFillId, replaceLayers } from './layers.js';
import { computePaperLayout, pxPerMm } from './paper-layout.js';
import { refreshStatusR } from './render-result.js';
import { formatValue } from './settings.js';
import { activeTab, makeSliderValueEditable, markStale, syncLineLayerUI } from './panel-controls.js';
import { renderTextureStack } from './texture-stack.js';
import { layoutOverlayOn, refreshAllBlockStyles, renderPreviewLayoutOverlay } from './layout-canvas.js';
import { updateTextureGizmo } from './paper-preview.js';

// Pen widths are mm values entered to plotter-nib precision (0.15, 0.25,
// 0.35mm etc.) — display up to 2 decimals, trimming trailing zeros rather
// than padding to a fixed width, so 1 shows as "1", 1.1 as "1.1", and 1.05
// as "1.05". Nothing in the native <input type=number> widget guarantees
// this on its own (its own internal step/display arithmetic can otherwise
// show a value rounded to fewer decimals than were actually typed or
// stepped to), so this is applied explicitly after every edit.
export function fmtWidth(n){ return (Math.round(n*100)/100).toString(); }
// Shared by every per-layer dash <select> (built below) AND by addDashSlot
// further down, which appends a fresh <option> to each already-built one
// when a new slot is created — 'solid' is always first and isn't part of
// DASH_KEYS itself (see its own comment in main.js).
export function dashOptionsHtml(){
  return '<option value="solid">—</option>' + DASH_KEYS.map(k => '<option value="' + k + '">' + k + '</option>').join('');
}
// The pen counterpart of dashOptionsHtml, but (re)fills an existing <select>
// in place rather than returning markup: pen names are user-typed, so they
// go in via textContent, never through innerHTML. Every pen dropdown (layer
// rows here, the Layout Override menu) carries the .penSelect class, which
// is how pen-library.js finds them all again after an add/rename/delete.
// Keeps the select's current pen when it still exists, else lands on
// `fallbackId` (if that exists) or the first pen.
export function fillPenSelect(select, fallbackId){
  const prev = select.value;
  select.replaceChildren(...PEN_LIBRARY.map(p => {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.name;
    return opt;
  }));
  const has = id => PEN_LIBRARY.some(p => p.id === id);
  select.value = has(prev) ? prev : has(fallbackId) ? fallbackId : PEN_LIBRARY[0].id;
}
// The layer rows' DOM, keyed by layer id: { chk, pen, dash, sw }. A VIEW of
// the instances in layers.js — the instance is the state; a row's own
// listeners write into it (see buildLayerRows) and applyLayerStyle pushes
// the instance back into the row.
export const layerEls = {};

/* ================= Dash section (Pen library tab) =================
   D1/D2 are user-editable 6-value patterns (dash,gap,dash,gap,dash,gap),
   each value an absolute length in mm, independent of pen width — see
   DASH_RATIOS/scaledDash/dashPattern in main.js. Editing a field here
   refreshes every layer currently on this pattern (any layer could be
   using it, not just one), the same reason a paper-size change already
   re-runs applyLayerStyle for every layer elsewhere. */
const DASH_FIELD_LABELS = ['dash','gap','dash','gap','dash','gap'];
export function refreshDashPreview(key){
  const line = $('dashPreview' + key).querySelector('line');
  const pattern = dashPattern(key);
  const PREVIEW_PX_PER_UNIT = 6;    // arbitrary — this preview isn't tied to any real layer's width
  if (pattern) line.setAttribute('stroke-dasharray', pattern.map(v => v*PREVIEW_PX_PER_UNIT).join(' '));
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
      for (const L of layers) applyLayerStyle(L.id);
      refreshStatusR();
    });
  });
  refreshDashPreview(key);
}
/* "+ Add dash style" — only ever grows DASH_KEYS (never removes), up to
   MAX_DASH_SLOTS. New slot starts at a plain, visibly non-solid default
   ([2,2,0,0,0,0]) purely so it's not all-zeros (which scaledDash would
   otherwise silently render as solid) until the user actually customizes
   it via the sliders buildDashFields just built. */
export function addDashSlot(){
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
  for (const L of layers){
    const opt = document.createElement('option');
    opt.value = newKey; opt.textContent = newKey;
    layerEls[L.id].dash.appendChild(opt);
  }
  if (DASH_KEYS.length >= MAX_DASH_SLOTS) $('addDashBtn').disabled = true;
}
// The layer instance's on/pen/dash with color/width resolved through its
// pen (see PEN_LIBRARY in main.js) — callers keep seeing the same flat
// shape they always did.
export function layerStyle(id){
  const L = layerById(id);
  const pen = penById(L.pen);
  return { on: L.on, color: pen.color, width: pen.width, dash: L.dash };
}
// Renders one layer's instance state: its row (checkbox, pen and dash
// dropdowns, swatch) and its group in the on-screen SVG.
export function applyLayerStyle(id){
  const s = layerStyle(id), el = layerEls[id], L = layerById(id);
  el.chk.checked = L.on;
  if (PEN_LIBRARY.some(p => p.id === L.pen)) el.pen.value = L.pen;
  el.dash.value = L.dash;
  const swWidth = Math.max(0.6, s.width);
  el.sw.setAttribute('stroke', s.color);
  el.sw.setAttribute('stroke-width', swWidth);
  el.sw.setAttribute('stroke-dasharray', scaledDash(s.dash, swWidth));
  const g = document.getElementById('g_' + id);
  if (g){
    g.setAttribute('stroke', s.color);
    // s.width is a true mm value (the pen's W[mm] — see PEN_LIBRARY).
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
    const k = pxPerMm();
    const gWidth = s.width * k;
    g.setAttribute('stroke-width', gWidth);
    // Dash/gap are true mm lengths (DASH_RATIOS), independent of pen width —
    // scale by the SAME mm->px factor as the width above, NOT by gWidth
    // itself, or a 10mm dash would come out as 10x-the-pen-width instead.
    const dash = scaledDash(s.dash, k);
    if (dash) g.setAttribute('stroke-dasharray', dash); else g.removeAttribute('stroke-dasharray');
    g.style.display = s.on ? '' : 'none';
  }
  // Blocks freeze geometry but read color/width/dash/on live (see
  // layout-canvas.js) — only worth the redraw while Layout is the tab
  // actually being looked at; switching TO Layout already does a full
  // render on its own.
  if (activeTab === 'layout') refreshAllBlockStyles();
  // The Preview tab's Layout overlay clones each block's current DOM rather
  // than referencing it live (see renderPreviewLayoutOverlay's own comment
  // for why), so a color/width/dash panel tweak needs an explicit rebuild
  // to show up in the overlay — it re-applies updateBlockStyle to each
  // block itself before re-cloning, so this alone is enough even though
  // refreshAllBlockStyles() above didn't run.
  if (layoutOverlayOn) renderPreviewLayoutOverlay();
}

/* ================= layer rows (Lines tab) =================
   One row per layer instance, built from `layers` (layers.js) at boot and
   again whenever the list itself changes — a scene import, or the user
   adding, duplicating, deleting or reordering a fill layer. A row is a
   VIEW: its controls write straight into the instance, and applyLayerStyle
   renders the instance back into the row.
   An edge row is the plain five-column .layer grid (checkbox, swatch,
   name, pen, dash). A fill row adds a disclosure triangle in front and
   duplicate/delete buttons at the end, and owns a settings panel beneath
   it holding that layer's own solve settings (its type's `settings`
   schema), shown while the row is expanded. One row at a time is
   expanded; the circles centre gizmo follows the expanded layer.
   Fill rows can be dragged to reorder among themselves; edge rows keep
   the fixed hierarchy above them. Order is drawing priority and, for the
   hatch passes, the order the shared segment cap runs out in, so a
   reorder re-solves. */
let expandedId = null;
export function expandedLayerId(){ return expandedId; }
// Every fill row's settings sliders, by layer id then setting key, so the
// gizmo / a paper change / the Soft shadows toggle can refresh them
// without rebuilding the rows.
const fillRowEls = {};
// Half the page in each axis — the range of a circles centre slider.
function paperHalf(axis){
  const layout = computePaperLayout();
  if (!layout) return 150;
  return (axis === 'w' ? layout.paperW : layout.paperH) / 2;
}
function settingRange(spec){
  return spec.paperHalf ? { min: -paperHalf(spec.paperHalf), max: paperHalf(spec.paperHalf) } : { min: spec.min, max: spec.max };
}
// Pushes a layer's stored values back into its own sliders (after a gizmo
// drag, or a paper change that rescaled a centre).
export function syncFillRowValues(id){
  const els = fillRowEls[id], L = layerById(id);
  if (!els || !L) return;
  for (const key in els){ els[key].input.value = L[key]; els[key].refresh(); }
}
// Re-applies every circles centre slider's range after a paper change.
export function syncFillRowRanges(){
  for (const L of layers){
    const els = fillRowEls[L.id];
    if (!els) continue;
    for (const spec of layerType(L).settings || []){
      const el = els[spec.key];
      if (!el || !spec.paperHalf) continue;
      const r = settingRange(spec);
      el.input.min = r.min; el.input.max = r.max;
      L[spec.key] = Math.min(r.max, Math.max(r.min, L[spec.key]));
      el.input.value = L[spec.key];
      el.refresh();
    }
  }
}
// Dims every "below" threshold slider while Soft shadows is off, the same
// .ctlDisabled treatment the shadow controls get — fillPasses forces those
// thresholds to 0, so the sliders are genuinely inert.
export function syncFillRowSoftState(){
  const on = $('softShadows').checked;
  for (const id in fillRowEls)
    for (const key in fillRowEls[id]){
      const el = fillRowEls[id][key];
      if (el.spec.soft) el.ctl.classList.toggle('ctlDisabled', !on);
    }
}
// The settings panel under one fill row: a .ctl slider per entry in the
// type's schema, each writing its own field on the instance.
function buildFillSettings(L){
  const wrap = document.createElement('div');
  wrap.className = 'layerSettings';
  wrap.hidden = L.id !== expandedId;
  const els = {};
  for (const spec of layerType(L).settings){
    const id = 'ls_' + L.id + '_' + spec.key;
    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = spec.label;
    const input = document.createElement('input');
    input.type = 'range'; input.id = id; input.step = spec.step;
    const r = settingRange(spec);
    input.min = r.min; input.max = r.max;
    input.value = L[spec.key];
    const val = document.createElement('span');
    val.className = 'val';
    const refresh = () => { val.textContent = formatValue(spec, input.value); };
    refresh();
    input.addEventListener('input', () => {
      L[spec.key] = +input.value;
      refresh();
      markStale();
      if (spec.paperHalf) updateTextureGizmo();   // the centre moved
    });
    makeSliderValueEditable(input, val, spec, refresh);
    ctl.append(label, input, val);
    wrap.appendChild(ctl);
    els[spec.key] = { input, val, ctl, spec, refresh };
  }
  fillRowEls[L.id] = els;
  return wrap;
}
// Everything that has to happen when the LIST changes (add, duplicate,
// delete, reorder): rows rebuilt, the texture tab's layer picker refilled,
// the gizmo re-pointed, and a re-solve, since order and membership both
// change what the worker draws.
function fillLayersChanged(){
  buildLayerRows();
  renderTextureStack();
  updateTextureGizmo();
  markStale();
  refreshStatusR();
}
function addFillLayer(type){
  layers.push(newFillLayer(type, nextFillId(), { on: true }));
  expandedId = layers[layers.length-1].id;
  fillLayersChanged();
}
function duplicateFillLayer(L){
  const copy = copyLayer(L, nextFillId());
  layers.splice(layers.indexOf(L) + 1, 0, copy);
  expandedId = copy.id;
  fillLayersChanged();
}
function deleteFillLayer(L){
  layers.splice(layers.indexOf(L), 1);
  if (expandedId === L.id) expandedId = null;
  delete fillRowEls[L.id];
  // Its geometry is still in the live SVG until the next solve.
  const g = document.getElementById('g_' + L.id);
  if (g) g.remove();
  fillLayersChanged();
}
/* Drag-reorder among fill rows — the same gesture and feedback as the
   Layout blocks list (see its own handler in layout-canvas.js): plain
   pointer events rather than native drag-and-drop, the dragged row dimmed
   in place, and an accent insertion line showing where it would land among
   the rows that aren't moving. The reorder happens on release.
   A drag starts anywhere on the row except its own controls, so the name,
   the swatch and the empty space are all grips while the checkbox, the
   dropdowns and the buttons keep working.
   Fill layers can never move above the edge layers, so only positions
   within the fill run are offered. */
const INSERT_LINE_HEIGHT = 2;
let fillDragState = null;
function startFillRowDrag(e, row, L){
  if (e.button !== 0 || e.target.closest('input,select,button')) return;
  const host = row.parentNode;
  const others = [...host.querySelectorAll('.fillRow')].filter(r => r !== row);
  fillDragState = { L, row, host, others, insertLine: svgInsertLine(), target: null, moved: false, startY: e.clientY };
  row.setPointerCapture(e.pointerId);
}
// How far the pointer must travel before a press on a row counts as a drag
// rather than a click on the row's own controls.
const FILL_DRAG_SLOP = 4;
function svgInsertLine(){
  const line = document.createElement('div');
  line.className = 'svInsertLine';
  return line;
}
function onFillRowDragMove(e){
  if (!fillDragState) return;
  const { host, others, insertLine, row } = fillDragState;
  if (!fillDragState.moved){
    if (Math.abs(e.clientY - fillDragState.startY) < FILL_DRAG_SLOP) return;
    fillDragState.moved = true;
    row.classList.add('svDragging');
  }
  let target = null;
  for (const r of others){
    const rect = r.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height/2){ target = r; break; }
  }
  fillDragState.target = target;          // null means "after every other row"
  if (!insertLine.parentNode) host.appendChild(insertLine);
  const hostRect = host.getBoundingClientRect();
  let top = 0;
  if (target) top = target.getBoundingClientRect().top - hostRect.top;
  else if (others.length) top = others[others.length-1].getBoundingClientRect().bottom - hostRect.top - INSERT_LINE_HEIGHT;
  insertLine.style.top = top + 'px';
}
function endFillRowDrag(){
  if (!fillDragState) return;
  const { L, row, others, insertLine, target, moved } = fillDragState;
  insertLine.remove();
  row.classList.remove('svDragging');
  fillDragState = null;
  if (!moved) return;                     // pressed but never dragged
  // `others` is the fill run without the dragged layer, in the same order,
  // so the row index carries straight over to the layer list.
  const before = layers.filter(e2 => layerType(e2).kind === 'fill');
  const rest = before.filter(e2 => e2 !== L);
  const at = target ? others.indexOf(target) : others.length;
  rest.splice(at, 0, L);
  if (rest.every((e2, i) => e2 === before[i])) return;   // dropped where it already was
  replaceLayers([...layers.filter(e2 => layerType(e2).kind !== 'fill'), ...rest]);
  fillLayersChanged();
}
// (Re)builds every row from the current instances.
export function buildLayerRows(){
  for (const id in layerEls) delete layerEls[id];
  for (const id in fillRowEls) delete fillRowEls[id];
  for (const host of new Set(Object.values(LAYER_TYPES).map(T => T.host))) $(host).replaceChildren();
  for (const L of layers){
    const T = layerType(L);
    const isFill = T.kind === 'fill';
    const name = layerName(L);
    const row = document.createElement('div');
    row.className = 'layer' + (isFill ? ' fillRow' : '');
    row.innerHTML =
      (isFill ? '<button type="button" class="rowExpand" aria-label="' + name + ' settings">&#9656;</button>' : '') +
      '<input type="checkbox" aria-label="' + name + ' on">' +
      '<svg class="swatch" viewBox="0 0 50 14" aria-hidden="true"><path d="M3 7 L47 7" fill="none"/></svg>' +
      '<span class="nm' + (name.startsWith('·') ? ' hid' : '') + '"></span>' +
      '<select class="penSelect" aria-label="' + name + ' pen"></select>' +
      '<select aria-label="' + name + ' dash">' + dashOptionsHtml() + '</select>' +
      (isFill
        ? '<button type="button" class="svBtn rowDup" title="Duplicate layer" aria-label="Duplicate ' + name + '">&#10697;</button>' +
          '<button type="button" class="svBtn svDelete" title="Delete layer" aria-label="Delete ' + name + '">&#10005;</button>'
        : '');
    const host = $(T.host);
    host.appendChild(row);
    const expand = isFill ? row.children[0] : null;
    const chk = row.querySelector('input[type=checkbox]');
    const sw = row.querySelector('.swatch').firstChild;
    const [pen, dash] = row.querySelectorAll('select');
    row.querySelector('.nm').textContent = name;
    fillPenSelect(pen, L.pen);
    layerEls[L.id] = { chk, pen, dash, sw };
    pen.addEventListener('change', () => { L.pen = pen.value; applyLayerStyle(L.id); });
    dash.addEventListener('change', () => { L.dash = dash.value; applyLayerStyle(L.id); refreshStatusR(); });
    chk.addEventListener('change', () => {
      L.on = chk.checked;
      markStale();
      // Fades the Lines-section sliders that belong to a layer group once that
      // group draws nothing (panel-controls.js).
      syncLineLayerUI();
      updateTextureGizmo();   // the Circles centre gizmo follows its layer's checkbox
    });
    if (isFill){
      const panel = buildFillSettings(L);
      host.appendChild(panel);
      row.classList.toggle('rowExpanded', L.id === expandedId);
      expand.addEventListener('click', () => {
        expandedId = expandedId === L.id ? null : L.id;
        for (const other of host.querySelectorAll('.fillRow')) other.classList.remove('rowExpanded');
        for (const other of host.querySelectorAll('.layerSettings')) other.hidden = true;
        if (expandedId === L.id){ row.classList.add('rowExpanded'); panel.hidden = false; }
        updateTextureGizmo();   // the gizmo follows whichever circles layer is open
      });
      row.querySelector('.rowDup').addEventListener('click', () => duplicateFillLayer(L));
      row.querySelector('.svDelete').addEventListener('click', () => deleteFillLayer(L));
      row.addEventListener('pointerdown', e => startFillRowDrag(e, row, L));
    }
    applyLayerStyle(L.id);
  }
  syncFillRowSoftState();
}

/* ================= init =================
   Everything above only declares. This wires the DOM and starts the
   module's live behaviour — called once by app.js, in script order. */
export function initSvgExport(){
  buildLayerRows();
  // "+ Add layer": one option per fill type, and back to the placeholder
  // after each pick (it is an action, not a stored choice).
  const addSel = $('addLayerSelect');
  addSel.replaceChildren(...[['', '+ Add layer…'], ...FILL_TYPES.map(t => [t, LAYER_TYPES[t].name])].map(([value, text]) => {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = text;
    return opt;
  }));
  addSel.addEventListener('change', () => {
    const type = addSel.value;
    addSel.value = '';
    if (type) addFillLayer(type);
  });
  // The fill rows' drag-reorder (startFillRowDrag) tracks and ends here, so
  // a release outside the row still finishes the gesture.
  document.addEventListener('pointermove', onFillRowDragMove);
  document.addEventListener('pointerup', endFillRowDrag);
  document.addEventListener('pointercancel', endFillRowDrag);
  buildDashFields('D1');
  buildDashFields('D2');
  $('addDashBtn').addEventListener('click', addDashSlot);
  if (DASH_KEYS.length >= MAX_DASH_SLOTS) $('addDashBtn').disabled = true;   // defensive — e.g. a restored scene that already has all 9
}
