import { defineCockpit } from './registry.js';

// COCKPIT: Focke-Wulf Fw 190 A-5 (framed flat-top sliding hood, Revi C/12 D).
//
// Body frame: +Z nose, +Y up, +X the pilot's LEFT; panel u / v are to the
// pilot's RIGHT / up. The canopy numbers are the spec's own glass sections
// (planes.js fw190.shape.canopy: windscreen base z 1.20 at half-width 0.18 /
// half-height 0.10 about y 0.60, windscreen rear bow z 0.90 at 0.36 / 0.20
// about y 0.56, the hood to z -0.35 at 0.30 / 0.16 about y 0.55), so the
// frame drawn here lines up with the airframe.
//
// What makes it an A-5 from the seat (Fw 190 A-5..A-7 pilot's notes; the
// sight change to the Revi 16 B came only with the A-7):
//   - the windscreen: a narrow, steeply raked FLAT 50 mm armoured front pane
//     between two heavy posts, with triangular quarter panes either side and
//     one bow at its rear where the sliding hood meets it;
//   - the hood: blown plexiglass with NO hoop overhead — only its bottom
//     rails and its rear frame — and the pilot's head armour riding inside
//     it, directly behind the head, propped by a tube to the rear frame;
//   - the Revi C/12 D reflector sight on the centreline, sitting on the
//     coaming hump that covers the two fuselage MG 17 breeches, its combining
//     glass centred on the eye line just behind the armoured pane, so the
//     graticule is seen through the glass and the pane with no frame on it
//     (the pane's top edge is the curved bow, ~4.7 deg above the boresight);
//   - the two-part panel, all RLM 66 black-grey: the upper (flight) panel with
//     airspeed over altimeter on the left, the Fl 22410 combined horizon /
//     turn indicator over the Fl 23334 repeater compass in the middle, the
//     AFN 2 homing indicator on the right and the clock right of the sight;
//     the lower (engine) panel with the ATA boost gauge and the tachometer
//     side by side, oil temperature and fuel contents to the right and the
//     VDM propeller-pitch "clock" to the left;
//   - a short stick low between the knees (the reclined seat puts the grip
//     well under the panel) and the single Kommandogerat lever on the LEFT.
// The eye stays the framework default (canopy y + 0.16, z + 0.05): clear of
// the pilot's head sphere and under the low hood, the Fw 190's notoriously
// short head room. It is stated explicitly so a later change to the default
// cannot move the Fw 190 pilot.
//
// Framework note: 'afn2' and 'pitch' are not dial kinds the framework animates;
// they draw as a static face (bezel, ticks), which is what an idle homing
// indicator and a pitch clock look like at a glance.

