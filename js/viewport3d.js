/* ================================================================
   viewport3d.js — the 3D viewport
   Three.js scene/camera/renderer, orbit controls (drag/zoom), the
   axis gizmo and light-direction gizmo, projection mode toggle,
   view presets, lighting + shadow sync, and onLoaded() which wires a
   freshly parsed mesh (from the worker) into the live 3D scene.
   ================================================================ */
/* ================= three.js viewport ================= */
const vp = $('viewport3d');
const renderer = new THREE.WebGLRenderer({ antialias:true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// Enabled once, unconditionally, at startup — toggling this flag later would
// force a shader recompile on every material in the scene. Actual shadow
// presence is controlled per-light/per-mesh instead (cheap to flip), driven
// by the Cast shadows / Ground shadow checkboxes.
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
vp.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x353c47);
const perspCam = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
let camera = perspCam;
function updateFrustum(){
  const w = vp.clientWidth || 1, h = vp.clientHeight || 1, aspect = w / h;
  perspCam.aspect = aspect;
  perspCam.fov = +$('fovDeg').value;
  // ortho frustum sized so it frames the target the same as perspective would
  const halfH = orbit.radius * Math.tan(perspCam.fov * Math.PI / 360), halfW = halfH * aspect;
  orthoCam.left = -halfW; orthoCam.right = halfW; orthoCam.top = halfH; orthoCam.bottom = -halfH;
  // Lens shift: setViewOffset with width/height == fullWidth/fullHeight means
  // no cropping or tiling, just an off-center window within the same-size
  // frustum — moves the vanishing point without moving or rotating the
  // camera, same effect as Blender's camera Shift. Expressed as a fraction
  // of frame size (matching Blender's own shift-value convention, e.g. the
  // 0.330 in the reference material) rather than a raw pixel offset, so it
  // stays meaningful regardless of viewport size.
  const shiftX = +$('camShiftX').value, shiftY = +$('camShiftY').value;
  if (shiftX || shiftY){
    perspCam.setViewOffset(w, h, shiftX * w, shiftY * h, w, h);
    orthoCam.setViewOffset(w, h, shiftX * w, shiftY * h, w, h);
  } else {
    perspCam.clearViewOffset();
    orthoCam.clearViewOffset();
  }
  perspCam.updateProjectionMatrix();
  orthoCam.updateProjectionMatrix();
}
const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
dirLight.shadow.mapSize.set(2048, 2048);
scene.add(dirLight, dirLight.target, new THREE.AmbientLight(0xffffff, 0.45));
let modelMesh = null, gridHelper = null, groundCatcher = null;
let modelCenter = new THREE.Vector3(), modelRadius = 1, modelBboxMinY = 0, modelName = 'demo scene';
// Rotate-model feature: modelMesh is a CHILD of modelPivot (not added to
// `scene` directly), positioned at -modelCenter in the pivot's local space;
// modelPivot itself sits AT modelCenter. Rotating modelPivot therefore
// rotates the mesh around its own center rather than around the world
// origin or whatever arbitrary point its raw geometry data happens to use
// as (0,0,0). gridHelper/groundCatcher/dirLight stay direct children of
// `scene` (not the pivot) — the ground plane and lighting are a world-space
// reference frame that deliberately does NOT tip along with the model.
const modelPivot = new THREE.Object3D();
scene.add(modelPivot);

/* --- minimal orbit controls (rotate / pan / dolly) --- */
const orbit = {
  theta: 0.7, phi: 1.12, radius: 5,
  target: new THREE.Vector3(),
  // 0 = normal (theta,phi) orbit; +1/-1 = locked exactly to the top/bottom
  // pole (CAD +Z/-Z). The standard lookAt(target) construction below is
  // exactly degenerate at phi=0/π — the camera's forward direction becomes
  // exactly parallel to the default up vector (0,1,0), so the cross
  // product used to derive the camera's actual right/up basis is exactly
  // zero. Approximating the pole with phi very-near-but-not-exactly 0/π
  // (the old approach) can only ever get arbitrarily close, never exact —
  // any nonzero tilt, however small, is still a real, nonzero tilt.
  // Swapping in an up vector that ISN'T parallel to the vertical view
  // direction sidesteps the degeneracy completely instead of merely
  // shrinking it, giving a bit-exact result with no residual tilt at all.
  exactPole: 0,
  apply(){
    if (this.exactPole){
      // Up vectors chosen to exactly match the screen orientation the old
      // near-pole approximation converged toward (verified directly by
      // computing that limit) — so the view looks identical, just with
      // genuinely zero tilt instead of a very small one.
      const upZ = this.exactPole > 0 ? -1 : 1;
      perspCam.up.set(0, 0, upZ); orthoCam.up.set(0, 0, upZ);
      const py = this.target.y + this.exactPole * this.radius;
      perspCam.position.set(this.target.x, py, this.target.z); perspCam.lookAt(this.target);
      orthoCam.position.set(this.target.x, py, this.target.z); orthoCam.lookAt(this.target);
      updateFrustum();
      return;
    }
    perspCam.up.set(0, 1, 0); orthoCam.up.set(0, 1, 0);   // restore default when leaving the exact pole
    const sp = Math.sin(this.phi), cp = Math.cos(this.phi);
    const px = this.target.x + this.radius * sp * Math.sin(this.theta),
          py = this.target.y + this.radius * cp,
          pz = this.target.z + this.radius * sp * Math.cos(this.theta);
    perspCam.position.set(px, py, pz); perspCam.lookAt(this.target);
    orthoCam.position.set(px, py, pz); orthoCam.lookAt(this.target);
    updateFrustum();               // ortho framing follows orbit distance
  }
};
// For a fixed world-space pan step, the resulting on-screen movement scales
// as 1/tan(fov/2) — a narrow (telephoto-like) FOV shows far more screen
// movement for the same world-space shift than a wide one, which is why
// panning felt fine around FOV=130 but wildly oversensitive near FOV=10.
// Multiplying the step by tan(fov/2) cancels that out, making the
// perceived screen-space pan speed roughly constant across the whole FOV
// range instead of varying with it. Uses perspCam.fov regardless of the
// active projection mode, since orthographic framing is itself already
// tied to fov elsewhere (updateFrustum) — consistent with how this app
// already treats fov as the shared "zoom/framing" parameter in both modes.
function fovPanScale(){ return Math.tan(perspCam.fov * Math.PI / 360); }
let dragBtn = -1, lastX = 0, lastY = 0;
renderer.domElement.addEventListener('pointerdown', e => {
  dragBtn = (e.button === 2 || e.shiftKey) ? 2 : 0;
  lastX = e.clientX; lastY = e.clientY;
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', e => {
  if (dragBtn < 0) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  if (dragBtn === 0){
    const poleEps = 0.001 * Math.PI / 180;
    if (orbit.exactPole){
      orbit.phi = orbit.exactPole > 0 ? poleEps : Math.PI - poleEps;
      orbit.exactPole = 0;
    }
    orbit.theta -= dx * 0.006;
    orbit.phi = Math.min(Math.PI - poleEps, Math.max(poleEps, orbit.phi - dy * 0.006));
  } else {
    // 0.00098484 = 0.00089531 * 1.1 — additional 10% bump on top of the
    // previous 20% increase.
    const k = orbit.radius * 0.00098484 * fovPanScale();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up    = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
    orbit.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
  }
  orbit.apply(); markStale(); clearActiveView();
});
renderer.domElement.addEventListener('pointerup', () => dragBtn = -1);
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
renderer.domElement.addEventListener('wheel', e => {
  e.preventDefault();
  orbit.radius = Math.min(modelRadius * 40, Math.max(modelRadius * 0.2,
    orbit.radius * Math.exp(e.deltaY * 0.0012)));
  orbit.apply(); markStale(); clearActiveView();
}, { passive:false });

// Arrow keys pan the camera along its OWN local axes (up/down/left/right
// on screen, not world axes) — only while the mouse is over the 3D
// viewport, so this never fights with arrow keys' native behavior in a
// focused slider or an in-place value editor elsewhere on the page.
// Reuses the exact same local-right/up extraction and radius-scaled
// target-shift the existing Shift+drag pan gesture already uses above,
// just a fixed step per keypress instead of following mouse delta.
let vpHover = false;
vp.addEventListener('pointerenter', () => { vpHover = true; });
vp.addEventListener('pointerleave', () => { vpHover = false; });
const ARROW_PAN_KEYS = { ArrowUp:[0,1], ArrowDown:[0,-1], ArrowRight:[1,0], ArrowLeft:[-1,0] };
document.addEventListener('keydown', e => {
  if (!vpHover) return;
  const dir = ARROW_PAN_KEYS[e.key];
  if (!dir) return;
  e.preventDefault();
  // 0.019818 anchors this to 85% of the old, FOV-independent step at
  // FOV=130 — "almost right, make it a bit less" — with lower FOV values
  // scaling down from there instead of staying constant (which is what
  // made low-FOV arrow-key movement jump so much more before this).
  const step = orbit.radius * 0.019818 * fovPanScale();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
  const up    = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
  orbit.target.addScaledVector(right, dir[0] * step).addScaledVector(up, dir[1] * step);
  orbit.apply(); markStale(); clearActiveView();
});

function resize(){
  const w = vp.clientWidth, h = vp.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  updateFrustum();
}
// Guarded against an early/spurious first notification: ResizeObserver
// callbacks are queued asynchronously and normally only run once the whole
// page (all <script src> tags) has finished loading — by which point
// markStale/computePaperLayout (defined in panel-controls.js/paper-
// preview.js, which load AFTER this file) already exist as globals. But the
// very first notification can occasionally get queued and fire in the gap
// between two script tags loading from disk, before those files have run —
// harmless (every REAL resize afterward works normally), but throws if
// called unguarded. typeof-checking here no-ops that one early call instead.
new ResizeObserver(() => { resize(); if (typeof markStale === 'function') markStale(); }).observe(vp);
resize();
new ResizeObserver(() => {
  if (typeof computePaperLayout !== 'function') return;
  const layout = computePaperLayout(); if (layout) applyPv(layout);
}).observe($('paperPane'));
/* ================= axis gizmo =================
   Blender-style orientation gizmo: the three world axes projected through the
   live camera rotation into a small SVG overlay — no second WebGL pass, just
   9 SVG nodes updated per frame. Positive ends are solid labeled balls with a
   stem line; negative ends are hollow. Depth-sorted by reordering the DOM
   (SVG paint order). Clicking any ball snaps to the view down that axis.

   LABELING CONVENTION: the engine is Y-up internally (three.js / WebGL
   convention), but the gizmo presents the CAD Z-up convention users know
   from Rhino/Blender/AutoCAD. Right-handed mapping:
     CAD X = internal +X   ·   CAD Y = internal −Z   ·   CAD Z = internal +Y
   Only the labels/colors say "CAD"; d[] vectors and snap angles are internal. */
const GIZMO_AXES = [   // theta/phi in degrees (internal orbit convention)
  { d:[ 1,0,0], c:'#e5544b', l:'X', theta:90,  phi:90       },   // CAD +X
  { d:[-1,0,0], c:'#e5544b', l:'',  theta:270, phi:90       },   // CAD −X
  { d:[0, 1,0], c:'#4a8fe0', l:'Z', theta:0,   phi:0.001    },   // CAD +Z = up
  { d:[0,-1,0], c:'#4a8fe0', l:'',  theta:0,   phi:179.999  },   // CAD −Z
  { d:[0,0,-1], c:'#6fbf3f', l:'Y', theta:180, phi:90       },   // CAD +Y
  { d:[0,0, 1], c:'#6fbf3f', l:'',  theta:0,   phi:90       },   // CAD −Y
];
const gizmoSvg = $('axisGizmo'), GNS = 'http://www.w3.org/2000/svg';
const gizmoParts = GIZMO_AXES.map(ax => {
  const positive = ax.l !== '';
  let line = null;
  if (positive){                          // stem only on positive halves, like Blender
    line = document.createElementNS(GNS, 'line');
    line.setAttribute('stroke', ax.c);
    line.setAttribute('stroke-width', '1.8');
    gizmoSvg.appendChild(line);
  }
  const g = document.createElementNS(GNS, 'g');
  g.setAttribute('class', 'ball');
  const c = document.createElementNS(GNS, 'circle');
  c.setAttribute('r', positive ? 9 : 7);
  c.setAttribute('fill', ax.c);
  if (!positive){ c.setAttribute('fill-opacity', '0.25'); c.setAttribute('stroke', ax.c); c.setAttribute('stroke-width', '1.4'); }
  g.appendChild(c);
  let t = null;
  if (positive){
    t = document.createElementNS(GNS, 'text');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dy', '3.4');
    t.setAttribute('fill', '#10141a');
    t.textContent = ax.l;
    g.appendChild(t);
  }
  // pointerdown, not click: drawGizmo re-inserts these nodes for depth
  // sorting, and a DOM re-insertion between mousedown and mouseup makes the
  // browser drop the click event entirely — pointerdown always fires
  g.addEventListener('pointerdown', ev => {
    ev.preventDefault(); ev.stopPropagation();
    const isZAxis = ax.d[0]===0 && ax.d[2]===0;   // CAD +Z or -Z (top/bottom)
    // if the view is already snapped to this exact axis, clicking again
    // flips to the opposite pole (Blender-style toggle) instead of no-op
    const eps = 0.5 * Math.PI / 180;
    const curTheta = orbit.theta, curPhi = orbit.phi;
    const wrap = a => ((a % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);
    const closeAngle = (a,b) => {
      const d = Math.abs(wrap(a) - wrap(b));
      return Math.min(d, 2*Math.PI - d) < eps;
    };
    const isCurrent = isZAxis
      ? orbit.exactPole === Math.sign(ax.d[1])
      : orbit.exactPole === 0 &&
        closeAngle(curTheta, ax.theta*Math.PI/180) &&
        Math.abs(curPhi - Math.min(Math.PI-1e-6, Math.max(1e-6, ax.phi*Math.PI/180))) < eps;
    let target = ax;
    if (isCurrent){
      const opp = GIZMO_AXES.find(o => o.d[0]===-ax.d[0] && o.d[1]===-ax.d[1] && o.d[2]===-ax.d[2]);
      if (opp) target = opp;
    }
    orbit.theta = target.theta * Math.PI / 180;
    orbit.phi = Math.min(Math.PI - 1e-6, Math.max(1e-6, target.phi * Math.PI / 180));
    orbit.exactPole = (target.d[0]===0 && target.d[2]===0) ? Math.sign(target.d[1]) : 0;
    orbit.apply(); markStale(); clearActiveView();
  });
  gizmoSvg.appendChild(g);
  return { line, g, c, t };
});
const gizmoOrder = [0,1,2,3,4,5];
let gizmoLastOrder = '';
function drawGizmo(){
  // world axes in camera space = rotation columns of the view matrix
  // (matrixWorldInverse is refreshed by renderer.render every frame)
  const e = camera.matrixWorldInverse.elements;
  const R = 36;
  const px = new Float32Array(6), py = new Float32Array(6), pz = new Float32Array(6);
  for (let i=0;i<6;i++){
    const d = GIZMO_AXES[i].d;
    px[i] =  (e[0]*d[0] + e[4]*d[1] + e[8]*d[2]) * R;
    py[i] = -(e[1]*d[0] + e[5]*d[1] + e[9]*d[2]) * R;   // SVG y is down
    pz[i] =   e[2]*d[0] + e[6]*d[1] + e[10]*d[2];       // toward camera = bigger
  }
  gizmoOrder.sort((a,b) => pz[a]-pz[b]);                // paint far → near
  // reorder the DOM only when the depth order actually flips — re-inserting
  // nodes every frame would cancel in-flight pointer gestures on the balls
  const orderKey = gizmoOrder.join('');
  if (orderKey !== gizmoLastOrder){
    gizmoLastOrder = orderKey;
    for (const i of gizmoOrder){
      const p = gizmoParts[i];
      if (p.line) gizmoSvg.appendChild(p.line);
      gizmoSvg.appendChild(p.g);
    }
  }
  for (const i of gizmoOrder){
    const p = gizmoParts[i];
    if (p.line){
      // stop the stem at the ball's rim, not its center, and fade it in
      // lockstep with its ball; when the axis points nearly at the camera
      // the ball covers the origin — no stem to draw at all
      const len = Math.hypot(px[i], py[i]);
      const f = len > 9.5 ? (len - 9) / len : 0;
      p.line.setAttribute('x2', (px[i]*f).toFixed(1));
      p.line.setAttribute('y2', (py[i]*f).toFixed(1));
      p.line.setAttribute('opacity', f === 0 ? '0' : (pz[i] >= 0 ? '1' : '0.5'));
    }
    p.g.setAttribute('transform', 'translate(' + px[i].toFixed(1) + ' ' + py[i].toFixed(1) + ')');
    p.g.setAttribute('opacity', pz[i] >= 0 ? '1' : '0.5');
  }
}

/* the floating export panel sits ON the pannable/zoomable 2D pane — swallow
   its pointer/wheel events so adjusting a dropdown never pans the paper */
['pointerdown','wheel','dblclick'].forEach(t => {
  $('genExportFloat').addEventListener(t, e => e.stopPropagation());
});

/* ================= light direction gizmo =================
   Static compass ring (azimuth, 0°=top, clockwise) + a separate vertical
   gauge (elevation) — deliberately NOT camera-following: a rotated ring of
   directions projects to an ellipse from most angles, ill-conditioned for
   dragging right when it's most tilted, so this stays a fixed 2D control
   like the reference mockup. Two-way bound to the existing Light azim./
   Light elev. sliders through the SAME path those sliders already use
   (set .value, dispatch a real 'input' event) rather than duplicating the
   markStale/updateLight/label-text logic that listener already does. */
const lgSvg = $('lightGizmo');
const LG = {
  cx: 70, cy: 95, r: 54,                 // azimuth ring — diameter == track length
  tx: 170, ty0: 41, ty1: 149,            // elevation track: x, top y, bottom y (length 108 == 2*r)
  azMin: 0, azMax: 360, elMin: 0, elMax: 90,
};
function lgToSvgPoint(clientX, clientY){
  const pt = lgSvg.createSVGPoint(); pt.x = clientX; pt.y = clientY;
  return pt.matrixTransform(lgSvg.getScreenCTM().inverse());
}
function lgAzToXY(azDeg){
  const t = azDeg * Math.PI / 180;
  // Vertical axis intentionally flipped from the naive top=0°/clockwise
  // reading: left/right (the sin term) was verified correct against actual
  // shadow direction, but top/bottom came out backwards — swapping only the
  // cos term's sign here corrects that pairing without touching lightVec()
  // or the az/el values themselves, which the rest of the app (hatching,
  // export) already depends on and already gets right.
  return [LG.cx + LG.r*Math.sin(t), LG.cy + LG.r*Math.cos(t)];
}
function lgElToY(elDeg){
  const f = (elDeg - LG.elMin) / (LG.elMax - LG.elMin);
  return LG.ty1 - f*(LG.ty1 - LG.ty0);
}
function lgSetLight(az, el){
  if (az !== null){
    az = ((az % 360) + 360) % 360;
    $('lightAz').value = String(Math.round(az));
    $('lightAz').dispatchEvent(new Event('input', { bubbles:true }));
  }
  if (el !== null){
    el = Math.min(LG.elMax, Math.max(LG.elMin, el));
    $('lightEl').value = String(Math.round(el));
    $('lightEl').dispatchEvent(new Event('input', { bubbles:true }));
  }
}
function updateLightGizmo(){
  const az = +$('lightAz').value, el = +$('lightEl').value;
  const [sx, sy] = lgAzToXY(az);
  lgAzNeedle.setAttribute('x2', sx); lgAzNeedle.setAttribute('y2', sy);
  lgAzSun.setAttribute('transform', `translate(${sx} ${sy})`);
  const ey = lgElToY(el);
  lgElFill.setAttribute('y1', LG.ty1); lgElFill.setAttribute('y2', ey);
  lgElSun.setAttribute('transform', `translate(${LG.tx} ${ey})`);
}
let lgAzNeedle, lgAzSun, lgElFill, lgElSun;
(function buildLightGizmo(){
  const mk = (tag, attrs) => {
    const el = document.createElementNS(GNS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  };
  const sun = cls => {
    const g = mk('g', { class: cls });
    g.appendChild(mk('circle', { r:8 }));
    return g;
  };
  // azimuth ring
  lgSvg.appendChild(mk('text', { class:'lgLbl', x:LG.cx, y:25, 'text-anchor':'middle' })).textContent = 'Azimuth';
  lgSvg.appendChild(mk('circle', { class:'lgRing', cx:LG.cx, cy:LG.cy, r:LG.r }));
  lgAzNeedle = lgSvg.appendChild(mk('line', { class:'lgNeedle', x1:LG.cx, y1:LG.cy, x2:LG.cx, y2:LG.cy+LG.r }));
  const lgAzHit = lgSvg.appendChild(mk('circle', { class:'lgHit', cx:LG.cx, cy:LG.cy, r:LG.r+9 }));
  lgAzSun = lgSvg.appendChild(sun('lgSun'));
  // elevation gauge
  lgSvg.appendChild(mk('text', { class:'lgLbl', x:LG.tx, y:25, 'text-anchor':'middle' })).textContent = 'Elev.';
  lgSvg.appendChild(mk('line', { class:'lgTrackBg', x1:LG.tx, y1:LG.ty0, x2:LG.tx, y2:LG.ty1 }));
  lgElFill = lgSvg.appendChild(mk('line', { class:'lgTrackFill', x1:LG.tx, y1:LG.ty1, x2:LG.tx, y2:LG.ty1 }));
  const lgElHit = lgSvg.appendChild(mk('rect', { class:'lgHit', x:LG.tx-15, y:LG.ty0-12, width:30, height:LG.ty1-LG.ty0+24 }));
  lgElSun = lgSvg.appendChild(sun('lgSun'));

  let azDrag = false, elDrag = false;
  const azMove = e => {
    const p = lgToSvgPoint(e.clientX, e.clientY);
    const az = Math.atan2(p.x - LG.cx, p.y - LG.cy) * 180 / Math.PI;
    lgSetLight(az, null);
  };
  lgAzHit.addEventListener('pointerdown', e => {
    azDrag = true; lgAzHit.setPointerCapture(e.pointerId); azMove(e);
  });
  lgAzHit.addEventListener('pointermove', e => { if (azDrag) azMove(e); });
  lgAzHit.addEventListener('pointerup', () => azDrag = false);

  const elMove = e => {
    const p = lgToSvgPoint(e.clientX, e.clientY);
    const f = Math.min(1, Math.max(0, (LG.ty1 - p.y) / (LG.ty1 - LG.ty0)));
    lgSetLight(null, LG.elMin + f*(LG.elMax - LG.elMin));
  };
  lgElHit.addEventListener('pointerdown', e => {
    elDrag = true; lgElHit.setPointerCapture(e.pointerId); elMove(e);
  });
  lgElHit.addEventListener('pointermove', e => { if (elDrag) elMove(e); });
  lgElHit.addEventListener('pointerup', () => elDrag = false);
})();
updateLightGizmo();

(function loop(){
  requestAnimationFrame(loop);
  if (typeof activeTab === 'undefined' || activeTab === 'preview'){
    renderer.render(scene, camera);
    drawGizmo();
  }
})();

function setProjMode(mode){
  const ortho = mode === 'ortho';
  $('projMode').dataset.mode = mode;
  $('projMode').classList.toggle('active', ortho);   // knob right = ortho
  $('projMode').setAttribute('aria-checked', String(ortho));
  $('projLblPersp').classList.toggle('active', !ortho);
  $('projLblOrtho').classList.toggle('active', ortho);
  camera = mode === 'ortho' ? orthoCam : perspCam;
  $('fovDeg').disabled = mode === 'ortho';
  positionSegPill($('projMode').parentElement);
}
$('projMode').addEventListener('click', () => {
  setProjMode($('projMode').dataset.mode === 'ortho' ? 'persp' : 'ortho');
  orbit.apply(); markStale(); clearActiveView();
});
// the flanking mode names select their side directly (no-op if already there)
for (const [id, mode] of [['projLblPersp','persp'], ['projLblOrtho','ortho']])
  $(id).addEventListener('click', () => {
    if ($('projMode').dataset.mode === mode) return;
    setProjMode(mode); orbit.apply(); markStale(); clearActiveView();
  });
$('fovDeg').addEventListener('input', updateFrustum);
$('camShiftX').addEventListener('input', updateFrustum);
$('camShiftY').addEventListener('input', updateFrustum);
// canonical CAD views. These set the ANGLE only and respect whichever
// projection is active — in perspective you get the same viewpoint with
// depth convergence, in orthographic the true measured view. Toggle the
// projection button if you need the strict CAD interpretation.
const VIEW_PRESETS = {
  nw: { theta:135, phi:54.7356 }, ne: { theta:45,  phi:54.7356 },
  sw: { theta:225, phi:54.7356 }, se: { theta:315, phi:54.7356 },
};
document.querySelectorAll('.vpBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    const v = VIEW_PRESETS[btn.dataset.view];
    orbit.theta = v.theta * Math.PI / 180;
    orbit.phi = v.phi * Math.PI / 180;
    orbit.exactPole = 0;
    orbit.apply(); markStale(); clearActiveView();
  });
});

