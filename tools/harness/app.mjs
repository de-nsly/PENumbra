/* ================================================================
   tools/harness/app.mjs — headless PENumbra, main thread + worker
   Reproduces exactly what the browser app does between "user drops a
   .pen file" and "the worker posts a result", with no DOM and no
   browser:

     importScene()  -> worker 'load'  -> onLoaded()
                    -> applyImportedScene() (camera + settings)
                    -> doGenerate() -> worker 'generate' -> onResult()

   The worker itself (js/worker/*.js) is the REAL one, imported
   unmodified — `self` is stubbed below before the import so its
   dispatcher installs the same way it does inside a Worker. The
   camera matrices come from the REAL three.js r128 (the same
   cdnjs build index.html loads, vendored under vendor/), driven
   through the same orbit.apply()/updateFrustum() math as
   viewport3d.js — so cam.view/cam.proj are bit-identical to the
   browser's, which matters for a scene whose whole problem is
   exactly-coincident geometry. gatherSettings/computePaperLayout are
   not reimplemented either: their source is lifted out of the real
   app files at runtime (see extract.mjs).

   The one thing that genuinely can't be reproduced headlessly is the
   WebGL shading-buffer readback (captureShadingBuffer). It only feeds
   Hatch/Circles density, so generate() gets shadingBuffer:null — the
   same thing the app sends with Smooth shading off. Line layers
   (Silhouette/Contour/Crease) are unaffected.
   ================================================================ */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractFrom, evalWithEnv } from './extract.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const THREE = require(path.join(HERE, 'vendor', 'three.min.js'));

/* The app's own viewport is whatever size the user's browser window
   happened to give it, and a .pen file doesn't record it — but the
   solver works in viewport pixels, so it has to be stated. This default
   is recovered from the reference exports in pen_files/ (their
   invertPageBounds pins vp to 798x947); override with --vp WxH. */
export const DEFAULT_VIEWPORT = { w: 798, h: 947 };

/* Shared-worker bookkeeping — see boot() below. */
let workerDispatch = null;   // the worker's own self.onmessage, installed once
let activeApp = null;        // whose post() is in flight (routes replies back)
let meshOwner = null;        // whose model is currently loaded in the worker

/* ---------- minimal DOM stand-in ----------
   Just enough of an "element" for the extracted app code, which only ever
   touches .value / .checked / .type on the controls it reads. */
class El {
  constructor(id, val){
    this.id = id;
    this.type = typeof val === 'boolean' ? 'checkbox' : 'text';
    if (typeof val === 'boolean') this.checked = val; else this.value = String(val);
  }
}

export class HarnessApp {
  constructor(){
    this.els = new Map();
    this.layers = {};
    this.vp = { clientWidth: DEFAULT_VIEWPORT.w, clientHeight: DEFAULT_VIEWPORT.h };
    this.messages = [];         // everything the worker has posted back
    this.errors = [];           // 'error' posts (see _onWorkerMessage)
    this.lastGen = null;        // the app's `lastGen` — the last 'result'
    this.loaded = null;         // the 'loaded' reply (center/radius/stats)
    this.modelRadius = 1;
    this._installAppCode();
  }

  /* ---- $(id) ---- */
  $(id){
    let el = this.els.get(id);
    if (!el){ el = new El(id, ''); this.els.set(id, el); }   // absent control reads as empty, like a missing id would never happen in the app
    return el;
  }
  setControl(id, val){ this.els.set(id, new El(id, val)); }

  /* ---- worker boot ----
     Same module, same entry point as `new Worker('js/worker/solver.js',
     {type:'module'})`; only the transport is different. postMessage's
     transfer list is ignored on purpose — nothing here reuses a posted
     buffer afterward, so not detaching is harmless and keeps the results
     readable.

     The worker module is a singleton here — ES modules are cached, so a
     second HarnessApp gets the SAME module instance, including its
     module-level mesh state `M`. That's the browser's own model too (one
     worker, one loaded mesh), so rather than pretending otherwise, the
     mesh's current owner is tracked and re-posted whenever a different app
     wants to solve (see _ensureMesh). Two scenes can therefore be compared
     in one process, just not solved simultaneously. */
  async boot(){
    if (!workerDispatch){
      globalThis.self = {
        postMessage(msg){
          if (!activeApp) return;
          activeApp.messages.push(msg);
          activeApp._onWorkerMessage(msg);
        },
        onmessage: null,
      };
      await import(new URL('../../js/worker/solver.js', import.meta.url).href);
      if (typeof globalThis.self.onmessage !== 'function')
        throw new Error('worker did not install its onmessage dispatcher');
      workerDispatch = globalThis.self.onmessage;
    }
    this.post = m => { activeApp = this; workerDispatch({ data: m }); };
  }
  // Re-loads this app's model into the shared worker if another app's is
  // currently resident. No-op in the common single-scene case.
  _ensureMesh(){
    if (meshOwner === this) return;
    if (!this._loadMsg) throw new Error('no model loaded — call loadScene() first');
    this.post(this._loadMsg());
  }

