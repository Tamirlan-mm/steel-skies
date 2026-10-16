import * as THREE from 'three';
// The solid ground: the terrain plus the airfields standing on it (a field's
// platform and embankment can be tens of metres above the hillside beside
// it), and the tops of the buildings on them. Ground avoidance that read only
// the terrain flew attack runs on airfield guns straight into the fill.
import { groundHeightAt, groundSurfaceAt, obstacleTopAt, airfieldAtPoint } from '../world/airfield.js';
import { clamp, moveToward, rand, wrapAngle } from '../core/utils.js';
// The two ground modes publish capture zones in two different shapes; readZones
// is the single normaliser both AI files go through, so an aeroplane and a tank
// can never end up with a different idea of who holds what.
import { readZones } from './tankAI.js';
// the engine wear an oil leak causes, for the engine-life estimate (engineLife)
import { OIL_ENGINE_WEAR } from '../vehicles/planeEntity.js';

const tmpAway = new THREE.Vector3();
const tmpLead = new THREE.Vector3();
const tmpRel = new THREE.Vector3();
const tmpSide = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// The flight model's gravity, for the specific-energy sums below.
const GRAV = 9.8;

// A sustained turn now genuinely descends, so the floor is both higher and
// looked at further ahead than the old attitude-chaser ever needed.
const LOOK_AHEAD = 3.5;
const GROUND_MARGIN = 110;
const ATTACK_LOOK = 1.6;
const ATTACK_MARGIN = 45;
// the steepest dive an attack run is flown at (40 degrees)
const ATTACK_DIVE_TAN = Math.tan((40 * Math.PI) / 180);
// collision avoidance in the fight (avoidCollisions): a predicted miss under
// this many metres, inside this many seconds
const COLLIDE_MISS = 26;
const COLLIDE_T = 3;
// where the fight turns for the middle: 30 m inside planeEntity's MAP_EDGE
const MAP_WALL = 1170;

// Height an aeroplane sinking at vel.y needs to level off, pulling about two
// g net: v^2 / (2 * 2g).
function pullOutHeight(p) {
  const vy = p.vel ? p.vel.y : p.dir.y * p.speed;
  return vy < 0 ? (vy * vy) / 40 : 0;
}

// Nothing up here is worth the climb: the air is thin, the engines fall off
// their critical altitude and the fight is happening below.
const CEILING = 640;

// ---------------------------------------------------------------------------
// Return to base: the circuit, the landing, the crew and the next sortie
// ---------------------------------------------------------------------------
//
// An aeroplane that is out of ammunition or ordnance, shot about, short of
// fuel or simply long out on a sortie goes home, lands on its OWN side's
// field, is serviced by the same ground crew the player uses
// (world/airfield.js serviceOnGround, run by the battle's updateGroundRoll for
// every aeroplane on its wheels) and takes off again into the fight.
//
// Geometry. Every strip runs along X and every landing rolls toward the map
// edge (there is no approach from beyond it), so the approach comes in from
// the battle side. In the field's own terms: d is the sign of the DEPARTURE
// heading along X, u = (x - xTd) * d is the distance out from the touchdown
// aim point along the approach (positive before it), w = z - laneZ the
// lateral offset from the landing lane.
//
// The circuit: a GATE out on the approach, to one side of the centreline —
// each field flies its circuit on its own side of the map's long axis, since
// the two fields face each other and both circuits share the middle of the
// map — then a base turn flown as a localizer intercept (a cut of up to ~65
// degrees onto the extended centreline, from any heading, a 180 from an
// outbound leg included), then the final. The glide path (3.6 degrees, or
// steeper with the aim point further in where a hill stands in front of the
// field: rtbPlanApproach), the speed and the flare are the ones the
// player-autopilot landing suite flies (land_harness.mjs), steered through the
// same instructor (steerTowards) the mouse uses. On the ground: brakes metered
// to stop where the type still has its takeoff run ahead, the crew turn it
// round when the service is done, and it rolls, rotates, cleans up and climbs
// straight out above the circuit before it goes back to the fight.
//
// Lanes. A field takes several aeroplanes at once without them rolling into
// each other: two lanes on the runway (south and north halves) and a strip of
// mown grass beyond the blast pens for the smaller types. Each is owned by one
// aeroplane from the gate until it is climbing away again; whoever has no lane
// waits in a stacked hold (one level each) clear of the gate, most urgent
// first (damage, fuel), then in order of arrival. Planes with a lane wait at
// the gate on a ring of their own until nobody else of theirs is turning in or
// far out on finals across their path. A lane with the player, a wreck or a
// non-AI arrival on or near it is not handed out.
//
// One way at a time. The strip's far end is the map edge, so departures roll
// toward the battle and arrivals come in from it: head-on down one corridor.
// A departure waits while any lander of its field is on base, on the final or
// in the flare (departureBlock); no lander turns in while a departure is
// rolling or still low over the approach, or once one has waited its turn
// for RTB_DEPARTURE_PRIORITY seconds (baseClear). A climb-out never dodges
// a lander on its own parallel lane, and every split in the sky is vertical
// by geometry: whoever will be the higher climbs (rtbSeparate). Holders
// handed a lane leave the stack level, not down through it.
//
// Engine trouble. An engine with little life left (an oil leak eating it, the
// tank nearly dry: engineLife) makes the aeroplane an EMERGENCY: first in the
// queue, allowed to take a lane from anybody not yet turning in, kept high
// enough on the way home to glide the rest, and brought in on a glide
// approach planned as if the engine had already stopped — the shortest
// turn-straight-turn path to a final, with height to spare burnt off round an
// orbit or down a downwind leg (or in S-turns, or on the gear, the flaps and
// the airbrake) and the speed held on the elevator at best glide (rtbGlide,
// dsPilot, dsFinal) — so that the engine stopping changes nothing. An engine
// that stops anywhere else (in the circuit, or out in the fight: no cooldown
// is waited out for that) goes onto the same approach dead-stick. One that
// stops out of gliding reach of the runway — or with no legs left to land on
// — makes a forced landing in the open instead: level ground chosen within
// reach, wheels up, wings level, rounded out along the ground's own slope
// (dsDitch). The aeroplane is written off, but it is not a fireball.
//
// Anything the field cannot do — no own field, a field that has been taken or
// disposed, no lane for too long, three go-arounds, an undercarriage or a set
// of controls that will not land — falls back to the old behaviour: break off
// and loiter at home.
const RTB_GLIDE = (3.6 * Math.PI) / 180;
const RTB_TAN = Math.tan(RTB_GLIDE);
// The circuit's size. Both fields face each other across the middle of the
// map with their approaches coming in from it (the touchdown points are 1830 m
// apart), so each side's circuit has to fit in its own half: the gate 800 m
// out puts the two gates 230 m apart and the two finals, which are joined
// ~150 m inside the gate, ~460 m apart at their far ends.
const RTB_FINAL_U = 700; // nominal start of the final, metres from the aim point
const RTB_GATE_W = 250; // lateral offset of the gate (the circuit's own side)
const RTB_GATE_U = RTB_FINAL_U + 100; // ...and how far out it is
// In a battle with a ground war under it (battle.groundBattleBound: the square
// the armour fights in) the circuit is drawn in: a shorter final, so the gate
// sits in its own side's half well back from the front, not over it.
const RTB_FINAL_U_GROUND = 560;
const RTB_TD_RUNWAY = 45; // touchdown aim point, metres in from the threshold
const RTB_TD_GRASS = 40;
const RTB_HOLD_MAX = 480; // seconds holding for a lane before giving up...
const RTB_HOLD_MAX_IDLE = 60; // ...or, for a routine end of sortie, going back to work
// Who gets a lane first when several are waiting: the shot-up and the dry
// before the merely empty, and those before a routine end of sortie.
const RTB_PRIORITY = { damage: 0, fuel: 0, ground: 0, ammo: 1, ordnance: 1, timer: 2 };
const RTB_GO_AROUNDS = 3;
const RTB_LANE_CLEAR = 3.5; // wingtip-to-building / wheel-to-edge margin a lane must leave
// ...and on the grass strip, which has a wall on one side and the edge of the
// fill on the other, a little more: the big-winged Il-2 does not fit there
const RTB_GRASS_CLEAR = 4;
const RTB_COOLDOWN = 45; // after an abort, before trying again
// Departures and arrivals share the corridor head-on: a departure lined up
// this long has the field before the next arrival's base turn...
const RTB_DEPARTURE_PRIORITY = 20;
// ...and one blocked this long by traffic that never clears goes anyway
const RTB_DEPARTURE_WAIT_MAX = 90;
// the holding stack's orbit
const RTB_HOLD_R = 230;
// ...and where it is: on the field's own side of the gate, off the circuit's
// side of the centreline. (It used to be 450 m beyond the gate, which put
// each side's stack over the OTHER side's half of the map — over its armour
// and its AA in Combined Arms — and out of gliding reach of the field.)
const RTB_HOLD_U = 300; // centre, metres out from the aim point
const RTB_HOLD_W = RTB_GATE_W + 330; // ...and off the centreline
// With a ground war, over the field's own corner of the map instead, clear of
// the armour's square: RTB_HOLD_BOX beyond its edge in x and in z (the circle
// just clears the square's corner) — and the walls of the map.
const RTB_HOLD_BOX = 170;
// Engine trouble (see above). Seconds of engine left below which a plane is
// an emergency, and its queue priority.
const RTB_EMERGENCY_LIFE = 150;
const RTB_PRIO_EMERGENCY = -1;
// The glide approach (rtbGlide, dsFinal; see the RTB notes). It is flown by
// the glide pilot (dsPilot: bank, airspeed and balance set directly — the
// instructor's bank ceiling closes to ~25 degrees in any descent, which made
// a glide's turns half again as wide as planned and their radius anybody's
// guess) along the shortest turn-straight-turn path (dubins) to the start of
// the final, DS_UK_K x the glide speed out (DS_UK_MIN..DS_UK_MAX m) on the
// extended centreline — or round a burn-off orbit tangent to the final there
// while there is height to lose. It is planned with the flight model's own
// glide slopes (planeEntity glideTanN): the legs and their turns (DS_BANK)
// clean at the glide speed, the final at DS_TAN_FINAL (gear down and a
// little flap; with everything out the types manage 0.21-0.26, and dsFinal
// can move the aim point further in), DS_PLAN on top, arriving DS_EX_TARGET
// metres high (more than drag can take off goes round the orbit, or down the
// downwind leg, first: rtbGlide).
const DS_BANK = (30 * Math.PI) / 180;
const DS_BANK_TIGHT = (40 * Math.PI) / 180;
const DS_BANK_MAX = (44 * Math.PI) / 180;
const DS_UK_K = 10;
const DS_UK_MIN = 260;
const DS_UK_MAX = 400;
const DS_TAN_FINAL = 0.165;
// the cleanest final there is (the gear left until the last six seconds)
const DS_TAN_FINAL_MIN = 0.125;
const DS_PLAN = 1.06;
const DS_EX_TARGET = 10;
// the longest downwind leg the glide pattern flies, beyond the final's start
const DS_DOWNWIND_MAX = 1000;
// Short of the field's cheapest path by more than this (the cleanest final,
// no engine): it will not make the runway, and the embankment in front of the
// platform is the worst place in the map to find that out. A forced landing
// in the open instead (dsDitch).
const DS_HOPELESS = 20;
// drag ladder for the glide final: [gear down, flap stage, airbrake]
const DS_LADDER = [[false, 0, false], [true, 0, false], [true, 1, false], [true, 2, false],
  [true, 3, false], [true, 3, true]];
// A forced landing (dsDitch): the slide it needs — ground this long and this
// level along it, and level enough across it for the wingtips — and the
// furthest it looks for one.
const DITCH_SLIDE = 170;
const DITCH_SLOPE = 0.06;
const DITCH_CROSS = 0.06;
const DITCH_SEARCH = 2600;

const TWO_PI = Math.PI * 2;
function mod2pi(a) {
  const t = a % TWO_PI;
  return t < 0 ? t + TWO_PI : t;
}

// The shortest path for something that turns no tighter than radius R
// (Dubins): from (x0, y0) heading th0 to (x1, y1) heading th1, the heading
// measured as atan2(dy, dx). Called with (z, x, yaw) in the world, so a
// positive turn (L) is a turn to the LEFT (body +X) and R one to the right.
// The six words are arc-line-arc and arc-arc-arc; out: the word, its first
// arc in radians (t), the arcs' and the straight's lengths in metres. A
// `prefer`red word keeps the choice unless another is 0.4 R shorter, so a
// plan does not flicker between two near-equal ways round.
const dubinsOut = { type: 'LSL', t: 0, arc: 0, straight: 0, len: 0, firstL: true };
function dubins(x0, y0, th0, x1, y1, th1, R, prefer = null, out = dubinsOut) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d = Math.hypot(dx, dy) / R;
  const phi = d > 1e-9 ? Math.atan2(dy, dx) : 0;
  const a = mod2pi(th0 - phi);
  const b = mod2pi(th1 - phi);
  const sa = Math.sin(a);
  const sb = Math.sin(b);
  const ca = Math.cos(a);
  const cb = Math.cos(b);
  const cab = Math.cos(a - b);
  const dsq = d * d;
  let bestT = null;
  let bt = 0;
  let bp = 0;
  let bq = 0;
  let bl = Infinity;
  let pl = Infinity;
  let pt = 0;
  let pp = 0;
  let pq = 0;
  const take = (type, t, p, q) => {
    const l = t + p + q;
    if (type === prefer) {
      pl = l;
      pt = t;
      pp = p;
      pq = q;
    }
    if (l < bl) {
      bl = l;
      bestT = type;
      bt = t;
      bp = p;
      bq = q;
    }
  };
  let p2 = 2 + dsq - 2 * cab + 2 * d * (sa - sb);
  if (p2 >= 0) {
    const tmp = Math.atan2(cb - ca, d + sa - sb);
    take('LSL', mod2pi(tmp - a), Math.sqrt(p2), mod2pi(b - tmp));
  }
  p2 = 2 + dsq - 2 * cab + 2 * d * (sb - sa);
  if (p2 >= 0) {
    const tmp = Math.atan2(ca - cb, d - sa + sb);
    take('RSR', mod2pi(a - tmp), Math.sqrt(p2), mod2pi(tmp - b));
  }
  p2 = -2 + dsq + 2 * cab + 2 * d * (sa + sb);
  if (p2 >= 0) {
    const p = Math.sqrt(p2);
    const tmp = Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p);
    take('LSR', mod2pi(tmp - a), p, mod2pi(tmp - b));
  }
  p2 = -2 + dsq + 2 * cab - 2 * d * (sa + sb);
  if (p2 >= 0) {
    const p = Math.sqrt(p2);
    const tmp = Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p);
    take('RSL', mod2pi(a - tmp), p, mod2pi(b - tmp));
  }
  let c = (6 - dsq + 2 * cab + 2 * d * (sa - sb)) / 8;
  if (Math.abs(c) <= 1) {
    const p = mod2pi(TWO_PI - Math.acos(c));
    const ph = Math.atan2(ca - cb, d - sa + sb);
    const t = mod2pi(a - ph + mod2pi(p / 2));
    take('RLR', t, p, mod2pi(a - b - t + mod2pi(p)));
  }
  c = (6 - dsq + 2 * cab + 2 * d * (sb - sa)) / 8;
  if (Math.abs(c) <= 1) {
    const p = mod2pi(TWO_PI - Math.acos(c));
    const ph = Math.atan2(ca - cb, d + sa - sb);
    const t = mod2pi(-a - ph + p / 2);
    take('LRL', t, p, mod2pi(mod2pi(b) - a - t + mod2pi(p)));
  }
  if (prefer && pl < bl + 0.4) {
    bestT = prefer;
    bl = pl;
    bt = pt;
    bp = pp;
    bq = pq;
  }
  out.type = bestT || 'LSL';
  out.t = bt;
  out.firstL = out.type[0] === 'L';
  const ccc = out.type[1] !== 'S';
  out.arc = (bt + bq + (ccc ? bp : 0)) * R;
  out.straight = ccc ? 0 : bp * R;
  out.len = bl * R;
  out.s0 = bt * R;
  out.s1 = bp * R;
  out.s2 = bq * R;
  return out;
}

const fieldLanes = new WeakMap();

// One grass candidate per field: the mown strip between the blast pens' back
// walls and the platform's edge, on the side the pens are on.
function grassStripOf(af) {
  if (!af.platform || !af.obstacles) return null;
  let wall = -Infinity;
  for (const o of af.obstacles) {
    const lo = o.minZ - af.z;
    if (lo > af.halfWid) wall = Math.max(wall, o.maxZ - af.z);
  }
  if (!Number.isFinite(wall)) return null;
  return { wall, edge: af.platform.maxZ };
}

// The lanes of a field, built once and kept on a WeakMap so a disposed field
// takes its bookkeeping with it.
function lanesOf(af) {
  let st = fieldLanes.get(af);
  if (st) return st;
  const hw = af.halfWid;
  const lanes = [
    { dz: -Math.round(hw * 0.55), grass: false },
    { dz: Math.round(hw * 0.41), grass: false },
  ];
  const strip = grassStripOf(af);
  if (strip) lanes.push({ dz: null, grass: true, wall: strip.wall, edge: strip.edge });
  for (const l of lanes) {
    l.owner = null;
    if (l.grass) continue;
    // nearest thing built on the field, measured across the lane, and the
    // platform's edges for the wheels
    let clear = Infinity;
    for (const o of af.obstacles || []) {
      const lz = af.z + l.dz;
      const g = o.minZ > lz ? o.minZ - lz : o.maxZ < lz ? lz - o.maxZ : 0;
      if (g < clear) clear = g;
    }
    l.clear = clear;
    l.edge = af.platform ? Math.min(l.dz - af.platform.minZ, af.platform.maxZ - l.dz) : hw;
  }
  st = { lanes, queue: [] };
  fieldLanes.set(af, st);
  return st;
}

// Where on lane `l` this aeroplane would put its centreline (local z), or null
// if the lane is too tight for it.
function laneDzFor(l, plane) {
  const g = plane.gearGeo || {};
  const half = Math.max(Math.abs(g.tipX || 0), (plane.spec.span || 12) * 0.5);
  const track = Math.abs(g.mainX || 1.6) + 0.3;
  if (l.grass) {
    // balance the two margins: wingtip off the pen walls, wheels off the edge
    const dz = (l.wall + half + l.edge - track) / 2;
    const m = Math.min(dz - half - l.wall, l.edge - track - dz);
    return m >= RTB_GRASS_CLEAR ? dz : null;
  }
  if (l.clear - half < RTB_LANE_CLEAR + 1.5) return null;
  if (l.edge - track < RTB_LANE_CLEAR) return null;
  return l.dz;
}

// Room the type needs ahead of it to be off and climbing before the edge of
// the fill — the same sum the ground crew make (world/airfield.js
// takeoffRoomNeeded), so a stop that leaves this much is never towed.
function takeoffRoom(spec) {
  const thrust = spec && spec.powerplant ? spec.powerplant.thrust : 0;
  if (!(thrust > 0) || !(spec.mass > 0)) return 260;
  const vs = spec.stallSpeed > 0 ? spec.stallSpeed : 25;
  return 1.3 * 1.65 * vs * vs * spec.mass / thrust + 40;
}