// Recenters the model in the viewport by moving the orbit PIVOT to the
// model's center — theta/phi/radius (view angle and zoom) are deliberately
// left untouched, so this only re-centers, it never reframes.
function recenter3dView(){
  orbit.target.copy(modelCenter);
  orbit.apply();
  markStale();
  clearActiveView();
}
$('recenter3dBtn').addEventListener('click', recenter3dView);
// same reset via a double middle-click anywhere on the 3D canvas
onMiddleDblClick(renderer.domElement, recenter3dView);


function updateLight(){
  const L = lightVec();   // viewport light mirrors the hatch light exactly
  dirLight.position.set(
    modelCenter.x + L[0]*modelRadius*4,
    modelCenter.y + L[1]*modelRadius*4,
    modelCenter.z + L[2]*modelRadius*4);
  dirLight.target.position.copy(modelCenter);
  dirLight.target.updateMatrixWorld();
}
// Shadow-camera frustum + bias, refit whenever the model (and so its scale)
// changes. The frustum only depends on modelRadius, not on light direction —
// Three.js repositions/reorients the shadow camera to follow dirLight every
// frame automatically, so this doesn't need to re-run when azimuth/elevation
// change, only when a new model loads.
function fitShadowFrustum(){
  const r = modelRadius;
  const sc = dirLight.shadow.camera;
  sc.left = -r*1.5; sc.right = r*1.5; sc.top = r*1.5; sc.bottom = -r*1.5;
  // light sits at distance r*4 from the target (see updateLight); pad the
  // near/far range around that so the frustum comfortably contains the
  // model regardless of light direction
  sc.near = r*2; sc.far = r*7;
  sc.updateProjectionMatrix();
  // normalBias scales with model size — a fixed constant would be invisible
  // on huge models and wildly overcorrect on tiny ones. Coplanar architectural
  // faces (flat walls, many edges sharing a plane) are exactly the case that
  // produces shadow acne without this.
  dirLight.shadow.normalBias = r * 0.002;
  dirLight.shadow.bias = -0.0003;
}
// Cast shadows: gates whether the model shadows itself in the preview at
// all. dirLight.castShadow is the master switch — off, no shadow map pass
// runs for this light regardless of any mesh's own flags. Also set the mesh
// flags explicitly (rather than relying on the light alone) since a fresh
// mesh from onLoaded starts with both false by default.
function syncShadowCasting(){
  const cast = $('castShadows').checked, ground = $('groundShadow').checked;
  // The light's own master switch, and whether the model casts a shadow at
  // all, must be on for EITHER feature — Ground shadow needs the model to
  // cast onto the (invisible) catcher plane just as much as Cast shadows
  // needs it to cast onto itself. Only RECEIVING stays tied to Cast shadows
  // specifically, since that's what makes the model shade itself; the
  // ground plane has its own separate receiveShadow (always true, set once
  // in onLoaded) and doesn't need the model to receive anything.
  const anyShadow = cast || ground;
  dirLight.castShadow = anyShadow;
  if (modelMesh){ modelMesh.castShadow = anyShadow; modelMesh.receiveShadow = cast; }
}
// Ground level: the TRUE lowest point of the current (possibly rotated)
// geometry, not an approximation. An earlier version rotated the 8 corners
// of the model's ORIGINAL, unrotated bbox and took the lowest — that's the
// wrong operation: rotating a loose axis-aligned box's corners gives the
// bounding box of the ROTATED BOX SHAPE, which is generically larger/looser
// than the actual rotated mesh's true footprint (the same reason AABBs get
// visibly "puffier" when rotated in most game engines) — so the computed
// ground level came out too low, leaving the model visibly floating above
// the catcher plane even at 0% offset. This scans the mesh's actual
// (local-space) vertex buffer directly and rotates each one — exact, no
// bounding-box approximation involved. Mirrored in the worker (same fix,
// same reasoning) so the exported SVG's ground-shadow hatching matches this
// preview exactly.
function rotatedMeshMinY(geometry, center, rotMat4){
  const arr = geometry.attributes.position.array;
  const e = rotMat4.elements;                          // column-major
  let minY = Infinity;
  for (let i=1; i<arr.length; i+=3){
    const dx=arr[i-1]-center.x, dy=arr[i]-center.y, dz=arr[i+1]-center.z;
    const wy = center.y + (e[1]*dx + e[5]*dy + e[9]*dz);
    if (wy < minY) minY = wy;
  }
  return minY;
}
// Ground shadow: position/size mirror the solver's plane exactly (rotation-
// aware true-min-Y, offset slider in units of model radius); opacity is a
// fixed approximation of "always maximum darkness" (see the fixed value
// set below), since the plotted result's actual darkness is governed
// entirely by Min spacing now, not a separate darkness slider.
function syncGroundCatcher(){
  if (!groundCatcher) return;
  const on = $('groundShadow').checked;
  groundCatcher.visible = on;
  if (!on) return;
  const off = +$('groundOff').value / 100;
  const minY = rotatedMeshMinY(modelMesh.geometry, modelCenter, modelPivot.matrix);
  groundCatcher.position.set(modelCenter.x, minY - off*modelRadius, modelCenter.z);
  // Ground shadow's plotted darkness is now always at maximum (governed
  // entirely by Min spacing — see gatherSettings), so this 3D-preview-only
  // catcher plane uses a fixed opacity rather than a removed slider's
  // value. Not 1.0: the actual plotted shadow is a dense hatch, not a
  // solid fill, so a moderate-high value reads as "a dark, dense shadow"
  // without looking like a flat black shape the real output never is.
  groundCatcher.material.opacity = 0.35;
}
function lightVec(){
  const az = +$('lightAz').value * Math.PI/180, el = +$('lightEl').value * Math.PI/180;
  return [Math.cos(el)*Math.sin(az), Math.sin(el), Math.cos(el)*Math.cos(az)];
}

