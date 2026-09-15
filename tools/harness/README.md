# tools/harness — headless PENumbra

Runs a `.pen` scene through the real app pipeline in Node, with no browser:
the **real** HLR worker (`js/worker/*.js`, imported unmodified), the **real**
three.js r128 (the same cdnjs build `index.html` loads, vendored in
`vendor/`), and the **real** main-thread code for everything that decides
what the worker sees or what the SVG ends up containing.

Nothing about the pipeline is reimplemented here. `gatherSettings`,
`buildCamMessage`, `computePaperLayout`, `lightVec`, the orbit→camera
construction, `setProjMode`, `updateModelRotation` and the whole
Contour/Silhouette/Crease chaining tail are **imported from the real
modules** (`js/panel-controls.js`, `js/viewport3d.js`, `js/svg-export.js`).
`app-env.mjs` installs the little the modules need at import time in Node —
a `THREE` global and a `document` whose `getElementById()` returns fake
controls with `.value`/`.checked` — and the modules' init functions (all the
DOM wiring) are simply never called. Edit the app, the harness follows;
rename or un-export one of those declarations and the harness fails at
module link time rather than testing a stale copy.

Verified (2026-09) against a pipe-model scene: the harness reproduced all
three browser exports (full plot, hidden Contour, Silhouette) **segment for
segment**.

`pen_files/` is a local, untracked folder for the `.pen` scenes referenced
below; only fingerprints derived from them are committed.

## Golden check (run this after any change meant to be output-neutral)

```sh
node tools/harness/verify-golden.mjs
```

Re-runs the sweep for the built-in demo mesh and `pen_files/arches.pen`
(skipped if absent) and diffs against `golden/demo.json` / `golden/arches.json`,
then rebuilds one all-layers combined SVG per scene and compares its SHA-256
against `golden/combined-sha256.txt`. Must end with
`RESULT: all golden outputs identical`.

After an INTENDED output change, re-capture:

```sh
node tools/harness/sweep.mjs demo --out tools/harness/golden/demo.json
node tools/harness/sweep.mjs pen_files/arches.pen --out tools/harness/golden/arches.json
node tools/harness/verify-golden.mjs --recapture-hashes
```

## Usage

```sh
# solve a scene, write one SVG per enabled layer (same paper as the app)
node tools/harness/run.mjs pen_files/arches.pen --out /tmp/out

# pick layers; --on/--off tick pen checkboxes before the solve, so the
# cross-layer ink-avoidance cascade sees exactly that set
node tools/harness/run.mjs scene.pen --on sh --layers sv,sh --out /tmp/out
node tools/harness/run.mjs scene.pen --combined          # all layers in one file
node tools/harness/run.mjs scene.pen --raw               # skip chaining: one subpath per worker segment
node tools/harness/run.mjs scene.pen --json              # counts only

# hunt for Contour ink that went missing
node tools/harness/contour-audit.mjs scene.pen [--hidden] [--png out.png]

# find ink the plotter draws twice
node tools/harness/double-ink.mjs scene.pen [--views] [--layer sh] [--set k=v]

# does a change delete ink nothing else redraws? (exact, per view)
node tools/harness/sweep.mjs scene.pen --compare --base contourCoincidentDedup=false

# regression sweep: capture a fingerprint, change something, compare
node tools/harness/sweep.mjs pen_files/arches.pen --out before.json
node tools/harness/sweep.mjs demo --out demo-before.json      # the built-in demo mesh
#   …make the change…
node tools/harness/sweep.mjs pen_files/arches.pen --out after.json
node tools/harness/sweep.mjs --diff before.json after.json
```

Two invariants, for two kinds of change. `len` is total pen travel — a
stretch drawn twice counts twice. Coverage is the union of ink on a 0.5px
grid, counted once however many strokes cover it. A fix that stops ink going
missing must not decrease either. A fix that removes duplicate strokes must
reduce `len` while leaving coverage untouched — `--compare` runs both
settings in one process and reports the exact per-view cell difference, which
is the only way to tell "stopped re-stroking" from "deleted the last copy".

`sweep.mjs` solves the scene from 28 camera angles — the six exact
axis-aligned orthographic poles (where different parts of the mesh project
onto each other exactly, which is where this pipeline is fragile), the same
six in perspective, a 15-view generic off-axis grid as a control group, and
the scene's own camera — with all seven line layers on, and fingerprints
each (view, layer)'s emitted path data by hash, segment count and total
drawn length. `--diff` reports every pair that moved and, crucially, the
direction of the change. Pass `demo` instead of a `.pen` path to sweep the
app's built-in demo mesh as an independent second scene.

## Files

| file | what it is |
|---|---|
| `app-env.mjs` | the browser stand-in (`THREE`, `document`, fake controls) the app modules need at import time. Import it first. |
| `app.mjs` | the main thread: `.pen` import → worker `load` → camera/settings → `generate` → result. `openScene()` / `HarnessApp`. |
| `svg.mjs` | `onResult`'s per-layer path building (`layerPathD`, calling the same builders `onResult` does) and a paper-space SVG writer. |
| `raster.mjs` | tiny anti-aliased line rasterizer + PNG writer, so a run can be looked at. Debug aid only. |
| `run.mjs` | CLI. |
| `contour-audit.mjs` | Contour-specific diagnostics (see below). |
| `double-ink.mjs` | finds overlapping near-coincident ink within a layer. |
| `sweep.mjs` | multi-view golden-output fingerprint + diff, and `--compare`. |
| `verify-golden.mjs` | one-command check of every committed golden (see above). |
| `golden/` | the committed fingerprints and combined-SVG hashes. |
| `vendor/three.min.js` | three.js r128, byte-identical to the CDN file `index.html` loads. |

