/* ================================================================
   debug/shading-diagnostics.js — console tools for the shading buffer
   Loaded only with ?debug in the URL (dynamic import at the end of
   initSceneIO, scene-io.js). Everything here is a diagnostic over
   captureShadingBuffer (shading-capture.js) and the worker's sampleShading;
   none of it is used by the app itself. Call from the browser console
   once a model is loaded:

     previewShadingBuffer()        draws the captured buffer over the live
                                   viewport — shadow/terminator edges should
                                   land exactly on the mesh underneath
     removeShadingBufferPreview()  removes that overlay
     analyzeShadingBuffer()        largest texel-to-texel brightness jump and
                                   jump counts, a smoothness sanity check
     benchmarkShadingCapture(n)    times n captures (default 20)
     testShadingBufferRoundTrip()  samples one buffer here and via the worker
                                   (transfer + row flip + sampleShading) and
                                   checks the two agree
   ================================================================ */
import { worker } from '../main.js';
import { modelMesh, vp } from '../viewport/viewport3d.js';
import { captureShadingBuffer } from '../viewport/shading-capture.js';
(function(){
  function previewShadingBuffer(){
    const cap = captureShadingBuffer();
    if (!cap) return;
    const { pixels, w, h } = cap;
    let overlay = document.getElementById('shadingBufferPreview');
    if (!overlay){
      overlay = document.createElement('canvas');
      overlay.id = 'shadingBufferPreview';
      overlay.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;';
      document.body.appendChild(overlay);
    }
    // Positioned over the 3D pane's own rect (it sits below the header, so
    // inset:0 would be offset by the header height); re-measured per call.
    const vpRect = vp.getBoundingClientRect();
    overlay.style.left = vpRect.left + 'px';
    overlay.style.top = vpRect.top + 'px';
    overlay.style.width = vpRect.width + 'px';
    overlay.style.height = vpRect.height + 'px';
    overlay.width = w; overlay.height = h;
    const ctx = overlay.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let y=0;y<h;y++){
      const srcY = h-1-y;   // WebGL readback is bottom-up; canvas 2D is top-down
      for (let x=0;x<w;x++){
        const si = (srcY*w+x)*4, di = (y*w+x)*4;
        const hasGeom = pixels[si+1] > 0.5;
        const v = hasGeom ? Math.round(Math.min(1, Math.max(0, pixels[si])) * 255) : 0;
        img.data[di]=v; img.data[di+1]=v; img.data[di+2]=v; img.data[di+3]= hasGeom ? 255 : 0;
      }
    }
    ctx.putImageData(img, 0, 0);
    console.log('[shadingCapture] buffer drawn over the live viewport (white = captured geometry). ' +
      'Call removeShadingBufferPreview() to remove it.');
  }
  function removeShadingBufferPreview(){
    const overlay = document.getElementById('shadingBufferPreview');
    if (overlay) overlay.remove();
  }

  function analyzeShadingBuffer(){
    const cap = captureShadingBuffer();
    if (!cap) return null;
    const { pixels: buf, w, h } = cap;
    // Scans every row, within continuous "hasGeometry" runs, for the
    // largest single-texel brightness jump.
    let maxJump = 0, maxJumpLoc = null;
    const counts = { '0.1':0, '0.2':0, '0.3':0, '0.4':0 };
    for (let y=0; y<h; y++){
      let prevB = null, prevG = 0;
      for (let x=0; x<w; x++){
        const i = (y*w+x)*4;
        const b = buf[i], g = buf[i+1];
        if (g > 0.5 && prevG > 0.5){
          const step = Math.abs(b - prevB);
          for (const t of Object.keys(counts)) if (step > +t) counts[t]++;
          if (step > maxJump){ maxJump = step; maxJumpLoc = [x,y]; }
        }
        prevB = b; prevG = g;
      }
    }
    console.log('[shadingAnalyze] buffer ' + w + '×' + h + ' (' + (w*h) + ' px):');
    console.log('  max single-texel brightness jump: ' + maxJump.toFixed(4) + ' at ' + JSON.stringify(maxJumpLoc));
    console.log('  jump counts (pixel-pairs exceeding each threshold):', counts);
    return { maxJump, maxJumpLoc, counts, w, h };
  }

  function benchmarkShadingCapture(n){
    n = n || 20;
    if (!modelMesh){ console.warn('[shadingBench] no model loaded'); return; }
    const times = [];
    let cap = null;
    for (let i = 0; i < n; i++){
      const t0 = performance.now();
      cap = captureShadingBuffer();
      times.push(performance.now() - t0);
    }
    const sum = times.reduce((a,b) => a+b, 0);
    console.log('[shadingBench] ' + n + ' captures at ' + cap.w + '×' + cap.h + ', ' +
      (cap.pixels.byteLength/1024/1024).toFixed(2) + ' MB per buffer: avg ' + (sum/n).toFixed(2) +
      'ms, min ' + Math.min(...times).toFixed(2) + 'ms, max ' + Math.max(...times).toFixed(2) + 'ms');
  }

  // Round trip: the reference is an independent bilinear sampler over a
  // flipped COPY (the original is transferred to the worker), so a bug in
  // the worker's path cannot agree with itself.
  let pendingReference = null;
  function testShadingBufferRoundTrip(){
    const cap = captureShadingBuffer();
    if (!cap){ console.warn('[shadingTest] no model loaded / capture failed'); return; }
    const { pixels, w, h } = cap;
    // Includes one fractional point so the bilinear path is exercised.
    const points = [
      [w*0.5, h*0.5], [w*0.25, h*0.75], [w*0.1, h*0.1],
      [w*0.9, h*0.9], [w*0.5 + 0.37, h*0.5 + 0.62],
    ];
    const flipped = pixels.slice();
    const rowFloats = w * 4;
    for (let y = 0; y < h >> 1; y++){
      const y2 = h - 1 - y;
      const o1 = y*rowFloats, o2 = y2*rowFloats;
      const tmp = flipped.slice(o1, o1+rowFloats);
      flipped.copyWithin(o1, o2, o2+rowFloats);
      flipped.set(tmp, o2);
    }
    const sampleRef = (sx, sy) => {
      const x = Math.max(0, Math.min(w - 1, sx));
      const y = Math.max(0, Math.min(h - 1, sy));
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const x1 = Math.min(w-1, x0+1), y1 = Math.min(h-1, y0+1);
      const fx = x-x0, fy = y-y0;
      const idx = (xi,yi) => (yi*w+xi)*4;
      const ia=idx(x0,y0), ib=idx(x1,y0), ic=idx(x0,y1), id=idx(x1,y1);
      const wA=(1-fx)*(1-fy), wB=fx*(1-fy), wC=(1-fx)*fy, wD=fx*fy;
      return {
        brightness: flipped[ia]*wA + flipped[ib]*wB + flipped[ic]*wC + flipped[id]*wD,
        hasGeometry: (flipped[ia+1]*wA + flipped[ib+1]*wB + flipped[ic+1]*wC + flipped[id+1]*wD) > 0.5,
      };
    };
    pendingReference = points.map(([sx,sy]) => sampleRef(sx,sy));
    worker.postMessage({ type: 'testShadingSample', pixels, w, h, points }, [pixels.buffer]);
    console.log('[shadingTest] sent ' + points.length + ' test points to the worker — waiting for testShadingSampleResult...');
  }
  // A second listener alongside scene-io.js's worker.onmessage dispatcher,
  // which ignores this message type.
  worker.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type !== 'testShadingSampleResult') return;
    if (!pendingReference){ console.warn('[shadingTest] got a result with no pending reference — ignoring'); return; }
    const reference = pendingReference;
    pendingReference = null;
    let allMatch = true;
    reference.forEach((ref, i) => {
      const got = m.values[i];
      const brightDiff = Math.abs(ref.brightness - got.brightness);
      const match = brightDiff < 1e-4 && ref.hasGeometry === got.hasGeometry;
      if (!match) allMatch = false;
      console.log('[shadingTest] point ' + i + ': reference=' + ref.brightness.toFixed(5) +
        ' worker=' + got.brightness.toFixed(5) + ' diff=' + brightDiff.toExponential(2) +
        ' hasGeometry ref=' + ref.hasGeometry + ' worker=' + got.hasGeometry +
        (match ? ' ✓' : ' ✗ MISMATCH'));
    });
    console.log(allMatch
      ? '[shadingTest] ALL POINTS MATCH — transfer + flip + sampleShading are all correct.'
      : '[shadingTest] MISMATCH FOUND — see above for which point(s) disagree.');
  });

  Object.assign(window, { previewShadingBuffer, removeShadingBufferPreview,
    analyzeShadingBuffer, benchmarkShadingCapture, testShadingBufferRoundTrip });
  console.log('[debug] shading diagnostics loaded: previewShadingBuffer(), removeShadingBufferPreview(), ' +
    'analyzeShadingBuffer(), benchmarkShadingCapture(n), testShadingBufferRoundTrip()');
})();
