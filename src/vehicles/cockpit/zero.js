import { defineCockpit } from './registry.js';

// COCKPIT: Mitsubishi A6M2 Model 21 "Zero" (greenhouse canopy, Type 98
// reflector sight, two Type 97 7.7 mm guns firing over the nose).
//
// Body frame: +Z nose, +Y up, +X the pilot's LEFT; panel u / v are to the
// pilot's RIGHT / up. Every canopy number is taken from the spec's own glass
// sections (planes.js zero.shape.canopy, [z, halfWidth, halfHeight, yCentre]):
//   1.70 (.20 .13 .50)  windscreen base on the cowl
//   1.30 (.38 .30 .50)  windscreen rear bow / sliding hood front
//   0.30 (.40 .32 .50)  sliding hood rear bow, just behind the head
//  -0.55 (.38 .29 .50)  fixed rear glazing, main hoop
//  -1.30 (.26 .18 .48)  end of the glazing, into the turtledeck
// so the frame drawn here sits on the airframe's own glass.
//
// What makes it an A6M2 from the seat:
//   - the windscreen: a FLAT front panel between two posts and two curved
//     quarter panels, plain glass (the A6M2 carried no armour glass, no armour
//     plate and no armoured headrest — those came with the A6M5 Hei);
//   - the long greenhouse: the sliding hood has a side frame at mid-length and
//     a horizontal rail along each side (four panes a side), clear overhead
//     between its bows; the fixed rear glazing repeats the pattern aft;
//   - the Type 98 reflector sight (a tubular body on the coaming, its
//     combining glass on the eye line) on the centreline, with the breeches
//     and charging handles of the two cowl guns poking into the cockpit
//     either side of it, over the top of the panel;
//   - the panel: navigation group on the left (directional gyro, clock and
//     airspeed on top; climb and altimeter under them), turn-and-slip over the
//     gyro horizon in the middle, engine group on the right (tachometer, boost,
//     temperature), the small horizontal board below with fuel and oil temp.
//     Needles read knots and metres (cockpit/index.js UNITS.Japan).
//   - the pilot sat high on an adjustable seat with low sills: the default
//     eye (canopy y + 0.16, z + 0.05 = [0, 0.66, 0.35], measured clear of the
//     airframe by planeCamera.js) is kept and stated explicitly.

// the spec's glass sections, interpolated linearly between stations
function glassAt(c, z) {
  const g = c.glass[0];
  if (z >= g[0][0]) return { hw: g[0][1], hh: g[0][2], y: g[0][3] != null ? g[0][3] : c.y };
  for (let i = 0; i < g.length - 1; i++) {
    const a = g[i];
    const b = g[i + 1];
    if (z <= a[0] && z >= b[0]) {
      const t = (a[0] - z) / (a[0] - b[0]);
      const ay = a[3] != null ? a[3] : c.y;
      const by = b[3] != null ? b[3] : c.y;
      return { hw: a[1] + (b[1] - a[1]) * t, hh: a[2] + (b[2] - a[2]) * t, y: ay + (by - ay) * t };
    }
  }
  const l = g[g.length - 1];
  return { hw: l[1], hh: l[2], y: l[3] != null ? l[3] : c.y };
}

