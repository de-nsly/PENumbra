/* ================================================================
   worker/geom-utils.js — screen-space & shadow geometry building blocks
   Stateless helpers generate() (solver.js) composes into the solve
   pipeline: segment intersection/spatial indexing, the light-space
   shadow map, screen->world face recovery, circle/ring pattern
   walking, and shading-buffer sampling. makeLightBasis and
   walkCircleSplit are internal to buildShadowMap/buildPatternSegsFromTest
   respectively and not used anywhere else.
   ================================================================ */
/* ---------------- generate: project · classify · occlude · hatch ---------------- */
export function intersectSegs(ax,ay,bx,by,cx,cy,dx,dy){
  const rx=bx-ax, ry=by-ay, sx=dx-cx, sy=dy-cy;
  const denom = rx*sy - ry*sx;
  if (Math.abs(denom) < 1e-9) return null;      // parallel/collinear — not split further
  const t = ((cx-ax)*sy - (cy-ay)*sx) / denom;
  const u = ((cx-ax)*ry - (cy-ay)*rx) / denom;
  const eps = 1e-6;
  if (t>eps && t<1-eps && u>eps && u<1-eps) return { t, u };
  return null;
}

/* Uniform grid over a flat [x0,y0,x1,y1,...] segment list — acceleration for
   the contour / scene-outline splitting passes, which used to test every
   silhouette edge against EVERY splitter segment (all-pairs O(k²), the reason
   both features carried hard "too complex, bail out" thresholds). query()
   invokes the callback once per candidate whose grid cells the query
   segment's bbox touches. Completeness: two segments can only intersect if
   their bboxes overlap; overlapping bboxes always share at least one grid
   cell (cell-index ranges of overlapping intervals overlap, since the
   cell-of mapping is monotone) — so every possible intersection partner IS
   visited, and the grid can never miss a split the all-pairs loop found. */
export function buildSegGrid(flat){
  const n = flat.length/4;
  if (!n) return { query: () => {} };
  let x0=1/0,y0=1/0,x1=-1/0,y1=-1/0;
  for (let i=0;i<flat.length;i+=2){
    const x=flat[i], y=flat[i+1];
    if (x<x0)x0=x; if (x>x1)x1=x; if (y<y0)y0=y; if (y>y1)y1=y;
  }
  const spanX=Math.max(x1-x0,1e-9), spanY=Math.max(y1-y0,1e-9);
  const cell=Math.max(Math.sqrt(spanX*spanY/n)*1.7, Math.min(spanX,spanY)/512);
  const gw=Math.max(1,Math.min(512,Math.ceil(spanX/cell)));
  const gh=Math.max(1,Math.min(512,Math.ceil(spanY/cell)));
  const cX=x=>Math.min(gw-1,Math.max(0,Math.floor((x-x0)/spanX*gw)));
  const cY=y=>Math.min(gh-1,Math.max(0,Math.floor((y-y0)/spanY*gh)));
  const count=new Int32Array(gw*gh);
  const forCells=(j,fn)=>{
    const a=cX(Math.min(flat[j*4],flat[j*4+2])), b=cX(Math.max(flat[j*4],flat[j*4+2]));
    const c=cY(Math.min(flat[j*4+1],flat[j*4+3])), d=cY(Math.max(flat[j*4+1],flat[j*4+3]));
    for (let vy=c;vy<=d;vy++) for (let vx=a;vx<=b;vx++) fn(vy*gw+vx);
  };
  for (let j=0;j<n;j++) forCells(j, ci=>count[ci]++);
  const start=new Int32Array(gw*gh+1);
  for (let i=0;i<gw*gh;i++) start[i+1]=start[i]+count[i];
  const items=new Int32Array(start[gw*gh]);
  const fill=start.slice(0,gw*gh);
  for (let j=0;j<n;j++) forCells(j, ci=>{ items[fill[ci]++]=j; });
  const stamp=new Int32Array(n).fill(-1);
  let gen=0;
  return { query(ax,ay,bx,by, cb){
    gen++;
    const qx0=cX(Math.min(ax,bx)), qx1=cX(Math.max(ax,bx));
    const qy0=cY(Math.min(ay,by)), qy1=cY(Math.max(ay,by));
    for (let vy=qy0;vy<=qy1;vy++) for (let vx=qx0;vx<=qx1;vx++){
      const ci=vy*gw+vx;
      for (let li=start[ci];li<start[ci+1];li++){
        const j=items[li];
        if (stamp[j]===gen) continue;
        stamp[j]=gen;
        cb(j);
      }
    }
  }};
}

