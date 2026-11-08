import { defineTankInterior } from './registry.js';

// INTERIOR: Panzerkampfwagen VI Tiger Ausf. E, mid production (1944 spec
// year, tanks.js): 8.8 cm KwK 36 L/56, the low cast cupola with seven
// periscopes, the loader's roof periscope and the rear escape hatch, no
// driver's binocular periscope (KFF 2 deleted early 1943).
// Sources: tiger1.info (from the Henschel / Krupp drawings), Jentz & Doyle
// "Germany's Tiger Tanks", the Tigerfibel (D 656/27), Wikipedia "Tiger I" and
// "8.8 cm KwK 36". Figures marked *verify* were not found in a primary source.
//
// Crew (left = +X):
//   - driver, hull front LEFT beside the Maybach Olvar gearbox; drives through
//     the Fahrersehklappe, the armoured visor in the 100 mm front plate (a
//     thick glass block behind a slit when shut). Steering WHEEL for the
//     regenerative L 600 C steering gear, with the two brake levers either
//     side; a fixed periscope in the roof over his hatch (the outside model
//     draws it), instruments on his left.
//   - radio operator, hull front RIGHT, the MG 34 in the Kugelblende ball
//     mount with the KZF 2 (1.8x) sight: the view rides the look, inside the
//     ball's +-15 / -10..+20 deg arc. The Fu 5 sets sit on a shelf over the
//     gearbox, to his left.
//   - gunner, turret LEFT of the gun, well forward, at the TZF 9b binocular
//     sight on the gun's left (the view is the H-02 sight); elevation handwheel
//     at his right hand, manual traverse handwheel ahead, the rocking foot
//     plate of the Boehringer-Sturm hydraulic traverse under his feet.
//   - commander, turret LEFT REAR behind the gunner, raised seat under the
//     cupola: seven periscopes, one dead ahead, hatch lid swinging aside.
//   - loader, turret RIGHT of the gun, standing on the turret platform; round
//     roof hatch over him, a fixed periscope in the roof front right, the
//     coaxial MG 34 right of the gun, the big spring equilibrator in front of
//     him, the escape hatch in the right rear wall.
//   - no basket: a full circular platform hung from the turret, 1.57 m below
//     the roof, over the propeller shaft and the under-floor stowage. Most of
//     the 92 rounds lie in four closed bins per sponson, lengthwise, noses
//     forward (the middle two of each side 16 rounds each).
// KwK 36: semi-automatic VERTICAL falling wedge, electric firing; recoil
// 580 mm *verify*; 88 x 571 mm R case. The gun is 5.32 m overall against the
// 4.24 m the model draws ahead of the trunnions, so the breech face sits
// 1.08 m behind them — almost at the turret's centre — and full recoil comes
// back to 0.4 m short of the rear wall, past the commander's knees.
// Paint: Elfenbein (ivory) inside, the framework's German default.