function fieldUsable(af, team) {
  return !!(af && !af.disposed && af.team === team && !af.captured && !af.destroyed &&
    !af.disabled && af.platform);
}

// role: 'fighter' hunts planes first; 'striker' works ground targets and
// only dogfights when directly threatened (or nothing left to bomb).
//
// The aeroplane underneath this is a real energy model now: the nose is not
// the flight path, a hard turn is paid for in altitude and speed, and the
// wings come off if either the speed or the pull is allowed to run away. So
// the AI flies it the way the model wants to be flown — it keeps a height
// advantage, spends it in a dive, and goes and gets more when it has none
// left rather than turning with somebody who still has his.
export class PlaneAI {
  constructor(plane, battle, role = 'fighter') {
    this.plane = plane;
    this.battle = battle;
    this.role = role;
    this.target = null;
    this.retarget = rand(0, 1);
    this.groundTarget = null;
    this.gRetarget = rand(0, 2);
    this.extendTimer = 0;
    this.aimErr = 0.6 + Math.random() * 0.6;

    // ---- energy and self-preservation ----
    this.threat = null;
    this.threatLevel = 0;
    this.climbTimer = 0;   // committed to rebuilding energy
    this.evadeTimer = 0;
    this.evadeDir = Math.random() < 0.5 ? 1 : -1;
    this.wepTimer = 0;
    this.rocketCd = 0;
    this.disengaged = false;
    this.wantBrake = false;
    this.hardTurn = 0;
    this.prefAlt = rand(280, 460);
    this.mode = 'patrol';
    // its own steer point: no aliasing with the shared temporaries
    this.steerPoint = new THREE.Vector3();
    this.homeX = plane.team === 0 ? -900 : 900;

    // ---- objectives ----
    // Where the ground war actually is. A patrol over the world origin is a
    // patrol over nothing on a map whose points sit two hundred metres out.
    this.focus = new THREE.Vector3();
    this.focusZone = null;
    this.focusOk = false;
    this.focusT = rand(0, 1.5);
    this.patrolPhase = rand(0, Math.PI * 2);
    this.patrolRadius = rand(190, 330);

    // ---- return to base (see the RTB block at the top of the file) ----
    this.clock = 0;
    this.rtb = null; // the live circuit, or null while fighting
    this.rtbCooldown = 0; // seconds before another try after an abort
    this.sortieT = 0; // seconds since spawn or the last service
    this.sortieLimit = rand(330, 500);
    // what happened to the last few circuits, for tests and tooling:
    // { reason, start, td, stopped, serviced, airborne, done, abort, goArounds }
    this.rtbLog = [];
  }

  /**
   * Event hook for the battle classes, matching the one on TankAI: call it when
   * a capture point changes hands and the aeroplane re-reads the map on its
   * next frame instead of waiting out its cache. `zones` is accepted and
   * ignored — PlaneAI always reads the battle's live list.
   */
  onObjectivesChanged(zones = null) {
    this.focusT = 0;
    this.gRetarget = 0;
    return this;
  }

  // The zone that most wants an aeroplane over it: contested first, then ground
  // we do not hold, then wherever the enemy vehicles actually are. Cached for a
  // couple of seconds — three zones, and nothing here changes in a frame.
  updateFocus(dt) {
    this.focusT -= dt;
    if (this.focusT > 0) return this.focusOk;
    this.focusT = rand(1.8, 2.6);
    const zones = readZones(this.battle);
    this.focusOk = false;
    this.focusZone = null;
    if (!zones) return false;
    const p = this.plane;
    const team = p.team;
    let best = null;
    let bestScore = Infinity;
    for (const z of zones) {
      const d = Math.hypot(z.x - p.position.x, z.z - p.position.z);
      const foes = team === 0 ? z.enemies : z.allies;
      let s = d * 0.35;
      if (z.contested) s -= 700;
      if (z.owner !== team) s -= 380;
      if (z.owner === -1) s -= 120;
      if (z.capTeam >= 0 && z.capTeam !== team) s -= 260;
      s -= foes * 90; // hulls under the nose are the whole reason to be here
      if (s < bestScore) {
        bestScore = s;
        best = z;
      }
    }
    if (!best) return false;
    this.focus.set(best.x, 0, best.z);
    this.focusZone = best;
    this.focusOk = true;
    return true;
  }

  // Specific energy in metres: the height this aeroplane could reach if it
  // traded every knot it has. Comparing two of these is what decides whether a
  // fight is worth having.
  energy(e) {
    return e.position.y + (e.speed * e.speed) / (2 * GRAV);
  }

  stallSpeed() {
    const p = this.plane;
    return p.vStall || p.spec.stallSpeed || p.spec.minSpeed || 20;
  }

  // One pass over the opposition: who we would rather shoot, and who is in a
  // position to shoot us. The second question is the one that keeps aeroplanes
  // alive.
  scan() {
    const p = this.plane;
    let best = null;
    let bestScore = Infinity;
    let threat = null;
    let threatScore = 0.12; // below this nobody is really a threat
    const myE = this.energy(p);

    for (const o of this.battle.planes) {
      if (!o.alive || o.team === p.team) continue;
      const d = p.position.distanceTo(o.position);
      // a bandit below us is a bandit we can dive on, which is the only free
      // shot in the sky — but one sitting on its own airfield is a strafing
      // run into the hangars and the field's AA, not a dogfight
      const score = d + (o.isPlayer ? -120 : 0) + (this.energy(o) < myE ? -90 : 0) +
        (o.onGround ? 650 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = o;
      }
      if (d < 800) {
        tmpRel.subVectors(p.position, o.position); // from him to us
        const inv = 1 / Math.max(1, d);
        const nose = (tmpRel.x * o.dir.x + tmpRel.y * o.dir.y + tmpRel.z * o.dir.z) * inv;
        const astern = (tmpRel.x * p.dir.x + tmpRel.y * p.dir.y + tmpRel.z * p.dir.z) * inv;
        const s =
          clamp(nose, 0, 1) * clamp(astern * 0.5 + 0.5, 0, 1) * (1 - d / 800);
        if (s > threatScore) {
          threatScore = s;
          threat = o;
        }
      }
    }
    this.target = best;
    this.threat = threat;
    this.threatLevel = threat ? threatScore : 0;
  }

  // ---------------------------------------------------------------------
  // airframe management: the switches a pilot works without thinking
  // ---------------------------------------------------------------------
  manageAirframe(dt) {
    const p = this.plane;

    // A fire is over in seconds one way or the other. Use the bottle at once.
    if (p.burning && p.extinguishers > 0) p.useExtinguisher();
    // nobody flies a combat sortie with the gear hanging out
    if (p.gear) p.toggleGear();

    // Coolant: open it when the engine is hot and shut it for speed when it is
    // not, which is the same trade a real pilot makes on every climb.
    if (p.engineTemp > 0.82) p.setRadiator(1);
    else if (p.engineTemp < 0.55) p.setRadiator(0.32);

    // WEP is for closing a gap or running away, never for cruising: it cooks
    // the engine and the engine does not grow back.
    if (this.wepTimer > 0) this.wepTimer -= dt;
    // hysteresis: the engine has to cool properly before it gets the boost
    // back, or the AI sits on the overheat line for the whole sortie
    const hot = p.engineTemp > (p.wep ? 0.88 : 0.74) || p.wepLock;
    const wantWep =
      !hot &&
      (this.mode === 'escape' ||
        this.mode === 'energy' ||
        this.mode === 'defend' ||
        (this.mode === 'engage' && this.chasing));
    if (wantWep !== p.wep && this.wepTimer <= 0) {
      p.setWep(wantWep);
      this.wepTimer = 1.6;
    }

    // Combat flap: a little more lift for a slow turn, and it comes straight
    // off again before the airflow tears it away.
    const rip = p.spec.flapRip ? p.spec.flapRip[0] : 70;
    // (the flap limits are indicated airspeeds: planes.js flapRipOf)
    const slow = p.speed < this.stallSpeed() * 1.5 && p.ias < rip * 0.82;
    const wantFlap = slow && this.hardTurn > 0.35 && this.mode !== 'escape';
    if (wantFlap && p.flaps === 0) p.setFlaps(1);
    else if (!wantFlap && p.flaps > 0 && p.speed > this.stallSpeed() * 1.35) p.setFlaps(0);

    p.setAirbrake(this.wantBrake);
  }

  // The wings are the only ones this aeroplane gets. Past about six sevenths of
  // the structural limit the dive is over, whatever it was for.
  limitDive() {
    const p = this.plane;
    const vne = p.spec.structuralSpeed || p.spec.maxSpeed * 1.4;
    const over = p.speed / vne;
    if (over > 0.86) {
      if (this.steerPoint.y < p.position.y) {
        this.steerPoint.y = p.position.y + (over > 0.95 ? 45 : 10);
      }
      p.throttle = Math.min(p.throttle, over > 0.95 ? 0.2 : 0.55);
      this.wantBrake = over > 0.92;
      return true;
    }
    return false;
  }

  // Nothing useful happens below the stall. Unload, point the nose down where
  // there is room to do it, and buy the speed back.
  recover(agl) {
    const p = this.plane;
    p.throttle = 1;
    this.wantBrake = false;
    const drop = agl > 140 ? -70 : 4;
    this.steerPoint.set(
      p.position.x + p.dir.x * 220,
      p.position.y + drop,
      p.position.z + p.dir.z * 220,
    );
    // in a spin the instructor is already flying the recovery; all it wants
    // from us is somewhere sensible to point when it is done
    if (p.spinning) this.steerPoint.y = p.position.y - Math.min(90, agl * 0.4);
  }

  // Break contact and go home. Damaged aeroplanes and empty ones are worth
  // more on the ground than they are in somebody's gunsight.
  escape() {
    const p = this.plane;
    p.throttle = 1;
    this.steerPoint.set(this.homeX, Math.min(Math.max(p.position.y, this.prefAlt + 120), CEILING), 0);
    if (this.threatLevel > 0.3) {
      // a gentle weave is all a shot-up aeroplane can afford
      if (this.evadeTimer <= 0) {
        this.evadeTimer = rand(1.8, 3);
        this.evadeDir = -this.evadeDir;
      }
      tmpAway.set(this.homeX - p.position.x, 0, -p.position.z);
      if (tmpAway.lengthSq() < 1) tmpAway.copy(p.dir).setY(0);
      tmpAway.normalize();
      tmpSide.crossVectors(tmpAway, UP);
      if (tmpSide.lengthSq() > 1e-4) {
        tmpSide.normalize();
        this.steerPoint.copy(p.position)
          .addScaledVector(tmpAway, 320)
          .addScaledVector(tmpSide, this.evadeDir * 140);
        this.steerPoint.y = p.position.y + 30;
      }
    }
  }

  // Somebody is in a position to kill us. Energy decides the answer: with speed
  // and height in hand you leave, without them you turn into him and make the
  // shot as hard as you can.
  defend() {
    const p = this.plane;
    const th = this.threat;
    p.throttle = 1;
    const dE = this.energy(p) - this.energy(th);
    if (dE > 60 && p.speed > p.spec.maxSpeed * 0.72) {
      tmpAway.subVectors(p.position, th.position);
      if (tmpAway.lengthSq() < 1) tmpAway.copy(p.dir);
      tmpAway.normalize();
      this.steerPoint.copy(p.position).addScaledVector(tmpAway, 420);
      this.steerPoint.y = Math.min(p.position.y + 90, CEILING);
      this.hardTurn = 0.2;
      return;
    }
    if (this.evadeTimer <= 0) {
      this.evadeTimer = rand(2, 3.4);
      this.evadeDir = -this.evadeDir;
    }
    tmpAway.subVectors(th.position, p.position);
    if (tmpAway.lengthSq() < 1) tmpAway.copy(p.dir);
    tmpAway.normalize();
    tmpSide.crossVectors(tmpAway, UP);
    if (tmpSide.lengthSq() < 1e-4) tmpSide.set(1, 0, 0);
    tmpSide.normalize();
    this.steerPoint.copy(p.position)
      .addScaledVector(tmpAway, 130)
      .addScaledVector(tmpSide, this.evadeDir * 240);
    this.steerPoint.y = p.position.y + 50;
    this.hardTurn = 1;
  }

  // Climb away from the fight and come back with something to spend. This is
  // the move the old AI never had, and it is the whole of energy fighting.
  rebuildEnergy(from) {
    const p = this.plane;
    p.throttle = 1;
    this.wantBrake = false;
    if (from) {
      tmpAway.subVectors(p.position, from.position);
      tmpAway.y = 0;
      if (tmpAway.lengthSq() < 1) tmpAway.copy(p.dir).setY(0);
      tmpAway.normalize();
    } else {
      tmpAway.copy(p.dir).setY(0).normalize();
    }
    this.steerPoint.copy(p.position).addScaledVector(tmpAway, 420);
    // a climb steeper than the aeroplane can hold just trades the speed back
    const climb = p.speed > this.stallSpeed() * 2 ? 210 : 110;
    this.steerPoint.y = Math.min(p.position.y + climb, CEILING);
    this.hardTurn = 0.2;
  }

  // ---------------------------------------------------------------------
  // offence
  // ---------------------------------------------------------------------
  attackAir(t) {
    const p = this.plane;
    const dist = p.position.distanceTo(t.position);
    this.chasing = dist > 160;

    if (dist < 55 && this.extendTimer <= 0) this.extendTimer = 2.6;
    if (this.extendTimer > 0) {
      // overshoot break: fly away and climb, then come back around
      tmpAway.subVectors(p.position, t.position).setY(0);
      if (tmpAway.lengthSq() < 1) tmpAway.copy(p.dir).setY(0);
      tmpAway.normalize();
      this.steerPoint.copy(p.position).addScaledVector(tmpAway, 300);
      this.steerPoint.y = Math.min(p.position.y + 90, CEILING);
      p.throttle = 1;
      this.hardTurn = 0.3;
      return dist;
    }

    const tof = dist / p.spec.gun.speed;
    this.steerPoint.copy(t.position);
    if (t.vel) this.steerPoint.addScaledVector(t.vel, tof);
    else this.steerPoint.addScaledVector(t.dir, t.speed * tof);
    this.steerPoint.y += 0.5 * 3 * tof * tof; // bullet drop compensation
    // Every other branch stops at CEILING; a chase has to as well, or two
    // fighters following each other up ratchet the pair of them onto the world
    // clamp and mush there below the stall, out of the fight and free kills.
    // The second term is the anti-bait clause: a bandit going vertical is not
    // an invitation to follow him to the top of the sky.
    this.steerPoint.y = Math.min(this.steerPoint.y, CEILING, p.position.y + 220);
    const err = dist * 0.008 * this.aimErr;
    this.steerPoint.x += rand(-err, err);
    this.steerPoint.y += rand(-err, err) * 0.7;
    this.steerPoint.z += rand(-err, err);
    // closing fast on a slower aeroplane is how you end up in front of it
    const closing = p.speed - t.speed;
    if (dist < 130 && closing > 12) {
      p.throttle = 0.45;
      this.wantBrake = true;
    } else {
      p.throttle = dist > 260 ? 1 : 0.82;
    }
    return dist;
  }

  attackGround(gt) {
    const p = this.plane;
    const dist = p.position.distanceTo(gt.position);
    const agl = p.position.y - groundHeightAt(p.position.x, p.position.z);
    this.chasing = false;
    // A dive at a tank ends at a fixed height, not at a fixed range: pulling
    // out of it costs altitude the aeroplane no longer gets for free — and the
    // faster it is coming down, the more (pullOutHeight: the sink arrested at
    // about two g to spare). A fixed 55 m flew steep dives into the ground at
    // 40-60 m/s with the pull-out barely started.
    if ((dist < 70 || agl < 55 + pullOutHeight(p)) && this.extendTimer <= 0) this.extendTimer = 3;
    if (this.extendTimer > 0) {
      tmpAway.subVectors(p.position, gt.position).setY(0);
      if (tmpAway.lengthSq() < 1) tmpAway.copy(p.dir).setY(0);
      tmpAway.normalize();
      this.steerPoint.copy(p.position).addScaledVector(tmpAway, 260);
      this.steerPoint.y = Math.min(p.position.y + 200, CEILING);
      p.throttle = 1;
      return dist;
    }

    this.steerPoint.copy(gt.position);
    this.steerPoint.y += Math.min(90, Math.max(6, dist * 0.15));
    // never point the nose at ground the aeroplane cannot pull away from
    const floor = groundHeightAt(this.steerPoint.x, this.steerPoint.z) + 42;
    if (this.steerPoint.y < floor) this.steerPoint.y = floor;
    // ...nor more than ATTACK_DIVE below the horizon: a target steeper than
    // that is overflown and come back to, the way a strafing pilot does it,
    // instead of being chased in a near-vertical dive nothing pulls out of
    const sh = Math.hypot(this.steerPoint.x - p.position.x, this.steerPoint.z - p.position.z);
    this.steerPoint.y = Math.max(this.steerPoint.y, p.position.y - sh * ATTACK_DIVE_TAN);
    p.throttle = 0.9;
    const alt = p.position.y - gt.position.y;
    const horiz = Math.hypot(
      p.position.x - gt.position.x,
      p.position.z - gt.position.z,
    );
    if (p.bombs > 0 && horiz < 55 && alt > 40 && alt < 240) {
      this.battle.dropBomb?.(p);
    }
    return dist;
  }

