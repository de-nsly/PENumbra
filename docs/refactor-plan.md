# PENumbra cleanup — remaining phases (handoff)

Written 2026-09-15 at the end of Phase 3, for whoever (human or model) continues the cleanup on
branch `cleanup`. It is self-contained: read this, `CLAUDE.md`, and the file headers, and you have
everything the earlier sessions had.

The goal of the whole effort: bring the code to the state it would be in if written from scratch today
with every feature designed in, **without changing the output**. Phases 0–3 are done. Phases 4–7 remain,
and Phase 4 also has to lay the ground for two planned features (§2.1).

---

## 1. Ground rules — what to do and what to avoid

1. **Output must stay byte-identical.** After every step run
   `node tools/harness/verify-golden.mjs` and require `RESULT: all golden outputs identical`. The
   goldens are `tools/harness/golden/` (demo mesh, and `pen_files/arches.pen`, a local untracked file
   the user has; the run skips it if absent). Never re-capture goldens to make a step pass. If a
   step *intentionally* changes output (there is none planned below), re-capture in its own commit
   with the reason in the message.
2. **Never reorder floating-point work** in `js/worker/*` or in the chaining/merge passes of
   `svg-export.js` (`chainSegments`, `mergeSilhouetteClose`, `chainByRun`, `mergeContourRunSplits`,
   `mergeAdjacentTouching`, `mergeCreaseScreenSpace`, `splitSelfTouching`, `simplifyCollinear`,
   `trimContourFoldbacks`, `dropRedundantContourSlivers`, `subtractCovered`, `dedupCollinear`,
   `dedupCrossRunCoincident`). A "harmless" change of loop order, tie-break, or accumulation order
   changes the SVG. Moving a function between files is fine; editing its body is not, unless the
   goldens prove it neutral.
