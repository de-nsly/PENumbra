# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PENumbra is a browser-based hidden-line-removal (HLR) "plotter studio": load an STL/OBJ mesh, it computes
silhouette/contour/crease edges and hatching, and exports pen-plotter-ready SVG laid out on a paper sheet.
It is a single static page — no build step, no bundler, no package.json. The HLR worker
(`js/worker/solver.js`) is booted as a module worker, which browsers refuse to load from a `file://` page,
so `index.html` must be served over HTTP — e.g. `python3 -m http.server 8000` from the repo root, then open
`http://localhost:8000/`.

The only external dependency is `three.js r128`, loaded from a CDN `<script>` tag in `index.html` (used
for the live 3D viewport only — the HLR solver itself is dependency-free). Fonts are loaded from Google
Fonts. Both require network access on first load.

## Ongoing cleanup

A whole-codebase cleanup is in progress on branch `cleanup` (Phases 0–5 done: goldens, dead code,
shared helpers, ES modules, the settings registry and layer-instance model, and the file splits that
produced most of the module list below). `docs/refactor-plan.md` is the handoff for the remaining
phases — read it before any refactor work; it lists the ground rules (byte-identical output, keys that
must not be renamed, module discipline), what each finished phase actually did, and what is left:
Phase 6 (naming) and Phase 7 (performance). The worker's `generate()` was deliberately left whole.

## Verifying changes

There is no lint or build step. Two checks:

1. **Golden output** (headless, node ≥ 18, no browser): `tools/harness` runs the real worker and the real
   main-thread chaining code on a scene and compares against committed fingerprints.
   ```
   node tools/harness/verify-golden.mjs
   ```
   must end with `RESULT: all golden outputs identical`. It covers the built-in demo mesh and
   `pen_files/arches.pen` (a local file, not in the repo; the run skips it when absent). Any refactor
   that is meant to be output-neutral must pass this. `tools/harness/README.md` documents the other
   tools (per-view sweeps, contour audit, double-ink search) and how to re-capture goldens after an
   intended output change.
2. **Browser**: open `index.html` served over HTTP and exercise the UI (load a model via drag-drop or the
   demo scene, toggle layers, Generate, export SVG, Layout tab, save/load a `.pen`). The harness cannot
   cover WebGL-dependent paths (the Smooth-shading buffer) or any UI.

## Main-thread modules

`index.html` loads `three.min.js` (CDN, a classic script that defines the `THREE` global) and then one
module script, `js/app.js`. Every other main-thread file is an ES module with explicit `import`/`export`:

Only two clusters are foldered (`js/layout/`, `js/viewport/`) — the rest is flat on purpose: the modules
cycle freely, so deeper folders would imply a layering that does not exist.

```
js/app.js            - entry point: imports every module and calls their init functions in order, then boots
js/main.js           - $, svgEl/SVG_NS, downloadFile, focus guards, PEN_LIBRARY/penById, DASH_*, the worker (bootWorker)
js/settings.js       - SETTINGS registry: one entry per control (regen flag, label unit/decimals/presets, scene persistence, onRestore hook)
js/layers.js         - layer instances (layers, LAYER_TYPES), TEXTURE_FILTERS schema, .pen v1/v2 layer loading (pure data, no DOM)
js/texture-stack.js  - the Texture tab's per-layer stack editor
js/paper-preview.js  - pan/zoom for the on-screen paper pane, rulers, circles-centre gizmo
js/layer-rows.js     - the Lines tab's layer rows + fill settings panels, the dash editor, layerStyle/applyLayerStyle
js/paper-layout.js   - PAPERS/getMargins/computePaperLayout/pxPerMm, renderPaper(), trim mask, page + guide colours
js/chain.js          - chaining and merge passes: worker segments -> polylines (pure geometry, imports nothing)
js/hatch-texture.js  - the texture filter implementations behind TEXTURE_FILTERS, and applyTextureStack
js/render-result.js  - renderResult(): the worker's result becomes the on-screen SVG; refreshStatusR() stats readout
js/path-model.js     - d-string <-> typed segments, dash splitting, the margin trim, computeDStats (curve-preserving)
js/export.js         - exportSvg(): the Export button, both modes (clone of the screen, or one path per pen)
js/panel-controls.js - control panel wiring, gatherSettings(), generate/staleness/auto-generate state
js/pen-library.js    - the Pen library tab, pen add/delete, matching incoming pens
js/scene-io.js       - worker.onmessage dispatcher, file I/O, .pen scene save/load, boots the demo scene
js/viewport/
  viewport3d.js      - three.js scene/camera/orbit controls, gizmos, lighting, onLoaded(), smooth shading
  saved-views.js     - the named camera views panel (part of the scene: a .pen import replaces the list)
  shading-capture.js - the WebGL shading-buffer readback the worker samples for Smooth shading
js/layout/
  layout-model.js       - the Layout tab: the blocks, their DOM, the canvas scaffold
  layout-list.js        - the Layout tab: block list rows, context menu, the floating buttons + overlay state
  layout-interaction.js - the Layout tab: selection, hit testing, move/rotate/scale gestures, snapping, guides
  layout-clipboard.js   - the Layout tab: copy / paste of blocks
js/debug/*.js        - console-only diagnostics, dynamically imported by scene-io.js only when the URL has ?debug
```

