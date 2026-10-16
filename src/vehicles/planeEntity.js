import * as THREE from 'three';
import {
  buildPlaneMesh,
  buildPlaneParts,
  tracePlaneParts,
  randomPlanePart,
  planeAero,
  airDensity,
  planeGearGeometry,
  gearLimits,
  displaySpeedKmh,
  PART_LABELS,
  RHO0,
  GRAV,
} from './planes.js';
// The solid ground: terrain, plus any airfield standing on it. Everything in
// this file that asks "where is the ground" asks this, never terrainHeight().
import { groundSurfaceAt, airfieldObstacleAt } from '../world/airfield.js';
import { disposeOwned } from '../core/materials.js';
import { clamp, moveToward, wrapAngle } from '../core/utils.js';

const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpQ2 = new THREE.Quaternion();
const tmpTo = new THREE.Vector3();
const tmpLocal = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
// flight-model scratch — this runs for every aircraft every frame, so nothing
// in here is allowed to allocate
const tmpVb = new THREE.Vector3();
const tmpVh = new THREE.Vector3();
const tmpLift = new THREE.Vector3();
const tmpSide = new THREE.Vector3();
const tmpForce = new THREE.Vector3();
const tmpPt = new THREE.Vector3();
const tmpHitDir = new THREE.Vector3();
const tmpMat = new THREE.Matrix4();
// the structural limiter runs inside the physics substep AND can be called by
// the battle before it, so it gets scratch of its own rather than borrowing
const tmpLimUp = new THREE.Vector3();
const tmpLimV = new THREE.Vector3();
// Ordnance bookkeeping runs off the hot path (a store leaves a pylon a handful
// of times a sortie), but it can be reached from inside applyDamage via
// ripWing, so it does not borrow the damage model's scratch.
const tmpStoreMat = new THREE.Matrix4();
const tmpStorePt = new THREE.Vector3();
// Ground contact runs inside the physics substep for every aircraft near the
// ground, so it has its own scratch and allocates nothing either: the body
// axes in world space, and two surface records (here, and a step ahead).
const tmpBx = new THREE.Vector3();
const tmpBy = new THREE.Vector3();
const tmpBz = new THREE.Vector3();
const tmpCp = new THREE.Vector3();
const SURF_A = { y: 0, kind: 'terrain', af: null };
const SURF_B = { y: 0, kind: 'terrain', af: null };
const tmpGroundE = new THREE.Euler(0, 0, 0, 'YXZ');

// True when `root` is somewhere up `obj`'s parent chain. Used to find out
// whether a store is already hung on the wing it belongs to, in which case
// three.js hides it along with the wing for free.
function isDescendantOf(obj, root) {
  if (!obj || !root) return false;
  for (let p = obj.parent; p; p = p.parent) if (p === root) return true;
  return false;
}

// The two kinds of store a pylon can carry, and the names the rest of the
// codebase uses for each. releaseStore() takes either spelling.
const STORE_KINDS = ['bomb', 'rocket'];

// Flap stages: 0 up, 1 combat, 2 takeoff, 3 landing. Combat flap is nearly
// free lift, landing flap is a barn door — that trade is the whole point of
// having a lever instead of a switch.
const FLAP_CL = [0, 0.18, 0.42, 0.65];
const FLAP_CD = [0, 0.006, 0.022, 0.055];
const FLAP_CLMAX = [0, 0.12, 0.3, 0.45];
// Drag of a fully extended undercarriage. It is spent in proportion to how far
// the legs actually are out (see gearPos), so a gear caught halfway through a
// cycle costs half of it rather than all or nothing.
const GEAR_CD = 0.021;
// Seconds for one full cycle, up-and-locked to down-and-locked. No spec carries
// a gear time today, so this is ONE constant for every type — spec.gearTime is
// honoured if a spec ever grows one. Six seconds sits in the middle of the WWII
// fighter band: a Spitfire's hydraulics take the best part of eight, a 109's
// closer to four, and none of them are quick.
const GEAR_CYCLE = 6;
// Spawning this close above the terrain means a strip start, not an air start,
// and the legs want to be down and locked before the first frame is drawn.
const GEAR_GROUND_SNAP = 6;

// ---------------------------------------------------------------------------
// Undercarriage limits
// ---------------------------------------------------------------------------
// The handbook figures are per type (spec.gearLimit, km/h INDICATED, sourced in
// planes.js) and reach this file through gearLimits() as this game's indicated
// m/s. The rules are the handbook's, made playable:
//   - the lever can be put down at any speed, but above VLO the legs stay in
//     their wells and the pilot is told the limit; they start down by
//     themselves the moment the aeroplane is slow enough. (The old model tore
//     the doors off the frame the lever moved above a fixed speed, which on a
//     P-51 cruising at 0.8 throttle was every time it was ever tried.)
//   - legs out above VLE by more than GEAR_WARN_OVER is a spoken warning;
//   - more than GEAR_FAIL_OVER over, held for about GEAR_FAIL_TIME seconds,
//     tears them off. Raising the gear is allowed at any speed.
// "Over" is the LOAD on the legs (gearLoadRatio): the airstream pushes on the
// part of them still out, so a gear half-way up carries half the load of one
// fully down. A retracting gear is not warned about unless it is actually
// being strained — the lever is already where the warning would ask for it.
const GEAR_WARN_OVER = 1.1;
const GEAR_FAIL_OVER = 1.25;
const GEAR_FAIL_TIME = 2;
const GEAR_STRAIN_RECOVER = 0.5; // strain bled off per second back under the line
const GEAR_WARN_EVERY = 2;
// Flaps: spec.flapRip is the INDICATED airspeed each stage leaves the
// aeroplane at (planes.js flapRipOf: the handbook's landing-flap figure on the
// dial's scale; dynamic pressure is what loads a flap, as it does the gear).
// Within this fraction of it the pilot is warned (every GEAR_WARN_EVERY s),
// and selecting a stage already past it says so at once.
const FLAP_WARN = 0.9;
// Engine hit points an oil leak of 1 eats per second (updateSystems). Exported
// because the AI reads the same number to tell how long an engine has left
// (ai/planeAI.js engineLife): the two must never disagree.
export const OIL_ENGINE_WEAR = 0.35;

// ---------------------------------------------------------------------------
// Ground contact
// ---------------------------------------------------------------------------
// Sink rate is what an undercarriage is designed against, and the figures are
// the real ones: wartime fighters were stressed for roughly 3-3.7 m/s (10-12
// ft/s) at the landing weight. Below SINK_FIRM the oleos absorb it and the
// aeroplane stays down; between that and SINK_FAIL they throw a share of it
// back (a bounce); past SINK_FAIL the legs fold; past SINK_CRASH nothing is
// left to slide on. These are not scaled with the game's compressed airspeeds:
// gravity and the masses here are real, so the energy the legs absorb is too.
const SINK_FIRM = 2.4;
const SINK_FAIL = 3.8;
const SINK_CRASH = 6;
const BOUNCE_RETURN = 0.3; // fraction of the sink rate the oleos hand back
// "Sink" is the speed INTO the surface, along its normal — not the vertical
// speed. On level ground the two are the same; on a hillside or the face of
// the embankment, ground rising to meet a level aeroplane is exactly as hard
// as the aeroplane coming down onto flat ground at that rate. The slope is
// sampled this far either side of the aeroplane (m).
const CLOSURE_SAMPLE = 1;
// Weight that has only just come onto the wheels stays there this long
// before the wing may take it off again (s). The oleos are still compressed;
// without it a wheel landing right at the lift-off threshold, where the
// ground model's lift and the flight model's differ by a hair, can hand the
// aeroplane back and forth between them every step.
const LIFTOFF_HOLD = 0.3;
// Rolling friction and the most braking a WWII drum brake and tyre will give
// before the tail comes over (a taildragger nose-overs somewhere near half a
// g). Concrete, the mown field, the embankment's graded earth and the open
// hillside, in that order of roughness. The brakes act on the weight the
// wheels actually carry, so right after touchdown, with the wing still
// lifting, they are weak — which is what makes touching down slow matter.
const ROLL_MU = { concrete: 0.025, grass: 0.06, berm: 0.07, terrain: 0.09 };
const BRAKE_MU = { concrete: 0.45, grass: 0.32, berm: 0.3, terrain: 0.28 };
const BELLY_MU = 0.5; // a fuselage sliding on its radiator
// A slope steeper than this at speed digs a wheel in and turns the aeroplane
// over. The graded embankment is allowed more than the open hillside.
const ROUGH_SLOPE = { concrete: 0.6, grass: 0.6, berm: 0.55, terrain: 0.32 };
const ROUGH_SPEED = 11;
// How fast the tail comes up on a takeoff run or settles on the roll-out, rad/s.
const TAIL_RATE = 0.3;
// Arcade's ground crew hold the brakes on for you whenever the throttle is
// closed on the ground; realistic leaves it to the B key.
const AUTO_BRAKE = 1;
// Below this the aeroplane is stopped, and stays stopped on a slope it could
// not hold on its brakes alone only if the engine says so.
const STOP_SPEED = 0.05;
// Into a hangar, a wall or a parked aeroplane faster than a brisk walk is a
// wreck; slower, it is a bent spinner and an embarrassed pilot.
const OBSTACLE_CRASH_SPEED = 5;

// Pilot limits. Blackout starts one tenth of a G above the instructor's
// ceiling, which is what guarantees mouse flying never greys its own screen
// out: everything below G_INSTRUCTOR is free, everything above is earned by
// pulling the stick yourself.
const G_BLACKOUT = 5;
const G_REDOUT = -1.8;
const G_INSTRUCTOR = 4.9;

// Static stability, in radians per second of nose movement per radian of
// misalignment at reference dynamic pressure. Low enough that the stick still
// owns the aeroplane, high enough that it flies straight hands-off.
const STAB_PITCH = 2.2;
// The fin is stiff on purpose: full rudder should buy ten or fifteen degrees
// of sideslip, not fly the aeroplane sideways. Weak yaw stiffness turns the
// rudder into a free second elevator and makes every turn a skid.
const STAB_YAW = 4.5;
const ROLL_ASYM = 2.4;

// ---------------------------------------------------------------------------
// Structural limits
// ---------------------------------------------------------------------------
// G_INSTRUCTOR above is a COMFORT ceiling: sustainG() spends a little over half
// the available lift so the aeroplane keeps its energy, and it is deliberately
// well under what the spar is rated for. The numbers below are the separate,
// higher STRUCTURAL ceiling — what the airframe can actually take — and they
// are what clampPitchCommand() flies to. Holding the pilot to the comfort limit
// would be safe and would also throw away two G the aeroplane owns.
//
// The limiter aims at MARGIN of the rated load and updateStructure() does not
// start spending the airframe's budget until DEADBAND of it, so there is a
// double gap: the limiter has room to overshoot slightly on a snatch and still
// cost nothing.
const G_STRUCT_MARGIN = 0.9; // arcade limiter target, as a fraction of spec.maxG
// Realistic aims the limiter at the rated load itself rather than at a safety
// margin under it, so a hard pull sits right on the number the book gives and
// an abrupt one punches through into the deadband — which is what makes the
// warning mean something.
const G_STRUCT_MARGIN_REAL = 1.02;
const G_STRUCT_LEAD = 0.17; // seconds of lookahead the limiter predicts over
const G_NEG_FRACTION = 0.45; // negative-G ceiling, as a fraction of spec.maxG
const G_NEG_FLOOR = 2.4; // ...but never tighter than this
// Realistic keeps a pilot who can override the limiter, and the override is the
// interesting part: the assist is nearly total the moment the stick reaches the
// stop, then GIVES WAY the longer the pilot hauls against it. A snatch is
// caught and costs nothing; a deliberate, sustained over-pull is not, and the
// wing eventually goes. Arcade never gives way at all.
const REALISTIC_ASSIST = 0.85; // assist authority the instant the limiter bites
const REALISTIC_ASSIST_MIN = 0; // ...and nothing at all once they have insisted
const REALISTIC_GIVE = 0.7; // seconds of holding it there before they win
const REALISTIC_RELAX = 2.5; // and how much faster than that it comes back
// ...but "their way" is bounded by what a pilot's arm can do to the elevator.
// Stick force grows with dynamic pressure, so at the speeds an aeroplane
// actually fights at (up to its level top speed) hauling past the stop buys
// the rated load and no more: full-back or full-forward on the keys stalls,
// buffets or greys the pilot out, it does not fold the wing. Only past the
// level top speed — a dive — can a determined pull carry the load beyond the
// rating, growing to REALISTIC_OVER_G x rated at the critical speed, which
// is what spends the structural budget and eventually takes the wing.
const REALISTIC_OVER_G = 1.3;

// How far past the rated numbers is free. A rated limit is where the safety
// factor begins, not where the metal parts company, so a few per cent over
// costs nothing and only what is beyond the deadband spends the budget.
const G_DEADBAND = 1.04;
const V_DEADBAND = 1.05;
const G_STRESS_RATE = 6.5; // budget per second per unit of over-G past the band
const V_STRESS_RATE = 2.2; // ...and per unit of overspeed
const STRESS_RECOVER = 1.5; // budget refunded per second once back inside
const STRESS_WARN_EVERY = 1.4; // seconds between spoken warnings while over

const TEMP_TAU = 9; // seconds for engine temperature to chase its target
const MAX_STEP = 1 / 50; // physics substep: a frame hitch must not blow up lift
// How far out the battle area reaches horizontally, in metres from the centre.
const MAP_EDGE = 1200;

let nextId = 1000;

