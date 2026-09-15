/* ================================================================
   settings.js — the settings registry
   One entry per control in the settings panel: what kind of element it
   is, whether changing it re-runs the solve, how its value label is
   formatted, and which sync function has to run after a .pen scene
   sets its value by assignment (which fires no input/change event).
   Everything that used to be scattered across a data-regen attribute,
   two hand-written if-chains for the value labels, and a list of sync
   calls in the scene importer is derived from this table instead.

   The `id` is the element id AND the persisted key in a .pen file's
   settings block — never rename one (see docs/refactor-plan.md §1.3).

   Entry fields:
     id          element id / persisted key
     kind        'range' | 'checkbox' | 'select' | 'number' | 'color'
     regen       true → an 'input' event marks the drawing stale and
                 re-generates (initPanelControls wires the listener)
     scene       false → not saved in a .pen (default: saved)
     unit        suffix on the value label ('' for none)
     decimals    fixed decimals on the label; absent → the raw slider
                 value string, as the browser holds it
     presets     a preset ladder: the slider value is an INDEX into it
                 and the label shows the ladder entry (fmtBigCount)
     clearsView  editing it invalidates the active saved view
     light       editing it moves the three.js light + gizmo
     rotAxis     editing it re-applies the model rotation
     perLayer    the control is cloned per fill layer with an _h1/_h2/
                 _h3/_cr id suffix (buildPerLayerTextureTabs, main.js);
                 those clones share this entry — transitional until the
                 per-layer texture stacks replace the clones
     onRestore   a sync function (or a list) the scene importer calls
                 once after every restored value is in place; the same
                 function named by several entries runs once, in the
                 order entries appear here (see restoreHooks)

   Every onRestore target is a hoisted `function` declaration in its
   module, so referencing it here at module top level is safe inside the
   import cycles this module sits in (a `const`/`let` export would not be).
   ================================================================ */
import { applySmoothAngleChange, applySmoothShadingToggle, syncGroundCatcher, syncShadowCasting, syncSmoothAngleVisibility, updateLight, updateLightGizmo, updateModelRotation } from './viewport3d.js';
import { applyPageColor, syncMarginMode } from './svg-export.js';
import { syncIndividualMode, syncShadowUI, syncSoftShadowsUI, updateTexLayerTabVisibility } from './panel-controls.js';
import { syncPenPathsExportUI, syncSplitDashChoiceFromDom } from './pen-library.js';

/* ================= preset ladders =================
   Shadow budget is a discrete preset ladder (not a raw number slider) so the
   wide useful range — from "fast preview" to "no cap, however long it takes"
   — stays reachable with a handful of clicks instead of a mostly-useless
   linear scrubber. `Number.MAX_SAFE_INTEGER` stands in for "unlimited": it's
   finite (so it survives structured-clone/JSON round-trips as an ordinary
   number, unlike literal Infinity, which JSON.stringify turns into `null`),
   while being far larger than any real scene could ever exhaust. */