**The rule that keeps this importable headlessly:** a module's top level only *declares* (functions,
constants, `let` state, `$('id')` element lookups). Every side effect — event wiring, DOM building, the
render loop, `new Worker` — lives in that module's exported `init…()` function, which `app.js` calls in the
order above. `tools/harness` imports the same modules in Node with a small browser stand-in
(`tools/harness/app-env.mjs`) and never calls the inits. Keep new side effects inside the inits.

Modules import each other freely (there are cycles); that is safe precisely because nothing at module top
level reads another module's state. Cross-module *writes* go through small exported setters
(`setActiveTab`, `setActiveSheet`, `setSavedViews`, `replaceBlocks`, `generateFinished`,
`takePendingSceneImport`, …) — an imported `let` binding is readable live but not assignable.

Each file's own header comment documents its responsibilities in more detail — read the top of the file
you're editing first.

## Architecture

**Two execution contexts:**
1. **Main thread** (the files above): UI, three.js viewport, paper preview, SVG assembly/export.
2. **HLR worker**: `js/worker/*.js`, real ES modules imported by `js/worker/solver.js`, the entry point
   `main.js` boots as a module worker: `new Worker('js/worker/solver.js', { type: 'module' })`. Split along
   the solver's own declaration groups, each a one-directional leaf `solver.js` imports from — none of them
   import from each other or from `solver.js`:
   - `parsers.js` — parseSTL/parseOBJ/demoSoup, turning a file (or nothing) into a flat triangle soup.
   - `mesh.js` — buildMesh/computeCornerNormals and the module-level mesh state `M`, rebuilt only on
     `load`/`demo`.
   - `geom-utils.js` — segment intersection/spatial indexing, the light-space shadow map
     (`buildShadowMap`), screen→world face recovery (`worldOnFace`), circle/ring pattern walking, and
     shading-buffer sampling.
   - `dedup.js` — collinear-overlap cleanup (`dedupCollinear`), higher-layer coverage subtraction
     (`subtractCovered`), and crease-junction arm pairing (`pairJunctionArms`).
   - `solver.js` — `generate()`/`generateRawEdges()` (the actual HLR solve) and the `self.onmessage`
     dispatcher; composes the four modules above.

**Worker message protocol** (dispatched in `scene-io.js`'s `worker.onmessage`, handled in the worker's own
`self.onmessage`): `load`/`demo` (parse STL/OBJ, build mesh, reply `loaded`) -> `generate` (run the HLR
solve, reply `result`) -> `recomputeSmoothAngle`, `debugRawEdges`, `testShadingSample` for narrower
recompute/debug paths. The worker keeps mesh state in a module-level `M`, rebuilt only on `load`/`demo`.
The `generate` settings (`gatherSettings`, `panel-controls.js`) carry the edge layers as `layerOn` and the
fill layers as `passes`, one descriptor per enabled fill layer in layer order (`fillPasses`), each with
that layer's own angle/spacing/threshold/centre; the result's `groups`, `hatchCarrier` and
`circlePatternSegs` are keyed by layer id.

**HLR pipeline** (inside the worker, see `generate()`): build mesh + adjacency -> compute a shadow map for
soft-shadow sampling -> per-face/per-edge visibility via ray occlusion (`occlude`, `buildShadowMap`) ->
classify edges into silhouette/contour/crease, each split into visible/hidden -> generate hatch/crosshatch/
circle fill patterns for shaded faces -> post back flat segment arrays per layer.

**Layer model** (`layers` in `layers.js`): an ordered array of layer instances `{id, type, on, pen, dash,
texture, …fill settings}`. Ids `so` silhouette, `iv`/`ih` silhouette individual, `sv`/`sh` contour
(historically "silhouette visible/hidden"), `cv`/`ch` crease, `h1`/`h2`/`h3` the first three hatch layers
(once Hatch/Crosshatch/Deep shadow), `cr` the first circles layer; layers the user adds get `f1`, `f2`, …
(`nextFillId`, never reused in a session). Edge layers are fixed singletons; fill layers can be added,
duplicated, deleted and reordered among themselves, any number of each type. Every fill setting is the
layer's own — `angleDeg` (hatch), `minSpacing`/`maxSpacing` in mm, `threshold`, and `centerX`/`centerY` for
circles — declared by its type's `settings` schema, which also drives the row's sliders. Names are derived
from the type plus the layer's number among its type (`layerName`), never stored. The instance is the
state; the Lines-tab rows (`layerEls`, `layer-rows.js`) are a view of it. `texture` is an ordered stack of
filter entries typed by `TEXTURE_FILTERS`; an empty stack is no texture, and only fill layers apply theirs
today. Order is the drawing-priority hierarchy:
higher entries win ink-avoidance against lower ones, and the array is walked in reverse when painting so
the highest-priority layer ends up on top. Toggling any single layer can change what survives in every
layer below it, so every layer checkbox re-runs the pipeline; there is no display-only toggle.

