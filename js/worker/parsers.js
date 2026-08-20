/* ================================================================
   worker/parsers.js — mesh input: STL, OBJ, demo scene
   Pure functions, no shared state: given raw file bytes (or nothing,
   for demoSoup) each returns a flat triangle soup for buildMesh to
   weld — see mesh.js.
   ================================================================ */
/* ---------------- file parsing ---------------- */
export function parseSTL(buf){
  const u8 = new Uint8Array(buf);
  let ascii = false;
  const head = new TextDecoder().decode(u8.subarray(0, Math.min(512, u8.length)));
  if (/^\s*solid/i.test(head)){
    ascii = true;
    if (buf.byteLength >= 84){
      const n = new DataView(buf).getUint32(80, true);
      if (84 + n * 50 === buf.byteLength) ascii = false;  // binary that starts with "solid"
    }
  }
  if (!ascii){
    if (buf.byteLength < 84) throw new Error('STL file too small');
    const dv = new DataView(buf);
    const n = dv.getUint32(80, true);
    if (84 + n * 50 > buf.byteLength) throw new Error('Corrupt binary STL (triangle count mismatch)');
    const out = new Float32Array(n * 9);
    let o = 84, k = 0;
    for (let i = 0; i < n; i++){
      o += 12;                                            // skip stored facet normal
      for (let j = 0; j < 9; j++){ out[k++] = dv.getFloat32(o, true); o += 4; }
      o += 2;                                             // attribute byte count
    }
    return out;
  }
  const text = new TextDecoder().decode(u8);
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  const arr = []; let m;
  while ((m = re.exec(text))) arr.push(+m[1], +m[2], +m[3]);
  arr.length -= arr.length % 9;
  return new Float32Array(arr);
}

export function parseOBJ(buf){
  const text = new TextDecoder().decode(new Uint8Array(buf));
  const v = [], soup = [], objId = [];
  // Tracks which source OBJ object (`o` line) each emitted triangle came
  // from — buildMesh uses this to weld vertices PER OBJECT rather than
  // globally, so touching-but-distinct manifold objects (e.g. a mosaic of
  // separately-modeled shapes placed edge-to-edge) never get fused into a
  // shared, falsely non-manifold edge at their boundary. No `o` lines at
  // all → every triangle stays object 0 → identical to the old global-weld
  // behavior, so plain single-object files are unaffected.
  let curObj = 0, sawO = false;
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++){
    const line = lines[li];
    if (line.length < 3) continue;
    const c0 = line.charCodeAt(0), c1 = line.charCodeAt(1);
    if (c0 === 118 && (c1 === 32 || c1 === 9)){            // "v "
      const p = line.slice(2).trim().split(/\s+/);
      v.push(+p[0], +p[1], +p[2]);
    } else if (c0 === 111 && (c1 === 32 || c1 === 9)){     // "o " — new source object starts
      if (sawO) curObj++;
      sawO = true;
    } else if (c0 === 102 && (c1 === 32 || c1 === 9)){     // "f "
      const p = line.slice(2).trim().split(/\s+/);
      const idx = [];
      for (let t = 0; t < p.length; t++){
        let i = parseInt(p[t], 10);                        // takes v of v/vt/vn
        if (!i && i !== 0) continue;
        i = i > 0 ? i - 1 : v.length / 3 + i;
        if (i >= 0 && i < v.length / 3) idx.push(i);
      }
      for (let k = 2; k < idx.length; k++){                // fan-triangulate n-gons
        const a = idx[0], b = idx[k-1], c = idx[k];
        soup.push(v[a*3],v[a*3+1],v[a*3+2], v[b*3],v[b*3+1],v[b*3+2], v[c*3],v[c*3+1],v[c*3+2]);
        objId.push(curObj);
      }
    }
  }
  return { soup: new Float32Array(soup), objId: new Uint32Array(objId) };
}

/* ---------------- demo mesh: torus on a pedestal ---------------- */
export function demoSoup(){
  const soup = [];
  const quad = (p0,p1,p2,p3) => { soup.push(...p0,...p1,...p2, ...p0,...p2,...p3); };
  // torus: R=1, r=0.42, axis Y
  const R=1.0, r=0.42, NU=30, NV=15, TY=0.35;
  const tp = (i,j) => {
    const th = i/NU*2*Math.PI, ph = j/NV*2*Math.PI;
    const w = R + r*Math.cos(ph);
    return [w*Math.cos(th), r*Math.sin(ph)+TY, w*Math.sin(th)];
  };
  for (let i=0;i<NU;i++) for (let j=0;j<NV;j++)
    quad(tp(i,j), tp(i,j+1), tp(i+1,j+1), tp(i+1,j));
  // pedestal box
  const hx=1.55, y0=-0.62, y1=-0.28, hz=1.55;
  const c = (x,y,z)=>[x,y,z];
  const A=c(-hx,y0,-hz),B=c(hx,y0,-hz),C=c(hx,y0,hz),D=c(-hx,y0,hz);
  const E=c(-hx,y1,-hz),F=c(hx,y1,-hz),G=c(hx,y1,hz),H=c(-hx,y1,hz);
  quad(A,B,C,D); quad(H,G,F,E);           // bottom, top
  quad(E,F,B,A); quad(F,G,C,B);           // sides
  quad(G,H,D,C); quad(H,E,A,D);
  return new Float32Array(soup);
}
