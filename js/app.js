/* ================================================================
   app.js — the page's only script (index.html loads it as type="module")
   Every other main-thread module only DECLARES at evaluation time; this
   file runs their init functions, in the order the classic <script> tags
   used to load, then the last one boots the demo scene. Keeping every
   side effect here is what lets tools/harness import the same modules
   headlessly.
   ================================================================ */
import { buildPerLayerTextureTabs, initSegPills, bootWorker } from './main.js';
import { initViewport3d } from './viewport3d.js';
import { initPaperPreview } from './paper-preview.js';
import { initSvgExport } from './svg-export.js';
import { initPanelControls } from './panel-controls.js';
import { initPenLibrary } from './pen-library.js';
import { initLayoutCanvas } from './layout-canvas.js';
import { initSceneIO } from './scene-io.js';

buildPerLayerTextureTabs();
initSegPills();
bootWorker();
initViewport3d();
initPaperPreview();
initSvgExport();
initPanelControls();
initPenLibrary();
initLayoutCanvas();
initSceneIO();
