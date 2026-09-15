/* ================================================================
   tools/harness/app-env.mjs — just enough browser for the app's modules
   The main-thread modules (js/*.js) only DECLARE at import time; every
   DOM-touching side effect lives in their init functions, which the
   harness never calls. What they still need at import time is a `THREE`
   global (viewport3d.js builds its cameras at module scope), a `document`
   whose getElementById() hands back something with .value/.checked, and a
   `window`. This module installs those globals, so it must be imported
   BEFORE any app module — put it first in every harness entry file.

   Elements are one fake object per id, kept for the life of the process:
   the app reads controls through $(id) at call time, so setting a fake
   element's .value/.checked is exactly like the user typing into it, and
   viewport3d.js's `vp` (looked up once at import) stays the same object
   whose clientWidth/clientHeight the harness sets.
   ================================================================ */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const THREE = require(path.join(HERE, 'vendor', 'three.min.js'));
globalThis.THREE = THREE;

function fakeEl(id){
  return {
    id, type: 'text', value: '', checked: false, disabled: false, textContent: '', innerHTML: '',
    clientWidth: 0, clientHeight: 0, offsetLeft: 0, offsetWidth: 0, offsetParent: null, parentElement: null,
    children: [], firstChild: null, dataset: {},
    style: { setProperty(){}, removeProperty(){} },
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    setAttribute(){}, getAttribute(){ return null; }, removeAttribute(){},
    addEventListener(){}, removeEventListener(){}, dispatchEvent(){},
    appendChild(c){ return c; }, insertBefore(c){ return c; }, remove(){},
    querySelector(){ return null; }, querySelectorAll(){ return []; }, closest(){ return null; },
    getBoundingClientRect(){ return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
  };
}
const els = new Map();
export function getEl(id){
  let el = els.get(id);
  if (!el){ el = fakeEl(id); els.set(id, el); }
  return el;
}
/* Sets a control the way the app's scene import does: a boolean makes it a
   checkbox, anything else a text/number field holding the string value. */
export function setControl(id, val){
  const el = getEl(id);
  if (typeof val === 'boolean'){ el.type = 'checkbox'; el.checked = val; }
  else { el.type = 'text'; el.value = String(val); }
  return el;
}

if (!globalThis.document){
  globalThis.document = {
    getElementById: getEl,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => fakeEl(''),
    createElementNS: () => fakeEl(''),
    body: fakeEl('body'),
    documentElement: fakeEl('html'),
    addEventListener(){},
  };
}
if (!globalThis.window) globalThis.window = globalThis;
if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = () => 0;
