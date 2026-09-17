/* ================================================================
   layout-list.js — the Layout tab's panels
   The block list (one row per block, newest on top — the reverse of the
   blocks array, which is paint order), its drag-reorder, the per-block
   right-click menu for layer visibility and pen overrides, and the
   floating buttons around the canvas: Add to layout, Duplicate, Delete
   all, and the Preview-tab overlay's own toggles (whose state lives
   here, since these buttons are what change it).
   A row is a view of its block: the block list and the canvas share one
   selection (layout-interaction.js), so clicking either updates both.
   ================================================================ */
import { $, positionSegPill } from './main.js';
import { layerName, layers } from './layers.js';
import { refreshStatusR } from './render-result.js';
import { dashOptionsHtml, fillPenSelect } from './layer-rows.js';
import { activeTab, makeNameEditable } from './panel-controls.js';
import { saveCurrentView } from './viewport3d.js';
import { blocks, deleteBlocks, duplicateBlocks, freezeCurrentGeneration, removeBlockDom, renderPreviewLayoutOverlay, screenToCanvasMm, setBlocks, syncDuplicateBlockBtn, updateBlockStyle, updateBlockTransform } from './layout-canvas.js';
import { LAYOUT_UI_CHROME_SELECTOR, blockForRow, clearSelection, extendSelectionTo, hitTestBlockBody, multiSelectKey, refreshInteractiveSelection, refreshSelectionHighlight, rowActionScope, selectOnly, selectedBlocks, toggleSelection } from './layout-interaction.js';
/* ================= per-block layer visibility context menu =================
   Right-clicking a block overrides the browser's default context menu with
   a small list of just that block's OWN layers (only the ones it actually
   has geometry for — layerPaths keys — not every layer instance), each
   toggleable independently. This is where the per-block visibility state
   introduced above actually gets edited after the fact.
   The "Override" checkbox at the bottom (static — see index.html, not
   rebuilt every time this function runs, so its own listener stays a
   single, permanent one rather than accumulating a fresh copy on every
   rebuild) switches the WHOLE block between reading pen/dash live from the
   panel (today's default, unchanged) and reading its own independent
   per-layer pen/dash choice instead — editable right here, inline, once
   Override is checked. Those per-layer values (block.overrideStyle) are
   populated lazily, one layer at a time, the first time that layer is shown
   with Override on for this block — not all at once, and not re-snapshotted
   on every subsequent toggle — and then persist even if Override gets
   switched off again, so re-checking it later restores what was last set. */