  update(dt) {
    const p = this.plane;
    if (!p.alive) {
      // a lane held by a dead aeroplane is a lane nobody can land on
      if (this.rtb) this.abortRTB('lost');
      return;
    }

    this.retarget -= dt;
    if (this.retarget <= 0) {
      this.retarget = rand(0.7, 1.2);
      this.scan();
    }
    if (this.extendTimer > 0) this.extendTimer -= dt;
    if (this.climbTimer > 0) this.climbTimer -= dt;
    if (this.evadeTimer > 0) this.evadeTimer -= dt;
    if (this.rocketCd > 0) this.rocketCd -= dt;
    this.updateFocus(dt);

    // ---- going home ----
    this.clock += dt;
    if (this.rtbCooldown > 0) this.rtbCooldown -= dt;
    // For the battle: an aeroplane with a field to go home to is rearmed by
    // its ground crew there, not topped up in the air (airBattle updateRearm)
    // — or it would never run dry and never come home for ammunition.
    p._rtbHome = this.homeUsable();
    if (!this.rtb) {
      this.sortieT += dt;
      // an aeroplane on its wheels with no plan (a hop, a bounce) gets one
      // at once, whatever the cooldown says: the combat logic cannot drive
      // (nor waits out a cooldown with a stopped engine: that is a glide
      // home or a forced landing now, or a crash)
      if (p.onGround || this.rtbCooldown <= 0 || this.engineOut()) {
        const why = p.onGround ? 'ground' : this.rtbReason();
        if (why) this.startRTB(why);
      }
    }
    if (this.rtb && this.updateRTB(dt)) return;

    const agl = p.position.y - groundHeightAt(p.position.x, p.position.z);
    const vStall = this.stallSpeed();
    this.wantBrake = false;
    this.chasing = false;
    this.hardTurn = 0;

    // ---- is this aeroplane still worth fighting in? ----
    const rollGone = !p.partOk('aileronL') && !p.partOk('aileronR');
    const pitchGone = !p.partOk('elevator') || !p.partOk('controls');
    const dry = p.fuel <= 0;
    // a fighter with an empty belt has nothing left to do here; a striker still
    // has its ordnance to deliver
    const spent =
      p.ammo <= 0 && (this.role !== 'striker' || (p.bombs <= 0 && p.rockets <= 0));
    if (
      (p.burning && p.extinguishers <= 0) ||
      p.hp < p.spec.hp * 0.28 ||
      rollGone || pitchGone || dry || spent || p.ripped
    ) {
      this.disengaged = true;
    }

    let fire = false;
    let groundMode = false;
    let dist = Infinity;
    const t = this.target;

    // ---- pick a mode, and with it a place to point the nose ----
    if (p.spinning || p.stalled || p.speed < vStall * 1.06) {
      this.mode = 'recover';
      this.recover(agl);
    } else if (this.disengaged) {
      this.mode = 'escape';
      this.escape();
    } else if (this.threat && this.threat.alive && this.threatLevel > 0.34) {
      this.mode = 'defend';
      this.defend();
    } else {
      // strikers stick to ground work unless a bandit is right on them
      let engageAir = false;
      if (t && t.alive) {
        engageAir =
          this.role === 'fighter' ||
          p.position.distanceTo(t.position) < 220 ||
          p.lastHitAge < 4;
      }
      let gt = null;
      if (!engageAir) {
        gt = this.pickGroundTarget(dt);
        if (!gt && t && t.alive) engageAir = true; // nothing to bomb: dogfight
      }

      if (engageAir && t && t.alive) {
        // Out-energied and inside his reach: go and get some back rather than
        // turn with a man who still has his.
        const dE = this.energy(p) - this.energy(t);
        const near = p.position.distanceTo(t.position);
        if (dE < -110 && near < 520 && this.climbTimer <= 0 && this.extendTimer <= 0) {
          this.climbTimer = rand(6, 9);
        }
        if (this.climbTimer > 0) {
          this.mode = 'energy';
          this.rebuildEnergy(t);
          dist = near;
        } else {
          this.mode = 'engage';
          dist = this.attackAir(t);
        }
      } else if (gt) {
        this.mode = 'ground';
        groundMode = true;
        dist = this.attackGround(gt);
      } else {
        // Patrol: hold height over the point that most needs covering, not over
        // the world origin — on these layouts the origin can be a corner of the
        // map with nothing on it. Each aeroplane walks its own slow orbit round
        // that point so a flight does not stack up on one coordinate.
        this.mode = 'patrol';
        this.patrolPhase += dt * 0.14;
        const cx = this.focusOk ? this.focus.x : 0;
        const cz = this.focusOk ? this.focus.z : 0;
        // same ceiling as every other branch: an aeroplane that came home high
        // should be letting down toward the fight, not holding station above it
        this.steerPoint.set(
          cx + Math.sin(this.patrolPhase) * this.patrolRadius,
          Math.min(Math.max(this.prefAlt, p.position.y * 0.6 + 120), CEILING),
          cz + Math.cos(this.patrolPhase) * this.patrolRadius,
        );
        p.throttle = p.position.y < this.prefAlt - 60 ? 1 : 0.78;
      }
    }

    // ---- limits that override whatever the plan was ----
    // there is no turn to be had near the stall: buy speed first
    if (this.mode !== 'recover' && p.speed < vStall * 1.2) {
      this.steerPoint.y = Math.min(this.steerPoint.y, p.position.y + (agl > 160 ? -30 : 10));
      p.throttle = 1;
      this.wantBrake = false;
    }
    // a hard pull under a greying-out pilot achieves nothing: ease it off
    if (p.blackout > 0.3) {
      const k = clamp((p.blackout - 0.3) / 0.5, 0, 0.8);
      tmpLead.copy(p.position).addScaledVector(p.dir, 260);
      this.steerPoint.lerp(tmpLead, k);
    }
    this.limitDive();
    // an imminent collision outranks the attack (only the ground outranks it;
    // a departure being recovered has no pull to spare for it)
    if (this.mode !== 'recover') this.avoidCollisions();

    // ground avoidance overrides everything: aim well above the horizon ahead.
    // Attack runs use a shorter lookahead so dives aren't cancelled.
    const lookT = groundMode ? ATTACK_LOOK : LOOK_AHEAD;
    // (an attack run's short look-ahead plus the height its sink rate needs
    // to be arrested in — see pullOutHeight)
    const minMargin = groundMode ? ATTACK_MARGIN + pullOutHeight(p) : GROUND_MARGIN;
    // Extrapolate along the VELOCITY vector. The nose is not the flight path in
    // this model — there is up to sixteen degrees of angle of attack between
    // them — and a nose-based guess is optimistic exactly when it matters, on a
    // high-alpha pull-out where the aeroplane is mushing down its own margin.
    const vx = p.vel ? p.vel.x : p.dir.x * p.speed;
    const vy = p.vel ? p.vel.y : p.dir.y * p.speed;
    const vz = p.vel ? p.vel.z : p.dir.z * p.speed;
    const lookX = p.position.x + vx * lookT;
    const lookZ = p.position.z + vz * lookT;
    const lookY = p.position.y + vy * lookT;
    const margin = lookY - Math.max(groundHeightAt(lookX, lookZ), obstacleTopAt(lookX, lookZ, 10));
    if (margin < minMargin) {
      this.steerPoint.set(
        p.position.x + p.dir.x * 120,
        p.position.y + (margin < minMargin * 0.5 ? 260 : 160),
        p.position.z + p.dir.z * 120,
      );
      p.throttle = 1;
      this.wantBrake = false;
      if (p.flaps > 0 && p.speed > vStall * 1.4) p.setFlaps(0);
    } else if (Math.abs(p.position.x) > 1050 || Math.abs(p.position.z) > 1050 ||
      (this.mode !== 'recover' && this.headingForWall(vx, vz, vy))) {
      // map border: curve back toward the middle — while there is still room
      // to turn (headingForWall), not 150 m short of a wall met at 90 m/s
      this.steerPoint.set(p.position.x * 0.3, p.position.y + 20, p.position.z * 0.3);
    }

    const offAngle = p.steerTowards(this.steerPoint, dt);
    // how hard this is asking the aeroplane to turn, for the flap decision
    this.hardTurn = Math.max(this.hardTurn, clamp(offAngle / 1.2, 0, 1));
    this.manageAirframe(dt);

    if (
      this.extendTimer <= 0 &&
      margin >= minMargin &&
      !p.stalled &&
      !p.spinning &&
      offAngle < 0.06 &&
      p.ammo > 0
    ) {
      if (groundMode && this.groundTarget && this.groundTarget.alive) {
        const gd = p.position.distanceTo(this.groundTarget.position);
        fire = gd < 320;
        // rockets are worth more than the gun against armour, and they are
        // aimed the same way: with the whole aeroplane
        if (p.rockets > 0 && this.rocketCd <= 0 && gd < 700 && gd > 240) {
          this.battle.fireRocket?.(p);
          this.rocketCd = 0.45;
        }
      } else if (this.mode === 'engage' && t && t.alive) {
        fire = dist < clamp(p.convergence * 1.5, 260, 430);
      }
    }
    p.firing = fire;
  }

  // The walls of the map (planeEntity MAP_EDGE) are a hard stop: the velocity
  // into one is simply taken away, so an aeroplane that meets it at speed is
  // left at a few m/s, stalled and spinning, usually a hundred metres up —
  // that was most of the "crashed on a strafing run" losses: a striker
  // overflies a target near the edge and the old position check (|x| > 1050)
  // asked for the turn about a second before the wall. True when the point a
  // level turn of about 4.5 g needs to come round (its radius, plus a margin)
  // lies past the wall along the present track — plus, in a dive, the ground
  // covered levelling out first (the instructor will not bank a sinking
  // aeroplane hard near the ground, so the turn only starts once the sink is
  // arrested, at about two g).
  headingForWall(vx, vz, vy = 0) {
    const vh = Math.hypot(vx, vz);
    if (vh < 5) return false;
    const reach = (vh * vh) / (GRAV * 4.5) + 80 + (vy < 0 ? (vh * -vy) / (2 * GRAV) : 0);
    const fx = this.plane.position.x + (vx / vh) * reach;
    const fz = this.plane.position.z + (vz / vh) * reach;
    return Math.abs(fx) > MAP_WALL || Math.abs(fz) > MAP_WALL;
  }

  // Two aeroplanes on a collision course — a head-on merge (both noses on
  // each other is what an attack IS), two strikers diving on the same tank, a
  // chase closing on its man — break apart in the last few seconds: away from
  // where the other will be (both sides of a head-on to their own right), the
  // one that will be the higher climbing and the other diving. Only for a
  // miss under COLLIDE_MISS metres inside COLLIDE_T seconds; anything less
  // imminent is the fight's business. Returns true while it is steering.
  avoidCollisions() {
    const p = this.plane;
    const pos = p.position;
    const vel = p.vel;
    if (!vel) return false;
    let worst = 0;
    let ax = 0;
    let az = 0;
    let ay = 0;
    for (const o of this.battle.planes || []) {
      if (o === p || !o.alive || o.onGround || !o.vel) continue;
      const rx = o.position.x - pos.x;
      const ry = o.position.y - pos.y;
      const rz = o.position.z - pos.z;
      if (rx * rx + ry * ry + rz * rz > 400 * 400) continue;
      const vx = o.vel.x - vel.x;
      const vy = o.vel.y - vel.y;
      const vz = o.vel.z - vel.z;
      const vv = vx * vx + vy * vy + vz * vz;
      if (vv < 1) continue;
      const tca = -(rx * vx + ry * vy + rz * vz) / vv;
      if (!(tca > 0 && tca < COLLIDE_T)) continue;
      const mx = rx + vx * tca;
      const my = ry + vy * tca;
      const mz = rz + vz * tca;
      const miss = Math.sqrt(mx * mx + my * my + mz * mz);
      if (miss > COLLIDE_MISS) continue;
      const k = clamp((0.4 + 0.6 * (1 - miss / COLLIDE_MISS)) * (1.25 - tca / COLLIDE_T), 0, 1);
      if (k <= worst) continue;
      worst = k;
      let lx = -mx;
      let lz = -mz;
      if (lx * lx + lz * lz < 36) {
        // (nearly) dead on: to the right
        lx = -vel.z;
        lz = vel.x;
      }
      const len = Math.hypot(lx, lz) || 1;
      ax = lx / len;
      az = lz / len;
      ay = Math.abs(my) > 3 ? (my < 0 ? 1 : -1) : (p.id < o.id ? 1 : -1);
    }
    if (worst <= 0) return false;
    const sp = Math.max(1, Math.hypot(vel.x, vel.z));
    this.steerPoint.set(
      pos.x + (vel.x / sp) * 160 + ax * 220 * worst,
      pos.y + ay * 90 * worst,
      pos.z + (vel.z / sp) * 160 + az * 220 * worst,
    );
    this.hardTurn = Math.max(this.hardTurn, worst);
    return true;
  }

  // ---------------------------------------------------------------------
  // return to base
  // ---------------------------------------------------------------------

  homeField() {
    const list = this.battle.airfields;
    if (!list) return null;
    for (const af of list) if (af && af.team === this.plane.team) return af;
    return null;
  }

  // Whether there is a field this aeroplane's circuit can fly to at all.
  homeUsable() {
    const af = this.homeField();
    return fieldUsable(af, this.plane.team) && Math.abs(Math.sin(af.heading)) > 0.7;
  }

  // Seconds the engine has left: 0 when it has stopped, the oil leak's wear
  // (planeEntity OIL_ENGINE_WEAR) against what is left of it, and the fuel at
  // a cruise setting plus any leak. Infinity for a healthy aeroplane.
  engineLife() {
    const p = this.plane;
    if (typeof p.engineHealth === 'function' && p.engineHealth() <= 0) return 0;
    let life = Infinity;
    const e = p.parts && p.parts.engine;
    if (e && p.oilLeak > 0) life = e.hp / (OIL_ENGINE_WEAR * p.oilLeak);
    const s = p.spec;
    if (s.fuelCapacity > 0) {
      const burn = (s.fuelBurn || 0) * 0.65 + (p.fuelLeak || 0);
      if (burn > 0) life = Math.min(life, p.fuel / burn);
    }
    return life;
  }

  // Whether this airframe can still be put down on its wheels. Anything that
  // cannot goes on with the old behaviour: break off and loiter at home.
  canLand() {
    return this.landBlocker() === null;
  }

  // ...and if not, why not (for the circuit log: 'airframe:<why>').
  landBlocker() {
    const p = this.plane;
    if (p.gearGone) return 'gear';
    if (p.wrecked || p.ripped) return 'structure';
    // a shattered wing: no lift to spare and a permanent roll — it cannot
    // hold a circuit, let alone a flare
    if (!p.partOk('leftWing') || !p.partOk('rightWing')) return 'wing';
    if (!p.partOk('aileronL') && !p.partOk('aileronR')) return 'ailerons';
    if (!p.partOk('elevator') || !p.partOk('controls')) return 'controls';
    if (p.burning && p.extinguishers <= 0) return 'fire';
    if (typeof p.engineHealth === 'function' && p.engineHealth() <= 0) return 'engine';
    if (p.spec.fuelCapacity > 0 && p.fuel <= 0) return 'fuel';
    return null;
  }

  // Why this aeroplane should go home now, or null.
  rtbReason() {
    const p = this.plane;
    const spec = p.spec;
    const ordnance = (spec.bombs ? spec.bombs.count : 0) + (spec.rockets ? spec.rockets.count : 0);
    if (p.ammo <= spec.gun.ammo * 0.06 &&
      (this.role !== 'striker' || (p.bombs <= 0 && p.rockets <= 0))) return 'ammo';
    if (this.role === 'striker' && ordnance > 0 && p.bombs <= 0 && p.rockets <= 0) return 'ordnance';
    if (p.hp < spec.hp * 0.5) return 'damage';
    if (typeof p.partFrac === 'function' && p.partFrac('engine') < 0.55) return 'damage';
    if (p.fuelLeak > 0.15 || p.oilLeak > 0.25) return 'damage';
    if (spec.fuelCapacity > 0 && p.fuel < spec.fuelCapacity * 0.22) return 'fuel';
    if (
      this.sortieT > this.sortieLimit && this.threatLevel < 0.2 &&
      !(this.target && this.target.alive && p.position.distanceTo(this.target.position) < 600)
    ) {
      return 'timer';
    }
    return null;
  }

  startRTB(reason) {
    const p = this.plane;
    const af = this.homeField();
    if (!fieldUsable(af, p.team)) return false;
    // A stopped engine is no bar to a landing within gliding reach, nor —
    // out of reach, or with the undercarriage gone as well — to a forced
    // landing in the open (startDeadstick, once the circuit's geometry
    // exists); anything else is.
    const blocker = this.landBlocker();
    const deadEngine = !p.onGround && this.engineOut() &&
      (blocker === 'engine' || blocker === 'fuel' || blocker === 'gear');
    if (blocker && !deadEngine) return false;
    const sh = Math.sin(af.heading);
    // the runway runs along X: a field turned any other way is not flown
    if (!(Math.abs(sh) > 0.7)) return false;
    // flags on the aeroplane itself, for the other circuit flyers' lane
    // checks: _rtbActive while it is in the circuit, _rtbLane while it holds
    // a lane (see laneObstructed), _rtbPhase / _rtbField for the separation
    // rules (rtbSeparate)
    p._rtbActive = true;
    p._rtbField = af;
    p._rtbPhase = p.onGround ? 'rollout' : 'transit';
    this.rtb = {
      reason,
      af,
      d: sh > 0 ? 1 : -1,
      phase: p.onGround ? 'rollout' : 'transit',
      phaseT: 0,
      t: 0,
      lane: null,
      laneDz: 0,
      side: 1,
      holdT: 0,
      laneAsk: 0,
      goArounds: 0,
      prio: RTB_PRIORITY[reason] != null ? RTB_PRIORITY[reason] : 1,
      askedAt: Infinity,
      integ: 0,
      configured: false,
      unserviced: false,
      log: { reason, start: this.clock, td: null, stopped: null, serviced: null, airborne: null,
        done: null, abort: null, goArounds: 0, holdT: 0, lane: null, tdSink: null, tdU: null,
        tdW: null, stopU: null },
    };
    this.rtbLog.push(this.rtb.log);
    if (this.rtbLog.length > 8) this.rtbLog.shift();
    // a provisional lane until one is handed out: the side of the runway the
    // aeroplane is already on (on its wheels: exactly where it stands)
    this.rtbGeometry(p.onGround ? p.position.z - af.z : 0, false);
    // engine stopped: the glide approach, or the forced landing
    if (deadEngine) this.startDeadstick();
    this.mode = 'rtb';
    return true;
  }

  // Everything the circuit needs, for the lane at local z `dz`.
  rtbGeometry(dz, grass) {
    const r = this.rtb;
    const af = r.af;
    const p = this.plane;
    const d = r.d;
    r.laneDz = dz;
    r.laneZ = af.z + dz;
    // the circuit's size (see RTB_FINAL_U_GROUND)
    r.box = (this.battle && this.battle.groundBattleBound) || 0;
    r.finalU = r.box ? RTB_FINAL_U_GROUND : RTB_FINAL_U;
    r.gateU = r.finalU + (RTB_GATE_U - RTB_FINAL_U);
    r.circK = r.finalU / RTB_FINAL_U;
    r.grass = !!grass;
    r.xThr = af.x + d * af.halfLen;
    r.runwayY = groundHeightAt(af.x + d * af.halfLen * 0.5, r.laneZ);
    r.wheelOff = (p.gearGeo ? p.gearGeo.restHeight : 1.6) * 0.9;
    // The glide path over the ground actually there: the ordinary 3.6 degrees
    // where the approach is open, steeper (and the aim point further in) where
    // a hill stands in front of the field.
    this.rtbPlanApproach(grass ? RTB_TD_GRASS : RTB_TD_RUNWAY);
    r.edgeInner = af.x + (d > 0 ? af.platform.maxX : af.platform.minX);
    r.edgeOuter = af.x + (d > 0 ? af.platform.minX : af.platform.maxX);
    // Where to stop: far enough down the field that the type still has its
    // takeoff run ahead of it once the crew have turned it round, never closer
    // than ~90 m past the aim point, never within 28 m of the far edge.
    // ("Further" is smaller x * d: the landing rolls toward -d.)
    let stop = r.edgeInner - d * (takeoffRoom(p.spec) + 15);
    const minRoll = r.xTd - d * 90;
    if ((stop - minRoll) * d > 0) stop = minRoll;
    const last = r.edgeOuter + d * 28;
    if ((stop - last) * d < 0) stop = last;
    r.stopX = stop;
    // Each field flies its circuit on its own side of the map's long axis, so
    // the two sides' gates, holds and base turns never share airspace: the
    // west field (team 0 on these maps) to +z, the east field to -z.
    r.side = af.x <= 0 ? 1 : -1;
  }

