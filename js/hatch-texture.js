/* ================================================================
   hatch-texture.js — the texture filter implementations
   What a layer's texture stack actually does to its geometry.
   TEXTURE_FILTERS (layers.js) declares the filter types and their
   parameters; this file holds the code behind each one and the single
   entry point render-result.js calls, applyTextureStack(input, stack,
   ctx), which walks a stack in order and dispatches each entry to the
   implementation for that geometry representation (TEXTURE_IMPL).
   Every length parameter is authored in mm and converted with the
   caller's mmToPx.
   Three representations travel through a stack: `segments` (a hatch
   layer's flat segment list plus the per-segment carrier index, so
   fragments of one line jitter together), `arcs` (the Circles layer's
   pieces, kept as arcs and emitted as Beziers unless a filter has to
   open them) and `polylines` (what everything ends as). A filter that
   has no implementation for the current representation is skipped.
   Overshoot, spacing jitter and angle jitter on segments share their
   per-carrier random draws and run as ONE combined step
   (applyHatchTexture) at the first of them in the stack — splitting
   them apart would change the draws, and so the output.
   ================================================================ */
import { filterSupports, stackEntry } from './layers.js';
import { accumulatePathStats } from './chain.js';
/* ================= texture effects =================
   The implementations of the texture filters a fill layer's stack can
   hold (TEXTURE_FILTERS in layers.js declares their parameters). Every
   length parameter is authored in mm and converted with the caller's
   mmToPx. A hatch layer's effects run on its flat segment list (plus the
   per-segment carrier index the worker sends, so fragments of one line
   jitter together); Circles has arc-aware variants of the first few and
   shares wobble/gaps once its arcs are polylines. applyTextureStack
   (further down) runs them in the layer's stack order. */
// The family angle of a hatch layer's lines — the same angle its pass was
// solved at (layers.js: angleDeg), so the texture's along-line direction
// matches the lines it is displacing.
export function hatchFamilyAngleDeg(L){
  return +L.angleDeg || 0;
}
// Smooth 2D value noise: hash the 4 surrounding integer-grid corners
// pseudo-randomly, then smoothstep-interpolate between them. Continuous
// and deterministic — same (x,y) always gives the same value — which is
// what makes a "wobble" read as a gentle wave instead of visual static.
function hatchNoiseHash(ix, iy){
  let h = ix*374761393 + iy*668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}
