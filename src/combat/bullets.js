import * as THREE from 'three';
// The solid ground: terrainHeight, plus any airfield platform, runway and
// embankment standing above it (exactly terrainHeight where there is none).
// airfield.js never imports combat code, so this cannot close a cycle.
import { groundHeightAt } from '../world/airfield.js';
// Walls and rocks stop rounds (world/scenery.js; it imports nothing from
// combat/, so no cycle).
import { propSegmentHit } from '../world/scenery.js';
// X-04: the one tracer law, material and streak (effects.js imports nothing
// from here, so no cycle).
import {
  createTracerMaterial, tracerGeometry, attachTracerViewHook, tracerColourFor,
  tracerLength, TRACER_CORE, TRACER_CORE_BULLET, tracerHeatFor, markRange,
} from './effects.js';

const MAX = 280;
// Every round is drawn as its tracer streak (the game's aiming feedback).
// Design flag, OFF: draw only the belt's real tracer share, about one round
// in four or five (verify per nation) — more realistic and less cluttered,
// but it takes the feedback away, so it is the game designer's call.
export const BELT_TRACERS_ONLY = false;
const BELT_RATIO = 4;
// the streak's quad width: the bullet's tracer core over the core share
const QUAD_W = TRACER_CORE_BULLET / TRACER_CORE;
// A bullet that strikes a building or a rock is stopped on the face with a
// puff of dust; this share of them throws one (a burst into a wall is a
// stream of strikes, and the particle pool is shared with everything else).
const WALL_PUFF = 0.5;
const tmpWall = new THREE.Vector3();
const GRAVITY = 3; // gentle drop so tracers arc a little
const tmpP0 = new THREE.Vector3();
const tmpL0 = new THREE.Vector3();
const tmpL1 = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3(1, 1, 1);
const tmpSc = new THREE.Vector3(1, 1, 1);
const tmpM = new THREE.Matrix4();
const tmpC = new THREE.Vector3();
const tmpSeg = new THREE.Vector3();
const tmpToL = new THREE.Vector3();
const tmpClose = new THREE.Vector3();
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const HIDDEN = new THREE.Vector3(0, -9999, 0);

// A round has to have got clear of the listener before passing him again can
// count as a near miss, or the player's own guns crack past his own ears.
const FLYBY_RADIUS = 25;
const FLYBY_ARM = 35;
// Even a near miss is one sound: a burst walking past is a stream of them, and
// nobody needs sixteen whooshes in a tenth of a second.
const FLYBY_GAP = 0.09;

