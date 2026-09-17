/* ================================================================
   panel-controls.js — control panel wiring
   Preset-slider helpers (shadow budget / hatch cap ladders),
   staleness tracking (markStale/scheduleAuto/clearStale),
   gatherSettings() (reads every control into a plain settings
   object for the worker), the Generate/Auto-generate buttons, and
   the shadow/soft-shadow UI sync helpers.
   ================================================================ */
import { $, APP_VERSION, isFormControlTarget, positionSegPill, worker } from './main.js';
import { HATCH_CAP_PRESETS, SETTINGS, SHADOW_BUDGET_PRESETS, formatValue, settingById } from './settings.js';
import { camera, captureShadingBuffer, clearActiveView, lightVec, modelMesh, modelPivot, syncGroundCatcher, syncShadowCasting, updateLight, updateLightGizmo, updateModelRotation, vp } from './viewport3d.js';
import { layerType, layers } from './layers.js';
import { computePaperLayout, layerStyle, syncFillRowRanges, syncFillRowSoftState } from './svg-export.js';
import { updateTextureGizmo } from './paper-preview.js';
import { pendingSoIvExport } from './scene-io.js';

/* ================= settings / staleness ================= */
// shared by the live 'input' listener below AND scene import — a restored
// control's value has to be reflected in its val-span the same way a user
// dragging it would, just without an 'input' event to trigger it naturally.
// The value span's id is always "<id>Val" in the markup.
export function refreshValLabel(el){
  const v = $(el.id + 'Val');
  if (!v) return;
  const s = settingById(el.id);
  if (!s) return;
  v.textContent = formatValue(s, el.value);
}
/* ================= double-click-to-edit slider values =================
   Every slider's value span already goes through refreshValLabel above to
   format itself (a unit suffix, or — for the two preset-ladder sliders — a
   lookup through a small fixed list, both from the entry's registry
   fields in settings.js). This adds the reverse direction:
   double-click the span, edit the raw number in place (unit suffix
   stripped while editing, restored on commit), Enter or blur to commit,
   Escape to cancel. On commit the slider's real 'input' event is
   dispatched, so every existing side effect (regenerate, live 3D update,
   scene dirtying, etc) fires exactly as if the slider itself had been
   dragged — nothing about that pipeline needed to change.
   Deliberately excluded: Hatch cap and Shadow budget. Their slider value
   is an INDEX into an 8-entry preset list, not a continuous number, and an
   8-position ladder doesn't really have the "hard to land on an exact
   value" problem this feature exists to solve.
   Invalid (non-numeric) text reverts to the previous value with no
   change. A valid number outside the slider's range clamps to whichever
   boundary it's past, rather than reverting.
   `spec` is the slider's registry entry or a texture filter parameter
   (anything formatValue accepts); `span` its value label; `refresh` puts
   the current value back into the label. */
