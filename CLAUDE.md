# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PENumbra is a browser-based hidden-line-removal (HLR) "plotter studio": load an STL/OBJ mesh, it computes
silhouette/contour/crease edges and hatching, and exports pen-plotter-ready SVG laid out on a paper sheet.
It is a single static page — no build step, no bundler, no package.json, no test suite. The HLR worker
(`js/worker/solver.js`) is booted as a module worker, which browsers refuse to load from a `file://` page,
so `index.html` must be served over HTTP — e.g. `python3 -m http.server 8000` from the repo root, then open
`http://localhost:8000/`.

The only external dependency is `three.js r128`, loaded from a CDN `<script>` tag in `index.html` (used
for the live 3D viewport only — the HLR solver itself is dependency-free). Fonts are loaded from Google
Fonts. Both require network access on first load.

There is no lint/build/test command — verify changes by opening `index.html` in a browser and exercising
the UI (load a model via drag-drop or the demo scene, toggle layers, Generate, export SVG).

## Script load order (index.html, bottom of file)

Files are plain global-scope scripts, not modules, and depend on load order:

```
three.min.js (CDN)
js/main.js          - must load first: defines $, LAYERS, PEN_LIBRARY/penById, DASH_RATIOS/scaledDash, boots the HLR worker
js/viewport3d.js     - three.js scene/camera/orbit controls, onLoaded()
js/paper-preview.js  - pan/zoom for the on-screen paper pane
js/svg-export.js     - layer styling, paper layout math, worker-result -> SVG, file export
js/panel-controls.js - control panel wiring, gatherSettings(), staleness/auto-generate
js/pen-library.js    - the Pen library tab, pen add/delete, matching incoming pens (needs panel-controls.js + svg-export.js)
js/layout-canvas.js  - the Layout tab (needs panel-controls.js + svg-export.js)
js/scene-io.js       - must load last: worker.onmessage dispatcher, file I/O, .pen scene save/load, boots the app
```

Each file's own header comment documents its responsibilities and cross-file dependencies in more detail
than is repeated here — read the top of the file you're editing first.

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

**HLR pipeline** (inside the worker, see `generate()`): build mesh + adjacency -> compute a shadow map for
soft-shadow sampling -> per-face/per-edge visibility via ray occlusion (`occlude`, `buildShadowMap`) ->
classify edges into silhouette/contour/crease, each split into visible/hidden -> generate hatch/crosshatch/
circle fill patterns for shaded faces -> post back flat segment arrays per layer.

**Layer model** (`LAYERS` in `main.js`): an ordered array of edge/fill layer definitions (`so` silhouette,
`iv`/`ih` silhouette individual, `sv`/`sh` contour, `cv`/`ch` crease, `h1`/`h2`/`h3` hatch/crosshatch/deep
shadow, `cr` circles). Order is the drawing-priority hierarchy: higher entries in the array win
ink-avoidance against lower ones, and the array is walked in reverse when painting so the highest-priority
layer ends up on top. Every layer has `solve:true` — toggling any single layer can change what survives in
every layer below it, so all layers re-run the pipeline on toggle, not just a display-only flag.

**Pen library** (`PEN_LIBRARY` in `main.js`, UI in `pen-library.js`): an ordered list of `{id, name, color,
width}` pens. Layers and Layout block overrides store only a pen id (plus their own dash) and resolve colour/
width through `penById` on every render, so editing a pen restyles everything using it. The library is part of
the scene (a `.pen` import replaces it); pre-pen-library scenes and clipboard pastes are matched into it by
colour + width (`resolvePen`). "Pen" is overloaded: the `.pen` scene file, the Lines tab's historical
`penTab`/`penModeBtn`/`data-mode="pen"` ids, and the library — library code uses `penLib*`/`PEN_LIBRARY`.

**SVG export modes** (Export button, `svg-export.js`): with the Pen library tab's "Export one path per pen" on
(default), `buildPenPathsExport` builds a fresh file with one `<path id="pen05_Blue_0.2">` per pen, dashes
always split, margin-trimmed, then baked into page mm — Blender's SVG importer makes one curve object per
path, named after its id. Off, the export is a cleaned-up clone of the on-screen SVG (one group per layer).
Dash patterns everywhere go through `dashPattern` (`main.js`): a pair whose dash is 0 is dropped whole.

**Layout tab vs. draw layers — a naming collision to watch for:** the Layout tab (`layout-canvas.js`)
stacks frozen snapshots of past generations, called "blocks" internally but labeled "layers" in the UI.
This is a *different* concept from the `LAYERS` edge/fill array above — don't conflate the two when reading
or writing code that touches either.

**Scene files (`.pen`):** `scene-io.js` handles save/load of the entire app state (model geometry, camera,
every setting, the pen library, layer pen/dash choices) as a single JSON-ish `.pen` file, with the model embedded as base64.

## Working in this codebase

- Global-scope, not modules: every function/const declared in any loaded script is a shared global.
  Cross-file references (e.g. `svg-export.js` calling `markStale` from `panel-controls.js`) are implicit
  and depend on load order — check the header comments before reordering `<script>` tags.
- The worker and the main thread each have their own copies of some logic (e.g. mesh math) and communicate
  only via `postMessage`/structured clone — the worker cannot touch DOM or main-thread globals directly.
- When a typed array needs to be reused by the sender after posting (e.g. the worker's own mesh buffers),
  it's copied via `.slice()` before being included in a transfer list — search for existing "copy, don't
  transfer" comments before changing a `postMessage` transfer list.
- `svg-export.js`'s header comment flags itself as the most likely place to look for line-position/drift
  bugs in exported SVGs (`chainSegments`, `mergeAdjacentTouching`, `mergeCreaseScreenSpace`,
  `splitSelfTouching`), separate from the worker's own `worldOnFace`/`intersectSegs`.

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
