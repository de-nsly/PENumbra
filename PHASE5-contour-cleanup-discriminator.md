# Phase 5 — a surface-distance discriminator for Contour cleanup (Step 4)

Spec. Not yet implemented.

**Scope: Step 4's depth-similarity test only.** This is *not* aimed at the
axis-aligned orthographic view problem — see `PHASE4-contour-aligned-views.md`,
where Step 4 was measured and excluded (disabling it entirely moves that case from
63 to 65 paths). Do not conflate the two.

---

## 1. The problem

Step 4 (`buildContourDrops`, §6.5 in `js/worker/solver.js`) decides, per cut interval
on a Contour segment, whether an outward backdrop belonging to the **same shell** is:

- the same local surface reappearing — a triangulation/coincidence **artifact**, drop it; or
- a genuine **fold**, where the shape passes close in front of itself — keep it.

It resolves this on one signal: the world-space depth gap between the sample point and
the backdrop, compared against `M.radius * CONTOUR_DEPTH_SIMILAR_FRAC_WORLD`.

That single signal does not separate the two populations across models. Measured:

| model | usable range for `contourCleanup` |
|---|---|
| most test models (torus knot, pipe, …) | 0.022 – 0.050 |
| faceted 3D text | **≤ 0.0225** |

A ~2% overlap window is a coincidence, not a constant — a fifth model breaks it. The
value currently ships as a user-facing control ("Contour cleanup", Lines section,
`contourCleanup`, default 0.022) precisely because no single value was defensible.

## 2. Why depth alone cannot separate them

Both populations are, by construction, *depth-similar* — that is the only reason they
reach this test. An artifact and a real fold can present the same depth gap; what
differs is whether the two surfaces are the **same part of the mesh**.

- **Artifact**: the backdrop face is topologically adjacent — the neighbouring triangle
  across a diagonal, one or two steps away across the surface.
- **Real fold**: the backdrop is far away across the surface — a letterform's bowl
  backed by its own stem is a walk around the entire glyph — even though it is close
  in space.

## 3. The proposed discriminator

Measure **distance along the surface** between the edge's own face and the backdrop
face, and compare it to the **straight-line distance** between the two points.

```
ratio = surfaceDistance / straightLineDistance
```

- `ratio ≈ 1` → the two points are neighbours on the surface → same local surface → artifact.
- `ratio >> 1` → close in space but far across the surface → genuine fold → keep.

Two possible metrics:

- **Hop count** in the dual (face-adjacency) graph. Simplest, but tessellation-dependent:
  a denser mesh needs a larger hop limit for the same real distance, so the limit becomes
  a tuned constant of its own.
- **Accumulated surface length** (centroid-to-centroid, or a bounded Dijkstra with edge
  lengths). **Preferred.** The ratio form is free of both model scale and tessellation
  density, which is the entire property the current threshold lacks.

**Compose, don't replace.** Keep the depth test and use this as a veto:

```
drop  ⟺  depth-similar  AND  topologically near
```

This lets the depth threshold sit at the loose end of the observed range (~0.05), with
the surface test killing the false positives that currently force it down to 0.0225.

## 4. Where it goes

- `js/worker/solver.js`, `buildContourDrops` (§6.5), inside the `for (let k…)` cut loop.
  The two inputs are already in hand at that point: `csFaceA[seg]` / `csFaceB[seg]` are
  the edge's own faces, and `pickBackdropFaceWithDepth` returns `{ f, iz }` where `f`
  is the backdrop **face id**.
- The existing same-shell gate (`COMP[back.f] !== shell → keep`) stays and runs first;
  the discriminator only ever applies within one shell, so cross-shell cases never
  reach it and surface distance is always finite.

## 5. Data structure required

`M` (see `js/worker/mesh.js`) currently has **edge → faces** (`et0`/`et1`) but **no
face → neighbouring faces** mapping. One is needed.

