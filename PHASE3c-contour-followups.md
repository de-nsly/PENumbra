# Phase 3c — Contour follow-ups from Phase 3b (session summary)

Continuation of Phase 3b (`PHASE3b-contour-run-identity.md`). This session's
work is split into **shipped/active** and **tried-and-reverted**, plus one
**open, unsolved problem** to pick up next. Function/constant names only —
full reasoning lives in their own code comments.

---

## Shipped and currently active

### 1. Cross-run identity merge (new problem Phase 3b didn't cover)

Phase 3b guarantees one `run.id` → one polyline. It does **not** guarantee two
*different* `run.id`s never need joining. Two cases surfaced:

- **Sandwich**: a run that's (almost) entirely triangulation-diagonal
  artifact gets entirely eliminated by Step 4/5, leaving its two flanking
  runs (always the opposite state) with nothing between them.
- **Near-coincident endpoints**: two different runs whose tips land within
  `MIN_SEG` of each other regardless of adjacency — most likely two
  different `siChains` sharing one mesh vertex (`pairJunctionArms` only
  pairs one straightest continuation per junction).

**Worker side** (`js/worker/solver.js`): every Contour run now records
`prevId`/`nextId` (its neighbor in original chain-walk order) at creation
time in Step 2/3, and `hasContent` (`outPts.length>=2`, recorded **before**
the `layerOn.sv`/`layerOn.sh` gate — critical, see pitfall below). Posted as
`counts.contourAdjacency`.

**Exporter side** (`js/svg-export.js`): `chainByRun` now tags each returned
chain with its `runId`. New `mergeContourRunSplits(chains, adjacency)` runs
right after it: resolves sandwich pairs (walking past any number of
consecutively-eliminated neighbors via `hasContent`) and near-coincident
pairs (nearest-first, averaged to a shared midpoint — mirrors
`mergeSilhouetteClose`'s own tip-graph walk, reused rather than
reinvented). Merged output is labeled with the lowest contributing
`run.id` (bookkeeping only, no visible effect).

**Pitfall already hit and fixed**: don't key "was this run eliminated" off
whether its `run.id` appears in the final `groups`/`runIds` arrays — that's
also true whenever the run's own layer checkbox (e.g. Contour hidden) is
simply off, which has nothing to do with whether Step 4/5 actually dropped
its content. Must use the worker's own `hasContent` flag instead.

### 2. Step 6 emit() bypass — same-run.id gaps

Step 6 used to filter every internal point-pair in `outPts` through
`emit()`'s `MIN_SEG` filter. Since `outPts` is already one continuous,
absorbed point sequence for a single run (not independent pieces the way
Silhouette/Crease's pieces are), this could silently sever one run into two
separately-chained polylines sharing a `run.id`, with a gap too small for
`chainByRun`'s 0.02px tolerance but under `MIN_SEG` — invisible to
`mergeContourRunSplits` too (same-run.id, out of its scope by design).

Fixed: Step 6 now pushes every consecutive `outPts` pair directly,
bypassing `emit()`'s length filter entirely (only a literal zero-length
duplicate point is skipped). `emit()` itself is untouched, still used as
before by Crease and Silhouette.

### 3. Diagnostics added (still present)

`counts.dbgStep23` (raw per-run point sequence before Step 4),
`counts.dbgStep4` (per-segment drop intervals). `counts.dbgStep6Rejected`
was added then removed once its underlying cause (#2 above) was fixed.

---

## Tried and reverted (do not re-attempt without new evidence)

### Collinear-run merging in Step 2/3 (theory: double-rail noise from fine tessellation)

Idea: merge consecutive real mesh edges that are collinear in screen space
into one `occlude()` call per chain, to reduce the number of tiny,
independent occlusion tests along a locally-straight run. Implemented,
validated with unit tests against a hand-derived reference, confirmed
correct — **but did not help** the actual problem being investigated at the
time (coincident edges across separate shells — see Open Problem below,
which turned out to be an unrelated mechanism). Fully reverted.

### Cross-shell occlusion epsilon (`EPS_CROSS_SHELL_REL` in `occlude()`)

Theory: two independently-authored, deliberately-touching shells sit at
nearly (not exactly) the same depth along their shared line; `occlude()`'s
existing epsilon (`EPS_FP_REL`/`EPS_SLOPE_FAR`) is tuned for single-mesh
floating-point noise, not cross-mesh modeling tolerance, so one shell
consistently — and fully, not partially — occludes the other's coincident
edge. Added a shell-aware epsilon floor to `occlude()` (new `edgeShell`
parameter, applied at all 3 real call sites: Crease, Contour, Silhouette).
**Reverted by the user — did not fix the problem.** The house/tiled-shell
coincident-edge drop remains unexplained; this mechanism is not it, or not
all of it.

---

## Open, unsolved problem

**`CONTOUR_DEPTH_SIMILAR_FRAC` → `CONTOUR_DEPTH_SIMILAR_FRAC_WORLD`**
(Step 4's same-shell backdrop depth-similarity test, `js/worker/solver.js`).

Found and fixed a real dimensional bug: the old threshold scaled with the
point's own `edgeIz` (∝ `1/dist` under perspective), but a fixed real-world
depth gap produces an `iz`-difference that shrinks as `1/dist²` — the wrong
power, so the same real fold reads as "keep" up close and "drop" (fully,
not partially — swallowing real geometry) further out. Rewrote the
comparison to convert back to an estimated world-space gap
(`/edgeIz²` for perspective, unchanged for ortho since its `iz` is already
linear) before comparing against a `M.radius`-relative threshold.

**Status: fixed the reported case (letterform "d", bowl-vs-stem) but no
single `CONTOUR_DEPTH_SIMILAR_FRAC_WORLD` value satisfies the other test
models** (torus knot, pipe, tiled-house model). The dimensional fix is very
likely correct on its own terms, but either:
- there's a second, still-uncontrolled variable this constant is being
  asked to compensate for (different models have genuinely different
  "real fold gap" vs. "artifact coincidence gap" scales that don't reduce
  to one global fraction of `M.radius`), or
- this same depth-similarity test is conflating two different phenomena
  that need different thresholds (the double-rail triangulation artifact
  Phase 3b targeted vs. whatever's actually causing the tiled-house
  coincident-shell drops, which the cross-shell `occlude()` epsilon attempt
  didn't fix either).

**Next step for a fresh session**: don't assume this is one bug. Get
`dbgStep4` output for both a working case and a failing case at whatever
`CONTOUR_DEPTH_SIMILAR_FRAC_WORLD` value was last tried, and check whether
the failing drops are going through Step 4's same-shell path at all, or
whether (per the reverted cross-shell experiment's own unresolved question)
the tiled-house case is actually a plain `occlude()` self-occlusion issue
unrelated to Step 4's backdrop test entirely.
