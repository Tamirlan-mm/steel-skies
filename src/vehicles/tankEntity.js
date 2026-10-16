import * as THREE from 'three';
import {
  buildTankMesh,
  shellPenAt,
  PEN_SCATTER,
  armourFace,
  surfaceProps,
  gearboxFor,
  suspensionFor,
  driveRunningGear,
} from './tanks.js';
import { terrainHeight, PLAY_BOUND } from '../world/terrain.js';
import { clamp, moveToward, angleToward, wrapAngle } from '../core/utils.js';
import { isSharedResource } from '../core/materials.js';
import {
  traceInternals,
  coneDirections,
  crewRoles,
  fillerWithin,
  MODULE_REPAIR,
  FUSE,
  SPALL,
  FILLER,
} from '../combat/internals.js';

const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);
const tmpV = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpQ2 = new THREE.Quaternion();
const tmpMat = new THREE.Matrix4();
const tmpOrigin = new THREE.Vector3();
const tmpTravel = new THREE.Vector3();
const tmpCentre = new THREE.Vector3();
const tmpEntry = new THREE.Vector3();
const tmpLocalDir = new THREE.Vector3();
const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const tmpPlate = new THREE.Vector3();
const tmpArmPoint = new THREE.Vector3();
const tmpArmDir = new THREE.Vector3();
const tmpBurst = new THREE.Vector3();
const dispA = new THREE.Vector3();
const dispB = new THREE.Vector3();
// reused by sampleGround so the four-point terrain probe allocates nothing
const groundSample = { pitch: 0, roll: 0, slope: 0 };

// Angle from the plate normal where each shell family starts to skid off, and
// where it always does. Subcalibre APCR skids early, a shaped charge much less.
const RICOCHET = {
  AP: [1.19, 1.36], // 68° .. 78°
  APHE: [1.19, 1.36],
  APCR: [1.13, 1.26], // 65° .. 72°
  HEAT: [1.36, 1.48], // 78° .. 85°
  HE: [1.4, 1.52], // 80° .. 87°
};

// Radians the shell turns back toward the plate normal on impact, which is why
// sloped armour is never quite as good as raw trigonometry suggests.
const NORMALIZATION = { AP: 0.07, APHE: 0.07, APCR: 0.035, HEAT: 0, HE: 0 };

const DEFAULT_ELEV = { min: -0.14, max: 0.38 };

// One plate solution, reused: which face was really struck, how it was lying,
// and what that makes it worth against this shell. Read it, do not keep it.
const plateSolve = {
  kind: 'AP', armor: 0, impact: 0, overmatch: false,
  ricochetChance: 0, effArmor: 0, effPen: 0,
};
const forecastOut = { effArmor: 0, effPen: 0, ricochetChance: 0, verdict: 'no' };

// Modules the crew can actually put right, in the order they would get to
// them: mobility first, because a tank that cannot move is a tank that is
// about to be hit again, then the gun, then everything else.
const REPAIRABLE = [
  'tracks', 'engine', 'transmission', 'breech', 'barrel',
  'traverse', 'elevation', 'radiator',
];

// A wounded crewman works one-handed and gets no better than this on his own;
// anything past it needs the first aid kit.
const CREW_SELF_HEAL_CAP = 0.7;
const CREW_SELF_HEAL_RATE = 0.035;
// Crew Replenishment. The kits it adds are what put a knocked-out man back in
// his seat; what the module buys between those is a compartment with dressings
// where a man can reach them, so the walking wounded are working again in a
// third of the time. The cap does not move — patching yourself up one-handed is
// still patching yourself up.
const CREW_REPLENISH_HEAL = 2.6;

// Crew replacement. A seat that has lost its man is filled, after a delay, by
// the least important free man sitting in a LESS important seat — never the
// other way round. The order is the one the crews themselves worked to:
// radio < commander < loader < gunner < driver. (internals.js CREW_ORDER is a
// seat LAYOUT order and ranks these differently; it is not used for this.)
const CREW_IMPORTANCE = { radio: 0, commander: 1, loader: 2, gunner: 3, driver: 4 };
const SEATS_BY_IMPORTANCE = ['driver', 'gunner', 'loader', 'commander', 'radio'];
// Seconds for a healthy man to climb from his seat into another. On a WWII tank
// that means squeezing past the transmission or round the turret basket with
// the hull under fire, so it is not quick — and a wounded man is slower still:
// pace = 1 / (CREW_SWAP_TIME * (1 + CREW_SWAP_WOUND_SLOW * (1 - health))).
const CREW_SWAP_TIME = 5;
const CREW_SWAP_WOUND_SLOW = 0.6;
// With nobody in the loader's seat somebody else is wrestling rounds out of the
// racks one handed: the reload takes exactly this many times as long.
const LOADER_EMPTY_RELOAD = 2.0;
// crewLog is drained by the battles every frame; this only guards against a
// battle that never drains it.
const CREW_LOG_CAP = 32;
// What losing the commander costs (this.coord = 1 - COMMAND_LOSS * (1 - his
// seat health)): with nobody calling targets and directing the driver the
// turret traverses and elevates 20% slower, the engine is driven at 80%, and
// repairs go 20% slower; he is also the only one scouting (canScout) and,
// with the radio operator, calling fire in (canCallIn). The reload is
// deliberately NOT on this list: the loader rule is exactly x2 and must not
// compound into x2.5 when the commander is gone too (crew.md S4).
const COMMAND_LOSS = 0.2;

// Blast ladder for bombs (applyExplosion with opts.model === 'bomb'). Distances
// are standoff from the armour; L = (R - 7) * 0.45 is the lethal standoff.
//   kill ramp  certain inside KILL_IN*L, never beyond KILL_OUT*L (÷ toughness)
//   heavy      one heavy module on the face the blast came from; certain inside
//              Mh - HEAVY_RAMP_K*R, never past Mh + HEAVY_RAMP_K*R (just
//              outside M), Mh = L + HEAVY_K*R
//   mobility   whole-crew concussion inside M = L + MOBILITY_K*R; tracks certain
//              inside M, then a ramp centred on M + TRACK_TAIL*(S - M),
//              S = SCRATCH_K*R
//   concussion from M out to the radius itself: the commander's optics and a
//              thinning share of the crew shaken, fading to nothing at R
// Every band edge is a ramp, never a step: the old ladder broke tracks 100% at
// 14 m and 4% at 15 m from a Zero's bomb, and did nothing at all between 0.8R
// and R — inside the visible blast, which is exactly "a near miss does
// nothing" again. The randomness is ±JITTER on the standoff, the ramps and
// the fire.
// The ramps are also wide enough not to stack into a cliff of their own.
// With the kill ramp at 1.0-1.5 L and the heavy one at L + 0.12R ± 0.06R the
// two ended within a metre of each other on the small bombs, and from a Zero's
// bomb a Tiger went from 63% destroyed at 7 m to 20% at 8 m, a Wirbelwind from
// 65% "destroyed or a heavy module gone" at 9.5 m to 15% at 10.5 m. At
// 0.85-1.65 L and L + 0.16R ± 0.12R nothing the bomb does to a tank changes by
// more than ~30 points per metre of miss (bombcurve harness, 1000 trials per
// 0.5 m step: kill 25, kill-or-heavy 29, anything at all 25, was 37/49/37),
// and the 50%-kill standoff is where it was (1.25 L, ÷ toughness).
const BOMB_KILL_IN = 0.85;
const BOMB_KILL_OUT = 1.65;
const BOMB_HEAVY_K = 0.16;
const BOMB_HEAVY_RAMP_K = 0.12;
const BOMB_MOBILITY_K = 0.25;
const BOMB_TRACK_TAIL = 0.35;
const BOMB_SCRATCH_K = 0.8;
const BOMB_RAMP_K = 0.06;
const BOMB_JITTER = 0.06;
const BOMB_FIRE_MAX = 0.3;
const BOMB_HEAVY_BY_ZONE = {
  front: 'transmission', rear: 'engine', side: 'traverse', top: 'engine',
};
const MODULE_EVENT = {
  engine: 'Engine damaged',
  transmission: 'Transmission damaged',
  traverse: 'Turret drive damaged',
  radiator: 'Radiator damaged',
  tracks: 'Track destroyed',
};

// Fires: without an extinguisher the crew beat at it, which takes this long at
// full strength and only works if the vehicle is standing still. It is meant
// to be a losing race — the point of the FPE is that it wins it instantly — and
// at 22 s it was not one: a stationary five-man crew put the fire out for free,
// every time, and never lost a man doing it.
const FIRE_SMOTHER = 25;
// AV-04 rev events (the exhaust puff and the gearbox clunk key off them). The
// auto-box hunts between two gears on a grade, and that is not a fresh cough
// every time: going back to a gear left less than REV_HUNT s ago is no event,
// and no tank coughs more often than every REV_GAP s.
const REV_GAP = 1.5;
const REV_HUNT = 3;
const FIRE_TICK = 3.2;
const FIRE_WOUND = 0.42;
// How much of their own patching-up the crew manage while the vehicle is
// alight. Nearly none: this is the number that decides whether a fire is a race
// or a formality, and at 1 the crew won it every time without spending a thing.
const FIRE_HEAL = 0.45;
// A fitted fire-prevention system is plumbed into the fighting compartment and
// discharges itself: this is the sensor and the plumbing, short enough to beat
// the first flame tick and long enough that the crew feel the fire start.
const FPE_AUTO = 2.4;
// With the system fitted but its bottles spent the crew are still beating the
// fire out by hand — only now with the hand extinguisher out of its bracket
// and lined bulkheads to fight it against, rather than a coat and their gloves.
const FPE_SMOTHER_HELP = 2.2;

// Dispersion, in radians of half-angle. The base is the gun on a still hull
// with a fit gunner; everything else piles on top and bleeds off again.
const BASE_DISPERSION = 0.0012;
const DISP_MOVE = 0.005;
const DISP_SLEW = 0.0024;
const DISP_PITCH = 0.005;
const DISP_SHAKE = 0.0018;
const DISP_SHAKE_DECAY = 0.0028;

// ---------------------------------------------------------------------------
// Blast. These are the numbers that decide whether a bomb feels like a bomb,
// so they are derived rather than picked.
//
// A 250 kg GP bomb carries ~125 kg of TNT equivalent and this game gives it a
// 13 m radius. Read that as the ~1 bar contour (scaled distance Z = R/W^⅓ =
// 13/5.0 = 2.6 m·kg^-⅓, which is where blast stops being dangerous to a closed
// vehicle) and every other number on this list is fixed to something real:
//
//   Z 0.6  = 23% of radius   ~90 bar   plating torn, vehicle thrown
//   Z 1.0  = 38% of radius   ~22 bar   running gear destroyed, thin roofs dished
//   Z 2.0  = 77% of radius   ~3.5 bar  tracks, fittings, crew concussion
//   Z 3.0  = 115% of radius  ~1.2 bar  noise and dust
//
// So the curve has to carry nearly everything in the first third of the radius
// and be nearly spent by the last third: falloff ** 2.2 keeps 61% of contact
// value at a fifth of the radius and 4% at three quarters of it. (Steeper than
// blast alone would give, flatter than blast alone would give at the near end —
// because what beats a roof at five metres is casing fragments, not pressure.)
// The old 1.2 was very nearly an even ramp — it still had 40% of its punch at
// the rim — and it was measured from the middle of the tank, which is what made
// a 250 kg bomb feel like a firecracker two metres off a Tiger's track.
// Exported so the X-ray (ui/xray.js) reads the one number instead of a mirror.
export const BLAST_PEN = 9; // mm of plate beaten per metre of radius, at contact
const BLAST_CURVE = 2.2;
// Outright destruction. A charge has to be big enough to LIFT a vehicle before
// standoff alone kills it, so the band opens at a 7 m radius (a 50 kg bomb) and
// grows from there. Measured from the ARMOUR, that is 2.7 m of standoff for a
// 250 kg bomb, 4.5 m for a 500 kg one, 0.5 m for a rocket, 1.8 m for the
// artillery barrage — and nothing whatever for an HE shell, which matters
// because shell splash runs through this same solver. The old rule killed
// inside 35% of the radius measured from the hull CENTRE, which on a Tiger was
// 1.1 m of standoff and on a Stuart 2.3 m: the bigger the tank the safer it
// was, which is precisely backwards.
const BLAST_LETHAL_R0 = 7;
const BLAST_LETHAL_K = 0.45;
// How much of the front washes over the roof instead of slamming into the plate
// it faces. Wash arrives ACROSS the roof rather than square on to it, so it is
// worth this much of a direct load.
const BLAST_WASH = 0.7;
// Whether the front gets onto the roof at all is a question of how long it
// lasts, not of where it went off. A 250 kg bomb's positive phase runs about
// ten milliseconds — metres of shock front — so it diffracts over the hull and
// reflects off the ground under it, and the vehicle is INSIDE the burst for the
// whole of it. An 85 mm shell's is under a millisecond: it slaps the plate
// facing it and is gone before it has wrapped anywhere. The front's own length
// scale goes as the cube root of the charge, i.e. as the radius, so a quarter
// of the radius against the height it has to climb is a fair reading of it.
// 250 kg bomb and the artillery barrage: engulfed. 100 mm shell: about half.
// 85 mm and below: it never reaches the roof.
const BLAST_FIREBALL = 0.25;
const BLAST_ENGULF_BIAS = 0.5;
// An open-topped vehicle has no roof to beat — only the crew's own screens and
// the gun cradle, which is worth about this much against overhead blast.
const OPEN_TOP_ARMOUR = 6;
// Leftover penetration below which a blast has dished the plate and thrown
// spall off the inside of it rather than opening the vehicle. RESIST.crew is
// 6 mm and RESIST.ammo 10, so under this nothing that came through can cross a
// single module anyway — and applyModuleDamage, which is shared with the shell
// model and is not this function's to rewrite, wrecks an engine it reaches no
// matter how little the fragment had left. Without the floor, a blast that beat
// an open-topped vehicle's nominal roof by two millimetres at eleven metres
// killed its transmission outright.
const BLAST_PIERCE_MIN = 8;

