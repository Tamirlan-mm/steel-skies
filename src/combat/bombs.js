import * as THREE from 'three';
import * as terrain from '../world/terrain.js';
// airfield.js imports terrain.js and the shared factories, never combat code,
// so this edge cannot close a cycle
import { groundSurfaceAt, groundHeightAt } from '../world/airfield.js';
import { intersectTanks } from './ballistics.js';
// Village buildings (standing or in ruins) and rocks: a store that meets one
// goes off on it — a rocket on the wall, a bomb on the roof.
import { propSegmentHit } from '../world/scenery.js';
import { mattMaterial, markSharedGeometry } from '../core/materials.js';
import { sfx3d } from '../core/audio.js';
// AV-01: the presentation of every detonation (picture, sound, shake) comes
// from one law of the charge's mass. Damage stays where it is, below.
import { blastOf, bombFillerKg, rocketFillerKg, shakeReach } from './blast.js';

// Surface data is a wave-2 addition to terrain.js; a namespace import lets the
// file load whether or not it has landed yet.
const terrainSurface = typeof terrain.terrainSurface === 'function' ? terrain.terrainSurface : null;

// Every "where is the ground under this store" question in this file — release
// height and arming, contact, the sight's prediction, where the crater and the
// shock ring sit — asks for the SOLID ground: the hillside, or an airfield's
// raised platform, runway and embankment where one stands above it. On
// terrainHeight alone a bomb fell through the runway and burst under it. With
// no airfield registered groundHeightAt is terrainHeight exactly.
const groundRec = { y: 0, kind: 'terrain', af: null };
const CONCRETE_SURFACE = {
  type: 'rock', grip: 1.05, drag: 0.04, dustColor: 0xb8b0a0, airfield: 'concrete',
};
function impactSurface(x, z) {
  if (groundSurfaceAt(x, z, groundRec).kind === 'concrete') return CONCRETE_SURFACE;
  return terrainSurface ? terrainSurface(x, z) : null;
}

const GRAVITY = 9.8;
const ROCKET_GRAVITY = 2.0;
const UP = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const tmpD = new THREE.Vector3();
const tmpR = new THREE.Vector3();
const tmpPrev = new THREE.Vector3();
// attitude integration scratch — never live across a call boundary
const tmpNose = new THREE.Vector3();
const tmpAxis = new THREE.Vector3();
const tmpSpin = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
// release scratch
const relPos = new THREE.Vector3();
const relOff = new THREE.Vector3();
// effects scratch
const fxA = new THREE.Vector3();
const fxB = new THREE.Vector3();
// host-frame scratch for a delayed bomb lodged on a vehicle
const tmpM = new THREE.Matrix4();
// the face a store struck, when it was a building or a rock
const wallPt = new THREE.Vector3();
const wallN = new THREE.Vector3();
// the burst is set this far off the face, so it goes off on the wall or the
// roof rather than inside it
const WALL_STANDOFF = 0.15;
const WALL_SURFACE = {
  type: 'rock', grip: 1, drag: 0.04, dustColor: 0xa49a8a, scenery: 'masonry',
};
const ROCK_SURFACE = {
  type: 'rock', grip: 1, drag: 0.04, dustColor: 0x8f8a80, scenery: 'rock',
};

// Arming. A bomb's nose fuse needs a moment of airflow to spin up, so a store
// released very low, or pressed so deep into a dive that it lands almost at
// once, cannot go off the instant it touches. It used to be a silent dud, which
// cost 28% of realistic attack runs (bombs.md: every release under 31 m, and
// 46-71 m in a fast 45-75 degree dive) and threw away direct hits with no word
// to the pilot. Now such a bomb falls back to its delay element: it buries
// itself where it lands and goes off LOW_DROP_DELAY seconds later, the arcade
// low-drop behaviour players know. Instant arming needs the release height and
// the flight time below; everything else is late, never lost.
const BOMB_ARM_TIME = 0.25;
const BOMB_ARM_HEIGHT = 12;
const LOW_DROP_DELAY = 1.5;
// The fuselage fallback in drop() starts the store this far under the aircraft;
// the sight prediction uses the same figure so its armed flag agrees with drop.
const RELEASE_DROP = 1.3;
// A rocket is already moving when it leaves the rail, so its fuse arms almost
// at once — but a point-blank launch into something can still fail.
const ROCKET_ARM_TIME = 0.14;

// ---------------------------------------------------------------------------
// blast model — the single source of truth for how big this bang is
// ---------------------------------------------------------------------------
//
// The projectile decides the size of its own explosion and hands the number to
// everybody downstream: tankEntity.applyExplosion() scales its penetration and
// its kill radius off it, the battle classes scale scenery felling, unit
// damage, shake and the sound off it.
//
// TRANSITIONAL SHIM. The per-aircraft radii in src/vehicles/planes.js were
// tuned when a bomb was a big grenade: 13-18 m, so a Zero's 60 kg bomb killed
// only within 4.5 m of a tank centre and a near miss at 6 m produced 60 mm of
// penetration — enough for a Stuart, nothing at all against a Tiger. That is
// the "bombs feel weak" the pilot is complaining about. The agreed fix is new
// radii in planes.js (22-36 m, see the report). Until they land, any radius
// still inside the old range is scaled here so the weapon hits as hard as it
// should regardless of which file lands first. Once planes.js carries a value
// at or above LEGACY_BOMB_MAX the shim is a no-op and cannot double-apply.
const LEGACY_BOMB_MAX = 19;
const LEGACY_BOMB_SCALE = 1.85;

// A rocket is a precision weapon and was never the complaint: its radius is
// passed through untouched so a salvo stays a scalpel and the bomb stays the
// hammer.
export function blastRadiusFor(type, specRadius) {
  const r = specRadius > 0 ? specRadius : (type === 'rocket' ? 8 : 12);
  if (type === 'rocket') return r;
  return r < LEGACY_BOMB_MAX ? r * LEGACY_BOMB_SCALE : r;
}

// Peak HE damage against a soft (unarmoured) target, and how it falls off.
// The battle classes apply a flat number inside the radius today, which with a
// 36 m blast would delete a whole convoy at the same rate as the truck sitting
// in the crater. This keeps the centre lethal and the edge survivable.
const SOFT_DAMAGE = { bomb: 340, rocket: 175 };

