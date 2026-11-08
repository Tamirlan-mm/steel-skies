import { defineTankInterior } from './registry.js';
import { gunnerPeriscope } from './stations.js';

// IS-2 (1944, "straightened" nose), 122 mm D-25T, crew of four.
//
// Sources: Russian Wikipedia "ИС-2" (crew layout, vision devices, breech,
// stowage, radio); Zaloga, "IS-2 Heavy Tank 1944-73" (dimensions, already
// in tanks.js). Marked *verify* where no primary figure was found.
//
// Crew (left = +X):
//   - DRIVER on the hull CENTRELINE, front. The 1944 nose dropped the old
//     plug hatch: he looks through a slit in the 120 mm upper plate via a
//     glass-block prism under a flat armoured cover. He has NO hatch of his
//     own (he gets out through the turret or the belly escape hatch).
//   - GUNNER left of the gun, ahead of and below the commander: TSh-17
//     telescopic sight beside the gun, an MK-IV periscope in the roof (the
//     early PT4-17 was replaced by it).
//   - COMMANDER left rear under the cast cupola: six vision slits with
//     protective glass blocks, an MK-IV periscope in the hatch; he also
//     works the 10-R / 10-RK radio.
//   - LOADER right of the gun, under his own hatch, MK-IV periscope ahead
//     of it. Projectiles come from the bin in the turret bustle; one charge
//     case rides on the right turret wall, the rest of the cases on the hull
//     walls (the damage model's ammoHullL/R) and the floor (ammoFloor).
// Breech: D-25T after the first ~100 guns: semi-automatic HORIZONTAL
// sliding wedge (the early guns had a piston breech). Separate loading:
// 122 mm projectile + a 785 mm case. Recoil ~0.52 m (*verify*).
//
// What this file changes over the derived defaults (stations.js):
//   - driver: centreline, slit device, no hatch; his roof hatch removed;
//   - room shapes: the turret casting sits 0.19 m aft of the ring centre
//     (zF 1.05 / zB -1.42 in tanks.js) and its walls roll in; the hull room
//     follows the real 60-degree glacis and stops at the engine firewall;
//   - commander / gunner / loader seats on their real sides (the damage
//     model's crew boxes put the commander on the right — see report);
//   - breech, radio, bustle bin, charge case, coaxial and rear DTs.

