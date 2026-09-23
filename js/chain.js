/* ================================================================
   chain.js — segment chaining and merge passes
   The main thread's half of the line work: the worker posts flat
   2-point segments per layer and these passes join them into the
   polylines that each become one <path> subpath. Contour (sv/sh)
   chains by solver run (chainByRun -> mergeContourRunSplits),
   Silhouette (so/iv/ih) chains by geometry (chainSegments ->
   mergeSilhouetteClose), Crease (cv/ch) pairs array-adjacent pieces and
   falls back to screen space (mergeAdjacentTouching ->
   mergeCreaseScreenSpace); all three finish through splitSelfTouching +
   simplifyCollinear. The builders at the end of the file hand the result
   back as pieces ({pts, closed} — silhouettePieces, contourPieces,
   creasePieces, which a texture stack runs on) or as path tokens
   (buildChainedPathD, appendContourPathD, appendCreasePathD).
   Pure geometry — no DOM, no app state, imports nothing. If a line ends
   up in the wrong place on the page, this file and the worker's
   worldOnFace/intersectSegs/subtractCovered are the two suspects.
   Byte-sensitive: tools/harness (svg.mjs) runs these functions against
   committed fingerprints, and a reordered loop or a changed tie-break
   moves lines in the exported SVG.
   This file's exports are deliberately wider than its current importers:
   it is the geometry surface the harness tools build on (svg.mjs re-exports
   most of it, contour-audit.mjs imports the tolerances under an explicit
   "never a second copy" rule). A tolerance or pass that no module imports
   TODAY still stays exported — the alternative is the next tool hard-coding
   0.3 somewhere, and a duplicated constant in here changes the output.
   ================================================================ */
/* ================= segment chaining =================
   Chains touching 2-point segments into maximal polylines. A segment's own
   endpoints already carry all the information needed — no extra data from
   the solver required. Open chains (a curve broken by real occlusion, or a
   boundary that's genuinely cut off) keep two distinct ends; closed chains
   (loop back to their own start) get flagged so the caller can emit an
   SVG "Z" instead of a duplicate closing point. */
export function chainSegments(segs){
  const key = (x,y) => Math.round(x*50) + '_' + Math.round(y*50);   // ~0.02px buckets
  const n = segs.length / 4;
  if (!n) return [];
  const P0 = i => [segs[i*4], segs[i*4+1]];
  const P1 = i => [segs[i*4+2], segs[i*4+3]];
  const TWO_PI = Math.PI * 2;
  // Each vertex's adjacency now also carries the outgoing angle of that
  // half-edge — needed to resolve junctions (3+ segment-ends sharing a
  // vertex) by a stable rule rather than by arrival order: take the next
  // half-edge in consistent rotational order from the reverse of the
  // direction just arrived on, rather than "first unused candidate" in
  // whatever order they happened to be pushed. (The worker resolves its own
  // junctions on a different signal — pairJunctionArms takes the straightest
  // continuation from world-space tangents, so its choice stays stable as the
  // camera orbits. This pass only ever sees screen coordinates, so rotational
  // order is the strongest signal available to it.) The naive first-match choice
  // at a junction can walk onto the wrong branch, stranding the actual
  // continuation to be discovered later as its own separate, disconnected
  // chain — confirmed directly against real output: two subpaths sharing
  // an EXACT shared vertex (zero distance) were still emitted as separate,
  // unconnected paths, which only a wrong turn at that vertex explains.
  const adj = new Map();
  const push = (k, rec) => { let a = adj.get(k); if (!a){ a=[]; adj.set(k,a); } a.push(rec); };
  for (let i=0; i<n; i++){
    const a=P0(i), b=P1(i);
    push(key(a[0],a[1]), { i, end:0, ang: Math.atan2(b[1]-a[1], b[0]-a[0]), toKey: key(b[0],b[1]) });
    push(key(b[0],b[1]), { i, end:1, ang: Math.atan2(a[1]-b[1], a[0]-b[0]), toKey: key(a[0],a[1]) });
  }
  const used = new Uint8Array(n);
  const findNext = (atKey, inAng) => {
    const arr = adj.get(atKey);
    if (!arr || !arr.length) return null;
    const rev = ((inAng + Math.PI) % TWO_PI + TWO_PI) % TWO_PI;
    let best=null, bestDiff=Infinity;
    for (const h of arr){
      if (used[h.i]) continue;
      const a = ((h.ang % TWO_PI) + TWO_PI) % TWO_PI;
      let diff = a - rev; if (diff <= 1e-9) diff += TWO_PI;
      if (diff < bestDiff){ bestDiff = diff; best = h; }
    }
    return best;
  };
  const chains = [];
  function walkFrom(segIdx, startEnd){
    used[segIdx] = 1;
    const a = P0(segIdx), b = P1(segIdx);
    const startPt = startEnd===0 ? a : b;
    const startKey = key(startPt[0], startPt[1]);
    const pts = [startPt, startEnd===0 ? b : a];
    let curAng = startEnd===0 ? Math.atan2(b[1]-a[1], b[0]-a[0]) : Math.atan2(a[1]-b[1], a[0]-b[0]);
    let curToKey = startEnd===0 ? key(b[0],b[1]) : key(a[0],a[1]);
    let closed = false;
    for (let guard=n+2; guard>0; guard--){
      if (curToKey === startKey && pts.length > 2){ closed = true; break; }
      const next = findNext(curToKey, curAng);
      if (!next) break;
      used[next.i] = 1;
      const nb = next.end===0 ? P1(next.i) : P0(next.i);
      pts.push(nb);
      curAng = next.ang; curToKey = next.toKey;
    }
    if (!closed && pts.length >= 3){
      // dead-ended a hair's width from start — see CHAIN_CLOSE_SNAP_TOL above
      const last = pts[pts.length-1], first = pts[0];
      const dx = last[0]-first[0], dy = last[1]-first[1];
      if (dx*dx+dy*dy <= CHAIN_CLOSE_SNAP_TOL*CHAIN_CLOSE_SNAP_TOL) closed = true;
    }
    if (closed) pts.pop();               // drop duplicate closing point — caller emits Z instead
    return { pts, closed };
  }
  // Pass 1: open chains start at a true endpoint (degree exactly 1) —
  // walking from there only ever needs to go one direction.
  for (const [k, list] of adj){
    if (list.length !== 1) continue;
    const { i, end } = list[0];
    if (!used[i]) chains.push(walkFrom(i, end));
  }
  // Pass 2: anything left has no degree-1 point at all, so it's a closed loop —
  // any unused segment is a valid place to start.
  for (let s=0; s<n; s++) if (!used[s]) chains.push(walkFrom(s, 0));
  return chains;
}

