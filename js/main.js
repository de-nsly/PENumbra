'use strict';
/* ================================================================
   main.js — shared app state & boot glue
   Declares the $ helper, APP_VERSION, the layer registry (LAYERS), the
   pen library (PEN_LIBRARY/penById), the dash patterns
   (DASH_RATIOS/DASH_KEYS/scaledDash), two small shared widgets
   (segmented-toggle pill positioning, middle-button double-click), the
   per-layer texture-tab cloning, and instantiates the HLR worker as a
   module worker from js/worker/solver.js.
   Load this file FIRST — every other file assumes these globals exist.
   ================================================================ */
const $ = id => document.getElementById(id);

// App version (shown in the About dialog footer). Bump on release.
const APP_VERSION = '0.8.6';

/* ================= layer registry =================
   Order here is the drawing-priority hierarchy (top = highest), used for:
     - UI row order, top to bottom
     - cross-layer ink-avoidance (a lower layer never re-strokes what an
       enabled higher layer already covers — see the cascade in generate())
     - paint order in the SVG: the result-building loop walks this list in
       REVERSE so the highest-priority layer (Silhouette) ends up painted
       last/on top, and the lowest (Deep shadow) painted first/underneath.
   Toggling any layer's checkbox re-runs the whole pipeline: the cascade
   means one layer's on/off changes which ink survives in every layer below
   it, so there is no display-only toggle.
   host → which container in index.html the row is appended to. The edge
   layers are split across three hosts so each group's own solve settings can
   sit in the panel directly under the rows they affect: Contour Cleanup + Max hops between the Contour
   rows and the Crease rows, Crease angle after the Crease rows. Order within
   this list still decides row order inside each host, and the hosts appear in
   index.html in the same order as here.
   pen → the DEFAULT pen id (see PEN_LIBRARY below) the row starts on. A
   layer has no colour/width of its own any more, only a pen reference. */
const LAYERS = [
  { key:'so', name:'Silhouette',            on:false, pen:'p1', dash:'solid', host:'edgeLayersSil'  },
  { key:'iv', name:'Silhouette individual', on:false, pen:'p2', dash:'solid', host:'edgeLayersSil'  },
  { key:'ih', name:'· hidden',              on:false, pen:'p4', dash:'D1',    host:'edgeLayersSil'  },
  { key:'sv', name:'Contour',               on:true,  pen:'p2', dash:'solid', host:'edgeLayersContour' },
  { key:'sh', name:'· hidden',              on:false, pen:'p4', dash:'D1',    host:'edgeLayersContour' },
  { key:'cv', name:'Crease',                on:true,  pen:'p3', dash:'solid', host:'edgeLayersCrease' },
  { key:'ch', name:'· hidden',              on:false, pen:'p4', dash:'D1',    host:'edgeLayersCrease' },
  { key:'h1', name:'Hatch',                 on:true,  pen:'p5', dash:'solid', host:'hatchLayers' },
  { key:'h2', name:'Crosshatch',            on:true,  pen:'p5', dash:'solid', host:'hatchLayers' },
  { key:'h3', name:'Deep shadow',           on:false, pen:'p5', dash:'solid', host:'hatchLayers' },
  { key:'cr', name:'Circles',               on:false, pen:'p5', dash:'solid', host:'hatchLayers' },
];

/* ================= pen library =================
   Every stroke's colour and width come from a pen here — edge/fill layers
   (LAYERS above) and a Layout block's Override menu both store only a pen
   id and resolve it through penById on every render, so editing a pen
   restyles everything using it. The UI (Pen library tab), add/delete and
   the scene/clipboard matching live in pen-library.js.
   id is a stable key, never reused (penIdCounter only climbs) and separate
   from name, so renaming never breaks a reference; names needn't be unique.
   width is a true mm value, same units as the dash lengths below.
   The library belongs to the scene: a .pen import replaces it wholesale.
   "Built-in" pens are only this starting set — once created they're
   ordinary pens (editable, deletable). They mirror the per-layer colour/
   width defaults the layers had before pens existed, so a fresh session
   and a migrated old scene render exactly as they did.
   NAMING: "pen" also means the .pen scene file and the Lines tab's own
   penTab/penModeBtn/data-mode="pen" ids — library code uses the penLib
   prefix and PEN_LIBRARY to stay distinguishable from both. */
function defaultPens(){
  return [
    { id:'p1', name:'Black 1.2', color:'#000000', width:1.2  },
    { id:'p2', name:'Ink 0.8',   color:'#14171c', width:0.8  },
    { id:'p3', name:'Ink 0.35',  color:'#14171c', width:0.35 },
    { id:'p4', name:'Grey 0.2',  color:'#9aa0a8', width:0.2  },
    { id:'p5', name:'Blue 0.2',  color:'#2c5aa8', width:0.2  },
  ];
}
const PEN_LIBRARY = defaultPens();   // mutated in place (like DASH_KEYS), never reassigned
let penIdCounter = PEN_LIBRARY.length;
// Never returns undefined: an unknown id (shouldn't happen — every delete/
// import path reassigns references first) falls back to the first pen so a
// render can't throw mid-way. The library always holds at least one pen.
function penById(id){
  return PEN_LIBRARY.find(p => p.id === id) || PEN_LIBRARY[0];
}
// Dash/gap lengths are true mm values (same units as a pen's width),
// independent of whatever layer/pen width happens to be using
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
// The pattern a dash slot actually draws, in mm: its (dash, gap) pairs with
// every pair whose DASH is 0 dropped whole, gap included — a 0 in a dash
// field means "unused slot", never a dot of ink (a zero-length dash would
// otherwise render as a nib-sized dot under round linecaps on screen, and
// the SVG importers the export feeds ignore it anyway). A very short dash
// (0.1mm) is still a real dash. null = solid: 'solid' itself, an unknown
// key, or a pattern with no dash left. The single source of truth for
// scaledDash, dashOnFraction, the dash previews — and, through the
// stroke-dasharray scaledDash writes, the export's dash split.
function dashPattern(key){
  const r = DASH_RATIOS[key];
  if (!r) return null;
  const out = [];
  for (let i = 0; i + 1 < r.length; i += 2){
    if (r[i] > 0) out.push(r[i], r[i+1]);
  }
  return out.length ? out : null;
}
// pxPerMm: how many of this context's local units correspond to 1mm — the
// SAME factor that context divided a mm width by to get its own local-unit
// stroke-width (i.e. pass 1/scale, never the stroke-width itself).
function scaledDash(key, pxPerMm){
  const p = dashPattern(key);
  if (!p) return '';
  const w = Math.max(1e-6, pxPerMm);
  return p.map(v => (v*w).toFixed(3)).join(' ');
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
  const t = dashPattern(key);
  if (!t) return 1;                       // solid
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
