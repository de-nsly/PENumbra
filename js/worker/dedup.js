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
// Also used directly by generate() (solver.js), which imports it from here
// rather than the reverse — dedupCollinear/subtractCovered need it too, and
// defining it here keeps this module a leaf with no import back to solver.js.
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
// Fallback tolerances only. The noise these absorb (two independently
// computed copies of the same edge disagreeing slightly) lives in WORLD
// space, so a fixed pixel value covers less of it the further the view is
// zoomed in; generate() (solver.js, step 1.2) derives the real per-call
// values (effOffTol/effGapTol) from the mesh's precision floor and the
// current view scale and passes them in explicitly.
const DEDUP_OFF_TOL = 0.15;                 // px, perpendicular-distance match
const DEDUP_GAP_TOL = 0.3;                  // px, along-line — bridges touching pieces
// Direction matching is a fixed ±1-bucket / 0.999-dot test. A length-
// adaptive angular tolerance was tried for short segments and rejected:
// it made generation noticeably slower on models with many short edges.
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

/* keepOrder: return the surviving pieces in the INPUT's own segment order,
   each in its input segment's own direction. The clustering below regroups
   segments by angle bucket and sweeps each cluster in canonical +t order, so
   by default the output order is unrelated to the input's. Crease (cv/ch)
   needs this: the worker pushes it in chain-walk order and the main thread's
   mergeAdjacentTouching (js/chain.js) joins it by array adjacency alone —
   measured on the demo mesh, the regrouping left 6–17% of chain neighbours
   array-adjacent, and mergeCreaseScreenSpace's arbitrary junction pairing
   ended up doing nearly all the joining. The ink itself is identical either
   way; only its order differs. so/iv/ih leave it off: chainSegments picks
   its chain start points in array order, so reordering them would move their
   output for no gain. */
export function dedupCollinear(arr, offTol=DEDUP_OFF_TOL, gapTol=DEDUP_GAP_TOL, keepOrder=false){
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
  let srcOf = i => i;                       // index into `arr` -> index into the caller's input
  if (keepIdx.length < n0){
    const reduced = [];
    for (const i of keepIdx) reduced.push(arr[i*4],arr[i*4+1],arr[i*4+2],arr[i*4+3]);
    arr = reduced;
    srcOf = i => keepIdx[i];
  }
  const n = arr.length/4;
  if (n < 2) return arr;
  const { clusters } = clusterCollinear(arr, offTol, gapTol);
  const out = [];
  const pieceSrc = [];                      // keepOrder only: input index each emitted piece sorts by
  const emit = (src, ax,ay,bx,by) => { out.push(ax,ay,bx,by); if (keepOrder) pieceSrc.push(src); };
  for (const L of clusters){
    if (L.idxs.length < 2){
      const i = L.idxs[0];
      const x0=arr[i*4],y0=arr[i*4+1],x1=arr[i*4+2],y1=arr[i*4+3];
      if (Math.hypot(x1-x0,y1-y0) > MIN_SEG) emit(srcOf(i), x0,y0,x1,y1);
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
      // src/plus: the input segment's index, and whether it runs along +t
      spans.push([lo,hi,{ src: srcOf(i), plus: t0r<=t1r }]);
    }
    spans.sort((a,b)=>a[0].t-b[0].t);
    /* A backbone can absorb several input segments, so for keepOrder it is
       placed at its LOWEST contributing input index (the same "lowest
       contributing id" rule mergeContourRunSplits uses) and drawn in that
       contributor's direction — this sweep always emits in +t order. */
    let bMeta = spans[0][2];
    const flush = (bs, be) => {
      if (be.t - bs.t <= MIN_SEG) return;
      if (keepOrder && !bMeta.plus) emit(bMeta.src, be.x, be.y, bs.x, bs.y);
      else emit(bMeta.src, bs.x, bs.y, be.x, be.y);
    };
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
      const ns = spans[k][0], ne = spans[k][1], nm = spans[k][2];
      if (ne.t <= be.t){
        continue;                                  // fully redundant — drop
      }
      if (ns.t <= be.t){
        // overlaps and extends further: keep backbone whole, trim next's
        // own head at t=be.t using ONLY next's two endpoints
        flush(bs, be);
        const frac = (be.t - ns.t) / Math.max(1e-9, ne.t - ns.t);
        bs = { t: be.t, x: ns.x + (ne.x-ns.x)*frac, y: ns.y + (ne.y-ns.y)*frac };
        be = ne;
        bMeta = nm;
      } else if (ns.t <= be.t + gapTol){
        be = ne;                                    // real gap, but bridgeable
        if (nm.src < bMeta.src) bMeta = nm;
      } else {
        flush(bs, be);
        bs = ns; be = ne;
        bMeta = nm;
      }
    }
    flush(bs, be);
  }
  if (!keepOrder) return out;
  const order = pieceSrc.map((s,i) => [s,i]).sort((a,b) => a[0]-b[0] || a[1]-b[1]);
  const ordered = [];
  for (const [,i] of order) ordered.push(out[i*4], out[i*4+1], out[i*4+2], out[i*4+3]);
  return ordered;
}

