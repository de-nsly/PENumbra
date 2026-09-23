# PENumbra cleanup — the record (all phases done)

Written 2026-09-15 at the end of Phase 3 as a handoff, and kept up to date as each phase ran. **The
cleanup finished on 2026-09-18**: Phases 0–7 are all done. What stays useful here is the ground rules
in §1 (they govern any future change to this code, not just the cleanup), the DONE note at the head of
each phase saying what was actually built and how it differs from the plan, and §6's measurements,
which say why three performance items were declined.

The goal of the whole effort was to bring the code to the state it would be in if written from scratch
today with every feature designed in, **without changing the output** — every step verified with
`verify-golden`, plus the user's own browser testing for everything headless checks cannot reach.

Read this, `CLAUDE.md` (the current map) and the file headers, and you have everything the earlier
sessions had. Each phase section below keeps its original spec after its DONE note, so a claim can
always be checked against what was actually asked for.

---

## 1. Ground rules — what to do and what to avoid

1. **Output must stay byte-identical.** After every step run
   `node tools/harness/verify-golden.mjs` and require `RESULT: all golden outputs identical`. The
   goldens are `tools/harness/golden/` (demo mesh, and `pen_files/arches.pen`, a local untracked file
   the user has; the run skips it if absent). Never re-capture goldens to make a step pass. If a
   step *intentionally* changes output (there is none planned below), re-capture in its own commit
   with the reason in the message.
2. **Never reorder floating-point work** in `js/worker/*` or in the chaining/merge passes of
   `js/chain.js` (`chainSegments`, `mergeSilhouetteClose`, `chainByRun`, `mergeContourRunSplits`,
   `mergeAdjacentTouching`, `mergeCreaseScreenSpace`, `splitSelfTouching`, `simplifyCollinear`,
   `trimContourFoldbacks`, `dropRedundantContourSlivers`) and `js/worker/dedup.js`
   (`subtractCovered`, `dedupCollinear`, `dedupCrossRunCoincident`). A "harmless" change of loop
   order, tie-break, or accumulation order changes the SVG. Moving a function between files is fine;
   editing its body is not, unless the goldens prove it neutral.
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
   new `HATCH_ANGLE_OFFSET`-style tables. Phase 4 removed the existing ones; a fill layer's settings
   live on its instance and its type's `settings` schema drives its row.
6. **Don't re-propose decomposing `generate()`** — the Contour-only split was specced and declined
   (2026-09-13), and the user declined decomposing the whole of it at the start of Phase 5
   (2026-09-17). It stays one function unless the user reopens it.
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

## 2. Where things stood after Phase 3 (historical — see CLAUDE.md for the current state)

**Read this as a snapshot, not as guidance.** Most of the file and function names below were changed by
Phases 5 and 6: `svg-export.js` became seven files, `layout-canvas.js` four, `initSvgExport` became
three inits, `onResult` became `renderResult`. CLAUDE.md's module list is the current map; the DONE
notes in §3–§6 are what actually happened.

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

## 5. Phase 6 — naming — DONE 2026-09-18

Done in 9 commits, everything below except where noted. `verify-golden` identical at every one; nothing
in this phase touches geometry, so the risk was entirely in UI strings and DOM ids, which the user's
browser pass covers.

What differs from the spec:
- The container ids became `edgeRowsSil` / `edgeRowsContour` / `edgeRowsCrease` / `fillRows` rather than
  `#fillLayers`, which would have echoed `fillLayers()` two lines away in layers.js. They are named for
  what they hold: rows.
- The block context menu's heading reads **"Block layers"** (the user's choice) and its rows still name
  draw layers, as §5.1 required.