/* Collapses a chain's redundant interior points — mesh vertices that happen
   to fall on a perfectly (or near-perfectly) straight run, e.g. a subdivided
   facade edge or window-frame side, and so add nothing but visual noise
   (extra dots/joints) beyond the two real endpoints of that straight run.
   This is deliberately separate from dedupCollinear (worker-side): that one
   removes ink duplicated by a SEPARATE original edge; this one only ever
   drops a point when its own two neighbors already define the same line, so
   it can never change a curve's shape, only its point count.
   Tolerance is a fixed constant, not user-exposed (unlike the Dedup
   sliders) — tune SIMPLIFY_COLLINEAR_TOL directly if the default proves too
   tight/loose. Kept tiny and unscaled by zoom on purpose: this is meant to
   catch only genuine (near-)exact collinearity from mesh topology, not a
   perceptual "close enough" judgment the way the dedup tolerances are. */
export const SIMPLIFY_COLLINEAR_TOL = 0.05;   // px, perpendicular deviation allowed
// The pipeline's "not worth a separate pen mark" floor, in px — the same
// value as the worker's MIN_SEG (js/worker/dedup.js), which this thread can't
// import. Every main-thread tolerance defined as "MIN_SEG" derives from it.
export const MIN_SEG_PX = 0.3;
/* How far past its own neighbors a point may stick out and still count as
   redundant. The perpendicular test below asks whether b sits on the a→c
   LINE; on its own it says nothing about whether b sits BETWEEN a and c. For
   an ordinary straight run that distinction is empty — b always does — but a
   chain that doubles back on itself along a near-coincident line puts b far
   PAST c on that same line, and dropping it there doesn't remove a redundant
   midpoint, it erases the entire out-and-back excursion. That happens exactly
   where two parts of the mesh at different depths project onto the same
   screen line, i.e. constantly in axis-snapped orthographic views: measured
   on an X-aligned view of the pipe model, one such drop deleted a 55.5px
   stretch of Contour that the worker had emitted correctly (the two strands
   were 0.03px apart in y, well inside the perpendicular tolerance, while b
   sat 105px beyond c).
   Set to MIN_SEG rather than to SIMPLIFY_COLLINEAR_TOL so a fold-back too
   short to be a pen mark at all — fp noise between two independently-computed
   representations of the same point — still collapses exactly as it did
   before, and only excursions a plotter would actually draw are kept. */
export const SIMPLIFY_FOLDBACK_TOL = MIN_SEG_PX;
// A walk that dead-ends a hair's width from its own start point (confirmed
// against real output: gaps on the order of 1e-5 units after unit
// conversion — far below anything a plotter, or a person, could ever
// perceive) is floating-point noise from two independently-arrived-at
// representations of what's geometrically the same point, not a genuine
// open curve. Snap-close onto it rather than leaving a curve that's closed
// in every way that matters except its own SVG markup. Deliberately much
// smaller than any real feature this pipeline draws (MIN_SEG is 0.3px).
export const CHAIN_CLOSE_SNAP_TOL = 0.05;   // px
export function simplifyCollinear(pts, closed, tol=SIMPLIFY_COLLINEAR_TOL){
  const n = pts.length;
  if (n < 3) return pts;
  let work = pts;
  if (closed){
    // Rotate to start at the sharpest corner first, so the seam between
    // last and first point never lands in the middle of a straight run —
    // lets the same single open-chain sweep below handle closed loops with
    // no separate wraparound case to get subtly wrong.
    let bestI = 0, bestCross = -1;
    for (let i=0;i<n;i++){
      const a=pts[(i-1+n)%n], b=pts[i], c=pts[(i+1)%n];
      const cross = Math.abs((b[0]-a[0])*(c[1]-b[1]) - (b[1]-a[1])*(c[0]-b[0]));
      if (cross > bestCross){ bestCross = cross; bestI = i; }
    }
    work = pts.slice(bestI).concat(pts.slice(0, bestI));
  }
  const out = [work[0]];
  const last = closed ? n : n-1;      // closed: test every point incl. wrap; open: last point always kept
  for (let i=1; i<last; i++){
    const a = out[out.length-1], b = work[i], c = work[(i+1) % n];
    const acx=c[0]-a[0], acy=c[1]-a[1];
    const lenAC = Math.hypot(acx,acy);
    if (lenAC > 1e-9){
      const cross = (b[0]-a[0])*acy - (b[1]-a[1])*acx;
      const t = ((b[0]-a[0])*acx + (b[1]-a[1])*acy) / (lenAC*lenAC);
      const overshoot = t < 0 ? -t*lenAC : t > 1 ? (t-1)*lenAC : 0;
      // both tests together are "b is close to the a→c SEGMENT", not merely to
      // its infinite line — see SIMPLIFY_FOLDBACK_TOL
      if (Math.abs(cross)/lenAC <= tol && overshoot <= SIMPLIFY_FOLDBACK_TOL) continue;   // redundant, drop it
    }
    out.push(b);
  }
  if (!closed) out.push(work[n-1]);
  return out;
}

/* Shared by any flat [x0,y0,x1,y1,...] segment list that needs reconstructing
   into proper chained/closed SVG path data — the exact same chainSegments →
   splitSelfTouching → simplifyCollinear pipeline the real Silhouette/Scene-
   Outline layers use (chain:'silhouette' in layers.js). Used for the parallel
   topological-pipeline debug exports too, so their output can go through
   the person's own closed-vs-open coloring check the same way a real
   layer's export would. */
// Shared by every rendering branch below — one entry per actual pen stroke
// (subpath) in the FINAL, post-processing SVG, not per raw 2-point input
// segment. `pts` must never repeat the closing point for a closed path
// (matching the convention splitSelfTouching/mergeAdjacentTouching already
// use elsewhere in this file) — the closing segment's length is added
// separately here instead.
// stats.segments counts one per actual "L" pen-stroke drawn between two
// points (pts.length-1) — the SAME convention computeDStats uses when it
// counts L/C tokens in a frozen block's d-string (the implicit closing
// edge of a closed path, added via a trailing Z, contributes length but
// not its own segment — matching computeDStats there too). Deliberately
// NOT the raw pre-chain/pre-simplify segment count the worker originally
// emitted — that would count every tiny sub-segment the chaining/collinear-
// simplify passes below just finished merging away, which is exactly the
// mismatch a saved Layout block (built from the post-processing d-string)
// doesn't have.
export function accumulatePathStats(stats, pts, closed){
  stats.paths++;
  if (closed) stats.closedPaths++;
  stats.segments += pts.length - 1;
  let len = 0;
  for (let i=1;i<pts.length;i++) len += Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]);
  if (closed) len += Math.hypot(pts[0][0]-pts[pts.length-1][0], pts[0][1]-pts[pts.length-1][1]);
  stats.lenPx += len;
}