/* Remove, from `loArr`, any portion that lies on the same infinite line AND
   overlaps a segment in `hiArr` (already-deduped, higher-drawing-priority
   layer). Unlike dedupCollinear this does NOT merge the two into one output
   — sv/cv keep distinct pens/weights on purpose — it only prevents the
   plotter from re-stroking ink a higher-priority layer already covers.
   A lo segment can emerge as zero, one, or several pieces (if hi coverage
   has a gap inside it, both remaining ends survive as separate segments).
   Segments with no collinear match in hiArr pass through unchanged. */
/* runIds/seqs: optional parallel identity arrays, one entry per input lo
   segment, carried by the Contour layers (sv/sh) only. subtractCovered only
   ever trims or removes — it never merges two lo segments together — so
   every surviving piece simply copies its source lo segment's runId/seq
   verbatim; a split just yields two pieces sharing that same pair, which
   chainByRun's endpoint-adjacency walk (js/chain.js) resolves correctly
   on its own. When supplied, returns { arr, runIds, seqs } instead of a bare
   array; every other caller omits them and gets the plain-array return. */
export function subtractCovered(loArr, hiArr, offTol=DEDUP_OFF_TOL, gapTol=DEDUP_GAP_TOL, runIds=null, seqs=null){
  const hn0 = hiArr.length/4;
  if (!hn0 || !loArr.length) return runIds ? { arr: loArr, runIds, seqs } : loArr;
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
  const remainingRunIds = runIds ? [] : null;
  const remainingSeqs = seqs ? [] : null;
  for (let i=0;i<ln0;i++){
    const x0=loArr[i*4],y0=loArr[i*4+1],x1=loArr[i*4+2],y1=loArr[i*4+3];
    if (hiExact.has(exactDupPairKey(x0,y0,x1,y1))) continue;   // exact duplicate — fully covered, drop
    remainingLo.push(x0,y0,x1,y1);
    if (runIds){ remainingRunIds.push(runIds[i]); remainingSeqs.push(seqs[i]); }
  }
  loArr = remainingLo;
  if (runIds){ runIds = remainingRunIds; seqs = remainingSeqs; }
  const hn = hiArr.length/4;
  if (!hn || !loArr.length) return runIds ? { arr: loArr, runIds, seqs } : loArr;
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
  const outRunIds = runIds ? [] : null;
  const outSeqs = seqs ? [] : null;
  const ivs = [];                                        // scratch, reused per lo segment
  for (let i=0;i<ln;i++){
    const x0=loArr[i*4],y0=loArr[i*4+1],x1=loArr[i*4+2],y1=loArr[i*4+3];
    const emitPiece = (ax,ay,bx,by) => {
      out.push(ax,ay,bx,by);
      if (runIds){ outRunIds.push(runIds[i]); outSeqs.push(seqs[i]); }
    };
    let dx=x1-x0, dy=y1-y0; const len=Math.hypot(dx,dy);
    if (len<1e-6) continue;
    dx/=len; dy/=len;
    if (dx<0 || (dx===0 && dy<0)){ dx=-dx; dy=-dy; }
    const nx=-dy, ny=dx, c=nx*x0+ny*y0;
    const found = findCollinearMatch(hiClustered, offTol, gapTol, x0,y0,x1,y1);
    if (!found){ emitPiece(x0,y0,x1,y1); continue; }     // no collinear hi coverage — keep as-is
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
    let cur=t0, ivIdx=0;
    while (ivIdx<ivs.length){
      let s=ivs[ivIdx][0], e=ivs[ivIdx][1]; ivIdx++;
      while (ivIdx<ivs.length && ivs[ivIdx][0]<=e+gapTol){ if (ivs[ivIdx][1]>e) e=ivs[ivIdx][1]; ivIdx++; }
      if (e<=cur || s>=t1) continue;
      // MIN_SEG guard: a leftover sliver from a coverage boundary landing a
      // hair's-width from cur (floating-point noise between two independent
      // computation paths, not a real gap) must not surface as an emitted
      // segment — some plotter software treats near-zero-length paths as
      // literal zero-length "points" rather than dropping them
      const segEnd = Math.min(s,t1);
      if (segEnd-cur > MIN_SEG) emitPiece(px+tx*cur,py+ty*cur, px+tx*segEnd,py+ty*segEnd);
      cur = Math.max(cur, e);
      if (cur>=t1) break;
    }
    if (t1-cur > MIN_SEG) emitPiece(px+tx*cur,py+ty*cur, px+tx*t1,py+ty*t1);
  }
  return runIds ? { arr: out, runIds: outRunIds, seqs: outSeqs } : out;
}

