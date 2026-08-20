/* ================================================================
   worker/dedup.js — collinear-overlap dedup & coverage subtraction
   Cleans up the double-struck ink two independent generation paths can
   land on the same infinite line (dedupCollinear), and removes ink a
   higher-priority layer already covers from a lower one
   (subtractCovered) — see generate() in solver.js for how these feed
   the layer ink-avoidance cascade. pairJunctionArms lives here too:
   unrelated to the line-overlap problem, but the smallest of the
   three exported "line-layer cleanup" helpers generate() calls.
   ================================================================ */
export const MIN_SEG = 0.3;        // min output segment length, px
/* 7.5 · collinear-overlap dedup — line layers only (never hatch: those
   strokes are deliberately parallel-adjacent, not overlapping).
   Two mechanisms legitimately produce exact-duplicate or partially
   overlapping segments on the SAME infinite line: (a) a straight edge that
   is split into several pieces by occlusion, where adjacent pieces abut but
   independent generation paths (silhouette vs. crease vs. boundary) can
   also land two full edges on an identical screen line — e.g. a window
   frame's front and back edge in an orthographic front view; and (b) two
   edges from different shells that are coincidentally coplanar+collinear in
   the current view. Both cases mean the plotter would trace the same
   physical stroke twice. Cluster segments by (angle, perpendicular offset)
   to find shared infinite lines, then union their 1D intervals along that
   line: exact duplicates and partial overlaps collapse to one run; a real
   gap between two collinear segments still keeps them separate. */
const DEDUP_ANG_BUCKETS = 720;              // 0.25° resolution
// DEDUP_OFF_TOL/DEDUP_GAP_TOL used to be fixed pixel constants — but the
// thing they're absorbing (small positional noise between independently-
// computed copies of the same edge, e.g. a front-pass vs back-pass
// silhouette/crease split) lives in WORLD space, not screen space. Under
// orthographic projection especially, zooming in doesn't change that
// world-space noise at all, but it directly multiplies how many screen
// pixels it projects to — so a fixed pixel tolerance silently represents
// less and less of the real noise the more the user zooms in, until it
// stops absorbing it at all (see the zoom-dependent hidden-crease
// investigation). generate() now computes the actual per-call values
// (effOffTol/effGapTol below) from the mesh's own precision floor and the
// CURRENT view's world-to-pixel scale, and passes them into dedupCollinear/
// subtractCovered explicitly. These two constants remain only as the
// default fallback for any future/test caller that doesn't supply values.
const DEDUP_OFF_TOL = 0.15;                 // px, perpendicular-distance match (fallback default)
const DEDUP_GAP_TOL = 0.3;                  // px, along-line — bridges touching pieces (fallback default)
// NOTE: a length-adaptive angular tolerance (DEDUP_BASE_ANG_TOL/
// DEDUP_MAX_ANG_TOL, plus a matching adaptive bucket-search window in both
// functions below) previously lived here to fix short-segment matching
// failures — but it also carried a real performance cost (widened bucket
// search + O(k²) pairwise testing in dedupCollinear, more accumulated
// per-lo-segment work in subtractCovered) that made generation noticeably
// slower on models with lots of short segments. Reverted back to the fixed,
// cheap ±1-bucket/fixed-dot-threshold matching below while we look for a
// way to get both the correctness and the speed at the same time.
/* Given the unit "arm" directions of every crease edge incident to one
   junction vertex (each arm points AWAY from the vertex, along its edge),
   decide which pairs of edges should be treated as "the same curve
   continuing straight through" this junction, for crease-chain assembly.

   Priority is deliberately two-tiered:
     1. MAXIMIZE how many edges get paired at all. This directly serves the
        actual goal (fewest pen lifts) — pairing is preferable to leaving a
        terminus almost everywhere, including ordinary right-angle turns
        (a plain box corner, three mutually perpendicular edges, scores an
        identical dot=0 for every candidate pair — treating that as "not
        worth pairing" would mean a box's edges never chain across any of
        its 8 corners, undermining the feature for its most common shape).
     2. AMONG matchings that are equally maximal, prefer the one with the
        lowest total dot(armA, armB) — i.e. the straightest continuation.
        This is what turns an ambiguous multi-edge junction into the
        geometry-following choice instead of an arbitrary one.
   The only candidates excluded outright (never counted toward maximality
   at all) are near-total fold-backs — two edges pointing in almost the
   same direction, which isn't a continuation so much as retracing the
   same path.

   Returns a list of [i,j] index pairs into `arms`; any index not appearing
   in any pair is a terminus at this vertex.
   Exact brute-force over all matchings for ordinary valence (≤8 incident
   edges — at most 105 perfect matchings, trivial). Falls back to a greedy
   nearest-pair-first heuristic for pathological high-valence vertices (e.g.
   a mesh pole where dozens of edges converge), where exact enumeration would
   blow up combinatorially — not guaranteed optimal there, but linear-ish,
   deterministic, and keeps generate() from hanging on a rare mesh shape. */
