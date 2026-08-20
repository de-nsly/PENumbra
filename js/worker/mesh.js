/* ================================================================
   worker/mesh.js — mesh state: weld · adjacency · corner normals
   Owns the module-level M (parsed+welded mesh state, rebuilt only on
   load/demo — see buildMesh) and computeCornerNormals, the per-corner
   smooth-normal pass buildMesh also uses internally, re-run standalone
   by solver.js on 'recomputeSmoothAngle'.
   ================================================================ */
export let M = null;                 // mesh state
/* ---------------- weld · validate · adjacency ---------------- */
// Per-corner smooth normals — one normal per (triangle, local vertex 0/1/2),
// matching the flat display buffer's own layout, rather than one per vertex
// position. That's necessary because a vertex sitting on a hard edge
// legitimately needs DIFFERENT normals depending on which face is asking —
// impossible to express with a single normal per vertex id.
//
// For each vertex, triangles touching it are grouped into "smooth fans" via
// union-find, merging across an edge only when its dihedral angle (eang,
// already in degrees) is below hardEdgeDeg — user-adjustable via the Smooth
// Shading angle slider, deliberately NOT tied to the Crease angle slider,
// which decides which edges get DRAWN, a completely separate concern from
// which edges should block normal smoothing here. Within each fan, face
// normals are combined weighted by the angle each face actually subtends at
// that vertex (not a flat unweighted sum) — the standard fix for small/thin
// triangles and uneven vertex valence otherwise skewing the result, the
// same technique behind Blender's own "smooth by angle" shading.
//
// Pulled out as its own function (rather than inline in buildMesh) so it
// can be re-run cheaply whenever the angle slider changes, without redoing
// the weld/adjacency computation buildMesh also does — every argument here
// is already sitting in M after the initial build, unchanged for the whole
// lifetime of the loaded model.
export function computeCornerNormals(nv, nt, tri, pos, fn, ea, eb, et0, et1, eang, hardEdgeDeg){
  const vTris = Array.from({ length: nv }, () => []);
  for (let t = 0; t < nt; t++) for (let c = 0; c < 3; c++) vTris[tri[t*3+c]].push(t*3+c);
  const vEdges = Array.from({ length: nv }, () => []);
  for (let e = 0; e < ea.length; e++){ vEdges[ea[e]].push(e); vEdges[eb[e]].push(e); }

  const cn = new Float32Array(nt * 9);
  for (let v = 0; v < nv; v++){
    const corners = vTris[v];               // t*3+corner entries touching this vertex
    const k = corners.length;
    if (k === 0) continue;
    const trisAtV = corners.map(tc => (tc / 3) | 0);
    const localOf = new Map();
    for (let i = 0; i < k; i++) localOf.set(trisAtV[i], i);
    const parent = new Int32Array(k);
    for (let i = 0; i < k; i++) parent[i] = i;
    const find = i => { while (parent[i] !== i){ parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (const e of vEdges[v]){
      if (eang[e] >= hardEdgeDeg) continue;               // hard edge — never merge across it
      const t0 = et0[e], t1 = et1[e];
      if (t0 < 0 || t1 < 0) continue;                     // boundary edge — nothing on the other side
      const i0 = localOf.get(t0), i1 = localOf.get(t1);
      if (i0 === undefined || i1 === undefined) continue; // neither touches v — not our concern here
      const r0 = find(i0), r1 = find(i1);
      if (r0 !== r1) parent[r0] = r1;
    }
    const fanSum = new Map();                             // root -> [sx,sy,sz]
    for (let i = 0; i < k; i++){
      const t = trisAtV[i];
      const a0 = tri[t*3], a1 = tri[t*3+1], a2 = tri[t*3+2];
      const ov0 = a0 === v ? a1 : a0, ov1 = a2 === v ? a1 : a2;   // the triangle's other two vertices
      const e0x=pos[ov0*3]-pos[v*3], e0y=pos[ov0*3+1]-pos[v*3+1], e0z=pos[ov0*3+2]-pos[v*3+2];
      const e1x=pos[ov1*3]-pos[v*3], e1y=pos[ov1*3+1]-pos[v*3+1], e1z=pos[ov1*3+2]-pos[v*3+2];
      const l0 = Math.hypot(e0x,e0y,e0z) || 1, l1 = Math.hypot(e1x,e1y,e1z) || 1;
      const dot = Math.max(-1, Math.min(1, (e0x*e1x+e0y*e1y+e0z*e1z)/(l0*l1)));
      const angle = Math.acos(dot);                       // angle this face subtends at v — the weight
      const root = find(i);
      if (!fanSum.has(root)) fanSum.set(root, [0,0,0]);
      const s = fanSum.get(root);
      s[0] += fn[t*3]*angle; s[1] += fn[t*3+1]*angle; s[2] += fn[t*3+2]*angle;
    }
    const fanNormal = new Map();
    for (const [root, s] of fanSum){
      const l = Math.hypot(s[0], s[1], s[2]) || 1;
      fanNormal.set(root, [s[0]/l, s[1]/l, s[2]/l]);
    }
    for (let i = 0; i < k; i++){
      const n = fanNormal.get(find(i));
      const tc = corners[i];
      cn[tc*3]=n[0]; cn[tc*3+1]=n[1]; cn[tc*3+2]=n[2];
    }
  }
  return cn;
}
const DEFAULT_HARD_EDGE_DEG = 30;
export function buildMesh(input){
  const soup = input.soup;
  const objId = input.objId || null;
  const nIn = (soup.length / 9) | 0;
  if (!nIn) throw new Error('No triangles found in file');
  // objId: one entry per input triangle, which source OBJ object (`o` line)
  // it came from. Missing/absent (STL, the demo mesh, or an OBJ with no `o`
  // lines at all) means "everything is one object" — a zero-filled array
  // reproduces the previous global-weld behavior exactly, so single-object
  // files are unaffected by this.
  const oid = objId && objId.length === nIn ? objId : new Uint32Array(nIn);

  // bounding box → relative weld tolerance
  let x0=1/0,y0=1/0,z0=1/0,x1=-1/0,y1=-1/0,z1=-1/0;
  for (let i = 0; i < soup.length; i += 3){
    const x=soup[i],y=soup[i+1],z=soup[i+2];
    if (x<x0)x0=x; if (x>x1)x1=x; if (y<y0)y0=y; if (y>y1)y1=y; if (z<z0)z0=z; if (z>z1)z1=z;
  }
  const diag = Math.hypot(x1-x0, y1-y0, z1-z0) || 1;
  const tol  = diag * 1e-5;

  // weld coincident vertices (spatial hash on rounded coords). Keyed by
  // source object id FIRST, position second — vertices only ever merge with
  // other vertices from the SAME source object, never across objects, so
  // two independently-manifold objects that happen to touch (coincident
  // boundary vertices/edges, e.g. a mosaic of shapes placed edge-to-edge)
  // never get fused into one shared, falsely non-manifold edge. Files with
  // no object structure (STL, or an OBJ with no `o` lines) fall back to oid
  // being all-zero, i.e. everything is "object 0" — identical to the
  // previous global-weld behavior.
  // NOTE: a numeric-hash + collision-verification variant was tried and
  // benchmarked (cold, 50k tris): identical timing to the string keys —
  // V8 handles short string map keys well — so the simpler version stays.
  const vmap = new Map();
  const pos = [];
  const sIdx = new Uint32Array(nIn * 3);
  for (let i = 0; i < nIn * 3; i++){
    const x=soup[i*3], y=soup[i*3+1], z=soup[i*3+2];
    const key = oid[(i/3)|0] + '_' + Math.round(x/tol) + ',' + Math.round(y/tol) + ',' + Math.round(z/tol);
    let vi = vmap.get(key);
    if (vi === undefined){ vi = pos.length / 3; pos.push(x,y,z); vmap.set(key, vi); }
    sIdx[i] = vi;
  }

  // drop degenerate triangles
  const tri = [];
  const minCross = diag * diag * 1e-12;
  for (let t = 0; t < nIn; t++){
    const a=sIdx[t*3], b=sIdx[t*3+1], c=sIdx[t*3+2];
    if (a===b || b===c || a===c) continue;
    const ax=pos[a*3],ay=pos[a*3+1],az=pos[a*3+2];
    const ux=pos[b*3]-ax, uy=pos[b*3+1]-ay, uz=pos[b*3+2]-az;
    const wx=pos[c*3]-ax, wy=pos[c*3+1]-ay, wz=pos[c*3+2]-az;
    const cx=uy*wz-uz*wy, cy=uz*wx-ux*wz, cz=ux*wy-uy*wx;
    if (Math.hypot(cx,cy,cz) < minCross) continue;
    tri.push(a,b,c);
  }
  const nt = tri.length / 3;
  if (!nt) throw new Error('All triangles degenerate after welding');
  const nv = pos.length / 3;
  if (nv >= 16777216) throw new Error('Model too large');

  // undirected edge map: key -> [triIndex<<1 | dirFlag, ...]
  const ekey = (a,b) => (a < b ? a * 16777216 + b : b * 16777216 + a);
  const emap = new Map();
  const addEdge = (u, v, t) => {
    const k = ekey(u, v), f = u < v ? 0 : 1;
    const arr = emap.get(k);
    if (arr) arr.push((t << 1) | f); else emap.set(k, [(t << 1) | f]);
  };
  for (let t = 0; t < nt; t++){
    const a=tri[t*3], b=tri[t*3+1], c=tri[t*3+2];
    addEdge(a,b,t); addEdge(b,c,t); addEdge(c,a,t);
  }

  // winding-consistency BFS (flip triangles to match neighbors)
  const flip = new Uint8Array(nt), seen = new Uint8Array(nt);
  const comp = new Int32Array(nt);
  let flips = 0, nComp = 0;
  const triEdgeKeys = t => {
    const a=tri[t*3], b=tri[t*3+1], c=tri[t*3+2];
    return [ekey(a,b), ekey(b,c), ekey(c,a)];
  };
  const stack = [];
  for (let s = 0; s < nt; s++){
    if (seen[s]) continue;
    const cid = nComp++;
    comp[s] = cid;
    seen[s] = 1; stack.length = 0; stack.push(s);
    while (stack.length){
      const t = stack.pop();
      const keys = triEdgeKeys(t);
      for (let e = 0; e < 3; e++){
        const arr = emap.get(keys[e]);
        if (!arr || arr.length !== 2) continue;            // boundary / non-manifold: don't traverse
        const o = (arr[0] >> 1) === t ? arr[1] : arr[0];
        const ot = o >> 1;
        if (seen[ot]) continue;
        const self_ = (arr[0] >> 1) === t ? arr[0] : arr[1];
        const effT = (self_ & 1) ^ flip[t];
        const effO = (o & 1) ^ flip[ot];
        if (effT === effO){ flip[ot] = 1; flips++; }       // same direction ⇒ neighbor is flipped
        comp[ot] = cid;
        seen[ot] = 1; stack.push(ot);
      }
    }
  }
  for (let t = 0; t < nt; t++) if (flip[t]){
    const tmp = tri[t*3+1]; tri[t*3+1] = tri[t*3+2]; tri[t*3+2] = tmp;
  }

  // global orientation: winding BFS only makes shells self-consistent — they can
  // still be consistently INWARD, which would invert culling and hatch brightness.
  // Signed volume per closed component decides; open/non-manifold shells are left alone.
  const compOpen = new Uint8Array(nComp);
  for (const arr of emap.values())
    if (arr.length !== 2) for (const it of arr) compOpen[comp[it >> 1]] = 1;
  const compVol = new Float64Array(nComp);
  for (let t = 0; t < nt; t++){
    const a=tri[t*3]*3, b=tri[t*3+1]*3, c=tri[t*3+2]*3;
    compVol[comp[t]] +=
      pos[a]*(pos[b+1]*pos[c+2]-pos[b+2]*pos[c+1]) -
      pos[a+1]*(pos[b]*pos[c+2]-pos[b+2]*pos[c]) +
      pos[a+2]*(pos[b]*pos[c+1]-pos[b+1]*pos[c]);
  }
  let reoriented = 0;
  const volFlip = new Uint8Array(nComp);
  for (let c = 0; c < nComp; c++)
    if (!compOpen[c] && compVol[c] < 0){ volFlip[c] = 1; reoriented++; }
  if (reoriented)
    for (let t = 0; t < nt; t++) if (volFlip[comp[t]]){
      const tmp = tri[t*3+1]; tri[t*3+1] = tri[t*3+2]; tri[t*3+2] = tmp;
    }

  // face normals (post-flip)
  const fn = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++){
    const a=tri[t*3], b=tri[t*3+1], c=tri[t*3+2];
    const ax=pos[a*3],ay=pos[a*3+1],az=pos[a*3+2];
    const ux=pos[b*3]-ax, uy=pos[b*3+1]-ay, uz=pos[b*3+2]-az;
    const wx=pos[c*3]-ax, wy=pos[c*3+1]-ay, wz=pos[c*3+2]-az;
    let cx=uy*wz-uz*wy, cy=uz*wx-ux*wz, cz=ux*wy-uy*wx;
    const l = Math.hypot(cx,cy,cz) || 1;
    fn[t*3]=cx/l; fn[t*3+1]=cy/l; fn[t*3+2]=cz/l;
  }

  // final edge list with dihedral angles (crease classification data, view-independent)
  const ea=[], eb=[], et0=[], et1=[], eang=[];
  let boundary = 0, nonManifold = 0;
  for (const [k, arr] of emap){
    const a = Math.floor(k / 16777216), b = k % 16777216;
    if (arr.length === 2){
      const t0 = arr[0] >> 1, t1 = arr[1] >> 1;
      const d = fn[t0*3]*fn[t1*3] + fn[t0*3+1]*fn[t1*3+1] + fn[t0*3+2]*fn[t1*3+2];
      ea.push(a); eb.push(b); et0.push(t0); et1.push(t1);
      eang.push(Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI);
    } else {                                               // 1 → boundary; 3+ → non-manifold, treat as boundary-like
      if (arr.length === 1) boundary++; else nonManifold++;
      ea.push(a); eb.push(b); et0.push(arr[0] >> 1); et1.push(-1); eang.push(0);
    }
  }

  // Per-corner smooth normals — see computeCornerNormals's own comment for
  // why this is a separate, re-runnable function rather than inline here.
  const cn = computeCornerNormals(nv, nt, tri, pos, fn, ea, eb, et0, et1, eang, DEFAULT_HARD_EDGE_DEG);

  M = {
    nv, nt,
    pos: new Float32Array(pos),
    tri: new Uint32Array(tri),
    fn, cn,
    comp, nComp,
    ne: ea.length,
    ea: new Uint32Array(ea), eb: new Uint32Array(eb),
    et0: new Int32Array(et0), et1: new Int32Array(et1),
    eang: new Float32Array(eang),
    stats: { trisIn: nIn, tris: nt, verts: nv, boundary, nonManifold, flips, reoriented, shells: nComp },
    bbox: [x0, y0, z0, x1, y1, z1],
    center: [(x0+x1)/2, (y0+y1)/2, (z0+z1)/2],
    radius: diag / 2
  };
  return M;
}