/* ================================================================
   mergeSilhouetteClose — post-chain cleanup for Silhouette (so/iv/ih).
   Deliberately permissive: no angle-continuity discrimination at all —
   every open chain, by nature, is expected to be part of a closed boundary,
   so any nearby tip (including a chain's own OTHER end, for self-closure)
   is a legitimate merge target. Two small steps:

   1. trimTipFoldback — a narrow, targeted fix for a specific artifact:
      occasionally a chain's very last segment folds back almost 180° over
      its own previous segment, with the true tip ending up projected back
      onto that prior segment (see the fold-back diagram this was built
      from). Contour has no equivalent pass: it chains by run identity
      carried from the worker (chainByRun) rather than by coordinate
      re-matching, and is deliberately excluded from dedupCollinear.
      Left alone, the spurious extra point sits between the chain's real
      endpoint and its neighbor, hiding what would otherwise be an exact
      (zero-gap) merge point. Trimmed before any merge search runs.

   2. mergeClose — proximity-merges every open chain tip within tolMerge
      of another (any other chain's tip, or its own opposite tip for
      self-closure), producing interpolated midpoints, then walks the
      resulting pairing graph (multi-hop runs and full closed loops alike)
      into final chains. so/iv/ih all get identical treatment — no
      exceptions, every gap within tolerance gets closed. Individual
      Silhouette only ever hides on same-shell self-occlusion (see the
      dropSelf test in the worker's 6.9), so it has no cross-shell cut
      endpoints that would need protecting from this merge.
   ================================================================ */
export function trimTipFoldback(chains, angleThreshDeg){
  const cosThresh = Math.cos(angleThreshDeg * Math.PI/180);
  function fix(pts, fromEnd){
    for (let guard=3; guard>0; guard--){
      if (pts.length < 3) break;
      const n = pts.length;
      const [cx,cy] = fromEnd ? pts[n-3] : pts[2];
      const [ax,ay] = fromEnd ? pts[n-2] : pts[1];
      const [bx,by] = fromEnd ? pts[n-1] : pts[0];
      const d1x=ax-cx, d1y=ay-cy, l1=Math.hypot(d1x,d1y)||1;
      const d2x=bx-ax, d2y=by-ay, l2=Math.hypot(d2x,d2y)||1;
      const cosAngle = (d1x/l1)*(d2x/l2) + (d1y/l1)*(d2y/l2);
      if (cosAngle > cosThresh) break;
      const t = ((bx-cx)*d1x+(by-cy)*d1y)/(l1*l1);
      if (t < 0 || t > 1) break;
      pts = fromEnd ? pts.slice(0, n-1) : pts.slice(1);
    }
    return pts;
  }
  return chains.map(c => {
    if (c.closed || c.pts.length < 3) return c;
    let pts = fix(c.pts, true);
    pts = fix(pts, false);
    return { pts, closed:false };
  });
}
export function mergeSilhouetteClose(chains, tolMerge){
  function mdist(a,b){ return Math.hypot(a[0]-b[0],a[1]-b[1]); }
  const open = [], closedOut = [];
  chains.forEach(c => { if (c.closed || c.pts.length < 2) closedOut.push(c); else open.push({ pts: c.pts.map(p=>p.slice()) }); });
  const N = open.length;
  const tips = [];
  for (let ci=0; ci<N; ci++){
    const p = open[ci].pts;
    tips.push({ pos:p[0] });
    tips.push({ pos:p[p.length-1] });
  }
  const cell = Math.max(tolMerge, 1e-6);
  const key = (x,y) => Math.floor(x/cell)+'_'+Math.floor(y/cell);
  const grid = new Map();
  tips.forEach((t,i) => { const k=key(t.pos[0],t.pos[1]); let a=grid.get(k); if(!a){a=[];grid.set(k,a);} a.push(i); });
  const paired = new Map();
  const used = new Set();
  const cand = [];
  for (let i=0;i<tips.length;i++){
    const cx=Math.floor(tips[i].pos[0]/cell), cy=Math.floor(tips[i].pos[1]/cell);
    for (let dx=-1;dx<=1;dx++) for (let dy=-1;dy<=1;dy++){
      const arr = grid.get((cx+dx)+'_'+(cy+dy)); if (!arr) continue;
      for (const j of arr){
        if (j<=i) continue;
        const d = mdist(tips[i].pos, tips[j].pos);
        if (d<=tolMerge) cand.push({i,j,d});
      }
    }
  }
  cand.sort((a,b)=>a.d-b.d);
  for (const c of cand){
    if (used.has(c.i) || used.has(c.j)) continue;
    used.add(c.i); used.add(c.j);
    paired.set(c.i, c.j); paired.set(c.j, c.i);
  }
  function ciOf(t){ return (t/2)|0; }
  function endOf(t){ return t%2; }
  function setTip(t, pt){
    const ci=ciOf(t), end=endOf(t);
    if (end===1) open[ci].pts[open[ci].pts.length-1] = pt.slice();
    else open[ci].pts[0] = pt.slice();
  }
  for (const [a,b] of paired){
    if (a>b) continue;
    const pa = tips[a].pos, pb = tips[b].pos;
    const mid = [(pa[0]+pb[0])/2, (pa[1]+pb[1])/2];
    setTip(a, mid); setTip(b, mid);
  }
  function orientedPts(ci, exitEnd){ const p = open[ci].pts; return exitEnd===1 ? p.slice() : p.slice().reverse(); }
  function tipKey(ci,end){ return ci*2+end; }
  const visited = new Uint8Array(N);
  const result = [];
  for (let ci=0; ci<N; ci++){
    if (visited[ci]) continue;
    const t0 = tipKey(ci,0), t1 = tipKey(ci,1);
    const p0 = paired.get(t0), p1 = paired.get(t1);
    if (p0 === t1 || p1 === t0){
      visited[ci] = 1;
      const pts = open[ci].pts.slice();
      pts.pop();
      result.push({ pts, closed:true });
      continue;
    }
    if (p0 != null && p1 != null) continue;
    visited[ci] = 1;
    const exitEnd = p0 != null ? 0 : 1;
    let pts = orientedPts(ci, exitEnd);
    let curTip = tipKey(ci, exitEnd);
    let closedLoop = false;
    for (let guard=N+2; guard>0; guard--){
      const partner = paired.get(curTip);
      if (partner == null) break;
      const nci = ciOf(partner), nend = endOf(partner);
      if (nci === ci){ closedLoop = true; break; }
      if (visited[nci]) break;
      visited[nci] = 1;
      const nextExitEnd = nend===1 ? 0 : 1;
      const nextPts = orientedPts(nci, nextExitEnd);
      pts = pts.concat(nextPts.slice(1));
      curTip = tipKey(nci, nextExitEnd);
    }
    if (closedLoop) pts.pop();
    result.push({ pts, closed: closedLoop });
  }
  for (let ci=0; ci<N; ci++){
    if (visited[ci]) continue;
    visited[ci] = 1;
    let pts = orientedPts(ci, 1);
    let curTip = tipKey(ci, 1);
    for (let guard=N+2; guard>0; guard--){
      const partner = paired.get(curTip);
      if (partner == null) break;
      const nci = ciOf(partner), nend = endOf(partner);
      if (visited[nci]) break;
      visited[nci] = 1;
      const nextExitEnd = nend===1 ? 0 : 1;
      const nextPts = orientedPts(nci, nextExitEnd);
      pts = pts.concat(nextPts.slice(1));
      curTip = tipKey(nci, nextExitEnd);
    }
    result.push({ pts, closed:true });
  }
  return result.concat(closedOut);
}

