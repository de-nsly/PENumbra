/* ================================================================
   layers.js — the layer model
   Every drawing layer is an INSTANCE in `layers`, ordered highest
   priority first:
     - UI row order, top to bottom
     - cross-layer ink-avoidance (a lower layer never re-strokes what an
       enabled higher layer already covers — see the cascade in the
       worker's generate())
     - paint order in the SVG: renderResult walks this list in REVERSE so the
       highest-priority layer (Silhouette) ends up painted last/on top.
   Toggling any layer re-runs the whole pipeline: the cascade means one
   layer's on/off changes which ink survives in every layer below it, so
   there is no display-only toggle.

   Instance shape: { id, type, on, pen, dash, texture, ...fill settings }
     id       the persisted key: layer groups in a result (m.groups[id]),
              Layout block layerPaths/layerVisible/overrideStyle, the row
              DOM (layerEls[id]), the SVG group g_<id>. Edge layers are
              singletons whose id is their type; the four original fill
              layers keep h1/h2/h3/cr (so old files and frozen Layout
              blocks still match), new ones get f1, f2, … (nextFillId).
     type     a key of LAYER_TYPES
     on/pen/dash   the row's state — the instance IS the state, the row
              DOM (layer-rows.js) is a view of it
     texture  the ordered texture stack: [{ type, ...params }] with types
              from TEXTURE_FILTERS. Empty = no texture. Only fill layers
              apply theirs today (renderResult); edge layers carry [].
     fill settings  every solve setting of a fill layer, one field per
              entry in its type's `settings` schema: angleDeg (hatch),
              minSpacing/maxSpacing (mm), threshold, and centerX/centerY
              (circles, mm from the page centre). Nothing is shared
              between instances.

   Names are derived, never stored: a fill layer is its type's name plus
   its number among the layers of that type (layerName) — "Hatch 1",
   "Circles 2" — so deleting one renumbers the rest.

   The layer ids are persisted and several read nothing like what they
   draw — the decoder table is on LAYER_TYPES below.

   Pure data: imports nothing, touches no DOM — tools/harness uses it
   headlessly, and sceneLayers() is the loader for every .pen version.
   ================================================================ */

/* chain — how renderResult joins an edge layer's worker segments into paths:
   'silhouette' (buildChainedPathD), 'contour' (appendContourPathD, by
   the worker's run identity), 'crease' (appendCreasePathD).
   geometry — what a fill layer's pieces are, which decides which texture
   filters apply: 'lines' (hatch strokes) or 'arcs' (circle pieces).
   host — the container in index.html the row is appended to; the edge
   layers are split across three so each group's solve settings can sit
   directly under the rows they affect.
   settings — a fill type's own solve settings, in row order. Each is a
   slider: {key, label, min, max, step, def, unit, decimals}. `paperHalf`
   means the range is half the page in that axis instead of min/max (the
   circles centre, an offset from the page centre). `soft` marks a setting
   Soft shadows disables, dimmed in the row like the shadow controls.
   thrFallback — only the loaders use it: the threshold an old scene's
   global slider stood for when it held no number.

   THE LAYER KEYS ARE PERSISTED and several of them no longer read like
   what they draw. They are written into every `.pen` file (the layer
   list, and every Layout block's layerPaths/layerVisible/overrideStyle)
   and into clipboard payloads, so they must keep their spelling — this
   table is the decoder:
     so        Silhouette
     iv / ih   Silhouette individual, visible / hidden
     sv / sh   CONTOUR, visible / hidden — "s" for silhouette, from when
               contour edges were part of that family
     cv / ch   Crease, visible / hidden
     h1 h2 h3  the first three Hatch layers (once Hatch, Crosshatch and
               Deep shadow, before fill layers became user-managed)
     cr        the first Circles layer
     f1 f2 …   every fill layer added since (nextFillId; never reused
               within a session) */
