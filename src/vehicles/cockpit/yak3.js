import { defineCockpit } from './registry.js';

// COCKPIT: Yakovlev Yak-3 (1944, VK-105PF-2) — the all-round-vision hood.
//
// Body frame: +Z nose, +Y up, +X the pilot's LEFT; panel u / v are to the
// pilot's RIGHT / up. Numbers are tied to the spec's own glass sections
// (planes.js yak3.shape.canopy, z 0.20 / y 0.53):
//   [1.05, hw .19, hh .09, y .57]  windscreen base
//   [0.75, hw .32, hh .21, y .55]  windscreen rear bow / sliding hood front
//   [0.20, hw .35, hh .25, y .53]  over the pilot (no frame here)
//   [-0.40, hw .32, hh .22, y .51] hood rear bow, start of the fixed fairing
//   [-0.95, hw .16, hh .08, y .43] the fixed rear glazing ends on the deck
//
// What makes it a Yak-3 from the seat:
//   - the windscreen: one-piece and FRAMELESS (airpages.ru Yak-3 page), so
//     nothing but its seating strip and the bow at its rear edge; NO thick
//     armour-glass block inside it (the Yak-1B and Yak-9 carried one);
//   - the sliding hood: one bow at its front, one at its rear, nothing
//     overhead; behind it the low fixed glazing over the cut-down deck;
//   - behind the head: the armoured back cut down to the shoulders and a
//     small (reduced-size) armoured glass above it at head height, framed
//     (the Yak-3 VK-108 later deleted this rear bulletproof glass);
//   - the PBP-1B collimator sight on the centre line above the panel, its
//     tilted combining glass at the rear end, the eye looking through it;
//   - a small, plain panel without an artificial horizon: flight group on
//     top (US-700 airspeed, UP-2 turn-and-slip, VD-10 altimeter), VAR
//     rate-of-climb and KI compass in the middle with the clock, engine
//     group below (boost manometer, TE tachometer, coolant/oil thermometer,
//     fuel). The panel layout is an approximation from period photos; the
//     dial set itself is the standard Soviet 1944 fit.
//   - the throttle on the pilot's LEFT sill (+X), the stick in the middle.
// The eye stays at the framework default (canopy y + 0.16, z + 0.05), which
// planeCamera.js measured clear of the airframe; stated explicitly so a later
// change to the default cannot move the Yak pilot.

