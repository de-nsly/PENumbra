/* ================================================================
   worker/solver.js — HLR worker entry point
   Boots as a module worker (see main.js). Owns the message dispatcher
   (self.onmessage) and the core solve pipeline (generate,
   generateRawEdges, generateRawContourEdges), composing the mesh/parsing/
   geometry/dedup building blocks from the sibling modules below.
   ================================================================ */
import { parseSTL, parseOBJ, demoSoup } from './parsers.js';
import { M, buildMesh, computeCornerNormals } from './mesh.js';
import { intersectSegs, buildSegGrid, buildShadowMap, worldOnFace, buildPatternSegsFromTest, flipBufferRowsY, sampleShading } from './geom-utils.js';
import { MIN_SEG, pairJunctionArms, dedupCollinear, subtractCovered } from './dedup.js';
/* Occlusion depth bias. The bias has exactly two legitimate jobs: absorb
   floating-point noise, and keep a surface from occluding edges that lie ON
   that surface (crease/silhouette edges vs. their fan-neighbor faces, or
   coplanar boolean faces). A constant RELATIVE bias on the depth value fails
   both scale tests — in view units it grows linearly with camera distance, so
   a far camera (low FOV framing) swallows real world-scale depth separations
   and lets hidden edges bleed through. Instead the bias is per-occluder and
   slope-scaled: fp floor + ~1px worth of THAT occluder's own screen-space
   depth gradient. Grazing surfaces (the self-occlusion fights) get a large
   protective bias; face-on occluders get a near-zero one and correctly hide
   edges at any camera distance / FOV / projection. */
const EPS_FP_REL   = 1e-6;    // fp noise floor, relative to segment depth magnitude
const EPS_SLOPE_PX  = 1.0;    // px of occluder depth-gradient guarding the edge's OWN surface
const EPS_SLOPE_FAR = 0.005;  // token slope floor away from the edge's own neighborhood
// NOTE: no vertex-guard window. With exact g=0 boundary crossings, a
// vertex-sharing occluder's depth plane passes exactly through the shared
// vertex (g(0)=0 by construction), so it can only claim occlusion where it is
// genuinely in front — which is correct occlusion, not self-occlusion. The
// fp floor plus EPS_SLOPE_FAR absorb the numerical noise. (The old guard was
// a legacy of splitting boundaries at g=eps.)
const HATCH_CAP_DEFAULT = 320000;  // fallback default — see the Hatch cap slider for the user-facing control

function post(msg, transfer){ if (typeof self !== 'undefined' && self.postMessage) self.postMessage(msg, transfer || []); }

