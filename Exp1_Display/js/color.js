'use strict';

// ---------------------------------------------------------------------------
// color.js -- colour space conversions, no dependencies.
//
// Lives on its own because it is pure arithmetic with nothing to do with GPUs
// or the DOM, and because the hue ramp in geometry.js is its only caller.
// ---------------------------------------------------------------------------

const Color = (() => {
  /**
   * Convert hue/saturation/value to RGB, all in 0..1.
   *
   * Hue wraps, so any real number is accepted and reduced modulo 1 -- which is
   * what makes "advance the hue by 90 degrees" work without branch-on-overflow
   * at the call site.
   *
   * @param {number} h hue, 0..1 for one full turn
   * @param {number} s saturation, 0..1
   * @param {number} v value (brightness), 0..1
   * @returns {[number, number, number]}
   */
  function hsvToRgb(h, s, v) {
    // Wrap first so that h = 1.25 behaves like h = 0.25.
    const wrapped = h - Math.floor(h);
    const sector = wrapped * 6;
    const index = Math.floor(sector);
    const fraction = sector - index;

    const p = v * (1 - s);
    const q = v * (1 - s * fraction);
    const t = v * (1 - s * (1 - fraction));

    switch (index % 6) {
      case 0:
        return [v, t, p];
      case 1:
        return [q, v, p];
      case 2:
        return [p, v, t];
      case 3:
        return [p, q, v];
      case 4:
        return [t, p, v];
      default:
        return [v, p, q];
    }
  }

  return Object.freeze({ hsvToRgb });
})();
