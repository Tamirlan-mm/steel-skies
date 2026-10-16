import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Internal layout of a tank — one source of truth.
//
// The damage model traces the penetrator through these boxes and breaks
// whatever it actually passes through; the X-ray view draws the very same
// boxes. Before this file existed the two disagreed: the X-ray drew an engine
// in the rear while the damage roll only looked at which armour face was hit,
// so the player saw one thing and got another.
//
// Frames: 'hull' boxes live in the tank group's local space (origin on the
// ground, forward +Z). 'turret' boxes live in turret space, which rotates with
// the turret. Those are exactly the spaces buildTankMesh parents its meshes to,
// so the X-ray can attach them without any extra maths.
// ---------------------------------------------------------------------------

// Penetration (mm of armour equivalent) each module soaks from a shell passing
// through it. Once the budget is spent the penetrator stops there.
export const RESIST = {
  engine: 55,
  transmission: 40,
  breech: 45,
  fuel: 12,
  ammo: 10,
  crew: 6,
  // the gun-laying gear and the cooling group: small, thin-walled assemblies,
  // so they break easily but soak almost nothing on the way through
  traverse: 22,
  elevation: 18,
  barrel: 18,
  radiator: 10,
};

export const MODULE_COLOR = {
  engine: 0xd08040,
  transmission: 0xc0709a,
  breech: 0x9aa4b0,
  fuel: 0xe07050,
  ammo: 0xe8d060,
  crew: 0x58d068,
  traverse: 0x6fb0d8,
  elevation: 0xa08cd8,
  barrel: 0xc2cad2,
  radiator: 0x54c8bc,
};

// Post-penetration spall: fragments thrown off the back face of the plate.
// Solid AP throws a tight cone, APHE bursts inside and sprays wide, APCR is
// famously poor at it, HEAT sends a narrow jet.
// `range` (metres from the burst/entry point) is how far a fragment still
// carries enough to wreck anything: without it a turret-front penetration
// sprayed the engine at the back of the hull (tankEntity passes it as
// traceInternals' maxDist).
// HEAT is the odd one out: what goes on behind the plate is the jet itself, a
// pencil of metal that keeps cutting until its last few millimetres are spent,
// so it is narrow and long rather than a spray. At 2 rays x 0.22 rad x 1.5 m it
// stopped short of the crew behind a Tiger or T-34 glacis and a third of all
// HEAT penetrations there did no visible damage at all.
export const SPALL = {
  AP: { rays: 3, spread: 0.3, energy: 0.55, range: 1.8 },
  APHE: { rays: 5, spread: 0.55, energy: 0.75, range: 2.4 },
  APCR: { rays: 2, spread: 0.18, energy: 0.35, range: 1.2 },
  HEAT: { rays: 3, spread: 0.12, energy: 0.6, range: 2.6 },
  HE: { rays: 5, spread: 0.7, energy: 0.6, range: 2.0 },
};

// The bursting charge itself. The spall cone above is the forward spray; the
// filler going off inside the compartment also throws the shell body out
// sideways and fills the space with overpressure, which reaches every man
// within `range + caliber * perMm` metres of the burst whichever way he sits —
// unless the gearbox casing is between them (SHIELD_KINDS, crewWithin).
// Without it a PzGr 39 that burst at the back of a Stuart's 1.5 m turret
// missed the gunner and loader it had just passed (they were in front of the
// burst, the cone only goes forward) and the turret kill rate was 1-2%.
// `energy * caliber` is the mm-equivalent a man right at the burst takes,
// falling linearly to nothing at the edge of the range; under `min` mm it is
// spent — applyModuleDamage gives anything that reaches a man at least a 15%
// chance to kill him, so the thin outer edge of the reach would otherwise kill
// men it should only frighten. In the fighting compartment it touches the
// crew only: a gearbox casing shrugs off what a man does not, which is also
// what keeps the Tiger's front transmission from becoming a sponge again —
// the one exception is a round that bursts INSIDE the casing, which spends
// its charge on it and on nothing else (fillerWithin). HE
// carries several times the filler of an APHE round, hence the wider reach. A
// burst in the engine bay stays there — the bulkhead in front of the engine is
// in the way (crewWithin) — and wrecks the powerpack's plumbing instead
// (engineBayWithin).
export const FILLER = {
  APHE: { range: 0.6, perMm: 0.006, energy: 0.3, min: 3 },
  HE: { range: 0.8, perMm: 0.01, energy: 0.35, min: 3 },
};