export default defineTankInterior('is2', (spec, base) => {
  const t = spec.turret; // w 2.36, h 0.80, len 2.55
  const hull = base.layout.hull;
  const cu = spec.shape.cupola; // r 0.30, h 0.21, x +0.52 (left), z -0.55
  const lh = spec.shape.loaderHatch; // x -0.50 (right), z -0.35
  const gm = spec.gunMount; // trunnions 0.95 m ahead of the ring centre
  const blockY = t.h + cu.h * 0.62;
  const roof = spec.hull.trackH + spec.hull.h; // 1.73
  const f = spec.hull.len / 2;

  // the 60-degree upper plate (tanks.js 'is2' hull): outer face z at height y
  // is f - (y - 0.95) tan60; 120 mm at 60 deg is 0.24 m measured along z
  const T60 = Math.tan(60 * Math.PI / 180);
  const glacisOuterZ = (y) => f - (y - 0.95) * T60;
  const glacisInnerZ = (y) => glacisOuterZ(y) - 0.24;

  // driver: eye under the slit, the window 0.14 m ahead of the eye and clear
  // of the sloping wall over its top edge
  const slitH = 0.035;
  const dEyeY = roof - 0.18;
  const dDist = 0.14;
  const dEyeZ = glacisInnerZ(dEyeY + slitH / 2) - dDist - 0.012;

  // breech (gun frame): rear face 0.93 m behind the trunnions
  const brPos = [0, 0, -0.62];
  const brSize = [0.44, 0.42, 0.62];
  const breechTz = gm.z + brPos[2]; // breech centre, turret frame

  // standing back against the right wall so the breech, the bustle bin and
  // the floor rack are all in reach and in view
  const lEye = [lh.x - 0.2, t.h - 0.3, lh.z];
  const gEye = [0.48, 0.45, 0.3];

  return {
    stations: {
      commander: {
        frame: 'turret',
        eye: [cu.x, blockY, cu.z],
        look: [0, 0],
        device: { type: 'blocks', count: 6, radius: cu.r * 0.92, y: blockY, w: 0.13, h: 0.045, lean: 0.12, phase: 0 },
        hatch: { eye: [cu.x, t.h + cu.h + 0.5, cu.z], fov: 70 },
        seat: [cu.x, 0.35, cu.z - 0.05],
      },
      gunner: {
        frame: 'turret',
        eye: gEye,
        device: { type: 'sight', w: 0.1, h: 0.06, dist: 0.07 },
        seat: [gEye[0], 0.0, gEye[2] - 0.2],
        // the MK-IV periscope in the roof over him (wave 7)
        vision: gunnerPeriscope(spec, gEye, { yaw: [-0.9, 0.9] }),
      },
      loader: {
        frame: 'turret',
        // right of the breech, facing it across the turret
        eye: lEye,
        look: [Math.atan2(-lEye[0], breechTz - lEye[2]), -0.42],
        device: { type: 'none' },
        hatch: { eye: [lh.x, t.h + 0.55, lh.z], fov: 70 },
        seat: [lh.x - 0.2, 0.0, lh.z - 0.2],
      },
      driver: {
        frame: 'hull',
        eye: [0, dEyeY, dEyeZ],
        look: [0, 0],
        device: { type: 'slit', w: 0.17, h: slitH, dist: dDist, bezel: 0.03, depth: 0.08 },
        hatch: null,
        seat: [0, 1.05, dEyeZ - 0.12],
      },
    },
    breech: {
      type: 'horizontal',
      pos: brPos,
      size: brSize,
      recoilLength: 0.52,
      guardLength: 1.15,
      openTravel: 0.26,
      caliber: 122,
      caseLength: 0.785,
    },
    layout: {
      hull: {
        // the fighting compartment ends at the engine firewall (rear drive)
        rearZ: hull.firewallZ,
        glacisTopZ: glacisInnerZ(roof - 0.03),
        lowFrontY: 0.95,
        frontZ: f - 0.13,
      },
      turret: { cz: -0.19, rx: 0.95, rz: 1.08 },
      // 10-RK on the left wall, ahead of the commander's seat
      radio: { frame: 'turret', pos: [0.75, 0.45, -0.1], size: [0.28, 0.3, 0.42] },
      domeLight: { frame: 'turret', pos: [-0.1, t.h - 0.08, -0.3] },
      // no driver's hatch on an IS-2
      hatches: [
        { frame: 'turret', pos: [cu.x, t.h + cu.h - 0.05, cu.z], r: cu.r * 0.86, cupola: { r: cu.r, y0: t.h - 0.04, y1: t.h + cu.h - 0.04 } },
        { frame: 'turret', pos: [lh.x, t.h - 0.04, lh.z], r: lh.r * 0.95 },
      ],
      racks: [
        ...base.layout.racks,
        // projectiles in the bustle bin, bases toward the loader
        { frame: 'turret', center: [-0.05, 0.2, -1.08], size: [0.8, 0.28, 0.22], face: 'pz', round: 0.122 },
      ],
      extras: [
        // the one charge case on the right turret wall, in its clamps
        { frame: 'turret', pos: [-0.84, 0.3, -0.2], cyl: true, r: 0.075, len: 0.78, color: 0xb08d4a },
        { frame: 'turret', pos: [-0.84, 0.12, -0.2], size: [0.06, 0.03, 0.2] },
        { frame: 'turret', pos: [-0.84, 0.5, -0.2], size: [0.06, 0.03, 0.2] },
        // the radio shelf
        { frame: 'turret', pos: [0.75, 0.285, -0.1], size: [0.34, 0.03, 0.48] },
        // loader's MK-IV periscope ahead of his hatch
        { frame: 'turret', pos: [lh.x, t.h - 0.1, lh.z + 0.42], size: [0.2, 0.14, 0.09] },
        // the TSh-17 eyepiece tube and its brow pad, beside the gun
        { frame: 'turret', pos: [gEye[0] - 0.02, gEye[1], gEye[2] + 0.35], cyl: true, r: 0.045, len: 0.5, axis: 'z', color: 0x2a2b28 },
        // gunner's elevation and traverse handwheels (left of the gun)
        { frame: 'turret', pos: [gEye[0] - 0.12, 0.2, gEye[2] + 0.18], cyl: true, r: 0.1, len: 0.03, axis: 'x', color: 0x2a2b28 },
        { frame: 'turret', pos: [gEye[0] + 0.12, 0.05, gEye[2] + 0.12], cyl: true, r: 0.09, len: 0.03, axis: 'y', color: 0x2a2b28 },
        // coaxial DT to the right of the gun, in the mantlet
        { frame: 'turret', pos: [-0.27, gm.y + 0.02, 0.74], size: [0.09, 0.11, 0.3], color: 0x2a2b28 },
        // the rear DT in its ball mount in the bustle
        { frame: 'turret', pos: [-0.25, 0.52, -1.24], cyl: true, r: 0.1, len: 0.12, axis: 'z' },
        { frame: 'turret', pos: [-0.25, 0.52, -1.0], size: [0.08, 0.1, 0.4], color: 0x2a2b28 },
        // driver's instrument panel left of the slit, the slit cover lever
        { frame: 'hull', pos: [0.38, dEyeY - 0.2, dEyeZ + 0.12], size: [0.26, 0.18, 0.06], color: 0x2a2b28 },
        { frame: 'hull', pos: [-0.16, dEyeY + 0.06, dEyeZ + 0.06], size: [0.03, 0.03, 0.16] },
        // compressed-air starter bottles on the hull floor, right of the driver
        { frame: 'hull', pos: [-0.55, hull.floorY + 0.12, dEyeZ + 0.1], cyl: true, r: 0.08, len: 0.6, axis: 'z', color: 0x3c4a3a },
        { frame: 'hull', pos: [-0.75, hull.floorY + 0.12, dEyeZ + 0.1], cyl: true, r: 0.08, len: 0.6, axis: 'z', color: 0x3c4a3a },
      ],
    },
    colors: { wall: 0xd3d5ca },
  };
});
