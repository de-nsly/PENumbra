/* ================================================================
   scene-io.js — everything that reads/writes files
   The worker message dispatcher (routes 'loaded' -> onLoaded in
   viewport3d.js, 'result' -> onResult in svg-export.js), STL/OBJ
   file loading (drag-drop + file picker + Z-up toggle), .pen scene
   save/load (base64 model embedding + settings/layers/pens/camera
   round-trip, migrating pre-pen-library scenes), and the demo-scene boot
   at the end of initSceneIO — app.js calls that init last, so it is the
   step that starts the app.
   ================================================================ */
import { $, APP_VERSION, DASH_KEYS, DASH_RATIOS, MAX_DASH_SLOTS, PEN_LIBRARY, downloadFile, penById, worker } from './main.js';
import { restoreHooks, sceneSettingIds } from './settings.js';
import { layerById, layers, replaceLayers, sceneLayers } from './layers.js';
import { camera, modelMesh, modelName, onLoaded, onSmoothAngleResult, orbit, orthoCam, renderSavedViews, savedViewCounter, savedViews, setSavedViews, setProjMode } from './viewport3d.js';
import { addDashSlot, applyLayerStyle, buildLayerRows, computePaperLayout, onResult, refreshDashPreview, refreshStatusR } from './svg-export.js';
import { activeTab, buildCamMessage, doGenerate, generateFailed, lastGen, refreshValLabel, syncLineLayerUI } from './panel-controls.js';
import { penIdCounter, refreshPenSelects, resolveOverridePen, resolvePen, setPenLibrary, splitDashChoice, syncPenLibraryUI } from './pen-library.js';
import { blockCounter, blocks, replaceBlocks, renderBlocksList, renderLayoutCanvas } from './layout-canvas.js';
import { resetPvFitWithRulers, updateTextureGizmo } from './paper-preview.js';
import { renderTextureStack } from './texture-stack.js';

// .pen format version this build writes. 1: layers as { key: {on, pen,
// dash} } and the texture as General/per-layer settings ids; 2: layers as
// the instance array with each layer's texture stack (layers.js —
// sceneLayers there loads both).
const SCENE_VERSION = 2;


/* ================= debug: raw edges export =================
   Bypasses almost the entire solver — see generateRawEdges in the worker.
   Two variants, both triggered from the same computation: raw solver-px
   coordinates (viewBox matches the 3D viewport's own pixel dimensions),
   or aligned to the exact same paper transform a regular export uses, so
   it can be directly overlaid against one for comparison. */
// Wraps one debug export's path data in an SVG for the given mode and
// downloads it as <model><suffix>.svg ('raw') or <model><suffix>-paper.svg
// ('paper'). Shared by the raw edges and raw contour edges exports.
function downloadDebugEdgesSvg(dStr, m, mode, suffix){
  let svgStr, filename;
  if (mode === 'paper'){
    const layout = computePaperLayout({ w: m.w, h: m.h });
    // Coordinates sit inside a scaling <g>, same as a regular export — stroke-width
    // needs the inverse of that scale to end up a consistent, visible mm width
    // rather than shrinking along with everything else inside the transform.
    const strokeW = (0.3 / Math.max(1e-6, layout.scale)).toFixed(3);
    svgStr = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + layout.paperW.toFixed(2) + 'mm" height="' + layout.paperH.toFixed(2) + 'mm" ' +
      'viewBox="0 0 ' + layout.paperW.toFixed(3) + ' ' + layout.paperH.toFixed(3) + '">' +
      '<g transform="translate(' + layout.offX.toFixed(3) + ',' + layout.offY.toFixed(3) + ') scale(' + layout.scale.toFixed(6) + ')">' +
      '<path d="' + dStr + '" fill="none" stroke="#000" stroke-width="' + strokeW + '"/>' +
      '</g></svg>';
    filename = modelName.replace(/\.(stl|obj)$/i, '') + suffix + '-paper.svg';
  } else {
    svgStr = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + m.w + ' ' + m.h + '">' +
      '<path d="' + dStr + '" fill="none" stroke="#000" stroke-width="1"/>' +
      '</svg>';
    filename = modelName.replace(/\.(stl|obj)$/i, '') + suffix + '.svg';
  }
  downloadFile(filename, svgStr, 'image/svg+xml');
}
let pendingDebugExportMode = null;   // 'raw' | 'paper' — set by whichever button was clicked
function triggerDebugRawEdgesExport(mode){
  if (!modelMesh){ $('statusL').textContent = 'load a model first'; return; }
  pendingDebugExportMode = mode;
  worker.postMessage({
    type: 'debugRawEdges',
    cam: buildCamMessage(),
    creaseDeg: +$('creaseDeg').value || 0,
  });
}
function handleDebugRawEdgesResult(m){
  const mode = pendingDebugExportMode;
  pendingDebugExportMode = null;
  const segs = m.segs;
  const d = [];
  for (let i=0; i<segs.length; i+=4){
    d.push('M', segs[i].toFixed(2), segs[i+1].toFixed(2), 'L', segs[i+2].toFixed(2), segs[i+3].toFixed(2));
  }
  downloadDebugEdgesSvg(d.join(' '), m, mode, '-debug-raw');
  $('statusL').textContent = 'exported raw edges (' + (segs.length/4) + ' segments)';
}