// ---------------------------------------------------------------------------
// burnt-out hulls (V-07 / art bible V-31)
// ---------------------------------------------------------------------------
//
// A wreck used to get `o.material = o.material.clone()` on every mesh. Two
// things went wrong with that. Material.copy() does not carry an instance's
// onBeforeCompile, so the clone lost the triplanar patch from core/materials.js
// and, with no uv attribute on the lofted hull, drew one flat texel. And copy()
// deep-copies userData through JSON, where the triplanar patch keeps the
// compiled shader — uniforms full of Textures — so every kill ran Texture.toJSON
// and PNG-encoded the texture canvases on the frame the tank died.
//
// Now each shared vehicle material has ONE burnt twin, built on first use and
// shared by every wreck that wears it: same maps, same patch, same program
// cache key (so no shader compiles on a kill either), stamped shared so no
// teardown sweep disposes it out from under another hulk.
//
// The tint is aimed at a luminance rather than being one multiplier: ×0.28 on
// everything turned Dunkelgelb (Y .30) into khaki and olive drab (Y .09) into
// near-black, so two nations' wrecks never matched. The painted coat lands
// between soot (Y .02-.04) and rust (Y .06-.12) with a warm cast; bare steel and
// track, already dark, oxidise a little further; flat fittings go to soot.
const WRECK_COAT_Y = 0.045;
const WRECK_FLAT_Y = 0.03;
const WRECK_METAL = 0.55;
const WRECK_COAT_HUE = [1.25, 0.95, 0.75]; // rust-soot, unit luminance
const WRECK_METAL_HUE = [1.1, 0.98, 0.88];
const WRECK_ROUGH = 0.9;  // burnt paint and scale are matte
const WRECK_METALNESS = 0.5;
const SHARED_MARK = Symbol.for('steelSkies.sharedResource'); // core/materials.js
const wreckMats = new WeakMap();

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

