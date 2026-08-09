# PENumbra

A browser-based hidden-line-removal studio for pen plotters. Load a 3D model (STL/OBJ), and PENumbra
computes its silhouette, contour, and crease edges, generates hatching for shaded surfaces, and lays the
result out on a paper sheet as plotter-ready SVG.

No install, no build step, no server required — it's a single static page that runs entirely in your
browser.

**Try it live: [de-nsly.github.io/PENumbra](https://de-nsly.github.io/PENumbra/)**

## What it does

- **Hidden-line removal**: computes visible vs. hidden edges (silhouette, contour, crease) from any angle
- **Shading via hatching**: crosshatch, hatch, and stipple/circle fills for shaded faces, with soft-shadow
  sampling
- **Layer control**: toggle and style each edge/fill layer independently, with drawing-priority
  ink-avoidance between layers
- **Paper layout**: position and scale the drawing on a chosen paper size, ready for export
- **SVG export**: clean, plotter-friendly SVG output (merged/chained paths, dashed-line support)
- **Live 3D preview**: orbit, pan, and zoom the source mesh before generating
- **Scene files**: save and reload your model, camera, and all settings as a single `.pen` file

## Getting started

Open `index.html` directly in a browser (`file://` works), or serve the folder with any static file
server. Drag and drop an STL/OBJ file onto the page, or load the built-in demo scene, then hit **Generate**.

## License

MIT — see [LICENSE](LICENSE).
