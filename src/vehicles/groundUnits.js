import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { terrainHeight } from '../world/terrain.js';
import { inShadowBox } from '../world/scenery.js';
import { hasLOS } from '../ai/tankAI.js';
import { clamp, rand, wrapAngle, angleToward } from '../core/utils.js';
import {
  armourMaterial,
  steelMaterial,
  mattMaterial,
  glassMaterial,
} from '../core/materials.js';

const tmpV = new THREE.Vector3();
const tmpAim = new THREE.Vector3();
const tmpEye = new THREE.Vector3();
const tmpLos = new THREE.Vector3();
const tmpVel = new THREE.Vector3();

// V-09: no unlit team stripes on the ground units any more (the bright
// MeshBasic boxes read as UI painted into the world): which side a gun or a
// truck is on is the HUD marker's job, as it is for tanks and aircraft.

// ---------------------------------------------------------------------------
// AA gun tuning
// ---------------------------------------------------------------------------
//
// The old gun was a wall: 430 m of coverage, no reaction delay, no aspect
// penalty, 1.6 damage a round at 6.5 rounds a second. Four airfield guns put
// out 11.6 effective damage a second between them, which is a dead Zero (28 hp)
// in 2.4 seconds and a dead P-51 in 4.3. A bombing run takes longer than that,
// so the answer to "there is flak on that airfield" was "do not go there".
//
// The rework keeps the gun frightening and makes it beatable. Every number
// below was picked against a simulation of the real engagement — the same
// 520 m/s round, the same GRAVITY = 3 drop, the same segment-versus-hitbox test
// bullets.js runs — flown as a straight bombing pass and as a loiter. Damage
// per hit does most of the work (1.6 -> 0.55, a 2.9x cut); the rest of the cut
// is duty cycle, and everything else exists to give the pilot decisions.
//
// The shape it produces, against a four-gun airfield battery:
//   one low pass at 80 m over the guns   Zero 130% -> 56% of hp, P-51 55% -> 15%
//   one pass at 130 m, 60 m offset       Zero 106% -> 36% of hp, P-51 35% -> 11%
//   loitering on a 220 m circle          Zero dead in 14.3 s -> 33.3 s
// Nothing on the roster dies to a single run any more, and nothing survives
// hanging around. Time-to-kill is in the notes handed back with this file.

const AA_RANGE = 360;         // was 430; a 70 m trim off the bubble is ~2 s of exposure
const AA_DROP_RANGE = 400;    // hysteresis, so a target on the edge does not strobe
const AA_RETARGET = 0.9;
const AA_REACQUIRE_GAP = 0.5; // dead time after losing a track, before looking again

// Crew reaction. The single most important addition: nothing leaves the barrel
// for over a second after a NEW target is picked up, so a fast pass through the
// bubble is survivable in a way it simply was not before.
const AA_REACTION_MIN = 1.2;
const AA_REACTION_MAX = 1.8;

const AA_DAMAGE = 0.55;
const AA_MUZZLE = 520;
const AA_ROF = 6.5;
const AA_BURST_FIRE = 0.7;    // was 0.9
const AA_BURST_COOL = 2.8;    // was 2.4 — duty cycle 27.3% -> 20.0%

// Traverse and elevation. A towed mount is cranked round by hand; 2.0 rad/s was
// a powered turret. Slowing it is what gives a diving attacker a window, because
// the mount physically cannot stay with a target that crosses close and fast.
const AA_YAW_RATE = 1.4;
const AA_PITCH_RATE = 1.15;
const AA_MIN_PITCH = -0.05;
const AA_MAX_PITCH = 1.30;    // ~74.5 deg: there is a cone straight overhead it cannot reach

