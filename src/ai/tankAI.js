import * as THREE from 'three';
import * as terrain from '../world/terrain.js';
// Walls and rocks on a sight line: the same building shapes that stop the
// rounds (scenery.js imports nothing from ai/, so no cycle).
import { propBlocksLine, solidPushOut } from '../world/scenery.js';
import { shellPenAt } from '../vehicles/tanks.js';
import { sfx3d } from '../core/audio.js';
import { clamp, wrapAngle, rand } from '../core/utils.js';

const { terrainHeight } = terrain;

// The ground table is being added to terrain.js in this same wave, so look for
// it once and get on with life if it never turns up.
const surfaceAt = typeof terrain.terrainSurface === 'function' ? terrain.terrainSurface : null;

const tmpV = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const losV = new THREE.Vector3(); // dedicated: hasLOS must not clobber caller temps

const DEG = Math.PI / 180;

// Reused by plateAgainst so the armour lookup a gunner does every frame costs
// nothing. Read the fields out before calling it again.
const plateRes = { zone: 'front', thickness: 0, eff: 0 };

// Crew contract (tankEntity.js): staffed(role) = a living man sitting in the
// seat, not climbing across into it. Guarded so an entity without the methods
// still answers the way it always did.
function seatStaffed(t, role) {
  if (typeof t.staffed === 'function') return t.staffed(role);
  if (role === 'driver') return t.canDrive !== false;
  const st = t.crewStations;
  if (!t.crewAlive || !st || !st.includes(role)) return true;
  return t.crewAlive[role] > 0;
}
function canFireStream(t) {
  if (typeof t.canFireStream === 'function') return t.canFireStream();
  return !!t.alive && seatStaffed(t, 'gunner') && t.streamAmmo > 0;
}
// how close to the edge of the playable square a bot will aim its hull
const EDGE_MARGIN = 5;

// Houses and boulders are walls to a hull (the battles push a hull back out
// of them with scenery.js solidPushOut), so a crew drives round one instead
// of into it: the hull's own footprint is swept ahead — discs of its half
// width plus a hand's breadth, every AVOID_STEP metres from its nose, as far
// as the tank covers in the next second and a half — against the very
// footprints that would stop it (a boulder narrower than the hull included),
// and while that is blocked the heading swings a step at a time to whichever
// side opens first (the side that worked last, else this crew's orbit side).
// An answer is kept AVOID_HOLD seconds, as an offset from the heading asked
// for: that caps the cost and stops a crew dithering between the two sides.
// Boxed in on every side, it drives on and updateStuck backs it out.
const AVOID_STEPS = [0.4, 0.8, 1.2, 1.6, 2.0];
const AVOID_LOOK = 7;      // m ahead at a standstill
const AVOID_LOOK_V = 1.5;  // s of travel added on the move
const AVOID_LOOK_MAX = 20; // m
const AVOID_STEP = 1.5;    // m between the swept discs
const AVOID_HOLD = 0.2;    // s an answer is kept
const avoidDisc = new THREE.Vector4();
const avoidShove = new THREE.Vector3();

function headingBlocked(t, yaw, look) {
  const hull = t.spec && t.spec.hull;
  if (!hull) return false;
  const half = hull.w * 0.5;
  const nose = Math.max(0, hull.len * 0.5 - half);
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  for (let d = nose; d <= nose + look; d += AVOID_STEP) {
    avoidDisc.set(t.position.x + fx * d, t.position.y, t.position.z + fz * d, half + 0.25);
    if (solidPushOut(avoidDisc, avoidShove)) return true;
  }
  return false;
}

const MAX_SIGHT = 650;    // how far a crew can pick a vehicle out of the ground
const ENGAGE_RANGE = 340; // beyond this the AI drives rather than fights
const CLOSE_FIGHT = 170;  // inside this a duel always beats the objective

// Every hold state in this file is bounded. A tank that is allowed to stand
// still without a deadline will, sooner or later, stand still for the whole
// match — which is exactly the bug these numbers exist to make impossible.
const ANGLE_HOLD_MAX = 12;   // hard ceiling on one uninterrupted angleHull stop
const POSTURE_HOLD_MAX = 4.5; // the "nothing better to do" stop in fight()
const STALL_LIMIT = 9;       // parked this long with no excuse: forced re-plan
const PLAN_REFRESH = 0.45;   // seconds between team-plan rebuilds

// Objective scoring. All additive, all expressed in map-crossings, so that a
// held point can genuinely LOSE to a distant unheld one — the whole point of
// the exercise. Lower is better; pickWaypoint takes the argmin.
const W_DIST = 1.0;      // one whole map crossing costs 1.0
const W_CAPTURE = 0.62;  // a point that is not ours is the job
const W_NEUTRAL = 0.14;  // neutral is cheaper to take than enemy-held
const W_CONTEST = 0.3;   // a fight already in progress wants help
const W_CROWD = 0.3;     // per bot already going there: spread the side out
const W_DEFEND = 0.55;   // a defender's pull toward ground the team owns
const W_STALE = 0.55;    // an attacker's shove off ground the team already owns
const W_LOSING = 0.9;    // our point with the enemy bar climbing on it

// Line of sight over terrain, and now through smoke: a screen is line of sight
// the crew do not have, which is the entire reason to carry the grenades.
// `smoke` is an Effects instance and is optional — the two-argument call the
// battle files make is unchanged.
export function hasLOS(from, to, smoke = null) {
  const dist = from.distanceTo(to);
  const steps = Math.max(2, Math.floor(dist / 15));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    losV.lerpVectors(from, to, t);
    if (terrainHeight(losV.x, losV.z) > losV.y + 0.4) return false;
  }
  if (smoke && smoke.blocksLineOfSight && smoke.blocksLineOfSight(from, to)) return false;
  return true;
}

// Is a building (standing or in ruins) or a rock between the two points? The
// same shapes ShellManager stops rounds on, so a crew never picks, keeps or
// fires at a hull it could only reach through a house — and the trees, which
// a round flies through, are not counted. Scenery is decoration to a battle
// that runs without it, so a failure here is "no wall".
export function wallBetween(from, to) {
  try {
    return propBlocksLine(from, to, false);
  } catch (err) {
    return false;
  }
}

// How opaque a smoke screen has to be drawn on a sight line before a crew
// cannot pick a vehicle out through it (effects.smokeOpacityAlong, 0..1; the
// game's own blind rule is 0.95). The battles take every HUD mark off a hull
// at this same figure, so a bot never shoots at something the player is not
// allowed to see — the old rule let it hold a solution through a cloud drawn
// two-thirds solid.
const SMOKE_BLIND = 0.6;
// how long a crew keeps laying on the spot a target vanished into before
// they give him up and look for something else
const SMOKE_MEMORY = 2.5;
// the extra gunner's error, per unit of smoke opacity on the line, for a
// target still visible through a thin veil
const SMOKE_AIM_ERR = 2.2;

// 0..1: how much of `to` the smoke hides from `from` — the effects module's
// integral of the same volume it draws. Without that query, the yes/no rule.
function smokeVeil(smoke, from, to) {
  if (!smoke || smoke.activeScreens === 0) return 0;
  if (typeof smoke.smokeOpacityAlong === 'function') return smoke.smokeOpacityAlong(from, to);
  return smoke.blocksLineOfSight && smoke.blocksLineOfSight(from, to) ? 1 : 0;
}

// Is this sight line blind through smoke, by the game's rule or by the
// SMOKE_BLIND opacity the player's own HUD is held to?
function smokeBlinds(smoke, from, to) {
  if (!smoke || smoke.activeScreens === 0) return false;
  if (smoke.blocksLineOfSight && smoke.blocksLineOfSight(from, to)) return true;
  return smokeVeil(smoke, from, to) >= SMOKE_BLIND;
}

// Effective thickness of the plate a shot from `from` would actually strike,
// in mm. This is the same geometry the damage model uses — the plate's own lay
// combined with the line of flight — so what the AI believes about a target is
// what the armour is going to do to its round.
function plateAgainst(spec, isTurret, yawWorld, from, aimPoint, caliber) {
  const dx = from.x - aimPoint.x;
  const dy = from.y - aimPoint.y;
  const dz = from.z - aimPoint.z;
  const s = Math.sin(yawWorld);
  const c = Math.cos(yawWorld);
  // into the target's own frame: +Z is its nose, +X its left
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  const len = Math.hypot(lx, dy, lz) || 1;
  const ux = lx / len;
  const uy = dy / len;
  const uz = lz / len;

  const set = isTurret ? spec.armor.turret : spec.armor.hull;
  const slopes = (isTurret ? spec.armor.turretSlope : spec.armor.hullSlope) || null;
  const zone = Math.abs(uz) >= Math.abs(ux) ? (uz > 0 ? 'front' : 'rear') : 'side';
  const thickness = set[zone] ?? set.side ?? 25;
  const slope = ((slopes && slopes[zone]) || 0) * DEG;
  const sn = Math.sin(slope);
  const cn = Math.cos(slope);
  let nx = 0;
  let nz = 0;
  if (zone === 'front') nz = cn;
  else if (zone === 'rear') nz = -cn;
  else nx = ux > 0 ? cn : -cn;
  const cosI = Math.abs(ux * nx + uy * sn + uz * nz);

  plateRes.zone = zone;
  plateRes.thickness = thickness;
  // a round three times fatter than the plate overmatches it and the lay stops
  // counting, exactly as the entity's own model has it
  plateRes.eff = caliber >= thickness * 3 ? thickness : thickness / Math.max(0.2, cosI);
  return plateRes;
}