export const LAYER_TYPES = {
  so: { kind:'edge', name:'Silhouette',            chain:'silhouette', host:'edgeRowsSil' },
  iv: { kind:'edge', name:'Silhouette individual', chain:'silhouette', host:'edgeRowsSil' },
  ih: { kind:'edge', name:'· hidden',              chain:'silhouette', host:'edgeRowsSil' },
  sv: { kind:'edge', name:'Contour',               chain:'contour',    host:'edgeRowsContour' },
  sh: { kind:'edge', name:'· hidden',              chain:'contour',    host:'edgeRowsContour' },
  cv: { kind:'edge', name:'Crease',                chain:'crease',     host:'edgeRowsCrease' },
  ch: { kind:'edge', name:'· hidden',              chain:'crease',     host:'edgeRowsCrease' },
  hatch: { kind:'fill', name:'Hatch', geometry:'lines', host:'fillRows', pen:'p5', settings:[
    // A full turn, not the half a line family repeats over: the carrier
    // lines of 217° and of 37° are the same direction but anchored from
    // opposite ends of the drawing, so they do not coincide. Scenes from
    // before per-layer angles had an effective angle of up to 270 (the
    // global angle plus a 90° offset), and keeping the range this wide is
    // what lets them migrate to exactly the lines they drew before.
    { key:'angleDeg',   label:'Angle',       min:0,   max:360, step:1,    def:45,   unit:'°',  decimals:0 },
    { key:'minSpacing', label:'Min spacing', min:0.1, max:5,   step:0.1,  def:1,    unit:'mm', decimals:1 },
    { key:'maxSpacing', label:'Max spacing', min:1,   max:20,  step:0.5,  def:7,    unit:'mm', decimals:1 },
    { key:'threshold',  label:'Below',       min:0.01, max:1,  step:0.01, def:0.92, unit:'',   decimals:2, soft:true },
  ]},
  circles: { kind:'fill', name:'Circles', geometry:'arcs', host:'fillRows', pen:'p5', thrFallback:0.92, settings:[
    { key:'minSpacing', label:'Min spacing', min:0.1, max:5,  step:0.1,  def:1,    unit:'mm', decimals:1 },
    { key:'maxSpacing', label:'Max spacing', min:1,   max:20, step:0.5,  def:7,    unit:'mm', decimals:1 },
    { key:'threshold',  label:'Below',       min:0.01, max:1, step:0.01, def:0.92, unit:'',   decimals:2, soft:true },
    { key:'centerX',    label:'Center X',    paperHalf:'w', step:1, def:0, unit:'mm', decimals:1 },
    { key:'centerY',    label:'Center Y',    paperHalf:'h', step:1, def:0, unit:'mm', decimals:1 },
  ]},
};
export const FILL_TYPES = Object.keys(LAYER_TYPES).filter(t => LAYER_TYPES[t].kind === 'fill');

// pen → the DEFAULT pen id (see PEN_LIBRARY in main.js) the row starts on.
// A layer has no colour/width of its own, only a pen reference.
// The three Hatch layers start at the angles and thresholds the app's old
// global controls produced for Hatch / Crosshatch / Deep shadow (45° + 0/90/45
// with the 0.92 / 0.45 / 0.18 thresholds), so a fresh session solves as before.
export function defaultLayers(){
  return [
    { id:'so', type:'so', on:false, pen:'p1', dash:'solid', texture:[] },
    { id:'iv', type:'iv', on:false, pen:'p2', dash:'solid', texture:[] },
    { id:'ih', type:'ih', on:false, pen:'p4', dash:'D1',    texture:[] },
    { id:'sv', type:'sv', on:true,  pen:'p2', dash:'solid', texture:[] },
    { id:'sh', type:'sh', on:false, pen:'p4', dash:'D1',    texture:[] },
    { id:'cv', type:'cv', on:true,  pen:'p3', dash:'solid', texture:[] },
    { id:'ch', type:'ch', on:false, pen:'p4', dash:'D1',    texture:[] },
    newFillLayer('hatch',   'h1', { on:true,  angleDeg:45,  threshold:0.92 }),
    newFillLayer('hatch',   'h2', { on:true,  angleDeg:135, threshold:0.45 }),
    //newFillLayer('hatch',   'h3', { on:false, angleDeg:90,  threshold:0.18 }),
    newFillLayer('circles', 'cr', { on:false }),
  ];
}
// A fill instance at its type's defaults, with `over` applied on top.
export function newFillLayer(type, id, over){
  const T = LAYER_TYPES[type];
  const L = { id, type, on:false, pen:T.pen, dash:'solid', texture:[] };
  for (const s of T.settings) L[s.key] = s.def;
  return Object.assign(L, over);
}
// Keeps a fill setting inside its slider's range (paperHalf sliders are
// bounded by the page, so only their type is checked here).
function clampSetting(spec, v){
  const n = +v;
  if (!Number.isFinite(n)) return spec.def;
  if (spec.paperHalf) return n;
  return Math.min(spec.max, Math.max(spec.min, n));
}
// The live list. Mutated in place (like PEN_LIBRARY/DASH_KEYS), never
// reassigned, so every module's imported binding stays valid.
export const layers = defaultLayers();
export function replaceLayers(list){ layers.splice(0, layers.length, ...list); }
export function layerById(id){ return layers.find(L => L.id === id); }
// Is this layer drawing? The instance IS the state (its row is a view of it),
// so this is the only question worth asking about an id — layerStyle() is for
// when the pen colour/width are wanted too. Safe on an id no layer has, which
// a partial scene file can produce.
export function isLayerOn(id){ const L = layerById(id); return !!(L && L.on); }
export function layerType(L){ return LAYER_TYPES[L.type]; }
export function fillLayers(){ return layers.filter(L => layerType(L).kind === 'fill'); }
// Display name: an edge layer's is fixed, a fill layer's is its type plus its
// number among the layers of that type ("Hatch 2"), so it always reflects the
// current list — deleting a layer renumbers the ones after it.
export function layerName(L){
  const T = layerType(L);
  if (T.kind === 'edge') return T.name;
  const sameType = layers.filter(e => e.type === L.type);
  return T.name + ' ' + (sameType.indexOf(L) + 1);
}
/* Ids for layers added in this session: f1, f2, … The counter only ever
   climbs, and never reuses an id even after a delete or a scene import —
   a Layout block frozen from an old layer must never be re-matched to a
   different one that happens to have taken its id. */