// relative luminance of an sRGB hex colour (the paint as specified)
function hexLuminance(hex) {
  const r = srgbToLinear(((hex >> 16) & 255) / 255);
  const g = srgbToLinear(((hex >> 8) & 255) / 255);
  const b = srgbToLinear((hex & 255) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// The burnt twin of one shared material. `coatY` is the luminance of the paint
// the owning tank was built in; only the painted coat (the factory's armour
// material — the one with a roughness map) is normalised by it.
function wreckMaterial(src, coatY) {
  let w = wreckMats.get(src);
  if (w) return w;
  w = new src.constructor();
  // Everything but userData: that is where the triplanar patch parks its
  // compiled shader, and JSON-copying it is the Texture.toJSON this replaces.
  const ud = src.userData;
  src.userData = {};
  try {
    w.copy(src);
  } finally {
    src.userData = ud;
  }
  w.name = src.name ? `${src.name} (wreck)` : 'wreck';
  w.userData = { shared: true, wreckOf: src.uuid };
  w[SHARED_MARK] = true;

  const own = (k) => Object.prototype.hasOwnProperty.call(src, k);
  if (own('onBeforeCompile')) {
    const patch = src.onBeforeCompile;
    w.onBeforeCompile = function wreckPatch(shader, renderer) {
      // the factory's patch records its shader on the material it was written
      // for; keep that record pointing at the live material, not at us
      const had = Object.prototype.hasOwnProperty.call(src.userData, 'shader');
      const keep = src.userData.shader;
      patch.call(this, shader, renderer);
      if (had) src.userData.shader = keep;
      else delete src.userData.shader;
    };
  }
  if (own('customProgramCacheKey')) w.customProgramCacheKey = src.customProgramCacheKey;

  if (w.color) {
    const c = w.color;
    if (w.map && w.roughnessMap) {
      // the painted coat: the albedo is in the map, the colour multiplies it
      const m = clamp(WRECK_COAT_Y / Math.max(1e-3, coatY), 0.1, 0.6);
      c.setRGB(c.r * m * WRECK_COAT_HUE[0], c.g * m * WRECK_COAT_HUE[1], c.b * m * WRECK_COAT_HUE[2]);
    } else if (w.map) {
      // bare steel, gear and track: dark already
      const m = WRECK_METAL;
      c.setRGB(c.r * m * WRECK_METAL_HUE[0], c.g * m * WRECK_METAL_HUE[1], c.b * m * WRECK_METAL_HUE[2]);
    } else {
      // untextured stowage, canvas and the team stripe: soot
      const y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      c.multiplyScalar(clamp(WRECK_FLAT_Y / Math.max(1e-3, y), 0.05, 1));
    }
  }
  if (w.isMeshStandardMaterial) {
    w.roughness = Math.max(w.roughness, WRECK_ROUGH);
    w.metalness *= WRECK_METALNESS;
  }
  wreckMats.set(src, w);
  return w;
}

let nextId = 1;

export class Tank {
  constructor(scene, spec, team, displayName, isPlayer = false) {
    this.id = nextId++;
    this.scene = scene;
    this.spec = spec;
    this.team = team; // 0 allies, 1 enemies
    this.displayName = displayName;
    this.isPlayer = isPlayer;

    const paint = isPlayer ? 0x8a9464 : null;
    const built = buildTankMesh(
      spec,
      paint,
      team === 0 ? 0x4f8fd0 : 0xd05f4f,
    );
    // the coat the hull was painted in, which destroy() burns down to a
    // common hulk tone whatever nation it started as. buildTankMesh reports
    // the coat it actually applied: the player's tint is refused when it is
    // out of the nation's band, and taking the asked-for 0x8a9464 here made
    // the first wreck of the player's type ~3x too dark for the session.
    this.paintHex = built.paintHex ?? paint ?? spec.color;
    // the per-spec geometry cache's buffers, which dispose() must leave alone
    this.builderGeos = new Set();
    built.group.traverse((o) => { if (o.geometry) this.builderGeos.add(o.geometry); });
    this.isTank = true;
    this.bound = PLAY_BOUND; // battles on bigger maps override this
    this.group = built.group;
    this.turretGroup = built.turretGroup;
    this.gunGroup = built.gunGroup;
    this.muzzle = built.muzzle;
    this.hullBox = built.hullBox;
    this.turretBox = built.turretBox;
    // moving tracks and wheels: metres each side has run (left = +X), wrapped
    // at runningGear.wrap. The belt stops on a broken track; the wheels
    // follow the ground whatever the belt is doing. A wreck stops both.
    this.runningGear = built.runningGear || null;
    this.beltRunL = 0;
    this.beltRunR = 0;
    this.wheelRunL = 0;
    this.wheelRunR = 0;
    scene.add(this.group);

    this.yaw = 0;
    this.speed = 0;
    this.throttleInput = 0;
    this.steerInput = 0;

    // ---- drivetrain ----
    this.gearbox = gearboxFor(spec);
    this.gearIndex = 0;      // index inside the current gear set
    this.gearDir = 0;        // 1 forward, -1 reverse, 0 neutral
    this.gear = 0;           // signed gear number for the HUD
    this.gearName = 'N';
    this.rpm = 0;            // 0..1, for the HUD needle and the engine note
    this.shiftTimer = 0;     // torque is cut while this runs
    this.surface = 'firm';   // battles set this from the map preset
    this.slope = 0;          // terrain grade under the hull, + = nose up
    this.stalled = false;    // the climb beat the engine
    this.engineHeat = 0;     // rises with a wrecked radiator
    this.yawDelta = 0;
    this.accelNow = 0;

    // ---- suspension ----
    this.susp = suspensionFor(spec);
    this.hullPitch = 0;
    this.hullRoll = 0;
    this.pitchVel = 0;
    this.rollVel = 0;
    this.hullPitchDelta = 0;
    this.hullPitchRate = 0;
    this.suspSeated = false;

    this.turretYaw = 0; // relative to hull
    this.gunPitch = 0;
    this.turretRate = 0;
    this.aimPoint = new THREE.Vector3(0, 0, 100);
    // sniper optics: no gravity auto-compensation, use the scope marks
    this.manualAim = false;

    this.alive = true;
    this.reload = 1.5;
    this.reloadTotal = spec.reload;
    this.reloadFrac = 1;
    this.shellType = 'AP';
    this.ammo = {};
    for (const k of Object.keys(spec.shells)) this.ammo[k] = spec.shells[k].count;
    // stream weapon: SPAA autocannon (LMB) or coax MG (Space)
    this.streamAmmo = spec.aa ? spec.aa.ammo : spec.mg ? spec.mg.ammo : 0;
    this.streamTimer = 0;
    this.streamSound = 0;

    // ---- gun laying ----
    this.dispersion = spec.dispersion ?? BASE_DISPERSION;
    this.shake = 0;
    this.recoilZ = 0;
    this.recoilVel = 0;

    // ---- crew ----
    // Every station carries its own 0..1 health, so a fragment can leave a man
    // working at half speed instead of the all-or-nothing count the vehicle
    // used to keep. Stations this vehicle does not crew stay at 1: their duty
    // is folded into somebody else's seat rather than simply missing.
    this.crewStations = crewRoles(spec);
    this.crewAlive = { driver: 1, gunner: 1, loader: 1, commander: 1, radio: 1 };
    this.crew = this.crewStations.length; // NUMBER of survivors — the HUD reads it
    this.crewFrac = 1;
    // Seat swaps under way: { from, to, progress 0..1 }, at most one per seat
    // either way. The man stays in his own seat's box until he arrives — he
    // still counts, can still be hit and still heals there — but his own seat
    // stops working the moment he gets up.
    this.crewSwaps = [];
    // Events for the battles to drain (never put these in hit result events:
    // any event string with "crew" in it pays crew-kill score):
    //   { type: 'killed', role } | { type: 'swapStart', from, to, seconds }
    //   { type: 'swapDone', from, to } | { type: 'revived', role }
    this.crewLog = [];
    // READ-ONLY mirror, recomputed every frame: seconds left on the swap into
    // the empty driver's seat, 0 when the seat is manned or nobody is coming.
    this.handover = 0;
    this.coord = 1;
    this.driveEff = 1;
    this.canDrive = true;
    this.canScout = true;
    this.canCallIn = true;
    this.effTraverse = spec.traverse;
    this.effPitchSpeed = spec.pitchSpeed || 1.4;
    this.effReload = spec.reload;
    // what the crew can get out of the drivetrain, for readouts and the engine
    // note. drive() applies driveEff and coord itself, so this is never the
    // number the physics reads — take it as a display value only.
    this.effMaxSpeed = spec.maxSpeed;

    // modules: 1 = ok, 0 = broken (the crew have to put it right).
    // `repair` is the work in seconds at full crew with a kit to hand,
    // `timer` is the live estimate the status panel prints.
    // repairFactor comes from the Repair Kit modification.
    const rf = spec.repairFactor || 1;
    const mod = (key) => ({ ok: true, timer: 0, repair: MODULE_REPAIR[key] * rf });
    this.modules = {
      engine: mod('engine'),
      transmission: mod('transmission'),
      tracks: mod('tracks'),
      breech: mod('breech'),
      barrel: mod('barrel'),
      traverse: mod('traverse'),
      elevation: mod('elevation'),
      radiator: mod('radiator'),
      ammoRack: { ok: true, timer: 0, repair: 0 }, // damaged flag only
    };

    // ---- repair and consumables ----
    const cons = spec.consumables || {};
    this.consumables = {
      repair: cons.repair ?? 2,
      fpe: cons.fpe ?? 1,
      firstAid: cons.firstAid ?? 1,
      smoke: cons.smoke ?? 1,
    };
    this.repairing = false;
    this.repairTarget = null;
    this.repairFrac = 0;
    this.repairInterrupt = null;
    // left on so a battle that has not been taught the repair key still sees
    // its crews put their own tracks back on, exactly as they always did
    this.autoRepair = true;

    this.burning = false;
    this.burnTimer = 0;
    this.burnTick = 0;
    this.fireSmother = 0;
    // seconds left before an automatic FPE lets go; 0 on a vehicle without one
    this.fpeDelay = 0;

    this.lastAttacker = null;
    this.wreckTurretVel = null;
    this.radius = Math.max(spec.hull.len, spec.hull.w) * 0.55;
    this.recomputeCrew();
  }

  get position() {
    return this.group.position;
  }

  setPose(x, z, yaw) {
    this.yaw = yaw;
    this.group.position.set(x, terrainHeight(x, z), z);
    this.suspSeated = false;
    this.updateOrientation();
  }

  // The hull no longer snaps to the ground normal: it sits on a sprung
  // attitude that lags the terrain, squats under power and rocks when the gun
  // goes off. Callers see the same thing they always did — the group ends up
  // oriented — so nothing outside had to change.
  updateOrientation() {
    if (!this.suspSeated) this.seatSuspension();
    tmpEuler.set(this.hullPitch, this.yaw, this.hullRoll, 'YXZ');
    this.group.quaternion.setFromEuler(tmpEuler);
  }

  // Drop the springs straight onto the ground plane, with no travel left in
  // them. Used when a vehicle is placed rather than driven there.
  seatSuspension() {
    const g = this.sampleGround();
    this.hullPitch = g.pitch;
    this.hullRoll = g.roll;
    this.slope = g.slope;
    this.pitchVel = 0;
    this.rollVel = 0;
    this.suspSeated = true;
  }

  // Terrain under the four contact patches, resolved into the attitude the
  // tracks imply. One sampler for both the spring and the initial seating, so
  // a tank that is placed on a hill sits the way it would if it had driven up.
  sampleGround() {
    const p = this.group.position;
    const spec = this.spec;
    const halfL = spec.hull.len * 0.42;
    const halfW = spec.hull.w * 0.42;
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    const fx = s * halfL;
    const fz = c * halfL;
    const rx = c * halfW;
    const rz = -s * halfW;

    const hFL = terrainHeight(p.x + fx - rx, p.z + fz - rz);
    const hFR = terrainHeight(p.x + fx + rx, p.z + fz + rz);
    const hRL = terrainHeight(p.x - fx - rx, p.z - fz - rz);
    const hRR = terrainHeight(p.x - fx + rx, p.z - fz + rz);
    const front = (hFL + hFR) * 0.5;
    const rear = (hRL + hRR) * 0.5;
    const left = (hFL + hRL) * 0.5;
    const right = (hFR + hRR) * 0.5;

    // positive pitch puts the nose down, so a climb reads negative
    groundSample.pitch = Math.atan2(rear - front, halfL * 2);
    groundSample.roll = Math.atan2(right - left, halfW * 2);
    groundSample.slope = -groundSample.pitch;
    return groundSample;
  }

  forwardDir(out = new THREE.Vector3()) {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  gunDirection(out = new THREE.Vector3()) {
    out.set(0, 0, 1);
    this.gunGroup.updateWorldMatrix(true, false);
    return out.transformDirection(this.gunGroup.matrixWorld);
  }

  muzzleWorld(out = new THREE.Vector3()) {
    this.muzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.muzzle.matrixWorld);
  }

  turretWorldPos(out = new THREE.Vector3()) {
    this.turretGroup.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.turretGroup.matrixWorld);
  }

  // Where the exhaust leaves the hull: the rear plate, just over the fenders
  // (tanks.js exhaust() hangs every chassis's pipes there). World space.
  exhaustWorld(out = new THREE.Vector3()) {
    const h = this.spec.hull || {};
    const len = h.len || 5;
    const y = (h.trackH || 0.95) + 0.25;
    out.set(0, y, -len / 2 - 0.15);
    this.group.updateWorldMatrix(true, false);
    return out.applyMatrix4(this.group.matrixWorld);
  }

  // 'diesel' | 'petrol'. A spec may say so outright (spec.engine); otherwise
  // the roster's Soviet chassis run the V-2 diesel and everything else a
  // petrol engine (Continental, Maybach, Ford GAF).
  get engineKind() {
    const e = this.spec.engine;
    if (e === 'diesel' || e === 'petrol') return e;
    return this.spec.nation === 'USSR' ? 'diesel' : 'petrol';
  }

  // The running gear as the ground sees it (X-07 track prints): track width,
  // and gauge = centre-to-centre of the two tracks (tanks.js lays each run at
  // x = +-(hull.w / 2 - trackW / 2)).
  get trackWidth() {
    return (this.spec.chassis && this.spec.chassis.trackW) || 0.45;
  }

  get trackGauge() {
    const w = (this.spec.hull && this.spec.hull.w) || 3;
    return Math.max(0.5, w - this.trackWidth);
  }

  // Launch solution to hit `point` with the selected shell: gravity-
  // compensated launch direction in WORLD space, converted into the hull's
  // local frame. The hull tilts with the terrain, so applying world angles
  // directly to the turret made the gun point wrong on any slope.
  // ballistic=false aims straight along the line of sight (sniper optics —
  // the player holds over using the scope's range marks).
  aimSolution(point, ballistic = true) {
    const tp = this.turretWorldPos(tmpV);
    const dx = point.x - tp.x;
    const dy = point.y - tp.y;
    const dz = point.z - tp.z;
    const horiz = Math.max(0.001, Math.hypot(dx, dz));
    const v = this.spec.shells[this.shellType].speed;
    const g = 9.8;
    const v2 = v * v;
    const disc = v2 * v2 - g * (g * horiz * horiz + 2 * dy * v2);
    const launch =
      ballistic && disc > 0
        ? Math.atan((v2 - Math.sqrt(disc)) / (g * horiz))
        : Math.atan2(dy, horiz);
    const yawW = Math.atan2(dx, dz);
    const cosL = Math.cos(launch);
    tmpDir.set(Math.sin(yawW) * cosL, Math.sin(launch), Math.cos(yawW) * cosL);
    tmpQ2.copy(this.group.quaternion).invert();
    tmpDir.applyQuaternion(tmpQ2);
    const yawLocal = Math.atan2(tmpDir.x, tmpDir.z);
    const pitchLocal = Math.atan2(
      tmpDir.y,
      Math.max(0.001, Math.hypot(tmpDir.x, tmpDir.z)),
    );
    const elev = this.spec.gunElev || DEFAULT_ELEV;
    return { yawLocal, pitch: clamp(pitchLocal, elev.min, elev.max) };
  }

  isAimedAt(point, tol = 0.015) {
    const sol = this.aimSolution(point);
    return (
      Math.abs(wrapAngle(sol.yawLocal - this.turretYaw)) < tol &&
      Math.abs(sol.pitch - this.gunPitch) < tol
    );
  }

  // `surface` names the ground the vehicle is standing on (the map preset keys
  // work directly). Left out, it falls back to whatever this.surface says, and
  // that defaults to firm going — so update(dt) behaves as it always has.
  update(dt, surface = null) {
    // AV-04: a rev event lasts exactly the frame it happened on
    this.revKick = null;
    if (!this.alive) {
      this.updateWreck(dt);
      return;
    }
    const surf = surfaceProps(surface || this.surface);

    this.updateCrew(dt);
    this.recomputeCrew();
    this.updateRepair(dt);
    this.updateFire(dt);
    if (!this.alive) return;

    const runX = this.group.position.x;
    const runZ = this.group.position.z;
    this.drive(dt, surf);
    this.runTracks(runX, runZ);
    this.updateSuspension(dt);
    this.updateOrientation();
    this.updateTurret(dt);
    this.updateDispersion(dt);
    this.updateRecoil(dt);

    if (this.reload > 0) this.reload -= dt;
    this.reloadFrac =
      this.reloadTotal > 0 ? clamp(1 - this.reload / this.reloadTotal, 0, 1) : 1;
  }

  // ---------------------------------------------------------------------
  // crew
  // ---------------------------------------------------------------------

  // Everything the rest of the game reads about how well this vehicle is being
  // worked. Cheap enough to run every frame, which keeps the effective values
  // honest without anyone having to remember to invalidate them.
  recomputeCrew() {
    const spec = this.spec;
    const st = this.crewStations;
    let alive = 0;
    let sum = 0;
    for (let i = 0; i < st.length; i++) {
      const h = this.crewAlive[st[i]];
      if (h > 0) alive++;
      sum += h;
    }
    this.crew = alive;
    this.crewFrac = st.length ? sum / st.length : 0;

    // The commander is the man who tells everyone else what is happening. With
    // him gone the crew are each doing their own job with no picture at all
    // (COMMAND_LOSS: turret drives, engine and repairs at 80%, reload untouched).
    // A man climbing out of the commander's seat is not commanding anybody.
    this.coord = 1 - COMMAND_LOSS * (1 - this.seatHealth('commander'));

    // Gunner's seat empty: nobody is laying the gun at all. The turret stays
    // where it was left and the gun cannot fire (canFire / canFireStream).
    const traverseOk = this.modules.traverse.ok;
    const elevOk = this.modules.elevation.ok;
    if (this.staffed('gunner')) {
      const g = this.crewAlive.gunner;
      this.effTraverse = spec.traverse * (0.55 + 0.45 * g) * this.coord * (traverseOk ? 1 : 0);
      this.effPitchSpeed =
        (spec.pitchSpeed || 1.4) * (0.6 + 0.4 * g) * this.coord * (elevOk ? 1 : 0.15);
    } else {
      this.effTraverse = 0;
      this.effPitchSpeed = 0;
    }

    // Loader's seat empty: somebody else is wrestling rounds out of the racks
    // one handed, and the gun falls silent for exactly twice as long between
    // shots — not compounded by anything else. A reload already running is
    // stretched (or shrunk back) with it rather than finishing at the old pace.
    const load = this.staffed('loader')
      ? 1 / (0.55 + 0.45 * this.crewAlive.loader)
      : LOADER_EMPTY_RELOAD;
    const eff = spec.reload * load;
    if (this.effReload > 0 && this.reload > 0 && eff !== this.effReload) {
      const k = eff / this.effReload;
      this.reload *= k;
      this.reloadTotal *= k;
    }
    this.effReload = eff;

    // Driver's seat empty: the vehicle cannot move until somebody is in it.
    this.canDrive = this.alive && this.staffed('driver');
    this.driveEff = this.canDrive ? 0.62 + 0.38 * this.crewAlive.driver : 0;
    const inbound = this.canDrive ? null : this.swapTo('driver');
    this.handover = inbound ? this.swapSecondsLeft(inbound) : 0;
    this.effMaxSpeed = spec.maxSpeed * this.driveEff * this.coord;

    // The commander is also the only man with his head out of the vehicle, and
    // the radio operator is the only one who can get a call out.
    this.canScout = this.seatHealth('commander') > 0.35;
    this.canCallIn = this.seatHealth('radio') > 0.35 && this.seatHealth('commander') > 0;
  }

  updateCrew(dt) {
    // Wounded men patch themselves up between shots, but never all the way
    // back — that takes the first aid kit. Almost nobody patches anybody up
    // inside a burning tank: at the full rate the crew simply outhealed a fire
    // and rode it out with the extinguisher still in its bracket.
    const replenish = this.spec.crewReplenish ? CREW_REPLENISH_HEAL : 1;
    const heal = CREW_SELF_HEAL_RATE * replenish * (this.burning ? FIRE_HEAL : 1);
    for (let i = 0; i < this.crewStations.length; i++) {
      const role = this.crewStations[i];
      const h = this.crewAlive[role];
      if (h > 0 && h < CREW_SELF_HEAL_CAP) {
        this.crewAlive[role] = Math.min(CREW_SELF_HEAL_CAP, h + dt * heal);
      }
    }

    // Seat swaps: start any that are owed, move the men already climbing, and
    // on arrival open the next link of a chain on the same frame.
    this.planSwaps();
    const sw = this.crewSwaps;
    let done = false;
    for (let i = 0; i < sw.length; i++) {
      const s = sw[i];
      s.progress += dt / this.swapDuration(this.crewAlive[s.from]);
      if (s.progress >= 1) {
        // he carries his wound with him
        this.crewAlive[s.to] = this.crewAlive[s.from];
        this.crewAlive[s.from] = 0;
        sw.splice(i, 1);
        i--;
        this.logCrew({ type: 'swapDone', from: s.from, to: s.to });
        done = true;
      }
    }
    if (done) this.planSwaps();
  }

  hasStation(role) {
    return this.crewStations.indexOf(role) >= 0;
  }

  // The swap leaving `seat`, or null. Loops rather than allocating: this runs
  // several times a frame.
  swapFrom(seat) {
    const sw = this.crewSwaps;
    for (let i = 0; i < sw.length; i++) if (sw[i].from === seat) return sw[i];
    return null;
  }

  // The swap heading into `seat`, or null.
  swapTo(seat) {
    const sw = this.crewSwaps;
    for (let i = 0; i < sw.length; i++) if (sw[i].to === seat) return sw[i];
    return null;
  }

  // Contract C1: a living man is actually sitting in this seat — not dead, and
  // not half way out of it to fill another. A seat this vehicle does not have
  // (the radio operator on a Stuart) has its duty folded into another man's
  // and reads as staffed, exactly as it always did.
  staffed(role) {
    if (!this.hasStation(role)) return true;
    return this.crewAlive[role] > 0 && !this.swapFrom(role);
  }

  // Health of the man WORKING this seat: 0 while it is empty or he is leaving.
  seatHealth(role) {
    if (!this.hasStation(role)) return this.crewAlive[role];
    return this.staffed(role) ? this.crewAlive[role] : 0;
  }

  // Seconds a man of health `h` takes to change seats from a standing start.
  swapDuration(h) {
    return CREW_SWAP_TIME * (1 + CREW_SWAP_WOUND_SLOW * (1 - clamp(h, 0, 1)));
  }

  swapSecondsLeft(s) {
    return Math.max(0, (1 - s.progress) * this.swapDuration(this.crewAlive[s.from]));
  }

  logCrew(ev) {
    if (!Array.isArray(this.crewLog)) this.crewLog = [];
    const log = this.crewLog;
    log.push(ev);
    if (log.length > CREW_LOG_CAP) log.splice(0, log.length - CREW_LOG_CAP);
  }

  // Drop swaps that no longer make sense (the man climbing died, or the seat
  // he was heading for got its own man back), then send the least important
  // free man sitting BELOW each empty seat into it, most important seat first.
  // Never sideways or down; never a man already on the move; a swap under way
  // is not redirected when a more important seat empties later.
  planSwaps() {
    const sw = this.crewSwaps;
    if (!this.alive) {
      sw.length = 0;
      return;
    }
    for (let i = sw.length - 1; i >= 0; i--) {
      const s = sw[i];
      if (this.crewAlive[s.from] <= 0 || this.crewAlive[s.to] > 0) sw.splice(i, 1);
    }
    const n = SEATS_BY_IMPORTANCE.length;
    for (let t = 0; t < n; t++) {
      const target = SEATS_BY_IMPORTANCE[t];
      if (!this.hasStation(target) || this.crewAlive[target] > 0 || this.swapTo(target)) continue;
      // least important first; everything after index t ranks below the target
      for (let k = n - 1; k > t; k--) {
        const r = SEATS_BY_IMPORTANCE[k];
        if (CREW_IMPORTANCE[r] >= CREW_IMPORTANCE[target]) break;
        if (!this.hasStation(r) || this.crewAlive[r] <= 0 || this.swapFrom(r)) continue;
        const swap = { from: r, to: target, progress: 0 };
        sw.push(swap);
        this.logCrew({
          type: 'swapStart', from: r, to: target, seconds: this.swapSecondsLeft(swap),
        });
        break;
      }
    }
  }

  // Contract C1: one row per crew station for the damage panel.
  // labels = { driver: 'Driver', ... }; missing labels fall back to the key.
  crewPanelRows(labels = null) {
    const rows = [];
    const st = this.crewStations;
    const lab = (r) => (labels && labels[r] != null ? labels[r] : r);
    for (let i = 0; i < st.length; i++) {
      const key = st[i];
      const h = clamp(this.crewAlive[key] || 0, 0, 1);
      const row = {
        role: lab(key),
        key,
        state: h > 0.7 ? 'ok' : h > 0 ? 'damaged' : 'destroyed',
        health: h,
      };
      const inbound = this.swapTo(key);
      const outbound = inbound ? null : this.swapFrom(key);
      if (inbound) {
        const secs = Math.ceil(this.swapSecondsLeft(inbound));
        row.state = 'moving';
        row.swapFrac = clamp(inbound.progress, 0, 1);
        row.swapSeconds = secs;
        row.swapFrom = inbound.from;
        row.text = `${secs}s`;
      } else if (outbound) {
        const letter = String(lab(outbound.to)).charAt(0).toUpperCase();
        row.state = 'leaving';
        row.swapFrac = clamp(outbound.progress, 0, 1);
        row.swapSeconds = Math.ceil(this.swapSecondsLeft(outbound));
        row.swapTo = outbound.to;
        row.text = `→${letter}`;
      }
      rows.push(row);
    }
    return rows;
  }

  // Knock a station down by `amount` of its 0..1 health. Returns 'killed',
  // 'wounded' or null if the seat was already empty.
  hurtCrew(role, amount) {
    if (!this.hasStation(role)) return null;
    const h = this.crewAlive[role];
    if (h <= 0) return null;
    const left = h - amount;
    if (left <= 0.02) {
      this.killCrew(role);
      return 'killed';
    }
    this.crewAlive[role] = left;
    this.recomputeCrew();
    return 'wounded';
  }

  killCrew(role) {
    if (!this.hasStation(role) || this.crewAlive[role] <= 0) return false;
    this.crewAlive[role] = 0;
    this.logCrew({ type: 'killed', role });
    this.recomputeCrew();
    // fewer than two men left: the vehicle is lost (wounded men still count)
    if (this.crew <= 1) {
      this.destroy(false);
      return true;
    }
    // cancels his own outgoing swap and sends somebody for his seat
    this.planSwaps();
    this.recomputeCrew();
    return true;
  }

  // Kept for everything that still thinks of the crew as a count: knocks out
  // `n` men picked at random from whoever is still working.
  loseCrew(n) {
    for (let i = 0; i < n; i++) {
      let pool = 0;
      for (const role of this.crewStations) if (this.crewAlive[role] > 0) pool++;
      if (pool === 0) break;
      let pick = Math.floor(Math.random() * pool);
      for (const role of this.crewStations) {
        if (this.crewAlive[role] <= 0) continue;
        if (pick-- === 0) {
          this.killCrew(role);
          break;
        }
      }
      if (!this.alive) return;
    }
    this.recomputeCrew();
    if (this.crew <= 1) this.destroy(false);
  }

  // ---------------------------------------------------------------------
  // repair and consumables
  // ---------------------------------------------------------------------

  // How fast the crew work, as a multiple of the nominal single-module time.
  // More hands finish sooner; without a kit they are improvising with what is
  // stowed on the hull and it shows.
  repairRate() {
    if (!this.alive) return 0;
    // a man climbing between seats is not holding a spanner
    const hands =
      Math.max(0, this.crew - this.crewSwaps.length) / Math.max(1, this.crewStations.length);
    const kit = this.consumables.repair > 0 ? 1 : 0.45;
    return (0.4 + 0.6 * hands) * kit * this.coord;
  }

  repairEstimate(key) {
    const m = this.modules[key];
    if (!m || !m.repair) return 0;
    const rate = this.repairRate();
    return rate > 0.02 ? Math.min(999, m.repair / rate) : 999;
  }

  // Most critical broken module, in the order the crew would actually get to
  // them. Pass a key to insist on one instead.
  startRepair(key = null) {
    if (!this.alive) return false;
    let target = null;
    if (key && this.modules[key] && !this.modules[key].ok && this.modules[key].repair) {
      target = key;
    } else {
      for (const k of REPAIRABLE) {
        if (this.modules[k] && !this.modules[k].ok) {
          target = k;
          break;
        }
      }
    }
    if (!target) return false;
    if (this.repairing && this.repairTarget === target) return true;
    this.repairing = true;
    this.repairTarget = target;
    this.repairFrac = 0;
    this.repairInterrupt = null;
    return true;
  }

  cancelRepair(reason = 'stopped') {
    if (!this.repairing) return;
    this.repairing = false;
    this.repairTarget = null;
    this.repairFrac = 0;
    this.repairInterrupt = reason;
  }

  updateRepair(dt) {
    // idle crews get on with it themselves unless the battle has taken the job
    // over and is driving startRepair from a key
    if (!this.repairing && this.autoRepair && Math.abs(this.speed) < 0.6) {
      this.startRepair();
    }

    const m = this.repairing ? this.modules[this.repairTarget] : null;
    if (!m) {
      this.repairing = false;
      this.repairTarget = null;
      return;
    }
    if (m.ok) {
      this.cancelRepair('done');
      return;
    }
    // you cannot swing a track bar from inside a moving tank
    if (Math.abs(this.speed) > 0.6) {
      this.cancelRepair('moving');
      return;
    }
    const rate = this.repairRate();
    if (rate <= 0.02) return;
    this.repairFrac += (dt * rate) / Math.max(0.5, m.repair);
    m.timer = Math.max(0, (m.repair * (1 - this.repairFrac)) / rate);
    if (this.repairFrac >= 1) {
      m.ok = true;
      m.timer = 0;
      if (this.consumables.repair > 0) this.consumables.repair--;
      this.repairing = false;
      this.repairTarget = null;
      this.repairFrac = 0;
    }
  }

  // Fires used to put themselves out after nine seconds, which meant they
  // never really mattered. Now they burn until something stops them.
  useExtinguisher() {
    if (!this.alive || !this.burning || this.consumables.fpe <= 0) return false;
    this.consumables.fpe--;
    this.burning = false;
    this.burnTimer = 0;
    this.fireSmother = 0;
    this.fpeDelay = 0;
    return true;
  }

  // Patches up the worst wounded man; failing that, drags a knocked-out one
  // back into the most important EMPTY seat in no state to do much (which
  // also calls off anybody who was on his way to fill that seat).
  useFirstAid() {
    if (!this.alive || this.consumables.firstAid <= 0) return null;
    let worst = null;
    let worstH = 1;
    for (const role of this.crewStations) {
      const h = this.crewAlive[role];
      if (h > 0 && h < worstH) {
        worstH = h;
        worst = role;
      }
    }
    if (worst) {
      this.consumables.firstAid--;
      this.crewAlive[worst] = 1;
      this.recomputeCrew();
      return worst;
    }
    if (this.crew < this.crewStations.length) {
      for (let i = 0; i < SEATS_BY_IMPORTANCE.length; i++) {
        const seat = SEATS_BY_IMPORTANCE[i];
        if (!this.hasStation(seat) || this.crewAlive[seat] > 0) continue;
        this.consumables.firstAid--;
        this.crewAlive[seat] = 0.45;
        this.logCrew({ type: 'revived', role: seat });
        this.planSwaps();
        this.recomputeCrew();
        return seat;
      }
    }
    return null;
  }

  // Returns what the battle needs to spawn the screen, or null with nothing
  // spent. Launchers throw the pots out in front and short, which is what
  // makes smoke a thing you break contact behind rather than sit inside.
  deploySmoke() {
    if (!this.alive || this.consumables.smoke <= 0) return null;
    this.consumables.smoke--;
    const f = this.forwardDir(new THREE.Vector3());
    const pos = this.position.clone().addScaledVector(f, 14);
    pos.y = terrainHeight(pos.x, pos.z) + 1.2;
    return { pos, radius: 12, duration: 22, source: this };
  }

  updateFire(dt) {
    if (!this.burning) return;

    // An automatic system does not wait to be asked. This is the half of the
    // FPE modification the spare bottle cannot buy: the fire is out before
    // anybody has found the key, and it costs a charge exactly as a pulled one
    // would — which is why the module hands over two of them.
    if (this.fpeDelay > 0) {
      this.fpeDelay -= dt;
      if (this.fpeDelay <= 0) {
        this.fpeDelay = 0;
        if (this.useExtinguisher()) return;
      }
    }

    // How hard the fire works on the crew. The vehicle that carries the system
    // is also the one with the lined bulkheads behind it, so a fire that does
    // take hold reaches the men far more slowly.
    const burn = this.spec.burnFactor || 1;
    this.burnTick -= dt;
    if (this.burnTick <= 0) {
      this.burnTick = FIRE_TICK / burn;
      // smoke and heat before flame: the crew are hurt long before they are
      // killed, which leaves a window to do something about it
      let pool = 0;
      for (const role of this.crewStations) if (this.crewAlive[role] > 0) pool++;
      if (pool > 0) {
        let pick = Math.floor(Math.random() * pool);
        for (const role of this.crewStations) {
          if (this.crewAlive[role] <= 0) continue;
          if (pick-- === 0) {
            this.hurtCrew(role, FIRE_WOUND);
            break;
          }
        }
      }
      if (!this.alive) return;
      // the flames work on the powerpack too
      if (this.modules.engine.ok && Math.random() < 0.22) this.breakModule('engine');
    }

    // Beating a fire out by hand only works if the vehicle is standing still,
    // and even then it is a long job with a full crew — the exception being a
    // vehicle whose bottles are spent but whose fittings are still there, where
    // the crew have something to fight it with instead of their gloves.
    const help = this.spec.fireExtinguisher ? FPE_SMOTHER_HELP : 1;
    const rate = (Math.abs(this.speed) < 1.2 ? 1 : 0.22) * this.crewFrac * help;
    if (rate > 0.02) {
      this.fireSmother += (dt / FIRE_SMOTHER) * rate;
      this.burnTimer = Math.min(999, ((1 - this.fireSmother) * FIRE_SMOTHER) / rate);
      if (this.fireSmother >= 1) {
        this.burning = false;
        this.burnTimer = 0;
        this.fireSmother = 0;
      }
    }
  }

  // ---------------------------------------------------------------------
  // drivetrain
  // ---------------------------------------------------------------------
  drive(dt, surf) {
    const spec = this.spec;
    const gb = this.gearbox;
    const tracksOk = this.modules.tracks.ok;

    // a dead engine leaves you crawling; a wrecked final drive costs the top
    // gears and most of the steering authority; a holed radiator lets the
    // powerpack cook itself over the next minute of driving
    const throttle = tracksOk && this.canDrive ? clamp(this.throttleInput, -1, 1) : 0;
    if (!this.modules.radiator.ok) {
      this.engineHeat = Math.min(1, this.engineHeat + dt * 0.045 * (0.3 + Math.abs(throttle)));
    } else if (this.engineHeat > 0) {
      this.engineHeat = Math.max(0, this.engineHeat - dt * 0.09);
    }
    const engineFactor =
      (this.modules.engine.ok ? 1 : 0.25) *
      (this.modules.transmission.ok ? 1 : 0.4) *
      (1 - 0.45 * this.engineHeat);
    const power = engineFactor * this.driveEff * this.coord;

    const maxF = spec.maxSpeed;
    const maxR = spec.maxReverse ?? spec.maxSpeed * 0.32;
    const sp = Math.abs(this.speed);

    // Direction: asking for the other way while still rolling means braking
    // first, because there is no torque converter to slur through it.
    const wantDir = throttle > 0.05 ? 1 : throttle < -0.05 ? -1 : 0;
    const rolling = sp > 0.4 ? Math.sign(this.speed) : 0;
    const reversing = wantDir !== 0 && rolling !== 0 && wantDir !== rolling;
    if (wantDir !== 0 && !reversing) {
      const wanted = wantDir > 0 ? gb.forward : gb.reverse;
      if (this.gearDir !== wantDir) {
        this.gearDir = wantDir;
        this.gearIndex = 0;
        this.shiftTimer = gb.shift;
      }
      this.gearIndex = Math.min(this.gearIndex, wanted.length - 1);
    } else if (wantDir === 0 && sp < 0.2) {
      this.gearDir = 0;
      this.gearIndex = 0;
    }

    // Grade along the line of travel — a climb whichever way the hull points.
    // Past the vehicle's climb angle the tracks cannot hold at all and it
    // slides back down; short of that the hill simply eats the top end.
    const heading = wantDir || rolling || 1;
    const grade = this.slope * heading;
    const climbLimit = (spec.climbMax ?? 0.58) * (0.6 + 0.4 * surf.grip);
    this.stalled = wantDir !== 0 && grade > climbLimit && power > 0;
    const gradeLoss = this.stalled
      ? 0
      : clamp(1 - (grade / Math.max(0.05, climbLimit)) * 0.55, 0.2, 1.1);

    const set = this.gearDir > 0 ? gb.forward : this.gearDir < 0 ? gb.reverse : gb.forward;
    const ceiling = this.gearDir < 0 ? maxR : maxF;
    const gearTop = Math.max(0.5, ceiling * set[this.gearIndex]);
    // what this gear can actually pull to on this ground, on this hill, with
    // this much engine left
    const deliver = Math.max(0.4, gearTop * power * surf.top * gradeLoss);

    // rpm, and the shift that comes out of it. The driver shifts up when the
    // gear has given everything it is going to give — which on a hill is well
    // short of the gear's nominal top — and down when the revs fall away.
    // Torque is cut while the lever is moving, which is why a crash box loses
    // ground on every slope.
    const revs = clamp(sp / gearTop, 0, 1.05);
    const reach = clamp(sp / deliver, 0, 1.3);
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
    } else if (this.gearDir !== 0) {
      if (!this.stalled && reach > 0.95 && this.gearIndex < set.length - 1) {
        this.gearIndex++;
        this.shiftTimer = gb.shift;
      } else if (revs < 0.35 && this.gearIndex > 0) {
        this.gearIndex--;
        this.shiftTimer = gb.shift * 0.6;
      }
    }
    const shifting = this.shiftTimer > 0;
    const revBlip = Math.abs(throttle) > 0.05 && revs < 0.15 ? 0.3 * Math.abs(throttle) : 0;
    this.rpm = clamp(0.1 + 0.85 * revs + revBlip - (shifting ? 0.3 : 0), 0, 1);
    const prevGear = this.gear;
    this.gear = this.gearDir === 0 ? 0 : this.gearDir * (this.gearIndex + 1);
    // AV-04: the two moments an engine visibly coughs — the driver taking a
    // new gear (the same change the battles hand the engine voice as its
    // `shift`) and a stab of throttle. revKick names it for THIS frame only
    // (update() clears it), so the exhaust puff and the gearbox clunk both
    // key off one event.
    const thAbs = Math.abs(throttle);
    this.revGap = (this.revGap || 0) - dt;
    this.revLeftAge = (this.revLeftAge || 0) + dt;
    let kick = null;
    if (this.gear !== prevGear && this.gear !== 0) {
      // hunting back into the gear it has just come out of is not an event
      if (!(this.gear === this.revLeftGear && this.revLeftAge < REV_HUNT)) kick = 'shift';
    } else if (thAbs - (this.revThrottle || 0) > 0.35 && thAbs > 0.5) kick = 'throttle';
    if (this.gear !== prevGear) {
      this.revLeftGear = prevGear;
      this.revLeftAge = 0;
    }
    if (kick && this.revGap <= 0) {
      this.revKick = kick;
      this.revGap = REV_GAP;
    }
    this.revThrottle = thAbs;
    if (this.revKick) this.revKicks = (this.revKicks || 0) + 1;
    this.gearName =
      this.gearDir === 0 ? 'N'
        : this.gearDir < 0 ? (gb.reverse.length > 1 ? `R${this.gearIndex + 1}` : 'R')
          : String(this.gearIndex + 1);

    // Tractive effort: a low gear is a low ratio number, and a low ratio is a
    // lot of pull. The torque curve peaks about four-fifths of the way up.
    const pull = clamp(0.62 / Math.max(0.1, set[this.gearIndex]), 0.85, 2.6);
    const curve = 0.55 + 0.85 * this.rpm - 0.5 * this.rpm * this.rpm;
    let accel = spec.accel * pull * curve * power * surf.grip;
    if (shifting) accel *= 0.05;

    // The brakes are their own machine, and the Brake System modification is
    // the only thing that touches them: everything below that sheds speed does
    // it through the drivetrain brake rather than through the engine.
    const brake = spec.brakeFactor || 1;

    let target;
    if (reversing) {
      target = 0;
      // brakes bite harder than the engine pulls
      accel = spec.accel * 1.6 * brake * power;
    } else if (this.stalled || wantDir === 0) {
      target = 0;
      // lifting off a tank is a brake application — there is no freewheel in a
      // final drive — so better brakes shorten the stop, not just the reversal
      accel *= brake;
    } else {
      target = wantDir * deliver;
    }

    const before = this.speed;
    this.speed = moveToward(this.speed, target, Math.max(0.5, accel) * dt);

    // gravity along the hull acts whatever the driver is doing — a stalled
    // climb slides back, a descent runs away a little
    this.speed -= 9.8 * Math.sin(this.slope) * 0.42 * dt;
    // rolling resistance, which is what makes soft going feel heavy
    if (wantDir === 0) {
      this.speed = moveToward(this.speed, 0, spec.accel * 0.55 * surf.roll * dt);
    }
    const overspeed = (this.gearDir < 0 ? maxR : maxF) * 1.3;
    this.speed = clamp(this.speed, -overspeed, overspeed);
    this.accelNow = dt > 0 ? (this.speed - before) / dt : 0;

    // ---- steering ----
    const prevYaw = this.yaw;
    if (tracksOk && this.canDrive && Math.abs(this.steerInput) > 0.05) {
      const v = Math.abs(this.speed);
      let rate;
      if (spec.neutralSteer && v < 0.8) {
        // regenerative steering: the tracks counter-rotate and the hull spins
        // on the spot, which is a luxury a clutch-and-brake box never had
        rate = spec.turnRate * 0.62 * power;
      } else {
        // otherwise the turn needs the tracks turning. Authority comes up fast
        // off the mark and falls away again at speed, so the tightest turn is
        // made slowly — which is exactly the shape of a real track turn.
        const u = clamp(v / Math.max(1, spec.maxSpeed * 0.28), 0, 1);
        rate = spec.turnRate * u * (1 - 0.32 * (v / Math.max(1, spec.maxSpeed))) * power;
      }
      rate *= surf.steer;
      this.yaw = wrapAngle(this.yaw + this.steerInput * rate * dt);
      // braking one track scrubs speed off, and more of it on loose ground
      const scrub = Math.abs(this.steerInput) * (0.3 + 0.45 * (1 - surf.grip));
      this.speed -= this.speed * clamp(scrub * dt, 0, 0.5);
    }
    this.yawDelta = wrapAngle(this.yaw - prevYaw);

    const p = this.group.position;
    p.x = clamp(p.x + Math.sin(this.yaw) * this.speed * dt, -this.bound, this.bound);
    p.z = clamp(p.z + Math.cos(this.yaw) * this.speed * dt, -this.bound, this.bound);
    p.y = terrainHeight(p.x, p.z);
  }

  // Moving tracks. Each side runs at the hull's ground speed plus or minus
  // the turn: yaw is + to the left, so a left turn slows the left (+X) track
  // and speeds the right, and a pivot runs them opposite. The distance is the
  // hull's ACTUAL travel along its heading this frame (a clamp at the map
  // edge stops the tracks too), so the ground run stands still on the ground.
  runTracks(prevX, prevZ) {
    const rg = this.runningGear;
    if (!rg) return;
    const p = this.group.position;
    const fwd = (p.x - prevX) * Math.sin(this.yaw) + (p.z - prevZ) * Math.cos(this.yaw);
    const half = this.trackGauge * 0.5 * (this.yawDelta || 0);
    const dl = fwd - half;
    const dr = fwd + half;
    if (dl === 0 && dr === 0) return;
    const wrap = rg.wrap || 500;
    const w = (x) => (x >= wrap || x <= -wrap ? x % wrap : x);
    this.wheelRunL = w(this.wheelRunL + dl);
    this.wheelRunR = w(this.wheelRunR + dr);
    // a broken track lies still under the wheels until the crew re-lay it
    if (this.modules.tracks.ok) {
      this.beltRunL = w(this.beltRunL + dl);
      this.beltRunR = w(this.beltRunR + dr);
    }
    driveRunningGear(rg, this.beltRunL, this.beltRunR, this.wheelRunL, this.wheelRunR);
  }

  // ---------------------------------------------------------------------
  // suspension
  // ---------------------------------------------------------------------
  // Four contact patches, a damped spring toward the plane they imply, plus
  // squat under power and dive under the brakes. This is what makes a hull-down
  // position mean something: the gun depression you have depends on the
  // attitude the hull settled into, not on the ground normal under its centre.
  updateSuspension(dt) {
    const g = this.sampleGround();
    const groundPitch = g.pitch;
    const groundRoll = g.roll;
    this.slope = g.slope;

    // accelerating lifts the nose, braking drops it
    const squat = clamp(this.accelNow, -14, 14) * this.susp.squat;
    const pitchTarget = groundPitch - squat;

    const k = this.susp.stiff;
    const d = this.susp.damp;
    const prevPitch = this.hullPitch;
    // substepped so a dropped frame cannot blow the spring up
    let left2 = dt;
    while (left2 > 0) {
      const h = Math.min(0.02, left2);
      left2 -= h;
      this.pitchVel += ((pitchTarget - this.hullPitch) * k - this.pitchVel * d) * h;
      this.rollVel += ((groundRoll - this.hullRoll) * k - this.rollVel * d) * h;
      this.hullPitch = clamp(this.hullPitch + this.pitchVel * h, -0.6, 0.6);
      this.hullRoll = clamp(this.hullRoll + this.rollVel * h, -0.6, 0.6);
    }
    this.hullPitchDelta = this.hullPitch - prevPitch;
    this.hullPitchRate = dt > 0 ? this.hullPitchDelta / dt : 0;
    this.suspSeated = true;
  }

  // ---------------------------------------------------------------------
  // turret, gun laying and dispersion
  // ---------------------------------------------------------------------
  updateTurret(dt) {
    const spec = this.spec;
    const elev = spec.gunElev || DEFAULT_ELEV;
    const stab = spec.stabiliser;

    // A stabiliser feeds the hull's own movement back into the drives so the
    // sight stays where the gunner put it. Without one the gun is bolted to a
    // hull that is rocking, and he has to chase it at hand speed — which is
    // the whole reason to stop before firing.
    if (stab && stab.horizontal && this.modules.traverse.ok) {
      this.turretYaw = wrapAngle(this.turretYaw - this.yawDelta * stab.horizontal);
    }
    if (stab && stab.vertical && this.modules.elevation.ok) {
      this.gunPitch = clamp(
        this.gunPitch + this.hullPitchDelta * stab.vertical, elev.min, elev.max,
      );
    }

    const prevTurretYaw = this.turretYaw;
    const sol = this.aimSolution(this.aimPoint, !this.manualAim);
    let desiredYaw = sol.yawLocal;
    if (spec.turretYawLimit != null) {
      // casemate: the gun only nudges — the hull does the aiming
      desiredYaw = clamp(desiredYaw, -spec.turretYawLimit, spec.turretYawLimit);
    }
    this.turretYaw = angleToward(this.turretYaw, desiredYaw, this.effTraverse * dt);
    this.turretGroup.rotation.y = this.turretYaw;
    this.turretRate = dt > 0 ? Math.abs(wrapAngle(this.turretYaw - prevTurretYaw)) / dt : 0;

    this.gunPitch = angleToward(this.gunPitch, sol.pitch, this.effPitchSpeed * dt);
    this.gunGroup.rotation.x = -this.gunPitch;
  }

  // Where the reticle should be drawn, and how big. Everything that unsettles
  // the gun piles on; standing still and letting the sight steady is the only
  // thing that takes it off again.
  updateDispersion(dt) {
    const spec = this.spec;
    const stab = spec.stabiliser;
    const vStab = stab && stab.vertical ? stab.vertical : 0;
    const base = spec.dispersion ?? BASE_DISPERSION;
    // Adjustment of Fire. mods.js has already folded spreadFactor into
    // spec.dispersion, so multiplying the base by it a second time would sell
    // the same fifteen per cent twice; what the modification still owes is the
    // spread the hull and the turret drive throw into a laid sight, and a gun
    // that has been properly zeroed keeps more of its group under all of it.
    const tighten = spec.spreadFactor ?? 1;

    const move = (Math.abs(this.speed) / Math.max(1, spec.maxSpeed)) * DISP_MOVE * (1 - 0.55 * vStab);
    const slew = this.turretRate * DISP_SLEW;
    const rock = Math.abs(this.hullPitchRate) * DISP_PITCH * (1 - vStab);
    // a gunner who is hurt, or a commander doing the job for him, is not going
    // to lay as fine a shot
    const gunner = this.seatHealth('gunner');
    const hands = gunner > 0 ? 1 + (1 - gunner) * 0.8 : 2.1;
    // a bent barrel throws rounds anywhere it likes
    const barrel = this.modules.barrel.ok ? 1 : 8;

    // 40 mrad is already a reticle the size of a tank at 200m; past that the
    // number stops meaning anything useful to draw
    const target = Math.min(
      0.04, (base + (move + slew + rock + this.shake) * tighten) * hands * barrel,
    );
    // it opens up at once and settles back slowly, the way a real sight does
    const k = target > this.dispersion ? 10 : 1.6;
    this.dispersion += (target - this.dispersion) * Math.min(1, k * dt);
    this.shake = Math.max(0, this.shake - dt * DISP_SHAKE_DECAY);
  }

  // A hit rings the whole vehicle; the gunner loses the sight picture for a
  // couple of seconds whether or not anything broke.
  addShake(amount = 1) {
    this.shake = Math.min(0.02, this.shake + DISP_SHAKE * amount);
  }

  updateRecoil(dt) {
    if (this.recoilZ === 0 && this.recoilVel === 0) return;
    // the recuperator pushes the gun back out: stiff, well damped, done in
    // about four tenths of a second
    this.recoilVel += (-this.recoilZ * 160 - this.recoilVel * 17) * dt;
    this.recoilZ += this.recoilVel * dt;
    if (Math.abs(this.recoilZ) < 0.002 && Math.abs(this.recoilVel) < 0.02) {
      this.recoilZ = 0;
      this.recoilVel = 0;
    }
    const rg = this.gunGroup.userData.recoilGroup;
    if (rg) rg.position.z = this.recoilZ;
  }

  // Slams the barrel back and lets updateRecoil bring it home. Returns the
  // stroke in metres so a caller can match a muzzle effect to it.
  recoil(amount = null) {
    const shell = this.spec.shells[this.shellType];
    const a = amount ?? clamp((shell ? shell.caliber : 75) / 620, 0.1, 0.42);
    this.recoilZ = -a;
    this.recoilVel = 0;
    // and the whole vehicle rocks back on its springs
    this.pitchVel -= a * 0.9;
    return a;
  }

  updateWreck(dt) {
    if (this.wreckTurretVel) {
      this.turretGroup.position.addScaledVector(this.wreckTurretVel, dt);
      this.wreckTurretVel.y -= 22 * dt;
      this.turretGroup.rotation.x += 2.2 * dt;
      const wp = this.turretWorldPos(tmpV);
      if (this.wreckTurretVel.y < 0 && wp.y <= terrainHeight(wp.x, wp.z) + 0.4) {
        this.wreckTurretVel = null;
      }
    }
  }

  setShellType(type) {
    if (type === this.shellType || !this.alive || !this.spec.shells[type]) return;
    this.shellType = type;
    // swapping costs time, and it costs the wounded loader more
    this.reload = Math.max(this.reload, this.effReload * 0.7);
    this.reloadTotal = Math.max(this.reloadTotal, this.reload);
  }

  // No man in the gunner's seat, no shot — whatever else is ready.
  canFire() {
    return (
      this.alive &&
      this.reload <= 0 &&
      this.modules.breech.ok &&
      this.ammo[this.shellType] > 0 &&
      this.staffed('gunner')
    );
  }

  // Contract C1: the SPAA autocannon / coax MG is laid by the gunner too.
  canFireStream() {
    return this.alive && this.staffed('gunner') && this.streamAmmo > 0;
  }

  tryFire() {
    if (!this.canFire()) return null;
    this.reload = this.effReload;
    this.reloadTotal = this.effReload;
    this.reloadFrac = 0;
    this.ammo[this.shellType]--;
    const pos = this.muzzleWorld(new THREE.Vector3());
    const dir = this.gunDirection(new THREE.Vector3());
    const spread = this.dispersion;
    this.scatter(dir, spread);
    this.recoil();
    // firing unsettles the next shot as well
    this.shake = Math.min(0.02, this.shake + spread * 0.35);
    return {
      pos,
      dir,
      shell: this.spec.shells[this.shellType],
      type: this.shellType,
      shooter: this,
      dispersion: spread,
    };
  }

  // Push `dir` off by a random angle inside the dispersion cone. Denser in the
  // middle than at the edge, so most rounds land near the point of aim and the
  // occasional one does not.
  scatter(dir, spread) {
    if (spread <= 0) return dir;
    dispA.crossVectors(dir, Math.abs(dir.y) > 0.9 ? SIDE : UP).normalize();
    dispB.crossVectors(dir, dispA).normalize();
    const mag = Math.tan(spread) * Math.sqrt(Math.random()) * (0.55 + Math.random() * 0.6);
    const ang = Math.random() * Math.PI * 2;
    return dir
      .addScaledVector(dispA, Math.cos(ang) * mag)
      .addScaledVector(dispB, Math.sin(ang) * mag)
      .normalize();
  }

  // ---------- damage model ----------
  // Three stages now: work out what plate was really hit and how it was lying,
  // decide whether it is beaten, then trace what the penetrator reaches inside.
  // Nothing is rolled per armour face — the modules in combat/internals.js
  // decide, which is also exactly what the X-ray draws.
  //
  // hit: { isTurret, zone, angle, dist, localY, point, dir }
  // returns { result, events, modules } — result: ricochet | nonpen | pen | kill
  // A ricochet also carries `deflect: { dir, energy }`: the shell is still
  // flying, and ballistics.js is meant to send it on its way rather than
  // delete it.
  applyHit(hit, shell, shellType) {
    if (!this.alive) return { result: 'dead', events: [], modules: [] };
    // the plate, in the frame of the part that was hit. The whole solution —
    // slope, overmatch, ricochet band, normalisation — comes out of solvePlate
    // so the HUD forecast cannot drift away from what actually happens here.
    const obj = hit.isTurret ? this.turretGroup : this.group;
    const s = solvePlate(this, hit, shell, shellType, hit.dist, true, plateSolve);
    const kind = s.kind;
    const impact = s.impact;
    const events = [];

    if (s.ricochetChance > 0 && Math.random() < s.ricochetChance) {
      events.push('Ricochet');
      this.maybeTrackHit(hit, events);
      this.addShake(0.7);
      this.cancelRepair('damage');
      const deflect = this.deflection(hit, obj, impact);
      // A bursting charge does not care that the shell skidded: the fuse is
      // still running and it is still against the plate. Skipping this was why
      // an HE round that grazed a light tank did nothing at all to it.
      if (kind === 'HE' && this.fillerLive(hit)) {
        const res = this.heOverpressure(hit, shell, s.effArmor, events);
        res.angle = impact;
        // the plate shrugged the blast off as well, so hand ballistics.js the
        // skid it asked for and let the empty shell go on its way
        if (res.result === 'nonpen') {
          res.result = 'ricochet';
          res.deflect = deflect;
        }
        return res;
      }
      return {
        result: 'ricochet',
        events,
        modules: [],
        angle: impact,
        deflect,
      };
    }

    const effArmor = s.effArmor;
    const effPen = s.effPen;

    if (effPen < effArmor) {
      events.push('Non-penetration');
      this.maybeTrackHit(hit, events);
      this.addShake(1);
      this.cancelRepair('damage');
      // A shell with a bursting charge in it does not simply stop because the
      // plate held — it goes off against the armour. Without this an HE round
      // was worth less on the target than in the dirt beside it.
      if (kind === 'HE' && this.fillerLive(hit)) {
        const res = this.heOverpressure(hit, shell, effArmor, events);
        res.angle = impact;
        return res;
      }
      return { result: 'nonpen', events, modules: [], angle: impact };
    }

    events.push('Penetration');
    this.maybeTrackHit(hit, events);
    this.addShake(1.4);
    this.cancelRepair('damage');
    const res = this.resolvePenetration(
      hit.point, hit.dir, effPen - effArmor, kind, events, shell.caliber || 75,
    );
    res.angle = impact;
    return res;
  }

  // Has this round still got its filler? A bursting charge goes off once.
  // ballistics.js keeps a skidded shell in flight and only bars it from the
  // vehicle it skidded off while it is still alongside — past that the same
  // round can come back for a second bite, and on a mantlet ricochet that is
  // exactly what it is meant to do. What it must not do is burst twice, so
  // read the mark the shell puts on itself when it deflects: ShellManager
  // cuts penMul on every deflection and copies it onto the hit record. An HE
  // round never grazes the ground (only solid shot does), so for the shells
  // that carry a charge a penMul under 1 means one thing — it has already
  // skidded off armour, and that is where the charge went.
  fillerLive(hit) {
    return !(hit && hit.penMul < 1);
  }

  // Where a skidding shell goes next. Reflected off the plate it failed to
  // beat, scattered a little and slowed, in WORLD space — ballistics.js can
  // put it straight back into flight instead of deleting it.
  deflection(hit, obj, impact) {
    const n = new THREE.Vector3().copy(tmpPlate).transformDirection(obj.matrixWorld).normalize();
    const dir = new THREE.Vector3().copy(hit.dir).normalize();
    dir.addScaledVector(n, -2 * dir.dot(n));
    // a real skid is never a clean mirror
    this.scatter(dir, 0.12);
    // the flatter the strike the more of its speed the shell keeps: a round
    // that barely skidded is still nearly intact, one that only just failed to
    // bite has left most of itself in the plate
    const energy = clamp(0.35 + (impact - 1) * 1.1, 0.3, 0.85);
    return { dir, energy };
  }

  // One of the men still working, picked at random, or null if nobody is.
  randomCrewRole() {
    let pool = 0;
    for (const role of this.crewStations) if (this.crewAlive[role] > 0) pool++;
    if (pool === 0) return null;
    let pick = Math.floor(Math.random() * pool);
    for (const role of this.crewStations) {
      if (this.crewAlive[role] <= 0) continue;
      if (pick-- === 0) return role;
    }
    return null;
  }

  // An HE shell that burst ON the armour instead of beside it. The charge is
  // going off against the plate with nothing to attenuate it, so it is worth
  // the same overpressure a contact bomb burst gets — which is what makes
  // firing HE at a tank better than deliberately missing it again.
  heOverpressure(hit, shell, armor, events) {
    const radius = shell.splash || Math.max(2, (shell.caliber || 75) * 0.05);
    // applyExplosion's curve at falloff 1: a burst on the plate is the closest
    // a burst can be. Same constant, so the two can never drift apart.
    const blastPen = radius * BLAST_PEN;

    if (blastPen >= armor) {
      events.push('Overpressure');
      const res = this.resolvePenetration(
        hit.point, hit.dir, blastPen - armor, 'HE', events, shell.caliber || 75,
      );
      res.blast = true;
      return res;
    }

    // The plate held, but the shock comes through it, and a heavy round on a
    // thin plate rings the crew's bells even when nothing gets inside.
    const shock = clamp((blastPen / armor - 0.4) * 1.2, 0, 0.55);
    if (shock > 0 && Math.random() < shock) {
      const role = this.randomCrewRole();
      const outcome = role ? this.hurtCrew(role, 0.4) : null;
      if (!this.alive) {
        events.push('Crew knocked out');
        return { result: 'kill', events, modules: [], blast: true };
      }
      if (outcome === 'killed') events.push('Crew member knocked out');
      else if (outcome === 'wounded') events.push('Crew member wounded');
    }
    return { result: 'nonpen', events, modules: [], blast: true };
  }

  // Bomb / rocket blast — and, through the battle classes, artillery and HE
  // shell splash as well, so nothing here may assume it is looking at a bomb.
  //
  // Two things decide what a burst does, and both used to be wrong.
  //
  // 1. HOW FAR IT STOOD OFF. Distance was measured to the hull centre, so a
  //    250 kg bomb going off 2 m from a Tiger's track was scored as 5 m away
  //    and threw two thirds of its curve away inside the vehicle's own hull.
  //    It is measured from the armour now.
  // 2. WHICH PLATE IT FINDS. The front was always sent into the plate facing
  //    the burst, so a bomb bursting in the dirt beside a Tiger was asked to
  //    beat 80 mm of side armour. A charge that big does not politely load one
  //    plate — it swallows the vehicle, and the thing it can actually reach is
  //    26 mm of roof. Top armour is the thinnest plate on every tank here and a
  //    bomb arrives from above; the roof is now a way in.
  //
  // What the blast fails to penetrate it still spends: on the running gear, on
  // the fittings hung outside the armour, and on the men. That is what makes a
  // near miss a mobility kill instead of a message in the log.
  //
  // Contract C2: opts.model === 'bomb' runs the deterministic bomb ladder
  // (applyBombBlast); anything else — artillery, HE splash, rockets — runs the
  // model below unchanged.
  //
  // Returns { result, events, modules, blast?, nearMiss? }:
  //   result    'kill' | 'damaged' | 'none' | 'dead' (already a wreck)
  //   events    hit-log strings ('Bomb hit', 'Track destroyed', ...); empty on
  //             'none' / 'dead'. Never carries crew-swap text.
  //   modules   module / 'crew_<role>' keys the X-ray flashes
  //   blast     true on 'kill' / 'damaged'
  //   nearMiss  BOMBS ONLY (opts.model === 'bomb'): true when the burst was
  //             inside radius + this.radius of the hull centre and did nothing
  //             but shake the vehicle — the battle's cue for 'Near miss'.
  //             Absent on every other path: the legacy model used to set it as
  //             well, and a rocket or an HE shell landing short then told the
  //             player 'Near miss' for what was simply a miss.
  applyExplosion(point, radius, label = 'Bomb hit', opts = null) {
    if (!this.alive) return { result: 'dead', events: [], modules: [] };
    if (opts && opts.model === 'bomb') return this.applyBombBlast(point, radius, label);
    const hull = this.spec.hull;
    const centre = tmpCentre.copy(this.position);
    centre.y += hull.trackH + hull.h * 0.5;
    const dist = centre.distanceTo(point);
    // cheap reject before any matrix work; the real test is on standoff below.
    // It matches the gate battle.js puts in front of this call, so the two
    // cannot disagree about who is in the blast.
    if (dist > radius + this.radius) return { result: 'none', events: [], modules: [] };

    // travel direction of the blast front, and the plate it slams into
    const travel = tmpTravel.subVectors(centre, point).normalize();
    this.group.updateMatrixWorld(true);
    tmpMat.copy(this.group.matrixWorld).invert();
    const ld = tmpDir.copy(travel).transformDirection(tmpMat);
    let zone;
    if (Math.abs(ld.y) >= Math.abs(ld.x) && Math.abs(ld.y) >= Math.abs(ld.z)) zone = 'top';
    else if (Math.abs(ld.z) >= Math.abs(ld.x)) zone = ld.z > 0 ? 'rear' : 'front';
    else zone = 'side';
    // travel points from the burst toward the hull centre, so a positive y here
    // means the charge went off underneath and the front reaches the belly
    const fromBelow = ld.y > 0;

    // How far the burst stood off the ARMOUR, which is the only distance blast
    // physics cares about. `half` is the hull's own half-extent along the line
    // the front travels: the axis-weighted sum is exact on an axis and never
    // overstates the box, and taking it off the centre distance is the
    // difference between measuring a near miss from the plate it went off
    // against and measuring it from the middle of the vehicle.
    const half =
      Math.abs(ld.x) * hull.w * 0.5 +
      Math.abs(ld.y) * (hull.trackH + hull.h) * 0.5 +
      Math.abs(ld.z) * hull.len * 0.5;
    const standoff = Math.max(0, dist - half);
    if (standoff >= radius) return { result: 'none', events: [], modules: [] };
    const falloff = 1 - standoff / radius;

    // a near miss knocks the gun off the aim for a while, and the closer it is
    // the longer the crew are getting the sight back on anything
    this.addShake(1 + falloff * 4);
    this.cancelRepair('damage');

    // Outright destruction: inside this the vehicle is not hit so much as
    // thrown. Scaled by charge, so a heavy bomb owns a real band of ground and
    // an HE shell owns none of it (BLAST_LETHAL_R0).
    // (`lethal > 0` is load-bearing: without it every charge too small to own
    // a lethal band still owned the single point standoff === 0, so an HE
    // shell that went off against the hull skin destroyed a Tiger outright.)
    const lethal = Math.max(0, (radius - BLAST_LETHAL_R0) * BLAST_LETHAL_K);
    if (lethal > 0 && standoff <= lethal) {
      this.destroy(true);
      return {
        result: 'kill',
        events: [label, 'Direct hit', 'Crew knocked out'],
        modules: [],
        blast: true,
      };
    }

    const events = [label];
    const modules = [];

    // ---- the two ways in ----
    const plate = armourFace(this.spec, false, zone, null, ld, tmpPlate);
    // the blast front wraps the plate, so its lay counts for much less than it
    // does against a solid shot — half credit, no more
    const wrap = Math.acos(clamp(Math.abs(ld.dot(tmpPlate)), 0, 1)) * 0.5;
    const faceArmor = plate.thickness / Math.max(0.5, Math.cos(wrap));

    // The roof. tmpV takes the normal here because tmpPlate is still holding
    // the facing plate's, which the wrap above was measured against.
    let roofArmor = armourFace(this.spec, false, 'top', null, ld, tmpV).thickness;
    const turretTop = this.spec.armor.turret ? this.spec.armor.turret.top : null;
    if (turretTop === 0) roofArmor = Math.min(roofArmor, OPEN_TOP_ARMOUR);
    const roofY = hull.trackH + hull.h;
    const engulf = clamp((radius * BLAST_FIREBALL) / roofY - BLAST_ENGULF_BIAS, 0, 1);
    // a burst already above the roof line loads it square on; one down in the
    // dirt only washes over the top, and only if it is big enough to get there
    const wash = zone === 'top' && !fromBelow ? 1 : engulf * BLAST_WASH;

    const blastPen = radius * BLAST_PEN * falloff ** BLAST_CURVE;
    const faceMargin = blastPen - faceArmor;
    const roofMargin = blastPen * wash - roofArmor;
    const throughRoof = roofMargin > faceMargin;
    const budget = throughRoof ? roofMargin : faceMargin;
    // How hard the plate was loaded, as a multiple of what it can take: 1 means
    // it only just held. What reaches the MEN is keyed to this rather than to
    // raw distance, because a thin roof passes on a great deal more of the
    // shock than a Tiger's does. What the blast does to the vehicle's own
    // ironwork is keyed to `falloff` instead — mountings and running gear do
    // not care how thick the roof over them was.
    const shock = clamp(
      (throughRoof ? blastPen * wash : blastPen) /
        Math.max(8, throughRoof ? roofArmor : faceArmor),
      0, 2,
    );

    // ---- what a blast wrecks before it troubles the armour at all ----
    // Track links, bogies, return rollers, idler and final drive are all
    // outside the plate with nothing over them. This is the near miss the user
    // is asking for: it goes long before the armour is in any danger, and at
    // half the blast radius it is close to a certainty.
    if (this.modules.tracks.ok && Math.random() < falloff * 1.7 - 0.12) {
      this.breakModule('tracks');
      events.push('Track destroyed');
      modules.push('tracks');
    }
    // the cooling group sits under wire mesh on the engine deck — a roof-side
    // blast reaches it without beating anything
    if (this.modules.radiator.ok && Math.random() < (falloff - 0.3) * 0.85) {
      this.breakModule('radiator');
      events.push('Radiator damaged');
      modules.push('radiator');
    }
    // Vision blocks, periscopes and the aerial are glass and thin sheet bolted
    // to the outside of the tank. There is no optics module in the internals
    // layout, so the loss lands where it really lands — on the men whose
    // fittings they were: the commander stops seeing out (canScout) and the
    // operator stops getting a call away (canCallIn).
    if (Math.random() < (falloff - 0.35) * 1.2) {
      if (this.hurtCrew('commander', 0.22)) {
        events.push('Optics smashed');
        modules.push('crew_commander');
      }
    }
    if (Math.random() < (falloff - 0.4) * 1) {
      if (this.hurtCrew('radio', 0.2)) {
        // "smashed", not "knocked out": combinedBattle.creditHit pays a crew
        // bonus for any event that says knocked out, and a bent aerial is not
        // a casualty
        events.push('Radio smashed');
        modules.push('crew_radio');
      }
    }
    if (!this.alive) {
      events.push('Crew knocked out');
      return { result: 'kill', events, modules, blast: true };
    }

    // ---- shock through the armour, beaten or not ----
    // This channel does NOT care whether the plate held. It used to sit inside
    // the non-penetration branch, which made a blast that just failed to beat
    // the roof hurt considerably more than one that just beat it — a cliff in
    // the wrong direction. Mountings, the turret race and the men take the
    // shock either way; what a penetration adds is the fragments, below.
    if (this.modules.engine.ok && Math.random() < (falloff - 0.55) * 0.7) {
      this.breakModule('engine');
      events.push('Engine damaged');
      modules.push('engine');
    }
    if (this.modules.transmission.ok && Math.random() < (falloff - 0.65) * 0.5) {
      this.breakModule('transmission');
      events.push('Transmission damaged');
      modules.push('transmission');
    }
    // the turret race is a ring of small balls under a many-tonne casting: put
    // a shock wave and a shovelful of dirt through it and the turret stops
    if (this.modules.traverse.ok && Math.random() < (falloff - 0.5) * 0.6) {
      this.breakModule('traverse');
      events.push('Turret drive damaged');
      modules.push('traverse');
    }

    // The men. Overpressure through a plate that held still throws them about
    // the compartment, and a bomb does it to all of them at once — which is
    // why crews abandoned tanks that were never opened. It wounds rather than
    // kills: one burst leaves a crew working at half speed, a second one on a
    // crew that has not had the first aid kit out finishes them.
    const conc = clamp((shock - 0.5) * 0.55, 0, 0.7);
    let crewLost = 0;
    let crewHurt = 0;
    if (conc > 0) {
      for (const role of this.crewStations) {
        if (this.crewAlive[role] <= 0 || Math.random() > conc) continue;
        const outcome = this.hurtCrew(role, 0.12 + shock * 0.28);
        if (outcome === 'killed') crewLost++;
        else if (outcome === 'wounded') crewHurt++;
        if (outcome) modules.push(`crew_${role}`);
        if (!this.alive) break;
      }
      // and at the very edge of what the plate could hold, one man simply does
      // not get up again
      if (this.alive && Math.random() < (shock - 1.5) * 0.5) {
        this.loseCrew(1);
        crewLost++;
      }
    }
    if (!this.alive) {
      events.push('Crew knocked out');
      return { result: 'kill', events, modules, blast: true };
    }
    if (crewLost > 0) {
      events.push(crewLost > 1 ? `${crewLost} crew knocked out` : 'Crew member knocked out');
    }
    if (crewHurt > 0) {
      events.push(crewHurt > 1 ? `${crewHurt} crew wounded` : 'Crew member wounded');
    }
    // Split fuel lines, stowage bins and a deck full of burning filler. Kept
    // low: the fuel is inside the armour, so a burst that never got in starts a
    // fire now and then rather than as a matter of course. A blast that DOES
    // get in reaches the cells, and applyModuleDamage lights them at 0.55.
    if (!this.burning && Math.random() < (falloff - 0.6) * 0.45) this.ignite(events);

    if (budget < BLAST_PIERCE_MIN) {
      // The plate held, or held well enough. Everything above still happened.
      if (events.length === 1) return { result: 'none', events: [], modules: [] };
      return { result: 'damaged', events, modules, blast: true };
    }

    // Through the plate. The entry point has to sit ON it: the bounding-sphere
    // radius put it up to two metres clear of the hull, and since the HE fuse
    // cuts the trace 0.3 m in, the penetrator itself reached nothing at all —
    // every bomb was delivering its damage through a spall cone thrown from
    // outside the tank.
    let entry;
    let dir;
    if (throughRoof && !(zone === 'top' && !fromBelow)) {
      // In over the NEAR edge of the roof and down into the fighting
      // compartment, rather than across the hull from a flank the front never
      // beat. The offset matters: straight down the centreline of the roof is
      // the one line through a tank that passes nothing at all — the racks,
      // the cells and the seats are all out in the sponsons — so the front
      // comes in over the sponson it is standing beside and works inward.
      const up = tmpV.set(0, 1, 0).transformDirection(this.group.matrixWorld).normalize();
      // the horizontal run of the front across the deck
      const across = tmpPlate.copy(travel).addScaledVector(up, -travel.dot(up));
      if (across.lengthSq() > 1e-6) across.normalize();
      else across.copy(travel);
      entry = tmpEntry.copy(centre)
        .addScaledVector(up, hull.h * 0.5)
        .addScaledVector(across, -half * 0.6);
      dir = tmpDir.copy(up).negate().addScaledVector(across, 0.55).normalize();
    } else {
      const depth = zone === 'top'
        ? (fromBelow ? hull.trackH + hull.h * 0.5 : hull.h * 0.5)
        : zone === 'side' ? hull.w * 0.5 : hull.len * 0.5;
      entry = tmpEntry.copy(centre).addScaledVector(travel, -depth);
      dir = travel;
    }
    const res = this.resolvePenetration(entry, dir, budget, 'HE', events);
    res.blast = true;
    // the running gear and the fittings went as well, and the X-ray reads this
    // list to decide what to flash
    if (modules.length) res.modules = modules.concat(res.modules || []);
    if (res.result === 'pen') res.result = 'damaged';
    return res;
  }

  // Bomb blast as a ladder keyed to standoff from the armour, so what a near
  // miss does is decided by how near it was rather than by a row of coin
  // flips. Same geometry as applyExplosion; see the BOMB_* constants for the
  // bands. Heavier plate reads as further away, for the kill and for the men.
  applyBombBlast(point, radius, label) {
    if (!this.alive) return { result: 'dead', events: [], modules: [] };
    const spec = this.spec;
    const hull = spec.hull;
    const centre = tmpCentre.copy(this.position);
    centre.y += hull.trackH + hull.h * 0.5;
    const dist = centre.distanceTo(point);
    if (dist > radius + this.radius) return { result: 'none', events: [], modules: [] };

    const travel = tmpTravel.subVectors(centre, point).normalize();
    this.group.updateMatrixWorld(true);
    tmpMat.copy(this.group.matrixWorld).invert();
    const ld = tmpDir.copy(travel).transformDirection(tmpMat);
    let zone;
    if (Math.abs(ld.y) >= Math.abs(ld.x) && Math.abs(ld.y) >= Math.abs(ld.z)) zone = 'top';
    else if (Math.abs(ld.z) >= Math.abs(ld.x)) zone = ld.z > 0 ? 'rear' : 'front';
    else zone = 'side';
    const half =
      Math.abs(ld.x) * hull.w * 0.5 +
      Math.abs(ld.y) * (hull.trackH + hull.h) * 0.5 +
      Math.abs(ld.z) * hull.len * 0.5;
    const standoff = Math.max(0, dist - half);
    if (standoff >= radius) return { result: 'none', events: [], modules: [], nearMiss: true };

    const arm = spec.armor || {};
    const hullArm = arm.hull || {};
    let top = hullArm.top || 0;
    if (arm.turret && arm.turret.top === 0) top = OPEN_TOP_ARMOUR;
    const tough = clamp(0.85 + (hullArm.side || 0) / 400 + top / 200, 0.9, 1.2);
    const s = standoff * (1 + (Math.random() * 2 - 1) * BOMB_JITTER);

    const L = Math.max(0, (radius - BLAST_LETHAL_R0) * BLAST_LETHAL_K);
    const Mh = L + BOMB_HEAVY_K * radius;
    const M = L + BOMB_MOBILITY_K * radius;
    const S = BOMB_SCRATCH_K * radius;
    const T = M + BOMB_TRACK_TAIL * (S - M);
    const rampW = BOMB_RAMP_K * radius;
    // 1 at or inside `a`, 0 at or beyond `b`, straight line between
    const ramp = (a, b) => clamp((b - s) / Math.max(0.001, b - a), 0, 1);
    const roll = (p) => p >= 1 || (p > 0 && Math.random() < p);

    this.addShake(1 + (1 - standoff / radius) * 4);
    this.cancelRepair('damage');

    // 1. thrown, not hit: certain inside KILL_IN*L, never past KILL_OUT*L
    if (L > 0) {
      const sk = s * tough;
      const p = clamp((BOMB_KILL_OUT * L - sk) / ((BOMB_KILL_OUT - BOMB_KILL_IN) * L), 0, 1);
      if (roll(p)) {
        this.destroy(true);
        return {
          result: 'kill',
          events: [label, 'Direct hit', 'Crew knocked out'],
          modules: [],
          blast: true,
        };
      }
    }

    const events = [label];
    const modules = [];
    const brk = (key) => {
      const m = this.modules[key];
      if (!m || !m.ok) return;
      this.breakModule(key);
      events.push(MODULE_EVENT[key]);
      modules.push(key);
    };
    // 2. running gear: certain inside M, fading out around T
    if (roll(ramp(M, 2 * T - M))) brk('tracks');
    // 3. one heavy module on the face the front arrived at (and the cooling
    //    group with it); from behind or above the deck grilles go first
    const heavyW = BOMB_HEAVY_RAMP_K * radius;
    const heavy = roll(ramp(Mh - heavyW, Mh + heavyW));
    if (heavy) brk(BOMB_HEAVY_BY_ZONE[zone]);
    if (zone === 'rear' || zone === 'top' ? roll(ramp(M - rampW, M + rampW)) : heavy) brk('radiator');

    // 4. the men: the whole crew concussed inside M, harder the closer it was;
    //    the commander, head and shoulders out of the cupola, takes a little
    //    more than the rest. Past M the shock thins out to nothing at R: his
    //    vision blocks and periscopes go first, then the odd man is shaken.
    let lost = 0;
    let hurt = 0;
    const st = this.crewStations;
    const count = (role, o) => {
      if (o === 'killed') lost++;
      else if (o === 'wounded') hurt++;
      if (o) modules.push(`crew_${role}`);
    };
    if (s <= M) {
      const fm = clamp((M - s) / Math.max(0.001, M - L), 0, 1);
      const w = (0.12 + 0.28 * fm) / tough;
      for (let i = 0; i < st.length && this.alive; i++) {
        const role = st[i];
        count(role, this.hurtCrew(role, role === 'commander' ? w + 0.04 / tough : w));
      }
      if (this.alive && !this.burning && Math.random() < BOMB_FIRE_MAX * fm) this.ignite(events);
    } else {
      // One roll decides whether the shock reaches the men at all (certain
      // out to half way between M and R, then falling straight to nothing at
      // R); only then are they shaken, the commander first. The share of the
      // crew each one stands for is what it always was (commander 2fc, every
      // other man fc), but separate rolls for every man made "anything at
      // all" hold near 100% until the last few metres and then drop like a
      // stone — 69% to 33% across one metre at the edge of a Spitfire's bomb.
      const fc = clamp((radius - s) / Math.max(0.001, radius - M), 0, 1);
      const reach = Math.min(1, 2 * fc);
      const shaken = roll(reach);
      for (let i = 0; shaken && i < st.length && this.alive; i++) {
        const role = st[i];
        if (role === 'commander') {
          const o = this.hurtCrew(role, (0.07 + 0.09 * fc) / tough);
          if (o === 'wounded') {
            events.push('Optics damaged');
            modules.push('crew_commander');
          } else if (o) {
            count(role, o); // an already badly wounded man does not get up
          }
        } else if (roll(fc / Math.max(0.001, reach))) {
          count(role, this.hurtCrew(role, (0.03 + 0.09 * fc) / tough));
        }
      }
    }
    if (!this.alive) {
      events.push('Crew knocked out');
      return { result: 'kill', events, modules, blast: true };
    }
    if (lost) events.push(lost > 1 ? `${lost} crew knocked out` : 'Crew member knocked out');
    if (hurt) events.push(hurt > 1 ? `${hurt} crew wounded` : 'Crew member wounded');
    if (events.length === 1) return { result: 'none', events: [], modules: [], nearMiss: true };
    return { result: 'damaged', events, modules, blast: true };
  }

  // Push a penetrator through the internals from a world-space entry point and
  // apply whatever it reaches. `budget` is leftover penetration in mm.
  //
  // A delay-fused round is handled properly here: the shell body walks in as a
  // solid shot, stops where the filler goes off, and the spall cone is thrown
  // from THAT point rather than from the back of the plate. Burst too deep and
  // it goes off behind the crew; burst on the way out and it does nothing —
  // which is the trade APHE has always been.
  //
  // `caliber` (mm) sizes the bursting charge of an armed APHE / HE round
  // (internals FILLER): the men within reach of the burst are hurt whichever
  // side of it they sit, unless the gearbox casing is in the way — or, when it
  // bursts in the engine bay, the engine, radiators and fuel cells within reach
  // are hit instead; a burst inside the gearbox spends itself on the gearbox
  // (internals fillerWithin). Left at 0 — the blast solver's own pierce
  // branch — there is no shell body and nothing changes there.
  //
  // "On the way out" is meant literally: when the fuse runs out only after the
  // round has left the vehicle again (insideArmour), the burst is in the open
  // and neither its spall cone nor its filler reaches back in through the
  // plate. Only the shell body's own path through the vehicle counts, and no
  // 'Shell explosion' is reported (the X-ray then draws a straight pass-through).
  // Without this the crew-only filler wounded men through the side armour: a
  // T-34 85 mm round across a Stuart's bow corner burst 0.34 m outside the
  // hull and still hurt the crew on every such shot (1.8% of all armed APHE
  // penetrations, a fifth of angled hits on the Stuart).
  resolvePenetration(worldPoint, worldDir, budget, kind, events, caliber = 0) {
    this.group.updateMatrixWorld(true);
    tmpMat.copy(this.group.matrixWorld).invert();
    // own temporaries: callers pass in vectors that alias the shared ones
    const origin = tmpOrigin.copy(worldPoint).applyMatrix4(tmpMat);
    const dir = tmpLocalDir.copy(worldDir).transformDirection(tmpMat).normalize();

    const fuse = FUSE[kind];
    const armed = !!fuse && budget > (fuse.arm || 0);
    const fuseDist = armed ? fuse.dist : Infinity;

    // the intact penetrator, then the spall cone off the burst point.
    // A module reached by several fragments keeps the hardest one.
    const seen = new Map();
    const collect = (list) => {
      for (const h of list) {
        const prev = seen.get(h.key);
        if (!prev || h.energy > prev.energy) seen.set(h.key, h);
      }
    };
    collect(traceInternals(this.spec, origin, dir, this.turretYaw, budget, fuseDist));

    const burst = tmpBurst.copy(origin);
    if (armed) {
      burst.addScaledVector(dir, fuseDist);
      // went straight through before the fuse ran out: the body's trace above
      // already covers its whole path inside, nothing else happens
      if (!this.insideArmour(burst)) {
        return this.applyModuleDamage([...seen.values()], events, kind);
      }
      if (fuse.label) events.push(fuse.label);
    }
    const sp = SPALL[kind] || SPALL.AP;
    for (const d of coneDirections(dir, sp.rays, sp.spread)) {
      // fragments run out of steam: SPALL entries carry their own reach
      collect(traceInternals(
        this.spec, burst, d, this.turretYaw, budget * sp.energy, sp.range ?? Infinity,
      ));
    }
    // the charge going off: overpressure and the shell body, all round — into
    // the men in the fighting compartment (not through the gearbox casing),
    // into the powerpack in the engine bay, into the casing it went off inside
    const fill = armed && caliber > 0 ? FILLER[kind] : null;
    if (fill) {
      const reach = fill.range + caliber * fill.perMm;
      const e0 = caliber * fill.energy;
      const near = fillerWithin(this.spec, burst, this.turretYaw, reach);
      for (let i = near.length - 1; i >= 0; i--) {
        const c = near[i];
        c.t = c.d;
        c.energy = e0 * (1 - c.d / reach);
        if (c.energy < fill.min) near.splice(i, 1);
      }
      collect(near);
    }
    return this.applyModuleDamage([...seen.values()], events, kind);
  }

  // Is `p` (tank-group local space, the frame resolvePenetration traces in)
  // behind the armour: inside the hull box, or inside the turret box at the
  // current traverse? These are the boxes ballistics.intersectTank hits, so a
  // point outside both is past the plate the round leaves by. The turret
  // transform is the one traceInternals uses (pivot on the hull roof at
  // turret.offZ, unrotated by turretYaw).
  insideArmour(p) {
    const hb = this.hullBox;
    if (p.x >= hb.min.x && p.x <= hb.max.x && p.y >= hb.min.y && p.y <= hb.max.y
      && p.z >= hb.min.z && p.z <= hb.max.z) return true;
    const tb = this.turretBox;
    const { hull, turret } = this.spec;
    const cos = Math.cos(-this.turretYaw);
    const sin = Math.sin(-this.turretYaw);
    const pz = p.z - turret.offZ;
    const x = p.x * cos + pz * sin;
    const y = p.y - (hull.trackH + hull.h);
    const z = -p.x * sin + pz * cos;
    return x >= tb.min.x && x <= tb.max.x && y >= tb.min.y && y <= tb.max.y
      && z >= tb.min.z && z <= tb.max.z;
  }

  applyModuleDamage(hits, events, kind) {
    const modules = hits.map((h) => h.key);
    const eventsIn = events.length;
    let crewLost = 0;
    let crewHurt = 0;
    let fuelHit = false;
    let engineHit = false;

    for (const h of hits) {
      switch (h.kind) {
        // The heavy modules take a real blow to wreck: a spent fragment with a
        // couple of millimetres left in it is as likely to bounce off the
        // casing as break it. (engineHit stays unconditional so the fire roll
        // below is unchanged.)
        case 'engine':
          engineHit = true;
          if (this.modules.engine.ok && Math.random() < clamp(h.energy / 10, 0.3, 1)) {
            this.breakModule('engine');
            events.push('Engine damaged');
          }
          break;
        case 'transmission':
          if (this.modules.transmission.ok && Math.random() < clamp(h.energy / 10, 0.3, 1)) {
            this.breakModule('transmission');
            events.push('Transmission damaged');
          }
          break;
        case 'radiator':
          if (this.modules.radiator.ok && Math.random() < clamp(h.energy / 10, 0.3, 1)) {
            this.breakModule('radiator');
            events.push('Radiator damaged');
          }
          break;
        case 'breech':
          if (this.modules.breech.ok && Math.random() < clamp(h.energy / 10, 0.3, 1)) {
            this.breakModule('breech');
            events.push('Gun breech damaged');
          }
          break;
        case 'traverse':
          // the drive is a gearbox full of small teeth; anything that reaches
          // it jams the turret where it stands
          if (this.modules.traverse.ok && Math.random() < clamp(h.energy / 18, 0.35, 1)) {
            this.breakModule('traverse');
            events.push('Turret drive damaged');
          }
          break;
        case 'elevation':
          if (this.modules.elevation.ok && Math.random() < clamp(h.energy / 18, 0.35, 1)) {
            this.breakModule('elevation');
            events.push('Elevation drive damaged');
          }
          break;
        case 'barrel':
          // a clipped barrel still fires, it just no longer sends the shell
          // anywhere in particular
          if (this.modules.barrel.ok && Math.random() < clamp(h.energy / 90, 0.1, 0.55)) {
            this.breakModule('barrel');
            events.push('Gun barrel damaged');
          }
          break;
        case 'fuel':
          fuelHit = true;
          break;
        case 'ammo':
          if (this.hitAmmoRack(events, kind, h.energy)) {
            return { result: 'kill', events, modules };
          }
          break;
        case 'crew': {
          // the trace says which seat, so the loss lands on the right man
          const role = h.key.slice(5);
          const severity = clamp(h.energy / 22, 0.15, 1);
          const outcome = Math.random() < severity
            ? this.killCrew(role) && 'killed'
            : this.hurtCrew(role, 0.3 + severity * 0.5);
          if (outcome === 'killed') crewLost++;
          else if (outcome === 'wounded') crewHurt++;
          if (!this.alive) {
            events.push('Crew knocked out');
            return { result: 'kill', events, modules };
          }
          break;
        }
        default:
          break;
      }
    }

    // fires start at the fuel cells far more often than anywhere else
    const fireChance = fuelHit ? 0.55 : engineHit ? 0.2 : 0;
    if (fireChance > 0 && !this.burning && Math.random() < fireChance) this.ignite(events);

    // A round that got in and came to nothing — it threaded the gaps, or
    // everything it reached shrugged it off — still concusses somebody: it
    // rings his bell, it does not kill him outright. This used to need an
    // empty trace, so a round that spent its last millimetres on a gearbox
    // casing or a fuel cell and broke nothing came to nothing at all: a
    // Stuart's 37 mm that only just beat an SU-100's rear plate did nothing
    // visible 57% of the time.
    const quiet = events.length === eventsIn && crewLost === 0 && crewHurt === 0;
    if (quiet && Math.random() < 0.25) {
      const role = this.randomCrewRole();
      const oc = role ? this.hurtCrew(role, 0.35) : null;
      if (oc === 'killed') crewLost = 1;
      else if (oc === 'wounded') crewHurt = 1;
      if (!this.alive) {
        events.push('Crew knocked out');
        return { result: 'kill', events, modules };
      }
    }

    if (crewLost > 0) {
      events.push(crewLost > 1 ? `${crewLost} crew knocked out` : 'Crew member knocked out');
    }
    if (crewHurt > 0) {
      events.push(crewHurt > 1 ? `${crewHurt} crew wounded` : 'Crew member wounded');
    }
    if (!this.alive) {
      events.push('Crew knocked out');
      return { result: 'kill', events, modules };
    }
    if (!hits.length && crewLost === 0 && crewHurt === 0) events.push('No internal damage');
    return { result: 'pen', events, modules };
  }

  // Running gear sits below the hull floor, so a low hit chews the track
  // whether or not the round goes on to beat the armour.
  maybeTrackHit(hit, events) {
    if (hit.isTurret || !this.modules.tracks.ok) return false;
    if (hit.localY > this.spec.hull.trackH + 0.2) return false;
    if (Math.random() > 0.6) return false;
    this.breakModule('tracks');
    events.push('Track destroyed');
    return true;
  }

  hitAmmoRack(events, kind, energy = 60) {
    // a bursting filler sets off neighbouring rounds far more readily than a
    // solid shot punching through the stowage — but only if the fragment still
    // arrives with real energy behind it
    const base = kind === 'APHE' || kind === 'HE' ? 0.62 : kind === 'HEAT' ? 0.45 : 0.5;
    const chance = base * clamp(energy / 60, 0.12, 1);
    if (Math.random() < chance) {
      events.push('Ammo rack detonated');
      this.destroy(true);
      return true;
    }
    this.modules.ammoRack.ok = false;
    events.push('Ammo rack damaged');
    return false;
  }

  ignite(events) {
    this.burning = true;
    this.fireSmother = 0;
    this.burnTimer = FIRE_SMOTHER;
    // the first flame reaches somebody sooner than the ones after it, and a
    // lined compartment pushes that first one out with all the rest
    this.burnTick = 2 / (this.spec.burnFactor || 1);
    this.fpeDelay =
      this.spec.fireExtinguisher && this.consumables.fpe > 0 ? FPE_AUTO : 0;
    events.push('Fire started');
  }

  breakModule(key) {
    const m = this.modules[key];
    if (!m) return;
    m.ok = false;
    m.timer = this.repairEstimate(key);
    // whatever the crew had their hands in, this is the more urgent job now
    if (this.repairing) this.cancelRepair('damage');
  }

  destroy(exploded) {
    if (!this.alive) return;
    this.alive = false;
    this.burning = false;
    this.repairing = false;
    this.repairTarget = null;
    this.speed = 0;
    this.rpm = 0;
    this.gear = 0;
    this.gearName = 'N';
    this.canDrive = false;
    this.driveEff = 0;
    this.handover = 0;
    // nobody is climbing anywhere in a wreck
    this.crewSwaps.length = 0;
    // V-07: burnt twins of the shared materials, never a clone (see
    // wreckMaterial above for why a clone broke the look and stalled the kill)
    const coatY = hexLuminance(this.paintHex ?? this.spec.color ?? 0x808080);
    this.group.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      o.material = Array.isArray(o.material)
        ? o.material.map((m) => wreckMaterial(m, coatY))
        : wreckMaterial(o.material, coatY);
    });
    if (exploded) {
      this.wreckTurretVel = new THREE.Vector3(
        (Math.random() - 0.5) * 6,
        14 + Math.random() * 6,
        (Math.random() - 0.5) * 6,
      );
    }
    this.exploded = exploded;
  }

  dispose() {
    this.scene.remove(this.group);
    // The hull geometry is the per-spec cache and the materials (live or burnt)
    // are the shared factory's: every other tank of this type is drawing from
    // them. A blanket dispose here — run every time a wreck sank mid-battle —
    // forced a re-upload and recompile for all of them. Free only what this
    // tank genuinely owns: skip anything isSharedResource() reports (the burnt
    // twins included) and the builder's geometry, whose cache stamps its
    // record rather than each buffer, so isSharedResource cannot see it.
    const keep = this.builderGeos;
    this.group.traverse((o) => {
      if (!o.isMesh && !o.isPoints && !o.isLine && !o.isSprite) return;
      const g = o.geometry;
      if (g && !(keep && keep.has(g)) && !isSharedResource(g)) g.dispose();
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) if (m && !isSharedResource(m)) m.dispose();
    });
  }
}