// Flight model: the aircraft carries a real velocity vector and the nose is
// only where it is pointing, not where it is going. Stick inputs in
// controls {roll, pitch, yaw} ∈ [-1..1] command body rotation rates exactly as
// they used to — that part of the feel is unchanged — but the trajectory now
// comes from lift, drag, thrust and gravity acting on this.vel. The gap
// between the two is the angle of attack, and every interesting thing an
// aeroplane does (stalling, spinning, blacking out, energy fighting, mushing
// through a turn it cannot hold) falls out of that one gap.
//
// Sign conventions (body frame, +Z nose, +Y canopy, +X left wing):
//   roll  +1 → rotZ+ → left wing UP  → roll RIGHT   (D key)
//   pitch +1 → rotX+ → nose DOWN                     (W key, as requested)
//   yaw   +1 → rotY+ → nose LEFT                     (Q key)
// state: 'alive' -> 'falling' (shot down, tumbling) -> 'dead'
export class Plane {
  constructor(scene, spec, team, displayName, isPlayer = false, difficulty = 'arcade') {
    this.id = nextId++;
    this.scene = scene;
    this.spec = spec;
    this.team = team;
    this.displayName = displayName;
    this.isPlayer = isPlayer;

    const built = buildPlaneMesh(
      spec,
      isPlayer ? 0x8a9464 : null,
      team === 0 ? 0x4f8fd0 : 0xd05f4f,
    );
    this.group = built.group;
    this.muzzles = built.muzzles;
    this.hitBox = built.hitBox;
    this.props = built.props;
    this.partMeshes = built.partMeshes || {};
    // The undercarriage. The rig is what knows the per-type facts — which way
    // each leg folds (inboard, outboard, or rearward), how far it rakes out,
    // and that a type whose wheels deliberately protrude must not be hidden
    // when it is up — so the animation goes through it rather than
    // reimplementing any of that here. A build that predates the gear has
    // neither rig nor group, hence the hunt and the nulls: everything that
    // touches them checks first.
    this._gearRig = built.rig || (this.group.userData && this.group.userData.rig) || null;
    this._gearGroup =
      this.partMeshes.gear ||
      (this.group.getObjectByName ? this.group.getObjectByName('gear') : null) ||
      null;
    // The stores hanging under the wings. This has to happen before the
    // ammunition counters are set below, because those are accessors now and
    // their setter reconciles what is on the pylons. A fresh aeroplane is
    // always built with a full rack visible — every respawn allocates a new
    // Plane, so there is no stale state to inherit.
    this._initStores(built.stores);
    this.isAircraft = true;
    scene.add(this.group);

    this.quat = new THREE.Quaternion();
    this.dir = new THREE.Vector3(0, 0, 1); // cached world forward (read-only)
    this.controls = { roll: 0, pitch: 0, yaw: 0 };
    this.speed = spec.maxSpeed * 0.7;
    this.throttle = 0.8;
    this.fallSpin = 1;

    // ---- flight model state ----
    this.aero = planeAero(spec);
    this.vel = new THREE.Vector3(0, 0, this.speed);
    this.aoa = 0; // angle of attack, rad (nose above the flight path)
    this.slip = 0; // sideslip, rad
    this.gLoad = 1;
    this.blackout = 0; // 0..1 grey-out from sustained positive G
    this.redout = 0; // 0..1 from sustained negative G
    this.stalled = false;
    this.spinning = false;
    this.spinEnergy = 0;
    this.spinDir = 1;
    this.stress = 0; // structural fatigue budget; 1 tears something off
    this.overStress = false; // true while that budget is actually being spent
    this.stressWarn = 0; // countdown between spoken overload warnings
    this.ripped = null; // 'leftWing' | 'rightWing' once a wing has left
    this.vStall = spec.stallSpeed;
    // elevator the aeroplane actually flew this step, after the structural
    // limiter — controls.pitch stays the raw pilot command
    this.pitchCmd = 0;
    this.gLimited = false; // true while the limiter is holding the stick back
    this.overrideHold = 0; // realistic only: how long the pilot has fought it
    this.difficulty = 'arcade';
    this.setDifficulty(difficulty);

    // ---- engine and airframe management ----
    this.wep = false;
    this.wepLock = false; // true while the engine is too hot to take WEP again
    this.engineTemp = 0.3;
    this.radiator = 0.5;
    this.oilLeak = 0;
    this.smoking = false;
    this.overheatWarn = 0;
    this.fuel = spec.fuelCapacity;
    this.fuelLeak = 0;
    this.flaps = 0;
    // The undercarriage is a mechanism, not a switch, and it takes two numbers
    // to say so:
    //   gear    — where the PILOT put the lever. Boolean, because that is what
    //             the HUD flag, the AI and the airfield's approach gate read,
    //             and they all pre-date this. Only the lever writes it.
    //   gearPos — where the legs actually ARE: 0 up and locked, 1 down and
    //             locked, anything between is mid-cycle. Drag, the mesh and the
    //             tear-off check all follow this one.
    // Default is an air start (up); setPose() corrects it for a strip start.
    this.gear = false;
    this.gearPos = 0;
    // Torn off by overspeed or folded by a heavy landing. Terminal: there is
    // nothing left to lower, so the lever stops working and the cycle stops.
    this.gearGone = false;
    this._gearApplied = -1; // last position pushed at the mesh; -1 forces one
    // The type's handbook limits, in this game's indicated m/s (planes.js).
    this.gearLim = gearLimits(spec);
    // Lever down, legs held in the wells because the aeroplane is too fast.
    this.gearHeld = false;
    this.gearStrain = 0; // 0..1 toward tearing the legs off by overspeed
    this.gearWarnCd = 0;
    this.flapWarnCd = 0; // seconds to the next flap-overspeed warning
    this.ias = this.speed; // indicated airspeed, refreshed every update
    this.airbrake = false;

    // ---- on the ground ----
    // Where the tyres, tailwheel, belly, propeller and wingtips are, from the
    // same layout the mesh is built from (planes.js planeGearGeometry).
    this.gearGeo = planeGearGeometry(spec);
    this.contactReach = Math.max(spec.span * 0.5, spec.len * 0.5, this.gearGeo.propR) + 1.5;
    this._onGround = false; // the ground model's flag; .onGround is the accessor
    this.groundYaw = 0;
    this.groundPitch = 0; // nose-up attitude on the wheels, rad
    this.groundSlopePitch = 0; // the surface's own slope under the aeroplane
    this.groundSlopeRoll = 0;
    this.groundKind = 'terrain';
    this.groundRudder = 0; // -1..1, written by airfield.js for the player
    this.wheelBrake = 0; // 0..1 actually applied this step (for the HUD)
    // A belly slide or a collapsed landing: still moving, never flying again.
    this.wrecked = false;
    this.wreckedOnGround = false; // came to rest as a write-off, not a fireball
    this._airTime = 10; // seconds since the wheels last left the ground
    this._wheelTime = 10; // seconds since the wheels last came down (LIFTOFF_HOLD)
    // the wheels left the ground over a crest rather than by lifting off (a
    // hop: coming down again a moment later is a settle, not a landing)
    this._groundHop = false;
    this._closureUphill = false; // last contact's closure was mostly the slope
    this._gradX = 0; // ground gradient where the last contact was made
    this._gradZ = 0;
    this._cpH = 0; // deepest point of the current contact check (_clearance)
    this._cpX = 0;
    this._cpZ = 0;
    this._wheelVy = 0; // ground model: the wheels' vertical speed following the surface
    // where checkContact() last sampled the surface (see its cheap reject)
    this._surfX = Infinity;
    this._surfZ = Infinity;
    this._surfY = 0;
    // What the last contact with the ground was, for airfield.js to present:
    // kind 'touchdown' | 'bounce' | 'liftoff' | 'collapse' | 'belly' | 'crash'.
    // seq counts up on every report so a reader can tell new from seen.
    this.lastContact = { kind: '', sink: 0, speed: 0, surface: '', af: null, seq: 0, reason: '' };

    this.hp = spec.hp;
    this.state = 'alive';
    this.pilotOut = false;
    this.burning = false;
    this.burnTimer = 0;
    this.fire = { engine: false, fuel: false, wing: false };
    this.extinguishers = 1;
    this.eventQueue = [];

    this.resetParts();

    this.firing = false;
    this.gunTimer = 0;
    this.gunSound = 0;
    this.ammo = spec.gun.ammo;
    this.bombs = spec.bombs ? spec.bombs.count : 0;
    this.rockets = spec.rockets ? spec.rockets.count : 0;
    this.muzzleFlip = 0;
    this.convergence = spec.convergence || 300;

    this.lastAttacker = null;
    this.lastHitAge = 99;
    this.justExploded = false;
    this.killCredited = false;
    this.radius = spec.span / 2 + 2;

    this._status = {};
    this._limits = { pull: 1, push: 1, floor: 0 };
    // reused argument for the rig's control-surface pose, so the per-frame
    // visual sync allocates nothing
    this._surfPose = { roll: 0, pitch: 0, yaw: 0, flaps: 0 };
    this.vel.set(0, 0, 1).applyQuaternion(this.quat).multiplyScalar(this.speed);
  }

  get position() {
    return this.group.position;
  }

  get alive() {
    return this.state === 'alive';
  }

  get yaw() {
    return Math.atan2(this.dir.x, this.dir.z);
  }

  // True while the aeroplane is on its wheels (or its belly) and update() is
  // running the ground model instead of the flight model. The ground-contact
  // code below sets it; the setter is kept for older callers that write it
  // directly (initPlaneAirfieldState writes false on a fresh aeroplane), and
  // routes a direct `true` through settleOnGround() so the aeroplane is put on
  // its wheels properly rather than left hanging where it was.
  get onGround() {
    return this._onGround;
  }

  set onGround(v) {
    const on = !!v;
    if (on === this._onGround) return;
    if (on) this.settleOnGround();
    else this._onGround = false;
  }

  // Kept as derived flags so hud.setPlaneStatus and the battle files read the
  // component model without knowing it exists. The setters are there because
  // "engineOk = false" used to be a legal thing to do to a plane.
  get engineOk() {
    return this.partOk('engine');
  }

  set engineOk(v) {
    if (!v) this.parts.engine.hp = Math.min(this.parts.engine.hp, 0);
    else this.parts.engine.hp = Math.max(this.parts.engine.hp, this.parts.engine.max);
  }

  get wingsOk() {
    return !this.ripped && this.partOk('leftWing') && this.partOk('rightWing');
  }

  set wingsOk(v) {
    if (!v) {
      this.parts.leftWing.hp = Math.min(this.parts.leftWing.hp, 0);
    } else {
      this.parts.leftWing.hp = Math.max(this.parts.leftWing.hp, this.parts.leftWing.max);
      this.parts.rightWing.hp = Math.max(this.parts.rightWing.hp, this.parts.rightWing.max);
    }
  }

  resetParts() {
    const layout = buildPlaneParts(this.spec);
    this.partLayout = layout;
    this.parts = {};
    for (const key of Object.keys(layout.hp)) {
      this.parts[key] = {
        key,
        label: PART_LABELS[key] || key,
        hp: layout.hp[key],
        max: layout.hp[key],
      };
    }
  }

  partOk(key) {
    const p = this.parts[key];
    return p ? p.hp > 0 : true;
  }

  partFrac(key) {
    const p = this.parts[key];
    return p ? clamp(p.hp / p.max, 0, 1) : 1;
  }

  // Control-surface effectiveness: full when intact, `broken` once it is shot
  // away, and sagging in between — a chewed-up aileron is slow, not dead.
  surfaceHealth(key, broken) {
    const p = this.parts[key];
    if (!p) return 1;
    if (p.hp <= 0) return broken;
    return broken + (1 - broken) * clamp(p.hp / p.max, 0, 1);
  }

  // How much lift one wing panel can still carry. A holed wing keeps flying;
  // a wing that has actually left the aeroplane does not.
  wingLift(key) {
    if (this.ripped === key) return 0;
    return 0.45 + 0.55 * this.partFrac(key);
  }

  currentMass() {
    return this.spec.mass - (this.spec.fuelCapacity - this.fuel);
  }

  // 0..1 of rated thrust. A holed engine still pulls, badly; a destroyed one or
  // a dry tank pulls nothing at all.
  engineHealth() {
    if (this.fuel <= 0) return 0;
    const p = this.parts.engine;
    if (!p) return 1;
    if (p.hp <= 0) return 0;
    const f = p.hp / p.max;
    return f > 0.55 ? 1 : 0.35 + (0.65 * f) / 0.55;
  }

  stallAoA() {
    return (this.aero.clMax + FLAP_CLMAX[this.flaps]) / this.aero.clAlpha;
  }

  stallSpeedNow() {
    const ae = this.aero;
    const clm =
      (ae.clMax + FLAP_CLMAX[this.flaps]) *
      Math.max(0.3, (this.wingLift('leftWing') + this.wingLift('rightWing')) * 0.5);
    const rho = airDensity(this.position.y);
    return Math.sqrt((2 * this.currentMass() * GRAV) / (rho * ae.wingArea * clm));
  }

  // Unpowered flight, for the AI's dead-stick approach (ai/planeAI.js): the
  // glide slope as a tangent (drag over lift) at true airspeed `v` with the
  // given flap stage, gear travel and airbrake, at the lift that holds the
  // present weight up in this air — the same drag terms update() charges, so
  // the plan and the flight agree. Parasitic part first (cdp), then the
  // induced part at that lift coefficient.
  _glideParasite(flaps, gearPos, airbrake) {
    const ls = Math.max(0.3, (this.wingLift('leftWing') + this.wingLift('rightWing')) * 0.5);
    let cdp = this.aero.cd0 + FLAP_CD[clamp(Math.round(flaps), 0, 3)] + this.radiator * 0.0045;
    if (gearPos > 0 && !this.gearGone) cdp += GEAR_CD * gearPos;
    if (airbrake) cdp += this.spec.airbrakeCd || 0;
    if (this.ripped) cdp += 0.05;
    cdp += (1 - ls) * 0.05 + this.oilLeak * 0.004;
    return { cdp, ls };
  }

  // A running engine at idle still pulls (thrustNow's 5% floor): that is
  // taken off, so an idling approach is planned as flat as it really flies.
  glideTan(v = this.speed, flaps = this.flaps, gearPos = this.gearPos, airbrake = this.airbrake) {
    const ae = this.aero;
    const { cdp, ls } = this._glideParasite(flaps, gearPos, airbrake);
    const vv = Math.max(v, 1);
    const qs = 0.5 * airDensity(this.position.y) * vv * vv * ae.wingArea;
    const w = this.currentMass() * GRAV;
    const cl = w / (qs * ls);
    const idle = (ae.thrustStatic * 0.05 * this.engineHealth()) / (1 + vv / ae.propKnee);
    return (cdp + ae.k * cl * cl) / (cl * ls) - idle / w;
  }

  // The best-glide speed for a configuration (true m/s; where the induced and
  // parasitic drag are equal), never closer than 1.25 x its stall, and the
  // slope it glides at there.
  bestGlide(flaps = 0, gearPos = 0, airbrake = false) {
    const ae = this.aero;
    const { cdp, ls } = this._glideParasite(flaps, gearPos, airbrake);
    const rho = airDensity(this.position.y);
    const clStar = Math.sqrt(cdp / ae.k);
    let v = Math.sqrt((2 * this.currentMass() * GRAV) / (rho * ae.wingArea * ls * clStar));
    const vs = this.stallSpeedAt(flaps);
    v = Math.max(v, vs * 1.25);
    return { v, tan: this.glideTan(v, flaps, gearPos, airbrake), vs };
  }

  // The glide slope (height lost per metre flown, unpowered) at true airspeed
  // `v` holding `n` g — a turn at bank B holds 1/cos B — from the same drag
  // terms update() charges: parasitic over the 1-g lift coefficient, plus the
  // induced part, which grows with n squared. No idle thrust: this is the
  // number a glide is PLANNED with, as if the engine had already stopped.
  glideTanN(v = this.speed, n = 1, flaps = 0, gearPos = 0, airbrake = false) {
    const ae = this.aero;
    const { cdp, ls } = this._glideParasite(flaps, gearPos, airbrake);
    const vv = Math.max(v, 1);
    const qs = 0.5 * airDensity(this.position.y) * vv * vv * ae.wingArea;
    const w = this.currentMass() * GRAV;
    const cl = (n * w) / (qs * ls);
    // drag over weight: the height a metre of flight costs at constant speed
    return ((cdp + ae.k * cl * cl) * qs) / w;
  }

  // The stick that brings the angle of attack to `aoaC` in about `tau`
  // seconds, from the rate model clampPitchCommand() predicts with (the
  // elevator's pitch rate, the weathercock term toward the trim angle and the
  // flight path's own rotation): an autopilot's pitch channel, for the AI's
  // glide pilot (ai/planeAI.js dsPilot). The structural limiter still has
  // the last word in flyStep.
  pitchCmdForAoa(aoaC, tau = 0.3) {
    const ae = this.aero;
    const authority = this.spec.pitchRate * this.pitchAuthority();
    if (!(authority > 1e-4)) return 0;
    const q = 0.5 * airDensity(this.position.y) * this.speed * this.speed;
    const qs = q * ae.wingArea;
    const aCrit = this.stallAoA();
    const trim = clamp((ae.weight / Math.max(qs, 1) - FLAP_CL[this.flaps]) / ae.clAlpha, -aCrit, aCrit);
    const stab = (this.aoa - trim) * STAB_PITCH * Math.min(1.5, q / ae.qRef);
    return clamp((-(aoaC - this.aoa) / Math.max(tau, 0.05) - this.pathRate() - stab) / authority, -1, 1);
  }

  // stallSpeedNow() with flap stage `flaps` selected instead of the present one
  stallSpeedAt(flaps) {
    const now = this.stallSpeedNow();
    const ae = this.aero;
    const f = clamp(Math.round(flaps), 0, 3);
    return now * Math.sqrt((ae.clMax + FLAP_CLMAX[this.flaps]) / (ae.clMax + FLAP_CLMAX[f]));
  }

  // Compressibility. Near the structural limit the controls go heavy and then
  // almost solid — the reason a dive that starts as a good idea ends as a hole
  // in the ground. Returns the surviving fraction of control authority.
  compressibility() {
    const vne = this.spec.structuralSpeed;
    const onset = vne * 0.75;
    if (this.speed <= onset) return 1;
    const t = (this.speed - onset) / (vne - onset);
    return Math.max(0.22, 1 - t * t * 1.15);
  }

  setPose(x, y, z, yawAngle) {
    this.position.set(x, y, z);
    this.quat.setFromEuler(tmpE.set(0, yawAngle, 0));
    this.syncFromQuat();
    // enter the world already trimmed: velocity along the horizon, nose lifted
    // by the angle of attack that holds the aeroplane up at this speed
    this.vel.copy(this.dir).multiplyScalar(this.speed);
    const q = 0.5 * airDensity(y) * this.speed * this.speed * this.aero.wingArea;
    const trim = clamp(this.aero.weight / Math.max(q, 1) / this.aero.clAlpha, 0, this.stallAoA());
    this.rotateBody(-trim, 0, 0);
    this.syncFromQuat();
    this.aoa = trim;
    this.gLoad = 1;
    // Enter the world with the undercarriage matching the situation rather than
    // always one way and then cycling: a strip start (already flagged onGround,
    // or simply put down on the deck) begins down and locked, an air start
    // begins up. Snapped, not cycled — nobody watches their own spawn retract.
    const ground = groundSurfaceAt(x, z, SURF_A).y;
    this.setGear(this.onGround || y - ground < GEAR_GROUND_SNAP, true);
    this.ias = this.speed * Math.sqrt(airDensity(y) / RHO0);
    this._airTime = 10;
    this._surfX = Infinity; // a teleport invalidates the surface cache
  }

  syncFromQuat() {
    this.quat.normalize();
    this.group.quaternion.copy(this.quat);
    this.dir.set(0, 0, 1).applyQuaternion(this.quat);
  }

  forward(out) {
    return out.copy(this.dir);
  }

  nextMuzzle(out) {
    const m = this.muzzles[this.muzzleFlip];
    this.muzzleFlip = (this.muzzleFlip + 1) % this.muzzles.length;
    m.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(m.matrixWorld);
  }

  // Direction from a wing muzzle to the convergence point ahead of the nose.
  // Wing guns are harmonised to cross at a set range; firing them straight
  // ahead is why parallel tracers never seem to hit anything.
  aimFromMuzzle(muzzlePos, out) {
    out.copy(this.position).addScaledVector(this.dir, this.convergence).sub(muzzlePos);
    const len = out.length();
    return len > 1e-4 ? out.multiplyScalar(1 / len) : out.copy(this.dir);
  }

  rotateBody(rx, ry, rz) {
    tmpQ.setFromEuler(tmpE.set(rx, ry, rz));
    this.quat.multiply(tmpQ); // post-multiply = rotation about body axes
  }

  // Which rulebook the airframe is flown under. Arcade's instructor owns the
  // structural limit outright — you cannot fold the aeroplane up by pulling —
  // while realistic warns, resists, and then lets the pilot have their way.
  // Anything that is not the string 'realistic' is arcade, so an unset or
  // unknown difficulty lands on the forgiving side.
  setDifficulty(mode) {
    this.difficulty = mode === 'realistic' ? 'realistic' : 'arcade';
    return this.difficulty;
  }