function generate(cam, S, shadingBuffer){
  if (!M){ post({ type:'error', msg:'No model loaded' }); return; }
  const t0ms = Date.now();
  const { view:V, proj:P, w:W, h:H, near } = cam;
  const ortho = !!cam.ortho;
  // The captured shading buffer (see viewport3d.js/panel-controls.js) is
  // size-checked against this generate's own W/H (the same source it was
  // captured at) as a cheap guard against a stale/resized-since-capture
  // buffer being silently misapplied.
  let shadingBuf = null;
  if (shadingBuffer && shadingBuffer.pixels &&
      shadingBuffer.w === W && shadingBuffer.h === H){
    flipBufferRowsY(shadingBuffer.pixels, W, H);
    shadingBuf = shadingBuffer;
  }
  // Smooth Shading's Hatch and Circles (model-surface rings) density
  // decisions are driven entirely by this captured buffer — the old
  // analytic Phong+shadow-map hybrid for smooth mode has been fully
  // removed after validation showed the buffer-driven approach was both
  // correct (it fixed a real bug the old approach had — a coarse gate
  // built on an imperfect shadow heuristic could silently exclude a
  // genuinely shadowed region before the real test ever ran) and faster.
  // Flat Shading is completely unaffected and never used any of this.
  // Circles' ground-shadow ring mode is also unaffected — it never went
  // through this either.
  const smoothH = !!S.smoothShading;
  const useShadingBuf = smoothH && !!shadingBuf;
  if (smoothH && !shadingBuf){
    // No fallback exists anymore — surfaced as an error rather than
    // silently producing no hatching/circles at all with no explanation.
    post({ type:'error', msg:'Smooth Shading needs a captured shading buffer for Hatch/Circles, but none arrived this generate.' });
  }
  // Automates a manual trick: with Soft shadows off, gatherSettings zeroes
  // every hatch/circles threshold (hatchThr, crossThr, deepThr, circlesThr),
  // which used to correctly disable just the ambient/gradient axis while
  // the old analytic hybrid's separate cast-shadow override stayed
  // independent of any threshold entirely. Now that one buffer sample
  // tests a single combined threshold, a genuinely zero threshold would
  // also silently disable Cast shadow's own hatching — so when Cast
  // shadows is on and Soft shadows is genuinely off (the explicit flag,
  // not inferred from thr===0, which would be ambiguous with a
  // deliberately low slider value), every pass uses a small fixed
  // threshold instead: only the darkest, truly-in-shadow areas qualify,
  // with no visible gradient — the exact look achieved before by manually
  // setting every "below" slider to 0.01, now automatic.
  const SHADOW_ONLY_THR = 0.01;
  const castOnly = !!(S.shadow && S.shadow.on) && !S.hatch.softShadowsOn;
  // depth key, affine in screen space, bigger = closer:
  //   perspective → 1/dist   ·   orthographic → view-space z (negative dist)
  const { nv, nt, tri } = M;
  let { pos, fn } = M;
  const nearZ = -near * 1.0001;

  /* 0.5 · Rotate-model panel — rotate a COPY of the vertex positions and
     face normals around M.center, once, before anything else runs. This is
     deliberately NOT done by folding the rotation into the view matrix V:
     that would only correctly affect the parts of the pipeline that go
     through the view-space cache built below (vx/vy/vz, the main silhouette
     geometry) — but the ground-shadow footprint and the per-face
     front/brightness test just below both read pos/fn DIRECTLY, in their
     own separate passes, and would silently keep using the un-rotated mesh
     if only V changed. Rotating pos/fn themselves, right here, means every
     one of those consumers (already written and tested against "pos/fn are
     the true, current mesh geometry") stays correct with no further changes
     anywhere else in this function — exactly as if the file had been loaded
     already rotated. Skipped entirely when the rotation is identity (the
     default, common case) to avoid the O(nv) cost on every generate().
  */
  const R = S.modelRot;
  if (R && (R[0]!==1||R[1]!==0||R[2]!==0||R[3]!==0||R[4]!==1||R[5]!==0||R[6]!==0||R[7]!==0||R[8]!==1)){
    // Cache: while the user orbits/zooms or tweaks pens with a rotation
    // active, the rotation itself usually hasn't changed between generates —
    // reuse the rotated copies instead of re-deriving O(nv+nt) every call.
    // Keyed on the mesh object identity (a new load invalidates it) plus the
    // 9 matrix values.
    const rc = M._rotCache;
    if (rc && rc.m.every((v,i)=>v===R[i])){
      pos = rc.pos; fn = rc.fn;
    } else {
      const cx=M.center[0], cy=M.center[1], cz=M.center[2];
      const rp = new Float32Array(pos.length);
      for (let i=0;i<nv;i++){
        const dx=pos[i*3]-cx, dy=pos[i*3+1]-cy, dz=pos[i*3+2]-cz;
        rp[i*3]   = cx + R[0]*dx + R[3]*dy + R[6]*dz;
        rp[i*3+1] = cy + R[1]*dx + R[4]*dy + R[7]*dz;
        rp[i*3+2] = cz + R[2]*dx + R[5]*dy + R[8]*dz;
      }
      const rf = new Float32Array(fn.length);
      for (let i=0;i<fn.length;i+=3){
        const nx=fn[i], ny=fn[i+1], nz=fn[i+2];
        rf[i]   = R[0]*nx + R[3]*ny + R[6]*nz;
        rf[i+1] = R[1]*nx + R[4]*ny + R[7]*nz;
        rf[i+2] = R[2]*nx + R[5]*ny + R[8]*nz;
      }
      M._rotCache = { m: Array.from(R), pos: rp, fn: rf };
      pos = rp; fn = rf;
    }
  }

  /* 1 · transform to view space, project to screen */
  const vx=new Float32Array(nv), vy=new Float32Array(nv), vz=new Float32Array(nv);
  const sx=new Float32Array(nv), sy=new Float32Array(nv), iz=new Float32Array(nv);
  const ok=new Uint8Array(nv);                       // vertex strictly in front of near plane
  for (let i=0;i<nv;i++){
    const x=pos[i*3], y=pos[i*3+1], z=pos[i*3+2];
    const a=V[0]*x+V[4]*y+V[8]*z+V[12], b=V[1]*x+V[5]*y+V[9]*z+V[13], c=V[2]*x+V[6]*y+V[10]*z+V[14];
    vx[i]=a; vy[i]=b; vz[i]=c;
    if (c < nearZ){
      const cx=P[0]*a+P[4]*b+P[8]*c+P[12], cy=P[1]*a+P[5]*b+P[9]*c+P[13],
            cw=P[3]*a+P[7]*b+P[11]*c+P[15];
      sx[i]=(cx/cw*0.5+0.5)*W; sy[i]=(0.5-cy/cw*0.5)*H; iz[i]=ortho?c:1/(-c); ok[i]=1;
    }
  }
  const projView = (a,b,c) => {                      // project arbitrary view-space point
    const cx=P[0]*a+P[4]*b+P[8]*c+P[12], cy=P[1]*a+P[5]*b+P[9]*c+P[13],
          cw=P[3]*a+P[7]*b+P[11]*c+P[15];
    return [(cx/cw*0.5+0.5)*W, (0.5-cy/cw*0.5)*H, ortho?c:1/(-c)];
  };

  /* 1.2 · zoom-independent line-matching tolerance for this view.
     dedupCollinear/subtractCovered use DEDUP_OFF_TOL/DEDUP_GAP_TOL to decide
     whether two independently-computed copies of "the same" edge (e.g. a
     front-pass vs back-pass silhouette/crease split) are actually the same
     line. That noise genuinely lives in WORLD space (mesh vertex precision,
     floating-point drift between code paths) — a fixed PIXEL tolerance only
     represented it correctly at whatever zoom level it happened to be tuned
     at. Under orthographic projection in particular, zooming in doesn't
     change the underlying world-space noise at all, but does directly
     multiply how many pixels it projects to, so a fixed pixel budget
     silently covers less and less of the real noise the more the user zooms
     in — until it stops covering it at all (this is the zoom-dependent
     hidden-crease bug). Fix: derive the tolerance from a WORLD-space noise
     floor and this view's actual current scale, so the EFFECTIVE (world)
     noise budget stays constant regardless of zoom.
     pxPerWorldUnit: orthographic is exact and depth-independent (same scale
     everywhere in the scene). Perspective genuinely varies with depth, so
     it's approximated using the model's own bounding-sphere center as a
     representative depth — reasonable since every edge being matched here
     belongs to the model itself. */
  let pxPerWorldUnit;
  if (ortho){
    pxPerWorldUnit = Math.abs(P[0]) * 0.5 * W;
  } else {
    const mcx=M.center[0], mcy=M.center[1], mcz=M.center[2];
    const mvz = V[2]*mcx+V[6]*mcy+V[10]*mcz+V[14];
    pxPerWorldUnit = Math.abs(P[0]) * 0.5 * W / Math.max(1e-6, -mvz);
  }
  // World-space noise budget, expressed as a fraction of the model's own
  // bounding-sphere radius (scale-invariant across model sizes). The actual
  // noise this is absorbing isn't purely vertex-weld precision — it also
  // picks up whatever the front/back occlusion split, edge-triangle
  // intersections, near-plane clipping etc. accumulate on top of that — so
  // 1.1e-3 is an empirically-tuned value (found by testing directly against
  // the zoom-dependent hidden-crease case), not a reuse of buildMesh's much
  // tighter weld tolerance. Converted to pixels at the CURRENT zoom, then
  // clamped to a wide sane range purely as a numerical safety net for
  // extreme cases (a huge model shrunk to a speck, or a tiny model zoomed in
  // enormously) — the clamp is a backstop, not the calibration.
  const worldNoiseFloor = M.radius * 1.1e-3;
  const clampPx = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // dedupOffMult/dedupGapMult (default 1) are the user-facing "Match
  // tolerance"/"Bridge gap" sliders — applied AFTER the auto/clamp math
  // below, purely as a final scale on top of each of the two base
  // tolerances, so the underlying zoom-independence this block exists for
  // is untouched; the user is only ever adjusting how generous THIS view's
  // already-correct base tolerance is. Gap is computed from the UNSCALED
  // base effOffTol (not the offset-scaled one) so it scales independently
  // of the offset multiplier. Match tolerance is halved before use — the
  // slider's default position (1) is meant to land on the 0.5 effective
  // scale found to work best, not on an unscaled 1:1. 0 is valid on both
  // (fully disables that tolerance) — only non-finite/negative values fall
  // back to the default.
  const dedupOffMult = Number.isFinite(S.dedupOffMult) && S.dedupOffMult >= 0 ? S.dedupOffMult : 1;
  const dedupGapMult = Number.isFinite(S.dedupGapMult) && S.dedupGapMult >= 0 ? S.dedupGapMult : 1;
  const baseOffTol = clampPx(worldNoiseFloor * pxPerWorldUnit, 0.03, 1.5);
  const baseGapTol = clampPx(baseOffTol * 2, 0.06, 3);
  const effOffTol = baseOffTol * (dedupOffMult / 2);
  const effGapTol = baseGapTol * dedupGapMult;

  /* 1.5 · analytic ground shadow (shadow-catcher plane, exact).
     The catcher plane is flat and horizontal, so its shadow region needs no
     sampling: it is EXACTLY the union of the model's triangles slid down the
     light rays onto the plane. We project every relevant triangle onto the
     plane and then to the screen once, keeping a flat list of 2D screen
     triangles plus the plane's screen-space depth equation (1/z is affine in
     screen space over a plane). The hatch stage clips each carrier against
     these triangles and unions the 1D intervals — exact shadow boundaries,
     zero shadow-map tests, no budget. The plane itself remains structurally
     invisible: no edges, no camera occlusion, no lit hatch.
     For watertight meshes the light-facing subset of triangles already covers
     the footprint; otherwise all triangles are used (their union is the exact
     footprint for ANY mesh, since every blocked ray passes through some
     triangle). GS stays null — disabling the feature — when the light is at or
     below the horizon (nothing can land on the plane) or when a projected
     point falls behind the camera's near plane (extreme perspective). */
  let GS = null;
  gshadow: if (S.ground && S.ground.on && S.hatch && (S.hatch.p1 || S.hatch.p2 || S.hatch.p3)){
    const L = S.light;
    if (L[1] <= 1e-6) break gshadow;                     // light at/below horizon
    const bb = M.bbox;
    // Ground level: the TRUE lowest point of the current (possibly rotated)
    // geometry, not an approximation. An earlier version rotated the 8
    // corners of the model's ORIGINAL, unrotated bbox and took the lowest —
    // that's the wrong operation: rotating a loose axis-aligned box's
    // corners gives the bounding box of the ROTATED BOX SHAPE, which is
    // generically larger/looser than the actual rotated mesh's true
    // footprint (the same reason AABBs get visibly "puffier" when rotated
    // in most game engines) — so the computed ground level came out too
    // low, leaving the model visibly floating above the catcher plane even
    // at 0% offset. `pos` is already the rotated vertex data by this point
    // (see the "0.5" step above), so the true minimum is just a direct
    // scan — exact, and no rotation math needed here at all anymore.
    let bbMinY = Infinity;
    for (let i=1; i<pos.length; i+=3) if (pos[i] < bbMinY) bbMinY = pos[i];
    const gy = bbMinY - (S.ground.off || 0) * M.radius;   // default: true rotated min-Y (Y-up)
    // plane depth equation from 3 reference points on the ground
    const rcx=(bb[0]+bb[3])/2, rcz=(bb[2]+bb[5])/2, rr=Math.max(M.radius, 1e-6);
    const refs=[[rcx,rcz],[rcx+rr,rcz],[rcx,rcz+rr]], rp=[];
    for (const [x,z] of refs){
      const a=V[0]*x+V[4]*gy+V[8]*z+V[12], b=V[1]*x+V[5]*gy+V[9]*z+V[13], c=V[2]*x+V[6]*gy+V[10]*z+V[14];
      if (c >= nearZ) break gshadow;
      rp.push(projView(a,b,c));
    }
    const r1x=rp[1][0]-rp[0][0], r1y=rp[1][1]-rp[0][1], r1z=rp[1][2]-rp[0][2];
    const r2x=rp[2][0]-rp[0][0], r2y=rp[2][1]-rp[0][1], r2z=rp[2][2]-rp[0][2];
    const rdet=r1x*r2y-r1y*r2x;
    if (Math.abs(rdet) < 1e-12) break gshadow;           // plane edge-on to camera
    const gA=(r1z*r2y-r2z*r1y)/rdet, gB=(r1x*r2z-r2x*r1z)/rdet, gC=rp[0][2]-gA*rp[0][0]-gB*rp[0][1];
    const st=[]; let bx0=1/0,by0=1/0,bx1=-1/0,by1=-1/0;
    const P=new Float64Array(6);
    for (let f=0; f<nt; f++){
      const i0=tri[f*3]*3, i1=tri[f*3+1]*3, i2=tri[f*3+2]*3;
      if (S.watertight){                                 // closed mesh: light-facing set suffices
        const ux=pos[i1]-pos[i0], uy=pos[i1+1]-pos[i0+1], uz=pos[i1+2]-pos[i0+2];
        const wx=pos[i2]-pos[i0], wy=pos[i2+1]-pos[i0+1], wz=pos[i2+2]-pos[i0+2];
        if ((uy*wz-uz*wy)*L[0] + (uz*wx-ux*wz)*L[1] + (ux*wy-uy*wx)*L[2] <= 0) continue;
      }
      const idx=[i0,i1,i2];
      for (let v=0; v<3; v++){
        const ii=idx[v];
        const t=Math.max(0, (pos[ii+1]-gy)/L[1]);        // slide down the light ray to the plane
        const x=pos[ii]-L[0]*t, z=pos[ii+2]-L[2]*t;
        const a=V[0]*x+V[4]*gy+V[8]*z+V[12], b=V[1]*x+V[5]*gy+V[9]*z+V[13], c=V[2]*x+V[6]*gy+V[10]*z+V[14];
        if (c >= nearZ) break gshadow;                   // shadow reaches behind camera — bail out
        const pr=projView(a,b,c);
        P[v*2]=pr[0]; P[v*2+1]=pr[1];
      }
      // zero-area slivers (triangle edge-on to the light) add nothing to the union
      if (Math.abs((P[2]-P[0])*(P[5]-P[1])-(P[3]-P[1])*(P[4]-P[0])) < 1e-9) continue;
      st.push(P[0],P[1],P[2],P[3],P[4],P[5]);
      for (let v=0;v<3;v++){
        const X=P[v*2], Y=P[v*2+1];
        if (X<bx0)bx0=X; if (X>bx1)bx1=X; if (Y<by0)by0=Y; if (Y>by1)by1=Y;
      }
    }
    if (!st.length) break gshadow;
    GS = { tris:Float64Array.from(st), tn:st.length/6,
           bx0:bx0-2, by0:by0-2, bx1:bx1+2, by1:by1+2, A:gA, B:gB, C:gC };
  }

  /* 2 · per-face facing + brightness (shared by culling, silhouettes, hatch) */
  const front=new Uint8Array(nt), bright=new Float32Array(nt);
  // At an orthographic view aligned exactly with an axis-aligned mesh's own
  // axis, many faces become simultaneously, mathematically EXACTLY edge-on
  // to the camera (nvz genuinely 0 in exact arithmetic) — a hard nvz>0 test
  // then classifies each one by whichever hair-thin (~1e-15) floating-point
  // sign its own chain of computation happened to produce, not by any real
  // geometric difference, so two equally-tied adjacent faces can land on
  // opposite sides purely by chance. Since front/back only ever matters
  // relative to a face's NEIGHBORS (isSilTopo below), that inconsistency —
  // not any single face's "wrong" answer — is what breaks silhouette
  // classification at exact axis views, for every mode built on it
  // (Contour included, since it uses this same array directly). A small
  // dead-zone, comfortably above float noise and comfortably below any
  // real angle worth distinguishing, makes every genuinely-tied face land
  // on the same side consistently instead.
  const EPS_FRONT_TIE = 1e-6;
  const Ll=Math.hypot(S.light[0],S.light[1],S.light[2])||1;
  const Lx=S.light[0]/Ll, Ly=S.light[1]/Ll, Lz=S.light[2]/Ll;
  for (let f=0; f<nt; f++){
    const nx=fn[f*3], ny=fn[f*3+1], nz=fn[f*3+2];
    const nvx=V[0]*nx+V[4]*ny+V[8]*nz, nvy=V[1]*nx+V[5]*ny+V[9]*nz, nvz=V[2]*nx+V[6]*ny+V[10]*nz;
    const a=tri[f*3], b=tri[f*3+1], c=tri[f*3+2];
    const cx=(vx[a]+vx[b]+vx[c])/3, cy=(vy[a]+vy[b]+vy[c])/3, cz=(vz[a]+vz[b]+vz[c])/3;
    // perspective: facing depends on the ray to the face (dot<0 = facing camera)
    // ortho: view ray is the constant forward (0,0,-1), so facing test is dot(n,(0,0,-1))<0 → nvz>0
    front[f] = ortho ? (nvz > EPS_FRONT_TIE ? 1 : 0) : ((nvx*cx + nvy*cy + nvz*cz) < 0 ? 1 : 0);
    bright[f] = Math.max(0, nx*Lx + ny*Ly + nz*Lz);
  }


  /* Shared cast-shadow occluder map — built at most ONCE per generate()
     call, reused by every consumer that needs it (Hatch's own shadow
     gating, the Circles pattern's model-surface ring set, and its
     ground-ring set), instead of each one calling buildShadowMap
     independently with the exact same arguments (pos, tri, fn, nt,
     S.light, S.watertight, a fixed radius-relative depth epsilon) and
     redundantly rebuilding an identical occluder grid up to 3x per
     generate. buildShadowMap is a pure function of these arguments — no
     external state, no side effects — so sharing one instance across all
     consumers is behaviorally identical to each building its own; it only
     removes the repeated work. Built whenever ANY consumer would have
     needed its own copy, matching the union of their individual trigger
     conditions exactly. */
  const needSharedShadowMap = (S.shadow && S.shadow.on) ||
    (S.circlesOn && S.ground && S.ground.on && Ly > 1e-6);
  const sharedShadowMap = needSharedShadowMap
    ? buildShadowMap(pos, tri, fn, nt, S.light, S.watertight, M.radius*2e-3)
    : null;

  /* 3 · occluder triangles (near-clipped, screen space) */
  const oc=[], ofc=[];                               // 9 floats/tri: x,y,iz ×3 · face id
  const pushOcc=(p0,p1,p2,f)=>{ oc.push(p0[0],p0[1],p0[2], p1[0],p1[1],p1[2], p2[0],p2[1],p2[2]); ofc.push(f); };
  for (let f=0; f<nt; f++){
    if (S.watertight && !front[f]) continue;
    const a=tri[f*3], b=tri[f*3+1], c=tri[f*3+2];
    const behind=(ok[a]?0:1)+(ok[b]?0:1)+(ok[c]?0:1);
    if (behind===3) continue;
    if (behind===0){ pushOcc([sx[a],sy[a],iz[a]],[sx[b],sy[b],iz[b]],[sx[c],sy[c],iz[c]],f); continue; }
    // Sutherland–Hodgman clip against z<=nearZ in view space, then fan
    const P3=[[vx[a],vy[a],vz[a]],[vx[b],vy[b],vz[b]],[vx[c],vy[c],vz[c]]], out=[];
    for (let i=0;i<3;i++){
      const p=P3[i], q=P3[(i+1)%3], pin=p[2]<=nearZ, qin=q[2]<=nearZ;
      if (pin) out.push(p);
      if (pin!==qin){
        const t=(nearZ-p[2])/(q[2]-p[2]);
        out.push([p[0]+t*(q[0]-p[0]), p[1]+t*(q[1]-p[1]), nearZ]);
      }
    }
    if (out.length<3) continue;
    const pr=out.map(p=>projView(p[0],p[1],p[2]));
    for (let k=2;k<pr.length;k++) pushOcc(pr[0],pr[k-1],pr[k],f);
  }
  const nOcc=ofc.length;

  /* 3.5 · per-occluder precomputation. Everything the occlusion inner loop
     needs that depends only on the occluder itself — bbox, closest depth,
     orientation sign, depth-plane coefficients, gradient, sliver
     classification and its 1-D edge basis — is a per-occluder constant, yet
     the old inner loop rebuilt all of it for EVERY segment × occluder pair
     (the single hottest code in generate()). Hoisted here: computed once per
     generate, stored in flat typed arrays for cache-friendly reads.
     oMaxZ additionally enables a conservative depth reject (below): an
     occluder whose CLOSEST point is at or behind a segment's FARTHEST point
     can never be in front of any part of it. */
  const ocp = Float64Array.from(oc);           // typed copy for the hot reads
  const oBx0=new Float64Array(nOcc), oBx1=new Float64Array(nOcc);
  const oBy0=new Float64Array(nOcc), oBy1=new Float64Array(nOcc);
  const oS=new Float64Array(nOcc);             // orientation sign of det
  const oA=new Float64Array(nOcc), oB=new Float64Array(nOcc), oC=new Float64Array(nOcc);
  const oGrad=new Float64Array(nOcc);          // |A|+|B| — screen depth gradient
  const oMaxZ=new Float64Array(nOcc);          // occluder's CLOSEST depth key
  const oSliver=new Uint8Array(nOcc);
  const oSpx=new Float64Array(nOcc), oSpy=new Float64Array(nOcc);  // sliver edge origin
  const oSex=new Float64Array(nOcc), oSey=new Float64Array(nOcc);  // sliver edge vector
  const oSpz=new Float64Array(nOcc), oSqz=new Float64Array(nOcc);  // sliver edge depths
  const oSeL=new Float64Array(nOcc);           // sliver edge length²
  const oSeps=new Float64Array(nOcc);          // sliver slope-eps term (pre-fpEps)
  const oSkip=new Uint8Array(nOcc);            // degenerate (|det| ~ 0): never tests
  for (let j=0;j<nOcc;j++){
    const o=j*9;
    const ax=ocp[o],ay=ocp[o+1],az=ocp[o+2], bx=ocp[o+3],by=ocp[o+4],bz=ocp[o+5],
          cx=ocp[o+6],cy2=ocp[o+7],cz=ocp[o+8];
    oBx0[j]=Math.min(ax,bx,cx); oBx1[j]=Math.max(ax,bx,cx);
    oBy0[j]=Math.min(ay,by,cy2); oBy1[j]=Math.max(ay,by,cy2);
    oMaxZ[j]=Math.max(az,bz,cz);
    const d1x=bx-ax,d1y=by-ay, d2x=cx-ax,d2y=cy2-ay;
    const det=d1x*d2y-d1y*d2x;
    if (Math.abs(det)<1e-9){ oSkip[j]=1; continue; }
    oS[j]=det>0?1:-1;
    const d1z=bz-az, d2z=cz-az;
    const A=(d1z*d2y-d2z*d1y)/det, B=(d1x*d2z-d2x*d1z)/det;
    oA[j]=A; oB[j]=B; oC[j]=az-A*ax-B*ay;
    oGrad[j]=Math.abs(A)+Math.abs(B);
    const lAB=d1x*d1x+d1y*d1y, lBC=(cx-bx)*(cx-bx)+(cy2-by)*(cy2-by), lCA=(ax-cx)*(ax-cx)+(ay-cy2)*(ay-cy2);
    const lMax=Math.max(lAB,lBC,lCA);
    if (lMax > 1e-12 && Math.abs(det)/Math.sqrt(lMax) < 1.0){
      oSliver[j]=1;
      let px2,py2,qx2,qy2,pz2,qz2;
      if (lMax===lAB){ px2=ax;py2=ay;pz2=az; qx2=bx;qy2=by;qz2=bz; }
      else if (lMax===lBC){ px2=bx;py2=by;pz2=bz; qx2=cx;qy2=cy2;qz2=cz; }
      else { px2=cx;py2=cy2;pz2=cz; qx2=ax;qy2=ay;qz2=az; }
      oSpx[j]=px2; oSpy[j]=py2; oSex[j]=qx2-px2; oSey[j]=qy2-py2;
      oSpz[j]=pz2; oSqz[j]=qz2; oSeL[j]=lMax;
      oSeps[j]=EPS_SLOPE_FAR*Math.abs(qz2-pz2)/Math.sqrt(lMax);
    }
  }

  /* 4 · uniform grid over occluder bboxes — CSR layout (one flat Int32Array
     of member indices + a start-offset array) instead of one JS array per
     cell: no per-cell allocation, contiguous iteration. cellMaxZ carries the
     closest depth of anything in each cell, so a whole cell of occluders can
     be rejected against a segment with one comparison. */
  const cell=Math.min(160, Math.max(8, Math.sqrt(W*H/Math.max(nOcc,1))*1.7));
  const gw=Math.max(1,Math.ceil(W/cell)), gh=Math.max(1,Math.ceil(H/cell));
  const cellX=x=>Math.min(gw-1,Math.max(0,Math.floor(x/cell)));
  const cellY=y=>Math.min(gh-1,Math.max(0,Math.floor(y/cell)));
  const cellCount=new Int32Array(gw*gh);
  for (let j=0;j<nOcc;j++){
    const cy0=cellY(oBy0[j]), cy1=cellY(oBy1[j]), cx0=cellX(oBx0[j]), cx1=cellX(oBx1[j]);
    for (let cyi=cy0;cyi<=cy1;cyi++) for (let cxi=cx0;cxi<=cx1;cxi++) cellCount[cyi*gw+cxi]++;
  }
  const cellStart=new Int32Array(gw*gh+1);
  for (let i=0;i<gw*gh;i++) cellStart[i+1]=cellStart[i]+cellCount[i];
  const cellItems=new Int32Array(cellStart[gw*gh]);
  const cellFill=cellStart.slice(0,gw*gh);
  const cellMaxZ=new Float64Array(gw*gh).fill(-Infinity);
  for (let j=0;j<nOcc;j++){
    const cy0=cellY(oBy0[j]), cy1=cellY(oBy1[j]), cx0=cellX(oBx0[j]), cx1=cellX(oBx1[j]);
    for (let cyi=cy0;cyi<=cy1;cyi++) for (let cxi=cx0;cxi<=cx1;cxi++){
      const ci=cyi*gw+cxi;
      cellItems[cellFill[ci]++]=j;
      if (oMaxZ[j]>cellMaxZ[ci]) cellMaxZ[ci]=oMaxZ[j];
    }
  }
  const stamp=new Int32Array(nOcc).fill(-1);
  let gen=0;

  /* 5 · segment occlusion: returns merged occluded t-intervals over [0,1] */
  const COMP = M.comp;
  const occIv=[];
  function occlude(x0,y0,z0,x1,y1,z1, skipA, skipB, skipShell, va, vb){
    occIv.length=0; gen++;
    const bx0=Math.min(x0,x1), bx1=Math.max(x0,x1), by0=Math.min(y0,y1), by1=Math.max(y0,y1);
    const fpEps=Math.abs(z0+z1)*0.5*EPS_FP_REL;
    // segment's FARTHEST depth key: an occluder (or a whole cell) whose
    // closest point is at or behind this can never be in front of any part
    // of the segment — g <= 0 <= eps everywhere, i.e. the exact case the
    // classification below discards, decided here with one comparison
    const segMinZ=Math.min(z0,z1);
    const dxs=x1-x0, dys=y1-y0, dzs=z1-z0;
    const slopeNear = va===undefined ? EPS_SLOPE_PX : EPS_SLOPE_FAR;
    for (let cyi=cellY(by0);cyi<=cellY(by1);cyi++)
      for (let cxi=cellX(bx0);cxi<=cellX(bx1);cxi++){
        const ci=cyi*gw+cxi;
        if (cellMaxZ[ci] <= segMinZ) continue;        // whole cell behind segment
        const cs0=cellStart[ci], cs1=cellStart[ci+1];
        for (let li=cs0;li<cs1;li++){
          const j=cellItems[li];
          if (stamp[j]===gen) continue;
          stamp[j]=gen;
          if (oSkip[j]) continue;                     // degenerate triangle
          if (oMaxZ[j] <= segMinZ) continue;          // occluder behind segment
          if (oBx1[j]<bx0 || oBx0[j]>bx1 || oBy1[j]<by0 || oBy0[j]>by1) continue;  // bbox reject
          const f=ofc[j];
          if (f===skipA||f===skipB) continue;
          if (skipShell!==undefined && COMP[f]===skipShell) continue;
          const o=j*9;
          const ax=ocp[o],ay=ocp[o+1], bx=ocp[o+3],by=ocp[o+4], cx=ocp[o+6],cy2=ocp[o+7];
          const s=oS[j];
          // parametric clip of segment to the triangle's 3 half-planes
          let ta=0, tb=1, alive=true;
          for (let e=0;e<3 && alive;e++){
            let px,py,qx,qy;
            if (e===0){px=ax;py=ay;qx=bx;qy=by;} else if (e===1){px=bx;py=by;qx=cx;qy=cy2;} else {px=cx;py=cy2;qx=ax;qy=ay;}
            const ex=qx-px, ey=qy-py;
            const fa=s*(ex*(y0-py)-ey*(x0-px));
            const fb=s*(ex*(y1-py)-ey*(x1-px));
            if (fa<0&&fb<0){ alive=false; break; }
            if (fa<0)      ta=Math.max(ta, fa/(fa-fb));
            else if (fb<0) tb=Math.min(tb, fa/(fa-fb));
          }
          if (!alive || tb-ta<1e-6) continue;
          // depth plane of triangle in (x, y, 1/z) space — precomputed
          const A=oA[j], B=oB[j], C=oC[j];
          // Per-occluder slope-scaled bias (see EPS_SLOPE_PX above). The full
          // guard is only owed to the edge's OWN local surface, and a
          // vertex-sharing occluder touches the edge exactly at the shared
          // ENDPOINT — so the protection is positional: full guard within a
          // ~1px window of the shared segment end, token floor elsewhere.
          // Unrelated occluders (and the far parts of related ones) can then
          // hide edges lying just behind them however razor-grazing they are
          // (sharp boolean pinch features).
          // Screen-thin sliver blockers: 2D altitude (area / longest edge)
          // under ~1px means the interpolated depth PLANE is ill-conditioned
          // across the thin direction — its slope bias would swallow
          // arbitrarily large real depth gaps. For those, model depth 1-D
          // along the sliver's dominant edge instead (well-conditioned), by
          // projecting the sample onto that edge and lerping its endpoint
          // depths. Both this and the plane give g linear in t, so the same
          // classification/crossing machinery applies. Sliver classification
          // and the edge basis are per-occluder constants — precomputed above.
          let g0, g1, eps;
          if (oSliver[j]){
            const px2=oSpx[j], py2=oSpy[j], ex2=oSex[j], ey2=oSey[j], eL2=oSeL[j];
            const pz2=oSpz[j], qz2=oSqz[j];
            const Xa=x0+dxs*ta, Ya=y0+dys*ta, Xb=x0+dxs*tb, Yb=y0+dys*tb;
            let ua=((Xa-px2)*ex2+(Ya-py2)*ey2)/eL2; ua=ua<0?0:(ua>1?1:ua);
            let ub=((Xb-px2)*ex2+(Yb-py2)*ey2)/eL2; ub=ub<0?0:(ub>1?1:ub);
            g0 = pz2+(qz2-pz2)*ua - (z0+dzs*ta);
            g1 = pz2+(qz2-pz2)*ub - (z0+dzs*tb);
            eps = fpEps + oSeps[j];
          } else {
            g0 = A*(x0+dxs*ta)+B*(y0+dys*ta)+C-(z0+dzs*ta);
            g1 = A*(x0+dxs*tb)+B*(y0+dys*tb)+C-(z0+dzs*tb);
            eps = fpEps + slopeNear*oGrad[j];
          }
          const gA2 = g0, gB2 = g1;
          // eps CLASSIFIES whether this occluder is genuinely in front anywhere;
          // the visible/hidden boundary itself is the exact g=0 crossing (the
          // occluder's true silhouette). Splitting at g=eps instead leaves a
          // systematic eps/slope-length stub of hidden edge at every junction.
          if (gA2<=eps && gB2<=eps) continue;                  // never meaningfully in front
          else if (gA2>0 && gB2>0) occIv.push(ta,tb);          // fully in front
          else {
            const tr=ta+(0-gA2)/(gB2-gA2)*(tb-ta);
            if (gA2>0) occIv.push(ta,tr); else occIv.push(tr,tb);
          }
        }
      }
    if (!occIv.length) return occIv;
    // sort & merge intervals
    const n=occIv.length/2, order=[];
    for (let i=0;i<n;i++) order.push(i);
    order.sort((a,b)=>occIv[a*2]-occIv[b*2]);
    const merged=[];
    let cs=occIv[order[0]*2], ce=occIv[order[0]*2+1];
    for (let i=1;i<n;i++){
      const s2=occIv[order[i]*2], e2=occIv[order[i]*2+1];
      if (s2<=ce+1e-6) ce=Math.max(ce,e2);
      else { merged.push(cs,ce); cs=s2; ce=e2; }
    }
    merged.push(cs,ce);
    // Denoise: absorb any INTERIOR visible/hidden piece shorter than MIN_SEG
    // into its neighbors. Depth-eps decisions right at split points can
    // otherwise produce sub-pixel visible↔hidden alternations — those pieces
    // get dropped by emit()'s minimum-length filter, cutting sub-pixel gaps
    // into otherwise closed loops (breaking the contour chain test) and
    // causing pointless pen up/downs on a real plotter.
    // Deliberately excludes the two END pieces (from t=0 to the first cut,
    // and from the last cut to t=1): a genuinely tiny piece bounded by CUTS
    // on BOTH sides is what indicates split-point noise (an in-and-
    // immediately-back-out blip); a tiny piece bounded by the segment's own
    // real endpoint on one side is just a real, short occlusion near that
    // tip (e.g. a baluster whose true overlap with a rail is only a sliver)
    // and must survive — absorbing it here was silently erasing real trims
    // whenever they happened to land close to an edge's own endpoint,
    // leaving that edge protruding past where it should have been clipped.
    // Representation: cuts strictly inside (0,1), pieces alternate starting
    // visible; removing an interior piece = removing its two bounding cuts.
    const segLen = Math.hypot(x1-x0, y1-y0);
    if (segLen > 1e-6){
      const minT = Math.min(0.49, MIN_SEG / segLen);
      let cuts = [];
      for (let i=0;i<merged.length;i+=2){
        if (merged[i]   > 1e-9)   cuts.push(merged[i]);
        if (merged[i+1] < 1-1e-9) cuts.push(merged[i+1]);
      }
      let startsHidden = merged.length && merged[0] <= 1e-9;
      for (let guard=cuts.length+2; guard>0 && cuts.length; guard--){
        // find shortest INTERIOR piece — p ranges over pieces with a cut on
        // both sides only (p=0 and p=cuts.length, the two end pieces, are
        // never eligible)
        let shortest=-1, shortLen=minT;
        for (let p=1;p<cuts.length;p++){
          const a=cuts[p-1], b=cuts[p];
          if (b-a < shortLen){ shortLen=b-a; shortest=p; }
        }
        if (shortest<0) break;
        cuts.splice(shortest-1, 2);
      }
      // rebuild hidden intervals from cuts + starting state
      merged.length = 0;
      let state = startsHidden, prev = 0;
      for (let ci=0; ci<=cuts.length; ci++){
        const end = (ci===cuts.length)?1:cuts[ci];
        if (state && end>prev) merged.push(prev, end);
        state=!state; prev=end;
      }
    }
    return merged;
  }

  /* 6 · candidate edges → visible / hidden segments */
  const groups={ sv:[], sh:[], cv:[], ch:[], h1:[], h2:[], h3:[], so:[], iv:[], ih:[] };
  // Contour (sv/sh) chain identity — Phase 3a, see PHASE3a-chain-identity.md.
  // One runId/seq entry per segment actually pushed to groups.sv/groups.sh,
  // parallel to those arrays: runId names which topological run (one
  // flushRun() call, below) a segment came from, seq its order within that
  // run. No other layer carries this — the exporter still rebuilds so/iv/ih
  // and cv/ch chains from coordinates/array-adjacency as before.
  const runIds = { sv:[], sh:[] };
  const seqs = { sv:[], sh:[] };
  // Diagnostic only (Phase 3a Step 4 — see PHASE3a-chain-identity.md): raw
  // per-run pixel length, one entry per genuine flushRun() below, captured
  // BEFORE dedupCollinear/subtractCovered can merge or drop any of them —
  // the "ceiling" the phase's measurement step compares the final path
  // count against. Read from devtools console as
  // lastGen.counts.contourRunLensSv / …Sh; not used by the pipeline itself.
  const contourRunLens = { sv:[], sh:[] };
  const hatchCarrier={ h1:[], h2:[], h3:[] };
  const counts={};
  const emit=(arr,x0,y0,x1,y1,tA,tB)=>{
    const ax=x0+(x1-x0)*tA, ay=y0+(y1-y0)*tA, bx=x0+(x1-x0)*tB, by=y0+(y1-y0)*tB;
    if ((bx-ax)*(bx-ax)+(by-ay)*(by-ay) < MIN_SEG*MIN_SEG) return false;
    arr.push(ax,ay,bx,by);
    return true;
  };

  const { ne, ea, eb, et0, et1, eang } = M;
  const wantC=S.types.c;

  const layerOn = S.layerOn || { so:false, iv:false, ih:false, sv:true, sh:false, cv:true, ch:false, h1:true, h2:true, h3:true };
  // Any silhouette-family layer wanting ink means a silhouette-classified
  // edge must be excluded from Crease topology ("silhouette wins overlaps",
  // same rule as before, just now covering all three silhouette layers
  // instead of only the old single Silhouette layer's visible+hidden pair).
  const wantS = !!(layerOn.so || layerOn.iv || layerOn.ih || layerOn.sv || layerOn.sh);

  /* 6.1 · Crease-chain topology (world-space, camera-independent — see the design
     spec). Built once here, before projection/occlusion, using the mesh's
     own vertex adjacency: two crease edges are connected iff they share a
     WELDED vertex index (`ea`/`eb` are exact integers, so this needs no
     screen-space tolerance at all). At a plain pass-through vertex (valence
     2) the two edges are unambiguously one chain. At a junction (valence 3+)
     `pairJunctionArms` decides which edges continue straight through, using
     world-space tangent directions so the decision is stable as the camera
     orbits — only the later occlusion-based visible/hidden cutting is
     camera-dependent. This intentionally mirrors the SAME `key==='c'`
     eligibility test the classification loop below uses (silhouette still
     wins overlaps at t1>=0; boundary/non-manifold edges fold in
     unconditionally at t1<0), so it only ever includes edges that would
     actually render as crease this call. */
  const isCreaseTopo = new Uint8Array(ne);
  // Only Contour draws a silhouette-classified edge at this same per-edge
  // granularity (its own topological chain walk includes every isSilTopo
  // edge unconditionally) — so it's the only layer Crease needs to
  // pre-emptively yield to here. Silhouette/Individual are built from
  // crossing-split sub-segments (different granularity, filtered by a
  // backdrop test) and are already safely removed from Crease's output by
  // the HIER/subtractCovered cascade further down; excluding on their
  // account here too would leave a genuine gap — neither Crease nor
  // Silhouette/Individual actually drawing that stretch — whenever Contour
  // itself is off.
  const wantContourPen = !!(layerOn.sv || layerOn.sh);
  for (let e=0;e<ne;e++){
    const t1x=et1[e];
    if (t1x>=0){
      if (wantContourPen && front[et0[e]]!==front[t1x]) continue;   // Contour wins overlaps
      if (wantC && eang[e]>=S.creaseDeg) isCreaseTopo[e]=1;
    } else if (wantC) isCreaseTopo[e]=1;
  }
  const ccCont0 = new Int32Array(ne).fill(-1);   // paired edge at this edge's ea[e] end
  const ccCont1 = new Int32Array(ne).fill(-1);   // paired edge at this edge's eb[e] end
  {
    const incident = new Map();                  // vertex → [[edge, end(0|1)], ...]
    for (let e=0;e<ne;e++){
      if (!isCreaseTopo[e]) continue;
      const a=ea[e], b=eb[e];
      if (a===b) continue;                        // degenerate edge, ignore
      let la=incident.get(a); if(!la){la=[];incident.set(a,la);} la.push([e,0]);
      let lb=incident.get(b); if(!lb){lb=[];incident.set(b,lb);} lb.push([e,1]);
    }
    for (const [v, list] of incident){
      if (list.length < 2) continue;              // valence 0/1: nothing to pair here
      if (list.length === 2){
        const [e0,end0]=list[0], [e1,end1]=list[1];
        if (end0===0) ccCont0[e0]=e1; else ccCont1[e0]=e1;
        if (end1===0) ccCont0[e1]=e0; else ccCont1[e1]=e0;
        continue;
      }
      const arms = list.map(([e,end]) => {
        const other = end===0 ? eb[e] : ea[e];
        const dx=pos[other*3]-pos[v*3], dy=pos[other*3+1]-pos[v*3+1], dz=pos[other*3+2]-pos[v*3+2];
        const L=Math.hypot(dx,dy,dz)||1;
        return [dx/L,dy/L,dz/L];
      });
      for (const [i,j] of pairJunctionArms(arms)){
        const [ei,endi]=list[i], [ej,endj]=list[j];
        if (endi===0) ccCont0[ei]=ej; else ccCont1[ei]=ej;
        if (endj===0) ccCont0[ej]=ei; else ccCont1[ej]=ei;
      }
    }
  }
  // decompose into disjoint open chains + cycles, each an ordered walk of
  // {e, rev} steps (rev = this edge is traversed eb[e]→ea[e], not ea[e]→eb[e])
  const ccChains = [];
  {
    const visited = new Uint8Array(ne);
    const walk = (startE, startRev) => {
      const edges=[]; let curE=startE, curRev=startRev;
      for(;;){
        edges.push({e:curE, rev:curRev});
        visited[curE]=1;
        const arriveV = curRev ? ea[curE] : eb[curE];
        const nextE = curRev ? ccCont0[curE] : ccCont1[curE];
        if (nextE===-1) return { edges, cycle:false };
        if (visited[nextE]) return { edges, cycle:(nextE===startE) };
        curRev = eb[nextE]===arriveV;   // arriving at eb[next] means we must walk it b→a
        curE = nextE;
      }
    };
    for (let e=0;e<ne;e++){
      if (!isCreaseTopo[e] || visited[e]) continue;
      if (ccCont0[e]===-1){ ccChains.push(walk(e,false)); continue; }
      if (ccCont1[e]===-1){ ccChains.push(walk(e,true));  continue; }
    }
    for (let e=0;e<ne;e++){                       // whatever's left must be pure cycles
      if (!isCreaseTopo[e] || visited[e]) continue;
      ccChains.push(walk(e,false));
    }
  }
  const ccX0=new Float32Array(ne), ccY0=new Float32Array(ne), ccZ0=new Float32Array(ne);
  const ccX1=new Float32Array(ne), ccY1=new Float32Array(ne), ccZ1=new Float32Array(ne);

  for (let e=0;e<ne;e++){
    if (!isCreaseTopo[e]) continue;
    const a=ea[e], b=eb[e];
    let X0,Y0,Z0,X1,Y1,Z1;
    if (ok[a]&&ok[b]){ X0=sx[a];Y0=sy[a];Z0=iz[a]; X1=sx[b];Y1=sy[b];Z1=iz[b]; }
    else {
      let pa=[vx[a],vy[a],vz[a]], pb=[vx[b],vy[b],vz[b]];
      if (pa[2]>nearZ && pb[2]>nearZ) continue;                  // fully behind camera
      const clip=(p,q)=>{ const t=(nearZ-p[2])/(q[2]-p[2]);
        return [p[0]+t*(q[0]-p[0]), p[1]+t*(q[1]-p[1]), nearZ]; };
      if (pa[2]>nearZ) pa=clip(pa,pb); else if (pb[2]>nearZ) pb=clip(pb,pa);
      const A2=projView(pa[0],pa[1],pa[2]), B2=projView(pb[0],pb[1],pb[2]);
      X0=A2[0];Y0=A2[1];Z0=A2[2]; X1=B2[0];Y1=B2[1];Z1=B2[2];
    }
    // deferred: this edge's projected coords are stashed here and walked in
    // chain order (with occlude() called per-edge exactly as before) right
    // after this loop, so topologically-continuous crease runs merge into
    // single polylines instead of one independent segment each
    ccX0[e]=X0; ccY0[e]=Y0; ccZ0[e]=Z0; ccX1[e]=X1; ccY1[e]=Y1; ccZ1[e]=Z1;
    if ((e & 511)===0) post({type:'progress', v: 0.05 + 0.45*e/ne});
  }

  /* 6.2 · emit crease chains — walks each chain from the topology pass above
     in geometric order, calling occlude() per edge exactly as the old
     per-edge path did, but concatenating consecutive same-state (visible or
     hidden) pieces ACROSS edge boundaries into one output polyline. A chain
     that's fully visible end-to-end becomes a single multi-point stroke
     instead of N separate ones; occlusion still splits it wherever the
     model genuinely hides part of it, same as before — this only removes
     the ARTIFICIAL splits that used to happen at every mesh-edge boundary
     regardless of visibility. `groups.cv`/`ch` still end up as flat
     [x0,y0,x1,y1,...] segment lists (unchanged shape), just pushed in
     chain-adjacency order, which is what lets the client's SVG builder
     recognize touching segments and merge them into one pen stroke. */
  for (const chain of ccChains){
    const pieces = [];                  // flat list of [state, [x0,y0], [x1,y1]], in walk order
    for (const {e:ei, rev} of chain.edges){
      const hid = occlude(ccX0[ei],ccY0[ei],ccZ0[ei],ccX1[ei],ccY1[ei],ccZ1[ei],
                           et0[ei], et1[ei], undefined, ea[ei], eb[ei]);
      const nat = [];                   // pieces in the edge's OWN ea→eb order
      let t=0;
      for (let i=0;i<hid.length;i+=2){
        if (hid[i]>t) nat.push(['v', t, hid[i]]);
        nat.push(['h', hid[i], hid[i+1]]);
        t=hid[i+1];
      }
      if (t<1) nat.push(['v', t, 1]);
      const walked = rev ? nat.slice().reverse().map(([st,a,b])=>[st,1-b,1-a]) : nat;
      for (const [st,s0,s1] of walked){
        const t0 = rev ? 1-s0 : s0, t1w = rev ? 1-s1 : s1;
        pieces.push([st,
          [ccX0[ei]+(ccX1[ei]-ccX0[ei])*t0, ccY0[ei]+(ccY1[ei]-ccY0[ei])*t0],
          [ccX0[ei]+(ccX1[ei]-ccX0[ei])*t1w, ccY0[ei]+(ccY1[ei]-ccY0[ei])*t1w]]);
      }
    }
    if (!pieces.length) continue;
    // a fully/partly-visible CYCLE was walked from an arbitrary start edge —
    // rotate to begin right after a genuine state change (if any exists) so
    // an arc that wraps across the arbitrary seam isn't cut into two pieces
    // purely because of where the walk happened to start
    let ordered = pieces;
    if (chain.cycle && pieces.length>1){
      let rotateAt=-1;
      for (let i=0;i<pieces.length;i++){
        const prev = pieces[(i-1+pieces.length)%pieces.length];
        if (pieces[i][0] !== prev[0]){ rotateAt=i; break; }
      }
      if (rotateAt>0) ordered = pieces.slice(rotateAt).concat(pieces.slice(0,rotateAt));
    }
    let curState=null, runPts=[];
    // Gated per sub-layer's own checkbox, same as Contour's sv/sh flush
    // below — cv/ch used to both fill unconditionally once wantC allowed
    // crease topology to be built at all (whichever of the two was on),
    // which meant a hidden-crease layer left off could still end up full
    // of frozen geometry in a saved Layout block. That's not just wasted
    // work: a block only ever stores POST-ink-avoidance geometry, so if
    // the user later re-enables that stale ch data on a block whose
    // Silhouette visibility they've since changed, it can't reflect
    // whatever Silhouette would have clipped away — it's either
    // accidentally still right or silently wrong, with no way to tell.
    // Not computing it when off removes that trap entirely.
    const flushRun = () => {
      if (runPts.length>=2){
        const arr = curState==='v' ? (layerOn.cv ? groups.cv : null) : (layerOn.ch ? groups.ch : null);
        if (arr) for (let i=0;i+1<runPts.length;i++)
          emit(arr, runPts[i][0],runPts[i][1], runPts[i+1][0],runPts[i+1][1], 0, 1);
      }
      runPts=[];
    };
    for (const [st,p0,p1] of ordered){
      if (st!==curState){ flushRun(); curState=st; runPts=[p0]; }
      runPts.push(p1);
    }
    flushRun();
  }

  /* ================================================================
     6.3 · Contour (Blender: silhouette_filtering = NONE) — chains
     silhouette-classified edges via actual mesh-vertex-index adjacency —
     the exact same mechanism ccChains/pairJunctionArms above already gives
     Crease — instead of reconstructing connectivity from screen-space
     coordinates after the fact (which is what the geometry-fill approach
     this replaced did, and was the root cause of the near-miss/T-junction
     bugs investigated separately; see project notes). Walking each chain
     once and calling occlude() per edge, in chain order, with no self-
     shell exclusion and no coverage/fill merge pass, is exactly Blender's
     Contour: standard occlusion, nothing more. Silhouette and Silhouette
     individual (both need an additional per-point backdrop test) are
     built on top of this same chain set further below. */
  function buildContourTopology(){
    const isSilTopo = new Uint8Array(ne);
    for (let e=0;e<ne;e++){
      const t1x=et1[e];
      if (t1x>=0){
        if (front[et0[e]]!==front[t1x]) isSilTopo[e]=1;
      } else {
        isSilTopo[e]=1;   // open/non-manifold edge — always a contour, no front/back test possible (matches Blender)
      }
    }
    const siCont0 = new Int32Array(ne).fill(-1), siCont1 = new Int32Array(ne).fill(-1);
    {
      const incident = new Map();
      for (let e=0;e<ne;e++){
        if (!isSilTopo[e]) continue;
        const a=ea[e], b=eb[e];
        if (a===b) continue;
        let la=incident.get(a); if(!la){la=[];incident.set(a,la);} la.push([e,0]);
        let lb=incident.get(b); if(!lb){lb=[];incident.set(b,lb);} lb.push([e,1]);
      }
      for (const [v, list] of incident){
        if (list.length < 2) continue;
        if (list.length === 2){
          const [e0,end0]=list[0], [e1,end1]=list[1];
          if (end0===0) siCont0[e0]=e1; else siCont1[e0]=e1;
          if (end1===0) siCont0[e1]=e0; else siCont1[e1]=e0;
          continue;
        }
        const arms = list.map(([e,end]) => {
          const other = end===0 ? eb[e] : ea[e];
          const dx=pos[other*3]-pos[v*3], dy=pos[other*3+1]-pos[v*3+1], dz=pos[other*3+2]-pos[v*3+2];
          const L=Math.hypot(dx,dy,dz)||1;
          return [dx/L,dy/L,dz/L];
        });
        for (const [i,j] of pairJunctionArms(arms)){
          const [ei,endi]=list[i], [ej,endj]=list[j];
          if (endi===0) siCont0[ei]=ej; else siCont1[ei]=ej;
          if (endj===0) siCont0[ej]=ei; else siCont1[ej]=ei;
        }
      }
    }
    const siChains = [];
    {
      const visited = new Uint8Array(ne);
      const walk = (startE, startRev) => {
        const edges=[]; let curE=startE, curRev=startRev;
        for(;;){
          edges.push({e:curE, rev:curRev});
          visited[curE]=1;
          const arriveV = curRev ? ea[curE] : eb[curE];
          const nextE = curRev ? siCont0[curE] : siCont1[curE];
          if (nextE===-1) return { edges, cycle:false };
          if (visited[nextE]) return { edges, cycle:(nextE===startE) };
          curRev = eb[nextE]===arriveV;
          curE = nextE;
        }
      };
      for (let e=0;e<ne;e++){
        if (!isSilTopo[e] || visited[e]) continue;
        if (siCont0[e]===-1){ siChains.push(walk(e,false)); continue; }
        if (siCont1[e]===-1){ siChains.push(walk(e,true));  continue; }
      }
      for (let e=0;e<ne;e++){
        if (!isSilTopo[e] || visited[e]) continue;
        siChains.push(walk(e,false));
      }
    }
    // segment records — one per silhouette-topology edge, ready to also host
    // non-edge (face-interior) segments in a future phase; see comment above.
    // csX0/Y0/Z0 and csX1/Y1/Z1 keep the edge's OWN ea→eb direction (never
    // normalised to chain-walk direction — that direction now lives in
    // chainRev below, exactly where `rev` lived in the old edge-indexed walk).
    let nCS = 0;
    const edgeToSeg = new Int32Array(ne).fill(-1);
    for (let e=0;e<ne;e++) if (isSilTopo[e]) edgeToSeg[e] = nCS++;
    const csX0=new Float32Array(nCS), csY0=new Float32Array(nCS), csZ0=new Float32Array(nCS);
    const csX1=new Float32Array(nCS), csY1=new Float32Array(nCS), csZ1=new Float32Array(nCS);
    const csFaceA=new Int32Array(nCS), csFaceB=new Int32Array(nCS);
    const csShell=new Int32Array(nCS);
    const csEdge=new Int32Array(nCS);
    const csValid=new Uint8Array(nCS);   // 6.4 needs to know which segments actually got projected
    for (let e=0;e<ne;e++){
      if (!isSilTopo[e]) continue;
      const i = edgeToSeg[e];
      csEdge[i]=e; csFaceA[i]=et0[e]; csFaceB[i]=et1[e]; csShell[i]=COMP[et0[e]];
      const a=ea[e], b=eb[e];
      let X0,Y0,Z0,X1,Y1,Z1;
      if (ok[a]&&ok[b]){ X0=sx[a];Y0=sy[a];Z0=iz[a]; X1=sx[b];Y1=sy[b];Z1=iz[b]; }
      else {
        let pa=[vx[a],vy[a],vz[a]], pb=[vx[b],vy[b],vz[b]];
        if (pa[2]>nearZ && pb[2]>nearZ) continue;
        const clip=(p,q)=>{ const t=(nearZ-p[2])/(q[2]-p[2]);
          return [p[0]+t*(q[0]-p[0]), p[1]+t*(q[1]-p[1]), nearZ]; };
        if (pa[2]>nearZ) pa=clip(pa,pb); else if (pb[2]>nearZ) pb=clip(pb,pa);
        const A2=projView(pa[0],pa[1],pa[2]), B2=projView(pb[0],pb[1],pb[2]);
        X0=A2[0];Y0=A2[1];Z0=A2[2]; X1=B2[0];Y1=B2[1];Z1=B2[2];
      }
      csX0[i]=X0; csY0[i]=Y0; csZ0[i]=Z0; csX1[i]=X1; csY1[i]=Y1; csZ1[i]=Z1;
      csValid[i]=1;
    }
    // chains, CSR over segment indices — same chain/segment order as the walk
    // above, just relabeled from edge index to segment index via edgeToSeg.
    const chainStart = new Int32Array(siChains.length + 1);
    let chainSegTotal = 0;
    for (const c of siChains) chainSegTotal += c.edges.length;
    const chainSeg = new Int32Array(chainSegTotal);
    const chainRev = new Uint8Array(chainSegTotal);
    const chainClosed = new Uint8Array(siChains.length);
    {
      let p = 0;
      for (let ci=0; ci<siChains.length; ci++){
        const c = siChains[ci];
        chainStart[ci] = p;
        for (const {e, rev} of c.edges){ chainSeg[p]=edgeToSeg[e]; chainRev[p]=rev?1:0; p++; }
        chainClosed[ci] = c.cycle ? 1 : 0;
      }
      chainStart[siChains.length] = p;
    }
    return { siChains, nCS,
             csX0, csY0, csZ0, csX1, csY1, csZ1,
             csFaceA, csFaceB, csShell, csEdge, csValid,
             chainStart, chainSeg, chainRev, chainClosed };
  }
  const topo = buildContourTopology();
  // Phase 3b (see PHASE3b-contour-run-identity.md) — Step 2+3: decompose
  // each chain into its TRUE occlusion runs — one occlude() call per whole
  // mesh edge (never per crossing-split sub-segment — occlude()'s own
  // interior-noise denoise only protects a single call's own t=0/1
  // boundary, and calling it more finely measurably increases spurious
  // fragmentation), concatenated across the chain exactly as before, then
  // grouped into maximal same-visibility runs. Each run gets a PERMANENT
  // id right here, from a counter shared across every siChain (never reset
  // per-chain, so two runs can never collide even when their endpoints
  // happen to coincide on screen). Nothing downstream may ever reassign or
  // re-infer this identity — the crossing-split/backdrop-depth test below
  // (Step 4, inside the widened Silhouette guard) and the drop application
  // (Step 5/6, right after it) can only ever SUBTRACT from a run's own
  // geometry, never split its identity into two or merge two into one.
  function buildContourRuns(topo){
    const { siChains, csX0, csY0, csZ0, csX1, csY1, csZ1,
            csFaceA, csFaceB, csEdge,
            chainStart, chainSeg, chainRev, chainClosed } = topo;
    let contourRunSeq = 0;
    const contourRuns = [];
    if (layerOn.sv || layerOn.sh) for (let ci=0; ci<siChains.length; ci++){
      const segStart = chainStart[ci], segEnd = chainStart[ci+1], cycle = !!chainClosed[ci];
      const pieces = [];
      for (let p=segStart; p<segEnd; p++){
        const seg = chainSeg[p], rev = !!chainRev[p];
        const e = csEdge[seg];
        const hid = occlude(csX0[seg],csY0[seg],csZ0[seg],csX1[seg],csY1[seg],csZ1[seg],
                             csFaceA[seg], csFaceB[seg], undefined, ea[e], eb[e]);
        const nat = [];
        let t=0;
        for (let i=0;i<hid.length;i+=2){
          if (hid[i]>t) nat.push(['v', t, hid[i]]);
          nat.push(['h', hid[i], hid[i+1]]);
          t=hid[i+1];
        }
        if (t<1) nat.push(['v', t, 1]);
        const walked = rev ? nat.slice().reverse().map(([st,a,b])=>[st,1-b,1-a]) : nat;
        for (const [st,s0,s1] of walked){
          const t0 = rev ? 1-s0 : s0, t1w = rev ? 1-s1 : s1;
          // seg/tEdge0/tEdge1 (the edge's OWN csX0→csX1 parametrization, same
          // basis Silhouette's siCuts uses below) ride along with each piece
          // so Step 5 can later locate a drop interval within it — p0/p1 are
          // exactly the points at tEdge0/tEdge1 respectively, by construction
          // of the interpolation just below.
          pieces.push({ st, seg, tEdge0: t0, tEdge1: t1w,
            p0: [csX0[seg]+(csX1[seg]-csX0[seg])*t0, csY0[seg]+(csY1[seg]-csY0[seg])*t0],
            p1: [csX0[seg]+(csX1[seg]-csX0[seg])*t1w, csY0[seg]+(csY1[seg]-csY0[seg])*t1w] });
        }
      }
      if (!pieces.length) continue;
      // group consecutive same-state pieces into runs — plain grouping, no
      // identity assigned yet
      const runs = [];
      for (const piece of pieces){
        const last = runs.length ? runs[runs.length-1] : null;
        if (last && last.st === piece.st) last.pieces.push(piece);
        else runs.push({ st: piece.st, pieces: [piece] });
      }
      // close the chain's own cycle seam here, immediately: if cycle and the
      // first/last run share a state, they're the same physical run split
      // only by the walk's arbitrary start point. No drops exist yet at this
      // stage, so this merge is always a plain touching-endpoint join.
      if (cycle && runs.length>1 && runs[0].st === runs[runs.length-1].st){
        const lastRun = runs.pop();
        runs[0].pieces = lastRun.pieces.concat(runs[0].pieces);
      }
      // A run with no true endpoint at all — the whole cycle is one
      // unbroken same-visibility loop — only when the chain is itself a
      // cycle AND collapsed to exactly one run above.
      const isClosedLoop = cycle && runs.length===1;
      for (const run of runs) run.id = contourRunSeq++;
      for (let ri=0; ri<runs.length; ri++){
        const run = runs[ri];
        run.isClosedLoop = isClosedLoop;
        // Adjacent run (always the OPPOSITE state, by construction — Step
        // 2/3 only ever starts a new run on a state change) in ORIGINAL
        // chain-walk order. Consumed downstream by js/svg-export.js's
        // mergeContourRunSplits: when this run itself turns out to be
        // (almost) entirely artifact and Step 4/5 drops all of it, its two
        // flanking runs — otherwise permanently different run.ids — get
        // bridged back together using exactly this adjacency. -1 = no
        // neighbor (a true open-chain end, or — for a single-run closed
        // loop wrapping to itself — deliberately excluded downstream via a
        // prevId===nextId check, since there's nothing external to bridge).
        run.prevId = ri>0 ? runs[ri-1].id : (cycle ? runs[runs.length-1].id : -1);
        run.nextId = ri<runs.length-1 ? runs[ri+1].id : (cycle ? runs[0].id : -1);
        let rl=0; for (const pc of run.pieces) rl += Math.hypot(pc.p1[0]-pc.p0[0], pc.p1[1]-pc.p0[1]);
        (run.st==='v' ? contourRunLens.sv : contourRunLens.sh).push(rl);
        contourRuns.push(run);
      }
    }
    // DIAGNOSTIC (temporary, at user's request) — full snapshot of every
    // Step 2/3 run's own point sequence, BEFORE Step 4 (crossing-split +
    // backdrop test) ever touches it. Read from devtools console (main
    // thread, after Generate) as:
    //   console.table(lastGen.counts.dbgStep23.map(r=>({id:r.id,st:r.st,closed:r.closed,npts:r.pts.length/2})))
    // or dump one run's raw points as lastGen.counts.dbgStep23[i].pts.
    counts.dbgStep23 = contourRuns.map(run => {
      const pts = [];
      for (const pc of run.pieces){
        if (!pts.length) pts.push(pc.p0[0], pc.p0[1]);
        pts.push(pc.p1[0], pc.p1[1]);
      }
      return { id: run.id, st: run.st, closed: run.isClosedLoop, pts };
    });
    return contourRuns;
  }
  const contourRuns = buildContourRuns(topo);

  // Shared by ground-shadow and cast-shadow texture (further below): a
  // point-in-triangle coverage/nearest-face lookup against the same
  // occluder grid occlude() uses. coverPoint is a plain yes/no "is some
  // front-facing triangle of this shell (or, if shell is null, ANY shell)
  // here at all" test — stops at the first hit, fine for a pure coverage
  // question. pickVisibleFace additionally finds the NEAREST such triangle
  // by interpolated depth and resolves its 3D world position, since cast
  // shadow's receiving surface is arbitrary model geometry (unlike ground,
  // which can always answer "where does this point land" by formula).
  const coverPoint = (px,py,shell) => {
    const ci = cellY(py)*gw + cellX(px);
    for (let li=cellStart[ci]; li<cellStart[ci+1]; li++){
      const j=cellItems[li], f=ofc[j];
      if (!front[f]) continue;
      if (shell!==null && COMP[f]!==shell) continue;
      const o=j*9;
      const ax=ocp[o],ay=ocp[o+1],bx=ocp[o+3],by=ocp[o+4],cx=ocp[o+6],cy2=ocp[o+7];
      const d=(bx-ax)*(cy2-ay)-(by-ay)*(cx-ax);
      if (Math.abs(d)<1e-9) continue;
      const s2=d>0?1:-1;
      if (s2*((bx-ax)*(py-ay)-(by-ay)*(px-ax)) < -1e-7) continue;
      if (s2*((cx-bx)*(py-by)-(cy2-by)*(px-bx)) < -1e-7) continue;
      if (s2*((ax-cx)*(py-cy2)-(ay-cy2)*(px-cx)) < -1e-7) continue;
      return true;
    }
    return false;
  };
  const pickVisibleFace = (px, py) => {
    const ci = cellY(py)*gw + cellX(px);
    let bestF = -1, bestIz = -Infinity, bestW0 = 0, bestW1 = 0, bestW2 = 0;
    for (let li=cellStart[ci]; li<cellStart[ci+1]; li++){
      const j=cellItems[li], f=ofc[j];
      if (!front[f]) continue;
      const o=j*9;
      const ax=ocp[o],ay=ocp[o+1],az=ocp[o+2], bx=ocp[o+3],by=ocp[o+4],bz=ocp[o+5], cx=ocp[o+6],cy2=ocp[o+7],cz=ocp[o+8];
      const d=(bx-ax)*(cy2-ay)-(by-ay)*(cx-ax);
      if (Math.abs(d)<1e-9) continue;
      const s2=d>0?1:-1;
      if (s2*((bx-ax)*(py-ay)-(by-ay)*(px-ax)) < -1e-7) continue;
      if (s2*((cx-bx)*(py-by)-(cy2-by)*(px-bx)) < -1e-7) continue;
      if (s2*((ax-cx)*(py-cy2)-(ay-cy2)*(px-cx)) < -1e-7) continue;
      const w0 = ((bx-px)*(cy2-py)-(by-py)*(cx-px)) / d;
      const w1 = ((cx-px)*(ay-py)-(cy2-py)*(ax-px)) / d;
      const w2 = 1 - w0 - w1;
      const pointIz = w0*az + w1*bz + w2*cz;
      if (pointIz > bestIz){ bestIz = pointIz; bestF = f; bestW0 = w0; bestW1 = w1; bestW2 = w2; }
    }
    if (bestF < 0) return null;
    const w = worldOnFace(bestF, px, py, tri, pos, sx, sy, iz, ortho);
    if (!w) return null;
    return { f: bestF, x: w[0], y: w[1], z: w[2], w0: bestW0, w1: bestW1, w2: bestW2 };
  };

  /* ================================================================
     6.4 · Shared silhouette-family machinery — the topological chain set
     of 6.3 above, split at every screen-space crossing, plus the
     depth-aware backdrop query. Read by BOTH consumers below: 6.5 Contour
     cleanup and 6.7 Silhouette. Sits outside either one's guard so neither
     has to be nested inside the other's scope to reach it — which is what
     used to force Contour's backdrop test to run inside the Silhouette
     block while its own emit ran after it, with the shared state hoisted
     between them.
     ================================================================ */
  function buildSilhouetteSplits(topo){
    const { nCS, csValid, csX0, csY0, csX1, csY1, csShell } = topo;
    // pickBackdropFaceWithDepth (Phase 3b — see PHASE3b-contour-run-identity.md
    // Step 1): same nearest-other-front-facing-triangle query Silhouette
    // always used, factored to also return the matched triangle's
    // interpolated depth — needed by Contour's own drop rule below, which
    // Silhouette itself has no use for. Pure refactor: pickBackdropFace stays
    // a one-line wrapper, zero behavior change for Silhouette's own calls.
    const pickBackdropFaceWithDepth = (px, py, skipA, skipB) => {
      const ci = cellY(py)*gw + cellX(px);
      let bestF = -1, bestIz = -Infinity;
      for (let li=cellStart[ci]; li<cellStart[ci+1]; li++){
        const j=cellItems[li], f=ofc[j];
        if (!front[f]) continue;
        if (f===skipA || f===skipB) continue;
        const o=j*9;
        const ax=ocp[o],ay=ocp[o+1],az=ocp[o+2], bx=ocp[o+3],by=ocp[o+4],bz=ocp[o+5], cx=ocp[o+6],cy2=ocp[o+7],cz=ocp[o+8];
        const d=(bx-ax)*(cy2-ay)-(by-ay)*(cx-ax);
        if (Math.abs(d)<1e-9) continue;
        const s2=d>0?1:-1;
        if (s2*((bx-ax)*(py-ay)-(by-ay)*(px-ax)) < -1e-7) continue;
        if (s2*((cx-bx)*(py-by)-(cy2-by)*(px-bx)) < -1e-7) continue;
        if (s2*((ax-cx)*(py-cy2)-(ay-cy2)*(px-cx)) < -1e-7) continue;
        const w0 = ((bx-px)*(cy2-py)-(by-py)*(cx-px)) / d;
        const w1 = ((cx-px)*(ay-py)-(cy2-py)*(ax-px)) / d;
        const w2 = 1 - w0 - w1;
        const pointIz = w0*az + w1*bz + w2*cz;
        if (pointIz > bestIz){ bestIz = pointIz; bestF = f; }
      }
      return { f: bestF, iz: bestIz };   // f=-1 = nothing behind (open background)
    };
    const pickBackdropFace = (px, py, skipA, skipB) => pickBackdropFaceWithDepth(px, py, skipA, skipB).f;

    const siList = [];      // compact list of the valid segment indices 6.3 projected
    const siFlat = [];      // parallel flat [x0,y0,x1,y1,...] for buildSegGrid
    if (wantS) for (let seg=0;seg<nCS;seg++){
      if (!csValid[seg]) continue;
      siList.push(seg);
      siFlat.push(csX0[seg], csY0[seg], csX1[seg], csY1[seg]);
    }
    const siShellOfIdx = siList.map(seg => csShell[seg]);
    const siCuts = siList.map((seg) => [ {t:0, x:csX0[seg], y:csY0[seg]}, {t:1, x:csX1[seg], y:csY1[seg]} ]);
    if (siList.length && siList.length <= 60000){
      const siSplitGrid = buildSegGrid(siFlat);
      for (let idx=0; idx<siList.length; idx++){
        const seg = siList[idx];
        const x0=csX0[seg], y0=csY0[seg], x1=csX1[seg], y1=csY1[seg];
        siSplitGrid.query(x0,y0,x1,y1, jdx => {
          if (jdx <= idx) return;               // each crossing pair handled once, from the lower index
          const seg2 = siList[jdx];
          const hit = intersectSegs(x0,y0,x1,y1, csX0[seg2],csY0[seg2],csX1[seg2],csY1[seg2]);
          if (!hit) return;
          // ONE shared point, computed from idx's own line, consumed by BOTH sides
          const X = x0 + (x1-x0)*hit.t, Y = y0 + (y1-y0)*hit.t;
          siCuts[idx].push({t: hit.t, x:X, y:Y});
          siCuts[jdx].push({t: hit.u, x:X, y:Y});
        });
      }
    }
    return { siList, siShellOfIdx, siCuts, pickBackdropFace, pickBackdropFaceWithDepth };
  }
  const splits = buildSilhouetteSplits(topo);

  /* 6.5 · Contour cleanup (Phase 3b Step 4 — see the block comment inside).
     Returns the per-segment drop-interval table 6.6 consumes; writes its own
     diagnostics to counts. Reads 6.4's shared splits, never 6.7 Silhouette. */
  function buildContourDrops(topo, splits){
    const { nCS, csX0, csY0, csZ0, csX1, csY1, csZ1,
            csFaceA, csFaceB, csEdge } = topo;
    const { siList, siShellOfIdx, siCuts, pickBackdropFaceWithDepth } = splits;
    // Phase 3b Step 4's output — drop [t0,t1] intervals per segment, in the
    // edge's own csX0→csX1 parametrization (the same basis Step 2/3's
    // tEdge0/tEdge1 already use, so Step 5 can apply a drop to a run's pieces
    // with no re-projection). Allocated only when Contour actually draws;
    // every consumer below tests it rather than the layer flags directly.
    const contourDrops = (layerOn.sv || layerOn.sh) ? new Array(nCS) : null;
    // World-space depth-similarity tolerance, as a fraction of the model's
    // own bounding-sphere radius — same convention as worldNoiseFloor above
    // (dedup's own world-scale tolerance). Replaces an earlier version that
    // scaled with the point's own iz (1/dist for perspective) directly:
    // that has the WRONG power of distance. A fixed real-world depth gap
    // between two surfaces produces an iz-difference that shrinks as
    // 1/dist² (derivative of 1/dist), but a threshold scaled by edgeIz
    // itself only shrinks as 1/dist — so at typical framing distances the
    // threshold ends up relatively too wide compared to the true gap,
    // swallowing real folds (e.g. a letterform's bowl passing close to its
    // own stem) that only re-separate correctly once the camera moves close
    // enough that the quadratic real gap catches back up. Comparing in
    // actual world-space depth (converting iz back to view-space z for
    // perspective) removes the distance-dependence entirely. Tunable, not
    // final.
    //
    // Exposed as a user-facing control ("Contour cleanup", Lines section)
    // rather than kept as a fixed constant, because no single value serves
    // every model: measured across the test set, most models want somewhere in
    // 0.022–0.050, while faceted 3D text needs 0.0225 at most before real folds
    // (a letterform's bowl passing close to its own stem) start being swallowed.
    // That leaves a ~2% window where one constant technically satisfies all of
    // them — too narrow to be worth defending, and the judgment involved ("is
    // this line desirable ink on paper") is genuinely per-model rather than
    // geometric. 0.022 is the default: the bottom of the common range, and just
    // inside the text case's ceiling.
    const CONTOUR_DEPTH_SIMILAR_FRAC_WORLD =
      (Number.isFinite(S.contourCleanup) && S.contourCleanup >= 0) ? S.contourCleanup : 0.022;
    // DEBUG kill-switch (Debug panel) — skips the whole test, so contourDrops
    // stays allocated but empty and Step 5/6 run their normal path over zero
    // drops. Distinct from simply setting Contour cleanup to 0, which still
    // runs every decision and can still drop on an exactly-coincident backdrop.
    // The discriminator for "is Step 4 even the thing removing this geometry":
    // if a contour is still missing with this on, the cause is upstream
    // (occlude()/Step 2/3), not Step 4's backdrop test.
    const step4Off = !!S.debugNoStep4;
    // DIAGNOSTIC — one record per same-shell decision Step 4 actually makes,
    // KEPT ones included (a keep that only just cleared the threshold is
    // exactly as informative as a drop when hunting for a value that works
    // across models). Capped so a dense model can't balloon the posted result.
    const dbg4 = [];
    const DBG4_CAP = 4000;

    /* Phase 3b Step 4 (see PHASE3b-contour-run-identity.md) — Contour's own
       crossing-split + backdrop-depth test, purely SUBTRACTIVE: never touches
       occlude(), never decides visible/hidden, only ever produces drop
       [t0,t1] intervals per segment — in the edge's own csX0→csX1
       parametrization, the exact same basis Step 2/3's tEdge0/tEdge1 already
       use, so applying a drop to a run's pieces below needs no re-projection.
       Reads the shared silhouette-family machinery built above (siList,
       siShellOfIdx, siCuts, pickBackdropFaceWithDepth) — no separate
       crossing-split computation for Contour, and no dependency on 6.7
       Silhouette's own back-end, which now runs after this. */
    const r4 = v => Number.isFinite(v) ? +v.toFixed(4) : v;
    if (contourDrops && !step4Off) for (let idx=0; idx<siList.length; idx++){
      const seg = siList[idx];
      const shell = siShellOfIdx[idx];
      const e = csEdge[seg];
      const cuts = siCuts[idx].slice().sort((a,b)=>a.t-b.t);
      // outward-nudge direction — identical to buildEdgePieces' own block
      // above (same OUTWARD_EPS, same reference-face/third-vertex sign
      // resolution).
      const OUTWARD_EPS = 0.01;
      let ox=0, oy=0;
      {
        const ex = csX1[seg]-csX0[seg], ey = csY1[seg]-csY0[seg];
        const elen = Math.hypot(ex,ey) || 1;
        let nx = -ey/elen, ny = ex/elen;
        const refFace = (csFaceB[seg]<0 || front[csFaceA[seg]]) ? csFaceA[seg] : csFaceB[seg];
        const va=tri[refFace*3], vb=tri[refFace*3+1], vc=tri[refFace*3+2];
        const tv = (va!==ea[e] && va!==eb[e]) ? va : (vb!==ea[e] && vb!==eb[e]) ? vb : vc;
        const emx=(csX0[seg]+csX1[seg])/2, emy=(csY0[seg]+csY1[seg])/2;
        const tvx = sx[tv]-emx, tvy = sy[tv]-emy;
        if (nx*tvx + ny*tvy > 0){ nx=-nx; ny=-ny; }
        ox=nx*OUTWARD_EPS; oy=ny*OUTWARD_EPS;
      }
      let drops = null;
      for (let k=0; k+1<cuts.length; k++){
        const ca=cuts[k], cb=cuts[k+1];
        if (cb.t - ca.t < 1e-6) continue;
        const tm = (ca.t+cb.t)/2;
        const mx = csX0[seg]+(csX1[seg]-csX0[seg])*tm, my = csY0[seg]+(csY1[seg]-csY0[seg])*tm;
        const back = pickBackdropFaceWithDepth(mx+ox, my+oy, csFaceA[seg], csFaceB[seg]);
        // no backdrop, or a backdrop belonging to a different shell — always
        // keep (open background, or a genuine boundary against another
        // object — exactly Silhouette's own "always keep" cases)
        if (back.f < 0 || COMP[back.f] !== shell) continue;
        // same shell — ambiguous, resolved by comparing the outward
        // backdrop's depth against THIS point's own interpolated depth:
        // near-identical means the "backdrop" is really this same local
        // surface (artifact, drop); a real gap means a genuine fold (keep)
        const edgeIz = csZ0[seg] + (csZ1[seg]-csZ0[seg])*tm;
        // Undo the 1/dist warp before comparing — see CONTOUR_DEPTH_SIMILAR_FRAC_WORLD
        // above. Perspective iz is 1/dist, so the world gap between two depths
        // is |Δiz| / (izEdge·izBack) EXACTLY; /edgeIz² is only that expression's
        // first-order approximation about edgeIz, and the error is not
        // cosmetic — it's largest precisely where the gap is largest. A
        // genuinely distant backdrop has back.iz well below edgeIz, so edgeIz²
        // over-states the denominator and UNDER-states the real gap, biasing
        // the test toward calling a real fold "similar" and dropping it. Ortho's
        // iz is already linear view-space z, so no correction needed there.
        const dIz = Math.abs(back.iz - edgeIz);
        let realGapWorld;
        if (ortho) realGapWorld = dIz;
        else {
          // Both are 1/dist for points in front of the camera, hence positive;
          // a non-positive product can only come from degenerate/clipped input,
          // where "these two depths are near-identical" is not a claim worth
          // making — fall through as a keep.
          const denom = edgeIz * back.iz;
          realGapWorld = denom > 1e-12 ? dIz/denom : Infinity;
        }
        const thresh = M.radius * CONTOUR_DEPTH_SIMILAR_FRAC_WORLD;
        const dropIt = realGapWorld < thresh;
        if (dbg4.length < DBG4_CAP) dbg4.push({
          seg, edge: e, shell,
          t0: r4(ca.t), t1: r4(cb.t),
          x: r4(mx), y: r4(my),
          edgeDist: r4(ortho ? -edgeIz : (edgeIz>1e-12 ? 1/edgeIz : Infinity)),
          backDist: r4(ortho ? -back.iz : (back.iz>1e-12 ? 1/back.iz : Infinity)),
          gapWorld: r4(realGapWorld), thresh: r4(thresh),
          // < 1 dropped, >= 1 kept. The single most useful column: sort by it
          // to read off what threshold THIS model would actually have needed.
          ratio: r4(realGapWorld/thresh),
          drop: dropIt,
        });
        if (!dropIt) continue;
        if (!drops) drops = [];
        drops.push(ca.t, cb.t);
      }
      if (drops) contourDrops[seg] = drops;
    }
    // DIAGNOSTIC (temporary, at user's request) — every segment Step 4 found
    // at least one drop interval on (edge's own csX0→csX1 t parametrization,
    // same basis dbgStep23's pts don't use but tEdge0/tEdge1 on each Step 2/3
    // piece do). Read from devtools console as:
    //   console.table(lastGen.counts.dbgStep4)
    // dbgStep4Detail is the per-decision companion (drops AND keeps, see dbg4
    // above) — the one to read when asking "what threshold would this model
    // have needed":
    //   const d = lastGen.counts.dbgStep4Detail;
    //   console.table(d.filter(r=>r.drop).sort((a,b)=>b.ratio-a.ratio).slice(0,40))  // closest calls that DID drop
    //   console.table(d.filter(r=>!r.drop).sort((a,b)=>a.ratio-b.ratio).slice(0,40)) // closest calls that survived
    if (contourDrops){
      const dbg = [];
      for (let seg=0; seg<nCS; seg++) if (contourDrops[seg]) dbg.push({ seg, edge: csEdge[seg], drops: contourDrops[seg].slice() });
      counts.dbgStep4 = dbg;
      counts.dbgStep4Detail = dbg4;
      counts.dbgStep4Off = step4Off;
      counts.dbgStep4Frac = CONTOUR_DEPTH_SIMILAR_FRAC_WORLD;
      counts.dbgStep4Truncated = dbg4.length >= DBG4_CAP;
    }
    return contourDrops;
  }
  const contourDrops = buildContourDrops(topo, splits);

  /* 6.6 · Contour emit (Phase 3b Step 5+6) — subtract Step 4's drops from each run's own
     geometry (never losing or reassigning run.id, only ever splitting its
     point sequence), absorb whatever sub-MIN_SEG slivers that splitting
     leaves behind (mirroring occlude()'s own denoise, but scoped to
     WHATEVER remains after splitting — Step 5's drops are themselves never
     length-filtered, they're identified artifacts, not noise), then emit —
     bridging any surviving gap with a direct connector, exactly the Phase
     3a flushRun convention (push the resuming fragment's own start point,
     then continue; the emitted segment between two flat-array-adjacent
     points IS the bridge, real touch or not). */
  function emitContourRuns(contourRuns, contourDrops){
    if (contourDrops) for (const run of contourRuns){
      // Step 5: split each piece against contourDrops[seg] (if any), into an
      // ordered fragment list — 'keep' fragments carry a running point list,
      // 'drop' fragments carry no data at all (their length is never tested,
      // only their presence as a separator matters). Adjacent same-type
      // fragments are merged as they're produced, so the list always
      // strictly alternates once built.
      const frags = [];
      const pushFrag = (frag) => {
        const last = frags.length ? frags[frags.length-1] : null;
        if (last && last.type === frag.type){
          if (frag.type === 'keep') last.pts.push(...frag.pts.slice(1));
          return;
        }
        frags.push(frag);
      };
      for (const pc of run.pieces){
        const drops = contourDrops[pc.seg];
        if (!drops){ pushFrag({ type:'keep', pts:[pc.p0, pc.p1] }); continue; }
        const denom = pc.tEdge1 - pc.tEdge0;
        const subs = [];   // [s0,s1] in [0,1] along p0→p1
        for (let i=0;i+1<drops.length;i+=2){
          let s0 = (drops[i]-pc.tEdge0)/denom, s1 = (drops[i+1]-pc.tEdge0)/denom;
          if (s0>s1){ const tmp=s0; s0=s1; s1=tmp; }
          s0 = Math.max(0, s0); s1 = Math.min(1, s1);
          if (s1 - s0 > 1e-9) subs.push([s0,s1]);
        }
        if (!subs.length){ pushFrag({ type:'keep', pts:[pc.p0, pc.p1] }); continue; }
        subs.sort((a,b)=>a[0]-b[0]);
        const pointAt = (s) => [ pc.p0[0]+(pc.p1[0]-pc.p0[0])*s, pc.p0[1]+(pc.p1[1]-pc.p0[1])*s ];
        let cur = 0;
        for (const [s0,s1] of subs){
          if (s0 > cur + 1e-9) pushFrag({ type:'keep', pts:[pointAt(cur), pointAt(s0)] });
          pushFrag({ type:'drop' });
          cur = s1;
        }
        if (cur < 1 - 1e-9) pushFrag({ type:'keep', pts:[pointAt(cur), pointAt(1)] });
      }
      if (!frags.length) continue;
      let frags2 = frags, closed = run.isClosedLoop;
      // closed loop: fold the wraparound seam BEFORE absorption (same
      // reasoning as Step 2/3's own seam-close) so the absorption pass below
      // never has to reason about the array boundary as anything other than
      // an ordinary adjacency.
      if (closed && frags2.length>1 && frags2[0].type===frags2[frags2.length-1].type){
        const lastF = frags2[frags2.length-1];
        frags2 = frags2.slice(0, frags2.length-1);
        if (lastF.type==='keep') frags2[0] = { type:'keep', pts: lastF.pts.concat(frags2[0].pts.slice(1)) };
      }
      for (const f of frags2) if (f.type==='keep'){
        let l=0; for (let i=1;i<f.pts.length;i++) l+=Math.hypot(f.pts[i][0]-f.pts[i-1][0], f.pts[i][1]-f.pts[i-1][1]);
        f.len = l;
      }
      // Absorb interior keep fragments shorter than MIN_SEG into their
      // surrounding drop. Protect the two true endpoints of an open run from
      // ever being absorbed away; a closed loop has none, so every fragment
      // — including the wrap-around seam — is eligible.
      for (let guard=frags2.length+2; guard>0 && frags2.length>1; guard--){
        let shortest=-1, shortLen=MIN_SEG;
        for (let i=0;i<frags2.length;i++){
          if (frags2[i].type!=='keep') continue;
          if (!closed && (i===0 || i===frags2.length-1)) continue;
          if (frags2[i].len < shortLen){ shortLen=frags2[i].len; shortest=i; }
        }
        if (shortest<0) break;
        if (shortest>0 && shortest<frags2.length-1){
          frags2.splice(shortest-1, 3, { type:'drop' });
        } else if (shortest===0){
          // wrap-around: merges frags2[last] + frags2[0] + frags2[1]
          frags2 = [{ type:'drop' }, ...frags2.slice(2, frags2.length-1)];
        } else {
          // wrap-around: merges frags2[last-1] + frags2[last] + frags2[0]
          frags2 = [{ type:'drop' }, ...frags2.slice(1, frags2.length-2)];
        }
      }
      // Step 6 emit: flat-concatenate every surviving keep fragment's own
      // points, in order — consecutive points from different fragments are
      // exactly the "direct connector" bridge across whatever was dropped
      // between them.
      const outPts = [];
      for (const f of frags2) if (f.type==='keep') outPts.push(...f.pts);
      // Recorded independent of layerOn.sv/sh below — this is "did Step 4/5
      // actually eliminate this run's own material," the thing
      // js/svg-export.js's mergeContourRunSplits needs to tell a genuine
      // artifact apart from a run that simply isn't being drawn because its
      // OWN layer checkbox is off (which says nothing about whether real
      // occlusion put real content there — bridging across that would paper
      // over a real, deliberate hidden-line gap with a false straight line).
      run.hasContent = outPts.length>=2;
      if (!run.hasContent) continue;
      const isV = run.st==='v';
      const arr = isV ? (layerOn.sv ? groups.sv : null) : (layerOn.sh ? groups.sh : null);
      if (!arr) continue;
      const runArr = isV ? runIds.sv : runIds.sh;
      const seqArr = isV ? seqs.sv : seqs.sh;
      // Every consecutive pair is pushed directly, deliberately bypassing
      // emit()'s own MIN_SEG filter. That filter exists to stop a genuinely
      // isolated, too-short 2-point piece from becoming a spurious
      // standalone dot — the right call for Silhouette/Crease's independent
      // per-edge pieces, each of which really does stand alone. outPts is
      // not that: it's already one continuous, Step-5-absorbed point
      // sequence for this ONE run (the absorption pass above is what
      // removes genuinely-too-short interior material — a survivor here is
      // real geometry). A pair measuring under MIN_SEG here is just two
      // adjacent points on a fine curve, not noise; filtering it used to
      // silently sever the run's own continuity into two separately-chained
      // polylines sharing one run.id, with a gap smaller than MIN_SEG but
      // larger than chainByRun's own 0.02px touch tolerance — invisible to
      // both that and mergeContourRunSplits (which only ever looks at
      // DIFFERENT run.ids). Only a literal duplicate point (exactly zero
      // length) is skipped — that's not a short segment, it's nothing.
      let seq = 0;
      for (let i=0;i+1<outPts.length;i++){
        const ax=outPts[i][0], ay=outPts[i][1], bx=outPts[i+1][0], by=outPts[i+1][1];
        if (ax===bx && ay===by) continue;
        arr.push(ax,ay,bx,by);
        runArr.push(run.id); seqArr.push(seq++);
      }
    }
    // Run-adjacency table (id/state/prevId/nextId/hasContent for EVERY run,
    // whether or not it's actually being drawn) — posted AFTER Step 5/6 so
    // hasContent reflects what Step 4/5 actually did, not whether the
    // layer's own on/off checkbox happened to be set. See js/svg-export.js's
    // mergeContourRunSplits, the actual consumer of this.
    counts.contourAdjacency = contourRuns.map(run => ({
      id: run.id, st: run.st, prevId: run.prevId, nextId: run.nextId, hasContent: !!run.hasContent
    }));
  }
  emitContourRuns(contourRuns, contourDrops);

  /* ================================================================
     6.7 · Silhouette / Silhouette individual (Blender: silhouette_filtering
     = GROUP / INDIVIDUAL) — crossing-split + depth-aware backdrop filter,
     built on top of the same topological chain set Contour uses above.

     1) Every topological edge gets split wherever it crosses ANOTHER
        topological edge in screen space. Each crossing is computed ONCE
        (from the lower-indexed edge's own line) and that SAME (x,y) is
        recorded as the cut point for BOTH edges — never two independently-
        derived coordinates for what's meant to be one point (the root
        cause of an earlier near-miss/T-junction investigation).
     2) Each resulting sub-segment is classified by ONE depth-aware query
        at its midpoint: the nearest front-facing triangle at that screen
        point, excluding the edge's own two adjacent faces (pickBackdropFace).
        Silhouette individual drops a sub-segment only when that backdrop
        belongs to the SAME shell (self-occlusion) — with only one shell in
        the scene this degenerately empties out, since Silhouette above
        already covers the identical geometry and the cross-layer clip
        below removes the duplicate. Silhouette drops it whenever ANY
        backdrop is found at all — matching Blender's GROUP/INDIVIDUAL
        filter table exactly. Silhouette has no hidden-line variant (never
        meaningfully "occluded", only "backdropped" — matching the old
        Scene Outline's own behavior); Silhouette individual does. */
  function emitSilhouetteChains(topo, splits){
    const { siChains, nCS, csX0, csY0, csZ0, csX1, csY1, csZ1,
            csFaceA, csFaceB, csEdge,
            chainStart, chainSeg, chainRev, chainClosed } = topo;
    const { siList, siShellOfIdx, siCuts, pickBackdropFace } = splits;
    const idxOfSeg = new Int32Array(nCS).fill(-1);
    for (let idx=0; idx<siList.length; idx++) idxOfSeg[siList[idx]] = idx;
    const lerp2 = (ca,cb,t) => [ca.x+(cb.x-ca.x)*t, ca.y+(cb.y-ca.y)*t];
    // Builds ONE edge's ordered piece-or-break list (in the edge's own ea→eb
    // direction). A "break" is an explicit backdrop-drop (self-occlusion) —
    // a genuine discontinuity, never denoised away. Everything else is a
    // 'v'/'h' piece from the standard occlude() pass on that sub-segment.
    // Crucially, pieces from ADJACENT sub-segments (and adjacent edges, via
    // the chain walk below) get concatenated into one continuous sequence
    // BEFORE any state-run flushing happens — so a genuinely tiny hidden
    // sliver that happens to fall near a crossing-cut boundary is exactly as
    // denoisable as one that falls in the middle of a single mesh edge,
    // instead of being artificially protected just because it's at the edge
    // of what this section's own splitting invented. (Calling occlude()+emit()
    // independently per cut sub-segment loses that continuity: each call's
    // own denoise pass correctly protects ITS OWN t=0/1 boundary from being
    // merged away per the earlier occlude() fix, but a crossing-cut boundary
    // isn't a real chain endpoint, so a truly microscopic occlusion sliver
    // right there would end up preserved as a genuine cut and then dropped
    // by emit()'s length filter anyway — a real, if tiny, gap invisible
    // until zoomed in.)
    function buildEdgePieces(seg, wantIndividual){
      const idx = idxOfSeg[seg];
      const shell = siShellOfIdx[idx];
      const e = csEdge[seg];
      // Both modes now split at EVERY crossing, same-shell or not (previously
      // Individual only split at same-shell crossings, leaving cross-shell
      // occlusion boundaries — e.g. where one torus disappears behind another
      // — to whatever point occlude()'s own per-triangle depth test happened
      // to land on, independently of where the occluder's OWN silhouette line
      // actually is). A cross-shell crossing is exactly where this edge meets
      // the occluding shell's silhouette in screen space, computed via the
      // same shared-point technique used elsewhere in this pipeline (one
      // crossing, computed once, consumed by both sides) — so bounding the
      // occlude() call tightly to that point means the resulting piece is
      // already split exactly at the true boundary in the ordinary case,
      // rather than leaving occlude() to locate its own transition somewhere
      // across a much longer, unbounded stretch using a triangle-faceted
      // approximation of the occluder's curved surface (which is where the
      // per-instance over/undershoot was actually coming from).
      const cuts = siCuts[idx].slice().sort((a,b)=>a.t-b.t);
      // Backdrop-test sample point offset, OUTWARD (away from this edge's own
      // solid material) rather than exactly on the edge. Sampling exactly on
      // the edge can't tell "there's a real hole here, so of course something
      // else is visible behind it" apart from "this happens to be a solid,
      // symmetric shape whose own far side coincidentally projects to this
      // exact same line" — a real hole's far side occupies the whole outward
      // neighborhood, not just the boundary line itself, so nudging the
      // sample point outward still finds it correctly; a coincidental
      // alignment only ever lined up along that one exact line and stops
      // matching as soon as the sample leaves it. Value chosen well below
      // this pipeline's other small-distance thresholds (MIN_SEG=0.3px,
      // DEDUP_OFF_TOL=0.15px default) so it can't be mistaken for a real
      // geometric feature, while staying astronomically larger than any
      // floating-point noise at typical screen-space coordinate magnitudes.
      const OUTWARD_EPS = 0.01;
      let ox=0, oy=0;
      {
        const ex = csX1[seg]-csX0[seg], ey = csY1[seg]-csY0[seg];
        const elen = Math.hypot(ex,ey) || 1;
        let nx = -ey/elen, ny = ex/elen;
        const refFace = (csFaceB[seg]<0 || front[csFaceA[seg]]) ? csFaceA[seg] : csFaceB[seg];
        const va=tri[refFace*3], vb=tri[refFace*3+1], vc=tri[refFace*3+2];
        const tv = (va!==ea[e] && va!==eb[e]) ? va : (vb!==ea[e] && vb!==eb[e]) ? vb : vc;
        const emx=(csX0[seg]+csX1[seg])/2, emy=(csY0[seg]+csY1[seg])/2;
        const tvx = sx[tv]-emx, tvy = sy[tv]-emy;
        // nx,ny should point AWAY from the material — if it currently points
        // toward the reference face's own third vertex (into the material), flip it
        if (nx*tvx + ny*tvy > 0){ nx=-nx; ny=-ny; }
        ox=nx*OUTWARD_EPS; oy=ny*OUTWARD_EPS;
      }
      const out = [];
      for (let k=0; k+1<cuts.length; k++){
        const ca=cuts[k], cb=cuts[k+1];
        if (cb.t - ca.t < 1e-6) continue;
        const tm = (ca.t+cb.t)/2;
        const mx = csX0[seg]+(csX1[seg]-csX0[seg])*tm, my = csY0[seg]+(csY1[seg]-csY0[seg])*tm;
        const backF = pickBackdropFace(mx+ox, my+oy, csFaceA[seg], csFaceB[seg]);
        const dropSelf = backF>=0 && COMP[backF]===shell;
        const keep = wantIndividual ? !dropSelf : backF<0;
        if (!keep){ out.push({brk:true}); continue; }
        const sz0 = csZ0[seg]+(csZ1[seg]-csZ0[seg])*ca.t, sz1 = csZ0[seg]+(csZ1[seg]-csZ0[seg])*cb.t;
        const hid = occlude(ca.x,ca.y,sz0, cb.x,cb.y,sz1, csFaceA[seg], csFaceB[seg], undefined, ea[e], eb[e]);
        let t=0;
        for (let i=0;i<hid.length;i+=2){
          if (hid[i]>t) out.push({st:'v', p0:lerp2(ca,cb,t), p1:lerp2(ca,cb,hid[i])});
          out.push({st:'h', p0:lerp2(ca,cb,hid[i]), p1:lerp2(ca,cb,hid[i+1])});
          t=hid[i+1];
        }
        if (t<1) out.push({st:'v', p0:lerp2(ca,cb,t), p1:lerp2(ca,cb,1)});
      }
      return out;
    }
    const wantedModes = [];
    if (layerOn.iv || layerOn.ih) wantedModes.push(true);    // Silhouette individual
    if (layerOn.so) wantedModes.push(false);                 // Silhouette
    for (const wantIndividual of wantedModes){
      for (let ci=0; ci<siChains.length; ci++){
        const segStart = chainStart[ci], segEnd = chainStart[ci+1], cycle = !!chainClosed[ci];
        // full chain walk, concatenating every segment's pieces (respecting
        // rev) into one continuous sequence before any flushing happens
        let pieces = [];
        for (let pi=segStart; pi<segEnd; pi++){
          const seg = chainSeg[pi], rev = !!chainRev[pi];
          if (idxOfSeg[seg] < 0) continue;   // shouldn't happen, but stay defensive
          const edgePieces = buildEdgePieces(seg, wantIndividual);
          const walked = rev
            ? edgePieces.slice().reverse().map(p => p.brk ? p : { st:p.st, p0:p.p1, p1:p.p0 })
            : edgePieces;
          pieces = pieces.concat(walked);
        }
        if (!pieces.length) continue;
        // For a fully-kept cycle (no backdrop-drop breaks at all), rotate to
        // start right after a genuine state change — same reasoning as
        // Crease/Contour above — so the arbitrary walk-start seam never
        // artificially splits one continuous run into two.
        const hasBreak = pieces.some(p => p.brk);
        if (cycle && !hasBreak && pieces.length>1){
          let rotateAt=-1;
          for (let i=0;i<pieces.length;i++){
            const prev = pieces[(i-1+pieces.length)%pieces.length];
            if (pieces[i].st !== prev.st){ rotateAt=i; break; }
          }
          if (rotateAt>0) pieces = pieces.slice(rotateAt).concat(pieces.slice(0,rotateAt));
        }
        let curState=null, runPts=[];
        const flushRun = () => {
          if (runPts.length>=2){
            // Silhouette (wantIndividual=false) never has a hidden variant —
            // 'h' runs simply don't draw there, matching the old Scene
            // Outline's depth-blind, visible-only behavior.
            const arr = wantIndividual
              ? (curState==='v' ? (layerOn.iv ? groups.iv : null) : (layerOn.ih ? groups.ih : null))
              : (curState==='v' ? (layerOn.so ? groups.so : null) : null);
            if (arr) for (let i=0;i+1<runPts.length;i++)
              emit(arr, runPts[i][0],runPts[i][1], runPts[i+1][0],runPts[i+1][1], 0, 1);
          }
          runPts=[]; curState=null;
        };
        for (const p of pieces){
          if (p.brk){ flushRun(); continue; }   // real backdrop-drop — never bridged
          if (p.st!==curState){ flushRun(); curState=p.st; runPts=[p.p0]; }
          runPts.push(p.p1);
        }
        flushRun();
      }
    }
  }
  if (layerOn.so || layerOn.iv || layerOn.ih) emitSilhouetteChains(topo, splits);

  /* 7 · circles pattern — one unified layer (single checkbox), drawing
     BOTH a ground-plane ring set (gated by the existing Ground shadow
     checkbox) and a model-surface ring set (gated by Cast shadows / Soft
     shadows), sharing one Center X/Y and reading spacing directly from
     the global Hatch Min/Max spacing sliders — no dedicated spacing
     setting of its own. Density on the model-surface set mirrors regular
     hatch's own mechanism exactly: within the qualifying brightness
     region, spacing interpolates continuously from Min to Max, then
     snaps to the nearest power-of-2 multiple of Min so rings stay
     aligned to one fixed family (kept every 1st, 2nd, 4th, ... ring)
     rather than literally varying radius — evaluated per point along
     each ring via the ring-index threading in buildPatternSegsFromTest
     above, not once per whole ring, since a ring's own brightness can
     vary substantially as it sweeps around a curved surface (mirroring
     how a single hatch line's own density already varies along its
     length). Cast shadow overrides this gradient to always-densest
     rather than blending with it — exactly regular hatch's own "shadow
     can still hatch a too-bright face" rule. Ground rings have no
     brightness gradient at all (the ground plane's own "brightness"
     isn't a meaningful concept the way a model face's is) — they're
     purely boolean, always densest wherever the ground shadow test is
     true, matching the same override-only treatment. */
  let circlePatternSegs = null;
  if (S.circlesOn){
    const minS = Math.max(1, S.hatch.minS), maxS = Math.max(minS+0.5, S.hatch.maxS);
    // See SHADOW_ONLY_THR/castOnly at the top of generate() — automates
    // the "set every below slider to 0.01" manual trick for Cast-shadow-
    // only mode, now that buffer mode tests one combined threshold.
    const circlesThr = castOnly ? SHADOW_ONLY_THR : (S.circlesThr || 0);   // zeroed by gatherSettings when Soft shadows is off
    const cx5 = S.groundPatternCenterX || 0, cy5 = S.groundPatternCenterY || 0;
    const segs = [];

    if (S.ground && S.ground.on && Ly > 1e-6){
      grAttempt: {
        let bbMinY3 = Infinity;
        for (let i=1; i<pos.length; i+=3) if (pos[i] < bbMinY3) bbMinY3 = pos[i];
        const gy3 = bbMinY3 - (S.ground.off || 0) * M.radius;
        const gpSm = sharedShadowMap;
        if (!gpSm.kept) break grAttempt;   // no occluders — shadow test would always be false
        // Worker-px rectangle that lands exactly on the full printable page
        // once computePaperLayout's contain-fit transform is applied — see
        // its own comment in gatherSettings() (js/panel-controls.js). Falls
        // back to the plain viewport rectangle for stale settings blobs
        // that arrive without it.
        const pb = S.invertPageBounds || { x0:0, x1:W, y0:0, y1:H };

        const viewRayPointAtC = (px, py, c) => {
          const ndcX=(px/W-0.5)*2, ndcY=(0.5-py/H)*2;
          const A11=P[0]-ndcX*P[3], A12=P[4]-ndcX*P[7];
          const A21=P[1]-ndcY*P[3], A22=P[5]-ndcY*P[7];
          const b1=-(P[8]-ndcX*P[11])*c-(P[12]-ndcX*P[15]);
          const b2=-(P[9]-ndcY*P[11])*c-(P[13]-ndcY*P[15]);
          const det=A11*A22-A12*A21;
          return [(b1*A22-A12*b2)/det, (A11*b2-b1*A21)/det, c];
        };
        const viewToWorld = (a,b,c) => {
          const tx=a-V[12], ty=b-V[13], tz=c-V[14];
          return [V[0]*tx+V[1]*ty+V[2]*tz, V[4]*tx+V[5]*ty+V[6]*tz, V[8]*tx+V[9]*ty+V[10]*tz];
        };
        // The two view-space depths groundWorldAt samples the ray at —
        // named so the ray-hit depth check below can't drift out of sync
        // with them.
        const RAY_C1 = -1, RAY_C2 = -5;
        const groundWorldAt = (px, py) => {
          const p1 = viewToWorld(...viewRayPointAtC(px, py, RAY_C1));
          const p2 = viewToWorld(...viewRayPointAtC(px, py, RAY_C2));
          const dir = [p2[0]-p1[0], p2[1]-p1[1], p2[2]-p1[2]];
          if (Math.abs(dir[1]) < 1e-9) return null;
          const t = (gy3 - p1[1]) / dir[1];
          // Reject on the ray-hit's own view-space depth against the
          // camera's real near plane — not an arbitrary ray-parameter
          // cutoff (the old `t<0` rejected a scale-dependent ~1-world-unit
          // strip in front of the camera, which is wrong at both ends: too
          // permissive in perspective near the true horizon, and a live
          // bug in orthographic where it doesn't correspond to anything
          // meaningful at all).
          const viewZHit = RAY_C1 + t * (RAY_C2 - RAY_C1);
          if (viewZHit >= nearZ) return null;   // behind the camera or closer than the near plane
          return [p1[0]+dir[0]*t, gy3, p1[2]+dir[2]*t];
        };
        const groundTest = (px, py) => {
          if (coverPoint(px, py, null)) return false;   // model covers the ground here from the camera
          // Ring radii reach the farthest viewport corner from the (user-
          // positioned) center, so rings already extend past the page edge —
          // invisible normally (off-page points are essentially never in
          // shadow), but Invert shadows would otherwise draw those arcs into
          // the paper margins. Only gated here, not above: it's a deliberate
          // page-bounds policy for the inverted fill, not a correctness fix.
          if (S.invertShadows && (px<pb.x0 || py<pb.y0 || px>pb.x1 || py>pb.y1)) return false;
          const w = groundWorldAt(px, py);
          // No valid ground-plane point here (behind the camera / above the
          // horizon) means "can't be in shadow" — same as a real, tested
          // point that comes back not-shadowed. Must still go through the
          // same invert negation as a real result, not an unconditional
          // false: otherwise every such point stays permanently blank even
          // when inverted, which is exactly the leftover horizon/near-plane
          // cutoff this was meant to fix.
          if (!w) return S.invertShadows;
          const result = gpSm.test(w[0], w[1], w[2], -1);
          return S.invertShadows ? !result : result;
        };
        // Rings need to reach the full page under Invert shadows, not just
        // the viewport rectangle — see pb above.
        const groundCorners = S.invertShadows
          ? [[pb.x0,pb.y0],[pb.x1,pb.y0],[pb.x0,pb.y1],[pb.x1,pb.y1]]
          : [[0,0],[W,0],[0,H],[W,H]];
        for (const piece of buildPatternSegsFromTest(groundTest, cx5, cy5, minS, groundCorners)){
          piece.source = 'ground'; segs.push(piece);
        }
      }
    }

    if ((S.shadow && S.shadow.on) || circlesThr > 0){
      const cpSm = (S.shadow && S.shadow.on) ? sharedShadowMap : null;
      const invertShadows = !!S.invertShadows;
      const castTest = (px, py, r) => {
        const hit = pickVisibleFace(px, py);
        if (!hit) return false;                                  // background — no surface to shadow
        if (smoothH){
          // Smooth Shading: buffer-driven only (see project notes) — one
          // direct sample already IS max(0,N·L)*shadowFactor as a single
          // continuous value, so there's no separate override branch
          // needed at all, unlike flat mode below.
          if (!shadingBuf) return false;   // warned once already, above the face loop equivalent
          const bFp = Math.max(0, sampleShading(shadingBuf.pixels, shadingBuf.w, shadingBuf.h, px, py).brightness);
          let result = false;
          if (bFp < circlesThr){
            const spacing = minS + bFp*(maxS-minS);
            const step = Math.max(1, Math.pow(2, Math.round(Math.log2(spacing/minS))));
            result = (r % step) === 0;
          }
          return invertShadows ? !result : result;
        }
        // Flat Shading: exact per-face scalar, unchanged.
        const bF = bright[hit.f];
        let brightOK = false, brightStep = 1;
        if (bF < circlesThr){
          const spacing = minS + bF*(maxS-minS);
          brightStep = Math.max(1, Math.pow(2, Math.round(Math.log2(spacing/minS))));
          brightOK = (r % brightStep) === 0;
        }
        let result;
        // If brightness alone already maxes out the ring spacing right HERE
        // (brightStep===1), cast shadow's override can't add anything at
        // this point — skip its occlusion query. bF above is the exact
        // brightness at this specific sample point, not a conservative
        // per-face bound — so there's no brighter "elsewhere on the face"
        // this could be wrong about.
        if (brightOK && brightStep === 1) result = true;
        // Cast shadow's override applies unconditionally in Flat Shading
        // (no separate Soft Shadow gradient here to hand off an "away from
        // light" side to, unlike Smooth Shading).
        else if (cpSm && cpSm.kept && cpSm.test(hit.x, hit.y, hit.z, hit.f)) result = true;
        else result = brightOK;
        return invertShadows ? !result : result;
      };
      for (const piece of buildPatternSegsFromTest(castTest, cx5, cy5, minS, [[0,0],[W,0],[0,H],[W,H]])){
        piece.source = 'cast'; segs.push(piece);
      }
    }

    if (segs.length) circlePatternSegs = segs;
  }

  /* 8 · hatching */
  if (S.hatch && (S.hatch.p1||S.hatch.p2||S.hatch.p3)){
    // Invert shadows should be a no-op on the mesh's own surface when
    // neither Soft nor Cast shadows is active — normally (non-inverted)
    // neither produces any on-mesh hatch either, so without this guard
    // inverting flips "nothing" into "hatch the whole mesh at max density".
    // Settings-based (not a runtime "did anything actually get occluded"
    // check), matching Circles' own gate a few hundred lines up
    // (`S.shadow.on || circlesThr>0`) — that's exactly why Circles never
    // had this problem.
    const meshInvertActive = !!S.invertShadows &&
      (!!(S.hatch && S.hatch.softShadowsOn) || !!(S.shadow && S.shadow.on));
    const minS=Math.max(1, S.hatch.minS), maxS=Math.max(minS+0.5, S.hatch.maxS);
    // user-configurable (see the Hatch cap slider) — higher allows denser
    // hatching before it gets cut off, at the cost of a slower solve; shadows
    // the module-level default, which stays as the fallback for stale/older
    // saved settings blobs that arrive without it
    const HATCH_CAP = (S.hatch && Number.isFinite(S.hatch.cap) && S.hatch.cap > 0)
      ? S.hatch.cap : HATCH_CAP_DEFAULT;

    /* shadow setup (stage 2): the light-space occlusion map is built once per
       generate, only when the toggle is on — with it off, every line below is
       byte-for-byte the pre-shadow pipeline. */
    let sm=null, shadowOn=false, shadowExhausted=false, stepShadow=1;
    // user-configurable (see the Shadow budget slider) — higher catches
    // finer detail on complex/dense scenes at the cost of a slower solve;
    // falls back to the old default if settings ever arrive without it
    // (e.g. a stale/older saved settings blob)
    let shadowBudget = (S.shadow && Number.isFinite(S.shadow.budget) && S.shadow.budget > 0)
      ? S.shadow.budget : 500000;
    // Shadow regions always use the densest (minimum) hatch spacing now —
    // this used to be adjustable via a "Shadow darkness" slider, but a
    // plotted line can't get any denser than Min spacing already allows,
    // and Cast shadows should always be the darkest part of the image (a
    // lighter setting risked Soft shadow's own patches appearing darker
    // in places, which looked wrong). Density is controlled via the Min
    // spacing slider itself instead. stepShadow accordingly stays at its
    // declared default of 1 (no line-skipping) unconditionally.
    if (S.shadow && S.shadow.on){
      sm = sharedShadowMap;
      shadowOn = sm.kept > 0;
    }
    /* shadeAt cache (optimization 2 — reuse across passes): whether a given
       screen point on a given face is in shadow is a fixed fact of the
       geometry + light, independent of which hatch pass or carrier angle is
       asking. Without this, h1/h2/h3 — plus every seed/bisection sample
       within each — independently re-derive the SAME face-local shadow
       boundary up to 3× per generate, since all three passes sweep the same
       faces, just at different line angles. Keyed on (face, screen point) at
       the same ~0.02px point-identity resolution already used elsewhere in
       this file (chainSegments, dedupCollinear, etc.) — fine enough that it
       never limits the sub-pixel boundary precision the recursion below
       converges to (CUT_PX, defined next), so this is purely a speed win,
       not an accuracy trade-off. Keyed by FACE as well as point — not just
       the raw screen point — because sm.test()'s occluder self-exclusion
       (`skipF`) is face-specific: two different faces that happen to
       project to the same screen point must still get their own, correctly-
       excluded answer. Only re-queries of the SAME face reuse a cache entry,
       which is exactly the dominant, common case this targets. */
    // face → Map(packed point → bool). Numeric keys instead of the old
    // 'f_x_y' string concatenation: building + hashing a fresh string per
    // lookup was measurable overhead in the (very hot) shadow sampling path.
    // qx*2^23+qy is injective for |qy| < 2^22 — i.e. |y| < ~84k px, far
    // beyond any real render target.
    const shadowCache = new Map();
    const shadeAt = (f, x, y) => {
      let fc = shadowCache.get(f);
      if (!fc){ fc = new Map(); shadowCache.set(f, fc); }
      const key = Math.round(x*50)*8388608 + Math.round(y*50);
      const cached = fc.get(key);
      if (cached !== undefined) return cached;
      if (shadowBudget-- <= 0){ shadowExhausted = true; return false; }
      const w = worldOnFace(f, x, y, tri, pos, sx, sy, iz, ortho);
      const result = w ? sm.test(w[0], w[1], w[2], f) : false;
      fc.set(key, result);
      return result;
    };
    /* Interval recursion (optimization 3 — replaces uniform marching):
       sample both ends of a span plus its midpoint, and only recurse into
       whichever half(s) disagree — a boundary crossing is found in O(log)
       samples instead of marching every fixed step along the whole span.
       A uniformly lit or uniformly shadowed run (the common case for
       anything much bigger than a few pixels) now costs 3 samples total,
       independent of its length on screen, instead of one sample every 2px.
       Once a crossing IS found, recursion converges to the exact same
       sub-pixel precision the old fixed 7-step bisection did: CUT_PX
       matches it exactly (SHADOW_STEP_PX / 2^7).

       SEED_PX is the recursion's starting sample pitch — the gap within
       which a real crossing could still hide undetected between two probes
       that happen to agree. It's set equal to SHADOW_STEP_PX, the exact
       pitch the old fixed uniform march used everywhere, unconditionally —
       so the detection floor here is IDENTICAL to what shipped before any
       of this optimization work, not an approximation of it. (An earlier
       version of this tried to go coarser almost everywhere and only drop
       to this fine pitch where a local occluder-density probe guessed the
       geometry was "busy enough" to need it — that guess missed real detail
       on moderately-but-not-extremely dense geometry, like evenly-spaced
       balcony balusters, so it's gone: the recursion's speed win over the
       old uniform march comes entirely from skipping REDUNDANT samples
       within a run once its endpoints already agree, never from sampling
       more sparsely than the old floor to begin with.) */
    const SHADOW_STEP_PX = 2.0, CUT_PX = SHADOW_STEP_PX / 128;
    const SEED_PX = SHADOW_STEP_PX;
    const shadowSplit = (f, x0,y0,x1,y1, u0,u1) => {
      const pxPerU = Math.hypot(x1-x0, y1-y0);
      const Px = u => x0+(x1-x0)*u, Py = u => y0+(y1-y0)*u;

      // cheap upfront reject (point 4): if this whole segment's light-space
      // footprint falls entirely outside the combined occluder bounds, it
      // can't be shadowed at all anywhere along it — skip straight to fully
      // lit, zero shadow samples needed (no seeding, no recursion). This one
      // carries no detail risk at all: it's an exact bounds check, not a
      // density guess.
      const wA = worldOnFace(f, x0, y0, tri, pos, sx, sy, iz, ortho);
      const wB = worldOnFace(f, x1, y1, tri, pos, sx, sy, iz, ortho);
      if (!wA || !wB) return [[false, u0, u1]];
      const [uA,vA] = sm.uvOf(wA[0],wA[1],wA[2]), [uB,vB] = sm.uvOf(wB[0],wB[1],wB[2]);
      const [bu0,bu1,bv0,bv1] = sm.bounds;
      if (Math.max(uA,uB)<bu0 || Math.min(uA,uB)>bu1 || Math.max(vA,vB)<bv0 || Math.min(vA,vB)>bv1)
        return [[false, u0, u1]];

      const parts = [];
      const recurse = (loU, loS, hiU, hiS) => {
        if (loS === hiS){ parts.push([loS, loU, hiU]); return; }
        if ((hiU-loU)*pxPerU <= CUT_PX){                  // converged — resolve the crossing here
          const cut=(loU+hiU)/2;
          parts.push([loS, loU, cut]); parts.push([hiS, cut, hiU]);
          return;
        }
        const midU=(loU+hiU)/2, midS=shadeAt(f, Px(midU), Py(midU));
        recurse(loU, loS, midU, midS);
        recurse(midU, midS, hiU, hiS);
      };
      const spanPix = pxPerU*(u1-u0);
      const nSeed = Math.max(1, Math.ceil(spanPix / SEED_PX));
      let prevU=u0, prevS=shadeAt(f, Px(u0), Py(u0));
      for (let i=1;i<=nSeed;i++){
        const u = u0 + (u1-u0)*i/nSeed;
        const s = shadeAt(f, Px(u), Py(u));
        recurse(prevU, prevS, u, s);
        prevU=u; prevS=s;
      }
      // coalesce adjacent same-state leaves — seed-cell boundaries where
      // both sides happen to agree don't need to stay as separate pieces
      const merged=[];
      for (const p of parts){
        const last = merged[merged.length-1];
        if (last && last[0]===p[0] && Math.abs(last[2]-p[1])<1e-9) last[2]=p[2];
        else merged.push(p.slice());
      }
      return merged;
    };
    // ================= Smooth Shading: buffer-driven Hatch density =================
    // Samples the captured shading buffer directly instead of an analytic
    // Phong formula — the buffer's brightness already IS max(0,N·L)*
    // shadowFactor as one continuous signal, so there's no separate shadow
    // axis to reconcile here at all, unlike flat mode below. Mirrors the
    // same bisection shape the old analytic version's per-point smooth
    // hatch boundary used, just sourced from the buffer instead.
    // Doesn't check hasGeometry — an earlier version did, flagging any
    // disagreement for inspection, and that's exactly how it was confirmed
    // this only ever happens right at silhouette edges (ordinary bilinear-
    // interpolation blur where the buffer's nearest texels straddle real
    // geometry and background), never in a face's interior. This function
    // only ever runs on segments the analytic solver already clipped to
    // real, visible geometry, so the spatial correctness was never in
    // question — brightness is used as-is regardless of the G channel.
    const bufferSplit = (x0,y0,x1,y1, u0,u1, k, pass) => {
      const pxPerU = Math.hypot(x1-x0, y1-y0);
      const Px = u => x0+(x1-x0)*u, Py = u => y0+(y1-y0)*u;
      const testAt = u => {
        const px = Px(u), py = Py(u);
        const samp = sampleShading(shadingBuf.pixels, shadingBuf.w, shadingBuf.h, px, py);
        const bFp = Math.max(0, samp.brightness);
        let result = false;
        if (bFp < pass.thr){
          const spacing = minS + bFp*(maxS-minS);
          const step = Math.max(1, Math.pow(2, Math.round(Math.log2(spacing/minS))));
          result = (k % step) === 0;
        }
        return meshInvertActive ? !result : result;
      };
      const parts = [];
      const recurse = (loU, loS, hiU, hiS) => {
        if (loS === hiS){ parts.push([loS, loU, hiU]); return; }
        if ((hiU-loU)*pxPerU <= CUT_PX){
          const cut=(loU+hiU)/2;
          parts.push([loS, loU, cut]); parts.push([hiS, cut, hiU]);
          return;
        }
        const midU=(loU+hiU)/2, midS=testAt(midU);
        recurse(loU, loS, midU, midS);
        recurse(midU, midS, hiU, hiS);
      };
      const spanPix = pxPerU*(u1-u0);
      const nSeed = Math.max(1, Math.ceil(spanPix / SEED_PX));
      let prevU=u0, prevS=testAt(u0);
      for (let i=1;i<=nSeed;i++){
        const u = u0 + (u1-u0)*i/nSeed;
        const s = testAt(u);
        recurse(prevU, prevS, u, s);
        prevU=u; prevS=s;
      }
      const merged=[];
      for (const p of parts){
        const last = merged[merged.length-1];
        if (last && last[0]===p[0] && Math.abs(last[2]-p[1])<1e-9) last[2]=p[2];
        else merged.push(p.slice());
      }
      return merged;
    };
    const passes=[];
    if (S.hatch.p1) passes.push({key:'h1', ang:S.hatch.ang,     thr: castOnly ? SHADOW_ONLY_THR : S.hatch.hatchThr});
    if (S.hatch.p2) passes.push({key:'h2', ang:S.hatch.ang+90,  thr: castOnly ? SHADOW_ONLY_THR : S.hatch.crossThr});
    if (S.hatch.p3) passes.push({key:'h3', ang:S.hatch.ang+45,  thr: castOnly ? SHADOW_ONLY_THR : S.hatch.deepThr});
    // global screen bbox of projected verts (keeps hatch families aligned across faces)
    let gx0=1/0,gy0=1/0,gx1=-1/0,gy1=-1/0, any=false;
    for (let i=0;i<nv;i++) if (ok[i]){
      any=true;
      if (sx[i]<gx0)gx0=sx[i]; if (sx[i]>gx1)gx1=sx[i];
      if (sy[i]<gy0)gy0=sy[i]; if (sy[i]>gy1)gy1=sy[i];
    }
    // carriers must span the ground-shadow region too, or its hatch would be
    // clipped to the model's screen extent
    if (GS){
      any=true;
      if (GS.bx0<gx0)gx0=GS.bx0; if (GS.bx1>gx1)gx1=GS.bx1;
      if (GS.by0<gy0)gy0=GS.by0; if (GS.by1>gy1)gy1=GS.by1;
    }
    let hatchTotal=0, capped=false;
    const lineVis = new Map();       // carrier index k → visible [a,b] intervals in carrier-t
    if (any) for (let pi=0; pi<passes.length && !capped; pi++){
      const pass=passes[pi], grp=groups[pass.key];
      const rad=pass.ang*Math.PI/180;
      const dx=Math.cos(rad), dy=Math.sin(rad), nx=-dy, ny=dx;   // line dir · family normal
      // global extent along dir/normal
      const corners=[[gx0,gy0],[gx1,gy0],[gx0,gy1],[gx1,gy1]];
      let c0=1/0,c1=-1/0,t0e=1/0,t1e=-1/0;
      for (const [px,py] of corners){
        const cc=px*nx+py*ny, tt=px*dx+py*dy;
        if (cc<c0)c0=cc; if (cc>c1)c1=cc; if (tt<t0e)t0e=tt; if (tt>t1e)t1e=tt;
      }
      // Invert shadows + Ground shadow: the ground-hatch block below fills
      // the whole visible PAGE (not just the viewport rectangle, and not
      // just the model+shadow bbox), so the carriers' along-line extent
      // needs to reach the true page bounds too — see invertPageBounds'
      // own comment in gatherSettings() (js/panel-controls.js). Widening
      // t0e/t1e only (never c0 — that's the carrier-family phase anchor;
      // shifting it would desync the k keys this on-mesh loop and the
      // ground block below both write into the shared lineVis map) is
      // safe: a face's own clip always reduces to the same physical
      // endpoints regardless of how long this nominal backing span is.
      if (GS && S.invertShadows){
        const pb = S.invertPageBounds || { x0:0, x1:W, y0:0, y1:H };
        for (const [px,py] of [[pb.x0,pb.y0],[pb.x1,pb.y0],[pb.x0,pb.y1],[pb.x1,pb.y1]]){
          const tt=px*dx+py*dy;
          if (tt<t0e)t0e=tt; if (tt>t1e)t1e=tt;
        }
      }
      for (let f=0; f<nt && !capped; f++){
        if (!front[f]) continue;
        const a=tri[f*3], b=tri[f*3+1], c=tri[f*3+2];
        if (!ok[a]||!ok[b]||!ok[c]) continue;                    // skip near-clipped faces for hatch
        if (smoothH){
          // ================= Smooth Shading: buffer-driven only =================
          // See project notes — the old analytic Phong+shadow-map hybrid
          // for smooth mode has been fully removed after validation showed
          // the buffer-driven approach was both correct (it fixed a real
          // bug the old approach had) and faster. Flat Shading (below) is
          // completely unaffected and never used any of this.
          if (!useShadingBuf) continue;   // no captured buffer this generate — warned once already, above
          // face plane in (x,y,1/z)
          const ax=sx[a],ay=sy[a],az=iz[a], bx=sx[b],by=sy[b],bz=iz[b], cx=sx[c],cy2=sy[c],cz=iz[c];
          const d1x=bx-ax,d1y=by-ay,d1z=bz-az, d2x=cx-ax,d2y=cy2-ay,d2z=cz-az;
          const det=d1x*d2y-d1y*d2x;
          if (Math.abs(det)>=1e-9){
            const A=(d1z*d2y-d2z*d1y)/det, B=(d1x*d2z-d2x*d1z)/det, C=az-A*ax-B*ay;
            const s=det>0?1:-1;
            const cA=ax*nx+ay*ny, cB=bx*nx+by*ny, cC=cx*nx+cy2*ny;
            const cMin=Math.min(cA,cB,cC), cMax=Math.max(cA,cB,cC);
            let k=Math.ceil((cMin-c0)/minS);
            const kEnd=Math.floor((cMax-c0)/minS);
            for (; k<=kEnd; k++){
              const cc=c0+k*minS;
              const X0=nx*cc+dx*t0e, Y0=ny*cc+dy*t0e, X1=nx*cc+dx*t1e, Y1=ny*cc+dy*t1e;
              let ta=0, tb=1, alive=true;
              for (let e2=0;e2<3 && alive;e2++){
                let px,py,qx,qy;
                if (e2===0){px=ax;py=ay;qx=bx;qy=by;} else if (e2===1){px=bx;py=by;qx=cx;qy=cy2;} else {px=cx;py=cy2;qx=ax;qy=ay;}
                const ex=qx-px, ey=qy-py;
                const fa=s*(ex*(Y0-py)-ey*(X0-px));
                const fb=s*(ex*(Y1-py)-ey*(X1-px));
                if (fa<0&&fb<0){ alive=false; break; }
                if (fa<0)      ta=Math.max(ta, fa/(fa-fb));
                else if (fb<0) tb=Math.min(tb, fa/(fa-fb));
              }
              if (!alive || tb-ta<1e-5) continue;
              const hx0=X0+(X1-X0)*ta, hy0=Y0+(Y1-Y0)*ta, hx1=X0+(X1-X0)*tb, hy1=Y0+(Y1-Y0)*tb;
              const hz0=A*hx0+B*hy0+C, hz1=A*hx1+B*hy1+C;
              const hid=occlude(hx0,hy0,hz0,hx1,hy1,hz1, f, -2);
              let ivs = lineVis.get(k);
              if (!ivs){ ivs=[]; lineVis.set(k, ivs); }
              const visPieces = [];
              let u=0;
              for (let hi=0; hi<hid.length; hi+=2){
                if (hid[hi]>u) visPieces.push(u, hid[hi]);
                u=hid[hi+1];
              }
              if (u<1) visPieces.push(u, 1);
              // The buffer's own brightness already IS max(0,N·L)*
              // shadowFactor as one continuous signal, so every camera-
              // visible piece goes straight through bufferSplit's own
              // bisection — no separate lit/shadow classification axis
              // needed at all, unlike flat mode below.
              for (let vp=0; vp<visPieces.length; vp+=2){
                for (const [ok_, pa, pb] of bufferSplit(hx0,hy0,hx1,hy1, visPieces[vp], visPieces[vp+1], k, pass))
                  if (ok_) ivs.push(ta+(tb-ta)*pa, ta+(tb-ta)*pb);
              }
              hatchTotal++;
              if (hatchTotal>HATCH_CAP*2){ capped=true; break; }
            }
          }
        } else {
          // ================= Flat Shading: exact per-face scalar (unchanged) =================
          const bF = bright[f];
          const litFace = bF < pass.thr;
          // Under Invert shadows a face with neither normal brightness-hatch
          // nor any shadow contribution isn't dead weight — it's exactly the
          // face that should come out fully hatched — so this shortcut only
          // applies un-inverted.
          if (!meshInvertActive && !litFace && !shadowOn) continue;   // shadow can still hatch a "too bright" face
          let stepLit = 1;
          if (litFace){
            const spacing=minS+Math.max(0,bF)*(maxS-minS);            // bright → sparse
            stepLit=Math.max(1, Math.pow(2, Math.round(Math.log2(spacing/minS)))); // pow2 keeps families aligned
          }
          // If brightness alone already forces the densest possible
          // spacing here (stepLit===1 — every carrier line already
          // qualifies), a shadowed vs. lit split can't change the outcome:
          // stepShadow is always 1 too, so both sides of that split would
          // keep every line regardless. Running shadowSplit's per-line
          // shadeAt/occlusion queries to find out WHICH portion is
          // shadowed is then pure wasted work — the answer (draw it,
          // densest) is already certain either way.
          const faceShadowRelevant = shadowOn && !(litFace && stepLit === 1);
          // face plane in (x,y,1/z)
          const ax=sx[a],ay=sy[a],az=iz[a], bx=sx[b],by=sy[b],bz=iz[b], cx=sx[c],cy2=sy[c],cz=iz[c];
          const d1x=bx-ax,d1y=by-ay,d1z=bz-az, d2x=cx-ax,d2y=cy2-ay,d2z=cz-az;
          const det=d1x*d2y-d1y*d2x;
          if (Math.abs(det)>=1e-9){
            const A=(d1z*d2y-d2z*d1y)/det, B=(d1x*d2z-d2x*d1z)/det, C=az-A*ax-B*ay;
            const s=det>0?1:-1;
            const cA=ax*nx+ay*ny, cB=bx*nx+by*ny, cC=cx*nx+cy2*ny;
            const cMin=Math.min(cA,cB,cC), cMax=Math.max(cA,cB,cC);
            let k=Math.ceil((cMin-c0)/minS);
            const kEnd=Math.floor((cMax-c0)/minS);
            for (; k<=kEnd; k++){
              const litCandidate = litFace && (k % stepLit) === 0;
              const shOK = faceShadowRelevant && (k % stepShadow) === 0;
              // Same reasoning as the face-level shortcut above — a carrier
              // line neither side would normally draw is exactly the one
              // Invert shadows needs to draw in full, so don't skip it.
              if (!meshInvertActive && !litCandidate && !shOK) continue;
              const cc=c0+k*minS;
              const X0=nx*cc+dx*t0e, Y0=ny*cc+dy*t0e, X1=nx*cc+dx*t1e, Y1=ny*cc+dy*t1e;
              let ta=0, tb=1, alive=true;
              for (let e2=0;e2<3 && alive;e2++){
                let px,py,qx,qy;
                if (e2===0){px=ax;py=ay;qx=bx;qy=by;} else if (e2===1){px=bx;py=by;qx=cx;qy=cy2;} else {px=cx;py=cy2;qx=ax;qy=ay;}
                const ex=qx-px, ey=qy-py;
                const fa=s*(ex*(Y0-py)-ey*(X0-px));
                const fb=s*(ex*(Y1-py)-ey*(X1-px));
                if (fa<0&&fb<0){ alive=false; break; }
                if (fa<0)      ta=Math.max(ta, fa/(fa-fb));
                else if (fb<0) tb=Math.min(tb, fa/(fa-fb));
              }
              if (!alive || tb-ta<1e-5) continue;
              const hx0=X0+(X1-X0)*ta, hy0=Y0+(Y1-Y0)*ta, hx1=X0+(X1-X0)*tb, hy1=Y0+(Y1-Y0)*tb;
              const hz0=A*hx0+B*hy0+C, hz1=A*hx1+B*hy1+C;
              const hid=occlude(hx0,hy0,hz0,hx1,hy1,hz1, f, -2);
              let ivs = lineVis.get(k);
              if (!ivs){ ivs=[]; lineVis.set(k, ivs); }
              const visPieces = [];
              let u=0;
              for (let hi=0; hi<hid.length; hi+=2){
                if (hid[hi]>u) visPieces.push(u, hid[hi]);
                u=hid[hi+1];
              }
              if (u<1) visPieces.push(u, 1);
              if (!faceShadowRelevant){
                // Invert shadows: this carrier's draw/no-draw call doesn't
                // vary with shadow at all here, so just negate the same
                // whole-piece decision — see the shOK/litCandidate split
                // below for the per-point case.
                const draw = meshInvertActive ? !litCandidate : litCandidate;
                if (draw) for (let vp=0; vp<visPieces.length; vp+=2) ivs.push(ta+(tb-ta)*visPieces[vp], ta+(tb-ta)*visPieces[vp+1]);
              } else {
                // second classification axis: within each camera-visible
                // piece, split by shadow state, then keep each run only if
                // this carrier is eligible for that state (lit → face's
                // own step + threshold; shadowed → shadow step, threshold
                // always bypassed, an unconditional override). Both states
                // land in the SAME pass layer/pen, so adjacent kept runs
                // merge back into one stroke downstream — density
                // difference is carried by which carriers participate, not
                // by breaking strokes. Invert shadows negates this same
                // per-point eligibility rather than re-deriving anything —
                // draw where it previously wouldn't, blank where it would.
                for (let vp=0; vp<visPieces.length; vp+=2){
                  const parts = shadowSplit(f, hx0,hy0,hx1,hy1, visPieces[vp], visPieces[vp+1]);
                  for (const [inShadow, ua, ub] of parts){
                    const draw = inShadow ? shOK : litCandidate;
                    if (draw !== meshInvertActive) ivs.push(ta+(tb-ta)*ua, ta+(tb-ta)*ub);
                  }
                }
              }
              hatchTotal++;
              if (hatchTotal>HATCH_CAP*2){ capped=true; break; }     // collection guard
            }
          }
        }
        if ((f & 1023)===0) post({type:'progress', v: 0.5 + 0.5*(pi+f/nt)/passes.length});
      }
      /* analytic ground shadow — for each eligible carrier, clip the infinite
         carrier line against every projected shadow triangle (cheap 3-edge
         half-plane clip in the carrier parameter), union the resulting 1D
         intervals, occlude the runs against the model, and store them in the
         shared lineVis in the same [t0e,t1e]-fraction parameterization the
         model hatch uses — so ground and model strokes merge into single pen
         paths downstream. Exact boundaries, no shadow-map tests, no budget. */
      if (GS){
        const inv = !!S.invertShadows;
        const pb = S.invertPageBounds || { x0:0, x1:W, y0:0, y1:H };
        const T=GS.tris, tn=GS.tn, Lpx2=t1e-t0e;
        // per-triangle extent along this pass's carrier normal (quick reject)
        const tcMin=new Float64Array(tn), tcMax=new Float64Array(tn);
        for (let i=0;i<tn;i++){
          const q0=T[i*6]*nx+T[i*6+1]*ny, q1=T[i*6+2]*nx+T[i*6+3]*ny, q2=T[i*6+4]*nx+T[i*6+5]*ny;
          tcMin[i]=Math.min(q0,q1,q2); tcMax[i]=Math.max(q0,q1,q2);
        }
        // carrier index range covering the shadow region
        let cLo=1/0, cHi=-1/0;
        for (const [qx,qy] of [[GS.bx0,GS.by0],[GS.bx1,GS.by0],[GS.bx0,GS.by1],[GS.bx1,GS.by1]]){
          const cc2=qx*nx+qy*ny;
          if (cc2<cLo)cLo=cc2; if (cc2>cHi)cHi=cc2;
        }
        // Invert shadows: also walk every carrier that crosses the visible
        // page, not just ones crossing the shadow's own bbox — those extra
        // lines find no shadow triangles (iv stays empty) and get fully
        // hatched below, which is exactly the "fill the rest of the page"
        // behavior. Gated: the extra k's cost a real per-triangle reject
        // scan below, wasted work when not inverting since output there is
        // unaffected either way.
        if (inv){
          for (const [qx,qy] of [[pb.x0,pb.y0],[pb.x1,pb.y0],[pb.x0,pb.y1],[pb.x1,pb.y1]]){
            const cc2=qx*nx+qy*ny;
            if (cc2<cLo)cLo=cc2; if (cc2>cHi)cHi=cc2;
          }
        }
        const iv=[];
        let k=Math.ceil((cLo-c0)/minS);
        const kEnd=Math.floor((cHi-c0)/minS);
        for (; k<=kEnd && !capped; k++){
          if (k % stepShadow) continue;                  // shadow density only
          const cc=c0+k*minS;
          // Invert shadows: clip this carrier's infinite line down to where
          // it's actually on the visible page. Deliberately NOT also
          // clipping to any camera-frustum/horizon notion here — GS.A/B/C
          // is only ever used below as a comparative depth KEY for
          // occlude()'s mesh-occlusion test, never as an actual 3D
          // position, so an extrapolated depth past the true horizon is
          // still a validly-ordered "farther than any real surface" key:
          // the mesh already occludes the fill wherever it should, and
          // where nothing occludes it, inking it is exactly this feature's
          // own spec (fill the whole page except shadow + mesh, at any
          // viewing angle). Same half-plane (f0,df) idiom as the triangle
          // clip just below — one axis-aligned page edge per row.
          let vt0=-1/0, vt1=1/0, cur=0;
          if (inv){
            const rows = [[nx*cc-pb.x0,dx],[pb.x1-nx*cc,-dx],[ny*cc-pb.y0,dy],[pb.y1-ny*cc,-dy]];
            let onPage=true;
            for (const [f0,df] of rows){
              if (Math.abs(df) < 1e-12){ if (f0 < 0){ onPage=false; break; } continue; }
              const tX=-f0/df;
              if (df > 0){ if (tX>vt0) vt0=tX; } else { if (tX<vt1) vt1=tX; }
            }
            if (!onPage || vt1-vt0 <= 1e-6) continue;   // nothing of this carrier is on-page
            cur = vt0;
          }
          iv.length=0;
          for (let i=0;i<tn;i++){
            if (cc<tcMin[i] || cc>tcMax[i]) continue;
            // clip carrier P(t) = n·cc + d·t against triangle i (absolute t)
            const o=i*6;
            const sgn = ((T[o+2]-T[o])*(T[o+5]-T[o+1])-(T[o+3]-T[o+1])*(T[o+4]-T[o])) > 0 ? 1 : -1;
            let ta=-1/0, tb=1/0, alive=true;
            for (let e2=0; e2<3; e2++){
              const px=T[o+e2*2], py=T[o+e2*2+1];
              const qx=T[o+((e2+1)%3)*2], qy=T[o+((e2+1)%3)*2+1];
              const ex=qx-px, ey=qy-py;
              const f0=sgn*(ex*(ny*cc-py)-ey*(nx*cc-px)); // signed dist at t=0
              const df=sgn*(ex*dy-ey*dx);                 // …and its slope in t
              if (Math.abs(df) < 1e-12){ if (f0 < 0){ alive=false; break; } continue; }
              const tX=-f0/df;
              if (df > 0){ if (tX>ta) ta=tX; } else { if (tX<tb) tb=tX; }
            }
            if (alive && tb-ta > 1e-9){ iv.push(ta, tb); }
          }
          // Under Invert shadows, a line with no shadow triangle at all
          // means "the whole on-page span is unshadowed" — must NOT skip
          // (that's handled a few lines down); non-inverted keeps today's
          // behavior exactly.
          if (!iv.length && !inv) continue;
          // union the per-triangle intervals (adjacent projected triangles
          // share edges, so their intervals touch and fuse into one run)
          const nIv=iv.length/2, ord=[];
          for (let i=0;i<nIv;i++) ord.push(i);
          ord.sort((a,b)=>iv[a*2]-iv[b*2]);
          let ivs = lineVis.get(k);
          if (!ivs){ ivs=[]; lineVis.set(k, ivs); }
          const flush = (u0,u1) => {
            u0=Math.max(u0,t0e); u1=Math.min(u1,t1e);
            if (u1-u0 < 1e-6) return;
            const x0=nx*cc+dx*u0, y0=ny*cc+dy*u0, x1=nx*cc+dx*u1, y1=ny*cc+dy*u1;
            const z0=GS.A*x0+GS.B*y0+GS.C, z1=GS.A*x1+GS.B*y1+GS.C;
            const hid=occlude(x0,y0,z0,x1,y1,z1, -1, -2); // model hides ground hatch
            const fa=(u0-t0e)/Lpx2, fb=(u1-t0e)/Lpx2;
            let u=0;
            for (let hi=0; hi<hid.length; hi+=2){
              if (hid[hi]>u) ivs.push(fa+(fb-fa)*u, fa+(fb-fa)*hid[hi]);
              u=hid[hi+1];
            }
            if (u<1) ivs.push(fa+(fb-fa)*u, fb);
            hatchTotal++;
            if (hatchTotal>HATCH_CAP*2) capped=true;
          };
          if (!nIv){ flush(vt0, vt1); continue; }   // inverted, no shadow on this line at all — hatch the whole on-page span
          // Invert shadows: ink the GAPS between shadow runs (bounded by
          // this line's on-page span, vt0/vt1) instead of the runs
          // themselves. Reusing flush() unmodified for both directions is
          // what makes "never overlap mesh" (its occlude call) hold for
          // inverted ground hatch too, without reimplementing it.
          const invRun = (a, b) => {
            const s = Math.min(Math.max(a, vt0), vt1);
            if (s - cur > 1e-6) flush(cur, s);
            if (b > cur) cur = b;
          };
          const outRun = inv ? invRun : flush;
          let cs=iv[ord[0]*2], ce=iv[ord[0]*2+1];
          for (let i=1; i<=nIv && !capped; i++){
            const s2 = i<nIv ? iv[ord[i]*2]   : Infinity;
            const e2 = i<nIv ? iv[ord[i]*2+1] : 0;
            if (s2 <= ce+1e-3){ if (e2>ce) ce=e2; }
            else { outRun(cs,ce); cs=s2; ce=e2; }
          }
          // Under Invert shadows this final call's sentinel args (Infinity,0)
          // make invRun close the LAST gap up to vt1 — see invRun above.
          if (!capped) outRun(cs,ce);
        }
      }
      // merge per carrier line: touching/overlapping visible intervals join into
      // maximal runs (tolerance ~half a MIN_SEG so shared-edge seams and denoise
      // slivers bridge, but genuine hidden gaps — always ≥ MIN_SEG after the
      // occlusion denoise pass — never do), then each run emits as ONE segment.
      const Lpx = t1e - t0e;                                     // dir is unit → carrier px length
      const epsT = Math.max(1e-9, (MIN_SEG*0.5) / Math.max(Lpx, 1e-6));
      for (const [k, ivs] of lineVis){
        const cc=c0+k*minS;
        const X0=nx*cc+dx*t0e, Y0=ny*cc+dy*t0e, X1=nx*cc+dx*t1e, Y1=ny*cc+dy*t1e;
        const nIv = ivs.length/2, order=[];
        for (let i=0;i<nIv;i++) order.push(i);
        order.sort((a,b)=>ivs[a*2]-ivs[b*2]);
        let cs=ivs[order[0]*2], ce=ivs[order[0]*2+1];
        for (let i=1;i<=nIv;i++){
          const s2 = i<nIv ? ivs[order[i]*2]   : Infinity;
          const e2 = i<nIv ? ivs[order[i]*2+1] : 0;
          if (s2 <= ce+epsT) ce=Math.max(ce,e2);
          else { if (emit(grp, X0,Y0,X1,Y1, cs, ce)) hatchCarrier[pass.key].push(k); cs=s2; ce=e2; }
        }
        if (grp.length/4 > HATCH_CAP){ capped=true; break; }
      }
      lineVis.clear();
    }
    if (capped) counts.hatchCapped = true;
    if (shadowExhausted) counts.shadowCapped = true;   // budget hit — remainder rendered as lit
  }
  /* Collinear-overlap dedup — every straight-line edge layer except Contour
     (hatch is deliberately excluded too: those strokes are evenly spaced by
     construction and never coincide, so there's nothing for intra-layer
     dedup to find). This is pass 1: merge duplicates/overlaps WITHIN each
     layer, since same-layer strokes share a pen and merging loses nothing.
     sv/sh are skipped outright (Phase 3b — see PHASE3b-contour-run-identity.md
     Step 7): dedupCollinear's clustering is purely 2D (angle + perpendicular
     offset), blind to depth or runId, so on a self-crossing/self-overlapping
     model it can silently merge two genuinely different strands of Contour
     that only LOOK collinear in 2D — confirmed directly (a self-crossing
     torus knot went from 81 fragmented paths to 22, one closed, purely by
     disabling this for Contour, everything else held constant). Contour's
     own run identity (Step 2/3 above) already guarantees no duplicate ink
     within a run, and cross-run duplicate ink is vanishingly rare compared
     to the corruption risk, so it's never run here at all. */
  for (const k of ['cv','ch','so']){
    groups[k] = dedupCollinear(groups[k], effOffTol, effGapTol);
  }
  /* Pass 2: cross-layer ink-avoidance across the FULL drawing-priority
     hierarchy (highest first): Silhouette > Silhouette individual >
     Silhouette individual hidden > Contour > Contour hidden > Crease >
     Crease hidden > Hatch > Crosshatch > Deep shadow — i.e. HIER below
     (so/iv/ih/sv/sh/cv/ch) plus the three hatch layers, which are still
     excluded from the cascade for the reason noted just after it.
     A lower-priority layer never re-strokes ink an enabled higher-priority
     layer already covers — applied as a sequential cascade (each layer
     subtracts every higher one in turn), which is equivalent to subtracting
     the union since coverage only ever shrinks a segment, never grows it
     back. This can't simply merge layers together since each keeps its own
     pen/weight on purpose (Silhouette is a deliberately bold re-stroke of
     the boundary for emphasis — 1.2mm black against Contour's 0.8mm, see
     LAYERS in main.js) — the covered portion is removed instead,
     and any uncovered remainder still draws in its own style.
     Every subtraction is gated on the higher layer being ACTUALLY enabled:
     e.g. if Silhouette's pen is off, Silhouette individual and Contour draw
     their full, unclipped geometry, exactly as if Silhouette didn't exist —
     an unconditional subtraction would silently delete lower-layer ink with
     nothing left to replace it. With only one shell in the scene, Silhouette
     individual's raw geometry is identical to Silhouette's, so this clips it
     down to nothing automatically whenever Silhouette is also on — no
     special-cased "only one object" logic needed. */
  // h1/h2/h3 (Hatch/Crosshatch/Deep shadow) still excluded for now. NOTE: the
  // sub-pixel shift bug that forced this exclusion (cross-basis t-value
  // comparison in subtractCovered — see the fix comment in that function) is
  // now fixed; clip boundaries are exact projections of the true hi
  // endpoints. Re-enabling hatch clipping is now just a matter of appending
  // 'h1','h2','h3' to HIER below, if that behavior is wanted again.
  // DIAGNOSTIC snapshot — raw so/iv geometry before ANY cross-layer
  // subtraction, purely to answer directly whether they're actually
  // identical (as the math says they should be for one shell) or genuinely
  // diverge somewhere, rather than continuing to guess. Never affects any
  // real output.
  const debugPreDedupSo = groups.so.slice();
  const debugPreDedupIv = groups.iv.slice();
  const HIER = ['so','iv','ih','sv','sh','cv','ch'];
  for (let i=1;i<HIER.length;i++){
    const lo = HIER[i];
    for (let j=0;j<i;j++){
      const hi = HIER[j];
      if (!(layerOn[hi] && groups[hi].length)) continue;
      if (lo==='sv' || lo==='sh'){
        const res = subtractCovered(groups[lo], groups[hi], effOffTol, effGapTol, runIds[lo], seqs[lo]);
        groups[lo] = res.arr; runIds[lo] = res.runIds; seqs[lo] = res.seqs;
      } else {
        groups[lo] = subtractCovered(groups[lo], groups[hi], effOffTol, effGapTol);
      }
    }
  }

  // Diagnostic only — see contourRunLens declaration above.
  counts.contourRunLensSv = contourRunLens.sv;
  counts.contourRunLensSh = contourRunLens.sh;

  /* 9 · package result */
  const out={}, transfer=[];
  for (const k in groups){
    counts[k]=groups[k].length/4;
    out[k]=new Float32Array(groups[k]);
    transfer.push(out[k].buffer);
  }
  // Contour chain identity (sv/sh only — see PHASE3a-chain-identity.md),
  // freshly built this generate() call and not reused for anything else
  // afterward, so a plain transfer (no "copy, don't transfer" slice) is safe.
  const outRunIds={}, outSeqs={};
  for (const k of ['sv','sh']){
    outRunIds[k]=new Int32Array(runIds[k]);
    outSeqs[k]=new Int32Array(seqs[k]);
    transfer.push(outRunIds[k].buffer, outSeqs[k].buffer);
  }
  const outCarrier={};
  for (const k in hatchCarrier){
    outCarrier[k]=new Int32Array(hatchCarrier[k]);
    transfer.push(outCarrier[k].buffer);
  }
  const debugPreDedupSoOut = new Float32Array(debugPreDedupSo);
  const debugPreDedupIvOut = new Float32Array(debugPreDedupIv);
  transfer.push(debugPreDedupSoOut.buffer, debugPreDedupIvOut.buffer);
  post({ type:'result', groups:out, runIds:outRunIds, seqs:outSeqs, hatchCarrier:outCarrier, w:W, h:H, counts, ms: Date.now()-t0ms,
    circlePatternSegs, debugPreDedupSo: debugPreDedupSoOut, debugPreDedupIv: debugPreDedupIvOut }, transfer);
}

