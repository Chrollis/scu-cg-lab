'use strict';

// ---------------------------------------------------------------------------
// The WGSL source, kept as a plain string.
//
// Not a separate .wgsl file on purpose: under file:// every fetch and every
// XMLHttpRequest is blocked, so the shader has to travel inside a script loaded
// with a classic <script> tag.
//
// A top-level `const` in a classic script lands in the shared global lexical
// scope, so later scripts can see SHADERS without any import/export.
// ---------------------------------------------------------------------------

const SHADERS = Object.freeze({
  // Vertex data supplies the shape and a per-vertex colour; the uniform supplies
  // the projection, placement and size; the fragment stage carves a Sierpinski
  // carpet out of the square.
  //
  // The carpet is antialiased by supersampling N*N points per pixel and writing
  // the surviving fraction as alpha, so partially covered pixels blend and
  // fully covered ones write nothing. RGB carries the vertex gradient and alpha
  // carries the fractal: split across channels, the two can coexist.
  centered: /* wgsl */ `
// Offsets that scene.js mirrors exactly. Widest alignment first keeps interior
// padding at zero; a mismatch reads the wrong bytes with no error at all.
//
//   projection   0   mat4x4f   64 bytes
//   color       64   vec4f     16
//   center      80   vec2f      8
//   depth       88   f32        4
//   hueShift    92   f32        4
//   samples     96   f32        4
//   total      112   (rounded up to the struct's own 16-byte alignment)
struct Params {
  projection : mat4x4f,
  color      : vec4f,
  center     : vec2f,
  depth      : f32,
  hueShift   : f32,
  samples    : f32,
};

@group(0) @binding(0) var<uniform> params : Params;

// Matched to the fragment stage by @location number, not by name. This is an
// interface declaration rather than a memory layout, so member order is free.
struct VertexOutput {
  @builtin(position) position : vec4f,
  @location(0)       color    : vec3f,
  @location(1)       local    : vec2f,
};

@vertex
fn vs(
  @location(0) position : vec2f,
  @location(1) color    : vec3f,
) -> VertexOutput {
  // Carries both the aspect correction and the on-screen size, so the same four
  // vertices work at any scale with no change to the buffer.
  let projected = params.projection * vec4f(position, 0.0, 1.0);

  var out : VertexOutput;

  // Added after the projection to keep it in clip space. That way the mouse
  // handler needs no aspect correction, and scaling the shape does not scale
  // its movement.
  out.position = vec4f(projected.xy + params.center, 0.0, 1.0);

  // Interpolated across the triangle by the rasteriser, for free.
  out.color = color;

  // Model space, before projection and before the centre. The fragment stage
  // cannot recover this from @builtin(position), which arrives in pixels.
  out.local = position;

  return out;
}

// p is in the square's normalised 0..1 space. Reading p as a base-3 fraction
// means each pass takes one digit: floor gives which of nine cells the point is
// in, fract leaves the rest for the next pass. The middle cell of any level is
// a hole.
fn inHole(pIn: vec2f, depth: u32) -> bool {
  var p = pIn;
  for (var i = 0u; i < depth; i += 1u) {
    let cell = floor(p * 3.0);
    if (all(cell == vec2f(1.0, 1.0))) {
      return true;
    }
    p = fract(p * 3.0);
  }
  return false;
}

// The same digits folded into a base-9 address used to pick a colour. Weights
// shrink ninefold each pass so the first digit dominates; equal weights would
// read as speckle rather than structure.
fn addressOf(pIn: vec2f, depth: u32) -> f32 {
  var p = pIn;
  var address = 0.0;
  var weight = 1.0 / 9.0;
  for (var i = 0u; i < depth; i += 1u) {
    let cell = floor(p * 3.0);
    address += (cell.x + cell.y * 3.0) * weight;
    p = fract(p * 3.0);
    weight /= 9.0;
  }
  return address;
}

@fragment
fn fs(
  @location(0) color : vec3f,
  @location(1) local : vec2f,
) -> @location(0) vec4f {
  // 0.4 is the square's side length in world units. It stays valid because the
  // on-screen size is applied in the projection, not to the vertex data.
  let p = local / 0.4 + 0.5;

  // How far one pixel moves in p. fwidth derives it, so sampling stays adequate
  // at any shape size without a hand-tuned constant per zoom level.
  let pixelStep = max(fwidth(p).x, fwidth(p).y);

  let n = max(u32(params.samples + 0.5), 1u);
  let side = f32(n);
  let texel = pixelStep / side;
  let origin = p - pixelStep * 0.5 + texel * 0.5;
  let depth = u32(params.depth);

  // Fraction of the pixel lying outside every hole: 1 fully outside, 0 fully
  // inside, in between means the pixel straddles an edge.
  var survivors = 0.0;
  for (var sy = 0u; sy < n; sy += 1u) {
    for (var sx = 0u; sx < n; sx += 1u) {
      if (!inHole(origin + vec2f(f32(sx), f32(sy)) * texel, depth)) {
        survivors += 1.0;
      }
    }
  }
  let coverage = survivors / (side * side);

  // A cosine palette rather than a colour wheel: one cos() over a vec3, no
  // branches, and smooth, so nearby addresses stay near in colour.
  let t = addressOf(p, depth) + params.hueShift;
  let fractalRgb = 0.5 + 0.5 * cos(6.28318 * (t + vec3f(0.0, 0.33, 0.67)));

  // Mostly the vertex gradient, tinted by the fractal. 0 is pure gradient,
  // 1 is pure palette.
  let mixAmount = 0.35;
  let rgb = mix(color * params.color.rgb, fractalRgb, mixAmount);

  // Alpha is the coverage, so a pixel fully inside a hole writes nothing rather
  // than writing the clear colour. That is what keeps the background free.
  return vec4f(rgb, coverage * params.color.a);
}
`,
});
