import * as THREE from 'three';
import { defineTankInterior } from './registry.js';
import { InteriorLayer } from './layer.js';
import { GeoBuilder, layerMesh, lin, ORDER_GLASS } from './common.js';

// INTERIOR: Flakpanzer IV (2 cm Flakvierling 38) "Wirbelwind", late 1944
// (Ostbau Sagan rebuilds of Panzer IV Ausf G/H/J hulls).
//
// Crew of five (tanks.js crew: 5):
//   hull, front LEFT (+X)   driver. Ausf J: no KFF binocular periscope any
//                           more, he drives through the Fahrersehklappe 50 —
//                           a sliding armoured visor over a thick laminated
//                           glass block in the vertical superstructure front
//                           plate. Two-piece hatch in the hull roof above him.
//   hull, front RIGHT (-X)  radio operator / hull gunner: MG 34 in the
//                           Kugelblende 50 ball mount, aimed through its KZF 2
//                           telescope (about 1.8x, narrow field); the FuG 5
//                           set sits on the gearbox housing on his left.
//   gearbox between them, propeller shaft back under the turret to the
//   Maybach HL 120 behind the firewall — the gun-tank hull is unchanged.
//   tub (open-topped nine-sided 16 mm "Keksdose", 1.05 m deep, NO turret
//   basket — the tub floor sits on the old turret ring):
//     gunner     on the Flakvierling's own seat, centre rear of the mount,
//                eye on the reflector sight above the cradle; two foot
//                pedals fire the diagonal gun pairs, two handwheels lay it.
//     commander  rear right, seated on a fold-down seat with his head over
//                the rim (the tub is open: there is no cupola, no vision
//                block — he simply looks out, and stands to see higher).
//     loader     right of the mount, crouched at the guns, changing the
//                20-round box magazines that feed each FlaK 38 from the side.
//                (Several accounts give the vehicle a second loader on the
//                left; the five-man spec here has one.)
//   Ammunition: 3,200 rounds in 20-round magazines — ready magazines in
//   racks round the lower tub wall, the rest in bins down both sponsons and
//   in floor bins under the tub (the damage model's ammo boxes).
//
// The four FlaK 38 are recoil-operated autocannon, not a gun with a breech
// block a loader rams: this file draws no framework breech (breech: null)
// and instead puts the four receivers and their magazines into the gun
// frame; each receiver kicks back when its gun fires, empties are thrown
// down onto the tub floor and a magazine is changed every 20 rounds.
//
// FRAMEWORK WORKAROUND (requested as a framework feature): an open-topped
// turret has no room to draw — the world IS the view from the tub — but the
// level-B layer always draws the hull room and its dark backstop, which in
// the tub would blank out the sky. A definition carrying `tub` therefore
// gets three small extensions to InteriorLayer, installed below and active
// ONLY for such a definition: extra geometry in the turret and gun frames
// (tub racks, gun receivers, sight, seats' fittings), the hull room hidden
// while the station is a tub station, and daylight instead of the dome lamp
// up there. Any other tank's layer is untouched.

const GUN_X = 0.337; // tanks.js quadGun: barrel columns +-0.337 m
const GUN_Y = 0.14; //                    rows +-0.14 m
const MAG_ROUNDS = 20;
const CASE_POOL = 10;

