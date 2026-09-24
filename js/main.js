/* ================================================================
   main.js — shared app state & boot glue
   Declares the $ helper, APP_VERSION, the pen library
   (PEN_LIBRARY/penById), the dash patterns (DASH_RATIOS/DASH_KEYS/
   scaledDash), two small shared widgets (segmented-toggle pill
   positioning, middle-button double-click), and the HLR worker
   (bootWorker creates it from js/worker/solver.js as a module worker).
   The layer model is layers.js. Imports nothing from the other modules;
   every one of them imports from here.
   ================================================================ */
export const $ = id => document.getElementById(id);
// SVG element factory — the one place the namespace is spelled out.
export const SVG_NS = 'http://www.w3.org/2000/svg';
export function svgEl(tag, attrs){
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}
/* Keyboard shortcuts keep out of the way of whatever the focused element
   does with the same key — but "focused element" is TWO different
   questions, and answering both with one predicate is what once made
   Ctrl+C/V/A dead after so much as clicking a slider:
     * isTextEntryTarget — somewhere text can be typed or selected (a name
       field, a number box). Native Ctrl+A/C/V and Backspace belong to it.
     * isFormControlTarget — the above PLUS sliders, checkboxes, colour
       swatches and <select>, where an ARROW KEY (or a letter, for the H
       panel toggle) adjusts the control. Wider on purpose: a focused slider
       must keep its arrow keys, but it holds no text, so Ctrl+C there is
       still ours to handle.
   `input` with no type attribute defaults to text, hence the || 'text'. */
const TEXT_ENTRY_INPUT_TYPES = new Set(['text','search','url','tel','email','password','number']);
export function isTextEntryTarget(){
  const a = document.activeElement;
  if (!a) return false;
  if (a.isContentEditable || a.tagName === 'TEXTAREA') return true;
  return a.tagName === 'INPUT' && TEXT_ENTRY_INPUT_TYPES.has((a.type || 'text').toLowerCase());
}
export function isFormControlTarget(){
  const a = document.activeElement;
  if (!a) return false;
  return !!a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT';
}
// Hands the browser a file to save (scene export, SVG export, debug dumps).
export function downloadFile(name, text, mime){
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// App version (shown in the About dialog footer). Bump on release.
export const APP_VERSION = '0.9.1';

/* ================= pen library =================
   Every stroke's colour and width come from a pen here — edge/fill layers
   (layers.js) and a Layout block's Override menu both store only a pen
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
   NAMING: "pen" also means the .pen scene file — library code uses the
   penLib prefix and PEN_LIBRARY to stay distinguishable from it. */
export function defaultPens(){
  return [
    { id:'p1', name:'Black 1.2', color:'#000000', width:1.2  },
    { id:'p2', name:'Black 0.8',   color:'#000000', width:0.8  },
    { id:'p3', name:'Black 0.35',  color:'#000000', width:0.35 },
    { id:'p4', name:'Grey 0.2',  color:'#9aa0a8', width:0.2  },
    { id:'p5', name:'Blue 0.2',  color:'#2c5aa8', width:0.2  },
  ];
}
export const PEN_LIBRARY = defaultPens();   // mutated in place (like DASH_KEYS), never reassigned
// Never returns undefined: an unknown id (shouldn't happen — every delete/
// import path reassigns references first) falls back to the first pen so a
// render can't throw mid-way. The library always holds at least one pen.
export function penById(id){
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
export const DASH_RATIOS = { solid: null, D1: [3.5, 2.5, 0, 0, 0, 0], D2: [0.5, 2.5, 0, 0, 0, 0] };
// DASH_KEYS is the growable, ordered list of active dash slots — 'solid'
// is implicit and always offered first in any dropdown, so it's not part
// of this list. New slots are only ever appended (D3, D4, ... up to
// MAX_DASH_SLOTS) via the "+ Add dash style" button — see addDashSlot in
// layer-rows.js — never removed, so nothing downstream needs to handle a
// slot disappearing out from under a layer/scene that's already using it.
export const DASH_KEYS = ['D1', 'D2'];
export const MAX_DASH_SLOTS = 9;
// The pattern a dash slot actually draws, in mm: its (dash, gap) pairs with
// every pair whose DASH is 0 dropped whole, gap included — a 0 in a dash
// field means "unused slot", never a dot of ink (a zero-length dash would
// otherwise render as a nib-sized dot under round linecaps on screen, and
// the SVG importers the export feeds ignore it anyway). A very short dash
// (0.1mm) is still a real dash. null = solid: 'solid' itself, an unknown
// key, or a pattern with no dash left. The single source of truth for
// scaledDash, dashOnFraction, the dash previews — and, through the
// stroke-dasharray scaledDash writes, the export's dash split.
export function dashPattern(key){
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
export function scaledDash(key, pxPerMm){
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
export function dashOnFraction(key){
  const t = dashPattern(key);
  if (!t) return 1;                       // solid
  let on = 0, total = 0;
  for (let i = 0; i < t.length; i += 2){ on += t[i]; total += t[i] + t[i+1]; }
  return total > 1e-9 ? on / total : 1;
}

/* ================= segmented-toggle sliding pill =================
   Shared by every .modeToggle (panel Pen/Texture/Page/Cog, Texture sub-tab
   rows) and .projRow (Perspective/Ortho, layout-overlay Behind/In front).
   The accent fill is a single ::before pill (see styles.css); this positions
   it over the active child. Callers that flip which child has .active also
   call positionSegPill() so the move animates immediately; the ResizeObserver
   below covers layout changes and rows that were hidden when first measured. */
export function positionSegPill(el){
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
export function initSegPills(){
  const bars = document.querySelectorAll('.modeToggle, .projRow');
  bars.forEach(el => {
    positionSegPill(el);
    new ResizeObserver(() => positionSegPill(el)).observe(el);
  });
  addEventListener('load', () => bars.forEach(positionSegPill));   // re-measure once fonts settle
}

/* ================= middle-button double-click =================
   Fires `handler` when the mouse wheel (middle button) is pressed twice in
   quick succession over `el`. Browsers have no native dblclick for non-primary
   buttons, so two pointerdowns are timed. Registered in the capture phase and,
   on the completing press, stops propagation so the pane's own middle-button
   pan/orbit handler doesn't also kick in; preventDefault kills the browser's
   middle-click autoscroll. Used for "reset the view" in the 3D and 2D panes. */
export function onMiddleDblClick(el, handler){
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

/* ================= worker =================
   Created by bootWorker() (called from app.js before any init runs) rather
   than at module evaluation, so this module can also be imported headlessly
   (tools/harness). Every other module reads the live binding. */
export let worker = null;
export function bootWorker(){
  worker = new Worker('js/worker/solver.js', { type: 'module' });
}
