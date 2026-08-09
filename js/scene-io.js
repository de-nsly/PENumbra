/* ================================================================
   scene-io.js — everything that reads/writes files
   The worker message dispatcher (routes 'loaded' -> onLoaded in
   viewport3d.js, 'result' -> onResult in svg-export.js), STL/OBJ
   file loading (drag-drop + file picker + Z-up toggle), .pen scene
   save/load (base64 model embedding + settings/layers/camera
   round-trip), and the final boot call that builds the demo scene.
   Load this file LAST — its last line kicks off the app.
   ================================================================ */
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
  } else if (m.type === 'testShadingSampleResult'){
    // Phase 2 validation — see testShadingBufferRoundTrip in panel-controls.js
    if (!pendingShadingTestReference){
      console.warn('[shadingTest] got a result with no pending reference — ignoring');
    } else {
      const { reference } = pendingShadingTestReference;
      pendingShadingTestReference = null;
      let allMatch = true;
      reference.forEach((ref, i) => {
        const got = m.values[i];
        const brightDiff = Math.abs(ref.brightness - got.brightness);
        const match = brightDiff < 1e-4 && ref.hasGeometry === got.hasGeometry;
        if (!match) allMatch = false;
        console.log('[shadingTest] point ' + i + ': reference=' + ref.brightness.toFixed(5) +
          ' worker=' + got.brightness.toFixed(5) + ' diff=' + brightDiff.toExponential(2) +
          ' hasGeometry ref=' + ref.hasGeometry + ' worker=' + got.hasGeometry +
          (match ? ' \u2713' : ' \u2717 MISMATCH'));
      });
      console.log(allMatch
        ? '[shadingTest] ALL POINTS MATCH \u2014 transfer + flip + sampleShading are all correct.'
        : '[shadingTest] MISMATCH FOUND \u2014 see above for which point(s) disagree.');
    }
  } else if (m.type === 'error'){
    busy = false; $('genBtn').disabled = false;
    $('paperPane').classList.remove('busy');
    $('statusL').textContent = 'error: ' + m.msg;
  }
};

/* ================= debug: raw edges export =================
   Bypasses almost the entire solver — see generateRawEdges in the worker.
   Two variants, both triggered from the same computation: raw solver-px
   coordinates (viewBox matches the 3D viewport's own pixel dimensions),
   or aligned to the exact same paper transform a regular export uses, so
   it can be directly overlaid against one for comparison. */
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
  const dStr = d.join(' ');
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
    filename = modelName.replace(/\.(stl|obj)$/i, '') + '-debug-raw-paper.svg';
  } else {
    svgStr = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + m.w + ' ' + m.h + '">' +
      '<path d="' + dStr + '" fill="none" stroke="#000" stroke-width="1"/>' +
      '</svg>';
    filename = modelName.replace(/\.(stl|obj)$/i, '') + '-debug-raw.svg';
  }
  const blob = new Blob([svgStr], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  $('statusL').textContent = 'exported raw edges (' + (segs.length/4) + ' segments)';
}
$('debugRawEdgesRawBtn').addEventListener('click', () => triggerDebugRawEdgesExport('raw'));
$('debugRawEdgesPaperBtn').addEventListener('click', () => triggerDebugRawEdgesExport('paper'));

/* ================= debug: Silhouette vs Individual pre-dedup overlay =================
   Exports the raw so/iv geometry EXACTLY as computed, before subtractCovered
   (or anything else) touches it — so (black) and iv (red), overlaid in one
   file, at full opacity so any actual divergence is directly visible rather
   than inferred from what survives the dedup cascade. Answers directly:
   are these two layers' raw geometry actually identical, or do they
   genuinely differ somewhere? Reads straight off lastGen (set in onResult),
   since debugPreDedupSo/Iv ride along in every normal generate() result. */
