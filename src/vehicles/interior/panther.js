import { defineTankInterior } from './registry.js';

// INTERIOR: Panzerkampfwagen V Panther Ausf. G (late 1944, 75 mm KwK 42 L/70
// in the chin mantlet). Sources: Jentz/Doyle "Panther Variants 1942-1945",
// the D 655/27 crew manual (Panther-Fibel) and published museum interiors.
//
// Crew (left = +X):
//   - driver, hull front LEFT, beside the AK 7-200 gearbox and steering unit.
//     The Ausf. G deleted the glacis vision port: he drives through ONE
//     rotating periscope in the hull roof just ahead of his hatch. Two
//     steering levers, instrument panel on his left.
//   - radio operator / bow gunner, hull front RIGHT, the MG 34 in the
//     Kugelblende 100 ball mount in the glacis (KZF 2 sight), one fixed
//     periscope in his hatch, the Fu 5 sets in the right sponson beside him.
//   - gunner, turret LEFT of the gun, well forward beside the breech, at the
//     TZF 12a monocular articulated sight: the objective rides the gun, the
//     eyepiece hangs from the roof so his head stays still. Elevation
//     handwheel on his right, traverse handwheel ahead, the rocking foot
//     plate of the hydraulic traverse under his feet.
//   - commander, turret left REAR, raised seat, under the cast cupola with
//     SEVEN periscopes (Ausf. A/G) and a lift-and-swing hatch.
//   - loader, turret RIGHT of the gun; no roof hatch on the A/G (the big
//     round hatch in the turret rear is his), a periscope in the roof
//     front right, the close-defence weapon in the roof right rear.
//   - no turret basket: a platform hung from the turret over the propeller
//     shaft and the hull-floor stowage; most of the 82 rounds lie in the
//     sponsons on both sides.
// KwK 42: VERTICAL sliding (falling) wedge, semi-automatic, electric firing;
// normal recoil 430 mm; 75 x 640 mm R case, 0.89 m complete round. The
// generic German default (horizontal wedge) is wrong for it.
// Paint: Elfenbein (ivory) inside, the framework's German default.