export default defineTankInterior('wirbelwind', (spec, base) => {
  const t = spec.turret; // w 2.0, h 1.05, len 2.3, offZ -0.15
  const H = base.layout.hull;
  const roof = H.roofY;
  // the Panzer IV's superstructure front plate stands vertical at
  // len/2 - 0.42 (tanks.js 'panzer4' stations), above a short ledge at 1.05
  const plateZ = spec.hull.len / 2 - 0.42; // 2.54
  const drv = [0.66, 1.42, plateZ - 0.24];
  const bow = [-0.58, 1.42, plateZ - 0.28];
  const cmd = [-0.42, t.h + 0.13, -0.64];
  const ldr = [-0.6, t.h + 0.07, 0.12];
  return {
    stations: {
      commander: {
        frame: 'turret',
        eye: cmd,
        look: [0, 0.04],
        device: { type: 'none' },
        // the wheel stands him up: head and shoulders over the rim
        hatch: { eye: [cmd[0], t.h + 0.5, cmd[2]], fov: 75, limits: { yaw: null, pitch: [-0.9, 1.45] } },
        limits: { yaw: null, pitch: [-0.85, 1.35] },
        fov: 70,
        seat: [cmd[0], 0.7, cmd[2] - 0.02],
      },
      gunner: {
        frame: 'turret',
        // the sight view is the H-02 optic; this eye only places the small
        // housing the framework draws for a 'sight' (here under the seat,
        // where it reads as the pedal box)
        eye: [0, 0.27, -0.6],
        device: { type: 'sight', w: 0.02, h: 0.02, dist: 0.12 },
        seat: [0, 0.75, -0.62],
      },
      loader: {
        frame: 'turret',
        eye: ldr,
        // across at the right-hand guns' magazines, and down
        look: [0.55, -0.8],
        device: { type: 'none' },
        hatch: { eye: [ldr[0], t.h + 0.5, ldr[2]], fov: 75, limits: { yaw: null, pitch: [-1.1, 1.45] } },
        limits: { yaw: null, pitch: [-1.2, 1.3] },
        fov: 72,
      },
      driver: {
        frame: 'hull',
        eye: drv,
        look: [0, 0],
        // Fahrersehklappe 50: the glass block is ~0.22 x 0.05 m
        device: { type: 'slit', w: 0.21, h: 0.045, dist: 0.17, bezel: 0.025, depth: 0.06 },
        limits: { yaw: [-0.32, 0.32], pitch: [-0.12, 0.12] },
        fov: 55,
        hatch: { eye: [drv[0], roof + 0.62, drv[2] - 0.3] },
        seat: [drv[0], 1.0, drv[2] - 0.28],
      },
      radio: {
        frame: 'hull',
        eye: bow,
        // KZF 2: the telescope rides the ball, so the window rides the look;
        // the world is seen from its objective in the ball (rise 0)
        device: { type: 'periscope', w: 0.05, h: 0.03, dist: 0.08, bezel: 0.012, depth: 0.04, rise: 0, fwd: 0.32 },
        limits: { yaw: [-0.26, 0.26], pitch: [-0.17, 0.3] },
        fov: 30,
        hatch: { eye: [bow[0], roof + 0.62, bow[2] - 0.3] },
        seat: [bow[0], 1.0, bow[2] - 0.28],
      },
    },
    breech: null,
    layout: {
      // the vertical Panzer IV front plate, not a long glacis
      hull: { glacisTopZ: plateZ - 0.04, lowFrontY: 1.02, frontZ: spec.hull.len / 2 - 0.06 },
      racks: [], // magazines are drawn by the tub extension (no round bases)
      // FuG 5 on the gearbox housing between driver and radio operator
      radio: { frame: 'hull', pos: [-0.1, 1.36, plateZ - 0.5], size: [0.4, 0.24, 0.28] },
      domeLight: { frame: 'hull', pos: [0, roof - 0.04, 0.9] },
      hatches: [
        { frame: 'hull', pos: [drv[0], roof, drv[2] - 0.3], r: 0.25 },
        { frame: 'hull', pos: [bow[0], roof, bow[2] - 0.3], r: 0.25 },
      ],
      extras: [
        // the superstructure front plate from the inside (behind both
        // windows: the holes cut it)
        { frame: 'hull', pos: [0, (1.05 + roof) / 2, plateZ - 0.02], size: [H.halfWidth * 2, roof - 1.05, 0.03] },
        // Fahrersehklappe 50: the visor housing round the glass block
        { frame: 'hull', pos: [drv[0], drv[1] + 0.05, plateZ - 0.05], size: [0.34, 0.05, 0.05], color: 0x2e302c },
        { frame: 'hull', pos: [drv[0], drv[1] - 0.05, plateZ - 0.05], size: [0.34, 0.05, 0.05], color: 0x2e302c },
        { frame: 'hull', pos: [drv[0] + 0.145, drv[1], plateZ - 0.05], size: [0.05, 0.05, 0.05], color: 0x2e302c },
        { frame: 'hull', pos: [drv[0] - 0.145, drv[1], plateZ - 0.05], size: [0.05, 0.05, 0.05], color: 0x2e302c },
        // the visor's operating lever
        { frame: 'hull', pos: [drv[0] + 0.2, drv[1] + 0.1, plateZ - 0.1], size: [0.03, 0.03, 0.14], color: 0x2e302c },
        // second set (FuG 2 receiver) beside the FuG 5
        { frame: 'hull', pos: [0.2, 1.33, plateZ - 0.5], size: [0.2, 0.18, 0.26], color: 0x3d4437 },
        // Kugelblende 50 ball and the MG 34 in it, under the KZF 2
        { frame: 'hull', pos: [bow[0], 1.33, plateZ - 0.03], cyl: true, r: 0.15, len: 0.06, axis: 'z', seg: 14 },
        { frame: 'hull', pos: [bow[0], 1.31, plateZ - 0.27], size: [0.07, 0.09, 0.42], color: 0x262724 },
        { frame: 'hull', pos: [bow[0], 1.22, plateZ - 0.4], size: [0.04, 0.12, 0.05], color: 0x262724 },
        // the belt bag on the MG's left
        { frame: 'hull', pos: [bow[0] + 0.1, 1.27, plateZ - 0.2], size: [0.08, 0.13, 0.15], color: 0x5b5040 },
        // fire extinguisher on the left sponson behind the driver
        { frame: 'hull', pos: [H.halfWidth - 0.14, H.sponsonY + 0.3, 1.45], cyl: true, r: 0.075, len: 0.5, color: 0x8a2a20 },
      ],
    },
    // what the tub extension draws and how it lights (wirbelwind-only keys)
    tub: {
      paint: typeof spec.color === 'number' ? spec.color : 0xb39a5f,
      gunSteel: 0x5a5d55,
      magazine: 0x44473f,
      // ready-magazine racks round the lower tub wall (turret frame)
      racks: [
        { x0: 0.56, x1: 0.7, z0: -0.6, z1: -0.05 },
        { x0: -0.7, x1: -0.56, z0: -0.42, z1: -0.02 },
      ],
      // sponson bins and floor bins (hull frame), from the damage boxes
      hullRacks: true,
      floorY: 0.075,
    },
  };
});

