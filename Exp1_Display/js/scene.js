'use strict';

// ---------------------------------------------------------------------------
// scene.js -- the CPU-side description of what to draw.
//
// Geometry says which vertices exist; these parameters say where they sit, how
// large they are and what colour they take. All of them are uniform for a whole
// draw, which is what a uniform buffer is for -- sending them per-vertex would
// copy the same value once per vertex.
//
// The class also serialises itself into the byte layout the WGSL struct
// declares. Keeping both definitions side by side is deliberate: they have to
// agree, and a mismatch produces no error at all.
// ---------------------------------------------------------------------------

// Offsets mirrored by the WGSL struct in js/wgsl.js. Placed widest-alignment
// first, which keeps interior padding at zero.
//
//   projection   0   mat4x4f   64 bytes
//   color       64   vec4f     16
//   center      80   vec2f      8
//   depth       88   f32        4
//   hueShift    92   f32        4
//   samples     96   f32        4
//   total      112   (rounded up to the struct's own 16-byte alignment)
const UNIFORM_LAYOUT = Object.freeze({
  projection: 0,
  color: 64,
  center: 80,
  depth: 88,
  hueShift: 92,
  samples: 96,
  byteLength: 112,
});

const UNIFORM_FLOATS = UNIFORM_LAYOUT.byteLength / 4;

// Past this the smallest cell is well under a pixel across, so extra levels cost
// work without changing anything visible. It also bounds the per-pixel loop.
const MAX_DEPTH = 10;

class SceneParams {
  #centerX = 0;
  #centerY = 0;
  #color = [1, 0, 0, 1];
  #depth = 0;
  #hueShift = 0;
  #samples = 1;

  // View state, kept so the projection can be rebuilt whenever either the
  // viewport or the requested on-screen size changes.
  #viewportWidth = 1;
  #viewportHeight = 1;
  #sidePx = 200;
  #worldHalfExtent = 0.2;

  // Reused by writeInto so an upload does not allocate.
  #projection = Mat4.identity();

  static get byteLength() {
    return UNIFORM_LAYOUT.byteLength;
  }

  static get MIN_SIDE_PX() {
    return Math.exp(5);
  }

  static get MAX_SIDE_PX() {
    return Math.exp(10);
  }

  static get MAX_SAMPLES() {
    return 4;
  }

