'use strict';
/* ================================================================
   main.js — shared app state & boot glue
   Declares the $ helper, the layer registry, and instantiates the
   HLR worker (from the inline worker-code script block in index.html,
   since file:// pages can't load a worker from a separate .js file).
   Load this file FIRST — every other file assumes $, LAYERS, DASH_RATIOS/scaledDash
   and 'worker' already exist as globals.
   ================================================================ */
const $ = id => document.getElementById(id);

/* ================= layer registry =================
   Order here is the drawing-priority hierarchy (top = highest), used for:
     - UI row order, top to bottom
     - cross-layer ink-avoidance (a lower layer never re-strokes what an
       enabled higher layer already covers — see the cascade in generate())
     - paint order in the SVG: the result-building loop walks this list in
       REVERSE so the highest-priority layer (Silhouette) ends up painted
       last/on top, and the lowest (Deep shadow) painted first/underneath.
   solve:true → checkbox re-runs the pipeline. Every layer needs this now:
   toggling any one can change which ink survives in every layer BELOW it in
   the hierarchy, so a pure display-only toggle (the old solve:false shortcut
   for the hidden sub-layers) would leave lower layers stale until the next
   unrelated regenerate. */
const LAYERS = [
  { key:'so', name:'Silhouette',           on:false, solve:true,  color:'#000000', width:1.2, dash:'solid', host:'edgeLayers'  },
  { key:'iv', name:'Silhouette individual', on:false, solve:true, color:'#14171c', width:0.8, dash:'solid', host:'edgeLayers'  },
  { key:'ih', name:'· hidden',             on:false, solve:true,  color:'#9aa0a8', width:0.2, dash:'D1',    host:'edgeLayers'  },
  { key:'sv', name:'Contour',              on:true,  solve:true,  color:'#14171c', width:0.8, dash:'solid', host:'edgeLayers'  },
  { key:'sh', name:'· hidden',             on:false, solve:true,  color:'#9aa0a8', width:0.2, dash:'D1',    host:'edgeLayers'  },
  { key:'cv', name:'Crease',               on:true,  solve:true,  color:'#14171c', width:0.35, dash:'solid', host:'edgeLayers'  },
  { key:'ch', name:'· hidden',             on:false, solve:true,  color:'#9aa0a8', width:0.2, dash:'D1',    host:'edgeLayers'  },
  { key:'h1', name:'Hatch',               on:true,  solve:true,  color:'#2c5aa8', width:0.2, dash:'solid', host:'hatchLayers' },
  { key:'h2', name:'Crosshatch',          on:true,  solve:true,  color:'#2c5aa8', width:0.2, dash:'solid', host:'hatchLayers' },
  { key:'h3', name:'Deep shadow',         on:false, solve:true,  color:'#2c5aa8', width:0.2, dash:'solid', host:'hatchLayers' },
  { key:'cr', name:'Circles',             on:false, solve:true,  color:'#2c5aa8', width:0.2, dash:'solid', host:'hatchLayers' },
];
// Dash/gap lengths expressed as multiples of the CURRENT stroke width,
// rather than fixed lengths — at a fixed absolute gap, a thick stroke's
// round line-cap eats most of that gap visually, making dashes look nearly
// solid (the exact problem this fixes). Since stroke-width varies by
// context (a small swatch preview icon vs. the actual paper content vs. a
// scaled Layout block all compute their own effective width), each caller
// computes its own dasharray via scaledDash(key, widthInThatContext) using
// whatever width value is actually correct there, rather than one shared
// pre-baked string.
const DASH_RATIOS = { solid: null, D1: [3.5, 2.5, 0, 0, 0, 0], D2: [0.5, 2.5, 0, 0, 0, 0] };
// DASH_KEYS is the growable, ordered list of active dash slots — 'solid'
// is implicit and always offered first in any dropdown, so it's not part
// of this list. New slots are only ever appended (D3, D4, ... up to
// MAX_DASH_SLOTS) via the "+ Add dash style" button — see addDashSlot in
// svg-export.js — never removed, so nothing downstream needs to handle a
// slot disappearing out from under a layer/scene that's already using it.
const DASH_KEYS = ['D1', 'D2'];
const MAX_DASH_SLOTS = 9;
// Trims trailing (dash,gap) pairs that are both zero — a user who only
// fills in the first pair and leaves the rest at 0 gets a plain 2-value
// dasharray, not "3.5 2.5 0 0 0 0" (zero-length segments render oddly in
// most SVG engines). Always keeps at least the first pair.
function trimTrailingZeroPairs(arr){
  let end = arr.length;
  while (end >= 4 && arr[end-1] === 0 && arr[end-2] === 0) end -= 2;
  return arr.slice(0, end);
}
function scaledDash(key, widthPx){
  const r = DASH_RATIOS[key];
  if (!r) return '';
  const trimmed = trimTrailingZeroPairs(r);
  if (trimmed[0] <= 0) return '';   // first dash itself is 0 — nothing to draw a pattern with, treat as solid
  const w = Math.max(1e-6, widthPx);
  return trimmed.map(v => (v*w).toFixed(3)).join(' ');
}

/* ================= per-layer texture settings =================
   Builds the 4 per-layer texture-settings tabs (H1/H2/H3/Circles) by
   cloning the General texture settings structure and relabeling every
   id/for attribute with a layer suffix — far lower-risk than hand-
   duplicating ~150 lines of markup 4 times, since it reuses the exact,
   already-correct DOM structure rather than a second hand-maintained
   copy that could drift out of sync. Circles' clone additionally drops
   Angle jitter and Regular wobble entirely (tagged with
   data-skipforcircles in the source markup), since neither applies to a
   circle. */
(function buildPerLayerTextureTabs(){
  const generalWrap = document.getElementById('texGeneralSettings');
  const layerKeys = ['h1', 'h2', 'h3', 'cr'];
  for (const key of layerKeys){
    const clone = generalWrap.cloneNode(true);
    clone.id = 'texLayerSettings_' + key;
    clone.style.display = 'none';
    clone.querySelectorAll('[id]').forEach(el => { el.id = el.id + '_' + key; });
    clone.querySelectorAll('[for]').forEach(el => { el.setAttribute('for', el.getAttribute('for') + '_' + key); });
    if (key === 'cr'){
      clone.querySelectorAll('[data-skipforcircles]').forEach(g => g.remove());
    }
    generalWrap.parentElement.appendChild(clone);
  }
})();

/* ================= worker ================= */
const workerSrc = document.getElementById('worker-code').textContent;
const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type:'text/javascript' })));
