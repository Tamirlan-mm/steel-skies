import { defineTankInterior } from './registry.js';

// INTERIOR: SU-100 (1944-45 production; T-34 chassis, fixed casemate,
// 100 mm D-10S in a ball mount offset right of the centreline).
//
// Crew of four, all in ONE compartment under the casemate (no turret, no
// basket, no bow gunner):
//   - driver   front LEFT (+X), under the hatch in the 50-degree front plate,
//              looking through the periscope in its cover;
//   - gunner   LEFT of the gun behind the driver, at the TSh-19 articulated
//              telescope (4x, 16 deg) on the cradle's left; the Hertz
//              panorama goes up through the left roof hatch;
//   - commander RIGHT of the gun, his head in the cupola that sits in the
//              right-hand blister: vision slots with triplex blocks all round
//              and an MK-IV periscope in the lid;
//   - loader   behind the commander, right-rear; no hatch of his own, only a
//              slit in the rear wall.
// Breech: D-10S semi-automatic HORIZONTAL sliding wedge, up to 570 mm of
// recoil; 100 x 695 mm R case. Ammunition, 33 rounds in five places:
// 17 in racks along the LEFT side, 8 on the rear wall, 8 in floor boxes on
// the RIGHT. Radio: 9RS by the commander. Interior painted white.
//
// The derived defaults treat the casemate as a hull of the T-34's height;
// this file raises the room to the casemate roof (2.02 m outside), lays the
// front wall along the one 50-degree plate, ends the room at the casemate's
// rear wall (the engine is behind it), and puts the seats and the cupola in
// hull coordinates (the derived seats are turret-frame boxes).
//
// Note on the cupola: the real one has five slots; the outside model draws
// six glass blocks (tanks.js), and the windows here MUST line up with the
// drawn glass, so the device keeps six.

