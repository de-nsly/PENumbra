/* ================================================================
   texture-stack.js — the Texture tab's per-layer stack editor
   Edits one layer's texture stack (layers.js: the instance's `texture`
   array, entries typed by TEXTURE_FILTERS): pick a layer, add a filter
   from the types its geometry supports, edit each entry's parameters,
   remove an entry. Only the fill layers are offered today — edge layers
   carry an empty stack that nothing applies yet (refactor plan §4e).
   Every edit marks the drawing stale, as the texture controls always
   did; onResult (svg-export.js) applies the stacks when the result comes
   back. Rebuilt wholesale (renderTextureStack) after a scene import
   replaces the layer list.
   ================================================================ */
import { $ } from './main.js';
import { TEXTURE_FILTERS, fillLayers, filterSupports, layerById, layerType, newFilter } from './layers.js';
import { formatValue } from './settings.js';
import { makeSliderValueEditable, markStale } from './panel-controls.js';

let selectedLayerId = null;

function selectedLayer(){
  const L = selectedLayerId && layerById(selectedLayerId);
  if (L && layerType(L).kind === 'fill') return L;
  const first = fillLayers()[0] || null;
  selectedLayerId = first ? first.id : null;
  return first;
}

// One stack entry: a header row with the filter's name and a delete
// button, then a control row per parameter.
function buildEntry(L, entry, index){
  const def = TEXTURE_FILTERS[entry.type];
  const group = document.createElement('div');
  group.className = 'textureGroup';
  const head = document.createElement('div');
  head.className = 'dashGroupLabel';
  head.innerHTML = '<span></span><button type="button" class="svBtn svDelete" title="Remove filter">&#10005;</button>';
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
      chk.addEventListener('change', () => { entry[p.key] = chk.checked; markStale(); });
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
    const refresh = () => { val.textContent = formatValue({ unit: p.unit, decimals: 1 }, range.value); };
    refresh();
    range.addEventListener('input', () => { entry[p.key] = +range.value; refresh(); markStale(); });
    makeSliderValueEditable(range, val, { unit: p.unit }, refresh);
    ctl.append(label, range, val);
    fields.appendChild(ctl);
  }
  group.appendChild(fields);
  return group;
}

export function renderTextureStack(){
  const layerSel = $('texLayerSelect');
  const addSel = $('texAddFilter');
  const list = $('texStackList');
  const L = selectedLayer();
  layerSel.replaceChildren(...fillLayers().map(F => {
    const opt = document.createElement('option');
    opt.value = F.id; opt.textContent = F.name;   // user text — never innerHTML
    return opt;
  }));
  list.replaceChildren();
  addSel.replaceChildren();
  if (!L){ layerSel.disabled = addSel.disabled = true; return; }
  layerSel.disabled = addSel.disabled = false;
  layerSel.value = L.id;
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
  $('texLayerSelect').addEventListener('change', () => {
    selectedLayerId = $('texLayerSelect').value;
    renderTextureStack();
  });
  $('texAddFilter').addEventListener('change', () => {
    const type = $('texAddFilter').value;
    const L = selectedLayer();
    if (!type || !L) return;
    // Inserted at its TEXTURE_FILTERS position: the stack applies in list
    // order (applyTextureStack, svg-export.js), and this keeps the three line
    // jitters, which run as one combined step, adjacent.
    const order = Object.keys(TEXTURE_FILTERS);
    const at = L.texture.findIndex(f => order.indexOf(f.type) > order.indexOf(type));
    L.texture.splice(at < 0 ? L.texture.length : at, 0, newFilter(type));
    renderTextureStack();
    markStale();
  });
  renderTextureStack();
}
