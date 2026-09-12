/* ================================================================
   tools/harness/raster.mjs — look at the output, not just count it
   A tiny anti-aliased line rasterizer + PNG writer, so a harness run
   can be eyeballed (and diffed against a screenshot) without a browser
   or any image library. Deliberately minimal: solver-px in, PNG out.
   Not part of the app pipeline — purely a debugging aid.
   ================================================================ */
import { deflateSync } from 'node:zlib';

export class Raster {
  /* `box` is the solver-px region to draw, `scale` output px per solver px. */
  constructor(box, scale = 1, pad = 8, bg = [251, 249, 243]){
    this.box = box; this.scale = scale; this.pad = pad;
    this.w = Math.max(1, Math.ceil((box.x1 - box.x0) * scale) + pad*2);
    this.h = Math.max(1, Math.ceil((box.y1 - box.y0) * scale) + pad*2);
    this.px = new Uint8Array(this.w * this.h * 3);
    for (let i = 0; i < this.w*this.h; i++){
      this.px[i*3] = bg[0]; this.px[i*3+1] = bg[1]; this.px[i*3+2] = bg[2];
    }
  }
  _to(x, y){
    return [ (x - this.box.x0) * this.scale + this.pad,
             (y - this.box.y0) * this.scale + this.pad ];
  }
  _blend(x, y, rgb, a){
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y*this.w + x)*3, k = Math.min(1, a);
    for (let c = 0; c < 3; c++) this.px[i+c] = Math.round(this.px[i+c]*(1-k) + rgb[c]*k);
  }
  /* Thick anti-aliased line: stamps a round brush of radius `width/2`
     along the segment. Slow and simple — fine at these sizes. */
  line(x0, y0, x1, y1, rgb = [0,0,0], width = 1){
    const [ax, ay] = this._to(x0, y0), [bx, by] = this._to(x1, y1);
    const r = Math.max(0.5, width/2);
    const minX = Math.floor(Math.min(ax,bx) - r - 1), maxX = Math.ceil(Math.max(ax,bx) + r + 1);
    const minY = Math.floor(Math.min(ay,by) - r - 1), maxY = Math.ceil(Math.max(ay,by) + r + 1);
    const dx = bx-ax, dy = by-ay, L2 = dx*dx + dy*dy;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++){
      const px = x+0.5, py = y+0.5;
      let t = L2 > 1e-12 ? ((px-ax)*dx + (py-ay)*dy)/L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax+t*dx), py - (ay+t*dy));
      this._blend(x, y, rgb, Math.max(0, Math.min(1, r + 0.5 - d)));
    }
  }
  segs(flat, rgb, width){
    for (let i = 0; i < flat.length; i += 4) this.line(flat[i], flat[i+1], flat[i+2], flat[i+3], rgb, width);
  }
  circle(cx, cy, rSolver, rgb = [224,32,32], width = 1.5){
    const [x, y] = this._to(cx, cy), r = rSolver * this.scale;
    const N = Math.max(24, Math.ceil(r));
    for (let i = 0; i < N; i++){
      const a0 = i/N*2*Math.PI, a1 = (i+1)/N*2*Math.PI;
      const ax = x + r*Math.cos(a0), ay = y + r*Math.sin(a0);
      const bx = x + r*Math.cos(a1), by = y + r*Math.sin(a1);
      const r2 = Math.max(0.5, width/2);
      const minX=Math.floor(Math.min(ax,bx)-r2-1), maxX=Math.ceil(Math.max(ax,bx)+r2+1);
      const minY=Math.floor(Math.min(ay,by)-r2-1), maxY=Math.ceil(Math.max(ay,by)+r2+1);
      const dx=bx-ax, dy=by-ay, L2=dx*dx+dy*dy;
      for (let yy=minY; yy<=maxY; yy++) for (let xx=minX; xx<=maxX; xx++){
        const px=xx+0.5, py=yy+0.5;
        let t = L2>1e-12 ? ((px-ax)*dx+(py-ay)*dy)/L2 : 0; t = Math.max(0,Math.min(1,t));
        const d = Math.hypot(px-(ax+t*dx), py-(ay+t*dy));
        this._blend(xx, yy, rgb, Math.max(0, Math.min(1, r2 + 0.5 - d)));
      }
    }
  }
  png(){
    const raw = Buffer.alloc((this.w*3 + 1) * this.h);
    for (let y = 0; y < this.h; y++){
      raw[y*(this.w*3+1)] = 0;                                   // filter: none
      Buffer.from(this.px.buffer, y*this.w*3, this.w*3).copy(raw, y*(this.w*3+1)+1);
    }
    const crcTable = (() => {
      const t = new Int32Array(256);
      for (let n = 0; n < 256; n++){ let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c; }
      return t;
    })();
    const crc = buf => { let c = -1;
      for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
      return (c ^ -1) >>> 0; };
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td));
      return Buffer.concat([len, td, cr]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGB
    return Buffer.concat([
      Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),
      chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

export function bboxOf(...arrays){
  let x0=Infinity, y0=Infinity, x1=-Infinity, y1=-Infinity;
  for (const a of arrays) for (let i=0;i<a.length;i+=2){
    x0=Math.min(x0,a[i]); x1=Math.max(x1,a[i]); y0=Math.min(y0,a[i+1]); y1=Math.max(y1,a[i+1]);
  }
  return { x0, y0, x1, y1 };
}
