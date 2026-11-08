import { defineCockpit } from './registry.js';

// COCKPIT: Supermarine Spitfire Mk Vb (framed windscreen with a flat
// bullet-resistant front panel, blown sliding hood, Barr & Stroud GM.2
// reflector sight).
//
// Body frame: +Z nose, +Y up, +X the pilot's LEFT; panel u / v are to the
// pilot's RIGHT / up. Every frame member is laid on the spec's own glass
// sections (planes.js spitfire.shape.canopy: canopy y 0.50; windscreen base
// z 0.95 half-height 0.11; windscreen rear / hood front z 0.62 at half-width
// 0.34, half-height 0.26; hood rear z -0.30 at 0.35 / 0.27; fixed rear
// glazing to z -1.05 at 0.22 / 0.14), so the frame lines up with the
// airframe and nothing outside changes.
//
// What makes it a Mk V from the seat:
//   - a NARROW flat armoured front panel between two posts, flat side panels
//     either side and one stout frame at the rear of the windscreen; the
//     posts stand about 12 degrees either side of the sight line;
//   - the rear-view mirror on top of the windscreen frame and the hood's
//     jettison knob at the top of its front bow;
//   - the sliding hood itself has no overhead frame: front bow, rear bow,
//     rails on the sills; behind the head the shaped head-armour plate, and
//     behind that the frame of the fixed rear glazing;
//   - the GM.2 on its bracket above the middle of the panel, its reflector
//     glass across the eye line, the range / span rings under the body;
//   - the panel: the RAF blind-flying panel ("basic six") in the middle
//     (A.S.I., artificial horizon, rate of climb over altimeter, direction
//     indicator, turn and slip), boost gauge to the left, rev counter top
//     right with the radiator / oil temperature and fuel contents gauges
//     below it, the P.8 compass low in the middle; the panel is matt black on
//     a grey-green (RAF cockpit interior) frame, with a short coaming so the
//     top row reads under its lip;
//   - the spade-grip (ring) control column between the knees, the throttle
//     quadrant on the port side, the drop-down access door in the port side
//     with its crowbar clipped to it.
// The eye is the framework's default (canopy y + 0.16, z + 0.05 = 0, 0.66,
// 0.10), 0.143 m ahead of the head sphere and about 0.11 m under the hood
// top; stated here so a later change to the default cannot move the pilot.