export let contextMenuBlock = null;
let contextMenuPos = { x: 0, y: 0 };
function openLayerContextMenu(block, clientX, clientY){
  contextMenuBlock = block;
  contextMenuPos = { x: clientX, y: clientY };
  $('layerContextOverrideChk').checked = !!block.override;
  $('layerContextMenu').classList.toggle('overrideActive', !!block.override);
  const list = $('layerContextMenuList');
  list.innerHTML = '';
  for (const L of layers){
    if (!(L.id in block.layerPaths)) continue;
    const row = document.createElement('div');
    row.className = 'savedView';
    const name = layerName(L);
    let html =
      '<span class="svName">' + name + '</span>' +
      '<button type="button" class="svBtn svEye" title="Toggle visibility" aria-label="Toggle ' + name + ' visibility">' +
        (block.layerVisible[L.id] ? '&#9673;' : '&#9675;') + '</button>';
    if (block.override){
      if (!block.overrideStyle[L.id]){
        block.overrideStyle[L.id] = { pen: L.pen, dash: L.dash };
      }
      html +=
        // Empty spacer — occupies the extra grid column between the eye
        // toggle and these settings (see .overrideActive CSS), visually
        // separating "visibility" from "the rest of the per-layer style".
        '<span class="ctxSpacer" aria-hidden="true"></span>' +
        // Options filled below via fillPenSelect (pen names are user text).
        '<select class="penSelect" aria-label="' + name + ' override pen"></select>' +
        '<select aria-label="' + name + ' override dash">' + dashOptionsHtml() + '</select>';
    }
    // Assigned ONCE, in full, before any listener gets attached below — an
    // earlier version built this with a second row.innerHTML += for the
    // override controls, which re-serializes and re-parses the WHOLE row
    // (including the eye button set up in the first assignment), silently
    // destroying that original element and its listener along with it.
    // That was exactly why the eye toggle stopped responding whenever
    // Override was on.
    row.innerHTML = html;
    row.querySelector('.svEye').addEventListener('click', () => {
      block.layerVisible[L.id] = !block.layerVisible[L.id];
      updateBlockStyle(block);
      refreshStatusR();
      openLayerContextMenu(block, clientX, clientY);   // cheap full rebuild — refreshes the toggled icon
    });
    if (block.override){
      const st = block.overrideStyle[L.id];
      const penSelect = row.children[3], dashSelect = row.children[4];
      fillPenSelect(penSelect, st.pen);
      dashSelect.value = st.dash;
      penSelect.addEventListener('change', () => { st.pen = penSelect.value; updateBlockStyle(block); });
      dashSelect.addEventListener('change', () => { st.dash = dashSelect.value; updateBlockStyle(block); refreshStatusR(); });
    }
    list.appendChild(row);
  }
  const menu = $('layerContextMenu');
  menu.style.display = 'block';
  // Clamp on-screen so the menu never renders partly off the viewport edge
  const menuRect = menu.getBoundingClientRect();
  const x = Math.min(clientX, window.innerWidth - menuRect.width - 8);
  const y = Math.min(clientY, window.innerHeight - menuRect.height - 8);
  menu.style.left = Math.max(8, x) + 'px';
  menu.style.top = Math.max(8, y) + 'px';
}
export function closeLayerContextMenu(){
  contextMenuBlock = null;
  $('layerContextMenu').style.display = 'none';
}
/* ================= block list UI ================= */
/* ================= block list drag-reorder =================
   Dedicated grip handle (not the whole row) starts a drag — the row
   already has several other click targets (select, eye, lock, delete,
   double-click-to-rename), so a whole-row drag would create ambiguity
   with those. Tracked with plain pointer events (matching how block move/
   rotate/scale on the canvas itself already work in this file) rather
   than native HTML5 drag-and-drop, which isn't used anywhere else here
   and tends to fight custom insertion-line feedback like this.
   The dragged rows stay in place, dimmed, while an insertion line shows
   where they would land among the rows NOT being dragged; the actual
   reorder only happens on drop. Reordering is done entirely in "visual"
   (displayed) order — a reversed copy of blocks[] — then reversed back once
   at the end, rather than computing array-index arithmetic under the
   reversal, which is easy to get off-by-one on.
   Grabbing the handle of a row that's part of the selection drags the WHOLE
   selection, and one outside it drags just that row — the same rowActionScope
   rule the eye/lock/delete buttons follow. Dragged blocks land as one
   contiguous run in their existing relative order, so a group reorder can
   move a stack around without also shuffling it internally. */
let blockDragState = null;
function startBlockDrag(e, block, row){
  e.preventDefault();
  e.stopPropagation();
  const moving = new Set(rowActionScope(block));
  const rows = [...$('blocksList').children].filter(el => el.classList.contains('savedView'));
  // Split once, here: rows never change during a drag (nothing re-renders
  // the list until the drop), so both halves stay valid for the whole
  // gesture — the moving rows to dim, and the rest as the only legal
  // insertion points.
  const movingRows = rows.filter(r => moving.has(blockForRow(r)));
  const others = rows.filter(r => !moving.has(blockForRow(r)));
  const insertLine = document.createElement('div');
  insertLine.className = 'svInsertLine';
  for (const r of movingRows) r.classList.add('svDragging');
  // target stays null until the pointer actually moves, and null legitimately
  // means "drop past the last row" — so `moved` is what separates that from a
  // plain click on the grip, which must not reorder anything at all. Without
  // it a click alone reads as a drop at the bottom.
  blockDragState = { moving, movingRows, others, insertLine, target: null, moved: false };
  e.target.setPointerCapture(e.pointerId);
}

