/* ================================================================
   texture-stack.js — the Texture tab's per-layer stack editor
   Edits one layer's texture stack (layers.js: the instance's `texture`
   array, entries typed by TEXTURE_FILTERS): pick a layer from the button
   list, add a filter from the types its geometry supports, edit each
   entry's parameters, remove an entry. Every enabled layer is offered,
   edge and fill alike, in two columns (textureLayers(), buildLayerList);
   the Filter menu offers what that layer's geometry supports (refactor
   plan §10).
   The layer being edited follows the Lines tab's selection, one way: a
   fill row selected there is pushed here (setTextureLayer, called by
   layer-rows.js), but picking a layer here never selects anything there.
   Every edit marks the drawing stale, as the texture controls always
   did; renderResult (render-result.js) applies the stacks when the result comes
   back. Rebuilt wholesale (renderTextureStack) after a scene import
   replaces the layer list.
   Sync (#texSyncParams, a saved scene setting): while it is on, editing
   one parameter writes the same value into that parameter of every
   layer's entry of the same filter type (setParam), and a newly added
   filter copies an existing entry of its type instead of the defaults.
   Only values sync, never which filters a stack holds, and only on edit:
   turning sync on changes nothing by itself, so values that already
   differ stay different until one of them is edited.
   ================================================================ */
import { $ } from './main.js';
import { TEXTURE_FILTERS, filterSupports, layerListName, layerType, layers, newFilter, stackEntry } from './layers.js';
import { formatValue } from './settings.js';
import { makeSliderValueEditable, markStale } from './panel-controls.js';

let selectedLayerId = null;
// The Lines tab's selection, pushed in as it changes. Only records the id —
// the caller re-renders (layer-rows.js does, straight after).
export function setTextureLayer(id){ selectedLayerId = id; }

/* Which layers the list offers: the enabled ones, in layer order — a layer
   switched off draws nothing, so there is nothing to texture. Every layer
   can hold a stack (renderResult applies each one's), and a switched-off
   layer keeps its own, which sync still reaches (setParam walks every
   layer). Edge rows in the Lines tab can't be selected, so this list is
   how an edge layer is picked (the user's choice, refactor plan §10.4).
   The list is re-rendered when a layer's checkbox changes (layer-rows.js). */
function textureLayers(){ return layers.filter(L => L.on); }
// The list's two columns, left to right, headed like the Lines tab's own
// sections.
const KIND_COLUMNS = [['edge', 'Lines'], ['fill', 'Fill layers']];

function syncOn(){ return $('texSyncParams').checked; }
// Writes one parameter of one stack entry — and, with sync on, the same
// parameter of every other layer's entry of that filter type, edge and fill
// alike.
function setParam(entry, key, value){
  entry[key] = value;
  if (!syncOn()) return;
  for (const O of layers){
    const other = stackEntry(O.texture, entry.type);
    if (other) other[key] = value;
  }
}
// A new entry of one type for L's stack: with sync on, a copy of the first
// entry of that type on another layer (layer order), so it starts in step;
// otherwise, or when no layer has one, the schema defaults.
function filterToAdd(L, type){
  if (syncOn()){
    for (const O of layers){
      const src = O !== L && stackEntry(O.texture, type);
      if (src) return { ...src };
    }
  }
  return newFilter(type);
}

// The layer being edited: the picked one while it is enabled, else the first
// enabled layer. The pick itself is kept, so switching a layer off and on
// again comes back to it.
function selectedLayer(){
  const candidates = textureLayers();
  return candidates.find(C => C.id === selectedLayerId) || candidates[0] || null;
}

/* Two columns, Lines on the left and Fill layers on the right, each
   always shown with its heading (a hint when none of its layers is
   enabled). One block button per enabled layer, in layer order, under its
   list name (layerListName: "Contour hidden", "Silhouette ind."). Each
   shows how many filters its stack holds on the right, or nothing when the
   stack is empty; every add/remove re-renders the list, so the count is
   never stale. A click picks that layer; clicking the one already picked
   does nothing, since this tab always edits some layer. */