/* chainByRun — Contour (sv/sh) path assembly. Builds chains from the
   worker's own runId/seq identity (generate()'s Contour runs, solver.js 6.7) instead of
   chainSegments()'s global coordinate re-matching: segments sharing a
   runId are the SAME topological run the worker walked, in occlusion
   order; sorting by seq recovers it exactly, with no bucket/junction
   heuristics at all. A run can still arrive here with real gaps —
   subtractCovered punches holes when a higher-priority layer covers part
   of it — so consecutive same-run segments that don't actually share an
   endpoint (same ~0.02px tolerance chainSegments/splitSelfTouching use)
   start a fresh polyline rather than being stitched across the hole.
   Each returned chain carries the run.id its segments came from (multiple
   chains can share one runId, in seq order, when subtractCovered punched
   a hole) — mergeContourRunSplits below is the consumer. */
export function chainByRun(segs, runIds, seqs){
  const eq = (x1,y1,x2,y2) => Math.abs(x1-x2)<0.02 && Math.abs(y1-y2)<0.02;
  const n = segs.length/4;
  const byRun = new Map();
  for (let i=0;i<n;i++){
    const rid = runIds[i];
    let list = byRun.get(rid);
    if (!list){ list=[]; byRun.set(rid, list); }
    list.push(i);
  }
  const polys = [];
  for (const [rid, list] of byRun){
    list.sort((a,b) => seqs[a]-seqs[b]);
    let cur = null;
    for (const i of list){
      const x0=segs[i*4],y0=segs[i*4+1],x1=segs[i*4+2],y1=segs[i*4+3];
      if (cur && eq(cur[cur.length-1][0], cur[cur.length-1][1], x0,y0)) cur.push([x1,y1]);
      else { if (cur) polys.push({ pts: cur, runId: rid }); cur = [[x0,y0],[x1,y1]]; }
    }
    if (cur) polys.push({ pts: cur, runId: rid });
  }
  return polys.map(({ pts, runId }) => {
    const closed = pts.length>2 && eq(pts[0][0],pts[0][1], pts[pts.length-1][0],pts[pts.length-1][1]);
    return { pts: closed ? pts.slice(0,-1) : pts, closed, runId };
  });
}

/* mergeContourRunSplits — Contour run-identity merge, built on top of
   chainByRun's own runId-tagged chains. Two DIFFERENT run.ids can
   legitimately need joining into one visual stroke, and neither case is
   safe for chainByRun's own local touch-check to catch (that only ever
   looks within one runId's own segment list):

   (a) "sandwich" — a run that's (almost) entirely triangulation-diagonal
       artifact ends up with ALL its own material dropped by the worker's
       Contour cleanup (solver.js 6.5/6.8), so it never reaches here at all
       — but it used to sit, in the worker's own chain-walk order, between
       two OTHER runs that are now left with nothing between them. The
       worker posts every run's prevId/nextId (solver.js 6.7,
       counts.contourAdjacency) precisely so this can be recognized
       here: an id present in that adjacency table but absent from this
       layer's own chains is exactly such a vanished run, and its
       prevId/nextId (walked past any number of ALSO-vanished neighbors,
       in case several artifact runs sit back to back) name the two chains
       that should be bridged, in a known, non-ambiguous direction.
       Bridged ONLY from both runs' genuine endpoints (tipP0/tipP1, also
       posted by the worker before the cross-layer cascade runs). With a
       Silhouette layer enabled, subtractCovered can trim a Contour run's
       own head or tail away entirely, leaving this pass anchored to an
       arbitrary interior cut — see the check in the loop below for why
       that must not be bridged.
   (b) near-coincident endpoints — two runs whose emitted tips land within
       MIN_SEG_PX of each other regardless of adjacency, most likely two
       different chains sharing one mesh vertex (pairJunctionArms only
       pairs one straightest continuation per junction), or two
       independently-computed copies of what's really the same point.
       Averaged to a shared midpoint (mergeSilhouetteClose's own convention
       for exactly this) rather than bridged — MIN_SEG_PX is small enough that the averaging can never
       visibly displace real geometry, so this never needs to distinguish
       WHY the two tips are close, only that they are.

   Both resolve to an explicit (chain, tip) pairing, then get walked
   exactly like mergeSilhouetteClose's own tip graph (open runs only;
   closed loops need no merge, they already have no open tip) — reused
   here rather than reinvented, just driven by these specific pairs
   instead of a distance search. When several runs merge, the merged
   result is labeled with the LOWEST contributing run.id (bookkeeping
   only — the exported path is pure geometry and carries no id). */