export default defineTankInterior('tiger', (spec, base) => {
  const t = spec.turret; // w 2.10, h 0.86, len 2.52, offZ 0.20
  const H = base.layout.hull;
  const roof = spec.hull.trackH + spec.hull.h; // 1.78, hull frame
  const roofY = H.roofY; // 1.75 inside (26 mm roof)
  const cu = spec.shape.cupola; // r 0.27, h 0.36, z -0.72, left
  const cupX = t.w * 0.26; // tanks.js: cs * t.w * 0.26
  const blockY = t.h + cu.h * 0.62;
  const gmY = t.h * 0.48; // tanks.js default gun mount: y 0.413, z 0.857
  const gmZ = t.len * 0.34;

  // ---- hull: the 9-degree driver's plate. tanks.js 'slab' puts its outside
  // face at z 2.32 (roof) .. 2.45 (y 1.05); 100 mm of plate puts the inside
  // 0.10 m further back. The space ahead of it under the glacis shelf is the
  // steering gear and final drives, not crew room.
  const glacisTopZ = 2.22;
  const frontZ = 2.36;
  const lowFrontY = 0.98;
  const plateZ = (y) => glacisTopZ + ((roofY - y) / (roofY - lowFrontY)) * (frontZ - glacisTopZ);

  // the driver's eye 0.27 m behind the plate's inside face: the visor's glass
  // block sits in a 0.1 m holder on the plate, his chest behind the wheel
  const drv = [0.85, roofY - 0.16, 1.98];

  // the Kugelblende exactly where tanks.js draws it: x = -w * 0.2, y = ySp +
  // (roof - ySp) * 0.45 = 1.39 for the Tiger (r 0.15, its face at z 2.51, the
  // MG barrel out to z 2.85). The KZF 2's objective sits in the ball ABOVE the
  // MG; the camera goes just ahead of the ball's face so neither the ball nor
  // the barrel fills the view.
  const ball = [-spec.hull.w * 0.2, 1.39];
  const bow = [ball[0], ball[1] + 0.12, 2.06];
  const bowFwd = 2.54 - bow[2];
  const bowHatchX = -0.85; // the hull roof hatch, mirror of the driver's

  // ---- gun: breech ring 0.40 x 0.35 x 0.46, rear face 1.08 m behind the
  // trunnions (gun frame z)
  const brRear = 1.08;
  const BR = { size: [0.4, 0.35, 0.46] };
  // the ring's top rear edge, at full recoil and the full -8 deg depression,
  // comes to y 0.413 + 0.175 cos 8 + 1.66 sin 8 = 0.818 in the turret frame,
  // under the 0.82 inside roof (40 mm roof plate, 1944): 0.35 m is as tall as
  // the ring can be in the drawn turret
  BR.pos = [0, 0, -(brRear - BR.size[2] / 2)];
  const breechFaceZ = gmZ - brRear; // turret frame, in battery

  const gEye = [0.4, gmY + 0.06, 0.25];
  const lEye = [-0.6, 0.58, -0.55]; // beside and behind the breech face, clear of the recoil
  const lYaw = Math.atan2(0 - lEye[0], breechFaceZ - lEye[2]);
  const lPitch = Math.atan2(gmY - lEye[1], Math.hypot(lEye[0], breechFaceZ - lEye[2]));
  const lHatch = [-0.5, -0.3]; // round roof hatch over the loader (x, z)
  const lPeri = [-t.w * 0.28, t.len * 0.2]; // tanks.js roof periscope, right

  const dark = 0x2a2b28;
  const binDoor = 0xb9b197;

  // steering wheel: a ring of beads in the x-y plane (extras are boxes and
  // cylinders), hub and two spokes
  const wheel = [];
  {
    const c = [drv[0], 1.34, 2.12];
    const r = 0.18;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      wheel.push({ frame: 'hull', pos: [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r, c[2]], size: [0.05, 0.05, 0.03], color: dark });
    }
    wheel.push({ frame: 'hull', pos: c, cyl: true, r: 0.04, len: 0.05, axis: 'z', color: dark });
    wheel.push({ frame: 'hull', pos: c, size: [r * 2, 0.025, 0.02], color: dark });
    // the column down to the steering gear
    wheel.push({ frame: 'hull', pos: [c[0], c[1] - 0.2, c[2] + 0.08], size: [0.05, 0.4, 0.05], color: 0x4a4d48 });
  }

  // closed sponson bin doors on the inboard face of each side's bins: four
  // compartments per side (the damage model's ammoHull boxes)
  const doors = [];
  for (const r of base.layout.racks) {
    if (r.face !== 'px' && r.face !== 'nx') continue;
    const s = r.center[0] > 0 ? 1 : -1;
    const x = r.center[0] - s * (r.size[0] / 2 + 0.008);
    // the bin's closed aft end plate: the rounds lie noses forward with their
    // bases against it, so (the framework draws them on the aft face) cover
    // them — a closed bin shows doors, not brass
    doors.push({ frame: 'hull', pos: [r.center[0], r.center[1], r.center[2] - r.size[2] / 2 - 0.012], size: [r.size[0], r.size[1], 0.014], color: binDoor });
    const n = 4;
    for (let i = 0; i < n; i++) {
      const z = r.center[2] - r.size[2] / 2 + (i + 0.5) * (r.size[2] / n);
      doors.push({ frame: 'hull', pos: [x, r.center[1], z], size: [0.014, r.size[1] * 0.86, r.size[2] / n - 0.05], color: binDoor });
      doors.push({ frame: 'hull', pos: [x - s * 0.02, r.center[1] + r.size[1] * 0.25, z], size: [0.025, 0.04, 0.12], color: dark });
    }
  }

  return {
    stations: {
      commander: {
        frame: 'turret',
        eye: [cupX, blockY, cu.z],
        look: [0, 0],
        // seven periscopes in the low cast cupola, one dead ahead
        device: { type: 'blocks', count: 7, radius: cu.r * 0.9, y: blockY, w: 0.11, h: 0.06, lean: 0.07, phase: 0 },
        hatch: { eye: [cupX, t.h + cu.h + 0.5, cu.z], fov: 70 },
        // raised seat under the cupola, outboard of the recoil guard (the
        // damage model's commander box sits on the other side; drawn seat only)
        seat: [cupX, 0.5, cu.z - 0.12],
      },
      gunner: {
        frame: 'turret',
        eye: gEye,
        // the TZF 9b eyepiece and its bracket (the view is H-02's)
        device: { type: 'sight', w: 0.1, h: 0.045, dist: 0.06 },
        seat: [0.46, -0.03, -0.02],
      },
      loader: {
        frame: 'turret',
        // standing on the platform right of the breech, facing its face
        eye: lEye,
        look: [lYaw, lPitch],
        device: { type: 'none' },
        hatch: { eye: [lHatch[0], t.h + 0.6, lHatch[1]], fov: 70 },
        // his folding seat against the right wall
        seat: [-0.74, 0.0, -0.5],
      },
      driver: {
        frame: 'hull',
        eye: drv,
        look: [0, 0],
        // the visor's glass block, 0.16 m ahead of the eye, short of the
        // plate's inside face
        device: { type: 'slit', w: 0.24, h: 0.04, dist: plateZ(drv[1]) - drv[2] - 0.09, bezel: 0.035, depth: 0.09 },
        limits: { yaw: [-0.42, 0.42], pitch: [-0.14, 0.12] },
        fov: 55,
        hatch: { eye: [drv[0], roof + 0.62, 1.66] },
        seat: [drv[0], 1.125, 1.78],
      },
      radio: {
        frame: 'hull',
        eye: bow,
        look: [0, 0],
        // KZF 2 through the ball mount: the eyepiece rides the look (a
        // periscope with no rise), the world seen from the ball's face
        device: { type: 'periscope', w: 0.05, h: 0.036, dist: 0.07, rise: 0, fwd: bowFwd, bezel: 0.02, depth: 0.05 },
        limits: { yaw: [-0.26, 0.26], pitch: [-0.17, 0.34] },
        // KZF 2: 1.8x, an 18-degree true field
        fov: 26,
        hatch: { eye: [bowHatchX, roof + 0.62, 1.66] },
        seat: [bow[0], 1.07, 1.8],
      },
    },
    breech: {
      type: 'vertical',
      pos: BR.pos,
      size: BR.size,
      recoilLength: 0.58,
      guardLength: 1.1,
      openTravel: 0.15,
      caliber: 88,
      caseLength: 0.571,
    },
    layout: {
      hull: { glacisTopZ, frontZ, lowFrontY },
      // inside the horseshoe: 100 mm front, 80 mm sides; the 1.85 m ring; the
      // platform 1.57 m below the roof
      turret: { rx: 0.97, rz: 1.17, y1: t.h - 0.04, ringR: 0.9, basketY: t.h - 0.04 - 1.57 },
      // sponson rounds lie lengthwise, noses forward: their bases face aft.
      // 88 x 571 R rim ~0.11 m.
      racks: base.layout.racks.map((r) => ({ ...r, face: r.face === 'px' || r.face === 'nx' ? 'nz' : r.face, round: 0.095 })),
      // the gearbox, cut back at the front plate (the steering unit lies
      // under the glacis shelf ahead of it)
      transmission: { frame: 'hull', pos: [0, 0.83, 1.94], size: [1.1, 0.62, 0.58] },
      // Fu 5 transmitter and receiver on their shelf over the gearbox
      radio: { frame: 'hull', pos: [-0.42, 1.58, 1.95], size: [0.36, 0.26, 0.3] },
      domeLight: { frame: 'turret', pos: [-0.2, 0.78, -0.45] },
      hatches: [
        { frame: 'turret', pos: [cupX, t.h + cu.h - 0.05, cu.z], r: cu.r * 0.86, cupola: { r: cu.r, y0: t.h - 0.04, y1: t.h + cu.h - 0.04 } },
        { frame: 'turret', pos: [lHatch[0], t.h - 0.04, lHatch[1]], r: 0.24 },
        { frame: 'hull', pos: [drv[0], roofY, 1.62], r: 0.25 },
        { frame: 'hull', pos: [bowHatchX, roofY, 1.62], r: 0.25 },
      ],
      extras: [
        // --- turret
        // TZF 9b: the binocular tube from the eyepiece to the mantlet
        { frame: 'turret', pos: [0.33, gEye[1], 0.78], cyl: true, r: 0.045, len: 0.76, axis: 'z', color: dark },
        // elevation handwheel at the gunner's right hand, traverse handwheel ahead
        { frame: 'turret', pos: [0.24, 0.24, 0.3], cyl: true, r: 0.1, len: 0.03, axis: 'x', color: dark },
        { frame: 'turret', pos: [0.6, 0.16, 0.42], cyl: true, r: 0.1, len: 0.03, axis: 'z', color: dark },
        // the hydraulic traverse's rocking foot plate
        { frame: 'turret', pos: [0.46, t.h - 0.04 - 1.57 + 0.03, 0.32], size: [0.26, 0.03, 0.24], color: dark },
        // coaxial MG 34 right of the gun, and its belt bag
        { frame: 'turret', pos: [-0.22, gmY + 0.02, 0.9], size: [0.08, 0.11, 0.5], color: dark },
        { frame: 'turret', pos: [-0.24, gmY - 0.14, 0.72], size: [0.12, 0.14, 0.1], color: 0x5a4b36 },
        // the spring equilibrator in front of the loader
        { frame: 'turret', pos: [-0.46, 0.3, 0.86], cyl: true, r: 0.085, len: 0.58, color: 0x4a4d48 },
        // the loader's fixed periscope, roof front right
        { frame: 'turret', pos: [lPeri[0], t.h - 0.1, lPeri[1]], size: [0.18, 0.11, 0.1] },
        // the escape hatch in the right rear wall
        { frame: 'turret', pos: [-0.45, 0.42, -1.04], cyl: true, r: 0.22, len: 0.03, axis: 'z' },
        // the roof ventilator over the breech
        { frame: 'turret', pos: [0, t.h - 0.07, 0.5], cyl: true, r: 0.09, len: 0.06 },
        // the commander's auxiliary traverse handwheel
        { frame: 'turret', pos: [cupX + 0.12, 0.62, cu.z + 0.3], cyl: true, r: 0.08, len: 0.025, axis: 'z', color: dark },
        // --- hull
        ...wheel,
        // the driver's roof periscope (outside: tanks.js) seen from below
        { frame: 'hull', pos: [spec.hull.w * 0.2, roofY - 0.06, 1.88], size: [0.18, 0.12, 0.1] },
        // the ball mount in the front plate and the MG 34 under the sight
        { frame: 'hull', pos: [ball[0], ball[1], plateZ(ball[1]) + 0.02], cyl: true, r: 0.14, len: 0.06, axis: 'z' },
        { frame: 'hull', pos: [ball[0], ball[1] - 0.01, plateZ(ball[1]) - 0.22], size: [0.08, 0.09, 0.4], color: dark },
        // the KZF 2 tube from the eyepiece forward into the ball, over the MG
        { frame: 'hull', pos: [bow[0], bow[1], (bow[2] + 0.08 + plateZ(bow[1])) / 2], cyl: true, r: 0.025, len: plateZ(bow[1]) - bow[2] - 0.08, axis: 'z', color: dark },
        // fire extinguisher on the left sponson wall behind the driver
        { frame: 'hull', pos: [H.halfWidth - 0.15, H.sponsonY + 0.3, 1.62], cyl: true, r: 0.07, len: 0.45, color: 0x8a2a20 },
        ...doors,
        // the visor's operating handwheel, right of and below the glass block
        { frame: 'hull', pos: [drv[0] - 0.2, drv[1] - 0.09, plateZ(drv[1]) - 0.06], cyl: true, r: 0.06, len: 0.025, axis: 'z', color: dark },
      ],
    },
  };
});
