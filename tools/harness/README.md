# tools/harness — headless PENumbra

Runs a `.pen` scene through the real app pipeline in Node, with no browser:
the **real** HLR worker (`js/worker/*.js`, imported unmodified), the **real**
three.js r128 (the same cdnjs build `index.html` loads, vendored in
`vendor/`), and the **real** main-thread code for everything that decides
what the worker sees or what the SVG ends up containing.

Nothing about the pipeline is reimplemented here. `gatherSettings`,
`buildCamMessage`, `computePaperLayout`, `lightVec`, the orbit→camera
construction and the whole Contour/Silhouette/Crease chaining tail are
pulled out of `js/panel-controls.js`, `js/viewport3d.js` and
`js/svg-export.js` **as source text** at runtime and evaluated in a sandbox
(see `extract.mjs`). Edit the app, the harness follows; rename one of those
declarations and the harness fails loudly rather than testing a stale copy.

Verified: for `pen_files/pipe_X_aligned.pen` the harness reproduces all
three of the browser exports in `pen_files/` (`pipe-plot.svg`,
`pipe-plot_sh.svg`, `pipe-plot_silhouette.svg`) **segment for segment**.

## Usage

```sh
# solve a scene, write one SVG per enabled layer (same paper as the app)
node tools/harness/run.mjs pen_files/pipe_X_aligned.pen --out /tmp/out

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
node tools/harness/sweep.mjs pen_files/pipe_X_aligned.pen --out before.json
node tools/harness/sweep.mjs demo --out demo-before.json      # the built-in demo mesh
#   …make the change…
node tools/harness/sweep.mjs pen_files/pipe_X_aligned.pen --out after.json
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
| `app.mjs` | the main thread: `.pen` import → worker `load` → camera/settings → `generate` → result. `openScene()` / `HarnessApp`. |
| `svg.mjs` | `onResult`'s per-layer path building (`layerPathD`) and a paper-space SVG writer. |
| `raster.mjs` | tiny anti-aliased line rasterizer + PNG writer, so a run can be looked at. Debug aid only. |
| `extract.mjs` | pulls named declarations out of the app's global-scope scripts and evaluates them in a sandbox. |
| `run.mjs` | CLI. |
| `contour-audit.mjs` | Contour-specific diagnostics (see below). |
| `double-ink.mjs` | finds overlapping near-coincident ink within a layer. |
| `sweep.mjs` | multi-view golden-output fingerprint + diff, and `--compare`. |
| `dedup-experiment.mjs` | re-tests the `dedupCollinear`-on-Contour exclusion (see below). |
| `vendor/three.min.js` | three.js r128, byte-identical to the CDN file `index.html` loads. |

## Two things the harness cannot reproduce

- **Viewport size.** The solver works in viewport pixels, and a `.pen` file
  doesn't record how big the browser's 3D pane was. The default (798×947) is
  recovered from the `invertPageBounds` recorded in the reference exports in
  `pen_files/`; override with `--vp WxH`. Get this wrong and every coordinate
  scales, so check `paper: … scale=…` in the run header against a real export.
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

Measured on `pipe_X_aligned.pen`, Contour layer alone:

| view | doubled ink, off | on |
|---|---|---|
| scene / axis+X | 91.9mm | 2.9mm |
| axis-X | 39.2mm | 0.0mm |
| axis+Z | 5.5mm | 0.4mm |
| axis+Y | 64.2mm | 0.6mm |
| axis-Y | 203.8mm | 32.7mm |
| 1° off axis | 41.5mm | 0.0mm |
| 5° off axis | 42.8mm | 1.2mm |
| generic views | 0mm | 0mm |

Over the 14 views of `dedup-experiment.mjs`: **910.2mm → 85.7mm**, with
**0 gap cells**, subpaths 1371 → 1389 and closed subpaths 206 → **208**. So
it removes 91% of the duplicate ink without losing any ink from the page and
without costing pen lifts. Same check on the demo mesh: exact no-op.

Two things were needed to get there, both of which had been silently capping
the pass at about a third of that:

- **Candidate lookup must be spatial.** It originally bucketed on (quantized
  direction, perpendicular offset from the origin). That offset moves by
  `y · Δdirection`, so at a few hundred px out a direction difference of a
  thousandth shifts a strand several buckets away from its own twin; and the
  angle has a seam at vertical, where canonicalizing sends the same line to
  either end of the range. Near-horizontal coincidences were found, nearly
  all near-vertical ones were not.
- **Interval ends need snapping at `EXACT_DUP_EPS`.** Two runs meeting at a
  shared mesh vertex compute it down different paths, so coverage can start
  5e-5px short of a segment's end — and that crumb then trips the
  stranded-sliver guard and abandons the whole trim.

The ~9% residual is deliberate: dropping sub-MIN_SEG remainders instead of
abandoning the trim takes it to 23.2mm, but closed subpaths fall from 208 to
129. See the guard's own comment in `dedupCrossRunCoincident`.

## dedup-experiment.mjs — re-testing the dedupCollinear exclusion

`sv`/`sh` are excluded from `dedupCollinear` (solver.js Step 7 / Phase 3b) on
a measurement taken when Contour was generated differently. This re-runs the
question against the current pipeline **without touching the app**: the real
`dedupCollinear` is imported and applied to the real worker's `sv`/`sh`
output, the emitted path is rebuilt through the real chaining tail, and the
result is compared against both the baseline and `dedupCrossRunCoincident`
over 14 views. Applied at the end of the pipeline — the more favourable
position — so a bad result here is not an artifact of placement.

It splits lost coverage into `gap` (ink gone from the page) and `shift` (ink
moved into a neighbouring cell, which is expected when a surviving strand
replaces one up to `offTol` away), and reports subpath and closed-subpath
counts, since the historical objection was about chain quality rather than
ink. Run it before reconsidering the exclusion.