  _onWorkerMessage(m){
    if (m.type === 'loaded') this._onLoaded(m);
    else if (m.type === 'result') this.lastGen = m;
    // 'error' is not necessarily fatal in the worker — generate() posts one
    // and keeps going for the missing shading buffer (see the header note),
    // so these are collected and surfaced, not thrown. A generate that truly
    // failed produces no 'result' at all, which generate() below catches.
    else if (m.type === 'error') this.errors.push(m.msg);
  }
  // viewport3d.js onLoaded(), minus everything that only exists to draw
  _onLoaded(m){
    this.loaded = m;
    meshOwner = this;
    this.modelCenter = new THREE.Vector3(m.center[0], m.center[1], m.center[2]);
    this.modelRadius = m.radius;
    this.perspCam.near = this.orthoCam.near = Math.max(this.modelRadius * 0.01, 1e-4);
    this.perspCam.far  = this.orthoCam.far  = this.modelRadius * 60;
  }

  /* ---- app code borrowed verbatim (see extract.mjs) ---- */
  _installAppCode(){
    const app = this;
    this.perspCam = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
    this.camera = this.perspCam;
    this.modelPivot = new THREE.Object3D();

    const $ = id => app.$(id);
    // env values arrive as plain function parameters, so anything the app code
    // reads LIVE (and the harness can reassign — `camera`, `lastGen`) is
    // declared inside the evaluated scope instead, with a tiny setter exported
    // alongside. `vp` needs no such treatment: it's a stable object whose
    // properties are mutated in place, exactly like a real DOM element.

    // svg-export.js: the paper transform (solver px -> page mm)
    const paperSrc = extractFrom(path.join(REPO, 'js', 'svg-export.js'),
      ['PAPERS', 'getMargins', 'computePaperLayout']);
    const paper = evalWithEnv(
      'let lastGen = null;\n' + paperSrc + '\nfunction __setLastGen(v){ lastGen = v; }',
      { $ }, ['computePaperLayout', 'getMargins', '__setLastGen']);
    // dims is optional in the app too — computePaperLayout falls back to
    // lastGen, so that has to be pushed in fresh on every call
    this.computePaperLayout = dims => { paper.__setLastGen(app.lastGen); return paper.computePaperLayout(dims); };
    this.getMargins = paper.getMargins;

    // viewport3d.js: light direction + the orbit->camera construction
    const lightSrc = extractFrom(path.join(REPO, 'js', 'viewport3d.js'), ['lightVec']);
    this.lightVec = evalWithEnv(lightSrc, { $ }, ['lightVec']).lightVec;

    const orbitSrc = extractFrom(path.join(REPO, 'js', 'viewport3d.js'),
      ['updateFrustum', 'orbit']);
    const o = evalWithEnv(orbitSrc,
      { $, vp: this.vp, perspCam: this.perspCam, orthoCam: this.orthoCam, THREE },
      ['orbit', 'updateFrustum']);
    this.orbit = o.orbit;
    this.updateFrustum = o.updateFrustum;

    // panel-controls.js: the exact settings object the worker is sent
    const setSrc = extractFrom(path.join(REPO, 'js', 'panel-controls.js'),
      ['SHADOW_BUDGET_PRESETS', 'HATCH_CAP_PRESETS', 'gatherSettings', 'buildCamMessage']);
    const s = evalWithEnv(
      'let camera = null;\n' + setSrc + '\nfunction __setCamera(v){ camera = v; }',
      {
        $, vp: this.vp, THREE,
        computePaperLayout: d => app.computePaperLayout(d),
        layerStyle: k => app.layerStyle(k),
        lightVec: () => app.lightVec(),
        modelPivot: this.modelPivot,
      },
      ['gatherSettings', 'buildCamMessage', '__setCamera']);
    this._setCamera = s.__setCamera;
    this.gatherSettings = s.gatherSettings;
    this.buildCamMessage = s.buildCamMessage;
    this._setCamera(this.camera);
  }

  /* Ticking a layer's pen checkbox. Every layer is solve:true (see LAYERS in
     js/main.js) — toggling one changes what survives in every layer below it
     — so this must be followed by a fresh generate(), exactly as in the app. */
  setLayer(key, on){
    if (!this.layers[key]) this.layers[key] = { on:false, color:'#000000', width:0.35, dash:'solid' };
    this.layers[key].on = !!on;
    return this;
  }
  setLayers(spec){ for (const [k, v] of Object.entries(spec)) this.setLayer(k, v); return this; }

  layerStyle(key){
    const st = this.layers[key];
    return st ? { on: !!st.on, color: st.color, width: +st.width, dash: st.dash }
              : { on: false, color: '#000000', width: 1, dash: 'solid' };
  }

  // viewport3d.js setProjMode(), stripped to the part the solver can see
  setProjMode(mode){
    this.camera = mode === 'ortho' ? this.orthoCam : this.perspCam;
    this._setCamera(this.camera);
  }
  // viewport3d.js updateModelRotation() — note the deliberate Y/Z swap
  updateModelRotation(){
    const rx = +this.$('rotX').value * Math.PI/180;
    const ry = +this.$('rotY').value * Math.PI/180;
    const rz = +this.$('rotZ').value * Math.PI/180;
    this.modelPivot.rotation.set(rx, rz, ry, 'XYZ');
    this.modelPivot.updateMatrixWorld(true);
  }

