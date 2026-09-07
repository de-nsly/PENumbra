# Phase 5 — Contour cleanup's surface-distance test

Implemented. This document is a record of what shipped and what was tried, not a spec.

The original spec proposed replacing Contour cleanup's per-model threshold with an
automatic geometric discriminator. That did not work. What shipped instead is a
second per-model control alongside the first. The reasoning is kept here because
three plausible metrics were measured and rejected, and re-deriving those dead ends
would cost more than reading this.

**Scope: Step 4's own drop test only.** Not related to the axis-aligned orthographic
view problem — see `PHASE4-contour-aligned-views.md`, where Step 4 was measured and
excluded. Do not conflate the two.

---

## 1. What ships

Step 4 (`buildContourDrops`, §6.5 in `js/worker/solver.js`) decides, per cut interval
on a Contour segment, whether an outward backdrop belonging to the **same shell** is a
triangulation artifact (drop it) or a genuine fold where the shape passes close in
front of itself (keep it).

Two tests, composed — a stretch is dropped only if **both** agree:

```
drop  ⟺  depth-similar  AND  within N hops across the surface
```

| control | where | range | default | feeds |
|---|---|---|---|---|
| **Contour cleanup** | Lines, under the Contour layer rows | 0 – 0.06 | 0.022 | `CONTOUR_DEPTH_SIMILAR_FRAC_WORLD` — world depth gap as a fraction of `M.radius` |
| **Max surface hops** | Lines, directly below it | 1 – 20 | 3 | `hopLimit` — face-adjacency steps from the edge's own faces to the backdrop face |

The hop test is `makeHopProbe` in the same function: a bounded N-ring flood over a
face→face adjacency map, early-returning the moment the backdrop face appears. It is
a **veto only** — it can turn a drop into a keep, never the reverse — and it runs only
on candidates the depth test already wants to drop, so a keep never pays for it. A
triangle mesh's N-ring is about 3N² faces, a dozen or so at the default, which is why
this is affordable where a per-candidate search inside `occlude()` would not be.

Its input is `M.faceAdjStart` / `M.faceAdjList` (`js/worker/mesh.js`): CSR
face-adjacency, derived in one O(ne) pass from `et0`/`et1` at load, taking only edges
with two faces so boundary and non-manifold edges correctly read as "no path". Pure
topology, invariant under both camera and the Rotate-model panel, so it is built once
per model and never per generate.

**Both controls are per-model and that is deliberate.** Across the test set the useful
values were roughly 0.020–0.030 for cleanup and 1–7 for hops, in different
combinations per scene. Every scene reached an acceptable result; no single pair
served all of them.

## 2. What was tried and rejected

The spec's premise was that an artifact's backdrop is topologically *near* (the
neighbouring triangle across a diagonal) while a real fold's backdrop is topologically
*far* (a walk around the whole glyph) even when close in space — and that some
normalization of that distance would be model-independent. Three candidates were
measured against `counts.dbgStep4Detail`, on a ~20k-triangle model and on faceted 3D
text, with every same-shell decision recorded, drops and keeps alike.

**`surfLen / straight` — the spec's own preferred metric. Rejected: it inverts.**
Drops sat at 2.16 median against keeps at 1.82 on one model, 29.8 against 2.29 on the
other. `straight` is small for drops *by construction* — depth-similarity is the only
reason they reach the test — so dividing by it cancels the very signal being measured.

**Hop count. Rejected: no separation.** Drop median 24 hops against keep median 62,
with the interquartile boxes overlapping across [46, 79], on the text model. The cause
is worse than the density-dependence the spec anticipated: a fan or strip
triangulation puts two *spatially adjacent* triangles an arbitrary number of hops
apart, so the metric varies within a single model, and faceted letterforms are full of
both.

**`surfLen / M.radius`. Rejected: separates cleanly, but the boundary does not
transfer.** On the 20k model the drop and keep [p10, p90] boxes were disjoint —
[0.018, 0.064] against [0.085, 0.423], 9× between medians — which is the only clean
result in the whole exercise. On the text model both populations sat beyond 0.2 R.
`0.2 R` is a different number of triangles on each model, so the threshold that worked
on one was meaningless on the other.

The pattern across all three: hops normalizes by triangle *count*, which varies within
a model; `surfLen/R` normalizes by model *size*, which varies between models; the
ratio normalizes by a quantity that is small by construction. Nothing available was
invariant in both directions at once.

Note that the hop test **ships anyway**, despite failing as an automatic
discriminator. Failing to separate the depth test's own labels is not the same as
being useless: those labels were never ground truth, and with the limit exposed as a
control the two tests together reach results neither reaches alone.

## 3. Diagnostics

- `counts.dbgStep4` — per-segment drop intervals.
- `counts.dbgStep4Detail` — one record per same-shell decision, drops and keeps alike,
  capped at 4000 (`counts.dbgStep4Truncated` flags it). Columns: `gapWorld`, `thresh`,
  `ratio` (`gapWorld/thresh`, so < 1 dropped on depth, ≥ 1 survived it), `drop`, and
  `vetoHops`. Read the last two together — a stretch survives if *either* test says
  keep:
  ```js
  const d = lastGen.counts.dbgStep4Detail;
  console.table(d.filter(r => r.vetoHops === -1))   // restored by the hop veto
  console.table(d.filter(r => r.vetoHops >= 1))     // near enough that the drop stood
  console.table(d.filter(r => r.drop).sort((a,b) => b.ratio - a.ratio).slice(0,40))
  ```
- `counts.dbgStep4Vetoed` — how many stretches the veto restored this generate. Unlike
  the `dbgStep4Detail` rows this is a true total, never truncated.
- `counts.dbgStep4Frac`, `counts.dbgStep4HopLimit` — the two settings in force.

The `debugNoStep4` kill-switch was removed along with this work; to isolate whether
Step 4 is what removed a given line, set Contour cleanup to 0 and Max surface hops to
1, which is very nearly the same thing.

## 4. If this is revisited

The measurement scaffolding (a Dijkstra over the face adjacency with centroid hop
costs, real endpoints recovered via `worldOnFace`, and `hops`/`surfLen`/`surfRatio`
columns) was removed once it had answered its question; it is in the git history if
the numbers above need re-deriving. Two things worth knowing before rebuilding it:

- Run it on **candidate drops only**. Keeps outnumber drops ~9:1 and have larger gaps,
  so a search radius proportional to the gap costs the most on the population that
  needs it least. That mistake cost roughly 10× the generate time twice, in two
  different disguises.
- A per-decision search is affordable here (a few hundred candidates) and is *not*
  affordable inside `occlude()`. Don't carry the approach across.
