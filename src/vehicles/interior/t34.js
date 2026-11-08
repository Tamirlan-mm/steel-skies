import { defineTankInterior } from './registry.js';

// INTERIOR: T-34-85, 1944-45 production (ZiS-S-53 85 mm, three-man cast
// turret on the 1.60 m ring, five-slot commander's cupola, glacis driver's
// hatch, DT in the bow ball). Everything is placed on the model's own drawn
// geometry (tanks.js 't34' hull stations, 'hexCast' turret plan) so the eye
// points sit inside the very plates the outside model draws.
//
// Crew (left = +X):
//   - driver-mechanic hull front LEFT, behind the rectangular glacis hatch
//     (tanks.js: x = w * 0.14, centre 1.29 m up the 60-degree plate at
//     z ~2.24). He looks through the two fixed prismatic periscopes in the
//     hatch; with the hatch propped open he looks straight out of it.
//   - bow machine gunner hull front RIGHT, behind the DT ball mount
//     (x = -w * 0.2, y ~1.26, z ~2.26). He has NO hatch and no periscope of
//     his own: his only view is the PPU-8T telescope of the DT (about 2x,
//     roughly 30 degrees of field), so his station is a fixed slit-type sight
//     that traverses inside the ball's +-12 / -6..+16 degrees.
//   - the T-34-85 moved the radio (9-RS, later 10-RT-26) from the hull into
//     the turret, on the LEFT wall beside the commander, who worked it.
//   - turret, three men: gunner LEFT of the gun and forward, with the
//     TSh-16 articulated telescope left of the breech and a periscope in the
//     roof above it; commander LEFT behind him under the cupola (x 0.50,
//     z -0.30): five vision slots with triplex blocks all round, an MK-4
//     periscope in the rotating hatch; loader RIGHT under his round hatch
//     (x -0.52, z 0.05) with an MK-4 periscope in the roof ahead of it.
//     There is no turret basket: the gunner's and commander's seats hang
//     from the ring and the loader stands on the floor ammunition boxes.
//   - breech: vertical sliding wedge, semi-automatic; recoil 260-330 mm
//     (0.32 m used), 85 x 629 mm R case.
//   - stowage, 55-60 rounds: the bustle rack (16, laid across the bustle,
//     bases toward the loader *verify*), clamps on the fighting-compartment
//     walls over the sponsons (8), and the rest in the floor boxes under
//     rubber mats, which is what the loader stands on.
//   - compartment rear: the engine firewall (combat/internals.js engine box,
//     z ~ -0.63). The engine and gearbox are behind it, so there is no
//     propeller shaft and no front transmission.
// Racks/boxes stay on the damage model's ammo boxes (ammoTurret, ammoHullL/R,
// ammoFloor), so what the loader sees is what the shells hit.
//
// Known gaps (framework, not this file): the room is a prism with vertical
// side walls, so the 40-degree upper side plates read as vertical from
// inside; the generic turret-basket posts are still drawn although a T-34
// has no basket; damage-model crew boxes put the commander on the right
// (internals.js), so the seats here follow the real layout instead; hull
// seat cushions are clamped to floor + 0.38 (layer.js), higher than the real
// T-34's low driver/gunner seats.
// Accepted deviation vs. the framework test t_interior.mjs ("driver periscope
// head above roof", expects > 1.60 m): the T-34's driver prisms sit in the
// GLACIS hatch, not the deck roof, so the head is at 1.52 m - 0.18 m above
// the hatch's outer face and clear (raycast), but below the deck's height.