/* ---------------- shadow infrastructure (stage 1) ----------------
   "Is this point blocked from the light" is the hidden-line solver's question
   aimed in a different direction: a directional light is an orthographic
   camera, so shadow testing = project the scene orthographically along the
   light direction and depth-compare against an occluder grid — the same
   machinery as camera-space occlusion, second instance, different axis.
   Standalone + stateless on purpose: testable directly, and generate() only
   pays for any of this when the shadow toggle is actually on (stage 2+). */

// orthonormal basis with w pointing toward the light; u,v span the light plane
function makeLightBasis(L){
  const l = Math.hypot(L[0],L[1],L[2]) || 1;
  const wx=L[0]/l, wy=L[1]/l, wz=L[2]/l;
  // reference axis least aligned with the light, so the cross product stays fat
  const rx = Math.abs(wz)<0.9 ? 0 : 1, ry = 0, rz = Math.abs(wz)<0.9 ? 1 : 0;
  let ux = wy*rz - wz*ry, uy = wz*rx - wx*rz, uz = wx*ry - wy*rx;
  const ul = Math.hypot(ux,uy,uz) || 1; ux/=ul; uy/=ul; uz/=ul;
  const vx = wy*uz - wz*uy, vy = wz*ux - wx*uz, vz = wx*uy - wy*ux;
  return { ux,uy,uz, vx,vy,vz, wx,wy,wz };
}