// ===========================================================================
// the open-tub extension of InteriorLayer (active only for a def with `tub`)
// ===========================================================================
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

// a rack of magazines standing on end, open on its inboard face (+/- x)
function magRack(b, cx, cy, cz, sx, sy, sz, inward, frameCol, magCol, tiers) {
  // back panel and the end plates
  b.box(cx - inward * (sx / 2 - 0.01), cy, cz, 0.02, sy, sz, frameCol);
  for (const e of [-1, 1]) b.box(cx, cy, cz + e * (sz / 2 - 0.01), sx, sy, 0.02, frameCol);
  const th = sy / tiers;
  const pitch = 0.075;
  const n = Math.max(1, Math.floor((sz - 0.06) / pitch));
  for (let k = 0; k < tiers; k++) {
    const y0 = cy - sy / 2 + k * th;
    // the shelf
    b.box(cx, y0 + 0.01, cz, sx, 0.02, sz, frameCol);
    // the magazines in it, their ends facing the crew
    for (let i = 0; i < n; i++) {
      const z = cz - sz / 2 + 0.03 + (i + 0.5) * ((sz - 0.06) / n);
      b.box(cx + inward * 0.005, y0 + 0.02 + (th - 0.05) / 2, z, sx - 0.03, th - 0.05, 0.055, magCol);
    }
    // the retaining bar across the front
    b.box(cx + inward * (sx / 2 - 0.01), y0 + th * 0.6, cz, 0.015, 0.015, sz, frameCol);
  }
}

