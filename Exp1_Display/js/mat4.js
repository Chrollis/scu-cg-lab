'use strict';

// ---------------------------------------------------------------------------
// mat4.js -- minimal 4x4 matrix maths, column major, no dependencies.
//
// Pure arithmetic: no GPU objects, no WebGPU constants, nothing canvas related.
//
// A 16-float array whose first four entries are the first COLUMN, so
// (row, col) maps to index col * 4 + row and the translation sits at 12, 13,
// 14. This matches WGSL's mat4x4f, so the array goes into a uniform buffer with
// no conversion. Getting the order backwards is a silent failure: everything
// stays valid and the picture is simply in the wrong place.
// ---------------------------------------------------------------------------

const MAT4_FLOATS = 16;

const Mat4 = (() => {
  /**
   * @param {Float32Array} [out]
   * @returns {Float32Array} the identity matrix
   */
  function identity(out = new Float32Array(MAT4_FLOATS)) {
    out.fill(0);
    out[0] = 1;
    out[5] = 1;
    out[10] = 1;
    out[15] = 1;
    return out;
  }

  /**
   * Orthographic projection for WebGPU's clip space: maps the world box
   * [left,right] x [bottom,top] x [near,far] onto x,y in -1..1 and z in 0..1.
   *
   * The Z RANGE is 0..1, not -1..1. WebGPU follows Direct3D and Metal here,
   * where OpenGL and WebGL used -1..1. An unmodified OpenGL ortho() pushes
   * every vertex outside the depth range, and the result is an empty screen
   * with no error -- clipping is normal behaviour, not a validation failure.
   *
   * @param {number} left
   * @param {number} right
   * @param {number} bottom
   * @param {number} top
   * @param {number} near
   * @param {number} far
   * @param {Float32Array} [out]
   * @returns {Float32Array}
   */
  function ortho(
    left,
    right,
    bottom,
    top,
    near,
    far,
    out = new Float32Array(MAT4_FLOATS),
  ) {
    if (left === right) throw new Error('ortho: left equals right');
    if (bottom === top) throw new Error('ortho: bottom equals top');
    if (near === far) throw new Error('ortho: near equals far');

    const width = right - left;
    const height = top - bottom;
    const depth = far - near;

    out.fill(0);
    out[0] = 2 / width;
    out[5] = 2 / height;
    out[10] = 1 / depth; // z maps to 0..1 for WebGPU
    out[12] = -(right + left) / width;
    out[13] = -(top + bottom) / height;
    out[14] = -near / depth;
    out[15] = 1;

    return out;
  }

  /**
   * Orthographic projection mapping a world half-extent onto a chosen number of
   * device pixels.
   *
   * Two things at once. Aspect: a clip-space box is stretched onto the viewport,
   * scaling x by width/2 pixels per unit and y by height/2, so a square comes
   * out rectangular unless x is divided by the aspect ratio. Size: one global
   * scale then sets how large the result is, without disturbing proportions.
   *
   * Measuring the world in pixels rather than in fractions of the window is what
   * holds the shape at a fixed on-screen size as the window resizes.
   *
   * @param {{
   *   viewportWidth: number,      device pixels
   *   viewportHeight: number,     device pixels
   *   worldHalfExtent: number,    half the shape's size in world units
   *   targetHalfExtentPx: number, half that many device pixels on screen
   * }} options
   * @param {Float32Array} [out]
   * @returns {Float32Array}
   */
  function forPixels(
    { viewportWidth, viewportHeight, worldHalfExtent, targetHalfExtentPx },
    out = new Float32Array(MAT4_FLOATS),
  ) {
    if (
      !(viewportWidth > 0) ||
      !(viewportHeight > 0) ||
      !(worldHalfExtent > 0) ||
      !(targetHalfExtentPx > 0)
    ) {
      return identity(out);
    }

    const aspect = viewportWidth / viewportHeight;

    // Clip space spans -1..1 over the viewport's height, so one clip unit is
    // viewportHeight/2 device pixels. A world half-extent of h becomes a clip
    // half-extent of h*scale, which is h*scale*viewportHeight/2 pixels; setting
    // that equal to the target solves for scale directly.
    const pixelsPerClipUnit = viewportHeight / 2;
    const scale = targetHalfExtentPx / (worldHalfExtent * pixelsPerClipUnit);

    // ortho() writes 2/(right-left) and 2/(top-bottom), so shrinking the
    // extents by scale multiplies both output scales by it.
    return ortho(
      -aspect / scale,
      aspect / scale,
      -1 / scale,
      1 / scale,
      0,
      1,
      out,
    );
  }

  return Object.freeze({ identity, ortho, forPixels });
})();
