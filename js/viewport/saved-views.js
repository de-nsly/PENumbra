/* ================================================================
   saved-views.js — the named camera views panel
   A saved view captures the camera (orbit theta/phi/radius/target, FOV,
   perspective/ortho) and the model rotation, so clicking one puts the
   viewport back exactly where it was. The rows are the panel's own DOM,
   rebuilt by renderSavedViews(); the list itself is part of the scene, so
   a .pen import replaces it through setSavedViews().
   Everything it moves lives in viewport3d.js — this only reads the
   camera and calls that module's own appliers.
   ================================================================ */
import { $ } from '../main.js';
import { makeNameEditable, markStale, refreshValLabel } from '../panel-controls.js';
import { camera, orbit, orthoCam, setProjMode, updateLight, updateLightGizmo, updateModelRotation } from './viewport3d.js';
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
   clearActiveView() calls scattered through this file and the regen
   listener in panel-controls.js (entries flagged clearsView in
   settings.js) for the actual hookup. */
export let savedViews = [];
export let savedViewCounter = 0;
// Scene import replaces the whole list (older .pen files have none).
export function setSavedViews(list, counter){ savedViews = list; savedViewCounter = counter; }
let activeViewRef = null;
export function renderSavedViews(){
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
export function saveCurrentView(){
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
export function clearActiveView(){
  if (activeViewRef){ activeViewRef = null; renderSavedViews(); }
}

/* The panel's two wirings. app.js calls this right after initViewport3d,
   which is where these two lines sat when saved views lived in it. */
export function initSavedViews(){
  renderSavedViews();   // sets the initial empty-state class — no other call site runs unconditionally at load
  $('saveViewBtn').addEventListener('click', saveCurrentView);
}