export default defineCockpit('spitfire', (spec) => {
  const c = spec.shape.canopy; // z 0.05, y 0.50
  const eye = [0, c.y + 0.16, c.z + 0.05];
  const cy = c.y;
  // the windscreen rear frame (the hood slides back from it)
  const ws = { z: 0.625, hw: 0.34, hh: 0.26, y: cy };
  const arcY = (x) => ws.y + ws.hh * Math.sqrt(Math.max(0, 1 - (x / ws.hw) ** 2));
  // the windscreen base, and the flat front panel's posts
  const baseZ = 0.94;
  const baseY = cy + 0.11;
  // the panel narrows to its top (base 0.33 m, top 0.21 m): from the seat
  // the two posts then stand near-vertical either side of the sight
  const postBase = 0.165;
  const postTop = 0.105;
  const postTopY = arcY(postTop) - 0.01;
  // the lower corner of the windscreen frame where it meets the sill
  const lowTh = -0.25;
  const lowX = ws.hw * Math.cos(lowTh);
  const lowY = ws.y + ws.hh * Math.sin(lowTh);
  // the shaped head-armour plate behind the head (his head sphere is at
  // z -0.04, r 0.125: the plate stands just clear of it)
  const armZ = -0.215;
  const armour = [
    [0.57, 0.15], [0.612, 0.15], [0.654, 0.142], [0.695, 0.122], [0.732, 0.08],
  ].map(([y, hw]) => ({ a: [hw, y, armZ], b: [-hw, y, armZ], t: 0.046 }));
  // the spade grip
  const stick = { pos: [0, 0.065, 0.32], len: 0.28 };
  const ringY = stick.pos[1] + stick.len + 0.045;
  const ringZ = stick.pos[2] - 0.045;
  return {
    eye,
    canopy: {
      arches: [
        // windscreen rear frame (the closed hood's front bow sits right
        // behind it and reads as the same member from the seat)
        { z: ws.z, hw: ws.hw, hh: ws.hh, y: ws.y, t: 0.03, from: lowTh, to: Math.PI - lowTh },
        // the sliding hood's rear bow, behind the head
        { z: -0.30, hw: 0.35, hh: 0.27, y: cy, t: 0.03, from: -0.25, to: Math.PI + 0.25 },
        // the fixed rear glazing's frame
        { z: -1.02, hw: 0.215, hh: 0.135, y: cy, t: 0.028, from: -0.3, to: Math.PI + 0.3 },
        // the spade grip's ring, facing the pilot
        { z: ringZ, hw: 0.056, hh: 0.05, y: ringY, t: 0.017, from: 0, to: Math.PI * 2 },
      ],
      bars: [
        // the flat armoured front panel: two posts, the base
        { a: [postBase, baseY, baseZ], b: [postTop, postTopY, ws.z + 0.01], t: 0.026 },
        { a: [-postBase, baseY, baseZ], b: [-postTop, postTopY, ws.z + 0.01], t: 0.026 },
        { a: [postBase + 0.01, baseY - 0.005, baseZ], b: [-postBase - 0.01, baseY - 0.005, baseZ], t: 0.03 },
        // the flat side panels' lower frames, down to the sills
        { a: [postBase, baseY - 0.005, baseZ], b: [lowX, lowY, ws.z + 0.005], t: 0.026 },
        { a: [-postBase, baseY - 0.005, baseZ], b: [-lowX, lowY, ws.z + 0.005], t: 0.026 },
        // rear-view mirror on top of the windscreen frame: stalk and glass
        { a: [0, arcY(0) + 0.01, ws.z + 0.01], b: [0, arcY(0) + 0.045, ws.z + 0.03], t: 0.014 },
        { a: [0.075, arcY(0) + 0.055, ws.z + 0.03], b: [-0.075, arcY(0) + 0.055, ws.z + 0.03], t: 0.032 },
        // hood jettison knob at the top of the front bow
        { a: [0, cy + 0.262, 0.575], b: [0, cy + 0.245, 0.555], t: 0.026 },
        // head armour
        ...armour,
        // GM.2 range / span rings under the sight body
        { a: [0.045, 0.548, 0.47], b: [0.07, 0.548, 0.47], t: 0.026 },
        { a: [-0.045, 0.548, 0.47], b: [-0.07, 0.548, 0.47], t: 0.026 },
        // the sight's rubber crash pad on its rear face
        { a: [0, 0.58, 0.418], b: [0, 0.58, 0.405], t: 0.036 },
        // port (+X) drop-down door: front and rear edges, crowbar on it
        { a: [0.333, 0.31, 0.34], b: [0.333, 0.1, 0.34], t: 0.02 },
        { a: [0.333, 0.31, -0.24], b: [0.333, 0.1, -0.24], t: 0.02 },
        { a: [0.318, 0.235, 0.27], b: [0.318, 0.215, -0.16], t: 0.02 },
      ],
      // the hood's rails along both sills
      sills: { y: 0.318, hw: 0.335, z0: 0.62, z1: -0.82, t: 0.045 },
    },
    panel: {
      z: 0.5,
      y: 0.35,
      w: 0.56,
      h: 0.3,
      tilt: 0.1,
      instruments: [
        // blind-flying panel
        { kind: 'ias', u: -0.105, v: 0.065, r: 0.036 },
        { kind: 'ah', u: 0, v: 0.065, r: 0.04 },
        { kind: 'vsi', u: 0.105, v: 0.065, r: 0.036 },
        { kind: 'alt', u: -0.105, v: -0.035, r: 0.036 },
        { kind: 'compass', u: 0, v: -0.035, r: 0.036 },
        { kind: 'turn', u: 0.105, v: -0.035, r: 0.036 },
        // port side of the panel: clock, boost
        { kind: 'clock', u: -0.225, v: 0.085, r: 0.022 },
        { kind: 'boost', u: -0.215, v: -0.055, r: 0.032 },
        // starboard: rev counter, radiator and oil temperatures, fuel contents
        { kind: 'tach', u: 0.215, v: 0.065, r: 0.033 },
        { kind: 'temp', u: 0.195, v: -0.045, r: 0.022 },
        { kind: 'temp', u: 0.25, v: -0.045, r: 0.02 },
        { kind: 'fuel', u: 0.222, v: -0.11, r: 0.022 },
        // the P.8 compass, low in the middle
        { kind: 'compass', u: 0, v: -0.115, r: 0.03 },
      ],
    },
    // short glare shield: the top row of dials shows under its lip
    coaming: { z: 0.53, y: 0.535, w: 0.6, h: 0.04, d: 0.08 },
    gunsight: {
      type: 'gm2',
      // on its bracket over the panel, the reflector glass across the eye line
      pos: [0, 0.585, 0.5],
      size: [0.075, 0.065, 0.17],
      glassH: 0.08,
    },
    stick,
    throttle: { pos: [0.29, 0.3, 0.28] },
    colors: {
      panel: 0x161716,
      frame: 0x6a7160,
      sill: 0x5c6353,
      coaming: 0x1a1b19,
      sight: 0x262725,
      stick: 0x1c1b18,
    },
  };
});