// Build a light-space occluder set + spatial grid over the whole scene.
// watertight: cull triangles facing away from the light (mirror of the camera
// solver's back-face cull — for closed solids only the light-facing surface
// can be the first blocker along a light ray).
// eps: absolute depth bias in world units; callers scale it to scene size.
// Returns { test(px,py,pz, skipF) → bool, kept } — test() is world-space in,
// boolean "in shadow" out.
export function buildShadowMap(pos, tri, fn, nt, L, watertight, eps){
  const B = makeLightBasis(L);
  const nv = pos.length/3;
  const lu = new Float32Array(nv), lv = new Float32Array(nv), ld = new Float32Array(nv);
  for (let i=0;i<nv;i++){
    const x=pos[i*3], y=pos[i*3+1], z=pos[i*3+2];
    lu[i] = x*B.ux + y*B.uy + z*B.uz;
    lv[i] = x*B.vx + y*B.vy + z*B.vz;
    ld[i] = x*B.wx + y*B.wy + z*B.wz;          // distance toward the light
  }
  // kept occluders + overall light-plane bounds
  const keep = [];
  let bu0=1/0,bv0=1/0,bu1=-1/0,bv1=-1/0;
  for (let f=0; f<nt; f++){
    if (watertight && (fn[f*3]*B.wx + fn[f*3+1]*B.wy + fn[f*3+2]*B.wz) <= 0) continue;
    keep.push(f);
    for (let k=0;k<3;k++){
      const i=tri[f*3+k];
      if (lu[i]<bu0)bu0=lu[i]; if (lu[i]>bu1)bu1=lu[i];
      if (lv[i]<bv0)bv0=lv[i]; if (lv[i]>bv1)bv1=lv[i];
    }
  }
  const nOcc = keep.length;
  if (!nOcc) return { test: () => false, countHits: () => 0, kept: 0, uvOf: () => [0,0], bounds: [0,0,0,0] };
  /* Per-occluder precomputation — mirror of the camera-space occlusion
     optimization: everything test() used to rebuild per query (vertex uv
     fetches through tri[], det, sign, plane coefficients, bbox) depends only
     on the occluder, so it's hoisted into flat typed arrays here. oMaxD
     (each occluder's greatest distance toward the light) enables the same
     conservative reject as the camera solver: an occluder that never gets
     closer to the light than the query point + eps can never shadow it. */
  const kAx=new Float64Array(nOcc), kAy=new Float64Array(nOcc), kAd=new Float64Array(nOcc);
  const kBx=new Float64Array(nOcc), kBy=new Float64Array(nOcc);
  const kCx=new Float64Array(nOcc), kCy=new Float64Array(nOcc);
  const kS =new Float64Array(nOcc);
  const kA =new Float64Array(nOcc), kBc=new Float64Array(nOcc);
  const kU0=new Float64Array(nOcc), kU1=new Float64Array(nOcc);
  const kV0=new Float64Array(nOcc), kV1=new Float64Array(nOcc);
  const kMaxD=new Float64Array(nOcc);
  const kSkip=new Uint8Array(nOcc);
  const kF = Int32Array.from(keep);
  for (let ki=0; ki<nOcc; ki++){
    const f = keep[ki];
    const a=tri[f*3], b=tri[f*3+1], c=tri[f*3+2];
    const ax=lu[a],ay=lv[a], bx=lu[b],by=lv[b], cx=lu[c],cy=lv[c];
    kAx[ki]=ax; kAy[ki]=ay; kAd[ki]=ld[a];
    kBx[ki]=bx; kBy[ki]=by; kCx[ki]=cx; kCy[ki]=cy;
    kU0[ki]=Math.min(ax,bx,cx); kU1[ki]=Math.max(ax,bx,cx);
    kV0[ki]=Math.min(ay,by,cy); kV1[ki]=Math.max(ay,by,cy);
    kMaxD[ki]=Math.max(ld[a],ld[b],ld[c]);
    const det=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
    if (Math.abs(det)<1e-12){ kSkip[ki]=1; continue; }
    kS[ki]=det>0?1:-1;
    const d1u=bx-ax, d1v=by-ay, d1d=ld[b]-ld[a];
    const d2u=cx-ax, d2v=cy-ay, d2d=ld[c]-ld[a];
    kA[ki]=(d1d*d2v-d2d*d1v)/det; kBc[ki]=(d1u*d2d-d2u*d1d)/det;
  }
  const spanU = Math.max(bu1-bu0, 1e-9), spanV = Math.max(bv1-bv0, 1e-9);
  const cell = Math.max(Math.sqrt(spanU*spanV/nOcc)*1.7, Math.min(spanU,spanV)/512);
  const gw = Math.max(1, Math.min(512, Math.ceil(spanU/cell)));
  const gh = Math.max(1, Math.min(512, Math.ceil(spanV/cell)));
  const cellU = u => Math.min(gw-1, Math.max(0, Math.floor((u-bu0)/spanU*gw)));
  const cellV = v => Math.min(gh-1, Math.max(0, Math.floor((v-bv0)/spanV*gh)));
  /* CSR grid + per-cell greatest light-distance aggregate */
  const cellCount=new Int32Array(gw*gh);
  for (let ki=0; ki<nOcc; ki++){
    const cy0=cellV(kV0[ki]), cy1=cellV(kV1[ki]), cx0=cellU(kU0[ki]), cx1=cellU(kU1[ki]);
    for (let cy=cy0; cy<=cy1; cy++) for (let cx=cx0; cx<=cx1; cx++) cellCount[cy*gw+cx]++;
  }
  const cellStart=new Int32Array(gw*gh+1);
  for (let i=0;i<gw*gh;i++) cellStart[i+1]=cellStart[i]+cellCount[i];
  const cellItems=new Int32Array(cellStart[gw*gh]);
  const cellFill=cellStart.slice(0,gw*gh);
  const cellMaxD=new Float64Array(gw*gh).fill(-Infinity);
  for (let ki=0; ki<nOcc; ki++){
    const cy0=cellV(kV0[ki]), cy1=cellV(kV1[ki]), cx0=cellU(kU0[ki]), cx1=cellU(kU1[ki]);
    for (let cy=cy0; cy<=cy1; cy++) for (let cx=cx0; cx<=cx1; cx++){
      const ci=cy*gw+cx;
      cellItems[cellFill[ci]++]=ki;
      if (kMaxD[ki]>cellMaxD[ci]) cellMaxD[ci]=kMaxD[ki];
    }
  }
  function test(px, py, pz, skipF){
    const u = px*B.ux + py*B.uy + pz*B.uz;
    const v = px*B.vx + py*B.vy + pz*B.vz;
    if (u < bu0-1e-9 || u > bu1+1e-9 || v < bv0-1e-9 || v > bv1+1e-9) return false;
    const d = px*B.wx + py*B.wy + pz*B.wz;
    const dEps = d + eps;
    const ci = cellV(v)*gw + cellU(u);
    if (cellMaxD[ci] <= dEps) return false;   // nothing in this cell is closer to the light
    const s0=cellStart[ci], s1=cellStart[ci+1];
    for (let li=s0; li<s1; li++){
      const ki = cellItems[li];
      if (kSkip[ki]) continue;
      if (kMaxD[ki] <= dEps) continue;                        // occluder depth reject
      if (u<kU0[ki] || u>kU1[ki] || v<kV0[ki] || v>kV1[ki]) continue;   // bbox reject
      if (kF[ki] === skipF) continue;
      const ax=kAx[ki],ay=kAy[ki], bx=kBx[ki],by=kBy[ki], cx=kCx[ki],cy=kCy[ki];
      const s = kS[ki];
      if (s*((bx-ax)*(v-ay)-(by-ay)*(u-ax)) < -1e-12) continue;
      if (s*((cx-bx)*(v-by)-(cy-by)*(u-bx)) < -1e-12) continue;
      if (s*((ax-cx)*(v-cy)-(ay-cy)*(u-cx)) < -1e-12) continue;
      // depth of the occluder plane at (u,v) — linear under ortho projection
      const occD = kAd[ki] + kA[ki]*(u-ax) + kBc[ki]*(v-ay);
      if (occD > dEps) return true;           // something between the point and the light
    }
    return false;
  }
  // Same occluder grid and per-occluder plane math as test() — but instead
  // of stopping at the first occluder found, counts distinct occluders
  // between the point and the light, up to `cap` (early-exits once reached,
  // since callers only ever need "is this >= 2", never the exact count).
  // Used to tell a genuine gap (a ray passing fully through some solid —
  // its own shell or another's, entry AND exit, always registers as 2+)
  // apart from a self-shadow terminator (only ever the one grazing
  // crossing back onto the same surface it started from) — see project
  // notes for the reasoning and the standalone verification behind it.
  function countHits(px, py, pz, skipF, cap){
    const u = px*B.ux + py*B.uy + pz*B.uz;
    const v = px*B.vx + py*B.vy + pz*B.vz;
    if (u < bu0-1e-9 || u > bu1+1e-9 || v < bv0-1e-9 || v > bv1+1e-9) return 0;
    const d = px*B.wx + py*B.wy + pz*B.wz;
    const dEps = d + eps;
    const ci = cellV(v)*gw + cellU(u);
    if (cellMaxD[ci] <= dEps) return 0;
    const s0=cellStart[ci], s1=cellStart[ci+1];
    let count = 0;
    for (let li=s0; li<s1; li++){
      const ki = cellItems[li];
      if (kSkip[ki]) continue;
      if (kMaxD[ki] <= dEps) continue;
      if (u<kU0[ki] || u>kU1[ki] || v<kV0[ki] || v>kV1[ki]) continue;
      if (kF[ki] === skipF) continue;
      const ax=kAx[ki],ay=kAy[ki], bx=kBx[ki],by=kBy[ki], cx=kCx[ki],cy=kCy[ki];
      const s = kS[ki];
      if (s*((bx-ax)*(v-ay)-(by-ay)*(u-ax)) < -1e-12) continue;
      if (s*((cx-bx)*(v-by)-(cy-by)*(u-bx)) < -1e-12) continue;
      if (s*((ax-cx)*(v-cy)-(ay-cy)*(u-cx)) < -1e-12) continue;
      const occD = kAd[ki] + kA[ki]*(u-ax) + kBc[ki]*(v-ay);
      if (occD > dEps){
        count++;
        if (count >= cap) return count;
      }
    }
    return count;
  }
  return {
    test, countHits, kept: nOcc,
    uvOf: (px,py,pz) => [px*B.ux+py*B.uy+pz*B.uz, px*B.vx+py*B.vy+pz*B.vz],
    bounds: [bu0, bu1, bv0, bv1],
  };
}