export function mergeContourRunSplits(chains, adjacency){
  if (!adjacency || !adjacency.length) return chains;
  const EPS = 1e-4;   // exact-computation match, not a proximity tolerance — see dedup.js's EXACT_DUP_EPS
  const eq = (a,b) => Math.abs(a[0]-b[0])<EPS && Math.abs(a[1]-b[1])<EPS;

  const open = [], closedOut = [];
  chains.forEach(c => { if (c.closed || c.pts.length<2) closedOut.push(c); else open.push(c); });
  const N = open.length;
  if (N < 2) return chains;

  // first/last chain-piece index for each runId — chainByRun already
  // emits multiple pieces of one runId in seq order, so "first"/"last"
  // here are that run's own head/tail ends.
  const firstOfRun = new Map(), lastOfRun = new Map();
  open.forEach((c,i) => {
    if (!firstOfRun.has(c.runId)) firstOfRun.set(c.runId, i);
    lastOfRun.set(c.runId, i);
  });

  const tipKey = (ci,end) => ci*2+end;   // end: 0=start, 1=end
  const paired = new Map();
  const link = (ta, tb) => { paired.set(ta,tb); paired.set(tb,ta); };

  // (a) sandwich pairs — walk past any run of consecutively-vanished
  // neighbors to find the nearest run on each side that actually HAS
  // content, then bridge those two, in the known prevId→nextId direction.
  // Deliberately keyed on the worker's own hasContent flag, NOT on whether
  // a run's segments actually made it into `chains` — those are two
  // different questions. A run can have real, worker-computed content and
  // still be entirely absent from `chains` simply because its own layer
  // checkbox (Contour hidden, say) is off; that says nothing about
  // whether real occlusion put a genuine gap there, and bridging across it
  // would replace a deliberate hidden-line break with a false straight
  // line. Only a run the worker's cleanup itself left with nothing
  // (artifact, genuinely eliminated) is eligible to be walked past/bridged
  // over.
  const adjById = new Map(adjacency.map(a => [a.id, a]));
  const hasContentIds = new Set(adjacency.filter(a => a.hasContent).map(a => a.id));
  const nearestSurviving = (startId, dir) => {
    let cur = startId, guard = adjacency.length + 2;
    while (guard-- > 0){
      if (cur == null || cur < 0) return null;
      if (hasContentIds.has(cur)) return cur;
      const a = adjById.get(cur);
      if (!a) return null;
      cur = a[dir];
    }
    return null;
  };
  for (const a of adjacency){
    if (a.hasContent) continue;   // only start from a run the cleanup left with nothing at all
    const prevSurv = nearestSurviving(a.prevId, 'prevId');
    const nextSurv = nearestSurviving(a.nextId, 'nextId');
    if (prevSurv == null || nextSurv == null || prevSurv === nextSurv) continue;
    const ai = lastOfRun.get(prevSurv), bi = firstOfRun.get(nextSurv);
    if (ai == null || bi == null) continue;   // has content, but isn't drawn in THIS layer (own checkbox off) — nothing to bridge to
    // Only bridge from the two runs' GENUINE ends. When a higher-priority
    // layer is enabled, subtractCovered (worker, cross-layer cascade) trims
    // and deletes sv/sh segments — so one runId can arrive here as several
    // chains, and a run's own head or tail segments may be gone entirely.
    // lastOfRun/firstOfRun then point at a piece whose end/start is an
    // arbitrary interior cut rather than the run's real tip, and bridging
    // those draws a long straight line between two points that were never
    // adjacent. That is exactly the case that must NOT be bridged: a cut end
    // means higher-priority ink occupies the gap, so the gap is correct.
    // The worker posts each run's true tips (tipP0/tipP1) before the cascade
    // can touch them; compare exactly (EPS above), since nothing has moved
    // these coordinates yet — simplifyCollinear/splitSelfTouching run later.
    const prevAdj = adjById.get(prevSurv), nextAdj = adjById.get(nextSurv);
    if (!prevAdj || !prevAdj.tipP1 || !nextAdj || !nextAdj.tipP0) continue;
    const aPts = open[ai].pts, bPts = open[bi].pts;
    if (!eq(aPts[aPts.length-1], prevAdj.tipP1)) continue;   // prev run cut short at its tail
    if (!eq(bPts[0], nextAdj.tipP0)) continue;               // next run cut short at its head
    const ta = tipKey(ai,1), tb = tipKey(bi,0);
    if (!paired.has(ta) && !paired.has(tb)) link(ta, tb);
  }

  // (b) near-coincident tip pairs within MIN_SEG_PX, across DIFFERENT run.ids
  // only (same-run splits are already stitched by chainByRun's own touch
  // check). Unlike (a)'s deliberate bridge across real removed material,
  // a pair found here is treated as the SAME real point, just resolved to
  // slightly different coordinates by two independently-computed runs —
  // averaged to a shared midpoint (same convention mergeSilhouetteClose
  // already uses for its own proximity merges) so the walk below sees a
  // genuine touch, not a bridge. Candidates are collected and consumed
  // nearest-first (also mirroring mergeSilhouetteClose) so an ambiguous
  // 3-way near-coincidence resolves to its closest pairing rather than
  // whichever one happened to be tested first. MIN_SEG_PX is small enough
  // that averaging two points within it can never visibly displace real
  // geometry, regardless of whether the gap turns out to be occlusion noise,
  // a crossing-split trim, or a shared/near-shared mesh vertex.
  const tipPos = (ci,end) => end===1 ? open[ci].pts[open[ci].pts.length-1] : open[ci].pts[0];
  const setTip = (ci,end,pt) => { if (end===1) open[ci].pts[open[ci].pts.length-1] = pt.slice(); else open[ci].pts[0] = pt.slice(); };
  const proxCand = [];
  for (let i=0;i<N;i++){
    for (let ei=0; ei<2; ei++){
      const ta = tipKey(i,ei);
      if (paired.has(ta)) continue;
      const pa = tipPos(i,ei);
      for (let j=i+1;j<N;j++){
        if (open[i].runId === open[j].runId) continue;
        for (let ej=0; ej<2; ej++){
          const tb = tipKey(j,ej);
          if (paired.has(tb)) continue;
          const pb = tipPos(j,ej);
          const d = Math.hypot(pa[0]-pb[0], pa[1]-pb[1]);
          if (d < MIN_SEG_PX) proxCand.push({ ta, tb, d, ci:i, ei, cj:j, ej });
        }
      }
    }
  }
  proxCand.sort((x,y) => x.d - y.d);
  for (const c of proxCand){
    if (paired.has(c.ta) || paired.has(c.tb)) continue;
    const pa = tipPos(c.ci,c.ei), pb = tipPos(c.cj,c.ej);
    const mid = [(pa[0]+pb[0])/2, (pa[1]+pb[1])/2];
    setTip(c.ci,c.ei,mid); setTip(c.cj,c.ej,mid);
    link(c.ta, c.tb);
  }

  // Walk the pairing graph — same structure as mergeSilhouetteClose's own
  // walk (open-chain pass, then closed-loop-only fallback).
  function orientedPts(ci, exitEnd){ const p = open[ci].pts; return exitEnd===1 ? p.slice() : p.slice().reverse(); }
  const visited = new Uint8Array(N);
  // Joins chain ci (leaving through its exitEnd tip) with every unvisited
  // chain reachable along the pairing graph. Returns the joined points and
  // the lowest contributing run.id.
  const walkFrom = (ci, exitEnd) => {
    let pts = orientedPts(ci, exitEnd);
    let minRunId = open[ci].runId;
    let curTip = tipKey(ci, exitEnd);
    for (let guard=N+2; guard>0; guard--){
      const partner = paired.get(curTip);
      if (partner == null) break;
      const nci = (partner/2)|0, nend = partner%2;
      if (visited[nci]) break;
      visited[nci] = 1;
      if (open[nci].runId < minRunId) minRunId = open[nci].runId;
      const nextExitEnd = nend===1 ? 0 : 1;
      const nextPts = orientedPts(nci, nextExitEnd);
      // A (b) pair's tips were overwritten to one shared midpoint above, so
      // the neighbor's leading point is a duplicate and is dropped. An (a)
      // sandwich pair is a genuine BRIDGE across a real gap — its two
      // endpoints are deliberately different points, so the neighbor's
      // leading point is kept and the bridge segment itself gets emitted.
      const bridging = !eq(pts[pts.length-1], nextPts[0]);
      pts = pts.concat(bridging ? nextPts : nextPts.slice(1));
      curTip = tipKey(nci, nextExitEnd);
    }
    return { pts, minRunId };
  };
  const result = [];
  for (let ci=0; ci<N; ci++){
    if (visited[ci]) continue;
    const t0 = tipKey(ci,0), t1 = tipKey(ci,1);
    const p0 = paired.get(t0), p1 = paired.get(t1);
    if (p0 === t1 || p1 === t0){
      visited[ci] = 1;
      const pts = open[ci].pts.slice(); pts.pop();
      result.push({ pts, closed:true, runId: open[ci].runId });
      continue;
    }
    if (p0 != null && p1 != null) continue;   // interior of a longer run — reached from its own true end below
    visited[ci] = 1;
    const { pts, minRunId } = walkFrom(ci, p0 != null ? 0 : 1);
    result.push({ pts, closed:false, runId: minRunId });
  }
  for (let ci=0; ci<N; ci++){   // whatever's left must be pure cycles
    if (visited[ci]) continue;
    visited[ci] = 1;
    const { pts, minRunId } = walkFrom(ci, 1);
    result.push({ pts, closed:true, runId: minRunId });
  }
  return result.concat(closedOut);
}