// Dispersion. The old error was a flat dist * 0.02 that knew nothing about
// aspect, so a full-deflection shot was as good as a head-on one. Now the base
// term is much tighter (a target boring straight in is a genuinely easy shot,
// better than it used to be) and the crossing term is large, so a beam pass is
// a hard one. Measured per-round hit chance against a Zero-sized box:
//        head-on            crossing
//   120 m   62% -> 72%        38% -> 50%
//   200 m   26% -> 50%        16% -> 25%
//   300 m   11% -> 29%         7% -> 14%
//   360 m    7% -> 21%         5% ->  8%
const AA_AIM_BASE = 0.011;
const AA_AIM_CROSS = 0.046;
const AA_AIM_SPINUP = 0.022;  // the first rounds of a burst are the wild ones
const AA_SPINUP_TIME = 0.45;
const AA_SPREAD_BASE = 0.016; // was a flat 0.05 passed to bullets.fire
const AA_SPREAD_CROSS = 0.034;
const AA_CROSS_REF = 115;     // m/s of crossing speed that counts as full deflection
const AA_FIRE_CONE = 0.16;    // must be laid this close before the crew will fire

// Losing the target. Hard manoeuvre, a fast crossing angle, or driving the
// mount off its bearing breaks the track; re-acquiring costs the full reaction
// delay again, which is what makes jinking worth doing.
const AA_TRACK_LOSS = 0.07;   // per second at full deflection
const AA_TRACK_FLOOR = 0.70;  // below this crossing fraction the crew holds on fine
const AA_TRACK_CONE = 1.0;    // rad of bearing error that breaks the track outright

// ---------------------------------------------------------------------------
// procedural geometry
// ---------------------------------------------------------------------------
//
// Every unit of a given type shares one set of merged geometries and one set of
// cached materials, so a fourteen-gun air battle costs the same handful of
// buffers and programs as a single gun. That matters more here than anywhere
// else in the game: the old constructor built six BoxGeometry and three
// materials PER GUN, which is 84 geometries and 42 materials for one air
// battle's worth of flak. This is six geometries and five materials in total,
// and it buys a lot more shape for them.
//
// Parts are merged by material rather than left as separate meshes, so the
// draw call count per unit is unchanged even though the triangle count is not.
// The renderer audit was explicit that draw calls are the scarce resource and
// triangles are not.

// Rotate in place, then translate, then optionally swing the whole part about
// the group origin — which is what an outrigger leg or a road wheel wants.
function place(geo, o = {}) {
  if (o.rx) geo.rotateX(o.rx);
  if (o.ry) geo.rotateY(o.ry);
  if (o.rz) geo.rotateZ(o.rz);
  geo.translate(o.x || 0, o.y || 0, o.z || 0);
  if (o.spin) geo.rotateY(o.spin);
  return geo;
}

function weld(list) {
  const merged = mergeGeometries(list);
  // mergeGeometries returns null only if the inputs disagree on attributes;
  // everything fed to it here is Box/Cylinder/Torus, which never do.
  if (!merged) return list[0];
  for (const g of list) g.dispose();
  merged.computeBoundingSphere();
  return merged;
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, s) => new THREE.CylinderGeometry(rt, rb, h, s);
const ring = (r, t, rs, ts, arc) => new THREE.TorusGeometry(r, t, rs, ts, arc);

// --- towed twin light flak -------------------------------------------------

