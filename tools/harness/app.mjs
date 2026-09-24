/* ================================================================
   tools/harness/app.mjs — headless PENumbra, main thread + worker
   Reproduces exactly what the browser app does between "user drops a
   .pen file" and "the worker posts a result", with no DOM and no
   browser:

     importScene()  -> worker 'load'  -> onLoaded()
                    -> applyImportedScene() (camera + settings)
                    -> doGenerate() -> worker 'generate' -> renderResult()

   The worker itself (js/worker/*.js) is the REAL one, imported
   unmodified — `self` is stubbed below before the import so its
   dispatcher installs the same way it does inside a Worker. The
   main-thread side is real too: gatherSettings, buildCamMessage,
   computePaperLayout, the orbit/updateFrustum camera construction,
   setProjMode and updateModelRotation are imported straight from
   js/*.js (see app-env.mjs for the browser stand-in that makes that
   possible), so cam.view/cam.proj and the settings object are the
   browser's own, which matters for a scene whose whole problem is
   exactly-coincident geometry.

   The one thing that genuinely can't be reproduced headlessly is the
   WebGL shading-buffer readback (captureShadingBuffer). It only feeds
   Hatch/Circles density, so generate() gets shadingBuffer:null — the
   same thing the app sends with Smooth shading off. Line layers
   (Silhouette/Contour/Crease) are unaffected.
   ================================================================ */
import { THREE, getEl, setControl } from './app-env.mjs';   // first: installs the globals the app modules need
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { defaultLayers, replaceLayers, sceneLayers } from '../../js/layers.js';
import { computePaperLayout, getMargins } from '../../js/paper-layout.js';
import { lightVec, orbit, updateFrustum, setProjMode, updateModelRotation, perspCam, orthoCam } from '../../js/viewport/viewport3d.js';
import { gatherSettings, buildCamMessage, setLastResult } from '../../js/panel-controls.js';

/* The app's own viewport is whatever size the user's browser window
   happened to give it, and a .pen file doesn't record it — but the solver
   works in viewport pixels, so it has to be stated. This default was
   recovered from the invertPageBounds recorded in the browser exports the
   harness was verified against; override with --vp WxH. */
export const DEFAULT_VIEWPORT = { w: 798, h: 947 };

/* Shared-worker bookkeeping — see boot() below. One entry per worker
   directory: the real js/worker by default, or a patched copy passed as
   openScene(pen, { workerDir }) to prototype a worker change without editing
   the app. Each directory is its own module graph, so each has its own mesh
   state and its own resident-mesh owner. */
const workers = new Map();   // entry-module URL -> { dispatch, meshOwner }
let activeApp = null;        // whose post() is in flight (routes replies back)
/* The app modules hold ONE set of controls, one orbit and one camera (as the
   browser does). Several HarnessApps can live in one process — a second
   scene to compare against — so each pushes its own state into the modules
   before it solves; see _activate. */
let stateOwner = null;

export class HarnessApp {
  constructor(){
    this.controls = new Map();  // id -> value, as the .pen's settings block holds them
    this.layerList = defaultLayers();   // this app's layer instances (js/layers.js shape)
    this.vp = { w: DEFAULT_VIEWPORT.w, h: DEFAULT_VIEWPORT.h };
    this.projMode = 'persp';
    this.orbitState = null;     // the .pen camera block, re-applied when this app takes the modules over
    this.messages = [];         // everything the worker has posted back
    this.errors = [];           // 'error' posts (see _onWorkerMessage)
    this.lastResult = null;        // the app's `lastResult` — the last 'result'
    this.loaded = null;         // the 'loaded' reply (center/radius/stats)
    this.modelRadius = 1;
    this.perspCam = perspCam;
    this.orthoCam = orthoCam;
    this.orbit = orbit;         // the app's own orbit object — set theta/phi/... then orbit.apply(), as the app does
  }