  getDifficulty() {
    return this.difficulty;
  }

  get arcade() {
    return this.difficulty !== 'realistic';
  }

  // ---- pilot-facing switches -------------------------------------------
  setFlaps(stage) {
    this.flaps = clamp(Math.round(stage), 0, 3);
  }

  // The pilot's flap lever (the AI works setFlaps directly). A stage selected
  // above its limit still goes out — and is torn off at once — so the limit
  // is quoted the moment the lever moves, on the airspeed tape's scale.
  cycleFlaps() {
    this.setFlaps((this.flaps + 1) % 4);
    if (this.flaps > 0 && !this.onGround && this.ias > this.spec.flapRip[this.flaps - 1]) {
      this.pushEvent(`Too fast for the flaps — limit ${this.flapLimitKmh()} km/h`);
    }
  }

  // The limit of flap stage `stage` (default: the one selected) as the
  // airspeed tape reads it: the rip speed is an indicated airspeed, so it is
  // the same figure at every height, through planes.js displaySpeedKmh like
  // every other figure on the dial.
  flapLimitKmh(stage = this.flaps) {
    const s = clamp(Math.round(stage), 1, 3);
    const rip = this.spec.flapRip ? this.spec.flapRip[s - 1] : 0;
    return Math.round(displaySpeedKmh(rip));
  }

  // Seconds for a full cycle. Per-type if a spec ever carries gearTime; one
  // shared constant until one does.
  gearCycleTime() {
    const t = this.spec.gearTime;
    return t > 0 ? t : GEAR_CYCLE;
  }

  // Move the lever. `instant` puts the legs there this frame instead of running
  // the cycle, which is what a spawn and a touchdown want and nothing else.
  // Returns the lever position that actually took, which is not always the one
  // asked for. A gear that has been torn off does not come back.
  setGear(down, instant = false) {
    if (this.gearGone) return false;
    this.gear = !!down;
    if (instant) {
      this.gearPos = this.gear ? 1 : 0;
      this._applyGearVisual(this.gearPos);
    }
    return this.gear;
  }

  toggleGear() {
    if (this.gearGone) {
      this.pushEvent('Undercarriage gone');
      return false;
    }
    // Weight on the wheels: the uplocks are not going to take the aeroplane's
    // weight, so the lever does nothing until it is flying. That is also what
    // keeps this in step with the airfield — land, and the gear stays down
    // through the roll-out and the rearm whatever the player leans on.
    if (this.onGround && this.gear) return this.gear;
    const down = this.setGear(!this.gear);
    // Lever down above the operating limit: the lever takes, the legs wait.
    // Say so at once, in the units the airspeed tape reads, or the pilot is
    // left wondering why nothing happened.
    if (down && !this.onGround && this.ias > this.gearLim.vlo) {
      this.gearHeld = true;
      this.pushEvent(`Too fast for the gear — it comes down below ${this.gearLimitKmh()} km/h`);
    }
    return down;
  }

  // The gear operating limit as the HUD's airspeed tape shows it (indicated,
  // km/h on the player's dial: planes.js displaySpeedKmh, the one scale every
  // readout and every spoken limit uses).
  gearLimitKmh() {
    return Math.round(displaySpeedKmh(this.gearLim.vlo));
  }

  // Indicated airspeed and the indicated stall, in the same display km/h the
  // tape prints — for anything that shows them without going through the
  // battle's HUD feed.
  iasKmh() {
    return displaySpeedKmh(this.ias);
  }

  // How hard the airstream is pushing on the undercarriage, as a multiple of
  // what it is built for: 1 is legs fully out at exactly VLE. The load on legs
  // and doors is dynamic pressure on the part of them still out in the air —
  // the same share the drag model already charges (GEAR_CD * gearPos) — so as
  // a speed ratio it is (IAS / VLE) * sqrt(gearPos). A gear folding away is
  // shedding its load as fast as it goes, which is why a prompt gear-up on a
  // full-power climb-out is safe although the aeroplane passes VLE before the
  // six-second cycle is through: on this world's compressed speed scale the
  // band from liftoff to VLE is crossed in about a third of the time the real
  // aeroplane took, and the hydraulics are as slow as they ever were.
  gearLoadRatio() {
    if (this.gearGone || this.gearPos <= 0) return 0;
    return (this.ias / this.gearLim.vle) * Math.sqrt(this.gearPos);
  }

  // A repaired aeroplane starts its gear budget from scratch.
  resetGearStrain() {
    this.gearStrain = 0;
    this.gearWarnCd = 0;
  }

  // The legs run toward wherever the lever is at a fixed rate. Nothing in here
  // writes `gear` — that is the pilot's — and nothing in here throws on a build
  // whose aeroplanes have no undercarriage in them.
  //
  // Extension waits for the operating limit: above VLO the legs are held in
  // the wells (gearHeld) and start down by themselves once the aeroplane has
  // slowed. A cycle already under way when the speed climbs back over the
  // limit stops where it is. Retraction is never held — folding the legs away
  // is what an overspeeding pilot ought to be doing.
  updateGear(dt) {
    if (this.gearGone) {
      this.gearHeld = false;
      return;
    }
    const target = this.gear ? 1 : 0;
    if (this.gearPos !== target) {
      const extending = target > this.gearPos;
      const held = extending && !this._onGround && this.ias > this.gearLim.vlo;
      if (this.gearHeld && !held && extending) this.pushEvent('Gear coming down');
      this.gearHeld = held;
      if (!held) {
        const step = Math.max(0, dt) / Math.max(0.05, this.gearCycleTime());
        const next = clamp(moveToward(this.gearPos, target, step), 0, 1);
        // Land ON the end stop. Stepping by dt/cycle accumulates enough float
        // error to leave a sliver of a millionth behind instead of zero, and a
        // sliver is not "fully retracted": the group would be hidden for a
        // frame while the state still said the legs were out.
        this.gearPos = Math.abs(next - target) < 1e-6 ? target : next;
      }
    } else {
      this.gearHeld = false;
    }
    if (this.gearPos !== this._gearApplied) this._applyGearVisual(this.gearPos);
  }

  // The undercarriage has gone: torn off by the airflow or folded by the
  // runway. Nothing is left to lower, and the legs are no longer drawn.
  loseGear(msg) {
    if (this.gearGone) return;
    this.gearGone = true;
    this.gear = false;
    this.gearPos = 0;
    this.gearHeld = false;
    this.gearStrain = 0;
    this._applyGearVisual(0);
    if (msg) this.pushEvent(msg);
  }

  // Push a position at the mesh. The rig is the good path: it owns the fold
  // direction, the rake and the rule that the group is only hidden once the
  // legs are fully up — which is the whole reason the gear does not pop out of
  // existence halfway through a cycle. The branch below it is for a build that
  // has parts but no rig, and the nulls are for one that has neither.
  _applyGearVisual(t) {
    this._gearApplied = t;
    const rig = this._gearRig;
    if (rig && typeof rig.setGear === 'function') {
      // setGear leaves rig.gearT holding this value, so anything that later
      // drives the rig directly carries on from where the aeroplane really is
      // instead of jumping.
      rig.setGear(t);
    } else {
      const pm = this.partMeshes || {};
      for (const leg of [pm.gearMainL, pm.gearMainR]) {
        if (!leg || !leg.rotation) continue;
        const ud = leg.userData || {};
        const swing = (ud.retractAngle != null ? ud.retractAngle : 0) * (1 - t);
        const rake = (ud.rake || 0) * t;
        if (ud.retractAxis === 'x') {
          leg.rotation.x = swing;
          leg.rotation.z = rake;
        } else {
          leg.rotation.z = swing + rake;
          leg.rotation.x = 0;
        }
      }
      // A fixed tailwheel hangs outside the retracting group and must not move.
      const tail = pm.gearTail;
      if (tail && tail.rotation && this._gearGroup && tail.parent === this._gearGroup) {
        tail.rotation.x = -1.35 * (1 - t);
      }
      if (this._gearGroup) {
        const always = !!(this._gearGroup.userData && this._gearGroup.userData.alwaysVisible);
        this._gearGroup.visible = always || t > 0.002;
      }
    }
    // Torn off is not the same as retracted: once the legs have gone they stay
    // gone, including on a type whose wheels are meant to show when up.
    if (this.gearGone && this._gearGroup) this._gearGroup.visible = false;
  }

  setAirbrake(on) {
    this.airbrake = !!on;
  }

  setRadiator(v) {
    this.radiator = clamp(v, 0, 1);
  }

  adjustRadiator(delta) {
    this.setRadiator(this.radiator + delta);
  }

  setWep(on) {
    if (on && (this.wepLock || !this.partOk('engine'))) return;
    this.wep = !!on;
  }

  toggleWep() {
    this.setWep(!this.wep);
  }

  // One bottle, one fire. Using it on an engine fire that is about to be a fuel
  // fire is the decision, and there is no second chance.
  useExtinguisher() {
    if (this.extinguishers <= 0 || !this.burning) return false;
    this.extinguishers--;
    this.fire.engine = false;
    this.fire.fuel = false;
    this.fire.wing = false;
    this.burning = false;
    this.burnTimer = 0;
    this.pushEvent('Fire out');
    return true;
  }

  // ---- ordnance: the stores hanging under the wings --------------------
  // planes.js builds the pylons and the store bodies and hands them back on the
  // build result as `built.stores = { bomb: [...], rocket: [...] }`, ordered the
  // way they would really come off — the inboard pair first, then outward. This
  // class owns them at runtime: bombs.js calls releaseStore() every time it
  // actually launches something, the store that was hanging there stops being
  // drawn, and its pylon stays on the wing.
  //
  // The source of truth is the AMMUNITION COUNTER, not a private index.
  // plane.bombs and plane.rockets are accessors (below) and every write to
  // either — a battle spending one, fireRocketSalvo() spending four up front
  // and then walking them off the rails, the airfield putting the whole load
  // back — reconciles the pylons. That is also how the airfield rearm reaches
  // restoreStores() without airfield.js knowing this feature exists: its
  // serviceOnGround() finishes with `plane.bombs = spec.bombs.count`, the
  // setter sees the count go UP, and the rack refills.
  _initStores(raw) {
    const pick = (a, b) => {
      const src = Array.isArray(a) ? a : Array.isArray(b) ? b : null;
      // copy, and keep only real scene nodes — the other half of this contract
      // is being written right now and may not be there at all yet
      return src ? src.filter((o) => o && o.isObject3D) : [];
    };
    const bomb = pick(raw && raw.bomb, raw && raw.bombs);
    const rocket = pick(raw && raw.rocket, raw && raw.rockets);
    // Mirrored under the name the build result uses, so anything that wants to
    // look at the rack (the x-ray view, a hangar preview) can, and sees exactly
    // the arrays this class is indexing into.
    this.stores = { bomb, rocket };
    this._stores = {
      bomb: { list: bomb, fired: 0, hidden: 0, lost: bomb.map(() => false) },
      rocket: { list: rocket, fired: 0, hidden: 0, lost: rocket.map(() => false) },
    };
    // The accessors read these; they must exist before anything sets a count.
    this._bombs = 0;
    this._rockets = 0;
    for (const o of bomb) o.visible = true;
    for (const o of rocket) o.visible = true;
  }

  // 'bomb' | 'bombs' | 'rocket' | 'rockets' -> the internal key, or null.
  _storeKey(kind) {
    if (kind === 'rocket' || kind === 'rockets') return 'rocket';
    if (kind === 'bomb' || kind === 'bombs') return 'bomb';
    return null;
  }

  // Bring the rack into line with the counter. Cheap enough to run on every
  // write — a rack is ten stores at the very most and this never touches the
  // per-frame path.
  _syncStores(key) {
    const s = this._stores && this._stores[key];
    if (!s) return;
    const n = s.list.length;
    if (n === 0) return;
    const have = key === 'bomb' ? this._bombs : this._rockets;
    const left = clamp(Math.floor(Number.isFinite(have) ? have : 0), 0, n);
    // Whichever count says more have gone wins. `fired` is what bombs.js has
    // physically pulled off a pylon; `n - left` is what the ammunition counter
    // has paid for. A rocket salvo spends its rounds up front and lets them go
    // one at a time, so for a fraction of a second the counter leads; a caller
    // that releases a store without spending a round leaves `fired` leading.
    const gone = clamp(Math.max(s.fired, n - left), 0, n);
    s.hidden = gone;
    for (let i = 0; i < n; i++) {
      const vis = i >= gone && !s.lost[i];
      if (s.list[i].visible !== vis) s.list[i].visible = vis;
    }
  }

  // Take the next store off its pylon.
  //
  // Returns a FRESH THREE.Vector3 holding the world position it was hanging at
  // — fresh on purpose, because the caller keeps it as the projectile's own
  // position and a shared scratch would put every bomb in the same place — or
  // null when the rack is empty, which is bombs.js's cue to fall back to the
  // belly of the aircraft.
  releaseStore(kind = 'bomb') {
    const key = this._storeKey(kind);
    const s = key && this._stores ? this._stores[key] : null;
    if (!s) return null;
    const n = s.list.length;
    // step over anything that went with a wing
    while (s.fired < n && s.lost[s.fired]) s.fired++;
    if (s.fired >= n) return null;
    const obj = s.list[s.fired];
    s.fired++;
    let out = null;
    if (obj) {
      // an object that has just been hidden still has a valid world matrix,
      // but ask for it explicitly rather than trusting the render traversal
      obj.updateWorldMatrix(true, false);
      out = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
    }
    this._syncStores(key);
    return out;
  }

  // Put the whole load back on the pylons. The airfield rearm gets here on its
  // own through the counters, so this is for anything that reloads the
  // aircraft without touching them; it tops the counters up to the spec's full
  // load as well, so the rack and the HUD cannot end up disagreeing.
  restoreStores() {
    const spec = this.spec;
    const full = {
      bomb: spec && spec.bombs ? spec.bombs.count : 0,
      rocket: spec && spec.rockets ? spec.rockets.count : 0,
    };
    for (const key of STORE_KINDS) {
      const s = this._stores && this._stores[key];
      if (!s) continue;
      s.fired = 0;
      for (let i = 0; i < s.lost.length; i++) s.lost[i] = false;
      if (key === 'bomb') this._bombs = Math.max(this._bombs, full.bomb);
      else this._rockets = Math.max(this._rockets, full.rocket);
      this._syncStores(key);
    }
  }

  // How many of that kind are still physically hanging there. Not the same
  // question as plane.bombs when the model carries fewer stores than the spec
  // lists, which is why it is asked separately.
  storesLeft(kind = 'bomb') {
    const key = this._storeKey(kind);
    const s = key && this._stores ? this._stores[key] : null;
    if (!s) return 0;
    let n = 0;
    for (let i = s.hidden; i < s.list.length; i++) if (!s.lost[i]) n++;
    return n;
  }

  // A wing that leaves takes whatever was hung on it. If planes.js parented the
  // pylon to partMeshes.leftWing / rightWing this is already true — hiding the
  // wing hides its children — and those are left alone. Anything hung straight
  // off the fuselage group has to be shed by hand, and the side it was on is
  // read off its position in the aeroplane's own frame (+X is the left wing).
  _shedWingStores(wingKey) {
    if (!this._stores) return;
    const wingMesh = this.partMeshes ? this.partMeshes[wingKey] : null;
    const leftSide = wingKey === 'leftWing';
    this.group.updateWorldMatrix(true, true);
    tmpStoreMat.copy(this.group.matrixWorld).invert();
    for (const key of STORE_KINDS) {
      const s = this._stores[key];
      if (!s || s.list.length === 0) continue;
      let shed = false;
      for (let i = 0; i < s.list.length; i++) {
        const obj = s.list[i];
        if (!obj || s.lost[i]) continue;
        if (!isDescendantOf(obj, wingMesh)) {
          // hung off the fuselage group instead: work the side out ourselves
          obj.updateWorldMatrix(true, false);
          tmpStorePt.setFromMatrixPosition(obj.matrixWorld).applyMatrix4(tmpStoreMat);
          if (Math.abs(tmpStorePt.x) < 0.05) continue; // a centreline store stays
          const onLeft = tmpStorePt.x > 0;
          if (onLeft !== leftSide) continue; // the other wing's problem
        }
        s.lost[i] = true;
        shed = true;
      }
      if (shed) this._syncStores(key);
    }
  }

  // The ammunition counters. They were plain fields and they still read and
  // write exactly like plain numbers — `plane.bombs--`, `plane.rockets -= n`,
  // `plane.bombs = spec.bombs.count` all behave as before — but going through
  // an accessor is what lets the pylons follow the count without every caller
  // having to remember they exist.
  get bombs() {
    return this._bombs;
  }

  set bombs(v) {
    this._setStoreCount('bomb', v);
  }

  get rockets() {
    return this._rockets;
  }

  set rockets(v) {
    this._setStoreCount('rocket', v);
  }

