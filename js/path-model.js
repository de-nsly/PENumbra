/* ================================================================
   path-model.js — the segment path model
   The shared representation both export-time geometry passes (dash
   splitting, splitDashedPathD, and the margin trim, trimCloneToMargins
   via clipPathDToMargins and the little affine-matrix helpers) work
   on, plus computeDStats, which measures a finished d-string for the
   stats readout.
   Parses this app's own d-string format (space-separated M/L/C/Z
   tokens — see the path building in render-result.js) into subpaths of
   typed SEGMENTS rather than a flat vertex list. The distinction
   matters entirely because of the Circles layer: its arcs are
   emitted as genuine cubic Beziers (see arcToBezierSegments in
   hatch-texture.js), and both passes here have to cut them without
   ever degrading them into polylines. Every operation is therefore
   expressed as "restrict a segment to a sub-range of its own
   parameter t", which for a cubic is a de Casteljau split — exact,
   shape-preserving, still a cubic — and for a line is plain
   interpolation.
   A closed subpath keeps `closed:true` and does NOT carry an
   explicit closing segment; callers that need to walk the closing
   edge materialize it via segsWithClose().
   Pure geometry apart from the DOM walk trimCloneToMargins does over
   an export clone; imports nothing.
   ================================================================ */
export function parsePathD(d){
  const tokens = (d || '').trim().split(/\s+/);
  const subpaths = [];
  let cur = null;
  const num = i => parseFloat(tokens[i]);
  for (let i = 0; i < tokens.length; ){
    const t = tokens[i];
    if (t === 'M'){
      cur = { start: [num(i+1), num(i+2)], segs: [], closed: false };
      subpaths.push(cur);
      i += 3;
    } else if (t === 'L'){
      if (cur) cur.segs.push({ t: 'L', p: [num(i+1), num(i+2)] });
      i += 3;
    } else if (t === 'C'){
      if (cur) cur.segs.push({ t: 'C', c1: [num(i+1), num(i+2)], c2: [num(i+3), num(i+4)], p: [num(i+5), num(i+6)] });
      i += 7;
    } else if (t === 'Z' || t === 'z'){
      if (cur) cur.closed = true;
      i += 1;
    } else {
      i += 1;   // unexpected token — skip defensively rather than throw
    }
  }
  return subpaths;
}
// Inverse of parsePathD. Coordinate precision deliberately matches the
// 2 decimals every d-string in this file is already written with
// (renderResult's own path building) — in solver-px, 0.01px is a small
// fraction of any plotter's resolution, and re-emitting at a different
// precision than the rest of the pipeline would only make diffs noisy.
// digits: 2 everywhere the path stays in its own (solver-px / block-local)
// units; the one-path-per-pen export writes page mm, where 3 is needed to
// keep the same effective precision (see buildPenPathsExport).
export function emitPathD(subpaths, digits = 2){
  const f = n => n.toFixed(digits);
  const out = [];
  for (const sp of subpaths){
    if (!sp.segs.length) continue;
    out.push('M', f(sp.start[0]), f(sp.start[1]));
    for (const s of sp.segs){
      if (s.t === 'C') out.push('C', f(s.c1[0]), f(s.c1[1]), f(s.c2[0]), f(s.c2[1]), f(s.p[0]), f(s.p[1]));
      else out.push('L', f(s.p[0]), f(s.p[1]));
    }
    if (sp.closed) out.push('Z');
  }
  return out.join(' ');
}
// A closed subpath's closing edge is implicit (a bare Z). Both passes
// below need to treat it as a real segment — it carries ink, so it can be
// dashed and it can cross a margin — so materialize it as a plain line
// back to the start point, unless the path already ends there.
function segsWithClose(sp){
  if (!sp.closed || !sp.segs.length) return sp.segs;
  const last = sp.segs[sp.segs.length-1].p;
  if (last[0] === sp.start[0] && last[1] === sp.start[1]) return sp.segs;
  return sp.segs.concat([{ t: 'L', p: sp.start.slice() }]);
}
function lerpPt(a, b, t){ return [a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t]; }
// de Casteljau split at t: the two halves together reproduce the original
// curve exactly (no approximation anywhere in this), each as its own cubic.
function bezSplit(p0, c1, c2, p3, t){
  const a = lerpPt(p0,c1,t), b = lerpPt(c1,c2,t), c = lerpPt(c2,p3,t);
  const d = lerpPt(a,b,t), e = lerpPt(b,c,t);
  const m = lerpPt(d,e,t);
  return { left: [p0,a,d,m], right: [m,e,c,p3] };
}
// The piece of a segment covering parameter range [t0,t1], returned as its
// own start point plus a segment of the SAME type — a cut cubic stays a
// cubic. Splitting off the tail first reparametrizes [0,t1] onto [0,1],
// which is why t0 has to be rescaled by t1 for the second cut.
function segSub(p0, seg, t0, t1){
  if (seg.t === 'C'){
    let pts = [p0, seg.c1, seg.c2, seg.p];
    if (t1 < 1) pts = bezSplit(pts[0],pts[1],pts[2],pts[3], t1).left;
    if (t0 > 0){
      const tt = t1 > 1e-12 ? Math.min(1, t0/Math.min(1,t1)) : 0;
      pts = bezSplit(pts[0],pts[1],pts[2],pts[3], tt).right;
    }
    return { start: pts[0], seg: { t:'C', c1: pts[1], c2: pts[2], p: pts[3] } };
  }
  return { start: lerpPt(p0, seg.p, t0), seg: { t:'L', p: lerpPt(p0, seg.p, t1) } };
}
// Arc-length table for one segment: exact for a line, sampled for a cubic
// (sample count scaled off the control polygon, which bounds the true arc
// length from above). Used only to convert a dash DISTANCE into a curve
// parameter — a stray fraction of a percent there shifts a dash boundary
// by a hair and nothing else, so sampling is entirely adequate.
const BEZ_LENGTH_SAMPLES_PER_PX = 0.5, BEZ_LENGTH_SAMPLES_MIN = 8, BEZ_LENGTH_SAMPLES_MAX = 64;
function segLengthTable(p0, seg){
  if (seg.t === 'L'){
    const total = Math.hypot(seg.p[0]-p0[0], seg.p[1]-p0[1]);
    return { total, tAt: s => total > 1e-12 ? Math.max(0, Math.min(1, s/total)) : 0 };
  }
  const poly = Math.hypot(seg.c1[0]-p0[0], seg.c1[1]-p0[1]) +
               Math.hypot(seg.c2[0]-seg.c1[0], seg.c2[1]-seg.c1[1]) +
               Math.hypot(seg.p[0]-seg.c2[0], seg.p[1]-seg.c2[1]);
  const n = Math.max(BEZ_LENGTH_SAMPLES_MIN, Math.min(BEZ_LENGTH_SAMPLES_MAX, Math.ceil(poly*BEZ_LENGTH_SAMPLES_PER_PX)));
  const ts = [0], ls = [0];
  let prev = p0, acc = 0;
  for (let k=1; k<=n; k++){
    const t = k/n, v = 1-t;
    const x = v*v*v*p0[0] + 3*v*v*t*seg.c1[0] + 3*v*t*t*seg.c2[0] + t*t*t*seg.p[0];
    const y = v*v*v*p0[1] + 3*v*v*t*seg.c1[1] + 3*v*t*t*seg.c2[1] + t*t*t*seg.p[1];
    acc += Math.hypot(x-prev[0], y-prev[1]);
    ts.push(t); ls.push(acc);
    prev = [x,y];
  }
  return {
    total: acc,
    tAt(s){
      if (acc <= 1e-12) return 0;
      const target = Math.max(0, Math.min(acc, s));
      let i = 1;
      while (i < ls.length-1 && ls[i] < target) i++;
      const span = ls[i] - ls[i-1];
      const f = span > 1e-12 ? (target - ls[i-1]) / span : 0;
      return ts[i-1] + (ts[i]-ts[i-1])*f;
    },
  };
}
// Layout-tab equivalent of the inline segment/path accumulation renderResult
// does per-layer via accumulatePathStats — Layout only has each block's
// already-frozen, already-merged d-string to work from (not the raw
// per-edge segments), so it needs its own self-contained walk over the
// d-string tokens instead. Handles M/L/Z (everything but Circles) and C
// (Circles layer, emitted as cubic-Bezier arcs — see arcToBezierSegments)
// tokens. Arc length for C is approximated by sampling the cubic Bezier at
// a handful of points, which is plenty accurate for a stats readout.
// inkFraction: fraction of the geometric length that's actually pen-down
// for this d-string's dash setting (see dashOnFraction in main.js) —
// applied as a flat multiplier at the end since it's uniform across the
// whole d-string (one dash setting per layer, not per-segment).
const D_STATS_BEZIER_SAMPLES = 8;
export function computeDStats(d, inkFraction){
  const out = { segments: 0, paths: 0, closedPaths: 0, lenPx: 0 };
  const tokens = d.trim().split(/\s+/);
  let cur = null, start = null;
  for (let i = 0; i < tokens.length; ){
    const t = tokens[i];
    if (t === 'M'){
      cur = [parseFloat(tokens[i+1]), parseFloat(tokens[i+2])];
      start = cur;
      out.paths++;
      i += 3;
    } else if (t === 'L'){
      const p = [parseFloat(tokens[i+1]), parseFloat(tokens[i+2])];
      out.segments++;
      out.lenPx += Math.hypot(p[0]-cur[0], p[1]-cur[1]);
      cur = p;
      i += 3;
    } else if (t === 'C'){
      const c1 = [parseFloat(tokens[i+1]), parseFloat(tokens[i+2])];
      const c2 = [parseFloat(tokens[i+3]), parseFloat(tokens[i+4])];
      const p3 = [parseFloat(tokens[i+5]), parseFloat(tokens[i+6])];
      out.segments++;
      let prev = cur;
      for (let s = 1; s <= D_STATS_BEZIER_SAMPLES; s++){
        const u = s / D_STATS_BEZIER_SAMPLES, v = 1 - u;
        const x = v*v*v*cur[0] + 3*v*v*u*c1[0] + 3*v*u*u*c2[0] + u*u*u*p3[0];
        const y = v*v*v*cur[1] + 3*v*v*u*c1[1] + 3*v*u*u*c2[1] + u*u*u*p3[1];
        out.lenPx += Math.hypot(x-prev[0], y-prev[1]);
        prev = [x, y];
      }
      cur = p3;
      i += 7;
    } else if (t === 'Z' || t === 'z'){
      if (cur && start && (cur[0] !== start[0] || cur[1] !== start[1])){
        out.lenPx += Math.hypot(start[0]-cur[0], start[1]-cur[1]);
      }
      out.closedPaths++;
      cur = start;
      i += 1;
    } else {
      i += 1;   // unexpected token — skip defensively rather than throw
    }
  }
  out.lenPx *= (inkFraction === undefined ? 1 : inkFraction);
  return out;
}
// Splits a dashed path into real geometry: only the "on" portions of the
// dash/gap pattern survive, each as its own subpath, so a plotter reads
// genuine pen-up gaps instead of a solid line styled to LOOK dashed.
// The pattern restarts at the beginning of every subpath — matching native
// SVG stroke-dasharray behavior exactly, rather than continuing across the
// (pen-up) gap between two already-disconnected subpaths.
// Walks the segment model above rather than a flat vertex list, so a
// Circles-layer arc on a dashed pen survives as a series of shorter ARCS.
// (The previous vertex-list version simply had no case for a C token and
// skipped straight past it, so a dashed Circles layer exported as a set of
// bare M points with no ink between them at all — the whole layer silently
// vanished from the file. Nothing else emits curves, which is why it went
// unnoticed for so long.) A closed subpath's closing edge is dashed like
// any other segment via segsWithClose(); the resulting dash pieces are all
// open by nature, so nothing is ever re-emitted with a Z.
// pattern is the FULL dash/gap list ([dash, gap, dash, gap, ...], in the
// path's own units — i.e. exactly what its stroke-dasharray says), walked
// cyclically. An earlier version took only the first dash/gap pair, so any
// pattern using a second or third pair exported differently from what the
// preview drew. A 0 gap between two dashes simply joins them into one run
// (the continuation check below); a 0-length dash never emits anything.
export function splitDashedPathD(d, pattern){
  if (pattern.length % 2) pattern = pattern.concat(pattern);   // SVG's own rule for an odd-length dasharray
  let period = 0;
  const runs = [];            // [offset within one period, length] of every "on" run
  for (let i = 0; i + 1 < pattern.length; i += 2){
    if (pattern[i] > 1e-6) runs.push([period, pattern[i]]);
    period += pattern[i] + pattern[i+1];
  }
  if (!(period > 1e-6) || !runs.length) return d;   // degenerate pattern — leave unchanged
  const out = [];
  for (const sp of parsePathD(d)){
    const segs = segsWithClose(sp);
    if (!segs.length) continue;
    let p0 = sp.start;
    let pos = 0;               // distance from this subpath's own start — the dash phase
    let cur = null, curEnd = 0;
    const flush = () => { if (cur && cur.segs.length) out.push(cur); cur = null; };
    for (const seg of segs){
      const tbl = segLengthTable(p0, seg);
      const L = tbl.total;
      if (L > 1e-9){
        for (let k = Math.floor(pos/period); k*period < pos + L - 1e-9; k++){
          for (const [off, len] of runs){
            const onStart = k*period + off, onEnd = onStart + len;
            if (onStart >= pos + L - 1e-9) break;
            const s = Math.max(onStart, pos), e = Math.min(onEnd, pos + L);
            if (e <= s + 1e-9) continue;
            const sub = segSub(p0, seg, tbl.tAt(s-pos), tbl.tAt(e-pos));
            if (cur && Math.abs(s - curEnd) < 1e-9) cur.segs.push(sub.seg);   // same "on" run continuing across a segment join (or a 0 gap)
            else { flush(); cur = { start: sub.start, segs: [sub.seg], closed: false }; }
            curEnd = e;
          }
        }
      }
      pos += L;
      p0 = seg.p;
    }
    flush();
  }
  return emitPathD(out);
}