## Two things the harness cannot reproduce

- **Viewport size.** The solver works in viewport pixels, and a `.pen` file
  doesn't record how big the browser's 3D pane was. The default (798×947) was
  recovered from the `invertPageBounds` recorded in the browser exports the
  harness was verified against; override with `--vp WxH`. Get this wrong and
  every coordinate scales, so check `paper: … scale=…` in the run header
  against a real export.
- **The shading buffer.** `captureShadingBuffer()` is a WebGL readback, so
  `generate` is sent `shadingBuffer: null`. With Smooth shading on, the worker
  posts a (non-fatal) error and skips Hatch/Circles — the run header reports it
  as `warning:`. Line layers are unaffected; hatch/circle output is not
  trustworthy here.

## contour-audit.mjs

Two checks, both aimed at "a stretch of Contour is simply absent":

1. **Fold-backs.** Re-runs `simplifyCollinear`'s sweep and reports every point
   whose projection onto the `a→c` line lands *outside* the `a..c` span. On a
   genuinely straight run that never happens — the point always sits between
   its neighbours. It happens when a contour chain doubles back on itself
   along a near-coincident line, where dropping the point would erase the
   whole out-and-back excursion rather than a redundant midpoint. Each is
   reported as `preserved` or `COLLAPSED`; anything collapsed with an
   excursion above `SIMPLIFY_FOLDBACK_TOL` is real ink being deleted.
   (This is the check that found the 55.5px Contour gap in
   `pipe_X_aligned.pen`; see `SIMPLIFY_FOLDBACK_TOL` in `js/svg-export.js`.)
2. **Collinear holes.** Clusters emitted ink onto infinite lines and reports
   gaps in the middle of an otherwise continuous run. Run with `--hidden`:
   without it, every genuinely occluded stretch shows up as a hole.

## Contour cross-run dedup (always on)

`dedupCrossRunCoincident` (`js/worker/dedup.js`), run from `generate()` after
the cross-layer cascade, removes Contour ink that two different mesh strands
draw on top of each other when their silhouettes project onto the same screen
line. It has no UI control. The worker skips it only when a settings object
carries `contourCoincidentDedup: false`, which nothing in the app sends — it
is there so the harness can still measure the pass against its absence:
`--set contourCoincidentDedup=false` (or `--base …=false` in `--compare`).

Measured in the worker on `pipe_X_aligned.pen`, Contour layer alone:

| view | doubled ink, off | on |
|---|---|---|
| scene / axis+X | 91.9mm | 0.0mm |
| axis-X | 39.2mm | 0.0mm |
| axis+Z | 5.5mm | 0.0mm |
| axis+Y | 64.2mm | 0.6mm |
| axis-Y | 203.8mm | 0.0mm |
| 1° off axis | 41.5mm | 0.0mm |
| 5° off axis | 42.8mm | 0.6mm |
| generic views | 0mm | 0mm |

Over 14 views, Contour + hidden Contour:

| | doubled ink | real closed rings (>5px) | pen lifts | paths |
|---|---|---|---|---|
| pass off | 910.2mm | 11 | 2330 | 1371 |
| pass on, trims that strand a crumb abandoned | 159.9mm | 11 | 2368 | 1393 |
| **pass on (current)** | **23.3mm** | **10** | **2356** | **1384** |

No ink is lost from the page in any of the 28 `--compare` views, on either
the pipe or the demo mesh (where the pass is an exact no-op). The one ring
that opens is still drawn in full, as an open stroke.

Three things were needed, each of which had silently capped the pass:

- **Candidate lookup must be spatial.** It originally bucketed on (quantized
  direction, perpendicular offset from the origin). That offset moves by
  `y · Δdirection`, so at a few hundred px out a direction difference of a
  thousandth shifts a strand several buckets away from its own twin; and the
  angle has a seam at vertical. Near-horizontal coincidences were found,
  nearly all near-vertical ones were not.
- **Interval ends need snapping at `EXACT_DUP_EPS`.** Two runs meeting at a
  shared mesh vertex compute it down different paths, so coverage can start
  5e-5px short of a segment's end.
- **Sub-MIN_SEG remainders are dropped, not guarded.** Abandoning a trim
  whenever it would strand a crumb kept 159.9mm of duplicates and — counter
  to what that guard was meant to protect — cost more pen lifts, not fewer.

**Measure topology in the worker, not post-hoc.** Re-running the pass on a
posted result looks equivalent (it is the last thing `generate()` does) but
isn't: posted groups are Float32Array, and the pass's epsilon snaps and
MIN_SEG decisions move under that rounding. Closed-subpath counts measured
that way were badly wrong (206 → 129 post-hoc against 206 → 206 in the
worker). Use `generate({ contourCoincidentDedup: false })` vs `generate()`.