// Recover a screen point's true world-space position on a given face.
// Hatching has only ever needed 2D screen coordinates; the shadow test is a
// 3D question, so this bridges the two. Perspective-correct: under perspective,
// world coordinates are NOT linear across the screen — but (world · 1/dist)
// and (1/dist) both are, so interpolate those and divide. Under ortho,
// plain screen-space barycentric interpolation is already exact.
export function worldOnFace(f, px, py, tri, pos, sxA, syA, izA, ortho){
  const a=tri[f*3], b=tri[f*3+1], c=tri[f*3+2];
  const ax=sxA[a],ay=syA[a], bx=sxA[b],by=syA[b], cx=sxA[c],cy=syA[c];
  const det=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
  if (Math.abs(det)<1e-12) return null;
  const w1=((px-ax)*(cy-ay)-(py-ay)*(cx-ax))/det;   // weight of b
  const w2=((bx-ax)*(py-ay)-(by-ay)*(px-ax))/det;   // weight of c
  const w0=1-w1-w2;
  if (ortho){
    return [
      w0*pos[a*3]  +w1*pos[b*3]  +w2*pos[c*3],
      w0*pos[a*3+1]+w1*pos[b*3+1]+w2*pos[c*3+1],
      w0*pos[a*3+2]+w1*pos[b*3+2]+w2*pos[c*3+2],
    ];
  }
  const qa=izA[a], qb=izA[b], qc=izA[c];
  const izP = w0*qa + w1*qb + w2*qc;
  if (Math.abs(izP)<1e-15) return null;
  return [
    (w0*pos[a*3]  *qa + w1*pos[b*3]  *qb + w2*pos[c*3]  *qc)/izP,
    (w0*pos[a*3+1]*qa + w1*pos[b*3+1]*qb + w2*pos[c*3+1]*qc)/izP,
    (w0*pos[a*3+2]*qa + w1*pos[b*3+2]*qb + w2*pos[c*3+2]*qc)/izP,
  ];
}