let AA_GEO = null;
function aaGeometry() {
  if (AA_GEO) return AA_GEO;

  // Static base: cruciform outriggers on jack pads, with the road wheels still
  // slung on the side the way a towed mount carries them in action.
  const baseArm = [
    place(box(1.45, 0.40, 1.45), { y: 0.30 }),
  ];
  const baseDark = [
    place(cyl(0.60, 0.60, 0.13, 16), { y: 0.56 }),
    place(box(1.90, 0.10, 0.10), { y: 0.44, z: -0.15 }),
  ];
  for (let k = 0; k < 4; k++) {
    const spin = k * Math.PI / 2 + Math.PI / 4;
    baseArm.push(place(box(0.30, 0.16, 1.25), { y: 0.12, z: 1.15, spin }));
    baseDark.push(place(cyl(0.20, 0.24, 0.10, 8), { y: 0.05, z: 1.72, spin }));
  }
  for (const side of [-0.92, 0.92]) {
    baseDark.push(place(cyl(0.40, 0.40, 0.22, 14), { rz: Math.PI / 2, x: side, y: 0.44, z: -0.15 }));
    baseDark.push(place(cyl(0.14, 0.14, 0.26, 8), { rz: Math.PI / 2, x: side, y: 0.44, z: -0.15 }));
  }
  // ready ammunition, stacked where the loader stands
  baseArm.push(place(box(0.52, 0.26, 0.34), { x: 1.02, y: 0.13, z: -0.92, spin: 0.18 }));
  baseArm.push(place(box(0.52, 0.26, 0.34), { x: 1.02, y: 0.39, z: -0.92, spin: 0.18 }));
  baseArm.push(place(box(0.52, 0.26, 0.34), { x: 1.46, y: 0.13, z: -0.72, spin: -0.25 }));
  baseArm.push(place(box(0.44, 0.30, 0.30), { x: -1.22, y: 0.15, z: 0.92, spin: 0.35 }));

  // Traversing mount, seats and handwheels. Origin sits on the traverse ring.
  const mountArm = [
    place(cyl(0.44, 0.56, 0.46, 12), { y: 0.23 }),
    place(box(0.78, 0.30, 0.62), { y: 0.55 }),
    place(box(0.22, 0.22, 0.22), { x: 0.44, y: 0.60, z: 0.05 }),
  ];
  for (const side of [-0.36, 0.36]) {
    mountArm.push(place(box(0.13, 0.46, 0.24), { x: side, y: 0.72 }));
  }
  for (const side of [-0.62, 0.62]) {
    mountArm.push(place(box(0.32, 0.06, 0.30), { x: side, y: 0.60, z: -0.36 }));
    mountArm.push(place(box(0.32, 0.24, 0.06), { x: side, y: 0.72, z: -0.50 }));
    mountArm.push(place(box(0.10, 0.10, 0.42), { x: side, y: 0.55, z: -0.20 }));
    mountArm.push(place(ring(0.15, 0.032, 4, 10), { ry: Math.PI / 2, x: side * 0.84, y: 0.62, z: 0.10 }));
  }

  // Elevating cradle: breech, twin jacketed barrels with flash hiders, recoil
  // cylinder, magazines and an open sight.
  const cradleDark = [
    place(box(0.52, 0.32, 0.72), { y: 0.02, z: 0.10 }),
    place(cyl(0.065, 0.065, 1.05, 8), { rx: Math.PI / 2, y: 0.26, z: 0.72 }),
    place(box(0.18, 0.14, 0.30), { y: -0.18, z: -0.10 }),
    place(box(0.05, 0.05, 0.46), { y: 0.30, z: 0.32 }),
    place(ring(0.07, 0.016, 3, 8), { rx: Math.PI / 2, y: 0.34, z: 0.56 }),
  ];
  for (const side of [-0.165, 0.165]) {
    cradleDark.push(place(cyl(0.082, 0.082, 0.85, 8), { rx: Math.PI / 2, x: side, y: 0.06, z: 0.72 }));
    for (let k = 0; k < 3; k++) {
      cradleDark.push(place(ring(0.092, 0.020, 3, 8), { rx: Math.PI / 2, x: side, y: 0.06, z: 0.42 + k * 0.26 }));
    }
    cradleDark.push(place(cyl(0.050, 0.058, 0.95, 8), { rx: Math.PI / 2, x: side, y: 0.06, z: 1.62 }));
    cradleDark.push(place(cyl(0.095, 0.078, 0.18, 8), { rx: Math.PI / 2, x: side, y: 0.06, z: 2.19 }));
    cradleDark.push(place(box(0.20, 0.36, 0.26), { x: side * 2, y: 0.26, z: -0.02 }));
  }

  // Crew shield, split down the middle to leave the gunner a sight slot.
  const cradleArm = [
    place(box(0.62, 0.80, 0.09), { rx: -0.14, x: -0.46, y: 0.16, z: 0.52 }),
    place(box(0.62, 0.80, 0.09), { rx: -0.14, x: 0.46, y: 0.16, z: 0.52 }),
    place(box(0.34, 0.34, 0.09), { rx: -0.14, y: -0.11, z: 0.55 }),
    place(box(1.54, 0.10, 0.20), { rx: 0.50, y: 0.56, z: 0.50 }),
    place(box(0.09, 0.62, 0.40), { ry: 0.38, x: -0.79, y: 0.12, z: 0.36 }),
    place(box(0.09, 0.62, 0.40), { ry: -0.38, x: 0.79, y: 0.12, z: 0.36 }),
  ];

  AA_GEO = {
    baseArm: weld(baseArm),
    baseDark: weld(baseDark),
    mountArm: weld(mountArm),
    cradleDark: weld(cradleDark),
    cradleArm: weld(cradleArm),
  };
  return AA_GEO;
}