function buildTub(layer) {
  const def = layer.def;
  const tub = def.tub;
  const col = layer.col;
  const paint = lin(tub.paint);
  const steel = lin(tub.gunSteel);
  const magC = lin(tub.magazine);
  const dark = col.dark;
  const ww = {
    receivers: [], mags: [], kick: [0, 0, 0, 0], fired: [0, 0, 0, 0], swap: [-1, -1, -1, -1],
    cases: [], caseNext: 0, lastAmmo: null, shots: 0, flash: 0, hullMeshes: [], tris: 0,
  };
  layer._ww = ww;
  const add = (group, b, mat, order) => {
    if (!b.count) return null;
    const m = layerMesh(b.build(), mat, order);
    group.add(m);
    ww.tris += b.count / 3;
    layer.stats.tris += b.count / 3;
    return m;
  };

  // ---- hull: magazine bins down both sponsons and on the floor
  if (tub.hullRacks) {
    const hb = new GeoBuilder();
    const H = def.layout.hull;
    for (const s of [-1, 1]) {
      // the damage model's ammoHull boxes: x +-1.09, y 1.35, z 0.36
      const cx = s * (H.halfWidth - 0.24);
      magRack(hb, cx, H.sponsonY + 0.32, 0.36, 0.4, 0.56, 1.8, -s, col.wall, magC, 3);
    }
    // floor bins either side of the propeller shaft, lids with hasps
    for (const s of [-1, 1]) {
      hb.box(s * 0.47, H.floorY + 0.12, -0.15, 0.42, 0.24, 1.0, col.wall);
      for (const z of [-0.45, -0.15, 0.15]) hb.box(s * 0.47, H.floorY + 0.245, z + 0.15, 0.4, 0.012, 0.012, dark);
    }
    add(layer.frames.hull, hb, layer.mats.lit);
  }
  // the hull room's own meshes (not the device groups that come later, not
  // the spark points): hidden while the head is up in the tub
  for (const c of layer.frames.hull.children) if (c.isMesh) ww.hullMeshes.push(c);

  // ---- tub (turret frame): racks, the mount's base ring, the gunner's
  // pedals and handwheels
  const tb = new GeoBuilder();
  const fy = tub.floorY;
  for (const r of tub.racks) {
    const inward = r.x0 > 0 ? -1 : 1;
    magRack(tb, (r.x0 + r.x1) / 2, fy + 0.16, (r.z0 + r.z1) / 2, Math.abs(r.x1 - r.x0), 0.32, Math.abs(r.z1 - r.z0), inward, paint, magC, 2);
  }
  const gm = def._gunMount;
  tb.cyl(0, fy + 0.03, gm[2], 0.46, 0.06, paint, { seg: 20 });
  tb.cyl(0, fy + 0.065, gm[2], 0.4, 0.012, dark, { seg: 20, caps: true });
  for (const s of [-1, 1]) {
    // foot pedals: each fires one diagonal pair
    tb.box(s * 0.12, fy + 0.07, -0.28, 0.08, 0.03, 0.16, dark);
    tb.bar([s * 0.12, fy + 0.06, -0.36], [s * 0.12, fy + 0.16, -0.22], 0.02, steel);
    // the laying handwheels in front of the seat, on their brackets
    tb.bar([s * 0.3, fy + 0.05, -0.5], [s * 0.3, 0.55, -0.42], 0.035, paint);
    tb.cyl(s * 0.34, 0.58, -0.42, 0.11, 0.025, dark, { axis: 'x', seg: 14 });
    tb.bar([s * 0.36, 0.58, -0.42], [s * 0.44, 0.58, -0.36], 0.02, dark);
  }
  add(layer.frames.turret, tb, layer.mats.lit);

  // ---- gun frame: the cradle, four FlaK 38 receivers with magazines (each
  // its own recoiling group), jackets, and the reflector sight
  const gun = layer.frames.gun;
  const gs = new GeoBuilder();
  gs.box(0, 0, -0.1, 0.5, 0.34, 0.6, steel); // the cradle (tanks.js quadGun)
  for (const y of [-GUN_Y, GUN_Y]) {
    gs.bar([-GUN_X, y + 0.075, -0.32], [GUN_X, y + 0.075, -0.32], 0.03, steel);
  }
  for (const x of [-GUN_X, GUN_X]) {
    for (const y of [-GUN_Y, GUN_Y]) {
      // the perforated jacket out to the front plate (inside the tub only)
      gs.cyl(x, y, 0.29, 0.062, 0.22, steel, { axis: 'z', seg: 10 });
    }
  }
  // reflector sight on its post over the cradle, in front of the gunner
  gs.bar([0, 0.17, -0.3], [0, 0.32, -0.3], 0.03, steel);
  gs.box(0, 0.36, -0.32, 0.12, 0.08, 0.16, steel);
  gs.box(0, 0.46, -0.26, 0.012, 0.11, 0.012, dark);
  add(gun, gs, layer.mats.lit);
  const glass = new GeoBuilder();
  glass.pushTR([0, 0.45, -0.262]);
  glass.rect(0.1, 0.075, lin(0x9fb3b0));
  glass.pop();
  add(gun, glass, layer.mats.glass, ORDER_GLASS);
  let gi = 0;
  for (const x of [GUN_X, -GUN_X]) {
    for (const y of [GUN_Y, -GUN_Y]) {
      const out = Math.sign(x);
      const g = new THREE.Group();
      g.name = `ivFlak${gi}`;
      gun.add(g);
      const rb = new GeoBuilder();
      rb.box(x, y, -0.16, 0.09, 0.12, 0.68, steel); // receiver
      rb.cyl(x, y, -0.53, 0.035, 0.06, dark, { axis: 'z', seg: 8 }); // buffer
      rb.box(x + out * 0.05, y, 0.06, 0.02, 0.1, 0.09, dark); // magazine well
      rb.bar([x, y - 0.06, -0.05], [x, y - 0.1, -0.05], 0.03, dark); // ejection chute
      add(g, rb, layer.mats.lit);
      const mg = new THREE.Group();
      g.add(mg);
      const mb = new GeoBuilder();
      // the 20-round box, in from the side, lying horizontal
      mb.box(x + out * 0.16, y, 0.06, 0.2, 0.1, 0.07, magC);
      mb.box(x + out * 0.255, y, 0.06, 0.012, 0.06, 0.03, dark);
      add(mg, mb, layer.mats.lit);
      ww.receivers.push(g);
      ww.mags.push({ group: mg, out });
      gi++;
    }
  }

  // ---- spent 20 x 138 mm B cases (turret frame), kept on the floor
  const cb = new GeoBuilder();
  cb.cyl(0, 0, 0, 0.0125, 0.138, col.brass, { axis: 'z', seg: 7 });
  const cgeo = cb.build();
  for (let i = 0; i < CASE_POOL; i++) {
    const m = layerMesh(cgeo, layer.mats.lit);
    m.visible = false;
    m.userData.shareGeo = i > 0;
    layer.frames.turret.add(m);
    ww.cases.push({ mesh: m, vel: new THREE.Vector3(), rest: true });
  }
  ww.caseGeo = cgeo;
  ww.tris += (cb.count / 3) * CASE_POOL;
}