const CREASE_FOLDBACK_DOT = 0.9;   // exclude only near-total reversals (~<26° from a full fold)
export function pairJunctionArms(arms){
  const n = arms.length;
  const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  if (n > 8){
    const used = new Uint8Array(n), pairs = [];
    for (;;){
      let bi=-1, bj=-1, bd=Infinity;
      for (let i=0;i<n;i++){
        if (used[i]) continue;
        for (let j=i+1;j<n;j++){
          if (used[j]) continue;
          const d = dot(arms[i], arms[j]);
          if (d >= CREASE_FOLDBACK_DOT) continue;
          if (d < bd){ bd=d; bi=i; bj=j; }
        }
      }
      if (bi<0) break;
      used[bi]=1; used[bj]=1;
      pairs.push([bi,bj]);
    }
    return pairs;
  }
  let bestCount = -1, bestScore = Infinity, bestPairs = [];
  const used = new Uint8Array(n);
  const rec = (curPairs, curScore) => {
    let first=-1;
    for (let i=0;i<n;i++) if (!used[i]){ first=i; break; }
    if (first<0){
      if (curPairs.length > bestCount ||
          (curPairs.length === bestCount && curScore < bestScore)){
        bestCount = curPairs.length; bestScore = curScore; bestPairs = curPairs.slice();
      }
      return;
    }
    used[first]=1;                       // branch: leave `first` unpaired here
    rec(curPairs, curScore);
    used[first]=0;
    for (let j=first+1;j<n;j++){         // branch: pair `first` with each viable partner
      if (used[j]) continue;
      const d = dot(arms[first], arms[j]);
      if (d >= CREASE_FOLDBACK_DOT) continue;  // near-total fold-back only — see comment above
      used[first]=1; used[j]=1;
      curPairs.push([first,j]);
      rec(curPairs, curScore + d);
      curPairs.pop();
      used[first]=0; used[j]=0;
    }
  };
  rec([], 0);
  return bestPairs;
}

/* ================================================================
   Shared "same real infinite line" clustering, used by both dedupCollinear
   (cleans up ONE layer's own self-overlap) and subtractCovered (removes ink
   a higher-priority layer already covers from a lower one). Both used to
   maintain their own near-duplicate copy of this logic, patched separately
   — which is exactly how they drifted into different bugs on the same
   underlying problem. One correct implementation now, shared.

   Two segments belong in the same cluster iff: (a) matching direction
   (within a few degrees), (b) matching perpendicular offset — bounded on
   the GROUP's total accumulated spread, not distance from whichever member
   happened to be inserted first, so a chain of members each close to their
   immediate neighbor stays correctly bounded rather than silently drifting
   further than the tolerance is meant to represent — AND (c) connected via
   an actual, position-contiguous chain of overlapping-or-near (within
   gapTol) segments along that line.

   (c) is the subtle part. A streaming pass that processes segments in
   whatever order they happen to arrive in the input array can't get this
   right in general: skip the position check and a chain of merely-similar
   offset can fuse together completely unrelated segments from opposite
   ends of a complex model (confirmed directly: with ~19k triangles' worth
   of silhouette edges, some pair having a coincidentally similar angle and
   offset is close to guaranteed). Keep the position check but process in
   arrival order, and a genuine single line can fragment into multiple
   clusters purely because its two ends happened to be visited before the
   middle piece that bridges them — confirmed directly too: Individual and
   Silhouette compute identical geometry but can emit it in different
   array order, and that alone was enough to make them cluster differently.
   The fix used here: within each direction bucket, sort candidates by
   POSITION along the line before doing the sequential merge pass. Once
   segments are visited in true along-the-line order, a cluster's
   accumulated span always accurately reflects everything that genuinely
   precedes the segment currently being tested — so the position check is
   simultaneously safe from both failure modes, regardless of the input
   array's original order. */