  /* ---- $(id) ---- */
  $(id){ return getEl(id); }
  setControl(id, val){ this.controls.set(id, val); setControl(id, val); }

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
  async boot(workerDir){
    const entry = workerDir
      ? pathToFileURL(path.join(path.resolve(workerDir), 'solver.js')).href
      : new URL('../../js/worker/solver.js', import.meta.url).href;
    let w = workers.get(entry);
    if (!w){
      if (!globalThis.self || !globalThis.self.postMessage){
        globalThis.self = {
          postMessage(msg){
            if (!activeApp) return;
            activeApp.messages.push(msg);
            activeApp._onWorkerMessage(msg);
          },
          onmessage: null,
        };
      }
      globalThis.self.onmessage = null;
      await import(entry);
      if (typeof globalThis.self.onmessage !== 'function')
        throw new Error('worker did not install its onmessage dispatcher: ' + entry);
      w = { dispatch: globalThis.self.onmessage, meshOwner: null };
      workers.set(entry, w);
    }
    this.worker = w;
    this.post = m => { activeApp = this; w.dispatch({ data: m }); };
  }
  // Re-loads this app's model into the shared worker if another app's is
  // currently resident. No-op in the common single-scene case.
  _ensureMesh(){
    if (this.worker.meshOwner === this) return;
    if (!this._loadMsg) throw new Error('no model loaded — call loadScene() first');
    this.post(this._loadMsg());
  }
  /* Pushes this app's controls, layer instances and viewport size into the
     app modules. Cheap and idempotent, so it runs before every read of
     module state. The camera (orbit, projection, model rotation) is only
     re-applied when a DIFFERENT app used the modules last: a caller that
     changed app.orbit for a view (sweep.mjs) must keep that view. */
  _activate(){
    for (const [id, val] of this.controls) setControl(id, val);
    replaceLayers(this.layerList);
    const vpEl = getEl('viewport3d');
    vpEl.clientWidth = this.vp.w; vpEl.clientHeight = this.vp.h;
    if (stateOwner !== this){
      stateOwner = this;
      setProjMode(this.projMode);
      if (this.orbitState) this._applyCamera(this.orbitState);
      updateModelRotation();
    }
  }

  _onWorkerMessage(m){
    if (m.type === 'loaded') this._onLoaded(m);
    else if (m.type === 'result') this.lastResult = m;
    // 'error' is not necessarily fatal in the worker — generate() posts one
    // and keeps going for the missing shading buffer (see the header note),
    // so these are collected and surfaced, not thrown. A generate that truly
    // failed produces no 'result' at all, which generate() below catches.
    else if (m.type === 'error') this.errors.push(m.msg);
  }
  // viewport3d.js onLoaded(), minus everything that only exists to draw
  _onLoaded(m){
    this.loaded = m;
    this.worker.meshOwner = this;
    this.modelCenter = new THREE.Vector3(m.center[0], m.center[1], m.center[2]);
    this.modelRadius = m.radius;
    perspCam.near = orthoCam.near = Math.max(this.modelRadius * 0.01, 1e-4);
    perspCam.far  = orthoCam.far  = this.modelRadius * 60;
  }

  // The app's computePaperLayout: dims is optional there too, falling back
  // to the last result, which is pushed in fresh on every call.
  computePaperLayout(dims){
    this._activate();
    setLastResult(this.lastResult);
    return computePaperLayout(dims);
  }
  getMargins(){ this._activate(); return getMargins(); }
  lightVec(){ this._activate(); return lightVec(); }
  updateFrustum(){ this._activate(); updateFrustum(); }

  /* Ticking a layer's checkbox. Toggling one layer changes what survives in
     every layer below it (see layers in js/layers.js), so this must be
     followed by a fresh generate(), exactly as in the app. */
  setLayer(key, on){
    const L = this.layerList.find(l => l.id === key);
    if (L) L.on = !!on;
    return this;
  }
  setLayers(spec){ for (const [k, v] of Object.entries(spec)) this.setLayer(k, v); return this; }
  layerOn(key){ const L = this.layerList.find(l => l.id === key); return !!(L && L.on); }
  layerIds(){ return this.layerList.map(L => L.id); }

