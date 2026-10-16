import * as THREE from 'three';
import * as terrain from '../world/terrain.js';
// airfield.js imports terrain.js and the shared factories, never combat code,
// so this edge cannot close a cycle
import { groundSurfaceAt, groundHeightAt } from '../world/airfield.js';
// The village and the rocks: what a round meets before it can reach a tank
// behind them. scenery.js imports nothing from combat/, so no cycle.
import { propSegmentHit, damageProp } from '../world/scenery.js';
import { FUSE } from './internals.js';

const { terrainNormal } = terrain;
// Surface data is a wave-2 addition to terrain.js; a namespace import lets the
// file load whether or not it has landed yet.
const terrainSurface = typeof terrain.terrainSurface === 'function' ? terrain.terrainSurface : null;

// The SOLID ground a round can strike: the hillside, or an airfield's raised
// platform, runway and embankment where one stands above it. Testing
// terrainHeight alone let shells fly straight through the airfield.
// With no airfield registered every number here is terrainHeight/terrainNormal
// exactly.
const groundRec = { y: 0, kind: 'terrain', af: null };
// concrete is hard, bare and grey; consumers reading the terrain contract get a
// record of the same shape
const CONCRETE_SURFACE = {
  type: 'rock', grip: 1.05, drag: 0.04, dustColor: 0xb8b0a0, airfield: 'concrete',
};

// Normal of the ground `g` (a groundSurfaceAt record for x, z). The platform is
// level; the embankment is sampled the way terrainNormal samples the hills.
function groundNormalAt(g, x, z, out) {
  if (!g.af) return terrainNormal(x, z, out);
  if (g.kind !== 'berm') return out.set(0, 1, 0);
  const e = 0.6;
  out.set(
    groundHeightAt(x - e, z) - groundHeightAt(x + e, z),
    2 * e,
    groundHeightAt(x, z - e) - groundHeightAt(x, z + e),
  );
  return out.normalize();
}

const GRAVITY = 9.8;
const tmpM = new THREE.Matrix4();
const tmpL0 = new THREE.Vector3();
const tmpL1 = new THREE.Vector3();
const tmpMid = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpN = new THREE.Vector3();
// Module scope so the slab test does not build an array and an iterator on
// every one of its several hundred calls a frame.
const AXES = ['x', 'y', 'z'];