// Crew stations by crew size. Where each man sits decides who the shell
// reaches, which is what makes flank shots read correctly on the X-ray — and
// the entity layer now hangs real consequences off the name that comes back,
// so losing the gunner is not the same loss as losing the loader.
const CREW_ORDER = ['driver', 'gunner', 'commander', 'loader', 'radio'];

// Which stations a given vehicle actually crews, in the same order the boxes
// are laid out. A four-man tank has no dedicated radio operator — the
// commander works the set — so the role simply is not placed.
export function crewRoles(spec) {
  const n = Math.max(1, Math.min(CREW_ORDER.length, spec.crew | 0));
  return CREW_ORDER.slice(0, n);
}

// How long one module takes to put right, in seconds, with a full crew and a
// repair kit to hand. The entity scales these by how many hands are left: a
// track is a two-man job with a bar and a hammer, a final drive is not.
export const MODULE_REPAIR = {
  tracks: 8,
  engine: 14,
  transmission: 16,
  breech: 9,
  barrel: 24,
  traverse: 15,
  elevation: 13,
  radiator: 11,
};

// Delay fuses. An APHE round has to be well inside the vehicle before the
// filler lets go, which is the whole point of it: the spall cone is thrown
// from the burst point, not from the back of the plate. `arm` is the leftover
// penetration below which the round simply passes through as a solid shot,
// the way a fuse that never sees enough resistance fails to arm.
export const FUSE = {
  APHE: { dist: 1.15, arm: 8, label: 'Shell explosion' },
  HE: { dist: 0.3, arm: 0 },
  HEAT: { dist: 0.18, arm: 0 },
};

const layoutCache = new WeakMap();

function box(key, kind, frame, pos, half, label) {
  return { key, kind, frame, pos, half, label, resist: RESIST[kind] };
}

