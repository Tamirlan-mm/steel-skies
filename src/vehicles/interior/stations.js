import { buildInternals, crewRoles } from '../../combat/internals.js';

// Default crew stations, interior layout and breech for ANY tank spec, worked
// out from the spec's own dimensions and from the damage model's module boxes
// (combat/internals.js buildInternals), so the seats, racks and gearbox seen
// from inside are the very boxes the X-ray draws and the shells hit.
//
// FRAMES. Every position is [x, y, z] in one of three frames:
//   'hull'   tank.group: +Z nose, +Y up, +X LEFT; y = 0 is the ground plane
//            the hull stands on, the hull roof is trackH + h
//   'turret' tank.turretGroup: origin on the hull roof at turret.offZ,
//            turns with turretYaw; the turret roof is turret.h
//   'gun'    tank.gunGroup: origin on the trunnions, elevates with the gun;
//            +Z along the bore (the breech is at negative z)
// A per-vehicle file overrides any of it (registry.js mergeDef).

// Station roles in cycle order (the key steps through them, then back to
// the third-person view). 'gunner' is the existing H-02 sniper optic.
export const STATION_ORDER = ['commander', 'driver', 'loader', 'radio', 'gunner'];

export const STATION_LABEL = {
  commander: 'COMMANDER',
  driver: 'DRIVER',
  loader: 'LOADER',
  radio: 'BOW GUNNER',
  gunner: 'GUNNER',
};

export const DEVICE_LABEL = {
  periscope: 'PERISCOPE',
  blocks: 'VISION BLOCKS',
  slit: 'VISION SLIT',
  hatch: 'HATCH OPEN',
  none: 'INTERIOR',
  sight: 'SIGHT',
};

// Device defaults by type. dist: eye to the window (m); w x h: the window;
// bezel / depth: its frame; rise / fwd: periscope head above / ahead of the
// eyepiece (the world is seen from there, the interior from the eye).
export const DEVICE_DEFAULTS = {
  periscope: { w: 0.17, h: 0.05, dist: 0.07, bezel: 0.014, depth: 0.05, rise: null, fwd: 0.06 },
  blocks: { count: 6, w: 0.13, h: 0.075, bezel: 0.02, depth: 0.06, lean: 0.12, radius: null, y: null },
  slit: { w: 0.22, h: 0.035, dist: 0.12, bezel: 0.03, depth: 0.08 },
  hatch: {},
  none: {},
};

// Look limits by device (radians, relative to the station's own forward);
// yaw null = all the way round.
const LIMITS = {
  periscope: { yaw: [-1.05, 1.05], pitch: [-0.22, 0.3], fov: 52 },
  blocks: { yaw: null, pitch: [-0.24, 0.26], fov: 60 },
  slit: { yaw: [-0.45, 0.45], pitch: [-0.14, 0.14], fov: 55 },
  hatch: { yaw: null, pitch: [-0.75, 0.95], fov: 70 },
  none: { yaw: [-2.4, 2.4], pitch: [-1.05, 0.75], fov: 72 },
};

export function limitsFor(type) {
  return LIMITS[type] || LIMITS.none;
}

// Interior paint: every nation in the roster painted the fighting
// compartment a light colour (US / UK white, German ivory, Soviet white or
// pale grey-green) so the crew could see what they were doing.
const WALL_BY_NATION = {
  USA: 0xd8d4c6,
  Britain: 0xd6d3c4,
  Germany: 0xd7cfb3,
  USSR: 0xc9cdbf,
};

export function defaultColors(spec) {
  return {
    wall: WALL_BY_NATION[spec.nation] || 0xd2cfc2,
    floor: 0x57534a,
    metal: 0x4a4d48,
    dark: 0x1c1d1b,
    brass: 0xb08d4a,
    seat: 0x4b3b2c,
    radio: 0x3d4437,
    glass: 0x9fb3b0,
    lamp: 0xfff1cc,
  };
}

function boxesOf(spec) {
  const out = {};
  for (const m of buildInternals(spec)) out[m.key] = m;
  return out;
}

const arr = (v) => [v.x, v.y, v.z];