// ---------------------------------------------------------------------------
// the plate solution, in one place
// ---------------------------------------------------------------------------

// Everything the damage model decides before it decides anything: the plate the
// round really struck, the incidence it struck it at, the ricochet band, the
// normalisation and the line-of-sight thickness that comes out of them.
// `hit` is the ballistics record { isTurret, zone, point, dir }, `roll` adds the
// per-shot penetration scatter (applyHit wants it, a forecast must not have it).
// Writes into `out` and leaves the plate normal in tmpPlate, in the local frame
// of the part that was hit — deflection() reads it from there.
function solvePlate(tank, hit, shell, shellType, dist, roll, out) {
  const kind = shell.kind || shellType || 'AP';
  const caliber = shell.caliber || 75;

  const obj = hit.isTurret ? tank.turretGroup : tank.group;
  obj.updateWorldMatrix(true, false);
  tmpMat.copy(obj.matrixWorld).invert();
  tmpArmPoint.copy(hit.point).applyMatrix4(tmpMat);
  tmpArmDir.copy(hit.dir).transformDirection(tmpMat).normalize();
  const plate = armourFace(
    tank.spec, hit.isTurret, hit.zone, tmpArmPoint, tmpArmDir, tmpPlate,
  );
  const armor = plate.thickness;
  // true incidence: the plate's own lay combined with the line of flight,
  // which is why a T-34 glacis is worth twice its thickness head-on and its
  // upright sides are worth exactly what they measure
  const impact = Math.acos(clamp(Math.abs(tmpArmDir.dot(tmpPlate)), 0, 1));

  // Overmatch: a round three times fatter than the plate punches straight
  // through and the slope stops mattering.
  const overmatch = caliber >= armor * 3;
  const band = RICOCHET[kind] || RICOCHET.AP;
  const norm = overmatch ? impact : (NORMALIZATION[kind] ?? 0.05);
  const effAngle = Math.max(0, impact - norm);

  out.kind = kind;
  out.armor = armor;
  out.face = plate.face;
  out.impact = impact;
  out.overmatch = overmatch;
  out.ricochetChance = overmatch
    ? 0
    : clamp((impact - band[0]) / Math.max(1e-4, band[1] - band[0]), 0, 1);
  out.effArmor = armor / Math.max(0.2, Math.cos(effAngle));
  // a chemical round carries the same charge however far it flew, and a caller
  // that never measured the range gets the muzzle figure rather than a NaN
  const range = kind === 'HE' || kind === 'HEAT' ? 0 : (dist || 0);
  out.effPen = shellPenAt(shell, range, roll);
  return out;
}