/* ================================================================
   Trim to margins — the export-only clip behind the "Trim SVG export
   to margins" checkbox. Runs on the export CLONE as the very last
   geometry step (after dash splitting, so each dash piece is clipped
   individually and the dash rhythm matches what the preview showed),
   and never touches the live document: on screen the same result is
   only simulated, by masking the band outside the margins in the page
   colour (see syncPreviewTrimMask/syncLayoutTrimMask).

   Clipping happens in each path's OWN local coordinate system, not in
   page-mm space: the margin rectangle is mapped backwards through the
   path's accumulated transform instead. That keeps every surviving
   coordinate in the units it was authored in, leaves the ancestor
   translate/scale transforms (and therefore the mm-anchored stroke
   widths that depend on them — see applyLayerStyle) completely
   untouched, and means a fully-inside path can be left byte-for-byte
   as it was. A rotated Layout block simply turns the rectangle into a
   rotated one in local space, which is still four half-planes, so
   rotation needs no special case.

   Half-plane clipping is exact for both segment types: a line's
   signed distance to a clip line is linear in t, and a cubic's is a
   cubic in t (signed distance is affine in the point, the point is a
   cubic in t), so the crossings are true roots and the surviving
   pieces are de Casteljau splits — curves stay curves.
   ================================================================ */