function clampf(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
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

// Where the guns are harmonised. Wing guns fired parallel converge nowhere and
// straddle everything; aimed at a point they cross where the pilot set them to.
// Accepts a world point, a range in metres (measured along the shooter's own
// nose, which is what a harmonisation setting really means), or { point } /
// { range }. Returns null when there is nothing sensible to aim at.
function convergePoint(converge, shooter, out) {
  if (!converge) return null;
  if (typeof converge === 'number') {
    if (!(converge > 0) || !shooter || !shooter.position || !shooter.dir) return null;
    return out.copy(shooter.position).addScaledVector(shooter.dir, converge);
  }
  if (typeof converge.x === 'number' && typeof converge.y === 'number' && typeof converge.z === 'number') {
    return out.copy(converge);
  }
  if (converge.point) return convergePoint(converge.point, shooter, out);
  if (typeof converge.range === 'number') return convergePoint(converge.range, shooter, out);
  return null;
}

// Module scope so the slab test allocates nothing per call — it runs per
// bullet, per plane, per substep.
const AXES = ['x', 'y', 'z'];

// Segment vs AABB, t in [0..1] or -1.
function segHitsBox(l0, l1, box) {
  let tmin = 0;
  let tmax = 1;
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
    if (t1 > t2) {
      const swap = t1; // a destructuring swap here would allocate an array
      t1 = t2;
      t2 = swap;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  return tmin;
}

export class BulletManager {
  constructor(scene) {
    this.scene = scene;
    // X-04: the tracer streak — speed-long, HDR, never under 1.5 px, veiled
    // by smoke — one InstancedMesh for every round in the air
    const geo = tracerGeometry();
    const mat = createTracerMaterial();
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.colors = new Float32Array(MAX * 3);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    attachTracerViewHook(this.mesh);
    scene.add(this.mesh);

    this.items = Array.from({ length: MAX }, () => ({
      active: false,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      life: 0,
      dmg: 0,
      shooter: null,
      flewBy: false,
      flybyArmed: false,
      // its instance matrix is already the off-screen one, so the write loop
      // has nothing to do for it until it is fired
      parked: true,
      // metres flown: the streak never reaches back past the muzzle
      flown: 0,
      // drawn at all (BELT_TRACERS_ONLY)
      shown: true,
    }));
    this.cursor = 0;
    this.flybyGap = 0;
    this.serial = 0;

    tmpM.compose(HIDDEN, tmpQ.identity(), tmpS);
    for (let i = 0; i < MAX; i++) this.mesh.setMatrixAt(i, tmpM);
  }

  // converge (optional): a world point, a harmonisation range in metres, or
  // { point } / { range }. Given one, the round is aimed from this muzzle at
  // that point instead of straight down `dir`, which is the whole difference
  // between wing guns that cross and wing guns that bracket.
  fire(pos, dir, speed, dmg, shooter, spread = 0, converge = null) {
    const b = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % MAX;
    b.active = true;
    b.pos.copy(pos);
    b.flewBy = false;
    b.flybyArmed = false;
    const aim = convergePoint(converge, shooter, tmpC);
    if (aim) {
      tmpD.subVectors(aim, pos);
      if (tmpD.lengthSq() < 1e-6) tmpD.copy(dir);
    } else {
      tmpD.copy(dir);
    }
    tmpD.normalize();
    if (spread > 0) {
      tmpD.x += (Math.random() - 0.5) * 2 * spread;
      tmpD.y += (Math.random() - 0.5) * 2 * spread;
      tmpD.z += (Math.random() - 0.5) * 2 * spread;
    }
    tmpD.normalize();
    b.vel.copy(tmpD).multiplyScalar(speed);
    b.life = 1.6;
    b.dmg = dmg;
    b.shooter = shooter;
    b.flown = 0;
    b.shown = !BELT_TRACERS_ONLY || this.serial % BELT_RATIO === 0;
    this.serial++;
    // the streak's colour by the shooter's nation, HDR (written once per round)
    const i = (this.cursor + MAX - 1) % MAX;
    const c = tracerColourFor(shooter);
    const C = this.colors;
    const heat = tracerHeatFor(c);
    C[i * 3] = (((c >> 16) & 255) / 255) * heat;
    C[i * 3 + 1] = (((c >> 8) & 255) / 255) * heat;
    C[i * 3 + 2] = ((c & 255) / 255) * heat;
    // one range per burst, not per round; and an overflow stays a whole-
    // buffer upload until it has been made (effects.js markRange)
    markRange(this.mesh.instanceColor, i * 3, 3);
  }

  // onHit(targetPlane, dmg, shooter, point)
  // ground: entities with { alive, team, position, radius } — sphere hit test,
  // reported through onGroundHit(target, bullet, point). Same-team ground
  // targets are ignored (no friendly fire).
  // opts (all optional): { listenerPos, onFlyby(kind, point, missDist), player }
  update(dt, planes, onHit, effects = null, ground = [], onGroundHit = null, opts = null) {
    const listener = opts && opts.listenerPos ? opts.listenerPos : null;
    const onFlyby = opts && opts.onFlyby ? opts.onFlyby : null;
    const player = opts && opts.player ? opts.player : null;
    if (this.flybyGap > 0) this.flybyGap -= dt;
    // cache inverse matrices once per frame
    for (const pl of planes) {
      if (!pl.alive) continue;
      pl.group.updateWorldMatrix(true, false);
      if (!pl._inv) pl._inv = new THREE.Matrix4();
      pl._inv.copy(pl.group.matrixWorld).invert();
    }

    const SUB = 2;
    const h = dt / SUB;
    for (let i = 0; i < MAX; i++) {
      const b = this.items[i];
      if (!b.active) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.active = false;
        continue;
      }

      for (let step = 0; step < SUB && b.active; step++) {
        const p0 = tmpP0.copy(b.pos);
        b.vel.y -= GRAVITY * h;
        b.pos.addScaledVector(b.vel, h);
        const segLen = b.vel.length() * h;
        b.flown += segLen;

        // Scenery first, and everything else only up to it: a plane or a
        // vehicle behind a house is out of reach of this step.
        const wall = propSegmentHit(p0, b.pos, null);
        let end = b.pos;
        if (wall) end = tmpWall.copy(wall.point);

        // The crack is for a round that goes PAST: measured along the stretch
        // it actually flew this step, and — since it plays on the approach,
        // inside FLYBY_RADIUS — only if the round will get abeam of the
        // listener before a wall stops it. One stopped on a house in front of
        // you, or between you and the gun, is an impact, and sounds like one.
        if (listener && onFlyby && !b.flewBy && (!player || b.shooter !== player)) {
          const miss = segmentDistance(p0, end, listener, tmpClose);
          if (!b.flybyArmed) {
            if (miss > FLYBY_ARM) b.flybyArmed = true;
          } else if (miss < FLYBY_RADIUS
            && (wall ? tmpClose.distanceToSquared(end) > 1e-6 : reachesAbeam(end, b.vel, listener))) {
            b.flewBy = true;
            if (this.flybyGap <= 0) {
              this.flybyGap = FLYBY_GAP;
              onFlyby('bullet', tmpClose, miss);
            }
          }
        }

        for (const pl of planes) {
          if (!pl.alive || pl === b.shooter) continue;
          if (pl.position.distanceTo(p0) > segLen + pl.radius + 3) continue;
          const l0 = tmpL0.copy(p0).applyMatrix4(pl._inv);
          const l1 = tmpL1.copy(end).applyMatrix4(pl._inv);
          const t = segHitsBox(l0, l1, pl.hitBox);
          if (t >= 0) {
            const point = new THREE.Vector3().lerpVectors(p0, end, t);
            onHit(pl, b.dmg, b.shooter, point);
            b.active = false;
            break;
          }
        }
        // ground targets: segment vs sphere (center lifted ~1.2m off the dirt)
        if (b.active && ground.length > 0) {
          for (const g of ground) {
            if (!g.alive || (b.shooter && g.team === b.shooter.team)) continue;
            // same cheap reject the plane loop above already has: without it a
            // burst of cannon fire runs the full sphere solve against every
            // ground unit on the map, twice per bullet per frame
            if (g.position.distanceTo(p0) > segLen + g.radius + 3) continue;
            const cx = g.position.x;
            const cy = g.position.y + 1.2;
            const cz = g.position.z;
            const dx = end.x - p0.x;
            const dy = end.y - p0.y;
            const dz = end.z - p0.z;
            const fx = p0.x - cx;
            const fy = p0.y - cy;
            const fz = p0.z - cz;
            const dd = dx * dx + dy * dy + dz * dz;
            if (dd < 1e-9) continue;
            const t = Math.max(0, Math.min(1, -(fx * dx + fy * dy + fz * dz) / dd));
            const qx = p0.x + dx * t - cx;
            const qy = p0.y + dy * t - cy;
            const qz = p0.z + dz * t - cz;
            if (qx * qx + qy * qy + qz * qz <= g.radius * g.radius) {
              const point = new THREE.Vector3(p0.x + dx * t, p0.y + dy * t, p0.z + dz * t);
              onGroundHit?.(g, b, point);
              b.active = false;
              break;
            }
          }
        }
        if (b.active && wall) {
          // a footing runs underground: a round that dug in short of it puffs
          // on the turf, not inside the earth
          const gy = groundHeightAt(tmpWall.x, tmpWall.z);
          if (tmpWall.y < gy) tmpWall.y = gy;
          if (effects && Math.random() < WALL_PUFF) effects.groundHit(tmpWall, 0.5);
          b.pos.copy(tmpWall);
          b.active = false;
          break;
        }
        if (b.active && b.pos.y <= groundHeightAt(b.pos.x, b.pos.z)) {
          if (effects && Math.random() < 0.3) effects.groundHit(b.pos, 0.5);
          b.active = false;
        }
      }
    }

    // Write instance matrices — but only the slots that actually changed. A
    // parked slot already holds the off-screen matrix, so re-composing it every
    // frame bought nothing except a 17.9 KB buffer upload in battles where not
    // one bullet is in the air.
    let lo = -1;
    let hi = -1;
    for (let i = 0; i < MAX; i++) {
      const b = this.items[i];
      if (!b.active && b.parked) continue;
      if (b.active && b.shown) {
        // X-04: the distance covered in a 60 Hz frame (4-15 m), no longer
        // than the round has flown, trailing back from the round
        const sp = b.vel.length();
        tmpD.copy(b.vel).multiplyScalar(1 / Math.max(sp, 1e-6));
        tmpQ.setFromUnitVectors(Z_AXIS, tmpD);
        const len = Math.max(QUAD_W, Math.min(tracerLength(sp), b.flown));
        tmpC.copy(b.pos).addScaledVector(tmpD, -0.5 * len);
        tmpSc.set(QUAD_W, QUAD_W, len);
        tmpM.compose(tmpC, tmpQ, tmpSc);
        b.parked = false;
      } else {
        tmpM.compose(HIDDEN, tmpQ.identity(), tmpS);
        b.parked = true;
      }
      this.mesh.setMatrixAt(i, tmpM);
      if (lo < 0) lo = i;
      hi = i;
    }
    if (lo >= 0) {
      // Bound the upload to the span the ring buffer actually touched. Ranges
      // accumulate on purpose — the renderer clears them once it has uploaded,
      // so a frame that ran without being drawn keeps its writes pending. Only
      // if they pile up do we fall back to an unbounded upload.
      markRange(this.mesh.instanceMatrix, lo * 16, (hi - lo + 1) * 16);
    }
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