  _setStoreCount(key, v) {
    const n = Number.isFinite(v) ? Math.max(0, v) : 0;
    const prev = key === 'bomb' ? this._bombs : this._rockets;
    if (key === 'bomb') this._bombs = n;
    else this._rockets = n;
    const s = this._stores && this._stores[key];
    if (!s) return;
    // A count going UP is a reload — the ground crew, or a battle handing the
    // aeroplane a fresh loadout — so the rack starts again from full.
    if (n > prev) {
      s.fired = 0;
      for (let i = 0; i < s.lost.length; i++) s.lost[i] = false;
    }
    this._syncStores(key);
  }

  pushEvent(msg) {
    if (this.eventQueue.length > 5) this.eventQueue.shift();
    this.eventQueue.push(msg);
  }

  // The battle drains this for the player's own HUD messages; damage the
  // aircraft deals to itself (overheat, ripped flaps, spins) shows up here.
  drainEvents() {
    if (this.eventQueue.length === 0) return null;
    const out = this.eventQueue.slice();
    this.eventQueue.length = 0;
    return out;
  }

  // Bank-and-pull "instructor": sets the stick inputs so the plane flies
  // toward a world-space point. Used by the AI and by the player's mouse
  // steering. Returns the off-nose angle in radians.
  // The virtual stick moves smoothly (rate-limited) and small corrections
  // are handled with rudder/elevator instead of hard banking — this keeps
  // mouse flight from twitching and wobbling.
  steerTowards(point, dt = 1 / 60) {
    tmpTo.subVectors(point, this.position).normalize();
    tmpQ2.copy(this.quat).invert();
    tmpLocal.copy(tmpTo).applyQuaternion(tmpQ2); // body frame: z fwd, y up, x left
    const offAngle = Math.acos(clamp(tmpLocal.z, -1, 1));

    // A departed aeroplane is not steered, it is recovered: unload, opposite
    // rudder, wings neutral. Doing this for the pilot is exactly what an
    // instructor is for, and it is why mouse flyers never see a flat spin.
    if (this.spinning) {
      this.controls.pitch = moveToward(this.controls.pitch, 0.45, 6 * dt);
      this.controls.yaw = moveToward(this.controls.yaw, -this.spinDir, 6 * dt);
      this.controls.roll = moveToward(this.controls.roll, 0, 6 * dt);
      return offAngle;
    }

    const rollErr = Math.atan2(tmpLocal.x, tmpLocal.y);
    // bank into the turn almost immediately — even small corrections roll
    // the wings toward the target, then the elevator pulls the nose around
    const rollWeight = clamp((offAngle - 0.015) / 0.22, 0, 1);
    let roll = clamp(-rollErr * 1.6, -1, 1) * rollWeight;
    let pitch = clamp(-Math.atan2(tmpLocal.y, Math.abs(tmpLocal.z)) * 2.6, -1, 1);
    if (tmpLocal.z < 0) pitch = -1; // target behind: full pull
    // Rudder: coordination first, fine aim second. The old model let the
    // rudder haul the nose anywhere for nothing; a skidding aeroplane now pays
    // for it in speed, so the instructor keeps the ball centred and leaves the
    // big changes of direction to the wings. Small corrections — the ones the
    // rudder is actually for — still get almost all of it.
    const fineAim = clamp(Math.atan2(tmpLocal.x, tmpLocal.z) * 1.2, -1, 1) * (1 - rollWeight * 0.75);
    const yaw = clamp(this.slip * 4 + fineAim, -1, 1);
    // level the wings once the target is (almost) dead ahead
    if (rollWeight < 1) {
      tmpUp.copy(UP).applyQuaternion(tmpQ2);
      const bankErr = Math.atan2(tmpUp.x, tmpUp.y);
      roll += clamp(-bankErr * 0.9, -1, 1) * (1 - rollWeight);
    }

    // Gravity does not care where the nose is pointing. Bank buys turn rate by
    // tipping the lift vector on its side, and what is left standing up —
    // L·cos(bank) — is the only thing holding the aeroplane off the ground.
    // Past arccos(1/g) there is none of it left and the turn is a spiral dive,
    // however level the horizon looks through the gunsight.
    //
    // So the guard is a ceiling on BANK ANGLE, not a veto on rolling: the
    // aeroplane still rolls toward wherever it is being pointed, it just stops
    // short of the wingtip, and the ceiling closes further as the flight path
    // falls behind the one being asked for. It is keyed to the aeroplane's own
    // velocity rather than to the target's elevation, because a mouse-flown
    // break turn holds the reticle on the horizon the whole way into the
    // ground — the target says nothing at all about whether we are sinking.
    tmpUp.copy(UP).applyQuaternion(tmpQ2);
    // Bank is only a meaningful quantity while the aeroplane is upright and its
    // nose is somewhere near the horizon. Inverted or pointed at the zenith it
    // is a loop, a split-S or a barrel roll — deliberate, with the lift aimed at
    // the ground on purpose — and atan2 against a vanishing horizon reference
    // is noise. Stand down for both.
    if (tmpUp.y > -0.12 && Math.hypot(tmpUp.x, tmpUp.y) > 0.35) {
      const bank = Math.atan2(tmpUp.x, tmpUp.y);
      const maxBank = Math.acos(clamp(1 / this.sustainG(), 0.05, 1));
      // The steer point tells us the flight path being ASKED for; vel tells us
      // the one being flown. Only the shortfall matters, and a demand to climb
      // harder than about 15 deg is the energy budget's problem, not the
      // guard's — capping it is what lets a climbing turn stay a turn.
      const want = Math.min(tmpTo.y, 0.25);
      const sink = clamp(want - this.vel.y / Math.max(this.speed, 1), 0, 0.7);
      const limit = Math.max(0.35, maxBank - sink * 8);
      const over = Math.abs(bank) - limit;
      if (over > 0) {
        // proportional, and never total: a capped turn is still a turn, which
        // is the whole difference between an instructor and a veto
        const w = Math.min(0.85, over / 0.15);
        roll = roll * (1 - w) + clamp(-bank * 1.2, -1, 1) * w;
        // and while it is over the ceiling and going down, the lift that the
        // roll is recovering is wanted for the vertical, not for the dive
        if (pitch > 0 && sink > 0) pitch *= 1 - w * 0.6;
      }
    }

    // Roll first, then pull. Hauling back before the lift vector is pointing
    // where the turn has to go throws the aeroplane at the sky instead of
    // around the corner, and in an energy model that altitude is bought with
    // speed you do not get back. Corrections that need almost no bank are
    // untouched, so aiming still feels the way it always did.
    const aligned = 1 - clamp(Math.abs(rollErr) / 1.2, 0, 1) * rollWeight;
    if (pitch < 0) pitch *= 0.08 + 0.92 * aligned;

    // Soft limits. In normal flight there is angle of attack and G to spare, so
    // these sit wide open and the stick is untouched — the aeroplane answers
    // the mouse exactly as it always has. They only bite at the edge, which is
    // where the difference between an instructor and no instructor lives.
    const lim = this.commandLimits();
    if (pitch < 0) pitch = Math.max(pitch, -lim.pull);
    else pitch = Math.min(pitch, lim.push);
    if (lim.floor > 0 && pitch < lim.floor) pitch = lim.floor;

    this.controls.roll = moveToward(this.controls.roll, clamp(roll, -1, 1), 10 * dt);
    this.controls.pitch = moveToward(this.controls.pitch, pitch, 10 * dt);
    this.controls.yaw = moveToward(this.controls.yaw, yaw, 10 * dt);
    return offAngle;
  }

  // The G the instructor is prepared to hold onto. The wing can only ever pull
  // (V/Vstall)² G, and asking for all of it buries the aeroplane in induced
  // drag until it is mushing along at the stall doing nothing. Spending a
  // little over half of what is available is roughly the sustainable turn, so
  // the instructor eases off as the speed washes off instead of hanging on the
  // stall — which is exactly why energy is worth having, and why a fast fighter
  // out-turns a slow one here.
  // Both the elevator limiter and the bank ceiling in steerTowards read this,
  // and they have to agree: the ceiling is the bank this much G can hold level.
  sustainG() {
    const vRatio = this.speed / Math.max(this.vStall, 1);
    const sustain = clamp(vRatio * vRatio * 0.85, 1.5, 99);
    return Math.min(this.spec.maxG * 0.8, G_INSTRUCTOR, sustain);
  }

  // How much elevator the instructor is willing to use, as a fraction of full
  // deflection, in each direction. Whichever limit — angle of attack, the
  // pilot, or the energy the aeroplane actually has — is closest wins.
  commandLimits() {
    const aCrit = this.stallAoA();
    const margin = Math.max(0.05, aCrit * 0.34);
    const gLim = this.sustainG();
    const pull = clamp(
      Math.min((aCrit * 0.86 - this.aoa) / margin, (gLim - this.gLoad) / 1.1),
      0,
      1,
    );
    const push = clamp(
      Math.min((aCrit * 0.86 + this.aoa) / margin, (this.gLoad + 1.6) / 1.1),
      0,
      1,
    );
    // Below a safe margin over the stall the instructor stops asking for lift
    // and starts asking for speed. Nothing else gets a mushing aeroplane back:
    // holding the nose up on the wrong side of the drag curve just parks it
    // there until it falls out of the sky.
    const slow = clamp((this.vStall * 1.6 - this.speed) / (this.vStall * 0.45), 0, 1);
    const lim = this._limits || (this._limits = {});
    // a sliver of pull survives so the aeroplane can still hold its nose level
    // near the ground; what it may not do any more is climb or turn hard
    lim.pull = pull * (1 - slow * 0.85);
    lim.push = push;
    // and once it is genuinely at the stall the nose goes down, because the
    // only thing worth having at that point is airspeed
    lim.floor = clamp((this.vStall * 1.02 - this.speed) / (this.vStall * 0.25), 0, 1) * 0.35;
    return lim;
  }

  // ---- structural limiter ----------------------------------------------
  // Everything above this line is the instructor being tidy. Everything below
  // it is the airframe refusing to be torn in half, and unlike commandLimits()
  // it is applied inside flyStep, so the mouse path, the keyboard path and the
  // AI all pass through it no matter what any battle file writes into
  // controls.pitch.

  // What the spar is rated for right now. A shattered panel will not carry
  // anything like the book figure, and updateStructure() derates it the same
  // way, so the limiter and the failure model always agree on the number.
  structuralG() {
    return this.spec.maxG * (this.wingsOk ? 1 : 0.55);
  }

  // The angle of attack that produces exactly `g` at this speed, altitude, flap
  // setting and state of damage. Below corner velocity the answer comes out
  // past the critical angle, which is the wing saying it physically cannot pull
  // that hard here — and that is precisely when the limiter should stand down.
  aoaForG(g) {
    const ae = this.aero;
    const liftScale = Math.max(
      0.05,
      (this.wingLift('leftWing') + this.wingLift('rightWing')) * 0.5,
    );
    const qs =
      0.5 * airDensity(this.position.y) * this.speed * this.speed * ae.wingArea * liftScale;
    if (qs < 1) return g >= 0 ? 9 : -9;
    return ((g * this.currentMass() * GRAV) / qs - FLAP_CL[this.flaps]) / ae.clAlpha;
  }

  // Elevator effectiveness, 0..1. Lifted out of flyStep so the limiter can ask
  // how much aeroplane the stick is actually connected to: a compressed,
  // greyed-out pilot with a chewed elevator commands a fraction of the pitch
  // rate a healthy one does, and a limiter that assumed otherwise would clamp
  // a stick that was never going to hurt anything.
  pitchAuthority() {
    const spec = this.spec;
    const authority = clamp(this.speed / (spec.minSpeed * 1.6), 0.3, 1);
    // greyed out is not yet blacked out: the stick only goes away at the very
    // end of the tunnel
    const grey = 1 - clamp((this.blackout - 0.85) / 0.15, 0, 1) * 0.85;
    const limp = this.pilotOut ? 0 : grey;
    return (
      this.surfaceHealth('elevator', 0.28) *
      (this.partOk('controls') ? 1 : 0.18) *
      limp *
      this.compressibility() *
      authority *
      (this.spinning ? 0.4 : 1)
    );
  }

  // How fast the flight path itself is swinging round, rad/s, in the plane the
  // lift acts in. Angle of attack is the GAP between the nose and the flight
  // path, so a limiter that watched only the nose would be wrong by exactly
  // this much — and at six G it is wrong by half the angle of attack available,
  // which is the difference between holding the rated load and sitting a whole
  // G under it wondering where the turn went.
  pathRate() {
    const v = Math.max(this.speed, 1);
    tmpLimV.copy(this.vel);
    const l = tmpLimV.length();
    if (l > 1e-4) tmpLimV.multiplyScalar(1 / l);
    else tmpLimV.copy(this.dir);
    tmpLimUp.set(0, 1, 0).applyQuaternion(this.quat);
    tmpLimUp.addScaledVector(tmpLimV, -tmpLimUp.dot(tmpLimV));
    if (tmpLimUp.lengthSq() < 1e-8) return 0;
    tmpLimUp.normalize();
    // lift pulls the flight path round; gravity's component in the same plane
    // adds to it or fights it depending on which way up we are
    return (this.gLoad * GRAV - GRAV * tmpLimUp.y) / v;
  }

  // THE structural limiter. Give it a commanded elevator deflection in [-1..1]
  // and it hands back the largest deflection that will not tear the wings off.
  //
  // It is predictive, not reactive: it works out the angle of attack that would
  // produce the ceiling load, then solves the pitch equation for the deflection
  // whose resulting rate of change of angle of attack still lands inside that
  // angle a lead time from now. Reacting to G after the fact is what tore wings
  // off in half a second — by the time the overshoot is measurable the spar has
  // already been asked for it.
  //
  //   d(aoa)/dt = -(stick·authority + static stability) - flight-path rate
  //
  // Solve that for the stick in each direction and the two answers are the
  // envelope. `dt` is only used to keep the lead sane on a long frame; `eff`
  // lets flyStep pass the elevator effectiveness it has already computed.
  clampPitchCommand(cmd, dt = 1 / 60, eff = null) {
    const c = clamp(cmd || 0, -1, 1);
    this.gLimited = false;
    if (this.state !== 'alive' || this.pilotOut) return c;
    const spec = this.spec;
    const ae = this.aero;
    const authority = spec.pitchRate * (eff === null ? this.pitchAuthority() : eff);
    if (!(authority > 1e-4)) return c;

    const arcade = this.arcade;
    const aCrit = this.stallAoA();
    const gTarget = this.structuralG() * (arcade ? G_STRUCT_MARGIN : G_STRUCT_MARGIN_REAL);
    const gNeg = Math.max(G_NEG_FLOOR, this.structuralG() * G_NEG_FRACTION);
    let aHi = this.aoaForG(gTarget);
    let aLo = this.aoaForG(-gNeg);
    if (arcade) {
      // The arcade instructor will not let you depart the aeroplane either, and
      // that ceiling is free: lift peaks AT the critical angle and falls away
      // past it, so refusing to go beyond costs no G and no turn rate at all —
      // it only removes the stall, the spin and the wing that follows them.
      aHi = Math.min(aHi, aCrit * 0.99);
      aLo = Math.max(aLo, -aCrit * 0.99);
    }
    if (aHi < aLo) {
      const mid = (aHi + aLo) * 0.5;
      aHi = mid;
      aLo = mid;
    }

    const q = 0.5 * airDensity(this.position.y) * this.speed * this.speed;
    const qs = q * ae.wingArea;
    const trim = clamp(
      (ae.weight / Math.max(qs, 1) - FLAP_CL[this.flaps]) / ae.clAlpha,
      -aCrit,
      aCrit,
    );
    // the same two terms flyStep adds to the stick, so the prediction is of the
    // aeroplane that is actually about to be integrated
    const stab = (this.aoa - trim) * STAB_PITCH * Math.min(1.5, q / ae.qRef);
    const path = this.pathRate();
    const lead = Math.max(G_STRUCT_LEAD, dt * 2);

    const base = -path - stab;
    const cMin = (-(aHi - this.aoa) / lead + base) / authority;
    const cMax = ((this.aoa - aLo) / lead + base) / authority;

    let out = c;
    if (out < cMin) out = cMin;
    if (out > cMax) out = cMax;
    out = clamp(out, -1, 1);
    // Realistic gives the pilot the last word. The assist still bleeds most of
    // an over-pull away, so a snatch is a warning — and hold it there and the
    // assist gives way entirely. What it gives way TO is the pilot's own
    // ceiling (REALISTIC_OVER_G): the rated load at fighting speeds, more only
    // in a dive past the level top speed, which is where the wing still goes.
    this.gLimited = Math.abs(out - c) > 1e-3;
    if (!arcade) {
      const give = clamp(this.overrideHold / REALISTIC_GIVE, 0, 1);
      const vTop = spec.maxSpeed;
      const dive = clamp(
        (this.speed - vTop) / Math.max(1, (spec.structuralSpeed || vTop * 1.4) - vTop),
        0,
        1,
      );
      const over = 1 + (REALISTIC_OVER_G - 1) * dive;
      let pilot = c;
      if (over > 1 + 1e-6) {
        const pHi = this.aoaForG(gTarget * over);
        const pLo = this.aoaForG(-gNeg * over);
        const pMin = (-(pHi - this.aoa) / lead + base) / authority;
        const pMax = ((this.aoa - pLo) / lead + base) / authority;
        if (pilot < pMin) pilot = pMin;
        if (pilot > pMax) pilot = pMax;
        pilot = clamp(pilot, -1, 1);
      } else {
        pilot = out;
      }
      out = pilot + (out - pilot) * (REALISTIC_ASSIST + (REALISTIC_ASSIST_MIN - REALISTIC_ASSIST) * give);
    }
    return out;
  }