**Pen library** (`PEN_LIBRARY` in `main.js`, UI in `pen-library.js`): an ordered list of `{id, name, color,
width}` pens. Layers and Layout block overrides store only a pen id (plus their own dash) and resolve colour/
width through `penById` on every render, so editing a pen restyles everything using it. The library is part of
the scene (a `.pen` import replaces it); pre-pen-library scenes and clipboard pastes are matched into it by
colour + width (`resolvePen`). "Pen" still means two things — the `.pen` scene file and the pen library —
so library code uses `penLib*`/`PEN_LIBRARY` to stay distinguishable from the file format.

**SVG export modes** (Export button, `export.js`): with the Pen library tab's "Export one path per pen" on
(default), `buildPenPathsExport` builds a fresh file with one `<path id="pen05_Blue_0.2">` per pen, dashes
always split, margin-trimmed, then baked into page mm — Blender's SVG importer makes one curve object per
path, named after its id. Off, the export is a cleaned-up clone of the on-screen SVG (one group per layer).
Dash patterns everywhere go through `dashPattern` (`main.js`): a pair whose dash is 0 is dropped whole.

**Layout tab vs. draw layers — a naming collision to watch for:** the Layout tab (`layout-*.js`)
stacks frozen snapshots of past generations, called "blocks" internally but labeled "layers" in the UI.
This is a *different* concept from the `layers` instance array above — don't conflate the two when reading
or writing code that touches either.

**Scene files (`.pen`):** `scene-io.js` handles save/load of the entire app state (model geometry, camera,
every setting, the pen library, the layer instances with their texture stacks) as a single JSON-ish `.pen`
file, with the model embedded as base64. It writes `penumbraScene: 2` (layers as the instance array) and
loads version 1 too: `sceneLayers` in `layers.js` gives each fill layer its own copy of what used to be
global (hatch angle plus its offset, spacing, its threshold slider, the circles centre) and rebuilds its
texture stack from the old General / per-layer texture settings. Those control ids exist only in that
loader now. A version-2 file written before fill settings moved onto the layers is read the same way.

## Working in this codebase

- Adding a cross-file reference means adding it to the `import { … }` line at the top of the file; a
  name that isn't exported fails at module link time (the browser console and `node
  tools/harness/verify-golden.mjs` both report it). New module-level state that another module must
  *assign* needs an exported setter function.
- The worker and the main thread each have their own copies of some logic (e.g. mesh math) and communicate
  only via `postMessage`/structured clone — the worker cannot touch DOM or main-thread globals directly.
- When a typed array needs to be reused by the sender after posting (e.g. the worker's own mesh buffers),
  it's copied via `.slice()` before being included in a transfer list — search for existing "copy, don't
  transfer" comments before changing a `postMessage` transfer list.
- Line-position bugs in exported SVGs have two homes: the main-thread chaining/merge passes in
  `chain.js` (`chainSegments`, `mergeSilhouetteClose`, `mergeContourRunSplits`,
  `mergeAdjacentTouching`, `mergeCreaseScreenSpace`, `splitSelfTouching`, `simplifyCollinear`) and the
  worker's `worldOnFace`/`intersectSegs`/`subtractCovered`. `tools/harness/sweep.mjs --diff` tells the two
  apart (`--raw` emits worker segments unchained).

## CSS styling conventions (`styles.css`)

`styles.css` was deliberately consolidated to a small set of reusable tokens and shared element classes
— keep it that way:

- **Never invent a new font styling combination** (size/weight/color/tracking/family). Reuse one of the
  existing `--fs-*`/`--ls-*` tokens and semantic colors (`--text`/`--muted`/`--accent`/etc.) in
  `:root`. Only add a new one if the user explicitly asks for it.
- **Never write new styling for a common element type** (buttons, icon buttons, checkboxes, sliders,
  pill toggles, segmented toggles, control rows, etc.). Reuse the existing shared class (`.btn`,
  `.chk`, `.pillToggle`, `.ctl`, the icon-button group, ...) instead of a one-off rule, unless it's
  genuinely unavoidable.
- Every element that looks the same (or nearly the same) as an existing one should share **one single
  source of truth** in CSS, not a duplicate/near-duplicate rule.