export function blastDamageAt(info, dist) {
  if (!info) return 0;
  const radius = info.radius || 12;
  const peak = info.softDamage || SOFT_DAMAGE[info.type] || SOFT_DAMAGE.bomb;
  const f = 1 - dist / Math.max(0.001, radius);
  if (f <= 0) return 0;
  // fat in the middle, tapering rather than cliff-edged at the rim
  return peak * (0.34 + 0.66 * f ** 0.85);
}

// Everything the presentation layer needs, derived once per detonation.
function blastProfile(type, radius) {
  const rocket = type === 'rocket';
  const s = rocket ? radius / 9 : radius / 26; // 1 == a 250 kg bomb
  // The charge, kg TNT (verify data in blast.js): ~130 kg for the 250 kg
  // class, cube of the scale either side; a rocket head ~3 kg. Everything
  // the player sees, hears and feels of the blast is blastOf(kg).
  const kg = rocket ? rocketFillerKg(radius) : bombFillerKg(radius);
  const law = blastOf(kg);
  return {
    scale: s,
    kg,
    // outright kill radius the tank model should use (see report)
    kill: radius * (rocket ? 0.34 : 0.28),
    // what tankEntity's curve hands out at contact, in mm RHA
    penAt0: radius * 9,
    softDamage: SOFT_DAMAGE[type] || SOFT_DAMAGE.bomb,
    // aircraft caught in the open. radius*0.8 with a 36 m blast swatted
    // fighters out of the sky from 29 m away, which is not a thing.
    planeRadius: radius * (rocket ? 0.6 : 0.45),
    planeDamage: rocket ? 140 : 260,
    // The hole it leaves, from the blast law: an instant-fuzed SC 250 makes
    // ~4.4 m (bible 6.5: decal 4-5 m); a delay fuze, buried, about twice
    // that (blast() doubles it).
    crater: law.crater,
    // sfx3d voice size, the trauma at the seat of the blast and how far the
    // shake carries — all the law's (the shake itself is shake.addBlast)
    soundSize: law.sound.size,
    shake: law.shake.amp,
    shakeReach: shakeReach(kg),
    // The drawn fronts, as OUTER mesh radii. The ring mesh is an annulus from
    // 0.34 to 1.0 of this and its texture puts the bright band at ~0.8 of it,
    // fading to nothing at 1.0 (effects.js ringTexture), so what the eye reads
    // as "the wave" sits at 0.8x these numbers. They used to be 26k and 52k
    // (1x and 2x the radius) — a tank visibly swallowed by the dust wave at
    // 1.6R took nothing (bombs.md). Now:
    //   shock  band at ~0.6R: the kill / tracks / whole-crew band (tankEntity
    //          bomb ladder M = (R-7)*0.45 + 0.25R, 0.56-0.61R for 22-36 m)
    //   dust   band at ~0.8R, fading out at R: past M an armoured target only
    //          feels concussion (the commander's optics, the odd man shaken),
    //          thinning to nothing at R itself — the same edge where a soft
    //          target's damage (radius + unit radius) ends
    //   air    band at ~0.8R: combinedBattle's aircraft-in-the-open radius
    radius,
    shockRing: radius * (rocket ? 1 : 0.75),
    dustRing: radius,
    airRing: radius,
  };
}

// ---------------------------------------------------------------------------
// store bodies
// ---------------------------------------------------------------------------
//
// The thing that falls off the wing is the thing that was hanging on the wing:
// a GP bomb silhouette — ogive nose, parallel body, boat tail, cruciform fins
// inside a stabilising ring — not a dark sphere. Built once, cached, and
// stamped shared so a battle teardown's blanket scene.traverse(dispose) sweep
// leaves it alone and the next battle still has ordnance.

const geoCache = new Map();

function share(geo) {
  if (typeof markSharedGeometry === 'function') markSharedGeometry(geo);
  return geo;
}

// Lay a lathe profile (built around +Y, nose at y=0) down the +Z axis with the
// centre of the body at the origin, so aligning mesh +Z to the velocity vector
// points the nose where it is going.
function layDown(geo, len) {
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, len * 0.5);
  return geo;
}

function bombBodyGeometry() {
  const key = 'bomb';
  let g = geoCache.get(key);
  if (g) return g;
  const L = 1.92;
  // r, y along the axis from the nose
  const prof = [
    [0.00, 0.00], [0.075, 0.03], [0.135, 0.10], [0.185, 0.22],
    [0.213, 0.36], [0.222, 0.52], [0.222, 1.12], [0.205, 1.30],
    [0.160, 1.48], [0.128, 1.66], [0.112, 1.92], [0.00, 1.92],
  ];
  const pts = prof.map(([r, y]) => new THREE.Vector2(r, y));
  const parts = [];
  parts.push(layDown(new THREE.LatheGeometry(pts, 14), L));

  // cruciform tail fins, four of them, set well back
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.BoxGeometry(0.022, 0.20, 0.46);
    fin.translate(0, 0.205, 0);
    fin.rotateZ((i * Math.PI) / 2);
    fin.translate(0, 0, -0.70);
    parts.push(fin);
  }
  // the drum around the tail: the single most recognisable thing about a WWII
  // bomb at two hundred metres
  const ring = new THREE.CylinderGeometry(0.212, 0.212, 0.085, 16, 1, true);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, 0, -0.86);
  parts.push(ring);
  // suspension lug — what it hung from, still there as it falls away
  const lug = new THREE.BoxGeometry(0.05, 0.10, 0.16);
  lug.translate(0, 0.26, 0.06);
  parts.push(lug);

  g = mergeParts(parts);
  geoCache.set(key, g);
  return g;
}

// The bright band behind the nose. Reads as a filled bomb at a glance and,
// much more to the point here, catches the light while it falls.
function bombBandGeometry() {
  const key = 'bombBand';
  let g = geoCache.get(key);
  if (g) return g;
  g = new THREE.CylinderGeometry(0.232, 0.232, 0.10, 16, 1, true);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, 0.42);
  geoCache.set(key, share(g));
  return g;
}