  // The approach over the real ground: for the touchdown point `tdIn` metres
  // in from the threshold (then further in, if that is not enough), the
  // shallowest glide path, no less than 3.6 degrees, whose wheels clear every
  // hill, tree line and building under the final (and a wingspan either side)
  // by 8 m. Writes xTd, tanG (its slope), levelY (the height the final is
  // joined at) and approachOk (false when nothing under ~8 degrees will do).
  rtbPlanApproach(tdIn0) {
    const r = this.rtb;
    const af = r.af;
    const p = this.plane;
    const d = r.d;
    const half = Math.max(4, (p.spec.span || 12) * 0.5);
    const maxTan = Math.tan((8 * Math.PI) / 180);
    const okTan = Math.tan((5.5 * Math.PI) / 180);
    let best = null;
    let hTop = -Infinity;
    const edgeInner = af.x + (d > 0 ? af.platform.maxX : af.platform.minX);
    for (const tdIn of [tdIn0, tdIn0 + 30, tdIn0 + 60]) {
      const xTd = af.x + d * (af.halfLen - tdIn);
      // the field itself is what is being landed on: the clearance is for
      // everything short of it
      const k0 = (edgeInner - xTd) * d + 5;
      let need = RTB_TAN;
      for (let k = Math.ceil(k0 / 25) * 25; k <= r.finalU + 150; k += 25) {
        const x = xTd + d * k;
        let h = -Infinity;
        for (let j = -1; j <= 1; j++) {
          const z = r.laneZ + j * half;
          h = Math.max(h, groundHeightAt(x, z), obstacleTopAt(x, z, 3));
        }
        if (h > hTop) hTop = h;
        const t = (h + 8 - r.runwayY) / k;
        if (t > need) need = t;
      }
      if (!best || need < best.need - 1e-4) best = { tdIn, need, xTd };
      if (need <= okTan) break;
    }
    r.tdIn = best.tdIn;
    r.xTd = best.xTd;
    r.tanG = clamp(best.need, RTB_TAN, maxTan);
    r.approachOk = best.need <= maxTan;
    // the final is joined at the 3.6-degree height of its far end, or well
    // clear of the highest ground under it, whichever is higher
    r.levelY = Math.max(r.runwayY + r.wheelOff + r.finalU * RTB_TAN, hTop + 30);
  }

  // Hand this aeroplane a free lane on its field (first come, first served),
  // or null. Planes that own a lane are flagged on the shared registry so a
  // lane check never mistakes a neighbour on its own lane for an obstruction.
  requestLane() {
    const r = this.rtb;
    if (r.lane) return r.lane;
    const st = lanesOf(r.af);
    for (const l of st.lanes) {
      const o = l.owner;
      if (o && !(o.plane.alive && o.rtb && o.rtb.lane === l)) l.owner = null;
    }
    st.queue = st.queue.filter((ai) => ai.rtb && !ai.rtb.lane && ai.plane.alive && ai.rtb.af === r.af);
    if (!st.queue.includes(this)) {
      // the battle's clock: every AI's own starts when it spawned
      r.askedAt = Number.isFinite(this.battle.time) ? this.battle.time : this.clock;
      st.queue.push(this);
    }
    // most urgent first — among emergencies, the engine with the least left
    // in it — then in order of arrival
    const urg = (ai) => (ai.rtb.prio < 0 ? ai.engineLife() : 0);
    st.queue.sort((a, b) => a.rtb.prio - b.rtb.prio || urg(a) - urg(b) || a.rtb.askedAt - b.rtb.askedAt);
    // An emergency comes in on the glide approach, and that wants the
    // runway: the grass strip's sixteen metres between the pens' walls and
    // the edge of the fill are no place for a landing that cannot go round.
    const fits = (ai, l) => !(l.grass && ai.rtb.prio < 0) && laneDzFor(l, ai.plane) !== null;
    for (const l of st.lanes) {
      if (l.owner || !fits(this, l)) continue;
      const dz = laneDzFor(l, this.plane);
      if (this.laneObstructed(r.af.z + dz)) continue;
      let earlier = false;
      for (const q of st.queue) {
        if (q === this) break;
        if (fits(q, l)) {
          earlier = true;
          break;
        }
      }
      if (earlier) continue;
      return this.takeLane(st, l, dz);
    }
    // An emergency (an engine about to stop, or stopped) takes a runway lane
    // from an aeroplane that has not begun its turn in yet — or from another
    // emergency still on its way in whose engine has clearly longer left;
    // that one goes back into the queue and waits its turn again.
    if (r.prio < 0) {
      const mine = this.engineLife();
      let pick = null;
      for (const l of st.lanes) {
        const o = l.owner;
        if (!o || o === this || !o.rtb || l.grass) continue;
        const or = o.rtb;
        const ph = or.phase;
        const loose = ph === 'transit' || ph === 'hold' || ph === 'goaround' ||
          (ph === 'glide' && (or.dsMode === 'downwind' || or.dsMode === 'orbit'));
        if (!loose) continue;
        if (or.prio < 0 && !(o.engineLife() > mine + 30)) continue;
        const dz = laneDzFor(l, this.plane);
        if (dz === null || this.laneObstructed(r.af.z + dz)) continue;
        // (an ordinary arrival before another emergency)
        if (!pick || (pick.o.rtb.prio < 0 && or.prio >= 0)) pick = { l, o, dz };
      }
      if (pick) {
        pick.o.releaseLane();
        pick.o.rtb.gateWait = 0;
        pick.o.rtb.log.bumped = (pick.o.rtb.log.bumped || 0) + 1;
        return this.takeLane(st, pick.l, pick.dz);
      }
    }
    return null;
  }

  takeLane(st, l, dz) {
    const r = this.rtb;
    l.owner = this;
    const qi = st.queue.indexOf(this);
    if (qi >= 0) st.queue.splice(qi, 1);
    r.lane = l;
    this.plane._rtbLane = true;
    this.rtbGeometry(dz, l.grass);
    r.log.lane = l.grass ? 'grass' : dz;
    return l;
  }

  releaseLane() {
    const r = this.rtb;
    this.plane._rtbLane = false;
    if (!r || !r.lane) return;
    if (r.lane.owner === this) r.lane.owner = null;
    r.lane = null;
  }

  // Is anything that is not on the lane system on, or about to be on, the
  // lane at world z `laneZ`: the player, a wreck, a non-AI arrival?
  laneObstructed(laneZ) {
    const r = this.rtb;
    const af = r.af;
    const d = r.d;
    for (const o of this.battle.planes || []) {
      // A live owner of another lane is on that lane (a dead one is a
      // wreck), and an AI aeroplane in the circuit without a lane does not
      // land: only the player, wrecks and aeroplanes outside the system count.
      if (!o || o === this.plane || ((o._rtbLane || o._rtbActive) && o.alive)) continue;
      const pos = o.position;
      const dz = Math.abs(pos.z - laneZ);
      const onField = airfieldAtPoint(pos.x, pos.z) === af;
      const wreck = o.state === 'dead' && (o.wreckedOnGround || pos.y - r.runwayY < 4);
      if (onField && (o.onGround || wreck)) {
        if (dz < 15) return true;
        continue;
      }
      if (!o.alive || o.onGround) continue;
      // somebody on finals along this lane: low, gear down, heading in (a
      // departure climbing out with its gear still folding is not one)
      const u = (pos.x - r.xTd) * d;
      const inbound = o.vel ? -o.vel.x * d > 0.5 * Math.max(1, o.speed) : true;
      if (inbound && u > -150 && u < 1800 && dz < 30 && pos.y - r.runwayY < 130 && (o.gearPos || 0) > 0.5) {
        return true;
      }
    }
    return false;
  }

  abortRTB(why) {
    const r = this.rtb;
    if (r) {
      r.log.abort = why;
      r.log.goArounds = r.goArounds;
    }
    this.releaseLane();
    this.rtb = null;
    this.plane._rtbActive = false;
    this.plane._rtbPhase = null;
    this.rtbCooldown = RTB_COOLDOWN;
    if (this.mode === 'rtb') this.mode = 'escape';
    return false;
  }

  finishRTB() {
    const r = this.rtb;
    if (r) {
      r.log.done = this.clock;
      r.log.goArounds = r.goArounds;
    }
    this.releaseLane();
    this.rtb = null;
    this.plane._rtbActive = false;
    this.plane._rtbPhase = null;
    // a serviced aeroplane is a fresh one; one the crew never reached is not
    if (!(r && r.unserviced)) {
      this.disengaged = false;
      this.sortieT = 0;
      this.sortieLimit = rand(330, 500);
    } else {
      this.rtbCooldown = RTB_COOLDOWN;
    }
    this.extendTimer = 0;
    this.climbTimer = 0;
    this.mode = 'patrol';
  }

  setRtbPhase(phase) {
    const r = this.rtb;
    if (r.phase === phase) return;
    r.phase = phase;
    r.phaseT = 0;
    this.plane._rtbPhase = phase;
  }

  // One frame of the circuit. Returns true when it flew the aeroplane this
  // frame, false when it gave up (the caller then runs the combat logic).
  updateRTB(dt) {
    const r = this.rtb;
    const p = this.plane;
    r.t += dt;
    r.phaseT += dt;
    p.firing = false;
    if (!fieldUsable(r.af, p.team)) return this.abortRTB('field');
    if (!p.onGround) {
      const why = this.landBlocker();
      if (why === 'engine' || why === 'fuel' || (why === 'gear' && this.engineOut())) {
        // stopped: the glide approach dead-stick — or, out of reach (or
        // with no legs to land on), a forced landing in the open
        if (!r.deadstick) this.startDeadstick();
        if (why === 'gear') this.dsStartDitch('gear');
      } else if (why) {
        return this.abortRTB('airframe:' + why);
      }
      // an engine with little left in it: an emergency (see the RTB notes)
      r.engineLife = this.engineLife();
      if (r.engineLife < RTB_EMERGENCY_LIFE && r.prio > RTB_PRIO_EMERGENCY) {
        r.prio = RTB_PRIO_EMERGENCY;
        r.log.emergency = this.clock;
      }
    }
    if (r.dsWait > 0) r.dsWait -= dt;
    if (p.onGround) return this.rtbGround(dt);
    return this.rtbAir(dt);
  }

  // No engine: stopped, or nothing left to feed it.
  engineOut() {
    const p = this.plane;
    return !(typeof p.engineHealth === 'function' && p.engineHealth() > 0);
  }

  // The engine has stopped (or is about to): fly the glide approach from
  // wherever the circuit is — or, with the field out of gliding reach (or no
  // legs to land on), the forced landing in the open (dsDitch).
  startDeadstick() {
    const r = this.rtb;
    const p = this.plane;
    const dead = this.engineOut();
    if (dead && !r.deadstick) {
      r.deadstick = true;
      r.log.deadstick = this.clock;
    }
    r.prio = RTB_PRIO_EMERGENCY;
    if (r.phase === 'glide' || r.phase === 'final' || r.phase === 'flare') {
      // already on the glide approach, or on a final: carry on with what
      // is there (the final becomes the glide final, dsFinal)
      r.glideApp = true;
      return true;
    }
    // the glide approach is flown to the runway, never the grass strip
    if (r.lane && r.lane.grass) {
      this.releaseLane();
      this.requestLane();
    }
    r.glideApp = true;
    r.dsMode = null;
    r.dsLvl = null;
    r.dsUF = null;
    this.setRtbPhase('glide');
    if (dead && (p.gearGone || this.dsPlan().exMin < -DS_HOPELESS)) this.dsStartDitch(p.gearGone ? 'gear' : 'reach');
    return true;
  }

  // The switches, for the circuit: the bottle, the radiator, no boost.
  rtbSystems() {
    const p = this.plane;
    if (p.burning && p.extinguishers > 0) p.useExtinguisher();
    // (a stopped engine needs no cooling, and the flap is drag)
    if (this.rtb && this.rtb.deadstick) p.setRadiator(0);
    else if (p.engineTemp > 0.8) p.setRadiator(1);
    else if (p.engineTemp < 0.55) p.setRadiator(0.4);
    if (p.wep) p.setWep(false);
    p.setAirbrake(this.wantBrake);
    // Legs out and running away past their limit wherever the plan has
    // gone (a defence on the way home, a recovery, a dodge): up they come
    // before the airflow takes them. Never on a final or in the flare —
    // there the airbrake and the throttle hold the speed, and a gear coming
    // up at 30 m is a belly landing.
    const ph = this.rtb && this.rtb.phase;
    if (p.gear && !p.onGround && !p.gearGone && ph !== 'final' && ph !== 'flare' &&
      p.ias > p.gearLim.vle * 1.02) p.toggleGear();
    // ...and a stage of flap the airspeed has run up to its limit comes in
    // before the airflow takes it (the limits are the handbook's, indicated:
    // planes.js flapRipOf)
    const rip = p.spec.flapRip;
    if (rip && p.flaps > 0 && !p.onGround && p.ias > rip[p.flaps - 1] * 0.93) p.setFlaps(p.flaps - 1);
  }

  // Lower the gear once slow enough for it, and walk the flaps out to `want`
  // a stage at a time, each below its own limit.
  rtbConfigure(gearDown, flapsWant) {
    const p = this.plane;
    const v = p.speed;
    // (a let-down that is picking up speed is no time to put them out; one
    // that ran away past the limit with them out has them brought up by
    // rtbSystems)
    if (gearDown && !p.gear && !p.gearGone && p.ias < p.gearLim.vlo * 0.95 &&
      !(this.rtb && this.rtb.phase === 'transit' && p.vel.y < -4)) p.toggleGear();
    // (and an aeroplane told to clean up raises them, not above the circuit)
    else if (!gearDown && p.gear && !p.onGround && this.rtb && this.rtb.phase === 'transit' &&
      p.ias > p.gearLim.vle * 0.9) p.toggleGear();
    const rip = p.spec.flapRip || [70, 55, 42];
    if (p.flaps < flapsWant && p.ias < rip[Math.min(2, p.flaps)] * 0.88) p.setFlaps(p.flaps + 1);
    else if (p.flaps > flapsWant && v > this.stallSpeed() * 1.3) p.setFlaps(p.flaps - 1);
  }

  // Throttle (and the airbrake) to hold an airspeed: the landing suite's PI.
  rtbSpeed(target, dt, brakeOver = 6) {
    const r = this.rtb;
    const p = this.plane;
    const err = target - p.speed;
    r.integ = clamp(r.integ + err * dt * 0.08, -0.3, 0.6);
    p.throttle = clamp(0.35 + err * 0.12 + r.integ, 0, 1);
    this.wantBrake = err < -brakeOver;
    // with the gear out, its limit is the speed limit
    if (p.gearPos > 0 && p.ias > p.gearLim.vle * 0.95) {
      p.throttle = 0;
      this.wantBrake = true;
    }
  }

  // Aim the instructor along a flight path: horizontally at (tx, tz), at a
  // vertical speed vyDes.
  rtbAim(tx, tz, vyDes) {
    const p = this.plane;
    const pos = p.position;
    const L = Math.max(60, Math.hypot(tx - pos.x, tz - pos.z));
    const v = Math.max(p.speed, 1);
    const pathAngle = Math.asin(clamp(vyDes / v, -0.6, 0.6));
    this.steerPoint.set(tx, pos.y + L * Math.tan(clamp(pathAngle + p.aoa, -1.2, 1.2)), tz);
  }

  // Keep clear of other aeroplanes in the circuit. For everybody within
  // 500 m, the closest approach over the next seven seconds at present
  // velocities; inside 70 m of a miss, turn away from where he will be and
  // split vertically, harder the nearer and sooner: whoever will be the
  // higher at the closest approach climbs and the lower one descends (the
  // lower id climbs only when they will be level), so the split never has
  // the two of them steering through each other's height. Both sides of a
  // head-on break to their own right.
  //
  // A departure does not dodge this field's own landers on the final or in
  // the flare: they fly a fixed lane parallel to its own, so the lanes are
  // the separation, and a dodge computed from a lander's sideways drift
  // while it is still lining up steered climbers straight onto its lane.
  rtbSeparate() {
    const p = this.plane;
    const pos = p.position;
    const vel = p.vel;
    const climbing = this.rtb && this.rtb.phase === 'climbout';
    for (const o of this.battle.planes || []) {
      if (o === p || !o.alive || o.onGround || !o.vel) continue;
      if (climbing && o._rtbField === this.rtb.af && (o._rtbPhase === 'final' || o._rtbPhase === 'flare')) continue;
      const rx = o.position.x - pos.x;
      const ry = o.position.y - pos.y;
      const rz = o.position.z - pos.z;
      if (rx * rx + ry * ry + rz * rz > 500 * 500) continue;
      const vx = o.vel.x - vel.x;
      const vy = o.vel.y - vel.y;
      const vz = o.vel.z - vel.z;
      const vv = vx * vx + vy * vy + vz * vz;
      const tca = vv > 1e-3 ? clamp(-(rx * vx + ry * vy + rz * vz) / vv, 0, 7) : 0;
      const mx = rx + vx * tca;
      const my = ry + vy * tca;
      const mz = rz + vz * tca;
      const miss = Math.sqrt(mx * mx + my * my + mz * mz);
      if (miss > 70) continue;
      const k = (1 - miss / 70) * (1 - tca / 8);
      let ax = -mx;
      let az = -mz;
      if (ax * ax + az * az < 100) {
        // (nearly) dead on: break to the right
        ax = -vel.z;
        az = vel.x;
      }
      const len = Math.hypot(ax, az) || 1;
      this.steerPoint.x += (ax / len) * 240 * k;
      this.steerPoint.z += (az / len) * 240 * k;
      // my = his height relative to mine at the closest approach
      const up = Math.abs(my) > 4 ? (my < 0 ? 1 : -1) : (p.id < o.id ? 1 : -1);
      this.steerPoint.y += up * 70 * k;
    }
  }

  // Ground and buildings ahead along the flight path. Returns the margin.
  rtbTerrainGuard(look, minMargin) {
    const p = this.plane;
    const pos = p.position;
    const vx = p.vel ? p.vel.x : p.dir.x * p.speed;
    const vy = p.vel ? p.vel.y : p.dir.y * p.speed;
    const vz = p.vel ? p.vel.z : p.dir.z * p.speed;
    const lx = pos.x + vx * look;
    const lz = pos.z + vz * look;
    const ly = pos.y + vy * look;
    const margin = ly - Math.max(groundHeightAt(lx, lz), obstacleTopAt(lx, lz, 10));
    if (margin < minMargin) {
      this.steerPoint.set(
        pos.x + p.dir.x * 140,
        pos.y + (margin < minMargin * 0.5 ? 120 : 70),
        pos.z + p.dir.z * 140,
      );
      p.throttle = 1;
      this.wantBrake = false;
    }
    return margin;
  }

  // Highest solid ground over the next `dist` metres toward (tx, tz).
  rtbGroundAhead(tx, tz, dist) {
    const pos = this.plane.position;
    const hx = tx - pos.x;
    const hz = tz - pos.z;
    const len = Math.hypot(hx, hz) || 1;
    let top = -Infinity;
    for (let k = 0; k <= dist; k += 50) {
      const x = pos.x + (hx / len) * k;
      const z = pos.z + (hz / len) * k;
      top = Math.max(top, groundHeightAt(x, z), obstacleTopAt(x, z, 8));
    }
    return top;
  }