- Block names already in `.pen` files are left alone (the user's choice): only new blocks are "Block NN".
- `.svUpdate` turned up during the class rename and became `.rowUpdate`; `.svEmpty` → `.listEmpty`,
  `.svHeaderRow`/`.svHeaderBtns` → `.listHeaderRow`/`.listHeaderBtns` — the same family, not in the
  original table.
- `updateGroundPatternSliderRange` → `rescaleCirclesCentres` and `_gpLastPaperW/H` → `lastPaperW/H`.
  The persisted setting ids `texGroundPatternCenterX/Y` and the old wire field `S.groundPatternCenterX/Y`
  in `legacyFillPasses` keep their names — both are read from saved data.
- `cy2` → `cvy`, `t1x` → `tri1` (solver), `mi2` → `ivIdx` (dedup). Renames only, no expression reordered.
- The `S`/`M`/`V`/`P`/`W`/`H`/`GS` row was conditional on `generate()` being decomposed. It was not
  (Phase 5, declined), so they stay.
- `isLayerOn(id)` now exists in layers.js for the two id-only callers; the three that already hold the
  instance just read `L.on`. `texLayerEnabled` was already gone.

Remaining naming work: none planned. Phase 7 (performance) is next.

The spec that was worked from follows. §5.1 was the user's own decision and the main piece of work;
§5.2 is the rest of the audit; the table in §5.3 is the original list.

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

## 6. Phase 7 — performance (output-preserving) — items 1 and 4 DONE 2026-09-18, 2/3/5 measured and declined

**Everything below was measured before anything was changed** (`arches.pen`, all layers on). The
measurements are the point of this section now: they say which items were worth doing, and they are
what a future session should re-run before re-proposing the rest.

*The plan's own measurement method does not fit its own items.* `run.mjs --json` prints `m.ms`, the
worker's solve time, so it covers item 5 and nothing else: 2 and 3 are main-thread chaining, 1 is Layout
UI, 4 is DOM. Solve time also swings ±12% run to run, so a single before/after run cannot see a change
smaller than ~35 ms.

Where the time actually goes (`node --cpu-prof`, self time, arches solve ≈ 300–335 ms): `generate`'s own
loops 8.6%, GC 5.7%, the circle pattern walk (`walkCircleSplit`/`Px`/`testFnForRing`/
`buildPatternSegsFromTest`) ≈ 12%, `occlude` ≈ 3.6%. No single hotspot. The whole main-thread chaining
for the same scene is **5.2 ms** (ch 0.9, cv 0.8, so 0.8, h2 0.6, …).

1. **DONE.** Per-block, per-layer stats memoised in a WeakMap keyed by the block (not a field: the scene
   save serialises whole blocks, so a field would land in every `.pen`). Ink fraction, scale and layer
   visibility still apply at read time, and the ink fraction moved from inside `computeDStats` (a
   multiply by 1) to the same position in the caller's product, so the summed mm length is bit-identical.
   Measured against the old code on the same blocks: 10 blocks 9.3 ms → 0.1 ms per refresh, 40 blocks
   33.9 ms → 0.2 ms.
2. **Declined — not worth it.** All the chaining these would touch costs 5.2 ms on arches, and every
   function named is a ground-rule-2 function where a changed tie-break silently moves lines. Revisit
   only if a scene turns up where chaining is actually slow (re-measure with a bench like the one this
   session used: solve once, then time `layerPathD` per layer over N repeats, median).
3. **Declined — the worst of the five.** Contour chaining is 0.2 ms for 25 segments on arches, and
   reproducing the exact (distance, index) tie order through a grid is the single most likely way in this
   plan to change output. If it is ever attempted and the goldens move, abandon it — do not re-capture.
4. **DONE.** `applyLayerStyle` schedules the Preview overlay rebuild through `requestAnimationFrame`;
   `renderPreviewLayoutOverlay` cancels anything pending, so direct callers are unchanged. The burst is
   bigger than the plan assumed: `renderPaper()` calls `applyLayerStyle` once per layer, so a paper
   change rebuilt the overlay 11 times in one tick. Now: 11 requests in a tick → 1 rebuild, 8 in a frame
   → 1, one per frame over 5 frames → 5 (nothing dropped).
5. **Declined for now — below the noise floor.** `occlude` is ~3.6% of solve self time, so the ceiling is
   a few ms against ±12% run-to-run noise. If attempted, first build a repeated-run measurement (20+
   solves, compare medians); a single run cannot tell success from noise.

Original list follows.

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

---

## 9. After the cleanup — Crease chain order (2026-09-23, an intended output change)

Not a refactor: this deliberately changes `cv`/`ch` path data, and the goldens were re-captured for it.

**Symptom.** Crease paths in the exported SVG joined edges seemingly at random instead of following the
mesh. **Cause.** The worker builds Crease topology correctly (6.1 `buildEdgeChains` + `pairJunctionArms`)
and 6.2 pushes `groups.cv`/`ch` in chain-walk order — the only topology the main thread sees, since
`mergeAdjacentTouching` joins by array adjacency alone. The intra-layer `dedupCollinear` pass then
regrouped the segments by angle bucket and swept each cluster in canonical +t order, discarding that
order. On the demo mesh only 6–17% of chain neighbours stayed array-adjacent (median 25/86 indices
apart), so `mergeCreaseScreenSpace` — the fallback, which pairs "first two in array order" at a junction
— did 81–93% of the joining. In generic views the pass removed no ink at all; it only reordered.
(`subtractCovered` keeps its input order; the old comment in `chain.js` blaming it was wrong.)

**Fix.** `dedupCollinear(…, keepOrder)` (`dedup.js`): each emitted piece sorts by its input index — a
merged backbone by its lowest contributing index, drawn in that contributor's direction — and the call in
`solver.js` passes `keepOrder` for `cv`/`ch` only. `so`/`iv`/`ih` leave it off: `chainSegments` picks
chain starts in array order, so reordering them would move their output for nothing.

**Rejected alternatives (measured).** Dropping `dedupCollinear` for Crease: axis views then double-ink
(`axis+Y` cv 390 → 780 segments). Reusing `dedupCrossRunCoincident` with chain ids: ~45% of coincident
Crease ink in axis views is same-chain (a ring's near and far halves), which a cross-run pass cannot see.
Carrying `chainId`/`seq` like Contour stays the escalation path if order is ever lost again — it makes
order irrelevant, but touches the worker post, `render-result.js`, `chain.js`, `export.js` and the harness.

**Result, demo mesh, 28 sweep views.** Only `cv`/`ch` changed (54 pairs; every other layer identical);
0 gap cells in every view (the `--diff` coverage drops are sub-0.5px shifts); segment counts and pen
travel unchanged; Crease pen lifts cv 847 → 665, ch 1582 → 928. Near-axis views restore only partially
(`axis+Y` cv 35 → 36 paths): where the dedup merges heavily, a backbone absorbing two chains lands at one
chain's index. `arches.pen`, same sweep: again only `cv`/`ch` (56 pairs) and 0 gap cells, but pen lifts
are flat (cv 3468 → 3469, ch 4700 → 4698) — the join order changes there, the path count doesn't.
Both goldens re-captured. Browser-verified by the user.

**Leftovers.** 6.8's restored crease is appended after the 6.2 chains, so it still reaches its own chain
through the screen-space fallback (1 join on the demo mesh). `mergeCreaseScreenSpace` still pairs
arbitrarily at junctions; it now handles ~1% of the joins, and straightest-continuation scoring there
would be its own change.

---

## 10. Texture stacks on edge layers (feature 2, the rest of it) — DONE 2026-09-23

§2.1's second feature: a texture stack on every layer, edge layers included. §4e left the fill side
done and the edge side unwired. Built as specified below, in five commits (chain split → wiring with
empty stacks → trim/overshoot/wobble/gaps → Break at corners → Texture tab list), with these details:
- `render-result.js` always takes the piece route for edge layers (piece builder → `applyTextureStack`
  → `appendPolylineD`) rather than keeping the wrappers for an empty stack: it is the same token stream,
  and the render comparison proved it. The wrappers stay for `tools/harness`.
- Filter params may carry `decimals` for the editor's value label (default 1); Break at corners' Angle
  uses 0.
- The Texture tab now opens on Silhouette (the first layer) until a fill row is selected in the Lines
  tab, which still pushes its selection there.
- A gap the Poisson walk clamps at a closed path's end ends exactly at its seam, so a stroke may start
  there; the join rule only merges the two strokes when no gap touches the seam.
- **Verified:** `verify-golden` identical at every commit; a `renderResult` comparison (the real
  function on a recording DOM, `Math.random` seeded, demo + `arches.pen` × 30 fill-texture
  configurations, edge stacks empty) 60/60 identical against the pre-change tree at every commit (a
  skewed seed: 2/60, only the texture-free configurations); scratch invariant checks on every edge
  layer of both scenes — trim changes open lengths by exactly 2×value and leaves closed paths
  byte-identical, overshoot within bounds, a shared wobble field tears 0 of 147/226/119/115 shared
  vertices where a per-path field tears all of them, gaps never leaves two strokes meeting at a seam,
  Break at corners preserves ink length exactly and passes box / circle / L / duplicate-vertex cases.

**Already in place before this:** the stack editor's "Sync filter settings across layers" checkbox
(`texSyncParams`, a saved scene setting, `texture-stack.js`). With it on, editing a parameter writes the
same value into every layer's entry of that filter type, and a newly added filter copies an existing
entry of its type. It walks every layer, so edge layers join in with no extra work.

### 10.1 What edge geometry is

After chaining, an edge layer is a list of `{pts, closed}` polylines (`pts` = `[[x,y],…]`, the first
point never repeated, `Z` in the SVG when closed). Unlike hatch lines they are long and connected:
straight runs are simplified to 2 points, curves keep their mesh vertices. Many are closed loops
(Silhouette and Contour outlines). They share endpoints: Crease arms at junctions, Crease ending on
Contour, and the visible and hidden halves of one edge meeting where its visibility changes — the last
two are between *different layers*. And there is no family angle or carrier index.

### 10.2 Which filters apply

| filter | edges | why |
|---|---|---|
| Break at corners (**new**) | yes, edges only | splits paths into strokes at sharp turns, so the filters after it act per stroke |
| Trim / extend | yes, new `paths` impl | end extensions are the construction-line sketch look |
| Overshoot / undershoot | yes, new `paths` impl | the same, random per end |
| Spacing jitter | **no** | edges have no spacing; the only analogue, shifting a whole path, detaches it at every junction |
| Angle jitter | **no** (this round) | rotating a long path about its midpoint moves its far end by mm and detaches it at every junction |
| Wobble | yes, new `paths` impl | the hatch version would tear a polyline apart at every vertex |
| Regular wobble | **no** | depends on the hatch angle; along-path variants kink at corners, seam on closed loops, and dephase at junctions; a 2D sine field cancels on 45° lines |
| Gaps | yes, adapted | the polyline version nearly works; closed loops need care |

Angle jitter is the one to revisit: after Break at corners most strokes are near straight, and rotating
a stroke is then the classic sketchy-box look. Only the long curved strokes (no corner above the
threshold) would still misbehave. Left out of this round on purpose.

### 10.3 The filters

**Break at corners** (`breakCorners`, new; `geometry:['paths']`; one param `angle`, the turn in degrees
above which a vertex splits the path: slider 1–179, step 1, default 30, unit °).
- It is the first key of `TEXTURE_FILTERS`, so the editor always inserts it first in the stack and every
  other filter sees strokes. Nothing else reads that key order in a way this changes (the v1 loader walks
  `V1_TEXTURE_IDS`; fill layers can't hold a `paths`-only filter).
- The turn at vertex i is the angle between the incoming and outgoing directions, skipping zero-length
  neighbours (< 1e-6 px).
- Open path: split at every vertex whose turn exceeds `angle`; each piece is an open stroke sharing its
  end vertex with the next.
- Closed path: with no qualifying vertex it stays closed and untouched. With k ≥ 1, rotate the loop to
  start at a qualifying corner (so the file's arbitrary start point doesn't become an extra break) and
  split into k open strokes.
- A path whose vertices are all dense curve samples (turns under the threshold) passes through whole.

**Trim / extend** (`value`, mm).
- Open paths: positive extends each end straight out along its end segment (the first one longer than
  1e-6 px); negative walks inward by that length along the path and cuts there. A path no longer than
  2·|value| is dropped, like the hatch rule.
- Closed paths pass through unchanged — a loop has no ends, the same rule intact circles follow.
  (After Break at corners, a broken loop is open strokes, which is the point of running it first.)

**Overshoot / undershoot** (`min`, `max`, mm).
- As trim, but each end draws its own amount from [min, max]; undershoot is capped at 30% of the
  path's length (hatch caps at 30% of its segment). Closed paths skipped.
- Its own step here: on hatch it is combined with the two jitters (`applyHatchTexture`), which edges
  don't have.

**Wobble** (`spacing`, `amp`, `variation`, `varScale`, `shared`).
- Resample: every original vertex is kept (corners stay sharp) and each segment is subdivided into
  `max(1, round(len/spacing))` pieces, the hatch rule.
- Displace each point by a 2D offset: x from one noise field, y from another, each
  `(noise(p·freq + offset) − 0.5)·amp`, `freq = 1/(spacing·3)` as for hatch. Because the offset
  depends only on position within a field, two paths sharing a point in the same field move it
  identically: closed loops stay closed and junctions stay joined, with no special cases. The two axes
  being independent and equally scaled, the component perpendicular to any line direction has the same
  spread as the hatch wobble's perpendicular push, so one `amp` means the same on both kinds.
- Variation: a third noise field scales the offset, `1 − variation·(1 − env)`, as for hatch.
- `shared` keeps its fill meaning (the user's choice, option B): **on** = one random field per layer
  per render (seeds drawn once, as `readWobbleParams` does) — junctions and corner breaks within the
  layer stay joined, junctions *between* layers tear (each layer has its own seeds even when sync
  makes the parameters equal); **off** = a random field per path — every stroke wobbles independently
  and junctions tear, deliberately.

**Gaps** (`spacing`, `max`, mm).
- Reuse the Poisson interval generator (`generateGapIntervals`) over each path's arc length. A closed
  path is measured including its closing segment.
- A path that receives at least one gap becomes open strokes. On a closed path, the stroke running to
  the end of the loop and the one starting at its beginning are one continuous line (no gap at the
  seam), so they are joined into one stroke. A path that receives **no** gap keeps its `closed` flag and
  its `Z` — unlike the fill `polylines` impl, which marks everything open.

Stack order: break at corners → trim → overshoot → wobble → gaps (the `TEXTURE_FILTERS` key order).

### 10.4 Wiring

1. **Geometry kind.** Every edge type in `LAYER_TYPES` gets `geometry:'paths'`; `TEXTURE_FILTERS` adds
   `'paths'` to trim, overshoot, wobble and gaps and gains `breakCorners`. `filterSupports`, the editor's
   Filter menu and `sanitizeStack` then need nothing else; `sceneLayers` passes the edge type's geometry
   instead of `null`, so an edge layer's saved filters survive a load. No `.pen` version bump: v2 files
   already carry an edge `texture` (always `[]` so far), and an older app reading a newer file drops the
   filters it doesn't know through the same sanitizer.
2. **A new rep, `paths`:** `{ rep:'paths', paths:[{pts, closed}] }`, in the chain's own point format. The
   edge filters are `TEXTURE_IMPL[type].paths`. Fill layers never produce this rep, so their dispatch is
   provably untouched — no new `polylines` impl that a fill stack could reach. `applyTextureStack`
   returns a `paths` input as `paths`.
3. **Chaining hands back pieces.** Split each of `buildChainedPathD`, `appendContourPathD`,
   `appendCreasePathD` into a piece builder (today's body, up to where it calls `appendPolylineD`) and
   the existing function as a thin wrapper that emits the pieces. The chaining itself is not touched
   (ground rule 2); `tools/harness` keeps calling the wrappers.
4. **`render-result.js`.** Empty stack → the wrapper, exactly as today, so output is byte-identical.
   Non-empty → piece builder → `applyTextureStack` → `appendPolylineD` per path (it writes `Z` for a
   closed one and counts stats). Randomness is re-drawn per render, as for fill layers.
5. **Texture tab.** `textureLayers()` returns every layer; the "Lines" / "Fill layers" headings already
   exist in `buildLayerList`. The list needs full names: the hidden rows are named "· hidden", which
   only reads under their parent row. Add a `fullName` to `ih`/`sh`/`ch` in `LAYER_TYPES` ("Silhouette
   individual hidden", "Contour hidden", "Crease hidden") and a `layerFullName(L)` the list uses. (The
   Layout block menu shows the same "· hidden" names out of context — a candidate for the same
   function, not part of this.) Edge rows in the Lines tab stay unselectable (the user's choice); the
   Texture tab's own list is how an edge layer is picked. Update the empty-list hint and the
   `texture-stack.js` / `layers.js` / `hatch-texture.js` headers that say only fill layers apply stacks.

Everything downstream reads the rendered `d` and needs no change: Layout freeze, both export modes,
dash splitting, margin trim, the endpoint-dot debug overlay.

### 10.5 Verification

- `verify-golden` identical (every edge stack is empty).
- Render comparison, old vs new `renderResult`, demo + `arches.pen`, edge stacks empty, fill textures
  seeded: every layer's `d`, group order and status text identical.
- Scratch checks with edge filters on: Break at corners splits a box outline into its sides and leaves
  a smooth curve whole; trim/overshoot leave closed paths byte-identical; wobble with `shared` on keeps
  every within-layer junction and every closed path intact; gaps keeps `Z` on a path it skipped and
  leaves no break at a closed path's seam.
- Browser (the user): add each filter to each edge layer, sync on/off across edge + fill layers,
  save/load a `.pen` with edge filters, open an older `.pen`, export in both modes, Add to Layout.