  // Convenience wrapper for the battle input code: route the keyboard through
  // this instead of writing controls.pitch directly and the stick is limited
  // before anything else in the frame reads it.
  //   p.controls.pitch = p.clampPitchCommand(kPitch, dt);   // equivalent
  //   p.applyPilotPitch(kPitch, dt);                        // shorthand
  // Doing so is optional — flyStep applies the same limiter internally — but it
  // keeps controls.pitch honest for anything that reads it mid-frame.
  applyPilotPitch(cmd, dt = 1 / 60) {
    this.controls.pitch = this.clampPitchCommand(cmd, dt);
    return this.controls.pitch;
  }

  // One frame. In the air this is the flight model; on the wheels it is the
  // ground model; the switch between them happens INSIDE the substep loop, at
  // the instant of contact or of lift-off, so a touchdown that falls in the
  // middle of a frame is a touchdown at that instant and the rest of the frame
  // is spent rolling. Battles call this for an aeroplane in either state (the
  // airfield's updateGroundRoll() calls it for one on the ground).
  update(dt) {
    if (this.state === 'dead') return;
    this.lastHitAge += dt;
    const engine = this.engineHealth() > 0;
    this.spinProps(dt, engine);
    // Indicated airspeed for everything that compares against a handbook
    // figure this frame: the gear limits, and the HUD.
    this.ias = this.speed * Math.sqrt(airDensity(this.position.y) / RHO0);
    // Ahead of the falling/dead returns below: an aeroplane shot down on finals
    // goes in with the gear still travelling, because the hydraulics do not
    // care that the pilot has stopped flying.
    this.updateGear(dt);

    this.updateFires(dt);
    if (this.state === 'dead') return;

    if (this.state === 'falling') {
      this.updateFalling(dt);
      this.syncVisual();
      return;
    }

    // A dropped frame must not be allowed to integrate lift explosively, so
    // long steps are walked in pieces.
    let left = dt;
    while (left > 1e-5 && this.state === 'alive') {
      const h = Math.min(left, MAX_STEP);
      if (this._onGround) this.groundStep(h);
      else this.flyStep(h);
      left -= h;
    }
    if (this.state !== 'alive') return;

    this.updateSystems(dt);
    this.updateStructure(dt);
    this.clampBounds();
    if (!this._onGround) this._airTime += dt;
    this.syncVisual();
  }

  // A-01: the propeller turns at its real speed — idle about 280 rpm at the
  // hub, full power about 1,300 (a geared Merlin at 3,000 rpm), windmilling
  // with a dead engine as the airflow drives it — and says so on the prop
  // (userData.rps), which is what lets planes.js hand the blades over to the
  // photographic disc before they could strobe. The angle is kept inside one
  // turn so it never loses precision over a long sortie.
  spinProps(dt, engine) {
    const thr = clamp(Number.isFinite(this.throttle) ? this.throttle : 0, 0, 1);
    let want;
    if (engine) want = PROP_IDLE_RPS + (PROP_MAX_RPS - PROP_IDLE_RPS) * thr ** 0.7;
    else want = this._onGround ? 0 : clamp(this.speed / 60, 0, 1) * PROP_WINDMILL_RPS;
    // An aeroplane that comes into the world already flying (an air start)
    // has its propeller already turning: spooling it up from rest would show
    // a stopped prop — blades AND disc — for its first half-second aloft.
    if (!(this.propRps >= 0)) this.propRps = this._onGround ? 0 : want;
    this.propRps += (want - this.propRps) * (1 - Math.exp(-Math.max(0, dt) / PROP_SPOOL_S));
    const step = this.propRps * Math.PI * 2 * dt;
    for (const pr of this.props) {
      pr.rotation.z = (pr.rotation.z + step) % (Math.PI * 2);
      pr.userData.rps = this.propRps;
      // and where the engine is turning it: the navigation lamps burn only on
      // the airfield (planes.js navLampMaterial, bible V-42)
      pr.userData.onGround = this._onGround === true;
    }
  }

  // X-06 (bible E-31): condensation only where the air makes it. The battles
  // ask these instead of inventing their own gates: a contrail is a 7.5 km
  // phenomenon (never inside today's battle ceiling, kept for later), and
  // wingtip vapour needs |g| >= 5 in humid air — overcast, dawn, snow or rain.
  contrailStrength() {
    return contrailStrength(this);
  }

  wingVapourStrength(preset) {
    return wingVapourStrength(this, preset);
  }

  // The moving parts that are not physics: ailerons, elevator, rudder and flaps
  // follow what the aeroplane is actually doing. The rig was always able to
  // pose them; nothing ever asked it to.
  syncVisual() {
    const rig = this._gearRig;
    if (!rig || typeof rig.setSurfaces !== 'function') return;
    const s = this._surfPose;
    const c = this.controls;
    s.roll = this.state === 'alive' ? c.roll : 0;
    s.pitch = this.state === 'alive' ? this.pitchCmd : 0;
    s.yaw = this.state === 'alive' ? (this._onGround ? this.groundRudder : c.yaw) : 0;
    s.flaps = this.flaps;
    rig.setSurfaces(s);
  }

  // One integration step of the flight model.
  flyStep(dt) {
    const spec = this.spec;
    const ae = this.aero;
    const v = this.speed;
    const rho = airDensity(this.position.y);
    const dRatio = rho / RHO0;
    const q = 0.5 * rho * v * v;
    const qs = q * ae.wingArea;
    const qRatio = Math.min(1.5, q / ae.qRef);
    const mass = this.currentMass();

    // ---- where the air is actually coming from ----
    tmpQ2.copy(this.quat).invert();
    tmpVb.copy(this.vel).applyQuaternion(tmpQ2);
    const axial = Math.abs(tmpVb.z) + 0.6; // keeps the angles sane at a standstill
    this.aoa = Math.atan2(-tmpVb.y, axial);
    this.slip = Math.atan2(tmpVb.x, axial);

    const aCrit = this.stallAoA();
    this.vStall = this.stallSpeedNow();
    const stallDepth = clamp((Math.abs(this.aoa) - aCrit) / (aCrit * 0.8), 0, 1);
    this.stalled = Math.abs(this.aoa) > aCrit || v < this.vStall * 0.92;
    this.updateSpin(dt, stallDepth, v);

    // ---- attitude: rate command from the stick, as it has always been ----
    const rollAuth = clamp(v / (spec.minSpeed * 1.4), 0.35, 1);
    const comp = this.compressibility();
    const ctl = this.partOk('controls') ? 1 : 0.18;
    // greyed out is not yet blacked out: the stick only goes away at the very
    // end of the tunnel
    const grey = 1 - clamp((this.blackout - 0.85) / 0.15, 0, 1) * 0.85;
    const limp = this.pilotOut ? 0 : grey;
    const spinCut = this.spinning ? 0.4 : 1;
    const wingAvg = (this.partFrac('leftWing') + this.partFrac('rightWing')) * 0.5;

    const pitchEff = this.pitchAuthority();
    const rollEff =
      0.5 *
      (this.surfaceHealth('aileronL', 0.18) + this.surfaceHealth('aileronR', 0.18)) *
      (0.55 + 0.45 * wingAvg) *
      (this.ripped ? 0.4 : 1) *
      ctl * limp * comp * rollAuth * spinCut;
    const yawEff = this.surfaceHealth('rudder', 0.2) * ctl * limp * comp * rollAuth * spinCut;

    // THE choke point. Every input path — mouse instructor, held W/S, AI —
    // ends up here, so the structural limit does not depend on any battle file
    // remembering to ask for it. controls.pitch keeps the raw pilot command;
    // pitchCmd is what the elevator actually did.
    this.pitchCmd = this.clampPitchCommand(this.controls.pitch, dt, pitchEff);
    // ...and this is the only place the realistic override clock runs, so a
    // battle that also routes its keyboard through clampPitchCommand cannot
    // wind it on twice in a frame
    this.overrideHold = clamp(
      this.overrideHold + (this.gLimited ? dt : -dt * REALISTIC_RELAX),
      0,
      REALISTIC_GIVE,
    );

    let rx = this.pitchCmd * spec.pitchRate * pitchEff;
    let ry = clamp(this.controls.yaw, -1, 1) * spec.yawRate * yawEff;
    let rz = clamp(this.controls.roll, -1, 1) * spec.rollRate * rollEff;

    // Static stability. The nose weathercocks back onto the relative wind, and
    // it does it against the trim angle of attack rather than against zero, so
    // the aeroplane holds its flight path hands-off the way a trimmed one does.
    const trim = clamp(
      (ae.weight / Math.max(qs, 1) - FLAP_CL[this.flaps]) / ae.clAlpha,
      -aCrit,
      aCrit,
    );
    rx += (this.aoa - trim) * STAB_PITCH * qRatio;
    ry += this.slip * STAB_YAW * qRatio;

    // an unbalanced wing is a rolling moment: shot-up panels drop
    const wl = this.wingLift('leftWing');
    const wr = this.wingLift('rightWing');
    if (wl !== wr) rz += (wl - wr) * ROLL_ASYM * qRatio;

    if (this.spinning) {
      const s = this.spinEnergy;
      rx += 0.55 * s; // the nose stays buried through the rotation
      ry += this.spinDir * 1.5 * s;
      rz -= this.spinDir * 1.9 * s;
    } else if (this.stalled) {
      // the classic stall break: the nose falls through on its own
      rx += (this.aoa < 0 ? -1 : 1) * (0.35 + stallDepth) * 1.1;
    }

    this.rotateBody(rx * dt, ry * dt, rz * dt);
    this.syncFromQuat();

    // ---- lift ----
    let cl = ae.clAlpha * this.aoa + FLAP_CL[this.flaps];
    const over = Math.abs(this.aoa) - aCrit;
    if (over > 0) {
      // past the critical angle the wing gives up, and it does it quickly
      const fall = Math.max(0.34, 1 - over / (aCrit * 0.85));
      cl = (ae.clAlpha * aCrit * (this.aoa < 0 ? -1 : 1) + FLAP_CL[this.flaps]) * fall;
    }
    const liftScale = (wl + wr) * 0.5;
    const lift = qs * cl * liftScale;

    // ---- drag ----
    let cd = ae.cd0 + ae.k * cl * cl + FLAP_CD[this.flaps] + this.radiator * 0.0045;
    // Where the legs ARE, not where the lever is: a cycle that is half done
    // hangs half the drag out, and the penalty comes on and goes off over the
    // same six seconds the wheels take rather than the frame the key is hit.
    if (this.gearPos > 0) cd += GEAR_CD * this.gearPos;
    if (this.airbrake) cd += spec.airbrakeCd;
    if (this.ripped) cd += 0.05;
    cd += (1 - liftScale) * 0.05; // torn skin and hanging panels
    cd += this.oilLeak * 0.004;
    // Compressibility shows up as heavy controls long before it shows up as
    // drag (see compressibility()), so the drag rise here stays modest — it
    // holds a vertical dive to a little over the structural limit rather than
    // conveniently saving the aeroplane from itself.
    const mach = v / spec.structuralSpeed;
    if (mach > 0.82) {
      const e = mach - 0.82;
      cd += e * e * 0.55;
    }
    const drag = qs * cd;

    // sideslip drags the fuselage sideways; the fin's answer to it is the yaw
    // stability term above
    const side = -qs * 0.9 * this.slip;
    const thrust = this.thrustNow(v, dRatio);

    // ---- integrate ----
    if (v > 1e-4) tmpVh.copy(this.vel).multiplyScalar(1 / v);
    else tmpVh.copy(this.dir);
    tmpUp.set(0, 1, 0).applyQuaternion(this.quat);
    tmpSide.set(1, 0, 0).applyQuaternion(this.quat);
    // lift acts square to the relative wind, in the aeroplane's plane of symmetry
    tmpLift.copy(tmpUp).addScaledVector(tmpVh, -tmpUp.dot(tmpVh));
    if (tmpLift.lengthSq() < 1e-6) tmpLift.copy(tmpUp);
    else tmpLift.normalize();

    tmpForce.copy(tmpLift).multiplyScalar(lift);
    tmpForce.addScaledVector(tmpVh, -drag);
    tmpForce.addScaledVector(tmpSide, side);
    tmpForce.addScaledVector(this.dir, thrust);
    tmpForce.y -= mass * GRAV;
    this.vel.addScaledVector(tmpForce, dt / mass);

    this.speed = this.vel.length();
    const cap = spec.structuralSpeed * 1.45;
    if (this.speed > cap) {
      this.vel.multiplyScalar(cap / this.speed);
      this.speed = cap;
    }
    this.position.addScaledVector(this.vel, dt);

    this.gLoad = lift / (mass * GRAV);
    this.updateBlackout(dt);
    this.checkContact();
  }

  // =========================================================================
  // Ground contact: touching down, rolling, lifting off
  // =========================================================================
  //
  // The aeroplane is a handful of points that can touch the ground: the two
  // main tyres and the tailwheel (only while the gear is down and locked), the
  // belly, the bottom of the propeller disc and the two wingtips. Every flight
  // substep that ends with the aeroplane near the ground asks where those
  // points are against the SOLID surface — the terrain or an airfield standing
  // on it — and against the airfield's buildings, and decides what the contact
  // was. A landing is not a gate the battle opens; it is what happens when the
  // tyres arrive first, gently enough for the legs, with the wings level.

  // Body axes in world space, into the module scratch. Cheap: three rotations.
  _bodyAxes() {
    tmpBx.set(1, 0, 0).applyQuaternion(this.quat);
    tmpBy.set(0, 1, 0).applyQuaternion(this.quat);
    tmpBz.set(0, 0, 1).applyQuaternion(this.quat);
  }

  // World position of a point given in the aeroplane's own frame.
  _bodyPoint(lx, ly, lz, out) {
    const p = this.position;
    return out.set(
      p.x + tmpBx.x * lx + tmpBy.x * ly + tmpBz.x * lz,
      p.y + tmpBx.y * lx + tmpBy.y * ly + tmpBz.y * lz,
      p.z + tmpBx.z * lx + tmpBy.z * ly + tmpBz.z * lz,
    );
  }

  // Height of the origin above level ground when standing on the main wheels
  // at a nose-up attitude of `pitch` (a belly slide rides on the belly).
  rideHeight(pitch) {
    const g = this.gearGeo;
    if (this.wrecked || this.gearGone || this.gearPos < 0.98) return -g.bellyY;
    return -(g.mainY * Math.cos(pitch) + g.mainZ * Math.sin(pitch));
  }

  // Height above the ground directly beneath it of a point given in the
  // aeroplane's own frame (call _bodyAxes() first). The deepest point of the
  // current contact check is kept in _cpH / _cpX / _cpZ: that is where the
  // aeroplane is meeting the ground, and so where the slope that decides how
  // hard it met it is measured. Only the points that can carry the aeroplane
  // (wheels, belly) come through here — see checkContact() for why the
  // propeller does not. Goes through SURF_B only.
  _clearance(lx, ly, lz) {
    this._bodyPoint(lx, ly, lz, tmpCp);
    return this._clearanceAt(tmpCp);
  }

  _clearanceAt(pt) {
    const h = pt.y - groundSurfaceAt(pt.x, pt.z, SURF_B).y;
    if (h < this._cpH) {
      this._cpH = h;
      this._cpX = pt.x;
      this._cpZ = pt.z;
    }
    return h;
  }

  // The slope of the ground at (x, z), as its gradient (rise per metre along
  // world X and Z), into this._gradX / this._gradZ. Sampled CLOSURE_SAMPLE
  // either side through SURF_B. The airfield platform — concrete and mown
  // grass — is level by construction and is not sampled: there is nothing to
  // find there but the 4 cm step where the slabs meet the grass, which is no
  // slope at all.
  _surfaceGradient(x, z) {
    const kind = groundSurfaceAt(x, z, SURF_B).kind;
    if (kind === 'concrete' || kind === 'grass') {
      this._gradX = 0;
      this._gradZ = 0;
      return;
    }
    const e = CLOSURE_SAMPLE;
    this._gradX = (groundSurfaceAt(x + e, z, SURF_B).y - groundSurfaceAt(x - e, z, SURF_B).y) / (2 * e);
    this._gradZ = (groundSurfaceAt(x, z + e, SURF_B).y - groundSurfaceAt(x, z - e, SURF_B).y) / (2 * e);
  }

  // Speed into the surface, m/s, along its normal: v . grad(h) - v.y over
  // |(-grad h, 1)|, with the gradient _surfaceGradient() last found. On level
  // ground that is the plain sink rate; on a slope it adds the ground coming
  // up to meet the aeroplane (level at 30 m/s into the 1:2.4 embankment face
  // is 11.5 m/s, not 0) and takes off the ground falling away beneath one
  // landing downhill.
  _closureRate() {
    const v = this.vel;
    const gx = this._gradX;
    const gz = this._gradZ;
    const down = Math.max(0, -v.y);
    const rising = v.x * gx + v.z * gz;
    const into = (rising - v.y) / Math.sqrt(1 + gx * gx + gz * gz);
    // for the wording of a crash: was it the ground coming up, or the
    // aeroplane coming down?
    this._closureUphill = rising > down;
    return Math.max(0, into);
  }