// Build (and cache) the module boxes for one vehicle spec.
export function buildInternals(spec) {
  let mods = layoutCache.get(spec);
  if (mods) return mods;

  const { w, h, len, trackH } = spec.hull;
  const t = spec.turret;
  const midY = trackH + h * 0.5; // fighting-compartment centre line
  // The interior runs from the belly plate to the roof, not from the top of
  // the track run: a hull box that starts above the tracks leaves the whole
  // lower hull empty, and every lower-front-plate penetration reached nothing.
  const floor = spec.hull.clear ?? trackH * 0.45;
  const roof = trackH + h;
  const H = roof - floor;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  // The gearbox lives wherever the drive sprocket is. The T-34-85, SU-100 and
  // M26 drive from the rear sprocket, so their transmission sits behind the
  // engine; front-drive tanks keep theirs low behind the lower front plate.
  const rearDrive = !!(spec.chassis && spec.chassis.sprocket && spec.chassis.sprocket.z < 0);
  mods = [];

  // A real fighting compartment is cramped — the boxes below are sized to
  // leave only narrow gaps, so a penetration that damages nothing is rare
  // rather than routine.

  // A front gearbox is about a metre wide (the Tiger's sits between the driver
  // and the radio operator); the old full-width box swallowed both seats.
  const trHalfX = Math.min(0.55, w * 0.15);
  const engZ = rearDrive ? -len * 0.23 : -len * 0.33;
  const engHalfZ = rearDrive ? len * 0.12 : len * 0.15;

  // --- crew stations, worked out first because the racks have to clear them ---
  // Bow seats sit on the belly either side of a front gearbox, clear of it.
  // Turret crew ride a basket with their legs down in the hull, so their boxes
  // are taller and reach below the turret ring — otherwise no hull-front shot
  // could ever touch the gunner, loader or commander. They stop under the
  // turret roof, though: on the SU-100 the "turret" is a 0.42 m casemate lid
  // and the full-height boxes stood 0.10-0.15 m out through it (the Stuart's
  // commander 0.06 m).
  const bowX = rearDrive ? 0 : trHalfX + 0.32;
  const seats = {
    driver: ['hull', V(Math.max(w * 0.24, bowX), floor + H * 0.5, len * 0.3)],
    radio: ['hull', V(-Math.max(w * 0.26, bowX), floor + H * 0.5, len * 0.28)],
    gunner: ['turret', V(t.w * 0.26, t.h * 0.42 - 0.2, -t.len * 0.02)],
    loader: ['turret', V(-t.w * 0.28, t.h * 0.4 - 0.2, t.len * 0.05)],
    commander: ['turret', V(-t.w * 0.2, t.h * 0.52 - 0.2, -t.len * 0.22)],
  };
  const crewBoxes = [];
  let turretCrewX = 0; // how far out the turret crew reach either side (yaw 0)
  for (const role of crewRoles(spec)) {
    const [frame, pos] = seats[role];
    const half = frame === 'turret' ? V(0.3, 0.55, 0.3) : V(0.3, 0.36, 0.3);
    if (frame === 'turret') {
      const top = Math.min(pos.y + half.y, t.h - 0.03);
      const bottom = Math.max(pos.y - half.y, floor - roof + 0.02);
      pos.y = (top + bottom) * 0.5;
      half.y = (top - bottom) * 0.5;
      turretCrewX = Math.max(turretCrewX, Math.abs(pos.x) + half.x);
    }
    crewBoxes.push(box(`crew_${role}`, 'crew', frame, pos, half, 'Crew member'));
  }

  // --- hull: powerpack at the rear, final drive wherever the sprocket is ---
  // The engine is narrow enough that the fuel cells beside it no longer sit
  // inside it.
  mods.push(box('engine', 'engine', 'hull',
    V(0, floor + H * 0.5, engZ), V(w * 0.2, H * 0.32, engHalfZ), 'Engine'));
  if (rearDrive) {
    mods.push(box('transmission', 'transmission', 'hull',
      V(0, floor + H * 0.42, -len * 0.435), V(w * 0.3, H * 0.38, len * 0.055), 'Transmission'));
  } else {
    mods.push(box('transmission', 'transmission', 'hull',
      V(0, floor + H * 0.33, len * 0.36), V(trHalfX, H * 0.3, len * 0.1), 'Transmission'));
  }

  // fuel cells flank the engine behind the firewall, and sit low in the hull —
  // that separation matters, otherwise every broadside sweeps fuel and ammo
  // alike and half the battle is on fire
  for (const side of [-1, 1]) {
    mods.push(box(`fuel${side < 0 ? 'L' : 'R'}`, 'fuel', 'hull',
      V(side * w * 0.33, midY - h * 0.2, engZ + len * 0.05), V(w * 0.09, h * 0.24, len * 0.13), 'Fuel tank'));
  }

  // ammo stowage down both sponsons — the classic side-shot detonation. The
  // racks are bins against the hull side, OUTSIDE the turret basket: their
  // inboard face stops clear of the turret crew's legs. Reaching in to w*0.15
  // they overlapped the gunner and loader boxes by 11-31%, so a hit on a man
  // was also a roll on the rack. Their outboard face goes out to the sponson
  // wall (w*0.45, was w*0.41) to keep most of the head-on area; a side shot
  // crosses the full rack either way (its side-on area is unchanged).
  const rackIn = Math.min(w * 0.38, Math.max(w * 0.15, turretCrewX + 0.03));
  const rackOut = w * 0.45;
  for (const side of [-1, 1]) {
    mods.push(box(`ammoHull${side < 0 ? 'L' : 'R'}`, 'ammo', 'hull',
      V(side * (rackIn + rackOut) * 0.5, midY, len * 0.06),
      V((rackOut - rackIn) * 0.5, h * 0.34, len * 0.16), 'Ammo rack'));
  }
  // Floor bins under the turret basket. Every vehicle here carried rounds on
  // the fighting-compartment floor — the T-34-85 and SU-100 most of them (the
  // T-34-85's 39 floor rounds against a handful on the walls), the M26 in
  // sub-floor racks — and without them a lower-plate penetration crossed an
  // empty belly 15-26% of the time with nothing to show for it.
  mods.push(box('ammoFloor', 'ammo', 'hull',
    V(0, floor + 0.17, t.offZ),
    V(Math.min(t.w * 0.34, w * 0.25), 0.15, Math.min(t.len * 0.24, len * 0.11)), 'Ammo rack'));

  // radiators and fans sit on the engine deck above the powerpack, which is
  // why a strafing run that never touches the armour still leaves a tank
  // overheating its way back to cover
  mods.push(box('radiator', 'radiator', 'hull',
    V(0, trackH + h * 0.82, -len * 0.43), V(w * 0.3, h * 0.15, len * 0.06), 'Radiator'));

  // --- turret ---
  mods.push(box('breech', 'breech', 'turret',
    V(0, t.h * 0.5, t.len * 0.05), V(t.w * 0.16, t.h * 0.32, t.len * 0.22), 'Gun breech'));

  // The barrel runs out through the mantlet, so it is the one module a
  // head-on shot at the gun shield can wreck without ever getting inside.
  const gunLen = spec.gunLen || 3;
  mods.push(box('barrel', 'barrel', 'turret',
    V(0, t.h * 0.48, t.len * 0.3 + gunLen * 0.45),
    V(0.12, 0.12, gunLen * 0.45 + t.len * 0.2), 'Gun barrel'));

  // laying gear: the traverse motor sits on the turret floor at the ring, the
  // elevation gear on the trunnion beside the breech
  mods.push(box('traverse', 'traverse', 'turret',
    V(t.w * 0.3, t.h * 0.13, t.len * 0.08), V(t.w * 0.12, t.h * 0.13, t.len * 0.1),
    'Turret drive'));
  mods.push(box('elevation', 'elevation', 'turret',
    V(-t.w * 0.21, t.h * 0.3, t.len * 0.17), V(t.w * 0.1, t.h * 0.15, t.len * 0.09),
    'Elevation drive'));

  // roomy turrets carry ready rounds in the bustle
  if (t.len > 2.6) {
    mods.push(box('ammoTurret', 'ammo', 'turret',
      V(0, t.h * 0.5, -t.len * 0.34), V(t.w * 0.28, t.h * 0.32, t.len * 0.13), 'Ammo rack'));
  }

  // --- crew stations (laid out above), last as they always were ---
  for (const c of crewBoxes) mods.push(c);

  layoutCache.set(spec, mods);
  return mods;
}

