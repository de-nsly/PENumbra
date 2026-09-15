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
  `generateFailed`, `setLastGen` (panel-controls), `takePendingSceneImport`, `takePendingSoIvExport`
  (scene-io), `syncSplitDashChoiceFromDom` (pen-library), `bootWorker` (main).
- Shared helpers added in Phase 2: `svgEl`/`SVG_NS`, `downloadFile`, `isTextEntryTarget`/
  `isFormControlTarget` (main.js); `pxPerMm`, `readWobbleParams`/`readGapParams` (svg-export.js);
  `blockTransformAttr` (layout-canvas.js); `occluderHitDet`/`occluderDepthAt`, `refineSplits`,
  `forEachCarrierOnFace` (worker/solver.js).
- File sizes: svg-export.js ≈2900, solver.js ≈2950, layout-canvas.js ≈2400, viewport3d.js ≈1030 lines.

### 2.1 The two planned features Phase 4 must prepare for (user's words, before Phase 3)

1. **A flexible hatch-layer system**: instead of the fixed Hatch / Crosshatch / Deep shadow / Circles
   set, the user adds only the fill layers they want, possibly several of one type, each with its own
   pen, dash and texture settings. New shading types will be added later and must slot in.
2. **Texture effects on every layer**, including Silhouette / Contour / Crease — today they apply to
   fills only.

Neither is to be *built* now; the code must be shaped so that both are additive later. Concretely
(agreed with the user): layer instances `{ id, type, on, pen, dash, texture }`; the worker takes an
array of pass descriptors instead of `hatch.p1/p2/p3`; the texture module takes geometry by kind, not a
layer key.

---

## 3. Phase 4 — settings registry and layer-instance model

The largest remaining design change. Do it in the sub-steps below, each output-neutral and committed
separately. Total: expect 4–6 commits.

### 4a. Settings registry (`js/settings.js`, new)

**Problem today.** Every setting lives only in its `<input>`; `gatherSettings` (panel-controls.js) reads
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