// Contract F1: what the arcade HUD indicator is allowed to promise. It runs the
// SAME solver applyHit runs — that is the entire point, because the old
// indicator did `armour / cos(angle)` against the raw spec number and the angle
// to the axis-aligned collision box, so it showed green on shots the damage
// model then bounced.
// Returns a REUSED record { effArmor, effPen, ricochetChance, verdict }; read
// it before calling again. Bands come off PEN_SCATTER so 'maybe' means exactly
// what it says: inside the round-to-round scatter, and a gamble either way.
export function penetrationForecast(target, hit, shell, shellType, dist) {
  const out = forecastOut;
  if (!target || !hit || !shell) {
    out.effArmor = 0;
    out.effPen = 0;
    out.ricochetChance = 0;
    out.verdict = 'no';
    return out;
  }
  const s = solvePlate(target, hit, shell, shellType, dist, false, plateSolve);
  out.effArmor = s.effArmor;
  out.effPen = s.effPen;
  out.ricochetChance = s.ricochetChance;
  // No plate at all (an open-topped turret's roof, effArmor 0): applyHit's
  // `effPen < effArmor` can never hold there and overmatch zeroes the
  // ricochet band, so every round goes through — the forecast says so too.
  const ratio = s.effArmor > 0 ? s.effPen / s.effArmor : Infinity;
  if (s.ricochetChance >= 0.5) out.verdict = 'ricochet';
  else if (ratio < 1 - PEN_SCATTER * 2) out.verdict = 'no';
  // a shot that beats the plate on paper but is still inside the ricochet band
  // is a gamble, not a promise — the indicator must not call it green
  else if (ratio >= 1 + PEN_SCATTER * 2 && s.ricochetChance <= 0.15) out.verdict = 'yes';
  else out.verdict = 'maybe';
  return out;
}