/* Appends one polyline to the `d` token array as an SVG subpath (M/L, plus Z
   when closed — `pts` never repeats the first point), and counts it into
   `stats` when given. Every chained line layer's path is built through this. */
export function appendPolylineD(d, pts, closed, stats){
  if (stats) accumulatePathStats(stats, pts, closed);
  d.push('M', pts[0][0].toFixed(2), pts[0][1].toFixed(2));
  for (let i=1;i<pts.length;i++) d.push('L', pts[i][0].toFixed(2), pts[i][1].toFixed(2));
  if (closed) d.push('Z');
}

/* Each edge layer has a piece builder (silhouettePieces, contourPieces,
   creasePieces) returning its finished polylines as [{pts, closed}], and a
   path builder wrapping it that turns those into path tokens. render-result.js
   takes the pieces when the layer has a texture stack to run on them. */
function appendPiecesD(d, pieces, stats){
  for (const { pts, closed } of pieces) appendPolylineD(d, pts, closed, stats);
}

/* Silhouette / Silhouette individual (so/iv/ih) layer → pieces: global
   coordinate chaining, then Silhouette's own tip cleanup (trimTipFoldback +
   mergeSilhouetteClose, see silMergeOpts), then the shared
   split-self-touching / collinear-simplify tail. */
export function silhouettePieces(segs, silMergeOpts){
  const pieces = [];
  let chains = chainSegments(segs);
  chains = trimTipFoldback(chains, silMergeOpts.foldbackAngleThreshDeg);
  chains = mergeSilhouetteClose(chains, silMergeOpts.tolMerge);
  for (const chain of chains)
    for (const { pts: rawPts, closed } of splitSelfTouching(chain.pts, chain.closed))
      pieces.push({ pts: simplifyCollinear(rawPts, closed), closed });
  return pieces;
}
// → a path data string
export function buildChainedPathD(segs, stats, silMergeOpts){
  const d = [];
  appendPiecesD(d, silhouettePieces(segs, silMergeOpts), stats);
  return d.join(' ');
}

/* Crease/hidden-crease arrive here already topologically pre-ordered by the
   worker (see the crease-chain design spec): genuinely continuous runs are
   pushed as array-adjacent segments with matching endpoints, using
   straightness-based pairing at junctions rather than screen coincidence.
   Unlike chainSegments() above — a GLOBAL coordinate search, safe for
   so/iv/ih since those are always simple non-branching curves by
   construction — crease networks have real junctions, so a global search
   here could silently undo the worker's pairing by reconnecting to
   whichever OTHER candidate happens to sit at the same point first. This
   merge is deliberately LOCAL: it only ever looks at the immediately
   preceding array entry, so it can never produce a wrong connection —
   only miss a merge it could have made, leaving it to
   mergeCreaseScreenSpace below. That makes it only as good as the order
   the worker posts: subtractCovered keeps its input's order, and the
   worker's intra-layer dedupCollinear is called with keepOrder for cv/ch
   for exactly this reason — without it, its angle-bucket regrouping left
   only 6–17% of chain neighbours array-adjacent on the demo mesh. What
   still arrives out of order (a stretch a dedup merge moved to another
   chain's position, 6.8's restored crease appended after the 6.2 chains)
   falls through to the screen-space pass. */
export function mergeAdjacentTouching(segs){
  const n = segs.length/4;
  const eq = (x1,y1,x2,y2) => Math.abs(x1-x2)<0.02 && Math.abs(y1-y2)<0.02;
  const polys = [];
  let cur = null;
  for (let i=0;i<n;i++){
    const x0=segs[i*4],y0=segs[i*4+1],x1=segs[i*4+2],y1=segs[i*4+3];
    if (cur && eq(cur[cur.length-1][0], cur[cur.length-1][1], x0,y0)) cur.push([x1,y1]);
    else { if (cur) polys.push(cur); cur = [[x0,y0],[x1,y1]]; }
  }
  if (cur) polys.push(cur);
  return polys.map(pts => {
    const closed = pts.length>2 &&
      Math.abs(pts[0][0]-pts[pts.length-1][0])<0.02 && Math.abs(pts[0][1]-pts[pts.length-1][1])<0.02;
    return { pts: closed ? pts.slice(0,-1) : pts, closed };
  });
}

/* SECOND, fallback pass for crease/hidden-crease — screen-space, deliberately
   more permissive than mergeAdjacentTouching() above.

   Why this is needed: the worker's crease topology pass (generate() 6.1)
   pairs at most ONE continuation per junction. pairJunctionArms maximises
   the NUMBER of pairs, but it deliberately refuses to pair a near-total
   fold-back, and an odd-valence junction always leaves at least one arm
   over regardless. So wherever three or more crease edges meet, the walk
   emits several SEPARATE chains that genuinely terminate at the same welded
   mesh vertex — and therefore at the same screen point.
   A right-angle box corner or window-frame rectangle is exactly this case:
   every corner is a 3-way junction, so the four sides arrive here as
   disconnected chains, and mergeAdjacentTouching's array-adjacency check
   can't place them next to each other because nothing ordered them that way.
   (Contour hits the identical phenomenon — see mergeContourRunSplits case
   (b) — but resolves it differently, since Contour carries run identity and
   Crease does not.)

   This pass repairs that by matching leftover polyline ENDPOINTS by screen
   coordinate — never interior points, so it can never splice into the
   middle of an already-correct chain, only extend from its two loose ends:
     - exactly 2 loose ends meet at one screen point → always joined.
     - 3+ loose ends at one point (a junction the topology pass never saw,
       since it never saw this edge at all) → no straightness scoring here,
       just take the first two in array order, join them, then re-examine
       the SAME point for any remaining ends — repeat until at most one is
       left there, same "arbitrary order, then move on" rule as any other
       junction pairing in this file.
   If a chain's two loose ends eventually meet at the same point (a merged
   window frame closing back on itself), it's emitted as a genuinely closed
   loop — coincident first/last point collapsed, `closed:true` — exactly
   like Silhouette/Scene-outline's chainSegments() above, rather than left
   as a duplicated coincident point.

   Trade-off, by design: this trusts screen-space coincidence for whatever
   mergeAdjacentTouching left as a loose end, so in principle two unrelated
   dangling ends that merely happen to project to the same pixel could be
   joined. In practice this only ever touches genuine chain termini (never
   interior points), and it only runs on ends the topology pass left unpaired
   and mergeAdjacentTouching couldn't join — the same trade-off the user asked
   for to fix box/building facades, where every corner is an exact on-screen
   coincidence anyway. */