// Segment vs local-space AABB (slab method).
// Returns t (0..1 along the segment) and writes the local face normal into
// `outN`, or -1 for a miss. An out-parameter rather than a returned object
// because this runs against every tank on every aim ray, every frame.
function segmentVsBox(l0, l1, box, outN) {
  let tmin = 0;
  let tmax = 1;
  let axis = null;
  let sign = 0;
  for (let ai = 0; ai < 3; ai++) {
    const a = AXES[ai];
    const o = l0[a];
    const d = l1[a] - o;
    if (Math.abs(d) < 1e-9) {
      if (o < box.min[a] || o > box.max[a]) return -1;
      continue;
    }
    let t1 = (box.min[a] - o) / d;
    let t2 = (box.max[a] - o) / d;
    let s = -1; // hit the min face
    if (t1 > t2) {
      const swap = t1; // a destructuring swap here would allocate an array
      t1 = t2;
      t2 = swap;
      s = 1; // hit the max face
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = a;
      sign = s;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  if (axis === null) return -1; // segment starts inside
  outN.set(0, 0, 0);
  outN[axis] = sign;
  return tmin;
}

function zoneFromNormal(n) {
  if (Math.abs(n.z) >= Math.abs(n.x) && Math.abs(n.z) >= Math.abs(n.y)) {
    return n.z > 0 ? 'front' : 'rear';
  }
  if (Math.abs(n.y) >= Math.abs(n.x)) {
    return n.y > 0 ? 'top' : 'bottom';
  }
  return 'side';
}

// Reused across every intersectTank call: the aim ray tests every tank in the
// battle every frame, and a pair of object literals per tank per frame is pure
// garbage-collector pressure in the hottest path the ground battle has.
const partObj = [null, null];
const partBox = [null, null];
const tmpFaceN = new THREE.Vector3();
const tmpBestN = new THREE.Vector3();

// Test a world-space segment against one tank's hull + turret boxes.
// Returns nearest hit { t, point, isTurret, zone, angle, localY } or null.
export function intersectTank(tank, p0, p1) {
  if (!tank.group.visible) return null;
  partObj[0] = tank.group;
  partBox[0] = tank.hullBox;
  partObj[1] = tank.turretGroup;
  partBox[1] = tank.turretBox;
  let bestT = -1;
  let bestPart = -1;
  let bestLocalY = 0;
  for (let i = 0; i < 2; i++) {
    const obj = partObj[i];
    if (!obj || !partBox[i]) continue;
    obj.updateWorldMatrix(true, false);
    tmpM.copy(obj.matrixWorld).invert();
    const l0 = tmpL0.copy(p0).applyMatrix4(tmpM);
    const l1 = tmpL1.copy(p1).applyMatrix4(tmpM);
    const t = segmentVsBox(l0, l1, partBox[i], tmpFaceN);
    if (t >= 0 && (bestPart < 0 || t < bestT)) {
      bestT = t;
      bestPart = i;
      bestLocalY = l0.y + (l1.y - l0.y) * t;
      tmpBestN.copy(tmpFaceN);
    }
  }
  if (bestPart < 0) return null;

  const point = new THREE.Vector3().lerpVectors(p0, p1, bestT);
  const worldNormal = tmpN.copy(tmpBestN).transformDirection(partObj[bestPart].matrixWorld);
  const dir = tmpDir.subVectors(p1, p0).normalize();
  // incidence angle: 0 = square hit, pi/2 = full graze
  const cos = Math.abs(dir.dot(worldNormal));
  const angle = Math.acos(THREE.MathUtils.clamp(cos, 0, 1));

  return {
    t: bestT,
    point,
    isTurret: bestPart === 1,
    zone: zoneFromNormal(tmpBestN),
    angle,
    localY: bestLocalY,
    // travel direction and the plate's outward normal, both world-space —
    // the damage model traces the penetrator on through the internals
    dir: dir.clone(),
    normal: worldNormal.clone(),
  };
}

// Also used for the aim ray / penetration indicator.
// Returns { tank, hit } of the nearest tank intersected by the segment.
// `skip` is an optional array of tanks to pass over as well as `ignore` — a
// shell that has just skidded off a plate must not immediately hit it again.
export function intersectTanks(tanks, p0, p1, ignore = null, skip = null) {
  let bestTank = null;
  let bestHit = null;
  for (const tank of tanks) {
    if (tank === ignore || !tank.alive) continue;
    if (skip && skip.length && skip.indexOf(tank) !== -1) continue;
    // Cheap broad-phase: true perpendicular distance to the segment. The old
    // mid-point-and-half-length test never rejected anything for the 1400 m
    // aim ray, so every tank on the map paid for a matrix inversion each frame.
    if (segmentDistance(p0, p1, tank.position, tmpMid) > tank.radius + 4) continue;
    const hit = intersectTank(tank, p0, p1);
    if (hit && (!bestHit || hit.t < bestHit.t)) {
      bestHit = hit;
      bestTank = tank;
    }
  }
  return bestTank ? { tank: bestTank, hit: bestHit } : null;
}

// The fallback tracer, for a ShellManager built without the effects system:
// one box per shell. With effects (the battles), shells draw through the one
// tracer law in effects.js instead — no mesh, no draw call per shell (X-04).
const tracerGeo = new THREE.BoxGeometry(0.14, 0.14, 2.4);
const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd873 });
const Z_AXIS = new THREE.Vector3(0, 0, 1);
// shell tracer: the core width (bible 4-8 cm) and how long the composition
// burns (the streak dims over the last third, see TracerField). Its HDR peak
// is the tracer field's own, per colour (effects.js tracerHeatFor), so a red
// shell clears the bloom threshold as surely as an amber one.
const SHELL_TRACER_CORE = 0.07;
const SHELL_LIFE = 4.5;

// A round that skids away is still a round: it just does it with a fraction of
// the energy it arrived with. Two plate deflections is the practical ceiling —
// past that there is nothing left of the shot worth simulating.
export const MAX_RICOCHETS = 2;
const MAX_BOUNCES = 3;
// Below this incidence to the ground a solid shot skips off the slope instead
// of burying itself in it. Twelve degrees is where the real thing stops
// digging in and starts skating.
const GRAZE_ANGLE = 12 * Math.PI / 180;
// A deflected round has to be moving to be worth anything; under this it is
// spent regardless of how prettily it bounced.
const DEAD_SPEED = 60;
// How close a round has to pass before the listener hears it go by, and how
// far it must first get from him before that can count — otherwise the
// player's own muzzle blast registers as a near miss.
const FLYBY_RADIUS = 25;
const FLYBY_ARM = 35;