// Whether the Layers panel itself should be on screen at all — both that
// the Layout tab is even active AND that there's at least one block to
// show. Distinct from the empty-list case Saved Views still handles with
// its own centered "nothing yet" state (.svEmpty in styles.css) — here the
// panel (list, Duplicate/Delete All buttons, everything) is hidden outright
// once the last block is removed, rather than left on screen empty.
export function syncBlocksFloatVisibility(){
  const show = activeTab === 'layout' && blocks.length > 0;
  $('blocksFloat').style.display = show ? '' : 'none';
  // Drives the 2D reset button out from under the panel — see #reset2dBtn in
  // styles.css. A class rather than a style so the two positions stay
  // described in one place, in CSS.
  document.body.classList.toggle('blocksPanelOpen', show);
}
export function renderBlocksList(){
  const list = $('blocksList');
  list.innerHTML = '';
  syncBlocksFloatVisibility();
  syncDuplicateBlockBtn();
  // Displayed top-to-bottom in front-to-back order (top of list = drawn on
  // top, matching the common layers-panel convention) — the reverse of
  // blocks[]'s own storage order (index 0 = drawn first/underneath,
  // matching how new blocks are appended to the END of both the array and
  // the DOM). Reversed only for this display — blocks[] itself, and every
  // other place that iterates it, is untouched.
  for (const block of blocks.slice().reverse()){
    const row = document.createElement('div');
    row.className = 'savedView' + (block.visible ? '' : ' svRowHidden') +
      (selectedBlocks.has(block) ? ' svRowSelected' : '');
    row.dataset.blockId = block.id;
    row.innerHTML =
      '<span class="svDragHandle" title="Drag to reorder" aria-label="Drag to reorder ' + block.name + '">' +
        '<svg viewBox="0 0 10 16" width="8" height="14" fill="currentColor">' +
          '<circle cx="2" cy="2" r="1.3"/><circle cx="8" cy="2" r="1.3"/>' +
          '<circle cx="2" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/>' +
          '<circle cx="2" cy="14" r="1.3"/><circle cx="8" cy="14" r="1.3"/>' +
        '</svg>' +
      '</span>' +
      '<span class="svName">' + block.name + '</span>' +
      // title/aria-label for these three are set by applyRowBtnLabels (via
      // the refreshSelectionHighlight call at the end of this function), not
      // here — they depend on the current selection, which can change
      // without the list being rebuilt.
      '<button type="button" class="svBtn svEye">' +
        (block.visible ? '&#9673;' : '&#9675;') + '</button>' +
      '<button type="button" class="svBtn svLock' + (block.locked ? ' svLockActive' : '') + '">' +
        (block.locked
          ? '<svg viewBox="0 0 134 134" width="13" height="13" fill="currentColor"><g transform="matrix(1.091075,0,0,1.179063,-6.236398,-17.854001)"><path d="M96.925,58.247C103.393,59.463 108.267,64.76 108.267,71.102L108.267,99.68C108.267,106.92 101.915,112.797 94.092,112.797L39.543,112.797C31.72,112.797 25.368,106.92 25.368,99.68L25.368,71.102C25.368,64.76 30.242,59.463 36.71,58.247L36.71,47.771C36.71,38.278 45.038,30.572 55.296,30.572L78.339,30.572C88.597,30.572 96.925,38.278 96.925,47.771L96.925,58.247ZM50.839,57.984L82.796,57.984L82.796,47.771C82.796,45.494 80.799,43.646 78.339,43.646L55.296,43.646C52.836,43.646 50.839,45.494 50.839,47.771L50.839,57.984Z"/></g></svg>'
          : '<svg viewBox="0 0 134 134" width="13" height="13" fill="currentColor"><g transform="matrix(1.091075,0,0,1.179063,-6.236398,-11.738486)"><path d="M96.925,58.247C103.393,59.463 108.267,64.76 108.267,71.102L108.267,99.68C108.267,106.92 101.915,112.797 94.092,112.797L39.543,112.797C31.72,112.797 25.368,106.92 25.368,99.68L25.368,71.102C25.368,63.862 31.72,57.984 39.543,57.984L82.796,57.984L82.796,37.397C82.796,35.121 80.799,33.273 78.339,33.273L55.296,33.273C52.836,33.273 50.839,35.121 50.839,37.397L50.839,49.019L36.71,49.019L36.71,37.397C36.71,27.905 45.038,20.198 55.296,20.198L78.339,20.198C88.597,20.198 96.925,27.905 96.925,37.397L96.925,58.247Z"/></g></svg>'
        ) + '</button>' +
      '<button type="button" class="svBtn svDelete">&#10005;</button>';
    row.querySelector('.svDragHandle').addEventListener('pointerdown', e => startBlockDrag(e, block, row));
    // Shift+click is also the browser's native "extend text selection"
    // gesture — without this, shift-selecting rows in quick succession
    // also highlights the row's own text (name/buttons) as a side effect.
    // preventDefault on mousedown (before any selection is even started)
    // is the standard fix; excludes the same interactive sub-elements the
    // click handler below already excludes, so button presses and the
    // drag handle keep their own normal behavior.
    row.addEventListener('mousedown', e => {
      if ((e.shiftKey || multiSelectKey(e)) && !e.target.closest('button') && !e.target.closest('.svDragHandle')) e.preventDefault();
    });
    row.addEventListener('click', e => {
      if (e.target.closest('button') || e.target.closest('.svDragHandle')) return;   // Eye/Lock/Delete/drag clicks bubble here too — don't also select
      // Every row is selectable here, hidden and locked ones included —
      // that's how a batch of them can be un-hidden/unlocked/deleted in one
      // action. They just stay inert on the canvas (see interactiveSelection).
      // Windows Explorer's rules, in its own precedence order: Shift extends
      // a range from the anchor (unioned with the existing selection when
      // Ctrl/Cmd is also held), Ctrl/Cmd alone toggles one row, a plain
      // click replaces. Deliberately NOT the canvas's deferred collapse-on-
      // drag refinement, since a list row click can't "drag the whole group"
      // the way grabbing a canvas block can.
      if (e.shiftKey) extendSelectionTo(block, multiSelectKey(e));
      else if (multiSelectKey(e)) toggleSelection(block);
      else selectOnly(block);
    });
    makeNameEditable(row.querySelector('.svName'), () => block.name, newName => {
      block.name = newName;
      renderBlocksList();
    });
    // All three row buttons act on the whole selection when this row is part
    // of it, and on this row alone otherwise (see rowActionScope) — the
    // button's own title/aria-label says which, refreshed on every selection
    // change by applyRowBtnLabels.
    row.querySelector('.svEye').addEventListener('click', () => {
      // The clicked row's OWN new state becomes the whole scope's state, no
      // matter what each block was before — one click leaves a mixed
      // selection uniform, rather than flipping each block independently and
      // just re-scrambling it.
      const visible = !block.visible;
      for (const b of rowActionScope(block)){
        b.visible = visible;
        updateBlockTransform(b);
      }
      // The selection itself is untouched — only which of its members are
      // now canvas-interactive changed, so the frame/overlay get reseeded.
      refreshInteractiveSelection();
      refreshStatusR();
      renderBlocksList();
    });
    row.querySelector('.svLock').addEventListener('click', () => {
      const locked = !block.locked;
      for (const b of rowActionScope(block)) b.locked = locked;
      refreshInteractiveSelection();   // same as the eye button — see there
      renderBlocksList();
    });
    row.querySelector('.svDelete').addEventListener('click', () => deleteBlocks(rowActionScope(block)));
    list.appendChild(row);
  }
  // Owns the row buttons' selection-dependent title/aria-label (see
  // applyRowBtnLabels) — the freshly built rows above carry none of their
  // own, so this pass is what gives them one.
  refreshSelectionHighlight();
}