// ---------------------------------------------------------------------------
// objectives — the shared picture of the capture points
// ---------------------------------------------------------------------------
// The two ground modes both publish capture zones and they do NOT publish the
// same object. Ground Domination (game/battle.js) writes thirteen fields —
// key,x,z,r,owner,cap,capTeam,allies,enemies,contested,pos,ring,progressRing —
// while Combined Arms (game/combinedBattle.js) writes seven — key,x,z,r,owner,
// progress,ring — with no contested flag and no occupancy counts at all. So
// nothing in this file touches a raw zone. Everything reads the normalised
// record below, and whatever the source is missing is DERIVED here by counting
// hulls, which means neither battle file has to change for any of this to work:
//
//   { ref, key, x, z, r, owner, allies, enemies, contested, capTeam, capFrac }
//
//   owner    -1 neutral, 0 allies, 1 enemies       (both modes already agree)
//   allies   live team-0 hulls inside the ring     (counted here when absent)
//   enemies  live team-1 hulls inside the ring     (counted here when absent)
//   capTeam  the team currently pushing the bar, -1 for nobody
//   capFrac  0..1 of that bar, whichever way the source stores it
//
// battle.js keeps cap as 0..100 toward capTeam; combinedBattle.js keeps
// progress as -100..100 with negative meaning team 0 is gaining. Both collapse
// to the same (capTeam, capFrac) pair here.
function normaliseZones(raw, tanks) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const z = raw[i];
    if (!z || typeof z.x !== 'number' || typeof z.z !== 'number') continue;
    const r = typeof z.r === 'number' ? z.r
      : typeof z.radius === 'number' ? z.radius : 25;

    let allies = typeof z.allies === 'number' ? z.allies : -1;
    let enemies = typeof z.enemies === 'number' ? z.enemies : -1;
    if (allies < 0 || enemies < 0) {
      allies = 0;
      enemies = 0;
      if (Array.isArray(tanks)) {
        const rr = r * r;
        for (const t of tanks) {
          if (!t || !t.alive || !t.position) continue;
          const dx = t.position.x - z.x;
          const dz = t.position.z - z.z;
          if (dx * dx + dz * dz > rr) continue;
          if (t.team === 0) allies++;
          else enemies++;
        }
      }
    }

    let capTeam = -1;
    let capFrac = 0;
    if (typeof z.cap === 'number') {
      capFrac = clamp(z.cap / 100, 0, 1);
      if (capFrac > 0.004) capTeam = typeof z.capTeam === 'number' ? z.capTeam : -1;
    } else if (typeof z.progress === 'number') {
      capFrac = clamp(Math.abs(z.progress) / 100, 0, 1);
      if (capFrac > 0.004) capTeam = z.progress < 0 ? 0 : 1;
      // a finished bar there stays pinned at +/-100 under its own owner: that
      // is a captured point, not a capture in progress
      if (capTeam === z.owner) {
        capTeam = -1;
        capFrac = 0;
      }
    }

    out.push({
      ref: z,
      key: z.key != null ? String(z.key) : `z${i}`,
      x: z.x,
      z: z.z,
      r,
      owner: typeof z.owner === 'number' ? z.owner : -1,
      allies,
      enemies,
      contested: typeof z.contested === 'boolean'
        ? z.contested
        : allies > 0 && enemies > 0,
      capTeam,
      capFrac,
    });
  }
  return out.length ? out : null;
}

// Public: the normalised capture-point picture for a battle, or null when the
// battle has no capture points at all (an air battle, say). planeAI.js reads
// the objectives through this so the two files cannot drift apart.
export function readZones(battle) {
  if (!battle) return null;
  const raw = battle.zones || battle.captureZones || battle.capZones || null;
  return normaliseZones(raw, battle.tanks);
}

// horizontal distance. The waypoint is stored at y = 0 and the ground runs to
// about +/-20 m, so a 3-D compare against it can never be trusted: on a flank
// point the height difference alone can exceed the arrival threshold and the
// bot never registers that it got there.
function horizDist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

const nowSec = typeof performance !== 'undefined' && performance.now
  ? () => performance.now() / 1000
  : () => Date.now() / 1000;

// One of these per (battle, team). It owns the things no single bot can know:
// what the whole side has been told to do, and who has already been sent where.
class TeamPlan {
  constructor(battle, team) {
    this.battle = battle;
    this.team = team;
    this.members = [];
    this.seq = 0;
    this.zones = null;
    this.override = null;     // raw array pushed in by setObjectives()
    this.assign = new Map();  // zone key -> bots currently claiming it
    this.stamp = -1e9;
    this.version = 0;
    this.mapScale = 400;
  }

  register(ai) {
    ai.planSeq = this.seq++;
    ai.deadFor = 0;
    this.members.push(ai);
    this.dirty();
  }

  // Bump the version and drop the refresh timestamp: every bot on the side
  // notices within one frame and re-plans.
  dirty() {
    this.version++;
    this.stamp = -1e9;
  }

  setOverride(raw) {
    this.override = Array.isArray(raw) && raw.length ? raw : null;
    this.dirty();
  }

  claim(ai, key) {
    if (ai.claimKey === key) return;
    if (ai.claimKey) {
      const n = (this.assign.get(ai.claimKey) || 0) - 1;
      if (n > 0) this.assign.set(ai.claimKey, n);
      else this.assign.delete(ai.claimKey);
    }
    ai.claimKey = key;
    if (key) this.assign.set(key, (this.assign.get(key) || 0) + 1);
  }

  refresh(force) {
    const now = nowSec();
    if (!force && now - this.stamp < PLAN_REFRESH) return;
    this.stamp = now;
    this.zones = normaliseZones(
      this.override || this.battle.zones || this.battle.captureZones ||
        this.battle.capZones || null,
      this.battle.tanks,
    );

    // the yardstick every distance term is measured in: the widest separation
    // between two objectives, so the weights mean the same thing on a 400 m
    // layout and on a 600 m one
    let scale = 0;
    if (this.zones) {
      for (let i = 0; i < this.zones.length; i++) {
        for (let j = i + 1; j < this.zones.length; j++) {
          const d = Math.hypot(
            this.zones[i].x - this.zones[j].x,
            this.zones[i].z - this.zones[j].z,
          );
          if (d > scale) scale = d;
        }
      }
    }
    this.mapScale = Math.max(120, scale || 400);

    this.prune();
    this.rebuildAssignments();
    this.assignRoles();
  }

  // A destroyed bot is never revived — the battle files build a fresh Tank and
  // a fresh TankAI on respawn — but give it a couple of refreshes' grace before
  // dropping it, so nothing depends on the exact frame a hull dies.
  prune() {
    for (let i = this.members.length - 1; i >= 0; i--) {
      const ai = this.members[i];
      if (ai.tank && ai.tank.alive) {
        ai.deadFor = 0;
        continue;
      }
      if (++ai.deadFor > 3) {
        this.claim(ai, null);
        this.members.splice(i, 1);
      }
    }
  }

  rebuildAssignments() {
    this.assign.clear();
    for (const ai of this.members) {
      if (!ai.tank.alive || !ai.claimKey) continue;
      this.assign.set(ai.claimKey, (this.assign.get(ai.claimKey) || 0) + 1);
    }
  }