let fillIdCounter = 0;
export function nextFillId(){
  let id;
  do id = 'f' + (++fillIdCounter); while (layers.some(L => L.id === id));
  return id;
}
// A scene import brings its own ids: keep the counter ahead of them.
function noteFillIds(list){
  for (const L of list){
    const m = /^f(\d+)$/.exec(L.id);
    if (m && +m[1] > fillIdCounter) fillIdCounter = +m[1];
  }
}

/* ================= texture filters =================
   The schema of every texture effect a fill layer's stack can hold: its
   parameters (with the slider ranges and defaults the stack editor uses,
   and the fallback the reader uses for a missing value) and which
   geometry kinds it applies to. The implementations live with the rest
   of the geometry code in hatch-texture.js (TEXTURE_IMPL, run by
   applyTextureStack in stack order), keyed by these same type names. Key
   order here is the canonical order: the stack editor inserts a new entry
   at its position, a version-1 scene's enabled effects are migrated in it
   (the old fixed pipeline's order), and it keeps the three line jitters —
   one combined step in applyTextureStack — adjacent. */
export const TEXTURE_FILTERS = {
  trim: { name:'Trim / extend', geometry:['lines','arcs'], params:[
    { key:'value', label:'Value', min:-10, max:10, step:0.1, def:0, unit:'mm' },
  ]},
  overshoot: { name:'Overshoot / undershoot', geometry:['lines','arcs'], params:[
    { key:'min', label:'Min', min:-10, max:10, step:0.1, def:-2, unit:'mm' },
    { key:'max', label:'Max', min:-10, max:10, step:0.1, def:1,  unit:'mm' },
  ]},
  spacingJitter: { name:'Spacing jitter', geometry:['lines','arcs'], params:[
    { key:'min', label:'Min', min:0, max:10, step:0.1, def:0,   unit:'mm' },
    { key:'max', label:'Max', min:0, max:10, step:0.1, def:0.5, unit:'mm' },
  ]},
  angleJitter: { name:'Angle jitter', geometry:['lines'], params:[
    { key:'min', label:'Min', min:0, max:10, step:0.1, def:0,   unit:'°' },
    { key:'max', label:'Max', min:0, max:10, step:0.1, def:0.5, unit:'°' },
  ]},
  wobble: { name:'Wobble', geometry:['lines','arcs'], params:[
    { key:'shared',    label:'Same noise field per layer', kind:'checkbox', def:false },
    { key:'spacing',   label:'Spacing',    min:0.1, max:10, step:0.1, def:1,   unit:'mm' },
    { key:'amp',       label:'Amplitude',  min:0,   max:10, step:0.1, def:0.5, unit:'mm' },
    { key:'variation', label:'Variation',  min:0,   max:1,  step:0.1, def:0,   unit:'' },
    { key:'varScale',  label:'Var. scale', min:1,   max:50, step:0.5, def:10,  unit:'mm' },
  ]},
  regularWobble: { name:'Regular wobble', geometry:['lines'], params:[
    { key:'amp',        label:'Amplitude',  min:0,   max:10, step:0.1, def:0.5, unit:'mm' },
    { key:'wavelength', label:'Wavelength', min:0.5, max:50, step:0.5, def:5,   unit:'mm' },
  ]},
  gaps: { name:'Gaps', geometry:['lines','arcs'], params:[
    { key:'spacing', label:'Avg. spacing', min:1,   max:100, step:0.5, def:30, unit:'mm' },
    { key:'max',     label:'Max gap',      min:0.1, max:10,  step:0.1, def:2,  unit:'mm' },
  ]},
};
export function filterSupports(type, geometry){
  const f = TEXTURE_FILTERS[type];
  return !!f && f.geometry.includes(geometry);
}
// A fresh stack entry of one type at the schema's defaults.
export function newFilter(type){
  const entry = { type };
  for (const p of TEXTURE_FILTERS[type].params) entry[p.key] = p.def;
  return entry;
}
// The entry of one type in a stack, or null. A stack holds at most one entry
// per type today (the editor and sanitizeStack enforce it): the combined
// line-jitter step reads its three entries through this.
export function stackEntry(stack, type){
  return stack.find(f => f.type === type) || null;
}
// Coerces a stack read from a file: unknown types and filters the layer's
// geometry doesn't support are dropped, every param is forced to its type
// (a bad number takes the default).
function sanitizeStack(src, geometry){
  const out = [];
  if (!Array.isArray(src)) return out;
  for (const f of src){
    if (!f || typeof f !== 'object' || !filterSupports(f.type, geometry)) continue;
    if (out.some(e => e.type === f.type)) continue;
    const entry = { type: f.type };
    for (const p of TEXTURE_FILTERS[f.type].params){
      entry[p.key] = p.kind === 'checkbox' ? !!f[p.key] : (Number.isFinite(+f[p.key]) && f[p.key] !== '' && f[p.key] !== null ? +f[p.key] : p.def);
    }
    out.push(entry);
  }
  return out;
}
// A deep copy, for duplicating a layer (its stack must not be shared).
export function copyLayer(L, id){
  return { ...L, id, texture: L.texture.map(f => ({ ...f })) };
}

