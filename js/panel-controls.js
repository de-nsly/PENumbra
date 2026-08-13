/* ================================================================
   panel-controls.js — control panel wiring
   Preset-slider helpers (shadow budget / hatch cap ladders),
   staleness tracking (markStale/scheduleAuto/clearStale),
   gatherSettings() (reads every control into a plain settings
   object for the worker), the Generate/Auto-generate buttons, and
   the shadow/soft-shadow UI sync helpers.
   ================================================================ */
/* ================= settings / staleness ================= */
// Shadow budget is a discrete preset ladder (not a raw number slider) so the
// wide useful range — from "fast preview" to "no cap, however long it takes"
// — stays reachable with a handful of clicks instead of a mostly-useless
// linear scrubber. `Number.MAX_SAFE_INTEGER` stands in for "unlimited": it's
// finite (so it survives structured-clone/JSON round-trips as an ordinary
// number, unlike literal Infinity, which JSON.stringify turns into `null`),
// while being far larger than any real scene could ever exhaust.
const SHADOW_BUDGET_PRESETS = [250000, 500000, 1000000, 2000000, 4000000, 8000000, 16000000, Number.MAX_SAFE_INTEGER];
// same idea for the hatch segment safety cap — default (index 2 → 80k)
// matches the value this app always used before it became adjustable.
const HATCH_CAP_PRESETS = [20000, 40000, 80000, 160000, 320000, 640000, 1280000, Number.MAX_SAFE_INTEGER];
function fmtBigCount(n){
  if (n >= Number.MAX_SAFE_INTEGER) return 'unl.';
  if (n >= 1e6) return (n/1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M';
  return Math.round(n/1e3) + 'k';
}
const PRESET_SLIDERS = { shadowBudget: SHADOW_BUDGET_PRESETS, hatchCap: HATCH_CAP_PRESETS };
// shared by the live 'input' listener below AND scene import — a restored
// control's value has to be reflected in its val-span the same way a user
// dragging it would, just without an 'input' event to trigger it naturally
// Per-layer texture clones suffix every id with _h1/_h2/_h3/_cr (see
// buildPerLayerTextureTabs in main.js) — stripping that suffix before
// classifying a control's type means refreshValLabel/valUnitFor below
// don't need a second copy of their own logic per layer.
function baseTexId(id){
  return id.replace(/_(h1|h2|h3|cr)$/, '');
}
function refreshValLabel(el){
  const v = $(el.id + 'Val');
  if (!v) return;
  const presets = PRESET_SLIDERS[el.id];
  if (presets){ v.textContent = fmtBigCount(presets[+el.value]); return; }
  if (el.id === 'camShiftX' || el.id === 'camShiftY'){ v.textContent = (+el.value).toFixed(2); return; }
  if (el.id === 'dedupOffMult' || el.id === 'dedupGapMult'){ v.textContent = (+el.value).toFixed(2) + '×'; return; }
  const bid = baseTexId(el.id);
  const isTexAngle = bid === 'texAngleMin' || bid === 'texAngleMax';
  const isTexRatio = bid === 'texWobbleVariation' || bid === 'texCirclesThr';
  const oneDecimal = bid === 'creaseDeg' || (bid.startsWith('tex') && bid !== 'texCirclesThr');
  const num = bid === 'texCirclesThr' ? (+el.value).toFixed(2) : oneDecimal ? (+el.value).toFixed(1) : el.value;
  const unit = bid.startsWith('tex') ? (isTexRatio ? '' : isTexAngle ? '°' : 'mm') :
    bid.includes('Thr') ? '' :
    bid.includes('hatchM') ? 'mm' : bid === 'groundOff' ? '%' : '°';
  v.textContent = num + unit;
}
/* ================= double-click-to-edit slider values =================
   Every slider's value span already goes through refreshValLabel above to
   format itself (a unit suffix, or — for the two preset-ladder sliders — a
   lookup through a small fixed list). This adds the reverse direction:
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
   boundary it's past, rather than reverting. */
function valUnitFor(id){
  if (id === 'camShiftX' || id === 'camShiftY') return '';
  if (id === 'dedupOffMult' || id === 'dedupGapMult') return '×';
  const bid = baseTexId(id);
  if (bid.startsWith('tex')) return (bid === 'texWobbleVariation' || bid === 'texCirclesThr') ? '' : (bid === 'texAngleMin' || bid === 'texAngleMax') ? '°' : 'mm';
  if (bid.includes('Thr')) return '';
  if (bid.includes('hatchM')) return 'mm';
  if (bid === 'groundOff') return '%';
  return '°';
}
function makeSliderValueEditable(rangeEl){
  if (PRESET_SLIDERS[rangeEl.id]) return;      // excluded — see comment above
  const span = $(rangeEl.id + 'Val');
  if (!span) return;
  const unit = valUnitFor(rangeEl.id);
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
    refreshValLabel(rangeEl);   // restores the unit suffix; also re-displays the true value if reverted
  }
  span.addEventListener('dblclick', beginEdit);
  span.addEventListener('blur', endEdit);
  span.addEventListener('keydown', e => {
    if (e.key === 'Enter'){ e.preventDefault(); span.blur(); }
    else if (e.key === 'Escape'){ cancelled = true; span.blur(); }
  });
}
document.querySelectorAll('input[type="range"]').forEach(makeSliderValueEditable);

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
function makeNameEditable(span, getCurrentName, onCommit){
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

document.querySelectorAll('[data-regen]').forEach(el =>
  el.addEventListener('input', () => {
    markStale();
    if (el.dataset.light !== undefined){ updateLight(); updateLightGizmo(); }
    if (el.dataset.rotAxis !== undefined){ updateModelRotation(); }
    if (el.id === 'fovDeg' || el.dataset.light !== undefined || el.dataset.rotAxis !== undefined || el.dataset.camshift !== undefined) clearActiveView();
    refreshValLabel(el);
  }));
let staleSeq = 0, genSeq = 0, autoTimer = null;
// 'preview' | 'layout'. While 'layout', the live 3D->SVG pipeline is fully
// paused — nothing in the 3D viewport (orbit, rotation sliders, light) is
// visible anyway, so there's no reason to keep regenerating on every change.
// See layout-canvas.js for the tab-switch handler that flips this and
// pauses/resumes accordingly (switching back to 'preview' calls markStale()
// once, to catch up on anything changed while paused).
let activeTab = 'preview';
function markStale(){
  if (activeTab !== 'preview') return;
  staleSeq++;
  $('paperPane').classList.add('stale');
  $('sheet').classList.add('stale');
  scheduleAuto();
}
function scheduleAuto(){
  if (activeTab !== 'preview') return;
  if (!autoGenOn || !modelMesh || genSeq === staleSeq) return;
  clearTimeout(autoTimer);
  // debounce adapts to how long the last solve took, so heavy models don't thrash
  const wait = lastGen ? Math.min(2000, Math.max(280, lastGen.ms * 1.5)) : 280;
  autoTimer = setTimeout(() => { if (!busy) doGenerate(); }, wait);
}
function clearStale(){
  $('paperPane').classList.remove('stale');
  $('sheet').classList.remove('stale');
}

function gatherSettings(){
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
    smoothShading: $('smoothShading').checked,
    creaseDeg: +$('creaseDeg').value,
    light: lightVec(),
    types: {
      c: layerStyle('cv').on || layerStyle('ch').on,
    },
    // individual per-layer draw state — the full-hierarchy cascade needs to
    // know whether EVERY individual layer will actually put ink on the page
    // before using it to remove ink from a lower-priority layer. Silhouette
    // (so), Silhouette individual (iv/ih), and Contour (sv/sh) are three
    // fully independent layers now (Blender's GROUP/INDIVIDUAL/NONE
    // silhouette filters, respectively) — no more single-layer-plus-toggle.
    layerOn: {
      so: layerStyle('so').on,
      iv: layerStyle('iv').on, ih: layerStyle('ih').on,
      sv: layerStyle('sv').on, sh: layerStyle('sh').on,
      cv: layerStyle('cv').on, ch: layerStyle('ch').on,
      h1: layerStyle('h1').on, h2: layerStyle('h2').on, h3: layerStyle('h3').on,
    },
    hatch: {
      p1: layerStyle('h1').on, p2: layerStyle('h2').on, p3: layerStyle('h3').on,
      ang: +$('hatchAng').value,
      minS: mmToPx(+$('hatchMin').value), maxS: mmToPx(+$('hatchMax').value),
      // Soft shadows off → every face fails these thresholds (0 is
      // unreachable since brightness is always >=0), disabling the ambient
      // brightness-based hatch bands while leaving Cast/Ground shadow
      // hatching (which doesn't go through this threshold at all) untouched.
      // The sliders' own stored values are left alone so re-enabling Soft
      // shadows restores exactly what the user had.
      // softShadowsOn is sent explicitly (not inferred from thr===0) so the
      // worker can tell "soft shadows genuinely off" apart from "a
      // threshold slider just happens to be low" — needed to automatically
      // restore Cast-shadow-only hatching (see project notes) now that
      // buffer mode tests one combined threshold instead of two independent
      // axes the old analytic hybrid had.
      crossThr: $('softShadows').checked ? +$('crossThr').value : 0,
      deepThr:  $('softShadows').checked ? +$('deepThr').value  : 0,
      hatchThr: $('softShadows').checked ? +$('hatchThr').value : 0,
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
    circlesOn: layerStyle('cr').on,
    circlesThr: $('softShadows').checked ? (+$('texCirclesThr').value || 0.92) : 0,
    groundPatternCenterX: layout
      ? mmToPx(layout.paperW/2 + (+$('texGroundPatternCenterX').value || 0) - layout.offX)
      : (+$('texGroundPatternCenterX').value || 0),
    groundPatternCenterY: layout
      ? mmToPx(layout.paperH/2 + (+$('texGroundPatternCenterY').value || 0) - layout.offY)
      : (+$('texGroundPatternCenterY').value || 0),
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
let busy = false, lastGen = null;
$('genBtn').addEventListener('click', doGenerate);
let autoGenOn = true;                 // header toggle button; checked/pressed by default
$('autoGenBtn').setAttribute('aria-checked', 'true');
$('autoGenBtn').classList.add('active');
// Ground shadow's plane offset only makes sense with its own toggle on;
// shadow budget only bounds Cast shadow's sampling, so only that toggle
// matters for it (see the function body below).
function syncShadowUI(){
  $('groundOffCtl').classList.toggle('ctlDisabled', !$('groundShadow').checked);
  // budget only bounds the light-space point-sampling used for object
  // self-shadow — Ground shadow is analytic (no sampling, no budget), so
  // the control is meaningless while Cast shadows is off
  $('shadowBudgetCtl').classList.toggle('ctlDisabled', !$('castShadows').checked);
}
$('castShadows').addEventListener('change', syncShadowUI);
$('groundShadow').addEventListener('change', syncShadowUI);
// Circles pattern's Center X/Y/threshold now live in the always-visible
// General sub-tab (moved there alongside Hatching/Shadows), so there's no
// group visibility to toggle here anymore — only the gizmo, which still
// depends on the Circles layer's own pen checkbox.
function syncTexturePatternUI(){
  if (typeof updateTextureGizmo === 'function') updateTextureGizmo();
}
// Texture pattern's Center X/Y are offsets from the page's own center
// (redefined from the solver's arbitrary origin — see groundPatternCenterX/Y
// in gatherSettings above), so the natural range is exactly half the page
// in each direction: reaching the slider's max/min lands exactly on the
// page edge, never beyond it. Reapplies the position as a fraction of the
// page's half-width/half-height whenever the page size or orientation
// actually changes (tracked via the last-seen paperW/paperH below), so a
// point 30% of the way to the edge stays 30% of the way to the edge on the
// new page — rescaling both up and down, not just clamping. This also
// makes the old "auto-center on first activation" logic unnecessary: 0,0
// already means page center by definition now, so there's nothing left to
// default away from.
let _gpLastPaperW = null, _gpLastPaperH = null;
function updateGroundPatternSliderRange(){
  const layout = computePaperLayout();
  if (!layout) return;
  const xEl = $('texGroundPatternCenterX'), yEl = $('texGroundPatternCenterY');
  if (_gpLastPaperW !== null && (_gpLastPaperW !== layout.paperW || _gpLastPaperH !== layout.paperH)){
    const oldHalfW = _gpLastPaperW/2, oldHalfH = _gpLastPaperH/2;
    const fracX = oldHalfW > 0 ? (+xEl.value)/oldHalfW : 0;
    const fracY = oldHalfH > 0 ? (+yEl.value)/oldHalfH : 0;
    xEl.value = fracX * (layout.paperW/2);
    yEl.value = fracY * (layout.paperH/2);
  }
  xEl.min = -layout.paperW/2; xEl.max = layout.paperW/2;
  yEl.min = -layout.paperH/2; yEl.max = layout.paperH/2;
  _gpLastPaperW = layout.paperW; _gpLastPaperH = layout.paperH;
  refreshValLabel(xEl); refreshValLabel(yEl);
}
layerEls['cr'].chk.addEventListener('change', syncTexturePatternUI);
syncTexturePatternUI();
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
// Soft shadows: the per-face ambient brightness bands (Hatch/Cross/Deep
// below) that give gradual, soft-looking shading — distinct from Cast
// shadows / Ground shadow, which are hard, occlusion-based shadows and stay
// fully independent of this toggle. Turning it off grays out the three
// threshold sliders and (in gatherSettings) forces their effective value to
// 0 so no face qualifies for ambient hatching, without touching the sliders'
// own stored positions — turning Soft shadows back on restores them exactly.
function syncSoftShadowsUI(){
  const on = $('softShadows').checked;
  for (const id of ['hatchThrCtl','crossThrCtl','deepThrCtl'])
    $(id).classList.toggle('ctlDisabled', !on);
}
$('softShadows').addEventListener('change', syncSoftShadowsUI);
$('autoGenBtn').addEventListener('click', () => {
  autoGenOn = !autoGenOn;
  $('autoGenBtn').setAttribute('aria-checked', String(autoGenOn));
  $('autoGenBtn').classList.toggle('active', autoGenOn);
  scheduleAuto();
});
function buildCamMessage(){
  camera.updateMatrixWorld(true);
  const view = new THREE.Matrix4().copy(camera.matrixWorld).invert();
  return {
    view: Array.from(view.elements),
    proj: Array.from(camera.projectionMatrix.elements),
    w: vp.clientWidth, h: vp.clientHeight, near: camera.near,
    ortho: !!camera.isOrthographicCamera,
  };
}
function doGenerate(){
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
  // surface rings) density decisions are driven entirely by this captured
  // buffer now — see project notes for the validation that preceded
  // removing the old analytic Phong+shadow-map hybrid.
  const transfer = [];
  let shadingBuffer = null;
  if ($('smoothShading').checked && typeof captureShadingBuffer === 'function'){
    const cap = captureShadingBuffer();
    if (cap){ shadingBuffer = cap; transfer.push(cap.pixels.buffer); }
  }
  worker.postMessage({
    type: 'generate',
    cam: buildCamMessage(),
    settings: gatherSettings(),
    shadingBuffer,
  }, transfer);
}

/* ================= Phase 2 validation: shading-buffer round trip =================
   Samples the SAME captured buffer two independent ways — directly here on
   the main thread, and round-tripped through the worker (transfer, row-
   flip, sampleShading's bilinear lookup) — and checks that they agree.
   Deliberately a separate, independent implementation from the worker's
   own sampleShading rather than shared code, so this is a genuine cross-
   check rather than the same bug (if any) agreeing with itself. Doesn't
   touch doGenerate/generate() at all — a standalone diagnostic, same
   discipline as Phase 1's previewShadingBuffer().
   Call from the browser console: testShadingBufferRoundTrip() */
let pendingShadingTestReference = null;
function testShadingBufferRoundTrip(){
  if (typeof captureShadingBuffer !== 'function'){ console.warn('[shadingTest] Phase 1 capture not available'); return; }
  const cap = captureShadingBuffer();
  if (!cap){ console.warn('[shadingTest] no model loaded / capture failed'); return; }
  const { pixels, w, h } = cap;
  // A handful of points spread across the buffer, including one
  // deliberately fractional (non-integer) point to exercise the bilinear
  // interpolation path itself, not just nearest-texel lookups.
  const points = [
    [w*0.5, h*0.5], [w*0.25, h*0.75], [w*0.1, h*0.1],
    [w*0.9, h*0.9], [w*0.5 + 0.37, h*0.5 + 0.62],
  ];
  // Reference: flip a COPY (never mutate the buffer about to be
  // transferred away) using the same row-flip the worker applies, then
  // sample with a plain, independent bilinear implementation.
  const flipped = pixels.slice();
  const rowFloats = w * 4;
  for (let y = 0; y < h >> 1; y++){
    const y2 = h - 1 - y;
    const o1 = y*rowFloats, o2 = y2*rowFloats;
    const tmp = flipped.slice(o1, o1+rowFloats);
    flipped.copyWithin(o1, o2, o2+rowFloats);
    flipped.set(tmp, o2);
  }
  const sampleRef = (sx, sy) => {
    const x = Math.max(0, Math.min(w - 1, sx));
    const y = Math.max(0, Math.min(h - 1, sy));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(w-1, x0+1), y1 = Math.min(h-1, y0+1);
    const fx = x-x0, fy = y-y0;
    const idx = (xi,yi) => (yi*w+xi)*4;
    const ia=idx(x0,y0), ib=idx(x1,y0), ic=idx(x0,y1), id=idx(x1,y1);
    const wA=(1-fx)*(1-fy), wB=fx*(1-fy), wC=(1-fx)*fy, wD=fx*fy;
    return {
      brightness: flipped[ia]*wA + flipped[ib]*wB + flipped[ic]*wC + flipped[id]*wD,
      hasGeometry: (flipped[ia+1]*wA + flipped[ib+1]*wB + flipped[ic+1]*wC + flipped[id+1]*wD) > 0.5,
    };
  };
  pendingShadingTestReference = { points, reference: points.map(([sx,sy]) => sampleRef(sx,sy)) };
  worker.postMessage({ type: 'testShadingSample', pixels, w, h, points }, [pixels.buffer]);
  console.log('[shadingTest] sent ' + points.length + ' test points to the worker — waiting for testShadingSampleResult...');
}
window.testShadingBufferRoundTrip = testShadingBufferRoundTrip;

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
document.addEventListener('keydown', e => {
  if (e.key !== 'h' && e.key !== 'H') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
  panelsHidden = !panelsHidden;
  $('camPanelStack').classList.toggle('panelsHidden', panelsHidden);
  $('paperPanelStack').classList.toggle('panelsHidden', panelsHidden);
  $('modelInfoFloat').style.display = panelsHidden ? 'none' : '';
});

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
$('aboutBtn').addEventListener('click', openAbout);
$('aboutCloseBtn').addEventListener('click', closeAbout);
aboutOverlay.addEventListener('click', e => { if (e.target === aboutOverlay) closeAbout(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !aboutOverlay.hidden) closeAbout();
});

/* ================= pen/cog settings-mode toggle =================
   Two tabs for the same right-hand panel: "pen" (everything line/hatch/
   shadow related — the default) and "cog" (general settings — currently
   just Assume watertight, more to come later). Clicking either button
   shows its tab and hides the other, and lights up the clicked side while
   the other stays muted — no sliding knob, unlike .pillToggle elsewhere. */
const PANEL_MODES = [
  { mode: 'pen',     tab: 'penTab',      btn: 'penModeBtn' },
  { mode: 'texture', tab: 'textureTab',  btn: 'textureModeBtn' },
  { mode: 'page',    tab: 'pageTab',     btn: 'pageModeBtn' },
  { mode: 'cog',     tab: 'settingsTab', btn: 'cogModeBtn' },
];
function setPanelMode(mode){
  for (const m of PANEL_MODES){
    $(m.tab).style.display = m.mode === mode ? '' : 'none';
    $(m.btn).classList.toggle('active', m.mode === mode);
    $(m.btn).setAttribute('aria-selected', String(m.mode === mode));
  }
}
for (const m of PANEL_MODES) $(m.btn).addEventListener('click', () => setPanelMode(m.mode));

/* ================= hatch texture enable checkboxes =================
   Each texture effect (Overshoot, Spacing jitter, Angle jitter, and
   whatever gets added later) has its own on/off checkbox, unchecked by
   default so shadows stay clean unless explicitly turned on, with its
   fields row dimmed while off. Listed by id prefix only, so a future
   effect just needs one more entry here — same pattern as PANEL_MODES. */
const TEXTURE_GROUPS = ['texTrim', 'texOvershoot', 'texSpacing', 'texAngle', 'texWobble', 'texRegWobble', 'texGaps'];
const TEXTURE_LAYER_KEYS = ['h1', 'h2', 'h3', 'cr'];
function syncTextureGroup(prefix, suffix){
  const onEl = $(prefix + 'On' + suffix), fieldsEl = $(prefix + 'Fields' + suffix);
  if (!onEl || !fieldsEl) return;   // e.g. texAngle/texRegWobble don't exist in the Circles clone
  fieldsEl.classList.toggle('ctlDisabled', !onEl.checked);
}
for (const prefix of TEXTURE_GROUPS){
  syncTextureGroup(prefix, '');
  $(prefix + 'On').addEventListener('change', () => syncTextureGroup(prefix, ''));
  for (const key of TEXTURE_LAYER_KEYS){
    const suffix = '_' + key;
    syncTextureGroup(prefix, suffix);
    const onEl = $(prefix + 'On' + suffix);
    if (onEl) onEl.addEventListener('change', () => syncTextureGroup(prefix, suffix));
  }
}

/* ================= texture tab: single-level tabs + per-layer individual mode =================
   One tab level, two possible button rows shown mutually exclusively:
   General/Texture by default, or G/H1/H2/H3/C when "Individual texture
   settings" (in General) is on — not a nested third tier. The per-layer
   content panels (H1/H2/H3/Circles, built by cloning — see
   buildPerLayerTextureTabs in main.js) are the same regardless of which
   row is currently shown. Turning Individual back off simply goes back
   to reading General's own values, which were never touched while it
   was on. */
let texActiveTop = 'general';

function texLayerEnabled(key){
  return !!(layerEls[key] && layerEls[key].chk.checked);
}
// Sets which top-level content panel is showing (General settings, the
// shared Texture controls, or one specific layer's own controls).
function selectTexTop(key){
  texActiveTop = key;
  document.querySelectorAll('.texTopTabBtn').forEach(b => b.classList.toggle('active', b.dataset.textop === key));
  $('texSubGeneral').style.display = key === 'general' ? '' : 'none';
  $('texGeneralSettings').style.display = key === 'texture' ? '' : 'none';
  TEXTURE_LAYER_KEYS.forEach(k => {
    const el = $('texLayerSettings_' + k);
    if (el) el.style.display = (key === k) ? '' : 'none';
  });
  updateTexTabRounding();
}
document.querySelectorAll('.texTopTabBtn').forEach(btn => {
  btn.addEventListener('click', () => { selectTexTop(btn.dataset.textop); markStale(); });
});
// CSS :first-child/:last-child (used elsewhere for this pill style) only
// look at DOM position, not which siblings are actually visible — so a
// row filtered down to two buttons would leave the visually-last one
// with square corners on both sides instead of rounded on the right.
// Recomputes which button is actually first/last-visible within each row
// and applies explicit classes instead, every time visibility changes.
function updateTexTabRounding(){
  document.querySelectorAll('.textureSubTabs').forEach(bar => {
    const visible = [...bar.querySelectorAll('.texTopTabBtn')].filter(b => b.style.display !== 'none');
    bar.querySelectorAll('.texTopTabBtn').forEach(b => b.classList.remove('roundLeft', 'roundRight'));
    if (visible.length){
      visible[0].classList.add('roundLeft');
      visible[visible.length-1].classList.add('roundRight');
    }
  });
}
// Only show tab buttons for currently-enabled layers (in the Individual
// row); if every one of them happens to be off, fall back to showing H1
// alone rather than leaving nothing to click. The General/"G" button is
// never filtered.
function updateTexLayerTabVisibility(){
  const anyEnabled = TEXTURE_LAYER_KEYS.some(texLayerEnabled);
  document.querySelectorAll('#texTopTabsIndividual .texTopTabBtn').forEach(btn => {
    const key = btn.dataset.textop;
    if (key === 'general') return;
    btn.style.display = (anyEnabled ? texLayerEnabled(key) : key === 'h1') ? '' : 'none';
  });
  const individualOn = $('texIndividualOn').checked;
  if (individualOn && texActiveTop !== 'general'){
    const activeBtn = document.querySelector('#texTopTabsIndividual .texTopTabBtn[data-textop="' + texActiveTop + '"]');
    if (!activeBtn || activeBtn.style.display === 'none'){
      const firstVisible = [...document.querySelectorAll('#texTopTabsIndividual .texTopTabBtn')].find(b => b.style.display !== 'none');
      if (firstVisible) selectTexTop(firstVisible.dataset.textop);
    }
  }
  updateTexTabRounding();
}

// Copies every current General texture-effect value into one layer's own
// suffixed controls — run once per layer at the moment Individual mode
// is switched on, so each layer starts out matching what was already
// active rather than jumping to a different default.
function seedLayerTextureSettings(key){
  $('texGeneralSettings').querySelectorAll('input').forEach(genEl => {
    const layerEl = $(genEl.id + '_' + key);
    if (!layerEl) return;   // e.g. Angle jitter / Regular wobble have no Circles counterpart
    if (genEl.type === 'checkbox') layerEl.checked = genEl.checked;
    else layerEl.value = genEl.value;
    refreshValLabel(layerEl);
    layerEl.dispatchEvent(new Event('change'));
  });
}
function syncIndividualMode(){
  const on = $('texIndividualOn').checked;
  $('texTopTabsNormal').style.display = on ? 'none' : '';
  $('texTopTabsIndividual').style.display = on ? '' : 'none';
  let nextTop = texActiveTop;
  if (on && nextTop === 'texture') nextTop = 'h1';                        // "Texture" doesn't exist in Individual mode
  if (!on && TEXTURE_LAYER_KEYS.includes(nextTop)) nextTop = 'texture';   // layer tabs don't exist in Normal mode
  selectTexTop(nextTop);
  if (on) updateTexLayerTabVisibility();
}
$('texIndividualOn').addEventListener('change', () => {
  if ($('texIndividualOn').checked) TEXTURE_LAYER_KEYS.forEach(seedLayerTextureSettings);
  syncIndividualMode();
  markStale();
});
selectTexTop('general');
syncIndividualMode();
TEXTURE_LAYER_KEYS.forEach(k => {
  if (layerEls[k]) layerEls[k].chk.addEventListener('change', updateTexLayerTabVisibility);
});
updateTexLayerTabVisibility();

/* ================= settings panel resize handle =================
   Drag-to-resize for the right settings panel. 322px (this stylesheet's
   own default column width) is both the starting width and the hard
   minimum — "cannot be narrower than it is now" was the explicit ask.
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
  const MIN_PANEL_W = 322;
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

/* ================= worker messages ================= */
