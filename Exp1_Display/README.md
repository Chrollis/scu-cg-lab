# HW1 - Interactive 2D Drawing with WebGPU

An interactive Sierpinski carpet drawn with WebGPU. Clicking anywhere on the
canvas recentres the shape on the pointer and re-randomises its colours, and
three sliders control the size, the recursion depth and the antialiasing.

## How to run

Double-click `index.html`, or right-click it and choose "Open with" a browser.

No server, no build step, no dependencies. The page is plain HTML, CSS and
JavaScript, and everything it needs is in this folder.

Supported browsers:

| Browser       | Version               |
| ------------- | --------------------- |
| Chrome / Edge | recommended           |
| Safari        | 26 or newer           |
| Firefox       | partial, may not work |

Any browser implementing `navigator.gpu` will work. To check a specific browser,
open the developer console and evaluate `navigator.gpu`: an object means WebGPU
is available, `undefined` means it is not.

If WebGPU is unavailable, the page shows a short explanation in the top-left
corner instead of a blank canvas.

## What it does

Assignment requirements, and where each one lives:

| Requirement                                 | Implementation                                  |
| ------------------------------------------- | ----------------------------------------------- |
| Click anywhere to recentre the shape        | `mousedown` handler in `index.html`             |
| Fill with a random colour                   | Palette phase rerolled per click, `js/scene.js` |
| Interactive fractal (bonus)                 | Sierpinski carpet, `js/wgsl.js`                 |
| Keep the aspect ratio (bonus)               | Orthographic projection, `js/mat4.js`           |
| Implement with another graphics API (bonus) | WebGPU throughout                               |

Interactions:

- **Click** - move the shape to the pointer and rotate the palette.
- **Sliders** - size, recursion depth, and supersampling factor.
- **Resize the window** - the shape holds its on-screen size rather than
  stretching with the viewport.

## How the fractal is drawn

There is no extra geometry. The square stays four vertices at every depth; what
changes is a loop inside the fragment shader.

Each pass reads the local position as a base-3 fraction: `floor(p * 3)` says
which of nine cells the pixel is in, `fract(p * 3)` says where inside that cell
it is and becomes the coordinate for the next pass. The middle cell of any level
is a hole.

Because the shape is not built as geometry, `fwidth` is what tells the shader
how much of the fractal a single pixel covers. That figure drives an N\*N grid of
samples, and the fraction landing outside every hole becomes the output alpha.
A pixel fully inside a hole therefore writes nothing rather than writing the
clear colour, so the holes are genuinely absent and the background shows through
them. The same figure lets partially covered pixels blend, which is what
smooths the edges.

The digits collected along the way also form a base-9 address for the pixel,
and a cosine palette turns that address into a colour. Weights shrink by a
factor of nine each pass, so the first digit decides which of eight broad
regions a pixel falls in and later digits only tint within them; equal weights
would read as speckle rather than structure.

RGB and alpha carry separate information: RGB is the interpolated vertex
gradient, alpha is the fractal coverage. Splitting them across channels is what
lets the gradient and the fractal coexist - as one colour scheme they would
muddy each other.

## How the projection works

A vertex position in clip space is stretched onto the viewport, scaling `x` by
`width/2` pixels per unit and `y` by `height/2`. Those differ when the window is
not square, so a square drawn in clip space comes out rectangular. Dividing the
x axis by the aspect ratio makes both figures equal.

The same matrix carries the on-screen size. Measuring the shape's extent in
device pixels rather than in fractions of the window is what makes it hold a
fixed size as the window resizes, like a UI element. It also means the size
lives in the projection rather than in the vertex data, so the buffer never has
to be rewritten and the shader's local space stays valid.

## Design notes

**The shader does not know what shape it draws.** Vertex data arrives as an
argument (`@location(0)`), so changing the shape means changing a buffer, not a
shader.

**Holes are absent pixels, not coloured ones.** Painting them in the clear
colour would look identical while the background stays flat, but it would break
the moment the background changed and would not composite under anything drawn
later. Writing zero alpha instead keeps the background free.

**Edges are antialiased by sampling, not by branching.** One point per pixel
aliases as soon as a cell is smaller than a pixel, and the error is not
monotonic - it is a sampling artefact, not a precision limit. The sample count
is adjustable so the two behaviours can be compared directly.

**No dirty flag for uploads.** The parameters are uploaded unconditionally as
part of drawing. A flag would be one more piece of state to keep in sync, for a
saving that is negligible next to the cost of the draw itself.

**The centre is added after the projection.** Clip space and the coordinates the
mouse handler produces are then the same space, so a click needs no aspect
correction and the shape tracks the pointer exactly.

**Uniform layout is derived, not guessed.** WGSL places each member at an
offset that is a multiple of its alignment, and rounds the struct up to a
multiple of its largest alignment. `js/scene.js` lists the resulting byte
offsets and `js/wgsl.js` declares members in the matching order. Getting this
wrong produces no error at all - just fields read from the wrong bytes.
Ordering members widest-alignment-first keeps interior padding at zero.

## Files

```
index.html        Page structure, script loading, controls, event wiring
css/style.css     Layout: full-window canvas, diagnostics text, sliders
js/mat4.js        Column-major 4x4 matrix maths, orthographic projection
js/color.js       HSV to RGB conversion
js/wgsl.js        WGSL shader source
js/geometry.js    Vertex data and the byte layout describing it
js/scene.js       Per-draw parameters and their serialisation
js/renderer.js    GPU resources and command recording
js/main.js        Glue between DOM events and the renderer
```

Dependencies run one way: `index.html` -> `main.js` -> `renderer.js` ->
`geometry.js` / `scene.js` -> `wgsl.js` / `mat4.js` / `color.js`. Nothing in the
lower layers knows about the DOM.

## Why it runs from a local file

Under `file://` the page origin is `null`, so the browser blocks any request the
page makes for another resource. In practice that means:

| Technique                                           | Works from `file://` |
| --------------------------------------------------- | -------------------- |
| `<script src="x.js">` classic script                | yes                  |
| inline `<script type="module">`, top-level await    | yes                  |
| `<script type="module" src="x.js">` external module | no                   |
| `import './x.js'`                                   | no                   |
| `fetch()`                                           | no                   |
| `XMLHttpRequest`                                    | no                   |

So the code uses classic scripts for the modules and an inline module for the
entry point, which keeps top-level `await` available. Shader source is stored as
a string inside a script file rather than in a separate `.wgsl` file, because
loading one would be a fetch and would be blocked.

The scripts are not modules, but a top-level `const` or `class` declared in one
classic script is still visible to the next one. That gives the sharing of a
module without the loading restrictions, and without leaking anything onto
`window`.

Run the page behind a local web server instead and all of this could be replaced
with real ES modules; the file boundaries already match what the module
boundaries would be.

## Running from a server instead (optional)

```sh
python -m http.server 8000
```

Then open `http://localhost:8000/Exp1_Display/`. Behaviour is identical.