export default defineCockpit('fw190', (spec) => {
  const c = spec.shape.canopy; // z 0.35, y 0.55
  const eye = [0, c.y + 0.16, c.z + 0.05]; // [0, 0.71, 0.40]
  // the windscreen rear bow (the hood slides back from it) and the base
  const bow = { z: 0.9, hw: 0.36, hh: 0.2, y: 0.56 };
  const baseZ = 1.19;
  const baseY = 0.52;
  // the flat front pane: 0.30 m wide at its base, leaning back to the bow
  const postBase = 0.15;
  const postTop = 0.19;
  const bowTopY = bow.y + bow.hh * Math.sqrt(1 - (postTop / bow.hw) ** 2);
  // the hood's rear frame
  const rear = { z: -0.35, hw: 0.3, hh: 0.16, y: 0.55 };

  // head armour: a plate 12 mm on the real thing, here a stack of 34 mm bars
  // (the framework draws bars, not plates) behind the head sphere planes.js
  // puts at z 0.26, r 0.125; the top corners are cut, as on the A-series plate
  const ha = { z: 0.095, t: 0.034, y0: 0.5 };
  const rows = [0.15, 0.15, 0.15, 0.15, 0.15, 0.14, 0.12, 0.085];
  const plate = rows.map((hw, i) => {
    const y = ha.y0 + i * ha.t;
    return { a: [hw, y, ha.z], b: [-hw, y, ha.z], t: ha.t };
  });
  const plateTop = ha.y0 + (rows.length - 1) * ha.t;

  return {
    eye,
    canopy: {
      arches: [
        // the windscreen rear bow
        // (its inner edge rides at the glass, hh + t/2, so the bow's lower
        // edge stays ~4.7 deg above the boresight and the Revi ring is clear)
        { z: bow.z, hw: bow.hw, hh: bow.hh + 0.005, y: bow.y, t: 0.028, from: -0.3, to: Math.PI + 0.3 },
        // the hood's rear frame, behind the head armour
        { z: rear.z, hw: rear.hw, hh: rear.hh, y: rear.y, t: 0.032, from: -0.4, to: Math.PI + 0.4 },
      ],
      bars: [
        // the armoured pane's two heavy posts, base to bow
        { a: [postBase, baseY, baseZ], b: [postTop, bowTopY, bow.z + 0.01], t: 0.034 },
        { a: [-postBase, baseY, baseZ], b: [-postTop, bowTopY, bow.z + 0.01], t: 0.034 },
        // its base; the pane's top edge is the bow itself (curved, no
        // straight chord rail hanging across the aim point)
        { a: [postBase + 0.02, baseY, baseZ], b: [-postBase - 0.02, baseY, baseZ], t: 0.034 },
        // the triangular quarter panes' lower frames, down to the sills
        { a: [postBase, baseY, baseZ], b: [0.35, 0.44, bow.z], t: 0.028 },
        { a: [-postBase, baseY, baseZ], b: [-0.35, 0.44, bow.z], t: 0.028 },
        // the head armour plate, and the tube that props it on the hood
        ...plate,
        { a: [0, plateTop, ha.z - 0.02], b: [0, rear.y + rear.hh * 0.9, rear.z + 0.02], t: 0.02 },
        // the MG 17 breech covers either side of the sight, on the coaming
        { a: [0.1, 0.64, 0.78], b: [0.1, 0.64, 0.98], t: 0.045 },
        { a: [-0.1, 0.64, 0.78], b: [-0.1, 0.64, 0.98], t: 0.045 },
      ],
      // the hood's rails along both sills
      sills: { y: 0.43, hw: 0.37, z0: 0.9, z1: -0.4, t: 0.045 },
    },
    panel: {
      // board 0.33..0.61, tucked right under the coaming lip so the whole
      // upper (flight) panel is inside a 60 deg view straight ahead; the
      // engine panel stays low, as on the real aircraft (a glance down)
      z: 0.82,
      y: 0.47,
      w: 0.54,
      h: 0.28,
      tilt: 0.08,
      instruments: [
        // upper (flight) panel
        { kind: 'ias', u: -0.12, v: 0.088, r: 0.04 },
        { kind: 'ah', u: 0, v: 0.088, r: 0.042 },
        { kind: 'afn2', u: 0.12, v: 0.088, r: 0.035 },
        { kind: 'alt', u: -0.12, v: 0.006, r: 0.038 },
        { kind: 'compass', u: 0, v: 0.006, r: 0.036 },
        { kind: 'clock', u: 0.215, v: 0.1, r: 0.022 },
        // lower (engine) panel
        { kind: 'pitch', u: -0.19, v: -0.09, r: 0.026 },
        { kind: 'boost', u: -0.065, v: -0.095, r: 0.032 },
        { kind: 'tach', u: 0.065, v: -0.095, r: 0.032 },
        { kind: 'temp', u: 0.175, v: -0.07, r: 0.022 },
        { kind: 'fuel', u: 0.175, v: -0.115, r: 0.022 },
      ],
    },
    // the glare shield's lip over the upper panel; the gun hump runs forward
    coaming: { z: 0.82, y: 0.635, w: 0.56, h: 0.05, d: 0.1 },
    gunsight: {
      type: 'revi',
      // Revi C/12 D on the centreline, its combining glass CENTRED on the
      // line of sight: body top y 0.665, glass 0.665..0.755 about the eye's
      // 0.71 (the top bar ~5.2 deg up, tucked under the bow; the body's far
      // top edge ~4.2 deg down), so the whole graticule (ring + ticks reach
      // ~3.9 deg) sits inside the glass and inside the armoured pane
      pos: [0, 0.62, 0.93],
      size: [0.085, 0.09, 0.15],
      glassH: 0.09,
    },
    stick: { pos: [0, 0.13, 0.58], len: 0.3 },
    throttle: { pos: [0.29, 0.4, 0.42] },
    // RLM 66 Schwarzgrau throughout
    colors: {
      panel: 0x2a2c2e,
      frame: 0x3a3c3e,
      sill: 0x37393b,
      coaming: 0x232527,
      sight: 0x2b2d2f,
      stick: 0x1c1c1c,
    },
  };
});