  /* ---- scene-io.js importScene() + applyImportedScene() ---- */
  async loadScene(penPath, opts = {}){
    // 'demo' stands in for a .pen holding the app's own built-in demo scene —
    // a second, independent mesh to regression-sweep against without needing
    // a fixture file. Settings/layers stay at the app's HTML defaults (absent
    // ids read as empty, which is what a fresh page does before any input).
    const data = penPath === 'demo'
      ? { penumbraScene: 1, model: { demo: true },
          camera: { theta: 0.7, phi: 1.12, radius: 5, exactPole: 0, target: [0,0,0], ortho: false },
          settings: { fovDeg: '40', camShiftX: '0', camShiftY: '0', rotX: '0', rotY: '0', rotZ: '0',
            lightAz: '35', lightEl: '42', hatchAng: '45', hatchMin: '1', hatchMax: '7', hatchCap: '4',
            hatchThr: '0.92', crossThr: '0.45', deepThr: '0.18', texCirclesThr: '0.92',
            texGroundPatternCenterX: '0', texGroundPatternCenterY: '0',
            watertight: true, dedupOffMult: '1', dedupGapMult: '1',
            contourCleanup: '0.025', contourMaxHops: '3', creaseDeg: '1',
            softShadows: false, invertShadows: false, castShadows: true, groundShadow: false,
            shadowBudget: '1', groundOff: '0', smoothShading: false, smoothAngleDeg: '30',
            paperSize: 'A3', orient: 'portrait', marginMm: '5', marginIndependent: false },
          layers: {} }
      : JSON.parse(readFileSync(penPath, 'utf8'));
    if (!data || data.penumbraScene !== 1 || !data.model)
      throw new Error('unrecognized scene file: ' + penPath);
    this.scene = data;
    // mutated in place, never reassigned — the extracted app code holds a
    // reference to this exact object (see _installAppCode)
    if (opts.viewport){
      this.vp.clientWidth = opts.viewport.w;
      this.vp.clientHeight = opts.viewport.h;
    }

    // model first — onLoaded's center/radius feed near/far, exactly as in the app.
    // Rebuilt fresh each time it's posted (the worker's parsers consume the
    // ArrayBuffer), so this is a factory, not a cached message.
    if (data.model.demo){
      this.modelName = 'demo scene';
      this._loadMsg = () => ({ type: 'demo' });
    } else {
      this.modelName = data.model.name;
      const buf = Buffer.from(data.model.dataB64, 'base64');
      this._loadMsg = () => ({
        type: 'load', name: data.model.name, zUp: !!data.model.zUp,
        buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      });
    }
    this.post(this._loadMsg());
    this._applyImportedScene(data);
    return this;
  }

  _applyImportedScene(data){
    for (const [id, val] of Object.entries(data.settings || {})) this.setControl(id, val);
    this.layers = {};
    for (const [key, st] of Object.entries(data.layers || {})) this.layers[key] = { ...st };
    const cs = data.camera || {};
    this.setProjMode(cs.ortho ? 'ortho' : 'persp');
    if (Number.isFinite(cs.theta))  this.orbit.theta  = cs.theta;
    if (Number.isFinite(cs.phi))    this.orbit.phi    = cs.phi;
    if (Number.isFinite(cs.radius)) this.orbit.radius = cs.radius;
    this.orbit.exactPole = Number.isFinite(cs.exactPole) ? cs.exactPole : 0;
    if (Array.isArray(cs.target)) this.orbit.target.set(cs.target[0], cs.target[1], cs.target[2]);
    this.orbit.apply();
    this.updateModelRotation();
  }

  /* ---- panel-controls.js doGenerate() ----
     shadingBuffer is null here (no WebGL) — see the header note. */
  generate(overrides){
    this._ensureMesh();
    const settings = this.gatherSettings();
    if (overrides) Object.assign(settings, overrides);
    this.lastSettings = settings;
    this.lastCam = this.buildCamMessage();
    this.lastGen = null;
    this.errors = [];
    this.post({ type: 'generate', cam: this.lastCam, settings, shadingBuffer: null });
    if (!this.lastGen) throw new Error('generate produced no result' +
      (this.errors.length ? ': ' + this.errors.join('; ') : ''));
    return this.lastGen;
  }

  /* ---- the two Contour debug paths the app's Debug panel exposes ---- */
  debugRawContourEdges(){
    this._ensureMesh();
    this.post({ type: 'debugRawContourEdges', cam: this.buildCamMessage() });
    return this.messages[this.messages.length-1];
  }
  debugRawEdges(){
    this._ensureMesh();
    this.post({ type: 'debugRawEdges', cam: this.buildCamMessage(),
                creaseDeg: +this.$('creaseDeg').value || 0 });
    return this.messages[this.messages.length-1];
  }
}

export async function openScene(penPath, opts){
  const app = new HarnessApp();
  await app.boot();
  await app.loadScene(penPath, opts);
  return app;
}
export { THREE };