- Derive in a single O(ne) pass: every edge with `et0 >= 0 && et1 >= 0` makes those two
  faces neighbours. Store CSR — `faceAdjStart` (nt+1) plus `faceAdjList` (≤ 2·ne).
- Build it **once at load, in `mesh.js`, cached on `M`** — it is camera-invariant
  topology. Rebuilding per `generate()` would be the one way to make this expensive.
- Use a **stamped visited array** (one `Int32Array(nt)` plus a monotonic counter,
  compared rather than cleared) to avoid per-search allocation.

## 6. Performance

This is affordable, and for a structural reason worth preserving in the implementation.

- Measured drop counts per generate on the affected models: **24 and 32**. The
  discriminator only needs to run on candidate drops — decisions where the depth test
  already said "artifact". At that volume even an uncapped search is free.
- The search is **self-limiting**: the radius is `ratioLimit × d`, where `d` is the
  straight-line gap, and every decision reaching this stage has already passed the
  depth-similarity filter — so `d` is small by construction. The more artifact-like the
  candidate, the smaller the search.
- Early-exit as soon as the backdrop face is reached, and keep a hard visit cap as a
  backstop so a pathological mesh cannot surprise you.

Contrast with `occlude()`, where a per-candidate search would *not* be affordable — that
is a different problem (Phase 4) with different constraints.

## 7. Do this as measurement first

The same code is ~90% of the real gate, so running it observe-only is not a detour.

Add the computed `ratio` (and hop count) as columns on the existing per-decision
diagnostic, `counts.dbgStep4Detail`, which already records every same-shell decision —
drops and keeps alike — with `gapWorld`, `thresh`, and the `ratio` each one missed or
cleared the depth threshold by. Change no behaviour on the first pass.

Then load the 3D text and one model that wants 0.05, and check whether drops and keeps
separate in the new column. Expect orders of magnitude of separation (adjacent-triangle
vs walk-around-the-glyph), against the ~2% window the depth threshold gives. If they do
not separate, the premise is wrong and the gate should not be built.

That reading also **calibrates the limit** directly, instead of guessing one.

## 8. Risks and open questions

- **Thin fins / plates viewed near edge-on.** Front and back surfaces are depth-similar
  *and* only a few steps apart across the rim, so they would be classified artifact.
  Believed not to reach the test — such an edge samples open background and exits at
  `back.f < 0` — but this is the case to verify explicitly.
- **Boundary and non-manifold edges** break face adjacency. The BFS must treat a missing
  neighbour as "no path", not as distance zero.
- **Interaction with the existing user control.** If the discriminator works, the
  `contourCleanup` slider's useful range should widen considerably. Decide deliberately
  whether it stays exposed (it is legitimate as an aesthetic control) or reverts to a
  constant.

## 9. Verification

- Test models: **3D text** (needs ≤ 0.0225 today), **torus knot**, **pipe**, and the
  tiled-house model.
- The goal is a single default that satisfies all four with real margin — that is the
  criterion the current constant fails.
- Golden matrix: `.pen` + expected-SVG pairs, several layer combinations, at least one
  near-tangent camera. Note this change **will** alter output, so goldens must be re-cut
  and diffed deliberately, not expected to match.

## 10. Existing controls and diagnostics

Already in the code, usable as-is:

- `contourCleanup` — Lines section slider, 0–0.06, default 0.022, feeds
  `CONTOUR_DEPTH_SIMILAR_FRAC_WORLD`.
- `debugNoStep4` — Debug panel kill-switch. Skips Step 4 entirely (distinct from setting
  the slider to 0, which still runs every decision).
- `counts.dbgStep4` — per-segment drop intervals.
- `counts.dbgStep4Detail` — per-decision records, drops and keeps, with `gapWorld`,
  `thresh`, `ratio`, `drop`, and screen `x`/`y`. Capped at 4000
  (`counts.dbgStep4Truncated` flags it).
