import { defineTankInterior } from './registry.js';
import { gunnerPeriscope } from './stations.js';

// INTERIOR: M3 Stuart, late M3 with the welded horseshoe turret and the
// hexagonal cupola, 37 mm Gun M6 in Mount M23 with the Westinghouse
// elevation stabiliser (tanks.js 'stuart').
//
// Crew of four. Hull: driver front LEFT, assistant driver / bow gunner front
// RIGHT, the controlled-differential transmission between them, the
// propeller shaft running back to the Continental W-670 radial. Each driver
// looks out of the visor in the front of his hood (a direct-vision slot
// behind a protectoscope) and has a roof hatch. Turret, no basket (the M3A1
// brought the basket): the gunner sits LEFT of the gun and lays it through
// the M4 periscope with the M40 telescope in the roof ahead of him; the
// commander sits RIGHT and also LOADS the gun, standing up into the
// hexagonal cupola (vision slots in its faces, the turret's only hatch) to
// command. 103 rounds of 37 mm, almost all of them in the sponsons, the rest
// in floor bins either side of the propeller shaft. The radio sat in the
// hull sponson. The fixed .30 sponson guns either side of the front plate.
// The fighting compartment was painted white.
//
// What this file changes over the derived defaults (stations.js), and why:
//   - the hull room's front: the derived profile is a long glacis; the M3 has
//     a near-vertical driver's plate with a projecting hood for each driver,
//     so the room runs forward to the hood visors (the extra headroom ahead
//     of the deck stands in for the hood itself);
//   - driver + assistant driver on the visor slits in their hoods (the hoods
//     sit 0.30 m either side of the centreline on the outside model), seats
//     moved forward behind the hoods, a narrower gearbox between them;
//   - the stations follow the real four men (wave 8): commander (who loads),
//     driver, assistant driver ('radio' station), gunner; no loader. The damage
//     model (combat/internals.js CREW_ORDER) still lays out driver, gunner,
//     commander, loader on any four-man tank, so its fourth box stands for the
//     assistant driver here (crewAliveKey): he can be knocked out, by a hit on
//     a box that is not where he sits, until that file learns per-tank seats;
//   - the commander's figure works at the breech when the player is elsewhere
//     (`loads`, `figEye`: right of the gun; crew.js);
//   - gunner left with the M4 periscope sight; breech: 37 mm M6 vertical
//     sliding wedge (semi-automatic), the 37 x 223 mm R case;
//   - racks: 103-ish rounds in four sponson bins and two floor bins, inside
//     the damage model's own ammo boxes (the derived racks drew 670 round
//     bases and 7.7k triangles);
//   - radio in the right sponson, sponson MG receivers, the commander's
//     traverse handwheel, pistol-port protectoscopes, extinguisher.

const RACK_DARK = 0x3f4238;