### 4b. Layer-instance model (`js/layers.js`, new; replaces `LAYERS` in main.js)

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
  { id:'h1', type:'hatch',   on:true,  pen:'p5', dash:'solid', angleOffsetDeg:0,  thresholdId:'hatchThr', texture:null },
  { id:'h2', type:'hatch',   on:true,  pen:'p5', dash:'solid', angleOffsetDeg:90, thresholdId:'crossThr', texture:null },
  { id:'h3', type:'hatch',   on:false, pen:'p5', dash:'solid', angleOffsetDeg:45, thresholdId:'deepThr',  texture:null },
  { id:'cr', type:'circles', on:false, pen:'p5', dash:'solid', thresholdId:'texCirclesThr', texture:null },
];
```
- `texture: null` means "use the General texture settings"; an object means the instance's own (today's
  "Individual texture settings" mode gives every fill instance an object seeded from General — keep
  that exact seeding behaviour, see `seedLayerTextureSettings`).
- Texture object shape = the texture control ids without prefix/suffix: `{ trimOn, trimValue,
  overshootOn, overshootMin, overshootMax, spacingOn, …, gapsOn, gapsSpacing, gapsMax }`. Circles
  ignore `angle*` and `regWobble*` (today's `data-skipforcircles`).
- **UI**: the texture panel becomes ONE set of controls bound to "the selected instance" (or General),
  re-filled from the model when the tab/instance changes, writing back on input. Delete
  `buildPerLayerTextureTabs`, `baseTexId`, `valLabelId`'s suffix logic, `texId()`, `TEXTURE_LAYER_KEYS`
  loops, `seedLayerTextureSettings` (becomes a model copy), and the `_h1/_h2/_h3/_cr` ids. The
  General/Individual toggle stays as UI, mapped onto `texture: null | {…}`.
- **Persistence**: `.pen` version 2 writes `layers` as this array. Loader for version 1: rebuild
  instances from `layers[key] = {on, pen, dash}` and from the suffixed `settings` ids
  (`texOvershootMin_h1` → `h1.texture.overshootMin`) when `texIndividualOn` was true. Keep writing the
  General texture values under their existing `settings` ids. Blocks (`layerPaths` keyed by layer id)
  and clipboard need no change as long as ids `h1 h2 h3 cr` stay.
- **Readers to migrate** (grep `LAYERS`, `layerEls`, `layerStyle`, `HATCH_ANGLE_OFFSET`,
  `TEXTURE_LAYER_KEYS`): svg-export.js (row building, `onResult`, `buildPenPathsExport`),
  panel-controls.js (`gatherSettings`, `syncLineLayerUI`, texture tabs), pen-library.js
  (`refreshPenSelects`, `deletePen`), layout-canvas.js (`createBlockDom`, `updateBlockStyle`,
  `computeLayoutStats`, context menu), scene-io.js (save/load), paper-preview.js
  (`ENDPOINT_DOT_LAYERS`), tools/harness/app.mjs (`layerEls` fakes → set `layers[i].on`).
- Keep `layerEls` (the row DOM) but key it by instance id; `layerStyle(id)` keeps returning
  `{on, color, width, dash}`.

### 4c. Worker input as pass descriptors

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

### 4d. Dynamic fill layers (the user's feature 1, UI part only)

After 4b/4c this is additive: an "+ Add layer" control on the Lines tab offering the fill types, a delete
button per fill row, `layers.push({ id: nextFillId(), type, … })`, drag-reorder among fill rows only
(edge rows keep their fixed hierarchy above). Per-instance fields the UI must expose: pen, dash,
angle (absolute, replacing "global angle + fixed offset": default instances get 45/135/90 to reproduce
today's output exactly — and note `hatchAng` then becomes per-instance, with the slider moving to the row
or a per-row popover), threshold (per instance, replacing `hatchThr/crossThr/deepThr`), texture
(own/inherit). Min/Max spacing and the Circles centre stay global for now. New ids must not collide
with persisted keys (`f1, f2, …` is fine; never reuse an id in a session). `.pen` version 2 is required
here (thresholds/angles move from `settings` into the instance). The cascade `HIER` in `generate()`
excludes hatch already; keep it so.

Only start 4d once 4a–4c are green and the user asks for it.

### 4e. Texture as a function of geometry (the user's feature 2, groundwork)

In svg-export.js `onResult`, the hatch branch and the circles branch each read texture settings and
apply a pipeline. Restructure into one entry point used by both:

```js
applyTexture(pieces, geometryKind /* 'lines' | 'arcs' */, texture, mmToPx) -> polylines
```
where `texture` is the resolved object from 4b (instance's own or General). Edge layers already produce
polylines (`pts` arrays of `[x,y]`) at the end of `buildChainedPathD` / `appendContourPathD` /
`appendCreasePathD`; converting those to the flat `[x0,y0,x1,y1,…]` form the texture functions take, and
back, is the only plumbing left for feature 2. Do NOT apply anything to edge layers in this phase
(their `texture` stays `null`, output identical); just make the call possible. Watch closed paths: edge
layers emit `Z`; texture functions today only see open hatch strokes.

### Phase 4 verification

`verify-golden` after each sub-step. Browser after 4a (every slider label reads the same as before;
scene import restores every control including margins, page colour, smooth angle), 4b (texture tabs,
General/Individual toggle, per-layer values survive save/load, old `.pen` files load), 4c (nothing
visible changes), 4d/4e (the new UI).

---

## 4. Phase 5 — split the big files

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

After Phase 5 (so the harness link check catches every miss). Suggested renames, all
non-persisted:

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
- The Export button handler and the scene Save handler are still anonymous listeners inside
  `initSvgExport` / `initSceneIO`; name them when their files are split.
- `walkCircleSplit` (geom-utils) duplicates the `refineSplits` recursion with different seam handling —
  left as is on purpose.
- `generateRawContourEdges` recomputes `isSilTopo` and `projView`; share with `buildContourTopology`
  during the Phase 5 worker work if that happens.
- `buildDashFields` / `addDashSlot` both hand-build dash markup; fold when `layer-rows.js` exists.
- The plan's original audit (findings A–H with file:line evidence, now partly stale line numbers) is at
  `C:\Users\Michal\.claude\plans\i-have-been-developing-graceful-walrus.md` on the user's machine.