/* ================= scene loading =================
   sceneLayers(data, resolvePen) builds the instance list a .pen scene
   describes. resolvePen(saved, defaultPenId) turns a saved layer record's
   pen reference into a pen id of the current library (the app matches an
   old record's colour/width into the library; the harness takes the id).

   Version 1 (penumbraScene: 1): `layers` is { key: {on, pen|color+width,
   dash} }, one entry per fixed layer, and every fill setting is global in
   the settings block — hatchAng plus a per-layer offset, hatchMin/hatchMax,
   one threshold slider each (hatchThr / crossThr / deepThr / texCirclesThr),
   texGroundPatternCenterX/Y — as is the texture (the General controls
   texOvershootOn, texOvershootMin, … plus per-layer copies suffixed
   _h1/_h2/_h3/_cr, with texIndividualOn saying which set applied). Each
   fill instance takes its own copy of those values, and its stack is
   rebuilt from whichever texture set applied, one entry per effect that
   was ON, in TEXTURE_FILTERS order — the old fixed pipeline order — so the
   migrated scene renders as it did.

   Version 2: `layers` is the instance array itself. Edge instances update
   the defaults by id; fill instances are taken as saved, in saved order.
   Files written between §4b and §4d hold the fill settings globally still,
   with only an angle offset and a threshold-slider name per instance
   (angleOffsetDeg / thrControl): a fill setting missing from the record is
   read back out of the settings block the same way version 1 does. */
const V1_TEXTURE_IDS = {
  trim:          { on:'texTrimOn',      params:{ value:'texTrimValue' } },
  overshoot:     { on:'texOvershootOn', params:{ min:'texOvershootMin', max:'texOvershootMax' } },
  spacingJitter: { on:'texSpacingOn',   params:{ min:'texSpacingMin', max:'texSpacingMax' } },
  angleJitter:   { on:'texAngleOn',     params:{ min:'texAngleMin', max:'texAngleMax' } },
  wobble:        { on:'texWobbleOn',    params:{ shared:'texWobbleShared', spacing:'texWobbleSpacing', amp:'texWobbleAmp', variation:'texWobbleVariation', varScale:'texWobbleVarScale' } },
  regularWobble: { on:'texRegWobbleOn', params:{ amp:'texRegWobbleAmp', wavelength:'texRegWobbleWavelength' } },
  gaps:          { on:'texGapsOn',      params:{ spacing:'texGapsSpacing', max:'texGapsMax' } },
};
// Values are coerced the way the old app read its controls: a checkbox is
// `!!value`; a number that doesn't parse becomes 0, so the reader's own
// `|| fallback` (readWobbleParams etc. in hatch-texture.js) lands on exactly
// the value the old `+el.value || fallback` read produced.
function v1TextureStack(settings, layerId, geometry){
  const suffix = settings.texIndividualOn ? '_' + layerId : '';
  const stack = [];
  for (const type in V1_TEXTURE_IDS){
    if (!filterSupports(type, geometry)) continue;
    const ids = V1_TEXTURE_IDS[type];
    if (!settings[ids.on + suffix]) continue;
    const entry = { type };
    for (const p of TEXTURE_FILTERS[type].params){
      const v = settings[ids.params[p.key] + suffix];
      entry[p.key] = p.kind === 'checkbox' ? !!v : (Number.isFinite(+v) ? +v : 0);
    }
    stack.push(entry);
  }
  return stack;
}
/* The fixed fill layers of a version-1 scene: each one's angle offset from
   the global Hatch angle, and the global threshold slider that was its
   "below". The same table reads a §4b/§4c version-2 file, which stored
   those two per instance (angleOffsetDeg / thrControl) and everything else
   globally. */