export default defineTankInterior('t34', (spec, base) => {
  const t = spec.turret; // w 2.30, h 0.87, len 2.62, offZ 0.70
  const H = base.layout.hull; // floor 0.45, roof 1.57 (inside), glacis 1.667 -> 2.97
  const w = spec.hull.w;
  const cu = spec.shape.cupola; // r 0.33, h 0.25, x +0.50, z -0.30
  const lh = spec.shape.loaderHatch; // r 0.25, x -0.52, z 0.05
  const roofT = t.h; // turret roof, turret frame
  const gunY = t.h * 0.48; // trunnion height (tanks.js default mount)
  const gunZ = t.len * 0.34; // trunnion z, turret frame (0.89)

  // the glacis line drawn by tanks.js: nose (z 3.05, y 0.82) to deck
  // (z 1.70, y 1.60), 60 degrees from vertical
  const glacisY = (z) => 0.82 + (3.05 - z) * (0.78 / 1.35);

  // ---- driver: behind the glacis hatch
  const dX = w * 0.14; // the hatch's x on the outside model
  const drv = [dX, 1.27, 1.95];
  // periscope heads 0.25 up / 0.2 ahead: clear of the hatch plate's outer
  // face (glacis 1.37 + plate at z 2.15)
  const drvRise = 0.25;
  const drvFwd = 0.2;

  // ---- bow gunner: the DT's PPU-8T telescope. On the real tank it looks
  // through the ball itself; the outside model's ball is a SOLID cylinder
  // (r 0.15, rear face at z 2.23) with the barrel on its axis, and the slit
  // device's camera rides 0.27 m ahead of the eye along the look, so any line
  // of sight through or near the ball fills the window with the tank's own
  // paint as soon as the gun traverses right or depresses. Accepted
  // deviation: the sight's eye sits 0.36 m LEFT of the ball axis and 5 cm
  // below it, a raycast search over the ball's whole arc (wave6/fix_t34
  // search.mjs / t_bow.mjs) leaves only the main gun's own barrel overhead at
  // full elevation in view. Window (z 2.13, top 1.26) stays under the
  // room's glacis face (1.30 there); the camera (z ~2.23, y 1.21) is inside
  // the plate, where its back faces are culled, never in front of a front face.
  const mX = -w * 0.2;
  const mgY = 1.26;
  const bow = [mX + 0.36, mgY - 0.05, 1.96];

  // ---- turret crew
  const cupX = cu.x;
  const blockY = roofT + cu.h * 0.62;
  const gEye = [0.33, gunY + 0.02, 0.33];
  // breech ring centre in the gun frame (rear face ~0.2 m behind the turret
  // ring centre at full recoil it reaches ~ -0.4, short of the bustle rack)
  const brZ = -0.8;
  const brTurretZ = gunZ + brZ; // ~0.09
  const lEye = [lh.x - 0.03, 0.58, -0.2];
  const lYaw = Math.atan2(0 - lEye[0], brTurretZ - lEye[2]);

  // floor boxes: six lidded boxes on the damage model's ammoFloor box
  const fb = base.layout.racks.find((r) => r.face === 'py');
  const floorBoxes = [];
  if (fb) {
    const [cx, cy, cz] = fb.center;
    const [sx, sy, sz] = fb.size;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        const x = cx - sx / 2 + (i + 0.5) * (sx / 3);
        const z = cz - sz / 2 + (j + 0.5) * (sz / 2);
        floorBoxes.push({ frame: 'hull', pos: [x, cy - 0.01, z], size: [sx / 3 - 0.03, sy - 0.02, sz / 2 - 0.03], color: 0x4a4d42 });
        // the rubber mat on the lid, and a lifting handle
        floorBoxes.push({ frame: 'hull', pos: [x, cy + sy / 2 - 0.02, z], size: [sx / 3 - 0.05, 0.012, sz / 2 - 0.05], color: 0x2b2a27 });
        floorBoxes.push({ frame: 'hull', pos: [x, cy + sy / 2 - 0.005, z - sz / 4 + 0.06], size: [0.12, 0.02, 0.02], color: 0x1c1d1b });
      }
    }
  }

  // wall clamps: four rounds per side lying fore-and-aft on the sponson
  // shelves, bases to the rear, on the damage model's ammoHull boxes
  const wallRounds = [];
  for (const r of base.layout.racks.filter((k) => k.face === 'px' || k.face === 'nx')) {
    const [cx, cy, cz] = r.center;
    const sIn = r.face === 'px' ? 1 : -1; // toward the centreline
    for (let k = 0; k < 2; k++) {
      for (let m = 0; m < 2; m++) {
        const x = cx + sIn * (m === 0 ? -0.06 : 0.06);
        const y = cy - 0.08 + k * 0.13 + m * 0.02;
        const z0 = cz - 0.3 + (k ? 0.5 : -0.25);
        wallRounds.push({ frame: 'hull', pos: [x, y, z0], cyl: true, r: 0.053, len: 0.63, axis: 'z', color: 0xb08d4a, seg: 8 });
        wallRounds.push({ frame: 'hull', pos: [x, y, z0 + 0.315 + 0.16], cyl: true, r: 0.043, len: 0.32, axis: 'z', color: 0x3e4234, seg: 8 });
      }
    }
    // the clamp straps
    for (const dz of [-0.35, 0.35]) {
      wallRounds.push({ frame: 'hull', pos: [cx + sIn * 0.0, cy, cz + dz], size: [0.3, 0.4, 0.03], color: 0x4a4d48 });
    }
  }

  return {
    stations: {
      commander: {
        frame: 'turret',
        eye: [cupX, blockY, cu.z],
        look: [0, 0],
        // five vision slots with triplex blocks, one dead ahead
        device: { type: 'blocks', count: 5, radius: cu.r * 0.93, y: blockY, w: 0.13, h: 0.045, lean: 0.13, phase: 0 },
        hatch: { eye: [cupX, roofT + cu.h + 0.48, cu.z], fov: 70 },
        // hung from the turret ring, high enough to put his eyes at the slots
        seat: [cupX - 0.02, blockY - 0.55, cu.z - 0.2],
      },
      gunner: {
        frame: 'turret',
        // the TSh-16 eyepiece, left of the breech (his view is the H-02 sight)
        eye: gEye,
        device: { type: 'sight', w: 0.06, h: 0.05, dist: 0.06 },
        seat: [gEye[0] + 0.05, gEye[1] - 0.24, gEye[2] - 0.32],
      },
      loader: {
        frame: 'turret',
        // standing on the floor boxes right of the gun, facing the breech
        eye: lEye,
        look: [lYaw, -0.3],
        device: { type: 'none' },
        hatch: { eye: [lh.x, roofT + 0.6, lh.z], fov: 70 },
        seat: [lEye[0] - 0.1, lEye[1] - 0.15, lEye[2] - 0.18],
      },
      driver: {
        frame: 'hull',
        eye: drv,
        look: [0, -0.04],
        device: { type: 'periscope', w: 0.17, h: 0.045, dist: 0.1, rise: drvRise, fwd: drvFwd },
        // fixed prisms in the hatch: they do not turn
        limits: { yaw: [-0.45, 0.45], pitch: [-0.18, 0.14] },
        fov: 50,
        // hatch propped open: head just out of the plate, looking forward
        hatch: { eye: [dX, glacisY(2.1) + 0.12, 2.1], fov: 72, limits: { yaw: [-1.3, 1.3], pitch: [-0.5, 0.5] } },
        seat: [dX, 1.0, 1.62],
      },
      radio: {
        frame: 'hull',
        eye: bow,
        look: [0, 0],
        device: { type: 'slit', w: 0.06, h: 0.05, dist: 0.17, bezel: 0.025, depth: 0.12 },
        // the ball's own arcs: +-12 degrees, -6..+16 degrees
        limits: { yaw: [-0.21, 0.21], pitch: [-0.1, 0.28] },
        fov: 30,
        hatch: null,
        // hunched forward over the eyepiece; the framework clamps a hull
        // cushion to floor + 0.38 (layer.js), the real seat was lower
        seat: [bow[0] + 0.05, 1.0, bow[2] - 0.4],
      },
    },
    breech: {
      type: 'vertical',
      pos: [0, 0, brZ],
      size: [0.34, 0.32, 0.4],
      recoilLength: 0.32,
      guardLength: 0.75,
      openTravel: 0.18,
      caliber: 85,
      caseLength: 0.63,
    },
    layout: {
      // the fighting compartment ends at the engine firewall
      hull: { rearZ: H.firewallZ },
      // the casting's room: 1.10 m ahead of the ring and 1.35 m behind it,
      // less the walls (90 front, 75 side, 52 rear)
      turret: { cz: -0.12, rx: 1.0, rz: 1.12, y1: roofT - 0.04 },
      racks: base.layout.racks
        .filter((r) => r.frame === 'turret')
        .map((r) => ({ ...r, face: 'nx', cols: 4, rows: 4 })),
      // 9-RS / 10-RT-26 on the left turret wall, beside the commander
      radio: { frame: 'turret', pos: [0.72, 0.36, -0.72], size: [0.18, 0.26, 0.42] },
      domeLight: { frame: 'turret', pos: [-0.1, roofT - 0.07, -0.25] },
      transmission: null,
      shaft: null,
      // cupola and loader's hatch only: the driver's hatch is in the glacis
      // (drawn below as its periscope bodies) and the bow gunner has none
      hatches: base.layout.hatches.filter((h) => h.frame === 'turret'),
      extras: [
        ...floorBoxes,
        ...wallRounds,
        // the radio's shelf on the turret wall
        { frame: 'turret', pos: [0.72, 0.21, -0.72], size: [0.24, 0.03, 0.48] },
        // the loader's MK-4 periscope in the roof ahead of his hatch
        { frame: 'turret', pos: [lh.x - 0.06, roofT - 0.12, lh.z + 0.42], size: [0.18, 0.13, 0.1] },
        // the gunner's TSh-16 telescope, eyepiece to mantlet, left of the gun
        { frame: 'turret', pos: [gEye[0], gEye[1], (gEye[2] + gunZ) / 2 + 0.08], cyl: true, r: 0.038, len: gunZ - gEye[2] - 0.05, axis: 'z', color: 0x2a2b28 },
        // his elevating handwheel (left) and traverse handwheel (forward)
        { frame: 'turret', pos: [gEye[0] + 0.12, gunY - 0.18, gEye[2] + 0.16], cyl: true, r: 0.11, len: 0.03, axis: 'x', color: 0x2a2b28 },
        { frame: 'turret', pos: [gEye[0] + 0.05, gunY - 0.32, gEye[2] + 0.22], cyl: true, r: 0.1, len: 0.03, axis: 'z', color: 0x2a2b28 },
        // the coaxial DT, right of the gun
        { frame: 'turret', pos: [-0.24, gunY + 0.02, gunZ - 0.35], size: [0.08, 0.1, 0.6], color: 0x2a2b28 },
        { frame: 'turret', pos: [-0.24, gunY + 0.1, gunZ - 0.5], cyl: true, r: 0.12, len: 0.04, axis: 'y', color: 0x3a3c37 },
        // the two roof ventilator housings at the rear (tanks.js roofDomes)
        { frame: 'turret', pos: [0.18, roofT - 0.1, -t.len * 0.39], cyl: true, r: 0.11, len: 0.1, color: 0x4a4d48 },
        { frame: 'turret', pos: [-0.18, roofT - 0.1, -t.len * 0.39], cyl: true, r: 0.11, len: 0.1, color: 0x4a4d48 },
        // driver: the second periscope body in the hatch and
        // the compressed-air starting bottles at his left front
        { frame: 'hull', pos: [dX - 0.12, drv[1] + 0.1, drv[2] + 0.2], size: [0.1, 0.12, 0.08], color: 0x4a4d48 },
        { frame: 'hull', pos: [H.lowerHalfWidth - 0.12, 0.78, 2.3], cyl: true, r: 0.08, len: 0.5, color: 0x5a5e55 },
        { frame: 'hull', pos: [H.lowerHalfWidth - 0.3, 0.78, 2.35], cyl: true, r: 0.08, len: 0.5, color: 0x5a5e55 },
        // the bow DT: the ball's inner face, the gun and its pan magazine
        { frame: 'hull', pos: [mX, mgY, 2.12], cyl: true, r: 0.14, len: 0.1, axis: 'z', color: 0x4a4d48 },
        { frame: 'hull', pos: [mX, mgY - 0.04, 1.86], size: [0.07, 0.09, 0.5], color: 0x2a2b28 },
        { frame: 'hull', pos: [mX, mgY + 0.01, 1.84], cyl: true, r: 0.1, len: 0.035, axis: 'y', color: 0x3a3c37 },
        // the PPU-8T's bracket from the gun cradle to the eyepiece housing,
        // outboard of the window (never in front of the hole)
        { frame: 'hull', pos: [(mX + bow[0] - 0.06) / 2, bow[1] - 0.03, bow[2] + 0.12], cyl: true, r: 0.018, len: bow[0] - 0.06 - mX, axis: 'x', color: 0x2a2b28 },
        // the hand-held fire extinguisher on the firewall
        { frame: 'hull', pos: [-0.6, 1.0, H.firewallZ + 0.1], cyl: true, r: 0.06, len: 0.4, color: 0x8a2a20 },
      ],
    },
    colors: { wall: 0xcdd0c2, seat: 0x3e3226 },
  };
});