// Everything a station, a layout and a breech need, for one spec.
export function deriveTankInterior(spec) {
  const { w, h, len, trackH } = spec.hull;
  const t = spec.turret;
  const sh = spec.shape || {};
  const floor = (spec.hull.clear ?? trackH * 0.45) + 0.05;
  const roof = trackH + h; // hull roof, hull frame
  const box = boxesOf(spec);
  const roles = crewRoles(spec);
  const casemate = sh.turret === 'casemate';
  const open = !!sh.openTurret;
  const rearDrive = !!(spec.chassis && spec.chassis.sprocket && spec.chassis.sprocket.z < 0);
  const dSide = sh.driverRight ? -1 : 1;
  const trackW = (spec.chassis && spec.chassis.trackW) || 0.4;
  const shell0 = spec.shells ? spec.shells[Object.keys(spec.shells)[0]] : null;
  const caliber = (shell0 && shell0.caliber) || 75;

  // ---- the hull compartment (fighting + driving), forward of the firewall
  const eng = box.engine;
  const firewall = eng ? eng.pos.z + eng.half.z + 0.04 : -len * 0.18;
  const frontZ = len / 2 - 0.08;
  const slope = ((spec.armor && spec.armor.hullSlope && spec.armor.hullSlope.front) || 30) * (Math.PI / 180);
  const yLowFront = floor + (roof - floor) * 0.32;
  const glacisRun = Math.min(len * 0.32, Math.max(0.15, (roof - 0.03 - yLowFront) * Math.tan(slope)));
  const hull = {
    floorY: floor,
    roofY: roof - 0.03,
    frontZ,
    rearZ: rearDrive ? Math.min(firewall, -len / 2 + 0.3) : firewall,
    firewallZ: firewall,
    halfWidth: w / 2 - 0.07,
    lowerHalfWidth: Math.max(0.5, w / 2 - trackW - 0.06),
    sponsonY: trackH + 0.02,
    glacisTopZ: frontZ - glacisRun,
    lowFrontY: yLowFront,
  };

  // ---- the turret room, in the turret frame
  const turret = casemate || open
    ? null
    : {
      cz: 0,
      rx: t.w / 2 - 0.07,
      rz: t.len / 2 - 0.07,
      y0: -0.03,
      y1: t.h - 0.05,
      ringR: Math.min(t.w, w) * 0.4,
      basketY: floor - roof, // basket floor on the hull floor, turret frame
    };

  // ---- crew stations
  const cu = sh.cupola || {};
  const cs = sh.cupolaRight ? -1 : 1;
  const hasCupola = !!(sh.cupolaLeft || sh.cupolaRight || sh.cupola);
  const cr = cu.r ?? t.w * 0.19;
  const cHgt = cu.h ?? 0.3;
  const cupX = cu.x ?? cs * t.w * 0.26;
  const cupZ = cu.z ?? -t.len * 0.28;
  // the vision blocks sit at 0.62 of the cupola height (tanks.js)
  const blockY = t.h + cHgt * 0.62;
  const lh = sh.loaderHatch || null;
  const seat = (role) => (box[`crew_${role}`] ? arr(box[`crew_${role}`].pos) : null);

  const stations = {};
  // In a casemate or an open turret the "turret" crew stand in the hull frame
  // under a fixed roof; the gunner keeps his sight, the others look over the
  // side (hatch) — per-vehicle files refine this.
  const tFrame = casemate ? 'hull' : 'turret';
  const tY = (y) => (casemate ? y + roof : y);
  const tZ = (z) => (casemate ? z + t.offZ : z);

  if (roles.includes('commander')) {
    if (hasCupola && !open) {
      stations.commander = {
        frame: tFrame,
        eye: [cupX, tY(blockY), tZ(cupZ)],
        look: [0, 0],
        device: { type: 'blocks', count: 6, radius: cr * 0.93, y: tY(blockY) },
        hatch: { eye: [cupX, tY(t.h + cHgt + 0.55), tZ(cupZ)] },
        seat: seat('commander'),
      };
    } else {
      const cx = cs * t.w * 0.24;
      const cz = -t.len * 0.22;
      stations.commander = {
        frame: tFrame,
        eye: [cx, tY(open ? t.h + 0.45 : t.h - 0.14), tZ(cz)],
        look: [0, 0],
        device: open ? { type: 'hatch' } : { type: 'periscope', rise: 0.24 },
        hatch: open ? null : { eye: [cx, tY(t.h + 0.62), tZ(cz)] },
        seat: seat('commander'),
      };
    }
  }

  if (roles.includes('driver')) {
    const d = box.crew_driver;
    const dx = d ? d.pos.x : dSide * w * 0.24;
    const dz = Math.min(d ? d.pos.z + 0.08 : len * 0.3, hull.glacisTopZ - 0.12);
    const eyeY = hull.roofY - 0.16;
    stations.driver = {
      frame: 'hull',
      eye: [dx, eyeY, dz],
      look: [0, 0],
      device: { type: 'periscope', rise: roof + 0.1 - eyeY },
      hatch: { eye: [dx, roof + 0.62, dz] },
      seat: seat('driver'),
    };
  }

  if (roles.includes('loader') && !open) {
    const l = box.crew_loader;
    const lx = lh ? lh.x : l ? l.pos.x : -cs * t.w * 0.26;
    const lz = lh ? lh.z + 0.12 : l ? l.pos.z : 0;
    const ly = (turret ? turret.y1 : t.h) - 0.32;
    // he faces the breech: across and a little forward
    const g = spec.gunMount || {};
    const gx = g.x ?? 0;
    const gz = (g.z ?? t.len * 0.34) - 0.6;
    const yaw = Math.atan2(gx - lx, gz - lz);
    stations.loader = {
      frame: tFrame,
      eye: [lx, tY(ly), tZ(lz)],
      look: [yaw, -0.32],
      device: { type: 'none' },
      hatch: lh ? { eye: [lh.x, tY(t.h + 0.6), tZ(lh.z)] } : null,
      seat: seat('loader'),
    };
  }

  if (roles.includes('radio')) {
    const r = box.crew_radio;
    const rx = r ? r.pos.x : -dSide * w * 0.26;
    const rz = Math.min(r ? r.pos.z + 0.08 : len * 0.28, hull.glacisTopZ - 0.12);
    const eyeY = hull.roofY - 0.16;
    stations.radio = {
      frame: 'hull',
      eye: [rx, eyeY, rz],
      look: [0, 0],
      device: { type: 'periscope', rise: roof + 0.1 - eyeY },
      hatch: { eye: [rx, roof + 0.62, rz] },
      seat: seat('radio'),
    };
  }

  if (roles.includes('gunner')) {
    const gnr = box.crew_gunner;
    const gEye = gnr ? [gnr.pos.x, tY(t.h * 0.55), tZ(gnr.pos.z + 0.25)] : [t.w * 0.22, tY(t.h * 0.55), tZ(0.1)];
    stations.gunner = {
      frame: tFrame,
      // the gunner's view is the H-02 sight (battle sniper view); this eye
      // only places his seat and his sight housing in the interior
      eye: gEye,
      device: { type: 'sight' },
      seat: seat('gunner'),
      // wave 7: his look-around view beside the sight (E toggles). The
      // default is a seated view in the turret, head back off the
      // eyepiece; a per-vehicle file gives him his own vision device
      // (periscope) where the real tank had one.
      vision: {
        frame: tFrame,
        eye: [gEye[0], gEye[1] + 0.04, gEye[2] - 0.16],
        look: [0, -0.06],
        device: { type: 'none' },
      },
    };
  }

  // ---- the gun's breech, in the gun frame
  const bw = Math.min(0.5, Math.max(0.18, caliber * 0.0036));
  const bl = Math.min(0.95, Math.max(0.3, caliber * 0.0058));
  const brType = spec.nation === 'USSR' && caliber >= 100 ? 'screw'
    : spec.nation === 'Germany' || spec.nation === 'Britain' ? 'horizontal'
      : 'vertical';
  const breech = {
    type: brType,
    pos: [0, 0, -(0.18 + bl / 2)],
    size: [bw, bw * 0.95, bl],
    recoilLength: Math.min(0.6, Math.max(0.2, caliber * 0.0042)),
    guardLength: Math.max(0.6, bl * 1.4),
    openTravel: bw * 0.62,
    caliber,
    caseLength: Math.min(0.9, Math.max(0.25, caliber * 0.0072)),
  };

  // ---- racks, seats, radio, gearbox, from the module boxes
  const racks = [];
  for (const key of ['ammoHullL', 'ammoHullR', 'ammoFloor', 'ammoTurret']) {
    const b = box[key];
    if (!b) continue;
    const face = key === 'ammoFloor' ? 'py' : key === 'ammoTurret' ? 'pz' : b.pos.x > 0 ? 'nx' : 'px';
    racks.push({
      frame: b.frame === 'turret' ? tFrame : 'hull',
      center: b.frame === 'turret' ? [b.pos.x, tY(b.pos.y), tZ(b.pos.z)] : arr(b.pos),
      size: [b.half.x * 2, b.half.y * 2, b.half.z * 2],
      face,
      round: caliber / 1000,
    });
  }
  const tr = box.transmission;
  const layout = {
    hull,
    turret,
    racks,
    radio: roles.includes('radio')
      ? { frame: 'hull', pos: [-dSide * w * 0.18, hull.sponsonY + 0.2, (box.crew_radio ? box.crew_radio.pos.z : len * 0.28) - 0.45], size: [0.42, 0.26, 0.3] }
      : turret
        ? { frame: 'turret', pos: [0, t.h * 0.45, -t.len / 2 + 0.28], size: [0.5, 0.28, 0.3] }
        : null,
    transmission: tr && !rearDrive ? { frame: 'hull', pos: arr(tr.pos), size: [tr.half.x * 2, tr.half.y * 2, tr.half.z * 2] } : null,
    // a rear engine driving front sprockets runs a propeller shaft under the
    // fighting compartment
    shaft: !rearDrive && eng ? { frame: 'hull', from: [0, floor + 0.12, firewall], to: [0, floor + 0.12, tr ? tr.pos.z - tr.half.z : len * 0.25], size: 0.3 } : null,
    traverse: box.traverse ? { frame: tFrame, pos: box.traverse.frame === 'turret' ? [box.traverse.pos.x, tY(box.traverse.pos.y), tZ(box.traverse.pos.z)] : arr(box.traverse.pos), size: [box.traverse.half.x * 1.4, box.traverse.half.y * 1.6, box.traverse.half.z * 1.4] } : null,
    domeLight: turret ? { frame: 'turret', pos: [0, turret.y1 - 0.03, -t.len * 0.12] } : { frame: 'hull', pos: [0, hull.roofY - 0.04, 0] },
    hatches: [],
    extras: [],
  };
  if (hasCupola && turret) layout.hatches.push({ frame: 'turret', pos: [cupX, t.h + cHgt - 0.05, cupZ], r: cr * 0.86, cupola: { r: cr, y0: t.h - 0.04, y1: t.h + cHgt - 0.04 } });
  if (lh && turret) layout.hatches.push({ frame: 'turret', pos: [lh.x, t.h - 0.04, lh.z], r: lh.r * 0.95 });
  if (stations.driver) layout.hatches.push({ frame: 'hull', pos: [stations.driver.eye[0], hull.roofY, stations.driver.eye[2] - 0.15], r: 0.27 });
  if (stations.radio) layout.hatches.push({ frame: 'hull', pos: [stations.radio.eye[0], hull.roofY, stations.radio.eye[2] - 0.15], r: 0.27 });

  return {
    id: spec.id,
    colors: defaultColors(spec),
    stations,
    breech: turret || casemate ? breech : null,
    layout,
    devices: {},
    // how hard the head rides the hull (station movement shake), 0..2
    shake: 1,
  };
}

