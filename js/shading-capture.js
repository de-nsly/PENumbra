/* ================================================================
   shading-capture.js — the WebGL shading buffer
   The one solver input that can only come from the GPU: the model
   rendered once more into an offscreen float target, read back as
   pixels. doGenerate() sends it to the worker whenever Smooth shading is
   on, and Hatch/Circles density then comes from sampling it
   (sampleShading, js/worker/geom-utils.js) instead of from the per-face
   brightness Flat shading uses.
   Renders with the SAME renderer, scene and camera the live viewport
   uses (viewport3d.js), so the buffer's projection matches
   buildCamMessage()'s by construction. tools/harness cannot run any of
   this — it is the one path with no headless equivalent.
   ================================================================ */
import { $ } from './main.js';
import { camera, gridHelper, modelMesh, renderer, scene, vp } from './viewport3d.js';
/* ================= shading-buffer capture =================
   Renders the model once more into an offscreen float target with a
   material that outputs only max(0,N·L)·shadowFactor (R channel) plus a
   geometry mask (G channel), and reads the pixels back. doGenerate()
   sends this buffer to the worker whenever Smooth shading is on: Hatch
   and Circles density on the model surface are driven by sampling it
   (sampleShading, js/worker/geom-utils.js) rather than by the per-face
   brightness Flat shading uses.

   Reuses the SAME `camera` object the live viewport renders with, so the
   buffer's projection matches buildCamMessage()'s by construction.
   The scene's AmbientLight is deliberately excluded — it would bake a flat
   baseline into every pixel, deep shadow included. makeShadingMaterialFrom
   clones each mesh's own material (so shadows compile exactly as in the
   live view) and overrides only the final colour output via
   onBeforeCompile, calling Three's own getShadow() for PCF sampling.

   Console diagnostics for this pipeline (round-trip test, benchmark,
   overlay preview) live in js/debug/shading-diagnostics.js, loaded with
   ?debug in the URL. */
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
export function captureShadingBuffer(){
  if (!modelMesh){ console.warn('[shadingCapture] no model loaded'); return null; }
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
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(prevTarget);
  for (const [o, mat] of swapped) o.material = mat;   // restore originals
  scene.background = prevBackground;
  if (gridHelper) gridHelper.visible = prevGridVisible;
  if (!shadingMaterialVerified){
    console.warn('[shadingCapture] proceeding despite the shader-injection check above failing — treat this buffer as unverified.');
  }
  const pixels = new Float32Array(w*h*4);
  renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);
  return { pixels, w, h };
}