// Shell speed is roughly pen ^ (1/1.4) in the DeMarre sense, so a round that
// keeps 30% of its speed keeps rather less than 30% of its ability to beat
// armour — and it has already left part of itself in the first plate.
function penRetained(energy) {
  return clampf(Math.pow(energy, 1.4) * 0.92, 0.05, 0.8);
}

function clampf(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// A weakened round needs a weakened shell record, because everything
// downstream (shellPenAt in the damage model, the HUD indicator) reads
// penetration off the shell itself. Cloning it here is what makes penMul bite
// without a single call site having to know about it.
function derivedShell(base, penMul) {
  const out = Object.assign({}, base);
  out.pen = (base.pen || 0) * penMul;
  out.penMul = penMul;
  out.basePen = base.basePen !== undefined ? base.basePen : base.pen;
  return out;
}

const tmpSeg = new THREE.Vector3();
const tmpToL = new THREE.Vector3();
const tmpClose = new THREE.Vector3();
const tmpVdir = new THREE.Vector3();
const tmpNorm = new THREE.Vector3();
const tmpRef = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Scenery in the line of fire
//
// Every round is swept against the solid scenery (village buildings, standing
// or in ruins, and rocks — world/scenery.js propSegmentHit) inside the substep
// loop, BEFORE the tanks, and the tank test only runs up to the wall: a house
// between the gun and a hull always takes the round. A round that strikes one
// is finished there whatever it is — solid shot stops in the masonry, HE and
// HEAT burst on the face — and reaches the battle as an ordinary 'ground'
// impact at the wall (point on the face, normal out of it), so every battle's
// existing ground handler plays the dirt and runs the HE splash without
// knowing anything about houses. The extra fields on that record:
//   prop      the scenery prop that was struck
//   scenery   its kind ('house' | 'rock')
//   felled    true if this round brought the building down
// Shell-trees on the way are chipped (or felled) and cost the round nothing,
// as they always did — once per tree per round.
const WALL_SURFACE = {
  type: 'rock', grip: 1, drag: 0.04, dustColor: 0xa49a8a, scenery: 'masonry',
};
const ROCK_SURFACE = {
  type: 'rock', grip: 1, drag: 0.04, dustColor: 0x8f8a80, scenery: 'rock',
};
const TREES_ONLY = { treesOnly: true };
const propPush = { dirX: 0, dirZ: 0 };
const wallPoint = new THREE.Vector3();
const wallNormal = new THREE.Vector3();
// a burst is set this far off the face, so HE goes off in front of the wall
// rather than inside it
const WALL_STANDOFF = 0.06;
// a round's hit points on a building, as battle.js used to charge them
const DEFAULT_PROP_DAMAGE = 75;

// Shorten the segment origin -> end to the first solid scenery it meets past
// `past` (a point projected onto the segment — the tank itself, when the ray
// comes from a chase camera that may be sitting behind a house the gun is
// clear of). `end` is moved onto the face. Returns the struck prop, or null.
// The aim ray, the gun marker and anything else that has to stop on the wall
// the player is looking at.
const clipFrom = new THREE.Vector3();
export function clipRayToScenery(origin, end, past = null) {
  tmpSeg.subVectors(end, origin);
  const len2 = tmpSeg.lengthSq();
  if (!(len2 > 1e-9)) return null;
  let t0 = 0;
  if (past) {
    tmpToL.subVectors(past, origin);
    t0 = clampf(tmpToL.dot(tmpSeg) / len2, 0, 1);
    if (t0 >= 1) return null;
  }
  clipFrom.copy(origin).addScaledVector(tmpSeg, t0);
  const res = propSegmentHit(clipFrom, end, null);
  if (!res) return null;
  // Starting INSIDE a solid (a hull nosed into a gable corner) is no wall to
  // aim at — clipping there would lay the gun on the vehicle's own position.
  // The round itself still meets that wall at the muzzle.
  if (res.t * Math.sqrt(len2) * (1 - t0) < 0.02) return null;
  end.copy(res.point);
  return res.prop;
}

// A tank's gun run into a wall, a roof or a boulder: the barrel (turret ring
// to muzzle) against the same solids the rounds meet. Puts into `out` (a
// Vector3, y = 0) the horizontal shove that brings the muzzle back to the face
// it went in through, plus 5 cm, and returns true; false when the barrel is
// clear, or starts inside a solid (that is the hull push's business). Both
// battles apply it after solidPushOut has held the hull itself clear, so a
// tank driven or traversed against a house keeps its muzzle outside — its
// rounds then meet the wall in front of it rather than bursting inside it.
const gunRoot = new THREE.Vector3();
const gunTip = new THREE.Vector3();
export function barrelIntoWall(tank, out) {
  if (!tank || typeof tank.muzzleWorld !== 'function' || typeof tank.turretWorldPos !== 'function') return false;
  tank.turretWorldPos(gunRoot);
  tank.muzzleWorld(gunTip);
  const res = propSegmentHit(gunRoot, gunTip, null);
  if (!res || !(res.t > 0)) return false;
  const bx = res.point.x - gunTip.x;
  const bz = res.point.z - gunTip.z;
  const bl = Math.sqrt(bx * bx + bz * bz);
  if (bl < 1e-4) return false;
  const k = (bl + 0.05) / bl;
  out.set(bx * k, 0, bz * k);
  return true;
}

// A handler says "this one is still flying" either with the agreed string or
// by handing back the damage model's own deflection record. Both are accepted
// so the battle files can wire it whichever way reads better there; anything
// else consumes the round exactly as it always did.
function keepsFlying(verdict) {
  return verdict === 'continue' || !!(verdict && verdict.dir);
}

function deflectFrom(verdict, info) {
  if (info.deflect && info.deflect.dir) return info.deflect;
  return verdict && verdict.dir ? verdict : null;
}

// Perpendicular distance from the segment p0->p1 to `p`, closest point in `out`.
function segmentDistance(p0, p1, p, out) {
  tmpSeg.subVectors(p1, p0);
  const len2 = tmpSeg.lengthSq();
  let t = 0;
  if (len2 > 1e-9) {
    tmpToL.subVectors(p, p0);
    t = clampf(tmpToL.dot(tmpSeg) / len2, 0, 1);
  }
  out.copy(p0).addScaledVector(tmpSeg, t);
  return out.distanceTo(p);
}

// Will a round at `pos` flying along `vel` get abeam of `listener` without a
// wall in the way? (already abeam or past: yes). One scenery query, asked only
// for a round inside the fly-by radius that has not cracked yet.
const tmpAbeam = new THREE.Vector3();
function reachesAbeam(pos, vel, listener) {
  const v2 = vel.lengthSq();
  if (!(v2 > 1e-9)) return false;
  const t = ((listener.x - pos.x) * vel.x + (listener.y - pos.y) * vel.y + (listener.z - pos.z) * vel.z) / v2;
  if (t <= 0) return true;
  tmpAbeam.copy(pos).addScaledVector(vel, t);
  return !propSegmentHit(pos, tmpAbeam, null);
}

// Tracer colour by the shooter's nation (effects.js TRACER_COLOUR, linear),
// read off the effects module the manager was handed so this file needs no
// import of it.
function shellTracerColour(effects, shooter) {
  if (effects && typeof effects.tracerColourFor === 'function') return effects.tracerColourFor(shooter);
  return 0xffb050;
}

export class ShellManager {
  // effects (optional, contract R1-T): the battle's Effects. Given it, every
  // shell draws as a handle in its tracer field (effects.attachTracer /
  // moveTracer / killTracer); without it, the old box mesh per shell.
  constructor(scene, effects = null) {
    this.scene = scene;
    this.effects = effects && typeof effects.attachTracer === 'function' ? effects : null;
    this.shells = [];
    this._p0 = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  fire(desc) {
    const fx = this.effects;
    const vel = desc.dir.clone().multiplyScalar(desc.shell.speed);
    let mesh = null;
    let tracer = -1;
    if (fx) {
      tracer = fx.attachTracer(desc.pos, vel, {
        color: shellTracerColour(fx, desc.shooter),
        width: SHELL_TRACER_CORE,
        life: SHELL_LIFE,
      });
    } else {
      mesh = new THREE.Mesh(tracerGeo, tracerMat);
      mesh.position.copy(desc.pos);
      this.scene.add(mesh);
    }
    const kind = (desc.shell && desc.shell.kind) || desc.type || 'AP';
    this.shells.push({
      pos: desc.pos.clone(),
      vel,
      shell: desc.shell,
      type: desc.type,
      shooter: desc.shooter,
      origin: desc.pos.clone(),
      life: SHELL_LIFE,
      mesh,
      tracer,
      // set on the step a ricochet turns the round: its streak re-anchors
      turned: false,
      // --- ricochet continuation state ---
      kind,
      baseShell: desc.shell,
      penMul: 1,
      bounces: 0,
      ricochets: 0,
      // a chemical round bursts on whatever it touches; only solid shot skips
      solid: kind !== 'HE' && kind !== 'HEAT',
      ignore: [],
      travel: 0,
      // delay fuse, so the damage model can start the fragment cone at the
      // burst point rather than at the entry hole
      fuse: FUSE[kind] || null,
      flewBy: false,
      flybyArmed: false,
      // the last tree this round clipped, so a crown it is still inside on
      // the next substep is not charged twice
      lastTree: null,
    });
  }

  // onImpact(kind, info): kind = 'tank' | 'ground'
  //
  // opts (all optional): { listenerPos, onFlyby(kind, point, missDist), player }
  //
  // onImpact may return the string 'continue' for a hit that resolved as a
  // ricochet: the round is then reflected off the plate and flies on, carrying
  // whatever penetration it has left. Any other return value consumes it, so
  // every caller that predates this contract behaves exactly as it always did.
  update(dt, tanks, onImpact, opts = null) {
    const listener = opts && opts.listenerPos ? opts.listenerPos : null;
    const onFlyby = opts && opts.onFlyby ? opts.onFlyby : null;
    const player = opts && opts.player ? opts.player : null;
    const SUBSTEPS = 4;
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.life -= dt;
      let dead = s.life <= 0;
      const h = dt / SUBSTEPS;

      for (let step = 0; step < SUBSTEPS && !dead; step++) {
        const p0 = this._p0.copy(s.pos);
        s.vel.y -= GRAVITY * h;
        s.pos.addScaledVector(s.vel, h);
        s.travel += p0.distanceTo(s.pos);

        // A round is barred from the vehicle it just skidded off only while it
        // is still alongside it. Let it back in once it is clear and a mantlet
        // ricochet can still come down through the roof, which is exactly the
        // shot the whole feature exists for.
        for (let k = s.ignore.length - 1; k >= 0; k--) {
          const t = s.ignore[k];
          if (s.pos.distanceTo(t.position) > t.radius + 2.5) s.ignore.splice(k, 1);
        }

        // Scenery first: a wall or a rock on this step ends the step there, so
        // nothing behind it (a tank, the ground) can be reached through it.
        const wall = propSegmentHit(p0, s.pos, null);
        let wallProp = null;
        let segEnd = s.pos;
        if (wall) {
          wallProp = wall.prop;
          wallPoint.copy(wall.point);
          wallNormal.copy(wall.normal);
          segEnd = wallPoint;
        }
        this.sweepTrees(s, p0, segEnd);

        // The crack is for a round that goes PAST: measured along the stretch
        // it actually flew this substep, and — since it plays on the
        // approach, inside FLYBY_RADIUS — only if the round will get abeam of
        // the listener before a wall stops it. One stopped on a house in
        // front of you, or between you and the gun, is an impact.
        if (listener && onFlyby && !s.flewBy && (!player || s.shooter !== player)) {
          const miss = segmentDistance(p0, segEnd, listener, tmpClose);
          if (!s.flybyArmed) {
            if (miss > FLYBY_ARM) s.flybyArmed = true;
          } else if (miss < FLYBY_RADIUS
            && (wallProp ? tmpClose.distanceToSquared(segEnd) > 1e-6 : reachesAbeam(segEnd, s.vel, listener))) {
            s.flewBy = true;
            onFlyby('shell', tmpClose, miss);
          }
        }

        const res = intersectTanks(tanks, p0, segEnd, s.shooter, s.ignore);
        if (res) {
          const hit = res.hit;
          // after a bounce the straight line back to the muzzle is a lie —
          // pen falloff should follow the path the round actually flew
          hit.dist = s.bounces > 0 ? s.travel : s.origin.distanceTo(hit.point);
          hit.penMul = s.penMul;
          hit.fuse = s.fuse;
          hit.burstPoint = s.fuse
            ? hit.point.clone().addScaledVector(hit.dir, s.fuse.dist)
            : null;
          const info = {
            shell: s,
            target: res.tank,
            hit,
            kind: s.kind,
            fuse: s.fuse,
            penMul: s.penMul,
            bounces: s.bounces,
            ricochets: s.ricochets,
            // the damage model may write { dir, energy } here; when it does we
            // use its deflection instead of a mirror off the plate normal
            deflect: null,
          };
          const verdict = onImpact('tank', info);
          if (keepsFlying(verdict)
            && this.deflect(s, deflectFrom(verdict, info), hit.point, hit.normal, hit.angle, true)) {
            if (s.ignore.indexOf(res.tank) === -1) s.ignore.push(res.tank);
            continue;
          }
          dead = true;
          break;
        }

        if (wallProp) {
          this.hitScenery(s, wallProp, wallPoint, wallNormal, onImpact);
          dead = true;
          break;
        }

        const g = groundSurfaceAt(s.pos.x, s.pos.z, groundRec);
        const gy = g.y;
        if (s.pos.y <= gy) {
          const n = groundNormalAt(g, s.pos.x, s.pos.z, tmpNorm);
          const onConcrete = g.kind === 'concrete';
          tmpVdir.copy(s.vel).normalize();
          // incidence measured off the ground plane, not off its normal
          const inc = Math.asin(clampf(-tmpVdir.dot(n), -1, 1));
          const canGraze = s.solid
            && inc < GRAZE_ANGLE
            && inc > 0
            && s.bounces < MAX_BOUNCES
            && s.vel.lengthSq() > DEAD_SPEED * DEAD_SPEED;
          s.pos.y = gy + 0.1;
          const point = s.pos.clone();
          const info = {
            shell: s,
            point,
            kind: s.kind,
            normal: n.clone(),
            incidence: inc,
            graze: canGraze,
            surface: onConcrete
              ? CONCRETE_SURFACE
              : terrainSurface ? terrainSurface(point.x, point.z) : null,
            penMul: s.penMul,
            bounces: s.bounces,
            deflect: null,
          };
          const verdict = onImpact('ground', info);
          if ((canGraze || keepsFlying(verdict))
            && this.deflect(s, deflectFrom(verdict, info), point, info.normal, Math.PI / 2 - inc, false)) {
            // lift it clear of the slope it just skated off
            s.pos.y = Math.max(s.pos.y, groundHeightAt(s.pos.x, s.pos.z) + 0.35);
            continue;
          }
          dead = true;
          break;
        }
      }

      if (dead) {
        this.retire(s);
        this.shells.splice(i, 1);
      } else if (s.tracer >= 0) {
        this.effects.moveTracer(s.tracer, s.pos, s.vel, s.turned);
        s.turned = false;
      } else if (s.mesh) {
        s.mesh.position.copy(s.pos);
        this._dir.copy(s.vel).normalize();
        s.mesh.quaternion.setFromUnitVectors(Z_AXIS, this._dir);
      }
    }
  }

  // A shell's drawing goes with it: the streak handle killed, or the box
  // taken out of the scene.
  retire(s) {
    if (s.tracer >= 0 && this.effects) this.effects.killTracer(s.tracer);
    s.tracer = -1;
    if (s.mesh) this.scene.remove(s.mesh);
  }

  // A round has struck a wall or a rock: charge the building, set the round on
  // the face (or on the ground, if it dug in short of a footing that runs
  // underground) and report it through the ground path. The round is spent
  // whatever the handler answers — nothing continues through a house.
  hitScenery(s, prop, point, normal, onImpact) {
    propPush.dirX = s.vel.x;
    propPush.dirZ = s.vel.z;
    const dmg = (s.shell && s.shell.caliber) || DEFAULT_PROP_DAMAGE;
    const felled = damageProp(prop, dmg, propPush);
    s.pos.copy(point).addScaledVector(normal, WALL_STANDOFF);
    const gy = groundHeightAt(s.pos.x, s.pos.z);
    if (s.pos.y < gy + 0.1) s.pos.y = gy + 0.1;
    tmpVdir.copy(s.vel).normalize();
    const info = {
      shell: s,
      point: s.pos.clone(),
      kind: s.kind,
      normal: normal.clone(),
      incidence: Math.asin(clampf(-tmpVdir.dot(normal), -1, 1)),
      graze: false,
      surface: prop.kind === 'rock' ? ROCK_SURFACE : WALL_SURFACE,
      penMul: s.penMul,
      bounces: s.bounces,
      deflect: null,
      prop,
      scenery: prop.kind,
      felled,
    };
    onImpact('ground', info);
  }

  // Timber on the way: the nearest shell-tree this step crosses is chipped or
  // felled (damageProp's own hit points decide) and the round flies on.
  sweepTrees(s, a, b) {
    const tr = propSegmentHit(a, b, TREES_ONLY);
    if (!tr || tr.prop === s.lastTree) return;
    s.lastTree = tr.prop;
    propPush.dirX = s.vel.x;
    propPush.dirZ = s.vel.z;
    damageProp(tr.prop, (s.shell && s.shell.caliber) || DEFAULT_PROP_DAMAGE, propPush);
  }

  // Put a deflected round back into flight. `supplied` is the damage model's
  // own { dir, energy } when it had one; otherwise the round is mirrored about
  // the plate normal. Returns false when there is nothing left to deflect,
  // which is the caller's signal to consume the shell as usual.
  deflect(s, supplied, point, normal, angle, isPlate) {
    if (s.bounces >= MAX_BOUNCES) return false;
    if (isPlate && s.ricochets >= MAX_RICOCHETS) return false;
    const speed = s.vel.length();
    if (speed < DEAD_SPEED) return false;

    // The damage model's record is authoritative when it exists: it mirrored
    // the round off the SLOPED plate, which is a different direction and a very
    // different energy from a mirror off the axis-aligned collision box below.
    let energy = -1;
    if (supplied && supplied.dir) {
      // copy first: the record may be a plain {x,y,z} rather than a Vector3
      tmpRef.copy(supplied.dir);
      if (tmpRef.lengthSq() > 1e-6) {
        tmpRef.normalize();
        energy = clampf(supplied.energy === undefined ? 0.3 : supplied.energy, 0.15, 0.9);
      }
    }
    if (energy < 0) {
      if (!normal || normal.lengthSq() < 1e-6) return false;
      tmpRef.copy(s.vel).divideScalar(speed);
      const dn = tmpRef.dot(normal);
      if (dn > -1e-4) return false; // already travelling away from the surface
      tmpRef.addScaledVector(normal, -2 * dn);
      // a skid is never a clean mirror — the plate is not a mirror and the
      // round is not a billiard ball
      tmpRef.x += (Math.random() - 0.5) * 0.16;
      tmpRef.y += (Math.random() - 0.5) * 0.16;
      tmpRef.z += (Math.random() - 0.5) * 0.16;
      if (tmpRef.lengthSq() < 1e-6) return false;
      tmpRef.normalize();
      // the flatter the strike, the more of itself the round carries away:
      // barely-a-graze keeps most of it, a shot that only just failed to bite
      // has left the best part of its energy in the plate
      const a = angle === undefined || angle === null ? 1.05 : angle;
      energy = isPlate
        ? clampf(0.3 + (a - 1.05) * 0.75, 0.28, 0.72)
        : clampf(0.3 + (1 - (Math.PI / 2 - a) / GRAZE_ANGLE) * 0.35, 0.3, 0.65);
    }

    s.vel.copy(tmpRef).multiplyScalar(speed * energy);
    s.penMul *= penRetained(energy);
    s.shell = derivedShell(s.baseShell, s.penMul);
    s.bounces++;
    // the streak starts again from the bounce, not back along the new line
    s.turned = true;
    if (isPlate) s.ricochets++;
    // clear of the surface, along the way out and a little off the face, so
    // the next substep does not start inside what it just bounced off
    s.pos.copy(point).addScaledVector(tmpRef, 0.45);
    if (normal && normal.lengthSq() > 1e-6) s.pos.addScaledVector(normal, 0.18);
    return true;
  }

  dispose() {
    for (const s of this.shells) this.retire(s);
    this.shells.length = 0;
  }
}
