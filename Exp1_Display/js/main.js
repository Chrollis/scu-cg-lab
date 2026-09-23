'use strict';

// ---------------------------------------------------------------------------
// main.js -- the glue layer: DOM events on one side, Renderer on the other.
//
// Knows nothing about WGSL or command buffers, which keeps the DOM wiring
// separate from the rendering code.
// ---------------------------------------------------------------------------

/**
 * @param {Renderer} renderer
 * @param {SceneParams} params
 * @returns {string} the diagnostic block shown in the corner of the page
 */
function describeScene(renderer, params) {
  const info = renderer.adapterInfo || {};
  const name = [info.vendor, info.architecture].filter(Boolean).join(' ');
  const { width, height } = renderer.resolution;

  const { x, y } = params.center;

  return (
    `adapter: ${name || 'unknown adapter'}\n` +
    `resolution: ${width}x${height}\n` +
    `side: ${Math.round(params.sidePx)} css px\n` +
    `depth: ${params.depth}  samples: ${params.samples}x${params.samples}\n` +
    `center: (${x.toFixed(3)}, ${y.toFixed(3)})\n` +
    `click to move and recolour`
  );
}

/**
 * Boot the app and return the live Renderer plus its scene.
 *
 * Async so the inline module in index.html can simply await it. An inline
 * module is the only place under file:// with top-level await, since an
 * external one would have to be fetched and fetches are blocked.
 *
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   messageElement: HTMLElement,
 *   shaderCode: string,
 *   geometry: object,
 *   uniformByteLength?: number,
 * }} options
 * @returns {Promise<object>} the renderer, the scene params and the controls
 */
async function startApp({
  canvas,
  messageElement,
  shaderCode,
  geometry,
  uniformByteLength = 0,
}) {
  const showMessage = (text) => {
    messageElement.textContent = text;
  };

  const renderer = await Renderer.create(
    canvas,
    { shaderCode, geometry, uniformByteLength },
    {
      // Async GPU failures have no stack trace to point at, so surface them in
      // the page as well -- a silent blank canvas is the worst possible outcome.
      onUncapturedError: (text) => {
        console.error(text);
        showMessage(text);
      },
    },
  );

  // The CPU-side model of what is being drawn. Mutating it only changes this
  // object -- the GPU learns about it when setParams uploads it.
  const params = new SceneParams();

  // resize() and render() are an atomic pair: assigning canvas.width resets
  // the drawing buffer, so a resize without a repaint leaves a blank canvas.
  let rendered = false;

  const redraw = () => {
    // On a cold load the canvas may not be laid out yet (clientWidth reads as
    // 1), which would bake in a wrong resolution, so wait for a real layout.
    if (!rendered && renderer.measure().width <= 1) {
      return;
    }

    const resized = renderer.resize();

    // The viewport is in device pixels while the on-screen size is in CSS
    // pixels, so they are kept as separate inputs rather than folded into one
    // aspect number.
    if (resized) {
      const { width, height } = renderer.resolution;
      params
        .setDevicePixelRatio(window.devicePixelRatio || 1)
        .setViewport(width, height);
    }

    // Upload then draw. Both are queue operations, so the write is guaranteed
    // to land before this frame runs. There is no dirty flag to maintain: the
    // upload is simply part of drawing.
    renderer.setParams(params);
    renderer.render();

    rendered = true;
    showMessage(describeScene(renderer, params));
  };

  // Fires once on observe, which is what corrects the first paint above, and
  // again for layout changes that never touch window size -- unlike a plain
  // window 'resize' listener.
  new ResizeObserver(redraw).observe(canvas);

  /**
   * On-screen size in CSS pixels.
   *
   * Folded into the projection rather than the vertex data, so the buffer is
   * untouched and the shader's local space stays valid.
   *
   * @param {number} pixels
   */
  const setSidePx = (pixels) => {
    params.setSidePx(Math.exp(pixels));
  };

  /**
   * Coverage samples per axis.
   *
   * @param {number} n
   */
  const setSamples = (n) => {
    params.setSamples(n);
  };

  /** Rotate the fractal palette. A uniform change, not a vertex-data change. */
  const recolor = () => {
    params.setRandomHueShift();
  };

  /**
   * @param {number} depth
   */
  const setDepth = (depth) => {
    params.setDepth(depth);
  };

  // Neutral tint, so the shader's own colours pass through unmodified.
  params.setColor(1, 1, 1, 1);

  return { renderer, params, redraw, recolor, setDepth, setSidePx, setSamples };
}