// --- supply truck ----------------------------------------------------------

let TRUCK_GEO = null;
function truckGeometry() {
  if (TRUCK_GEO) return TRUCK_GEO;

  const bodyArm = [
    place(box(1.60, 0.80, 1.15), { y: 1.15, z: 1.20 }),
    place(box(1.52, 0.10, 1.05), { y: 1.58, z: 1.22 }),
    place(box(1.30, 0.52, 1.15), { y: 1.00, z: 2.32 }),
    place(box(1.34, 0.16, 0.30), { y: 1.30, z: 1.85 }),
    place(box(1.78, 0.10, 2.70), { y: 1.00, z: -0.90 }),
    place(box(1.78, 0.52, 0.09), { y: 1.30, z: -2.20 }),
    place(box(1.78, 0.62, 0.09), { y: 1.35, z: 0.42 }),
  ];
  for (const side of [-0.78, 0.78]) {
    bodyArm.push(place(box(0.40, 0.14, 1.30), { x: side, y: 0.86, z: 2.15 }));
  }
  for (const side of [-0.87, 0.87]) {
    bodyArm.push(place(box(0.09, 0.52, 2.70), { x: side, y: 1.30, z: -0.90 }));
  }

  const dark = [
    place(box(1.16, 0.48, 0.10), { y: 1.00, z: 2.92 }),
    place(box(1.75, 0.15, 0.13), { y: 0.66, z: 3.00 }),
    place(cyl(0.07, 0.07, 1.60, 6), { rx: Math.PI / 2, x: 0.62, y: 0.40, z: 0.60 }),
    place(cyl(0.42, 0.42, 0.20, 12), { rz: Math.PI / 2, x: 0.95, y: 0.78, z: 0.10 }),
    place(box(0.60, 0.40, 0.50), { y: 1.25, z: -1.62 }),
  ];
  for (const side of [-0.58, 0.58]) {
    dark.push(place(box(0.14, 0.18, 4.30), { x: side, y: 0.62, z: 0.30 }));
  }
  for (const z of [1.60, 0.20, -1.40]) {
    dark.push(place(box(1.20, 0.10, 0.14), { y: 0.62, z }));
  }
  for (const z of [1.45, -0.80, -1.60]) {
    dark.push(place(box(1.70, 0.11, 0.11), { y: 0.44, z }));
    for (const side of [-0.78, 0.78]) {
      dark.push(place(cyl(0.44, 0.44, 0.26, 14), { rz: Math.PI / 2, x: side, y: 0.44, z }));
      dark.push(place(cyl(0.16, 0.16, 0.30, 8), { rz: Math.PI / 2, x: side, y: 0.44, z }));
    }
  }
  for (const side of [-0.52, 0.52]) {
    dark.push(place(cyl(0.13, 0.13, 0.13, 8), { rx: Math.PI / 2, x: side, y: 1.24, z: 2.90 }));
  }
  for (const side of [-0.44, 0.44]) {
    dark.push(place(cyl(0.24, 0.24, 0.60, 10), { x: side, y: 1.35, z: -2.00 }));
  }
  // bare tilt bows over the open rear of the bed
  for (const z of [-1.45, -1.95]) {
    dark.push(place(ring(0.86, 0.045, 3, 10, Math.PI), { y: 1.05, z }));
  }

  // Canvas tilt: a half cylinder laid along the bed. thetaLength = PI gives the
  // +X half shell; rotateX swings the axis onto Z and rotateZ brings the shell
  // over the top, which is an arch with closed ends — exactly a tarpaulin.
  const canvas = [
    place(cyl(0.86, 0.86, 1.55, 12).clone(), { }),
  ];
  canvas.length = 0;
  const tilt = new THREE.CylinderGeometry(0.86, 0.86, 1.55, 12, 1, false, 0, Math.PI);
  tilt.rotateX(Math.PI / 2);
  tilt.rotateZ(Math.PI / 2);
  tilt.translate(0, 1.05, -0.45);
  canvas.push(tilt);

  const glass = [
    place(box(1.42, 0.46, 0.06), { rx: -0.20, y: 1.40, z: 1.80 }),
    place(box(1.00, 0.30, 0.06), { y: 1.38, z: 0.63 }),
  ];
  for (const side of [-0.81, 0.81]) {
    glass.push(place(box(0.06, 0.38, 0.62), { x: side, y: 1.36, z: 1.25 }));
  }

  TRUCK_GEO = {
    bodyArm: weld(bodyArm),
    dark: weld(dark),
    canvas: weld(canvas),
    glass: weld(glass),
  };
  return TRUCK_GEO;
}