function tubShot(layer, i) {
  const ww = layer._ww;
  ww.kick[i] = 1;
  ww.flash = 1;
  ww.fired[i]++;
  if (ww.fired[i] >= MAG_ROUNDS) {
    ww.fired[i] = 0;
    ww.swap[i] = 0; // the loader changes it
  }
  // the empty: out of the chute under the receiver, down to the floor
  const c = ww.cases[ww.caseNext];
  ww.caseNext = (ww.caseNext + 1) % ww.cases.length;
  const tf = layer.frames.turret.matrix;
  const g2t = _m.copy(tf).invert().multiply(layer.frames.gun.matrix);
  const x = i < 2 ? GUN_X : -GUN_X;
  const y = i % 2 === 0 ? GUN_Y : -GUN_Y;
  c.mesh.position.set(x, y - 0.12, -0.05).applyMatrix4(g2t);
  _q.setFromRotationMatrix(g2t);
  c.mesh.quaternion.copy(_q);
  c.vel.set((Math.random() - 0.5) * 0.6, -1.5, (Math.random() - 0.5) * 0.6).applyQuaternion(_q);
  c.rest = false;
  c.mesh.visible = true;
}

function animateTub(layer, dt) {
  const ww = layer._ww;
  const tank = layer.tank;
  // shots: the stream counter going down (resync whenever the layer was
  // hidden: firing from third person is not replayed when the player sits
  // back down; a rearm puts the counter up)
  const ammo = tank.streamAmmo | 0;
  if (ww.lastAmmo == null || ammo > ww.lastAmmo) ww.lastAmmo = ammo;
  let n = Math.min(8, ww.lastAmmo - ammo);
  ww.lastAmmo = ammo;
  // the guns fire in diagonal pairs (one pedal each): 0+3, then 1+2
  while (n-- > 0) {
    const k = ww.shots++ % 4;
    tubShot(layer, [0, 3, 1, 2][k]);
  }
  for (let i = 0; i < 4; i++) {
    ww.kick[i] = Math.max(0, ww.kick[i] - dt * 22);
    ww.receivers[i].position.z = -0.045 * Math.sin(Math.min(1, ww.kick[i]) * Math.PI * 0.5);
    // magazine change: out, gone, a full one in (1.6 s)
    const m = ww.mags[i];
    if (ww.swap[i] >= 0) {
      ww.swap[i] += dt / 1.6;
      const u = ww.swap[i];
      if (u >= 1) {
        ww.swap[i] = -1;
        m.group.position.set(0, 0, 0);
        m.group.visible = true;
      } else if (u < 0.3) {
        const k = u / 0.3;
        m.group.position.set(m.out * 0.22 * k, 0.05 * k, -0.05 * k);
        m.group.visible = true;
      } else if (u < 0.55) {
        m.group.visible = false;
      } else {
        const k = 1 - (u - 0.55) / 0.45;
        m.group.position.set(m.out * 0.3 * k, 0.12 * k, -0.08 * k);
        m.group.visible = true;
      }
    }
  }
  const fy = layer.def.tub.floorY + 0.0125;
  for (const c of ww.cases) {
    if (c.rest || !c.mesh.visible) continue;
    c.vel.y -= 9.8 * dt;
    c.mesh.position.addScaledVector(c.vel, dt);
    c.mesh.rotation.x += 9 * dt;
    if (c.mesh.position.y < fy) {
      c.mesh.position.y = fy;
      if (Math.abs(c.vel.y) < 0.5) {
        c.rest = true;
        c.mesh.rotation.set(0, c.mesh.rotation.y, 0);
      } else {
        c.vel.y = -c.vel.y * 0.3;
        c.vel.x *= 0.5;
        c.vel.z *= 0.5;
      }
    }
    // inside the tub floor
    c.mesh.position.x = Math.max(-0.68, Math.min(0.68, c.mesh.position.x));
    c.mesh.position.z = Math.max(-0.9, Math.min(0.6, c.mesh.position.z));
  }
}