/* ---------------- debug: raw edges (crease-angle filtered only) ----------------
   Deliberately bypasses almost the entire solver — no hidden-line removal,
   no occlusion, no hatching, no texture effects — since the whole point is
   to see the mesh's raw edges before any of that runs, with only the
   crease-angle threshold applied (the same eang/creaseDeg comparison the
   main pipeline already uses). Points behind the camera are skipped
   entirely (the simple approach) rather than clipped at the near plane. */
function generateRawEdges(cam, creaseDeg){
  if (!M){ post({ type:'error', msg:'No model loaded' }); return; }
  const { view:V, proj:P, w:W, h:H, near } = cam;
  const ortho = !!cam.ortho;
  const nearZ = -near * 1.0001;
  const projView = (a,b,c) => {
    const cx=P[0]*a+P[4]*b+P[8]*c+P[12], cy=P[1]*a+P[5]*b+P[9]*c+P[13],
          cw=P[3]*a+P[7]*b+P[11]*c+P[15];
    return [(cx/cw*0.5+0.5)*W, (0.5-cy/cw*0.5)*H];
  };
  const { pos, ea, eb, eang, ne } = M;
  const segs = [];
  for (let e=0; e<ne; e++){
    if (eang[e] < creaseDeg) continue;
    const a = ea[e], b = eb[e];
    const ax=pos[a*3], ay=pos[a*3+1], az=pos[a*3+2];
    const bx=pos[b*3], by=pos[b*3+1], bz=pos[b*3+2];
    const avx=V[0]*ax+V[4]*ay+V[8]*az+V[12], avy=V[1]*ax+V[5]*ay+V[9]*az+V[13], avz=V[2]*ax+V[6]*ay+V[10]*az+V[14];
    const bvx=V[0]*bx+V[4]*by+V[8]*bz+V[12], bvy=V[1]*bx+V[5]*by+V[9]*bz+V[13], bvz=V[2]*bx+V[6]*by+V[10]*bz+V[14];
    if (avz >= nearZ || bvz >= nearZ) continue;   // either endpoint behind camera — skip
    const [x0,y0] = projView(avx,avy,avz);
    const [x1,y1] = projView(bvx,bvy,bvz);
    segs.push(x0,y0,x1,y1);
  }
  const out = new Float32Array(segs);
  post({ type:'debugRawEdgesResult', segs: out, w:W, h:H }, [out.buffer]);
}