// ---------------------------------------------------------------------------
// shared materials
// ---------------------------------------------------------------------------

const aaBodyMat = () => armourMaterial(0x5a6152, { camo: 0x424736, wear: 0.6, scale: 1.1 });
const aaSteelMat = () => steelMaterial(0x33362f, { rough: 0.62, metal: 0.7, scale: 0.7 });
const truckBodyMat = () => armourMaterial(0x6e6a58, { camo: 0x4a4a3c, wear: 0.55, scale: 1.4 });
const truckSteelMat = () => steelMaterial(0x2f2f2b, { rough: 0.70, metal: 0.55, scale: 0.8 });
const canvasMat = () => mattMaterial(0x8a8168, { rough: 0.97, metal: 0 });

// One shared burnt-out material for every wreck on the map. The old darken()
// cloned a material per mesh per kill, which leaked a material and a shader
// program every time anything died and never got them back.
const wreckMat = () => mattMaterial(0x17181a, { rough: 0.98, metal: 0.1, flatShading: true });

function darken(group) {
  const m = wreckMat();
  group.traverse((o) => {
    if (o.isMesh && o.material) o.material = m;
  });
}

function meshOf(geo, mat, cast = true) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.userData.casts = cast;
  return m;
}

// P-03 / P-04: a unit's parts cast only while the unit is inside the sun's
// shadow box (with a 30 m margin for the box moving between checks); the
// guns and trucks of a far airfield otherwise sit in every frame's shadow
// pass list for nothing. Checked four times a second.
function gateShadows(unit, dt) {
  unit.shadowCheck = (unit.shadowCheck || 0) - dt;
  if (unit.shadowCheck > 0) return;
  unit.shadowCheck = 0.25;
  const p = unit.group.position;
  const want = inShadowBox(p.x, p.y + 1, p.z, (unit.radius || 3) + 30);
  if (want === unit.casting) return;
  unit.casting = want;
  unit.group.traverse((o) => {
    if (o.isMesh && o.userData.casts) o.castShadow = want;
  });
}

// Static anti-air gun: bursts of tracers at enemy planes. Dies to strafing
// runs and bombs. Shares the plane BulletManager for its fire.
export class AAGun {
  constructor(scene, team, x, z, index = 0) {
    this.scene = scene;
    this.team = team;
    this.displayName = `${team === 0 ? 'Ally' : 'Enemy'} AA-${index + 1}`;
    this.isGroundUnit = true;
    this.alive = true;
    this.hp = 20;
    this.radius = 2.8;

    const g = aaGeometry();
    const body = aaBodyMat();
    const dark = aaSteelMat();

    this.group = new THREE.Group();
    this.mount = new THREE.Group();
    this.mount.position.y = 0.62;
    this.cradle = new THREE.Group();
    this.cradle.position.y = 0.88;

    this.cradle.add(meshOf(g.cradleDark, dark), meshOf(g.cradleArm, body));
    this.mount.add(meshOf(g.mountArm, body), this.cradle);
    this.group.add(
      meshOf(g.baseArm, body),
      meshOf(g.baseDark, dark),
      this.mount,
    );
    this.group.position.set(x, terrainHeight(x, z), z);
    scene.add(this.group);

    this.yawG = rand(0, Math.PI * 2);
    this.pitchG = 0.4;
    this.target = null;
    this.retarget = rand(0, AA_RETARGET);
    this.reaction = 0;      // >0 while the crew is still getting on the target
    this.burstPhase = 0;    // >0 firing window, negative while cooling
    this.burstAge = 99;     // seconds into the current burst, drives spin-up error
    this.shotTimer = 0;
    this.soundTimer = 0;
  }