  _closureWord() {
    return this._closureUphill ? 'into rising ground' : 'descent';
  }

  // Report a contact for airfield.js (and anything else) to present.
  _reportContact(kind, sink, surf, reason = '') {
    const c = this.lastContact;
    c.kind = kind;
    c.sink = sink;
    c.speed = this.speed;
    c.surface = surf ? surf.kind : '';
    c.af = surf ? surf.af : null;
    c.reason = reason;
    c.seq++;
  }

  // Into the ground hard enough that nothing is left. The reason is spoken to
  // the pilot the same way every other self-inflicted failure is.
  crash(reason, surf = null, sink = Math.max(0, -this.vel.y)) {
    if (this.state === 'dead') return;
    this.pushEvent(reason);
    this._reportContact('crash', sink, surf, reason);
    this._onGround = false;
    this.explodeNow();
  }

  // Called at the end of every flight substep.
  checkContact() {
    if (this.state !== 'alive') return;
    const p = this.position;
    const g = this.gearGeo;
    // Cheap reject for the common case, an aeroplane well up: the surface was
    // sampled within the last 20 m of travel, and nothing on this map (the
    // steepest hillside, an embankment, a control tower) can climb 40 m in 20.
    const mx = p.x - this._surfX;
    const mz = p.z - this._surfZ;
    if (mx * mx + mz * mz < 400 && p.y - this._surfY > this.contactReach + 40) return;
    const s = groundSurfaceAt(p.x, p.z, SURF_A);
    this._surfX = p.x;
    this._surfZ = p.z;
    this._surfY = s.y;
    // the whole aeroplane fits inside this sphere: above it nothing can touch,
    // and that is the case for every aeroplane that is actually flying
    if (p.y - s.y > this.contactReach) {
      if (s.af) this._checkObstacles(s);
      return;
    }
    this._bodyAxes();
    const bxy = tmpBx.y;
    const byy = tmpBy.y;
    const bzy = tmpBz.y;
    const locked = this.gearPos >= 0.98 && !this.gearGone;
    const base = p.y - s.y;
    // Lowest point of each contact group, as a height above the ground right
    // beneath THAT point. Measuring them all against the ground under the
    // origin, as a level floor, was wrong the moment the ground was not level:
    // on a 1:9 hillside the main wheels sit a metre downhill of the origin and
    // the tailwheel four metres up it, and the ground model's own resting pose
    // read as the wheels 30 cm into the slope — an aeroplane lifting off
    // downhill was back on the ground the next step. (Extending the origin's
    // slope as a plane instead fails at every crest: off the end of the
    // embankment, the face's slope continued back over the platform puts the
    // tailwheel a metre and a half underground.)
    this._cpH = Infinity;
    this._cpX = p.x;
    this._cpZ = p.z;
    let mainL = Infinity;
    let mainR = Infinity;
    let tail = Infinity;
    if (locked) {
      mainL = this._clearance(g.mainX, g.mainY, g.mainZ);
      mainR = this._clearance(-g.mainX, g.mainY, g.mainZ);
      tail = this._clearance(0, g.tailY, g.tailZ);
    }
    const belly = this._clearance(0, g.bellyY, 0);
    // The bottom of the propeller disc: from the hub, propR along the
    // direction in the disc's plane that points most nearly down — world down
    // with its component along the shaft (body Z) taken out.
    const across = Math.sqrt(Math.max(0, 1 - bzy * bzy));
    this._bodyPoint(0, 0, g.propZ, tmpCp);
    if (across > 1e-6) {
      const k = g.propR / across;
      tmpCp.x += k * bzy * tmpBz.x;
      tmpCp.y += k * (bzy * bzy - 1);
      tmpCp.z += k * bzy * tmpBz.z;
    }
    // Measured against the ground under it, but NOT a candidate for where the
    // closure rate is taken. A strike only wrecks the engine and the
    // aeroplane flies on, so by the time the wheels arrive the blade tip can
    // be metres further on and somewhere else entirely: an Il-2 flown level
    // into the embankment face struck the face with its propeller, ran it
    // on through the bank and over the crest, and met the face with its main
    // wheels a fifth of a second later — with the slope read under the
    // propeller, on the level platform, as a 0.7 m/s "touchdown" that then
    // threw it up onto the field at 12 m/s, where the face it had actually
    // hit makes it 11.7. What lands is what the closure belongs to.
    const propLow = tmpCp.y - groundSurfaceAt(tmpCp.x, tmpCp.z, SURF_B).y;
    const wheels = locked ? Math.min(mainL, mainR, tail) : Infinity;
    // The wingtips are six metres out, so they get their own surface sample —
    // but only when they could possibly be down there.
    let tipHit = false;
    const tipDrop = Math.abs(g.tipX * bxy) + g.tipY * byy + g.tipZ * bzy;
    if (base - tipDrop < 3) {
      // both tips, unrolled: an array literal here would be garbage per step
      this._bodyPoint(g.tipX, g.tipY, g.tipZ, tmpCp);
      if (tmpCp.y <= groundSurfaceAt(tmpCp.x, tmpCp.z, SURF_B).y) tipHit = true;
      this._bodyPoint(-g.tipX, g.tipY, g.tipZ, tmpCp);
      if (tmpCp.y <= groundSurfaceAt(tmpCp.x, tmpCp.z, SURF_B).y) tipHit = true;
    }
    const propHit = propLow <= 0;
    const bellyHit = belly <= 0;
    const wheelHit = wheels <= 0;
    if (!tipHit && !propHit && !bellyHit && !wheelHit) {
      if (s.af) this._checkObstacles(s);
      return;
    }

    // Speed into the ground, along its normal (see CLOSURE_SAMPLE), on the
    // slope where the aeroplane is meeting it: under its deepest point.
    this._surfaceGradient(this._cpX, this._cpZ);
    const sink = this._closureRate();
    const speed = this.speed;
    // A wingtip into the ground at any real speed cartwheels the aeroplane.
    if (tipHit && speed > 8) {
      this.crash('Wingtip struck the ground', s, sink);
      return;
    }
    // Nose low enough to put the propeller in first: the blades fold and the
    // engine is shock-loaded. If the legs are down the aeroplane is still
    // about to arrive on them, so the landing goes on — without an engine.
    if (propHit && this.partOk('engine')) this._propStrike();
    if (locked && !wheelHit && !bellyHit) return; // only the propeller, so far
    if (locked) {
      if (sink > SINK_CRASH) {
        this.crash(`Crashed — ${sink.toFixed(1)} m/s ${this._closureWord()}`, s, sink);
        return;
      }
      if (sink > SINK_FAIL) {
        this.loseGear(`Undercarriage collapsed — ${sink.toFixed(1)} m/s`);
        this._beginBellySlide(s, 'collapse', sink);
        return;
      }
      if (sink > SINK_FIRM && this._airTime > 0.2) {
        // the oleos hand some of it back: a hop, and the pilot gets to try
        // the last foot again
        p.y -= Math.min(mainL, mainR, tail);
        this.vel.y = sink * BOUNCE_RETURN;
        this._airTime = 0;
        this._reportContact('bounce', sink, s);
        return;
      }
      this.touchDownOn(s, sink);
      return;
    }
    // Gear up, or still in transit: the belly takes it. A propeller that has
    // only just touched leaves the aeroplane flying a moment longer.
    if (!bellyHit && !tipHit) return;
    if (sink > SINK_FAIL || speed > this.spec.stallSpeed * 2.4 || Math.abs(Math.atan2(bxy, byy)) > 0.45) {
      this.crash(sink > SINK_FAIL ? `Crashed — ${sink.toFixed(1)} m/s ${this._closureWord()}` : 'Crashed into the ground', s, sink);
      return;
    }
    if (this.gearPos > 0.05 && !this.gearGone) this.loseGear('Undercarriage collapsed — not locked down');
    this._beginBellySlide(s, 'belly', sink);
  }

  // Bank angle, rad, positive with the right wing down (the left wing, body
  // +X, up). Zero wings level, PI inverted.
  bankAngle() {
    this._bodyAxes();
    return Math.atan2(tmpBx.y, tmpBy.y);
  }

  _propStrike() {
    const e = this.parts.engine;
    if (e) e.hp = Math.min(e.hp, 0);
    this.oilLeak = Math.max(this.oilLeak, 0.5);
    this.wep = false;
    this.pushEvent('Propeller strike — engine wrecked');
  }

  // Airfield buildings, walls, bowsers and parked aeroplanes are solid. A
  // touch at taxiing pace stops the aeroplane against them; anything faster is
  // a wreck. Tested at the nose, the tail, both wingtips and the centre.
  _checkObstacles(surf) {
    if (this.state !== 'alive') return false;
    const g = this.gearGeo;
    this._bodyAxes();
    const half = this.spec.len * 0.5;
    for (let i = 0; i < 5; i++) {
      if (i === 0) this._bodyPoint(0, 0, 0, tmpCp);
      else if (i === 1) this._bodyPoint(0, 0, half, tmpCp);
      else if (i === 2) this._bodyPoint(0, 0.4, -half, tmpCp);
      else if (i === 3) this._bodyPoint(g.tipX, g.tipY, g.tipZ, tmpCp);
      else this._bodyPoint(-g.tipX, g.tipY, g.tipZ, tmpCp);
      const o = airfieldObstacleAt(tmpCp.x, tmpCp.y, tmpCp.z, 0.2);
      if (!o) continue;
      if (this.speed > OBSTACLE_CRASH_SPEED) {
        this.crash(`Hit the ${o.name}`, surf);
      } else if (this._onGround) {
        // nosed into it at a walking pace: stop, and back off the wall
        this.speed = 0;
        this.vel.set(0, 0, 0);
        this.position.x -= tmpBz.x * 0.3;
        this.position.z -= tmpBz.z * 0.3;
      }
      return true;
    }
    return false;
  }

  // The tyres have arrived gently enough: weight on the wheels. Heading and
  // ground speed carry over, the attitude is whatever it was (up to the
  // three-point angle the tailwheel allows), and the flight model stands down.
  touchDownOn(surf, sink) {
    const g = this.gearGeo;
    this._onGround = true;
    this.groundYaw = Math.atan2(this.dir.x, this.dir.z);
    // The attitude on the wheels is measured from the surface they are on,
    // so the slope comes first; with it taken now (not eased in from wherever
    // the last landing left it) the nose stays exactly where it was unless
    // the tailwheel or the three-point stop has something to say about it.
    const along = this._meetSlope();
    this.groundPitch = clamp(Math.asin(clamp(this.dir.y, -1, 1)) - this.groundSlopePitch, 0, g.threePoint);
    this.groundKind = surf.kind;
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    // The oleos took the speed into the surface; what is left runs along it.
    // groundStep() reads vel.y as the rate the wheels are already following
    // the ground at — leave it at zero on a downhill slope and the very next
    // step decides the ground has fallen away from under a level wheel, and
    // the aeroplane hops off it, every other frame, all the way down the hill.
    this.vel.y = this.speed * along;
    this._wheelVy = this.vel.y;
    this.position.y = surf.y + this.rideHeight(this.groundPitch);
    this.aoa = this.groundPitch;
    this.slip = 0;
    this.gLoad = 1;
    this.spinning = false;
    // the spin only unwinds inside the flight model, which is stood down on
    // the ground — leave the energy in and the next takeoff departs the
    // aeroplane at circuit height
    this.spinEnergy = 0;
    this.stalled = false;
    this.stress = 0;
    this.overrideHold = 0;
    // A wheel that only left the runway a moment ago on the takeoff run, or
    // was thrown off a crest by its own speed, is settling back, not landing:
    // no ceremony for that.
    const hop = (this.lastContact.kind === 'liftoff' || this._groundHop) && this._airTime < 1;
    this._reportContact(hop ? 'settle' : 'touchdown', sink, surf);
    this._airTime = 0;
    this._wheelTime = 0;
    this._groundHop = false;
    this._poseOnGround();
  }

  // Put the aeroplane on its wheels where it is, now, without any of the
  // landing checks — a strip start, or an old caller writing onGround = true.
  settleOnGround() {
    const s = groundSurfaceAt(this.position.x, this.position.z, SURF_A);
    if (!this.wrecked && !this.gearGone) this.setGear(true, true);
    this.groundPitch = this.wrecked ? 0 : this.gearGeo.threePoint;
    this.groundYaw = Math.atan2(this.dir.x, this.dir.z);
    this.groundKind = s.kind;
    this._onGround = true;
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.vel.y = this.speed * this._meetSlope();
    this._wheelVy = this.vel.y;
    this.position.y = s.y + this.rideHeight(this.groundPitch);
    // put there, not landed: free to fly off at once
    this._wheelTime = LIFTOFF_HOLD;
    this._groundHop = false;
    this._poseOnGround();
  }

  // The slope of the surface under the aeroplane, along its heading and
  // across it, sampled exactly as groundStep() samples it; written straight
  // into groundSlopePitch / groundSlopeRoll (no easing — this is for the
  // moment the wheels arrive) and the rise per metre along the heading
  // returned. Needs groundYaw set first. Goes through SURF_B only.
  _meetSlope() {
    const p = this.position;
    const hx = Math.sin(this.groundYaw);
    const hz = Math.cos(this.groundYaw);
    const along = (groundSurfaceAt(p.x + hx * 1.5, p.z + hz * 1.5, SURF_B).y
      - groundSurfaceAt(p.x - hx * 1.5, p.z - hz * 1.5, SURF_B).y) / 3;
    const across = groundSurfaceAt(p.x + hz * 1.5, p.z - hx * 1.5, SURF_B).y
      - groundSurfaceAt(p.x - hz * 1.5, p.z + hx * 1.5, SURF_B).y;
    this.groundSlopePitch = Math.atan(along);
    this.groundSlopeRoll = Math.atan(across / 3);
    return along;
  }

  // Legs folded under it or never down at all: it slides on its belly, the
  // propeller is gone, and it will never fly again. When it stops it is
  // written off — a wreck on the ground, not a fireball.
  _beginBellySlide(surf, kind, sink) {
    if (this.partOk('engine')) this._propStrike();
    this.wrecked = true;
    this._onGround = true;
    this.groundYaw = Math.atan2(this.dir.x, this.dir.z);
    this.groundPitch = 0;
    this.groundKind = surf.kind;
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.vel.y = this.speed * this._meetSlope();
    this._wheelVy = this.vel.y;
    this.position.y = surf.y + this.rideHeight(0);
    this.throttle = 0;
    if (kind === 'belly') this.pushEvent('Belly landing — the aircraft is a write-off');
    this._reportContact(kind, sink, surf);
    this._airTime = 0;
    this._poseOnGround();
  }

  // Turn a stopped aeroplane on the spot to face `yaw` (the ground crew
  // walking the tail round). Only on the ground and only at a standstill.
  swingTo(yaw) {
    if (!this._onGround || this.speed > 1.5 || this.wrecked) return false;
    this.groundYaw = wrapAngle(yaw);
    this.speed = 0;
    this.vel.set(0, 0, 0);
    this._poseOnGround();
    return true;
  }

  // Off the ground. The aeroplane leaves at its current ground attitude with a
  // little climb on it; the flight model takes it from the next substep.
  //
  // It leaves ALONG the surface it was rolling on, not along the horizontal.
  // The attitude on the ground is groundPitch on top of the slope, and the
  // ground model worked out the lift at groundPitch; a horizontal velocity
  // would hand the flight model an angle of attack off by the whole slope.
  // Downhill that is a wing suddenly at negative incidence, which put the
  // aeroplane straight back on the ground the next step — and lifted it off
  // again the step after, for as long as the hill lasted.
  liftOff() {
    if (!this._onGround) return;
    this._onGround = false;
    this._poseOnGround();
    tmpVh.set(Math.sin(this.groundYaw), 0, Math.cos(this.groundYaw));
    this.vel.copy(tmpVh).multiplyScalar(this.speed);
    this.vel.y = this.speed * Math.tan(this.groundSlopePitch) + 0.8;
    this.position.y += 0.05;
    this.aoa = this.groundPitch;
    this._airTime = 0;
    this._groundHop = false;
    this._reportContact('liftoff', 0, null);
  }

  // Orientation on the ground: heading, the attitude on the wheels, and the
  // slope of the surface under it.
  _poseOnGround() {
    tmpGroundE.set(-(this.groundPitch + this.groundSlopePitch), this.groundYaw, this.groundSlopeRoll, 'YXZ');
    this.quat.setFromEuler(tmpGroundE);
    this.syncFromQuat();
  }