export function mergeCreaseScreenSpace(polys){
  const key = (x,y) => Math.round(x*50) + '_' + Math.round(y*50);   // ~0.02px buckets, same as above

  const result = [];
  const allPolys = [];
  const buckets = new Map();     // screen point key → [{poly, end(0=start,1=end)}, ...]

  const addEnd = (poly, end) => {
    const pt = end===0 ? poly.pts[0] : poly.pts[poly.pts.length-1];
    const k = key(pt[0], pt[1]);
    let list = buckets.get(k);
    if (!list){ list=[]; buckets.set(k,list); }
    list.push({ poly, end });
    return k;
  };

  for (const p of polys){
    if (p.closed){ result.push(p); continue; }     // already a complete stroke — leave untouched
    const poly = { pts: p.pts, alive:true };
    allPolys.push(poly);
    addEnd(poly, 0);
    addEnd(poly, 1);
  }

  const queue = [...buckets.keys()];
  const queued = new Set(queue);
  const enqueue = k => { if (!queued.has(k)){ queued.add(k); queue.push(k); } };

  while (queue.length){
    const k = queue.shift();
    queued.delete(k);
    for (;;){
      const raw = buckets.get(k);
      if (!raw) break;
      const live = raw.filter(e => e.poly.alive);
      if (live.length < 2){ buckets.set(k, live); break; }

      const [A, B] = live;                 // "arbitrary order (index value)": first two, array order
      buckets.set(k, live.slice(2));

      if (A.poly === B.poly){              // both loose ends of ONE chain meet here → it closes
        A.poly.alive = false;
        result.push({ pts: A.poly.pts.slice(0, -1), closed:true });
        continue;                          // keep resolving any further ends still at this point
      }

      let ptsA = A.poly.pts, ptsB = B.poly.pts;
      if (A.end === 0) ptsA = ptsA.slice().reverse();   // orient so ptsA ENDS at the junction
      if (B.end === 1) ptsB = ptsB.slice().reverse();   // orient so ptsB STARTS at the junction
      const merged = { pts: ptsA.concat(ptsB.slice(1)), alive:true };   // drop duplicate junction point
      A.poly.alive = false; B.poly.alive = false;
      allPolys.push(merged);
      const k0 = addEnd(merged, 0), k1 = addEnd(merged, 1);
      if (k0 !== k) enqueue(k0);
      if (k1 !== k) enqueue(k1);
      // fall through and loop again: more loose ends may remain at this junction
    }
  }

  for (const poly of allPolys) if (poly.alive) result.push({ pts: poly.pts, closed:false });
  return result;
}

/* Final safety net, applied to every chained/merged polyline right before
   SVG serialization — Silhouette, Scene-outline, Crease, hidden-crease
   alike. Guarantees no emitted subpath ever revisits the SAME on-screen
   point at an INTERIOR position (as opposed to the expected start≈end
   coincidence of a genuinely closed loop, which this leaves alone).

   Why this exists: a subpath that touches itself mid-stroke — draws out to
   a point, keeps going, and later passes back through that exact point
   again before terminating — is valid SVG, and line-segment renderers (a
   pen plotter, Affinity's own renderer) draw it correctly since they just
   draw each segment independently. But curve-importing tools build ONE
   continuous spline object per subpath, and can't represent "pass through
   this vertex twice" — Blender's SVG importer in particular will silently
   drop or mis-merge the revisited vertex while building that spline,
   quietly losing a vertex/kink with no warning at all. This can happen
   whenever a merge pass has to choose a pairing at a 3+-way junction with
   no stronger signal than array order (see mergeCreaseScreenSpace's own
   comment) — occasionally it stitches a small closed loop together with a
   passing-through tail instead of letting the loop close on its own.

   Since revisiting a point mid-path means that point is a REAL junction
   (three or more strokes genuinely meet there), the safe fix is the same
   one used everywhere else in this file for junctions: split there. The
   part of the path that returns to the touch point becomes its own closed
   loop; whatever remains before/after stays as the (now simple) rest of
   the chain. Same ink, restructured into pieces no import tool can choke
   on. Nested self-touches (a loop that itself touches a point twice) are
   peeled off one at a time, so this holds for any number of them. */
export function splitSelfTouching(pts, closed){
  const key = (p) => Math.round(p[0]*50) + '_' + Math.round(p[1]*50);   // ~0.02px buckets, same as above
  const seen = new Map();          // point key → index within `out`
  const out = [];
  const loops = [];
  for (const p of pts){
    const k = key(p);
    if (seen.has(k)){
      const i = seen.get(k);
      loops.push(out.slice(i));                  // out[i]..out[end] is a simple closed loop
      for (let j=i+1;j<out.length;j++) seen.delete(key(out[j]));
      out.length = i+1;                           // keep the shared anchor point, drop the rest
    } else {
      seen.set(k, out.length);
      out.push(p);
    }
  }
  const pieces = [];
  if (out.length>=2) pieces.push({ pts: out, closed });
  for (const l of loops) if (l.length>=2) pieces.push({ pts: l, closed:true });
  return pieces;
}

/* Contour micro-geometry cleanup — the last two steps of appendContourPathD,
   run on finished pieces ({pts, closed}, after splitSelfTouching and
   simplifyCollinear).

   Where they come from: in an axis-aligned view many mesh edges run almost
   along the view direction (in the X-aligned pipe scene, 342 edges project
   to under 0.2px). At a tube end the silhouette genuinely travels along such
   an edge and back, so the worker's Contour carries a ~0.17px out-and-back
   stub at the junction where several runs meet. Chaining then turns each
   stub into one of: a whole run that is just the stub (emitted as a
   2-point closed "loop" the pen draws out and back), a single sub-MIN_SEG
   segment standing alone, a stub glued to the start or end of a real stroke
   (a near-180° fold), or — once two runs tracing the same stub are merged —
   a micro-loop that splitSelfTouching cuts out as its own closed piece.

   Both steps are bounded so they only ever remove ink that is still on the
   page, measured over 28 views of the pipe and demo scenes (0 gap cells).
   The unbounded versions of each were measured to delete real ink. */
export const CONTOUR_MICRO_TOL = MIN_SEG_PX;

/* Trims a path-end vertex that folds straight back (turn > 150°) onto the
   segment before it. Unlike trimTipFoldback (Silhouette's version), the tip
   must also lie within CONTOUR_MICRO_TOL of that segment's LINE, not just
   inside its span: without the distance check a genuine short edge meeting a
   long one at a shallow angle reads as a fold too, and gets cut (measured —
   a real 7px edge at 9° on the pipe, 107 cells of real ink on the demo mesh).
   Runs after simplifyCollinear on purpose: before it, the previous segment
   is usually a micro-segment shorter than the stub folding back over it, so
   the tip doesn't land inside its span and nothing is caught. */