  get position() {
    return this.group.position;
  }

  eye(out) {
    out.copy(this.position);
    out.y += 1.6;
    return out;
  }

  // A new track always costs the full reaction delay, and always starts its
  // burst clock fresh — so a gun that has just re-acquired cannot punish you
  // with a burst it had already half spent on someone else.
  acquire(plane) {
    this.target = plane;
    this.reaction = rand(AA_REACTION_MIN, AA_REACTION_MAX);
    this.burstPhase = AA_BURST_FIRE;
    this.burstAge = 0;
  }

  dropTrack(gap) {
    this.target = null;
    this.retarget = gap;
  }

  update(dt, planes, bullets, onShotSound) {
    gateShadows(this, dt);
    if (!this.alive) return;

    this.retarget -= dt;

    if (this.target && (!this.target.alive
      || this.position.distanceTo(this.target.position) > AA_DROP_RANGE)) {
      this.dropTrack(AA_REACQUIRE_GAP);
    }

    if (!this.target && this.retarget <= 0) {
      this.retarget = AA_RETARGET;
      let best = Infinity;
      let pick = null;
      for (const pl of planes) {
        if (!pl.alive || pl.team === this.team) continue;
        const d = this.position.distanceTo(pl.position);
        if (d < AA_RANGE && d < best) {
          best = d;
          pick = pl;
        }
      }
      if (pick) this.acquire(pick);
    }

    const t = this.target;
    if (!t || !t.alive) return;

    const dist = this.position.distanceTo(t.position);
    const tof = dist / AA_MUZZLE;

    // How much of the target's velocity is across the line of sight rather than
    // along it. Zero for something boring straight in, which needs no lead and
    // no traverse; one for a fast beam pass, which needs both and gets neither
    // quite right. This is the term the old gun was missing entirely.
    this.eye(tmpEye);
    tmpLos.subVectors(t.position, tmpEye);
    const losLen = tmpLos.length() || 1;
    tmpLos.multiplyScalar(1 / losLen);
    tmpVel.copy(t.dir).multiplyScalar(t.speed || 0);
    const along = tmpVel.dot(tmpLos);
    const crossSpeed = Math.sqrt(Math.max(0, tmpVel.lengthSq() - along * along));
    const cross = clamp(crossSpeed / AA_CROSS_REF, 0, 1);

    this.reaction -= dt;
    if (this.reaction <= 0) this.burstAge += dt;
    const spin = this.burstAge < AA_SPINUP_TIME
      ? AA_AIM_SPINUP * (1 - this.burstAge / AA_SPINUP_TIME)
      : 0;

    // lead + bullet drop compensation, with aim error that now grows with both
    // range and crossing angle
    const err = dist * (AA_AIM_BASE + AA_AIM_CROSS * cross + spin);
    tmpAim.copy(t.position).addScaledVector(tmpVel, tof);
    tmpAim.y += 0.5 * 3 * tof * tof;
    tmpAim.x += rand(-err, err);
    tmpAim.y += rand(-err, err) * 0.7;
    tmpAim.z += rand(-err, err);
    const dx = tmpAim.x - this.position.x;
    const dy = tmpAim.y - this.position.y - 1.6;
    const dz = tmpAim.z - this.position.z;
    const desiredYaw = Math.atan2(dx, dz);
    const rawPitch = Math.atan2(dy, Math.hypot(dx, dz));
    const desiredPitch = clamp(rawPitch, AA_MIN_PITCH, AA_MAX_PITCH);
    this.yawG = angleToward(this.yawG, desiredYaw, AA_YAW_RATE * dt);
    this.pitchG = angleToward(this.pitchG, desiredPitch, AA_PITCH_RATE * dt);
    this.mount.rotation.y = this.yawG;
    this.cradle.rotation.x = -this.pitchG;

    const yawErr = Math.abs(wrapAngle(this.yawG - desiredYaw));

    // Track loss. Hard crossing wears the crew down gradually; running the
    // mount off its bearing, or climbing out of the elevation arc straight
    // overhead, breaks it at once. Either way the next shot is a whole
    // reaction delay away.
    let lose = AA_TRACK_LOSS * Math.max(cross - AA_TRACK_FLOOR, 0) / (1 - AA_TRACK_FLOOR);
    if (yawErr > AA_TRACK_CONE) lose += 1.2;
    if (rawPitch > AA_MAX_PITCH) lose += 1.6;
    if (lose > 0 && Math.random() < lose * dt) {
      this.dropTrack(AA_REACQUIRE_GAP);
      return;
    }

    // burst cycle: 0.7 s firing, 2.8 s cooling, and the clock does not start
    // until the crew is actually on the target
    if (this.reaction <= 0) {
      this.burstPhase -= dt;
      if (this.burstPhase < -AA_BURST_COOL) {
        this.burstPhase = AA_BURST_FIRE;
        this.burstAge = 0;
      }
    }
    const firing =
      this.reaction <= 0 &&
      this.burstPhase > 0 &&
      yawErr < AA_FIRE_CONE &&
      hasLOS(this.eye(tmpEye), tmpAim);

    this.shotTimer -= dt;
    this.soundTimer -= dt;
    if (firing && this.shotTimer <= 0) {
      this.shotTimer = 1 / AA_ROF;
      const dir = tmpV.set(
        Math.sin(this.yawG) * Math.cos(this.pitchG),
        Math.sin(this.pitchG),
        Math.cos(this.yawG) * Math.cos(this.pitchG),
      );
      const muzzle = tmpAim.copy(this.position).addScaledVector(dir, 2.2);
      muzzle.y += 1.6;
      bullets.fire(muzzle, dir, AA_MUZZLE, AA_DAMAGE, this,
        AA_SPREAD_BASE + AA_SPREAD_CROSS * cross);
      if (this.soundTimer <= 0) {
        this.soundTimer = 0.14;
        onShotSound?.(this);
      }
    }
  }