// daylight for the open tub (after the framework's own closed-room lighting)
function lightTub(layer, dt) {
  const u = layer.u;
  const d = layer.day;
  const ww = layer._ww;
  const sky = d.skyCol;
  const ks = (0.35 + d.sky) / Math.PI;
  u.uAmb.value.set(sky[0] * ks + 0.02, sky[1] * ks + 0.02, sky[2] * ks + 0.02);
  u.uSunDir.value.copy(d.sunDir);
  const kk = d.sun / Math.PI;
  u.uSunCol.value.set(d.sunCol[0] * kk, d.sunCol[1] * kk, d.sunCol[2] * kk);
  u.uLampCol.value[0].set(0, 0, 0); // no dome lamp under the sky
  u.uLampCol.value[1].set(0, 0, 0);
  // the muzzle flashes ahead of the front plate
  if (ww.flash > 0) {
    const g = ww.flash * 0.9;
    u.uLampPos.value[2].set(0, 0, 0.75).applyMatrix4(layer.frames.gun.matrix);
    u.uLampCol.value[2].set(1.4 * g, 0.9 * g, 0.4 * g);
    u.uLampR.value[2] = 1.6;
    ww.flash = Math.max(0, ww.flash - dt * 14);
  } else if (!layer.tank.burning) {
    u.uLampCol.value[2].set(0, 0, 0);
  }
  // a spall flash reads against daylight, not against a dark room
  u.uLampCol.value[3].multiplyScalar(0.4);
  // smoke and fumes blow away in an open tub
  u.uSmoke.value *= 0.3;
}