function exportSoIvOverlayNow(){
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
  const blob = new Blob([svgStr], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = modelName.replace(/\.(stl|obj)$/i, '') + '-debug-so-vs-iv.svg';
  a.click();
  URL.revokeObjectURL(a.href);
  $('statusL').textContent = 'exported so/iv overlay (so: ' + (so.length/4) + ' segs, iv: ' + (iv.length/4) + ' segs)';
}
let pendingSoIvExport = false;
$('debugSoIvOverlayBtn').addEventListener('click', () => {
  if (!modelMesh){ $('statusL').textContent = 'load a model first'; return; }
  if (lastGen && lastGen.debugPreDedupSo){ exportSoIvOverlayNow(); return; }
  pendingSoIvExport = true;
  doGenerate();
});


$('loadBtn').addEventListener('click', () => $('fileInput').click());
for (const [wrap, btn] of [['zUpWrap','zUpBtn'], ['autoWrap','autoGenBtn']])
  $(wrap).addEventListener('click', e => { if (e.target !== $(btn)) $(btn).click(); });
// Single entry point for "the user handed us a file" — file picker and drag-drop
// both funnel through this, and it's just a filename sniff: .pen goes to the
// scene importer, everything else goes down the usual STL/OBJ mesh-load path.
function openDroppedFile(file){
  if (/\.pen$/i.test(file.name)) importScene(file);
  else loadFile(file);
}
$('fileInput').addEventListener('change', e => {
  if (e.target.files[0]) openDroppedFile(e.target.files[0]);
  e.target.value = '';
});
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

/* ================= scene export / import (.pen) =================
   Captures everything needed to reproduce the current view exactly: the
   model itself (the original uploaded file's bytes, not the parsed/welded
   mesh — re-importing re-runs the same load path a fresh upload would, so
   any future change to that pipeline can't drift the two apart), every
   [data-regen] control plus the paper layout controls (which aren't
   solve-affecting but are still part of "what I had"), the per-layer pen
   styling, and the camera (orbit angles/distance/target + projection mode —
   FOV rides along as an ordinary [data-regen] control already).
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
// every plain id→value/checked control worth restoring: all solve settings
// (data-regen) plus the paper layout controls, which live outside that
// mechanism (their own listener re-lays-out the page rather than staling it)
function sceneSettingIds(){
  return [...document.querySelectorAll('[data-regen]')].map(el => el.id)
    .concat(['paperSize', 'orient', 'marginMm', 'marginIndependent', 'marginTopMm', 'marginBottomMm', 'marginLeftMm', 'marginRightMm', 'pageColor'])
    .concat(DASH_KEYS.flatMap(k => [0,1,2,3,4,5].map(i => 'dash' + k + '_' + i)));
}

$('exportSceneBtn').addEventListener('click', () => {
  if (!modelMesh){ $('statusL').textContent = 'load a model first'; return; }
  const settings = {};
  for (const id of sceneSettingIds()){
    const el = document.getElementById(id);
    if (el) settings[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  const layers = {};
  for (const L of LAYERS){
    const els = layerEls[L.key];
    layers[L.key] = { on: els.chk.checked, color: els.col.value, width: +els.wid.value, dash: els.dash.value };
  }
  const camState = {
    theta: orbit.theta, phi: orbit.phi, radius: orbit.radius,
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
  const scene = { penumbraScene: 1, model: modelField, camera: camState, settings, layers,
    dashKeys: DASH_KEYS.slice(), savedViews, savedViewCounter, blocks: blocksOut, blockCounter };
  const blob = new Blob([JSON.stringify(scene)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const base = (lastFileData ? lastFileData.name.replace(/\.(stl|obj)$/i, '') : modelName)
    .replace(/[^\w.-]+/g, '_');
  a.download = base + '.pen';
  a.click();
  URL.revokeObjectURL(a.href);
  $('statusL').textContent = 'exported scene';
});

// Applying a scene sets DOM properties directly (not the same as a user
// typing/dragging), which does NOT dispatch input/change events — so every
// side effect those events would normally trigger has to be called
// explicitly here, once, after all the values are in place.
function applyImportedScene(data){
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
    if (el.dataset.regen !== undefined) refreshValLabel(el);
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
  // texIndividualOn's checked state was just set directly above (no event
  // dispatched), so the tab-visibility/layer-tab-filter logic that
  // normally reacts to toggling it needs an explicit nudge here too.
  if (typeof syncIndividualMode === 'function') syncIndividualMode();
  if (typeof updateTexLayerTabVisibility === 'function') updateTexLayerTabVisibility();
  for (const L of LAYERS) applyLayerStyle(L.key);
  for (const [key, st] of Object.entries(data.layers || {})){
    const els = layerEls[key];
    if (!els || !st) continue;
    els.chk.checked = !!st.on;
    els.col.value = st.color;
    els.wid.value = fmtWidth(+st.width);
    els.dash.value = st.dash;
    applyLayerStyle(key);
  }
  const cs = data.camera || {};
  setProjMode(cs.ortho ? 'ortho' : 'persp');
  if (Number.isFinite(cs.theta))  orbit.theta  = cs.theta;
  if (Number.isFinite(cs.phi))    orbit.phi    = cs.phi;
  if (Number.isFinite(cs.radius)) orbit.radius = cs.radius;
  if (Array.isArray(cs.target))   orbit.target.set(cs.target[0], cs.target[1], cs.target[2]);
  orbit.apply();                 // also updates the frustum for the restored FOV/ortho state
  syncShadowUI(); syncSoftShadowsUI(); syncShadowCasting(); syncGroundCatcher();
  updateLight(); updateLightGizmo(); updateModelRotation();
  // Setting smoothShading's .checked directly (like every control above)
  // doesn't fire its own 'change' listener, which is what actually swaps
  // the 3D viewport's geometry between the flat and smooth normal
  // attributes (see applySmoothShadingToggle in viewport3d.js) — without
  // this, an imported scene with Smooth shading on generates correctly
  // (the worker reads the checkbox's now-correct .checked state fresh)
  // but the live viewport keeps showing flat shading until the user
  // manually toggles the checkbox off and back on.
  if (typeof applySmoothShadingToggle === 'function') applySmoothShadingToggle();
  // Same reasoning — the coarse gate row's visibility is also driven by
  // smoothShading's 'change' listener, which setting .checked directly
  // doesn't fire either.
  if (typeof syncCoarseGateVisibility === 'function') syncCoarseGateVisibility();
  // Same reasoning as smoothShading just above — marginIndependent's
  // .checked was just set directly too, which won't fire the 'change'
  // listener that shows/hides the right margin inputs and recomputes the
  // paper layout for the newly-restored mode.
  if (typeof syncMarginMode === 'function') syncMarginMode();
  // Same reasoning again — pageColor's .value was just set directly by the
  // generic loop above, which doesn't fire its own 'input' listener (the
  // thing that actually pushes the value into the --paper CSS variable).
  if (typeof applyPageColor === 'function') applyPageColor();
  // Same reasoning again — smoothAngleDeg's .value was just set directly by
  // the generic loop above too, which won't trigger the worker round-trip
  // that recomputes the corner normals for the newly-restored angle.
  if (typeof applySmoothAngleChange === 'function') applySmoothAngleChange();
  // Older .pen files predate the Saved Views feature — default to an empty
  // list and a fresh counter rather than failing on the missing fields.
  savedViews = Array.isArray(data.savedViews) ? data.savedViews : [];
  savedViewCounter = Number.isFinite(data.savedViewCounter) ? data.savedViewCounter : 0;
  renderSavedViews();
  // Same fallback for layout blocks (a later addition than Saved Views).
  // A scene import always REPLACES the block list wholesale (unlike loading
  // a bare STL/OBJ, which leaves existing blocks alone) — so the outgoing
  // blocks' own persistent DOM (see createBlockDom's PERFORMANCE ARCHITECTURE
  // comment up top) and any selection referencing them must be torn down
  // explicitly here. Just reassigning `blocks` would orphan their <g> trees
  // in #layoutBlocksLayer forever: renderLayoutCanvas only ever creates DOM
  // for blocks that lack one, it never removes DOM for blocks no longer in
  // the array, leaving stale shapes visible but unselectable/undeletable.
  clearSelection();
  closeLayerContextMenu();
  for (const b of blocks) removeBlockDom(b);
  blocks = Array.isArray(data.blocks) ? data.blocks : [];
  blockCounter = Number.isFinite(data.blockCounter) ? data.blockCounter : 0;
  renderBlocksList();
  if (activeTab === 'layout') renderLayoutCanvas();
  resetPv();                     // new scene's content — fit the whole page, like a first-ever generate
}

let importingScene = false, pendingSceneRestore = null;
$('importSceneBtn').addEventListener('click', () => $('sceneFileInput').click());
$('sceneFileInput').addEventListener('change', e => {
  if (e.target.files[0]) importScene(e.target.files[0]);
  e.target.value = '';
});
async function importScene(file){
  $('statusL').textContent = 'importing ' + file.name + '…';
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (err){ $('statusL').textContent = 'invalid scene file'; return; }
  if (!data || data.penumbraScene !== 1 || !data.model){
    $('statusL').textContent = 'unrecognized scene file';
    return;
  }
  importingScene = true;
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

/* ================= SVG export =================
   Always the full paper page — same computePaperLayout() the preview uses —
   regardless of whatever pan/zoom window the user currently has on screen. */

/* ================= boot: demo scene ================= */
$('statusL').textContent = 'building demo scene…';
worker.postMessage({ type:'demo' });
