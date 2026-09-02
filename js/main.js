'use strict';
/* ================================================================
   main.js — shared app state & boot glue
   Declares the $ helper, the layer registry, and instantiates the
   HLR worker as a module worker from js/worker/solver.js.
   Load this file FIRST — every other file assumes $, LAYERS, DASH_RATIOS/scaledDash
   and 'worker' already exist as globals.
   ================================================================ */
const $ = id => document.getElementById(id);

// App version (shown in the About dialog footer). Bump on release.
const APP_VERSION = '0.8.0';

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
// Dash/gap lengths are true mm values (same units as the layer W[mm]
// field), independent of whatever layer/pen width happens to be using
// them — a 10mm dash is 10mm on the plotted page whether the pen is
// 0.15mm or 1.2mm wide. Since path coordinates live in solver-px space and
// only land at physical size once multiplied through the paper's own
// mm-per-px transform (or a Layout block's mm-per-local-unit one), each
// caller computes its own dasharray via scaledDash(key, pxPerMmInThatContext)
// — the SAME px-per-mm conversion factor it already applies to that
// context's stroke width — rather than one shared pre-baked string. Do NOT
// pass the stroke width itself here; that would make dash length scale
// with pen width instead of being the literal mm value the user typed.
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
// pxPerMm: how many of this context's local units correspond to 1mm — the
// SAME factor that context divided a mm width by to get its own local-unit
// stroke-width (i.e. pass 1/scale, never the stroke-width itself).
function scaledDash(key, pxPerMm){
  const r = DASH_RATIOS[key];
  if (!r) return '';
  const trimmed = trimTrailingZeroPairs(r);
  if (trimmed[0] <= 0) return '';   // first dash itself is 0 — nothing to draw a pattern with, treat as solid
  const w = Math.max(1e-6, pxPerMm);
  return trimmed.map(v => (v*w).toFixed(3)).join(' ');
}
// Fraction of a dashed stroke's length that's actually "ink" (pen-down),
// e.g. D1's 3.5-on/2.5-off pattern is 3.5/6 =~ 0.583. Since DASH_RATIOS
// values are absolute mm (see the comment above scaledDash — deliberately
// NOT scaled by stroke width), this ratio is width-independent: it's a
// straight sum of on-lengths over on+off, with no px/mm conversion needed.
// Used by the stats readout as a length-only approximation of actual pen
// travel, not a literal geometric split like splitDashedPathD does at
// export time.
function dashOnFraction(key){
  const r = DASH_RATIOS[key];
  if (!r) return 1;                       // solid
  const t = trimTrailingZeroPairs(r);
  if (t[0] <= 0) return 1;                // degenerate pattern — scaledDash also treats this as solid
  let on = 0, total = 0;
  for (let i = 0; i < t.length; i += 2){ on += t[i]; total += t[i] + t[i+1]; }
  return total > 1e-9 ? on / total : 1;
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

/* ================= segmented-toggle sliding pill =================
   Shared by every .modeToggle (panel Pen/Texture/Page/Cog, Texture sub-tab
   rows) and .projRow (Perspective/Ortho, layout-overlay Behind/In front).
   The accent fill is a single ::before pill (see styles.css); this positions
   it over the active child. Callers that flip which child has .active also
   call positionSegPill() so the move animates immediately; the ResizeObserver
   below covers layout changes and rows that were hidden when first measured. */
function positionSegPill(el){
  if (!el) return;
  const active = [...el.children].find(c => c.classList.contains('active') && c.offsetParent);
  if (!active) return;                                  // no active child, or row hidden
  el.style.setProperty('--seg-x', active.offsetLeft + 'px');
  el.style.setProperty('--seg-w', active.offsetWidth + 'px');
  if (!el.dataset.segReady){                            // first placement: land without animating
    el.dataset.segReady = '1';
    requestAnimationFrame(() => el.classList.add('seg-anim'));
  }
}
(function initSegPills(){
  const bars = document.querySelectorAll('.modeToggle, .projRow');
  bars.forEach(el => {
    positionSegPill(el);
    new ResizeObserver(() => positionSegPill(el)).observe(el);
  });
  addEventListener('load', () => bars.forEach(positionSegPill));   // re-measure once fonts settle
})();

/* ================= middle-button double-click =================
   Fires `handler` when the mouse wheel (middle button) is pressed twice in
   quick succession over `el`. Browsers have no native dblclick for non-primary
   buttons, so two pointerdowns are timed. Registered in the capture phase and,
   on the completing press, stops propagation so the pane's own middle-button
   pan/orbit handler doesn't also kick in; preventDefault kills the browser's
   middle-click autoscroll. Used for "reset the view" in the 3D and 2D panes. */
function onMiddleDblClick(el, handler){
  let t = 0, x = 0, y = 0;
  el.addEventListener('pointerdown', e => {
    if (e.button !== 1) return;
    e.preventDefault();
    if (e.timeStamp - t < 400 && Math.hypot(e.clientX - x, e.clientY - y) < 6){
      t = 0;
      e.stopImmediatePropagation();
      handler(e);
    } else {
      t = e.timeStamp; x = e.clientX; y = e.clientY;
    }
  }, true);
}

/* ================= worker ================= */
const worker = new Worker('js/worker/solver.js', { type: 'module' });
