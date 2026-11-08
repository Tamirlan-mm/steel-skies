import { defineCockpit } from './registry.js';

// COCKPIT: Messerschmitt Bf 109 G-6 (framed hood, Revi 16B reflector sight).
//
// Body frame: +Z nose, +Y up, +X the pilot's LEFT; u / v on the panel are to
// the pilot's RIGHT / up. Every frame member is placed on the spec's own glass
// sections (planes.js bf109g6.shape.canopy, z 0.50 / y 0.62):
//   S0 z  1.45  hw 0.20 hh 0.09 y 0.67   windscreen base (flat armour panel)
//   S1 z  1.15  hw 0.30 hh 0.22 y 0.64   windscreen rear frame = hood front bow
//   S2 z  0.55  hw 0.31 hh 0.25 y 0.63   (abeam the eye: no frame here)
//   S3 z -0.10  hw 0.29 hh 0.23 y 0.62   hood rear frame / fixed rear glazing
//   S4 z -0.50  hw 0.20 hh 0.13 y 0.60   rear glazing ends on the spine
// so the frame drawn here lines up with the airframe seen from outside.
//
// What makes it a G-6 from the seat (mid-production hood, before the Erla
// clear-view hood and the Galland armour glass of late 1944):
//   - the windscreen: a flat thick armour-glass front panel between two posts,
//     angled side panels, a heavy base frame on the coaming;
//   - the hood, hinged on the STARBOARD sill: a flat roof pane edged by two
//     rails that run the hood's length, a front bow and a rear frame, and the
//     curved steel head-armour plate hung from the hood roof behind the head;
//   - the fixed rear glazing behind the hood, framed down to the spine;
//   - the Revi 16B reflector sight on the centreline above the panel, its
//     combining glass just under the eye line, a crash pad on its back;
//   - the two MG 131 breech fairings either side of the sight (the same guns
//     whose breech blocks need the Beulen on the cowl outside);
//   - the panel: no artificial horizon (not standard on the G-6) — airspeed
//     over altimeter on the left, turn-and-slip over the repeater compass in
//     the middle, supercharger pressure (ATA) over the tachometer on the
//     right; below them the twin oil/coolant thermometer, the fuel contents
//     gauge and the clock-faced propeller-pitch indicator.
// The eye is the framework's default (canopy y + 0.16, z + 0.05): the 109
// hood is famously low and the airframe's glass leaves no room to raise it
// (S2's crown is 0.10 m above it), so it is stated explicitly here.

// a point on a glass section's ellipse at a fraction `f` of its half-width
function onSection(s, f, side) {
  const [z, hw, hh, y] = s;
  return [side * f * hw, y + hh * Math.sqrt(Math.max(0, 1 - f * f)), z];
}