3. **Do not rename persisted keys.** These are written into `.pen` files and clipboard payloads and
   must keep loading old files:
   - layer keys `so iv ih sv sh cv ch h1 h2 h3 cr` (`sv/sh` mean *Contour*, historically
     "silhouette visible/hidden"; document, don't rename)
   - every control id that `gatherSettings`/`sceneSettingIds` reads (they are the `settings` keys in a
     `.pen`), including the suffixed per-layer texture ids `texOvershootMin_h1` etc.
   - pen ids `p1…`, dash keys `D1…`, block fields (`layerPaths`, `layerVisible`, `overrideStyle`,
     `freezeOffX/Y/Scale`, `bboxLocal`, `x y rotationDeg scale`), `penumbraScene: 1`,
     `penumbraClipboard: 1`.
   A format change is allowed only with a version bump (`penumbraScene: 2`) plus a migration that
   loads every older version. Test with a `.pen` saved before the pen library existed (the user has
   them) and with `arches.pen`.
4. **Module discipline (from Phase 3).** A module's top level only declares. Every side effect lives in
   its exported `init…()` called from `js/app.js`. No `typeof x === 'function'` guards. Cross-module
   writes go through exported setters. `tools/harness` imports the real modules in Node through
   `tools/harness/app-env.mjs`; if you move or rename an exported declaration, the harness fails at
   link time — update `tools/harness/app.mjs` / `svg.mjs` imports.
5. **No new code that switches on `h1 / h2 / h3 / cr` literals**, no new DOM cloning by id suffix, no
   new `HATCH_ANGLE_OFFSET`-style tables. Phase 4 removes the existing ones.
6. **Don't re-propose splitting only the Contour part of `generate()`** — it was specced and declined
   (2026-09-13). Decomposing the *whole* of `generate()` is a Phase 5 item the user decides on.
7. Keep the CSS conventions in `CLAUDE.md` (tokens, shared classes, no one-off rules, no inline styles).
8. No build step, no `package.json`, no bundler, three.js stays r128 from the CDN as a classic script.
9. Testing split: the node harness is run by the model; **all browser testing is done by the user** —
   hand over a short checklist after each phase, listing what the harness could not cover (anything
   UI, and the Smooth-shading buffer path).
10. Commit per step, message ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
    (or the model in use). Work on branch `cleanup`; `pen_files/` stays untracked (the user declined
    a `.gitignore`).
11. Tooling gotchas on this machine: `sed -i` strips CR from CRLF files (all `js/*.js` are CRLF in the
    working copy); use `perl -pi` or the Edit tool. In `perl -pi -e "..."` inside bash, `$(` inside the
    replacement is interpolated — use single quotes or escape.

---

## 2. Where things stand after Phase 3

- `index.html` loads `three.min.js` (classic) and `js/app.js` (module). `app.js` calls, in order:
  `buildPerLayerTextureTabs, initSegPills, bootWorker` (main.js), then `initViewport3d,
  initPaperPreview, initSvgExport, initPanelControls, initPenLibrary, initLayoutCanvas, initSceneIO`.
  `initSceneIO` ends by posting `demo` to the worker (the boot) and dynamically imports
  `js/debug/shading-diagnostics.js` when the URL has `?debug`.
- Setters that exist for cross-module writes: `setActiveTab` (panel-controls), `setActiveSheet`
  (paper-preview), `setSavedViews` (viewport3d), `replaceBlocks` (layout-canvas), `generateFinished`,
  `generateFailed`, `setLastResult` (panel-controls), `takePendingSceneImport`, `takePendingSoIvExport`
  (scene-io), `syncSplitDashChoiceFromDom` (pen-library), `bootWorker` (main).
- Shared helpers added in Phase 2: `svgEl`/`SVG_NS`, `downloadFile`, `isTextEntryTarget`/
  `isFormControlTarget` (main.js); `pxPerMm`, `readWobbleParams`/`readGapParams` (svg-export.js);
  `blockTransformAttr` (layout-canvas.js); `occluderHitDet`/`occluderDepthAt`, `refineSplits`,
  `forEachCarrierOnFace` (worker/solver.js).
- File sizes: svg-export.js ≈2900, solver.js ≈2950, layout-canvas.js ≈2400, viewport3d.js ≈1030 lines.

### 2.1 The two planned features Phase 4 must prepare for (user's words, before Phase 3)

1. **A flexible hatch-layer system**: instead of the fixed Hatch / Crosshatch / Deep shadow / Circles
   set, the user adds only the fill layers they want, possibly several of one type. **Every setting is
   per instance** — pen, dash, angle, min and max spacing, "below" threshold, and (for circles) the
   centre — nothing shared between instances. New shading types will be added later and must slot in.
2. **A texture stack on every layer** (edge layers included), like modifiers in Blender: each layer
   carries an ordered list of user-added texture "filters" (trim/extend, overshoot, spacing jitter,
   angle jitter, wobble, regular wobble, gaps, and later more), each with its own parameters. **There
   are no global texture settings any more**: a layer with an empty stack has no texture, which is the
   default; today's "General" panel and "Individual texture settings" toggle disappear.

Neither is to be *built* now; the code must be shaped so that both are additive later. Concretely
(agreed with the user): layer instances `{ id, type, on, pen, dash, ...perInstanceSettings,
texture: [ ...filters ] }`; the worker takes an array of pass descriptors instead of `hatch.p1/p2/p3`;
the texture module applies a stack to geometry given by kind, not by layer key.

---

## 3. Phase 4 — settings registry and layer-instance model

The largest remaining design change. Do it in the sub-steps below, each output-neutral and committed
separately. Total: expect 4–6 commits.

### 4a. Settings registry (`js/settings.js`, new) — DONE 2026-09-15

Done as specified below. Notes for later steps: the preset ladders and `fmtBigCount` now live in
`settings.js` (panel-controls imports them); `sceneSettingIds()` is registry order, not DOM order (the
`.pen` settings block's key order changed, loading is order-independent); `applyImportedScene` runs
`restoreHooks()` once after the layer rows and camera are restored, so `updateTexLayerTabVisibility`
now sees the restored layer checkboxes (it used to run before them). `perLayer` entries and
`settingElementIds` exist only to carry the `_h1…_cr` clones until 4b removes them.

**Problem before 4a.** Every setting lives only in its `<input>`; `gatherSettings` (panel-controls.js) reads
~40 elements; `sceneSettingIds` (scene-io.js) is `[data-regen]` ids plus a hand-kept list; the value
label formatting is two hand-written if-chains (`refreshValLabel`, `valUnitFor`); after a scene import
`applyImportedScene` hand-calls twelve sync functions because setting `.value` fires no events.

**Build** one table, one entry per control:

```js
// js/settings.js
export const SETTINGS = [
  { id:'fovDeg',        kind:'range', regen:true, unit:'°',  decimals:0 },
  { id:'camShiftX',     kind:'range', regen:true, unit:'',   decimals:2, clearsView:true },
  { id:'shadowBudget',  kind:'range', regen:true, presets:SHADOW_BUDGET_PRESETS },
  { id:'paperSize',     kind:'select', regen:false, onChange:'paper' },
  { id:'marginIndependent', kind:'checkbox', regen:false, onRestore: syncMarginMode },
  ...
];
```
Fields: `id` (the element id — this *is* the persisted key, unchanged), `kind`, `regen` (replaces the
`data-regen` attribute), `unit`/`decimals`/`presets` (replaces `refreshValLabel` + `valUnitFor`),
`onRestore` (the function `applyImportedScene` currently calls by hand for that control),
`light`/`rotAxis`/`camshift` flags (replace the `data-*` attributes read in the `[data-regen]` listener).

Derive from it: `formatValue(entry, value)`; `sceneSettingIds()` = entries with `scene !== false`;
the regen listener wiring in `initPanelControls`; `applyImportedScene`'s loop, which becomes "set value,
then call `entry.onRestore` if present". Keep `gatherSettings` reading `$()` for now (it is
harness-tested and byte-sensitive); only replace its *inputs* in 4c.

Pitfalls: `refreshValLabel` has special cases (`contourCleanup` 4 decimals no unit, `contourMaxHops`
integer, `layoutOverlayOpacity` %, `texCirclesThr` 2 decimals, `hatchM*` mm, `*Thr` no unit) — encode
each as an entry, then diff the rendered labels against the old function on every id before deleting
it. The per-layer texture clones (`texOvershootMin_h1`) are *not* entries; 4b removes them.

### 4b. Layer-instance model (`js/layers.js`, new; replaces `LAYERS` in main.js) — DONE 2026-09-15

Done, with these deliberate differences from the sketch below:
- **Fill settings are not on the instance yet.** Angle, spacing, threshold and circles centre stay the
  global controls until 4d. Hatch instances carry a transitional `angleOffsetDeg` (0/90/45, replaces
  `HATCH_ANGLE_OFFSET`); the family angle is `hatchAng + angleOffsetDeg` (`hatchFamilyAngleDeg`). A
  `.pen` v2 saved before 4d has `angleOffsetDeg` and the global `hatchAng` setting; the 4d loader must
  turn that into `angleDeg = hatchAng + angleOffsetDeg`.
- **Texture is a stack** as specified (`texture: [{type, ...params}]`, `TEXTURE_FILTERS` lives in
  `layers.js` for now with the parameter schema; the implementations stay in `svg-export.js`). `onResult`
  still runs the fixed pipeline and looks each effect up with `stackEntry(stack, type)`; the editor keeps
  one entry per type, inserted at its pipeline position, so list order equals application order. 4e
  replaces this with `applyTextureStack`.
- **The instance is the state.** `layerEls` is a view rebuilt by `buildLayerRows()` (boot and scene
  import); row listeners write into the instance, `applyLayerStyle(id)` renders the instance back.
  `layerStyle(id)` reads the instance. `L.key` is `L.id`.
- **UI:** the Texture tab's General/Texture/H1…C sub-tabs are gone; the tab shows the global Hatching and
  Circles controls, then a Texture section: a layer dropdown (fill layers), the selected layer's filter
  entries (slider rows + remove), and an "+ Add filter…" dropdown offering what the layer's geometry
  supports. Module `js/texture-stack.js`.
- **Persistence:** `penumbraScene: 2` writes `layers` as the instance array. `sceneLayers(data,
  resolvePen)` (layers.js) loads v1 and v2; v1 fill stacks come from `v1TextureStack`, which coerces a
  missing/unparseable number to 0 so the reader's `|| fallback` reproduces the old `+el.value || fallback`
  read exactly. The texture ids (`texOvershootOn`, `_h1`…) are no longer controls or saved settings.
- **Verified:** besides verify-golden (which never runs `onResult`'s texture code), a scratch script ran
  the pre-4b and post-4b `onResult` on real worker results (arches + demo with circles), seeded
  `Math.random`, over 84 texture configurations (as saved, all off, 40 random General/Individual mixes
  per scene incl. missing ids), each via v1 load and via a v2 save/load round trip: every layer's path
  `d`, group order and status text identical (168/168; a perturbed seed shows 138 differences).

```js
export const LAYER_TYPES = {
  // edge layers: singletons, id === persisted key, no texture yet (see 4e)
  so: { kind:'edge', name:'Silhouette' }, iv: { kind:'edge', name:'Silhouette individual' }, ih: …,
  sv: { kind:'edge', name:'Contour' }, sh: …, cv: { kind:'edge', name:'Crease' }, ch: …,
  // fill layers: instances
  hatch:   { kind:'fill', name:'Hatch',   geometry:'lines' },
  circles: { kind:'fill', name:'Circles', geometry:'arcs'  },
};
export const layers = [ /* ordered, highest priority first — the LAYERS order today */
  { id:'so', type:'so', on:false, pen:'p1', dash:'solid' },
  …
  // fill instances carry EVERY fill setting themselves (nothing shared) — values below are today's
  // global defaults, so the migrated scene solves identically
  { id:'h1', type:'hatch',   on:true,  pen:'p5', dash:'solid', angleDeg:45,  minSpacing:1, maxSpacing:7, threshold:0.92, texture:[] },
  { id:'h2', type:'hatch',   on:true,  pen:'p5', dash:'solid', angleDeg:135, minSpacing:1, maxSpacing:7, threshold:0.45, texture:[] },
  { id:'h3', type:'hatch',   on:false, pen:'p5', dash:'solid', angleDeg:90,  minSpacing:1, maxSpacing:7, threshold:0.18, texture:[] },
  { id:'cr', type:'circles', on:false, pen:'p5', dash:'solid', minSpacing:1, maxSpacing:7, threshold:0.92, centerX:0, centerY:0, texture:[] },
];
```
- **Texture is a stack**: `texture` is an ordered array of filter entries `{ type, ...params }`, e.g.
  `[{ type:'overshoot', min:-2, max:1 }, { type:'wobble', spacing:1, amp:0.5, variation:0, varScale:10,
  shared:false }, { type:'gaps', spacing:30, max:2 }]`. Empty array = no texture (the default for every
  layer, edge layers included). Filter types and their params are a registry (`TEXTURE_FILTERS` in
  `hatch-texture.js` after Phase 5): `trim {value}`, `overshoot {min,max}`, `spacingJitter {min,max}`,
  `angleJitter {min,max}` (lines only), `wobble {spacing,amp,variation,varScale,shared}`,
  `regularWobble {amp,wavelength}` (lines only), `gaps {spacing,max}`. Each type declares which
  geometry kinds it supports (`lines`, `arcs`) — today's `data-skipforcircles` becomes that flag.
- **Order of application is the stack order.** Today's fixed pipeline order (trim → overshoot →
  spacing jitter → angle jitter → wobble → regular wobble → gaps, see `onResult`) becomes the order in
  which the *migrated* stack is built, so a scene with several effects on solves as before; a user
  may reorder later.
- **UI**: the Texture tab becomes a per-layer stack editor: pick a layer (or reach it from its row),
  "+ Add filter" chooses a type, each entry shows its own controls, can be removed and reordered.
  Delete the General/Individual concept entirely: `texIndividualOn`, `buildPerLayerTextureTabs`,
  `baseTexId`, `valLabelId`'s suffix logic, `texId()`, `TEXTURE_LAYER_KEYS` loops,
  `seedLayerTextureSettings`, `updateTexLayerTabVisibility`, `selectTexTop`, and the `_h1/_h2/_h3/_cr`
  ids. The Circles centre gizmo and `texCirclesThr` move to the circles instance's own settings.
- **Persistence**: `.pen` version 2 writes `layers` as this array (stack included). Loader for
  version 1: rebuild instances from `layers[key] = {on, pen, dash}` plus the old globals
  (`hatchAng` + 0/90/45 → `angleDeg`, `hatchMin/hatchMax` → spacing, `hatchThr/crossThr/deepThr/
  texCirclesThr` → threshold, `texGroundPatternCenterX/Y` → circles centre), and build each fill
  instance's stack from the texture settings that were *enabled* — General's (`texOvershootOn` …) when
  `texIndividualOn` was false, the suffixed per-layer ids (`texOvershootOn_h1` …) when true. Effects
  that were off produce no entry. Edge layers get `[]`. Blocks (`layerPaths` keyed by layer id) and
  clipboard need no change as long as ids `h1 h2 h3 cr` stay.
- **Readers to migrate** (grep `LAYERS`, `layerEls`, `layerStyle`, `HATCH_ANGLE_OFFSET`,
  `TEXTURE_LAYER_KEYS`): svg-export.js (row building, `onResult`, `buildPenPathsExport`),
  panel-controls.js (`gatherSettings`, `syncLineLayerUI`, texture tabs), pen-library.js
  (`refreshPenSelects`, `deletePen`), layout-canvas.js (`createBlockDom`, `updateBlockStyle`,
  `computeLayoutStats`, context menu), scene-io.js (save/load), paper-preview.js
  (`ENDPOINT_DOT_LAYERS`), tools/harness/app.mjs (`layerEls` fakes → set `layers[i].on`).
- Keep `layerEls` (the row DOM) but key it by instance id; `layerStyle(id)` keeps returning
  `{on, color, width, dash}`.

### 4c. Worker input as pass descriptors — DONE 2026-09-15

Done as specified, with these details:
- `passes` holds only ENABLED fill layers (a pass is work to do), built by `fillPasses` in
  panel-controls.js: hatch `{id, type, angleDeg, thr}`, circles `{id, type, thr, centerX, centerY}` (centre
  already in worker px). `S.hatch` keeps only what every pass still shares: `minS, maxS, softShadowsOn,
  cap`. `types`, `circlesOn`, `circlesThr`, `groundPatternCenterX/Y` and `layerOn.h1…h3` are gone.
- Thresholds are still the global sliders: each fill instance names its slider in a transitional
  `thrControl` (layers.js, saved in v2 files and validated on load), beside 4b's `angleOffsetDeg`. The
  4d loader turns both into per-instance values.
- Worker: `groups`/`hatchCarrier` get one key per hatch pass (a disabled hatch layer no longer has an
  empty group in the result); the hatch loop maps `hatchPasses` to its old internal `{key, ang, thr}`
  shape, so the loop body is untouched. Circles draws the FIRST circles pass only — the result still
  has one `circlePatternSegs` list; 4d must key it by id before allowing a second circles instance.
  `legacyFillPasses(S)` rebuilds the classic passes for a blob without `passes`.
- Verified: verify-golden identical; a scratch script ran the old gatherSettings + old worker against
  the new ones over 72 random configurations (layer subsets, soft/cast/ground/invert, angle, thresholds,
  spacing, centre, cap presets, forced low caps; arches + demo) and also fed the old settings shape to
  the new worker: 144/144 identical results (groups, carriers, runIds/seqs, circle pieces, counts).

Today `gatherSettings` sends four overlapping encodings (`types.c`, `layerOn`, `hatch.p1/p2/p3`,
`circlesOn`) and the worker hard-codes three passes (`solver.js`: `passes.push({key:'h1', ang:S.hatch.ang,
thr: castOnly ? SHADOW_ONLY_THR : S.hatch.hatchThr})`, `+90`/`crossThr`, `+45`/`deepThr`) plus
`HATCH_ANGLE_OFFSET` in svg-export.js.

Send instead:
```js
layerOn: { so, iv, ih, sv, sh, cv, ch },                      // edge layers (unchanged)
passes: [                                                     // fill layers, in layers[] order
  { id:'h1', type:'hatch',   angleDeg: hatchAng + 0,  thr: hatchThr },
  { id:'h2', type:'hatch',   angleDeg: hatchAng + 90, thr: crossThr },
  { id:'h3', type:'hatch',   angleDeg: hatchAng + 45, thr: deepThr },
  { id:'cr', type:'circles', thr: texCirclesThr },
],
```
In the worker: `groups`/`hatchCarrier` keyed by pass id; the hatch loop iterates `passes` filtered to
`type==='hatch'` **in the same order as today** (`hatchTotal`/`capped` are shared across passes, so
order affects the cap); `castOnly` applies `SHADOW_ONLY_THR` per pass as now; the circles block reads
its pass. `wantC = layerOn.cv || layerOn.ch` replaces `S.types.c`. Keep the literal defaults the
worker falls back to for settings blobs that lack a key (older harness scenes) — several exist
(`contourCleanup`, `contourMaxHops`, `S.hatch.cap`, `S.shadow.budget`); add one for `passes`
(rebuild the three classic passes when `S.passes` is absent). The export metadata comment
(`JSON.stringify(gatherSettings())`) changes shape; that comment also carries a timestamp, so it was
never byte-stable and the harness ignores it.

Byte-identity check: the demo golden covers h1/h2/h3 with cast shadows; the arches golden covers ground
shadow too. Run both after this step.

### 4d. Dynamic fill layers (the user's feature 1) — DONE 2026-09-16

Done as specified, with the user's answers on the open UI questions:
- **Settings inline under the row.** Each fill row has a disclosure triangle; opening it shows that
  layer's own sliders (`LAYER_TYPES[type].settings` drives them, `.layerSettings` under the row). One row
  open at a time; the circles centre gizmo follows the open circles layer, else the first enabled one.
- **Row actions: duplicate, delete, drag-reorder.** No rename — names are derived (`layerName`): the
  type plus the layer's number among its type, so deleting renumbers. The three hatch layers are now
  "Hatch 1/2/3", not Hatch/Crosshatch/Deep shadow; only their names changed, their angles and thresholds
  are the same values those layers always solved with.
- **"+ Add layer" offers each fill type**, any number of each; a new layer starts at its type's fixed
  defaults (hatch 45°, 1–7mm, 0.92), not a copy of a neighbour.
- **Angle range is 0–360, not 0–180.** A family's carrier lines at 217° are anchored from the opposite
  end of the drawing than at 37°, so wrapping into a half turn moves the lines; scenes whose global angle
  plus offset exceeded 180 need the wide range to migrate to exactly what they drew. The harness caught
  this: 21 of 144 configurations differed until the clamp was removed.
- **Worker:** spacing is per pass (`minS`/`maxS` assigned at the top of the pass loop, read by the
  carrier walk and the closures defined above it); every circles pass draws, and `circlePatternSegs` is
  keyed by layer id.
- **Deleting a layer also drops its frozen ink from existing Layout blocks** (`createBlockDom` builds
  groups from the current layers), since there is no longer a layer to take the pen/dash from.
- **Verified:** verify-golden identical; the old-vs-new worker comparison (72 random configurations,
  each also fed through the version-1 migration into per-layer settings) 144/144 identical; the texture
  comparison against the pre-4b `onResult` still 168/168; plus a new check with 5 hatch + 2 circles
  layers confirming per-layer settings reach the worker and a version-2 save/load round trip reproduces
  the same result exactly.

After 4b/4c this is additive: an "+ Add layer" control on the Lines tab offering the fill types, a delete
button per fill row, `layers.push({ id: nextFillId(), type, …defaults })`, drag-reorder among fill rows
only (edge rows keep their fixed hierarchy above). Every fill setting is per instance and edited on
that instance (a per-row expander or popover): pen, dash, angle (absolute — default instances get
45/135/90 to reproduce today's "global angle + 0/90/45 offset" exactly), min and max spacing, "below"
threshold, and for circles the centre (the on-canvas gizmo then belongs to the selected circles
instance). The old global `hatchAng`, `hatchMin`, `hatchMax`, `hatchThr`, `crossThr`, `deepThr`,
`texCirclesThr`, `texGroundPatternCenterX/Y` controls go away from the panel (their ids survive only in
the version-1 loader). New instance ids must not collide with persisted keys (`f1, f2, …` is fine;
never reuse an id in a session). `.pen` version 2 is required here. The cascade `HIER` in `generate()`
excludes hatch already; keep it so.

Worker consequence: `minS`/`maxS`, the carrier family `c0` anchor and the `lineVis` map in the hatch
block are currently computed once per generate from the global spacing; with per-instance spacing they
move inside the per-pass loop (one carrier family per pass). Only the *sharing* changes — with equal
values per pass the arithmetic is identical, which the goldens confirm.

Only start 4d once 4a–4c are green and the user asks for it.

### 4e. Texture as a function of geometry (the user's feature 2, groundwork) — DONE 2026-09-15

Done, ahead of 4d (4e did not depend on it). Differences from the sketch below:
- Signature `applyTextureStack(input, stack, ctx)`: `input` is a tagged representation, not a flat array,
  because Circles must stay arcs (emitted as Béziers) unless wobble turns them into polylines, and hatch
  starts as segments plus carrier indices. Reps: `segments {segs, carrier}`, `arcs {pieces}`,
  `polylines {polylines, closed}`. `ctx = {geometry, mmToPx, familyAngleDeg}`. Implementations are
  `TEXTURE_IMPL[type][rep]`; segments are converted to 2-point polylines when a filter only has a
  polylines implementation, and at the end.
- **Line jitters are one step.** Overshoot, spacing jitter and angle jitter on segments share per-carrier
  random draws and apply rotate → shift → overshoot, so they run as one combined step
  (`applyHatchTexture`) at the first of them in the stack. Splitting them into independent passes is an
  intended output change (different random draws, slightly different geometry) — do it in its own
  commit, if and when the stack becomes user-reorderable. The editor inserts entries at their
  `TEXTURE_FILTERS` position, which keeps the three adjacent.
- Closed-path rule implemented as proposed: a one-to-one filter passes `closed` through, gaps returns
  `closed: null` (all open).
- Edge layers: not wired. `applyTextureStack` accepts their polylines (rep `polylines`, geometry null → every
  filter skipped, input returned as is), but the chaining functions still write straight into `d`
  (`appendPolylineD`), so feeding their output through it needs those functions to hand back polylines
  first. That is the remaining plumbing for feature 2, and it touches ground-rule-2 functions.
- Verified: the 4b scratch comparison (pre-4b onResult vs now, 84 texture configurations × v1/v2 load)
  still 168/168 identical; verify-golden identical.

In svg-export.js `onResult`, the hatch branch and the circles branch each read texture settings and
apply a fixed pipeline. Restructure into one entry point used by both:

```js
applyTextureStack(pieces, geometryKind /* 'lines' | 'arcs' */, stack, mmToPx) -> polylines
```
which walks the instance's `texture` array in order and dispatches each entry to its filter's
implementation for that geometry kind (`TEXTURE_FILTERS[type].apply[geometryKind]`); a filter that does
not support the kind is skipped. An empty stack returns the input untouched. Edge layers already produce
polylines (`pts` arrays of `[x,y]`) at the end of `buildChainedPathD` / `appendContourPathD` /
`appendCreasePathD`; converting those to the flat `[x0,y0,x1,y1,…]` form the filters take, and back, is
the only plumbing left for feature 2. Do NOT apply anything to edge layers in this phase (their stack is
`[]`, output identical); just make the call possible. Watch closed paths: edge layers emit `Z`; the
filters today only ever see open hatch strokes, so closed polylines need an explicit rule (probably:
a filter that opens a path, such as gaps, drops the `Z`; the rest keep it).

### Phase 4 verification

`verify-golden` after each sub-step. Browser after 4a (every slider label reads the same as before;
scene import restores every control including margins, page colour, smooth angle), 4b (texture tabs,
General/Individual toggle, per-layer values survive save/load, old `.pen` files load), 4c (nothing
visible changes), 4d/4e (the new UI).

---

## 4. Phase 5 — split the big files — DONE 2026-09-17/18 (worker declined)

Done as specified below, 13 commits, with these decisions and deviations:
- **The worker's `generate()` was NOT split** — the user declined it at the start of the phase, as the
  last bullet allows. `js/worker/solver.js` is untouched by Phase 5.
- **`main.js` was left alone** (no `pens.js`): at ~200 lines it is already coherent, and the plan's
  keep-list had no home for `positionSegPill`/`initSegPills`/`onMiddleDblClick`.
- **`TEXTURE_FILTERS` stayed in `layers.js`**; only the implementations became `hatch-texture.js`, so the
  data model does not import from a rendering module.
- **No re-export barrel**: `svg-export.js` and `layout-canvas.js` are gone, every importer was rewritten,
  and the remainder of each was renamed (`layer-rows.js`, `layout-model.js`).
- `initSvgExport` became `initLayerRows` + `initPaperLayout` + `initExport`, and `initLayoutCanvas`
  became `initLayoutModel` + `initLayoutList` + `initLayoutInteraction` + `initLayoutClipboard`, called
  from `app.js` in the order those listeners were registered in before — which matters for the
  document-level ones (the list's context-menu pointerdown and keydown must precede the canvas
  shortcuts). Also `initSavedViews`.
- **Four small non-pure-move edits in the Layout split**, each replacing a cross-module assignment with a
  named helper: `nextBlockId()` and `setBlocks()` (layout-model.js), `setSelectionAnchor()` and
  `resetHoverCursor()` (layout-interaction.js). One `keydown` listener became two adjacent ones
  (Escape-closes-menu in layout-list.js, the nudge/delete/select-all shortcuts in
  layout-interaction.js). Everything else moved byte-for-byte.
- `viewport3d.js` now exports `renderer` and `scene` (read, never written, by shading-capture.js).
- **Verification**: every commit ran the link check and `verify-golden` (identical throughout). Because
  the goldens never run `onResult`, the svg-export commits were also checked with a render comparison
  against the pre-split tree — both trees' `onResult` over the same worker result, `Math.random` seeded
  alike, comparing every layer's path `d`, group order and the status text: 60/60 identical over demo +
  `arches.pen` × 30 texture configurations (a skewed seed makes it fail, so it does compare geometry).
  The Layout and viewport files have no headless coverage and were browser-tested by the user.

Original plan follows.

Pure moves. One file per commit; no edits to function bodies. After each move: node link check
(`node --input-type=module -e "import './tools/harness/app-env.mjs'; await import('./js/scene-io.js')"`),
`verify-golden`, and fix the harness import lines.

Target layout:

- `svg-export.js` → `layer-rows.js` (layer row DOM, dash editor, `layerEls`, `layerStyle`,
  `applyLayerStyle`), `paper-layout.js` (`PAPERS`, `getMargins`, `computePaperLayout`, `pxPerMm`,
  `baseSheetSize`, `renderPaper`, trim mask, page/guide colour), `chain.js` (every chaining/merge
  function and their constants — the harness's `svg.mjs` imports these), `hatch-texture.js` (noise,
  wobble, gaps, trim, overshoot, the circle variants, `applyTexture` from 4e), `path-model.js`
  (`parsePathD`, `emitPathD`, `segsWithClose`, `bezSplit`, `segSub`, `segLengthTable`,
  `splitDashedPathD`, `computeDStats`, margin clip: `matMul`… `trimCloneToMargins`),
  `render-result.js` (`onResult`, `refreshStatusR`, `lastLiveStats`), `export.js`
  (`buildPenPathsExport`, `penExportId`, the Export button handler — currently inline in
  `initSvgExport`; make it a named `exportSvg()` when moving).
- `layout-canvas.js` → `layout-model.js` (blocks, transforms, `computeLayoutStats`, `replaceBlocks`,
  DOM per block), `layout-interaction.js` (hit test, snapping, pointer handlers, guides, labels),
  `layout-list.js` (rows, drag-reorder, context menu), `layout-clipboard.js`.
- `viewport3d.js` → `viewport3d.js`, `saved-views.js`, `shading-capture.js`.
- `main.js` keeps only `$`, `svgEl`, `downloadFile`, focus guards, `APP_VERSION`, `bootWorker`; layer
  and pen/dash registries move to `layers.js` (4b) and `pens.js`.
- Worker `generate()` (≈2600 lines, ~40 closures): only if the user opts in. If so, stage functions
  taking one context object `ctx` holding what the closures share (`sx sy iz ok front bright vx vy vz
  W H V P ortho nearZ occlude emit emitRun groups runIds seqs hatchCarrier counts effOffTol effGapTol
  sharedShadowMap projView COMP …`), extracted in pipeline order: projection + occluder grid,
  `occlude`, crease (6.1–6.2), contour (6.3–6.8), silhouette (6.9), circles (7), hatch (8), cascade
  (dedup passes, 9). Mutable counters (`hatchTotal`, `capped`, `gen`, `stamp`) must live on `ctx`.
  Every stage move is a golden check.

Update `CLAUDE.md`'s module list and each file header as you go.

---

## 5. Phase 6 — naming

After Phase 5 (so the harness link check catches every miss). §5.1 is the user's own decision and the
main piece of work; §5.2 is the rest of the audit; the table in §5.3 is the original list.

### 5.1 One word per concept: a Layout "layer" becomes a **block**, in the UI too

Decided 2026-09-18. The app has two unrelated things called "layer": the draw layers (Silhouette,
Contour, Crease, Hatch, Circles — `layers` in layers.js) and the Layout tab's frozen snapshots, which
the code has always called *blocks* while the UI called them "layers". The UI adopts the code's word.

**The distinction that makes this surgical:** inside a block, "layer" still means a DRAW layer — a block
holds one path per draw layer (`layerPaths`), each with its own visibility (`layerVisible`) and optional
pen override (`overrideStyle`). Those are persisted `.pen` keys AND correctly named; they do not change.
The right-click menu on a block lists exactly those, so its rows and its "Layers" heading stay "Layers"
as well. Only the places where "layer" means *the block itself* change.

**UI text to change** (all of it, at the time of the audit):
- `index.html`: the Preview overlay toggle title ("Show the layers saved to Layout…"); the blocks float's
  `vpLabel` heading "Layers"; the Duplicate button's `title` + `aria-label`; Delete All's `title` +
  `aria-label`; the "Rotate layers with page" checkbox label (its id `rotateBlocksWithPage` is already
  right); every row under the About dialog's `<h3>Layout tab</h3>` group (13 shortcut rows — that whole
  group is block shortcuts, and no other About group mentions layers).
- `export.js` `'no layers to export'`; `layout-list.js`'s `confirm('Delete all N layer(s)?…')`;
  `layout-model.js` `blockCountLabel` (`'N layers'`) and the default block name `'Layer NN'`;
  `layout-interaction.js`'s row-button scope label (`'all N selected layers'`).
- Check the row `aria-label`s built in `renderBlocksList` at the same time.

**Two judgement calls to settle before starting:**
1. *Old scenes keep their stored names.* A block's `name` is saved in the `.pen`, so scenes made before
   this will still show "Layer 03" next to new "Block 04"s. Recommended: leave them — a name is
   user-editable content and a migration would also rewrite names someone typed deliberately. The
   alternative (rewrite `^Layer (\d+)$` to `Block $1` on load) is a one-line change in `sceneBlocks`,
   but it is a content change, not a rename.
2. *The block context menu's heading.* It lists draw layers, so "Layers" is literally right, but it now
   sits inside a block-worded UI. Either keep it, or make it "Block layers" for readability.

**Internal names to follow the same word** (none of these are persisted — checked against
`SETTINGS`/`sceneSettingIds`): the element ids `layerContextMenu`, `layerContextMenuList`,
`layerContextOverrideChk`, `layerContextOverrideRow` (all of them are the *block's* menu) →
`blockContextMenu*`, with the matching `#layerContextMenu` selectors in `styles.css`; and
`openLayerContextMenu` / `closeLayerContextMenu` / `contextMenuBlock` / `contextMenuPos` in
layout-list.js → `openBlockContextMenu` / `closeBlockContextMenu` / …

### 5.2 Other name/meaning mismatches found in the same audit (2026-09-18)

- `#hatchLayers` (index.html) hosts BOTH hatch and circles rows since Phase 4d — rename to `#fillLayers`,
  including `host:'hatchLayers'` in `LAYER_TYPES` (layers.js), which is code, not a saved key.
- "Every line layer and Layout override draws with one of these pens" (index.html, Pen library tab) —
  fill layers use pens too; "line layer" should just be "layer".
- `splitDashBtn` and `penPathsExport` are checkboxes whose ids read like buttons, and `trimToMargins`,
  `layoutOverlayOpacity` are fine — but **all four are persisted setting ids** (`SETTINGS`), so the ids
  stay; only variables and labels may be renamed. `blendMultiplyOn` is NOT persisted and may be renamed.
- The layer-key table (`sv`/`sh` = Contour, `iv`/`ih` = Silhouette individual, `h1…h3` = the first three
  hatch layers, `cr` = the first circles layer) is persisted and stays — document it as a comment on
  `layers.js` and in `CLAUDE.md`, which was already a Phase 6 item.

**Stale row in the table below:** `texLayerEnabled` no longer exists (Phase 4b removed it). Since the
layer instance is now the state, the "one `isLayerOn(id)`" idea is mostly already true — the remaining
five callers use `layerStyle(id).on`, which could simply be `layerById(id).on` where they don't also need
the colour/width. Decide whether that is worth a commit at all.

### 5.3 The original rename list

Suggested renames, all non-persisted:

| now | proposed |
|---|---|
| `penTab` / `penModeBtn` / `data-mode="pen"` (index.html, panel-controls) | `linesTab` / `linesModeBtn` / `"lines"` |
| `texGroundPatternCenterX/Y`, `groundPatternCenterX/Y` (setting id — **persisted**, keep the id, rename only the variables/labels) | `circlesCenter*` in code |
| `wantS`, `wantC`, `wantContour` (solver) | `wantSilhouetteFamily`, `wantCrease`, `wantContour` |
| `S`, `M`, `V`, `P`, `W`, `H`, `GS` in `generate()` | `settings`, `mesh`, `view`, `proj`, `width`, `height`, `groundShadow` (only if generate() is decomposed; otherwise leave) |
| CSS `.savedView .svName .svBtn .svEye .svDelete .svRowSelected`, `.addViewBtn`, `.layer` used by unrelated widgets | `.listRow .rowName .rowBtn .rowEye .rowDelete .rowSelected`, `.headerBtn`, `.gridRow` |
| `layerStyle(k).on` / `layerEls[k].chk.checked` / `texLayerEnabled(k)` | one `isLayerOn(id)` |
| `pane2`, `pv`, `plx/ply`, `cy2`, `mi2`, `t1x`, `_gpLastPaperW` | descriptive names |
| `onResult` / `lastGen` | `renderResult` / `lastResult` |

Add the layer-key table (`sv/sh` = Contour, etc.) as a comment on `layers.js` and in `CLAUDE.md`.

---

## 6. Phase 7 — performance (output-preserving)

Each item one commit, with `verify-golden` and the solve time from `node tools/harness/run.mjs
pen_files/arches.pen --json` (prints `solve : N ms`) before/after in the message.

1. `computeLayoutStats()` re-tokenises every block's d-string on every `refreshStatusR()`. Cache
   `{segments, paths, closedPaths, lenPx}` per block per layer when the block is created/pasted
   (geometry is frozen); apply dash fraction and scale at read time.
2. String-keyed spatial hashes in `chainSegments`, `mergeCreaseScreenSpace`, `splitSelfTouching`,
   `mergeSilhouetteClose`, `dropRedundantContourSlivers`, `dedupCrossRunCoincident` (`cx+':'+cy`),
   `exactDupKey` → packed numeric keys (`Math.round(x*50)*8388608 + Math.round(y*50)` as `shadeAt`
   already does). Same rounding ⇒ same buckets ⇒ identical output. Measure first; `mesh.js` notes
   string keys were as fast for the weld.
3. `mergeContourRunSplits` pass (b) is O(N²) over open chains; `mergeSilhouetteClose` grids the same
   problem — reuse it, keeping the (distance, index) tie order so pairing is unchanged.
4. `applyLayerStyle` → `renderPreviewLayoutOverlay()` re-clones every block on every pen-colour
   `input` tick; coalesce with `requestAnimationFrame`.
5. `occlude()` allocates and sorts `order`/`merged` per call; scratch typed arrays give the same
   intervals.

---

## 7. Verification recipe (every step)

```sh
node --check --input-type=module < js/<file>.js                     # each edited file
node --input-type=module -e "import './tools/harness/app-env.mjs'; await import('./js/scene-io.js'); console.log('linked')"
node tools/harness/verify-golden.mjs                                # must end: all golden outputs identical
node tools/harness/sweep.mjs demo --compare --base contourCoincidentDedup=false   # optional: harness tools still run
```
Then the user's browser checklist: load demo + OBJ + `.pen`; Generate with every layer on; toggle each
layer; export in both modes with Split dashes / Trim on and off; Layout add/move/rotate/scale/override/
export; Save PEN and reopen; open a pre-pen-library `.pen`; Smooth shading + Circles (the one solver
path the harness cannot run); `?debug` → `testShadingBufferRoundTrip()`; console clean.

---

## 8. Open items and known leftovers

- `js/debug/shading-diagnostics.js` attaches to `worker` at import time; it is browser-only by design
  (fails to import in Node — expected).
- The Export button handler is now `exportSvg()` (export.js, Phase 5). The scene Save handler is still an
  anonymous listener inside `initSceneIO`; scene-io.js was not split, so it was left alone.
- `walkCircleSplit` (geom-utils) duplicates the `refineSplits` recursion with different seam handling —
  left as is on purpose.
- `generateRawContourEdges` recomputes `isSilTopo` and `projView`; share with `buildContourTopology` if
  the worker is ever decomposed (Phase 5 declined that, so this stands).
- `buildDashFields` / `addDashSlot` both hand-build dash markup; now both in `layer-rows.js`, still
  unfolded — Phase 5 was moves only, so this consolidation wants its own commit.
- The plan's original audit (findings A–H with file:line evidence, now partly stale line numbers) is at
  `C:\Users\Michal\.claude\plans\i-have-been-developing-graceful-walrus.md` on the user's machine.