// Rotate-model panel: reads the 3 sliders (degrees, -180..180) and applies
// them to modelPivot as an intrinsic XYZ Euler rotation around the model's
// own center — this is what drives the live 3D preview directly. The same
// rotation also reaches the worker: gatherSettings() (panel-controls.js)
// reads modelPivot.matrix.elements and sends it as S.modelRot, which the
// worker uses to rotate its own copy of the mesh data before solving (see
// generate()'s "0.5" step) — so the exported line art always matches
// whatever this preview currently shows. updateMatrixWorld(true) is called
// explicitly here (rather than waiting for the next render frame) so
// gatherSettings() always reads the CURRENT rotation, never a frame-stale
// one, even if doGenerate() runs synchronously right after a slider drag.
function updateModelRotation(){
  const rx = +$('rotX').value * Math.PI/180;
  const ry = +$('rotY').value * Math.PI/180;
  const rz = +$('rotZ').value * Math.PI/180;
  // Swapped on purpose: Three.js is Y-up internally, but the UI (like the
  // axis gizmo) presents the CAD Z-up convention — so the slider LABELED
  // "Z" needs to drive the internal Y (vertical) axis, and the one labeled
  // "Y" drives internal Z. Only the mapping is swapped here; the slider
  // ids/labels themselves are untouched.
  modelPivot.rotation.set(rx, rz, ry, 'XYZ');
  modelPivot.updateMatrixWorld(true);
  syncGroundCatcher();
}