function clusterCollinear(arr, offTol, gapTol){
  const n = arr.length/4;
  const result = { clusters: [], buckets: new Map() };
  if (n === 0) return result;

  const segNx=new Float64Array(n), segNy=new Float64Array(n), segC=new Float64Array(n);
  const segBi=new Int32Array(n).fill(-1);
  for (let i=0;i<n;i++){
    const x0=arr[i*4],y0=arr[i*4+1],x1=arr[i*4+2],y1=arr[i*4+3];
    let dx=x1-x0, dy=y1-y0; const len=Math.hypot(dx,dy);
    if (len<1e-6) continue;                  // degenerate — excluded, never clustered
    dx/=len; dy/=len;
    if (dx<0 || (dx===0 && dy<0)){ dx=-dx; dy=-dy; }   // canonical half-plane
    let ang=Math.atan2(dy,dx); if (ang<0) ang+=Math.PI;
    segBi[i] = Math.round(ang/Math.PI*DEDUP_ANG_BUCKETS)%DEDUP_ANG_BUCKETS;
    segNx[i]=-dy; segNy[i]=dx;
    segC[i] = segNx[i]*(x0+x1)/2 + segNy[i]*(y0+y1)/2;
  }

  const primaryBuckets = new Map();
  for (let i=0;i<n;i++){
    if (segBi[i]<0) continue;
    let list = primaryBuckets.get(segBi[i]);
    if (!list){ list=[]; primaryBuckets.set(segBi[i], list); }
    list.push(i);
  }

  const used = new Uint8Array(n);   // an index may appear in 3 buckets; keep first successful pass
  const clusters = result.clusters;
  for (const [bi] of primaryBuckets){
    const candidates = [];
    for (const b of [bi, (bi+1)%DEDUP_ANG_BUCKETS, (bi-1+DEDUP_ANG_BUCKETS)%DEDUP_ANG_BUCKETS]){
      const list = primaryBuckets.get(b);
      if (!list) continue;
      for (const i of list) if (!used[i]) candidates.push(i);
    }
    if (!candidates.length) continue;

    // shared reference tangent for sorting this bucket-pass's candidates —
    // any consistent direction works for ordering purposes, since actual
    // matching below always uses each candidate's/cluster's own true normal
    const refAng = bi/DEDUP_ANG_BUCKETS*Math.PI;
    const refTx = Math.cos(refAng), refTy = Math.sin(refAng);
    candidates.sort((a,b) => (arr[a*4]*refTx+arr[a*4+1]*refTy) - (arr[b*4]*refTx+arr[b*4+1]*refTy));

    const openHere = [];   // clusters formed/touched during THIS bucket-pass
    for (const i of candidates){
      if (used[i]) continue;
      used[i] = 1;
      const x0=arr[i*4],y0=arr[i*4+1],x1=arr[i*4+2],y1=arr[i*4+3];
      const nx=segNx[i], ny=segNy[i], c=segC[i];
      const tx=ny, ty=-nx;
      const t0=x0*tx+y0*ty, t1=x1*tx+y1*ty;
      const tLo=Math.min(t0,t1), tHi=Math.max(t0,t1);

      let found=null, foundDist=Infinity, foundC0=c, foundTLo=tLo, foundTHi=tHi;
      for (const L of openHere){
        if (Math.abs(nx*L.nx+ny*L.ny) < 0.999) continue;
        // Every value merged into a cluster's cMin/cMax/tMin/tMax must be
        // measured with THAT CLUSTER's own (nx,ny) — never this segment's
        // own, even though the two are within the direction tolerance of
        // each other. Adjacent links of one polyline chain routinely have
        // slightly different individual directions; measuring one link's
        // offset with its own normal and then mixing that value into a
        // range meant to be all-one-reference-frame corrupts the range by
        // an amount that grows with distance from the origin — the exact
        // "mixed-normal" bug this codebase has already hit and fixed
        // elsewhere, reintroduced here if the segment's own (c, tLo, tHi)
        // are ever stored directly instead of recomputing via L's basis.
        const c0 = L.nx*(x0+x1)/2 + L.ny*(y0+y1)/2;
        if (Math.max(L.cMax,c0) - Math.min(L.cMin,c0) > offTol) continue;
        const ltx=L.ny, lty=-L.nx;
        const lt0=x0*ltx+y0*lty, lt1=x1*ltx+y1*lty;
        const lTLo=Math.min(lt0,lt1), lTHi=Math.max(lt0,lt1);
        // Safe now — candidates arrive in true along-line order, so L.tMax
        // always accurately reflects everything that genuinely precedes
        // this one; nothing can "not have arrived yet."
        if (lTLo > L.tMax + gapTol) continue;
        const dist = Math.abs(c0 - (L.cMin+L.cMax)/2);
        if (dist < foundDist){ found = L; foundDist = dist; foundC0 = c0; foundTLo = lTLo; foundTHi = lTHi; }
      }
      if (!found){
        found = { nx, ny, cMin:c, cMax:c, tMin:tLo, tMax:tHi, bi, idxs:[] };
        clusters.push(found);
        openHere.push(found);
      } else {
        found.cMin = Math.min(found.cMin, foundC0); found.cMax = Math.max(found.cMax, foundC0);
        found.tMin = Math.min(found.tMin, foundTLo); found.tMax = Math.max(found.tMax, foundTHi);
      }
      found.idxs.push(i);
    }
  }

  for (const L of clusters){
    for (const b of new Set([L.bi, (L.bi+1)%DEDUP_ANG_BUCKETS, (L.bi-1+DEDUP_ANG_BUCKETS)%DEDUP_ANG_BUCKETS])){
      let list = result.buckets.get(b); if (!list){ list=[]; result.buckets.set(b,list); }
      list.push(L);
    }
  }
  return result;
}