/* ---------------- debug: raw contour edges (topological silhouette, chained) ----------------
   Same "bypass almost everything" spirit as generateRawEdges above, but
   selects edges by the Contour layer's own classification test (isSilTopo
   in generate()) instead of the crease-angle threshold, and walks them into
   chains via the exact same welded-vertex-incidence + pairJunctionArms
   mechanism generate()'s siChains uses — so the output shows the raw chain
   topology feeding Contour. No occlusion, no backdrop test, no dedup: each
   chain is emitted as one continuous polyline, broken only where an edge has
   an endpoint behind the camera (the same "simple bypass" behavior
   generateRawEdges uses, just per-chain instead of per-edge). */
function generateRawContourEdges(cam){
  if (!M){ post({ type:'error', msg:'No model loaded' }); return; }
  const { view:V, proj:P, w:W, h:H, near } = cam;
  const ortho = !!cam.ortho;
  const nearZ = -near * 1.0001;
  const { pos, fn, tri, nv, nt, ea, eb, et0, et1, ne } = M;
  const projView = (a,b,c) => {
    const cx=P[0]*a+P[4]*b+P[8]*c+P[12], cy=P[1]*a+P[5]*b+P[9]*c+P[13],
          cw=P[3]*a+P[7]*b+P[11]*c+P[15];
    return [(cx/cw*0.5+0.5)*W, (0.5-cy/cw*0.5)*H];
  };
  const vx=new Float32Array(nv), vy=new Float32Array(nv), vz=new Float32Array(nv);
  for (let i=0;i<nv;i++){
    const x=pos[i*3], y=pos[i*3+1], z=pos[i*3+2];
    vx[i]=V[0]*x+V[4]*y+V[8]*z+V[12]; vy[i]=V[1]*x+V[5]*y+V[9]*z+V[13]; vz[i]=V[2]*x+V[6]*y+V[10]*z+V[14];
  }
  // per-face front/back facing — same test as generate()'s own step 2
  const EPS_FRONT_TIE = 1e-6;
  const front = new Uint8Array(nt);
  for (let f=0; f<nt; f++){
    const nx=fn[f*3], ny=fn[f*3+1], nz=fn[f*3+2];
    const nvx=V[0]*nx+V[4]*ny+V[8]*nz, nvy=V[1]*nx+V[5]*ny+V[9]*nz, nvz=V[2]*nx+V[6]*ny+V[10]*nz;
    const a=tri[f*3], b=tri[f*3+1], c=tri[f*3+2];
    const cx=(vx[a]+vx[b]+vx[c])/3, cy=(vy[a]+vy[b]+vy[c])/3, cz=(vz[a]+vz[b]+vz[c])/3;
    front[f] = ortho ? (nvz > EPS_FRONT_TIE ? 1 : 0) : ((nvx*cx + nvy*cy + nvz*cz) < 0 ? 1 : 0);
  }
  // isSilTopo — same test as generate()'s Contour section (6.3)
  const isSilTopo = new Uint8Array(ne);
  for (let e=0; e<ne; e++){
    const t1x = et1[e];
    if (t1x >= 0){ if (front[et0[e]] !== front[t1x]) isSilTopo[e]=1; }
    else isSilTopo[e]=1;   // open/non-manifold edge
  }
  // chain adjacency: two isSilTopo edges connect iff they share a welded
  // vertex; at a junction (valence 3+) pairJunctionArms picks which pair
  // continues straight through — identical to generate()'s siCont0/siCont1.
  const siCont0 = new Int32Array(ne).fill(-1), siCont1 = new Int32Array(ne).fill(-1);
  {
    const incident = new Map();
    for (let e=0;e<ne;e++){
      if (!isSilTopo[e]) continue;
      const a=ea[e], b=eb[e];
      if (a===b) continue;
      let la=incident.get(a); if(!la){la=[];incident.set(a,la);} la.push([e,0]);
      let lb=incident.get(b); if(!lb){lb=[];incident.set(b,lb);} lb.push([e,1]);
    }
    for (const [v, list] of incident){
      if (list.length < 2) continue;
      if (list.length === 2){
        const [e0,end0]=list[0], [e1,end1]=list[1];
        if (end0===0) siCont0[e0]=e1; else siCont1[e0]=e1;
        if (end1===0) siCont0[e1]=e0; else siCont1[e1]=e0;
        continue;
      }
      const arms = list.map(([e,end]) => {
        const other = end===0 ? eb[e] : ea[e];
        const dx=pos[other*3]-pos[v*3], dy=pos[other*3+1]-pos[v*3+1], dz=pos[other*3+2]-pos[v*3+2];
        const L=Math.hypot(dx,dy,dz)||1;
        return [dx/L,dy/L,dz/L];
      });
      for (const [i,j] of pairJunctionArms(arms)){
        const [ei,endi]=list[i], [ej,endj]=list[j];
        if (endi===0) siCont0[ei]=ej; else siCont1[ei]=ej;
        if (endj===0) siCont0[ej]=ei; else siCont1[ej]=ei;
      }
    }
  }
  const chains = [];
  {
    const visited = new Uint8Array(ne);
    const walk = (startE, startRev) => {
      const edges=[]; let curE=startE, curRev=startRev;
      for(;;){
        edges.push({e:curE, rev:curRev});
        visited[curE]=1;
        const arriveV = curRev ? ea[curE] : eb[curE];
        const nextE = curRev ? siCont0[curE] : siCont1[curE];
        if (nextE===-1) return edges;
        if (visited[nextE]) return edges;
        curRev = eb[nextE]===arriveV;
        curE = nextE;
      }
    };
    for (let e=0;e<ne;e++){
      if (!isSilTopo[e] || visited[e]) continue;
      if (siCont0[e]===-1){ chains.push(walk(e,false)); continue; }
      if (siCont1[e]===-1){ chains.push(walk(e,true));  continue; }
    }
    for (let e=0;e<ne;e++){
      if (!isSilTopo[e] || visited[e]) continue;
      chains.push(walk(e,false));
    }
  }
  // project each chain in walk order into one flat polyline of screen
  // points, breaking (and starting a fresh polyline) at any edge with an
  // endpoint behind the camera
  const chainSegs = [];
  for (const edges of chains){
    let runPts = [];
    const flush = () => { if (runPts.length>=4) chainSegs.push(new Float32Array(runPts)); runPts = []; };
    for (const {e, rev} of edges){
      const a = rev ? eb[e] : ea[e], b = rev ? ea[e] : eb[e];
      if (vz[a] >= nearZ || vz[b] >= nearZ){ flush(); continue; }
      if (!runPts.length){
        const [xa,ya] = projView(vx[a],vy[a],vz[a]);
        runPts.push(xa,ya);
      }
      const [xb,yb] = projView(vx[b],vy[b],vz[b]);
      runPts.push(xb,yb);
    }
    flush();
  }
  post({ type:'debugRawContourEdgesResult', chains: chainSegs, w:W, h:H }, chainSegs.map(c => c.buffer));
}
/* ---------------- message dispatch ---------------- */
if (typeof self !== 'undefined' && typeof self.document === 'undefined'){
  self.onmessage = ev => {
    const m = ev.data;
    try {
      if (m.type === 'load' || m.type === 'demo'){
        let parsed;
        if (m.type === 'demo') parsed = { soup: demoSoup(), objId: null };
        else {
          const name = (m.name||'').toLowerCase();
          if (name.endsWith('.obj')) parsed = parseOBJ(m.buffer);
          else if (name.endsWith('.stl')) parsed = { soup: parseSTL(m.buffer), objId: null };
          else {
            const peek = new TextDecoder().decode(new Uint8Array(m.buffer, 0, Math.min(2048, m.buffer.byteLength)));
            parsed = /\nv\s/.test(peek) ? parseOBJ(m.buffer) : { soup: parseSTL(m.buffer), objId: null };
          }
          // Z-up file → internal Y-up: rotate −90° about X, i.e. (x,y,z) →
          // (x, z, −y). Proper rotation (det +1), so winding/normals are
          // preserved and buildMesh sees a consistently oriented mesh.
          if (m.zUp) for (let i=0;i<parsed.soup.length;i+=3){
            const y = parsed.soup[i+1];
            parsed.soup[i+1] = parsed.soup[i+2];
            parsed.soup[i+2] = -y;
          }
        }
        const mesh = buildMesh(parsed);
        // expanded (non-indexed) copy for flat-shaded display
        const disp = new Float32Array(mesh.nt * 9);
        for (let t=0;t<mesh.nt;t++) for (let v=0;v<3;v++){
          const vi = mesh.tri[t*3+v];
          disp[t*9+v*3]=mesh.pos[vi*3]; disp[t*9+v*3+1]=mesh.pos[vi*3+1]; disp[t*9+v*3+2]=mesh.pos[vi*3+2];
        }
        // Per-corner smooth normals for the viewport's optional smooth-
        // shading display — same layout as disp (nt*9), applied directly as
        // a normal attribute rather than needing a separate indexed
        // geometry. A COPY, not the original: mesh IS the module-level M
        // (buildMesh assigns it directly), so transferring the real cn
        // buffer would detach it and break the solver's own use of it in
        // every later generate.
        const cnCopy = mesh.cn.slice();
        post({ type:'loaded', name: m.name||'demo scene', stats: mesh.stats,
               center: mesh.center, radius: mesh.radius, bboxMinY: mesh.bbox[1], display: disp,
               cornerNormals: cnCopy },
             [disp.buffer, cnCopy.buffer]);
      } else if (m.type === 'generate'){
        generate(m.cam, m.settings, m.shadingBuffer);
      } else if (m.type === 'debugRawEdges'){
        generateRawEdges(m.cam, m.creaseDeg);
      } else if (m.type === 'debugRawContourEdges'){
        generateRawContourEdges(m.cam);
      } else if (m.type === 'recomputeSmoothAngle'){
        // Re-runs ONLY the corner-normal fan grouping with a new hard-edge
        // threshold — every input it needs is already sitting in M from the
        // initial buildMesh() call, so this skips the far more expensive
        // weld/adjacency/shell work entirely. Updates M.cn in place so any
        // later generate() (Circle-shadow smoothing) picks it up for free,
        // and also ships a copy back for the viewport's live display —
        // same "copy, don't transfer the real one" reasoning as the
        // 'loaded' cornerNormals above.
        if (M){
          M.cn = computeCornerNormals(M.nv, M.nt, M.tri, M.pos, M.fn, M.ea, M.eb, M.et0, M.et1, M.eang, m.hardEdgeDeg);
          const cnCopy = M.cn.slice();
          post({ type:'smoothAngleResult', cornerNormals: cnCopy }, [cnCopy.buffer]);
        }
      } else if (m.type === 'testShadingSample'){
        // Phase 2 round-trip test — see testShadingBufferRoundTrip in
        // panel-controls.js. Samples the SAME buffer the main thread also
        // sampled directly (bilinear, no transfer/flip involved), so the
        // two result sets can be compared for agreement — validates both
        // the transfer+flip mechanism and sampleShading's own math in one
        // pass, without needing to render or affect any real output.
        flipBufferRowsY(m.pixels, m.w, m.h);
        const values = m.points.map(([sx, sy]) => sampleShading(m.pixels, m.w, m.h, sx, sy));
        post({ type: 'testShadingSampleResult', values });
      }
    } catch (err){
      post({ type:'error', msg: String(err && err.message || err) });
    }
  };
}
