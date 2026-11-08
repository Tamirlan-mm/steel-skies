import { defineCockpit } from './registry.js';

// REFERENCE COCKPIT: P-51D Mustang (bubble canopy, K-14 gyro gunsight).
//
// Body frame: +Z nose, +Y up, +X the pilot's LEFT; u / v on the panel are to
// the pilot's RIGHT / up. The canopy numbers come from the spec's own glass
// sections (planes.js p51.shape.canopy: windscreen base z 1.30, windscreen
// rear bow z 1.00 at half-width 0.36 / half-height 0.21 about y 0.57, the
// bubble to z -0.70), so the frame drawn here lines up with the airframe.
//
// What makes it a D-model from the seat:
//   - the windscreen: a FLAT bullet-resistant front panel between two posts,
//     two curved quarter panels, and one bow at its rear where the sliding
//     bubble meets it — the bubble itself has NO frame overhead, only its
//     rails along the sills and the rear bow behind the pilot's head;
//   - the K-14 gyro sight on top of the panel, offset nothing, its combining
//     glass just under the eye line, range and span knobs either side;
//   - the panel: flight group in the middle (airspeed, gyro horizon,
//     altimeter over turn-and-bank, directional gyro, rate of climb), engine
//     group below (manifold pressure, tachometer, coolant, fuel).
// The eye is the framework's default (canopy y + 0.16, z + 0.05), measured
// clear of the airframe (planeCamera.js): stated explicitly here so a later
// change to the default cannot move the Mustang pilot.

export default defineCockpit('p51', (spec, base) => {
  const c = spec.shape.canopy; // z 0.40, y 0.55
  const eye = [0, c.y + 0.16, c.z + 0.05];
  // the windscreen's rear bow and its base
  const bow = { z: 1.0, hw: 0.36, hh: 0.21, y: 0.57 };
  const baseZ = 1.3;
  const baseY = 0.6 - 0.1 * 0.72;
  // the flat front panel: 0.30 m wide at its base, leaning back to the bow
  const postBase = 0.15;
  const postTop = 0.19;
  const bowTopY = bow.y + bow.hh * Math.sqrt(1 - (postTop / bow.hw) ** 2);
  return {
    eye,
    canopy: {
      arches: [
        // the windscreen rear bow (the bubble slides back from it)
        { z: bow.z, hw: bow.hw, hh: bow.hh, y: bow.y, t: 0.034, from: -0.3, to: Math.PI + 0.3 },
        // the bubble's rear bow, behind the head
        { z: -0.66, hw: 0.19, hh: 0.095, y: 0.5, t: 0.03, from: -0.4, to: Math.PI + 0.4 },
      ],
      bars: [
        // the front panel's two posts, base to bow
        { a: [postBase, baseY + 0.02, baseZ - 0.02], b: [postTop, bowTopY, bow.z + 0.01], t: 0.028 },
        { a: [-postBase, baseY + 0.02, baseZ - 0.02], b: [-postTop, bowTopY, bow.z + 0.01], t: 0.028 },
        // its top rail along the bow, and the windscreen base
        { a: [postTop, bowTopY, bow.z + 0.01], b: [-postTop, bowTopY, bow.z + 0.01], t: 0.024 },
        { a: [0.21, baseY, baseZ], b: [-0.21, baseY, baseZ], t: 0.03 },
        // the quarter panels' lower frames, down to the sills
        { a: [0.21, baseY, baseZ], b: [0.35, 0.43, bow.z], t: 0.026 },
        { a: [-0.21, baseY, baseZ], b: [-0.35, 0.43, bow.z], t: 0.026 },
      ],
      // the canopy rails along both sills
      sills: { y: 0.415, hw: 0.37, z0: 1.02, z1: -0.7, t: 0.045 },
    },
    panel: {
      z: 0.86,
      y: 0.47,
      w: 0.56,
      h: 0.3,
      tilt: 0.1,
      instruments: [
        { kind: 'ias', u: -0.15, v: 0.07, r: 0.04 },
        { kind: 'ah', u: 0, v: 0.07, r: 0.045 },
        { kind: 'alt', u: 0.15, v: 0.07, r: 0.04 },
        { kind: 'turn', u: -0.15, v: -0.035, r: 0.034 },
        { kind: 'compass', u: 0, v: -0.035, r: 0.04 },
        { kind: 'vsi', u: 0.15, v: -0.035, r: 0.034 },
        { kind: 'boost', u: -0.2, v: -0.12, r: 0.03 },
        { kind: 'tach', u: -0.08, v: -0.12, r: 0.03 },
        { kind: 'temp', u: 0.06, v: -0.12, r: 0.024 },
        { kind: 'fuel', u: 0.16, v: -0.12, r: 0.024 },
        { kind: 'clock', u: 0.235, v: 0.07, r: 0.022 },
      ],
    },
    // a short glare shield, so the top row of dials shows under its lip
    coaming: { z: 0.84, y: 0.62, w: 0.58, h: 0.045, d: 0.07 },
    gunsight: {
      type: 'k14',
      // on the coaming, its glass top just under the eye line
      pos: [0, 0.632, 0.9],
      size: [0.1, 0.07, 0.2],
      glassH: 0.07,
    },
    stick: { pos: [0, 0.24, 0.68], len: 0.34 },
    throttle: { pos: [0.31, 0.4, 0.5] },
    colors: { panel: 0x2a2c28, frame: 0x8c9284, sill: 0x6b7262 },
  };
});