/* ================= debug: raw contour edges export =================
   Same two-variant pattern as the raw edges export above, but the worker
   selects edges via generateRawContourEdges — the Contour layer's own
   front/back topological test (isSilTopo in generate()), chained with the
   same buildEdgeChains walk generate() uses, with no occlusion, backdrop
   test, or dedup — so this isolates whether an issue is in that raw chain
   topology or later in the pipeline. m.chains is an array of flat
   [x0,y0,x1,y1,...] polylines, one per chain (or per camera-visible run
   within a chain — see generateRawContourEdges). */
let pendingDebugContourExportMode = null;   // 'raw' | 'paper'
function triggerDebugRawContourEdgesExport(mode){
  if (!modelMesh){ $('statusL').textContent = 'load a model first'; return; }
  pendingDebugContourExportMode = mode;
  worker.postMessage({
    type: 'debugRawContourEdges',
    cam: buildCamMessage(),
  });
}
function handleDebugRawContourEdgesResult(m){
  const mode = pendingDebugContourExportMode;
  pendingDebugContourExportMode = null;
  const chains = m.chains;
  const d = [];
  let nSegs = 0;
  for (const pts of chains){
    d.push('M', pts[0].toFixed(2), pts[1].toFixed(2));
    for (let i=2; i<pts.length; i+=2) d.push('L', pts[i].toFixed(2), pts[i+1].toFixed(2));
    nSegs += pts.length/2 - 1;
  }
  downloadDebugEdgesSvg(d.join(' '), m, mode, '-debug-raw-contour');
  $('statusL').textContent = 'exported raw contour edges (' + chains.length + ' chains, ' + nSegs + ' segments)';
}

/* ================= debug: Silhouette vs Individual pre-dedup overlay =================
   Exports the raw so/iv geometry EXACTLY as computed, before subtractCovered
   (or anything else) touches it — so (black) and iv (red), overlaid in one
   file, at full opacity so any actual divergence is directly visible rather
   than inferred from what survives the dedup cascade. The worker only
   includes debugPreDedupSo/Iv in a result when the generate request asked
   for them (settings.debugPreDedup, set from pendingSoIvExport in
   doGenerate), so the button triggers one such generate and exports from
   its result. */