  rtbAir(dt) {
    const r = this.rtb;
    const p = this.plane;
    const pos = p.position;
    const d = r.d;
    // set by the glide pilot (dsPilot) when it has flown this frame itself
    this._dsFlown = false;
    // off the wheels again: a bounce on the roll-out flies the flare again,
    // a takeoff becomes the climb-out
    if (r.phase === 'rollout' || r.phase === 'service' || r.phase === 'lineup' || r.phase === 'turn') {
      this.setRtbPhase('flare');
    } else if (r.phase === 'takeoff') {
      this.setRtbPhase('climbout');
      if (r.log.airborne == null) r.log.airborne = this.clock;
    }
    const u = (pos.x - r.xTd) * d;
    const w = pos.z - r.laneZ;
    const v = p.speed;
    const surfY = groundHeightAt(pos.x, pos.z);
    const agl = pos.y - surfY;
    const vsNow = p.stallSpeedNow();
    const vsClean = this.stallSpeed();
    const lim = p.gearLim;
    this.wantBrake = false;
    this.hardTurn = 0;
    this.chasing = false;
    // a pattern speed: slow enough for the gear, with a margin over the stall
    const vPat = clamp(vsClean * 1.6, vsClean * 1.4, lim.vlo * 0.92);

    // A departure is recovered first, wherever in the circuit it happens.
    if ((p.spinning || p.stalled) && r.phase !== 'flare') {
      this.recover(agl);
      p.steerTowards(this.steerPoint, dt);
      this.rtbSystems();
      return true;
    }

    let guard = true; // the terrain guard, off for the deliberate descent
    let separate = true;
    switch (r.phase) {
      case 'transit': {
        // Under fire on the way home: defend, as before, until it is safe to
        // carry on. Committed once it is in the circuit proper.
        if (this.threat && this.threat.alive && this.threatLevel > 0.45 && u > 900) {
          this.defend();
          // a defence is flown clean: full power with the legs hanging out
          // ran them past their limit
          if (p.gear) p.toggleGear();
          if (p.flaps > 0 && v > vsClean * 1.3) p.setFlaps(p.flaps - 1);
          break;
        }
        // An emergency asks for its lane from anywhere on the way home and
        // flies the glide approach the moment it has one (with no lane yet
        // it carries on to the gate and the stack, kept high enough to glide
        // the rest if the engine stops: below).
        if (r.prio < 0) {
          if (!r.lane && (r.laneAsk -= dt) <= 0) {
            r.laneAsk = 0.5;
            this.requestLane();
          }
          if (r.lane && !(r.dsWait > 0)) {
            if (!r.approachOk) return this.abortRTB('approach');
            this.startDeadstick();
            return this.rtbAir(dt);
          }
        }
        // With a ground war under the circuit, no lane is waited for over
        // the front: ask from anywhere, and with none go straight to the
        // stack (which is out of the armour's square).
        if (r.box && !r.lane) {
          if ((r.laneAsk -= dt) <= 0) {
            r.laneAsk = 0.5;
            this.requestLane();
          }
          if (!r.lane) {
            this.setRtbPhase('hold');
            break;
          }
        }
        const gx = r.xTd + d * r.gateU;
        const gz = r.laneZ + r.side * RTB_GATE_W;
        const dist = Math.hypot(gx - pos.x, gz - pos.z);
        // above the circuit height until close to the gate: the other side's
        // circuit is in the same sky, and its finals are below that. The two
        // sides' transits cross in the middle of the map, so they cross at
        // different heights: the -z side's 35 m above the +z side's.
        const far = dist > 900 ? 45 + (r.side < 0 ? 35 : 0) : 15;
        const gy = Math.max(r.levelY + far, this.rtbGroundAhead(gx, gz, 600) + 55);
        const inbound = (p.vel.x * -d) / Math.max(1, Math.hypot(p.vel.x, p.vel.z));
        // straight in: well out on the approach side, heading for the field,
        // and close enough to the centreline to join it without a big turn
        // ...and low enough to let down onto the glide path from there
        // (and not from so far out that it would come through the other
        // side's circuit to get there)
        const straightIn = u > 450 * r.circK + 1.15 * Math.abs(w) && u < r.gateU - 50 && inbound > 0.35 &&
          pos.y < r.levelY + 40 + Math.max(0, u - r.finalU) * 0.09;
        const atGate = dist < 200 || (u > r.gateU - 100 && Math.abs(w - r.side * RTB_GATE_W) < 150 &&
          Math.abs(u - r.gateU) < 250);
        if (atGate && pos.y > gy + 60 && !r.lane) {
          // arrived high with no lane: into the hold (it spirals down there)
          this.setRtbPhase('hold');
          break;
        }
        if ((straightIn || atGate) && (r.laneAsk -= dt) <= 0) {
          r.laneAsk = 0.5;
          if (this.requestLane()) {
            // a field with a hill in front of it too steep to clear
            if (!r.approachOk) return this.abortRTB('approach');
            // (from the gate only off its far side, and not while heading
            // away from the field: a turn-in started on the near side of the
            // ring is a 180 that ends on short finals, and one started on the
            // way out swings wide into the other side's circuit; nor from its
            // outer edge, which on the widest ring is ~460 m off the line and
            // still converging when the final starts — the grass strip's 4 m
            // tolerance then sent the same aeroplane round four times)
            if (this.baseClear() &&
              (straightIn || (u > r.gateU - 80 && inbound > -0.25 && Math.abs(w) < RTB_GATE_W + 90)) &&
              pos.y < r.levelY + 55) {
              r.integ = 0;
              this.setRtbPhase('base');
              break;
            }
            // somebody of ours is turning in, or still well out on finals
            // where this turn would cross him, or this is the wrong side of
            // the ring: a lap of the gate (its own ring, below) first
            r.gateWait = (r.gateWait || 0) + 0.5;
          } else if (atGate) {
            // no lane yet: into the stack. (With one, never: the old order
            // sent a lane-holder that could not turn in yet to the hold for
            // half a second at a time, climbing toward the stack, until it
            // was too high to turn in at all.)
            this.setRtbPhase('hold');
            break;
          }
        }
        // toward the gate, letting down at no more than about 7 degrees (or,
        // held at the gate with a lane, round it)
        let gyRing = gy;
        let ahead = Math.min(400, dist);
        let hx = (gx - pos.x) / Math.max(dist, 1);
        let hz = (gz - pos.z) / Math.max(dist, 1);
        if (r.lane && dist < 420) {
          // one ring per lane, 50 m apart, so two planes waiting their turn
          // here are never on the same circle — and the widest still 40 m
          // short of the centreline, which is the other side's business
          const li = Math.max(0, lanesOf(r.af).lanes.indexOf(r.lane));
          const ring = 110 + 50 * li;
          // ...and 15 m of height between the rings as well
          gyRing = gy + 15 * li;
          const ang = Math.atan2(pos.z - gz, pos.x - gx) + 0.6 * r.side;
          const sx = gx + Math.cos(ang) * ring - pos.x;
          const sz = gz + Math.sin(ang) * ring - pos.z;
          ahead = Math.max(80, Math.hypot(sx, sz));
          hx = sx / ahead;
          hz = sz / ahead;
        }
        let ty = gyRing;
        if (pos.y > gyRing) ty = Math.max(gyRing, pos.y - ahead * 0.12);
        else ty = Math.min(gyRing, pos.y + ahead * 0.15);
        // a big change of heading is flown as a level turn: letting down at
        // the same time is a descending spiral the bank limiter can only
        // shallow out, never stop
        const vh = Math.hypot(p.vel.x, p.vel.z);
        if (vh > 1 && (p.vel.x * hx + p.vel.z * hz) / vh < 0.5) ty = Math.max(ty, pos.y);
        // Never down through the holding stack: level until clear of its
        // orbit. (A holder handed a lane leaves from its own level, and the
        // levels under it are still circling there.)
        const hc = this.rtbHoldCentre();
        if (Math.hypot(pos.x - hc.x, pos.z - hc.z) < RTB_HOLD_R + 120) ty = Math.max(ty, pos.y);
        // an emergency waiting for its lane: never lower than the height that
        // would glide it the rest of the way (climbing to it gently)
        if (r.prio < 0) {
          const floor = Math.min(CEILING, pos.y - this.dsPlan().ex + DS_EX_TARGET);
          ty = Math.max(ty, Math.min(floor, pos.y + ahead * 0.15));
        }
        this.steerPoint.set(pos.x + hx * ahead, ty, pos.z + hz * ahead);
        if (dist > 1400) {
          p.throttle = 0.85;
          this.wantBrake = v > vPat * 1.9;
        } else {
          this.rtbSpeed(dist > 700 ? vPat * 1.15 : vPat, dt, 8);
        }
        this.rtbConfigure(dist < 900, dist < 900 ? 1 : 0);
        break;
      }
      case 'hold': {
        r.holdT += dt;
        r.log.holdT = r.holdT;
        if (r.holdT > (r.prio >= 2 ? RTB_HOLD_MAX_IDLE : RTB_HOLD_MAX)) return this.abortRTB('no lane');
        if ((r.laneAsk -= dt) <= 0) {
          r.laneAsk = 0.5;
          if (this.requestLane()) {
            if (!r.approachOk) return this.abortRTB('approach');
            r.holdLevel = null;
            // (an emergency glides in from the stack: it is up there with
            // the height to do it)
            if (r.prio < 0) {
              this.startDeadstick();
              return this.rtbAir(dt);
            }
            this.setRtbPhase('transit');
            break;
          }
        }
        // An orbit well clear of the gate (the gate's own orbit, where a
        // plane with a lane lets down, does not touch it), kept well inside
        // the map walls whichever field this is. Each holder keeps its own
        // level, 38 m apart, from entry until it gets a lane: a stack, not a
        // queue that reshuffles heights every time somebody leaves it.
        const hc = this.rtbHoldCentre();
        const cx = hc.x;
        const cz = hc.z;
        const st = lanesOf(r.af);
        if (r.holdLevel == null) {
          const taken = new Set();
          for (const o of st.holders || []) {
            if (o !== this && o.rtb && o.rtb.phase === 'hold' && o.plane.alive && o.rtb.holdLevel != null) {
              taken.add(o.rtb.holdLevel);
            }
          }
          let lv = 0;
          while (taken.has(lv)) lv++;
          r.holdLevel = lv;
          st.holders = (st.holders || []).filter((o) => o.rtb && o.rtb.phase === 'hold' && o.plane.alive);
          st.holders.push(this);
        }
        const R = RTB_HOLD_R;
        const ang = Math.atan2(pos.z - cz, pos.x - cx) + 0.55 * r.side;
        // (the stack starts above every transit height, so nobody letting
        // down to the gate or passing on the way to it flies through it)
        const ty = Math.max(r.levelY + 110 + 38 * r.holdLevel, this.rtbGroundAhead(cx, cz, 400) + 60);
        const sx = cx + Math.cos(ang) * R;
        const sz = cz + Math.sin(ang) * R;
        // a gentle spiral, never a dive: at most ~6 degrees down, 9 up
        const reach = Math.max(80, Math.hypot(sx - pos.x, sz - pos.z));
        this.steerPoint.set(sx, clamp(ty, pos.y - reach * 0.1, pos.y + reach * 0.16), sz);
        this.rtbSpeed(vPat * 1.12, dt, 8);
        this.rtbConfigure(false, 1);
        break;
      }
      case 'base': {
        // Intercept the extended centreline like a localizer: a track toward
        // it of atan(w / 150), never steeper than 60 degrees, measured from
        // the landing heading. From an outbound leg the aim point is behind
        // and this is the 180; from abeam it is a 60-degree cut that has the
        // aeroplane on the centreline well before the final starts; close in
        // it is the same proportional law the final flies.
        const L = 300;
        const ax = pos.x - d * L;
        const az = pos.z - L * clamp(w / 120, -2.1, 2.1);
        const vyHold = clamp((Math.max(r.levelY, this.rtbGroundAhead(ax, az, 400) + 45) - pos.y) * 0.3, -4, 3);
        this.rtbAim(ax, az, vyHold);
        this.rtbSpeed(vPat, dt);
        this.rtbConfigure(true, 2);
        const track = Math.atan2(p.vel.z, p.vel.x * -d); // 0 = straight down the approach
        if (Math.abs(w) < 45 && Math.abs(track) < 0.35 && u > 350 * r.circK) {
          r.integ = 0;
          this.setRtbPhase('final');
        } else if (u < 380 * r.circK || r.phaseT > 75) {
          if (!this.rtbGoAround(u < 380 * r.circK ? 'base: not lined up' : 'base: too long')) return false;
        }
        break;
      }
      case 'glide': {
        // the glide approach to its final (rtbGlide); its own terrain sense
        guard = false;
        this.rtbGlide(dt);
        break;
      }
      case 'final':
      case 'flare': {
        guard = false;
        separate = false;
        if (r.glideApp) {
          this.dsFinal(dt);
          break;
        }
        const vApp = Math.max(vsNow * 1.3, Math.min(lim.vlo * 0.92, vsNow * 1.45));
        const target = p.gearPos < 1 ? Math.min(vApp, lim.vlo * 0.95) : vApp;
        if (r.phase === 'flare') {
          p.throttle = 0;
          this.wantBrake = false;
        } else {
          this.rtbSpeed(target, dt);
        }
        this.rtbConfigure(true, p.gearPos >= 1 ? 3 : 2);
        if (!r.configured && p.gearPos >= 1 && p.flaps === 3 && v < vApp + 4) r.configured = true;
        const rh = p.rideHeight(0);
        const gsY = r.runwayY + rh + Math.max(0, u) * r.tanG;
        let pathY = r.configured ? Math.min(gsY, r.levelY) : r.levelY;
        // terrain clearance on the way in: no glide path into a hill short of
        // the field
        for (let k = 0; k <= 360; k += 30) {
          const sxk = pos.x - d * k;
          if ((sxk - r.xThr) * d < 40) break;
          pathY = Math.max(pathY, groundHeightAt(sxk, r.laneZ) + rh + 9 + k * 0.02);
        }
        // Wheels above whatever they are about to land on: the platform, or
        // the ground under them where that stands higher (a hill short of the
        // field is not to be flared onto, nor flown into).
        const hWheel = pos.y - Math.max(surfY, r.runwayY) - rh;
        let vyDes;
        if (r.phase === 'final') {
          vyDes = (r.configured ? -v * r.tanG : 0) + clamp((pathY - pos.y) * 0.35, -4, 4);
          if (u < 0) vyDes = Math.max(vyDes, -1.2);
          if (hWheel < 7 && u < r.tdIn + 120) this.setRtbPhase('flare');
          // the go-around gates: not configured, off the centreline, high,
          // or running out of runway in the air
          const kC = r.circK;
          const off = Math.abs(w) > (u < 250 * kC ? (r.grass ? 4 : 9) : 30);
          const high = pos.y - gsY > (u < 250 * kC ? 18 : 40);
          // sinking into rising ground short of the field
          const low = pos.y - surfY - rh < 3 && u > r.tdIn + 100;
          const wayHigh = u < r.gateU + 100 && pos.y - gsY > 90;
          // somebody (the player, a wreck) has turned up on this lane since it
          // was handed out: not a landing to continue
          let blocked = false;
          if (u < 600) {
            r.blockT = (r.blockT || 0) - dt;
            if (r.blockT <= 0) {
              r.blockT = 0.5;
              blocked = this.laneObstructed(r.laneZ);
            }
          }
          if ((u < 300 * kC && !r.configured) || (u < 400 * kC && off) || (u < 300 * kC && high) || u < -120 || low || wayHigh ||
            blocked) {
            const why = blocked ? 'runway blocked' : u < -120 ? 'long' : low ? 'terrain' : wayHigh ? 'high'
              : !r.configured ? 'not configured' : off ? 'off centreline' : 'high';
            if (!this.rtbGoAround(why)) return false;
            break;
          }
        }
        if (r.phase === 'flare') {
          vyDes = -clamp(0.25 + hWheel * 0.32, 0.25, 2.5);
          // floated past where the roll-out still fits (hard braking, a
          // margin), or drifted off the lane: go round
          const remain = (pos.x - (r.edgeOuter + d * 28)) * d;
          if (remain < (v * v) / 7 + 25 || Math.abs(w) > (r.grass ? 3.5 : 8)) {
            if (!this.rtbGoAround(Math.abs(w) > (r.grass ? 3.5 : 8) ? 'flare: off the lane' : 'flare: floated')) return false;
            break;
          }
        }
        const L = 220;
        // Aim down the lane: a PD on the lateral error, w and its rate (the
        // lateral speed). 3 m of aim per metre off and 1.5 per m/s closing is
        // a 2.5-3 s, well-damped closure for every type at approach speed —
        // the landing suite's 1.4 / 0.8 was five or six seconds per e-fold,
        // which a straight-in from 2 km can afford and a 600 m final cannot.
        const az = pos.z - clamp(3 * w + 1.5 * p.vel.z, -154, 154);
        this.rtbAim(pos.x - d * L, az, vyDes);
        break;
      }
      case 'goaround': {
        p.throttle = 1;
        this.wantBrake = false;
        // climb straight ahead, clean up a stage, then back round to the gate
        const ty = pos.y + 300 * Math.tan(v > vsNow * 1.2 ? 0.14 : 0.04);
        this.steerPoint.set(pos.x - d * 300, ty, r.laneZ + r.side * 40);
        this.rtbConfigure(true, Math.min(p.flaps, 2));
        const edgeRoom = (pos.x - r.edgeOuter) * d; // metres to the map-edge end
        if ((agl > 40 && p.vel.y > 0) || r.phaseT > 9 || edgeRoom < 260) {
          r.configured = false;
          this.setRtbPhase('transit');
        }
        break;
      }
      case 'climbout': {
        p.throttle = 1;
        this.wantBrake = false;
        const climb = v > vsNow * 1.25 ? 0.16 : 0.05;
        this.steerPoint.set(pos.x + d * 300, pos.y + 300 * Math.tan(climb), r.laneZ);
        if (p.gear && agl > 12 && p.vel.y > 0) p.toggleGear();
        if (p.flaps >= 2 && agl > 25 && v > vsNow * 1.3) p.setFlaps(1);
        else if (p.flaps === 1 && agl > 45 && v > vsClean * 1.35) p.setFlaps(0);
        // the lane is free once this aeroplane is clear above its far end
        if (r.lane && (agl > 60 || (agl > 20 && (pos.x - r.edgeInner) * d > 0))) this.releaseLane();
        if (agl > 110 || (pos.x - r.xThr) * d > 1000 || r.phaseT > 40) {
          this.finishRTB();
          // this frame's stick still has to come from somewhere
          p.steerTowards(this.steerPoint, dt);
          this.rtbSystems();
          return true;
        }
        guard = agl > 30;
        separate = agl > 30;
        break;
      }
      default:
        this.setRtbPhase('transit');
        break;
    }

    // the glide pilot has set the stick itself (its paths and its sites are
    // inside the walls, and it has its own sense of the ground)
    if (this._dsFlown) {
      this.hardTurn = 0;
      this.rtbSystems();
      return true;
    }
    if (separate) this.rtbSeparate();
    if (guard) this.rtbTerrainGuard(2.5, 22);
    // The walls of the map are as hard in the circuit as anywhere: one met at
    // speed takes the speed with it. Six seconds ahead is the turn's warning.
    if (r.phase !== 'final' && r.phase !== 'flare' && r.phase !== 'climbout') {
      // (the stack's circle is laid out inside them: two seconds' warning)
      const look = r.phase === 'hold' ? 2 : 6;
      const fx = pos.x + p.vel.x * look;
      const fz = pos.z + p.vel.z * look;
      if (Math.abs(fx) > 1130 || Math.abs(fz) > 1130) {
        // (a glide has no height to give the turn: it keeps its descent)
        const ty = r.phase === 'glide' ? this.steerPoint.y : Math.max(this.steerPoint.y, pos.y);
        this.steerPoint.set(pos.x * 0.4, ty, pos.z * 0.4);
      }
    }
    const off = p.steerTowards(this.steerPoint, dt);
    this.hardTurn = clamp(off / 1.2, 0, 1);
    this.rtbSystems();
    return true;
  }