  // Split the side. Some bots push the next objective, the rest sit on what the
  // team already holds — and nobody defends when the team holds nothing.
  assignRoles() {
    const live = [];
    for (const ai of this.members) if (ai.tank.alive) live.push(ai);
    if (live.length === 0) return;

    let owned = 0;
    if (this.zones) for (const z of this.zones) if (z.owner === this.team) owned++;

    let defenders = owned === 0 ? 0 : Math.min(owned, Math.floor(live.length * 0.4));
    if (owned > 0 && live.length >= 3 && defenders < 1) defenders = 1;
    if (defenders > live.length - 1) defenders = live.length - 1;
    if (defenders < 0) defenders = 0;

    // Whoever is already sitting on our own ground defends it. The bias term is
    // hysteresis: without it a role flips every time two bots swap places.
    for (const ai of live) {
      let near = Infinity;
      if (this.zones) {
        for (const z of this.zones) {
          if (z.owner !== this.team) continue;
          const d = Math.hypot(z.x - ai.tank.position.x, z.z - ai.tank.position.z);
          if (d < near) near = d;
        }
      }
      ai.roleScore = (near === Infinity ? 1e6 : near) -
        (ai.role === 'defend' ? 90 : 0) + ai.planSeq * 0.001;
    }
    live.sort((a, b) => a.roleScore - b.roleScore);
    for (let i = 0; i < live.length; i++) {
      const want = i < defenders ? 'defend' : 'attack';
      if (live[i].role !== want) {
        live[i].role = want;
        live[i].zoneTimer = 0; // a new job is re-planned at once
      }
    }
  }

  // The additive score. Never multiplicative on distance: that was the defect
  // that made a captured point mathematically incapable of losing the argmin.
  score(z, ai) {
    const t = ai.tank;
    const team = this.team;
    const d = Math.hypot(z.x - t.position.x, z.z - t.position.z) / this.mapScale;
    const ours = z.owner === team;
    const crowd = (this.assign.get(z.key) || 0) - (ai.claimKey === z.key ? 1 : 0);
    const defender = ai.role === 'defend';

    let s = W_DIST * d;
    if (!ours) s -= W_CAPTURE;
    if (z.owner === -1) s -= W_NEUTRAL;
    if (z.contested) s -= W_CONTEST;
    // our own ground with the enemy bar climbing on it: everybody cares
    if (ours && z.capTeam >= 0 && z.capTeam !== team) {
      s -= W_LOSING * (0.4 + z.capFrac);
    }
    if (defender) s += ours ? -W_DEFEND : W_DEFEND * 0.5;
    else if (ours) s += W_STALE;
    s += W_CROWD * Math.max(0, crowd) * (defender ? 0.5 : 1);
    return s;
  }
}

const plans = new WeakMap(); // battle -> Map(team -> TeamPlan)

function getPlan(battle, team) {
  let byTeam = plans.get(battle);
  if (!byTeam) {
    byTeam = new Map();
    plans.set(battle, byTeam);
  }
  let plan = byTeam.get(team);
  if (!plan) {
    plan = new TeamPlan(battle, team);
    byTeam.set(team, plan);
  }
  return plan;
}

/**
 * Event hook for the battle classes: call this the instant a capture point
 * changes hands and every TankAI on BOTH sides re-plans on its next frame,
 * instead of waiting out an eight-to-fourteen second timer.
 *
 *   notifyObjectivesChanged(this);              // "something flipped, re-plan"
 *   notifyObjectivesChanged(this, this.zones);  // "...and here is the new list"
 *
 * `zones` is optional and may be either schema; passing it replaces the list
 * the AI reasons about, passing null goes back to reading battle.zones.
 * Returns true when at least one team plan existed to be told.
 */
export function notifyObjectivesChanged(battle, zones = null) {
  const byTeam = plans.get(battle);
  if (!byTeam) return false;
  for (const plan of byTeam.values()) {
    if (zones !== null) plan.setOverride(zones);
    else plan.dirty();
  }
  return true;
}

export class TankAI {
  constructor(tank, battle) {
    this.tank = tank;
    this.battle = battle;
    this.target = null;
    this.threat = null;
    this.threatSeen = false;
    this.airTarget = null;
    this.losTarget = false;

    this.retargetTimer = rand(0, 0.7);
    this.reactionTimer = 0;
    this.zoneTimer = 0;
    this.coverTimer = 0;
    this.aidCd = 0;
    this.smokeCd = rand(0, 6);
    this.shellCd = 0;
    this.shellKeys = null;      // ammunition list, cached per spec (see chooseShell)
    this.shellKeysSpec = null;
    this.soundCd = 0;
    this.errTimer = 0;
    this.stopHold = 0;
    this.stuckAccum = 0;
    this.reverseTimer = 0;
    this.avoidSide = 0;        // the side avoidWalls last found open (-1 / 0 / 1)
    this.avoidSideAt = -1e9;   // battle time it last needed that side
    this.avoidAt = -1e9;       // battle time of avoidWalls' last answer...
    this.avoidOffset = 0;      // ...as an offset from the heading asked for
    this.streamBurst = 0;
    this.streamRest = rand(0.2, 1.6);
    // ---- smoke ----
    this.sightCd = 0;          // throttle on the per-target smoke check
    this.sightOf = null;       // the target the verdict below is about
    this.smokeBlind = false;   // that target has gone into smoke
    this.blindFor = 0;         // ...for this long
    this.smokeVeil = 0;        // 0..1 opacity on the line to it while visible

    // ---- objectives ----
    // this.zone used to be written here and read precisely nowhere. The
    // objective is a live thing now: a normalised zone record, a claim the rest
    // of the side can see, and a role that says what to do with it.
    this.objective = null;   // normalised zone record, or null
    this.zone = null;        // kept: the raw zone object, for anything outside
    this.claimKey = null;    // what this bot has told the team it is going to
    this.role = 'attack';    // 'attack' | 'defend', owned by the team plan
    this.planSeq = 0;
    this.deadFor = 0;
    this.roleScore = 0;
    this.planVersion = -1;
    this.atObjective = false;
    this.holdZone = false;
    this.pushTimer = 0;      // seconds the objective outranks any duel
    this.angleHold = 0;      // bounded: total time parked by angleHull
    this.postureHold = 0;    // bounded: the "nothing better to do" stop
    this.idleAccum = 0;      // watchdog against standing still for ever
    this.holdTimer = rand(3, 8);
    this.plan = getPlan(battle, tank.team);
    this.plan.register(this);

    // owned vectors: no aliasing games with the shared temporaries
    this.waypoint = new THREE.Vector3();
    this.aimWorld = new THREE.Vector3();
    this.aimErr = new THREE.Vector3();
    this.moveGoal = new THREE.Vector3();
    this.coverPoint = new THREE.Vector3();

    this.orbitDir = Math.random() < 0.5 ? 1 : -1;
    const spec = tank.spec;
    this.isLight = spec.klass === 'Light Tank';
    this.isSPAA = !!spec.aa;
    this.isCasemate = spec.turretYawLimit != null;
    this.isHeavy = spec.klass === 'Heavy Tank' || spec.klass === 'Battle Tank';
    // spec.aimFactor comes off the crew skills when a battle spawns a modded
    // vehicle; on a stock AI tank it simply is not there.
    this.aimError = (this.isLight ? 0.016 : 0.012) * (spec.aimFactor || 1);
    this.grip = 1;
    this.canPen = true;
    this.armour = 0;

    this.pickWaypoint();
  }

  // ---------------------------------------------------------------------
  // perception
  // ---------------------------------------------------------------------
  eyePos(out) {
    const p = this.tank.turretWorldPos(out);
    p.y += 0.6;
    return p;
  }

  // Centre of mass of a target, which is where a gunner lays before he starts
  // picking at weak spots.
  centreOf(target, out) {
    const h = target.spec.hull;
    return out.set(
      target.position.x,
      target.position.y + h.trackH + h.h * 0.6,
      target.position.z,
    );
  }

  // One pass over the enemy: what we would rather shoot, and who is the most
  // dangerous thing looking back at us. They are usually not the same vehicle,
  // and the difference is what the hull gets angled against.
  acquire() {
    const t = this.tank;
    const eye = this.eyePos(tmpA);
    const smoke = this.battle.effects;
    let best = null;
    let bestScore = Infinity;
    let threat = null;
    let threatScore = Infinity;

    for (const other of this.battle.tanks) {
      if (!other.alive || other.team === t.team) continue;
      const d = t.position.distanceTo(other.position);
      if (d > MAX_SIGHT) continue;
      this.centreOf(other, tmpV);
      // the ground first (the dearer test, but the common blocker), then smoke
      // at the same opacity the player's HUD is held to, then the walls
      if (!hasLOS(eye, tmpV)) continue;
      if (smokeBlinds(smoke, eye, tmpV)) continue;
      if (wallBetween(eye, tmpV)) continue;

      let score = d;
      if (other.isPlayer) score -= 60;
      if (other === t.lastAttacker) score -= 90;
      // a target this gun cannot beat is a poor use of a reload
      if (!this.wouldPenetrate(other, d)) score += 200;
      if (score < bestScore) {
        bestScore = score;
        best = other;
      }

      // threat: everything that can see us is a threat, and the one that can
      // do it soonest is the one to keep the glacis pointed at
      const ts = d - (other.isPlayer ? 40 : 0) - (other === t.lastAttacker ? 120 : 0);
      if (ts < threatScore) {
        threatScore = ts;
        threat = other;
      }
    }

    // A target that has just vanished into smoke is not dropped on this
    // sweep if nothing else is in sight: the crew keep the gun on the spot he
    // went in for SMOKE_MEMORY (updateSight counts it) — remembered, not seen.
    const remembered = !best && this.target && this.target.alive &&
      this.smokeBlind && this.sightOf === this.target && this.blindFor < SMOKE_MEMORY;
    if (remembered) best = this.target;
    if (best !== this.target) {
      this.target = best;
      this.reactionTimer = rand(0.4, 0.9);
      this.errTimer = 0;
      this.stopHold = 0;
    }
    // everything that survived that loop was in sight when we looked
    this.losTarget = !!best && !remembered;
    this.threat = threat;
    // everything in that loop already had line of sight to our turret, and
    // line of sight is symmetric
    this.threatSeen = !!threat;
    if (this.isSPAA) this.acquireAir();
    if (surfaceAt) {
      const s = surfaceAt(t.position.x, t.position.z);
      this.grip = s && typeof s.grip === 'number' ? clamp(s.grip, 0.3, 1.4) : 1;
    }
  }