  // One step of the ground model: a bad car with wings. The forces are the
  // real ones — thrust, aerodynamic drag and lift (lift takes weight off the
  // tyres, which is why braking is weak at speed), rolling resistance and the
  // brakes on whatever surface is under the wheels, and the component of
  // gravity along a slope — integrated along the heading. The aeroplane does
  // not skid: it goes where it points, and it points where the rudder, the
  // tailwheel and the brakes put it.
  groundStep(dt) {
    const spec = this.spec;
    const ae = this.aero;
    const g = this.gearGeo;
    const p = this.position;
    const mass = this.currentMass();
    const W = mass * GRAV;
    const vs = Math.max(5, this.stallSpeedNow());
    this.vStall = vs;
    let v = this.speed;

    // ---- the tail: up with speed, down as it goes, held by the stick ----
    // Hands off, the tail comes up as the elevator gets authority on a takeoff
    // run and settles again on the roll-out; stick back holds it down (and is
    // what rotates the aeroplane), stick forward lifts it early. A trimmed
    // aeroplane well past its unstick speed flies itself off, which is the
    // last word against a taxi that drives across the map.
    const stick = this.pilotOut ? 0 : clamp(this.controls.pitch, -1, 1);
    this.pitchCmd = stick;
    let pitchTarget;
    if (this.wrecked) {
      pitchTarget = 0;
    } else {
      const u = clamp((v / vs - 0.45) / 0.35, 0, 1);
      const tailUp = u * u * (3 - 2 * u);
      pitchTarget = g.threePoint * (1 - tailUp);
      if (stick < -0.12) pitchTarget = Math.max(pitchTarget, g.threePoint * Math.min(1, -stick * 1.4));
      else if (stick > 0.12 && v > vs * 0.3) pitchTarget *= 1 - Math.min(1, stick * 1.4);
      const intent = stick < -0.12 || this.throttle > 0.6;
      if (intent && v > vs * 1.3 && stick < 0.12) pitchTarget = g.threePoint;
    }
    this.groundPitch = moveToward(this.groundPitch, pitchTarget, TAIL_RATE * dt);

    // ---- forces along the heading ----
    const rho = airDensity(p.y);
    const q = 0.5 * rho * v * v;
    const aCrit = this.stallAoA();
    const alpha = this.wrecked ? 0 : this.groundPitch;
    const liftScale = (this.wingLift('leftWing') + this.wingLift('rightWing')) * 0.5;
    const cl = Math.min(ae.clAlpha * alpha, ae.clAlpha * aCrit) + FLAP_CL[this.flaps];
    const lift = q * ae.wingArea * cl * liftScale;
    let cd = ae.cd0 + ae.k * cl * cl + FLAP_CD[this.flaps] + this.radiator * 0.0045;
    if (this.gearPos > 0) cd += GEAR_CD * this.gearPos;
    if (this.airbrake) cd += spec.airbrakeCd;
    const drag = q * ae.wingArea * cd;
    const thrust = this.wrecked ? 0 : this.thrustNow(v, rho / RHO0);
    const normal = Math.max(0, W - lift);
    // the brake: B, or arcade's crew holding it on with the throttle closed
    let brake = this.airbrake ? 1 : 0;
    if (!brake && this.arcade && this.throttle < 0.03) brake = AUTO_BRAKE;
    if (this.wrecked) brake = 0;
    this.wheelBrake = brake;
    const kind = this.groundKind;
    const mu = this.wrecked
      ? BELLY_MU
      : (ROLL_MU[kind] || ROLL_MU.terrain) + brake * (BRAKE_MU[kind] || BRAKE_MU.terrain);
    // slope along the heading, from the surface a metre either side
    const hx = Math.sin(this.groundYaw);
    const hz = Math.cos(this.groundYaw);
    const ahead = groundSurfaceAt(p.x + hx * 1.5, p.z + hz * 1.5, SURF_B).y;
    const behind = groundSurfaceAt(p.x - hx * 1.5, p.z - hz * 1.5, SURF_B).y;
    const slopeAlong = (ahead - behind) / 3;
    const gravAlong = W * slopeAlong / Math.sqrt(1 + slopeAlong * slopeAlong);
    const drive = thrust - drag - gravAlong;
    const friction = mu * normal;
    if (v < STOP_SPEED && Math.abs(drive) <= friction) {
      v = 0;
    } else {
      v += ((drive - (v > 0 ? friction : 0)) / mass) * dt;
      if (v < 0) v = 0; // no reverse gear
    }

    // ---- steering ----
    // The rudder bites with airspeed and with the slipstream of an engine at
    // power; a locked, steerable tailwheel does the work at taxiing pace while
    // the tail is on the ground. Hard braking with rudder is the differential
    // brake every taildragger pilot leans on to turn on the spot.
    if (!this.wrecked) {
      const rudder = clamp(this.groundRudder || 0, -1, 1);
      const aero = spec.yawRate * clamp(v / (spec.minSpeed * 1.2), 0, 1);
      const wash = spec.yawRate * 0.45 * clamp(this.throttle, 0, 1) * clamp(1 - v / 25, 0, 1);
      const tailOn = 1 - clamp(1 - this.groundPitch / Math.max(0.05, g.threePoint), 0, 1) * 0.85;
      const wheel = 0.6 * tailOn * clamp(v / 2.5, 0, 1) * clamp(1 - v / 30, 0, 1);
      const diff = brake > 0.5 && v < 8 ? 0.5 : 0;
      this.groundYaw = wrapAngle(this.groundYaw + rudder * (aero + wash + wheel + diff) * dt);
    }

    // ---- move, and follow the surface ----
    const hx2 = Math.sin(this.groundYaw);
    const hz2 = Math.cos(this.groundYaw);
    p.x += hx2 * v * dt;
    p.z += hz2 * v * dt;
    const s = groundSurfaceAt(p.x, p.z, SURF_A);
    const prevY = p.y;
    const wantY = s.y + this.rideHeight(this.groundPitch);
    // The ground falling away faster than gravity can follow (the crest of
    // the embankment taken fast, the end of the field): the wheels leave it.
    // (_wheelVy, not vel.y: the wheels' own vertical speed from the last
    // step, which nothing outside the ground model can write)
    const fallY = prevY + (this._wheelVy - GRAV * dt) * dt;
    if (wantY < fallY - 0.05 && !this.wrecked) {
      // ...and carry on the way they were going: along the slope just left,
      // under gravity (taking the climb off a crest, keeping the descent of
      // a steepening hill) — not flattened to the horizontal.
      const vy = this._wheelVy;
      this._onGround = false;
      tmpVh.set(hx2, 0, hz2);
      this.vel.copy(tmpVh).multiplyScalar(v);
      this.vel.y = vy - GRAV * dt;
      this.speed = this.vel.length();
      this._airTime = 0;
      this._groundHop = true;
      return;
    }
    // The ground rising faster than a wheel can climb: a bank or a wall.
    if (wantY - prevY > 0.6 + v * dt * ROUGH_SLOPE[s.kind]) {
      if (v > 6) {
        this.crash('Ran into the bank', s);
        return;
      }
      p.x -= hx2 * v * dt;
      p.z -= hz2 * v * dt;
      v = 0;
    } else {
      p.y = wantY;
    }
    this.groundKind = s.kind;
    this._wheelVy = (p.y - prevY) / Math.max(dt, 1e-4);
    this.vel.set(hx2 * v, this._wheelVy, hz2 * v);
    this.speed = v;

    // the slope under it, eased so a crest is a nod rather than a snap
    const across = groundSurfaceAt(p.x + hz2 * 1.5, p.z - hx2 * 1.5, SURF_B).y
      - groundSurfaceAt(p.x - hz2 * 1.5, p.z + hx2 * 1.5, SURF_B).y;
    const slopeRoll = Math.atan(across / 3);
    const slopePitch = Math.atan(slopeAlong);
    this.groundSlopePitch = moveToward(this.groundSlopePitch, slopePitch, 1.2 * dt);
    this.groundSlopeRoll = moveToward(this.groundSlopeRoll, slopeRoll, 1.2 * dt);
    // Too steep for the speed: a wheel digs in and over it goes.
    const slope = Math.hypot(slopeAlong, across / 3);
    if (v > ROUGH_SPEED && slope > (ROUGH_SLOPE[s.kind] || ROUGH_SLOPE.terrain)) {
      this.crash('Overturned on rough ground', s);
      return;
    }

    this._poseOnGround();
    this.aoa = alpha;
    this.slip = 0;
    this.gLoad = 1;
    this.stalled = false;
    if (this._checkObstacles(s)) {
      if (this.state !== 'alive') return;
    }

    // ---- lift-off ----
    // The wing has the weight, and the pilot means it: stick back, or the
    // throttle open for a takeoff. Without the intent clause a fast wheel
    // landing would float straight back into the air the moment it touched,
    // which is not what pinning it down with the stick feels like. Weight that
    // has only just arrived stays on the wheels for LIFTOFF_HOLD first.
    this._wheelTime += dt;
    const intent = stick < -0.12 || this.throttle > 0.6;
    if (!this.wrecked && intent && lift > W * 1.02 && v > vs * 0.9 && this._wheelTime >= LIFTOFF_HOLD) {
      this.liftOff();
      return;
    }

    // A wreck that has stopped sliding is a wreck.
    if (this.wrecked && v < 0.3) this.writeOff();
  }

  // The aeroplane is finished but did not explode: it stays where it stopped,
  // and the battle books it as lost exactly as it would a crash.
  writeOff() {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.wreckedOnGround = true;
    this.firing = false;
    this.burning = false;
    this.fire.engine = false;
    this.fire.fuel = false;
    this.fire.wing = false;
    this._onGround = false;
    this.pushEvent('Aircraft written off');
  }

  thrustNow(v, dRatio) {
    const spec = this.spec;
    const ae = this.aero;
    const health = this.engineHealth();
    if (health <= 0) return 0;
    // supercharged engines hold rated power to their critical altitude and
    // fall away above it — the P-51 is still making power where the Fw 190
    // has given up
    const alt = dRatio >= spec.critDensity ? 1 : dRatio / spec.critDensity;
    const hot = this.engineTemp > 0.9 ? Math.max(0.6, 1 - (this.engineTemp - 0.9) * 2.5) : 1;
    const boost = this.wep ? 1.12 : 1;
    return (
      (ae.thrustStatic * (0.05 + 0.95 * clamp(this.throttle, 0, 1)) * boost * health * alt * hot) /
      (1 + v / ae.propKnee)
    );
  }

  updateBlackout(dt) {
    const g = this.gLoad;
    if (g > G_BLACKOUT) {
      this.blackout = clamp(this.blackout + clamp((g - G_BLACKOUT) / 2, 0, 1) * 0.85 * dt, 0, 1);
    } else {
      this.blackout = Math.max(0, this.blackout - 0.5 * dt);
    }
    if (g < G_REDOUT) {
      // blood to the head is far less survivable than blood to the boots
      this.redout = clamp(this.redout + clamp((G_REDOUT - g) / 1.4, 0, 1) * 0.9 * dt, 0, 1);
    } else {
      this.redout = Math.max(0, this.redout - 0.5 * dt);
    }
  }

  // Departure and autorotation. Yaw at high angle of attack is what turns a
  // stall into a spin; opposite rudder with the stick unloaded is what turns it
  // back into flying.
  updateSpin(dt, stallDepth, v) {
    if (stallDepth > 0.02) {
      const asym =
        Math.abs(this.slip) * 2.2 +
        Math.abs(this.controls.roll) * 0.5 +
        Math.abs(this.controls.yaw) * 0.6 +
        Math.abs(this.partFrac('leftWing') - this.partFrac('rightWing')) * 1.5;
      this.spinEnergy = clamp(this.spinEnergy + (0.2 + asym) * stallDepth * dt, 0, 1);
      if (!this.spinning && this.spinEnergy > 0.35) {
        this.spinning = true;
        // the aeroplane departs away from the wing that stalled first
        this.spinDir = this.slip > 0 ? -1 : 1;
        this.pushEvent('Spin!');
      }
    } else {
      const anti = this.controls.yaw * this.spinDir < -0.25 ? 1.8 : 0.55;
      // the wing is unloaded by what the elevator DID, not by what was asked
      // for: in arcade the limiter unloads it for you while the stick is still
      // buried, and that recovery has to count
      const unloaded = this.pitchCmd > -0.1 ? 1 : 0.35;
      const flying = v > this.vStall * 1.1 ? 1.3 : 0.8;
      this.spinEnergy = Math.max(0, this.spinEnergy - anti * unloaded * flying * dt);
      if (this.spinning && this.spinEnergy < 0.12) {
        this.spinning = false;
        this.pushEvent('Recovered');
      }
    }
  }

  // Fuel, oil, coolant, WEP: the housekeeping that decides whether the engine
  // is still an engine by the end of the sortie.
  updateSystems(dt) {
    const spec = this.spec;
    const running = this.engineHealth() > 0;
    const burn = running ? spec.fuelBurn * (0.12 + 0.88 * clamp(this.throttle, 0, 1)) * (this.wep ? 1.4 : 1) : 0;
    const hadFuel = this.fuel > 0;
    this.fuel = Math.max(0, this.fuel - (burn + this.fuelLeak) * dt);
    if (hadFuel && this.fuel <= 0) this.pushEvent('Out of fuel');
    // a tank that has run dry cannot go on burning
    if (this.fuel <= 0 && this.fire.fuel) {
      this.fire.fuel = false;
      this.pushEvent('Fuel fire burnt out');
    }

    // ---- engine temperature ----
    const rho = airDensity(this.position.y);
    // a dead engine makes no heat; a leaking one runs hot because the oil that
    // should be carrying the heat away is going over the side
    const load = running
      ? (0.15 + 0.85 * clamp(this.throttle, 0, 1)) *
        (this.wep ? 1.75 : 1) *
        (this.fire.engine ? 1.8 : 1) *
        (1 + this.oilLeak * 0.5)
      : 0.05;
    // Thin air carries less heat away, but it is also colder air, so altitude
    // only costs part of the cooling rather than all of it.
    const cool =
      (0.3 + 0.7 * this.radiator) *
      (0.35 + 0.65 * Math.min(1, this.speed / spec.maxSpeed)) *
      (0.55 + 0.45 * (rho / RHO0)) *
      (this.partOk('oilCooler') ? 1 : 0.3);
    const target = clamp((load / Math.max(0.2, cool)) * 0.42, 0, 1.4);
    this.engineTemp += (target - this.engineTemp) * Math.min(1, dt / TEMP_TAU);

    if (this.engineTemp > 0.98 && this.wep) {
      this.wep = false;
      this.wepLock = true;
      this.pushEvent('WEP cut — overheat');
    }
    if (this.wepLock && this.engineTemp < 0.72) this.wepLock = false;
    if (this.engineTemp > 0.9 && running) {
      // cooking the engine is a slow punishment, not an instant one: there is
      // time to open the radiator or throttle back before anything seizes
      this.hurtPart('engine', (this.engineTemp - 0.9) * 3 * dt, null, true);
      this.overheatWarn -= dt;
      if (this.overheatWarn <= 0) {
        this.overheatWarn = 6;
        this.pushEvent('Engine overheating');
      }
    } else {
      this.overheatWarn = 0;
    }

    // an oil leak is a slow death sentence for the engine, and a smoke trail
    // every fighter in the sky can see
    if (this.oilLeak > 0 && this.partOk('engine')) {
      this.hurtPart('engine', OIL_ENGINE_WEAR * this.oilLeak * dt, null, true);
    }
    this.smoking = this.oilLeak > 0.15 || !this.partOk('engine');
  }

  // Overspeed and over-G. Neither is instant: the airframe spends a budget,
  // which is why a brief snatch is survivable and a long dive is not.
  //
  // Both paths carry a deadband, because the rated limit is where the safety
  // factor starts, not where the metal parts company — a few per cent over is
  // free and only what is past the band spends anything. The coefficients are
  // soft enough that a moment's overshoot costs a fraction of the budget, the
  // refund is quick enough that unloading actually saves you, and the warning
  // is DETERMINISTIC: it fires the instant the budget starts being spent,
  // which is a good second and a half before anything breaks.
  updateStructure(dt) {
    const spec = this.spec;
    const v = this.speed;
    const vOver = v / spec.structuralSpeed;
    // a shattered wing panel will not take anything like its rated load
    const gCap = spec.maxG * (this.wingsOk ? 1 : 0.55);
    const gOver = Math.abs(this.gLoad) / gCap;
    let rate = 0;
    let worst = 0;
    let cause = '';
    if (vOver > V_DEADBAND) {
      const e = vOver - V_DEADBAND;
      rate += e * V_STRESS_RATE;
      worst = e;
      cause = 'Airframe overspeed — slow down!';
    }
    // over-G is still the less forgiving of the two, just no longer instant
    if (gOver > G_DEADBAND) {
      const e = gOver - G_DEADBAND;
      rate += e * G_STRESS_RATE;
      if (e >= worst) cause = 'Wings overloaded — unload!';
    }
    this.overStress = rate > 0;
    this.stress = Math.max(0, this.stress + (rate > 0 ? rate : -STRESS_RECOVER) * dt);
    if (rate > 0) {
      this.stressWarn -= dt;
      if (this.stressWarn <= 0) {
        this.stressWarn = STRESS_WARN_EVERY;
        this.pushEvent(cause);
      }
    } else {
      // back inside the envelope: the next excursion warns immediately
      this.stressWarn = 0;
    }
    if (this.stress > 1) {
      const side = this.partFrac('leftWing') <= this.partFrac('rightWing') ? 'leftWing' : 'rightWing';
      this.ripWing(side, null);
      return;
    }

    // flaps and gear are not built for combat speeds and say so by leaving
    // — after a spoken warning, in the units the airspeed tape reads, once the
    // speed is within FLAP_WARN of the stage's limit
    if (this.flapWarnCd > 0) this.flapWarnCd -= dt;
    // (indicated: see FLAP_WARN)
    const vi = this.ias;
    if (this.flaps > 0 && vi > spec.flapRip[this.flaps - 1]) {
      this.flaps--;
      this.pushEvent('Flaps ripped');
    } else if (this.flaps > 0 && vi > spec.flapRip[this.flaps - 1] * FLAP_WARN && !(this.flapWarnCd > 0)) {
      this.flapWarnCd = GEAR_WARN_EVERY;
      this.pushEvent(`Flap overspeed — limit ${this.flapLimitKmh()} km/h`);
    }
    this.updateGearLoads(dt);
  }