// Walks a circle (screen-space cx,cy,radius), testing testFn(x,y) at a seed
// pitch (seedPx apart, in screen pixels along the circumference) and
// bisecting any seed pair that disagrees until the crossing is refined to
// within cutPx — same recursion shape as shadeAt/shadowSplit's own
// boundary refinement above, just parametrized over a circle instead of a
// straight carrier segment. Returns [state, uStart, uEnd] pieces (u in
// [0,1) around the loop); the wrap-around seam (u=1 meeting u=0) is
// explicitly merged back together when both sides agree, so a run
// spanning it doesn't get reported as two separate pieces.
function walkCircleSplit(cx, cy, radius, testFn, seedPx, cutPx){
  const pxPerU = 2*Math.PI*radius;
  const Px = u => cx + radius*Math.cos(u*2*Math.PI);
  const Py = u => cy + radius*Math.sin(u*2*Math.PI);
  const nSeed = Math.max(8, Math.ceil(pxPerU / seedPx));
  const seedU = [], seedS = [];
  for (let i=0; i<nSeed; i++){ const u=i/nSeed; seedU.push(u); seedS.push(testFn(Px(u), Py(u))); }
  const segments = [];
  for (let i=0; i<nSeed; i++){
    const u0=seedU[i], u1=(i+1<nSeed)?seedU[i+1]:1;
    const s0=seedS[i], s1=(i+1<nSeed)?seedS[i+1]:seedS[0];
    if (s0===s1){ segments.push([s0,u0,u1]); continue; }
    const parts = [];
    const recurse = (loU,loS,hiU,hiS) => {
      if (loS===hiS){ parts.push([loS,loU,hiU]); return; }
      if ((hiU-loU)*pxPerU <= cutPx){
        const cut=(loU+hiU)/2;
        parts.push([loS,loU,cut]); parts.push([hiS,cut,hiU]);
        return;
      }
      const midU=(loU+hiU)/2, midS=testFn(Px(midU), Py(midU));
      recurse(loU,loS,midU,midS);
      recurse(midU,midS,hiU,hiS);
    };
    recurse(u0,s0,u1,s1);
    segments.push(...parts);
  }
  const merged = [];
  for (const seg of segments){
    const last = merged[merged.length-1];
    if (last && last[0]===seg[0] && Math.abs(last[2]-seg[1])<1e-9) last[2]=seg[2];
    else merged.push(seg.slice());
  }
  if (merged.length>1 && merged[0][0]===merged[merged.length-1][0] &&
      Math.abs(merged[merged.length-1][2]-1)<1e-9 && Math.abs(merged[0][1])<1e-9){
    merged[0][1] = merged[merged.length-1][1] - 1;   // extend first piece backward across the seam
    merged.pop();
  }
  return { merged, Px, Py };
}
// Shared by ground-texture and cast-texture: generates just enough
// concentric rings (spacing apart, from the given center) to reach the
// farthest screen corner, walks each with walkCircleSplit against
// whatever combined test function it's given, and returns the kept
// polylines. The two texture types differ only in what testFn does
// (ground: plane-projection then shadow test; cast: pickVisibleFace then
// shadow test) — ring generation and boundary refinement are identical,
// so this is the one place that logic lives rather than being duplicated
// per texture type.
export function buildPatternSegsFromTest(testFn, cx, cy, spacing, corners){
  let maxDist = 0;
  for (const [x,y] of corners) maxDist = Math.max(maxDist, Math.hypot(x-cx, y-cy));
  const nRings = Math.ceil(maxDist/spacing) + 1;
  const SEED_PX = 3.0, CUT_PX = 0.05;
  const pieces = [];
  for (let r=1; r<=nRings; r++){
    const radius = r*spacing;
    const testFnForRing = (px, py) => testFn(px, py, r);
    const { merged, Px, Py } = walkCircleSplit(cx, cy, radius, testFnForRing, SEED_PX, CUT_PX);
    const closed = merged.length === 1;   // no transition anywhere -> whole ring survived uncut
    for (const [state, u0, u1] of merged){
      if (!state) continue;
      const nSub = Math.max(2, Math.ceil((u1-u0)*2*Math.PI*radius / 2));
      const poly = [];
      for (let k=0; k<=nSub; k++){
        const u = u0 + (u1-u0)*k/nSub;
        poly.push(Px(u), Py(u));
      }
      pieces.push({ poly, ringIdx: r, closed, cx, cy, radius, u0, u1 });
    }
  }
  return pieces;
}