  // Aircraft only matter to a vehicle that can reach them, so only the SPAA
  // pays for this loop — and only in a battle that has aeroplanes in it.
  acquireAir() {
    this.airTarget = null;
    const list = this.battle.planes;
    if (!Array.isArray(list) || list.length === 0) return;
    const t = this.tank;
    const smoke = this.battle.effects;
    const eye = this.eyePos(tmpB);
    let best = null;
    let bestD = Infinity;
    for (const pl of list) {
      if (!pl.alive || pl.team === t.team) continue;
      const d = t.position.distanceTo(pl.position);
      if (d > 900) continue;
      // a low aeroplane behind the screen is no more visible than a tank
      if (smokeBlinds(smoke, eye, pl.position)) continue;
      if (d < bestD) {
        bestD = d;
        best = pl;
      }
    }
    this.airTarget = best;
  }

  // Would the loaded round get through this target's likely aspect? Cheap
  // enough for the target-selection loop; layGun does the careful version.
  wouldPenetrate(other, dist) {
    const t = this.tank;
    const shell = t.spec.shells[t.shellType];
    if (!shell) return false;
    if (t.ammo[t.shellType] <= 0) return false;
    this.centreOf(other, tmpB);
    const p = plateAgainst(other.spec, false, other.yaw, this.eyePos(tmpC), tmpB, shell.caliber || 75);
    return shellPenAt(shell, dist) > p.eff;
  }

  // ---------------------------------------------------------------------
  // objectives
  // ---------------------------------------------------------------------
  // The battle may expose a list of capture zones; if it does not, this is the
  // single point at the origin the game has always fought over.
  zoneList() {
    this.plan.refresh(false);
    return this.plan.zones;
  }

  /**
   * Event hook, per bot. The battle classes may call this on any TankAI when a
   * point changes hands; it re-plans that bot's whole side. `zones` is optional
   * and may be either battle schema. Prefer the module-level
   * notifyObjectivesChanged(battle) — one call covers both teams.
   */
  onObjectivesChanged(zones = null) {
    if (zones !== null) this.plan.setOverride(zones);
    else this.plan.dirty();
    this.zoneTimer = 0;
    return this;
  }

  /**
   * Replace the objective list this bot's side reasons about. Pass either
   * battle schema, or null to go back to reading battle.zones.
   */
  setObjectives(zones) {
    this.plan.setOverride(zones);
    this.zoneTimer = 0;
    return this;
  }

  // Re-elect an objective and a point inside it. Called on the timer, on
  // arrival, when the team plan changes version, and whenever a hold state runs
  // out of budget — never on a schedule alone.
  pickWaypoint(force = false) {
    this.zoneTimer = rand(8, 14);
    const plan = this.plan;
    plan.refresh(force);
    this.planVersion = plan.version;
    const zones = plan.zones;

    if (zones) {
      let best = null;
      let bestScore = Infinity;
      for (const z of zones) {
        const s = plan.score(z, this);
        if (s < bestScore) {
          bestScore = s;
          best = z;
        }
      }
      if (best) {
        const same = this.objective && this.objective.key === best.key;
        this.objective = best;
        this.zone = best.ref; // the raw zone, for anything outside this file
        plan.claim(this, best.key);
        // Re-rolling the in-ring offset on every re-plan is what made the old
        // bot shuffle twenty metres and park again. Keep the point we are
        // already driving to unless the objective actually changed, or we are
        // standing on it and repositioning inside the ring is the whole idea.
        if (!same || this.atObjective || force) this.rollHoldPoint();
        return;
      }
    }

    // No zone list at all: the single point at the origin this game has always
    // fought over, with a personal offset.
    this.objective = null;
    this.zone = null;
    plan.claim(this, null);
    if (!this.atObjective || force) this.rollHoldPoint();
  }

  // Somewhere inside the ring. Defenders sit out in it where there is cover to
  // be had, attackers push toward the middle where the bar actually ticks.
  rollHoldPoint() {
    const z = this.objective;
    if (!z) {
      const a = rand(0, Math.PI * 2);
      const r = rand(6, 26);
      this.waypoint.set(Math.sin(a) * r, 0, Math.cos(a) * r);
      return;
    }
    const a = rand(0, Math.PI * 2);
    const band = this.role === 'defend' ? rand(0.35, 0.85) : rand(0.15, 0.7);
    const r = band * z.r;
    this.waypoint.set(z.x + Math.sin(a) * r, 0, z.z + Math.cos(a) * r);
  }

  // Where we stand in relation to the objective. Horizontal distance only —
  // the waypoint is stored at y = 0 and the ground runs to about +/-20 m, so a
  // 3-D compare against it can never fire on a flank point.
  refreshObjective() {
    const t = this.tank;
    const plan = this.plan;
    plan.refresh(false); // internally throttled; only the first caller pays

    // The normalised records are rebuilt on every plan refresh, so the one we
    // are holding is a snapshot. Re-bind by key or the ownership, contest and
    // capture-bar terms below would all be reading history.
    if (this.objective) {
      let live = null;
      if (plan.zones) {
        for (const c of plan.zones) {
          if (c.key === this.objective.key) {
            live = c;
            break;
          }
        }
      }
      this.objective = live;
      if (live) this.zone = live.ref;
      else this.zoneTimer = 0; // the point we were sent to no longer exists
    } else if (plan.zones && this.claimKey === null) {
      this.zoneTimer = 0;      // zones appeared after we planned without them
    }

    const z = this.objective;
    if (!z) {
      this.atObjective = horizDist(t.position, this.waypoint) < 20;
      this.holdZone = false;
      return;
    }
    const d = Math.hypot(z.x - t.position.x, z.z - t.position.z);
    this.atObjective = d < z.r * 1.15;
    const team = t.team;
    const foes = team === 0 ? z.enemies : z.allies;
    // Standing here is doing work: the ring is contested, or it is not ours
    // yet, or somebody else's bar is climbing on it.
    this.holdZone = this.atObjective &&
      (z.contested || z.owner !== team || foes > 0 ||
        (z.capTeam >= 0 && z.capTeam !== team));
  }

  // How badly this bot is wanted on its point, 0..1.
  objectiveUrgency() {
    const z = this.objective;
    if (!z) return 0.25;
    const team = this.tank.team;
    const mine = team === 0 ? z.allies : z.enemies;
    const foes = team === 0 ? z.enemies : z.allies;
    let u = 0.35;
    if (z.owner !== team) u += 0.3;
    if (z.capTeam >= 0 && z.capTeam !== team) u += 0.25;
    if (z.contested) u += 0.15;
    if (mine === 0 && z.owner !== team) u += 0.15;
    if (this.role === 'defend' && z.owner === team && foes > 0) u += 0.3;
    return clamp(u, 0, 1);
  }

  // Does the objective outrank the fight in front of us? Sometimes it has to,
  // or a bot that is winning a capture walks off the point to duel something at
  // three hundred metres that it cannot even hurt.
  shouldPressObjective(target, dist) {
    // Nothing, not even a watchdog push, drives blithely past a tank at
    // seventy metres. That is knife range and it gets answered.
    if (dist < CLOSE_FIGHT * 0.45) return false;
    if (this.pushTimer > 0) return true;
    if (!target) return true;
    if (dist < CLOSE_FIGHT) return false;
    // the man who is actually shooting at us gets answered
    const th = this.threat;
    if (th && th.alive && th === this.tank.lastAttacker &&
      horizDist(this.tank.position, th.position) < 240) return false;
    // holding the ring IS the objective: do not walk off it to chase
    if (this.atObjective && this.holdZone) return false;
    if (!this.canPen && dist > 140) return true;
    const cut =
      CLOSE_FIGHT + (1 - this.objectiveUrgency()) * (ENGAGE_RANGE - CLOSE_FIGHT);
    return dist > cut;
  }