export function makeSliderValueEditable(rangeEl, span, spec, refresh){
  if (!span || spec.presets) return;      // preset ladders excluded — see comment above
  const unit = spec.unit || '';
  let editing = false, cancelled = false;
  function beginEdit(){
    if (editing) return;
    editing = true; cancelled = false;
    let raw = span.textContent;
    if (unit && raw.endsWith(unit)) raw = raw.slice(0, -unit.length);
    span.textContent = raw;
    span.contentEditable = 'true';
    span.spellcheck = false;
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function endEdit(){
    if (!editing) return;
    editing = false;
    span.contentEditable = 'false';
    if (!cancelled){
      const n = parseFloat(span.textContent);
      const min = +rangeEl.min, max = +rangeEl.max;
      // Invalid (non-numeric) input reverts with no change. A valid number
      // outside this slider's range clamps to whichever boundary it's
      // past, rather than reverting — e.g. typing something above max
      // sets the slider to max, and likewise for below min.
      if (Number.isFinite(n)){
        rangeEl.value = Math.min(max, Math.max(min, n));
        rangeEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    refresh();   // restores the unit suffix; also re-displays the true value if reverted
  }
  span.addEventListener('dblclick', beginEdit);
  span.addEventListener('blur', endEdit);
  span.addEventListener('keydown', e => {
    if (e.key === 'Enter'){ e.preventDefault(); span.blur(); }
    else if (e.key === 'Escape'){ cancelled = true; span.blur(); }
  });
}

/* ================= double-click-to-edit names (layer/view lists) =================
   Same pattern as the slider-value editor above: contenteditable toggled
   on demand, no visible box/border ever, Enter/blur commits, Escape
   cancels. Empty (or whitespace-only) input reverts to the previous name
   rather than allowing a blank one. onCommit is always called — on both
   the commit and the cancel/revert paths — with whichever name should end
   up showing; its job is to write that back into the underlying object
   and re-render the owning list, which is what correctly refreshes this
   span's text (and anything else derived from the name, like a selection-
   highlight dataset attribute) in one place rather than two separate code
   paths that could drift out of sync. */
export function makeNameEditable(span, getCurrentName, onCommit){
  let editing = false, cancelled = false;
  function beginEdit(e){
    if (e) e.stopPropagation();
    if (editing) return;
    editing = true; cancelled = false;
    span.contentEditable = 'true';
    span.spellcheck = false;
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function endEdit(){
    if (!editing) return;
    editing = false;
    span.contentEditable = 'false';
    const typed = span.textContent.trim();
    onCommit(!cancelled && typed ? typed : getCurrentName());
  }
  span.addEventListener('dblclick', beginEdit);
  span.addEventListener('blur', endEdit);
  span.addEventListener('keydown', e => {
    if (e.key === 'Enter'){ e.preventDefault(); span.blur(); }
    else if (e.key === 'Escape'){ cancelled = true; span.blur(); }
  });
}

let staleSeq = 0, genSeq = 0, autoTimer = null;
// 'preview' | 'layout'. While 'layout', the live 3D->SVG pipeline is fully
// paused — nothing in the 3D viewport (orbit, rotation sliders, light) is
// visible anyway, so there's no reason to keep regenerating on every change.
// See layout-canvas.js for the tab-switch handler that flips this and
// pauses/resumes accordingly (switching back to 'preview' calls markStale()
// once, to catch up on anything changed while paused).
export let activeTab = 'preview';
export function setActiveTab(tab){ activeTab = tab; }   // layout-canvas.js's tab switch
export function markStale(){
  if (activeTab !== 'preview') return;
  staleSeq++;
  $('paperPane').classList.add('stale');
  $('sheet').classList.add('stale');
  scheduleAuto();
}
export function scheduleAuto(){
  if (activeTab !== 'preview') return;
  if (!autoGenOn || !modelMesh || genSeq === staleSeq) return;
  clearTimeout(autoTimer);
  // debounce adapts to how long the last solve took, so heavy models don't thrash
  const wait = lastGen ? Math.min(2000, Math.max(280, lastGen.ms * 1.5)) : 280;
  autoTimer = setTimeout(() => { if (!busy) doGenerate(); }, wait);
}
export function clearStale(){
  $('paperPane').classList.remove('stale');
  $('sheet').classList.remove('stale');
}

/* The worker's fill passes: one descriptor per enabled fill layer, in layer
   order (the hatch cap is shared across hatch passes, so order matters).
     hatch   { id, type, angleDeg, thr }
     circles { id, type, thr, centerX, centerY }   (centre in worker px)
   Every value is the layer's own (layers.js); nothing is shared between
   passes except the segment cap. Spacing is authored in mm and converted
   here, as is the circles centre, which the user sets as an offset from
   the page centre and the solver wants in its own pixel space.
   thr is the layer's "below" threshold. Soft shadows off → 0 for every
   pass (unreachable since brightness is always >=0), disabling the ambient
   brightness-based bands while leaving Cast/Ground shadow fills (which
   don't go through this threshold) untouched; the layers' own values are
   left alone so re-enabling Soft shadows restores exactly what the user
   had. */
function fillPasses(layout, mmToPx){
  const soft = $('softShadows').checked;
  const out = [];
  for (const L of layers){
    const T = layerType(L);
    if (T.kind !== 'fill' || !L.on) continue;
    const pass = { id: L.id, type: L.type, thr: soft ? L.threshold : 0,
      minS: mmToPx(L.minSpacing), maxS: mmToPx(L.maxSpacing) };
    if (L.type === 'hatch') pass.angleDeg = L.angleDeg;
    else {
      pass.centerX = layout ? mmToPx(layout.paperW/2 + L.centerX - layout.offX) : L.centerX;
      pass.centerY = layout ? mmToPx(layout.paperH/2 + L.centerY - layout.offY) : L.centerY;
    }
    out.push(pass);
  }
  return out;
}
export function gatherSettings(){
  // Hatch spacing is authored in mm (it's paper space now that the preview is a
  // real page), but the solver only ever works in viewport-pixel space — convert
  // here, once, using the paper scale for the viewport size this generate call
  // will actually use, not whatever lastGen happens to hold.
  const layout = computePaperLayout({ w: vp.clientWidth, h: vp.clientHeight });
  const mmToPx = mm => layout ? mm / layout.scale : mm;
  return {
    watertight: $('watertight').checked,
    // Multipliers on the solver's own auto-computed, zoom-independent
    // dedup tolerances (see effOffTol/effGapTol in generate()) — 1.0 is
    // the original unscaled behavior. Kept as multipliers rather than raw
    // px so the zoom-invariance that tolerance is built on isn't
    // reintroduced as a bug by a user-facing absolute value.
    dedupOffMult: +$('dedupOffMult').value,
    dedupGapMult: +$('dedupGapMult').value,
    // Contour's backdrop depth-similarity tolerance (Lines section, "Cleanup").
    // The worker keeps its own literal default for whenever contourCleanup isn't a finite number, so a
    // scene saved before this control existed still solves identically.
    contourCleanup: +$('contourCleanup').value,
    // "Max hops": the surface-distance half of the same decision, composed onto the depth
    // test rather than replacing it: a depth-similar stretch is only dropped
    // if its backdrop is also within this many triangle steps across the
    // surface. Both halves are per-model aesthetic controls — see the block
    // comment on CONTOUR_DEPTH_SIMILAR_FRAC_WORLD in the worker.
    contourMaxHops: +$('contourMaxHops').value,
    smoothShading: $('smoothShading').checked,
    creaseDeg: +$('creaseDeg').value,
    light: lightVec(),
    // Edge layers' draw state, keyed by layer id — the full-hierarchy cascade
    // needs to know whether EVERY individual layer will actually put ink on
    // the page before using it to remove ink from a lower-priority layer.
    // Silhouette (so), Silhouette individual (iv/ih), and Contour (sv/sh) are
    // three fully independent layers (Blender's GROUP/INDIVIDUAL/NONE
    // silhouette filters, respectively).
    layerOn: Object.fromEntries(layers.filter(L => layerType(L).kind === 'edge').map(L => [L.id, L.on])),
    // One descriptor per ENABLED fill layer, in layer order (fillPasses).
    passes: fillPasses(layout, mmToPx),
    // All that is left shared by every fill pass: the segment cap, and
    // whether Soft shadows is on at all. softShadowsOn is sent explicitly
    // (not inferred from thr===0) so the worker can tell "soft shadows
    // genuinely off" apart from "a threshold just happens to be low" —
    // see castOnly / SHADOW_ONLY_THR at the top of generate().
    hatch: {
      softShadowsOn: $('softShadows').checked,
      cap: HATCH_CAP_PRESETS[+$('hatchCap').value],
    },
    shadow: { on: $('castShadows').checked,
      budget: SHADOW_BUDGET_PRESETS[+$('shadowBudget').value] },
    // off: fraction of the model's bounding RADIUS (size-relative, so the same
    // slider position means the same visual drop on any model scale)
    ground: { on: $('groundShadow').checked, off: +$('groundOff').value / 100 },
    // Flips the final on-mesh "draw ink" decision for Hatch/Crosshatch/Deep
    // shadow/Circles that Soft+Cast shadows would otherwise produce. Ground
    // shadow's own hatch/circles (off-mesh, on the paper) don't read this —
    // see the worker's ground-shadow code paths.
    invertShadows: $('invertShadows').checked,
    // The worker-px rectangle whose image, under computePaperLayout's own
    // contain-fit transform (page_mm = offX + px*scale), lands exactly on
    // the full margin-inset printable page — i.e. the inverse of that
    // transform, computed once here so the worker never needs to duplicate
    // the paper-layout math itself. Ground shadow's "invert" fill uses this
    // instead of [0,W]x[0,H] so it reaches the true page edges instead of
    // stopping at the (generally differently-proportioned) viewport
    // rectangle's own letterboxed footprint on the page. On whichever axis
    // the viewport already matches the page's available aspect ratio, this
    // reduces to exactly [0,W] or [0,H].
    invertPageBounds: (() => {
      const availW = Math.max(0.01, layout.paperW - layout.margin.left - layout.margin.right);
      const availH = Math.max(0.01, layout.paperH - layout.margin.top - layout.margin.bottom);
      const x0 = -(availW/layout.scale - vp.clientWidth) / 2;
      const y0 = -(availH/layout.scale - vp.clientHeight) / 2;
      return { x0, x1: x0 + availW/layout.scale, y0, y1: y0 + availH/layout.scale };
    })(),
    // Rotate-model panel: 3x3 rotation (column-major — matches THREE.Matrix4's
    // own element layout, so the worker's math lines up exactly with
    // modelPivot's) applied around the model's own center. The worker rotates
    // a COPY of its vertex/normal data by this once, at the top of generate(),
    // rather than folding it into the camera's view matrix — that would only
    // have fixed the main silhouette geometry (which goes through the
    // view-space cache) while leaving face-normal lighting and the
    // ground-shadow footprint (both of which read raw positions/normals
    // directly) silently using the un-rotated mesh. See modelPivot in
    // viewport3d.js for where this matrix comes from.
    modelRot: (() => {
      const e = modelPivot.matrix.elements;
      return [e[0],e[1],e[2], e[4],e[5],e[6], e[8],e[9],e[10]];
    })(),
  };
}

/* ================= generate ================= */
let busy = false;
export let lastGen = null;             // the worker's last 'result' message
// Called by onResult (svg-export.js) with the worker's result: releases the
// Generate button, records the result, and either clears the stale state or
// re-arms auto-generate if the view moved while solving.
export function generateFinished(m){
  busy = false; $('genBtn').disabled = false;
  $('paperPane').classList.remove('busy');
  $('progressBar').style.width = '0';
  lastGen = m;
  if (genSeq === staleSeq) clearStale();
  else scheduleAuto();               // view moved while solving — stays stale, auto retries
}
// The worker posted an error instead of a result.
export function generateFailed(msg){
  busy = false; $('genBtn').disabled = false;
  $('paperPane').classList.remove('busy');
  $('statusL').textContent = 'error: ' + msg;
}
// Records a result without the UI bookkeeping above (tools/harness).
export function setLastGen(m){ lastGen = m; }
let autoGenOn = true;                 // header toggle button; checked/pressed by default
// Ground shadow's plane offset only makes sense with its own toggle on;
// shadow budget only bounds Cast shadow's sampling, so only that toggle
// matters for it (see the function body below).
export function syncShadowUI(){
  $('groundOffCtl').classList.toggle('ctlDisabled', !$('groundShadow').checked);
  // budget only bounds the light-space point-sampling used for object
  // self-shadow — Ground shadow is analytic (no sampling, no budget), so
  // the control is meaningless while Cast shadows is off
  $('shadowBudgetCtl').classList.toggle('ctlDisabled', !$('castShadows').checked);
  // With Soft, Cast, and Ground shadows all off there's nothing left for
  // Invert shadows to invert (the worker's own meshInvertActive/GS gating
  // already makes it a no-op in that case) — disable it too so the UI
  // doesn't suggest a dormant toggle does something. Doesn't clear the
  // checkbox itself, so re-enabling any shadow type resumes exactly what
  // was set before, without needing to re-check it.
  const anyShadow = $('softShadows').checked || $('castShadows').checked || $('groundShadow').checked;
  $('invertShadowsRow').classList.toggle('ctlDisabled', !anyShadow);
  $('invertShadows').disabled = !anyShadow;
}
// The three Lines-section sliders that belong to one layer group each, faded
// out while that group draws nothing at all — the same treatment (and the same
// .ctlDisabled class) the shadow controls above get. Each condition mirrors
// the solver's own gate exactly, so a disabled slider is genuinely inert
// rather than merely hidden: Contour Cleanup and Max hops feed
// buildContourDrops, which does nothing unless layerOn.sv || layerOn.sh, and
// Crease angle is only read inside the worker's own `wantC` guard, which is
// this same cv || ch test on gatherSettings' layerOn.
//
// Never clears or rewrites a slider's value — re-enabling a layer resumes
// whatever was set before, exactly as syncShadowUI leaves Invert shadows
// alone. Called from three places, because layer checkboxes change in three
// ways: the user clicking one (svg-export.js's own change handler), a .pen
// scene restoring them by assignment (scene-io.js — assignment fires no
// change event), and here at load for the initial state.
export function syncLineLayerUI(){
  const contourOn = layerStyle('sv').on || layerStyle('sh').on;
  const creaseOn  = layerStyle('cv').on || layerStyle('ch').on;
  $('contourCleanupCtl').classList.toggle('ctlDisabled', !contourOn);
  $('contourMaxHopsCtl').classList.toggle('ctlDisabled', !contourOn);
  $('creaseDegCtl').classList.toggle('ctlDisabled', !creaseOn);
}
// A circles layer's Center X/Y are offsets from the page's own center, so
// the natural range is exactly half the page in each direction: reaching a
// slider's max/min lands exactly on the page edge, never beyond it. When the
// page size or orientation actually changes, each centre is reapplied as a
// fraction of the page's half-width/half-height (tracked via the last-seen
// paperW/paperH below), so a point 30% of the way to the edge stays 30% of
// the way to the edge on the new page — rescaling both up and down, not just
// clamping. 0,0 is the page centre by definition, so there is nothing to
// default away from. Called from renderPaper; the row sliders' own ranges
// are refreshed by syncFillRowRanges (svg-export.js).
let _gpLastPaperW = null, _gpLastPaperH = null;
export function updateGroundPatternSliderRange(){
  const layout = computePaperLayout();
  if (!layout) return;
  if (_gpLastPaperW !== null && (_gpLastPaperW !== layout.paperW || _gpLastPaperH !== layout.paperH)){
    const kx = _gpLastPaperW > 0 ? layout.paperW/_gpLastPaperW : 1;
    const ky = _gpLastPaperH > 0 ? layout.paperH/_gpLastPaperH : 1;
    for (const L of layers){
      if (L.type !== 'circles') continue;
      L.centerX *= kx;
      L.centerY *= ky;
    }
  }
  _gpLastPaperW = layout.paperW; _gpLastPaperH = layout.paperH;
  syncFillRowRanges();
}
// Soft shadows: the per-face ambient brightness bands that give gradual,
// soft-looking shading — distinct from Cast shadows / Ground shadow, which
// are hard, occlusion-based shadows and stay fully independent of this
// toggle. Turning it off grays out every fill layer's "below" slider and (in
// fillPasses) forces its effective value to 0 so no face qualifies for
// ambient hatching, without touching the layers' own stored values —
// turning Soft shadows back on restores them exactly.
export function syncSoftShadowsUI(){
  syncFillRowSoftState();
}
export function buildCamMessage(){
  camera.updateMatrixWorld(true);
  const view = new THREE.Matrix4().copy(camera.matrixWorld).invert();
  return {
    view: Array.from(view.elements),
    proj: Array.from(camera.projectionMatrix.elements),
    w: vp.clientWidth, h: vp.clientHeight, near: camera.near,
    ortho: !!camera.isOrthographicCamera,
  };
}
export function doGenerate(){
  if (busy || !modelMesh || activeTab !== 'preview') return;
  busy = true;
  genSeq = staleSeq;                 // snapshot: did the view change mid-solve?
  $('genBtn').disabled = true;
  $('paperPane').classList.add('busy');
  // Only captured when Smooth Shading is on, since Flat Shading never uses
  // this — no reason to pay for an extra render+readback pass otherwise.
  // Transferred, not copied, via postMessage's second argument — ownership
  // of the underlying buffer moves to the worker, which is fine since
  // captureShadingBuffer() always allocates a fresh Float32Array per call,
  // never reused elsewhere. Smooth Shading's Hatch and Circles (model-
  // surface rings) density decisions are driven entirely by this buffer.
  const transfer = [];
  let shadingBuffer = null;
  if ($('smoothShading').checked){
    const cap = captureShadingBuffer();
    if (cap){ shadingBuffer = cap; transfer.push(cap.pixels.buffer); }
  }
  const settings = gatherSettings();
  // The "Silhouette vs Individual (pre-dedup)" debug export (scene-io.js)
  // needs the worker's raw so/iv geometry too; everything else skips the
  // extra copies.
  settings.debugPreDedup = pendingSoIvExport;
  worker.postMessage({
    type: 'generate',
    cam: buildCamMessage(),
    settings,
    shadingBuffer,
  }, transfer);
}

/* ================= H: hide/show floating panels =================
   Toggles both floating panel stacks (3D viewport's #camPanelStack, 2D/
   Layout's #paperPanelStack) out of the way — CSS handles the actual
   slide, this just flips one shared class on both. Also hides the model
   info text (#modelInfoFloat) outright — no slide/animation for that one,
   it just disappears and reappears. Ignored while focus is in a text-
   editing context (a normal input/textarea/select, or the inline slider-
   value editor's contenteditable span — see makeSliderValueEditable
   above) so typing "h" there types the letter instead of toggling panels,
   and ignored with any modifier held so it doesn't fight a browser/OS
   shortcut that happens to share the key. */
let panelsHidden = false;

/* ================= about / shortcuts modal =================
   Plain show/hide of a fixed-position overlay — no focus trap or
   animation, just hidden attribute toggling. Closes on the X button,
   clicking the dimmed backdrop outside the card, or Escape (checked
   here rather than folded into the H-panel-toggle listener above
   since it must fire regardless of what's focused, including while
   the modal itself holds focus). */
const aboutOverlay = $('aboutOverlay');
function openAbout(){ aboutOverlay.hidden = false; }
function closeAbout(){ aboutOverlay.hidden = true; }

/* ================= settings panel tabs =================
   Five tabs for the same right-hand panel, one content div each; the
   segmented toggle in #panelHead switches them. "pen" is the Lines tab's
   historical id (it predates the Pen library — see the NAMING note on
   PEN_LIBRARY in main.js). */
const PANEL_MODES = [
  { mode: 'pen',     tab: 'penTab',      btn: 'penModeBtn' },      // Lines/Shadows — "pen" predates the Pen library
  { mode: 'penlib',  tab: 'penLibTab',   btn: 'penLibModeBtn' },   // Pen library (pen-library.js)
  { mode: 'texture', tab: 'textureTab',  btn: 'textureModeBtn' },
  { mode: 'page',    tab: 'pageTab',     btn: 'pageModeBtn' },
  { mode: 'cog',     tab: 'settingsTab', btn: 'cogModeBtn' },
];
export function setPanelMode(mode){
  for (const m of PANEL_MODES){
    $(m.tab).style.display = m.mode === mode ? '' : 'none';
    $(m.btn).classList.toggle('active', m.mode === mode);
    $(m.btn).setAttribute('aria-selected', String(m.mode === mode));
  }
  positionSegPill($('panelModeToggle'));
}

/* ================= init =================
   Everything above only declares. This wires the DOM and starts the
   module's live behaviour — called once by app.js, in script order. */
export function initPanelControls(){
  // Every solve-affecting control (settings.js: regen) re-runs the pipeline
  // on input; the entry's flags say what else that edit has to move. Every
  // range control gets the double-click value editor.
  for (const s of SETTINGS){
    const el = $(s.id);
    if (!el) continue;
    if (s.kind === 'range') makeSliderValueEditable(el, $(s.id + 'Val'), s, () => refreshValLabel(el));
    if (!s.regen) continue;
    el.addEventListener('input', () => {
      markStale();
      if (s.light){ updateLight(); updateLightGizmo(); }
      if (s.rotAxis){ updateModelRotation(); }
      if (s.clearsView) clearActiveView();
      refreshValLabel(el);
    });
  }
  $('genBtn').addEventListener('click', doGenerate);
  $('autoGenBtn').setAttribute('aria-checked', 'true');
  $('autoGenBtn').classList.add('active');
  $('softShadows').addEventListener('change', syncShadowUI);
  $('castShadows').addEventListener('change', syncShadowUI);
  $('groundShadow').addEventListener('change', syncShadowUI);
  syncShadowUI();   // sets the initial disabled state at load
  syncLineLayerUI();
  updateTextureGizmo();
  // previewOverlaySvg's visibility is normally kept in sync by the tab-switch
  // click handler in layout-canvas.js — but that handler has an early return
  // when the clicked tab is already the active one, so it never runs for
  // whichever tab starts active by default (here, 'preview'). Set it
  // explicitly here too, so the gizmo overlay's initial visibility doesn't
  // depend on the HTML's own default happening to match activeTab's actual
  // starting value.
  $('previewOverlaySvg').style.display = activeTab === 'preview' ? '' : 'none';
  // Live 3D-preview counterparts — these run regardless of Auto-regenerate,
  // since they're a pure viewport visual and don't depend on the solved SVG
  // output at all.
  $('castShadows').addEventListener('change', syncShadowCasting);
  $('groundShadow').addEventListener('change', syncShadowCasting);
  $('groundShadow').addEventListener('change', syncGroundCatcher);
  $('groundOff').addEventListener('input', syncGroundCatcher);
  $('softShadows').addEventListener('change', syncSoftShadowsUI);
  $('autoGenBtn').addEventListener('click', () => {
    autoGenOn = !autoGenOn;
    $('autoGenBtn').setAttribute('aria-checked', String(autoGenOn));
    $('autoGenBtn').classList.toggle('active', autoGenOn);
    scheduleAuto();
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'h' && e.key !== 'H') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isFormControlTarget()) return;
    panelsHidden = !panelsHidden;
    $('camPanelStack').classList.toggle('panelsHidden', panelsHidden);
    $('paperPanelStack').classList.toggle('panelsHidden', panelsHidden);
    $('modelInfoFloat').style.display = panelsHidden ? 'none' : '';
  });
  $('appVersion').textContent = 'Version ' + APP_VERSION + ' ·';
  $('aboutBtn').addEventListener('click', openAbout);
  $('aboutCloseBtn').addEventListener('click', closeAbout);
  aboutOverlay.addEventListener('click', e => { if (e.target === aboutOverlay) closeAbout(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !aboutOverlay.hidden) closeAbout();
  });
  for (const m of PANEL_MODES) $(m.btn).addEventListener('click', () => setPanelMode(m.mode));
  /* ================= settings panel resize handle =================
     Drag-to-resize for the right settings panel. 372px (the stylesheet's
     own default column width) is both the starting width and the hard
     minimum — "cannot be narrower than it is now" was the explicit ask.
     Changing it means changing all three copies of that number: this
     MIN_PANEL_W, `main{grid-template-columns}` and #panelResizeHandle's
     `right` (width - 4) in styles.css — applyWidth() doesn't run until
     the first drag or window resize, so until then the handle's position
     comes from CSS alone.
     The 3D viewport and 2D preview panes are the grid's first two `1fr`
     tracks, so they always split whatever space remains 50/50 regardless
     of how wide the panel gets; only the panel's own px track changes.

     Below the layout's existing 1100px stacked-mobile breakpoint, the
     handle is hidden (see CSS) and dragging is disabled — but an inline
     style set here would otherwise permanently outrank that breakpoint's
     own `main{grid-template-columns:...}` rule (inline always beats an
     external stylesheet, media query or not), silently breaking the
     responsive collapse the very first time someone resizes the panel and
     THEN shrinks the window. Guarded by clearing the inline override
     below the breakpoint and restoring it above, on every window resize. */
  (function(){
    const MIN_PANEL_W = 372;
    const MAX_PANEL_W = 640;
    const STACK_BREAKPOINT = 1100;
    const handle = $('panelResizeHandle');
    const mainEl = document.querySelector('main');
    if (!handle || !mainEl) return;
    let panelW = MIN_PANEL_W;
    let dragging = false, startX = 0, startW = MIN_PANEL_W;

    function applyWidth(){
      if (window.innerWidth <= STACK_BREAKPOINT){ mainEl.style.gridTemplateColumns = ''; return; }
      mainEl.style.gridTemplateColumns = `1fr 1fr ${panelW}px`;
      handle.style.right = (panelW - 4) + 'px';   // center the 8px handle on the column boundary
    }
    window.addEventListener('resize', applyWidth);

    handle.addEventListener('pointerdown', e => {
      if (window.innerWidth <= STACK_BREAKPOINT) return;   // stacked layout — handle is hidden here anyway
      dragging = true;
      startX = e.clientX;
      startW = panelW;
      handle.classList.add('dragging');
      document.body.classList.add('resizingPanel');
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = startX - e.clientX;      // dragging left (negative clientX delta) widens the panel
      panelW = Math.max(MIN_PANEL_W, Math.min(MAX_PANEL_W, startW + dx));
      applyWidth();
    });
    function endDrag(){
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.classList.remove('resizingPanel');
    }
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  })();
}
