import { defineTankInterior } from './registry.js';
import { gunnerPeriscope } from './stations.js';

// M26 Pershing (1945 production: 90 mm M3 in combination mount M67, no
// muzzle brake, torsion bars, Ford GAF V-8 and Torqmatic box at the REAR).
//
// Crew (left = +X): driver hull front LEFT, assistant driver / bow gunner
// hull front RIGHT behind the .30 cal ball mount. There is NO gearbox or
// propeller shaft in the fighting compartment: engine, torque converter and
// final drives are all behind the firewall (sprocket at the rear), so the
// floor ahead of the basket is clear and carries the main ammunition bins.
// Turret (cast, 69 in / 1.75 m ring): gunner RIGHT front of the gun with
// the M10F periscopic sight in the roof ahead of him and the M71C telescope
// beside the gun; commander right REAR under the vision cupola (six vision
// blocks, M6 periscope in the hatch); loader LEFT with his own roof hatch
// and an M6 periscope; the SCR-508/528 radio in the bustle. Gun: vertical
// sliding-wedge, semi-automatic breech, about 13 in (0.33 m) of recoil,
// fixed 90 x 600 mm R rounds. Driver and assistant driver each look
// through an M6 periscope in the hatch (no direct-vision ports). Interior
// painted white. Sources: afvdatabase.com (crew positions, sights, 69 in
// ring, 70 rounds / 10 ready), Hunnicutt "Pershing" (general layout).
//
// Room sizes follow the drawn geometry: tanks.js castOval plans the turret
// from z +1.30 to -1.60 (half-width 1.15, roof inset 0.14), so the room is
// an ellipse centred 0.15 m aft of the ring; the hull fighting compartment
// stops at the engine bulkhead, not at the rear plate.