  // Keep a manoeuvre inside the ring while the ring is the job.
  leash(goal) {
    const z = this.objective;
    if (!z || !this.holdZone) return goal;
    const dx = goal.x - z.x;
    const dz = goal.z - z.z;
    const d = Math.hypot(dx, dz);
    const lim = z.r * 0.9;
    if (d > lim && d > 1e-3) {
      goal.x = z.x + (dx / d) * lim;
      goal.z = z.z + (dz / d) * lim;
    }
    return goal;
  }

  // ---------------------------------------------------------------------
  // damage control
  // ---------------------------------------------------------------------
  // Returns true when the crew have a job that has to be done standing still.
  updateDamageControl(dt) {
    const t = this.tank;
    let pinned = false;

    // A fire is now a death sentence with a countdown on it. The bottle is the
    // only thing that beats it quickly; without one the crew have to stop,
    // because a fire cannot be smothered on a moving vehicle.
    if (t.burning) {
      if (t.consumables.fpe > 0) t.useExtinguisher();
      else pinned = true;
    }

    // The kit goes on whoever is hurt badly enough to be costing the vehicle
    // its gun or its legs.
    if (this.aidCd <= 0 && t.consumables.firstAid > 0) {
      let worst = 1;
      for (let i = 0; i < t.crewStations.length; i++) {
        const h = t.crewAlive[t.crewStations[i]];
        if (h < worst) worst = h;
      }
      if (worst < 0.5 && t.useFirstAid()) this.aidCd = 10;
    }

    // Smoke is for breaking contact, not for a fair fight: it goes out when the
    // vehicle is hurt and something has a clear view of it.
    const hurt =
      !t.modules.tracks.ok || !t.modules.breech.ok || t.crewFrac < 0.62 || t.burning;
    if (this.smokeCd <= 0 && hurt && this.threatSeen && t.consumables.smoke > 0) {
      this.throwSmoke();
      this.smokeCd = 30;
    }

    // Repairs: the crew get on with it themselves the moment the vehicle stops
    // (autoRepair), but the decision to STOP is the commander's. A track is not
    // a decision at all — nothing moves until it is back on.
    if (!t.modules.tracks.ok) {
      pinned = true;
      t.startRepair('tracks');
    } else if (!t.repairing) {
      const critical =
        !t.modules.engine.ok || !t.modules.breech.ok ||
        !t.modules.traverse.ok || !t.modules.transmission.ok;
      // out of sight is the only place worth spending fifteen seconds
      if (critical && !this.threatSeen) {
        pinned = true;
        t.startRepair();
      }
    } else if (t.repairing && !this.threatSeen) {
      pinned = true;
    }
    return pinned;
  }

  throwSmoke() {
    const t = this.tank;
    // if the battle grew its own grenade plumbing, let it own the whole job
    if (typeof this.battle.deploySmoke === 'function') {
      this.battle.deploySmoke(t);
      return;
    }
    const s = t.deploySmoke();
    if (!s) return;
    const fx = this.battle.effects;
    if (fx && fx.smokeScreen) fx.smokeScreen(s.pos, s.radius, s.duration);
  }

  // ---------------------------------------------------------------------
  // gunnery
  // ---------------------------------------------------------------------
  // Angular half-size of the target at this range: the cone the round is
  // allowed to be thrown into and still hit something.
  aimTolerance(target, dist) {
    const half = Math.max(1.2, target.spec.hull.w * 0.45);
    return clamp(half / Math.max(25, dist), 0.0015, 0.03);
  }

  // Where on the target the gunner is trying to put the round, and whether what
  // he has loaded will get through when it lands there. Writes this.aimWorld.
  layGun(target, dist) {
    const t = this.tank;
    const spec = target.spec;
    const shell = t.spec.shells[t.shellType];
    const caliber = shell.caliber || 75;
    const pen = shellPenAt(shell, dist);
    const eye = this.eyePos(tmpC);

    // Hull centre first: the fattest part of the target, with the crew, the
    // fuel and the racks stacked up behind it.
    const h = spec.hull;
    tmpA.set(target.position.x, target.position.y + h.trackH + h.h * 0.45, target.position.z);
    let p = plateAgainst(spec, false, target.yaw, eye, tmpA, caliber);
    let bestEff = p.eff;
    let bestZone = p.zone;
    this.aimWorld.copy(tmpA);

    // Then the turret cheek — kept deliberately off centre, because the gun
    // shield in the middle of it is the thickest casting on most of these
    // vehicles and putting a round into it achieves nothing.
    const tYaw = target.yaw + target.turretYaw;
    target.turretWorldPos(tmpB);
    const cs = Math.cos(tYaw);
    const sn = Math.sin(tYaw);
    const sx = (eye.x - tmpB.x) * cs - (eye.z - tmpB.z) * sn;
    const side = sx >= 0 ? 1 : -1;
    tmpB.x += cs * spec.turret.w * 0.33 * side;
    tmpB.z -= sn * spec.turret.w * 0.33 * side;
    p = plateAgainst(spec, true, tYaw, eye, tmpB, caliber);
    if (p.eff < bestEff) {
      bestEff = p.eff;
      bestZone = p.zone;
      this.aimWorld.copy(tmpB);
    }

    this.armour = bestEff;
    this.aimZone = bestZone;
    this.canPen = pen > bestEff * 1.02;

    // Nothing on this vehicle is worth a round from here. Put it through the
    // running gear instead — a tank that cannot move is a tank that can be
    // walked around — and go looking for a flank.
    if (!this.canPen) {
      this.aimWorld.set(
        target.position.x,
        target.position.y + h.trackH * 0.55,
        target.position.z,
      );
    }
  }

  // Which round to have in the breech. Switching costs most of a reload, so it
  // is done in the instant after a shot when the gun is empty anyway.
  chooseShell(target, dist) {
    const t = this.tank;
    if (this.shellCd > 0) return;
    // The decision costs an armour solve per round type, so it is rate-limited
    // whether or not it ends in a swap: a loader does not reconsider his
    // ammunition sixty times a second, and the answer cannot change that fast.
    // The window stays around a second so the swap still catches the early part
    // of a reload, where it is free.
    this.shellCd = rand(0.7, 1.3);
    if (this.shellKeysSpec !== t.spec) {
      this.shellKeysSpec = t.spec;
      this.shellKeys = Object.keys(t.spec.shells);
    }
    const keys = this.shellKeys;
    if (keys.length < 2) return;
    const spec = target.spec;
    const eye = this.eyePos(tmpC);
    const h = spec.hull;
    tmpA.set(target.position.x, target.position.y + h.trackH + h.h * 0.45, target.position.z);

    let bestKey = null;
    let bestMargin = -Infinity;
    for (const key of keys) {
      const shell = t.spec.shells[key];
      if (!shell || t.ammo[key] <= 0) continue;
      const p = plateAgainst(spec, false, target.yaw, eye, tmpA, shell.caliber || 75);
      let margin = shellPenAt(shell, dist) - p.eff;
      // HE is a last resort against armour and a first choice against an
      // open-topped vehicle, where the blast simply drops in on the crew
      if (shell.kind === 'HE') {
        margin = (spec.armor.turret.top || 0) < 6 ? margin + 60 : margin - 90;
      }
      // subcalibre is precious and short-legged: keep it for what needs it
      if (shell.kind === 'APCR') margin -= 25;
      if (key === t.shellType) margin += 12; // inertia: do not dither
      if (margin > bestMargin) {
        bestMargin = margin;
        bestKey = key;
      }
    }
    if (!bestKey || bestKey === t.shellType) return;
    // free swap while the gun is being reloaded anyway, otherwise only when the
    // round in the breech is simply not going to do the job
    const free = t.reload > t.effReload * 0.55;
    if (free || (!this.canPen && bestMargin > 0)) {
      t.setShellType(bestKey);
      this.shellCd = 4;
    }
  }

  // Nobody fires through a friendly hull, and with friendly fire on in
  // realistic that matters more than it looks.
  friendlyInLine(target) {
    const t = this.tank;
    const eye = this.eyePos(tmpC);
    const dx = target.position.x - eye.x;
    const dz = target.position.z - eye.z;
    const len = Math.hypot(dx, dz);
    if (len < 1) return false;
    const ux = dx / len;
    const uz = dz / len;
    for (const o of this.battle.tanks) {
      if (o === t || !o.alive || o.team !== t.team) continue;
      const ox = o.position.x - eye.x;
      const oz = o.position.z - eye.z;
      const along = ox * ux + oz * uz;
      if (along < 5 || along > len - 4) continue;
      if (Math.abs(ox * uz - oz * ux) < o.radius + 1.4) return true;
    }
    return false;
  }