/* Query variant of the same matching rule, for a segment that ISN'T itself
   one of the clustered inputs (subtractCovered's lo segments, tested
   against hi's already-built clusters). Prefers a cluster that actually
   overlaps the query's own position over one that's merely closer in
   offset but positionally unrelated — falls back to offset-nearest only
   when nothing overlaps in position at all (harmless either way, since a
   non-overlapping cluster can't provide any real coverage regardless of
   which one gets picked). */
function findCollinearMatch(clusterResult, offTol, gapTol, x0, y0, x1, y1){
  let dx=x1-x0, dy=y1-y0; const len=Math.hypot(dx,dy);
  if (len<1e-6) return null;
  dx/=len; dy/=len;
  if (dx<0 || (dx===0 && dy<0)){ dx=-dx; dy=-dy; }
  let ang=Math.atan2(dy,dx); if (ang<0) ang+=Math.PI;
  const bi=Math.round(ang/Math.PI*DEDUP_ANG_BUCKETS)%DEDUP_ANG_BUCKETS;
  const nx=-dy, ny=dx;
  const mx=(x0+x1)/2, my=(y0+y1)/2;

  let found=null, foundDist=Infinity, foundOverlaps=false;
  for (const b of [bi, (bi+1)%DEDUP_ANG_BUCKETS, (bi-1+DEDUP_ANG_BUCKETS)%DEDUP_ANG_BUCKETS]){
    const cand = clusterResult.buckets.get(b);
    if (!cand) continue;
    for (const L of cand){
      if (Math.abs(nx*L.nx+ny*L.ny) < 0.999) continue;
      const c0 = L.nx*mx+L.ny*my;
      if (Math.max(L.cMax,c0) - Math.min(L.cMin,c0) > offTol) continue;
      const dist = Math.abs(c0 - (L.cMin+L.cMax)/2);
      // Position, like offset above, must be measured in THIS candidate's
      // own reference frame (its own nx,ny) — not the query's — for the
      // same reason: different clusters can have slightly different
      // reference directions, and comparing one globally-computed query
      // position against several different clusters' tMin/tMax produces
      // an inconsistent (sometimes wrong) overlap verdict, exactly the
      // "mixed-normal" bug already fixed in the clustering step itself.
      const ltx=L.ny, lty=-L.nx;
      const lt0=x0*ltx+y0*lty, lt1=x1*ltx+y1*lty;
      const overlaps = Math.max(lt0,lt1) >= L.tMin-gapTol && Math.min(lt0,lt1) <= L.tMax+gapTol;
      if (foundOverlaps && !overlaps) continue;
      if (overlaps && !foundOverlaps){ found=L; foundDist=dist; foundOverlaps=true; continue; }
      if (dist < foundDist){ found = L; foundDist = dist; }
    }
  }
  return found;
}