export default defineCockpit('yak3', (spec) => {
  const c = spec.shape.canopy; // z 0.20, y 0.53
  const eye = [0, c.y + 0.16, c.z + 0.05]; // [0, 0.69, 0.25]
  const g = c.glass[0];
  const ws = { z: g[0][0], hw: g[0][1], hh: g[0][2], y: g[0][3] }; // windscreen base section
  const bow = { z: g[1][0], hw: g[1][1], hh: g[1][2], y: g[1][3] }; // its rear bow
  const rear = { z: g[3][0], hw: g[3][1], hh: g[3][2], y: g[3][3] }; // hood rear bow
  const tail = { z: g[4][0], hw: g[4][1], hh: g[4][2], y: g[4][3] }; // fixed glazing end
  // the windscreen base line on the deck
  const baseY = ws.y - ws.hh * 0.55;
  const baseZ = ws.z - 0.02;
  // the hood's sill rails
  const sillY = bow.y - bow.hh * 0.72;
  const sillHW = bow.hw * 0.96;
  // behind the head: armoured back to shoulder height, small armour glass above
  const armZ = c.z - 0.24; // -0.04
  const shoulderY = eye[1] - 0.26; // 0.43
  // the armour glass reaches above the eye line (head height), inside the
  // hood: hood top here is ~0.76, half-width at 0.73 ~0.16
  const glassTop = eye[1] + 0.04; // 0.73
  const glassBot = shoulderY + 0.04; // 0.47
  const glassHW = 0.13;
  const bars = [
    // windscreen: ONE-PIECE, FRAMELESS curved Plexiglas (no posts, no top
    // rail) — only its seating strip on the deck and along the sides down to
    // the sills; its rear edge is the bow arch below
    { a: [ws.hw, baseY, baseZ], b: [-ws.hw, baseY, baseZ], t: 0.022 },
    { a: [ws.hw, baseY, baseZ], b: [sillHW, sillY + 0.01, bow.z], t: 0.016 },
    { a: [-ws.hw, baseY, baseZ], b: [-sillHW, sillY + 0.01, bow.z], t: 0.016 },
    // the fixed rear glazing's lower edges, hood bow to the deck
    { a: [rear.hw * 0.95, rear.y - rear.hh * 0.72, rear.z], b: [tail.hw, tail.y - tail.hh * 0.6, tail.z], t: 0.022 },
    { a: [-rear.hw * 0.95, rear.y - rear.hh * 0.72, rear.z], b: [-tail.hw, tail.y - tail.hh * 0.6, tail.z], t: 0.022 },
  ];
  // the armoured back plate (8.5 mm), cut at the shoulders: stacked slabs
  for (let i = 0; i < 4; i++) {
    const y = 0.12 + i * 0.085;
    bars.push({ a: [0.2, y, armZ], b: [-0.2, y, armZ], t: 0.085 });
  }
  // the reduced-size armoured glass above it, at head height: a thick frame
  // all round (the framework has no transparent solids, so the glass itself
  // is the clear hole the frame encloses), plus the strip it is bolted to
  // on top of the back plate
  bars.push(
    { a: [glassHW, glassBot, armZ - 0.01], b: [glassHW, glassTop, armZ - 0.02], t: 0.026 },
    { a: [-glassHW, glassBot, armZ - 0.01], b: [-glassHW, glassTop, armZ - 0.02], t: 0.026 },
    { a: [glassHW, glassTop, armZ - 0.02], b: [-glassHW, glassTop, armZ - 0.02], t: 0.026 },
    { a: [glassHW, glassBot, armZ - 0.01], b: [-glassHW, glassBot, armZ - 0.01], t: 0.03 },
    { a: [0.2, shoulderY, armZ], b: [-0.2, shoulderY, armZ], t: 0.03 },
  );
  // the gunsight's bracket, from under the sight body down to the coaming
  bars.push({ a: [0, 0.595, 0.78], b: [0, 0.56, 0.66], t: 0.03 });
  return {
    eye,
    canopy: {
      arches: [
        // windscreen rear bow with the sliding hood's front bow against it
        { z: bow.z, hw: bow.hw, hh: bow.hh, y: bow.y, t: 0.032, from: -0.35, to: Math.PI + 0.35 },
        // the hood's rear bow (it slides back over the fixed fairing)
        { z: rear.z, hw: rear.hw, hh: rear.hh, y: rear.y, t: 0.03, from: -0.4, to: Math.PI + 0.4 },
        // where the fixed rear glazing meets the deck
        { z: tail.z, hw: tail.hw, hh: tail.hh, y: tail.y, t: 0.026, from: -0.2, to: Math.PI + 0.2 },
      ],
      bars,
      // the hood rails along both sills
      sills: { y: sillY, hw: sillHW, z0: bow.z + 0.02, z1: rear.z - 0.05, t: 0.042 },
    },
    panel: {
      z: 0.66,
      y: 0.4,
      w: 0.5,
      h: 0.28,
      tilt: 0.12,
      instruments: [
        // flight group: US-700, UP-2, VD-10 (no gyro horizon on the Yak-3)
        { kind: 'ias', u: -0.15, v: 0.075, r: 0.04 },
        { kind: 'turn', u: 0, v: 0.075, r: 0.038 },
        { kind: 'alt', u: 0.15, v: 0.075, r: 0.04 },
        // clock, rate of climb, compass
        { kind: 'clock', u: -0.205, v: -0.03, r: 0.022 },
        { kind: 'vsi', u: -0.08, v: -0.03, r: 0.034 },
        { kind: 'compass', u: 0.08, v: -0.03, r: 0.034 },
        // engine group: boost, rpm, coolant/oil, fuel
        { kind: 'boost', u: -0.17, v: -0.11, r: 0.028 },
        { kind: 'tach', u: -0.055, v: -0.11, r: 0.03 },
        { kind: 'temp', u: 0.06, v: -0.11, r: 0.026 },
        { kind: 'fuel', u: 0.17, v: -0.11, r: 0.024 },
      ],
    },
    // a thin lip over the panel, shallow so the top row shows under it
    coaming: { z: 0.645, y: 0.555, w: 0.5, h: 0.04, d: 0.05 },
    gunsight: {
      type: 'pbp',
      // PBP-1B on the centre line; the pilot looks THROUGH its combining
      // glass. Glass frame (index.js: x +-size.x*0.525, y from pos.y+size.y/2
      // to +glassH, at z pos.z-0.3*size.z = 0.74, 0.49 m from the eye):
      // y 0.65..0.735 = -4.7..+5.1 deg, x +-4.6 deg — the 3.2 deg lead ring
      // (reflectorRingMrad at 800 m/s) fits inside with margin
      pos: [0, 0.62, 0.8],
      size: [0.076, 0.06, 0.2],
      glassH: 0.085,
    },
    // the stick grip at chest height, well below the sightline
    stick: { pos: [0, 0.14, 0.44], len: 0.3 },
    // the throttle box on the LEFT sill
    throttle: { pos: [0.27, 0.4, 0.3] },
    // Soviet cockpit: grey-green (A-14 style) interior, black panel
    colors: { panel: 0x1e201d, frame: 0x6d7466, sill: 0x5b6356, coaming: 0x262823, sight: 0x2e302c },
  };
});
