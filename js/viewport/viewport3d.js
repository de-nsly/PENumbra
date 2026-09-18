/* ================================================================
   viewport3d.js — the 3D viewport
   Three.js scene/camera/renderer, orbit controls (drag/zoom), the
   axis gizmo and light-direction gizmo, projection mode toggle,
   view presets, lighting + shadow sync, onLoaded() which wires a
   freshly parsed mesh (from the worker) into the live 3D scene, and the
   smooth-shading normals.
   The two things built ON this scene have their own files: the saved
   views panel (saved-views.js) and the offscreen shading-buffer
   readback (shading-capture.js). Both only read `renderer`/`scene`/
   `camera` from here, which is why those are exported.
   ================================================================ */
import { $, onMiddleDblClick, positionSegPill, svgEl, worker } from '../main.js';
import { activeTab, doGenerate, markStale, refreshValLabel } from '../panel-controls.js';
import { computePaperLayout } from '../paper-layout.js';
import { applyPaperView } from '../paper-preview.js';
import { applyImportedScene, takePendingSceneImport } from '../scene-io.js';
import { clearActiveView } from './saved-views.js';

/* ================= three.js viewport ================= */
export const vp = $('viewport3d');
export let renderer;
export const scene = new THREE.Scene();
export const perspCam = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
export const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
export let camera = perspCam;
export function updateFrustum(){
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
export let modelMesh = null, gridHelper = null, groundCatcher = null;
export let modelCenter = new THREE.Vector3(), modelRadius = 1, modelBboxMinY = 0, modelName = 'demo scene';
// Rotate-model feature: modelMesh is a CHILD of modelPivot (not added to
// `scene` directly), positioned at -modelCenter in the pivot's local space;
// modelPivot itself sits AT modelCenter. Rotating modelPivot therefore
// rotates the mesh around its own center rather than around the world
// origin or whatever arbitrary point its raw geometry data happens to use
// as (0,0,0). gridHelper/groundCatcher/dirLight stay direct children of
// `scene` (not the pivot) — the ground plane and lighting are a world-space
// reference frame that deliberately does NOT tip along with the model.
export const modelPivot = new THREE.Object3D();

/* --- minimal orbit controls (rotate / pan / dolly) --- */
export const orbit = {
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
// Pan speeds, in orbit radii per screen px of drag / per arrow-key press,
// both before the fovPanScale() correction. Tuned by feel.
const PAN_DRAG_RATE = 0.00098484;
const PAN_KEY_STEP  = 0.019818;
let dragBtn = -1, lastX = 0, lastY = 0;

// Arrow keys pan the camera along its OWN local axes (up/down/left/right
// on screen, not world axes) — only while the mouse is over the 3D
// viewport, so this never fights with arrow keys' native behavior in a
// focused slider or an in-place value editor elsewhere on the page.
// Reuses the exact same local-right/up extraction and radius-scaled
// target-shift the existing Shift+drag pan gesture already uses above,
// just a fixed step per keypress instead of following mouse delta.
let vpHover = false;
const ARROW_PAN_KEYS = { ArrowUp:[0,1], ArrowDown:[0,-1], ArrowRight:[1,0], ArrowLeft:[-1,0] };

function resize(){
  const w = vp.clientWidth, h = vp.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  updateFrustum();
}
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
const gizmoSvg = $('axisGizmo');
let gizmoParts;
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
export function updateLightGizmo(){
  const az = +$('lightAz').value, el = +$('lightEl').value;
  const [sx, sy] = lgAzToXY(az);
  lgAzNeedle.setAttribute('x2', sx); lgAzNeedle.setAttribute('y2', sy);
  lgAzSun.setAttribute('transform', `translate(${sx} ${sy})`);
  const ey = lgElToY(el);
  lgElFill.setAttribute('y1', LG.ty1); lgElFill.setAttribute('y2', ey);
  lgElSun.setAttribute('transform', `translate(${LG.tx} ${ey})`);
}
let lgAzNeedle, lgAzSun, lgElFill, lgElSun;

export function setProjMode(mode){
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
// canonical CAD views. These set the ANGLE only and respect whichever
// projection is active — in perspective you get the same viewpoint with
// depth convergence, in orthographic the true measured view. Toggle the
// projection button if you need the strict CAD interpretation.
const VIEW_PRESETS = {
  nw: { theta:135, phi:54.7356 }, ne: { theta:45,  phi:54.7356 },
  sw: { theta:225, phi:54.7356 }, se: { theta:315, phi:54.7356 },
};

// Recenters the model in the viewport by moving the orbit PIVOT to the
// model's center — theta/phi/radius (view angle and zoom) are deliberately
// left untouched, so this only re-centers, it never reframes.
function recenter3dView(){
  orbit.target.copy(modelCenter);
  orbit.apply();
  markStale();
  clearActiveView();
}

export function updateLight(){
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
export function syncShadowCasting(){
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
// geometry — every vertex rotated and scanned, not the rotated bounding
// box (whose corners overshoot the real footprint and would leave the
// model floating above the catcher plane). The worker does the same scan
// on its rotated copy (generate() step 1.5), so the exported ground-shadow
// hatching matches this preview exactly.
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
export function syncGroundCatcher(){
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
export function lightVec(){
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
export function updateModelRotation(){
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

/* ================= model loaded =================
   Called from scene-io.js's worker.onmessage when the worker reports a
   freshly parsed/loaded mesh. */
let modelGeo = null, flatNormalAttr = null, smoothNormalAttr = null;
export function onLoaded(m){
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
  const pendingScene = takePendingSceneImport();
  if (pendingScene){
    applyImportedScene(pendingScene);
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

// One toggle drives both the viewport's display (swap the normal
// attribute, pure visual, instant) and the solver's shading source for
// Hatch/Circles (the captured shading buffer instead of per-face
// brightness — needs a regenerate to take effect).
export function applySmoothShadingToggle(){
  if (!modelMesh || !modelGeo || !flatNormalAttr || !smoothNormalAttr) return;
  const useSmooth = $('smoothShading').checked;
  modelGeo.setAttribute('normal', useSmooth ? smoothNormalAttr : flatNormalAttr);
  modelGeo.attributes.normal.needsUpdate = true;
}
// The smooth-angle slider only applies to Smooth Shading — always visible,
// just disabled (same treatment as Shadow budg. under Cast shadows) for
// Flat Shading, where it's not relevant.
export function syncSmoothAngleVisibility(){
  const on = $('smoothShading').checked;
  $('smoothAngleRow').classList.toggle('ctlDisabled', !on);
}

// Re-runs just the corner-normal fan grouping in the worker with a new
// hard-edge threshold (see computeCornerNormals's own comment for why this
// is cheap — no weld/adjacency/shell recompute needed) rather than a full
// model reload. markStale() alongside it because the normals change the
// shading buffer the next generate captures, not just the live display.
export function applySmoothAngleChange(){
  if (!modelMesh) return;
  worker.postMessage({ type:'recomputeSmoothAngle', hardEdgeDeg: +$('smoothAngleDeg').value });
  markStale();
}
// Worker's reply to the message just above — swaps in the freshly computed
// normals and, if Smooth Shading is currently the active display mode,
// pushes the change to screen immediately rather than waiting on the next
// regenerate.
export function onSmoothAngleResult(m){
  if (!modelGeo) return;
  smoothNormalAttr = new THREE.BufferAttribute(m.cornerNormals, 3);
  if ($('smoothShading').checked){
    modelGeo.setAttribute('normal', smoothNormalAttr);
    modelGeo.attributes.normal.needsUpdate = true;
  }
}

/* ================= init =================
   Everything above only declares. This wires the DOM and starts the
   module's live behaviour — called once by app.js, in script order. */
export function initViewport3d(){
  renderer = new THREE.WebGLRenderer({ antialias:true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // Enabled once, unconditionally, at startup — toggling this flag later would
  // force a shader recompile on every material in the scene. Actual shadow
  // presence is controlled per-light/per-mesh instead (cheap to flip), driven
  // by the Cast shadows / Ground shadow checkboxes.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  vp.appendChild(renderer.domElement);
  scene.background = new THREE.Color(0x353c47);
  dirLight.shadow.mapSize.set(2048, 2048);
  scene.add(dirLight, dirLight.target, new THREE.AmbientLight(0xffffff, 0.45));
  scene.add(modelPivot);
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
      const k = orbit.radius * PAN_DRAG_RATE * fovPanScale();
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
  vp.addEventListener('pointerenter', () => { vpHover = true; });
  vp.addEventListener('pointerleave', () => { vpHover = false; });
  document.addEventListener('keydown', e => {
    if (!vpHover) return;
    const dir = ARROW_PAN_KEYS[e.key];
    if (!dir) return;
    e.preventDefault();
    const step = orbit.radius * PAN_KEY_STEP * fovPanScale();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up    = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
    orbit.target.addScaledVector(right, dir[0] * step).addScaledVector(up, dir[1] * step);
    orbit.apply(); markStale(); clearActiveView();
  });
  new ResizeObserver(() => { resize(); markStale(); }).observe(vp);
  resize();
  new ResizeObserver(() => {
    const layout = computePaperLayout(); if (layout) applyPaperView(layout);
  }).observe($('paperPane'));
  gizmoParts = GIZMO_AXES.map(ax => {
    const positive = ax.l !== '';
    let line = null;
    if (positive){                          // stem only on positive halves, like Blender
      line = svgEl('line');
      line.setAttribute('stroke', ax.c);
      line.setAttribute('stroke-width', '1.8');
      gizmoSvg.appendChild(line);
    }
    const g = svgEl('g');
    g.setAttribute('class', 'ball');
    const c = svgEl('circle');
    c.setAttribute('r', positive ? 9 : 7);
    c.setAttribute('fill', ax.c);
    if (!positive){ c.setAttribute('fill-opacity', '0.25'); c.setAttribute('stroke', ax.c); c.setAttribute('stroke-width', '1.4'); }
    g.appendChild(c);
    let t = null;
    if (positive){
      t = svgEl('text');
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
  /* the floating export panel sits ON the pannable/zoomable 2D pane — swallow
     its pointer/wheel events so adjusting a dropdown never pans the paper */
  ['pointerdown','wheel','dblclick'].forEach(t => {
    $('genExportFloat').addEventListener(t, e => e.stopPropagation());
  });
  (function buildLightGizmo(){
    const sun = cls => {
      const g = svgEl('g', { class: cls });
      g.appendChild(svgEl('circle', { r:8 }));
      return g;
    };
    // azimuth ring
    lgSvg.appendChild(svgEl('text', { class:'lgLbl', x:LG.cx, y:25, 'text-anchor':'middle' })).textContent = 'Azimuth';
    lgSvg.appendChild(svgEl('circle', { class:'lgRing', cx:LG.cx, cy:LG.cy, r:LG.r }));
    lgAzNeedle = lgSvg.appendChild(svgEl('line', { class:'lgNeedle', x1:LG.cx, y1:LG.cy, x2:LG.cx, y2:LG.cy+LG.r }));
    const lgAzHit = lgSvg.appendChild(svgEl('circle', { class:'lgHit', cx:LG.cx, cy:LG.cy, r:LG.r+9 }));
    lgAzSun = lgSvg.appendChild(sun('lgSun'));
    // elevation gauge
    lgSvg.appendChild(svgEl('text', { class:'lgLbl', x:LG.tx, y:25, 'text-anchor':'middle' })).textContent = 'Elev.';
    lgSvg.appendChild(svgEl('line', { class:'lgTrackBg', x1:LG.tx, y1:LG.ty0, x2:LG.tx, y2:LG.ty1 }));
    lgElFill = lgSvg.appendChild(svgEl('line', { class:'lgTrackFill', x1:LG.tx, y1:LG.ty1, x2:LG.tx, y2:LG.ty1 }));
    const lgElHit = lgSvg.appendChild(svgEl('rect', { class:'lgHit', x:LG.tx-15, y:LG.ty0-12, width:30, height:LG.ty1-LG.ty0+24 }));
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
    if (activeTab === 'preview'){
      renderer.render(scene, camera);
      drawGizmo();
    }
  })();
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
  document.querySelectorAll('.vpBtn').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = VIEW_PRESETS[btn.dataset.view];
      orbit.theta = v.theta * Math.PI / 180;
      orbit.phi = v.phi * Math.PI / 180;
      orbit.exactPole = 0;
      orbit.apply(); markStale(); clearActiveView();
    });
  });
  $('recenter3dBtn').addEventListener('click', recenter3dView);
  // same reset via a double middle-click anywhere on the 3D canvas
  onMiddleDblClick(renderer.domElement, recenter3dView);
  $('smoothShading').addEventListener('change', () => {
    applySmoothShadingToggle();
    syncSmoothAngleVisibility();
    markStale();
  });
  syncSmoothAngleVisibility();   // sets the initial visibility at load — no other call site runs unconditionally at load
  $('smoothAngleDeg').addEventListener('input', applySmoothAngleChange);
}