/* ================= saved views =================
   Captures camera (orbit theta/phi/radius/target, FOV, perspective/ortho),
   light (azimuth/elevation), and model rotation (X/Y/Z sliders) —
   deliberately nothing else (no model, no layer styles, no paper settings),
   unlike the full .pen scene save. Names are hardcoded "View NN", never
   editable and never renumbered after a delete — savedViewCounter only
   ever climbs, so a gap left by a deleted view stays a gap, which is
   simpler and more predictable than shuffling every other view's name to
   close it. Persisted as part of the .pen scene (see scene-io.js),
   restored via the same renderSavedViews() this uses.

   activeViewRef tracks which saved view (if any) the live camera/light/
   rotation state currently matches — highlighted in the list (same
   .svRowSelected style the Layout blocks list uses), set on activate/
   update, and cleared the moment ANY of those settings changes through
   any interaction path: orbit drag/pan, wheel zoom, projection toggle,
   isometric presets, recenter, rotation sliders/resets, FOV, or light. See
   clearActiveView() calls scattered through this file and the generic
   [data-regen] listener in panel-controls.js for the actual hookup. */
let savedViews = [];
let savedViewCounter = 0;
let activeViewRef = null;
function renderSavedViews(){
  const list = $('viewsList');
  list.innerHTML = '';
  $('viewsFloat').classList.toggle('svEmpty', savedViews.length === 0);
  for (const view of savedViews){
    const row = document.createElement('div');
    row.className = 'savedView' + (view === activeViewRef ? ' svRowSelected' : '');
    row.dataset.viewName = view.name;
    row.innerHTML =
      '<span class="svName">' + view.name + '</span>' +
      '<button type="button" class="svBtn svUpdate" title="Update view with current settings" aria-label="Update ' + view.name + ' with current settings">&#10227;</button>' +
      '<button type="button" class="svBtn svDelete" title="Delete view" aria-label="Delete ' + view.name + '">&#10005;</button>';
    row.addEventListener('click', e => {
      if (e.target.closest('button')) return;   // Update/Delete clicks bubble here too — don't also activate
      activateView(view);
    });
    makeNameEditable(row.querySelector('.svName'), () => view.name, newName => {
      view.name = newName;
      renderSavedViews();
    });
    row.querySelector('.svUpdate').addEventListener('click', () => updateSavedView(view));
    row.querySelector('.svDelete').addEventListener('click', () => {
      const i = savedViews.indexOf(view);
      if (i >= 0) savedViews.splice(i, 1);
      if (activeViewRef === view) activeViewRef = null;
      renderSavedViews();
    });
    list.appendChild(row);
  }
}
renderSavedViews();   // sets the initial empty-state class — no other call site runs unconditionally at load
// Toggles the selection-highlight class on the matching row without
// rebuilding the list — used by activateView/updateSavedView, neither of
// which changes the list's item count, only which view is active. A full
// renderSavedViews() there was destroying every row's DOM (including the
// .svName span mid-gesture) on every single click, which broke the
// browser's double-click detection for renaming — clicking a view's name
// now activates it directly (see below), so this had to stop happening on
// every plain click, not just on add/delete.
function refreshSavedViewHighlight(){
  for (const row of $('viewsList').children){
    row.classList.toggle('svRowSelected', !!activeViewRef && row.dataset.viewName === activeViewRef.name);
  }
}
function captureCurrentViewState(){
  return {
    theta: orbit.theta, phi: orbit.phi, radius: orbit.radius,
    exactPole: orbit.exactPole,
    target: [orbit.target.x, orbit.target.y, orbit.target.z],
    fov: +$('fovDeg').value,
    shiftX: +$('camShiftX').value, shiftY: +$('camShiftY').value,
    ortho: camera === orthoCam,
    lightAz: +$('lightAz').value, lightEl: +$('lightEl').value,
    rotX: +$('rotX').value, rotY: +$('rotY').value, rotZ: +$('rotZ').value,
  };
}
function saveCurrentView(){
  savedViewCounter++;
  const view = Object.assign(
    { name: 'View ' + String(savedViewCounter).padStart(2, '0') },
    captureCurrentViewState());
  savedViews.push(view);
  activeViewRef = view;          // the just-saved view trivially matches the current live state
  renderSavedViews();
}
// Overwrites an EXISTING view's stored settings with the current live state
// — same name, same position in the list, just replacing what's saved.
function updateSavedView(view){
  Object.assign(view, captureCurrentViewState());
  activeViewRef = view;
  refreshSavedViewHighlight();
}
function activateView(view){
  setProjMode(view.ortho ? 'ortho' : 'persp');
  orbit.theta = view.theta;
  orbit.phi = view.phi;
  orbit.exactPole = view.exactPole || 0;   // fallback for views saved before this existed
  orbit.radius = view.radius;
  orbit.target.set(view.target[0], view.target[1], view.target[2]);
  $('fovDeg').value = view.fov;
  refreshValLabel($('fovDeg'));
  // Fallback to 0 for views saved before Shift was added to this feature.
  $('camShiftX').value = Number.isFinite(view.shiftX) ? view.shiftX : 0;
  $('camShiftY').value = Number.isFinite(view.shiftY) ? view.shiftY : 0;
  refreshValLabel($('camShiftX')); refreshValLabel($('camShiftY'));
  orbit.apply();                 // also updates the frustum for the restored FOV/ortho state
  $('lightAz').value = view.lightAz;
  $('lightEl').value = view.lightEl;
  updateLight(); updateLightGizmo();
  // Number.isFinite fallback to 0: views saved before rotation was added to
  // this feature simply don't have these fields — default to no rotation
  // rather than leaving whatever rotation happened to be active untouched,
  // since a saved view is meant to be a complete, predictable snapshot.
  $('rotX').value = Number.isFinite(view.rotX) ? view.rotX : 0;
  $('rotY').value = Number.isFinite(view.rotY) ? view.rotY : 0;
  $('rotZ').value = Number.isFinite(view.rotZ) ? view.rotZ : 0;
  refreshValLabel($('rotX')); refreshValLabel($('rotY')); refreshValLabel($('rotZ'));
  updateModelRotation();
  activeViewRef = view;
  refreshSavedViewHighlight();
  markStale();
}
// Called from every interaction elsewhere in this file that can change a
// setting a saved view captures — see the big comment above.
function clearActiveView(){
  if (activeViewRef){ activeViewRef = null; renderSavedViews(); }
}
$('saveViewBtn').addEventListener('click', saveCurrentView);