  get center() {
    return { x: this.#centerX, y: this.#centerY };
  }

  get color() {
    return [...this.#color];
  }

  get depth() {
    return this.#depth;
  }

  get hueShift() {
    return this.#hueShift;
  }

  get samples() {
    return this.#samples;
  }

  get sidePx() {
    return this.#sidePx;
  }

  /**
   * Rotate the fractal palette by a fresh random amount.
   *
   * Re-rolling the vertex colours would not work here: the shader builds the
   * fractal colour from the pixel's address, so the vertices only act as a
   * tint.
   *
   * @returns {this}
   */
  setRandomHueShift() {
    this.#hueShift = Math.random();
    return this;
  }

  /**
   * @param {number} depth 0..MAX_DEPTH, in whole steps
   * @returns {this}
   */
  setDepth(depth) {
    const whole = Math.floor(depth);
    this.#depth = Math.min(Math.max(whole, 0), MAX_DEPTH);
    return this;
  }

  /**
   * @param {number} width device pixels
   * @param {number} height device pixels
   * @returns {this}
   */
  setViewport(width, height) {
    if (!(width > 0) || !(height > 0)) {
      return this;
    }

    this.#viewportWidth = width;
    this.#viewportHeight = height;
    return this.#rebuildProjection();
  }

  /**
   * On-screen size, in CSS pixels, so the slider number matches what a person
   * measures. The caller converts using the device pixel ratio.
   *
   * @param {number} pixels
   * @returns {this}
   */
  setSidePx(pixels) {
    this.#sidePx = Math.min(
      Math.max(pixels, SceneParams.MIN_SIDE_PX),
      SceneParams.MAX_SIDE_PX,
    );
    return this.#rebuildProjection();
  }

  /** @returns {this} */
  #rebuildProjection() {
    Mat4.forPixels(
      {
        viewportWidth: this.#viewportWidth,
        viewportHeight: this.#viewportHeight,
        worldHalfExtent: this.#worldHalfExtent,
        targetHalfExtentPx: (this.#sidePx * this.#devicePixelRatio) / 2,
      },
      this.#projection,
    );
    return this;
  }

  /**
   * Half the shape's extent in world units, taken from the geometry so the two
   * cannot drift apart.
   *
   * @param {number} halfExtent
   * @returns {this}
   */
  setWorldHalfExtent(halfExtent) {
    if (halfExtent > 0) {
      this.#worldHalfExtent = halfExtent;
      this.#rebuildProjection();
    }
    return this;
  }

  // Stored rather than read from window, so this class stays free of browser
  // globals and can be exercised directly.
  #devicePixelRatio = 1;

  /**
   * @param {number} ratio
   * @returns {this}
   */
  setDevicePixelRatio(ratio) {
    if (ratio > 0) {
      this.#devicePixelRatio = ratio;
      this.#rebuildProjection();
    }
    return this;
  }

  /**
   * Coverage samples per axis. One means a single point at the pixel centre,
   * which aliases once a cell is smaller than a pixel; each step squares the
   * fragment loop's work.
   *
   * @param {number} n 1..MAX_SAMPLES
   * @returns {this}
   */
  setSamples(n) {
    const whole = Math.floor(n);
    this.#samples = Math.min(Math.max(whole, 1), SceneParams.MAX_SAMPLES);
    return this;
  }

  /**
   * Move the shape. Coordinates are clip space: x/y run -1..1, origin centred.
   *
   * @param {number} x
   * @param {number} y
   * @returns {this}
   */
  setCenter(x, y) {
    this.#centerX = x;
    this.#centerY = y;
    return this;
  }

  /**
   * @param {number} r 0..1
   * @param {number} g 0..1
   * @param {number} b 0..1
   * @param {number} [a]
   * @returns {this}
   */
  setColor(r, g, b, a = 1) {
    this.#color = [r, g, b, a];
    return this;
  }

  /**
   * Serialise into a Float32Array laid out for the GPU.
   *
   * The target is passed in rather than allocated here, and reused across
   * uploads, so a per-frame write creates no garbage.
   *
   * @param {Float32Array} target with UNIFORM_FLOATS entries
   * @returns {Float32Array}
   */
  writeInto(target) {
    if (target.length !== UNIFORM_FLOATS) {
      throw new Error(
        `This uniform block needs ${UNIFORM_FLOATS} floats, got ${target.length}.`,
      );
    }

    const F = Float32Array.BYTES_PER_ELEMENT;
    const at = (byteOffset) => byteOffset / F;

    // Already column major, so it copies verbatim.
    target.set(this.#projection, at(UNIFORM_LAYOUT.projection));

    const colorAt = at(UNIFORM_LAYOUT.color);
    const c = this.#color;
    target[colorAt] = c[0];
    target[colorAt + 1] = c[1];
    target[colorAt + 2] = c[2];
    target[colorAt + 3] = c[3];

    const centerAt = at(UNIFORM_LAYOUT.center);
    target[centerAt] = this.#centerX;
    target[centerAt + 1] = this.#centerY;

    target[at(UNIFORM_LAYOUT.depth)] = this.#depth;
    target[at(UNIFORM_LAYOUT.hueShift)] = this.#hueShift;
    target[at(UNIFORM_LAYOUT.samples)] = this.#samples;

    // The floats after samples are the struct's trailing padding. They are
    // already zero from allocation and are never written, but the buffer still
    // has to be this long.

    return target;
  }

  /** @returns {Float32Array} a fresh array sized for this uniform block */
  static createBuffer() {
    return new Float32Array(UNIFORM_FLOATS);
  }
}
