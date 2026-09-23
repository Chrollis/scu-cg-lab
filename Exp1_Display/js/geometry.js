'use strict';

// ---------------------------------------------------------------------------
// geometry.js -- vertex data, and the memory layout describing it.
//
// A GPU buffer is just bytes. That "every 20 bytes form a position and a colour"
// lives in the layout description below, which the pipeline reads. This is what
// WebGL hid behind bindBuffer + vertexAttribPointer, and the easiest part to get
// wrong.
// ---------------------------------------------------------------------------

const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT; // 4

const POSITION_COMPONENTS = 2;
const COLOR_COMPONENTS = 3;

// Shader locations. These must match the @location(n) parameters on the WGSL
// vertex entry point, or an attribute feeds the wrong argument.
const LOCATION_POSITION = 0;
const LOCATION_COLOR = 1;

/**
 * @returns {GPUVertexBufferLayout}
 */
function vertexLayout() {
  const positionBytes = POSITION_COMPONENTS * FLOAT_BYTES; // 8
  const colorBytes = COLOR_COMPONENTS * FLOAT_BYTES; // 12

  return {
    // Stride covers one whole vertex: position and colour, interleaved.
    arrayStride: positionBytes + colorBytes,
    attributes: [
      {
        shaderLocation: LOCATION_POSITION,
        offset: 0,
        format: 'float32x2',
      },
      {
        // Two attributes share one arrayStride and carve out their own slice by
        // starting at a different byte.
        shaderLocation: LOCATION_COLOR,
        offset: positionBytes,
        format: 'float32x3',
      },
    ],
  };
}

/**
 * Pack coordinates and per-vertex colours into one interleaved buffer.
 *
 *   byte  0    4    8    12   16   20   24   28   32   36   40
 *         +----+----+----+----+----+----+----+----+----+----+
 *         | x0 | y0 | r0 | g0 | b0 | x1 | y1 | r1 | g1 | b1 |
 *         +----+----+----+----+----+----+----+----+----+----+
 *         |<-- position -->|<- colour ->|
 *         |<--------------- vertex 0 ------------->|  ...
 *
 * Every vertex carries a colour even when it is white. That is what removes the
 * need for a branch in the shader: white multiplied by any tint is that tint,
 * so "no colour" is expressed as data rather than as control flow.
 *
 * @param {number[]} coordinates flat [x0, y0, x1, y1, ...]
 * @param {number[][]} [colors] one [r, g, b] per vertex; white when omitted
 * @param {'triangle-list'|'triangle-strip'} [topology]
 * @returns {{
 *   vertices: Float32Array,
 *   vertexCount: number,
 *   layout: GPUVertexBufferLayout,
 *   topology: string,
 * }}
 */
function makeGeometry(coordinates, colors, topology = 'triangle-list') {
  if (coordinates.length % POSITION_COMPONENTS !== 0) {
    throw new Error(
      `Geometry needs x,y pairs, got ${coordinates.length} numbers.`,
    );
  }

  const vertexCount = coordinates.length / POSITION_COMPONENTS;

  if (colors && colors.length !== vertexCount) {
    throw new Error(
      `Got ${vertexCount} vertices but ${colors.length} colours.`,
    );
  }

  const strideFloats = POSITION_COMPONENTS + COLOR_COMPONENTS;
  const vertices = new Float32Array(vertexCount * strideFloats);

  for (let i = 0; i < vertexCount; i++) {
    const base = i * strideFloats;
    vertices[base] = coordinates[i * POSITION_COMPONENTS];
    vertices[base + 1] = coordinates[i * POSITION_COMPONENTS + 1];

    const color = colors ? colors[i] : [1, 1, 1];
    vertices[base + 2] = color[0];
    vertices[base + 3] = color[1];
    vertices[base + 4] = color[2];
  }

  return {
    vertices,
    vertexCount,
    layout: vertexLayout(),
    topology,
  };
}

// ---------------------------------------------------------------------------
// The shape.
// ---------------------------------------------------------------------------

// Four vertices in a Z order: bottom-left, top-left, bottom-right, top-right.
//
//   v0 --- v2
//   |  \   |
//   |   \  |
//   v1 --- v3
//
// A strip emits one triangle per new vertex after the first two, so four
// vertices give two triangles where a list would need six. The implied second
// triangle is (v2, v1, v3), wound backwards on purpose to keep a consistent
// facing.
//
// The coordinates stay at +-0.2 whatever the on-screen size: scaling happens in
// the projection. Changing them would also invalidate the 0.4 divisor the
// fragment shader uses to normalise local space.
const SQUARE_SIDE = 0.4;
const SQUARE_HALF = SQUARE_SIDE / 2;

const SQUARE = [-0.2, -0.2, -0.2, 0.2, 0.2, -0.2, 0.2, 0.2];

/**
 * Per-vertex colours spread around the hue wheel.
 *
 * Interpolation happens in RGB, not HSV, so two vertices 0.5 (180 degrees)
 * apart blend through grey in the middle; the Z ordering puts those on opposite
 * corners, making that diagonal the greyest part. A 0.25 (90 degree) step keeps
 * neighbours closer and the ramp vivid.
 *
 * @param {number} count
 * @param {number} [step] hue advance per vertex, in turns
 * @returns {number[][]}
 */
function hueRamp(count, step = 0.25) {
  const base = Math.random();

  return Array.from({ length: count }, (_, i) =>
    Color.hsvToRgb(base + i * step, 0.72, 0.95),
  );
}

/**
 * The square the fractal is carved out of.
 *
 * Vertices carry a hue ramp that the shader returns in RGB, while the fractal
 * coverage goes into alpha -- separate channels, so the gradient and the holes
 * do not compete.
 *
 * @returns {object} the geometry bundle expected by Renderer
 */
function makeSquare() {
  const geometry = makeGeometry(SQUARE, hueRamp(4), 'triangle-strip');
  geometry.worldHalfExtent = SQUARE_HALF;
  return geometry;
}

const GEOMETRY = Object.freeze({ makeSquare });