function buildLayerList(current){
  const list = $('texLayerList');
  list.replaceChildren();
  const enabled = textureLayers();
  for (const [kind, heading] of KIND_COLUMNS){
    const column = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'vpLabel';
    head.textContent = heading;
    column.appendChild(head);
    list.appendChild(column);
    const members = enabled.filter(L => layerType(L).kind === kind);
    if (!members.length){
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = 'None enabled';
      column.appendChild(hint);
    }
    for (const L of members){
      const picked = L === current;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'texLayerBtn' + (picked ? ' rowSelected' : '');
      btn.setAttribute('aria-pressed', String(picked));
      const name = document.createElement('span');
      name.className = 'texLayerName';
      name.textContent = layerListName(L);
      btn.appendChild(name);
      const n = L.texture.length;
      if (n){
        const filters = n + (n === 1 ? ' filter' : ' filters');
        const count = document.createElement('span');
        count.className = 'texLayerCount';
        count.textContent = n;
        count.title = filters + ' applied';
        btn.appendChild(count);
        // Read as "Hatch 1, 2 filters", not the bare "Hatch 1 2".
        btn.setAttribute('aria-label', layerListName(L) + ', ' + filters);
      }
      btn.addEventListener('click', () => {
        if (picked) return;
        selectedLayerId = L.id;
        renderTextureStack();
      });
      column.appendChild(btn);
    }
  }
}

// One stack entry: a header row with the filter's name and a delete
// button, then a control row per parameter.
function buildEntry(L, entry, index){
  const def = TEXTURE_FILTERS[entry.type];
  const group = document.createElement('div');
  group.className = 'textureGroup';
  const head = document.createElement('div');
  head.className = 'dashGroupLabel';
  head.innerHTML = '<span></span><button type="button" class="rowBtn rowDelete" title="Remove filter">&#10005;</button>';
  head.firstChild.textContent = def.name;
  head.lastChild.setAttribute('aria-label', 'Remove ' + def.name);
  head.lastChild.addEventListener('click', () => {
    L.texture.splice(index, 1);
    renderTextureStack();
    markStale();
  });
  group.appendChild(head);
  const fields = document.createElement('div');
  for (const p of def.params){
    const idBase = 'tex_' + L.id + '_' + entry.type + '_' + p.key;
    if (p.kind === 'checkbox'){
      const label = document.createElement('label');
      label.className = 'chk chk-sub';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!entry[p.key];
      chk.addEventListener('change', () => { setParam(entry, p.key, chk.checked); markStale(); });
      label.appendChild(chk);
      label.appendChild(document.createTextNode(' ' + p.label));
      fields.appendChild(label);
      continue;
    }
    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    const label = document.createElement('label');
    label.htmlFor = idBase;
    label.textContent = p.label;
    const range = document.createElement('input');
    range.type = 'range'; range.id = idBase;
    range.min = p.min; range.max = p.max; range.step = p.step;
    range.value = entry[p.key];
    const val = document.createElement('span');
    val.className = 'val';
    const refresh = () => { val.textContent = formatValue({ unit: p.unit, decimals: p.decimals ?? 1 }, range.value); };
    refresh();
    range.addEventListener('input', () => { setParam(entry, p.key, +range.value); refresh(); markStale(); });
    makeSliderValueEditable(range, val, { unit: p.unit }, refresh);
    ctl.append(label, range, val);
    fields.appendChild(ctl);
  }
  group.appendChild(fields);
  return group;
}

export function renderTextureStack(){
  const addSel = $('texAddFilter');
  const list = $('texStackList');
  const L = selectedLayer();
  buildLayerList(L);
  list.replaceChildren();
  addSel.replaceChildren();
  if (!L){ addSel.disabled = true; return; }
  addSel.disabled = false;
  L.texture.forEach((entry, i) => list.appendChild(buildEntry(L, entry, i)));
  // The add menu offers what this layer's geometry supports and the stack
  // doesn't hold yet (one entry per type — see stackEntry in layers.js).
  const geometry = layerType(L).geometry;
  const placeholder = document.createElement('option');
  placeholder.value = ''; placeholder.textContent = '+ Add filter…';
  addSel.appendChild(placeholder);
  for (const type in TEXTURE_FILTERS){
    if (!filterSupports(type, geometry) || L.texture.some(f => f.type === type)) continue;
    const opt = document.createElement('option');
    opt.value = type; opt.textContent = TEXTURE_FILTERS[type].name;
    addSel.appendChild(opt);
  }
  addSel.value = '';
  addSel.disabled = addSel.options.length <= 1;
}

/* ================= init =================
   Everything above only declares. This wires the DOM and starts the
   module's live behaviour — called once by app.js, in script order. */
export function initTextureStack(){
  $('texAddFilter').addEventListener('change', () => {
    const type = $('texAddFilter').value;
    const L = selectedLayer();
    if (!type || !L) return;
    // Inserted at its TEXTURE_FILTERS position: the stack applies in list
    // order (applyTextureStack, hatch-texture.js), and this keeps the three line
    // jitters, which run as one combined step, adjacent.
    const order = Object.keys(TEXTURE_FILTERS);
    const at = L.texture.findIndex(f => order.indexOf(f.type) > order.indexOf(type));
    L.texture.splice(at < 0 ? L.texture.length : at, 0, filterToAdd(L, type));
    renderTextureStack();
    markStale();
  });
  renderTextureStack();
}