// Ray vs axis-aligned box (slab method) in the box's own frame.
// Returns the entry distance along `dir`, 0 if the ray starts inside,
// or null if it misses / the box is behind the origin.
function rayVsBox(o, dir, c, half) {
  let tmin = 0;
  let tmax = Infinity;
  for (const a of ['x', 'y', 'z']) {
    const d = dir[a];
    const lo = c[a] - half[a];
    const hi = c[a] + half[a];
    if (Math.abs(d) < 1e-9) {
      if (o[a] < lo || o[a] > hi) return null;
      continue;
    }
    let t1 = (lo - o[a]) / d;
    let t2 = (hi - o[a]) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
}

const tmpO = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const scratch = [];

// Walk one penetrator through the internals, in hull-local space.
// Returns the modules it actually reaches, nearest first, stopping once the
// penetration budget (mm of armour equivalent) runs out.
// `maxDist` (metres along `dir`) cuts the walk short — that is how a delay-
// fused round is stopped at the point where its filler goes off, so everything
// past the burst is reached by the spall cone instead of by the shell body.
export function traceInternals(spec, origin, dir, turretYaw, budget, maxDist = Infinity) {
  const mods = buildInternals(spec);
  const pivotY = spec.hull.trackH + spec.hull.h;
  const pivotZ = spec.turret.offZ;
  const cos = Math.cos(-turretYaw);
  const sin = Math.sin(-turretYaw);
  scratch.length = 0;

  for (const m of mods) {
    let o = tmpO.copy(origin);
    let d = tmpD.copy(dir);
    if (m.frame === 'turret') {
      // hull space -> turret space: drop to the pivot, then unrotate
      const px = origin.x;
      const py = origin.y - pivotY;
      const pz = origin.z - pivotZ;
      o.set(px * cos + pz * sin, py, -px * sin + pz * cos);
      d.set(dir.x * cos + dir.z * sin, dir.y, -dir.x * sin + dir.z * cos);
    }
    const t = rayVsBox(o, d, m.pos, m.half);
    if (t !== null && t <= maxDist) scratch.push({ mod: m, t });
  }

  scratch.sort((a, b) => a.t - b.t);
  const out = [];
  let left = budget;
  for (const s of scratch) {
    if (left <= 0) break;
    // `energy` is what the penetrator still carried on arrival, in mm — a
    // fragment down to its last few millimetres should not wreck a module the
    // way a fresh round does
    out.push({ key: s.mod.key, kind: s.mod.kind, label: s.mod.label, t: s.t, energy: left });
    left -= s.mod.resist;
  }
  return out;
}

// Is a point (hull-local space) in the engine bay: below the hull roof and
// behind the front face of the engine? Every vehicle here is rear-engined with
// a bulkhead between the engine bay and the men. A turret bustle overhanging
// the engine deck is above the roof line and counts as the fighting
// compartment.
export function inEngineBay(spec, point) {
  if (point.y >= spec.hull.trackH + spec.hull.h) return false;
  for (const m of buildInternals(spec)) {
    if (m.key === 'engine') return point.z < m.pos.z + m.half.z;
  }
  return false;
}

// What makes the engine bay burn when it is hit: the engine (its fuel, oil
// and ignition lines and the fans, not the block), the radiators over it and
// the fuel cells beside it.
const BAY_KINDS = ['engine', 'radiator', 'fuel'];

// The bursting charge (FILLER) going off IN the engine bay: the powerpack
// parts within `range` metres of the point, nearest-surface distance, shaped
// like crewWithin's result. Empty anywhere else. There are no men back there
// to take it, and without this an HE shell that only just beat the rear plate
// arrived with a few millimetres of penetration left and did nothing visible
// 59-66% of the time (Pershing rear, 88 / 90 mm HE) — its 0.7-1 kg of filler
// going off among the fuel lines counted for nothing. The gearbox is left to
// the shell body and the spall cone, front or rear, for the reason FILLER
// gives: its casing shrugs off what the filler throws.
export function engineBayWithin(spec, point, range) {
  const out = [];
  if (!inEngineBay(spec, point)) return out;
  for (const m of buildInternals(spec)) {
    if (m.frame !== 'hull' || BAY_KINDS.indexOf(m.kind) < 0) continue;
    const dx = Math.max(0, Math.abs(point.x - m.pos.x) - m.half.x);
    const dy = Math.max(0, Math.abs(point.y - m.pos.y) - m.half.y);
    const dz = Math.max(0, Math.abs(point.z - m.pos.z) - m.half.z);
    const d = Math.hypot(dx, dy, dz);
    if (d <= range) out.push({ key: m.key, kind: m.kind, label: m.label, d });
  }
  return out;
}

// The heavy assemblies — the engine block and the gearbox — are lumps of cast
// steel: what a bursting charge throws into them stays in them. A man with one
// of them between him and the burst is out of its reach (crewWithin), and a
// shell that bursts inside one spends its charge on it (fillerWithin) — the
// spall cone has always behaved that way, since traceInternals starts its rays
// inside the casing and the casing soaks them first. The filler ignored them:
// an 88 mm APHE that burst inside a Tiger's front gearbox (16% of its upper-
// plate penetrations) still struck the driver or the radio operator 99% of the
// time, and a burst beside the gearbox reached the man on its far side as well.
// Tiger upper plate, AP family: crew hit 66.9% -> 63.8% of penetrations (88 mm
// APHE 89.5 -> 74.5%), transmission broken and kills per shot unchanged.
// The gun breech is NOT on the list. It stands in the middle of an open turret
// basket a man's width from everybody, and in a turret that small the blast
// and the fragments thrown back off the walls get round it: with the breech
// shielding, an 88 mm burst behind a Stuart's breech left the loader untouched
// and the turret-front kill fell from 75% to 0%.
const SHIELD_KINDS = ['engine', 'transmission'];

const losO = new THREE.Vector3();
const losD = new THREE.Vector3();

// Is the straight line from `a` to `b` (hull-local) blocked by a shield module:
// does it pass through one, or start inside one? `cos` / `sin` are the turret
// unrotation traceInternals uses.
function lineShielded(spec, mods, a, b, cos, sin) {
  const pivotY = spec.hull.trackH + spec.hull.h;
  const pivotZ = spec.turret.offZ;
  for (const m of mods) {
    if (SHIELD_KINDS.indexOf(m.kind) < 0) continue;
    const o = losO.copy(a);
    const d = losD.subVectors(b, a);
    if (m.frame === 'turret') {
      const px = a.x;
      const pz = a.z - pivotZ;
      const dx = d.x;
      const dz = d.z;
      o.set(px * cos + pz * sin, a.y - pivotY, -px * sin + pz * cos);
      d.set(dx * cos + dz * sin, d.y, -dx * sin + dz * cos);
    }
    // d is the whole segment, so the line is blocked when the box starts
    // before its far end (t < 1)
    const t = rayVsBox(o, d, m.pos, m.half);
    if (t !== null && t < 1 - 1e-6) return true;
  }
  return false;
}

const losP = new THREE.Vector3();

// A point given in a box's own frame, back in hull-local space (the inverse of
// the hull -> turret transform), into `out`.
function frameToHull(spec, frame, x, y, z, cos, sin, out) {
  if (frame !== 'turret') return out.set(x, y, z);
  return out.set(
    x * cos - z * sin,
    y + spec.hull.trackH + spec.hull.h,
    x * sin + z * cos + spec.turret.offZ,
  );
}

// The crew stations within `range` metres of a point inside the vehicle
// (hull-local space, the frame traceInternals takes), nearest-surface
// distance, for the bursting charge (FILLER). Returns [{ key, kind, label, d }].
// Nothing at all when the point is in the engine bay (inEngineBay): the
// bulkhead is in the way, and a 100 mm HE shell that burst in a Stuart's
// engine bay was otherwise wounding the turret crew through it 78% of the
// time (engineBayWithin covers what it does there instead).
// A man is reached only along a clear line (SHIELD_KINDS): to the nearest part
// of him, or failing that to the middle of him — then at that longer distance,
// so he takes less of it. With both lines through the gearbox casing, or the
// burst inside it, he is not reached at all.
export function crewWithin(spec, point, turretYaw, range) {
  const mods = buildInternals(spec);
  const out = [];
  const pivotY = spec.hull.trackH + spec.hull.h;
  const pivotZ = spec.turret.offZ;
  if (inEngineBay(spec, point)) return out;
  const cos = Math.cos(-turretYaw);
  const sin = Math.sin(-turretYaw);
  for (const m of mods) {
    if (m.kind !== 'crew') continue;
    let x = point.x;
    let y = point.y;
    let z = point.z;
    if (m.frame === 'turret') {
      // the same hull -> turret transform traceInternals uses
      const px = point.x;
      const pz = point.z - pivotZ;
      x = px * cos + pz * sin;
      y = point.y - pivotY;
      z = -px * sin + pz * cos;
    }
    const dx = Math.max(0, Math.abs(x - m.pos.x) - m.half.x);
    const dy = Math.max(0, Math.abs(y - m.pos.y) - m.half.y);
    const dz = Math.max(0, Math.abs(z - m.pos.z) - m.half.z);
    let d = Math.hypot(dx, dy, dz);
    if (d > range) continue;
    // a burst inside the man's own box has nothing in between
    if (d > 0) {
      const nx = THREE.MathUtils.clamp(x, m.pos.x - m.half.x, m.pos.x + m.half.x);
      const ny = THREE.MathUtils.clamp(y, m.pos.y - m.half.y, m.pos.y + m.half.y);
      const nz = THREE.MathUtils.clamp(z, m.pos.z - m.half.z, m.pos.z + m.half.z);
      if (lineShielded(spec, mods, point, frameToHull(spec, m.frame, nx, ny, nz, cos, sin, losP), cos, sin)) {
        d = Math.hypot(x - m.pos.x, y - m.pos.y, z - m.pos.z);
        if (d > range) continue;
        const c = frameToHull(spec, m.frame, m.pos.x, m.pos.y, m.pos.z, cos, sin, losP);
        if (lineShielded(spec, mods, point, c, cos, sin)) continue;
      }
    }
    out.push({ key: m.key, kind: m.kind, label: m.label, d });
  }
  return out;
}

// Everything the bursting charge (FILLER) of a round that went off at `point`
// (hull-local) reaches within `range` metres, as [{ key, kind, label, d }] —
// what resolvePenetration applies. In the engine bay that is the powerpack
// (engineBayWithin); in the fighting compartment the men in clear line of it
// (crewWithin) and, when it went off inside the gearbox casing, the gearbox
// itself at d = 0: the casing takes the charge it spares the men. Without that
// an HE round through a Wirbelwind's lower plate, which bursts in the gearbox,
// did nothing visible in 12% of penetrations (0% before the casing shielded
// the men; 0.3% with this).
export function fillerWithin(spec, point, turretYaw, range) {
  if (inEngineBay(spec, point)) return engineBayWithin(spec, point, range);
  const out = crewWithin(spec, point, turretYaw, range);
  for (const m of buildInternals(spec)) {
    if (m.frame !== 'hull' || SHIELD_KINDS.indexOf(m.kind) < 0) continue;
    if (Math.abs(point.x - m.pos.x) <= m.half.x && Math.abs(point.y - m.pos.y) <= m.half.y
      && Math.abs(point.z - m.pos.z) <= m.half.z) {
      out.push({ key: m.key, kind: m.kind, label: m.label, d: 0 });
    }
  }
  return out;
}

const basisA = new THREE.Vector3();
const basisB = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);

// A cone of fragment directions around `dir`, used for spall and blast.
export function coneDirections(dir, count, spread) {
  basisA.crossVectors(dir, Math.abs(dir.y) > 0.9 ? SIDE : UP).normalize();
  basisB.crossVectors(dir, basisA).normalize();
  const out = [];
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = Math.tan(spread * Math.sqrt(Math.random()));
    out.push(
      dir.clone()
        .addScaledVector(basisA, Math.cos(ang) * r)
        .addScaledVector(basisB, Math.sin(ang) * r)
        .normalize(),
    );
  }
  return out;
}