export function exportSoIvOverlayNow(){
  const so = lastGen.debugPreDedupSo, iv = lastGen.debugPreDedupIv;
  const dFor = (segs) => {
    const d = [];
    for (let i=0; i<segs.length; i+=4)
      d.push('M', segs[i].toFixed(3), segs[i+1].toFixed(3), 'L', segs[i+2].toFixed(3), segs[i+3].toFixed(3));
    return d.join(' ');
  };
  const layout = computePaperLayout({ w: lastGen.w, h: lastGen.h });
  const strokeW = (0.25 / Math.max(1e-6, layout.scale)).toFixed(3);
  const svgStr = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + layout.paperW.toFixed(2) + 'mm" height="' + layout.paperH.toFixed(2) + 'mm" ' +
    'viewBox="0 0 ' + layout.paperW.toFixed(3) + ' ' + layout.paperH.toFixed(3) + '">' +
    '<g transform="translate(' + layout.offX.toFixed(3) + ',' + layout.offY.toFixed(3) + ') scale(' + layout.scale.toFixed(6) + ')">' +
    '<path d="' + dFor(so) + '" fill="none" stroke="#000000" stroke-width="' + strokeW + '"/>' +
    '<path d="' + dFor(iv) + '" fill="none" stroke="#ff0000" stroke-width="' + strokeW + '" stroke-opacity="0.6"/>' +
    '</g></svg>';
  downloadFile(modelName.replace(/\.(stl|obj)$/i, '') + '-debug-so-vs-iv.svg', svgStr, 'image/svg+xml');
  $('statusL').textContent = 'exported so/iv overlay (so: ' + (so.length/4) + ' segs, iv: ' + (iv.length/4) + ' segs)';
}
export let pendingSoIvExport = false;
// onResult (svg-export.js) asks whether the result it just received was the
// one this export requested; asking clears the flag.
export function takePendingSoIvExport(){ const v = pendingSoIvExport; pendingSoIvExport = false; return v; }

// Single entry point for "the user handed us a file" — file picker and drag-drop
// both funnel through this, and it's just a filename sniff: .pen goes to the
// scene importer, everything else goes down the usual STL/OBJ mesh-load path.
function openDroppedFile(file){
  if (/\.pen$/i.test(file.name)) importScene(file);
  else loadFile(file);
}
// Z-up import: STL/OBJ carry no up-axis; CAD exports (Rhino STL etc.) are
// usually Z-up while this app is Y-up internally. The toggle rotates files
// upright on import. We keep a copy of the last file so flipping the toggle
// re-imports in place — the posted buffer itself is transferred away.
let zUpImport = false, lastFileData = null;
async function loadFile(file){
  $('statusL').textContent = 'loading ' + file.name + '…';
  const buffer = await file.arrayBuffer();
  lastFileData = { name: file.name, buffer: buffer.slice(0) };
  worker.postMessage({ type:'load', name: file.name, buffer, zUp: zUpImport }, [buffer]);
}

/* ================= scene export / import (.pen) =================
   Captures everything needed to reproduce the current view exactly: the
   model itself (the original uploaded file's bytes, not the parsed/welded
   mesh — re-importing re-runs the same load path a fresh upload would, so
   any future change to that pipeline can't drift the two apart), every
   control in the settings registry (settings.js: the solve settings plus
   the paper layout controls, which aren't solve-affecting but are still
   part of "what I had"), the pen library, the layer instances (on/pen/
   dash and each layer's texture stack — layers.js), and the camera (orbit
   angles/distance/target + projection mode — FOV rides along as an
   ordinary registry control already).
   A plain JSON container, base64 for the binary model bytes — simple, and
   the model is the only part large enough for that ~33% inflation to
   matter, which is an acceptable trade for not inventing a binary format. */