  takeDamage(dmg) {
    if (!this.alive) return false;
    this.hp -= dmg;
    if (this.hp <= 0) {
      this.alive = false;
      darken(this.group);
      return true;
    }
    return false;
  }

  dispose() {
    this.scene.remove(this.group);
  }
}

// Supply truck driving a circle route around the map center. Free tickets
// for whoever guns it down first.
export class Truck {
  constructor(scene, team, pathRadius, angle0, index = 0) {
    this.scene = scene;
    this.team = team;
    this.displayName = `${team === 0 ? 'Ally' : 'Enemy'} Truck-${index + 1}`;
    this.isGroundUnit = true;
    this.alive = true;
    this.hp = 18;
    this.radius = 2.4;
    this.pathRadius = pathRadius;
    this.angle = angle0;
    this.speedA = (team === 0 ? 1 : -1) * (7 / pathRadius); // rad/s

    const g = truckGeometry();
    this.group = new THREE.Group();
    this.group.add(
      meshOf(g.bodyArm, truckBodyMat()),
      meshOf(g.dark, truckSteelMat()),
      meshOf(g.canvas, canvasMat()),
      meshOf(g.glass, glassMaterial(0x8fb4c8, 0.42), false),
    );
    scene.add(this.group);
    this.place();
  }

  get position() {
    return this.group.position;
  }

  place() {
    const x = Math.sin(this.angle) * this.pathRadius;
    const z = Math.cos(this.angle) * this.pathRadius;
    this.group.position.set(x, terrainHeight(x, z), z);
    // heading = path tangent
    const yaw = this.angle + (this.speedA > 0 ? Math.PI / 2 : -Math.PI / 2);
    this.group.rotation.y = yaw;
  }

  update(dt) {
    gateShadows(this, dt);
    if (!this.alive) return;
    this.angle += this.speedA * dt;
    this.place();
  }

  takeDamage(dmg) {
    if (!this.alive) return false;
    this.hp -= dmg;
    if (this.hp <= 0) {
      this.alive = false;
      darken(this.group);
      return true;
    }
    return false;
  }

  dispose() {
    this.scene.remove(this.group);
  }
}