export function trimContourFoldbacks(pieces){
  const cosThresh = Math.cos(150 * Math.PI/180);
  return pieces.map(piece => {
    if (piece.closed || piece.pts.length < 3) return piece;
    let pts = piece.pts;
    const fix = fromEnd => {
      for (let guard=3; guard>0 && pts.length>=3; guard--){
        const n = pts.length;
        const [cx,cy] = fromEnd ? pts[n-3] : pts[2];
        const [ax,ay] = fromEnd ? pts[n-2] : pts[1];
        const [bx,by] = fromEnd ? pts[n-1] : pts[0];
        const d1x=ax-cx, d1y=ay-cy, l1=Math.hypot(d1x,d1y);
        const d2x=bx-ax, d2y=by-ay, l2=Math.hypot(d2x,d2y);
        if (l1 < 1e-9 || l2 < 1e-9) break;
        if ((d1x*d2x + d1y*d2y)/(l1*l2) > cosThresh) break;                        // not a fold-back
        const t = ((bx-cx)*d1x + (by-cy)*d1y)/(l1*l1);
        if (t < 0 || t > 1) break;                                                   // doesn't land on the segment
        if (Math.abs((bx-cx)*d1y - (by-cy)*d1x)/l1 > CONTOUR_MICRO_TOL) break;       // doesn't retrace it
        pts = fromEnd ? pts.slice(0, n-1) : pts.slice(1);
      }
    };
    fix(true); fix(false);
    return { pts, closed:false };
  });
}

/* Drops pieces smaller than CONTOUR_MICRO_TOL across — but only when the
   rest of the layer already puts ink within CONTOUR_MICRO_TOL of every point
   of them, so nothing leaves the page. A micro-piece that is the only ink at
   its spot is kept: along hidden-contour curves some of them are exactly
   that, and dropping every tiny piece unconditionally was measured to punch
   holes there. Checked against the non-tiny pieces only, so two slivers can
   never vouch for each other and both disappear. */
export function dropRedundantContourSlivers(pieces){
  const extentOf = pts => {
    let x0=Infinity, y0=Infinity, x1=-Infinity, y1=-Infinity;
    for (const [x,y] of pts){ if (x<x0) x0=x; if (x>x1) x1=x; if (y<y0) y0=y; if (y>y1) y1=y; }
    return Math.hypot(x1-x0, y1-y0);
  };
  const tiny = pieces.map(p => extentOf(p.pts) < CONTOUR_MICRO_TOL);
  if (!tiny.some(Boolean)) return pieces;
  const G = 2, grid = new Map(), segs = [];
  pieces.forEach((p, pi) => {
    if (tiny[pi]) return;
    const q = p.closed ? [...p.pts, p.pts[0]] : p.pts;
    for (let i=0;i+1<q.length;i++){
      const s = segs.length;
      segs.push(q[i][0], q[i][1], q[i+1][0], q[i+1][1]);
      const xa=Math.min(q[i][0],q[i+1][0]), xb=Math.max(q[i][0],q[i+1][0]);
      const ya=Math.min(q[i][1],q[i+1][1]), yb=Math.max(q[i][1],q[i+1][1]);
      for (let gx=Math.floor(xa/G)-1; gx<=Math.floor(xb/G)+1; gx++)
        for (let gy=Math.floor(ya/G)-1; gy<=Math.floor(yb/G)+1; gy++){
          const k = gx + ',' + gy;
          let list = grid.get(k);
          if (!list){ list = []; grid.set(k, list); }
          list.push(s);
        }
    }
  });
  const covered = (x, y) => {
    const list = grid.get(Math.floor(x/G) + ',' + Math.floor(y/G));
    if (!list) return false;
    for (const s of list){
      const dx=segs[s+2]-segs[s], dy=segs[s+3]-segs[s+1], L2=dx*dx+dy*dy;
      let t = L2 > 1e-12 ? ((x-segs[s])*dx + (y-segs[s+1])*dy)/L2 : 0;
      t = Math.max(0, Math.min(1, t));
      if (Math.hypot(x-(segs[s]+t*dx), y-(segs[s+1]+t*dy)) <= CONTOUR_MICRO_TOL) return true;
    }
    return false;
  };
  return pieces.filter((p, pi) => {
    if (!tiny[pi]) return true;
    const q = p.closed ? [...p.pts, p.pts[0]] : p.pts;
    for (let i=0;i<q.length;i++){
      if (!covered(q[i][0], q[i][1])) return true;
      if (i+1 < q.length && !covered((q[i][0]+q[i+1][0])/2, (q[i][1]+q[i+1][1])/2)) return true;
    }
    return false;
  });
}

/* Contour (sv/sh) layer → pieces. Built straight from
   the worker's own runId/seq chain identity (chainByRun), never from
   coordinate re-matching. mergeContourRunSplits then re-joins any run that's
   permanently split across a vanished-artifact run or a shared-vertex
   coincidence — `adjacency` is the FULL table (both sv and sh), since a
   vanished run's prevId/nextId can name runs of either state; entries that
   aren't relevant to this layer are no-ops. Then the shared
   split-self-touching / collinear-simplify tail, plus Contour's own
   micro-geometry cleanup (trimContourFoldbacks, dropRedundantContourSlivers). */
export function contourPieces(segs, runIds, seqs, adjacency){
  const contourChains = mergeContourRunSplits(chainByRun(segs, runIds, seqs), adjacency);
  const pieces = [];
  for (const chain of contourChains)
    for (const { pts: rawPts, closed } of splitSelfTouching(chain.pts, chain.closed))
      pieces.push({ pts: simplifyCollinear(rawPts, closed), closed });
  return dropRedundantContourSlivers(trimContourFoldbacks(pieces));
}
// → path tokens appended to `d`
export function appendContourPathD(d, segs, runIds, seqs, adjacency, stats){
  appendPiecesD(d, contourPieces(segs, runIds, seqs, adjacency), stats);
}

/* Crease (cv/ch) layer → pieces:
   1) mergeAdjacentTouching — local, topology-trusting merge of array-adjacent
      touching pieces
   2) mergeCreaseScreenSpace — screen-space fallback that mops up whatever (1)
      couldn't place, e.g. the extra arms pairJunctionArms left unpaired at a
      3+-way junction (see its own comment for why)
   3) splitSelfTouching safety net — see its own comment for the
      Blender-import bug this specifically guards
   then collinear simplify. */
export function creasePieces(segs){
  const pieces = [];
  for (const chain of mergeCreaseScreenSpace(mergeAdjacentTouching(segs)))
    for (const { pts: rawPts, closed } of splitSelfTouching(chain.pts, chain.closed))
      pieces.push({ pts: simplifyCollinear(rawPts, closed), closed });
  return pieces;
}
// → path tokens appended to `d`
export function appendCreasePathD(d, segs, stats){
  appendPiecesD(d, creasePieces(segs), stats);
}