export default defineTankInterior('su100', (spec, base) => {
  const roof = spec.hull.trackH + spec.hull.h; // 1.60, the hull/engine deck
  const t = spec.turret;                        // the casemate lid, 0.42 m
  const caseRoof = roof + t.h;                  // 2.02, casemate roof outside
  const cu = spec.shape.cupola;                 // r 0.33, h 0.22, x -0.72, z 0.90
  const cupX = cu.x;
  const cupZ = cu.z + t.offZ;                   // 1.62 in the hull frame
  const blockY = caseRoof + cu.h * 0.62;        // where tanks.js draws the glass
  const gm = spec.gunMount;
  const gunX = gm.x;                            // -0.26: right of centre
  const gunY = roof + gm.y;                     // 1.80
  const gunZ = gm.z + t.offZ;                   // 1.88, the ball mount
  const H0 = base.layout.hull;

  // the inner face of the front plate: the outside runs from the roof edge
  // (z 1.62, y 2.02) down at 50 degrees; the inside is ~9 cm behind it
  const PLATE = (caseRoof - 0.82) / (1.62 - 3.05); // dy/dz, -0.84
  const innerZ = (y) => 1.53 + (y - caseRoof) / PLATE;
  const roofIn = caseRoof - 0.03;
  const lowFrontY = 0.95;

  const hull = {
    ...H0,
    roofY: roofIn,
    rearZ: -0.72,                 // the casemate rear wall; engine behind it
    firewallZ: -0.72,
    halfWidth: 1.25,              // the side plates lean in 20 deg above the
    glacisTopZ: innerZ(roofIn),   //   sponsons: this is their mean
    frontZ: innerZ(lowFrontY),
    lowFrontY,
  };

  // ---- stations
  const drv = [0.72, 1.42, 1.95];
  const gnr = [0.3, gunY + 0.04, 1.15];
  const ldr = [-0.62, 1.8, 0.15];
  const brZ = gunZ - 0.55; // breech ring centre at rest
  const ldrYaw = Math.atan2(gunX - ldr[0], brZ - ldr[2]);

  return {
    stations: {
      commander: {
        frame: 'hull',
        eye: [cupX, blockY, cupZ],
        look: [0, 0],
        device: { type: 'blocks', count: 6, radius: cu.r * 0.92, y: blockY, w: 0.12, h: 0.06, lean: 0.12, phase: 0 },
        hatch: { eye: [cupX, caseRoof + cu.h + 0.52, cupZ], fov: 70 },
        seat: [cupX, 1.6, cupZ - 0.22],
      },
      driver: {
        frame: 'hull',
        eye: drv,
        look: [0, 0],
        // the periscope in the hatch cover: its head stands just proud of the
        // front plate, 0.32 up and 6 cm ahead of the eyepiece
        device: { type: 'periscope', w: 0.14, h: 0.045, dist: 0.07, rise: 0.32, fwd: 0.06 },
        limits: { yaw: [-0.7, 0.7], pitch: [-0.2, 0.22] },
        // the hatch opens up and forward off the plate: head out above it
        hatch: { eye: [drv[0], 2.02, 2.02], fov: 70 },
        seat: [drv[0], 1.08, 1.78],
      },
      gunner: {
        frame: 'hull',
        eye: gnr,
        device: { type: 'sight', w: 0.06, h: 0.06, dist: 0.06 },
        seat: [0.34, 1.33, 0.92],
      },
      loader: {
        frame: 'hull',
        // right-rear behind the commander, head at breech height under the
        // 2 m roof, facing the breech face over the deflector tray
        eye: ldr,
        look: [ldrYaw, -0.06],
        device: { type: 'none' },
        hatch: null,
        seat: [-0.92, 1.2, 0.05],
      },
      radio: null,
    },
    breech: {
      type: 'horizontal',
      pos: [0, 0, -0.55],
      size: [0.4, 0.34, 0.5],
      recoilLength: 0.57,
      guardLength: 1.0,
      openTravel: 0.24,
      caliber: 100,
      caseLength: 0.695,
    },
    layout: {
      hull,
      racks: [
        // LEFT side, 17: rounds lying fore-and-aft in clamps, bases aft;
        // eight on the sponson shelf, nine in the box below it
        { frame: 'hull', center: [1.08, 1.28, 0.12], size: [0.32, 0.64, 0.95], face: 'nz', cols: 2, rows: 4, round: 0.1 },
        { frame: 'hull', center: [0.7, 0.7, 0.12], size: [0.44, 0.48, 0.95], face: 'nz', cols: 3, rows: 3, round: 0.1 },
        // rear wall, 8: across the compartment, bases to the right
        { frame: 'hull', center: [0.05, 1.3, -0.54], size: [1.05, 0.32, 0.32], face: 'nx', cols: 2, rows: 2, round: 0.1 },
        { frame: 'hull', center: [0.05, 1.66, -0.54], size: [1.05, 0.32, 0.32], face: 'nx', cols: 2, rows: 2, round: 0.1 },
        // RIGHT floor, 8: boxes under the loader, bases aft
        { frame: 'hull', center: [-0.56, 0.61, 0.62], size: [0.72, 0.3, 0.95], face: 'nz', cols: 4, rows: 2, round: 0.1 },
      ],
      // 9RS on the right wall by the commander
      radio: { frame: 'hull', pos: [-1.0, 1.3, 1.02], size: [0.4, 0.24, 0.26] },
      domeLight: { frame: 'hull', pos: [0.1, roofIn - 0.04, 0.75] },
      traverse: null,
      transmission: null,
      shaft: null,
      hatches: [
        // the cupola: wall, lid and the ring of blocks
        { frame: 'hull', pos: [cupX, caseRoof + cu.h - 0.015, cupZ], r: cu.r * 0.86, cupola: { r: cu.r, y0: roofIn - 0.02, y1: caseRoof + cu.h - 0.04 } },
        // the gunner's two-leaf panorama hatch on the left of the roof
        { frame: 'hull', pos: [0.6, roofIn, 1.05], r: 0.24 },
      ],
      extras: [
        // the casemate's roof beam and the rear wall's top angle
        { frame: 'hull', pos: [0, roofIn - 0.03, 0.4], size: [2.3, 0.05, 0.08] },
        { frame: 'hull', pos: [0, roofIn - 0.04, -0.69], size: [2.3, 0.06, 0.06] },
        // the loader's vision slit in the rear wall
        { frame: 'hull', pos: [-0.75, 1.62, -0.7], size: [0.26, 0.04, 0.03], color: 0x1c1d1b },
        // TSh-19: the telescope along the cradle's left side, its eyepiece
        // head and brow pad at the gunner's eye
        { frame: 'hull', pos: [gnr[0] - 0.12, gunY + 0.06, 1.52], cyl: true, r: 0.045, len: 0.62, axis: 'z' },
        { frame: 'hull', pos: [gnr[0] - 0.04, gnr[1], gnr[2] + 0.16], size: [0.16, 0.12, 0.12] },
        // the gunner's elevation (left hand) and traverse handwheels
        { frame: 'hull', pos: [gnr[0] - 0.14, 1.5, 1.32], cyl: true, r: 0.11, len: 0.03, axis: 'x', color: 0x2a2b28 },
        { frame: 'hull', pos: [gnr[0] + 0.12, 1.42, 1.38], cyl: true, r: 0.1, len: 0.03, axis: 'z', color: 0x2a2b28 },
        { frame: 'hull', pos: [gnr[0] + 0.02, 1.42, 1.48], size: [0.2, 0.14, 0.16], color: 0x2a2b28 },
        // the Hertz panorama under the left roof hatch
        { frame: 'hull', pos: [0.6, roofIn - 0.17, 1.12], cyl: true, r: 0.05, len: 0.32 },
        { frame: 'hull', pos: [0.6, roofIn - 0.34, 1.02], size: [0.09, 0.08, 0.12], color: 0x2a2b28 },
        // the MK-IV periscope in the cupola lid
        { frame: 'hull', pos: [cupX, caseRoof + cu.h - 0.14, cupZ - 0.04], size: [0.12, 0.13, 0.07] },
        // the ball mount's inner collar on the front plate, round the gun
        { frame: 'hull', pos: [gunX, gunY, innerZ(gunY) - 0.05], cyl: true, r: spec.shape.mantletR * 0.95, len: 0.1, axis: 'z' },
        // compressed-air starter bottles at the driver's left knee
        { frame: 'hull', pos: [1.12, 1.15, 2.2], cyl: true, r: 0.07, len: 0.5, color: 0x4f5b47 },
        { frame: 'hull', pos: [1.12, 1.15, 2.05], cyl: true, r: 0.07, len: 0.5, color: 0x4f5b47 },
        // fire extinguisher on the right sponson
        { frame: 'hull', pos: [-1.1, 1.2, 0.45], cyl: true, r: 0.06, len: 0.42, color: 0x8a2a20 },
        // the driver's hatch frame in the front plate, above the periscope
        { frame: 'hull', pos: [drv[0], 1.8, innerZ(1.8) - 0.04], size: [0.56, 0.05, 0.06] },
      ],
    },
    colors: { wall: 0xcfd2c6 },
  };
});