// The gunner's look-around through the roof periscope on his side of the
// turret (wave 7) — the one the outside model draws there (tanks.js: two
// roof periscopes at x = +-0.28 w, z = 0.2 len, on every closed turret).
// A per-vehicle file uses it where the real gunner had such a periscope:
//   gunner: { vision: gunnerPeriscope(spec, gunnerEye, { yaw: [-0.4, 0.4] }) }
// The eye moves up to its eyepiece under the roof; index.js puts the
// aperture just outside the head the outside model draws (device.headAt).
export function gunnerPeriscope(spec, gunnerEye, opts = {}) {
  const t = spec.turret;
  const casemate = spec.shape && spec.shape.turret === 'casemate';
  const roof = spec.hull.trackH + spec.hull.h;
  const side = (gunnerEye && gunnerEye[0] < 0) ? -1 : 1;
  const hx = side * t.w * 0.28;
  const hz = t.len * 0.2 + (casemate ? t.offZ : 0);
  const top = t.h + (casemate ? roof : 0);
  // under and behind the periscope's body (a per-vehicle file may draw it
  // there as an extra): eyepiece at its foot, 0.24 under the roof skin
  const eye = [hx, top - 0.05 - (opts.drop ?? 0.24), hz - (opts.back ?? 0.14)];
  return {
    frame: casemate ? 'hull' : 'turret',
    eye,
    look: [0, 0],
    device: {
      type: 'periscope', w: opts.w ?? 0.12, h: opts.h ?? 0.045, dist: opts.dist ?? 0.08,
      rise: top + 0.0375 - eye[1], fwd: 0.06, headAt: [hx, hz],
    },
    limits: { yaw: opts.yaw || [-0.35, 0.35], pitch: opts.pitch || [-0.2, 0.25] },
    fov: opts.fov ?? 50,
  };
}