// A segment whose two endpoints exactly match (within float noise, NOT the
// user's tolerance slider) another segment's is unambiguously the same
// physical edge — this must never be at the mercy of the heuristic
// nearest/overlap tie-breaking clusterCollinear/findCollinearMatch use for
// genuinely close-but-not-identical lines, and must never depend on
// whatever Match-tolerance the person has dialed in. EXACT_DUP_EPS is
// fixed, small, and unrelated to offTol/gapTol on purpose.
const EXACT_DUP_EPS = 1e-4;
const exactDupKey = (x,y) => Math.round(x/EXACT_DUP_EPS) + '_' + Math.round(y/EXACT_DUP_EPS);
const exactDupPairKey = (x0,y0,x1,y1) => {
  const ka=exactDupKey(x0,y0), kb=exactDupKey(x1,y1);
  return ka<kb ? ka+'|'+kb : kb+'|'+ka;
};

export function dedupCollinear(arr, offTol=DEDUP_OFF_TOL, gapTol=DEDUP_GAP_TOL){
  const n0 = arr.length/4;
  if (n0 < 2) return arr;
  // Exact-duplicate fast path — see EXACT_DUP_EPS above. Collapses literal
  // (within float noise) duplicates to one copy each, unconditionally,
  // before the tolerance-based clustering below — the two mechanisms
  // dedupCollinear exists for (independent generation paths landing two
  // full copies of the same edge; adjacent occlusion-split pieces sharing
  // an exact endpoint) both produce EXACT matches here, so this handles
  // the common case with zero exposure to fuzzy tie-breaking, same
  // reasoning as subtractCovered's identical pass.
  const seen = new Map();
  const keepIdx = [];
  for (let i=0;i<n0;i++){
    const key = exactDupPairKey(arr[i*4],arr[i*4+1],arr[i*4+2],arr[i*4+3]);
    if (seen.has(key)) continue;
    seen.set(key, i);
    keepIdx.push(i);
  }
  if (keepIdx.length < n0){
    const reduced = [];
    for (const i of keepIdx) reduced.push(arr[i*4],arr[i*4+1],arr[i*4+2],arr[i*4+3]);
    arr = reduced;
  }
  const n = arr.length/4;
  if (n < 2) return arr;
  const { clusters } = clusterCollinear(arr, offTol, gapTol);
  const out = [];
  for (const L of clusters){
    if (L.idxs.length < 2){
      const i = L.idxs[0];
      const x0=arr[i*4],y0=arr[i*4+1],x1=arr[i*4+2],y1=arr[i*4+3];
      if (Math.hypot(x1-x0,y1-y0) > MIN_SEG) out.push(x0,y0,x1,y1);
      continue;
    }
    // union along the line direction (tx,ty) = (-ny,nx)
    const tx=-L.ny, ty=L.nx;
    const spans = [];
    for (const i of L.idxs){
      const x0=arr[i*4],y0=arr[i*4+1],x1=arr[i*4+2],y1=arr[i*4+3];
      const t0r=x0*tx+y0*ty, t1r=x1*tx+y1*ty;
      // Keep each span's actual raw endpoint attached, not just its t value.
      // The sweep below only ever emits a point that's either one of these
      // verbatim, or interpolated between the TWO points of a single one of
      // these spans — never a blend across two different original spans —
      // so a surviving/trimmed piece's direction always matches some real
      // input segment's direction exactly, never a drifted stand-in.
      const lo = t0r<=t1r ? {t:t0r,x:x0,y:y0} : {t:t1r,x:x1,y:y1};
      const hi = t0r<=t1r ? {t:t1r,x:x1,y:y1} : {t:t0r,x:x0,y:y0};
      spans.push([lo,hi]);
    }
    spans.sort((a,b)=>a[0].t-b[0].t);
    /* Sweep left-to-right maintaining one "backbone" run — either a single
       original span untouched, a TRIMMED remainder of one original span
       (cut only against that span's own two endpoints), or a bridge of
       non-overlapping-but-touching backbones (their real endpoints joined,
       no interior point invented). At every step exactly one of three
       things happens to the next span:
         - fully redundant (contained in the backbone already covered)
           → dropped entirely (rule 1: complete deletion)
         - genuinely overlaps and extends past the backbone
           → backbone emitted as-is, the next span's redundant HEAD is cut
             away using only ITS OWN two endpoints, its surviving tail
             becomes the new backbone (rule 2: partial deletion)
         - only touches within gapTol (a real, separate, but adjoining
           piece — e.g. an occlusion-split edge) → bridged into one
           continuous backbone for fewer pen lifts, same as before
         - a real gap beyond gapTol → backbone finalized, next span starts
           a fresh one
       This never combines a point from one span with a point from a
       genuinely different, merely-nearby-in-tolerance span into a single
       new interior point — the one case that produced the zig-zag: two
       close-but-distinct lines whose interleaved pieces used to get
       stitched together using whichever endpoint happened to be extremal. */
    let bs = spans[0][0], be = spans[0][1];
    for (let k=1; k<spans.length; k++){
      const ns = spans[k][0], ne = spans[k][1];
      if (ne.t <= be.t){
        continue;                                  // fully redundant — drop
      }
      if (ns.t <= be.t){
        // overlaps and extends further: keep backbone whole, trim next's
        // own head at t=be.t using ONLY next's two endpoints
        if (be.t - bs.t > MIN_SEG) out.push(bs.x, bs.y, be.x, be.y);
        const frac = (be.t - ns.t) / Math.max(1e-9, ne.t - ns.t);
        bs = { t: be.t, x: ns.x + (ne.x-ns.x)*frac, y: ns.y + (ne.y-ns.y)*frac };
        be = ne;
      } else if (ns.t <= be.t + gapTol){
        be = ne;                                    // real gap, but bridgeable
      } else {
        if (be.t - bs.t > MIN_SEG) out.push(bs.x, bs.y, be.x, be.y);
        bs = ns; be = ne;
      }
    }
    if (be.t - bs.t > MIN_SEG) out.push(bs.x, bs.y, be.x, be.y);
  }
  return out;
}