export const SHADOW_BUDGET_PRESETS = [250000, 500000, 1000000, 2000000, 4000000, 8000000, 16000000, Number.MAX_SAFE_INTEGER];
// same idea for the hatch segment safety cap — default (index 2 → 80k)
// matches the value this app always used before it became adjustable.
export const HATCH_CAP_PRESETS = [20000, 40000, 80000, 160000, 320000, 640000, 1280000, Number.MAX_SAFE_INTEGER];
export function fmtBigCount(n){
  if (n >= Number.MAX_SAFE_INTEGER) return 'unl.';
  if (n >= 1e6) return (n/1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M';
  return Math.round(n/1e3) + 'k';
}

// The fill layers whose texture controls are cloned with an id suffix.
// Goes away with the clones (refactor plan §4b).
export const TEXTURE_LAYER_KEYS = ['h1', 'h2', 'h3', 'cr'];

const range = (id, extra) => ({ id, kind:'range', regen:true, ...extra });
const chk   = (id, extra) => ({ id, kind:'checkbox', regen:true, ...extra });
const tex   = (id, extra) => ({ id, kind:'range', regen:true, perLayer:true, decimals:1, unit:'mm', ...extra });
const texOn = id => ({ id, kind:'checkbox', regen:true, perLayer:true });

export const SETTINGS = [
  /* ---- camera (3D viewport panel) ---- */
  range('fovDeg',    { unit:'°', clearsView:true }),
  range('camShiftX', { unit:'', decimals:2, clearsView:true }),
  range('camShiftY', { unit:'', decimals:2, clearsView:true }),
  range('rotX', { unit:'°', rotAxis:'x', clearsView:true, onRestore: updateModelRotation }),
  range('rotY', { unit:'°', rotAxis:'y', clearsView:true, onRestore: updateModelRotation }),
  range('rotZ', { unit:'°', rotAxis:'z', clearsView:true, onRestore: updateModelRotation }),
  /* ---- light ---- */
  range('lightAz', { unit:'°', light:true, clearsView:true, onRestore: [updateLight, updateLightGizmo] }),
  range('lightEl', { unit:'°', light:true, clearsView:true, onRestore: [updateLight, updateLightGizmo] }),
  /* ---- hatching ---- */
  range('hatchAng', { unit:'°' }),
  range('hatchMin', { unit:'mm' }),
  range('hatchMax', { unit:'mm' }),
  range('hatchCap', { presets: HATCH_CAP_PRESETS }),
  range('hatchThr', { unit:'' }),
  range('crossThr', { unit:'' }),
  range('deepThr',  { unit:'' }),
  /* ---- circles pattern ---- */
  range('texGroundPatternCenterX', { unit:'mm', decimals:1 }),
  range('texGroundPatternCenterY', { unit:'mm', decimals:1 }),
  range('texCirclesThr', { unit:'', decimals:2 }),
  /* ---- texture mode ---- */
  chk('texIndividualOn', { onRestore: [syncIndividualMode, updateTexLayerTabVisibility] }),
  /* ---- texture effects (cloned per fill layer, see perLayer) ---- */
  texOn('texTrimOn'),      tex('texTrimValue'),
  texOn('texOvershootOn'), tex('texOvershootMin'), tex('texOvershootMax'),
  texOn('texSpacingOn'),   tex('texSpacingMin'),   tex('texSpacingMax'),
  texOn('texAngleOn'),     tex('texAngleMin', { unit:'°' }), tex('texAngleMax', { unit:'°' }),
  texOn('texWobbleOn'),    texOn('texWobbleShared'),
  tex('texWobbleSpacing'), tex('texWobbleAmp'), tex('texWobbleVariation', { unit:'' }), tex('texWobbleVarScale'),
  texOn('texRegWobbleOn'), tex('texRegWobbleAmp'), tex('texRegWobbleWavelength'),
  texOn('texGapsOn'),      tex('texGapsSpacing'),  tex('texGapsMax'),
  /* ---- lines ---- */
  chk('watertight'),
  range('dedupOffMult', { unit:'×', decimals:2 }),
  range('dedupGapMult', { unit:'×', decimals:2 }),
  // A bare fraction of the model radius, small enough to need 4 decimals
  // and with no unit at all.
  range('contourCleanup', { unit:'', decimals:4 }),
  // A bare count of triangle steps — no unit, integral.
  range('contourMaxHops', { unit:'' }),
  range('creaseDeg', { unit:'°', decimals:1 }),
  /* ---- shadows ---- */
  chk('softShadows',   { onRestore: [syncShadowUI, syncSoftShadowsUI] }),
  chk('invertShadows'),
  chk('castShadows',   { onRestore: [syncShadowUI, syncShadowCasting] }),
  chk('groundShadow',  { onRestore: [syncShadowUI, syncShadowCasting, syncGroundCatcher] }),
  range('shadowBudget', { presets: SHADOW_BUDGET_PRESETS }),
  range('groundOff', { unit:'%', onRestore: syncGroundCatcher }),
  chk('smoothShading', { onRestore: [applySmoothShadingToggle, syncSmoothAngleVisibility] }),
  range('smoothAngleDeg', { unit:'°', onRestore: applySmoothAngleChange }),
  /* ---- page (not solve-affecting: their own listeners re-lay-out the page) ---- */
  { id:'paperSize', kind:'select',   onRestore: syncMarginMode },
  { id:'orient',    kind:'select',   onRestore: syncMarginMode },
  { id:'marginMm',  kind:'number',   onRestore: syncMarginMode },
  { id:'marginIndependent', kind:'checkbox', onRestore: syncMarginMode },
  { id:'marginTopMm',    kind:'number', onRestore: syncMarginMode },
  { id:'marginBottomMm', kind:'number', onRestore: syncMarginMode },
  { id:'marginLeftMm',   kind:'number', onRestore: syncMarginMode },
  { id:'marginRightMm',  kind:'number', onRestore: syncMarginMode },
  { id:'trimToMargins',  kind:'checkbox' },
  { id:'pageColor',      kind:'color', onRestore: applyPageColor },
  { id:'gridGuideEnabled', kind:'checkbox' },
  { id:'gridGuideX', kind:'number' },
  { id:'gridGuideY', kind:'number' },
  /* ---- export ---- */
  // Split dashes first: the restored value is taken as the user's own
  // choice before the one-path-per-pen lock is re-applied over it.
  { id:'splitDashBtn',   kind:'checkbox', onRestore: [syncSplitDashChoiceFromDom, syncPenPathsExportUI] },
  { id:'penPathsExport', kind:'checkbox', onRestore: syncPenPathsExportUI },
  /* ---- layout tab (session-only) ---- */
  { id:'layoutOverlayOpacity', kind:'range', scene:false, unit:'%' },
];

const byId = new Map(SETTINGS.map(s => [s.id, s]));
export function settingById(id){ return byId.get(id); }

// The element ids one entry owns: its own, plus the per-layer clones for
// a perLayer entry. A clone may not exist (the Circles clone has no Angle
// jitter / Regular wobble) — callers $() each id and skip a null.
export function settingElementIds(s){
  return s.perLayer ? [s.id, ...TEXTURE_LAYER_KEYS.map(k => s.id + '_' + k)] : [s.id];
}

// Text for a control's value label.
export function formatValue(s, value){
  if (s.presets) return fmtBigCount(s.presets[+value]);
  const num = s.decimals == null ? String(value) : (+value).toFixed(s.decimals);
  return num + (s.unit || '');
}

// Every id a .pen scene's settings block records (the dash fields are
// added by the caller — they are a growable slot list, not fixed controls).
export function sceneSettingIds(){
  return SETTINGS.filter(s => s.scene !== false).flatMap(settingElementIds);
}

// The sync functions the scene importer runs after restoring values, each
// once, in registry order.
export function restoreHooks(){
  const out = [];
  for (const s of SETTINGS){
    if (!s.onRestore) continue;
    for (const fn of [].concat(s.onRestore)) if (!out.includes(fn)) out.push(fn);
  }
  return out;
}