export default defineCockpit('zero', (spec) => {
  const c = spec.shape.canopy; // z 0.30, y 0.50
  const eye = [0, c.y + 0.16, c.z + 0.05];
  // a point on the glass at station z, angle th (0 = the pilot's left side,
  // PI/2 = overhead), pulled 1 cm inside the glass
  const on = (z, th, x = null) => {
    const s = glassAt(c, z);
    const k = 0.985;
    if (x != null) {
      const ct = Math.max(-1, Math.min(1, x / (s.hw * k)));
      return [x, s.y + s.hh * k * Math.sqrt(1 - ct * ct), z];
    }
    return [Math.cos(th) * s.hw * k, s.y + Math.sin(th) * s.hh * k, z];
  };
  const hoop = (z, t, from = -0.35, to = Math.PI + 0.35) => {
    const s = glassAt(c, z);
    return { z, hw: s.hw * 0.985, hh: s.hh * 0.985, y: s.y, t, from, to };
  };
  // side-only frames (the top stays clear): left and right halves
  const sides = (z, t, up = 0.78) => [hoop(z, t, -0.35, up), hoop(z, t, Math.PI - up, Math.PI + 0.35)];

  const zScreen = 1.70;
  const zBow = 1.28;
  // the horizontal side rail, at about shoulder-to-eye height
  const RAIL = 0.42;
  const railZ = [zBow, 0.8, 0.3, -0.15, -0.55, -0.95, -1.28];
  const bars = [];
  for (const sg of [1, -1]) {
    const th = sg > 0 ? RAIL : Math.PI - RAIL;
    for (let i = 0; i < railZ.length - 1; i++) {
      bars.push({ a: on(railZ[i], th), b: on(railZ[i + 1], th), t: 0.022 });
    }
    // the flat front panel's posts, base to bow
    bars.push({ a: on(zScreen - 0.01, 0, sg * 0.105), b: on(zBow + 0.01, 0, sg * 0.17), t: 0.026 });
  }

  // the two Type 97 7.7 mm guns lie on the upper cowling either side of the
  // centreline; their receivers come back through the firewall over the panel
  // top, each with a charging handle (drawn as frame bars: the cockpit
  // framework has no free-form "extras" for aircraft)
  for (const sg of [1, -1]) {
    const x = sg * 0.135;
    bars.push({ a: [x, 0.605, 0.92], b: [x, 0.605, 0.68], t: 0.05 }); // receiver
    bars.push({ a: [x, 0.637, 0.86], b: [x, 0.637, 0.7], t: 0.022 }); // feed cover
    bars.push({ a: [x + sg * 0.03, 0.61, 0.74], b: [x + sg * 0.045, 0.645, 0.65], t: 0.014 }); // handle lever
    bars.push({ a: [x + sg * 0.025, 0.645, 0.65], b: [x + sg * 0.065, 0.645, 0.65], t: 0.018 }); // T grip
  }

  return {
    eye,
    canopy: {
      arches: [
        // windscreen base on the cowl decking
        hoop(zScreen, 0.03, -0.25, Math.PI + 0.25),
        // windscreen rear bow and the sliding hood's front bow, side by side
        hoop(zBow, 0.042),
        // the sliding hood's mid frame, sides only
        ...sides(0.8, 0.024),
        // the sliding hood's rear bow behind the head
        hoop(0.3, 0.036),
        // the fixed rear glazing
        ...sides(-0.15, 0.022),
        hoop(-0.55, 0.03),
        ...sides(-0.95, 0.022, 0.9),
        hoop(-1.28, 0.03),
      ],
      bars,
      // the cockpit sills: low, the Zero's pilot sat high in a narrow cockpit
      sills: { y: 0.3, hw: 0.36, z0: 1.28, z1: -0.85, t: 0.04 },
    },
    panel: {
      z: 0.78,
      y: 0.43,
      w: 0.5,
      h: 0.3,
      tilt: 0.12,
      instruments: [
        // left: navigation group
        { kind: 'compass', u: -0.212, v: 0.088, r: 0.027 },
        { kind: 'clock', u: -0.155, v: 0.105, r: 0.018 },
        { kind: 'ias', u: -0.095, v: 0.075, r: 0.038 },
        { kind: 'vsi', u: -0.205, v: -0.015, r: 0.03 },
        { kind: 'alt', u: -0.12, v: -0.022, r: 0.036 },
        // centre: turn-and-slip over the gyro horizon
        { kind: 'turn', u: 0, v: 0.088, r: 0.033 },
        { kind: 'ah', u: 0, v: -0.012, r: 0.038 },
        // right: engine group
        { kind: 'tach', u: 0.097, v: 0.075, r: 0.038 },
        { kind: 'boost', u: 0.19, v: 0.085, r: 0.03 },
        { kind: 'temp', u: 0.12, v: -0.022, r: 0.027 },
        // the horizontal board under the panel: fuel, and a second temperature
        { kind: 'fuel', u: -0.05, v: -0.11, r: 0.025 },
        { kind: 'temp', u: 0.05, v: -0.11, r: 0.025 },
      ],
    },
    // a padded coaming over the panel, between the gun receivers
    coaming: { z: 0.8, y: 0.6, w: 0.52, h: 0.04, d: 0.12 },
    gunsight: {
      type: 'type98',
      // the tubular sight body on the coaming centreline; its combining glass
      // spans the eye line (0.66)
      pos: [0, 0.625, 0.78],
      size: [0.06, 0.04, 0.16],
      glassH: 0.075,
    },
    // the stick between the knees, grip about lap height
    stick: { pos: [0, 0.07, 0.58], len: 0.3 },
    // throttle quadrant on the left console (the gun trigger was on it)
    throttle: { pos: [0.3, 0.3, 0.42] },
    colors: {
      // black panel, "Mitsubishi cockpit green" sills and frames
      panel: 0x1d1e1a,
      frame: 0x4f5139,
      sill: 0x646440,
      coaming: 0x1a1a16,
      sight: 0x2a2b27,
      stick: 0x22221d,
    },
  };
});