function hatchNoiseSmooth(t){ return t*t*(3-2*t); }
function hatchNoise2D(x, y){
  const x0=Math.floor(x), y0=Math.floor(y), x1=x0+1, y1=y0+1;
  const sx=hatchNoiseSmooth(x-x0), sy=hatchNoiseSmooth(y-y0);
  const n00=hatchNoiseHash(x0,y0), n10=hatchNoiseHash(x1,y0);
  const n01=hatchNoiseHash(x0,y1), n11=hatchNoiseHash(x1,y1);
  const nx0 = n00 + (n10-n00)*sx, nx1 = n01 + (n11-n01)*sx;
  return nx0 + (nx1-nx0)*sy;
}
// Subdivides each segment (spacing controls how finely — a short fragment
// naturally gets fewer subdivisions than a long one) and displaces each
// interior point perpendicular to the segment by noise mapped to
// [-amp/2, amp/2], so wobble is symmetric around the original line rather
// than always pushing one direction. sharedSeed (when set) makes every
// segment sample the SAME patch of the noise field at its true position,
// so nearby lines wobble in a correlated, flowing way; without it, each
// segment draws its own large random offset into an unrelated patch of
// the same field, so neighboring lines wobble independently — real
// hand-drawn lines don't share a noise field with each other.
// Poisson-process gaps: exponential inter-gap intervals (mean = minLenPx)
// naturally give the "sometimes several breaks, sometimes just one or
// two" clustering behavior — pure chance means some stretches draw
// several short intervals in a row while others draw one long one.
// minLenPx does double duty as both that average spacing AND a hard
// floor: a total length shorter than it is left completely untouched,
// since it wouldn't statistically expect even one gap anyway. Shared by
// applyHatchGaps (generic polylines) and applyCircleGaps (circle arcs) —
// this only deals in abstract cumulative-length units, with no
// knowledge of what the underlying curve actually is, so both can use
// the exact same random-interval logic rather than duplicating it.
function generateGapIntervals(total, minLenPx, maxGapPx){
  if (maxGapPx <= 0 || minLenPx <= 0 || total < minLenPx) return null;
  const gaps = [];
  let pos = -minLenPx * Math.log(1 - Math.random());
  while (pos < total){
    const gEnd = Math.min(total, pos + Math.random()*maxGapPx);
    if (gEnd > pos) gaps.push([pos, gEnd]);
    pos = gEnd - minLenPx * Math.log(1 - Math.random());
  }
  return gaps.length ? gaps : null;
}
function applyHatchGaps(polylines, minLenPx, maxGapPx){
  if (maxGapPx <= 0 || minLenPx <= 0) return polylines;
  const out = [];
  for (const poly of polylines){
    const nPts = poly.length/2;
    const cum = [0];
    for (let i=1; i<nPts; i++){
      cum.push(cum[i-1] + Math.hypot(poly[i*2]-poly[(i-1)*2], poly[i*2+1]-poly[(i-1)*2+1]));
    }
    const total = cum[nPts-1];
    if (nPts < 2){ out.push(poly); continue; }
    const gaps = generateGapIntervals(total, minLenPx, maxGapPx);
    if (!gaps){ out.push(poly); continue; }
    let idx = 1;
    function interpAt(s){
      while (idx < nPts-1 && cum[idx] < s) idx++;
      const segLen = cum[idx]-cum[idx-1];
      const t = segLen > 1e-9 ? (s-cum[idx-1])/segLen : 0;
      return [poly[(idx-1)*2] + (poly[idx*2]-poly[(idx-1)*2])*t,
              poly[(idx-1)*2+1] + (poly[idx*2+1]-poly[(idx-1)*2+1])*t];
    }
    let onStart = 0;
    for (const [gs, ge] of gaps){
      if (gs > onStart + 1e-6){
        const first = interpAt(onStart);
        const startIdx = idx;
        const last = interpAt(gs);
        const chain = [first[0], first[1]];
        for (let k=startIdx; k<idx; k++) chain.push(poly[k*2], poly[k*2+1]);
        chain.push(last[0], last[1]);
        out.push(chain);
      } else {
        interpAt(gs);   // gap starts at/before current cursor — just advance past it
      }
      onStart = ge;
    }
    if (onStart < total - 1e-6){
      const first = interpAt(onStart);
      const startIdx = idx;
      const last = interpAt(total);
      const chain = [first[0], first[1]];
      for (let k=startIdx; k<idx; k++) chain.push(poly[k*2], poly[k*2+1]);
      chain.push(last[0], last[1]);
      out.push(chain);
    }
  }
  return out;
}
// The Wobble and Gaps stack entries of one layer as local-px parameters —
// read the same way for the hatch layers and the Circles layer in
// renderResult. Noise seeds are drawn only when "Same noise field per layer"
// is on.
function readWobbleParams(entry, mmToPx){
  const isShared = !!entry.shared;
  return {
    spacingPx: (+entry.spacing || 1) * mmToPx,
    ampPx: (+entry.amp || 0) * mmToPx,
    variationAmount: +entry.variation || 0,
    envScalePx: (+entry.varScale || 10) * mmToPx,
    sharedSeed: isShared ? [Math.random()*10000, Math.random()*10000] : null,
    sharedEnvSeed: isShared ? [Math.random()*10000, Math.random()*10000] : null,
  };
}
function readGapParams(entry, mmToPx){
  return {
    minLenPx: (+entry.spacing || 30) * mmToPx,
    maxGapPx: (+entry.max || 2) * mmToPx,
  };
}
function applyHatchWobble(segs, spacingPx, ampPx, sharedSeed, variationAmount, envScalePx, sharedEnvSeed){
  const out = [];
  const freq = 1 / Math.max(1e-6, spacingPx*3);   // noise "grid cell" spans ~3 subdivision points
  const envFreq = 1 / Math.max(1e-6, envScalePx); // one envelope cycle spans envScalePx mm
  for (let i=0; i<segs.length; i+=4){
    const x0=segs[i], y0=segs[i+1], x1=segs[i+2], y1=segs[i+3];
    const dx=x1-x0, dy=y1-y0, len=Math.hypot(dx,dy);
    if (ampPx<=0 || spacingPx<=0 || len<1e-6){ out.push([x0,y0,x1,y1]); continue; }
    const ux=dx/len, uy=dy/len, nx=-uy, ny=ux;
    const nSub = Math.max(1, Math.round(len/spacingPx));
    const offX = sharedSeed ? sharedSeed[0] : Math.random()*10000;
    const offY = sharedSeed ? sharedSeed[1] : Math.random()*10000;
    // Separate offset for the envelope noise (a different random patch of
    // the same underlying field) — so "where it wobbles" and "how much it
    // wobbles" vary independently, not always in lockstep.
    const envOffX = sharedEnvSeed ? sharedEnvSeed[0] : Math.random()*10000;
    const envOffY = sharedEnvSeed ? sharedEnvSeed[1] : Math.random()*10000;
    const poly = [];
    for (let k=0; k<=nSub; k++){
      const t = k/nSub;
      const bx = x0+dx*t, by = y0+dy*t;    // point on the straight, un-wobbled segment
      let disp = (hatchNoise2D(bx*freq+offX, by*freq+offY) - 0.5) * ampPx;
      if (variationAmount > 0){
        const env = hatchNoise2D(bx*envFreq+envOffX, by*envFreq+envOffY);
        disp *= 1 - variationAmount*(1-env);   // 0 -> always ×1 (uniform); 1 -> ranges 0..1 (can go fully calm)
      }
      poly.push(bx+nx*disp, by+ny*disp);
    }
    out.push(poly);
  }
  return out;
}
function applyHatchRegularWobble(polylines, familyAngleDeg, amplitudePx, wavelengthPx){
  if (amplitudePx <= 0 || wavelengthPx <= 0) return polylines;
  const rad = familyAngleDeg * Math.PI/180;
  const dirX = Math.cos(rad), dirY = Math.sin(rad);   // family's shared along-line axis
  const nx = -dirY, ny = dirX;                         // perpendicular — same displacement direction as noise wobble
  const targetSpacing = wavelengthPx / 12;              // ~12 samples per wave, so the curve reads smoothly
  const out = [];
  for (const poly of polylines){
    const nPts = poly.length/2;
    if (nPts < 2){ out.push(poly); continue; }
    const newPoly = [];
    for (let i=0; i<nPts-1; i++){
      const x0=poly[i*2], y0=poly[i*2+1], x1=poly[(i+1)*2], y1=poly[(i+1)*2+1];
      const segLen = Math.hypot(x1-x0, y1-y0);
      const nSub = Math.max(1, Math.ceil(segLen/targetSpacing));
      for (let k=(i===0?0:1); k<=nSub; k++){
        const t = k/nSub;
        const bx = x0+(x1-x0)*t, by = y0+(y1-y0)*t;
        const proj = bx*dirX + by*dirY;
        const disp = amplitudePx * Math.sin(2*Math.PI*proj/wavelengthPx);
        newPoly.push(bx+nx*disp, by+ny*disp);
      }
    }
    out.push(newPoly);
  }
  return out;
}
// Constant (non-random) trim/extend applied to both ends of every hatch
// segment before the rest of the texture stack runs. Negative shortens
// each end by |trimPx| (a segment shorter than 2*|trimPx| would invert,
// so it's dropped entirely instead); positive extends each end outward
// by trimPx, unconditionally. carrierIdx is filtered in lockstep with
// segs — dropping a segment must drop its corresponding carrier entry
// too, or applyHatchTexture's index-based lookup would silently
// misattribute every segment after the first dropped one.
function applyHatchTrimExtend(segs, carrierIdx, trimPx){
  if (trimPx === 0) return { segs, carrierIdx };
  const outSegs = [];
  const outCarrier = carrierIdx ? [] : null;
  for (let i = 0, si = 0; i < segs.length; i += 4, si++){
    const x0=segs[i], y0=segs[i+1], x1=segs[i+2], y1=segs[i+3];
    const dx=x1-x0, dy=y1-y0, len=Math.hypot(dx,dy);
    if (len < 1e-6) continue;
    const ux=dx/len, uy=dy/len;
    if (len + 2*trimPx <= 0) continue;   // would collapse/invert — drop entirely
    outSegs.push(x0-ux*trimPx, y0-uy*trimPx, x1+ux*trimPx, y1+uy*trimPx);
    if (outCarrier) outCarrier.push(carrierIdx[si]);
  }
  return { segs: new Float32Array(outSegs), carrierIdx: outCarrier };
}
// Overshoot, spacing jitter and angle jitter, from the layer's stack.
function applyHatchTexture(segs, carrierIdx, familyAngleDeg, mmToPx, stack){
  const overshoot = stackEntry(stack, 'overshoot');
  const spacing = stackEntry(stack, 'spacingJitter');
  const angle = stackEntry(stack, 'angleJitter');
  const overshootOn = !!overshoot, spacingOn = !!spacing, angleOn = !!angle;
  const oMin = overshootOn ? (+overshoot.min || 0) * mmToPx : 0;
  const oMax = overshootOn ? (+overshoot.max || 0) * mmToPx : 0;
  const sMin = spacingOn ? (+spacing.min || 0) * mmToPx : 0;
  const sMax = spacingOn ? (+spacing.max || 0) * mmToPx : 0;
  const aMin = angleOn ? (+angle.min || 0) : 0;
  const aMax = angleOn ? (+angle.max || 0) : 0;
  if (!overshootOn && !spacingOn && !angleOn) return segs;   // all off — skip untouched
  const rad = familyAngleDeg * Math.PI/180;
  const nx = -Math.sin(rad), ny = Math.cos(rad);          // hatch family's shared normal direction
  // One shared jitter draw per unique carrier line — fragments of the same
  // original line (split by occlusion into several visible pieces) move
  // together, rather than each piece scattering independently, which would
  // read as broken debris instead of a shifted/rotated line.
  const carrierJitter = new Map();
  function jitterFor(k){
    let j = carrierJitter.get(k);
    if (j) return j;
    const spacingMag = spacingOn ? sMin + Math.random()*(sMax-sMin) : 0;
    const angleMag = angleOn ? aMin + Math.random()*(aMax-aMin) : 0;
    j = { spacing: spacingMag * (Math.random()<0.5?-1:1), angle: angleMag * (Math.random()<0.5?-1:1) };
    carrierJitter.set(k, j);
    return j;
  }
  const out = new Float32Array(segs.length);
  for (let i=0, si=0; i<segs.length; i+=4, si++){
    let x0=segs[i], y0=segs[i+1], x1=segs[i+2], y1=segs[i+3];
    const j = jitterFor(carrierIdx[si]);
    if (j.angle){
      const mx=(x0+x1)/2, my=(y0+y1)/2;
      const th=j.angle*Math.PI/180, c=Math.cos(th), s=Math.sin(th);
      const rx0=x0-mx, ry0=y0-my, rx1=x1-mx, ry1=y1-my;
      x0=mx+rx0*c-ry0*s; y0=my+rx0*s+ry0*c;
      x1=mx+rx1*c-ry1*s; y1=my+rx1*s+ry1*c;
    }
    if (j.spacing){
      x0+=nx*j.spacing; y0+=ny*j.spacing;
      x1+=nx*j.spacing; y1+=ny*j.spacing;
    }
    if (overshootOn){
      // Signed draw directly from [oMin,oMax] — no separate random sign.
      // Positive extends the endpoint outward (overshoot), negative pulls
      // it inward (undershoot), each endpoint drawn independently.
      const dx=x1-x0, dy=y1-y0, len=Math.hypot(dx,dy) || 1, ux=dx/len, uy=dy/len;
      const maxUndershoot = 0.3 * len;   // cap shortening so both ends can't collapse/invert a short segment
      let m0 = oMin + Math.random()*(oMax-oMin);
      let m1 = oMin + Math.random()*(oMax-oMin);
      if (m0 < -maxUndershoot) m0 = -maxUndershoot;
      if (m1 < -maxUndershoot) m1 = -maxUndershoot;
      x0-=ux*m0; y0-=uy*m0;
      x1+=ux*m1; y1+=uy*m1;
    }
    out[i]=x0; out[i+1]=y0; out[i+2]=x1; out[i+3]=y1;
  }
  return out;
}
// Re-samples a piece's poly at a given (possibly widened/shrunk) angular
// span and/or radius — shared by trim/extend, overshoot/undershoot, and
// spacing jitter below, since all three are "recompute u0/u1 and/or
// radius, then resample the arc," just with different adjustments.
function resampleArcPiece(piece, newU0, newU1, newRadius){
  const { cx, cy } = piece;
  const nSub = Math.max(2, Math.ceil((newU1-newU0)*2*Math.PI*newRadius / 2));
  const poly = [];
  for (let k=0; k<=nSub; k++){
    const u = newU0 + (newU1-newU0)*k/nSub;
    poly.push(cx+newRadius*Math.cos(u*2*Math.PI), cy+newRadius*Math.sin(u*2*Math.PI));
  }
  return { ...piece, poly, u0: newU0, u1: newU1, radius: newRadius };
}
// Extends/trims a piece's two ends ALONG the circle's own path (more arc-
// length at the same radius), not in a straight line — trimPx of linear
// distance corresponds to trimPx/radius radians of additional angular
// span. Only applies to pieces actually cut by shadow clipping (or
// density thinning, which cuts the same way) — a fully-intact ring has no
// real endpoints for this to act on, so it passes through untouched,
// exactly as agreed.
function applyCircleTrimExtend(pieces, trimPx){
  if (trimPx === 0) return pieces;
  const out = [];
  for (const piece of pieces){
    if (piece.closed){ out.push(piece); continue; }
    const du = (trimPx/piece.radius) / (2*Math.PI);
    const newU0 = piece.u0 - du, newU1 = piece.u1 + du;
    if (newU1 - newU0 <= 0) continue;   // would collapse/invert — drop entirely, mirrors hatch's own rule
    out.push(resampleArcPiece(piece, newU0, newU1, piece.radius));
  }
  return out;
}
// Same idea as hatch's own overshoot/undershoot — each end drawn
// independently from [oMin,oMax] (signed: positive extends, negative
// trims), undershoot capped at 30% of the piece's own arc length so it
// can't invert a short arc. Only applies to shadow-cut pieces, same as
// trim/extend above.
function applyCircleOvershootUndershoot(pieces, oMin, oMax){
  if (oMin === 0 && oMax === 0) return pieces;
  const out = [];
  for (const piece of pieces){
    if (piece.closed){ out.push(piece); continue; }
    const arcLen = (piece.u1-piece.u0)*2*Math.PI*piece.radius;
    const maxUndershoot = 0.3*arcLen;
    let m0 = oMin + Math.random()*(oMax-oMin);
    let m1 = oMin + Math.random()*(oMax-oMin);
    if (m0 < -maxUndershoot) m0 = -maxUndershoot;
    if (m1 < -maxUndershoot) m1 = -maxUndershoot;
    const du0 = (m0/piece.radius)/(2*Math.PI), du1 = (m1/piece.radius)/(2*Math.PI);
    const newU0 = piece.u0 - du0, newU1 = piece.u1 + du1;
    if (newU1 - newU0 <= 0) continue;
    out.push(resampleArcPiece(piece, newU0, newU1, piece.radius));
  }
  return out;
}
// Radial equivalent of hatch's per-carrier spacing jitter: one shared
// random radius offset per RING (not per piece — every fragment a single
// ring got split into by shadow/density thinning moves together), applied
// by shifting the whole ring's radius and resampling.
// Keyed by ring index ALONE, deliberately: ring r of the ground set and
// ring r of the model-surface set are not two rings that happen to share a
// number, they are the same circle (same center, same spacing) seen on two
// different receiving surfaces. Keying them apart gave the two halves of
// one ring different radii, which tore it open at exactly the boundary
// mergeRingPieces (worker) now joins. Unlike trim/extend and
// overshoot, this applies to both closed and cut pieces — the user's
// exception was specifically for the two end-focused effects, not this
// one.
function applyCircleSpacingJitter(pieces, sMin, sMax){
  if (sMin === 0 && sMax === 0) return pieces;
  const jitterByRing = new Map();
  function jitterFor(key){
    if (jitterByRing.has(key)) return jitterByRing.get(key);
    const mag = sMin + Math.random()*(sMax-sMin);
    const j = mag * (Math.random()<0.5?-1:1);
    jitterByRing.set(key, j);
    return j;
  }
  const out = [];
  for (const piece of pieces){
    const j = jitterFor(piece.ringIdx);
    if (j === 0){ out.push(piece); continue; }
    const newRadius = Math.max(0.01, piece.radius + j);
    out.push(resampleArcPiece(piece, piece.u0, piece.u1, newRadius));
  }
  return out;
}
// Radial version of applyHatchWobble — same noise field, same envelope-
// variation logic, but displacement direction is "away from center at
// this point" instead of a fixed perpendicular, and position along the
// piece is measured as arc-length (u * circumference) instead of linear
// distance along a straight segment. Returns plain polylines (not
// pieces), matching applyHatchWobble's own output shape, since gaps
// (the next stage) only needs the point data.
function applyCircleWobble(pieces, spacingPx, ampPx, sharedSeed, variationAmount, envScalePx, sharedEnvSeed){
  const out = [];
  const freq = 1 / Math.max(1e-6, spacingPx*3);
  const envFreq = 1 / Math.max(1e-6, envScalePx);
  for (const piece of pieces){
    const { cx, cy, radius, u0, u1 } = piece;
    const arcLen = (u1-u0)*2*Math.PI*radius;
    if (ampPx<=0 || spacingPx<=0 || arcLen<1e-6){ out.push(piece.poly); continue; }
    const nSub = Math.max(1, Math.round(arcLen/spacingPx));
    const offX = sharedSeed ? sharedSeed[0] : Math.random()*10000;
    const offY = sharedSeed ? sharedSeed[1] : Math.random()*10000;
    const envOffX = sharedEnvSeed ? sharedEnvSeed[0] : Math.random()*10000;
    const envOffY = sharedEnvSeed ? sharedEnvSeed[1] : Math.random()*10000;
    const poly = [];
    for (let k=0; k<=nSub; k++){
      const t = k/nSub;
      const u = u0 + (u1-u0)*t;
      const ang = u*2*Math.PI;
      const bx = cx+radius*Math.cos(ang), by = cy+radius*Math.sin(ang);
      const rx = Math.cos(ang), ry = Math.sin(ang);   // radial direction at this point — the "perpendicular" for a circle
      let disp = (hatchNoise2D(bx*freq+offX, by*freq+offY) - 0.5) * ampPx;
      if (variationAmount > 0){
        const env = hatchNoise2D(bx*envFreq+envOffX, by*envFreq+envOffY);
        disp *= 1 - variationAmount*(1-env);
      }
      poly.push(bx+rx*disp, by+ry*disp);
    }
    out.push(poly);
  }
  return out;
}
// Circle-specific gaps — operates directly on the rich piece objects
// (cx, cy, radius, u0, u1) rather than generic polylines. For a perfect
// circle, cumulative arc length from u0 to any u is simply
// (u-u0)*2*PI*radius (linear in u, since arc length is proportional to
// angle at constant radius) — no point-by-point interpolation needed at
// all, unlike the generic polyline case. Reuses the exact same Poisson-
// gap interval generator as applyHatchGaps, just interpreting the
// resulting length-ranges as arc positions. Returns pieces with narrowed
// u0/u1 (radius/cx/cy unchanged, closed forced false since a gap-split
// piece is never a whole intact loop anymore) — still full piece
// objects, so Bezier conversion downstream has everything it needs.
function applyCircleGaps(pieces, minLenPx, maxGapPx){
  if (maxGapPx <= 0 || minLenPx <= 0) return pieces;
  const out = [];
  for (const piece of pieces){
    const { u0, u1, radius } = piece;
    const total = (u1-u0) * 2*Math.PI*radius;
    const gaps = generateGapIntervals(total, minLenPx, maxGapPx);
    if (!gaps){ out.push(piece); continue; }
    const uAt = s => u0 + s/(2*Math.PI*radius);
    let onStart = 0;
    for (const [gs, ge] of gaps){
      if (gs > onStart + 1e-6) out.push({ ...piece, u0: uAt(onStart), u1: uAt(gs), closed: false });
      onStart = ge;
    }
    if (onStart < total - 1e-6) out.push({ ...piece, u0: uAt(onStart), u1: uAt(total), closed: false });
  }
  return out;
}
// Standard circular-arc-to-cubic-Bezier conversion: splits the u0..u1
// span into sub-arcs of at most 90 degrees each (the well-known accuracy
// limit for this formula — verified numerically at ~0.027% max radial
// error at exactly 90 degrees, dropping off sharply for smaller spans),
// using the standard control-point distance k = (4/3)*tan(span/4) along
// each endpoint's tangent direction. Returns an array of {p0,c1,c2,p3}
// segments (each a [x,y] pair) ready to emit as SVG "C" commands.
export function arcToBezierSegments(cx, cy, radius, u0, u1){
  const nSeg = Math.max(1, Math.ceil(Math.abs((u1-u0)*2*Math.PI) / (Math.PI/2)));
  const segs = [];
  for (let i=0; i<nSeg; i++){
    const a0 = (u0 + (u1-u0)*i/nSeg) * 2*Math.PI;
    const a1 = (u0 + (u1-u0)*(i+1)/nSeg) * 2*Math.PI;
    const k = (4/3) * Math.tan((a1-a0)/4);
    const p0 = [cx+radius*Math.cos(a0), cy+radius*Math.sin(a0)];
    const p3 = [cx+radius*Math.cos(a1), cy+radius*Math.sin(a1)];
    const c1 = [p0[0] - k*radius*Math.sin(a0), p0[1] + k*radius*Math.cos(a0)];
    const c2 = [p3[0] + k*radius*Math.sin(a1), p3[1] - k*radius*Math.cos(a1)];
    segs.push({ p0, c1, c2, p3 });
  }
  return segs;
}