// Off by default — saving a view is an explicit opt-in, not something
// "+ Add to layout" should do as a side effect unless asked.
let addToLayoutSaveView = false;

// Layout overlay — static, non-interactive rendering of every saved block
// on top of (or behind) the live Preview drawing, for live-compositing
// reference. Off by default, session-only (not saved to .pen scenes, same
// as addToLayoutSaveView/blendMultiplyOn above/elsewhere) — see
// renderPreviewLayoutOverlay for the actual drawing logic.
export let layoutOverlayOn = false;
export let layoutOverlayFront = false;   // false = behind (default), true = in front
export let layoutOverlayOpacity = 1;     // 0..1 — the slider below is 0-100
function setLayoutOverlayOrder(front){
  layoutOverlayFront = front;
  $('layoutOverlayOrderBtn').dataset.mode = front ? 'front' : 'back';
  $('layoutOverlayOrderBtn').classList.toggle('active', front);
  $('layoutOverlayOrderBtn').setAttribute('aria-checked', String(front));
  $('layoutOverlayLblBack').classList.toggle('active', !front);
  $('layoutOverlayLblFront').classList.toggle('active', front);
  positionSegPill($('layoutOverlayOrderBtn').parentElement);
  renderPreviewLayoutOverlay();
}

/* Wires the panels. app.js calls this after initLayoutCanvas and before
   initLayoutInteraction, which is the order these listeners were registered
   in when the Layout tab had a single init. */