export default defineTankInterior('pershing', (spec, base) => {
  const t = spec.turret; // w 2.30, h 0.90, len 2.90, offZ 0.15
  const hull = base.layout.hull;
  const cu = spec.shape.cupola; // r 0.28, h 0.31, z -0.80 (right side)
  const cupX = -t.w * 0.26;
  const blockY = t.h + cu.h * 0.62;
  // trunnions: tanks.js default, len * 0.34 ahead of the turret origin
  const trunZ = t.len * 0.34;
  const trunY = t.h * 0.48;
  const brZ = -0.55; // breech ring centre, gun frame
  // the loader's hatch (left of the roof, beside the cupola)
  const lh = { x: 0.5, z: -0.5, r: 0.24 };
  const ld = [0.55, 0.55, -0.12]; // loader's eye, standing left of the gun
  const gnr = [-0.42, 0.5, 0.4];
  const drv = base.stations.driver.eye;
  const bow = base.stations.radio.eye;
  const roof = spec.hull.trackH + spec.hull.h;
  const bulk = -0.8; // engine bulkhead (contains the turret basket, r 0.92)
  const peri = (eye) => ({ type: 'periscope', w: 0.17, h: 0.05, dist: 0.07, rise: roof + 0.12 - eye[1], fwd: 0.05 });
  return {
    stations: {
      commander: {
        frame: 'turret',
        eye: [cupX, blockY, cu.z],
        look: [0, 0],
        device: { type: 'blocks', count: 6, radius: cu.r * 0.92, y: blockY, w: 0.15, h: 0.08, lean: 0.13, phase: 0 },
        hatch: { eye: [cupX, t.h + cu.h + 0.5, cu.z], fov: 70 },
        seat: [cupX, 0.42, cu.z - 0.08],
      },
      gunner: {
        frame: 'turret',
        eye: gnr,
        device: { type: 'sight', w: 0.12, h: 0.06, dist: 0.07 },
        seat: [gnr[0], -0.05, gnr[2] - 0.3],
        // the M10 periscope sight in the roof: its 1x window is his
        // look-out beside the M71 telescope (wave 7)
        vision: gunnerPeriscope(spec, gnr, { yaw: [-0.3, 0.3] }),
      },
      loader: {
        frame: 'turret',
        eye: ld,
        // across to the breech ring, a little down
        look: [Math.atan2(0 - ld[0], trunZ + brZ - ld[2]), -0.34],
        device: { type: 'none' },
        hatch: { eye: [lh.x, t.h + 0.55, lh.z], fov: 70 },
        seat: [ld[0] + 0.05, -0.2, ld[2] - 0.3],
      },
      driver: {
        frame: 'hull',
        eye: drv,
        device: peri(drv),
        hatch: { eye: [drv[0], roof + 0.62, drv[2] - 0.1] },
      },
      radio: {
        frame: 'hull',
        eye: bow,
        device: peri(bow),
        hatch: { eye: [bow[0], roof + 0.62, bow[2] - 0.1] },
      },
    },
    breech: {
      type: 'vertical',
      pos: [0, 0, brZ],
      size: [0.36, 0.34, 0.46],
      recoilLength: 0.33,
      guardLength: 0.9,
      openTravel: 0.2,
      caliber: 90,
      caseLength: 0.6,
    },
    layout: {
      hull: { rearZ: bulk, firewallZ: bulk },
      turret: { cz: -0.12, rx: 1.12, rz: 1.45, y1: t.h - 0.06 },
      // the 69 in ring
      // (turret.ringR stays the derived 0.92: 0.875 m ring + race)
      radio: { frame: 'turret', pos: [0, 0.56, -1.33], size: [0.6, 0.32, 0.24] },
      domeLight: { frame: 'turret', pos: [0.05, t.h - 0.09, -0.2] },
      // the power traverse control sits by the gunner, on the RIGHT
      traverse: { frame: 'turret', pos: [-0.5, 0.14, gnr[2] + 0.18], size: [0.18, 0.16, 0.2] },
      transmission: null,
      shaft: null,
      // the derived racks are the damage model's boxes (hull side bins, the
      // floor bins under the basket, the bustle) plus the loader's ready
      // rack on the left turret wall
      racks: [
        ...base.layout.racks.filter((r) => r.frame !== 'turret'),
        // the bustle bin, low and ahead of the radio (inside the damage
        // model's ammoTurret box)
        { frame: 'turret', center: [0, 0.27, -0.85], size: [1.1, 0.4, 0.45], face: 'pz', round: 0.09 },
        { frame: 'turret', center: [0.9, 0.3, -0.15], size: [0.22, 0.34, 0.62], face: 'nx', round: 0.09 },
      ],
      hatches: [
        ...base.layout.hatches,
        { frame: 'turret', pos: [lh.x, t.h - 0.06, lh.z], r: lh.r * 0.95 },
      ],
      extras: [
        // the radio shelf across the bustle
        { frame: 'turret', pos: [0, 0.39, -1.33], size: [0.8, 0.03, 0.3] },
        // gunner's M10F periscopic sight in the roof, its link to the gun
        { frame: 'turret', pos: [gnr[0], t.h - 0.15, gnr[2] + 0.14], size: [0.15, 0.2, 0.13] },
        { frame: 'turret', pos: [gnr[0] + 0.03, (t.h - 0.25 + trunY) / 2, gnr[2] + 0.22], size: [0.04, t.h - 0.25 - trunY + 0.1, 0.04] },
        // his elevation handwheel, to the left of his knees by the gun
        { frame: 'turret', pos: [-0.26, 0.28, gnr[2] + 0.18], cyl: true, r: 0.1, len: 0.03, axis: 'x', color: 0x2a2b28 },
        // the loader's M6 periscope ahead of his hatch
        { frame: 'turret', pos: [lh.x, t.h - 0.12, lh.z + 0.4], size: [0.2, 0.14, 0.09] },
        // the roof ventilator between the hatches
        { frame: 'turret', pos: [0.02, t.h - 0.12, -0.75], cyl: true, r: 0.11, len: 0.1, color: 0x3b3d39 },
        // the commander's map board / interphone box on the right wall
        { frame: 'turret', pos: [-0.98, 0.45, -0.45], size: [0.06, 0.2, 0.26], color: 0x3d4437 },
        // the .30 cal ball mount on the right glacis and its gun
        { frame: 'hull', pos: [bow[0] + 0.2, hull.lowFrontY + 0.36, hull.frontZ - 0.42], cyl: true, r: 0.11, len: 0.12, axis: 'z' },
        { frame: 'hull', pos: [bow[0] + 0.2, hull.lowFrontY + 0.36, hull.frontZ - 0.75], size: [0.08, 0.1, 0.55], color: 0x2a2b28 },
        // the escape hatch in the floor behind the assistant driver
        { frame: 'hull', pos: [bow[0], hull.floorY + 0.02, bow[2] - 0.7], cyl: true, r: 0.24, len: 0.03, color: 0x3b3d39 },
        // fixed fire extinguisher bottles at the bulkhead
        { frame: 'hull', pos: [hull.halfWidth - 0.6, hull.floorY + 0.3, bulk + 0.12], cyl: true, r: 0.08, len: 0.55, color: 0x8a2a20 },
        { frame: 'hull', pos: [-hull.halfWidth + 0.6, hull.floorY + 0.3, bulk + 0.12], cyl: true, r: 0.08, len: 0.55, color: 0x8a2a20 },
      ],
    },
    colors: { wall: 0xd9d6c9 },
  };
});