/* ================= texture stack =================
   applyTextureStack(input, stack, ctx) is the one entry point every layer's
   texture goes through: it walks the layer's stack IN ORDER and hands each
   entry to its implementation for the representation the pieces are in
   right now. Representations ("rep"):
     segments   { segs, carrier }  a hatch layer's flat Float32Array
                [x0,y0,x1,y1,…] and the worker's per-segment carrier index
                (null when absent — the carrier-coherent jitters then skip)
     arcs       { pieces }  Circles pieces {cx, cy, radius, u0, u1, …}
     polylines  { polylines, closed }  flat [x0,y0,x1,y1,…] arrays; closed is
                a per-polyline boolean array, or null for "all open"
   A filter can change the rep (wobble turns segments or arcs into
   polylines). When a filter has no implementation for segments but has one
   for polylines, the segments become 2-point polylines first. A filter
   whose type the layer's geometry doesn't support (ctx.geometry — see
   TEXTURE_FILTERS in layers.js), or that has no implementation for the
   current rep, is skipped. Segments still left at the end become
   polylines; arcs stay arcs (renderResult emits them as Béziers).
   Closed paths: a filter that keeps the polylines one-to-one passes
   `closed` through; one that can split a path (gaps) returns closed:null,
   i.e. every output path open, since a gap opens a ring. Only hatch and
   circles call this today; an edge layer's chained polylines could come
   in as rep:'polylines' with their Z flags as `closed`, and with its empty
   stack come back untouched (refactor plan §4e).
   Overshoot, spacing jitter and angle jitter on segments are ONE combined
   step (applyHatchTexture), run where the first of them sits in the stack:
   they share per-carrier random draws and are applied rotate → shift →
   overshoot per segment, so running them as three separate passes would
   change the output. The editor keeps them adjacent (texture-stack.js). */