/* ================= layer UI ================= */

/* -------- called from scene-io.js's worker.onmessage when the
   worker reports a freshly parsed/loaded mesh -------- */
let modelGeo = null, flatNormalAttr = null, smoothNormalAttr = null;
function onLoaded(m){
  modelName = m.name;
  if (modelMesh) modelPivot.remove(modelMesh);
  if (modelGeo) modelGeo.dispose();
  if (gridHelper) scene.remove(gridHelper);
  if (groundCatcher) scene.remove(groundCatcher);

  modelCenter.set(m.center[0], m.center[1], m.center[2]);
  modelRadius = m.radius;
  modelBboxMinY = m.bboxMinY;

  // Single non-indexed geometry (each triangle owns its own 3 vertices) —
  // flat mode uses computeVertexNormals() on it directly (naturally flat,
  // since there's no vertex sharing for it to average across). Smooth mode
  // swaps in the worker's precomputed per-corner normals instead — same
  // buffer layout, so this is a plain attribute swap, no second geometry
  // or index buffer needed at all.
  modelGeo = new THREE.BufferGeometry();
  modelGeo.setAttribute('position', new THREE.BufferAttribute(m.display, 3));
  modelGeo.computeVertexNormals();
  flatNormalAttr = modelGeo.getAttribute('normal');
  smoothNormalAttr = new THREE.BufferAttribute(m.cornerNormals, 3);

  const useSmooth = $('smoothShading').checked;
  modelGeo.setAttribute('normal', useSmooth ? smoothNormalAttr : flatNormalAttr);
  modelMesh = new THREE.Mesh(modelGeo, new THREE.MeshPhongMaterial({
    color: 0xaeb6c2, side: THREE.DoubleSide, shininess: 18 }));
  // mesh sits at -center in the pivot's local space; the pivot itself sits
  // at +center in world space — combined, the mesh renders at its original
  // world position when the pivot's rotation is zero, and rotating the
  // pivot spins the mesh around modelCenter rather than its raw local origin
  modelMesh.position.set(-modelCenter.x, -modelCenter.y, -modelCenter.z);
  modelPivot.position.copy(modelCenter);
  modelPivot.add(modelMesh);
  // A freshly loaded model starts unrotated — unless this load is the
  // model-loading step of a .pen scene import, in which case
  // applyImportedScene (called below) restores the saved rotation right
  // after this and calls updateModelRotation() itself; resetting here first
  // is harmless in that case, just briefly overwritten.
  for (const id of ['rotX','rotY','rotZ']) $(id).value = 0;
  for (const id of ['rotX','rotY','rotZ']) refreshValLabel($(id));
  updateModelRotation();
  syncShadowCasting();

  gridHelper = new THREE.GridHelper(modelRadius * 4, 12, 0x6883a9, 0x5e636a);
  gridHelper.position.set(modelCenter.x, modelBboxMinY, modelCenter.z);
  scene.add(gridHelper);

  // Ground shadow catcher preview — the 3D-viewport counterpart of the SVG's
  // invisible catcher plane. ShadowMaterial renders fully transparent except
  // where a shadow actually lands on it, so with no shadow falling nearby it
  // is indistinguishable from having no plane there at all; it never shows
  // its own edges or a visible surface, matching the "invisible" framing of
  // the feature. Sized/positioned to match the SOLVER's plane exactly (same
  // 3x-radius extent, same bbox-min-Y default, same offset slider) rather
  // than a rough visual approximation, so the preview is a faithful stand-in
  // for what the export will show. Visibility/position/opacity are set by
  // syncGroundCatcher(), called right after this and on every relevant
  // checkbox/slider change.
  const groundGeo = new THREE.PlaneGeometry(modelRadius*6, modelRadius*6);
  groundGeo.rotateX(-Math.PI/2);
  groundCatcher = new THREE.Mesh(groundGeo, new THREE.ShadowMaterial({ opacity: 0.35 }));
  groundCatcher.receiveShadow = true;
  scene.add(groundCatcher);

  fitShadowFrustum();
  syncGroundCatcher();

  perspCam.near = orthoCam.near = Math.max(modelRadius * 0.01, 1e-4);
  perspCam.far  = orthoCam.far  = modelRadius * 60;

  const s = m.stats;
  $('modelStat').innerHTML = '<b>' + modelName + '</b><br>' +
    s.tris.toLocaleString() + ' tris · ' + s.verts.toLocaleString() + ' verts (welded) · ' +
    s.shells.toLocaleString() + ' shell' + (s.shells!==1?'s':'');
  const warn = [];
  if (s.flips)       warn.push(s.flips + ' faces re-wound');
  if (s.reoriented)  warn.push(s.reoriented + ' shell' + (s.reoriented>1?'s':'') + ' re-oriented');
  if (s.boundary)    warn.push(s.boundary + ' boundary edges (open mesh)');
  if (s.nonManifold) warn.push(s.nonManifold + ' non-manifold edges');
  $('modelWarn').textContent = warn.join(' · ');

  // Scene import in progress: the model just needed to finish loading (its
  // center/radius feed the ground plane, shadow frustum, near/far above) —
  // camera framing and every setting come from the imported file instead of
  // the usual "fit the new model" defaults, and generate() runs exactly
  // once, directly, rather than through the debounced auto-regenerate path
  // (which would otherwise fire once on default settings and again once
  // per restored control, however harmlessly that resolves in the end).
  if (importingScene){
    applyImportedScene(pendingSceneRestore);
    importingScene = false; pendingSceneRestore = null;
    $('statusL').textContent = 'imported scene · ' + modelName;
    doGenerate();
    return;
  }

  orbit.target.copy(modelCenter);
  orbit.radius = modelRadius * 2.8;
  orbit.apply();
  updateLight();
  $('statusL').textContent = 'loaded ' + modelName;
  doGenerate();
}