function base64FromArrayBuffer(buf){
  let binary = '';
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;                      // avoid a giant single call to fromCharCode
  for (let i=0; i<bytes.length; i+=CHUNK)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i+CHUNK));
  return btoa(binary);
}
function base64ToArrayBuffer(b64){
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i=0; i<binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
// every plain id→value/checked control worth restoring: the settings
// registry (solve settings plus the paper layout controls) and the dash
// slot fields, which are a growable list rather than fixed controls
function savedSettingIds(){
  return sceneSettingIds()
    .concat(DASH_KEYS.flatMap(k => [0,1,2,3,4,5].map(i => 'dash' + k + '_' + i)));
}

// Applying a scene sets DOM properties directly (not the same as a user
// typing/dragging), which does NOT dispatch input/change events — so every
// side effect those events would normally trigger has to be called
// explicitly here, once, after all the values are in place: each settings
// entry names its own sync function (onRestore in settings.js), run below
// through restoreHooks(); the layer rows and the camera are handled here.
export function applyImportedScene(data){
  // Create any dash slots this scene needs (D3+) BEFORE the generic
  // settings-restore loop below, which relies on their DOM (dashD3_0 etc.)
  // already existing, and before layer dash values get restored, which
  // relies on the matching <option> already being in each select. DASH_KEYS
  // is always sequential/gapless (D1, D2, D3, ...), so just growing to the
  // same COUNT is enough — no need to match specific key names. Older
  // scenes (from before this existed) simply have no data.dashKeys, so
  // nothing happens here and D1/D2 (already present by default) cover them.
  const neededDashCount = (data.dashKeys || []).length;
  while (DASH_KEYS.length < neededDashCount && DASH_KEYS.length < MAX_DASH_SLOTS) addDashSlot();
  for (const [id, val] of Object.entries(data.settings || {})){
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!val; else el.value = val;
    refreshValLabel(el);   // no-op for a control without a value label
  }
  // The loop above only set each dash-field input's raw value — DASH_RATIOS
  // itself and the derived preview/layer rendering need an explicit sync.
  for (const key of DASH_KEYS){
    for (let i = 0; i < 6; i++){
      const el = document.getElementById('dash' + key + '_' + i);
      if (el) DASH_RATIOS[key][i] = Math.max(0, +el.value || 0);
    }
    refreshDashPreview(key);
  }
  // The pen library belongs to the scene — replace it wholesale. Scenes saved
  // before pens existed have no data.pens: setPenLibrary restarts from the
  // built-in set, and each layer's own color/width is matched into it below.
  setPenLibrary(data.pens, data.penIdCounter);
  // The layer instances (with their texture stacks) come from the file —
  // sceneLayers handles both format versions. Each layer's pen is resolved
  // here, into the library just installed: a saved pen id that still
  // exists is taken as is; an old scene's color/width is matched into the
  // library (resolvePen may append a pen), which must happen BEFORE the
  // rows' dropdowns are built, as a <select> can't take a value it has no
  // <option> for yet.
  replaceLayers(sceneLayers(data, (st, defaultPenId) =>
    (typeof st.pen === 'string' && PEN_LIBRARY.some(p => p.id === st.pen))
      ? st.pen
      : resolvePen({ color: st.color, width: st.width }, penById(defaultPenId))));
  buildLayerRows();
  refreshPenSelects();
  renderTextureStack();
  // The rows were just built from the instances, which fires no change
  // event, so the sliders that fade with their own layer group and the
  // Circles gizmo need the same explicit nudge the toggles above get.
  syncLineLayerUI();
  updateTextureGizmo();
  const cs = data.camera || {};
  setProjMode(cs.ortho ? 'ortho' : 'persp');
  if (Number.isFinite(cs.theta))  orbit.theta  = cs.theta;
  if (Number.isFinite(cs.phi))    orbit.phi    = cs.phi;
  if (Number.isFinite(cs.radius)) orbit.radius = cs.radius;
  // Fallback to 0 for scenes saved before exactPole was captured here — must
  // be reset explicitly rather than left alone, since a leftover pole-lock
  // from whatever view was active before the import would otherwise make
  // orbit.apply() below ignore the restored theta/phi entirely (see the
  // exactPole branch in orbit.apply, viewport3d.js).
  orbit.exactPole = Number.isFinite(cs.exactPole) ? cs.exactPole : 0;
  if (Array.isArray(cs.target))   orbit.target.set(cs.target[0], cs.target[1], cs.target[2]);
  orbit.apply();                 // also updates the frustum for the restored FOV/ortho state
  // Every control was set by assignment, so nothing above fired the
  // listeners that normally follow an edit: the shadow/margin/export UI
  // state, the three.js light, shadow flags, model rotation, the smooth-
  // shading geometry swap and its worker round-trip, the page colour, the
  // texture tab mode. Each entry in settings.js names what it needs.
  for (const fn of restoreHooks()) fn();
  // Older .pen files predate the Saved Views feature — default to an empty
  // list and a fresh counter rather than failing on the missing fields.
  setSavedViews(Array.isArray(data.savedViews) ? data.savedViews : [],
    Number.isFinite(data.savedViewCounter) ? data.savedViewCounter : 0);
  renderSavedViews();
  // Same fallback for layout blocks (a later addition than Saved Views). A
  // scene import always REPLACES the block list wholesale, unlike loading a
  // bare STL/OBJ, which leaves existing blocks alone — see replaceBlocks
  // (layout-canvas.js) for the DOM/selection teardown and id reassignment.
  replaceBlocks(Array.isArray(data.blocks) ? data.blocks : [],
    Number.isFinite(data.blockCounter) ? data.blockCounter : 0);
  // Override entries from before pens existed are {color, width, dash};
  // matched into the library the same way the layers above were. Newer ones
  // already hold a pen id from this very scene's library.
  for (const b of blocks){
    const src = (b.overrideStyle && typeof b.overrideStyle === 'object') ? b.overrideStyle : {};
    b.overrideStyle = {};
    for (const key in src){
      const ov = src[key];
      if (!layerById(key) || !ov || typeof ov !== 'object') continue;
      b.overrideStyle[key] = { pen: resolveOverridePen(ov, key, null), dash: ov.dash };
    }
  }
  syncPenLibraryUI();
  renderBlocksList();
  if (activeTab === 'layout') renderLayoutCanvas();
  refreshStatusR();
  resetPvFitWithRulers();        // new scene's content — fit the whole page, rulers included, like a first-ever generate
}

let pendingSceneRestore = null;   // the parsed .pen while its model loads in the worker
// onLoaded (viewport3d.js) asks for this once the model is in: a scene
// import restores camera + settings from the file instead of framing fresh.
export function takePendingSceneImport(){
  const data = pendingSceneRestore;
  pendingSceneRestore = null;
  return data;
}
// .pen files arrive through the same "Open STL / OBJ / PEN" button and
// drag-drop as meshes — openDroppedFile routes by extension.
async function importScene(file){
  $('statusL').textContent = 'importing ' + file.name + '…';
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (err){ $('statusL').textContent = 'invalid scene file'; return; }
  if (!data || !(data.penumbraScene >= 1 && data.penumbraScene <= SCENE_VERSION) || !data.model){
    $('statusL').textContent = 'unrecognized scene file';
    return;
  }
  pendingSceneRestore = data;
  if (data.model.demo){
    lastFileData = null;
    worker.postMessage({ type:'demo' });
  } else {
    zUpImport = !!data.model.zUp;
    $('zUpBtn').setAttribute('aria-checked', String(zUpImport));
    $('zUpBtn').classList.toggle('active', zUpImport);
    const buffer = base64ToArrayBuffer(data.model.dataB64);
    lastFileData = { name: data.model.name, buffer: buffer.slice(0) };
    worker.postMessage({ type:'load', name: data.model.name, buffer, zUp: zUpImport }, [buffer]);
  }
}

/* ================= optional debug tools =================
   js/debug/*.js hold console-only diagnostics that are never needed in
   normal use. Adding ?debug to the URL loads them. */

/* ================= init =================
   Everything above only declares. This wires the DOM and starts the
   module's live behaviour — called once by app.js, in script order. */
export function initSceneIO(){
  worker.onmessage = ev => {
    const m = ev.data;
    if (m.type === 'progress'){
      $('progressBar').style.width = (m.v * 100).toFixed(1) + '%';
    } else if (m.type === 'loaded'){
      onLoaded(m);
    } else if (m.type === 'result'){
      onResult(m);
    } else if (m.type === 'smoothAngleResult'){
      onSmoothAngleResult(m);
    } else if (m.type === 'debugRawEdgesResult'){
      handleDebugRawEdgesResult(m);
    } else if (m.type === 'debugRawContourEdgesResult'){
      handleDebugRawContourEdgesResult(m);
    } else if (m.type === 'error'){
      generateFailed(m.msg);
    }
  };
  $('debugRawEdgesRawBtn').addEventListener('click', () => triggerDebugRawEdgesExport('raw'));
  $('debugRawEdgesPaperBtn').addEventListener('click', () => triggerDebugRawEdgesExport('paper'));
  $('debugRawContourEdgesRawBtn').addEventListener('click', () => triggerDebugRawContourEdgesExport('raw'));
  $('debugRawContourEdgesPaperBtn').addEventListener('click', () => triggerDebugRawContourEdgesExport('paper'));
  $('debugSoIvOverlayBtn').addEventListener('click', () => {
    if (!modelMesh){ $('statusL').textContent = 'load a model first'; return; }
    if (lastGen && lastGen.debugPreDedupSo){ exportSoIvOverlayNow(); return; }
    pendingSoIvExport = true;
    doGenerate();
  });
  $('loadBtn').addEventListener('click', () => $('fileInput').click());
  for (const [wrap, btn] of [['zUpWrap','zUpBtn'], ['autoWrap','autoGenBtn'], ['addToLayoutSaveViewWrap','addToLayoutSaveViewBtn']])
    $(wrap).addEventListener('click', e => { if (e.target !== $(btn)) $(btn).click(); });
  $('fileInput').addEventListener('change', e => {
    if (e.target.files[0]) openDroppedFile(e.target.files[0]);
    e.target.value = '';
  });
  $('zUpBtn').addEventListener('click', () => {
    zUpImport = !zUpImport;
    $('zUpBtn').setAttribute('aria-checked', String(zUpImport));
    $('zUpBtn').classList.toggle('active', zUpImport);
    if (lastFileData){                       // re-import the loaded file in the new convention
      $('statusL').textContent = 'reloading ' + lastFileData.name + '…';
      const buffer = lastFileData.buffer.slice(0);
      worker.postMessage({ type:'load', name: lastFileData.name, buffer, zUp: zUpImport }, [buffer]);
    }
  });
  window.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  window.addEventListener('drop', e => {
    e.preventDefault(); document.body.classList.remove('dragging');
    if (e.dataTransfer.files[0]) openDroppedFile(e.dataTransfer.files[0]);
  });
  $('exportSceneBtn').addEventListener('click', () => {
    if (!modelMesh){ $('statusL').textContent = 'load a model first'; return; }
    const settings = {};
    for (const id of savedSettingIds()){
      const el = document.getElementById(id);
      if (el) settings[id] = el.type === 'checkbox' ? el.checked : el.value;
    }
    // While "Export one path per pen" is on, Split dashes is only shown ticked
    // (see syncPenPathsExportUI) — save the user's own choice instead.
    settings.splitDashBtn = splitDashChoice;
    // The layer instances as they are, texture stacks included (a deep
    // copy, so nothing in the file aliases live state).
    const layersOut = layers.map(L => ({ ...L, texture: L.texture.map(f => ({ ...f })) }));
    const camState = {
      theta: orbit.theta, phi: orbit.phi, radius: orbit.radius,
      exactPole: orbit.exactPole,
      target: [orbit.target.x, orbit.target.y, orbit.target.z],
      ortho: camera === orthoCam,
    };
    // demo scene has no uploaded bytes to embed — re-import just rebuilds it
    // the same procedural way the app does on first boot
    const modelField = lastFileData
      ? { name: lastFileData.name, zUp: zUpImport, dataB64: base64FromArrayBuffer(lastFileData.buffer) }
      : { demo: true };
    // Each block carries a live .dom reference (its persistent SVG nodes —
    // see layout-canvas.js) once it's actually been rendered; JSON.stringify
    // on a DOM node throws (circular structure), so it must be stripped here,
    // not carried through into the saved file at all — it's rebuilt fresh on
    // import anyway (renderLayoutCanvas hydrates DOM for any block missing it).
    const blocksOut = blocks.map(({ dom, ...rest }) => rest);
    const scene = { penumbraScene: SCENE_VERSION, appVersion: APP_VERSION, savedAt: new Date().toISOString(),
      model: modelField, camera: camState, settings, layers: layersOut,
      pens: PEN_LIBRARY.map(p => ({ ...p })), penIdCounter,
      dashKeys: DASH_KEYS.slice(), savedViews, savedViewCounter, blocks: blocksOut, blockCounter };
    const base = (lastFileData ? lastFileData.name.replace(/\.(stl|obj)$/i, '') : modelName)
      .replace(/[^\w.-]+/g, '_');
    downloadFile(base + '.pen', JSON.stringify(scene), 'application/json');
    $('statusL').textContent = 'exported scene';
  });
  /* ================= boot: demo scene ================= */
  $('statusL').textContent = 'building demo scene…';
  worker.postMessage({ type:'demo' });
  if (new URLSearchParams(location.search).has('debug')) import('./debug/shading-diagnostics.js');
}