/* ================= Shading-buffer sampling =================
   Receiving side of the captured shading buffer (see captureShadingBuffer
   in viewport3d.js). flipBufferRowsY and sampleShading are now real,
   permanent infrastructure — Smooth Shading's Hatch and Circles (model-
   surface rings) density decisions are driven entirely by sampleShading's
   output (see generate() below and the buffer-driven code further down);
   the old analytic Phong+shadow-map hybrid these replaced has been fully
   removed after validation. testShadingSample (see the message dispatch)
   remains as a standalone round-trip check of the transfer/flip/sampling
   pipeline itself, independent of the real generation path. */
// WebGL readback is bottom-up; everything else in this file uses top-down
// screen coordinates (matching cam.w/cam.h — the same source
// captureShadingBuffer sizes its render target from, so no rescaling is
// needed here, just the row order). Flipped ONCE on receipt rather than
// baking a flip into every sampleShading call, so that function stays a
// plain, ordinary bilinear lookup.
export function flipBufferRowsY(buf, w, h){
  const rowFloats = w * 4;
  const tmp = new Float32Array(rowFloats);
  for (let y = 0; y < h >> 1; y++){
    const y2 = h - 1 - y;
    const o1 = y*rowFloats, o2 = y2*rowFloats;
    tmp.set(buf.subarray(o1, o1+rowFloats));
    buf.copyWithin(o1, o2, o2+rowFloats);
    buf.set(tmp, o2);
  }
}
// Bilinear-sampled lookup into a captured shading buffer — RGBA
// Float32Array, R=brightness (max(0,N·L)*shadowFactor from the real
// shadow-mapped GPU render), G=1 where actual geometry was rendered there
// (0 for background/no-geometry pixels). (sx,sy) are in the same
// screen-pixel space as everything else in this file (top-down, origin
// top-left) — clamped to the buffer's own edges rather than wrapping or
// erroring on out-of-range input.
export function sampleShading(buf, w, h, sx, sy){
  const x = Math.max(0, Math.min(w - 1, sx));
  const y = Math.max(0, Math.min(h - 1, sy));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const idx = (xi, yi) => (yi*w + xi) * 4;
  const ia = idx(x0,y0), ib = idx(x1,y0), ic = idx(x0,y1), id = idx(x1,y1);
  const w00 = (1-fx)*(1-fy), w10 = fx*(1-fy), w01 = (1-fx)*fy, w11 = fx*fy;
  const brightness = buf[ia]*w00 + buf[ib]*w10 + buf[ic]*w01 + buf[id]*w11;
  const geomWeight  = buf[ia+1]*w00 + buf[ib+1]*w10 + buf[ic+1]*w01 + buf[id+1]*w11;
  return { brightness, hasGeometry: geomWeight > 0.5 };
}
