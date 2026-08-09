# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PENumbra is a browser-based hidden-line-removal (HLR) "plotter studio": load an STL/OBJ mesh, it computes
silhouette/contour/crease edges and hatching, and exports pen-plotter-ready SVG laid out on a paper sheet.
It is a single static page — no build step, no bundler, no package.json, no test suite. Open `index.html`
directly (file:// works) or serve the directory with any static file server.

The only external dependency is `three.js r128`, loaded from a CDN `<script>` tag in `index.html` (used
for the live 3D viewport only — the HLR solver itself is dependency-free). Fonts are loaded from Google
Fonts. Both require network access on first load.

There is no lint/build/test command — verify changes by opening `index.html` in a browser and exercising
the UI (load a model via drag-drop or the demo scene, toggle layers, Generate, export SVG).

## Script load order (index.html, bottom of file)

Files are plain global-scope scripts, not modules, and depend on load order:

```
three.min.js (CDN)
js/main.js          - must load first: defines $, LAYERS, DASH_RATIOS/scaledDash, boots the HLR worker
js/viewport3d.js     - three.js scene/camera/orbit controls, onLoaded()
js/paper-preview.js  - pan/zoom for the on-screen paper pane
js/svg-export.js     - layer styling, paper layout math, worker-result -> SVG, file export
js/panel-controls.js - control panel wiring, gatherSettings(), staleness/auto-generate
js/layout-canvas.js  - the Layout tab (needs panel-controls.js + svg-export.js)
js/scene-io.js       - must load last: worker.onmessage dispatcher, file I/O, .pen scene save/load, boots the app
```

Each file's own header comment documents its responsibilities and cross-file dependencies in more detail
than is repeated here — read the top of the file you're editing first.

## Architecture

**Two execution contexts:**
1. **Main thread** (the files above): UI, three.js viewport, paper preview, SVG assembly/export.
2. **HLR worker**: a large inline script, embedded as `<script id="worker-code" type="text/plain">` in
   `index.html` (~3,300 lines, between the `__CORE_START__`/`__CORE_END__` markers). It's read out of the
   DOM and spun up via `new Worker(URL.createObjectURL(new Blob([...])))` in `main.js` — done this way
   specifically so the app keeps working when opened as a `file://` page, which can't `fetch()` a sibling
   `.js` file as a worker script. When editing the solver, you are editing a `<script>` block inside
   `index.html`, not a `.js` file in `js/`.

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

**Layout tab vs. draw layers — a naming collision to watch for:** the Layout tab (`layout-canvas.js`)
stacks frozen snapshots of past generations, called "blocks" internally but labeled "layers" in the UI.
This is a *different* concept from the `LAYERS` edge/fill array above — don't conflate the two when reading
or writing code that touches either.

**Scene files (`.pen`):** `scene-io.js` handles save/load of the entire app state (model geometry, camera,
every setting, layer styles) as a single JSON-ish `.pen` file, with the model embedded as base64.

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