  updateGun(dt, target, dist) {
    const t = this.tank;

    // The SPAA's business is aeroplanes; its main gun is a formality.
    if (this.isSPAA && this.airTarget && this.airTarget.alive) {
      this.layAir(dt, this.airTarget);
      return;
    }

    if (!target) {
      this.losTarget = false;
      // A target that has just gone into smoke keeps the gun laid where he
      // was last seen — nothing tracks the hull itself through the cloud —
      // until the crew give him up (update() drops him after SMOKE_MEMORY).
      if (this.smokeBlind && this.target) return;
      // rest the gun forward while cruising
      const f = t.forwardDir(tmpA).multiplyScalar(60).add(t.position);
      f.y += 2;
      t.aimPoint.copy(f);
      return;
    }

    this.layGun(target, dist);
    this.chooseShell(target, dist);

    // Lead. The gun itself compensates for gravity, so this is only where the
    // target will have got to by the time the round arrives.
    const shell = t.spec.shells[t.shellType];
    const tof = dist / shell.speed;
    const tv = Math.sin(target.yaw) * target.speed;
    const tvz = Math.cos(target.yaw) * target.speed;
    this.aimWorld.x += tv * tof;
    this.aimWorld.z += tvz * tof;

    // The gunner's error is held for a second at a time rather than rerolled
    // every frame: a sight that jitters is a turret that never stops slewing,
    // and a turret that never stops slewing never lets its dispersion settle.
    this.errTimer -= dt;
    if (this.errTimer <= 0) {
      this.errTimer = rand(0.6, 1.1);
      // a thin veil of smoke on the line costs the gunner his fine lay
      const err = this.aimError * dist * (1 + Math.abs(target.speed) * 0.06) *
        (t.crewAlive.gunner > 0 ? 1 : 1.9) * (1 + SMOKE_AIM_ERR * this.smokeVeil);
      this.aimErr.set(rand(-err, err), rand(-err, err) * 0.5, rand(-err, err));
    }
    t.aimPoint.copy(this.aimWorld).add(this.aimErr);

    // ---- the decision to fire ----
    if (this.reactionTimer > 0 || !t.canFire() || !seatStaffed(t, 'gunner') || dist > 700) return;
    const need = this.aimTolerance(target, dist);
    // the sight has to have settled: this is the whole reason the tank stops
    if (t.dispersion > need * 0.95) return;
    if (!t.isAimedAt(t.aimPoint, Math.max(need * 0.9, 0.004))) return;
    const eye = this.eyePos(tmpC);
    this.centreOf(target, tmpD);
    // the last look before the trigger: the ground, then smoke at the opacity
    // the player's own HUD is held to, then a house or a rock in the way —
    // and the gun's own line too, which from a hull beside a wall can be
    // blocked when the commander's view over it is not
    this.losTarget = hasLOS(eye, tmpD) && !smokeBlinds(this.battle.effects, eye, tmpD)
      && !wallBetween(eye, tmpD) && !wallBetween(t.muzzleWorld ? t.muzzleWorld(tmpB) : eye, tmpD);
    if (!this.losTarget) return;
    if (this.friendlyInLine(target)) return;
    this.battle.requestFire(t);
  }

  // Lay the quad on an aeroplane: lead it by the time of flight and let the
  // gun's own ballistic solution take care of the drop.
  layAir(dt, plane) {
    const t = this.tank;
    const wpn = t.spec.aa || t.spec.mg;
    const speed = wpn ? wpn.speed : 900;
    const d = t.position.distanceTo(plane.position);
    const tof = d / speed;
    tmpA.copy(plane.position);
    if (plane.vel) tmpA.addScaledVector(plane.vel, tof);
    else tmpA.addScaledVector(plane.dir, plane.speed * tof);
    // aircraft are small and fast; the error is a real one
    this.errTimer -= dt;
    if (this.errTimer <= 0) {
      this.errTimer = rand(0.4, 0.8);
      const err = d * 0.012;
      this.aimErr.set(rand(-err, err), rand(-err, err), rand(-err, err));
    }
    t.aimPoint.copy(tmpA).add(this.aimErr);
    this.losTarget = true;
  }

  // ---------------------------------------------------------------------
  // stream weapons: the SPAA's quad, and the coax against thin skin
  // ---------------------------------------------------------------------
  updateStream(dt) {
    const t = this.tank;
    const wpn = t.spec.aa || t.spec.mg;
    if (!wpn) return;
    // nothing else ticks this down for an AI vehicle — the battle only drives
    // the player's stream
    if (t.streamTimer > 0) t.streamTimer -= dt;
    if (this.soundCd > 0) this.soundCd -= dt;
    // no gunner in his seat (or an empty belt) and the quad / coax is silent
    if (!canFireStream(t)) {
      this.streamBurst = 0;
      return;
    }

    // If the battle grew a hook for AI stream fire, hand the whole job over.
    const hook = this.battle.requestStream;
    let victim = null;
    if (this.isSPAA && this.airTarget && this.airTarget.alive) {
      victim = this.airTarget;
    } else {
      const g = this.target;
      // a machine gun is only worth firing at something a machine gun can hurt
      if (g && g.alive) {
        const thin = Math.min(g.spec.armor.hull.side, g.spec.armor.hull.top) <= 16;
        const reach = this.isSPAA ? 420 : 260;
        if (thin && t.position.distanceTo(g.position) < reach) victim = g;
      }
    }
    if (!victim || !this.losTarget) {
      this.streamBurst = 0;
      return;
    }
    if (!t.isAimedAt(t.aimPoint, 0.03)) return;

    // burst discipline: nobody holds the trigger down until the belt is gone
    if (this.streamBurst > 0) {
      this.streamBurst -= dt;
    } else {
      this.streamRest -= dt;
      if (this.streamRest > 0) return;
      this.streamBurst = rand(0.45, 1.1);
      this.streamRest = rand(0.5, 1.5);
    }

    if (typeof hook === 'function') {
      hook.call(this.battle, t, t.aimPoint);
      return;
    }
    const bullets = this.battle.bullets;
    if (!bullets) return;
    let fired = 0;
    while (t.streamTimer <= 0 && t.streamAmmo > 0 && fired < 8) {
      t.streamTimer += 1 / wpn.rof;
      t.streamAmmo--;
      const pos = t.muzzleWorld(tmpA);
      pos.y -= 0.12;
      const dir = t.gunDirection(tmpB);
      bullets.fire(pos, dir, wpn.speed, wpn.dmg, t, wpn.spread);
      fired++;
    }
    if (fired > 0) {
      const fx = this.battle.effects;
      if (fx && fx.mgFlash) fx.mgFlash(t.muzzleWorld(tmpA), t.gunDirection(tmpB));
      if (this.soundCd <= 0) {
        this.soundCd = 0.12;
        if (sfx3d && sfx3d.mg) sfx3d.mg(t.muzzleWorld(tmpA));
      }
    }
  }

  // ---------------------------------------------------------------------
  // driving
  // ---------------------------------------------------------------------
  // Point the hull at `point` and go. `reverse` backs toward it instead, which
  // is how a tank leaves a fight without showing anybody its rear plate.
  driveToward(point, reverse = false, power = 1) {
    const t = this.tank;
    // A goal past the edge of the playable square is a hull pressed against
    // the clamp in tankEntity forever. Pull it inside; every caller passes one
    // of this AI's own vectors, so the arrival checks see the same point.
    const lim = Math.max(0, (t.bound || 420) - EDGE_MARGIN);
    if (point.x > lim) point.x = lim;
    else if (point.x < -lim) point.x = -lim;
    if (point.z > lim) point.z = lim;
    else if (point.z < -lim) point.z = -lim;
    const dx = point.x - t.position.x;
    const dz = point.z - t.position.z;
    const dist = Math.hypot(dx, dz);
    let desired = Math.atan2(dx, dz);
    if (reverse) desired = wrapAngle(desired + Math.PI);
    // A grade the engine cannot pull is not climbed, it is worked around.
    if (t.stalled) desired = wrapAngle(desired + this.orbitDir * 0.85);
    // and a house is driven round, not into
    else if (!reverse) desired = this.avoidWalls(desired, dist);
    const dYaw = wrapAngle(desired - t.yaw);
    // loose going needs more lock for the same turn
    t.steerInput = clamp((dYaw * 2.2) / Math.max(0.5, this.grip), -1, 1);
    const drive = reverse ? -1 : 1;
    t.throttleInput = Math.abs(dYaw) < 1.1 ? drive * power : drive * 0.25;
    return dist;
  }

