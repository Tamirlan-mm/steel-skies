import { defineTankInterior } from './registry.js';
import { gunnerPeriscope } from './stations.js';

// Cromwell Mk IV (A27M, 75 mm OQF Mk V), as fought in NW Europe 1944.
//
// Crew (left = +X): driver hull front RIGHT, hull gunner (Besa) hull front
// LEFT, the two separated by a bulkhead; the Meteor and the gearbox are at
// the BACK, so the floor ahead of the engine bulkhead is clear (no propeller
// shaft, no front transmission). Turret: gunner RIGHT of the gun, commander
// behind him under the all-round vision cupola, loader / wireless operator
// LEFT, with the No. 19 wireless set at the back of the turret.
//
// Vision (Wikipedia 'Cromwell tank'; Fletcher, 'Cromwell Cruiser Tank'):
//   - driver: a visor in the upright 64 mm front plate (opened fully or to a
//     small gate behind a thick glass block) plus two periscopes in the roof
//     over him -> the 'slit' device, with the two periscope bodies drawn;
//   - hull gunner: one sighting periscope in his roof, the No. 35 telescope
//     of the Besa ball beside it;
//   - commander: the 1944 all-round vision cupola, eight episcopes (*verify*:
//     the outside model draws six blocks) and a Vickers periscope;
//   - gunner: No. 50 x3 telescope beside the gun and a Vickers periscope in
//     the roof (his view is the framework's sight);
//   - loader: a Vickers periscope in the roof, left front.
// Gun: the 75 mm was a 6-pdr bored out for US rounds, so it keeps the 6-pdr
// semi-automatic VERTICAL sliding block; about 12 in of recoil (*verify*);
// the US 75 x 350 mm R case.
// Ammunition: the damage model's sponson bins and floor bin are kept as they
// are (shells hit those boxes), only the crew sides are moved here.
//
// combat/internals.js lays the Cromwell turret out in the same British order
// (shape.gunnerRight, wave 8), so the X-ray crew boxes and these seats agree.
//
// WAVE 8 GEOMETRY (vehicles/tanks.js, Cromwell lane): the hull is a box
// BETWEEN the tracks, spec.hull.bodyW = 2.08 m wide, and its bow is
// spec.hull.nose — the vertical driver's plate stands at z = nose.plateZ
// (2.05) from y = nose.plateY (1.18) to the roof (1.62), behind a long shallow
// glacis to z 2.98. The room below stops at that plate.