export default defineTankInterior('stuart', (spec, base) => {
  const t = spec.turret; // w 1.45, h 0.60, len 1.52
  const hull = base.layout.hull;
  const roof = spec.hull.trackH + spec.hull.h; // 1.72
  const cu = spec.shape.cupola; // r 0.28, h 0.19, x +0.30 (left), z -0.34, hex
  const blockY = t.h + cu.h * 0.62; // the outside model's vision-block ring
  const gunZ = t.len * 0.34; // trunnions (no spec.gunMount): turret z 0.517
  const gunY = t.h * 0.48;

  // ---- the hull front: the hood visors. Outside (tanks.js driverHoods)
  // the visor plates are at x +-0.30, y ~1.36, z ~2.22.
  const visorY = 1.38;
  const dX = 0.38;
  const eyeZ = 2.0;
  const H = {
    glacisTopZ: 1.95,
    lowFrontY: 1.17,
    frontZ: 2.21,
  };
  const slit = { type: 'slit', w: 0.2, h: 0.04, dist: 0.1, bezel: 0.03, depth: 0.07 };
  const hullSeat = (x) => [x, 1.07, 1.66];

  // ---- the commander loading: right of the breech, looking at it
  const ldEye = [-0.38, 0.3, 0.0];

  // ---- ammunition: bins inside the damage model's ammo boxes
  const side = base.layout.racks.find((r) => r.face === 'nx' || r.face === 'px');
  const sx = side ? Math.abs(side.center[0]) : 0.87;
  const sy = side ? side.center[1] - 0.08 : 1.25;
  const sz = side ? side.center[2] : 0.27;
  const sd = side ? side.size[0] : 0.27;
  const racks = [];
  for (const s of [1, -1]) {
    for (const dz of [0.38, -0.37]) {
      racks.push({ frame: 'hull', center: [s * sx, sy, sz + dz], size: [sd, 0.3, 0.62], face: s > 0 ? 'nx' : 'px', round: 0.037, cols: 7, rows: 3 });
    }
  }
  const fl = base.layout.racks.find((r) => r.face === 'py');
  const fy = fl ? fl.center[1] : 0.59;
  const fz = fl ? fl.center[2] : 0.38;
  for (const s of [1, -1]) {
    racks.push({ frame: 'hull', center: [s * 0.32, fy, fz], size: [0.32, 0.3, 0.7], face: 'py', round: 0.037, cols: 2, rows: 5 });
  }

  // ---- hatches: keep the cupola, add both drivers' roof hatches
  const cupHatch = base.layout.hatches.filter((h) => h.cupola);
  const hatches = [
    ...cupHatch,
    { frame: 'hull', pos: [dX, hull.roofY, 1.62], r: 0.24 },
    { frame: 'hull', pos: [-dX, hull.roofY, 1.62], r: 0.24 },
  ];

  const mgY = roof - spec.hull.h * 0.5;
  const mgX = spec.hull.w / 2 - 0.22;

  return {
    crewRoles: ['driver', 'gunner', 'commander', 'radio'],
    crewAliveKey: { radio: 'loader' },
    stationLabels: { commander: 'COMMANDER / LOADER' },
    stations: {
      commander: {
        frame: 'turret',
        loads: true,
        figEye: ldEye,
        // head up in the hexagonal cupola; the slots face the six sides of
        // the outside model's drum (tanks.js: blocks at i/6 turns, phase 0)
        eye: [cu.x, blockY, cu.z],
        look: [0, 0],
        device: { type: 'blocks', count: 6, radius: cu.r * 0.9, y: blockY, w: 0.1, h: 0.045, bezel: 0.025, lean: 0.1, phase: 0 },
        hatch: { eye: [cu.x, t.h + cu.h + 0.5, cu.z], fov: 70 },
        seat: [-0.3, 0.07, -0.36],
      },
      gunner: {
        frame: 'turret',
        eye: [0.3, 0.34, 0.16],
        device: { type: 'sight', w: 0.08, h: 0.05, dist: 0.07 },
        seat: [0.3, 0.04, -0.08],
        // the M4 periscope (with the M40 telescope) in the roof ahead of
        // him: its unity window is his look-out (wave 7)
        vision: gunnerPeriscope(spec, [0.3, 0.34, 0.16], { yaw: [-0.3, 0.3], drop: 0.2 }),
      },
      loader: null,
      // the assistant driver: the right-hand hood's visor and his roof hatch
      radio: {
        frame: 'hull',
        eye: [-dX, visorY, eyeZ],
        look: [0, 0],
        device: slit,
        limits: { yaw: [-0.4, 0.4], pitch: [-0.12, 0.12] },
        fov: 55,
        hatch: { eye: [-dX, roof + 0.6, 1.62] },
        seat: hullSeat(-dX),
      },
      driver: {
        frame: 'hull',
        eye: [dX, visorY, eyeZ],
        look: [0, 0],
        device: slit,
        limits: { yaw: [-0.4, 0.4], pitch: [-0.12, 0.12] },
        fov: 55,
        hatch: { eye: [dX, roof + 0.6, 1.62] },
        seat: hullSeat(dX),
      },
    },
    breech: {
      type: 'vertical',
      pos: [0, 0, -0.24],
      size: [0.15, 0.15, 0.22],
      recoilLength: 0.2,
      guardLength: 0.45,
      openTravel: 0.08,
      caliber: 37,
      caseLength: 0.223,
    },
    layout: {
      hull: H,
      racks,
      hatches,
      // the gearbox between the two drivers, narrower than the damage box so
      // their seats clear it
      transmission: { frame: 'hull', pos: [0, 0.8, 1.6], size: [0.44, 0.62, 0.84] },
      // the set in the right sponson, behind the assistant driver
      radio: { frame: 'hull', pos: [-0.8, hull.sponsonY + 0.17, 1.2], size: [0.34, 0.3, 0.3] },
      domeLight: { frame: 'turret', pos: [0.05, t.h - 0.08, -0.2] },
      extras: [
        // the radio shelf
        { frame: 'hull', pos: [-0.8, hull.sponsonY + 0.005, 1.2], size: [0.42, 0.03, 0.4] },
        // the fixed .30 sponson guns' receivers either side of the front plate
        { frame: 'hull', pos: [mgX, mgY, 1.72], size: [0.09, 0.11, 0.42], color: 0x2a2b28 },
        { frame: 'hull', pos: [-mgX, mgY, 1.72], size: [0.09, 0.11, 0.42], color: 0x2a2b28 },
        // the visor doors' hinges/latches above each slit
        { frame: 'hull', pos: [dX, visorY + 0.09, 2.08], size: [0.3, 0.03, 0.05] },
        { frame: 'hull', pos: [-dX, visorY + 0.09, 2.08], size: [0.3, 0.03, 0.05] },
        // the gunner's M4 periscope (M40 telescope) and its link to the gun
        { frame: 'turret', pos: [0.3, t.h - 0.1, 0.27], size: [0.1, 0.16, 0.1] },
        { frame: 'turret', pos: [0.3, gunY + 0.06, 0.34], size: [0.04, 0.26, 0.04] },
        // the gunner's elevation handwheel and the stabiliser's gyro box
        { frame: 'turret', pos: [0.22, gunY - 0.08, 0.3], cyl: true, r: 0.08, len: 0.03, axis: 'x', color: 0x2a2b28 },
        { frame: 'turret', pos: [0.25, gunY - 0.2, 0.42], size: [0.12, 0.12, 0.16], color: 0x2a2b28 },
        // the commander's traverse handwheel on the right of the ring
        { frame: 'turret', pos: [-0.5, 0.12, 0.2], cyl: true, r: 0.09, len: 0.03, axis: 'x', color: 0x2a2b28 },
        { frame: 'turret', pos: [-0.56, 0.06, 0.2], size: [0.08, 0.14, 0.14] },
        // pistol ports with protectoscopes in both turret sides
        { frame: 'turret', pos: [t.w / 2 - 0.085, 0.32, -0.05], size: [0.03, 0.1, 0.16], color: RACK_DARK },
        { frame: 'turret', pos: [-t.w / 2 + 0.085, 0.32, -0.05], size: [0.03, 0.1, 0.16], color: RACK_DARK },
        // a hand extinguisher on the left sponson wall
        { frame: 'hull', pos: [hull.halfWidth - 0.12, hull.sponsonY + 0.25, -0.62], cyl: true, r: 0.07, len: 0.45, color: 0x8a2a20 },
      ],
    },
    colors: { wall: 0xdad7cb },
  };
});