  // `desired`, or the nearest heading either side of it whose strip ahead is
  // clear of buildings and rocks (see AVOID_STEPS).
  avoidWalls(desired, dist) {
    const t = this.tank;
    const now = this.battle && typeof this.battle.time === 'number' ? this.battle.time : 0;
    if (now >= this.avoidAt && now - this.avoidAt < AVOID_HOLD) return wrapAngle(desired + this.avoidOffset);
    this.avoidAt = now;
    this.avoidOffset = 0;
    const look = Math.min(dist, AVOID_LOOK_MAX, AVOID_LOOK + Math.abs(t.speed || 0) * AVOID_LOOK_V);
    if (look < 1 || !headingBlocked(t, desired, look)) {
      // the side that worked is remembered a while after the way clears, so
      // a crew working round a house keeps going round the same way
      if (now - this.avoidSideAt > 2) this.avoidSide = 0;
      return desired;
    }
    const first = this.avoidSide || this.orbitDir || 1;
    for (let i = 0; i < AVOID_STEPS.length; i++) {
      for (let k = 0; k < 2; k++) {
        const s = k ? -first : first;
        const yaw = wrapAngle(desired + s * AVOID_STEPS[i]);
        if (!headingBlocked(t, yaw, look)) {
          this.avoidSide = s;
          this.avoidSideAt = now;
          this.avoidOffset = s * AVOID_STEPS[i];
          return yaw;
        }
      }
    }
    return desired;
  }

  // Stop, and sit at an angle to whoever is shooting. Sloped armour is worth
  // real thickness now, so the hull is turned off square while the gun is out
  // of action anyway and squared away again in the last of the reload, when
  // moving would only throw the shot.
  // Returns true while it is holding the vehicle still, false once its budget
  // is spent — at which point the caller MUST do something else. Nothing in
  // this file is allowed to park a tank without a deadline.
  angleHull(dt, facing, dist) {
    const t = this.tank;
    this.angleHold += dt;
    if (this.angleHold > ANGLE_HOLD_MAX) {
      this.angleHold = ANGLE_HOLD_MAX;
      return false;
    }
    t.throttleInput = 0;
    t.steerInput = 0;
    if (!facing || !facing.alive || !t.canDrive) return true;
    const bearing = Math.atan2(
      facing.position.x - t.position.x,
      facing.position.z - t.position.z,
    );
    // A casemate has no turret worth the name: its hull IS the mounting, so it
    // points at what it is shooting and takes what angle it can get away with.
    const cap = t.spec.turretYawLimit;
    const off = cap != null ? clamp(cap * 0.6, 0, 0.12) : 0.55;
    const want = wrapAngle(bearing + this.orbitDir * off);
    const e = wrapAngle(want - t.yaw);
    if (Math.abs(e) < 0.12) return true;
    // settle for the shot rather than shuffle through it
    if (cap == null && t.reload < 0.9) return true;
    t.steerInput = clamp(e * 2.0, -1, 1);
    // clutch-and-brake steering needs the tracks turning before anything
    // happens; a regenerative box will spin the hull standing still
    if (!t.spec.neutralSteer) t.throttleInput = dist > 90 ? 0.5 : -0.5;
    return true;
  }

  // The posture budget is gone and the target is still there. Take a different
  // firing position rather than becoming scenery: it un-parks the vehicle, it
  // spoils the other man's solution, and it is what a real crew would do.
  repositionFire(dt, target, dist) {
    const t = this.tank;
    const a =
      Math.atan2(
        t.position.x - target.position.x,
        t.position.z - target.position.z,
      ) + this.orbitDir * 0.55;
    const r = clamp(dist, 80, this.preferredRange() * 1.15);
    this.moveGoal.set(
      target.position.x + Math.sin(a) * r,
      0,
      target.position.z + Math.cos(a) * r,
    );
    this.leash(this.moveGoal);
    this.driveToward(this.moveGoal, false, 0.85);
  }

  // Back out of a fight this vehicle cannot win, keeping the thick end pointed
  // at the man who is winning it, and finish behind something solid.
  retreat(dt, threat) {
    const t = this.tank;
    if (this.coverTimer <= 0) {
      this.coverTimer = 1.8;
      this.findCover(threat);
    }
    const bearing = Math.atan2(
      threat.position.x - t.position.x,
      threat.position.z - t.position.z,
    );
    const off = wrapAngle(bearing - t.yaw);
    const near = t.position.distanceTo(threat.position);
    if (this.threatSeen && near < 260 && Math.abs(off) < 1.3) {
      // he is in front and looking: reverse, glacis toward him
      t.steerInput = clamp(off * 2.0, -1, 1);
      t.throttleInput = -1;
      return;
    }
    this.driveToward(this.coverPoint, false, 1);
  }