function setSun(layer, on) {
  if (!on) layer.u.uSunCol.value.set(0, 0, 0);
}

const P = InteriorLayer.prototype;
if (!P.__tubExtension) {
  const build0 = P.build;
  const update0 = P.update;
  const dispose0 = P.dispose;
  const setVisible0 = P.setVisible;
  const spall0 = P._spall;
  // spall seen from the tub bursts in the tub, not in the hidden hull room
  P._spall = function _spall(point, dir) {
    spall0.call(this, point, dir);
    const ww = this._ww;
    if (!ww || !ww.inTub) return;
    const y0 = this.def.layout.hull.roofY + 0.3;
    const arr = this.sparks.geometry.attributes.position.array;
    const lift = Math.max(0, y0 - this.fx.flashPos.y);
    for (let i = 1; i < arr.length; i += 3) arr[i] += lift;
    this.fx.flashPos.y += lift;
  };
  P.setVisible = function setVisible(v) {
    if (!v && this._ww) this._ww.lastAmmo = null;
    return setVisible0.call(this, v);
  };
  P.build = function build() {
    build0.call(this);
    if (this.def && this.def.tub && this.frames.turret) {
      const g = this.tank && this.tank.spec && this.tank.spec.gunMount;
      this.def._gunMount = g ? [g.x || 0, g.y || 0, g.z || 0] : [0, 0.45, 0.3];
      buildTub(this);
    }
  };
  P.update = function update(dt, view) {
    const ww = this._ww;
    if (!ww) return update0.call(this, dt, view);
    animateTub(this, dt);
    update0.call(this, dt, view);
    const inTub = !!(view && view.station && view.station.frame === 'turret');
    ww.inTub = inTub;
    for (const m of ww.hullMeshes) m.visible = !inTub;
    if (inTub) lightTub(this, dt);
    else setSun(this, false);
    return undefined;
  };
  P.dispose = function dispose() {
    const ww = this._ww;
    if (ww) for (const c of ww.cases) if (c.mesh.userData.shareGeo) c.mesh.geometry = new THREE.BufferGeometry();
    dispose0.call(this);
    if (ww && ww.caseGeo) ww.caseGeo.dispose();
    this._ww = null;
  };
  Object.defineProperty(P, '__tubExtension', { value: true });
}