  // The centre of this field's holding stack (shared by every holder: it is
  // measured from the field's centreline, not from anybody's lane).
  rtbHoldCentre() {
    const r = this.rtb;
    const h = this._holdC || (this._holdC = { x: 0, z: 0 });
    if (r.box) {
      h.x = Math.sign(r.af.x || -r.d) * (r.box + RTB_HOLD_BOX);
      h.z = r.side * (r.box + RTB_HOLD_BOX);
    } else {
      h.x = clamp(r.xTd + r.d * RTB_HOLD_U, -900, 900);
      h.z = clamp(r.af.z + r.side * RTB_HOLD_W, -900, 900);
    }
    return h;
  }

  // ---- the glide approach (an engine stopped, or about to) ----

  // The glide numbers for this aeroplane as it is now (re-read every second):
  // the speed it is flown at (best glide clean, never under 1.35 x the clean
  // stall), the radius of a DS_BANK turn there, the slopes of a straight and
  // of a turning glide, clean, and how far out the final starts.
  dsGlideParams() {
    const r = this.rtb;
    const p = this.plane;
    const g = r.dsG || (r.dsG = { t: -Infinity });
    if (this.clock - g.t < 1) return g;
    g.t = this.clock;
    const bg = p.bestGlide(0, 0, false);
    g.vs = p.stallSpeedAt(0);
    g.vT = Math.max(bg.v, g.vs * 1.35);
    g.R = (g.vT * g.vT) / (GRAV * Math.tan(DS_BANK));
    g.tanStr = p.glideTanN(g.vT, 1, 0, 0, false);
    g.tanTurn = p.glideTanN(g.vT, 1 / Math.cos(DS_BANK), 0, 0, false);
    g.Rt = (g.vT * g.vT) / (GRAV * Math.tan(DS_BANK_TIGHT));
    g.tanTurnT = p.glideTanN(g.vT, 1 / Math.cos(DS_BANK_TIGHT), 0, 0, false);
    g.uK = clamp(g.vT * DS_UK_K, DS_UK_MIN, DS_UK_MAX);
    // the final's speed (1.34 x the landing-flap stall): the height in hand
    // counts the speed over it as height (it is lost on the way in: the
    // committed approach slows to it near the final, dsPilot)
    g.vF = p.stallSpeedAt(3) * 1.34;
    // what the gear, and the gear and a stage of flap, add to the slope
    g.dT1 = p.glideTanN(g.vT, 1, 0, 1, false) - g.tanStr;
    g.dT2 = p.glideTanN(g.vT, 1, 1, 1, false) - g.tanStr;
    g.dT3 = p.glideTanN(g.vT, 1, 2, 1, true) - g.tanStr;
    // what an engine still running at idle takes off the slope (none dead)
    g.idle = Math.max(0, g.tanStr - p.glideTan(g.vT, 0, 0, false));
    // the height a lap of the orbit costs, and the most the longest
    // downwind leg can take off (out and back)
    g.lap = TWO_PI * g.R * g.tanTurn * DS_PLAN;
    g.cap = 2 * DS_DOWNWIND_MAX * g.tanStr;
    return g;
  }

  // The aeroplane's track, as a yaw (dir = (sin yaw, y, cos yaw)).
  dsHeading() {
    const p = this.plane;
    return Math.hypot(p.vel.x, p.vel.z) > 1 ? Math.atan2(p.vel.x, p.vel.z) : Math.atan2(p.dir.x, p.dir.z);
  }

  // The arithmetic. E: the height in hand over the runway (the wheels), the
  // speed over the glide speed counted as height. For a final starting `uF`
  // out on the centreline: need, what the shortest way there (dubins, at the
  // glide's own turn radius, legs and turns at their own slopes) and the
  // final from it cost; ex = E - need, and exMin the same with the cleanest
  // final there is. Without uF the best of three finals: the longest with
  // height to spare, or else the least short.
  dsPlan(uF = null) {
    const r = this.rtb;
    const p = this.plane;
    const pos = p.position;
    const g = this.dsGlideParams();
    const v = p.speed;
    const E = pos.y - r.runwayY - r.wheelOff + (v * v - g.vF * g.vF) / (2 * GRAV);
    const psi = this.dsHeading();
    const psiF = Math.atan2(-r.d, 0);
    // Each final is tried at the glide's own turn (DS_BANK) and at a tight
    // one (DS_BANK_TIGHT, a steeper turning glide): close in, the wide turn
    // can need a whole loop where the tight one still makes it.
    const one = (uf) => {
      const fx = r.xTd + r.d * uf;
      // (committed, the way round it is already flying is kept for any
      // final it re-plans to, unless another is clearly shorter: a plan
      // that flips between ways round mid-turn flies neither)
      const mine = uf === r.dsUF || r.dsMode === 'icpt';
      let path = dubins(pos.z, pos.x, psi, r.laneZ, fx, psiF, g.R, mine && !r.dsTight ? r.dsWord || null : null, {});
      let legs = (path.arc * g.tanTurn + path.straight * g.tanStr) * DS_PLAN;
      let R = g.R;
      const pt = dubins(pos.z, pos.x, psi, r.laneZ, fx, psiF, g.Rt, mine && r.dsTight ? r.dsWord || null : null, {});
      const lt = (pt.arc * g.tanTurnT + pt.straight * g.tanStr) * DS_PLAN;
      // (the tight turn only when it saves real height, and kept once chosen
      // unless the wide one is clearly better again)
      if (lt < legs - (mine ? (r.dsTight ? -15 : 15) : 8)) {
        path = pt;
        legs = lt;
        R = g.Rt;
      }
      const need = legs + uf * DS_TAN_FINAL;
      return { uF: uf, E, need, ex: E - need, exMin: E - legs - uf * DS_TAN_FINAL_MIN, path, R, g };
    };
    if (uF != null) return one(uF);
    let best = null;
    // (and, close in, the centreline further in than that: a final joined
    // where the aeroplane can still turn onto it, rather than a loop for
    // the one it has just missed)
    const cands = [g.uK, Math.round(g.uK * 0.75), Math.max(150, Math.round(g.uK * 0.55))];
    const u = (pos.x - r.xTd) * r.d;
    for (const k of [60, 130, 210]) if (u - k > 100 && u - k < g.uK * 0.55) cands.push(Math.round(u - k));
    for (const uf of cands) {
      const c = one(uf);
      if (!best || (c.ex >= 0 && best.ex < 0) || (c.ex < 0 && best.ex < 0 && c.ex > best.ex)) best = c;
    }
    return best;
  }

  // May a glide approach turn onto its final now? Not across another of this
  // field's landers turning in or out on a long final, nor head-on into a
  // departure on its roll or low on the climb-out. (Asked only while there is
  // an engine to wait with: without one the height decides.)
  dsClear() {
    const r = this.rtb;
    for (const l of lanesOf(r.af).lanes) {
      const o = l.owner;
      if (!o || o === this || !o.rtb || !o.plane.alive) continue;
      const ph = o.rtb.phase;
      if (ph === 'base') return false;
      if (ph === 'final' && (o.plane.position.x - o.rtb.xTd) * o.rtb.d > 200) return false;
      if (ph === 'glide' && o.rtb.dsMode === 'icpt') return false;
    }
    for (const o of this.battle.planes || []) {
      if (!o || o === this.plane || !o.alive || o._rtbField !== r.af) continue;
      if (o._rtbPhase === 'takeoff') return false;
      if (o._rtbPhase === 'climbout' && o.position.y - r.runwayY < 100 &&
        (o.position.x - r.xThr) * r.d < 1100) return false;
    }
    return true;
  }

  // The glide approach to its final. Two ways of flying it: round the burn-
  // off orbit ('orbit': a circle of the glide's own turn radius tangent to
  // the extended centreline at the final's start, on the side away from the
  // stack, flown so that it is heading in at the tangent point) while the
  // height in hand is more than the way in needs, or waiting for a lane; and
  // committed ('icpt': the turn-straight-turn path to the final's start,
  // re-planned every frame from where the aeroplane actually is, so whatever
  // the glide gains or loses on the plan is put right as it happens). The
  // orbit is left the moment the path from wherever it has got to costs no
  // more than the height there is: that moment comes continuously, not once
  // a lap. Height to spare on the committed path goes on the gear and a stage
  // of flap; height short, while there is an engine, on the throttle. Short
  // of even the cleanest way in with no engine: a forced landing (dsDitch).
  rtbGlide(dt) {
    const r = this.rtb;
    const p = this.plane;
    const pos = p.position;
    const d = r.d;
    if (r.dsMode === 'ditch') {
      this.dsDitch(dt);
      return;
    }
    if (!r.lane && (r.laneAsk -= dt) <= 0) {
      r.laneAsk = 0.5;
      this.requestLane();
    }
    const g = this.dsGlideParams();
    const power = !r.deadstick && p.engineHealth() > 0;
    const u = (pos.x - r.xTd) * d;
    const w = pos.z - r.laneZ;
    const hR = pos.y - r.runwayY - r.wheelOff;
    const track = Math.atan2(p.vel.z, p.vel.x * -d); // 0 = straight down the approach
    // lined up and low over the approach, however it got there: the final
    if (r.lane && hR < 35 && u > 60 && u < g.uK + 80 && Math.abs(w) < 25 && Math.abs(track) < 0.4 && this.dsFinalFits(u)) {
      this.dsToFinal(dt, u);
      return;
    }
    let plan;
    if (r.dsMode === 'icpt' && r.dsUF != null) {
      plan = this.dsPlan(r.dsUF);
      // short of the final it chose: a shorter one, if that is better
      if (plan.ex < -3) {
        const alt = this.dsPlan();
        if (alt.uF < r.dsUF && alt.ex > plan.ex + 3) {
          plan = alt;
          r.dsUF = alt.uF;
        }
      }
    } else {
      plan = this.dsPlan();
    }
    r.dsEx = plan.ex;
    r.dsWord = plan.path.type;
    // out of reach of the runway, with no engine to make up the difference
    // (unless it is as good as on the final already, and that still reaches)
    if (!power && plan.exMin < -DS_HOPELESS) {
      if (r.lane && Math.abs(w) < 45 && Math.abs(track) < 0.6 && u > 60 && u < g.uK + 150 && this.dsFinalReach() > 0) {
        this.dsToFinal(dt, u);
        return;
      }
      this.dsStartDitch('short');
      this.dsDitch(dt);
      return;
    }
    // What drag can still take off on the way in (the gear and a stage of
    // flap over the rest of the path, at 80%, and a little of the final's
    // own spare): a committed approach that is this much high is fine.
    // (an engine still idling pulls against the drag: g.idle)
    const idle = power ? g.idle : 0;
    const absorb = (pl) => (pl.path.arc + pl.path.straight) * Math.max(0, g.dT3 - idle) * 0.7 + pl.uF * 0.05;
    // ...and what S-turns on a long straight leg can (dsWeave: legs ~50
    // degrees either side of the way in fly ~1.5 x the distance)
    const weaveCap = (pl) => Math.max(0, pl.path.straight - 300) * 0.5 * g.tanStr;
    const highCap = (pl) => absorb(pl) + weaveCap(pl);
    if (!r.dsMode) r.dsMode = r.lane && plan.ex <= DS_EX_TARGET + highCap(plan) ? 'icpt' : 'orbit';
    // committed, but far too high for that: back to the orbit (a few times
    // at most)
    if (r.dsMode === 'icpt' && plan.ex > DS_EX_TARGET + highCap(plan) + 30 && (r.dsReorbit || 0) < 3) {
      r.dsReorbit = (r.dsReorbit || 0) + 1;
      r.dsMode = 'orbit';
    }
    // The orbit: a circle of the glide's turn radius over the near end of
    // the approach, on the side away from the stack (its inner edge 60 m off
    // the centreline), flown heading in on its inner side and out on its
    // outer side. A lap costs height in steps of a lap; the downwind leg —
    // out along the outer side's line, then the turn back onto the final when
    // the height and the way back meet — takes off any amount up to the
    // longest leg (g.cap), continuously. So: round the orbit while more than
    // that is left, down the downwind leg (from the top of the orbit, heading
    // out) once it is less, and committed once the way in costs what there is.
    const s = -r.side;
    const cx = r.xTd + d * g.uK * 0.3;
    const cz = r.laneZ + s * (g.R + 60);
    const outb = Math.atan2(d, 0);
    if (r.dsMode === 'orbit' || r.dsMode === 'downwind') {
      const commitAt = DS_EX_TARGET + (r.dsMode === 'orbit' ? absorb(plan) * 0.5 + weaveCap(plan) : 0);
      if (r.lane && plan.ex <= commitAt && (!power || plan.ex < DS_EX_TARGET - 25 || this.dsClear())) {
        r.dsMode = 'icpt';
        r.dsUF = plan.uF;
        r.log.dsCommit = { u: Math.round(u), w: Math.round(w), ex: Math.round(plan.ex), uF: plan.uF };
      } else if (!r.lane && !power && plan.exMin < 5) {
        // no lane came, and the height to wait with is gone
        this.dsStartDitch('no lane');
        this.dsDitch(dt);
        return;
      } else if (r.dsMode === 'orbit') {
        const rO = Math.hypot(pos.x - cx, pos.z - cz);
        if (Math.abs(rO - g.R) < 0.4 * g.R && (pos.z - cz) * s > 0 &&
          Math.abs(wrapAngle(this.dsHeading() - outb)) < 0.6) {
          const pk = plan.uF === g.uK ? plan : this.dsPlan(g.uK);
          if (pk.ex <= DS_EX_TARGET + g.cap) {
            r.dsMode = 'downwind';
            r.dsDwZ = pos.z;
          }
        }
      } else if (u > g.uK + DS_DOWNWIND_MAX && r.lane) {
        // as far out as a downwind leg goes: in now, however high
        r.dsMode = 'icpt';
        r.dsUF = plan.uF;
      }
    }
    let phi;
    if (r.dsMode === 'orbit') {
      phi = this.dsCircle(cx, cz, g.R, s * d);
      this.dsDrag(0);
    } else if (r.dsMode === 'downwind') {
      // out along the line it left the orbit on
      const cross = -(pos.z - r.dsDwZ) * d; // > 0: left of the line
      const want = outb - Math.atan(clamp(cross / 45, -1, 1));
      phi = this.dsBankFor(clamp(0.9 * wrapAngle(want - this.dsHeading()), -0.3, 0.3));
      // far more to lose than the leg wants to be long: the gear
      const pk = plan.uF === g.uK ? plan : this.dsPlan(g.uK);
      this.dsDrag(pk.ex - DS_EX_TARGET > g.cap * 0.5 ? 1 : r.dsDragLvl || 0);
    } else {
      if (r.dsUF == null) r.dsUF = plan.uF;
      phi = this.dsFollow(plan.path, plan.R);
      r.dsTight = plan.R < g.R;
      // More height than the drag can take off, out on a long straight leg:
      // S-turns until it is not (dsWeave keeps the side and the timer).
      const ab = absorb(plan);
      const spareW = plan.ex - DS_EX_TARGET;
      if (r.dsWv) {
        if (spareW < ab * 0.7 - 4 || plan.path.straight < 220) r.dsWv = 0;
      } else if (spareW > ab * 0.7 + 6 && plan.path.straight > 320 && plan.path.t < 0.3) {
        r.dsWv = -r.side;
        r.dsWvT = 0;
      }
      if (r.dsWv) phi = this.dsWeave(dt, plan);
      // on the final's course, at its start: the final
      if (Math.abs(w) < 30 && Math.abs(track) < 0.45 && u > 40 && u < r.dsUF + 60 && this.dsFinalFits(u)) {
        this.dsToFinal(dt, u);
        return;
      }
      // Height to spare on the way in: the gear once the spare is what it
      // would cost over the rest of the way, then a stage of flap the same
      // way (so the drag comes on late and stays on); off again only when
      // clearly short.
      const spare = plan.ex - DS_EX_TARGET;
      const len = plan.path.arc + plan.path.straight;
      const cur = r.dsDragLvl || 0;
      // (and back off a level once what it would still burn is clearly more
      // than the spare — an engine that stops takes its idling pull with it,
      // and the drag that was holding that off is then too much; the gear
      // itself only when clearly short)
      const burn = [0, g.dT1, g.dT2, g.dT3].map((dT) => len * Math.max(0.01, dT - idle));
      let want = cur;
      if (spare > 10 && spare > burn[3] * 0.85) want = 3;
      else if (spare > 8 && spare > burn[2] * 0.85) want = Math.max(cur, 2);
      else if (spare > 5 && spare > burn[1] * 0.85) want = Math.max(cur, 1);
      if (cur >= 2 && spare < burn[cur] * 0.55 - 6) want = cur - 1;
      if (spare < -8) want = Math.max(0, cur - 1);
      this.dsDrag(want);
    }
    // An engine that still runs makes up a shortfall; otherwise it idles —
    // the approach is planned as if it had already stopped.
    p.throttle = power && plan.ex < 0 ? clamp(0.35 - plan.ex * 0.04, 0, 1) : 0;
    // (committed and close in: down to the final's speed, the stall margin
    // kept. Not before: the drag out burns height by the dynamic pressure,
    // and slow, it hardly does)
    let vT = g.vT;
    if (r.dsMode === 'icpt' && plan.path.arc + plan.path.straight < 250) {
      vT = Math.max(g.vF * 1.04, p.stallSpeedNow() * 1.3);
    }
    this.dsPilot(dt, phi, vT);
  }

  // The glide's drag on the way to the final: 0 clean, 1 the gear, 2 the
  // gear and the first stage of flap, 3 the gear, the take-off flap and the
  // airbrake (each within its limit; a stage of flap at a time).
  dsDrag(lvl) {
    const r = this.rtb;
    const p = this.plane;
    r.dsDragLvl = lvl;
    const gearWant = lvl >= 1;
    if (gearWant && !p.gear && !p.gearGone && p.ias < p.gearLim.vlo * 0.95) p.toggleGear();
    else if (!gearWant && p.gear && !p.gearGone) p.toggleGear();
    const rip = p.spec.flapRip || [70, 55, 42];
    const fWant = lvl >= 3 ? 2 : lvl >= 2 ? 1 : 0;
    if (p.flaps < fWant && p.ias < rip[p.flaps] * 0.85) p.setFlaps(p.flaps + 1);
    else if (p.flaps > fWant) p.setFlaps(p.flaps - 1);
    this.wantBrake = lvl >= 3;
  }