export default defineTankInterior('cromwell', (spec, base) => {
  const t = spec.turret; // w 1.84, h 0.78, len 2.0, offZ 0.60
  const cu = spec.shape.cupola; // r 0.30, h 0.09, x -0.42 (right), z -0.42
  const cupX = cu.x ?? -t.w * 0.26;
  const blockY = t.h + cu.h * 0.62;
  const lh = spec.shape.loaderHatch; // x +0.45, z -0.40
  const gm = spec.gunMount; // trunnions y 0.39, z 0.90
  const roofOut = spec.hull.trackH + spec.hull.h; // 1.62
  const N = spec.hull.nose;
  const hb = (spec.hull.bodyW ?? spec.hull.w) / 2; // 1.04

  // the hull room: the inner face of the upright 64 mm front plate, walls
  // inside the 2.08 m body (no sponsons: the tracks are outboard). The room's
  // one-slope front cannot follow plate + glacis, so it stands at the plate:
  // upright almost to the floor (the space under the glacis is not modelled)
  const frontZ = N.plateZ - 0.07;
  const room = {
    frontZ,
    glacisTopZ: frontZ - 0.01,
    lowFrontY: base.layout.hull.floorY + 0.3,
    halfWidth: hb - 0.07,
    lowerHalfWidth: hb - 0.11,
    // the fighting compartment ends at the engine bulkhead
    rearZ: base.layout.hull.firewallZ,
  };
  const hull = { ...base.layout.hull, ...room };

  // driver: eye behind the visor (tanks.js cromwellDetails: x -0.45 hb, 52%
  // up the front plate); the slit's window (eye + 0.12) lands just inside the
  // room's front wall, the camera outside the visor box (index.js measures it)
  const visorY = N.plateY + (roofOut - N.plateY) * 0.52;
  const drv = [-hb * 0.45, visorY - 0.02, frontZ - 0.14];
  // hull gunner: under his roof periscope, behind the Besa ball (tanks.js
  // bowMg: x = 0.2 w, 45% of the way up the driver's plate)
  const hg = [spec.hull.w * 0.2, 1.36, frontZ - 0.22];
  const besaY = N.plateY + (roofOut - N.plateY) * 0.45;
  // the breech's rear face in the turret frame (gun level)
  const breechZ = gm.z - 0.4 - 0.2;
  const ldr = [lh.x + 0.03, 0.32, lh.z + 0.05];

  return {
    stations: {
      commander: {
        frame: 'turret',
        eye: [cupX, blockY, cu.z],
        look: [0, 0],
        device: { type: 'blocks', count: 8, radius: cu.r * 0.92, y: blockY, w: 0.12, h: 0.06, lean: 0.12, phase: 0 },
        hatch: { eye: [cupX, t.h + cu.h + 0.52, cu.z], fov: 70 },
        seat: [cupX, 0.1, cu.z - 0.05],
      },
      gunner: {
        frame: 'turret',
        // at the No. 50 telescope, right of the breech
        eye: [-0.33, gm.y + 0.03, breechZ + 0.05],
        device: { type: 'sight', w: 0.07, h: 0.07, dist: 0.06 },
        seat: [-0.4, -0.2, breechZ - 0.2],
        // the Vickers Tank Periscope in the roof over him (wave 7)
        vision: gunnerPeriscope(spec, [-0.33, gm.y + 0.03, breechZ + 0.05], { yaw: [-0.6, 0.6] }),
      },
      loader: {
        frame: 'turret',
        // standing left of the gun, facing the breech across the turret
        eye: ldr,
        look: [Math.atan2(0 - ldr[0], breechZ - ldr[2]), -0.12],
        device: { type: 'none' },
        hatch: { eye: [lh.x, t.h + 0.58, lh.z], fov: 70 },
        seat: [lh.x + 0.05, -0.15, lh.z - 0.05],
      },
      driver: {
        frame: 'hull',
        eye: drv,
        look: [0, 0],
        // the visor gate: the slit's hole lands just inside the front plate,
        // the camera (eye + dist + 0.1) just outside it
        device: { type: 'slit', w: 0.24, h: 0.06, dist: 0.12, bezel: 0.03, depth: 0.07 },
        hatch: { eye: [drv[0], roofOut + 0.6, drv[2] - 0.2], fov: 70 },
        seat: [drv[0], 1.0, drv[2] - 0.12],
      },
      radio: {
        frame: 'hull',
        eye: hg,
        look: [0, 0],
        device: { type: 'periscope', w: 0.17, h: 0.05, dist: 0.07, rise: hull.roofY + 0.13 - hg[1], fwd: 0.05 },
        hatch: { eye: [hg[0], roofOut + 0.6, hg[2] - 0.12], fov: 70 },
        seat: [hg[0], 1.0, hg[2] - 0.1],
      },
    },
    breech: {
      type: 'vertical',
      pos: [0, 0, -0.4],
      size: [0.26, 0.24, 0.4],
      recoilLength: 0.3,
      guardLength: 0.75,
      openTravel: 0.15,
      caliber: 75,
      caseLength: 0.35,
    },
    layout: {
      hull: room,
      // the No. 19 set on its shelf against the turret rear wall, worked by
      // the loader / operator
      radio: { frame: 'turret', pos: [0.2, 0.3, -t.len / 2 + 0.2], size: [0.56, 0.28, 0.24] },
      // the power traverse controller under the gunner's left hand
      traverse: { frame: 'turret', pos: [-0.44, 0.06, breechZ + 0.12], size: [0.22, 0.14, 0.2] },
      domeLight: { frame: 'turret', pos: [0.18, t.h - 0.09, -0.1] },
      hatches: [
        { frame: 'turret', pos: [cupX, t.h + cu.h - 0.05, cu.z], r: cu.r * 0.86, cupola: { r: cu.r, y0: t.h - 0.04, y1: t.h + cu.h - 0.04 } },
        { frame: 'turret', pos: [lh.x, t.h - 0.04, lh.z], r: lh.r * 0.95 },
        { frame: 'hull', pos: [drv[0], hull.roofY, N.plateZ - 0.22], r: 0.2 },
        { frame: 'hull', pos: [hg[0], hull.roofY, N.plateZ - 0.22], r: 0.2 },
      ],
      extras: [
        // radio shelf
        { frame: 'turret', pos: [0.2, 0.15, -t.len / 2 + 0.2], size: [0.7, 0.03, 0.3] },
        // the Vickers roof periscopes: gunner right, loader left (the outside
        // model's two roof heads at x = +/-0.28 w, z = 0.2 len)
        { frame: 'turret', pos: [-t.w * 0.28, t.h - 0.13, t.len * 0.2 - 0.02], size: [0.14, 0.16, 0.1] },
        { frame: 'turret', pos: [t.w * 0.28, t.h - 0.13, t.len * 0.2 - 0.02], size: [0.14, 0.16, 0.1] },
        // the No. 50 telescope along the right of the gun
        { frame: 'turret', pos: [-0.2, gm.y + 0.03, breechZ + 0.45], cyl: true, r: 0.035, len: 0.7, axis: 'z', color: 0x2a2b28 },
        // gunner's elevation handwheel and the firing pedal box
        { frame: 'turret', pos: [-0.22, gm.y - 0.17, breechZ + 0.2], cyl: true, r: 0.09, len: 0.03, axis: 'x', color: 0x2a2b28 },
        { frame: 'turret', pos: [-0.4, -0.85, breechZ + 0.05], size: [0.16, 0.06, 0.14], color: 0x2a2b28 },
        // the coaxial Besa on the left of the 75
        { frame: 'turret', pos: [0.17, gm.y - 0.02, breechZ + 0.3], size: [0.09, 0.12, 0.55], color: 0x2a2b28 },
        // ready ammunition box for the coax and the 2-inch bomb thrower tube
        { frame: 'turret', pos: [t.w / 2 - 0.15, 0.05, 0.2], size: [0.14, 0.24, 0.32], color: 0x4a4d48 },
        { frame: 'turret', pos: [0.32, t.h - 0.2, 0.55], cyl: true, r: 0.03, len: 0.35, axis: 'y' },
        // the bulkhead between the driver and the hull gunner
        { frame: 'hull', pos: [0, (hull.floorY + hull.roofY) / 2, frontZ - 0.26], size: [0.03, hull.roofY - hull.floorY - 0.05, 0.5] },
        // the driver's two roof periscopes, over and ahead of his head
        { frame: 'hull', pos: [drv[0] - 0.13, hull.roofY - 0.08, drv[2] - 0.18], size: [0.13, 0.16, 0.09] },
        { frame: 'hull', pos: [drv[0] + 0.13, hull.roofY - 0.08, drv[2] - 0.18], size: [0.13, 0.16, 0.09] },
        // the visor's hinge bar and operating handle
        { frame: 'hull', pos: [drv[0], drv[1] + 0.09, frontZ - 0.04], size: [0.34, 0.03, 0.04], color: 0x2a2b28 },
        { frame: 'hull', pos: [drv[0] - 0.22, drv[1] - 0.02, frontZ - 0.08], size: [0.03, 0.12, 0.1], color: 0x2a2b28 },
        // the hull Besa ball in the upright plate, the gun and its No. 35
        // telescope, and the belt box
        { frame: 'hull', pos: [hg[0], besaY, frontZ - 0.05], cyl: true, r: 0.13, len: 0.1, axis: 'z' },
        { frame: 'hull', pos: [hg[0], besaY, frontZ - 0.28], size: [0.09, 0.12, 0.44], color: 0x2a2b28 },
        { frame: 'hull', pos: [hg[0] - 0.09, besaY + 0.07, frontZ - 0.22], cyl: true, r: 0.025, len: 0.36, axis: 'z', color: 0x2a2b28 },
        { frame: 'hull', pos: [hg[0] + 0.14, besaY - 0.12, frontZ - 0.35], size: [0.12, 0.14, 0.24], color: 0x4a4d48 },
        // fire extinguisher on the driver's side wall
        { frame: 'hull', pos: [-hull.halfWidth + 0.12, hull.sponsonY + 0.28, frontZ - 0.75], cyl: true, r: 0.07, len: 0.45, color: 0x8a2a20 },
      ],
    },
  };
});