  // Legs out in an airstream faster than they are built for. The handbook
  // limit (VLE) is where the safety factor starts: a little over it is a
  // spoken warning, well over it for a couple of seconds tears them off — and
  // that is one way: the lever stops meaning anything and updateGear() has
  // nothing left to animate. Indicated airspeed, so the limit means the same
  // at every height, as it does on the real dial.
  updateGearLoads(dt) {
    if (this.gearWarnCd > 0) this.gearWarnCd -= dt;
    if (this.gearGone || this.gearPos <= 0 || this._onGround) {
      this.gearStrain = Math.max(0, this.gearStrain - GEAR_STRAIN_RECOVER * dt);
      return;
    }
    const over = this.gearLoadRatio();
    // Lever already up: the pilot is doing the one thing the warning would
    // tell him to, so it stays quiet unless the legs are actually being hurt
    // on their way in.
    const retracting = !this.gear;
    if (over > GEAR_WARN_OVER && this.gearWarnCd <= 0 && (!retracting || over > GEAR_FAIL_OVER)) {
      this.gearWarnCd = GEAR_WARN_EVERY;
      this.pushEvent(`Gear overspeed — limit ${Math.round(displaySpeedKmh(this.gearLim.vle))} km/h`);
    }
    if (over > GEAR_FAIL_OVER) {
      // the further past the line, the quicker it goes
      this.gearStrain += (dt / GEAR_FAIL_TIME) * (1 + (over - GEAR_FAIL_OVER) * 4);
    } else {
      this.gearStrain = Math.max(0, this.gearStrain - GEAR_STRAIN_RECOVER * dt);
    }
    if (this.gearStrain >= 1) {
      this.loseGear('Undercarriage torn off by the airflow');
      // the legs take a piece of the wing with them
      this.hurtPart('leftWing', this.parts.leftWing ? this.parts.leftWing.max * 0.12 : 0, null, true);
      this.hurtPart('rightWing', this.parts.rightWing ? this.parts.rightWing.max * 0.12 : 0, null, true);
    }
  }

  // Fires burn until the bottle is used, the fuel runs out or the aeroplane
  // does. burnTimer is the time left at the current burn rate, which is what
  // the HUD counts down.
  updateFires(dt) {
    let dps = 0;
    if (this.fire.engine) dps += 2.2;
    if (this.fire.fuel) dps += 3.2;
    if (this.fire.wing) dps += 1.8;
    if (dps <= 0) {
      this.burning = false;
      this.burnTimer = 0;
      return;
    }
    this.burning = true;
    this.hp -= dps * dt;
    if (this.fire.engine) this.hurtPart('engine', 1.4 * dt, null, true);
    if (this.fire.fuel) {
      this.hurtPart('fuelTank', 1.2 * dt, null, true);
      this.fuel = Math.max(0, this.fuel - 1.5 * dt);
    }
    if (this.fire.wing) {
      const key = this.partFrac('leftWing') <= this.partFrac('rightWing') ? 'leftWing' : 'rightWing';
      this.hurtPart(key, 1.1 * dt, null, true);
    }
    this.burnTimer = Math.max(0, this.hp / dps);
    if (this.hp <= 0) this.beginFalling();
  }

  startFire(source, events) {
    if (this.fire[source]) return;
    if (source === 'fuel' && this.fuel <= 0) return;
    this.fire[source] = true;
    this.burning = true;
    const msg = source === 'fuel' ? 'Fuel fire!' : 'Fire!';
    if (events) events.push(msg);
    this.pushEvent(msg);
  }

  updateFalling(dt) {
    this.rotateBody(0.9 * dt, 0, this.fallSpin * 3.0 * dt);
    this.syncFromQuat();
    // a wreck is a shape falling: gravity, a lot of drag, and no lift at all
    const v = this.speed;
    if (v > 1e-4) {
      const q = 0.5 * airDensity(this.position.y) * v * v;
      const drag = (q * this.aero.wingArea * 0.09) / this.currentMass();
      this.vel.addScaledVector(this.vel, (-drag * dt) / v);
    }
    this.vel.y -= GRAV * dt;
    this.speed = this.vel.length();
    const cap = this.spec.structuralSpeed * 1.3;
    if (this.speed > cap) {
      this.vel.multiplyScalar(cap / this.speed);
      this.speed = cap;
    }
    this.position.addScaledVector(this.vel, dt);
    this.clampBounds();
    // a wreck comes down on whatever is there — the runway and the hangars as
    // well as the hillside
    const p = this.position;
    const s = groundSurfaceAt(p.x, p.z, SURF_A);
    if (p.y < s.y + 1.2 || (s.af && airfieldObstacleAt(p.x, p.y, p.z, 1))) this.explodeNow();
  }

  clampBounds() {
    const p = this.position;
    // The same argument the ceiling makes below applies sideways. Pinning x and
    // z on their own let an aeroplane grind along the map wall at full speed
    // with all its energy intact, which made the boundary a free brick to lean
    // on. Take the component that is driving into the wall away and leave the
    // rest of the velocity alone: what is left is a shallower, slower aeroplane
    // that the flight model then has to fly out of the corner on its own.
    let bounded = false;
    if (p.x < -MAP_EDGE) {
      p.x = -MAP_EDGE;
      if (this.vel.x < 0) {
        this.vel.x = 0;
        bounded = true;
      }
    } else if (p.x > MAP_EDGE) {
      p.x = MAP_EDGE;
      if (this.vel.x > 0) {
        this.vel.x = 0;
        bounded = true;
      }
    }
    if (p.z < -MAP_EDGE) {
      p.z = -MAP_EDGE;
      if (this.vel.z < 0) {
        this.vel.z = 0;
        bounded = true;
      }
    } else if (p.z > MAP_EDGE) {
      p.z = MAP_EDGE;
      if (this.vel.z > 0) {
        this.vel.z = 0;
        bounded = true;
      }
    }
    // speed feeds q, the stall check and every readout, so it has to follow the
    // velocity down the moment the wall takes a bite out of it
    if (bounded) this.speed = this.vel.length();
    // Pinning the position alone leaves the climb on the books: the aeroplane
    // hangs against the ceiling burning its speed off into a wall it cannot
    // see. Take the vertical component away when it arrives and let it fly.
    if (p.y > 1000) {
      p.y = 1000;
      if (this.vel.y > 0) {
        this.vel.y = 0;
        this.speed = this.vel.length();
      }
    }
  }

  beginFalling() {
    if (this.state !== 'alive') return;
    this.state = 'falling';
    if (!this.ripped) this.fallSpin = Math.random() < 0.5 ? -1 : 1;
    this.firing = false;
    this.spinning = false;
  }

  explodeNow() {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this._onGround = false;
    this.group.visible = false;
    this.justExploded = true;
    this.burning = false;
    this.fire.engine = false;
    this.fire.fuel = false;
    this.fire.wing = false;
  }

  // A wing fails and leaves. Everything hung on it goes too, and what is left
  // rolls into the hole where the lift used to be.
  ripWing(key, events) {
    if (this.ripped) return;
    this.ripped = key;
    const wing = this.parts[key];
    if (wing) wing.hp = Math.min(wing.hp, 0);
    const aileron = this.parts[key === 'leftWing' ? 'aileronL' : 'aileronR'];
    if (aileron) aileron.hp = Math.min(aileron.hp, 0);
    const mesh = this.partMeshes[key];
    if (mesh) mesh.visible = false;
    // whatever was hung on that panel went with it
    this._shedWingStores(key);
    this.fallSpin = key === 'leftWing' ? -1 : 1;
    const msg = key === 'leftWing' ? 'Left wing torn off' : 'Right wing torn off';
    if (events) events.push(msg);
    this.pushEvent(msg);
    this.beginFalling();
  }

  // Damage one named part. `events` collects the messages the shooter sees;
  // `quiet` is for the slow damage the aeroplane does to itself (fire, oil
  // starvation, overheat) which should not read as a hit.
  hurtPart(key, dmg, events, quiet = false) {
    const p = this.parts[key];
    if (!p || dmg <= 0) return;
    const wasOk = p.hp > 0;
    p.hp = Math.max(0, p.hp - dmg);

    // partial damage tells before the part actually fails
    if (wasOk && !quiet) {
      if (key === 'engine' && Math.random() < 0.4) {
        this.oilLeak = Math.min(1, this.oilLeak + 0.25 + dmg / p.max);
      }
      if (key === 'fuelTank') {
        this.fuelLeak += 0.12 + (dmg / p.max) * 0.6;
        if (Math.random() < this.spec.fireRisk * 0.35) this.startFire('fuel', events);
      }
    }
    if (wasOk && p.hp <= 0) this.partBroken(key, events);
  }

  partBroken(key, events) {
    const say = (m) => {
      if (events) events.push(m);
      this.pushEvent(m);
    };
    switch (key) {
      case 'engine':
        say('Engine destroyed');
        this.oilLeak = 1;
        this.wep = false;
        if (Math.random() < 0.45) this.startFire('engine', events);
        break;
      case 'oilCooler':
        say('Oil cooler holed');
        this.oilLeak = Math.min(1, this.oilLeak + 0.5);
        break;
      case 'fuelTank':
        say('Fuel tank holed');
        this.fuelLeak += 0.9;
        if (Math.random() < this.spec.fireRisk) this.startFire('fuel', events);
        break;
      case 'pilot':
        say('Pilot knocked out');
        this.pilotOut = true;
        this.controls.roll = 0;
        this.controls.pitch = 0;
        this.controls.yaw = 0;
        this.beginFalling();
        break;
      case 'leftWing':
      case 'rightWing': {
        say(key === 'leftWing' ? 'Left wing shattered' : 'Right wing shattered');
        if (Math.random() < this.spec.fireRisk * 0.4) this.startFire('wing', events);
        const other = key === 'leftWing' ? 'rightWing' : 'leftWing';
        // one panel gone is survivable if you are gentle; both is not
        if (this.parts[other].hp <= 0) this.ripWing(key, events);
        break;
      }
      case 'tail':
        say('Tail shot away');
        this.beginFalling();
        break;
      case 'elevator':
        say('Elevator shot away');
        break;
      case 'rudder':
        say('Rudder shot away');
        break;
      case 'aileronL':
        say('Left aileron shot away');
        break;
      case 'aileronR':
        say('Right aileron shot away');
        break;
      case 'controls':
        say('Control cables cut');
        break;
      default:
        break;
    }
  }

  // returns { killed, events }
  // hitPoint (world space) and hitDir (world space, direction of travel) are
  // optional: with them the round is resolved against the aircraft's component
  // boxes, without them the damage lands on a part picked by how much of the
  // aeroplane that part is — which is what a bomb blast deserves anyway.
  applyDamage(dmg, attacker, hitPoint = null, hitDir = null) {
    if (this.state !== 'alive') return { killed: false, events: [] };
    this.hp -= dmg;
    this.lastAttacker = attacker;
    this.lastHitAge = 0;
    // remember everyone who dealt damage, for assist rewards on death
    if (attacker) (this.damagers || (this.damagers = new Set())).add(attacker);
    const events = [];

    let box = null;
    if (hitPoint) {
      this.group.updateWorldMatrix(true, false);
      tmpMat.copy(this.group.matrixWorld).invert();
      tmpPt.copy(hitPoint).applyMatrix4(tmpMat);
      let local = null;
      if (hitDir) {
        tmpQ2.copy(this.quat).invert();
        local = tmpHitDir.copy(hitDir).applyQuaternion(tmpQ2).normalize();
      }
      box = tracePlaneParts(this.spec, tmpPt, local);
    } else {
      box = randomPlanePart(this.spec);
    }
    if (box) this.hurtPart(box.part, dmg, events);

    if (this.hp <= 0) {
      this.beginFalling();
      return { killed: true, events };
    }
    return { killed: this.state !== 'alive', events };
  }

  // Reusable snapshot for the HUD — no allocation, safe to call every frame.
  flightStatus() {
    const s = this._status;
    s.speed = this.speed;
    s.stallSpeed = this.vStall;
    s.aoa = this.aoa;
    s.slip = this.slip;
    s.gLoad = this.gLoad;
    s.blackout = this.blackout;
    s.redout = this.redout;
    s.stalled = this.stalled;
    s.spinning = this.spinning;
    s.mach = this.speed / this.spec.structuralSpeed;
    s.throttle = this.throttle;
    s.wep = this.wep;
    s.wepLock = this.wepLock;
    s.engineTemp = this.engineTemp;
    s.radiator = this.radiator;
    s.fuel = this.spec.fuelCapacity > 0 ? this.fuel / this.spec.fuelCapacity : 0;
    s.fuelKg = this.fuel;
    s.flaps = this.flaps;
    // gear stays the boolean lever the HUD flag has always read; gearPos is
    // there for anything that wants to show a gear in transit.
    s.gear = this.gear;
    s.gearPos = this.gearPos;
    s.gearGone = this.gearGone;
    // Lever down but the legs held in the wells because it is too fast, the
    // operating limit as the airspeed tape reads it (km/h indicated), and how
    // far over the extended limit the legs are being flown (1 = on the line;
    // the load ratio the strain model uses, so a gear on its way up reads
    // what it is actually carrying).
    s.gearHeld = this.gearHeld;
    s.gearLimitKmh = this.gearLimitKmh();
    s.gearOver = this.gearLoadRatio();
    s.gearStrain = this.gearStrain;
    s.airbrake = this.airbrake;
    // Indicated airspeed and the stall on the same dial: an indicated stall
    // speed does not move with height, which is the reason pilots fly IAS.
    s.ias = this.ias;
    s.stallIas = this.vStall * Math.sqrt(airDensity(this.position.y) / RHO0);
    // ...and the same two as the dial prints them (planes.js displaySpeedKmh)
    s.iasKmh = displaySpeedKmh(s.ias);
    s.stallIasKmh = displaySpeedKmh(s.stallIas);
    s.onGround = this._onGround;
    s.wheelBrake = this._onGround ? this.wheelBrake : 0;
    s.wrecked = this.wrecked;
    s.altitude = this.position.y;
    s.climb = this.vel.y;
    s.burning = this.burning;
    s.smoking = this.smoking;
    s.extinguishers = this.extinguishers;
    // structural state, for a HUD that wants to show the airframe budget being
    // spent instead of only announcing it after the wing has gone
    s.stress = this.stress;
    s.overStress = this.overStress;
    s.gLimited = this.gLimited;
    s.gLimit = this.structuralG();
    s.difficulty = this.difficulty;
    return s;
  }

  dispose() {
    this.scene.remove(this.group);
    // The airframe, the pylons and the store bodies are cloned off the per-spec
    // geometry cache and painted with the shared material factory, so every
    // other aeroplane of this type is drawing from the same objects: a blanket
    // dispose here used to empty the sky on the next spawn. disposeOwned frees
    // what this aircraft genuinely owns and steps over anything materials.js
    // has stamped as shared — disposeMaterials() is the only thing allowed to
    // free those.
    disposeOwned(this.group);
  }
}

// ---------------------------------------------------------------------------
// Propeller speed and condensation hooks (A-01, X-06)
// ---------------------------------------------------------------------------
// Propeller revolutions per second at the hub. 4.7 rev/s is a geared engine
// idling at ~600 rpm; 22 rev/s is take-off power through a ~0.45 reduction.
export const PROP_IDLE_RPS = 4.7;
export const PROP_MAX_RPS = 22;
export const PROP_WINDMILL_RPS = 7;
export const PROP_SPOOL_S = 0.7;

// Bible E-31: persistent contrails form only in the cold, high air above about
// 7,500 m. The game's playable ceiling is about 1 km, so this is never true in
// a battle today; the path is kept so a higher map gets it for free.
export const CONTRAIL_MIN_ALT = 7500;
export function contrailStrength(plane) {
  if (!plane || !plane.position || plane.position.y < CONTRAIL_MIN_ALT) return 0;
  const sn = plane.speed / Math.max(1, plane.spec ? plane.spec.maxSpeed : 1);
  return clamp((plane.position.y - CONTRAIL_MIN_ALT) / 600, 0, 1) * clamp((sn - 0.5) * 2, 0, 1);
}

// Wingtip vapour (bible 6.5): only at |g| >= 5 and only in humid air. The
// effect itself keeps its life <= 0.5 s and alpha <= 0.3 (combat/effects.js).
export const VAPOUR_MIN_G = 5;
export function humidAir(preset) {
  if (!preset) return false;
  const w = preset.weatherKey;
  const t = preset.todKey;
  return w === 'overcast' || w === 'snow' || w === 'rain' || preset.precip === 'rain' || preset.precip === 'snow'
    || t === 'dawn' || t === 'overcast';
}
export function wingVapourStrength(plane, preset) {
  if (!plane || !humidAir(preset)) return 0;
  const g = Math.abs(plane.gLoad || 0);
  if (g < VAPOUR_MIN_G) return 0;
  const sn = plane.speed / Math.max(1, plane.spec ? plane.spec.maxSpeed : 1);
  return clamp((g - VAPOUR_MIN_G) / 2.5, 0.1, 1) * clamp(sn, 0, 1);
}