  // Height in hand over what the cleanest final from here to the platform
  // costs (clean until the gear has to come down, gear down after): < 0, the
  // runway cannot be made without an engine.
  dsFinalReach() {
    const r = this.rtb;
    const p = this.plane;
    const pos = p.position;
    const v = Math.max(p.speed, 1);
    const u = (pos.x - r.xTd) * r.d;
    const uNear = Math.max(0, (r.edgeInner - r.xTd) * r.d - 15);
    const dist = Math.max(0, u - uNear);
    const gearRun = Math.min(dist, 9 * v);
    const vC = Math.max(v, p.stallSpeedAt(0) * 1.25);
    const need = (dist - gearRun) * p.glideTanN(vC, 1, 0, 0, false) + gearRun * p.glideTanN(vC, 1, 0, 1, false);
    return pos.y - r.runwayY - p.rideHeight(0) - need;
  }

  // Is the height in hand from `u` out one a final can take: not short of
  // the platform (dsFinalReach), and not more than everything out can take
  // off down to the far end of where it may touch down?
  dsFinalFits(u) {
    const r = this.rtb;
    const p = this.plane;
    const v = p.speed;
    const vF = p.stallSpeedAt(3) * 1.34;
    const tTop = p.glideTan(vF / 1.34 * 1.3, 3, 1, true);
    const E = p.position.y - r.runwayY - p.rideHeight(0) + (v * v - vF * vF) / (2 * GRAV);
    return E <= (u + 60) * tTop * 1.12 && this.dsFinalReach() > -2;
  }

  // Onto the final (dsFinal flies it from here).
  dsToFinal(dt, u) {
    const r = this.rtb;
    r.dsLvl = null;
    r.dsVI = 0;
    r.log.dsFinal = { u: Math.round(u), ex: Math.round(r.dsEx || 0) };
    this.setRtbPhase('final');
    this.dsFinal(dt);
  }

  // The bank for a turn rate `om` (rad/s, positive to the LEFT: the yaw
  // growing), never past DS_BANK_MAX.
  dsBankFor(om) {
    const v = Math.max(this.plane.speed, 1);
    return clamp(-Math.atan((v * om) / GRAV), -DS_BANK_MAX, DS_BANK_MAX);
  }

  // Along the first leg of a dubins path: its turn at the path's own radius,
  // or — once that turn is all but done — the last of it in proportion, which
  // leaves the aeroplane on the straight.
  dsFollow(path, R) {
    const v = Math.max(this.plane.speed, 1);
    const s1 = path.firstL ? 1 : -1;
    const om = path.t > 0.12 ? s1 * (v / R) : s1 * Math.min(v / R, path.t * 1.1);
    return this.dsBankFor(om);
  }

  // S-turns on the way in: legs 50 degrees either side of the bearing to the
  // final's start, nine seconds each, so the path is half as long again as
  // the way it covers (the Dubins plan is still re-made every frame, and the
  // S-turns stop as soon as the drag can take off what is left).
  dsWeave(dt, plan) {
    const r = this.rtb;
    const p = this.plane;
    const pos = p.position;
    r.dsWvT = (r.dsWvT || 0) + dt;
    if (r.dsWvT > 9) {
      r.dsWvT = 0;
      r.dsWv = -r.dsWv;
    }
    const brg = Math.atan2(r.xTd + r.d * plan.uF - pos.x, r.laneZ - pos.z);
    const omMax = Math.max(p.speed, 1) / this.dsGlideParams().R;
    return this.dsBankFor(clamp(0.8 * wrapAngle(brg + r.dsWv * 0.87 - this.dsHeading()), -omMax, omMax));
  }

  // Round a circle: centre (cx, cz), radius R, `sig` +1 turning left (the
  // yaw growing), -1 right. Converges onto it from anywhere (a course that
  // aims inside the tangent by the distance off the circle), with the circle's
  // own turn rate fed forward once close.
  dsCircle(cx, cz, R, sig) {
    const pos = this.plane.position;
    const v = Math.max(this.plane.speed, 1);
    const rx = pos.x - cx;
    const rz = pos.z - cz;
    const dist = Math.hypot(rx, rz) || 1;
    const th = Math.atan2(rx, rz);
    const want = th + sig * (Math.PI / 2 + Math.atan(clamp((1.3 * (dist - R)) / R, -1.4, 1.4)));
    const e = wrapAngle(want - this.dsHeading());
    const ff = ((sig * v) / R) * clamp(2 - dist / R, 0, 1);
    return this.dsBankFor(ff + 0.9 * e);
  }

  // The glide pilot. The instructor (steerTowards) closes its bank ceiling as
  // the flight path falls below the one asked for, which in a glide is all
  // the time, so a gliding turn never got past ~25 degrees and its radius was
  // nobody's plan. This flies the three things a glide is made of directly:
  // the bank `phiC` (positive with the right wing down; capped near the
  // ground, where the wingtip is the first thing to arrive), the airspeed `vT`
  // on the elevator (the load factor that holds the path, plus a PD on the
  // speed error: a speed-hold with a ~15 s period, well damped) — or, with
  // `vyCmd`, a sink rate instead (the round-out) — and the ball in the middle.
  // The pitch goes through planeEntity.pitchCmdForAoa, never past 0.85 of the
  // stalling angle, and the structural limiter still has the last word.
  dsPilot(dt, phiC, vT, vyCmd = null) {
    const r = this.rtb;
    const p = this.plane;
    const v = Math.max(p.speed, 1);
    this._dsFlown = true;
    const agl = p.position.y - groundHeightAt(p.position.x, p.position.z);
    const cap = clamp((agl - 8) / 45, 0.05, 1) * DS_BANK_MAX;
    const phiT = clamp(phiC, -cap, cap);
    const phi = p.bankAngle();
    p.controls.roll = moveToward(p.controls.roll, clamp((phiT - phi) / (0.5 * p.spec.rollRate), -1, 1), 6 * dt);
    const gam = Math.asin(clamp(p.vel.y / v, -1, 1));
    const cphi = Math.max(0.5, Math.cos(phi));
    const acc = r.dsVPrev != null ? (v - r.dsVPrev) / Math.max(dt, 1e-3) : 0;
    r.dsVPrev = v;
    r.dsAcc = r.dsAcc == null ? acc : r.dsAcc + (acc - r.dsAcc) * Math.min(1, dt * 3);
    let n;
    if (vyCmd != null) n = Math.cos(gam) / cphi + (vyCmd - p.vel.y) * 0.12;
    else n = Math.cos(gam) / cphi + (0.55 * (v - vT) + 2 * r.dsAcc) / GRAV;
    const vr = v / Math.max(p.stallSpeedNow(), 1);
    n = clamp(n, 0.2, Math.min(2.5, 0.85 * vr * vr));
    const aoaC = Math.min(p.aoaForG(n), p.stallAoA() * 0.85);
    p.controls.pitch = moveToward(p.controls.pitch, p.pitchCmdForAoa(aoaC, 0.3), 8 * dt);
    p.controls.yaw = moveToward(p.controls.yaw, clamp(p.slip * 4, -1, 1), 10 * dt);
  }

  // Give up on the runway: a forced landing in the open (dsDitch). The lane
  // goes back to the field.
  dsStartDitch(why) {
    const r = this.rtb;
    if (r.dsMode === 'ditch') return;
    r.dsMode = 'ditch';
    r.dsSite = null;
    r.dsWord2 = null;
    if (r.log.ditch == null) {
      r.log.ditch = this.clock;
      r.log.ditchWhy = why;
    }
    if (r.phase !== 'glide') this.setRtbPhase('glide');
    this.releaseLane();
  }

  // How good a forced-landing site is (lower is better), or null if it is no
  // site at all: the touchdown at (x, z), the slide along (sx, sz) with
  // (lx, lz) its left. The ground has to be clear of every field's platform
  // and embankment and of the map's walls, not rising more than DITCH_SLOPE
  // along the DITCH_SLIDE metres of the slide (a slope met at the glide's sink
  // is the crash) nor leaning more than DITCH_CROSS across it (a wingtip),
  // and not climbing steeply in the last 60 m short of it.
  dsSiteScore(x, z, sx, sz, lx, lz, hw, strict = true) {
    const surf = this._dsSurf || (this._dsSurf = { y: 0, kind: '', af: null });
    let prev = null;
    let up = 0;
    let down = 0;
    let cross = 0;
    let field = 0;
    for (let k = -150; k <= DITCH_SLIDE; k += 15) {
      const px = x + sx * k;
      const pz = z + sz * k;
      if (Math.abs(px) > 1100 || Math.abs(pz) > 1100) return null;
      const s = groundSurfaceAt(px, pz, surf);
      const h = s.y;
      if (s.af && k >= -60) field = 1;
      // a building, a wall, a parked aeroplane anywhere near the slide (or
      // under the last of the line in to it)
      if (obstacleTopAt(px, pz, hw + 12) > h - 1) return null;
      if (k < -60) continue;
      if (prev !== null) {
        const sl = (h - prev) / 15;
        if (k > 0) {
          up = Math.max(up, sl);
          down = Math.max(down, -sl);
        } else if (sl > 0.15 && strict) {
          return null;
        }
      }
      prev = h;
      if (strict && up > DITCH_SLOPE) return null;
    }
    for (let k = 0; k <= DITCH_SLIDE; k += 30) {
      const px = x + sx * k;
      const pz = z + sz * k;
      const c = Math.abs(groundHeightAt(px + lx * hw, pz + lz * hw) - groundHeightAt(px - lx * hw, pz - lz * hw)) / (2 * hw);
      cross = Math.max(cross, c);
      if (strict && cross > DITCH_CROSS) return null;
    }
    // (a field's own platform is level, but a wreck on it shuts a lane)
    return up * 25 + cross * 12 + Math.max(0, down - 0.12) * 4 + field * 1.5;
  }

  // Away from the fields: a touchdown, or the line in to it, within reach of
  // a field's hangars, tower and pens is a slide or an approach through them.
  dsNearField(x, z, sx, sz) {
    let pen = 0;
    for (const af of this.battle.airfields || []) {
      if (!af) continue;
      for (let k = 0; k <= 300; k += 100) {
        if (Math.hypot(x - sx * k - af.x, z - sz * k - af.z) < 330) {
          pen = 3;
          break;
        }
      }
    }
    return pen;
  }

  // Where to put it down: every bearing out to 120 degrees either side of
  // the track, every 75 m along it while the glide (the turn onto it, then
  // straight, clean) still arrives with height in hand over the ground there
  // and no hill has come up through the glide first. The flattest slide wins,
  // with a little against turning and against arriving with height to throw
  // away (the touchdown is where the glide ends, not the first flat ground it
  // passes over).
  dsPickSite() {
    const p = this.plane;
    const pos = p.position;
    const g = this.dsGlideParams();
    const v = p.speed;
    const psi0 = this.dsHeading();
    const extra = (v * v - g.vT * g.vT) / (2 * GRAV);
    const hw = Math.max(3, (p.spec.span || 12) * 0.5 - 0.5);
    let best = null;
    for (let k = -8; k <= 8; k++) {
      const dpsi = k * 0.2618;
      const psi = psi0 + dpsi;
      const sx = Math.sin(psi);
      const sz = Math.cos(psi);
      const turn = Math.abs(dpsi) * g.R;
      // (the turn onto the bearing moves the start of the straight out to
      // its side; near enough the arc's chord, half way round)
      const ox = pos.x + Math.sin(psi0 + dpsi * 0.5) * turn * 0.9;
      const oz = pos.z + Math.cos(psi0 + dpsi * 0.5) * turn * 0.9;
      for (let D = 75; D <= DITCH_SEARCH; D += 75) {
        const x = ox + sx * D;
        const z = oz + sz * D;
        if (Math.abs(x) > 1080 || Math.abs(z) > 1080) break;
        const gy = groundHeightAt(x, z);
        const hAt = pos.y + extra - (turn * g.tanTurn + D * g.tanStr) * 1.08 - gy;
        if (hAt < 10) break;
        // a hangar or a tower in the way of the glide there (and half way
        // back to the last sample: a building is narrower than the step)
        if (obstacleTopAt(x, z, 15) > gy + hAt - 12) break;
        const mx = x - sx * 37;
        const mz = z - sz * 37;
        if (obstacleTopAt(mx, mz, 15) > groundHeightAt(mx, mz) + hAt - 8) break;
        const extraScore = Math.max(0, hAt - 45) * 0.03 + Math.abs(dpsi) * 0.25 + (hAt < 18 ? (18 - hAt) * 0.05 : 0) +
          this.dsNearField(x, z, sx, sz);
        const sc = this.dsSiteScore(x, z, sx, sz, Math.cos(psi), -Math.sin(psi), hw);
        if (sc === null) {
          // nothing that passes: the least bad ground, as a last resort
          if (best && !best.lenient) continue;
          const sl = this.dsSiteScore(x, z, sx, sz, Math.cos(psi), -Math.sin(psi), hw, false);
          if (sl === null) continue;
          const score = sl + extraScore;
          if (!best || score < best.score) best = { x, z, psi, score, hAt, D, t: this.clock, locked: false, lenient: true };
          continue;
        }
        const score = sc + extraScore;
        if (!best || best.lenient || score < best.score) best = { x, z, psi, score, hAt, D, t: this.clock, locked: false };
      }
    }
    return best;
  }

  // The forced landing. A site (dsPickSite) is chosen and re-chosen every
  // second and a half until the aeroplane is committed to it; it is flown to
  // along the glide's own turn-straight-turn path to a point 120 m short of
  // the touchdown on the slide's line, round an orbit beside that point
  // first while there is height to throw away, then down the line: clean,
  // wheels up (a belly slide is a write-off, a cartwheel on its legs over
  // rough ground is a fireball), wings level for the last of it, and the
  // round-out flown along the ground's own slope a second ahead, at a sink
  // easing off to a few tenths of a metre a second. With nowhere better:
  // straight on, wings level.
  dsDitch(dt) {
    const r = this.rtb;
    const p = this.plane;
    const pos = p.position;
    const g = this.dsGlideParams();
    const v = Math.max(p.speed, 1);
    p.throttle = 0;
    this.wantBrake = false;
    if (p.gear && !p.gearGone) p.toggleGear();
    const g0 = groundHeightAt(pos.x, pos.z);
    const agl = pos.y - g0;
    if (!r.dsSite || (!r.dsSite.locked && this.clock - r.dsSite.t > 1.5)) {
      const ns = this.dsPickSite();
      if (ns) r.dsSite = ns;
      else if (r.dsSite) r.dsSite.t = this.clock;
    }
    const s = r.dsSite;
    const psi = this.dsHeading();
    let phi = 0;
    let vyCmd = null;
    if (s) {
      const sx = Math.sin(s.psi);
      const sz = Math.cos(s.psi);
      const ex = s.x - sx * 120;
      const ez = s.z - sz * 120;
      const along = (pos.x - s.x) * sx + (pos.z - s.z) * sz; // < 0 short of the touchdown
      const cross = (pos.x - s.x) * sz - (pos.z - s.z) * sx; // > 0 left of the line
      const onLine = along > -160 && Math.abs(cross) < 40 && Math.abs(wrapAngle(psi - s.psi)) < 0.5;
      if (onLine || s.onLine) {
        // down the line, a course back onto it in proportion to the offset
        s.onLine = true;
        s.locked = true;
        const want = s.psi - Math.atan(clamp(cross / 45, -1, 1));
        phi = this.dsBankFor(clamp(0.9 * wrapAngle(want - psi), -0.35, 0.35));
        // Down to the touchdown: the slope still wanted against the clean
        // glide's. Height to throw away goes on the airbrake and the flap,
        // and past what they take (or past the touchdown still high) the
        // nose goes down after it — a site overflown is ground nobody has
        // looked at, and beyond it, sooner or later, the wall of the map.
        const hTd = pos.y - groundHeightAt(s.x, s.z) - p.rideHeight(0);
        const togo = -along;
        const tanD = hTd / Math.max(togo, 40);
        const rip = p.spec.flapRip || [70, 55, 42];
        if (tanD > g.tanStr * 1.25 || togo < 0) {
          this.wantBrake = true;
          if (p.flaps < 2 && p.ias < rip[p.flaps] * 0.85) p.setFlaps(p.flaps + 1);
        }
        if (p.flaps > 0 && p.ias > rip[p.flaps - 1] * 0.92) p.setFlaps(p.flaps - 1);
        if (hTd > 8 && (togo < 0 || tanD > g.tanStr * 1.8)) {
          s.dive = true;
          // (never a dive the round-out cannot take out again low down)
          vyCmd = -clamp(v * Math.min(Math.max(tanD, 0.12), 0.32), 2, Math.min(9, 2 + agl * 0.12));
          // (never faster than the flaps and the glide want)
          if (v > g.vT * 1.3) vyCmd = Math.max(vyCmd, p.vel.y + 1);
        }
      } else {
        const path = dubins(pos.z, pos.x, psi, ez, ex, s.psi, g.R, r.dsWord2 || null, {});
        r.dsWord2 = path.type;
        const need = (path.arc * g.tanTurn + path.straight * g.tanStr) * 1.05 + 120 * g.tanStr;
        const spare = pos.y + (v * v - g.vT * g.vT) / (2 * GRAV) - groundHeightAt(s.x, s.z) - need;
        if (s.orbit == null && spare > 60) s.orbit = true;
        if (s.orbit === true && spare < 20) s.orbit = false;
        if (s.orbit) {
          // a circle tangent to the line at the entry point, on its left,
          // flown left-handed so that it is heading down the line there
          phi = this.dsCircle(ex + Math.cos(s.psi) * g.R, ez - Math.sin(s.psi) * g.R, g.R, 1);
        } else {
          phi = this.dsFollow(path, g.R);
          if (path.len < 3 * g.R || agl < 70) s.locked = true;
        }
      }
    }
    // The round-out: along the ground's own slope a second ahead, the sink
    // easing off with the height. The flare starts higher the faster it is
    // coming down.
    const vh = Math.hypot(p.vel.x, p.vel.z) || 1;
    const look = Math.max(10, vh);
    const g1 = groundHeightAt(pos.x + (p.vel.x / vh) * look, pos.z + (p.vel.z / vh) * look);
    // (smoothed: a slope read off two samples a second apart jumps about,
    // and the round-out chased it up and down)
    const slope0 = (g1 - g0) / look;
    r.dsSlope = r.dsSlope == null ? slope0 : r.dsSlope + (slope0 - r.dsSlope) * Math.min(1, dt * 2.5);
    const slope = r.dsSlope;
    const hBelly = pos.y - Math.max(g0, g1) - p.rideHeight(0);
    // The walls of the map: eight seconds from one with height to turn,
    // round toward the middle (and a new site from there).
    const fx = pos.x + p.vel.x * 8;
    const fz = pos.z + p.vel.z * 8;
    if ((Math.abs(fx) > 1150 || Math.abs(fz) > 1150) && agl > 25) {
      phi = this.dsBankFor(clamp(0.7 * wrapAngle(Math.atan2(-pos.x, -pos.z) - psi), -0.4, 0.4));
      vyCmd = null;
      if (r.dsSite && !r.dsSite.onLine) r.dsSite.locked = false;
    }
    if (hBelly < Math.max(6, -(p.vel.y - vh * slope) * 1.8)) {
      vyCmd = vh * slope - clamp(0.3 + hBelly * 0.22, 0.3, 2.2);
      phi = 0;
    }
    this.dsPilot(dt, phi, g.vT, vyCmd);
  }

