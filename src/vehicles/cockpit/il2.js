import { defineCockpit } from './registry.js';

// COCKPIT: Il-2M3 Sturmovik (two-seat, 1943-44 series), pilot's station.
//
// Body frame: +Z nose, +Y up, +X the pilot's LEFT; panel u / v are to the
// pilot's RIGHT / up. Every number is laid against the spec's own glass
// (planes.js il2.shape.canopy): the windscreen is the loft from z 2.15
// (half-width 0.18, half-height 0.10 about y 0.86) back to z 1.80, with the
// flat armour-glass roof planes.js lays over it; the sliding hood runs
// 1.80 -> 1.05; the fixed rear fairing 1.05 -> 0.55; then solid decking to
// the gunner. The armoured shell's top edge — the real sill, high at the
// pilot's shoulder — is at y ~0.72 with x ~0.41 here (fuselage superellipse
// n 4.6 at z 1.85), so the frame stands on THAT, not on the glass loft's
// buried lower rail.
//
// What makes it an Il-2 from the seat:
//   - a small, deep FRONT PANEL of 64 mm bullet-resistant glass in a heavy
//     frame, flat side quarters, and a flat armoured roof over the windscreen;
//   - a heavily framed sliding hood: bows front and rear, a vertical frame
//     splitting each side window, and two roof stringers; armour plates make
//     the sides high (the hull walls come up to the shoulder);
//   - behind the head the armour bulkhead with its armoured HEADREST
//     (late-series aircraft replaced the early rear armour glass by steel);
//   - the PBP-1b reflector sight on the coaming, plus the VV-1 mechanical
//     sight's front post on the cowl top ahead of the windscreen (the VV-1's
//     rear element was painted marks on the armour glass — not modelled);
//   - a wide black panel, flight group on the left (clock, airspeed
//     US-700 km/h, altimeter VD-10 m, turn-and-slip, rate of climb VAR-30),
//     compass low centre, engine group on the right (tachometer, boost,
//     water and oil temperatures, fuel). No gyro horizon: series Il-2s were
//     day attackers without one (stated with medium confidence).
//   - throttle quadrant on the left wall, the control column with the gun
//     triggers on its grip.
// The eye is the framework default (canopy y + 0.16, z + 0.05 = 0.82 / 1.25),
// stated explicitly so a later change of the default cannot move the pilot:
// ~0.10 m above the cowl line at z 3.0 (about 3 degrees of over-nose view,
// the type's notoriously poor forward-down view) and clear of the head
// sphere planes.js puts at (0, 0.79, 1.11).

// stacked thin bars standing in for a plate (the framework has no plate
// primitive for aircraft): rows from y0 to y1 at depth z, half-width per row
function plate(out, { y0, y1, z, hw, t, taper = 0 }) {
  const n = Math.max(1, Math.round((y1 - y0) / t));
  for (let i = 0; i < n; i++) {
    const y = y0 + (i + 0.5) * ((y1 - y0) / n);
    const f = (y - y0) / Math.max(1e-6, y1 - y0);
    const w = hw * (1 - taper * f * f);
    out.push({ a: [w, y, z], b: [-w, y, z], t });
  }
}