  // Somewhere within a short drive that the threat cannot see into.
  findCover(threat) {
    const t = this.tank;
    const eye = tmpA.copy(threat.position);
    eye.y += 2.2;
    const base = Math.atan2(
      t.position.x - threat.position.x,
      t.position.z - threat.position.z,
    );
    const bound = Math.max(0, (t.bound || 420) - EDGE_MARGIN);
    let picked = false;
    for (let i = 0; i < 8; i++) {
      const a = base + (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * 0.5;
      const r = 55 + (i % 3) * 22;
      const x = clamp(t.position.x + Math.sin(a) * r, -bound, bound);
      const z = clamp(t.position.z + Math.cos(a) * r, -bound, bound);
      if (!picked) {
        this.coverPoint.set(x, 0, z);
        picked = true;
      }
      tmpB.set(x, terrainHeight(x, z) + 1.7, z);
      if (!hasLOS(eye, tmpB)) {
        this.coverPoint.set(x, 0, z);
        return;
      }
    }
  }

  // The range this vehicle would rather fight at.
  preferredRange() {
    if (!this.canPen) return 90;      // closer is the only thing that helps
    if (this.isCasemate) return 260;  // a casemate is a sniper by construction
    if (this.isLight) return 130;
    return this.isHeavy ? 150 : 200;
  }

  // Stopping is not free, so it is done when the shot is nearly ready: an
  // unsettled sight cannot make the range, and the sight takes a couple of
  // seconds to come back down after the tracks stop.
  wantStop(target, dist) {
    const t = this.tank;
    if (!this.losTarget) return false;
    if (!t.modules.breech.ok || t.ammo[t.shellType] <= 0) return false;
    if (dist < 70 && !this.isCasemate) return false; // brawling: keep moving
    const settle = 2.2 + (1 - this.grip) * 1.5;
    return t.reload <= settle;
  }

  fight(dt, target, dist) {
    const t = this.tank;
    const facing = this.threat && this.threat.alive ? this.threat : target;

    if (this.stopHold < 11 && this.wantStop(target, dist)) {
      this.stopHold += dt;
      // angleHull refuses once its own ceiling is reached; then this falls
      // through to the movement below rather than standing there
      if (this.angleHull(dt, facing, dist)) return;
    }
    // a gun that cannot settle — a bent barrel, a target it cannot beat — is a
    // gun that should be looking for a better position instead of a better shot
    if (this.stopHold > 0) this.stopHold = Math.max(0, this.stopHold - dt * 1.2);

    const brawl = this.isHeavy ? 60 : this.isCasemate ? 120 : 45;
    if (dist < brawl) {
      // Backing off a point you are in the middle of taking is how the point is
      // lost. Give ground inside the ring instead of leaving it.
      if (this.holdZone) this.repositionFire(dt, target, dist);
      else this.retreat(dt, target);
      return;
    }

    // Light tanks never stand still, and nobody who cannot get through the
    // front stays in front of it.
    if (this.isLight || !this.canPen) {
      const a =
        Math.atan2(
          t.position.x - target.position.x,
          t.position.z - target.position.z,
        ) + this.orbitDir * 0.8;
      const r = this.isLight ? 130 : clamp(dist, 90, 180);
      this.moveGoal.set(
        target.position.x + Math.sin(a) * r,
        0,
        target.position.z + Math.cos(a) * r,
      );
      this.leash(this.moveGoal);
      this.driveToward(this.moveGoal, false, 1);
      return;
    }

    const want = this.preferredRange();
    if (dist > want * 1.2) {
      this.moveGoal.set(target.position.x, 0, target.position.z);
      this.leash(this.moveGoal);
      this.driveToward(this.moveGoal, false, 1);
      return;
    }

    // This is the branch that used to park a bot for the rest of the match:
    // angleHull zeroes throttle and steer and nothing here had a deadline on
    // it, so any target sitting between the brawl radius and the preferred
    // range froze the vehicle permanently. It has a budget now, and when the
    // budget is gone the crew go and find a better position.
    this.postureHold += dt;
    if (this.postureHold < POSTURE_HOLD_MAX && this.angleHull(dt, facing, dist)) return;
    this.repositionFire(dt, target, dist);
  }

  updateDrive(dt, target, dist, pinned) {
    const t = this.tank;

    // A dead driver is a parked tank, and so is a shed track.
    if (!t.canDrive || !seatStaffed(t, 'driver') || !t.modules.tracks.ok || pinned) {
      t.throttleInput = 0;
      t.steerInput = 0;
      return;
    }
    if (this.reverseTimer > 0) {
      t.steerInput = this.orbitDir * 0.7;
      t.throttleInput = -1;
      return;
    }

    // An SPAA working an aeroplane stands still: the quad cannot track anything
    // that fast off a hull that is bouncing over the country.
    if (this.isSPAA && this.airTarget && this.airTarget.alive) {
      t.throttleInput = 0;
      t.steerInput = 0;
      return;
    }

    const threat = this.threat && this.threat.alive ? this.threat : null;
    const gunOut =
      !t.modules.breech.ok || !t.modules.barrel.ok || !t.modules.traverse.ok;
    const crippled = gunOut || t.crew <= 2 || (t.burning && t.consumables.fpe <= 0);
    if (crippled && threat) {
      this.retreat(dt, threat);
      return;
    }

    // The old test was `target && dist < ENGAGE_RANGE`, and with points two to
    // three hundred metres apart and six hundred and fifty metres of sight
    // there was almost always such a target — so the objective branch below
    // was, in practice, unreachable. The objective gets to win now.
    if (target && dist < ENGAGE_RANGE && !this.shouldPressObjective(target, dist)) {
      this.fight(dt, target, dist);
      return;
    }

    this.driveObjective(dt);
  }

  // The objective loop. Re-elects on the timer, on arrival, and — the part the
  // old code never had — the moment the team plan changes version, which is
  // what an ownership change does.
  driveObjective(dt) {
    const t = this.tank;
    if (this.zoneTimer <= 0 || this.plan.version !== this.planVersion) {
      this.pickWaypoint();
    }

    // horizontal distance. The waypoint sits at y = 0 while the ground runs to
    // about +/-20 m, so the old three-dimensional compare could never fire on
    // the flank points: |dy| alone beat the threshold.
    const d = horizDist(t.position, this.waypoint);
    const arrive = this.objective ? Math.max(10, this.objective.r * 0.45) : 16;

    if (d < arrive) {
      // On the point. Standing on it is the job — but on a clock, so the bot
      // re-scores the whole map every few seconds and leaves the moment
      // something else is worth more.
      if (this.holdTimer <= 0) {
        this.holdTimer = rand(5, 9);
        this.pickWaypoint(true);
        // the re-election may have sent us somewhere else entirely
        this.driveToward(this.waypoint, false, this.atObjective ? 0.7 : 1);
        return;
      }
      if (d < 3) {
        t.throttleInput = 0;
        t.steerInput = 0;
        return;
      }
      this.driveToward(this.waypoint, false, 0.5);
      return;
    }

    this.driveToward(this.waypoint, false, this.atObjective ? 0.7 : 1);
  }

  // The watchdog under everything else. Whatever the branches above decided, a
  // tank that has not moved for nine seconds with no excuse for it gets its
  // hold budgets confiscated, a fresh plan, and a few seconds during which the
  // objective outranks any duel.
  updateStall(dt, pinned) {
    const t = this.tank;
    if (Math.abs(t.speed) > 0.6) {
      this.angleHold = Math.max(0, this.angleHold - dt * 1.5);
      this.postureHold = Math.max(0, this.postureHold - dt * 1.4);
    }
    const excused =
      pinned || t.repairing || !t.canDrive || !t.modules.tracks.ok ||
      this.reverseTimer > 0 ||
      (this.isSPAA && this.airTarget && this.airTarget.alive) ||
      // sitting on a capture point is not a lock-up, it is the objective
      (this.atObjective && !!this.objective);
    if (!excused && Math.abs(t.speed) < 0.5) {
      this.idleAccum += dt;
      if (this.idleAccum > STALL_LIMIT) {
        this.idleAccum = 0;
        this.stopHold = 12;
        this.angleHold = ANGLE_HOLD_MAX;
        this.postureHold = POSTURE_HOLD_MAX;
        this.pushTimer = rand(4.5, 7);
        this.pickWaypoint(true);
      }
    } else {
      this.idleAccum = Math.max(0, this.idleAccum - dt * 1.5);
    }
  }

  // Hung up on a boulder, a fence or another tank: back off and try the other
  // way round rather than grinding at it forever.
  updateStuck(dt) {
    const t = this.tank;
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      return;
    }
    // (0.2, not 0.3: driveToward turns hard at a quarter throttle, and a hull
    // whose nose is against a wall cannot get the way on to turn — most
    // tanks steer by their tracks' speed — so that is being stuck as well)
    if (
      Math.abs(t.throttleInput) > 0.2 &&
      Math.abs(t.speed) < 0.6 &&
      t.canDrive &&
      t.modules.tracks.ok &&
      !t.stalled
    ) {
      this.stuckAccum += dt;
      if (this.stuckAccum > 2.4) {
        this.stuckAccum = 0;
        this.reverseTimer = 1.5;
        this.orbitDir = -this.orbitDir;
        // and once backed off, round the other side of whatever stopped it
        if (this.avoidSide) {
          this.avoidSide = -this.avoidSide;
          this.avoidSideAt = this.battle && typeof this.battle.time === 'number' ? this.battle.time + 1.5 : 0;
        }
        this.avoidAt = -1e9;
      }
    } else {
      this.stuckAccum = Math.max(0, this.stuckAccum - dt);
    }
  }

  // Can the crew still see their target through whatever smoke is on the
  // line? Re-asked a few times a second (it is two integrals over the live
  // screens), and at once whenever the target changes. Returns true while he
  // is blind to us. Coming back out of the smoke costs a fresh reaction time:
  // nobody re-lays on a reappearing hull in the same instant.
  updateSight(dt, target) {
    this.sightCd -= dt;
    if (this.sightOf !== target) {
      this.sightOf = target;
      this.smokeBlind = false;
      this.blindFor = 0;
      this.smokeVeil = 0;
      this.sightCd = 0;
    }
    if (this.sightCd <= 0) {
      this.sightCd = 0.15;
      const smoke = this.battle.effects;
      const eye = this.eyePos(tmpC);
      this.centreOf(target, tmpD);
      const blind = smokeBlinds(smoke, eye, tmpD);
      this.smokeVeil = blind ? 1 : smokeVeil(smoke, eye, tmpD);
      if (!blind && this.smokeBlind) {
        this.reactionTimer = Math.max(this.reactionTimer, rand(0.35, 0.7));
        this.errTimer = 0;
      }
      this.smokeBlind = blind;
    }
    if (this.smokeBlind) {
      this.blindFor += dt;
      this.losTarget = false;
      return true;
    }
    this.blindFor = 0;
    return false;
  }

  update(dt) {
    const t = this.tank;
    if (!t.alive) return;

    this.retargetTimer -= dt;
    if (this.reactionTimer > 0) this.reactionTimer -= dt;
    if (this.aidCd > 0) this.aidCd -= dt;
    if (this.smokeCd > 0) this.smokeCd -= dt;
    if (this.shellCd > 0) this.shellCd -= dt;
    if (this.coverTimer > 0) this.coverTimer -= dt;
    if (this.zoneTimer > 0) this.zoneTimer -= dt;
    if (this.holdTimer > 0) this.holdTimer -= dt;
    if (this.pushTimer > 0) this.pushTimer -= dt;

    if (this.retargetTimer <= 0) {
      this.retargetTimer = rand(0.5, 0.85);
      this.acquire();
    }

    const pinned = this.updateDamageControl(dt);
    let target = this.target && this.target.alive ? this.target : null;
    // A target that drives into smoke is gone from the crew's eyes between two
    // acquire() sweeps too: from here on neither the gun nor the hull follows
    // him — the gun stays on the spot he vanished into, the hull goes back to
    // its objective — and after SMOKE_MEMORY he is given up altogether.
    if (target && this.updateSight(dt, target)) {
      if (this.blindFor > SMOKE_MEMORY) {
        this.target = null;
        this.smokeBlind = false;
        this.sightOf = null;
      }
      target = null;
    }
    const dist = target ? t.position.distanceTo(target.position) : Infinity;

    this.refreshObjective();
    this.updateStall(dt, pinned);
    this.updateStuck(dt);
    this.updateGun(dt, target, dist);
    this.updateStream(dt);
    this.updateDrive(dt, target, dist, pinned);
  }
}
