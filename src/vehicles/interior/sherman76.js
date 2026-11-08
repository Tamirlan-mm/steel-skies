import { defineTankInterior } from './registry.js';

// REFERENCE INTERIOR: M4A3(76)W Sherman ("large hatch" 47-degree hull, T23
// turret, 76 mm M1A1 in mount M62, wet stowage).
//
// Crew (left = +X): driver hull front LEFT, assistant driver / bow gunner
// hull front RIGHT, the transmission between them under the final-drive
// housing, the propeller shaft back to the Ford GAA under the turret basket.
// Turret: gunner RIGHT of the gun, commander behind him under the vision
// cupola (six vision blocks, an M6 periscope in the hatch), loader LEFT
// under his oval hatch with an M6 periscope ahead of it. The SCR-528 radio
// sits in the turret bustle. The interior was painted white.
//
// What this file changes over the derived defaults (stations.js), and why:
//   - the turret crew sides (the generic layout is the German one: gunner
//     left, loader right);
//   - the commander's six blocks start dead ahead, the hatch eye is a head
//     above the cupola ring;
//   - driver and bow gunner both look through the M6 periscope in their
//     hatches (the 47-degree hull had no direct-vision ports);
//   - the breech: vertical sliding wedge, 12 in (0.30 m) of recoil, the
//     76 x 539 mm R case;
//   - the radio in the bustle, the dome light, the loader's periscope, the
//     bow MG ball mount and the gunner's periscope sight housing.
// Everything else (room sizes, racks from the damage model's ammo boxes,
// seats from its crew boxes) comes from the spec through the defaults.

export default defineTankInterior('sherman76', (spec, base) => {
  const t = spec.turret; // w 2.1, h 0.82, len 2.65
  const hull = base.layout.hull;
  const cu = spec.shape.cupola; // r 0.32, h 0.22, z -0.42 (right side)
  const cupX = -t.w * 0.26;
  const blockY = t.h + cu.h * 0.62;
  const lh = spec.shape.loaderHatch; // x +0.48, z -0.30
  const gm = spec.gunMount; // trunnions 0.95 m ahead of the turret centre
  const drv = base.stations.driver.eye;
  const bow = base.stations.radio.eye;
  return {
    stations: {
      commander: {
        frame: 'turret',
        eye: [cupX, blockY, cu.z],
        look: [0, 0],
        device: { type: 'blocks', count: 6, radius: cu.r * 0.92, y: blockY, w: 0.15, h: 0.08, lean: 0.13, phase: 0 },
        hatch: { eye: [cupX, t.h + cu.h + 0.5, cu.z], fov: 70 },
        seat: [cupX, 0.05, cu.z - 0.05],
      },
      gunner: {
        frame: 'turret',
        eye: [-0.36, t.h * 0.5, 0.42],
        device: { type: 'sight', w: 0.12, h: 0.06, dist: 0.07 },
        seat: [-0.36, -0.15, 0.18],
      },
      loader: {
        frame: 'turret',
        // standing left of the breech, facing it across the turret
        eye: [lh.x + 0.05, t.h - 0.3, lh.z + 0.25],
        look: [Math.atan2(-(lh.x + 0.05), gm.z - 0.42 - (lh.z + 0.25)), -0.36],
        device: { type: 'none' },
        hatch: { eye: [lh.x, t.h + 0.55, lh.z], fov: 70 },
        seat: [lh.x + 0.05, -0.1, lh.z - 0.05],
      },
      driver: {
        frame: 'hull',
        eye: drv,
        device: { type: 'periscope', w: 0.17, h: 0.05, dist: 0.07, rise: hull.roofY + 0.13 - drv[1], fwd: 0.05 },
        hatch: { eye: [drv[0], hull.roofY + 0.62, drv[2] - 0.1] },
      },
      radio: {
        frame: 'hull',
        eye: bow,
        device: { type: 'periscope', w: 0.17, h: 0.05, dist: 0.07, rise: hull.roofY + 0.13 - bow[1], fwd: 0.05 },
        hatch: { eye: [bow[0], hull.roofY + 0.62, bow[2] - 0.1] },
      },
    },
    breech: {
      type: 'vertical',
      pos: [0, 0, -0.42],
      size: [0.27, 0.26, 0.44],
      recoilLength: 0.3,
      guardLength: 0.85,
      openTravel: 0.17,
      caliber: 76,
      caseLength: 0.54,
    },
    layout: {
      // SCR-528 in the bustle, on its shelf
      radio: { frame: 'turret', pos: [0.1, t.h * 0.42, -t.len / 2 + 0.3], size: [0.62, 0.3, 0.32] },
      domeLight: { frame: 'turret', pos: [0.25, t.h - 0.06, -0.15] },
      extras: [
        // the radio shelf
        { frame: 'turret', pos: [0.1, t.h * 0.42 - 0.17, -t.len / 2 + 0.3], size: [0.8, 0.03, 0.4] },
        // the loader's M6 periscope ahead of his hatch
        { frame: 'turret', pos: [lh.x, t.h - 0.09, lh.z + 0.42], size: [0.2, 0.14, 0.09] },
        // the gunner's M4 periscope sight and its link to the gun
        { frame: 'turret', pos: [-0.36, t.h - 0.12, 0.52], size: [0.14, 0.2, 0.12] },
        { frame: 'turret', pos: [-0.36, t.h * 0.42, 0.62], size: [0.05, 0.36, 0.05] },
        // the gunner's traverse handle box and elevation handwheel
        { frame: 'turret', pos: [-0.42, t.h * 0.18, 0.62], size: [0.16, 0.14, 0.18], color: 0x2a2b28 },
        { frame: 'turret', pos: [-0.24, t.h * 0.3, 0.58], cyl: true, r: 0.1, len: 0.03, axis: 'x', color: 0x2a2b28 },
        // fire extinguisher bottles on the hull side
        { frame: 'hull', pos: [hull.halfWidth - 0.15, hull.sponsonY + 0.3, -0.7], cyl: true, r: 0.08, len: 0.55, color: 0x8a2a20 },
        { frame: 'hull', pos: [-hull.halfWidth + 0.15, hull.sponsonY + 0.3, -0.7], cyl: true, r: 0.08, len: 0.55, color: 0x8a2a20 },
        // the bow MG ball mount and its gun
        { frame: 'hull', pos: [bow[0], hull.lowFrontY + 0.35, hull.frontZ - 0.42], cyl: true, r: 0.11, len: 0.12, axis: 'z' },
        { frame: 'hull', pos: [bow[0], hull.lowFrontY + 0.35, hull.frontZ - 0.75], size: [0.08, 0.1, 0.55], color: 0x2a2b28 },
      ],
    },
    colors: { wall: 0xd9d6c9 },
  };
});
