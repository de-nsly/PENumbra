/* ================================================================
   layers.js — the layer model
   Every drawing layer is an INSTANCE in `layers`, ordered highest
   priority first:
     - UI row order, top to bottom
     - cross-layer ink-avoidance (a lower layer never re-strokes what an
       enabled higher layer already covers — see the cascade in the
       worker's generate())
     - paint order in the SVG: onResult walks this list in REVERSE so the
       highest-priority layer (Silhouette) ends up painted last/on top.
   Toggling any layer re-runs the whole pipeline: the cascade means one
   layer's on/off changes which ink survives in every layer below it, so
   there is no display-only toggle.

   Instance shape: { id, type, name, on, pen, dash, texture }
     id       the persisted key: layer groups in a result (m.groups[id]),
              Layout block layerPaths/layerVisible/overrideStyle, the row
              DOM (layerEls[id]), the SVG group g_<id>. Edge layers are
              singletons whose id is their type; fill instances have ids
              h1 h2 h3 cr today (kept for old files) and fresh ids later.
     type     a key of LAYER_TYPES
     on/pen/dash   the row's state — the instance IS the state, the row
              DOM (svg-export.js) is a view of it
     texture  the ordered texture stack: [{ type, ...params }] with types
              from TEXTURE_FILTERS. Empty = no texture. Only fill layers
              apply theirs today (onResult); edge layers carry [].
     angleOffsetDeg   hatch instances only, TRANSITIONAL: the offset
              added to the global Hatch angle slider (0 / 90 / 45 for the
              classic Hatch / Crosshatch / Deep shadow). Becomes an
              absolute per-instance angleDeg once fill settings move onto
              the instance (refactor plan §4d).
     thrControl   fill instances only, TRANSITIONAL: the id of the global
              "below" threshold slider this instance follows (hatchThr /
              crossThr / deepThr / texCirclesThr). Becomes a per-instance
              threshold value in §4d, whose loader reads it from the
              settings block through this id.

   Layer keys, for reading old code and .pen files: so = Silhouette,
   iv/ih = Silhouette individual visible/hidden, sv/sh = Contour
   visible/hidden (historically "silhouette"), cv/ch = Crease visible/
   hidden, h1/h2/h3 = Hatch/Crosshatch/Deep shadow, cr = Circles.

   Pure data: imports nothing, touches no DOM — tools/harness uses it
   headlessly, and sceneLayers() is the loader for both the app and the
   harness.
   ================================================================ */

/* chain — how onResult joins an edge layer's worker segments into paths:
   'silhouette' (buildChainedPathD), 'contour' (appendContourPathD, by
   the worker's run identity), 'crease' (appendCreasePathD).
   geometry — what a fill layer's pieces are, which decides which texture
   filters apply: 'lines' (hatch strokes) or 'arcs' (circle pieces).
   host — the container in index.html the row is appended to; the edge
   layers are split across three so each group's solve settings can sit
   directly under the rows they affect. */
export const LAYER_TYPES = {
  so: { kind:'edge', name:'Silhouette',            chain:'silhouette', host:'edgeLayersSil' },
  iv: { kind:'edge', name:'Silhouette individual', chain:'silhouette', host:'edgeLayersSil' },
  ih: { kind:'edge', name:'· hidden',              chain:'silhouette', host:'edgeLayersSil' },
  sv: { kind:'edge', name:'Contour',               chain:'contour',    host:'edgeLayersContour' },
  sh: { kind:'edge', name:'· hidden',              chain:'contour',    host:'edgeLayersContour' },
  cv: { kind:'edge', name:'Crease',                chain:'crease',     host:'edgeLayersCrease' },
  ch: { kind:'edge', name:'· hidden',              chain:'crease',     host:'edgeLayersCrease' },
  hatch:   { kind:'fill', name:'Hatch',   geometry:'lines', host:'hatchLayers', pen:'p5', thrControl:'hatchThr' },
  // thrFallback: the threshold used when the slider holds no number (Circles
  // always had one; Hatch reads an empty value as 0).
  circles: { kind:'fill', name:'Circles', geometry:'arcs',  host:'hatchLayers', pen:'p5', thrControl:'texCirclesThr', thrFallback:0.92 },
};
// The global threshold sliders a fill instance's thrControl may name.
const THR_CONTROLS = ['hatchThr', 'crossThr', 'deepThr', 'texCirclesThr'];