const V1_FILL = {
  h1: { angleOffset:0,  thr:'hatchThr' },
  h2: { angleOffset:90, thr:'crossThr' },
  h3: { angleOffset:45, thr:'deepThr' },
  cr: { angleOffset:0,  thr:'texCirclesThr' },
};
const GLOBAL_FILL_IDS = { minSpacing:'hatchMin', maxSpacing:'hatchMax', centerX:'texGroundPatternCenterX', centerY:'texGroundPatternCenterY' };
// One fill setting from a scene's global settings block, for a record that
// doesn't carry it: `legacy` is {angleOffset, thr} for this instance.
function globalFillSetting(spec, settings, legacy, T){
  const num = id => { const v = +settings[id]; return (id in settings) && Number.isFinite(v) ? v : null; };
  if (spec.key === 'angleDeg'){
    const base = num('hatchAng');
    return base === null ? spec.def : base + legacy.angleOffset;
  }
  if (spec.key === 'threshold'){
    const v = num(legacy.thr);
    // The old Circles read was `+value || 0.92`, so a missing or zero
    // slider meant 0.92; a hatch threshold read as a plain number.
    if (T.thrFallback) return v || T.thrFallback;
    return v === null ? spec.def : v;
  }
  const v = num(GLOBAL_FILL_IDS[spec.key]);
  return v === null ? spec.def : v;
}
// Fill settings for one saved record: its own values where it has them,
// else the scene's global controls (version 1, and version 2 before §4d).
function fillSettingsFor(rec, T, settings, id){
  const legacy = V1_FILL[id] || { angleOffset: Number.isFinite(+rec.angleOffsetDeg) ? +rec.angleOffsetDeg : 0, thr: rec.thrControl };
  const out = {};
  for (const spec of T.settings){
    const own = rec[spec.key];
    out[spec.key] = (own !== undefined && Number.isFinite(+own))
      ? clampSetting(spec, +own)
      : clampSetting(spec, globalFillSetting(spec, settings, legacy, T));
  }
  return out;
}
export function sceneLayers(data, resolvePen){
  const base = defaultLayers();
  const saved = data.layers;
  const settings = data.settings || {};
  if (data.penumbraScene >= 2 && Array.isArray(saved)){
    const out = base.filter(L => layerType(L).kind === 'edge');
    for (const s of saved){
      if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !LAYER_TYPES[s.type]) continue;
      const T = LAYER_TYPES[s.type];
      if (T.kind === 'edge'){
        const L = out.find(e => e.id === s.id && e.type === s.type);
        if (!L) continue;
        L.on = !!s.on; L.pen = resolvePen(s, L.pen);
        if (typeof s.dash === 'string') L.dash = s.dash;
        L.texture = sanitizeStack(s.texture, null);
        continue;
      }
      if (out.some(e => e.id === s.id)) continue;
      out.push(Object.assign(
        newFillLayer(s.type, s.id, { on: !!s.on, pen: resolvePen(s, T.pen), dash: typeof s.dash === 'string' ? s.dash : 'solid' }),
        fillSettingsFor(s, T, settings, s.id),
        { texture: sanitizeStack(s.texture, T.geometry) }));
    }
    noteFillIds(out);
    return out;
  }
  const byKey = (saved && typeof saved === 'object') ? saved : {};
  for (const L of base){
    const st = byKey[L.id];
    if (st && typeof st === 'object'){
      L.on = !!st.on;
      L.pen = resolvePen(st, L.pen);
      // A record without a dash rendered solid in the old app (its <select>
      // matched no option).
      L.dash = typeof st.dash === 'string' ? st.dash : 'solid';
    }
    const T = layerType(L);
    if (T.kind !== 'fill') continue;
    Object.assign(L, fillSettingsFor({}, T, settings, L.id));
    L.texture = v1TextureStack(settings, L.id, T.geometry);
  }
  return base;
}