/* Cross-run coincidence removal WITHIN one Contour layer.
   Two parts of the mesh whose silhouettes project onto the same screen line
   each produce their own Contour run, and both are genuinely visible —
   neither occludes the other, since they graze. Nothing upstream removes
   either, so the plotter re-strokes that stretch: on an X-aligned view of the
   pipe model, 92mm of ink drawn twice, the two strands 20-55µm apart on the
   page. Generic (off-axis) views have none of it at all — this is an artifact
   of coincident projection, not a general property of Contour.

   Deliberately NOT built on dedupCollinear or subtractCovered, both of which
   were tried and measured first:
     - dedupCollinear CLUSTERS and MERGES collinear strands into a new
       backbone, blind to depth and run identity, and corrupts self-crossing
       Contour (see the intra-layer dedup pass in solver.js for why sv/sh
       are excluded from it).
     - subtractCovered only ever trims, but it subtracts against a MERGED
       backbone of every higher-priority run at once, so unrelated runs that
       merely pass near each other compound into coverage that was never
       really there. Measured: it deleted real geometry in 14 of 28 sweep
       views, generic ones included, and the losses barely moved when the
       tolerance was tightened — the accumulation, not the tolerance, was the
       problem. It also has to regroup segments by run, and that reordering
       alone perturbed the cross-layer cascade downstream even in views where
       nothing at all was removed.
   So this is a direct pairwise pass instead: a segment only ever yields to
   ONE other segment at a time, each of which must independently pass the
   full coincidence test, and the output keeps the input's segment order so a
   view with no coincidence is a bit-exact no-op.

   Priority is longest-run-first, run id breaking ties: the longest continuous
   stroke keeps all its ink and shorter coincident runs yield. Since every
   strand involved is visible Contour, which one survives is a plotter-economy
   question, not a correctness one — the drawn page looks the same either way. */