export default defineCockpit('il2', (spec, base) => {
  const c = spec.shape.canopy; // z 1.20, y 0.66
  const eye = [0, c.y + 0.16, c.z + 0.05];

  // the windscreen front panel (armour glass) and the hood front bow
  const front = { z: 2.12, hw: 0.17, y0: 0.775, y1: 0.952 };
  const sillY = 0.72;
  const sillHW = 0.41;
  const roofY = 0.962; // planes.js's flat armour roof, underside
  const roofHW = 0.34;
  const bowZ = 1.8;
  const rearZ = 1.05;
  const stringerX = 0.2;
  const stringerY = 0.912;

  const bars = [
    // the 64 mm front panel's heavy frame
    { a: [front.hw, front.y0, front.z], b: [-front.hw, front.y0, front.z], t: 0.04 },
    { a: [front.hw, front.y1, front.z], b: [-front.hw, front.y1, front.z], t: 0.036 },
    { a: [front.hw, front.y0, front.z], b: [front.hw, front.y1, front.z], t: 0.04 },
    { a: [-front.hw, front.y0, front.z], b: [-front.hw, front.y1, front.z], t: 0.04 },
    // the side quarters: roof edges and lower frames back to the hood bow
    { a: [front.hw, front.y1, front.z], b: [roofHW, roofY - 0.012, bowZ + 0.01], t: 0.03 },
    { a: [-front.hw, front.y1, front.z], b: [-roofHW, roofY - 0.012, bowZ + 0.01], t: 0.03 },
    { a: [front.hw, front.y0, front.z], b: [sillHW, sillY + 0.02, bowZ + 0.01], t: 0.032 },
    { a: [-front.hw, front.y0, front.z], b: [-sillHW, sillY + 0.02, bowZ + 0.01], t: 0.032 },
    // the windscreen's own base on the armour shell
    { a: [front.hw + 0.02, front.y0 - 0.03, front.z + 0.01], b: [-front.hw - 0.02, front.y0 - 0.03, front.z + 0.01], t: 0.03 },
    // the sliding hood's two roof stringers
    { a: [stringerX, stringerY, bowZ], b: [stringerX, stringerY, rearZ], t: 0.024 },
    { a: [-stringerX, stringerY, bowZ], b: [-stringerX, stringerY, rearZ], t: 0.024 },
    // the hood's lower side rails (its armour side plates' top edge)
    { a: [sillHW - 0.01, sillY + 0.05, bowZ], b: [sillHW - 0.03, sillY + 0.05, rearZ], t: 0.026 },
    { a: [-sillHW + 0.01, sillY + 0.05, bowZ], b: [-sillHW + 0.03, sillY + 0.05, rearZ], t: 0.026 },
    // VV-1 front post on the cowl top (cowl skin ~0.736 at z 2.55)
    { a: [0, 0.735, 2.58], b: [0, 0.735, 2.5], t: 0.018 },
    { a: [0, 0.735, 2.55], b: [0, 0.8, 2.55], t: 0.01 },
  ];
  // the armour bulkhead behind the head and its headrest (13 mm plate),
  // narrowing to the hood's curve at the top; clear of the head sphere's
  // back (z 0.985)
  plate(bars, { y0: 0.62, y1: 0.8, z: 0.955, hw: 0.3, t: 0.03 });
  plate(bars, { y0: 0.8, y1: 0.92, z: 0.955, hw: 0.17, t: 0.03, taper: 0.35 });

  // a hoop clipped to the part above the sill
  const hoop = (z, y, hw, hh, t, from, to) => ({ z, y, hw, hh, t, from, to });
  const above = (y, hh) => Math.asin(Math.max(-1, Math.min(1, (sillY - y) / hh)));
  // the glass section at the mid-hood frame (interpolated 1.80 -> 1.05)
  const mid = { z: 1.42, y: 0.65, hw: 0.45 * 0.98, hh: 0.31 * 0.98 };
  const midTop = Math.acos(stringerX / mid.hw);
  return {
    eye,
    canopy: {
      arches: [
        // hood front bow (the windscreen's rear frame)
        hoop(bowZ, 0.66, 0.44 * 0.98, 0.3 * 0.98, 0.036, above(0.66, 0.294), Math.PI - above(0.66, 0.294)),
        // the vertical frame splitting each hood side window, sill to stringer
        hoop(mid.z, mid.y, mid.hw, mid.hh, 0.028, above(mid.y, mid.hh), midTop),
        hoop(mid.z, mid.y, mid.hw, mid.hh, 0.028, Math.PI - midTop, Math.PI - above(mid.y, mid.hh)),
        // hood rear bow
        hoop(rearZ, 0.64, 0.46 * 0.98, 0.32 * 0.98, 0.036, above(0.64, 0.314), Math.PI - above(0.64, 0.314)),
        // the fixed rear fairing's aft frame, where the decking starts
        hoop(0.57, 0.62, 0.4 * 0.97, 0.26 * 0.97, 0.03, 0.05, Math.PI - 0.05),
      ],
      bars,
      // the armoured shell's top edge either side of the pilot
      sills: { y: sillY, hw: sillHW, z0: 2.05, z1: 0.95, t: 0.05 },
    },
    panel: {
      z: 1.66,
      y: 0.52,
      w: 0.64,
      h: 0.3,
      tilt: 0.08,
      instruments: [
        // flight group, pilot's left
        { kind: 'clock', u: -0.28, v: 0.11, r: 0.022 },
        { kind: 'ias', u: -0.2, v: 0.09, r: 0.04 },
        { kind: 'alt', u: -0.09, v: 0.09, r: 0.04 },
        { kind: 'turn', u: 0.02, v: 0.095, r: 0.034 },
        { kind: 'vsi', u: -0.2, v: -0.015, r: 0.034 },
        { kind: 'compass', u: -0.06, v: -0.03, r: 0.036 },
        // engine group, pilot's right
        { kind: 'tach', u: 0.12, v: 0.09, r: 0.038 },
        { kind: 'boost', u: 0.23, v: 0.09, r: 0.034 },
        { kind: 'temp', u: 0.08, v: -0.025, r: 0.026 },
        { kind: 'temp', u: 0.16, v: -0.025, r: 0.026 },
        { kind: 'fuel', u: 0.25, v: -0.025, r: 0.026 },
      ],
    },
    // a short coaming: its lip at y 0.70 leaves the top row of dials in view
    coaming: { z: 1.67, y: 0.72, w: 0.66, h: 0.04, d: 0.16 },
    gunsight: {
      type: 'pbp',
      // PBP-1b on the coaming, its glass straddling the eye line (0.82)
      pos: [0, 0.77, 1.72],
      size: [0.085, 0.06, 0.17],
      glassH: 0.085,
    },
    stick: { pos: [0, 0.3, 1.47], len: 0.33 },
    // throttle quadrant on the left wall (+X)
    throttle: { pos: [0.3, 0.6, 1.32] },
    colors: {
      panel: 0x1c1d1b,
      frame: 0x6a6f66,
      sill: 0x55594f,
      coaming: 0x191a18,
      sight: 0x2b2d2a,
      stick: 0x1a1a18,
    },
  };
});