// One global toggle, forward-looking: today it drives both the viewport's
// display (swap geometry + flatShading, pure visual, instant) and the
// solver's smooth shadow boundary for Circles (needs a regenerate to take
// effect) — later, when hatch/crosshatch get the same smoothing, this same
// toggle will drive that too, rather than adding a second one.
function applySmoothShadingToggle(){
  if (!modelMesh || !modelGeo || !flatNormalAttr || !smoothNormalAttr) return;
  const useSmooth = $('smoothShading').checked;
  modelGeo.setAttribute('normal', useSmooth ? smoothNormalAttr : flatNormalAttr);
  modelGeo.attributes.normal.needsUpdate = true;
}
// The smooth-angle slider only applies to Smooth Shading — always visible,
// just disabled (same treatment as Shadow budg. under Cast shadows) for
// Flat Shading, where it's not relevant.
function syncSmoothAngleVisibility(){
  const on = $('smoothShading').checked;
  $('smoothAngleRow').classList.toggle('ctlDisabled', !on);
}
$('smoothShading').addEventListener('change', () => {
  applySmoothShadingToggle();
  syncSmoothAngleVisibility();
  markStale();
});
syncSmoothAngleVisibility();   // sets the initial visibility at load — no other call site runs unconditionally at load

// Re-runs just the corner-normal fan grouping in the worker with a new
// hard-edge threshold (see computeCornerNormals's own comment for why this
// is cheap — no weld/adjacency/shell recompute needed) rather than a full
// model reload. markStale() alongside it because the same normals also
// feed the solver's Circle-shadow smoothing at generate() time, not just
// this live viewport display — see applySmoothShadingToggle's own comment.
function applySmoothAngleChange(){
  if (!modelMesh) return;
  worker.postMessage({ type:'recomputeSmoothAngle', hardEdgeDeg: +$('smoothAngleDeg').value });
  markStale();
}
$('smoothAngleDeg').addEventListener('input', applySmoothAngleChange);
// Worker's reply to the message just above — swaps in the freshly computed
// normals and, if Smooth Shading is currently the active display mode,
// pushes the change to screen immediately rather than waiting on the next
// regenerate (which markStale() above will still eventually trigger, for
// the Circle-shadow side of this).
function onSmoothAngleResult(m){
  if (!modelGeo) return;
  smoothNormalAttr = new THREE.BufferAttribute(m.cornerNormals, 3);
  if ($('smoothShading').checked){
    modelGeo.setAttribute('normal', smoothNormalAttr);
    modelGeo.attributes.normal.needsUpdate = true;
  }
}