function rocketBodyGeometry() {
  const key = 'rocket';
  let g = geoCache.get(key);
  if (g) return g;
  const parts = [];
  const body = new THREE.CylinderGeometry(0.072, 0.072, 1.05, 10, 1, true);
  body.rotateX(Math.PI / 2);
  body.translate(0, 0, -0.18);
  parts.push(body);
  const nozzle = new THREE.CylinderGeometry(0.072, 0.05, 0.09, 10);
  nozzle.rotateX(Math.PI / 2);
  nozzle.translate(0, 0, -0.74);
  parts.push(nozzle);
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.BoxGeometry(0.016, 0.13, 0.24);
    fin.translate(0, 0.135, 0);
    fin.rotateZ((i * Math.PI) / 2 + Math.PI / 4);
    fin.translate(0, 0, -0.60);
    parts.push(fin);
  }
  g = mergeParts(parts);
  geoCache.set(key, g);
  return g;
}

// The fat HE head, in its own material slot.
function rocketHeadGeometry() {
  const key = 'rocketHead';
  let g = geoCache.get(key);
  if (g) return g;
  const pts = [
    new THREE.Vector2(0.0, 0.0), new THREE.Vector2(0.048, 0.02),
    new THREE.Vector2(0.086, 0.09), new THREE.Vector2(0.104, 0.20),
    new THREE.Vector2(0.104, 0.44), new THREE.Vector2(0.072, 0.52),
    new THREE.Vector2(0.0, 0.52),
  ];
  g = new THREE.LatheGeometry(pts, 12);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0, 0.86);
  geoCache.set(key, share(g));
  return g;
}

// Merge without pulling in BufferGeometryUtils: every part here is a plain
// non-indexed-able primitive with position/normal/uv, so concatenating the
// attribute arrays by hand is both shorter and one less import to break.
function mergeParts(parts) {
  let verts = 0;
  const flat = [];
  for (const p of parts) {
    const g = p.index ? p.toNonIndexed() : p;
    if (g !== p) p.dispose();
    flat.push(g);
    verts += g.attributes.position.count;
  }
  const pos = new Float32Array(verts * 3);
  const nrm = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  let o = 0;
  for (const g of flat) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array.subarray(0, n * 3), o * 3);
    if (g.attributes.normal) nrm.set(g.attributes.normal.array.subarray(0, n * 3), o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array.subarray(0, n * 2), o * 2);
    o += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return share(out);
}