export default defineCockpit('bf109g6', (spec, base) => {
  const c = spec.shape.canopy;
  const G = c.glass[0];
  const [S0, S1, S2, S3, S4] = G;
  const eye = [0, c.y + 0.16, c.z + 0.05];

  const bars = [];
  const bar = (a, b, t) => bars.push({ a, b, t });

  // ---- windscreen: base frame, the armour panel's two posts, side panels
  // the flat panel as planes.js builds it: 0.8 x S1 half-width, its base
  // just above S0's crown, its top just above S1's
  const pw = S1[1] * 0.8;
  const pY0 = S0[3] + S0[2] * 0.95 + 0.005;
  const pY1 = S1[3] + S1[2] * 1.0;
  const zb = S0[0] - 0.01;
  const zt = S1[0] + 0.02;
  bar([pw, pY0 - 0.005, zb], [-pw, pY0 - 0.005, zb], 0.03); // base frame
  bar([pw, pY0, zb], [pw * 0.92, pY1, zt], 0.028); // left post
  bar([-pw, pY0, zb], [-pw * 0.92, pY1, zt], 0.028); // right post
  bar([pw * 0.92, pY1, zt], [-pw * 0.92, pY1, zt], 0.026); // top frame
  // the side panels' lower frames, from the posts down to the sills
  const sillY = S1[3] - S1[2] * 0.72;
  for (const sg of [1, -1]) {
    bar([sg * pw, pY0 - 0.01, zb], [sg * S1[1] * 0.97, sillY, S1[0]], 0.026);
  }

  // ---- the hood: roof rails along the roof pane's edges, bow to rear frame
  const RF = 0.5;
  for (const sg of [1, -1]) {
    const a = onSection(S1, RF, sg);
    const m = onSection(S2, RF, sg);
    const b = onSection(S3, RF, sg);
    bar(a, m, 0.018);
    bar(m, b, 0.018);
    // the fixed rear glazing's upper frame, down to the spine
    bar(b, onSection(S4, RF, sg), 0.022);
  }
  // the hood's starboard hinges (pilot's right, -X) on the sill, and the
  // locking lever on the port sill
  for (const z of [0.95, 0.15]) bar([-S2[1] * 0.97, sillY + 0.02, z + 0.04], [-S2[1] * 0.97, sillY + 0.02, z - 0.04], 0.04);
  bar([S2[1] * 0.9, sillY + 0.03, 0.62], [S2[1] * 0.82, sillY + 0.09, 0.66], 0.018);

  // ---- the head armour: a curved 8 mm plate hung from the hood roof,
  // behind the head (the airframe's pilot head sits at z ~0.41, r 0.125),
  // built as stacked strips that follow the hood's curve
  const hz = 0.24;
  const hs = [0.0, 0.04, 0.08, 0.12, 0.16];
  for (const dy of hs) {
    const y = c.y + 0.04 + dy;
    // half-width the glass leaves at this height (S2/S3 blend), less a margin
    const hw = 0.3;
    const hh = 0.24;
    const yc = 0.625;
    const k = Math.min(1, Math.abs(y - yc) / hh);
    const x = Math.min(0.17, hw * Math.sqrt(1 - k * k) - 0.05);
    bar([x, y, hz + dy * 0.15], [-x, y, hz + dy * 0.15], 0.045);
  }

  // ---- the MG 131 breech fairings, either side of the sight on the coaming
  for (const sg of [1, -1]) bar([sg * 0.125, 0.664, 1.3], [sg * 0.125, 0.664, 1.07], 0.05);
  // the Revi's leather crash pad on the back of the sight body
  bar([0, 0.695, 0.976], [0, 0.695, 0.95], 0.05);

  return {
    eye,
    canopy: {
      arches: [
        // hood front bow (the windscreen's rear frame)
        { z: S1[0], hw: S1[1], hh: S1[2], y: S1[3], t: 0.034, from: -0.3, to: Math.PI + 0.3 },
        // hood rear frame, behind the head armour
        { z: S3[0], hw: S3[1], hh: S3[2], y: S3[3], t: 0.034, from: -0.3, to: Math.PI + 0.3 },
        // the rear glazing's last frame on the spine
        { z: S4[0] + 0.03, hw: S4[1], hh: S4[2], y: S4[3], t: 0.028, from: -0.2, to: Math.PI + 0.2 },
      ],
      bars,
      // the hood's sill rails (it sits on them, hinged on the starboard one)
      sills: { y: sillY, hw: S1[1] * 0.97, z0: S0[0] - 0.05, z1: S4[0] + 0.05, t: 0.05 },
    },
    panel: {
      z: 0.98,
      y: 0.47,
      w: 0.52,
      h: 0.3,
      tilt: 0.08,
      instruments: [
        // flight group (the shock-mounted upper panel)
        { kind: 'ias', u: -0.16, v: 0.075, r: 0.04 },
        { kind: 'alt', u: -0.16, v: -0.02, r: 0.04 },
        { kind: 'turn', u: 0, v: 0.06, r: 0.036 },
        { kind: 'compass', u: 0, v: -0.035, r: 0.038 },
        // engine: supercharger pressure (ATA) over the tachometer
        { kind: 'boost', u: 0.16, v: 0.075, r: 0.04 },
        { kind: 'tach', u: 0.16, v: -0.02, r: 0.04 },
        // lower row: prop-pitch clock, twin thermometer, fuel contents
        { kind: 'clock', u: -0.205, v: -0.115, r: 0.026 },
        { kind: 'temp', u: -0.08, v: -0.115, r: 0.028 },
        { kind: 'fuel', u: 0.08, v: -0.115, r: 0.028 },
      ],
    },
    // a shallow lip over the panel; the 109 has no deep glare shield
    coaming: { z: 1.0, y: 0.655, w: 0.54, h: 0.03, d: 0.06 },
    gunsight: {
      type: 'revi',
      // the Revi 16B on the centreline above the panel, close behind the
      // armour glass; its combining glass tops out just under the eye line
      pos: [0, 0.695, 1.05],
      size: [0.075, 0.06, 0.15],
      glassH: 0.035,
    },
    stick: { pos: [0, 0.28, 0.8], len: 0.27 },
    // throttle quadrant on the port (left, +X) cockpit wall
    throttle: { pos: [0.27, 0.46, 0.62] },
    // RLM 66 Schwarzgrau interior, panel and coaming
    colors: {
      panel: 0x2b2d2c,
      frame: 0x3a3d3c,
      sill: 0x33363a,
      coaming: 0x262829,
      sight: 0x2d2f2e,
      stick: 0x1c1c1b,
    },
  };
});