/* ================= Phase 1 prototype: shading-buffer capture =================
   [CONFIRMED WORKING — see project notes] Exploring whether Smooth
   Shading's soft+cast shadow hatching could eventually be driven by
   sampling an actual rendered shading pass, instead of the analytic Phong
   + shadow-map hybrid the worker currently computes. This block is
   PURELY ADDITIVE and is not called from anywhere else in the app — the
   render loop, generate(), and every existing material are completely
   untouched. Flat Shading is not part of this exploration at all and
   never will be; only Smooth Shading's soft/cast shadow computation is a
   candidate for eventually using this.

   Reuses the EXACT SAME `camera` object the live viewport renders with —
   not a reconstructed approximation of its FOV/aspect/near/far — so this
   inherits buildCamMessage()'s own view+projection matrices by
   construction, avoiding a whole class of alignment risk.

   The scene's AmbientLight(0.45) is deliberately NOT part of the output —
   a plain lit material would bake that flat baseline into every pixel,
   including deep shadow, contaminating exactly the signal hatch/circle
   generation would need (max(0,N·L) times shadow factor, nothing else).
   makeShadingMaterialFrom clones each mesh's own actual material (proven
   correct with shadows already, since that's what the live viewport
   renders) and overrides only its final output stage via onBeforeCompile,
   calling Three.js's own getShadow(shadowMap, shadowMapSize, shadowBias,
   shadowRadius, shadowCoord) — verified directly against this build's
   real compiled shader source, not guessed — so PCF shadow sampling is
   Three's own tested code, not hand-rolled.

   Usage from the browser console once a model is loaded:
     previewShadingBuffer()        — draws the captured buffer directly over
                                      the live viewport for a direct visual
                                      alignment check (shadow/terminator
                                      edges should land exactly on the
                                      visible mesh underneath)
     removeShadingBufferPreview()  — removes it
     captureShadingBuffer()        — returns { pixels, w, h } directly, for
                                      scripted/numeric inspection instead */
let shadingCaptureTarget = null;
function ensureShadingCaptureTarget(w, h){
  if (shadingCaptureTarget && shadingCaptureTarget.width === w && shadingCaptureTarget.height === h) return shadingCaptureTarget;
  if (shadingCaptureTarget) shadingCaptureTarget.dispose();
  shadingCaptureTarget = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    type: THREE.FloatType, format: THREE.RGBAFormat,
  });
  return shadingCaptureTarget;
}
let shadingMaterialVerified = false;
function makeShadingMaterialFrom(sourceMaterial){
  // Clone the mesh's OWN actual material — already proven to compile
  // correctly with shadows, since that's what the live viewport visibly
  // renders — instead of building a fresh material from scratch and
  // hoping it happens to pick up the same compile conditions. Only the
  // final output stage gets touched; everything else about the material
  // (and therefore whatever made shadows work for it) stays as-is.
  const mat = sourceMaterial.clone();
  mat.color.set(0xffffff);   // avoid the mesh's own albedo tinting the output
  mat.map = null; mat.normalMap = null; mat.roughnessMap = null;   // avoid texture-driven contamination — pure geometry+lighting only
  mat.metalnessMap = null; mat.aoMap = null; mat.emissiveMap = null;
  // Three caches compiled programs by a key it derives itself from ordinary
  // material/light/renderer state — it has no way to know onBeforeCompile's
  // injected GLSL below also depends on the Cast shadows checkbox, since
  // that's plain external JS state, invisible to Three's own key. Without
  // this, toggling Cast shadows (or Ground shadow, which forces the same
  // NUM_DIR_LIGHT_SHADOWS>0 condition on) after a program for the OTHER
  // state has already been compiled+cached reuses that stale program
  // outright — onBeforeCompile never runs again, so the buffer keeps
  // whatever shadow behavior was baked in the first time, until something
  // forces a full recompile (e.g. a page reload resets Three's cache).
  // customProgramCacheKey is exactly Three's own escape hatch for this:
  // fold the external condition into the key so each state gets its own
  // cached program instead of colliding.
  mat.customProgramCacheKey = () => $('castShadows').checked ? 'shadingCast' : 'shadingNoCast';
  mat.onBeforeCompile = shader => {
    // Overwrites the material's final color output (right at
    // #include<dithering_fragment>, one of the last chunks in Three's
    // standard fragment shader) with just the one quantity being tested:
    // N·L times the shadow factor, via Three's own getShadow() — verified
    // against this build's real compiled shader, not guessed.
    const marker = '#include <dithering_fragment>';
    // NUM_DIR_LIGHT_SHADOWS > 0 (hence a real shadow-map sample being
    // available at all) is driven by dirLight.castShadow, which
    // syncShadowCasting sets true whenever EITHER Cast shadows OR Ground
    // shadow is on (Ground shadow needs the model to cast onto the catcher
    // plane too) — so without this explicit check, turning Ground shadow
    // on with Cast shadows off would still bake real self-shadow darkening
    // into the captured buffer, leaking into Smooth Shading's Hatch and
    // Circles even though Cast shadows itself is unchecked.
    const shadowTerm = $('castShadows').checked ? `
      #if NUM_DIR_LIGHT_SHADOWS > 0
        shadingShadow = getShadow(directionalShadowMap[0], directionalLightShadows[0].shadowMapSize,
          directionalLightShadows[0].shadowBias, directionalLightShadows[0].shadowRadius, vDirectionalShadowCoord[0]);
      #endif
    ` : '';
    const injected = `
      float shadingNdotL = max(0.0, dot(normalize(vNormal), directionalLights[0].direction));
      float shadingShadow = 1.0;
      ${shadowTerm}
      gl_FragColor = vec4(shadingNdotL * shadingShadow, 1.0, 0.0, 1.0);
    `;
    if (shader.fragmentShader.includes(marker)){
      shader.fragmentShader = shader.fragmentShader.replace(marker, injected);
      shadingMaterialVerified = true;
    } else {
      shadingMaterialVerified = false;
      console.error('[shadingCapture] marker "' + marker + '" not found in this material\'s template — injection skipped, buffer will be wrong.');
    }
  };
  return mat;
}
function captureShadingBuffer(){
  if (!modelMesh){ console.warn('[shadingCapture] no model loaded'); return null; }
  const tStart = performance.now();
  const w = Math.max(1, vp.clientWidth), h = Math.max(1, vp.clientHeight);
  const target = ensureShadingCaptureTarget(w, h);
  const prevBackground = scene.background;
  scene.background = null;   // avoid a solid background color polluting non-geometry pixels — the G channel (always 1 where geometry was drawn) is what distinguishes "no geometry here" instead
  // The grid is purely a visual orientation aid, not part of the model — but
  // it's real scene geometry with its own depth, so when the camera looks
  // up at the model from below the grid plane, its lines sit in front of
  // the mesh and punch depth-tested gaps straight through the sampled N·L*
  // shadow buffer. Hide it for this one render, restore right after.
  const prevGridVisible = gridHelper ? gridHelper.visible : null;
  if (gridHelper) gridHelper.visible = false;
  // Swaps each mesh's own material for a clone of itself (see
  // makeShadingMaterialFrom) — modelMesh may be a Group of multiple
  // shells, so this walks every Mesh found under it and clones each one's
  // own material individually, rather than assuming they're identical.
  const swapped = [];
  modelMesh.traverse(o => {
    if (o.isMesh){
      swapped.push([o, o.material]);
      o.material = makeShadingMaterialFrom(o.material);
    }
  });
  const tAfterSwap = performance.now();
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  const tAfterRender = performance.now();
  renderer.setRenderTarget(prevTarget);
  for (const [o, mat] of swapped) o.material = mat;   // restore originals
  scene.background = prevBackground;
  if (gridHelper) gridHelper.visible = prevGridVisible;
  if (!shadingMaterialVerified){
    console.warn('[shadingCapture] proceeding despite the shader-injection check above failing — treat this buffer as unverified.');
  }
  const pixels = new Float32Array(w*h*4);
  renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);
  const tEnd = performance.now();
  // Phase 3 measurement — always computed (performance.now() calls are
  // essentially free), not gated behind a special "benchmark mode", so
  // ordinary use of this function (Phase 2's doGenerate hook, Phase 1's
  // previewShadingBuffer) also feeds real-world numbers into
  // benchmarkShadingCapture's running stats below.
  const timing = {
    materialSwapMs: tAfterSwap - tStart,
    renderMs: tAfterRender - tAfterSwap,
    // readRenderTargetPixels forces the GPU pipeline to sync/flush before
    // the CPU can read results back — in most WebGL setups this, not the
    // render itself, is where most of the real cost of an extra pass
    // tends to show up.
    readbackMs: tEnd - tAfterRender,
    totalMs: tEnd - tStart,
    meshCount: swapped.length, w, h,
    bufferBytes: pixels.byteLength,
  };
  if (typeof recordShadingCaptureTiming === 'function') recordShadingCaptureTiming(timing);
  return { pixels, w, h, timing };
}
/* ================= Phase 3: measurement =================
   Real numbers on real geometry, not estimates. Call from the browser
   console once a model is loaded:
     benchmarkShadingCapture(n)   — runs n captures (default 20), reports
                                     avg/min/max timing per stage
     analyzeShadingBuffer()       — one capture, scanned for the same
                                     brightness-discontinuity metric the
                                     original standalone prototype used,
                                     so the numbers are directly comparable
                                     to what was already validated there */