function segmentsToPolylines(st){
  const polylines = [];
  for (let i = 0; i < st.segs.length; i += 4) polylines.push([st.segs[i], st.segs[i+1], st.segs[i+2], st.segs[i+3]]);
  return { rep: 'polylines', polylines, closed: null };
}
const LINE_JITTER_TYPES = { overshoot: 1, spacingJitter: 1, angleJitter: 1 };
function lineJitter(st, f, ctx, stack){
  if (!st.carrier) return st;
  return { rep: 'segments', segs: applyHatchTexture(st.segs, st.carrier, ctx.familyAngleDeg, ctx.mmToPx, stack), carrier: st.carrier };
}
const TEXTURE_IMPL = {
  trim: {
    segments: (st, f, ctx) => {
      const r = applyHatchTrimExtend(st.segs, st.carrier, (+f.value || 0) * ctx.mmToPx);
      return { rep: 'segments', segs: r.segs, carrier: r.carrierIdx };
    },
    arcs: (st, f, ctx) => ({ rep: 'arcs', pieces: applyCircleTrimExtend(st.pieces, (+f.value || 0) * ctx.mmToPx) }),
  },
  overshoot: {
    segments: lineJitter,
    arcs: (st, f, ctx) => ({ rep: 'arcs', pieces: applyCircleOvershootUndershoot(st.pieces, (+f.min || 0) * ctx.mmToPx, (+f.max || 0) * ctx.mmToPx) }),
  },
  spacingJitter: {
    segments: lineJitter,
    arcs: (st, f, ctx) => ({ rep: 'arcs', pieces: applyCircleSpacingJitter(st.pieces, (+f.min || 0) * ctx.mmToPx, (+f.max || 0) * ctx.mmToPx) }),
  },
  angleJitter: { segments: lineJitter },
  // Wobble displaces points along a line or arc, so the result is a dense
  // polyline — a wobbled arc is no longer a circle.
  wobble: {
    segments: (st, f, ctx) => {
      const wb = readWobbleParams(f, ctx.mmToPx);
      return { rep: 'polylines', closed: null,
        polylines: applyHatchWobble(st.segs, wb.spacingPx, wb.ampPx, wb.sharedSeed, wb.variationAmount, wb.envScalePx, wb.sharedEnvSeed) };
    },
    arcs: (st, f, ctx) => {
      const wb = readWobbleParams(f, ctx.mmToPx);
      return { rep: 'polylines', closed: null,
        polylines: applyCircleWobble(st.pieces, wb.spacingPx, wb.ampPx, wb.sharedSeed, wb.variationAmount, wb.envScalePx, wb.sharedEnvSeed) };
    },
  },
  regularWobble: {
    polylines: (st, f, ctx) => ({ rep: 'polylines', closed: st.closed,
      polylines: applyHatchRegularWobble(st.polylines, ctx.familyAngleDeg, (+f.amp || 0) * ctx.mmToPx, (+f.wavelength || 5) * ctx.mmToPx) }),
  },
  gaps: {
    arcs: (st, f, ctx) => {
      const gp = readGapParams(f, ctx.mmToPx);
      return { rep: 'arcs', pieces: applyCircleGaps(st.pieces, gp.minLenPx, gp.maxGapPx) };
    },
    polylines: (st, f, ctx) => {
      const gp = readGapParams(f, ctx.mmToPx);
      return { rep: 'polylines', closed: null, polylines: applyHatchGaps(st.polylines, gp.minLenPx, gp.maxGapPx) };
    },
  },
};
// ctx: { geometry ('lines' | 'arcs' | null for edge layers), mmToPx,
// familyAngleDeg (lines: the hatch family's angle) }
export function applyTextureStack(input, stack, ctx){
  let st = input;
  let lineJitterDone = false;
  for (const f of stack){
    const impl = TEXTURE_IMPL[f.type];
    if (!impl || !filterSupports(f.type, ctx.geometry)) continue;
    if (LINE_JITTER_TYPES[f.type] && st.rep === 'segments'){
      if (lineJitterDone) continue;     // the combined step already ran for this group
      lineJitterDone = true;
    }
    let run = impl[st.rep];
    if (!run && st.rep === 'segments' && impl.polylines){ st = segmentsToPolylines(st); run = impl.polylines; }
    if (!run) continue;
    st = run(st, f, ctx, stack);
  }
  return st.rep === 'segments' ? segmentsToPolylines(st) : st;
}
// Appends polylines to a path's d tokens, one subpath each, counting them
// into pathStats when given. A polyline whose ends meet (within 0.02px) is
// counted as closed.
export function appendTexturedPolylinesD(d, polylines, pathStats){
  for (const poly of polylines){
    const pts = []; for (let i=0;i<poly.length;i+=2) pts.push([poly[i],poly[i+1]]);
    const closed = pts.length>2 && Math.hypot(pts[0][0]-pts[pts.length-1][0], pts[0][1]-pts[pts.length-1][1]) < 0.02;
    if (pathStats) accumulatePathStats(pathStats, closed ? pts.slice(0,-1) : pts, closed);
    d.push('M', poly[0].toFixed(2), poly[1].toFixed(2));
    for (let i = 2; i < poly.length; i += 2) d.push('L', poly[i].toFixed(2), poly[i+1].toFixed(2));
  }
}