const MAT_IDENTITY = { a:1, b:0, c:0, d:1, e:0, f:0 };
// Applies q first, then p — the order an SVG transform chain composes in
// when walking from an ancestor down to the element.
function matMul(p, q){
  return {
    a: p.a*q.a + p.c*q.b,
    b: p.b*q.a + p.d*q.b,
    c: p.a*q.c + p.c*q.d,
    d: p.b*q.c + p.d*q.d,
    e: p.a*q.e + p.c*q.f + p.e,
    f: p.b*q.e + p.d*q.f + p.f,
  };
}
export function matApply(m, p){ return [m.a*p[0] + m.c*p[1] + m.e, m.b*p[0] + m.d*p[1] + m.f]; }
export function matInvert(m){
  const det = m.a*m.d - m.b*m.c;
  if (Math.abs(det) < 1e-12) return null;
  return {
    a:  m.d/det, b: -m.b/det,
    c: -m.c/det, d:  m.a/det,
    e: (m.c*m.f - m.d*m.e)/det,
    f: (m.b*m.e - m.a*m.f)/det,
  };
}
// Deliberately a plain text parse rather than SVGGraphicsElement.transform
// /getCTM(): the element being measured lives in a DETACHED clone that was
// never inserted into the document, where the DOM's own matrix plumbing is
// not dependable across engines. Everything it has to understand is written
// by this codebase itself (translate/scale/rotate, see updateBlockTransform
// and renderPaper), with matrix/skew accepted for completeness.
function parseTransformAttr(str){
  let m = MAT_IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let hit;
  while ((hit = re.exec(str))){
    const v = hit[2].trim().split(/[\s,]+/).map(parseFloat);
    const n = i => (isFinite(v[i]) ? v[i] : 0);
    let t = MAT_IDENTITY;
    if (hit[1] === 'matrix') t = { a:n(0), b:n(1), c:n(2), d:n(3), e:n(4), f:n(5) };
    else if (hit[1] === 'translate') t = { a:1, b:0, c:0, d:1, e:n(0), f:v.length>1 ? n(1) : 0 };
    else if (hit[1] === 'scale'){ const sx = n(0), sy = v.length>1 ? n(1) : sx; t = { a:sx, b:0, c:0, d:sy, e:0, f:0 }; }
    else if (hit[1] === 'rotate'){
      const th = n(0)*Math.PI/180, cos = Math.cos(th), sin = Math.sin(th);
      t = { a:cos, b:sin, c:-sin, d:cos, e:0, f:0 };
      if (v.length >= 3){        // rotate(angle cx cy) — translate to the pivot, rotate, translate back
        const cx = n(1), cy = n(2);
        t = matMul(matMul({ a:1,b:0,c:0,d:1,e:cx,f:cy }, t), { a:1,b:0,c:0,d:1,e:-cx,f:-cy });
      }
    }
    else if (hit[1] === 'skewX') t = { a:1, b:0, c:Math.tan(n(0)*Math.PI/180), d:1, e:0, f:0 };
    else if (hit[1] === 'skewY') t = { a:1, b:Math.tan(n(0)*Math.PI/180), c:0, d:1, e:0, f:0 };
    m = matMul(m, t);
  }
  return m;
}
// Element -> root user space (the viewBox space, which for both #plot and
// #layoutPlot IS page mm — see renderPaper/syncLayoutPaperFrame, both of
// which set "0 0 paperW paperH"). The root's own attributes are excluded,
// since the viewBox mapping is exactly what makes that space mm in the
// first place.
export function ctmWithinRoot(el, root){
  const chain = [];
  for (let n = el; n && n !== root; n = n.parentNode) chain.push(n);
  let m = MAT_IDENTITY;
  for (let i = chain.length-1; i >= 0; i--){
    const t = chain[i].getAttribute && chain[i].getAttribute('transform');
    if (t) m = matMul(m, parseTransformAttr(t));
  }
  return m;
}
// The margin rectangle expressed as four inward half-planes in some path's
// own local space. value(p) >= 0 means "inside" for all four. The inward
// direction is taken from the mapped rectangle's own centroid rather than
// from a winding assumption, so a mirroring transform can't quietly invert
// the whole test and clip away precisely the wrong half.
function marginHalfPlanes(dims, inv){
  const x0 = dims.margin.left, y0 = dims.margin.top;
  const x1 = Math.max(x0, dims.paperW - dims.margin.right);
  const y1 = Math.max(y0, dims.paperH - dims.margin.bottom);
  const q = [[x0,y0],[x1,y0],[x1,y1],[x0,y1]].map(p => matApply(inv, p));
  const cx = (q[0][0]+q[1][0]+q[2][0]+q[3][0])/4, cy = (q[0][1]+q[1][1]+q[2][1]+q[3][1])/4;
  const planes = [];
  for (let i=0; i<4; i++){
    const a = q[i], b = q[(i+1)%4];
    let nx = -(b[1]-a[1]), ny = b[0]-a[0];
    const len = Math.hypot(nx, ny);
    if (len < 1e-12) return null;             // degenerate mapping — caller leaves the path alone
    nx /= len; ny /= len;
    let c = -(nx*a[0] + ny*a[1]);
    if (nx*cx + ny*cy + c < 0){ nx = -nx; ny = -ny; c = -c; }
    planes.push({ nx, ny, c });
  }
  return planes;
}
// Roots of a cubic given in Bernstein form, found by splitting [0,1] at the
// derivative's own roots (so every piece is monotonic) and bisecting the
// pieces that change sign. Deliberately not the closed-form cubic solution:
// the analytic formula's near-degenerate cases (triple roots, a vanishing
// leading coefficient — both entirely ordinary here, since a straight-ish
// arc or a curve tangent to a margin produces exactly those) need careful
// handling to stay accurate, while monotonic bisection is unconditionally
// stable and still lands within ~1e-15 after the iterations below.
const CUBIC_BISECT_ITERS = 60;
function cubicRootsInUnit(b0, b1, b2, b3){
  const a0 = b0, a1 = 3*(b1-b0), a2 = 3*(b2 - 2*b1 + b0), a3 = b3 - 3*b2 + 3*b1 - b0;
  const f = t => ((a3*t + a2)*t + a1)*t + a0;
  const crit = [];
  const A = 3*a3, B = 2*a2, C = a1;
  if (Math.abs(A) < 1e-12){
    if (Math.abs(B) > 1e-12){ const t = -C/B; if (t > 0 && t < 1) crit.push(t); }
  } else {
    const disc = B*B - 4*A*C;
    if (disc > 0){
      const s = Math.sqrt(disc);
      for (const t of [(-B-s)/(2*A), (-B+s)/(2*A)]) if (t > 0 && t < 1) crit.push(t);
    }
  }
  crit.sort((x,y) => x-y);
  const knots = [0, ...crit, 1];
  const roots = [];
  for (let i=0; i<knots.length-1; i++){
    let lo = knots[i], hi = knots[i+1];
    let flo = f(lo), fhi = f(hi);
    if (flo === 0) roots.push(lo);
    if (flo*fhi < 0){
      for (let k=0; k<CUBIC_BISECT_ITERS; k++){
        const mid = (lo+hi)/2, fm = f(mid);
        if (flo*fm <= 0){ hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
      }
      roots.push((lo+hi)/2);
    }
  }
  return { f, roots };
}
// The sub-ranges of one segment's parameter that lie inside a half-plane.
function segInsideIntervals(p0, seg, hp){
  const val = p => hp.nx*p[0] + hp.ny*p[1] + hp.c;
  if (seg.t === 'L'){
    const f0 = val(p0), f1 = val(seg.p);
    if (f0 >= 0 && f1 >= 0) return [[0,1]];
    if (f0 < 0 && f1 < 0) return [];
    const t = f0/(f0-f1);
    return f0 >= 0 ? [[0,t]] : [[t,1]];
  }
  const b0 = val(p0), b1 = val(seg.c1), b2 = val(seg.c2), b3 = val(seg.p);
  // Convex hull property: a Bezier never leaves its control polygon's hull,
  // so all-four-inside (or all-four-outside) settles the whole curve without
  // touching the root finder.
  if (b0 >= 0 && b1 >= 0 && b2 >= 0 && b3 >= 0) return [[0,1]];
  if (b0 < 0 && b1 < 0 && b2 < 0 && b3 < 0) return [];
  const { f, roots } = cubicRootsInUnit(b0, b1, b2, b3);
  const knots = [0, ...roots.filter(r => r > 1e-12 && r < 1-1e-12), 1];
  const out = [];
  for (let i=0; i<knots.length-1; i++){
    const a = knots[i], b = knots[i+1];
    if (b - a < 1e-12) continue;
    if (f((a+b)/2) < 0) continue;
    if (out.length && Math.abs(out[out.length-1][1] - a) < 1e-12) out[out.length-1][1] = b;   // merge across a tangential touch
    else out.push([a, b]);
  }
  return out;
}
// One subpath clipped against one half-plane -> zero or more subpaths.
function clipSubpathHalfPlane(sp, hp){
  const segs = segsWithClose(sp);
  if (!segs.length) return [];
  const EPS = 1e-9;
  // Wholly-inside fast path, and the ONLY way a closed subpath survives as
  // a closed one: returning the very same object (identity, not a copy) is
  // what lets the caller recognize "nothing was cut here" and re-emit the
  // original d-data untouched, Z and all, instead of rebuilding it.
  const val = p => hp.nx*p[0] + hp.ny*p[1] + hp.c;
  let allIn = val(sp.start) >= 0;
  for (const s of segs){
    if (!allIn) break;
    if (s.t === 'C') allIn = val(s.c1) >= 0 && val(s.c2) >= 0 && val(s.p) >= 0;
    else allIn = val(s.p) >= 0;
  }
  if (allIn) return [sp];
  const out = [];
  let cur = null, p0 = sp.start;
  // Tracked as the piece OBJECTS themselves rather than as flags, so the
  // closed-path rejoin below can compare identity against what actually
  // survived: a run reaching the seam can still be dropped as a sliver by
  // the length filter, and a flag would then rejoin the wrong two pieces.
  let headPiece = null, tailPiece = null;
  // A path that merely grazes a margin (or whose dash piece ends exactly on
  // one) yields a piece of no length at all. It isn't nothing on a plotter:
  // with stroke-linecap:round a zero-length stroke is a visible dot of ink
  // the size of the nib, so these are dropped rather than exported. The
  // threshold is half the precision emitPathD writes at — below that a piece
  // cannot even be represented as two distinct points in the file.
  const CLIP_MIN_PIECE = 0.005;
  const pieceLen = piece => {
    let total = 0, q = piece.start;
    for (const s of piece.segs){ total += Math.hypot(s.p[0]-q[0], s.p[1]-q[1]); q = s.p; }
    return total;
  };
  const flush = () => { if (cur && cur.segs.length && pieceLen(cur) > CLIP_MIN_PIECE) out.push(cur); cur = null; };
  for (let i=0; i<segs.length; i++){
    const seg = segs[i];
    const ivs = segInsideIntervals(p0, seg, hp);
    if (!ivs.length) flush();
    for (const [ta, tb] of ivs){
      if (ta > EPS) flush();          // a gap in the ink before this piece — previous run ends here
      const sub = segSub(p0, seg, ta, tb);
      if (!cur){
        cur = { start: sub.start, segs: [], closed: false };
        if (i === 0 && ta <= EPS) headPiece = cur;
      }
      cur.segs.push(sub.seg);
      tailPiece = (i === segs.length-1 && tb >= 1-EPS) ? cur : null;
      if (tb < 1-EPS) flush();
    }
    p0 = seg.p;
  }
  flush();
  // A closed path cut open still shouldn't be reported as two strokes when
  // the cut fell somewhere other than its own start point: the run that ends
  // at the seam and the run that begins there are one continuous stroke, so
  // rejoin them (the start point is only an artifact of where the d-string
  // happened to begin).
  if (sp.closed && out.length > 1 && out[0] === headPiece && out[out.length-1] === tailPiece){
    const last = out.pop();
    out[0] = { start: last.start, segs: last.segs.concat(out[0].segs), closed: false };
  }
  return out;
}
// Clips one d-string against the margin rectangle, seen from `inv` (the
// inverse of that path's own accumulated transform). Returns null when the
// whole path is inside and nothing needs rewriting, '' when nothing of it
// survives at all.
export function clipPathDToMargins(d, dims, inv){
  const planes = marginHalfPlanes(dims, inv);
  if (!planes) return null;
  const subpaths = parsePathD(d);
  if (!subpaths.length) return null;
  let changed = false;
  const out = [];
  for (const sp of subpaths){
    let pieces = [sp];
    for (const hp of planes){
      const next = [];
      for (const piece of pieces) next.push(...clipSubpathHalfPlane(piece, hp));
      pieces = next;
      if (!pieces.length) break;
    }
    // Untouched is the common case (a drawing that fits inside its own
    // margins) and is worth detecting explicitly: clipSubpathHalfPlane
    // hands back the identical object when a subpath is wholly inside a
    // plane, so surviving all four unchanged means nothing was cut and the
    // ORIGINAL data is kept rather than a re-rounded rebuild of it.
    if (pieces.length === 1 && pieces[0] === sp){
      out.push(sp);
    } else {
      changed = true;
      for (const piece of pieces) out.push(piece);   // push, not concat: a hatch layer runs this tens of thousands of times
    }
  }
  if (!changed) return null;
  return emitPathD(out);
}
// Applies the trim to every path in an export clone. dims is whichever
// paper description the export is built from — computePaperLayout() for
// Preview, computeLayoutPaperDims() for Layout; both carry paperW/paperH/
// margin in mm, which is all this needs.
export function trimCloneToMargins(root, dims){
  root.querySelectorAll('path').forEach(p => {
    const inv = matInvert(ctmWithinRoot(p, root));
    if (!inv) return;                       // collapsed transform — nothing sane to clip against, leave it
    const d = clipPathDToMargins(p.getAttribute('d') || '', dims, inv);
    if (d === null) return;                 // entirely inside — untouched
    if (d) p.setAttribute('d', d);
    else p.remove();                        // entirely outside the margins — never exported
  });
}