export function initLayoutList(){
  $('duplicateBlockBtn').addEventListener('click', () => {
    if (selectedBlocks.size) duplicateBlocks([...selectedBlocks]);
  });
  $('layerContextOverrideChk').addEventListener('change', e => {
    if (!contextMenuBlock) return;
    contextMenuBlock.override = e.target.checked;
    updateBlockStyle(contextMenuBlock);
    refreshStatusR();   // switches which dash (live panel vs. this block's own override) governs the ink length
    openLayerContextMenu(contextMenuBlock, contextMenuPos.x, contextMenuPos.y);   // rebuild to show/hide the expanded controls
  });
  $('paperPane').addEventListener('contextmenu', e => {
    if (activeTab !== 'layout') return;
    if (e.target.closest(LAYOUT_UI_CHROME_SELECTOR)) return;
    const [wx, wy] = screenToCanvasMm(e.clientX, e.clientY);
    const hit = hitTestBlockBody(wx, wy);
    if (!hit){ closeLayerContextMenu(); return; }   // let the browser's default menu show over empty canvas
    e.preventDefault();
    // Deliberately does NOT change the current selection — right-click edits
    // whichever block is under the cursor, independent of a broader multi-
    // selection, so you can peek at one layer's overrides without losing it.
    openLayerContextMenu(hit, e.clientX, e.clientY);
  }, { capture: true });
  document.addEventListener('pointerdown', e => {
    if (contextMenuBlock && !$('layerContextMenu').contains(e.target)) closeLayerContextMenu();
  });
  /* Escape closes the menu. Its own listener since the split: it used to be
     the first line of the shortcut handler in layout-interaction.js, and this
     init runs before that one, so it still runs first for a given keypress. */
  document.addEventListener('keydown', e => {
    if (contextMenuBlock && e.key === 'Escape') closeLayerContextMenu();
  });
  ['pointerdown','wheel'].forEach(t => $('layerContextMenu').addEventListener(t, e => e.stopPropagation()));
  document.addEventListener('pointermove', e => {
    if (!blockDragState) return;
    const { others, insertLine } = blockDragState;
    const list = $('blocksList');
    blockDragState.moved = true;
    let target = null;
    for (const r of others){
      const rect = r.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height/2){ target = r; break; }
    }
    blockDragState.target = target;   // null means "after every other row"
    if (!insertLine.parentNode) list.appendChild(insertLine);
    // Positioned via absolute top offset (see .svInsertLine — out of normal
    // flow entirely) rather than DOM insertion order, specifically so it
    // never adds to the list's own content height: inserting it as a real
    // flow element was occasionally enough to tip the list over its
    // max-height and pop the scrollbar open mid-drag.
    const listRect = list.getBoundingClientRect();
    const INSERT_LINE_HEIGHT = 2;   // keep in sync with .svInsertLine's own height in styles.css
    let lineTop;
    if (target) lineTop = target.getBoundingClientRect().top - listRect.top + list.scrollTop;
    else if (others.length){
      // Bottom-of-list case — anchor the line's BOTTOM edge (not top) to the
      // last row's bottom, so the line's own height stays within the
      // existing content bounds instead of extending past it. Anchoring by
      // top here (matching the target case above) would put the line's
      // bottom 2px beyond the true content edge — even fully absolutely-
      // positioned, that still counts toward the list's scrollable overflow,
      // which was popping the scrollbar open specifically in this one case.
      lineTop = others[others.length-1].getBoundingClientRect().bottom - listRect.top + list.scrollTop - INSERT_LINE_HEIGHT;
    }
    else lineTop = 0;
    insertLine.style.top = lineTop + 'px';
  });
  document.addEventListener('pointerup', () => {
    if (!blockDragState) return;
    const { moving, movingRows, others, insertLine, target, moved } = blockDragState;
    insertLine.remove();
    for (const r of movingRows) r.classList.remove('svDragging');
    blockDragState = null;
    if (!moved) return;   // grip clicked but never dragged — see startBlockDrag

    // insertAt indexes into `others` — the rows that AREN'T moving — and
    // `rest` below is that exact same sequence as blocks, so the index carries
    // over directly with no adjustment for how many blocks were lifted out.
    const insertAt = target ? others.indexOf(target) : others.length;

    const visualOrder = blocks.slice().reverse();
    const lifted = visualOrder.filter(b => moving.has(b));
    if (!lifted.length) return;   // every dragged block was deleted mid-drag — nothing to do
    const rest = visualOrder.filter(b => !moving.has(b));
    rest.splice(insertAt, 0, ...lifted);   // `lifted` keeps its own visual order, so the group stays internally stacked as it was
    setBlocks(rest.slice().reverse());

    // Sync actual SVG paint order to match — re-appending an already-present
    // child moves it to the end, so appending every block in the new array
    // order, in sequence, reproduces that order in the DOM.
    const blocksLayer = $('layoutBlocksLayer');
    for (const b of blocks) if (b.dom) blocksLayer.appendChild(b.dom.outer);
    renderBlocksList();
  });
  renderBlocksList();   // sets the panel's initial hidden/shown state — no other call site runs unconditionally at load
  $('addToLayoutSaveViewBtn').addEventListener('click', () => {
    addToLayoutSaveView = !addToLayoutSaveView;
    $('addToLayoutSaveViewBtn').setAttribute('aria-checked', String(addToLayoutSaveView));
    $('addToLayoutSaveViewBtn').classList.toggle('active', addToLayoutSaveView);
  });
  $('addToLayoutBtn').addEventListener('click', () => {
    freezeCurrentGeneration();
    if (addToLayoutSaveView) saveCurrentView();
  });
  $('layoutOverlayBtn').addEventListener('click', () => {
    layoutOverlayOn = !layoutOverlayOn;
    $('layoutOverlayBtn').setAttribute('aria-checked', String(layoutOverlayOn));
    $('layoutOverlayBtn').classList.toggle('active', layoutOverlayOn);
    $('layoutOverlayControls').style.display = layoutOverlayOn ? '' : 'none';
    renderPreviewLayoutOverlay();
  });
  $('layoutOverlayOrderBtn').addEventListener('click', () => setLayoutOverlayOrder(!layoutOverlayFront));
  for (const [id, front] of [['layoutOverlayLblBack', false], ['layoutOverlayLblFront', true]])
    $(id).addEventListener('click', () => setLayoutOverlayOrder(front));
  $('layoutOverlayOpacity').addEventListener('input', () => {
    layoutOverlayOpacity = +$('layoutOverlayOpacity').value / 100;
    $('layoutOverlayOpacityVal').textContent = $('layoutOverlayOpacity').value + '%';
    renderPreviewLayoutOverlay();
  });
  $('clearBlocksBtn').addEventListener('click', () => {
    if (!blocks.length) return;
    if (!confirm('Delete all ' + blocks.length + ' layer(s)? This cannot be undone.')) return;
    for (const b of blocks) removeBlockDom(b);
    setBlocks([]);
    clearSelection();
    closeLayerContextMenu();
    refreshStatusR();
    renderBlocksList();
  });
  ['pointerdown','wheel'].forEach(t => {
    $('blocksFloat').addEventListener(t, e => e.stopPropagation());
    $('paperTabs').addEventListener(t, e => e.stopPropagation());
    $('addToLayoutFloat').addEventListener(t, e => e.stopPropagation());
  });
}
