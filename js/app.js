/* ================================================================
   app.js — the page's only script (index.html loads it as type="module")
   Every other main-thread module only DECLARES at evaluation time; this
   file runs their init functions, in the order the classic <script> tags
   used to load, then the last one boots the demo scene. Keeping every
   side effect here is what lets tools/harness import the same modules
   headlessly.
   ================================================================ */
import { initSegPills, bootWorker } from './main.js';
import { initViewport3d } from './viewport/viewport3d.js';
import { initSavedViews } from './viewport/saved-views.js';
import { initPaperPreview } from './paper-preview.js';
import { initLayerRows } from './layer-rows.js';
import { initPaperLayout } from './paper-layout.js';
import { initExport } from './export.js';
import { initPanelControls } from './panel-controls.js';
import { initTextureStack } from './texture-stack.js';
import { initPenLibrary } from './pen-library.js';
import { initLayoutModel } from './layout/layout-model.js';
import { initLayoutList } from './layout/layout-list.js';
import { initLayoutInteraction } from './layout/layout-interaction.js';
import { initLayoutClipboard } from './layout/layout-clipboard.js';
import { initSceneIO } from './scene-io.js';

initSegPills();
bootWorker();
initViewport3d();
initSavedViews();
initPaperPreview();
initLayerRows();
initPaperLayout();
initExport();
initPanelControls();
initTextureStack();
initPenLibrary();
initLayoutModel();
initLayoutList();
initLayoutInteraction();
initLayoutClipboard();
initSceneIO();