export default defineTankInterior('panther', (spec, base) => {
  const t = spec.turret; // w 2.30, h 0.82, len 2.55 (1.05 ahead of the ring, 1.45 behind)
  const H = base.layout.hull;
  const roof = spec.hull.trackH + spec.hull.h; // 1.92, hull frame
  const cu = spec.shape.cupola; // r 0.30, h 0.24, x +0.52 (left), z -0.42
  const blockY = t.h + cu.h * 0.62;
  const gm = spec.gunMount; // trunnions y 0.36, z 1.0 in the turret frame
  const roofY = H.roofY; // 1.89 inside

  // hull: the 55-degree glacis meets the roof 1.39 m behind the nose beam;
  // 80 mm at 55 degrees puts its INSIDE face 0.14 m further back
  const glacisTopZ = 1.87;
  // the upper sides lean in at 30 degrees: 1.09 m half-width at the roof,
  // 1.55 at the sponson shelf; the room is one width, so take the middle
  const halfWidth = 1.4;

  // driver / bow gunner: heads under the roof, just behind the glacis top
  const drv = [0.81, roofY - 0.16, 1.68];
  const bow = [-0.85, roofY - 0.16, 1.68];
  const periscope = (e) => ({ type: 'periscope', w: 0.15, h: 0.045, dist: 0.1, rise: roof + 0.1 - e[1], fwd: 0.05 });

  // gunner's eye at the TZF 12a eyepiece, left of the gun and beside the
  // breech ring (the sight's aperture is left of the bore in the mantlet)
  const gEye = [0.4, gm.y + 0.06, 0.25];
  // loader: standing right of and behind the breech, looking at its face
  const lEye = [-0.62, 0.36, -0.3];
  const breechRearZ = gm.z - 0.8 - 0.24; // turret frame, gun level
  const lYaw = Math.atan2(0 - lEye[0], breechRearZ - lEye[2]);

  const BR = { pos: [0, 0, -0.8], size: [0.36, 0.34, 0.48] };

  return {
    stations: {
      commander: {
        frame: 'turret',
        eye: [cu.x, blockY, cu.z],
        look: [0, 0],
        // seven periscopes in the cast cupola, one dead ahead
        device: { type: 'blocks', count: 7, radius: cu.r * 0.9, y: blockY, w: 0.13, h: 0.055, lean: 0.12, phase: 0 },
        hatch: { eye: [cu.x, t.h + cu.h + 0.5, cu.z], fov: 70 },
        // raised seat under the cupola (the damage model's commander box is
        // on the other side; this is only the drawn seat)
        seat: [cu.x, 0.47, cu.z - 0.12],
      },
      gunner: {
        frame: 'turret',
        eye: gEye,
        // the eyepiece and the bracket it hangs from (the view is H-02's)
        device: { type: 'sight', w: 0.05, h: 0.05, dist: 0.06 },
        seat: [0.46, -0.08, -0.02],
      },
      loader: {
        frame: 'turret',
        eye: lEye,
        look: [lYaw, -0.22],
        device: { type: 'none' },
        hatch: null,
        seat: [-0.78, -0.05, -0.55],
      },
      driver: {
        frame: 'hull',
        eye: drv,
        look: [0, 0],
        // the Ausf. G driver's periscope rotates: a wide arc
        device: periscope(drv),
        limits: { yaw: [-1.4, 1.4], pitch: [-0.2, 0.25] },
        hatch: { eye: [drv[0], roof + 0.62, drv[2] - 0.2] },
        seat: [drv[0], 1.24, drv[2] - 0.12],
      },
      radio: {
        frame: 'hull',
        eye: bow,
        look: [0, 0],
        // one fixed periscope, forward
        device: periscope(bow),
        limits: { yaw: [-0.6, 0.6], pitch: [-0.2, 0.25] },
        hatch: { eye: [bow[0], roof + 0.62, bow[2] - 0.2] },
        seat: [bow[0], 1.24, bow[2] - 0.12],
      },
    },
    breech: {
      type: 'vertical',
      pos: BR.pos,
      size: BR.size,
      recoilLength: 0.43,
      guardLength: 1.0,
      openTravel: 0.2,
      caliber: 75,
      caseLength: 0.64,
    },
    layout: {
      hull: { halfWidth, glacisTopZ, lowFrontY: 0.97, frontZ: 3.27 },
      // inside the welded turret: 0.95 ahead of the ring to 1.39 behind it,
      // ~1.9 m across at shoulder height; the 1.65 m ring; the platform hung
      // above the floor stowage and the shaft
      turret: { cz: -0.22, rx: 0.98, rz: 1.17, ringR: 0.83, basketY: -1.0 },
      // the sponson bins and the floor stowage are the damage model's boxes;
      // the KwK 42 case rim is ~0.1 m across
      racks: base.layout.racks.map((r) => ({ ...r, round: 0.085 })),
      // Fu 5 transmitter over receiver in the right sponson, beside him
      radio: { frame: 'hull', pos: [-1.18, H.sponsonY + 0.24, 1.98], size: [0.3, 0.42, 0.5] },
      shaft: base.layout.shaft ? { ...base.layout.shaft, size: 0.24 } : null,
      domeLight: { frame: 'turret', pos: [-0.15, 0.74, -0.65] },
      hatches: [
        { frame: 'turret', pos: [cu.x, t.h + cu.h - 0.05, cu.z], r: cu.r * 0.86, cupola: { r: cu.r, y0: t.h - 0.04, y1: t.h + cu.h - 0.04 } },
        { frame: 'hull', pos: [drv[0], roofY, drv[2] - 0.2], r: 0.24 },
        { frame: 'hull', pos: [bow[0], roofY, bow[2] - 0.2], r: 0.24 },
      ],
      extras: [
        // --- turret
        // TZF 12a: the tube from the eyepiece forward to the mantlet aperture
        { frame: 'turret', pos: [0.37, gEye[1], 0.62], cyl: true, r: 0.04, len: 0.6, axis: 'z', color: 0x2a2b28 },
        // elevation handwheel on the gunner's right, traverse handwheel ahead
        { frame: 'turret', pos: [0.29, 0.2, 0.3], cyl: true, r: 0.1, len: 0.03, axis: 'x', color: 0x2a2b28 },
        { frame: 'turret', pos: [0.56, 0.12, 0.42], cyl: true, r: 0.09, len: 0.03, axis: 'z', color: 0x2a2b28 },
        // the hydraulic traverse's rocking foot plate
        { frame: 'turret', pos: [0.48, -0.96, 0.38], size: [0.26, 0.03, 0.24], color: 0x2a2b28 },
        // the loader's periscope, roof front right
        { frame: 'turret', pos: [-0.38, 0.7, 0.5], size: [0.2, 0.13, 0.09] },
        // the close-defence weapon, roof right rear
        { frame: 'turret', pos: [-0.35, 0.69, -0.95], cyl: true, r: 0.06, len: 0.16 },
        // the turret ventilator fan housing, roof centre front
        { frame: 'turret', pos: [0, 0.72, 0.62], cyl: true, r: 0.09, len: 0.1 },
        // the big round hatch in the turret rear plate
        { frame: 'turret', pos: [0, 0.38, -1.37], cyl: true, r: 0.27, len: 0.03, axis: 'z' },
        { frame: 'turret', pos: [0, 0.38, -1.34], size: [0.3, 0.03, 0.03], color: 0x1c1d1b },
        // the case bag under the breech guard
        { frame: 'turret', pos: [0, -0.2, -0.45], size: [0.34, 0.3, 0.42], color: 0x4b4a3c },
        // the coaxial MG 34, right of the gun
        { frame: 'turret', pos: [-0.3, gm.y - 0.02, 0.62], size: [0.08, 0.1, 0.62], color: 0x2a2b28 },
        // --- hull
        // the bow MG 34 ball mount in the glacis, its gun and the KZF 2
        { frame: 'hull', pos: [-0.78, 1.5, 2.3], cyl: true, r: 0.12, len: 0.14, axis: 'z' },
        { frame: 'hull', pos: [-0.78, 1.5, 1.98], size: [0.08, 0.1, 0.5], color: 0x2a2b28 },
        { frame: 'hull', pos: [-0.78, 1.6, 2.06], cyl: true, r: 0.025, len: 0.36, axis: 'z', color: 0x2a2b28 },
        // the steering unit's brake housings either side of the gearbox
        { frame: 'hull', pos: [0.56, 1.0, 2.9], cyl: true, r: 0.2, len: 0.18, axis: 'x' },
        { frame: 'hull', pos: [-0.56, 1.0, 2.9], cyl: true, r: 0.2, len: 0.18, axis: 'x' },
        // the hydraulic traverse drive off the shaft, under the platform
        { frame: 'hull', pos: [0, 0.82, -0.1], size: [0.3, 0.18, 0.32] },
        // a hand extinguisher on the firewall
        { frame: 'hull', pos: [0.6, 1.35, H.rearZ + 0.12], cyl: true, r: 0.07, len: 0.45, color: 0x8a2a20 },
      ],
    },
  };
});