  // viewport3d.js setProjMode() — the real one; only its solver-visible
  // effect (which camera buildCamMessage reads) matters here.
  setProjMode(mode){
    this.projMode = mode;
    stateOwner = this;
    setProjMode(mode);
  }
  // viewport3d.js updateModelRotation() — the real one (note its Y/Z swap)
  updateModelRotation(){ this._activate(); updateModelRotation(); }
  _applyCamera(cs){
    if (Number.isFinite(cs.theta))  orbit.theta  = cs.theta;
    if (Number.isFinite(cs.phi))    orbit.phi    = cs.phi;
    if (Number.isFinite(cs.radius)) orbit.radius = cs.radius;
    orbit.exactPole = Number.isFinite(cs.exactPole) ? cs.exactPole : 0;
    orbit.twoPoint = !!cs.twoPoint;
    if (Array.isArray(cs.target))orbit.target.set(cs.target[0], cs.target[1], cs.target[2]);
    orbit.apply();
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
    if (!data || !(data.penumbraScene >= 1 && data.penumbraScene <= 2) || !data.model)
      throw new Error('unrecognized scene file: ' + penPath);
    this.scene = data;
    if (opts.viewport){ this.vp.w = opts.viewport.w; this.vp.h = opts.viewport.h; }

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
    for (const [id, val] of Object.entries(data.settings || {})) this.controls.set(id, val);
    // The app's own loader (js/layers.js), minus pen matching: a saved pen
    // id is taken as is (pens don't affect the solve). A version-1 scene
    // that doesn't mention a layer leaves it OFF here (the browser keeps the
    // row's current state instead) — callers tick what they want on.
    this.layerList = sceneLayers(data, (st, def) => typeof st.pen === 'string' ? st.pen : def);
    if (!(data.penumbraScene >= 2)){
      const saved = data.layers || {};
      for (const L of this.layerList) if (!(L.id in saved)) L.on = false;
    }
    const cs = data.camera || {};
    this.projMode = cs.ortho ? 'ortho' : 'persp';
    this.orbitState = cs;
    stateOwner = null;          // force a full push (controls, camera, rotation) on the next _activate
    this._activate();
  }

  /* ---- panel-controls.js doGenerate() ----
     shadingBuffer is null here (no WebGL) — see the header note. */
  generate(overrides){
    this._ensureMesh();
    this._activate();
    const settings = gatherSettings();
    if (overrides) Object.assign(settings, overrides);
    this.lastSettings = settings;
    this.lastCam = buildCamMessage();
    this.lastResult = null;
    this.errors = [];
    this.post({ type: 'generate', cam: this.lastCam, settings, shadingBuffer: null });
    if (!this.lastResult) throw new Error('generate produced no result' +
      (this.errors.length ? ': ' + this.errors.join('; ') : ''));
    return this.lastResult;
  }

  /* ---- the two Contour debug paths the app's Debug panel exposes ---- */
  debugRawContourEdges(){
    this._ensureMesh();
    this._activate();
    this.post({ type: 'debugRawContourEdges', cam: buildCamMessage() });
    return this.messages[this.messages.length-1];
  }
  debugRawEdges(){
    this._ensureMesh();
    this._activate();
    this.post({ type: 'debugRawEdges', cam: buildCamMessage(),
                creaseDeg: +this.$('creaseDeg').value || 0 });
    return this.messages[this.messages.length-1];
  }
}

export async function openScene(penPath, opts = {}){
  const app = new HarnessApp();
  await app.boot(opts.workerDir);
  await app.loadScene(penPath, opts);
  return app;
}
export { THREE };