// pen → the DEFAULT pen id (see PEN_LIBRARY in main.js) the row starts on.
// A layer has no colour/width of its own, only a pen reference.
export function defaultLayers(){
  return [
    { id:'so', type:'so', name:'Silhouette',            on:false, pen:'p1', dash:'solid', texture:[] },
    { id:'iv', type:'iv', name:'Silhouette individual', on:false, pen:'p2', dash:'solid', texture:[] },
    { id:'ih', type:'ih', name:'· hidden',              on:false, pen:'p4', dash:'D1',    texture:[] },
    { id:'sv', type:'sv', name:'Contour',               on:true,  pen:'p2', dash:'solid', texture:[] },
    { id:'sh', type:'sh', name:'· hidden',              on:false, pen:'p4', dash:'D1',    texture:[] },
    { id:'cv', type:'cv', name:'Crease',                on:true,  pen:'p3', dash:'solid', texture:[] },
    { id:'ch', type:'ch', name:'· hidden',              on:false, pen:'p4', dash:'D1',    texture:[] },
    { id:'h1', type:'hatch',   name:'Hatch',       on:true,  pen:'p5', dash:'solid', angleOffsetDeg:0,  thrControl:'hatchThr', texture:[] },
    { id:'h2', type:'hatch',   name:'Crosshatch',  on:true,  pen:'p5', dash:'solid', angleOffsetDeg:90, thrControl:'crossThr', texture:[] },
    { id:'h3', type:'hatch',   name:'Deep shadow', on:false, pen:'p5', dash:'solid', angleOffsetDeg:45, thrControl:'deepThr',  texture:[] },
    { id:'cr', type:'circles', name:'Circles',     on:false, pen:'p5', dash:'solid', thrControl:'texCirclesThr', texture:[] },
  ];
}
// The live list. Mutated in place (like PEN_LIBRARY/DASH_KEYS), never
// reassigned, so every module's imported binding stays valid.
export const layers = defaultLayers();
export function replaceLayers(list){ layers.splice(0, layers.length, ...list); }
export function layerById(id){ return layers.find(L => L.id === id); }
export function layerType(L){ return LAYER_TYPES[L.type]; }
export function fillLayers(){ return layers.filter(L => layerType(L).kind === 'fill'); }

/* ================= texture filters =================
   The schema of every texture effect a fill layer's stack can hold: its
   parameters (with the slider ranges and defaults the stack editor uses,
   and the fallback the reader uses for a missing value) and which
   geometry kinds it applies to. The implementations live with the rest
   of the geometry code in svg-export.js (the applyHatch… and applyCircle… functions),
   keyed by these same type names. Key order here is the order the fixed
   pipeline in onResult applies them in — and the order a version-1 scene's
   enabled effects are migrated into a stack. */
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
// The entry of one type in a stack, or null. One entry per type today:
// the fixed pipeline in onResult applies each effect once.
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

/* ================= scene loading =================
   sceneLayers(data, resolvePen) builds the instance list a .pen scene
   describes. resolvePen(saved, defaultPenId) turns a saved layer record's
   pen reference into a pen id of the current library (the app matches an
   old record's colour/width into the library; the harness takes the id).

   Version 1 (penumbraScene: 1): `layers` is { key: {on, pen|color+width,
   dash} } and the texture lives in the settings block as the General
   controls (texOvershootOn, texOvershootMin, …) plus per-layer copies
   with an _h1/_h2/_h3/_cr suffix; texIndividualOn said which set applied.
   Each fill instance's stack is rebuilt from whichever set applied, one
   entry per effect that was ON, in TEXTURE_FILTERS order — today's fixed
   pipeline order, so the migrated scene renders as it did. An absent
   control counts as off / at its default.

   Version 2: `layers` is the instance array itself. Edge instances update
   the defaults by id; the fill instances are taken as saved, in saved
   order. */
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
// `|| fallback` (readWobbleParams etc. in svg-export.js) lands on exactly
// the value the old `+el.value || fallback` read produced.
export function v1TextureStack(settings, layerId, geometry){
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
export function sceneLayers(data, resolvePen){
  const base = defaultLayers();
  const saved = data.layers;
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
      const L = { id: s.id, type: s.type, name: (typeof s.name === 'string' && s.name.trim()) ? s.name : T.name,
        on: !!s.on, pen: resolvePen(s, T.pen), dash: typeof s.dash === 'string' ? s.dash : 'solid' };
      if (s.type === 'hatch') L.angleOffsetDeg = Number.isFinite(+s.angleOffsetDeg) ? +s.angleOffsetDeg : 0;
      L.thrControl = THR_CONTROLS.includes(s.thrControl) ? s.thrControl : T.thrControl;
      L.texture = sanitizeStack(s.texture, T.geometry);
      out.push(L);
    }
    return out;
  }
  const settings = data.settings || {};
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
    if (T.kind === 'fill') L.texture = v1TextureStack(settings, L.id, T.geometry);
  }
  return base;
}