  // The glide approach's final and flare. No go-around without an engine:
  // the aim point is the touchdown point, moved further down the runway (as
  // far as the roll-out still allows) when even everything out will not get
  // the aeroplane down to it, or toward the threshold when it is short. The
  // speed is held on the elevator; the path to the aim point with the drag
  // ladder (DS_LADDER: gear, flaps, airbrake), stepped by the slope still
  // wanted against each rung's glide slope — and with the throttle while
  // there is an engine. Short of the platform even clean, with no engine: a
  // forced landing in the open instead (the embankment face in front of the
  // platform is the worst ground on the map to find that out on).
  dsFinal(dt) {
    const r = this.rtb;
    const p = this.plane;
    const pos = p.position;
    const d = r.d;
    const v = p.speed;
    const u = (pos.x - r.xTd) * d;
    const w = pos.z - r.laneZ;
    const surfY = groundHeightAt(pos.x, pos.z);
    const rh = p.rideHeight(0);
    const hWheel = pos.y - Math.max(surfY, r.runwayY) - rh;
    const power = !r.deadstick && p.engineHealth() > 0;
    const top = DS_LADDER.length - 1;
    const rungTan = (i) => {
      const [g, f, b] = DS_LADDER[i];
      return p.glideTan(p.stallSpeedAt(f) * 1.3, f, g ? 1 : 0, b);
    };
    const vsNow = p.stallSpeedNow();
    // (a little over the powered approach's 1.3: a glide final is steep, and
    // the flare has only the speed to round it out with)
    const vT = vsNow * 1.34;
    // where it may touch down: from 15 m inside the platform's near edge to
    // as far down as still leaves the roll-out and a couple of seconds' float
    const uNear = Math.max(0, (r.edgeInner - r.xTd) * d - 15);
    const uFar = Math.min(0, (r.edgeOuter + d * 28 - r.xTd) * d + (vT * vT) / 7 + 25 + 2 * vT);
    const tGo = Math.max(0, u) / Math.max(v, 1);
    // The gear is not optional for the last stretch: six seconds to come
    // down, and a margin — later when the height is short (the legs are
    // drag), earlier when there is height to spare.
    const short = hWheel / Math.max(u - uNear, 20) < rungTan(1);
    const minLvl = (short ? tGo < 11 || hWheel < 40 : tGo < 13 || hWheel < 50) ? 1 : 0;
    if (!power && r.phase === 'final' && u > uNear + 25) {
      // can the platform still be reached? (dsFinalReach)
      if (this.dsFinalReach() < -3 || pos.y - rh < r.runwayY - 1) {
        this.dsStartDitch('final short');
        this.dsDitch(dt);
        return;
      }
    }
    let uA = 0;
    const s0 = Math.max(u - uA, 20);
    const tTop = rungTan(top);
    const tBot = rungTan(minLvl);
    if (hWheel / s0 > tTop) uA = clamp(u - hWheel / tTop, uFar, 0);
    else if (hWheel / s0 < tBot && !power) uA = clamp(u - hWheel / tBot, 0, uNear);
    r.dsAim = uA;
    const tanReq = hWheel / Math.max(u - uA, 15);
    if (r.phase === 'final') {
      // With the engine still turning, a final that has gone wrong — too
      // high to get down even landing long, off the lane close in, or past
      // the aim point still in the air — is gone round, as any other.
      // (Not with an engine that may not last the circuit; and "too high"
      // only when well past what landing long can take: an idling engine
      // still pulls, and the big ones never get down to the drag sums.)
      if (power && this.engineLife() > 60 && ((u < 300 && hWheel / Math.max(u - uFar, 20) > tTop * 1.3) ||
        (u < 150 && Math.abs(w) > 20) || u < uFar - 20)) {
        r.dsWait = 12;
        this.rtbGoAround(u < uFar - 20 ? 'glide final: long' : Math.abs(w) > 20 ? 'glide final: off the lane'
          : 'glide final: high');
        return;
      }
      // way too high even landing long: round again for more height off
      // (twice at most), while there is room to
      if (u > 260 && hWheel / Math.max(u - uFar, 20) > tTop * 1.12 && (r.dsReorbit || 0) < 2) {
        r.dsReorbit = (r.dsReorbit || 0) + 1;
        r.dsMode = 'orbit';
        r.dsUF = null;
        this.setRtbPhase('glide');
        this.rtbGlide(dt);
        return;
      }
      if (r.dsLvl == null) {
        r.dsLvl = top;
        for (let i = minLvl; i <= top; i++) {
          if (rungTan(i) >= tanReq) {
            r.dsLvl = i;
            break;
          }
        }
        r.dsLvlT = 0;
      }
      r.dsLvlT += dt;
      if (r.dsLvl < minLvl) r.dsLvl = minLvl;
      if (r.dsLvlT > 0.6) {
        if (r.dsLvl < top && tanReq > rungTan(r.dsLvl) * 1.03) {
          r.dsLvl++;
          r.dsLvlT = 0;
        } else if (r.dsLvl > minLvl && hWheel > 30 && tanReq < rungTan(r.dsLvl - 1) * 0.97) {
          // (never cleaning up in the last thirty metres: flap coming in
          // there is lift gone just when the round-out needs it)
          r.dsLvl--;
          r.dsLvlT = 0;
        }
      }
      // the round-out starts higher the faster it is coming down — over the
      // platform (short of it, the check above has had its say)
      // (the height it takes to arrest the sink at ~0.3 g, plus a moment
      // to begin)
      const sink = Math.max(0, -p.vel.y);
      if (hWheel < clamp((sink * sink) / 5 + 0.6 * sink, 4.5, 14) && u < uNear + 60) this.setRtbPhase('flare');
    }
    // the rung: gear, flaps (a stage at a time, each below its limit), brake
    const [gWant, fWant, bWant] = DS_LADDER[r.dsLvl == null ? top : r.dsLvl];
    if (gWant && !p.gear && !p.gearGone && p.ias < p.gearLim.vlo * 0.97) p.toggleGear();
    else if (!gWant && p.gear && hWheel > 50 && tGo > 13) p.toggleGear();
    const rip = p.spec.flapRip || [70, 55, 42];
    if (p.flaps < fWant && p.ias < rip[Math.min(2, p.flaps)] * 0.88) p.setFlaps(p.flaps + 1);
    else if (p.flaps > fWant && v > vsNow * 1.15 && r.phase !== 'flare') p.setFlaps(p.flaps - 1);
    // (the airbrake comes in for the flare — the speed is the round-out —
    // unless it is floating toward the end of the runway: without an
    // engine the float is the danger then, not the sink)
    const remainF = (pos.x - (r.edgeOuter + d * 28)) * d;
    this.wantBrake = bWant && (r.phase !== 'flare' || remainF < (v * v) / 5 + 60);
    let vyDes;
    if (r.phase === 'flare') {
      p.throttle = 0;
      // (settling at ~1 m/s, not 0.25, and briskly: the float of a dead-
      // stick landing is runway it does not have)
      vyDes = -clamp(1 + hWheel * 0.45, 1, 3);
      // floating past where the roll-out still fits: no going round, so
      // put it on, firmly
      const remain = (pos.x - (r.edgeOuter + d * 28)) * d;
      if (remain < (v * v) / 7 + 25) vyDes = Math.min(vyDes, -1.4);
    } else if (power && tanReq < tBot * 0.97) {
      // short, with an engine: fly the line on the throttle
      vyDes = -v * tanReq;
      this.rtbSpeed(vT, dt);
      r.dsVI = 0;
    } else {
      p.throttle = 0;
      // The instructor points the nose; it does not hold a speed, and the
      // pointing error it settles with costs the glide its speed. So the
      // speed error has an integral as well as a proportional term.
      r.dsVI = clamp((r.dsVI || 0) + (vT - v) * dt * 0.12, -1, 2);
      vyDes = -v * p.glideTan() - 0.7 * (vT - v) - r.dsVI;
      if (v < vsNow * 1.12) vyDes = Math.min(vyDes, -2);
      vyDes = clamp(vyDes, -v * 0.4, 1);
    }
    const az = pos.z - clamp(3 * w + 1.5 * p.vel.z, -154, 154);
    this.rtbAim(pos.x - d * 220, az, vyDes);
  }

  // May this aeroplane turn in from the gate? Not while another of this
  // field's landers is turning in itself, or is still far enough out on its
  // final that this turn would cut across it at the same height.
  //
  // Nor while a departure is rolling or still climbing out low over the
  // approach, or has been lined up waiting its turn for long enough. The
  // strip is at the map's edge, so take-offs run toward the battle and
  // landings come in from it: the two are head-on down the same corridor,
  // and the field works them one way at a time (see departureBlock).
  baseClear() {
    const r = this.rtb;
    const st = lanesOf(r.af);
    for (const l of st.lanes) {
      const o = l.owner;
      if (!o || o === this || !o.rtb || !o.plane.alive) continue;
      const ph = o.rtb.phase;
      if (ph === 'base') return false;
      if (ph === 'final' && (o.plane.position.x - o.rtb.xTd) * o.rtb.d > 380) return false;
      if (ph === 'lineup' && o.rtb.depBlock === 1 && o.rtb.phaseT > RTB_DEPARTURE_PRIORITY) return false;
      // a glide approach turning onto its final has the field
      if (ph === 'glide' && o.rtb.dsMode === 'icpt') return false;
    }
    for (const o of this.battle.planes || []) {
      if (!o || o === this.plane || !o.alive || o._rtbField !== r.af) continue;
      if (o._rtbPhase === 'takeoff') return false;
      if (o._rtbPhase === 'climbout' && o.position.y - r.runwayY < 100 &&
        (o.position.x - r.xThr) * r.d < 1100) return false;
    }
    return true;
  }

  // Abandon this approach and come round again; false when that was the
  // last try (the circuit has been given up).
  rtbGoAround(why = '') {
    const r = this.rtb;
    r.goArounds++;
    r.log.goArounds = r.goArounds;
    (r.log.gaWhy || (r.log.gaWhy = [])).push(why);
    if (r.goArounds > RTB_GO_AROUNDS) return this.abortRTB('go-arounds');
    r.configured = false;
    this.setRtbPhase('goaround');
    return true;
  }

  // Is the runway ahead of a departure clear? 0: go. 1: wait — one of this
  // field's landers is turning in, on the final or in the flare (on any
  // lane: take-offs and landings meet head-on here, see baseClear), or
  // somebody else is low and inbound down the approach (the player landing,
  // a go-around), or a parked aeroplane is close beside the take-off run.
  // 2: never — an aeroplane on the ground right in the wheels' path.
  departureBlock() {
    const r = this.rtb;
    const p = this.plane;
    const d = r.d;
    const af = r.af;
    let soft = 0;
    for (const l of lanesOf(af).lanes) {
      const o = l.owner;
      if (!o || o === this || !o.rtb || !o.plane.alive || o.plane.onGround) continue;
      const ph = o.rtb.phase;
      if (ph === 'base' || ph === 'flare' ||
        (ph === 'final' && (o.plane.position.x - o.rtb.xTd) * o.rtb.d < 1500)) soft = 1;
      // a glide approach turning in: it may not be able to go round, so the
      // runway is its until it is down
      if (ph === 'glide' && o.rtb.dsMode === 'icpt') soft = 1;
    }
    for (const o of this.battle.planes || []) {
      if (!o || o === p || !o.alive) continue;
      const dz = Math.abs(o.position.z - p.position.z);
      const ahead = (o.position.x - p.position.x) * d;
      if (o.onGround) {
        if (dz < 16 && ahead > -15 && ahead < 420) {
          if (dz < 10) return 2;
          soft = 1;
        }
        continue;
      }
      // a departure ahead is going the same way
      if (o._rtbField === af && (o._rtbPhase === 'climbout' || o._rtbPhase === 'takeoff')) continue;
      if (Math.abs(o.position.z - af.z) < af.halfWid + 40 && ahead > -15 && ahead < 1800 &&
        o.position.y - r.runwayY < 150 && o.vel && o.vel.x * d < 0) soft = 1;
    }
    return soft;
  }

  rtbGround(dt) {
    const r = this.rtb;
    const p = this.plane;
    const pos = p.position;
    const d = r.d;
    const v = p.speed;
    this.wantBrake = false;
    p.controls.roll = 0;
    if (p.wrecked) {
      // a belly or a folded leg: nothing left to fly, the battle books it
      p.throttle = 0;
      p.controls.pitch = 0;
      p.controls.yaw = 0;
      if (r.log.abort == null) r.log.abort = 'wrecked';
      return true;
    }
    switch (r.phase) {
      case 'rollout':
      case 'service':
      case 'lineup':
      case 'turn':
      case 'takeoff':
        break;
      case 'climbout':
        // settled back onto the runway a moment after lifting off
        this.setRtbPhase('takeoff');
        break;
      default: {
        // the wheels are down: it has landed
        this.setRtbPhase('rollout');
        if (r.log.td == null) {
          r.log.td = this.clock;
          r.log.tdSink = p.lastContact ? p.lastContact.sink : null;
          r.log.tdU = (pos.x - r.xTd) * d;
          r.log.tdW = pos.z - r.laneZ;
        }
        break;
      }
    }

    const heading = (yawX, corr, gain) => {
      const yawDes = Math.atan2(yawX, clamp(corr, -0.5, 0.5));
      const e = wrapAngle(yawDes - p.groundYaw);
      p.controls.yaw = clamp(e * gain, -1, 1);
      return e;
    };

    switch (r.phase) {
      case 'rollout': {
        p.throttle = 0;
        p.controls.pitch = 0;
        // metre the brakes to stop at the planned point
        const togo = (pos.x - r.stopX) * d;
        const aReq = (v * v) / (2 * Math.max(togo, 0.5));
        this.wantBrake = togo < 3 || aReq > 0.55;
        heading(-d, (r.laneZ - pos.z) / 45, 6);
        if (v < 0.4) {
          this.setRtbPhase('service');
          if (r.log.stopped == null) {
            r.log.stopped = this.clock;
            r.log.stopU = (pos.x - r.xThr) * -d; // metres past the threshold
          }
        }
        break;
      }
      case 'service': {
        p.throttle = 0;
        p.controls.pitch = 0;
        p.controls.yaw = 0;
        this.wantBrake = true;
        if (p.serviceFrac >= 1) {
          if (r.log.serviced == null) r.log.serviced = this.clock;
          // mended: an ordinary departure and, if it comes to it, an
          // ordinary circuit again
          r.deadstick = false;
          r.glideApp = false;
          r.prio = RTB_PRIORITY[r.reason] != null ? RTB_PRIORITY[r.reason] : 1;
          this.setRtbPhase('lineup');
        } else if ((r.phaseT > 3 && !(p.serviceFrac > 0)) || r.phaseT > 45) {
          // no crew here (not on our own platform): go without
          r.unserviced = true;
          this.setRtbPhase('lineup');
        }
        break;
      }
      case 'lineup': {
        p.throttle = 0;
        p.controls.pitch = 0;
        p.controls.yaw = 0;
        this.wantBrake = true;
        const e = wrapAngle(r.af.heading - p.groundYaw);
        if (Math.abs(e) > 0.1) {
          r.pivot = false;
          this.setRtbPhase('turn');
        } else {
          // (a wait that will not end — a lander that never comes, the
          // player parked beside the run — is given up after a minute and a
          // half; one right in the wheels' path never is)
          const blk = this.departureBlock();
          // (what baseClear reads: only a departure held by TRAFFIC has the
          // field before the next arrival — one with an aeroplane parked in
          // its path would otherwise hold every arrival off for as long as
          // that aeroplane stays there)
          r.depBlock = blk;
          if (blk === 0 || (blk === 1 && r.phaseT > RTB_DEPARTURE_WAIT_MAX)) {
            r.integ = 0;
            this.setRtbPhase('takeoff');
          }
        }
        break;
      }
      case 'turn': {
        // a pivot: stop, then brakes on, a burst of power and full rudder
        const e = wrapAngle(r.af.heading - p.groundYaw);
        if (!r.pivot && v > 0.4) {
          p.throttle = 0;
          p.controls.yaw = 0;
        } else {
          r.pivot = true;
          p.throttle = 0.3;
          p.controls.yaw = Math.abs(e) > 0.03 ? Math.sign(e) : 0;
        }
        p.controls.pitch = -0.3; // tail down: the tailwheel steers
        this.wantBrake = true;
        if (r.pivot && Math.abs(e) < 0.06) this.setRtbPhase('lineup');
        break;
      }
      case 'takeoff': {
        p.throttle = 1;
        this.wantBrake = false;
        if (p.flaps !== 2) p.setFlaps(2);
        const vs = p.stallSpeedNow();
        const climb = v > vs * 1.15 ? 0.16 : -0.05;
        this.steerPoint.set(pos.x + d * 300, pos.y + 300 * Math.tan(climb), r.laneZ);
        p.steerTowards(this.steerPoint, dt);
        // ...the stick from the instructor, the feet from here
        p.controls.roll = 0;
        heading(d, (r.laneZ - pos.z) / 60, 6);
        break;
      }
      default:
        break;
    }
    this.rtbSystems();
    return true;
  }

  pickGroundTarget(dt) {
    if (!this.battle.strafeTargetsFor) return null;
    this.gRetarget -= dt;
    if (this.groundTarget && this.groundTarget.alive && this.gRetarget > 0) {
      return this.groundTarget;
    }
    this.gRetarget = 3;
    this.groundTarget = null;
    const list = this.battle.strafeTargetsFor(this.plane.team);
    const zones = readZones(this.battle);
    const team = this.plane.team;
    let best = Infinity;
    for (const g of list) {
      if (!g.alive) continue;
      // The old rule was "nearest living hull", which sent every striker after
      // whatever happened to be closest to the airfield while the capture
      // points went unopposed. Range still leads, but a tank standing on a
      // point is worth flying past two that are standing in a field.
      let s = this.plane.position.distanceTo(g.position);
      // a target close under the map wall can only be dived on heading for
      // the wall (see headingForWall): worth less the closer it stands
      const edge = MAP_WALL + 30 - Math.max(Math.abs(g.position.x), Math.abs(g.position.z));
      if (edge < 300) s += (300 - Math.max(0, edge)) * 2;
      if (zones) {
        let near = null;
        let nearD = Infinity;
        for (const z of zones) {
          const d = Math.hypot(g.position.x - z.x, g.position.z - z.z);
          if (d < nearD) {
            nearD = d;
            near = z;
          }
        }
        if (near && nearD < near.r * 2.4) {
          s -= 200;
          if (near.contested) s -= 260;
          if (near.owner !== team) s -= 140;
          if (near.capTeam >= 0 && near.capTeam !== team) s -= 180;
        }
      }
      if (s < best) {
        best = s;
        this.groundTarget = g;
      }
    }
    return this.groundTarget;
  }
}