/* Remove, from `loArr`, any portion that lies on the same infinite line AND
   overlaps a segment in `hiArr` (already-deduped, higher-drawing-priority
   layer). Unlike dedupCollinear this does NOT merge the two into one output
   — sv/cv keep distinct pens/weights on purpose — it only prevents the
   plotter from re-stroking ink a higher-priority layer already covers.
   A lo segment can emerge as zero, one, or several pieces (if hi coverage
   has a gap inside it, both remaining ends survive as separate segments).
   Segments with no collinear match in hiArr pass through unchanged. */
export function subtractCovered(loArr, hiArr, offTol=DEDUP_OFF_TOL, gapTol=DEDUP_GAP_TOL){
  const hn0 = hiArr.length/4;
  if (!hn0 || !loArr.length) return loArr;
  // Exact-duplicate fast path — see EXACT_DUP_EPS above. Runs first,
  // unconditionally, so a lo segment with a literal duplicate in hi is
  // ALWAYS fully removed, with zero dependence on offTol/gapTol and zero
  // exposure to the fuzzy clustering's heuristic tie-breaking below.
  const hiExact = new Map();
  for (let i=0;i<hn0;i++){
    const key = exactDupPairKey(hiArr[i*4],hiArr[i*4+1],hiArr[i*4+2],hiArr[i*4+3]);
    let list = hiExact.get(key); if (!list){ list=[]; hiExact.set(key,list); }
    list.push(i);
  }
  const ln0 = loArr.length/4;
  const remainingLo = [];
  for (let i=0;i<ln0;i++){
    const x0=loArr[i*4],y0=loArr[i*4+1],x1=loArr[i*4+2],y1=loArr[i*4+3];
    if (hiExact.has(exactDupPairKey(x0,y0,x1,y1))) continue;   // exact duplicate — fully covered, drop
    remainingLo.push(x0,y0,x1,y1);
  }
  loArr = remainingLo;
  const hn = hiArr.length/4;
  if (!hn || !loArr.length) return loArr;
  /* THE SHIFT-BUG FIX. The old version parameterized each hi group's covered
     intervals along the GROUP's own tangent basis, then compared those t
     values against a lo segment's t values computed in the LO segment's
     basis. Any angular mismatch δ between the two "same" lines (real —
     that's what the tolerance matching exists to absorb) makes the two
     parameterizations disagree by ≈ δ × distance-from-screen-origin, so the
     clip boundary landed shifted along the lo line — worse the further from
     the origin, which is the previously-investigated line-shift bug that
     forced hatch clipping to be disabled. Fix: keep the hi segments' RAW
     endpoints per group, and per lo segment project those endpoints into the
     LO segment's OWN basis before subtracting. The boundary then IS the true
     projection of the real hi endpoint onto the lo line — no cross-basis
     comparison anywhere, exact at any distance from the origin. */
  const hiClustered = clusterCollinear(hiArr, offTol, gapTol);
  const ln = loArr.length/4;
  const out = [];
  const ivs = [];                                        // scratch, reused per lo segment
  for (let i=0;i<ln;i++){
    const x0=loArr[i*4],y0=loArr[i*4+1],x1=loArr[i*4+2],y1=loArr[i*4+3];
    let dx=x1-x0, dy=y1-y0; const len=Math.hypot(dx,dy);
    if (len<1e-6) continue;
    dx/=len; dy/=len;
    if (dx<0 || (dx===0 && dy<0)){ dx=-dx; dy=-dy; }
    const nx=-dy, ny=dx, c=nx*x0+ny*y0;
    const found = findCollinearMatch(hiClustered, offTol, gapTol, x0,y0,x1,y1);
    if (!found){ out.push(x0,y0,x1,y1); continue; }     // no collinear hi coverage — keep as-is
    // project the matched group's RAW hi endpoints into THIS lo segment's own
    // tangent axis, then sort + gap-merge + subtract — all in one basis
    const tx=dx, ty=dy;
    ivs.length=0;
    for (const hIdx of found.idxs){
      let ha=hiArr[hIdx*4]*tx+hiArr[hIdx*4+1]*ty, hb=hiArr[hIdx*4+2]*tx+hiArr[hIdx*4+3]*ty;
      if (ha>hb){ const tmp=ha; ha=hb; hb=tmp; }
      ivs.push([ha,hb]);
    }
    ivs.sort((a,b)=>a[0]-b[0]);
    let t0=x0*tx+y0*ty, t1=x1*tx+y1*ty;
    if (t0>t1){ const tmp=t0; t0=t1; t1=tmp; }
    const px=nx*c, py=ny*c;   // fixed point on THIS (lo) segment's own line
    let cur=t0, mi2=0;
    while (mi2<ivs.length){
      let s=ivs[mi2][0], e=ivs[mi2][1]; mi2++;
      while (mi2<ivs.length && ivs[mi2][0]<=e+gapTol){ if (ivs[mi2][1]>e) e=ivs[mi2][1]; mi2++; }
      if (e<=cur || s>=t1) continue;
      // MIN_SEG guard: a leftover sliver from a coverage boundary landing a
      // hair's-width from cur (floating-point noise between two independent
      // computation paths, not a real gap) must not surface as an emitted
      // segment — some plotter software treats near-zero-length paths as
      // literal zero-length "points" rather than dropping them
      const segEnd = Math.min(s,t1);
      if (segEnd-cur > MIN_SEG) out.push(px+tx*cur,py+ty*cur, px+tx*segEnd,py+ty*segEnd);
      cur = Math.max(cur, e);
      if (cur>=t1) break;
    }
    if (t1-cur > MIN_SEG) out.push(px+tx*cur,py+ty*cur, px+tx*t1,py+ty*t1);
  }
  return out;
}