function storeMesh(type) {
  if (type === 'rocket') {
    const m = new THREE.Mesh(
      rocketBodyGeometry(), mattMaterial(0x6d7264, { rough: 0.7, metal: 0.35 }),
    );
    const head = new THREE.Mesh(rocketHeadGeometry(), mattMaterial(0x7a3529, { rough: 0.8 }));
    m.add(head);
    return m;
  }
  const m = new THREE.Mesh(bombBodyGeometry(), mattMaterial(0x2f3630, { rough: 0.82, metal: 0.2 }));
  const band = new THREE.Mesh(bombBandGeometry(), mattMaterial(0xc4a02c, { rough: 0.7 }));
  m.add(band);
  return m;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function rand(a, b) {
  return a + Math.random() * (b - a);
}

export class BombManager {
  constructor(scene) {
    this.scene = scene;
    this.bombs = [];
    // rockets queued by a salvo, launched one rail at a time
    this.ripples = [];
    this.bombArmTime = BOMB_ARM_TIME;
    this.bombArmHeight = BOMB_ARM_HEIGHT;
    this.rocketArmTime = ROCKET_ARM_TIME;

    // Presentation. `effects` arrives per frame through update(); the shake
    // rig and the camera have to be handed over once, because nothing else in
    // the update signature carries them.
    this.shake = null;
    this.camera = null;
    this.blastSound = false;
    this.autoFX = true;
    // the ground wave arriving after the flash, one entry per live blast
    this.pendingShake = [];
    this.craterCd = 0;
  }

  // Optional. { shake, camera, sound, fx }
  //   shake / camera  enable the distance-scaled camera kick and the second,
  //                   late jolt when the ground wave gets there
  //   sound           let the manager voice the blast itself (leave false if
  //                   the caller is still calling sfx3d.bomb in its own
  //                   explosion handler — otherwise it is voiced twice)
  //   fx              false disables the whole visual layer
  setBlastContext(ctx = null) {
    if (!ctx) return;
    if (ctx.shake !== undefined) this.shake = ctx.shake;
    if (ctx.camera !== undefined) this.camera = ctx.camera;
    if (ctx.sound !== undefined) this.blastSound = !!ctx.sound;
    if (ctx.fx !== undefined) this.autoFX = !!ctx.fx;
  }

  // Ask the aircraft to physically let a store go and tell us where it was
  // hanging. Returns:
  //   { pos: Vector3|null, quat: Quaternion|null, refused: bool }
  // `pos` is a scratch vector owned by this call — copy it, do not keep it.
  //
  // The aeroplane half of this (planeEntity.releaseStore) may not exist yet, in
  // which case there is nothing to hide and nothing to refuse: the projectile
  // simply spawns off the fuselage as it always did.
  takeStore(plane, kind, credited) {
    relPos.set(0, 0, 0);
    const out = { pos: null, quat: null, refused: false };
    if (!plane || typeof plane.releaseStore !== 'function') return out;
    let r = null;
    try {
      r = plane.releaseStore(kind);
    } catch {
      r = null;
    }
    if (r) {
      // a Vector3, or something carrying one — the contract says Vector3, the
      // tolerance costs nothing
      const v = r.isVector3 ? r : (r.position || r.pos || null);
      if (v && typeof v.x === 'number' && Number.isFinite(v.x + v.y + v.z)) {
        relPos.set(v.x, v.y, v.z);
        // The contract says WORLD position. A local one (a store's position
        // inside the aeroplane's group, un-transformed) would put the bomb a
        // couple of metres from the map origin, which is a very confusing bug
        // to look at — so anything implausibly far from the aircraft is
        // treated as "not given" and we fall back to the fuselage.
        if (relPos.distanceToSquared(plane.position) < 900) out.pos = relPos;
      }
      if (r.quaternion && r.quaternion.isQuaternion) out.quat = r.quaternion;
    }
    // Something did come off the wing, even if it declined to say where: the
    // release happened, so this is never a refusal.
    if (r) return out;
    // Nothing came off the wing. If the ammunition counter also says empty,
    // the two halves agree that there is nothing to drop and we must not
    // conjure a projectile — that is exactly how the count and the visible
    // stores drift apart. `credited` covers the ripple-fire case, where the
    // rounds were deducted up front and the counter is already at zero for
    // rails that have every right to fire.
    if (!credited) {
      const left = kind === 'rocket' ? plane.rockets : plane.bombs;
      if (left !== undefined && left <= 0) out.refused = true;
    }
    return out;
  }

  // Common set-up for anything that falls off an aeroplane.
  spawnStore(plane, type, pos, radius, opts) {
    const mesh = storeMesh(type);
    const prof = blastProfile(type, radius);
    const size = type === 'rocket'
      ? clamp(prof.scale, 0.8, 1.25)
      : clamp(prof.scale, 0.74, 1.35);
    mesh.scale.setScalar(size);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    const b = {
      pos,
      vel: new THREE.Vector3(),
      radius,
      shooter: plane,
      mesh,
      type,
      age: 0,
      armTime: 0,
      armFail: false,
      releaseHeight: pos.y - groundHeightAt(pos.x, pos.z),
      delay: 0,
      damage: null,
      pen: null,
      stuck: false,
      fuseTimer: 0,
      armed: false,
      dud: false,
      direct: false,
      target: null,
      hit: null,
      impactDir: null,
      impactNormal: null,
      impactSpeed: 0,
      // attitude: a store does not slide down the sky unrotated. It leaves the
      // rack in the aeroplane's attitude and then weathercocks onto the
      // airstream, overshooting and settling as the fins bite.
      quat: new THREE.Quaternion(),
      omega: new THREE.Vector3(),
      rollRate: 0,
      finK: type === 'rocket' ? 6.5e-4 : 1.05e-4,
      finC: type === 'rocket' ? 0.032 : 0.0105,
      burn: 0,
      profile: prof,
      fxPlayed: false,
    };
    if (plane.quat && plane.quat.isQuaternion) b.quat.copy(plane.quat);
    else if (plane.dir) b.quat.setFromUnitVectors(Z_AXIS, tmpD.copy(plane.dir).normalize());
    if (opts && opts.quat) b.quat.copy(opts.quat);
    mesh.quaternion.copy(b.quat);
    return b;
  }

  // opts (all optional):
  //   delay    seconds the fuse burns after contact (a delay-action bomb sticks
  //            where it lands and goes off later); also read from plane.bombFuse
  //   armTime  override the arming delay for this weapon
  //   radius   override the blast radius
  //
  // Returns true when a bomb actually left the aircraft. The counter is spent
  // by the caller, as it always was; false means the release was refused and
  // the caller should hand the round back if it can.
  drop(plane, opts = null) {
    if (!plane) return false;
    const rel = this.takeStore(plane, 'bomb', opts && opts.credited);
    if (rel.refused) return false;
    const spec = plane.spec && plane.spec.bombs ? plane.spec.bombs : null;
    const radius = blastRadiusFor(
      'bomb', (opts && opts.radius) || (spec && spec.radius) || 12,
    );

    const pos = new THREE.Vector3();
    if (rel.pos) pos.copy(rel.pos);
    else {
      pos.copy(plane.position);
      pos.y -= RELEASE_DROP;
    }

    const b = this.spawnStore(plane, 'bomb', pos, radius, { quat: rel.quat });
    b.vel.copy(plane.dir).multiplyScalar(plane.speed * 0.98);
    // Ejection. The rack pushes it clear of the wing — small, but it is what
    // makes the store visibly fall away from the station instead of hanging
    // there in formation with the aeroplane. Kept tiny on purpose: the bomb
    // sight predicts a clean ballistic drop and must stay honest.
    relOff.subVectors(pos, plane.position);
    if (relOff.lengthSq() > 1e-4) {
      relOff.normalize();
      b.vel.addScaledVector(relOff, 0.9);
    }
    b.vel.y -= 0.7;
    b.armTime = opts && opts.armTime !== undefined ? opts.armTime : this.bombArmTime;
    // released too low for the nose fuse to arm: it will not burst on contact,
    // it will fall back to the low-drop delay (impactInfo) — never a dud
    b.armFail = pos.y - groundHeightAt(pos.x, pos.z) < this.bombArmHeight;
    b.delay = (opts && opts.delay) || plane.bombFuse || 0;
    b.damage = spec && spec.dmg ? spec.dmg : null;
    b.pen = spec && spec.pen ? spec.pen : null;
    // Off the rack the nose rides up against the airstream — the flight path
    // steepens under gravity faster than the body can follow — and the fins
    // then swing it down through the velocity vector and settle it. That swing
    // is the whole reason a falling bomb reads as a falling bomb.
    b.omega.set(rand(-0.35, 0.35), rand(-0.25, 0.25), 0).applyQuaternion(b.quat);
    b.omega.addScaledVector(tmpAxis.set(1, 0, 0).applyQuaternion(b.quat), rand(-0.9, -0.35));
    b.rollRate = rand(-1.6, 1.6);
    this.bombs.push(b);
    return true;
  }

  // unguided rocket from an under-wing pylon (alternating sides when the
  // aeroplane cannot tell us where its rails are)
  fireRocket(plane, opts = null) {
    if (!plane) return false;
    const rel = this.takeStore(plane, 'rocket', opts && opts.credited);
    if (rel.refused) return false;
    const spec = plane.spec && plane.spec.rockets ? plane.spec.rockets : null;
    const radius = blastRadiusFor(
      'rocket', (opts && opts.radius) || (spec && spec.radius) || 8,
    );

    const pos = new THREE.Vector3();
    if (rel.pos) pos.copy(rel.pos);
    else {
      this.rocketFlip = !this.rocketFlip;
      const side = this.rocketFlip ? 1 : -1;
      tmpR.crossVectors(plane.dir, UP);
      if (tmpR.lengthSq() < 0.05) tmpR.set(1, 0, 0);
      tmpR.normalize();
      pos.copy(plane.position).addScaledVector(tmpR, side * 1.6);
      pos.y -= 0.7;
    }

    const b = this.spawnStore(plane, 'rocket', pos, radius, { quat: rel.quat });
    // It leaves the rail already moving and then lights up: the motor burns for
    // most of a second and the thing visibly accelerates away from the wing,
    // which is what a rocket looks like and a bullet does not.
    b.vel.copy(plane.dir).multiplyScalar(plane.speed + 110);
    b.burn = 0.82;
    b.life = 6;
    b.armTime = opts && opts.armTime !== undefined ? opts.armTime : this.rocketArmTime;
    b.damage = spec && spec.dmg ? spec.dmg : null;
    b.pen = spec && spec.pen ? spec.pen : null;
    // fins bite instantly, so barely any wander — just a slow induced roll
    b.omega.set(rand(-0.12, 0.12), rand(-0.12, 0.12), 0).applyQuaternion(b.quat);
    b.rollRate = rand(-3.2, 3.2);
    this.bombs.push(b);
    return true;
  }

  // Ripple fire: a pilot does not launch eight rockets simultaneously, he lets
  // them go down the rails a tenth of a second apart and walks the pattern
  // through the target. Unlike fireRocket this DOES spend the rounds itself
  // (plane.rockets), because the salvo is decided here — call it instead of
  // fireRocket, not as well. Returns how many rails will actually fire.
  fireRocketSalvo(plane, count = 4, interval = 0.1, opts = null) {
    if (!plane || !plane.alive) return 0;
    const have = plane.rockets === undefined ? count : plane.rockets;
    const n = Math.max(0, Math.min(Math.floor(count), Math.floor(have)));
    if (n <= 0) return 0;
    if (plane.rockets !== undefined) plane.rockets -= n;
    // Every rail in this salvo is paid for up front, so the counter reads zero
    // while rails are still queued. `credited` stops the release check reading
    // that as "empty" and swallowing the rest of the salvo.
    const o = opts ? { ...opts, credited: true } : { credited: true };
    // the first rail goes now so the salvo answers the trigger immediately
    this.fireRocket(plane, o);
    if (n > 1) {
      this.ripples.push({
        plane,
        left: n - 1,
        timer: interval,
        interval,
        opts: o,
      });
    }
    return n;
  }

  updateRipples(dt) {
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      if (!r.plane.alive) {
        this.ripples.splice(i, 1);
        continue;
      }
      r.timer -= dt;
      while (r.timer <= 0 && r.left > 0) {
        r.timer += r.interval;
        r.left--;
        this.fireRocket(r.plane, r.opts);
      }
      if (r.left <= 0) this.ripples.splice(i, 1);
    }
  }

  // Weathercocking. The store leaves the rack in the aeroplane's attitude and
  // the airstream then has to swing it onto the flight path — a torsional
  // spring whose stiffness is dynamic pressure and whose damping is the fins.
  // Fast and it snaps into line with one small overshoot; slow, or dropped out
  // of a stall, and it wallows and tumbles. Purely cosmetic: the trajectory
  // stays a point mass, so nothing downstream of the impact point moves.
  integrateAttitude(b, dt) {
    const v = b.vel.length();
    tmpNose.set(0, 0, 1).applyQuaternion(b.quat);
    if (v > 0.5) {
      tmpD.copy(b.vel).multiplyScalar(1 / v);
      const dot = clamp(tmpNose.dot(tmpD), -1, 1);
      const ang = Math.acos(dot);
      tmpAxis.crossVectors(tmpNose, tmpD);
      const s = tmpAxis.length();
      if (s > 1e-5) tmpAxis.multiplyScalar(1 / s);
      else tmpAxis.set(0, 0, 0);
      // split the roll off before damping, or the fins would kill the spin too
      const rollComp = b.omega.dot(tmpNose);
      b.omega.addScaledVector(tmpNose, -rollComp);
      b.omega.addScaledVector(tmpAxis, b.finK * v * v * ang * dt);
      b.omega.multiplyScalar(Math.max(0, 1 - b.finC * v * dt));
      const w = b.omega.length();
      if (w > 14) b.omega.multiplyScalar(14 / w);
      b.rollRate *= Math.max(0, 1 - 0.12 * dt);
    }
    tmpSpin.copy(b.omega).addScaledVector(tmpNose, b.rollRate);
    const wl = tmpSpin.length();
    if (wl > 1e-5) {
      tmpSpin.multiplyScalar(1 / wl);
      tmpQ.setFromAxisAngle(tmpSpin, wl * dt);
      b.quat.premultiply(tmpQ).normalize();
    }
    b.mesh.quaternion.copy(b.quat);
  }

  // onExplode(point, bomb, info)
  //
  // Ordnance bursts on whatever it touches first — armour or ground. Without
  // the armour test a bomb aimed straight at a tank simply passed through the
  // hull and went off somewhere behind it, which made direct hits feel dead.
  // Rockets cover 5m+ per frame, so the flight is substepped to stop them
  // tunnelling clean through a hull.
  //
  // `info` is everything the blast damage model needs and never existed before:
  //   { type, point, radius, armed, dud, delayed, direct, target, hit, normal,
  //     dir, speed, shooter, team, age, releaseHeight, damage, pen, surface,
  //     groundY, kill, penAt0, softDamage, planeRadius, planeDamage, soundSize,
  //     fxPlayed }
  // The same fields are also written onto `bomb`, so a two-argument handler
  // that only reads the bomb record still sees the whole story.
  //
  // opts (optional): { onDud(point, bomb, info) } — a round whose fuse never
  // armed. Without the hook a dud simply kicks up dirt and is gone.
  // Also accepted: { shake, camera } as a per-frame alternative to
  // setBlastContext().
  update(dt, tanks, onExplode, effects = null, opts = null) {
    this.updateRipples(dt);
    if (this.craterCd > 0) this.craterCd -= dt;
    const onDud = opts && opts.onDud ? opts.onDud : null;
    const shake = (opts && opts.shake) || this.shake;
    const camera = (opts && opts.camera) || this.camera;
    this.updateDelayedShake(dt, shake, camera);
    const SUBSTEPS = 4;
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.age += dt;

      // a delay-action fuse: the bomb is already in the dirt, counting down
      if (b.stuck) {
        // Lodged on a vehicle: it rides along with it. Every low drop now takes
        // this path, and a tank at 11-18 m/s would otherwise leave the bomb
        // hanging in mid-air where its armour used to be and drive 16-27 m
        // clear before it went off.
        this.followHost(b);
        b.fuseTimer -= dt;
        if (b.fuseTimer <= 0) {
          this.scene.remove(b.mesh);
          this.bombs.splice(i, 1);
          if (b.info) {
            b.info.point = b.pos;
            b.info.groundY = groundHeightAt(b.pos.x, b.pos.z);
            b.info.age = b.age;
          }
          this.blast(b.pos, b.info, effects, shake, camera);
          onExplode(b.pos, b, b.info);
        }
        continue;
      }

      if (b.type === 'rocket') {
        b.life -= dt;
        if (b.life <= 0) {
          this.scene.remove(b.mesh);
          this.bombs.splice(i, 1);
          continue;
        }
        if (b.burn > 0) {
          // motor still lit: it accelerates along its own axis, not along the
          // velocity vector, which is why an unguided rocket walks off aim
          b.burn -= dt;
          tmpNose.set(0, 0, 1).applyQuaternion(b.quat);
          b.vel.addScaledVector(tmpNose, 205 * dt);
          this.motorPlume(b, effects, dt);
        } else if (effects && Math.random() < 0.35) {
          effects.burningTick(b.pos);
        }
      }

      const h = dt / SUBSTEPS;
      let hitPoint = null;
      let hitRec = null;
      let hitTank = null;
      let hitProp = null;
      for (let step = 0; step < SUBSTEPS && !hitPoint; step++) {
        tmpPrev.copy(b.pos);
        b.vel.y -= (b.type === 'rocket' ? ROCKET_GRAVITY : GRAVITY) * h;
        b.pos.addScaledVector(b.vel, h);

        // a wall or a roof on this step: the tanks are only looked for up to it
        const wall = propSegmentHit(tmpPrev, b.pos, null);
        let end = b.pos;
        if (wall) {
          wallPt.copy(wall.point);
          wallN.copy(wall.normal);
          end = wallPt;
        }
        if (tanks && tanks.length) {
          const res = intersectTanks(tanks, tmpPrev, end, b.shooter);
          if (res) {
            hitRec = res.hit;
            hitTank = res.tank;
            hitPoint = res.hit.point;
          }
        }
        if (!hitPoint && wall) {
          hitProp = wall.prop;
          hitPoint = wallPt.clone().addScaledVector(wallN, WALL_STANDOFF);
          // a footing runs underground: a store that dug in short of it
          // bursts on the turf
          const gy = groundHeightAt(hitPoint.x, hitPoint.z);
          if (hitPoint.y < gy + 0.2) hitPoint.y = gy + 0.2;
        }
        if (!hitPoint && b.pos.y <= groundHeightAt(b.pos.x, b.pos.z) + 0.2) {
          hitPoint = b.pos.clone();
        }
      }

      if (hitPoint) {
        const info = this.impactInfo(b, hitPoint, hitRec, hitTank);
        if (hitProp) {
          // the face it went off against, for the blast and for the handler
          info.prop = hitProp;
          info.scenery = hitProp.kind;
          info.normal = wallN.clone();
          info.surface = hitProp.kind === 'rock' ? ROCK_SURFACE : WALL_SURFACE;
          b.impactNormal = info.normal;
          b.prop = hitProp;
        }
        if (!info.armed) {
          // Only a ROCKET can get here (a point-blank launch whose fuse never
          // armed): impactInfo turns every unarmed bomb into a delayed one.
          // A dud is not an explosion: it is a hole in the ground, reported
          // through onDud so the battle can tell the pilot.
          this.scene.remove(b.mesh);
          this.bombs.splice(i, 1);
          if (onDud) onDud(hitPoint, b, info);
          else if (effects) {
            if (effects.dirtImpact) effects.dirtImpact(hitPoint, 1);
            else if (effects.groundHit) effects.groundHit(hitPoint, 1);
          }
          continue;
        }
        if (b.delay > 0) {
          // it stops where it landed and burns its fuse there
          b.stuck = true;
          b.fuseTimer = b.delay;
          b.pos.copy(hitPoint);
          b.vel.set(0, 0, 0);
          b.mesh.position.copy(b.pos);
          b.info = info;
          this.attachHost(b, hitTank);
          continue;
        }
        this.scene.remove(b.mesh);
        this.bombs.splice(i, 1);
        this.blast(hitPoint, info, effects, shake, camera);
        onExplode(hitPoint, b, info);
        continue;
      }
      b.mesh.position.copy(b.pos);
      this.integrateAttitude(b, dt);
    }
  }

  // A delayed store that came to rest on a vehicle keeps its place on it: the
  // contact point is stored in the host's local frame and re-projected every
  // frame while the fuse burns. Ground hits have no host and stay put.
  attachHost(b, host) {
    b.host = null;
    b.hostLocal = null;
    const g = host && host.group;
    if (!g || !g.matrixWorld || typeof g.updateMatrixWorld !== 'function') return;
    g.updateMatrixWorld(true);
    tmpM.copy(g.matrixWorld).invert();
    b.host = host;
    b.hostLocal = new THREE.Vector3().copy(b.pos).applyMatrix4(tmpM);
  }

  followHost(b) {
    if (!b.host || !b.hostLocal) return;
    const g = b.host.group;
    if (!g || !g.matrixWorld || (!g.parent && !b.host.alive)) {
      // wreck taken out of the scene: leave the bomb where it last was
      b.host = null;
      return;
    }
    g.updateMatrixWorld(true);
    b.pos.copy(b.hostLocal).applyMatrix4(g.matrixWorld);
    b.mesh.position.copy(b.pos);
  }

  // Rocket motor: a hard white core at the nozzle and the smoke it leaves
  // hanging behind it.
  motorPlume(b, fx, dt) {
    if (!fx) return;
    tmpNose.set(0, 0, 1).applyQuaternion(b.quat);
    fxA.copy(b.pos).addScaledVector(tmpNose, -0.8);
    if (fx.fire && fx.fire.spawn) {
      fxB.copy(b.vel).multiplyScalar(0.25).addScaledVector(tmpNose, -26);
      fx.fire.spawn(fxA, fxB, rand(0.06, 0.14), 0xfff4d0, 0, 5.5, rand(0.5, 0.9), 1.4, 1, 3.4);
    }
    if (fx.smoke && fx.smoke.spawn && Math.random() < 40 * dt) {
      fxB.set(rand(-1.4, 1.4), rand(0.2, 1.6), rand(-1.4, 1.4));
      fx.smoke.spawn(fxA, fxB, rand(0.8, 1.7), 0x9c9a94, -0.35, 1.6, rand(0.5, 0.9), 2.4, 0.42);
    }
    if (fx.flash) fx.flash(fxA, 26, 0xffd090, 9, 22);
  }

  // ------------------------------------------------------------------
  // detonation
  // ------------------------------------------------------------------
  //
  // What a bomb going off should look like from the cockpit: a white core, a
  // fireball that climbs, a shock ring running out over the ground ahead of a
  // slower dust wave, a column of soil, clods raining back down, a hole and a
  // scorch mark left in the field, a plume standing over it for the rest of the
  // engagement — and the aeroplane thumped twice, once by the flash and once
  // again when the ground wave catches up.
  //
  // `info.fxPlayed` is set before onExplode fires, so a handler that used to
  // draw its own explosion can skip it (`if (!bomb.fxPlayed) ...`) rather than
  // stacking a second one on top.
  blast(point, info, fx, shake, camera) {
    if (info) info.fxPlayed = true;
    if (!this.autoFX) return;
    const prof = (info && info.profile) || blastProfile(
      (info && info.type) || 'bomb', (info && info.radius) || 12,
    );
    const rocket = info && info.type === 'rocket';
    const k = clamp(prof.scale, 0.5, 1.7);
    const gy = groundHeightAt(point.x, point.z);
    const onGround = point.y - gy < 4 + k * 2;

    // AV-03: the ground the store went into, one record for the dust, the
    // crater and the sound (the impact's own surface lookup, impactSurface)
    const look = fx && fx.surfaceLook ? fx.surfaceLook((info && info.surface) || null, point.x, point.z) : null;

    if (fx) {
      if (rocket) this.rocketFX(point, fx, k, gy, onGround, prof, look);
      else this.bombFX(point, fx, k, gy, onGround, prof, look, !!(info && info.delayed));
    }

    if (this.blastSound) {
      sfx3d.bomb(point, { size: prof.soundSize, kg: prof.kg, surface: look || (info && info.surface) });
    }

    if (shake && camera && camera.position) {
      // AV-01 / AV-02: the amplitude at the camera's scaled distance, and the
      // onset when the wave gets there — d / 343 s after the flash, with the
      // thump core/audio.js schedules on the same clock. (This used to kick
      // at once and again on arrival; the flash itself shakes nothing.)
      if (typeof shake.addBlast === 'function') {
        shake.addBlast(prof.kg, point, camera.position);
      } else {
        shake.addAt(prof.shake, point, camera.position, prof.shakeReach, rocket ? 0.5 : 1.05);
      }
    }
  }

  updateDelayedShake(dt, shake, camera) {
    if (!this.pendingShake.length) return;
    for (let i = this.pendingShake.length - 1; i >= 0; i--) {
      const p = this.pendingShake[i];
      p.t -= dt;
      if (p.t > 0) continue;
      this.pendingShake.splice(i, 1);
      if (shake && camera && camera.position) {
        shake.addAt(p.amp, p.pos, camera.position, p.reach, p.dur);
      }
    }
  }

  // A bomb. In the ground it is HE in soil at the real scale (effects
  // heBurst, X-02 / AV-01): a flash that is gone in a quarter of a second, a
  // soil column ~50 m tall for a 250 kg bomb (bible 30-60 m) settling over
  // half a minute, clods thrown 50-100 m, a ~4.4 m crater (twice that for a
  // delay fuze, buried) — no lingering fireball. In the air it is a burst
  // with a fireball (effects explosion). Every size is blastOf(prof.kg).
  // The shock and dust FRONTS keep their sizes off the damage radius: they
  // are the read of what the blast touched (bombs.md), not a picture of it.
  bombFX(point, fx, k, gy, onGround, prof, look = null, delayed = false) {
    const kg = prof.kg || bombFillerKg(prof.radius || 26);
    if (onGround && fx.heBurst) fx.heBurst(point, kg, look, true);
    else if (fx.explosion) fx.explosion(point, kg);

    // Shock. Three fronts: the bright pressure ring, a wide dust wave rolling
    // out behind it, and — off the deck — a spherical front at the seat.
    if (fx.rings && fx.rings.add) {
      const R = prof.radius || 26 * k;
      const shockR = prof.shockRing || 0.75 * R;
      const dustR = prof.dustRing || R;
      const airR = prof.airRing || R;
      const rr = point.y - gy < 6 ? fxA.set(point.x, gy + 0.2, point.z) : point;
      fx.rings.add(rr, UP, Math.min(1.5 * k, shockR * 0.2), shockR, 0.4, 0xffe6b4, 1.9);
      fx.rings.add(rr, UP, Math.min(6 * k, dustR * 0.25), dustR, 0.95,
        look ? look.dust : 0xbfae8e, 0.7 * (fx.litScale != null ? fx.litScale : 1));
      if (!onGround) {
        fx.rings.add(point, fxB.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)),
          Math.min(2 * k, airR * 0.2), airR, 0.5, 0xffd0a0, 1.4);
      }
    }

    // the hole, and the burn ring around it. Rate limited: DecalGeometry is
    // cheap but forty craters is the whole budget.
    if (onGround && fx.groundDecal && this.craterCd <= 0) {
      this.craterCd = 0.15;
      fxA.set(point.x, gy, point.z);
      const crater = prof.crater * (delayed ? 2 : 1);
      fx.groundDecal(fxA, crater * 1.9, 'scorch');
      fx.groundDecal(fxA, crater, 'crater', look ? look.decal : null);
    }

    // and the marker left standing over it
    if (fx.addColumnKg) fx.addColumnKg(point, kg);
    else if (fx.addColumn) fx.addColumn(point, rand(16, 26) * (0.7 + 0.3 * k), 1.5 + 0.9 * k);
  }

  // A rocket head: HE in the ground, or a burst in the air, at its own
  // charge (blastOf(prof.kg)); the ring sits at ~0.8 of its damage radius.
  rocketFX(point, fx, k, gy, onGround, prof = null, look = null) {
    const kg = (prof && prof.kg) || rocketFillerKg((prof && prof.radius) || 9);
    if (onGround && fx.heBurst) fx.heBurst(point, kg, look);
    else if (fx.explosion) fx.explosion(point, kg);
    if (fx.rings && fx.rings.add) {
      // was 15k (1.67x an 8 m rocket's radius); now the band sits at ~0.8R
      const ringR = (prof && prof.shockRing) || 9 * k;
      const rr = point.y - gy < 4 ? fxA.set(point.x, gy + 0.15, point.z) : point;
      fx.rings.add(rr, UP, Math.min(1 * k, ringR * 0.2), ringR, 0.32, 0xffdca8, 1.3);
    }
    if (fx.addColumnKg) fx.addColumnKg(point, kg);
    else if (fx.addColumn) fx.addColumn(point, rand(5, 9), 0.8 * k);
  }

  // Assemble (and record on the bomb) everything the blast model wants to know
  // about one impact.
  impactInfo(b, point, hitRec, hitTank) {
    const speed = b.vel.length();
    const dir = new THREE.Vector3().copy(b.vel);
    if (speed > 1e-6) dir.divideScalar(speed);
    const normal = hitRec && hitRec.normal ? hitRec.normal : null;
    b.armed = !b.armFail && b.age >= b.armTime;
    let delayed = b.delay > 0;
    // A bomb that could not arm on contact is never a dud: it falls back to
    // the delay element and goes off LOW_DROP_DELAY after landing (update()
    // sticks it at the impact point and runs the fuse). Rockets keep duds.
    b.lowDrop = !b.armed && b.type !== 'rocket';
    if (b.lowDrop) {
      b.armed = true;
      b.delay = Math.max(b.delay || 0, LOW_DROP_DELAY);
      delayed = true;
    }
    b.dud = !b.armed;
    b.delayed = delayed;
    b.direct = !!hitTank;
    b.target = hitTank || null;
    b.hit = hitRec || null;
    b.impactDir = dir;
    b.impactNormal = normal;
    b.impactSpeed = speed;
    const prof = b.profile || blastProfile(b.type, b.radius);
    return {
      type: b.type,
      point,
      radius: b.radius,
      armed: b.armed,
      dud: b.dud,
      delayed,
      // true when the fuse could not arm on contact and the low-drop delay
      // took over; `fuse` is the seconds it burns after landing (0 = instant)
      lowDrop: b.lowDrop,
      fuse: delayed ? b.delay : 0,
      direct: b.direct,
      target: b.target,
      hit: b.hit,
      normal,
      dir,
      speed,
      shooter: b.shooter,
      team: b.shooter ? b.shooter.team : undefined,
      age: b.age,
      releaseHeight: b.releaseHeight,
      damage: b.damage,
      pen: b.pen,
      groundY: groundHeightAt(point.x, point.z),
      surface: impactSurface(point.x, point.z),
      // the blast this round is reporting, so every consumer scales off one
      // set of numbers instead of inventing its own
      profile: prof,
      kill: prof.kill,
      penAt0: prof.penAt0,
      softDamage: prof.softDamage,
      planeRadius: prof.planeRadius,
      planeDamage: prof.planeDamage,
      soundSize: prof.soundSize,
      crater: prof.crater,
      fxPlayed: false,
    };
  }

  // Simulate a drop from the plane's current state; true if `out` was filled
  // with the predicted impact point (used for the bomb sight marker).
  // `info`, when supplied, is filled with { time, armed, delayed, height }.
  // `armed` means "bursts on contact"; `delayed` is its complement — the bomb
  // is still live but will go off LOW_DROP_DELAY after landing, which a sight
  // can show ('DELAY') before the pilot pickles. No drop ever predicts a dud.
  predictImpact(plane, out, info = null) {
    const high = plane.position.y - RELEASE_DROP
      - groundHeightAt(plane.position.x, plane.position.z) >= this.bombArmHeight;
    // Arming is decided on the store's real first quarter-second, not on the
    // coarse sight path below: drop() starts it RELEASE_DROP under the
    // fuselage with the rack's push (0.7 down plus 0.9 along the offset) and
    // update() tests the ground 0.2 m early. The coarse path is ~1.3 m high
    // and rounds its landing time up a whole step, which promised an instant
    // burst on drops that were really delayed (10/252 threshold cells).
    let inTime = true;
    if (info && high) {
      const hs = 1 / 240;
      let x = plane.position.x;
      let y = plane.position.y - RELEASE_DROP;
      let z = plane.position.z;
      const vx = plane.dir.x * plane.speed * 0.98;
      const vz = plane.dir.z * plane.speed * 0.98;
      let vy = plane.dir.y * plane.speed * 0.98 - 1.6;
      for (let t = hs; t < this.bombArmTime; t += hs) {
        vy -= GRAVITY * hs;
        x += vx * hs;
        y += vy * hs;
        z += vz * hs;
        if (y <= groundHeightAt(x, z) + 0.2) {
          inTime = false;
          break;
        }
      }
    }
    const p = tmpD.copy(plane.position);
    let vx = plane.dir.x * plane.speed * 0.98;
    let vy = plane.dir.y * plane.speed * 0.98;
    let vz = plane.dir.z * plane.speed * 0.98;
    const h = 0.08;
    for (let t = 0; t < 14; t += h) {
      vy -= GRAVITY * h;
      p.x += vx * h;
      p.y += vy * h;
      p.z += vz * h;
      if (p.y <= groundHeightAt(p.x, p.z)) {
        out.copy(p);
        if (info) {
          info.time = t + h;
          info.armed = high && inTime;
          info.delayed = !info.armed;
          info.height = plane.position.y - p.y;
        }
        return true;
      }
    }
    if (info) {
      info.time = 14;
      info.armed = high;
      info.delayed = !info.armed;
      info.height = 0;
    }
    return false;
  }

  dispose() {
    for (const b of this.bombs) this.scene.remove(b.mesh);
    this.bombs.length = 0;
    this.ripples.length = 0;
    this.pendingShake.length = 0;
  }
}