let shadingCaptureTimingLog = [];
function recordShadingCaptureTiming(t){
  shadingCaptureTimingLog.push(t);
  if (shadingCaptureTimingLog.length > 200) shadingCaptureTimingLog.shift();   // bounded — avoid unbounded growth over a long session
}
function benchmarkShadingCapture(n){
  n = n || 20;
  if (!modelMesh){ console.warn('[shadingBench] no model loaded'); return; }
  const before = shadingCaptureTimingLog.length;
  for (let i = 0; i < n; i++) captureShadingBuffer();
  const samples = shadingCaptureTimingLog.slice(before);
  const stat = key => {
    const vals = samples.map(s => s[key]);
    const sum = vals.reduce((a,b) => a+b, 0);
    return { avg: sum/vals.length, min: Math.min(...vals), max: Math.max(...vals) };
  };
  console.log('[shadingBench] ' + n + ' captures at ' + samples[0].w + '\u00d7' + samples[0].h +
    ' (' + samples[0].meshCount + ' mesh(es)), ' + (samples[0].bufferBytes/1024/1024).toFixed(2) + ' MB per buffer:');
  for (const key of ['materialSwapMs', 'renderMs', 'readbackMs', 'totalMs']){
    const s = stat(key);
    console.log('  ' + key + ': avg ' + s.avg.toFixed(2) + 'ms, min ' + s.min.toFixed(2) + 'ms, max ' + s.max.toFixed(2) + 'ms');
  }
  console.log('[shadingBench] for context, compare totalMs against the status bar\'s own generate() time ' +
    '(e.g. "...\u00b7 55 ms") to judge relative overhead.');
}
window.benchmarkShadingCapture = benchmarkShadingCapture;
function analyzeShadingBuffer(){
  const cap = captureShadingBuffer();
  if (!cap) return null;
  const { pixels: buf, w, h } = cap;
  // Same methodology as the standalone (non-Three.js) prototype that
  // originally validated Phase 1's core premise — scans every row, within
  // continuous "hasGeometry" runs, for the largest single-texel-to-texel
  // brightness jump. Directly comparable to those earlier numbers, just
  // against this build's real geometry instead of a synthetic two-torus
  // test scene.
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
  console.log('[shadingAnalyze] buffer ' + w + '\u00d7' + h + ' (' + (w*h) + ' px):');
  console.log('  max single-texel brightness jump: ' + maxJump.toFixed(4) + ' at ' + JSON.stringify(maxJumpLoc));
  console.log('  jump counts (pixel-pairs exceeding each threshold):', counts);
  console.log('  for reference, the standalone prototype at 800\u00d7800 on a synthetic two-torus scene ' +
    'saw a max jump of ~0.51 with a narrow 3\u00d73 PCF filter (~0.46 with a wider one), and >0.3 jumps in ' +
    'the tens out of ~640,000 pixel-pairs \u2014 coherent boundary curves, not scattered noise. Values in a ' +
    'similar range here would suggest the same holds on real geometry; a much higher count or max would ' +
    'be worth a closer look before moving on.');
  return { maxJump, maxJumpLoc, counts, w, h };
}
window.analyzeShadingBuffer = analyzeShadingBuffer;
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
  // Positioned to match the 3D viewport PANE's own bounding rect, not
  // inset:0 (the whole browser window) — vp sits below the header bar and
  // isn't at the window's own origin, so inset:0 was drawing the buffer at
  // the right SIZE but the wrong POSITION, off by exactly the header's
  // height. Re-measured on every call rather than cached, since panel
  // layout could plausibly change between calls.
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
  console.log('[shadingCapture] buffer drawn over the live viewport (white=captured geometry areas). ' +
    'Compare its silhouette and shadow/terminator edges against the mesh underneath — they should line up exactly, ' +
    'with no offset or scale mismatch, since this reused the exact same camera object. ' +
    'Call removeShadingBufferPreview() to remove it and see the live view again.');
}
function removeShadingBufferPreview(){
  const overlay = document.getElementById('shadingBufferPreview');
  if (overlay) overlay.remove();
}
window.captureShadingBuffer = captureShadingBuffer;
window.previewShadingBuffer = previewShadingBuffer;
window.removeShadingBufferPreview = removeShadingBufferPreview;

// Chain touching 2-point segments into maximal polylines. A segment's own
// endpoints already carry all the information needed — no extra data from the
// solver required, this is purely a presentation-layer optimization on 2D
// points that are already known to be correct. Open chains (a curve broken by
// real occlusion, or a boundary that's genuinely cut off) keep two distinct
// ends; closed chains (loop back to their own start) get flagged so the caller
// can emit an SVG "Z" instead of a duplicate closing point.