export function dedupCrossRunCoincident(arr, runIds, seqs, offTol=DEDUP_OFF_TOL){
  const n = arr.length/4;
  if (n < 2) return { arr, runIds, seqs };
  // rank each run: longest total length first, run id as a stable tie-break
  const lenByRun = new Map();
  for (let i=0;i<n;i++){
    const L = Math.hypot(arr[i*4+2]-arr[i*4], arr[i*4+3]-arr[i*4+1]);
    lenByRun.set(runIds[i], (lenByRun.get(runIds[i]) || 0) + L);
  }
  if (lenByRun.size < 2) return { arr, runIds, seqs };   // one run can't duplicate itself
  const ranked = [...lenByRun.keys()].sort((a,b) => lenByRun.get(b) - lenByRun.get(a) || a - b);
  const rank = new Map(ranked.map((r,i) => [r,i]));
  const order = [];                                      // segment indices, highest-priority run first
  for (let i=0;i<n;i++) order.push(i);
  order.sort((x,y) => rank.get(runIds[x]) - rank.get(runIds[y]) || x - y);

  /* Two descriptions of the same segment, for two different jobs.
     `ux,uy` is the segment's OWN direction, used for every interval
     computation and for emitting: pieces are built from the segment's own
     start point along its own direction, so a surviving piece keeps both the
     position AND the orientation of its input. (Parameterising along a
     canonicalized direction instead mirrors every leftward segment about its
     own start point — geometry moved bodily across the page — and even done
     correctly it would reverse endpoints, which chainByRun reads as a broken
     chain and splits.)
     Nothing else is derived from the direction — candidate lookup is spatial
     (see the grid below), so there is no canonicalized form to keep in step. */
  const describe = (x0,y0,x1,y1) => {
    let ux = x1-x0, uy = y1-y0;
    const L = Math.hypot(ux,uy);
    if (L < 1e-12) return null;
    ux /= L; uy /= L;
    return { x0, y0, ux, uy, L };
  };
  /* Candidate lookup is SPATIAL — a grid over screen space, each segment
     registered in every cell it passes through — and never line-parametric.
     Bucketing on (quantized direction, perpendicular offset) is the obvious
     choice and is wrong here: that offset is measured from the origin, so two
     strands that are 0.2px apart but differ in direction by a thousandth land
     several buckets apart once they sit a few hundred px out (offset moves by
     y·Δdirection — a 646px lever arm turns 0.003 of direction into 2px of
     offset). It also has a seam at vertical, where canonicalizing into the
     right half-plane sends the same physical line to either end of the angle
     range. Both failure modes silently drop candidates.
     Two segments that overlap on the page are, by definition, in the same
     neighbourhood of it — so proximity is the filter that cannot miss. */
  const CELL = Math.max(8, offTol * 8);
  const grid = new Map();
  const cellsAlong = (s, fn) => {
    const steps = Math.max(1, Math.ceil(s.L / CELL) + 1);
    let pcx = NaN, pcy = NaN;
    for (let k = 0; k <= steps; k++){
      const t = (k/steps) * s.L;
      const cx = Math.floor((s.x0 + s.ux*t) / CELL), cy = Math.floor((s.y0 + s.uy*t) / CELL);
      if (cx === pcx && cy === pcy) continue;
      pcx = cx; pcy = cy;
      fn(cx, cy);
    }
  };
  const addSurvivor = (s, run) => {
    const entry = { s, run };
    cellsAlong(s, (cx, cy) => {
      // one cell ring of slack, so a candidate running just outside this
      // segment's own cells is still reachable
      for (let dx=-1; dx<=1; dx++) for (let dy=-1; dy<=1; dy++){
        const k = (cx+dx) + ':' + (cy+dy);
        let list = grid.get(k);
        if (!list){ list = []; grid.set(k, list); }
        list.push(entry);
      }
    });
  };

  /* Survivors, not originals, are what a segment is tested against. Runs are
     visited highest-priority first, so by the time a run is reached every run
     that could take ink from it is already final — testing against the
     original array instead lets a three-way chain lose ink for real (the
     middle run yields to the top one, the bottom run yields the same stretch
     to the middle one's ORIGINAL extent, and nothing is left drawing it). */
  const piecesAt = new Array(n);                          // original index -> surviving pieces
  for (const i of order){
    const a = describe(arr[i*4], arr[i*4+1], arr[i*4+2], arr[i*4+3]);
    if (!a){ piecesAt[i] = []; continue; }                 // degenerate; the MIN_SEG guard would drop it anyway
    const nx = -a.uy, ny = a.ux;                           // a's own normal
    const cover = [];
    const seen = new Set();                                // a candidate sits in many cells
    const lists = [];
    cellsAlong(a, (cx, cy) => { const l = grid.get(cx + ':' + cy); if (l) lists.push(l); });
    for (const list of lists){
      for (const entry of list){
        if (seen.has(entry)) continue;
        seen.add(entry);
        const { s: q, run } = entry;
        if (run === runIds[i]) continue;                   // a run never duplicates itself
        /* Coincidence = the SHORTER segment lies within offTol of the LONGER
           one's line (both of its endpoints). No direction comparison: a short
           segment's direction is mostly positional noise — on a 0.5px micro-run
           lying right on top of a long run, 0.015px of offset already tilts it
           1.7°, which a parallel test rejects, leaving a sub-pen-mark sliver
           drawn over real ink. And the band test alone is enough: a segment
           whose endpoints both sit inside the other's offTol band is parallel
           to it to within 2·offTol over its own length, or it is too short for
           the difference to be visible. */
        const qx1 = q.x0 + q.ux*q.L, qy1 = q.y0 + q.uy*q.L;
        if (q.L >= a.L){
          const qnx = -q.uy, qny = q.ux;
          const e0 = Math.abs((a.x0-q.x0)*qnx + (a.y0-q.y0)*qny);
          const e1 = Math.abs((a.x0+a.ux*a.L-q.x0)*qnx + (a.y0+a.uy*a.L-q.y0)*qny);
          if (e0 > offTol || e1 > offTol) continue;
        } else {
          const d0 = Math.abs((q.x0-a.x0)*nx + (q.y0-a.y0)*ny);
          const d1 = Math.abs((qx1  -a.x0)*nx + (qy1  -a.y0)*ny);
          if (d0 > offTol || d1 > offTol) continue;
        }
        const t0 = (q.x0-a.x0)*a.ux + (q.y0-a.y0)*a.uy;
        const t1 = (qx1  -a.x0)*a.ux + (qy1  -a.y0)*a.uy;
        let lo = Math.max(0, Math.min(t0,t1)), hi = Math.min(a.L, Math.max(t0,t1));
        /* Snap an interval end that lands a float-noise distance from this
           segment's own end onto it. Two runs that meet at a shared mesh
           vertex compute that point down two different paths, so the cover
           can start 5e-5px short of t=0 — and that crumb then reads as a
           "stranded sliver" below and abandons the trim for the whole
           segment. Measured: it was why the largest doubled stretch in the
           pipe scene (55px) survived untouched. EXACT_DUP_EPS is the module's
           existing "same point, different arithmetic" scale. */
        if (lo < EXACT_DUP_EPS) lo = 0;
        if (hi > a.L - EXACT_DUP_EPS) hi = a.L;
        // every real overlap counts, however short. Filtering these by MIN_SEG
        // (the obvious-looking guard) punches a sub-MIN_SEG hole into otherwise
        // continuous coverage wherever a covering run's segment boundary falls
        // just inside this one — and that hole then becomes a stranded sliver,
        // which abandons the trim for the whole segment. The MIN_SEG guard
        // belongs on what is EMITTED, not on what counts as covered.
        if (hi > lo + 1e-9) cover.push([lo, hi]);
      }
    }
    const pieces = [];
    if (!cover.length){
      // untouched: the whole segment survives as one piece
      pieces.push(describe(arr[i*4], arr[i*4+1], arr[i*4+2], arr[i*4+3]));
    } else {
      cover.sort((p,q) => p[0]-q[0]);
      /* A remainder too short to be its own pen mark is dropped, the same way
         subtractCovered drops one. Two runs that coincide rarely have their
         segment boundaries in the same places, so a trim usually ends a
         sub-MIN_SEG crumb short of the segment's end; the surviving strand
         sits at most offTol away, so the crumb's ink is still on the page.
         The cost is in the CHAINS: dropping the crumb cuts the run there, and
         a closed loop that loses a stretch to a coincident run opens up.
         Measured against abandoning such trims instead (X-aligned pipe, 14
         views): far less residual double ink (23mm vs 160mm) and fewer pen
         lifts overall, at the price of one opened ring. No ink lost from the
         page either way. */
      const keep = (s,e) => {
        if (e - s <= MIN_SEG) return;
        pieces.push(describe(a.x0 + a.ux*s, a.y0 + a.uy*s, a.x0 + a.ux*e, a.y0 + a.uy*e));
      };
      let cur = 0;
      for (const [s,e] of cover){
        if (e <= cur) continue;
        if (s > cur) keep(cur, s);
        cur = e;
        if (cur >= a.L) break;
      }
      if (cur < a.L) keep(cur, a.L);
    }
    piecesAt[i] = pieces.filter(Boolean);
    for (const p of piecesAt[i]) addSurvivor(p, runIds[i]);
  }
  // emit in the INPUT's own segment order — regrouping by run was measured to
  // perturb the cross-layer cascade downstream even where nothing was removed
  const outArr = [], outRunIds = [], outSeqs = [];
  for (let i=0;i<n;i++){
    for (const p of piecesAt[i]){
      outArr.push(p.x0, p.y0, p.x0 + p.ux*p.L, p.y0 + p.uy*p.L);
      outRunIds.push(runIds[i]); outSeqs.push(seqs[i]);
    }
  }
  return { arr: outArr, runIds: outRunIds, seqs: outSeqs };
}
