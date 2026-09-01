# Phase 4 — Contour in axis-aligned orthographic views

Problem statement and dead ends. Deliberately no proposed solution.

---

## The problem

In any of the six axis-snapped orthographic views (±X, ±Y, ±Z), Contour output on
models with geometry that coincides in 2D fragments into many short paths instead
of a few clean closed loops. Off-axis views are unaffected.

It shows up wherever projected geometry lands on top of itself: an extruded shape's
near and far surfaces projecting to the same outline, a pipe whose 90° corners align,
an arch band whose top and bottom rims coincide. Vertices do **not** coincide — only
the projected edges do.

Reference case: `arches.obj`, 4 closed shells, 1104 tris, no non-manifold edges,
aligned top view, Contour layer only.

| | segments | paths | closed |
|---|---|---|---|
| expected | 16 | 4 | 4 |
| current pipeline | 79 | 65 | 4 |
| old pipeline (`main`, pre-Phase-3b) | 16 | 4 | 2 |

## Where the fragmentation happens

Measured through the pipeline on that case:

| stage | count |
|---|---|
| raw chain walk (debug export — no occlusion, no dedup) | **7 closed loops** |
| after Step 2/3 `occlude()` (`counts.contourRunLensSv.length`) | **95 visible runs** |
| final output | 65 paths |

Two independent problems, an order of magnitude apart in size:

- **(A) Topology: 4 → 7.** Three spurious closed strands, coincident in 2D with the
  real ones, exist in the raw chain walk itself. Real, but minor.
- **(B) Occlusion: 7 → 95.** `occlude()` splits each loop roughly thirteen ways —
  about 190 visible/hidden alternations across the model. This dominates.

## Why the old pipeline looked correct

It ran `dedupCollinear` on the contour layer, which collapsed the redundancy after
the fact (75+ segments → 16). Phase 3b Step 7 removed Contour from that pass: at
segment granularity a merge can span two runs, the survivor inherits one `runId`,
and the loser is left with a hole mid-sequence that `chainByRun` then splits at.
Measured at the time — a self-crossing torus knot went from 81 fragmented paths
with dedup to 22 without.

So the old output was dedup hiding the redundancy, not a better solve. Both
pipelines produce it; only the old one cleaned up afterwards.

## Ruled out

- **Contour cleanup / Step 4 backdrop depth test.** Disabling it entirely moves the
  count 63 → 65 paths. Not involved. The `CONTOUR_DEPTH_SIMILAR_FRAC_WORLD`
  threshold question is real but orthogonal to this.
- **The outward-nudge direction** in both backdrop tests. Measured as genuinely
  ill-conditioned here: 56% of segments have their reference face's third vertex
  less than the 0.01px nudge distance off the edge line, median conditioning
  18,000× worse than off-axis (0.000256px vs 4.685px), collinear-overlap pairs
  0 → 879 across 77% of segments. All view-induced — an off-axis control on the
  same mesh showed zero below 0.1px. **But fixing it changed almost nothing**,
  because `pickBackdropFaceWithDepth` skips collapsed triangles at `|det|<1e-9`,
  so both sides of the edge see an identical candidate set and the direction never
  mattered. Reverted. Conditioning was measured correctly; causation was inferred
  from it without checking whether the two branches could return different verdicts.
- **`EPS_FRONT_TIE`.** Still doing its job — front/back classification is consistent.
  It makes classification stable but says nothing about whether a face has usable
  projected area.
- **Mesh topology.** Clean: 4 closed shells, no non-manifold edges, single weld group.
- **`emit()`'s `MIN_SEG` filter severing continuous runs.** A real defect, found and
  fixed (`emitRun`, applied to Crease and Silhouette), but not the cause of this.
- **`EPS_CROSS_SHELL_REL`** (Phase 3c). Right function, wrong mechanism.
- **`so` vs `iv` divergence.** Was a separate bug — `iv`/`ih` were missing from the
  `dedupCollinear` list while `so` was in it. Fixed; they now agree.

## Code facts gathered along the way

Recorded as observations, not as direction.

- `occlude()`'s per-occluder precomputation (§3.5) classifies every occluder
  triangle: `|det| < 1e-9` → `oSkip`, never tests; height over longest edge
  `< 1.0px` → `oSliver`, handled on a 1-D edge basis with its own epsilon
  (`oSeps = EPS_SLOPE_FAR·|Δz|/len`). In an aligned view the edge-on surfaces make
  nearly every occluder a sliver, so a path written for occasional thin triangles
  ends up handling most of the mesh.
- `dedupCollinear` already accepts `runIds`/`seqs` (Phase 3a). Contour's exclusion
  from it is about cross-run merging, not missing plumbing.
- The raw-contour debug export bypasses occlusion and dedup entirely, so it isolates
  (A) from (B) directly.
- `counts.contourRunLensSv.length` / `…Sh.length` give the Step 2/3 run counts, which
  is what separates occlusion fragmentation from anything downstream.
